/**
 * 网关内核 - KeyPool 纯逻辑实现
 * 冻结依据：docs/dev-constraints.md §三（签名冻结）/ §四（失败分类与冷却）/ §五（单写者、热路径零 DB）
 *
 * 冻死不变的部分：
 *   getAvailableKeys(model) / reportFailure(keyId, reason) / reportSuccess(keyId, tokens, latencyMs)
 *   - getAvailableKeys 只读进程内快照，零 DB 往返，Promise 签名保留（调用方一律 await）
 *   - 只返回候选列表，不做内部重试；返回顺序即优先级（重试/换 key 是引擎职责）
 *   - 单写者：cooldown / fail_count 只有本模块写；管理端只读 + 手动启停
 *
 * 非冻结的内部面（仅供网关引擎使用，不属于对外 KeyPool 契约）：
 *   applySnapshot / beginAttempt / endAttempt / view / stats
 */

import { nextCooldownMs } from './cooldown.js';
import type {
  FailureReason,
  KeyCandidate,
  KeyConfig,
  KeyRuntimeState,
  PoolOptions,
  PoolSnapshot,
  ReportFailureOptions,
  TokenUsage,
} from './types.js';

/** 对外冻结接口（PM 冻结件，变更需走契约流程） */
export interface KeyPool {
  getAvailableKeys(model: string): Promise<KeyCandidate[]>;
  reportFailure(keyId: string, reason: FailureReason, opts?: ReportFailureOptions): void;
  reportSuccess(keyId: string, tokens: TokenUsage, latencyMs: number): void;
}

/** 网关引擎侧扩展面（非契约，工程内部使用） */
export interface KeyPoolInternal extends KeyPool {
  /** 用新快照替换内存配置（change_log 事件 / 1s 轮询兜底）；保留仍在快照内的 key 的运行态 */
  applySnapshot(snapshot: PoolSnapshot): void;
  /** 占一个并发位；返回 false = 该 key 已满，调用方应重新选路 */
  beginAttempt(keyId: string): boolean;
  /** 释放并发位（成功/失败/客户端断开都必须在 finally 里调用） */
  endAttempt(keyId: string): void;
  /** 供 GET /internal/snapshot 与管理端只读健康展示 */
  view(): KeyRuntimeState[];
  /** 你能否被 401 连续失败自动禁用告警，由上层接入（可选） */
  onAlert?(event: PoolAlert): void;
}

export interface PoolAlert {
  type: 'AUTH_INVALID_AUTO_DISABLED';
  keyId: string;
  consecutiveFails: number;
  at: number;
}

interface RuntimeExtras {
  autoDisabled: boolean;
  /** token-plan：本次快照刷新后已消耗的 tokens（乐观扣减，结算由管家侧落库） */
  spentTokens: number;
}

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_AUTO_DISABLE_AFTER = 5;

function emptyRuntime(keyId: string): KeyRuntimeState & RuntimeExtras {
  return {
    keyId,
    failCount: 0,
    consecutiveFails: 0,
    cooldownUntil: null,
    lastFailureAt: null,
    lastFailureReason: null,
    lastLatencyMs: null,
    inflight: 0,
    autoDisabled: false,
    spentTokens: 0,
  };
}

function matchesModel(supported: readonly string[] | null, model: string): boolean {
  // null / 空数组 = 不限制
  if (supported === null || supported.length === 0) return true;
  return supported.includes('*') || supported.includes(model);
}

function keyModels(key: KeyConfig, upstreamModels: readonly string[] | null): readonly string[] | null {
  // 显式关联优先；留空即按 upstream 继承（v1.1 §四）
  return key.models === null || key.models.length === 0 ? upstreamModels : key.models;
}

function remainingQuotaOf(key: KeyConfig, rt: RuntimeExtras): number {
  if (key.category === 'token-plan') {
    if (key.tokenPlanRemainingTokens === null) return -1; // 未知 → 排序时靠后，但不排除
    return Math.max(0, key.tokenPlanRemainingTokens - rt.spentTokens);
  }
  return key.balanceCents === null ? -1 : key.balanceCents;
}

function isUsable(key: KeyConfig, rt: KeyRuntimeState & RuntimeExtras, now: number, fallbackMaxConcurrency: number): boolean {
  if (key.status !== 'enabled') return false;
  if (rt.autoDisabled) return false;
  if (rt.cooldownUntil !== null && rt.cooldownUntil > now) return false;
  if (rt.inflight >= (key.maxConcurrency ?? fallbackMaxConcurrency)) return false; // 满并发不算失败、不进冷却

  if (key.category === 'balance') {
    // 未知 ≠ 0：null 仍可用；<=0 不可用
    return key.balanceCents === null || key.balanceCents > 0;
  }
  // token-plan：按套餐余量 / 到期时间判定，不参与「余额>0」过滤
  if (key.tokenPlanExpiresAt !== null) {
    const exp = Date.parse(key.tokenPlanExpiresAt);
    if (Number.isFinite(exp) && exp <= now) return false;
  }
  return remainingQuotaOf(key, rt) !== 0;
}

