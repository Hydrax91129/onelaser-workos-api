import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDatabase,schema,seedDemo} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {looksSecret,parseCsv,quarterOf} from '../src/it-accounts.js';

async function setup(start='2026-11-02T10:00:00Z'){
 const db=await createDatabase();await db.exec(schema);await seedDemo(db);
 // m3 reports to m2, m2 reports to m1; m1 is an executive; m4 is IT
 await db.query("UPDATE users SET manager_id='m1' WHERE id='m2'");await db.query("UPDATE users SET manager_id='m2' WHERE id='m3'");
 for(const id of ['m1','m2','m3','m4','m5','m6'])await db.query('UPDATE users SET email=$2 WHERE id=$1',[id,id+'@onelaser.test']);
 const clock={ms:new Date(start).getTime()};
 const app=await buildApp({db,integrations:{executiveUserIds:['m1']},it:{userIds:['m4']},completionModel:null,translationModel:null,mailer:null,nudgeIntervalMs:0,clock:()=>clock.ms,closeDatabase:false});
 const tokens:Record<string,string>={};
 const call=async(who:string,method:'GET'|'POST'|'PUT'|'DELETE',url:string,payload?:any,lang='zh')=>{tokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[who],'accept-language':lang}});};
 const inbox=async(who:string)=>(await db.query("SELECT title FROM inbox_items WHERE user_id=$1 AND kind='it_reminder' ORDER BY created_at",[who])).rows.map((r:any)=>r.title as string);
 return {db,app,call,clock,inbox};
}
const GOOGLE={service:'Google Workspace',category:'email',login:'sales@onelaser.test',mailboxType:'shared',ownerId:'m2',userIds:['m3'],mfaMethod:'app',mfaHolderId:'m2',
 vaultRef:'https://start.1password.com/open/i?a=ABC&v=DEF&i=GHI',plan:'Business Starter',seats:5,cost:72,currency:'USD',cycle:'yearly',nextRenewal:'2026-11-20',autoRenew:true,paymentLabel:'招行公司卡',cardLast4:'1234'};

