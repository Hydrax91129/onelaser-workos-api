# CLAUDE.md — OneLaser WorkOS（craftos.app）

> 所有 Claude Code 会话在开始任何工作前必须先完整阅读本文件。
> 本文件同时承担两个职能：①所有会话共同遵守的规则；②各模块会话之间唯一的"沟通板"。
> 会话之间没有共享记忆，彼此看不到对方未合并的工作。想让其他会话知道的事情，必须写进本文件并合并到 main。
>
> 版本：v1.2（2026-11-04）｜维护人：KC｜标注"【待填】"的地方由工程师或"平台核心"会话补全
>
> **主版本在后端仓库 `Yonge6/onelaser-workos-api` 根目录。** 前端仓库 `Yonge6/onelaser-workos` 根目录放一份完全相同的副本，只读：要改本文件，一律改后端仓库的主版本，合并后由 core 同步到前端仓库。两边内容不一致时，以后端主版本为准。
>
> **新增模块、新增共享数据表，或改了本文件里的任何约定，必须在同一个 PR 里更新本文件的主版本。**
>
> **两个仓库都是公开的**：本文件和代码里都不能出现密钥、真实成本、真实价格或计价比例、真实库存、员工薪资和任何客户数据。

---

## 1. 项目概况

- **是什么**：craftos.app 是 OneLaser 正在线上使用的公司内部系统（WorkOS），美国团队和中国团队（武汉、东莞、济南/山东）共同使用。
- **仓库**：GitHub，Yonge6 账号下的 `onelaser-workos-api`（后端、数据库、部署，本文件主版本）和 `onelaser-workos`（网页前端），详见第 2 节
- **主分支**：main（所有 PR 合并到这里）。注意线上部署跟踪的是另一个分支，合并到 main 不等于上线，见第 2 节"发布方式"
- **部署**：由 Yongger 负责发布；托管正在迁移到 OneLaser 自己的 Render 工作区，目标是稳定、可控地发布。
- **决策人**：KC（创始人）。涉及业务规则、权限、数据结构的取舍，以 KC 的确认为准。

### 当前侧边栏结构（按线上代码更新，2026-11-03；未经 KC 同意不得改动）

> KC 2026-11-03 决定：侧边栏先以代码为准。下面是线上正在用的版本（后端固定的前端提交 `0c90f37`，定义在前端 `dist/live-app.js` 的 `navs`）。和 KC 2026-10-31 原描述不一致的地方列在第 7 节，等 KC 审批；审批前不要按任何一边去改代码。

- **工作区**：个人工作台、OKR 目标（参考飞书 OKR）、项目管理（monday.com + Asana 风格，项目任务自动流入个人任务列表）、个人任务
- **报表区**：OKR 分析、项目分析、任务分析
- **产品+供应链**（受限可见）：
  - 产品与库存：有 `products` 权限、有仓库权限、有经销商权限、是负责人（manager）或管理员时可见；
  - 成本核算、智能供应链：只有 `products` 权限或管理员可见；
  - ERP 权限：负责人（manager）和管理员可见。
- **产品开发测试区**：客服工作台（有客服权限才可见）、知识中心 / Wiki、产品质量追踪（工厂账号登录后只能看到这一项）
- **其他**：
  - 所有人可见：个人设置、版本更新；
  - 组织架构：开通组织资料后可见；
  - 人事档案、IT 账号与订阅：开通对应功能后可见，具体数据权限由后端控制；
  - 组织与权限、Bug 与建议：仅管理员可见。
- **不在侧边栏、从其他入口进入**：
  - 集成与通知：在个人设置里，仅管理员；
  - 老板看板：仅 `WORKOS_EXECUTIVE_USER_IDS` 里的人；
  - 库存管理（WMS）、成果验收、绩效参考：从对应页面进入。
- 前端仓库最新代码里已经有"营销"分区（KOL 管理），但还没有固定到线上版本，所以上面没有列。
- 新模块要进侧边栏时，先在第 7 节"待 KC 决策"里登记位置提案，不得自行添加。

---

## 2. 技术栈与目录结构（core 读代码补全，基于 main `23c5d1d`，2026-11-03）

**两个仓库。** 改界面要动前端仓库，改接口和数据要动后端仓库。上线时一起发布。

| 仓库 | 内容 | 本文件 |
|---|---|---|
| `Yonge6/onelaser-workos-api`（本仓库） | 后端 API、数据库结构、部署配置；构建时把固定版本的前端一起打进镜像 | 就在这里 |
| `Yonge6/onelaser-workos` | 网页前端（`dist/` 下的静态文件） | 只读副本，由 core 从这里同步 |

- **前端**：原生 JavaScript + CSS，没有框架，也没有构建步骤，`dist/` 里的文件就是线上文件。每个模块一个文件，例如 `dist/wms.js` + `dist/wms.css`、`dist/kol.js`、`dist/dealers.js`；`dist/live-app.js` 是真实模式的外壳（导航、顶栏、任务抽屉）；各模块挂在 `window.WorkOSXxx` 上，由 live-app 的 `render()` 调用模块的 `configure()`，注入 api、state、语言等。`dist/api-client.js` 负责 Cookie、CSRF 和错误处理，`dist/i18n.js` 负责中英文。改了 JS/CSS 后要运行 `node tools/stamp-assets.mjs` 更新 `index.html` 里的版本号，否则浏览器会继续用缓存。
  - 后端用 `deploy/frontend-revision.txt` 固定前端的某个提交（40 位哈希）；`tools/fetch-frontend.mjs` 构建时按哈希下载并校验 `dist/`。**前端合并后，要在后端改这个哈希并发布，线上才会变。**
  - CalDock 是另一个独立前端，用 `deploy/caldock-revision.txt` 固定；知识中心 Wiki 的公开内容用 `deploy/wiki-revision.txt` 固定。
