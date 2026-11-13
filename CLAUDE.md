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
| PIM 与定价 | products.ts, product-spec.ts（产品资料库字段模型）, product-library.ts, product-worksheet.ts（定价工作表）, product-import.ts（标准模板、上传预览、确认、撤销）, xlsx.ts | products.js, product-library.js | product_catalog（SKU 主数据、MSRP；所有价格最多两位小数，如 27.09（product-spec.ts 的 `toCents`，products.ts 的 `money`）；必填 = 产品基本参数里除 UPC/EAN/GTIN、产品主图和产品线 / 系列（2026-11-13 起选填，单选）以外的字段，加上到岸价、尾程运费（product-spec.ts 的 `REQUIRED`、`minReq`），退货产品必填退货 SKU，其余选填；删除产品（product-library.ts 的 `DELETE /products/library/:sku`，产品资料“管理信息”或主管理员）：SKU 已用在库存、出入库、经销商订单、采购单、货柜、退货、质量问题里的不能删（提示改“停售”），产品自己的价格、渠道价、文件和空库存行一起删，记审计 `products.deleted`；“型号”字段已去掉；产品资料是一个单页（没有子页签），分组按显示顺序：1 基本参数、2 生命周期、3 定价（只填到岸价、尾程运费、MSRP 三个数）、4 包装物流、5 供应商、6 产品详情、7 售后与库存（`GROUPS` 的 `disp`，存储用的 `no` 不变），右上角依次是 新建产品、批量更新、下载标准模板、导入记录、产品资料权限（有权设权限的人可见，打开 `#erp-access/products`）；“定价”页是同一个产品资料库的定价模式（product-library.js 的 `render('pricing')`：基本信息可以直接改（权限同产品资料）、到岸价 + 尾程运费、每个 SKU 可填自己的零售 / 批发销售费率（`dtcRate` / `whRate`，留空用价格参数的公司费率，`skuRate`）、NPCR 计算，改 MSRP 就是改 product_catalog 的 MSRP；主管理员在这里点“价格参数（NPCR）”改价格参数）；产品族 family、大货/退货 goods_type、退货 SKU refb_sku（以 REF- 开头，和退货登记 RMA 用同一规则），其余规格字段在 attrs）、product_pricing（成本输入；供应商在 attrs）、pricing_rules（公司计价规则；价格参数在 worksheet 列，仓库里不放真实数值）、product_channel_prices（各渠道价格及审批；MAP=map、官网促销底价=promo_floor、批发档手动价=wh0…）、product_files（产品主图和文件栏位）、product_imports / product_import_previews（批量更新记录与预览：主管理员、产品资料“管理信息”和价格“管理”的人能上传和确认（product-spec.ts 的 `canBulkImport`）；能改哪些列仍按各自的字段权限，没权限的列内容不变就忽略、改了就报错；非主管理员只能撤销自己的批量更新） |
| 财务 Finance（应收账款 AR；应付 AP 待做） | finance.ts | finance.js | fin_receivables（一张发票一条：负责人、开票日、账期与到期日、客户公司（选填，列表为空时显示联系人）、联系人姓名 / 邮箱 / 电话（必填；美国电话存成 +1 加 10 位）、收货地址（街道、地址行2 选填、城市、州、邮编、国家，默认 US；美国地址只查格式：州两位缩写、邮编 5 位或 5+4 位，不接地址核对服务；规则在 finance.ts 的 `checkContact`）、类型、订单号、金额、是否发货、付款方式）、fin_payments（收款记录：已到账 cleared / 支票已存待到账 deposited）、fin_files（发票附件）、fin_notes（跟进记录）。状态由收款算出：未收款 / 部分收款 / 支票已存待到账 / 已收清；待收 = 金额 − 已到账；逾期 = 没收清且过了到期日。权限见第 3 节第 6 条 |
| WMS 库存 | wms.ts | wms.js | WMS 库位与出入库流水（只管常规库存，库位：美国LA仓 us、东莞工厂仓 dg、济南工厂仓 jn、在途运输中 transit；没有退货仓，REF- 退货 SKU 不显示、不能出入库；产品资料 product_catalog 里的 SKU 就是库存 SKU：没动过库存的按 0 列出，第一次出入库或经销商发货扣库存时由 wms.ts 的 `adoptCatalogItems` 补进 wms_items，不用再“新增 SKU”；货架库位 wms_bins：每个 SKU 在每个仓库一个首选库位 + 两个备选库位，库存数量仍按仓库记；库位清单 wms_bin_codes（“库位管理”：新增、改名时 SKU 跟着改、有货不能删，`/wms/bin-codes*`）；盘点调整要由另一位有库存管理权限的人确认，没有就由主管理员确认，页面写出可以确认的人（`confirmersOf`）；“到港入仓”逐行确认 SCM 发来的到港货柜（`/wms/arrivals`，在 scm.ts）；每条流水有操作日期 op_date（必填，默认当天），操作方式由同一事务的行数推出：手动 / 批量 / 期初导入 / 经销商发货；入库、出库、调拨、盘点都走 `/wms/movements/batch`，一次可以多个 SKU；库存表从产品资料带出中英文名、产品族、系列、MSRP、主图） |
| 退货维修 RMA | rma.ts | rma.js | rma_cases（退货维修自成一块，不写常规库存：已入库待上架 / 完成上架 / 售出都只是 rma_cases 的阶段；登记退货只记录退货和收货照片，是否可维修、维修人员在维修环节填；状态：等待维修 → 等待配件（填等待什么配件）→ 完成维修 → 已入库待上架 → 完成上架 → 售出，见 rma.ts 的 `stageOf`；入库时按成色定折扣（2026-11-12 老板定）：A 全新不打折，B 开箱品 5% off，C 开箱有使用痕迹 10% off，D 一般二手 15% off，E 有损伤但功能正常 20% off（`GRADE_DISCOUNT`；旧的 B 10% / C 20% 由 `migrateRmaGrades` 按当时折扣改成 C / E，只跑一次）；照片可删除：库存管理的人删任何照片，维修人员只删自己上传的，处理记录留一条；收货日期不能早于 2000 年，管理员可改） |
| 供应链 SCM（决策看板） | scm.ts | scm.js | scm_sales_daily（Shopify 每个 SKU 每天的销量，`/scm/sync` 拉最近 365 天整表替换；需要店铺 API 有 read_orders + read_all_orders）、scm_sync、scm_settings（目标天数、安全天数、下单天数、清关收货天数、意外天数、默认生产交期、默认头程）、scm_orders / scm_order_lines（采购下单：供应商必须是产品资料里这些 SKU 的主供应商或备选供应商（`checkOrder`）、下单日、预计交期（必填）、每个 SKU 数量和已完工数 `shipped`；状态 草稿 draft（保存即通知其他 `supply_manage` 的人）→ 下达生产 issued（和工厂确认后，才算在产）→ 已交付 delivered（全部完工，对比预计交期记准时 / 延迟）或 关闭 closed；草稿和生产中可以修改，数量不能少于已完工）、scm_shipments / scm_shipment_lines（货柜：单号、头程 first_leg（空运 7 / OA 普船 30 / 快船 20 / 美森特快 15 天）+ 尾程 last_leg（快递 3 / 港到仓 4 / 卡派 7 天）必选，预计天数默认两者相加（`FIRST_LEGS` / `LAST_LEGS`）、tracking、当前位置 position、预计到港、关联采购单、每个 SKU 发货数和实收数）。预测日销 = 40% 近 30 天 + 30% 近 90 天 + 30% 全年 × 季节系数（`forecastOf`，短期爆发最多按近 90 天 2 倍计入）；到仓天数 = 下单 + 生产交期 + 头程 + 清关收货 + 意外天数，工厂有成品时不算生产（`supplyDaysOf`，生产交期和头程取产品资料）；建议发货按成品（美国仓 + 在途 + 东莞 + 济南）算，建议生产按成品 + 在产（采购单未完工数）算（`reorderOf`）；状态只有 缺货风险 / 正常 / 库存过多，鼠标放在状态上显示系统判断。补货表数量一律显示整数（2026-11-13 老板定）：近 365 / 90 / 30 天销量（件）、预测月销（件），日均 DS 只放在鼠标悬停里；近 30 天卖不到 3 件不算涨跌（`TREND_MIN_UNITS`）；可售天数超过一年显示“1 年以上”。补货表有“SKU 状态”列和筛选（产品资料的生命周期，2026-11-13 起五个状态：开发中 / 上新中 / 在售 / 停产清存 / 下架封存，旧的 清库存、计划停售 并入停产清存，停售改名下架封存；旧名称导入照认）：停产清存 / 下架封存 的 SKU 只卖完现有货，不建议生产、不报缺货风险（`stoppingAdjust`）。“供应链看板”页签：销量趋势（整周）、库存分布、周转（按 SKU，用当前库存近似平均库存）、仓库、供应商准时率等，配色按 dataviz 规范（分类色 1–5 固定顺序，状态色带文字）。库存一律走 WMS 流水（`wmsMoveLines`）：发柜 工厂仓或新货 → 在途；完工入库 → 工厂仓；“到港通知”只通知仓库（pushInbox `wms_arrival`），WMS“到港入仓”逐行确认实收和库位后 在途 → 美国LA仓，少收的留在在途。权限：`supply_manage` 或主管理员可管理，`supply` / `products` 只读；到港入仓要库存管理 |
| 经销商下单 portal | dealer.ts, dealer-admin.ts | dealers.js | dealer_accounts、dealer_orders（价格读 product_channel_prices 的 dealer 渠道，发货走 WMS 出库） |
| 客服 | support.ts, shopify.ts | company-support.js | 工单、客服回复 |
| HRM | hr.ts | hr.js | hr_profiles（含所属地区 region：us / cn / intl，地区资料 details）、hr_secrets（SSN、身份证号、银行账号、当地税号、薪酬与税务，均加密）、hr_salary、hr_documents、hr_events。按地区授权，见第 3 节第 6 条 |
| IT 账号与资产 | it-accounts.ts | it.js | it_accounts |
| 质量追踪 | quality.ts | quality.js | quality_issues、quality_plans |
| KOL ROI | — | kol.js | （待补充） |
| Bug 与建议、版本记录 | feedback.ts | feedback.js, changelog.js | feedback |
| AI 连接（WorkOS MCP） | mcp.ts | mcp-connect.js | mcp_clients、mcp_auth_codes、mcp_tokens、mcp_calls。`https://craftos.app/api/mcp` 给老板自己的 Claude（OAuth）或 Composio（个人令牌）用；只有 `WORKOS_MCP_USER_IDS` 里、同时是主管理员的人能连，见第 3 节第 10 条 |
| CalDock（Mac mini 托管） | caldock*.ts | 独立前端仓库 | caldock_*，与 WorkOS 用户完全隔离 |

