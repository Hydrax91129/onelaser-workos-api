import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import Fastify from 'fastify';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {registerHrRoutes,keyringFrom} from '../src/hr.js';

const KEY=randomBytes(32).toString('base64');
const clock=()=>new Date('2026-11-02T10:00:00Z').getTime();
async function setup(hr:{dataKey?:string;previousKeys?:string[]}={dataKey:KEY},db?:Database){
 if(!db){db=await createDatabase();await db.exec(schema);await seedDemo(db);
  // m2 reports to m1; m4 is HR (and a manager of another department)
  await db.query("UPDATE users SET manager_id='m1' WHERE id='m2'");
  // m4 is HR for China (granted per person; WORKOS_HR_USER_IDS no longer opens anything) and everyone here is in China.
  await db.query(`UPDATE users SET grants='["hr_cn_manage"]' WHERE id='m4'`);
  await db.query("INSERT INTO hr_profiles(user_id,org_id,region,version) SELECT id,org_id,'cn',0 FROM users ON CONFLICT DO NOTHING");}
 const app=await buildApp({db,integrations:{executiveUserIds:['m6']},hr:{userIds:['m4'],...hr},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock,closeDatabase:false});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:any,lang='zh')=>{tokens[who]??=(await issueSession(db!,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who],'accept-language':lang}});};
 return {db,app,call};
}

test('HR records: who sees whom, versioned profile edits and history',async()=>{
 const {db,app,call}=await setup();
 try{
  assert.equal((await call('m3','GET','/capabilities')).json().hr,true);
  assert.deepEqual((await call('m4','GET','/hr/access')).json(),{isHr:true,global:false,regions:{us:null,cn:'manage',intl:null},hasReports:false,sensitive:'configured'});
  assert.equal((await call('m1','GET','/hr/access')).json().isHr,false,'company admins are not HR by default (m1 is a manager, not the owner)');
  assert.deepEqual((await call('m3','GET','/hr/people')).json().items.map((p:any)=>p.id),['m3'],'employees see only themselves');
  assert.deepEqual((await call('m1','GET','/hr/people')).json().items.map((p:any)=>p.id).sort(),['m1','m2'],'managers see their reports');
  assert.equal((await call('m4','GET','/hr/people')).json().items.length,6,'HR sees everyone');
  assert.equal((await call('m3','GET','/hr/people/m2')).statusCode,404,'not in my scope');

  assert.equal((await call('m1','PUT','/hr/people/m2/profile',{expectedVersion:0,jobLevel:'P3'})).statusCode,403);
  const p=await call('m4','PUT','/hr/people/m2/profile',{expectedVersion:0,hireDate:'2025-03-01',employmentType:'full_time',probationEnd:'2025-06-01',contractStart:'2025-03-01',contractEnd:'2028-02-29',jobLevel:'P3',notes:'HR only note'});
  assert.equal(p.statusCode,200,p.body);assert.equal(p.json().profile.version,1);
  assert.equal((await call('m4','PUT','/hr/people/m2/profile',{expectedVersion:0,jobLevel:'P4'})).statusCode,409,'stale version');
  assert.equal((await call('m4','PUT','/hr/people/m2/profile',{expectedVersion:1,hireDate:'2025-13-01'})).statusCode,400);
  assert.equal((await call('m4','PUT','/hr/people/m2/profile',{expectedVersion:1,status:'leaving',lastDay:'2026-11-30'})).json().profile.version,2);
  assert.equal((await call('m4','POST','/hr/people/m2/events',{kind:'warning',happenedOn:'2026-10-01',note:'迟到'})).statusCode,201);

  const hrView=(await call('m4','GET','/hr/people/m2')).json();
  assert.equal(hrView.profile.notes,'HR only note');assert.equal(hrView.tenureDays,611);
  assert.deepEqual(hrView.events.map((e:any)=>e.kind).sort(),['joined','leaving','warning']);
  const mgr=(await call('m1','GET','/hr/people/m2')).json();
  assert.equal(mgr.access,'manager');assert.equal(mgr.profile.jobLevel,'P3');
  assert.equal(mgr.profile.notes,undefined);assert.equal(mgr.secrets,undefined);assert.equal(mgr.salary,undefined);assert.equal(mgr.documents,undefined);
  assert.ok(!mgr.events.some((e:any)=>e.kind==='warning'),'managers do not see warnings');
  const self=(await call('m2','GET','/hr/people/m2')).json();
  assert.equal(self.access,'self');assert.equal(self.profile.notes,undefined,'internal HR notes stay with HR');assert.ok(self.secrets);

  const audit=(await db.query("SELECT details FROM audit_events WHERE action='hr.profile.update'")).rows;
  assert.ok(audit.length>=2);assert.ok(!JSON.stringify(audit).includes('HR only note'),'audit holds field names, not values');
  const en=await call('m1','PUT','/hr/people/m2/profile',{expectedVersion:2,jobLevel:'P4'},'en');
  assert.equal(en.json().error.message,'Only HR can do this');
  assert.match((await call('m1','PUT','/hr/people/m2/profile',{expectedVersion:2,jobLevel:'P4'})).json().error.message,/人事/);
 }finally{await app.close();await db.close();}
});

