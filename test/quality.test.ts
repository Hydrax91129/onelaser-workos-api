import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {qualityOptionsFromEnv} from '../src/quality.js';

test('quality options read leads and factory departments from env',()=>{
 const o=qualityOptionsFromEnv({WORKOS_QUALITY_LEAD_IDS:'a, b',WORKOS_QUALITY_FACTORY_DEPARTMENTS:'dg:d1|d2,jn:d3,xx:d4'} as any);
 assert.deepEqual(o.leadIds,['a','b']);
 assert.deepEqual(o.factoryDepartments,{dg:['d1','d2'],jn:['d3']});
});

test('quality issue: lead sends to factory, factory plans, lead approves, factory implements, lead verifies; each step dated',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 let nowIso='2026-11-10T08:00:00Z';const clock=()=>new Date(nowIso).getTime();
 // dg factory staff sit in a DingTalk department matched by external id; jn staff by internal id
 await db.query("INSERT INTO departments(org_id,id,external_id,name) VALUES('demo','fdg','dt-889','东莞工厂'),('demo','fjn','dt-890','济南工厂')");
 await db.query("INSERT INTO users(id,org_id,department_id,display_name,role) VALUES('f1','demo','fdg','东莞品质','employee'),('f2','demo','fjn','济南品质','employee')");
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},quality:{leadIds:['m4'],factoryDepartments:{dg:['dt-889'],jn:['fjn']}},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const base={title:'Hydra 13 Pro 电源板过热断电',category:'ELE',defect:'01',model:'Hydra 13 Pro',severity:'S1',factory:'dg',foundAt:'2026-11-01'};
 try{
  assert.equal((await call('m1','GET','/capabilities')).json().quality,true);
  assert.equal((await call('m2','POST','/quality',base)).statusCode,403,'only leads create');
  assert.equal((await call('m4','POST','/quality',{...base,defect:'99'})).statusCode,400,'strict defect codes');
  assert.equal((await call('m4','POST','/quality',{...base,foundAt:'2026-12-01'})).statusCode,400,'no future dates');
  const c=await call('m4','POST','/quality',{...base,batch:'2026-09 批次',affected:3});
  assert.equal(c.statusCode,201,c.body);assert.equal(c.json().number,'Q-2026-0001');const id=c.json().id;
  // the factory cannot see the issue until it is sent; the other factory never sees it
  assert.equal((await call('f1','GET','/quality')).json().items.length,0);
  assert.equal((await call('f1','GET',`/quality/${id}`)).statusCode,404);
  assert.equal((await call('m2','GET','/quality')).json().items.length,1,'colleagues can read');
  assert.equal((await call('m2','GET','/quality')).json().role,'viewer');
  assert.equal((await call('m4','POST',`/quality/${id}/plan`,{rootCause:'xxxxx',corrective:'xxxxx',preventive:'xxxxx',implDue:'2026-11-20'})).statusCode,409,'not sent yet');
  const s=await call('m4','POST',`/quality/${id}/send`,{sentAt:'2026-11-02',note:'附 9 张工单'});
  assert.equal(s.statusCode,200,s.body);assert.equal(s.json().planDue,'2026-11-09','default 7 days for the factory plan');
  const fl=(await call('f1','GET','/quality')).json();assert.equal(fl.role,'factory');assert.equal(fl.factory,'dg');assert.equal(fl.items.length,1);
  assert.equal(fl.items[0].overdue,'plan','plan due 11-09, today 11-10');
  assert.equal((await call('f2','GET','/quality')).json().items.length,0,'other factory');
  assert.equal((await call('f2','GET',`/quality/${id}`)).statusCode,404);
  assert.equal((await call('f1','POST',`/quality/${id}/update`,{title:'改个标题看看'})).statusCode,403,'factory cannot edit the issue');
  assert.equal((await call('m4','POST',`/quality/${id}/update`,{factory:'jn'})).statusCode,409,'factory locked after sending');
  // factory plan v1 → returned → v2 → approved
  const p1=await call('f1','POST',`/quality/${id}/plan`,{rootCause:'电源板散热片面积不足',corrective:'更换散热片',preventive:'来料检验加温升测试',implDue:'2026-11-20'});
  assert.equal(p1.statusCode,201,p1.body);assert.equal(p1.json().version,1);
  assert.equal((await call('f1','POST',`/quality/${id}/decision`,{decision:'approve'})).statusCode,403,'factory cannot approve itself');
  assert.equal((await call('m4','POST',`/quality/${id}/decision`,{decision:'return'})).statusCode,400,'a returned plan needs a reason');
  assert.equal((await call('m4','POST',`/quality/${id}/decision`,{decision:'return',note:'请附温升测试数据'})).json().status,'sent');
  nowIso='2026-11-12T08:00:00Z';
  assert.equal((await call('f1','GET','/quality')).json().items[0].overdue,null,'a returned plan gets a few more days');
  assert.equal((await call('f1','POST',`/quality/${id}/plan`,{rootCause:'散热片面积不足，温升 38K',corrective:'更换加大散热片',preventive:'每批抽检温升',implDue:'2026-11-08'})).statusCode,400,'implementation cannot be before the plan');
  assert.equal((await call('f1','POST',`/quality/${id}/plan`,{rootCause:'散热片面积不足，温升 38K',corrective:'更换加大散热片',preventive:'每批抽检温升',implDue:'2026-11-25'})).json().version,2);
  assert.equal((await call('m4','POST',`/quality/${id}/decision`,{decision:'approve',note:'同意'})).json().status,'doing');
  assert.equal((await call('f2','POST',`/quality/${id}/implemented`,{implementedAt:'2026-11-12',effectiveBatch:'2026-11 批次'})).statusCode,404,'other factory');
  nowIso='2026-11-20T08:00:00Z';
  assert.equal((await call('f1','POST',`/quality/${id}/implemented`,{implementedAt:'2026-11-18',effectiveBatch:'SN 2611-0001 起'})).statusCode,200);
  assert.equal((await call('f1','POST',`/quality/${id}/verify`,{result:'pass',note:'自己验证一下'})).statusCode,403);
  assert.equal((await call('m4','POST',`/quality/${id}/verify`,{result:'fail',note:'新批次仍有 1 台过热'})).json().status,'doing');
  assert.equal((await call('f1','POST',`/quality/${id}/implemented`,{implementedAt:'2026-11-20',effectiveBatch:'SN 2611-0050 起'})).statusCode,200);
  nowIso='2026-11-30T08:00:00Z';
  assert.equal((await call('m4','POST',`/quality/${id}/verify`,{result:'pass',verifiedAt:'2026-11-29',note:'新批次 30 台无复发'})).json().status,'closed');
  const d=(await call('m4','GET',`/quality/${id}`)).json();
  assert.deepEqual(d.dates,{sentAt:'2026-11-02',planDue:'2026-11-13',planAt:'2026-11-12',approvedAt:'2026-11-12',implDue:'2026-11-25',implementedAt:'2026-11-20',verifiedAt:'2026-11-29',closedAt:'2026-11-29'});
  assert.deepEqual(d.durations,{toSend:1,factoryReply:10,implementation:8,verification:9,total:28});
  assert.equal(d.resolution,'fixed');assert.equal(d.effectiveBatch,'SN 2611-0050 起');
  assert.equal(d.plans.length,2);assert.equal(d.plans[1].decision,'return');assert.equal(d.plans[0].decision,'approve');
  assert.ok(d.events.map((e:any)=>e.action).join(',').includes('created,sent,plan,plan_return,plan,plan_approve,implemented,verify_fail,implemented,verify_pass'));
  assert.equal(d.can.edit,false);
  assert.equal((await call('m4','POST',`/quality/${id}/update`,{title:'关闭后不能改'})).statusCode,409);
  const audit=(await db.query("SELECT count(*)::int n FROM audit_events WHERE action LIKE 'quality.%' AND object_id=$1",[id])).rows[0].n;assert.ok(audit>=9);
  // evidence links raise the affected count; a second issue can be cancelled with a reason
  const c2=(await call('m1','POST','/quality',{...base,title:'Cobra 升降台卡滞',category:'MEC',defect:'03',model:'Cobra',severity:'S2',factory:'jn',foundAt:'2026-11-29'})).json();
  assert.equal(c2.number,'Q-2026-0002','admins act as leads');
  for(const ref of ['#8812','#8820'])assert.equal((await call('m4','POST',`/quality/${c2.id}/links`,{kind:'ticket',ref})).statusCode,201);
  assert.equal((await call('m4','POST',`/quality/${c2.id}/links`,{kind:'reddit',ref:'r/lasercutting',url:'javascript:alert(1)'})).statusCode,400);
  assert.equal((await call('m4','GET',`/quality/${c2.id}`)).json().affected,2);
  assert.equal((await call('m4','POST',`/quality/${c2.id}/cancel`,{reason:'不'})).statusCode,400);
  assert.equal((await call('m4','POST',`/quality/${c2.id}/cancel`,{reason:'用户操作问题，转为 FAQ'})).statusCode,200);
  const list=(await call('m4','GET','/quality')).json();
  assert.equal(list.items.length,2);assert.equal(list.items.find((i:any)=>i.id===c2.id).resolution,'cancelled');
  assert.deepEqual(list.leads.map((l:any)=>l.id).sort(),['m1','m4']);
  assert.ok(list.categories.ELE.defects['01']);
 }finally{await app.close();}
});

