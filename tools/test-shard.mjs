#!/usr/bin/env node
/*
 * Split the test files into N groups so CI can run them on N machines at once (owner, 2026-11-13: about 9 minutes
 * of tests in a row became about 3 per group).
 *
 *   node tools/test-shard.mjs 2/4        run group 2 of 4 with the same command as `npm test`
 *   node tools/test-shard.mjs --check 4  check that every test file is in exactly one of 4 groups, and list them
 *
 * Groups are built the same way every time: biggest files first, each into the group with the least so far (file
 * size stands in for run time). The command comes from package.json's "test" script, with its file pattern replaced
 * by this group's files, so flags such as --no-wasm-code-gc stay the same as a full local run.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const testDir = join(root, 'test');
const PATTERN = 'test/*.test.ts';

export function allTestFiles() {
  return readdirSync(testDir).filter(f => f.endsWith('.test.ts')).sort().map(f => `test/${f}`);
}

export function groups(total) {
  const out = Array.from({ length: total }, () => ({ files: [], bytes: 0 }));
  const sized = allTestFiles().map(f => ({ f, bytes: statSync(join(root, f)).size }))
    .sort((a, b) => b.bytes - a.bytes || a.f.localeCompare(b.f));
  for (const { f, bytes } of sized) {
    const g = out.reduce((min, x) => (x.bytes < min.bytes ? x : min), out[0]);
    g.files.push(f); g.bytes += bytes;
  }
  return out.map(g => g.files.sort());
}

function fail(msg) { console.error(msg); process.exit(1); }

const args = process.argv.slice(2);
if (args[0] === '--check') {
  const total = Number(args[1]);
  if (!Number.isInteger(total) || total < 1) fail('Usage: node tools/test-shard.mjs --check <groups>');
  const all = allTestFiles(), seen = new Map();
  groups(total).forEach((files, i) => {
    console.log(`group ${i + 1}/${total}: ${files.length} files`);
    for (const f of files) seen.set(f, (seen.get(f) || 0) + 1);
  });
  const missing = all.filter(f => !seen.has(f)), twice = [...seen].filter(([, n]) => n > 1).map(([f]) => f);
  if (missing.length || twice.length || seen.size !== all.length) fail(`Shard check failed. Missing: ${missing.join(', ') || 'none'}; in more than one group: ${twice.join(', ') || 'none'}`);
  console.log(`All ${all.length} test files are in exactly one group.`);
  process.exit(0);
}

const m = /^(\d+)\/(\d+)$/.exec(args[0] || '');
if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) fail('Usage: node tools/test-shard.mjs <group>/<groups>, e.g. 2/4');
const [index, total] = [Number(m[1]), Number(m[2])];
const files = groups(total)[index - 1];
const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test;
if (!script.includes(PATTERN)) fail(`package.json "test" no longer ends with ${PATTERN}; update tools/test-shard.mjs`);
const [cmd, ...flags] = script.replace(PATTERN, '').trim().split(/\s+/);
console.log(`Test group ${index}/${total}: ${files.length} files\n  ${files.join('\n  ')}`);
if (!files.length) process.exit(0);
const run = spawnSync(join(root, 'node_modules', '.bin', cmd), [...flags, ...files], { stdio: 'inherit', cwd: root, env: process.env });
process.exit(run.status ?? 1);