test('HR sensitive data: encrypted at rest, shown in full to whoever may read the record, never to managers',async()=>{
 const {db,app,call}=await setup();
 try{
  const put=await call('m4','PUT','/hr/people/m2/secrets',{idNumber:'TEST-0000-0000-1234',bankAccount:'0000 0000 1234 5678',emergencyPhone:'000-000-0000'});
  assert.equal(put.statusCode,200,put.body);
  const rows=(await db.query("SELECT * FROM hr_secrets WHERE user_id='m2'")).rows;
  assert.equal(rows.length,3);
  for(const r of rows)for(const plain of ['TEST-0000','0000 0000','000-000-0000'])assert.ok(!r.ciphertext.includes(plain),'no plaintext in the database');
  assert.equal((await call('m4','POST','/hr/people/m2/salary',{effectiveDate:'2026-01-01',base:12000,allowance:800,reason:'年度调薪'})).statusCode,201);
  assert.ok(!JSON.stringify((await db.query("SELECT ciphertext FROM hr_salary")).rows).includes('12000'));

  const view=(await call('m4','GET','/hr/people/m2')).json();
  assert.equal(view.secrets.idNumber.value,'TEST-0000-0000-1234','no masking: HR for the region sees the full value');assert.equal(view.secrets.bankAccount.value,'0000 0000 1234 5678');
  assert.equal(view.salary.set,true);assert.equal(view.salary.latestEffective,'2026-01-01');
  const sal=view.salary.list;
  assert.equal(sal[0].base,12000);assert.equal(sal[0].allowance,800);assert.equal(sal[0].currency,'CNY');assert.equal(sal[0].reason,'年度调薪');

  const mgr=(await call('m1','GET','/hr/people/m2')).json();
  assert.equal(mgr.secrets,undefined);assert.equal(mgr.salary,undefined);assert.ok(!JSON.stringify(mgr).includes('TEST-0000'),'managers never see sensitive values');
  assert.equal((await call('m1','POST','/hr/people/m2/reveal',{field:'idNumber'})).statusCode,403);
  assert.equal((await call('m1','PUT','/hr/people/m2/secrets',{idNumber:'X1234'})).statusCode,403);
  assert.equal((await call('m2','GET','/hr/people/m2')).json().secrets.bankAccount.value,'0000 0000 1234 5678','people can see their own');
  assert.equal((await call('m3','GET','/hr/people/m2')).statusCode,404);
  assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'hr.%view%' OR action='hr.sensitive.reveal'")).rows[0].n,0,'reading is not logged');

  // clearing a field removes it; a ciphertext moved onto another person does not decrypt
  assert.equal((await call('m4','PUT','/hr/people/m2/secrets',{emergencyPhone:''})).json().updated[0],'emergencyPhone');
  assert.equal((await call('m4','GET','/hr/people/m2')).json().secrets.emergencyPhone.set,false);
  await db.query("INSERT INTO hr_secrets(org_id,user_id,field,ciphertext,key_id,hint,updated_by) SELECT org_id,'m3',field,ciphertext,key_id,hint,updated_by FROM hr_secrets WHERE user_id='m2' AND field='id_number'");
  const moved=await call('m4','GET','/hr/people/m3');
  assert.equal(moved.statusCode,200);assert.equal(moved.json().secrets.idNumber.value,null,'a moved ciphertext does not decrypt');
 }finally{await app.close();await db.close();}
});

