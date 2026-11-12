/* Finance (财务) — accounts receivable (应收账款). Accounts payable comes later.
 *
 * One record per invoice: who is responsible (sales or account manager), customer company (optional) and contact
 * (name, email and phone required), the shipping address (street, line 2 optional, city, state, ZIP, country),
 * invoice date, payment term and due date, our order number, total, whether the goods were dispatched,
 * the expected payment method, invoice files, payments received and a follow-up log.
 *
 * Amounts: received = payments that cleared; "check deposited" payments are counted separately until they
 * clear; outstanding = total − received; paid % = received ÷ total. Status follows from the payments:
 *   未收款 unpaid · 部分收款 partial · 支票已存待到账 deposit (cleared + deposited covers the total) · 已收清 paid.
 * Overdue = not fully received and the due date has passed.
 *
 * Access (CLAUDE.md rule 6 style, grants set by main admins only, in the module's 权限 tab):
 *   finance_manage  view everything, add and edit invoices, payments, files and notes
 *   finance_view    view everything (read only)
 *   responsible     the person named on an invoice sees it and can record its payments and follow-ups (SOP 5),
 *                   without seeing anyone else's
 * Main admins (WORKOS_EXECUTIVE_USER_IDS) manage everything. Nobody else sees any of it. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';

export const financeSchema = `
CREATE TABLE IF NOT EXISTS fin_receivables(id text PRIMARY KEY, org_id text NOT NULL, number text NOT NULL, responsible_id text,
  invoice_date date NOT NULL, payment_term text NOT NULL DEFAULT '', term_days integer, due_date date,
  customer text NOT NULL DEFAULT '', contact text NOT NULL DEFAULT '', contact_email text NOT NULL DEFAULT '', contact_phone text NOT NULL DEFAULT '',
  ship_street text NOT NULL DEFAULT '', ship_line2 text NOT NULL DEFAULT '', ship_city text NOT NULL DEFAULT '', ship_state text NOT NULL DEFAULT '', ship_zip text NOT NULL DEFAULT '',
  ship_country text NOT NULL DEFAULT 'US', kind text NOT NULL DEFAULT '', order_ref text NOT NULL DEFAULT '',
  amount numeric NOT NULL CHECK (amount >= 0), currency text NOT NULL DEFAULT 'USD', dispatched boolean NOT NULL DEFAULT false, dispatched_on date,
  pay_method text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS fin_receivables_number ON fin_receivables(org_id, number);
CREATE TABLE IF NOT EXISTS fin_payments(id text PRIMARY KEY, org_id text NOT NULL, receivable_id text NOT NULL, received_on date NOT NULL, amount numeric NOT NULL CHECK (amount > 0),
  method text NOT NULL DEFAULT '', state text NOT NULL DEFAULT 'cleared' CHECK (state IN ('cleared','deposited')), reference text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS fin_payments_receivable ON fin_payments(receivable_id);
CREATE TABLE IF NOT EXISTS fin_files(id text PRIMARY KEY, org_id text NOT NULL, receivable_id text NOT NULL, name text NOT NULL, mime text NOT NULL, size integer NOT NULL,
  data bytea NOT NULL, uploader_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS fin_files_receivable ON fin_files(receivable_id);
CREATE TABLE IF NOT EXISTS fin_notes(id text PRIMARY KEY, org_id text NOT NULL, receivable_id text NOT NULL, actor_id text NOT NULL, kind text NOT NULL DEFAULT 'note',
  body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS fin_notes_receivable ON fin_notes(receivable_id, created_at);
`;

export const FINANCE_GRANTS = ['finance_view', 'finance_manage'] as const;
export const PAY_METHODS = ['check', 'ach', 'wire', 'quickbooks', 'card', 'paypal', 'cash', 'other'] as const;
export const TERMS: [string, number | null][] = [['due_on_receipt', 0], ['net15', 15], ['net30', 30], ['net45', 45], ['net60', 60], ['net90', 90], ['prepaid', 0], ['custom', null]];
const MAX_FILE = 10 * 1024 * 1024, MAX_FILES = 20;
const FILE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'text/csv': 'csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/msword': 'doc',
};
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-02');
const money = z.number().finite().min(0).max(100_000_000);
const ymd = (d: unknown) => d ? (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10) : null;
const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (date: string, n: number) => { const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/* Contact and shipping address checks (format only; no address lookup service yet). The page uses the same rules. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** USPS two-letter codes: states, DC, territories and military (AA/AE/AP). */
export const US_STATES = new Set(('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY ' +
  'DC PR GU VI AS MP AA AE AP').split(' '));
