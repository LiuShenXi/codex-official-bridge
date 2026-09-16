import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCodexRpc } from '../src/runtime.mjs';
import { CodexBridge } from '../src/bridge.mjs';
import { createBridgeServer } from '../src/server.mjs';

// This is an integration test of the real, unmodified official binary. Only its
// model endpoint is replaced: no account, OpenAI connection, or paid inference.
const MODEL = process.env.BRIDGE_VERIFY_MODEL ?? 'bridge-fixture';
const UPSTREAM_KEY = 'official-bridge-local-fixture-key-not-a-real-credential';
const GATEWAY_KEY = 'official-bridge-local-test-client-key';
const callId = `call_fixture_${randomUUID()}`;
const evidence = {
  backend: 'real-official-codex-app-server',
  model: MODEL,
  upstream: 'loopback-controlled-responses-fixture',
  account_used: false,
  actual_openai_inference: false,
  upstream_requests: 0,
  thread_starts: 0,
  turn_starts: 0,
  server_tool_requests: 0,
  registered_upstream_tools: [],
  official_token_usage: [],
  credentials: 'not_observed',
};

let stage = 'prepare';
let upstream;
let gateway;
let rpc;
let bridge;
let fixtureFailure;
let observedToolOutput;
let localToolExecutions = 0;
const temp = await mkdtemp(path.join(tmpdir(), 'codex-official-bridge-verify-'));

function check(condition, reason) {
  if (!condition) throw Object.assign(new Error(reason), { verificationReason: reason });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function closeServer(server) {
  if (!server) return;
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

function declaredTools(body) {
  const declarations = [];
  const append = (tools, source) => {
    check(Array.isArray(tools), 'unsupported_tool_declaration_shape');
    declarations.push({ source, tools });
  };
  if (body.tools !== undefined) append(body.tools, 'tools');
  // Some models receive tool declarations in input[].additional_tools or an
  // additional_tools input item instead of the top-level tools array. Inspect
  // the structured fields, never reinterpret ordinary prompt text as tools.
  const walk = (value, source) => {
    if (Array.isArray(value)) return value.forEach((child, index) => walk(child, `${source}[${index}]`));
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'tools' || key === 'additional_tools') append(child, `${source}.${key}`);
      else walk(child, `${source}.${key}`);
    }
  };
  walk(body.input, 'input');
  const flattened = [];
  const flatten = (tools, prefix = '') => {
    for (const tool of tools) {
      check(tool && typeof tool === 'object' && !Array.isArray(tool), 'unsupported_tool_declaration_shape');
      if (tool.type === 'namespace') {
        check(typeof tool.name === 'string' && Array.isArray(tool.tools), 'unsupported_namespace_declaration_shape');
        // An empty unknown namespace is still an unexpected declaration.
        if (!tool.tools.length) flattened.push({ name: `${prefix}${tool.name}.*`, tool });
        flatten(tool.tools, `${prefix}${tool.name}.`);
      } else flattened.push({ name: `${prefix}${tool.name ?? tool.type ?? '(unknown)'}`, tool });
    }
  };
  for (const { tools } of declarations) flatten(tools);
  return { declarations, flattened };
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(part => part.text ?? '').join('');
  return '';
}

