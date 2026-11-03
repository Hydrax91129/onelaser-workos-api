import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { createDatabase, schema, seedDemo, type Database } from '../src/db.js';
import { krProgress } from '../src/domain.js';
import { languageFrom } from '../src/i18n.js';

let db:Database;
let admin:Database|undefined;
let isolatedSchema:string|undefined;
let app:Awaited<ReturnType<typeof buildApp>>;
const secret=randomBytes(32).toString('hex');
const tokens:Record<string,string>={};
before(async()=>{
  if(process.env.TEST_DATABASE_URL){
    // Never migrate or seed an arbitrary existing schema supplied by a caller.
    isolatedSchema='workos_test_'+randomUUID().replaceAll('-','');
    admin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});
    await admin.exec(`CREATE SCHEMA ${isolatedSchema}`);
    const url=new URL(process.env.TEST_DATABASE_URL);
    url.searchParams.set('options',`-c search_path=${isolatedSchema}`);
    db=await createDatabase({connectionString:url.toString()});
  }else db=await createDatabase();
  await db.exec(schema);await seedDemo(db);
  app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret});
  for(const userId of ['m1','m2','m3','m4','m5','m6']){
    const res=await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId,secret}});
    assert.equal(res.statusCode,200,res.body);tokens[userId]=res.json().accessToken;
  }
});
after(async()=>{
  if(app)await app.close();else if(db)await db.close();
  if(admin&&isolatedSchema){await admin.exec(`DROP SCHEMA ${isolatedSchema} CASCADE`);await admin.close();}
});
const call=(userId:string,method:'GET'|'POST'|'DELETE',url:string,payload?:Record<string,any>,language?:string)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[userId],...(language?{'accept-language':language}:{})}});
async function newTask(ownerId='m2',krId='kr2'){
  const res=await call('m1','POST','/tasks',{title:'API integration task',description:'Synthetic task for API integration tests',ownerId,criteria:['Provide evidence'],dueAt:'2026-11-01T18:00:00+08:00',krId});
  assert.equal(res.statusCode,201,res.body);return res.json();
}
async function submit(id:string,expectedVersion:number,userId='m2'){
  const res=await call(userId,'POST',`/tasks/${id}/submissions`,{expectedVersion,title:'Evidence record',description:'A synthetic evidence record that requires actual human verification.'});
  assert.equal(res.statusCode,201,res.body);return res.json();
}
async function accept(id:string,expectedVersion:number,submissionVersion:number){
  const res=await call('m1','POST',`/tasks/${id}/reviews`,{expectedVersion,submissionVersion,decision:'accept',quality:9,note:'Evidence was manually checked in this synthetic test.',verifiedCurrentSubmission:true});
  assert.equal(res.statusCode,201,res.body);return res.json();
}