- **后端**：Node.js 24（最低 22）+ TypeScript（strict，ES 模块）+ Fastify 5；请求校验用 zod 4。
  - 入口：`src/server.ts`（读环境变量、建库、启动）→ `src/app.ts`（`buildApp`：注册所有路由、登录拦截、CSRF、错误处理）。
  - 每个模块一个文件，同时包含建表语句和路由，例如 `src/wms.ts`、`src/rma.ts`、`src/quality.ts`、`src/hr.ts`、`src/it-accounts.ts`、`src/products.ts`、`src/support.ts`、`src/public-wiki.ts`、`src/caldock*.ts`。
  - 外部集成：`src/integrations/`（钉钉 `dingtalk.ts`、Grok Bot、OAuth 等，路由在 `routes.ts`）。
  - 线上由 Caddy（`deploy/Caddyfile`）在同一域名下提供网页，`/api/*` 去掉前缀后转给 Node；启动脚本是 `deploy/container-start.sh`，镜像见 `Dockerfile`。
- **数据库 / ORM**：PostgreSQL 16，**没有 ORM**，直接写 SQL（`pg` 驱动，参数化查询 `$1,$2…`）。本地和测试用内嵌的 PGlite（`@electric-sql/pglite`），不需要装数据库。统一接口在 `src/db.ts`：`db.query`、`db.transaction`。
- **认证与权限**：
  - 会话：`src/auth.ts`（会话令牌只存哈希、HttpOnly Cookie、CSRF 令牌）；登录拦截和 CSRF 校验在 `src/app.ts` 的 `onRequest` 钩子里，所有路由默认要求登录，公开路径要明确列出。
  - 登录方式：钉钉 OAuth（`src/integrations/dingtalk.ts`、`routes.ts`）；邮箱 + 密码 / 邮箱验证码和成员邀请（`src/members.ts`）。
  - 角色和权限点：`users.role`（`employee` / `manager`）+ `users.grants`（JSON 数组）。权限点清单是 `src/org.ts` 里的 `GRANTS`：`products`、`product_cost_detail`、`products_manage`、`pricing_msrp`、`supply`、`supply_manage`、`warehouse`、`warehouse_manage`。管理员判断是 `src/org.ts` 的 `isAdmin`。
  - 按人指定的权限由环境变量控制（见下方清单的 `*_USER_IDS`），例如老板看板 `WORKOS_EXECUTIVE_USER_IDS`、HR `WORKOS_HR_USER_IDS`。
  - 数据可见范围（谁能看哪些任务和 OKR）：`src/domain.ts`（`visibleTask`、`visibleObjective`、`attachReportingScope`）。
  - 各模块自己的权限判断写在模块文件里，例如 `src/wms.ts` 的 `warehouseLevelFor`、`src/quality.ts` 的工厂账号限制。
- **数据库迁移目录**：**没有单独的迁移目录，也没有迁移版本号。** 每个模块文件导出一段建表 SQL（如 `wmsSchema`），在 `src/db.ts` 的 `schema` 里拼起来，每次服务启动时完整执行一遍。所以所有语句都必须能重复执行：`CREATE TABLE IF NOT EXISTS`、`ALTER TABLE … ADD COLUMN IF NOT EXISTS`、`CREATE INDEX IF NOT EXISTS`。改结构 = 在对应模块的 schema 末尾追加这类语句，并把新模块的 schema 加进 `src/db.ts`（这一步属于第 4 节的共享区域）。
- **侧边栏 / 路由定义位置**：
  - 侧边栏：前端 `dist/live-app.js` 里的 `navs`（每项：页面代号、图标、中文名、英文名、所属分区）和 `navSections`（分区）；某个菜单项显示不显示由同一文件的 `navVisible` 和各个 `*Access` 函数决定。
  - 页面路由：前端用地址里的 `#页面代号`，由 `live-app.js` 的 `routePage` 切换。
  - 后端接口：在 `src/app.ts` 的 `buildApp` 里调用各模块的 `register*Routes` 注册。
- **公共组件目录**：前端没有组件库，也没有单独的组件目录。共用的东西是：`dist/styles.css`、`dist/workspace-ui.css`（全局样式和主题变量）、`dist/api-client.js`（请求）、`dist/i18n.js`（中英文）、`dist/help-tips.js`（悬停说明）、`dist/preferences.js`（语言和主题）、`dist/assets/`（图标字体、Logo）。后端的共用代码在 `src/errors.ts`（`deny()` 出错）、`src/i18n.ts`（错误信息中文翻译）、`src/db.ts`、`src/auth.ts`。
- **本地运行命令**（后端，在本仓库）：
  ```sh
  npm ci
  export NODE_ENV=development ALLOW_DEV_LOGIN=true SEED_DEMO=true PGLITE_DATA_DIR=.runtime/pglite
  export DEV_LOGIN_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
  npm run dev          # 监听 127.0.0.1:3001，内嵌数据库，虚构账号
  ```
  生产方式运行：`npm run build && npm start`。在 Mac 上前后端一起跑：`npm run local:mac`（见 `deploy/MAC_LOCAL.md`）。
- **测试命令**：
  - 后端：`npm run typecheck` + `npm test`（`test/*.test.ts`，Node 自带测试框架，内嵌数据库，测试数据全部虚构）。要用真 PostgreSQL 测时设置 `TEST_DATABASE_URL`。
  - 前端（在前端仓库）：`npm test`（`node --test test/*.test.mjs`）。
  - CI：`.github/workflows/ci.yml`。每次推送都会跑类型检查、内嵌库和 PostgreSQL 两遍测试、构建生产镜像，并对容器做冒烟测试。
