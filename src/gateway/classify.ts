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

// 出口级（IP 级）429 的识别缝（`EgressLimitInput` / `EgressLimitDetector` / `neverEgressLimited` /
// `egressLimitedOnSecondKey`）**已退休**（ADR-0021 影响表 + 决策 10(5)）：归因判据转正进闸内
//（`src/gateway/egress.ts` 的 `observeLimited`），且只此一处 —— 旁路第二个计数器会让一个
// 被打空预算的出口拿**自己拒出来的** N 张脸判成「被上游限」再冷掉自己。本文件自此只负责
// 「状态码 → key 级失败」这一件事。
//
// 同批删掉三个**全仓零调用**的导出（2026-10-16 清死代码）：`isAbortError` / `isTimeoutError` /
// `classifyNetworkError`。它们与上面那条退休同源 —— 那套"网络异常 → NETWORK 冷却"的分派
// 转正进了引擎（`src/gateway/engine.ts` 直接按 `FailureReason` 记账），这里只剩状态码映射。
// 留着的风险不是"占地方"，是**下一个人会以为它是活的**：一个导出了却没被调用的分类函数，
// 看起来像"网关是这样把 ECONNRESET 归成 NETWORK 的"，于是照着它改判据 —— 而真的判据在别处。
// 需要它们回来时，从 `engine.ts` 的调用点反推即可（git 历史里有逐字原文）。

