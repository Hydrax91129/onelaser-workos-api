import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase,schema,seedDemo,type Database} from '../src/db.js';
import {buildApp} from '../src/app.js';
import {issueSession} from '../src/auth.js';
import {signStripePayload,type CaldockStripe} from '../src/caldock-stripe.js';
import type {CaldockGateway} from '../src/caldock-oidc.js';
import {dealerOptionsFromEnv} from '../src/dealer.js';

const origin='https://craftos.example.test',secret='whsec_dealertestsecret123';
let db:Database,app:Awaited<ReturnType<typeof buildApp>>;
const mails:{to:string;subject:string;text:string}[]=[];
/* Stripe stand-in: records every call and answers like the REST API for the paths the portal uses. */
const calls:{method:string;path:string;params:Record<string,string>;key?:string}[]=[];
const sessions=new Map<string,{status:string;url:string}>();
const stripe:CaldockStripe={mode:'test',webhookSecret:secret,async request(method,path,params={},key){
 calls.push({method,path,params,key});
 if(path==='/v1/customers')return {id:'cus_'+calls.length};
 if(path==='/v1/checkout/sessions'){const id='cs_test_'+calls.length;sessions.set(id,{status:'open',url:'https://checkout.stripe.test/'+id});return {id,url:sessions.get(id)!.url};}
 const m=/^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(path);
 if(m){const s=sessions.get(decodeURIComponent(m[1]))!;if(m[2])s.status='expired';return {id:m[1],...s};}
 throw new Error('unexpected Stripe call '+path);
}};
const google:CaldockGateway={
 authorizationUrl({state}){return 'https://accounts.google.test/auth?state='+state;},
 async authenticate({code}){return {provider:'google',subject:'sub-'+code,email:code+'@gmail.test',name:'G '+code};},
};
const staffTokens:Record<string,string>={};
const staff=async(who:string,method:'GET'|'POST'|'PATCH',url:string,payload?:any)=>{staffTokens[who]??=(await issueSession(db,who)).accessToken;return app.inject({method,url,payload,headers:{authorization:'Bearer '+staffTokens[who]}});};
type Dealer={cookie:string;csrf:string};
const dealer=(d:Dealer,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:any)=>app.inject({method,url:'/dealer'+url,payload,headers:{cookie:d.cookie,origin,'x-csrf-token':d.csrf}});
const cookieFrom=(res:any)=>[res.headers['set-cookie']].flat().filter(Boolean).map(String).find((c:string)=>c.startsWith('__Host-dealer_session='))!.split(';')[0];
async function signedIn(cookie:string):Promise<Dealer>{const me=await app.inject({url:'/dealer/me',headers:{cookie}});assert.equal(me.statusCode,200,me.body);return {cookie,csrf:me.json().csrfToken};}
const address={line1:'100 Main St',city:'Austin',state:'TX',postalCode:'78701'};
const profile={company:'Laser Supply Co',contactName:'Pat Lee',phone:'512-555-0100',resaleCert:'TX-123',address};
async function register(email:string):Promise<Dealer>{
 const res=await app.inject({method:'POST',url:'/dealer/auth/register',payload:{...profile,email,password:'correct horse battery'},headers:{origin}});
 assert.equal(res.statusCode,201,res.body);return signedIn(cookieFrom(res));
}
const webhook=(event:any)=>{const body=JSON.stringify({livemode:false,...event});return app.inject({method:'POST',url:'/dealer/stripe/webhook',payload:body,headers:{'content-type':'application/json','stripe-signature':signStripePayload(body,secret)}});};
const sessionEvent=(type:string,order:any,extra:any={})=>({id:'evt_'+randomUUID(),type,data:{object:{id:'cs_x',mode:'payment',metadata:{dealer_order_id:order.id},amount_total:order.totalCents,currency:'usd',payment_intent:'pi_'+order.number,payment_status:'unpaid',...extra}}});
const approve=async(id:string)=>{const a=(await staff('m1','GET','/dealer-admin/accounts')).json().items.find((x:any)=>x.id===id);return staff('m1','POST',`/dealer-admin/accounts/${id}/decision`,{action:'approve',expectedVersion:a.version});};

