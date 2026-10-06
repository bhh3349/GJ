# 13. M6-B 运维观测：错误事件分型、健康快照与只读维护令牌（契约 v1.1.0）

- 状态：已接受（范围由 PM 于 2026-10-06 立项冻结，见群聊任务单）
- 日期：2026-10-06
- 决策者：管家 · 管理后端
- 相关：ADR-0011（池饱和与冷却阶梯）、ADR-0010（key_runtime 镜像）、ADR-0007（契约冻结）、ADR-0012（M6-A 余额自测）

## 背景与问题

M6-B 的验收目标是"能查、能定位、不给攻击面"。落地前把三件事摊开看，缺口分别在三处：

1. **失败没有留下结构化痕迹**。今天一次失败的 `/v1/*` 请求，能事后看到的只有 `usage_logs` 里一行 `status>=400` 加一个 `error_code`。**为什么失败**（池里没 key？上游 401？首字节超时？客户端自己断开？）拿不到；**用了哪把 key、哪个上游**只有 id 可 join，而上游明细在 `upstreams` 表上——要排查一次抖动，得人工把两张表对起来。事后翻日志更不行：`usage_logs` 是计数表，不是事件表。
2. **"现在好不好"没有权威口径**。仪表盘（§6 `overview`）给的是窗口内的 requests / errors / successRate，**没有延迟分位**，也**没有健康历史**——窗口一过，"刚才那五分钟是不是劣化过"就无从回答。`usage_logs` 会按 `LOG_RETENTION_DAYS` 被裁，意味着**过去无法重算**。
3. **观测面还没有独立的身份**。管理员会话（Cookie + CSRF，ADR-0002）是给人用的；第二阶段的**内置 AI 助手**、以及值班脚本要读观测数据，如果只能借管理员会话，等于把会话权限发给一个只需要看的消费者。反过来，让助手用 `ADMIN_TOKEN` 更是把管理面全部权限交出去。

同时有两条硬约束必须同时满足：**DB 单写者**、**热路径零同步写**（AGENTS.md §5 / 契约 §9）。任何"每次失败写一条 event"的设计都是直接违规。

## 备选方案

### A. 错误事件怎么存

| 方案 | 结论 |
|---|---|
| A1. 独立 `gateway_error_events` 表 + **显式列**，落库前脱敏 | **采纳** |
| A2. 复用 `usage_logs`，加几个列（`category`/`reason`/`attempts`） | 否。两张表的**基数是不同量级**：`usage_logs` 每请求一行（含大量成功），错误事件是稀疏的。混在一张表里，事件查询要每次带 `status>=400` 过滤，且保留策略无法分开（事件值得留得比流量日志久）。更要命的是**失败分型会污染成功路径的写入热路径**——A1 的入队是纯错误路径的事 |
| A3. 一条 `detail` JSON 列装全部附加信息 | 否。脱敏就变成"记得在序列化前替换"，而不是**构造性成立**。显式列下，`keyMasked` 这一列**物理上只能放 4 位掩码**，写错列名就写不出明文。见 ADR-0006 的同一思路：安全要落在结构上，不落在自觉上 |
| A4. 只写文件日志（NDJSON），不落库 | 否。PM 明确要求"落结构化存储"，且查询端点要做**分型过滤 + 分页**，JSONL 上做这两件事等于自己重写一个数据库（还要处理轮转与并发读） |

### B. 健康指标怎么算

| 方案 | 结论 |
|---|---|
| B1. `GET /api/observability/health` 实时算 + **每 60s 落一条快照** | **采纳** |
| B2. 只在内存里滚动窗口，不落库 | 否。"健康历史"是本次的交付物之一，内存窗口一重启就没了，也过不了"机器可读、可查询" |
| B3. 只落快照、查询端点直接读快照 | 否。快照是 60s 粒度，值班问的是"**现在**怎么样"。实时算的部分必须真查库 |
| B4. 快照由网关进程写 | 否。**单写者**：`/v1/*` 是热路径，让网关进程持第二个写连接直接违反纪律。快照落库放在管理进程，且不在任何请求处理链上 |

延迟分位的取法另有一处决策：**最近秩（nearest-rank）而非插值**，用 `COUNT(*)` + `ORDER BY latency_ms LIMIT 1 OFFSET n` 取样本，不把行搬进内存 —— 保住 `/api/*` 的 <100ms 验收（本模块验收）。

### C. 观测面怎么鉴权

