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

/* m6 = company owner. m4 = US HR (manage). m5 = US HR (read-only). m3 = China HR (read-only).
 * m2 (US, reports to m1) and m1 (China) are the people on file. */
async function setup(){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query("UPDATE users SET manager_id='m1' WHERE id='m2'");
 const app=await buildApp({db,integrations:{executiveUserIds:['m6']},hr:{dataKey:KEY},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock,closeDatabase:false});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:any,lang='zh')=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who],'accept-language':lang}});};
 return {db,app,call};
}
const ok=(r:any,code=200)=>{assert.equal(r.statusCode,code,r.body);return r.json();};

test('HR regions: only the owner assigns grants and regions; each region sees only its own people',async()=>{
 const {db,app,call}=await setup();
 try{
  await db.query("UPDATE users SET is_admin=true WHERE id='m1'");
  assert.equal((await call('m1','PATCH','/org/members/m4',{grants:['hr_us_manage']})).statusCode,403,'in-app admins cannot hand out HR access');
  assert.deepEqual(ok(await call('m6','PATCH','/org/members/m4',{grants:['hr_us_manage']})).grants,['hr_us_manage']);
  ok(await call('m6','PATCH','/org/members/m5',{grants:['hr_us_view']}));
  ok(await call('m6','PATCH','/org/members/m3',{grants:['hr_cn_view']}));
  assert.equal((await call('m6','PATCH','/org/members/m3',{grants:['hr_mars_view']})).statusCode,400);

  assert.equal((await call('m4','PUT','/hr/people/m2/region',{region:'us'})).statusCode,403,'regional HR cannot move people between regions');
  assert.equal(ok(await call('m6','PUT','/hr/people/m2/region',{region:'us'})).region,'us');
  ok(await call('m6','PUT','/hr/people/m1/region',{region:'cn'}));
  assert.equal((await call('m6','PUT','/hr/people/m1/region',{region:'mars'})).statusCode,400);
  const audit=(await db.query("SELECT details FROM audit_events WHERE action='hr.region.update' AND object_id='m2'")).rows[0];
  assert.deepEqual(audit.details,{from:'',to:'us'});

  const owner=ok(await call('m6','GET','/hr/people'));
  assert.equal(owner.items.length,6);assert.equal(owner.canAssignRegion,true);
  assert.deepEqual(owner.regions,{us:'manage',cn:'manage',intl:'manage'});
  assert.equal(owner.items.find((p:any)=>p.id==='m2').region,'us');

  const us=ok(await call('m4','GET','/hr/people'));
  assert.deepEqual(us.items.map((p:any)=>p.id).sort(),['m2','m4'],'US HR: the US people plus themself');
  assert.deepEqual(us.regions,{us:'manage',cn:null,intl:null});assert.equal(us.canAssignRegion,false);
  assert.equal(us.items.find((p:any)=>p.id==='m2').access,'hr');

  const cn=ok(await call('m3','GET','/hr/people'));
  assert.deepEqual(cn.items.map((p:any)=>p.id).sort(),['m1','m3'],'China HR never sees the US region');
  assert.equal(cn.items.find((p:any)=>p.id==='m1').access,'view');
  assert.equal((await call('m3','GET','/hr/people/m2')).statusCode,404,'China HR cannot open a US record');
  assert.equal((await call('m3','GET','/hr/people/m2/payroll')).statusCode,404);
  assert.equal((await call('m3','POST','/hr/people/m2/reveal',{field:'ssn',reason:'核对工资'})).statusCode,404);
  assert.equal((await call('m4','GET','/hr/people/m1')).statusCode,404,'US HR cannot open a China record');

  assert.deepEqual(ok(await call('m2','GET','/hr/people')).items.map((p:any)=>p.id),['m2'],'no grant: only yourself');
  assert.equal(ok(await call('m5','GET','/hr/access')).regions.us,'view');
 }finally{await app.close();await db.close();}
});

