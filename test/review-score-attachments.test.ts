import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { buildApp, submissionFiles } from '../src/app.js';
import { createDatabase, schema, seedDemo, type Database } from '../src/db.js';

let db:Database;
let app:Awaited<ReturnType<typeof buildApp>>;
const secret=randomBytes(32).toString('hex');
const tokens:Record<string,string>={};
before(async()=>{
  db=await createDatabase();await db.exec(schema);await seedDemo(db);
  app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret});
  for(const userId of ['m1','m2','m3']){
    const res=await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId,secret}});
    assert.equal(res.statusCode,200,res.body);tokens[userId]=res.json().accessToken;
  }
});
after(async()=>{await app.close();});
const call=(userId:string,method:'GET'|'POST',url:string,payload?:Record<string,any>)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[userId]}});
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
async function newTask(){
  const res=await call('m1','POST','/tasks',{title:'Score and attachment task',description:'Synthetic task for score and attachment tests',ownerId:'m2',criteria:['Factory confirmation'],dueAt:'2026-11-20T18:00:00+08:00'});
  assert.equal(res.statusCode,201,res.body);return res.json();
}
async function upload(taskId:string,userId:string,name:string){
  const res=await call(userId,'POST',`/tasks/${taskId}/attachments`,{name,mime:'image/png',dataBase64:PNG});
  assert.equal(res.statusCode,201,res.body);return res.json();
}

test('human quality score accepts 0-10 only',async()=>{
  const task=await newTask();
  const s=await call('m2','POST',`/tasks/${task.id}/submissions`,{expectedVersion:task.version,description:'Order placed with the factory'});
  assert.equal(s.statusCode,201,s.body);
  const base={expectedVersion:s.json().taskVersion,submissionVersion:1,decision:'accept',note:'Checked the factory confirmation.',verifiedCurrentSubmission:true};
  assert.equal((await call('m1','POST',`/tasks/${task.id}/reviews`,{...base,quality:11})).statusCode,400);
  assert.equal((await call('m1','POST',`/tasks/${task.id}/reviews`,{...base,quality:85})).statusCode,400);
  const ok=await call('m1','POST',`/tasks/${task.id}/reviews`,{...base,quality:10});
  assert.equal(ok.statusCode,201,ok.body);assert.equal(ok.json().review.quality,10);assert.equal(ok.json().review.quality_scale,10);
});

test('a submission carries its uploaded files and the detail lists them',async()=>{
  const task=await newTask(),a=await upload(task.id,'m2','截图-1.png'),b=await upload(task.id,'m2','截图-2.png');
  const s=await call('m2','POST',`/tasks/${task.id}/submissions`,{expectedVersion:task.version,description:'Order placed with the factory',attachmentIds:[a.id,b.id]});
  assert.equal(s.statusCode,201,s.body);
  const detail=(await call('m1','GET',`/tasks/${task.id}`)).json();
  assert.deepEqual(detail.submissions[0].attachments.map((f:any)=>f.name),['截图-1.png','截图-2.png']);
  assert.equal(detail.submissions[0].attachments[0].data,undefined,'file bytes are not inlined in the detail');
  const img=await call('m1','GET',`/tasks/${task.id}/attachments/${a.id}`);
  assert.equal(img.statusCode,200);assert.equal(img.headers['content-type'],'image/png');
});

test('a submission cannot claim files uploaded by someone else or to another task',async()=>{
  const task=await newTask(),other=await newTask(),theirs=await upload(task.id,'m1','manager.png'),elsewhere=await upload(other.id,'m2','other.png');
  for(const id of [theirs.id,elsewhere.id]){
    const res=await call('m2','POST',`/tasks/${task.id}/submissions`,{expectedVersion:task.version,description:'Order placed with the factory',attachmentIds:[id]});
    assert.equal(res.statusCode,400,res.body);assert.equal(res.json().error.code,'INVALID_ATTACHMENT');
  }
});

