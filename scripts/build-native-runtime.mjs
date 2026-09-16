import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, copyFile, mkdir, readFile, realpath, rename, rm, stat, statfs, symlink } from 'node:fs/promises';
import { devNull } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(PROJECT, '.runtime');
const VENDOR = path.join(RUNTIME, 'vendor', 'codex');
const MANIFEST = path.join(PROJECT, 'native-runtime', 'Cargo.toml');
const LOCKFILE = path.join(PROJECT, 'native-runtime', 'Cargo.lock');
const TARGET = path.join(RUNTIME, 'native-target');
const BINARY_NAME = 'codex-official-runtime';
const DESTINATION = path.join(RUNTIME, 'bin', BINARY_NAME + (process.platform === 'win32' ? '.exe' : ''));
const SOURCE_URL = 'https://github.com/openai/codex.git';
const SOURCE_TAG = 'rust-v0.154.0-alpha.6.2';
const SOURCE_COMMIT = 'b5bffd3ec4db487e7e3dec59663875b0ef7b72ca';
const RUST_VERSION = '1.95.0';
const MIN_FREE_BYTES = 8n * 1024n ** 3n;
const SOURCE = path.resolve(process.env.BRIDGE_CODEX_SOURCE || VENDOR);
const sourceWasExplicit = Boolean(process.env.BRIDGE_CODEX_SOURCE);
const checkOnly = process.argv.slice(2).includes('--check-only');
let activeChild;
let interrupted = false;

function error(code, message) { return Object.assign(new Error(message), { code, buildDiagnostic: true }); }
function check(condition, code, message) { if (!condition) throw error(code, message); }

async function exists(location) {
  try { await access(location); return true; } catch (cause) {
    if (cause.code === 'ENOENT') return false;
    throw error('path_unavailable', 'A required build path is not accessible.');
  }
}

function stopChild() {
  if (!activeChild?.pid) return;
  try {
    if (process.platform === 'win32') activeChild.kill('SIGTERM');
    else process.kill(-activeChild.pid, 'SIGTERM');
  } catch { /* The process may already have exited. */ }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { interrupted = true; stopChild(); });
}

// Child output stays private: compiler/git diagnostics may contain local
// credential-bearing URLs. Only validated version strings are ever printed.
function execute(command, args, { cwd = PROJECT, env = process.env, stage, quiet = false } = {}) {
  if (interrupted) return Promise.reject(error('interrupted', 'Build interrupted.'));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;
    let output = Buffer.alloc(0);
    let processError;
    const retain = chunk => { output = Buffer.from(Buffer.concat([output, chunk]).subarray(-64 * 1024)); };
    child.stdout.on('data', retain);
    child.stderr.on('data', retain);
    child.on('error', cause => { processError = cause; });
    const heartbeat = !quiet && stage ? setInterval(() => console.log(`${stage}: still running.`), 30_000) : undefined;
    child.once('close', (code, signal) => {
      clearInterval(heartbeat);
      if (activeChild === child) activeChild = undefined;
      if (interrupted) reject(error('interrupted', 'Build interrupted.'));
      else resolve({ code, signal, processError: processError?.code, output: output.toString('utf8') });
    });
  });
}

const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
};
const rustEnv = { ...process.env, RUSTUP_AUTO_INSTALL: '0' };

async function git(args, options = {}) {
  return execute('git', ['-c', `core.hooksPath=${devNull}`, '-c', 'protocol.file.allow=never', ...args], { env: gitEnv, ...options });
}

async function sourceStatus(location) {
  if (!await exists(location)) return { status: 'missing', needs_download: !sourceWasExplicit };
  const head = await git(['-C', location, 'rev-parse', '--verify', 'HEAD^{commit}'], { quiet: true });
  if (head.code !== 0) return { status: 'not_git_checkout' };
  const commit = head.output.trim();
  if (commit !== SOURCE_COMMIT) return { status: 'wrong_commit', expected_commit: SOURCE_COMMIT };
  const dirty = await git(['-C', location, 'status', '--porcelain', '--untracked-files=all'], { quiet: true });
  if (dirty.code !== 0) return { status: 'cannot_check_worktree' };
  if (dirty.output.trim()) return { status: 'dirty_worktree' };
  if (!await exists(path.join(location, 'codex-rs', 'Cargo.toml'))) return { status: 'missing_official_manifest' };
  return { status: 'verified', commit };
}

