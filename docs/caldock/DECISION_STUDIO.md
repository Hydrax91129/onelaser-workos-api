# Decision Studio V4

**Not public since 2026-11-08 (owner decision).** Caddy answers 404 for the page and for `/api/caldock/studio/*` on every host, and the release no longer fetches its files. Shared data stays in the database. The rest of this page describes the earlier public setup.

User decision on 2026-11-01: viewing is public for everyone. Shared writes require a valid existing CalDock session and an explicit `caldock_studio_members` role. Work OS sessions, commerce admin rights and first visits grant no studio editing privileges.

The page is built from the pinned `Yonge6/mac-mini-rental` revision and mounted independently at `/decision-studio/`. The public GitHub Pages calculator uses browser-local storage and links here; it does not send browser-local edits to the shared state at sign-in. Commerce pricing and orders are untouched.

`/api/caldock/studio/state`, `/history`, `/health` and SSE `/live` are publicly readable. Keep private supplier details, credentials and payment information out of the shared plan. Member identities/roles and editor CSRF are returned only to authorized studio members. All writes require exact Origin, a matching session CSRF, membership checked again under transaction locks, bounded validated fields and revision preconditions. Field overlap includes ancestors/descendants and detects ABA changes. Request IDs make retries idempotent. Imports need owner access; restores append a new revision and preserve history.

PostgreSQL NOTIFY is committed in the same transaction as each edit. Every instance has a dedicated LISTEN connection with reconnect handling; SSE delivers a fresh snapshot on connect and checks revisions at heartbeat as recovery for missed notifications. No paid platform or external message broker is introduced. References: https://www.postgresql.org/docs/current/sql-listen.html and https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events .

Editing setup: configure the existing CalDock Google/Apple login as described in `SETUP.md`, have the approved owner sign in, verify their immutable CalDock user ID, then set `CALDOCK_STUDIO_OWNER_USER_IDS` in private deployment configuration. On startup, only existing explicitly approved IDs are provisioned as owners. Existing roles are preserved. After bootstrap, owners grant/revoke access to existing CalDock account IDs in the UI. Removing the last owner is rejected; membership changes have a separate append-only audit table. No messages or invitations are sent.

No new password auth or developer login is deployed. The current public login capabilities reported Google/Apple disabled during initial implementation. Public viewing does not depend on enabling those providers; live real-identity editor acceptance remains pending until configuration and actual sign-in.

Run `npm run typecheck`, `npm test`, `npm run build`. `test/caldock-studio.test.ts` verifies public read/protected write boundaries, CSRF, field merges/conflicts, same-value ABA protection, idempotency, validation, history restores, owner-only import, permission revocation and real SSE between server instances. CI also runs it against PostgreSQL with separate adapters to verify the database notification bus.