- **代码检查（lint）与格式化命令**：**目前没有配置 lint 或格式化工具**（没有 ESLint / Prettier）。代码质量靠 `npm run typecheck`（TypeScript strict）和测试保证。请跟随所改文件已有的写法，不要整文件重新排版（会产生大量无关改动和合并冲突）。要加 lint 工具属于第 4 节"依赖与构建配置"，先在第 7 节登记。
- **环境变量清单**（只列变量名；值在 Render 上配置，绝不写进代码或本文件；说明见 `render.yaml` 和 `README.md`）：
  - 基础：`NODE_ENV`、`HOST`、`PORT`、`DATABASE_URL`、`PGLITE_DATA_DIR`、`APP_PUBLIC_URL`、`RENDER_EXTERNAL_URL`、`FRONTEND_CONNECTED`、`SEED_DEMO`、`ALLOW_DEV_LOGIN`、`DEV_LOGIN_SECRET`
  - 团队与人员权限：`WORKOS_TEAM_MODE`、`WORKOS_TEAM_NAME`、`WORKOS_EXECUTIVE_USER_IDS`、`WORKOS_HR_USER_IDS`、`WORKOS_IT_USER_IDS`、`WORKOS_QUALITY_LEAD_IDS`、`WORKOS_QUALITY_FACTORY_DEPARTMENTS`、`WORKOS_SUPPORT_USER_IDS`、`WORKOS_SUPPORT_REVIEWER_IDS`、`WORKOS_SUPPORT_ORG_ID`、`WORKOS_SUPPORT_INGEST_TOKEN`
  - 钉钉：`DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_CORP_ID`、`DINGTALK_AGENT_ID`、`DINGTALK_REDIRECT_URI`、`DINGTALK_ALLOWED_DEPARTMENT_IDS`、`DINGTALK_INCLUDE_SUBDEPARTMENTS`、`DINGTALK_ADDITIONAL_USER_IDS`、`DINGTALK_MANAGER_USER_IDS`、`DINGTALK_NOTIFICATIONS_ENABLED`
  - 邮件：`RESEND_API_KEY`、`EMAIL_FROM`、`SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASS`、`FEEDBACK_EMAIL`
  - AI：`AI_REVIEW_MODE`、`AI_PROVIDER_API_KEY`、`AI_PROVIDER_BASE_URL`、`AI_MODEL_ID`、`AI_SCORING_MODEL_ID`、`AI_TRANSLATION_MODEL_ID`、`AI_REVIEW_TIMEOUT_MS`、`REQUIRE_AI_ASSESSMENT`、`XAI_API_KEY`
  - Grok Bot：`GROK_BOT_MCP_AUTH_MODE`、`GROK_BOT_ORG_ID`、`GROK_BOT_WORKER_TOKEN`、`GROK_BOT_WEBHOOK_URL`、`GROK_BOT_WEBHOOK_SECRET`、`GROK_BOT_WEBHOOK_ALLOWED_HOST`、`GROK_BOT_OAUTH_REDIRECT_URIS`、`GROK_BOT_OAUTH_PRE_REGISTERED_CLIENT_ID`
  - HR 加密：`HR_DATA_KEY`、`HR_DATA_KEY_PREVIOUS`
  - 公开 Wiki 助手：`PUBLIC_WIKI_API_KEY`、`PUBLIC_WIKI_DATA_DIR`、`PUBLIC_WIKI_MODEL_ENABLED`、`PUBLIC_WIKI_MODEL_ID`、`PUBLIC_WIKI_MODEL_DAILY_LIMIT`
  - Shopify：`SHOPIFY_SHOP_DOMAIN`、`SHOPIFY_ACCESS_TOKEN`、`SHOPIFY_CLIENT_ID`、`SHOPIFY_CLIENT_SECRET`
  - CalDock：`CALDOCK_ADMIN_USER_IDS`、`CALDOCK_STUDIO_OWNER_USER_IDS`、`CALDOCK_MARKETING_URL`、`CALDOCK_GOOGLE_CLIENT_ID`、`CALDOCK_GOOGLE_CLIENT_SECRET`、`CALDOCK_APPLE_SERVICE_ID`、`CALDOCK_APPLE_TEAM_ID`、`CALDOCK_APPLE_KEY_ID`、`CALDOCK_APPLE_PRIVATE_KEY`、`CALDOCK_STRIPE_SECRET_KEY`、`CALDOCK_STRIPE_WEBHOOK_SECRET`、`CALDOCK_STRIPE_ALLOW_LIVE`
  - 其他：`OKR_TIMEZONE`、`NUDGE_INTERVAL_MS`、`FX_FALLBACK_CNY`
  - 新增环境变量时，同时加进 `render.yaml`（密钥用 `sync: false`）和本清单。

**模块与代码文件对照**（"拥有的数据"只有这个模块能写，别的模块只读或走接口，见 3.3、3.8）：

