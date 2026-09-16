import { randomUUID } from 'node:crypto';
import { BridgeError, ResponseSegment, canonical, dynamicTools, turnErrorToBridgeError, validateRequest } from './protocol.mjs';

const CONTROL_INSTRUCTIONS = 'The registered bridge_fn_* functions run on the client computer. Use these functions for client operations. Do not execute commands, read files, or use other tools on this server. Wait for function results; never invent them.';
const BLOCKED_ITEMS = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageGeneration', 'collabAgentToolCall', 'dynamicToolCallError']);

export class CodexBridge {
  constructor({ rpc, cwd, defaultModel, requestTimeoutMs = 120_000, sessionTtlMs = 300_000, threadConfig = {} }) {
    this.rpc = rpc;
    this.cwd = cwd;
    this.defaultModel = defaultModel;
    this.requestTimeoutMs = requestTimeoutMs;
    this.sessionTtlMs = sessionTtlMs;
    this.threadConfig = threadConfig;
    this.session = null;
    this.operation = null;
    this.busy = false;
    this.closed = false;
    this.rpc.on('notification', event => this.onNotification(event));
    this.rpc.on('serverRequest', event => this.onServerRequest(event));
    this.rpc.on('exit', () => {
      this.closed = true;
      this.fail(new BridgeError(503, 'codex_unavailable', 'Official Codex app-server exited; restart the bridge.'));
    });
  }

  status() {
    return { backend: 'official-codex-app-server', state: this.closed ? 'unavailable' : this.busy ? 'generating' : this.session?.waiting ? 'waiting_for_tool' : this.session ? 'idle' : 'ready', durable_sessions: false };
  }