test('HR regions: US payroll profile, encrypted IDs, read-only vs manage, self and manager views',async()=>{
 const {db,app,call}=await setup();
 try{
  ok(await call('m6','PATCH','/org/members/m4',{grants:['hr_us_manage']}));
  ok(await call('m6','PATCH','/org/members/m5',{grants:['hr_us_view']}));
  ok(await call('m6','PUT','/hr/people/m2/region',{region:'us'}));
  const v0=ok(await call('m4','GET','/hr/people/m2')).profile.version;

  const details={legal:{firstName:'Test',lastName:'Person',middleName:''},contact:{phone:'000-000-0000',personalEmail:'test.person@example.com',address:{line1:'1 Example Street',city:'Sampletown',state:'CA',postalCode:'00000',country:'US'}},
   workAuth:{i9Status:'citizen',expiresOn:null,taxState:'CA'},education:{level:'bachelor',school:'Example College'}};
  const d=ok(await call('m4','PUT','/hr/people/m2/details',{expectedVersion:v0,details}));
  assert.equal(d.details.legal.middleName,undefined,'blank fields are not stored');
  assert.deepEqual(d.changed.sort(),['contact','education','legal','workAuth']);
  assert.equal((await call('m4','PUT','/hr/people/m2/details',{expectedVersion:v0,details})).statusCode,409,'stale version');
  assert.equal((await call('m4','PUT','/hr/people/m2/details',{expectedVersion:d.version,details:{workAuth:{taxState:'California'}}})).statusCode,400);

  const payroll={comp:{payType:'hourly',flsa:'non_exempt',payFrequency:'biweekly'},
   commission:{plan:'tiered',tiers:[{from:0,to:10000,rate:2},{from:10000,to:null,rate:3}],basis:'fictional plan'},
   bonus:{eligible:true,type:'annual',amountType:'fixed',amount:500},
   benefits:{medical:{status:'enrolled',tier:'family'},dental:{status:'waived'},retirement:{enrolled:true,employeePercent:4,employerMatch:'fictional match'},pto:{daysPerYear:10}},
   family:{maritalStatus:'married',dependents:2},
   w4:{formYear:2026,filingStatus:'mfj_or_qss',multipleJobs:true,dependentsAmount:4000,otherIncome:0,deductions:0,extraWithholding:25,exempt:false},
   de4:{filingStatus:'married_one_income',allowances:2,additionalAllowances:0,extraWithholding:0,exempt:false}};
  const p1=ok(await call('m4','PUT','/hr/people/m2/payroll',{expectedVersion:null,payroll}));
  assert.equal(p1.payroll.w4.filingStatus,'mfj_or_qss');
  assert.equal((await call('m4','PUT','/hr/people/m2/payroll',{expectedVersion:null,payroll})).statusCode,409);
  assert.equal((await call('m4','PUT','/hr/people/m2/payroll',{expectedVersion:p1.version,payroll:{w4:{filingStatus:'married'}}})).statusCode,400);
  ok(await call('m4','PUT','/hr/people/m2/secrets',{ssn:'000-00-0000',bankAccount:'0000 0000 1234',bankRouting:'000000000'}));
  assert.equal((await call('m4','PUT','/hr/people/m2/secrets',{ssn:'123'})).statusCode,400);
  ok(await call('m4','POST','/hr/people/m2/salary',{effectiveDate:'2026-01-01',base:20,currency:'USD',period:'hour',reason:'fictional starting rate'}),201);

  const stored=JSON.stringify((await db.query("SELECT * FROM hr_secrets WHERE user_id='m2'")).rows);
  for(const plain of ['000-00-0000','0000 0000 1234','mfj_or_qss','married','fictional match'])assert.ok(!stored.includes(plain),'no plaintext at rest: '+plain);

  // Manage access
  const hr=ok(await call('m4','GET','/hr/people/m2'));
  assert.equal(hr.access,'hr');assert.equal(hr.canManage,true);assert.equal(hr.region,'us');
  assert.equal(hr.secrets.ssn.hint,'****0000');assert.equal(hr.secrets.bankAccount.hint,'****1234');assert.equal(hr.payroll.set,true);
  assert.ok(!JSON.stringify(hr).includes('000-00-0000'),'masked in reads');
  assert.equal((await call('m4','POST','/hr/people/m2/reveal',{field:'bankAccount'})).statusCode,400,'reason required');
  assert.equal(ok(await call('m4','POST','/hr/people/m2/reveal',{field:'bankRouting',reason:'set up direct deposit'})).value,'000000000');

  // Read-only access
  const ro=ok(await call('m5','GET','/hr/people/m2'));
  assert.equal(ro.access,'view');assert.equal(ro.canManage,false);assert.equal(ro.canRevealBank,false);
  assert.equal(ro.details.contact.address.city,'Sampletown');assert.equal(ro.secrets.ssn.hint,'****0000');
  assert.deepEqual(ro.secrets.bankAccount,{set:true,hint:'****',updatedAt:ro.secrets.bankAccount.updatedAt},'read-only does not even see the last digits of bank details');
  assert.equal(ok(await call('m5','GET','/hr/people/m2/payroll')).payroll.de4.allowances,2);
  assert.equal(ok(await call('m5','POST','/hr/people/m2/reveal',{field:'ssn',reason:'payroll check'})).value,'000-00-0000');
  assert.equal((await call('m5','POST','/hr/people/m2/reveal',{field:'salary',reason:'payroll check'})).json().value[0].base,20);
  const bank=await call('m5','POST','/hr/people/m2/reveal',{field:'bankAccount',reason:'payroll check'});
  assert.equal(bank.statusCode,403);assert.equal(bank.json().error.code,'HR_BANK_MANAGE_ONLY');
  for(const [method,url,body] of [
   ['PUT','/hr/people/m2/profile',{expectedVersion:hr.profile.version,jobLevel:'P9'}],
   ['PUT','/hr/people/m2/details',{expectedVersion:hr.profile.version,details:{}}],
   ['PUT','/hr/people/m2/payroll',{expectedVersion:p1.version,payroll:{}}],
   ['PUT','/hr/people/m2/secrets',{ssn:'000-00-0001'}],
   ['POST','/hr/people/m2/salary',{effectiveDate:'2026-02-01',base:1,currency:'USD',period:'hour'}],
   ['POST','/hr/people/m2/events',{kind:'other',happenedOn:'2026-02-01'}],
   ['POST','/hr/people/m2/documents',{kind:'w4',name:'w4.pdf',mime:'application/pdf',dataBase64:PDF}],
   ['PUT','/hr/people/m2/region',{region:'intl'}],
  ] as const){const r=await call('m5',method,url,body);assert.equal(r.statusCode,403,`${method} ${url}: ${r.body}`);}
  assert.match((await call('m5','PUT','/hr/people/m2/secrets',{ssn:'000-00-0001'})).json().error.message,/只读/);

  // Audit: who, whose, which field, why; never the value.
  const reveals=(await db.query("SELECT actor_id,owner_id,details FROM audit_events WHERE action='hr.sensitive.reveal' ORDER BY created_at")).rows;
  assert.deepEqual(reveals.map((r:any)=>[r.actor_id,r.owner_id,r.details.field]),[['m4','m2','bankRouting'],['m5','m2','ssn'],['m5','m2','salary']]);
  assert.ok(!JSON.stringify(reveals).includes('000-00-0000'));
  assert.equal((await db.query("SELECT count(*)::int n FROM audit_events WHERE action='hr.payroll.view' AND actor_id='m5'")).rows[0].n,1,'reading payroll is audited');
  assert.deepEqual((await db.query("SELECT details FROM audit_events WHERE action='hr.payroll.update'")).rows[0].details.sections.sort(),['benefits','bonus','commission','comp','de4','family','w4']);

  // The person themself: read everything, reveal own values without a reason, change nothing.
  const self=ok(await call('m2','GET','/hr/people/m2'));
  assert.equal(self.access,'self');assert.equal(self.canRevealBank,true);assert.equal(self.details.legal.firstName,'Test');
  assert.equal(ok(await call('m2','GET','/hr/people/m2/payroll')).payroll.family.dependents,2);
  assert.equal(ok(await call('m2','POST','/hr/people/m2/reveal',{field:'ssn'})).value,'000-00-0000');
  assert.equal((await call('m2','PUT','/hr/people/m2/details',{expectedVersion:self.profile.version,details:{}})).statusCode,403);
  // US HR cannot edit their own record either.
  ok(await call('m6','PUT','/hr/people/m4/region',{region:'us'}));
  assert.equal(ok(await call('m4','GET','/hr/people/m4')).access,'self');
  assert.equal((await call('m4','POST','/hr/people/m4/salary',{effectiveDate:'2026-02-01',base:1,currency:'USD',period:'hour'})).statusCode,403);

  // Line manager: basic employment facts only.
  const mgr=ok(await call('m1','GET','/hr/people/m2'));
  assert.equal(mgr.access,'manager');assert.equal(mgr.details,undefined);assert.equal(mgr.payroll,undefined);assert.equal(mgr.secrets,undefined);
  assert.equal((await call('m1','GET','/hr/people/m2/payroll')).statusCode,403);
  // No relation at all.
  assert.equal((await call('m3','GET','/hr/people/m2')).statusCode,404);
 }finally{await app.close();await db.close();}
});