before(async()=>{
 db=await createDatabase();await db.exec(schema);await seedDemo(db);
 // m4 manages dealers, m5 only views them, m6 has no dealer access; m1 is a company admin.
 await db.query(`UPDATE users SET grants='["dealers","dealers_manage"]' WHERE id='m4'`);
 await db.query(`UPDATE users SET grants='["dealers"]' WHERE id='m5'`);
 for(const [sku,name,status,price,listed] of [['LZ-100','Laser 100W','live',1999,true],['AC-1','Air assist','clearance',49.5,true],['DEV-9','Prototype','dev',500,true],['HID-1','Hidden','live',10,false],['NOP-1','No dealer price','live',null,true]] as const){
  await db.query('INSERT INTO product_catalog(org_id,sku,name_en,status,msrp) VALUES($1,$2,$3,$4,$5)',['demo',sku,name,status,2999]);
  if(price!==null)await db.query("INSERT INTO product_channel_prices(org_id,sku,channel,price,listed) VALUES('demo',$1,'dealer',$2,$3)",[sku,price,listed]);
 }
 await db.query("INSERT INTO wms_items(org_id,sku,name) VALUES('demo','LZ-100','Laser 100W'),('demo','AC-1','Air assist')");
 await db.query("INSERT INTO wms_stock(org_id,sku,location,qty) VALUES('demo','LZ-100','us',12),('demo','AC-1','us',3)");
 app=await buildApp({db,environment:'production',integrations:{executiveUserIds:['m1'],appPublicUrl:origin},completionModel:null,translationModel:null,nudgeIntervalMs:0,
  mailer:async m=>{mails.push(m);},dealer:{orgId:'demo',publicUrl:origin,stripe,google,notifyEmail:'sales@onelaser.test'}});
});
after(async()=>{await app?.close();});

test('portal is closed without an org, and live keys need an explicit switch',async()=>{
 const closed=await buildApp({db,environment:'production',closeDatabase:false,mailer:null,dealer:{publicUrl:origin}});
 try{
  assert.equal((await closed.inject('/dealer/capabilities')).json().enabled,false);
  assert.equal((await closed.inject({method:'POST',url:'/dealer/auth/login',payload:{email:'a@b.co',password:'x'},headers:{origin}})).statusCode,503);
 }finally{await closed.close();}
 const cap=(await app.inject('/dealer/capabilities')).json();
 assert.equal(cap.enabled,true);assert.equal(cap.paymentMode,'test');assert.deepEqual(cap.paymentMethods,['us_bank_account']);
 assert.equal(dealerOptionsFromEnv({DEALER_STRIPE_SECRET_KEY:'sk_live_abcdefghijklmnop',DEALER_STRIPE_WEBHOOK_SECRET:secret}).stripe,undefined,'a live key without DEALER_STRIPE_ALLOW_LIVE stays off');
 assert.equal(dealerOptionsFromEnv({DEALER_STRIPE_SECRET_KEY:'sk_test_abcdefghijklmnop',DEALER_STRIPE_WEBHOOK_SECRET:secret}).stripe?.mode,'test');
});