## 3. 共享数据规则（最重要）

1. **SKU 只有一份**：所有模块都用 `product_catalog.sku`。不要另建产品表、不要复制产品名称和价格。要扩展产品字段，在 products.ts 里加。
2. **价格只有一个来源**：MSRP 在 product_catalog；各渠道价格（经销商、Amazon 等）在 product_channel_prices；
   公司计价规则在 pricing_rules（零售 17%、批发 7%、MSRP 30/40/50%、批发按 MSRP 打 25%/30%，单笔超 $5 万再加 2 点、超 $10 万再加 5 点）。
   **待对齐**：经销商渠道价目前是人工填写，应改为按 pricing_rules 的批发规则自动建议、再走价格审批。
3. **库存只有一份**：常规库存的数量变化一律写 WMS 出入库流水（经销商发货就是这样），其他模块只读。退货维修（REF- SKU）不算常规库存，只在 rma.ts 里管（2026-11-11 老板定）。
4. **人和权限只有一份**：用 users 和 grants 判断权限，不要另建账号体系（CalDock 和经销商是外部客户，例外）。
   汇报线：每个人有一个第一领导 `users.manager_id`，可选一个第二领导 `users.second_manager_id`（虚线汇报）。**两位领导对这个人的权限完全相同**
   （查看、验收、OKR 领导评分、审批、调整截止时间、HR 下属范围，也包括 TA 下面的团队）：判断"谁是领导/谁能看"时两条线都要算，
   用 domain.ts 的 `leaderChildren`、`attachReportingScope`（`visibleOwnerIds` 已含两条线）或 org.ts 的 `reportsOf`，不要只读 `manager_id`。
   只有"默认指派给谁"（新任务的默认验收人、需要谁去做的提醒）仍按第一领导，避免重复。`user.dottedOwnerIds` 只是界面上区分"虚线汇报给我"用。
