import { registerCaldockStudio, type StudioOptions } from './caldock-studio.js';
import { registerTaskBoardRoutes, validateBoardCreation, applyAutoStatus } from './task-board.js';
import { registerCaldockRoutes, type CaldockOptions } from './caldock.js';
import { registerDealerRoutes, type DealerOptions } from './dealer.js';
import { registerDealerAdminRoutes } from './dealer-admin.js';
import { registerSupportRoutes, supportPermissions, type SupportOptions } from './support.js';
import { registerPublicWikiRoutes, PUBLIC_WIKI_PATHS, type PublicWikiOptions } from './public-wiki.js';
import { registerShopifyRoutes, type ShopifyOptions } from './shopify.js';
import { registerOkrRoutes } from './okr.js';
import { registerOkrCollabRoutes } from './okr-collab.js';
import { registerCompletionRoutes, jsonModel, type JsonModel } from './completions.js';
import { registerTranslateRoutes } from './translate.js';
import { registerOkrAiRoutes } from './okr-ai.js';
import { registerAssignRoutes, TASK_SOURCE_COLUMNS } from './assign.js';
import { registerOkrScoreRoutes, scoresFor, canLeadScore } from './okr-scores.js';
import { registerProjectRoutes } from './projects.js';
import { registerWmsRoutes } from './wms.js';
import { registerRmaRoutes } from './rma.js';
import { registerHrRoutes, type HrOptions } from './hr.js';
import { registerItRoutes, type ItOptions } from './it-accounts.js';
import { registerQualityRoutes, qualityFactoryOf, factoryPathAllowed, type QualityOptions } from './quality.js';
import { registerProductRoutes } from './products.js';
import { registerInboxRoutes, pushInbox, taskFollowers } from './inbox.js';
import { registerFeedbackRoutes } from './feedback.js';
import { registerOkrCycle } from './okr-cycle.js';
import { registerOkrPublish } from './okr-publish.js';
import { registerMemberRoutes, isPublicMemberPath, mailerFromEnv, type Mailer } from './members.js';
import { registerOrgRoutes, isAdmin as isOrgAdmin } from './org.js';
import { executiveSummary } from './executive.js';
import Fastify, { type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { Database, Queryable } from './db.js';
import { cookie, hash, issueSession, readCookie, resolveSession, sameSecret, sessionCookieName, type User } from './auth.js';
import { visibleObjective, visibleTask, attachReportingScope, krProgress, hasKrMetric, reviewerAllowed } from './domain.js';
import { attachOkrImportMetadata } from './okr-import.js';
import { languageFrom, message, type Language } from './i18n.js';
import { ApiError, deny } from './errors.js';
import { registerIntegrationRoutes, type IntegrationOptions } from './integrations/routes.js';
import { BOT_OAUTH_PREFIX, BOT_OAUTH_WELL_KNOWN } from './integrations/grok-bot-oauth.js';

declare module 'fastify' { interface FastifyRequest { actor: User | null; language: Language; sessionToken: string | null; cookieAuthenticated: boolean } }
const identifier = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const expectedVersion = z.number().int().min(1);
const evidenceUrl = z.string().max(2000).url().refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password;
}, 'Only HTTPS URLs without embedded credentials are allowed');
const taskInput = z.object({
  title: z.string().trim().min(3).max(200), description: z.string().trim().max(10000).default(''),
  ownerId: identifier, reviewerId: identifier.optional(), criteria: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  dueAt: z.string().datetime({ offset: true }), krId: identifier.optional(), boardGroupId:identifier.optional(), boardPriority:z.string().max(80).optional(), boardCategory:z.string().max(80).optional(), parentTaskId:identifier.optional()
}).strict();
const submissionInput = z.object({ expectedVersion, title:z.string().trim().min(1).max(200).optional(), description:z.string().trim().min(2).max(30000), evidenceUrl:evidenceUrl.optional(), attachmentIds:z.array(identifier).max(10).optional() }).strict();
/** A submission needs only its progress note (files are attached to the task); the title defaults to the note's first line. */
const submissionTitle=(t:string|undefined,d:string)=>{if(t)return t;const first=(d.split(/\r?\n/).find(l=>l.trim())||d).trim();return first.length>60?first.slice(0,60)+'…':first;};
const reviewInput = z.object({ expectedVersion, submissionVersion:z.number().int().min(1), decision:z.enum(['accept','return']), quality:z.number().int().min(0).max(10).optional(), note:z.string().trim().min(5).max(4000), verifiedCurrentSubmission:z.boolean().optional() }).strict();
const measurementInput = z.object({ expectedVersion, actual:z.number().finite(), source:z.string().trim().min(3).max(2000), note:z.string().trim().min(5).max(4000) }).strict();
/** Besides the department rules, a person may read the OKRs of everyone in their reporting line,
 * of peers who share their manager, and administrators read everyone's. Writing keeps the stricter rules. */
