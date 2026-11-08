import { createOrderWebhook, orderWebhookFromEnv } from '../src/caldock-notify.js';
import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,type Database} from '../src/db.js';
import {caldockOptionsFromEnv} from '../src/caldock.js';
import {type CaldockGateway,type CaldockProvider} from '../src/caldock-oidc.js';
import {createCaldockStripe,signStripePayload,stripeFromEnv,verifyStripeEvent,type StripeFetch} from '../src/caldock-stripe.js';

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

const offSaleOrder=async(who:Login,billing:'week',cents:number)=>{
  const order=(await send(who,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();
  return (await db.query('UPDATE caldock_orders SET interval=$2,amount_cents=$3 WHERE id=$1 RETURNING *',[order.id,billing,cents])).rows[0];
};
test('new orders can only be monthly, quarterly, half-yearly or yearly',async()=>{
  const buyer=await login('three-plans');
  assert.equal((await send(buyer,'POST','/orders',{interval:'week',requestKey:randomUUID()})).statusCode,400);
  assert.deepEqual(Object.keys((await send(buyer,'GET','/me')).statusCode===200?(await app.inject('/caldock/capabilities')).json().prices:{}),['month','quarter','half','year']);
});

test('checkout uses the server price, reuses one open page, and only a signed event marks the order paid',async()=>{
  const buyer=await login('stripe-buyer');
  const order=(await send(buyer,'POST','/orders',{interval:'quarter',requestKey:randomUUID()})).json();
  assert.equal(order.amount_cents,48165);
  const first=await send(buyer,'POST',`/orders/${order.id}/checkout`,{lang:'en'});assert.equal(first.statusCode,200,first.body);
  const created=calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').pop()!;
  assert.equal(created.params.get('mode'),'subscription');
  assert.equal(created.params.get('line_items[0][price_data][unit_amount]'),'48165');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval]'),'month');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval_count]'),'3');
  assert.equal(created.params.get('metadata[caldock_order_id]'),order.id);
  assert.equal(created.params.get('customer_email'),'stripe-buyer@example.test');
  assert.match(created.params.get('success_url')!,/^https:\/\/craftos\.example\.test\/caldock\/\?view=orders&lang=en&interval=quarter&checkout=success&order=[0-9a-f-]{36}$/);
  const again=await send(buyer,'POST',`/orders/${order.id}/checkout`,{lang:'en'});
  assert.equal(again.json().url,first.json().url);
  assert.equal(calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').length,1);
  const other=await login('stripe-other');
  assert.equal((await send(other,'POST',`/orders/${order.id}/checkout`,{})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:`/caldock/orders/${order.id}/checkout`,payload:{},headers:{cookie:buyer.cookie}})).statusCode,403);

  const sessionId=[...sessions.keys()].pop()!;
  assert.equal((await webhook(completed(order.id,sessionId,48165),{secret:'whsec_forgedSecret123456'})).statusCode,400);
  assert.equal((await webhook(completed(order.id,sessionId,48165),{timestamp:Math.floor(Date.now()/1000)-3600})).statusCode,400);
  assert.equal((await webhook({...completed(order.id,sessionId,48165),livemode:true})).statusCode,400);
  assert.equal((await send(buyer,'GET',`/orders/${order.id}`)).json().status,'pending_payment');

  const ok=await webhook(completed(order.id,sessionId,48165));assert.equal(ok.statusCode,200,ok.body);
  const paid=(await send(buyer,'GET',`/orders/${order.id}`)).json();
  assert.equal(paid.status,'paid');assert.equal(paid.stripe_subscription_id,'sub_'+order.id.slice(0,8));
  assert.equal((await webhook(completed(order.id,sessionId,48165))).statusCode,200); // duplicate delivery is harmless
  assert.equal((await db.query('SELECT count(*)::int AS n FROM caldock_payment_events WHERE order_id=$1',[order.id])).rows[0].n,1);
  assert.equal((await send(buyer,'POST',`/orders/${order.id}/checkout`,{})).statusCode,409);
});

// Weekly is off sale, but an order created before that can still be paid and renewed.
test('an existing weekly order charges 8900 every week and delivery covers 7 days',async()=>{
  const owner=await login('stripe-owner'),buyer=await login('stripe-weekly');
  const order=await offSaleOrder(buyer,'week',8900);
  await send(buyer,'POST',`/orders/${order.id}/checkout`,{});
  const created=calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').pop()!;
  assert.equal(created.params.get('line_items[0][price_data][unit_amount]'),'8900');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval]'),'week');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval_count]'),'1');
  const sessionId=[...sessions.keys()].pop()!;
  assert.equal((await webhook(completed(order.id,sessionId,8900))).statusCode,200);
  const paid=(await send(buyer,'GET',`/orders/${order.id}`)).json();assert.equal(paid.status,'paid');
  const preparing=(await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'provisioning',expectedVersion:paid.version,deliveryNote:'preparing'}));assert.equal(preparing.statusCode,200,preparing.body);
  const live=(await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'active',expectedVersion:preparing.json().version,deliveryNote:'ready'}));assert.equal(live.statusCode,200,live.body);
  const days=(new Date(live.json().billing_ends_at).getTime()-new Date(live.json().delivered_at).getTime())/86400000;
  assert.ok(Math.abs(days-7)<0.01,String(days));
});