5. **通知统一走一处**：站内红点用 `pushInbox()`；钉钉和邮件用 app.ts 里的 `notify`。
6. 成本和利润只给有 `product_cost_detail` 权限的人和主管理员（部署配置 `WORKOS_EXECUTIVE_USER_IDS`）；在系统里勾选的管理员**不会**自动看到产品、成本、价格、库存、经销商数据，也要单独授权。功能权限（grants）只有主管理员能改，任何人都不能改自己的。薪资只给 HR 权限对应分区的人。后端新模块判断敏感数据时用 `isExecutive`，不要用 `isAdmin`。
   产品资料库的可见级别（product-spec.ts 的 `viewerOf`，服务器端过滤所有接口、文件下载、修改记录和导出模板）：
   全员 = 所有登录员工（工厂对接人除外）；产品与供应链 = `products`；仅成本权限、敏感 · 仅编辑者 = `products_secret` 或 `product_cost_detail`；仅管理员 = 主管理员。
   产品资料四级（2026-11-12 老板定，wms.ts 的 `AREAS.products`）：无 / 查看普通信息 `products` / 查看保密信息 `+products_secret` / 管理信息 `+products_manage`（改全部字段含保密字段，可批量更新）。
   价格四级（`AREAS.pricing`）：无 / 查看 `product_cost_detail`（看成本、费率、利润，只读）/ 单项修改 `+pricing_edit`（逐个 SKU 改价格、成本、费率、渠道价）/ 管理 `+products_import`（再加批量更新）。
   规则在 product-spec.ts 的 `viewerOf` / `canBulkImport` 和 products.ts 的 `canPricingEdit`；价格参数（NPCR）只有主管理员能改。旧的 `pricing_msrp` 已取消，`migrateProductPricingLevels` 只跑一次：谁也不会因此多看到东西。
   人事档案按地区：美国区只有主管理员（`WORKOS_EXECUTIVE_USER_IDS`）能看能改，没有授权项；中国、海外其他地区用 grants 里的
   `hr_cn_view` / `hr_cn_manage`、`hr_intl_view` / `hr_intl_manage`（只读 / 可管理）逐人授权，只有主管理员能分配。`WORKOS_HR_USER_IDS` 不再给任何权限。
   停用账号（members.ts）会在同一事务里调用 hr.ts 的 `hrMarkLeft`，把人事档案改为已离职、最后工作日取停用日期并记一条离职记录；恢复账号调用 `hrMarkReturned` 改回在职。反过来，把人事状态改为已离职不会停用账号。
   离职即取消全部权限（2026-11-12 老板定）：停用账号在同一事务里清空 `grants` 和 `is_admin`，清掉的内容写进审计日志（`org.member_access_cleared`）；恢复账号不会自动恢复，要重新授权。
   员工所属地区只有主管理员能改。有权限的人看到完整资料（数据库里加密保存）。员工本人只看自己的基本雇佣信息，自助填写个人资料是第二期。
   婚姻、子女、受抚养人和 EEO 只放在加密字段里，只能用于 payroll、福利和合规统计，不能用于聘用决定。
   供应链运营（左侧一组：PIM / WMS / SCM）的权限不再有单独菜单：每个模块右上角的“权限”按钮打开 `#erp-access/<area>`（erp-access.js 的 `button(area)`，只显示这个模块的列），area：products、pricing、warehouse、returns、supply、dealers、kol（批量更新不再单独授权，跟着产品资料“管理信息”或价格“管理”）。
   退货维修有自己的 grants `returns` / `returns_manage`（wms.ts 的 `returnsLevelFor`，rma.ts 用它）；2026-11 起从仓库权限拆出，`migrateReturnsAccess` 只跑一次，让原来有仓库权限的人保留同样的退货权限。主管可以给自己的下属设仓库库存和退货维修权限，其余只有主管理员能设。
   登录：钉钉登录的人可以在个人设置里自己加“邮箱密码登录”（members.ts 的 `/me/login`：登录邮箱全局唯一，已有密码时改要输入当前密码）。不要替任何人在后台写密码。
   财务（finance.ts）：grants `finance_view`（只读）/ `finance_manage`（新建、修改、记收款、附件），只有主管理员在财务模块的“权限”页分配；主管理员自动可管理。
   发票上的负责人只看自己负责的单子，并可以记收款、上传附件、写跟进（SOP：谁登记谁负责催收），不能新建或改金额。
