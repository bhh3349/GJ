# API 契约 v1.0-frozen

> 作者：管家 · 管理后端　｜　状态：**v1.0-frozen（PM 已核验冻结，见 ADR-0007）**　｜　当前版本：**v1.1.1**
> 本文件是**唯一接口事实源**。冻结后任何一方不得单方面改字段；改动走本文件 + `docs/adr/`。
> 覆盖范围：管理面 `/api/*`（REST + WS）。网关面 `/v1/*` 见 §10。
>
> **补遗 v1.0.1（2026-10-06，PM 已追认）**：§4 新增 `GET /api/groups/:id/keys`，并给 `reset` 的响应补上 `id`。动机与影响见 ADR-0008。
>
> **补遗 v1.0.2（2026-10-06）**：① §3 `POST /api/keys/:id/balance/refresh` 的响应补成 `202 {taskId}`（原文只写了用途、没写形状，而实现从第一天起就回 `202 {taskId}`，属于文本与实现的既存分歧，本次抹平）；② §5 新增「`POST /api/models/sync` 的字段映射」小节，把「只落能证明的、其余一律未知」写成明文规则；③ §5 补一句「同步不覆盖人工值」。除此之外 v1.0.1 全部内容不变 —— 无字段改名、无类型变更、无端点删除。动机与影响见 ADR-0009。
>
> **补遗 v1.0.3（2026-10-06）**：① §3 写明 `health` 等四个运行态字段的**来源与新鲜度**（网关进程 1s 批量镜像落 `key_runtime`，重启后归零），动机见 ADR-0010；② §6 新增「`costCents` 金额口径」小节 —— 契约此前**暴露**了 `costCents`（§4 Group、§6 usage 点）却从未**定义**它，未知单价该记 0 还是 null 无据可依；③ §10 把「无可用 key」与「候选用尽」两个 Terminating 结果拆开登记（`503 NO_AVAILABLE_KEY` ≠ `502 UPSTREAM_ERROR`，原文一句话把两者混在一起，与实现不符），并登记已在使用但未登记的 `504 UPSTREAM_TIMEOUT`。三处都是**文本对齐实现**，无字段改名、无类型变更、无端点增删。
>
> **勘误（2026-10-06，不升版）**：§7「关闭码」补登 **`1008`**（跨站 Origin 被拒）—— 服务端自 M4 起就发这个码，关闭码表漏登了这一行（路由者 M4 复核 P3 提出）。定性为**既有实现、文档补记**：无字段改名、无类型变更、无端点增删、**两侧实现零改动**（服务端已发 `1008`、前端 `live.ts` 已落 `default` 分支），同 v1.0.3 的 `504 UPSTREAM_TIMEOUT`，故**不 bump 版本**，留待下一次真正的字段/形状变更时统一升版。§7 另补「未登记码通则」一句，堵住"按码白名单实现"这个坑。
>
> **补遗 v1.0.4（2026-10-06）**：§10 错误码表按 **ADR-0011** 扩充两处**触发条件**（码值 / HTTP / `type` 全部不变）：① `RATE_LIMITED`(429) 增加「**网关池饱和**」触发路径（候选非空、0 次真实尝试、全候选并发已满），与用户组 RPM / TPM 超限共用码值；② `NO_AVAILABLE_KEY`(503) 增加「**候选存在但密文解不出**」的配置异常路径。同时写明 **429 一律带 `Retry-After`**，并明确「0 次真实尝试」**不得报 502**、不计入任何 key 的健康计数。无字段改名、无类型变更、无端点增删，`GATEWAY_ERROR_CODES` 无新增值。

> **补遗 v1.0.5（2026-10-06）**：M6-A「余额查询与展示」契约落地。① §2 Upstream 对象新增**只读**字段 `balancePreset`（内置 preset 命中情况，未命中为 `null`）；② §2/§3 新增两个**自测端点** `POST /api/upstreams/:id/balance-template/test`、`POST /api/keys/:id/test-balance`，共用一个 `BalanceTestResult` 响应体，**同步执行、绝不写库**；③ §2 新增「余额查询解析顺序与失败引导」小节，定义三段解析顺序（用户模板 → 内置 preset → `skipped`）、`hintCode` / `hint` 两个**非破坏**引导字段（**不进 `ERROR_CODES`、不影响 HTTP 状态**）；④ §6 `/api/stats/usage` 每个点补 `promptTokens` / `completionTokens` / `estimatedTokens` 三个非破坏字段（token 维度，不带钱）。无字段改名、无字段删除、无类型变更、`ERROR_CODES` 零新增，`balanceQuery` 模板契约**未改动**。动机与影响见 ADR-0012。

> **v1.1.0（2026-10-06，M6-B 接口阶段）**：新增 **§12 运维观测** —— ①网关**错误事件**结构化 schema（`GatewayErrorEvent`，落表 `gateway_error_events`）；②**健康指标**口径与 **60s 健康快照**（落表 `gateway_health_snapshots`）；③**四个只读查询端点** `/api/observability/*`（结构化 JSON、机器可读、支持时间窗 + 分型 + 分页过滤）；④**只读维护令牌** `READONLY_TOKEN`（独立于管理员会话、与 `ADMIN_TOKEN` 互斥、作用域仅 `/api/observability/*` 的 GET）。**新增 4 端点 / 2 表 / 1 令牌；无字段改名、无字段删除、无类型变更、`ERROR_CODES` 零新增、§10 网关错误码表零新增** —— 事件里的 `category` / `severity` 是**事件分类维度**（给机器分组用），不是错误码，不进 `ERROR_CODES`。版本号由补遗序列（v1.0.1–v1.0.5）升为 **v1.1.0**：本节开的是一个**新面**（新命名空间 + 新鉴权主体），与前面几版"文本对齐实现"不是同一档次。动机与影响见 ADR-0013。
>
> **勘误（2026-10-06，不升版）**：§12.1 的 `keyMasked` 一栏原写「无"那一把 key"可言时为 `null`」，与实现不符 —— sink 侧一律写 `****`（4 位掩码的退化形态，与 `usage_logs.key_masked` 同约定）；"没有哪把具体 key"这个事实由 `keyId` 为 `null` 承担，不由 `keyMasked` 为 `null` 承担。纯文本对齐实现：无字段改名、无类型变更、无端点增删。同批把 `docs/adr/0013` §7 的端口签名块按已落地的 `ErrorEventEntry` 订正（初稿的 `GatewayErrorEventInput` / `ts` / `model` 与实现不符）。§12 其余内容不变。

> **v1.1.1（2026-10-06，M6-B 接口阶段收口）**：补上**关联键 `x-request-id` 全链路透传**（冻结约束里早已写死、全仓尚未实现的那条缺口，PM 裁决"现在补、不留第二阶段"）。① §6 `GET /api/logs` 与 §12.1 `GatewayErrorEvent` 各新增**只读**字段 `requestId`（同键同值，`usage_logs` / `gateway_error_events` 各补一列），并新增同键精确匹配筛选位 `requestId`；② §6 新增「关联键 `x-request-id`」小节：入站缺失/非法/超长即重生成（白名单 `^[A-Za-z0-9._-]{8,64}$`）、响应头必回写、原样透传上游、落两表同值；③ §10 写明每个 `/v1/*` 请求都带该头（唯一的头侧新增要求）。**无字段改名、无字段删除、无类型变更、`ERROR_CODES` 零新增、§10 错误码表零新增** —— `requestId` 是**数据字段**（给"错误事件 ↔ 用量明细" join 用），不是错误码、不进 `ERROR_CODES`。动机与影响见 ADR-0014。

---

## 0. 通用约定

### 0.1 两套错误体，不许混

| 面 | 路径 | 成功 | 失败 |
|---|---|---|---|
| 管理面 | `/api/*` | 资源本体 | `{ code, message, details? }` |
| 网关面 | `/v1/*` | OpenAI 形状 | `{ error: { message, type, code } }` |

### 0.2 类型口径（强制）

| 概念 | 类型 | 说明 |
|---|---|---|
| 金额 | `int`，单位**分** | 永久禁止 float 存钱。拿不到就是 `null`，**不是 0** |
| token | `int` | 永远是整数，不出现 `1234.5` |
| 时间 | `string` ISO8601 **UTC** | `2026-10-06T12:00:00.000Z`。不带时区的时间串视为非法 |
| id | `string` | 不透明，前端不得解析 |
| 布尔 | `true/false` | 不用 `0/1` |

### 0.3 分页（所有列表统一）

请求：`?page=1&pageSize=20`　（`page` 从 1 起；`pageSize` 默认 20，**上限 200**，超限返回 400 `INVALID_PARAM`）

