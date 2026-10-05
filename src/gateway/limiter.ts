/**
 * 网关内核 - 用户组限流（RPM / TPM / 日配额）
 * 冻结依据：docs/api-contract.md §4（rpm / tpm / dailyQuota，null = 不限）
 *
 * 口径：
 *   - RPM / TPM：60s 滑动窗口（用 1s 分桶近似，误差 ≤ 1s，内存 O(窗口秒数)）
 *   - 日配额：按 UTC 自然日累计 token，跨日自动归零
 *   - 超限返回 429：RPM/TPM → RATE_LIMITED，日配额 → QUOTA_EXCEEDED（type=insufficient_quota）
 *   - token 记账在**请求结束后**回填（非流式=响应返回后，流式=流结束），
 *     所以 TPM 是「事后窗口」而非预扣；预扣会让流式请求的 TTFB 后置，得不偿失
 *
 * 单进程内存态。多进程/多实例部署时要换成共享存储 —— 这里显式留 TODO，
 * 不要因为「现在只有单进程」就把这个假设埋进代码。
 */

import type { GroupContext } from './ports.js';

const SECOND_MS = 1000;
const WINDOW_SECONDS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LimitRejection = 'RATE_LIMITED' | 'QUOTA_EXCEEDED';

export interface LimitCheckResult {
  ok: boolean;
  reason?: LimitRejection;
  /** 建议客户端等待秒数（写进 Retry-After） */
  retryAfterSec?: number;
  /** 命中的限额描述，仅进日志 */
  detail?: string;
}

interface GroupWindow {
  /** 下标 = 秒偏移（0 = 当前秒），值为该秒内的请求数 / token 数 */
  rpm: number[];
  tpm: number[];
  /** UTC 日桶：YYYY-MM-DD */
  dayKey: string;
  dayTokens: number;
  /** 上一次推进窗口的秒（用于滑动清桶） */
  lastSecond: number;
}

export interface RateLimiterOptions {
  now?: () => number;
}

export interface RateLimiter {
  /** 请求入口检查（不记账）；不 ok 时应直接拒绝，不得调用上游 */
  check(group: GroupContext): LimitCheckResult;
  /** 请求结束后回填 token 用量（RPM 在 check 里已计） */
  commitTokens(groupId: string, tokens: number): void;
  /** 该组今日已用 token（与 DB 的 dailyQuotaUsed 对账用） */
  dayTokensOf(groupId: string): number;
  /** 测试/运维：清空某组窗口 */
  reset(groupId?: string): void;
}

function dayKeyOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function emptyWindow(t: number): GroupWindow {
  return {
    rpm: new Array<number>(WINDOW_SECONDS).fill(0),
    tpm: new Array<number>(WINDOW_SECONDS).fill(0),
    dayKey: dayKeyOf(t),
    dayTokens: 0,
    lastSecond: Math.floor(t / SECOND_MS),
  };
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const now = options.now ?? Date.now;
  const groups = new Map<string, GroupWindow>();

  function windowOf(groupId: string, t: number): GroupWindow {
    let w = groups.get(groupId);
    if (w === undefined) {
      w = emptyWindow(t);
      groups.set(groupId, w);
      return w;
    }
    const second = Math.floor(t / SECOND_MS);
    const delta = second - w.lastSecond;
    if (delta > 0) {
      if (delta >= WINDOW_SECONDS) {
        w.rpm.fill(0);
        w.tpm.fill(0);
      } else {
        // 逐秒清桶：把 [lastSecond+1, second] 这段对应的槽位清零
        for (let i = 1; i <= delta; i += 1) {
          const slot = (w.lastSecond + i) % WINDOW_SECONDS;
          w.rpm[slot] = 0;
          w.tpm[slot] = 0;
        }
      }
      w.lastSecond = second;
    }
    const key = dayKeyOf(t);
    if (w.dayKey !== key) {
      w.dayKey = key;
      w.dayTokens = 0;
    }
    return w;
  }

  function slotOf(t: number): number {
    return Math.floor(t / SECOND_MS) % WINDOW_SECONDS;
  }

  function sum(values: readonly number[]): number {
    let total = 0;
    for (const v of values) total += v;
    return total;
  }

  return {
    check(group: GroupContext): LimitCheckResult {
      if (!group.enabled) return { ok: false, reason: 'RATE_LIMITED', detail: 'group disabled' };

      const t = now();
      const w = windowOf(group.groupId, t);
      const slot = slotOf(t);

      if (group.rpm !== null) {
        const used = sum(w.rpm);
        if (used >= group.rpm) {
          return { ok: false, reason: 'RATE_LIMITED', retryAfterSec: 1, detail: `rpm ${used}/${group.rpm}` };
        }
      }
      if (group.tpm !== null) {
        const used = sum(w.tpm);
        if (used >= group.tpm) {
          return { ok: false, reason: 'RATE_LIMITED', retryAfterSec: 1, detail: `tpm ${used}/${group.tpm}` };
        }
      }
      if (group.dailyQuota !== null && w.dayTokens >= group.dailyQuota) {
        return {
          ok: false,
          reason: 'QUOTA_EXCEEDED',
          retryAfterSec: secondsUntilUtcMidnight(t),
          detail: `dailyQuota ${w.dayTokens}/${group.dailyQuota}`,
        };
      }

      // RPM 计数在通过检查的这一刻落桶（与 OpenAI 一致：请求到达即计数）
      w.rpm[slot] = (w.rpm[slot] ?? 0) + 1;
      return { ok: true };
    },

    commitTokens(groupId: string, tokens: number): void {
      if (tokens <= 0) return;
      const t = now();
      const w = windowOf(groupId, t);
      const slot = slotOf(t);
      w.tpm[slot] = (w.tpm[slot] ?? 0) + tokens;
      w.dayTokens += tokens;
    },

    dayTokensOf(groupId: string): number {
      const w = groups.get(groupId);
      if (w === undefined) return 0;
      return windowOf(groupId, now()).dayTokens;
    },

    reset(groupId?: string): void {
      if (groupId === undefined) groups.clear();
      else groups.delete(groupId);
    },
  };
}

function secondsUntilUtcMidnight(t: number): number {
  const next = Math.floor(t / DAY_MS) * DAY_MS + DAY_MS;
  return Math.max(1, Math.ceil((next - t) / SECOND_MS));
}