test('HR data key: missing or invalid key disables only sensitive features; rotation keeps old values readable',async()=>{
 assert.equal(keyringFrom({}).status,'not_configured');
 assert.equal(keyringFrom({dataKey:'short'}).status,'invalid_key');
 const first=await setup();
 await first.call('m4','PUT','/hr/people/m2/secrets',{idNumber:'TEST-0000-0000-1234'});
 await first.app.close();
 const db=first.db;
 try{
  const none=await setup({},db);
  assert.equal((await none.call('m4','GET','/hr/access')).json().sensitive,'not_configured');
  assert.equal((await none.call('m4','PUT','/hr/people/m3/profile',{expectedVersion:0,jobLevel:'P2'})).statusCode,200,'profiles work without a key');
  const blocked=await none.call('m4','PUT','/hr/people/m2/secrets',{idNumber:'X12345'});
  assert.equal(blocked.statusCode,501);assert.equal(blocked.json().error.code,'HR_KEY_NOT_CONFIGURED');
  assert.equal((await none.call('m4','GET','/hr/people/m2')).json().secrets.idNumber.hint,'****1234','masked hints still show');
  await none.app.close();

  const NEW=randomBytes(32).toString('base64');
  const rotated=await setup({dataKey:NEW,previousKeys:[KEY]},db);
  assert.equal((await rotated.call('m4','POST','/hr/people/m2/reveal',{field:'idNumber',reason:'轮换后核对'})).json().value,'TEST-0000-0000-1234');
  await rotated.app.close();
  const lost=await setup({dataKey:NEW},db);
  const gone=await lost.call('m4','POST','/hr/people/m2/reveal',{field:'idNumber',reason:'旧密钥已删'});
  assert.equal(gone.statusCode,409);assert.equal(gone.json().error.code,'HR_KEY_UNAVAILABLE');
  await lost.app.close();
 }finally{await db.close();}
});

test('HR documents: encrypted files, HR and the person only, type and size limits',async()=>{
 const {db,app,call}=await setup();
 const pdf=Buffer.from('%PDF-1.4 labor contract for m2');
 try{
  const up=await call('m4','POST','/hr/people/m2/documents',{kind:'contract',name:'劳动合同.pdf',mime:'application/pdf',dataBase64:pdf.toString('base64'),expiresOn:'2026-11-20'});
  assert.equal(up.statusCode,201,up.body);const docId=up.json().id;
  const stored=(await db.query('SELECT data FROM hr_documents WHERE id=$1',[docId])).rows[0].data;
  assert.ok(!Buffer.from(stored).includes(Buffer.from('labor contract')),'file content is encrypted');
  assert.equal((await call('m4','POST','/hr/people/m2/documents',{kind:'other',name:'x.svg',mime:'image/svg+xml',dataBase64:pdf.toString('base64')})).statusCode,400);
  assert.equal((await call('m2','POST','/hr/people/m2/documents',{kind:'other',name:'a.pdf',mime:'application/pdf',dataBase64:pdf.toString('base64')})).statusCode,403,'only HR uploads');
  const doc=(await call('m4','GET','/hr/people/m2')).json().documents[0];
  assert.equal(doc.name,'劳动合同.pdf');assert.equal(doc.daysToExpiry,18);
  const own=await call('m2','GET',`/hr/people/m2/documents/${docId}`);
  assert.equal(own.statusCode,200);assert.equal(own.headers['content-type'],'application/pdf');assert.equal(own.headers['cache-control'],'no-store');
  assert.deepEqual(own.rawPayload,pdf);
  assert.equal((await call('m1','GET',`/hr/people/m2/documents/${docId}`)).statusCode,403,'managers cannot open documents');
  assert.equal((await call('m4','DELETE',`/hr/people/m2/documents/${docId}`)).statusCode,200);
  assert.equal((await call('m4','GET','/hr/people/m2')).json().documents.length,0);
 }finally{await app.close();await db.close();}
});

test('HR reminders: probation, contract and document dates reach HR once per threshold',async()=>{
 const {db,app,call}=await setup();
 try{
  await call('m4','PUT','/hr/people/m2/profile',{expectedVersion:0,hireDate:'2026-08-10',probationEnd:'2026-11-09',contractEnd:'2026-12-01'});
  await call('m4','PUT','/hr/people/m3/profile',{expectedVersion:0,contractEnd:'2027-06-01'});
  const due=(await call('m4','GET','/hr/reminders')).json().items;
  assert.deepEqual(due.map((i:any)=>[i.kind,i.userId,i.days]),[['probation_end','m2',7],['contract_end','m2',29]]);
  assert.equal((await call('m1','GET','/hr/reminders')).statusCode,403);

  const worker=Fastify();
  const {runReminders}=await registerHrRoutes(worker,db,{userIds:['m4'],dataKey:KEY,now:clock});
  assert.equal(await runReminders(),2);
  assert.equal(await runReminders(),0,'each threshold is sent once');
  const inbox=(await call('m4','GET','/inbox')).json().items.filter((i:any)=>i.kind==='hr_reminder');
  assert.equal(inbox.length,2);assert.match(inbox.map((i:any)=>i.title).join('|'),/陈一 的试用期还有 7 天结束/);
  assert.equal((await call('m2','GET','/inbox')).json().items.filter((i:any)=>i.kind==='hr_reminder').length,0,'only HR is reminded');
  await worker.close();
 }finally{await app.close();await db.close();}
});
