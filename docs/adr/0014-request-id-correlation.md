# 14. 关联键 `x-request-id`：全链路透传、格式校验与两表落列（契约 v1.1.1）

- 状态：已接受（PM 于 2026-10-06 裁决"现在补，不留第二阶段"）
- 日期：2026-10-06
- 决策者：管家 · 管理后端（契约 + 存储 + 查询 + 端口签名）；产出侧接线见 §7 与「影响」
- 相关：ADR-0013（观测面与 `record()` 冻结签名）、ADR-0011（0 次真实尝试的两条终态）、ADR-0010（key_runtime 镜像）、ADR-0007（契约冻结）

## 背景与问题

`x-request-id` 全链路透传**早就写进了冻结约束**（`docs/dev-constraints.md` §六.6、《需求文档 v1.1》§二/§五），但全仓 TypeScript 侧**一处实现都没有**：`usage_logs` 没有列、错误事件没有列、网关不读也不回写这个头。这是**文档与实现的既存缺口**，不是本阶段新提的范围。

本次把它补上，是因为 M6-B 之后它从"锦上添花"变成了**结构性依赖**：

1. **错误事件与流量日志无法真正串起来**。一次抖动在两张表里各留一行/几条，唯一能对的键是"时间窗 + 模型名"——同一秒内两个用户组打同一个模型，猜不出来谁是谁。ADR-0013 的三层口径（`category`/`gatewayCode`/`failureReason`）解决了"**为什么**失败"，`requestId` 解决的是"**这一次**失败"，两者不是一回事。
2. **第二阶段的内置助手要"读日志 → 定位问题"**。它只读、不猜；靠时间窗猜关联等于让它编故事。
3. **越晚补越贵**。现在补 = 加两列 + 端口签名加一个字段；二阶段补 = 改两张表 + 动 ADR-0013 已冻结的 `record()` 签名 + 路由者那批接线返工。

硬约束不变：`/v1/*` 是热路径，**不得新增任何同步 DB 写**（§9）；DB 单写者；入站值不可信。

## 备选方案

### A. 生成/校验放在哪一层

| 方案 | 结论 |
|---|---|
| A1. 网关入站处 O(1) 生成/校验，值随请求对象下传，最终进两条出口 | **采纳** |
| A2. 落库前在 sink 侧生成 | 否。sink 在**管理进程**、批量 flush，它已经不知道"这个请求当初从哪个连接来"；更要命的是**响应头回写**必须在热路径上就拿到值，sink 生成太晚 |
| A3. 入站值一律原样接受，不校验 | 否。等于让调用方决定写进我们响应头、上游请求头、DB 列的内容。见 B |
| A4. 入站值非法就回 `400` | 否。一个坏 ID 不该让请求失败——它不是业务参数，是诊断缺乏。**重新生成**比报错正确 |

### B. 格式规则

| 方案 | 结论 |
|---|---|
| B1. 白名单 `^[A-Za-z0-9._-]{8,64}$`，不合法（含超长）即重生成 | **采纳** |
| B2. 不限制（`maxLength` 给大一点即可） | 否。这个值会**原样进响应头**、进上游请求头、进 SQL 参数与日志文本。C0 控制字符与 CR/LF 是响应头注入的经典入口，一个正则白名单把这一整类问题一次性关掉 |
| B3. 只校验长度，不校验字符集 | 否。同上，长度不解决注入 |
| B4. 只接受 UUID | 否。多数代理/客户端会用带前缀的 id（`req-…`、trace id）。**宽到白名单**比窄到一种形状更实用，安全性由白名单保证、不由形状保证 |
| B5. 上限 64 字符 | 采纳。64 足够容纳 UUID（36）与常见 trace id，又不至于让一列塞进任意长串 |

### C. 存哪、索引不索引

