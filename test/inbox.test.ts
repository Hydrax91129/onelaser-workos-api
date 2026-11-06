import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';
let db:Database,app:Awaited<ReturnType<typeof buildApp>>;const tokens:Record<string,string>={},secret=randomBytes(32).toString('hex');
before(async()=>{db=await createDatabase();await db.exec(schema);await seedDemo(db);
  app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret,completionModel:null});
  for(const userId of ['m1','m2','m3'])tokens[userId]=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId,secret}})).json().accessToken;});
after(async()=>{await app.close();});
const call=(who:string,method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});

test('new tasks, updates and submissions land in the inbox of the people who follow the task, never the actor',async()=>{
  const before2=(await call('m2','GET','/inbox')).json().unread;
  const t=(await call('m1','POST','/tasks',{title:'Inbox fixture task',description:'Internal fictional fixture',ownerId:'m2',criteria:['Provide evidence'],dueAt:'2026-11-10T12:00:00Z'})).json();
  let inbox=(await call('m2','GET','/inbox')).json();
  assert.equal(inbox.unread,before2+1);const item=inbox.items.find((i:any)=>i.taskId===t.id);assert.equal(item.kind,'task_new');assert.equal(item.read,false);assert.equal(item.title,'Inbox fixture task');
  assert.equal((await call('m1','GET','/inbox')).json().items.some((i:any)=>i.taskId===t.id),false,'the creator gets nothing for their own action');
  const up=await call('m2','POST',`/tasks/${t.id}/updates`,{requestId:randomUUID(),body:'Started; first draft tomorrow.'});assert.equal(up.statusCode,201,up.body);
  const m1=(await call('m1','GET','/inbox')).json();const u=m1.items.find((i:any)=>i.taskId===t.id&&i.kind==='task_update');assert.ok(u,'creator sees the owner update');assert.match(u.body,/first draft/);
  // Work someone else gave you is finished by submitting it for review.
  const done=await call('m2','POST',`/tasks/${t.id}/submissions`,{expectedVersion:(await call('m2','GET',`/tasks/${t.id}`)).json().version,description:'Delivered.'});assert.equal(done.statusCode,201,done.body);
  assert.ok((await call('m1','GET','/inbox')).json().items.some((i:any)=>i.taskId===t.id&&i.kind==='submission'));
  // Opening the task clears its items; read-all clears the rest.
  await call('m2','POST',`/inbox/read-task/${t.id}`,{});
  inbox=(await call('m2','GET','/inbox')).json();assert.equal(inbox.items.find((i:any)=>i.taskId===t.id).read,true);
  await call('m1','POST','/inbox/read',{all:true});assert.equal((await call('m1','GET','/inbox')).json().unread,0);
  // Another user cannot mark my items read.
  const t2=(await call('m1','POST','/tasks',{title:'Second inbox task',description:'Internal fictional fixture',ownerId:'m2',criteria:['Evidence'],dueAt:'2026-11-11T12:00:00Z'})).json();
  const id2=(await call('m2','GET','/inbox')).json().items.find((i:any)=>i.taskId===t2.id).id;
  await call('m3','POST','/inbox/read',{ids:[id2]});assert.equal((await call('m2','GET','/inbox')).json().items.find((i:any)=>i.id===id2).read,false);
  await call('m2','POST','/inbox/read',{ids:[id2]});assert.equal((await call('m2','GET','/inbox')).json().items.find((i:any)=>i.id===id2).read,true);
});
