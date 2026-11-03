/* Dealer orders, staff side: review dealer applications, see orders, ship and record tracking.
 *
 * Access comes from ERP grants (set on the ERP permissions page, area "dealers"):
 *   dealers          view dealer accounts and orders
 *   dealers_manage   approve/reject/suspend dealers, ship and cancel orders
 * Company admins can do everything; only they may let a dealer's orders ship before ACH clears.
 *
 * Shipping takes stock out of a WMS location (US warehouse by default) as a goods-out movement whose
 * reference is the order number, in the same transaction that marks the order shipped. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './db.js';
import type { User } from './auth.js';
import { deny } from './errors.js';
import { LOCATIONS } from './wms.js';
import { accountOut, CARRIERS, money, ORDER_STATUSES, orderLines, orderOut, sendMail, setStatus, profileComplete, type DealerOptions } from './dealer.js';

const uuid = z.string().uuid();
const LOC_IDS = LOCATIONS.map(l => l.id) as [string, ...string[]];
const TRACKING: Record<string, (n: string) => string> = {
  ups: n => 'https://www.ups.com/track?tracknum=' + encodeURIComponent(n),
  fedex: n => 'https://www.fedex.com/fedextrack/?trknbr=' + encodeURIComponent(n),
  usps: n => 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(n),
  dhl: n => 'https://www.dhl.com/us-en/home/tracking.html?tracking-id=' + encodeURIComponent(n),
};
const httpsUrl = z.string().trim().max(2000).url().refine(v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; } }, 'Use an https link');
const nameOf = (u: any) => u ? (u.display_name || u.name_zh || u.name_en || u.id) : '';

export async function registerDealerAdminRoutes(app: FastifyInstance, db: Database, o: DealerOptions & { isAdmin: (u: User) => boolean }) {
  const orgId = o.orgId;
  const actorOf = (req: FastifyRequest): User => req.actor || deny(401, 'UNAUTHENTICATED', 'Authentication is required');
  const grants = (u: User): string[] => Array.isArray((u as any).grants) ? (u as any).grants : [];
  const canView = (u: User) => o.isAdmin(u) || grants(u).includes('dealers');
  const canManage = (u: User) => o.isAdmin(u) || grants(u).includes('dealers_manage');
  const viewer = (req: FastifyRequest) => {
    const u = actorOf(req);
    if (!canView(u)) deny(403, 'DEALER_ADMIN_FORBIDDEN', 'You do not have access to dealer orders', '你没有经销商订单的访问权限');
    if (!orgId) deny(503, 'DEALER_PORTAL_DISABLED', 'The dealer portal is not configured', '经销商门户尚未配置（DEALER_ORG_ID）');
    // The portal serves one company; staff of any other org see nothing.
    if (u.org_id !== orgId) deny(403, 'DEALER_ADMIN_FORBIDDEN', 'You do not have access to dealer orders', '你没有经销商订单的访问权限');
    return u;
  };
  const manager = (req: FastifyRequest) => {
    const u = viewer(req);
    if (!canManage(u)) deny(403, 'DEALER_MANAGE_ONLY', 'Only dealer managers can do this', '只有经销商管理权限的同事可以操作');
    return u;
  };
  const audit = (tx: Queryable, u: User, action: string, objectId: string, details: unknown) =>
    tx.query('INSERT INTO audit_events(id,org_id,department_id,owner_id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [randomUUID(), u.org_id, u.department_id, u.id, u.id, action, objectId, JSON.stringify(details)]);
  const staffAccount = (a: any) => ({ ...accountOut(a), shipBeforeClear: a.ship_before_clear, staffNote: a.staff_note, decisionNote: a.decision_note, decidedAt: a.decided_at, version: a.version, hasStripeCustomer: !!a.stripe_customer_id });
  const people = async (ids: string[]) => new Map((await db.query('SELECT id,display_name,name_zh,name_en FROM users WHERE id=ANY($1::text[])', [ids.filter(Boolean)])).rows.map((p: any) => [p.id, p]));
  /* Paid orders ship. An order whose ACH is still clearing ships only for a dealer an admin has marked as trusted. */
  const shippable = (order: any, dealer: any) => order.status === 'paid' || (order.status === 'processing' && dealer?.ship_before_clear === true);

  app.get('/dealer-admin/summary', async req => {
    const u = viewer(req);
    const r = (await db.query(`SELECT
        (SELECT count(*)::int FROM dealer_accounts WHERE org_id=$1 AND status='pending') AS pending_accounts,
        (SELECT count(*)::int FROM dealer_orders o JOIN dealer_accounts a ON a.id=o.dealer_id WHERE o.org_id=$1 AND (o.status='paid' OR (o.status='processing' AND a.ship_before_clear))) AS to_ship,
        (SELECT count(*)::int FROM dealer_orders WHERE org_id=$1 AND status='processing') AS processing,
        (SELECT count(*)::int FROM dealer_orders WHERE org_id=$1 AND status='disputed') AS disputed`, [orgId])).rows[0];
    return { pendingAccounts: r.pending_accounts, toShip: r.to_ship, processing: r.processing, disputed: r.disputed, canManage: canManage(u), canTrust: o.isAdmin(u), payments: !!o.stripe, paymentMode: o.stripe?.mode ?? null, locations: LOCATIONS, carriers: CARRIERS };
  });

  /* ---------- dealer accounts ---------- */
  app.get('/dealer-admin/accounts', async req => {
    viewer(req);
    const q = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional() }).strict().parse(req.query);
    const rows = (await db.query(`SELECT a.*,(SELECT count(*)::int FROM dealer_orders o WHERE o.dealer_id=a.id) AS orders,
        (SELECT COALESCE(sum(total_cents),0)::bigint FROM dealer_orders o WHERE o.dealer_id=a.id AND o.status IN ('paid','shipped')) AS paid_cents
      FROM dealer_accounts a WHERE a.org_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY (a.status='pending') DESC, a.created_at DESC LIMIT 500`, [orgId, q.status || null])).rows;
    return { items: rows.map((a: any) => ({ ...staffAccount(a), orders: a.orders, paidCents: Number(a.paid_cents) })) };
  });
  const decisionInput = z.object({ action: z.enum(['approve', 'reject', 'suspend', 'reactivate']), note: z.string().trim().max(1000).default(''), expectedVersion: z.number().int().positive() }).strict();
  const NEXT: Record<string, Record<string, string>> = {
    pending: { approve: 'approved', reject: 'rejected' }, approved: { suspend: 'suspended' },
    suspended: { reactivate: 'approved' }, rejected: { reactivate: 'approved' },
  };
  app.post<{ Params: { id: string } }>('/dealer-admin/accounts/:id/decision', async req => {
    const u = manager(req), v = decisionInput.parse(req.body);
    const result = await db.transaction(async tx => {
      const a = (await tx.query('SELECT * FROM dealer_accounts WHERE id=$1 AND org_id=$2 FOR UPDATE', [uuid.parse(req.params.id), orgId])).rows[0];
      if (!a) deny(404, 'NOT_FOUND', 'Dealer not found', '找不到这个经销商');
      if (a.version !== v.expectedVersion) deny(409, 'VERSION_CONFLICT', 'This dealer changed; reload before continuing', '经销商资料已变化，请刷新后再操作');
      const next = NEXT[a.status]?.[v.action];
      if (!next) deny(409, 'DEALER_INVALID_DECISION', 'This action does not apply to the dealer’s current status', '这个操作不适用于经销商当前的状态');
      if (next === 'approved' && !profileComplete(a)) deny(409, 'DEALER_PROFILE_INCOMPLETE', 'The dealer has not completed their company details yet', '经销商还没有填完公司资料，不能批准');
      if ((v.action === 'reject' || v.action === 'suspend') && !v.note) deny(400, 'DEALER_NOTE_REQUIRED', 'Give a reason', '请填写原因');
      const row = (await tx.query('UPDATE dealer_accounts SET status=$2,decision_note=$3,decided_by=$4,decided_at=now(),version=version+1 WHERE id=$1 RETURNING *', [a.id, next, v.note, u.id])).rows[0];
      // A suspended dealer is signed out everywhere.
      if (next === 'suspended') await tx.query('DELETE FROM dealer_sessions WHERE dealer_id=$1', [a.id]);
      await audit(tx, u, 'dealer.' + v.action, a.id, { from: a.status, to: next, company: a.company });
      return row;
    });
    const name = result.contact_name || result.company;
    if (v.action === 'approve' || v.action === 'reactivate')
      await sendMail(o.mailer, result.email, 'Your OneLaser dealer account is approved', [`Hi ${name},`, 'Your dealer account has been approved. Sign in to the OneLaser dealer portal to see dealer pricing and place orders.']);
    if (v.action === 'reject')
      await sendMail(o.mailer, result.email, 'Your OneLaser dealer application', [`Hi ${name},`, 'Thank you for applying. We are not able to approve a dealer account at this time.', v.note]);
    return staffAccount(result);
  });
  const accountPatch = z.object({ shipBeforeClear: z.boolean().optional(), staffNote: z.string().trim().max(2000).optional(), expectedVersion: z.number().int().positive() }).strict();
  app.patch<{ Params: { id: string } }>('/dealer-admin/accounts/:id', async req => {
    const u = manager(req), v = accountPatch.parse(req.body);
    // Shipping before ACH clears risks goods leaving against money that can still be returned: admins only.
    if (v.shipBeforeClear !== undefined && !o.isAdmin(u)) deny(403, 'DEALER_TRUST_ADMIN_ONLY', 'Only company admins can let a dealer ship before payment clears', '只有公司管理员可以允许经销商款未到账先发货');
    return db.transaction(async tx => {
      const a = (await tx.query('SELECT * FROM dealer_accounts WHERE id=$1 AND org_id=$2 FOR UPDATE', [uuid.parse(req.params.id), orgId])).rows[0];
      if (!a) deny(404, 'NOT_FOUND', 'Dealer not found', '找不到这个经销商');
      if (a.version !== v.expectedVersion) deny(409, 'VERSION_CONFLICT', 'This dealer changed; reload before continuing', '经销商资料已变化，请刷新后再操作');
      const row = (await tx.query('UPDATE dealer_accounts SET ship_before_clear=COALESCE($2,ship_before_clear),staff_note=COALESCE($3,staff_note),version=version+1 WHERE id=$1 RETURNING *', [a.id, v.shipBeforeClear ?? null, v.staffNote ?? null])).rows[0];
      if (v.shipBeforeClear !== undefined && v.shipBeforeClear !== a.ship_before_clear) await audit(tx, u, 'dealer.ship_before_clear', a.id, { to: v.shipBeforeClear, company: a.company });
      return staffAccount(row);
    });
  });

  /* ---------- orders ---------- */
  app.get('/dealer-admin/orders', async req => {
    viewer(req);
    const q = z.object({ status: z.enum([...ORDER_STATUSES, 'to_ship']).optional(), q: z.string().trim().max(100).default('') }).strict().parse(req.query);
    const rows = (await db.query(`SELECT o.*,a.company,a.email,a.ship_before_clear FROM dealer_orders o JOIN dealer_accounts a ON a.id=o.dealer_id
      WHERE o.org_id=$1
        AND ($2::text IS NULL OR o.status=$2 OR ($2='to_ship' AND (o.status='paid' OR (o.status='processing' AND a.ship_before_clear))))
        AND ($3='' OR o.number ILIKE $4 OR a.company ILIKE $4 OR a.email ILIKE $4 OR o.po_number ILIKE $4 OR o.tracking_number ILIKE $4)
      ORDER BY o.created_at DESC LIMIT 500`, [orgId, q.status || null, q.q, '%' + q.q.replace(/[%_\\]/g, m => '\\' + m) + '%'])).rows;
    const lines = await orderLines(db, rows.map((r: any) => r.id));
    return { items: rows.map((r: any) => ({ ...orderOut(r, lines.get(r.id)), dealer: { id: r.dealer_id, company: r.company, email: r.email }, canShip: shippable(r, r) })) };
  });
  app.get<{ Params: { id: string } }>('/dealer-admin/orders/:id', async req => {
    viewer(req);
    const row = (await db.query('SELECT * FROM dealer_orders WHERE id=$1 AND org_id=$2', [uuid.parse(req.params.id), orgId])).rows[0];
    if (!row) deny(404, 'NOT_FOUND', 'Order not found', '找不到这个订单');
    const dealer = (await db.query('SELECT * FROM dealer_accounts WHERE id=$1', [row.dealer_id])).rows[0];
    const events = (await db.query('SELECT * FROM dealer_order_events WHERE order_id=$1 ORDER BY created_at,id', [row.id])).rows;
    const who = await people(events.filter((e: any) => e.actor_kind === 'staff').map((e: any) => e.actor_id));
    return {
      ...orderOut(row, (await orderLines(db, [row.id])).get(row.id)), dealer: staffAccount(dealer), canShip: shippable(row, dealer), stockLocation: row.stock_location,
      stripePaymentIntent: row.stripe_payment_intent_id, paymentMode: o.stripe?.mode ?? null,
      events: events.map((e: any) => ({ type: e.type, by: e.actor_kind, byName: e.actor_kind === 'staff' ? nameOf(who.get(e.actor_id)) : e.actor_kind === 'dealer' ? dealer.company : 'Stripe', details: e.details, at: e.created_at })),
    };
  });

  const shipInput = z.object({
    carrier: z.enum(CARRIERS), trackingNumber: z.string().trim().min(3).max(100).regex(/^[A-Za-z0-9 \-]+$/, 'Use letters and digits for the tracking number'),
    trackingUrl: httpsUrl.optional(), deductStock: z.boolean().default(true), location: z.enum(LOC_IDS).default('us'), expectedVersion: z.number().int().positive(),
  }).strict();
  app.post<{ Params: { id: string } }>('/dealer-admin/orders/:id/ship', async req => {
    const u = manager(req), v = shipInput.parse(req.body);
    const trackingUrl = v.trackingUrl || TRACKING[v.carrier]?.(v.trackingNumber.replace(/\s+/g, '')) || null;
    const done = await db.transaction(async tx => {
      const order = (await tx.query('SELECT * FROM dealer_orders WHERE id=$1 AND org_id=$2 FOR UPDATE', [uuid.parse(req.params.id), orgId])).rows[0];
      if (!order) deny(404, 'NOT_FOUND', 'Order not found', '找不到这个订单');
      if (order.version !== v.expectedVersion) deny(409, 'VERSION_CONFLICT', 'This order changed; reload before continuing', '订单已变化，请刷新后再操作');
      const dealer = (await tx.query('SELECT * FROM dealer_accounts WHERE id=$1', [order.dealer_id])).rows[0];
      if (!shippable(order, dealer)) deny(409, 'DEALER_ORDER_NOT_SHIPPABLE',
        order.status === 'processing' ? 'The ACH payment has not cleared yet' : 'This order cannot be shipped in its current status',
        order.status === 'processing' ? 'ACH 款项还没到账，不能发货' : '这个订单当前的状态不能发货');
      const lines = (await orderLines(tx, [order.id])).get(order.id) || [];
      if (v.deductStock) {
        for (const l of lines) {
          const item = (await tx.query('SELECT sku FROM wms_items WHERE org_id=$1 AND lower(sku)=lower($2)', [orgId, l.sku])).rows[0];
          if (!item) deny(409, 'DEALER_SKU_NOT_IN_WMS', `${l.sku} is not in the warehouse system`, `${l.sku} 不在库存系统里，请先在库存管理新增，或选择不扣库存`);
          const have = Number((await tx.query('SELECT qty FROM wms_stock WHERE org_id=$1 AND sku=$2 AND location=$3 FOR UPDATE', [orgId, item.sku, v.location])).rows[0]?.qty ?? 0);
          if (have < l.qty) deny(409, 'WMS_NEGATIVE_STOCK', `Not enough stock of ${l.sku}: ${have} on hand, ${l.qty} needed`, `${l.sku} 库存不足：现有 ${have} 件，需要 ${l.qty} 件`);
          await tx.query('UPDATE wms_stock SET qty=$4 WHERE org_id=$1 AND sku=$2 AND location=$3', [orgId, item.sku, v.location, have - l.qty]);
          await tx.query(`INSERT INTO wms_movements(id,org_id,type,sku,location,qty,reason,reference,status,created_by) VALUES($1,$2,'out',$3,$4,$5,$6,$7,'done',$8)`,
            [randomUUID(), orgId, item.sku, v.location, -l.qty, `Dealer order ${order.number} · ${dealer.company}`.slice(0, 500), order.number, u.id]);
        }
      }
      const row = await setStatus(tx, order, 'shipped', 'staff', u.id, { carrier: v.carrier, trackingNumber: v.trackingNumber, deductStock: v.deductStock, location: v.deductStock ? v.location : null, beforeClear: order.status === 'processing' },
        { carrier: v.carrier, tracking_number: v.trackingNumber, tracking_url: trackingUrl, shipped_at: new Date().toISOString(), shipped_by: u.id, stock_location: v.deductStock ? v.location : null });
      await audit(tx, u, 'dealer.order_shipped', order.id, { number: order.number, carrier: v.carrier, deductStock: v.deductStock, location: v.location, beforeClear: order.status === 'processing' });
      return { row, dealer, lines };
    });
    const carrier = { ups: 'UPS', fedex: 'FedEx', usps: 'USPS', dhl: 'DHL', freight: 'Freight', other: '' }[v.carrier] || '';
    await sendMail(o.mailer, done.dealer.email, `Order ${done.row.number} has shipped`, [
      `Hi ${done.dealer.contact_name || done.dealer.company},`, `Your OneLaser order ${done.row.number} (${money(done.row.total_cents)}) has shipped.`,
      `Carrier: ${carrier || 'see tracking'} · Tracking number: ${v.trackingNumber}`, ...(trackingUrl ? [`Track it: ${trackingUrl}`] : []),
    ]);
    return orderOut(done.row, done.lines);
  });
  const cancelInput = z.object({ reason: z.string().trim().min(1).max(1000), expectedVersion: z.number().int().positive() }).strict();
  app.post<{ Params: { id: string } }>('/dealer-admin/orders/:id/cancel', async req => {
    const u = manager(req), v = cancelInput.parse(req.body);
    return db.transaction(async tx => {
      const order = (await tx.query('SELECT * FROM dealer_orders WHERE id=$1 AND org_id=$2 FOR UPDATE', [uuid.parse(req.params.id), orgId])).rows[0];
      if (!order) deny(404, 'NOT_FOUND', 'Order not found', '找不到这个订单');
      if (order.version !== v.expectedVersion) deny(409, 'VERSION_CONFLICT', 'This order changed; reload before continuing', '订单已变化，请刷新后再操作');
      if (!['pending_payment', 'payment_failed'].includes(order.status)) deny(409, 'DEALER_ORDER_NOT_CANCELLABLE', 'Only unpaid orders can be cancelled; refund a paid order in Stripe', '只有未付款的订单可以取消；已付款的订单请在 Stripe 退款');
      if (o.stripe && order.stripe_checkout_session_id) {
        const session = await o.stripe.request('GET', '/v1/checkout/sessions/' + encodeURIComponent(order.stripe_checkout_session_id)).catch(() => deny(502, 'DEALER_PAYMENT_PROVIDER_ERROR', 'The payment provider could not complete the request; try again', 'Stripe 暂时无法完成请求，请重试'));
        if (session.status === 'complete' && order.status === 'pending_payment') deny(409, 'DEALER_PAYMENT_IN_PROGRESS', 'Payment for this order is being confirmed', '这笔订单的付款正在确认中，稍后刷新再试');
        if (session.status === 'open') await o.stripe.request('POST', '/v1/checkout/sessions/' + encodeURIComponent(order.stripe_checkout_session_id) + '/expire').catch(() => deny(502, 'DEALER_PAYMENT_PROVIDER_ERROR', 'The payment provider could not complete the request; try again', 'Stripe 暂时无法完成请求，请重试'));
      }
      const row = await setStatus(tx, order, 'cancelled', 'staff', u.id, { reason: v.reason });
      await audit(tx, u, 'dealer.order_cancelled', order.id, { number: order.number, reason: v.reason });
      return orderOut(row, (await orderLines(tx, [row.id])).get(row.id));
    });
  });
}
