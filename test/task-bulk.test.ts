import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';
import {issueSession} from '../src/auth.js';

// Bulk bar on the task board: batch edits, delete (soft archive) with undo, permissions and the OKR-task rule.
let db:Database,app:Awaited<ReturnType<typeof buildApp>>;const tokens:Record<string,string>={};
before(async()=>{db=await createDatabase();await db.exec(schema);await seedDemo(db);
 app=await buildApp({db,integrations:{executiveUserIds:['m4']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});});
after(async()=>{await app.close();});
const call=async(who:string,method:'GET'|'POST',url:string,payload?:any,lang='zh-CN')=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who],'accept-language':lang}});};
const due=()=>new Date(Date.now()+5*864e5).toISOString();
async function own(who:string,title:string,extra:any={}){const r=await call(who,'POST','/tasks',{title,ownerId:who,criteria:[],dueAt:due(),...extra});assert.equal(r.statusCode,201,r.body);return r.json();}
async function assigned(title:string){const r=await call('m1','POST','/tasks',{title,description:'Fictional fixture task',ownerId:'m2',criteria:['Fictional evidence'],dueAt:due()});assert.equal(r.statusCode,201,r.body);return r.json();}
const boardIds=async(who:string)=>(await call(who,'GET','/task-board')).json().items.map((t:any)=>t.id);

test('batch-board applies one change to many rows and reports rows it may not change instead of failing',async()=>{
 const a=await own('m2','Bulk fixture A'),b=await own('m2','Bulk fixture B'),locked=await assigned('Bulk fixture assigned');
 const r=await call('m2','POST','/tasks/batch-board',{items:[a,b].map(t=>({id:t.id,expectedVersion:t.version})),changes:{status:'hold'}});
 assert.equal(r.statusCode,200,r.body);assert.deepEqual(r.json().updated.sort(),[a.id,b.id].sort());assert.deepEqual(r.json().skipped,[]);
 const rows=(await db.query('SELECT board_status FROM tasks WHERE id=ANY($1::text[])',[[a.id,b.id]])).rows;assert.ok(rows.every((x:any)=>x.board_status==='hold'));
 // Priority on a task someone else assigned is locked for the assignee; a stale version is a conflict. Both are skipped, the rest is saved.
 const p=await call('m2','POST','/tasks/batch-board',{items:[{id:a.id,expectedVersion:a.version+1},{id:b.id,expectedVersion:b.version},{id:locked.id,expectedVersion:locked.version}],changes:{priority:'high'}});
 assert.equal(p.statusCode,200,p.body);assert.deepEqual(p.json().updated,[a.id]);
 const reasons=Object.fromEntries(p.json().skipped.map((s:any)=>[s.id,s.code]));assert.equal(reasons[b.id],'VERSION_CONFLICT');assert.equal(reasons[locked.id],'TASK_DEFINITION_LOCKED');
 assert.match(p.json().skipped.find((s:any)=>s.id===locked.id).message,/只有设定任务的人/,'skip reasons are in the reader’s language');
 // Group moves and due dates use the same rules; reassigning needs a manager.
 const g=await call('m2','POST','/tasks/batch-board',{items:[{id:a.id,expectedVersion:a.version+2}],changes:{dueAt:due(),groupId:'todo'}});assert.deepEqual(g.json().updated,[a.id],g.body);
 const o=await call('m2','POST','/tasks/batch-board',{items:[{id:a.id,expectedVersion:a.version+3}],changes:{ownerId:'m3'}},'en');assert.equal(o.json().skipped[0].code,'FORBIDDEN');assert.match(o.json().skipped[0].message,/manager/);
 assert.equal((await call('m2','POST','/tasks/batch-board',{items:Array.from({length:201},(_,i)=>({id:'x'+i,expectedVersion:1})),changes:{status:'hold'}})).statusCode,400,'at most 200 rows');
 assert.equal((await call('m2','POST','/tasks/batch-board',{items:[{id:a.id,expectedVersion:1}],changes:{}})).statusCode,400,'a change is required');
});

