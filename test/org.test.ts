import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';

const PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function setup(){
 const db=await createDatabase();await db.exec(schema);await db.exec(schema);await seedDemo(db);
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']}});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PATCH'|'PUT'|'DELETE',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 return {db,app,call};
}

test('employees edit their own contact info; invalid values are rejected; directory shows contacts',async()=>{
 const {app,call}=await setup();
 try{
  const locked=await call('m2','PATCH','/me/profile',{location:'Irvine, CA'});assert.equal(locked.statusCode,403,'employees cannot set their own work location');assert.equal(locked.json().error.code,'LOCATION_ADMIN_ONLY');
  const ok=await call('m2','PATCH','/me/profile',{title:'Content lead',phone:'+1 (949) 555-0100',email:'chen@example.com',wechat:'chen_yi',timezone:'America/Los_Angeles'});
  assert.equal(ok.statusCode,200,ok.body);assert.equal(ok.json().email,'chen@example.com');
  assert.equal((await call('m2','PATCH','/me/profile',{email:'not-an-email'})).statusCode,400);
  assert.equal((await call('m2','PATCH','/me/profile',{phone:'call me'})).statusCode,400);
  assert.equal((await call('m2','PATCH','/me/profile',{role:'manager'})).statusCode,400,'role cannot be self-assigned');
  const me=(await call('m2','GET','/me')).json();assert.equal(me.title,'Content lead');assert.equal(me.isAdmin,false);
  const dir=(await call('m3','GET','/directory')).json().items.find((u:any)=>u.id==='m2');
  assert.equal(dir.phone,'+1 (949) 555-0100');assert.equal(dir.timezone,'America/Los_Angeles');
  assert.ok(!('is_admin' in dir)&&!('role_override' in dir),'admin fields are not public');
 }finally{await app.close();}
});

test('avatar upload, serve within the organization, and removal',async()=>{
 const {app,call}=await setup();
 try{
  assert.equal((await call('m2','PUT','/me/avatar',{dataUrl:'data:image/svg+xml;base64,PHN2Zz4='})).statusCode,400,'SVG is not accepted');
  const up=await call('m2','PUT','/me/avatar',{dataUrl:PNG});assert.equal(up.statusCode,200,up.body);assert.equal(up.json().avatarVersion,1);
  const img=await call('m4','GET','/users/m2/avatar');assert.equal(img.statusCode,200);assert.equal(img.headers['content-type'],'image/png');assert.equal(img.headers['x-content-type-options'],'nosniff');
  assert.equal((await call('m2','GET','/directory')).json().items.find((u:any)=>u.id==='m2').avatar_version,1);
  assert.equal((await call('m2','DELETE','/me/avatar')).json().avatarVersion,0);
  assert.equal((await call('m3','GET','/users/m2/avatar')).statusCode,404);
 }finally{await app.close();}
});

test('only admins manage reporting lines, titles, roles and admins; cycles are rejected',async()=>{
 const {app,call}=await setup();
 try{
  assert.equal((await call('m2','GET','/org/members')).statusCode,403);
  const chart=(await call('m2','GET','/org/chart'));assert.equal(chart.statusCode,200,'any member can read the org chart');
  const row=chart.json().items.find((u:any)=>u.id==='m1');assert.ok(row&&'location' in row&&'title' in row);assert.ok(!('email' in row)&&!('phone' in row)&&!('grants' in row),'org chart exposes no contact details or grants');
  assert.equal((await call('m4','PATCH','/org/members/m2',{managerId:'m4'})).statusCode,403,'manager role alone is not admin');
  const list=(await call('m1','GET','/org/members')).json().items;assert.ok(list.find((u:any)=>u.id==='m1').adminSource==='deployment');
  assert.equal((await call('m1','PATCH','/org/members/m2',{managerId:'m1',title:'Designer'})).json().manager_id,'m1');
  await call('m1','PATCH','/org/members/m3',{managerId:'m2'});
  const cycle=await call('m1','PATCH','/org/members/m2',{managerId:'m3'});assert.equal(cycle.statusCode,400);assert.equal(cycle.json().error.code,'REPORTING_CYCLE');
  assert.equal((await call('m1','PATCH','/org/members/m2',{managerId:'m2'})).statusCode,400);
  const promoted=await call('m1','PATCH','/org/members/m2',{role:'manager',isAdmin:true});assert.equal(promoted.json().role,'manager');assert.equal(promoted.json().admin,true);
  assert.equal((await call('m2','GET','/me')).json().isAdmin,true);
  assert.equal((await call('m2','PATCH','/org/members/m2',{isAdmin:false})).statusCode,400,'app admins cannot remove themselves');
  assert.equal((await call('m1','PATCH','/org/members/m2',{isAdmin:false,role:'employee'})).json().admin,false);
 }finally{await app.close();}
});

