import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {hashPassword,verifyPassword} from '../src/members.js';

async function setup(mailer:any=null){
 const db=await createDatabase();await db.exec(schema);await db.exec(schema);await seedDemo(db);
 const sent:any[]=[];
 const app=await buildApp({db,integrations:{executiveUserIds:['m1'],appPublicUrl:'https://craftos.example'},mailer:mailer===null?null:async(m:any)=>{sent.push(m);}});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const anon=(method:'GET'|'POST',url:string,payload?:any)=>app.inject({method,url,payload});
 return {db,app,call,anon,sent,tokens};
}
const tokenFrom=(url:string)=>url.split('#invite/')[1];

test('password hashing round-trips and rejects wrong or malformed hashes',async()=>{
 const h=await hashPassword('correct horse battery');
 assert.ok(h.startsWith('scrypt$'));
 assert.equal(await verifyPassword('correct horse battery',h),true);
 assert.equal(await verifyPassword('wrong password!!',h),false);
 assert.equal(await verifyPassword('anything',null),false);
});

test('admin invites a non-DingTalk member; invitee sets a password, signs in, appears in the org',async()=>{
 const {app,call,anon,db}=await setup();
 try{
  assert.equal((await call('m2','POST','/org/invites',{displayName:'Mike',email:'mike@example.com'})).statusCode,403,'only admins invite');
  const inv=await call('m1','POST','/org/invites',{displayName:'Mike Chen',email:'Mike@Example.com',title:'US warehouse lead',managerId:'m1',role:'employee',grants:['products']});
  assert.equal(inv.statusCode,201,inv.body);const body=inv.json();
  assert.ok(body.url.startsWith('https://craftos.example/#invite/'));assert.equal(body.email,'mike@example.com');assert.equal(body.status,'pending');
  const list=(await call('m1','GET','/org/invites')).json();assert.equal(list.items[0].email,'mike@example.com');assert.ok(!('url' in list.items[0])&&!('token_hash' in list.items[0]),'links are shown once only');
  const token=tokenFrom(body.url);
  const peek=await anon('GET','/auth/invite/'+token);assert.equal(peek.statusCode,200,peek.body);assert.equal(peek.json().displayName,'Mike Chen');
  assert.equal((await anon('POST','/auth/invite/'+token+'/accept',{password:'short'})).statusCode,400,'password too short');
  const accept=await anon('POST','/auth/invite/'+token+'/accept',{password:'warehouse-2026!'});
  assert.equal(accept.statusCode,200,accept.body);assert.match(String(accept.headers['set-cookie']),/workos_session=/);
  assert.equal((await anon('POST','/auth/invite/'+token+'/accept',{password:'warehouse-2026!'})).statusCode,404,'single use');
  const user=(await db.query("SELECT * FROM users WHERE login_email='mike@example.com'")).rows[0];
  assert.equal(user.manager_id,'m1');assert.equal(user.title,'US warehouse lead');assert.deepEqual(user.grants,['products']);assert.equal(user.department_id,'marketing');
  const chart=(await call('m2','GET','/org/chart')).json().items;assert.ok(chart.some((u:any)=>u.id===user.id),'invitee is on the org chart');
  const bad=await anon('POST','/auth/password',{email:'mike@example.com',password:'wrong-password'});assert.equal(bad.statusCode,401);
  const good=await anon('POST','/auth/password',{email:'MIKE@example.com',password:'warehouse-2026!'});assert.equal(good.statusCode,200,good.body);
  const cookie=String(good.headers['set-cookie']).split(';')[0];
  const me=await app.inject({url:'/me',headers:{cookie}});assert.equal(me.statusCode,200);assert.equal(me.json().display_name,'Mike Chen');
  assert.equal((await call('m1','POST','/org/invites',{displayName:'Dup',email:'mike@example.com'})).statusCode,409,'email already a member');
 }finally{await app.close();}
});

test('revoked and expired invites cannot be used',async()=>{
 const {app,call,anon,db}=await setup();
 try{
  const a=(await call('m1','POST','/org/invites',{displayName:'A',email:'a@example.com'})).json();
  assert.equal((await call('m1','DELETE','/org/invites/'+a.id)).statusCode,200);
  assert.equal((await anon('GET','/auth/invite/'+tokenFrom(a.url))).statusCode,404);
  const b=(await call('m1','POST','/org/invites',{displayName:'B',email:'b@example.com'})).json();
  await db.query("UPDATE member_invites SET expires_at=now()-interval '1 minute' WHERE id=$1",[b.id]);
  assert.equal((await anon('POST','/auth/invite/'+tokenFrom(b.url)+'/accept',{password:'long-enough-pw'})).statusCode,404);
  assert.equal((await anon('GET','/auth/invite/not-a-token')).statusCode,401,'malformed paths are not public');
 }finally{await app.close();}
});

