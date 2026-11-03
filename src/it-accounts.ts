/* IT assets: accounts, mailboxes and subscriptions (phase 1 of docs/plans/2026-11-02-it-assets.md).
 *
 *   it_accounts       one company account or mailbox: service, login, owner, where its password lives (vault_ref), 2FA, status,
 *                     and optional subscription facts (plan, cost, cycle, renewal, payment label + last 4)
 *   it_account_users  who else uses a shared account
 *   it_flags          "needs change" / "I stopped using this" / "problem" reports from employees, resolved by IT
 *   it_checks         the quarterly "confirm your accounts" round, one row per person per quarter
 *
 * Passwords are never stored: there is no password, PIN, recovery-code or token field, and free text that looks like one is
 * rejected (IT_SECRET_IN_TEXT). vault_ref links to the item in the company password manager instead.
 *
 * Access: IT = WORKOS_IT_USER_IDS (deployment config only) sees and edits everything, including costs. Executives
 * (WORKOS_EXECUTIVE_USER_IDS) read everything, including costs. Everyone else sees the accounts that they or their reports
 * own, use or hold the 2FA for, without subscription details; they can register accounts they own, edit their own (not the
 * subscription), and flag changes. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { ApiError, deny } from './errors.js';
import { pushInbox } from './inbox.js';

export const itSchema = `
CREATE TABLE IF NOT EXISTS it_accounts(id text PRIMARY KEY, org_id text NOT NULL, service text NOT NULL, category text NOT NULL DEFAULT 'saas', login text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '', owner_id text REFERENCES users(id), vault_ref text NOT NULL DEFAULT '', mfa_method text NOT NULL DEFAULT 'none', mfa_holder_id text REFERENCES users(id),
  mfa_note text NOT NULL DEFAULT '', shared boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'active', mailbox_type text NOT NULL DEFAULT '', notes text NOT NULL DEFAULT '',
  plan text NOT NULL DEFAULT '', seats integer, cost numeric(14,2), currency text NOT NULL DEFAULT '', cycle text NOT NULL DEFAULT '', next_renewal date,
  payment_label text NOT NULL DEFAULT '', card_last4 text NOT NULL DEFAULT '', auto_renew boolean NOT NULL DEFAULT false, invoice_contact text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1, created_by text NOT NULL, updated_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS it_accounts_org ON it_accounts(org_id, service);
CREATE TABLE IF NOT EXISTS it_account_users(account_id text NOT NULL REFERENCES it_accounts(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id), org_id text NOT NULL,
  added_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id, user_id));
CREATE TABLE IF NOT EXISTS it_flags(id text PRIMARY KEY, org_id text NOT NULL, account_id text REFERENCES it_accounts(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id),
  kind text NOT NULL, note text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz, resolved_by text, resolution text NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS it_flags_org ON it_flags(org_id, resolved_at);
CREATE TABLE IF NOT EXISTS it_checks(org_id text NOT NULL, quarter text NOT NULL, user_id text NOT NULL REFERENCES users(id), status text NOT NULL DEFAULT 'pending',
  started_on date NOT NULL, confirmed_at timestamptz, note text NOT NULL DEFAULT '', PRIMARY KEY(org_id, quarter, user_id));
CREATE TABLE IF NOT EXISTS it_reminder_log(key text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
`;

export type ItOptions = { userIds?: string[] };
export function itOptionsFromEnv(env: NodeJS.ProcessEnv): ItOptions {
  return { userIds: (env.WORKOS_IT_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean) };
}

/* ---------- constants and inputs ---------- */
export const CATEGORIES = ['email', 'saas', 'social', 'marketplace', 'cloud', 'domain', 'finance', 'other'] as const;
export const MFA_METHODS = ['none', 'sms', 'app', 'email', 'hardware_key', 'other'] as const;
export const STATUSES = ['active', 'to_cancel', 'cancelled'] as const;
export const MAILBOX_TYPES = ['personal', 'shared', 'alias', 'forwarding'] as const;
export const CYCLES = ['monthly', 'yearly', 'one_off'] as const;
const FLAG_KINDS = ['needs_change', 'stopped_using', 'problem'] as const;
const DAY = 86_400_000, MAX_IMPORT_ROWS = 2000;
const id = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-02')
  .refine(v => { const d = new Date(v + 'T00:00:00Z'); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v; }, 'Use a real calendar date');
const text = (max: number) => z.string().trim().max(max);
const ymd = (v: any) => v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null;
const nameOf = (u: any) => u ? (u.display_name || u.name_zh || u.name_en || u.id) : '';
const round2 = (n: number) => Math.round(n * 100) / 100;

const fieldShape = {
  service: z.string().trim().min(1).max(120), category: z.enum(CATEGORIES), login: text(200),
  url: z.union([z.literal(''), z.string().trim().max(500).regex(/^https?:\/\/\S+$/)]), ownerId: id.nullable(),
  vaultRef: z.union([z.literal(''), z.string().trim().max(500).regex(/^(https:\/\/\S+|op:\/\/[^\r\n]+)$/)]),
  mfaMethod: z.enum(MFA_METHODS), mfaHolderId: id.nullable(), mfaNote: text(300), shared: z.boolean(), status: z.enum(STATUSES),
  mailboxType: z.enum(['', ...MAILBOX_TYPES]), notes: text(4000),
  plan: text(120), seats: z.number().int().min(0).max(100_000).nullable(), cost: z.number().finite().min(0).max(100_000_000).nullable(),
  currency: z.union([z.literal(''), z.string().trim().regex(/^[A-Z]{3}$/)]), cycle: z.enum(['', ...CYCLES]), nextRenewal: day.nullable(),
  paymentLabel: text(80), cardLast4: z.union([z.literal(''), z.string().regex(/^\d{4}$/)]), autoRenew: z.boolean(), invoiceContact: text(120),
};
const fields = z.object(fieldShape).partial();
const createInput = fields.extend({ service: fieldShape.service, userIds: z.array(id).max(200).optional() }).strict();
const updateInput = fields.extend({ expectedVersion: z.number().int().min(1) }).strict();
const usersInput = z.object({ userIds: z.array(id).max(200) }).strict();
const flagInput = z.object({ kind: z.enum(FLAG_KINDS), note: text(1000).default('') }).strict();
const resolveInput = z.object({ resolution: text(1000).default('') }).strict();
const confirmInput = z.object({ items: z.array(z.object({ accountId: id, ok: z.boolean(), note: text(1000).default('') }).strict()).max(500).default([]), missing: text(1000).default('') }).strict();
const importInput = z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().default(false) }).strict();

