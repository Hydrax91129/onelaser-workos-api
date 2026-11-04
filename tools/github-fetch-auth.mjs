import { readFileSync } from 'node:fs';

// Optional read-only GitHub token for downloading the pinned frontend and Wiki.
// Docker builds receive it as a BuildKit secret file (never ARG/ENV, so it is not
// kept in an image layer); local runs and CI may pass the environment variable.
// Without a token, downloads stay anonymous, which works while the repositories are public.
export const tokenName = 'GITHUB_FETCH_TOKEN';
export const secretPath = `/etc/secrets/${tokenName}`;

export function githubToken({ env = process.env, readSecret = () => readFileSync(secretPath, 'utf8') } = {}) {
  let token = (env[tokenName] || '').trim();
  if (!token) {
    try { token = readSecret().trim(); } catch { token = ''; }
  }
  if (token && !/^[A-Za-z0-9_]+$/.test(token)) throw new Error(`${tokenName} has an unexpected format.`);
  return token;
}

// The URL of a pinned file and the headers to request it with. With a token, blobs come from
// the API by their Git object id (works for private repositories); without one, from raw.githubusercontent.com.
export function githubFileRequest(repository, revision, file, token, userAgent) {
  const headers = { 'User-Agent': userAgent };
  if (!token) {
    return { url: `https://raw.githubusercontent.com/${repository}/${revision}/${file.path}`, headers };
  }
  return {
    url: `https://api.github.com/repos/${repository}/git/blobs/${file.sha}`,
    headers: { ...headers, Accept: 'application/vnd.github.raw', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  };
}

export function githubTreeHeaders(token, userAgent) {
  const headers = { 'User-Agent': userAgent, Accept: 'application/vnd.github+json' };
  if (token) Object.assign(headers, { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' });
  return headers;
}

// Says whether a token was used, never what it is.
export function describeTokenUse(token) {
  return token ? `${tokenName}: used` : `${tokenName}: not provided, downloading anonymously`;
}