test('delete is a soft archive with undo; archived tasks leave the board, lists, leaderboard and reports',async()=>{
 const a=await own('m2','Archive fixture A'),b=await own('m2','Archive fixture B');
 const teamTotal=async()=>(await call('m4','GET','/reports/team?scope=all')).json().members.find((m:any)=>m.id==='m2').stats.total,teamBefore=await teamTotal();
 const before=(await call('m2','GET','/reports/leaderboard')).json().items.find((x:any)=>x.id==='m2').total;
 const r=await call('m2','POST','/tasks/batch-archive',{ids:[a.id,b.id]});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().count,2);assert.deepEqual(r.json().skipped,[]);
 const row=(await db.query('SELECT archived_at,archived_by FROM tasks WHERE id=$1',[a.id])).rows[0];assert.ok(row.archived_at);assert.equal(row.archived_by,'m2');
 assert.ok(!(await boardIds('m2')).includes(a.id),'gone from the task board');
 assert.ok(!(await call('m2','GET','/tasks')).json().items.some((t:any)=>t.id===a.id),'gone from the task list');
 assert.ok(!(await call('m1','GET','/tasks')).json().items.some((t:any)=>t.id===a.id),'gone from the manager’s list');
 assert.equal((await call('m2','GET',`/tasks/${a.id}`)).statusCode,404,'detail is gone');
 assert.equal((await call('m2','POST',`/tasks/${a.id}/board`,{expectedVersion:9,status:'hold'})).statusCode,404,'cannot be edited');
 assert.equal((await call('m2','GET','/reports/leaderboard')).json().items.find((x:any)=>x.id==='m2').total,before-2,'left the leaderboard counts');
 assert.equal(await teamTotal(),teamBefore-2,'left Task analysis');
 const audit=(await db.query("SELECT action FROM audit_events WHERE object_id=ANY($1::text[]) AND action='task.archived'",[[a.id,b.id]])).rows;assert.equal(audit.length,2,'one audit event per task');
 // Undo
 const u=await call('m2','POST','/tasks/batch-restore',{ids:[a.id,b.id]});assert.equal(u.statusCode,200,u.body);assert.equal(u.json().count,2);
 assert.ok((await boardIds('m2')).includes(a.id));assert.equal(await teamTotal(),teamBefore,'back in Task analysis');assert.equal((await call('m2','GET','/reports/leaderboard')).json().items.find((x:any)=>x.id==='m2').total,before);
 assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE object_id=ANY($1::text[]) AND action='task.restored'",[[a.id,b.id]])).rows[0].n,2);
 assert.equal((await call('m2','POST','/tasks/batch-restore',{ids:[a.id]})).json().skipped[0].code,'TASK_NOT_ARCHIVED');
 assert.equal((await call('m2','POST','/tasks/batch-archive',{ids:[]})).statusCode,400);
 assert.equal((await call('m2','POST','/tasks/batch-archive',{ids:Array.from({length:201},(_,i)=>'x'+i)})).statusCode,400,'at most 200 ids');
});

test('permissions: own tasks and tasks you assigned; never ones others gave you; admins any; skips are reported',async()=>{
 const mine=await own('m2','Permission fixture mine'),given=await assigned('Permission fixture given'),other=await own('m3','Permission fixture other');
 const r=await call('m2','POST','/tasks/batch-archive',{ids:[mine.id,given.id,other.id]});assert.equal(r.statusCode,200,r.body);
 assert.deepEqual(r.json().archived,[mine.id]);assert.equal(r.json().skipped.length,2);
 const codes=Object.fromEntries(r.json().skipped.map((s:any)=>[s.id,s.code]));assert.equal(codes[given.id],'TASK_ARCHIVE_FORBIDDEN');assert.equal(codes[other.id],'NOT_FOUND','another employee’s task is not even visible');
 assert.match(r.json().skipped.find((s:any)=>s.id===given.id).message,/只能删除自己创建的任务/);
 assert.equal(r.json().skipped.find((s:any)=>s.id===given.id).title,'Permission fixture given');
 // The person who assigned it may delete it; so may an administrator, for anyone.
 assert.deepEqual((await call('m1','POST','/tasks/batch-archive',{ids:[given.id]})).json().archived,[given.id]);
 assert.deepEqual((await call('m4','POST','/tasks/batch-archive',{ids:[other.id]})).json().archived,[other.id],'admin deletes any task in the org');
 // Restore: m3 did not delete it and did create it, so m3 may restore; m2 may not touch it.
 assert.equal((await call('m2','POST','/tasks/batch-restore',{ids:[other.id]})).json().skipped[0].code,'NOT_FOUND');
 assert.deepEqual((await call('m3','POST','/tasks/batch-restore',{ids:[other.id]})).json().restored,[other.id]);
});