test('register, review, sign in; pending dealers see no prices; staff permissions',async()=>{
 assert.equal((await app.inject({method:'POST',url:'/dealer/auth/register',payload:{...profile,email:'x@shop.test',password:'correct horse battery'},headers:{origin:'https://evil.test'}})).statusCode,403,'foreign origin');
 const pat=await register('Pat@Shop.test');
 assert.equal((await app.inject({method:'POST',url:'/dealer/auth/register',payload:{...profile,email:'pat@shop.test',password:'another long one'},headers:{origin}})).statusCode,409,'email is unique regardless of case');
 assert.equal((await dealer(pat,'GET','/me')).json().dealer.status,'pending');
 assert.equal((await dealer(pat,'GET','/products')).statusCode,403,'no prices before approval');
 assert.equal((await dealer(pat,'POST','/orders',{requestKey:randomUUID(),lines:[{sku:'LZ-100',qty:1}]})).statusCode,403);
 assert.equal((await app.inject({method:'POST',url:'/dealer/auth/login',payload:{email:'pat@shop.test',password:'wrong password'},headers:{origin}})).statusCode,401);
 const login=await app.inject({method:'POST',url:'/dealer/auth/login',payload:{email:'PAT@shop.test',password:'correct horse battery'},headers:{origin}});
 assert.equal(login.statusCode,200);assert.match(String([login.headers['set-cookie']].flat()[0]),/HttpOnly; SameSite=Lax; Max-Age=604800; Secure/);
 assert.equal((await dealer({...pat,csrf:'wrong'},'PATCH','/profile',profile)).statusCode,403,'CSRF token is required');
 assert.ok(mails.some(m=>m.to==='sales@onelaser.test'&&/Laser Supply Co/.test(m.subject)),'sales hears about the application');

 assert.equal((await staff('m6','GET','/dealer-admin/accounts')).statusCode,403);
 const list=(await staff('m5','GET','/dealer-admin/accounts?status=pending')).json().items;assert.equal(list[0].email,'pat@shop.test');
 assert.equal((await staff('m5','POST',`/dealer-admin/accounts/${list[0].id}/decision`,{action:'approve',expectedVersion:list[0].version})).statusCode,403,'view-only staff cannot approve');
 assert.equal((await staff('m4','POST',`/dealer-admin/accounts/${list[0].id}/decision`,{action:'reject',expectedVersion:list[0].version})).statusCode,400,'rejection needs a reason');
 const ok=await staff('m4','POST',`/dealer-admin/accounts/${list[0].id}/decision`,{action:'approve',expectedVersion:list[0].version});assert.equal(ok.statusCode,200,ok.body);
 assert.equal((await staff('m4','POST',`/dealer-admin/accounts/${list[0].id}/decision`,{action:'approve',expectedVersion:list[0].version})).statusCode,409,'stale version');
 assert.ok(mails.some(m=>m.to==='pat@shop.test'&&/approved/.test(m.subject)));
 assert.equal((await dealer(pat,'PATCH','/profile',profile)).statusCode,409,'approved details change through OneLaser');

 const items=(await dealer(pat,'GET','/products')).json().items;
 assert.deepEqual(items.map((i:any)=>i.sku).sort(),['AC-1','LZ-100'],'only listed, sellable SKUs with a dealer price');
 const lz=items.find((i:any)=>i.sku==='LZ-100'),ac=items.find((i:any)=>i.sku==='AC-1');
 assert.equal(lz.priceCents,199900);assert.equal(lz.availability,'in_stock');assert.equal(ac.priceCents,4950);assert.equal(ac.availability,'limited');assert.equal(ac.clearance,true);
 assert.equal(lz.qty,undefined,'exact stock stays internal');
});

test('Google sign-in creates a pending account that must complete its profile; never merges by email',async()=>{
 const flow=async(code:string)=>{
  const start=await app.inject('/dealer/auth/google/start?lang=en');assert.equal(start.statusCode,302);
  const state=new URL(start.headers.location!).searchParams.get('state')!,oauth=String([start.headers['set-cookie']].flat()[0]).split(';')[0];
  return app.inject({url:`/dealer/auth/google/callback?state=${state}&code=${code}`,headers:{cookie:oauth}});
 };
 const first=await flow('sam');assert.equal(first.statusCode,302);assert.equal(first.headers.location,origin+'/dealer/?lang=en');
 const sam=await signedIn(cookieFrom(first));const me=(await dealer(sam,'GET','/me')).json().dealer;
 assert.equal(me.email,'sam@gmail.test');assert.equal(me.signIn,'google');assert.equal(me.profileComplete,false);
 assert.equal((await approve(me.id)).statusCode,409,'cannot approve an incomplete profile');
 assert.equal((await dealer(sam,'PATCH','/profile',{...profile,company:'Sam Signs'})).statusCode,200);
 assert.equal((await approve(me.id)).statusCode,200);
 const again=await flow('sam');assert.equal((await dealer(await signedIn(cookieFrom(again)),'GET','/me')).json().dealer.id,me.id,'same Google subject, same account');
 await register('kim@gmail.test');
 const clash=await flow('kim');assert.equal(new URL(clash.headers.location!).searchParams.get('error'),'email_in_use','a password account with that email is not taken over');
 const replay=await app.inject({url:'/dealer/auth/google/callback?state='+'a'.repeat(43)+'&code=x',headers:{cookie:'__Host-dealer_oauth='+'b'.repeat(43)}});assert.equal(replay.statusCode,400);
});

