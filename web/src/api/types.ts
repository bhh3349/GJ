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
  | 'BALANCE_AUTH_REJECTED';

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

/** 余额刷新任务的 `result`：原计数 + 失败引导两字段（非破坏新增，计数语义不变）。 */
export interface BalanceRefreshResult {
  checked: number;
  ok: number;
  failed: number;
  unknown: number;
  skipped: number;
  hintCode: HintCode | null;
  hint: string | null;
}

export interface Upstream {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  keyCount: number;
  enabledKeyCount: number;
  /** 本上游 balance 类 key 合计（分）。全部未知时是 `null`，不是 0。 */
  totalBalance: Cents | null;
  /** 余额未知的 key 数。**未知 ≠ 0**，UI 必须单独呈现。 */
  balanceUnknownKeyCount: number;
  /** token-plan 类 key 数。这类**不进** totalBalance。 */
  tokenPlanKeyCount: number;
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

export interface UpstreamCreateRequest {
  name: string;
  baseUrl: string;
  enabled?: boolean;
  balanceQuery?: BalanceQueryTemplate;
}

/** PATCH 只发变更子集 + `revision`（乐观锁）。 */
export interface UpstreamPatchRequest {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
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
  /** 非空 = 已软删（C4 级联软删）。 */
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

export type TaskType = 'model_sync' | 'balance_refresh';

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

export type LiveMessage =
  | LiveReadyMessage
  | LiveMetricsMessage
  | LiveKeyHealthMessage
  | LiveBalanceMessage
  | LiveTaskMessage
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
