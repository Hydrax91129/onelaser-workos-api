# OneLaser Work OS 部署

中文 · [English](README.en.md)

正式入口由托管平台提供 HTTPS 子域名；GitHub Pages 继续作为公开演示。Docker 镜像同时提供固定版本的前端与 `/api`，业务数据进入 PostgreSQL。当前代码与 mock 测试不代表真实钉钉、Grok 或生产部署已经验收。

## 选定配置

- 全公司约 10 人，`WORKOS_TEAM_MODE=company`，仍限指定钉钉企业和批准部门。
- 负责人必须明确列入 `DINGTALK_MANAGER_USER_IDS`；首位登录不会获得管理权限。
- 试点优先使用现有 Grok Bot 套餐额度，单独建立 Work OS 评审工作流；现有客服 Bot、Zoho 自动化不受影响。模型 API 作为可选备用，单独计费。
- 不导入演示数据、不开启开发登录；真实业务内容不保存在浏览器 localStorage。
- 默认关闭钉钉通知。AI 输出作为核查建议，验收由指定负责人完成。

## Render 托管

1. 打开 [创建 Blueprint](https://dashboard.render.com/select-repo?type=blueprint)，选择本后台仓库 `Hydrax91129/onelaser-workos-api`，使用根目录 `render.yaml`。
2. 审核将创建的 Web Service、PostgreSQL、区域和实际费用。当前模板使用 Singapore、Web `0.5c-512mb`、数据库 `0.1c-256mb`、1 GB 数据盘。计划 ID 和价格以平台当时界面为准；模板未授权任何扣款。
3. 在平台安全环境变量中配置下表。不要把凭据放入 GitHub、前端、URL 或聊天。
4. 部署后获得 `https://<service>.onrender.com`。`APP_PUBLIC_URL` 默认读取平台 `RENDER_EXTERNAL_URL`，无需自有域名。将此地址配置为钉钉首页，并注册回调 `https://<service>.onrender.com/api/auth/dingtalk/callback`。
5. 完成下面的真实验收后再邀请员工。缺少凭据时页面显示待配置，不能绕过登录使用。

| 配置 | 来源与用途 |
| --- | --- |
| `DINGTALK_CLIENT_ID` / `DINGTALK_CLIENT_SECRET` | 独立企业内部应用的凭据 |
| `DINGTALK_CORP_ID` | 批准接入的企业 |
| `DINGTALK_ALLOWED_DEPARTMENT_IDS` | 明确批准的真实部门 ID，逗号分隔；公司模式仍须指定 |
| `DINGTALK_INCLUDE_SUBDEPARTMENTS` | 默认开启：允许部门下任意层级子部门的成员也可登录和同步，归入该允许部门。设为 `false` 只收直属成员 |
| `DINGTALK_MANAGER_USER_IDS` | 明确批准的主管 userId，逗号分隔 |
| `REQUIRE_AI_ASSESSMENT` | 默认不设：验收人可以不等 Bot 评估直接人工验收。设为 `true` 时，必须先有评估通过才能验收 |
| `AI_REVIEW_MODE` | 模板选择 `bot`；代码默认 `api`。配置缺失时评审保持关闭 |
| `GROK_BOT_MCP_AUTH_MODE` | Render 选择 `oauth`；代码默认 `bearer` 兼容模式 |
| `GROK_BOT_OAUTH_REDIRECT_URIS` | OAuth 精确回调白名单，默认空；只能由管理员核对真实客户端后显式配置 |
| `GROK_BOT_OAUTH_PRE_REGISTERED_CLIENT_ID` | 可选固定 HTTPS client ID 的本地映射；不抓取 client metadata |
| `GROK_BOT_WEBHOOK_URL` / `GROK_BOT_WEBHOOK_SECRET` | 独立 Bot routine 的正式 HTTPS 触发地址与密钥 |
| `GROK_BOT_WEBHOOK_ALLOWED_HOST` | 逐字核对 routine 显示的实际域名；不接受通配符或本机/私网地址 |
| `GROK_BOT_WORKER_TOKEN` | 仅 `bearer` 兼容模式需要；OAuth 使用主管批准与 PKCE，不把静态密钥传给 Bot 聊天 |
| `GROK_BOT_ORG_ID` | 允许读取评审作业的企业，默认可读取显式配置的 `DINGTALK_CORP_ID` |
| `AI_PROVIDER_API_KEY` / `AI_MODEL_ID` | 仅 `api` 模式需要：模型密钥及账号实际支持结构化输出的模型 ID |
| `DINGTALK_AGENT_ID` | 应用 AgentId，启用工作通知时需要 |

钉钉企业管理员需要为独立应用批准登录身份、企业成员映射、指定部门与成员读取权限；工作通知仍需应用 AgentId 和明确启用。权限名称以企业应用后台当时界面和官方文档为准。应用可见范围限指定成员。模型仅接收本次授权任务的标准与成果文本；不自动读取链接、不发送薪资或全员档案。首次真实验证应使用虚构任务。

Bot 触发和回写的具体步骤见 [Bot 接入说明](../docs/integrations/GROK_BOT_SETUP.md)。先部署基础服务与钉钉登录，配置管理员核对的精确回调/可选 client ID，再连接 OAuth MCP，由主管明确批准并点击“返回 Bot”。OAuth 连接可先于 webhook 配置完成；实际评审仍须独立 Routine 的 webhook 地址、密钥及主机名。回调白名单为空时 OAuth 关闭，不能用静态 worker secret 替代或降级匿名。模板不要求购买模型 API 额度。Webhook 接受请求只表示开始执行，结果另行回传。Bot 套餐仍有用量限制。同账号 Bots 共享云端电脑和登录，独立工作流不能代替服务端权限控制。

### 切换到 craftos.app

先核验 `craftos.app` 的 DNS、Render 域名验证和 HTTPS，再将 `APP_PUBLIC_URL` 设为 `https://craftos.app`。同时更新钉钉首页与登录回调；如配置了 `DINGTALK_REDIRECT_URI`，必须一起更新。只有这个明确的正式来源（允许末尾 `/`）会启用旧 `onelaser-workos.onrender.com` 的 307 跳转，保留路径、查询参数和请求方法，并设置 `no-store`；`/healthz`、`/api/health` 始终直接服务健康检查。切换前所有 URL 保持原行为，恢复旧 `APP_PUBLIC_URL` 即关闭跳转。

员工须从新域名重新登录；旧域名的会话与进行中的登录不会迁移。同步调整私有连接器的来源，并让专用 Bot 使用新 MCP 地址重新授权；跳转不替代 OAuth 授权或 API 客户端迁移。此规则的目标是固定的 `https://craftos.app`，不使用请求 Host 或任意环境变量拼接目标域名。

可使用真实 Caddy 2 二进制验证切换前后路由、健康检查和 Host/来源注入防护：`CADDY_BIN=/absolute/path/to/caddy node --import tsx --test test/caddy-redirect.test.ts`。本地没有 `CADDY_BIN` 时该集成测试会明确跳过；CI 在构建生产镜像后提取其中的 Caddy 并设置 `CADDY_BIN`，必须执行这些测试，再运行原有同源 smoke test。用于提取二进制的临时容器在成功或失败后都会清理。

### 私有仓库的下载令牌（`GITHUB_FETCH_TOKEN`）

Docker 构建会下载固定版本的前端（`Hydrax91129/onelaser-workos`）和 Wiki（`Hydrax91129/onelaser-support-center`）。仓库公开时匿名下载即可；改成私有前，必须先配好只读令牌。

1. 令牌：GitHub fine-grained token，只授权上面两个仓库，权限只给 Contents: Read-only。令牌只填进平台的密钥设置，不要放进代码、URL 或聊天。
2. Render：在服务的 Environment → **Secret Files** 里添加文件 `GITHUB_FETCH_TOKEN`，内容是令牌（普通环境变量不会传进 Docker 构建）。Dockerfile 用 BuildKit secret（`RUN --mount=type=secret,id=GITHUB_FETCH_TOKEN,dst=/etc/secrets/GITHUB_FETCH_TOKEN`）读取，不用 ARG/ENV，令牌不会留在镜像层里。
3. GitHub CI：在后端仓库 Settings → Secrets and variables → Actions 添加密钥 `_GITHUB_FETCH_TOKEN`（GitHub 不允许密钥名以 `GITHUB_` 开头）；`ci.yml` 用 `docker build --secret` 传入。
4. 核对：构建日志会打印 `GITHUB_FETCH_TOKEN: used`（只说明是否使用，不打印令牌）。Render 和 CI 的日志都显示 `used` 之后，才能把仓库改成私有。看到 `not provided` 说明令牌没有传进构建。
5. 没有令牌时脚本照旧匿名下载；令牌无效时构建会直接失败（401/404），不会悄悄退回旧版本。CalDock（`Yonge6/mac-mini-rental`）不受影响，仍匿名下载。

## 自有服务器备选

`deploy/compose.yaml` 包含 PostgreSQL 持久卷和应用，只向本机暴露 `127.0.0.1:8088`。已有 Nginx/Caddy 将正式 HTTPS 来源反代至该端口。GitHub 链接不能替代这台运行服务的主机。

1. 在后台仓库根目录创建 Git 忽略的 `.env.production`，填入批准配置和 `APP_PUBLIC_URL=https://<host>`。
2. 设置一个强随机 `POSTGRES_PASSWORD`；若写入连接串，使用仅含 URL 安全字符的随机值。
3. 运行 `docker compose --env-file .env.production -f deploy/compose.yaml up -d --build`。
4. 数据库卷必须备份，禁止把 `down -v` 当作日常重启。迁移前备份，恢复至独立数据库验证后再切换正式连接。

## 验收与发布

- CI 必须通过：TypeScript、PGlite、真实 PostgreSQL、Docker 构建、同源 `/api`、安全头、默认关闭身份入口和未配置的 Bot 集成。
- `/healthz` 检查数据库连通性；`/api/capabilities` 显示配置状态。`configured` 仅表示配置完整。当前版本的 `productionReady:false` 是固定标识，不随配置或真实租户验收自动改变；它不是部署失败信号，也不能替代实际验收记录。
- 真实钉钉主管和员工登录；未批准企业/部门拒绝，普通员工不能读取他人任务或自行提权；同步停用成员后已有会话失效。
- OAuth 模式核验根路径及带 MCP 路径的 well-known metadata、外部 `/api` 端点、真实客户端注册/精确回调、主管明确批准、PKCE、state/iss、刷新轮换与撤销。完成页不自动跳转；批准后两分钟内点击“返回 Bot”。静态 worker token、业务 Cookie 与 OAuth token 不可代用。配置摘要不匹配会拒绝旧 grant；永久停用须显式撤销。
- 创建 OKR/KR、分配任务、员工提交成果、Grok 返回可核对引用、负责人验收、刷新后仍保留；冲突返回 409，不自动覆盖。Bot 模式另外验证排队、处理、完成、超时/不确定状态、手动重试、租约失效与旧版本拒绝，不以“已触发”冒充分析完成。
- 中文/English、日夜模式、退出与重新登录检查。主题和语言可存本地；任务与会话不能存 localStorage。
- 如需通知，先明确批准测试收件人，再设置 `DINGTALK_NOTIFICATIONS_ENABLED=true`。`queued` 表示平台接受请求，不能作为送达凭证。
- 确认托管数据库备份策略、费用和恢复演练。前端版本由 `frontend-revision.txt` 固定；更新前端后必须修改固定提交并重建镜像，回滚时保持数据库迁移兼容。

此阶段不自动作留任、解雇或薪资决定；现有证据与人工验收记录可供主管查看。

### 老板看板（只读）

`WORKOS_EXECUTIVE_USER_IDS` 为逗号分隔的 **Work OS 内部 users.id**，默认空；必须在真实钉钉身份核验后，由管理员确认老板对应账号，再写入服务器私有配置。不是姓名、钉钉工号或手机号，不自动授权首位登录人。`GET /me` 返回当前人的 `executiveAccess`；`GET /executive/summary` 仅向名单内的在职账号返回其所属企业的只读总览。此权限不改变原有任务详情、修改、AI 调用或验收权限。

统计涵盖系统内全部已记录任务，不受普通任务列表的 100 条上限影响；风险明细最多 50 项。OKR 为有效 KR 等权、公司目标等权，不含个人目标；缺失指标为 null。逾期按服务器当前时间和最新截止时间计算，可能与待验收重叠。不提供虚构薪资或留用评分。当前流程无独立阻塞状态，正式看板跟进逾期、待验收和退回补充；演示版另有阻塞示例。部门范围遵循当前工作空间配置，company 模式采用一个试点协作范围；老板看板按每位成员保留的已核验钉钉部门归属汇总人数与任务，多部门成员按首个批准部门计入一次。共享范围内的部门目标不冒充原始部门目标。
