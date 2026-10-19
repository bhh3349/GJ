# sub-gateway 交接文档（HANDOVER）

- 交接基线：main = `667e20c`（fix(web): Vite dev server 双栈绑定），与 origin/main 同步，工作树无未提交源码改动
- 交接时间：2026-10-16
- 交接人：画师（前端车道，代 PM 执行打包交接；PM 当时被系统 CPU 保护打断）
- 本包构成：`git archive HEAD` 的干净源码树 + 本文档 + `docs/proposals/1panel-五功能-可增加性报告-v1.md`（未入库的调查报告）
- 包内不含：`node_modules/`、`data/`（运行态 SQLite 与账号数据）、`.env`（真实凭据）、`.git/`、`.worktrees/`、`.ekko-tmp/`
- 本包不含 git 历史；如需提交历史，向交接方另要仓库或远程 origin

## 1. 项目是什么

LLM 网关 `sub-gateway v0.1.0`：对接 OpenAI 兼容上游（TierFlow 类服务），管理账号池 / Key 池 / 用户组 / 模型档案 / 出口代理，对外提供 OpenAI 兼容转发（`/v1/*`），对内提供 React 管理后台（`/api/*` + `web/`）。

核心交付原则：**安装即用**——所有端口/绑定走 `.env`，零写死域名/IP/出口；Base URL 与 API Key 全部由产品界面录入。

## 2. 技术栈与运行要求

- 后端：Node **>=22 <23**（`better-sqlite3` 原生模块按 Node 22 ABI 编译，换大版本会 `ERR_DLOPEN_FAILED`）、Fastify 5、better-sqlite3 11、undici 7
- 前端：React + Ant Design + Vite（`web/` 为独立 pnpm 子包）
- 包管理：pnpm 10.34.6（`packageManager` 字段已钉死）
- 数据库：SQLite（`data/gateway.db`，`SCHEMA_VERSION=2`，迁移由代码管理，**勿手改库**）

## 3. 快速开始

```bash
pnpm install
cp .env.example .env      # 按需改端口/绑定；真实上游凭据稍后在界面录入
pnpm dev                  # 后端 dev（tsx watch src/server.ts）
pnpm web:dev              # 前端 dev，http://127.0.0.1:5173（IPv4/IPv6 双栈）
```

管理后台默认账号见 `.env` 的 `ADMIN_USER` / `ADMIN_PASSWORD`（首次启动写入库）。

生产：

```bash
pnpm build                # tsc -p tsconfig.build.json → dist/
pnpm start                # node dist/server.js
pnpm web:build            # web/dist
# 可选：.env 设 ADMIN_WEB_DIST=<web/dist 绝对路径> → :4001 同源托管前端产物
```

## 4. 端口与绑定（全部 `.env`，代码零硬编码）

| 键 | 默认 | 说明 |
|---|---|---|
| `PORT_GATEWAY` / `HOST_GATEWAY` | 4000 / 0.0.0.0 | 网关对外转发面 |
| `PORT_ADMIN` / `HOST_ADMIN` | 4001 / 127.0.0.1 | 管理面 REST + 可选同源托管 |
| Vite dev 端口 | 5173 | `web/vite.config.ts` 已 `host: true` 双栈（127.0.0.1 与 [::1] 都通） |
| `PUBLIC_HOST` | 空串（=null） | 接入信息页对外展示域名；不落库、不审计 |
| `ADMIN_WEB_DIST` | 空 | 非空 = :4001 同源托管前端产物 |

## 5. 目录结构

```
C:\WorkSpace\sub
├─ src/                          后端（Node + Fastify + better-sqlite3）
│  ├─ server.ts / config.ts      进程入口与 .env 装载
│  ├─ api/
│  │  ├─ routes/                 REST 路由（upstreams/keys/groups/models/
│  │  │                          supplier-accounts/egress/access-info/stats/
│  │  │                          observability/live(WS)/auth/assistant）
│  │  ├─ services/               余额刷新/模型同步/凭据轮换/批量导入导出
│  │  └─ app.ts auth.ts errors.ts dto.ts schemas.ts
│  ├─ db/                        schema/database/crypto(aes-256-gcm)/ids
│  │  └─ repo/                   keys/upstreams/groups/models/supplier-accounts/
│  │                             egress/audit/logs 仓储层
│  ├─ gateway/                   转发内核：engine/key-pool/limiter/rotation/
│  │                             cooldown/egress/usage/routes/stack
│  ├─ wiring/                    装配缝：runtime/store/egress-select/
│  │                             egress-proxy/auth/shutdown
│  ├─ security/ egress/ supplier/ balance/ util/
│  └─ *.spec.ts                  测试与源码同目录（vitest）
├─ web/                          前端（React + AntD + Vite）
│  └─ src/                       pages/ api/ layouts/ router/ components/
│                                realtime/ theme/ styles/ auth/ utils/
├─ data/gateway.db               SQLite 运行态（不入包）
├─ docs/
│  ├─ api-contract.md            REST 契约（v1.14.2；§0.6=数据保留策略总表、§16.7=出口探活、§18=接入信息）
│  ├─ adr/0001–0033              33 条架构决策记录
│  └─ proposals/                 1panel 五功能可增加性报告等
├─ deploy/vps-egress             出口 VPS 相关
├─ Dockerfile / docker-compose.yml / .dockerignore   单机容器化（§10 第 2 条）
├─ scripts/                      压测/探针/校验（bench-ttfb、probe-* 等）
└─ .env.example                  端口与绑定模板（真实 .env 不入包）
```

