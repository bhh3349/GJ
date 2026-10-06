/**
 * 网关内核 - 出口级（IP 级）冷却
 * 冻结依据：docs/api-contract.md §16.7 / docs/adr/0020-egress-ip-rate-limit.md
 *
 * 与 key 级冷却**正交**：key 级状态在 KeyPool（`reportFailure(keyId, …)`），
 * 这里只管「出口」——本期出口 = 上游 host（`UpstreamTarget.baseUrl` 的 host）。
 *
 * 为什么必须单开一层（§16.7）：上游按**来源 IP** 计数，同出口下的 key 共命运 ——
 * 换 key 不改变出口，也就换不掉被限流的对象。把出口级 429 记到当时正打的那把 key 头上，
 * 再由轮换把候选逐把冷光（最长 30min），正是这条故障被自己放大成全池不可用的形状。
 * 所以正确的动作是「**不换 key**」，而不是「换一把再试」。
 *
 * 职责边界：本文件只做「记住某出口冷到什么时候」，**不判断什么算出口级 429** ——
 * 识别规则在 classify.ts 的 `EgressLimitDetector`（ADR-0020 决策 4：悬空件）。
 */

import { MAX_COOLDOWN_MS, nextCooldownMs } from './cooldown.js';

/** 出口级冷却封顶，与 key 级同值（§16.7「封顶 30min」） */
export const EGRESS_MAX_COOLDOWN_MS = MAX_COOLDOWN_MS;

/**
 * 取出口标识：上游 host（含端口，小写）。
 * `baseUrl` 解析不出 host（空串/相对地址/垃圾串）→ `null`，该次不参与出口级冷却
 * —— 宁可退回旧的 key 级处置，也不拿一个假出口去冷掉别的上游。
 */
export function egressHostOf(baseUrl: string): string | null {
  try {
    const host = new URL(baseUrl).host;
    return host === '' ? null : host.toLowerCase();
  } catch {
    return null;
  }
}

/** 剩余冷却毫秒 → 写进 `Retry-After` 的秒数（向上取整，至少 1s） */
export function retryAfterSecOf(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

interface EgressState {
  /** 连续命中次数（成功一次即归零），驱动与 key 级同一条升档阶梯 */
  consecutive: number;
  /** 冷却结束时刻（epoch ms）；0 = 未冷却 */
  until: number;
}

export interface EgressCooldown {
  /** 该出口当前是否在冷却期内（只读，不产生状态） */
  isCooling(host: string): boolean;
  /** 剩余冷却毫秒；不在冷却期 → 0（只读，不产生状态） */
  remainingMs(host: string): number;
  /**
   * 落一次出口级冷却。`retryAfterMs` 来自上游 `Retry-After`（§16.7：尊重它）。
   * 未给则 60s 起，连续命中按阶梯升档，30min 封顶；**已有更长的冷却不被缩短**。
   * @returns 本次冷却结束的 epoch ms
   */
  cool(host: string, retryAfterMs?: number): number;
  /**
   * 该出口一次成功（上游真的答了）→ 清**连续计数**、退出升档阶梯。
   *
   * 刻意**不清 `until`**：并发的在途请求成功，不该提前解开整出口的冷却 ——
   * 冷却的意义正是「这段时间内别再打这个 IP」。清计数让下次失败重新从 60s 起，
   * 而不是接着上一轮的档位往上爬。
   */
  noteSuccess(host: string): void;
  /** 清空全部出口状态（测试用；快照重建时不需要，出口状态与 key 生命周期无关） */
  clear(): void;
}

export interface EgressCooldownOptions {
  /** 注入时钟，便于单测；默认 Date.now */
  now?: () => number;
  /** 冷却封顶，默认 30min */
  maxCooldownMs?: number;
  /** 升档阶梯，缺省用冻结常量；语义同 `PoolOptions.cooldownLadderMs` */
  ladderMs?: readonly number[];
}

/**
 * 出口级冷却表。**跨请求共享**（由 stack 装配进引擎）——
 * 每个请求各建一份等于没建：出口被限流是全体请求共同的事实。
 */
export function createEgressCooldown(options: EgressCooldownOptions = {}): EgressCooldown {
  const now = options.now ?? Date.now;
  const maxCooldownMs = options.maxCooldownMs;
  const ladderMs = options.ladderMs;
  const state = new Map<string, EgressState>();

  function entryOf(host: string): EgressState {
    let s = state.get(host);
    if (s === undefined) {
      s = { consecutive: 0, until: 0 };
      state.set(host, s);
    }
    return s;
  }

  return {
    isCooling(host: string): boolean {
      const s = state.get(host);
      return s !== undefined && s.until > now();
    },

    remainingMs(host: string): number {
      const s = state.get(host);
      return s === undefined ? 0 : Math.max(0, s.until - now());
    },

    cool(host: string, retryAfterMs?: number): number {
      const s = entryOf(host);
      const t = now();
      s.consecutive += 1;
      const ms = nextCooldownMs({
        reason: 'RATE_LIMITED',
        consecutiveFails: s.consecutive,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(maxCooldownMs === undefined ? {} : { maxCooldownMs }),
        ...(ladderMs === undefined ? {} : { ladderMs }),
      });
      // 已有更长的冷却不被缩短：并发的两个请求各自落一次冷却时，取更远的那次
      s.until = Math.max(s.until, t + ms);
      return s.until;
    },

    noteSuccess(host: string): void {
      const s = state.get(host);
      if (s === undefined) return;
      s.consecutive = 0; // 只清计数：`until` 不动，见接口注释
    },

    clear(): void {
      state.clear();
    },
  };
}
