import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import Fastify from 'fastify';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {registerHrRoutes} from '../src/hr.js';

/* Fictional people only. SSN 000-00-0000 and routing 000000000 are never valid numbers. */
const KEY=randomBytes(32).toString('base64');
const clock=()=>new Date('2026-11-02T10:00:00Z').getTime();
const PDF=Buffer.from('%PDF-1.4\n% fictional test file\n').toString('base64');
const PNG=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]).toString('base64');
const DOCX=Buffer.from([0x50,0x4b,0x03,0x04,0x14,0,0,0]).toString('base64');

/* m6 = company owner. m3 is on the legacy WORKOS_HR_USER_IDS list, which no longer opens anything.
 * m2 (US, reports to m1) and m1 (China) are the people on file; grants are given per test. */
async function setup(){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query("UPDATE users SET manager_id='m1' WHERE id='m2'");
 const app=await buildApp({db,integrations:{executiveUserIds:['m6']},hr:{dataKey:KEY,userIds:['m3']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock,closeDatabase:false});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:any,lang='zh')=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who],'accept-language':lang}});};
 return {db,app,call};
}
const ok=(r:any,code=200)=>{assert.equal(r.statusCode,code,r.body);return r.json();};
const version=async(call:any,id:string)=>ok(await call('m6','GET','/hr/people/'+id)).profile.version;

const US_DETAILS={legal:{firstName:'Test',middleName:'Q',lastName:'Person',preferredName:'Tess',dateOfBirth:'1990-01-01',gender:'decline'},
 contact:{phone:'000-000-0000',personalEmail:'test.person@example.com',address:{line1:'1 Example Street',city:'Sampletown',state:'CA',postalCode:'00000',country:'US'}},
 workAuth:{i9Status:'citizen',taxState:'CA'}};
const US_PAYROLL={comp:{payType:'hourly',flsa:'non_exempt',payFrequency:'biweekly',standardHours:40},
 commission:{plan:'tiered',tiers:[{from:0,to:10000,rate:2},{from:10000,to:null,rate:3}],basis:'fictional plan'},
 bonus:{eligible:true,type:'annual',amountType:'fixed',amount:500},
 benefits:{medical:{status:'enrolled',plan:'Example PPO',tier:'family',deduction:120},dental:{status:'waived'},retirement:{enrolled:true,employeePercent:4,employerMatch:'fictional match'},
  hsa:{enrolled:true,perPeriod:50},life:{coverage:'1x salary',beneficiaries:[{name:'Sample Spouse',relation:'spouse',percent:100}]},pto:{daysPerYear:10}},
 family:{maritalStatus:'married'},
 dependents:[{name:'Sample Spouse',relation:'spouse',dateOfBirth:'1991-02-02',ssn:'000-00-0001'},{name:'Sample Child',relation:'child',dateOfBirth:'2020-03-03',ssn:'000-00-0002'}],
 directDeposit:[{bankName:'Example Bank',routing:'000000000',account:'000012345',accountType:'checking',split:'percent',value:80},{bankName:'Example Credit Union',routing:'000000000',account:'000067890',accountType:'savings',split:'remainder'}],
 w4:{formYear:2026,filingStatus:'mfj_or_qss',multipleJobs:true,dependentsAmount:4000,otherIncome:0,deductions:0,extraWithholding:25,exempt:false},
 de4:{filingStatus:'married_one_income',allowances:2,additionalAllowances:0,extraWithholding:0,exempt:false}};

