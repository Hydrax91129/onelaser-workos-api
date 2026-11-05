import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from './db.js';
import { deny } from './errors.js';

// Weekly is off sale; its price stays for unpaid orders that were created while it was on sale.
export const CALDOCK_PRICES = Object.freeze({ week:8900, month:16900, quarter:48165, half:91260, year:172380 });
export const CALDOCK_SALE_PRICES = Object.freeze({ month:CALDOCK_PRICES.month, quarter:CALDOCK_PRICES.quarter, half:CALDOCK_PRICES.half, year:CALDOCK_PRICES.year });
// A yearly order of 5 or more gets 2.5% off its first year; renewals return to the yearly price.
const CALDOCK_BULK=Object.freeze({interval:'year',minQuantity:5,offBps:250});
export function caldockOrderAmounts(interval:keyof typeof CALDOCK_PRICES,quantity:number) {
  const unit=CALDOCK_PRICES[interval],subtotal=unit*quantity;
  const bulkOff=interval===CALDOCK_BULK.interval&&quantity>=CALDOCK_BULK.minQuantity?Math.round(subtotal*CALDOCK_BULK.offBps/10000):0;
  return {unit,subtotal,bulkOff,total:subtotal-bulkOff};
}
// Stock totals live in caldock_settings. Orders paid from countFrom on are added to the rented count.
// A rental frees its Mac once its paid period has ended; the grace leaves room for a late renewal charge.
export const CALDOCK_STOCK = Object.freeze({ countFrom:'2026-11-04T00:00:00Z', graceDays:3 });
export async function caldockStockStatus(db:Queryable) {
  const row=(await db.query("SELECT COALESCE(sum(quantity),0)::int AS rented FROM caldock_orders WHERE status IN ('paid','provisioning','active') AND paid_at>=$1::timestamptz AND (billing_ends_at IS NULL OR billing_ends_at+make_interval(days=>$2::int)>now())",[CALDOCK_STOCK.countFrom,CALDOCK_STOCK.graceDays])).rows[0];
  const {stock_total:total,stock_rented_before:before}=(await db.query('SELECT stock_total,stock_rented_before FROM caldock_settings WHERE id=1')).rows[0];
  const rented=Math.min(total,before+Number(row.rented));
  return {total,rented,left:total-rented};
}
export async function caldockAudit(tx:Queryable,actorId:string|null,action:string,objectId:string,details:unknown={}) {
  await tx.query('INSERT INTO caldock_audit(id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actorId,action,objectId,JSON.stringify(details)]);
}
export async function createCaldockOrder(db:Database,customerId:string,interval:keyof typeof CALDOCK_SALE_PRICES,quantity:number,requestKey:string) {
  return db.transaction(async tx=>{
    // Customer lock serializes retries and the one-unpaid-order rule.
    await tx.query('SELECT id FROM caldock_users WHERE id=$1 FOR UPDATE',[customerId]);
    const existing=(await tx.query('SELECT * FROM caldock_orders WHERE customer_id=$1 AND request_key=$2',[customerId,requestKey])).rows[0];
    if(existing) {if(existing.interval!==interval||existing.quantity!==quantity)deny(409,'IDEMPOTENCY_CONFLICT','This request was already used for another plan');return existing;}
    const active=(await tx.query("SELECT id FROM caldock_orders WHERE customer_id=$1 AND status='pending_payment' LIMIT 1",[customerId])).rows[0];
    if(active)deny(409,'ACTIVE_ORDER_EXISTS','An open order already exists');
    const settings=(await tx.query('SELECT * FROM caldock_settings WHERE id=1')).rows[0];
    const referral=(await tx.query('SELECT r.affiliate_id FROM caldock_referrals r JOIN caldock_affiliates a ON a.user_id=r.affiliate_id WHERE r.customer_id=$1 AND a.active=true AND r.affiliate_id<>$1',[customerId])).rows[0];
    const amounts=caldockOrderAmounts(interval,quantity);
    const row=(await tx.query('INSERT INTO caldock_orders(id,customer_id,request_key,interval,amount_cents,affiliate_id,commission_bps,commission_mode,first_order_only,quantity,list_amount_cents,billed_from_payment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,true) RETURNING *',[randomUUID(),customerId,requestKey,interval,amounts.total,referral?.affiliate_id||null,settings[interval+'_commission_bps'],settings.commission_mode,quantity,amounts.subtotal])).rows[0];
    await caldockAudit(tx,customerId,'order.created',row.id,{interval,quantity,amountCents:row.amount_cents});return row;
  });
}

// Orders with first_order_only never earn on renewals. Older orders keep their terms: renewals earn for a year, on both tiers.
export const CALDOCK_COMMISSION_MONTHS=12;
// Second-tier commission for one collected payment; sourceId keeps each payment to one record.
async function recordSecondTierCommission(db:Queryable,order:any,paidCents:number,sourceId:string) {
  const cents=Math.floor(paidCents*order.second_tier_bps/10000);
  if(order.second_affiliate_id&&cents>0)await db.query('INSERT INTO caldock_commissions(id,order_id,affiliate_id,amount_cents,rate_bps,source_id,tier) VALUES($1,$2,$3,$4,$5,$6,2) ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING',[randomUUID(),order.id,order.second_affiliate_id,cents,order.second_tier_bps,sourceId]);
}
export async function recordCaldockRenewalCommission(db:Queryable,order:any,invoiceId:string,amountPaidCents:number) {
  if(order.first_order_only||!Number.isInteger(amountPaidCents)||amountPaidCents<=0)return;
  // Renewals earn for the first year after the first payment; from the second year on neither tier does.
  const window=new Date(order.paid_at);window.setUTCMonth(window.getUTCMonth()+CALDOCK_COMMISSION_MONTHS);
  if(!order.paid_at||Date.now()>=window.getTime())return;
  const earned=(await db.query("SELECT 1 FROM caldock_commissions WHERE order_id=$1 AND status<>'void' LIMIT 1",[order.id])).rows.length>0;
  if(!earned)return;
  const cents=Math.floor(amountPaidCents*order.commission_bps/10000);
  if(cents>0)await db.query('INSERT INTO caldock_commissions(id,order_id,affiliate_id,amount_cents,rate_bps,source_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING',[randomUUID(),order.id,order.affiliate_id,cents,order.commission_bps,'stripe_in:'+invoiceId]);
  await recordSecondTierCommission(db,order,amountPaidCents,'stripe_in:'+invoiceId+':t2');
}

// Trusted adapter entry point ONLY. Deliberately not registered as a public HTTP route.
// A future payment adapter must validate its provider signature before calling this.
export async function recordVerifiedCaldockPayment(db:Database,input:{eventId:string;orderId:string;type:'paid'|'refunded';amountCents:number;currency:string}) {
  if(!/^[A-Za-z0-9_.:-]{1,200}$/.test(input.eventId)||!['paid','refunded'].includes(input.type))deny(400,'INVALID_PAYMENT_EVENT','Invalid payment event');
  return db.transaction(async tx=>{
    const order=(await tx.query('SELECT * FROM caldock_orders WHERE id=$1 FOR UPDATE',[input.orderId])).rows[0];
    if(!order)deny(404,'NOT_FOUND','Order not found');
    if(input.amountCents!==order.amount_cents||input.currency!=='USD')deny(400,'PAYMENT_AMOUNT_MISMATCH','Payment amount does not match the order');
    const existing=(await tx.query('SELECT * FROM caldock_payment_events WHERE event_id=$1',[input.eventId])).rows[0];
    if(existing){if(existing.order_id!==order.id||existing.event_type!==input.type)deny(409,'PAYMENT_EVENT_CONFLICT','Payment event was already used');return {duplicate:true};}
    if(input.type==='paid'&&order.status!=='pending_payment')deny(409,'INVALID_PAYMENT_STATE','The order cannot accept this payment');
    if(input.type==='refunded'&&!['paid','provisioning','active'].includes(order.status))deny(409,'INVALID_PAYMENT_STATE','The order cannot accept this refund');
    const inserted=await tx.query('INSERT INTO caldock_payment_events(event_id,order_id,event_type,amount_cents) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id',[input.eventId,order.id,input.type,input.amountCents]);
    if(!inserted.rows.length){const prior=(await tx.query('SELECT * FROM caldock_payment_events WHERE event_id=$1',[input.eventId])).rows[0];if(prior?.order_id!==order.id||prior?.event_type!==input.type)deny(409,'PAYMENT_EVENT_CONFLICT','Payment event was already used');return {duplicate:true};}
    if(input.type==='paid'){
      // Serialize paid orders for one buyer before checking first-order commission.
      await tx.query('SELECT id FROM caldock_users WHERE id=$1 FOR UPDATE',[order.customer_id]);
      await tx.query("UPDATE caldock_orders SET status='paid',paid_at=now(),version=version+1 WHERE id=$1",[order.id]);
      const previous=(await tx.query('SELECT id FROM caldock_orders WHERE customer_id=$1 AND paid_at IS NOT NULL AND id<>$2 LIMIT 1',[order.customer_id,order.id])).rows.length>0;
      if(order.affiliate_id&&order.affiliate_id!==order.customer_id&&order.commission_bps>0&&(order.commission_mode==='each_order'||!previous)){
        const cents=Math.floor(order.amount_cents*order.commission_bps/10000);
        if(cents>0)await tx.query('INSERT INTO caldock_commissions(id,order_id,affiliate_id,amount_cents,rate_bps) VALUES($1,$2,$3,$4,$5)',[randomUUID(),order.id,order.affiliate_id,cents,order.commission_bps]);
        await recordSecondTierCommission(tx,order,order.amount_cents,'order:'+order.id+':t2');
      }
    } else {
      await tx.query("UPDATE caldock_orders SET status='refunded',renewal_enabled=false,version=version+1 WHERE id=$1",[order.id]);
      // Retain settled_at/reference to surface a refunded settled commission for recovery.
      await tx.query("UPDATE caldock_commissions SET status='void' WHERE order_id=$1",[order.id]);
    }
    await caldockAudit(tx,null,'payment.'+input.type,order.id,{eventId:input.eventId});return {duplicate:false};
  });
}
