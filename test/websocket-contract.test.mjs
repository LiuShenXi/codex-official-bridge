import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createBridgeServer } from '../src/server.mjs';
import { forwardRawWebSocket } from '../src/native-runtime.mjs';
import { encodeFrame, frameDecoder, openWebSocket, verifyLive } from '../scripts/verify-websocket.mjs';

async function setup(t, { onMessage, onUpgrade, timeoutMs = 1500 } = {}) {
  const requests = []; const messages = []; const sockets = new Set();
  const upstream = http.createServer();
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.on('upgrade', (req, socket, head) => {
    requests.push({ headers: req.headers, url: req.url, socket });
    if (onUpgrade) return onUpgrade(req, socket, head);
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\nX-Codex-Turn-State: handshake-state\r\n\r\n');
    const send = (body, options = {}) => socket.write(encodeFrame(body, { ...options, masked: false }));
    const decode = frameDecoder(frame => {
      if (frame.opcode === 8) { send(frame.payload, { opcode: 8 }); socket.end(); return; }
      if (frame.opcode === 9) { send(frame.payload, { opcode: 10 }); return; }
      messages.push(frame);
      if (onMessage) onMessage(frame, { socket, send, messages });
      else send(frame.payload, { opcode: frame.opcode });
    });
    socket.on('data', decode);
    if (head.length) decode(head);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const rawUpstream = {
    closed: false, status: () => ({ ready: true }), forward: () => { throw new Error('Unexpected HTTP request.'); },
    forwardWebSocket: (req, socket, head, { signal }) => forwardRawWebSocket({ req, socket, head, signal, port: upstream.address().port, token: 'runtime-contract-token', timeoutMs }),
  };
  const gateway = createBridgeServer({ rawUpstream, apiKey: 'gateway-contract-key' });
  gateway.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const address = `ws://127.0.0.1:${gateway.address().port}/v1/responses`;
  return { address, gateway, upstream, requests, messages, open: options => openWebSocket(address, { apiKey: 'gateway-contract-key', ...options }) };
}

async function eventually(predicate, timeout = 1000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Expected transport event did not arrive.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('one WS preserves metadata, unknown fields, previous_response_id and tool output over multiple turns', async t => {
  const seen = [];
  const metadata = '{"type":"codex.response.metadata","headers":{"x-codex-turn-state":"opaque-state","future-header":"unchanged"},"future_field":[true,null,12]}';
  const fixture = await setup(t, { onMessage: (frame, { send }) => {
    assert.equal(frame.opcode, 1);
    const request = JSON.parse(frame.payload);
    seen.push(request);
    send(metadata);
    if (seen.length === 1) {
      send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_first', model: 'gpt-6-astra', output: [{ type: 'function_call', call_id: 'call_local', name: 'verification_echo', arguments: '{"value":"transport-check"}' }] } }));
    } else {
      assert.equal(request.previous_response_id, 'resp_first');
      assert.equal(request.input[0].type, 'function_call_output');
      assert.equal(request.input[0].call_id, 'call_local');
      send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_second', model: 'gpt-6-astra', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: request.input[0].output }] }] } }));
    }
  } });
  const result = await verifyLive({ address: fixture.address, apiKey: 'gateway-contract-key', timeoutMs: 1000 });
  assert.equal(result.status, 'passed', result.reason);
  assert.equal(result.same_connection_tool_continuation, true);
  assert.equal(result.previous_response_id_round_trip, true);
  assert.equal(result.event_counts['codex.response.metadata'], 2);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].headers.authorization, undefined);
  assert.equal(fixture.requests[0].headers['x-codex-runtime-token'], 'runtime-contract-token');
  assert.equal(fixture.requests[0].headers['openai-beta'], 'responses_websockets=2026-02-06');
});

test('live verifier collects finished streamed items when completed.output is empty', async t => {
  let turn = 0;
  const fixture = await setup(t, { onMessage: (frame, { send }) => {
    const request = JSON.parse(frame.payload);
    send('{"type":"codex.response.metadata","headers":{}}');
    if (turn++ === 0) {
      const item = { id: 'fc_fixture', type: 'function_call', call_id: 'call_streamed', name: 'verification_echo', arguments: '{"value":"transport-check"}' };
      send(JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } }));
      send(JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments }));
      send(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }));
      send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_streamed_first', model: 'gpt-6-astra', output: [] } }));
    } else {
      assert.equal(request.previous_response_id, 'resp_streamed_first');
      assert.equal(request.input[0].call_id, 'call_streamed');
      const item = { id: 'msg_fixture', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: request.input[0].output }] };
      send(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }));
      send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_streamed_second', model: 'gpt-6-astra', output: [] } }));
    }
  } });
  const result = await verifyLive({ address: fixture.address, apiKey: 'gateway-contract-key', timeoutMs: 1000 });
  assert.equal(result.status, 'passed', result.reason);
  assert.deepEqual(result.completed_output_sources, ['output_item_done', 'output_item_done']);
  assert.deepEqual(result.completed_response_id_present, [true, true]);
  assert.equal(fixture.requests.length, 1);
});

test('live verifier does not mistake added or partial function arguments for a completed call', async t => {
  const fixture = await setup(t, { onMessage: (_frame, { send }) => {
    send(JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'verification_echo', call_id: 'call_partial' } }));
    send(JSON.stringify({ type: 'response.completed', response: { id: 'resp_partial', model: 'gpt-6-astra', output: [] } }));
  } });
  const result = await verifyLive({ address: fixture.address, apiKey: 'gateway-contract-key', timeoutMs: 1000 });
  assert.equal(result.status, 'failed'); assert.equal(result.reason, 'function_call_not_completed');
  assert.deepEqual(result.completed_output_sources, ['none']);
});

