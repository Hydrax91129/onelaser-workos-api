import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const origin = process.env.SMOKE_ORIGIN || 'http://127.0.0.1:18689';
let healthy = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    const response = await fetch(origin + '/healthz');
    if (response.ok) { healthy = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(healthy, 'Container must start with PostgreSQL and no provider keys');
const index = await fetch(origin + '/');
assert.equal(index.status, 200);
assert.match(index.headers.get('content-security-policy'), /script-src 'self'/);
const shellCsp = new Map(index.headers.get('content-security-policy').split(';').map(part => {
  const [name, ...sources] = part.trim().split(/\s+/); return [name, sources.join(' ')];
}));
assert.equal(shellCsp.get('frame-src'), "'none'");
assert.equal(shellCsp.get('frame-ancestors'), "'none'");
assert.equal(shellCsp.get('img-src'), "'self' data: https://wiki.1laser.com https://zohodesk.1laser.com https://www.1laser.com https://encrypted-tbn0.gstatic.com https://weacrylic.com https://images.openai.com https://api2.mubu.com https://document-image.mubu.com");
for (const directive of ['default-src', 'script-src', 'connect-src', 'font-src', 'base-uri']) assert.equal(shellCsp.get(directive), "'self'");
assert.equal(shellCsp.get('object-src'), "'none'");
assert.equal(shellCsp.get('form-action'), "'self' https://login.dingtalk.com");
assert.equal(index.headers.get('cache-control'), 'no-store');
assert.equal(index.headers.get('x-frame-options'), 'DENY');
assert.equal(index.headers.get('referrer-policy'), 'no-referrer');
const consentPage = await fetch(origin + '/api/integrations/grok-bot/oauth/requests/' + 'R'.repeat(43));
assert.equal(consentPage.headers.get('referrer-policy'), 'same-origin', 'Proxy must preserve the consent form origin policy, including error responses');
assert.match(consentPage.headers.get('content-security-policy'), /(?:^|;)\s*img-src 'self' data:;/);
assert.match(consentPage.headers.get('content-security-policy'), /(?:^|;)\s*frame-src 'self';/);
assert.doesNotMatch(consentPage.headers.get('content-security-policy'), /https:\/\/wiki\.1laser\.com/);
const html = await index.text();
for (const asset of ['preferences.js', 'runtime-config.js', 'api-client.js', 'wiki.js', 'wiki.css', 'company-support.js', 'live-app.js']) {
  assert.ok(html.includes(asset), 'Missing production client asset: ' + asset);
  assert.equal((await fetch(origin + '/' + asset)).status, 200);
}
const runtime = await (await fetch(origin + '/runtime-config.js')).text();
assert.match(runtime, /mode:'live'/);
assert.match(runtime, /apiBase:'\/api'/);
assert.doesNotMatch(runtime, /apiKey|secret|password|token/i);
const build = await (await fetch(origin + '/build-info.json')).json();
const pinned = (await readFile(new URL('../deploy/frontend-revision.txt', import.meta.url), 'utf8')).trim();
assert.equal(build.frontendCommit, pinned);
const wiki = await fetch(origin + '/wiki/?lang=zh');
assert.equal(wiki.status, 200);
assert.equal(wiki.headers.get('x-frame-options'), 'SAMEORIGIN');
assert.match(wiki.headers.get('content-security-policy'), /frame-ancestors 'self'/);
assert.match(wiki.headers.get('content-security-policy'), /frame-src 'none'/);
assert.match(wiki.headers.get('content-security-policy'), /https:\/\/document-image\.mubu\.com/);
assert.match(await wiki.text(), /\.\/assets\/app\.js/);
const wikiBuild = await (await fetch(origin + '/wiki/wiki-build-info.json')).json();
const wikiPin = (await readFile(new URL('../deploy/wiki-revision.txt', import.meta.url), 'utf8')).trim();
assert.equal(wikiBuild.sourceCommit, wikiPin); assert.equal(wikiBuild.files, 259);
assert.equal(wikiBuild.articles, 236); assert.equal(wikiBuild.privateOperationsIncluded, false);
assert.equal(wikiBuild.patches.length, 2);
assert.equal(wikiBuild.patches[0].id, 'catalog-family-id-allowlist-v1');
assert.notEqual(wikiBuild.patches[0].sourceSha256, wikiBuild.patches[0].packagedSha256);
assert.equal(wikiBuild.patches[1].id, 'hash-route-language-preservation-v1');
assert.notEqual(wikiBuild.patches[1].sourceSha256, wikiBuild.patches[1].packagedSha256);
const wikiLibrary = await (await fetch(origin + '/wiki/data/library.json')).json();
assert.equal(wikiLibrary.articles.length, 236); assert.equal(wikiLibrary.publication_enabled, false);
assert.equal((await (await fetch(origin + '/wiki/data/search-index.json')).json()).length, 236);
for (const name of ['assets/app.js', 'assets/locale.js', 'assets/fonts/Certia-Regular.otf', 'data/articles/en-36.json']) {
  assert.equal((await fetch(origin + '/wiki/' + name)).status, 200, name);
}
const health = await (await fetch(origin + '/api/health')).json();
assert.equal(health.database, 'postgres');
const capabilities = await (await fetch(origin + '/api/capabilities')).json();
const onSite=(path)=>new Promise((done,fail)=>{const u=new URL(origin+path);const r=httpRequest({hostname:u.hostname,port:u.port,path,headers:{host:'wodemac.com'}},res=>{let body='';res.setEncoding('utf8');res.on('data',c=>{body+=c;});res.on('end',()=>done({status:res.statusCode,headers:res.headers,body}));});r.on('error',fail);r.end();});
const caldockPage=await onSite('/?view=login&lang=zh');
assert.equal(caldockPage.status,200);assert.match(caldockPage.body,/wodeMac/);
assert.equal(caldockPage.headers['cache-control'],'no-store');
assert.match(caldockPage.headers['content-security-policy'],/connect-src 'self'/);
assert.match(caldockPage.headers['content-security-policy'],/frame-ancestors 'none'/);
const caldockBuild=JSON.parse((await onSite('/build-info.json')).body);
assert.equal(caldockBuild.caldockCommit,(await readFile(new URL('../deploy/caldock-revision.txt',import.meta.url),'utf8')).trim());
assert.equal((await onSite('/api/caldock/capabilities')).status,200);
for(const closed of ['/api/health','/api/tasks','/wiki/','/caldock/.env'])assert.equal((await onSite(closed)).status,404,closed);
const legacyRedirect=await fetch(origin+'/caldock/?view=login&lang=zh',{redirect:'manual'});assert.equal(legacyRedirect.status,308);assert.equal(legacyRedirect.headers.get('location'),'https://wodemac.com/?view=login&lang=zh');
const caldockCapabilities=const caldockCapabilities=await (await fetch(origin+'/api/caldock/capabilities')).json();
assert.equal(caldockCapabilities.service,'caldock');assert.equal(caldockCapabilities.providers.google,false);assert.equal(caldockCapabilities.providers.apple,false);assert.equal(caldockCapabilities.payments,false);
for(const route of ['/api/caldock/me','/api/caldock/orders','/api/caldock/admin/orders'])assert.equal((await fetch(origin+route)).status,401);
assert.equal((await fetch(origin+'/api/caldock/auth/google/start',{redirect:'manual'})).status,503);
for(const file of ['/.env','/src/server.ts','/api/tasks'])assert.equal((await onSite(file)).status,404,file);
assert.equal(capabilities.devLogin, false);
assert.equal(capabilities.frontendConnected, true);
assert.equal(capabilities.teamMode, 'company');
assert.equal(capabilities.auth.loginEnabled, false);
assert.equal(capabilities.aiReview, 'not_integrated');
assert.equal(capabilities.aiReviewMode, 'bot');
assert.equal(capabilities.botMcpAuthMode, 'oauth');
assert.ok(capabilities.setup.aiMissing.includes('GROK_BOT_WEBHOOK_URL'));
assert.ok(capabilities.setup.aiMissing.includes('GROK_BOT_OAUTH_REDIRECT_URIS'));
for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/api/integrations/grok-bot/mcp','/.well-known/oauth-authorization-server','/.well-known/oauth-authorization-server/api/integrations/grok-bot/oauth','/api/.well-known/oauth-protected-resource']){
  const response=await fetch(origin+path);assert.equal(response.status,503,path+' must reach disabled OAuth rather than static HTML');assert.equal((await response.json()).error,'temporarily_unavailable');
}
assert.match((await fetch(origin+'/api/integrations/grok-bot/oauth/consent.css')).headers.get('content-type'),/text\/css/);
assert.equal(capabilities.employeeDecisions, 'not_supported');
assert.ok(capabilities.setup.dingtalkMissing.includes('DINGTALK_CLIENT_SECRET'));
for (const path of ['/api/tasks', '/api/directory', '/api/objectives', '/api/auth/csrf']) {
  assert.equal((await fetch(origin + path)).status, 401, path + ' must require login');
}
assert.equal((await fetch(origin + '/api/auth/dev-login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' })).status, 404);
assert.equal((await fetch(origin + '/api/auth/dingtalk/start', {redirect:'manual'})).status, 501);
assert.equal((await fetch(origin + '/api/integrations/grok-bot/mcp', {
  method:'POST', headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})
})).status, 503);
for (const path of ['/.env', '/src/server.ts', '/deploy/Caddyfile', '/build/src/cli/import-okr.js', '/wiki/.env', '/wiki/api/tasks', '/wiki/src/server.ts']) {
  assert.equal((await fetch(origin + path)).status, 404);
}
console.log('Same-origin container smoke passed: pinned live frontend, PostgreSQL API, CSP, and fail-closed authentication. No provider requests sent.');
