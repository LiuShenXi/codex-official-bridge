#!/usr/bin/env node
// Project-owned MCP image client. Credentials are read only from the selected
// connection.json; OAuth stays on the bridge server. Never log request bodies.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, realpath, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PROFILE = path.join(ROOT, '.runtime', 'windows-second', 'codex', 'connection.json');

class ToolError extends Error {
  constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new ToolError(code, message, details); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isInside = (root, target) => { const rel = path.relative(root, target); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };

export async function loadConnection(profilePath) {
  let profile;
  try { profile = JSON.parse((await readFile(profilePath, 'utf8')).replace(/^\uFEFF/, '')); }
  catch { fail('profile_unavailable', 'The selected connection.json could not be read.'); }
  if (!isRecord(profile) || typeof profile.base_url !== 'string' || typeof profile.api_key !== 'string' || !profile.api_key.trim() || /[\r\n]/.test(profile.api_key)) fail('profile_invalid', 'The selected connection.json requires base_url and api_key.');
  let base;
  try { base = new URL(profile.base_url); }
  catch { fail('profile_invalid', 'The connection base_url is invalid.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (!['http:', 'https:'].includes(base.protocol) || (base.protocol === 'http:' && !loopback) || base.username || base.password || base.search || base.hash || !/^\/v1\/?$/.test(base.pathname)) fail('profile_invalid', 'Use a bridge /v1 endpoint over HTTPS or local loopback HTTP.');
  return { endpoint: new URL('/v1/images/generations', base), health: new URL('/healthz', base), apiKey: profile.api_key };
}

async function limitedBody(response, limit) {
  const chunks = []; let bytes = 0;
  if (!response.body) fail('empty_response', 'The image endpoint returned no response body.');
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) fail('response_too_large', 'The image response exceeded the configured limit.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function inspectPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buffer.toString('ascii', 12, 16) !== 'IHDR' || buffer.readUInt32BE(8) !== 13) fail('invalid_image', 'The endpoint did not return a valid PNG image.');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width > 32768 || height > 32768 || width * height > 100_000_000) fail('invalid_image', 'The returned PNG dimensions are invalid.');
  let offset = 8, data = false, end = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (length > buffer.length - offset - 12) fail('invalid_image', 'The returned PNG is incomplete.');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') data = true;
    if (type === 'IEND') { end = length === 0 && offset + 12 === buffer.length; break; }
    offset += 12 + length;
  }
  if (!data || !end) fail('invalid_image', 'The returned PNG is incomplete.');
  return { width, height, mime_type: 'image/png' };
}

function base64Png(value) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('invalid_image', 'The endpoint returned invalid image data.');
  const image = Buffer.from(value, 'base64');
  if (image.toString('base64') !== value) fail('invalid_image', 'The endpoint returned invalid image data.');
  inspectPng(image);
  return image;
}

// Endpoint payload/response parsing is deliberately confined here. It accepts
// embedded PNG bytes only: no URLs, redirects, or second credentialed downloads.
export function decodeImageResponse(buffer, contentType = 'application/json') {
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) fail('unsupported_response', 'The image endpoint must return JSON containing embedded PNG data.');
  let body;
  try { body = JSON.parse(buffer.toString('utf8')); }
  catch { fail('invalid_response', 'The image endpoint returned invalid JSON.'); }
  if (!Array.isArray(body?.data) || body.data.length !== 1) fail('invalid_response', 'Expected exactly one image in the response.');
  return base64Png(body.data[0]?.b64_json);
}

