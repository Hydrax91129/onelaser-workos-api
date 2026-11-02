import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

test('project tasks are real tasks: they land in the assignee’s task center with source “project”',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  const p=await call('m2','POST','/projects',{name:'Hydra 2.0 新机型开发',startDate:'2026-11-01',endDate:'2026-12-20',template:'launch',members:['m3']});assert.equal(p.statusCode,201,p.body);
  const proj=p.json();assert.equal(proj.groups.length,3);assert.deepEqual(proj.members.sort(),['m2','m3']);
  const t=await call('m2','POST',`/projects/${proj.id}/tasks`,{title:'首台样机组装',ownerId:'m5',groupId:proj.groups[1].id,dueAt:new Date(Date.now()+5*864e5).toISOString(),priority:'urgent'});assert.equal(t.statusCode,201,t.body);
  const task=t.json();assert.equal(task.owner_id,'m5');assert.equal(task.source_kind,'project');assert.equal(task.reviewer_id,'m2');
  const board=(await call('m5','GET','/task-board')).json().items.find((x:any)=>x.id===task.id);assert.ok(board,'in the assignee’s task center');assert.equal(board.source_kind,'project');
  const list=(await call('m6','GET','/projects')).json().items;assert.equal(list[0].tasks.length,1,'everyone in the org can read projects');assert.equal(list[0].canEdit,false);
  assert.equal((await call('m6','POST',`/projects/${proj.id}/tasks`,{title:'x任务',ownerId:'m6',groupId:proj.groups[0].id,dueAt:new Date(Date.now()+864e5).toISOString()})).statusCode,403,'non-members cannot add tasks');
  const moved=await call('m3','PATCH',`/projects/${proj.id}/tasks/${task.id}`,{expectedVersion:task.version,status:'working',groupId:proj.groups[2].id});assert.equal(moved.statusCode,200,moved.body);assert.equal(moved.json().board_status,'working');
  const done=await call('m3','PATCH',`/projects/${proj.id}/tasks/${task.id}`,{expectedVersion:moved.json().version,status:'done'});assert.equal(done.statusCode,409);assert.equal(done.json().error.code,'COMPLETION_RESULT_REQUIRED');
  assert.equal((await call('m2','POST',`/projects/${proj.id}/updates`,{health:'at_risk',body:'电源板供应商延期一周'})).statusCode,201);
  const again=(await call('m2','GET','/projects')).json().items[0];assert.equal(again.health,'at_risk');assert.equal(again.updates[0].body,'电源板供应商延期一周');assert.ok(again.members.includes('m5'),'assignee joins the project');
  assert.equal((await call('m2','PATCH',`/projects/${proj.id}`,{milestones:[{id:'ms1',name:'首台样机',date:'2026-11-14',done:false}]})).json().milestones[0].name,'首台样机');
 }finally{await app.close();}
});

test('project admin: the creator by default or a chosen active member; only the admin manages members',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  const mine=(await call('m2','POST','/projects',{name:'官网改版',startDate:'2026-11-01',endDate:'2026-12-20',members:['m3']})).json();
  assert.equal(mine.owner_id,'m2','the creator is the project admin by default');assert.equal(mine.canManage,true);
  const chosen=await call('m2','POST','/projects',{name:'展会筹备',startDate:'2026-11-01',endDate:'2026-12-20',ownerId:'m5',members:['m3']});assert.equal(chosen.statusCode,201,chosen.body);
  const c=chosen.json();assert.equal(c.owner_id,'m5');assert.deepEqual([...c.members].sort(),['m2','m3','m5']);assert.equal(c.canManage,false,'the creator is no longer the admin');
  assert.equal((await call('m3','PATCH',`/projects/${mine.id}`,{members:['m3','m6']})).statusCode,403,'a member cannot invite');
  const invited=await call('m2','PATCH',`/projects/${mine.id}`,{members:['m3','m6']});assert.equal(invited.statusCode,200,invited.body);assert.deepEqual([...invited.json().members].sort(),['m2','m3','m6']);
  const handed=await call('m2','PATCH',`/projects/${mine.id}`,{ownerId:'m6'});assert.equal(handed.json().owner_id,'m6');
  assert.equal((await call('m3','PATCH',`/projects/${mine.id}`,{description:'目标与范围'})).statusCode,200,'members still edit the description');
 }finally{await app.close();}
});