  async respond(body, { onEvent, signal } = {}) {
    const req = validateRequest(body, this.defaultModel);
    if (this.closed) throw new BridgeError(503, 'codex_unavailable', 'Official Codex app-server is unavailable; restart the bridge.');
    if (this.busy) throw new BridgeError(409, 'bridge_busy', 'This prototype accepts one HTTP generation at a time.');
    if (signal?.aborted) throw new BridgeError(499, 'client_disconnected', 'The client disconnected.');
    this.checkContinuation(req);
    this.busy = true;
    clearTimeout(this.sessionTimer);

    let segment;
    let abort;
    let timer;
    try {
      if (!req.previousId) {
        await this.releaseSession();
        this.session = {
          model: req.model, tools: req.tools ?? [], instructions: req.instructions ?? '', effort: req.effort,
          threadId: null, turnId: null, lastResponseId: null, pending: [], waiting: null,
          buffered: [], seenCalls: new Set(), lastError: null,
        };
      }
      const session = this.session;
      segment = new ResponseSegment(session.model, req.previousId, onEvent);
      const result = new Promise((resolve, reject) => { this.operation = { segment, resolve, reject, settled: false }; });
      // A cancellation can reject while the initial thread/start RPC is still pending.
      result.catch(() => {});
      abort = () => this.fail(new BridgeError(499, 'client_disconnected', 'The client disconnected; the server turn was cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => this.fail(new BridgeError(504, 'generation_timeout', 'The generation timed out; its session cannot be resumed.')), this.requestTimeoutMs);
      try { segment.start(); } catch (error) { this.fail(error); }
      if (signal?.aborted) abort();
      else if (!this.operation.settled) {
        const operation = this.operation;
        // Await the response independently of startup RPCs so timeout/disconnect always wins.
        this.drive(req, session, operation).catch(error => {
          if (this.operation !== operation || operation.settled) return;
          this.fail(error instanceof BridgeError ? error : new BridgeError(502, 'codex_rpc_error', 'Official Codex rejected an operation. Run npm run doctor and verify the installed CLI version.'));
        });
      }
      return await result;
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener('abort', abort);
      this.busy = false;
      this.operation = null;
      if (this.session) {
        this.sessionTimer = setTimeout(() => { this.releaseSession().catch(() => {}); }, this.sessionTtlMs);
        this.sessionTimer.unref();
      }
    }
  }

  async drive(req, session, operation) {
    await this.rpc.start();
    if (this.session !== session) return;
    if (!session.threadId) {
      const started = await this.rpc.request('thread/start', {
        model: session.model, modelProvider: 'openai', allowProviderModelFallback: false,
        cwd: this.cwd, environments: [], ephemeral: true,
        approvalPolicy: 'never', sandbox: 'read-only', personality: 'none',
        baseInstructions: session.instructions || 'Assist the user with their request.',
        developerInstructions: CONTROL_INSTRUCTIONS,
        dynamicTools: dynamicTools(session.tools), config: this.threadConfig,
      });
      if (this.session !== session) {
        if (started.thread?.id) await this.rpc.request('thread/unsubscribe', { threadId: started.thread.id }).catch(() => {});
        return;
      }
      if (!started.thread?.id) throw new BridgeError(502, 'invalid_upstream_event', 'Codex returned no thread ID.');
      session.threadId = started.thread.id;
      if (started.model && started.model !== session.model) throw new BridgeError(502, 'model_mismatch', 'Codex selected a different model; fallback is not accepted.');
    }
    if (req.toolOutput) {
      const call = session.waiting;
      session.waiting = null;
      this.rpc.respond(call.rpcId, { contentItems: [{ type: 'inputText', text: req.toolOutput.output }], success: true });
      for (const event of session.buffered.splice(0)) this.consumeNotification(event);
      this.flushTool();
    } else {
      const started = await this.rpc.request('turn/start', {
        threadId: session.threadId, input: [{ type: 'text', text: req.text }],
        environments: [], ...(session.effort ? { effort: session.effort } : {}),
      });
      if (this.session !== session) {
        // turn/start can succeed after cancellation; retire that late turn explicitly.
        if (started.turn?.id) await this.rpc.request('turn/interrupt', { threadId: session.threadId, turnId: started.turn.id }).catch(() => {});
        return;
      }
      if (this.operation === operation && !operation.segment.finished) {
        if (!started.turn?.id) throw new BridgeError(502, 'invalid_upstream_event', 'Codex returned no turn ID.');
        session.turnId ??= started.turn.id;
      }
    }
  }

  checkContinuation(req) {
    const s = this.session;
    if (!req.previousId) {
      if (s?.turnId || s?.waiting || s?.pending.length) throw new BridgeError(409, 'session_busy', 'An existing session is waiting for its tool result. Resume it or let it expire.');
      return;
    }
    if (!s || s.lastResponseId !== req.previousId) throw new BridgeError(409, 'invalid_previous_response_id', 'Only the latest response in the current in-memory session can be continued.', 'previous_response_id');
    if (s.lastError) throw s.lastError;
    for (const [key, expected] of [['model', s.model], ['instructions', s.instructions], ['effort', s.effort]]) {
      if (req[key] !== undefined && req[key] !== expected) throw new BridgeError(409, 'session_config_changed', `${key} cannot change within a session.`, key);
    }
    if (req.tools !== undefined && canonical(req.tools) !== canonical(s.tools)) throw new BridgeError(409, 'session_config_changed', 'Tools cannot change within a session.', 'tools');
    if (req.toolOutput) {
      if (!s.waiting || s.waiting.clientCallId !== req.toolOutput.callId) throw new BridgeError(409, 'invalid_call_id', 'Tool result does not match the outstanding function call.', 'input');
    } else if (s.waiting || s.turnId || s.pending.length) {
      throw new BridgeError(409, 'tool_result_required', 'Submit the outstanding function_call_output before another user message.', 'input');
    }
  }

  onServerRequest(event) {
    try { this.consumeServerRequest(event); }
    catch (error) { this.fail(error instanceof BridgeError ? error : new BridgeError(502, 'invalid_upstream_event', 'Malformed Codex tool request.')); }
  }

  consumeServerRequest(event) {
    const s = this.session;
    if (event.method !== 'item/tool/call' || !s || event.params?.threadId !== s.threadId) {
      this.rpc.respondError(event.id, { code: -32601, message: 'This bridge permits registered client function calls only.' });
      if (s && event.params?.threadId === s.threadId) this.fail(new BridgeError(502, 'unsupported_server_action', 'Codex requested a server-side action not supported by this bridge.'));
      return;
    }
    const p = event.params;
    const index = /^bridge_fn_(\d+)$/.exec(p.tool ?? '')?.[1];
    const tool = index === undefined ? undefined : s.tools[Number(index)];
    if (!tool || p.namespace || typeof p.turnId !== 'string' || typeof p.callId !== 'string' || !p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments) || s.seenCalls.has(p.callId) || (s.turnId && s.turnId !== p.turnId)) {
      this.rpc.respondError(event.id, { code: -32602, message: 'Unknown or malformed client function call.' });
      this.fail(new BridgeError(502, 'invalid_tool_call', 'Codex requested an unknown or malformed client tool.'));
      return;
    }
    s.turnId ??= p.turnId;
    s.seenCalls.add(p.callId);
    s.pending.push({ rpcId: event.id, clientCallId: `call_bridge_${randomUUID()}`, name: tool.name, args: p.arguments });
    this.flushTool();
  }

  flushTool() {
    const s = this.session;
    const op = this.operation;
    if (!s || !op || op.segment.finished || s.waiting || !s.pending.length) return;
    s.waiting = s.pending.shift();
    op.segment.toolCall(s.waiting.clientCallId, s.waiting.name, s.waiting.args);
    // HTTP segments do not correspond one-to-one with official inference requests.
    // Leave usage unknown until per-segment accounting has a verified mapping.
    this.complete(null);
  }

  onNotification(event) {
    const s = this.session;
    if (!s || event.params?.threadId !== s.threadId) return;
    try {
      if (event.method === 'turn/started') {
        s.turnId = event.params.turn.id;
        return;
      }
      if (event.method === 'thread/tokenUsage/updated') return;
      if (event.method === 'error') {
        if (event.params.willRetry) return;
        this.fail(turnErrorToBridgeError(event.params.error));
        return;
      }
      if (event.params.turnId && s.turnId && event.params.turnId !== s.turnId) return;
      if (BLOCKED_ITEMS.has(event.params.item?.type)) {
        this.fail(new BridgeError(502, 'unsupported_server_action', 'Codex attempted an unsupported server-side tool.'));
        return;
      }
      if (!['item/agentMessage/delta', 'item/completed', 'turn/completed'].includes(event.method)) return;
      if (!this.operation || this.operation.segment.finished) {
        s.buffered.push(event);
        if (s.buffered.length > 4096) this.fail(new BridgeError(502, 'upstream_buffer_limit', 'Too many events arrived while waiting for a client tool.'));
        return;
      }
      this.consumeNotification(event);
    } catch (error) {
      this.fail(error instanceof BridgeError ? error : new BridgeError(502, 'invalid_upstream_event', 'Malformed Codex event.'));
    }
  }

  consumeNotification({ method, params: p }) {
    const s = this.session;
    const op = this.operation;
    if (!s || !op || op.segment.finished) return;
    switch (method) {
      case 'item/agentMessage/delta':
        if (typeof p.delta !== 'string' || typeof p.itemId !== 'string') throw new BridgeError(502, 'invalid_upstream_event', 'Malformed text event.');
        op.segment.textDelta(p.itemId, p.delta);
        break;
      case 'item/completed':
        if (p.item?.type === 'agentMessage') op.segment.completeMessage(p.item);
        break;
      case 'turn/completed':
        if (s.turnId && p.turn.id !== s.turnId) return;
        if (p.turn.status !== 'completed') {
          throw turnErrorToBridgeError(p.turn.error);
        }
        if (s.pending.length || s.waiting) throw new BridgeError(502, 'invalid_upstream_event', 'Codex completed with an unanswered client tool.');
        s.turnId = null;
        this.complete(null);
        break;
    }
  }

  complete(usage) {
    const op = this.operation;
    if (!op || op.settled) return;
    const response = op.segment.finish(usage);
    this.session.lastResponseId = response.id;
    op.settled = true;
    op.resolve(response);
  }

  fail(error) {
    const op = this.operation;
    if (op && !op.settled) {
      try { op.segment.fail(error); } catch { /* A disconnected transport cannot accept another event. */ }
      op.settled = true;
      op.reject(error);
    }
    this.releaseSession().catch(() => {});
  }

  async releaseSession() {
    clearTimeout(this.sessionTimer);
    const s = this.session;
    this.session = null;
    if (!s) return;
    for (const call of [s.waiting, ...s.pending].filter(Boolean)) {
      try { this.rpc.respond(call.rpcId, { contentItems: [{ type: 'inputText', text: 'Client tool cancelled; do not retry.' }], success: false }); } catch { /* Child may have exited. */ }
    }
    if (s.threadId && s.turnId) {
      await this.rpc.request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId }, { timeoutMs: 3000 }).catch(() => {});
    }
    if (s.threadId) await this.rpc.request('thread/unsubscribe', { threadId: s.threadId }, { timeoutMs: 3000 }).catch(() => {});
  }

  async close() {
    if (this.operation && !this.operation.settled) this.fail(new BridgeError(503, 'bridge_shutdown', 'The bridge is shutting down.'));
    this.closed = true;
    await this.releaseSession();
    await this.rpc.close();
  }
}
