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