test('older submissions that only named their files in the text are matched to the uploads',()=>{
  const t0='2026-11-03T01:12:00Z',files=[
    {id:'f1',name:'截图-20261103-171311.png',uploader_id:'u1',created_at:t0},
    {id:'f2',name:'later.png',uploader_id:'u1',created_at:'2026-11-03T02:00:00Z'},
    {id:'f3',name:'spec.pdf',uploader_id:'u2',created_at:t0},
  ];
  const legacy={submitted_by:'u1',created_at:'2026-11-03T01:13:00Z',attachment_ids:[],description:'已完成下单给PMC。\n\n附件：截图-20261103-171311.png、later.png、spec.pdf'};
  assert.deepEqual(submissionFiles(legacy,files).map((f:any)=>f.id),['f1'],'only files the submitter uploaded before submitting');
  assert.deepEqual(submissionFiles({...legacy,description:'no files'},files),[]);
  assert.deepEqual(submissionFiles({...legacy,description:'Done\n\nAttachments: later.png',created_at:'2026-11-03T03:00:00Z'},files).map((f:any)=>f.id),['f2']);
  assert.deepEqual(submissionFiles({...legacy,attachment_ids:['f3','f1']},files).map((f:any)=>f.id),['f3','f1'],'explicit ids win');
});

test('existing 0-100 scores convert once to 0-10, rounding half up, and keep the original',async()=>{
  const legacy=await createDatabase();await legacy.exec(schema);await seedDemo(legacy);
  // Recreate the pre-migration state: the old 0-100 rule and rows written before the switch.
  await legacy.exec(`ALTER TABLE reviews DROP CONSTRAINT reviews_quality_0_10; ALTER TABLE reviews ADD CONSTRAINT reviews_quality_check CHECK(quality BETWEEN 0 AND 100);
    ALTER TABLE reviews DROP COLUMN quality_scale; ALTER TABLE reviews DROP COLUMN quality_legacy_100;`);
  await legacy.query("INSERT INTO submissions(id,task_id,version,submitted_by,title,description) VALUES('s1','t1',1,'m2','e','evidence')");
  const scores:[string,number|null,string][]=[['r100',100,'accept'],['r85',85,'accept'],['r84',84,'accept'],['r45',45,'accept'],['r5',5,'accept'],['r4',4,'accept'],['r0',0,'accept'],['rnull',null,'return']];
  for(const [id,q,d] of scores) await legacy.query("INSERT INTO reviews(id,task_id,submission_version,reviewer_id,decision,quality,note) VALUES($1,'t1',1,'m1',$2,$3,'legacy review')",[id,d,q]);
  await legacy.exec(schema);await legacy.exec(schema);
  const rows=Object.fromEntries((await legacy.query('SELECT id,quality,quality_legacy_100,quality_scale FROM reviews')).rows.map((r:any)=>[r.id,r]));
  assert.deepEqual(scores.map(([id])=>rows[id].quality),[10,9,8,5,1,0,0,null]);
  assert.deepEqual(scores.map(([id])=>rows[id].quality_legacy_100),scores.map(([,q])=>q));
  assert.ok(scores.every(([id])=>rows[id].quality_scale===10));
  await assert.rejects(legacy.query("INSERT INTO reviews(id,task_id,submission_version,reviewer_id,decision,quality,note) VALUES('bad','t1',1,'m1','accept',11,'too high')"));
  await legacy.query("INSERT INTO reviews(id,task_id,submission_version,reviewer_id,decision,quality,note) VALUES('new','t1',1,'m1','accept',7,'new scale')");
  await legacy.exec(schema);
  const fresh=(await legacy.query("SELECT quality,quality_scale FROM reviews WHERE id='new'")).rows[0];
  assert.deepEqual([fresh.quality,fresh.quality_scale],[7,10],'rows written on the new scale are never converted again');
  await legacy.close();
});