| 方案 | 结论 |
|---|---|
| C1. 两张表各加一列 `request_id TEXT NULL` **+ 各一个索引** | **采纳** |
| C2. 不加索引 | 否。本列存在的唯一理由就是**按它查**——一次调用 = 1 行日志 + 0..n 条事件，这类点查若有 30 天窗口在前面扫，正是 `/api/*` <100ms 验收的破口 |
| C3. 建一张 `request_index` 映射表 | 否。多一张表就多一个写入点与一处一致性问题；两列直接落在各自表上，查哪张表用哪张 |
| C4. 复用 `usage_logs.id` 当关联键 | 否。**语义不对**：`id` 是行主键，一次失败调用可能**没有** usage 行（或有多条试错），关联键要的是"调用"，不是"记录行" |
| C5. 索引影响写入成本 | 接受。这是 `/v1/*` 之外的**批量 flush** 成本（每行一次 B-tree 插入），不是热路径上的同步写；且两表的写入本来就已经在走批量事务 |

### D. 端口字段必填还是可选

| 方案 | 结论 |
|---|---|
| D1. `UsageLogEntry.requestId` / `ErrorEventEntry.requestId` **必填 `string`** | **采纳** |
| D2. 可选 `requestId?: string` | 否。可选 = 忘了传也能编译过 = 上线后 `request_id` 静默全是 `NULL`，而"静默"正是本次要消灭的东西。**"相关键缺失"必须在编译期就报出来**，这是 ADR-0006/0013 同一条思路：不变式落在结构上，不落在自觉上 |
| D3. 由 sink 侧反查（像 `keyMasked` 那样，网关不传） | 否。`keyMasked` 能反查是因为它由 `keyId` 决定；`requestId` 只有**当时那个请求**知道，事后无从反查 |

D1 的代价是明确的：`src/gateway/engine.ts` 里构造这两条 entry 的地方会**编译失败**，必须由产出侧（路由者）把值传进去。这是**故意**的——签名冻结先于接线，编译错误就是交接单。

## 决策

### 1. 唯一实现处（`src/util/request-id.ts`）

`src/util/` 是中立层（网关与管理面都可 import，不违反 AGENTS.md §8）：

- `REQUEST_ID_HEADER = 'x-request-id'`：头名与格式**只有这一处**定义，产出侧不许内联正则。
- `isValidRequestId(value)`：白名单 `^[A-Za-z0-9._-]{8,64}$`。
- `generateRequestId()`：`crypto.randomUUID()`，O(1)，无 IO。
- `resolveRequestId(inbound)`：取入站值 → 合法则沿用，否则生成。**永不返回空串、永不抛**。数组形式（重复头）按非法处理——重复头是可疑输入，不挑一个用。

### 2. 全链路五个环节（契约 §6「关联键」）

| 环节 | 规则 |
|---|---|
| 取值 | 入站缺失 / 非法 / 超长 → 重新生成；**不报 400** |
| 回写 | 响应头**一定**带最终值（包括 4xx/5xx） |
| 透传 | 同一值原样透传上游（白名单保证透传内容是安全的） |
| 落库 | `usage_logs.request_id` 与 `gateway_error_events.request_id` 各一列、同键同值 |
| 查询 | `GET /api/logs?requestId=`、`GET /api/observability/errors?requestId=` |

热路径增量 = 一次正则匹配 +（非法时）一次 UUID 生成，**全是内存操作，零新增同步 DB 写**。

### 3. 0 次真实尝试的终态也要带键

ADR-0011 的两条终态——`429 RATE_LIMITED`（池饱和，候选非空但并发槽位全满）与 `503 NO_AVAILABLE_KEY`（密文解析不出，`unresolvable`）——**同样带 `requestId`**。它们恰恰是"事后必须能一眼定位"的两类：0 次真实尝试意味着上游侧毫无痕迹，只有这两列能对上。

### 4. `NULL` 的语义

- 本列上线前的历史行 → `NULL`：含义是"**当时还没有这个字段**"，不是"这次调用没有 ID"。前端按 `null` 直渲，不做"未知"包装。
- sink 侧沿用既有约定：`''` 落库为 `NULL`（与 `keyId` / `upstreamId` / `groupId` 同一条"空串 = 无"）。正常路径下 `resolveRequestId` 不产出空串，所以这只在有人手工构造 entry 时才会发生。
- 库里**不写空串**：空串看着像"有值"，会污染 `IS NULL` 的历史语义。

### 5. 迁移（幂等）

