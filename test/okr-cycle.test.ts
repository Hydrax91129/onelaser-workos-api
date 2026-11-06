import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {cycleDates} from '../src/okr-cycle.js';

test('cycle dates: set up from the 25th before, self-score 25th–30th, leader 30th–3rd',()=>{
 assert.deepEqual(cycleDates('2026-11'),{period:'2026-11',setupFrom:'2026-10-25',setupUntil:'2026-11-05',selfFrom:'2026-11-25',selfUntil:'2026-11-30',leadFrom:'2026-11-30',leadUntil:'2026-12-03'});
 assert.equal(cycleDates('2027-02').selfUntil,'2027-02-28');
});

test('daily reminders, automatic 0 self score after the deadline, leader reminders; every KR becomes a locked task',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const clock={t:Date.parse('2026-10-26T18:00:00Z')};
 const app=await buildApp({db,integrations:{executiveUserIds:['m4']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  // setup reminder (uses the real clock in the app; run against period of "next month" relative to now)
  const cyc=(await call('m2','GET','/okr/cycle?period=2026-11')).json();assert.equal(cyc.selfUntil,'2026-11-30');
  // KR → task for the owner, definition locked for the owner
  const o=(await call('m2','POST','/objectives',{title:'Hydra 产品页转化率提升',level:'personal',planning:{period:'2026-11',weight:100,scoringDueDate:'2026-12-03'}})).json();
  const kr=(await call('m2','POST',`/objectives/${o.id}/key-results`,{title:'转化率到 3%',baseline:0,target:3,direction:'increase',unit:'%',planning:{weight:100,targetText:'3%'}})).json();
  assert.ok(!(await call('m2','GET','/task-board')).json().items.some((t:any)=>t.kr_id===kr.id),'drafts do not create tasks');
  assert.equal((await call('m2','POST','/okr/publish',{period:'2026-11'})).statusCode,201);
  const task=(await call('m2','GET','/task-board')).json().items.find((t:any)=>t.kr_id===kr.id);
  assert.ok(task,'own KR becomes a task once the OKR is published');assert.equal(task.source_kind,'okr');assert.equal(task.owner_id,'m2');assert.notEqual(task.reviewer_id,'m2');
  const locked=await call('m2','POST',`/tasks/${task.id}/board`,{expectedVersion:task.version,title:'改个名字吧'});assert.equal(locked.statusCode,403);assert.equal(locked.json().error.code,'TASK_DEFINITION_LOCKED');
  assert.equal((await call('m2','POST',`/tasks/${task.id}/board`,{expectedVersion:task.version,status:'working'})).statusCode,200,'status updates are still allowed');
 }finally{await app.close();}
});

test('the cycle job reminds, auto-scores missing self scores as 0, then reminds leaders',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const clock={t:Date.parse('2026-10-26T18:00:00Z')};
 const app=await buildApp({db,integrations:{executiveUserIds:['m4']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock:()=>clock.t});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  let r=(await call('m4','POST','/okr/cycle/run')).json();assert.ok(r.setup>=5,'everyone without November OKR is reminded');
  assert.equal((await call('m4','POST','/okr/cycle/run')).json().setup,0,'once a day');
  assert.ok((await call('m2','GET','/nudges')).json().items.some((n:any)=>n.kind==='okr_setup'&&n.okr));
  const o=(await call('m2','POST','/objectives',{title:'转化率提升',level:'personal',planning:{period:'2026-11',weight:100,scoringDueDate:'2026-12-03'}})).json();
  const kr=(await call('m2','POST',`/objectives/${o.id}/key-results`,{title:'转化率到 3%',baseline:0,target:3,direction:'increase',unit:'%',planning:{weight:100}})).json();
  clock.t=Date.parse('2026-11-26T18:00:00Z');r=(await call('m4','POST','/okr/cycle/run')).json();assert.ok(r.self>=1,'self-score reminder');
  clock.t=Date.parse('2026-12-01T18:00:00Z');r=(await call('m4','POST','/okr/cycle/run')).json();assert.ok(r.autoZero>=1);assert.ok(r.lead>=1,'leader reminded');
  const row=(await call('m2','GET','/key-results')).json().items.find((k:any)=>k.id===kr.id);assert.equal(row.scores.self.score,0);assert.match(row.scores.self.comment,/系统按 0 分/);
  assert.ok((await call('m1','GET','/nudges')).json().items.some((n:any)=>n.kind==='okr_lead'),'m2’s department manager is reminded');
 }finally{await app.close();}
});