响应：
```json
{ "items": [], "total": 137, "page": 1, "pageSize": 20 }
```

`items` 为空是**合法**响应（空态），不是错误。前端不得因此显示错误态。

### 0.4 错误码总表

| code | HTTP | 含义 | 前端动作 |
|---|---|---|---|
| `INVALID_PARAM` | 400 | 参数校验失败，`details.field` 指明字段 | 表单标红 |
| `UNAUTHORIZED` | 401 | 未登录 | 跳登录 |
| `SESSION_EXPIRED` | 401 | 会话过期/被踢 | 跳登录 |
| `INVALID_CREDENTIALS` | 401 | 账号密码错 | 提示，清空密码 |
| `CSRF_REJECTED` | 403 | CSRF 校验未过 | 提示刷新重试 |
| `FORBIDDEN` | 403 | 已登录但无权 | 提示 |
| `NOT_FOUND` | 404 | 资源不存在 | 提示 + 返回列表 |
| `CONFLICT` | 409 | 唯一约束冲突（重名等） | 表单标红 |
| `REVISION_MISMATCH` | 409 | 乐观锁版本不符（并发编辑） | 提示"已被他人修改"，拉最新 |
| `UPSTREAM_HAS_KEYS` | 409 | 删上游但其下仍有 key | 弹二次确认，带 `force=true` 重发 |
| `UNPROCESSABLE` | 422 | 语义合法但业务拒绝 | 展示 message |
| `TOO_MANY_ATTEMPTS` | 429 | 登录限速（5 次/分钟） | 倒计时禁用按钮 |
| `INTERNAL` | 500 | 服务端异常 | 提示 + 可重试 |
| `UPSTREAM_UNREACHABLE` | 502 | 查余额时上游不可达 | key 余额标记为未知 |
| `TASK_FAILED` | 500 | 异步任务失败 | 展示任务 message |

### 0.5 鉴权与 CSRF

- 会话走 **`HttpOnly` + `SameSite=Lax` Cookie**（生产加 `Secure`）。**响应体里永远不出现 token**，前端 JS 读不到。
- `/api/*` **除 `POST /api/auth/login` 外全量鉴权**，无白名单例外。
- 写请求（`POST/PUT/PATCH/DELETE`）CSRF 校验顺序固定：`Origin` → `Sec-Fetch-Site`（缺失则跳过）→ `X-Requested-With`。不过则 403 `CSRF_REJECTED`。
- `ADMIN_TOKEN` 仅作 CI 机器令牌，走 `Authorization: Bearer <ADMIN_TOKEN>`，**不参与浏览器流程**，默认关闭。
- `READONLY_TOKEN`（v1.1.0 新增）是**只读维护令牌**：同一套 `Authorization: Bearer` 形式，但**作用域只有 `GET /api/observability/*`**，落在别的路径或用了写方法一律 `403 FORBIDDEN`。它**不等于**管理员会话、也不等于 `ADMIN_TOKEN`；未配置即关闭；两者配成同一个值会在启动时被拒。详见 §12.4。

---

## 1. 鉴权 `/api/auth/*`

### `POST /api/auth/login`
```json
{ "username": "admin", "password": "..." }
```
→ `200`
```json
{ "username": "admin", "expiresAt": "2026-10-07T12:00:00.000Z" }
```
`Set-Cookie: sid=...; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`

会话 24h **滑动续期**：每次通过鉴权的请求刷新 `expiresAt`。
失败：`INVALID_CREDENTIALS`(401) / `TOO_MANY_ATTEMPTS`(429，每 IP 5 次/分钟)。
副作用：写审计（成功与失败**都写**）。

### `POST /api/auth/logout`
无请求体 → `204`，清 Cookie，写审计。

### `GET /api/auth/session`
→ `200 { "username": "admin", "expiresAt": "..." }`
未登录 → `401 UNAUTHORIZED`。前端启动时调它决定是否跳登录页。

---

## 2. 上游 `/api/upstreams`

### Upstream 对象（全字段）
```json
{
  "id": "up_7f3a",
  "name": "my88",
  "baseUrl": "https://api.my88.com",
  "enabled": true,
  "keyCount": 6,
  "enabledKeyCount": 5,
  "totalBalance": 128400,
  "balanceUnknownKeyCount": 2,
  "tokenPlanKeyCount": 1,
  "balanceQuery": {
    "enabled": true,
    "url": "https://api.my88.com/user/balance",
    "method": "GET",
    "headers": { "Authorization": "Bearer {key}" },
    "body": null,
    "parse": {
      "balance": "data.balance_infos[0].total_balance",
      "currency": "data.balance_infos[0].currency",
      "remainingTokens": null,
      "expiresAt": null,
      "unit": "yuan"
    },
    "timeoutMs": 5000
  },
  "balancePreset": { "id": "openai", "label": "OpenAI 官方计费", "matchedBy": "host", "effective": false },
  "revision": 4,
  "createdAt": "2026-10-01T03:00:00.000Z",
  "updatedAt": "2026-10-06T09:12:00.000Z"
}
```

字段语义（**都是画师 §三.3 要的**）：

| 字段 | 可空 | 说明 |
|---|---|---|
| `totalBalance` | ✅ `null` | 本上游 balance 类 key 的合计，**分**。全部未知时为 `null`（不是 0） |
| `balanceUnknownKeyCount` | ❌ | 余额未知的 key 数。**未知 ≠ 0**，前端必须单独呈现 |
| `tokenPlanKeyCount` | ❌ | token-plan 类 key 数。这类**不进** `totalBalance` |
| `balanceQuery.parse.unit` | ❌ | `"yuan"`(×100→分) / `"cents"`(原样) / `"dollar"`(×100→分)。**统一到分是后端的责任** |
| `balanceQuery.enabled` | ❌ | `false` 表示该上游只能手动录入余额 |
| `balancePreset` | ✅ `null` | **只读**。按 `baseUrl` 的 host 命中的内置查询 preset；未命中为 `null`。传了也不生效（可推导字段，非入参） |
| `revision` | ❌ | 乐观锁。写请求带 `revision`，不符则 409 `REVISION_MISMATCH` |

> **安全**：`headers` 里的 `{key}` 是**占位符**，执行时才替换，**替换后的字符串永不落盘、永不进日志、永不回显**。`GET` 时返回的是含占位符的原始模板。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/upstreams?q=&enabled=&page=&pageSize=` | 列表 |
| `POST` | `/api/upstreams` | 建，body `{name, baseUrl, enabled?, balanceQuery?}` → `201` |
| `GET` | `/api/upstreams/:id` | 详情 |
| `PATCH` | `/api/upstreams/:id` | 改，body 任意子集 + `revision` |
| `DELETE` | `/api/upstreams/:id?force=false` | 删。有 key 且 `force!=true` → `409 UPSTREAM_HAS_KEYS`，`details: {keyCount: 6}` |
| `POST` | `/api/upstreams/:id/balance/refresh` | 按模板查该上游全部 key 余额 → `202 {taskId}` |
| `POST` | `/api/upstreams/:id/balance-template/test` | **自测**：用草稿模板真实打一次查询 → `200 BalanceTestResult`（见下） |

`baseUrl` 校验：必须 `http(s)://`，无尾斜杠（根路径除外）。不合法 → `400 INVALID_PARAM`。

### 余额查询解析顺序与失败引导

查询一个 key 的余额时，**按顺序取第一个可用的**（互斥、有优先级）：

```
① 用户模板 enabled=true   → 现有模板引擎（上文 balanceQuery，本版零改动）
② host 命中内置 preset     → 内置执行器（见 balancePreset）
③ 都没有                   → 不发请求，计入 skipped，并带 hintCode=BALANCE_QUERY_UNSUPPORTED
```

**内置 preset 永不覆盖用户模板、永不落库**：库里只有用户自己的 `balanceQuery`，preset 是每次查询时现算的判定。
本版注册表只有 `openai`（host = `api.openai.com`；`subscription − usage` 双请求相减，USD→分）。
其余上游（含自建 new-api / one-api）**不做猜测式兜底** —— 自建域名不可判、`quota` 单位随部署方配置、该端点鉴权用的是用户 access token 而非 `sk-` 接口 key，猜错会写出**看起来合理但错误**的余额。这正是"查不到就引导用户提供查询方法"的适用场景。

#### 失败引导字段（非破坏新增）

`hintCode` + `hint` 出现在①余额刷新任务的 `result`、②`BalanceTestResult`。**不是错误码**：不进 `ERROR_CODES`、不映射 HTTP 状态、不影响 `202` 任务本身的成败判定。

