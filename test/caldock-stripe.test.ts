import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,type Database} from '../src/db.js';
import {caldockOptionsFromEnv} from '../src/caldock.js';
import {type CaldockGateway,type CaldockProvider} from '../src/caldock-oidc.js';
import {createCaldockStripe,signStripePayload,verifyStripeEvent,type StripeFetch} from '../src/caldock-stripe.js';

let db:Database,dbAdmin:Database|undefined,isolated:string|undefined,app:Awaited<ReturnType<typeof buildApp>>;
const origin='https://craftos.example.test',adminId=randomUUID(),webhookSecret='whsec_testsecret1234567890';
type Login={cookie:string;csrf:string;user:any};
type Call={method:string;path:string;params:URLSearchParams;idempotency?:string};
const calls:Call[]=[];
const sessions=new Map<string,{status:string;url:string}>();
let sessionCount=0;
const fakeFetch:StripeFetch=async(url,init)=>{
  const u=new URL(url),params=new URLSearchParams(init.method==='GET'?u.search:init.body||'');
  calls.push({method:init.method,path:u.pathname,params,idempotency:init.headers['idempotency-key']});
  assert.equal(init.headers.authorization,'Bearer sk_test_fakeKey1234567890');
  const ok=(body:any)=>({ok:true,status:200,json:async()=>body});
  if(init.method==='POST'&&u.pathname==='/v1/checkout/sessions'){const id='cs_test_'+(++sessionCount);sessions.set(id,{status:'open',url:'https://checkout.stripe.test/'+id});return ok({id,...sessions.get(id)});}
  if(init.method==='POST'&&u.pathname==='/v1/coupons')return ok({id:params.get('id')});
  const cs=/^\/v1\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(u.pathname);
  if(cs){const s=sessions.get(cs[1]);if(!s)return {ok:false,status:404,json:async()=>({error:{code:'resource_missing',message:'secret detail'}})};if(cs[2])s.status='expired';return ok({id:cs[1],...s});}
  if(u.pathname.startsWith('/v1/subscriptions/'))return ok({id:u.pathname.split('/').pop()});
  return {ok:false,status:400,json:async()=>({error:{code:'unexpected'}})};
};
const stripe=createCaldockStripe({secretKey:'sk_test_fakeKey1234567890',webhookSecret,fetch:fakeFetch,apiBase:'https://api.stripe.test'});
const gateways=Object.fromEntries((['google','apple'] as const).map(provider=>[provider,{
  authorizationUrl({state}:{state:string}){return `https://provider.example/${provider}?state=${state}`;},
  async authenticate({code}:{code:string}){return {provider,subject:code,email:code+'@example.test',name:code};}
}])) as Record<CaldockProvider,CaldockGateway>;

before(async()=>{
  if(process.env.TEST_DATABASE_URL){dbAdmin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});isolated='caldock_stripe_'+randomUUID().replaceAll('-','');await dbAdmin.exec(`CREATE SCHEMA ${isolated}`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+isolated);db=await createDatabase({connectionString:url.toString()});}else db=await createDatabase();
  await db.exec(schema);
  await db.exec(schema); // migrations must be repeatable
  await db.query('INSERT INTO caldock_users(id,display_name,email) VALUES($1,$2,$3)',[adminId,'Owner','owner@example.test']);
  await db.query('INSERT INTO caldock_identities(provider,subject,user_id) VALUES($1,$2,$3)',['google','stripe-owner',adminId]);
  app=await buildApp({db,environment:'production',caldock:{publicUrl:origin,providers:gateways,adminUserIds:[adminId],stripe}});
});
after(async()=>{if(app)await app.close();else if(db)await db.close();if(dbAdmin&&isolated){await dbAdmin.exec(`DROP SCHEMA ${isolated} CASCADE`);await dbAdmin.close();}});

