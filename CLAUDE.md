# OneLaser WorkOS（craftos.app）— 所有 Claude Code 会话必读

这份文件放在两个仓库的根目录（onelaser-workos 前端、onelaser-workos-api 后端），内容相同。
新增模块、新增共享数据表或改了下面任何约定，必须在同一个提交里更新这份文件（两个仓库都改）。

产品名统一叫 **WorkOS**（不再用 CraftOS）；正式域名仍是 craftos.app，不要改域名。

仓库是公开的：这里和代码里都不能出现密钥、真实成本、真实库存、员工薪资或任何客户数据。

## 1. 系统结构

- 前端 `Hydrax91129/onelaser-workos`：`dist/` 下的原生 JS，无构建步骤。`dist/live-app.js` 是外壳（导航、顶栏、任务抽屉），
  各模块是独立文件，挂在 `window.WorkOSXxx` 上，由 live-app 的 `render()` 调用 `configure()` 注入 api、state、lang 等。
- 后端 `Hydrax91129/onelaser-workos-api`：Fastify + TypeScript，PostgreSQL（本地测试用 PGlite），参数校验用 zod。
  每个模块一个文件，导出 `xxxSchema`（建表 SQL，汇总到 `src/db.ts` 的 `schema`）和 `registerXxxRoutes`（在 `src/app.ts` 注册）。
- AI（翻译、OKR 起草、成果评分）：设了 `ANTHROPIC_API_KEY` 就用 Claude（`ANTHROPIC_MODEL`，默认 `claude-haiku-5-5`，completions.ts 的 `claudeModel`）；
  没设时沿用 xAI（`AI_PROVIDER_API_KEY` / `XAI_API_KEY` 和 `AI_*_MODEL_ID`）。Wiki 助手和 Grok Bot 仍走 xAI。
- 上线：后端仓库 `deploy/frontend-revision.txt` 写死前端的 commit，Docker 构建时拉取这个版本的前端。线上服务在 Render（onelaser-workos-migration）。

## 2. 模块地图（谁负责什么数据）

| 子功能 | 后端 | 前端 | 拥有的数据（只有这个模块能写） |
| --- | --- | --- | --- |
| 账号、组织、权限 | auth.ts, org.ts, members.ts | people.js, erp-access.js | users（含第一领导 manager_id、第二领导 second_manager_id，两者权限相同）、departments、grants（功能权限） |
| 任务、OKR、项目 | app.ts, task-board.ts, completions.ts, assign.ts, okr*.ts, projects.ts | task-board.js, okr-board.js, projects.js, reports.js | tasks、submissions、reviews、objectives、key_results、projects、project_files（项目附件）、project_activity（项目动态） |
| 消息红点 | inbox.ts | inbox.js | inbox_items（其他模块只调用 `pushInbox()`，不要自建通知表） |
| PIM 与定价 | products.ts, product-spec.ts（产品资料库字段模型）, product-library.ts, product-worksheet.ts（定价工作表）, product-import.ts（标准模板、上传预览、确认、撤销）, xlsx.ts | products.js, product-library.js | product_catalog（SKU 主数据、MSRP；产品族 family、大货/退货 goods_type、退货 SKU refb_sku（以 REF- 开头，和退货登记 RMA 用同一规则），其余规格字段在 attrs）、product_pricing（成本输入；供应商在 attrs）、pricing_rules（公司计价规则；价格参数在 worksheet 列，仓库里不放真实数值）、product_channel_prices（各渠道价格及审批；MAP=map、官网促销底价=promo_floor、批发档手动价=wh0…）、product_files（产品主图和文件栏位）、product_imports / product_import_previews（批量更新记录与预览，只有主管理员能上传和确认） |
| WMS 库存 | wms.ts | wms.js | WMS 库位与出入库流水 |
| 退货维修 RMA | rma.ts | rma.js | rma_cases（登记退货只记录退货和收货照片，是否可维修、维修人员在维修环节填；翻新机入库走 WMS；状态：等待维修 → 等待配件（填等待什么配件）→ 完成维修 → 已入库待上架 → 完成上架 → 售出，见 rma.ts 的 `stageOf`；入库时按成色定折扣：A 品原封不动当新货、不打折，B 品 10% off，C 品 20% off（`GRADE_DISCOUNT`）；标记售出自动写 WMS 出库，撤销售出写回） |
| 经销商下单 portal | dealer.ts, dealer-admin.ts | dealers.js | dealer_accounts、dealer_orders（价格读 product_channel_prices 的 dealer 渠道，发货走 WMS 出库） |
| 客服 | support.ts, shopify.ts | company-support.js | 工单、客服回复 |
| HRM | hr.ts | hr.js | hr_profiles（含所属地区 region：us / cn / intl，地区资料 details）、hr_secrets（SSN、身份证号、银行账号、当地税号、薪酬与税务，均加密）、hr_salary、hr_documents、hr_events。按地区授权，见第 3 节第 6 条 |
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
   汇报线：每个人有一个第一领导 `users.manager_id`，可选一个第二领导 `users.second_manager_id`（虚线汇报）。**两位领导对这个人的权限完全相同**
   （查看、验收、OKR 领导评分、审批、调整截止时间、HR 下属范围，也包括 TA 下面的团队）：判断"谁是领导/谁能看"时两条线都要算，
   用 domain.ts 的 `leaderChildren`、`attachReportingScope`（`visibleOwnerIds` 已含两条线）或 org.ts 的 `reportsOf`，不要只读 `manager_id`。
   只有"默认指派给谁"（新任务的默认验收人、需要谁去做的提醒）仍按第一领导，避免重复。`user.dottedOwnerIds` 只是界面上区分"虚线汇报给我"用。