| 子功能 | 后端 `src/` | 前端 `dist/` | 拥有的数据 |
|---|---|---|---|
| 账号、组织、权限（core） | `auth.ts` `org.ts` `members.ts` | `people.js` `erp-access.js` | `users`、`departments`、`grants`（功能权限） |
| 任务、OKR、项目（core） | `app.ts` `task-board.ts` `completions.ts` `assign.ts` `okr*.ts` `projects.ts` | `task-board.js` `okr-board.js` `projects.js` `reports.js` | `tasks`、`submissions`、`reviews`、`objectives`、`key_results`、`projects` |
| 站内消息红点（core） | `inbox.ts` | `inbox.js` | `inbox_items`（别的模块只调用 `pushInbox()`，不要自建通知表） |
| Bug 与建议、版本记录（core） | `feedback.ts` | `feedback.js` `changelog.js` | `feedback` |
| PIM 与定价（pim） | `products.ts` | `products.js` | `product_catalog`（SKU 主数据、MSRP）、`product_pricing`（成本输入）、`pricing_rules`（公司计价规则）、`product_channel_prices`（各渠道价格及审批） |
| WMS 库存（wms） | `wms.ts` | `wms.js` | `wms_*`：库位、库存和出入库流水 |
| 退货维修 RMA（wms） | `rma.ts` | `rma.js` | `rma_*`（翻新机入库走 WMS 流水） |
| 经销商下单（dealer） | `dealer.ts` `dealer-admin.ts` | `dealers.js` | `dealer_*`（价格读 `product_channel_prices` 的 `dealer` 渠道，发货走 WMS 出库） |
| 客服（support） | `support.ts` `shopify.ts` `public-wiki.ts` | `company-support.js` `wiki*.js` | `support_*`、`public_wiki_*` |
| HRM（hrm） | `hr.ts` | `hr.js` | `hr_*`（美国、中国分区权限） |
| IT 账号与资产（asset） | `it-accounts.ts` | `it.js` | `it_*` |
| 质量追踪（quality） | `quality.ts` | `quality.js` | `quality_*` |
| KOL ROI（kol） | 未合并分支 `kol-phase1` | `kol.js` | `kol_*`（待合并） |
| CalDock（caldock，暂停） | `caldock*.ts` | 独立前端仓库 | `caldock_*`，和 WorkOS 用户完全隔离 |

**发布方式（读 Render 配置得到，2026-11-03）**：线上服务是 Render 上的 `onelaser-workos-migration`（新加坡），它跟踪 `codex/company-migration-live-20261102` 分支，**自动部署是关闭的**，要在 Render 上手动部署。合并到 `main` 不等于上线，完整步骤见 3.10。数据库 `onelaser-workos-db`：PostgreSQL 16，磁盘 1 GB，没有开自动扩容。`render.yaml` 里写的服务名和分支和线上实际不一致，以 Render 控制台为准。

---

## 3. 全局规则（所有会话必须遵守）

### 3.1 开工前
1. 先拉取最新的 main（`git pull --rebase`），确认自己的分支基于最新 main。**推送前再拉一次**：其他会话随时在推送代码。
2. 读完本文件，确认自己负责的模块和边界（第 6 节）。
3. 看一下第 8 节变更日志里最近的改动，特别是共享区域的改动。

### 3.2 改动前先出方案（KC 的硬性要求）
- 任何改动开始前，先用中文列出：要改哪些文件、新增哪些表或字段、界面前后对比（before/after）。
- KC 批准后再执行。KC 标注批准的条目直接执行，不需要再次确认。
- 只改动 KC 批准范围内的东西，不顺手"优化"范围外的代码。

### 3.3 模块边界
- 每个会话只改自己模块的目录和文件（第 6 节登记）。
- 需要改共享区域（第 4 节）时，不要自己动手。在第 7 节登记需求，由平台核心会话统一修改并合并，然后你再拉取 main 继续。
- 需要调用其他模块的数据时，通过对方公开的接口或服务层调用，不直接读写对方的数据表。

### 3.4 分支与 PR
- 分支命名：feature/模块代号/简短描述（模块代号见第 6 节），例如 feature/wms/inbound-scan。
- 不直接推送到 main。所有改动走 PR，默认开草稿 PR。
- 小步提交：一个 PR 只做一件事，做完一小块就开 PR，不要让分支积压超过 2–3 天。
- 不合并别人的 PR，不修改别人的分支。
- PR 描述必须写：做了什么、改了哪些表或接口、如何测试、是否影响其他模块。

### 3.5 数据库
- 迁移文件只能由平台核心会话创建（见第 4 节）。
- 表名统一加模块前缀，避免撞名。前缀方案见下方 3.5.1（KC 2026-11-03 已批准）。
- 不删除和重命名已有字段；需要时先新增字段、迁移数据，再由 KC 批准后废弃旧字段。
- **金额字段规则（KC 2026-11-03 确定）**：
  - **交易金额**（订单、付款、退款、发票、应收应付、佣金等实际发生的钱）：用整数分。类型 `bigint`，字段名以 `_cents` 结尾，例如 `total_cents`、`unit_cents`。经销商模块的 `dealer_orders` 就是这样存的，可以参考。
  - **成本和定价计算**（出厂价、到岸成本、运费分摊、换汇后的成本、建议售价等需要中间精度的数）：用固定 4 位小数。类型 `numeric(18,4)`。
  - **每个金额字段都要有币种字段**：字段名用 `currency`；一行里有多个币种时用 `xxx_currency`。值用三位大写代码，目前只用 `USD`、`CNY`。不要再把币种写进字段名（例如不要再新建 `xxx_rmb`、`xxx_usd` 这样的字段）。
  - **已有字段不改**。下面这些是历史写法，继续用，但新字段不要照抄：产品/定价表里不限精度的 `numeric`、币种写在字段名里（如 `factory_rmb`、`landed_usd`），IT 订阅的 `cost numeric(14,2)`，CalDock 的 `amount_cents integer`。HR 薪资是加密存储，不受这条规则影响。

#### 3.5.1 表名前缀方案（KC 2026-11-03 已批准）

读 main 和未合并分支后的结论：main 上现有的 114 张表里，大部分已经按模块加了前缀，但有些前缀和第 6 节的模块代号不一样。按 3.5"不改名"的规则，**已有的表一律不改名**，前缀就沿用现在的。规则只有三条：