| `hintCode` | 触发 | 前端应做 |
|---|---|---|
| `BALANCE_QUERY_UNSUPPORTED` | 无用户模板且无 preset（`skipped`） | 引导用户提供查询方法（打开自测表单） |
| `BALANCE_PARSE_MISMATCH` | 请求成功但取值路径取不到（`unknown`） | 引导用户改字段路径，就地再自测 |
| `BALANCE_UPSTREAM_UNREACHABLE` | 不可达 / 超时 / 非 2xx（`failed`） | 提示稍后重试，**不**引导改配置 |
| `BALANCE_AUTH_REJECTED` | 401 / 403（`failed` 子型） | 提示 key 可能失效，或该端点需要另一种凭据 |
| `null` | `ok` 且解析出数 | 无需引导 |

- `hint`：`string | null`，面向用户的一句话（中文，可直接展示）。
- 刷新任务 `result` 在原 `{checked, ok, failed, unknown, skipped}` 基础上增加 `hintCode` / `hint` 两字段；计数语义**逐字不变**。
- **三型口径不变**（`unknown` / `failed` / `skipped` 仍分开计数，失败仍不写库，`balance_cents NULL = 未知 ≠ 0`）。`hintCode` 只是解释，不改变分型。

#### 自测端点请求体

`POST /api/upstreams/:id/balance-template/test`：

```json
{
  "keyId": "key_9c21",
  "url": "https://api.my88.com/user/balance",
  "method": "GET",
  "headers": { "Authorization": "Bearer {key}" },
  "body": null,
  "parse": { "balance": "data.balance_infos[0].total_balance", "currency": "data.currency", "remainingTokens": null, "expiresAt": null, "unit": "yuan" },
  "timeoutMs": 5000
}
```

- 请求体整体**可省略**（或传 `{}`）→ 用该上游已存的 `balanceQuery` 作草稿。
- **不含 `enabled`**：`enabled` 是持久化语义，一次自测没有"启用/停用"之分；传了忽略。
- `keyId` **可选**：省略时取该上游第一把 `enabled=true` 且 `category="balance"` 的 key；显式指定时必须属于该上游（否则 `404 NOT_FOUND`）。上游下无可用 key → `422 UNPROCESSABLE`。
- 字段合法性同 `balanceQuery`：`url` 必须 http(s)、`method` 仅 `GET|POST`、`timeoutMs` 正数、`unit` 在枚举内，否则 `400 INVALID_PARAM`（`details.field` 指到具体字段）。

`POST /api/keys/:id/test-balance`：**无请求体**，用该 key 所属上游的**生效查询方式**（① 用户模板 → ② 内置 preset）；两条都无 → `422 UNPROCESSABLE`。

**安全**：草稿模板即用即弃 —— 不落盘、不进日志、不进审计；替换过 `{key}` 的 URL 不回显（详见 `endpoint` 字段）。

#### `BalanceTestResult`（两个自测端点共用）

```json
{
  "ok": true,
  "keyId": "key_9c21",
  "maskedKey": "****a1b2",
  "source": "user-template",
  "presetId": null,
  "endpoint": "https://api.my88.com/user/balance",
  "httpStatus": 200,
  "durationMs": 132,
  "parsed": { "balance": 12345, "currency": "CNY", "remainingTokens": null, "expiresAt": null, "unit": "yuan" },
  "raw": { "data": { "balance_infos": [ { "total_balance": 123.45 } ] } },
  "errorCode": null,
  "hintCode": null,
  "hint": null
}
```

| 字段 | 说明 |
|---|---|
| `source` | `"user-template"` \| `"preset"` —— 本次实际用的是哪一条（③ 走不到，无查询方式时直接 422） |
| `endpoint` | **规范化后的 `协议//host/path`**，已剥掉 query。绝不回显替换过 `{key}` 的 URL |
| `parsed.balance` | 分；`null` = 取不到（与"0"严格区分）。**自测永不写库**，所以 `balanceUpdatedAt` / `balanceSource` 不因此改变 |
| `raw` | 上游响应体，**已抹掉明文 key 的所有出现**并截断至 8KB。取值路径没配对时，用户靠它看出来该填什么 |
| `errorCode` | `null`（成功）\| `"UPSTREAM_UNREACHABLE"` \| `"PARSE_FAILED"`；HTTP 仍是 `200` |

**状态码约定**：自测是**诊断**，业务性的"上游不可达 / 取不到值"一律 `200` + `ok:false`（前端要展示诊断结论，不该被错误分支吃掉）；只有**请求本身**有问题才 4xx/5xx，且复用既有码：

| 情形 | 响应 |
|---|---|
| 上游 / key 不存在 | `404 NOT_FOUND` |
| 草稿模板形状非法（`url` 非 http(s)、`method` 非 GET/POST、`timeoutMs` 非正、`unit` 不在枚举） | `400 INVALID_PARAM`（`details.field` 指到具体字段） |
| 无用户模板且无 preset（无查询方式可测） | `422 UNPROCESSABLE`（复用，message 指引配置模板） |
| 未登录 | `401 UNAUTHORIZED` |

---

## 3. Key `/api/keys`