async function reserveOutput(outputPath, roots) {
  if (!path.isAbsolute(outputPath) || path.extname(outputPath).toLowerCase() !== '.png' || /[\x00-\x1f]/.test(outputPath)) fail('invalid_output_path', 'Use an absolute .png path within a configured output root.');
  const target = path.resolve(outputPath);
  const matching = roots.find(root => isInside(root, target));
  if (!matching) fail('output_outside_root', 'The output path is outside the configured output roots.');
  // Resolve the closest existing ancestor before creating directories, then
  // resolve again so junctions/symlinks cannot redirect writes outside a root.
  const allowed = await realpath(matching).catch(() => fail('output_root_unavailable', 'The configured output root does not exist.'));
  const parent = path.dirname(target);
  let ancestor = parent;
  while (true) {
    try { const resolved = await realpath(ancestor); if (!isInside(allowed, resolved)) fail('output_outside_root', 'The output directory resolves outside its configured root.'); break; }
    catch (error) { if (error instanceof ToolError) throw error; if (error.code !== 'ENOENT') fail('invalid_output_path', 'The output directory is unavailable.'); const next = path.dirname(ancestor); if (next === ancestor) fail('invalid_output_path', 'The output directory is unavailable.'); ancestor = next; }
  }
  await mkdir(parent, { recursive: true });
  const resolvedParent = await realpath(parent);
  if (!isInside(allowed, resolvedParent)) fail('output_outside_root', 'The output directory resolves outside its configured root.');
  const resolvedTarget = path.join(resolvedParent, path.basename(target));
  let handle;
  try { handle = await open(resolvedTarget, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') fail('output_exists', 'The output file already exists. Choose a new filename.'); fail('output_unwritable', 'The output file could not be created.'); }
  return { path: resolvedTarget, handle };
}

export const IMAGE_TOOLS = [
  { name: 'get_status', description: 'Read this project image bridge configuration and check bridge health. Does not generate images or return credentials. Health alone does not prove image generation is authorized.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  { name: 'generate_image', description: 'Generate one PNG through this project official bridge and save it locally. Use for an authorized image request, including when native image_gen is unavailable. Do not switch provider or request API fallback confirmation. Return the saved image with a Markdown absolute-path image link. Never auto-retry an uncertain generation. This is a project MCP tool, not the native image_gen tool.', inputSchema: { type: 'object', properties: { prompt: { type: 'string', minLength: 1, maxLength: 32000, description: 'Complete image description.' }, output_path: { type: 'string', description: 'Absolute new .png file path within a configured output root. Omit for an automatically generated filename.' } }, required: ['prompt'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
];

export function createImageService({ profilePath = DEFAULT_PROFILE, outputRoots = [path.join(ROOT, '.runtime', 'generated-images')], fetchImpl = globalThis.fetch, timeoutMs = 600_000 } = {}) {
  const roots = outputRoots.map(root => path.resolve(root));
  const defaultRoot = roots[0];
  if (!defaultRoot) throw new Error('At least one output root is required.');
  return {
    async getStatus({ signal } = {}) {
      const connection = await loadConnection(profilePath);
      let status;
      try { const response = await fetchImpl(connection.health, { headers: { Authorization: `Bearer ${connection.apiKey}` }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) }); status = response.status; await response.body?.cancel(); }
      catch { return { configured: true, bridge_reachable: false, image_generation_verified: false, native_image_gen: false }; }
      return { configured: true, bridge_reachable: status === 200, bridge_http_status: status, image_generation_verified: false, native_image_gen: false, endpoint: connection.endpoint.href, output_roots: roots };
    },
    async generate(args, { signal } = {}) {
      if (!isRecord(args) || Object.keys(args).some(key => !['prompt', 'output_path'].includes(key)) || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32000 || (args.output_path !== undefined && typeof args.output_path !== 'string')) fail('invalid_arguments', 'Supply a nonempty prompt of at most 32000 characters and an optional absolute output_path.');
      const connection = await loadConnection(profilePath);
      if (args.output_path === undefined) await mkdir(defaultRoot, { recursive: true });
      const reservation = await reserveOutput(args.output_path ?? path.join(defaultRoot, `${randomUUID()}.png`), roots);
      let saved = false;
      try {
        let response;
        // Same generation fields observed in official Desktop requests. The
        // Codex backend does not need public-API-only n/response_format fields.
        try { response = await fetchImpl(connection.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ prompt: args.prompt, background: 'auto', model: 'gpt-image-2', quality: 'auto', size: 'auto' }), redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) }); }
        catch { fail('image_request_interrupted', 'The image request did not finish. Completion may be uncertain; do not automatically retry.'); }
        if (!response.ok) { await response.body?.cancel(); fail('image_request_failed', 'The bridge rejected the image request.', { http_status: response.status }); }
        let body;
        try { body = await limitedBody(response, MAX_RESPONSE_BYTES); }
        catch (error) {
          if (error instanceof ToolError) throw error;
          fail('completion_uncertain', 'The bridge accepted the image request, but the response stream was interrupted. Generation may have completed; do not automatically retry.', { completion_uncertain: true, retry_safe: false });
        }
        const buffer = decodeImageResponse(body, response.headers.get('content-type') ?? '');
        const info = inspectPng(buffer);
        await reservation.handle.writeFile(buffer);
        await reservation.handle.sync();
        saved = true;
        return { path: reservation.path, ...info, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), model_requested: 'gpt-image-2', native_image_gen: false };
      } finally {
        await reservation.handle.close();
        if (!saved) await unlink(reservation.path).catch(() => {});
      }
    },
  };
}

