#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodexRpc } from '../src/rpc.mjs';

// LIVE protocol acceptance using an existing client's real configuration.
// This does not operate or verify the desktop UI. Model/provider/effort and
// feature settings are loaded from the selected CODEX_HOME without overrides.
const command = process.env.BRIDGE_CODEX_BIN ?? 'codex';
const deadline = Date.now() + 180_000;
const evidence = {
  client: 'official-cli-with-existing-client-profile',
  desktop_ui_tested: false, profile_configuration_overridden: false,
  event_counts: {}, item_counts: {}, startup_error_categories: {}, runtime_error_categories: {},
};
let temporary;
let rpc;
let stage = 'validate_client_home';

function check(condition, reason) {
  if (!condition) throw Object.assign(new Error(reason), { verificationReason: reason });
}

function safeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : 'unavailable';
}

function errorCategory(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  if (/code.?mode.*disabled/i.test(text)) return 'code_mode_disabled';
  if (/model.*(?:not found|unknown|not recognized|not supported|metadata|catalog)/i.test(text)) return 'model_metadata_unavailable';
  if (/shell.?snapshot/i.test(text)) return 'shell_snapshot_warning';
  if (/mcp/i.test(text)) return 'mcp_startup_warning';
  if (/skill.*(?:load|parse|invalid|fail)/i.test(text)) return 'skill_loading_warning';
  if (/(?:sqlite|database|state db|rollout)/i.test(text)) return 'local_state_warning';
  if (/(?:permission denied|operation not permitted)/i.test(text)) return 'local_permission_denied';
  if (/(?:capacity|overloaded)/i.test(text)) return 'upstream_capacity';
  if (/(?:usage.limit|rate.limit|quota)/i.test(text)) return 'upstream_usage_limit';
  if (/(?:connection|network|timeout|timed out|dns)/i.test(text)) return 'connection_warning';
  if (/(?:config|configuration)/i.test(text)) return 'configuration_warning';
  return 'unspecified_error';
}

