import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

// Fictional demo data only. m1 = marketing manager (company owner), m2/m3 = marketing employees,
// m4 = product manager who becomes m2's second leader (dotted line), m5/m6 = product employees.
// Rule: the second leader has the same rights over the person as the first leader.
async function setup(){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query("INSERT INTO users(id,org_id,department_id,display_name,role,active) VALUES('gone','demo','product','Former','employee',false),('x1','other','ops','Outsider','manager',true)");
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']}});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 for(const [who,mgr] of [['m2','m1'],['m3','m1'],['m5','m4'],['m6','m4']])assert.equal((await call('m1','PATCH',`/org/members/${who}`,{managerId:mgr})).statusCode,200);
 return {db,app,call};
}

test('second leader: only admins set it; self, same as first leader, cycles, inactive and other-org users are rejected',async()=>{
 const {db,app,call}=await setup();
 try{
  const code=async(r:any)=>(await r).json().error?.code;
  assert.equal((await call('m4','PATCH','/org/members/m2',{secondManagerId:'m4'})).statusCode,403,'non-admins cannot set a second leader');
  assert.equal(await code(call('m1','PATCH','/org/members/m2',{secondManagerId:'m2'})),'SECOND_MANAGER_SELF');
  assert.equal(await code(call('m1','PATCH','/org/members/m2',{secondManagerId:'m1'})),'SECOND_MANAGER_SAME');
  assert.equal(await code(call('m1','PATCH','/org/members/m2',{secondManagerId:'gone'})),'INVALID_SECOND_MANAGER');
  assert.equal(await code(call('m1','PATCH','/org/members/m2',{secondManagerId:'x1'})),'INVALID_SECOND_MANAGER');
  assert.equal(await code(call('m1','PATCH','/org/members/m2',{secondManagerId:'nobody'})),'INVALID_SECOND_MANAGER');
  await call('m1','PATCH','/org/members/m3',{managerId:'m2'});
  assert.equal(await code(call('m1','PATCH','/org/members/m2',{secondManagerId:'m3'})),'SECOND_MANAGER_CYCLE','m3 reports to m2');
  await call('m1','PATCH','/org/members/m3',{managerId:'m1'});
  const ok=await call('m1','PATCH','/org/members/m2',{secondManagerId:'m4'});assert.equal(ok.statusCode,200,ok.body);
  assert.equal(ok.json().second_manager_id,'m4');assert.equal(ok.json().manager_id,'m1','the first leader is unchanged');
  assert.equal(await code(call('m1','PATCH','/org/members/m4',{secondManagerId:'m2'})),'SECOND_MANAGER_CYCLE');
  assert.equal(await code(call('m1','PATCH','/org/members/m4',{managerId:'m2'})),'REPORTING_CYCLE');
  assert.equal(await code(call('m1','PATCH','/org/members/m2',{managerId:'m4'})),'SECOND_MANAGER_SAME');
  const chart=(await call('m6','GET','/org/chart')).json().items.find((u:any)=>u.id==='m2');assert.equal(chart.second_manager_id,'m4');
  const audit=(await db.query("SELECT details FROM audit_events WHERE action='org.second_manager_changed' AND object_id='m2'")).rows;
  assert.equal(audit.length,1);assert.deepEqual(audit[0].details,{from:null,to:'m4'});
  assert.equal((await call('m1','PATCH','/org/members/m2',{secondManagerId:null})).json().second_manager_id,null,'clearing works');
 }finally{await app.close();}
});

