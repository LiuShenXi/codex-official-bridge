import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const originalReadFile = fs.readFile;
let runtime;
let readIntercepted = false;
let exitedBeforeReadReturned = false;
const directory = await fs.mkdtemp(path.join(tmpdir(), 'native-ready-exit-fixture-'));

try {
  fs.readFile = async (file, ...args) => {
    const bytes = await originalReadFile(file, ...args);
    if (String(file).endsWith('/ready.json')) {
      readIntercepted = true;
      // The runtime has valid readiness bytes, but its child exits before the
      // awaited read resolves. No timing assumptions or production hooks needed.
      const exited = once(runtime.child, 'exit');
      runtime.child.kill('SIGTERM');
      await exited;
      exitedBeforeReadReturned = true;
    }
    return bytes;
  };
  syncBuiltinESMExports();
  const { NativeRuntime } = await import('../../src/native-runtime.mjs');
  runtime = new NativeRuntime({
    nativeCommand: process.execPath,
    nativeArgs: [fileURLToPath(new URL('./native-child.mjs', import.meta.url)), 'ready'],
    codexHome: directory, cwd: directory, runtimeDir: directory, startupTimeoutMs: 1000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  await assert.rejects(runtime.start(), /exited before becoming ready/);
  assert.equal(readIntercepted, true);
  assert.equal(exitedBeforeReadReturned, true);
  assert.equal(runtime.status().ready, false);
  assert.equal(runtime.token, undefined);
  assert.deepEqual(await fs.readdir(directory), []);
  console.log(JSON.stringify({
    read_intercepted: readIntercepted,
    exited_before_read_returned: exitedBeforeReadReturned,
    ready: runtime.status().ready,
    token_cleared: runtime.token === undefined,
    control_directory_removed: (await fs.readdir(directory)).length === 0,
  }));
} finally {
  fs.readFile = originalReadFile;
  syncBuiltinESMExports();
  await runtime?.close();
  await fs.rm(directory, { recursive: true, force: true });
}
