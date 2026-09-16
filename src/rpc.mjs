import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';

const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = (id) => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

function rpcError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** Owns one official app-server process. No credentials or stderr are logged. */
export class CodexRpc extends EventEmitter {
  #child;
  #startPromise;
  #stopPromise;
  #childClosed = false;
  #childClosedPromise;
  #terminalError;
  #pending = new Map();
  #nextId = 1;
  #buffer = Buffer.alloc(0);
  #stderrTail = Buffer.alloc(0);

  constructor({
    command = 'codex',
    args = ['app-server', '--listen', 'stdio://'],
    cwd,
    env,
    requestTimeoutMs = 15_000,
    maxLineBytes = 8 * 1024 * 1024,
  } = {}) {
    super();
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new TypeError('requestTimeoutMs must be positive');
    }
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new TypeError('maxLineBytes must be a positive integer');
    }
    this.options = { command, args: [...args], cwd, env, requestTimeoutMs, maxLineBytes };
    this.started = false;
    this.closed = false;
  }

  start() {
    if (this.closed) return Promise.reject(this.#terminalError);
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  async #start() {
    try {
      const { command, args, cwd, env } = this.options;
      this.#child = spawn(command, args, {
        cwd,
        env: env ?? process.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const child = this.#child;
      this.#childClosedPromise = new Promise((resolve) => {
        child.once('close', (code, signal) => {
          this.#childClosed = true;
          resolve();
          this.#fail(rpcError(
            `Codex app-server exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`,
            'RPC_PROCESS_EXIT',
            { exitCode: code, signal },
          ));
        });
      });
      child.once('error', (error) => this.#fail(rpcError(
        `Cannot start Codex app-server (${error.code ?? 'process error'})`,
        'RPC_PROCESS_ERROR',
      )));
      child.stdin.on('error', () => this.#fail(rpcError('Codex stdin failed', 'RPC_IO_ERROR')));
      child.stdout.on('error', () => this.#fail(rpcError('Codex stdout failed', 'RPC_IO_ERROR')));
      child.stderr.on('error', () => this.#fail(rpcError('Codex stderr failed', 'RPC_IO_ERROR')));
      child.stdout.on('data', (chunk) => this.#onData(chunk));
      child.stderr.on('data', (chunk) => {
        // Keep only a bounded private tail. Do not attach it to user-visible errors.
        this.#stderrTail = Buffer.from(Buffer.concat([this.#stderrTail, chunk]).subarray(-8192));
      });

      await this.#request('initialize', {
        clientInfo: {
          name: 'codex_official_bridge',
          title: 'Codex Official Bridge',
          version: '0.1.0',
        },
        capabilities: { experimentalApi: true },
      });
      this.#send({ method: 'initialized' });
      this.started = true;
      return this;
    } catch (error) {
      this.#fail(error);
      await this.#stopChild();
      throw error;
    }
  }

  request(method, params, { timeoutMs = this.options.requestTimeoutMs } = {}) {
    if (!this.started || this.closed) {
      return Promise.reject(this.#terminalError ?? rpcError('Codex RPC has not started', 'RPC_NOT_STARTED'));
    }
    return this.#request(method, params, timeoutMs);
  }

  #request(method, params, timeoutMs = this.options.requestTimeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new TypeError('timeoutMs must be positive'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(rpcError(`Codex RPC request timed out: ${method}`, 'RPC_TIMEOUT', { method }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#requireStarted();
    this.#send({ method, params });
  }

  respond(id, result) {
    this.#requireStarted();
    if (!validId(id)) throw new TypeError('RPC response id must be a string or number');
    this.#send({ id, result });
  }

  respondError(id, { code, message }) {
    this.#requireStarted();
    if (!validId(id)) throw new TypeError('RPC response id must be a string or number');
    this.#send({ id, error: { code, message } });
  }

  #requireStarted() {
    if (!this.started || this.closed) {
      throw this.#terminalError ?? rpcError('Codex RPC has not started', 'RPC_NOT_STARTED');
    }
  }

  #send(message) {
    if (this.closed || !this.#child?.stdin.writable) {
      throw this.#terminalError ?? rpcError('Codex RPC is closed', 'RPC_CLOSED');
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.#fail(rpcError('Cannot write to Codex stdin', 'RPC_IO_ERROR'));
    });
  }

  #onData(chunk) {
    if (this.closed) return;
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 10) continue;
      if (!this.#append(chunk.subarray(start, index))) return;
      const line = this.#buffer;
      this.#buffer = Buffer.alloc(0);
      this.#onLine(line);
      if (this.closed) return;
      start = index + 1;
    }
    this.#append(chunk.subarray(start));
  }

  #append(chunk) {
    if (this.#buffer.length + chunk.length > this.options.maxLineBytes) {
      this.#fail(rpcError('Codex RPC line exceeds maxLineBytes', 'RPC_PROTOCOL_ERROR'));
      return false;
    }
    if (chunk.length) this.#buffer = Buffer.concat([this.#buffer, chunk]);
    return true;
  }

  #onLine(bytes) {
    const line = bytes.toString('utf8').trim();
    if (!line) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#fail(rpcError('Codex emitted invalid JSON', 'RPC_PROTOCOL_ERROR'));
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.#fail(rpcError('Codex emitted an invalid RPC message', 'RPC_PROTOCOL_ERROR'));
      return;
    }
    if (has(message, 'method')) {
      if (typeof message.method !== 'string' || !message.method || (has(message, 'id') && !validId(message.id))) {
        this.#fail(rpcError('Codex emitted an invalid RPC method or id', 'RPC_PROTOCOL_ERROR'));
        return;
      }
      if (has(message, 'id')) {
        this.emit('serverRequest', { id: message.id, method: message.method, params: message.params });
      } else {
        this.emit('notification', { method: message.method, params: message.params });
      }
      return;
    }
    if (!validId(message.id) || has(message, 'result') === has(message, 'error')) {
      this.#fail(rpcError('Codex emitted an invalid RPC response', 'RPC_PROTOCOL_ERROR'));
      return;
    }
    if (has(message, 'error') && (!message.error || typeof message.error !== 'object' ||
      typeof message.error.message !== 'string' || typeof message.error.code !== 'number')) {
      this.#fail(rpcError('Codex emitted an invalid RPC error', 'RPC_PROTOCOL_ERROR'));
      return;
    }
    const pending = this.#pending.get(message.id);
    // A timed-out request may still produce a response; it cannot match a later request.
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (has(message, 'error')) {
      pending.reject(rpcError(message.error.message, message.error.code, { data: message.error.data }));
    } else {
      pending.resolve(message.result);
    }
  }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.#terminalError = error;
    this.#buffer = Buffer.alloc(0);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.emit('exit', error);
    void this.#stopChild();
  }

  #stopChild() {
    this.#stopPromise ??= (async () => {
      const child = this.#child;
      if (!child || this.#childClosed) return;
      child.stdin.end();
      child.kill('SIGTERM');
      await this.#waitForClose(300);
      if (!this.#childClosed) {
        child.kill('SIGKILL');
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        await this.#waitForClose(300);
      }
      child.unref();
    })();
    return this.#stopPromise;
  }

  #waitForClose(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.#childClosedPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async close() {
    this.#fail(rpcError('Codex RPC closed', 'RPC_CLOSED'));
    await this.#stopChild();
  }
}