type Fields = z.infer<typeof fields>;
const COLS: [keyof Fields, string][] = [
  ['service', 'service'], ['category', 'category'], ['login', 'login'], ['url', 'url'], ['ownerId', 'owner_id'], ['vaultRef', 'vault_ref'], ['mfaMethod', 'mfa_method'],
  ['mfaHolderId', 'mfa_holder_id'], ['mfaNote', 'mfa_note'], ['shared', 'shared'], ['status', 'status'], ['mailboxType', 'mailbox_type'], ['notes', 'notes'],
  ['plan', 'plan'], ['seats', 'seats'], ['cost', 'cost'], ['currency', 'currency'], ['cycle', 'cycle'], ['nextRenewal', 'next_renewal'], ['paymentLabel', 'payment_label'],
  ['cardLast4', 'card_last4'], ['autoRenew', 'auto_renew'], ['invoiceContact', 'invoice_contact'],
];
const SUBSCRIPTION_KEYS = new Set<string>(['plan', 'seats', 'cost', 'currency', 'cycle', 'nextRenewal', 'paymentLabel', 'cardLast4', 'autoRenew', 'invoiceContact']);
const DEFAULTS: Record<string, any> = {
  service: '', category: 'saas', login: '', url: '', owner_id: null, vault_ref: '', mfa_method: 'none', mfa_holder_id: null, mfa_note: '', shared: false, status: 'active',
  mailbox_type: '', notes: '', plan: '', seats: null, cost: null, currency: '', cycle: '', next_renewal: null, payment_label: '', card_last4: '', auto_renew: false, invoice_contact: '',
};
/** The stored row as plain comparable values. */
const pick = (row: any) => Object.fromEntries(Object.keys(DEFAULTS).map(c => [c, row[c] === undefined ? DEFAULTS[c]
  : c === 'next_renewal' ? ymd(row[c]) : (c === 'cost' || c === 'seats') && row[c] !== null ? Number(row[c]) : row[c]]));
const same = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');

/* ---------- the "no passwords here" guard ---------- */
const SECRET_LABEL = /(password|passwd|pwd|passcode|pin|密码|口令|恢复码|验证码|recovery\s*codes?|backup\s*codes?)\s*[:：=]/i;
const SECRET_TOKEN = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/;
const longToken = (v: string) => (v.match(/[A-Za-z0-9+_=-]{32,}/g) || []).some(t => /[A-Za-z]/.test(t) && /\d/.test(t));
export function looksSecret(v: string, tokens = true) { return SECRET_LABEL.test(v) || SECRET_TOKEN.test(v) || (tokens && longToken(v)); }
function guard(v: Fields) {
  const labelled: (keyof Fields)[] = ['service', 'login', 'notes', 'mfaNote', 'plan', 'invoiceContact', 'paymentLabel'];
  for (const k of labelled) {
    const s = v[k];
    if (typeof s === 'string' && s && looksSecret(s, k === 'notes' || k === 'login' || k === 'mfaNote'))
      deny(400, 'IT_SECRET_IN_TEXT', 'This looks like a password or key. Keep secrets in the password manager and paste its link instead',
        '这里看起来填了密码或密钥。密码请保存在密码管理器里，这里只填它的链接。');
  }
  if (v.paymentLabel && /\d{8,}/.test(v.paymentLabel.replace(/[\s-]/g, '')))
    deny(400, 'IT_CARD_NUMBER', 'Record only a card name and its last 4 digits', '付款方式只填卡的名称，卡号只填后四位。');
}

/* ---------- dates ---------- */
const addMonths = (d: string, n: number) => {
  const [y, m, dd] = d.split('-').map(Number), t = new Date(Date.UTC(y, m - 1 + n, 1));
  t.setUTCDate(Math.min(dd, new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()));
  return t.toISOString().slice(0, 10);
};
export const quarterOf = (d: string) => `${d.slice(0, 4)}-Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1}`;
const quarterStart = (q: string) => `${q.slice(0, 4)}-${String((Number(q.slice(6)) - 1) * 3 + 1).padStart(2, '0')}-01`;

