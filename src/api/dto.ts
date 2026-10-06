// 管理面响应 DTO —— 与 docs/api-contract.md（v1.0-frozen）逐字段对齐。
//
// 这些接口是**契约的代码化身**：改这里就是改契约，必须同时改 docs/api-contract.md 并补 ADR。
// 所以每个对象上方都标了契约小节号，方便 review 时逐条比对。
//
// 布尔一律 true/false（不是 0/1），可空一律 `| null`（不是 undefined）——
// JSON 里不出现 undefined 键，前端拿到的字段集合是稳定的。

import type { BalanceQueryTemplate, BalanceUnit } from '../db/balance-query.js';

/**
 * 契约 §2 余额查询失败引导码（ADR-0012 §4）。
 *
 * **不是错误码**：不进 `ERROR_CODES`、不映射 HTTP 状态 —— "查不到余额"不是 HTTP 层的失败，
 * 刷新任务本身是成功的（`202` + `ok` 计数）。它只是给前端一个"该引导用户做什么"的指针。
 */
export type HintCode =
  | 'BALANCE_QUERY_UNSUPPORTED'
  | 'BALANCE_PARSE_MISMATCH'
  | 'BALANCE_UPSTREAM_UNREACHABLE'
  | 'BALANCE_AUTH_REJECTED';

/** 契约 §2 内置余额查询 preset 的命中情况。**只读、可推导**，传了也不生效。 */
export interface BalancePresetDto {
  id: string;
  label: string;
  matchedBy: 'host';
  /** 当前真正生效的是它（即用户模板未启用） */
  effective: boolean;
}

/** 自测的查询来源。③（无查询方式）走不到 —— 那种情况直接 422。 */
export type BalanceTestSource = 'user-template' | 'preset';
export type BalanceTestErrorCode = 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED';

/** 契约 §2 自测解析结果。`balance` 是**分**；`null` = 取不到（与 0 严格区分）。 */
export interface BalanceTestParsed {
  balance: number | null;
  currency: string | null;
  remainingTokens: number | null;
  expiresAt: string | null;
  unit: BalanceUnit;
}

/**
 * 契约 §2 `BalanceTestResult` —— 两个自测端点共用（同步执行、**绝不写库**）。
 *
 * 业务性失败（上游不可达 / 取不到值）一律 `200` + `ok:false`：自测是**诊断**，
 * 前端要展示诊断结论，不该被错误分支吃掉。只有请求本身有问题才 4xx/5xx。
 */
export interface BalanceTestResult {
  ok: boolean;
  keyId: string | null;
  maskedKey: string | null;
  source: BalanceTestSource;
  presetId: string | null;
  /** 规范化后的 `协议//host/path`，已剥 query。绝不回显替换过 `{key}` 的 URL */
  endpoint: string;
  /** HTTP 状态；`0` = 没拿到响应（不可达 / 超时） */
  httpStatus: number;
  durationMs: number;
  parsed: BalanceTestParsed;
  /** 上游响应体，已抹掉明文 key 的所有出现并截断至 8KB。取值路径没配对时靠它定位 */
  raw: unknown;
  errorCode: BalanceTestErrorCode | null;
  hintCode: HintCode | null;
  hint: string | null;
}

