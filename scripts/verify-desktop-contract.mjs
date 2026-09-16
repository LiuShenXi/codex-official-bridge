#!/usr/bin/env node
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { configArguments, ISOLATED_CONFIG } from '../src/runtime.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { forwardRawRequest } from '../src/native-runtime.mjs';

// Runs the actual official client, including its native tool dispatcher. This
// fixture only supplies model responses; it never executes the requested patch.
// Requests go through the real gateway and raw transport before the fixture.
const model = process.env.BRIDGE_DESKTOP_MODEL ?? 'gpt-5.5';
const command = process.env.BRIDGE_CODEX_BIN ?? 'codex';
const gatewayKey = 'desktop-contract-local-client-not-a-real-key';
const runtimeToken = 'desktop_contract_private_runtime_fixture_token';
const callId = `call_desktop_${randomUUID()}`;
const fileName = 'native-edit.txt';
const before = 'before official native tool\n';
const after = `after official native tool ${randomUUID()}\n`;
const patch = `*** Begin Patch\n*** Update File: ${fileName}\n@@\n-${before.trimEnd()}\n+${after.trimEnd()}\n*** End Patch`;
const evidence = {
  client: 'real-official-codex-exec',
  gateway: 'createBridgeServer-rawUpstream-forwardRawRequest',
  model,
  upstream: 'loopback-controlled-responses-fixture',
  actual_openai_inference: false,
  account_used: false,
  credentials: 'not_observed',
  upstream_requests: [],
  native_tool_round_trip: null,
};

let upstream;
let gateway;
let failure;
let stage = 'prepare';
const gatewayRequestHashes = [];
const temporary = await mkdtemp(path.join(tmpdir(), 'codex-desktop-contract-'));
const cwd = path.join(temporary, 'empty-workspace');
const codexHome = path.join(temporary, 'codex-home');
const home = path.join(temporary, 'home');
const exec = promisify(execFile);

function check(condition, reason) {
  if (!condition) throw Object.assign(new Error(reason), { verificationReason: reason });
}

function toolDeclarations(body) {
  const entries = [];
  const append = (tools, location, namespace = '') => {
    check(Array.isArray(tools), 'invalid_tool_declaration');
    for (const tool of tools) {
      if (tool.type === 'namespace') append(tool.tools, location, `${namespace}${tool.name}.`);
      else entries.push({
        location, type: tool.type, name: `${namespace}${tool.name ?? '(unnamed)'}`,
        ...(tool.format ? { format_type: tool.format.type, grammar_syntax: tool.format.syntax } : {}),
      });
    }
  };
  if (body.tools) append(body.tools, 'tools');
  for (const [index, item] of (body.input ?? []).entries()) {
    if (item.tools) append(item.tools, `input[${index}].tools`);
    if (item.additional_tools) append(item.additional_tools, `input[${index}].additional_tools`);
  }
  return entries;
}

function requestShape(body) {
  return {
    top_level_fields: Object.keys(body).sort(),
    model: body.model,
    stream: body.stream,
    input: (body.input ?? []).map(item => ({
      type: item.type ?? 'message',
      ...(item.role ? { role: item.role } : {}),
      fields: Object.keys(item).sort(),
      ...(Array.isArray(item.content) ? { content_types: item.content.map(part => part.type) } : {}),
    })),
    tool_declarations: toolDeclarations(body),
    reasoning_fields: Object.keys(body.reasoning ?? {}).sort(),
    has_previous_response_id: typeof body.previous_response_id === 'string',
  };
}

function sendSse(response, item, index) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let sequence = 0;
  const emit = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`);
  const base = { id: `resp_desktop_${index}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model, output: [], status: 'in_progress', error: null };
  emit('response.created', { response: base });
  emit('response.in_progress', { response: base });
  emit('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', ...(item.type === 'custom_tool_call' ? { input: '' } : { content: [] }) } });
  if (item.type === 'custom_tool_call') {
    emit('response.custom_tool_call_input.delta', { item_id: item.id, output_index: 0, delta: item.input });
    emit('response.custom_tool_call_input.done', { item_id: item.id, output_index: 0, input: item.input });
  } else {
    const text = item.content[0].text;
    emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
    emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
    emit('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  }
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: {
    ...base, status: 'completed', output: [item], incomplete_details: null,
    usage: { input_tokens: 16, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 23 },
  } });
  response.end();
}

