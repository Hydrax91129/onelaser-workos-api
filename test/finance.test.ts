import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, schema, seedDemo } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { issueSession } from '../src/auth.js';
import { arState, normalizePhone, normalizeZip } from '../src/finance.js';

// Fictional customers and amounts only.
async function setup() {
  const db = await createDatabase(); await db.exec(schema); await seedDemo(db);
  const clock = () => new Date('2026-11-10T18:00:00Z').getTime();
  const app = await buildApp({ db, integrations: { executiveUserIds: ['m1'] }, completionModel: null, translationModel: null, mailer: null, nudgeIntervalMs: 0, clock });
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: any, lang = 'en') => { tokens[who] ??= (await issueSession(db, who)).accessToken; return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + tokens[who], 'accept-language': lang } }); };
  return { db, app, call };
}
// A complete fictional contact and US shipping address; tests override what they check.
const who = { contact: '示例联系人', contactEmail: 'buyer@example.com', contactPhone: '(626) 555-0142', shipStreet: '100 Example Ave', shipCity: 'Pasadena', shipState: 'CA', shipZip: '91101' };
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

test('receivable status, outstanding and paid % follow the payments; overdue after the due date', () => {
  assert.deepEqual(arState(1000, [], '2026-11-01', '2026-11-10'), { received: 0, deposited: 0, outstanding: 1000, paidPct: 0, status: 'unpaid', overdue: true, daysOverdue: 9 });
  assert.equal(arState(1000, [{ amount: 400, state: 'cleared' }], '2026-12-01', '2026-11-10').status, 'partial');
  const dep = arState(1000, [{ amount: 400, state: 'cleared' }, { amount: 600, state: 'deposited' }], '2026-11-01', '2026-11-10');
  assert.equal(dep.status, 'deposit'); assert.equal(dep.outstanding, 600, 'a deposited check is not received until it clears'); assert.equal(dep.paidPct, 40);
  assert.equal(arState(1000, [{ amount: 1000, state: 'cleared' }], '2026-11-01', '2026-11-10').overdue, false, 'paid is never overdue');
});