1. **新表的前缀 = 本模块已经在用的前缀**；模块还没有表的，用第 6 节的模块代号加下划线。
2. 前缀之后用英文复数名词，全小写加下划线，例如 `wms_movements`、`kol_profiles`。
3. 一张表只属于一个模块。别的模块要用这些数据，按 3.3 走接口或服务层，不直接读写别人的表。

| 模块 | 代号 | 新表用的前缀 | 现有的表（截至 2026-11-03） |
|---|---|---|---|
| 平台核心 | core | 不加前缀（仅限核心表，新增要 KC 批准）；OKR、任务、项目沿用 `okr_` `kr_` `task_` `project_` | `users` `sessions` `departments` `external_identities` `oauth_states` `audit_events` `user_avatars` `member_invites` `login_codes` `inbox_items` `text_translations` `notification_requests` `notification_deliveries`；OKR：`objectives` `key_results` `kr_appraisals` `kr_scores` `objective_scores` `measurements` `okr_updates` `okr_import_batches` `okr_source_records` `okr_publications`；任务：`tasks` `submissions` `reviews` `task_attachments` `task_completions` `task_nudges` `task_updates` `task_board_config` `task_board_personal` `task_board_views`；项目：`projects` `project_updates`；AI 评审：`ai_evaluations` `ai_review_jobs` `bot_dispatch_budgets` `bot_oauth_*`（7 张）；反馈：`feedback` |
| WMS 仓储管理（含退货与维修 RMA） | wms | `wms_`；RMA 沿用 `rma_` | `wms_items` `wms_stock` `wms_movements` `wms_imports`；RMA：`rma_cases` `rma_photos` `rma_events` |
| PIM 与定价 | pim | `product_`（**不是** `pim_`，沿用现有） | `product_catalog` `product_pricing` `product_imports` `product_changes` `product_channel_prices` `product_price_changes` `pricing_rules`（例外：没有 `product_` 前缀，不改名） |
| HRM 员工档案 | hrm | `hr_`（**不是** `hrm_`，沿用现有） | `hr_profiles` `hr_secrets` `hr_salary` `hr_documents` `hr_events` `hr_reminder_log` |
| 电子与资产管理 | asset | `it_`（IT 账号与订阅已经用了这个前缀）；实物资产等新表用 `asset_` | `it_accounts` `it_account_users` `it_flags` `it_checks` `it_reminder_log` |
| 客服系统 | support | `support_`；公开支持中心沿用 `public_wiki_` | `support_snapshots` `support_reviews` `support_reply_edits` `support_handovers` `support_knowledge_candidates` `support_knowledge_candidate_reviews` `public_wiki_*`（7 张） |
| KOL 自动化 ROI | kol | `kol_` | 未合并分支 `kol-phase1`：`kol_profiles` `kol_collabs` `kol_referrals` `kol_sync_state` |
| 经销商下单 portal | dealer | `dealer_` | `dealer_accounts` `dealer_identities` `dealer_sessions` `dealer_oauth_states` `dealer_orders` `dealer_order_lines` `dealer_order_events` `dealer_stripe_events` |
| AR/AP 应收应付 | arap | `arap_` | 还没有 |
| 企业网盘管理 | drive | `drive_` | 还没有 |
| 钉钉与企业微信接入 | im | `im_` | 还没有（钉钉登录用的 `external_identities` `oauth_states` 和通知用的 `notification_*` 属于 core 共享区域） |
| 数据与网络安全 | security | `security_` | 还没有 |
| 公司数据中心 / ERP | erp | `erp_`（只放缓存或快照，不放业务数据，见 6.1） | 还没有 |
| craftos 通用改进 | general | 不建表；需要表时先在第 7 节和对应模块协调 | — |
| 产品质量追踪 | quality | `quality_` | `quality_issues` `quality_plans` `quality_links` `quality_events` |
| CalDock（不属于 OneLaser 业务，待迁出） | caldock | 不新建表（暂停新增功能） | `caldock_*`（13 张）、`caldock_studio_*`（5 张） |

归属按 KC 2026-11-03 决定：RMA 归 wms；产品质量追踪单独成为 quality 模块；CalDock 不属于 OneLaser 业务，单独登记，待迁出到独立仓库。

### 3.6 安全与数据
- 不把任何密钥、token、密码写进代码、提交记录、日志或本文件。只使用环境变量。
- 测试只用虚构数据，不使用真实员工、客户、经销商、价格或成本数据。
- 不在前端暴露成本价、毛利、薪资等敏感字段，权限必须在后端校验，不能只靠前端隐藏。
- 发现安全问题（越权访问、密钥泄露、未校验的接口）时立即停下，在第 7 节登记并通知 KC。

### 3.7 沟通方式
- 每完成一个阶段（开 PR 或 PR 合并），更新第 6 节自己模块那一行，并在第 8 节变更日志顶部加一条。
- 只改自己模块的那一行和那一段，不改其他模块的内容，避免本文件本身产生合并冲突。
- 对其他模块有疑问或依赖时，写在第 7 节，不要猜测对方的实现。
- 对 KC 的汇报用中文，简洁直接，先说结论。

### 3.8 共享数据规则（最重要）
1. **SKU 只有一份**：所有模块都用 `product_catalog.sku`。不要另建产品表，也不要复制产品名称和价格。要扩展产品字段，由 pim 模块在 `products.ts` 里加。
2. **价格只有一个来源**：
   - MSRP 在 `product_catalog`；
   - 各渠道价格（经销商、Amazon 等）在 `product_channel_prices`；
   - 公司计价规则在 `pricing_rules`。具体比例属于第 5 节的受限数据，**不写进本文件、代码注释或测试**；测试里用虚构的比例。
