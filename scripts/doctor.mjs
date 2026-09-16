import { createCodexRpc, runtimeOptions } from '../src/runtime.mjs';

const options = await runtimeOptions();
const rpc = createCodexRpc(options);
try {
  await rpc.start();
  const account = await rpc.request('account/read', { refreshToken: false });
  console.log(JSON.stringify({
    official_process_handshake: 'passed', codex_home: options.codexHome,
    signed_in: Boolean(account.account), auth_type: account.account?.type ?? null,
    plan: account.account?.planType ?? null,
    next: account.account ? 'Run npm start, then BRIDGE_MODEL=<available model> npm run demo.' : 'Run npm run login to sign this isolated instance in.',
  }, null, 2));
  if (!account.account) process.exitCode = 2;
} catch (error) {
  console.error(`Official Codex check failed (${error.code ?? 'unknown'}). Check BRIDGE_CODEX_BIN and the supported CLI version.`);
  process.exitCode = 1;
} finally { await rpc.close(); }
