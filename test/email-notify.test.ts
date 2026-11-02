import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

test('work email: required, admin-set email is locked for the person, and reminders go out by email too',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 const sent:any[]=[];
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},completionModel:null,translationModel:null,mailer:async m=>{sent.push(m);},nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  assert.equal((await call('m3','PATCH','/me/profile',{email:''})).statusCode,400,'cannot clear the work email');
  assert.equal((await call('m3','PATCH','/me/profile',{email:'Me@Example.com'})).json().email,'me@example.com','self-set while unlocked');
  assert.equal((await call('m3','PATCH','/org/members/m3',{email:'x@1laser.com'})).statusCode,403,'only admins set others');
  const set=await call('m1','PATCH','/org/members/m3',{email:'Wei@1laser.com'});assert.equal(set.statusCode,200,set.body);assert.equal(set.json().email,'wei@1laser.com');assert.equal(set.json().email_locked,true);
  const self=await call('m3','PATCH','/me/profile',{email:'other@example.com'});assert.equal(self.statusCode,403);assert.equal(self.json().error.code,'EMAIL_LOCKED');
  assert.equal((await call('m3','PATCH','/me/profile',{phone:'123'})).statusCode,200,'other fields still editable');
  assert.equal((await call('m1','GET','/capabilities')).json().notificationChannels.email,true);
  // assigning a task to m3 emails them
  const due=new Date(Date.now()+5*86400000).toISOString();
  const r=await call('m1','POST','/tasks/assign',{assigneeId:'m3',title:'整理经销商资料',dueAt:due,description:'把经销商资料整理成一张表，周五前完成。',criteria:['表格上传共享盘'],priority:'high'});
  assert.equal(r.statusCode,201,r.body);
  const mail=sent.find(m=>m.to==='wei@1laser.com');assert.ok(mail,'assignment email sent');assert.match(mail.subject,/【WorkOS】/);assert.match(mail.text,/整理经销商资料/);
  const nudge=(await db.query("SELECT channels FROM task_nudges WHERE task_id=$1 AND kind='assigned'",[r.json().id])).rows[0];
  assert.deepEqual(typeof nudge.channels==='string'?JSON.parse(nudge.channels):nudge.channels,['app','email']);
  // manual nudge also emails
  const n=await call('m1','POST',`/tasks/${r.json().id}/nudge`,{});assert.equal(n.statusCode,200,n.body);
  assert.equal(sent.filter(m=>m.to==='wei@1laser.com').length,2);
 }finally{await app.close();}
});