test('IT accounts: who sees what, cost hiding and who may create or edit',async()=>{
 const {db,app,call}=await setup();
 try{
  assert.equal((await call('m3','GET','/capabilities')).json().itAssets,true);
  assert.deepEqual(((({quarter,check,...rest})=>rest))((await call('m4','GET','/it/access')).json()),{isIt:true,isExecutive:false,canSeeCost:true,seesAll:true,hasReports:false,configured:true});
  assert.equal((await call('m1','GET','/it/access')).json().canSeeCost,true,'executives read costs');
  assert.equal((await call('m3','GET','/it/access')).json().canSeeCost,false);
  assert.deepEqual(Object.keys((await call('m3','GET','/it/people')).json().items[0]).sort(),['id','name'],'pickers get names only');

  const g=await call('m4','POST','/it/accounts',GOOGLE);assert.equal(g.statusCode,201,g.body);
  const google=g.json();assert.equal(google.owner.id,'m2');assert.equal(google.subscription.cost,72);assert.equal(google.subscription.monthlyCost,6);assert.deepEqual(google.users.map((x:any)=>x.id),['m3']);
  const aws=(await call('m4','POST','/it/accounts',{service:'AWS',category:'cloud',login:'ops@onelaser.test',ownerId:'m5',cost:100,cycle:'monthly',nextRenewal:'2026-10-15',autoRenew:true})).json();
  assert.equal(aws.subscription.currency,'CNY','cost without a currency defaults to CNY');
  assert.equal(aws.subscription.nextRenewal,'2026-11-15','a passed auto-renew date rolls forward');assert.equal(aws.subscription.storedRenewal,'2026-10-15');

  const shop=await call('m3','POST','/it/accounts',{service:'Shopify',category:'marketplace',login:'m3@onelaser.test',mailboxType:'shared'});
  assert.equal(shop.statusCode,201,shop.body);assert.equal(shop.json().owner.id,'m3','employees own what they register');assert.equal(shop.json().mailboxType,'','mailbox type only for email');
  assert.equal(shop.json().subscription,undefined);
  assert.equal((await call('m3','POST','/it/accounts',{service:'Canva',cost:10})).json().error.code,'IT_COST_ONLY');
  assert.equal((await call('m3','POST','/it/accounts',{service:'Canva',ownerId:'m2'})).statusCode,403);
  assert.equal((await call('m4','POST','/it/accounts',{service:'X',ownerId:'nobody'})).json().error.code,'IT_UNKNOWN_PERSON');

  const see=async(who:string)=>(await call(who,'GET','/it/accounts')).json().items.map((a:any)=>a.service).sort();
  assert.deepEqual(await see('m3'),['Google Workspace','Shopify'],'own and used accounts');
  assert.deepEqual(await see('m2'),['Google Workspace','Shopify'],'managers see their reports\' accounts');
  assert.deepEqual(await see('m6'),[]);
  assert.deepEqual(await see('m1'),['AWS','Google Workspace','Shopify'],'executives see everything');
  const m3view=(await call('m3','GET','/it/accounts')).json().items.find((a:any)=>a.service==='Google Workspace');
  assert.equal(m3view.subscription,undefined,'cost hidden from employees');assert.deepEqual(m3view.relation,['user']);assert.equal(m3view.canEdit,false);
  assert.ok(!JSON.stringify((await call('m2','GET','/it/accounts')).json()).includes('1234'),'no payment details for managers');
  assert.equal((await call('m6','GET','/it/accounts/'+google.id)).statusCode,404);
  assert.equal((await call('m1','GET','/it/accounts/'+google.id)).json().subscription.cardLast4,'1234');
  assert.equal((await call('m1','PUT','/it/accounts/'+google.id,{expectedVersion:1,notes:'x'})).json().error.code,'IT_EDIT_FORBIDDEN','executives read, they do not edit');

  // the owner edits their own account but not its subscription or owner
  const e=await call('m2','PUT','/it/accounts/'+google.id,{expectedVersion:1,notes:'销售共用邮箱'});
  assert.equal(e.statusCode,200,e.body);assert.equal(e.json().version,2);
  assert.equal((await call('m2','PUT','/it/accounts/'+google.id,{expectedVersion:1,notes:'again'})).statusCode,409,'stale version');
  assert.equal((await call('m2','PUT','/it/accounts/'+google.id,{expectedVersion:2,cost:1})).json().error.code,'IT_COST_ONLY');
  assert.equal((await call('m2','PUT','/it/accounts/'+google.id,{expectedVersion:2,ownerId:'m3'})).json().error.code,'IT_OWNER_CHANGE');
  assert.equal((await call('m3','PUT','/it/accounts/'+google.id,{expectedVersion:2,notes:'x'})).statusCode,403);
  const handed=(await call('m4','PUT','/it/accounts/'+google.id,{expectedVersion:2,ownerId:'m3',mfaMethod:'none'})).json();
  assert.equal(handed.owner.id,'m3');assert.equal(handed.mfaHolder,null,'no 2FA means no holder');
  assert.equal((await call('m4','PUT','/it/accounts/'+google.id+'/users',{userIds:['m5','m6']})).json().users.length,2);

  const detail=(await call('m4','GET','/it/accounts/'+google.id)).json();
  assert.ok(detail.history.some((h:any)=>h.action==='it.account.update'&&h.fields.includes('ownerId')));
  const audit=JSON.stringify((await db.query("SELECT details FROM audit_events WHERE action LIKE 'it.%'")).rows);
  assert.ok(!audit.includes('销售共用邮箱')&&!audit.includes('1234'),'audit holds field names, not values');

  assert.equal((await call('m3','DELETE','/it/accounts/'+aws.id)).statusCode,403);
  assert.equal((await call('m4','DELETE','/it/accounts/'+aws.id)).json().deleted,true);
  assert.equal((await call('m4','GET','/it/accounts/'+aws.id)).statusCode,404);
 }finally{await app.close();await db.close();}
});

