import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

const pdf=Buffer.from('%PDF-1.4\n% fictional brief\n').toString('base64');
const docx=Buffer.concat([Buffer.from([0x50,0x4b,0x03,0x04]),Buffer.from('fictional word file')]).toString('base64');

async function setup(model:any=null){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,okrDraftModel:model,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:`Bearer ${tokens[who]}`}});};
 const proj=(await call('m2','POST','/projects',{name:'示例活动项目',startDate:'2026-11-01',endDate:'2027-03-30',template:'campaign',members:['m3']})).json();
 return {app,call,proj};
}

test('project files: members upload, viewers download, only uploader or admin deletes, types are checked',async()=>{
 const {app,call,proj}=await setup();
 try{
  const up=await call('m3','POST',`/projects/${proj.id}/files`,{name:'活动方案.pdf',category:'brief',dataBase64:pdf});assert.equal(up.statusCode,201,up.body);
  const f=up.json();assert.equal(f.category,'brief');assert.equal(f.mime,'application/pdf');
  assert.equal((await call('m2','POST',`/projects/${proj.id}/files`,{name:'报价.docx',category:'contract',dataBase64:docx})).statusCode,201);
  assert.equal((await call('m2','POST',`/projects/${proj.id}/files`,{name:'x.exe',dataBase64:pdf})).statusCode,400,'unknown types are refused');
  assert.equal((await call('m2','POST',`/projects/${proj.id}/files`,{name:'fake.pdf',dataBase64:docx})).statusCode,400,'content must match the extension');
  assert.equal((await call('m6','POST',`/projects/${proj.id}/files`,{name:'a.pdf',dataBase64:pdf})).statusCode,404,'outsiders cannot see the project');
  const listed=(await call('m2','GET','/projects')).json().items[0].files;assert.equal(listed.length,2);
  assert.equal(listed.find((x:any)=>x.id===f.id).canDelete,true,'the project admin can delete any file');
  const dl=await call('m1','GET',`/projects/files/${f.id}`);assert.equal(dl.statusCode,200);assert.equal(dl.headers['content-type'],'application/pdf');assert.match(dl.body,/%PDF/);
  assert.equal((await call('m6','GET',`/projects/files/${f.id}`)).statusCode,404,'outsiders cannot download');
  const other=listed.find((x:any)=>x.id!==f.id);
  assert.equal((await call('m3','DELETE',`/projects/files/${other.id}`)).statusCode,403,'a member cannot delete someone else’s file');
  assert.equal((await call('m3','DELETE',`/projects/files/${f.id}`)).statusCode,200,'the uploader can');
  assert.equal((await call('m2','GET','/projects')).json().items[0].files.length,1);
 }finally{await app.close();}
});

test('deleting a stage moves its tasks to the first remaining stage, and the activity feed records it all',async()=>{
 const {app,call,proj}=await setup();
 try{
  const [g1,g2,g3]=proj.groups;
  const t=(await call('m2','POST',`/projects/${proj.id}/tasks`,{title:'整理素材清单',ownerId:'m3',groupId:g3.id,dueAt:new Date(Date.now()+5*864e5).toISOString()})).json();
  const moved=await call('m2','PATCH',`/projects/${proj.id}/tasks/${t.id}`,{expectedVersion:t.version,groupId:g2.id,status:'working'});assert.equal(moved.statusCode,200,moved.body);
  const renamed=await call('m3','PATCH',`/projects/${proj.id}`,{groups:[{...g1,name:'方案'},g3]});assert.equal(renamed.statusCode,200,renamed.body);
  const after=renamed.json();assert.equal(after.groups[0].name,'方案');assert.equal(after.tasks[0].project_group_id,g1.id,'the task left the deleted stage');
  await call('m3','POST',`/projects/${proj.id}/files`,{name:'方案.pdf',category:'brief',dataBase64:pdf});
  await call('m2','POST',`/projects/${proj.id}/updates`,{health:'on_track',body:'进展正常'});
  const feed=await call('m3','GET',`/projects/${proj.id}/activity`);assert.equal(feed.statusCode,200,feed.body);
  const kinds=feed.json().items.map((x:any)=>x.kind);
  for(const k of ['task_created','task_changed','stage_renamed','stage_deleted','file_added','status'])assert.ok(kinds.includes(k),k);
  const change=feed.json().items.find((x:any)=>x.kind==='task_changed');assert.equal(change.detail.stage,g2.name);assert.equal(change.detail.status,'working');assert.equal(change.taskTitle,'整理素材清单');
  assert.equal((await call('m6','GET',`/projects/${proj.id}/activity`)).statusCode,404);
 }finally{await app.close();}
});

test('AI 拆任务 returns a checked draft and creates nothing',async()=>{
 let seen='';
 const model={model:'fake',json:async(_s:string,user:string)=>{seen=user;return {tasks:[
  {title:'写活动方案',description:'方案定稿',owner:2,stage:1,dueDate:'2026-01-01',priority:'high'},
  {title:'做广告素材',description:'三组素材',owner:9,stage:7,dueDate:'2099-01-01',priority:'nope'},
  {title:'',description:'',owner:1,stage:1,dueDate:'x',priority:'low'}]};}};
 const {app,call,proj}=await setup(model);
 try{
  const r=await call('m3','POST',`/projects/${proj.id}/ai-plan`,{text:'黑五要做方案和广告素材，方案给许夏'});assert.equal(r.statusCode,200,r.body);
  const {tasks}=r.json();assert.equal(tasks.length,2,'empty titles are dropped');
  assert.ok(JSON.parse(seen).people.length>=2);
  assert.ok(['m2','m3'].includes(tasks[0].ownerId));assert.equal(tasks[0].groupId,proj.groups[0].id);
  assert.ok(tasks[0].dueDate>=new Date().toISOString().slice(0,10),'due dates are not in the past');
  assert.equal(tasks[1].ownerId,null,'an unknown person is left blank');assert.equal(tasks[1].groupId,proj.groups[0].id);assert.equal(tasks[1].dueDate,'2027-03-30','clamped to the project end');assert.equal(tasks[1].priority,'medium');
  assert.equal((await call('m2','GET','/projects')).json().items[0].tasks.length,0,'nothing is created');
  assert.equal((await call('m6','POST',`/projects/${proj.id}/ai-plan`,{text:'随便写点'})).statusCode,404);
 }finally{await app.close();}
});
