import { CodexBridge } from './bridge.mjs';
import { createBridgeServer } from './server.mjs';
import { createCodexRpc, runtimeOptions } from './runtime.mjs';
import { NativeRuntime } from './native-runtime.mjs';

let bridge;
let server;
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const closing = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
  await bridge?.close();
  server?.closeAllConnections();
  await closing;
}

try {
  const options = await runtimeOptions();
  if (!options.apiKey || options.apiKey === 'replace-with-a-random-local-key') throw new Error('Set BRIDGE_API_KEY to a private random key.');
  if (options.mode === 'native') {
    bridge = new NativeRuntime(options);
    await bridge.start();
    server = createBridgeServer({ rawUpstream: bridge, apiKey: options.apiKey });
  } else {
    const rpc = createCodexRpc(options);
    bridge = new CodexBridge({ ...options, rpc });
    await rpc.start();
    server = createBridgeServer({ bridge, apiKey: options.apiKey });
  }
  server.on('error', error => { console.error(`HTTP listener failed: ${error.code ?? 'unknown'}`); process.exitCode = 1; void shutdown(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', resolve); });
  if (options.mode === 'native') {
    void bridge.exitPromise.then(() => {
      if (shuttingDown) return;
      console.error('Native runtime exited; stopping the gateway for its supervisor to restart.');
      process.exitCode = 1;
      void shutdown();
    });
  }
  console.log(`Codex Official Bridge: http://127.0.0.1:${options.port}/v1`);
  console.log(`Official Codex state: ${options.codexHome}`);
  console.log(`Mode: ${options.mode}; tools execute on the client. Run npm run doctor to check login.`);
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  await shutdown();
}