3. **库存只有一份**：数量变化一律写 WMS 出入库流水（经销商发货、RMA 翻新入库都是这样），其他模块只读。
4. **人和权限只有一份**：用 `users` 和 `grants` 判断权限，不要另建账号体系。经销商和 CalDock 的客户是外部用户，属于例外。
5. **通知统一走一处**：站内红点用 `pushInbox()`（`src/inbox.ts`）；钉钉和邮件用 `src/app.ts` 里的 `notify`。
6. **敏感数据**：
   - 成本和利润只给有 `product_cost_detail` 权限的人和管理员（后端判断在 `src/products.ts`）。这个权限给谁，按第 5 节执行。
   - 薪资只给对应分区的 HR 权限人。
7. **工厂对接人**：标记为工厂对接人的账号只能用质量追踪，后端会拦截其他接口。
   - 标记方式：`users.quality_factory` 非空（邀请时选"工厂对接人"，或管理员在成员列表里改）。注意：截至 2026-11-04，这个字段的后端改动还没合并到 main，以合并后的实际字段为准。
   - 旧方式仍然有效：`WORKOS_QUALITY_FACTORY_DEPARTMENTS` 里部门的成员。
   - 面向全公司的流程（季度确认、全员提醒、统计人数等）要用 `src/quality.ts` 的 `factoryUserIds()` 把他们排除，IT 季度账号核对已经这样做了。

### 3.9 开发细则
- 改公共文件（前端 `live-app.js`、`changelog.js`、`index.html`；后端 `app.ts`、`db.ts`、`i18n.ts`）要小步修改，不要整段重写。按第 4 节，这些文件归 core。
- 前端改完先运行 `node tools/stamp-assets.mjs`（更新资源版本号），再运行 `npm test`；后端运行 `npm test`，大约需要 8–10 分钟。
- 后端所有报错文案都要在 `src/i18n.ts` 里有中文翻译，有测试会检查。
- 版本号：在前端 `dist/changelog.js` 的 `RELEASES` 最前面加一条，号码 = 当前最新版本 + 0.1。先拉取最新代码再看最新号，避免撞号。

### 3.10 部署规则（同一时间只能有一个会话部署）
1. 前端推送 main，记下 commit。
2. 后端先拉取最新代码，再把这个前端 commit 写进 `deploy/frontend-revision.txt`。新的前端 commit 必须包含之前已上线的前端提交（先拉取再取 HEAD），否则会把别人的功能回滚掉。
3. 后端推送 main，再推到部署分支 `codex/company-migration-live-20261102`。推之前确认部署分支是 main 的祖先。
4. 在 Render 点 Manual Deploy → Deploy latest commit，大约等 3 分钟。
5. 打开 https://craftos.app/build-info.json，确认 `frontendCommit` 等于第 1 步的 commit。核对之前不能说"已上线"。

---

## 4. 共享区域与负责人

以下区域被多个模块共用，只能由"平台核心"会话修改（侧边栏里名为 [WorkOS] 的会话）：

| 共享区域 | 内容 | 说明 |
|---|---|---|
| 数据库结构与迁移 | 所有迁移文件、核心表 | 其他模块提需求，平台核心统一出迁移 |
| 认证与权限（RBAC） | 登录、角色、权限点 | 新增权限点必须登记在第 5 节 |
| 侧边栏与路由 | 菜单、路由注册 | 按第 1 节的结构，变更需 KC 批准 |
| 公共组件与样式 | 通用 UI 组件、主题 | 模块内部组件放模块自己的目录 |
| 依赖与构建配置 | 依赖包、构建、lint 配置 | 新增依赖需在 PR 说明理由 |
| 部署与环境变量 | 部署配置、环境变量清单 | 与 Yongger 的发布流程对齐 |
| 通知与集成底座 | 消息推送、钉钉/企业微信底层连接 | 业务模块只调用，不改底座 |

平台核心会话的工作顺序：先补全第 2 节，再处理第 7 节里其他模块登记的共享区域需求。

---

## 5. 权限与敏感数据规则（KC 已确认）

| 数据 / 区域 | 可见范围 |
|---|---|
| 产品管理区（产品目录、成本核算、智能供应链） | 仅 KC、李帅、袁勇 |
| 成本和价格的计算方式 | 仅 KC、李帅 |
| HRM 美国区员工档案 | 仅 KC |
| HRM 中国区员工档案 | KC 指定的负责人【待 KC 指定】 |
| 集成与通知设置 | 仅管理员 |
| AR/AP、薪资相关数据 | 【待 KC 确认】 |
| 经销商下单 portal | 经销商只能看到自己的订单、价格和账期【待 KC 确认细则】 |

新增任何敏感数据或权限点，必须先登记在这里并经 KC 确认。

---

## 6. 模块登记表

状态取值：规划中 / 开发中 / 待 KC 审批 / PR 待合并 / 已上线 / 暂停

