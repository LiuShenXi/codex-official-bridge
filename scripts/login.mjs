import { spawn } from 'node:child_process';
import { codexEnvironment, runtimeOptions } from '../src/runtime.mjs';

const options = await runtimeOptions();
const flags = process.argv.slice(2);
if (flags.some(flag => !['--browser', '--device-auth'].includes(flag)) || flags.length > 1) {
  console.error('Usage: npm run login -- [--browser|--device-auth]');
  process.exit(1);
}
const browserLogin = flags[0] === '--browser';
console.log(`Signing the official Codex CLI into isolated state: ${options.codexHome}`);
console.log(browserLogin ? 'Complete sign-in in the browser opened by the official CLI.' : 'Complete the official device-code login shown below. No credentials are handled by the gateway.');
const child = spawn(options.command, browserLogin ? ['login'] : ['login', '--device-auth'], {
  cwd: options.cwd, env: codexEnvironment(options.codexHome), stdio: 'inherit', shell: false,
});
child.on('error', error => { console.error(`Could not start Codex: ${error.code}`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
