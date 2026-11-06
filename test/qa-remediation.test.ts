import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

async function fixture(model:any=null){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,completionModel:model,integrations:{executiveUserIds:['m1']},closeDatabase:false});
 const tokens:Record<string,string>={};for(const id of ['m1','m2','m3','m4'])tokens[id]=(await issueSession(db,id)).accessToken;
 const call=(who:string,method:any,url:string,payload?:any)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});
 const create=async()=>{const r=await call('m2','POST','/tasks',{title:'Synthetic recoverable task',description:'Local QA evidence',ownerId:'m2',criteria:['Evidence'],dueAt:'2026-11-12T10:00:00Z'});assert.equal(r.statusCode,201,r.body);return r.json();};
 const finish=async(t:any)=>{const r=await call('m2','POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Delivered the fictional report with a link to the result and checked all acceptance criteria.',selfReview:'Synthetic result verified by this fixture.'});assert.equal(r.statusCode,201,r.body);return r.json();};
 const age=async(taskId:string)=>{await db.query("UPDATE task_completions SET created_at=now()-interval '25 hours' WHERE task_id=$1 AND superseded_at IS NULL",[taskId]);};
 return {db,app,call,create,finish,age,async close(){await app.close();await db.close();}};
}
const model={model:'fixture',json:async()=>({score:8.5,summary:'Synthetic scored result.'})};
test('late scoring recovery keeps the locked result and board completion date immutable',async()=>{
 const f=await fixture();try{
  const t=await f.create(),done=await f.finish(t);await f.age(t.id);const old='2026-01-01T00:00:00Z';await f.db.query('UPDATE tasks SET board_done_at=$2 WHERE id=$1',[t.id,old]);
  const missing=await f.call('m2','POST',`/tasks/${t.id}/completion/rescore`,{completionId:done.completion.id});assert.equal(missing.statusCode,503,missing.body);assert.equal(missing.json().error.code,'AI_NOT_CONFIGURED');
  await f.app.close();const restored=await buildApp({db:f.db,completionModel:model,closeDatabase:false});
  const tok=(await issueSession(f.db,'m2')).accessToken;
  const r=await restored.inject({method:'POST',url:`/tasks/${t.id}/completion/rescore`,headers:{authorization:'Bearer '+tok},payload:{completionId:done.completion.id}});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().completion.ai_status,'scored');
  const after=(await f.db.query('SELECT board_done_at,version FROM tasks WHERE id=$1',[t.id])).rows[0];assert.equal(new Date(after.board_done_at).getTime(),new Date(old).getTime());assert.equal(after.version,done.task.version);
  const ev=(await f.db.query("SELECT details FROM audit_events WHERE action='task.completion_score_retry'")).rows;assert.equal(ev.length,1);assert.equal(ev[0].details.completionId,done.completion.id);assert.ok(!JSON.stringify(ev).includes('fictional report'));
  await restored.close();
 }finally{await f.close();}
});
test('a visible colleague cannot trigger scoring; successful scores cannot be replaced',async()=>{
 let calls=0;const f=await fixture({...model,json:async()=>{calls++;return {score:8.5,summary:'Synthetic'};}});try{
  const t=await f.create(),done=await f.finish(t);await f.age(t.id);assert.equal((await f.call('m2','POST',`/tasks/${t.id}/completion/rescore`,{completionId:done.completion.id})).json().completion.score_source,'ai');
  await f.db.query("UPDATE users SET role='manager' WHERE id='m3'");assert.equal((await f.call('m3','POST',`/tasks/${t.id}/completion/rescore`,{})).statusCode,403);
  assert.equal((await f.call('m4','POST',`/tasks/${t.id}/completion/rescore`,{})).statusCode,404);
  const ok=await f.call('m1','POST',`/tasks/${t.id}/completion/rescore`,{completionId:done.completion.id});assert.equal(ok.statusCode,200,ok.body);assert.equal(calls,1);
 }finally{await f.close();}
});
test('profile rejects nonexistent IANA time zones and accepts known zones and unset',async()=>{const f=await fixture();try{for(const timezone of ['Mars/Base','Asia/Not_A_City','+08:00'])assert.equal((await f.call('m2','PATCH','/me/profile',{timezone})).statusCode,400);for(const timezone of ['Asia/Shanghai','America/Los_Angeles','UTC',''])assert.equal((await f.call('m2','PATCH','/me/profile',{timezone})).statusCode,200);}finally{await f.close();}});
test('task lists and board return the current submission acceptance timestamp, never a previous version',async()=>{const f=await fixture();try{
 const t=await f.create();const sub=await f.call('m2','POST',`/tasks/${t.id}/submissions`,{expectedVersion:t.version,title:'Fixture evidence',description:'Synthetic evidence verified in an isolated fixture.'});assert.equal(sub.statusCode,201,sub.body);
 const submitted=(await f.call('m2','GET',`/tasks/${t.id}`)).json();const review=await f.call('m1','POST',`/tasks/${t.id}/reviews`,{expectedVersion:submitted.version,submissionVersion:submitted.submission_version,decision:'accept',quality:8,note:'Inspected synthetic evidence',verifiedCurrentSubmission:true});assert.equal(review.statusCode,201,review.body);
 for(const endpoint of ['/tasks','/task-board']){const row=(await f.call('m2','GET',endpoint)).json().items.find((x:any)=>x.id===t.id);assert.ok(row.accepted_at,endpoint);}
 const after=(await f.call('m2','GET',`/tasks/${t.id}`)).json();await f.call('m2','POST',`/tasks/${t.id}/submissions`,{expectedVersion:after.version,title:'New fixture evidence',description:'A replacement synthetic submission invalidates the old acceptance.'});
 const row=(await f.call('m2','GET','/tasks')).json().items.find((x:any)=>x.id===t.id);assert.equal(row.accepted_at,null);
}finally{await f.close();}});