const cookieList=(r:any)=>[r.headers['set-cookie']].flat().filter(Boolean).map(String);
async function login(code:string):Promise<Login>{
  const start=await app.inject(`/caldock/auth/google/start?next=account&lang=zh&interval=year`);
  const state=new URL(start.headers.location!).searchParams.get('state')!;
  const cookie=cookieList(start).map(c=>c.split(';')[0]).join('; ');
  const callback=await app.inject({url:`/caldock/auth/google/callback?state=${state}&code=${code}`,headers:{cookie}});
  const session=cookieList(callback).find(c=>c.startsWith('__Host-caldock_session='))!.split(';')[0];
  const me=(await app.inject({url:'/caldock/me',headers:{cookie:session}})).json();
  return {cookie:session,csrf:me.csrfToken,user:me.user};
}
const send=(who:Login,method:'GET'|'POST'|'PATCH',url:string,payload?:Record<string,unknown>)=>app.inject({method,url:'/caldock'+url,payload,headers:{cookie:who.cookie,origin,'x-csrf-token':who.csrf}});
function webhook(event:Record<string,unknown>,options:{secret?:string;timestamp?:number}={}){
  const payload=JSON.stringify({livemode:false,...event});
  return app.inject({method:'POST',url:'/caldock/stripe/webhook',payload,headers:{'content-type':'application/json','stripe-signature':signStripePayload(payload,options.secret||webhookSecret,options.timestamp)}});
}
const completed=(orderId:string,sessionId:string,amount:number,extra:Record<string,unknown>={})=>({id:'evt_'+randomUUID(),type:'checkout.session.completed',data:{object:{id:sessionId,object:'checkout.session',mode:'subscription',payment_status:'paid',amount_total:amount,currency:'usd',client_reference_id:orderId,metadata:{caldock_order_id:orderId},customer:'cus_'+orderId.slice(0,8),subscription:'sub_'+orderId.slice(0,8),...extra}}});

test('capabilities advertise test-mode payments; live keys need an explicit switch; bad config never stops startup',async()=>{
  const cap=(await app.inject('/caldock/capabilities')).json();assert.equal(cap.payments,true);assert.equal(cap.paymentMode,'test');
  assert.throws(()=>createCaldockStripe({secretKey:'sk_live_fakeKey1234567890',webhookSecret}),/ALLOW_LIVE/);
  assert.equal(createCaldockStripe({secretKey:'sk_live_fakeKey1234567890',webhookSecret,allowLive:true}).mode,'live');
  assert.throws(()=>createCaldockStripe({secretKey:'pk_test_publishable123456',webhookSecret}),/secret key/);
  const original=console.error;console.error=()=>{};
  try{assert.equal(caldockOptionsFromEnv({CALDOCK_STRIPE_SECRET_KEY:'sk_live_fakeKey1234567890',CALDOCK_STRIPE_WEBHOOK_SECRET:webhookSecret}).stripe,undefined);}finally{console.error=original;}
  assert.equal(caldockOptionsFromEnv({}).stripe,undefined);
});

test('signature verification rejects tampering, stale timestamps and wrong secrets',()=>{
  const body=JSON.stringify({id:'evt_1',type:'x',data:{object:{}}}),now=Date.now();
  assert.equal(verifyStripeEvent(Buffer.from(body),signStripePayload(body,webhookSecret,Math.floor(now/1000)),webhookSecret,now).id,'evt_1');
  assert.throws(()=>verifyStripeEvent(Buffer.from(body+' '),signStripePayload(body,webhookSecret),webhookSecret));
  assert.throws(()=>verifyStripeEvent(Buffer.from(body),signStripePayload(body,webhookSecret,Math.floor(now/1000)-600),webhookSecret,now));
  assert.throws(()=>verifyStripeEvent(Buffer.from(body),signStripePayload(body,'whsec_otherSecret123456'),webhookSecret));
  assert.throws(()=>verifyStripeEvent(Buffer.from(body),undefined,webhookSecret));
});

