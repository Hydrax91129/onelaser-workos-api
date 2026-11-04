import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from './db.js';
import { deny } from './errors.js';

export const CALDOCK_PRICES = Object.freeze({ week:6900, month:19900, quarter:53700, half:95400, year:166800 });
// Daily first-period offer. Seats are counted here on the server; the page only displays them.
export const CALDOCK_OFFER = Object.freeze({ percentOff:20, dailySeats:3, utcOffsetHours:8, holdMinutes:32, sessionMinutes:31, couponId:'caldock-first-period-20', excluded:['week'] });
// Launch stock. Seven Macs were rented before online sales; orders paid from countFrom on are added to them.
// A rental frees its Mac once its paid period has ended; the grace leaves room for a late renewal charge.
export const CALDOCK_STOCK = Object.freeze({ total:10, rentedBefore:7, countFrom:'2026-11-04T00:00:00Z', graceDays:3 });
export async function caldockStockStatus(db:Queryable) {
  const row=(await db.query("SELECT count(*)::int AS rented FROM caldock_orders WHERE status IN ('paid','provisioning','active') AND paid_at>=$1::timestamptz AND (billing_ends_at IS NULL OR billing_ends_at+make_interval(days=>$2::int)>now())",[CALDOCK_STOCK.countFrom,CALDOCK_STOCK.graceDays])).rows[0];
  const rented=Math.min(CALDOCK_STOCK.total,CALDOCK_STOCK.rentedBefore+Number(row.rented));
  return {total:CALDOCK_STOCK.total,rented,left:CALDOCK_STOCK.total-rented};
}
const offerDay=(now:number)=>new Date(now+CALDOCK_OFFER.utcOffsetHours*3600000).toISOString().slice(0,10);
const offerResetsAt=(now:number)=>new Date(Date.parse(offerDay(now)+'T00:00:00Z')+(24-CALDOCK_OFFER.utcOffsetHours)*3600000).toISOString();
async function offerSeatsUsed(db:Queryable,day:string,excludeOrderId:string|null) {
  // A paid order keeps its seat; an unpaid one holds it only until its payment page expires.
  const row=(await db.query("SELECT count(*)::int AS used FROM caldock_orders WHERE offer_day=$1 AND id IS DISTINCT FROM $2 AND (status IN ('paid','provisioning','active','refunded') OR (status='pending_payment' AND offer_hold_until>now()))",[day,excludeOrderId])).rows[0];
  return Number(row.used);
}
export async function caldockOfferStatus(db:Queryable,now=Date.now()) {
  const used=await offerSeatsUsed(db,offerDay(now),null);
  return {percentOff:CALDOCK_OFFER.percentOff,seatsTotal:CALDOCK_OFFER.dailySeats,seatsLeft:Math.max(0,CALDOCK_OFFER.dailySeats-used),resetsAt:offerResetsAt(now),excludedIntervals:CALDOCK_OFFER.excluded};
}
// Runs inside the checkout transaction, just before a new payment page is created.
export async function applyCaldockOffer(tx:Queryable,order:any,now=Date.now()) {
  const list=order.list_amount_cents??order.amount_cents,day=offerDay(now);
  let claimed=false;
  if(!CALDOCK_OFFER.excluded.includes(order.interval)){
    await tx.query('INSERT INTO caldock_offer_days(day) VALUES($1) ON CONFLICT DO NOTHING',[day]);
    await tx.query('SELECT day FROM caldock_offer_days WHERE day=$1 FOR UPDATE',[day]);
    claimed=await offerSeatsUsed(tx,day,order.id)<CALDOCK_OFFER.dailySeats;
  }
  const amount=claimed?Math.round(list*(100-CALDOCK_OFFER.percentOff)/100):list;
  return (await tx.query("UPDATE caldock_orders SET list_amount_cents=$2,amount_cents=$3,offer_day=$4,offer_hold_until=CASE WHEN $4::text IS NULL THEN NULL ELSE now()+make_interval(mins=>$5::int) END WHERE id=$1 RETURNING *",[order.id,list,amount,claimed?day:null,CALDOCK_OFFER.holdMinutes])).rows[0];
}
export async function caldockAudit(tx:Queryable,actorId:string|null,action:string,objectId:string,details:unknown={}) {
  await tx.query('INSERT INTO caldock_audit(id,actor_id,action,object_id,details) VALUES($1,$2,$3,$4,$5)',[randomUUID(),actorId,action,objectId,JSON.stringify(details)]);
}
export async function createCaldockOrder(db:Database,customerId:string,interval:'week'|'month'|'quarter'|'half'|'year',requestKey:string) {
  return db.transaction(async tx=>{
    // Customer lock serializes retries and the one-active-rental rule.
    await tx.query('SELECT id FROM caldock_users WHERE id=$1 FOR UPDATE',[customerId]);
    const existing=(await tx.query('SELECT * FROM caldock_orders WHERE customer_id=$1 AND request_key=$2',[customerId,requestKey])).rows[0];
    if(existing) {if(existing.interval!==interval)deny(409,'IDEMPOTENCY_CONFLICT','This request was already used for another plan');return existing;}
    const active=(await tx.query("SELECT id FROM caldock_orders WHERE customer_id=$1 AND status IN ('pending_payment','paid','provisioning','active') LIMIT 1",[customerId])).rows[0];
    if(active)deny(409,'ACTIVE_ORDER_EXISTS','An open order already exists');
    const settings=(await tx.query('SELECT * FROM caldock_settings WHERE id=1')).rows[0];
    const referral=(await tx.query('SELECT r.affiliate_id FROM caldock_referrals r JOIN caldock_affiliates a ON a.user_id=r.affiliate_id WHERE r.customer_id=$1 AND a.active=true AND r.affiliate_id<>$1',[customerId])).rows[0];
    // The referrer's own parent earns the second tier, unless the parent is the buyer.
    const second=referral?(await tx.query('SELECT a.parent_id FROM caldock_affiliates a JOIN caldock_affiliates p ON p.user_id=a.parent_id WHERE a.user_id=$1 AND p.active=true AND a.parent_id<>$2',[referral.affiliate_id,customerId])).rows[0]?.parent_id||null:null;
    const row=(await tx.query('INSERT INTO caldock_orders(id,customer_id,request_key,interval,amount_cents,affiliate_id,commission_bps,commission_mode,second_affiliate_id,second_tier_bps) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[randomUUID(),customerId,requestKey,interval,CALDOCK_PRICES[interval],referral?.affiliate_id||null,settings.commission_bps,settings.commission_mode,second,second?settings.second_tier_bps:0])).rows[0];
    await caldockAudit(tx,customerId,'order.created',row.id,{interval,amountCents:row.amount_cents});return row;
  });
}

// A renewal earns only when the order's first payment earned, at the rate snapshotted on the order.
// Second-tier commission for one collected payment; sourceId keeps each payment to one record.
async function recordSecondTierCommission(db:Queryable,order:any,paidCents:number,sourceId:string) {
  const cents=Math.floor(paidCents*order.second_tier_bps/10000);
  if(order.second_affiliate_id&&cents>0)await db.query('INSERT INTO caldock_commissions(id,order_id,affiliate_id,amount_cents,rate_bps,source_id,tier) VALUES($1,$2,$3,$4,$5,$6,2) ON CONFLICT (source_id) WHERE source_id IS NOT NULL DO NOTHING',[randomUUID(),order.id,order.second_affiliate_id,cents,order.second_tier_bps,sourceId]);
}
export async function recordCaldockRenewalCommission(db:Queryable,order:any,invoiceId:string,amountPaidCents:number) {
  if(!Number.isInteger(amountPaidCents)||amountPaidCents<=0)return;
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