test('role set in the app survives the next DingTalk-style login update',async()=>{
 const {db,app,call}=await setup();
 try{
  await call('m1','PATCH','/org/members/m3',{role:'manager'});
  await db.query("UPDATE users SET display_name='许夏',role=COALESCE(role_override,'employee') WHERE id='m3'");
  assert.equal((await db.query("SELECT role FROM users WHERE id='m3'")).rows[0].role,'manager');
 }finally{await app.close();}
});

test('team report follows reporting lines (direct and indirect) and computes outcomes',async()=>{
 const {db,app,call}=await setup();
 try{
  await call('m1','PATCH','/org/members/m2',{managerId:'m3'});
  await call('m1','PATCH','/org/members/m5',{managerId:'m2'});
  await db.exec(`UPDATE tasks SET due_at=now()-interval '2 day' WHERE owner_id='m2';`);
  const none=(await call('m4','GET','/reports/team')).json();assert.equal(none.members.length,0,'no reports, nothing to see');
  const lead=(await call('m3','GET','/reports/team')).json();
  assert.deepEqual(lead.members.map((m:any)=>m.id).sort(),['m2','m5']);
  const m2=lead.members.find((m:any)=>m.id==='m2');assert.equal(m2.depth,1);assert.ok(m2.stats.total>=1);assert.ok(m2.stats.overdue>=1);assert.ok(m2.attention.length>=1);
  assert.equal(lead.members.find((m:any)=>m.id==='m5').depth,2);
  assert.equal((await call('m3','GET','/reports/team?scope=all')).json().scope,'reports','scope=all needs admin');
  const all=(await call('m1','GET','/reports/team?scope=all')).json();assert.equal(all.scope,'all');assert.ok(all.members.length>=5);
  assert.ok(!JSON.stringify(all).includes('description'),'no task bodies in the report');
 }finally{await app.close();}
});

test('feature grants for the product area are admin-managed and visible on /me',async()=>{
 const {app,call}=await setup();
 try{
  assert.deepEqual((await call('m2','GET','/me')).json().grants,[]);
  assert.equal((await call('m1','PATCH','/org/members/m2',{grants:['product_cost_detail']})).statusCode,400,'detail needs area access');
  assert.equal((await call('m1','PATCH','/org/members/m2',{grants:['products','bogus']})).statusCode,400);
  const ok=await call('m1','PATCH','/org/members/m2',{grants:['products']});assert.equal(ok.statusCode,200,ok.body);assert.deepEqual(ok.json().grants,['products']);
  assert.deepEqual((await call('m2','GET','/me')).json().grants,['products']);
  assert.equal((await call('m4','PATCH','/org/members/m2',{grants:['products','product_cost_detail']})).statusCode,403);
  assert.ok(!('grants' in (await call('m3','GET','/directory')).json().items[0]),'grants are not public');
 }finally{await app.close();}
});

test('administrators set each member\'s work location; it shows on the org chart',async()=>{
 const {app,call}=await setup();
 try{
  assert.equal((await call('m4','PATCH','/org/members/m2',{location:'武汉'})).statusCode,403);
  const r=await call('m1','PATCH','/org/members/m2',{location:'武汉'});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().location,'武汉');
  assert.equal((await call('m3','GET','/org/chart')).json().items.find((u:any)=>u.id==='m2').location,'武汉');
  assert.equal((await call('m1','PATCH','/me/profile',{location:'Irvine, CA'})).statusCode,200,'an admin may still set their own');
 }finally{await app.close();}
});

test('everyone fills in a Chinese and an English name; admins can complete them; the org chart returns both',async()=>{
 const {app,call}=await setup();
 try{
  const r=await call('m2','PATCH','/me/profile',{nameZh:'陈一',nameEn:'Yi Chen'});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().name_en,'Yi Chen');
  assert.equal((await call('m2','PATCH','/me/profile',{nameEn:'陈一'})).statusCode,400,'English name uses Latin letters');
  assert.equal((await call('m1','PATCH','/org/members/m3',{nameZh:'许夏',nameEn:'Xia Xu'})).json().name_en,'Xia Xu');
  assert.equal((await call('m4','PATCH','/org/members/m3',{nameEn:'X'})).statusCode,403);
  const chart=(await call('m5','GET','/org/chart')).json().items;assert.equal(chart.find((u:any)=>u.id==='m3').name_en,'Xia Xu');assert.equal(chart.find((u:any)=>u.id==='m2').name_zh,'陈一');
  assert.equal((await call('m2','GET','/me')).json().name_zh,'陈一');
 }finally{await app.close();}
});
