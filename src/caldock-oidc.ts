import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { timingSafeEqual } from 'node:crypto';

export type CaldockProvider = 'google' | 'apple';
export type CaldockIdentity = { provider: CaldockProvider; subject: string; email: string | null; name: string };
type Flow = { state: string; nonce: string; challenge: string; redirectUri: string };
type Exchange = { code: string; nonce: string; verifier: string; redirectUri: string };
export interface CaldockGateway {
  authorizationUrl(flow: Flow): string;
  authenticate(exchange: Exchange): Promise<CaldockIdentity>;
}
const endpoints = {
  google: { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs', issuer: ['https://accounts.google.com','accounts.google.com'] },
  apple: { authorize: 'https://appleid.apple.com/auth/authorize', token: 'https://appleid.apple.com/auth/token', jwks: 'https://appleid.apple.com/auth/keys', issuer: 'https://appleid.apple.com' },
};
export async function verifyCaldockIdentity(token: string, provider: CaldockProvider, clientId: string, nonce: string, key: JWTVerifyGetKey): Promise<CaldockIdentity> {
  const { payload } = await jwtVerify(token,key,{ algorithms:['RS256'], issuer:endpoints[provider].issuer, audience:clientId, requiredClaims:['sub','iat','exp','nonce'], maxTokenAge:'10m', clockTolerance:5 });
  if(typeof payload.nonce!=='string'||payload.nonce.length!==nonce.length||!timingSafeEqual(Buffer.from(payload.nonce),Buffer.from(nonce))) throw new Error('Invalid identity nonce');
  if(typeof payload.sub!=='string'||!payload.sub||payload.sub.length>255) throw new Error('Invalid identity subject');
  const email = typeof payload.email==='string'&&payload.email.length<=320 ? payload.email : null;
  // Never trust unverified email for display or account association; subject is identity.
  if(email&&payload.email_verified!==true&&payload.email_verified!=='true') throw new Error('Email not verified');
  const name=typeof payload.name==='string'?payload.name.replace(/[\u0000-\u001f]/g,'').trim().slice(0,100):'wodeMac user';
  return { provider, subject:payload.sub, email, name:name||'wodeMac user' };
}
export function createCaldockGateway(provider: CaldockProvider, config: { clientId:string; clientSecret?:string; teamId?:string; keyId?:string; privateKey?:string }): CaldockGateway {
  const keys=createRemoteJWKSet(new URL(endpoints[provider].jwks),{timeoutDuration:5000});
  return {
    authorizationUrl(flow) {
      const url=new URL(endpoints[provider].authorize);
      for(const [key,value] of Object.entries({client_id:config.clientId,redirect_uri:flow.redirectUri,response_type:'code',scope:provider==='google'?'openid email profile':'name email',state:flow.state,nonce:flow.nonce})) url.searchParams.set(key,value);
      if(provider==='google') {url.searchParams.set('code_challenge',flow.challenge);url.searchParams.set('code_challenge_method','S256');}
      else url.searchParams.set('response_mode','form_post');
      return url.toString();
    },
    async authenticate(exchange) {
      let secret=config.clientSecret;
      if(provider==='apple') {
        const key=await importPKCS8(config.privateKey!.replaceAll('\\n','\n'),'ES256');
        secret=await new SignJWT({}).setProtectedHeader({alg:'ES256',kid:config.keyId!}).setIssuer(config.teamId!).setSubject(config.clientId).setAudience('https://appleid.apple.com').setIssuedAt().setExpirationTime('5m').sign(key);
      }
      const form=new URLSearchParams({grant_type:'authorization_code',code:exchange.code,client_id:config.clientId,client_secret:secret!,redirect_uri:exchange.redirectUri});
      if(provider==='google') form.set('code_verifier',exchange.verifier);
      const response=await fetch(endpoints[provider].token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(8000),redirect:'error'});
      const text=await response.text();
      if(!response.ok||text.length>32000) throw new Error('Provider token exchange failed');
      const result=JSON.parse(text);
      if(typeof result.id_token!=='string'||result.id_token.length>16000) throw new Error('Missing provider identity token');
      return verifyCaldockIdentity(result.id_token,provider,config.clientId,exchange.nonce,keys);
    },
  };
}
