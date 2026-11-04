// Additive namespace: no Work OS identity, session, task or Wiki table is reused.
export const caldockSchema = `
CREATE TABLE IF NOT EXISTS caldock_users (
 id text PRIMARY KEY, display_name text NOT NULL, email text,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS caldock_identities (
 provider text NOT NULL CHECK(provider IN ('google','apple')), subject text NOT NULL,
 user_id text NOT NULL REFERENCES caldock_users(id), PRIMARY KEY(provider,subject)
);
CREATE TABLE IF NOT EXISTS caldock_sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES caldock_users(id),
 csrf_token text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS caldock_session_user ON caldock_sessions(user_id);
CREATE TABLE IF NOT EXISTS caldock_affiliates (
 user_id text PRIMARY KEY REFERENCES caldock_users(id), code text NOT NULL UNIQUE,
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS caldock_referral_visits (
 token_hash text PRIMARY KEY, affiliate_id text NOT NULL REFERENCES caldock_affiliates(user_id),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS caldock_referral_affiliate ON caldock_referral_visits(affiliate_id,created_at);
CREATE TABLE IF NOT EXISTS caldock_referrals (
 customer_id text PRIMARY KEY REFERENCES caldock_users(id),
 affiliate_id text NOT NULL REFERENCES caldock_affiliates(user_id),
 created_at timestamptz NOT NULL DEFAULT now(), CHECK(customer_id<>affiliate_id)
);
CREATE INDEX IF NOT EXISTS caldock_referral_owner ON caldock_referrals(affiliate_id);
CREATE TABLE IF NOT EXISTS caldock_oauth_states (
 state_hash text PRIMARY KEY, browser_hash text NOT NULL, provider text NOT NULL,
 nonce text NOT NULL, verifier text NOT NULL, next_view text NOT NULL, interval text NOT NULL,
 language text NOT NULL, referral_hash text, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS caldock_settings (
 id integer PRIMARY KEY CHECK(id=1), commission_bps integer NOT NULL DEFAULT 0 CHECK(commission_bps BETWEEN 0 AND 10000),
 commission_mode text NOT NULL DEFAULT 'first_order' CHECK(commission_mode IN ('first_order','each_order')),
 version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO caldock_settings(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS caldock_orders (
 id text PRIMARY KEY, customer_id text NOT NULL REFERENCES caldock_users(id), request_key text NOT NULL,
 interval text NOT NULL CHECK(interval IN ('week','month','quarter','year')), amount_cents integer NOT NULL CHECK(amount_cents>0),
 currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 status text NOT NULL DEFAULT 'pending_payment' CHECK(status IN ('pending_payment','paid','provisioning','active','cancelled','refunded')),
 affiliate_id text REFERENCES caldock_affiliates(user_id), commission_bps integer NOT NULL CHECK(commission_bps BETWEEN 0 AND 10000),
 commission_mode text NOT NULL CHECK(commission_mode IN ('first_order','each_order')),
 version integer NOT NULL DEFAULT 1, delivery_note text NOT NULL DEFAULT '', renewal_enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(), paid_at timestamptz, delivered_at timestamptz, billing_ends_at timestamptz,
 UNIQUE(customer_id,request_key), CHECK(affiliate_id IS NULL OR affiliate_id<>customer_id)
);
CREATE INDEX IF NOT EXISTS caldock_order_customer ON caldock_orders(customer_id,created_at DESC);
CREATE INDEX IF NOT EXISTS caldock_order_status ON caldock_orders(status,created_at DESC);
CREATE INDEX IF NOT EXISTS caldock_order_affiliate ON caldock_orders(affiliate_id);
-- Expand the previous constraint without changing existing order amounts.
DO $caldock$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='caldock_orders'::regclass AND conname='caldock_orders_interval_check' AND pg_get_constraintdef(oid) NOT LIKE '%week%') THEN
  ALTER TABLE caldock_orders DROP CONSTRAINT caldock_orders_interval_check;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='caldock_orders'::regclass AND conname='caldock_orders_interval_check') THEN
  ALTER TABLE caldock_orders ADD CONSTRAINT caldock_orders_interval_check CHECK(interval IN ('week','month','quarter','year'));
 END IF;
END $caldock$;
CREATE TABLE IF NOT EXISTS caldock_commissions (
 id text PRIMARY KEY, order_id text NOT NULL UNIQUE REFERENCES caldock_orders(id),
 affiliate_id text NOT NULL REFERENCES caldock_affiliates(user_id), amount_cents integer NOT NULL CHECK(amount_cents>0),
 rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 1 AND 10000),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','settled','void')),
 settlement_reference text, settled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS caldock_commission_owner ON caldock_commissions(affiliate_id,status);
CREATE TABLE IF NOT EXISTS caldock_payment_events (
 event_id text PRIMARY KEY, order_id text NOT NULL REFERENCES caldock_orders(id),
 event_type text NOT NULL CHECK(event_type IN ('paid','refunded')), amount_cents integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
-- Stripe adapter (additive and repeatable). Provider IDs only; no card data is stored.
ALTER TABLE caldock_orders ADD COLUMN IF NOT EXISTS stripe_checkout_session_id text;
ALTER TABLE caldock_orders ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE caldock_orders ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
CREATE INDEX IF NOT EXISTS caldock_order_stripe_subscription ON caldock_orders(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS caldock_order_stripe_customer ON caldock_orders(stripe_customer_id);
CREATE TABLE IF NOT EXISTS caldock_stripe_events (
 event_id text PRIMARY KEY, event_type text NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS caldock_audit (
 id text PRIMARY KEY, actor_id text REFERENCES caldock_users(id), action text NOT NULL,
 object_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
`;
