# CalDock accounts, orders and referrals

CalDock reuses the existing craftos.app service and PostgreSQL database, at the user's explicit request. It has its own `caldock_*` tables, Google/Apple identities, HttpOnly session cookies, CSRF protection, administrator allowlist and audit events. Work OS / DingTalk sessions and customer sessions are not interchangeable. Existing Work OS and Wiki frontend pins remain unchanged.

## URLs

- Marketing preview: https://yonge6.github.io/mac-mini-rental/
- Account app: https://wodemac.com/?view=login&lang=zh
- Customer center: https://wodemac.com/?view=account&lang=zh
- Order administration: https://wodemac.com/?view=admin&lang=zh
- Configuration availability: https://craftos.app/api/caldock/capabilities

Account routes stay on craftos.app so authentication uses first-party HttpOnly cookies rather than third-party cookies or tokens in a marketing-page URL. CalDock statics are built from a full verified commit in `deploy/caldock-revision.txt` and mounted at `/caldock/`. The GitHub marketing site directs account/checkout flows there. All API writes require exact Origin and the session CSRF token.

## Google activation

Create a CalDock web OAuth client in the owner's Google Cloud project. Configure this exact authorized redirect URI:

`https://craftos.app/api/caldock/auth/google/callback`

Place the client ID and client secret in Render's private environment variables `CALDOCK_GOOGLE_CLIENT_ID` and `CALDOCK_GOOGLE_CLIENT_SECRET`. Never put a client secret in GitHub, the frontend or chat. The flow requests only OpenID, email and basic profile; verifies signature, issuer, audience, expiry, nonce and Google PKCE. A configuration flag is not a completed real-login acceptance test.

## Apple activation

Associate a Sign in with Apple-enabled primary app with a CalDock Services ID and private key in the owner's Apple developer account. Register domain `craftos.app` and this return URL:

`https://craftos.app/api/caldock/auth/apple/callback`

Set the private server variables `CALDOCK_APPLE_SERVICE_ID`, `CALDOCK_APPLE_TEAM_ID`, `CALDOCK_APPLE_KEY_ID`, `CALDOCK_APPLE_PRIVATE_KEY`. The server signs a short-lived client secret; private key and identity tokens never enter the frontend. Apple's form_post callback uses a separate Secure SameSite=None OAuth browser-binding cookie; the final account session remains HttpOnly, Secure and SameSite=Lax.

## Administrator activation

1. Finish and verify a real Google or Apple sign-in as the intended owner.
2. Read that CalDock user's immutable ID from their authenticated `/api/caldock/me` response, or from the private database.
3. Have the owner explicitly confirm the ID, then add it to `CALDOCK_ADMIN_USER_IDS` in private hosting configuration.
4. Verify that this user can access administration and another ordinary account receives 403.

The first user is never an administrator. Matching email addresses do not auto-link Google and Apple identities. Client profile data cannot assign roles. No development login is exposed by CalDock.

## Orders and commission rules

- The server determines USD 199/month, USD 507/quarter (169/month), or USD 1,548/year (129/month) in integer cents. Clients cannot supply prices, customer IDs or paid status.
- Pricing changes apply to new orders only. Existing orders retain their snapshotted amount and commission rule. Quarterly delivery starts a three-calendar-month service period.
- Order creation is idempotent per customer/request key and respects one open rental per customer.
- A new customer's initial referral is bound from a server-side 30-day first-touch record. Existing customers cannot overwrite attribution; self-referrals cannot earn commission.
- Commission defaults to zero and first paid order. Administrators can set 0–100% and first/every paid order. Each order snapshots the rule, so future edits do not retroactively change it.
- Paid state and commissions come only from `recordVerifiedCaldockPayment`, an internal adapter function. It is intentionally NOT an HTTP endpoint. The Stripe adapter (below) is its only caller, after verifying Stripe's webhook signature. A client payment-success flag is never accepted.
- Full refunds void commissions. Prior offline settlement references and timestamps are preserved so a settled/refunded commission can be flagged for recovery.
- Administrator order actions only advance verified paid orders through provisioning and delivery. Delivery begins the billing period. Version checks prevent stale changes.
- Commissions require approval, then a reference for a completed OFFLINE settlement. No automatic transfer is performed.