test('a customer can buy several Macs, and buy again; stock counts each Mac',async()=>{
  const buyer=await login('many-macs');
  assert.equal((await send(buyer,'POST','/orders',{interval:'year',quantity:0,requestKey:randomUUID()})).statusCode,400);
  const order=(await send(buyer,'POST','/orders',{interval:'month',quantity:3,requestKey:randomUUID()})).json();
  assert.deepEqual([order.quantity,order.amount_cents,order.list_amount_cents],[3,50700,50700]);
  // One unpaid order at a time.
  assert.equal((await send(buyer,'POST','/orders',{interval:'month',requestKey:randomUUID()})).statusCode,409);
  await send(buyer,'POST',`/orders/${order.id}/checkout`,{});
  const created=calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').pop()!;
  assert.equal(created.params.get('line_items[0][quantity]'),'3');assert.equal(created.params.get('line_items[0][price_data][unit_amount]'),'16900');assert.equal(created.params.get('discounts[0][coupon]'),null);
  assert.equal((await webhook(completed(order.id,[...sessions.keys()].pop()!,50700,{subscription:'sub_many',customer:'cus_many'}))).statusCode,200);
  const second=await send(buyer,'POST','/orders',{interval:'quarter',requestKey:randomUUID()});assert.equal(second.statusCode,201,second.body);
  await send(buyer,'PATCH',`/orders/${second.json().id}`,{action:'cancel_pending',expectedVersion:second.json().version});
});

test('a yearly order of 5 or more gets 2.5% off the first charge only; 4 Macs or other plans do not',async()=>{
  const four=await login('bulk-four');
  assert.equal((await send(four,'POST','/orders',{interval:'year',quantity:4,requestKey:randomUUID()})).json().amount_cents,689520);
  const half=await login('bulk-half');
  assert.equal((await send(half,'POST','/orders',{interval:'half',quantity:5,requestKey:randomUUID()})).json().amount_cents,456300);
  const buyer=await login('bulk-five');
  const order=(await send(buyer,'POST','/orders',{interval:'year',quantity:5,requestKey:randomUUID()})).json();
  assert.deepEqual([order.list_amount_cents,order.amount_cents],[861900,840352]);
  assert.equal((await send(buyer,'POST',`/orders/${order.id}/checkout`,{})).statusCode,200);
  const created=calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').pop()!;
  assert.equal(created.params.get('line_items[0][price_data][unit_amount]'),'172380');assert.equal(created.params.get('line_items[0][quantity]'),'5');assert.equal(created.params.get('discounts[0][coupon]'),'caldock-bulk-21548');
  const coupon=calls.filter(c=>c.path==='/v1/coupons').pop()!.params;
  assert.equal(coupon.get('amount_off'),'21548');assert.equal(coupon.get('currency'),'usd');assert.equal(coupon.get('duration'),'once');
  assert.equal((await webhook(completed(order.id,[...sessions.keys()].pop()!,840352,{subscription:'sub_bulk',customer:'cus_bulk'}))).statusCode,200);
  assert.equal((await send(buyer,'GET',`/orders/${order.id}`)).json().status,'paid');
});

test('the half-yearly plan charges 91260 every 6 months',async()=>{
  const buyer=await login('stripe-half');
  const order=(await send(buyer,'POST','/orders',{interval:'half',requestKey:randomUUID()})).json();
  assert.equal(order.amount_cents,91260);
  await send(buyer,'POST',`/orders/${order.id}/checkout`,{});
  const created=calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').pop()!;
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval]'),'month');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval_count]'),'6');
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
    assert.deepEqual(await stock(),{total:100,rented:68,left:32});
    // Fill the launch stock to three left, so the sold-out path below stays short.
    const seed=await signIn('stock-seed'),seedId=(await stockApp.inject({url:'/caldock/me',headers:{cookie:seed.cookie}})).json().user.id;
    await db.query("INSERT INTO caldock_orders(id,customer_id,request_key,interval,amount_cents,commission_bps,commission_mode,status,paid_at) SELECT gen_random_uuid()::text,$1,gen_random_uuid()::text,'month',16900,0,'first_order','paid',now() FROM generate_series(1,29)",[seedId]);
    assert.deepEqual(await stock(),{total:100,rented:97,left:3});
    const buyer=await order(await signIn('stock-1')),id=buyer.json().id,event=completed(id,'cs_stock_1',16900);
    assert.deepEqual(await stock(),{total:100,rented:97,left:3}); // an unpaid order holds no Mac
    assert.equal((await pay(event)).statusCode,200);
    assert.deepEqual(await stock(),{total:100,rented:98,left:2});
    const tooMany=await stockApp.inject({method:'POST',url:'/caldock/orders',payload:{interval:'month',quantity:3,requestKey:randomUUID()},headers:{cookie:seed.cookie,origin,'x-csrf-token':seed.csrf}});
    assert.equal(tooMany.statusCode,409);assert.equal(tooMany.json().error.code,'CALDOCK_NOT_ENOUGH_STOCK');
    assert.deepEqual(sent.map(m=>m.to),['a@example.test','b@example.test']);
    assert.match(sent[0].subject,/新订单.*月付 1 台 \$169\.00/);assert.match(sent[0].text,/stock-1@example\.test/);assert.match(sent[0].text,/剩余 2 台/);
    assert.equal((await pay({...event,id:'evt_'+randomUUID()})).statusCode,200);assert.equal(sent.length,2); // a redelivered payment mails nobody
    failing=true;
    const second=(await order(await signIn('stock-2'))).json().id;
    assert.equal((await pay(completed(second,'cs_stock_2',16900))).statusCode,200); // mail down, payment still recorded
    assert.equal((await db.query('SELECT status FROM caldock_orders WHERE id=$1',[second])).rows[0].status,'paid');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM caldock_audit WHERE action='notify.order_mail_failed' AND object_id=$1",[second])).rows[0].n,1);
    failing=false;
    const third=(await order(await signIn('stock-3'))).json().id;
    await pay(completed(third,'cs_stock_3',16900));
    assert.deepEqual(await stock(),{total:100,rented:100,left:0});
    const late=await order(await signIn('stock-4'));
    assert.equal(late.statusCode,409);assert.equal(late.json().error.code,'CALDOCK_SOLD_OUT');
    await db.query('UPDATE caldock_settings SET stock_total=101 WHERE id=1'); // adding stock reopens sales
    assert.deepEqual(await stock(),{total:101,rented:100,left:1});
    await db.query('UPDATE caldock_settings SET stock_total=100 WHERE id=1');
    await db.query("UPDATE caldock_orders SET billing_ends_at=now()-interval '4 days' WHERE id=$1",[third]); // lapsed past the grace
    assert.equal((await stock()).left,1);
    await db.query("UPDATE caldock_orders SET status='refunded' WHERE id=$1",[second]);
    assert.equal((await stock()).left,2);
  }finally{await db.query("UPDATE caldock_orders SET paid_at='2026-01-01' WHERE paid_at IS NOT NULL");await stockApp.close();}
});