| 模块 | 代号 | 负责会话 | 目录【待填】 | 状态 | 依赖的共享改动 | 最后更新 |
|---|---|---|---|---|---|---|
| 平台核心 | core | [WorkOS] | `src/app.ts` `src/server.ts` `src/db.ts` `src/auth.ts` `src/domain.ts` `src/org.ts` `src/members.ts` `src/integrations/` `deploy/` `render.yaml` `Dockerfile` `CLAUDE.md` | PR 待合并（CLAUDE.md v1.1） | — | 2026-11-03 |
| WMS 仓储管理 | wms | [WorkOS] - WMS系统 |  | 开发中 |  | 2026-11-03 |
| 企业网盘管理 | drive | [WorkOS] - 企业网盘管理 |  | 开发中 |  | 2026-11-03 |
| KOL 自动化 ROI | kol | [WorkOS] - KOL自动化ROI系统 |  | 开发中 |  | 2026-11-03 |
| 经销商下单 portal | dealer | [WorkOS] - 经销商下单portal |  | 开发中 |  | 2026-11-03 |
| 电子与资产管理 | asset | [WorkOS] - 电子&资产管理 |  | 开发中 |  | 2026-11-03 |
| 客服系统 | support | [WorkOS] - 客服系统 |  | 开发中 |  | 2026-11-03 |
| PIM 与定价 | pim | [WorkOS] - PIM & 定价系统 |  | 开发中 |  | 2026-11-03 |
| AR/AP 应收应付 | arap | [WorkOS] - AR/AP |  | 开发中 |  | 2026-11-03 |
| 数据与网络安全 | security | [WorkOS] - 数据与网络安全 |  | 开发中 |  | 2026-11-03 |
| 公司数据中心 / ERP 仪表板 | erp | [WorkOS] 公司数据中心 ERP 仪表板 |  | 开发中 |  | 2026-11-03 |
| 钉钉与企业微信接入 | im | 接入钉钉与企业微信 |  | 开发中 |  | 2026-11-03 |
| craftos 通用改进 | general | craftos.app 改进 |  | 开发中 |  | 2026-11-03 |
| HRM 员工档案 | hrm | 【未开会话】 |  | 规划中 |  | 2026-11-03 |
| 产品质量追踪 | quality | 【未开会话】 | `src/quality.ts`；前端 `dist/quality.js` | 已上线 |  | 2026-11-03 |
| CalDock（不属于 OneLaser 业务） | caldock | 【未开会话】 | `src/caldock*.ts`；前端另有 CalDock 仓库，用 `deploy/caldock-revision.txt` 固定 | 暂停：待迁出到独立仓库，暂时不要新增功能 |  | 2026-11-03 |

各会话首次读到本文件时，把自己那一行的"目录"和"状态"改成真实情况。

### 6.1 模块要点（每个会话只维护自己的条目）

**core 平台核心**：负责第 4 节的全部共享区域；首要任务是补全第 2 节，并确认表名前缀和金额存储方案。

**wms 仓储管理**：范围【待填】。退货与维修 RMA 归本模块（KC 2026-11-03），代码在 `src/rma.ts`、前端 `dist/rma.js`。与 pim（SKU 主数据）、dealer（出库订单）有数据依赖，SKU 以 pim 为唯一来源，不在 wms 里另建 SKU 表。

**drive 企业网盘管理**：范围【待填】。如涉及钉钉网盘（钉盘）的文件同步，底层连接走 im 模块提供的接口。

**kol KOL 自动化 ROI**：范围【待填】。广告与销售数据如来自外部平台，只读不写；ROI 计算口径写在本条目里，供 erp 仪表板引用。

**dealer 经销商下单 portal**：范围【待填】。经销商是外部用户，权限隔离是第一优先级；价格取自 pim，不得在本模块硬编码价格。

**asset 电子与资产管理**：范围【待填】。

**support 客服系统**：包括客服工作台和知识中心/Wiki。KC 的路线：公开支持中心（可搜索 Wiki、客户提问、员工审核后发布标准答案、带评分）先在 craftos.app 上线，之后迁移到 Shopify 官网 1laser.com 的支持页面，所以内容结构要便于导出和迁移。

**pim PIM 与定价**：产品目录是 SKU 的唯一来源。每个 SKU 覆盖全生命周期属性（如 HS 编码、主机/配件类型、成本、毛重、随附配件等）。成本和定价逻辑属于第 5 节的受限数据。

**arap 应收应付**：范围【待填】。金额字段遵守 3.5 节规定，注明币种。

**security 数据与网络安全**：负责审查其他模块的权限校验、密钥管理和日志脱敏；发现问题时在第 7 节登记，不直接改其他模块的代码。

**erp 公司数据中心 / ERP 仪表板**：只读汇总其他模块的数据，不反向写入。指标口径引用各模块条目里的定义，不自己另算。

**im 钉钉与企业微信接入**：提供通知与消息的底层接口，供其他模块调用；业务逻辑留在各模块。

**general craftos 通用改进**：处理不属于以上任何模块的小改进；如果改动碰到某个模块，先在第 7 节和该模块协调。

**hrm 员工档案**：规划中。员工档案和资料分美国区、中国区存放，访问权限完全分开（见第 5 节）。

**quality 产品质量追踪**：KC 2026-11-03 决定单独成为一个模块。已上线（侧边栏"产品开发测试区"）。工厂对接人只能使用本模块（怎么判断见 3.8 第 7 条），这个限制在 `src/app.ts` 的登录拦截里，属于 core。范围【待填】。

**caldock CalDock**：不属于 OneLaser 业务（KC 2026-11-03）。待迁出到独立仓库，**暂时不要新增功能**，只允许修安全问题和线上故障。迁出前不要让 OneLaser 的模块依赖它的表或接口。

---

## 7. 跨模块需求与待 KC 决策

格式：日期｜提出模块 → 目标模块或 KC｜事项｜状态（待处理 / 处理中 / 已完成）