test('status rules: first update starts a task, past due becomes Overdue (not when paused), 15 days silent = Abandoned',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m4']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  const mk=async(title:string)=>(await call('m1','POST','/tasks/assign',{assigneeId:'m2',title,dueAt:new Date(Date.now()+3*864e5).toISOString(),description:'说明说明说明说明说明',criteria:['完成']})).json();
  const a=await mk('任务甲'),b=await mk('任务乙'),c=await mk('任务丙'),d=await mk('任务丁');
  const status=async(id:string)=>(await call('m2','GET','/task-board')).json().items.find((t:any)=>t.id===id).board_status;
  assert.equal(await status(a.id),'not_started');
  await call('m2','POST',`/tasks/${a.id}/updates`,{requestId:crypto.randomUUID(),body:'开始做了'});assert.equal(await status(a.id),'working');
  const bv=(await call('m2','GET','/task-board')).json().items.find((t:any)=>t.id===b.id).version;
  assert.equal((await call('m2','POST',`/tasks/${b.id}/board`,{expectedVersion:bv,status:'hold'})).statusCode,200);
  await db.query("UPDATE tasks SET due_at=now()-interval '1 day' WHERE id=ANY($1::text[])",[[a.id,b.id]]);
  assert.equal(await status(a.id),'overdue');assert.equal(await status(b.id),'hold','paused tasks never turn overdue');
  await db.query("UPDATE tasks SET created_at=now()-interval '16 days' WHERE id=$1",[c.id]);assert.equal(await status(c.id),'abandoned');
  const cfg=(await call('m2','GET','/task-board')).json().config.status.map((x:any)=>x.zh);
  for(const z of ['未开始','进行中','被暂停','待审批','完成','延期','放弃'])assert.ok(cfg.includes(z),z);
  const dv=(await call('m2','GET','/task-board')).json().items.find((t:any)=>t.id===d.id).version;
  assert.equal((await call('m2','POST',`/tasks/${d.id}/board`,{expectedVersion:dv,dueAt:new Date(Date.now()+30*864e5).toISOString()})).statusCode,403,'assignees cannot move the due date');
 }finally{await app.close();}
});

test('一键催办: a leader reminds the people in their scope who are behind; once per person, stage and day',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 // m1 leads m2 and m3 (reporting lines); m2 has published November, m3 has not.
 await db.query("UPDATE users SET manager_id='m1' WHERE id IN ('m2','m3')");
 await db.query("INSERT INTO okr_publications(org_id,owner_id,period,published_by) SELECT org_id,'m2','2026-11','m2' FROM users WHERE id='m2'");
 const app=await buildApp({db,integrations:{executiveUserIds:['m4']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock:()=>Date.parse('2026-11-06T18:00:00Z')});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  const list=(await call('m1','GET','/okr/nudge?period=2026-11')).json();
  assert.deepEqual(list.items.map((x:any)=>[x.userId,x.stage,x.overdue]),[['m3','setup',true]],'only the person who has not published, marked overdue after the 5th');
  assert.equal(list.items[0].deadline,'11/05');
  assert.deepEqual((await call('m3','GET','/okr/nudge?period=2026-11')).json().items,[],'people without reports nudge nobody');
  assert.deepEqual((await call('m1','POST','/okr/nudge',{period:'2026-11'})).json(),{period:'2026-11',sent:1,already:0});
  const n=(await db.query("SELECT user_id,kind,message FROM task_nudges WHERE kind='okr_manual'")).rows;
  assert.equal(n.length,1);assert.equal(n[0].user_id,'m3');assert.match(n[0].message,/催办.*11月 OKR.*已逾期/);
  assert.deepEqual((await call('m1','POST','/okr/nudge',{period:'2026-11'})).json(),{period:'2026-11',sent:0,already:1},'a second click the same day sends nothing');
  assert.deepEqual((await call('m1','POST','/okr/nudge',{period:'2026-11',userIds:['m2']})).json(),{period:'2026-11',sent:0,already:0},'only people who are behind can be nudged');
 }finally{await app.close();}
});