test('order mail uses its own settings and an admin can send a test',async()=>{
  assert.equal(caldockOptionsFromEnv({RESEND_API_KEY:'re_shared',EMAIL_FROM:'a@example.test'}).mailer,null);
  assert.equal(typeof caldockOptionsFromEnv({CALDOCK_RESEND_API_KEY:'re_own',CALDOCK_EMAIL_FROM:'a@example.test'}).mailer,'function');
  const sent:string[]=[];let failing=false;
  const shared=async()=>{throw new Error('the shared mailer must not be used');};
  const mailApp=await buildApp({db,environment:'production',closeDatabase:false,mailer:shared,caldock:{publicUrl:origin,providers:gateways,adminUserIds:[adminId],stripe,mailer:async m=>{if(failing)throw new Error('down');sent.push(m.to);},orderNotifyEmails:['a@example.test','b@example.test']}});
  const plainApp=await buildApp({db,environment:'production',closeDatabase:false,caldock:{publicUrl:origin,providers:gateways,adminUserIds:[adminId],stripe,mailer:null}});
  const signIn=async(target:typeof mailApp,code:string)=>{
    const start=await target.inject('/caldock/auth/google/start?next=account&lang=zh&interval=month');
    const state=new URL(start.headers.location!).searchParams.get('state')!,flow=cookieList(start).map(c=>c.split(';')[0]).join('; ');
    const back=await target.inject({url:`/caldock/auth/google/callback?state=${state}&code=${code}`,headers:{cookie:flow}});
    const cookie=cookieList(back).find(c=>c.startsWith('__Host-caldock_session='))!.split(';')[0];
    return {cookie,csrf:(await target.inject({url:'/caldock/me',headers:{cookie}})).json().csrfToken};
  };
  const test=(target:typeof mailApp,who:{cookie:string;csrf:string})=>target.inject({method:'POST',url:'/caldock/admin/order-mail-test',payload:{},headers:{cookie:who.cookie,origin,'x-csrf-token':who.csrf}});
  try{
    assert.equal((await test(mailApp,await signIn(mailApp,'mail-test-customer'))).statusCode,403);
    const owner=await signIn(mailApp,'stripe-owner');
    const ok=await test(mailApp,owner);assert.equal(ok.statusCode,200);assert.equal(ok.json().sent,2);assert.deepEqual(sent,['a@example.test','b@example.test']);
    failing=true;
    const down=await test(mailApp,owner);assert.equal(down.statusCode,502);assert.equal(down.json().error.code,'CALDOCK_ORDER_MAIL_FAILED');
    const off=await test(plainApp,await signIn(plainApp,'stripe-owner'));assert.equal(off.statusCode,503);assert.equal(off.json().error.code,'CALDOCK_ORDER_MAIL_UNCONFIGURED');
  }finally{await mailApp.close();await plainApp.close();}
});

