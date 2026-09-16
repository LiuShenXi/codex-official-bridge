import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridge } from '../src/bridge.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { FakeRpc } from './fixtures/fake-rpc.mjs';

const tools = [{
  type: 'function', name: 'read_local_note', description: 'Read the client note.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: false,
}];

async function setup(t, { turns, requestTimeoutMs = 1000, sessionTtlMs = 2000, bodyLimit = 1048576 } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-bridge-http-test-'));
  const rpc = new FakeRpc({ turns });
  const bridge = new CodexBridge({ rpc, cwd, defaultModel: 'test-model', requestTimeoutMs, sessionTtlMs });
  const server = createBridgeServer({ bridge, apiKey: 'test-secret', bodyLimit });
  t.after(async () => {
    await bridge.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(cwd, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  async function post(body, { key = 'test-secret', path = '/v1/responses', signal = AbortSignal.timeout(5000) } = {}) {
    return fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key === null ? {} : { authorization: `Bearer ${key}` }) },
      body: JSON.stringify(body), signal,
    });
  }
  return { rpc, bridge, server, url, post };
}

async function jsonOk(response) {
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.match(body.id, /^resp_/);
  assert.ok(Array.isArray(body.output));
  return body;
}

function textOf(response) {
  return response.output.filter((item) => item.type === 'message')
    .flatMap((item) => item.content).filter((part) => part.type === 'output_text').map((part) => part.text).join('');
}

function calls(rpc, method) { return rpc.requests.filter((request) => request.method === method); }

