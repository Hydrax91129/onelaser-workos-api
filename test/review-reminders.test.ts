import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';

let db:Database,app:Awaited<ReturnType<typeof buildApp>>;
const tokens:Record<string,string>={},secret=randomBytes(32).toString('hex'),mail:any[]=[];
let mailFails=false;
before(async()=>{
  db=await createDatabase();await db.exec(schema);await seedDemo(db);
  await db.query("UPDATE users SET email=id||'@example.test'");
  app=await buildApp({db,allowDevLogin:true,devLoginSecret:secret,completionModel:null,nudgeIntervalMs:0,mailer:async(m:any)=>{if(mailFails)throw new Error('mail down');mail.push(m);}});
  for(const userId of ['m1','m2','m3'])tokens[userId]=(await app.inject({method:'POST',url:'/auth/dev-login',payload:{userId,secret}})).json().accessToken;
});
after(async()=>{await app.close();});
const call=(who:string,method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});
const give=async(title:string)=>(await call('m1','POST','/tasks',{title,description:'Internal fictional fixture',ownerId:'m2',reviewerId:'m1',criteria:['Provide evidence'],dueAt:'2026-12-10T12:00:00Z'})).json();
const submit=async(who:string,id:string)=>call(who,'POST',`/tasks/${id}/submissions`,{expectedVersion:(await call(who,'GET',`/tasks/${id}`)).json().version,description:'Delivered the fixture.'});
const waitFor=async(check:()=>boolean)=>{for(let i=0;i<100&&!check();i++)await new Promise(r=>setTimeout(r,20));};

test('the reviewer gets an email saying who submitted and that it auto-accepts in 3 days',async()=>{
  const t=await give('Reminder fixture task');mail.length=0;
  const r=await submit('m2',t.id);assert.equal(r.statusCode,201,r.body);
  await waitFor(()=>mail.length>0);
  assert.equal(mail.length,1,'only the reviewer is emailed');assert.equal(mail[0].to,'m1@example.test');
  assert.match(mail[0].text,/提交了「Reminder fixture task」的成果/);assert.match(mail[0].text,/3 天内/);
});

test('a failing email does not fail the submission',async()=>{
  const t=await give('Failing mail fixture');mailFails=true;
  try{const r=await submit('m2',t.id);assert.equal(r.statusCode,201,r.body);}finally{mailFails=false;}
});

test('submitting your own self-reviewed task sends no reminder',async()=>{
  const t=(await call('m2','POST','/tasks',{title:'Own fixture task',ownerId:'m2',dueAt:'2026-12-10T12:00:00Z'})).json();
  await db.query('UPDATE tasks SET reviewer_id=owner_id WHERE id=$1',[t.id]);
  mail.length=0;const r=await submit('m2',t.id);assert.equal(r.statusCode,201,r.body);
  await new Promise(res=>setTimeout(res,100));assert.equal(mail.length,0);
});

test('awaiting-my-review lists work others submitted to me, with the auto-accept time, and clears on decision',async()=>{
  const t=await give('Queue fixture task');await submit('m2',t.id);
  const mine=(await call('m1','GET','/tasks/awaiting-my-review')).json().items.find((x:any)=>x.id===t.id);
  assert.ok(mine,'the reviewer sees it even though they do not own it');assert.equal(mine.owner_id,'m2');
  assert.equal(new Date(mine.auto_accept_at).getTime()-new Date(mine.submitted_at).getTime(),3*864e5);
  assert.equal((await call('m1','GET','/task-board')).json().items.some((x:any)=>x.id===t.id),false,'the personal board alone would have missed it');
  assert.equal((await call('m2','GET','/tasks/awaiting-my-review')).json().items.some((x:any)=>x.id===t.id),false,'not the owner');
  assert.equal((await call('m3','GET','/tasks/awaiting-my-review')).json().items.some((x:any)=>x.id===t.id),false,'not a third person');
  const d=(await call('m1','GET',`/tasks/${t.id}`)).json();
  const a=await call('m1','POST',`/tasks/${t.id}/reviews`,{expectedVersion:d.version,submissionVersion:d.submission_version,decision:'accept',quality:9,note:'Checked the fixture.',verifiedCurrentSubmission:true});assert.equal(a.statusCode,201,a.body);
  assert.equal((await call('m1','GET','/tasks/awaiting-my-review')).json().items.some((x:any)=>x.id===t.id),false,'gone once accepted');
});

test('awaiting-my-review needs a signed-in user',async()=>{
  assert.equal((await app.inject({method:'GET',url:'/tasks/awaiting-my-review'})).statusCode,401);
});
