#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_RESPONSES = 8;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function options() {
  let model = process.env.BRIDGE_MODEL;
  let stream = false;
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === '--help') {
      console.log('Usage: BRIDGE_API_KEY=... BRIDGE_MODEL=... npm run demo -- [--stream] [--model MODEL]');
      console.log('BRIDGE_URL defaults to http://127.0.0.1:8789/v1. This demo reads one temporary local file.');
      return null;
    }
    if (argument === '--stream') stream = true;
    else if (argument === '--model') {
      model = process.argv[++index];
      if (!model || model.startsWith('--')) throw new Error('--model requires a model name');
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  const apiKey = process.env.BRIDGE_API_KEY;
  if (!apiKey?.trim()) throw new Error('Set BRIDGE_API_KEY to the bridge access key.');
  if (!model?.trim()) throw new Error('Set BRIDGE_MODEL or pass --model MODEL.');
  const base = process.env.BRIDGE_URL || 'http://127.0.0.1:8789/v1';
  const endpoint = new URL(`${base.replace(/\/+$/, '')}/responses`);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('BRIDGE_URL must be an HTTP(S) base URL without credentials, query, or fragment.');
  }
  return { apiKey, model: model.trim(), stream, endpoint };
}

function errorMessage(value) {
  return value?.error?.message || value?.response?.error?.message || value?.message || 'Unknown bridge error';
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Bridge returned an empty HTTP body.');
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Bridge response exceeded the demo size limit.');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); }
    catch { throw new Error(`Bridge returned invalid JSON (HTTP ${response.status}).`); }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readSse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Bridge returned an empty SSE body.');
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  let eventName = '';
  let dataLines = [];
  let completed;

  function dispatch() {
    const data = dataLines.join('\n');
    const namedType = eventName;
    eventName = '';
    dataLines = [];
    if (!data || data === '[DONE]') return;
    let event;
    try { event = JSON.parse(data); }
    catch { throw new Error('Bridge returned invalid SSE JSON.'); }
    const type = event.type || namedType;
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
      throw new Error(`${type}: ${errorMessage(event)}`);
    }
    if (type === 'response.completed') {
      if (!event.response) throw new Error('response.completed is missing its response object.');
      completed = event.response;
    }
  }

  function line(value) {
    if (value === '') return dispatch();
    if (value.startsWith(':')) return;
    const separator = value.indexOf(':');
    const field = separator < 0 ? value : value.slice(0, separator);
    let content = separator < 0 ? '' : value.slice(separator + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') eventName = content;
    if (field === 'data') dataLines.push(content);
  }

  function drain(atEnd = false) {
    // Accept LF, CRLF and CR, including a CRLF split across network chunks.
    while (buffer.length) {
      const separator = buffer.search(/[\r\n]/);
      if (separator < 0) break;
      if (!atEnd && buffer[separator] === '\r' && separator === buffer.length - 1) break;
      const width = buffer[separator] === '\r' && buffer[separator + 1] === '\n' ? 2 : 1;
      line(buffer.slice(0, separator));
      buffer = buffer.slice(separator + width);
    }
    if (atEnd) {
      if (buffer) line(buffer);
      buffer = '';
      dispatch();
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Bridge SSE exceeded the demo size limit.');
      buffer += decoder.decode(value, { stream: true });
      drain();
    }
    buffer += decoder.decode();
    drain(true);
    if (!completed) throw new Error('SSE ended without response.completed.');
    return completed;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function request(config, body) {
  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      accept: config.stream ? 'text/event-stream' : 'application/json',
    },
    body: JSON.stringify({ ...body, model: config.model, stream: config.stream }),
    signal: AbortSignal.timeout(180_000),
    redirect: 'error',
  });
  if (!response.ok) {
    const body = await readJson(response);
    throw new Error(`HTTP ${response.status}: ${errorMessage(body)}`);
  }
  if (config.stream && !response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    throw new Error('Streaming request did not return text/event-stream.');
  }
  const result = config.stream ? await readSse(response) : await readJson(response);
  if (result.error || result.status === 'failed' || result.status === 'incomplete') {
    throw new Error(errorMessage(result));
  }
  if (typeof result.id !== 'string' || !result.id || !Array.isArray(result.output)) {
    throw new Error('Bridge returned an invalid Responses object.');
  }
  return result;
}

async function run() {
  const config = options();
  if (!config) return;
  const directory = await mkdtemp(join(tmpdir(), 'codex-bridge-demo-'));
  const notePath = join(directory, 'note.txt');
  const nonce = randomBytes(16).toString('hex');
  try {
    await writeFile(notePath, `Local file verification nonce: ${nonce}\nThis file was created and read by the local demo process.\n`, { mode: 0o600 });
    console.log(`Local note: ${notePath}`);
    console.log(`Transport: ${config.stream ? 'typed SSE' : 'JSON'}`);
    let body = {
      input: '请调用 read_local_note 读取本地便签，然后根据工具结果回答。请在最终回答中逐字包含便签中的 verification nonce，以证明使用了工具结果。不要猜测内容，也不要调用其他工具。',
      tools: [{
        type: 'function',
        name: 'read_local_note',
        description: 'Read a temporary note from the client machine. Returns its complete text, including a verification nonce.',
        parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
        strict: false,
      }],
    };
    let executed = false;
    for (let index = 0; index < MAX_RESPONSES; index += 1) {
      const response = await request(config, body);
      const calls = response.output.filter((item) => item.type === 'function_call');
      const text = response.output
        .filter((item) => item.type === 'message')
        .flatMap((item) => item.content || [])
        .filter((part) => part.type === 'output_text')
        .map((part) => part.text)
        .join('\n');
      if (text) console.log(`\nModel output:\n${text}`);
      if (!calls.length) {
        if (!executed) throw new Error('The model finished without calling the local tool.');
        if (!text.includes(nonce)) throw new Error('The final answer did not contain the nonce from the local file.');
        console.log('\nPASS: local tool execution, previous_response_id continuation, and nonce verification.');
        return;
      }
      const input = [];
      for (const call of calls) {
        if (call.name !== 'read_local_note') throw new Error(`Refusing unknown local tool: ${call.name}`);
        if (typeof call.call_id !== 'string' || !call.call_id) throw new Error('Tool call is missing call_id.');
        let args;
        try { args = JSON.parse(call.arguments); }
        catch { throw new Error('read_local_note arguments must be a JSON object.'); }
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== 0) {
          throw new Error('read_local_note accepts only an empty argument object.');
        }
        const output = await readFile(notePath, 'utf8');
        executed = true;
        console.log(`Executing read_local_note locally: ${notePath}`);
        input.push({ type: 'function_call_output', call_id: call.call_id, output });
      }
      body = { previous_response_id: response.id, input };
    }
    throw new Error(`Stopped after ${MAX_RESPONSES} responses without a verified final answer.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(`Demo failed: ${error.message}`);
  process.exitCode = 1;
});
