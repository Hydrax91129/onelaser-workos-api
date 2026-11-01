import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { readOkrLegacySource } from './okr-import.js';

const weight=z.number().finite().positive().max(100);
const date=z.string().date();
export const objectivePlanning=z.object({
  period:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), weight,
  location:z.string().trim().max(100).default(''), description:z.string().trim().max(4000).default(''),
  type:z.enum(['mandatory','bonus']).default('mandatory'), bonusIncluded:z.boolean().default(false),
  scoringDueDate:date
}).strict();
export const krPlanning=z.object({weight,description:z.string().trim().max(4000).default(''),targetText:z.string().trim().max(120).optional()}).strict();
const score=z.number().int().refine(n=>[0,20,40,60,80,100].includes(n));
const id=z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const base={expectedVersion:z.number().int().positive(),score,note:z.string().trim().min(5).max(4000)};
const selfInput=z.object({...base,evidence:z.string().trim().min(10).max(20000)}).strict();
const managerInput=z.object({...base,selfAppraisalId:id,verifiedEvidence:z.literal(true)}).strict();
async function accessible(tx:Queryable,user:User,krId:string,lock=false){
  const kr=(await tx.query(`SELECT k.*,o.org_id,o.department_id,o.owner_id,o.planning AS objective_planning FROM key_results k JOIN objectives o ON o.id=k.objective_id WHERE k.id=$1 AND k.archived_at IS NULL AND o.archived_at IS NULL${lock?' FOR UPDATE OF k':''}`,[krId])).rows[0];
  // Personal evaluations are more restrictive than a generally visible department/company goal.
  if(!kr||kr.org_id!==user.org_id||kr.department_id!==user.department_id||(user.role!=='manager'&&kr.owner_id!==user.id))deny(404,'NOT_FOUND','Key result not found');
  return kr;
}
async function view(tx:Queryable,kr:any){
  const history=(await tx.query('SELECT * FROM kr_appraisals WHERE kr_id=$1 ORDER BY metric_version,created_at,id',[kr.id])).rows;
  const self=[...history].reverse().find(row=>row.kind==='self')||null;
  const manager=self?[...history].reverse().find(row=>row.kind==='manager'&&row.self_appraisal_id===self.id&&row.metric_version===kr.version):null;
  return {krId:kr.id,version:kr.version,self,manager:manager||null,history,policy:'human_confirmed_v1',legacyFormulaVerified:false,legacySource:await readOkrLegacySource(tx,'key_result',kr.id)};
}
export async function registerOkrRoutes(app:FastifyInstance,db:Database){
  app.get<{Params:{id:string}}>('/objectives/:id/source',async req=>{
    const user=req.actor!,objective=(await db.query('SELECT * FROM objectives WHERE id=$1',[id.parse(req.params.id)])).rows[0];
    if(!objective||objective.org_id!==user.org_id||objective.department_id!==user.department_id||(user.role!=='manager'&&objective.owner_id!==user.id))deny(404,'NOT_FOUND','Key result not found');
    return readOkrLegacySource(db,'objective',objective.id);
  });
  app.get<{Params:{id:string}}>('/key-results/:id/appraisal',async req=>{
    const user=req.actor!; return db.transaction(async tx=>view(tx,await accessible(tx,user,id.parse(req.params.id))));
  });
  for(const kind of ['self','manager'] as const){
    app.post<{Params:{id:string}}>(`/key-results/:id/${kind}-evaluation`,async(req,reply)=>{
      const user=req.actor!,input=kind==='self'?selfInput.parse(req.body):managerInput.parse(req.body);
      const result=await db.transaction(async tx=>{
        const kr=await accessible(tx,user,id.parse(req.params.id),true);
        if(kind==='self'&&kr.owner_id!==user.id)deny(403,'FORBIDDEN','Only the objective owner can self-evaluate');
        if(kind==='manager'&&(user.role!=='manager'||kr.owner_id===user.id))deny(403,'FORBIDDEN','A different manager must verify the result');
        if(kr.version!==input.expectedVersion)deny(409,'VERSION_CONFLICT','Key result changed; reload before recording');
        const current=await view(tx,kr);
        if(kind==='manager'&&(!current.self||current.self.id!==(input as z.infer<typeof managerInput>).selfAppraisalId||current.self.metric_version!==kr.version))deny(409,'VERSION_CONFLICT','Self evaluation changed; submit current evidence first');
        const version=kr.version+1,recordId=randomUUID();
        await tx.query('INSERT INTO kr_appraisals(id,kr_id,kind,score,note,evidence,author_id,self_appraisal_id,metric_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[recordId,kr.id,kind,input.score,input.note,kind==='self'?(input as z.infer<typeof selfInput>).evidence:'',user.id,kind==='manager'?current.self.id:null,version]);
        await tx.query('UPDATE key_results SET version=$2 WHERE id=$1',[kr.id,version]);
        await tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),user.org_id,kr.department_id,kr.owner_id,user.id,`kr.${kind}_evaluated`,kr.id,JSON.stringify({appraisalId:recordId,version,score:input.score,policy:'human_confirmed_v1'})]);
        return view(tx,{...kr,version});
      }); return reply.code(201).send(result);
    });
  }
}
