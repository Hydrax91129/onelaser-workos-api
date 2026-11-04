import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const revision=(await readFile(new URL('../deploy/frontend-revision.txt',import.meta.url),'utf8')).trim();
if(!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Pin a full frontend commit before building.');
const destination=path.resolve(process.argv[2]||'public');
const headers={'User-Agent':'OneLaser-WorkOS-release','Accept':'application/vnd.github+json'};
const treeResponse=await fetch(`https://api.github.com/repos/Hydrax91129/onelaser-workos/git/trees/${revision}?recursive=1`,{headers,signal:AbortSignal.timeout(30000)});
if(!treeResponse.ok) throw new Error(`Frontend tree unavailable (${treeResponse.status}).`);
const tree=await treeResponse.json();
if(tree.truncated) throw new Error('Frontend tree unexpectedly truncated.');
const files=tree.tree.filter(x=>x.type==='blob'&&x.path.startsWith('dist/')&&x.path!=='dist/.nojekyll');
if(!files.length||files.length>100||!files.some(x=>x.path==='dist/live-app.js')) throw new Error('Pinned revision is not the live-capable frontend.');
let total=0;
for(const file of files){
  const relative=file.path.slice(5);
  if(!/^[a-zA-Z0-9_./-]+$/.test(relative)||relative.split('/').includes('..')||file.mode!=='100644'||file.size>2*1024*1024)throw new Error('Unexpected frontend asset.');
  const response=await fetch(`https://raw.githubusercontent.com/Hydrax91129/onelaser-workos/${revision}/${file.path}`,{headers,signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw new Error(`Frontend asset unavailable (${response.status}).`);
  const buffer=Buffer.from(await response.arrayBuffer());total+=buffer.length;
  if(total>5*1024*1024)throw new Error('Frontend package is unexpectedly large.');
  const digest=createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
  if(digest!==file.sha)throw new Error('Frontend asset does not match the pinned Git object.');
  const target=path.join(destination,relative);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,buffer);
}
await writeFile(path.join(destination,'build-info.json'),JSON.stringify({frontendCommit:revision})+'\n');
console.log(`Verified and packaged ${files.length} frontend assets at ${revision}.`);