test('HR regions: only the owner hands out access and regions; there is no US grant and the legacy HR list opens nothing',async()=>{
 const {db,app,call}=await setup();
 try{
  await db.query("UPDATE users SET is_admin=true WHERE id='m1'");
  assert.equal((await call('m1','PATCH','/org/members/m4',{grants:['hr_cn_manage']})).statusCode,403,'in-app admins cannot hand out HR access');
  assert.deepEqual(ok(await call('m6','PATCH','/org/members/m4',{grants:['hr_cn_manage']})).grants,['hr_cn_manage']);
  ok(await call('m6','PATCH','/org/members/m5',{grants:['hr_cn_view']}));
  for(const g of ['hr_us_view','hr_us_manage'])assert.equal((await call('m6','PATCH','/org/members/m5',{grants:[g]})).statusCode,400,`${g} does not exist`);

  assert.equal((await call('m4','PUT','/hr/people/m1/region',{region:'cn'})).statusCode,403,'regional HR cannot set regions');
  assert.equal((await call('m3','PUT','/hr/people/m1/region',{region:'cn'})).statusCode,403,'nor can the legacy HR list');
  ok(await call('m6','PUT','/hr/people/m2/region',{region:'us'}));
  ok(await call('m6','PUT','/hr/people/m1/region',{region:'cn'}));
  assert.deepEqual((await db.query("SELECT details FROM audit_events WHERE action='hr.region.update' AND object_id='m2'")).rows[0].details,{from:'',to:'us'});

  const owner=ok(await call('m6','GET','/hr/people'));
  assert.equal(owner.items.length,6);assert.equal(owner.canAssignRegion,true);assert.equal(owner.canExportUs,true);
  assert.deepEqual(owner.regions,{us:'manage',cn:'manage',intl:'manage'});

  const cn=ok(await call('m4','GET','/hr/people'));
  assert.deepEqual(cn.items.map((p:any)=>p.id).sort(),['m1','m4'],'China HR: the China people plus themself, never the US');
  assert.deepEqual(cn.regions,{us:null,cn:'manage',intl:null});assert.equal(cn.canExportUs,false);
  assert.equal(cn.items.find((p:any)=>p.id==='m1').access,'hr');
  assert.equal(ok(await call('m5','GET','/hr/people')).items.find((p:any)=>p.id==='m1').access,'view');

  const legacy=ok(await call('m3','GET','/hr/access'));
  assert.deepEqual(legacy,{isHr:false,global:false,regions:{us:null,cn:null,intl:null},hasReports:false,sensitive:'configured'},'WORKOS_HR_USER_IDS alone opens no region');
  assert.deepEqual(ok(await call('m3','GET','/hr/people')).items.map((p:any)=>p.id),['m3']);
  assert.equal((await call('m3','GET','/hr/people/m1')).statusCode,404);
  assert.equal((await call('m3','GET','/hr/reminders')).statusCode,403);
 }finally{await app.close();await db.close();}
});

