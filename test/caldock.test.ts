import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {buildApp} from '../src/app.js';
import {createDatabase,schema,type Database} from '../src/db.js';
import {issueSession} from '../src/auth.js';
import {verifyCaldockIdentity,type CaldockGateway,type CaldockProvider} from '../src/caldock-oidc.js';
import {caldockOptionsFromEnv} from '../src/caldock.js';
import {recordVerifiedCaldockPayment} from '../src/caldock-domain.js';
import {caldockSchema} from '../src/caldock-schema.js';

let db:Database,dbAdmin:Database|undefined,isolated:string|undefined,app:Awaited<ReturnType<typeof buildApp>>;
const origin='https://craftos.example.test',adminId=randomUUID();
type Login={cookie:string;csrf:string;user:any;isAdmin:boolean};
let owner:Login,buyer:Login,other:Login,affiliate:Login,order:any,commission:any;
let authenticates=0;
const gateways=Object.fromEntries((['google','apple'] as const).map(provider=>[provider,{
 authorizationUrl({state}:{state:string}){return `https://provider.example/${provider}?state=${state}`;},
 async authenticate({code}:{code:string}){authenticates++;if(code==='invalid')throw new Error('Provider secret must not leak');return {provider,subject:code,email:code==='shared'?'same@example.test':code+'@example.test',name:code};}
}])) as Record<CaldockProvider,CaldockGateway>;
before(async()=>{
 if(process.env.TEST_DATABASE_URL){dbAdmin=await createDatabase({connectionString:process.env.TEST_DATABASE_URL});isolated='caldock_'+randomUUID().replaceAll('-','');await dbAdmin.exec(`CREATE SCHEMA ${isolated}`);const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options','-c search_path='+isolated);db=await createDatabase({connectionString:url.toString()});}else db=await createDatabase();
 await db.exec(schema);
 await db.query('INSERT INTO caldock_users(id,display_name,email) VALUES($1,$2,$3)',[adminId,'Approved owner','owner@example.test']);
 await db.query('INSERT INTO caldock_identities(provider,subject,user_id) VALUES($1,$2,$3)',['google','approved-owner',adminId]);
 app=await buildApp({db,environment:'production',caldock:{publicUrl:origin,providers:gateways,adminUserIds:[adminId]}});
});
after(async()=>{if(app)await app.close();else if(db)await db.close();if(dbAdmin&&isolated){await dbAdmin.exec(`DROP SCHEMA ${isolated} CASCADE`);await dbAdmin.close();}});
const send=(who:Login,method:'GET'|'POST'|'PATCH'|'DELETE',url:string,payload?:Record<string,unknown>,headers:Record<string,string>={})=>app.inject({method,url:'/caldock'+url,payload,headers:{cookie:who.cookie,origin,'x-csrf-token':who.csrf,...headers}});
function cookies(response:any){return [response.headers['set-cookie']].flat().filter(Boolean).map(String);}
async function login(code:string,provider:CaldockProvider='google',ref?:string,billing:'week'|'month'|'quarter'|'half'|'year'='year'):Promise<Login>{
 const start=await app.inject(`/caldock/auth/${provider}/start?next=account&lang=zh&interval=${billing}${ref?'&ref='+ref:''}`);assert.equal(start.statusCode,302,start.body);
 const state=new URL(start.headers.location!).searchParams.get('state')!;
 const cookie=cookies(start).map(c=>c.split(';')[0]).join('; ');
 const callback=await app.inject({method:provider==='apple'?'POST':'GET',url:`/caldock/auth/${provider}/callback${provider==='google'?'?state='+state+'&code='+code:''}`,payload:provider==='apple'?new URLSearchParams({state,code}).toString():undefined,headers:{cookie,...(provider==='apple'?{'content-type':'application/x-www-form-urlencoded'}:{})}});
 assert.equal(callback.statusCode,302,callback.body);assert.equal(new URL(String(callback.headers.location)).searchParams.get('interval'),billing);assert.match(String(callback.headers.location),/^https:\/\/craftos\.example\.test\/caldock\/\?/);assert.doesNotMatch(String(callback.headers.location),/access_token|csrf|secret/);
 const session=cookies(callback).find(c=>c.startsWith('__Host-caldock_session='));assert.ok(session);assert.match(session,/HttpOnly; SameSite=Lax/);assert.match(session,/; Secure/);
 const me=await app.inject({url:'/caldock/me',headers:{cookie:session.split(';')[0]}});assert.equal(me.statusCode,200,me.body);
 return {cookie:session.split(';')[0],csrf:me.json().csrfToken,...me.json()};
}
test('capabilities report server prices and no live payment; missing providers fail closed',async()=>{
 const cap=(await app.inject('/caldock/capabilities')).json();assert.equal(cap.prices.month,16900);assert.equal(cap.prices.half,91260);assert.equal(cap.prices.quarter,48165);assert.equal(cap.prices.week,undefined);assert.equal(cap.prices.year,172380);assert.equal(cap.payments,false);assert.equal(cap.referrals.automaticPayouts,false);
 const empty=await buildApp({db,environment:'production',closeDatabase:false,caldock:{publicUrl:origin}});
 try{assert.equal((await empty.inject('/caldock/auth/google/start')).statusCode,503);assert.equal((await empty.inject('/caldock/me')).statusCode,401);assert.equal((await empty.inject('/caldock/admin/orders')).statusCode,401);}finally{await empty.close();}
 const config=caldockOptionsFromEnv({NODE_ENV:'production',CALDOCK_GOOGLE_CLIENT_ID:'incomplete'});assert.equal(config.providers?.google,undefined);assert.deepEqual(config.adminUserIds,[]);
});
test('OAuth browser binding, single-use state, method and controlled return target',async()=>{
 const start=await app.inject('/caldock/auth/google/start?next=affiliate&lang=en&interval=month');const state=new URL(start.headers.location!).searchParams.get('state')!,cookie=cookies(start)[0].split(';')[0];
 const calls=authenticates;
 const wrong=await app.inject({url:`/caldock/auth/google/callback?state=${state}&code=bound`,headers:{cookie:'__Host-caldock_oauth_google='+randomBytes(32).toString('base64url')}});assert.equal(wrong.statusCode,400);assert.equal(authenticates,calls);
 const result=await app.inject({url:`/caldock/auth/google/callback?state=${state}&code=bound&scope=openid&authuser=0`,headers:{cookie}});assert.equal(result.statusCode,302);assert.equal(new URL(result.headers.location!).searchParams.get('view'),'affiliate');
 const replay=await app.inject({url:`/caldock/auth/google/callback?state=${state}&code=bound`,headers:{cookie}});assert.equal(replay.statusCode,400);
 assert.equal((await app.inject('/caldock/auth/google/start?next=https://evil.example')).statusCode,400);
 const apple=await app.inject('/caldock/auth/apple/start');assert.match(cookies(apple)[0],/SameSite=None/);assert.match(cookies(apple)[0],/Secure/);
 owner=await login('approved-owner');buyer=await login('buyer');other=await login('other');affiliate=await login('affiliate');assert.equal(owner.isAdmin,true);assert.equal(buyer.isAdmin,false);
});
test('Google and Apple subjects stay separate even with the same email',async()=>{
 const google=await login('shared','google'),apple=await login('shared','apple');assert.equal(google.user.email,apple.user.email);assert.notEqual(google.user.id,apple.user.id);
});
test('JWT verification rejects wrong issuer, audience, nonce, expiry and unverified email',async()=>{
 const {publicKey,privateKey}=await generateKeyPair('RS256');const jwk=await exportJWK(publicKey);jwk.kid='test';const keys=createLocalJWKSet({keys:[jwk]});
 const sign=(fields:Record<string,unknown>={})=>new SignJWT({nonce:'expected-nonce',email:'test@example.test',email_verified:true,...fields}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://accounts.google.com').setAudience('google-client').setSubject('stable-subject').setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const valid=await sign();assert.equal((await verifyCaldockIdentity(valid,'google','google-client','expected-nonce',keys)).subject,'stable-subject');
 await assert.rejects(verifyCaldockIdentity(valid,'google','wrong-client','expected-nonce',keys));
 await assert.rejects(verifyCaldockIdentity(valid,'google','google-client','wrong-nonce',keys));
 await assert.rejects(verifyCaldockIdentity(valid,'apple','google-client','expected-nonce',keys));
 await assert.rejects(verifyCaldockIdentity(await sign({email_verified:false}),'google','google-client','expected-nonce',keys));
 const expired=await new SignJWT({nonce:'expected-nonce'}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://accounts.google.com').setAudience('google-client').setSubject('s').setIssuedAt(1).setExpirationTime(2).sign(privateKey);
 await assert.rejects(verifyCaldockIdentity(expired,'google','google-client','expected-nonce',keys));
});
test('Work OS sessions and CalDock sessions never authorize the other product',async()=>{
 await db.query("INSERT INTO users(id,org_id,department_id,display_name,role) VALUES('caldock-test-workos','test','test','Employee','manager')");const workos=await issueSession(db,'caldock-test-workos');
 assert.equal((await app.inject({url:'/caldock/me',headers:{cookie:'__Host-workos_session='+workos.accessToken}})).statusCode,401);
 assert.equal((await app.inject({url:'/caldock/me',headers:{authorization:'Bearer '+workos.accessToken}})).statusCode,401);
 assert.equal((await app.inject({url:'/me',headers:{cookie:buyer.cookie}})).statusCode,401);
});
test('writes require exact Origin and CSRF; profile cannot assign admin or email',async()=>{
 assert.equal((await send(buyer,'PATCH','/profile',{displayName:'Buyer'},{'x-csrf-token':'wrong'})).statusCode,403);
 assert.equal((await send(buyer,'PATCH','/profile',{displayName:'Buyer'},{origin:'https://evil.example'})).statusCode,403);
 assert.equal((await send(buyer,'PATCH','/profile',{displayName:'Buyer',role:'admin'})).statusCode,400);
 assert.equal((await send(buyer,'PATCH','/profile',{displayName:'Buyer',email:'owner@example.test'})).statusCode,400);
 assert.equal((await send(buyer,'GET','/admin/orders')).statusCode,403);
 assert.equal((await send(buyer,'PATCH','/admin/settings',{monthCommissionBps:1000,quarterCommissionBps:1000,halfCommissionBps:1000,yearCommissionBps:1000,commissionMode:'first_order',expectedVersion:1})).statusCode,403);
});
test('server owns order prices and customer identity; retries return one order',async()=>{
 const key=randomUUID();const payload={interval:'year',requestKey:key};
 assert.equal((await send(buyer,'POST','/orders',{...payload,amountCents:1})).statusCode,400);
 assert.equal((await send(buyer,'POST','/orders',{...payload,customerId:owner.user.id})).statusCode,400);
 const created=await send(buyer,'POST','/orders',payload);assert.equal(created.statusCode,201,created.body);const row=created.json();assert.equal(row.amount_cents,172380);assert.equal(row.customer_id,buyer.user.id);assert.equal(row.status,'pending_payment');
 const retry=await send(buyer,'POST','/orders',payload);assert.equal(retry.json().id,row.id);
 assert.equal((await send(buyer,'POST','/orders',{interval:'month',requestKey:key})).statusCode,409);
 assert.equal((await send(buyer,'POST','/orders',{interval:'month',requestKey:randomUUID()})).statusCode,409);
 assert.equal((await send(other,'GET','/orders/'+row.id)).statusCode,404);
 assert.equal((await send(other,'PATCH','/orders/'+row.id,{action:'cancel_pending',expectedVersion:1})).statusCode,404);
 assert.equal((await send(owner,'PATCH','/admin/orders/'+row.id,{status:'provisioning',expectedVersion:1})).statusCode,409);
 const cancelled=await send(buyer,'PATCH','/orders/'+row.id,{action:'cancel_pending',expectedVersion:1});assert.equal(cancelled.json().status,'cancelled');
});
test('referral binds only a new customer, does not overwrite prior attribution, and reveals no buyer emails to affiliate',async()=>{
 assert.equal((await send(affiliate,'POST','/affiliate',{})).statusCode,200);const data=(await send(affiliate,'GET','/affiliate')).json();assert.match(data.affiliate.code,/^[A-Z0-9]{12}$/);assert.equal(new URL(data.affiliate.url).searchParams.get('ref'),data.affiliate.code);
 buyer=await login('referred-buyer','google',data.affiliate.code);
 const before=(await send(affiliate,'GET','/affiliate')).json();assert.equal(before.stats.registrations,1);assert.equal(before.stats.pendingCents,0);
 await login('other','google',data.affiliate.code);assert.equal((await send(affiliate,'GET','/affiliate')).json().stats.registrations,1);
 const raw=await send(affiliate,'GET','/affiliate');assert.doesNotMatch(raw.body,/referred-buyer@example.test/);
 const settings=(await send(owner,'GET','/admin/settings')).json();const saved=await send(owner,'PATCH','/admin/settings',{monthCommissionBps:1000,quarterCommissionBps:1000,halfCommissionBps:1000,yearCommissionBps:1000,commissionMode:'first_order',expectedVersion:settings.version});assert.equal(saved.statusCode,200,saved.body);
 order=(await send(buyer,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();assert.equal(order.amount_cents,16900);assert.equal(order.affiliate_id,affiliate.user.id);assert.equal(order.commission_bps,1000);
 await send(owner,'PATCH','/admin/settings',{monthCommissionBps:2000,quarterCommissionBps:2000,halfCommissionBps:2000,yearCommissionBps:2000,commissionMode:'each_order',expectedVersion:saved.json().version});
 assert.equal((await send(affiliate,'GET','/affiliate')).json().commissions.length,0);
});
test('only a trusted verified payment event accrues snapshotted commission and is idempotent',async()=>{
 assert.equal((await send(buyer,'POST','/payments/events',{orderId:order.id,status:'paid'})).statusCode,404);
 await assert.rejects(recordVerifiedCaldockPayment(db,{eventId:'wrong_amount',orderId:order.id,type:'paid',amountCents:1,currency:'USD'}));
 const event={eventId:'verified_event_1',orderId:order.id,type:'paid' as const,amountCents:16900,currency:'USD'};
 assert.equal((await recordVerifiedCaldockPayment(db,event)).duplicate,false);assert.equal((await recordVerifiedCaldockPayment(db,event)).duplicate,true);
 const ledger=(await send(affiliate,'GET','/affiliate')).json();assert.equal(ledger.commissions.length,1);commission=ledger.commissions[0];assert.equal(commission.amount_cents,1690);assert.equal(commission.rate_bps,1000);assert.equal(commission.status,'pending');
 assert.equal((await send(buyer,'GET','/orders/'+order.id)).json().status,'paid');
});
test('admin fulfillment uses valid transitions, optimistic versions and delivery-based billing',async()=>{
 const paid=(await send(buyer,'GET','/orders/'+order.id)).json();assert.equal((await send(owner,'PATCH','/admin/orders/'+order.id,{status:'active',expectedVersion:paid.version})).statusCode,409);
 const provision=await send(owner,'PATCH','/admin/orders/'+order.id,{status:'provisioning',expectedVersion:paid.version});assert.equal(provision.statusCode,200,provision.body);
 assert.equal((await send(owner,'PATCH','/admin/orders/'+order.id,{status:'active',expectedVersion:paid.version})).statusCode,409);
 const delivered=await send(owner,'PATCH','/admin/orders/'+order.id,{status:'active',expectedVersion:provision.json().version,deliveryNote:'Your dedicated Mac is ready.'});assert.equal(delivered.statusCode,200,delivered.body);assert.ok(delivered.json().delivered_at);assert.ok(new Date(delivered.json().billing_ends_at)>new Date(delivered.json().delivered_at));
 assert.equal((await send(owner,'GET','/admin/orders?status=active')).json().items.length,1);
 assert.equal((await send(owner,'GET','/admin/orders?search='+encodeURIComponent("' OR 1=1; --"))).json().items.length,0);
});
test('manual commission recording requires approval and reference; refund voids earned amount while retaining recovery evidence',async()=>{
 assert.equal((await send(buyer,'PATCH','/admin/commissions/'+commission.id,{status:'approved',expectedStatus:'pending'})).statusCode,403);
 assert.equal((await send(owner,'PATCH','/admin/commissions/'+commission.id,{status:'settled',expectedStatus:'pending',reference:'invalid'})).statusCode,400);
 assert.equal((await send(owner,'PATCH','/admin/commissions/'+commission.id,{status:'approved',expectedStatus:'pending'})).statusCode,200);
 assert.equal((await send(owner,'PATCH','/admin/commissions/'+commission.id,{status:'settled',expectedStatus:'approved'})).statusCode,400);
 const settled=await send(owner,'PATCH','/admin/commissions/'+commission.id,{status:'settled',expectedStatus:'approved',reference:'Offline transfer receipt EXAMPLE-1'});assert.equal(settled.statusCode,200,settled.body);
 await recordVerifiedCaldockPayment(db,{eventId:'verified_refund_1',orderId:order.id,type:'refunded',amountCents:16900,currency:'USD'});
 const data=(await send(affiliate,'GET','/affiliate')).json();assert.equal(data.commissions[0].status,'void');assert.ok(data.commissions[0].settled_at);assert.equal(data.stats.pendingCents,0);assert.equal(data.stats.settledCents,0);
 assert.ok((await db.query('SELECT * FROM caldock_audit WHERE object_id=$1',[commission.id])).rows.length>=2);
});
test('billing migration is repeatable and leaves legacy order snapshots unchanged',async()=>{
 const legacy=await login('legacy-order-customer');
 const row=(await send(legacy,'POST','/orders',{interval:'year',requestKey:randomUUID()})).json();
 await db.query('UPDATE caldock_orders SET amount_cents=179900 WHERE id=$1',[row.id]);
 await db.exec("ALTER TABLE caldock_orders DROP CONSTRAINT caldock_orders_interval_check; ALTER TABLE caldock_orders ADD CONSTRAINT caldock_orders_interval_check CHECK(interval IN ('month','year'))");
 await db.exec(caldockSchema);await db.exec(caldockSchema);
 assert.equal((await send(legacy,'GET','/orders/'+row.id)).json().amount_cents,179900);
 assert.match((await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='caldock_orders'::regclass AND conname='caldock_orders_interval_check'")).rows[0].definition,/quarter/);
});
test('half-yearly login, authoritative upfront price, referral commission and six-month delivery agree',async()=>{
 const code=(await send(affiliate,'GET','/affiliate')).json().affiliate.code;
 const customer=await login('half-yearly-customer','google',code,'half');
 const key=randomUUID();
 assert.equal((await send(customer,'POST','/orders',{interval:'half',requestKey:key,amountCents:16900})).statusCode,400);
 const created=await send(customer,'POST','/orders',{interval:'half',requestKey:key});assert.equal(created.statusCode,201,created.body);
 const row=created.json();assert.equal(row.amount_cents,91260);assert.equal(row.interval,'half');
 assert.equal((await send(customer,'POST','/orders',{interval:'half',requestKey:key})).json().id,row.id);
 await recordVerifiedCaldockPayment(db,{eventId:'half-yearly-verified-paid',orderId:row.id,type:'paid',amountCents:91260,currency:'USD'});
 const ledger=(await db.query('SELECT amount_cents FROM caldock_commissions WHERE order_id=$1',[row.id])).rows[0];assert.equal(ledger.amount_cents,18252);
 const paid=(await send(customer,'GET','/orders/'+row.id)).json();
 const provisioning=(await send(owner,'PATCH','/admin/orders/'+row.id,{status:'provisioning',expectedVersion:paid.version})).json();
 const delivered=await send(owner,'PATCH','/admin/orders/'+row.id,{status:'active',expectedVersion:provisioning.version});assert.equal(delivered.statusCode,200,delivered.body);
 assert.equal((await db.query("SELECT billing_ends_at=paid_at+interval '6 months' AS correct_term FROM caldock_orders WHERE id=$1",[row.id])).rows[0].correct_term,true);
});
test('logout revokes the server session and clears the cookie',async()=>{
 assert.equal((await send(other,'DELETE','/session')).statusCode,200);assert.equal((await send(other,'GET','/me')).statusCode,401);
});
test('setup answers are optional, editable by the customer and admins, and private to the customer',async()=>{
 const customer=await login('setup-answers-customer','google',undefined,'month'),stranger=await login('setup-answers-stranger');
 const row=(await send(customer,'POST','/orders',{interval:'month',requestKey:randomUUID()})).json();
 assert.deepEqual(row.setup_answers,{});
 assert.equal((await send(customer,'PATCH','/orders/'+row.id+'/setup',{email:'maybe'})).statusCode,400);
 assert.equal((await send(customer,'PATCH','/orders/'+row.id+'/setup',{email:'yes',password:'x'})).statusCode,400);
 const saved=await send(customer,'PATCH','/orders/'+row.id+'/setup',{appleId:'yes',email:'no'});assert.equal(saved.statusCode,200,saved.body);
 assert.deepEqual(saved.json().setup_answers,{appleId:'yes',email:'no',card:null});assert.equal(saved.json().version,row.version);
 assert.equal((await send(stranger,'PATCH','/orders/'+row.id+'/setup',{card:'yes'})).statusCode,404);
 assert.equal((await send(customer,'PATCH','/admin/orders/'+row.id+'/setup',{card:'yes'})).statusCode,403);
 const edited=await send(owner,'PATCH','/admin/orders/'+row.id+'/setup',{appleId:'yes',email:'yes',card:'no'});assert.equal(edited.statusCode,200,edited.body);
 assert.deepEqual((await send(customer,'GET','/orders/'+row.id)).json().setup_answers,{appleId:'yes',email:'yes',card:'no'});
 assert.deepEqual((await send(owner,'GET','/admin/orders?search='+row.id)).json().items[0].setup_answers,{appleId:'yes',email:'yes',card:'no'});
 assert.equal((await send(customer,'PATCH','/orders/'+row.id,{action:'cancel_pending',expectedVersion:row.version})).statusCode,200);
 assert.equal((await send(customer,'PATCH','/orders/'+row.id+'/setup',{card:'yes'})).statusCode,409);
});