| 方案 | 结论 |
|---|---|
| C1. 新增独立 **只读维护令牌** `READONLY_TOKEN`，作用域**仅** `GET /api/observability/*`，与 `ADMIN_TOKEN` 同值则启动拒绝 | **采纳** |
| C2. 复用管理员会话 | 否（见"背景 3"）。助手/脚本拿会话 = 拿到写权限 |
| C3. 复用现有 `ADMIN_TOKEN` | 否。**这是最危险的一个**：`ADMIN_TOKEN` 是 CI 用的管理面机器令牌，能建上游、发 key。把它交给一个只需要"看"的消费者，等于把观测需求升级成管理权限泄漏 |
| C4. 观测面**不鉴权**（内网可信） | 否。事件里含模型名、上游 id、key 掩码、错误归因——是**拓扑与运行状态情报**。内网不是免鉴权理由，且这是一次写入契约的不可逆决定 |

C1 的关键在**互相排斥**这一条：两把令牌配成同一个值时**启动失败**而不是"以管理员为准"。理由是没有第三种正确行为——静默取其一，会让部署者以为隔离生效了而实际没有；报错让人当场发现，代价最小。

## 决策

### 1. 错误事件 schema（契约 §12.1）

`GatewayErrorEvent` 20 个字段，落表 `gateway_error_events`。要点：

- **时间**：`ts` 是 **网关侧时刻**，落库时**不重打**。事件描述的是"当时发生了什么"，写入耗时不改变事实。
- **抹名引用**：`upstreamId` / `keyId` 只记 id（不记 baseUrl、不记上游名、不记 key 明文），`keyMasked` 只 4 位。这是 PM 要求的"抹名引用"的落地形状。
- **三层口径分开**：`category`（事件分型，9 值）/ `gatewayCode`（§10 面向调用方的码）/ `failureReason`（计入 key 失败的 5 类，决定冷却，与 §3 同一套枚举）。三者**可以不同**且都正确——三把候选 key 全 401 后报 502 的事件里，它们是 `UPSTREAM_ERROR` / `UPSTREAM_ERROR` / `AUTH_INVALID`。契约里专门写了一张表说明"不可互相反推"，因为这是下游（含 AI 助手）最容易踩的坑。
- **`CLIENT_ABORTED` 与 499**：客户端中途断开是**高频正常现象**，不是故障。给它单独分型、severity 为 `warn`、HTTP 记 `499`，并**在契约里显式声明这个状态只存在于事件流**、不进 §10 错误码表——否则调用方会去 `GATEWAY_ERROR_CODES` 里找它，找不到就以为契约漏了。
- **`attempts` 区分两类 503**：`NO_AVAILABLE_KEY` 里，"池里没候选"与"候选存在但密文全解不出"（ADR-0011 的 `poolMisconfiguredError`）对客户端是同一种处置，但归因完全不同。`attempts=0` + `candidates>0` 一眼指向配置/密文问题，不用翻日志。

### 2. `severity` 由 `category` 决定，不由 HTTP 状态现推

`warn`：`CLIENT_REQUEST` / `AUTH_FAILED` / `RATE_LIMITED` / `QUOTA_EXCEEDED` / `CLIENT_ABORTED`。
`error`：`NO_AVAILABLE_KEY` / `UPSTREAM_ERROR` / `UPSTREAM_TIMEOUT` / `INTERNAL`。

分界是**归因侧**不是状态码：429（配额/限流）在调用方侧是 `warn`，502 在系统侧是 `error`。值班与助手按 `severity` 先分诊、再按 `category` 定位——两级都在服务端定死，不让消费者各自推断。

### 3. 健康指标（契约 §12.2）

`GET /api/observability/health?window=`，覆盖 PM 点名的全部字段：

| PM 要求 | 落地 |
|---|---|
| uptime | `uptimeSec` + `startedAt` |
| QPS | `traffic.qps`（与 §6 overview 同一份 SQL） |
| 成功率 | `traffic.successRate`（口径同 §6，含 `requests=0 → 1` 的约定） |
| P50/P99 | `traffic.latencyMs`，最近秩，`samples=0` 时为 **`null` 不是 0** |
| key 健康 | `keys.{total,healthy,cooling,disabled}` + `items[]`（与 §3 同源） |
| DB 状态 | `db.{ok,schemaVersion,fileSizeBytes,walSizeBytes,queryMs}`，`ok` 是**真跑 `SELECT 1`** |
| 错误分型计数 | `events.total` + `byCategory[]` + `dropped` |

三处口径决定值得留痕：

