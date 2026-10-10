/**
 * 管理面契约类型层 —— docs/api-contract.md v1.0-frozen 的逐字段映射。
 *
 * 纪律（来自契约 §0.2，违反即红线）：
 * - 金额：`int`，单位**分**。拿不到是 `null`，**不是 0**。
 * - token：永远是 `int`。
 * - 时间：ISO8601 UTC 字符串（不带时区的时间串视为非法）。
 * - id：不透明 string，前端不解析。
 * - `health` / `cooldownUntil` / `consecutiveFailures` 是网关运行态，**只读**。
 *
 * 本文件不含任何 mock 默认值：所有可空字段都显式建模为 `| null`，
 * 让「未知」在类型层就无法被悄悄降级成 0。
 */

// ── §0 通用 ────────────────────────────────────────────────────────────────

/** 所有列表统一分页信封（§0.3）。`items` 为空是**合法**空态，不是错误。 */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 分页请求参数。`pageSize` 上限 200，超限后端返回 400 INVALID_PARAM。 */
export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export const PAGE_SIZE_MAX = 200;
export const PAGE_SIZE_DEFAULT = 20;

/** ISO8601 UTC 时间串。 */
export type Iso8601 = string;

/** 金额，单位分。 */
export type Cents = number;

/** 契约 §0.4 错误码全集，前端按 code 分支，不按 message 文案分支。 */
export type ApiErrorCode =
  | 'INVALID_PARAM'
  | 'UNAUTHORIZED'
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'CSRF_REJECTED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'REVISION_MISMATCH'
  | 'UPSTREAM_HAS_KEYS'
  /** v1.4.0 首次新增的错误码（409）：删账号时名下还有已入池 key。**只解绑、不删 key**。 */
  | 'ACCOUNT_HAS_KEYS'
  | 'UNPROCESSABLE'
  | 'TOO_MANY_ATTEMPTS'
  | 'INTERNAL'
  | 'UPSTREAM_UNREACHABLE'
  | 'TASK_FAILED';

// ── §1 鉴权 ───────────────────────────────────────────────────────────────

/** `GET /api/auth/session` 与 `POST /api/auth/login` 的 200 响应。 */
export interface SessionInfo {
  username: string;
  expiresAt: Iso8601;
}

export interface LoginRequest {
  username: string;
  password: string;
}

// ── §2 上游 ───────────────────────────────────────────────────────────────

/** 余额模板的响应解析路径。空串/字段缺失统一用 `null`。 */
export interface BalanceParseRules {
  /** 如 `data.balance_infos[0].total_balance` */
  balance: string;
  currency: string | null;
  remainingTokens: string | null;
  expiresAt: string | null;
  /** 上游给的单位，统一换算到「分」是后端的责任。 */
  unit: 'yuan' | 'cents' | 'dollar';
}

/**
 * 余额查询模板。
 * 安全：`headers` 里的 `{key}` 是占位符，执行时才替换；替换后的串永不下发。
 */
export interface BalanceQueryTemplate {
  /** `false` ⇒ 该上游只能手动录入余额。 */
  enabled: boolean;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | null;
  parse: BalanceParseRules;
  timeoutMs: number;
}

/** 内置余额查询 preset（只读、可推导，永不落库；本批仅注册 `openai`）。 */
export interface BalancePreset {
  id: string;
  label: string;
  matchedBy: 'host';
  /** 当前真正生效的是它（即用户模板未启用）。 */
  effective: boolean;
}

/**
 * 余额查询失败引导码。**不是错误码**：不进 `ERROR_CODES`、不映射 HTTP 状态，
 * 只是给前端一个「该引导用户做什么」的指针。
 */
export type HintCode =
  | 'BALANCE_QUERY_UNSUPPORTED'
  | 'BALANCE_PARSE_MISMATCH'
  | 'BALANCE_UPSTREAM_UNREACHABLE'
  | 'BALANCE_AUTH_REJECTED'
  /**
   * v1.7.0 新增（§15.3 `failed` 子型）。**判据只是 HTTP 429**（契约第 328 行），
   * 所以文案只能陈述"这一轮请求被拒绝"，**不得**写成"出口被限流" —— 归因归检测器，不归 UI。
   */
  | 'BALANCE_EGRESS_RATE_LIMITED';

/** 自测的查询来源。③（无查询方式）走不到，直接 422。 */
export type BalanceTestSource = 'user-template' | 'preset';

export type BalanceTestErrorCode = 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED';

/** 自测解析结果。`balance` 是分；`null` = 取不到（与 0 严格区分）。 */
export interface BalanceTestParsed {
  balance: Cents | null;
  currency: string | null;
  remainingTokens: number | null;
  expiresAt: Iso8601 | null;
  unit: 'yuan' | 'cents' | 'dollar';
}

/**
 * 两个自测端点共用的响应（同步、不写库）。业务性失败仍 200 + `ok:false`。
 * `raw` 是上游原文，后端已抹掉明文 key 并截断 8KB；前端只做只读展示，绝不当 HTML 渲染。
 */