test('subitems go with their parent and come back with it; a parent with someone else’s subitem is kept',async()=>{
 const p=await own('m2','Parent fixture'),c=await own('m2','Child fixture',{parentTaskId:p.id});
 const r=await call('m2','POST','/tasks/batch-archive',{ids:[p.id]});assert.deepEqual(r.json().archived.sort(),[p.id,c.id].sort());assert.equal(r.json().count,1);
 assert.equal((await call('m2','POST','/tasks/batch-restore',{ids:[c.id]})).json().skipped[0].code,'TASK_PARENT_ARCHIVED');
 assert.deepEqual((await call('m2','POST','/tasks/batch-restore',{ids:[p.id]})).json().restored.sort(),[p.id,c.id].sort());
 const p2=await own('m2','Parent fixture 2');const child=await call('m1','POST','/tasks',{title:'Child given by manager',description:'Fictional',ownerId:'m2',criteria:['Fictional'],dueAt:due(),parentTaskId:p2.id});assert.equal(child.statusCode,201,child.body);
 const k=await call('m2','POST','/tasks/batch-archive',{ids:[p2.id]});assert.deepEqual(k.json().archived,[]);assert.equal(k.json().skipped[0].code,'TASK_CHILD_FORBIDDEN');
});

test('a task from an OKR key result cannot be deleted while the KR exists, but its status and group can change',async()=>{
 await db.query("INSERT INTO tasks(id,org_id,department_id,owner_id,reviewer_id,created_by,title,description,criteria,baseline_due_at,due_at,kr_id,source) VALUES('okr-fixture','demo','marketing','m2','m1','m2','推进 KR：通过验收的内容','Fictional','[]',$1,$1,'kr2','okr')",[due()]);
 for(const who of ['m2','m4']){const r=await call(who,'POST','/tasks/batch-archive',{ids:['okr-fixture']});assert.equal(r.json().skipped[0].code,'TASK_FROM_OKR',who);assert.equal(r.json().skipped[0].message,'来自 OKR 的任务请在 OKR 里删除对应 KR');}
 assert.match((await call('m2','POST','/tasks/batch-archive',{ids:['okr-fixture']},'en')).json().skipped[0].message,/key result in the OKR/);
 const v=(await db.query("SELECT version FROM tasks WHERE id='okr-fixture'")).rows[0].version;
 const s=await call('m2','POST','/tasks/batch-board',{items:[{id:'okr-fixture',expectedVersion:v}],changes:{status:'hold'}});assert.deepEqual(s.json().updated,['okr-fixture'],s.body);
 // Once the KR is deleted in the OKR, the task can go too.
 await db.query("UPDATE key_results SET archived_at=now() WHERE id='kr2'");
 try{assert.deepEqual((await call('m2','POST','/tasks/batch-archive',{ids:['okr-fixture']})).json().archived,['okr-fixture']);}
 finally{await db.query("UPDATE key_results SET archived_at=NULL WHERE id='kr2'");}
});

test('“Assigned to me” lists only direct and project assignments, never tasks generated from an OKR',async()=>{
 const ins=(id:string,source:string|null,createdBy:string,kr:string|null)=>db.query("INSERT INTO tasks(id,org_id,department_id,owner_id,reviewer_id,created_by,title,description,criteria,baseline_due_at,due_at,kr_id,source) VALUES($1,'demo','marketing','m2','m1',$2,$3,'Fictional','[]',$4,$4,$5,$6)",[id,createdBy,'Assignment fixture '+id,due(),kr,source]);
 await ins('to-me-okr','okr','m1','kr2');await ins('to-me-okr-legacy',null,'m1','kr2');await ins('to-me-project','project','m1',null);await ins('to-me-direct','direct','m1',null);await ins('to-me-legacy',null,'m1',null);await ins('to-me-self',null,'m2',null);
 const ids=(await call('m2','GET','/tasks/assignments')).json().toMe.map((t:any)=>t.id);
 for(const id of ['to-me-project','to-me-direct','to-me-legacy'])assert.ok(ids.includes(id),id);
 for(const id of ['to-me-okr','to-me-okr-legacy','to-me-self'])assert.ok(!ids.includes(id),id+' is not an assignment from someone');
 const board=await boardIds('m2');assert.ok(board.includes('to-me-okr'),'OKR tasks still show on the personal task board');
 await call('m1','POST','/tasks/batch-archive',{ids:['to-me-direct']});
 assert.ok(!(await call('m2','GET','/tasks/assignments')).json().toMe.some((t:any)=>t.id==='to-me-direct'),'deleted tasks leave the list');
});
