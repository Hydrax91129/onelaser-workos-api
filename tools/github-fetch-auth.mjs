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

// The requests to try, in order, for one pinned file. Files come from raw.githubusercontent.com,
// which does not count against the GitHub REST API rate limit (5000 requests an hour per token,
// shared by every CI run and Render build). With a token the raw request carries it, so private
// repositories work; only if raw answers 404 does the file come from the API by its Git object id.
// The tree listing is then the only API request per repository and build.
export function githubFileRequests(repository, revision, file, token, userAgent) {
  const raw = { url: `https://raw.githubusercontent.com/${repository}/${revision}/${file.path}`, headers: { 'User-Agent': userAgent } };
  if (!token) return [raw];
  raw.headers.Authorization = `Bearer ${token}`;
  return [raw, {
    url: `https://api.github.com/repos/${repository}/git/blobs/${file.sha}`,
    headers: { 'User-Agent': userAgent, Accept: 'application/vnd.github.raw', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
  }];
}

// Status for an error message, naming a GitHub rate limit when that is the cause (never the token).
export function describeStatus(response) {
  const limited = (response.status === 403 || response.status === 429) && response.headers?.get?.('x-ratelimit-remaining') === '0';
  return limited ? `${response.status}, GitHub API rate limit reached` : String(response.status);
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
