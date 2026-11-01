import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

async function setup(nowRef={t:Date.now()}){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 return {db,app,call};
}
const due=(days:number)=>new Date(Date.now()+days*864e5).toISOString();
const body=(assigneeId:string,extra:any={})=>({assigneeId,title:'整理 11 月竞品价格表',dueAt:due(5),description:'收集三个品牌主要机型的售价和促销',criteria:['覆盖 3 个品牌'],...extra});

test('anyone can assign a task to anyone in the organization; the assigner reviews it and both see it',async()=>{
 const {app,call}=await setup();
 try{
  const r=await call('m3','POST','/tasks/assign',body('m5'));assert.equal(r.statusCode,201,r.body);
  const t=r.json();assert.equal(t.owner_id,'m5');assert.equal(t.reviewer_id,'m3');assert.equal(t.department_id,'product');assert.equal(t.source_kind,'direct');assert.equal(t.assigned_by_name,'许夏');
  assert.ok((await call('m5','GET','/tasks')).json().items.some((x:any)=>x.id===t.id),'assignee sees it');
  const board=(await call('m5','GET','/task-board')).json().items.find((x:any)=>x.id===t.id);assert.ok(board);assert.equal(board.source_kind,'direct');
  assert.ok((await call('m3','GET','/task-board')).json().items.some((x:any)=>x.id===t.id),'assigner in another department tracks it on the board');
  assert.ok((await call('m4','GET','/tasks')).json().items.some((x:any)=>x.id===t.id),'the assignee’s department manager sees it');
  assert.ok(!(await call('m2','GET','/tasks')).json().items.some((x:any)=>x.id===t.id),'unrelated colleagues do not');
  const a=(await call('m5','GET','/tasks/assignments')).json();const mine=a.toMe.find((x:any)=>x.id===t.id);assert.ok(mine);assert.equal(mine.assigned_by_name,'许夏');
  assert.equal((await call('m3','GET','/tasks/assignments')).json().byMe.find((x:any)=>x.id===t.id).owner_name,'赵然');
  const n=(await call('m5','GET','/nudges')).json();assert.equal(n.unread,1);assert.equal(n.items[0].kind,'assigned');assert.match(n.items[0].message,/许夏 给你下达了任务/);
  assert.equal((await call('m5','POST','/nudges/read',{ids:[n.items[0].id]})).statusCode,200);assert.equal((await call('m5','GET','/nudges')).json().unread,0);
  assert.equal((await call('m3','POST','/tasks/assign',body('m3'))).statusCode,400,'not to yourself');
  assert.equal((await call('m3','POST','/tasks/assign',body('m5',{dueAt:due(-2)}))).statusCode,400,'no past due dates');
 }finally{await app.close();}
});

test('follow-ups: overdue and never-started tasks nudge the owner once a day and copy the assigner',async()=>{
 const {app,call,db}=await setup();
 try{
  const t=(await call('m1','POST','/tasks/assign',body('m2'))).json();
  await db.query("UPDATE tasks SET due_at=now()-interval '1 day',created_at=now()-interval '3 days' WHERE id=$1",[t.id]);
  assert.equal((await call('m2','POST','/nudges/run')).statusCode,403,'admins only');
  const run=(await call('m1','POST','/nudges/run')).json();assert.ok(run.sent>=1);
  const mine=(await call('m2','GET','/nudges')).json().items.find((x:any)=>x.kind==='overdue');assert.ok(mine);assert.match(mine.message,/逾期/);
  assert.ok((await call('m1','GET','/nudges')).json().items.some((x:any)=>x.kind==='overdue'&&x.role==='assigner'),'assigner is copied');
  assert.equal((await call('m1','POST','/nudges/run')).json().sent,0,'not repeated the same day');
 }finally{await app.close();}
});

test('a key result added to someone else’s objective becomes a task in their task center',async()=>{
 const {app,call}=await setup();
 try{
  const o=await call('m1','POST','/objectives',{title:'提升有效获客效率',level:'personal',ownerId:'m2'});assert.equal(o.statusCode,201,o.body);
  const kr=await call('m1','POST',`/objectives/${o.json().id}/key-results`,{title:'有效询盘 30 条',baseline:0,target:30,direction:'increase',unit:'条'});assert.equal(kr.statusCode,201,kr.body);
  const task=(await call('m2','GET','/tasks')).json().items.find((x:any)=>x.kr_id===kr.json().id);
  assert.ok(task,'task created for the objective owner');assert.equal(task.source_kind,'okr');assert.equal(task.kr_title,'有效询盘 30 条');assert.equal(task.reviewer_id,'m1');
  const own=await call('m2','POST','/objectives',{title:'自己的目标',level:'personal'});
  await call('m2','POST',`/objectives/${own.json().id}/key-results`,{title:'自己的 KR',baseline:0,target:5,direction:'increase',unit:'个'});
  assert.ok(!(await call('m2','GET','/tasks')).json().items.some((x:any)=>x.kr_title==='自己的 KR'),'own KRs do not create tasks');
 }finally{await app.close();}
});