test('HR regions: US records are for the company owner only, with Rippling-style fields, EEO kept apart',async()=>{
 const {db,app,call}=await setup();
 try{
  ok(await call('m6','PATCH','/org/members/m4',{grants:['hr_cn_manage','hr_intl_manage']}));
  ok(await call('m6','PATCH','/org/members/m5',{grants:['hr_cn_view','hr_intl_view']}));
  ok(await call('m6','PUT','/hr/people/m2/region',{region:'us'}));
  const d=ok(await call('m6','PUT','/hr/people/m2/details',{expectedVersion:await version(call,'m2'),details:US_DETAILS}));
  assert.equal(d.details.legal.dateOfBirth,'1990-01-01');
  assert.equal((await call('m6','PUT','/hr/people/m2/details',{expectedVersion:d.version-1,details:US_DETAILS})).statusCode,409,'stale version');
  const p1=ok(await call('m6','PUT','/hr/people/m2/payroll',{expectedVersion:null,payroll:US_PAYROLL}));
  assert.equal(p1.payroll.directDeposit[1].split,'remainder');
  assert.equal((await call('m6','PUT','/hr/people/m2/payroll',{expectedVersion:null,payroll:US_PAYROLL})).statusCode,409);
  assert.equal((await call('m6','PUT','/hr/people/m2/payroll',{expectedVersion:p1.version,payroll:{directDeposit:[{routing:'12345'}]}})).statusCode,400,'routing has 9 digits');
  ok(await call('m6','PUT','/hr/people/m2/secrets',{ssn:'000-00-0000'}));
  ok(await call('m6','PUT','/hr/people/m2/eeo',{ethnicity:'decline',veteran:'not_protected'}));
  ok(await call('m6','POST','/hr/people/m2/salary',{effectiveDate:'2026-01-01',base:20,currency:'USD',period:'hour',reason:'fictional starting rate'}),201);
  ok(await call('m6','POST','/hr/people/m2/documents',{kind:'offer_letter',name:'offer.pdf',mime:'application/pdf',dataBase64:PDF}),201);

  const stored=JSON.stringify((await db.query("SELECT * FROM hr_secrets WHERE user_id='m2'")).rows);
  for(const plain of ['000-00-0000','000-00-0001','000012345','not_protected','mfj_or_qss','Sample Spouse'])assert.ok(!stored.includes(plain),'no plaintext at rest: '+plain);
  assert.ok((await db.query("SELECT 1 FROM hr_secrets WHERE user_id='m2' AND field='eeo'")).rows.length,'EEO answers are stored on their own');

  // The owner sees everything in full: no masking, no reveal step.
  const own=ok(await call('m6','GET','/hr/people/m2'));
  assert.equal(own.access,'hr');assert.equal(own.secrets.ssn.value,'000-00-0000');
  assert.equal(own.payroll.data.dependents[0].ssn,'000-00-0001');assert.equal(own.payroll.data.directDeposit[0].account,'000012345');
  assert.equal(own.eeo.veteran,'not_protected');assert.equal(own.salary.list[0].base,20);

  // Nobody else reads any US endpoint: regional HR (manage or read-only), the legacy HR list.
  const docId=own.documents[0].id;
  for(const who of ['m4','m5','m3']){
   for(const [method,url,body] of [['GET','/hr/people/m2'],['GET','/hr/people/m2/payroll'],['POST','/hr/people/m2/reveal',{field:'ssn'}],['GET',`/hr/people/m2/documents/${docId}`],
    ['PUT','/hr/people/m2/details',{expectedVersion:0,details:{}}],['PUT','/hr/people/m2/secrets',{ssn:'000-00-0003'}],['PUT','/hr/people/m2/eeo',{}]] as const){
    const r=await call(who,method,url,body);assert.equal(r.statusCode,404,`${who} ${method} ${url}: ${r.body}`);
   }
   assert.ok(!ok(await call(who,'GET','/hr/people')).items.some((p:any)=>p.id==='m2'),`${who} does not list US people`);
   assert.equal((await call(who,'POST','/hr/exports/us')).statusCode,403);
  }
  // The employee and their manager: basic employment facts only.
  for(const who of ['m2','m1']){
   const v=ok(await call(who,'GET','/hr/people/m2'));
   assert.equal(v.access,who==='m2'?'basic':'manager');
   for(const k of ['details','secrets','payroll','salary','documents','eeo'])assert.equal(v[k],undefined,`${who} gets no ${k}`);
   assert.ok(!JSON.stringify(v).includes('000-00-0000'));
   assert.equal((await call(who,'GET','/hr/people/m2/payroll')).statusCode,403);
   assert.equal((await call(who,'GET',`/hr/people/m2/documents/${docId}`)).statusCode,403);
  }
  ok(await call('m6','PUT','/hr/people/m1/region',{region:'cn'}));
  assert.equal((await call('m6','PUT','/hr/people/m1/eeo',{ethnicity:'decline'})).statusCode,400,'EEO is US only');
  assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'hr.%view%' OR action='hr.sensitive.reveal'")).rows[0].n,0,'reading is not logged');
 }finally{await app.close();await db.close();}
});