test('checkout uses the server price, reuses one open page, and only a signed event marks the order paid',async()=>{
  const buyer=await login('stripe-buyer');
  const order=(await send(buyer,'POST','/orders',{interval:'quarter',requestKey:randomUUID()})).json();
  assert.equal(order.amount_cents,53700);
  const first=await send(buyer,'POST',`/orders/${order.id}/checkout`,{lang:'en'});assert.equal(first.statusCode,200,first.body);
  const created=calls.find(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions')!;
  assert.equal(created.params.get('mode'),'subscription');
  assert.equal(created.params.get('line_items[0][price_data][unit_amount]'),'53700');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval]'),'month');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval_count]'),'3');
  assert.equal(created.params.get('metadata[caldock_order_id]'),order.id);
  assert.equal(created.params.get('customer_email'),'stripe-buyer@example.test');
  assert.match(created.params.get('success_url')!,/^https:\/\/craftos\.example\.test\/caldock\/\?view=orders&lang=en&interval=quarter&checkout=success$/);
  const again=await send(buyer,'POST',`/orders/${order.id}/checkout`,{lang:'en'});
  assert.equal(again.json().url,first.json().url);
  assert.equal(calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').length,1);
  const other=await login('stripe-other');
  assert.equal((await send(other,'POST',`/orders/${order.id}/checkout`,{})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:`/caldock/orders/${order.id}/checkout`,payload:{},headers:{cookie:buyer.cookie}})).statusCode,403);

  const sessionId=[...sessions.keys()].pop()!;
  assert.equal((await webhook(completed(order.id,sessionId,53700),{secret:'whsec_forgedSecret123456'})).statusCode,400);
  assert.equal((await webhook(completed(order.id,sessionId,53700),{timestamp:Math.floor(Date.now()/1000)-3600})).statusCode,400);
  assert.equal((await webhook({...completed(order.id,sessionId,53700),livemode:true})).statusCode,400);
  assert.equal((await send(buyer,'GET',`/orders/${order.id}`)).json().status,'pending_payment');

  const ok=await webhook(completed(order.id,sessionId,53700));assert.equal(ok.statusCode,200,ok.body);
  const paid=(await send(buyer,'GET',`/orders/${order.id}`)).json();
  assert.equal(paid.status,'paid');assert.equal(paid.stripe_subscription_id,'sub_'+order.id.slice(0,8));
  assert.equal((await webhook(completed(order.id,sessionId,53700))).statusCode,200); // duplicate delivery is harmless
  assert.equal((await db.query('SELECT count(*)::int AS n FROM caldock_payment_events WHERE order_id=$1',[order.id])).rows[0].n,1);
  assert.equal((await send(buyer,'POST',`/orders/${order.id}/checkout`,{})).statusCode,409);
});

test('the weekly plan charges 6900 every week and delivery covers 7 days',async()=>{
  const owner=await login('stripe-owner'),buyer=await login('stripe-weekly');
  const order=(await send(buyer,'POST','/orders',{interval:'week',requestKey:randomUUID()})).json();
  assert.equal(order.amount_cents,6900);
  await send(buyer,'POST',`/orders/${order.id}/checkout`,{});
  const created=calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').pop()!;
  assert.equal(created.params.get('line_items[0][price_data][unit_amount]'),'6900');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval]'),'week');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval_count]'),'1');
  const sessionId=[...sessions.keys()].pop()!;
  assert.equal((await webhook(completed(order.id,sessionId,6900))).statusCode,200);
  const paid=(await send(buyer,'GET',`/orders/${order.id}`)).json();assert.equal(paid.status,'paid');
  const preparing=(await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'provisioning',expectedVersion:paid.version,deliveryNote:'preparing'}));assert.equal(preparing.statusCode,200,preparing.body);
  const live=(await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'active',expectedVersion:preparing.json().version,deliveryNote:'ready'}));assert.equal(live.statusCode,200,live.body);
  const days=(new Date(live.json().billing_ends_at).getTime()-new Date(live.json().delivered_at).getTime())/86400000;
  assert.ok(Math.abs(days-7)<0.01,String(days));
});

