import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {githubToken,githubFileRequests,githubTreeHeaders,describeStatus,fetchWithRetry} from './github-fetch-auth.mjs';
const revision=(await readFile(new URL('../deploy/caldock-revision.txt',import.meta.url),'utf8')).trim();
if(!/^[a-f0-9]{40}$/.test(revision))throw new Error('Pin a full CalDock frontend commit.');
const destination=path.resolve(process.argv[2]||'/caldock-source');
const repository='Yonge6/mac-mini-rental',prefix='agent-mac/',userAgent='CalDock-pinned-release';
// This repository has a different owner from the Work OS repositories, and a fine-grained token only reaches one owner, so CalDock has its own token.
const token=githubToken({env:{GITHUB_FETCH_TOKEN:process.env.CALDOCK_FETCH_TOKEN},readSecret:()=>readFileSync('/etc/secrets/CALDOCK_FETCH_TOKEN','utf8')});
console.log(`CALDOCK_FETCH_TOKEN: ${token?'used':'not provided, downloading anonymously'}`);
const rootFiles=new Set(['package.json','package-lock.json','index.html','vite.config.mjs','.openai/hosting.json','worker/index.js','scripts/prepare-sites-build.mjs','scripts/generate-seo.mjs','scripts/seo-content.mjs','scripts/prerender-home.mjs','public/seo-locale.js','public/seo-shell.css','public/llms.txt','public/0f1a4f2c60d091a80c12fdf41674a802.txt','public/robots.txt','public/sitemap.xml','public/404.html']);
const response=await fetchWithRetry(`https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`,{headers:githubTreeHeaders(token,userAgent)});
if(!response.ok)throw new Error(`CalDock source tree is unavailable (${describeStatus(response)}).`);
const tree=await response.json();if(tree.truncated)throw new Error('CalDock source tree truncated.');
const files=tree.tree.filter(f=>f.type==='blob'&&f.path.startsWith(prefix)).map(f=>({...f,relative:f.path.slice(prefix.length)})).filter(f=>rootFiles.has(f.relative)||f.relative.startsWith('src/')||f.relative.startsWith('public/assets/')||f.relative.startsWith('public/legal/')||f.relative.startsWith('public/guides/'));
if(files.length<10||files.length>200||!files.some(f=>f.relative==='src/commerce/pages.jsx'))throw new Error('Not a CalDock account-capable build.');
let total=0;
for(let index=0;index<files.length;index+=6){
 const batch=await Promise.allSettled(files.slice(index,index+6).map(async file=>{
  if(!/^[a-zA-Z0-9_./-]+$/.test(file.relative)||file.relative.split('/').includes('..')||file.mode!=='100644'||file.size>3*1024*1024)throw new Error('Unexpected CalDock source asset.');
  let response;for(const request of githubFileRequests(repository,revision,file,token,userAgent)){response=await fetchWithRetry(request.url,{headers:request.headers});if(response.ok)break;}
  if(!response.ok)throw new Error(`CalDock source asset is unavailable (${describeStatus(response)}).`);
  const bytes=Buffer.from(await response.arrayBuffer());total+=bytes.length;if(total>15*1024*1024)throw new Error('CalDock source package too large.');
  const digest=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');if(digest!==file.sha)throw new Error('CalDock source asset does not match pinned Git bytes.');
  const target=path.join(destination,file.relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);
 }));
 for(const result of batch)if(result.status==='rejected')throw result.reason;
}
await mkdir(path.join(destination,'public'),{recursive:true});await writeFile(path.join(destination,'public/build-info.json'),JSON.stringify({caldockCommit:revision})+'\n');
console.log(`Verified ${files.length} CalDock source assets at ${revision}.`);
