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
 *
 * 排序口径的历史（`remainingQuotaOf` 的语义是这文件里唯一被改过的）：
 *   · 2026-10-06 ADR-0011：balance 退出键 2（返回常量 0），兜底位改 LRU。
 *   · 2026-10-16 ADR-0011 追认：套餐余量未知的哨兵从 `-1` 改 `1`，
 *     实现「套餐 key 一律排在余额 key 之前」（套餐 30 天有效期，不用即作废）。
 *     签名、过滤、冷却、单写者全部未动 —— 变的只有排序键 2 的一个常量。
 */

import { MAX_COOLDOWN_MS, nextCooldownMs } from './cooldown.js';
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
  /**
   * 最近一次「占到并发位、真的去敲上游」的**单调序号**，`0` = 从未使用。
   * 只在排序兜底位用（最久未用优先），**不进 `view()`、不落 key_runtime 镜像** ——
   * 它是选路的内部轮转游标，不是对外健康态（ADR-0011）。
   *
   * 为什么不是 `lastUsedAt` 墙钟：实测 60 次串行请求整轮跑在 ~1ms 内，
   * `Date.now()` 的毫秒分辨率会让多把 key 拿到**同一个** stamp → 比较器并列 →
   * 回落到快照序 → 快照第一把照样吃掉 63%~70% 的流量（正是本改动要消灭的饥饿）。
   * 序号与请求速率无关，任意吞吐下都是严格全序。见 ADR-0011「实现注记」。
   */
  lastUsedSeq: number;
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
    lastUsedSeq: 0,
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

/**
 * 「套餐余量未知」在排序键 2 上的取值（ADR-0011 追认，2026-10-16）。
 *
 * 旧值是 `-1`（排到 balance 的 0 之后）。改成 `1` 的理由是用户目标
 * **「先烧套餐 key，再烧余额 key」**（套餐只有 30 天有效期，不用就作废）：
 * 余量未知的套餐 key 也必须排在余额 key 前面，否则它会被饿死。
 *
 * 为什么恰好是 `1` 而不是任意正数：`1` 是**唯一**同时满足两条的值 ——
 *   · `> 0`：压过 balance 类的常量 0（余额 key 排在所有套餐 key 之后）；
 *   · `≤ 任何可用套餐 key 的真实余量`：`isUsable` 把余量 0 的套餐 key 已经排除，
 *     所以"可用"的已知余量最小就是 1 —— 未知值不会盖过任何一把真实有额的套餐 key。
 * 取更大的数（如 `Number.MAX_SAFE_INTEGER`）会让"刚 rotate 完、还没回填"的 key
 * 压过一把只剩 2 个 token 的套餐 key，那才叫真的本末倒置。
 *
 * `isUsable` 的 `remainingQuotaOf(...) !== 0` 判定因此**不受影响**（1 ≠ 0，仍可用）：
 * "余量未知"从来就不是"不可用"，这一点与 ADR-0011 原文一致，没有放松过滤。
 */
const UNKNOWN_PLAN_QUOTA = 1;

