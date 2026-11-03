# 经销商下单门户（Dealer Portal）方案

**目标：** 经销商用 Google 账号或邮箱+密码注册登录，经我们人工审核后，按经销商价格下单、用 ACH 付款；
我们在 CraftOS 里看到订单，款到后发货并回填物流单号，经销商在门户里看到物流信息。

**选定做法（2026-11-02）：** A —— 作为 CraftOS API 的内置模块，照 CalDock 的方式和员工系统隔离：
独立的经销商账户表、cookie、CSRF 和 `/dealer/*` 路径；员工端的订单管理走正常员工登录。

## 业务规则（用户未另行指定，按推荐默认）

| 问题 | 规则 |
|---|---|
| 注册审核 | 必须人工审核。注册后状态为「待审核」，看不到价格也不能下单；管理员批准后开通，可驳回或停用。 |
| 何时发货 | 默认等 Stripe 确认款项到账（`paid`）后才能发货。可给单个经销商打开「信任，ACH 处理中即可发货」开关，只有公司管理员能开。 |
| 信用额度 / 账期 | 第一版不做，全部预付 ACH。 |
| 价格 | 用产品价格管理里已有的 `dealer` 渠道价（`product_channel_prices`，改价审批已存在）。只展示有经销商价、标记上架、且产品状态不是 dev / eol 的 SKU（未标状态的也会展示）。下单时价格由服务器按当时价格快照，前端传来的价格一律忽略。 |
| 运费 / 税 | 第一版订单金额 = 货款，不含运费和销售税（经销商转售，注册时填转售证书号）。运费按现有规则（Option 2，经销商付运费）线下另行结算。**待确认**。 |
| 库存 | 门户只显示「有货 / 库存紧张 / 需预订」，不显示具体数量；缺货也可以下单。发货时默认从美国仓扣库存（WMS 出库流水，参考号=订单号），库存不足会拒绝；从别处发货可选择不扣。 |

## 订单状态

```
pending_payment ──付款页完成(ACH 已发起)──▶ processing ──Stripe 确认到账──▶ paid ──▶ shipped
      │                                      │
      │                                      └─ 扣款失败 ─▶ payment_failed（可重新付款）
      └─ 经销商/员工取消 ─▶ cancelled
paid / shipped ──ACH 退回或争议──▶ disputed（人工处理）
任意已付款状态 ──全额退款──▶ refunded
```

`processing` 状态下，只有打开了「信任」开关的经销商订单可以发货。

## ACH 付款（Stripe）

- 用 **Stripe Checkout**（托管付款页），`mode=payment`，`payment_method_types=us_bank_account`。
  银行账户验证走 Financial Connections（即时验证，必要时退回小额存款验证）。跳转付款页是页面导航，不需要改 CSP。
- 每个经销商一个 Stripe Customer，`setup_future_usage=off_session`，下次付款可复用已授权的银行账户。
- 金额由服务器从订单快照生成；webhook 校验签名、测试/正式模式一致、金额和币种与订单一致，不一致的事件记入审计等待人工处理。
- 处理的事件：`checkout.session.completed`（ACH 一般是 unpaid → processing）、`checkout.session.async_payment_succeeded`（→ paid）、
  `checkout.session.async_payment_failed`（→ payment_failed）、`charge.dispute.created`（→ disputed）、`charge.refunded`（全额 → refunded）。每个事件 ID 只处理一次。
- 复用 `caldock-stripe.ts`：不依赖 SDK；live 密钥必须额外设置 `DEALER_STRIPE_ALLOW_LIVE=true` 才会启用。**开发阶段只用 `sk_test_`。**
- 环境变量：`DEALER_STRIPE_SECRET_KEY`、`DEALER_STRIPE_WEBHOOK_SECRET`、`DEALER_STRIPE_ALLOW_LIVE`。
  Webhook 地址：`https://craftos.app/api/dealer/stripe/webhook`。

## 登录

- **邮箱+密码：** 复用 `members.ts` 的 scrypt 哈希；登录有频率限制。
- **Google：** 复用 `caldock-oidc.ts`（PKCE + nonce + 邮箱已验证），以 Google subject 为身份，不按邮箱合并账户。
  首次 Google 登录会建一个待审核账户，要求先补全公司资料再进入审核。
  环境变量：`DEALER_GOOGLE_CLIENT_ID`、`DEALER_GOOGLE_CLIENT_SECRET`；回调 `https://craftos.app/api/dealer/auth/google/callback`。
