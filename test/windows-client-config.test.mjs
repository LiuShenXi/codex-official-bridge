import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const windows = { skip: process.platform !== 'win32' };
const sentinel = 'fixture-not-a-real-api-key';
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
function runPs(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true, ...options });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
const retained = '[mcp_servers.existing]\ncommand = "keep-me"\nargs = ["literal"]\n\n[otel]\nlog_user_prompt = false\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:9999/v1/logs" } }\n';

async function fixture(t, health = { ready: true, capabilities: { websocket: true, imageGeneration: true } }) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'bridge-client-fixture-')));
  const scripts = path.join(root, 'scripts'); const instance = path.join(root, '.runtime', 'windows-second');
  const home = path.join(instance, 'codex'); const requests = [];
  await mkdir(scripts, { recursive: true }); await mkdir(home, { recursive: true });
  for (const name of ['configure-windows-client.ps1', 'sync-windows-client-profile.ps1']) await copyFile(path.join(ROOT, 'scripts', name), path.join(scripts, name));
  await writeFile(path.join(scripts, 'desktop-image-mcp.mjs'), '// Fixture only: never executed.\n');
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url, validAuth: req.headers.authorization === `Bearer ${sentinel}` });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(health));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connection = { base_url: `http://127.0.0.1:${server.address().port}/v1`, api_key: sentinel, model: 'gpt-5.6-sol', model_reasoning_effort: 'low', retained_setting: { original: true } };
  const config = '# retained comment\nmodel = "gpt-6-astra"\nmodel_reasoning_effort = "ultra"\nmodel_provider = "official_bridge"\n\n[model_providers.official_bridge]\nname = "OpenAI"\nbase_url = "http://127.0.0.1:1/v1"\nexperimental_bearer_token = "old-fixture-value"\nsupports_websockets = false\n\n' + retained;
  const paths = { connection: path.join(home, 'connection.json'), config: path.join(home, 'config.toml'), auth: path.join(home, 'auth.json'), wrapper: path.join(instance, 'sync-profile.ps1') };
  await writeFile(paths.connection, JSON.stringify(connection)); await writeFile(paths.config, config);
  await writeFile(paths.auth, '{"fixture_original":true}\n'); await writeFile(paths.wrapper, '# old private fixture wrapper\n');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, file]) => [name, await readFile(file, 'utf8')])));
  const command = (name, extra = []) => runPs(['-File', path.join(scripts, name), '-InstanceRoot', instance, ...extra]);
  return { root, scripts, instance, home, paths, requests, connection, config, snapshot, command };
}