/* ---------- CSV ---------- */
const CSV_COLUMNS: [string, string, string][] = [
  ['service', '服务名称', 'service'], ['category', '类别', 'category'], ['login', '登录账号', 'login'], ['url', '网址', 'url'], ['owner', '负责人', 'owner'],
  ['users', '共用人', 'users'], ['vaultRef', '密码库链接', 'vault_ref'], ['mfaMethod', '两步验证方式', 'mfa_method'], ['mfaHolder', '两步验证绑定人', 'mfa_holder'],
  ['mfaNote', '两步验证说明', 'mfa_note'], ['shared', '共享账号', 'shared'], ['status', '状态', 'status'], ['mailboxType', '邮箱类型', 'mailbox_type'], ['plan', '套餐', 'plan'],
  ['seats', '席位数', 'seats'], ['cost', '费用', 'cost'], ['currency', '币种', 'currency'], ['cycle', '付费周期', 'cycle'], ['nextRenewal', '下次续费日', 'next_renewal'],
  ['paymentLabel', '付款方式', 'payment_label'], ['cardLast4', '卡号后四位', 'card_last4'], ['autoRenew', '自动续费', 'auto_renew'], ['invoiceContact', '发票联系人', 'invoice_contact'],
  ['notes', '备注', 'notes'],
];
const LABELS: Record<string, Record<string, string>> = {
  category: { email: '邮箱', saas: '软件服务', social: '社交媒体', marketplace: '电商平台', cloud: '云服务', domain: '域名', finance: '财务银行', other: '其他' },
  mfaMethod: { none: '无', sms: '短信', app: '验证器App', email: '邮箱验证', hardware_key: '硬件密钥', other: '其他' },
  status: { active: '在用', to_cancel: '待取消', cancelled: '已取消' },
  mailboxType: { personal: '个人', shared: '共享', alias: '别名', forwarding: '转发' },
  cycle: { monthly: '月付', yearly: '年付', one_off: '一次性' },
};
const ALIASES: Record<string, Record<string, string>> = {
  category: { 'saas': 'saas', '软件': 'saas', 'SaaS': 'saas', '社媒': 'social', '电商': 'marketplace', '财务': 'finance', '银行': 'finance', '网银': 'finance' },
  mfaMethod: { '': 'none', '验证器': 'app', '身份验证器': 'app', 'authenticator': 'app', '邮箱': 'email', '密钥': 'hardware_key' },
  status: { '': 'active', '使用中': 'active', '停用': 'cancelled' },
  cycle: { '每月': 'monthly', '月': 'monthly', '每年': 'yearly', '年': 'yearly' },
};
const enumFrom = (key: string, raw: string) => {
  const v = raw.trim(), labels = LABELS[key];
  if (labels[v]) return v;
  const byLabel = Object.entries(labels).find(([, l]) => l === v)?.[0];
  return byLabel ?? ALIASES[key]?.[v] ?? ALIASES[key]?.[v.toLowerCase()] ?? v.toLowerCase();
};
const boolFrom = (raw: string) => {
  const v = raw.trim().toLowerCase();
  if (['是', 'yes', 'y', 'true', '1', '✓'].includes(v)) return true;
  if (['否', 'no', 'n', 'false', '0', ''].includes(v)) return false;
  return null;
};
export function parseCsv(input: string) {
  const s = input.replace(/^﻿/, ''), rows: string[][] = [];
  let row: string[] = [], f = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
/** Quote for CSV; a leading = + - @ is prefixed with ' so spreadsheets do not run it as a formula. */
const cell = (v: unknown) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const unformula = (s: string) => /^'[=+\-@]/.test(s) ? s.slice(1) : s;

export async function registerItRoutes(app: FastifyInstance, db: Database, o: ItOptions & { executiveIds?: string[]; now?: () => number; intervalMs?: number }) {
  const now = o.now || Date.now;
  const itIds = new Set(o.userIds || []), execIds = new Set(o.executiveIds || []);
  const isIt = (u: User) => itIds.has(u.id);
  const isExec = (u: User) => execIds.has(u.id);
  const seesAll = (u: User) => isIt(u) || isExec(u);
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const requireIt = (u: User) => { if (!isIt(u)) deny(403, 'IT_ONLY', 'Only IT can do this', '只有 IT 管理员可以进行这项操作。'); };
  const requireSeesAll = (u: User) => { if (!seesAll(u)) deny(403, 'IT_ONLY', 'Only IT can do this', '只有 IT 管理员可以进行这项操作。'); };
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const daysTo = (d: string) => Math.round((new Date(d + 'T00:00:00Z').getTime() - new Date(today() + 'T00:00:00Z').getTime()) / DAY);
  const scopeOf = (u: User) => [...new Set([u.id, ...(u.visibleOwnerIds || [])])];
  const audit = (tx: Queryable, u: User, a: { id: string; owner_id?: string | null }, action: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, a.owner_id || u.id, u.id, action, a.id, JSON.stringify(details)]);
  const people = async (tx: Queryable, orgId: string) => new Map((await tx.query(
    `SELECT u.id,u.display_name,u.name_zh,u.name_en,u.email,u.active,u.disabled_at,u.department_id,p.status AS hr_status FROM users u LEFT JOIN hr_profiles p ON p.user_id=u.id WHERE u.org_id=$1`,
    [orgId])).rows.map((r: any) => [r.id, r]));
  const usable = (p: any) => !!p && p.active && !p.disabled_at;
  const checkPeople = async (tx: Queryable, orgId: string, ids: (string | null | undefined)[]) => {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return;
    const found = (await tx.query('SELECT id FROM users WHERE org_id=$1 AND id=ANY($2::text[]) AND active=true AND disabled_at IS NULL', [orgId, want])).rows.length;
    if (found !== want.length) deny(400, 'IT_UNKNOWN_PERSON', 'Choose an active member', '请选择在职的成员。');
  };
  const itRecipients = async (tx: Queryable, orgId: string) =>
    (await tx.query('SELECT id FROM users WHERE org_id=$1 AND id=ANY($2::text[]) AND active=true', [orgId, [...itIds]])).rows.map((r: any) => r.id as string);

  /** Next renewal date; an auto-renewing monthly/yearly subscription whose stored date has passed rolls forward to the next one. */
  const renewalOf = (a: any) => {
    const base = ymd(a.next_renewal);
    if (!base || !a.auto_renew || (a.cycle !== 'monthly' && a.cycle !== 'yearly')) return base;
    const step = a.cycle === 'monthly' ? 1 : 12, t = today();
    let d = base;
    for (let i = 1; d < t && i < 1200; i++) d = addMonths(base, step * i);
    return d;
  };
  const monthlyCost = (a: any) => a.cost === null || a.cost === undefined || a.status === 'cancelled' ? 0
    : a.cycle === 'monthly' ? Number(a.cost) : a.cycle === 'yearly' ? Number(a.cost) / 12 : 0;

  const loadAccounts = async (tx: Queryable, u: User, where: 'visible' | 'mine' | 'all', accountId?: string) => {
    const params: any[] = [u.org_id];
    let sql = 'SELECT a.* FROM it_accounts a WHERE a.org_id=$1';
    if (accountId) { params.push(accountId); sql += ` AND a.id=$${params.length}`; }
    const scope = where === 'mine' ? [u.id] : where === 'visible' && !seesAll(u) ? scopeOf(u) : null;
    if (scope) {
      params.push(scope);
      const p = `$${params.length}::text[]`;
      sql += ` AND (a.owner_id=ANY(${p}) OR a.mfa_holder_id=ANY(${p}) OR EXISTS(SELECT 1 FROM it_account_users x WHERE x.account_id=a.id AND x.user_id=ANY(${p})))`;
    }
    const rows = (await tx.query(sql + ' ORDER BY lower(a.service), a.login, a.id', params)).rows;
    const users = rows.length ? (await tx.query('SELECT account_id,user_id FROM it_account_users WHERE account_id=ANY($1::text[]) ORDER BY created_at', [rows.map((r: any) => r.id)])).rows : [];
    const byAccount = new Map<string, string[]>();
    for (const r of users) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) || []), r.user_id]);
    return rows.map((r: any) => ({ ...r, user_ids: byAccount.get(r.id) || [] }));
  };
  const shape = (a: any, u: User, names: Map<string, any>) => {
    const person = (pid: string | null) => pid ? { id: pid, name: nameOf(names.get(pid)), active: usable(names.get(pid)), leaving: names.get(pid)?.hr_status === 'leaving' } : null;
    const relation = [a.owner_id === u.id && 'owner', a.user_ids.includes(u.id) && 'user', a.mfa_holder_id === u.id && 'mfa'].filter(Boolean);
    const out: any = {
      id: a.id, service: a.service, category: a.category, login: a.login, url: a.url, owner: person(a.owner_id), vaultRef: a.vault_ref,
      mfaMethod: a.mfa_method, mfaHolder: person(a.mfa_holder_id), mfaNote: a.mfa_note, shared: a.shared, status: a.status, mailboxType: a.mailbox_type,
      notes: a.notes, users: a.user_ids.map(person), version: Number(a.version), updatedAt: a.updated_at, createdAt: a.created_at,
      relation, canEdit: isIt(u) || a.owner_id === u.id,
    };
    if (seesAll(u)) {
      const renewal = renewalOf(a);
      out.subscription = {
        plan: a.plan, seats: a.seats === null ? null : Number(a.seats), cost: a.cost === null ? null : Number(a.cost), currency: a.currency, cycle: a.cycle,
        nextRenewal: renewal, storedRenewal: ymd(a.next_renewal), daysToRenewal: renewal ? daysTo(renewal) : null, paymentLabel: a.payment_label,
        cardLast4: a.card_last4, autoRenew: a.auto_renew, invoiceContact: a.invoice_contact, monthlyCost: round2(monthlyCost(a)),
      };
    }
    return out;
  };
  const accountFor = async (tx: Queryable, u: User, accountId: string) => {
    const a = (await loadAccounts(tx, u, 'visible', accountId))[0];
    if (!a) deny(404, 'NOT_FOUND', 'Account not found', '找不到这个账号。');
    return a;
  };
  /** Stored values after applying an input; keeps the rules that tie fields together. */
  const merge = (cur: any, v: Fields) => {
    const next: Record<string, any> = cur ? pick(cur) : { ...DEFAULTS };
    for (const [k, col] of COLS) if (v[k] !== undefined) next[col] = v[k];
    if (next.category !== 'email') next.mailbox_type = '';
    if (next.mfa_method === 'none') next.mfa_holder_id = null;
    if (next.cost !== null && !next.currency) next.currency = 'CNY';
    if (!next.cycle) next.auto_renew = false;
    return next;
  };
  const touchesSubscription = (v: Fields) => Object.keys(v).some(k => SUBSCRIPTION_KEYS.has(k));
  const insertAccount = async (tx: Queryable, u: User, next: Record<string, any>, userIds: string[]) => {
    const accountId = randomUUID(), cols = Object.keys(DEFAULTS);
    await tx.query(`INSERT INTO it_accounts(id,org_id,${cols.join(',')},created_by,updated_by) VALUES($1,$2,${cols.map((_, i) => `$${i + 3}`).join(',')},$${cols.length + 3},$${cols.length + 3})`,
      [accountId, u.org_id, ...cols.map(c => next[c]), u.id]);
    for (const uid of new Set(userIds)) await tx.query('INSERT INTO it_account_users(account_id,user_id,org_id,added_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [accountId, uid, u.org_id, u.id]);
    return accountId;
  };
  const flag = async (tx: Queryable, u: User, accountId: string | null, kind: string, note: string) => {
    const flagId = randomUUID();
    await tx.query('INSERT INTO it_flags(id,org_id,account_id,user_id,kind,note) VALUES($1,$2,$3,$4,$5,$6)', [flagId, u.org_id, accountId, u.id, kind, note]);
    return flagId;
  };
  const FLAG_TITLES: Record<string, string> = { needs_change: '需要修改', stopped_using: '已不再使用', problem: '有问题', missing: '有账号未登记' };

  app.get('/it/access', async req => {
    const u = actorOf(req), quarter = quarterOf(today());
    const check = (await db.query('SELECT status,started_on,confirmed_at FROM it_checks WHERE org_id=$1 AND quarter=$2 AND user_id=$3', [u.org_id, quarter, u.id])).rows[0];
    return { isIt: isIt(u), isExecutive: isExec(u), canSeeCost: seesAll(u), seesAll: seesAll(u), hasReports: (u.visibleOwnerIds || []).some(x => x !== u.id), configured: itIds.size > 0,
      quarter, check: check ? { status: check.status, startedOn: ymd(check.started_on), confirmedAt: check.confirmed_at } : null };
  });

  /** Active members for the owner / users / 2FA pickers (names only; everyone can already see them in the org chart). */
  app.get('/it/people', async req => {
    const u = actorOf(req);
    return { items: [...(await people(db, u.org_id)).values()].filter(usable).map(p => ({ id: p.id, name: nameOf(p) })).sort((a, b) => a.name.localeCompare(b.name, 'zh')) };
  });

  app.get('/it/accounts', async req => {
    const u = actorOf(req), names = await people(db, u.org_id);
    return { items: (await loadAccounts(db, u, 'visible')).map(a => shape(a, u, names)), canSeeCost: seesAll(u), isIt: isIt(u) };
  });

  app.get('/it/my', async req => {
    const u = actorOf(req), names = await people(db, u.org_id), quarter = quarterOf(today());
    const check = (await db.query('SELECT status,started_on,confirmed_at FROM it_checks WHERE org_id=$1 AND quarter=$2 AND user_id=$3', [u.org_id, quarter, u.id])).rows[0];
    const flags = (await db.query('SELECT f.*,a.service FROM it_flags f LEFT JOIN it_accounts a ON a.id=f.account_id WHERE f.org_id=$1 AND f.user_id=$2 AND f.resolved_at IS NULL ORDER BY f.created_at DESC', [u.org_id, u.id])).rows;
    return {
      accounts: (await loadAccounts(db, u, 'mine')).map(a => shape(a, u, names)),
      check: check ? { quarter, status: check.status, startedOn: ymd(check.started_on), confirmedAt: check.confirmed_at } : { quarter, status: 'not_started' },
      openFlags: flags.map((f: any) => ({ id: f.id, accountId: f.account_id, service: f.service || '', kind: f.kind, note: f.note, createdAt: f.created_at })),
    };
  });

  app.get<{ Params: { id: string } }>('/it/accounts/:id', async req => {
    const u = actorOf(req), a = await accountFor(db, u, id.parse(req.params.id)), names = await people(db, u.org_id);
    const out = shape(a, u, names);
    out.flags = (await db.query('SELECT * FROM it_flags WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50', [a.id])).rows
      .map((f: any) => ({ id: f.id, kind: f.kind, note: f.note, byName: nameOf(names.get(f.user_id)), createdAt: f.created_at, resolvedAt: f.resolved_at, resolution: f.resolution }));
    out.history = (await db.query("SELECT actor_id,action,details,created_at FROM audit_events WHERE org_id=$1 AND object_id=$2 AND action LIKE 'it.%' ORDER BY created_at DESC LIMIT 50", [u.org_id, a.id])).rows
      .map((h: any) => ({ action: h.action, byName: nameOf(names.get(h.actor_id)), fields: (typeof h.details === 'string' ? JSON.parse(h.details) : h.details)?.fields || [], createdAt: h.created_at }));
    return out;
  });

  app.post('/it/accounts', async (req, reply) => {
    const u = actorOf(req), v = createInput.parse(req.body);
    guard(v);
    if (!isIt(u) && touchesSubscription(v)) deny(403, 'IT_COST_ONLY', 'Only IT can change subscription and payment details', '只有 IT 管理员可以填写或修改订阅和付款信息。');
    if (!isIt(u) && v.ownerId !== undefined && v.ownerId !== u.id) deny(403, 'IT_OWNER_SELF', 'You can register only accounts you own; ask IT for others', '你只能登记自己负责的账号；别人负责的账号请联系 IT 管理员。');
    return db.transaction(async tx => {
      const next = merge(null, { ...v, ownerId: v.ownerId !== undefined ? v.ownerId : isIt(u) ? null : u.id });
      await checkPeople(tx, u.org_id, [next.owner_id, next.mfa_holder_id, ...(v.userIds || [])]);
      const accountId = await insertAccount(tx, u, next, v.userIds || []);
      await audit(tx, u, { id: accountId, owner_id: next.owner_id }, 'it.account.create', { fields: Object.keys(v).filter(k => k !== 'userIds') });
      reply.code(201);
      return shape((await loadAccounts(tx, u, 'all', accountId))[0], u, await people(tx, u.org_id));
    });
  });

  app.put<{ Params: { id: string } }>('/it/accounts/:id', async req => {
    const u = actorOf(req), v = updateInput.parse(req.body), accountId = id.parse(req.params.id);
    guard(v);
    return db.transaction(async tx => {
      const a = await accountFor(tx, u, accountId);
      if (!isIt(u) && a.owner_id !== u.id) deny(403, 'IT_EDIT_FORBIDDEN', 'Only IT or the account owner can edit this account', '只有 IT 管理员或账号负责人可以修改这个账号。');
      if (!isIt(u) && touchesSubscription(v)) deny(403, 'IT_COST_ONLY', 'Only IT can change subscription and payment details', '只有 IT 管理员可以填写或修改订阅和付款信息。');
      if (!isIt(u) && v.ownerId !== undefined && v.ownerId !== u.id) deny(403, 'IT_OWNER_CHANGE', 'Ask IT to hand this account to someone else', '要把账号交给别人负责，请联系 IT 管理员。');
      const cur = (await tx.query('SELECT * FROM it_accounts WHERE id=$1 FOR UPDATE', [a.id])).rows[0];
      if (Number(cur.version) !== v.expectedVersion) deny(409, 'VERSION_CONFLICT', 'This record changed since you opened it; reload and try again', '这条账号记录在你打开后已被修改，请刷新后再试。');
      const before = pick(cur), next = merge(cur, v), changed = Object.keys(DEFAULTS).filter(c => !same(before[c], next[c]));
      if (changed.length) {
        await checkPeople(tx, u.org_id, [changed.includes('owner_id') ? next.owner_id : null, changed.includes('mfa_holder_id') ? next.mfa_holder_id : null]);
        await tx.query(`UPDATE it_accounts SET ${changed.map((c, i) => `${c}=$${i + 2}`).join(',')},version=version+1,updated_by=$${changed.length + 2},updated_at=now() WHERE id=$1`,
          [a.id, ...changed.map(c => next[c]), u.id]);
        const keyOf = new Map(COLS.map(([k, c]) => [c, k]));
        await audit(tx, u, { id: a.id, owner_id: next.owner_id }, 'it.account.update', { fields: changed.map(c => keyOf.get(c)) });
      }
      return shape((await loadAccounts(tx, u, 'all', a.id))[0], u, await people(tx, u.org_id));
    });
  });

  app.put<{ Params: { id: string } }>('/it/accounts/:id/users', async req => {
    const u = actorOf(req), v = usersInput.parse(req.body), accountId = id.parse(req.params.id);
    return db.transaction(async tx => {
      const a = await accountFor(tx, u, accountId);
      if (!isIt(u) && a.owner_id !== u.id) deny(403, 'IT_EDIT_FORBIDDEN', 'Only IT or the account owner can edit this account', '只有 IT 管理员或账号负责人可以修改这个账号。');
      const want = [...new Set(v.userIds)], added = want.filter(x => !a.user_ids.includes(x)), removed = a.user_ids.filter((x: string) => !want.includes(x));
      await checkPeople(tx, u.org_id, added);
      if (removed.length) await tx.query('DELETE FROM it_account_users WHERE account_id=$1 AND user_id=ANY($2::text[])', [a.id, removed]);
      for (const uid of added) await tx.query('INSERT INTO it_account_users(account_id,user_id,org_id,added_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [a.id, uid, u.org_id, u.id]);
      if (added.length || removed.length) await audit(tx, u, a, 'it.account.users', { fields: ['users'], added: added.length, removed: removed.length });
      return shape((await loadAccounts(tx, u, 'all', a.id))[0], u, await people(tx, u.org_id));
    });
  });

  app.delete<{ Params: { id: string } }>('/it/accounts/:id', async req => {
    const u = actorOf(req); requireIt(u);
    return db.transaction(async tx => {
      const a = (await tx.query('DELETE FROM it_accounts WHERE id=$1 AND org_id=$2 RETURNING id,owner_id,service', [id.parse(req.params.id), u.org_id])).rows[0];
      if (!a) deny(404, 'NOT_FOUND', 'Account not found', '找不到这个账号。');
      await audit(tx, u, a, 'it.account.delete', { service: a.service });
      return { deleted: true };
    });
  });

  /* ---------- flags ---------- */
  app.post<{ Params: { id: string } }>('/it/accounts/:id/flags', async (req, reply) => {
    const u = actorOf(req), v = flagInput.parse(req.body), accountId = id.parse(req.params.id);
    if (v.note && looksSecret(v.note)) guard({ notes: v.note });
    return db.transaction(async tx => {
      const a = await accountFor(tx, u, accountId);
      const flagId = await flag(tx, u, a.id, v.kind, v.note);
      if (v.kind === 'stopped_using') await tx.query('DELETE FROM it_account_users WHERE account_id=$1 AND user_id=$2', [a.id, u.id]);
      await audit(tx, u, a, 'it.account.flag', { kind: v.kind });
      const who = nameOf((await people(tx, u.org_id)).get(u.id));
      await pushInbox(tx, { orgId: u.org_id, recipients: await itRecipients(tx, u.org_id), actorId: u.id, kind: 'it_reminder', title: `${who} 反馈：${a.service} ${FLAG_TITLES[v.kind]}`, body: v.note });
      reply.code(201);
      return { id: flagId };
    });
  });

  app.get<{ Querystring: { all?: string } }>('/it/flags', async req => {
    const u = actorOf(req); requireIt(u);
    const names = await people(db, u.org_id), all = req.query.all === '1';
    const rows = (await db.query(`SELECT f.*,a.service,a.login FROM it_flags f LEFT JOIN it_accounts a ON a.id=f.account_id WHERE f.org_id=$1 ${all ? '' : 'AND f.resolved_at IS NULL'}
      ORDER BY f.resolved_at IS NULL DESC, f.created_at DESC LIMIT 500`, [u.org_id])).rows;
    return { items: rows.map((f: any) => ({ id: f.id, accountId: f.account_id, service: f.service || '', login: f.login || '', kind: f.kind, note: f.note, userId: f.user_id,
      byName: nameOf(names.get(f.user_id)), createdAt: f.created_at, resolvedAt: f.resolved_at, resolvedByName: f.resolved_by ? nameOf(names.get(f.resolved_by)) : '', resolution: f.resolution })) };
  });

  app.post<{ Params: { id: string } }>('/it/flags/:id/resolve', async req => {
    const u = actorOf(req); requireIt(u);
    const v = resolveInput.parse(req.body);
    return db.transaction(async tx => {
      const f = (await tx.query('UPDATE it_flags SET resolved_at=now(),resolved_by=$3,resolution=$4 WHERE id=$1 AND org_id=$2 AND resolved_at IS NULL RETURNING *', [id.parse(req.params.id), u.org_id, u.id, v.resolution])).rows[0];
      if (!f) deny(404, 'NOT_FOUND', 'Report not found or already handled', '找不到这条反馈，或它已经处理过了。');
      await audit(tx, u, { id: f.account_id || f.id, owner_id: f.user_id }, 'it.flag.resolve', { kind: f.kind });
      return { resolved: true };
    });
  });

  /* ---------- quarterly check ---------- */
  const startChecks = async (tx: Queryable, orgId: string, quarter: string) => {
    const started = (await tx.query(`INSERT INTO it_checks(org_id,quarter,user_id,started_on) SELECT org_id,$2,id,$3 FROM users
      WHERE org_id=$1 AND active=true AND disabled_at IS NULL ON CONFLICT DO NOTHING RETURNING user_id`, [orgId, quarter, today()])).rows.map((r: any) => r.user_id as string);
    if (started.length) await pushInbox(tx, { orgId, recipients: started, actorId: 'system', kind: 'it_reminder', title: `请确认你的账号与设备（${quarter}）`, body: 'IT 资产与账号 → 我的账号' });
    return started.length;
  };
  const checkRound = async (tx: Queryable, orgId: string, quarter: string) => {
    const names = await people(tx, orgId);
    const rows = (await tx.query('SELECT * FROM it_checks WHERE org_id=$1 AND quarter=$2', [orgId, quarter])).rows;
    const items = rows.map((r: any) => ({ userId: r.user_id, name: nameOf(names.get(r.user_id)), departmentId: names.get(r.user_id)?.department_id || '', status: r.status,
      startedOn: ymd(r.started_on), confirmedAt: r.confirmed_at, overdueDays: r.status === 'pending' ? Math.max(0, -daysTo(ymd(r.started_on)!)) : 0 }))
      .sort((a: any, b: any) => (a.status === b.status ? 0 : a.status === 'pending' ? -1 : 1) || a.name.localeCompare(b.name));
    const done = items.filter((x: any) => x.status === 'done').length;
    return { quarter, started: rows.length > 0, total: items.length, done, percent: items.length ? Math.round(done * 100 / items.length) : 0, people: items };
  };
  app.get<{ Querystring: { quarter?: string } }>('/it/checks', async req => {
    const u = actorOf(req); requireIt(u);
    const quarter = req.query.quarter && /^\d{4}-Q[1-4]$/.test(req.query.quarter) ? req.query.quarter : quarterOf(today());
    return checkRound(db, u.org_id, quarter);
  });
  app.post('/it/checks/start', async req => {
    const u = actorOf(req); requireIt(u);
    return db.transaction(async tx => {
      const quarter = quarterOf(today()), started = await startChecks(tx, u.org_id, quarter);
      await audit(tx, u, { id: 'it-check-' + quarter }, 'it.check.start', { quarter, people: started });
      return { ...(await checkRound(tx, u.org_id, quarter)), newlyStarted: started };
    });
  });
  app.post('/it/checks/confirm', async req => {
    const u = actorOf(req), v = confirmInput.parse(req.body), quarter = quarterOf(today());
    if (v.missing && looksSecret(v.missing)) guard({ notes: v.missing });
    for (const item of v.items) if (item.note && looksSecret(item.note)) guard({ notes: item.note });
    return db.transaction(async tx => {
      const check = (await tx.query('SELECT * FROM it_checks WHERE org_id=$1 AND quarter=$2 AND user_id=$3 FOR UPDATE', [u.org_id, quarter, u.id])).rows[0];
      if (!check) deny(404, 'IT_CHECK_NOT_STARTED', 'This quarter\'s check has not started yet', '本季度的账号确认还没有开始。');
      const mine = new Map((await loadAccounts(tx, u, 'mine')).map(a => [a.id, a]));
      let flagged = 0;
      for (const item of v.items) {
        const a = mine.get(item.accountId);
        if (!a) deny(404, 'NOT_FOUND', 'Account not found', '找不到这个账号。');
        if (!item.ok) { await flag(tx, u, a.id, 'needs_change', item.note); flagged++; }
      }
      if (v.missing) { await flag(tx, u, null, 'missing', v.missing); flagged++; }
      await tx.query("UPDATE it_checks SET status='done',confirmed_at=now(),note=$4 WHERE org_id=$1 AND quarter=$2 AND user_id=$3", [u.org_id, quarter, u.id, v.missing]);
      await audit(tx, u, { id: 'it-check-' + quarter, owner_id: u.id }, 'it.check.confirm', { quarter, confirmed: v.items.length, flagged });
      if (flagged) {
        const who = nameOf((await people(tx, u.org_id)).get(u.id));
        await pushInbox(tx, { orgId: u.org_id, recipients: await itRecipients(tx, u.org_id), actorId: u.id, kind: 'it_reminder', title: `${who} 的季度确认有 ${flagged} 项需要处理`, body: quarter });
      }
      return { quarter, status: 'done', flagged };
    });
  });

  /* ---------- summary and reminders ---------- */
  app.get('/it/summary', async req => {
    const u = actorOf(req); requireSeesAll(u);
    const names = await people(db, u.org_id), rows = await loadAccounts(db, u, 'all');
    const costs: Record<string, { monthly: number; yearly: number }> = {}, byCategory = new Map<string, any>();
    for (const a of rows) {
      if (a.cost === null || a.status === 'cancelled') continue;
      const m = monthlyCost(a), y = a.cycle === 'yearly' ? Number(a.cost) : m * 12, cur = a.currency || 'CNY';
      costs[cur] ??= { monthly: 0, yearly: 0 }; costs[cur].monthly += m; costs[cur].yearly += y;
      const key = a.category + '|' + cur, c = byCategory.get(key) || { category: a.category, currency: cur, monthly: 0, yearly: 0, count: 0 };
      c.monthly += m; c.yearly += y; c.count++; byCategory.set(key, c);
    }
    for (const c of Object.values(costs)) { c.monthly = round2(c.monthly); c.yearly = round2(c.yearly); }
    const renewals = rows.filter(a => a.status !== 'cancelled').map(a => ({ a, date: renewalOf(a) })).filter(x => x.date && daysTo(x.date) <= 60 && daysTo(x.date) >= -30)
      .map(({ a, date }) => ({ id: a.id, service: a.service, date, days: daysTo(date!), cost: a.cost === null ? null : Number(a.cost), currency: a.currency, cycle: a.cycle, autoRenew: a.auto_renew, status: a.status }))
      .sort((x, y) => x.days - y.days);
    const brief = (a: any) => ({ id: a.id, service: a.service, login: a.login });
    const live = rows.filter(a => a.status !== 'cancelled');
    const noOwner = live.filter(a => !a.owner_id || !usable(names.get(a.owner_id))).map(a => ({ ...brief(a), ownerName: a.owner_id ? nameOf(names.get(a.owner_id)) : '' }));
    const noVault = live.filter(a => !a.vault_ref).map(brief);
    const leaving: any[] = [];
    for (const a of live) {
      for (const [role, pid] of [['owner', a.owner_id], ['mfa', a.mfa_holder_id], ...a.user_ids.map((x: string) => ['user', x])] as [string, string | null][])
        if (pid && names.get(pid)?.hr_status === 'leaving') leaving.push({ ...brief(a), role, userId: pid, name: nameOf(names.get(pid)) });
    }
    const openFlags = Number((await db.query('SELECT count(*)::int n FROM it_flags WHERE org_id=$1 AND resolved_at IS NULL', [u.org_id])).rows[0].n);
    return {
      costs, byCategory: [...byCategory.values()].map(c => ({ ...c, monthly: round2(c.monthly), yearly: round2(c.yearly) })).sort((a, b) => b.yearly - a.yearly),
      renewals, noOwner, noVault, leaving,
      counts: { total: rows.length, active: rows.filter(a => a.status === 'active').length, toCancel: rows.filter(a => a.status === 'to_cancel').length,
        noOwner: noOwner.length, noVault: noVault.length, leaving: leaving.length, openFlags },
    };
  });

  type Due = { key: string; kind: 'renewal' | 'cancel_before_renewal' | 'leaving_owner' | 'leaving_mfa'; accountId: string; service: string; ownerId: string | null; date?: string; days?: number; name?: string; once?: boolean };
  const dueItems = async (orgId: string): Promise<Due[]> => {
    const names = await people(db, orgId);
    const rows = (await db.query("SELECT * FROM it_accounts WHERE org_id=$1 AND status<>'cancelled'", [orgId])).rows;
    const out: Due[] = [];
    for (const a of rows) {
      const date = renewalOf(a);
      if (date && daysTo(date) <= 30 && daysTo(date) >= 0) {
        out.push({ key: `renewal:${a.id}:${date}`, kind: 'renewal', accountId: a.id, service: a.service, ownerId: a.owner_id, date, days: daysTo(date) });
        if (a.status === 'to_cancel' && a.auto_renew) out.push({ key: `cancel:${a.id}:${date}`, kind: 'cancel_before_renewal', accountId: a.id, service: a.service, ownerId: a.owner_id, date, days: daysTo(date), once: true });
      }
      if (a.owner_id && names.get(a.owner_id)?.hr_status === 'leaving')
        out.push({ key: `leaving:${a.id}:owner:${a.owner_id}`, kind: 'leaving_owner', accountId: a.id, service: a.service, ownerId: null, name: nameOf(names.get(a.owner_id)), once: true });
      if (a.mfa_holder_id && names.get(a.mfa_holder_id)?.hr_status === 'leaving')
        out.push({ key: `leaving:${a.id}:mfa:${a.mfa_holder_id}`, kind: 'leaving_mfa', accountId: a.id, service: a.service, ownerId: a.owner_id === a.mfa_holder_id ? null : a.owner_id, name: nameOf(names.get(a.mfa_holder_id)), once: true });
    }
    return out.sort((x, y) => (x.days ?? -1) - (y.days ?? -1));
  };
  app.get('/it/reminders', async req => {
    const u = actorOf(req); requireIt(u);
    return { items: (await dueItems(u.org_id)).map(({ once, ...x }) => x) };
  });

  const TITLES = {
    renewal: (d: Due) => d.days! > 0 ? `${d.service} 还有 ${d.days} 天续费` : `${d.service} 今天续费`,
    cancel_before_renewal: (d: Due) => `${d.service} 标记为待取消，但仍会在 ${d.date} 自动续费`,
    leaving_owner: (d: Due) => `${d.service} 的负责人 ${d.name} 即将离职，请转交账号`,
    leaving_mfa: (d: Due) => `${d.service} 的两步验证绑定在即将离职的 ${d.name} 名下，请转移`,
  };
  /** Inbox reminders: renewals at 30/7/0 days, a to-cancel subscription still set to auto-renew, owners and 2FA holders who
   * are leaving (to IT and the account owner); the quarterly round auto-starts in the first week of a quarter, and people
   * who have not confirmed are reminded 7 and 14 days after it started. Each reminder is sent once. */
  async function runReminders() {
    if (!itIds.size) return 0;
    let sent = 0;
    const once = async (key: string) => (await db.query('INSERT INTO it_reminder_log(key) VALUES($1) ON CONFLICT DO NOTHING RETURNING key', [key])).rows.length > 0;
    const orgs = (await db.query('SELECT DISTINCT org_id FROM users WHERE id=ANY($1::text[]) AND active=true', [[...itIds]])).rows.map((r: any) => r.org_id);
    const t = today(), quarter = quarterOf(t), dayOfQuarter = daysTo(quarterStart(quarter)) * -1 + 1;
    for (const orgId of orgs) {
      const it = await itRecipients(db, orgId);
      for (const item of await dueItems(orgId)) {
        const threshold = item.once ? 'once' : [30, 7, 0].find(x => item.days! <= x && item.days! > (x === 30 ? 7 : x === 7 ? 0 : -1));
        if (threshold === undefined || !(await once(`${item.key}:${threshold}`))) continue;
        sent += await pushInbox(db, { orgId, recipients: [...it, item.ownerId], actorId: 'system', kind: 'it_reminder', title: TITLES[item.kind](item), body: item.date || '' });
      }
      if (dayOfQuarter <= 7 && !(await db.query('SELECT 1 FROM it_checks WHERE org_id=$1 AND quarter=$2 LIMIT 1', [orgId, quarter])).rows.length)
        sent += await db.transaction(tx => startChecks(tx, orgId, quarter));
      const pending = (await db.query("SELECT user_id,started_on FROM it_checks WHERE org_id=$1 AND quarter=$2 AND status='pending'", [orgId, quarter])).rows;
      for (const p of pending) {
        const age = -daysTo(ymd(p.started_on)!), step = age >= 14 ? 14 : age >= 7 ? 7 : 0;
        if (!step || !(await once(`check:${orgId}:${quarter}:${p.user_id}:${step}`))) continue;
        sent += await pushInbox(db, { orgId, recipients: [p.user_id], actorId: 'system', kind: 'it_reminder', title: `你还没有确认本季度的账号与设备（${quarter}）`, body: 'IT 资产与账号 → 我的账号' });
      }
    }
    return sent;
  }

  /* ---------- CSV ---------- */
  const csvReply = (reply: any, name: string, body: string) => reply.header('content-type', 'text/csv; charset=utf-8').header('cache-control', 'no-store')
    .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`).send('﻿' + body);
  app.get('/it/import-template.csv', async (req, reply) => {
    const u = actorOf(req); requireIt(u);
    return csvReply(reply, 'IT账号登记模板.csv', CSV_COLUMNS.map(c => c[1]).join(',') + '\r\n');
  });
  app.get('/it/accounts.csv', async (req, reply) => {
    const u = actorOf(req); requireSeesAll(u);
    const names = await people(db, u.org_id), who = (pid: string | null) => pid ? (names.get(pid)?.email || nameOf(names.get(pid))) : '';
    const lines = [CSV_COLUMNS.map(c => c[1]).join(',')];
    for (const a of await loadAccounts(db, u, 'all')) {
      const v: Record<string, unknown> = {
        service: a.service, category: LABELS.category[a.category], login: a.login, url: a.url, owner: who(a.owner_id), users: a.user_ids.map(who).join(';'),
        vaultRef: a.vault_ref, mfaMethod: LABELS.mfaMethod[a.mfa_method], mfaHolder: who(a.mfa_holder_id), mfaNote: a.mfa_note, shared: a.shared ? '是' : '否',
        status: LABELS.status[a.status], mailboxType: a.mailbox_type ? LABELS.mailboxType[a.mailbox_type] : '', plan: a.plan, seats: a.seats, cost: a.cost === null ? '' : Number(a.cost),
        currency: a.currency, cycle: a.cycle ? LABELS.cycle[a.cycle] : '', nextRenewal: ymd(a.next_renewal), paymentLabel: a.payment_label, cardLast4: a.card_last4,
        autoRenew: a.cycle ? (a.auto_renew ? '是' : '否') : '', invoiceContact: a.invoice_contact, notes: a.notes,
      };
      lines.push(CSV_COLUMNS.map(([k]) => cell(v[k])).join(','));
    }
    await audit(db, u, { id: 'it-accounts-export' }, 'it.account.export', { rows: lines.length - 1 });
    return csvReply(reply, `IT账号-${today()}.csv`, lines.join('\r\n') + '\r\n');
  });

  app.post('/it/accounts/import', { bodyLimit: 2_200_000 }, async (req, reply) => {
    const u = actorOf(req); requireIt(u);
    const v = importInput.parse(req.body), en = req.language === 'en';
    const rows = parseCsv(v.csv);
    if (rows.length < 2) deny(400, 'IT_IMPORT_EMPTY', 'The file has no rows to import', '文件里没有可导入的数据行。');
    if (rows.length - 1 > MAX_IMPORT_ROWS) deny(400, 'IT_IMPORT_TOO_MANY', 'Import at most 2000 rows at a time', '一次最多导入 2000 行。');
    const header = rows[0].map(h => h.trim().replace(/\s+/g, '').toLowerCase());
    const colIndex = new Map<string, number>();
    CSV_COLUMNS.forEach(([key, zh, en2]) => { const i = header.findIndex(h => h === zh || h === en2 || h === key.toLowerCase()); if (i >= 0) colIndex.set(key, i); });
    if (!colIndex.has('service')) deny(400, 'IT_IMPORT_HEADER', 'The first row must include a 服务名称 / service column', '第一行必须是表头，并且包含“服务名称”这一列。请用导入模板。');
    const names = [...(await people(db, u.org_id)).values()].filter(usable);
    const findPerson = (raw: string): string | null => {
      const s = raw.trim();
      if (!s) return null;
      const lower = s.toLowerCase(), hits = names.filter(p => p.id === s || (p.email && p.email.toLowerCase() === lower) || p.display_name === s || p.name_zh === s || (p.name_en && p.name_en.toLowerCase() === lower));
      if (hits.length === 1) return hits[0].id;
      throw new Error(hits.length ? (en ? `"${s}" matches more than one person; use their email` : `“${s}” 对应多位员工，请改填邮箱`) : (en ? `No active member "${s}"` : `找不到在职员工“${s}”`));
    };
    const existing = new Set((await db.query('SELECT lower(service) s,lower(login) l FROM it_accounts WHERE org_id=$1', [u.org_id])).rows.map((r: any) => r.s + '\n' + r.l));
    const errors: { row: number; message: string }[] = [], ready: { row: number; next: Record<string, any>; userIds: string[] }[] = [], skipped: number[] = [];
    const seen = new Set<string>();
    for (let r = 1; r < rows.length; r++) {
      const raw = (key: string) => unformula((rows[r][colIndex.get(key) ?? -1] ?? '').trim());
      try {
        const input: Record<string, any> = {};
        for (const [key] of CSV_COLUMNS) {
          if (!colIndex.has(key) || ['owner', 'users', 'mfaHolder'].includes(key)) continue;
          const s = raw(key);
          if (key in LABELS) { if (s) input[key] = enumFrom(key, s); continue; }
          if (key === 'shared' || key === 'autoRenew') { const b = boolFrom(s); if (b === null) throw new Error(en ? `${key}: use 是 or 否` : `“${CSV_COLUMNS.find(c => c[0] === key)![1]}”请填“是”或“否”`); input[key] = b; continue; }
          if (key === 'seats' || key === 'cost') { if (s) { const n = Number(s.replace(/[,，¥$￥]/g, '')); if (!Number.isFinite(n)) throw new Error(en ? `${key} must be a number` : `“${CSV_COLUMNS.find(c => c[0] === key)![1]}”必须是数字`); input[key] = n; } continue; }
          if (key === 'nextRenewal') { if (s) input[key] = s.replace(/[/.]/g, '-').replace(/^(\d{4})-(\d)-/, '$1-0$2-').replace(/-(\d)$/, '-0$1'); continue; }
          if (key === 'currency') { if (s) input[key] = s.toUpperCase() === 'RMB' || s === '人民币' ? 'CNY' : s === '美元' ? 'USD' : s.toUpperCase(); continue; }
          if (s) input[key] = s;
        }
        if (input.category === undefined) input.category = 'saas';
        input.ownerId = colIndex.has('owner') ? findPerson(raw('owner')) : null;
        input.mfaHolderId = colIndex.has('mfaHolder') ? findPerson(raw('mfaHolder')) : null;
        const userIds = colIndex.has('users') ? raw('users').split(/[;；,，、]/).map(x => x.trim()).filter(Boolean).map(x => findPerson(x)!) : [];
        const parsed = createInput.safeParse(input);
        if (!parsed.success) {
          const path = String(parsed.error.issues[0]?.path[0] ?? ''), col = CSV_COLUMNS.find(c => c[0] === path || c[0] + 'Id' === path);
          throw new Error(en ? `Invalid value in ${col?.[2] || path}` : `“${col?.[1] || path}”的内容不正确`);
        }
        guard(parsed.data);
        const dupKey = parsed.data.service.toLowerCase() + '\n' + (parsed.data.login || '').toLowerCase();
        if (existing.has(dupKey)) { skipped.push(r + 1); continue; }
        if (seen.has(dupKey)) throw new Error(en ? 'Same service and login as an earlier row' : '和前面某一行的服务名称、登录账号重复');
        seen.add(dupKey);
        ready.push({ row: r + 1, next: merge(null, parsed.data), userIds });
      } catch (e: any) {
        errors.push({ row: r + 1, message: e instanceof ApiError ? (en ? e.message : e.zh || e.message) : String(e?.message || e) });
      }
    }
    if (errors.length) return reply.code(400).send({ error: { code: 'IT_IMPORT_INVALID', message: en ? 'Some rows need fixing; nothing was imported' : '有些行需要修改，本次没有导入任何数据。',
      fields: errors.map(x => ({ path: String(x.row), code: 'row', message: x.message })) }, errors, rows: rows.length - 1 });
    if (v.dryRun) return { dryRun: true, rows: rows.length - 1, toImport: ready.length, skipped };
    return db.transaction(async tx => {
      for (const item of ready) {
        const accountId = await insertAccount(tx, u, item.next, item.userIds);
        await audit(tx, u, { id: accountId, owner_id: item.next.owner_id }, 'it.account.create', { fields: ['import'] });
      }
      return { dryRun: false, rows: rows.length - 1, imported: ready.length, skipped };
    });
  });

  if (o.intervalMs && o.intervalMs > 0) {
    const timer = setInterval(() => { runReminders().catch(() => undefined); }, o.intervalMs);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  return { runReminders };
}
