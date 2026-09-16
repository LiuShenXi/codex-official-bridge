#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

async function collect(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.runtime') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(path);
  }
  return files;
}

try {
  const files = (await Promise.all(['src', 'scripts', 'examples', 'test'].map((name) => collect(join(root, name))))).flat();
  let failures = 0;
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      failures += 1;
      console.error(`FAIL ${relative(root, file)}`);
      if (result.error) console.error(result.error.message);
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.signal) console.error(`Terminated by ${result.signal}`);
    }
  }
  if (failures) {
    console.error(`Syntax checks failed: ${failures}/${files.length} files.`);
    process.exitCode = 1;
  } else {
    console.log(`Syntax checks passed: ${files.length} .mjs files.`);
  }
} catch (error) {
  console.error(`Syntax check failed: ${error.message}`);
  process.exitCode = 1;
}
