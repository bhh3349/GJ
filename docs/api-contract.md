# API 契约 v1.0-frozen

> 作者：管家 · 管理后端　｜　状态：**v1.0-frozen（PM 已核验冻结，见 ADR-0007）**
> 本文件是**唯一接口事实源**。冻结后任何一方不得单方面改字段；改动走本文件 + `docs/adr/`。
> 覆盖范围：管理面 `/api/*`（REST + WS）。网关面 `/v1/*` 见 §10。
>
> **补遗 v1.0.1（2026-10-06，PM 已追认）**：§4 新增 `GET /api/groups/:id/keys`，并给 `reset` 的响应补上 `id`。动机与影响见 ADR-0008。
>
> **补遗 v1.0.2（2026-10-06）**：① §3 `POST /api/keys/:id/balance/refresh` 的响应补成 `202 {taskId}`（原文只写了用途、没写形状，而实现从第一天起就回 `202 {taskId}`，属于文本与实现的既存分歧，本次抹平）；② §5 新增「`POST /api/models/sync` 的字段映射」小节，把「只落能证明的、其余一律未知」写成明文规则；③ §5 补一句「同步不覆盖人工值」。除此之外 v1.0.1 全部内容不变 —— 无字段改名、无类型变更、无端点删除。动机与影响见 ADR-0009。

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

`baseUrl` 校验：必须 `http(s)://`，无尾斜杠（根路径除外）。不合法 → `400 INVALID_PARAM`。

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
        { "t": "2026-10-05T09:00:00.000Z", "requests": 120, "tokens": 84000, "costCents": 320, "errors": 1 }
      ]
    }
  ],
  "isEstimatedTokenCount": 12
}
```
- `axis` 与每个 `series[].points` **等长且下标对齐**，缺失桶补 `0`（这里是计数，补 0 是对的——与余额的 `null` 语义不同）。
- `isEstimatedTokenCount`：`is_estimated=1` 的调用条数。前端图表需可标注"含估算"。

### `GET /api/logs` — 调用记录
`?from=&to=&groupId=&model=&status=&upstreamId=&keyId=&page=&pageSize=&includeDeleted=`（默认不查已软删资源；`includeDeleted=true` 时按 id 过滤仍可命中已软删的 upstream/key/group）

```json
{
  "items": [
    {
      "id": "log_88a1",
      "ts": "2026-10-06T09:11:58.000Z",
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
| `1000` | 正常关闭（登出） | 不重连 |

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
- 无可用 key → **`503 NO_AVAILABLE_KEY`**。
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

*已冻结：v1.0-frozen，冻结裁决见 `docs/adr/0007-api-contract-v1-frozen.md`。字段改动必须改本契约并新增 ADR。*