test('IT accounts: passwords and card numbers are refused, vault links validated',async()=>{
 const {db,app,call}=await setup();
 try{
  const bad=async(body:any,lang='zh')=>(await call('m4','POST','/it/accounts',{service:'Amazon Seller',...body},lang)).json().error;
  assert.equal((await bad({notes:'密码：Abc12345'})).code,'IT_SECRET_IN_TEXT');
  assert.match((await bad({notes:'password = hunter2'})).message,/密码管理器/);
  assert.equal((await bad({notes:'password = hunter2'},'en')).message,'This looks like a password or key. Keep secrets in the password manager and paste its link instead');
  assert.equal((await bad({notes:'key sk-abcdefghijklmnop12345'})).code,'IT_SECRET_IN_TEXT');
  assert.equal((await bad({login:'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8'})).code,'IT_SECRET_IN_TEXT');
  assert.equal((await bad({mfaNote:'恢复码: 1234 5678'})).code,'IT_SECRET_IN_TEXT');
  assert.equal((await bad({paymentLabel:'招行 6222 0200 1234 5678'})).code,'IT_CARD_NUMBER');
  assert.equal((await bad({cardLast4:'12345'})).code,'VALIDATION_ERROR');
  assert.equal((await bad({vaultRef:'http://example.com/item'})).code,'VALIDATION_ERROR','vault links must be https or op://');
  assert.equal((await bad({password:'x'})).code,'VALIDATION_ERROR','there is no password field');
  const ok=await call('m4','POST','/it/accounts',{service:'Amazon Seller',vaultRef:'op://Shared/Amazon Seller',notes:'见 https://sellercentral.amazon.com/home 登录后台',paymentLabel:'公司 Amex'});
  assert.equal(ok.statusCode,201,ok.body);
  assert.equal(looksSecret('订阅续费联系财务'),false);assert.equal(looksSecret('PIN: 0000'),true);
  assert.equal((await call('m3','POST','/it/accounts/'+ok.json().id+'/flags',{kind:'problem',note:'x'})).statusCode,404,'cannot flag what you cannot see');
 }finally{await app.close();await db.close();}
});

test('IT accounts: flags, the quarterly check and its reminders',async()=>{
 const {db,app,call,clock,inbox}=await setup();
 try{
  const google=(await call('m4','POST','/it/accounts',GOOGLE)).json();
  const shop=(await call('m3','POST','/it/accounts',{service:'Shopify',category:'marketplace'})).json();

  assert.equal((await call('m3','POST','/it/accounts/'+google.id+'/flags',{kind:'stopped_using',note:'已转岗'})).statusCode,201);
  assert.deepEqual((await call('m4','GET','/it/accounts/'+google.id)).json().users,[],'stopping removes me from the users');
  assert.match((await inbox('m4'))[0],/许夏 反馈：Google Workspace 已不再使用/);
  assert.equal((await call('m3','GET','/it/flags')).statusCode,403);
  const flags=(await call('m4','GET','/it/flags')).json().items;assert.equal(flags.length,1);assert.equal(flags[0].byName,'许夏');
  assert.equal((await call('m4','POST','/it/flags/'+flags[0].id+'/resolve',{resolution:'已移除'})).json().resolved,true);
  assert.equal((await call('m4','POST','/it/flags/'+flags[0].id+'/resolve',{})).statusCode,404);
  assert.equal((await call('m4','GET','/it/flags')).json().items.length,0);

  assert.equal((await call('m3','POST','/it/checks/confirm',{items:[]})).json().error.code,'IT_CHECK_NOT_STARTED');
  assert.equal((await call('m3','POST','/it/checks/start')).statusCode,403);
  const round=(await call('m4','POST','/it/checks/start')).json();
  assert.equal(round.quarter,'2026-Q4');assert.equal(round.total,6);assert.equal(round.newlyStarted,6);
  assert.equal((await call('m4','POST','/it/checks/start')).json().newlyStarted,0,'starting twice adds nobody');
  assert.ok((await inbox('m3')).includes('请确认你的账号与设备（2026-Q4）'));
  const my=(await call('m3','GET','/it/my')).json();
  assert.equal(my.check.status,'pending');assert.deepEqual(my.accounts.map((a:any)=>a.service),['Shopify']);
  assert.equal((await call('m3','POST','/it/checks/confirm',{items:[{accountId:google.id,ok:true}]})).statusCode,404,'only my own accounts');
  const done=(await call('m3','POST','/it/checks/confirm',{items:[{accountId:shop.id,ok:false,note:'登录邮箱换了'}],missing:'Canva 团队版没登记'})).json();
  assert.equal(done.flagged,2);
  assert.equal((await call('m3','GET','/it/my')).json().check.status,'done');
  const after=(await call('m4','GET','/it/checks')).json();assert.equal(after.done,1);assert.equal(after.percent,17);
  assert.deepEqual((await call('m4','GET','/it/flags')).json().items.map((f:any)=>f.kind).sort(),['missing','needs_change']);

  // 7 and 14 days later the people still pending are reminded once each
  const run=async(day:string)=>{clock.ms=new Date(day+'T10:00:00Z').getTime();return (await db.query("SELECT count(*)::int n FROM inbox_items WHERE kind='it_reminder' AND title LIKE '你还没有确认%'")).rows[0].n;};
  const {registerItRoutes}=await import('../src/it-accounts.js');
  const Fastify=(await import('fastify')).default;const side=Fastify();
  const jobs=await registerItRoutes(side,db,{userIds:['m4'],now:()=>clock.ms});
  await run('2026-11-09');await jobs.runReminders();
  assert.equal(await run('2026-11-09'),5,'five people still pending at day 7');
  await jobs.runReminders();assert.equal(await run('2026-11-09'),5,'not sent twice');
  await run('2026-11-16');await jobs.runReminders();assert.equal(await run('2026-11-16'),10);
  await side.close();
 }finally{await app.close();await db.close();}
});

