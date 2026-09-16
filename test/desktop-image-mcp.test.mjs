import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createImageService, decodeImageResponse, inspectPng, loadConnection, serveStdio } from '../scripts/desktop-image-mcp.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDuoAAAAASUVORK5CYII=', 'base64');
const KEY = 'test-only-not-a-real-key';
const response = () => new Response(JSON.stringify({ created: 123, background: 'opaque', data: [{ b64_json: PNG.toString('base64'), generation_id: 'fixture' }], output_format: 'png', quality: 'medium', size: '1x1', usage: {} }), { headers: { 'Content-Type': 'application/json' } });

async function fixture(t, fetchImpl) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-image-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'output'); await mkdir(output);
  const profile = path.join(root, 'connection.json');
  await writeFile(profile, JSON.stringify({ base_url: 'http://127.0.0.1:8879/v1', api_key: KEY }));
  const service = createImageService({ profilePath: profile, outputRoots: [output], fetchImpl });
  return { root, output, profile, service };
}

test('official Codex image JSON becomes a PNG with real dimensions; no foreign provider or key in output', async t => {
  let observed;
  const f = await fixture(t, async (url, options) => { observed = { url: String(url), options }; return response(); });
  const result = await f.service.generate({ prompt: 'Draw a pelican', output_path: path.join(f.output, 'new', 'pelican.png') });
  assert.equal(observed.url, 'http://127.0.0.1:8879/v1/images/generations');
  assert.equal(observed.options.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(observed.options.redirect, 'error');
  assert.deepEqual(JSON.parse(observed.options.body), { prompt: 'Draw a pelican', background: 'auto', model: 'gpt-image-2', quality: 'auto', size: 'auto' });
  assert.deepEqual(await readFile(result.path), PNG);
  assert.equal(result.width, 1); assert.equal(result.height, 1);
  assert.equal(result.native_image_gen, false);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('existing output and invalid paths are rejected before any image request', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(); });
  const existing = path.join(f.output, 'exists.png'); await writeFile(existing, 'keep');
  for (const [output_path, code] of [[existing, 'output_exists'], ['relative.png', 'invalid_output_path'], [path.join(f.root, 'outside.png'), 'output_outside_root'], [path.join(f.output, 'bad.txt'), 'invalid_output_path']]) {
    await assert.rejects(f.service.generate({ prompt: 'test', output_path }), error => error.code === code);
  }
  assert.equal(calls, 0); assert.equal(await readFile(existing, 'utf8'), 'keep');
});

test('directory symlinks and junctions cannot escape the output root', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return response(); });
  const outside = path.join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.service.generate({ prompt: 'test', output_path: path.join(f.output, 'linked', 'nested', 'escape.png') }), error => error.code === 'output_outside_root');
  assert.equal(calls, 0);
  await assert.rejects(access(path.join(outside, 'nested')));
});

test('overlapping calls reserve the target before submission, preventing duplicate generation', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const f = await fixture(t, async () => { calls++; entered(); await gate; return response(); });
  const args = { prompt: 'test', output_path: path.join(f.output, 'same.png') };
  const first = f.service.generate(args); await started;
  await assert.rejects(f.service.generate(args), error => error.code === 'output_exists');
  release(); await first;
  assert.equal(calls, 1);
});

test('HTTP failure does not echo remote secrets, retry, or leave an empty output', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return new Response(`secret:${KEY}`, { status: 401 }); });
  const target = path.join(f.output, 'failed.png');
  await assert.rejects(f.service.generate({ prompt: 'test', output_path: target }), error => error.code === 'image_request_failed' && error.details.http_status === 401 && !JSON.stringify(error).includes(KEY));
  assert.equal(calls, 1); await assert.rejects(access(target));
});

test('network failure is uncertain and never auto-retried; subsequent call re-reads authoritative profile', async t => {
  let calls = 0;
  const f = await fixture(t, async (_url, options) => { calls++; if (calls === 1) throw new Error(KEY); assert.equal(options.headers.Authorization, 'Bearer rotated-test-key'); return response(); });
  const target = path.join(f.output, 'retry.png');
  await assert.rejects(f.service.generate({ prompt: 'test', output_path: target }), error => error.code === 'image_request_interrupted' && !error.message.includes(KEY));
  assert.equal(calls, 1); await assert.rejects(access(target));
  await writeFile(f.profile, JSON.stringify({ base_url: 'http://127.0.0.1:8879/v1', api_key: 'rotated-test-key' }));
  await f.service.generate({ prompt: 'user-authorized new attempt', output_path: target });
});

test('HTTP 200 followed by a broken response stream reports uncertain completion without retry or raw errors', async t => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('{"data":[')); },
      pull(controller) { controller.error(new Error(`private remote diagnostic ${KEY}`)); },
    }), { headers: { 'Content-Type': 'application/json' } });
  });
  const target = path.join(f.output, 'interrupted.png');
  await assert.rejects(f.service.generate({ prompt: 'test', output_path: target }), error => {
    assert.equal(error.code, 'completion_uncertain');
    assert.deepEqual(error.details, { completion_uncertain: true, retry_safe: false });
    assert.match(error.message, /do not automatically retry/);
    assert.equal(error.message.includes(KEY), false);
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(access(target));
});

