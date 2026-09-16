import { createInterface } from 'node:readline';

const mode = process.argv[2];
const lines = createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\r\n`);
let initialized = false;
let serverPending;

if (mode === 'ignore-term') process.on('SIGTERM', () => {});

lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    if (mode === 'hang-init') return;
    // Separate chunks inside a UTF-8 character to test byte-safe JSONL buffering.
    const response = Buffer.from(`${JSON.stringify({ id: request.id, result: { label: '官方' } })}\r\n`);
    const split = response.indexOf(Buffer.from('官')) + 1;
    process.stdout.write(response.subarray(0, split));
    setTimeout(() => process.stdout.write(response.subarray(split)), 5);
    return;
  }
  if (request.method === 'initialized') {
    initialized = true;
    return;
  }
  if (request.id === 'tool-1' && !request.method) {
    send({ id: serverPending, result: { toolResponse: request } });
    serverPending = undefined;
    return;
  }
  if (!initialized) throw new Error('Request arrived before initialized notification');
  switch (request.method) {
    case 'environment-presence':
      send({ id: request.id, result: Object.fromEntries(request.params.keys.map(key => [key, Object.hasOwn(process.env, key)])) });
      break;
    case 'echo':
      send({ id: request.id, result: request.params });
      break;
    case 'delayed':
      setTimeout(() => send({ id: request.id, result: request.params.value }), request.params.delay);
      break;
    case 'notify':
      send({ method: 'fixture/notification', params: request.params });
      break;
    case 'tool':
      serverPending = request.id;
      send({ method: 'fixture/notification', params: { text: '工具即将调用' } });
      send({ id: 'tool-1', method: 'item/tool/call', params: { name: 'local_tool', arguments: { a: 1 } } });
      break;
    case 'error':
      send({ id: request.id, error: { code: -32001, message: 'Fixture failure', data: { retry: false } } });
      break;
    case 'never':
      break;
    case 'exit':
      process.stderr.write('sensitive-token-do-not-show\n');
      process.exit(23);
      break;
    case 'malformed':
      process.stdout.write('NOT_JSON\n');
      break;
    case 'invalid-envelope':
      send({ id: request.id, result: 'ok', error: { code: 1, message: 'bad' } });
      break;
    case 'oversized':
      process.stdout.write('x'.repeat(request.params.bytes));
      break;
    default:
      throw new Error(`Unexpected fixture method: ${request.method}`);
  }
});

// The ignore-term mode also ignores stdin EOF until forcibly killed.
lines.on('close', () => {
  if (mode === 'ignore-term') setInterval(() => {}, 1000);
});