export function createKeyPool(options: PoolOptions = {}): KeyPoolInternal {
  const now = options.now ?? Date.now;
  const maxCooldownMs = options.maxCooldownMs;
  const autoDisableAfter = options.autoDisableAfterConsecutiveFails ?? DEFAULT_AUTO_DISABLE_AFTER;
  const defaultMaxConcurrency = options.defaultMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const usageSink = options.usageSink;

  let snapshot: PoolSnapshot = { revision: 0, upstreams: [], keys: [] };
  const runtime = new Map<string, KeyRuntimeState & RuntimeExtras>();
  const pool: KeyPoolInternal = {
    applySnapshot(next: PoolSnapshot): void {
      snapshot = next;
      const live = new Set(next.keys.map((k) => k.keyId));
      for (const keyId of [...runtime.keys()]) {
        if (!live.has(keyId)) runtime.delete(keyId); // 被删除的 key 清掉运行态
      }
      for (const k of next.keys) {
        const existing = runtime.get(k.keyId);
        if (existing) {
          existing.spentTokens = 0; // 新快照的 balance/quota 已含历史消耗
        } else {
          runtime.set(k.keyId, emptyRuntime(k.keyId));
        }
      }
    },

    async getAvailableKeys(model: string): Promise<KeyCandidate[]> {
      const t = now();
      const upstreamById = new Map(snapshot.upstreams.map((u) => [u.upstreamId, u]));
      const ready: KeyCandidate[] = [];

      for (const key of snapshot.keys) {
        const upstream = upstreamById.get(key.upstreamId);
        if (upstream === undefined || !upstream.enabled) continue; // 上游级熔断/停用
        const rt = runtime.get(key.keyId) ?? emptyRuntime(key.keyId);
        if (!runtime.has(key.keyId)) runtime.set(key.keyId, rt);
        if (!isUsable(key, rt, t, defaultMaxConcurrency)) continue;
        if (!matchesModel(keyModels(key, upstream.models), model)) continue;
        ready.push({ keyId: key.keyId, upstreamId: key.upstreamId, category: key.category, weight: key.weight });
      }

      const order = new Map(snapshot.keys.map((k, i) => [k.keyId, i]));
      ready.sort((a, b) => {
        if (b.weight !== a.weight) return b.weight - a.weight; // 1. 权重降序
        const ra = remainingQuotaOf(configOf(a), runtimeOf(a));
        const rb = remainingQuotaOf(configOf(b), runtimeOf(b));
        if (rb !== ra) return rb - ra; // 2. 剩余额度降序（未知 = -1 靠后）
        const la = runtimeOf(a).lastFailureAt ?? -1;
        const lb = runtimeOf(b).lastFailureAt ?? -1;
        if (la !== lb) return la - lb; // 3. 上次失败时间升序（从未失败优先）
        return (order.get(a.keyId) ?? 0) - (order.get(b.keyId) ?? 0); // 稳定兜底
      });
      return ready;

      function configOf(c: KeyCandidate): KeyConfig {
        const k = snapshot.keys.find((x) => x.keyId === c.keyId);
        if (k === undefined) throw new Error(`key not found in snapshot: ${c.keyId}`);
        return k;
      }
      function runtimeOf(c: KeyCandidate): KeyRuntimeState & RuntimeExtras {
        const rt = runtime.get(c.keyId);
        if (rt === undefined) throw new Error(`runtime not found: ${c.keyId}`);
        return rt;
      }
    },

    reportFailure(keyId: string, reason: FailureReason, opts?: ReportFailureOptions): void {
      const rt = runtime.get(keyId) ?? emptyRuntime(keyId);
      runtime.set(keyId, rt);
      const t = now();
      rt.failCount += 1;
      rt.consecutiveFails += 1;
      rt.lastFailureAt = t;
      rt.lastFailureReason = reason;
      rt.cooldownUntil = t + nextCooldownMs({ reason, consecutiveFails: rt.consecutiveFails, retryAfterMs: opts?.retryAfterMs, maxCooldownMs });

      // v1.1 §四.2：401/403 连续 N 次 → 自动禁用 + 告警（长冷却已在 cooldown.ts 保证）
      if (reason === 'AUTH_INVALID' && !rt.autoDisabled && rt.consecutiveFails >= autoDisableAfter) {
        rt.autoDisabled = true;
        pool.onAlert?.({ type: 'AUTH_INVALID_AUTO_DISABLED', keyId, consecutiveFails: rt.consecutiveFails, at: t });
      }
    },

    reportSuccess(keyId: string, tokens: TokenUsage, latencyMs: number): void {
      const rt = runtime.get(keyId) ?? emptyRuntime(keyId);
      runtime.set(keyId, rt);
      rt.consecutiveFails = 0; // 清失败计数、退出冷却半开
      rt.cooldownUntil = null;
      rt.lastLatencyMs = latencyMs;
      const key = snapshot.keys.find((k) => k.keyId === keyId);
      if (key?.category === 'token-plan') rt.spentTokens += tokens.total; // 乐观扣减，落库由管家侧异步结算
      usageSink?.(keyId, tokens, latencyMs);
    },

    beginAttempt(keyId: string): boolean {
      const rt = runtime.get(keyId);
      if (rt === undefined) return false;
      const key = snapshot.keys.find((k) => k.keyId === keyId);
      const cap = key?.maxConcurrency ?? defaultMaxConcurrency;
      if (rt.inflight >= cap) return false;
      rt.inflight += 1;
      return true;
    },

    endAttempt(keyId: string): void {
      const rt = runtime.get(keyId);
      if (rt !== undefined && rt.inflight > 0) rt.inflight -= 1;
    },

    view(): KeyRuntimeState[] {
      return [...runtime.values()].map((r) => ({
        keyId: r.keyId,
        failCount: r.failCount,
        consecutiveFails: r.consecutiveFails,
        cooldownUntil: r.cooldownUntil,
        lastFailureAt: r.lastFailureAt,
        lastFailureReason: r.lastFailureReason,
        lastLatencyMs: r.lastLatencyMs,
        inflight: r.inflight,
      }));
    },
  };

  return pool;
}
