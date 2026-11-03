import { studioSchema } from './caldock-studio.js';
import { boardSchema } from './task-board.js';
import { okrCollabSchema } from './okr-collab.js';
import { orgSchema } from './org.js';
import { completionSchema } from './completions.js';
import { memberSchema } from './members.js';
import { translationSchema } from './translate.js';
import { assignSchema } from './assign.js';
import { okrScoreSchema } from './okr-scores.js';
import { projectSchema } from './projects.js';
import { wmsSchema } from './wms.js';
import { rmaSchema } from './rma.js';
import { productSchema } from './products.js';
import { inboxSchema } from './inbox.js';
import { feedbackSchema } from './feedback.js';
import { okrPublishSchema } from './okr-publish.js';
import { caldockSchema } from './caldock-schema.js';
import { dealerSchema } from './dealer.js';
import { supportSchema } from './support.js';
import { publicWikiSchema } from './public-wiki.js';
import { okrImportSchema } from './okr-import.js';
import { hrSchema } from './hr.js';
import { itSchema } from './it-accounts.js';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'pglite' | 'postgres';
}
export async function createDatabase(options: { connectionString?: string; dataDir?: string } = {}): Promise<Database> {
  if (options.connectionString) {
    const pool = new pg.Pool({ connectionString: options.connectionString, max: 5, connectionTimeoutMillis: 5000, query_timeout: 10000 });
    const wrap = (client: pg.Pool | pg.PoolClient): Queryable => ({
      async query<T>(sql: string, params: unknown[] = []) { return { rows: (await client.query(sql, params)).rows as T[] }; }
    });
    return {
      ...wrap(pool), kind: 'postgres',
      async exec(sql) { await pool.query(sql); },
      async transaction(fn) {
        const client = await pool.connect();
        try { await client.query('BEGIN'); const result = await fn(wrap(client)); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      },
      async close() { await pool.end(); }
    };
  }
  const db = await PGlite.create(options.dataDir || 'memory://');
  const wrap = (client: Pick<PGlite, 'query'>): Queryable => ({
    async query<T>(sql: string, params: unknown[] = []) { return { rows: (await client.query(sql, params)).rows as T[] }; }
  });
  return {
    ...wrap(db), kind: 'pglite',
    async exec(sql) { await db.exec(sql); },
    async transaction(fn) { return db.transaction(tx => fn(wrap(tx))); },
    async close() { await db.close(); }
  };
}

const coreSchema = `
CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, org_id text NOT NULL, department_id text NOT NULL,
 display_name text NOT NULL, role text NOT NULL CHECK (role IN ('employee','manager')), active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS csrf_token text;
CREATE TABLE IF NOT EXISTS departments (
 org_id text NOT NULL, id text NOT NULL, external_id text NOT NULL, name text NOT NULL,
 PRIMARY KEY(org_id,id)
);
CREATE TABLE IF NOT EXISTS external_identities (
 provider text NOT NULL, corp_id text NOT NULL, external_user_id text NOT NULL,
 union_id text NOT NULL, user_id text NOT NULL REFERENCES users(id),
 PRIMARY KEY(provider,corp_id,external_user_id), UNIQUE(provider,corp_id,user_id)
);
ALTER TABLE external_identities ADD COLUMN IF NOT EXISTS external_department_id text;
ALTER TABLE external_identities ADD COLUMN IF NOT EXISTS external_department_name text;
CREATE TABLE IF NOT EXISTS oauth_states (
 state_hash text PRIMARY KEY, nonce_hash text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS objectives (
 id text PRIMARY KEY, org_id text NOT NULL, department_id text,
 owner_id text REFERENCES users(id), level text NOT NULL CHECK(level IN ('company','department','personal')), title text NOT NULL
);
CREATE TABLE IF NOT EXISTS key_results (
 id text PRIMARY KEY, objective_id text NOT NULL REFERENCES objectives(id), title text NOT NULL,
 baseline double precision NOT NULL, target double precision NOT NULL, actual double precision NOT NULL,
 direction text NOT NULL CHECK(direction IN ('increase','decrease')), unit text NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version >= 1)
);
ALTER TABLE objectives ADD COLUMN IF NOT EXISTS planning jsonb NOT NULL DEFAULT '{}';
ALTER TABLE key_results ADD COLUMN IF NOT EXISTS planning jsonb NOT NULL DEFAULT '{}';
ALTER TABLE key_results ALTER COLUMN baseline DROP NOT NULL;
ALTER TABLE key_results ALTER COLUMN target DROP NOT NULL;
ALTER TABLE key_results ALTER COLUMN actual DROP NOT NULL;
ALTER TABLE key_results ALTER COLUMN direction DROP NOT NULL;
ALTER TABLE key_results ALTER COLUMN unit DROP NOT NULL;
CREATE TABLE IF NOT EXISTS kr_appraisals (
 id text PRIMARY KEY, kr_id text NOT NULL REFERENCES key_results(id),
 kind text NOT NULL CHECK(kind IN ('self','manager')), score integer NOT NULL CHECK(score IN (0,20,40,60,80,100)),
 note text NOT NULL, evidence text NOT NULL, author_id text NOT NULL REFERENCES users(id),
 self_appraisal_id text REFERENCES kr_appraisals(id), metric_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kr_appraisal_lookup ON kr_appraisals(kr_id,created_at);
CREATE TABLE IF NOT EXISTS tasks (
 id text PRIMARY KEY, org_id text NOT NULL, department_id text NOT NULL,
 owner_id text NOT NULL REFERENCES users(id), reviewer_id text NOT NULL REFERENCES users(id), created_by text NOT NULL REFERENCES users(id),
 title text NOT NULL, description text NOT NULL, criteria jsonb NOT NULL,
 baseline_due_at timestamptz NOT NULL, due_at timestamptz NOT NULL, kr_id text REFERENCES key_results(id),
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','submitted','accepted','revision')),
 version integer NOT NULL DEFAULT 1, submission_version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS submissions (
 id text PRIMARY KEY, task_id text NOT NULL REFERENCES tasks(id), version integer NOT NULL,
 submitted_by text NOT NULL REFERENCES users(id), title text NOT NULL, description text NOT NULL, evidence_url text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(task_id, version)
);
CREATE TABLE IF NOT EXISTS reviews (
 id text PRIMARY KEY, task_id text NOT NULL REFERENCES tasks(id), submission_version integer NOT NULL,
 reviewer_id text NOT NULL REFERENCES users(id), decision text NOT NULL CHECK(decision IN ('accept','return')),
 quality integer CHECK(quality BETWEEN 0 AND 100), note text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(task_id, submission_version) REFERENCES submissions(task_id, version)
);
CREATE TABLE IF NOT EXISTS measurements (
 id text PRIMARY KEY, kr_id text NOT NULL REFERENCES key_results(id), actual double precision NOT NULL,
 source text NOT NULL, note text NOT NULL, recorded_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
 id text PRIMARY KEY, org_id text NOT NULL, department_id text NOT NULL, owner_id text NOT NULL,
 actor_id text NOT NULL REFERENCES users(id), action text NOT NULL, object_id text NOT NULL,
 details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ai_evaluations (
 id text PRIMARY KEY, task_id text NOT NULL REFERENCES tasks(id), submission_version integer NOT NULL,
 status text NOT NULL, model text NOT NULL, input_hash text NOT NULL, result jsonb NOT NULL,
 created_by text NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(task_id,submission_version,model,input_hash)
);
CREATE TABLE IF NOT EXISTS ai_review_jobs (
 id text PRIMARY KEY, org_id text NOT NULL, task_id text NOT NULL REFERENCES tasks(id),
 task_version integer NOT NULL, submission_version integer NOT NULL, requested_by text NOT NULL REFERENCES users(id),
 input_hash text NOT NULL, input_payload jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('dispatching','pending','dispatch_unknown','failed','leased','completed','expired','superseded')),
 error_code text, lease_hash text, lease_expires_at timestamptz, result_hash text,
 evaluation_id text REFERENCES ai_evaluations(id), retry_of text UNIQUE REFERENCES ai_review_jobs(id),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_review_job_current_idx ON ai_review_jobs(task_id,submission_version,input_hash) WHERE status<>'superseded';
CREATE INDEX IF NOT EXISTS ai_review_job_scope_idx ON ai_review_jobs(org_id,task_id,created_at DESC);
CREATE TABLE IF NOT EXISTS bot_dispatch_budgets (
 org_id text NOT NULL, hour_start timestamptz NOT NULL, attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 10),
 PRIMARY KEY(org_id,hour_start)
);
CREATE TABLE IF NOT EXISTS bot_oauth_clients (
 id text PRIMARY KEY, org_id text NOT NULL, name text NOT NULL, redirect_uris jsonb NOT NULL, grant_types jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bot_oauth_client_capacity (
 org_id text PRIMARY KEY, clients integer NOT NULL CHECK(clients BETWEEN 0 AND 50)
);
CREATE TABLE IF NOT EXISTS bot_oauth_registration_budgets (
 org_id text NOT NULL, hour_start timestamptz NOT NULL, attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 10),
 PRIMARY KEY(org_id,hour_start)
);
CREATE TABLE IF NOT EXISTS bot_oauth_requests (
 id text PRIMARY KEY, org_id text NOT NULL, client_id text NOT NULL REFERENCES bot_oauth_clients(id),
 redirect_uri text NOT NULL, resource text NOT NULL, scope text NOT NULL, state text NOT NULL,
 code_challenge text NOT NULL, nonce_hash text NOT NULL, policy_hash text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS return_request_id text;
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS return_destination text CHECK(return_destination IS NULL OR return_destination='caldock-studio');
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS return_language text CHECK(return_language IS NULL OR return_language IN ('zh','en'));
CREATE TABLE IF NOT EXISTS bot_oauth_grants (
 id text PRIMARY KEY, org_id text NOT NULL, department_id text NOT NULL, manager_id text NOT NULL REFERENCES users(id),
 client_id text NOT NULL REFERENCES bot_oauth_clients(id), redirect_uri text NOT NULL, resource text NOT NULL, scope text NOT NULL, policy_hash text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS bot_oauth_codes (
 code_hash text PRIMARY KEY, request_id text NOT NULL UNIQUE REFERENCES bot_oauth_requests(id),
 grant_id text NOT NULL REFERENCES bot_oauth_grants(id), expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS bot_oauth_tokens (
 token_hash text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('access','refresh')),
 grant_id text NOT NULL REFERENCES bot_oauth_grants(id), expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), used_at timestamptz
);
CREATE INDEX IF NOT EXISTS bot_oauth_grant_scope_idx ON bot_oauth_grants(org_id,manager_id);
CREATE INDEX IF NOT EXISTS bot_oauth_token_grant_idx ON bot_oauth_tokens(grant_id);
CREATE TABLE IF NOT EXISTS notification_requests (
 org_id text NOT NULL, requested_by text NOT NULL REFERENCES users(id), request_key text NOT NULL,
 payload_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,requested_by,request_key)
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
 id text PRIMARY KEY, org_id text NOT NULL, department_id text NOT NULL,
 requested_by text NOT NULL REFERENCES users(id), request_key text NOT NULL, recipient_id text NOT NULL REFERENCES users(id),
 payload_hash text NOT NULL, status text NOT NULL CHECK(status IN ('pending','queued','unknown')),
 provider_task_id text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,requested_by,request_key,recipient_id)
);
CREATE INDEX IF NOT EXISTS task_scope_idx ON tasks(org_id, department_id, owner_id);
CREATE INDEX IF NOT EXISTS audit_scope_idx ON audit_events(org_id, department_id, owner_id);
`;
export const schema = coreSchema + boardSchema + supportSchema + okrImportSchema + okrCollabSchema + orgSchema + memberSchema + translationSchema + completionSchema + assignSchema + okrScoreSchema + projectSchema + wmsSchema + rmaSchema + productSchema + inboxSchema + feedbackSchema + publicWikiSchema + caldockSchema + dealerSchema + studioSchema + okrPublishSchema + hrSchema + itSchema;

export async function seedDemo(db: Database) {
  const users = [
    ['m1','marketing','林楠','manager'], ['m2','marketing','陈一','employee'], ['m3','marketing','许夏','employee'],
    ['m4','product','周明','manager'], ['m5','product','赵然','employee'], ['m6','product','顾安','employee']
  ];
  await db.transaction(async tx => {
    for (const [id, dept, name, role] of users) await tx.query(
      'INSERT INTO users(id,org_id,department_id,display_name,role) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [id,'demo',dept,name,role]);
    const objs = [
      ['o1',null,null,'company','以可核验的客户价值推动增长'],
      ['o2','marketing','m1','department','提升有效获客效率'],
      ['o3','marketing','m2','personal','交付可验收的产品内容'],
      ['o4','marketing','m3','personal','完善增长实验复盘'],
      ['o5','product','m4','department','改善产品交付可靠性']
    ];
    for (const [id,dept,owner,level,title] of objs) await tx.query(
      'INSERT INTO objectives(id,org_id,department_id,owner_id,level,title) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING', [id,'demo',dept,owner,level,title]);
    for (const [id, obj, title, target, actual, unit] of [
      ['kr1','o2','有效询盘',30,18,'条'], ['kr2','o3','通过验收的内容',20,12,'篇'],
      ['kr3','o4','有效实验',5,2,'次'], ['kr4','o5','完成验证的发布',10,5,'次']
    ]) await tx.query('INSERT INTO key_results(id,objective_id,title,baseline,target,actual,direction,unit) VALUES($1,$2,$3,0,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [id,obj,title,target,actual,'increase',unit]);
    for (const [id,owner,reviewer,dept,kr,title] of [
      ['t1','m2','m1','marketing','kr2','产品内容初稿'],
      ['t2','m3','m1','marketing','kr3','获客实验复盘'],
      ['t3','m5','m4','product','kr4','发布验证记录']
    ]) await tx.query('INSERT INTO tasks(id,org_id,department_id,owner_id,reviewer_id,created_by,title,description,criteria,baseline_due_at,due_at,kr_id) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$9,$10) ON CONFLICT DO NOTHING', [id,'demo',dept,owner,reviewer,title,'仅为 API 开发测试的虚构任务',JSON.stringify(['提供可核对的成果记录','逐项说明验收标准']), new Date(Date.now()+14*864e5).toISOString(),kr]);
  });
}