test('HR regions: China and other-country profiles, documents by type, file checks',async()=>{
 const {db,app,call}=await setup();
 try{
  ok(await call('m6','PATCH','/org/members/m3',{grants:['hr_cn_manage','hr_intl_view']}));
  ok(await call('m6','PUT','/hr/people/m1/region',{region:'cn'}));
  ok(await call('m6','PUT','/hr/people/m2/region',{region:'intl'}));
  const v=ok(await call('m3','GET','/hr/people/m1')).profile.version;
  ok(await call('m3','PUT','/hr/people/m1/details',{expectedVersion:v,details:{cn:{hukouLocation:'示例省示例市',hukouType:'urban',currentAddress:'示例路 1 号',contractType:'fixed_term'},education:{level:'master'}}}));
  ok(await call('m3','PUT','/hr/people/m1/payroll',{expectedVersion:null,payroll:{
   socialInsurance:{city:'示例市',base:5000,pension:{personal:8,employer:16},medical:{personal:2,employer:9},unemployment:{personal:0.5,employer:0.5},injury:{employer:0.2},maternity:{employer:0.8}},
   housingFund:{base:5000,personal:7,employer:7},
   specialDeductions:{childEducation:{claimed:true,count:1,monthly:2000},elderlySupport:{claimed:true,monthly:1500,note:'示例'}},family:{maritalStatus:'married',children:1}}}));
  ok(await call('m3','PUT','/hr/people/m1/secrets',{idNumber:'000000000000000000',bankAccount:'0000 0000 0000 0000'}));
  const back=ok(await call('m3','GET','/hr/people/m1/payroll')).payroll;
  assert.equal(back.socialInsurance.pension.employer,16);assert.equal(back.specialDeductions.childEducation.count,1);

  // Other countries: read-only for m3.
  const ro=ok(await call('m3','GET','/hr/people/m2'));
  assert.equal(ro.access,'view');
  assert.equal((await call('m3','PUT','/hr/people/m2/details',{expectedVersion:ro.profile.version,details:{intl:{country:'DE',engagement:'eor'}}})).statusCode,403);
  const vi=ok(await call('m6','GET','/hr/people/m2')).profile.version;
  ok(await call('m6','PUT','/hr/people/m2/details',{expectedVersion:vi,details:{intl:{country:'DE',engagement:'eor',eorProvider:'Example EOR',currency:'EUR'}}}));
  ok(await call('m6','PUT','/hr/people/m2/secrets',{localTaxId:'00/000/00000'}));
  assert.equal(ok(await call('m3','GET','/hr/people/m2')).details.intl.engagement,'eor');
  assert.equal((await call('m6','PUT','/hr/people/m2/details',{expectedVersion:vi+1,details:{intl:{country:'Germany'}}})).statusCode,400);

  // Documents: typed, content checked, downloadable only by people with access.
  const doc=ok(await call('m3','POST','/hr/people/m1/documents',{kind:'resume',name:'resume.pdf',mime:'application/pdf',dataBase64:PDF}),201);
  ok(await call('m3','POST','/hr/people/m1/documents',{kind:'contract',name:'contract.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',dataBase64:DOCX}),201);
  const fake=await call('m3','POST','/hr/people/m1/documents',{kind:'id',name:'id.pdf',mime:'application/pdf',dataBase64:PNG});
  assert.equal(fake.statusCode,400);assert.equal(fake.json().error.code,'HR_DOC_CONTENT');assert.match(fake.json().error.message,/文件内容/);
  assert.equal((await call('m3','POST','/hr/people/m1/documents',{kind:'payslip',name:'x.pdf',mime:'application/pdf',dataBase64:PDF})).statusCode,400);
  const list=ok(await call('m3','GET','/hr/people/m1')).documents;
  assert.deepEqual(list.map((d:any)=>d.kind).sort(),['contract','resume']);
  const dl=await call('m3','GET',`/hr/people/m1/documents/${doc.id}`);
  assert.equal(dl.statusCode,200);assert.equal(dl.headers['cache-control'],'no-store');assert.ok(dl.rawPayload.toString('latin1').startsWith('%PDF-'));
  assert.equal((await call('m4','GET',`/hr/people/m1/documents/${doc.id}`)).statusCode,404,'no access, no file');
  assert.equal((await call('m2','GET',`/hr/people/m1/documents/${doc.id}`)).statusCode,404);
  const stored=(await db.query('SELECT data FROM hr_documents WHERE id=$1',[doc.id])).rows[0].data;
  assert.ok(!Buffer.from(stored).toString('latin1').includes('fictional test file'),'files are encrypted at rest');
 }finally{await app.close();await db.close();}
});