test('health and capabilities do not claim production integrations',async()=>{
  const health=await app.inject('/health');assert.equal(health.statusCode,200);assert.equal(health.json().productionReady,false);
  const c=(await app.inject('/capabilities')).json();assert.equal(c.aiReview,'not_integrated');assert.equal(c.frontendConnected,false);
});
test('unauthenticated and forged tokens are rejected; error language changes without changing code',async()=>{
  const zh=await app.inject('/tasks');const en=await app.inject({url:'/tasks',headers:{'accept-language':'en-US,en;q=0.9'}});
  assert.equal(zh.statusCode,401);assert.equal(en.statusCode,401);
  assert.equal(zh.json().error.code,en.json().error.code);assert.match(zh.json().error.message,/登录/);assert.match(en.json().error.message,/Authentication/);
  const forged=await app.inject({url:'/tasks',headers:{authorization:'Bearer '+randomBytes(32).toString('base64url')}});assert.equal(forged.statusCode,401);
});
test('server derives scope from session; employees cannot enumerate other employees or departments',async()=>{
  const list=await call('m2','GET','/tasks');assert.ok(list.json().items.every((t:any)=>t.owner_id==='m2'));
  assert.equal((await call('m2','GET','/tasks/t2')).statusCode,404);
  assert.equal((await call('m1','GET','/tasks/t3')).statusCode,404);
  assert.equal((await call('m4','GET','/tasks/t1')).statusCode,404);
});
test('employee cannot assign tasks to another member, or spoof role fields',async()=>{
  const input={title:'New synthetic task',description:'Acceptance scope',ownerId:'m3',criteria:['Evidence'],dueAt:'2026-11-01T18:00:00+08:00'};
  assert.equal((await call('m2','POST','/tasks',input)).statusCode,403);
  const bad=await call('m2','POST','/tasks',{...input,ownerId:'m2',role:'manager'},'zh');assert.equal(bad.statusCode,400);
  assert.equal(bad.json().error.code,'VALIDATION_ERROR');assert.match(bad.json().error.message,/请求/);assert.match(bad.json().error.fields[0].message,/输入/);
  const badEn=await call('m2','POST','/tasks',{...input,ownerId:'m2',role:'manager'},'en');assert.match(badEn.json().error.fields[0].message,/Invalid/);
});
test('personal KR access is scoped and owner must be able to see a linked KR',async()=>{
  const krs=(await call('m2','GET','/key-results')).json().items;assert.ok(!krs.some((k:any)=>k.id==='kr3'));
  const result=await call('m1','POST','/tasks',{title:'Invalid KR test',description:'Synthetic task',ownerId:'m2',criteria:['Evidence'],dueAt:'2026-11-01T18:00:00+08:00',krId:'kr3'});assert.equal(result.statusCode,400);
});
test('only owner can submit; evidence URL is metadata and credentials/non-HTTPS are rejected',async()=>{
  const task=await newTask();
  const payload={expectedVersion:task.version,title:'Evidence record',description:'Synthetic test description with enough detail to pass'};
  assert.equal((await call('m1','POST',`/tasks/${task.id}/submissions`,payload)).statusCode,403);
  for(const evidenceUrl of ['http://example.com','https://user:secret@example.com'])assert.equal((await call('m2','POST',`/tasks/${task.id}/submissions`,{...payload,evidenceUrl})).statusCode,400);
});
test('human review requires explicit verification and numeric quality; employees cannot approve',async()=>{
  const task=await newTask(),s=await submit(task.id,task.version);
  const payload={expectedVersion:s.taskVersion,submissionVersion:1,decision:'accept',quality:9,note:'Manual verification required'};
  assert.equal((await call('m1','POST',`/tasks/${task.id}/reviews`,payload)).statusCode,400);
  assert.equal((await call('m2','POST',`/tasks/${task.id}/reviews`,{...payload,verifiedCurrentSubmission:true})).statusCode,403);
  assert.equal((await call('m4','POST',`/tasks/${task.id}/reviews`,{...payload,verifiedCurrentSubmission:true})).statusCode,404);
});
test('task owner cannot self-review even when owner has manager role',async()=>{
  const task=await newTask(),s=await submit(task.id,task.version);
  // Simulate a migrated or reassigned manager-owned task; API creation rejects self-reviewer pairs.
  await db.query('UPDATE tasks SET owner_id=$2 WHERE id=$1',[task.id,'m1']);
  const res=await call('m1','POST',`/tasks/${task.id}/reviews`,{expectedVersion:s.taskVersion,submissionVersion:1,decision:'accept',quality:9,note:'Self review must be blocked',verifiedCurrentSubmission:true});
  assert.equal(res.statusCode,403);assert.equal(res.json().error.code,'SELF_REVIEW_FORBIDDEN');
});
test('new evidence invalidates current review, preserves history and rejects stale approvals',async()=>{
  const task=await newTask(),s1=await submit(task.id,task.version),r1=await accept(task.id,s1.taskVersion,1),s2=await submit(task.id,r1.taskVersion);
  const detail=(await call('m2','GET',`/tasks/${task.id}`)).json();
  assert.equal(detail.submission_version,2);assert.equal(detail.currentReview,null);assert.equal(detail.reviews.length,1);assert.equal(detail.submissions.length,2);
  const old=await call('m1','POST',`/tasks/${task.id}/reviews`,{expectedVersion:s2.taskVersion,submissionVersion:1,decision:'accept',quality:9,note:'Stale evidence should fail',verifiedCurrentSubmission:true});assert.equal(old.statusCode,409);
  await accept(task.id,s2.taskVersion,2);
  const final=(await call('m2','GET',`/tasks/${task.id}`)).json();assert.equal(final.status,'accepted');assert.equal(final.currentReview.submission_version,2);assert.equal(final.reviews.length,2);
});
test('concurrent submissions with the same expected version produce one success and one conflict',async()=>{
  const task=await newTask(),payload={expectedVersion:task.version,title:'Concurrent evidence',description:'A synthetic evidence payload for concurrency validation'};
  const res=await Promise.all([call('m2','POST',`/tasks/${task.id}/submissions`,payload),call('m2','POST',`/tasks/${task.id}/submissions`,payload)]);
  assert.deepEqual(res.map(r=>r.statusCode).sort(),[201,409]);
});
test('return decision needs no quality score and preserves review as a request for evidence',async()=>{
  const task=await newTask(),s=await submit(task.id,task.version);
  const res=await call('m1','POST',`/tasks/${task.id}/reviews`,{expectedVersion:s.taskVersion,submissionVersion:1,decision:'return',note:'Please provide the original source'});
  assert.equal(res.statusCode,201);assert.equal(res.json().review.quality,null);assert.equal((await call('m2','GET',`/tasks/${task.id}`)).json().status,'revision');
});
test('task acceptance does not change numeric KR actuals; explicit verified measurements do',async()=>{
  const before=(await call('m1','GET','/key-results')).json().items.find((k:any)=>k.id==='kr2');
  const task=await newTask(),s=await submit(task.id,task.version);await accept(task.id,s.taskVersion,1);
  const after=(await call('m1','GET','/key-results')).json().items.find((k:any)=>k.id==='kr2');assert.equal(after.actual,before.actual);assert.equal(after.version,before.version);
  assert.equal((await call('m2','POST','/key-results/kr2/measurements',{expectedVersion:before.version,actual:13,source:'CRM test record',note:'Synthetic metric evidence'})).statusCode,403);
  const update=await call('m1','POST','/key-results/kr2/measurements',{expectedVersion:before.version,actual:13,source:'CRM test record',note:'Synthetic metric evidence'});assert.equal(update.statusCode,201);assert.equal(update.json().actual,13);
});
test('audit and notification preview stay in scope; integrations explicitly fail without sending',async()=>{
  const audit=(await call('m2','GET','/audit')).json().items;assert.ok(audit.length>0);assert.ok(audit.every((e:any)=>e.owner_id==='m2'));
  const preview=(await call('m2','GET','/notifications/preview')).json();assert.equal(preview.sent,false);assert.ok(preview.items.every((t:any)=>t.owner_id==='m2'));
  const zh=await call('m2','POST','/tasks/t1/analyze',{},'zh'),en=await call('m2','POST','/tasks/t1/analyze',{},'en');assert.equal(zh.statusCode,501);assert.equal(en.statusCode,501);assert.equal(zh.json().error.code,en.json().error.code);assert.match(zh.json().error.message,/尚未接入/);assert.match(en.json().error.message,/not integrated/);
  assert.equal((await call('m2','POST','/notifications/send',{})).statusCode,403);assert.equal((await call('m1','POST','/notifications/send',{})).statusCode,501);
});
test('production always disables development login; missing secret rejects startup',async()=>{
  const prod=await buildApp({db,environment:'production',allowDevLogin:true,devLoginSecret:secret,closeDatabase:false});
  const res=await prod.inject({method:'POST',url:'/auth/dev-login',payload:{userId:'m2',secret}});assert.equal(res.statusCode,404);assert.equal(res.json().error.code,'DEV_LOGIN_DISABLED');await prod.close();
  await assert.rejects(()=>buildApp({db,allowDevLogin:true,devLoginSecret:'short'}));
});
test('account deactivation and explicit logout revoke access; no role claims are trusted',async()=>{
  await db.query('UPDATE users SET active=false WHERE id=$1',['m6']);assert.equal((await call('m6','GET','/me')).statusCode,401);
  assert.equal((await call('m5','DELETE','/auth/session')).statusCode,200);assert.equal((await call('m5','GET','/me')).statusCode,401);
});
test('unknown authenticated routes and body validation are bilingual with stable codes',async()=>{
  const zh=await call('m2','GET','/no-such-endpoint',undefined,'zh-CN'),en=await call('m2','GET','/no-such-endpoint',undefined,'en');
  assert.equal(zh.statusCode,404);assert.equal(zh.json().error.code,en.json().error.code);assert.match(zh.json().error.message,/接口/);assert.match(en.json().error.message,/Endpoint/);
  assert.equal(zh.headers['content-language'],'zh');assert.equal(en.headers['content-language'],'en');
});
test('metric boundary and language parsing handle invalid denominator and declared preference',()=>{
  assert.equal(krProgress({baseline:0,target:0,actual:10,direction:'increase'}),null);
  assert.equal(krProgress({baseline:100,target:50,actual:75,direction:'decrease'}),0.5);
  assert.equal(languageFrom('en;q=0,zh;q=1'),'zh');assert.equal(languageFrom('fr, en-GB;q=0.8, zh;q=0.5'),'en');
});