test('finance: only granted people, main admins and the responsible person see receivables; main admins set access', async () => {
  const { app, call } = await setup();
  try {
    assert.equal((await call('m2', 'GET', '/finance/receivables')).statusCode, 403, 'no access by default');
    assert.equal((await call('m1', 'GET', '/me')).json().financeAccess, 'manage', 'main admins manage');
    assert.equal((await call('m2', 'GET', '/me')).json().financeAccess, null);
    assert.equal((await call('m4', 'GET', '/finance/access')).statusCode, 403, 'a manager cannot set finance access');
    assert.equal((await call('m4', 'POST', '/finance/access', { userId: 'm4', level: 'manage' })).statusCode, 403, 'nobody gives themselves access');
    // Main admin creates two invoices: one for m2 (responsible), one for m5
    const mk = async (body: any) => { const r = await call('m1', 'POST', '/finance/receivables', body); assert.equal(r.statusCode, 201, r.body); return r.json(); };
    const a = await mk({ ...who, responsibleId: 'm2', invoiceDate: '2026-10-01', paymentTerm: 'net30', termDays: 30, customer: '示例客户 A', contact: '示例联系人', kind: 'PO', orderRef: '9001', amount: 5000, dispatched: true, dispatchedOn: '2026-10-02', payMethod: 'check' });
    const b = await mk({ ...who, responsibleId: 'm5', invoiceDate: '2026-11-05', paymentTerm: 'net30', termDays: 30, customer: '示例客户 B', amount: 1200, kind: 'KOL' });
    assert.equal(a.number, 'AR-2026-0001'); assert.equal(b.number, 'AR-2026-0002');
    assert.equal((await call('m2', 'POST', '/finance/receivables', { ...who, invoiceDate: '2026-11-01', customer: 'x', amount: 1 })).statusCode, 403, 'the responsible person cannot create invoices');
    // The responsible person sees only their own and records its payments and follow-ups (SOP 5)
    assert.equal((await call('m2', 'GET', '/me')).json().financeAccess, 'own');
    const own = (await call('m2', 'GET', '/finance/receivables')).json();
    assert.equal(own.level, 'own'); assert.deepEqual(own.items.map((i: any) => i.number), ['AR-2026-0001']);
    assert.equal((await call('m2', 'GET', `/finance/receivables/${b.id}`)).statusCode, 404, 'other people\'s invoices are invisible');
    assert.equal((await call('m2', 'PATCH', `/finance/receivables/${a.id}`, { amount: 1 })).statusCode, 403, 'only managers edit the invoice');
    assert.equal((await call('m2', 'POST', `/finance/receivables/${a.id}/payments`, { receivedOn: '2026-11-03', amount: 2000, method: 'check', state: 'deposited', reference: '示例支票 101' })).statusCode, 201);
    assert.equal((await call('m2', 'POST', `/finance/receivables/${a.id}/notes`, { body: '客户说下周补齐（示例）' })).statusCode, 201);
    assert.equal((await call('m2', 'POST', `/finance/receivables/${b.id}/payments`, { receivedOn: '2026-11-03', amount: 1 })).statusCode, 404);
    // Give m3 view access: sees everything, changes nothing
    assert.equal((await call('m1', 'POST', '/finance/access', { userId: 'm3', level: 'view' })).json().level, 'view');
    const v = (await call('m3', 'GET', '/finance/receivables')).json(); assert.equal(v.level, 'view'); assert.equal(v.items.length, 2);
    assert.equal((await call('m3', 'POST', `/finance/receivables/${a.id}/payments`, { receivedOn: '2026-11-03', amount: 1 })).statusCode, 403);
    const access = (await call('m1', 'GET', '/finance/access')).json().people;
    assert.equal(access.find((p: any) => p.id === 'm3').level, 'view'); assert.equal(access.find((p: any) => p.id === 'm1').level, 'manage');
    await call('m1', 'POST', '/finance/access', { userId: 'm3', level: 'none' });
    assert.equal((await call('m3', 'GET', '/finance/receivables')).statusCode, 403, 'access taken away');
  } finally { await app.close(); }
});