async function freeSpace() {
  let location = RUNTIME;
  while (!await exists(location)) location = path.dirname(location);
  const info = await statfs(location, { bigint: true });
  const bytes = info.bavail * info.bsize;
  return { free_gib: Math.floor(Number(bytes) / 1024 ** 3 * 100) / 100, minimum_gib: 8, sufficient: bytes >= MIN_FREE_BYTES };
}

async function rustToolchain() {
  const rustup = await execute('rustup', ['--version'], { env: rustEnv, quiet: true });
  if (rustup.code === 0) {
    const installed = await execute('rustup', ['toolchain', 'list'], { env: rustEnv, quiet: true });
    const hasPinned = installed.code === 0 && installed.output.split('\n').some(line => line.startsWith(`${RUST_VERSION}-`) || line.startsWith(`${RUST_VERSION} `) || line.trim() === RUST_VERSION);
    if (!hasPinned) return { status: 'missing_required_toolchain', rustup: true };
    const rustc = await execute('rustup', ['run', RUST_VERSION, 'rustc', '--version'], { env: rustEnv, quiet: true });
    const cargo = await execute('rustup', ['run', RUST_VERSION, 'cargo', '--version'], { env: rustEnv, quiet: true });
    if (rustc.code !== 0 || !rustc.output.startsWith(`rustc ${RUST_VERSION} `) || cargo.code !== 0 || !cargo.output.startsWith(`cargo ${RUST_VERSION} `)) {
      return { status: 'invalid_required_toolchain', rustup: true };
    }
    return { status: 'ready', rustup: true, command: 'rustup', args: ['run', RUST_VERSION, 'cargo'] };
  }
  const rustc = await execute('rustc', ['--version'], { env: rustEnv, quiet: true });
  const cargo = await execute('cargo', ['--version'], { env: rustEnv, quiet: true });
  if (rustc.code !== 0 || cargo.code !== 0) return { status: 'rust_not_installed', rustup: false };
  if (!rustc.output.startsWith(`rustc ${RUST_VERSION} `) || !cargo.output.startsWith(`cargo ${RUST_VERSION} `)) return { status: 'wrong_rust_version', rustup: false };
  return { status: 'ready', rustup: false, command: 'cargo', args: [] };
}

async function preflight() {
  const disk = await freeSpace();
  const gitVersion = await git(['--version'], { quiet: true });
  const gitReady = gitVersion.code === 0 && /^git version [\w.+-]+/.test(gitVersion.output.trim());
  const rust = await rustToolchain();
  const source = gitReady ? await sourceStatus(SOURCE) : { status: 'unchecked_without_git' };
  const manifest = await exists(MANIFEST);
  const problems = [];
  if (!disk.sufficient) problems.push('At least 8 GiB free is required before downloading or compiling. Free space or use a build host with sufficient space.');
  if (!gitReady) problems.push('Git is required and was not found or could not run.');
  if (rust.status !== 'ready') problems.push(`Rust and Cargo ${RUST_VERSION} must already be installed. This script never installs or changes the global Rust toolchain.`);
  if (source.status !== 'verified' && !(source.status === 'missing' && !sourceWasExplicit)) problems.push(`Official source verification failed (${source.status}); supply a clean checkout at the exact pinned commit.`);
  if (!manifest) problems.push('native-runtime/Cargo.toml is missing.');
  if (sourceWasExplicit && await exists(VENDOR) && await exists(SOURCE) && await realpath(VENDOR) !== await realpath(SOURCE)) problems.push('The default vendor location already points to different source; it will not be overwritten.');
  return { disk, gitReady, rust, source, manifest, problems };
}

