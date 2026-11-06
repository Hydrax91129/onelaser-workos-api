import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {REVIEW_TIMEOUT_MS} from '../src/completions.js';

// One path to "done" for work someone else gave you: submit a version; the reviewer accepts it (any role),
// or after 3 days with no decision it is accepted automatically and the AI scores it.
async function setup(){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const model={model:'fake-scorer',json:async()=>({score:7.5,summary:'synthetic summary'})};
 const app=await buildApp({db,integrations:{executiveUserIds:['m4']},completionModel:model as any,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 return {db,app,call};
}
const due=(days:number)=>new Date(Date.now()+days*864e5).toISOString();
const submit=async(call:any,who:string,id:string,description='Synthetic deliverable with a link to the fictional result.')=>{const v=(await call(who,'GET',`/tasks/${id}`)).json().version;const r=await call(who,'POST',`/tasks/${id}/submissions`,{expectedVersion:v,description});assert.equal(r.statusCode,201,r.body);return r.json();};

test('a task someone else gave you cannot be marked done directly; owner and reviewer must use review',async()=>{
 const {app,call}=await setup();
 try{
  const t=(await call('m1','POST','/tasks',{title:'Given task',description:'Fictional fixture',ownerId:'m2',criteria:['Evidence'],dueAt:due(5)})).json();
  for(const who of ['m2','m1']){const r=await call(who,'POST',`/tasks/${t.id}/complete`,{expectedVersion:t.version,result:'Tried to mark it done directly.'});assert.equal(r.statusCode,409,r.body);assert.equal(r.json().error.code,'REVIEW_REQUIRED');}
  // Your own task still completes directly.
  const own=(await call('m2','POST','/tasks',{title:'My own task',ownerId:'m2',dueAt:due(5)})).json();
  const r=await call('m2','POST',`/tasks/${own.id}/complete`,{expectedVersion:own.version,result:'Finished my own fictional task.'});assert.equal(r.statusCode,201,r.body);
 }finally{await app.close();}
});

test('an employee who assigned the task reviews it; accepting makes it done and counts with the review score',async()=>{
 const {app,call}=await setup();
 try{
  const a=await call('m3','POST','/tasks/assign',{assigneeId:'m2',title:'Fictional price sheet',dueAt:due(5),description:'Collect fictional prices',criteria:['Three brands']});assert.equal(a.statusCode,201,a.body);
  const id=a.json().id??a.json().task?.id;
  const task=(await call('m2','GET',`/tasks/${id}`)).json();assert.equal(task.reviewer_id,'m3');
  await submit(call,'m2',id);
  const cur=(await call('m3','GET',`/tasks/${id}`)).json();
  const rv=await call('m3','POST',`/tasks/${id}/reviews`,{expectedVersion:cur.version,submissionVersion:cur.submission_version,decision:'accept',quality:9,note:'Checked the fictional sheet',verifiedCurrentSubmission:true});assert.equal(rv.statusCode,201,rv.body);
  const after=(await call('m2','GET',`/tasks/${id}`)).json();assert.equal(after.status,'accepted');assert.equal(after.board_status,'done');
  const me=(await call('m2','GET','/reports/leaderboard')).json().items.find((x:any)=>x.id==='m2');assert.ok(me.done>=1);assert.equal(me.avg_score,9);
  // The owner can never review their own work.
  const b=(await call('m3','POST','/tasks/assign',{assigneeId:'m2',title:'Second fictional sheet',dueAt:due(5),description:'More fictional prices',criteria:['One brand']})).json();
  const bid=b.id??b.task?.id;await submit(call,'m2',bid);const bc=(await call('m2','GET',`/tasks/${bid}`)).json();
  assert.equal((await call('m2','POST',`/tasks/${bid}/reviews`,{expectedVersion:bc.version,submissionVersion:bc.submission_version,decision:'accept',quality:10,note:'Self review attempt',verifiedCurrentSubmission:true})).statusCode,403);
 }finally{await app.close();}
});

test('with no decision for 3 days the current version is accepted automatically, the AI scores it and followers are told',async()=>{
 const {db,app,call}=await setup();
 try{
  const t=(await call('m1','POST','/tasks',{title:'Waiting task',description:'Fictional fixture',ownerId:'m2',criteria:['Evidence'],dueAt:due(5)})).json();
  const fresh=(await call('m1','POST','/tasks',{title:'Fresh task',description:'Fictional fixture',ownerId:'m2',criteria:['Evidence'],dueAt:due(5)})).json();
  await submit(call,'m2',t.id);await submit(call,'m2',fresh.id);
  await db.query(`UPDATE submissions SET created_at=now()-($2::bigint*interval '1 millisecond')-interval '1 minute' WHERE task_id=$1`,[t.id,REVIEW_TIMEOUT_MS]);
  const run=await call('m4','POST','/completions/auto-score/run',{});assert.equal(run.statusCode,200,run.body);
  const done=(await call('m2','GET',`/tasks/${t.id}`)).json();assert.equal(done.status,'accepted');assert.equal(done.board_status,'done');
  const c=(await call('m2','GET',`/tasks/${t.id}/completion`)).json().completion;
  assert.ok(c.auto_accepted_at);assert.equal(c.score_source,'ai');assert.equal(Number(c.final_score),7.5);assert.match(c.result,/Synthetic deliverable/);
  assert.equal((await call('m2','GET',`/tasks/${fresh.id}`)).json().status,'submitted','a version younger than 3 days keeps waiting');
  for(const who of ['m2','m1'])assert.ok((await call(who,'GET','/inbox')).json().items.some((i:any)=>i.taskId===t.id&&i.kind==='auto_accept'),who+' is told');
  // Running again changes nothing.
  await call('m4','POST','/completions/auto-score/run',{});
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM task_completions WHERE task_id=$1`,[t.id])).rows[0].n,1);
 }finally{await app.close();}
});