7. **工厂对接人**：`users.quality_factory` 非空（邀请时选“工厂对接人”，或管理员在成员列表里改）的账号只能用质量追踪，后端会拦截其他接口。
   面向全公司的流程（季度确认、全员提醒、统计人数等）要用 quality.ts 的 `factoryUserIds()` 把他们排除。
8. **任务删除是软删除**：`tasks.archived_at` 非空表示已删除（批量删除/撤销在 task-board.ts 的 `/tasks/batch-archive`、`/tasks/batch-restore`）。任何模块读 tasks 做列表、统计、提醒、排行榜都要加 `archived_at IS NULL`；按 id 取单条任务用 `visibleTask()`，它已把已删除任务当作不存在。
9. **点完成就算完成**：负责人点“完成”（`/tasks/:id/complete`）任务马上算完成，别人派的任务也一样，不再等验收。
   评分是可选的：验收人、派任务的人、直属领导或管理员 24 小时内可打 0–10 分，没人打分时由 AI 评分；
   人打分低于 5 分（completions.ts 的 `LOW_SCORE`）任务退回未完成（status `revision`），负责人改完再点完成。
   旧的“提交 / 验收”接口（submissions、reviews）保留给机器人和老数据用，网页不再用它来完成任务。
10. **WorkOS MCP 只读、只给一个人**：只有 `WORKOS_MCP_USER_IDS`（部署配置）里、同时在 `WORKOS_EXECUTIVE_USER_IDS` 的人能用，每次调用都重新检查。
   工具一律只读，以这个人的身份调用现有 GET 接口（权限、汇报线、已删除任务规则照旧），再**只挑 mcp.ts 里列明的字段**返回，不能把接口结果原样转出：
   成本、到岸价、MAP / 促销底价和渠道价、供应商、报关信息、人事和薪资、客户资料（退货的客户、订单号，客服工单）都不给，因为返回的内容会离开 WorkOS 交给 AI 服务商。加写入工具前先问用户。

