import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer, type IncomingMessage} from 'node:http';
import {createHash} from 'node:crypto';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {signV4,s3Store,fileStorageFromEnv,s3ConfigFromEnv,objectKey,type FileStorage} from '../src/files.js';

const CRED={accessKeyId:'AKIDTEST',secretAccessKey:'test-secret-key',region:'oss-cn-hongkong'};

/** A minimal S3-compatible bucket: path-style PUT/GET/DELETE, every request's SigV4 signature re-checked
 * against the headers that actually arrived. `fail` makes it answer 500. */
async function fakeBucket(){
  const objects=new Map<string,{body:Buffer;type:string}>(),log:{method:string;path:string;signed:boolean}[]=[];
  const state={fail:false};
  const verify=(req:IncomingMessage,body:Buffer)=>{
    const auth=String(req.headers.authorization||''),m=/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if(!m||m[1]!==CRED.accessKeyId||m[3]!==CRED.region)return false;
    if(req.headers['x-amz-content-sha256']!==createHash('sha256').update(body).digest('hex'))return false;
    const headers:Record<string,string>={};
    for(const n of m[4].split(';'))if(!['host','x-amz-date','x-amz-content-sha256'].includes(n))headers[n]=String(req.headers[n]);
    const d=String(req.headers['x-amz-date']),when=new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${d.slice(9,11)}:${d.slice(11,13)}:${d.slice(13,15)}Z`);
    const probe={method:req.method!,url:new URL(req.url!,`http://${req.headers.host}`),headers,payloadHash:String(req.headers['x-amz-content-sha256'])};
    return signV4(probe,CRED,when)===m[5]&&probe.headers.authorization.includes('SignedHeaders='+m[4]+',');
  };
  const server=createServer((req,res)=>{
    const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
      const body=Buffer.concat(chunks),path=decodeURIComponent(new URL(req.url!,'http://x').pathname),signed=verify(req,body);
      log.push({method:req.method!,path,signed});
      if(!signed){res.writeHead(403);res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');return;}
      if(state.fail){res.writeHead(500);res.end('<Error><Code>InternalError</Code></Error>');return;}
      if(req.method==='PUT'){objects.set(path,{body,type:String(req.headers['content-type'])});res.writeHead(200);res.end();}
      else if(req.method==='GET'){const o=objects.get(path);if(!o){res.writeHead(404);res.end('<Error><Code>NoSuchKey</Code></Error>');return;}res.writeHead(200,{'content-type':o.type});res.end(o.body);}
      else if(req.method==='DELETE'){objects.delete(path);res.writeHead(204);res.end();}
      else{res.writeHead(405);res.end();}
    });
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const port=(server.address() as any).port;
  const store=s3Store({endpoint:`http://127.0.0.1:${port}`,bucket:'erp-files',pathStyle:true,...CRED});
  return {objects,log,state,store,close:()=>new Promise<void>(r=>{server.close(()=>r());server.closeAllConnections();})};
}
async function setup(files:FileStorage,closeDatabase=true){
  const db=await createDatabase();await db.exec(schema);await seedDemo(db);
  const app=await buildApp({db,files,closeDatabase,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
  const tokens:Record<string,string>={};
  const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
  return {db,app,call};
}
const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');

test('SigV4 signing matches the AWS published example (GET object with Range)',()=>{
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html — "Example: GET Object"
  const req={method:'GET',url:new URL('https://examplebucket.s3.amazonaws.com/test.txt'),headers:{range:'bytes=0-9'} as Record<string,string>,payloadHash:'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'};
  const sig=signV4(req,{accessKeyId:'AKIAIOSFODNN7EXAMPLE',secretAccessKey:'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',region:'us-east-1'},new Date('2013-05-24T00:00:00Z'));
  assert.equal(sig,'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(req.headers.authorization,'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('configuration: database storage by default, all-or-nothing bucket settings, https only',()=>{
  assert.deepEqual(fileStorageFromEnv({}),{mode:'db',store:null});
  const full={S3_ENDPOINT:'https://oss-cn-hongkong.aliyuncs.com',S3_BUCKET:'b',S3_REGION:'oss-cn-hongkong',S3_ACCESS_KEY_ID:'k',S3_SECRET_ACCESS_KEY:'s'};
  assert.throws(()=>fileStorageFromEnv({FILE_STORAGE:'s3'}),/needs S3_ENDPOINT/);
  assert.throws(()=>fileStorageFromEnv({FILE_STORAGE:'oss'}),/db or s3/);
  assert.throws(()=>s3ConfigFromEnv({S3_BUCKET:'b'}),/missing S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
  assert.throws(()=>s3ConfigFromEnv({...full,S3_ENDPOINT:'http://oss.example.com'}),/https/);
  const s3=fileStorageFromEnv({...full,FILE_STORAGE:'s3'});assert.equal(s3.mode,'s3');assert.ok(s3.store);
  const readOnly=fileStorageFromEnv(full);assert.equal(readOnly.mode,'db');assert.ok(readOnly.store,'bucket stays readable after switching back to db');
  // virtual-hosted style (OSS requires it) vs path style (R2, MinIO)
  const v=s3Store({endpoint:'https://oss-cn-hongkong.aliyuncs.com',bucket:'erp',region:'oss-cn-hongkong',accessKeyId:'k',secretAccessKey:'s',prefix:'prod'});
  assert.equal(v.urlFor('org/o1/rma/c1/p1').href,'https://erp.oss-cn-hongkong.aliyuncs.com/prod/org/o1/rma/c1/p1');
  const p=s3Store({endpoint:'https://acct.r2.cloudflarestorage.com',bucket:'erp',region:'auto',accessKeyId:'k',secretAccessKey:'s',pathStyle:true});
  assert.equal(p.urlFor('a b/c').href,'https://acct.r2.cloudflarestorage.com/erp/a%20b/c');
  assert.equal(objectKey('org-1','tasks','t/../x','id 1'),'org/org-1/tasks/t____x/id_1','no path tricks in keys');
});

test('object storage: RMA photos, task attachments and feedback screenshots go to the bucket and download through the API',async()=>{
  const bucket=await fakeBucket(),{db,app,call}=await setup({mode:'s3',store:bucket.store});
  try{
    // RMA photo
    await call('m1','POST','/wms/import',{asOf:'2026-10-31',rows:[{sku:'DEMO-A',name:'Demo machine A',type:'整机',qty:{us:5}}]});
    const c=(await call('m1','POST','/rma',{sku:'DEMO-A',kind:'return',reason:'坏了',receivedAt:'2026-11-01'})).json();
    const ph=await call('m1','POST',`/rma/${c.id}/photos`,{kind:'received',name:'in.png',mime:'image/png',dataBase64:PNG.toString('base64')});assert.equal(ph.statusCode,201,ph.body);
    const row=(await db.query('SELECT data,storage_key FROM rma_photos WHERE id=$1',[ph.json().id])).rows[0];
    assert.equal(row.data,null,'no bytes in the database');assert.match(row.storage_key,/^org\/[^/]+\/rma\//);
    assert.deepEqual(bucket.objects.get('/erp-files/'+row.storage_key)?.body,PNG);assert.equal(bucket.objects.get('/erp-files/'+row.storage_key)?.type,'image/png');
    const img=await call('m1','GET',`/rma/${c.id}/photos/${ph.json().id}`);assert.equal(img.statusCode,200);assert.deepEqual(img.rawPayload,PNG);assert.equal(img.headers['content-type'],'image/png');
    assert.equal((await call('m2','GET',`/rma/${c.id}/photos/${ph.json().id}`)).statusCode,403,'permission checks unchanged');
    // task attachment
    const t=(await call('m1','POST','/tasks',{title:'Prepare report',description:'Internal fictional fixture',ownerId:'m2',criteria:['done'],dueAt:'2026-12-01T00:00:00Z'})).json();
    const at=await call('m2','POST',`/tasks/${t.id}/attachments`,{name:'result.txt',mime:'text/plain',dataBase64:Buffer.from('hello bucket').toString('base64')});assert.equal(at.statusCode,201,at.body);
    assert.equal((await db.query('SELECT data FROM task_attachments WHERE id=$1',[at.json().id])).rows[0].data,null);
    const dl=await call('m2','GET',`/tasks/${t.id}/attachments/${at.json().id}`);assert.equal(dl.body,'hello bucket');assert.equal(dl.headers['x-content-type-options'],'nosniff');
    assert.match(String(dl.headers['content-security-policy']),/sandbox/,'security headers unchanged');
    assert.equal((await call('m4','GET',`/tasks/${t.id}/attachments/${at.json().id}`)).statusCode,404);
    // feedback screenshot
    const fb=await call('m3','POST','/feedback',{body:'按钮没反应',images:[{name:'shot.png',type:'image/png',data:PNG.toString('base64')}]});assert.equal(fb.statusCode,201,fb.body);
    const images=(await db.query('SELECT images FROM feedback WHERE id=$1',[fb.json().id])).rows[0].images;
    assert.equal(images[0].data,undefined);assert.match(images[0].key,/\/feedback\//);assert.equal(images[0].size,PNG.length);
    assert.equal((await call('m1','GET','/feedback')).json().items[0].image_count,1);
    const fi=await call('m1','GET',`/feedback/${fb.json().id}/images/0`);assert.deepEqual(fi.rawPayload,PNG);
    assert.ok(bucket.log.length>=6&&bucket.log.every(l=>l.signed),'every bucket request carried a valid signature');
  }finally{await app.close();await bucket.close();}
});

test('object storage: files stored in the database before the switch stay readable',async()=>{
  const bucket=await fakeBucket(),before=await setup({mode:"db",store:null},false);
  const t=(await before.call('m1','POST','/tasks',{title:'Old task',description:'Internal fictional fixture',ownerId:'m2',criteria:['done'],dueAt:'2026-12-01T00:00:00Z'})).json();
  const at=(await before.call('m2','POST',`/tasks/${t.id}/attachments`,{name:'old.txt',mime:'text/plain',dataBase64:Buffer.from('from the database').toString('base64')})).json();
  const fb=(await before.call('m3','POST','/feedback',{body:'old',images:[{name:'a.png',type:'image/png',data:PNG.toString('base64')}]})).json();
  assert.equal((await before.db.query('SELECT storage_key FROM task_attachments WHERE id=$1',[at.id])).rows[0].storage_key,null);
  await before.app.close();
  const app=await buildApp({db:before.db,files:{mode:'s3',store:bucket.store},integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
  const token=(await issueSession(before.db,'m2')).accessToken,admin=(await issueSession(before.db,'m1')).accessToken;
  try{
    assert.equal((await app.inject({method:'GET',url:`/tasks/${t.id}/attachments/${at.id}`,headers:{authorization:'Bearer '+token}})).body,'from the database');
    assert.deepEqual((await app.inject({method:'GET',url:`/feedback/${fb.id}/images/0`,headers:{authorization:'Bearer '+admin}})).rawPayload,PNG);
    assert.equal(bucket.log.length,0,'old rows never touch the bucket');
  }finally{await app.close();await bucket.close();}
});

test('object storage failures: uploads answer 503 and save nothing; missing settings for bucket rows answer 503',async()=>{
  const bucket=await fakeBucket(),{db,app,call}=await setup({mode:"s3",store:bucket.store},false);
  try{
    const t=(await call('m1','POST','/tasks',{title:'Prepare report',description:'Internal fictional fixture',ownerId:'m2',criteria:['done'],dueAt:'2026-12-01T00:00:00Z'})).json();
    const ok=(await call('m2','POST',`/tasks/${t.id}/attachments`,{name:'a.txt',mime:'text/plain',dataBase64:Buffer.from('a').toString('base64')})).json();
    bucket.state.fail=true;
    const r=await call('m2','POST',`/tasks/${t.id}/attachments`,{name:'b.txt',mime:'text/plain',dataBase64:Buffer.from('b').toString('base64')});
    assert.equal(r.statusCode,503);assert.equal(r.json().error.code,'FILE_STORAGE_UNAVAILABLE');assert.match(r.json().error.message,/文件存储暂时不可用/);
    assert.equal((await db.query('SELECT count(*)::int n FROM task_attachments WHERE task_id=$1',[t.id])).rows[0].n,1,'no row without its file');
    const fb=await call('m3','POST','/feedback',{body:'x',images:[{name:'a.png',type:'image/png',data:PNG.toString('base64')}]});assert.equal(fb.statusCode,503);
    assert.equal((await db.query('SELECT count(*)::int n FROM feedback')).rows[0].n,0);
    assert.equal((await call('m2','GET',`/tasks/${t.id}/attachments/${ok.id}`)).statusCode,503,'download while the bucket is down');
    bucket.state.fail=false;bucket.objects.clear();
    assert.equal((await call('m2','GET',`/tasks/${t.id}/attachments/${ok.id}`)).statusCode,404,'object gone from the bucket');
  }finally{await app.close();await bucket.close();}
  // A database whose rows point at a bucket, started without bucket settings, answers 503 rather than crashing.
  const app2=await buildApp({db,files:{mode:'db',store:null},integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
  try{
    const row=(await db.query('SELECT id,task_id FROM task_attachments LIMIT 1')).rows[0];
    const res=await app2.inject({method:'GET',url:`/tasks/${row.task_id}/attachments/${row.id}`,headers:{authorization:'Bearer '+(await issueSession(db,'m2')).accessToken}});
    assert.equal(res.statusCode,503);
  }finally{await app2.close();}
});