test('IT accounts: summary, renewals and leaving people, with deduplicated reminders',async()=>{
 const {db,app,call,clock,inbox}=await setup();
 try{
  const google=(await call('m4','POST','/it/accounts',GOOGLE)).json();
  await call('m4','POST','/it/accounts',{service:'AWS',category:'cloud',ownerId:'m5',cost:100,cycle:'monthly',nextRenewal:'2026-10-15',autoRenew:true,vaultRef:'op://Ops/AWS'});
  await call('m4','POST','/it/accounts',{service:'Old CRM',cost:999,currency:'USD',cycle:'yearly',status:'cancelled'});
  await call('m4','POST','/it/accounts',{service:'Domain onelaser.com',category:'domain',ownerId:'m6'});
  await db.query("INSERT INTO hr_profiles(user_id,org_id,status) VALUES('m2','demo','leaving')");
  await db.query("UPDATE users SET active=false WHERE id='m6'");

  assert.equal((await call('m3','GET','/it/summary')).statusCode,403);
  const s=(await call('m1','GET','/it/summary')).json();
  assert.deepEqual(s.costs,{USD:{monthly:6,yearly:72},CNY:{monthly:100,yearly:1200}},'cancelled subscriptions do not count');
  assert.deepEqual(s.renewals.map((r:any)=>[r.service,r.days]),[['AWS',13],['Google Workspace',18]]);
  assert.deepEqual(s.noOwner.map((x:any)=>x.service).sort(),['Domain onelaser.com'],'inactive owners count as no owner');
  assert.deepEqual(s.noVault.map((x:any)=>x.service).sort(),['Domain onelaser.com']);
  assert.deepEqual(s.leaving.map((x:any)=>x.role).sort(),['mfa','owner']);
  assert.equal(s.counts.total,4);assert.equal(s.counts.leaving,2);
  assert.ok(google.owner&&(await call('m4','GET','/it/accounts/'+google.id)).json().owner.leaving);

  const due=(await call('m4','GET','/it/reminders')).json().items.map((x:any)=>x.kind).sort();
  assert.deepEqual(due,['leaving_mfa','leaving_owner','renewal','renewal']);
  const {registerItRoutes}=await import('../src/it-accounts.js');
  const Fastify=(await import('fastify')).default;const side=Fastify();
  const jobs=await registerItRoutes(side,db,{userIds:['m4'],now:()=>clock.ms});
  assert.ok(await jobs.runReminders()>0);
  const it=await inbox('m4');
  assert.ok(it.includes('AWS 还有 13 天续费'));assert.ok(it.includes('Google Workspace 的负责人 陈一 即将离职，请转交账号'));
  assert.ok((await inbox('m5')).includes('AWS 还有 13 天续费'),'the owner hears about renewals too');
  assert.equal(await jobs.runReminders(),0,'nothing is sent twice');

  await call('m4','PUT','/it/accounts/'+google.id,{expectedVersion:1,status:'to_cancel'});
  await jobs.runReminders();
  assert.ok((await inbox('m4')).includes('Google Workspace 标记为待取消，但仍会在 2026-11-20 自动续费'));
  clock.ms=new Date('2026-11-14T10:00:00Z').getTime();await jobs.runReminders();
  assert.ok((await inbox('m4')).includes('Google Workspace 还有 6 天续费'),'7-day threshold');

  // the round starts by itself in the first week of a quarter, and only then
  assert.equal((await db.query('SELECT count(*)::int n FROM it_checks')).rows[0].n,0,'not mid-quarter');
  clock.ms=new Date('2027-01-04T10:00:00Z').getTime();await jobs.runReminders();
  assert.equal((await db.query("SELECT count(*)::int n FROM it_checks WHERE quarter='2027-Q1'")).rows[0].n,5);
  assert.equal(quarterOf('2027-01-04'),'2027-Q1');
  await side.close();
 }finally{await app.close();await db.close();}
});