test('the half-yearly plan charges 95400 every 6 months',async()=>{
  const buyer=await login('stripe-half');
  const order=(await send(buyer,'POST','/orders',{interval:'half',requestKey:randomUUID()})).json();
  assert.equal(order.amount_cents,95400);
  await send(buyer,'POST',`/orders/${order.id}/checkout`,{});
  const created=calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').pop()!;
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval]'),'month');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval_count]'),'6');
});

test('three first-period seats a day: 20% off once, weekly excluded, a cancelled hold frees its seat',async()=>{
  const offerApp=await buildApp({db,environment:'production',closeDatabase:false,caldock:{publicUrl:origin,providers:gateways,stripe,firstPeriodOffer:true}});
  const signIn=async(code:string)=>{
    const start=await offerApp.inject('/caldock/auth/google/start?next=account&lang=zh&interval=month');
    const state=new URL(start.headers.location!).searchParams.get('state')!,flow=cookieList(start).map(c=>c.split(';')[0]).join('; ');
    const back=await offerApp.inject({url:`/caldock/auth/google/callback?state=${state}&code=${code}`,headers:{cookie:flow}});
    const cookie=cookieList(back).find(c=>c.startsWith('__Host-caldock_session='))!.split(';')[0];
    return {cookie,csrf:(await offerApp.inject({url:'/caldock/me',headers:{cookie}})).json().csrfToken};
  };
  const call=(who:{cookie:string;csrf:string},method:'POST'|'PATCH',url:string,payload:Record<string,unknown>)=>offerApp.inject({method,url:'/caldock'+url,payload,headers:{cookie:who.cookie,origin,'x-csrf-token':who.csrf}});
  const buy=async(code:string,interval:string)=>{
    const who=await signIn(code),order=(await call(who,'POST','/orders',{interval,requestKey:randomUUID()})).json();
    assert.equal((await call(who,'POST',`/orders/${order.id}/checkout`,{})).statusCode,200);
    const params=calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').pop()!.params;
    const row=(await db.query('SELECT * FROM caldock_orders WHERE id=$1',[order.id])).rows[0];
    return {who,order,row,params};
  };
  const left=async()=>(await offerApp.inject('/caldock/capabilities')).json().offer;
  try{
    await db.query("UPDATE caldock_orders SET offer_day=NULL");
    const fresh=await left();assert.equal(fresh.seatsLeft,3);assert.equal(fresh.percentOff,20);
    assert.ok(Date.parse(fresh.resetsAt)>Date.now());assert.ok(Date.parse(fresh.resetsAt)-Date.now()<=86400000);
    assert.equal(new Date(fresh.resetsAt).getUTCHours(),16);
    const weekly=await buy('offer-weekly','week');
    assert.equal(weekly.row.amount_cents,6900);assert.equal(weekly.params.get('discounts[0][coupon]'),null);assert.equal((await left()).seatsLeft,3);
    const first=await buy('offer-1','month');
    assert.equal(first.row.amount_cents,15920);assert.equal(first.row.list_amount_cents,19900);
    assert.equal(first.params.get('line_items[0][price_data][unit_amount]'),'19900');assert.equal(first.params.get('discounts[0][coupon]'),'caldock-first-period-20');assert.ok(first.params.get('expires_at'));
    const coupon=calls.filter(c=>c.path==='/v1/coupons').pop()!.params;assert.equal(coupon.get('duration'),'once');assert.equal(coupon.get('percent_off'),'20');
    const second=await buy('offer-2','year');assert.equal(second.row.amount_cents,133440);
    const third=await buy('offer-3','half');assert.equal(third.row.amount_cents,76320);
    assert.equal((await left()).seatsLeft,0);
    const fourth=await buy('offer-4','quarter');
    assert.equal(fourth.row.amount_cents,53700);assert.equal(fourth.row.offer_day,null);assert.equal(fourth.params.get('discounts[0][coupon]'),null);
    assert.equal((await call(first.who,'PATCH',`/orders/${first.order.id}`,{action:'cancel_pending',expectedVersion:first.order.version})).statusCode,200);
    assert.equal((await left()).seatsLeft,1);
    await db.query("UPDATE caldock_orders SET offer_hold_until=now()-interval '1 minute' WHERE id=$1",[second.order.id]);
    assert.equal((await left()).seatsLeft,2);
  }finally{await db.query("UPDATE caldock_orders SET offer_day=NULL");await offerApp.close();}
});