function summarize(stdout) {
  const eventTypes = new Set(['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'item.started', 'item.updated', 'item.completed', 'error']);
  const itemTypes = new Set(['agent_message', 'reasoning', 'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'error']);
  let turnStarted = false;
  let invalid = 0;
  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); }
    catch { invalid += 1; continue; }
    if (!event || typeof event !== 'object') { invalid += 1; continue; }
    if (event.type === 'turn.started') turnStarted = true;
    const type = eventTypes.has(event.type) ? event.type : 'other';
    evidence.event_counts[type] = (evidence.event_counts[type] ?? 0) + 1;
    if (event.item) {
      const itemType = itemTypes.has(event.item.type) ? event.item.type : 'other';
      evidence.item_counts[itemType] = (evidence.item_counts[itemType] ?? 0) + 1;
    }
    if (event.type === 'error' || event.type === 'turn.failed' || event.item?.type === 'error') {
      const category = errorCategory(event.error ?? event.item ?? event.message);
      const counts = turnStarted ? evidence.runtime_error_categories : evidence.startup_error_categories;
      counts[category] = (counts[category] ?? 0) + 1;
    }
  }
  evidence.non_json_event_lines = invalid;
}

function stopGroup(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch { /* The process group has already stopped. */ }
}

function runCli(args, { cwd, env, timeoutMs, maxBytes = 4 * 1024 * 1024 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let failure;
    const timer = setTimeout(() => { failure = 'official_cli_timeout'; stopGroup(child); }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { failure = 'official_output_limit'; stopGroup(child); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', () => {}); // Never echo or retain raw diagnostics.
    child.once('error', () => { failure = 'official_cli_start_failed'; });
    child.once('close', code => {
      clearTimeout(timer);
      stopGroup(child);
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (failure || code !== 0) {
        reject(Object.assign(new Error('official_cli_failed'), { verificationReason: failure ?? 'official_cli_failed', exitCode: code, capturedStdout: stdout }));
      } else resolve({ stdout, exitCode: code });
    });
  });
}

try {
  check(typeof process.env.BRIDGE_CLIENT_HOME === 'string' && process.env.BRIDGE_CLIENT_HOME.length > 0, 'bridge_client_home_required');
  const clientHome = await realpath(path.resolve(process.env.BRIDGE_CLIENT_HOME));
  const configPath = path.join(clientHome, 'config.toml');
  const configDigest = createHash('sha256').update(await readFile(configPath)).digest('hex');
  temporary = await mkdtemp(path.join(tmpdir(), 'codex-client-profile-'));
  const cwd = path.join(temporary, 'workspace');
  await mkdir(cwd, { mode: 0o700 });
  const note = `${randomBytes(24).toString('hex')}\n`;
  await writeFile(path.join(cwd, 'input.txt'), note, { mode: 0o600 });
  const finalPath = path.join(temporary, 'final-answer.txt');

  // Keep normal HOME/PATH so the client's actual configuration and tools load.
  // Remove parent Codex identity/provider credentials and all bridge overrides.
  const env = { ...process.env, PWD: cwd };
  for (const name of Object.keys(env)) {
    if (/^(?:CODEX_|BRIDGE_|OPENAI_|CHATGPT_)/.test(name) || ['LIVE_DESKTOP_BRIDGE_KEY', 'FIXTURE_OPENAI_API_KEY'].includes(name)) delete env[name];
  }
  env.CODEX_HOME = clientHome;

  stage = 'read_effective_client_configuration';
  rpc = new CodexRpc({ command, args: ['app-server', '--listen', 'stdio://'], cwd, env, requestTimeoutMs: 15_000 });
  rpc.on('serverRequest', event => rpc.respondError(event.id, { code: -32601, message: 'This process only reads configuration.' }));
  await rpc.start();
  const result = await rpc.request('config/read', { includeLayers: false, cwd });
  const config = result.config;
  check(config && typeof config === 'object', 'effective_configuration_unavailable');
  const providerId = config.model_provider;
  const provider = config.model_providers?.[providerId];
  evidence.loaded_model = safeIdentifier(config.model);
  evidence.loaded_provider = safeIdentifier(providerId);
  evidence.loaded_provider_name = safeIdentifier(provider?.name);
  evidence.loaded_reasoning_effort = safeIdentifier(config.model_reasoning_effort);
  evidence.loaded_features = {
    code_mode: typeof config.features?.code_mode === 'boolean' ? config.features.code_mode : null,
    code_mode_host: typeof config.features?.code_mode_host === 'boolean' ? config.features.code_mode_host : null,
  };
  check(evidence.loaded_model !== 'unavailable' && evidence.loaded_provider !== 'unavailable', 'model_or_provider_not_explicitly_configured');
  await rpc.close();
  rpc = undefined;
  const version = await runCli(['--version'], { cwd, env, timeoutMs: 5000, maxBytes: 64 * 1024 });
  check(/^codex-cli [\w.+-]+$/.test(version.stdout.trim()), 'unexpected_official_binary_version');
  evidence.codex_version = version.stdout.trim();

  stage = 'live_client_profile_tool_round_trip';
  const remaining = deadline - Date.now() - 2000;
  check(remaining > 0, 'verification_deadline_exceeded');
  const generated = await runCli([
    'exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--json',
    '-c', 'approval_policy="never"', '-c', 'sandbox_workspace_write.network_access=false',
    '--output-last-message', finalPath,
    'Read input.txt in the current workspace. It contains a random nonce. Use your local tools to write the entire file contents, byte for byte including its trailing newline, to output.txt. Do not change input.txt. After completing the file operation, answer only DONE.',
  ], { cwd, env, timeoutMs: remaining });
  evidence.official_exit_code = generated.exitCode;
  summarize(generated.stdout);
  check(evidence.non_json_event_lines === 0, 'invalid_official_event_stream');
  check((evidence.event_counts['turn.completed'] ?? 0) > 0 && !evidence.event_counts['turn.failed'], 'official_turn_not_completed');
  stage = 'verify_local_files';
  let output;
  try { output = await readFile(path.join(cwd, 'output.txt'), 'utf8'); }
  catch { throw Object.assign(new Error('output_file_missing'), { verificationReason: 'output_file_missing' }); }
  check(output === note, 'local_file_nonce_mismatch');
  check(await readFile(path.join(cwd, 'input.txt'), 'utf8') === note, 'input_file_was_changed');
  check((await readFile(finalPath, 'utf8')).trim() === 'DONE', 'final_answer_not_done');
  evidence.local_file_copy_exact = true;
  evidence.input_file_unchanged = true;
  evidence.final_answer_done = true;
  // The CLI may migrate configuration, or its owner may edit it concurrently.
  // Report that observation separately from the completed native tool check.
  evidence.client_config_unchanged = createHash('sha256').update(await readFile(configPath)).digest('hex') === configDigest;
  if (!evidence.client_config_unchanged) evidence.configuration_change_observed = true;
  console.log(JSON.stringify({ status: 'passed', ...evidence }, null, 2));
} catch (error) {
  if (error.capturedStdout && stage === 'live_client_profile_tool_round_trip') summarize(error.capturedStdout);
  if (error.exitCode !== undefined) evidence.official_exit_code = error.exitCode;
  console.error(JSON.stringify({ status: 'failed', stage, reason: error.verificationReason ?? 'verification_failed', ...evidence }, null, 2));
  process.exitCode = 1;
} finally {
  await rpc?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
