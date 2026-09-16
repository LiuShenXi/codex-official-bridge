import http from 'node:http';
import path from 'node:path';
import { writeFile, rename } from 'node:fs/promises';

const controlFile = process.argv[process.argv.indexOf('--control-file') + 1];
if (!controlFile || !process.env.CODEX_HOME) process.exit(2);

// A real child process with a listening socket, but no model or account access.
const server = http.createServer((_request, response) => {
  response.writeHead(503, { 'content-type': 'application/json' });
  response.end('{"error":{"code":"fixture_has_no_model"}}');
});
server.listen(0, '127.0.0.1', async () => {
  await writeFile(path.join(process.env.CODEX_HOME, 'main-native-test-info.json'), JSON.stringify({
    pid: process.pid, port: server.address().port, controlFile,
  }), { mode: 0o600 });
  const temporaryControl = `${controlFile}.pending`;
  await writeFile(temporaryControl, JSON.stringify({
    port: server.address().port, token: 'main_native_lifecycle_fixture_token_1234567890',
  }), { mode: 0o600 });
  await rename(temporaryControl, controlFile);
});