test('a paid order pings the webhook once, without customer details, and a failed ping keeps the payment',async()=>{
  const pings:any[]=[];let failing=false;
  const hookApp=await buildApp({db,environment:'production',closeDatabase:false,mailer:null,caldock:{publicUrl:origin,providers:gateways,adminUserIds:[adminId],stripe,liveStock:true,orderWebhook:async p=>{if(failing)throw new Error('down');pings.push(p);}}});
  const plainApp=await buildApp({db,environment:'production',closeDatabase:false,mailer:null,caldock:{publicUrl:origin,providers:gateways,adminUserIds:[adminId],stripe}});
  const signIn=async(target:typeof hookApp,code:string)=>{
    const start=await target.inject('/caldock/auth/google/start?next=account&lang=zh&interval=month');
    const state=new URL(start.headers.location!).searchParams.get('state')!,flow=cookieList(start).map(c=>c.split(';')[0]).join('; ');
    const back=await target.inject({url:`/caldock/auth/google/callback?state=${state}&code=${code}`,headers:{cookie:flow}});
    const cookie=cookieList(back).find(c=>c.startsWith('__Host-caldock_session='))!.split(';')[0];
    return {cookie,csrf:(await target.inject({url:'/caldock/me',headers:{cookie}})).json().csrfToken};
  };
  const order=async(code:string)=>{const who=await signIn(hookApp,code);return (await hookApp.inject({method:'POST',url:'/caldock/orders',payload:{interval:'month',requestKey:randomUUID()},headers:{cookie:who.cookie,origin,'x-csrf-token':who.csrf}})).json().id as string;};
  const pay=(event:Record<string,unknown>)=>{const payload=JSON.stringify({livemode:false,...event});return hookApp.inject({method:'POST',url:'/caldock/stripe/webhook',payload,headers:{'content-type':'application/json','stripe-signature':signStripePayload(payload,webhookSecret)}});};
  const ping=(target:typeof hookApp,who:{cookie:string;csrf:string})=>target.inject({method:'POST',url:'/caldock/admin/order-webhook-test',payload:{},headers:{cookie:who.cookie,origin,'x-csrf-token':who.csrf}});
  try{
    const id=await order('hook-1'),event=completed(id,'cs_hook_1',16900);
    assert.equal((await pay(event)).statusCode,200);
    assert.equal(pings.length,1);assert.equal(pings[0].event,'caldock.order.paid');assert.equal(pings[0].orderRef,id.slice(0,8).toUpperCase());assert.equal(pings[0].amount,'$169.00');assert.equal(pings[0].plan,'月付');
    assert.doesNotMatch(JSON.stringify(pings[0]),/hook-1|@example/);
    assert.equal((await pay({...event,id:'evt_'+randomUUID()})).statusCode,200);assert.equal(pings.length,1); // a redelivered payment pings nobody
    failing=true;
    const second=await order('hook-2');
    assert.equal((await pay(completed(second,'cs_hook_2',16900))).statusCode,200);
    assert.equal((await db.query('SELECT status FROM caldock_orders WHERE id=$1',[second])).rows[0].status,'paid');
    assert.equal((await db.query("SELECT count(*)::int AS n FROM caldock_audit WHERE action='notify.order_webhook_failed' AND object_id=$1",[second])).rows[0].n,1);
    assert.equal((await ping(hookApp,await signIn(hookApp,'hook-customer'))).statusCode,403);
    const owner=await signIn(hookApp,'stripe-owner');
    const down=await ping(hookApp,owner);assert.equal(down.statusCode,502);assert.equal(down.json().error.code,'CALDOCK_ORDER_WEBHOOK_FAILED');
    failing=false;
    assert.equal((await ping(hookApp,owner)).statusCode,200);assert.equal(pings.at(-1).event,'caldock.order.test');assert.equal(pings.at(-1).test,true);
    const off=await ping(plainApp,await signIn(plainApp,'stripe-owner'));assert.equal(off.statusCode,503);assert.equal(off.json().error.code,'CALDOCK_ORDER_WEBHOOK_UNCONFIGURED');
  }finally{await db.query("UPDATE caldock_orders SET paid_at='2026-01-01' WHERE paid_at IS NOT NULL");await hookApp.close();await plainApp.close();}
});

test('the order webhook sends a bearer POST, retries once and rejects a bad URL',async()=>{
  const calls:any[]=[];let answers=[500,200];
  const send=createOrderWebhook('https://hooks.example.test/run','s3cret',(async(url:any,init:any)=>{calls.push({url:String(url),init});return new Response('',{status:answers.shift()??500});}) as typeof fetch);
  const payload={event:'caldock.order.test',test:true,orderRef:'TEST',plan:'x',quantity:1,amount:'$0.00',stockLeft:null,adminUrl:'https://wodemac.com/?view=admin'} as const;
  await send(payload);
  assert.equal(calls.length,2);assert.equal(calls[0].url,'https://hooks.example.test/run');assert.equal(calls[0].init.headers.Authorization,'Bearer s3cret');assert.equal(calls[0].init.redirect,'error');
  answers=[500,500];await assert.rejects(send(payload));
  assert.throws(()=>createOrderWebhook('http://hooks.example.test/run','s3cret'));
  assert.equal(orderWebhookFromEnv({CALDOCK_ORDER_WEBHOOK_URL:'http://bad.example.test',CALDOCK_ORDER_WEBHOOK_SECRET:'s'}),null);
  assert.equal(orderWebhookFromEnv({GROK_BOT_WEBHOOK_URL:'https://hooks.example.test',GROK_BOT_WEBHOOK_SECRET:'s'}),null);
  assert.equal(typeof orderWebhookFromEnv({CALDOCK_ORDER_WEBHOOK_URL:'https://hooks.example.test/run',CALDOCK_ORDER_WEBHOOK_SECRET:'s'}),'function');
});

