import { pushInbox, taskFollowers } from './inbox.js';
import { COMPLETION_LOCK_MS } from './completions.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { visibleTask, reviewerAllowed } from './domain.js';
import { TASK_SOURCE_COLUMNS } from './assign.js';
import { deny, ApiError } from './errors.js';
import { message, type Language } from './i18n.js';

export const boardSchema = `
CREATE TABLE IF NOT EXISTS task_board_personal(user_id text PRIMARY KEY, org_id text NOT NULL, groups jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_group_id text NOT NULL DEFAULT 'todo';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_status text NOT NULL DEFAULT 'not_started';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_priority text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_category text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_notes text NOT NULL DEFAULT '';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS board_done_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS updated_by text REFERENCES users(id);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id text REFERENCES tasks(id);
UPDATE tasks SET updated_at=GREATEST(created_at,COALESCE((SELECT max(created_at) FROM reviews WHERE task_id=tasks.id),created_at),COALESCE((SELECT max(created_at) FROM submissions WHERE task_id=tasks.id),created_at)) WHERE updated_by IS NULL;
UPDATE tasks SET board_status=CASE WHEN status='accepted' THEN 'done' WHEN status='submitted' THEN 'review' ELSE 'working' END,board_done_at=CASE WHEN status='accepted' THEN COALESCE((SELECT max(created_at) FROM reviews WHERE task_id=tasks.id AND decision='accept'),created_at) ELSE NULL END WHERE updated_by IS NULL AND board_status='not_started' AND status IN ('accepted','submitted','revision');
CREATE INDEX IF NOT EXISTS task_board_parent ON tasks(parent_task_id);
CREATE TABLE IF NOT EXISTS task_board_config(org_id text NOT NULL,department_id text NOT NULL,version integer NOT NULL DEFAULT 1,data jsonb NOT NULL,PRIMARY KEY(org_id,department_id));
CREATE TABLE IF NOT EXISTS task_board_views(user_id text PRIMARY KEY REFERENCES users(id),org_id text NOT NULL,data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS task_updates(id text PRIMARY KEY,task_id text NOT NULL REFERENCES tasks(id),org_id text NOT NULL,actor_id text NOT NULL REFERENCES users(id),body text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS task_updates_task ON task_updates(task_id,created_at,id);
ALTER TABLE task_updates ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS archived_by text REFERENCES users(id);
CREATE INDEX IF NOT EXISTS tasks_active_owner ON tasks(org_id,owner_id) WHERE archived_at IS NULL;
`;
const id=z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const color=z.string().regex(/^#[0-9a-fA-F]{6}$/);
const label=z.object({id:z.string().max(80).regex(/^[A-Za-z0-9_-]*$/),en:z.string().trim().min(1).max(80),zh:z.string().trim().min(1).max(80),color}).strict();
const group=z.object({id,en:z.string().trim().min(1).max(100),zh:z.string().trim().min(1).max(100),color}).strict();
const statusIds=['working','hold','review','done','not_started','overdue','abandoned'];
const priorityIds=['urgent','high','medium','low',''];
// Status rules: Not started is automatic; the first progress update moves a task to Working; past the due date
// Not started / Working tasks become Overdue (On hold never does); 15 days without any update means Abandoned.
const STATUS_LABELS=[{id:'not_started',en:'Not started',zh:'未开始',color:'#797e93'},{id:'working',en:'Working',zh:'进行中',color:'#fdbc65'},{id:'hold',en:'Paused',zh:'被暂停',color:'#df7689'},{id:'review',en:'In review',zh:'待审批',color:'#b483d7'},{id:'done',en:'Done',zh:'完成',color:'#34d391'},{id:'overdue',en:'Overdue',zh:'延期',color:'#e2445c'},{id:'abandoned',en:'Abandoned',zh:'放弃',color:'#4b4f5c'}];
export async function applyAutoStatus(db:Queryable,orgId?:string){
 const scope=orgId?' AND org_id=$1':'',params=orgId?[orgId]:[];
 await db.query(`UPDATE tasks SET board_status='overdue',version=version+1,updated_at=now() WHERE board_status IN ('not_started','working') AND status<>'accepted' AND due_at<now()${scope}`,params);
 await db.query(`UPDATE tasks SET board_status='abandoned',version=version+1,updated_at=now() WHERE board_status IN ('not_started','working','overdue') AND status<>'accepted'
   AND COALESCE((SELECT max(u.created_at) FROM task_updates u WHERE u.task_id=tasks.id),tasks.created_at)<now()-interval '15 days'${scope}`,params);
}
export const defaultBoardConfig=()=>({
 groups:[{id:'todo',en:'To-Do',zh:'待办任务',color:'#579bfc'},{id:'completed',en:'Completed',zh:'已完成',color:'#00c875'}],
 status:STATUS_LABELS.map(x=>({...x})),
 priority:[{id:'urgent',en:'Urgent',zh:'紧急',color:'#ff7cd1'},{id:'high',en:'High',zh:'高',color:'#6646aa'},{id:'medium',en:'Medium',zh:'中',color:'#8581df'},{id:'low',en:'Low',zh:'低',color:'#8eb8f9'},{id:'',en:'Unassigned',zh:'未设置',color:'#797e93'}],
 category:[{id:'hr',en:'B-HR',zh:'B-人事',color:'#ff8358'},{id:'finance',en:'B-Finance',zh:'B-财务',color:'#e96a7d'},{id:'legal',en:'B-Legal',zh:'B-法务',color:'#349ecd'},{id:'operations',en:'B-Operations',zh:'B-运营',color:'#ca5d77'},{id:'marketing',en:'B-Marketing',zh:'B-市场',color:'#ffd533'},{id:'personal',en:'Personal',zh:'个人事务',color:'#ff44a1'}]
});
const configInput=z.object({expectedVersion:z.number().int().positive(),groups:z.array(group).min(2).max(40).optional(),status:z.array(label).min(5).max(7),priority:z.array(label).length(5),category:z.array(label).max(40)}).strict().superRefine((v,c)=>{
 for(const k of ['groups','status','priority','category'] as const)if(v[k]&&new Set(v[k]!.map(x=>x.id)).size!==v[k]!.length)c.addIssue({code:'custom',path:[k],message:'Duplicate labels'});
 if(v.groups&&!['todo','completed'].every(x=>v.groups!.some(g=>g.id===x)))c.addIssue({code:'custom',path:['groups'],message:'Default groups required'});
 if(!statusIds.every(x=>v.status.some(g=>g.id===x))||!priorityIds.every(x=>v.priority.some(g=>g.id===x)))c.addIssue({code:'custom',path:['status'],message:'Stable label identifiers required'});
 if(v.category.some(x=>!x.id))c.addIssue({code:'custom',path:['category'],message:'Blank category is reserved'});
});
const width=z.number().int().min(64).max(700);
const viewInput=z.object({sort:z.array(z.object({field:z.enum(['priority','due','category','title','updated','status']),direction:z.enum(['asc','desc'])}).strict()).max(5),groupBy:z.enum(['group','priority','status','category','owner','due']),hidden:z.array(z.enum(['owner','priority','status','category','due','notes','updated'])).max(7),collapsed:z.array(id).max(200),display:z.enum(['table','kanban','calendar','dashboard']).optional(),scope:z.enum(['team','mine']).optional(),showWeekends:z.boolean().optional(),widths:z.object({title:z.number().int().min(180).max(700).optional(),owner:width.optional(),priority:width.optional(),status:width.optional(),category:width.optional(),due:width.optional(),notes:width.optional(),updated:width.optional()}).strict().optional()}).strict();
const patchInput=z.object({expectedVersion:z.number().int().positive(),title:z.string().trim().min(3).max(200).optional(),priority:z.string().max(80).optional(),status:z.enum(['working','hold','review','done','not_started','overdue','abandoned']).optional(),category:z.string().max(80).optional(),groupId:id.optional(),notes:z.string().max(10000).optional(),dueAt:z.string().datetime({offset:true}).optional(),ownerId:id.optional(),reviewerId:id.optional(),description:z.string().trim().min(1).max(10000).optional(),criteria:z.array(z.string().trim().min(1).max(500)).min(1).max(20).optional()}).strict().refine(v=>Object.keys(v).length>1);
export async function boardConfig(tx:Queryable,user:User){
 await tx.query('INSERT INTO task_board_config(org_id,department_id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[user.org_id,user.department_id,JSON.stringify(defaultBoardConfig())]);
 const row=(await tx.query('SELECT * FROM task_board_config WHERE org_id=$1 AND department_id=$2',[user.org_id,user.department_id])).rows[0];
 // Older boards had five statuses: add Overdue / Abandoned and adopt the new names for untouched defaults.
 if(row&&!['overdue','abandoned'].every(id=>row.data.status.some((x:any)=>x.id===id))){
  const renamed:Record<string,string>={暂缓:'被暂停',待检查:'待审批'},data={...row.data,status:STATUS_LABELS.map(d=>{const old=row.data.status.find((x:any)=>x.id===d.id);return old?{...old,zh:renamed[old.zh]||old.zh,en:({'On-Hold':'Paused','Review':'In review','Awaiting approval':'In review','Working on it':'Working'} as Record<string,string>)[old.en]||old.en}:{...d};})};
  const up=(await tx.query('UPDATE task_board_config SET data=$3,version=version+1 WHERE org_id=$1 AND department_id=$2 RETURNING *',[user.org_id,user.department_id,JSON.stringify(data)])).rows[0];return up;
 }
 return row;
}
export async function validateBoardCreation(tx:Queryable,user:User,input:any){
 const config=(await boardConfig(tx,user)).data;
 for(const [key,list] of [['boardPriority','priority'],['boardCategory','category']] as const)if(input[key]&&!config[list].some((x:any)=>x.id===input[key]))deny(400,'INVALID_BOARD_LABEL','Select an existing board label');
 if(input.boardGroupId&&input.boardGroupId!=='completed'&&!config.groups.some((x:any)=>x.id===input.boardGroupId)&&!(await personalGroups(tx,user)).some((x:any)=>x.id===input.boardGroupId))deny(400,'INVALID_BOARD_GROUP','Select an active group');
 if(input.parentTaskId){const parent=(await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[input.parentTaskId])).rows[0];if(!visibleTask(user,parent)||parent.parent_task_id)deny(400,'INVALID_PARENT','Select a visible top-level parent task');return parent.board_group_id==='completed'?'todo':parent.board_group_id;}
 return input.boardGroupId||'todo';
}
export function effectiveGroup(task:any,tasks:any[],now=Date.now()){
 const oldDone=(t:any)=>t.board_status==='done'&&t.board_done_at&&new Date(t.board_done_at).getTime()<=now-COMPLETION_LOCK_MS;
 return oldDone(task)&&tasks.filter(t=>t.parent_task_id===task.id).every(oldDone)?'completed':task.board_group_id;
}
/* Personal groups: the Task hub is each person's own list, so everyone arranges their own groups.
 * Until someone edits them, their groups are the department's defaults. "completed" always stays last. */
export async function personalGroups(tx:Queryable,user:User){
 const row=(await tx.query('SELECT groups FROM task_board_personal WHERE user_id=$1 AND org_id=$2',[user.id,user.org_id])).rows[0];
 const base=row?.groups||(await boardConfig(tx,user)).data.groups.filter((g:any)=>g.id!=='completed');
 const done=(await boardConfig(tx,user)).data.groups.find((g:any)=>g.id==='completed')||{id:'completed',en:'Completed',zh:'已完成',color:'#00c875'};
 return [...base.filter((g:any)=>g.id!=='completed'),done];
}
async function reportsSet(db:Queryable,orgId:string,userId:string){
 const rows=(await db.query('SELECT id,manager_id FROM users WHERE org_id=$1',[orgId])).rows as {id:string;manager_id:string|null}[];
 const out=new Set<string>();let frontier=[userId];
 for(let d=0;d<20&&frontier.length;d++){const next=rows.filter(r=>r.manager_id&&frontier.includes(r.manager_id)&&!out.has(r.id)&&r.id!==userId).map(r=>r.id);next.forEach(x=>out.add(x));frontier=next;}
 return out;
}
export function registerTaskBoardRoutes(app:FastifyInstance,db:Database,o:{isAdmin?:(u:User)=>boolean}={}){
 const actor=(u:User|null)=>u||deny(401,'UNAUTHENTICATED','Authentication is required');
 app.get('/task-board',async req=>{
  // The Task hub is personal: it lists the signed-in person's own tasks. A manager (or an admin) can open
  // a report's Task hub read-only from Task analysis with ?person=<id>.
  const user=actor(req.actor);await applyAutoStatus(db,user.org_id);const config=await boardConfig(db,user);
  const asked=typeof (req.query as any)?.person==='string'?String((req.query as any).person).slice(0,100):'';
  let target:any=user,readOnly=false;
  if(asked&&asked!==user.id){
   const allowed=o.isAdmin?.(user)||(await reportsSet(db,user.org_id,user.id)).has(asked);
   if(!allowed)deny(403,'TASK_HUB_FORBIDDEN','You can only open the Task hub of people who report to you','只能查看向你汇报的同事的任务。');
   target=(await db.query('SELECT * FROM users WHERE id=$1 AND org_id=$2',[asked,user.org_id])).rows[0];if(!target)deny(404,'NOT_FOUND','Member not found');readOnly=true;
  }
  const tasks=(await db.query('SELECT tasks.*,CASE WHEN tasks.status=\'accepted\' THEN (SELECT r.created_at FROM reviews r WHERE r.task_id=tasks.id AND r.submission_version=tasks.submission_version AND r.decision=\'accept\' ORDER BY r.created_at DESC,r.id DESC LIMIT 1) ELSE NULL END AS accepted_at,(SELECT count(*)::int FROM task_updates u WHERE u.task_id=tasks.id AND u.org_id=tasks.org_id) AS update_count,(SELECT json_build_object(\'ai_status\',c.ai_status,\'ai_score\',c.ai_score,\'ai_summary\',c.ai_summary,\'human_score\',c.human_score,\'final_score\',COALESCE(c.human_score,CASE WHEN c.ai_status=\'scored\' THEN c.ai_score END),\'score_source\',CASE WHEN c.human_score IS NOT NULL THEN \'human\' WHEN c.ai_status=\'scored\' THEN \'ai\' END,\'created_at\',c.created_at,\'score_due_at\',c.created_at+interval \'24 hours\') FROM task_completions c WHERE c.task_id=tasks.id AND c.superseded_at IS NULL ORDER BY c.created_at DESC LIMIT 1) AS completion,(SELECT max(u.created_at) FROM task_updates u WHERE u.task_id=tasks.id) AS last_update_at,(SELECT count(*)::int FROM task_attachments a WHERE a.task_id=tasks.id) AS attachment_count,'+TASK_SOURCE_COLUMNS+' FROM tasks WHERE org_id=$1 AND owner_id=$2 AND archived_at IS NULL ORDER BY created_at,id LIMIT 1000',[user.org_id,target.id])).rows;
  const ids=tasks.map((t:any)=>t.id);
  const allChildren=ids.length?(await db.query('SELECT parent_task_id,board_status,board_done_at FROM tasks WHERE parent_task_id=ANY($1::text[]) AND archived_at IS NULL',[ids])).rows:[];
  const groups=await personalGroups(db,target),known=new Set(groups.map((g:any)=>g.id)),first=groups[0]?.id||'todo';
  const now=Date.now(),items=tasks.map((t:any)=>{const g=effectiveGroup(t,allChildren,now);return {...t,effective_group_id:known.has(g)?g:first};});
  const view=(await db.query('SELECT data FROM task_board_views WHERE user_id=$1 AND org_id=$2',[user.id,user.org_id])).rows[0]?.data;
  return {items,config:{...config.data,groups},version:config.version,view:view||{sort:[{field:'priority',direction:'asc'},{field:'due',direction:'asc'},{field:'category',direction:'asc'}],groupBy:'group',hidden:[],collapsed:[]},scope:{kind:'personal',person:target.id,personName:target.display_name,readOnly},serverNow:new Date(now).toISOString(),limit:1000};
 });
 // Personal groups: add, rename, recolour, reorder and delete. Deleting a group moves its tasks to another group.
 app.post('/task-board/groups',async req=>{
  const user=actor(req.actor),v=z.object({groups:z.array(group).min(1).max(40),remove:z.object({id,moveTo:id}).strict().optional()}).strict().parse(req.body);
  const list=v.groups.filter(g=>g.id!=='completed');
  if(!list.length)deny(400,'GROUP_REQUIRED','Keep at least one group','至少保留一个分组。');
  if(new Set(list.map(g=>g.id)).size!==list.length)deny(400,'INVALID_BOARD_GROUP','Group names must be unique','分组不能重复。');
  return db.transaction(async tx=>{
   if(v.remove){
    if(v.remove.id==='completed')deny(400,'INVALID_BOARD_GROUP','The Completed group is managed automatically','“已完成”分组由系统自动管理，不能删除。');
    if(!list.some(g=>g.id===v.remove!.moveTo))deny(400,'INVALID_BOARD_GROUP','Choose a group to move the tasks to','请选择把任务移到哪个分组。');
    await tx.query('UPDATE tasks SET board_group_id=$3,version=version+1,updated_at=now(),updated_by=$2 WHERE org_id=$1 AND owner_id=$2 AND board_group_id=$4',[user.org_id,user.id,v.remove.moveTo,v.remove.id]);
   }
   await tx.query('INSERT INTO task_board_personal(user_id,org_id,groups) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET groups=$3,updated_at=now()',[user.id,user.org_id,JSON.stringify(list)]);
   await log(tx,user,'task_board.groups.updated',user.id,{count:list.length,removed:v.remove?.id||null},user.id);
   return {groups:await personalGroups(tx,user)};
  });
 });
 app.post('/task-board/config',async req=>{
  const user=actor(req.actor),v=configInput.parse(req.body);if(user.role!=='manager')deny(403,'FORBIDDEN','A manager must edit shared board settings');
  return db.transaction(async tx=>{await boardConfig(tx,user);const old=(await tx.query('SELECT * FROM task_board_config WHERE org_id=$1 AND department_id=$2 FOR UPDATE',[user.org_id,user.department_id])).rows[0];
   if(old.version!==v.expectedVersion)deny(409,'VERSION_CONFLICT','Board settings changed; reload before saving');
   // Groups are personal now (see /task-board/groups); a request without groups keeps the department defaults.
   const groups=v.groups||old.data.groups;
   const removed=old.data.groups.filter((g:any)=>!groups.some((x:any)=>x.id===g.id));
   if(removed.length){const used=await tx.query('SELECT id FROM tasks WHERE org_id=$1 AND department_id=$2 AND board_group_id=ANY($3::text[]) LIMIT 1',[user.org_id,user.department_id,removed.map((x:any)=>x.id)]);if(used.rows.length)deny(400,'GROUP_NOT_EMPTY','Move tasks before removing their group');}
   // Labels already used by records cannot disappear silently.
   const removedCats=old.data.category.filter((g:any)=>!v.category.some(x=>x.id===g.id));
   if(removedCats.length&&(await tx.query('SELECT id FROM tasks WHERE org_id=$1 AND department_id=$2 AND board_category=ANY($3::text[]) LIMIT 1',[user.org_id,user.department_id,removedCats.map((x:any)=>x.id)])).rows.length)deny(400,'LABEL_IN_USE','A category is in use');
   const {expectedVersion,...rest}=v,data={...rest,groups};
   await tx.query('UPDATE task_board_config SET version=version+1,data=$3 WHERE org_id=$1 AND department_id=$2',[user.org_id,user.department_id,JSON.stringify(data)]);
   await log(tx,user,'task_board.config.updated',user.department_id,{version:old.version+1});return {config:data,version:old.version+1};
  });
 });
 app.post('/task-board/view',async req=>{const user=actor(req.actor),v=viewInput.parse(req.body);await db.query('INSERT INTO task_board_views(user_id,org_id,data) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET org_id=excluded.org_id,data=excluded.data',[user.id,user.org_id,JSON.stringify(v)]);return {saved:true};});
 app.get<{Params:{id:string}}>('/tasks/:id/updates',async req=>{
  const user=actor(req.actor),task=(await db.query('SELECT * FROM tasks WHERE id=$1',[id.parse(req.params.id)])).rows[0];
  if(!visibleTask(user,task))deny(404,'NOT_FOUND','Task not found');
  const items=(await db.query('SELECT u.id,u.body,u.created_at,u.edited_at,u.actor_id,p.display_name FROM task_updates u JOIN users p ON p.id=u.actor_id WHERE u.task_id=$1 AND u.org_id=$2 ORDER BY u.created_at DESC,u.id DESC LIMIT 2000',[task.id,user.org_id])).rows.reverse();
  return {items:items.map((x:any)=>({...x,mine:x.actor_id===user.id})),limit:200,notificationsSent:false};
 });
 // Only the author can edit or delete their own update. The original text stays in the audit log.
 const ownUpdate=async(tx:any,user:any,taskId:string,updateId:string)=>{
  const task=(await tx.query('SELECT * FROM tasks WHERE id=$1',[taskId])).rows[0];if(!visibleTask(user,task))deny(404,'NOT_FOUND','Task not found');
  const u=(await tx.query('SELECT * FROM task_updates WHERE id=$1 AND task_id=$2 AND org_id=$3 FOR UPDATE',[updateId,taskId,user.org_id])).rows[0];
  if(!u)deny(404,'NOT_FOUND','Update not found');
  if(u.actor_id!==user.id)deny(403,'UPDATE_AUTHOR_ONLY','Only the author can edit or delete this update');
  return {task,u};
 };
 app.post<{Params:{id:string;updateId:string}}>('/tasks/:id/updates/:updateId/edit',async req=>{
  const user=actor(req.actor),taskId=id.parse(req.params.id),updateId=id.parse(req.params.updateId),v=z.object({body:z.string().trim().min(1).max(10000)}).strict().parse(req.body);
  return db.transaction(async tx=>{
   const {task,u}=await ownUpdate(tx,user,taskId,updateId);
   if(u.body===v.body)return {id:u.id,body:u.body,edited_at:u.edited_at};
   const row=(await tx.query('UPDATE task_updates SET body=$2,edited_at=now() WHERE id=$1 RETURNING id,body,edited_at',[u.id,v.body])).rows[0];
   await log(tx,user,'task.update.edited',taskId,{updateId:u.id,before:u.body},task.owner_id);
   return row;
  });
 });
 app.delete<{Params:{id:string;updateId:string}}>('/tasks/:id/updates/:updateId',async req=>{
  const user=actor(req.actor),taskId=id.parse(req.params.id),updateId=id.parse(req.params.updateId);
  return db.transaction(async tx=>{
   const {task,u}=await ownUpdate(tx,user,taskId,updateId);
   await tx.query('DELETE FROM task_updates WHERE id=$1',[u.id]);
   await log(tx,user,'task.update.deleted',taskId,{updateId:u.id,body:u.body,postedAt:u.created_at},task.owner_id);
   return {deleted:true};
  });
 });
 app.post<{Params:{id:string}}>('/tasks/:id/updates',async(req,reply)=>{
  const user=actor(req.actor),taskId=id.parse(req.params.id),v=z.object({requestId:z.string().uuid(),expectedVersion:z.number().int().positive().optional(),body:z.string().trim().min(1).max(10000)}).strict().parse(req.body);
  return db.transaction(async tx=>{
   const task=(await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];if(!visibleTask(user,task))deny(404,'NOT_FOUND','Task not found');
   const old=(await tx.query('SELECT * FROM task_updates WHERE id=$1',[v.requestId])).rows[0];
   if(old){if(old.task_id!==taskId||old.org_id!==user.org_id||old.actor_id!==user.id||old.body!==v.body)deny(409,'VERSION_CONFLICT','Update request already used');return {id:old.id,stored:true,notificationsSent:false};}
   // Updates are an append-only log: post as many as needed, even while others edit the task.
   await tx.query('INSERT INTO task_updates(id,task_id,org_id,actor_id,body) VALUES($1,$2,$3,$4,$5)',[v.requestId,taskId,user.org_id,user.id,v.body]);
   // The owner's first progress update starts the task; an update also revives an abandoned one.
   if(user.id===task.owner_id&&['not_started','abandoned'].includes(task.board_status))await tx.query("UPDATE tasks SET board_status=CASE WHEN due_at<now() THEN 'overdue' ELSE 'working' END,version=version+1,updated_at=now() WHERE id=$1",[taskId]);
   await log(tx,user,'task.update.posted',taskId,{updateId:v.requestId,acceptanceUnchanged:true},task.owner_id);
   await pushInbox(tx,{orgId:task.org_id,recipients:taskFollowers(task),actorId:user.id,kind:'task_update',taskId,title:task.title,body:v.body});
   reply.code(201);return {id:v.requestId,stored:true,notificationsSent:false};
  });
 });
 /* One board edit (status, group, priority, due date, owner…) with every permission and lock rule. The single-task
  * route and the bulk bar both use it, so a batch can never do more than editing the rows one by one. */
 async function boardPatch(tx:Queryable,user:User,taskId:string,v:z.infer<typeof patchInput>){
   const task=(await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
   if(!task||task.archived_at)deny(404,'NOT_FOUND','Task not found');
   // Overseers may move a task's due date even when the task is not theirs: anyone above the owner in the
   // reporting line, the admin of the task's project, and company administrators. Only the due date.
   const overseer=!!task&&task.org_id===user.org_id&&task.owner_id!==user.id&&(o.isAdmin?.(user)||(await reportsSet(tx,user.org_id,user.id)).has(task.owner_id)||(!!task.project_id&&(await tx.query('SELECT 1 FROM projects WHERE id=$1 AND owner_id=$2',[task.project_id,user.id])).rows.length>0));
   if(!visibleTask(user,task)&&!overseer)deny(404,'NOT_FOUND','Task not found');
   const onlyDue=Object.keys(v).every(k=>k==='expectedVersion'||k==='dueAt');
   if(!visibleTask(user,task)&&!onlyDue)deny(403,'OVERSEER_DUE_ONLY','As their manager or project admin you can change the due date of this task, nothing else','你可以修改下属或项目内任务的截止时间，其他内容由负责人修改。');
   if(task.version!==v.expectedVersion)deny(409,'VERSION_CONFLICT','Task changed; reload before saving');
   const config=(await boardConfig(tx,user)).data;
   if(v.priority!==undefined&&!config.priority.some((x:any)=>x.id===v.priority))deny(400,'INVALID_BOARD_LABEL','Select an existing board label');
   if(v.category&&!config.category.some((x:any)=>x.id===v.category))deny(400,'INVALID_BOARD_LABEL','Select an existing board label');
   const ownGroups=v.groupId?[...await personalGroups(tx,user),...(task.owner_id!==user.id?await personalGroups(tx,{...user,id:task.owner_id} as User):[])]:[];
   if(v.groupId&&((!config.groups.some((x:any)=>x.id===v.groupId)&&!ownGroups.some((x:any)=>x.id===v.groupId))||v.groupId==='completed'))deny(400,'INVALID_BOARD_GROUP','Completed is managed by the three-day completion rule');
   if(v.groupId&&user.role!=='manager'&&(await tx.query('SELECT id FROM tasks WHERE parent_task_id=$1 AND owner_id<>$2 AND archived_at IS NULL LIMIT 1',[taskId,user.id])).rows.length)deny(403,'FORBIDDEN','A manager must move a parent with other owners');
   if(v.groupId&&task.parent_task_id)deny(400,'INVALID_BOARD_GROUP','Move the parent task to move its subitems');
   // Tasks that come from an OKR, a project or a direct assignment keep their definition: the assignee updates
   // status and progress but cannot rewrite the title, due date, owner, reviewer or priority.
   const source=task.source||(task.kr_id?'okr':task.created_by!==task.owner_id?'direct':'self'),definer=task.assigned_by||task.created_by;
   if(source!=='self'&&user.id===task.owner_id&&user.id!==task.reviewer_id&&user.id!==definer&&(v.title!==undefined||v.dueAt!==undefined||v.ownerId!==undefined||v.reviewerId!==undefined||v.priority!==undefined||v.description!==undefined||v.criteria!==undefined))deny(403,'TASK_DEFINITION_LOCKED','This task comes from an OKR, a project or an assignment; only the person who set it can change its definition','这条任务来自 OKR、项目或他人下达，只有设定任务的人可以修改名称、截止日期、优先级和负责人。');
   let owner=task.owner_id,reviewer=task.reviewer_id;
   if((v.ownerId&&v.ownerId!==task.owner_id||v.reviewerId&&v.reviewerId!==task.reviewer_id)&&task.submission_version>0)deny(409,'TASK_REASSIGNMENT_LOCKED','Tasks with submitted evidence keep their original owner and reviewer');
   if(v.ownerId||v.reviewerId){if(user.role!=='manager')deny(403,'FORBIDDEN','A manager must reassign tasks');owner=v.ownerId||owner;reviewer=v.reviewerId||reviewer;
    const people=(await tx.query('SELECT * FROM users WHERE id=ANY($1::text[]) AND org_id=$2 AND active=true',[[owner,reviewer],user.org_id])).rows;
    const ownerRow=people.find(p=>p.id===owner&&p.department_id===user.department_id),reviewerRow=people.find(p=>p.id===reviewer);
    if(!ownerRow||!reviewerAllowed(ownerRow,reviewerRow,user.org_id,user.department_id))deny(400,'INVALID_REVIEWER','Select an active owner and a different authorized reviewer');
   }
   // The deliverable standard is what the result is judged against: it is fixed once evidence has been submitted.
   if(v.criteria!==undefined&&task.submission_version>0&&JSON.stringify(v.criteria)!==JSON.stringify(task.criteria))deny(409,'CRITERIA_LOCKED','The acceptance criteria cannot change after evidence was submitted','已经提交过成果的任务，验收标准不能再修改。');
   if(v.status==='done'&&task.board_status!=='done')deny(409,'COMPLETION_RESULT_REQUIRED','Write the result and a self-evaluation to complete this task');
   if(v.status&&v.status!=='done'&&task.board_status==='done'&&task.board_done_at&&Date.now()-new Date(task.board_done_at).getTime()>=COMPLETION_LOCK_MS)deny(409,'COMPLETION_LOCKED','This task was completed more than 3 days ago; its result and score are locked');
   const status=v.status??task.board_status,doneAt=status==='done'?(task.board_status==='done'&&task.board_done_at?task.board_done_at:new Date().toISOString()):null;
   const next=(await tx.query('UPDATE tasks SET title=$2,board_priority=$3,board_status=$4,board_category=$5,board_group_id=$6,board_notes=$7,due_at=$8,owner_id=$9,reviewer_id=$10,board_done_at=$11,updated_at=now(),updated_by=$12,version=version+1 WHERE id=$1 RETURNING *',[taskId,v.title??task.title,v.priority??task.board_priority,status,v.category??task.board_category,v.groupId??task.board_group_id,v.notes??task.board_notes,v.dueAt??task.due_at,owner,reviewer,doneAt,user.id])).rows[0];
   if(v.description!==undefined||v.criteria!==undefined){const d=(await tx.query('UPDATE tasks SET description=$2,criteria=$3 WHERE id=$1 RETURNING description,criteria',[taskId,v.description??task.description,JSON.stringify(v.criteria??task.criteria)])).rows[0];Object.assign(next,d);}
   if(v.groupId)await tx.query('UPDATE tasks SET board_group_id=$2,version=version+1,updated_at=now(),updated_by=$3 WHERE parent_task_id=$1 AND org_id=$4 AND department_id=$5 AND archived_at IS NULL',[taskId,v.groupId,user.id,user.org_id,user.department_id]);
   await log(tx,user,'task.board.updated',taskId,{fields:Object.keys(v).filter(k=>k!=='expectedVersion'),version:next.version,acceptanceUnchanged:true},owner);return next;
 }
 app.post<{Params:{id:string}}>('/tasks/:id/board',async req=>{
  const user=actor(req.actor),v=patchInput.parse(req.body),taskId=id.parse(req.params.id);
  return db.transaction(tx=>boardPatch(tx,user,taskId,v));
 });
 /* Bulk bar: the same edit applied to up to 200 ticked rows. Each row is saved on its own with the single-row rules;
  * a row that may not change (locked definition, version conflict, no right to reassign…) is reported, not fatal. */
 app.post('/tasks/batch-board',async req=>{
  const user=actor(req.actor),v=batchBoardInput.parse(req.body),lang=langOf(req);
  const updated:string[]=[],skipped:Skipped[]=[];
  for(const item of uniqueItems(v.items)){
   try{const next=await db.transaction(tx=>boardPatch(tx,user,item.id,{expectedVersion:item.expectedVersion,...v.changes} as any));updated.push(next.id);}
   catch(e){if(!(e instanceof ApiError))throw e;skipped.push(skip(item.id,e,lang));}
  }
  return {updated,skipped};
 });
 /* Delete = soft delete (archived_at). Archived tasks leave every list, report and leaderboard; undo restores them.
  * Allowed: administrators, and whoever created or assigned the task (so your own tasks, not ones others gave you).
  * A task generated from an OKR key result stays while that key result exists: delete the KR in the OKR instead. */
 const definer=(t:any)=>t.assigned_by||t.created_by;
 const okrKrAlive=async(tx:Queryable,t:any)=>!!t.kr_id&&(t.source==='okr'||!t.source)&&(await tx.query('SELECT 1 FROM key_results k JOIN objectives o ON o.id=k.objective_id WHERE k.id=$1 AND k.archived_at IS NULL AND o.archived_at IS NULL',[t.kr_id])).rows.length>0;
 const archiveRefusal=async(tx:Queryable,user:User,t:any):Promise<ApiError|null>=>{
  if(!t||t.org_id!==user.org_id||t.archived_at||!(visibleTask(user,t)||o.isAdmin?.(user)))return new ApiError(404,'NOT_FOUND','Task not found');
  if(await okrKrAlive(tx,t))return new ApiError(409,'TASK_FROM_OKR','Tasks from an OKR are deleted by deleting their key result in the OKR');
  if(!o.isAdmin?.(user)&&definer(t)!==user.id)return new ApiError(403,'TASK_ARCHIVE_FORBIDDEN','You can delete tasks you created; ask whoever assigned this task, or an administrator');
  return null;
 };
 app.post('/tasks/batch-archive',async req=>{
  const user=actor(req.actor),v=idsInput.parse(req.body),lang=langOf(req),ids=[...new Set(v.ids)];
  return db.transaction(async tx=>{
   const rows=new Map((await tx.query('SELECT * FROM tasks WHERE id=ANY($1::text[]) AND org_id=$2 FOR UPDATE',[ids,user.org_id])).rows.map((t:any)=>[t.id,t]));
   const archived:string[]=[],skipped:Skipped[]=[],withChildren=new Map<string,string>();
   for(const taskId of ids){
    const t=rows.get(taskId),refusal=await archiveRefusal(tx,user,t);
    if(refusal){skipped.push(skip(taskId,refusal,lang,t?.title));continue;}
    // Subitems go with their parent, so each must be one this person could delete on its own.
    const kids=(await tx.query('SELECT * FROM tasks WHERE parent_task_id=$1 AND archived_at IS NULL FOR UPDATE',[taskId])).rows;
    let blocked=false;for(const k of kids)if(!ids.includes(k.id)&&await archiveRefusal(tx,user,k)){blocked=true;break;}
    if(blocked){skipped.push(skip(taskId,new ApiError(403,'TASK_CHILD_FORBIDDEN','A subitem of this task is not yours to delete, so the task was kept'),lang,t.title));continue;}
    archived.push(taskId);for(const k of kids)if(!ids.includes(k.id))withChildren.set(k.id,taskId);
   }
   const all=[...archived,...withChildren.keys()];
   if(all.length){
    await tx.query('UPDATE tasks SET archived_at=now(),archived_by=$2,version=version+1,updated_at=now(),updated_by=$2 WHERE id=ANY($1::text[])',[all,user.id]);
    for(const taskId of all){const t=rows.get(taskId)||(await tx.query('SELECT owner_id,title FROM tasks WHERE id=$1',[taskId])).rows[0];await log(tx,user,'task.archived',taskId,{title:t.title,withParent:withChildren.get(taskId)||null},t.owner_id);}
   }
   return {archived:all,count:archived.length,skipped};
  });
 });
 app.post('/tasks/batch-restore',async req=>{
  const user=actor(req.actor),v=idsInput.parse(req.body),lang=langOf(req),ids=[...new Set(v.ids)];
  return db.transaction(async tx=>{
   const rows=new Map((await tx.query('SELECT * FROM tasks WHERE id=ANY($1::text[]) AND org_id=$2 FOR UPDATE',[ids,user.org_id])).rows.map((t:any)=>[t.id,t]));
   const restored:string[]=[],skipped:Skipped[]=[];
   for(const taskId of ids){
    const t=rows.get(taskId);
    if(!t||!(visibleTask(user,{...t,archived_at:null})||o.isAdmin?.(user))){skipped.push(skip(taskId,new ApiError(404,'NOT_FOUND','Task not found'),lang));continue;}
    if(!t.archived_at){skipped.push(skip(taskId,new ApiError(409,'TASK_NOT_ARCHIVED','This task is not deleted'),lang,t.title));continue;}
    if(!o.isAdmin?.(user)&&t.archived_by!==user.id&&definer(t)!==user.id){skipped.push(skip(taskId,new ApiError(403,'TASK_RESTORE_FORBIDDEN','Only the person who deleted this task, its creator or an administrator can restore it'),lang,t.title));continue;}
    const parent=t.parent_task_id&&!ids.includes(t.parent_task_id)?(await tx.query('SELECT archived_at FROM tasks WHERE id=$1',[t.parent_task_id])).rows[0]:null;
    if(parent?.archived_at){skipped.push(skip(taskId,new ApiError(409,'TASK_PARENT_ARCHIVED','Restore the parent task first'),lang,t.title));continue;}
    restored.push(taskId);
   }
   // Subitems that were deleted together with a restored parent come back with it.
   const kids=restored.length?(await tx.query('SELECT c.id FROM tasks c JOIN tasks p ON p.id=c.parent_task_id WHERE c.parent_task_id=ANY($1::text[]) AND c.archived_at IS NOT NULL AND c.archived_at=p.archived_at',[restored])).rows.map((r:any)=>r.id).filter((x:string)=>!restored.includes(x)):[];
   const all=[...restored,...kids];
   if(all.length){
    await tx.query('UPDATE tasks SET archived_at=NULL,archived_by=NULL,version=version+1,updated_at=now(),updated_by=$2 WHERE id=ANY($1::text[])',[all,user.id]);
    for(const taskId of all){const t=rows.get(taskId)||(await tx.query('SELECT owner_id,title FROM tasks WHERE id=$1',[taskId])).rows[0];await log(tx,user,'task.restored',taskId,{title:t.title},t.owner_id);}
   }
   return {restored:all,count:restored.length,skipped};
  });
 });
}
type Skipped={id:string;title?:string;code:string;message:string};
const langOf=(req:any):Language=>req.language==='en'?'en':'zh';
const skip=(taskId:string,e:ApiError,lang:Language,title?:string):Skipped=>({id:taskId,...(title?{title}:{}),code:e.code,message:e.zh&&lang!=='en'?e.zh:message(e.message,lang)});
const uniqueItems=<T extends {id:string}>(items:T[])=>[...new Map(items.map(x=>[x.id,x])).values()];
const idsInput=z.object({ids:z.array(id).min(1).max(200)}).strict();
const batchBoardInput=z.object({
 items:z.array(z.object({id,expectedVersion:z.number().int().positive()}).strict()).min(1).max(200),
 changes:z.object({status:z.enum(['working','hold','review','done','not_started','overdue','abandoned']).optional(),groupId:id.optional(),priority:z.string().max(80).optional(),dueAt:z.string().datetime({offset:true}).optional(),ownerId:id.optional(),reviewerId:id.optional()}).strict().refine(c=>Object.keys(c).length>0)
}).strict();
async function log(tx:Queryable,user:User,action:string,object:string,details:unknown,owner=user.id){await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),user.org_id,user.department_id,owner,user.id,action,object,JSON.stringify(details)]);}