test('HR regions: China read-only sees everything in full but changes nothing; manage edits; self sees only basics',async()=>{
 const {db,app,call}=await setup();
 try{
  ok(await call('m6','PATCH','/org/members/m4',{grants:['hr_cn_manage']}));
  ok(await call('m6','PATCH','/org/members/m5',{grants:['hr_cn_view']}));
  ok(await call('m6','PUT','/hr/people/m1/region',{region:'cn'}));
  ok(await call('m6','PUT','/hr/people/m4/region',{region:'cn'}));
  ok(await call('m4','PUT','/hr/people/m1/details',{expectedVersion:await version(call,'m1'),details:{legal:{nativeName:'示例员工'},cn:{hukouLocation:'示例省示例市',hukouType:'urban',currentAddress:'示例路 1 号',contractType:'fixed_term'},education:{level:'master'}}}));
  const pay=ok(await call('m4','PUT','/hr/people/m1/payroll',{expectedVersion:null,payroll:{
   socialInsurance:{city:'示例市',base:5000,pension:{personal:8,employer:16},medical:{personal:2,employer:9},unemployment:{personal:0.5,employer:0.5},injury:{employer:0.2},maternity:{employer:0.8}},
   housingFund:{base:5000,personal:7,employer:7},specialDeductions:{childEducation:{claimed:true,count:1,monthly:2000},elderlySupport:{claimed:true,monthly:1500,note:'示例'}},family:{maritalStatus:'married',children:1}}}));
  ok(await call('m4','PUT','/hr/people/m1/secrets',{idNumber:'000000000000000000',bankAccount:'0000 0000 0000 0000'}));
  ok(await call('m4','POST','/hr/people/m1/salary',{effectiveDate:'2026-01-01',base:10000,currency:'CNY',period:'month'}),201);

  const ro=ok(await call('m5','GET','/hr/people/m1'));
  assert.equal(ro.access,'view');assert.equal(ro.canManage,false);
  assert.equal(ro.secrets.idNumber.value,'000000000000000000');assert.equal(ro.secrets.bankAccount.value,'0000 0000 0000 0000','read-only sees bank details too');
  assert.equal(ro.payroll.data.socialInsurance.pension.employer,16);assert.equal(ro.salary.list[0].base,10000);
  for(const [method,url,body] of [
   ['PUT','/hr/people/m1/profile',{expectedVersion:ro.profile.version,jobLevel:'P9'}],
   ['PUT','/hr/people/m1/details',{expectedVersion:ro.profile.version,details:{}}],
   ['PUT','/hr/people/m1/payroll',{expectedVersion:pay.version,payroll:{}}],
   ['PUT','/hr/people/m1/secrets',{idNumber:'000000000000000001'}],
   ['POST','/hr/people/m1/salary',{effectiveDate:'2026-02-01',base:1,currency:'CNY',period:'month'}],
   ['POST','/hr/people/m1/events',{kind:'other',happenedOn:'2026-02-01'}],
   ['POST','/hr/people/m1/documents',{kind:'contract',name:'c.pdf',mime:'application/pdf',dataBase64:PDF}],
  ] as const){const r=await call('m5',method,url,body);assert.equal(r.statusCode,403,`${method} ${url}: ${r.body}`);}
  assert.match((await call('m5','PUT','/hr/people/m1/secrets',{idNumber:'000000000000000001'})).json().error.message,/只读/);

  // The person themself: basic employment facts only, like in the US (self-service is phase 2).
  const self=ok(await call('m1','GET','/hr/people/m1'));
  assert.equal(self.access,'basic');
  for(const k of ['details','secrets','payroll','salary','documents'])assert.equal(self[k],undefined,`self gets no ${k}`);
  assert.ok(!JSON.stringify(self).includes('000000000000000000'));
  for(const [method,url,body] of [['GET','/hr/people/m1/payroll'],['POST','/hr/people/m1/reveal',{field:'idNumber'}],['GET','/hr/people/m1/documents/x']] as const)
   assert.equal((await call('m1',method,url,body)).statusCode,403,`self ${method} ${url}`);
  assert.equal((await call('m1','PUT','/hr/people/m1/details',{expectedVersion:self.profile.version,details:{}})).statusCode,403,'no one edits their own record');
  assert.equal(ok(await call('m4','GET','/hr/people/m4')).access,'basic','China HR sees only basics of their own record too');
  assert.equal((await call('m4','POST','/hr/people/m4/salary',{effectiveDate:'2026-02-01',base:1,currency:'CNY',period:'month'})).statusCode,403);
  assert.equal((await call('m3','GET','/hr/people/m1')).statusCode,404,'no grant, no access');

  // Documents: typed, content checked, downloadable only by people with access.
  const doc=ok(await call('m4','POST','/hr/people/m1/documents',{kind:'resume',name:'resume.pdf',mime:'application/pdf',dataBase64:PDF}),201);
  ok(await call('m4','POST','/hr/people/m1/documents',{kind:'contract',name:'contract.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',dataBase64:DOCX}),201);
  const fake=await call('m4','POST','/hr/people/m1/documents',{kind:'id',name:'id.pdf',mime:'application/pdf',dataBase64:PNG});
  assert.equal(fake.statusCode,400);assert.equal(fake.json().error.code,'HR_DOC_CONTENT');assert.match(fake.json().error.message,/文件内容/);
  const dl=await call('m5','GET',`/hr/people/m1/documents/${doc.id}`);
  assert.equal(dl.statusCode,200);assert.equal(dl.headers['cache-control'],'no-store');assert.ok(dl.rawPayload.toString('latin1').startsWith('%PDF-'));
  assert.equal((await call('m2','GET',`/hr/people/m1/documents/${doc.id}`)).statusCode,404,'no access, no file');
  const stored=(await db.query('SELECT data FROM hr_documents WHERE id=$1',[doc.id])).rows[0].data;
  assert.ok(!Buffer.from(stored).toString('latin1').includes('fictional test file'),'files are encrypted at rest');
  const raw=JSON.stringify((await db.query("SELECT ciphertext FROM hr_secrets WHERE user_id='m1'")).rows);
  assert.ok(!raw.includes('0000 0000')&&!raw.includes('示例'),'no plaintext at rest');
 }finally{await app.close();await db.close();}
});

