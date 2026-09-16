import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, realpath } from 'node:fs/promises';
import { CodexRpc } from './rpc.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ISOLATED_CONFIG = {
  web_search: 'disabled',
  'tools.update_plan.enabled': false,
  'tools.experimental_request_user_input.enabled': false,
  'skills.include_instructions': false,
  'skills.bundled.enabled': false,
  'orchestrator.skills.enabled': false,
  'features.skip_host_skill_discovery': true,
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.shell_snapshot': false,
  'features.apps': false,
  'features.plugins': false,
  'features.hooks': false,
  'features.multi_agent': false,
  'features.browser_use': false,
  'features.browser_use_external': false,
  'features.computer_use': false,
  'features.view_image': false,
  'features.image_generation': false,
  'features.code_mode': false,
  'features.code_mode_host': false,
  'features.skill_search': false,
  'features.skill_mcp_dependency_install': false,
  'features.workspace_dependencies': false,
  'features.goals': false,
  'features.sleep_tool': false,
};

function integer(value, fallback, name, min, max) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return n;
}

export async function runtimeOptions(env = process.env) {
  const runtimeDir = path.join(PROJECT_ROOT, '.runtime');
  const codexHome = path.resolve(env.BRIDGE_CODEX_HOME ?? path.join(runtimeDir, 'codex-home'));
  const cwd = path.join(runtimeDir, 'empty-workspace');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const mode = env.BRIDGE_MODE ?? 'native';
  if (!['native', 'legacy'].includes(mode)) throw new Error('BRIDGE_MODE must be native or legacy.');
  return {
    mode,
    nativeCommand: env.BRIDGE_NATIVE_BIN ?? path.join(runtimeDir, 'bin', 'codex-official-runtime'),
    startupTimeoutMs: integer(env.BRIDGE_NATIVE_STARTUP_TIMEOUT_MS, 120_000, 'BRIDGE_NATIVE_STARTUP_TIMEOUT_MS', 1000, 600_000),
    apiKey: env.BRIDGE_API_KEY,
    port: integer(env.BRIDGE_PORT, 8789, 'BRIDGE_PORT', 1, 65535),
    command: env.BRIDGE_CODEX_BIN ?? 'codex', codexHome: await realpath(codexHome), cwd: await realpath(cwd),
    defaultModel: env.BRIDGE_MODEL,
    requestTimeoutMs: integer(env.BRIDGE_REQUEST_TIMEOUT_MS, 120_000, 'BRIDGE_REQUEST_TIMEOUT_MS', 1000, 600_000),
    sessionTtlMs: integer(env.BRIDGE_SESSION_TTL_MS, 300_000, 'BRIDGE_SESSION_TTL_MS', 1000, 3_600_000),
  };
}

export function configArguments(config) {
  return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]);
}

export function codexEnvironment(codexHome, source = process.env) {
  // Inherit normal networking/proxy settings, but never pass the bridge key or parent Codex session IDs.
  const env = { ...source, CODEX_HOME: codexHome };
  for (const key of Object.keys(env)) {
    if (key.startsWith('BRIDGE_') || (key.startsWith('CODEX_') && !['CODEX_HOME', 'CODEX_CA_CERTIFICATE'].includes(key))) delete env[key];
  }
  // Subscription authentication is owned by the child CLI; do not accidentally select another provider.
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'CHATGPT_BASE_URL', 'CODEX_API_BASE_URL']) delete env[key];
  return env;
}

export function createCodexRpc(options, { extraConfig = {}, env = process.env } = {}) {
  return new CodexRpc({
    command: options.command,
    args: ['app-server', '--listen', 'stdio://', '--strict-config', ...configArguments({ ...ISOLATED_CONFIG, ...extraConfig })],
    cwd: options.cwd, env: codexEnvironment(options.codexHome, env), requestTimeoutMs: 20_000,
  });
}
