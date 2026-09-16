#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// A bounded, dependency-free RFC 6455 client for transport acceptance, not a
// production WebSocket implementation. It deliberately negotiates no compression.
export function encodeFrame(payload, { opcode = 1, masked = true, fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const extra = body.length < 126 ? 0 : body.length < 65536 ? 2 : 8;
  const header = Buffer.alloc(2 + extra + (masked ? 4 : 0));
  header[0] = (fin ? 0x80 : 0) | opcode;
  header[1] = (masked ? 0x80 : 0) | (extra === 0 ? body.length : extra === 2 ? 126 : 127);
  if (extra === 2) header.writeUInt16BE(body.length, 2);
  if (extra === 8) header.writeBigUInt64BE(BigInt(body.length), 2);
  if (!masked) return Buffer.concat([header, body]);
  const mask = randomBytes(4);
  mask.copy(header, 2 + extra);
  const copy = Buffer.from(body);
  for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i % 4];
  return Buffer.concat([header, copy]);
}

export function frameDecoder(onFrame, { maxBytes = 32 * 1024 * 1024 } = {}) {
  let buffered = Buffer.alloc(0);
  return chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const fin = Boolean(buffered[0] & 128);
      const opcode = buffered[0] & 15;
      if (buffered[0] & 112) throw failure('unexpected_compressed_frame');
      const masked = Boolean(buffered[1] & 128);
      let length = buffered[1] & 127;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const wide = buffered.readBigUInt64BE(2);
        if (wide > BigInt(maxBytes)) throw failure('websocket_frame_too_large');
        length = Number(wide); offset = 10;
      }
      if (length > maxBytes) throw failure('websocket_frame_too_large');
      if (opcode >= 8 && (!fin || length > 125)) throw failure('invalid_control_frame');
      if (buffered.length < offset + (masked ? 4 : 0) + length) return;
      const mask = masked ? buffered.subarray(offset, offset + 4) : null;
      offset += masked ? 4 : 0;
      const payload = Buffer.from(buffered.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffered = buffered.subarray(offset + length);
      onFrame({ opcode, fin, masked, payload });
    }
  };
}

function failure(reason, httpStatus) { return Object.assign(new Error(reason), { reason, httpStatus }); }