async function okrListOwners(db:Database,user:User,executiveUserIds:string[]){
  const rows=(await db.query('SELECT id,manager_id FROM users WHERE org_id=$1 AND active=true',[user.org_id])).rows as {id:string;manager_id:string|null}[];
  if(isOrgAdmin(user as any,{executiveUserIds}))return new Set(rows.map(r=>r.id));
  const out=new Set<string>(),children=new Map<string,string[]>();for(const r of rows)if(r.manager_id){if(!children.has(r.manager_id))children.set(r.manager_id,[]);children.get(r.manager_id)!.push(r.id);}
  const queue=[...(children.get(user.id)||[])];while(queue.length){const c=queue.shift()!;if(out.has(c))continue;out.add(c);queue.push(...(children.get(c)||[]));}
  const mine=rows.find(r=>r.id===user.id)?.manager_id;if(mine)for(const r of rows)if(r.manager_id===mine&&r.id!==user.id)out.add(r.id);
  return out;
}
export type AppOptions = { clock?:()=>number; nudgeIntervalMs?:number; translationModel?:JsonModel|null; okrDraftModel?:JsonModel|null; mailer?:Mailer|null; completionModel?:JsonModel|null; fxFetcher?:typeof fetch; db:Database; environment?:string; allowDevLogin?:boolean; devLoginSecret?:string; closeDatabase?:boolean; integrations?:IntegrationOptions; support?:SupportOptions; publicWiki?:PublicWikiOptions; shopify?:ShopifyOptions; caldock?:CaldockOptions; studio?:StudioOptions; hr?:HrOptions; it?:ItOptions; quality?:QualityOptions; dealer?:DealerOptions };

function actor(req: FastifyRequest): User { return req.actor || deny(401,'UNAUTHENTICATED','Authentication is required'); }
function scope(user: User) {
  if (Array.isArray(user.visibleOwnerIds)) return ['org_id=$1 AND (owner_id=ANY($2::text[]) OR reviewer_id=($2::text[])[1])',[user.org_id,user.visibleOwnerIds]] as const;
  return user.role === 'manager' ? ['org_id=$1 AND (department_id=$2 OR reviewer_id=$3)',[user.org_id,user.department_id,user.id]] as const : ['org_id=$1 AND (owner_id=$2 OR reviewer_id=$2)',[user.org_id,user.id]] as const;
}
async function loadTask(tx: Queryable, user: User, id: string, lock=false) {
  const result = await tx.query('SELECT * FROM tasks WHERE id=$1' + (lock?' FOR UPDATE':''),[id]);
  const task = result.rows[0]; if (!visibleTask(user,task)) deny(404,'NOT_FOUND','Task not found'); return task;
}
async function loadKr(tx: Queryable, id: string, lock=false) {
  return (await tx.query('SELECT k.*,o.org_id,o.department_id,o.owner_id,o.level FROM key_results k JOIN objectives o ON o.id=k.objective_id WHERE k.id=$1 AND k.archived_at IS NULL AND o.archived_at IS NULL' + (lock?' FOR UPDATE OF k':''),[id])).rows[0];
}
async function audit(tx: Queryable, user:User, action:string, objectId:string, details:unknown, ownerId=user.id, departmentId=user.department_id) {
  await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),user.org_id,departmentId,ownerId,user.id,action,objectId,JSON.stringify(details)]);
}
/** The files a submission carries. Submissions made before attachment_ids existed only named their files in a trailing
 *  "附件：a、b" / "Attachments: a、b" line; those are matched by name to files the submitter uploaded before submitting. */