test('Windows integration scripts parse with Windows PowerShell 5.1', windows, async () => {
  for (const name of ['configure-windows-client.ps1', 'sync-windows-client-profile.ps1']) {
    const file = path.join(ROOT, 'scripts', name);
    const result = await runPs(['-Command', `$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(${psQuote(file)},[ref]$tokens,[ref]$errors); if($errors.Count){$errors | ForEach-Object {$_.Message}; exit 1}`]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
});

test('configure DryRun checks only local health and leaves every fake profile file unchanged', windows, async t => {
  const f = await fixture(t); const before = await f.snapshot();
  const result = await f.command('configure-windows-client.ps1', ['-DryRun']);
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout); assert.equal(plan.dry_run, true); assert.equal(plan.bridge_ready, true);
  assert.deepEqual(await f.snapshot(), before);
  assert.deepEqual(f.requests, [{ path: '/healthz', validAuth: true }]);
  assert.equal(result.stdout.includes(sentinel) || result.stderr.includes(sentinel), false);
  assert.equal((await readdir(f.instance)).includes('backups'), false);
});

test('missing deployed capability refuses configuration without modifying fake files', windows, async t => {
  const f = await fixture(t, { ready: true, capabilities: { websocket: true, imageGeneration: false } }); const before = await f.snapshot();
  const result = await f.command('configure-windows-client.ps1');
  assert.notEqual(result.code, 0); assert.match(result.stderr, /capabilities/);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(result.stdout.includes(sentinel) || result.stderr.includes(sentinel), false);
});

test('fake configure backs up all private files, preserves TOML and registers both capabilities', windows, async t => {
  const f = await fixture(t); const before = await f.snapshot();
  const result = await f.command('configure-windows-client.ps1');
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout); assert.equal(plan.configured, true); assert.equal(plan.restart_performed, false);
  const profile = JSON.parse(await readFile(f.paths.connection));
  assert.equal(profile.supports_websockets, true); assert.equal(profile.bridge_images, true);
  assert.deepEqual(profile.retained_setting, { original: true });
  const config = (await readFile(f.paths.config, 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(config.includes(retained));
  assert.match(config, /^model = "gpt-6-astra"$/m); assert.match(config, /^model_reasoning_effort = "ultra"$/m);
  assert.match(config, /^supports_websockets = true$/m); assert.match(config, /^\[mcp_servers\.bridge_images\]$/m);
  assert.match(config, /^tool_timeout_sec = 660$/m);
  const mcp = config.split('[mcp_servers.bridge_images]')[1];
  const args = JSON.parse(mcp.match(/^args = (.+)$/m)[1]);
  assert.equal(args[0], path.join(f.scripts, 'desktop-image-mcp.mjs'));
  assert.deepEqual(args.slice(1, 3), ['--profile', f.paths.connection]);
  assert.equal(args.filter(arg => arg === '--output-root').length, 3);
  assert.ok(args.includes('C:\\WORK-SPACE'));
  assert.equal(JSON.parse(await readFile(f.paths.auth)).OPENAI_API_KEY, sentinel);
  const wrapper = await readFile(f.paths.wrapper, 'utf8'); assert.ok(wrapper.includes('sync-windows-client-profile.ps1')); assert.equal(wrapper.includes(sentinel), false);
  for (const [name, original] of Object.entries(before)) {
    const filename = { connection: 'connection.json', config: 'config.toml', auth: 'auth.json', wrapper: 'sync-profile.ps1' }[name];
    assert.equal(await readFile(path.join(plan.backup_directory, filename), 'utf8'), original);
  }
  const again = await f.command('sync-windows-client-profile.ps1'); assert.equal(again.code, 0, again.stderr);
  assert.equal((await readFile(f.paths.config, 'utf8')).replaceAll('\r\n', '\n'), config);
  assert.equal(result.stdout.includes(sentinel) || result.stderr.includes(sentinel), false);
});

test('plain sync defaults WS to false, does not install images, clears only process base override', windows, async t => {
  const f = await fixture(t);
  const sync = path.join(f.scripts, 'sync-windows-client-profile.ps1');
  const result = await runPs(['-Command', `& ${psQuote(sync)} -InstanceRoot ${psQuote(f.instance)}; if($env:OPENAI_BASE_URL){throw 'process_base_not_cleared'}; if($env:OPENAI_API_KEY -ne ${psQuote(sentinel)}){throw 'process_key_not_generated'}; Write-Output 'verified'`], { env: { ...process.env, OPENAI_BASE_URL: 'http://fixture.invalid' } });
  assert.equal(result.code, 0, result.stderr);
  const config = await readFile(f.paths.config, 'utf8'); assert.match(config, /supports_websockets = false/); assert.doesNotMatch(config, /\[mcp_servers\.bridge_images\]/);
  assert.equal(result.stdout.trim(), 'verified'); assert.equal(f.requests.length, 0);
});

test('table-like text inside a multiline TOML string is retained and not treated as configuration', windows, async t => {
  const f = await fixture(t);
  const literal = 'custom_instructions = """\n[features]\nmodel = "embedded text only"\n"""\n';
  await writeFile(f.paths.config, literal + f.config);
  const result = await f.command('configure-windows-client.ps1');
  assert.equal(result.code, 0, result.stderr);
  const config = (await readFile(f.paths.config, 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(config.startsWith(literal)); assert.ok(config.includes('model = "gpt-6-astra"'));
});

test('configuration failure after capability update restores all four private files', windows, async t => {
  const f = await fixture(t);
  await writeFile(f.paths.config, f.config + '\n[mcp_servers.bridge_images]\nargs = [\n  "manual multiline managed value"\n]\nenabled = false\n');
  const before = await f.snapshot();
  const result = await f.command('configure-windows-client.ps1');
  assert.notEqual(result.code, 0); assert.match(result.stderr, /restored/);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(result.stdout.includes(sentinel) || result.stderr.includes(sentinel), false);
});

test('TOML array tables delimit root and managed sections and retain unrelated values', windows, async t => {
  const f = await fixture(t);
  const skills = '[[skills.config]]\npath = "fixture-skill"\nenabled = false\n';
  const unrelated = '[[other.config]]\nwire_api = "retain-this-array-value"\nname = "KeepArrayName"\n';
  await writeFile(f.paths.config, '# root retained\nunrelated_root = true\n' + skills + '[model_providers.official_bridge]\nname = "OpenAI"\n' + unrelated + retained);
  const result = await f.command('configure-windows-client.ps1');
  assert.equal(result.code, 0, result.stderr);
  const config = (await readFile(f.paths.config, 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(config.includes(skills)); assert.ok(config.includes(unrelated));
  assert.ok(config.indexOf('model = "gpt-5.6-sol"') < config.indexOf('[[skills.config]]'));
  assert.ok(config.indexOf('model_provider = "official_bridge"') < config.indexOf('[[skills.config]]'));
  const provider = config.split('[model_providers.official_bridge]')[1].split('[[other.config]]')[0];
  assert.match(provider, /^wire_api = "responses"$/m); assert.match(provider, /^supports_websockets = true$/m);
});