- 会话：httpOnly cookie `__Host-dealer_session`（7 天），写操作需 `X-CSRF-Token` 且 Origin 必须是本站。
- 门户只服务一个公司：`DEALER_ORG_ID`（产品和库存所在的 org）。没设置时门户关闭（503）。

## 员工端权限

公司管理员可以做所有事。ERP 权限页新增「经销商」一栏：
- 查看（grant `dealers`）：看经销商和订单。
- 管理（grant `dealers`+`dealers_manage`）：审核经销商、发货、取消订单。
- 「信任先发货」开关：只有公司管理员。

## 通知

配置了邮件（`SMTP_*`，同成员邀请）时给经销商发邮件：审核通过 / 驳回、收到付款、已发货（含承运商和单号）。
没配置邮件时门户里的订单页仍能看到全部状态。`DEALER_NOTIFY_EMAIL` 可选：新注册和新付款时通知内部。

## 接口

经销商端（`/api/dealer/*`，经销商会话）：
`GET capabilities`，`POST auth/register`，`POST auth/login`，`GET auth/google/start|callback`，`GET me`，`DELETE session`，
`PATCH profile`，`GET products`，`GET orders`，`GET orders/:id`，`POST orders`，`POST orders/:id/checkout`，`POST orders/:id/cancel`，
`POST stripe/webhook`（Stripe 签名，无会话）。

员工端（`/api/dealer-admin/*`，员工会话）：
`GET summary`，`GET accounts`，`POST accounts/:id/decision`（approve/reject/suspend/reactivate），`PATCH accounts/:id`（信任开关、备注），
`GET orders`，`GET orders/:id`，`POST orders/:id/ship`（承运商、单号、是否扣库存），`POST orders/:id/cancel`。

## 前端

- 经销商门户：前端 repo `dist/dealer/`（独立页面，`/dealer/`），中英文，不加载员工端代码。
- 员工端：「产品与库存」页新增「经销商订单」标签：待审核经销商、订单列表（按状态筛选）、发货表单。

## 本地开发

`npm run dealer:local`（`tools/dealer-local.ts`，端口 4173）：内存 PGlite + 演示数据（演示产品、经销商价、美国仓库存），员工账号 `admin@onelaser.test` / `onelaser-local`，
同时托管前端 `dist/`。没有设置测试密钥时用本地模拟的 Stripe 付款页和模拟 Google 登录（只在这个开发脚本里存在，不进生产代码）；
设置了 `DEALER_STRIPE_SECRET_KEY=sk_test_...` 时走真实的 Stripe 测试模式（需要 `stripe listen` 转发 webhook）。

## 上线前要做的配置（部署前先和用户确认）

1. 前端 repo 合入 `dealer-portal` 分支后，API repo 的 `deploy/frontend-revision.txt` 指向新提交（Caddy 已经会把 `/dealer/` 当静态页提供，不需要改 Caddyfile）。
2. Render 环境变量：`DEALER_ORG_ID`（生产 org id）、`DEALER_STRIPE_SECRET_KEY`、`DEALER_STRIPE_WEBHOOK_SECRET`、可选 `DEALER_GOOGLE_CLIENT_ID/SECRET`、`DEALER_NOTIFY_EMAIL`。先用 `sk_test_` 在生产环境试；转正式要另设 `DEALER_STRIPE_ALLOW_LIVE=true`。
3. Stripe 后台：开通 ACH Direct Debit；建 webhook 指向 `/api/dealer/stripe/webhook`，订阅上面列出的 7 个事件。
4. Google Cloud：OAuth 客户端加回调 `https://craftos.app/api/dealer/auth/google/callback`。
5. 在 ERP 权限页给负责经销商的同事开「经销商」权限；在产品价格管理里给要卖的 SKU 设好 `dealer` 渠道价。

## 不在第一版

信用额度和账期（Net 30）、按经销商分级价格、运费自动计算、销售税、密码找回、同一公司多个登录、部分发货、
推送到 Shopify。
