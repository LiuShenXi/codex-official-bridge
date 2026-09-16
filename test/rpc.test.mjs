import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from '../src/rpc.mjs';
import { codexEnvironment } from '../src/runtime.mjs';

const fixture = fileURLToPath(new URL('./fixtures/rpc-child.mjs', import.meta.url));

test('the spawned process receives the sanitized environment without re-inheriting removed values', async (t) => {
  const previous = process.env.BRIDGE_TEST_SENTINEL;
  process.env.BRIDGE_TEST_SENTINEL = 'synthetic-parent-value';
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_TEST_SENTINEL;
    else process.env.BRIDGE_TEST_SENTINEL = previous;
  });
  const env = codexEnvironment('/tmp/unused-test-home', {
    ...process.env, OPENAI_API_KEY: 'synthetic-api-key', OPENAI_BASE_URL: 'http://unused.invalid',
    CODEX_THREAD_ID: 'synthetic-thread', HTTPS_PROXY: 'http://unused.invalid',
  });
  const rpc = await started(t, { env });
  assert.deepEqual(await rpc.request('environment-presence', {
    keys: ['BRIDGE_TEST_SENTINEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_THREAD_ID', 'CODEX_HOME', 'HTTPS_PROXY'],
  }), {
    BRIDGE_TEST_SENTINEL: false, OPENAI_API_KEY: false, OPENAI_BASE_URL: false,
    CODEX_THREAD_ID: false, CODEX_HOME: true, HTTPS_PROXY: true,
  });
});

async function started(t, options = {}) {
  const rpc = new CodexRpc({ command: process.execPath, args: [fixture], requestTimeoutMs: 1000, ...options });
  t.after(() => rpc.close());
  await rpc.start();
  return rpc;
}

test('initializes once, parses split UTF-8 and CRLF, correlates out-of-order responses', async (t) => {
  const rpc = await started(t);
  assert.equal(await rpc.start(), rpc);
  assert.equal(rpc.started, true);
  const order = [];
  const slow = rpc.request('delayed', { value: '慢', delay: 60 }).then((value) => { order.push(value); return value; });
  const fast = rpc.request('delayed', { value: '快', delay: 5 }).then((value) => { order.push(value); return value; });
  assert.deepEqual(await Promise.all([slow, fast]), ['慢', '快']);
  assert.deepEqual(order, ['快', '慢']);
  const notification = once(rpc, 'notification');
  rpc.notify('notify', { text: '通知' });
  assert.deepEqual((await notification)[0], { method: 'fixture/notification', params: { text: '通知' } });
});

test('emits server requests and responds with the original string RPC id', async (t) => {
  const rpc = await started(t);
  const serverRequest = once(rpc, 'serverRequest');
  const result = rpc.request('tool');
  const [request] = await serverRequest;
  assert.deepEqual(request, {
    id: 'tool-1', method: 'item/tool/call', params: { name: 'local_tool', arguments: { a: 1 } },
  });
  rpc.respond(request.id, { output: 'local-result' });
  assert.deepEqual(await result, { toolResponse: { id: 'tool-1', result: { output: 'local-result' } } });
});

test('returns explicit server request errors and propagates remote RPC errors', async (t) => {
  const rpc = await started(t);
  const serverRequest = once(rpc, 'serverRequest');
  const result = rpc.request('tool');
  const [request] = await serverRequest;
  rpc.respondError(request.id, { code: -32601, message: 'Denied' });
  assert.deepEqual(await result, { toolResponse: { id: 'tool-1', error: { code: -32601, message: 'Denied' } } });
  await assert.rejects(rpc.request('error'), { code: -32001, message: 'Fixture failure', data: { retry: false } });
});

test('times out a request, ignores late responses, and remains usable', async (t) => {
  const rpc = await started(t);
  await assert.rejects(rpc.request('delayed', { value: 'late', delay: 40 }, { timeoutMs: 10 }), { code: 'RPC_TIMEOUT' });
  assert.equal(await rpc.request('delayed', { value: 'next', delay: 70 }), 'next');
  assert.equal(rpc.closed, false);
});

test('process exit rejects all pending requests once without exposing stderr', async (t) => {
  const rpc = await started(t);
  const exits = [];
  rpc.on('exit', (error) => exits.push(error));
  const first = assert.rejects(rpc.request('never'), { code: 'RPC_PROCESS_EXIT', exitCode: 23 });
  const second = assert.rejects(rpc.request('exit'), { code: 'RPC_PROCESS_EXIT', exitCode: 23 });
  await Promise.all([first, second]);
  assert.equal(exits.length, 1);
  assert.doesNotMatch(exits[0].message, /sensitive-token/);
  assert.equal(rpc.started, false);
  assert.equal(rpc.closed, true);
  await assert.rejects(rpc.request('echo', {}), { code: 'RPC_PROCESS_EXIT' });
});

for (const method of ['malformed', 'invalid-envelope']) {
  test(`${method} terminates the transport and rejects pending calls`, async (t) => {
    const rpc = await started(t);
    await assert.rejects(rpc.request(method), { code: 'RPC_PROTOCOL_ERROR' });
    assert.equal(rpc.closed, true);
  });
}

test('rejects an oversized unterminated JSONL line', async (t) => {
  const rpc = await started(t, { maxLineBytes: 256 });
  await assert.rejects(rpc.request('oversized', { bytes: 1024 }), { code: 'RPC_PROTOCOL_ERROR' });
  assert.equal(rpc.closed, true);
});

test('close rejects pending requests and kills an uncooperative child', async (t) => {
  const rpc = await started(t, { args: [fixture, 'ignore-term'] });
  const pending = assert.rejects(rpc.request('never'), { code: 'RPC_CLOSED' });
  await rpc.close();
  await pending;
  await rpc.close();
  assert.equal(rpc.closed, true);
  assert.throws(() => rpc.notify('anything'), { code: 'RPC_CLOSED' });
});

test('startup failures and initialization timeouts reject cleanly without an error listener', async (t) => {
  const missing = new CodexRpc({ command: '/nonexistent/codex-fixture' });
  t.after(() => missing.close());
  await assert.rejects(missing.start(), { code: 'RPC_PROCESS_ERROR' });
  const timeout = new CodexRpc({ command: process.execPath, args: [fixture, 'hang-init'], requestTimeoutMs: 100 });
  t.after(() => timeout.close());
  await assert.rejects(timeout.start(), { code: 'RPC_TIMEOUT' });
  assert.equal(timeout.closed, true);
});

test('calls before start reject and close before start is idempotent', async () => {
  const rpc = new CodexRpc();
  await assert.rejects(rpc.request('echo'), { code: 'RPC_NOT_STARTED' });
  await rpc.close();
  await rpc.close();
  await assert.rejects(rpc.start(), { code: 'RPC_CLOSED' });
});
