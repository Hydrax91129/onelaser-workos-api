import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const revision=(await readFile(new URL('../deploy/caldock-revision.txt',import.meta.url),'utf8')).trim();
if(!/^[a-f0-9]{40}$/.test(revision))throw new Error('Pin a full CalDock frontend commit.');
const destination=path.resolve(process.argv[2]||'/caldock-source');
const repository='Yonge6/mac-mini-rental',prefix='agent-mac/';
const rootFiles=new Set(['package.json','package-lock.json','index.html','vite.config.mjs','.openai/hosting.json','worker/index.js','scripts/prepare-sites-build.mjs']);
const response=await fetch(`https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`,{headers:{'User-Agent':'CalDock-pinned-release'},signal:AbortSignal.timeout(30000)});
if(!response.ok)throw new Error('CalDock source tree is unavailable.');
const tree=await response.json();if(tree.truncated)throw new Error('CalDock source tree truncated.');
const files=tree.tree.filter(f=>f.type==='blob'&&f.path.startsWith(prefix)).map(f=>({...f,relative:f.path.slice(prefix.length)})).filter(f=>rootFiles.has(f.relative)||f.relative.startsWith('src/')||f.relative.startsWith('public/assets/')||f.relative.startsWith('public/decision-studio/')||f.relative.startsWith('public/legal/'));
if(files.length<10||files.length>200||!files.some(f=>f.relative==='src/commerce/pages.jsx'))throw new Error('Not a CalDock account-capable build.');
let total=0;
for(let index=0;index<files.length;index+=6){
 const batch=await Promise.allSettled(files.slice(index,index+6).map(async file=>{
  if(!/^[a-zA-Z0-9_./-]+$/.test(file.relative)||file.relative.split('/').includes('..')||file.mode!=='100644'||file.size>3*1024*1024)throw new Error('Unexpected CalDock source asset.');
  const response=await fetch(`https://raw.githubusercontent.com/${repository}/${revision}/${file.path}`,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('CalDock source asset is unavailable.');
  const bytes=Buffer.from(await response.arrayBuffer());total+=bytes.length;if(total>15*1024*1024)throw new Error('CalDock source package too large.');
  const digest=createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');if(digest!==file.sha)throw new Error('CalDock source asset does not match pinned Git bytes.');
  const target=path.join(destination,file.relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes);
 }));
 for(const result of batch)if(result.status==='rejected')throw result.reason;
}
await mkdir(path.join(destination,'public'),{recursive:true});await writeFile(path.join(destination,'public/build-info.json'),JSON.stringify({caldockCommit:revision})+'\n');
console.log(`Verified ${files.length} CalDock source assets at ${revision}.`);