/** A phone number in one stored form. US numbers (10 digits, or 11 starting with 1, any punctuation) become +1XXXXXXXXXX;
 *  other countries are written with + and the country code (8–15 digits). null when it is not a valid number. */
export function normalizePhone(raw: string): string | null {
  const s = String(raw || '').trim();
  if (!s || /[^\d\s()+.\-]/.test(s) || s.indexOf('+') > 0 || (s.match(/\+/g) || []).length > 1) return null;
  const d = s.replace(/\D/g, '');
  const us = (ten: string) => /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? '+1' + ten : null;
  if (s.startsWith('+')) return d.startsWith('1') ? (d.length === 11 ? us(d.slice(1)) : null) : d.length >= 8 && d.length <= 15 ? '+' + d : null;
  if (d.length === 10) return us(d);
  if (d.length === 11 && d.startsWith('1')) return us(d.slice(1));
  return null;
}
/** ZIP: 5 digits or ZIP+4; 9 digits without the dash are written as 12345-6789. null when invalid. */
export function normalizeZip(raw: string): string | null {
  const s = String(raw || '').trim();
  if (/^\d{5}(-\d{4})?$/.test(s)) return s;
  if (/^\d{9}$/.test(s)) return s.slice(0, 5) + '-' + s.slice(5);
  return null;
}
type Contact = { customer: string; contact: string; contactEmail: string; contactPhone: string; shipStreet: string; shipLine2: string; shipCity: string; shipState: string; shipZip: string; shipCountry: string };
/** Checks the contact and address, and returns them in the stored form (phone +1…, state and country upper case). */
export function checkContact(v: Contact): Contact {
  const t = (x: unknown) => String(x ?? '').trim();
  const contact = t(v.contact), contactEmail = t(v.contactEmail), shipCountry = (t(v.shipCountry) || 'US').toUpperCase();
  if (!contact) deny(400, 'FINANCE_CONTACT', 'Enter the contact name', '请填写联系人姓名。');
  if (!EMAIL_RE.test(contactEmail)) deny(400, 'FINANCE_EMAIL', 'Enter a valid contact email, like name@example.com', '请填写正确的联系人邮箱，例如 name@example.com。');
  const contactPhone = normalizePhone(v.contactPhone);
  if (!contactPhone) deny(400, 'FINANCE_PHONE', 'Enter a valid phone number: 10 digits for the US, or + and the country code', '请填写正确的联系电话：美国号码 10 位，其他国家请以 + 和国家代码开头。');
  if (!/^[A-Z]{2}$/.test(shipCountry)) deny(400, 'FINANCE_COUNTRY', 'Use the two-letter country code, e.g. US', '国家请用两位字母代码，例如 US。');
  const shipStreet = t(v.shipStreet), shipCity = t(v.shipCity), us = shipCountry === 'US';
  let shipState = t(v.shipState), shipZip = t(v.shipZip);
  if (!shipStreet || !shipCity || (us && (!shipState || !shipZip))) deny(400, 'FINANCE_ADDRESS', 'Enter the shipping address: street, city, state and ZIP', '请填写完整的收货地址：街道地址、城市、州和邮编。');
  if (us) {
    shipState = shipState.toUpperCase();
    if (!US_STATES.has(shipState)) deny(400, 'FINANCE_STATE', 'Use the two-letter state code, e.g. CA', '州请用两位字母缩写，例如 CA。');
    const zip = normalizeZip(shipZip);
    if (!zip) deny(400, 'FINANCE_ZIP', 'ZIP must be 5 digits, or ZIP+4 like 12345-6789', '邮编要 5 位数字，或 5+4 位，例如 12345-6789。');
    shipZip = zip;
  }
  return { customer: t(v.customer), contact, contactEmail, contactPhone, shipStreet, shipLine2: t(v.shipLine2), shipCity, shipState, shipZip, shipCountry };
}
const CONTACT_KEYS = ['customer', 'contact', 'contactEmail', 'contactPhone', 'shipStreet', 'shipLine2', 'shipCity', 'shipState', 'shipZip', 'shipCountry'] as const;

