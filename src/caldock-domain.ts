import { randomUUID } from 'node:crypto';
import type { Database, Queryable } from './db.js';
import { deny } from './errors.js';

export const CALDOCK_PRICES = Object.freeze({ week:6900, month:19900, quarter:53700, half:95400, year:166800 });
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
    const row=(await tx.query('INSERT INTO caldock_orders(id,customer_id,request_key,interval,amount_cents,affiliate_id,commission_bps,commission_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',[randomUUID(),customerId,requestKey,interval,CALDOCK_PRICES[interval],referral?.affiliate_id||null,settings.commission_bps,settings.commission_mode])).rows[0];
    await caldockAudit(tx,customerId,'order.created',row.id,{interval,amountCents:row.amount_cents});return row;
  });
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
      }
    } else {
      await tx.query("UPDATE caldock_orders SET status='refunded',renewal_enabled=false,version=version+1 WHERE id=$1",[order.id]);
      // Retain settled_at/reference to surface a refunded settled commission for recovery.
      await tx.query("UPDATE caldock_commissions SET status='void' WHERE order_id=$1",[order.id]);
    }
    await caldockAudit(tx,null,'payment.'+input.type,order.id,{eventId:input.eventId});return {duplicate:false};
  });
}
