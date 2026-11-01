import { COMPLETION_LOCK_MS } from './completions.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { visibleTask, reviewerAllowed } from './domain.js';
import { TASK_SOURCE_COLUMNS } from './assign.js';
import { deny } from './errors.js';

export const boardSchema = `
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
`;
const id=z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const color=z.string().regex(/^#[0-9a-fA-F]{6}$/);
const label=z.object({id:z.string().max(80).regex(/^[A-Za-z0-9_-]*$/),en:z.string().trim().min(1).max(80),zh:z.string().trim().min(1).max(80),color}).strict();
const group=z.object({id,en:z.string().trim().min(1).max(100),zh:z.string().trim().min(1).max(100),color}).strict();
const statusIds=['working','hold','review','done','not_started','overdue','abandoned'];
const priorityIds=['urgent','high','medium','low',''];
// Status rules: Not started is automatic; the first progress update moves a task to Working; past the due date
// Not started / Working tasks become Overdue (On hold never does); 15 days without any update means Abandoned.
const STATUS_LABELS=[{id:'not_started',en:'Not started',zh:'未开始',color:'#797e93'},{id:'working',en:'Working on it',zh:'进行中',color:'#fdbc65'},{id:'hold',en:'Paused',zh:'被暂停',color:'#df7689'},{id:'review',en:'Awaiting approval',zh:'待审批',color:'#b483d7'},{id:'done',en:'Done',zh:'完成',color:'#34d391'},{id:'overdue',en:'Overdue',zh:'延期',color:'#e2445c'},{id:'abandoned',en:'Abandoned',zh:'放弃',color:'#4b4f5c'}];
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
const configInput=z.object({expectedVersion:z.number().int().positive(),groups:z.array(group).min(2).max(40),status:z.array(label).min(5).max(7),priority:z.array(label).length(5),category:z.array(label).max(40)}).strict().superRefine((v,c)=>{
 for(const k of ['groups','status','priority','category'] as const)if(new Set(v[k].map(x=>x.id)).size!==v[k].length)c.addIssue({code:'custom',path:[k],message:'Duplicate labels'});
 if(!['todo','completed'].every(x=>v.groups.some(g=>g.id===x)))c.addIssue({code:'custom',path:['groups'],message:'Default groups required'});
 if(!statusIds.every(x=>v.status.some(g=>g.id===x))||!priorityIds.every(x=>v.priority.some(g=>g.id===x)))c.addIssue({code:'custom',path:['status'],message:'Stable label identifiers required'});
 if(v.category.some(x=>!x.id))c.addIssue({code:'custom',path:['category'],message:'Blank category is reserved'});
});
const width=z.number().int().min(64).max(700);
const viewInput=z.object({sort:z.array(z.object({field:z.enum(['priority','due','category','title','updated','status']),direction:z.enum(['asc','desc'])}).strict()).max(5),groupBy:z.enum(['group','priority','status','category','owner','due']),hidden:z.array(z.enum(['owner','priority','status','category','due','notes','updated'])).max(7),collapsed:z.array(id).max(200),display:z.enum(['table','kanban','calendar','dashboard']).optional(),scope:z.enum(['team','mine']).optional(),showWeekends:z.boolean().optional(),widths:z.object({title:z.number().int().min(180).max(700).optional(),owner:width.optional(),priority:width.optional(),status:width.optional(),category:width.optional(),due:width.optional(),notes:width.optional(),updated:width.optional()}).strict().optional()}).strict();
const patchInput=z.object({expectedVersion:z.number().int().positive(),title:z.string().trim().min(3).max(200).optional(),priority:z.string().max(80).optional(),status:z.enum(['working','hold','review','done','not_started','overdue','abandoned']).optional(),category:z.string().max(80).optional(),groupId:id.optional(),notes:z.string().max(10000).optional(),dueAt:z.string().datetime({offset:true}).optional(),ownerId:id.optional(),reviewerId:id.optional()}).strict().refine(v=>Object.keys(v).length>1);
export async function boardConfig(tx:Queryable,user:User){
 await tx.query('INSERT INTO task_board_config(org_id,department_id,data) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[user.org_id,user.department_id,JSON.stringify(defaultBoardConfig())]);
 const row=(await tx.query('SELECT * FROM task_board_config WHERE org_id=$1 AND department_id=$2',[user.org_id,user.department_id])).rows[0];
 // Older boards had five statuses: add Overdue / Abandoned and adopt the new names for untouched defaults.
 if(row&&!['overdue','abandoned'].every(id=>row.data.status.some((x:any)=>x.id===id))){
  const renamed:Record<string,string>={暂缓:'被暂停',待检查:'待审批'},data={...row.data,status:STATUS_LABELS.map(d=>{const old=row.data.status.find((x:any)=>x.id===d.id);return old?{...old,zh:renamed[old.zh]||old.zh,en:old.en==='On-Hold'?'Paused':old.en==='Review'?'Awaiting approval':old.en}:{...d};})};
  const up=(await tx.query('UPDATE task_board_config SET data=$3,version=version+1 WHERE org_id=$1 AND department_id=$2 RETURNING *',[user.org_id,user.department_id,JSON.stringify(data)])).rows[0];return up;
 }
 return row;
}
export async function validateBoardCreation(tx:Queryable,user:User,input:any){
 const config=(await boardConfig(tx,user)).data;
 for(const [key,list] of [['boardPriority','priority'],['boardCategory','category']] as const)if(input[key]&&!config[list].some((x:any)=>x.id===input[key]))deny(400,'INVALID_BOARD_LABEL','Select an existing board label');
 if(input.boardGroupId&&!config.groups.some((x:any)=>x.id===input.boardGroupId&&x.id!=='completed'))deny(400,'INVALID_BOARD_GROUP','Select an active group');
 if(input.parentTaskId){const parent=(await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[input.parentTaskId])).rows[0];if(!visibleTask(user,parent)||parent.parent_task_id)deny(400,'INVALID_PARENT','Select a visible top-level parent task');return parent.board_group_id==='completed'?'todo':parent.board_group_id;}
 return input.boardGroupId||'todo';
}
export function effectiveGroup(task:any,tasks:any[],now=Date.now()){
 const oldDone=(t:any)=>t.board_status==='done'&&t.board_done_at&&new Date(t.board_done_at).getTime()<=now-COMPLETION_LOCK_MS;
 return oldDone(task)&&tasks.filter(t=>t.parent_task_id===task.id).every(oldDone)?'completed':task.board_group_id;
}
export function registerTaskBoardRoutes(app:FastifyInstance,db:Database){
 const actor=(u:User|null)=>u||deny(401,'UNAUTHENTICATED','Authentication is required');
 app.get('/task-board',async req=>{
  const user=actor(req.actor);await applyAutoStatus(db,user.org_id);const config=await boardConfig(db,user);
  // Scope before any parent/group calculation: hidden tasks never contribute names or counts.
  const tasks=(await db.query('SELECT tasks.*,CASE WHEN tasks.status=\'accepted\' THEN (SELECT r.created_at FROM reviews r WHERE r.task_id=tasks.id AND r.submission_version=tasks.submission_version AND r.decision=\'accept\' ORDER BY r.created_at DESC,r.id DESC LIMIT 1) ELSE NULL END AS accepted_at,(SELECT count(*)::int FROM task_updates u WHERE u.task_id=tasks.id AND u.org_id=tasks.org_id) AS update_count,(SELECT json_build_object(\'ai_status\',c.ai_status,\'ai_score\',c.ai_score,\'ai_summary\',c.ai_summary) FROM task_completions c WHERE c.task_id=tasks.id AND c.superseded_at IS NULL ORDER BY c.created_at DESC LIMIT 1) AS completion,(SELECT max(u.created_at) FROM task_updates u WHERE u.task_id=tasks.id) AS last_update_at,(SELECT count(*)::int FROM task_attachments a WHERE a.task_id=tasks.id) AS attachment_count,'+TASK_SOURCE_COLUMNS+' FROM tasks WHERE org_id=$1 AND (department_id=$2 OR owner_id=$3 OR reviewer_id=$3) ORDER BY created_at,id LIMIT 1000',[user.org_id,user.department_id,user.id])).rows.filter((t:any)=>visibleTask(user,t));
  const allChildren=(await db.query('SELECT parent_task_id,board_status,board_done_at FROM tasks WHERE org_id=$1 AND department_id=$2 AND parent_task_id IS NOT NULL',[user.org_id,user.department_id])).rows;
  const now=Date.now(),items=tasks.map(t=>({...t,effective_group_id:effectiveGroup(t,allChildren,now)}));
  const view=(await db.query('SELECT data FROM task_board_views WHERE user_id=$1 AND org_id=$2',[user.id,user.org_id])).rows[0]?.data;
  return {items,config:config.data,version:config.version,view:view||{sort:[{field:'priority',direction:'asc'},{field:'due',direction:'asc'},{field:'category',direction:'asc'}],groupBy:'group',hidden:[],collapsed:[]},scope:{kind:user.role==='manager'?'department':'assigned',departmentId:user.department_id},serverNow:new Date(now).toISOString(),limit:1000};
 });
 app.post('/task-board/config',async req=>{
  const user=actor(req.actor),v=configInput.parse(req.body);if(user.role!=='manager')deny(403,'FORBIDDEN','A manager must edit shared board settings');
  return db.transaction(async tx=>{await boardConfig(tx,user);const old=(await tx.query('SELECT * FROM task_board_config WHERE org_id=$1 AND department_id=$2 FOR UPDATE',[user.org_id,user.department_id])).rows[0];
   if(old.version!==v.expectedVersion)deny(409,'VERSION_CONFLICT','Board settings changed; reload before saving');
   const removed=old.data.groups.filter((g:any)=>!v.groups.some(x=>x.id===g.id));
   if(removed.length){const used=await tx.query('SELECT id FROM tasks WHERE org_id=$1 AND department_id=$2 AND board_group_id=ANY($3::text[]) LIMIT 1',[user.org_id,user.department_id,removed.map((x:any)=>x.id)]);if(used.rows.length)deny(400,'GROUP_NOT_EMPTY','Move tasks before removing their group');}
   // Labels already used by records cannot disappear silently.
   const removedCats=old.data.category.filter((g:any)=>!v.category.some(x=>x.id===g.id));
   if(removedCats.length&&(await tx.query('SELECT id FROM tasks WHERE org_id=$1 AND department_id=$2 AND board_category=ANY($3::text[]) LIMIT 1',[user.org_id,user.department_id,removedCats.map((x:any)=>x.id)])).rows.length)deny(400,'LABEL_IN_USE','A category is in use');
   const {expectedVersion,...data}=v;
   await tx.query('UPDATE task_board_config SET version=version+1,data=$3 WHERE org_id=$1 AND department_id=$2',[user.org_id,user.department_id,JSON.stringify(data)]);
   await log(tx,user,'task_board.config.updated',user.department_id,{version:old.version+1});return {config:data,version:old.version+1};
  });
 });
 app.post('/task-board/view',async req=>{const user=actor(req.actor),v=viewInput.parse(req.body);await db.query('INSERT INTO task_board_views(user_id,org_id,data) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET org_id=excluded.org_id,data=excluded.data',[user.id,user.org_id,JSON.stringify(v)]);return {saved:true};});
 app.get<{Params:{id:string}}>('/tasks/:id/updates',async req=>{
  const user=actor(req.actor),task=(await db.query('SELECT * FROM tasks WHERE id=$1',[id.parse(req.params.id)])).rows[0];
  if(!visibleTask(user,task))deny(404,'NOT_FOUND','Task not found');
  const items=(await db.query('SELECT u.id,u.body,u.created_at,u.actor_id,p.display_name FROM task_updates u JOIN users p ON p.id=u.actor_id WHERE u.task_id=$1 AND u.org_id=$2 ORDER BY u.created_at DESC,u.id DESC LIMIT 2000',[task.id,user.org_id])).rows.reverse();
  return {items,limit:200,notificationsSent:false};
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
   reply.code(201);return {id:v.requestId,stored:true,notificationsSent:false};
  });
 });
 app.post<{Params:{id:string}}>('/tasks/:id/board',async req=>{
  const user=actor(req.actor),v=patchInput.parse(req.body),taskId=id.parse(req.params.id);
  return db.transaction(async tx=>{
   const task=(await tx.query('SELECT * FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];if(!visibleTask(user,task))deny(404,'NOT_FOUND','Task not found');
   if(task.version!==v.expectedVersion)deny(409,'VERSION_CONFLICT','Task changed; reload before saving');
   const config=(await boardConfig(tx,user)).data;
   if(v.priority!==undefined&&!config.priority.some((x:any)=>x.id===v.priority))deny(400,'INVALID_BOARD_LABEL','Select an existing board label');
   if(v.category&&!config.category.some((x:any)=>x.id===v.category))deny(400,'INVALID_BOARD_LABEL','Select an existing board label');
   if(v.groupId&&(!config.groups.some((x:any)=>x.id===v.groupId)||v.groupId==='completed'))deny(400,'INVALID_BOARD_GROUP','Completed is managed by the three-day completion rule');
   if(v.groupId&&user.role!=='manager'&&(await tx.query('SELECT id FROM tasks WHERE parent_task_id=$1 AND owner_id<>$2 LIMIT 1',[taskId,user.id])).rows.length)deny(403,'FORBIDDEN','A manager must move a parent with other owners');
   if(v.groupId&&task.parent_task_id)deny(400,'INVALID_BOARD_GROUP','Move the parent task to move its subitems');
   // Tasks that come from an OKR, a project or a direct assignment keep their definition: the assignee updates
   // status and progress but cannot rewrite the title, due date, owner, reviewer or priority.
   const source=task.source||(task.kr_id?'okr':task.created_by!==task.owner_id?'direct':'self'),definer=task.assigned_by||task.created_by;
   if(source!=='self'&&user.id===task.owner_id&&user.id!==task.reviewer_id&&user.id!==definer&&(v.title!==undefined||v.dueAt!==undefined||v.ownerId!==undefined||v.reviewerId!==undefined||v.priority!==undefined))deny(403,'TASK_DEFINITION_LOCKED','This task comes from an OKR, a project or an assignment; only the person who set it can change its definition');
   let owner=task.owner_id,reviewer=task.reviewer_id;
   if((v.ownerId&&v.ownerId!==task.owner_id||v.reviewerId&&v.reviewerId!==task.reviewer_id)&&task.submission_version>0)deny(409,'TASK_REASSIGNMENT_LOCKED','Tasks with submitted evidence keep their original owner and reviewer');
   if(v.ownerId||v.reviewerId){if(user.role!=='manager')deny(403,'FORBIDDEN','A manager must reassign tasks');owner=v.ownerId||owner;reviewer=v.reviewerId||reviewer;
    const people=(await tx.query('SELECT * FROM users WHERE id=ANY($1::text[]) AND org_id=$2 AND active=true',[[owner,reviewer],user.org_id])).rows;
    const ownerRow=people.find(p=>p.id===owner&&p.department_id===user.department_id),reviewerRow=people.find(p=>p.id===reviewer);
    if(!ownerRow||!reviewerAllowed(ownerRow,reviewerRow,user.org_id,user.department_id))deny(400,'INVALID_REVIEWER','Select an active owner and a different authorized reviewer');
   }
   if(v.status==='done'&&task.board_status!=='done')deny(409,'COMPLETION_RESULT_REQUIRED','Write the result and a self-evaluation to complete this task');
   if(v.status&&v.status!=='done'&&task.board_status==='done'&&task.board_done_at&&Date.now()-new Date(task.board_done_at).getTime()>=COMPLETION_LOCK_MS)deny(409,'COMPLETION_LOCKED','This task was completed more than 3 days ago; its result and score are locked');
   const status=v.status??task.board_status,doneAt=status==='done'?(task.board_status==='done'&&task.board_done_at?task.board_done_at:new Date().toISOString()):null;
   const next=(await tx.query('UPDATE tasks SET title=$2,board_priority=$3,board_status=$4,board_category=$5,board_group_id=$6,board_notes=$7,due_at=$8,owner_id=$9,reviewer_id=$10,board_done_at=$11,updated_at=now(),updated_by=$12,version=version+1 WHERE id=$1 RETURNING *',[taskId,v.title??task.title,v.priority??task.board_priority,status,v.category??task.board_category,v.groupId??task.board_group_id,v.notes??task.board_notes,v.dueAt??task.due_at,owner,reviewer,doneAt,user.id])).rows[0];
   if(v.groupId)await tx.query('UPDATE tasks SET board_group_id=$2,version=version+1,updated_at=now(),updated_by=$3 WHERE parent_task_id=$1 AND org_id=$4 AND department_id=$5',[taskId,v.groupId,user.id,user.org_id,user.department_id]);
   await log(tx,user,'task.board.updated',taskId,{fields:Object.keys(v).filter(k=>k!=='expectedVersion'),version:next.version,acceptanceUnchanged:true},owner);return next;
  });
 });
}
async function log(tx:Queryable,user:User,action:string,object:string,details:unknown,owner=user.id){await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),user.org_id,user.department_id,owner,user.id,action,object,JSON.stringify(details)]);}