test('HR regions: other countries are opened only by their own grant',async()=>{
 const {app,db,call}=await setup();
 try{
  ok(await call('m6','PATCH','/org/members/m4',{grants:['hr_intl_view']}));
  ok(await call('m6','PUT','/hr/people/m2/region',{region:'intl'}));
  ok(await call('m6','PUT','/hr/people/m2/details',{expectedVersion:await version(call,'m2'),details:{intl:{country:'DE',engagement:'eor',eorProvider:'Example EOR',currency:'EUR'}}}));
  ok(await call('m6','PUT','/hr/people/m2/secrets',{localTaxId:'00/000/00000'}));
  const v=ok(await call('m4','GET','/hr/people/m2'));
  assert.equal(v.access,'view');assert.equal(v.details.intl.engagement,'eor');assert.equal(v.secrets.localTaxId.value,'00/000/00000');
  assert.equal((await call('m6','PUT','/hr/people/m2/details',{expectedVersion:v.profile.version,details:{intl:{country:'Germany'}}})).statusCode,400);
  assert.equal((await call('m5','GET','/hr/people/m2')).statusCode,404);
 }finally{await app.close();await db.close();}
});

test('HR regions: factory contacts never get HR access and never appear in HR lists',async()=>{
 const {db,app,call}=await setup();
 try{
  await db.query(`UPDATE users SET quality_factory='dg',grants='["hr_cn_manage"]' WHERE id='m5'`);
  const r=await call('m5','GET','/hr/people');
  assert.equal(r.statusCode,403);assert.equal(r.json().error.code,'FACTORY_SCOPE');
  assert.equal((await call('m5','GET','/hr/access')).statusCode,403);
  assert.ok(!ok(await call('m6','GET','/hr/people')).items.some((p:any)=>p.id==='m5'),'factory contacts are not HR subjects');
  assert.equal((await call('m6','GET','/hr/people/m5')).statusCode,404);
  assert.deepEqual(ok(await call('m6','PATCH','/org/members/m5',{grants:['hr_cn_manage','products']})).grants,['products'],'HR grants are dropped for factory contacts');
 }finally{await app.close();await db.close();}
});

test('HR regions: reminders go to whoever manages the region; US ones to the owner',async()=>{
 const {db,app,call}=await setup();
 try{
  ok(await call('m6','PATCH','/org/members/m4',{grants:['hr_cn_manage']}));
  ok(await call('m6','PATCH','/org/members/m5',{grants:['hr_cn_view']}));
  ok(await call('m6','PUT','/hr/people/m2/region',{region:'us'}));
  ok(await call('m6','PUT','/hr/people/m1/region',{region:'cn'}));
  ok(await call('m6','PUT','/hr/people/m2/details',{expectedVersion:await version(call,'m2'),details:{workAuth:{i9Status:'authorized_alien',expiresOn:'2026-11-20'}}}));
  ok(await call('m6','PUT','/hr/people/m1/profile',{expectedVersion:await version(call,'m1'),contractEnd:'2026-11-09'}));

  assert.deepEqual(ok(await call('m4','GET','/hr/reminders')).items.map((i:any)=>[i.kind,i.userId]),[['contract_end','m1']],'China HR never sees US reminders');
  assert.equal(ok(await call('m6','GET','/hr/reminders')).items.length,2);
  assert.equal((await call('m2','GET','/hr/reminders')).statusCode,403);

  const worker=Fastify();
  const {runReminders}=await registerHrRoutes(worker,db,{dataKey:KEY,executiveUserIds:['m6'],userIds:['m3'],now:clock});
  assert.equal(await runReminders(),2);
  const box=async(who:string)=>ok(await call(who,'GET','/inbox')).items.filter((i:any)=>i.kind==='hr_reminder').map((i:any)=>i.title);
  assert.match((await box('m6')).join('|'),/工作授权/);assert.equal((await box('m6')).length,1);
  assert.match((await box('m4')).join('|'),/劳动合同/);
  assert.equal((await box('m5')).length,0,'read-only HR is not reminded');
  assert.equal((await box('m3')).length,0,'the legacy HR list is not reminded');
  await worker.close();
 }finally{await app.close();await db.close();}
});