export interface BalanceTestResult {
  ok: boolean;
  keyId: string | null;
  maskedKey: string | null;
  source: BalanceTestSource;
  presetId: string | null;
  /** 规范化后的 `协议//host/path`，已剥 query，绝不回显替换过 `{key}` 的 URL。 */
  endpoint: string;
  httpStatus: number;
  durationMs: number;
  parsed: BalanceTestParsed;
  raw: unknown;
  errorCode: BalanceTestErrorCode | null;
  hintCode: HintCode | null;
  hint: string | null;
}

/** 自测草稿模板 = 余额查询模板去掉 `enabled`（测试语义无「启用」）。 */
export type BalanceTestTemplate = Omit<BalanceQueryTemplate, 'enabled'>;

/**
 * 上游级自测请求体 = 草稿模板 + 可选 `keyId`。
 * `keyId` 缺省 = 上游第一把 `enabled=true` 且 `category="balance"` 的 key（契约 §2）。
 */
export interface BalanceTemplateTestRequest extends BalanceTestTemplate {
  keyId?: string;
}

/**
 * 余额刷新任务的 `result`：原计数 + 失败引导两字段（非破坏新增，计数语义不变）。
 */
export interface BalanceRefreshResult {
  checked: number;
  ok: number;
  failed: number;
  unknown: number;
  skipped: number;
  hintCode: HintCode | null;
  hint: string | null;
  /**
   * #12（共享形状，PM 钉死）：本地拒绝带回的 `Retry-After`，单位**整数秒**。
   * `null` / 字段缺席 = 无建议 —— 展示位**不渲染**，不编默认秒数。
   * 后端（管家 #16）把该字段带进刷新结果；`hintCode` 非 429 型时恒为 `null`。
   */
  retryAfterSeconds: number | null;
}

