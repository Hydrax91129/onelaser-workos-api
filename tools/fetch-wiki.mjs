import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardenWikiApp, hardenWikiLocale } from './wiki-safety.mjs';
import { githubToken, githubFileRequests, githubTreeHeaders, describeTokenUse, describeStatus } from './github-fetch-auth.mjs';

const repository = 'Hydrax91129/onelaser-support-center';
const fixedFiles = new Set([
  '.nojekyll', 'README.md', 'index.html', 'export-manifest.json', 'docs/sla-draft.md',
  'assets/app.js', 'assets/locale.js', 'assets/styles.css', 'assets/brand.css', 'assets/fonts.css',
  'assets/onelaser-logo-black.svg', 'assets/x-series.jpg', 'assets/hydra-series.png',
  'assets/cobra.webp', 'assets/vertigo.png',
  ...['Regular', 'Medium', 'SemiBold', 'Bold', 'ExtraBold', 'Black'].map(name => `assets/fonts/Certia-${name}.otf`),
  'data/library.json', 'data/search-index.json',
]);
const directories = new Set(['assets', 'assets/fonts', 'data', 'data/articles', 'docs']);
const articlePath = /^data\/articles\/en-[1-9]\d*\.json$/;
const maxFileBytes = 2 * 1024 * 1024;
const maxPackageBytes = 8 * 1024 * 1024;

export function validateWikiTree(tree) {
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('Incomplete Wiki Git tree.');
  const files = [], seen = new Set();
  let total = 0;
  for (const file of tree.tree) {
    if (file.type === 'tree' && directories.has(file.path)) continue;
    if (file.type !== 'blob' || file.mode !== '100644' ||
        (!fixedFiles.has(file.path) && !articlePath.test(file.path)) || seen.has(file.path) ||
        !/^[a-f0-9]{40}$/.test(file.sha) || !Number.isSafeInteger(file.size) ||
        file.size < 0 || file.size > maxFileBytes) throw new Error('Unexpected Wiki asset.');
    seen.add(file.path); total += file.size; files.push(file);
  }
  if (files.length !== 259 || total > maxPackageBytes ||
      [...fixedFiles].some(name => !seen.has(name)) ||
      files.filter(file => articlePath.test(file.path)).length !== 236) {
    throw new Error('Wiki package must preserve all 259 public files and 236 articles.');
  }
  return files;
}

export function verifyWikiBlob(file, buffer) {
  const digest = createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
  if (buffer.length !== file.size || digest !== file.sha) throw new Error(`Wiki Git object mismatch: ${file.path}`);
}

export function validateWikiPackage(buffers) {
  const json = name => JSON.parse(buffers.get(name).toString('utf8'));
  const manifest = json('export-manifest.json');
  if (manifest.type !== 'public_knowledge_center_preview' || manifest.unique_source_pages !== 236 ||
      manifest.private_operations_included !== false || manifest.customer_send_enabled !== false) {
    throw new Error('Wiki export must remain public-only with customer sending disabled.');
  }
  const library = json('data/library.json'), search = json('data/search-index.json');
  if (library.publication_enabled !== false || library.source_status !== 'unreviewed') {
    throw new Error('Wiki source must remain unreviewed and unpublished.');
  }
  const ids = new Set(library.articles?.map(article => article.id));
  if (ids.size !== 236 || library.articles.length !== 236 || search.length !== 236 ||
      new Set(search.map(article => article.id)).size !== 236 ||
      search.some(article => !ids.has(article.id))) throw new Error('Wiki library/search coverage mismatch.');
  const allowedFields = new Set(['id', 'title', 'family', 'topic', 'read_minutes', 'source_url',
    'source_updated_at', 'body_html', 'headings', 'technical_version']);
  for (const id of ids) {
    if (!/^en-[1-9]\d*$/.test(id) || !buffers.has(`data/articles/${id}.json`)) {
      throw new Error('Wiki article missing from package.');
    }
    const article = json(`data/articles/${id}.json`);
    if (article.id !== id || Object.keys(article).some(key => !allowedFields.has(key)) ||
        typeof article.body_html !== 'string' || !article.source_url?.startsWith('https://wiki.1laser.com/')) {
      throw new Error('Unexpected public Wiki article schema.');
    }
  }
}

const userAgent = 'OneLaser-WorkOS-release';

async function boundedFetch(url, maximum, headers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30000), redirect: 'error',
      });
      if (!response.ok) throw Object.assign(new Error(`Wiki download unavailable (${describeStatus(response)}).`), { status: response.status });
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > maximum) throw new Error('Wiki response exceeds its size bound.');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (attempt === 2 || error.status === 404) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

export async function packageWiki(destination, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Pin a full Wiki commit before building.');
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length) throw new Error('Wiki package destination must be empty.');
  const token = githubToken();
  console.log(describeTokenUse(token));
  const tree = JSON.parse((await boundedFetch(
    `https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`, 1024 * 1024,
    githubTreeHeaders(token, userAgent))).toString('utf8'));
  const files = validateWikiTree(tree), buffers = new Map(); let cursor = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      const requests = githubFileRequests(repository, revision, file, token, userAgent);
      let buffer;
      for (const [index, request] of requests.entries()) {
        try { buffer = await boundedFetch(request.url, file.size, request.headers); break; }
        catch (error) { if (error.status !== 404 || index === requests.length - 1) throw error; }
      }
      verifyWikiBlob(file, buffer); buffers.set(file.path, buffer);
    }
  }));
  validateWikiPackage(buffers);
  const originalApp = buffers.get('assets/app.js');
  const hardenedApp = Buffer.from(hardenWikiApp(originalApp.toString('utf8')));
  buffers.set('assets/app.js', hardenedApp);
  const originalLocale = buffers.get('assets/locale.js');
  const hardenedLocale = Buffer.from(hardenWikiLocale(originalLocale.toString('utf8')));
  buffers.set('assets/locale.js', hardenedLocale);
  for (const file of files) {
    const target = path.join(destination, file.path);
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, buffers.get(file.path));
  }
  await writeFile(path.join(destination, 'wiki-build-info.json'), JSON.stringify({
    sourceRepository: repository, sourceCommit: revision, files: files.length,
    articles: 236, privateOperationsIncluded: false,
    patches: [{ id: 'catalog-family-id-allowlist-v1', file: 'assets/app.js',
      sourceSha256: createHash('sha256').update(originalApp).digest('hex'),
      packagedSha256: createHash('sha256').update(hardenedApp).digest('hex') },
    { id: 'hash-route-language-preservation-v1', file: 'assets/locale.js',
      sourceSha256: createHash('sha256').update(originalLocale).digest('hex'),
      packagedSha256: createHash('sha256').update(hardenedLocale).digest('hex') }],
  }) + '\n');
  console.log(`Verified and packaged ${files.length} public Wiki assets at ${revision}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const revision = (await readFile(new URL('../deploy/wiki-revision.txt', import.meta.url), 'utf8')).trim();
  await packageWiki(path.resolve(process.argv[2] || '.runtime/wiki-public'), revision);
}
