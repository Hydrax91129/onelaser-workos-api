import { createHmac, timingSafeEqual } from 'node:crypto';

// Minimal Stripe adapter for CalDock. No SDK dependency: form-encoded REST calls and
// the documented v1 webhook signature scheme (HMAC-SHA256 over "<timestamp>.<raw body>").

export type StripeFetch = (url:string,init:{method:string;headers:Record<string,string>;body?:string})=>Promise<{ok:boolean;status:number;json():Promise<any>}>;
export type CaldockStripe = {
  mode:'test'|'live';
  webhookSecret:string;
  request(method:'GET'|'POST'|'DELETE',path:string,params?:Record<string,string>,idempotencyKey?:string):Promise<any>;
};
export class StripeRequestError extends Error {
  constructor(public status:number,public code:string){super('Stripe request failed');}
}

const SECRET_KEY=/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;
const WEBHOOK_SECRET=/^whsec_[A-Za-z0-9+/=_-]{10,}$/;

export function createCaldockStripe(config:{secretKey:string;webhookSecret:string;allowLive?:boolean;fetch?:StripeFetch;apiBase?:string}):CaldockStripe {
  const match=SECRET_KEY.exec(config.secretKey);
  if(!match)throw new Error('Invalid Stripe secret key format');
  if(!WEBHOOK_SECRET.test(config.webhookSecret))throw new Error('Invalid Stripe webhook secret format');
  const mode=match[2] as 'test'|'live';
  // Live money requires an explicit second switch so a pasted live key cannot go live silently.
  if(mode==='live'&&config.allowLive!==true)throw new Error('Live Stripe keys require CALDOCK_STRIPE_ALLOW_LIVE=true');
  const send=config.fetch||(globalThis.fetch as unknown as StripeFetch);
  const base=config.apiBase||'https://api.stripe.com';
  return {
    mode,webhookSecret:config.webhookSecret,
    async request(method,path,params={},idempotencyKey) {
      const body=new URLSearchParams(params).toString();
      const headers:Record<string,string>={authorization:'Bearer '+config.secretKey,'stripe-version':'2024-06-20'};
      if(method==='POST')headers['content-type']='application/x-www-form-urlencoded';
      if(idempotencyKey)headers['idempotency-key']=idempotencyKey;
      const url=base+path+(method==='GET'&&body?'?'+body:'');
      let response;
      try{response=await send(url,{method,headers,body:method==='POST'?body:undefined});}
      catch{throw new StripeRequestError(502,'STRIPE_UNREACHABLE');}
      const json=await response.json().catch(()=>({}));
      // Never surface Stripe's message text: it can echo request details.
      if(!response.ok)throw new StripeRequestError(response.status,typeof json?.error?.code==='string'?json.error.code.slice(0,80):'STRIPE_ERROR');
      return json;
    },
  };
}

export function stripeFromEnv(env:NodeJS.ProcessEnv):CaldockStripe|undefined {
  if(!env.CALDOCK_STRIPE_SECRET_KEY||!env.CALDOCK_STRIPE_WEBHOOK_SECRET)return undefined;
  return createCaldockStripe({secretKey:env.CALDOCK_STRIPE_SECRET_KEY.trim(),webhookSecret:env.CALDOCK_STRIPE_WEBHOOK_SECRET.trim(),allowLive:env.CALDOCK_STRIPE_ALLOW_LIVE==='true'});
}

// Returns the parsed event only when a v1 signature over the exact raw bytes is valid and fresh.
export function verifyStripeEvent(payload:Buffer,header:string|undefined,secret:string,nowMs=Date.now(),toleranceSeconds=300):any {
  if(!header||header.length>2000)throw new Error('Missing Stripe signature');
  let timestamp=NaN;const signatures:string[]=[];
  for(const part of header.split(',')){
    const index=part.indexOf('=');if(index<1)continue;
    const key=part.slice(0,index).trim(),value=part.slice(index+1).trim();
    if(key==='t')timestamp=Number(value);
    else if(key==='v1'&&/^[0-9a-f]{64}$/.test(value))signatures.push(value);
  }
  if(!Number.isInteger(timestamp)||!signatures.length)throw new Error('Malformed Stripe signature');
  if(Math.abs(nowMs/1000-timestamp)>toleranceSeconds)throw new Error('Stale Stripe signature');
  const expected=createHmac('sha256',secret).update(timestamp+'.').update(payload).digest();
  if(!signatures.some(sig=>{const got=Buffer.from(sig,'hex');return got.length===expected.length&&timingSafeEqual(got,expected);}))throw new Error('Invalid Stripe signature');
  const event=JSON.parse(payload.toString('utf8'));
  if(typeof event?.id!=='string'||typeof event?.type!=='string'||typeof event?.data?.object!=='object')throw new Error('Malformed Stripe event');
  return event;
}

// Test helper and documentation of the scheme.
export function signStripePayload(payload:string,secret:string,timestamp=Math.floor(Date.now()/1000)) {
  return `t=${timestamp},v1=${createHmac('sha256',secret).update(timestamp+'.'+payload).digest('hex')}`;
}

export const STRIPE_RECURRING={
  month:{interval:'month',interval_count:'1'},
  quarter:{interval:'month',interval_count:'3'},
  year:{interval:'year',interval_count:'1'},
} as const;
