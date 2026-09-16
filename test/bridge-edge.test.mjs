import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridge } from '../src/bridge.mjs';
import { BridgeError } from '../src/protocol.mjs';
import { FakeRpc } from './fixtures/fake-rpc.mjs';

const tools = ['read_first_note', 'read_second_note'].map(name => ({
  type: 'function', name, description: 'Read a client-side note.',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
}));
const textOf = response => response.output.flatMap(item => item.content ?? []).map(part => part.text ?? '').join('');
const calls = (rpc, method) => rpc.requests.filter(request => request.method === method);

function setup(t, rpc = new FakeRpc(), options = {}) {
  const bridge = new CodexBridge({ rpc, cwd: '/tmp/bridge-edge-fixture', defaultModel: 'test-model', requestTimeoutMs: 1000, ...options });
  t.after(() => bridge.close());
  return { rpc, bridge };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function deadline(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 1000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function eventMatching(emitter, name, predicate) {
  return new Promise(resolve => {
    const listener = event => {
      if (!predicate(event)) return;
      emitter.off(name, listener);
      resolve(event);
    };
    emitter.on(name, listener);
  });
}

function toolRequest(rpc, turn, index) {
  const request = {
    id: rpc.nextServerId++, method: 'item/tool/call',
    params: { threadId: turn.threadId, turnId: turn.id, callId: `upstream-${index}`, tool: `bridge_fn_${index}`, namespace: null, arguments: {} },
  };
  rpc.pendingTools.set(request.id, { request, turn });
  return request;
}

test('completion delivery failure settles the operation and allows a fresh request', async t => {
  const { bridge } = setup(t);
  await assert.rejects(deadline(bridge.respond({ input: 'first' }, {
    onEvent(event) {
      if (event.type === 'response.completed') throw new BridgeError(499, 'client_disconnected', 'Fixture completion write failure.');
    },
  }), 'completion delivery failure'), { code: 'client_disconnected' });
  const next = await deadline(bridge.respond({ input: 'recover' }), 'request after completion delivery failure');
  assert.equal(textOf(next), 'fixture text 2');
});

test('tool delivery failure rejects the operation without escaping the RPC event listener', async t => {
  const { rpc, bridge } = setup(t, new FakeRpc({ turns: ['hold', 'text'] }));
  const started = eventMatching(rpc, 'notification', event => event.method === 'turn/started');
  const rejected = assert.rejects(deadline(bridge.respond({ input: 'read', tools }, {
    onEvent(event) {
      if (event.type === 'response.function_call_arguments.delta') throw new BridgeError(502, 'slow_consumer', 'Fixture tool write failure.');
    },
  }), 'tool delivery failure'), { code: 'slow_consumer' });
  const event = await deadline(started, 'initial tool turn');
  const turn = rpc.activeTurns.get(event.params.turn.id);
  const request = toolRequest(rpc, turn, 0);
  assert.doesNotThrow(() => rpc.emit('serverRequest', request));
  await rejected;
  assert.equal(rpc.responses.find(response => response.id === request.id)?.result.success, false);
  assert.equal(textOf(await deadline(bridge.respond({ input: 'recover' }), 'request after tool delivery failure')), 'fixture text 2');
});

class DelayedTurnAckRpc extends FakeRpc {
  constructor() {
    super();
    this.turnRequested = deferred();
    this.ack = deferred();
    this.delayed = false;
  }

  async request(method, params) {
    if (method !== 'turn/start' || this.delayed) return super.request(method, params);
    this.delayed = true;
    this.requests.push({ method, params: structuredClone(params) });
    this.emit('request', { method, params });
    const turn = { id: `turn-${++this.turnCount}`, threadId: params.threadId, interrupted: false };
    this.activeTurns.set(turn.id, turn);
    this.turnRequested.resolve(turn);
    await this.ack.promise;
    return { turn: { id: turn.id, status: 'inProgress' } };
  }
}

test('pending turn startup does not delay cancellation and its late acknowledgement is interrupted', async t => {
  for (const reason of ['timeout', 'abort']) {
    await t.test(reason, async t => {
      const rpc = new DelayedTurnAckRpc();
      const { bridge } = setup(t, rpc, { requestTimeoutMs: reason === 'timeout' ? 40 : 5000 });
      const controller = new AbortController();
      const rejected = assert.rejects(deadline(bridge.respond({ input: 'delayed startup' }, { signal: controller.signal }), `${reason} before turn acknowledgement`), {
        code: reason === 'timeout' ? 'generation_timeout' : 'client_disconnected',
      });
      const oldTurn = await deadline(rpc.turnRequested.promise, 'pending turn/start');
      if (reason === 'abort') controller.abort();
      await rejected; // The acknowledgement is deliberately still unresolved.
      assert.equal(textOf(await deadline(bridge.respond({ input: 'new independent request' }), 'new request while old acknowledgement is pending')), 'fixture text 2');
      const interrupted = eventMatching(rpc, 'request', request => request.method === 'turn/interrupt' && request.params.turnId === oldTurn.id);
      rpc.ack.resolve();
      const cleanup = await deadline(interrupted, 'late turn interruption');
      assert.equal(cleanup.params.threadId, oldTurn.threadId);
      assert.equal(calls(rpc, 'turn/interrupt').every(request => request.params.turnId === oldTurn.id), true);
    });
  }
});

class ParallelToolRpc extends FakeRpc {
  respond(id, result) {
    const pending = this.pendingTools.get(id);
    assert.ok(pending, 'Only an unanswered original RPC may be completed.');
    this.responses.push({ id, result: structuredClone(result) });
    this.pendingTools.delete(id);
    if (!this.pendingTools.size) setImmediate(() => this.finishText(pending.turn, 'Both client notes received.'));
  }
}

test('parallel upstream tool calls survive successive response segments without restarting the turn', async t => {
  const { rpc, bridge } = setup(t, new ParallelToolRpc({ turns: ['hold'] }));
  const started = eventMatching(rpc, 'notification', event => event.method === 'turn/started');
  const firstResponse = bridge.respond({ input: 'read both notes', tools });
  const event = await deadline(started, 'parallel tool turn');
  const turn = rpc.activeTurns.get(event.params.turn.id);
  const requests = [toolRequest(rpc, turn, 0), toolRequest(rpc, turn, 1)];
  for (const request of requests) rpc.emit('serverRequest', request);
  const first = await deadline(firstResponse, 'first queued tool');
  const firstCall = first.output.find(item => item.type === 'function_call');
  assert.equal(firstCall.name, tools[0].name);
  assert.equal(rpc.responses.length, 0);

  const second = await deadline(bridge.respond({
    previous_response_id: first.id,
    input: [{ type: 'function_call_output', call_id: firstCall.call_id, output: 'first local note' }],
  }), 'second queued tool');
  const secondCall = second.output.find(item => item.type === 'function_call');
  assert.equal(secondCall.name, tools[1].name);
  assert.notEqual(secondCall.call_id, firstCall.call_id);
  assert.deepEqual(rpc.responses.map(response => response.id), [requests[0].id]);
  assert.equal(rpc.pendingTools.size, 1);

  const final = await deadline(bridge.respond({
    previous_response_id: second.id,
    input: [{ type: 'function_call_output', call_id: secondCall.call_id, output: 'second local note' }],
  }), 'final answer after both tools');
  assert.equal(textOf(final), 'Both client notes received.');
  assert.deepEqual(rpc.responses.map(response => response.id), requests.map(request => request.id));
  assert.deepEqual(rpc.responses.map(response => response.result.contentItems[0].text), ['first local note', 'second local note']);
  assert.equal(calls(rpc, 'thread/start').length, 1);
  assert.equal(calls(rpc, 'turn/start').length, 1);
  assert.equal(rpc.pendingTools.size, 0);
});
