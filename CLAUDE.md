# OneLaser WorkOS（craftos.app）— 所有 Claude Code 会话必读

这份文件放在两个仓库的根目录（onelaser-workos 前端、onelaser-workos-api 后端），内容相同。
每个 Claude Code 会话开始工作前都会自动读到它。**多个会话在同时开发不同子功能，彼此看不到对方的对话**，
这里是唯一的共同约定。新增模块、新增共享数据表或改了下面任何约定，必须在同一个提交里更新这份文件（两个仓库都改）。

仓库是公开的：这里和代码里都不能出现密钥、真实成本、真实库存、员工薪资或任何客户数据。

## 1. 系统结构

- 前端 `Yonge6/onelaser-workos`：`dist/` 下的原生 JS，无构建步骤。`dist/live-app.js` 是外壳（导航、顶栏、任务抽屉），
  各模块是独立文件，挂在 `window.WorkOSXxx` 上，由 live-app 的 `render()` 调用 `configure()` 注入 api、state、lang 等。
- 后端 `Yonge6/onelaser-workos-api`：Fastify + TypeScript，PostgreSQL（本地测试用 PGlite），参数校验用 zod。
  每个模块一个文件，导出 `xxxSchema`（建表 SQL，汇总到 `src/db.ts` 的 `schema`）和 `registerXxxRoutes`（在 `src/app.ts` 注册）。
- 上线：后端仓库 `deploy/frontend-revision.txt` 写死前端的 commit，Docker 构建时拉取这个版本的前端。线上服务在 Render（onelaser-workos-migration）。

## 2. 模块地图（谁负责什么数据）

| 子功能 | 后端 | 前端 | 拥有的数据（只有这个模块能写） |
| --- | --- | --- | --- |
| 账号、组织、权限 | auth.ts, org.ts, members.ts | people.js, erp-access.js | users、departments、grants（功能权限） |
| 任务、OKR、项目 | app.ts, task-board.ts, completions.ts, assign.ts, okr*.ts, projects.ts | task-board.js, okr-board.js, projects.js, reports.js | tasks、submissions、reviews、objectives、key_results、projects |
| 消息红点 | inbox.ts | inbox.js | inbox_items（其他模块只调用 `pushInbox()`，不要自建通知表） |
| PIM 与定价 | products.ts | products.js | product_catalog（SKU 主数据、MSRP）、product_pricing（成本输入）、pricing_rules（公司计价规则）、product_channel_prices（各渠道价格及审批） |
| WMS 库存 | wms.ts | wms.js | WMS 库位与出入库流水 |
| 退货维修 RMA | rma.ts | rma.js | rma_cases（翻新机入库走 WMS） |
| 经销商下单 portal | dealer.ts, dealer-admin.ts | dealers.js | dealer_accounts、dealer_orders（价格读 product_channel_prices 的 dealer 渠道，发货走 WMS 出库） |
| 客服 | support.ts, shopify.ts | company-support.js | 工单、客服回复 |
| HRM | hr.ts | hr.js | hr_profiles、hr_salary、hr_documents（美国/中国分区权限） |
| IT 账号与资产 | it-accounts.ts | it.js | it_accounts |
| 质量追踪 | quality.ts | quality.js | quality_issues、quality_plans |
| KOL ROI | — | kol.js | （待补充） |
| Bug 与建议、版本记录 | feedback.ts | feedback.js, changelog.js | feedback |
| CalDock（Mac mini 托管） | caldock*.ts | 独立前端仓库 | caldock_*，与 WorkOS 用户完全隔离 |

## 3. 共享数据规则（最重要）

1. **SKU 只有一份**：所有模块都用 `product_catalog.sku`。不要另建产品表、不要复制产品名称和价格。要扩展产品字段，在 products.ts 里加。
2. **价格只有一个来源**：MSRP 在 product_catalog；各渠道价格（经销商、Amazon 等）在 product_channel_prices；
   公司计价规则在 pricing_rules（零售 17%、批发 7%、MSRP 30/40/50%、批发按 MSRP 打 25%/30%，单笔超 $5 万再加 2 点、超 $10 万再加 5 点）。
   **待对齐**：经销商渠道价目前是人工填写，应改为按 pricing_rules 的批发规则自动建议、再走价格审批。
3. **库存只有一份**：数量变化一律写 WMS 出入库流水（经销商发货、RMA 翻新入库都是这样），其他模块只读。
4. **人和权限只有一份**：用 users 和 grants 判断权限，不要另建账号体系（CalDock 和经销商是外部客户，例外）。
5. **通知统一走一处**：站内红点用 `pushInbox()`；钉钉和邮件用 app.ts 里的 `notify`。
6. 成本和利润只给有 `product_cost_detail` 权限的人和主管理员（部署配置 `WORKOS_EXECUTIVE_USER_IDS`）；在系统里勾选的管理员**不会**自动看到产品、成本、价格、库存、经销商数据，也要单独授权。功能权限（grants）只有主管理员能改，任何人都不能改自己的。薪资只给 HR 权限对应分区的人。后端新模块判断敏感数据时用 `isExecutive`，不要用 `isAdmin`。
7. **工厂对接人**：`users.quality_factory` 非空（邀请时选“工厂对接人”，或管理员在成员列表里改）的账号只能用质量追踪，后端会拦截其他接口。
   面向全公司的流程（季度确认、全员提醒、统计人数等）要用 quality.ts 的 `factoryUserIds()` 把他们排除。

## 4. 开发规则

- 开工前、推送前都要 `git pull --rebase`：其他会话随时在推送代码。
- 改公共文件（live-app.js、changelog.js、index.html、app.ts、db.ts、i18n.ts）要小步修改，不要整段重写。
- 前端改完运行 `node tools/stamp-assets.mjs`（更新资源版本号），再 `npm test`；后端 `npm test`（约 8 分钟）。
- 后端所有报错文案都要在 i18n.ts 里有中文（有测试检查）。
- 版本号：在 dist/changelog.js 的 RELEASES 最前面加一条，号码 = 当前最新版本 + 0.1（先 pull 再看最新号，避免撞号）。
- 只用虚构的示例数据写测试和种子数据。

## 5. 部署规则（同一时间只能一个会话部署）

1. 前端推送 main，记下 commit。
2. 后端：先 pull，把这个 commit 写进 `deploy/frontend-revision.txt`。新的前端 commit 必须包含之前已上线的前端提交（先 pull 再取 HEAD），否则会把别人的功能回滚掉。
3. 后端推送 main，再推到部署分支 `codex/company-migration-live-20261102`（推之前确认部署分支是 main 的祖先）。
4. 在 Render 点 Manual Deploy → Deploy latest commit，等约 3 分钟。
5. 打开 https://craftos.app/build-info.json，确认 frontendCommit 等于第 1 步的 commit 才算上线。没核对之前不能说"已上线"。