test('order → ACH checkout → processing → paid → ship with tracking and stock out',async()=>{
 const ann=await register('ann@dealer.test');const id=(await dealer(ann,'GET','/me')).json().dealer.id;await approve(id);
 const key=randomUUID();
 assert.equal((await dealer(ann,'POST','/orders',{requestKey:randomUUID(),lines:[{sku:'DEV-9',qty:1}]})).statusCode,400,'development products cannot be ordered');
 const created=await dealer(ann,'POST','/orders',{requestKey:key,poNumber:'PO-77',lines:[{sku:'lz-100',qty:2},{sku:'AC-1',qty:1},{sku:'LZ-100',qty:1}],unitCents:1} as any);
 assert.equal(created.statusCode,400,'clients cannot send prices');
 const res=await dealer(ann,'POST','/orders',{requestKey:key,poNumber:'PO-77',lines:[{sku:'lz-100',qty:2},{sku:'AC-1',qty:1},{sku:'LZ-100',qty:1}]});
 assert.equal(res.statusCode,201,res.body);const order=res.json();
 assert.match(order.number,/^D-\d{4,}$/);assert.equal(order.status,'pending_payment');assert.equal(order.totalCents,3*199900+4950);
 assert.deepEqual(order.lines.map((l:any)=>[l.sku,l.qty]),[['AC-1',1],['LZ-100',3]]);assert.deepEqual(order.shipTo,{...address,country:'US'});
 assert.equal((await dealer(ann,'POST','/orders',{requestKey:key,lines:[{sku:'AC-1',qty:9}]})).json().id,order.id,'a retried request returns the same order');

 const co=await dealer(ann,'POST',`/orders/${order.id}/checkout`,{});assert.equal(co.statusCode,200,co.body);
 const sessionCall=calls.find(c=>c.path==='/v1/checkout/sessions')!;
 assert.equal(sessionCall.params['payment_method_types[0]'],'us_bank_account');assert.equal(sessionCall.params.mode,'payment');
 assert.equal(sessionCall.params['line_items[1][price_data][unit_amount]'],'199900');assert.equal(sessionCall.params['line_items[1][quantity]'],'3');
 assert.equal(sessionCall.params['payment_intent_data[setup_future_usage]'],'off_session');assert.match(sessionCall.params.customer,/^cus_/);
 assert.equal((await dealer(ann,'POST',`/orders/${order.id}/checkout`,{})).json().url,co.json().url,'an open payment page is reused');
 assert.equal(calls.filter(c=>c.path==='/v1/customers').length,1);

 assert.equal((await app.inject({method:'POST',url:'/dealer/stripe/webhook',payload:'{}',headers:{'content-type':'application/json','stripe-signature':'t=1,v1=00'}})).statusCode,400);
 const wrongAmount=await webhook(sessionEvent('checkout.session.completed',{...order,totalCents:1}));assert.equal(wrongAmount.statusCode,200);
 assert.equal((await dealer(ann,'GET',`/orders/${order.id}`)).json().status,'pending_payment','a mismatched amount changes nothing');
 const completed=sessionEvent('checkout.session.completed',order);
 assert.equal((await webhook(completed)).statusCode,200);assert.equal((await webhook(completed)).statusCode,200,'replays are acknowledged');
 assert.equal((await dealer(ann,'GET',`/orders/${order.id}`)).json().status,'processing');
 const admin=(await staff('m4','GET',`/dealer-admin/orders/${order.id}`)).json();assert.equal(admin.canShip,false);
 assert.ok(admin.events.some((e:any)=>e.type==='payment_rejected'),'the rejected event is kept for review');
 const early=await staff('m4','POST',`/dealer-admin/orders/${order.id}/ship`,{carrier:'ups',trackingNumber:'1Z999',expectedVersion:admin.version});
 assert.equal(early.statusCode,409,'no shipping before ACH clears');

 assert.equal((await webhook(sessionEvent('checkout.session.async_payment_succeeded',order))).statusCode,200);
 const paid=(await staff('m4','GET',`/dealer-admin/orders/${order.id}`)).json();assert.equal(paid.status,'paid');assert.equal(paid.canShip,true);
 assert.ok(mails.some(m=>m.to==='ann@dealer.test'&&/Payment received/.test(m.subject)));
 assert.equal((await staff('m1','GET','/dealer-admin/orders?status=to_ship')).json().items.some((o:any)=>o.id===order.id),true);
 assert.equal((await staff('m5','POST',`/dealer-admin/orders/${order.id}/ship`,{carrier:'ups',trackingNumber:'1Z999',expectedVersion:paid.version})).statusCode,403,'view-only staff cannot ship');
 const short=await staff('m4','POST',`/dealer-admin/orders/${order.id}/ship`,{carrier:'ups',trackingNumber:'1Z999',location:'dg',expectedVersion:paid.version});
 assert.equal(short.statusCode,409);assert.equal(short.json().error.code,'WMS_NEGATIVE_STOCK');
 const ship=await staff('m4','POST',`/dealer-admin/orders/${order.id}/ship`,{carrier:'ups',trackingNumber:'1Z 999 AA1',expectedVersion:paid.version});
 assert.equal(ship.statusCode,200,ship.body);
 const stock=(await db.query("SELECT sku,qty FROM wms_stock WHERE org_id='demo' AND location='us' ORDER BY sku")).rows.map((r:any)=>[r.sku,Number(r.qty)]);
 assert.deepEqual(stock,[['AC-1',2],['LZ-100',9]]);
 const moves=(await db.query("SELECT sku,qty,reference FROM wms_movements WHERE type='out' ORDER BY sku")).rows;
 assert.deepEqual(moves.map((m:any)=>[m.sku,Number(m.qty),m.reference]),[['AC-1',-1,order.number],['LZ-100',-3,order.number]]);

 const seen=(await dealer(ann,'GET',`/orders/${order.id}`)).json();
 assert.equal(seen.status,'shipped');assert.equal(seen.carrier,'ups');assert.equal(seen.trackingNumber,'1Z 999 AA1');assert.equal(seen.trackingUrl,'https://www.ups.com/track?tracknum=1Z999AA1');
 assert.deepEqual(seen.events.map((e:any)=>e.type),['created','checkout_started','payment_rejected','processing','paid','shipped']);
 assert.equal(seen.events[5].by,'staff');assert.equal(seen.events[5].byName,undefined,'staff names stay internal');
 assert.ok(mails.some(m=>m.to==='ann@dealer.test'&&/has shipped/.test(m.subject)&&/1Z 999 AA1/.test(m.text)));

 // An ACH return after shipping flags the order for a person.
 await webhook({id:'evt_dispute',type:'charge.dispute.created',data:{object:{id:'dp_1',payment_intent:'pi_'+order.number,reason:'unauthorized'}}});
 assert.equal((await dealer(ann,'GET',`/orders/${order.id}`)).json().status,'disputed');
 assert.ok(mails.some(m=>m.to==='sales@onelaser.test'&&/disputed/.test(m.subject)&&/already shipped/.test(m.text)));

 const bob=await register('bob@dealer.test');await approve((await dealer(bob,'GET','/me')).json().dealer.id);
 assert.equal((await dealer(bob,'GET',`/orders/${order.id}`)).statusCode,404,'dealers see only their own orders');
});