新库：`CREATE TABLE` 里直接带 `request_id TEXT`。老库：`hasColumn()` 守住的 `ALTER TABLE ... ADD COLUMN`（与 `gateway_keys.deleted_at` 同一套惯例）。

**索引必须建在迁移块之后**，不能写进 `DDL` 常量：`db.exec(DDL)` 先于 `ALTER TABLE` 执行，老库上那条 `CREATE INDEX ... ON usage_logs(request_id)` 会因列不存在而直接抛，整个启动失败。顺序是 `exec(DDL)` → 补列 → 建索引。

`SCHEMA_VERSION` **保持 2**：纯加列加索引，不动既有列语义（与 ADR-0013 的"纯加表不递增"同一判据）。**注意与纯加表的区别**：加列会改变既有表的行形状，所以这里必须走 `ALTER TABLE` 而不是只改 `CREATE TABLE` 文本。

## 影响

- **后端（管家）**：本 ADR + 契约 §6/§10/§12.1/§12.3；`util/request-id.ts`；`schema.ts` 两列两索引；`repo/logs.ts`、`repo/gateway-events.ts` 的输入/行/INSERT/过滤；`api/dto.ts` 两个 DTO；`routes/misc.ts`（logs）与 `routes/observability.ts` 的查询参数；两个 sink 的透传；`gateway/ports.ts` 两处签名；测试。
- **网关（路由者）**：`/v1/*` 入站 `resolveRequestId` → 响应头回写 → `ForwardRequest.requestId` → 两处 entry 构造补 `requestId`。签名已冻结（§7），实现时不再改签名。
- **前端（画师）**：日志表与错误事件详情多一列 `requestId`（可复制、可跳查）；`/api/logs?requestId=` 与 `/api/observability/errors?requestId=` 两个筛选位。**无破坏性变更**（新字段，老字段不动）。
- **契约**：升 **v1.1.1**（补遗，非新命名空间）。§10 只新增一个头要求，错误码表**零新增**（`ERROR_CODES` 不动）。
- **安全**：`requestId` **不是凭据**，不含任何密钥材料，可安全回写与透传；白名单字符集把响应头注入整类关掉。key 明文不落盘的红线不受影响。
- **性能**：`/v1/*` 增量 = 一次正则 +（必要时）一次 UUID；`/api/*` 两个新筛选位走索引点查。

## §7 冻结的端口签名（路由者按此对接）

```ts
// src/gateway/ports.ts —— 与 ADR-0013 §7 同一份端口文件，本批只加 requestId 一个字段。
export interface UsageLogEntry {
  // …ADR-0013 §7 既有字段不变…
  requestId: string;   // 关联键，**必填**。取自同一次请求（入站合法则沿用，否则重生成）
  at: string;          // ISO8601 UTC
}

export interface ErrorEventEntry {
  // …ADR-0013 §7 既有字段不变…
  requestId: string;   // 同上；0 次真实尝试的终态也必须传（ADR-0011 两条）
  at: string;
}
```

**必填是刻意的**：漏传 → 编译不过。产出侧需要准备的只有两样：

1. `src/gateway/routes.ts`：入站 `resolveRequestId(req.headers[REQUEST_ID_HEADER])`，回写 `reply.header(REQUEST_ID_HEADER, id)`，透传上游，并把它放进 `ForwardRequest.requestId`。
2. `src/gateway/engine.ts`：`ForwardRequest` 加 `requestId: string`；两处 entry 构造（`logAttempt` 的 `recordLog({...})`、错误事件的 `record()`）各补一行 `requestId: req.requestId`。

## 门禁核验

见下方"落地记录"。

## 已知缺口（不在本次范围）

- **管理面响应不带 `x-request-id`**：本批只做网关面。管理面自身排障若需要，另立（涉及审计日志的关联语义）。
- **W3C `traceparent` / OpenTelemetry 传播**：本批只用 `x-request-id` 这一个键，不引入 trace 上下文语义。
- **上游若回写自己的 id**：我们不解析上游响应头里的 id，只保证**发出去**的值可对。
- **`/internal/snapshot` 与 WS 握手不带该头**：非 `/v1/*` 数据面，本轮不涉及。
