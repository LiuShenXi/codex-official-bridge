import http from 'node:http';
import { BridgeError } from './protocol.mjs';

// Node does not terminate WebSocket here. It authenticates the local client,
// relays the runtime's handshake, and carries the original frames in both
// directions. The official Rust connector owns the upstream WS session.
export function tunnelWebSocket({ req, socket, head = Buffer.alloc(0), signal, port, token, timeoutMs = 30_000, filterHeaders }) {
  return new Promise((resolve, reject) => {
    let upstreamSocket;
    let responseStarted = false;
    let settled = false;
    let upgraded = false;
    socket.pause();
    const headers = filterHeaders(req.headers);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    headers['x-codex-runtime-token'] = token;
    delete headers['content-length'];
    const upstream = http.request({ hostname: '127.0.0.1', port, method: 'GET', path: req.url, headers, agent: false });
    const deadline = setTimeout(() => fail('native_websocket_handshake_timeout'), Math.min(timeoutMs, 30_000));
    deadline.unref();
    function cleanup() {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
    }
    function settle(error) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    }
    function fail(code = 'native_websocket_failed') {
      upstream.destroy();
      upstreamSocket?.destroy();
      if (responseStarted) {
        socket.destroy();
        settle();
      } else settle(new BridgeError(502, code, 'The official runtime WebSocket connection failed.'));
    }
    function onAbort() {
      upstream.destroy();
      upstreamSocket?.destroy();
      socket.destroy();
      settle();
    }
    function writeHead(status, fields) {
      const pairs = [];
      for (const [name, values] of Object.entries(fields)) {
        for (const value of Array.isArray(values) ? values : [values]) {
          if (value !== undefined) pairs.push(`${name}: ${value}\r\n`);
        }
      }
      responseStarted = true;
      socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Upstream Response'}\r\n${pairs.join('')}\r\n`);
    }
    socket.once('error', onAbort);
    socket.once('close', () => {
      upstream.destroy();
      upstreamSocket?.destroy();
      settle();
    });
    upstream.once('error', () => {
      if (!settled) fail();
    });
    upstream.once('upgrade', (response, peer, upstreamHead) => {
      if (settled || socket.destroyed || signal?.aborted) { peer.destroy(); return; }
      if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket') { peer.destroy(); fail(); return; }
      upgraded = true;
      clearTimeout(deadline); // A successful, reusable session has no overall request deadline.
      upstreamSocket = peer;
      peer.on('error', () => fail());
      peer.once('close', () => {
        if (!peer.readableEnded) socket.destroy();
        else if (!socket.writableEnded) socket.end();
      });
      const outputHeaders = filterHeaders(response.headers);
      outputHeaders.connection = 'Upgrade';
      outputHeaders.upgrade = 'websocket';
      delete outputHeaders['content-length'];
      writeHead(101, outputHeaders);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      // pipe propagates backpressure and EOF. Errors/abrupt closes tear down
      // the other side; no frame or JSON is interpreted, synthesized, or retried.
      socket.pipe(peer);
      peer.pipe(socket);
      socket.resume();
    });
    upstream.once('response', response => {
      if (settled || upgraded || socket.destroyed) { response.destroy(); return; }
      // Rejected handshakes must finish their HTTP error body within the same deadline.
      const outputHeaders = filterHeaders(response.headers);
      // IncomingMessage removes chunk framing, so a rejected handshake is
      // relayed using Content-Length (if supplied) or connection-close framing.
      outputHeaders.connection = 'close';
      writeHead(response.statusCode, outputHeaders);
      response.once('error', () => fail());
      response.pipe(socket);
      socket.resume();
    });
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    upstream.end();
  });
}