const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const safeToolError = error => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(error instanceof ToolError ? { error: error.code, message: error.message, ...error.details } : { error: 'image_tool_failed', message: 'The image tool could not finish. No credentials or remote error body are included.' }) }] });

export function serveStdio(service, { input = process.stdin, output = process.stdout } = {}) {
  const active = new Map(); let initialized = false, pending = Buffer.alloc(0);
  const send = value => output.write(`${JSON.stringify(value)}\n`);
  const error = (id, code, message) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  async function handle(message) {
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(message?.id, -32600, 'Invalid request');
    const id = message.id;
    if (id === undefined) {
      if (message.method === 'notifications/cancelled') active.get(message.params?.requestId)?.abort();
      return;
    }
    if (typeof id !== 'string' && typeof id !== 'number') return error(null, -32600, 'Invalid request id');
    if (message.method === 'initialize') {
      initialized = true;
      const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'codex-official-bridge-images', version: '0.2.0' }, instructions: 'For user-requested images, call generate_image directly using this project bridge. Do not change providers or ask the user to select an API fallback. Calls may take several minutes. No automatic retries.' } });
    }
    if (message.method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (!initialized) return error(id, -32002, 'Server not initialized');
    if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: IMAGE_TOOLS } });
    if (message.method !== 'tools/call') return error(id, -32601, 'Method not found');
    if (active.has(id)) return error(id, -32600, 'Request id is already active');
    const controller = new AbortController(); active.set(id, controller);
    try {
      const args = message.params?.arguments ?? {};
      let result;
      if (message.params?.name === 'get_status') { if (!isRecord(args) || Object.keys(args).length) fail('invalid_arguments', 'get_status accepts no arguments.'); result = await service.getStatus({ signal: controller.signal }); }
      else if (message.params?.name === 'generate_image') result = await service.generate(args, { signal: controller.signal });
      else fail('unknown_tool', 'The requested tool is not available.');
      send({ jsonrpc: '2.0', id, result: toolResult(result) });
    } catch (cause) { send({ jsonrpc: '2.0', id, result: safeToolError(cause) }); }
    finally { active.delete(id); }
  }
  input.on('data', chunk => {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
      if (!line.length) continue;
      if (line.length > MAX_INPUT_BYTES) { error(null, -32600, 'Request exceeds input limit'); continue; }
      let message;
      try { message = JSON.parse(line.toString('utf8')); }
      catch { error(null, -32700, 'Parse error'); continue; }
      void handle(message).catch(() => error(message?.id, -32603, 'Internal error'));
    }
    if (pending.length > MAX_INPUT_BYTES) { pending = Buffer.alloc(0); error(null, -32600, 'Request exceeds input limit'); input.destroy(); }
  });
  input.on('end', () => { for (const controller of active.values()) controller.abort(); });
  return () => { for (const controller of active.values()) controller.abort(); };
}

export function parseOptions(argv) {
  const options = { outputRoots: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!['--profile', '--output-root'].includes(flag) || !value || !path.isAbsolute(value)) throw new Error('Expected --profile PATH and optional --output-root PATH arguments.');
    if (flag === '--profile') options.profilePath = value;
    else options.outputRoots.push(value);
  }
  if (!options.outputRoots.length) delete options.outputRoots;
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try { const service = createImageService(parseOptions(process.argv.slice(2))); serveStdio(service); }
  catch { process.stderr.write('Image MCP configuration is invalid. Use absolute profile/output-root paths.\n'); process.exitCode = 1; }
}
