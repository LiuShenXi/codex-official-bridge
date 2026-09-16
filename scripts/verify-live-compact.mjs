#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from '../src/rpc.mjs';

// LIVE acceptance: one normal turn, one official V2 compaction, one recall turn.
// Uses the selected client's provider without exposing its configuration/token.
// This is an app-server protocol check, not a desktop UI check.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = Date.now() + 175_000;
const evidence = {
  client: 'official-app-server-with-existing-client-profile',
  desktop_ui_tested: false,
  model: 'gpt-5.6-sol',
  remote_compaction_v2_explicit: true,
  dynamic_tools_injected: false,
  ephemeral_thread: true,
  temporary_home_and_workspace: true,
  reasoning_effort: 'low',
  event_counts: {}, item_counts: {},
  unexpected_server_requests: 0,
};
const eventTypes = new Set(['thread/started', 'turn/started', 'turn/completed', 'item/started', 'item/completed', 'error']);
const itemTypes = new Set(['agentMessage', 'reasoning', 'contextCompaction', 'commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'plan']);
let stage = 'validate_client_home';
let temporary;
let rpc;
let threadId;
let active;
let configPath;
let initialDigest;
let closing = false;
let watchdog;
let failure;

function check(condition, reason) {
  if (!condition) throw Object.assign(new Error(reason), { verificationReason: reason });
}

function remaining() {
  const value = deadline - Date.now();
  check(value > 0, 'verification_deadline_exceeded');
  return value;
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function count(map, type) { map[type] = (map[type] ?? 0) + 1; }

function collectItem(state, item) {
  if (!item || typeof item !== 'object') return;
  if (item.type === 'contextCompaction') state.compacted = true;
  if (item.type === 'agentMessage' && typeof item.text === 'string') {
    state.messages.set(item.id ?? `anonymous-${state.messages.size}`, item.text);
  }
}

function beginPhase(name) {
  check(!active, 'overlapping_verification_phase');
  let resolve;
  let reject;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A notification can arrive while the corresponding RPC is still pending.
  // Mark rejection handled immediately; the phase is awaited after that RPC.
  done.catch(() => {});
  active = { name, done, resolve, reject, messages: new Map(), compacted: false, started: false, turnId: undefined };
  return active;
}

function failActive(reason) {
  const error = Object.assign(new Error(reason), { verificationReason: reason });
  failure ??= error;
  active?.reject(error);
}

async function finishPhase(state) {
  await state.done;
  check(!failure, failure?.verificationReason ?? 'verification_failed');
  active = undefined;
  return state;
}

async function request(method, params) {
  if (failure) throw failure;
  return rpc.request(method, params, { timeoutMs: Math.min(20_000, remaining()) });
}

async function normalTurn(name, prompt) {
  stage = name;
  const state = beginPhase(name);
  const response = await request('turn/start', {
    threadId, input: [{ type: 'text', text: prompt, textElements: [] }], effort: 'low',
  });
  check(response.turn?.id, 'turn_start_missing_id');
  check(!state.turnId || state.turnId === response.turn.id, 'turn_identity_mismatch');
  state.turnId = response.turn.id;
  return finishPhase(state);
}

try {
  check(typeof process.env.BRIDGE_CLIENT_HOME === 'string' && path.isAbsolute(process.env.BRIDGE_CLIENT_HOME), 'absolute_client_home_required');
  const clientHome = await realpath(process.env.BRIDGE_CLIENT_HOME);
  configPath = path.join(clientHome, 'config.toml');
  initialDigest = digest(await readFile(configPath));
  temporary = await mkdtemp(path.join(tmpdir(), 'codex-live-compact-'));
  const cwd = path.join(temporary, 'workspace');
  const home = path.join(temporary, 'home');
  await Promise.all([cwd, home].map(directory => mkdir(directory, { mode: 0o700 })));
  const env = { ...process.env, HOME: home, PWD: cwd, TMPDIR: temporary };
  for (const name of Object.keys(env)) {
    if (/^(?:CODEX_|BRIDGE_|OPENAI_|CHATGPT_)/.test(name) || ['LIVE_DESKTOP_BRIDGE_KEY', 'FIXTURE_OPENAI_API_KEY'].includes(name)) delete env[name];
  }
  env.CODEX_HOME = clientHome;
  rpc = new CodexRpc({
    command: process.env.BRIDGE_CODEX_BIN ?? 'codex',
    args: ['app-server', '--listen', 'stdio://', '-c', 'features.remote_compaction_v2=true'],
    cwd, env, requestTimeoutMs: 20_000,
  });
  rpc.on('serverRequest', event => {
    evidence.unexpected_server_requests += 1;
    try { rpc.respondError(event.id, { code: -32601, message: 'Interactive requests are disabled for this verification.' }); }
    catch { /* The global exit handler handles process shutdown. */ }
    failActive('unexpected_interactive_request');
  });
  rpc.on('exit', () => { if (!closing) failActive('official_app_server_exited'); });
  rpc.on('notification', ({ method, params }) => {
    count(evidence.event_counts, eventTypes.has(method) ? method : 'other');
    if (method === 'item/completed') count(evidence.item_counts, itemTypes.has(params?.item?.type) ? params.item.type : 'other');
    if (!active || params?.threadId !== threadId) return;
    if (method === 'error') { failActive('official_turn_error'); return; }
    if (method === 'turn/started') {
      if (active.turnId && active.turnId !== params.turn?.id) { failActive('turn_identity_mismatch'); return; }
      active.turnId = params.turn?.id;
      active.started = true;
    }
    if (params.turnId && active.turnId && params.turnId !== active.turnId) return;
    if (method === 'item/completed') collectItem(active, params.item);
    if (method === 'turn/completed') {
      if (active.turnId && active.turnId !== params.turn?.id) { failActive('turn_identity_mismatch'); return; }
      if (params.turn?.status !== 'completed' || params.turn?.error) { failActive('official_turn_not_completed'); return; }
      for (const item of params.turn.items ?? []) collectItem(active, item);
      active.resolve();
    }
  });
  watchdog = setTimeout(() => {
    failActive('verification_deadline_exceeded');
    closing = true;
    void rpc.close();
  }, remaining());

  stage = 'read_effective_configuration';
  await rpc.start();
  const { config } = await request('config/read', { includeLayers: false, cwd });
  check(config?.model === 'gpt-5.6-sol', 'client_model_is_not_sol');
  const providerId = config.model_provider;
  const provider = config.model_providers?.[providerId];
  check(typeof providerId === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(providerId), 'invalid_provider_identifier');
  check(provider?.name === 'OpenAI', 'provider_name_not_openai');
  check(provider.base_url?.replace(/\/+$/, '') === 'http://127.0.0.1:8879/v1', 'provider_not_expected_local_gateway');
  check(provider.requires_openai_auth === false && provider.supports_websockets === false, 'provider_transport_not_gateway_http');
  check(config.features?.remote_compaction_v2 === true, 'remote_compaction_v2_not_enabled');
  check(config.features?.token_budget !== true && config.features?.token_budget?.enabled !== true, 'token_budget_overrides_v2_compaction');
  evidence.loaded_provider = providerId;
  evidence.loaded_provider_name = provider.name;
  evidence.expected_gateway_confirmed = true;

  stage = 'start_ephemeral_thread';
  const started = await request('thread/start', {
    cwd, ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only',
    config: { model_reasoning_effort: 'low' },
  });
  check(started.model === 'gpt-5.6-sol' && started.modelProvider === providerId, 'thread_model_or_provider_changed');
  check(started.reasoningEffort === 'low', 'thread_reasoning_effort_not_low');
  threadId = started.thread?.id;
  check(typeof threadId === 'string' && threadId.length > 0, 'thread_start_missing_id');

  const nonce = randomBytes(20).toString('hex');
  await normalTurn('remember_nonce', `Remember the following verification nonce exactly for a later turn: ${nonce}. Do not use tools or write it to files. Answer only ACK.`);
  evidence.initial_turn_completed = true;

  stage = 'official_manual_compaction_v2';
  const compact = beginPhase(stage);
  await request('thread/compact/start', { threadId });
  await finishPhase(compact);
  check(compact.compacted, 'context_compaction_item_not_completed');
  evidence.context_compaction_completed = true;

  const recalled = await normalTurn('recall_after_compaction', 'Return exactly the verification nonce from our earlier conversation, with no extra characters or explanation. Do not use tools or read files.');
  const answers = [...recalled.messages.values()].map(text => text.trim());
  check(answers.includes(nonce), 'post_compaction_nonce_mismatch');
  evidence.recall_turn_completed = true;
  evidence.post_compaction_nonce_exact = true;
  check(evidence.unexpected_server_requests === 0, 'unexpected_interactive_request');
  stage = 'complete';
} catch (error) {
  failure ??= Object.assign(new Error('verification_failed'), { verificationReason: error.verificationReason ?? 'verification_failed' });
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  closing = true;
  await rpc?.close();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  if (configPath && initialDigest) {
    try { evidence.client_config_bytes_unchanged = digest(await readFile(configPath)) === initialDigest; }
    catch { evidence.client_config_bytes_unchanged = false; }
  }
  const result = {
    status: failure ? 'failed' : 'passed', stage,
    ...(failure ? { reason: failure.verificationReason } : {}),
    ...evidence,
    note: 'No nonce, account, credential, model output, or raw prompt is recorded. Desktop UI was not tested.',
  };
  await mkdir(path.join(root, '.runtime'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, '.runtime', 'compact-v2-live.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
}