5. **通知统一走一处**：站内红点用 `pushInbox()`；钉钉和邮件用 app.ts 里的 `notify`。
6. 成本和利润只给有 `product_cost_detail` 权限的人和主管理员（部署配置 `WORKOS_EXECUTIVE_USER_IDS`）；在系统里勾选的管理员**不会**自动看到产品、成本、价格、库存、经销商数据，也要单独授权。功能权限（grants）只有主管理员能改，任何人都不能改自己的。薪资只给 HR 权限对应分区的人。后端新模块判断敏感数据时用 `isExecutive`，不要用 `isAdmin`。
   产品资料库的可见级别（product-spec.ts 的 `viewerOf`，服务器端过滤所有接口、文件下载、修改记录和导出模板）：
   全员 = 所有登录员工（工厂对接人除外）；产品与供应链 = `products`；仅成本权限、敏感 · 仅编辑者 = `product_cost_detail`；仅管理员 = 主管理员。
   修改：产品字段要 `products_manage`，成本/敏感字段和文件要 `product_cost_detail`，MSRP/MAP/促销底价沿用 MSRP 规则；价格参数只有主管理员能改。
   人事档案按地区：美国区只有主管理员（`WORKOS_EXECUTIVE_USER_IDS`）能看能改，没有授权项；中国、海外其他地区用 grants 里的
   `hr_cn_view` / `hr_cn_manage`、`hr_intl_view` / `hr_intl_manage`（只读 / 可管理）逐人授权，只有主管理员能分配。`WORKOS_HR_USER_IDS` 不再给任何权限。
   停用账号（members.ts）会在同一事务里调用 hr.ts 的 `hrMarkLeft`，把人事档案改为已离职、最后工作日取停用日期并记一条离职记录；恢复账号调用 `hrMarkReturned` 改回在职。反过来，把人事状态改为已离职不会停用账号。
   员工所属地区只有主管理员能改。有权限的人看到完整资料（数据库里加密保存）。员工本人只看自己的基本雇佣信息，自助填写个人资料是第二期。
   婚姻、子女、受抚养人和 EEO 只放在加密字段里，只能用于 payroll、福利和合规统计，不能用于聘用决定。
7. **工厂对接人**：`users.quality_factory` 非空（邀请时选“工厂对接人”，或管理员在成员列表里改）的账号只能用质量追踪，后端会拦截其他接口。
   面向全公司的流程（季度确认、全员提醒、统计人数等）要用 quality.ts 的 `factoryUserIds()` 把他们排除。
