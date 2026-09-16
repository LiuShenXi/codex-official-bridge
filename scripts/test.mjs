#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Node 20 on Windows does not expand shell globs passed by npm.
const directory = new URL('../test/', import.meta.url);
const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs')).sort().map(name => fileURLToPath(new URL(name, directory)));
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.once('error', () => { process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
