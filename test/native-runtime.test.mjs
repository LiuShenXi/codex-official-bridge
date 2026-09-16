import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeRuntime } from '../src/native-runtime.mjs';

async function setup(t, mode = 'ready') {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-runtime-test-'));
  const runtime = new NativeRuntime({ nativeCommand: process.execPath, nativeArgs: [fileURLToPath(new URL('./fixtures/native-child.mjs', import.meta.url)), mode], codexHome: directory, cwd: directory, runtimeDir: directory, startupTimeoutMs: 1000, env: { ...process.env, BRIDGE_API_KEY: 'must-not-leak', OPENAI_API_KEY: 'must-not-leak', CODEX_THREAD_ID: 'parent-thread' } });
  t.after(async () => { await runtime.close(); await rm(directory, { recursive: true, force: true }); });
  return { runtime, directory };
}

test('private runtime startup strips gateway/parent credentials and closes its child', async t => {
  const { runtime, directory } = await setup(t);
  await runtime.start();
  assert.equal(runtime.status().ready, true);
  const result = await (await fetch(`http://127.0.0.1:${runtime.port}`)).json();
  assert.equal(result.sensitiveEnvironmentPresent, false);
  assert.equal(result.codexHome, directory);
  await runtime.close();
  assert.equal(runtime.closed, true);
  assert.equal(runtime.token, undefined);
  assert.deepEqual(await readdir(directory), []);
});

for (const mode of ['exit', 'stall', 'public']) {
  test(`runtime startup fails closed for ${mode}`, async t => {
    const { runtime, directory } = await setup(t, mode);
    await assert.rejects(runtime.start());
    assert.equal(runtime.closed, true);
    assert.deepEqual(await readdir(directory), []);
  });
}

test('exit during the readiness file read cannot publish a ready runtime', async () => {
  // Keep the builtin fs interception confined to a separate Node process so
  // other runtime and HTTP tests cannot observe the injected scheduling point.
  const fixture = fileURLToPath(new URL('./fixtures/native-exit-during-read.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [fixture], { timeout: 5000, maxBuffer: 64 * 1024 });
  assert.deepEqual(JSON.parse(stdout), {
    read_intercepted: true, exited_before_read_returned: true, ready: false,
    token_cleared: true, control_directory_removed: true,
  });
});