test('factory accounts are limited to quality tracking; leads in the same department are not',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 await db.query("INSERT INTO departments(org_id,id,external_id,name) VALUES('demo','fdg','dt-889','东莞工厂')");
 await db.query("INSERT INTO users(id,org_id,department_id,display_name,role) VALUES('f1','demo','fdg','东莞品质','employee'),('f9','demo','fdg','东莞品质主管','manager')");
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},quality:{leadIds:['m4','f9'],factoryDepartments:{dg:['dt-889']}},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'DELETE',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 try{
  const me=(await call('f1','GET','/me')).json();assert.equal(me.qualityFactory,'dg');
  assert.equal((await call('f1','GET','/quality')).statusCode,200);
  assert.equal((await call('f1','GET','/inbox')).statusCode,200);
  for(const url of ['/tasks','/objectives','/key-results','/directory','/task-board','/products','/wms/summary','/rma','/support/summary','/executive/summary','/feedback'])
   {const r=await call('f1','GET',url);assert.equal(r.statusCode,403,url);assert.equal(r.json().error.code,'FACTORY_SCOPE');}
  assert.equal((await call('f1','POST','/tasks',{title:'x'})).statusCode,403);
  assert.notEqual((await call('f1','POST','/feedback',{})).statusCode,403,'factory staff can still report bugs');
  assert.equal((await call('f9','GET','/me')).json().qualityFactory,null,'a lead in the factory department is not restricted');
  assert.equal((await call('f9','GET','/tasks')).statusCode,200);
  assert.equal((await call('m2','GET','/tasks')).statusCode,200,'ordinary staff unaffected');
  assert.equal((await call('f1','DELETE','/auth/session')).statusCode<400,true,'factory staff can sign out');
 }finally{await app.close();}
});