async function clientError(response) {
  const body = await response.json();
  assert.ok(response.status >= 400 && response.status < 500, `Expected a client error, got ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(typeof body.error?.message, 'string');
  return body;
}

async function sseEvents(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const text = await response.text();
  return text.split(/\r?\n\r?\n/).filter(Boolean).flatMap((block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    return !data || data === '[DONE]' ? [] : [JSON.parse(data)];
  });
}

async function waitForRequest(rpc, method) {
  if (calls(rpc, method).length) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rpc.off('request', onRequest);
      reject(new Error(`Timed out waiting for ${method}.`));
    }, 2000);
    function onRequest(request) {
      if (request.method !== method) return;
      clearTimeout(timer);
      rpc.off('request', onRequest);
      resolve();
    }
    rpc.on('request', onRequest);
  });
}

test('requires Bearer authentication before starting an official turn', async (t) => {
  const { post, rpc } = await setup(t);
  for (const key of [null, 'wrong-secret']) {
    const response = await post({ input: 'hello' }, { key });
    assert.equal(response.status, 401);
    await clientError(response);
  }
  assert.equal(calls(rpc, 'turn/start').length, 0);
  assert.equal(textOf(await jsonOk(await post({ input: 'hello' }))), 'fixture text 1');
});

test('text JSON returns a completed response and ordinary continuation reuses the thread', async (t) => {
  const { post, rpc } = await setup(t);
  const first = await jsonOk(await post({ model: 'test-model', input: 'hello' }));
  assert.equal(first.model, 'test-model');
  assert.equal(textOf(first), 'fixture text 1');
  const second = await jsonOk(await post({ previous_response_id: first.id, input: 'continue' }));
  assert.equal(second.previous_response_id, first.id);
  assert.equal(textOf(second), 'fixture text 2');
  assert.equal(calls(rpc, 'thread/start').length, 1);
  assert.equal(calls(rpc, 'turn/start').length, 2);
  assert.equal(calls(rpc, 'turn/start')[0].params.threadId, calls(rpc, 'turn/start')[1].params.threadId);
});

test('typed SSE has ordered lifecycle events and reconstructs the completed text', async (t) => {
  const { post } = await setup(t, { turns: [{ text: '工具与 text streaming ✓' }] });
  const events = await sseEvents(await post({ input: 'hello', stream: true }));
  assert.equal(events[0].type, 'response.created');
  assert.ok(events.some((event) => event.type === 'response.in_progress'));
  assert.equal(events.at(-1).type, 'response.completed');
  assert.equal(events.filter((event) => event.type === 'response.completed').length, 1);
  assert.ok(events.some((event) => event.type === 'response.output_item.done'));
  assert.ok(events.some((event) => event.type === 'response.output_text.done'));
  const deltas = events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta).join('');
  assert.equal(deltas, '工具与 text streaming ✓');
  assert.equal(textOf(events.at(-1).response), deltas);
  assert.equal(events.at(-1).response.status, 'completed');
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(events[index].sequence_number > events[index - 1].sequence_number);
  }
});

for (const stream of [false, true]) {
  test(`external tool round trip (${stream ? 'SSE' : 'JSON'}) waits for the client and resumes the original turn`, async (t) => {
    const { post, rpc } = await setup(t, { turns: ['tool'] });
    const firstHttp = await post({ input: 'read the note', tools, stream });
    const first = stream ? (await sseEvents(firstHttp)).at(-1).response : await jsonOk(firstHttp);
    const call = first.output.find((item) => item.type === 'function_call');
    assert.equal(call.name, 'read_local_note');
    assert.deepEqual(JSON.parse(call.arguments), {});
    assert.equal(rpc.responses.length, 0, 'The bridge must not execute or answer an external tool on its own.');
    assert.equal(rpc.pendingTools.size, 1);
    const pendingId = [...rpc.pendingTools.keys()][0];
    const localOutput = `local-only-${randomUUID()}`;
    const nextHttp = await post({
      previous_response_id: first.id, stream,
      input: [{ type: 'function_call_output', call_id: call.call_id, output: localOutput }],
    });
    const next = stream ? (await sseEvents(nextHttp)).at(-1).response : await jsonOk(nextHttp);
    assert.equal(next.status, 'completed');
    assert.equal(textOf(next), `local result: ${localOutput}`);
    assert.equal(rpc.responses.length, 1);
    assert.equal(rpc.responses[0].id, pendingId);
    assert.equal(calls(rpc, 'turn/start').length, 1, 'A tool result must answer the pending RPC instead of starting another turn.');
    assert.equal(calls(rpc, 'thread/start').length, 1);
    assert.equal(rpc.pendingTools.size, 0);
  });
}

test('invalid tool continuation does not consume the pending call or response ID', async (t) => {
  const { post, rpc } = await setup(t, { turns: ['tool'] });
  const first = await jsonOk(await post({ input: 'read', tools }));
  const call = first.output.find((item) => item.type === 'function_call');
  const valid = { previous_response_id: first.id, input: [{ type: 'function_call_output', call_id: call.call_id, output: 'client note' }] };
  const invalid = [
    { ...valid, input: [{ ...valid.input[0], call_id: 'not-the-pending-call' }] },
    { ...valid, previous_response_id: 'resp_unknown' },
    { ...valid, tools: [{ ...tools[0], description: 'changed contract' }] },
    { ...valid, unknown_field: true },
    { ...valid, tools: [{ type: 'custom', name: 'read_local_note' }] },
  ];
  for (const body of invalid) {
    await clientError(await post(body));
    assert.equal(rpc.responses.length, 0);
    assert.equal(rpc.pendingTools.size, 1);
  }
  const completed = await jsonOk(await post(valid));
  assert.equal(textOf(completed), 'local result: client note');
  assert.equal(rpc.responses.length, 1);
  await clientError(await post(valid));
  assert.equal(rpc.responses.length, 1, 'A stale response ID must not replay the tool result.');
  const continued = await jsonOk(await post({ previous_response_id: completed.id, input: 'continue' }));
  assert.equal(textOf(continued), 'fixture text 2');
});

test('rejects unsupported fields, custom tools, and compact before invoking a turn', async (t) => {
  const { post, rpc } = await setup(t);
  for (const body of [
    { input: 'hello', temperature: 0.5 },
    { input: 'hello', tools: [{ type: 'custom', name: 'apply_patch' }] },
    { input: 'hello', tools: [{ ...tools[0], strict: true }] },
  ]) await clientError(await post(body));
  const compact = await post({ model: 'test-model', input: [] }, { path: '/v1/responses/compact' });
  assert.ok([400, 501].includes(compact.status));
  assert.equal(typeof (await compact.json()).error?.message, 'string');
  assert.equal(calls(rpc, 'turn/start').length, 0);
  await jsonOk(await post({ input: 'valid request' }));
});

test('concurrent requests get 409 without starting an extra official turn', async (t) => {
  const { post, rpc } = await setup(t, { turns: ['hold'], requestTimeoutMs: 500 });
  const first = post({ input: 'hold this turn' });
  await waitForRequest(rpc, 'turn/start');
  const concurrent = await post({ input: 'another request' });
  assert.equal(concurrent.status, 409);
  await clientError(concurrent);
  assert.equal(calls(rpc, 'turn/start').length, 1);
  const failed = await first;
  assert.ok(failed.status >= 500);
  assert.equal(typeof (await failed.json()).error?.message, 'string');
});

test('oversized request returns 413 and does not start a model turn', async (t) => {
  const { post, rpc } = await setup(t, { bodyLimit: 256 });
  const response = await post({ input: 'x'.repeat(1024) });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'body_too_large');
  assert.equal(calls(rpc, 'turn/start').length, 0);
  await jsonOk(await post({ input: 'valid' }));
});

test('generation timeout returns an error and allows a later independent session', async (t) => {
  const { post, rpc } = await setup(t, { turns: ['hold', 'text'], requestTimeoutMs: 60 });
  const failed = await post({ input: 'wait forever' });
  assert.ok(failed.status >= 500);
  assert.equal(typeof (await failed.json()).error?.message, 'string');
  assert.ok(calls(rpc, 'turn/interrupt').length >= 1, 'A timed-out official turn must be interrupted.');
  assert.equal(textOf(await jsonOk(await post({ input: 'new session' }))), 'fixture text 2');
});

test('official process exit fails JSON and streaming requests explicitly', async (t) => {
  for (const stream of [false, true]) {
    await t.test(stream ? 'SSE failure event' : 'JSON error', async (t) => {
      const { post } = await setup(t, { turns: ['exit'] });
      const response = await post({ input: 'process exits', stream });
      if (stream) {
        const events = await sseEvents(response);
        assert.equal(events.at(-1).type, 'response.failed');
        assert.equal(events.at(-1).response.status, 'failed');
        assert.equal(typeof events.at(-1).response.error?.message, 'string');
        assert.equal(events.some((event) => event.type === 'response.completed'), false);
      } else {
        assert.ok(response.status >= 500);
        assert.equal(typeof (await response.json()).error?.message, 'string');
      }
    });
  }
});
