import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database, Queryable } from './db.js';
import { hash, sameSecret, readCookie } from './auth.js';
import { deny } from './errors.js';
import { createCaldockGateway, type CaldockGateway, type CaldockProvider } from './caldock-oidc.js';
import { recordCaldockRenewalCommission, caldockAudit, caldockOrderAmounts, caldockStockStatus, CALDOCK_SALE_PRICES, createCaldockOrder, recordVerifiedCaldockPayment } from './caldock-domain.js';
import { ApiError } from './errors.js';
import { mailerFromEnv, type Mailer } from './members.js';
import { orderWebhookFromEnv, type OrderWebhook } from './caldock-notify.js';
import { isStaleTestSession, onExistingStripeObject, stripeFromEnv, verifyCaldockStripeEvent, StripeRequestError, STRIPE_RECURRING, type CaldockStripe } from './caldock-stripe.js';

type Customer = {id:string;display_name:string;email:string|null;active:boolean;created_at:string};
type Session = {user:Customer;csrf:string;token:string};
export type CaldockOptions = {publicUrl?:string;siteUrl?:string;liveStock?:boolean;mailer?:Mailer|null;orderNotifyEmails?:string[];orderWebhook?:OrderWebhook|null;marketingUrl?:string;secureCookies?:boolean;adminUserIds?:string[];providers?:Partial<Record<CaldockProvider,CaldockGateway>>;stripe?:CaldockStripe};
const id=z.string().uuid(),providerName=z.enum(['google','apple']);
const status=z.enum(['pending_payment','paid','provisioning','active','cancelled','refunded']);
const interval=z.enum(['week','month','quarter','half','year']);
const saleInterval=z.enum(['month','quarter','half','year']);
const nextView=z.enum(['account','orders','affiliate','checkout','admin','studio']);
const token=()=>randomBytes(32).toString('base64url');
export const caldockCookieName=(secure:boolean,kind='session')=>(secure?'__Host-':'')+'caldock_'+kind;
function sessionCookie(secure:boolean,value:string,maxAge=604800,kind='session',crossSite=false) {
  return `${caldockCookieName(secure,kind)}=${value}; Path=/; HttpOnly; SameSite=${crossSite?'None':'Lax'}; Max-Age=${maxAge}${secure?'; Secure':''}`;
}
function appendCookie(reply:any,value:string) {const old=reply.getHeader('set-cookie');reply.header('Set-Cookie',[...(old?[old].flat():[]),value]);}
export async function issueCaldockSession(db:Queryable,userId:string) {
  const value=token(),csrf=token();
  await db.query("INSERT INTO caldock_sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+interval '7 days')",[hash(value),userId,csrf]);
  return {token:value,csrf};
}
export function caldockOptionsFromEnv(env:NodeJS.ProcessEnv):CaldockOptions {
  const providers:NonNullable<CaldockOptions['providers']>={};
  if(env.CALDOCK_GOOGLE_CLIENT_ID&&env.CALDOCK_GOOGLE_CLIENT_SECRET) providers.google=createCaldockGateway('google',{clientId:env.CALDOCK_GOOGLE_CLIENT_ID,clientSecret:env.CALDOCK_GOOGLE_CLIENT_SECRET});
  if(env.CALDOCK_APPLE_SERVICE_ID&&env.CALDOCK_APPLE_TEAM_ID&&env.CALDOCK_APPLE_KEY_ID&&env.CALDOCK_APPLE_PRIVATE_KEY) providers.apple=createCaldockGateway('apple',{clientId:env.CALDOCK_APPLE_SERVICE_ID,teamId:env.CALDOCK_APPLE_TEAM_ID,keyId:env.CALDOCK_APPLE_KEY_ID,privateKey:env.CALDOCK_APPLE_PRIVATE_KEY});
  let stripe:CaldockStripe|undefined;
  // A Stripe misconfiguration disables CalDock payments only; it must never stop the shared Work OS service.
  try{stripe=stripeFromEnv(env);}catch(error){console.error('CalDock payments disabled: '+(error as Error).message);}
  // Its own mail settings: the shared ones would also switch on Work OS email sign-in and invites.
  return {stripe,liveStock:true,mailer:mailerFromEnv({RESEND_API_KEY:env.CALDOCK_RESEND_API_KEY,EMAIL_FROM:env.CALDOCK_EMAIL_FROM}),orderNotifyEmails:(env.CALDOCK_ORDER_NOTIFY_EMAILS||'').split(',').map(x=>x.trim()).filter(Boolean),orderWebhook:orderWebhookFromEnv(env),publicUrl:env.APP_PUBLIC_URL||env.RENDER_EXTERNAL_URL||'http://localhost:4173',siteUrl:'https://wodemac.com',secureCookies:env.NODE_ENV==='production',marketingUrl:env.CALDOCK_MARKETING_URL||'https://yonge6.github.io/mac-mini-rental/',adminUserIds:(env.CALDOCK_ADMIN_USER_IDS||'').split(',').map(x=>x.trim()).filter(Boolean),providers};
}
export async function registerCaldockRoutes(app:FastifyInstance,db:Database,options:CaldockOptions={}) {
  const publicUrl=new URL(options.publicUrl||'http://localhost:4173');
  if(!['http:','https:'].includes(publicUrl.protocol)||publicUrl.username||publicUrl.password)throw new Error('Invalid CalDock public URL');
  const origin=publicUrl.origin,secure=options.secureCookies===true,providers=options.providers||{};
  const admins=new Set(options.adminUserIds||[]);
  // Referral links open the storefront domain when there is one.
  const market=new URL(options.siteUrl||options.marketingUrl||'https://yonge6.github.io/mac-mini-rental/');
  if(!['http:','https:'].includes(market.protocol)||market.username||market.password)throw new Error('Invalid CalDock marketing URL');
  const stripe=options.stripe;
  const requireStock=async(quantity=1)=>{if(!options.liveStock)return;const {left}=await caldockStockStatus(db);if(left===0)deny(409,'CALDOCK_SOLD_OUT','All Macs are rented right now');if(left<quantity)deny(409,'CALDOCK_NOT_ENOUGH_STOCK','Fewer Macs are available than this order needs');};
  const viaStripe=async<T>(call:()=>Promise<T>):Promise<T>=>{try{return await call();}catch(error){if(error instanceof StripeRequestError)deny(502,'CALDOCK_PAYMENT_PROVIDER_ERROR','The payment provider could not complete the request; try again');throw error;}};
  const stopStripeRenewal=async(subscriptionId:string|null)=>{if(stripe&&subscriptionId)await viaStripe(()=>onExistingStripeObject(stripe,account=>account.request('POST','/v1/subscriptions/'+encodeURIComponent(subscriptionId),{cancel_at_period_end:'true'},'caldock-stop-'+subscriptionId)));};
  const sessions=new WeakMap<FastifyRequest,Session>();
  const actor=(req:FastifyRequest)=>sessions.get(req)||deny(401,'CALDOCK_UNAUTHENTICATED','Sign in to wodeMac to continue');
  const admin=(req:FastifyRequest)=>{const current=actor(req);if(!admins.has(current.user.id))deny(403,'CALDOCK_ADMIN_REQUIRED','wodeMac administrator access is required');return current;};
  // The storefront has its own domain; requests on the shared host keep that host's origin and /caldock/ path.
  const site=options.siteUrl?new URL(options.siteUrl):undefined;
  const onSite=(req:FastifyRequest)=>!!site&&(req.headers.host||'').toLowerCase()===site.host;
  const originFor=(req:FastifyRequest)=>onSite(req)?site!.origin:origin;
  const appPath=(req:FastifyRequest)=>onSite(req)?'/':'/caldock/';
  const checkOrigin=(req:FastifyRequest)=>{if(req.headers.origin!==originFor(req))deny(403,'CALDOCK_CSRF_INVALID','Request origin or security token is invalid');};
  const attempts=new Map<string,{count:number;expires:number}>();
  const limit=(req:FastifyRequest)=>{
    const now=Date.now(),key=hash(req.ip),record=attempts.get(key);
    if(record&&record.expires>now){if(++record.count>100)deny(429,'CALDOCK_RATE_LIMITED','Too many requests; try again shortly');}
    else attempts.set(key,{count:1,expires:now+60000});
    if(attempts.size>1000)for(const[k,v]of attempts)if(v.expires<=now)attempts.delete(k);
  };
  const returnUrl=(req:FastifyRequest,view:string,language:string,billing:string,error?:string)=>{const u=new URL(view==='studio'?'/decision-studio/':appPath(req),originFor(req));u.searchParams.set('view',view);u.searchParams.set('lang',language);u.searchParams.set('interval',billing);if(error)u.searchParams.set('error',error);return u.toString();};
  async function referral(req:FastifyRequest,reply:any,code?:string) {
    const old=readCookie(req.headers.cookie,caldockCookieName(secure,'ref'));
    if(old){const row=(await db.query('SELECT token_hash FROM caldock_referral_visits WHERE token_hash=$1 AND expires_at>now()',[hash(old)])).rows[0];if(row)return row.token_hash;}
    if(!code)return null;
    const affiliate=(await db.query('SELECT user_id FROM caldock_affiliates WHERE code=$1 AND active=true',[code])).rows[0];
    if(!affiliate)return null;
    const value=token();
    await db.query("INSERT INTO caldock_referral_visits(token_hash,affiliate_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[hash(value),affiliate.user_id]);
    appendCookie(reply,sessionCookie(secure,value,30*86400,'ref'));
    return hash(value);
  }
  app.register(async routes=>{
    routes.addHook('onRequest',async(req,reply)=>{
      reply.header('Cache-Control','no-store');
      const path=req.url.split('?')[0];
      if(path==='/caldock/capabilities'||path==='/caldock/referral-visits'||/^\/caldock\/auth\/(google|apple)\/(start|callback)$/.test(path))return;
      const value=readCookie(req.headers.cookie,caldockCookieName(secure));
      if(!value)deny(401,'CALDOCK_UNAUTHENTICATED','Sign in to wodeMac to continue');
      const row=(await db.query('SELECT u.*,s.csrf_token FROM caldock_sessions s JOIN caldock_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true',[hash(value)])).rows[0];
      if(!row)deny(401,'CALDOCK_UNAUTHENTICATED','Sign in to wodeMac to continue');
      const {csrf_token,...user}=row;sessions.set(req,{user,csrf:csrf_token,token:value});
      if(!['GET','HEAD','OPTIONS'].includes(req.method)){
        checkOrigin(req);const supplied=req.headers['x-csrf-token'];
        if(typeof supplied!=='string'||!sameSecret(supplied,csrf_token))deny(403,'CALDOCK_CSRF_INVALID','Request origin or security token is invalid');
      }
    });
    routes.get('/capabilities',async req=>({service:'caldock',stock:options.liveStock?await caldockStockStatus(db):null,accountApp:originFor(req)+appPath(req),providers:{google:!!providers.google,apple:!!providers.apple},payments:!!stripe,paymentMode:stripe?.mode??null,currency:'USD',prices:CALDOCK_SALE_PRICES,auth:{session:'httpOnlyCookie',csrf:true},referrals:{attributionDays:30,automaticPayouts:false}}));
    routes.post('/referral-visits',async(req,reply)=>{checkOrigin(req);limit(req);const input=z.object({code:z.string().regex(/^[A-Z0-9]{12}$/)}).strict().parse(req.body);await referral(req,reply,input.code);return {recorded:true};});
    for(const provider of ['google','apple'] as const){
      routes.get(`/auth/${provider}/start`,async(req,reply)=>{
        limit(req);const gateway=providers[provider];if(!gateway)deny(503,'CALDOCK_PROVIDER_NOT_CONFIGURED','This sign-in method is not available yet');
        const input=z.object({next:nextView.default('account'),lang:z.enum(['zh','en']).default('zh'),interval:interval.default('month'),ref:z.string().regex(/^[A-Z0-9]{12}$/).optional()}).strict().parse(req.query);
        const state=token(),browser=token(),nonce=token(),verifier=token();
        const referralHash=await referral(req,reply,input.ref);
        await db.query('DELETE FROM caldock_oauth_states WHERE expires_at<now()');
        await db.query("INSERT INTO caldock_oauth_states(state_hash,browser_hash,provider,nonce,verifier,next_view,interval,language,referral_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '10 minutes')",[hash(state),hash(browser),provider,nonce,verifier,input.next,input.interval,input.lang,referralHash]);
        appendCookie(reply,sessionCookie(secure,browser,600,'oauth_'+provider,provider==='apple'&&secure));
        return reply.redirect(gateway.authorizationUrl({state,nonce,challenge:createHash('sha256').update(verifier).digest('base64url'),redirectUri:originFor(req)+`/api/caldock/auth/${provider}/callback`}));
      });
      routes.route({method:provider==='apple'?'POST':'GET',url:`/auth/${provider}/callback`,handler:async(req,reply)=>{
        limit(req);const gateway=providers[provider];if(!gateway)deny(503,'CALDOCK_PROVIDER_NOT_CONFIGURED','This sign-in method is not available yet');
        const input=z.object({state:z.string().regex(/^[A-Za-z0-9_-]{43}$/),code:z.string().min(1).max(4096).optional(),error:z.string().max(100).optional(),user:z.string().max(4000).optional(),id_token:z.string().max(16000).optional()}).parse(provider==='apple'?req.body:req.query);
        const browser=readCookie(req.headers.cookie,caldockCookieName(secure,'oauth_'+provider));
        if(!browser)deny(400,'CALDOCK_OAUTH_STATE_INVALID','Sign-in expired; please start again');
        const state=(await db.query('DELETE FROM caldock_oauth_states WHERE state_hash=$1 AND browser_hash=$2 AND provider=$3 AND expires_at>now() RETURNING *',[hash(input.state),hash(browser),provider])).rows[0];
        if(!state)deny(400,'CALDOCK_OAUTH_STATE_INVALID','Sign-in expired; please start again');
        appendCookie(reply,sessionCookie(secure,'',0,'oauth_'+provider,provider==='apple'&&secure));
        if(input.error||!input.code)return reply.redirect(returnUrl(req,'login',state.language,state.interval,'oauth_cancelled'));
        let identity;
        try {identity=await gateway.authenticate({code:input.code,nonce:state.nonce,verifier:state.verifier,redirectUri:originFor(req)+`/api/caldock/auth/${provider}/callback`});}
        catch {return reply.redirect(returnUrl(req,'login',state.language,state.interval,'oauth_failed'));}
        if(identity.provider!==provider||!identity.subject||identity.subject.length>255)deny(400,'CALDOCK_IDENTITY_INVALID','Identity could not be verified');
        const user=await db.transaction(async tx=>{
          // One insert wins concurrent first logins; provider subject, never email, is the key.
          const newId=randomUUID();
          const prior=(await tx.query('SELECT u.* FROM caldock_identities i JOIN caldock_users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2',[provider,identity.subject])).rows[0];
          if(prior){if(!prior.active)deny(403,'CALDOCK_ACCOUNT_DISABLED','This wodeMac account is disabled');return prior;}
          await tx.query('INSERT INTO caldock_users(id,display_name,email) VALUES($1,$2,$3)',[newId,identity.name.slice(0,100)||'wodeMac user',identity.email]);
          const linked=await tx.query('INSERT INTO caldock_identities(provider,subject,user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id',[provider,identity.subject,newId]);
          if(!linked.rows.length){await tx.query('DELETE FROM caldock_users WHERE id=$1',[newId]);const current=(await tx.query('SELECT u.* FROM caldock_identities i JOIN caldock_users u ON u.id=i.user_id WHERE i.provider=$1 AND i.subject=$2',[provider,identity.subject])).rows[0];if(!current?.active)deny(403,'CALDOCK_ACCOUNT_DISABLED','This CalDock account is disabled');return current;}
          if(state.referral_hash){const visit=(await tx.query('SELECT v.affiliate_id FROM caldock_referral_visits v JOIN caldock_affiliates a ON a.user_id=v.affiliate_id WHERE v.token_hash=$1 AND v.expires_at>now() AND a.active=true AND v.affiliate_id<>$2',[state.referral_hash,newId])).rows[0];if(visit)await tx.query('INSERT INTO caldock_referrals(customer_id,affiliate_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[newId,visit.affiliate_id]);}
          await caldockAudit(tx,newId,'account.created',newId,{provider});return (await tx.query('SELECT * FROM caldock_users WHERE id=$1',[newId])).rows[0];
        });
        const issued=await issueCaldockSession(db,user.id);appendCookie(reply,sessionCookie(secure,issued.token));
        return reply.redirect(returnUrl(req,state.next_view,state.language,state.interval));
      }});
    }
    routes.get('/me',async req=>{const current=actor(req);return {user:current.user,isAdmin:admins.has(current.user.id),csrfToken:current.csrf};});
    routes.delete('/session',async(req,reply)=>{const current=actor(req);await db.query('DELETE FROM caldock_sessions WHERE token_hash=$1',[hash(current.token)]);reply.header('Set-Cookie',sessionCookie(secure,'',0));return {signedOut:true};});
    routes.patch('/profile',async req=>{const current=actor(req),input=z.object({displayName:z.string().trim().min(1).max(100)}).strict().parse(req.body);return (await db.query('UPDATE caldock_users SET display_name=$2 WHERE id=$1 RETURNING id,display_name,email',[current.user.id,input.displayName])).rows[0];});
    // Customer questionnaire: every field optional; the customer can change it at any time. Admins read it with orders and customers.
    const yn=z.enum(['yes','no']).nullable().default(null),sourceDetails={ai:['chatgpt','claude','gemini','doubao','deepseek','kimi','yuanbao','ai_other'],social:['xiaohongshu','douyin','wechat_channels','wechat_official','bilibili','zhihu','weibo','x','youtube','social_other']} as Record<string,string[]>;
    const profileAnswers=z.object({appleId:yn,email:yn,card:yn,source:z.enum(['friend','ai','social','creator','search','other']).nullable().default(null),sourceDetail:z.string().max(40).nullable().default(null),sourceNote:z.string().trim().max(200).default(''),uses:z.array(z.enum(['coding','agents','content','ops','study','other'])).max(6).default([]),teamSize:z.enum(['solo','2_5','6_20','20_plus']).nullable().default(null),wechat:z.string().trim().max(64).default('')}).strict().superRefine((v,ctx)=>{if(v.sourceDetail!==null&&!(v.source&&sourceDetails[v.source]?.includes(v.sourceDetail)))ctx.addIssue({code:'custom',path:['sourceDetail'],message:'Source detail does not match the source'});if(new Set(v.uses).size!==v.uses.length)ctx.addIssue({code:'custom',path:['uses'],message:'Duplicate use'});});
    routes.patch('/profile/answers',async req=>{const current=actor(req),input=profileAnswers.parse(req.body);return db.transaction(async tx=>{const row=(await tx.query('UPDATE caldock_users SET profile_answers=$2::jsonb,profile_updated_at=now() WHERE id=$1 RETURNING id,display_name,email,profile_answers,profile_updated_at',[current.user.id,JSON.stringify(input)])).rows[0];await caldockAudit(tx,current.user.id,'profile.answers',current.user.id,{fields:Object.keys(input).filter(k=>{const v=(input as any)[k];return v!==null&&v!==''&&!(Array.isArray(v)&&!v.length);})});return row;});});
    routes.get('/orders',async req=>({items:(await db.query('SELECT * FROM caldock_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[actor(req).user.id])).rows}));
    routes.get<{Params:{id:string}}>('/orders/:id',async req=>{const row=(await db.query('SELECT * FROM caldock_orders WHERE id=$1 AND customer_id=$2',[id.parse(req.params.id),actor(req).user.id])).rows[0];if(!row)deny(404,'NOT_FOUND','Order not found');return row;});
    routes.post('/orders',async(req,reply)=>{const input=z.object({interval:saleInterval,quantity:z.number().int().min(1).max(100).default(1),requestKey:id}).strict().parse(req.body);await requireStock(input.quantity);return reply.code(201).send(await createCaldockOrder(db,actor(req).user.id,input.interval,input.quantity,input.requestKey));});
    routes.post<{Params:{id:string}}>('/orders/:id/checkout',async req=>{
      const current=actor(req),input=z.object({lang:z.enum(['zh','en']).default('zh')}).strict().parse(req.body||{});
      if(!stripe)deny(503,'CALDOCK_PAYMENTS_UNAVAILABLE','Online payment is not available yet');
      await requireStock();
      return db.transaction(async tx=>{
        // Row lock: one hosted payment page per order, so a customer cannot pay twice in parallel tabs.
        let order=(await tx.query('SELECT * FROM caldock_orders WHERE id=$1 AND customer_id=$2 FOR UPDATE',[id.parse(req.params.id),current.user.id])).rows[0];
        if(!order)deny(404,'NOT_FOUND','Order not found');
        if(order.status!=='pending_payment')deny(409,'INVALID_ORDER_STATE','This order is not awaiting payment');
        if(order.stripe_checkout_session_id&&!isStaleTestSession(stripe,order.stripe_checkout_session_id)){
          const existing=await viaStripe(()=>onExistingStripeObject(stripe,account=>account.request('GET','/v1/checkout/sessions/'+encodeURIComponent(order.stripe_checkout_session_id))));
          if(existing.status==='open'&&typeof existing.url==='string')return {url:existing.url};
          if(existing.status==='complete')deny(409,'CALDOCK_PAYMENT_IN_PROGRESS','Payment for this order is being confirmed; reload in a moment');
        }
        await requireStock(order.quantity);
        // No payment page is open any more, so an unpaid order takes today's price with no leftover discount.
        const amounts=caldockOrderAmounts(order.interval,order.quantity);
        order=(await tx.query('UPDATE caldock_orders SET amount_cents=$2,list_amount_cents=$3,offer_day=NULL,offer_hold_until=NULL WHERE id=$1 RETURNING *',[order.id,amounts.total,amounts.subtotal])).rows[0];
        const back=(view:string,result:string)=>{const u=new URL(appPath(req),originFor(req));u.searchParams.set('view',view);u.searchParams.set('lang',input.lang);u.searchParams.set('interval',order.interval);u.searchParams.set('checkout',result);return u.toString();};
        const names={week:['Weekly','周付'],month:['Monthly','月付'],quarter:['Quarterly','季付'],half:['Half-yearly','半年付'],year:['Yearly','年付']}[order.interval as 'week'|'month'|'quarter'|'half'|'year'];
        const recurring=STRIPE_RECURRING[order.interval as 'week'|'month'|'quarter'|'half'|'year'];
        const params:Record<string,string>={
          mode:'subscription',client_reference_id:order.id,locale:input.lang==='en'?'en':'zh',
          success_url:back('orders','success')+'&order='+encodeURIComponent(order.id),cancel_url:back('checkout','cancelled'),
          'line_items[0][quantity]':String(order.quantity),'line_items[0][price_data][currency]':'usd',
          // Server-owned price snapshot from the order, never a client amount.
          'line_items[0][price_data][unit_amount]':String(amounts.unit),
          'line_items[0][price_data][recurring][interval]':recurring.interval,
          'line_items[0][price_data][recurring][interval_count]':recurring.interval_count,
          'line_items[0][price_data][product_data][name]':`wodeMac Dedicated Mac mini · ${names[0]} / 独享 Mac mini · ${names[1]}`,
          'metadata[caldock_order_id]':order.id,'subscription_data[metadata][caldock_order_id]':order.id,
        };
        if(current.user.email)params.customer_email=current.user.email;
        if(amounts.bulkOff){
          // A fixed amount, so the total Stripe charges equals the order total to the cent. duration=once: renewals are at the full price.
          const couponId='caldock-bulk-'+amounts.bulkOff;
          await stripe.request('POST','/v1/coupons',{id:couponId,amount_off:String(amounts.bulkOff),currency:'usd',duration:'once',name:'Yearly order of 5 or more: 2.5% off the first year'}).catch(error=>{if(!(error instanceof StripeRequestError)||error.code!=='resource_already_exists')deny(502,'CALDOCK_PAYMENT_PROVIDER_ERROR','The payment provider could not complete the request; try again');});
          params['discounts[0][coupon]']=couponId;
        }
        const session=await viaStripe(()=>stripe.request('POST','/v1/checkout/sessions',params,'caldock-checkout-'+order.id+'-'+(order.stripe_checkout_session_id||'first')));
        if(typeof session.id!=='string'||typeof session.url!=='string')deny(502,'CALDOCK_PAYMENT_PROVIDER_ERROR','The payment provider could not complete the request; try again');
        await tx.query('UPDATE caldock_orders SET stripe_checkout_session_id=$2 WHERE id=$1',[order.id,session.id]);
        await caldockAudit(tx,current.user.id,'payment.checkout_started',order.id,{session:session.id,mode:stripe.mode,amountCents:order.amount_cents,quantity:order.quantity});
        return {url:session.url};
      });
    });
    routes.patch<{Params:{id:string}}>('/orders/:id',async req=>{
      const current=actor(req),input=z.object({action:z.enum(['cancel_pending','stop_renewal']),expectedVersion:z.number().int().positive()}).strict().parse(req.body);
      return db.transaction(async tx=>{const row=(await tx.query('SELECT * FROM caldock_orders WHERE id=$1 AND customer_id=$2 FOR UPDATE',[id.parse(req.params.id),current.user.id])).rows[0];if(!row)deny(404,'NOT_FOUND','Order not found');if(row.version!==input.expectedVersion)deny(409,'VERSION_CONFLICT','Order changed; reload before continuing');if(input.action==='cancel_pending'&&row.status!=='pending_payment'||input.action==='stop_renewal'&&!['paid','provisioning','active'].includes(row.status))deny(409,'INVALID_ORDER_STATE','This order cannot perform the requested action');
        if(input.action==='cancel_pending'&&stripe&&row.stripe_checkout_session_id&&!isStaleTestSession(stripe,row.stripe_checkout_session_id)){
          // Close the hosted payment page first so a cancelled order cannot be paid afterwards.
          await viaStripe(()=>onExistingStripeObject(stripe,async account=>{
            const session=await account.request('GET','/v1/checkout/sessions/'+encodeURIComponent(row.stripe_checkout_session_id));
            if(session.status==='complete')deny(409,'CALDOCK_PAYMENT_IN_PROGRESS','Payment for this order is being confirmed; reload in a moment');
            if(session.status==='open')await account.request('POST','/v1/checkout/sessions/'+encodeURIComponent(row.stripe_checkout_session_id)+'/expire');
          }));
        }
        if(input.action==='stop_renewal')await stopStripeRenewal(row.stripe_subscription_id);
        const updated=(await tx.query("UPDATE caldock_orders SET status=CASE WHEN $2='cancel_pending' THEN 'cancelled' ELSE status END,renewal_enabled=false,version=version+1 WHERE id=$1 RETURNING *",[row.id,input.action])).rows[0];await caldockAudit(tx,current.user.id,'order.'+input.action,row.id);return updated;});
    });
    routes.post('/affiliate',async req=>{const current=actor(req);await db.query('INSERT INTO caldock_affiliates(user_id,code) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING',[current.user.id,randomBytes(6).toString('hex').toUpperCase()]);return {joined:true};});
    routes.get('/affiliate',async req=>{
      const current=actor(req),affiliate=(await db.query('SELECT * FROM caldock_affiliates WHERE user_id=$1',[current.user.id])).rows[0];
      const settings=(await db.query('SELECT month_commission_bps,quarter_commission_bps,half_commission_bps,year_commission_bps,commission_mode FROM caldock_settings WHERE id=1')).rows[0];
      if(!affiliate)return {affiliate:null,settings,commissions:[],stats:{registrations:0,orders:0,pendingCents:0,settledCents:0}};
      const link=new URL(market);link.searchParams.set('ref',affiliate.code);
      const counts=(await db.query('SELECT (SELECT count(*)::int FROM caldock_referrals WHERE affiliate_id=$1) AS registrations,(SELECT count(*)::int FROM caldock_orders WHERE affiliate_id=$1) AS orders',[current.user.id])).rows[0];
      const commissions=(await db.query('SELECT c.*,o.interval FROM caldock_commissions c JOIN caldock_orders o ON o.id=c.order_id WHERE c.affiliate_id=$1 ORDER BY c.created_at DESC LIMIT 100',[current.user.id])).rows;
      const sums=(await db.query("SELECT COALESCE(sum(amount_cents) FILTER(WHERE status IN ('pending','approved')),0)::bigint AS pending,COALESCE(sum(amount_cents) FILTER(WHERE status='settled'),0)::bigint AS settled FROM caldock_commissions WHERE affiliate_id=$1",[current.user.id])).rows[0];
      // Partners see who is below them only as a masked name, never an email.
      return {affiliate:{...affiliate,url:link.toString()},settings,commissions,stats:{...counts,pendingCents:Number(sums.pending),settledCents:Number(sums.settled)}};
    });
    routes.get('/admin/summary',async req=>{admin(req);return (await db.query("SELECT count(*)::int AS total_orders,count(*) FILTER(WHERE status IN ('paid','provisioning'))::int AS awaiting_delivery,count(*) FILTER(WHERE status='active')::int AS active_macs,COALESCE(sum(amount_cents) FILTER(WHERE status IN ('paid','provisioning','active')),0)::bigint AS paid_cents,(SELECT count(*)::int FROM caldock_users) AS customers,(SELECT COALESCE(sum(amount_cents),0)::bigint FROM caldock_commissions WHERE status IN ('pending','approved')) AS pending_commission_cents FROM caldock_orders")).rows[0];});
    routes.get('/admin/orders',async req=>{admin(req);const q=z.object({status:status.optional(),search:z.string().max(100).default(''),page:z.coerce.number().int().min(0).max(100000).default(0)}).strict().parse(req.query);const where="WHERE ($1::text IS NULL OR o.status=$1) AND ($2='' OR o.id ILIKE $3 OR u.email ILIKE $3 OR u.display_name ILIKE $3)";const params=[q.status||null,q.search,'%'+q.search+'%'];return {items:(await db.query(`SELECT o.*,u.email,u.display_name,u.profile_answers AS customer_answers,u.profile_updated_at AS customer_answers_at,a.code AS referral_code FROM caldock_orders o JOIN caldock_users u ON u.id=o.customer_id LEFT JOIN caldock_affiliates a ON a.user_id=o.affiliate_id ${where} ORDER BY o.created_at DESC,o.id LIMIT 50 OFFSET $4`,[...params,q.page*50])).rows,total:Number((await db.query(`SELECT count(*) FROM caldock_orders o JOIN caldock_users u ON u.id=o.customer_id ${where}`,params)).rows[0].count)};});
    routes.patch<{Params:{id:string}}>('/admin/orders/:id',async req=>{
      const current=admin(req),input=z.object({status:z.enum(['provisioning','active']),expectedVersion:z.number().int().positive(),deliveryNote:z.string().trim().max(1000).default('')}).strict().parse(req.body);
      return db.transaction(async tx=>{const order=(await tx.query('SELECT * FROM caldock_orders WHERE id=$1 FOR UPDATE',[id.parse(req.params.id)])).rows[0];if(!order)deny(404,'NOT_FOUND','Order not found');if(order.version!==input.expectedVersion)deny(409,'VERSION_CONFLICT','Order changed; reload before continuing');if(!(order.status==='paid'&&input.status==='provisioning'||order.status==='provisioning'&&input.status==='active'))deny(409,'INVALID_ORDER_STATE','Only verified paid orders can be provisioned and delivered');const row=(await tx.query("UPDATE caldock_orders SET status=$2,version=version+1,delivery_note=$3,delivered_at=CASE WHEN $2='active' THEN now() ELSE delivered_at END,billing_ends_at=CASE WHEN $2='active' THEN (CASE WHEN billed_from_payment THEN paid_at ELSE now() END)+CASE WHEN interval='year' THEN interval '1 year' WHEN interval='quarter' THEN interval '3 months' WHEN interval='half' THEN interval '6 months' WHEN interval='week' THEN interval '7 days' ELSE interval '1 month' END ELSE billing_ends_at END WHERE id=$1 RETURNING *",[order.id,input.status,input.deliveryNote])).rows[0];
        if(input.status==='active'&&stripe&&row.stripe_subscription_id&&!row.billed_from_payment){
          // Older orders bill from delivery: push the next automatic charge to the end of the delivered period.
          const next=Math.floor(new Date(row.billing_ends_at).getTime()/1000);
          await viaStripe(()=>onExistingStripeObject(stripe,account=>account.request('POST','/v1/subscriptions/'+encodeURIComponent(row.stripe_subscription_id),{trial_end:String(next),proration_behavior:'none'},'caldock-deliver-'+order.id)));
        }
        await caldockAudit(tx,current.user.id,'order.'+input.status,order.id);return row;});
    });
    routes.post('/admin/order-mail-test',async req=>{
      const current=admin(req),mailer=options.mailer,recipients=options.orderNotifyEmails||[];
      if(!mailer||!recipients.length)deny(503,'CALDOCK_ORDER_MAIL_UNCONFIGURED','Order email is not configured');
      const sent=await Promise.allSettled(recipients.map(to=>mailer({to,subject:'wodeMac 新订单邮件测试',text:'这是一封测试邮件，收到说明新订单通知配置正常。',html:'<p>这是一封测试邮件，收到说明新订单通知配置正常。</p>'})));
      const failed=sent.filter(r=>r.status==='rejected').length;
      await caldockAudit(db,current.user.id,'notify.order_mail_test','1',{recipients:recipients.length,failed});
      if(failed)deny(502,'CALDOCK_ORDER_MAIL_FAILED','The test email could not be delivered');
      return {sent:recipients.length};
    });
    routes.post('/admin/order-webhook-test',async req=>{
      const current=admin(req),webhook=options.orderWebhook;
      if(!webhook)deny(503,'CALDOCK_ORDER_WEBHOOK_UNCONFIGURED','The order webhook is not configured');
      let failed=false;
      try{await webhook({event:'caldock.order.test',test:true,orderRef:'TEST',plan:'测试通知',quantity:1,amount:'$0.00',stockLeft:null,adminUrl:`${market.origin}/?view=admin`});}catch{failed=true;}
      await caldockAudit(db,current.user.id,'notify.order_webhook_test','1',{failed});
      if(failed)deny(502,'CALDOCK_ORDER_WEBHOOK_FAILED','The order webhook could not be reached');
      return {sent:true};
    });
    const stockView=async(tx:Queryable=db)=>{const row=(await tx.query('SELECT stock_rented_before,version FROM caldock_settings WHERE id=1')).rows[0];return {...await caldockStockStatus(tx),rentedBefore:row.stock_rented_before,version:row.version};};
    routes.get('/admin/stock',async req=>{admin(req);return stockView();});
    routes.patch('/admin/stock',async req=>{const current=admin(req),input=z.object({total:z.number().int().min(0).max(100000),rentedBefore:z.number().int().min(0).max(100000),expectedVersion:z.number().int().positive()}).strict().parse(req.body);if(input.rentedBefore>input.total)deny(400,'CALDOCK_STOCK_INVALID','Rented Macs cannot exceed the total');return db.transaction(async tx=>{const row=(await tx.query('UPDATE caldock_settings SET stock_total=$1,stock_rented_before=$2,version=version+1,updated_at=now() WHERE id=1 AND version=$3 RETURNING id',[input.total,input.rentedBefore,input.expectedVersion])).rows[0];if(!row)deny(409,'VERSION_CONFLICT','Settings changed; reload before continuing');await caldockAudit(tx,current.user.id,'stock.updated','1',{total:input.total,rentedBefore:input.rentedBefore});return stockView(tx);});});
    routes.get('/admin/settings',async req=>{admin(req);return (await db.query('SELECT * FROM caldock_settings WHERE id=1')).rows[0];});
    routes.get('/admin/customers',async req=>{admin(req);return {items:(await db.query('SELECT u.id,u.display_name,u.email,u.active,u.created_at,u.profile_answers,u.profile_updated_at,(SELECT count(*)::int FROM caldock_orders o WHERE o.customer_id=u.id) AS orders FROM caldock_users u ORDER BY u.created_at DESC LIMIT 100')).rows};});
    // Everything the admin needs about one customer: account, sign-in methods, questionnaire, who referred them, their own referral link, orders and commissions.
    routes.get<{Params:{id:string}}>('/admin/customers/:id',async req=>{admin(req);const customerId=id.parse(req.params.id);
      const user=(await db.query('SELECT id,display_name,email,active,created_at,profile_answers,profile_updated_at FROM caldock_users WHERE id=$1',[customerId])).rows[0];if(!user)deny(404,'NOT_FOUND','Customer not found');
      const [identities,lastSeen,referredBy,affiliate,orders,commissions]=await Promise.all([
        db.query('SELECT provider FROM caldock_identities WHERE user_id=$1 ORDER BY provider',[customerId]),
        db.query('SELECT max(created_at) AS last_sign_in FROM caldock_sessions WHERE user_id=$1',[customerId]),
        db.query('SELECT a.code,u.display_name,u.email,r.created_at FROM caldock_referrals r JOIN caldock_affiliates a ON a.user_id=r.affiliate_id JOIN caldock_users u ON u.id=r.affiliate_id WHERE r.customer_id=$1',[customerId]),
        db.query('SELECT a.code,a.active,a.created_at,(SELECT count(*)::int FROM caldock_referrals r WHERE r.affiliate_id=a.user_id) AS registrations,(SELECT count(*)::int FROM caldock_orders o WHERE o.affiliate_id=a.user_id) AS orders FROM caldock_affiliates a WHERE a.user_id=$1',[customerId]),
        db.query('SELECT id,interval,quantity,amount_cents,status,created_at,paid_at,delivered_at,billing_ends_at,renewal_enabled FROM caldock_orders WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100',[customerId]),
        db.query("SELECT COALESCE(sum(amount_cents) FILTER(WHERE status IN ('pending','approved')),0)::bigint AS pending_cents,COALESCE(sum(amount_cents) FILTER(WHERE status='settled'),0)::bigint AS settled_cents FROM caldock_commissions WHERE affiliate_id=$1",[customerId])
      ]);
      return {user,signInMethods:identities.rows.map(r=>r.provider),lastSignIn:lastSeen.rows[0]?.last_sign_in??null,referredBy:referredBy.rows[0]??null,affiliate:affiliate.rows[0]?{...affiliate.rows[0],pendingCents:Number(commissions.rows[0].pending_cents),settledCents:Number(commissions.rows[0].settled_cents)}:null,orders:orders.rows,paidCents:orders.rows.filter(o=>['paid','provisioning','active'].includes(o.status)).reduce((s,o)=>s+o.amount_cents,0)};
    });
    routes.patch('/admin/settings',async req=>{const current=admin(req),input=z.object({monthCommissionBps:z.number().int().min(0).max(10000),quarterCommissionBps:z.number().int().min(0).max(10000),halfCommissionBps:z.number().int().min(0).max(10000),yearCommissionBps:z.number().int().min(0).max(10000),commissionMode:z.enum(['first_order','each_order']),expectedVersion:z.number().int().positive()}).strict().parse(req.body);return db.transaction(async tx=>{const row=(await tx.query('UPDATE caldock_settings SET month_commission_bps=$1,half_commission_bps=$2,year_commission_bps=$3,commission_mode=$4,quarter_commission_bps=$6,version=version+1,updated_at=now() WHERE id=1 AND version=$5 RETURNING *',[input.monthCommissionBps,input.halfCommissionBps,input.yearCommissionBps,input.commissionMode,input.expectedVersion,input.quarterCommissionBps])).rows[0];if(!row)deny(409,'VERSION_CONFLICT','Settings changed; reload before continuing');await caldockAudit(tx,current.user.id,'affiliate.settings','1',{monthCommissionBps:input.monthCommissionBps,quarterCommissionBps:input.quarterCommissionBps,halfCommissionBps:input.halfCommissionBps,yearCommissionBps:input.yearCommissionBps,commissionMode:input.commissionMode});return row;});});
    routes.get('/admin/affiliates',async req=>{admin(req);return {items:(await db.query('SELECT a.*,u.display_name,u.email,(SELECT count(*)::int FROM caldock_referrals r WHERE r.affiliate_id=a.user_id) AS registrations,(SELECT count(*)::int FROM caldock_orders o WHERE o.affiliate_id=a.user_id) AS orders FROM caldock_affiliates a JOIN caldock_users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100')).rows};});
    routes.get('/admin/commissions',async req=>{admin(req);return {items:(await db.query('SELECT c.*,u.display_name,u.email FROM caldock_commissions c JOIN caldock_users u ON u.id=c.affiliate_id ORDER BY c.created_at DESC LIMIT 200')).rows};});
    routes.patch<{Params:{id:string}}>('/admin/commissions/:id',async req=>{
      const current=admin(req),input=z.object({status:z.enum(['approved','settled']),expectedStatus:z.enum(['pending','approved']),reference:z.string().trim().max(200).optional()}).strict().parse(req.body);
      if(input.status==='settled'&&(!input.reference||input.expectedStatus!=='approved')||input.status==='approved'&&input.expectedStatus!=='pending')deny(400,'SETTLEMENT_REFERENCE_REQUIRED','Record an approved offline settlement reference');
      return db.transaction(async tx=>{const row=(await tx.query("UPDATE caldock_commissions SET status=$2,settlement_reference=CASE WHEN $2='settled' THEN $4 ELSE settlement_reference END,settled_at=CASE WHEN $2='settled' THEN now() ELSE settled_at END WHERE id=$1 AND status=$3 RETURNING *",[id.parse(req.params.id),input.status,input.expectedStatus,input.reference||null])).rows[0];if(!row)deny(409,'VERSION_CONFLICT','Commission changed; reload before continuing');await caldockAudit(tx,current.user.id,'commission.'+input.status,row.id,{reference:input.reference||null,automaticTransfer:false});return row;});
    });
  },{prefix:'/caldock'});
  if(stripe)app.register(async hooks=>{
    // Raw bytes are required for signature verification; this parser is scoped to this plugin only.
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
    hooks.post('/caldock/stripe/webhook',async(req,reply)=>{
      reply.header('Cache-Control','no-store');
      let event:any;
      try{event=verifyCaldockStripeEvent(stripe,req.body as Buffer,req.headers['stripe-signature'] as string|undefined);}
      catch{return reply.code(400).send({error:{code:'CALDOCK_WEBHOOK_INVALID'}});}
      if(event.livemode!==(stripe.mode==='live'))return reply.code(400).send({error:{code:'CALDOCK_WEBHOOK_MODE_MISMATCH'}});
      await handleStripeEvent(event);
      return {received:true};
    });
  });
  // Runs after the payment is committed: a notification failure is audited and never fails the Stripe webhook.
  async function notifyNewOrder(orderId:string) {
    await Promise.all([mailNewOrder(orderId),pingOrderWebhook(orderId)]);
  }
  async function pingOrderWebhook(orderId:string) {
    const webhook=options.orderWebhook;
    if(!webhook)return;
    try{
      const order=(await db.query('SELECT id,interval,quantity,amount_cents FROM caldock_orders WHERE id=$1',[orderId])).rows[0];
      const stock=await caldockStockStatus(db);
      const plan=({week:'周付',month:'月付',quarter:'季付',half:'半年付',year:'年付'} as Record<string,string>)[order.interval]||order.interval;
      await webhook({event:'caldock.order.paid',test:stripe?.mode==='test',orderRef:order.id.slice(0,8).toUpperCase(),plan,quantity:order.quantity,amount:'$'+(order.amount_cents/100).toLocaleString('en-US',{minimumFractionDigits:2}),stockLeft:stock.left,adminUrl:`${market.origin}/?view=admin`});
    }catch{await caldockAudit(db,null,'notify.order_webhook_failed',orderId,{}).catch(()=>{});}
  }
  async function mailNewOrder(orderId:string) {
    const mailer=options.mailer,recipients=options.orderNotifyEmails||[];
    if(!recipients.length)return;
    if(!mailer){await caldockAudit(db,null,'notify.order_mail_unavailable',orderId,{});return;}
    try{
      const order=(await db.query('SELECT o.*,u.display_name,u.email FROM caldock_orders o JOIN caldock_users u ON u.id=o.customer_id WHERE o.id=$1',[orderId])).rows[0];
      const stock=await caldockStockStatus(db),amount='$'+(order.amount_cents/100).toLocaleString('en-US',{minimumFractionDigits:2});
      const plan=({week:'周付',month:'月付',quarter:'季付',half:'半年付',year:'年付'} as Record<string,string>)[order.interval]||order.interval,short=order.id.slice(0,8).toUpperCase();
      const lines=[`订单号：#${short}`,`方案：${plan}`,`数量：${order.quantity} 台`,`实付：${amount}`,`客户：${order.display_name}${order.email?' <'+order.email+'>':''}`,`库存：共 ${stock.total} 台，已租出 ${stock.rented} 台，剩余 ${stock.left} 台`,`交付后台：${market.origin}/?view=admin`];
      const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
      const subject=`${stripe?.mode==='test'?'[测试] ':''}wodeMac 新订单 #${short} · ${plan} ${order.quantity} 台 ${amount}`;
      const sent=await Promise.allSettled(recipients.map(to=>mailer({to,subject,text:lines.join('\n'),html:lines.map(l=>`<p>${esc(l)}</p>`).join('')})));
      const failed=sent.filter(r=>r.status==='rejected').length;
      if(failed)await caldockAudit(db,null,'notify.order_mail_failed',orderId,{failed});
    }catch{await caldockAudit(db,null,'notify.order_mail_failed',orderId,{}).catch(()=>{});}
  }
  async function handleStripeEvent(event:any) {
    const object=event.data.object;
    const record=async(fields:{orderId:string;type:'paid'|'refunded';eventId:string;amountCents:number;currency:string})=>{
      try{const result=await recordVerifiedCaldockPayment(db,fields);if(fields.type==='paid'&&!result.duplicate)await notifyNewOrder(fields.orderId);}
      catch(error){
        // Deterministic rejections (state, amount) are kept for manual review instead of endless provider retries.
        if(!(error instanceof ApiError)||error.status>=500)throw error;
        await caldockAudit(db,null,'payment.rejected',fields.orderId,{eventId:fields.eventId,type:fields.type,code:error.code,amountCents:fields.amountCents});
      }
    };
    if(event.type==='checkout.session.completed'||event.type==='checkout.session.async_payment_succeeded'){
      const orderId=object.metadata?.caldock_order_id||object.client_reference_id;
      if(object.mode!=='subscription'||typeof orderId!=='string'||!/^[0-9a-f-]{36}$/.test(orderId))return;
      const exists=(await db.query('SELECT id FROM caldock_orders WHERE id=$1',[orderId])).rows[0];
      if(!exists)return;
      await db.query('UPDATE caldock_orders SET stripe_customer_id=COALESCE($2,stripe_customer_id),stripe_subscription_id=COALESCE($3,stripe_subscription_id) WHERE id=$1',[orderId,typeof object.customer==='string'?object.customer:null,typeof object.subscription==='string'?object.subscription:null]);
      if(object.payment_status!=='paid')return; // Delayed methods confirm later; nothing is marked paid yet.
      await record({orderId,type:'paid',eventId:'stripe_cs:'+object.id,amountCents:Number(object.amount_total),currency:String(object.currency||'').toUpperCase()});
      return;
    }
    // Remaining events are processed once per Stripe event ID.
    const fresh=(await db.query('INSERT INTO caldock_stripe_events(event_id,event_type) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id',[event.id,event.type])).rows.length>0;
    if(!fresh)return;
    if(event.type==='charge.refunded'){
      if(object.refunded!==true||typeof object.customer!=='string')return; // Partial refunds stay a manual decision.
      const order=(await db.query("SELECT id FROM caldock_orders WHERE stripe_customer_id=$1 AND status IN ('paid','provisioning','active') ORDER BY created_at DESC LIMIT 1",[object.customer])).rows[0];
      if(!order)return;
      // A full refund ends the rental: cancel the subscription now so no further charge is attempted.
      const subscription=(await db.query('SELECT stripe_subscription_id FROM caldock_orders WHERE id=$1',[order.id])).rows[0]?.stripe_subscription_id;
      if(subscription)await onExistingStripeObject(stripe!,account=>account.request('DELETE','/v1/subscriptions/'+encodeURIComponent(subscription))).catch(()=>caldockAudit(db,null,'payment.cancel_failed',order.id,{subscription}));
      await record({orderId:order.id,type:'refunded',eventId:'stripe_ch:'+object.id,amountCents:Number(object.amount),currency:String(object.currency||'').toUpperCase()});
      return;
    }
    const subscriptionId=event.type.startsWith('customer.subscription.')?object.id:(object.subscription??object.parent?.subscription_details?.subscription);
    if(typeof subscriptionId!=='string')return;
    const order=(await db.query('SELECT * FROM caldock_orders WHERE stripe_subscription_id=$1',[subscriptionId])).rows[0];
    if(!order)return;
    if(event.type==='invoice.paid'&&object.billing_reason==='subscription_cycle'){
      // Renewal collected: extend the paid service period and accrue its commission.
      await db.query("UPDATE caldock_orders SET billing_ends_at=GREATEST(COALESCE(billing_ends_at,now()),now())+CASE WHEN interval='year' THEN interval '1 year' WHEN interval='quarter' THEN interval '3 months' WHEN interval='half' THEN interval '6 months' WHEN interval='week' THEN interval '7 days' ELSE interval '1 month' END,version=version+1 WHERE id=$1 AND status='active'",[order.id]);
      await recordCaldockRenewalCommission(db,order,String(object.id),Number(object.amount_paid));
      await caldockAudit(db,null,'payment.renewal',order.id,{invoice:object.id,amountCents:Number(object.amount_paid)});
    } else if(event.type==='invoice.payment_failed'){
      await caldockAudit(db,null,'payment.renewal_failed',order.id,{invoice:object.id});
    } else if(event.type==='customer.subscription.deleted'||(event.type==='customer.subscription.updated'&&object.cancel_at_period_end===true)){
      const changed=(await db.query('UPDATE caldock_orders SET renewal_enabled=false,version=version+1 WHERE id=$1 AND renewal_enabled=true RETURNING id',[order.id])).rows.length>0;
      if(changed)await caldockAudit(db,null,'order.renewal_stopped_by_provider',order.id,{event:event.type});
    }
  }
}
