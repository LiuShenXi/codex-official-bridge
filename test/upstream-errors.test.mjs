import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexBridge } from '../src/bridge.mjs';
import { FakeRpc } from './fixtures/fake-rpc.mjs';

const PRIVATE_DETAIL = 'private-upstream-diagnostic-that-must-not-be-forwarded';

class UpstreamErrorRpc extends FakeRpc {
  constructor({ info, mode }) {
    super({ turns: ['hold'] });
    this.info = info;
    this.mode = mode;
  }

  async request(method, params) {
    const result = await super.request(method, params);
    if (method !== 'turn/start') return result;
    setImmediate(() => {
      const threadId = params.threadId;
      const turnId = result.turn.id;
      const error = { message: PRIVATE_DETAIL, additionalDetails: PRIVATE_DETAIL, codexErrorInfo: this.info };
      if (this.mode === 'retry') {
        this.notify('error', { threadId, turnId, error, willRetry: true });
        setImmediate(() => this.finishText(this.activeTurns.get(turnId), 'Recovered after retry.'));
        return;
      }
      if (this.mode === 'error-first') {
        this.notify('error', { threadId, turnId, error, willRetry: false });
        // A later generic completion must not erase the first classified error.
        error.codexErrorInfo = 'other';
      }
      this.notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error } });
    });
    return result;
  }
}

async function runTurn(t, options) {
  const rpc = new UpstreamErrorRpc(options);
  const bridge = new CodexBridge({ rpc, cwd: '/tmp', defaultModel: 'test-model', requestTimeoutMs: 1000 });
  t.after(() => bridge.close());
  const events = [];
  const response = bridge.respond({ input: 'Test error handling.' }, { onEvent: event => events.push(event) });
  return { rpc, bridge, events, response };
}

const cases = [
  { info: 'serverOverloaded', status: 503, code: 'upstream_overloaded' },
  { info: 'usageLimitExceeded', status: 429, code: 'upstream_usage_limit' },
  { info: 'rateLimitExceeded', status: 429, code: 'upstream_usage_limit' },
  { info: 'sessionBudgetExceeded', status: 429, code: 'upstream_usage_limit' },
  { info: 'other', status: 502, code: 'codex_turn_failed' },
  { info: { responseStreamDisconnected: { httpStatusCode: 503 } }, status: 502, code: 'codex_turn_failed' },
];

for (const mode of ['error-first', 'completion-only']) {
  for (const { info, status, code } of cases) {
    test(`${mode} preserves ${typeof info === 'string' ? info : 'unclassified structured error'} without leaking diagnostics`, async (t) => {
      const { bridge, events, response } = await runTurn(t, { info, mode });
      await assert.rejects(response, error => {
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        assert.doesNotMatch(error.message, /private-upstream/);
        return true;
      });
      const failures = events.filter(event => event.type === 'response.failed');
      assert.equal(failures.length, 1);
      assert.equal(failures[0].response.error.code, code);
      assert.equal(events.some(event => event.type === 'response.completed'), false);
      assert.equal(JSON.stringify(events).includes(PRIVATE_DETAIL), false);
      assert.equal(bridge.status().state, 'ready');
    });
  }
}

test('willRetry errors keep the turn alive until successful text completion', async (t) => {
  const { rpc, events, response } = await runTurn(t, { info: 'serverOverloaded', mode: 'retry' });
  const result = await response;
  assert.equal(result.status, 'completed');
  assert.equal(result.output[0].content[0].text, 'Recovered after retry.');
  assert.equal(events.some(event => event.type === 'response.failed'), false);
  assert.equal(events.filter(event => event.type === 'response.completed').length, 1);
  assert.equal(rpc.requests.filter(request => request.method === 'turn/start').length, 1);
  assert.equal(rpc.requests.some(request => request.method === 'turn/interrupt'), false);
  assert.equal(JSON.stringify(events).includes(PRIVATE_DETAIL), false);
});