/** 契约 §0.3 分页信封 */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 契约 §2 Upstream */
export interface UpstreamDto {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  /**
   * 契约 §2 `supplier`（v1.4.0）。**只读语义、可写入**。
   *
   * 它存在的唯一目的是让 `baseUrl` 的 host **不被当成能力判据**：猜错会静默走错驱动器，
   * 而"这个上游有没有账号面"是管理员建上游时就知道的事，不该让代码去反推。
   */
  supplier: string | null;
  keyCount: number;
  enabledKeyCount: number;
  /** 分；全部未知时 null。组成 = `Σ账号 + Σ无账号归属的 key`（§15.6 / ADR-0018 决策 3） */
  totalBalance: number | null;
  /** `category='balance' AND unlimited=0 AND balance_cents IS NULL` */
  balanceUnknownKeyCount: number;
  /** `balanceKeyCount` 的子集：无限额度 key 数。**不额外相加、也不进未知计数** */
  unlimitedKeyCount: number;
  tokenPlanKeyCount: number;
  /** §15 账号数；通用上游恒 0 */
  accountCount: number;
  /** 账号级余额合计（分）；通用上游恒 null */
  accountsBalance: number | null;
  accountsBalanceUnknownCount: number;
  /** `totalBalance` 里由 key 贡献的那一半，供前端拆解合计；**不是**新增的一份钱 */
  keysBalance: number | null;
  balanceQuery: BalanceQueryTemplate;
  /** 该 upstream 的 baseUrl 命中的内置 preset；没命中为 null。用户模板启用后它仍返回，只是 `effective:false` */
  balancePreset: BalancePresetDto | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** 契约 §3 Key */
export type KeyCategory = 'balance' | 'token-plan';
export type KeyHealth = 'healthy' | 'cooling' | 'disabled';
export type FailureReasonCode =
  | 'AUTH_INVALID'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_BALANCE'
  | 'UPSTREAM_ERROR'
  | 'NETWORK';

export interface TokenPlanDto {
  remainingTokens: number;
  expiresAt: string | null;
}

export interface KeyDto {
  id: string;
  upstreamId: string;
  label: string;
  maskedKey: string;
  category: KeyCategory;
  enabled: boolean;
  weight: number;
  /**
   * 契约 §3 `unlimited`（v1.4.0）。无限额度 key 的 `balance` **恒为 `null`**（§15.7），
   * 于是它与"还没查到余额"在 JSON 上逐字同形。
   *
   * **`unlimited: true` 优先于任何负值渲染**（§15.6）：上游给这类 key 的 `remain_quota`
   * 是无意义的负数（如 `-331119`），前端若照抄会把"无限"画成"欠费"。
   */
  unlimited: boolean;
  /** 分；null = 未知 */
  balance: number | null;
  balanceCurrency: string | null;
  balanceUpdatedAt: string | null;
  balanceSource: 'manual' | 'template' | null;
  tokenPlan: TokenPlanDto | null;
  health: KeyHealth;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastFailureReason: FailureReasonCode | null;
  lastFailureAt: string | null;
  todayTokens: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** 契约 §4 Group */
export interface GroupDto {
  id: string;
  name: string;
  gatewayKeyMasked: string | null;
  /** null = 不限 */
  rpm: number | null;
  tpm: number | null;
  dailyQuota: number | null;
  dailyQuotaUsed: number;
  todayUsage: { requests: number; tokens: number; costCents: number };
  keyCount: number;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 契约 §4 网关 key 列表项（`GET /api/groups/:id/keys`）。
 *
 * 故意只有三个字段：`id` 是重置/吊销唯一能用的入参，`maskedKey` 给人眼认，
 * `createdAt` 是列表的排序键。**不回 `updatedAt`** —— 网关 key 的改法是删旧行插新行，
 * 它恒等于 `createdAt`，回一个永远相等的字段只会让调用方以为它可能不同。
 */
export interface GatewayKeyDto {
  id: string;
  maskedKey: string;
  createdAt: string;
}

/** 契约 §4 建组/签发网关 key 的响应：明文只在这里出现一次 */
export interface GatewayKeyIssuedDto {
  id: string;
  gatewayKey: string;
  maskedKey: string;
  createdAt: string;
}

/** 契约 §5 Model */
export type ModelType = 'chat' | 'embedding' | 'image' | 'audio' | 'rerank';
export type ModelCapability = 'stream' | 'function_call' | 'vision' | 'json_mode';

export interface ModelDto {
  id: string;
  name: string;
  displayName: string | null;
  upstreamId: string;
  type: ModelType;
  capabilities: ModelCapability[];
  contextLength: number | null;
  /** 两端都缺失时整体为 null；前端显示 — */
  price: { inputPer1k: number | null; outputPer1k: number | null } | null;
  availableKeyIds: string[];
  enabled: boolean;
  lastSyncedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** 契约 §5 任务对象 */
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export interface TaskDto {
  id: string;
  type: string;
  status: TaskStatus;
  progress: { done: number; total: number };
  message: string | null;
  result: unknown;
  startedAt: string;
  finishedAt: string | null;
}

/** 契约 §6 调用记录 */
export interface LogDto {
  id: string;
  ts: string;
  /** 关联键（契约 §6「关联键 `x-request-id`」/ ADR-0014）。本列上线前的历史行为 `null` */
  requestId: string | null;
  groupId: string | null;
  model: string | null;
  upstreamId: string | null;
  keyMasked: string;
  status: number;
  errorCode: string | null;
  tokens: { prompt: number; completion: number; total: number; isEstimated: boolean };
  latencyMs: number | null;
  ttfbMs: number | null;
  stream: boolean;
}

/** 契约 §6 审计 */
export interface AuditDto {
  id: string;
  ts: string;
  actor: string;
  ip: string;
  action: string;
  targetType: string;
  targetId: string | null;
  result: 'ok' | 'fail';
}

/** 契约 §1 会话 */
export interface SessionDto {
  username: string;
  expiresAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 契约 §12 运维观测（v1.1.0）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 契约 §12.1 错误事件**分型**（9 值）。
 *
 * 这是本模块最容易踩的坑，所以写在类型注释里：它**不是错误码**。
 * 面向调用方的码在 §10 `GATEWAY_ERROR_CODES`（`gatewayCode` 字段），
 * 计入 key 失败的 5 类在 `FailureReasonCode`（`failureReason` 字段）。
 * 三者可以不同且都正确 —— 见契约 §12.1「三层口径不可互相替代」。
 */
export type GatewayErrorCategory =
  | 'CLIENT_REQUEST'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'NO_AVAILABLE_KEY'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'CLIENT_ABORTED'
  | 'INTERNAL';

export type GatewayErrorSeverity = 'warn' | 'error';

/** 契约 §12.1 网关错误事件 */
export interface GatewayErrorEventDto {
  id: string;
  ts: string;
  /** 关联键（契约 §6「关联键 `x-request-id`」/ ADR-0014）。本列上线前的历史行为 `null` */
  requestId: string | null;
  severity: GatewayErrorSeverity;
  category: GatewayErrorCategory;
  /** 回给客户端的 HTTP 状态；客户端断开为 499（该值只存在于事件流，§10 未登记） */
  status: number;
  gatewayCode: string | null;
  failureReason: FailureReasonCode | null;
  endpoint: string;
  model: string | null;
  upstreamId: string | null;
  keyId: string | null;
  /** 永远只有 ****后4位；`null` = 这次失败与某把具体 key 无关 */
  keyMasked: string | null;
  stream: boolean;
  upstreamStatus: number | null;
  /** 真实上游尝试次数；`0` = 一次都没发出去（配置/密文侧问题的判据） */
  attempts: number;
  candidates: number | null;
  latencyMs: number | null;
  /** 已 scrub + 截断 512 字符 */
  message: string | null;
}

/** 契约 §12.2 延迟分位。`samples=0` 时两个分位是 `null`（未知 != 0）。 */
export interface LatencyPercentilesDto {
  p50: number | null;
  p99: number | null;
  samples: number;
}

/** 契约 §12.2 窗口流量指标。与 §6 `overview` 同一份 SQL、同一口径。 */
export interface HealthTrafficDto {
  qps: number;
  successRate: number;
  requests: number;
  errors: number;
  tokens: { prompt: number; completion: number; total: number };
  latencyMs: LatencyPercentilesDto;
}

/** 契约 §12.2 key 健康总览 */
export interface HealthKeysDto {
  total: number;
  healthy: number;
  cooling: number;
  disabled: number;
  items: {
    keyId: string;
    maskedKey: string;
    upstreamId: string;
    health: KeyHealth;
    cooldownUntil: string | null;
    consecutiveFailures: number;
  }[];
}

/** 契约 §12.2 DB 状态。**不返回库文件路径** —— 那是部署细节。 */
export interface HealthDbDto {
  /** 真跑一次 `SELECT 1` 的结果，不是"连接对象还在" */
  ok: boolean;
  schemaVersion: number;
  fileSizeBytes: number | null;
  walSizeBytes: number | null;
  queryMs: number;
}

/** 契约 §12.2 错误分型计数。**不补 0**：只列出现过的分型。 */
export interface HealthEventCategoryDto {
  category: GatewayErrorCategory;
  severity: GatewayErrorSeverity;
  count: number;
  lastAt: string;
}

export interface HealthEventsDto {
  total: number;
  /** 进程启动以来**累计**丢弃的事件条数（不是窗口内） */
  dropped: number;
  byCategory: HealthEventCategoryDto[];
}

/**
 * 契约 §12.2 / §13.4 `assistant` —— 内置助手的**独立计量**。
 *
 * 本进程内计数、重启归零、不落表（与 `events.dropped` 同属"本进程"口径，不是窗口内量）。
 * 之所以能在 §12.2 只读暴露：助手调用**计入 key 健康**（`keys.*` 含它的影响），但
 * **不计入业务流量口径**（不写 `usage_logs`，故 `traffic.*` 不含它）—— 值班必须能把
 * "助手把并发槽位吃满"与"业务流量打满"分开归因，否则会去查一个根本不存在的流量尖峰。
 *
 * 结构上等同于 `src/wiring/assistant-invoker.ts` 的 `AssistantMetrics`。刻意不复用那个类型：
 * 依赖方向是 wiring → api，dto 反向 import wiring 会绕出一个环（AGENTS.md §8）。
 * 两端形状由 §12.2 钉住，`server.ts` 以此为接线点，字段增删必须同时改契约。
 */
export interface AssistantMetricsDto {
  /** 助手调用总次数 */
  requests: number;
  /** 以 `error` 终止帧结束的次数 */
  errors: number;
  /** 累计 token（上游 usage 或字符估算） */
  tokens: { prompt: number; completion: number; total: number };
}

/** 契约 §12.2 `GET /api/observability/health` */
export interface HealthMetricsDto {
  generatedAt: string;
  /** 归一化后回显；前端按它渲染，不自算 */
  window: string;
  uptimeSec: number;
  startedAt: string;
  traffic: HealthTrafficDto;
  keys: HealthKeysDto;
  db: HealthDbDto;
  events: HealthEventsDto;
  /** 契约 §12.2 / §13.4：助手独立计量。未接线时为全 0（这是事实：本进程确实没跑过助手调用） */
  assistant: AssistantMetricsDto;
}

/** 契约 §12.2 / §12.3 历史健康快照。落当时算出来的结果，不事后重算。 */
export interface HealthSnapshotDto {
  id: string;
  ts: string;
  windowSec: number;
  qps: number;
  successRate: number;
  requests: number;
  errors: number;
  p50Ms: number | null;
  p99Ms: number | null;
  keys: { total: number; healthy: number; cooling: number; disabled: number };
  dbOk: boolean;
  errorCount: number;
}

/**
 * 契约 §14.3 自动同步的**生效参数回显**。
 *
 * 前端**不得**自算间隔 / 抖动 / 退避 —— 这些数只在这里给一次，前端抄了就会和
 * 后端漂成两个值（同 `HealthMetricsDto.window` 的"归一化后回显"纪律）。
 */
export interface BalanceSyncAutoDto {
  enabled: boolean;
  intervalMinutes: number;
  jitterRatio: number;
  backoffCapMinutes: number;
}

/** 契约 §14.3 每上游运行态。退避与单飞都在**进程内存**里，重启即归零（ADR-0010 同款降级）。 */
export interface BalanceSyncUpstreamStateDto {
  upstreamId: string;
  name: string;
  /** 该上游最近一条快照的 `ts`（上游级 `asOf`）；从未同步过为 `null` */
  lastSyncedAt: string | null;
  consecutiveFailures: number;
  /** 退避中非空；无排程（自动同步关闭）为 `null`。刻意不与 `nextRunAt` 求同：两者取的不是同一批上游 */
  nextAttemptAt: string | null;
  inFlight: boolean;
}

/**
 * 契约 §14.3 快照点。**自带 `t`** —— 本节刻意没有等长 `axis`：
 * 同步节奏本身不规则（抖动 + 退避 + 关闭期），造一条均匀轴就得发明不存在的点。
 */
export interface BalanceSnapshotPointDto {
  t: string;
  /** 分；`null` = 那一刻该上游 balance 类 key **全部未知**（不是 0） */
  totalBalanceCents: number | null;
  /** `balanceKeyCount` − unknown − unlimited。**三格加起来才是那一刻的 key 总数**（v1.6.0） */
  knownKeyCount: number;
  unknownKeyCount: number;
  /** v1.6.0：无限额度那一格。缺了它 `known + unknown` 会平白少一批 key 而无人能解释 */
  unlimitedKeyCount: number;
  tokenPlanKeyCount: number;
}

export interface BalanceSyncSeriesDto {
  upstreamId: string;
  /** 展示名来自快照行的 `upstream_name`：上游被物理删除后这一路仍可读 */
  label: string;
  points: BalanceSnapshotPointDto[];
}

/**
 * 契约 §14.4 漂移提示码。**地位同 `hintCode`**：不进 `ERROR_CODES`、
 * 不影响任何 HTTP 状态、不拦请求 —— 它只是"给管理员看一眼"的方向级提示。
 */
export type BalanceDriftCode = 'BALANCE_SPENT_WITHOUT_TRAFFIC' | 'BALANCE_UNCHANGED_WITH_TRAFFIC';

export interface BalanceDriftAlertDto {
  code: BalanceDriftCode;
  upstreamId: string;
  /** 相邻两次快照的较早 / 较晚时刻（判定的窗口两端） */
  from: string;
  to: string;
  /** 该窗口内本网关的 token 用量（上游级，不按 key 过滤） */
  usedTokens: number;
}

export interface BalanceDriftDto {
  since: string;
  /** 进程内计数，重启归零（`balance_drift_total{code}`），**不是**窗口内计数 */
  counts: Record<BalanceDriftCode, number>;
  /** 按 `to` 倒序，上限 20 条 */
  alerts: BalanceDriftAlertDto[];
}

/** 契约 §14.3 `GET /api/stats/balance/sync` */
export interface BalanceSyncStatusDto {
  auto: BalanceSyncAutoDto;
  /** 最近一次同步**完成**的时刻（任意触发都算）；从未同步过为 `null` */
  lastSyncedAt: string | null;
  lastTrigger: 'auto' | 'manual' | null;
  /** 自动同步下一次计划时刻（已含抖动）；关闭时为 `null` */
  nextRunAt: string | null;
  window: { from: string; to: string };
  upstreams: BalanceSyncUpstreamStateDto[];
  series: BalanceSyncSeriesDto[];
  drift: BalanceDriftDto;
}

// ---------------------------------------------------------------------------
// §15 供应商账号面（TierFlow）
// ---------------------------------------------------------------------------

/**
 * 契约 §15.1 `credentialSource`。
 *
 * 它回答的是**一个具体问题**「会话过期后能不能自动重登」：`password` = 库里有存档密码、能；
 * `session` = 只有会话、不能（§15.9 明示取舍）。前端**不自行推断** ——
 * 「有会话」和「能重登」是两件事，用 `hasSession` 推 `credentialSource` 一定推错。
 */
export type SupplierCredentialSource = 'password' | 'session';

/** 契约 §15.1 账号状态。`unknown` = **从未成功查询过**，不是"正常"的同义词。 */
export type SupplierAccountStatus = 'active' | 'login_failed' | 'session_expired' | 'unknown';

/** 契约 §15.1 套餐摘要。金额一律 int **分**；上游给的是 quota 或**浮点元**，换算全在后端。 */
export interface SupplierSubscriptionDto {
  subNo: string;
  planTitle: string | null;
  planSlug: string | null;
  amountTotalCents: number | null;
  amountUsedCents: number | null;
  paidCents: number | null;
  basicTokenTotal: number | null;
  basicTokenUsed: number | null;
  status: string | null;
  source: string | null;
  startAt: string | null;
  endAt: string | null;
  /**
   * **三态**：`true` / `false` 是上游明确给了；`null` 是**上游根本没这个字段**。
   * 合并成两态，等于把"供应商没告诉我们"当成"不会自动续费" —— 替对方下了结论。
   */
  autoRenew: boolean | null;
  hasKey: boolean;
  /** 套餐 key **只有掩码、永不进池**（ADR-0018 决策 7） */
  keyMasked: string | null;
  updatedAt: string;
}

/**
 * 契约 §15.2 `GET /api/supplier-accounts/subscriptions` 的一行 = `SupplierSubscriptionDto`
 * **加上"它是谁的"**。
 *
 * 为什么必须带归属：套餐列表是**跨账号**的（详情页里那个 `subscriptions[]` 天然知道
 * 自己属于谁，扁平列表不知道）。只给 `subNo` 的列表在读的人眼里是一串没有主语的编号，
 * 对账时第一句话就是"这是哪个号的" —— 而那正是这个端点存在的用途。
 *
 * 归属字段**只放掩码**（`accountIdentifier`），真值连这个端点也不出后端（§15.1）。
 */
export interface SupplierSubscriptionRowDto extends SupplierSubscriptionDto {
  accountId: string;
  /** **掩码**手机号 / 邮箱。与 §15.1 同一条纪律：真值不出后端 */
  accountIdentifier: string;
  upstreamId: string;
}

/** 契约 §15.1 `SupplierAccount`（`GET /api/supplier-accounts` 列表项与详情共用同一形状）。 */export interface SupplierAccountDto {
  id: string;
  upstreamId: string;
  supplier: string;
  /** **掩码**手机号 / 邮箱。真值不出后端 */
  identifier: string;
  username: string | null;
  uid: string | null;
  status: SupplierAccountStatus;
  /** 面向人的一句话。只放供应商错误码或通用原因，不含凭据 */
  statusMessage: string | null;
  /** 分；`null` = 未知 ≠ 0（ADR-0003） */
  balanceCents: number | null;
  /** 最近一次**真的查到**余额的时刻。查失败**不动它** —— 否则会渲染成"刚查过"，而事实是没查到 */
  balanceUpdatedAt: string | null;
  /** 归属本账号、**已入池**（`upstream_keys` 未软删）的 key 数 */
  keyCount: number;
  /** `keyCount` 中 `unlimited = 1` 的条数。**是子集，不额外相加**（§15.7 不变量） */
  unlimitedKeyCount: number;
  /** 只拿到掩码、**进不了池**的 key 数（对账用）。**不得与 `keyCount` 相加成"key 总数"** */
  maskedKeyCount: number;
  /** **恒为数组**：上游给的是 `all_subscriptions: []`，单数对象表达不了"没有套餐" */
  subscriptions: SupplierSubscriptionDto[];
  /** 「能不能自动重登」，由它回答；与 `hasSession` **正交** */
  credentialSource: SupplierCredentialSource;
  /** 只回答**有无**。会话值永不出后端 */
  hasSession: boolean;
  sessionExpiresAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