## 6. 架构分层（改代码前必读）

- `src/api/` 管理面：统一错误码 `{code, message}`（17 枚，如 `KEY_EXHAUSTED`、`QUOTA_EXCEEDED`）；时间 ISO8601；金额单位**分（int）**；token 单位 **int**
- `src/db/`：上游 key 明文只在录入瞬间存在，库内一律 aes-256-gcm 密文，**永不明文落盘**
- `src/gateway/` 转发内核；`src/wiring/` 装配缝；**`fetch-gate.ts` 与 `ports.ts` 为 ADR-0021 冻结件，禁止修改**
- 车道纪律：改 api/db 不动 gateway 内部实现，反之亦然；跨缝改动走 `wiring/`
- 契约唯一事实源：`docs/api-contract.md` + `docs/adr/`。**改接口先改契约**，代码跟着契约走

## 7. 接口面

网关（Key 鉴权，`Authorization: Bearer <网关key>`；无 key → 401 `INVALID_API_KEY`）：
`/v1/chat/completions`、`/v1/models`、`/v1/completions`、`/v1/embeddings`

管理（会话鉴权，写操作需 `X-Requested-With: XMLHttpRequest`）：
- `/api/upstreams`（Base URL 增删改）
- `/api/keys`（+ `PUT /api/keys/:id/balance` 余额录入）
- `/api/groups`（用户组：建组、发 key、配额）
- `/api/models`（+ `POST /api/models/sync`）
- `/api/supplier-accounts`（账号池、批量导入「手机号,密码」逐行、`/:id/funds` 资金池）
- `/api/egress`（出口代理六写端点 §16.7.2：**仅 HTTP(S) CONNECT**；`socks5://`/`socks4://`/`ftp://` 写入即 400 `INVALID_PARAM`，零行落库）
- `/api/access-info`（§18 接入信息：网关/管理面地址、publicHost、同源托管状态）
- `/api/stats/usage` + WS `/api/stats/live`；`/api/observability/health|health/snapshots|errors|errors/:id`
- `/api/auth/login`（Set-Cookie `sid=`，HttpOnly SameSite=Lax Path=/）

出口代理绑定语义（判据缝方案甲）：池空 = 未启用恒活；池内按单轴 `status`；查无此行 = 未绑账号照常宿主出口。

## 8. 质量闸（每次改完必跑，全绿才算完）

```bash
pnpm typecheck        # RC=0
pnpm test             # 基线：58 文件 899 passed 1 skipped @667e20c；当前 59 文件 947 passed
pnpm build            # RC=0
pnpm check:secrets    # 0 命中 PASS
```

> **当前实测（2026-10-16，v1.14.2 / ADR-0033 + 容器化落地后）**：`typecheck` RC=0、`build` RC=0、`check:secrets` 0 命中（323 文件 / 4087 KB）、**测试 59 文件 947 passed**（比上面的 @667e20c 基线 +1 文件 / +48 条，多出来的全是这几笔的回归判据）。

红线（仓库文件内 0 命中）：11 位手机号形状、mock/fake/dummy、`sk-` 字面量、密码字面量。
测试贴源：每个 `.ts` 旁边 `.spec.ts`；`web-layout-parity` 锁布局与 vite `host:true` 绑定（防单栈事故回退）。

**测试用例必须过变异验证才算数**：写完判据先改坏实现、看它红，再改回来。ADR-0032 里有一条用例（`pruneTasks` 的"在跑任务不删"）就是靠变异才发现它拦的不是当前结果而是某次特定改写 —— 不改坏一次，你无法知道一条绿用例到底在保护什么。

## 9. 已交付能力（截至 667e20c，全部在 main）

供应商管理（BaseUrl）／Key 管理（分类标签、余额、启停）／用户组（建组、发 key、配额）／模型档案（拉取建档、sync）／账号池批量导入＋资金池／出口代理全链路（面板录入 → 绑定账号 → 转发链路生效，`3a79f33`）／接入信息页（`/access`，af2655e）／统计＋实时 WS／日志查询／可观测性端点／Vite 双栈绑定（667e20c）。