## 4. 开发规则（所有改动都走 PR）

- **不直接推 main**（分支保护会拒绝）：在 `claude/<简短描述>` 分支上开发，推送后开 PR 到 `main`。
  PR 必须基于最新 `main`、CI 通过才能合并；合并前如果 `main` 有新提交，先 `git pull --rebase origin main` 再推。
- 前端改完运行 `node tools/stamp-assets.mjs`（更新资源版本号，CI 会检查），再 `npm ci && npm test`；后端 `npm test`（约 8 分钟）。
- 后端所有报错文案都要在 i18n.ts 里有中文（有测试检查）。
- 中英文都要能用（供应链 PIM / WMS / SCM 已全部核对过英文）：页面文字一律 `tr(中文, English)`，英文里用半角标点；服务器写进数据库的系统文字（WMS 流水原因如“移库 / 发柜 / 完工入库 / 到港入仓 / 期初导入”，SCM 发的站内通知）保持固定格式，由前端按语言翻译（wms.js 的 `reasonText`、inbox.js 的 `SYS`），改这些文字时两边一起改；产品资料模板按下载人的语言生成，上传时中英文表头、下拉值和清空标记（`[清空]` / `[clear]`）都认（product-import.ts）。
- 上传文件统一用前端的 `dist/upload-zone.js`（`window.WorkOSUpload`）：一个框同时支持粘贴、拖拽、点击选择和“上传”按钮，
  只负责收文件和检查类型、大小，存储和权限仍由各模块自己的接口负责。新功能不要再自己写一套上传。
- 打开附件统一用 `dist/file-preview.js`（`window.WorkOSPreview.open`）：PDF、图片、文本、视频直接预览，Word / Excel 等给下载按钮。
  指向文件接口的普通 `<a href>` 会自动用它打开。新增返回文件的接口时，要同时加进 file-preview.js 的 `FILE_PATH`
  和后端 `deploy/Caddyfile` 的 `@stored_file`（只允许 WorkOS 自己嵌入预览）；PDF 不能带 CSP `sandbox`，否则 Chrome 会拦截。
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