export function submissionFiles(s:any, files:any[]) {
  const ids:string[]=s.attachment_ids||[];
  if(ids.length) return ids.map(id=>files.find(f=>f.id===id)).filter(Boolean);
  const line=String(s.description||'').split(/\r?\n/).reverse().find(l=>/^\s*(附件[：:]|Attachments:)/.test(l));
  if(!line) return [];
  const names=line.replace(/^\s*(附件[：:]|Attachments:)\s*/,'').split('、').map(n=>n.trim()).filter(Boolean), at=new Date(s.created_at).getTime(), used=new Set<string>();
  return names.map(n=>{const f=[...files].reverse().find(f=>f.name===n&&f.uploader_id===s.submitted_by&&!used.has(f.id)&&new Date(f.created_at).getTime()<=at);if(f)used.add(f.id);return f;}).filter(Boolean);
}
async function taskDetail(db:Queryable, task:any) {
  const files=(await db.query('SELECT id,name,mime,size,uploader_id,created_at FROM task_attachments WHERE task_id=$1 ORDER BY created_at,id',[task.id])).rows;
  const submissions=(await db.query('SELECT * FROM submissions WHERE task_id=$1 ORDER BY version',[task.id])).rows.map((s:any)=>({...s,attachments:submissionFiles(s,files)}));
  const reviews=(await db.query('SELECT * FROM reviews WHERE task_id=$1 ORDER BY created_at,id',[task.id])).rows;
  return {...task,submissions,reviews,currentReview:task.status==='accepted' ? [...reviews].reverse().find(r=>r.submission_version===task.submission_version&&r.decision==='accept') || null : null};
}
export async function buildApp(options:AppOptions) {
  const aiReviewConfigured=()=>{const integrations:any=(options as any).integrations||{};return !!(integrations.aiReviewMode==='bot'?integrations.bot:integrations.ai);};
  // The designated reviewer decides; the AI assessment is advice. Set REQUIRE_AI_ASSESSMENT=true to make a sufficient assessment a precondition for acceptance.
  const aiAssessmentRequired=()=>process.env.REQUIRE_AI_ASSESSMENT==='true'&&aiReviewConfigured();
  const {db}=options, environment=options.environment || 'development';
  const completionModel=options.completionModel===undefined?jsonModel({apiKey:process.env.AI_PROVIDER_API_KEY||process.env.XAI_API_KEY,model:process.env.AI_SCORING_MODEL_ID||process.env.AI_MODEL_ID,baseUrl:process.env.AI_PROVIDER_BASE_URL}):options.completionModel||undefined;
  const mailer=options.mailer===undefined?mailerFromEnv(process.env):options.mailer;
  const devEnabled=options.allowDevLogin===true && environment!=='production';
  if(devEnabled && (options.devLoginSecret?.length || 0)<32) throw new Error('DEV_LOGIN_SECRET must contain at least 32 characters when development login is enabled');
  const app=Fastify({logger:false,bodyLimit:128*1024,trustProxy:false});
  app.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string'},(_req,body,done)=>{
    const values=new URLSearchParams(String(body)),output:Record<string,string>={};
    for(const[key,value]of values){if(Object.hasOwn(output,key)){const error=Object.assign(new Error('Duplicate form field'),{statusCode:400});done(error);return;}Object.defineProperty(output,key,{value,enumerable:true});}
    done(null,output);
  });
  app.decorateRequest('actor',null);
  app.decorateRequest('language','zh');
  app.decorateRequest('sessionToken',null);
  app.decorateRequest('cookieAuthenticated',false);
  const integrations={...options.integrations,secureCookies:environment==='production'||options.integrations?.secureCookies===true};
  // This exact endpoint has its own worker-only bearer authentication, never a user session.
  const publicPaths=new Set(['/health','/capabilities','/auth/dev-login','/auth/dingtalk/start','/auth/dingtalk/callback','/integrations/grok-bot/mcp','/support/ingest']);
  for(const path of PUBLIC_WIKI_PATHS)publicPaths.add(path);
  for(const path of [...BOT_OAUTH_WELL_KNOWN,...['/register','/authorize','/token','/revoke','/consent.css'].map(path=>BOT_OAUTH_PREFIX+path)])publicPaths.add(path);
  app.addHook('onRequest',async(req,reply)=>{
    req.language=languageFrom(req.headers['accept-language']);
    reply.header('Content-Language',req.language).header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer');
    const requestPath=req.url.split('?')[0];
    // Commerce has its own customer identities, cookies, CSRF and admin checks.
    // Studio alone may bridge an independently scoped DingTalk employee session.
    if(requestPath.startsWith('/caldock/')) return;
    // The dealer portal likewise has its own dealer accounts, cookie and CSRF; /dealer-admin/* is employee-only.
    if(requestPath.startsWith('/dealer/')) return;
    if(publicPaths.has(requestPath)||isPublicMemberPath(requestPath)||/^\/integrations\/grok-bot\/oauth\/requests\/[A-Za-z0-9_-]{43}$/.test(requestPath)) return;
    const cookieToken=readCookie(req.headers.cookie,sessionCookieName(integrations.secureCookies));
    const token=req.headers.authorization?(req.headers.authorization.startsWith('Bearer ')?req.headers.authorization.slice(7):undefined):cookieToken;
    if(token&&integrations.bot?.workerToken&&sameSecret(token,integrations.bot.workerToken))deny(401,'UNAUTHENTICATED','Authentication is required');
    req.sessionToken=token||null;req.cookieAuthenticated=!req.headers.authorization&&!!cookieToken;
    req.actor=await resolveSession(db,token?'Bearer '+token:undefined);
    if(!req.actor) deny(401,'UNAUTHENTICATED','Authentication is required');
    await attachReportingScope(db,req.actor);
    // Factory staff (quality-only accounts) never reach the rest of the workspace; leads/admins are never restricted.
    const qualityAdmin=isOrgAdmin(req.actor as any,{executiveUserIds:integrations.executiveUserIds||[]})||(options.quality?.leadIds||[]).includes(req.actor.id);
    (req as any).qualityFactory=qualityAdmin?null:await qualityFactoryOf(db,options.quality||{},req.actor);
    if((req as any).qualityFactory&&!factoryPathAllowed(req.method,requestPath))deny(403,'FACTORY_SCOPE','Factory accounts can only use product quality tracking','工厂账号只能使用产品质量追踪。');
    if(req.cookieAuthenticated&&!['GET','HEAD','OPTIONS'].includes(req.method)){
      if(req.headers.origin&&req.headers.origin!==new URL(integrations.appPublicUrl||'http://localhost').origin)deny(403,'CSRF_INVALID','Request origin or security token is invalid');
      const supplied=req.headers['x-csrf-token'];
      const row=(await db.query('SELECT csrf_token FROM sessions WHERE token_hash=$1',[hash(token!)])).rows[0];
      if(typeof supplied!=='string'||!row?.csrf_token||!sameSecret(supplied,row.csrf_token))deny(403,'CSRF_INVALID','Request origin or security token is invalid');
    }
  });
  app.setErrorHandler((error,req,reply)=>{
    if(error instanceof ZodError) return reply.code(400).send({error:{code:'VALIDATION_ERROR',message:message('Invalid request data',req.language),fields:error.issues.map(i=>({path:i.path.join('.'),code:i.code,message:message('Invalid value',req.language)}))}});
    if(error instanceof ApiError) return reply.code(error.status).send({error:{code:error.code,message:error.zh&&req.language!=='en'?error.zh:message(error.message,req.language)}});
    if((error as any).statusCode===413) return reply.code(413).send({error:{code:'BODY_TOO_LARGE',message:message('Request body exceeds limit',req.language)}});
    if((error as any).statusCode===400) return reply.code(400).send({error:{code:'INVALID_JSON',message:message('Invalid JSON request',req.language)}});
    return reply.code(500).send({error:{code:'INTERNAL_ERROR',message:message('The request could not be completed',req.language)}});
  });
  app.setNotFoundHandler((req,reply)=>reply.code(404).send({error:{code:'NOT_FOUND',message:message('Endpoint not found',req.language)}}));
  app.get('/health',async(_req,reply)=>{
    try { await db.query('SELECT 1'); }
    catch { return reply.code(503).send({status:'unavailable',service:'onelaser-workos-api'}); }
    return {status:'ok',service:'onelaser-workos-api',version:'0.1.0',database:db.kind,productionReady:false};
  });
  app.get('/capabilities',async()=>({passwordLogin:true,emailCodeLogin:!!mailer,memberInvites:true,memberDisable:true,autoTranslate:true,assignTasks:true,simpleOkrScores:true,bilingualNames:true,projectsLive:true,wms:true,rma:true,quality:true,dealerPortal:!!options.dealer?.orgId,hr:true,itAssets:true,erpAccess:true,productsData:true,pricingRules:true,feedback:true,okrCycle:true,okrPublish:true,okrAiDraft:!!(options.okrDraftModel===undefined?(process.env.AI_PROVIDER_API_KEY||process.env.XAI_API_KEY)&&(process.env.AI_OKR_MODEL_ID||process.env.AI_MODEL_ID||process.env.AI_TRANSLATION_MODEL_ID||process.env.AI_SCORING_MODEL_ID):options.okrDraftModel),taskCompletion:true,aiCompletionScore:!!completionModel,aiInsights:!!completionModel,liveFx:true,aiAssessmentRequired:aiAssessmentRequired(),tasks:true,objectives:true,okrCollaboration:true,orgProfiles:true,submissions:true,humanReviews:true,audit:true,devLogin:devEnabled,dingtalk:integrations.dingtalk?'configured':'not_integrated',aiReview:(integrations.aiReviewMode==='bot'?(integrations.bot&&(!(integrations.botMcpAuthMode==='oauth')||!!(integrations.botOAuth?.publicUrl&&integrations.botOAuth.orgId&&integrations.botOAuth.redirectUris.length))):integrations.ai)?'configured':'not_integrated',aiReviewMode:integrations.aiReviewMode||'api',botMcpAuthMode:integrations.botMcpAuthMode||'bearer',notificationDelivery:integrations.notificationsEnabled&&integrations.dingtalk?'configured':'not_integrated',notificationChannels:{dingtalk:!!(integrations.notificationsEnabled&&integrations.dingtalk),email:!!mailer},employeeDecisions:'not_supported',frontendConnected:integrations.frontendConnected===true,teamMode:integrations.teamMode||'department',auth:{provider:'dingtalk',loginEnabled:!!integrations.dingtalk,session:'httpOnlyCookie',csrfHeader:'X-CSRF-Token'},setup:integrations.setup||null}));
  const attempts=new Map<string,{count:number;until:number}>();
  app.post('/auth/dev-login',async(req,reply)=>{
    if(!devEnabled) deny(404,'DEV_LOGIN_DISABLED','Development login is disabled');
    const now=Date.now(), current=attempts.get(req.ip);
    if(current&&current.until>now&&current.count>=30) deny(429,'RATE_LIMITED','Too many development login attempts');
    if(!current||current.until<=now) attempts.set(req.ip,{count:1,until:now+60000}); else current.count++;
    if(attempts.size>1000) for(const [ip,v] of attempts) if(v.until<=now) attempts.delete(ip);
    const input=z.object({userId:identifier,secret:z.string().max(512)}).strict().parse(req.body);
    if(!sameSecret(input.secret,options.devLoginSecret!)) deny(401,'INVALID_CREDENTIALS','Invalid development credentials');
    const user=(await db.query<User>('SELECT * FROM users WHERE id=$1 AND active=true',[input.userId])).rows[0];
    if(!user) deny(401,'INVALID_CREDENTIALS','Invalid development credentials');
    return issueSession(db,user.id);
  });
  app.delete('/auth/session',async(req,reply)=>{await db.query('DELETE FROM sessions WHERE token_hash=$1',[hash(req.sessionToken!)]);reply.header('Set-Cookie',cookie(sessionCookieName(integrations.secureCookies),'',integrations.secureCookies,0));return {revoked:true};});
  const isExecutive=(user:User)=>integrations.executiveUserIds?.includes(user.id)===true;
  app.get('/me',async req=>({...actor(req),isAdmin:isOrgAdmin(actor(req) as any,{executiveUserIds:integrations.executiveUserIds||[]}),executiveAccess:isExecutive(actor(req)),supportAccess:supportPermissions(actor(req),options.support||{},integrations.executiveUserIds||[]),qualityFactory:(req as any).qualityFactory||null}));
  app.get('/executive/summary',async req=>{const user=actor(req);if(!isExecutive(user))deny(403,'FORBIDDEN','Executive access is required');return db.transaction(tx=>executiveSummary(tx,user.org_id,integrations.teamMode));});
  registerSupportRoutes(app,db,options.support,integrations.executiveUserIds);
  await registerOkrPublish(app,db,{isAdmin:(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]})});
  await registerCaldockRoutes(app,db,{mailer,...options.caldock,secureCookies:environment==='production'||options.caldock?.secureCookies===true});
  await registerCaldockStudio(app,db,{publicUrl:options.caldock?.publicUrl||integrations.appPublicUrl,...options.studio,
    dingtalk:integrations.dingtalk&&integrations.corpId&&integrations.appPublicUrl&&(integrations.allowedDepartmentIds?.length||integrations.teamMode==='company'&&integrations.additionalUserIds?.length)?{
      corpId:integrations.corpId,allowedDepartmentIds:integrations.allowedDepartmentIds||[],
      additionalUserIds:integrations.teamMode==='company'?integrations.additionalUserIds||[]:[],managerUserIds:integrations.managerUserIds||[]
    }:undefined,secureCookies:environment==='production'||options.studio?.secureCookies===true});
  const dealerOptions={mailer,publicUrl:integrations.appPublicUrl,...options.dealer,secureCookies:environment==='production'||options.dealer?.secureCookies===true};
  await registerDealerRoutes(app,db,dealerOptions);
  await registerDealerAdminRoutes(app,db,{...dealerOptions,isAdmin:isExecutive /* sensitive ERP data: only deployment-configured executives bypass grants; in-app admins need grants */});
  registerPublicWikiRoutes(app,db,options.publicWiki,options.support,integrations.executiveUserIds);
  registerShopifyRoutes(app,db,options.shopify,options.support,integrations.executiveUserIds);
  registerTaskBoardRoutes(app,db,{isAdmin:(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]})});
  app.get('/tasks',async req=>{
    const user=actor(req),[where,params]=scope(user);await applyAutoStatus(db,user.org_id);
    return {items:(await db.query(`SELECT tasks.*,CASE WHEN tasks.status='accepted' THEN (SELECT r.created_at FROM reviews r WHERE r.task_id=tasks.id AND r.submission_version=tasks.submission_version AND r.decision='accept' ORDER BY r.created_at DESC,r.id DESC LIMIT 1) ELSE NULL END AS accepted_at,(SELECT json_build_object('ai_status',c.ai_status,'ai_score',c.ai_score,'human_score',c.human_score,'final_score',COALESCE(c.human_score,CASE WHEN c.ai_status='scored' THEN c.ai_score END),'score_source',CASE WHEN c.human_score IS NOT NULL THEN 'human' WHEN c.ai_status='scored' THEN 'ai' END,'score_due_at',c.created_at+interval '24 hours') FROM task_completions c WHERE c.task_id=tasks.id AND c.superseded_at IS NULL ORDER BY c.created_at DESC LIMIT 1) AS completion,${TASK_SOURCE_COLUMNS} FROM tasks WHERE ${where} ORDER BY created_at,id LIMIT 100`,[...params])).rows,limit:100};
  });
  app.get<{Params:{id:string}}>('/tasks/:id',async req=>taskDetail(db,await loadTask(db,actor(req),identifier.parse(req.params.id))));
  app.post('/tasks',async(req,reply)=>{
    const user=actor(req),input=taskInput.parse(req.body);
    if(user.role==='employee'&&input.ownerId!==user.id) deny(403,'FORBIDDEN','Employees can create tasks only for themselves');
    // Your own tasks need only a name (description and attachments optional); a task for someone else still needs what to deliver and how it is accepted.
    if(input.ownerId!==user.id&&(!input.description||!input.criteria.length)) deny(400,'TASK_DETAILS_REQUIRED','A task for someone else needs a description and acceptance criteria');
    const result=await db.transaction(async tx=>{
      const owner=(await tx.query<User>('SELECT * FROM users WHERE id=$1 AND active=true',[input.ownerId])).rows[0];
      if(!owner||owner.org_id!==user.org_id||owner.department_id!==user.department_id) deny(400,'INVALID_OWNER','Owner must be an active member of the current department');
      let reviewer=(await tx.query<User>(input.reviewerId?'SELECT * FROM users WHERE id=$1 AND active=true':'SELECT * FROM users WHERE org_id=$1 AND department_id=$2 AND role=$3 AND active=true AND id<>$4 ORDER BY id LIMIT 1',input.reviewerId?[input.reviewerId]:[user.org_id,user.department_id,'manager',owner.id])).rows[0];
      if(!reviewer&&!input.reviewerId&&(owner as any).manager_id)reviewer=(await tx.query<User>('SELECT * FROM users WHERE id=$1 AND active=true',[(owner as any).manager_id])).rows[0];
      // Top of the reporting line with no other manager in the department: the owner's own tasks are scored by AI on completion, so they review themselves.
      const topSelf=!reviewer&&!input.reviewerId&&!(owner as any).manager_id&&input.ownerId===user.id;if(topSelf)reviewer=owner;
      if(!topSelf&&!reviewerAllowed(owner,reviewer,user.org_id,user.department_id)) deny(400,'INVALID_REVIEWER','Select a different authorized manager in this department');
      if(input.krId){const kr=await loadKr(tx,input.krId);if(!visibleObjective(user,kr)||!visibleObjective(owner,kr))deny(400,'INVALID_KR','The linked key result must be visible to the task owner');}
      const groupId=await validateBoardCreation(tx,user,input);
      const id=randomUUID();
      const task=(await tx.query('INSERT INTO tasks(id,org_id,department_id,owner_id,reviewer_id,created_by,title,description,criteria,baseline_due_at,due_at,kr_id,board_group_id,board_priority,board_category,parent_task_id,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$6) RETURNING *',[id,user.org_id,user.department_id,owner.id,reviewer.id,user.id,input.title,input.description,JSON.stringify(input.criteria),input.dueAt,input.krId||null,groupId,input.boardPriority||'',input.boardCategory||'',input.parentTaskId||null])).rows[0];
      await audit(tx,user,'task.created',id,{version:1},owner.id);
      await pushInbox(tx,{orgId:user.org_id,recipients:[owner.id],actorId:user.id,kind:'task_new',taskId:id,title:input.title,body:String(input.description||'').slice(0,200)});return task;
    });return reply.code(201).send(result);
  });
  app.post<{Params:{id:string}}>('/tasks/:id/submissions',async(req,reply)=>{
    const user=actor(req),input=submissionInput.parse(req.body),id=identifier.parse(req.params.id);
    const result=await db.transaction(async tx=>{
      const task=await loadTask(tx,user,id,true);
      if(task.owner_id!==user.id) deny(403,'FORBIDDEN','Only the task owner can submit evidence');
      if(task.version!==input.expectedVersion) deny(409,'VERSION_CONFLICT','Task changed; reload before submitting');
      const version=task.submission_version+1;
      const attachmentIds=[...new Set(input.attachmentIds||[])];
      if(attachmentIds.length){const own=(await tx.query('SELECT id FROM task_attachments WHERE task_id=$1 AND uploader_id=$2 AND id=ANY($3::text[])',[id,user.id,attachmentIds])).rows;if(own.length!==attachmentIds.length)deny(400,'INVALID_ATTACHMENT','Attach only files you uploaded to this task');}
      const submission=(await tx.query('INSERT INTO submissions(id,task_id,version,submitted_by,title,description,evidence_url,attachment_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),id,version,user.id,submissionTitle(input.title,input.description),input.description,input.evidenceUrl||null,attachmentIds])).rows[0];
      await tx.query('UPDATE tasks SET version=version+1,submission_version=$2,status=$3,board_status=$4,board_done_at=NULL,updated_at=now(),updated_by=$5 WHERE id=$1',[id,version,'submitted','review',user.id]);
      await audit(tx,user,'submission.created',id,{submissionVersion:version,previousReviewInvalidated:true},task.owner_id);
      await pushInbox(tx,{orgId:task.org_id,recipients:[task.reviewer_id,task.assigned_by,task.created_by],actorId:user.id,kind:'submission',taskId:id,title:task.title,body:input.description});return {submission,taskVersion:task.version+1};
    });return reply.code(201).send(result);
  });
  app.post<{Params:{id:string}}>('/tasks/:id/reviews',async(req,reply)=>{
    const user=actor(req),input=reviewInput.parse(req.body),id=identifier.parse(req.params.id);
    if(user.role!=='manager') deny(403,'FORBIDDEN','A designated manager must review evidence');
    const result=await db.transaction(async tx=>{
      const task=await loadTask(tx,user,id,true);
      if(task.owner_id===user.id) deny(403,'SELF_REVIEW_FORBIDDEN','Task owners cannot review their own work');
      if(task.reviewer_id!==user.id) deny(403,'FORBIDDEN','Only the designated reviewer can confirm this task');
      if(task.version!==input.expectedVersion||task.submission_version!==input.submissionVersion||task.status!=='submitted') deny(409,'VERSION_CONFLICT','Review must match the currently submitted version');
      if(input.decision==='accept'&&(input.quality===undefined||input.verifiedCurrentSubmission!==true)) deny(400,'HUMAN_VERIFICATION_REQUIRED','A quality score and actual evidence verification are required');
      // A task only counts as done when the owner's evidence has an AI assessment that found it sufficient.
      if(input.decision==='accept'&&aiAssessmentRequired()){
        const ev=(await tx.query('SELECT status FROM ai_evaluations WHERE task_id=$1 AND submission_version=$2 ORDER BY created_at DESC LIMIT 1',[id,task.submission_version])).rows[0];
        if(!ev) deny(409,'AI_ASSESSMENT_REQUIRED','Run the AI assessment on the current evidence before accepting');
        if(ev.status!=='ready_for_human_review') deny(409,'AI_EVIDENCE_INSUFFICIENT','The AI assessment found the evidence insufficient; ask the owner to add evidence');
      }
      const review=(await tx.query('INSERT INTO reviews(id,task_id,submission_version,reviewer_id,decision,quality,note) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[randomUUID(),id,input.submissionVersion,user.id,input.decision,input.decision==='accept'?input.quality:null,input.note])).rows[0];
      await tx.query('UPDATE tasks SET version=version+1,status=$2,board_status=$3,board_done_at=$4,updated_at=now(),updated_by=$5 WHERE id=$1',[id,input.decision==='accept'?'accepted':'revision',input.decision==='accept'?'done':'working',input.decision==='accept'?new Date().toISOString():null,user.id]);
      await audit(tx,user,'review.'+input.decision,id,{submissionVersion:input.submissionVersion,quality:review.quality},task.owner_id);
      await pushInbox(tx,{orgId:task.org_id,recipients:[task.owner_id],actorId:user.id,kind:input.decision==='accept'?'review_accept':'review_revise',taskId:id,title:task.title,body:input.note||''});return {review,taskVersion:task.version+1};
    });return reply.code(201).send(result);
  });
  app.get('/objectives',async req=>{
    const user=actor(req),rows=(await db.query('SELECT o.*,u.display_name AS owner_name,u.name_zh AS owner_name_zh,u.name_en AS owner_name_en FROM objectives o LEFT JOIN users u ON u.id=o.owner_id WHERE o.org_id=$1 AND o.archived_at IS NULL ORDER BY o.created_at,o.id',[user.org_id])).rows;
    const extra=await okrListOwners(db,user,integrations.executiveUserIds||[]);const items=await attachOkrImportMetadata(db,'objective',rows.filter(o=>visibleObjective(user,o)||(o.owner_id&&extra.has(o.owner_id))));
    const scores=await scoresFor(db,items.map((o:any)=>o.id)),adminCheck=(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]});
    for(const o of items as any[]){o.scores=scores.get(o.id)||{};o.canLeadScore=await canLeadScore(db,user,o,adminCheck);}
    return {items};
  });
  app.get('/key-results',async req=>{
    const user=actor(req),rows=(await db.query('SELECT k.*,o.org_id,o.department_id,o.owner_id,o.level FROM key_results k JOIN objectives o ON o.id=k.objective_id WHERE o.org_id=$1 AND k.archived_at IS NULL AND o.archived_at IS NULL ORDER BY k.created_at,k.id',[user.org_id])).rows;
    const extra=await okrListOwners(db,user,integrations.executiveUserIds||[]);const krs=await attachOkrImportMetadata(db,'key_result',rows.filter(o=>visibleObjective(user,o)||(o.owner_id&&extra.has(o.owner_id))).map(kr=>({...kr,progress:krProgress(kr)})));
    const krScores=await scoresFor(db,krs.map((k:any)=>k.id),'kr_scores');for(const k of krs as any[])k.scores=krScores.get(k.id)||{};const krTasks=new Map((await db.query('SELECT DISTINCT ON (t.kr_id) t.kr_id,t.id,t.owner_id FROM tasks t WHERE t.org_id=$1 AND t.kr_id=ANY($2::text[]) ORDER BY t.kr_id,t.created_at',[user.org_id,krs.map((k:any)=>k.id)])).rows.map((r:any)=>[r.kr_id,r])) as Map<string,any>;for(const k of krs as any[]){const t=krTasks.get(k.id);k.task_id=t&&t.owner_id===k.owner_id?t.id:null;}
    return {items:krs};
  });
  app.post<{Params:{id:string}}>('/key-results/:id/measurements',async(req,reply)=>{
    const user=actor(req),input=measurementInput.parse(req.body),id=identifier.parse(req.params.id);
    if(user.role!=='manager') deny(403,'FORBIDDEN','A manager must verify metric updates');
    const result=await db.transaction(async tx=>{
      const kr=await loadKr(tx,id,true);
      if(!visibleObjective(user,kr)||kr.department_id!==user.department_id) deny(404,'NOT_FOUND','Key result not found');
      if(!hasKrMetric({...kr})||typeof kr.unit!=='string'||!kr.unit.trim()) deny(400,'METRIC_NOT_CONFIGURED','This key result has no quantitative metric configured');
      if(kr.version!==input.expectedVersion) deny(409,'VERSION_CONFLICT','Key result changed; reload before recording');
      await tx.query('INSERT INTO measurements(id,kr_id,actual,source,note,recorded_by) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),id,input.actual,input.source,input.note,user.id]);
      const updated=(await tx.query('UPDATE key_results SET actual=$2,version=version+1 WHERE id=$1 RETURNING *',[id,input.actual])).rows[0];
      await audit(tx,user,'kr.measured',id,{actual:input.actual,source:input.source},kr.owner_id||user.id);return {...updated,progress:krProgress(updated)};
    });return reply.code(201).send(result);
  });
  app.get('/notifications/preview',async req=>{
    const user=actor(req),[where,params]=scope(user),tasks=(await db.query(`SELECT id,title,status,owner_id,due_at FROM tasks WHERE ${where} AND status<>$${params.length+1} ORDER BY due_at LIMIT 100`,[...params,'accepted'])).rows;
    return {status:'draft',sent:false,recipient:user.id,items:tasks};
  });
  app.get('/audit',async req=>{const u=actor(req),[where,params]=Array.isArray(u.visibleOwnerIds)?['org_id=$1 AND owner_id=ANY($2::text[])',[u.org_id,u.visibleOwnerIds]] as const:u.role==='manager'?['org_id=$1 AND department_id=$2',[u.org_id,u.department_id]] as const:['org_id=$1 AND owner_id=$2',[u.org_id,u.id]] as const;return {items:(await db.query(`SELECT * FROM audit_events WHERE ${where} ORDER BY created_at DESC,id LIMIT 100`,[...params])).rows,limit:100};});
  await registerOkrRoutes(app,db);
  await registerOkrCollabRoutes(app,db,{isAdmin:(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]})});
  await registerOrgRoutes(app,db,{executiveUserIds:integrations.executiveUserIds||[]});
  await registerMemberRoutes(app,db,{executiveUserIds:integrations.executiveUserIds||[],secureCookies:integrations.secureCookies,appPublicUrl:integrations.appPublicUrl,mailer,teamName:integrations.teamName});
  await registerTranslateRoutes(app,db,{model:options.translationModel===undefined?(jsonModel({apiKey:process.env.AI_PROVIDER_API_KEY||process.env.XAI_API_KEY,model:process.env.AI_TRANSLATION_MODEL_ID||process.env.AI_SCORING_MODEL_ID||process.env.AI_MODEL_ID,baseUrl:process.env.AI_PROVIDER_BASE_URL})||null):options.translationModel});
  await registerOkrAiRoutes(app,db,{model:options.okrDraftModel===undefined?(jsonModel({apiKey:process.env.AI_PROVIDER_API_KEY||process.env.XAI_API_KEY,model:process.env.AI_OKR_MODEL_ID||process.env.AI_MODEL_ID||process.env.AI_TRANSLATION_MODEL_ID||process.env.AI_SCORING_MODEL_ID,baseUrl:process.env.AI_PROVIDER_BASE_URL})||null):options.okrDraftModel});
  const dingNotify=integrations.dingtalk&&integrations.notificationsEnabled&&integrations.corpId?async(userId:string,content:string)=>{const ext=(await db.query('SELECT external_user_id FROM external_identities WHERE provider=$1 AND corp_id=$2 AND user_id=$3',['dingtalk',integrations.corpId,userId])).rows[0]?.external_user_id;if(!ext)return false;await integrations.dingtalk!.sendWorkNotification([ext],content);return true;}:null;
  /* Email copy of every reminder: to the address on the person's profile (required, see Personal settings). */
  const appLink=integrations.appPublicUrl||'https://craftos.app';
  const escHtml=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const emailNotify=mailer?async(userId:string,content:string)=>{const to=String((await db.query("SELECT email FROM users WHERE id=$1 AND active=true AND disabled_at IS NULL",[userId])).rows[0]?.email||'').trim();if(!to)return false;const body=content.replace(/^【WorkOS】/,'');const subject='【WorkOS】'+(body.length>60?body.slice(0,60)+'…':body);await mailer({to,subject,text:`${body}\n\n打开 WorkOS 查看：${appLink}`,html:`<div style="font:15px/1.6 -apple-system,Segoe UI,Arial,sans-serif;color:#1f2937"><p>${escHtml(body).replace(/\n/g,'<br>')}</p><p><a href="${appLink}" style="display:inline-block;background:#3370ff;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none">打开 WorkOS 查看</a></p><p style="color:#9ca3af;font-size:12px">OneLaser WorkOS 自动通知</p></div>`});return true;}:null;
  const notify=dingNotify||emailNotify?async(userId:string,content:string)=>{const out:string[]=[];if(dingNotify){try{if(await dingNotify(userId,content))out.push('dingtalk');}catch{/* keep trying email */}}if(emailNotify){try{if(await emailNotify(userId,content))out.push('email');}catch{/* in-app copy stands */}}return out;}:null;
  await registerAssignRoutes(app,db,{model:completionModel||null,notify,intervalMs:options.nudgeIntervalMs??(environment==='production'?Number(process.env.NUDGE_INTERVAL_MS)||30*60000:0),isAdmin:(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]})});
  await registerOkrCycle(app,db,{now:options.clock,notify,timeZone:process.env.OKR_TIMEZONE||'America/Los_Angeles',intervalMs:options.nudgeIntervalMs??(environment==='production'?Number(process.env.NUDGE_INTERVAL_MS)||30*60000:0),isAdmin:(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]})});
  await registerProjectRoutes(app,db,{isAdmin:(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]})});
  await registerWmsRoutes(app,db,{isAdmin:isExecutive /* sensitive ERP data: only deployment-configured executives bypass grants; in-app admins need grants */});
  await registerRmaRoutes(app,db,{isAdmin:isExecutive /* sensitive ERP data: only deployment-configured executives bypass grants; in-app admins need grants */,now:options.clock});
  await registerHrRoutes(app,db,{...options.hr,now:options.clock,intervalMs:options.nudgeIntervalMs??(environment==='production'?Number(process.env.NUDGE_INTERVAL_MS)||30*60000:0)});
  await registerQualityRoutes(app,db,{...options.quality,notify,intervalMs:options.nudgeIntervalMs??(environment==='production'?Number(process.env.NUDGE_INTERVAL_MS)||30*60000:0),isAdmin:(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]}),now:options.clock});
  await registerItRoutes(app,db,{...options.it,quality:options.quality,executiveIds:integrations.executiveUserIds||[],now:options.clock,intervalMs:options.nudgeIntervalMs??(environment==='production'?Number(process.env.NUDGE_INTERVAL_MS)||30*60000:0)});
  await registerInboxRoutes(app,db);
  await registerProductRoutes(app,db,{isAdmin:isExecutive /* sensitive ERP data: only deployment-configured executives bypass grants; in-app admins need grants */});
  await registerFeedbackRoutes(app,db,{isAdmin:(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]}),mailer,to:process.env.FEEDBACK_EMAIL,appUrl:integrations.appPublicUrl});
  await registerOkrScoreRoutes(app,db,{isAdmin:(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]}),visible:visibleObjective});
  await registerCompletionRoutes(app,db,{model:completionModel,fxFetcher:options.fxFetcher,fxFallback:Number(process.env.FX_FALLBACK_CNY)||7.1,intervalMs:options.nudgeIntervalMs??(environment==='production'?Number(process.env.NUDGE_INTERVAL_MS)||30*60000:0),isAdmin:(u:User)=>isOrgAdmin(u as any,{executiveUserIds:integrations.executiveUserIds||[]})});
  await registerIntegrationRoutes(app,db,integrations);
  if(options.closeDatabase!==false) app.addHook('onClose',async()=>db.close());
  return app;
}
