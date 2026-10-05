/**
 * 网关内核 - 上游失败分类
 * 冻结依据：docs/api-contract.md §10「失败枚举（计入 key 失败，仅这五类）」
 *
 * 铁律：只有这五类计入 key 失败并触发换 key / 冷却：
 *   AUTH_INVALID(401/403) / RATE_LIMITED(429) / INSUFFICIENT_BALANCE(402) /
 *   UPSTREAM_ERROR(5xx) / NETWORK(连接、读取超时、ECONNRESET)
 * 400/404/422 是「客户端自己的错」，原样透传、**不换 key、不计失败** ——
 * 否则一个写错参数的调用方能把整池 key 全打进冷却。
 */

import type { FailureReason } from './types.js';

/** 上游 HTTP 状态码 → 失败原因；null = 不计失败（客户端错） */
export function classifyUpstreamStatus(status: number): FailureReason | null {
  if (status === 401 || status === 403) return 'AUTH_INVALID';
  if (status === 402) return 'INSUFFICIENT_BALANCE';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return null;
}

/**
 * 解析 Retry-After（秒数或 HTTP-date）→ 毫秒。
 * 无法解析 / 为过去时间 → undefined（由 cooldown.ts 落回默认 60s）。
 */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  const raw = header.trim();
  if (raw === '') return undefined;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds * 1000 : undefined;
  }

  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  const delta = at - nowMs;
  return delta > 0 ? delta : undefined;
}

/** 取 AbortSignal 超时导致的中止（与「客户端主动断开」区分开） */
export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

export function isTimeoutError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError';
}

/**
 * 网络层异常 → NETWORK（超时、ECONNRESET、DNS 失败一律同一档冷却）。
 * 注意：调用方必须先判「客户端主动断开」——那种情况不计失败、也不换 key。
 */
export function classifyNetworkError(_err: unknown): FailureReason {
  return 'NETWORK';
}