export interface Upstream {
  id: string;
  name: string;
  baseUrl: string;
  /**
   * §2 `supplier`（v1.4.0）。它存在的唯一目的是让 host **不被当成能力判据** ——
   * 「这个上游有没有账号面」由管理员建上游时就指定，前端**不得**去 parse `baseUrl` 反推。
   * 判据只有一条：`supplier === 'tierflow'`（§15.12 锚 1）。
   */
  supplier: string | null;
  enabled: boolean;
  keyCount: number;
  enabledKeyCount: number;
  /**
   * 本上游合计（分）。全部未知时是 `null`，不是 0。
   * 组成 = `Σ账号 + Σ无账号归属的 key`（§15.6 / ADR-0018 决策 3）——
   * 所以它**不是** `accountsBalance + keysBalance` 之外的新一份钱，另两个字段是拆解用的。
   */
  totalBalance: Cents | null;
  /** 余额未知的 key 数。**未知 ≠ 0**，UI 必须单独呈现。 */
  balanceUnknownKeyCount: number;
  /** `balance` 类 key 中 `unlimited=1` 的子集。**是子集：不额外相加、也不进未知计数**。 */
  unlimitedKeyCount: number;
  /** token-plan 类 key 数。这类**不进** totalBalance。 */
  tokenPlanKeyCount: number;
  /** §15 账号数。**通用上游恒 0**（0 是"没有账号面"，不是"没查到"）。 */
  accountCount: number;
  /** 账号级余额合计（分）；通用上游恒 `null`。 */
  accountsBalance: Cents | null;
  accountsBalanceUnknownCount: number;
  /** `totalBalance` 里由 key 贡献的那一半（分，供拆解合计）；**不是**新增的一份钱。 */
  keysBalance: Cents | null;
  balanceQuery: BalanceQueryTemplate | null;
  /** 内置 preset（只读、可推导）。未命中任何 preset 时为 `null`。 */
  balancePreset: BalancePreset | null;
  revision: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface UpstreamListQuery extends PageQuery {
  q?: string;
  enabled?: boolean;
}

/**
 * v1.4.0 起 `supplier` **可写**（§15.6：上游表单多一个可选「供应商」下拉，缺省 = 通用）。
 * 取值只有两个：`null` = 通用上游，`'tierflow'` = 走 §15 账号面。
 * 服务端 schema 是 `enum: [null, 'tierflow']`，写别的值会当场 400。
 */
export type SupplierKind = 'tierflow';

export interface UpstreamCreateRequest {
  name: string;
  baseUrl: string;
  enabled?: boolean;
  supplier?: SupplierKind | null;
  balanceQuery?: BalanceQueryTemplate;
}

/** PATCH 只发变更子集 + `revision`（乐观锁）。 */
export interface UpstreamPatchRequest {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  supplier?: SupplierKind | null;
  balanceQuery?: BalanceQueryTemplate | null;
  revision: number;
}

// ── §3 Key ────────────────────────────────────────────────────────────────

export type KeyCategory = 'balance' | 'token-plan';

/** 网关运行态健康度，管理端只读。`disabled` 优先于 `cooling`。 */
export type KeyHealth = 'healthy' | 'cooling' | 'disabled';

/** §10：只有这五类计入 key 失败。 */
export type FailureReason =
  | 'AUTH_INVALID'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_BALANCE'
  | 'UPSTREAM_ERROR'
  | 'NETWORK';

export type BalanceSource = 'manual' | 'template';

export interface TokenPlan {
  remainingTokens: number;
  expiresAt: Iso8601 | null;
}

export interface UpstreamKey {
  id: string;
  upstreamId: string;
  label: string;
  /** 后端唯一出口，形如 `****a1b2`。明文永不出现。 */
  maskedKey: string;
  category: KeyCategory;
  enabled: boolean;
  weight: number;
  /** `null` = **未知**（查不到或从未录入）。UI 显示「未知」，绝不显示 0。 */
  balance: Cents | null;
  balanceCurrency: string | null;
  balanceUpdatedAt: Iso8601 | null;
  balanceSource: BalanceSource | null;
  /** `category="token-plan"` 时非空，此时 `balance` 恒为 `null`。 */
  tokenPlan: TokenPlan | null;
  health: KeyHealth;
  cooldownUntil: Iso8601 | null;
  consecutiveFailures: number;
  lastFailureReason: FailureReason | null;
  lastFailureAt: Iso8601 | null;
  /** 自然日（UTC）累计 token。 */
  todayTokens: number;
  revision: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
  /**
   * 非空 = 已软删。来源只有 `DELETE /api/keys/:id` 这一条 —— 上游删除（ADR-0016）走的是
   * **物理删除整棵子树**，不留软删行（v1.2.2 起）。
   */
  deletedAt: Iso8601 | null;
}

export interface KeyListQuery extends PageQuery {
  upstreamId?: string;
  category?: KeyCategory;
  enabled?: boolean;
  health?: KeyHealth;
  q?: string;
  /** 默认不含已软删；`true` 才显式查询。 */
  includeDeleted?: boolean;
}

export interface KeyCreateRequest {
  upstreamId: string;
  /** 明文只在此处进入系统，响应只回 maskedKey。 */
  key: string;
  category: KeyCategory;
  label?: string;
  weight?: number;
  balance?: Cents | null;
  tokenPlan?: TokenPlan | null;
}

export interface KeyPatchRequest {
  label?: string;
  enabled?: boolean;
  weight?: number;
  category?: KeyCategory;
  tokenPlan?: TokenPlan | null;
  revision: number;
}

/** `PUT /api/keys/:id/balance`：`0` 合法，与「未知」(`null`) 严格区分。 */
export interface KeyBalanceUpsertRequest {
  balance: Cents | null;
  currency?: string;
  note?: string;
}

export interface KeyBatchRequest {
  ids: string[];
  action: 'enable' | 'disable';
}

export interface KeyBatchResult {
  updated: number;
}

// ── §4 用户组 ─────────────────────────────────────────────────────────────

/** `null` ⇒ **不限**（契约 §4）。 */
export type QuotaValue = number | null;

export interface GroupUsageToday {
  requests: number;
  tokens: number;
  costCents: Cents;
}

export interface Group {
  id: string;
  name: string;
  gatewayKeyMasked: string | null;
  rpm: QuotaValue;
  tpm: QuotaValue;
  dailyQuota: QuotaValue;
  dailyQuotaUsed: number;
  todayUsage: GroupUsageToday;
  keyCount: number;
  enabled: boolean;
  revision: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface GroupCreateRequest {
  name: string;
  rpm?: QuotaValue;
  tpm?: QuotaValue;
  dailyQuota?: QuotaValue;
}

export interface GroupPatchRequest {
  name?: string;
  rpm?: QuotaValue;
  tpm?: QuotaValue;
  dailyQuota?: QuotaValue;
  enabled?: boolean;
  revision: number;
}

/**
 * 建组响应 = Group + 明文 `gatewayKey`（**仅此一次**）。
 * 前端纪律：弹窗关闭即从内存丢弃，不缓存、不写 localStorage。
 */
export interface GroupCreateResponse extends Group {
  gatewayKey: string;
}

export interface GroupKeyIssued {
  id: string;
  gatewayKey: string;
  maskedKey: string;
  createdAt: Iso8601;
}

export interface GroupKeyResetResponse {
  gatewayKey: string;
  maskedKey: string;
}

// ── §5 模型 ───────────────────────────────────────────────────────────────

export type ModelType = 'chat' | 'embedding' | 'image' | 'audio' | 'rerank';
export type ModelCapability = 'stream' | 'function_call' | 'vision' | 'json_mode';

/** 单价，单位分/1k tokens。整体为 `null` 表示上游没给（≠ 0）。 */
export interface ModelPrice {
  inputPer1k: Cents;
  outputPer1k: Cents;
}

export interface ModelProfile {
  id: string;
  name: string;
  displayName: string;
  upstreamId: string;
  type: ModelType;
  capabilities: ModelCapability[];
  contextLength: number | null;
  price: ModelPrice | null;
  /** 当前**可服务**该模型的 key（启用、非冷却、余额 > 0）。空数组 = 暂不可用。 */
  availableKeyIds: string[];
  /** 决定是否出现在 `/v1/models`；与验收 4 的逐项 0 差异直接相关。 */
  enabled: boolean;
  lastSyncedAt: Iso8601 | null;
  revision: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface ModelListQuery extends PageQuery {
  upstreamId?: string;
  type?: ModelType;
  capability?: ModelCapability;
  enabled?: boolean;
  q?: string;
}

export interface ModelPatchRequest {
  enabled?: boolean;
  type?: ModelType;
  capabilities?: ModelCapability[];
  contextLength?: number | null;
  price?: ModelPrice | null;
  displayName?: string;
  revision: number;
}

// ── §5.1 异步任务 ─────────────────────────────────────────────────────────

/**
 * 任务类型。后四个来自 §15.2 的四个批量端点（服务端 `startTask` 的取值，
 * 见 `src/api/services/supplier-accounts.ts`）。前端**不用它做分支判断**
 * —— 逐行结果一律读 `result.items`（§15.3），类型串只用来在浮层标题上指个来源。
 */
export type TaskType =
  | 'model_sync'
  | 'balance_refresh'
  | 'supplier_import'
  | 'supplier_refresh'
  | 'supplier_keys'
  | 'supplier_keys_sync';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface TaskProgress {
  done: number;
  total: number;
}

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  /** `total` 未知时为 `null`（如全量同步尚未枚举完）。 */
  progress: TaskProgress | null;
  message: string | null;
  result: unknown;
  startedAt: Iso8601 | null;
  finishedAt: Iso8601 | null;
}

export interface TaskAccepted {
  taskId: string;
}

// ── §6 统计 ───────────────────────────────────────────────────────────────

export type StatsWindow = '60s' | '5m' | '15m' | '1h';

export interface TokenBuckets {
  prompt: number;
  completion: number;
  total: number;
}

/** 余额聚合的一层（上游或全局）。 */
export interface BalanceScope {
  upstreamId?: string;
  name?: string;
  /** 全部未知时是 `null`，不是 0。 */
  totalBalance: Cents | null;
  balanceKeyCount?: number;
  /** 未知 ≠ 0，必须单独呈现。 */
  balanceUnknownKeyCount: number;
  tokenPlanKeyCount: number;
  currency?: string;
  /** 仅 `/api/stats/balance` 的 byUpstream 下钻带 `keys`。 */
  keys?: BalanceKeyRow[];
  byUpstream?: BalanceScope[];
}

export interface BalanceKeyRow {
  keyId: string;
  maskedKey: string;
  balance: Cents | null;
  balanceUpdatedAt?: Iso8601;
  balanceSource?: BalanceSource;
  balanceUnknownKeyCount?: number;
}

export interface BalanceStats {
  global: BalanceScope;
}

export interface KeyHealthRow {
  keyId: string;
  maskedKey: string;
  upstreamId: string;
  health: KeyHealth;
  cooldownUntil?: Iso8601;
}

export interface StatsOverview {
  /** **后端给**的时间窗口。前端不得用本地时间自算 QPS。 */
  window: StatsWindow;
  generatedAt: Iso8601;
  qps: number;
  /** 0..1 的小数，不是百分数。 */
  successRate: number;
  requests: number;
  errors: number;
  tokens: TokenBuckets;
  balance: BalanceStats;
  keyHealth: KeyHealthRow[];
}

export type UsageGroupBy = 'key' | 'upstream' | 'group' | 'model';
export type UsageBucket = '1m' | '5m' | '1h' | '1d';

export interface UsageQuery {
  from: Iso8601;
  to: Iso8601;
  groupBy: UsageGroupBy;
  bucket: UsageBucket;
  upstreamId?: string;
  groupId?: string;
  model?: string;
}

export interface UsagePoint {
  t: Iso8601;
  requests: number;
  tokens: number;
  /** token 维度补缺（ADR-0012）：输入/输出/估算分列，`tokens = prompt + completion`。 */
  promptTokens: number;
  completionTokens: number;
  /** 本点中 `is_estimated=1` 的调用条数，>0 时该点需标「含估算」。 */
  estimatedTokens: number;
  costCents: Cents;
  errors: number;
}

export interface UsageSeries {
  key: string;
  label: string;
  /** 与 `axis` **等长且下标对齐**；缺失桶补 0（计数补 0 是对的，与余额的 null 语义不同）。 */
  points: UsagePoint[];
}

export interface UsageStats {
  from: Iso8601;
  to: Iso8601;
  /** C2：允许后端降级，此处回显**实际**使用的 bucket，前端按回显渲染。 */
  bucket: UsageBucket;
  groupBy: UsageGroupBy;
  axis: Iso8601[];
  series: UsageSeries[];
  /** `is_estimated=1` 的调用条数，>0 时图表需标注「含估算」。 */
  isEstimatedTokenCount: number;
}

export interface CallLog {
  id: string;
  ts: Iso8601;
  groupId: string | null;
  model: string;
  upstreamId: string;
  /** 只 4 位。 */
  keyMasked: string;
  status: number;
  errorCode: string | null;
  tokens: TokenBuckets & { isEstimated: boolean };
  latencyMs: number;
  ttfbMs: number | null;
  stream: boolean;
}

export interface LogListQuery extends PageQuery {
  from?: Iso8601;
  to?: Iso8601;
  groupId?: string;
  model?: string;
  status?: number;
  upstreamId?: string;
  keyId?: string;
  includeDeleted?: boolean;
}

export interface AuditEntry {
  id: string;
  ts: Iso8601;
  actor: string;
  ip: string;
  action: string;
  targetType: string;
  targetId: string;
  result: string;
}

// ── §14 余额同步（v1.3.0） ────────────────────────────────────────────────

/**
 * `lastTrigger`：最近一次同步**完成**的触发方（`"auto"` | `"manual"`）—— **任意触发都算**，
 * 不是"最近一次自动同步"。从未同步过是 `null`。
 */
export type BalanceSyncTrigger = 'auto' | 'manual';

/**
 * 契约 §14.4 方向级漂移码。**只有这两个**，且**只 warn + 计数**：
 * 本地没有单价（`usage_logs` 只有 token、`balance` 只有分，量纲不可比），
 * 所以漂移**只能判方向 + 零/非零，不能判钱**。前端不得据此推断"对账不上"或建议扣减。
 */
export type BalanceDriftCode =
  | 'BALANCE_SPENT_WITHOUT_TRAFFIC'
  | 'BALANCE_UNCHANGED_WITH_TRAFFIC';

/**
 * 自动同步的**生效参数回显**。前端**不得自算**间隔 / 抖动 / 退避（契约 §14.3 逐字）。
 *
 * ⚠️ 这三个数是**服务端配置**（`BALANCE_SYNC_MINUTES` 环境变量）的只读投影，
 * **不是**可以从前端改写的字段：契约里**没有**写这个配置的端点，
 * 也**没有** `min_interval_minutes` 这样的每上游字段。UI 只能显示 + 指向部署侧。
 */
export interface BalanceSyncAuto {
  enabled: boolean;
  /** 基准间隔（分钟）。`enabled=false` 时该值仍回显配置值，但**不代表正在跑**。 */
  intervalMinutes: number;
  /** ±比例，如 `0.1` = ±10%。 */
  jitterRatio: number;
  /** 退避上限（分钟），契约冻结 360。 */
  backoffCapMinutes: number;
}

/** 每上游的运行态（§14.3 `upstreams[]`）：退避与单飞读面。 */
export interface BalanceSyncUpstreamState {
  upstreamId: string;
  name: string;
  /** 该上游最近一次同步**完成**时刻；从未同步过为 `null`。 */
  lastSyncedAt: Iso8601 | null;
  /** 连续失败次数（退避用）；任一成功即归零。 */
  consecutiveFailures: number;
  /** 退避中非空，否则 `null`。 */
  nextAttemptAt: Iso8601 | null;
  inFlight: boolean;
}

/**
 * 一个快照点 = 该上游**此刻**所有未软删 key 的余额状态（**照下来的相**，不是作业记录）。
 * `totalBalanceCents === null` 表示那一刻**全未知** —— **不是 0**（§0.2 / §14.2 绝不补 0）。
 */
export interface BalanceSyncPoint {
  t: Iso8601;
  totalBalanceCents: Cents | null;
  /** 推导值：`balanceKeyCount - unknownKeyCount - unlimitedKeyCount`，分列出来才解释得通缺口。 */
  knownKeyCount: number;
  unknownKeyCount: number;
  unlimitedKeyCount: number;
  tokenPlanKeyCount: number;
}

export interface BalanceSyncSeries {
  upstreamId: string;
  /** 上游名快照（ADR-0016：删上游后历史仍可读）。 */
  label: string;
  /** **不自带等长轴**：节奏不规则（抖动 + 退避 + 关闭期），要均匀轴就得发明不存在的点。 */
  points: BalanceSyncPoint[];
}

/**
 * 一条漂移告警：相邻两次快照 + 同窗口 token 用量。
 * `from` / `to` 是判定窗口两端，`usedTokens` 是**上游级**（不按 key 过滤）。
 */
export interface BalanceDriftAlert {
  code: BalanceDriftCode;
  upstreamId: string;
  from: Iso8601;
  to: Iso8601;
  usedTokens: number;
}

/** §14.4 漂移块。`counts` 是**进程内计数**（重启归零），**不是**窗口内计数。 */
export interface BalanceDrift {
  since: Iso8601;
  counts: Record<BalanceDriftCode, number>;
  /** 按 `to` 倒序，上限 20 条。 */
  alerts: BalanceDriftAlert[];
}

/** 契约 §14.3 `GET /api/stats/balance/sync` 的 200 响应。**只读**：不改状态、不触发查询。 */
export interface BalanceSyncStatus {
  auto: BalanceSyncAuto;
  lastSyncedAt: Iso8601 | null;
  lastTrigger: BalanceSyncTrigger | null;
  /** 已含抖动的下一次计划时刻；关闭自动同步时为 `null`。 */
  nextRunAt: Iso8601 | null;
  window: { from: Iso8601; to: Iso8601 };
  upstreams: BalanceSyncUpstreamState[];
  series: BalanceSyncSeries[];
  drift: BalanceDrift;
}

/**
 * `window` 为 `Ns` / `Nm` / `Nh`，上限 24h，**默认 `6h`**（解析规则同 §6 `overview`）。
 * 契约说得很清楚：这是**观测窗口**，与自动同步的节奏**无关** —— 别拿它当"同步间隔"。
 */
export interface BalanceSyncQuery {
  upstreamId?: string;
  window?: string;
}

// ── §7 实时通道 ───────────────────────────────────────────────────────────

export interface LiveReadyMessage {
  type: 'ready';
  serverTime: Iso8601;
  intervalMs: number;
}

export interface LiveMetricsMessage {
  type: 'metrics';
  window: StatsWindow;
  serverTime: Iso8601;
  qps: number;
  successRate: number;
  requests: number;
  tokensTotal: number;
  balanceGlobal: Cents | null;
  balanceUnknownKeyCount: number;
}

export interface LiveKeyHealthMessage {
  type: 'key_health';
  serverTime: Iso8601;
  keyId: string;
  upstreamId: string;
  maskedKey: string;
  health: KeyHealth;
  cooldownUntil: Iso8601 | null;
  lastFailureReason: FailureReason | null;
}

export interface LiveBalanceMessage {
  type: 'balance';
  serverTime: Iso8601;
  keyId: string;
  maskedKey: string;
  balance: Cents | null;
  balanceUpdatedAt: Iso8601;
  balanceSource: BalanceSource | null;
  globalTotalBalance: Cents | null;
  balanceUnknownKeyCount: number;
}

export interface LiveTaskMessage {
  type: 'task';
  taskId: string;
  status: TaskStatus;
  progress: TaskProgress | null;
  message: string | null;
}

export interface LiveErrorMessage {
  type: 'error';
  code: ApiErrorCode;
  message: string;
}

/** §7 `egress_pool` 帧的单个节点（**终局名**，与 `src/egress/heartbeat.ts` 的 `EgressPoolNode` 逐字对应）。 */
export interface EgressPoolNode {
  /** **不透明字符串**，只当键用，前端不得解析其内容（契约 §7 v1.6.4）。 */
  egressId: string;
  /** 显示名（用户可改）—— 只作展示，不作键。 */
  name: string;
  /** 池化层探活态。前端**不得**按 `lastHeartbeatAt` 的新鲜度自算健康。 */
  status: 'online' | 'offline';
  /** 探活观测到的出口 IP；null = 本次心跳未带回。 */
  exitIp: string | null;
  /** 登记期望值；null = 未登记。与 `exitIp` 不等时必须显式告警。 */
  expectedExitIp: string | null;
  /** 最近一次真证据的绝对时刻（ISO8601 UTC）；冷启动 = null。 */
  lastHeartbeatAt: string | null;
  /** 上游限流冷却解除时刻。**与 `status` 是两种不可用**，并列展示、不得互盖。 */
  cooldownUntil: string | null;
}

export interface LiveEgressPoolMessage {
  type: 'egress_pool';
  serverTime: Iso8601;
  /**
   * **池级一帧**。`[]` = 已接线且当前 0 个出口 ⇒ 「未配置出口」空态；
   * **收不到本帧 ≠ 0 个出口**（= 未接线/未发射，缺省不是证据）。N 节点自适应，不得写死数量。
   */
  nodes: EgressPoolNode[];
}

export type LiveMessage =
  | LiveReadyMessage
  | LiveMetricsMessage
  | LiveKeyHealthMessage
  | LiveBalanceMessage
  | LiveTaskMessage
  | LiveEgressPoolMessage
  | LiveErrorMessage;

/** 服务端可识别的入站帧（首帧 `auth` 仅作就绪确认，**不传 token**）。 */
export interface LiveAuthFrame {
  type: 'auth';
}

/** 契约 §7 关闭码。 */
export const WS_CLOSE = {
  /** 会话失效 → 跳登录 */
  SESSION_EXPIRED: 4401,
  /** 就绪超时 → 重连一次 */
  READY_TIMEOUT: 4408,
  /** 服务重启 → 退避重连 */
  SERVICE_RESTART: 1012,
  /** 正常关闭（登出）→ 不重连 */
  NORMAL: 1000,
} as const;

// ── §12 运维观测（只读） ──────────────────────────────────────────────────

/** §12.1 错误事件分型，9 值枚举。**唯一判据**，不由 HTTP 状态现推。 */
export const OBSERVABILITY_CATEGORIES = [
  'CLIENT_REQUEST',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'NO_AVAILABLE_KEY',
  'UPSTREAM_ERROR',
  'UPSTREAM_TIMEOUT',
  'CLIENT_ABORTED',
  'INTERNAL',
] as const;

export type ObservabilityCategory = (typeof OBSERVABILITY_CATEGORIES)[number];

/** §12.2 健康窗口。与 §6 `StatsWindow` 不同：观测面**没有** `15m`。 */
export type ObservabilityWindow = '60s' | '5m' | '1h';

export type ObservabilitySeverity = 'warn' | 'error';

// ── §13 内置 AI 助手聊天 `POST /api/assistant/chat`（v1.2.0） ─────────────

export type AssistantRole = 'system' | 'user' | 'assistant';

/** 一轮对话里的一条消息。多轮上下文由**客户端**原样回传（服务端无状态、不落库）。 */
export interface AssistantMessage {
  role: AssistantRole;
  content: string;
}

/**
 * §13.1 结构化取数参数 —— 逐字段复用 §12.3 白名单，**不造第二套口径**。
 * 省略 = 纯闲聊、不注入日志。
 */
export interface AssistantLogContext {
  window?: ObservabilityWindow;
  /** 带时区 ISO8601；与 `to` 跨度 > 24h 时服务端收窄并回 `truncated`（**不报 400**）。 */
  from?: Iso8601;
  to?: Iso8601;
  /** 逗号分隔多值（最多 9）。 */
  category?: string;
  severity?: ObservabilitySeverity;
  upstreamId?: string;
  keyId?: string;
  model?: string;
  requestId?: string;
}

export interface AssistantChatRequest {
  /** 至少 1 条；空/缺失 → 400 INVALID_PARAM。 */
  messages: AssistantMessage[];
  logContext?: AssistantLogContext;
}

/** §13.2 citation：服务端派生的注入事件引用（不是从模型输出解析 id）。 */
export interface AssistantCitation {
  id: string;
  ts: Iso8601;
  /** 事件可能没有码值（如 499 客户端断开）→ `null`。 */
  gatewayCode: string | null;
  category: string;
  severity: ObservabilitySeverity;
  /** 未过鉴权的请求恒为 `null`（§12.1 产出边界）。 */
  model: string | null;
  /** 已脱敏 `message` 再截 120 字符 —— 可直接渲染的最小可读标签。 */
  summary: string;
}

/**
 * §13.2 SSE 帧（**恰好一个终止帧**）。
 * `seq` 单请求内从 1 起单调递增；「重试」= 新请求 = 从 1 重来。
 */
export type AssistantFrame =
  | { kind: 'delta'; seq: number; text: string }
  | { kind: 'done'; seq: number; truncated: boolean; citations: AssistantCitation[] }
  | {
      kind: 'error';
      seq: number;
      /** §10 网关码值，零新增枚举。 */
      code: string;
      message: string;
      /** §10 表里该码值的 HTTP 状态，**不是**本次 SSE 响应状态（流已开恒 200）。 */
      status: number;
      /** 仅 429 两类带；其它为 `null`。 */
      retryAfterSec: number | null;
    };

// ── §15 供应商账号面（TierFlow） ───────────────────────────────────────────
//
// **消费锚（§15.12，三个字段级事实，判据唯一）**
// 1. 「这个上游有没有账号面」的唯一判据是 `Upstream.supplier === 'tierflow'`。
//    **不 parse `baseUrl`、不查域名、不猜** —— 猜错的后果是静默走错驱动器。
// 2. 批量任务的逐行结论**只读 `result.items`**，且只在**终态**读（`succeeded` / `failed`）。
//    它最多 500 行，`itemsTotal` 是截断前的真实行数、`truncated` 说明明细被截。
//    本期**没有**分页，前端不得自己造一个"下一页"。
// 3. `SupplierAccount` DTO 是**穷尽**的：**不存在** `egressId` 或任何出口字段。
//    出口的读面只有 §7 的 `egress_*` 帧，而本期那两帧**不发射** ⇒ 出口池在管理面上**无数据可读**。
//
// **凭据纪律**：本文件里所有 `identifier` / `keyMasked` 都是**掩码**；
// 唯一进入系统的明文密码走 `POST /api/supplier-accounts/import` 的请求体，且**只进不出**。

/** §15.1 `credentialSource`：回答「会话过期后能不能自动重登」。与 `hasSession` **正交**。 */
export type SupplierCredentialSource = 'password' | 'session';

/** §15.1 账号状态。`unknown` = **从未成功查询过**，不是"正常"的同义词。 */
export type SupplierAccountStatus = 'active' | 'login_failed' | 'session_expired' | 'unknown';

/**
 * §15.1 `SupplierAccount`。列表项与详情**共用同一形状**。
 *
 * 金额一律 int **分**；上游给的是 quota 或**浮点元**，换算**全在后端**，前端不做任何除法。
 */
export interface SupplierAccount {
  id: string;
  upstreamId: string;
  supplier: string;
  /** **掩码**手机号 / 邮箱。真值不出后端，前端也不得试图还原。 */
  identifier: string;
  username: string | null;
  uid: string | null;
  status: SupplierAccountStatus;
  /** 面向人的一句话，只放供应商错误码或通用原因，**不含凭据**。 */
  statusMessage: string | null;
  /** 分；`null` = 未知 ≠ 0。 */
  balanceCents: Cents | null;
  /** 最近一次**真的查到**余额的时刻。查失败**不动它** —— 否则会渲染成"刚查过"，而事实是没查到。 */
  balanceUpdatedAt: Iso8601 | null;
  /** 归属本账号、**已入池**的 key 数。 */
  keyCount: number;
  /** `keyCount` 中 `unlimited=1` 的**子集**（不额外相加）。 */
  unlimitedKeyCount: number;
  /** 只拿到掩码、**进不了池**的 key 数（对账用）。**不得与 `keyCount` 相加成"key 总数"**。 */
  maskedKeyCount: number;
  /** **恒为数组**：上游给的是 `all_subscriptions: []`，单数对象表达不了"没有套餐"。 */
  subscriptions: SupplierSubscription[];
  /** 「能不能自动重登」由它回答。**不得**用 `hasSession` 反推。 */
  credentialSource: SupplierCredentialSource;
  /** 只回答**有无**，会话值永不出后端。 */
  hasSession: boolean;
  sessionExpiresAt: Iso8601 | null;
  revision: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

/** §15.1 套餐摘要。**挂账号、不建成 key**（ADR-0018 决策 7）。 */
export interface SupplierSubscription {
  subNo: string;
  planTitle: string | null;
  planSlug: string | null;
  amountTotalCents: Cents | null;
  amountUsedCents: Cents | null;
  paidCents: Cents | null;
  basicTokenTotal: number | null;
  basicTokenUsed: number | null;
  status: string | null;
  source: string | null;
  startAt: Iso8601 | null;
  endAt: Iso8601 | null;
  /**
   * **三态**：`true` / `false` 是上游明确给了；`null` = 上游**根本没这个字段**。
   * 合并成两态等于把"供应商没告诉我们"当成"不会自动续费" —— 替对方下了结论。
   */
  autoRenew: boolean | null;
  hasKey: boolean;
  /** 套餐 key **只有掩码、永不进池**。 */
  keyMasked: string | null;
  updatedAt: Iso8601;
}

/**
 * §15.2 `GET /api/supplier-accounts/subscriptions` 的一行 = 套餐摘要 **加上"它是谁的"**。
 *
 * 归属字段**只放掩码**：扁平列表不知道自己属于谁，而不给归属的列表在读的人眼里
 * 是一串没有主语的编号，对账时第一句话就是"这是哪个号的"。
 */
export interface SupplierSubscriptionRow extends SupplierSubscription {
  accountId: string;
  /** **掩码**。与 §15.1 同一条纪律。 */
  accountIdentifier: string;
  upstreamId: string;
}

export interface SupplierAccountListQuery extends PageQuery {
  upstreamId?: string;
  status?: SupplierAccountStatus;
  q?: string;
}

/** §15.2 `POST /api/supplier-accounts/import`。**本端点只收密码型凭据**；会话型不走 HTTP（§15.9）。 */
export interface SupplierImportRequest {
  upstreamId: string;
  /** 「手机号,密码」行文本。逐行校验在服务层 —— 它要按行给「第 3 行缺密码」这种原因。 */
  text?: string;
}

/** 四个批量端点共用的「打谁」参数。`ids` 省略 = 该上游全部账号。 */
export interface SupplierBatchRequest {
  upstreamId: string;
  ids?: string[];
}

/** §15.2 `POST /api/supplier-accounts/keys`：批量新建 key 并入池（**本节的目的是这个**）。 */
export interface SupplierKeysRequest extends SupplierBatchRequest {
  /** 1..10，越界**在本次 HTTP 里就 400**（不变成一个立刻失败的异步任务）。 */
  count?: number;
  namePrefix?: string;
  unlimited?: boolean;
  quotaCents?: Cents | null;
  /** 空数组与省略同义，两者都归一化为 `NULL` = 不限模型。 */
  models?: string[] | null;
  label?: string | null;
}

/** §15.3 `action` 五值，每个都必须有生产者（不留"枚举里有、没人发"的空值）。 */
export type SupplierBatchAction = 'login' | 'relogin' | 'refresh' | 'create' | 'sync';

/** 逐行结果的一行。**不含任何凭据** —— `keyMasked` 是掩码，`keyId`/`tokenNo` 是内部标识。 */
export interface SupplierBatchItem {
  accountId: string | null;
  /** **掩码**；这一行没能解析出账号时为 `null`。 */
  identifier: string | null;
  action: SupplierBatchAction | null;
  ok: boolean;
  /** 供应商错误码原样（如 `LOGIN_INVALID_CREDENTIALS`）或本契约错误码。 */
  code: string | null;
  message: string | null;
  keyId: string | null;
  keyMasked: string | null;
  tokenNo: number | null;
}

/**
 * §15.3 批量任务 result（四个批量端点共用形状）。
 *
 * 不变量：`ok + failed + skipped = total`。
 */
export interface SupplierBatchResult {
  done: number;
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  /** `items` 截断前的**真实行数**。 */
  itemsTotal: number;
  /** `items` 超过 500 行时为 `true` —— UI **必须**说出"逐行明细已截断"。 */
  truncated: boolean;
  items: SupplierBatchItem[];
  hintCode: HintCode | null;
  hint: string | null;
}

/**
 * §15.2 `SupplierTestResult`（连接自测）。与 §2 `BalanceTestResult` 同口径三条：
 * **永不写库**、业务性失败一律 `200 + ok:false`、`raw` 是上游原样而 `parsed` 才是结论。
 */
export interface SupplierTestResult {
  ok: boolean;
  accountId: string;
  /** **掩码**。 */
  identifier: string;
  /** 未能发出请求时为 `0`（`null` 会让人以为是"没记录"，事实是"没发生"）。 */
  httpStatus: number;
  durationMs: number;
  /** 本次是否为验证密码而**真实登录过** —— 让"这次测得慢"可解释。 */
  loginAttempted: boolean;
  /** **换算后**的结论：`balanceCents` 是分，取不到就是 `null`。 */
  parsed: SupplierTestParsed;
  /** 上游原样，已抹掉所有凭据出现并截断。**禁止读这里的数字当金额渲染**。 */
  raw: unknown;
  errorCode: string | null;
  hintCode: HintCode | null;
  hint: string | null;
}

export interface SupplierTestParsed {
  balanceCents: Cents | null;
  /** 换算比（**比例，非金额**）。保留是为了诊断"换算比是不是被供应商改了"。 */
  quotaPerUnit: number | null;
  subscriptionCount: number | null;
}

/** 状态 → 人话。`unknown` 那一格刻意不写"正常"。 */
export const SUPPLIER_STATUS_TEXT: Record<SupplierAccountStatus, string> = {
  active: '正常',
  login_failed: '登录失败',
  session_expired: '会话过期',
  unknown: '未查询过',
};
