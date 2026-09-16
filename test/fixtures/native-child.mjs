import http from 'node:http';
import { writeFile } from 'node:fs/promises';
const file = process.argv[process.argv.indexOf('--control-file') + 1];
const mode = process.argv[2];
if (mode === 'exit') process.exit(1);
if (mode === 'stall') setInterval(() => {}, 1000);
else {
  const server = http.createServer((_req, res) => res.end(JSON.stringify({ sensitiveEnvironmentPresent: ['BRIDGE_API_KEY', 'OPENAI_API_KEY', 'CODEX_THREAD_ID'].some(key => process.env[key] !== undefined), codexHome: process.env.CODEX_HOME })));
  server.listen(0, '127.0.0.1', async () => {
    await writeFile(file, JSON.stringify({ port: server.address().port, token: 'x'.repeat(64) }), { mode: mode === 'public' ? 0o644 : 0o600 });
  });
}