test('disabling a member ends sessions, hides them, reassigns open tasks and moves reports up; re-enable restores',async()=>{
 const {app,call,db,tokens}=await setup();
 try{
  await call('m1','PATCH','/org/members/m2',{managerId:'m1'});await call('m1','PATCH','/org/members/m3',{managerId:'m2'});
  assert.equal((await call('m2','GET','/me')).statusCode,200);const m2token=tokens.m2;
  assert.equal((await call('m1','POST','/org/members/m1/status',{active:false})).json().error.code,'SELF_DISABLE');
  assert.equal((await call('m4','POST','/org/members/m2/status',{active:false})).statusCode,403,'non-admin cannot disable');
  const counts=(await call('m1','GET','/org/members/m2/open-tasks')).json();assert.ok(counts.owned>=1,'m2 owns an open seeded task');
  assert.equal((await call('m1','POST','/org/members/m2/status',{active:false,reassignTo:'m5'})).statusCode,400,'heir must be in the same department');
  const off=await call('m1','POST','/org/members/m2/status',{active:false,reassignTo:'m3'});assert.equal(off.statusCode,200,off.body);
  assert.equal(off.json().reassigned.owned,counts.owned);assert.equal(off.json().reassigned.reports,1);
  const r=await app.inject({url:'/me',headers:{authorization:'Bearer '+m2token}});assert.equal(r.statusCode,401,'session revoked');
  assert.equal((await db.query("SELECT manager_id FROM users WHERE id='m3'")).rows[0].manager_id,'m1','reports move up');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM tasks WHERE owner_id='m2' AND status<>'accepted'")).rows[0].n,0);
  assert.ok(!(await call('m3','GET','/org/chart')).json().items.some((u:any)=>u.id==='m2'),'hidden from org chart');
  const dir=(await call('m3','GET','/directory')).json();assert.ok(!dir.items.some((u:any)=>u.id==='m2'));assert.ok(dir.former.some((u:any)=>u.id==='m2'),'name kept for history');
  const members=(await call('m1','GET','/org/members')).json().items;const row=members.find((u:any)=>u.id==='m2');assert.equal(row.active,false);assert.ok(row.disabled_at);
  assert.equal((await call('m1','POST','/org/members/m2/status',{active:true})).statusCode,200);
  assert.equal((await call('m1','GET','/org/members')).json().items.find((u:any)=>u.id==='m2').active,true);
 }finally{await app.close();}
});

test('a disabled invitee cannot sign in with password; executives are protected',async()=>{
 const {app,call,anon,db}=await setup();
 try{
  const inv=(await call('m1','POST','/org/invites',{displayName:'Temp',email:'temp@example.com'})).json();
  await anon('POST','/auth/invite/'+tokenFrom(inv.url)+'/accept',{password:'temporary-pass'});
  const uid=(await db.query("SELECT id FROM users WHERE login_email='temp@example.com'")).rows[0].id;
  assert.equal((await call('m1','POST','/org/members/'+uid+'/status',{active:false})).statusCode,200);
  const res=await anon('POST','/auth/password',{email:'temp@example.com',password:'temporary-pass'});assert.equal(res.statusCode,403);assert.equal(res.json().error.code,'ACCOUNT_DISABLED');
  await call('m1','PATCH','/org/members/m4',{isAdmin:true});
  assert.equal((await call('m4','POST','/org/members/m1/status',{active:false})).json().error.code,'EXECUTIVE_PROTECTED');
 }finally{await app.close();}
});

test('email code sign-in works only when a mailer is configured, never reveals membership, and limits attempts',async()=>{
 const off=await setup(null);
 try{
  assert.equal((await off.anon('POST','/auth/email-code',{email:'x@example.com'})).statusCode,501);
  assert.equal((await off.call('m1','GET','/capabilities')).json().emailCodeLogin,false);
 }finally{await off.app.close();}
 const {app,call,anon,sent}=await setup(true);
 try{
  assert.equal((await call('m1','GET','/capabilities')).json().emailCodeLogin,true);
  const inv=await call('m1','POST','/org/invites',{displayName:'Lee',email:'lee@example.com'});assert.equal(inv.json().emailed,true,'invite emailed');assert.equal(sent.length,1);
  await anon('POST','/auth/invite/'+tokenFrom(inv.json().url)+'/accept',{password:'lee-password-1'});
  assert.equal((await anon('POST','/auth/email-code',{email:'nobody@example.com'})).statusCode,202,'same answer for unknown emails');assert.equal(sent.length,1);
  assert.equal((await anon('POST','/auth/email-code',{email:'lee@example.com'})).statusCode,202);assert.equal(sent.length,2);
  const code=/(\d{6})/.exec(sent[1].text)![1];
  const wrong=String((Number(code)+1)%1000000).padStart(6,'0');
  assert.equal((await anon('POST','/auth/email-code/verify',{email:'lee@example.com',code:wrong})).statusCode,401);
  const ok=await anon('POST','/auth/email-code/verify',{email:'lee@example.com',code});assert.equal(ok.statusCode,200,ok.body);
  assert.equal((await anon('POST','/auth/email-code/verify',{email:'lee@example.com',code})).statusCode,401,'codes are single use');
 }finally{await app.close();}
});

test('a department with one manager can still create the manager\'s own task: the owner\'s manager reviews',async()=>{
 const {app,call}=await setup();
 try{
  const due=new Date(Date.now()+3*864e5).toISOString();
  const before=await call('m1','POST','/tasks',{title:'Manager own task',ownerId:'m1',dueAt:due,description:'A task the department manager owns personally',criteria:['done']});
  assert.equal(before.statusCode,400,'no other manager in marketing and no reporting line yet');
  await call('m1','PATCH','/org/members/m1',{managerId:'m4'});
  const after=await call('m1','POST','/tasks',{title:'Manager own task',ownerId:'m1',dueAt:due,description:'A task the department manager owns personally',criteria:['done']});
  assert.equal(after.statusCode,201,after.body);assert.equal(after.json().reviewer_id??after.json().task?.reviewer_id,'m4');
  const reviewerView=(await call('m4','GET','/tasks')).json().items;assert.ok(reviewerView.some((t:any)=>t.title==='Manager own task'),'the cross-department reviewer sees the task');
  const dir=(await call('m1','GET','/directory')).json();assert.ok(dir.reviewers.some((u:any)=>u.id==='m4'&&u.outsideDepartment));
 }finally{await app.close();}
});