test('HR regions: the owner exports US payroll for the CPA, with what changed since the last export',async()=>{
 const {db,app,call}=await setup();
 try{
  ok(await call('m6','PUT','/hr/people/m2/region',{region:'us'}));
  ok(await call('m6','PUT','/hr/people/m2/details',{expectedVersion:await version(call,'m2'),details:{...US_DETAILS,legal:{...US_DETAILS.legal,preferredName:'=HYPERLINK("x")'}}}));
  const p1=ok(await call('m6','PUT','/hr/people/m2/payroll',{expectedVersion:null,payroll:US_PAYROLL}));
  ok(await call('m6','PUT','/hr/people/m2/secrets',{ssn:'000-00-0000'}));
  ok(await call('m6','POST','/hr/people/m2/salary',{effectiveDate:'2026-01-01',base:20,currency:'USD',period:'hour'}),201);
  ok(await call('m6','PUT','/hr/people/m3/region',{region:'us'}));
  ok(await call('m6','PUT','/hr/people/m5/region',{region:'us'}));
  ok(await call('m6','PUT','/hr/people/m5/profile',{expectedVersion:await version(call,'m5'),status:'left',lastDay:'2026-10-01'}));
  ok(await call('m6','PUT','/hr/people/m1/region',{region:'cn'}));

  const first=ok(await call('m6','POST','/hr/exports/us'));
  assert.equal(first.rows,2,'active US employees only (m2, m3); people who left and other regions are not exported');
  const lines=first.csv.replace(/^﻿/,'').trim().split('\r\n');
  assert.match(lines[0],/^Employee,Legal first name,.*SSN.*W-4 Step 1\(c\) filing status.*State tax form.*Direct deposit 1.*Changed since last export$/);
  const row=lines.find((l:string)=>l.includes('000-00-0000'))!;
  for(const v of ['Test','000-00-0000','1 Example Street','non_exempt','hourly',',20,','hour','biweekly','mfj_or_qss','CA DE 4','married_one_income','Example PPO','120','Example Bank | checking | routing 000000000 | account 000012345 | 80%','first export'])assert.ok(row.includes(v),'row has '+v);
  assert.ok(row.includes(`'=HYPERLINK`),'cells that start a formula are neutralised');
  assert.match(first.filename,/^us-payroll-2026-11-02\.csv$/);

  ok(await call('m6','PUT','/hr/people/m2/payroll',{expectedVersion:p1.version,payroll:{...US_PAYROLL,w4:{...US_PAYROLL.w4,extraWithholding:50}}}));
  ok(await call('m6','PUT','/hr/people/m4/region',{region:'us'}));
  const second=ok(await call('m6','POST','/hr/exports/us'));
  const l2=second.csv.trim().split('\r\n');
  assert.match(l2.find((l:string)=>l.includes('000-00-0000'))!,/W-4 Step 4\(c\) extra withholding$/);
  assert.match(l2.find((l:string)=>l.startsWith('周明'))!,/new employee$/);
  assert.match(l2.find((l:string)=>l.startsWith('许夏'))!,/—$/,'unchanged rows say so');

  const log=(await db.query("SELECT actor_id,details FROM audit_events WHERE action='hr.export.us' ORDER BY created_at")).rows;
  assert.deepEqual(log.map((r:any)=>[r.actor_id,r.details.rows]),[['m6',2],['m6',3]],'each export is logged: who, when, how many rows');
  assert.ok(!JSON.stringify((await db.query('SELECT snapshot FROM hr_exports')).rows).includes('000-00-0000'),'the change snapshot is encrypted');
  assert.equal(ok(await call('m6','GET','/hr/people')).lastUsExport.rows,3);
  assert.equal((await call('m4','POST','/hr/exports/us')).statusCode,403);
  assert.match((await call('m4','POST','/hr/exports/us')).json().error.message,/主管理员/);
 }finally{await app.close();await db.close();}
});
