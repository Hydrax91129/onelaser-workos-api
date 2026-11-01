import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Employee-facing WorkOS errors must reach Chinese users in Chinese, not as the generic fallback.
test('every WorkOS error message has Chinese text (i18n table or the zh argument of deny)', () => {
  const i18n = readFileSync('src/i18n.ts', 'utf8');
  const keys = new Set([...i18n.matchAll(/^\s*'((?:[^'\\]|\\.)*)'\s*:/gm)].map(m => m[1].replace(/\\'/g, "'")));
  const files: string[] = [];
  (function walk(d: string) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p); } })('src');
  const skip = /caldock|public-wiki|support\.ts$/;
  const missing: string[] = [];
  for (const f of files.filter(f => !skip.test(f))) {
    const s = readFileSync(f, 'utf8');
    for (const m of s.matchAll(/deny\(\s*\d+\s*,\s*'([A-Z_]+)'\s*,\s*'((?:[^'\\]|\\.)*)'\s*(,|\))/g)) if (m[3] === ')' && !keys.has(m[2])) missing.push(`${f}: ${m[1]} ${m[2]}`);
  }
  assert.deepEqual(missing, []);
});