export function openWebSocket(address, { apiKey, headers = {}, timeoutMs = 15000, maxBytes = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(address); } catch { reject(failure('invalid_websocket_url')); return; }
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
      reject(failure('invalid_websocket_url')); return;
    }
    const key = randomBytes(16).toString('base64');
    const request = (url.protocol === 'wss:' ? https : http).request({
      hostname: url.hostname, port: url.port || (url.protocol === 'wss:' ? 443 : 80),
      path: url.pathname + url.search, method: 'GET', headers: {
        ...headers, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': key, 'sec-websocket-version': '13',
      },
    });
    const timer = setTimeout(() => request.destroy(failure('websocket_handshake_timeout')), timeoutMs);
    request.once('error', error => { clearTimeout(timer); reject(failure(error.reason ?? 'websocket_connection_failed')); });
    request.once('response', response => {
      clearTimeout(timer); response.resume(); reject(failure('websocket_upgrade_rejected', response.statusCode));
    });
    request.once('upgrade', (response, socket, head) => {
      clearTimeout(timer);
      const expected = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (response.headers['sec-websocket-accept'] !== expected || response.headers['sec-websocket-extensions']) {
        socket.destroy(); reject(failure('invalid_websocket_upgrade')); return;
      }
      const queue = []; const waiters = [];
      let ended; let sentClose = false; let fragmentOpcode; let fragments = []; let fragmentBytes = 0;
      const push = event => { const waiting = waiters.shift(); if (waiting) { clearTimeout(waiting.timer); waiting.resolve(event); } else queue.push(event); };
      const stop = error => {
        if (ended) return;
        ended = error;
        for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
      };
      const decode = frameDecoder(frame => {
        if (frame.masked) throw failure('masked_server_frame');
        if (frame.opcode === 9) { socket.write(encodeFrame(frame.payload, { opcode: 10 })); return; }
        if (frame.opcode === 10) return;
        if (frame.opcode === 8) {
          const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
          push({ type: 'close', code });
          if (!sentClose) { sentClose = true; socket.write(encodeFrame(frame.payload, { opcode: 8 })); }
          socket.end(); return;
        }
        if (![0, 1, 2].includes(frame.opcode)) throw failure('unexpected_websocket_opcode');
        if (frame.opcode === 0 && fragmentOpcode === undefined) throw failure('unexpected_continuation');
        if (frame.opcode !== 0 && fragmentOpcode !== undefined) throw failure('interleaved_fragments');
        if (frame.opcode !== 0) fragmentOpcode = frame.opcode;
        fragments.push(frame.payload); fragmentBytes += frame.payload.length;
        if (fragmentBytes > maxBytes) throw failure('websocket_message_too_large');
        if (frame.fin) {
          const payload = Buffer.concat(fragments);
          push({ type: fragmentOpcode === 1 ? 'text' : 'binary', data: payload });
          fragments = []; fragmentBytes = 0; fragmentOpcode = undefined;
        }
      }, { maxBytes });
      const consume = chunk => { try { decode(chunk); } catch (error) { stop(failure(error.reason ?? 'invalid_websocket_frame')); socket.destroy(); } };
      socket.on('data', consume);
      socket.on('error', () => stop(failure('websocket_socket_error')));
      socket.on('close', () => stop(failure('websocket_closed')));
      resolve({
        statusCode: response.statusCode, headers: response.headers,
        send: (payload, options = {}) => socket.write(encodeFrame(payload, options)),
        sendJSON: value => socket.write(encodeFrame(JSON.stringify(value))),
        receive: (waitMs = timeoutMs) => {
          if (queue.length) return Promise.resolve(queue.shift());
          if (ended) return Promise.reject(ended);
          return new Promise((res, rej) => {
            const item = { resolve: res, reject: rej };
            item.timer = setTimeout(() => { const index = waiters.indexOf(item); if (index >= 0) waiters.splice(index, 1); rej(failure('websocket_receive_timeout')); }, waitMs);
            waiters.push(item);
          });
        },
        close: (code = 1000) => { if (!sentClose) { const body = Buffer.alloc(2); body.writeUInt16BE(code); sentClose = true; socket.write(encodeFrame(body, { opcode: 8 })); } },
        terminate: () => socket.destroy(),
      });
      if (head.length) consume(head);
    });
    request.end();
  });
}

