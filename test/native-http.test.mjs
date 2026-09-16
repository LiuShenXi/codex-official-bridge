import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';
import { createBridgeServer } from '../src/server.mjs';
import { forwardRawRequest } from '../src/native-runtime.mjs';

async function setup(t, handler, options = {}) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks) });
    await handler(req, res, requests.at(-1));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const rawUpstream = {
    closed: false,
    status: () => ({ mode: 'native', ready: true }),
    forward: (req, res, { signal, bodyLimit }) => forwardRawRequest({ req, res, signal, bodyLimit, port: upstream.address().port, token: 'private-runtime-token', timeoutMs: 2000 }),
  };
  const gateway = createBridgeServer({ apiKey: 'gateway-key', rawUpstream, ...options });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(async () => {
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const url = `http://127.0.0.1:${gateway.address().port}`;
  const post = (body, { path = '/v1/responses', headers = {}, ...rest } = {}) => fetch(url + path, { method: 'POST', body, headers: { authorization: 'Bearer gateway-key', 'content-type': 'application/json', ...headers }, ...rest });
  return { requests, gateway, upstream, post, url };
}

test('raw native request and future SSE events survive without JSON/tool conversion', async t => {
  const payload = Buffer.from('{ "input":[{"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[{"type":"custom","name":"exec","format":{"type":"grammar","syntax":"lark","definition":"start: /.+/"}}]}]},{"type":"reasoning","encrypted_content":"opaque"}],"tool_choice":"auto","future_field":1,"stream":true }');
  const events = Buffer.from('event: response.future_event\r\ndata: {"encrypted_content":"raw","unknown":[1,2]}\r\n\r\nevent: response.completed\ndata: {"usage":{"total_tokens":9}}\n\n');
  const { post, requests } = await setup(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'opaque-state', 'set-cookie': 'secret=server' });
    res.write(events.subarray(0, 17));
    res.end(events.subarray(17));
  });
  const response = await post(payload, { headers: { 'x-codex-turn-state': 'previous-state', 'chatgpt-account-id': 'client-account-must-not-leak', 'x-openai-fedramp': '1', cookie: 'client=cookie', 'x-api-key': 'other-key', 'x-codex-runtime-token': 'client-spoof' } });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), events);
  assert.equal(response.headers.get('x-codex-turn-state'), 'opaque-state');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(requests[0].body, payload);
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(requests[0].headers['chatgpt-account-id'], undefined);
  assert.equal(requests[0].headers['x-api-key'], undefined);
  assert.equal(requests[0].headers['x-openai-fedramp'], undefined);
  assert.equal(requests[0].headers['x-codex-runtime-token'], 'private-runtime-token');
  assert.equal(requests[0].headers['x-codex-turn-state'], 'previous-state');
});

test('compressed request bytes and encoding survive unchanged', async t => {
  const body = gzipSync(Buffer.from('{"tools":[{"type":"custom"}],"input":[]}'));
  const { post, requests } = await setup(t, async (_req, res) => res.end('{"ok":true}'));
  assert.equal((await post(body, { headers: { 'content-encoding': 'gzip' } })).status, 200);
  assert.deepEqual(requests[0].body, body);
  assert.equal(requests[0].headers['content-encoding'], 'gzip');
});

test('official 429 status, retry headers and structured error body survive', async t => {
  const body = '{ "error": {"code":"usage_limit_reached","reset":123,"message":"upstream limit"} }';
  const { post } = await setup(t, async (_req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '17', 'x-request-id': 'upstream-id' }); res.end(body); });
  const response = await post('{}');
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '17');
  assert.equal(response.headers.get('x-request-id'), 'upstream-id');
  assert.equal(await response.text(), body);
});

