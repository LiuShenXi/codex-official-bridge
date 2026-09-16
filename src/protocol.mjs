import { randomUUID } from 'node:crypto';

export class BridgeError extends Error {
  constructor(status, code, message, param = null) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

/** Project official TurnError categories without exposing upstream diagnostic text. */
export function turnErrorToBridgeError(error) {
  const info = error?.codexErrorInfo;
  if (info === 'serverOverloaded') {
    return new BridgeError(503, 'upstream_overloaded', 'The upstream service is at capacity. Try again later.');
  }
  if (['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'].includes(info)) {
    return new BridgeError(429, 'upstream_usage_limit', 'The official account reached an upstream usage limit.');
  }
  return new BridgeError(502, 'codex_turn_failed', 'Official Codex did not complete this turn.');
}

export function errorBody(error) {
  const known = error instanceof BridgeError;
  return { error: {
    type: known && error.status < 500 ? 'invalid_request_error' : 'server_error',
    code: known ? error.code : 'bridge_error',
    message: known ? error.message : 'The Codex bridge failed. Check the local operator diagnostics.',
    param: known ? error.param : null,
  } };
}

function object(value, param) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError(400, 'invalid_request', `${param} must be an object.`, param);
  }
}

function keys(value, allowed, param) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new BridgeError(400, 'unsupported_field', `Unsupported field: ${param}${key}.`, `${param}${key}`);
  }
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validateRequest(body, defaultModel) {
  object(body, 'body');
  keys(body, ['model', 'input', 'instructions', 'tools', 'stream', 'previous_response_id', 'reasoning', 'store'], '');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new BridgeError(400, 'invalid_request', 'stream must be boolean.', 'stream');
  if (body.store !== undefined && body.store !== false) throw new BridgeError(400, 'unsupported_field', 'Durable storage is not supported; use store:false or omit store.', 'store');
  const previousId = body.previous_response_id;
  if (previousId !== undefined && (typeof previousId !== 'string' || !previousId)) throw new BridgeError(400, 'invalid_request', 'previous_response_id must be a nonempty string.', 'previous_response_id');
  const model = body.model ?? (previousId ? undefined : defaultModel);
  if ((!previousId && !model) || (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 128))) {
    throw new BridgeError(400, 'invalid_request', 'Provide a nonempty model, or configure BRIDGE_MODEL.', 'model');
  }
  if (body.instructions !== undefined && typeof body.instructions !== 'string') throw new BridgeError(400, 'invalid_request', 'instructions must be a string.', 'instructions');
  let effort;
  if (body.reasoning !== undefined) {
    object(body.reasoning, 'reasoning');
    keys(body.reasoning, ['effort'], 'reasoning.');
    effort = body.reasoning.effort;
    if (typeof effort !== 'string' || !effort || effort.length > 32) throw new BridgeError(400, 'invalid_request', 'reasoning.effort must be a nonempty string.', 'reasoning.effort');
  }
  let tools;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 32) throw new BridgeError(400, 'invalid_request', 'tools must be an array with at most 32 entries.', 'tools');
    const names = new Set();
    tools = body.tools.map((tool, i) => {
      const p = `tools[${i}].`;
      object(tool, p);
      keys(tool, ['type', 'name', 'description', 'parameters', 'strict'], p);
      if (tool.type !== 'function') throw new BridgeError(400, 'unsupported_tool', 'This prototype supports function tools only; custom/freeform/native tools are not silently converted.', `${p}type`);
      if (typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name)) throw new BridgeError(400, 'invalid_request', 'Tool names must be unique and contain 1–64 letters, numbers, underscores or hyphens.', `${p}name`);
      names.add(tool.name);
      if (tool.description !== undefined && typeof tool.description !== 'string') throw new BridgeError(400, 'invalid_request', 'Tool description must be a string.', `${p}description`);
      object(tool.parameters, `${p}parameters`);
      if (tool.parameters.type !== 'object') throw new BridgeError(400, 'invalid_request', 'Tool parameters must be an object JSON Schema.', `${p}parameters`);
      if (tool.strict !== undefined && typeof tool.strict !== 'boolean') throw new BridgeError(400, 'invalid_request', 'strict must be boolean.', `${p}strict`);
      // Official dynamic tools currently serialize strict:false and expose no strict toggle.
      if (tool.strict === true) throw new BridgeError(400, 'unsupported_field', 'strict:true cannot be preserved by app-server dynamic tools; use false or omit it.', `${p}strict`);
      return { type: 'function', name: tool.name, description: tool.description ?? '', parameters: tool.parameters, strict: false };
    });
  }

  let text;
  let toolOutput;
  if (typeof body.input === 'string') {
    text = body.input;
  } else if (Array.isArray(body.input) && body.input.length === 1) {
    const item = body.input[0];
    object(item, 'input[0]');
    if (item.type === 'function_call_output') {
      keys(item, ['type', 'call_id', 'output'], 'input[0].');
      if (!previousId || typeof item.call_id !== 'string' || !item.call_id || typeof item.output !== 'string') throw new BridgeError(400, 'invalid_tool_output', 'Tool output requires previous_response_id, call_id and a string output.', 'input');
      toolOutput = { callId: item.call_id, output: item.output };
    } else {
      keys(item, ['type', 'role', 'content'], 'input[0].');
      if ((item.type !== undefined && item.type !== 'message') || item.role !== 'user') throw new BridgeError(400, 'unsupported_input', 'Initial input supports one user text message; use previous_response_id for history.', 'input');
      if (typeof item.content === 'string') text = item.content;
      else if (Array.isArray(item.content) && item.content.length === 1) {
        const part = item.content[0];
        object(part, 'input[0].content[0]');
        keys(part, ['type', 'text'], 'input[0].content[0].');
        if (part.type !== 'input_text' || typeof part.text !== 'string') throw new BridgeError(400, 'unsupported_input', 'Only input_text is supported in this prototype.', 'input');
        text = part.text;
      }
    }
  }
  if (!toolOutput && (typeof text !== 'string' || !text.trim())) throw new BridgeError(400, 'unsupported_input', 'input must be nonempty text, one user text message, or one tool output.', 'input');
  return { model, text, toolOutput, tools, instructions: body.instructions, effort, previousId, stream: body.stream ?? false };
}

