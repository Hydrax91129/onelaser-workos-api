import { objectivePlanning, krPlanning } from '../okr.js';
import { assertKrWeight, assertObjectivePoints } from '../okr-weights.js';
import { PUBLIC_USER_COLUMNS } from '../org.js';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Database, Queryable } from '../db.js';
import { cookie, hash, issueSession, oauthCookieName, readCookie, sameSecret, sessionCookieName, type User } from '../auth.js';
import { ApiError, deny } from '../errors.js';
import { createKrTask, isPublished } from '../okr-publish.js';
import { visibleObjective, visibleTask, krProgress } from '../domain.js';
import { DingTalkClient, DingTalkError, type DingTalkProfile } from './dingtalk.js';
import { AiIntegrationError, GrokReviewer, type ReviewInput } from './grok.js';
import { GrokBotAdapter } from './grok-bot.js';
import { registerBotReviewRoutes } from './grok-bot-jobs.js';
import { BotOAuthService, registerBotOAuthRoutes, validatedBotRedirects, type BotOAuthConfig } from './grok-bot-oauth.js';

export type IntegrationOptions = {
  executiveUserIds?: string[];
  managerUserIds?: string[];
  dingtalk?: Pick<DingTalkClient,'authorizationUrl'|'authenticate'|'listDepartmentUsers'|'sendWorkNotification'> & Partial<Pick<DingTalkClient,'getAdditionalUser'>>;
  corpId?: string; appPublicUrl?: string; secureCookies?: boolean; ai?: Pick<GrokReviewer,'model'|'inputHash'|'assess'>;
  aiReviewMode?:'api'|'bot';bot?:GrokBotAdapter;
  botMcpAuthMode?:'bearer'|'oauth';botOAuth?:BotOAuthConfig;
  notificationsEnabled?: boolean; frontendConnected?: boolean; teamMode?:'company'|'department';allowedDepartmentIds?:string[];additionalUserIds?:string[];teamName?:string; setup?: {dingtalkMissing:string[];aiMissing:string[];notificationMissing:string[]};
};
const id=z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const currentUser=(req:FastifyRequest):User=>req.actor||deny(401,'UNAUTHENTICATED','Authentication is required');
const safeUpstream=async<T>(action:()=>Promise<T>)=>{
  try{return await action();}
  catch(error){
    if(error instanceof DingTalkError)deny(error.status,error.code,'DingTalk could not complete the request');
    if(error instanceof AiIntegrationError)deny(error.status,error.code,'AI assessment could not be verified; use human review');
    throw error;
  }
};
async function loadTask(db:Queryable,user:User,taskId:string,lock=false){
  const task=(await db.query('SELECT * FROM tasks WHERE id=$1'+(lock?' FOR UPDATE':''),[taskId])).rows[0];
  if(!visibleTask(user,task))deny(404,'NOT_FOUND','Task not found');return task;
}
async function audit(db:Queryable,user:User,action:string,objectId:string,details:unknown,ownerId=user.id){
  await db.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),user.org_id,user.department_id,ownerId,user.id,action,objectId,JSON.stringify(details)]);
}
async function upsertMember(tx:Queryable,corpId:string,profile:DingTalkProfile,options:IntegrationOptions,mode:'login'|'sync'='login'){
  if(options.teamMode==='company'&&!options.allowedDepartmentIds?.includes(profile.departmentId)&&!options.additionalUserIds?.includes(profile.externalUserId))deny(403,'DINGTALK_DEPARTMENT_FORBIDDEN','DingTalk could not complete the request');
  const departmentId=options.teamMode==='company'?'company':'ding_'+profile.departmentId;
  const departmentName=options.teamMode==='company'?(options.teamName||'OneLaser'):profile.departmentName;
  await tx.query('INSERT INTO departments(org_id,id,external_id,name) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,id) DO UPDATE SET name=excluded.name',[corpId,departmentId,options.teamMode==='company'?'company':profile.departmentId,departmentName]);
  const existing=(await tx.query('SELECT user_id FROM external_identities WHERE provider=$1 AND corp_id=$2 AND external_user_id=$3',['dingtalk',corpId,profile.externalUserId])).rows[0];
  const userId=existing?.user_id||randomUUID();
  // An administrator's "disabled" decision outranks DingTalk: login is refused and sync never reactivates.
  if(existing&&mode==='login'&&(await tx.query('SELECT disabled_at FROM users WHERE id=$1',[userId])).rows[0]?.disabled_at)deny(403,'ACCOUNT_DISABLED','This account has been disabled by an administrator');
  if(existing)await tx.query('UPDATE users SET display_name=$2,department_id=$3,role=COALESCE(role_override,$4),active=(disabled_at IS NULL) WHERE id=$1 AND org_id=$5',[userId,profile.name,departmentId,profile.role,corpId]);
  else{
    await tx.query('INSERT INTO users(id,org_id,department_id,display_name,role) VALUES($1,$2,$3,$4,$5)',[userId,corpId,departmentId,profile.name,profile.role]);
    await tx.query('INSERT INTO external_identities(provider,corp_id,external_user_id,union_id,user_id) VALUES($1,$2,$3,$4,$5)',['dingtalk',corpId,profile.externalUserId,profile.unionId,userId]);
  }
  // DingTalk 职位/办公地点 fill the profile by default and follow DingTalk changes; a value someone edited in WorkOS is kept.
  if(profile.title!==undefined||profile.workPlace!==undefined)await tx.query(`UPDATE users SET
    title=CASE WHEN $2<>'' AND (title='' OR title=dingtalk_title) THEN $2 ELSE title END, dingtalk_title=CASE WHEN $2<>'' THEN $2 ELSE dingtalk_title END,
    location=CASE WHEN $3<>'' AND (location='' OR location=dingtalk_location) THEN $3 ELSE location END, dingtalk_location=CASE WHEN $3<>'' THEN $3 ELSE dingtalk_location END
    WHERE id=$1`,[userId,profile.title||'',profile.workPlace||'']);
  await tx.query('UPDATE external_identities SET union_id=$4,external_department_id=$5,external_department_name=$6 WHERE provider=$1 AND corp_id=$2 AND external_user_id=$3',['dingtalk',corpId,profile.externalUserId,profile.unionId,profile.departmentId,profile.departmentName]);
  return (await tx.query<User>('SELECT * FROM users WHERE id=$1',[userId])).rows[0];
}
export function integrationOptionsFromEnv(env:NodeJS.ProcessEnv):IntegrationOptions {
  const additionalUserIds=[...new Set((env.DINGTALK_ADDITIONAL_USER_IDS||'').split(',').map(x=>x.trim()).filter(Boolean))];
  const managerUserIds=[...new Set((env.DINGTALK_MANAGER_USER_IDS||'').split(',').map(x=>x.trim()).filter(Boolean))];
  if(additionalUserIds.length&&env.WORKOS_TEAM_MODE!=='company')throw new DingTalkError('DINGTALK_CONFIGURATION_INVALID',503);
  const publicUrl=env.APP_PUBLIC_URL||env.RENDER_EXTERNAL_URL;
  if(publicUrl){const url=new URL(publicUrl);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||(url.protocol!=='https:'&&!(env.NODE_ENV!=='production'&&url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))throw new Error('APP_PUBLIC_URL must be an application origin');}
  const required=['DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_CORP_ID','DINGTALK_ALLOWED_DEPARTMENT_IDS','DINGTALK_MANAGER_USER_IDS'];
  const dingtalkMissing=required.filter(key=>!env[key]?.trim());if(!publicUrl)dingtalkMissing.push('APP_PUBLIC_URL');
  let dingtalk:DingTalkClient|undefined;
  if(!dingtalkMissing.length){
    dingtalk=new DingTalkClient({clientId:env.DINGTALK_CLIENT_ID!,clientSecret:env.DINGTALK_CLIENT_SECRET!,corpId:env.DINGTALK_CORP_ID!,agentId:env.DINGTALK_AGENT_ID,
      allowedDepartmentIds:(env.DINGTALK_ALLOWED_DEPARTMENT_IDS||'').split(',').map(x=>x.trim()).filter(Boolean),additionalUserIds,managerUserIds,redirectUri:env.DINGTALK_REDIRECT_URI||new URL('/api/auth/dingtalk/callback',publicUrl!).toString()});
  }
  if(env.AI_REVIEW_MODE&&!['api','bot'].includes(env.AI_REVIEW_MODE))throw new Error('Invalid AI review mode');
  const aiReviewMode=env.AI_REVIEW_MODE==='bot'?'bot':'api';
  if(env.GROK_BOT_MCP_AUTH_MODE&&!['bearer','oauth'].includes(env.GROK_BOT_MCP_AUTH_MODE))throw new Error('Invalid Bot MCP auth mode');
  const botMcpAuthMode=env.GROK_BOT_MCP_AUTH_MODE==='oauth'?'oauth':'bearer';
  const key=env.AI_PROVIDER_API_KEY||env.XAI_API_KEY;let ai:GrokReviewer|undefined,bot:GrokBotAdapter|undefined;
  const botOrgId=env.GROK_BOT_ORG_ID||env.DINGTALK_CORP_ID;
  const transportMissing=['GROK_BOT_WEBHOOK_URL','GROK_BOT_WEBHOOK_SECRET','GROK_BOT_WEBHOOK_ALLOWED_HOST',...(botMcpAuthMode==='bearer'?['GROK_BOT_WORKER_TOKEN']:[])].filter(name=>!env[name]?.trim());
  const botMissing=[...transportMissing];
  if(!botOrgId?.trim())botMissing.push('GROK_BOT_ORG_ID');
  const redirectUris=botMcpAuthMode==='oauth'?validatedBotRedirects(env.GROK_BOT_OAUTH_REDIRECT_URIS):[];
  const botOAuth:BotOAuthConfig|undefined=botMcpAuthMode==='oauth'?{publicUrl,orgId:botOrgId,redirectUris,secureCookies:env.NODE_ENV==='production',preRegisteredClientId:env.GROK_BOT_OAUTH_PRE_REGISTERED_CLIENT_ID||undefined}:undefined;
  if(botMcpAuthMode==='oauth'){if(!redirectUris.length)botMissing.push('GROK_BOT_OAUTH_REDIRECT_URIS');if(!publicUrl)botMissing.push('APP_PUBLIC_URL');}
  if(aiReviewMode==='bot'&&!transportMissing.length&&botOrgId?.trim())bot=new GrokBotAdapter({webhookUrl:env.GROK_BOT_WEBHOOK_URL!,webhookSecret:env.GROK_BOT_WEBHOOK_SECRET!,allowedHost:env.GROK_BOT_WEBHOOK_ALLOWED_HOST!,workerToken:botMcpAuthMode==='bearer'?env.GROK_BOT_WORKER_TOKEN:undefined,orgId:botOrgId});
  if(aiReviewMode==='api'&&key&&env.AI_MODEL_ID){ai=new GrokReviewer({apiKey:key,model:env.AI_MODEL_ID,baseUrl:env.AI_PROVIDER_BASE_URL,timeoutMs:Number(env.AI_REVIEW_TIMEOUT_MS)||45000});}
  return {additionalUserIds,managerUserIds,executiveUserIds:(env.WORKOS_EXECUTIVE_USER_IDS||'').split(',').map(x=>x.trim()).filter(Boolean),teamMode:env.WORKOS_TEAM_MODE==='company'?'company':'department',teamName:env.WORKOS_TEAM_NAME||'OneLaser',allowedDepartmentIds:(env.DINGTALK_ALLOWED_DEPARTMENT_IDS||'').split(',').map(x=>x.trim()).filter(Boolean),dingtalk,corpId:env.DINGTALK_CORP_ID,appPublicUrl:publicUrl,secureCookies:env.NODE_ENV==='production',ai,aiReviewMode,bot,botMcpAuthMode,botOAuth,notificationsEnabled:env.DINGTALK_NOTIFICATIONS_ENABLED==='true'&&!!env.DINGTALK_AGENT_ID,frontendConnected:env.FRONTEND_CONNECTED==='true',setup:{dingtalkMissing,aiMissing:aiReviewMode==='bot'?botMissing:[...(!key?['AI_PROVIDER_API_KEY']:[]),...(!env.AI_MODEL_ID?['AI_MODEL_ID']:[])],notificationMissing:[...(!env.DINGTALK_AGENT_ID?['DINGTALK_AGENT_ID']:[]),...(env.DINGTALK_NOTIFICATIONS_ENABLED!=='true'?['DINGTALK_NOTIFICATIONS_ENABLED']:[])]}};
}
export async function registerIntegrationRoutes(app:FastifyInstance,db:Database,options:IntegrationOptions){
  const secure=options.secureCookies===true,sessionName=sessionCookieName(secure),nonceName=oauthCookieName(secure);
  app.get('/auth/csrf',async req=>{
    currentUser(req);const token=req.sessionToken!;
    let row=(await db.query('SELECT csrf_token FROM sessions WHERE token_hash=$1',[hash(token)])).rows[0];
    if(!row?.csrf_token){const value=randomBytes(32).toString('base64url');await db.query('UPDATE sessions SET csrf_token=$2 WHERE token_hash=$1 AND csrf_token IS NULL',[hash(token),value]);row=(await db.query('SELECT csrf_token FROM sessions WHERE token_hash=$1',[hash(token)])).rows[0];}
    if(!row?.csrf_token)deny(401,'UNAUTHENTICATED','Authentication is required');return {csrfToken:row.csrf_token};
  });
  const limits=new Map<string,{count:number,until:number}>();
  function limited(key:string,max:number,windowMs:number){
    const now=Date.now();if(limits.size>=2000)for(const [k,v]of limits)if(v.until<=now)limits.delete(k);
    let value=limits.get(key);if(!value||value.until<=now){if(limits.size>=2000)deny(429,'RATE_LIMITED','Too many requests; try again later');value={count:0,until:now+windowMs};limits.set(key,value);}
    value.count++;if(value.count>max)deny(429,'RATE_LIMITED','Too many requests; try again later');
  }
  const oauth=options.aiReviewMode==='bot'&&options.botMcpAuthMode==='oauth'?new BotOAuthService(db,{...(options.botOAuth||{publicUrl:options.appPublicUrl,orgId:options.corpId,redirectUris:[]}),secureCookies:secure}):undefined;
  await oauth?.initialize();
  const resumeConsent=async(requestId:string,header:string|undefined)=>{if(!oauth)deny(400,'OAUTH_STATE_INVALID','Login expired or could not be verified');try{return await oauth.resume(requestId,header);}catch{deny(400,'OAUTH_STATE_INVALID','Login expired or could not be verified');}};
  await registerBotOAuthRoutes(app,db,oauth);
  const botJobs=await registerBotReviewRoutes(app,db,options.aiReviewMode==='bot'?options.bot:undefined,options.appPublicUrl,user=>limited('ai-user:'+user.id,5,60000),{mode:options.botMcpAuthMode,oauth});
  app.get('/auth/dingtalk/start',async(req,reply)=>{
    limited('oauth:'+req.ip,30,60000);
    if(!options.dingtalk||!options.corpId||!options.appPublicUrl)deny(501,'DINGTALK_NOT_CONFIGURED','Real DingTalk authentication is not integrated');
    const query=z.object({destination:z.literal('caldock-studio').optional(),lang:z.enum(['zh','en']).optional(),oauth_request:z.string().optional()}).passthrough().parse(req.query);
    const returnRequest=query.oauth_request;
    if(query.destination&&returnRequest!==undefined)deny(400,'OAUTH_STATE_INVALID','Login destination is ambiguous');
    if(query.destination&&!options.allowedDepartmentIds?.length&&!(options.teamMode==='company'&&options.additionalUserIds?.length))deny(501,'DINGTALK_NOT_CONFIGURED','Studio DingTalk membership scope is not configured');
    if(returnRequest!==undefined){if(typeof returnRequest!=='string')deny(400,'OAUTH_STATE_INVALID','Login expired or could not be verified');await resumeConsent(returnRequest,req.headers.cookie);}
    const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url');
    await db.query('DELETE FROM oauth_states WHERE expires_at<now()');
    await db.query('INSERT INTO oauth_states(state_hash,nonce_hash,expires_at,return_request_id,return_destination,return_language) VALUES($1,$2,$3,$4,$5,$6)',[hash(state),hash(nonce),new Date(Date.now()+600000).toISOString(),returnRequest||null,query.destination||null,query.destination?(query.lang||'zh'):null]);
    reply.header('Set-Cookie',cookie(nonceName,nonce,secure,600));
    return reply.redirect(options.dingtalk.authorizationUrl(state));
  });
  const callback=async(req:FastifyRequest,reply:any)=>{
    if(!options.dingtalk||!options.corpId||!options.appPublicUrl)deny(501,'DINGTALK_NOT_CONFIGURED','Real DingTalk authentication is not integrated');
    const input=z.object({state:z.string().regex(/^[A-Za-z0-9_-]{43}$/),authCode:z.string().min(1).max(2048)}).passthrough().parse(req.method==='POST'?req.body:req.query);
    const nonce=readCookie(req.headers.cookie,nonceName);
    if(!nonce)deny(400,'OAUTH_STATE_INVALID','Login expired or could not be verified');
    const returnState=await db.transaction(async tx=>{
      const state=(await tx.query('SELECT * FROM oauth_states WHERE state_hash=$1 AND expires_at>now() FOR UPDATE',[hash(input.state)])).rows[0];
      if(!state||!sameSecret(state.nonce_hash,hash(nonce)))deny(400,'OAUTH_STATE_INVALID','Login expired or could not be verified');
      await tx.query('DELETE FROM oauth_states WHERE state_hash=$1',[hash(input.state)]);
      return {request:state.return_request_id as string|null,destination:state.return_destination as string|null,language:state.return_language as string|null};
    });
    // Only the nonce-bound server record chooses a destination. Callback query
    // parameters can neither introduce a return URL nor alter its language.
    const target=returnState.request?await resumeConsent(returnState.request,req.headers.cookie):returnState.destination==='caldock-studio'
      ?new URL('/decision-studio/?tab=team&lang='+(returnState.language==='en'?'en':'zh'),options.appPublicUrl).toString():options.appPublicUrl;
    const profile=await safeUpstream(()=>options.dingtalk!.authenticate(input.authCode));
    let session;
    try{session=await db.transaction(async tx=>{
      const user=await upsertMember(tx,options.corpId!,profile,options);return issueSession(tx,user.id);
    });}catch(error){
      if(error instanceof ApiError&&error.code==='ACCOUNT_DISABLED'){reply.header('Set-Cookie',cookie(nonceName,'',secure,0));return reply.redirect(new URL('/?login_error=disabled#overview',options.appPublicUrl).toString());}
      throw error;
    }
    reply.header('Set-Cookie',[cookie(nonceName,'',secure,0),cookie(sessionName,session.accessToken,secure)]);
    return reply.redirect(target);
  };
  app.get('/auth/dingtalk/callback',callback);app.post('/auth/dingtalk/callback',callback);
  app.get('/directory',async req=>{const user=currentUser(req);
    const items=(await db.query(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE org_id=$1 AND department_id=$2 AND active=true ORDER BY display_name,id`,[user.org_id,user.department_id])).rows;
    // Managers outside the department who manage someone in it may review that person's tasks.
    const outside=(await db.query(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE org_id=$1 AND active=true AND department_id<>$2 AND id IN (SELECT manager_id FROM users WHERE org_id=$1 AND department_id=$2 AND active=true AND manager_id IS NOT NULL) ORDER BY display_name,id`,[user.org_id,user.department_id])).rows;
    // Former members keep their name on historical tasks (shown as "disabled").
    const former=(await db.query('SELECT id,display_name,department_id FROM users WHERE org_id=$1 AND department_id=$2 AND active=false ORDER BY display_name,id',[user.org_id,user.department_id])).rows;
    return {items,reviewers:outside.map((u:any)=>({...u,outsideDepartment:true})),former:former.map((u:any)=>({...u,active:false}))};});
  app.get('/departments',async req=>{const user=currentUser(req);return {items:(await db.query('SELECT id,name FROM departments WHERE org_id=$1 AND id=$2',[user.org_id,user.department_id])).rows};});
  app.post('/integrations/dingtalk/sync',async req=>{
    const user=currentUser(req);if(user.role!=='manager')deny(403,'FORBIDDEN','A designated manager must review evidence');
    if(!options.dingtalk||!options.corpId||user.org_id!==options.corpId)deny(501,'DINGTALK_NOT_CONFIGURED','Real DingTalk authentication is not integrated');
    const department=(await db.query('SELECT external_id FROM departments WHERE org_id=$1 AND id=$2',[user.org_id,user.department_id])).rows[0];
    if(!department)deny(400,'DIRECTORY_SCOPE_INVALID','Department synchronization is unavailable');
    const externalDepartments=options.teamMode==='company'?(options.allowedDepartmentIds||[]):[department.external_id];
    if(!externalDepartments.length)deny(400,'DIRECTORY_SCOPE_INVALID','Department synchronization is unavailable');
    const allProfiles:DingTalkProfile[]=[];
    for(const externalDepartment of externalDepartments)allProfiles.push(...await safeUpstream(()=>options.dingtalk!.listDepartmentUsers(externalDepartment)));
    if(options.teamMode==='company')for(const externalUserId of new Set(options.additionalUserIds||[])){
      if(!options.dingtalk.getAdditionalUser)deny(503,'DINGTALK_CONFIGURATION_INVALID','DingTalk could not complete the request');
      allProfiles.push(await safeUpstream(()=>options.dingtalk!.getAdditionalUser!(externalUserId)));
    }
    const profiles=[...new Map(allProfiles.map(profile=>[profile.externalUserId,profile])).values()];
    // A small company can use one internal workspace after enterprise membership checks.
    const sameDepartment=options.teamMode==='company'?profiles:profiles.filter(p=>'ding_'+p.departmentId===user.department_id);
    await db.transaction(async tx=>{
      for(const profile of sameDepartment)await upsertMember(tx,options.corpId!,profile,options,'sync');
      const externalIds=sameDepartment.map(p=>p.externalUserId);
      const missing=(await tx.query('SELECT u.id,e.external_user_id FROM users u JOIN external_identities e ON e.user_id=u.id WHERE u.org_id=$1 AND u.department_id=$2 AND e.provider=$3',[user.org_id,user.department_id,'dingtalk'])).rows.filter(r=>!externalIds.includes(r.external_user_id));
      for(const member of missing)await tx.query('UPDATE users SET active=false WHERE id=$1',[member.id]);
      await audit(tx,user,'directory.synchronized',user.department_id,{members:sameDepartment.length,deactivated:missing.length});
    });
    return {synchronized:sameDepartment.length,departmentId:user.department_id};
  });
  const objectiveInput=z.object({title:z.string().trim().min(1).max(300),level:z.enum(['personal','department']),ownerId:id.optional(),planning:objectivePlanning.optional(),parentObjectiveId:id.optional()}).strict();
  app.post('/objectives',async(req,reply)=>{
    const user=currentUser(req),input=objectiveInput.parse(req.body),ownerId=input.ownerId||user.id;
    if(user.role!=='manager'&&(input.level!=='personal'||ownerId!==user.id))deny(403,'FORBIDDEN','Employees can create tasks only for themselves');
    const owner=(await db.query<User>('SELECT * FROM users WHERE id=$1 AND active=true',[ownerId])).rows[0];
    if(!owner||owner.org_id!==user.org_id||owner.department_id!==user.department_id)deny(400,'INVALID_OWNER','Owner must be an active member of the current department');
    if(input.parentObjectiveId){const parent=(await db.query('SELECT * FROM objectives WHERE id=$1 AND archived_at IS NULL',[input.parentObjectiveId])).rows[0];if(!visibleObjective(user,parent))deny(400,'INVALID_PARENT','Select a visible objective to align with');}
    const result=await db.transaction(async tx=>{await assertObjectivePoints(tx,{org_id:user.org_id,owner_id:ownerId,level:input.level,period:input.planning?.period},input.planning?.weight);const objective=(await tx.query('INSERT INTO objectives(id,org_id,department_id,owner_id,level,title,planning,parent_objective_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),user.org_id,user.department_id,ownerId,input.level,input.title,JSON.stringify(input.planning||{}),input.parentObjectiveId||null])).rows[0];await audit(tx,user,'objective.created',objective.id,{},ownerId);return objective;});
    return reply.code(201).send(result);
  });
  const krInput=z.object({title:z.string().trim().min(1).max(300),baseline:z.number().finite(),target:z.number().finite(),actual:z.number().finite().optional(),direction:z.enum(['increase','decrease']),unit:z.string().trim().min(1).max(30),planning:krPlanning.optional()}).strict();
  app.post<{Params:{id:string}}>('/objectives/:id/key-results',async(req,reply)=>{
    const user=currentUser(req),input=krInput.parse(req.body),objectiveId=id.parse(req.params.id);
    const objective=(await db.query('SELECT * FROM objectives WHERE id=$1 AND archived_at IS NULL',[objectiveId])).rows[0];
    if(!visibleObjective(user,objective)||objective.department_id!==user.department_id||(user.role!=='manager'&&(objective.level!=='personal'||objective.owner_id!==user.id)))deny(404,'NOT_FOUND','Key result not found');
    if(krProgress({...input,actual:input.actual??input.baseline})===null)deny(400,'METRIC_INVALID','Metric target must differ from baseline in the declared direction');
    const result=await db.transaction(async tx=>{await assertKrWeight(tx,objectiveId,input.planning?.weight);const kr=(await tx.query('INSERT INTO key_results(id,objective_id,title,baseline,target,actual,direction,unit,planning) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[randomUUID(),objectiveId,input.title,input.baseline,input.target,input.actual??input.baseline,input.direction,input.unit,JSON.stringify(input.planning||{})])).rows[0];await audit(tx,user,'kr.created',kr.id,{},objective.owner_id||user.id);
      // Key results become tasks when the OKR is published; once it is published (a leader adding a KR), right away.
      // (Objectives without a monthly cycle have no publish step and keep creating tasks right away.)
      if(!objective.planning?.period||await isPublished(tx,objective.org_id,objective.owner_id,objective.planning.period))await createKrTask(tx,user,objective,kr);
      return {...kr,progress:krProgress(kr)};});return reply.code(201).send(result);
  });
  app.get<{Params:{id:string}}>('/tasks/:id/evaluations',async req=>{const task=await loadTask(db,currentUser(req),id.parse(req.params.id));return {items:(await db.query('SELECT * FROM ai_evaluations WHERE task_id=$1 ORDER BY created_at DESC,id',[task.id])).rows};});
  const runningAssessments=new Map<string,Promise<unknown>>();
  app.post<{Params:{id:string}}>('/tasks/:id/analyze',async(req,reply)=>{
    const user=currentUser(req),task=await loadTask(db,user,id.parse(req.params.id));
    if(options.aiReviewMode==='bot'){
      if(!botJobs||(options.botMcpAuthMode==='oauth'&&!oauth?.configured))deny(501,'AI_NOT_CONFIGURED','AI evidence assessment is not integrated; use human review');
      const result=await botJobs.analyze(user,task.id,req.language);return reply.code(result.statusCode).send(result.body);
    }
    if(!options.ai)deny(501,'AI_NOT_CONFIGURED','AI evidence assessment is not integrated; use human review');
    if(!task.submission_version)deny(400,'EVIDENCE_REQUIRED','Submit evidence before requesting assessment');
    const submission=(await db.query('SELECT * FROM submissions WHERE task_id=$1 AND version=$2',[task.id,task.submission_version])).rows[0];
    const input:ReviewInput={taskId:task.id,submissionVersion:task.submission_version,title:task.title,description:task.description,criteria:task.criteria,submission:{id:submission.id,title:submission.title,description:submission.description,evidenceUrl:submission.evidence_url},language:req.language};
    const inputHash=options.ai.inputHash(input),key=task.id+':'+task.submission_version+':'+inputHash;
    const cached=(await db.query('SELECT * FROM ai_evaluations WHERE task_id=$1 AND submission_version=$2 AND input_hash=$3 AND model=$4',[task.id,task.submission_version,inputHash,options.ai.model])).rows[0];
    if(cached)return {evaluation:cached,cached:true};
    if(runningAssessments.has(key))return runningAssessments.get(key);
    limited('ai-user:'+user.id,5,60000);limited('ai-org:'+user.org_id,50,3600000);
    const promise=(async()=>{
      const result=await safeUpstream(()=>options.ai!.assess(input));
      const evaluation=await db.transaction(async tx=>{
        const current=await loadTask(tx,user,task.id,true);
        if(current.submission_version!==task.submission_version)deny(409,'VERSION_CONFLICT','Review must match the currently submitted version');
        const status=result.criteria.some(c=>c.finding==='insufficient_evidence')?'needs_more_evidence':'ready_for_human_review';
        const row=(await tx.query('INSERT INTO ai_evaluations(id,task_id,submission_version,status,model,input_hash,result,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(task_id,submission_version,model,input_hash) DO UPDATE SET result=excluded.result RETURNING *',[randomUUID(),task.id,task.submission_version,status,options.ai!.model,inputHash,JSON.stringify(result),user.id])).rows[0];
        await audit(tx,user,'evidence.assessed',task.id,{submissionVersion:task.submission_version,evaluationId:row.id},task.owner_id);return row;
      });return {evaluation,cached:false};
    })();runningAssessments.set(key,promise);
    try{return reply.send(await promise);}finally{runningAssessments.delete(key);}
  });
  app.post('/notifications/send',async req=>{
    const user=currentUser(req);if(user.role!=='manager')deny(403,'FORBIDDEN','A designated manager must review evidence');
    if(!options.notificationsEnabled||!options.dingtalk||!options.corpId||user.org_id!==options.corpId)deny(501,'NOTIFICATIONS_NOT_CONFIGURED','Notification delivery is not integrated; no message was sent');
    const input=z.object({taskIds:z.array(id).min(1).max(20),idempotencyKey:z.string().uuid()}).strict().parse(req.body);
    const grouped=new Map<string,any[]>();
    for(const taskId of [...new Set(input.taskIds)].sort()){const task=await loadTask(db,user,taskId);const list=grouped.get(task.owner_id)||[];list.push(task);grouped.set(task.owner_id,list);}
    // Validate all recipients and mappings before dispatching any notification.
    const deliveries: {recipientId:string;externalId:string;content:string}[]=[];
    for(const [recipientId,tasks]of grouped){
      const identity=(await db.query('SELECT e.external_user_id FROM external_identities e JOIN users u ON u.id=e.user_id WHERE e.provider=$1 AND e.corp_id=$2 AND u.id=$3 AND u.org_id=$2 AND u.department_id=$4 AND u.active=true',['dingtalk',options.corpId,recipientId,user.department_id])).rows[0];
      if(!identity)deny(400,'NOTIFICATION_RECIPIENT_UNAVAILABLE','A notification recipient is unavailable');
      const content=(req.language==='en'?'OneLaser task reminder\n':'OneLaser 任务提醒\n')+tasks.map(t=>`• ${t.title}\n${new Date(t.due_at).toISOString()} · ${t.status}`).join('\n')+`\n${options.appPublicUrl||''}`;
      if(content.length>4000)deny(400,'NOTIFICATION_TOO_LARGE','Notification is too long; select fewer tasks');
      deliveries.push({recipientId,externalId:identity.external_user_id,content});
    }
    const requestHash=createHash('sha256').update(JSON.stringify(deliveries.map(d=>({recipientId:d.recipientId,content:d.content})))).digest('hex');
    await db.query('INSERT INTO notification_requests(org_id,requested_by,request_key,payload_hash) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[user.org_id,user.id,input.idempotencyKey,requestHash]);
    const existingRequest=(await db.query('SELECT payload_hash FROM notification_requests WHERE org_id=$1 AND requested_by=$2 AND request_key=$3',[user.org_id,user.id,input.idempotencyKey])).rows[0];
    if(existingRequest.payload_hash!==requestHash)deny(409,'IDEMPOTENCY_CONFLICT','This notification key was already used for different content');
    const notifications=[];
    for(const delivery of deliveries){
      const payloadHash=createHash('sha256').update(delivery.content).digest('hex');
      const proposedId=randomUUID();
      const inserted=(await db.query('INSERT INTO notification_deliveries(id,org_id,department_id,requested_by,request_key,recipient_id,payload_hash,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING *',[proposedId,user.org_id,user.department_id,user.id,input.idempotencyKey,delivery.recipientId,payloadHash,'pending'])).rows[0];
      let row=inserted||(await db.query('SELECT * FROM notification_deliveries WHERE org_id=$1 AND requested_by=$2 AND request_key=$3 AND recipient_id=$4',[user.org_id,user.id,input.idempotencyKey,delivery.recipientId])).rows[0];
      if(row.payload_hash!==payloadHash)deny(409,'IDEMPOTENCY_CONFLICT','This notification key was already used for different content');
      if(inserted){
        try{const result=await options.dingtalk.sendWorkNotification([delivery.externalId],delivery.content);row=(await db.query('UPDATE notification_deliveries SET status=$2,provider_task_id=$3 WHERE id=$1 RETURNING *',[row.id,'queued',result.taskId])).rows[0];}
        catch{row=(await db.query('UPDATE notification_deliveries SET status=$2 WHERE id=$1 RETURNING *',[row.id,'unknown'])).rows[0];}
        await audit(db,user,'notification.requested',row.id,{status:row.status,providerTaskId:row.provider_task_id},delivery.recipientId);
      }
      notifications.push({id:row.id,status:row.status,providerTaskId:row.provider_task_id});
    }
    return {accepted:notifications.every(n=>n.status==='queued'),sent:false,status:notifications.every(n=>n.status==='queued')?'queued':'unknown',notifications};
  });
}
