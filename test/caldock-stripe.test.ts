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
  assert.equal(order.amount_cents,50700);
  const first=await send(buyer,'POST',`/orders/${order.id}/checkout`,{lang:'en'});assert.equal(first.statusCode,200,first.body);
  const created=calls.find(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions')!;
  assert.equal(created.params.get('mode'),'subscription');
  assert.equal(created.params.get('line_items[0][price_data][unit_amount]'),'50700');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval]'),'month');
  assert.equal(created.params.get('line_items[0][price_data][recurring][interval_count]'),'3');
  assert.equal(created.params.get('metadata[caldock_order_id]'),order.id);
  assert.equal(created.params.get('customer_email'),'stripe-buyer@example.test');
  assert.match(created.params.get('success_url')!,/^https:\/\/craftos\.example\.test\/macusa\/\?view=orders&lang=en&interval=quarter&checkout=success$/);
  const again=await send(buyer,'POST',`/orders/${order.id}/checkout`,{lang:'en'});
  assert.equal(again.json().url,first.json().url);
  assert.equal(calls.filter(c=>c.method==='POST'&&c.path==='/v1/checkout/sessions').length,1);
  const other=await login('stripe-other');
  assert.equal((await send(other,'POST',`/orders/${order.id}/checkout`,{})).statusCode,404);
  assert.equal((await app.inject({method:'POST',url:`/caldock/orders/${order.id}/checkout`,payload:{},headers:{cookie:buyer.cookie}})).statusCode,403);

  const sessionId=[...sessions.keys()].pop()!;
  assert.equal((await webhook(completed(order.id,sessionId,50700),{secret:'whsec_forgedSecret123456'})).statusCode,400);
  assert.equal((await webhook(completed(order.id,sessionId,50700),{timestamp:Math.floor(Date.now()/1000)-3600})).statusCode,400);
  assert.equal((await webhook({...completed(order.id,sessionId,50700),livemode:true})).statusCode,400);
  assert.equal((await send(buyer,'GET',`/orders/${order.id}`)).json().status,'pending_payment');

  const ok=await webhook(completed(order.id,sessionId,50700));assert.equal(ok.statusCode,200,ok.body);
  const paid=(await send(buyer,'GET',`/orders/${order.id}`)).json();
  assert.equal(paid.status,'paid');assert.equal(paid.stripe_subscription_id,'sub_'+order.id.slice(0,8));
  assert.equal((await webhook(completed(order.id,sessionId,50700))).statusCode,200); // duplicate delivery is harmless
  assert.equal((await db.query('SELECT count(*)::int AS n FROM caldock_payment_events WHERE order_id=$1',[order.id])).rows[0].n,1);
  assert.equal((await send(buyer,'POST',`/orders/${order.id}/checkout`,{})).statusCode,409);
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
  await webhook(completed(order.id,[...sessions.keys()].pop()!,154800));
  let row=(await send(buyer,'GET',`/orders/${order.id}`)).json();
  row=(await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'provisioning',expectedVersion:row.version})).json();
  const delivered=await send(owner,'PATCH',`/admin/orders/${order.id}`,{status:'active',expectedVersion:row.version});assert.equal(delivered.statusCode,200,delivered.body);
  const move=calls.filter(c=>c.path==='/v1/subscriptions/'+row.stripe_subscription_id&&c.params.has('trial_end')).pop()!;
  assert.equal(Number(move.params.get('trial_end')),Math.floor(new Date(delivered.json().billing_ends_at).getTime()/1000));
  assert.equal(move.params.get('proration_behavior'),'none');

  const renewal={id:'evt_'+randomUUID(),type:'invoice.paid',data:{object:{id:'in_1',billing_reason:'subscription_cycle',subscription:row.stripe_subscription_id,amount_paid:154800}}};
  const before=new Date(delivered.json().billing_ends_at).getTime();
  await webhook(renewal);await webhook(renewal); // same event twice extends once
  const extended=(await send(buyer,'GET',`/orders/${order.id}`)).json();
  assert.ok(new Date(extended.billing_ends_at).getTime()-before>360*86400000);
  assert.ok(new Date(extended.billing_ends_at).getTime()-before<370*86400000);

  const stop=await send(buyer,'PATCH',`/orders/${order.id}`,{action:'stop_renewal',expectedVersion:extended.version});assert.equal(stop.statusCode,200,stop.body);
  assert.equal(stop.json().renewal_enabled,false);
  assert.ok(calls.some(c=>c.path==='/v1/subscriptions/'+row.stripe_subscription_id&&c.params.get('cancel_at_period_end')==='true'));

  const refund={id:'evt_'+randomUUID(),type:'charge.refunded',data:{object:{id:'ch_1',refunded:true,amount:154800,currency:'usd',customer:row.stripe_customer_id}}};
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
