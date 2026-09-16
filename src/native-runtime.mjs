import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, lstat, readFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { BridgeError } from './protocol.mjs';
import { codexEnvironment, PROJECT_ROOT } from './runtime.mjs';

const HOP_HEADERS = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const PRIVATE_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key', 'chatgpt-account-id', 'chatgpt-user-id', 'openai-organization', 'openai-project', 'x-openai-actor-authorization', 'x-openai-fedramp', 'x-codex-runtime-token'];

export function transportHeaders(headers) {
  const excluded = new Set([...HOP_HEADERS, ...PRIVATE_HEADERS, 'host']);
  for (const name of String(headers.connection ?? '').split(',')) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name.toLowerCase())));
}

// The gateway must not deserialize model requests or SSE. This also preserves compressed bytes.
export async function forwardRawRequest({ req, res, signal, port, token, timeoutMs = 120_000, bodyLimit = 16 * 1024 * 1024 }) {
  if (req.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new BridgeError(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
  }
  if (Number(req.headers['content-length']) > bodyLimit) throw new BridgeError(413, 'body_too_large', 'Request body exceeds the configured limit.');
  const chunks = [];
  let length = 0;
  // destroyOnReturn:false permits a proper 413 response if a chunked upload exceeds the limit.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > bodyLimit) { req.resume(); throw new BridgeError(413, 'body_too_large', 'Request body exceeds the configured limit.'); }
    chunks.push(chunk);
  }
  signal?.throwIfAborted();
  const headers = transportHeaders(req.headers);
  headers['x-codex-runtime-token'] = token;
  headers['content-length'] = String(length);
  const upstream = http.request({ hostname: '127.0.0.1', port, method: req.method, path: req.url, headers, signal, agent: false });
  const timeout = setTimeout(() => upstream.destroy(new Error('Runtime request deadline exceeded.')), timeoutMs);
  timeout.unref();
  try {
    const response = await new Promise((resolve, reject) => {
      upstream.once('response', resolve);
      upstream.once('error', reject);
      upstream.end(Buffer.concat(chunks, length));
    });
    res.writeHead(response.statusCode, transportHeaders(response.headers));
    // pipeline carries backpressure and tears down both sockets on interruption.
    await pipeline(response, res, { signal });
  } catch (error) {
    upstream.destroy();
    if (res.headersSent) res.destroy();
    if (signal?.aborted) throw new BridgeError(499, 'client_disconnected', 'The client disconnected.');
    throw new BridgeError(502, 'native_transport_failed', 'The official runtime connection failed.');
  } finally { clearTimeout(timeout); }
}

export class NativeRuntime {
  constructor({ nativeCommand, nativeArgs = [], codexHome, cwd, requestTimeoutMs = 120_000, startupTimeoutMs = 20_000, runtimeDir = path.join(PROJECT_ROOT, '.runtime'), env = process.env }) {
    Object.assign(this, { command: nativeCommand, args: nativeArgs, codexHome, cwd, requestTimeoutMs, startupTimeoutMs, runtimeDir });
    this.env = codexEnvironment(codexHome, env);
    this.closed = true;
  }

  async start() {
    if (this.child) throw new Error('Native runtime already started.');
    this.controlDir = await mkdtemp(path.join(this.runtimeDir, 'native-control-'));
    const controlFile = path.join(this.controlDir, 'ready.json');
    this.child = spawn(this.command, [...this.args, '--control-file', controlFile], { cwd: this.cwd, env: this.env, stdio: ['ignore', 'ignore', 'ignore'] });
    let spawnError;
    let exited = false;
    this.exitPromise = new Promise(resolve => {
      this.child.once('error', error => { spawnError = error; exited = true; this.closed = true; resolve(); });
      this.child.once('exit', () => { exited = true; this.closed = true; resolve(); });
    });
    try {
      const deadline = Date.now() + this.startupTimeoutMs;
      while (Date.now() < deadline) {
        if (spawnError || exited) throw new Error('Native runtime could not start. Build it with npm run build:native.');
        try {
          const stat = await lstat(controlFile);
          if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw new Error('Native runtime control file is not private.');
          let ready;
          try { ready = JSON.parse(await readFile(controlFile, 'utf8')); }
          catch { throw new Error('Native runtime returned invalid control data.'); }
          if (!Number.isInteger(ready.port) || ready.port < 1 || ready.port > 65535 || typeof ready.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(ready.token)) throw new Error('Native runtime returned invalid control data.');
          if (spawnError || exited || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('Native runtime exited before becoming ready.');
          this.port = ready.port;
          this.token = ready.token;
          this.closed = false;
          return;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await delay(50);
      }
      throw new Error('Native runtime startup timed out.');
    } catch (error) { await this.close(); throw error; }
  }

  status() { return { mode: 'native', ready: !this.closed, transport: 'http-sse', toolsExecute: 'client' }; }

  async forward(req, res, { signal, bodyLimit }) {
    if (this.closed) throw new BridgeError(503, 'runtime_unavailable', 'The official runtime is not running.');
    return forwardRawRequest({ req, res, signal, port: this.port, token: this.token, timeoutMs: this.requestTimeoutMs, bodyLimit });
  }

  async close() {
    this.closed = true;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      const force = setTimeout(() => this.child.kill('SIGKILL'), 2000);
      force.unref();
      await this.exitPromise;
      clearTimeout(force);
    }
    this.token = undefined;
    if (this.controlDir) await rm(this.controlDir, { recursive: true, force: true });
  }
}
