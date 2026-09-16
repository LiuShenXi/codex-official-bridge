import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const mainPath = fileURLToPath(new URL('../src/main.mjs', import.meta.url));
const fixtureUrl = new URL('./fixtures/main-native-child.mjs', import.meta.url).href;

async function unusedPort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  return port;
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function connectionResult(port) {
  return bounded(new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', error => { socket.destroy(); resolve(error.code); });
  }), 1000, 'Port closure check timed out.');
}

async function startMain(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-main-native-test-'));
  const home = path.join(directory, 'home');
  const codexHome = path.join(directory, 'codex-home');
  await Promise.all([home, codexHome].map(value => mkdir(value, { mode: 0o700 })));
  const wrapper = path.join(directory, 'fixture-runtime.mjs');
  await writeFile(wrapper, `#!/usr/bin/env node\nawait import(${JSON.stringify(fixtureUrl)});\n`, { mode: 0o700 });
  const port = await unusedPort();
  const child = spawn(process.execPath, [mainPath], {
    cwd: directory,
    env: {
      PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
      HOME: home, TMPDIR: directory,
      BRIDGE_MODE: 'native', BRIDGE_NATIVE_BIN: wrapper,
      BRIDGE_CODEX_HOME: codexHome, BRIDGE_PORT: String(port),
      BRIDGE_API_KEY: 'main-native-test-only-key', BRIDGE_NATIVE_STARTUP_TIMEOUT_MS: '2000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', error => resolve({ spawnError: error.code }));
  });
  let runtime;
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (runtime?.pid) {
      try { process.kill(runtime.pid, 'SIGKILL'); } catch { /* Already stopped. */ }
    }
    await bounded(exited, 2000, 'Main process failed to stop during test cleanup.');
    // NativeRuntime normally removes this directory; clean it on failed tests too.
    if (runtime?.controlFile) await rm(path.dirname(runtime.controlFile), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });

  await bounded(new Promise((resolve, reject) => {
    const readyLine = `Codex Official Bridge: http://127.0.0.1:${port}/v1`;
    const onData = () => {
      if (stdout.includes(readyLine)) { child.stdout.off('data', onData); resolve(); }
    };
    child.stdout.on('data', onData);
    onData();
    exited.then(result => {
      if (!stdout.includes(readyLine)) reject(new Error(`Main exited before listening: ${JSON.stringify(result)}`));
    });
  }), 4000, 'Main did not start its HTTP listener.');
  runtime = JSON.parse(await readFile(path.join(codexHome, 'main-native-test-info.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { authorization: 'Bearer main-native-test-only-key' }, signal: AbortSignal.timeout(1000),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ready, true);
  return { child, exited, runtime, port, diagnostics: () => ({ stdout, stderr }) };
}

test('native child death makes the actual main process exit 1 and close its listener', { skip: process.platform === 'win32' ? 'The serving runtime requires Unix private-file permissions; release checks execute this on Linux.' : false }, async t => {
  const { exited, runtime, port, diagnostics } = await startMain(t);
  process.kill(runtime.pid, 'SIGKILL');
  const result = await bounded(exited, 3000, 'Main stayed alive after its native runtime died.');
  assert.deepEqual(result, { code: 1, signal: null });
  assert.match(diagnostics().stderr, /Native runtime exited; stopping the gateway/);
  assert.equal(await connectionResult(port), 'ECONNREFUSED');
  assert.equal(await connectionResult(runtime.port), 'ECONNREFUSED');
  await assert.rejects(access(path.dirname(runtime.controlFile)), { code: 'ENOENT' });
});

test('operator shutdown keeps exit 0 when the native child exits during normal cleanup', { skip: process.platform === 'win32' ? 'The serving runtime requires Unix private-file permissions; release checks execute this on Linux.' : false }, async t => {
  const { child, exited, runtime, port, diagnostics } = await startMain(t);
  child.kill('SIGTERM');
  const result = await bounded(exited, 3000, 'Main did not finish its requested shutdown.');
  assert.deepEqual(result, { code: 0, signal: null });
  assert.doesNotMatch(diagnostics().stderr, /Native runtime exited; stopping the gateway/);
  assert.equal(await connectionResult(port), 'ECONNREFUSED');
  assert.equal(await connectionResult(runtime.port), 'ECONNREFUSED');
});