function remainingQuotaOf(key: KeyConfig, rt: RuntimeExtras): number {
  if (key.category === 'token-plan') {
    if (key.tokenPlanRemainingTokens === null) return UNKNOWN_PLAN_QUOTA; // 未知 → 仍排在余额 key 前
    return Math.max(0, key.tokenPlanRemainingTokens - rt.spentTokens);
  }
  // balance 类不参与「剩余额度」排序（ADR-0011）：余额是计费资金，不是随请求递减的配额，
  // 若按 balanceCents 排序，余额最高者会垄断全部流量（验收 §九.1 要求每 key ≥10% 出量）。
  // 返回常量 0 让 balance 类在键 2 上全平，轮转交给兜底位（lastUsedSeq LRU）。
  // 可用性过滤（<=0 排除）仍在 isUsable，与排序无关。
  return 0;
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
  const cooldownLadderMs = options.cooldownLadderMs;
  const autoDisableAfter = options.autoDisableAfterConsecutiveFails ?? DEFAULT_AUTO_DISABLE_AFTER;
  const defaultMaxConcurrency = options.defaultMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const usageSink = options.usageSink;
  /**
   * 失败时效窗：lastFailureAt 超过该窗口在排序比较中归「从未失败」。
   * 否则陈旧失败（如昨晚 401 风暴留下的相异时间戳）会永久钉死键 3，LRU 永远轮不到（探针 P1 实证）。
   * 窗口取冷却封顶（maxCooldownMs ?? MAX_COOLDOWN_MS）：一次失败最多冷却这么久，超窗即视为已康复。
   */
  const failureFreshnessMs = maxCooldownMs ?? MAX_COOLDOWN_MS;

  let snapshot: PoolSnapshot = { revision: 0, upstreams: [], keys: [] };
  const runtime = new Map<string, KeyRuntimeState & RuntimeExtras>();
  /** 单调递增的使用序号（LRU 兜底键，见 RuntimeExtras.lastUsedSeq） */
  let usedSeq = 0;
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
        if (rb !== ra) return rb - ra; // 2. 剩余额度降序（token-plan；balance 类恒 0 故总排在套餐 key 后，见 ADR-0011 + UNKNOWN_PLAN_QUOTA）
        const la = freshFailureAt(a);
        const lb = freshFailureAt(b);
        if (la !== lb) return la - lb; // 3. 上次失败时间升序（从未失败优先；超窗归从未失败）
        const ua = runtimeOf(a).lastUsedSeq;
        const ub = runtimeOf(b).lastUsedSeq;
        if (ua !== ub) return ua - ub; // 4. LRU：最久未用优先（从未使用 = 0 = 最早）
        // 5. 快照顺序兜底：序号全异的场景到不了这里，纯防御。
        return (order.get(a.keyId) ?? 0) - (order.get(b.keyId) ?? 0);
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
      /** tie#3 时效化：lastFailureAt 只在冷却窗内参与比较，过期归「从未失败」 */
      function freshFailureAt(c: KeyCandidate): number {
        const rt = runtimeOf(c);
        if (rt.lastFailureAt === null) return -1;
        return t - rt.lastFailureAt <= failureFreshnessMs ? rt.lastFailureAt : -1;
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
      rt.cooldownUntil =
        t +
        nextCooldownMs({
          reason,
          consecutiveFails: rt.consecutiveFails,
          retryAfterMs: opts?.retryAfterMs,
          maxCooldownMs,
          ...(cooldownLadderMs === undefined ? {} : { ladderMs: cooldownLadderMs }),
        });

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
      // 一次真实的成功就是最强的证据：这把 key 现在能敲通上游。若留着 autoDisabled，
      // 这把 key 会被 isUsable 的第一行永久踢出选路，而自动禁用是**网关自己的推断**
      // （连续 5 次 401），不是管理端的配置意图 —— 推断被证据推翻时就该撤回。
      // 此前不清的后果是进程级不可恢复：key_runtime 没有这一列、管理面没有入口、
      // applySnapshot 也不清，唯一的恢复手段是重启进程（审计项 A）。
      rt.autoDisabled = false;
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
      usedSeq += 1;
      rt.lastUsedSeq = usedSeq; // LRU 游标：占到并发位（真的要去敲上游）才算「用过」
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
        // 与 failCount 同族：只在 /internal/snapshot 上可见，不进 key_runtime 镜像
        // （表里没有这一列，加了就是给 ADR-0010 的单向镜像添一个"永不刷新"的假字段）。
        // 管理端想看"这把 key 是不是被自动禁用了"只能看日志里的 AUTH_INVALID_AUTO_DISABLED
        // 告警 —— 这是已知缺口，不是遗漏：自动禁用态不落库，重启即归零（见 types.ts 注释）。
        autoDisabled: r.autoDisabled,
      }));
    },
  };

  return pool;
}