test('AI capabilities require the same complete, valid model configuration used by scoring',async()=>{
 const keys=['AI_PROVIDER_API_KEY','XAI_API_KEY','AI_SCORING_MODEL_ID','AI_MODEL_ID','AI_PROVIDER_BASE_URL'] as const;
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 try{
  for(const values of [{XAI_API_KEY:'fixture-key'},{AI_SCORING_MODEL_ID:'fixture-model'},{XAI_API_KEY:'fixture-key',AI_SCORING_MODEL_ID:'fixture-model',AI_PROVIDER_BASE_URL:'not a URL'},{XAI_API_KEY:'fixture-key',AI_SCORING_MODEL_ID:'fixture-model',AI_PROVIDER_BASE_URL:'http://unsafe.invalid'}]){
   for(const k of keys)delete process.env[k];Object.assign(process.env,values);
   const db=await createDatabase();await db.exec(schema);const app=await buildApp({db});try{const c=(await app.inject('/capabilities')).json();assert.equal(c.aiCompletionScore,false);assert.equal(c.aiInsights,false);}finally{await app.close();}
  }
  for(const k of keys)delete process.env[k];Object.assign(process.env,{XAI_API_KEY:'fixture-key',AI_SCORING_MODEL_ID:'fixture-model'});
  const db=await createDatabase();await db.exec(schema);const app=await buildApp({db});try{const c=(await app.inject('/capabilities')).json();assert.equal(c.aiCompletionScore,true);assert.equal(c.aiInsights,true);}finally{await app.close();}
 }finally{for(const k of keys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
});

test('a stale in-flight attempt can recover once; its late response cannot overwrite the recovered score',async()=>{
 let release:(()=>void)|undefined,calls=0;const f=await fixture({model:'fixture',json:async()=>{calls++;if(calls===1){await new Promise<void>(r=>release=r);return {score:1,summary:'old response'};}return {score:9,summary:'recovered result'};}});
 try{
  const t=await f.create(),done=await f.finish(t);await f.age(t.id);const first=f.call('m2','POST',`/tasks/${t.id}/completion/rescore`,{completionId:done.completion.id});
  for(let i=0;i<100&&!release;i++)await new Promise(r=>setTimeout(r,10));assert.ok(release);
  const active=await f.call('m2','POST',`/tasks/${t.id}/completion/rescore`,{completionId:done.completion.id});assert.equal(active.statusCode,202);assert.equal(calls,1);
  await f.db.query("UPDATE task_completions SET ai_attempted_at=now()-interval '3 minutes' WHERE id=$1",[done.completion.id]);
  const retries=await Promise.all([f.call('m2','POST',`/tasks/${t.id}/completion/rescore`,{completionId:done.completion.id}),f.call('m2','POST',`/tasks/${t.id}/completion/rescore`,{completionId:done.completion.id})]);assert.ok(retries.every(r=>r.statusCode===200||r.statusCode===202));assert.equal(calls,2);
  release!();await first;await new Promise(r=>setTimeout(r,30));
  const c=(await f.call('m2','GET',`/tasks/${t.id}/completion`)).json().completion;assert.equal(Number(c.ai_score),9);assert.equal(c.ai_summary,'recovered result');assert.equal(c.ai_attempts,2);
  const audits=(await f.db.query("SELECT id FROM audit_events WHERE action='task.completion_score_retry' AND object_id=$1",[t.id])).rows;assert.equal(audits.length,2,'the first attempt and the one recovery');
 }finally{release?.();await f.close();}
});

test('retry cannot target a superseded completion',async()=>{const f=await fixture();try{
 const t=await f.create(),first=await f.finish(t);const second=await f.finish(first.task);assert.notEqual(first.completion.id,second.completion.id);
 assert.equal((await f.call('m2','POST',`/tasks/${t.id}/completion/rescore`,{completionId:first.completion.id})).statusCode,409);
}finally{await f.close();}});

test('without a scoring model completions still count and wait: the job changes nothing and nothing is marked failed',async()=>{const f=await fixture();try{
 const t=await f.create(),done=await f.finish(t);assert.equal(done.completion.ai_status,'pending');await f.age(t.id);
 const run=await f.call('m1','POST','/completions/auto-score/run',{});assert.equal(run.statusCode,200,run.body);assert.equal(run.json().started,0);
 const c=(await f.call('m2','GET',`/tasks/${t.id}/completion`)).json();assert.equal(c.completion.ai_status,'pending');assert.equal(c.completion.ai_attempts,0);assert.equal(c.completion.final_score,null);
 assert.equal((await f.call('m2','POST','/completions/auto-score/run',{})).statusCode,403,'only administrators can run the job by hand');
 const lb=(await f.call('m2','GET','/reports/leaderboard')).json().items.find((x:any)=>x.id==='m2');assert.ok(lb.done>=1);
 assert.equal((await f.call('m1','GET',`/tasks/${t.id}/completion`)).json().canHumanScore,true,'a person can still score while the AI is unavailable');
}finally{await f.close();}});
test('an accepted evidence review with a quality score counts as the human score; the AI is not asked',async()=>{let calls=0;const f=await fixture({...model,json:async()=>{calls++;return {score:2,summary:'x'};}});try{
 const t=await f.create(),done=await f.finish(t);
 const sub=await f.call('m2','POST',`/tasks/${t.id}/submissions`,{expectedVersion:done.task.version,title:'Fixture evidence',description:'Synthetic evidence verified in an isolated fixture.'});assert.equal(sub.statusCode,201,sub.body);
 const cur=(await f.call('m2','GET',`/tasks/${t.id}`)).json();const rv=await f.call('m1','POST',`/tasks/${t.id}/reviews`,{expectedVersion:cur.version,submissionVersion:cur.submission_version,decision:'accept',quality:8,note:'Checked',verifiedCurrentSubmission:true});assert.equal(rv.statusCode,201,rv.body);
 await f.age(t.id);await f.call('m1','POST','/completions/auto-score/run',{});assert.equal(calls,0);
 const c=(await f.call('m2','GET',`/tasks/${t.id}/completion`)).json().completion;assert.equal(c.score_source,'human');assert.equal(Number(c.final_score),8);
}finally{await f.close();}});