test('compact and Codex model directory use the same raw transport', async t => {
  const { post, url, requests } = await setup(t, async (_req, res, request) => {
    res.setHeader('content-type', 'application/json');
    res.end(request.method === 'GET' ? '{"models":[{"slug":"test-model","future":true}]}' : '{"output":[{"type":"compaction","encrypted_content":"opaque"}]}');
  });
  const compact = await post('{"input":[],"instructions":"same"}', { path: '/v1/responses/compact' });
  assert.equal((await compact.json()).output[0].encrypted_content, 'opaque');
  const models = await fetch(`${url}/v1/models?client_version=0.154.0-alpha.6.2`, { headers: { authorization: 'Bearer gateway-key' } });
  assert.equal((await models.json()).models[0].future, true);
  assert.equal(requests[1].url, '/v1/models?client_version=0.154.0-alpha.6.2');
});

test('unauthorized, unsupported and oversized requests never reach official transport', async t => {
  const { post, requests } = await setup(t, async (_req, res) => res.end('{}'), { bodyLimit: 64 });
  assert.equal((await post('{}', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await post('{}', { headers: { origin: 'https://example.test' } })).status, 403);
  assert.equal((await post('{}', { path: '/v1/chat/completions' })).status, 404);
  assert.equal((await post('{}', { path: '/v1/responses?upstream=https://example.test' })).status, 404);
  assert.equal((await post('{}', { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await post('x'.repeat(65))).status, 413);
  assert.equal(requests.length, 0);
});

test('chunked upload over the limit returns complete 413 and keeps the connection usable', async t => {
  const { url, requests } = await setup(t, async (_req, res) => res.end('{"ok":true}'), { bodyLimit: 64 });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const headers = { authorization: 'Bearer gateway-key', 'content-type': 'application/json' };
  const first = await new Promise((resolve, reject) => {
    const request = http.request(`${url}/v1/responses`, {
      method: 'POST', agent, headers: { ...headers, 'transfer-encoding': 'chunked' },
    });
    let socket;
    request.once('socket', value => { socket = value; });
    request.once('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('Chunked limit response timed out.')));
    request.once('response', response => {
      // The oversized upload has not ended yet. Finish its framing only after
      // receiving 413, so this exercises iterator cleanup before request EOF.
      request.end();
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: JSON.parse(text), socket }));
    });
    assert.equal(request.getHeader('content-length'), undefined);
    request.write('a'.repeat(32));
    setImmediate(() => request.write('b'.repeat(33)));
  });
  assert.equal(first.status, 413);
  assert.equal(first.body.error.code, 'body_too_large');
  assert.equal(requests.length, 0);
  assert.equal(first.socket.destroyed, false);

  const second = await new Promise((resolve, reject) => {
    const request = http.request(`${url}/v1/responses`, { method: 'POST', agent, headers }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: text, socket: request.socket, reused: request.reusedSocket }));
    });
    request.once('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('Follow-up request timed out.')));
    request.end('{}');
  });
  assert.equal(second.status, 200);
  assert.equal(second.body, '{"ok":true}');
  assert.equal(second.reused, true);
  assert.equal(second.socket, first.socket);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.toString(), '{}');
});

test('client cancellation closes the ongoing official event stream', async t => {
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const { post } = await setup(t, async (_req, res) => {
    res.on('close', resolveClosed);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: {}\n\n');
  });
  const controller = new AbortController();
  const response = await post('{}', { signal: controller.signal });
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read());
  await Promise.race([closed, new Promise((_, reject) => { const timeout = setTimeout(() => reject(new Error('upstream not cancelled')), 1000); timeout.unref(); })]);
});

test('upstream disconnect after headers aborts the response instead of synthesizing success', async t => {
  const { post } = await setup(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.created\ndata: {}\n\n');
    setTimeout(() => res.destroy(), 30);
  });
  const response = await post('{}');
  await assert.rejects(response.text());
});

test('malformed authority request targets return 400 without crashing the gateway', async t => {
  const { gateway, post, requests } = await setup(t, async (_req, res) => res.end('{}'));
  const socket = net.connect(gateway.address().port, '127.0.0.1');
  const chunks = [];
  socket.on('data', chunk => chunks.push(chunk));
  socket.write('GET //[/v1/models HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer gateway-key\r\nConnection: close\r\n\r\n');
  await once(socket, 'end');
  assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1.1 400 /);
  assert.equal(requests.length, 0);
  assert.equal((await post('{}')).status, 200);
});