- **`db.ok` 真跑查询**。"连接对象还在"不等于"库还能用"（WAL 损坏、磁盘满都发生在连接之后）。探测成本是一次 `SELECT 1`，换来的是这个字段真的能报警。
- **`byCategory` 不补 0**。§6 时间轴补 0 是因为轴与 series 必须下标对齐；这里**没有轴**，补 0 只会让响应变长并掩盖"从没发生过"。同一份契约里两处相反的做法，理由写在一处，避免后人"统一"它们。
- **不返回库文件路径**。路径是部署细节（含主机目录结构），观测面不需要它。

快照表 `gateway_health_snapshots` 每 60s 一条，**落当时算出来的结果，不事后重算**：`usage_logs` 会被保留期裁掉，重算会得出"另一种历史"——那正是最难识别的假数据。

### 4. 只读维护令牌（契约 §12.4）

`READONLY_TOKEN`（env，空 = 关闭）。`Authorization: Bearer`，作用域**仅** `GET /api/observability/*`；其他路径或写方法一律 `403 FORBIDDEN`。与 `ADMIN_TOKEN` 同值 → **启动即拒绝**（理由见 C1）。令牌不进响应体、不进日志；轮换 = 改 env 重启。

配额说明：本节**不新增任何 `ERROR_CODES`**，观测面复用 `UNAUTHORIZED`（未带/坏令牌）与 `FORBIDDEN`（令牌有效但越界），与 §0.4 完全一致。

### 5. 写入路径：缓冲入队，绝不新增同步写

- 事件由网关侧**入队**（O(1)），落库在管理进程侧定时批量。**热路径零同步 DB 写**（§9 原文纪律）。
- 队列上限 + 溢出丢**最旧** + **累计 `dropped` 计数并经 `/health` 暴露**。丢事件不许静默——一个"偶尔丢观测数据"的观测系统比没有观测系统更误导。
- 快照写入由 `buildApp` 持有定时器，经 Fastify `onClose` 关闭（冻结关闭顺序里 `app.close()` 早于 `db.close()`，因此不需要改 `shutdown.ts`）。
- **脱敏在落盘前做**：`message` 过 scrub（`Bearer <token>` / `sk-…` / `gw-…` 替换为 `****`）并截断 512 字符；`keyMasked` 由掩码函数产出。明文 key 不进事件、不进日志、不进错误体。

### 6. 边界与归口

- 本批**不碰** `src/gateway/**` 热路径实现：路由者按本节 schema 产事件并接自己的 sink（端口签名见 §7）。
- **零 schema 语义变更**：两张表是纯新增，`SCHEMA_VERSION` 保持 2（与 `schema.ts` 既有注释一致：纯加表加索引不递增）。
- **§10 零新增**：`CLIENT_ABORTED`/`499` 只在事件流里，网关面向客户端的错误码表不动。

## 影响

- **后端（管家）**：契约 §12 + 本 ADR；`schema.ts` 加 2 表 5 索引；`util/redact.ts`；`db/repo/gateway-events.ts`、`db/repo/health-snapshots.ts`；`db/observability.ts`（含最近秩分位与 DB 探测）；`wiring/error-event-sink.ts`；`config.readonlyToken`；`api/routes/observability.ts` + 只读令牌作用域校验；测试。
- **网关（路由者）**：按 §12.1 产事件、接 sink。**端口签名由本 ADR §7 冻结**，实现前先对齐。
- **前端（画师）**：新页面/卡片读取 4 个只读端点；`range`/`window` 回显按契约渲染，不自算窗口。**无破坏性变更**。
- **契约**：升 **v1.1.0**（非补遗）。这是本 ADR 唯一"重"的一点，理由：新增的是**新命名空间**（`/api/observability/*`）+ **新鉴权主体**（`READONLY_TOKEN`），与 v1.0.1–v1.0.5 那几版"文本对齐实现"不是同一档次；`v1.0-frozen` 主版本继续生效，冻结规则（改字段必须改契约 + 新 ADR）不变。
- **安全**：明文 key 不落盘的红线扩展到事件与快照；观测面从"无"变成"有且独立鉴权"。`dropped` 计数与 `db.ok` 是新增的**可观测性指标**，不引入新的失败模式。
- **性能**：`/v1/*` 增量 = 一次内存入队（失败路径）；`/api/*` 新端点只做索引查询与聚合，分位查询走 `ORDER BY ... LIMIT 1 OFFSET`，不搬行。

## §7 冻结的端口签名（路由者按此对接）

