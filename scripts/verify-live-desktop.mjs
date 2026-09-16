#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configArguments, ISOLATED_CONFIG } from '../src/runtime.mjs';

// LIVE integration check: this consumes model usage through the configured
// bridge. Only the official CLI may read input.txt or create output.txt.
const model = process.env.BRIDGE_DESKTOP_MODEL ?? 'gpt-5.6-sol';
const command = process.env.BRIDGE_CODEX_BIN ?? 'codex';
const apiKey = process.env.BRIDGE_API_KEY;
const deadline = Date.now() + 180_000;
const evidence = {
  client: 'real-official-codex-exec', model, target: 'configured_live_bridge',
  local_account_used: false, local_home_isolated: true,
  event_counts: {}, item_counts: {},
};
let temporary;
let stage = 'validate_configuration';

function check(condition, reason) {
  if (!condition) throw Object.assign(new Error(reason), { verificationReason: reason });
}

function killProcessGroup(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* Already exited; the isolated process group no longer exists. */ }
}

function runOfficial(args, { cwd, env, timeoutMs, maxBytes = 4 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, detached: process.platform !== 'win32',
      // Closed stdin matters: Codex otherwise waits for appended piped input.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    let bytes = 0;
    let timedOut = false;
    let exceeded = false;
    let startFailed = false;
    const timer = setTimeout(() => { timedOut = true; killProcessGroup(child); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { exceeded = true; killProcessGroup(child); }
      else chunks.push(chunk);
    });
    // Upstream errors, prompts, file contents, and credentials must not be
    // echoed. Drain stderr without retaining or printing its text.
    child.stderr.on('data', () => {});
    child.once('error', () => { startFailed = true; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      killProcessGroup(child);
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (startFailed || timedOut || exceeded || code !== 0) {
        reject(Object.assign(new Error('official_cli_failed'), {
          verificationReason: startFailed ? 'official_cli_start_failed' : timedOut ? 'official_cli_timeout' : exceeded ? 'official_output_limit' : 'official_cli_failed',
          exitCode: code, signal, capturedStdout: stdout,
        }));
      } else resolve({ stdout, exitCode: code });
    });
  });
}

function summarizeEvents(stdout) {
  const allowedEvents = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error']);
  const allowedItems = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'error']);
  let invalidLines = 0;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); }
    catch { invalidLines += 1; continue; }
    const type = allowedEvents.has(event.type) ? event.type : 'other';
    evidence.event_counts[type] = (evidence.event_counts[type] ?? 0) + 1;
    if (event.item) {
      const itemType = allowedItems.has(event.item.type) ? event.item.type : 'other';
      evidence.item_counts[itemType] = (evidence.item_counts[itemType] ?? 0) + 1;
    }
  }
  evidence.non_json_event_lines = invalidLines;
}

try {
  check(typeof apiKey === 'string' && apiKey.trim().length > 0, 'bridge_api_key_required');
  check(['gpt-5.6-sol', 'gpt-5.5'].includes(model), 'unsupported_test_model');
  let base;
  try { base = new URL(process.env.BRIDGE_URL ?? 'http://127.0.0.1:8789/v1'); }
  catch { throw Object.assign(new Error('invalid_bridge_url'), { verificationReason: 'invalid_bridge_url' }); }
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && !base.search && !base.hash, 'invalid_bridge_url');
  const baseUrl = base.href.replace(/\/+$/, '');

  stage = 'prepare_isolated_client';
  temporary = await mkdtemp(path.join(tmpdir(), 'codex-live-desktop-'));
  const cwd = path.join(temporary, 'workspace');
  const home = path.join(temporary, 'home');
  const codexHome = path.join(temporary, 'codex-home');
  const finalPath = path.join(temporary, 'final-answer.txt');
  await Promise.all([cwd, home, codexHome].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  const note = `${randomBytes(24).toString('hex')}\n`;
  // The nonce goes only into this local file, never the prompt or environment.
  await writeFile(path.join(cwd, 'input.txt'), note, { mode: 0o600 });
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome,
    TMPDIR: temporary, NO_PROXY: '127.0.0.1,localhost',
    LIVE_DESKTOP_BRIDGE_KEY: apiKey,
  };
  const version = await runOfficial(['--version'], { cwd, env, timeoutMs: 5000, maxBytes: 64 * 1024 });
  check(/^codex-cli [\w.+-]+$/.test(version.stdout.trim()), 'unexpected_official_binary_version');
  evidence.codex_version = version.stdout.trim();

  const config = {
    ...ISOLATED_CONFIG,
    model, model_provider: 'live_bridge', model_reasoning_effort: 'low', approval_policy: 'never',
    'features.shell_tool': true,
    'features.unified_exec': true,
    'features.code_mode': true,
    'features.code_mode_host': true,
    'model_providers.live_bridge.name': 'OpenAI',
    'model_providers.live_bridge.base_url': baseUrl,
    'model_providers.live_bridge.wire_api': 'responses',
    'model_providers.live_bridge.requires_openai_auth': false,
    'model_providers.live_bridge.supports_websockets': false,
    'model_providers.live_bridge.env_key': 'LIVE_DESKTOP_BRIDGE_KEY',
    'model_providers.live_bridge.request_max_retries': 0,
    'model_providers.live_bridge.stream_max_retries': 0,
    'features.enable_request_compression': false,
    'sandbox_workspace_write.network_access': false,
  };
  const args = [
    'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'workspace-write', '--strict-config', '--json', '--model', model,
    '--output-last-message', finalPath, ...configArguments(config),
    'Read input.txt in the current workspace. It contains a random nonce. Use your local tools to write the entire file contents, byte for byte including its trailing newline, to output.txt. Do not change input.txt. After completing the file operation, answer only DONE.',
  ];
  stage = 'live_official_client';
  const remainingMs = deadline - Date.now() - 2000;
  check(remainingMs > 0, 'verification_deadline_exceeded');
  const result = await runOfficial(args, { cwd, env, timeoutMs: remainingMs });
  evidence.official_exit_code = result.exitCode;
  summarizeEvents(result.stdout);
  check(evidence.non_json_event_lines === 0, 'invalid_official_event_stream');
  check((evidence.event_counts['turn.completed'] ?? 0) > 0, 'official_turn_not_completed');
  check(!evidence.event_counts['turn.failed'], 'official_turn_failed');

  stage = 'verify_local_file_result';
  let output;
  try { output = await readFile(path.join(cwd, 'output.txt'), 'utf8'); }
  catch { throw Object.assign(new Error('output_file_missing'), { verificationReason: 'output_file_missing' }); }
  check(output === note, 'local_file_nonce_mismatch');
  check(await readFile(path.join(cwd, 'input.txt'), 'utf8') === note, 'input_file_was_changed');
  check((await readFile(finalPath, 'utf8')).trim() === 'DONE', 'final_answer_not_done');
  evidence.local_file_copy_exact = true;
  evidence.input_file_unchanged = true;
  evidence.final_answer_done = true;
  console.log(JSON.stringify({ status: 'passed', ...evidence, note: 'Live official CLI used the configured bridge and local filesystem tools. No account state, nonce, tool output, prompt, or credential is recorded.' }, null, 2));
} catch (error) {
  if (error.capturedStdout && stage === 'live_official_client') summarizeEvents(error.capturedStdout);
  if (error.exitCode !== undefined) evidence.official_exit_code = error.exitCode;
  console.error(JSON.stringify({ status: 'failed', stage, reason: error.verificationReason ?? 'verification_failed', ...evidence }, null, 2));
  process.exitCode = 1;
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