### Key 对象（全字段，覆盖画师 §三.2）
```json
{
  "id": "key_9c21",
  "upstreamId": "up_7f3a",
  "label": "my88-主号-1",
  "maskedKey": "****a1b2",
  "category": "balance",
  "enabled": true,
  "weight": 1,
  "balance": 12345,
  "balanceCurrency": "CNY",
  "balanceUpdatedAt": "2026-10-06T09:12:00.000Z",
  "balanceSource": "template",
  "tokenPlan": null,
  "health": "healthy",
  "cooldownUntil": null,
  "consecutiveFailures": 0,
  "lastFailureReason": null,
  "lastFailureAt": null,
  "todayTokens": 84213,
  "revision": 2,
  "createdAt": "2026-10-01T03:00:00.000Z",
  "updatedAt": "2026-10-06T09:12:00.000Z",
  "deletedAt": null
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `maskedKey` | `"****a1b2"` | **后端唯一出口**。明文只在 `POST` 请求体里进，之后**任何**响应/日志/导出都不出现 |
| `category` | `"balance"` \| `"token-plan"` | `token-plan` 时 `balance` 恒为 `null`，看 `tokenPlan` |
| `balance` | `int`(分) \| `null` | `null` = **未知**（查不到或从未录入）。前端显示"未知"，不得显示 0 |
| `balanceSource` | `"manual"` \| `"template"` \| `null` | 数据来源，用于 UI 标注可信度 |
| `tokenPlan` | 对象 \| `null` | `{ "remainingTokens": int, "expiresAt": ISO8601\|null }` |
| `health` | `"healthy"` \| `"cooling"` \| `"disabled"` | **网关运行态**，管理端只读。`disabled` 优先于 `cooling` |
| `cooldownUntil` | ISO8601 \| `null` | `health=cooling` 时非空 |
| `consecutiveFailures` | int | 连续失败次数，决定冷却档位 |
| `lastFailureReason` | 枚举 \| `null` | `AUTH_INVALID` \| `RATE_LIMITED` \| `INSUFFICIENT_BALANCE` \| `UPSTREAM_ERROR` \| `NETWORK` |
| `todayTokens` | int | 自然日（UTC）累计 token |

> `health` 是**网关进程内**的运行时状态。管理端**不能写** `health`，只能写 `enabled`。`enabled=false` ⇒ 后端返回 `health="disabled"`，即使此前在冷却中。
>
> **这四个字段的来源与新鲜度（ADR-0010）**：网关进程是 `key_runtime` 表的**唯一写者**，它按约 **1s** 一次的节奏把内存里的运行态批量镜像进去（攒批、去重、只在值真的变了才写，且**不在 `/v1/*` 请求线程上**执行）。因此：管理端读到的运行态**最多滞后 1s**；`?health=cooling` 筛选与健康灯的口径由此表提供，而不是「永远 health」。
> **重启后归零**：`key_runtime` **不参与冷启动**——网关启动时不恢复冷却与连续失败计数，第一个镜像周期会把全量状态（含归零的那些）写回，管理端在重启后 1s 内看到的就是归零后的真实值。这是**既定降级**，理由与备选方案见 ADR-0010。
> 注意 `failCount`（累计失败总数）**只在 `/internal/snapshot` 上存在**，不落库、不在本对象里 —— 契约没承诺它。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/keys?upstreamId=&category=&enabled=&health=&q=&page=&pageSize=&includeDeleted=` | 列表（默认 `maskedKey`，默认不含已软删） |
| `POST` | `/api/keys` | 建，body `{upstreamId, key, category, label?, weight?, balance?, tokenPlan?}` → `201` |
| `GET` | `/api/keys/:id` | 详情；已软删的 key 返回 404 `NOT_FOUND`（`?includeDeleted=true` 显式可查） |
| `PATCH` | `/api/keys/:id` | 改 `{label?, enabled?, weight?, category?, tokenPlan?, revision}` |
| `DELETE` | `/api/keys/:id` | 删 → `204` |
| **`PUT`** | **`/api/keys/:id/balance`** | **手动录入余额**（见下） |
| `POST` | `/api/keys/:id/balance/refresh` | 按模板查单个 key 余额 → `202 {taskId}`（异步，轮询 `GET /api/tasks/:id`） |
| `POST` | `/api/keys/:id/test-balance` | **自测**：用该 key 的生效查询方式真实打一次 → `200 BalanceTestResult`（同步、不写库，见 §2） |
| `POST` | `/api/keys/batch` | `{ids: [], action: "enable"\|"disable"}` → `{updated: 5}` |
| `POST` | `/api/keys/balance/refresh` | 批量查余额 → `202 {taskId}` |

### `PUT /api/keys/:id/balance` — 手动录入

请求：
```json
{ "balance": 12345, "currency": "CNY", "note": "客服核对" }
```
- `balance`：`int` 分，**必填**，可为 `0`（0 是合法值，与"未知"严格区分）。
- `currency`：可选，默认取上游配置。
- 响应 `200` 返回完整 Key 对象，其中 `balanceSource="manual"`、`balanceUpdatedAt=now`。

**把 balance 置回"未知"**：`{ "balance": null }` → `balance=null`、`balanceSource=null`。用于撤销错误录入。

> 这是"防造假"的关键：`0` 和 `null` 在契约层就是两个值，前端不能把它们渲染成同一个东西。

### `POST /api/keys` 请求体
```json
{
  "upstreamId": "up_7f3a",
  "key": "sk-xxxxxxxxxxxxxxxx",
  "category": "balance",
  "label": "my88-主号-1",
  "weight": 1,
  "balance": null,
  "tokenPlan": null
}
```
`key` 明文**只在此处进入系统**，服务端立即 aes-256-gcm 加密落盘，响应只回 `maskedKey`。

---

## 4. 用户组 `/api/groups`

### Group 对象（覆盖画师 §三.7）
```json
{
  "id": "grp_2b91",
  "name": "内部-文案组",
  "gatewayKeyMasked": "****9f3c",
  "rpm": 600,
  "tpm": 120000,
  "dailyQuota": 5000000,
  "dailyQuotaUsed": 1832450,
  "todayUsage": { "requests": 412, "tokens": 1832450, "costCents": 4820 },
  "keyCount": 1,
  "enabled": true,
  "revision": 1,
  "createdAt": "2026-10-01T03:00:00.000Z",
  "updatedAt": "2026-10-06T09:12:00.000Z"
}
```
`rpm` / `tpm` / `dailyQuota` 为 `null` ⇒ **不限**。（画师 §三.7 明确要求。）

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/groups?q=&page=&pageSize=` | 列表 |
| `POST` | `/api/groups` | `{name, rpm?, tpm?, dailyQuota?}` → `201`；**建组时自动签发第一个网关 key**，响应**额外带 `gatewayKey` 明文（仅此一次）** |
| `GET` | `/api/groups/:id` | 详情（**不含**明文） |
| `PATCH` | `/api/groups/:id` | `{name?, rpm?, tpm?, dailyQuota?, enabled?, revision}` |
| `DELETE` | `/api/groups/:id` | → `204` |
| `GET` | `/api/groups/:id/keys?page=&pageSize=` | 该组网关 key 列表（**不含**明文）→ 分页信封，项见下 |
| `POST` | `/api/groups/:id/keys` | 再签发一把 → `201 {id, gatewayKey, maskedKey, createdAt}`，**明文仅此一次** |
| `POST` | `/api/groups/:id/keys/:keyId/reset` | 重置 → `200 {id, gatewayKey, maskedKey, createdAt}`，旧 key **立即失效** |
| `DELETE` | `/api/groups/:id/keys/:keyId` | → `204` |

> **网关 key 明文纪律**：只在创建/重置响应里出现**一次**，之后绝不可再取回。前端创建弹窗关闭即从内存丢弃，**不缓存、不写 localStorage**。库内只存 sha256 摘要。

### 网关 key 列表项（`GET /api/groups/:id/keys`）
```json
{
  "id": "gwk_9a12",
  "maskedKey": "****9f3c",
  "createdAt": "2026-10-01T03:00:00.000Z"
}
```
- `id` 就是 `:keyId` 的取值 —— **本端点存在的唯一理由**：`Group` 对象只暴露 `gatewayKeyMasked`，前端拿不到 `keyId`，重置/吊销两个端点无从触达。
- **不返回** `updatedAt`：网关 key 的改法是「删旧行 + 插新行」（重置即失效），`updated_at` 恒等于 `created_at`，回一个永远相等的字段只会让人以为它可以不同。
- 排序固定 `createdAt, id`，因此 **`Group.gatewayKeyMasked` 恒等于列表第一项的 `maskedKey`**（组内至少 1 把 key 时）。
- 明文、`key_hash` 均不出现在本端点，任何情况下都不出现。
- **吊销是硬删**（行不在即失效），不会出现在本列表；痕迹只留在 `audit_log`。因此本端点没有 `includeDeleted`（契约 §3 上游 key 的软删口径不适用于网关 key）。
- 未知组 → `404 NOT_FOUND`；`:keyId` 不属于该组时，重置/吊销一律 `404`（不返回 403，不泄漏 key 的存在性）。

---

## 5. 模型 `/api/models`

### Model 对象（覆盖画师 §三.4）
```json
{
  "id": "mdl_5e10",
  "name": "deepseek-chat",
  "displayName": "DeepSeek Chat",
  "upstreamId": "up_7f3a",
  "type": "chat",
  "capabilities": ["stream", "function_call", "json_mode"],
  "contextLength": 65536,
  "price": { "inputPer1k": 100, "outputPer1k": 200 },
  "availableKeyIds": ["key_9c21", "key_9c22"],
  "enabled": true,
  "lastSyncedAt": "2026-10-06T09:00:00.000Z",
  "revision": 1,
  "createdAt": "2026-10-01T03:00:00.000Z",
  "updatedAt": "2026-10-06T09:00:00.000Z"
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `type` | `chat` \| `embedding` \| `image` \| `audio` \| `rerank` | |
| `capabilities` | `stream` \| `function_call` \| `vision` \| `json_mode` 的数组 | |
| `contextLength` | `int` \| `null` | 上游没给就是 `null`，前端显示 `—` |
| `price` | 对象 \| `null` | `inputPer1k`/`outputPer1k` 单位**分**。**缺失是 `null` 不是 0**，前端显示 `—` |
| `availableKeyIds` | `string[]` | 当前**可服务**该模型的 key（已启用、非冷却、余额 > 0）。空数组 = 暂不可用 |
| `enabled` | bool | 决定是否出现在 `/v1/models`。验收 4 要求两边**逐项 0 差异** |

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/models?upstreamId=&type=&capability=&enabled=&q=&page=&pageSize=` | 卡片列表 |
| `GET` | `/api/models/:id` | 档案卡详情 |
| `PATCH` | `/api/models/:id` | `{enabled?, type?, capabilities?, contextLength?, price?, displayName?, revision}` |
| `POST` | `/api/models/sync` | `{upstreamId?}` 省略则全量 → `202 {taskId}` |

`POST /api/models/sync` 是**异步任务**（上游拉取可能慢），不阻塞 HTTP。前端轮询 `GET /api/tasks/:id` 拿真实进度——**不许做假进度条**。

### `POST /api/models/sync` 的字段映射（ADR-0009）

上游 `/v1/models` 只回 `{id, object, created, owned_by}` —— **没有**能力、上下文长度、价格。所以同步只写它确实知道的东西：

| 字段 | 同步写入 | 理由 |
|---|---|---|
| `name` | 上游 `id` | 唯一有证据的字段 |
| `type` | **按名字推断**（规则表见 ADR-0009），命不中为 `chat` | 推断是显式的、可覆盖的：建档之后以库里现值为准，`PATCH /api/models/:id` 改过就不再被同步回退 |
| `displayName` | `null` | 上游不给；不拿 `name` 顶替 |
| `capabilities` | `[]` | 空数组 = **未声明**，不是「没有任何能力」 |
| `contextLength` | `null` | 未知，前端显示 `—` |
| `price` | `null` | 未知 **≠ 0**。编一个价格会让统计口径从第一秒起就是假的 |
| `enabled` | 建档写 `1` | 建档即启用；是否真正服务由管理员在档案卡上关 |
| `lastSyncedAt` | 本次同步时间 | 回答「上次拉到数据是什么时候」；内容没变也会刷新，前端用它判新鲜度 |

两条不变量（改代码前先读这两条）：

1. **永不编造**：上游没给的字段一律留空。任何「合理默认值」都是造假。
2. **未知不覆盖已知**：同步只在**建档**时写这些字段；对已存在的模型，`null`/`[]` 不是「新值」，不构成覆盖理由。管理员 `PATCH` 补的 `price`/`capabilities`/`contextLength`/`type`/`displayName` 在下一次同步后原样保留 —— 否则「同步一次就抹掉刚录的价格」比不填更坏。

任务 `result` 里带 `inferredTypeCount`：本次**建档**时靠推断定类型的条数。管理员据此知道有多少条 `type` 是猜的、不是从上游读来的。

### 任务对象 `GET /api/tasks/:id`
```json
{
  "id": "task_3f7a",
  "type": "model_sync",
  "status": "running",
  "progress": { "done": 34, "total": 88 },
  "message": null,
  "result": null,
  "startedAt": "2026-10-06T09:00:00.000Z",
  "finishedAt": null
}
```
`status`：`queued` \| `running` \| `succeeded` \| `failed`。`failed` 时 `message` 非空、`result` 为 `null`。

---

## 6. 统计 `/api/stats/*`

### `costCents` 金额口径（强制，全节通用）

`costCents` 由**网关进程在用量落库时**按上游真实模型名算一次，存进 `usage_logs.cost_cents`；本节所有 `costCents`（`/api/stats/overview` 的 `todayUsage`、`/api/stats/usage` 的 `series[].points`、§4 `Group.todayUsage`）都是对它的 `SUM`。

```
costCents = round(promptTokens    / 1000 * priceInputPer1k)
          + round(completionTokens / 1000 * priceOutputPer1k)      // 单位：分，整数
```

**单价缺失（`models.price_*_per_1k = NULL`）时该项按 `0` 计，不做任何估算、不按同类模型代填。** 于是 `costCents=0` 有两种含义：真的免费/无消耗，或**单价未知**——调用方要区分就必须看模型档案里的价格是否为 `null`，不能把 `0` 当"免费"。

> 与 §0.2「拿不到就是 `null`，不是 0」的关系：那条管的是**余额**（未知余额必须 `null`，因为它是可查询的事实）；而 `costCents` 是**统计聚合**，桶里缺失必须补 0（同 §6「缺失桶补 `0`」）。两者不冲突，但**未知单价计 0 会低报成本**——这是已知缺口，等 M4/M5 决定要不要引入「未知价格触发的估算标记」，届时走契约 + ADR。

### `GET /api/stats/overview?window=60s`
仪表盘 4 张卡 + key 健康灯。
```json
{
  "window": "60s",
  "generatedAt": "2026-10-06T09:12:00.000Z",
  "qps": 3.42,
  "successRate": 0.9941,
  "requests": 205,
  "errors": 2,
  "tokens": { "prompt": 120000, "completion": 34000, "total": 154000 },
  "balance": {
    "global": {
      "totalBalance": 512300,
      "balanceUnknownKeyCount": 3,
      "tokenPlanKeyCount": 2,
      "byUpstream": [
        { "upstreamId": "up_7f3a", "name": "my88", "totalBalance": 384800, "balanceUnknownKeyCount": 2, "tokenPlanKeyCount": 1 }
      ]
    }
  },
  "keyHealth": [
    { "keyId": "key_9c21", "maskedKey": "****a1b2", "upstreamId": "up_7f3a", "health": "healthy" },
    { "keyId": "key_9c22", "maskedKey": "****c3d4", "upstreamId": "up_7f3a", "health": "cooling", "cooldownUntil": "2026-10-06T09:17:00.000Z" }
  ]
}
```

> `window` 必须由**后端**给（画师明确要求）。前端不得用本地时间自算 QPS，否则对不上。

### 余额三口径 `GET /api/stats/balance`
```json
{
  "global": {
    "totalBalance": 512300,
    "balanceKeyCount": 6,
    "balanceUnknownKeyCount": 3,
    "tokenPlanKeyCount": 2,
    "currency": "CNY",
    "byUpstream": [
      {
        "upstreamId": "up_7f3a", "name": "my88",
        "totalBalance": 384800,
        "balanceKeyCount": 4,
        "balanceUnknownKeyCount": 2,
        "tokenPlanKeyCount": 1,
        "keys": [
          { "keyId": "key_9c21", "maskedKey": "****a1b2", "balance": 12345, "balanceUpdatedAt": "...", "balanceSource": "template" },
          { "keyId": "key_9c23", "maskedKey": "****e5f6", "balance": null, "balanceUnknownKeyCount": 1 }
        ]
      }
    ]
  }
}
```

**三条不可违背的规则**（ADR-0003）：
1. 合计**只统计 `category="balance"` 的 key**。token-plan 类不进金额。
2. 全局合计 = 各上游合计之和。
3. 任一层只要有未知项，`balanceUnknownKeyCount` 必须 > 0，前端必须单独呈现。**未知不得补 0 计入合计。**
4. 已软删（`deletedAt` 非空）的 key **不进**任何合计与未知计数，历史日志外键保留。

### `GET /api/stats/usage`
覆盖画师 §三.5，**后端返回序列化好的时间轴，前端不二次聚合**。

| 参数 | 取值 | 必填 |
|---|---|---|
| `from` / `to` | ISO8601 | ✅ |
| `groupBy` | `key` \| `upstream` \| `group` \| `model` | ✅ |
| `bucket` | `1m` \| `5m` \| `1h` \| `1d` | ✅ |
| `upstreamId` / `groupId` / `model` | 过滤 | ❌ |

```json
{
  "from": "2026-10-05T09:00:00.000Z",
  "to": "2026-10-06T09:00:00.000Z",
  "bucket": "1h",
  "groupBy": "upstream",
  "axis": ["2026-10-05T09:00:00.000Z", "2026-10-05T10:00:00.000Z"],
  "series": [
    {
      "key": "up_7f3a",
      "label": "my88",
      "points": [
        { "t": "2026-10-05T09:00:00.000Z", "requests": 120, "tokens": 84000, "promptTokens": 60000, "completionTokens": 24000, "estimatedTokens": 0, "costCents": 320, "errors": 1 }
      ]
    }
  ],
  "isEstimatedTokenCount": 12
}
```
- `axis` 与每个 `series[].points` **等长且下标对齐**，缺失桶补 `0`（这里是计数，补 0 是对的——与余额的 `null` 语义不同）。
- `isEstimatedTokenCount`：`is_estimated=1` 的调用条数。前端图表需可标注"含估算"。
- 每个点另带 `promptTokens` / `completionTokens` / `estimatedTokens`（同一桶内 `is_estimated=1` 的调用条数）——token 维度拆到点上，前端才能画输入/输出双线、并**只**给含估算的那几段打标。`tokens` 恒等于 `promptTokens + completionTokens`；`isEstimatedTokenCount` 恒等于全轴 `estimatedTokens` 之和。
- `costCents` 保留（金额口径见上方「`costCents` 金额口径」）。**本轮不下线、不新增计费**。

### `GET /api/logs` — 调用记录
`?from=&to=&groupId=&model=&status=&upstreamId=&keyId=&requestId=&page=&pageSize=&includeDeleted=`（默认不查已软删资源；`includeDeleted=true` 时按 id 过滤仍可命中已软删的 upstream/key/group；`requestId` 见下方「关联键」）

```json
{
  "items": [
    {
      "id": "log_88a1",
      "ts": "2026-10-06T09:11:58.000Z",
      "requestId": "3f9a1c2e-7d4b-4a11-9c88-2b6f0e5d1a77",
      "groupId": "grp_2b91",
      "model": "deepseek-chat",
      "upstreamId": "up_7f3a",
      "keyMasked": "****a1b2",
      "status": 200,
      "errorCode": null,
      "tokens": { "prompt": 812, "completion": 340, "total": 1152, "isEstimated": false },
      "latencyMs": 842,
      "ttfbMs": 210,
      "stream": true
    }
  ],
  "total": 1, "page": 1, "pageSize": 20
}
```
`keyMasked` 只 4 位。**日志里永远没有 key 明文、没有请求体明文里的 Authorization。**

#### 关联键 `x-request-id`（全链路，v1.1.1 / ADR-0014）

同一个客户端请求的**唯一关联键**。它把一次 `/v1/*` 调用在 `usage_logs`、`gateway_error_events` 与上游侧日志之间串成一条线——第二阶段的 AI 助手「读日志 → 定位问题」靠它，不靠时间窗 + 模型名猜。

| 环节 | 规则 |
|---|---|
| 取值 | 请求进入时读 `x-request-id`；**缺失、非法或超长**一律重新生成。合法格式：`^[A-Za-z0-9._-]{8,64}$`（白名单字符，保证它能安全进响应头、进查询串、进日志文本） |
| 回写 | 无论入站有没有，响应头**一定**带 `x-request-id` = 最终生效的那个值。调用方按回执排障，不靠猜 |
| 透传 | 同一个值**原样**透传上游，上游自己的日志能对上 |
| 落库 | `usage_logs.request_id` 与 `gateway_error_events.request_id` 各一列、同键同值。两表都可查：`GET /api/logs?requestId=`、`GET /api/observability/errors?requestId=` |
| 热路径 | 生成/校验/回写全是 O(1) 内存操作，**不新增任何同步 DB 写**（§9） |

- 入站值**不信任、也不报错**：只做格式白名单校验，不过就重新生成。一个坏 ID 不该让调用方的请求失败（对比 §0.4 的 400 只用于"参数不合法会导致结果不可信"）。
- 非法判定含**超长与非法字符**：把任意长的入站串原样回写，等于替调用方污染响应头与日志列。
- `request_id` ≠ `id`：`id` 是**记录行**的主键（一行日志一个），`request_id` 是**调用**的键——一次调用 = 1 行 `usage_logs` + 0..n 条 `gateway_error_events`。0 次真实尝试的终态（429 池饱和 / 503 密文不可解，见 §10）同样带 `requestId`，它们是**最需要定位**的那几条。
- 历史行（本列上线前写入的）为 `NULL`，与前端的 `null` 渲染一致：**`null` 表示"当时还没有这个字段"，不表示"这次调用没有 ID"**。

### `GET /api/audit` — 审计（最小集）
覆盖：**登录 / 登出 / 所有写操作**。
```json
{ "items": [ { "id": "aud_1", "ts": "...", "actor": "admin", "ip": "127.0.0.1", "action": "key.create", "targetType": "key", "targetId": "key_9c21", "result": "ok" } ], "total": 1, "page": 1, "pageSize": 20 }
```

---

## 7. 实时通道 `WS /api/stats/live`

### 握手
1. 浏览器带 Cookie 发起 `GET ws://<host>:4001/api/stats/live`（**URL 里不带 token**）。
2. 服务端校验会话。失败 → 立即关闭，码 **`4401`**。
3. 前端**首帧**发 `{"type":"auth"}`（**仅就绪确认，不传 token**）。
4. 服务端回 `{"type":"ready"}`。**5s 内未就绪 → 前端主动断开**（服务端也会关，码 `4408`）。

### 关闭码

| code | 含义 | 前端动作 |
|---|---|---|
| `4401` | 会话失效 | 跳登录页 |
| `4408` | 就绪超时 | **重连一次** |
| `1012` | 服务重启 | 退避重连（1s→2s→4s→max 15s） |
| `1008` | 跨站 Origin 被拒（未通过 §0.5 同源判定）—— **既有实现、文档补记** | 退避重连（走 `default` 分支，同 `1012`；源侧修好即自愈） |
| `1000` | 正常关闭（登出） | 不重连 |

**未登记码通则**：上表以外的**任何**关闭码 —— 含异常断开的 `1006`、浏览器侧的 `1005`/`1009` —— 一律走 `default` 分支：退避重连（1s→2s→4s→max 15s）。前端**不得**实现成"只有登记过的码才重连"的白名单，否则新增码会变成静默断连。

### 消息结构

**`ready`**
```json
{ "type": "ready", "serverTime": "2026-10-06T09:12:00.000Z", "intervalMs": 1000 }
```

**`metrics`** — 每 **1s** 一帧
```json
{
  "type": "metrics",
  "window": "60s",
  "serverTime": "2026-10-06T09:12:00.000Z",
  "qps": 3.42,
  "successRate": 0.9941,
  "requests": 205,
  "tokensTotal": 154000,
  "balanceGlobal": 512300,
  "balanceUnknownKeyCount": 3
}
```

**`key_health`** — 状态变化时**立即**推（不等到下一帧）
```json
{
  "type": "key_health",
  "serverTime": "...",
  "keyId": "key_9c22",
  "upstreamId": "up_7f3a",
  "maskedKey": "****c3d4",
  "health": "cooling",
  "cooldownUntil": "2026-10-06T09:17:00.000Z",
  "lastFailureReason": "RATE_LIMITED"
}
```

**`balance`** — 余额变动时推（验收 3 要求 Web 端 **5s 内**呈现）
```json
{
  "type": "balance",
  "serverTime": "...",
  "keyId": "key_9c21",
  "maskedKey": "****a1b2",
  "balance": 11245,
  "balanceUpdatedAt": "...",
  "balanceSource": "template",
  "globalTotalBalance": 511200,
  "balanceUnknownKeyCount": 3
}
```

**`task`** — 异步任务进度
```json
{ "type": "task", "taskId": "task_3f7a", "status": "running", "progress": { "done": 34, "total": 88 }, "message": null }
```

**`error`** — 服务端主动报错
```json
{ "type": "error", "code": "INTERNAL", "message": "..." }
```

> **前端契约**：断线期间**不得**把上一帧数字继续当实时值展示。画师已在需求里要求"卡片右上角显示『已断开·重连中』"，后端 `serverTime` 用于判断帧是否新鲜。

---

## 8. 画师 §三 字段依赖对照表

| # | 画师要求 | 落在本契约 | 状态 |
|---|---|---|---|
| 1 | 分页 `{items,total,page,pageSize}` + 错误 `{code,message}` | §0.1 §0.3 | ✅ |
| 2 | Key 全字段（含 `maskedKey`/`category`/`balance` 可空/`health`/`lastFailureReason`/`todayTokens`） | §3 Key 对象 | ✅ |
| 3 | Upstream 全字段 + 余额模板编辑字段 | §2 Upstream 对象 | ✅ 模板字段 = `url/method/headers/body/parse/timeoutMs/enabled` |
| 4 | Model 全字段（type/capabilities/contextLength/price 可空/availableKeyIds） | §5 Model 对象 | ✅ |
| 5 | `groupBy`/`from`/`to`/`bucket`，返回序列化时间轴 | §6 `/api/stats/usage` | ✅ `axis` + `series[].points` 下标对齐 |
| 6 | WS 消息结构 + 窗口口径示例 | §7 | ✅ |
| 7 | Group 全字段，配额 `null` = 不限 | §4 Group 对象 | ✅ |

---

## 9. 与网关面的边界

- 管理面**不改**网关运行态：`health`/`cooldownUntil`/`consecutiveFailures` 只读。
- 反向的一条同样成立：**`key_runtime` 只由网关进程写**，管理面只读（单写者原则）。写入是约 1s 一次的**批量镜像**，不落在 `/v1/*` 请求线程上 —— 见 ADR-0010。
- 管理面写 key 时递增 `revision`；网关靠共享 SQLite(WAL) + `change_log` + 1s 轮询兜底感知变更。
- **热路径零同步 DB 写**：`/v1/*` 上的用量日志异步批量落库，不得挡在 TTFB 前面。

## 10. 网关面 `/v1/*`（路由者负责，此处仅登记口径）

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | stream / 非 stream |
| `GET /v1/models` | 集合必须与模型档案 `enabled=true` **逐项 0 差异**（验收 4） |
| `POST /v1/embeddings` | |
| `image` / `audio` / `rerank` | 建档案，接口返回 `501 UNSUPPORTED_ENDPOINT` |
| `GET /internal/snapshot` | 本机观测 |

- 错误体：`{ "error": { "message": "...", "type": "...", "code": "..." } }`。
- 每个 `/v1/*` 请求都带 `x-request-id`：入站值合法则沿用、否则重新生成，并在**响应头**回写最终值；同一值原样透传上游，并落 `usage_logs` / `gateway_error_events` 的 `request_id` 列（口径见 §6「关联键」）。该头是本节的**唯一新增要求**，不动错误码表、不动错误体。

**`/v1/*` 错误码登记表**（改动需同步 `src/gateway/errors.ts` 的 `GATEWAY_ERROR_CODES`）

| code | HTTP | `type` | 触发条件 |
|---|---|---|---|
| `INVALID_REQUEST` | 400 | `invalid_request_error` | body 不是 JSON 对象、缺 `model`/`messages`/`input` |
| `INVALID_API_KEY` | 401 | `authentication_error` | 网关 key 缺失/未知/已吊销（**不区分**"不存在"与"已禁用"，避免探测窗口） |
| `NOT_FOUND` | 404 | `invalid_request_error` | `/v1/*` 下未知路径 |
| `RATE_LIMITED` | 429 | `rate_limit_error` | 用户组 RPM / TPM 超限，**或网关池饱和**（候选非空、0 次真实尝试、全候选并发已满，ADR-0011） |
| `QUOTA_EXCEEDED` | 429 | `insufficient_quota` | 用户组日配额（token）超限 |
| `UNSUPPORTED_ENDPOINT` | 501 | `invalid_request_error` | image / audio / rerank 等未实现端点 |
| `UPSTREAM_ERROR` | 502 | `api_error` | **候选存在但用尽**：重试上限内每把 key 都失败 |
| `NO_AVAILABLE_KEY` | 503 | `server_error` | **候选为空**：该模型一把可用 key 都没有；或**候选存在但密文解不出**（元数据在、`secrets.resolve === null`，0 次真实尝试的配置异常，ADR-0011） |
| `UPSTREAM_TIMEOUT` | 504 | `api_error` | 所有尝试都超时（首字节超时，默认 120s） |

> 502 与 503 的分界是**候选集是否为空**，不是"最终有没有成功"：池子里有 key 但全试完仍失败 → `502 UPSTREAM_ERROR`；一把都选不出来 → `503 NO_AVAILABLE_KEY`。两者的排障含义完全不同（前者查上游，后者查池子/档案）。
> **0 次真实尝试不是上游故障（ADR-0011）**：候选非空却在派发前被并发槽位全部挡回（`skippedSaturated > 0` 且无可解析异常）→ `429 RATE_LIMITED` + `Retry-After: 1`，message 明示 `pool saturated`；候选里有 key 但密文解析不出 → `503 NO_AVAILABLE_KEY`（message 明示 `unresolvable`）。两条都**不得报 502**，且都是 0 次真实尝试、`failureReason: null` —— 不计入任何 key 的健康计数。
> **429 响应一律带 `Retry-After`（秒，int）**：用户组 RPM / TPM 超限、日配额超限（`QUOTA_EXCEEDED`）与网关池饱和（`RATE_LIMITED`）三条路径都写该头（池饱和头部由 ADR-0011 起补），两类 `rate_limit_error` 语义统一为"退避后可重试"。调用方按该头退避，不解析 message 文本。
> 另有一个不对外承诺的内部结果：客户端中途断开时引擎会构造 `499 UPSTREAM_ERROR`，此时对端已不可达，`499` 不出现在任何真实响应里，**不入本表**。

- 失败枚举（计入 key 失败，仅这五类）：`AUTH_INVALID` / `RATE_LIMITED` / `INSUFFICIENT_BALANCE` / `UPSTREAM_ERROR` / `NETWORK`。400/404/422 与客户端断开**不计**失败。

---

## 11. C1–C5 裁决（已冻结，详见 ADR-0007）

| # | 问题 | PM 裁决 |
|---|---|---|
| C1 | 建组自动签发第一把网关 key | **通过**：自动签发，明文仅在创建响应出现一次（同网关 key 明文纪律） |
| C2 | usage bucket 自动降级 | **通过**：允许降级，响应必须回显实际 `bucket`，前端按回显渲染 |
| C3 | 日志导出端点 | **通过**：不加端点，前端自行导出 |
| C4 | 删上游 force=true 的 key 处置 | **通过**：级联软删（`enabled=false` + `deletedAt`），保留历史日志外键 |
| C5 | 手动余额覆盖模板值 | **通过**：不保护，手动录入总是优先并置 `balanceSource=manual` |

---

## 12. 运维观测 `/api/observability/*`（v1.1.0）

本节是**只读观测面**的唯一事实源：网关把「错误事件」与「健康指标快照」落结构化存储，管理面提供机器可读的查询接口。服务的两个消费者是**排障的人**与**内嵌 AI 助手**（第二阶段，只读分析 + 给建议）。三条纪律贯穿全节：

1. **只读** —— 本节所有端点不接受任何写方法；观测面不产生副作用。
2. **鉴权** —— 除管理员会话外，可配一把**独立只读维护令牌**（§12.4），作用域仅本节。
3. **脱敏** —— 落盘前抹掉一切 key 明文；事件里只有 `keyId` 与 `****后4位`。

### 12.1 错误事件 `GatewayErrorEvent`

**定义**：网关处理 `/v1/*` 时，**一次被拒或一次失败**产生一条事件。成功请求不产生事件（成功量在 §6 `usage_logs` 里）。

落表 `gateway_error_events`（纯加表，`SCHEMA_VERSION` 不变）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | ❌ | `err_` 前缀，不透明 |
| `ts` | ISO8601 UTC | ❌ | 事件发生时刻，**网关侧时刻**，落库不重打 |
| `requestId` | string \| null | ✅ | **关联键**（§6「关联键 `x-request-id`」）：与同一请求的 `usage_logs.request_id` 同值。池饱和 / 密文不可解这类 **0 次真实尝试**的终态同样带值——它们最需要定位。本列上线前的历史行为 `null` |
| `severity` | `"warn"` \| `"error"` | ❌ | 由 `category` 决定（见下表），不由 HTTP 状态现推 |
| `category` | 枚举 9 值 | ❌ | **事件分型**，见下表 |
| `status` | int | ❌ | 最终回给客户端的 HTTP 状态；客户端断开写 `499`（该值只存在于事件流） |
| `gatewayCode` | string \| null | ✅ | §10 `GATEWAY_ERROR_CODES` 里的码 |
| `failureReason` | 5 类枚举 \| null | ✅ | 与 §3 `lastFailureReason` **同一套枚举**；未触达上游为 `null` |
| `endpoint` | string | ❌ | 如 `/v1/chat/completions` |
| `model` | string \| null | ✅ | **客户端请求的模型名**（非凭据），与 §6 日志同口径 |
| `upstreamId` | string \| null | ✅ | 抹名引用：只记 id，不记 baseUrl / 上游名 |
| `keyId` | string \| null | ✅ | 抹名引用：只记 id |
| `keyMasked` | string \| null | ✅ | `****后4位`；**永不出现明文**。没有"哪一把 key"可言时（`keyId` 为 `null`）产出侧写 **`****`**（4 位掩码的退化形态），**不是 `null`** —— 与 `usage_logs.key_masked` 同约定；类型保留 `string \| null` 但产出侧永不写 `null`，消费方按"总是有值"渲染即可 |
| `stream` | bool | ❌ | |
| `upstreamStatus` | int \| null | ✅ | 上游返回的原始状态码；一次都没打到上游为 `null` |
| `attempts` | int | ❌ | **真实**上游尝试次数（`0` = 一次都没发出去） |
| `candidates` | int \| null | ✅ | 本次候选 key 数（`NO_AVAILABLE_KEY` 时为 `0`） |
| `latencyMs` | int \| null | ✅ | 自请求进入到产事件的耗时 |
| `message` | string \| null | ✅ | 人类可读归因。**落盘前脱敏 + 截断 512 字符** |

#### `category` 分型表（唯一判据）

| `category` | `severity` | HTTP | 对应 §10 码 | 排障含义 |
|---|---|---|---|---|
| `CLIENT_REQUEST` | `warn` | 400 / 404 / 501 | `INVALID_REQUEST` / `NOT_FOUND` / `UNSUPPORTED_ENDPOINT` | 调用方写错，**不是网关问题** |
| `AUTH_FAILED` | `warn` | 401 | `INVALID_API_KEY` | 网关 key 缺失 / 未知 / 已吊销 |
| `RATE_LIMITED` | `warn` | 429 | `RATE_LIMITED`（含池饱和，ADR-0011） | 退避后可重试 |
| `QUOTA_EXCEEDED` | `warn` | 429 | `QUOTA_EXCEEDED` | 用户组日配额用尽 |
| `NO_AVAILABLE_KEY` | `error` | 503 | `NO_AVAILABLE_KEY` | 查池子与模型档案（候选为空的**或**密文解不出的） |
| `UPSTREAM_ERROR` | `error` | 502 | `UPSTREAM_ERROR` | 候选存在但用尽 → 查上游 |
| `UPSTREAM_TIMEOUT` | `error` | 504 | `UPSTREAM_TIMEOUT` | 上游首字节超时 |
| `CLIENT_ABORTED` | `warn` | 499（内部） | 引擎内部 `499` | 调用方中途断开；**仅存在于事件流**，真实响应里没有这个状态，§10 也未登记 |
| `INTERNAL` | `error` | 500 | 网关自身未预期异常 | 网关自己的问题 |

`severity` 的分界是**归因侧**，不是"HTTP 是不是 >= 500"：429 与 502 都是失败，但一个在调用方/配额侧（`warn`）、一个在系统侧（`error`）。助手与值班按 `severity` 先分诊、再按 `category` 定位。

#### 三层口径不可互相替代（下游最容易搞错的一处）

| 字段 | 是什么 | 谁在用 |
|---|---|---|
| `category` | **事件分型**（9 值，本节定义） | 机器聚合、助手分诊 |
| `gatewayCode` | **面向调用方**的错误码（§10 表） | 客户端按它分支 |
| `failureReason` | **计入 key 失败**的 5 类（决定冷却） | 池健康、冷却阶梯 |

一次 `UPSTREAM_ERROR` 事件里三者可能分别是 `UPSTREAM_ERROR` / `UPSTREAM_ERROR` / `AUTH_INVALID`（三把候选 key 全 401、用尽后报 502）—— 这是**正确**的，不是数据不一致。反过来说：**任何一方都别指望用另一个字段反推**。

#### 写入纪律

- 网关侧只做**入队**（O(1) 内存操作），落库由定时批量完成 —— **热路径零同步 DB 写**（§9）。
- 队列有上限；溢出时丢**最旧**的一批并计数，累计丢弃数由 `/api/observability/health` 的 `events.dropped` 暴露。**丢事件不许静默**。
- **落盘前脱敏**：`keyMasked` 只有 4 位；`message` 过 scrub（`Bearer <token>` / `sk-…` / `gw-…` 形状一律替换成 `****`）并截断 512 字符。明文 key 不进事件、不进日志、不进错误体。
- 保留期与 `usage_logs` 同口径（`LOG_RETENTION_DAYS`，默认 30 天）。

### 12.2 健康指标 `GET /api/observability/health`

`?window=60s|5m|1h`（默认 `5m`，上限 24h，与 §6 `/api/stats/overview` 同一条解析规则，回显归一化后的原字符串）。

```json
{
  "generatedAt": "2026-10-06T09:12:00.000Z",
  "window": "5m",
  "uptimeSec": 86412,
  "startedAt": "2026-10-05T09:11:48.000Z",
  "traffic": {
    "qps": 3.42,
    "successRate": 0.9941,
    "requests": 1024,
    "errors": 6,
    "tokens": { "prompt": 120000, "completion": 34000, "total": 154000 },
    "latencyMs": { "p50": 640, "p99": 5120, "samples": 1018 }
  },
  "keys": {
    "total": 8, "healthy": 6, "cooling": 1, "disabled": 1,
    "items": [
      { "keyId": "key_9c21", "maskedKey": "****a1b2", "upstreamId": "up_7f3a", "health": "healthy", "cooldownUntil": null, "consecutiveFailures": 0 }
    ]
  },
  "db": { "ok": true, "schemaVersion": 2, "fileSizeBytes": 2883584, "walSizeBytes": 40960, "queryMs": 1 },
  "events": {
    "total": 12,
    "dropped": 0,
    "byCategory": [
      { "category": "UPSTREAM_ERROR", "severity": "error", "count": 4, "lastAt": "2026-10-06T09:11:02.000Z" }
    ]
  }
}
```

| 字段 | 口径 |
|---|---|
| `uptimeSec` / `startedAt` | 服务进程已运行时长（`process.uptime()`）。网关面与管理面在同一进程内，所以这一条即"服务启动了多久" |
| `traffic.*` | 与 §6 `overview` **同一份 SQL、同一口径**；`requests=0` 时 `successRate=1` 是约定而非断言，前端仍必须显示"无流量" |
| `traffic.latencyMs` | `usage_logs.latency_ms` 的**最近秩**分位（nearest-rank，不做插值）：`p50` 取第 `ceil(0.5n)` 小、`p99` 取第 `ceil(0.99n)` 小的样本。`samples` 是参与计算的样本数；`samples=0` 时两个分位是 `null`（**不是 0**） |
| `keys.*` | 与 §3 Key 的 `health` / `cooldownUntil` / `consecutiveFailures` 同源（`key_runtime` 表，新鲜度 ≤1s，ADR-0010） |
| `db.ok` | **真跑一次** `SELECT 1` 的结果，不是"连接对象还在"。`queryMs` 是这次探测的耗时 |
| `db.fileSizeBytes` / `walSizeBytes` | 取不到为 `null`（如 `:memory:` 库）。**不返回库文件路径** —— 路径是部署细节，不进 API |
| `events.total` | 窗口内事件条数 |
| `events.byCategory` | 只列**出现过**的分型，**不补 0**。与 §6 时间轴补 0 不同：这里没有"时间轴完整性"约束，补 0 只会让响应变长、并掩盖"从没发生过" |
| `events.dropped` | 进程启动以来因队列溢出 / 落库失败**累计丢弃**的事件条数（不是窗口内） |

#### 健康快照（`gateway_health_snapshots`）

每 **60s** 落一条：`ts` / `windowSec` / `qps` / `successRate` / `requests` / `errors` / `p50Ms` / `p99Ms` / `keyTotal` / `keyHealthy` / `keyCooling` / `keyDisabled` / `dbOk` / `errorCount`。

- 快照是**当时算出来的历史**，不允许事后重算：`usage_logs` 会被保留期裁掉，重算会得到另一种历史 —— 那正是"看起来合理的假数据"。
- 写入发生在管理进程内、单写者、**不在 `/v1/*` 热路径**上（§5）。

### 12.3 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/observability/health` | 健康指标（实时算，不读快照表） |
| `GET` | `/api/observability/health/snapshots?from=&to=&page=&pageSize=` | 历史快照，`ts DESC, id DESC`；默认最近 **6h** |
| `GET` | `/api/observability/errors?from=&to=&category=&severity=&upstreamId=&keyId=&model=&requestId=&page=&pageSize=` | 错误事件查询，`ts DESC, id DESC`；默认最近 **1h** |
| `GET` | `/api/observability/errors/:id` | 单条事件详情；未知 id → `404 NOT_FOUND` |

- `from` / `to`：带时区 ISO8601（§0.2）。省略 `to` = 现在；`from`/`to` 全省略 = 该端点的默认窗口；跨度上限 **30 天**，超限 `400 INVALID_PARAM`（`details.field="from"`）。
- `category` 支持**逗号分隔多值**（最多 9 个），任一不在 §12.1 枚举内 → `400 INVALID_PARAM`（`details.field="category"`）。
- `severity`：单值，`warn` \| `error`。
- `upstreamId` / `keyId` / `model` / `requestId`：单值精确匹配（`requestId` 见 §6「关联键」）。
- 响应在 §0.3 分页信封之上**追加** `range: { from, to }`，回显**实际**生效的窗口（同 §6 回显降档后 `bucket` 的惯例：前端按回显渲染，不自算）。
- 全部端点**只读**，无副作用、不写审计。

### 12.4 只读维护令牌

- 配置：`READONLY_TOKEN`（env）。空 = **关闭**（默认）。与 `ADMIN_TOKEN` 配成同一个值 → **启动即拒绝**，理由见下。
- 用法：`Authorization: Bearer <READONLY_TOKEN>`。命中后主体为 `readonly`。
- **作用域：仅 `GET /api/observability/*`**。落在别的路径 → `403 FORBIDDEN`；任何写方法 → `403 FORBIDDEN`。不做"是 GET 就放行整个管理面"的宽口径 —— 观测令牌能读的只有观测面。
- 令牌**不进任何响应体、不进日志**。轮换 = 改 env 后重启（本版不做热轮换，"可随时换值"即满足轮换需求）。
- 隔离为什么是硬约束：这把令牌的持有者是内置助手/值班脚本，它的泄露不该等于管理员会话泄露；反之管理员会话也不该被降格成观测令牌。**两把令牌同值 = 隔离归零**，所以宁可启动失败，也不静默接受一份看起来配好了、实际没有隔离的配置。
- 未带令牌时一切照旧：`/api/*` 仍由会话 Cookie 把关（§0.5），本节端点对管理员会话**同样开放**（画师的控制台与助手共用同一份响应体）。

---

*已冻结：v1.0-frozen，冻结裁决见 `docs/adr/0007-api-contract-freeze-c1-c5.md`。字段改动必须改本契约并新增 ADR。v1.1.0 补遗见 `docs/adr/0013-observability-readonly-query.md`；v1.1.1 补遗（关联键 `x-request-id`，§6 / §10 / §12.1 / §12.3）见 `docs/adr/0014-request-id-correlation.md`。*