test('finance: due date from the term, payments, summary (outstanding, %, overdue, shipped but unpaid, aging), files, archive', async () => {
  const { app, call } = await setup();
  try {
    const r = (await call('m1', 'POST', '/finance/receivables', { ...who, responsibleId: 'm2', invoiceDate: '2026-09-01', paymentTerm: 'net30', termDays: 30, customer: '示例客户 C', amount: 10000, dispatched: true, payMethod: 'ach' })).json();
    const d = (await call('m1', 'GET', `/finance/receivables/${r.id}`)).json();
    assert.equal(d.dueDate, '2026-10-01', 'invoice date + 30 days'); assert.equal(d.status, 'unpaid'); assert.equal(d.overdue, true); assert.equal(d.daysOverdue, 40);
    // Changing the term moves the due date
    await call('m1', 'PATCH', `/finance/receivables/${r.id}`, { termDays: 60, paymentTerm: 'net60' });
    assert.equal((await call('m1', 'GET', `/finance/receivables/${r.id}`)).json().dueDate, '2026-10-31');
    await call('m1', 'POST', `/finance/receivables/${r.id}/payments`, { receivedOn: '2026-10-15', amount: 4000, method: 'ach' });
    const dep = (await call('m1', 'POST', `/finance/receivables/${r.id}/payments`, { receivedOn: '2026-11-05', amount: 6000, method: 'check', state: 'deposited' })).json();
    let x = (await call('m1', 'GET', `/finance/receivables/${r.id}`)).json();
    assert.equal(x.status, 'deposit'); assert.equal(x.received, 4000); assert.equal(x.outstanding, 6000); assert.equal(x.paidPct, 40);
    // Not paid yet, not dispatched, due later
    await call('m1', 'POST', '/finance/receivables', { ...who, invoiceDate: '2026-11-08', termDays: 30, customer: '示例客户 D', amount: 500 });
    const s = (await call('m1', 'GET', '/finance/receivables')).json().summary;
    assert.equal(s.total, 10500); assert.equal(s.received, 4000); assert.equal(s.outstanding, 6500); assert.equal(s.paidPct, 38.1);
    assert.equal(s.overdue, 6000); assert.equal(s.overdueCount, 1); assert.equal(s.shippedUnpaid, 6000); assert.equal(s.shippedUnpaidCount, 1);
    assert.equal(s.aging.d1_30, 6000); assert.equal(s.aging.current, 500);
    // The check clears: paid in full
    await call('m1', 'POST', `/finance/receivables/${r.id}/payments/${dep.id}`, { state: 'cleared' });
    x = (await call('m1', 'GET', `/finance/receivables/${r.id}`)).json();
    assert.equal(x.status, 'paid'); assert.equal(x.paidPct, 100); assert.equal(x.overdue, false);
    assert.ok(x.notes.some((n: any) => /支票已到账/.test(n.body)), 'follow-up log records it');
    // Invoice files: PDF/images/Office; others refused; download for viewers; responsible may add
    assert.equal((await call('m1', 'POST', `/finance/receivables/${r.id}/files`, { name: 'x.exe', mime: 'application/x-msdownload', dataBase64: png })).statusCode, 400);
    const f = await call('m2', 'POST', `/finance/receivables/${r.id}/files`, { name: '示例发票.png', mime: 'image/png', dataBase64: png });
    assert.equal(f.statusCode, 201, f.body);
    const got = await call('m1', 'GET', `/finance/receivables/${r.id}/files/${f.json().id}`);
    assert.equal(got.headers['content-type'], 'image/png'); assert.match(String(got.headers['content-disposition']), /^inline/);
    assert.equal((await call('m2', 'POST', `/finance/receivables/${r.id}/files/${f.json().id}/delete`, {})).statusCode, 403, 'only managers delete files');
    assert.equal((await call('m1', 'POST', '/finance/receivables', { ...who, invoiceDate: '0001-01-01', customer: 'x', amount: 1 })).statusCode, 400, 'dates are checked');
    // Archive hides it
    await call('m1', 'POST', `/finance/receivables/${r.id}/archive`, {});
    assert.ok(!(await call('m1', 'GET', '/finance/receivables')).json().items.some((i: any) => i.id === r.id));
    assert.equal((await call('m1', 'GET', `/finance/receivables/${r.id}`)).statusCode, 404);
  } finally { await app.close(); }
});

test('phone and ZIP formats: US numbers stored as +1XXXXXXXXXX, ZIP 5 or 5+4', () => {
  for (const raw of ['(626) 555-0142', '626-555-0142', '626.555.0142', '6265550142', '1 626 555 0142', '+1 (626) 555-0142']) assert.equal(normalizePhone(raw), '+16265550142', raw);
  assert.equal(normalizePhone('+86 138 0000 0000'), '+8613800000000', 'other countries keep + and the country code');
  for (const bad of ['', '555-0142', '62655501420', '(026) 555-0142', '626-155-0142', '626 555 01ab', '+1 626 555 014', '22 2+3']) assert.equal(normalizePhone(bad), null, bad);
  assert.equal(normalizeZip('91101'), '91101'); assert.equal(normalizeZip('91101-1234'), '91101-1234'); assert.equal(normalizeZip('911011234'), '91101-1234');
  for (const bad of ['9110', '91101-12', 'ABCDE', '91101 1234']) assert.equal(normalizeZip(bad), null, bad);
});