test('IT accounts: CSV template, all-or-nothing import with row errors, export',async()=>{
 const {db,app,call}=await setup();
 try{
  const tpl=await call('m4','GET','/it/import-template.csv');
  assert.equal(tpl.statusCode,200);assert.ok(tpl.body.startsWith('﻿服务名称,类别,登录账号'));
  assert.equal((await call('m3','GET','/it/import-template.csv')).statusCode,403);
  const head='服务名称,类别,登录账号,负责人,共用人,密码库链接,两步验证方式,两步验证绑定人,状态,费用,币种,付费周期,下次续费日,自动续费,备注\n';
  const broken=head+'Shopify,电商平台,shop@onelaser.test,m3@onelaser.test,,,,,在用,,,,,,\n'+
   'Canva,软件服务,design@onelaser.test,不存在的人,,,,,在用,,,,,,\n'+
   'Lark,火星,lark@onelaser.test,,,,,,在用,,,,,,\n'+
   'TikTok,社交媒体,tt@onelaser.test,,,,,,在用,,,,,,"密码：abc12345"\n';
  const r=await call('m4','POST','/it/accounts/import',{csv:broken});
  assert.equal(r.statusCode,400);assert.deepEqual(r.json().errors.map((e:any)=>e.row),[3,4,5]);
  assert.match(r.json().errors[0].message,/不存在的人/);assert.match(r.json().errors[2].message,/密码管理器/);
  assert.equal((await db.query('SELECT count(*)::int n FROM it_accounts')).rows[0].n,0,'nothing imported');

  const good=head+'Shopify,电商平台,shop@onelaser.test,许夏,陈一；赵然,https://start.1password.com/open/i?i=1,验证器App,许夏,在用,"1,200",人民币,年付,2026/12/1,是,主店铺\n'+
   'Google Workspace,邮箱,sales@onelaser.test,m2@onelaser.test,,,,,待取消,6,USD,月付,2026-11-20,否,\n';
  const dry=(await call('m4','POST','/it/accounts/import',{csv:'﻿'+good,dryRun:true})).json();
  assert.deepEqual(dry,{dryRun:true,rows:2,toImport:2,skipped:[]});
  assert.equal((await db.query('SELECT count(*)::int n FROM it_accounts')).rows[0].n,0,'a dry run writes nothing');
  assert.equal((await call('m4','POST','/it/accounts/import',{csv:good})).json().imported,2);
  const shop=(await call('m4','GET','/it/accounts')).json().items.find((a:any)=>a.service==='Shopify');
  assert.equal(shop.owner.id,'m3');assert.deepEqual(shop.users.map((x:any)=>x.id).sort(),['m2','m5']);assert.equal(shop.mfaMethod,'app');
  assert.deepEqual([shop.subscription.cost,shop.subscription.currency,shop.subscription.cycle,shop.subscription.nextRenewal,shop.subscription.autoRenew],[1200,'CNY','yearly','2026-12-01',true]);
  assert.deepEqual((await call('m4','POST','/it/accounts/import',{csv:good})).json(),{dryRun:false,rows:2,imported:0,skipped:[2,3]},'already registered rows are skipped');
  assert.equal((await call('m4','POST','/it/accounts/import',{csv:'foo,bar\n1,2\n'})).json().error.code,'IT_IMPORT_HEADER');
  assert.equal((await call('m3','POST','/it/accounts/import',{csv:good})).statusCode,403);
  assert.equal((await call('m4','POST','/it/accounts/import',{csv:broken},'en')).json().error.message,'Some rows need fixing; nothing was imported');

  const out=await call('m1','GET','/it/accounts.csv');
  assert.equal(out.statusCode,200);assert.match(out.headers['content-type'] as string,/text\/csv/);
  const rows=parseCsv(out.body);assert.equal(rows.length,3);
  const shopRow=rows.find(x=>x[0]==='Shopify')!;
  assert.equal(shopRow[1],'电商平台');assert.equal(shopRow[4],'m3@onelaser.test');assert.equal(shopRow[11],'在用');assert.equal(shopRow[21],'是');
  assert.equal((await call('m2','GET','/it/accounts.csv')).statusCode,403);
  // the export imports back as "already registered"
  assert.deepEqual((await call('m4','POST','/it/accounts/import',{csv:out.body,dryRun:true})).json().skipped,[2,3]);
  assert.deepEqual(parseCsv('a,"b ""q"", c"\r\n\r\nd,e'),[['a','b "q", c'],['d','e']]);
 }finally{await app.close();await db.close();}
});