## Stripe payments (test mode first)

CalDock uses Stripe Checkout subscriptions: monthly $199, quarterly $507 every 3 months, yearly $1,548. Prices come from the server order snapshot; no Stripe products or prices need to be created by hand. No card data reaches this service.

Activation (the Stripe account owner or an operator with Render access; never paste keys into GitHub, chat or the frontend):

1. In Stripe **test mode**, Developers → API keys: create a **restricted key** with write access to Checkout Sessions and Subscriptions and read access to Customers and Invoices (a standard `sk_test_` key also works).
2. Developers → Webhooks → Add endpoint: `https://craftos.app/api/caldock/stripe/webhook`. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`. Copy its signing secret (`whsec_…`).
3. Render private environment variables: `CALDOCK_STRIPE_SECRET_KEY` and `CALDOCK_STRIPE_WEBHOOK_SECRET`, then redeploy.
4. Check `https://craftos.app/api/caldock/capabilities`: `"payments":true,"paymentMode":"test"`.

Live money needs a separate decision: replace both values with live-mode ones **and** set `CALDOCK_STRIPE_ALLOW_LIVE=true`. A live key without that switch, or any malformed value, disables CalDock payments only (logged at startup); Work OS keeps running.

Switching to another Stripe account (subscriptions already paid on the old one keep working):
1. In the new account, repeat steps 1–2 (same webhook URL and events) and put its key and signing secret in `CALDOCK_STRIPE_SECRET_KEY` / `CALDOCK_STRIPE_WEBHOOK_SECRET`.
2. Move the old account's two values to `CALDOCK_STRIPE_PREVIOUS_SECRET_KEY` / `CALDOCK_STRIPE_PREVIOUS_WEBHOOK_SECRET`, and leave the old account's webhook endpoint in place.
3. New payment pages always open on the new account. Webhooks are accepted when signed by either account. Stopping renewal, delivery and closing a payment page try the new account first and, on "not found", the old one.
4. Both accounts must be in the same mode; a half-set or mismatched previous account disables CalDock payments (logged at startup). Remove both `PREVIOUS` values once the old account has no live subscriptions.

Behaviour:
- `POST /caldock/orders/:id/checkout` (signed-in owner, Origin + CSRF) returns one hosted Checkout URL per pending order and reuses it while open. The frontend only navigates to `https://checkout.stripe.com`.
- The webhook verifies the v1 signature over raw bytes (5-minute tolerance) and rejects test/live mismatches. Duplicate deliveries are harmless. Deterministic rejections (amount or state mismatch) are written to `caldock_audit` as `payment.rejected` for manual refund review instead of being retried forever.
- Billing starts on delivery: marking an order delivered moves the next automatic charge to the end of the delivered period (`trial_end`, no proration).
- Customer "stop next renewal" sets `cancel_at_period_end`; cancelling a pending order expires its open Checkout page.
- `invoice.paid` for a renewal extends `billing_ends_at` once per event. Renewal commissions are not yet accrued automatically (pending decision).
- A full `charge.refunded` cancels the subscription and marks the order refunded (voiding commission). Partial refunds stay manual.
- End-to-end acceptance still requires real customer sign-in (Google/Apple not configured yet), a Stripe test card payment, delivery, stop-renewal and refund in the Stripe test dashboard.

## Explicit demonstrations

`?view=account&demo=1&role=customer` and `?view=admin&demo=1&role=admin` use fictional browser-local records and a visible demo banner. They never call production business APIs, create real users, seed the server database or simulate Google/Apple consent success. Production sign-in buttons remain unavailable until their provider is configured.

## Verification

`npm run typecheck`, `npm test` (embedded and real PostgreSQL CI), Docker/Caddy smoke tests, and browser checks cover ownership, namespace separation, role escalation, CSRF, OIDC claims, state/replay, order tampering, request/payment idempotency, commission snapshots, refunds and delivery versions. Real provider sign-in, real payment and real payout remain separate acceptance items.

Official references:
- https://developers.google.com/identity/openid-connect/openid-connect
- https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple
- https://developer.apple.com/documentation/signinwithapple/verifying-a-user
- https://developer.apple.com/documentation/signinwithapple/receiving-a-users-identity-token
- https://github.com/panva/jose