// Explicit opt-in is mandatory: this part sends paid model requests. No account
// token, request header values, prompts, tool arguments, or model text are logged.
export async function verifyLive({ address, apiKey, model = 'gpt-6-astra', timeoutMs = 120000 }) {
  const evidence = { mode: 'live', model, event_counts: {}, completed_models: [], completed_output_sources: [], completed_response_id_present: [], websocket_connections: 0 };
  let client;
  const ensure = (condition, reason) => { if (!condition) throw failure(reason); };
  const receiveJson = async () => {
    const frame = await client.receive(timeoutMs);
    ensure(frame.type === 'text', 'expected_text_event');
    let event; try { event = JSON.parse(frame.data); } catch { throw failure('invalid_event_json'); }
    const type = /^[a-z_.]{1,100}$/.test(event.type) ? event.type : 'other';
    evidence.event_counts[type] = (evidence.event_counts[type] ?? 0) + 1;
    ensure(!['error', 'response.failed'].includes(event.type), 'upstream_model_error');
    return event;
  };
  const complete = async () => {
    const doneItems = new Map();
    for (let count = 0; count < 10000; count++) {
      const event = await receiveJson();
      // Codex can send each finished item once and leave completed.output empty.
      // Only finished items count: arguments/text deltas and item.added do not
      // establish a completed tool call or assistant message.
      if (event.type === 'response.output_item.done' && event.item && typeof event.item === 'object') {
        const key = Number.isInteger(event.output_index) ? `index:${event.output_index}` : event.item.id ? `id:${event.item.id}` : `sequence:${doneItems.size}`;
        doneItems.set(key, event.item);
      }
      if (event.type === 'response.completed') {
        ensure(event.response && typeof event.response === 'object', 'invalid_completed_response');
        const hasFinalOutput = Array.isArray(event.response.output) && event.response.output.length > 0;
        const output = hasFinalOutput ? event.response.output : [...doneItems.values()];
        evidence.completed_models.push(/^[\w.-]{1,100}$/.test(event.response?.model) ? event.response.model : 'unavailable');
        evidence.completed_output_sources.push(hasFinalOutput ? 'completed_response' : doneItems.size ? 'output_item_done' : 'none');
        evidence.completed_response_id_present.push(typeof event.response.id === 'string' && event.response.id.length > 0);
        return { ...event.response, output };
      }
    }
    throw failure('event_limit_exceeded');
  };
  try {
    ensure(apiKey && typeof apiKey === 'string', 'bridge_api_key_required');
    const url = new URL(address);
    ensure(url.pathname === '/v1/responses' && !url.search, 'responses_endpoint_required');
    try {
      const denied = await openWebSocket(address, { apiKey: randomBytes(32).toString('hex') });
      denied.terminate(); throw failure('invalid_key_was_accepted');
    } catch (error) { ensure(error.httpStatus === 401, 'invalid_key_not_rejected_with_401'); }
    evidence.invalid_key_rejected = true;
    client = await openWebSocket(address, { apiKey, headers: { 'openai-beta': 'responses_websockets=2026-02-06', originator: 'codex_bridge_verification' } });
    evidence.websocket_connections = 1;
    const tool = { type: 'function', name: 'verification_echo', description: 'Return the supplied validation string.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, strict: true };
    const common = { type: 'response.create', model, store: false, stream: true, tools: [tool], reasoning: { effort: 'low' } };
    client.sendJSON({ ...common, tool_choice: { type: 'function', name: tool.name }, input: [{ role: 'user', content: 'Call verification_echo with value transport-check. Do not call any other tool.' }] });
    const first = await complete();
    const call = first.output?.find(item => item.type === 'function_call' && item.name === tool.name);
    ensure(call?.call_id && first.id, 'function_call_not_completed');
    evidence.function_call_completed = true;
    const nonce = randomBytes(18).toString('hex');
    client.sendJSON({ ...common, previous_response_id: first.id, tool_choice: 'none', input: [{ type: 'function_call_output', call_id: call.call_id, output: nonce }, { role: 'user', content: 'Reply with exactly the tool result, without other text.' }] });
    const second = await complete();
    const finalText = (second.output ?? []).flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('').trim();
    ensure(finalText === nonce, 'tool_round_trip_mismatch');
    ensure((evidence.event_counts['codex.response.metadata'] ?? 0) >= 2, 'per_turn_metadata_missing');
    evidence.previous_response_id_round_trip = true;
    evidence.same_connection_tool_continuation = true;
    evidence.metadata_received = true;
    client.close(1000);
    const closing = await client.receive(10000);
    ensure(closing.type === 'close', 'close_handshake_incomplete');
    evidence.close_handshake_received = true;
    return { status: 'passed', ...evidence, note: 'Two model generations completed on one connection. Active-generation cancellation is covered by the local contract test, not inferred from this normal close.' };
  } catch (error) {
    return { status: 'failed', reason: error.reason ?? 'verification_failed', ...evidence };
  } finally { client?.terminate(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--live')) {
    console.log('No network request made. Local contract: node --test test/websocket-contract.test.mjs. Live opt-in: BRIDGE_API_KEY=<private> BRIDGE_URL=http://127.0.0.1:8879/v1 node scripts/verify-websocket.mjs --live. Optional BRIDGE_MODEL defaults to gpt-6-astra.');
  } else {
    let result;
    try {
      const base = new URL(process.env.BRIDGE_URL ?? 'http://127.0.0.1:8879/v1');
      base.protocol = base.protocol === 'https:' ? 'wss:' : base.protocol === 'http:' ? 'ws:' : base.protocol;
      base.pathname = base.pathname.replace(/\/$/, '') + '/responses';
      result = await verifyLive({ address: base.href, apiKey: process.env.BRIDGE_API_KEY, model: process.env.BRIDGE_MODEL ?? 'gpt-6-astra' });
    } catch { result = { status: 'failed', reason: 'invalid_configuration' }; }
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'passed') process.exitCode = 1;
  }
}