test('trusted dealers ship while ACH clears; failed payments can be retried; unpaid orders cancel',async()=>{
 const cy=await register('cy@dealer.test');const id=(await dealer(cy,'GET','/me')).json().dealer.id;await approve(id);
 const acct=()=>staff('m1','GET','/dealer-admin/accounts').then(r=>r.json().items.find((x:any)=>x.id===id));
 assert.equal((await staff('m4','PATCH',`/dealer-admin/accounts/${id}`,{shipBeforeClear:true,expectedVersion:(await acct()).version})).statusCode,403,'only admins may trust a dealer');
 assert.equal((await staff('m1','PATCH',`/dealer-admin/accounts/${id}`,{shipBeforeClear:true,expectedVersion:(await acct()).version})).statusCode,200);

 const order=(await dealer(cy,'POST','/orders',{requestKey:randomUUID(),lines:[{sku:'AC-1',qty:2}]})).json();
 await dealer(cy,'POST',`/orders/${order.id}/checkout`,{});
 await webhook(sessionEvent('checkout.session.completed',order));
 const processing=(await staff('m4','GET',`/dealer-admin/orders/${order.id}`)).json();assert.equal(processing.status,'processing');assert.equal(processing.canShip,true);
 await webhook(sessionEvent('checkout.session.async_payment_failed',order));
 assert.equal((await dealer(cy,'GET',`/orders/${order.id}`)).json().status,'payment_failed');
 assert.ok(mails.some(m=>m.to==='cy@dealer.test'&&/failed/.test(m.subject)));
 const retry=await dealer(cy,'POST',`/orders/${order.id}/checkout`,{});assert.equal(retry.statusCode,200,'a failed payment can be retried');
 const shipNo=await staff('m4','POST',`/dealer-admin/orders/${order.id}/ship`,{carrier:'fedex',trackingNumber:'7777',expectedVersion:(await staff('m4','GET',`/dealer-admin/orders/${order.id}`)).json().version});
 assert.equal(shipNo.statusCode,409,'a failed payment is not shippable even for trusted dealers');

 const cancelled=await dealer(cy,'POST',`/orders/${order.id}/cancel`,{});assert.equal(cancelled.statusCode,200,cancelled.body);assert.equal(cancelled.json().status,'cancelled');
 assert.equal([...sessions.values()].filter(s=>s.status==='expired').length,1,'the open payment page is closed first');
 assert.equal((await dealer(cy,'POST',`/orders/${order.id}/checkout`,{})).statusCode,409);

 const second=(await dealer(cy,'POST','/orders',{requestKey:randomUUID(),lines:[{sku:'LZ-100',qty:1}]})).json();
 await webhook(sessionEvent('checkout.session.completed',second,{payment_status:'paid'}));
 assert.equal((await dealer(cy,'POST',`/orders/${second.id}/cancel`,{})).statusCode,409,'paid orders are refunded, not cancelled');
 const v=(await staff('m4','GET',`/dealer-admin/orders/${second.id}`)).json().version;
 assert.equal((await staff('m4','POST',`/dealer-admin/orders/${second.id}/ship`,{carrier:'freight',trackingNumber:'PRO 12345',deductStock:false,trackingUrl:'http://insecure.test/x',expectedVersion:v})).statusCode,400,'tracking links must be https');
 const shipped=await staff('m4','POST',`/dealer-admin/orders/${second.id}/ship`,{carrier:'freight',trackingNumber:'PRO 12345',deductStock:false,expectedVersion:v});
 assert.equal(shipped.statusCode,200,shipped.body);assert.equal(shipped.json().trackingUrl,null);
 await webhook({id:'evt_refund',type:'charge.refunded',data:{object:{id:'ch_1',payment_intent:'pi_'+second.number,refunded:true,amount_refunded:199900}}});
 assert.equal((await dealer(cy,'GET',`/orders/${second.id}`)).json().status,'refunded');

 // Suspending signs the dealer out everywhere.
 assert.equal((await staff('m4','POST',`/dealer-admin/accounts/${id}/decision`,{action:'suspend',note:'Unpaid returns',expectedVersion:(await acct()).version})).statusCode,200);
 assert.equal((await dealer(cy,'GET','/me')).statusCode,401);
});

test('ERP permissions page can grant dealer access; staff summary counts work queues',async()=>{
 const set=await staff('m1','POST','/erp/access',{userId:'m6',area:'dealers',level:'view'});assert.equal(set.statusCode,200,set.body);assert.equal(set.json().access.dealers,'view');
 assert.equal((await staff('m6','GET','/dealer-admin/summary')).statusCode,200);
 const sum=(await staff('m1','GET','/dealer-admin/summary')).json();
 assert.equal(sum.canTrust,true);assert.equal(sum.paymentMode,'test');assert.equal(typeof sum.toShip,'number');
 assert.equal((await staff('m4','GET','/dealer-admin/summary')).json().canTrust,false);
});
