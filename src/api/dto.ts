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
  keyCount: number;
  enabledKeyCount: number;
  /** 分；全部未知时 null */
  totalBalance: number | null;
  balanceUnknownKeyCount: number;
  tokenPlanKeyCount: number;
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
