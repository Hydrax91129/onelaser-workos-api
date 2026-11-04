import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Run against the real edge binary: CADDY_BIN=/path/to/caddy npm test.
// The Docker smoke check also validates this Caddyfile on every CI build.
test('canonical origin switches only the approved Render host and retains health probes', {
  skip: !process.env.CADDY_BIN && 'Set CADDY_BIN to run the edge integration test',
  timeout: 30_000,
}, async t => {
  await mkdir(resolve('.runtime'), { recursive: true });
  const root = await mkdtemp(resolve('.runtime/caddy-redirect-test-'));
  const wikiRoot = resolve(root, 'wiki');
  await mkdir(resolve(wikiRoot, 'assets'), { recursive: true });
  await mkdir(resolve(wikiRoot, 'data'), { recursive: true });
  await writeFile(resolve(wikiRoot, 'index.html'), 'complete public wiki');
  await writeFile(resolve(wikiRoot, 'assets/app.js'), 'public wiki script');
  await writeFile(resolve(wikiRoot, 'data/library.json'), '{"articles":[{"id":"public-article"}]}');
  const upstream = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ path: req.url, method: req.method }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as { port: number }).port;
  const config = (await readFile(resolve('deploy/Caddyfile'), 'utf8'))
    .replaceAll('127.0.0.1:3001', `127.0.0.1:${upstreamPort}`)
    .replace('root * /app/public', `root * ${root}`)
    .replace('root * /app/wiki', `root * ${wikiRoot}`);
  const configPath = resolve(root, 'Caddyfile');
  await writeFile(configPath, config);
  await writeFile(resolve(root, 'index.html'), 'workos frontend');
  await writeFile(resolve(root, 'task-board.js'), '/* board */');
  const oldHost = 'onelaser-workos.onrender.com';
  try {
    for (const appUrl of ['', `https://${oldHost}`, 'https://elsewhere.example',
      "https://evil.example' || true || '", 'https://craftos.app.evil.example',
      'https://craftos.app', 'https://craftos.app/']) {
      await t.test(`APP_PUBLIC_URL=${JSON.stringify(appUrl)}`, async () => {
        const listener = createServer();
        listener.listen(0, '127.0.0.1');
        await once(listener, 'listening');
        const port = (listener.address() as { port: number }).port;
        await new Promise<void>(resolve => listener.close(() => resolve()));
        const edge = spawn(process.env.CADDY_BIN!, ['run', '--config', configPath, '--adapter', 'caddyfile'], {
          env: { ...process.env, PORT: String(port), APP_PUBLIC_URL: appUrl,
            XDG_DATA_HOME: root, XDG_CONFIG_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let diagnostics = '';
        edge.stdout.on('data', chunk => { diagnostics += chunk; });
        edge.stderr.on('data', chunk => { diagnostics += chunk; });
        const exited = once(edge, 'exit');
        const get = (host: string, path: string, method = 'GET', headers: Record<string, string> = {}) =>
          new Promise<{ status: number; location?: string; cacheControl?: string; csp: string; frameOptions: string; body: string }>((resolve, reject) => {
            const req = request({ hostname: '127.0.0.1', port, path, method, headers: { host, ...headers } }, res => {
              let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
              res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location,
                cacheControl: res.headers['cache-control'],
                csp: String(res.headers['content-security-policy'] || ''),
                frameOptions: String(res.headers['x-frame-options'] || ''), body }));
            });
            req.on('error', reject); req.end();
          });
        try {
          let ready = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            try { ready = (await get(oldHost, '/healthz')).status === 200; } catch {}
            if (ready || edge.exitCode !== null) break;
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          assert.ok(ready, diagnostics);
          const publicPage = await get('craftos.app', '/');
          const csp = new Map(publicPage.csp.split(';').map(part => {
            const [name, ...sources] = part.trim().split(/\s+/);
            return [name, sources.join(' ')] as const;
          }));
          // Native shell never embeds frames; the original Wiki stays available separately.
          assert.equal(csp.get('frame-src'), "'none'");
          assert.equal(csp.get('frame-ancestors'), "'none'");
          assert.equal(publicPage.frameOptions, 'DENY');
          for (const directive of ['default-src', 'script-src', 'connect-src', 'font-src', 'base-uri']) {
            assert.equal(csp.get(directive), "'self'");
          }
          assert.equal(csp.get('style-src'), "'self' 'unsafe-inline'");
          assert.equal(csp.get('object-src'), "'none'");
          assert.equal(csp.get('form-action'), "'self' https://login.dingtalk.com");
          assert.equal(csp.get('img-src'), "'self' data: https://wiki.1laser.com https://zohodesk.1laser.com https://www.1laser.com https://encrypted-tbn0.gstatic.com https://weacrylic.com https://images.openai.com https://api2.mubu.com https://document-image.mubu.com");
          assert.equal((await get('craftos.app', '/index.html')).csp, publicPage.csp);
          for (const path of ['/api/tasks', '/api/integrations/grok-bot/oauth/requests/example', '/.well-known/oauth-authorization-server', '/healthz']) {
            const upstreamPolicy = (await get('craftos.app', path)).csp;
            assert.match(upstreamPolicy, /(?:^|;)\s*img-src 'self' data:;/, path);
            assert.match(upstreamPolicy, /(?:^|;)\s*frame-src 'self';/, path);
            assert.doesNotMatch(upstreamPolicy, /https:\/\/wiki\.1laser\.com/, path);
          }
          const moved = await get('craftos.app', '/caldock/?lang=zh');
          assert.equal(moved.status, 308); assert.equal(moved.location, 'https://wodemac.com/?lang=zh');
          assert.equal((await get('craftos.app', '/caldock')).location?.startsWith('https://wodemac.com/'), true);
          assert.equal((await get('craftos.app', '/caldock/legal/terms.html')).location, 'https://wodemac.com/legal/terms.html');
          const wiki = await get('craftos.app', '/wiki/?lang=zh');
          assert.equal(wiki.status, 200); assert.equal(wiki.body, 'complete public wiki');
          assert.equal(wiki.frameOptions, 'SAMEORIGIN');
          assert.equal(wiki.cacheControl, 'no-store');
          assert.equal((await get('craftos.app','/wiki/data/library.json')).cacheControl, 'public, max-age=300');
          assert.equal((await get('craftos.app','/wiki/assets/example.png')).cacheControl, 'public, max-age=86400');
          assert.equal((await get('craftos.app','/api/tasks')).cacheControl, 'no-store');
          assert.equal((await get('craftos.app','/task-board.js?v=20261101-a')).cacheControl, 'public, max-age=31536000, immutable', 'versioned app scripts are cached');
          assert.equal((await get('craftos.app','/task-board.js')).cacheControl, 'no-store', 'unversioned scripts are not');
          assert.equal((await get('craftos.app','/api/tasks?v=1')).cacheControl, 'no-store', 'API never cached');
          assert.equal((await get('craftos.app','/')).cacheControl, 'no-store', 'the page itself always loads fresh');
          const wikiCsp = new Map(wiki.csp.split(';').map(part => {
            const [name, ...sources] = part.trim().split(/\s+/);
            return [name, sources.join(' ')] as const;
          }));
          assert.equal(wikiCsp.get('frame-ancestors'), "'self'");
          for (const directive of ['default-src', 'script-src', 'style-src', 'connect-src', 'font-src', 'form-action']) {
            assert.equal(wikiCsp.get(directive), "'self'");
          }
          for (const directive of ['frame-src', 'media-src', 'object-src', 'base-uri']) {
            assert.equal(wikiCsp.get(directive), "'none'");
          }
          assert.equal(wikiCsp.get('img-src'), "'self' https://wiki.1laser.com https://zohodesk.1laser.com https://www.1laser.com https://encrypted-tbn0.gstatic.com https://weacrylic.com https://images.openai.com https://api2.mubu.com https://document-image.mubu.com");
          assert.equal((await get('craftos.app', '/wiki/assets/app.js')).body, 'public wiki script');
          const wikiData = await get('craftos.app', '/wiki/data/library.json');
          assert.equal(wikiData.status, 200);assert.deepEqual(JSON.parse(wikiData.body), {articles:[{id:'public-article'}]});
          const wikiRedirect = await get('craftos.app', '/wiki?lang=en');
          assert.equal(wikiRedirect.status, 308); assert.equal(wikiRedirect.location, '/wiki/?lang=en');
          const apiRedirect = await get('craftos.app', '/api');
          assert.equal(apiRedirect.status, 308); assert.equal(apiRedirect.location, '/api/');
          for (const path of ['/wiki/.env', '/wiki/src/server.ts', '/wiki/api/tasks', '/wikievil/']) {
            assert.equal((await get('craftos.app', path)).status, 404, path);
          }
          for (const path of ['/api/tasks', '/wiki', '/wikievil/']) {
            const protectedRoute = await get('craftos.app', path);
            assert.equal(protectedRoute.frameOptions, 'DENY', path);
            assert.match(protectedRoute.csp, /frame-ancestors 'none'/, path);
          }
          for (const path of ['/healthz', '/api/health']) {
            const response = await get(oldHost, path);
            assert.equal(response.status, 200); assert.equal(response.location, undefined);
            assert.equal(JSON.parse(response.body).path, '/health');
          }
          const cutover = appUrl === 'https://craftos.app' || appUrl === 'https://craftos.app/';
          for (const path of ['/', '/api/auth/dingtalk/start?next=%2Ftasks',
            '/api/tasks?limit=10', '/.well-known/oauth-authorization-server']) {
            const response = await get(oldHost, path);
            assert.equal(response.status, cutover ? 307 : 200, path);
            assert.equal(response.location, cutover ? `https://craftos.app${path}` : undefined);
            assert.equal(response.cacheControl, 'no-store');
          }
          const write = await get(oldHost, '/api/tasks', 'POST');
          assert.equal(write.status, cutover ? 307 : 200);
          if (!cutover) assert.equal(JSON.parse(write.body).method, 'POST');
          for (const host of ['craftos.app', 'localhost', 'evil.example', `${oldHost}.evil.example`]) {
            const response = await get(host, '/', 'GET', { 'x-forwarded-host': oldHost });
            assert.equal(response.status, 200); assert.equal(response.location, undefined);
          }
          if (cutover) {
            for (const path of ['//evil.example/path?next=https://evil.example',
              '/%5C%5Cevil.example/path']) {
              const untrustedPath = await get(oldHost, path);
              assert.equal(untrustedPath.status, 307, path);
              assert.equal(new URL(untrustedPath.location!).origin, 'https://craftos.app');
            }
            // Go uses the absolute-form authority instead of the Host header.
            // It must not trick the host matcher or produce a reflected redirect.
            const absoluteForm = await get(oldHost, 'http://evil.example/path?x=1');
            assert.equal(absoluteForm.status, 404);
            assert.equal(absoluteForm.location, undefined);
          }
        } finally {
          edge.kill('SIGTERM'); await exited;
        }
      });
    }
  } finally {
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