async function serve(request, response) {
  try {
    check(request.method === 'POST' && request.url === '/v1/responses', 'unexpected_upstream_route');
    check(request.headers['x-codex-runtime-token'] === runtimeToken, 'runtime_token_missing');
    check(request.headers.authorization === undefined, 'client_authorization_leaked_to_runtime');
    check(!Object.values(request.headers).some(value => String(value).includes(gatewayKey)), 'client_key_leaked_to_runtime');
    evidence.credentials = 'client_key_stripped_runtime_token_only';
    check(!request.headers['content-encoding'] || request.headers['content-encoding'] === 'identity', 'unexpected_request_compression');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      check(bytes < 4 * 1024 * 1024, 'request_too_large');
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks);
    const bodyHash = createHash('sha256').update(rawBody).digest('hex');
    check(gatewayRequestHashes[evidence.upstream_requests.length] === bodyHash, 'request_bytes_changed_in_gateway');
    const body = JSON.parse(rawBody.toString('utf8'));
    check(body.model === model && body.stream === true, 'unexpected_model_or_transport');
    evidence.upstream_requests.push({ ...requestShape(body), gateway_request_bytes_preserved: true, request_bytes: rawBody.length });
    const count = evidence.upstream_requests.length;
    check(count <= 2, 'unexpected_extra_model_request');
    const expectedName = model === 'gpt-5.6-sol' ? 'functions.exec' : 'apply_patch';
    const declaration = toolDeclarations(body).find(tool => tool.name === expectedName);
    check(declaration?.type === 'custom' && declaration.format_type === 'grammar', 'native_custom_grammar_tool_missing');
    if (count === 1) {
      check(await readFile(path.join(cwd, fileName), 'utf8') === before, 'file_changed_before_tool_request');
      const item = {
        id: 'ctc_desktop_1', type: 'custom_tool_call', status: 'completed', call_id: callId,
        name: model === 'gpt-5.6-sol' ? 'exec' : 'apply_patch',
        ...(model === 'gpt-5.6-sol' ? { namespace: 'functions' } : {}),
        input: model === 'gpt-5.6-sol' ? `text(await tools.apply_patch(${JSON.stringify(patch)}));` : patch,
      };
      evidence.native_tool_round_trip = { issued: item };
      stage = 'official_native_tool_execution';
      sendSse(response, item, count);
      return;
    }
    const originalCall = body.input.find(item => item.type === 'custom_tool_call' && item.call_id === callId);
    const toolOutput = body.input.find(item => item.type === 'custom_tool_call_output' && item.call_id === callId);
    check(originalCall, 'original_custom_tool_call_not_preserved');
    check(originalCall.input === evidence.native_tool_round_trip.issued.input, 'custom_tool_input_was_changed');
    check(toolOutput, 'native_custom_tool_output_missing');
    check(!body.input.some(item => item.type === 'function_call_output' && item.call_id === callId), 'custom_tool_was_converted_to_function');
    evidence.native_tool_round_trip.returned_call = originalCall;
    evidence.native_tool_round_trip.returned_output = toolOutput;
    check(await readFile(path.join(cwd, fileName), 'utf8') === after, 'official_client_did_not_apply_native_patch');
    evidence.native_tool_round_trip.file_modified_by_official_client = true;
    stage = 'official_final_answer';
    sendSse(response, {
      id: 'msg_desktop_2', type: 'message', status: 'completed', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'DESKTOP_CONTRACT_OK', annotations: [] }],
    }, count);
  } catch (error) {
    failure ??= error.verificationReason ?? 'invalid_fixture_request';
    if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'fixture_error', code: failure, message: 'Local contract fixture rejected the request.' } }));
  }
}