test('text, fragmented frames, binary bytes and persistent idle connection remain transparent', async t => {
  const fixture = await setup(t, { timeoutMs: 100, onMessage: (frame, { send }) => send(frame.payload, { opcode: frame.opcode, fin: frame.fin }) });
  const client = await fixture.open();
  t.after(() => client.terminate());
  assert.equal(client.headers['x-codex-turn-state'], 'handshake-state');
  await new Promise(resolve => setTimeout(resolve, 180)); // Handshake timer must not terminate an idle session.
  const raw = '{ "type": "response.create", "previous_response_id":"resp_opaque", "future": [1,null,"中文"] }';
  client.send(raw.slice(0, 20), { opcode: 1, fin: false });
  client.send(raw.slice(20), { opcode: 0, fin: true });
  const echoed = await client.receive();
  assert.equal(echoed.type, 'text');
  assert.equal(echoed.data.toString(), raw);
  const bytes = Buffer.from([0, 255, 128, 1, 7, 8, 127]);
  client.send(bytes, { opcode: 2 });
  assert.deepEqual((await client.receive()).data, bytes);
  client.close(1000);
  assert.deepEqual(await client.receive(), { type: 'close', code: 1000 });
});

test('auth, browser origin, unsupported route and query are rejected before dialing runtime', async t => {
  const fixture = await setup(t);
  const cases = [
    [fixture.address, { apiKey: 'wrong-private-key' }, 401],
    [fixture.address, { headers: { origin: 'https://untrusted.test' } }, 403],
    [fixture.address.replace('/responses', '/models'), {}, 404],
    [fixture.address + '?target=outside', {}, 404],
  ];
  for (const [url, options, status] of cases) {
    await assert.rejects(openWebSocket(url, { apiKey: 'gateway-contract-key', ...options }), error => error.httpStatus === status && !error.message.includes('private-key'));
  }
  assert.equal(fixture.requests.length, 0);
});

test('upgrade head containing first client frame is delivered once without byte loss', async t => {
  const fixture = await setup(t);
  const socket = net.connect(fixture.gateway.address().port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  const key = randomBytes(16).toString('base64');
  const first = Buffer.from('{ "type":"response.create", "input":[], "future": true }');
  const handshake = Buffer.from(`GET /v1/responses HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer gateway-contract-key\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  socket.write(Buffer.concat([handshake, encodeFrame(first)]));
  await eventually(() => fixture.messages.length > 0);
  assert.equal(fixture.messages.length, 1);
  assert.deepEqual(fixture.messages[0].payload, first);
  socket.destroy();
});

test('upgrade response head preserves complete metadata and binary frames byte for byte', async t => {
  const metadata = Buffer.from('{ "type":"codex.response.metadata", "headers":{"x-codex-turn-state":"opaque","unknown-quota":[1,2]}, "future":null }');
  const binary = Buffer.from([9, 0, 255, 88, 27]);
  const fixture = await setup(t, { onUpgrade: (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const headers = Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.write(Buffer.concat([headers, encodeFrame(metadata, { masked: false }), encodeFrame(binary, { opcode: 2, masked: false })]));
    socket.resume();
  } });
  const client = await fixture.open();
  t.after(() => client.terminate());
  assert.deepEqual((await client.receive()).data, metadata);
  assert.deepEqual((await client.receive()).data, binary);
});

test('closing client during a running generation cancels the runtime connection', async t => {
  const fixture = await setup(t, { onMessage: (_frame, { send }) => send('{"type":"response.created","response":{"id":"resp_running"}}') });
  const client = await fixture.open();
  t.after(() => client.terminate());
  client.sendJSON({ type: 'response.create', input: [{ role: 'user', content: 'fixture' }] });
  assert.equal(JSON.parse((await client.receive()).data).type, 'response.created');
  const upstreamClosed = once(fixture.requests[0].socket, 'close');
  client.close(1000);
  assert.equal((await client.receive()).type, 'close');
  await Promise.race([upstreamClosed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('runtime socket survived cancellation')), 1000); timer.unref(); })]);
});

test('runtime close code and abnormal disconnection are surfaced without fabricated completion', async t => {
  let count = 0;
  const fixture = await setup(t, { onMessage: (_frame, { socket, send }) => {
    if (count++ === 0) { const body = Buffer.alloc(2); body.writeUInt16BE(1008); send(body, { opcode: 8 }); }
    else socket.destroy();
  } });
  const first = await fixture.open();
  first.sendJSON({ type: 'response.create' });
  assert.deepEqual(await first.receive(), { type: 'close', code: 1008 });
  first.terminate();
  const second = await fixture.open();
  second.sendJSON({ type: 'response.create' });
  await assert.rejects(second.receive(), error => ['websocket_closed', 'websocket_socket_error'].includes(error.reason));
  second.terminate();
});

test('non-101 runtime status survives and a hanging handshake has a bounded failure', async t => {
  const rejected = await setup(t, { onUpgrade: (_req, socket) => socket.end('HTTP/1.1 429 Too Many Requests\r\nContent-Length: 2\r\nRetry-After: 13\r\nConnection: close\r\n\r\n{}') });
  await assert.rejects(rejected.open(), error => error.httpStatus === 429);
  const hanging = await setup(t, { timeoutMs: 80, onUpgrade: (_req, socket) => socket.resume() });
  const start = Date.now();
  await assert.rejects(hanging.open({ timeoutMs: 1000 }), error => [502, 503, 504].includes(error.httpStatus));
  assert.ok(Date.now() - start < 900);
  // An upgraded mock socket may allow half-open TCP; EOF proves the gateway
  // released its side even if this intentionally non-responsive peer stays open.
  await eventually(() => hanging.requests[0].socket.readableEnded || hanging.requests[0].socket.destroyed);
});
