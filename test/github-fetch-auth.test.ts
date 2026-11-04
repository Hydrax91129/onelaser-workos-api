import { test } from 'node:test';
import assert from 'node:assert/strict';

const { githubToken, githubFileRequest, githubTreeHeaders, describeTokenUse, secretPath } =
  await import(new URL('../tools/github-fetch-auth.mjs', import.meta.url).href);
const fictionalToken = 'github_pat_FICTIONAL0example';
const file = { path: 'dist/live-app.js', sha: 'b'.repeat(40) };
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };

test('fetch token comes from the env variable, then the BuildKit secret file, else anonymous', () => {
  assert.equal(secretPath, '/etc/secrets/GITHUB_FETCH_TOKEN');
  assert.equal(githubToken({ env: { GITHUB_FETCH_TOKEN: ` ${fictionalToken}\n` }, readSecret: missing }), fictionalToken);
  assert.equal(githubToken({ env: {}, readSecret: () => `${fictionalToken}\n` }), fictionalToken);
  assert.equal(githubToken({ env: { GITHUB_FETCH_TOKEN: '' }, readSecret: () => '' }), '');
  assert.equal(githubToken({ env: {}, readSecret: missing }), '');
  assert.throws(() => githubToken({ env: { GITHUB_FETCH_TOKEN: 'bad token\nX-Injected: 1' }, readSecret: missing }), /unexpected format/);
});

test('anonymous downloads keep raw URLs and send no Authorization header', () => {
  const request = githubFileRequest('Hydrax91129/onelaser-workos', 'c'.repeat(40), file, '', 'ua');
  assert.equal(request.url, `https://raw.githubusercontent.com/Hydrax91129/onelaser-workos/${'c'.repeat(40)}/dist/live-app.js`);
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(githubTreeHeaders('', 'ua').Authorization, undefined);
});

test('token downloads fetch the pinned blob by object id through the API', () => {
  const request = githubFileRequest('Hydrax91129/onelaser-workos', 'c'.repeat(40), file, fictionalToken, 'ua');
  assert.equal(request.url, `https://api.github.com/repos/Hydrax91129/onelaser-workos/git/blobs/${file.sha}`);
  assert.equal(request.headers.Authorization, `Bearer ${fictionalToken}`);
  assert.equal(request.headers.Accept, 'application/vnd.github.raw');
  assert.equal(githubTreeHeaders(fictionalToken, 'ua').Authorization, `Bearer ${fictionalToken}`);
});

test('build log says whether a token was used and never prints it', () => {
  assert.equal(describeTokenUse(fictionalToken), 'GITHUB_FETCH_TOKEN: used');
  assert.ok(!describeTokenUse(fictionalToken).includes(fictionalToken));
  assert.match(describeTokenUse(''), /not provided/);
});