try {
  check(['gpt-5.5', 'gpt-5.6-sol'].includes(model), 'unsupported_test_model');
  await Promise.all([cwd, codexHome, home].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
  // Only the initial file is written by this harness. All later modifications
  // must come from the real official client's built-in tool implementation.
  await writeFile(path.join(cwd, fileName), before, { mode: 0o600 });
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome,
    TMPDIR: temporary, NO_PROXY: '127.0.0.1,localhost', FIXTURE_OPENAI_API_KEY: gatewayKey,
  };
  const version = await exec(command, ['--version'], { cwd, env, timeout: 5000, maxBuffer: 64 * 1024 });
  check(/^codex-cli [\w.+-]+$/.test(version.stdout.trim()), 'unexpected_official_binary_version');
  evidence.codex_version = version.stdout.trim();
  upstream = http.createServer((request, response) => { void serve(request, response); });
  await new Promise((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  gateway = createBridgeServer({
    apiKey: gatewayKey,
    rawUpstream: {
      closed: false,
      status() { return { mode: 'native-fixture', ready: true }; },
      async forward(req, res, { signal, bodyLimit }) {
        const hash = createHash('sha256');
        const index = gatewayRequestHashes.push(null) - 1;
        req.on('data', chunk => hash.update(chunk));
        req.once('end', () => { gatewayRequestHashes[index] = hash.digest('hex'); });
        return forwardRawRequest({ req, res, signal, port: upstream.address().port, token: runtimeToken, timeoutMs: 20_000, bodyLimit });
      },
    },
  });
  await new Promise((resolve, reject) => {
    gateway.once('error', reject);
    gateway.listen(0, '127.0.0.1', resolve);
  });
  const address = `http://127.0.0.1:${gateway.address().port}/v1`;
  const config = {
    ...ISOLATED_CONFIG,
    // The client owns these native tools. Sol's functions.exec requires its
    // local code-mode runtime; disabling it would only test a rejected call.
    ...(model === 'gpt-5.6-sol' ? { 'features.code_mode': true, 'features.code_mode_host': true } : {}),
    model,
    model_provider: 'desktop_fixture',
    approval_policy: 'never',
    'model_providers.desktop_fixture.name': 'OpenAI',
    'model_providers.desktop_fixture.base_url': address,
    'model_providers.desktop_fixture.wire_api': 'responses',
    'model_providers.desktop_fixture.requires_openai_auth': false,
    'model_providers.desktop_fixture.supports_websockets': false,
    'model_providers.desktop_fixture.env_key': 'FIXTURE_OPENAI_API_KEY',
    'model_providers.desktop_fixture.request_max_retries': 0,
    'model_providers.desktop_fixture.stream_max_retries': 0,
    'features.enable_request_compression': false,
    'sandbox_workspace_write.network_access': false,
  };
  const args = [
    'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'workspace-write', '--strict-config', '--json', '--model', model,
    ...configArguments(config),
    `Apply the supplied native tool patch to ${fileName} in this workspace. Then answer briefly.`,
  ];
  stage = 'official_exec';
  let result;
  try {
    const running = exec(command, args, { cwd, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    // execFile creates a pipe. Codex appends piped stdin even with a prompt, so
    // close it explicitly instead of leaving the official client waiting.
    running.child.stdin.end();
    result = await running;
  }
  catch (error) {
    evidence.official_exit_code = typeof error.code === 'number' ? error.code : null;
    evidence.official_timed_out = Boolean(error.killed);
    if (process.env.BRIDGE_DESKTOP_DEBUG === '1') {
      evidence.isolated_stderr_tail = String(error.stderr ?? '').slice(-4096)
        .replaceAll(temporary, '<temporary-root>').replaceAll(gatewayKey, '<fixture-key>').replaceAll(runtimeToken, '<runtime-token>')
        .replace(/Bearer\s+[^\s"']+/gi, 'Bearer <redacted>');
    }
    throw Object.assign(new Error('official_exec_failed'), { verificationReason: failure ?? 'official_exec_failed' });
  }
  check(!failure, failure ?? 'fixture_failed');
  evidence.official_exit_code = 0;
  const events = result.stdout.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  evidence.official_event_types = events.map(event => event.type);
  evidence.official_item_types = events.flatMap(event => event.item?.type ? [event.item.type] : []);
  check(evidence.upstream_requests.length === 2, 'native_tool_round_trip_incomplete');
  check(evidence.native_tool_round_trip?.file_modified_by_official_client, 'native_patch_not_verified');
  check(result.stdout.includes('DESKTOP_CONTRACT_OK'), 'official_final_answer_missing');
  check(await readFile(path.join(cwd, fileName), 'utf8') === after, 'native_patch_did_not_persist');
  console.log(JSON.stringify({ status: 'passed', ...evidence, note: 'Real official client native custom-tool execution through the gateway raw branch and private runtime transport. The runtime is a controlled local model fixture; this does not test an OpenAI account or desktop UI.' }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', stage, reason: failure ?? error.verificationReason ?? error.code ?? 'verification_failed', ...evidence }, null, 2));
  process.exitCode = 1;
} finally {
  if (gateway) await new Promise(resolve => { gateway.close(resolve); gateway.closeAllConnections(); });
  if (upstream) await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
  await rm(temporary, { recursive: true, force: true });
}