```ts
// src/gateway/ports.ts —— 由路由者添加，形状由本 ADR 冻结
export interface ErrorEventSink {
  record(entry: GatewayErrorEventInput): void;  // 必须 O(1)、不得抛、不得同步落库
}

export interface GatewayErrorEventInput {
  ts: string;                       // ISO8601 UTC，网关侧时刻
  status: number;                   // 回给客户端的状态；客户端断开写 499
  gatewayCode: string | null;
  failureReason: 'AUTH_INVALID' | 'INSUFFICIENT_BALANCE' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'NETWORK' | null;
  // ↑ 直接复用 src/gateway/types.ts 的 FailureReason，不新造一套大小写
  endpoint: string;
  model: string | null;             // 客户端请求的模型名
  upstreamId: string | null;
  keyId: string | null;
  keyMasked: string | null;         // 只 4 位掩码；调用方不得传明文
  stream: boolean;
  upstreamStatus: number | null;
  attempts: number;                 // 真实上游尝试次数
  candidates: number | null;
  latencyMs: number | null;
  message: string | null;           // 可含上游原文；落盘前由 sink 统一 scrub + 截断
}
```

`category` / `severity` **不由网关传**，由 sink 侧按 §12.1 的映射表从 `gatewayCode` + `status` 派生——映射只有一个实现处，网关侧不需要理解分型，也就不会与契约漂移。

## 门禁核验

四闸在 2026-10-06 按序跑完，全绿（`main` 上、本 ADR 与其实现同一批）：

| 闸 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过，0 error |
| 测试 | `pnpm test` | **30 文件 / 335 通过 / 1 跳过**（较本批前的 24 文件 / 245 通过新增 6 文件 90 例） |
| 构建 | `pnpm build` | 通过，`dist/server.js` 产出正常 |
| 密钥 | `pnpm check:secrets` | **0 命中**（189 个文件 / 1368 KB） |

`check:secrets` 这一闸对**测试里的样本**同样生效，值得记一笔：`assigned-secret` 规则是大小写不敏感的 `/token\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{24,}["']/`，所以新测试里凡是"令牌字面量"一律短于 24 字符（`'ro-probe'` / `'ci-probe'`），而 key 样本用 `'sk-probe-' + 'D'.repeat(24)` 在运行期拼出来——源码里不出现任何 key 形状的长字面量。这不是绕闸，是让闸门保持有意义：真正该拦的是"密钥被写进代码"，而不是"测试里恰好有一串长字符"。

本批新增 6 个测试文件，逐条对应的不变式：

| 文件 | 钉住的东西 |
|---|---|
| `src/util/redact.spec.ts` | 凭据按**形状**抹除；`先抹再截`（跨界密钥不留半个可识别残片）；幂等 |
| `src/wiring/error-event-sink.spec.ts` | `record()` **绝不碰库**（热路径纪律）；分型由码值而非状态码派生（429 两义）；**脱敏发生在入队前**；溢出丢最旧且计数 |
| `src/db/repo/gateway-events.spec.ts` | `keyMasked` 三态；多值过滤全走绑定参数（注入形状查 0 行）；**同毫秒翻页不重不漏**；`byCategory` 不补 0 |
| `src/db/observability.spec.ts` | 分位**最近秩**（取值必是真实样本，不插值）；无样本 `null` ≠ 0；窗口**回显用户写法**；`inspectDb` 不泄漏库路径、关库不抛 |
| `src/api/health-snapshot-writer.spec.ts` | 启动即写一条；写的是当时算的那份（不事后重算）；定时器回调**绝不抛** |
| `src/api/observability.spec.ts` | 只读令牌**作用域**：越界 `403` 而非 `401`；两把令牌都未配置时 Bearer **照旧落回会话鉴权**（v1.0 语义零变更）；`buildApp` 默认接入写入器 |

其中 `src/api/observability.spec.ts` 里那一例"两把令牌都未配置 → Bearer 请求照旧 401、带上会话同头就 200"是专门的**回归闸**：本批唯一的风险不是新功能出错，而是**旧行为被顺带改掉**（把未配置的 Bearer 从"不是机器令牌"变成"令牌无效"）。这条用例两者都断言了。

## 已知缺口（不在本次范围）

- **令牌热轮换**：本版轮换 = 改 env 重启；不引入配置热加载（那需要一套新的配置文件监听语义，收益与本批无关）。
- **指标导出（Prometheus / OpenMetrics）**：本次只做 JSON 只读端点；若日后接监控栈，另开 ADR（涉及指标命名与基数控制）。
- **告警与通知**：本批只提供数据，不做阈值告警与推送。
- **`events.byCategory` 的窗口外累计**：只有 `dropped` 是累计量，其余按窗口；全量历史查询走 `/errors` 端点。
- **AI 助手的写权限**：第二阶段明确只读分析 + 建议；任何"助手自动改配置"另立 ADR 与授权模型。