test('second leader sees what the first leader sees: tasks, OKRs, projects, team report, HR basics; nobody else gains access',async()=>{
 const {app,call}=await setup();
 try{
  const project=await call('m2','POST','/projects',{name:'Fictional launch',startDate:'2026-11-01',endDate:'2026-12-01'});assert.equal(project.statusCode,201,project.body);
  assert.equal((await call('m4','GET','/tasks/t1')).statusCode,404,'no access before the dotted line exists');
  assert.equal((await call('m1','PATCH','/org/members/m2',{secondManagerId:'m4'})).statusCode,200);
  assert.deepEqual((await call('m4','GET','/me')).json().dottedOwnerIds,['m2']);
  for(const who of ['m1','m4']){
   const ids=(await call(who,'GET','/tasks')).json().items.map((t:any)=>t.id);assert.ok(ids.includes('t1'),who+' lists m2\'s task');
   for(const url of ['/tasks/t1','/tasks/t1/updates','/tasks/t1/attachments','/tasks/t1/completion','/tasks/t1/evaluations'])assert.equal((await call(who,'GET',url)).statusCode,200,who+' '+url);
   const hub=await call(who,'GET','/task-board?person=m2');assert.equal(hub.statusCode,200,hub.body);
   const objectives=(await call(who,'GET','/objectives')).json().items;assert.equal(objectives.find((o:any)=>o.id==='o3')?.canLeadScore,true,who+' can give the leader score');
   assert.ok((await call(who,'GET','/key-results')).json().items.some((k:any)=>k.id==='kr2'));
   assert.equal((await call(who,'GET','/objectives/o3/updates')).statusCode,200,who+' reads OKR updates');
   const p=(await call(who,'GET','/projects')).json().items.find((x:any)=>x.id===project.json().id);assert.ok(p,who+' sees the report\'s project');
   const team=(await call(who,'GET','/reports/team')).json().members.find((m:any)=>m.id==='m2');assert.ok(team,who+' has m2 in the team report');
   assert.equal(team.line,who==='m4'?'second':'first');
   const hr=await call(who,'GET','/hr/people/m2');assert.equal(hr.statusCode,200,who+' sees the non-sensitive HR profile like any leader');
   // m1 is also the company owner here, and owners see all HR data (hr.ts); being a leader alone never opens salary.
   if(who!=='m1')assert.equal((await call(who,'POST','/hr/people/m2/reveal',{field:'salary',reason:'curious'})).statusCode,403,who+' never sees salary');
  }
  // The project stays editable only by its members (same as for the first leader).
  assert.equal((await call('m4','PATCH',`/projects/${project.json().id}`,{name:'Renamed by a leader'})).statusCode,403);
  // m4 is not m3's leader on either line; m6 gains nothing.
  assert.equal((await call('m4','GET','/tasks/t2')).statusCode,404);
  assert.equal((await call('m6','GET','/tasks/t1')).statusCode,404);
  assert.ok(!(await call('m6','GET','/projects')).json().items.some((x:any)=>x.id===project.json().id));
 }finally{await app.close();}
});

test('second leader can review, give the leader score and move due dates like the first leader; clearing or disabling ends it',async()=>{
 const {db,app,call}=await setup();
 try{
  assert.equal((await call('m1','PATCH','/org/members/m2',{secondManagerId:'m4'})).statusCode,200);
  const t1=(await call('m4','GET','/tasks/t1')).json();
  const due=new Date(Date.now()+5*864e5).toISOString();
  const moved=await call('m4','POST','/tasks/t1/board',{expectedVersion:t1.version,dueAt:due});assert.equal(moved.statusCode,200,'moves the due date as an overseer: '+moved.body);
  const score=await call('m4','POST','/objectives/o3/scores',{kind:'manager',score:100,comment:'Fictional leader score'});assert.ok([200,201].includes(score.statusCode),'gives the objective leader score: '+score.body);
  // Assigning the second leader as reviewer is allowed (reviewerAllowed accepts either leader).
  const created=await call('m2','POST','/tasks',{title:'Fictional task for the dotted line',description:'Only test data here',ownerId:'m2',reviewerId:'m4',criteria:['Done'],dueAt:due});
  assert.equal(created.statusCode,201,created.body);assert.equal(created.json().reviewer_id??created.json().task?.reviewer_id,'m4');
  // Clearing the dotted line removes the access again.
  await call('m1','PATCH','/org/members/m2',{secondManagerId:null});
  assert.equal((await call('m4','GET','/tasks/t1')).statusCode,404);
  // Disabling the second leader ends the dotted line.
  await call('m1','PATCH','/org/members/m2',{secondManagerId:'m4'});
  const off=await call('m1','POST','/org/members/m4/status',{active:false,reassignTo:null});assert.equal(off.statusCode,200,off.body);
  assert.equal((await db.query("SELECT second_manager_id FROM users WHERE id='m2'")).rows[0].second_manager_id,null);
 }finally{await app.close();}
});