test('paid orders update the live stock, mail the owners once, and sold-out stops new orders',async()=>{
  const sent:{to:string;subject:string;text:string}[]=[];let failing=false;
  const stockApp=await buildApp({db,environment:'production',closeDatabase:false,mailer:async m=>{if(failing)throw new Error('down');sent.push(m);},caldock:{publicUrl:origin,providers:gateways,stripe,liveStock:true,orderNotifyEmails:['a@example.test','b@example.test']}});
  const signIn=async(code:string)=>{
    const start=await stockApp.inject('/caldock/auth/google/start?next=account&lang=zh&interval=month');
    const state=new URL(start.headers.location!).searchParams.get('state')!,flow=cookieList(start).map(c=>c.split(';')[0]).join('; ');
    const back=await stockApp.inject({url:`/caldock/auth/google/callback?state=${state}&code=${code}`,headers:{cookie:flow}});
    const cookie=cookieList(back).find(c=>c.startsWith('__Host-caldock_session='))!.split(';')[0];
    return {cookie,csrf:(await stockApp.inject({url:'/caldock/me',headers:{cookie}})).json().csrfToken};
  };
  const order=(who:{cookie:string;csrf:string})=>stockApp.inject({method:'POST',url:'/caldock/orders',payload:{interval:'month',requestKey:randomUUID()},headers:{cookie:who.cookie,origin,'x-csrf-token':who.csrf}});
  const pay=(event:Record<string,unknown>)=>{const payload=JSON.stringify({livemode:false,...event});return stockApp.inject({method:'POST',url:'/caldock/stripe/webhook',payload,headers:{'content-type':'application/json','stripe-signature':signStripePayload(payload,webhookSecret)}});};
  const stock=async()=>(await stockApp.inject('/caldock/capabilities')).json().stock;
  try{
    await db.query("UPDATE caldock_orders SET paid_at='2026-01-01' WHERE paid_at IS NOT NULL");
    assert.deepEqual(await stock(),{total:10,rented:7,left:3});
    const buyer=await order(await signIn('stock-1')),id=buyer.json().id,event=completed(id,'cs_stock_1',19900);
    assert.deepEqual(await stock(),{total:10,rented:7,left:3}); // an unpaid order holds no Mac
    assert.equal((await pay(event)).statusCode,200);
    assert.deepEqual(await stock(),{total:10,rented:8,left:2});
    assert.deepEqual(sent.map(m=>m.to),['a@example.test','b@example.test']);
    assert.match(sent[0].subject,/新订单.*月付 \$199\.00/);assert.match(sent[0].text,/stock-1@example\.test/);assert.match(sent[0].text,/剩余 2 台/);
    assert.equal((await pay({...event,id:'evt_'+randomUUID()})).statusCode,200);assert.equal(sent.length,2); // a redelivered payment mails nobody
    failing=true;
    const second=(await order(await signIn('stock-2'))).json().id;
    assert.equal((await pay(completed(second,'cs_stock_2',19900))).statusCode,200); // mail down, payment still recorded
    assert.equal((await db.query('SELECT status FROM caldock_orders WHERE id=$1',[second])).rows[0].status,'paid');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM caldock_audit WHERE action='notify.order_mail_failed' AND object_id=$1",[second])).rows[0].n,1);
    failing=false;
    const third=(await order(await signIn('stock-3'))).json().id;
    await pay(completed(third,'cs_stock_3',19900));
    assert.deepEqual(await stock(),{total:10,rented:10,left:0});
    const late=await order(await signIn('stock-4'));
    assert.equal(late.statusCode,409);assert.equal(late.json().error.code,'CALDOCK_SOLD_OUT');
    await db.query("UPDATE caldock_orders SET billing_ends_at=now()-interval '4 days' WHERE id=$1",[third]); // lapsed past the grace
    assert.equal((await stock()).left,1);
    await db.query("UPDATE caldock_orders SET status='refunded' WHERE id=$1",[second]);
    assert.equal((await stock()).left,2);
  }finally{await db.query("UPDATE caldock_orders SET paid_at='2026-01-01' WHERE paid_at IS NOT NULL");await stockApp.close();}
});