test('quality reminders: each step tells the next person; due-tomorrow and overdue reminders reach the factory once per day',async()=>{
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 let nowIso='2026-11-02T08:00:00Z';const clock=()=>new Date(nowIso).getTime();
 await db.query("INSERT INTO departments(org_id,id,external_id,name) VALUES('demo','fdg','dt-889','东莞工厂')");
 await db.query("INSERT INTO users(id,org_id,department_id,display_name,role) VALUES('f1','demo','fdg','东莞品质','employee'),('f2','demo','fdg','东莞工程','employee')");
 await db.query("UPDATE users SET email='f1@factory.example' WHERE id='f1'");
 const mails:any[]=[];
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},quality:{leadIds:['m4'],factoryDepartments:{dg:['dt-889']}},completionModel:null,translationModel:null,mailer:(async(m:any)=>{mails.push(m);}) as any,nudgeIntervalMs:0,clock});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST',url:string,payload?:any)=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who]}});};
 const inbox=async(who:string)=>(await call(who,'GET','/inbox')).json().items.filter((i:any)=>i.kind==='quality');
 try{
  const id=(await call('m4','POST','/quality',{title:'Hydra 电源板过热',category:'ELE',defect:'01',model:'Hydra 13 Pro',severity:'S1',factory:'dg',foundAt:'2026-11-01'})).json().id;
  assert.equal((await call('m4','POST',`/quality/${id}/send`,{planDue:'2026-11-05'})).statusCode,200);
  const sent=await inbox('f1');assert.equal(sent.length,1);assert.equal(sent[0].issueId,id);assert.match(sent[0].body,/已提交给你们工厂.*11月5日/);
  assert.equal((await inbox('f2')).length,1,'every factory member is told');
  assert.equal((await inbox('m4')).length,0,'the actor is not told about their own step');
  assert.ok(mails.some(m=>m.to==='f1@factory.example'&&/Q-2026-0001/.test(m.subject)),'email copy goes out');
  assert.equal((await call('f1','POST','/quality/reminders/run',{})).statusCode,403,'only leads trigger a scan by hand');
  // due tomorrow
  nowIso='2026-11-04T08:00:00Z';
  assert.equal((await call('m4','POST','/quality/reminders/run',{})).json().sent,2);
  assert.equal((await call('m4','POST','/quality/reminders/run',{})).json().sent,0,'once per day');
  assert.match((await inbox('f1'))[0].body,/整改方案明天（11月5日）到期/);
  // overdue day 1 → factory and owner; day 2 quiet; day 3 again
  nowIso='2026-11-06T08:00:00Z';
  assert.equal((await call('m4','POST','/quality/reminders/run',{})).json().sent,3);
  assert.match((await inbox('m4'))[0].body,/已逾期 1 天/);
  nowIso='2026-11-07T08:00:00Z';assert.equal((await call('m4','POST','/quality/reminders/run',{})).json().sent,0);
  nowIso='2026-11-08T08:00:00Z';assert.equal((await call('m4','POST','/quality/reminders/run',{})).json().sent,3);
  // plan → owner; approve → factory with the implementation date
  assert.equal((await call('f1','POST',`/quality/${id}/plan`,{rootCause:'散热片面积不足',corrective:'更换加大散热片',preventive:'每批抽检温升',implDue:'2026-11-20'})).statusCode,201);
  assert.match((await inbox('m4'))[0].body,/工厂已提交.*请审批/);
  assert.equal((await call('m4','POST',`/quality/${id}/decision`,{decision:'approve'})).statusCode,200);
  assert.match((await inbox('f2'))[0].body,/方案已批准，请在 11月20日 前落实/);
  nowIso='2026-11-21T08:00:00Z';
  assert.equal((await call('m4','POST','/quality/reminders/run',{})).json().sent,3,'implementation overdue');
  assert.match((await inbox('f1'))[0].body,/整改落实已逾期 1 天/);
  assert.equal((await call('f1','POST',`/quality/${id}/implemented`,{implementedAt:'2026-11-21',effectiveBatch:'SN 2611-0050 起'})).statusCode,200);
  assert.match((await inbox('m4'))[0].body,/从 SN 2611-0050 起.*请安排验证/);
  nowIso='2026-11-28T08:00:00Z';
  assert.equal((await call('m4','POST','/quality/reminders/run',{})).json().sent,0,'nothing is due while awaiting verification');
 }finally{await app.close();}
});
