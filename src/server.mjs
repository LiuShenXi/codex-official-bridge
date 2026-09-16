import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { BridgeError, errorBody } from './protocol.mjs';

const hash = value => createHash('sha256').update(value).digest();

export function createBridgeServer({ bridge, rawUpstream, apiKey, bodyLimit = rawUpstream ? 16 * 1024 * 1024 : 1024 * 1024 }) {
  if (!apiKey || typeof apiKey !== 'string') throw new Error('BRIDGE_API_KEY is required.');
  const authHash = hash(`Bearer ${apiKey}`);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // This service is a local native-client endpoint; it does not support browser-origin access.
    if (req.headers.origin) return json(res, 403, { error: { code: 'browser_origin_denied', message: 'Browser-origin requests are not supported.' } });
    if (!timingSafeEqual(authHash, hash(req.headers.authorization ?? ''))) return json(res, 401, { error: { code: 'invalid_api_key', message: 'A valid Bearer key is required.' } });
    let url;
    try {
      if (!req.url.startsWith('/') || req.url.startsWith('//')) throw new Error('Expected origin-form URL.');
      url = new URL(req.url, 'http://localhost');
    } catch { return json(res, 400, { error: { code: 'invalid_request_target', message: 'Use an origin-form request path.' } }); }
    const backend = rawUpstream ?? bridge;
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, backend.closed ? 503 : 200, backend.status());
    if (rawUpstream) {
      const allowed = (req.method === 'POST' && ['/v1/responses', '/v1/responses/compact', '/v1/images/generations'].includes(url.pathname) && !url.search)
        || (req.method === 'GET' && url.pathname === '/v1/models');
      // Origin-form targets only; this endpoint cannot select an upstream host.
      if (!allowed || !req.url.startsWith('/v1/') || req.url.startsWith('//')) return json(res, 404, { error: { code: 'not_found', message: 'Unsupported model endpoint.' } });
      const controller = new AbortController();
      req.once('aborted', () => controller.abort());
      res.once('close', () => { if (!res.writableEnded) controller.abort(); });
      try { await rawUpstream.forward(req, res, { signal: controller.signal, bodyLimit }); }
      catch (error) {
        if (res.headersSent) res.destroy();
        else json(res, error instanceof BridgeError ? error.status : 500, errorBody(error));
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/responses/compact') return json(res, 501, { error: { code: 'unsupported_endpoint', message: 'Context compaction is not implemented by this prototype.' } });
    if (req.method !== 'POST' || url.pathname !== '/v1/responses' || url.search) return json(res, 404, { error: { code: 'not_found', message: 'Supported: POST /v1/responses, GET /healthz.' } });
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let streaming = false;
    let heartbeat;
    try {
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new BridgeError(415, 'unsupported_encoding', 'Compressed client request bodies are not supported yet.');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new BridgeError(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
      let length = 0;
      const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        length += chunk.length;
        if (length > bodyLimit) { req.resume(); throw new BridgeError(413, 'body_too_large', `Request body exceeds ${bodyLimit} bytes.`); }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BridgeError(400, 'invalid_json', 'Request body is not valid JSON.'); }
      const onEvent = body?.stream === true ? event => {
        if (res.destroyed) throw new BridgeError(499, 'client_disconnected', 'The client disconnected.');
        if (!streaming) {
          streaming = true;
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
          heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15_000);
          heartbeat.unref();
        }
        if (res.writableLength > 2 * 1024 * 1024) throw new BridgeError(502, 'slow_consumer', 'Client is not consuming the event stream.');
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } : undefined;
      const result = await bridge.respond(body, { signal: controller.signal, onEvent });
      if (streaming) res.end();
      else json(res, 200, result);
    } catch (error) {
      if (!res.destroyed) {
        if (streaming) res.end(); // The bridge emitted response.failed; never write a second JSON envelope.
        else json(res, error instanceof BridgeError ? error.status : 500, errorBody(error));
      }
    } finally { clearInterval(heartbeat); }
  });
  server.on('upgrade', async (req, socket, head) => {
    // An upgrade bypasses the normal HTTP request handler, including its auth.
    // Repeat all boundary checks before opening any runtime connection.
    const deny = (status, code, message) => {
      if (socket.destroyed || socket.writableEnded) return;
      const body = JSON.stringify({ error: { code, message } });
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\n\r\n${body}`);
    };
    socket.on('error', () => {});
    if (req.headers.origin) return deny(403, 'browser_origin_denied', 'Browser-origin requests are not supported.');
    if (!timingSafeEqual(authHash, hash(req.headers.authorization ?? ''))) return deny(401, 'invalid_api_key', 'A valid Bearer key is required.');
    if (!rawUpstream || typeof rawUpstream.forwardWebSocket !== 'function') return deny(501, 'websocket_unavailable', 'WebSocket requires the native runtime.');
    if (req.method !== 'GET' || req.url !== '/v1/responses') return deny(404, 'not_found', 'Unsupported WebSocket endpoint.');
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) {
      return deny(400, 'invalid_websocket_handshake', 'A valid WebSocket version 13 handshake is required.');
    }
    const controller = new AbortController();
    socket.once('close', () => controller.abort());
    try { await rawUpstream.forwardWebSocket(req, socket, head, { signal: controller.signal, bodyLimit }); }
    catch (error) { deny(error instanceof BridgeError ? error.status : 502, error instanceof BridgeError ? error.code : 'native_websocket_failed', 'The official runtime WebSocket connection failed.'); }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5000;
  return server;
}

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