async function prepareSource() {
  await mkdir(path.dirname(VENDOR), { recursive: true });
  if (sourceWasExplicit) {
    if (!await exists(VENDOR)) await symlink(await realpath(SOURCE), VENDOR, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  if (await exists(VENDOR)) return;
  const staging = path.join(path.dirname(VENDOR), `.codex-download-${randomUUID()}`);
  console.log(`Downloading official source tag ${SOURCE_TAG}; verifying its exact commit before use.`);
  try {
    const clone = await git(['clone', '--depth', '1', '--branch', SOURCE_TAG, '--single-branch', SOURCE_URL, staging], { stage: 'Source download' });
    check(clone.code === 0, 'source_download_failed', 'Official source download failed. Git output is withheld to avoid exposing credential-bearing URLs.');
    const verified = await sourceStatus(staging);
    check(verified.status === 'verified', 'source_verification_failed', `Downloaded source verification failed (${verified.status}); no source was installed.`);
    await rename(staging, VENDOR);
  } finally { await rm(staging, { recursive: true, force: true }); }
}

async function build(rust) {
  // Recheck after source checkout, before Cargo can download or compile anything.
  check((await freeSpace()).sufficient, 'insufficient_disk', 'Less than 8 GiB is free after source checkout; compilation was not started.');
  const verified = await sourceStatus(VENDOR);
  check(verified.status === 'verified', 'source_verification_failed', `Official source changed before compilation (${verified.status}); compilation was not started.`);
  // A standalone workspace does not inherit the dependency lock from its path
  // dependencies. Seed from the pinned upstream lock, then let the first native
  // build add this workspace root and its dependencies. Subsequent builds lock
  // the resulting graph; a failed first build can safely retry the seed.
  if (!await exists(LOCKFILE)) await copyFile(path.join(VENDOR, 'codex-rs', 'Cargo.lock'), LOCKFILE);
  const lockText = (await readFile(LOCKFILE, 'utf8')).replaceAll('\r\n', '\n');
  const lockReady = /(?:^|\n)\[\[package\]\]\nname = "codex-native-runtime"\n/.test(lockText);
  console.log(lockReady ? 'Dependency resolution: using the native Cargo.lock with --locked.' : 'Dependency resolution: adding the native workspace to the pinned upstream lock seed.');
  console.log(`Building ${BINARY_NAME} with Rust ${RUST_VERSION}. Compilation output is not echoed.`);
  const result = await execute(rust.command, [...rust.args, 'build', '--release', ...(lockReady ? ['--locked'] : []), '--manifest-path', MANIFEST, '--target-dir', TARGET, '--bin', BINARY_NAME], {
    env: rustEnv, stage: 'Native compilation',
  });
  check(result.code === 0, 'native_build_failed', `Native compilation failed (exit ${result.code ?? result.processError ?? result.signal ?? 'unknown'}). Run the documented Cargo command locally to inspect full compiler diagnostics.`);
  const built = path.join(TARGET, 'release', BINARY_NAME + (process.platform === 'win32' ? '.exe' : ''));
  check((await stat(built)).isFile(), 'missing_binary', 'Cargo succeeded but the expected executable was not produced.');
  await mkdir(path.dirname(DESTINATION), { recursive: true });
  const staging = `${DESTINATION}.new-${randomUUID()}`;
  try {
    await copyFile(built, staging);
    if (process.platform !== 'win32') await chmod(staging, 0o755);
    await rename(staging, DESTINATION);
  } finally { await rm(staging, { force: true }); }
  console.log(`Native runtime ready: ${DESTINATION}`);
}

try {
  const args = process.argv.slice(2);
  check(args.every(arg => ['--check-only', '--help'].includes(arg)), 'invalid_argument', 'Supported options: --check-only, --help.');
  if (args.includes('--help')) {
    console.log('Usage: node scripts/build-native-runtime.mjs [--check-only]\nChecks Git, Rust 1.95.0, pinned source and at least 8 GiB free.\nBRIDGE_CODEX_SOURCE may point to an existing clean checkout at the exact pinned commit.\n--check-only performs read-only checks; it never downloads, builds, or creates directories.');
  } else {
    const report = await preflight();
    console.log(JSON.stringify({
      status: report.problems.length ? 'not_ready' : 'ready', check_only: checkOnly,
      source_tag: SOURCE_TAG, source_commit: SOURCE_COMMIT, source: report.source,
      disk: report.disk, git_available: report.gitReady, required_rust: RUST_VERSION,
      rust_status: report.rust.status, manifest_present: report.manifest, problems: report.problems,
    }, null, 2));
    if (report.problems.length) process.exitCode = 1;
    else if (!checkOnly) { await prepareSource(); await build(report.rust); }
  }
} catch (cause) {
  console.error(JSON.stringify({ status: 'failed', code: cause.code ?? 'build_failed', message: cause.buildDiagnostic ? cause.message : 'Native build could not complete; no child process output is exposed.' }, null, 2));
  process.exitCode = interrupted ? 130 : 1;
} finally { stopChild(); }