test('authoritative connection profiles written by Windows PowerShell with UTF-8 BOM are readable', async t => {
  const f = await fixture(t, async () => response());
  await writeFile(f.profile, '\uFEFF' + JSON.stringify({ base_url: 'http://127.0.0.1:8879/v1', api_key: KEY }), 'utf8');
  const connection = await loadConnection(f.profile);
  assert.equal(connection.endpoint.href, 'http://127.0.0.1:8879/v1/images/generations');
  assert.equal(connection.apiKey, KEY);
  const result = await f.service.generate({ prompt: 'BOM profile test', output_path: path.join(f.output, 'bom.png') });
  assert.deepEqual(await readFile(result.path), PNG);
});

test('unsupported response URLs, malformed base64 and truncated PNG are rejected, never downloaded', () => {
  for (const data of [[{ url: 'https://attacker.invalid/image.png' }], [{ b64_json: 'invalid' }], [{ b64_json: PNG.subarray(0, 40).toString('base64') }]]) assert.throws(() => decodeImageResponse(Buffer.from(JSON.stringify({ data }))));
  assert.throws(() => decodeImageResponse(Buffer.from('data: {}\n\n'), 'text/event-stream'));
  assert.deepEqual(inspectPng(PNG), { width: 1, height: 1, mime_type: 'image/png' });
});

test('profile URLs cannot contain embedded auth, off-loopback plaintext, query or arbitrary path', async t => {
  const f = await fixture(t, async () => response());
  for (const base_url of ['http://example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?key=hidden', 'https://example.com/v1/other', 'file:///v1']) {
    await writeFile(f.profile, JSON.stringify({ base_url, api_key: KEY }));
    await assert.rejects(loadConnection(f.profile), error => error.code === 'profile_invalid');
  }
});

test('get_status makes only a health request and never claims an image was generated', async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => { calls.push({ url: String(url), options }); return new Response('{}'); });
  const result = await f.service.getStatus();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'http://127.0.0.1:8879/healthz');
  assert.equal(calls[0].options.method, undefined); assert.equal(calls[0].options.body, undefined);
  assert.equal(result.bridge_reachable, true); assert.equal(result.image_generation_verified, false);
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('stdio initializes, advertises both tools and masks unexpected errors', async t => {
  const input = new PassThrough(), output = new PassThrough(); let text = '';
  output.on('data', chunk => { text += chunk; });
  serveStdio({ getStatus: async () => { throw new Error(KEY); }, generate: async () => ({}) }, { input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_status', arguments: {} } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  const messages = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(messages.length, 3);
  assert.equal(messages[0].result.protocolVersion, '2025-06-18');
  assert.deepEqual(messages[1].result.tools.map(tool => tool.name), ['get_status', 'generate_image']);
  assert.equal(messages[2].result.isError, true); assert.equal(text.includes(KEY), false);
  input.end();
});

test('stdio cancellation aborts an in-flight image request', async t => {
  const input = new PassThrough(), output = new PassThrough(); let aborted = false, started;
  const gate = new Promise(resolve => { started = resolve; });
  serveStdio({ generate: async (_args, { signal }) => { started(); await new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); throw new Error('cancelled'); } }, { input, output });
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'test' } } }) + '\n');
  await gate;
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true); input.end();
});

test('real stdio child calls only the configured local bridge and produces the requested file', { timeout: 10_000 }, async t => {
  const f = await fixture(t, async () => response());
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    res.setHeader('Content-Type', 'application/json');
    res.end(req.url === '/healthz' ? '{}' : JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeFile(f.profile, JSON.stringify({ base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: KEY }));
  const script = fileURLToPath(new URL('../scripts/desktop-image-mcp.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--profile', f.profile, '--output-root', f.output], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  const replies = new Map(); let text = '', stderr = '', id = 0;
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    text += chunk;
    let split;
    while ((split = text.indexOf('\n')) >= 0) { const value = JSON.parse(text.slice(0, split)); text = text.slice(split + 1); replies.get(value.id)?.(value); }
  });
  const call = (method, params = {}) => { const requestId = ++id; const result = new Promise(resolve => replies.set(requestId, resolve)); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n'); return result; };
  const initialized = await call('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(initialized.result.serverInfo.name, 'codex-official-bridge-images');
  assert.equal(initialized.result.serverInfo.version, '0.2.0');
  const health = await call('tools/call', { name: 'get_status' });
  assert.equal(health.result.structuredContent.bridge_reachable, true);
  const target = path.join(f.output, 'integration.png');
  const generated = await call('tools/call', { name: 'generate_image', arguments: { prompt: 'offline fixture image', output_path: target } });
  assert.equal(generated.result.structuredContent.path, await realpath(target));
  assert.deepEqual(await readFile(target), PNG);
  assert.deepEqual(calls.map(item => [item.method, item.url]), [['GET', '/healthz'], ['POST', '/v1/images/generations']]);
  assert.ok(calls.every(item => item.auth === `Bearer ${KEY}`));
  assert.equal(JSON.stringify([initialized, health, generated]).includes(KEY), false);
  assert.equal(stderr, ''); child.stdin.end();
});