test('only the seller earns: the plan rate once on the first order, nothing on renewals or to whoever referred the seller',async()=>{
  const base=await db.query('SELECT commission_mode FROM caldock_settings WHERE id=1');
  await db.query("UPDATE caldock_settings SET commission_mode='first_order' WHERE id=1");
  try{
    const upline=await login('one-tier-upline'),seller=await login('one-tier-seller'),customer=await login('one-tier-customer');
    await send(upline,'POST','/affiliate',{});
    await db.query('INSERT INTO caldock_referrals(customer_id,affiliate_id) VALUES($1,$2)',[seller.user.id,upline.user.id]);
    await send(seller,'POST','/affiliate',{});
    assert.equal((await db.query('SELECT parent_id FROM caldock_affiliates WHERE user_id=$1',[seller.user.id])).rows[0].parent_id,null);
    await db.query('INSERT INTO caldock_referrals(customer_id,affiliate_id) VALUES($1,$2)',[customer.user.id,seller.user.id]);
    const order=(await send(customer,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();
    await send(customer,'POST',`/orders/${order.id}/checkout`,{});
    assert.equal((await webhook(completed(order.id,[...sessions.keys()].pop()!,16900,{subscription:'sub_one_tier',customer:'cus_one_tier'}))).statusCode,200);
    const rows=async()=>(await db.query('SELECT affiliate_id,amount_cents,rate_bps,tier,status FROM caldock_commissions WHERE order_id=$1',[order.id])).rows;
    assert.deepEqual((await rows()).map(r=>[r.affiliate_id,r.amount_cents,r.rate_bps,r.tier]),[[seller.user.id,845,500,1]]);
    assert.equal((await webhook({id:'evt_'+randomUUID(),type:'invoice.paid',data:{object:{id:'in_one_tier',billing_reason:'subscription_cycle',subscription:'sub_one_tier',amount_paid:16900}}})).statusCode,200);
    assert.equal((await rows()).length,1);
    const view=(await send(seller,'GET','/affiliate')).json();assert.equal(view.team,undefined);assert.equal(view.stats.pendingCents,845);
    assert.equal((await webhook({id:'evt_'+randomUUID(),type:'charge.refunded',data:{object:{id:'ch_one_tier',refunded:true,customer:'cus_one_tier',amount:16900,currency:'usd'}}})).statusCode,200);
    assert.deepEqual((await rows()).map(r=>r.status),['void']);
  }finally{await db.query('UPDATE caldock_settings SET commission_mode=$1 WHERE id=1',[base.rows[0].commission_mode]);}
});

test('orders from before the new rules keep both tiers and a year of renewal commission',async()=>{
  const seller=await login('legacy-seller'),upline=await login('legacy-upline'),customer=await login('legacy-customer');
  await send(upline,'POST','/affiliate',{});await send(seller,'POST','/affiliate',{});
  await db.query('INSERT INTO caldock_referrals(customer_id,affiliate_id) VALUES($1,$2)',[customer.user.id,seller.user.id]);
  const order=(await send(customer,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();
  await db.query('UPDATE caldock_orders SET commission_bps=2000,second_tier_bps=500,second_affiliate_id=$2,first_order_only=false WHERE id=$1',[order.id,upline.user.id]);
  await send(customer,'POST',`/orders/${order.id}/checkout`,{});
  assert.equal((await webhook(completed(order.id,[...sessions.keys()].pop()!,16900,{subscription:'sub_legacy',customer:'cus_legacy'}))).statusCode,200);
  const rows=async()=>(await db.query('SELECT amount_cents,rate_bps,tier FROM caldock_commissions WHERE order_id=$1 ORDER BY created_at,tier',[order.id])).rows.map(r=>[r.amount_cents,r.rate_bps,r.tier]);
  const renew=(invoice:string)=>webhook({id:'evt_'+randomUUID(),type:'invoice.paid',data:{object:{id:invoice,billing_reason:'subscription_cycle',subscription:'sub_legacy',amount_paid:16900}}});
  assert.deepEqual(await rows(),[[3380,2000,1],[845,500,2]]);
  assert.equal((await renew('in_legacy_1')).statusCode,200);assert.equal((await renew('in_legacy_1')).statusCode,200);
  assert.deepEqual(await rows(),[[3380,2000,1],[845,500,2],[3380,2000,1],[845,500,2]]);
  await db.query("UPDATE caldock_orders SET paid_at=now()-interval '12 months' WHERE id=$1",[order.id]);
  assert.equal((await renew('in_legacy_2')).statusCode,200);assert.equal((await rows()).length,4);
});

test('an unpaid order with no open payment page is charged the current price with no discount',async()=>{
  const customer=await login('stale-discount');
  const order=(await send(customer,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();
  await db.query("UPDATE caldock_orders SET amount_cents=15920,list_amount_cents=19900,offer_day='2026-11-03' WHERE id=$1",[order.id]);
  assert.equal((await send(customer,'POST',`/orders/${order.id}/checkout`,{})).statusCode,200);
  const params=calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').pop()!.params;
  assert.equal(params.get('line_items[0][price_data][unit_amount]'),'16900');assert.equal(params.get('discounts[0][coupon]'),null);
  const row=(await db.query('SELECT amount_cents,list_amount_cents,offer_day FROM caldock_orders WHERE id=$1',[order.id])).rows[0];
  assert.deepEqual([row.amount_cents,row.list_amount_cents,row.offer_day],[16900,16900,null]);
});

test('each plan earns its own rate: yearly 15%, half-yearly 10%, quarterly 7.5%, monthly 5%',async()=>{
  const seller=await login('rates-seller');await send(seller,'POST','/affiliate',{});
  for(const [billing,cents,bps,earned] of [['year',172380,1500,25857],['half',91260,1000,9126],['quarter',48165,750,3612],['month',16900,500,845]] as const){
    const customer=await login('rates-'+billing);
    await db.query('INSERT INTO caldock_referrals(customer_id,affiliate_id) VALUES($1,$2)',[customer.user.id,seller.user.id]);
    const order=(await send(customer,'POST','/orders',{interval:billing,requestKey:randomUUID()})).json();
    assert.deepEqual([order.amount_cents,order.commission_bps],[cents,bps]);
    await send(customer,'POST',`/orders/${order.id}/checkout`,{});
    assert.equal((await webhook(completed(order.id,[...sessions.keys()].pop()!,cents,{subscription:'sub_rates_'+billing,customer:'cus_rates_'+billing}))).statusCode,200);
    const row=(await db.query('SELECT amount_cents,rate_bps FROM caldock_commissions WHERE order_id=$1',[order.id])).rows;
    assert.deepEqual(row.map(x=>[x.amount_cents,x.rate_bps]),[[earned,bps]]);
  }
});

test('stock has its own admin page: only admins change it, a bad pair is refused, and rules saves leave it alone',async()=>{
  const owner=await login('stripe-owner');
  const before=(await send(owner,'GET','/admin/stock')).json();assert.equal(before.total,100);assert.equal(before.rentedBefore,68);
  assert.equal((await send(await login('not-admin-stock'),'GET','/admin/stock')).statusCode,403);
  assert.equal((await send(await login('not-admin-stock'),'PATCH','/admin/stock',{total:1,rentedBefore:0,expectedVersion:before.version})).statusCode,403);
  assert.equal((await send(owner,'PATCH','/admin/stock',{total:10,rentedBefore:11,expectedVersion:before.version})).statusCode,400);
  assert.equal((await send(owner,'PATCH','/admin/stock',{total:150,rentedBefore:70,expectedVersion:before.version+5})).statusCode,409);
  const saved=await send(owner,'PATCH','/admin/stock',{total:150,rentedBefore:70,expectedVersion:before.version});assert.equal(saved.statusCode,200,saved.body);
  assert.equal((await send(owner,'GET','/admin/stock')).json().total,150);
  assert.equal(saved.json().total,150);assert.equal(saved.json().rentedBefore,70);
  const rules=(await send(owner,'GET','/admin/settings')).json();
  assert.equal((await send(owner,'PATCH','/admin/settings',{monthCommissionBps:rules.month_commission_bps,quarterCommissionBps:rules.quarter_commission_bps,halfCommissionBps:rules.half_commission_bps,yearCommissionBps:rules.year_commission_bps,commissionMode:rules.commission_mode,stockTotal:1,expectedVersion:rules.version})).statusCode,400);
  await db.query('UPDATE caldock_settings SET stock_total=100,stock_rented_before=68 WHERE id=1');
});

test('the plan rates default once and never override a later admin choice',async()=>{
  const read=async()=>{const row=(await db.query('SELECT month_commission_bps,half_commission_bps,year_commission_bps FROM caldock_settings WHERE id=1')).rows[0];return [row.month_commission_bps,row.half_commission_bps,row.year_commission_bps];};
  assert.deepEqual(await read(),[500,1000,1500]);
  await db.query('UPDATE caldock_settings SET month_commission_bps=0 WHERE id=1');
  await db.exec(schema);
  assert.deepEqual(await read(),[0,1000,1500]);
  await db.query('UPDATE caldock_settings SET month_commission_bps=500 WHERE id=1');
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

test('renewals of a new order earn nothing, and an unreferred order earns nothing at all',async()=>{
  try{
    const partner=await login('renew-partner'),buyer=await login('renew-buyer'),plain=await login('renew-plain');
    await send(partner,'POST','/affiliate',{});
    await db.query('INSERT INTO caldock_referrals(customer_id,affiliate_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[buyer.user.id,partner.user.id]);
    const pay=async(who:Login,sub:string)=>{
      const order=(await send(who,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();
      await send(who,'POST',`/orders/${order.id}/checkout`,{});
      assert.equal((await webhook(completed(order.id,[...sessions.keys()].pop()!,16900,{subscription:sub,customer:'cus_'+sub}))).statusCode,200);
      return order;
    };
    const renew=(sub:string,invoice:string)=>webhook({id:'evt_'+randomUUID(),type:'invoice.paid',data:{object:{id:invoice,billing_reason:'subscription_cycle',subscription:sub,amount_paid:16900}}});
    const rows=async(id:string)=>(await db.query('SELECT amount_cents,rate_bps FROM caldock_commissions WHERE order_id=$1',[id])).rows;
    const referred=await pay(buyer,'sub_renew_ref');
    assert.equal((await rows(referred.id)).length,1);
    assert.equal((await renew('sub_renew_ref','in_renew_1')).statusCode,200);
    assert.equal((await rows(referred.id)).length,1);
    const own=await pay(plain,'sub_renew_plain');await renew('sub_renew_plain','in_plain_1');assert.equal((await rows(own.id)).length,0);
  }finally{}
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

test('a new order is billed from payment: delivery changes neither the period end nor the next charge',async()=>{
  const owner=await login('stripe-owner'),buyer=await login('stripe-from-payment');
  const order=(await send(buyer,'POST','/orders',{interval:'year',requestKey:randomUUID()})).json();
  await send(buyer,'POST',`/orders/${order.id}/checkout`,{});
  await webhook(completed(order.id,[...sessions.keys()].pop()!,172380,{subscription:'sub_from_payment',customer:'cus_from_payment'}));
  await db.query("UPDATE caldock_orders SET paid_at=now()-interval '2 days' WHERE id=$1",[order.id]);
  let row=(await send(buyer,'GET',`/orders/${order.id}`)).json();
  row=(await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'provisioning',expectedVersion:row.version})).json();
  assert.equal((await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'active',expectedVersion:row.version})).statusCode,200);
  assert.equal((await db.query("SELECT billing_ends_at=paid_at+interval '1 year' AS correct FROM caldock_orders WHERE id=$1",[order.id])).rows[0].correct,true);
  assert.equal(calls.some(c=>c.path==='/v1/subscriptions/sub_from_payment'&&c.params.has('trial_end')),false);
});

test('an older order is billed from delivery: delivery moves the next charge, stopping renewal syncs Stripe, and a full refund ends the rental',async()=>{
  const owner=await login('stripe-owner'),buyer=await login('stripe-lifecycle');
  const order=(await send(buyer,'POST','/orders',{interval:'year',requestKey:randomUUID()})).json();
  await db.query('UPDATE caldock_orders SET billed_from_payment=false WHERE id=$1',[order.id]);
  await send(buyer,'POST',`/orders/${order.id}/checkout`,{});
  await webhook(completed(order.id,[...sessions.keys()].pop()!,172380));
  let row=(await send(buyer,'GET',`/orders/${order.id}`)).json();
  row=(await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'provisioning',expectedVersion:row.version})).json();
  const delivered=await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'active',expectedVersion:row.version});assert.equal(delivered.statusCode,200,delivered.body);
  const move=calls.filter(c=>c.path==='/v1/subscriptions/'+row.stripe_subscription_id&&c.params.has('trial_end')).pop()!;
  assert.equal(Number(move.params.get('trial_end')),Math.floor(new Date(delivered.json().billing_ends_at).getTime()/1000));
  assert.equal(move.params.get('proration_behavior'),'none');

  const renewal={id:'evt_'+randomUUID(),type:'invoice.paid',data:{object:{id:'in_1',billing_reason:'subscription_cycle',subscription:row.stripe_subscription_id,amount_paid:172380}}};
  const before=new Date(delivered.json().billing_ends_at).getTime();
  await webhook(renewal);await webhook(renewal); // same event twice extends once
  const extended=(await send(buyer,'GET',`/orders/${order.id}`)).json();
  assert.ok(new Date(extended.billing_ends_at).getTime()-before>360*86400000);
  assert.ok(new Date(extended.billing_ends_at).getTime()-before<370*86400000);

  const stop=await send(buyer,'PATCH',`/orders/${order.id}`,{action:'stop_renewal',expectedVersion:extended.version});assert.equal(stop.statusCode,200,stop.body);
  assert.equal(stop.json().renewal_enabled,false);
  assert.ok(calls.some(c=>c.path==='/v1/subscriptions/'+row.stripe_subscription_id&&c.params.get('cancel_at_period_end')==='true'));

  const refund={id:'evt_'+randomUUID(),type:'charge.refunded',data:{object:{id:'ch_1',refunded:true,amount:172380,currency:'usd',customer:row.stripe_customer_id}}};
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

test('after a switch, the previous Stripe account still verifies its webhooks and manages its own subscriptions',async()=>{
  const env={CALDOCK_STRIPE_SECRET_KEY:'sk_test_newAccount1234567890',CALDOCK_STRIPE_WEBHOOK_SECRET:'whsec_newAccount1234567890'};
  assert.equal(stripeFromEnv(env)!.previous,undefined);
  assert.throws(()=>stripeFromEnv({...env,CALDOCK_STRIPE_PREVIOUS_SECRET_KEY:'sk_test_oldAccount1234567890'}),/both/);
  assert.throws(()=>stripeFromEnv({...env,CALDOCK_STRIPE_PREVIOUS_SECRET_KEY:'sk_live_oldAccount1234567890',CALDOCK_STRIPE_PREVIOUS_WEBHOOK_SECRET:'whsec_oldAccount1234567890',CALDOCK_STRIPE_ALLOW_LIVE:'true'}),/same mode/);
  assert.throws(()=>stripeFromEnv({...env,CALDOCK_STRIPE_PREVIOUS_SECRET_KEY:env.CALDOCK_STRIPE_SECRET_KEY,CALDOCK_STRIPE_PREVIOUS_WEBHOOK_SECRET:'whsec_oldAccount1234567890'}),/differ/);
  assert.equal(stripeFromEnv({...env,CALDOCK_STRIPE_PREVIOUS_SECRET_KEY:'sk_test_oldAccount1234567890',CALDOCK_STRIPE_PREVIOUS_WEBHOOK_SECRET:'whsec_oldAccount1234567890'})!.previous!.mode,'test');

  const oldSecret='whsec_oldAccount1234567890',newSecret='whsec_newAccount1234567890';
  const newCalls:string[]=[],oldCalls:{method:string;path:string;body:string}[]=[];
  const missing={ok:false,status:404,json:async()=>({error:{code:'resource_missing'}})};
  const newFetch:StripeFetch=async(url,init)=>{const u=new URL(url);newCalls.push(init.method+' '+u.pathname);
    if(init.method==='POST'&&u.pathname==='/v1/checkout/sessions')return {ok:true,status:200,json:async()=>({id:'cs_test_new_1',url:'https://checkout.stripe.test/new',status:'open'})};
    return missing;};
  const oldFetch:StripeFetch=async(url,init)=>{const u=new URL(url);oldCalls.push({method:init.method,path:u.pathname,body:init.body||''});
    assert.equal(init.headers.authorization,'Bearer sk_test_oldAccount1234567890');
    if(u.pathname.startsWith('/v1/subscriptions/'))return {ok:true,status:200,json:async()=>({id:u.pathname.split('/').pop()})};
    return missing;};
  const previous=createCaldockStripe({secretKey:'sk_test_oldAccount1234567890',webhookSecret:oldSecret,fetch:oldFetch,apiBase:'https://api.stripe.test'});
  const current={...createCaldockStripe({secretKey:'sk_test_newAccount1234567890',webhookSecret:newSecret,fetch:newFetch,apiBase:'https://api.stripe.test'}),previous};
  const dual=await buildApp({db,environment:'production',closeDatabase:false,mailer:null,caldock:{publicUrl:origin,providers:gateways,adminUserIds:[adminId],stripe:current}});
  try{
    const start=await dual.inject('/caldock/auth/google/start?next=account&lang=zh&interval=month');
    const state=new URL(start.headers.location!).searchParams.get('state')!,flow=cookieList(start).map(c=>c.split(';')[0]).join('; ');
    const back=await dual.inject({url:`/caldock/auth/google/callback?state=${state}&code=dual-account`,headers:{cookie:flow}});
    const cookie=cookieList(back).find(c=>c.startsWith('__Host-caldock_session='))!.split(';')[0];
    const csrf=(await dual.inject({url:'/caldock/me',headers:{cookie}})).json().csrfToken,headers={cookie,origin,'x-csrf-token':csrf};
    const hook=(event:Record<string,unknown>,secret:string)=>{const payload=JSON.stringify({livemode:false,...event});return dual.inject({method:'POST',url:'/caldock/stripe/webhook',payload,headers:{'content-type':'application/json','stripe-signature':signStripePayload(payload,secret)}});};
    // An order paid on the previous account: its webhook still verifies, and an unknown signer does not.
    const placed=await dual.inject({method:'POST',url:'/caldock/orders',payload:{interval:'month',requestKey:randomUUID()},headers});
    assert.equal(placed.statusCode,201,placed.body);const legacy=placed.json().id as string;
    const paid=completed(legacy,'cs_old_1',16900);
    assert.equal((await hook(paid,'whsec_strangerSecret123456')).statusCode,400);
    assert.equal((await hook(paid,oldSecret)).statusCode,200);
    const row=(await db.query('SELECT status,version,stripe_subscription_id FROM caldock_orders WHERE id=$1',[legacy])).rows[0];
    assert.equal(row.status,'paid');
    // New payment pages always open on the current account.
    const made=await dual.inject({method:'POST',url:'/caldock/orders',payload:{interval:'month',requestKey:randomUUID()},headers});
    assert.equal(made.statusCode,201,made.body);const fresh=made.json().id as string;
    assert.equal((await dual.inject({method:'POST',url:`/caldock/orders/${fresh}/checkout`,payload:{lang:'zh'},headers})).json().url,'https://checkout.stripe.test/new');
    assert(newCalls.includes('POST /v1/checkout/sessions'));assert(!oldCalls.some(c=>c.path==='/v1/checkout/sessions'));
    // Stopping renewal: the current account does not know this subscription, so the previous one is asked.
    const stop=await dual.inject({method:'PATCH',url:`/caldock/orders/${legacy}`,payload:{action:'stop_renewal',expectedVersion:row.version},headers});
    assert.equal(stop.statusCode,200);assert.equal(stop.json().renewal_enabled,false);
    assert(newCalls.includes('POST /v1/subscriptions/'+row.stripe_subscription_id));
    const asked=oldCalls.find(c=>c.path==='/v1/subscriptions/'+row.stripe_subscription_id);assert(asked);assert.match(asked.body,/cancel_at_period_end=true/);
    // A full refund made on the previous account cancels the subscription there.
    await db.query("UPDATE caldock_orders SET status='paid' WHERE id=$1",[legacy]);
    const customer=(await db.query('SELECT stripe_customer_id FROM caldock_orders WHERE id=$1',[legacy])).rows[0].stripe_customer_id;
    assert.equal((await hook({id:'evt_'+randomUUID(),type:'charge.refunded',data:{object:{id:'ch_old_1',object:'charge',refunded:true,customer,amount:16900,currency:'usd'}}},oldSecret)).statusCode,200);
    assert(oldCalls.some(c=>c.method==='DELETE'&&c.path==='/v1/subscriptions/'+row.stripe_subscription_id));
    assert.equal((await db.query("SELECT count(*)::int AS n FROM caldock_audit WHERE action='payment.cancel_failed' AND object_id=$1",[legacy])).rows[0].n,0);
    // Renewals billed on the previous account keep arriving.
    assert.equal((await hook({id:'evt_'+randomUUID(),type:'customer.subscription.deleted',data:{object:{id:row.stripe_subscription_id,object:'subscription',metadata:{caldock_order_id:legacy}}}},oldSecret)).statusCode,200);
    assert.equal((await hook(completed(fresh,'cs_test_new_1',16900),newSecret)).statusCode,200);
  }finally{await db.query("UPDATE caldock_orders SET paid_at='2026-01-01' WHERE paid_at IS NOT NULL");await dual.close();}
});