test('the launch commission default applies once and never overrides a later admin choice',async()=>{
  assert.equal((await db.query('SELECT commission_bps FROM caldock_settings WHERE id=1')).rows[0].commission_bps,2000);
  await db.query('UPDATE caldock_settings SET commission_bps=0 WHERE id=1');
  await db.exec(schema);
  assert.equal((await db.query('SELECT commission_bps FROM caldock_settings WHERE id=1')).rows[0].commission_bps,0);
});

test('referral links open the storefront domain',async()=>{
  const site=await buildApp({db,environment:'production',closeDatabase:false,caldock:{publicUrl:origin,siteUrl:'https://wodemac.example',marketingUrl:'https://old.example/',providers:gateways,stripe}});
  try{
    const start=await site.inject('/caldock/auth/google/start?next=account&lang=zh&interval=year');
    const state=new URL(start.headers.location!).searchParams.get('state')!,flow=cookieList(start).map(c=>c.split(';')[0]).join('; ');
    const back=await site.inject({url:`/caldock/auth/google/callback?state=${state}&code=stripe-link`,headers:{cookie:flow}});
    const cookie=cookieList(back).find(c=>c.startsWith('__Host-caldock_session='))!.split(';')[0];
    const csrf=(await site.inject({url:'/caldock/me',headers:{cookie}})).json().csrfToken;
    await site.inject({method:'POST',url:'/caldock/affiliate',payload:{},headers:{cookie,origin,'x-csrf-token':csrf}});
    const data=(await site.inject({url:'/caldock/affiliate',headers:{cookie}})).json();
    assert.match(JSON.stringify(data),/https:\/\/wodemac\.example\/\?ref=/);
  }finally{await site.close();}
});

