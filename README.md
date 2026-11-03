# OneLaser 工作与成果 API

中文 · [English](README.en.md)

暂用 Mac 联调的启动、私有配置及隧道步骤见 [Mac 本机联调](deploy/MAC_LOCAL.md)。

员工任务、OKR、成果提交和人工验收的后台研发 MVP。使用 Node.js、TypeScript、Fastify 和 PostgreSQL 查询；本地与测试可使用 PGlite，正式数据库连接使用 `pg` 适配器。

[后台仓库](https://github.com/Yonge6/onelaser-workos-api) · [前端仓库](https://github.com/Yonge6/onelaser-workos) · [前端交互演示](https://yonge6.github.io/onelaser-workos/)

**原 GitHub Pages 站点仍为演示部署。** 只有部署同源 live runtime 并配置后才调用本仓库 API；原演示记录仍保存在浏览器 `localStorage`。虚构数据仅用于研发验证。钉钉登录、Grok 服务端评审和通知适配器已实现；实际启用需企业应用授权、部署配置，以及所选评审通道的凭证，不能据代码实现声称线上授权已经通过。

评审默认使用独立模型 API（`AI_REVIEW_MODE=api`）；可选 [Grok Bot 异步评审](docs/integrations/GROK_BOT_SETUP.md)（`AI_REVIEW_MODE=bot`），通过专用 Routine 与受保护的远程 MCP 领取/回传任务。Bot 模式不要求模型 API 余额；账户实际额度和线上连接仍须核验。每企业每 UTC 小时最多 10 次新触发，无自动重试。

Render 选择 MCP OAuth：管理员显式配置精确回调后，钉钉主管登录并明确批准 `workos.review`，再点击“返回 Bot”。数据库只存令牌摘要；刷新轮换、重放撤销和授权撤销均由服务端检查。代码仍保留显式 `bearer` 兼容模式，原生 Bot 不需要在聊天中接收 worker 密钥。真实客户端连接仍须部署后验证。

## 本地运行

需要 Node.js 22 或更新版本，推荐 Node.js 24。以下命令适用于 macOS、Linux 或兼容的 Shell：

```sh
git clone https://github.com/Yonge6/onelaser-workos-api.git
cd onelaser-workos-api
npm ci
npm run typecheck
npm test
npm run build
npm start
```

服务默认监听 `127.0.0.1:3001`。默认不导入演示数据、不启用开发登录。配置使用进程环境变量；`.env.example` 仅说明配置项，复制为 `.env` 不等于自动加载。

需要体验虚构账号时，在当前终端显式开启开发模式：

```sh
export NODE_ENV=development
export HOST=127.0.0.1 PORT=3001
export ALLOW_DEV_LOGIN=true SEED_DEMO=true
export DEV_LOGIN_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export PGLITE_DATA_DIR=.runtime/pglite
npm run dev
```

`DEV_LOGIN_SECRET` 至少 32 字符，开发登录需要同时提交该值。不要提交真实配置文件、会话令牌或数据库文件。`NODE_ENV=production` 禁止开发登录；生产配置必须提供 PostgreSQL 连接，不能用 PGlite 作为多人生产数据库。生产部署必须配置真实钉钉身份，并完成企业成员、CSRF、前后端及模型/通知实测后验收。

## 虚构账号

只有显式设置 `SEED_DEMO=true` 才会导入这些样本：

| ID | 姓名 | 部门 | 角色 |
| --- | --- | --- | --- |
| `m1` | 林楠 | 市场 | 负责人 |
| `m2` | 陈一 | 市场 | 员工 |
| `m3` | 许夏 | 市场 | 员工 |
| `m4` | 周明 | 产品 | 负责人 |
| `m5` | 赵然 | 产品 | 员工 |
| `m6` | 顾安 | 产品 | 员工 |

角色和部门由服务端保存，不接受客户端自行声明。每次请求都会重新查询用户状态和范围；停用用户不能继续使用已有会话。

## 中英文响应

系统错误与提示默认使用中文。请求头设置 `Accept-Language: en` 时使用英文；设置 `Accept-Language: zh` 时使用中文。接口路径、JSON 字段名和 `error.code` 等机器标识固定使用英文，方便前后端稳定对接。员工填写的标题、说明、成果和验收意见按原文保存，不自动翻译。

```sh
curl --silent http://127.0.0.1:3001/capabilities -H 'Accept-Language: en'
```

## 登录与请求示例

开发登录从环境变量读取密钥，通过请求正文发送给本机服务：

```sh
export ACCESS_TOKEN="$(node -e 'process.stdout.write(JSON.stringify({userId:"m2",secret:process.env.DEV_LOGIN_SECRET}))' \
  | curl --fail --silent --show-error http://127.0.0.1:3001/auth/dev-login \
      -H 'Content-Type: application/json' --data-binary @- \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).accessToken))')"

curl --fail --silent --show-error http://127.0.0.1:3001/tasks \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

登录返回 `accessToken`、`tokenType` 和 `expiresAt`。会话使用随机令牌，数据库只保存令牌摘要；请勿将令牌写入 URL 或日志。

员工创建本人任务的正文示例：

```json
{
  "title": "完成产品内容初稿",
  "description": "提交可核对的内容与资料来源",
  "criteria": ["提供资料来源", "逐项说明验收情况"],
  "ownerId": "m2",
  "reviewerId": "m1",
  "dueAt": "2026-11-01T18:00:00+08:00",
  "krId": "kr2"
}
```

提交和验收需要先读取任务的最新 `version`。将它作为 `expectedVersion` 传入；审批请求的 `submissionVersion` 应使用任务返回的当前 `submission_version`。版本变化后旧请求会返回 `409`，调用方应重新读取并由用户确认。

## API 范围

除健康、能力说明和身份入口外，业务接口均需要会话。正式网页使用 HttpOnly Cookie；Bearer 仅用于开发示例和受控工具。

| 方法与路径 | 当前行为 |
| --- | --- |
| `GET /health`、`GET /capabilities` | 健康状态与接入能力说明 |
| `POST /auth/dev-login` | 仅显式启用的开发模式可用，正文为 `userId`、`secret` |
| `GET /auth/dingtalk/start`、`GET/POST /auth/dingtalk/callback` | 配置后启动受控 OAuth 流程；缺配置返回 `501` |
| `DELETE /auth/session` | 撤销当前会话 |
| `GET /me` | 当前用户身份 |
| `GET /tasks`、`GET /tasks/:id` | 按本人或部门范围读取任务及成果记录 |
| `POST /tasks` | 创建任务并冻结最初截止日、验收标准与验收人 |
| `POST /tasks/:id/submissions` | 提交新成果版本，保存说明和可选 HTTPS 证据链接 |
| `POST /tasks/:id/reviews` | 指定负责人验收通过或退回补充 |
| `GET /objectives`、`GET /key-results` | 可见目标、KR 与业务进度 |
| `POST /key-results/:id/measurements` | 负责人记录实际值、来源和说明 |
| `POST /tasks/:id/analyze` | 配置后进行有引用的文本证据评审；缺配置返回 `501` |
| `GET /notifications/preview` | 生成当前可见范围的本地草稿，不发送 |
| `POST /notifications/send` | 负责人明确触发的幂等通知；缺配置或开关关闭返回 `501` |
| `GET /audit` | 按权限范围读取操作记录 |

成果提交正文：

```json
{
  "expectedVersion": 1,
  "title": "第一版成果说明",
  "description": "说明交付内容、数据来源与尚待补充的部分",
  "evidenceUrl": "https://example.com/evidence"
}
```

人工验收正文：

```json
{
  "expectedVersion": 2,
  "submissionVersion": 1,
  "decision": "accept",
  "quality": 85,
  "note": "已实际核对当前成果及约定标准，保留核对依据",
  "verifiedCurrentSubmission": true
}
```

以上版本号仅展示字段关系，实际请求必须使用最新返回值。退回时使用 `decision: "return"` 并填写原因，无需填写质量分。

## 权限与数据规则

- 员工只读取本人任务，新建任务不能指派给其他人；负责人只管理本部门。
- 个人 KR 只在允许的身份范围内显示。创建任务时，服务端再次校验人员、验收人和关联 KR。
- 负责人不能验收自己的成果；只有指定验收人可以确认相应任务。
- 新成果版本会使旧验收退出当前结果，历史记录保留。旧版本审批不能覆盖新提交。
- 验收通过要求人工质量分、意见和已核对当前材料的确认。任务完成不会自动增加 KR 实际值。
- KR 变化需要单独记录实际值、来源和说明；无法计算的归一化进度返回未知值。
- 证据链接仅保存为元数据，不主动访问外部链接，不上传或解析附件。
- 不含薪资数据、自动去留判断、自动人事操作或个人综合绩效评分。
- API 使用参数化 SQL、结构化校验与受限请求大小；默认不开放跨域访问。

## 验证与后续工作

`npm test` 使用 Fastify 注入请求和 PGlite SQL 数据库，覆盖身份、权限、版本冲突、人工验收与 KR 独立性等接口行为。`npm run typecheck` 检查 TypeScript，`npm run build` 生成可运行代码。

设置 `TEST_DATABASE_URL` 可让同一组接口测试连接测试用 PostgreSQL；测试库必须独立于正式业务库。生产 PostgreSQL 适配器仍需在实际服务器完成联调；本地 PGlite 测试不能证明真实 PostgreSQL 部署、备份或恢复已经通过。远程 CI 的结果以对应 Actions 运行记录为准。正式试点还需核验真实钉钉授权、前后端联调、按需添加私有文件存储与证据解析、实测模型引用、启用的通知通道、工作日历、恢复演练和企业权限。


## 生产集成

完整部署步骤见 [部署说明](deploy/README.md) · [English deployment guide](deploy/README.en.md)。Docker 镜像固定前端提交，在同一来源提供网页和 `/api`；Render Blueprint 和自有服务器 Compose 均已提供。部署文件不会自动创建收费资源。

知识中心/Wiki 已整合为 Work OS 原生栏目，共用系统导航、字体、中英界面和日夜主题，无 iframe。保留 236 篇原文、8 个分类、全文搜索、52 篇下载指南、完整目录、图片、表格和原始链接；“档案与核对”沿用受授权保护的人工记录。构建仍固定并校验 `deploy/wiki-revision.txt` 的 259 个公开文件，原生栏目从同源 `/wiki/data/` 读取、清理并呈现内容，原站不变。原始图片和下载仍依赖原链接。详见 [知识中心集成与数据边界](docs/company-support.md)。

前端与 API 使用同一 HTTPS 来源，反代 `/api` 时去除前缀。网页登录直接进入 `/api/auth/dingtalk/start`。服务端使用短时 OAuth state 与 HttpOnly 浏览器 nonce，随后按指定企业验证个人 unionId、企业 userId、有效成员和批准部门。只有 `DINGTALK_MANAGER_USER_IDS` 中明确的账号获得负责人角色；不会把首个登录者自动升级。

登录返回 HttpOnly、Secure、SameSite=Lax 会话 Cookie，不把会话放进地址或浏览器存储。前端先读取 `GET /auth/csrf`，写请求带 `X-CSRF-Token`；服务端校验来源、令牌、当前用户和资源权限。`GET /capabilities` 只显示配置状态及缺少的配置名，不返回密钥。配置完整不等于已经在真实租户验收。

十来人的公司可显式设置 `WORKOS_TEAM_MODE=company`，让已通过企业与部门白名单验证的成员共用工作区；代码默认仍是 `department`。原钉钉部门 ID 和名称保留在身份映射中。公司模式同步逐个读取允许的真实部门并去重，不把内部工作区 ID 发给钉钉。已有业务数据后不要直接切换模式，应先迁移任务与目标范围。

负责人可调用 `POST /integrations/dingtalk/sync` 同步批准范围，缺席成员会停用，从而立即失去已有会话权限。`GET /directory`、`GET /departments` 提供允许的人员与工作区；员工只可建本人个人目标，负责人可建当前工作区目标。

公司模式如需接入其他部门的个别人，可配置 `DINGTALK_ADDITIONAL_USER_IDS` 为经核对的钉钉企业 userId（逗号分隔，不是姓名或员工工号），保留原部门白名单不变。登录仍核验同一企业、内部有效成员和真实部门；同步逐一读取这些指定成员，合并去重后再判断缺席成员，不枚举其所在的其他部门。任何成员核验失败会中止本次同步，避免部分结果停用已有成员。这个名单只授予接入资格，不授予管理权限；只有 `DINGTALK_MANAGER_USER_IDS` 决定负责人角色，`WORKOS_EXECUTIVE_USER_IDS` 独立决定老板看板权限。额外人员名单只支持 `WORKOS_TEAM_MODE=company`；配置更新后需部署并执行同步或重新登录，使数据库角色生效，已有会话的后续请求读取最新角色。

`POST /objectives` 正文为 `{title,level:"personal"|"department",ownerId?}`；`POST /objectives/:id/key-results` 为 `{title,baseline,target,actual?,direction:"increase"|"decrease",unit}`。普通部门角色不能创建全企业公司级目标，避免扩大跨工作区权限。

Grok 评审可选择模型 API（`AI_REVIEW_MODE=api`）或 [Bot 异步通道](docs/integrations/GROK_BOT_SETUP.md)（`AI_REVIEW_MODE=bot`）；Bot 使用独立 Work OS Routine，保留现有客服 Bot 工作流。评审只传递当前任务标准和当前提交的文本，不发送薪资/全员资料，不自动抓取 URL。服务端验证所有标准恰好出现一次、引用 ID 属于本次提交、引用原文实际存在。失败或旧版本返回待处理错误，不填低分；AI 不改变任务验收状态、不作人事判断。`GET /tasks/:id/evaluations` 保留版本历史，负责人仍需实际核对并验收。

通知请求为 `{taskIds:[...],idempotencyKey:"UUID"}`，仅负责人可发给当前范围内的任务本人。需另开 `DINGTALK_NOTIFICATIONS_ENABLED=true` 并配置 AgentId；未开启不会发送。返回 `queued` 只表示钉钉接受发送请求，`sent:false` 不冒充已送达；超时标为 `unknown`，同一幂等键不自动重发。不得将通知预览当作真实送达。

### 上传文件的存放位置

RMA 照片、任务附件和反馈截图默认存在 PostgreSQL 里（`FILE_STORAGE=db`），和以前一样。设置 `FILE_STORAGE=s3` 和五个 `S3_*` 值后，新上传的文件写入私有的 S3 兼容存储桶（阿里云 OSS、Cloudflare R2），数据库只记对象路径。下载仍然经过 API，权限检查和安全响应头不变，存储桶不需要也不允许公开访问。已经存在数据库里的旧文件照常读取，不需要迁移。存储桶故障时上传返回 503，不会留下没有文件的记录。

切换前先在服务 Shell 运行 `node build/src/cli/check-file-storage.js`：它会写入、读回并删除一个测试对象，并确认不带签名的请求读不到文件。只要还有文件在桶里，就要保留 `S3_*` 设置，即使把 `FILE_STORAGE` 改回 `db`。HR 加密证件和头像仍存在数据库里，不受这个设置影响。配置示例见 `render.yaml`。

新增 OAuth/CSRF、企业范围、Grok 引用和通知幂等测试使用 mock 官方服务；这些测试不会发送真实钉钉消息或消耗真实模型额度。真实授权、模型可用性、API 费用、用户首次登录和通知接收仍需上线验证。


### OKR fields / 钉钉字段对齐 (2026-10-28)

Objective creation accepts validated `planning`: `period` (YYYY-MM), `weight`
(absolute period %), `location`, `description`, `type` (mandatory/bonus),
`bonusIncluded`, `scoringDueDate` (YYYY-MM-DD). KR creation accepts
`planning: {weight, description}`. Existing rows keep unknown planning.

`GET /key-results/:id/appraisal` reads authorized version history.
`POST /key-results/:id/self-evaluation` requires expectedVersion, score, note and
evidence. `POST /key-results/:id/manager-evaluation` requires expectedVersion,
score, note, current selfAppraisalId and verifiedEvidence:true. Allowed scores
are 0/20/40/60/80/100. A different in-scope manager confirms evidence. Both writes
advance the KR version. New self evidence or actual measurements invalidate the
current manager result. Other employees cannot inspect these private evaluations.

新增周期、权重、地点、任务类型、奖励项参与开关、成果、自评、主管评分和评分截止日期。
评分版本和历史审计独立保存。新版明确采用主管核定分，不推断原钉钉综合公式；
当前不自动迁移历史表、不代替人工验收、不生成员工去留结论。


### Team task views and internal updates

The pinned frontend provides Team board/My Work, Table/Kanban/Calendar/Dashboard, and per-user view/column preferences. `POST /task-board/view` accepts optional `display`, `scope`, `showWeekends` and bounded `widths`; existing saved views remain valid. Scope selection never expands authorization.

`GET /tasks/:id/updates` returns the most recent 200 internal updates, chronological within that window, after existing task visibility checks. `POST /tasks/:id/updates` accepts `{requestId, expectedVersion, body}` (UUID, current task version, 1–10000 trimmed characters). It stores an append-only internal note and audit entry; matching retries are idempotent, conflicting UUID reuse/stale context returns409. No customer messages, notifications, task status or evidence decisions are triggered. `/task-board` includes each visible task's `update_count` and actual department/assigned scope. The additive `task_updates` table/index is initialized alongside the existing board schema.