test('HR regions: factory contacts never get HR access and never appear in HR lists',async()=>{
 const {db,app,call}=await setup();
 try{
  await db.query(`UPDATE users SET quality_factory='dg',grants='["hr_us_manage"]' WHERE id='m5'`);
  const r=await call('m5','GET','/hr/people');
  assert.equal(r.statusCode,403);assert.equal(r.json().error.code,'FACTORY_SCOPE');
  assert.equal((await call('m5','GET','/hr/access')).statusCode,403);
  assert.ok(!ok(await call('m6','GET','/hr/people')).items.some((p:any)=>p.id==='m5'),'factory contacts are not HR subjects');
  assert.equal((await call('m6','GET','/hr/people/m5')).statusCode,404);
  assert.deepEqual(ok(await call('m6','PATCH','/org/members/m5',{grants:['hr_us_manage','products']})).grants,['products'],'HR grants are dropped for factory contacts');
 }finally{await app.close();await db.close();}
});

test('HR regions: reminders go to whoever manages the region, including US work authorization expiry',async()=>{
 const {db,app,call}=await setup();
 try{
  ok(await call('m6','PATCH','/org/members/m4',{grants:['hr_us_manage']}));
  ok(await call('m6','PATCH','/org/members/m3',{grants:['hr_cn_view']}));
  ok(await call('m6','PUT','/hr/people/m2/region',{region:'us'}));
  ok(await call('m6','PUT','/hr/people/m1/region',{region:'cn'}));
  const v=ok(await call('m4','GET','/hr/people/m2')).profile.version;
  ok(await call('m4','PUT','/hr/people/m2/details',{expectedVersion:v,details:{workAuth:{i9Status:'authorized_alien',expiresOn:'2026-11-20'}}}));
  const vc=ok(await call('m6','GET','/hr/people/m1')).profile.version;
  ok(await call('m6','PUT','/hr/people/m1/profile',{expectedVersion:vc,contractEnd:'2026-11-09'}));

  assert.deepEqual(ok(await call('m4','GET','/hr/reminders')).items.map((i:any)=>[i.kind,i.userId,i.days]),[['work_auth_expiry','m2',18]]);
  assert.deepEqual(ok(await call('m3','GET','/hr/reminders')).items.map((i:any)=>[i.kind,i.userId]),[['contract_end','m1']]);
  assert.equal(ok(await call('m6','GET','/hr/reminders')).items.length,2);
  assert.equal((await call('m2','GET','/hr/reminders')).statusCode,403);

  const worker=Fastify();
  const {runReminders}=await registerHrRoutes(worker,db,{dataKey:KEY,executiveUserIds:['m6'],now:clock});
  assert.equal(await runReminders(),1,'China has no manager yet, so only the US reminder goes out');
  const inbox=ok(await call('m4','GET','/inbox')).items.filter((i:any)=>i.kind==='hr_reminder');
  assert.equal(inbox.length,1);assert.match(inbox[0].title,/工作授权/);
  assert.equal(ok(await call('m3','GET','/inbox')).items.filter((i:any)=>i.kind==='hr_reminder').length,0,'read-only HR is not reminded');
  await worker.close();
 }finally{await app.close();await db.close();}
});