function sendSse(res, item, index) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let sequence = 0;
  const emit = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
  const base = {
    id: `resp_fixture_${index}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
    model: MODEL, output: [], status: 'in_progress', error: null, incomplete_details: null,
  };
  emit('response.created', { response: base });
  emit('response.in_progress', { response: base });
  const added = { ...item, status: 'in_progress', ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) };
  emit('response.output_item.added', { output_index: 0, item: added });
  if (item.type === 'function_call') {
    emit('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
    emit('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
  } else {
    const text = item.content[0].text;
    emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
    emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
    emit('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  }
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: {
    ...base, status: 'completed', output: [item],
    usage: { input_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 23 },
  } });
  res.end();
}

async function fixture(req, res) {
  try {
    const authorization = req.headers.authorization;
    check(authorization === undefined || authorization === `Bearer ${UPSTREAM_KEY}`, 'unexpected_upstream_credential');
    evidence.credentials = authorization === undefined ? 'absent' : 'test_literal_only';
    check(req.method === 'POST' && req.url === '/v1/responses', 'unexpected_upstream_route');
    check(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 'unexpected_request_compression');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      check(bytes <= 1024 * 1024, 'fixture_request_too_large');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    evidence.upstream_requests += 1;
    check(body.model === MODEL, 'model_was_changed');
    check(body.stream === true, 'official_client_did_not_request_streaming');
    const { declarations, flattened } = declaredTools(body);
    const names = flattened.map(entry => entry.name);
    evidence.tool_declaration_locations = [...new Set([...(evidence.tool_declaration_locations ?? []), ...declarations.filter(entry => entry.tools.length).map(entry => entry.source)])];
    evidence.registered_upstream_tools = [...new Set([...evidence.registered_upstream_tools, ...names])];
    evidence.unsupported_native_tools = names.filter(name => name !== 'bridge_fn_0');
    check(names.length >= 1 && evidence.unsupported_native_tools.length === 0, 'unexpected_server_tools_exposed');
    evidence.upstream_tool_strict = flattened[0].tool.strict ?? 'omitted';
    check(flattened.every(entry => entry.tool.type === 'function' && entry.tool.strict === false), 'unexpected_official_dynamic_tool_strict_mode');
    if (evidence.upstream_requests === 1) {
      check(!body.input.some(item => item.type === 'function_call_output'), 'tool_output_present_before_client_execution');
      sendSse(res, { id: 'fc_fixture_1', type: 'function_call', status: 'completed', name: 'bridge_fn_0', call_id: callId, arguments: '{}' }, 1);
    } else {
      check(evidence.upstream_requests === 2, 'unexpected_additional_inference_request');
      const output = body.input.findLast(item => item.type === 'function_call_output' && item.call_id === callId);
      check(output, 'original_call_id_or_client_result_was_lost');
      const parsed = JSON.parse(outputText(output.output));
      check(typeof parsed.nonce === 'string' && parsed.nonce.startsWith('client_nonce_'), 'client_tool_result_was_changed');
      observedToolOutput = parsed.nonce;
      sendSse(res, {
        id: 'msg_fixture_2', type: 'message', role: 'assistant', status: 'completed', phase: 'final_answer',
        content: [{ type: 'output_text', text: `Tool completed: ${parsed.nonce}`, annotations: [] }],
      }, 2);
    }
  } catch (error) {
    fixtureFailure ??= error.verificationReason ?? 'invalid_fixture_request';
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Local fixture rejected request', type: 'fixture_error', code: fixtureFailure } }));
  }
}

async function post(base, body) {
  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GATEWAY_KEY}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  check(response.status === 200, fixtureFailure ?? `gateway_${result.error?.code ?? response.status}`);
  check(result.status === 'completed', 'gateway_response_did_not_complete');
  return result;
}

try {
  const codexHome = path.join(temp, 'codex-home');
  const cwd = path.join(temp, 'empty-workspace');
  const home = path.join(temp, 'home');
  await Promise.all([codexHome, cwd, home].map(dir => mkdir(dir, { recursive: true, mode: 0o700 })));
  const command = process.env.BRIDGE_CODEX_BIN ?? 'codex';
  const fixtureEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: temp, NO_PROXY: '127.0.0.1,localhost', FIXTURE_OPENAI_API_KEY: UPSTREAM_KEY };
  const version = await promisify(execFile)(command, ['--version'], { cwd, env: { ...fixtureEnv, CODEX_HOME: codexHome }, timeout: 5000, maxBuffer: 64 * 1024 });
  check(/^codex-cli [\w.+-]+$/.test(version.stdout.trim()), 'unexpected_official_binary_version');
  evidence.codex_version = version.stdout.trim();
  upstream = http.createServer((req, res) => { void fixture(req, res); });
  const upstreamUrl = await listen(upstream);
  rpc = createCodexRpc({ command, codexHome, cwd }, {
    // Full allowlist: never give the test child the operator's environment.
    env: fixtureEnv,
    extraConfig: {
      model: MODEL,
      model_provider: 'fixture',
      'model_providers.fixture.name': 'Local protocol verification fixture',
      'model_providers.fixture.base_url': `${upstreamUrl}/v1`,
      'model_providers.fixture.wire_api': 'responses',
      'model_providers.fixture.requires_openai_auth': false,
      'model_providers.fixture.supports_websockets': false,
      'model_providers.fixture.env_key': 'FIXTURE_OPENAI_API_KEY',
      'model_providers.fixture.request_max_retries': 0,
      'model_providers.fixture.stream_max_retries': 0,
      'features.enable_request_compression': false,
    },
  });
  const request = rpc.request.bind(rpc);
  rpc.request = (method, ...args) => {
    if (method === 'thread/start') {
      evidence.thread_starts += 1;
      // Current Codex rejects overrides of reserved provider ID "openai".
      // Route only this integration test to a custom loopback provider; the
      // production bridge and official binary remain unchanged.
      args[0] = { ...args[0], modelProvider: 'fixture' };
      evidence.test_only_provider_override = 'fixture';
    }
    if (method === 'turn/start') evidence.turn_starts += 1;
    return request(method, ...args);
  };
  rpc.on('serverRequest', event => {
    if (event.method === 'item/tool/call') evidence.server_tool_requests += 1;
  });
  rpc.on('notification', event => {
    if (event.method === 'thread/tokenUsage/updated') {
      const summarize = usage => ({ input: usage?.inputTokens, output: usage?.outputTokens, total: usage?.totalTokens });
      evidence.official_token_usage.push({ last: summarize(event.params?.tokenUsage?.last), total: summarize(event.params?.tokenUsage?.total) });
    }
  });
  stage = 'official_process_handshake';
  await rpc.start();
  bridge = new CodexBridge({ rpc, cwd, defaultModel: MODEL, requestTimeoutMs: 15_000, sessionTtlMs: 30_000 });
  gateway = createBridgeServer({ bridge, apiKey: GATEWAY_KEY });
  const gatewayUrl = await listen(gateway);
  stage = 'official_function_call';
  const first = await post(gatewayUrl, {
    model: MODEL, input: 'Call local_probe exactly once, then report its returned nonce.',
    tools: [{ type: 'function', name: 'local_probe', description: 'Return a nonce from the local client.', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
  });
  const calls = first.output.filter(item => item.type === 'function_call');
  check(calls.length === 1 && calls[0].name === 'local_probe', 'function_call_not_projected_to_client');
  check(calls[0].arguments === '{}', 'function_arguments_were_changed');
  check(evidence.upstream_requests === 1 && evidence.turn_starts === 1, 'official_turn_did_not_wait_for_client_tool');
  // This executable client step is the only place the nonce is created. The
  // upstream can obtain it solely through the real official tool-result request.
  localToolExecutions += 1;
  const nonce = `client_nonce_${randomUUID()}`;
  stage = 'official_tool_result_continuation';
  const second = await post(gatewayUrl, {
    previous_response_id: first.id,
    input: [{ type: 'function_call_output', call_id: calls[0].call_id, output: JSON.stringify({ nonce }) }],
  });
  const text = second.output.filter(item => item.type === 'message').flatMap(item => item.content).map(part => part.text ?? '').join('');
  check(text === `Tool completed: ${nonce}`, 'final_text_did_not_contain_executed_tool_nonce');
  check(observedToolOutput === nonce && localToolExecutions === 1, 'client_tool_was_not_executed_exactly_once');
  check(evidence.upstream_requests === 2 && evidence.thread_starts === 1 && evidence.turn_starts === 1 && evidence.server_tool_requests === 1, 'tool_result_restarted_or_duplicated_the_official_turn');
  check(second.previous_response_id === first.id, 'response_continuation_link_was_lost');
  // A tool continuation spans multiple inference requests. Preserve this
  // evidence even when the prototype intentionally returns usage:null.
  check(evidence.official_token_usage.some(usage => usage.total.total > 0), 'official_usage_was_not_observed');
  evidence.gateway_usage = second.usage;
  check(!fixtureFailure, fixtureFailure ?? 'fixture_failure');
  console.log(JSON.stringify({ status: 'passed', ...evidence, local_tool_executions: localToolExecutions, nonce_round_trip: 'passed', native_server_tools: 'none', same_official_turn: true, note: 'Verifies real official process and protocol compatibility against a controlled local model endpoint; does not verify an OpenAI account or model quality.' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', stage, reason: fixtureFailure ?? error.verificationReason ?? error.code ?? 'verification_failed', ...evidence }, null, 2));
  process.exitCode = 1;
} finally {
  await closeServer(gateway);
  if (bridge) await bridge.close();
  else if (rpc) await rpc.close();
  await closeServer(upstream);
  await rm(temp, { recursive: true, force: true });
}