test('new receivable: company optional; contact name, email, phone and shipping address required, with clear errors', async () => {
  const { app, call } = await setup();
  try {
    const base = { invoiceDate: '2026-11-05', termDays: 30, amount: 800 };
    const post = (body: any) => call('m1', 'POST', '/finance/receivables', { ...base, ...body });
    const errOf = async (body: any, code: string, zh: RegExp) => {
      const r = await post(body); assert.equal(r.statusCode, 400, `${code}: ${r.body}`);
      assert.equal(r.json().error.code, code);
      const cn = await call('m1', 'POST', '/finance/receivables', { ...base, ...body }, 'zh-CN');
      assert.match(cn.json().error.message, zh, 'the message is in Chinese');
    };
    await errOf({ ...who, contact: '  ' }, 'FINANCE_CONTACT', /联系人姓名/);
    await errOf({ ...who, contactEmail: '' }, 'FINANCE_EMAIL', /邮箱/);
    await errOf({ ...who, contactEmail: 'buyer@example' }, 'FINANCE_EMAIL', /邮箱/);
    await errOf({ ...who, contactPhone: '' }, 'FINANCE_PHONE', /联系电话/);
    await errOf({ ...who, contactPhone: '555-0142' }, 'FINANCE_PHONE', /10 位/);
    await errOf({ ...who, shipStreet: '' }, 'FINANCE_ADDRESS', /收货地址/);
    await errOf({ ...who, shipCity: '' }, 'FINANCE_ADDRESS', /收货地址/);
    await errOf({ ...who, shipZip: '' }, 'FINANCE_ADDRESS', /收货地址/);
    await errOf({ ...who, shipState: 'California' }, 'FINANCE_STATE', /两位字母/);
    await errOf({ ...who, shipState: 'ZZ' }, 'FINANCE_STATE', /两位字母/);
    await errOf({ ...who, shipZip: '9110' }, 'FINANCE_ZIP', /邮编/);
    await errOf({ ...who, shipCountry: 'USA' }, 'FINANCE_COUNTRY', /国家/);
    // No company: saved, stored in one form (phone +1…, state upper case, ZIP+4 with a dash, country US by default)
    const ok = await post({ ...who, contactPhone: '626.555.0142', shipState: 'ca', shipZip: '911011234', shipLine2: 'Suite 5' });
    assert.equal(ok.statusCode, 201, ok.body);
    const d = (await call('m1', 'GET', `/finance/receivables/${ok.json().id}`)).json();
    assert.equal(d.customer, ''); assert.equal(d.contact, '示例联系人'); assert.equal(d.contactEmail, 'buyer@example.com'); assert.equal(d.contactPhone, '+16265550142');
    assert.deepEqual([d.shipStreet, d.shipLine2, d.shipCity, d.shipState, d.shipZip, d.shipCountry], ['100 Example Ave', 'Suite 5', 'Pasadena', 'CA', '91101-1234', 'US']);
    // Outside the US: state and postcode are free text and optional; the phone needs + and the country code
    const intl = await post({ ...who, contactPhone: '+44 20 7946 0000', shipCountry: 'gb', shipState: '', shipZip: 'SW1A 1AA', shipCity: 'London' });
    assert.equal(intl.statusCode, 201, intl.body);
    assert.equal((await call('m1', 'GET', `/finance/receivables/${intl.json().id}`)).json().shipCountry, 'GB');
    // Editing checks the saved set: a required field cannot be cleared, formats are kept
    const rid = ok.json().id;
    assert.equal((await call('m1', 'PATCH', `/finance/receivables/${rid}`, { contactPhone: '' })).json().error.code, 'FINANCE_PHONE');
    assert.equal((await call('m1', 'PATCH', `/finance/receivables/${rid}`, { shipZip: '123' })).json().error.code, 'FINANCE_ZIP');
    assert.equal((await call('m1', 'PATCH', `/finance/receivables/${rid}`, { contactPhone: '(213) 555-0199', customer: '示例公司' })).statusCode, 200);
    const e = (await call('m1', 'GET', `/finance/receivables/${rid}`)).json();
    assert.equal(e.contactPhone, '+12135550199'); assert.equal(e.customer, '示例公司'); assert.equal(e.shipZip, '91101-1234');
    assert.equal((await call('m1', 'PATCH', `/finance/receivables/${rid}`, { amount: 900 })).statusCode, 200, 'other fields still edit on their own');
  } finally { await app.close(); }
});
