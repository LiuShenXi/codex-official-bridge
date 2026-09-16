import { EventEmitter } from 'node:events';

/** Stateful app-server boundary fixture. It never calls an external service. */
export class FakeRpc extends EventEmitter {
  constructor({ turns = ['text'] } = {}) {
    super();
    this.turns = [...turns];
    this.requests = [];
    this.responses = [];
    this.responseErrors = [];
    this.pendingTools = new Map();
    this.activeTurns = new Map();
    this.started = false;
    this.closed = false;
    this.threadCount = 0;
    this.turnCount = 0;
    this.nextServerId = 100;
  }

  async start() {
    if (this.closed) throw new Error('Fixture RPC is closed.');
    this.started = true;
    return this;
  }

  async request(method, params) {
    if (this.closed) throw new Error('Fixture RPC is closed.');
    this.requests.push({ method, params: structuredClone(params) });
    this.emit('request', { method, params });
    if (method === 'thread/start') {
      return { thread: { id: `thr-${++this.threadCount}` }, model: params.model };
    }
    if (method === 'turn/start') {
      const count = ++this.turnCount;
      const action = this.turns.shift() ?? 'text';
      const turn = { id: `turn-${count}`, threadId: params.threadId, interrupted: false };
      this.activeTurns.set(turn.id, turn);
      setImmediate(() => {
        if (this.closed || turn.interrupted) return;
        this.notify('turn/started', { threadId: turn.threadId, turn: { id: turn.id, status: 'inProgress' } });
        if (action === 'hold') return;
        if (action === 'exit') {
          this.crash();
          return;
        }
        if (action === 'tool') {
          const request = {
            id: this.nextServerId++,
            method: 'item/tool/call',
            params: {
              threadId: turn.threadId, turnId: turn.id, callId: `up_call_${count}`,
              tool: 'bridge_fn_0', arguments: {}, namespace: null,
            },
          };
          this.pendingTools.set(request.id, { request, turn });
          this.emit('serverRequest', request);
          return;
        }
        this.finishText(turn, typeof action === 'object' ? action.text : `fixture text ${count}`);
      });
      return { turn: { id: turn.id, status: 'inProgress' } };
    }
    if (method === 'turn/interrupt') {
      const turn = this.activeTurns.get(params.turnId);
      if (turn) turn.interrupted = true;
      return {};
    }
    if (method === 'thread/unsubscribe' || method === 'thread/archive') return {};
    throw new Error(`Unexpected fixture RPC method: ${method}`);
  }

  notify(method, params) {
    if (!this.closed) this.emit('notification', { method, params });
  }

  finishText(turn, text) {
    if (this.closed || turn.interrupted) return;
    const itemId = `message-${turn.id}`;
    const prefix = { threadId: turn.threadId, turnId: turn.id, itemId };
    const boundary = Math.max(1, Math.floor(text.length / 2));
    this.notify('item/agentMessage/delta', { ...prefix, delta: text.slice(0, boundary) });
    this.notify('item/agentMessage/delta', { ...prefix, delta: text.slice(boundary) });
    this.notify('item/completed', {
      threadId: turn.threadId, turnId: turn.id,
      item: { id: itemId, type: 'agentMessage', text, phase: 'final_answer' },
    });
    this.notify('turn/completed', {
      threadId: turn.threadId,
      turn: { id: turn.id, status: 'completed', error: null },
    });
    this.activeTurns.delete(turn.id);
  }

  respond(id, result) {
    if (this.closed) throw new Error('Fixture RPC is closed.');
    const pending = this.pendingTools.get(id);
    if (!pending) throw new Error(`Unknown fixture server request id: ${id}`);
    this.responses.push({ id, result: structuredClone(result) });
    this.pendingTools.delete(id);
    const text = result.contentItems?.map((item) => item.text ?? '').join('') ?? '';
    setImmediate(() => this.finishText(pending.turn, `local result: ${text}`));
  }

  respondError(id, error) {
    this.responseErrors.push({ id, error: structuredClone(error) });
    this.pendingTools.delete(id);
  }

  crash() {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.emit('exit', Object.assign(new Error('Fixture app-server exited.'), { code: 'RPC_PROCESS_EXIT' }));
  }

  async close() {
    this.closed = true;
    this.started = false;
    this.pendingTools.clear();
    this.activeTurns.clear();
  }
}
