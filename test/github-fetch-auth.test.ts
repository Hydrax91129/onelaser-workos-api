import { test } from 'node:test';
import assert from 'node:assert/strict';

const { githubToken, githubFileRequests, githubTreeHeaders, describeTokenUse, describeStatus, secretPath } =
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
  const requests = githubFileRequests('Hydrax91129/onelaser-workos', 'c'.repeat(40), file, '', 'ua');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://raw.githubusercontent.com/Hydrax91129/onelaser-workos/${'c'.repeat(40)}/dist/live-app.js`);
  assert.equal(requests[0].headers.Authorization, undefined);
  assert.equal(githubTreeHeaders('', 'ua').Authorization, undefined);
});

test('token downloads use raw first (outside the API rate limit) and fall back to the API blob', () => {
  const requests = githubFileRequests('Hydrax91129/onelaser-workos', 'c'.repeat(40), file, fictionalToken, 'ua');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `https://raw.githubusercontent.com/Hydrax91129/onelaser-workos/${'c'.repeat(40)}/dist/live-app.js`);
  assert.equal(requests[0].headers.Authorization, `Bearer ${fictionalToken}`);
  assert.equal(requests[1].url, `https://api.github.com/repos/Hydrax91129/onelaser-workos/git/blobs/${file.sha}`);
  assert.equal(requests[1].headers.Accept, 'application/vnd.github.raw');
  assert.equal(githubTreeHeaders(fictionalToken, 'ua').Authorization, `Bearer ${fictionalToken}`);
});

test('error status names an exhausted GitHub rate limit', () => {
  const response = (status: number, remaining?: string) => ({ status, headers: new Headers(remaining === undefined ? {} : { 'x-ratelimit-remaining': remaining }) });
  assert.equal(describeStatus(response(403, '0')), '403, GitHub API rate limit reached');
  assert.equal(describeStatus(response(429, '0')), '429, GitHub API rate limit reached');
  assert.equal(describeStatus(response(403, '12')), '403');
  assert.equal(describeStatus(response(404)), '404');
});

test('build log says whether a token was used and never prints it', () => {
  assert.equal(describeTokenUse(fictionalToken), 'GITHUB_FETCH_TOKEN: used');
  assert.ok(!describeTokenUse(fictionalToken).includes(fictionalToken));
  assert.match(describeTokenUse(''), /not provided/);
});