- 2026-11-03｜core → KC｜确认各模块的业务范围，补全第 6.1 节的"【待填】"｜待处理
- 2026-11-03｜core → KC｜确认 AR/AP 与经销商 portal 的权限细则（第 5 节）｜待处理
- 2026-11-03｜core → KC｜指定 HRM 中国区负责人｜待处理
- 2026-11-03｜core → KC｜批准 3.5.1 表名前缀方案，特别是：pim 沿用 `product_`、hrm 沿用 `hr_`、asset 沿用 `it_`（都不改名）｜已完成：KC 已批准
- 2026-11-03｜core → KC｜产品质量追踪（`quality_`）、退货与维修 RMA（`rma_`）、CalDock（`caldock_`）在第 6 节没有对应模块，请指定归属｜已完成：RMA 归 wms；质量追踪新开 quality 模块；CalDock 单独登记，待迁出到独立仓库，暂停新增功能（见第 6 节）
- 2026-11-03｜core → KC｜金额存储方式（3.5）：现在有三种写法——CalDock 用整数分（`amount_cents integer` + `currency`），IT 订阅用 `numeric(14,2)` + `currency`，产品/定价用不限精度的 `numeric`、币种写在字段名里（如 `factory_rmb`、`landed_usd`）；HR 薪资是加密文本。请定新字段统一用哪种；已有字段按 3.5 不改｜已完成：交易金额用整数分，成本和定价计算用 4 位小数，都要带币种字段，已写进 3.5
- 2026-11-03｜core → KC｜第 1 节的侧边栏和代码不一致｜已处理：按 KC 决定，第 1 节已改成线上代码的样子；具体差异拆成下面几条，等 KC 审批
- 2026-11-03｜core → KC｜侧边栏差异 1：原描述的"产品管理区"在代码里叫"产品+供应链"，第一项叫"产品与库存"（原描述是"产品管理"）｜待 KC 审批
- 2026-11-03｜core → KC｜侧边栏差异 2：原描述的"任务中心"在代码里叫"个人任务"；"OKR"在代码里叫"OKR 目标"｜待 KC 审批
- 2026-11-03｜core → KC｜侧边栏差异 3：代码在"产品+供应链"里多了"ERP 权限"（给成员分配产品、仓库等权限的页面）｜待 KC 审批
- 2026-11-03｜core → KC｜侧边栏差异 4（涉及第 5 节权限）：第 5 节说产品管理区"仅 KC、李帅、袁勇"可见，但代码里所有负责人（manager）都能看到"产品与库存"（只读库存）和"ERP 权限"（只能给自己的下属分配仓库权限）。后端也是这样判断的：`src/wms.ts` 的 `warehouseLevelFor` 和 `/erp/access`。成本核算、智能供应链、产品目录和成本数据，后端都要求 `products` 权限或管理员，这部分和第 5 节一致。谁实际持有 `products` 权限要看线上数据，我连不上生产库，查不了。请 KC 确认：负责人看库存和分配仓库权限是否允许｜待 KC 审批
- 2026-11-03｜core → KC｜侧边栏差异 5：代码多了"其他"分区（个人设置、组织架构、人事档案、IT 账号与订阅、组织与权限、Bug 与建议、版本更新），原描述没有这个分区｜待 KC 审批
- 2026-11-03｜core → KC｜侧边栏差异 6：前端仓库最新代码已经加了"营销"分区（KOL 管理），还没上线；按第 1 节规则，新分区要先经 KC 批准，请确认位置｜待 KC 审批
- 2026-11-04｜core → KC｜**敏感数据外露**：2026-11-04 05:14 UTC，另一个会话把规则草稿直接推到了两个公开仓库的 main（后端 `a37bab8`、前端 `e49dda2`），没有走 PR。草稿里有公司计价比例，按第 5 节属于受限数据。PR #18 合并后，文件当前版本里就没有这些比例了，但 **git 历史里仍然能看到**。要彻底清除，需要改写两个仓库的 main 历史，这会影响所有会话，请 KC 决定：接受现状，还是改写历史（或者把仓库改成私有）｜待 KC 决定
- 2026-11-04｜core → pim、dealer｜经销商渠道价现在是人工填写，应改为按 `pricing_rules` 的批发规则自动给出建议价，再走价格审批（来源：KC 2026-11-04 提供的规则草稿）｜待处理
- 2026-11-03｜core → Yongger｜`render.yaml` 写的是服务 `onelaser-workos`、分支 `main`、通过检查后自动部署，但线上实际是 `onelaser-workos-migration`、跟踪 `codex/company-migration-live-20261102`、自动部署关闭。是否要改 `render.yaml` 和线上保持一致？｜处理中：KC 去和 Yongger 确认

---

## 8. 变更日志（最新的写在最上面）

格式：日期｜模块｜做了什么｜涉及的表或接口｜PR 链接

- 2026-11-04｜core｜v1.2 补充：并入另一个会话在前端 main（`50fc7d9`，v1.30）直接加的"工厂对接人"规则，放在 3.8 第 7 条，并注明 `users.quality_factory` 的后端改动还没合并｜只改本文件｜PR #18
- 2026-11-04｜core｜v1.2：并入 KC 2026-11-04 提供的规则草稿（另一个会话已在 05:14 UTC 把草稿原样直接推到了两个仓库的 main，本版本替换它）——第 2 节加模块与代码文件对照；新增 3.8 共享数据规则、3.9 开发细则、3.10 部署规则；3.1 加推送前拉取；文件开头注明仓库公开。计价比例按第 5 节不写入；草稿里"两个仓库各自修改"改为按 v1.1 的主版本加同步｜只改本文件｜PR #18
- 2026-11-03｜core｜v1.1：按 KC 决定更新——前缀方案已批准；RMA 归 wms，新增 quality 模块，CalDock 单独登记并暂停；3.5 写入金额规则；第 1 节侧边栏按线上代码更新，6 处差异登记在第 7 节；补全第 1 节仓库名和主分支；前端仓库放只读副本｜只改本文件｜PR #18
- 2026-11-03｜core｜放入仓库根目录；补全第 2 节（技术栈、目录、命令、环境变量、发布方式）和 3.5.1 表名前缀方案；第 7 节登记 5 项待决定事项｜只改本文件，不涉及表或接口｜草稿 PR（链接见 PR 页面）
- 2026-11-03｜core｜建立本文件 v1.0｜—｜—