## 10. 挂账与待拍板（接手方从这里继续）

1. **1panel 对标五功能**：报告在 `docs/proposals/1panel-五功能-可增加性报告-v1.md`；建议先做 A 档——纯前端 `/admin` ↔ `/console` 双视图（角色切换），后端 0 改动
2. ~~**容器化（C 笔）未做**~~ —— **已结**（2026-10-16）：`Dockerfile` / `docker-compose.yml` / `.dockerignore` 三件已交付并**实测过**（真构建 + 真启动 + 双面在听 + 真写库 + 重启后数据还在 + `MASTER_KEY` 缺失时按 `CryptoConfigError` 拒绝启动 + `.dockerignore` 确实挡住 `.env` 与 `data/`）。**部署入口是 `docker compose up -d`**，`.env` 由 `env_file` 读入（含 `MASTER_KEY`）。健康探针走 **WS 升级握手**（`/api/stats/live` 的 101，见下"为什么不是 HTTP 200"），已做变异验证（探错端口 → `unhealthy`）。**遗留三条不粉饰**：(a) `web/dist` 需调用方先 `pnpm web:build` 再拷入或挂载，镜像内不构建前端；(b) 生产 `.env` 模板仍是 `.env.example`，没有独立的 `deploy/` 部署说明；(c) 镜像留着构建期工具链（~120MB），未做 multi-stage 搬运。
   - **为什么健康探针不是 HTTP 200**：`/api/*` 除 `auth/login` 外全量鉴权（安全红线），`/api/observability/health` 不带 cookie 回 **401**，而 `r.ok` 只在 2xx 为真 —— 拿它当探针 = **恒假**：容器明明是好的却永远 `(unhealthy)`，`restart` 策略会反复重启它。这不是"探针不够准"，是把**需要鉴权的端点**当成了健康端点。
3. **TierFlow 余额查询模板**：目前手动录入余额；是否配置自动查询模板待定
4. ~~**契约 v1.8.2 §15 订正挂账**~~ —— **已结**（v1.8.2 本体，`data.quota_per_unit` 层级已实测钉死）
5. ~~**§15.8 三条**（先烧套餐顺序 / 网关准入判断）待产品拍板~~ —— **已结**（ADR-0030，2026-10-16：套餐 key 优先于余额 key + 哨兵 `-1 → 1` + 回填腿）
6. ~~**出口探活目标**~~ —— **已结**（ADR-0033 + 契约 v1.14.2，2026-10-16）：新增 `EGRESS_ECHO_URL`，缺省值不动（换缺省会静默改变所有现存部署的探测语义），缺省字面量只有一份 `EGRESS_ECHO_URL_DEFAULT`（`src/egress/port.ts`）。**遗留三条不粉饰**：入口 B 仍默认关、`/test` 的假失败仍会写库、没有端点可达性的自检（拼错域名与被墙症状相同）。
7. ~~**保留策略未做（2026-10-16 挂账）**~~ —— **已结**（ADR-0032 + 契约 v1.14.1，2026-10-16）：八张会累积的表全部有真在运行的清理路径，清单与三条纪律见契约 **§0.6**。三个新旋钮 `AUDIT_RETENTION_DAYS`(180) / `TASK_RETENTION_DAYS`(7) / `CHANGE_LOG_KEEP_ROWS`(10000) 均有默认值，`.env.example` 已登记。**遗留三条不粉饰**（ADR-0032 末节）：新旋钮无范围校验（挡不住 `=0`）、没有"表多大"的观测面、`change_log` 的消费者停摆漏广播**无告警**。

## 11. 敏感与红线

- `.env` 含真实上游凭据 → **不入包不入库**；分发包一律用 `.env.example`
- `data/` 是运行态数据（含真实账号）→ 不入包
- 任何仓库文件不得出现 11 位手机号形状的字符串（测试用合成号）
- 上游 key 明文只在录入瞬间存在，库内一律 aes-256-gcm 密文
- 调试残留（会话封存件、workbench.db 等）都在 `.ekko-tmp/`，本包未含，接手方无需

## 12. 给接手 AI 的起步顺序

1. `pnpm install` → 2. `cp .env.example .env` → 3. `pnpm dev` + `pnpm web:dev` → 4. 管理后台登录 → 上游管理加一个供应商（Base URL）→ 账号池导入账号 → 用户组签发一个网关 key → 5. `curl http://127.0.0.1:4000/v1/chat/completions` 走通 → 6. 跑四闸（§8）→ 7. 通读 `docs/api-contract.md` 与 ADR-0021 / 0027 / 0028
