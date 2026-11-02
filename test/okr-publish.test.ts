import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { issueSession } from '../src/auth.js';

test('final publish: needs 100 points and 100% KRs, creates KR tasks, locks the owner, leaves the leader able to edit',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query("UPDATE users SET manager_id='m1' WHERE id='m2'");
 const app=await buildApp({db,integrations:{executiveUserIds:['m4']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const period=new Date().toISOString().slice(0,7),due=new Date(Date.now()+20*864e5).toISOString().slice(0,10);
 try{
  const o=(await call('m2','POST','/objectives',{title:'提升 Hydra 产品页转化率',level:'personal',planning:{period,weight:60,scoringDueDate:due}})).json();
  const kr=(title:string,weight:number,obj=o.id,who='m2')=>call(who,'POST',`/objectives/${obj}/key-results`,{title,baseline:0,target:1,direction:'increase',unit:'完成',planning:{weight,targetText:'完成'}});
  const k1=(await kr('转化率达到 3%',70)).json();
  let r=await call('m2','POST','/okr/publish',{period});assert.equal(r.statusCode,400);assert.equal(r.json().error.code,'OKR_NOT_READY');assert.match(r.json().error.message,/100 分/);assert.match(r.json().error.message,/70%/);
  await kr('产品页视频上线',30);
  const o2=(await call('m2','POST','/objectives',{title:'整理客户案例',level:'personal',planning:{period,weight:40,scoringDueDate:due}})).json();
  assert.equal((await call('m2','GET','/tasks')).json().items.filter((t:any)=>t.kr_id===k1.id).length,0,'no tasks before publishing');
  r=await call('m2','POST','/okr/publish',{period});assert.equal(r.statusCode,201,r.body);assert.equal(r.json().tasksCreated,2);
  assert.equal((await call('m2','POST','/okr/publish',{period})).statusCode,409,'only once');
  assert.ok((await call('m1','GET',`/okr/publications?period=${period}`)).json().items.some((p:any)=>p.ownerId==='m2'));
  // owner is locked out of the definition
  for(const [method,url,payload] of [['PATCH',`/objectives/${o.id}`,{expectedVersion:1,title:'改标题'}],['POST',`/objectives/${o2.id}/key-results`,{title:'新 KR',baseline:0,target:1,direction:'increase',unit:'完成',planning:{weight:100}}],['PATCH',`/key-results/${k1.id}`,{expectedMetaVersion:k1.meta_version||1,weight:50}],['POST','/objectives',{title:'第三个目标',level:'personal',planning:{period,weight:10,scoringDueDate:due}}],['POST',`/key-results/${k1.id}/archive`,{expectedMetaVersion:k1.meta_version||1}]] as const){
   const res=await call('m2',method as any,url,payload);assert.equal(res.statusCode,403,url);assert.equal(res.json().error.code,'OKR_PUBLISHED_LOCKED');assert.match(res.json().error.message,/领导/);
  }
  assert.equal((await call('m2','PATCH',`/key-results/${k1.id}`,{expectedMetaVersion:k1.meta_version||1,confidence:'at_risk'})).statusCode,200,'KR status stays open');
  // the leader can still change it, and the owner is told
  const lead=await call('m1','PATCH',`/key-results/${k1.id}`,{expectedMetaVersion:(k1.meta_version||1)+1,title:'转化率达到 3.5%'});assert.equal(lead.statusCode,200,lead.body);
  const added=await kr('领导补充的 KR',100,o2.id,'m1');assert.equal(added.statusCode,201,added.body);
  assert.ok((await call('m2','GET','/tasks')).json().items.some((t:any)=>t.kr_id===added.json().id),'a KR added after publishing becomes a task right away');
  await new Promise(res=>setTimeout(res,50));
  assert.ok((await call('m2','GET','/nudges')).json().items.some((n:any)=>n.kind==='okr_changed'),'owner is told about the leader’s change');
  assert.equal((await call('m3','PATCH',`/key-results/${k1.id}`,{expectedMetaVersion:(k1.meta_version||1)+2,title:'别人改'})).statusCode,403,'peers cannot');
 }finally{await app.close();}
});

test('the Task hub is personal: own tasks only; managers open their reports’ hub read-only, never the other way',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query("UPDATE users SET manager_id='m1' WHERE id IN ('m2','m3')");await db.query("UPDATE users SET role='manager' WHERE id='m2'");
 const app=await buildApp({db,integrations:{executiveUserIds:['m4']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  await db.query("INSERT INTO tasks(id,org_id,department_id,owner_id,reviewer_id,created_by,title,description,criteria,baseline_due_at,due_at) VALUES('boss-own','demo','marketing','m1','m1','m1','上级自己的任务','上级自己的任务说明','[]',now()+interval '3 days',now()+interval '3 days')");
  const mine={id:'boss-own'};
  const r=await call('m2','POST','/tasks/assign',{assigneeId:'m1',title:'下属给上级下达的任务',dueAt:new Date(Date.now()+3*864e5).toISOString(),description:'请上级在周五前确认下季度的推广预算',criteria:['确认预算']});assert.equal(r.statusCode,201,r.body);const toBoss=r.json();
  const board=(await call('m2','GET','/task-board')).json().items.map((t:any)=>t.id);
  assert.ok(!board.includes(mine.id),'the boss’s own task is hidden from the report');
  assert.ok(!board.includes(toBoss.id),'tasks the report assigned to others are tracked in “tasks I assigned”, not in the personal hub');
  assert.ok((await call('m2','GET','/tasks/assignments')).json().byMe.some((t:any)=>t.id===toBoss.id));
  const bossView=await call('m1','GET','/task-board?person=m2');assert.equal(bossView.statusCode,200);assert.equal(bossView.json().scope.readOnly,true);
  assert.equal((await call('m2','GET','/task-board?person=m1')).statusCode,403,'reports cannot open their manager’s hub');
  assert.equal((await call('m4','GET','/task-board?person=m1')).statusCode,200,'company admins can open anyone’s hub');
  assert.ok((await call('m1','GET','/task-board')).json().items.every((t:any)=>t.owner_id==='m1'));
 }finally{await app.close();}
});

test('a manager anywhere above the owner (or the project admin) can move the due date, nothing else',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query("UPDATE users SET manager_id='m1' WHERE id='m4'");await db.query("UPDATE users SET manager_id='m4' WHERE id='m5'");
 const app=await buildApp({db,integrations:{executiveUserIds:['m6']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  await db.query("INSERT INTO tasks(id,org_id,department_id,owner_id,reviewer_id,created_by,title,description,criteria,baseline_due_at,due_at) VALUES('m5-own','demo','product','m5','m4','m5','赵然自己的任务','任务说明内容','[]',now()+interval '3 days',now()+interval '3 days')");
  const t=(await db.query("SELECT * FROM tasks WHERE id='m5-own'")).rows[0];
  const due=new Date(Date.now()+9*864e5).toISOString();
  const r=await call('m1','POST','/tasks/m5-own/board',{expectedVersion:t.version,dueAt:due});assert.equal(r.statusCode,200,r.body);
  const a=await call('m6','POST','/tasks/m5-own/board',{expectedVersion:r.json().version,dueAt:due});assert.equal(a.statusCode,200,'a company admin outside the line can move the due date');
  assert.equal((await call('m6','POST','/tasks/m5-own/board',{expectedVersion:a.json().version,title:'改个名字'})).statusCode,403,'…but nothing else');
  assert.equal((await call('m2','POST','/tasks/m5-own/board',{expectedVersion:r.json().version,dueAt:due})).statusCode,404,'not in the reporting line');
 }finally{await app.close();}
});
