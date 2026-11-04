# Deploy OneLaser Work OS

[中文](README.md) · English

The production host supplies an HTTPS subdomain. GitHub Pages remains a public demo. The Docker image serves a pinned frontend and `/api` on one origin, backed by PostgreSQL. Implemented adapters and mock tests do not establish real provider or production acceptance.

## Selected setup

- One company workspace for approximately 10 people, with `WORKOS_TEAM_MODE=company`. The configured DingTalk enterprise and department allowlist still apply.
- Managers are explicitly listed in `DINGTALK_MANAGER_USER_IDS`; the first login never becomes an administrator automatically.
- The pilot prefers an independent Work OS workflow using the existing Grok Bot allowance. The existing support Bot and Zoho workflows stay untouched. The separately billed model API remains an optional fallback.
- No demo seeds or developer login in production. Business content is never persisted in browser localStorage.
- DingTalk notifications are disabled initially. The designated manager inspects and accepts deliverables; AI findings remain advisory.

## Managed hosting with Render

1. Open [New Blueprint](https://dashboard.render.com/select-repo?type=blueprint), select `Hydrax91129/onelaser-workos-api`, and use the root `render.yaml`.
2. Review the Web Service, PostgreSQL instance, region and actual charges before applying. The template selects Singapore, web plan `0.5c-512mb`, database plan `0.1c-256mb` and 1 GB storage. Current platform plans and displayed prices govern; this template authorizes no payment.
3. Enter credentials only in the hosting secret settings. Never put them in GitHub, the frontend, URLs or chat.
4. Use the assigned `https://<service>.onrender.com` URL. `APP_PUBLIC_URL` defaults to Render's `RENDER_EXTERNAL_URL`; no purchased domain is required. Register the app homepage and `https://<service>.onrender.com/api/auth/dingtalk/callback` in DingTalk.
5. Complete real acceptance below before inviting employees. Missing credentials disable login; they do not enable a fallback identity.

| Variable | Purpose |
| --- | --- |
| `DINGTALK_CLIENT_ID`, `DINGTALK_CLIENT_SECRET` | Separate enterprise internal app credentials |
| `DINGTALK_CORP_ID` | Approved enterprise |
| `DINGTALK_ALLOWED_DEPARTMENT_IDS` | Approved real department IDs, comma separated; required in company mode |
| `DINGTALK_INCLUDE_SUBDEPARTMENTS` | On by default: members of any sub-department (any depth) of an allowed department can sign in and are synced, filed under that allowed department. Set `false` to admit direct members only |
| `DINGTALK_MANAGER_USER_IDS` | Explicit manager user IDs, comma separated |
| `REQUIRE_AI_ASSESSMENT` | Unset by default: the reviewer can accept without waiting for the Bot assessment. Set `true` to require a sufficient assessment before acceptance |
| `AI_REVIEW_MODE` | Template selects `bot`; code defaults to `api`. Incomplete integration settings disable assessment |
| `GROK_BOT_MCP_AUTH_MODE` | Render selects `oauth`; code defaults to `bearer` compatibility |
| `GROK_BOT_OAUTH_REDIRECT_URIS` | Exact OAuth callback allowlist, empty by default; an administrator must verify the actual client before setting it |
| `GROK_BOT_OAUTH_PRE_REGISTERED_CLIENT_ID` | Optional exact HTTPS client ID mapped locally; no metadata URL fetching |
| `GROK_BOT_WEBHOOK_URL`, `GROK_BOT_WEBHOOK_SECRET` | Dedicated routine's actual HTTPS trigger URL and secret |
| `GROK_BOT_WEBHOOK_ALLOWED_HOST` | Exact verified routine hostname, without wildcards or local/private destinations |
| `GROK_BOT_WORKER_TOKEN` | `bearer` compatibility only; OAuth uses manager consent and PKCE, without a static worker secret in Bot chat |
| `GROK_BOT_ORG_ID` | Approved worker organization; may fall back to the explicitly configured DingTalk corporation |
| `AI_PROVIDER_API_KEY`, `AI_MODEL_ID` | Required only in `api` mode: separate API key and an account-accessible model supporting structured output |
| `DINGTALK_AGENT_ID` | App AgentId, required for work notifications |

An enterprise administrator must grant the independent app its login identity, enterprise membership mapping and approved department/member read permissions. Work notifications still require the app AgentId and explicit activation. Use the current developer console and official documentation for exact scope names. Limit app visibility to approved employees. The model receives only the authorized task criteria and submitted text; it does not fetch links or receive compensation or the employee directory. Use fictional material for the first real call.

See the [Bot integration guide](../docs/integrations/GROK_BOT_SETUP.en.md). Deploy the base service and DingTalk login, configure administrator-verified callbacks and any required pinned client ID, then connect OAuth MCP. A manager explicitly approves and clicks Return to Bot. OAuth can connect before webhook settings are complete; actual assessments still require the dedicated Routine URL, secret and hostname. An empty callback allowlist disables OAuth, without static-secret or anonymous fallback. The template requires no model API credits. Webhook acceptance only starts execution; completion returns separately. Bot usage has plan limits, and account-wide shared computer/logins mean a separate workflow does not replace server authorization.

### Cut over to craftos.app

Verify `craftos.app` DNS, Render domain verification and HTTPS before setting `APP_PUBLIC_URL=https://craftos.app`. Update the DingTalk homepage and login callback together, including `DINGTALK_REDIRECT_URI` if it is explicitly set. Only this exact origin (optionally ending in `/`) enables a 307 redirect from `onelaser-workos.onrender.com`, preserving the path, query and method with `no-store`. `/healthz` and `/api/health` continue to answer health probes directly. All URLs retain their previous behavior before cutover; restoring the old `APP_PUBLIC_URL` disables the redirect.

Employees must sign in at the new domain; existing sessions and in-progress logins do not migrate. Update the private connector origin and reauthorize the dedicated Bot at its new MCP URL. Redirects do not replace OAuth consent or API client migration. The destination is the literal `https://craftos.app`, never an incoming Host or an arbitrary environment URL.

Run the routing, health and Host/origin-injection integration checks against a real Caddy 2 binary: `CADDY_BIN=/absolute/path/to/caddy node --import tsx --test test/caddy-redirect.test.ts`. Local runs explicitly skip when `CADDY_BIN` is absent. After building the production image, CI extracts its Caddy binary and sets `CADDY_BIN` to require these checks before the existing same-origin smoke test. The temporary extraction container is removed on success or failure.

### Download token for private repositories (`GITHUB_FETCH_TOKEN`)

The Docker build downloads the pinned frontend (`Hydrax91129/onelaser-workos`) and Wiki (`Hydrax91129/onelaser-support-center`). Anonymous downloads work while they are public; set up a read-only token before making them private.

1. Token: a GitHub fine-grained token limited to those two repositories, with Contents: Read-only. Enter it only in the platform's secret settings, never in code, URLs or chat.
2. Render: add a **Secret File** named `GITHUB_FETCH_TOKEN` (Environment → Secret Files) containing the token; plain environment variables do not reach the Docker build. The Dockerfile reads it as a BuildKit secret (`RUN --mount=type=secret,id=GITHUB_FETCH_TOKEN,dst=/etc/secrets/GITHUB_FETCH_TOKEN`), not ARG/ENV, so it never lands in an image layer.
3. GitHub CI: add the Actions secret `_GITHUB_FETCH_TOKEN` to this repository (GitHub rejects secret names starting with `GITHUB_`); `ci.yml` passes it with `docker build --secret`.
4. Check: the build log prints `GITHUB_FETCH_TOKEN: used` (whether it was used, never the value). Make the repositories private only after both the Render and CI logs say `used`. `not provided` means the token did not reach the build.
5. Without a token the scripts download anonymously; an invalid token fails the build (401/404) instead of silently falling back. CalDock (`Yonge6/mac-mini-rental`) is unaffected and stays anonymous.

## Existing server alternative

`compose.yaml` includes a persistent PostgreSQL volume and the application. It exposes only `127.0.0.1:8088`; an existing HTTPS reverse proxy must forward the production origin to this port.

1. Create the Git-ignored `.env.production` at repository root, with approved settings and `APP_PUBLIC_URL=https://<host>`.
2. Set a strong random `POSTGRES_PASSWORD`. Use URL-safe random characters if embedding it in a connection string.
3. Run `docker compose --env-file .env.production -f deploy/compose.yaml up -d --build`.
4. Back up the database volume. Do not use `down -v` for routine restarts. Test restores in a separate database before switching production.

## Acceptance and releases

- Require CI: TypeScript, PGlite, real PostgreSQL, Docker build, same-origin API, security headers, fail-closed login and an unconfigured Bot adapter.
- `/healthz` checks database connectivity. `/api/capabilities` reports configuration only; `configured` is not verified acceptance. In this version, `productionReady:false` is a constant marker that does not change with configuration or real tenant acceptance. It is not a deployment-failure signal or a substitute for acceptance records.
- Verify actual manager and employee login, rejection of unapproved enterprise/departments, employee scope, no privilege escalation, and immediate loss of sessions after member deactivation through sync.
- In OAuth mode verify root/path-specific well-known metadata, external `/api` endpoints, actual client registration and exact redirects, explicit manager consent, PKCE, state/iss, refresh rotation and revoke. Click Return to Bot within two minutes of approval; the completion page does not auto-navigate. Worker secrets, business cookies and OAuth tokens cannot substitute for one another. A changed policy rejects old grants; permanent removal requires explicit revoke.
- Create OKRs/KRs and a task; submit evidence; verify Grok citations; inspect and accept as manager; reload and confirm persistence. Stale writes must return 409 without silent overwrites. In Bot mode also verify pending, leased, completed and uncertain/failed states, explicit retry, invalidated leases and rejection of old submissions. Dispatch must never masquerade as a completed assessment.
- Check Chinese/English, theme, logout and login. Only theme/language preferences may use localStorage, never task data or sessions.
- Approve a specific test recipient before setting `DINGTALK_NOTIFICATIONS_ENABLED=true`. `queued` means provider acceptance, not confirmed delivery.
- Confirm backup retention, costs and a restore drill. `frontend-revision.txt` pins the frontend; updating it requires rebuilding the image. Keep database migrations compatible with any rollback.

The application does not automatically decide retention, termination or compensation. Managers can inspect evidence and human acceptance records.

### Read-only executive overview

Set `WORKOS_EXECUTIVE_USER_IDS` to explicitly verified internal Work OS `users.id` values, comma separated. It defaults to empty; do not substitute names, phone numbers, or DingTalk employee numbers. Authenticate the owner and confirm the mapping before granting access. `/me` returns `executiveAccess`; `/executive/summary` checks that allowlist and the active session, then restricts all aggregates to that user's organization. Ordinary task detail/write/review permissions remain unchanged.

Counts include all recorded tasks, beyond the normal 100-task list limit. Follow-up details are capped at 50. Company progress averages valid KRs within objectives and then company objectives; missing metrics remain null. Overdue means current due date has passed and task is not accepted; it can overlap pending review. No salary estimates or employment decisions. Live workflow currently has no blocked state; demo data includes one. Company mode shares a pilot collaboration scope; executive counts group each member and their tasks by the retained verified DingTalk department, counting multi-department members once under the first approved department. Shared-scope goals are not attributed to an original department.