8. **任务删除是软删除**：`tasks.archived_at` 非空表示已删除（批量删除/撤销在 task-board.ts 的 `/tasks/batch-archive`、`/tasks/batch-restore`）。任何模块读 tasks 做列表、统计、提醒、排行榜都要加 `archived_at IS NULL`；按 id 取单条任务用 `visibleTask()`，它已把已删除任务当作不存在。
9. **点完成就算完成**：负责人点“完成”（`/tasks/:id/complete`）任务马上算完成，别人派的任务也一样，不再等验收。
   评分是可选的：验收人、派任务的人、直属领导或管理员 24 小时内可打 0–10 分，没人打分时由 AI 评分；
   人打分低于 5 分（completions.ts 的 `LOW_SCORE`）任务退回未完成（status `revision`），负责人改完再点完成。
   旧的“提交 / 验收”接口（submissions、reviews）保留给机器人和老数据用，网页不再用它来完成任务。

## 4. 开发规则（所有改动都走 PR）

- **不直接推 main**（分支保护会拒绝）：在 `claude/<简短描述>` 分支上开发，推送后开 PR 到 `main`。
  PR 必须基于最新 `main`、CI 通过才能合并；合并前如果 `main` 有新提交，先 `git pull --rebase origin main` 再推。
- 前端改完运行 `node tools/stamp-assets.mjs`（更新资源版本号，CI 会检查），再 `npm ci && npm test`；后端 `npm test`（约 8 分钟）。
- 后端所有报错文案都要在 i18n.ts 里有中文（有测试检查）。
- 上传文件统一用前端的 `dist/upload-zone.js`（`window.WorkOSUpload`）：一个框同时支持粘贴、拖拽、点击选择和“上传”按钮，
  只负责收文件和检查类型、大小，存储和权限仍由各模块自己的接口负责。新功能不要再自己写一套上传。
- 版本号：在 dist/changelog.js 的 RELEASES 最前面加一条，号码 = 当前最新版本 + 0.1，date 要晚于上一版。
- 只用虚构的示例数据写测试和种子数据。
- **发布前预览**：后端仓库 `npm run preview`（tools/preview-local.ts）在 http://localhost:4174 起一个完整的 WorkOS，前端取自旁边的
  `../onelaser-workos/dist`，数据库在内存里、每次启动重置，填好虚构的人员、人事档案（三个地区，含一位已离职）、产品、经销商价和库存。
  登录：owner@workos.test（主管理员）、hr@workos.test（中国 / 海外 HR）、staff@workos.test（普通员工），密码 workos-preview。
  改了页面的 PR，合并前先用它跑一遍、截图给用户确认；新模块要用的示例数据也加在这个文件里。
- **测试站**：用户在 Render 上另建的服务（和正式服务 onelaser-workos-migration、正式数据库完全分开），用 `Dockerfile.preview`
  构建 `claude/preview` 分支：只有内存里的虚构数据，登录密码是那个服务上的 `PREVIEW_PASSWORD`（不写进仓库），页面底部有“测试站”标记。
  给用户预览时：把后端 PR 的提交推到 `claude/preview`，要预览的前端提交写进 `deploy/preview-frontend-revision.txt`。
  `claude/preview` 永远不合进 `main`；第 5 节对正式服务的规则不变。

## 5. 上线规则（全自动，任何会话都不手动部署）

上线只有一条路：**代码合进 `main` → CI 通过 → 自动部署**。

1. 前端 PR 合进前端 `main` 后，GitHub Action（`.github/workflows/pin-frontend.yml`）会自动在后端仓库开一个 PR（分支 `auto/pin-frontend`），
   把 `deploy/frontend-revision.txt` 改成这个提交；后端 CI 通过后自动合并（没有自动合并时，CI 通过后可手动合）。不要手动改 `frontend-revision.txt`。
   先合后端、再合前端，避免页面先于接口上线。
2. 后端 `main` 有新提交且 CI 通过后，Render 自动部署 `main`（Auto-Deploy：After CI checks pass）。
3. **禁止**：在 Render 点手动部署、通过 API 触发部署、修改 Render 服务的分支或其他设置、部署不在 `main` 上的提交、强推任何不属于自己的分支。
   需要改环境变量或 Render 设置时，请用户本人在 Render 后台操作。
4. 核对上线：打开 https://craftos.app/build-info.json，`frontendCommit` 等于（或包含）你的前端提交才算上线。没核对之前不能说"已上线"。
5. 线上出问题需要回滚：在 `main` 上用 `git revert` 撤销有问题的提交并走 PR，不要部署旧分支（旧分支会把别人已上线的功能一起回滚掉）。