test('renewals of a referred order earn commission once per invoice; unreferred orders earn none',async()=>{
  const partner=await login('stripe-partner'),plain=await login('stripe-renew-plain');
  await send(partner,'POST','/affiliate',{});
  await db.query("UPDATE caldock_settings SET commission_bps=1000,commission_mode='first_order' WHERE id=1");
  try{
    const buyer=await login('stripe-renew-buyer');
    await db.query('INSERT INTO caldock_referrals(customer_id,affiliate_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[buyer.user.id,partner.user.id]);
    const pay=async(who:Login,sub:string)=>{
      const order=(await send(who,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();
      await send(who,'POST',`/orders/${order.id}/checkout`,{});
      assert.equal((await webhook(completed(order.id,[...sessions.keys()].pop()!,19900,{subscription:sub,customer:'cus_'+sub}))).statusCode,200);
      return order;
    };
    const renew=(sub:string,invoice:string)=>webhook({id:'evt_'+randomUUID(),type:'invoice.paid',data:{object:{id:invoice,billing_reason:'subscription_cycle',subscription:sub,amount_paid:19900}}});
    const referred=await pay(buyer,'sub_renew_ref');
    const rows=async(id:string)=>(await db.query('SELECT amount_cents,rate_bps FROM caldock_commissions WHERE order_id=$1',[id])).rows;
    assert.equal((await rows(referred.id)).length,1);
    assert.equal((await renew('sub_renew_ref','in_renew_1')).statusCode,200);
    assert.equal((await renew('sub_renew_ref','in_renew_1')).statusCode,200);
    let list=await rows(referred.id);assert.equal(list.length,2);assert.equal(list[1].amount_cents,1990);assert.equal(list[1].rate_bps,1000);
    await renew('sub_renew_ref','in_renew_2');assert.equal((await rows(referred.id)).length,3);
    const own=await pay(plain,'sub_renew_plain');await renew('sub_renew_plain','in_plain_1');assert.equal((await rows(own.id)).length,0);
    await db.query("UPDATE caldock_commissions SET status='void' WHERE order_id=$1",[referred.id]);
    await renew('sub_renew_ref','in_renew_3');assert.equal((await rows(referred.id)).length,3);
  }finally{await db.query('UPDATE caldock_settings SET commission_bps=0 WHERE id=1');}
});

test('amount mismatch is recorded for review and never marks the order paid',async()=>{
  const buyer=await login('stripe-mismatch');
  const order=(await send(buyer,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();
  await send(buyer,'POST',`/orders/${order.id}/checkout`,{});
  const sessionId=[...sessions.keys()].pop()!;
  assert.equal((await webhook(completed(order.id,sessionId,100))).statusCode,200);
  assert.equal((await send(buyer,'GET',`/orders/${order.id}`)).json().status,'pending_payment');
  const audit=(await db.query("SELECT details FROM caldock_audit WHERE object_id=$1 AND action='payment.rejected'",[order.id])).rows[0];
  assert.equal(audit.details.code,'PAYMENT_AMOUNT_MISMATCH');
  assert.equal((await send(buyer,'PATCH',`/orders/${order.id}`,{action:'cancel_pending',expectedVersion:order.version})).statusCode,200);
  assert.equal(sessions.get(sessionId)!.status,'expired');
});

test('the storefront domain gets its own sign-in and payment return addresses; the shared host is unchanged',async()=>{
  const site=await buildApp({db,environment:'production',closeDatabase:false,caldock:{publicUrl:origin,siteUrl:'https://wodemac.example',providers:gateways,stripe}});
  try{
    const host={host:'wodemac.example'},cap=(await site.inject({url:'/caldock/capabilities',headers:host})).json();
    assert.equal(cap.accountApp,'https://wodemac.example/');
    assert.equal((await site.inject('/caldock/capabilities')).json().accountApp,origin+'/caldock/');
    assert.equal((await site.inject({url:'/caldock/capabilities',headers:{host:'evil.example'}})).json().accountApp,origin+'/caldock/');
    const start=await site.inject({url:'/caldock/auth/google/start?next=account&lang=zh&interval=year',headers:host});
    const state=new URL(start.headers.location!).searchParams.get('state')!,flow=cookieList(start).map(c=>c.split(';')[0]).join('; ');
    const back=await site.inject({url:`/caldock/auth/google/callback?state=${state}&code=stripe-site`,headers:{...host,cookie:flow}});
    assert.match(String(back.headers.location),/^https:\/\/wodemac\.example\/\?view=account/);
    const cookie=cookieList(back).find(c=>c.startsWith('__Host-caldock_session='))!.split(';')[0];
    const csrf=(await site.inject({url:'/caldock/me',headers:{...host,cookie}})).json().csrfToken;
    const post=(from:string)=>site.inject({method:'POST',url:'/caldock/affiliate',payload:{},headers:{...host,cookie,origin:from,'x-csrf-token':csrf}});
    assert.equal((await post(origin)).statusCode,403);
    assert.equal((await post('https://wodemac.example')).statusCode,200);
  }finally{await site.close();}
});

test('after going live, an order left with a test session can still be paid or cancelled',async()=>{
  const buyer=await login('stripe-stale-pay'),canceller=await login('stripe-stale-cancel');
  const order=(await send(buyer,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();
  const other=(await send(canceller,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();
  await db.query("UPDATE caldock_orders SET stripe_checkout_session_id='cs_test_from_before_live' WHERE id=ANY($1)",[[order.id,other.id]]);
  stripe.mode='live';
  try{
    const before=calls.length;
    const paid=await send(buyer,'POST',`/orders/${order.id}/checkout`,{});
    assert.equal(paid.statusCode,200,paid.body);
    assert.ok(!calls.slice(before).some(c=>c.path.includes('cs_test_from_before_live')));
    assert.notEqual((await send(buyer,'GET',`/orders/${order.id}`)).json().stripe_checkout_session_id,'cs_test_from_before_live');
    const cancelled=await send(canceller,'PATCH',`/orders/${other.id}`,{action:'cancel_pending',expectedVersion:other.version});
    assert.equal(cancelled.statusCode,200,cancelled.body);
    assert.equal(cancelled.json().status,'cancelled');
  }finally{stripe.mode='test';}
  // In test mode the same session id is real and still has to be looked up.
  assert.equal((await send(buyer,'PATCH',`/orders/${order.id}`,{action:'cancel_pending',expectedVersion:order.version})).statusCode,200);
});

test('delivery moves the next charge, stopping renewal syncs Stripe, and a full refund ends the rental',async()=>{
  const owner=await login('stripe-owner'),buyer=await login('stripe-lifecycle');
  const order=(await send(buyer,'POST','/orders',{interval:'year',requestKey:randomUUID()})).json();
  await send(buyer,'POST',`/orders/${order.id}/checkout`,{});
  await webhook(completed(order.id,[...sessions.keys()].pop()!,166800));
  let row=(await send(buyer,'GET',`/orders/${order.id}`)).json();
  row=(await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'provisioning',expectedVersion:row.version})).json();
  const delivered=await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'active',expectedVersion:row.version});assert.equal(delivered.statusCode,200,delivered.body);
  const move=calls.filter(c=>c.path==='/v1/subscriptions/'+row.stripe_subscription_id&&c.params.has('trial_end')).pop()!;
  assert.equal(Number(move.params.get('trial_end')),Math.floor(new Date(delivered.json().billing_ends_at).getTime()/1000));
  assert.equal(move.params.get('proration_behavior'),'none');

  const renewal={id:'evt_'+randomUUID(),type:'invoice.paid',data:{object:{id:'in_1',billing_reason:'subscription_cycle',subscription:row.stripe_subscription_id,amount_paid:166800}}};
  const before=new Date(delivered.json().billing_ends_at).getTime();
  await webhook(renewal);await webhook(renewal); // same event twice extends once
  const extended=(await send(buyer,'GET',`/orders/${order.id}`)).json();
  assert.ok(new Date(extended.billing_ends_at).getTime()-before>360*86400000);
  assert.ok(new Date(extended.billing_ends_at).getTime()-before<370*86400000);

  const stop=await send(buyer,'PATCH',`/orders/${order.id}`,{action:'stop_renewal',expectedVersion:extended.version});assert.equal(stop.statusCode,200,stop.body);
  assert.equal(stop.json().renewal_enabled,false);
  assert.ok(calls.some(c=>c.path==='/v1/subscriptions/'+row.stripe_subscription_id&&c.params.get('cancel_at_period_end')==='true'));

  const refund={id:'evt_'+randomUUID(),type:'charge.refunded',data:{object:{id:'ch_1',refunded:true,amount:166800,currency:'usd',customer:row.stripe_customer_id}}};
  assert.equal((await webhook(refund)).statusCode,200);
  assert.equal((await send(buyer,'GET',`/orders/${order.id}`)).json().status,'refunded');
  assert.ok(calls.some(c=>c.method==='DELETE'&&c.path==='/v1/subscriptions/'+row.stripe_subscription_id));
});

test('without Stripe configuration checkout is unavailable and the webhook does not exist',async()=>{
  const plain=await buildApp({db,environment:'production',closeDatabase:false,caldock:{publicUrl:origin,providers:gateways}});
  try{
    assert.equal((await plain.inject('/caldock/capabilities')).json().payments,false);
    assert.equal((await plain.inject({method:'POST',url:'/caldock/stripe/webhook',payload:'{}',headers:{'content-type':'application/json'}})).statusCode,404);
  }finally{await plain.close();}
});
