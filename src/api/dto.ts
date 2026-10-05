// 管理面响应 DTO —— 与 docs/api-contract.md（v1.0-frozen）逐字段对齐。
//
// 这些接口是**契约的代码化身**：改这里就是改契约，必须同时改 docs/api-contract.md 并补 ADR。
// 所以每个对象上方都标了契约小节号，方便 review 时逐条比对。
//
// 布尔一律 true/false（不是 0/1），可空一律 `| null`（不是 undefined）——
// JSON 里不出现 undefined 键，前端拿到的字段集合是稳定的。

import type { BalanceQueryTemplate } from '../db/balance-query.js';

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