/** Status and amounts of one invoice from its payments. */
export function arState(amount: number, payments: { amount: number; state: string }[], dueDate: string | null, today: string) {
  const received = round2(payments.filter(p => p.state === 'cleared').reduce((s, p) => s + Number(p.amount), 0));
  const deposited = round2(payments.filter(p => p.state === 'deposited').reduce((s, p) => s + Number(p.amount), 0));
  const outstanding = round2(Math.max(0, amount - received));
  const status = amount > 0 && received >= amount ? 'paid' : amount > 0 && received + deposited >= amount ? 'deposit' : received + deposited > 0 ? 'partial' : amount === 0 ? 'paid' : 'unpaid';
  const overdue = status !== 'paid' && !!dueDate && dueDate < today;
  const daysOverdue = overdue ? Math.round((Date.parse(today) - Date.parse(dueDate!)) / 86400000) : 0;
  return { received, deposited, outstanding, paidPct: amount > 0 ? Math.min(100, round2(received / amount * 100)) : 100, status, overdue, daysOverdue };
}

export async function registerFinanceRoutes(app: FastifyInstance, db: Database, o: { isAdmin: (u: User) => boolean; now?: () => number }) {
  const now = o.now || Date.now, today = () => new Date(now()).toISOString().slice(0, 10);
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const grantsOf = (u: any): string[] => Array.isArray(u.grants) ? u.grants : [];
  /** 'manage' | 'view' | 'own' (responsible for at least one invoice) | 'none' */
  const levelOf = (u: User) => o.isAdmin(u) || grantsOf(u).includes('finance_manage') ? 'manage' : grantsOf(u).includes('finance_view') ? 'view' : 'own';
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const requireManage = (u: User) => { if (levelOf(u) !== 'manage') deny(403, 'FINANCE_MANAGE_ONLY', 'Only people allowed to manage finance can do this', '只有财务管理权限的人可以操作。'); };
  /** An invoice this person may open: everyone with view/manage, or the responsible person. */
  const recordOf = async (tx: Queryable, u: User, rid: string, lock = false) => {
    const r = (await tx.query(`SELECT * FROM fin_receivables WHERE id=$1 AND org_id=$2 AND archived_at IS NULL${lock ? ' FOR UPDATE' : ''}`, [rid, u.org_id])).rows[0];
    if (!r || (levelOf(u) === 'own' && r.responsible_id !== u.id)) deny(404, 'FINANCE_NOT_FOUND', 'Invoice not found', '找不到这张发票记录。');
    return r;
  };
  /** Recording payments and follow-ups: managers, or the responsible person on their own invoices (SOP 5). */
  const canWork = (u: User, r: any) => levelOf(u) === 'manage' || r.responsible_id === u.id;
  const note = (tx: Queryable, u: User, rid: string, kind: string, body: string) =>
    tx.query('INSERT INTO fin_notes(id,org_id,receivable_id,actor_id,kind,body) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), u.org_id, rid, u.id, kind, body.slice(0, 2000)]);
  const peopleOf = async (org: string) => new Map((await db.query('SELECT id,display_name,name_zh,name_en,active FROM users WHERE org_id=$1', [org])).rows.map((p: any) => [p.id, p]));
  const nameOf = (p: any) => p ? (p.name_zh || p.display_name || p.name_en || p.id) : '';

  const shape = (r: any, pays: any[], files: number, ppl: Map<string, any>) => {
    const s = arState(Number(r.amount), pays.map(p => ({ amount: Number(p.amount), state: p.state })), ymd(r.due_date), today());
    return { id: r.id, number: r.number, responsibleId: r.responsible_id, responsibleName: nameOf(ppl.get(r.responsible_id)), invoiceDate: ymd(r.invoice_date),
      paymentTerm: r.payment_term, termDays: r.term_days, dueDate: ymd(r.due_date), customer: r.customer, contact: r.contact, contactEmail: r.contact_email, contactPhone: r.contact_phone,
      shipStreet: r.ship_street, shipLine2: r.ship_line2, shipCity: r.ship_city, shipState: r.ship_state, shipZip: r.ship_zip, shipCountry: r.ship_country, kind: r.kind,
      orderRef: r.order_ref, amount: Number(r.amount), currency: r.currency, dispatched: r.dispatched, dispatchedOn: ymd(r.dispatched_on), payMethod: r.pay_method, note: r.note,
      fileCount: files, createdAt: r.created_at, updatedAt: r.updated_at, ...s };
  };

  app.get('/finance/receivables', async req => {
    const u = actorOf(req), level = levelOf(u);
    const rows = (await db.query(`SELECT * FROM fin_receivables WHERE org_id=$1 AND archived_at IS NULL${level === 'own' ? ' AND responsible_id=$2' : ''} ORDER BY invoice_date DESC, number DESC`,
      level === 'own' ? [u.org_id, u.id] : [u.org_id])).rows;
    if (level === 'own' && !rows.length) deny(403, 'FINANCE_FORBIDDEN', 'You do not have access to finance', '你没有财务模块的权限。');
    const ids = rows.map((r: any) => r.id);
    const pays = ids.length ? (await db.query('SELECT * FROM fin_payments WHERE receivable_id=ANY($1::text[]) ORDER BY received_on, created_at', [ids])).rows : [];
    const files = ids.length ? (await db.query('SELECT receivable_id, count(*)::int n FROM fin_files WHERE receivable_id=ANY($1::text[]) GROUP BY receivable_id', [ids])).rows : [];
    const ppl = await peopleOf(u.org_id), fileN = new Map(files.map((f: any) => [f.receivable_id, f.n]));
    const items = rows.map((r: any) => shape(r, pays.filter((p: any) => p.receivable_id === r.id), fileN.get(r.id) || 0, ppl));
    const sum = (f: (i: any) => number) => round2(items.reduce((s: number, i: any) => s + f(i), 0));
    const open = items.filter((i: any) => i.status !== 'paid');
    const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90: 0 } as Record<string, number>;
    for (const i of open) { const k = !i.overdue ? 'current' : i.daysOverdue <= 30 ? 'd1_30' : i.daysOverdue <= 60 ? 'd31_60' : i.daysOverdue <= 90 ? 'd61_90' : 'd90'; aging[k] = round2(aging[k] + i.outstanding); }
    const total = sum(i => i.amount), received = sum(i => i.received);
    const responsible = [...new Map(items.filter((i: any) => i.responsibleId).map((i: any) => [i.responsibleId, i.responsibleName])).entries()].map(([id, name]) => ({ id, name }));
    const assignable = level === 'manage' ? [...ppl.values()].filter((p: any) => p.active).map((p: any) => ({ id: p.id, name: nameOf(p) })).sort((a, b) => a.name.localeCompare(b.name)) : [];
    return { level, items, people: assignable, responsible, terms: TERMS.map(([k, d]) => ({ key: k, days: d })), methods: PAY_METHODS,
      summary: { count: items.length, total, received, outstanding: sum(i => i.outstanding), deposited: sum(i => i.deposited), paidPct: total > 0 ? round2(received / total * 100) : 100,
        overdue: round2(open.filter((i: any) => i.overdue).reduce((s: number, i: any) => s + i.outstanding, 0)), overdueCount: open.filter((i: any) => i.overdue).length,
        shippedUnpaid: round2(open.filter((i: any) => i.dispatched).reduce((s: number, i: any) => s + i.outstanding, 0)), shippedUnpaidCount: open.filter((i: any) => i.dispatched).length, aging } };
  });

  app.get<{ Params: { id: string } }>('/finance/receivables/:id', async req => {
    const u = actorOf(req), r = await recordOf(db, u, id.parse(req.params.id));
    const pays = (await db.query('SELECT * FROM fin_payments WHERE receivable_id=$1 ORDER BY received_on, created_at', [r.id])).rows;
    const files = (await db.query('SELECT id,name,mime,size,uploader_id,created_at FROM fin_files WHERE receivable_id=$1 ORDER BY created_at', [r.id])).rows;
    const notes = (await db.query('SELECT * FROM fin_notes WHERE receivable_id=$1 ORDER BY created_at DESC LIMIT 200', [r.id])).rows;
    const ppl = await peopleOf(u.org_id);
    return { ...shape(r, pays, files.length, ppl), canEdit: levelOf(u) === 'manage', canWork: canWork(u, r),
      payments: pays.map((p: any) => ({ id: p.id, receivedOn: ymd(p.received_on), amount: Number(p.amount), method: p.method, state: p.state, reference: p.reference, note: p.note, by: nameOf(ppl.get(p.created_by)) })),
      files: files.map((f: any) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, by: nameOf(ppl.get(f.uploader_id)), at: f.created_at })),
      notes: notes.map((n: any) => ({ id: n.id, kind: n.kind, body: n.body, by: nameOf(ppl.get(n.actor_id)), at: n.created_at })) };
  });

  const fields = {
    responsibleId: id.nullable(), invoiceDate: day, paymentTerm: z.string().trim().max(40), termDays: z.number().int().min(0).max(365).nullable(), dueDate: day.nullable(),
    customer: z.string().trim().max(200), contact: z.string().trim().max(120), contactEmail: z.string().trim().max(200), contactPhone: z.string().trim().max(40),
    shipStreet: z.string().trim().max(200), shipLine2: z.string().trim().max(200), shipCity: z.string().trim().max(100), shipState: z.string().trim().max(60), shipZip: z.string().trim().max(20),
    shipCountry: z.string().trim().max(60), kind: z.string().trim().max(60),
    orderRef: z.string().trim().max(80), amount: money, dispatched: z.boolean(), dispatchedOn: day.nullable(), payMethod: z.string().trim().max(40), note: z.string().trim().max(4000),
  };
  // Contact name, email, phone and the address are checked by checkContact (with clear messages), so zod only caps their length.
  const createInput = z.object({ ...fields, responsibleId: id.nullable().optional(), paymentTerm: fields.paymentTerm.optional(), termDays: fields.termDays.optional(), dueDate: fields.dueDate.optional(),
    customer: fields.customer.optional(), contact: fields.contact.optional(), contactEmail: fields.contactEmail.optional(), contactPhone: fields.contactPhone.optional(),
    shipStreet: fields.shipStreet.optional(), shipLine2: fields.shipLine2.optional(), shipCity: fields.shipCity.optional(), shipState: fields.shipState.optional(), shipZip: fields.shipZip.optional(),
    shipCountry: fields.shipCountry.optional(), kind: fields.kind.optional(), orderRef: fields.orderRef.optional(), dispatched: fields.dispatched.optional(),
    dispatchedOn: fields.dispatchedOn.optional(), payMethod: fields.payMethod.optional(), note: fields.note.optional() }).strict();
  const updateInput = z.object(fields).partial().strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');
  const col: Record<string, string> = { responsibleId: 'responsible_id', invoiceDate: 'invoice_date', paymentTerm: 'payment_term', termDays: 'term_days', dueDate: 'due_date', customer: 'customer',
    contact: 'contact', contactEmail: 'contact_email', contactPhone: 'contact_phone', shipStreet: 'ship_street', shipLine2: 'ship_line2', shipCity: 'ship_city', shipState: 'ship_state',
    shipZip: 'ship_zip', shipCountry: 'ship_country', kind: 'kind', orderRef: 'order_ref', amount: 'amount', dispatched: 'dispatched', dispatchedOn: 'dispatched_on', payMethod: 'pay_method', note: 'note' };
  const checkDates = (v: any) => {
    for (const k of ['invoiceDate', 'dueDate', 'dispatchedOn']) if (v[k] && (v[k] < '2000-01-01' || v[k] > addDays(today(), 366))) deny(400, 'FINANCE_DATE', 'Check the date', '日期不对，请检查。');
  };
  /** Due date: entered, or invoice date + term days. */
  const dueOf = (v: { invoiceDate: string; termDays?: number | null; dueDate?: string | null }) => v.dueDate !== undefined && v.dueDate !== null ? v.dueDate : v.termDays !== undefined && v.termDays !== null ? addDays(v.invoiceDate, v.termDays) : null;
  const responsibleOk = async (tx: Queryable, org: string, rid: string | null | undefined) => {
    if (!rid) return;
    if (!(await tx.query('SELECT 1 FROM users WHERE id=$1 AND org_id=$2 AND active=true', [rid, org])).rows.length) deny(400, 'FINANCE_RESPONSIBLE', 'Choose an active colleague as the responsible person', '负责人要选在职的同事。');
  };

  app.post('/finance/receivables', async (req, reply) => {
    const u = actorOf(req); requireManage(u);
    const v = createInput.parse(req.body); checkDates(v);
    const c = checkContact(v as any);
    const out = await db.transaction(async tx => {
      await responsibleOk(tx, u.org_id, v.responsibleId);
      const year = v.invoiceDate.slice(0, 4);
      const n = Number((await tx.query("SELECT count(*)::int n FROM fin_receivables WHERE org_id=$1 AND number LIKE $2", [u.org_id, `AR-${year}-%`])).rows[0].n) + 1;
      const rid = randomUUID(), number = `AR-${year}-${String(n).padStart(4, '0')}`;
      await tx.query(`INSERT INTO fin_receivables(id,org_id,number,responsible_id,invoice_date,payment_term,term_days,due_date,customer,contact,contact_email,contact_phone,
          ship_street,ship_line2,ship_city,ship_state,ship_zip,ship_country,kind,order_ref,amount,dispatched,dispatched_on,pay_method,note,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
        [rid, u.org_id, number, v.responsibleId || null, v.invoiceDate, v.paymentTerm || '', v.termDays ?? null, dueOf(v), c.customer, c.contact, c.contactEmail, c.contactPhone,
          c.shipStreet, c.shipLine2, c.shipCity, c.shipState, c.shipZip, c.shipCountry, v.kind || '', v.orderRef || '',
          v.amount, !!v.dispatched, v.dispatched ? (v.dispatchedOn || null) : null, v.payMethod || '', v.note || '', u.id]);
      await note(tx, u, rid, 'created', `${number} · $${v.amount}`);
      await audit(tx, u, 'finance.receivable_created', rid, { number, amount: v.amount });
      return { id: rid, number };
    });
    return reply.code(201).send(out);
  });

  app.patch<{ Params: { id: string } }>('/finance/receivables/:id', async req => {
    const u = actorOf(req); requireManage(u);
    const v = updateInput.parse(req.body); checkDates(v);
    return db.transaction(async tx => {
      const r = await recordOf(tx, u, id.parse(req.params.id), true);
      if (v.responsibleId !== undefined) await responsibleOk(tx, u.org_id, v.responsibleId);
      const next: any = { ...v };
      // Contact or address touched: check the whole set as it will be saved, so nothing required can be cleared.
      if (CONTACT_KEYS.some(k => (v as any)[k] !== undefined)) {
        const merged: any = { customer: r.customer, contact: r.contact, contactEmail: r.contact_email, contactPhone: r.contact_phone, shipStreet: r.ship_street, shipLine2: r.ship_line2,
          shipCity: r.ship_city, shipState: r.ship_state, shipZip: r.ship_zip, shipCountry: r.ship_country };
        for (const k of CONTACT_KEYS) if ((v as any)[k] !== undefined) merged[k] = (v as any)[k];
        const c = checkContact(merged);
        for (const k of CONTACT_KEYS) next[k] = c[k];
      }
      if (v.dispatched === false) next.dispatchedOn = null;
      // The due date follows the invoice date and term unless it was entered.
      if ((v.invoiceDate !== undefined || v.termDays !== undefined) && v.dueDate === undefined) {
        const termDays = v.termDays !== undefined ? v.termDays : r.term_days;
        if (termDays !== null && termDays !== undefined) next.dueDate = addDays(v.invoiceDate || ymd(r.invoice_date)!, termDays);
      }
      const sets: string[] = [], vals: unknown[] = [r.id];
      for (const [k, val] of Object.entries(next)) { vals.push(val); sets.push(`${col[k]}=$${vals.length}`); }
      await tx.query(`UPDATE fin_receivables SET ${sets.join(',')},updated_at=now() WHERE id=$1`, vals);
      const changed = Object.keys(v).filter(k => k !== 'note');
      if (changed.length) await note(tx, u, r.id, 'updated', changed.join(', '));
      await audit(tx, u, 'finance.receivable_updated', r.id, { fields: Object.keys(v) });
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string } }>('/finance/receivables/:id/archive', async req => {
    const u = actorOf(req); requireManage(u);
    return db.transaction(async tx => {
      const r = await recordOf(tx, u, id.parse(req.params.id), true);
      await tx.query('UPDATE fin_receivables SET archived_at=now(),updated_at=now() WHERE id=$1', [r.id]);
      await audit(tx, u, 'finance.receivable_archived', r.id, { number: r.number });
      return { ok: true };
    });
  });

  const payInput = z.object({ receivedOn: day, amount: z.number().finite().positive().max(100_000_000), method: z.string().trim().max(40).optional(),
    state: z.enum(['cleared', 'deposited']).default('cleared'), reference: z.string().trim().max(120).optional(), note: z.string().trim().max(1000).optional() }).strict();
  app.post<{ Params: { id: string } }>('/finance/receivables/:id/payments', async (req, reply) => {
    const u = actorOf(req), v = payInput.parse(req.body);
    if (v.receivedOn < '2000-01-01' || v.receivedOn > addDays(today(), 1)) deny(400, 'FINANCE_DATE', 'Check the date', '日期不对，请检查。');
    return db.transaction(async tx => {
      const r = await recordOf(tx, u, id.parse(req.params.id), true);
      if (!canWork(u, r)) deny(403, 'FINANCE_WORK_ONLY', 'Only finance managers or the responsible person can record payments', '只有财务管理人或这单的负责人可以记录收款。');
      const pid = randomUUID();
      await tx.query('INSERT INTO fin_payments(id,org_id,receivable_id,received_on,amount,method,state,reference,note,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [pid, u.org_id, r.id, v.receivedOn, v.amount, v.method || '', v.state, v.reference || '', v.note || '', u.id]);
      await tx.query('UPDATE fin_receivables SET updated_at=now() WHERE id=$1', [r.id]);
      await note(tx, u, r.id, 'payment', `${v.state === 'deposited' ? '支票已存入' : '收款'} $${v.amount}${v.method ? ' · ' + v.method : ''}${v.reference ? ' · ' + v.reference : ''}`);
      await audit(tx, u, 'finance.payment_recorded', r.id, { amount: v.amount, state: v.state });
      return reply.code(201).send({ id: pid });
    });
  });
  const payPatch = z.object({ state: z.enum(['cleared', 'deposited']).optional(), receivedOn: day.optional() }).strict().refine(v => Object.keys(v).length > 0, 'Nothing to change');
  app.post<{ Params: { id: string; pay: string } }>('/finance/receivables/:id/payments/:pay', async req => {
    const u = actorOf(req), v = payPatch.parse(req.body);
    return db.transaction(async tx => {
      const r = await recordOf(tx, u, id.parse(req.params.id), true);
      if (!canWork(u, r)) deny(403, 'FINANCE_WORK_ONLY', 'Only finance managers or the responsible person can record payments', '只有财务管理人或这单的负责人可以记录收款。');
      const p = (await tx.query('SELECT * FROM fin_payments WHERE id=$1 AND receivable_id=$2', [id.parse(req.params.pay), r.id])).rows[0] || deny(404, 'FINANCE_NOT_FOUND', 'Payment not found', '找不到这笔收款。');
      await tx.query('UPDATE fin_payments SET state=COALESCE($2,state),received_on=COALESCE($3,received_on) WHERE id=$1', [p.id, v.state || null, v.receivedOn || null]);
      if (v.state && v.state !== p.state) await note(tx, u, r.id, 'payment', v.state === 'cleared' ? `支票已到账 $${Number(p.amount)}` : `改为支票已存入待到账 $${Number(p.amount)}`);
      return { ok: true };
    });
  });
  app.post<{ Params: { id: string; pay: string } }>('/finance/receivables/:id/payments/:pay/delete', async req => {
    const u = actorOf(req); requireManage(u);
    return db.transaction(async tx => {
      const r = await recordOf(tx, u, id.parse(req.params.id), true);
      const p = (await tx.query('DELETE FROM fin_payments WHERE id=$1 AND receivable_id=$2 RETURNING amount', [id.parse(req.params.pay), r.id])).rows[0] || deny(404, 'FINANCE_NOT_FOUND', 'Payment not found', '找不到这笔收款。');
      await note(tx, u, r.id, 'payment', `删除收款记录 $${Number(p.amount)}`);
      await audit(tx, u, 'finance.payment_deleted', r.id, { amount: Number(p.amount) });
      return { ok: true };
    });
  });

  const noteInput = z.object({ body: z.string().trim().min(1).max(2000) }).strict();
  app.post<{ Params: { id: string } }>('/finance/receivables/:id/notes', async (req, reply) => {
    const u = actorOf(req), v = noteInput.parse(req.body);
    return db.transaction(async tx => {
      const r = await recordOf(tx, u, id.parse(req.params.id));
      if (!canWork(u, r)) deny(403, 'FINANCE_WORK_ONLY', 'Only finance managers or the responsible person can record payments', '只有财务管理人或这单的负责人可以记录收款。');
      await note(tx, u, r.id, 'note', v.body);
      return reply.code(201).send({ ok: true });
    });
  });

  const fileInput = z.object({ name: z.string().trim().min(1).max(200), mime: z.string().max(120), dataBase64: z.string().min(4) }).strict();
  app.post<{ Params: { id: string } }>('/finance/receivables/:id/files', { bodyLimit: Math.ceil(MAX_FILE * 4 / 3) + 4096 }, async (req, reply) => {
    const u = actorOf(req), v = fileInput.parse(req.body);
    const mime = v.mime.split(';')[0].trim().toLowerCase();
    if (!FILE_TYPES[mime]) deny(400, 'FINANCE_FILE_TYPE', 'Upload a PDF, image, Excel, Word or CSV file', '请上传 PDF、图片、Excel、Word 或 CSV 文件。');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v.dataBase64)) deny(400, 'FINANCE_FILE_INVALID', 'The file could not be read', '文件读取失败，请重新上传。');
    const data = Buffer.from(v.dataBase64, 'base64');
    if (!data.length || data.length > MAX_FILE) deny(400, 'FINANCE_FILE_TOO_LARGE', 'Files must be 10 MB or smaller', '文件不能超过 10 MB。');
    return db.transaction(async tx => {
      const r = await recordOf(tx, u, id.parse(req.params.id), true);
      if (!canWork(u, r)) deny(403, 'FINANCE_WORK_ONLY', 'Only finance managers or the responsible person can record payments', '只有财务管理人或这单的负责人可以记录收款。');
      if (Number((await tx.query('SELECT count(*)::int n FROM fin_files WHERE receivable_id=$1', [r.id])).rows[0].n) >= MAX_FILES) deny(400, 'FINANCE_FILE_LIMIT', 'An invoice can have at most 20 files', '一张发票最多 20 个附件。');
      const fid = randomUUID();
      await tx.query('INSERT INTO fin_files(id,org_id,receivable_id,name,mime,size,data,uploader_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [fid, u.org_id, r.id, v.name, mime, data.length, data, u.id]);
      await note(tx, u, r.id, 'file', v.name);
      return reply.code(201).send({ id: fid });
    });
  });
  app.get<{ Params: { id: string; file: string } }>('/finance/receivables/:id/files/:file', async (req, reply) => {
    const u = actorOf(req), r = await recordOf(db, u, id.parse(req.params.id));
    const f = (await db.query('SELECT name,mime,data FROM fin_files WHERE id=$1 AND receivable_id=$2', [id.parse(req.params.file), r.id])).rows[0];
    if (!f) deny(404, 'FINANCE_NOT_FOUND', 'File not found', '找不到这个附件。');
    const inline = /^(application\/pdf|image\/(png|jpeg|webp))$/.test(f.mime);
    reply.header('content-type', f.mime).header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
    return reply.send(Buffer.from(f.data));
  });
  app.post<{ Params: { id: string; file: string } }>('/finance/receivables/:id/files/:file/delete', async req => {
    const u = actorOf(req); requireManage(u);
    return db.transaction(async tx => {
      const r = await recordOf(tx, u, id.parse(req.params.id), true);
      const f = (await tx.query('DELETE FROM fin_files WHERE id=$1 AND receivable_id=$2 RETURNING name', [id.parse(req.params.file), r.id])).rows[0] || deny(404, 'FINANCE_NOT_FOUND', 'File not found', '找不到这个附件。');
      await note(tx, u, r.id, 'file', `删除附件 ${f.name}`);
      return { ok: true };
    });
  });

  /* 权限: main admins choose who views or manages finance. */
  const execOnly = (u: User) => { if (!o.isAdmin(u)) deny(403, 'FINANCE_ACCESS_ADMIN_ONLY', 'Only main administrators can set finance access', '只有主管理员可以设置财务权限。'); };
  app.get('/finance/access', async req => {
    const u = actorOf(req); execOnly(u);
    const rows = (await db.query('SELECT id,display_name,name_zh,name_en,title,grants,quality_factory FROM users WHERE org_id=$1 AND active=true ORDER BY display_name', [u.org_id])).rows;
    return { people: rows.filter((p: any) => !p.quality_factory).map((p: any) => ({ id: p.id, name: nameOf(p), title: p.title || '', admin: o.isAdmin(p),
      level: o.isAdmin(p) ? 'manage' : grantsOf(p).includes('finance_manage') ? 'manage' : grantsOf(p).includes('finance_view') ? 'view' : 'none' })) };
  });
  const accessInput = z.object({ userId: id, level: z.enum(['none', 'view', 'manage']) }).strict();
  app.post('/finance/access', async req => {
    const u = actorOf(req); execOnly(u); const v = accessInput.parse(req.body);
    return db.transaction(async tx => {
      const p = (await tx.query('SELECT id,grants FROM users WHERE id=$1 AND org_id=$2 AND active=true FOR UPDATE', [v.userId, u.org_id])).rows[0] || deny(404, 'NOT_FOUND', 'Member not found');
      const before = grantsOf(p), next = [...before.filter(g => !(FINANCE_GRANTS as readonly string[]).includes(g)), ...(v.level === 'manage' ? ['finance_view', 'finance_manage'] : v.level === 'view' ? ['finance_view'] : [])];
      await tx.query('UPDATE users SET grants=$2 WHERE id=$1', [p.id, JSON.stringify(next)]);
      await audit(tx, u, 'finance.access_changed', p.id, { to: v.level });
      return { userId: p.id, level: v.level };
    });
  });
}

/** For /me: what the finance menu should show this person ('manage' | 'view' | 'own' | null). */
export async function financeAccessOf(db: Queryable, u: any, admin: boolean) {
  const g: string[] = Array.isArray(u.grants) ? u.grants : [];
  if (admin || g.includes('finance_manage')) return 'manage';
  if (g.includes('finance_view')) return 'view';
  return (await db.query('SELECT 1 FROM fin_receivables WHERE org_id=$1 AND responsible_id=$2 AND archived_at IS NULL LIMIT 1', [u.org_id, u.id])).rows.length ? 'own' : null;
}