export function dynamicTools(tools) {
  // Prefix names to avoid collisions with Codex built-in namespaces; reverse-map every call.
  return tools.map((tool, i) => ({ type: 'function', name: `bridge_fn_${i}`, description: `${tool.name}: ${tool.description}`, inputSchema: tool.parameters }));
}

/** One HTTP response segment, which may finish while an official turn waits for a tool. */
export class ResponseSegment {
  constructor(model, previousId, onEvent = () => {}) {
    this.onEvent = onEvent;
    this.sequence = 0;
    this.messages = new Map();
    this.doneItems = new Set();
    this.finished = false;
    this.response = {
      id: `resp_bridge_${randomUUID()}`, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'in_progress', model, previous_response_id: previousId ?? null,
      output: [], usage: null, error: null, incomplete_details: null,
    };
  }

  emit(type, fields = {}) { this.onEvent({ type, sequence_number: this.sequence++, ...structuredClone(fields) }); }
  start() { this.emit('response.created', { response: this.response }); this.emit('response.in_progress', { response: this.response }); }

  message(itemId, phase) {
    if (this.messages.has(itemId)) return this.messages.get(itemId);
    const item = { id: `msg_bridge_${randomUUID()}`, type: 'message', status: 'in_progress', role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }], ...(phase ? { phase } : {}) };
    const index = this.response.output.push(item) - 1;
    const entry = { item, index };
    this.messages.set(itemId, entry);
    this.emit('response.output_item.added', { output_index: index, item: { ...item, content: [] } });
    this.emit('response.content_part.added', { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] });
    return entry;
  }

  textDelta(itemId, delta) {
    if (this.finished || !delta) return;
    const { item, index } = this.message(itemId);
    if (this.doneItems.has(item.id)) throw new BridgeError(502, 'invalid_upstream_event', 'Received text after a completed output item.');
    item.content[0].text += delta;
    this.emit('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta });
  }

  completeMessage(raw) {
    if (this.finished) return;
    const { item, index } = this.message(raw.id, raw.phase);
    if (this.doneItems.has(item.id)) return;
    const current = item.content[0].text;
    if (!raw.text.startsWith(current)) throw new BridgeError(502, 'invalid_upstream_event', 'Completed message differs from its streamed text.');
    this.textDelta(raw.id, raw.text.slice(current.length));
    if (raw.phase) item.phase = raw.phase;
    this.finishMessage(item, index);
  }

  finishMessage(item, index) {
    if (this.doneItems.has(item.id)) return;
    this.doneItems.add(item.id);
    item.status = 'completed';
    this.emit('response.output_text.done', { item_id: item.id, output_index: index, content_index: 0, text: item.content[0].text });
    this.emit('response.content_part.done', { item_id: item.id, output_index: index, content_index: 0, part: item.content[0] });
    this.emit('response.output_item.done', { output_index: index, item });
  }

  toolCall(callId, name, args) {
    const item = { id: `fc_bridge_${randomUUID()}`, type: 'function_call', status: 'in_progress', call_id: callId, name, arguments: '' };
    const index = this.response.output.push(item) - 1;
    this.emit('response.output_item.added', { output_index: index, item });
    item.arguments = JSON.stringify(args);
    this.emit('response.function_call_arguments.delta', { item_id: item.id, output_index: index, delta: item.arguments });
    this.emit('response.function_call_arguments.done', { item_id: item.id, output_index: index, arguments: item.arguments });
    item.status = 'completed';
    this.emit('response.output_item.done', { output_index: index, item });
  }

  finish(usage = null) {
    if (this.finished) return this.response;
    for (const { item, index } of this.messages.values()) this.finishMessage(item, index);
    this.finished = true;
    this.response.status = 'completed';
    this.response.usage = usage;
    this.emit('response.completed', { response: this.response });
    return this.response;
  }

  fail(error) {
    if (this.finished) return;
    this.finished = true;
    this.response.status = 'failed';
    this.response.error = errorBody(error).error;
    this.emit('response.failed', { response: this.response });
  }
}
