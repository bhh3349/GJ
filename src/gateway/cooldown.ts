/**
 * 网关内核 - 失败冷却映射
 * 冻结依据：docs/dev-constraints.md §四（冷却映射表 + 默认参数表）
 *
 * 语义（M1 前置实现，已按 §四 逐条对齐）：
 *   cooldownMs(n) = min( max(reasonBase(n), ladder(n)), MAX_COOLDOWN_MS )
 *     n = 该 key 当前连续失败次数（成功后归零）
 *   - 首次失败（n=1）用该 reason 的基础冷却：NETWORK 15s / UPSTREAM_ERROR 10s /
 *     RATE_LIMITED = Retry-After 或 60s / AUTH_INVALID 与 INSUFFICIENT_BALANCE 30min。
 *   - 连续再失败时走上半开探测阶梯 1m → 5m → 15m → 30m 封顶。
 *   - AUTH_INVALID / INSUFFICIENT_BALANCE 因 base 已是封顶值，恒为 30min（长冷却）。
 */

import type { FailureReason } from './types.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;

/** 冷却封顶：30min */
export const MAX_COOLDOWN_MS = 30 * MINUTE;

/** 半开探测阶梯：下标 = 连续失败次数 - 1 */
const LADDER_MS: readonly number[] = [0, MINUTE, 5 * MINUTE, 15 * MINUTE, MAX_COOLDOWN_MS];

/**
 * 默认阶梯（冻结常量）。
 *
 * 可经 `PoolOptions.cooldownLadderMs`（env `COOLDOWN_LADDER_SECONDS`）整条替换，
 * 但**封顶不变**：结果仍受 `MAX_COOLDOWN_MS` 与各 reason 的基础冷却约束，
 * 所以换阶梯只影响"连续失败后的升档速度"，不会把 AUTH_INVALID 的 30min 长冷却改短。
 */
export const DEFAULT_COOLDOWN_LADDER_MS: readonly number[] = LADDER_MS;

/** 未给 Retry-After 时 429 的默认冷却 */
export const RATE_LIMITED_DEFAULT_MS = 60 * SECOND;

/** 5xx 短冷却基准（区间 10–30s，取区间下沿，随后按阶梯升档） */
export const UPSTREAM_ERROR_BASE_MS = 10 * SECOND;

/** 连接/读取超时、ECONNRESET 短冷却 */
export const NETWORK_BASE_MS = 15 * SECOND;

/** 长冷却（401/403、402 余额不足） */
export const LONG_COOLDOWN_MS = 30 * MINUTE;

/** 该 reason 的基础冷却；exponential 语义由阶梯承担（RATE_LIMITED 尊重上游 Retry-After） */
export function reasonBaseCooldownMs(reason: FailureReason, retryAfterMs?: number): number {
  switch (reason) {
    case 'AUTH_INVALID':
    case 'INSUFFICIENT_BALANCE':
      return LONG_COOLDOWN_MS;
    case 'RATE_LIMITED':
      return retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.max(retryAfterMs, RATE_LIMITED_DEFAULT_MS)
        : RATE_LIMITED_DEFAULT_MS;
    case 'UPSTREAM_ERROR':
      return UPSTREAM_ERROR_BASE_MS;
    case 'NETWORK':
      return NETWORK_BASE_MS;
  }
}

/** 半开探测阶梯值；n<1 视为首次。超出阶梯长度取最后一档（封顶档） */
export function ladderCooldownMs(consecutiveFails: number, ladderMs: readonly number[] = LADDER_MS): number {
  const idx = Math.max(0, Math.min(consecutiveFails - 1, ladderMs.length - 1));
  return ladderMs[idx] ?? MAX_COOLDOWN_MS;
}

/** 计算本次应进入的冷却时长（ms），结果恒落在 [0, MAX_COOLDOWN_MS] */
export function nextCooldownMs(input: {
  reason: FailureReason;
  consecutiveFails: number;
  retryAfterMs?: number;
  maxCooldownMs?: number;
  /** 覆盖阶梯；缺省用冻结常量。见 `DEFAULT_COOLDOWN_LADDER_MS` 的封顶说明 */
  ladderMs?: readonly number[];
}): number {
  const cap = input.maxCooldownMs ?? MAX_COOLDOWN_MS;
  const base = reasonBaseCooldownMs(input.reason, input.retryAfterMs);
  const ladder = ladderCooldownMs(input.consecutiveFails, input.ladderMs);
  return Math.min(Math.max(base, ladder), cap);
}
