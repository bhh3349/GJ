/**
 * 网关内核 - 出口（IP 级）预算闸 / 冷却态 / 归因判据
 * 冻结依据：docs/adr/0021-egress-budget-seam.md（决策 2/3/5/8/10）+ docs/api-contract.md §16.7
 *
 * 本文件是**实现**；端口在 `src/egress/port.ts`（跨车道冻结件，只依赖标准库）：
 *   · `reserve`        逐出口令牌桶 + 数据面保留额（决策 8）
 *   · `observeLimited` 归因判据（决策 10）—— 命中则落冷却（决策 5 表内被动那行）
 *   · `observeSuccess` 出口真的答了 ⇒ 清连续计数、退出升档（决策 3）
 *   · `cooldownUntil` / `snapshot()` 两个只读面（后者签名逐字不动，契约 v1.5.0 ②）
 *
 * **一个实例持三种状态**（决策 3「令牌桶 + 冷却态同一个实例」）：它们挂在**同一个出口**上，
 * 拆成三份 = 三张表各自回答「这个出口现在能不能用」。装配口径：**一个进程一份、造一次注入两处**
 * （`src/server.ts`，决策 4c）—— 每个请求各建一份等于没建。
 *
 * 三条不许漂移的口径（每条都对应一类静默事故）：
 *   1. **桶拒绝不写冷却、不推进阶梯**（决策 5 表内第 2 行）：额度耗尽是我们**自己**算出来的账、
 *      没有上游证据；顺手 `cool()` 会在几十毫秒内把封顶档爬满，整个出口 30min 一个请求都不给。
 *      ⇒ `reserve` 只**读**冷却态，从不写它。
 *   2. **观察面只此一处**（决策 4a / 验证 7）：`classify.ts` 那两个识别器已退休，归因窗只由
 *      `observeLimited` 写。旁路第二个计数器 = 一个被打空预算的出口拿**自己拒出来的** N 张脸
 *      判成「被上游限」再冷掉自己 —— 决策 8 那个自伤最直接的闭合成环形态。
 *   3. **`snapshot()` 全量、含已过期条目、不过滤**（契约 v1.5.0 ②）：差分通道没有墓碑，滤掉到期的
 *      出口 = **解除帧永不发出**（前端永远停在「出口限流中」）。同理**预算桶不在这张表里**：
 *      一次人工刷新（几十次拒绝，验证 9）不得让 §7 帧有任何变化 ⇒ 桶另置一表，不是靠过滤。
 *
 * 数值纪律（决策 8）：容量是**每个出口**的数，不是全站的数，构造参数注入；占位值见
 * `EGRESS_BUDGET_PLACEHOLDER`（PM 已裁定写死，标定回来**只改数、不改结构**）。判据的两个数
 * （N=3 / 窗口 60s 滑动）同为**初值**，纪律同上（决策 10(1)）。
 *
 * 本文件不认识 key 明文（只认识 id）：`subject.keyId` 落在足迹位，与判据无关（决策 10(2)）。
 */

import {
  type EgressConsumer,
  type EgressGate,
  type EgressLimitedInput,
  type EgressReservation,
  type EgressShadowRecord,
  type EgressShadowSink,
  type EgressVerdict,
} from '../egress/port.js';
import { MAX_COOLDOWN_MS, nextCooldownMs } from './cooldown.js';

/* ------------------------------------------------------------------ *
 * 数值：占位 / 初值（改这里就是改标定输入，见文件头「数值纪律」）
 * ------------------------------------------------------------------ */

/**
 * 归因判据的两个初值（决策 10(1)）：**N = 3 个不同账号**、窗口 **60s 滑动**。
 * N=2 是数学下限，取 3 是因为去重到账号之后剩下的唯一误报源是**巧合**（池子忙时 60s 内的巧合不罕见）。
 */
const DEFAULT_ATTRIBUTION_WINDOW_MS = 60_000;
const DEFAULT_DISTINCT_ACCOUNTS = 3;

/**
 * 本期 `observeLimited` **只在 429 路径被调用**（决策 10(3)），事件天然同型 ⇒ `types` 只有这一个值。
 * 它是**诊断位、不进判据**：把「同型」实现成一个滤波器，只会造出一个恒真的条件。
 */
const LIMITED_TYPE = 'RATE_LIMITED';

/**
 * 预算占位值（决策 8；PM 2026-10-07 裁定照此写死）。
 *
 * `reserveForData` 与 `capacity` **写在同一个构造参数里**是 PM 的明确要求 —— 两处分头定义
 * 就是「保留额」与「容量」各说各话的起点。接线层（`src/server.ts`）引用这一份、**不得再抄一遍数字**；
 * 标定回填时**只改数、不改结构**。
 *
 * 口径复述（免得被读成两个独立的数）：管理面可用 = `capacity - reserveForData`、
 * 数据面可用 = `capacity`，**两者之和不超过 `capacity`**（同一张账，不是两张）。
 * 没有保留额，一次人工全量刷新（26 key × 2 = 52 枚）可以**合规地**吃干整段预算、饿死客户端流量。
 */
export const EGRESS_BUDGET_PLACEHOLDER: EgressBudget = { capacity: 5, windowMs: 60_000, reserveForData: 1 };

/** 出口预算（决策 8）。**单出口口径** —— 多出口部署时这几个数须**逐出口**回填，不得加总 */
export interface EgressBudget {
  /** 每个出口、每个窗口可发出的请求数 */
  capacity: number;
  /** 预算窗口（**滑动**：连续取 `capacity` 枚后第 `capacity+1` 次即被拒，直到最早那枚滑出） */
  windowMs: number;
  /** 数据面保留额：该出口**剩余 ≤ reserveForData** 时 `'management'` 必须被拒（决策 8） */
  reserveForData: number;
}

/**
 * 判据模式（决策 10(6)）。`'shadow'` 是**缺省**，也是「判据默认关」的唯一表达式：
 * 恒回 `'key'` **且照常产出 shadow 记录**（不是「不调用」—— 不调用会让「影子没响」同时意味着
 * 未接线 / 判据没发现 / 判据炸了三件不同的事，标定无从分辨）。
 *
 * **放行不是改这里**：是接线层显式注入 `'active'`；§7 帧的起点是「判据真正启用」那一刻。
 */
export type EgressAttributionMode = 'shadow' | 'active';

export interface EgressGateOptions {
  /** 注入时钟，便于单测；默认 Date.now */
  now?: () => number;
  /** 冷却封顶，默认 30min（与 key 级同值，§16.7） */
  maxCooldownMs?: number;
  /** 升档阶梯，缺省用冻结常量；语义同 `PoolOptions.cooldownLadderMs` */
  ladderMs?: readonly number[];
  /** 出口预算；缺省即 `EGRESS_BUDGET_PLACEHOLDER`（**接线层可显式覆写 = 标定回填的落点**） */
  budget?: EgressBudget;
  /** 归因窗口（决策 10(1) 初值 60s 滑动） */
  attributionWindowMs?: number;
  /** 归因判据的 N（决策 10(1) 初值 3）；**必须 ≥ 2** —— 1 就是那条被否掉的「裸 429」 */
  distinctAccounts?: number;
  /** 判据模式；缺省 `'shadow'`（只记不动） */
  mode?: EgressAttributionMode;
  /** shadow 记录出口（标定直接吃它）；缺省丢弃。抛异常不得影响数据面 */
  onShadow?: EgressShadowSink;
}

/* ------------------------------------------------------------------ *
 * 内部状态（三张表各司其职，互不串门 —— 见文件头第 3 条的「桶另置一表」）
 * ------------------------------------------------------------------ */

interface CooldownState {
  /** 连续命中次数（出口成功一次即归零），驱动与 key 级同一条升档阶梯 */
  consecutive: number;
  /** 冷却结束时刻（epoch ms 绝对时刻）；0 = 未冷却 */
  until: number;
}

/** 一个账号在一段窗口内的 429 足迹（`types` 只为诊断，见 `LIMITED_TYPE`） */
interface AccountStrike {
  lastTs: number;
  types: string[];
}

interface AttributionState {
  /**
   * `accountId → 最近一次 429`。**`window.size` 就是 `distinctAccounts`**（决策 10(3)），
   * 每次 `observeLimited` 惰性剪掉 `lastTs < now − windowMs` 的条目。
   * 内存上界 = **该出口上的账号数**，与 429 事件数无关 —— 否则一次 429 风暴（它的触发条件
   * 恰恰就是风暴）会把内存打成事件条数。
   */
  window: Map<string, AccountStrike>;
  /**
   * 该出口上**见过**的账号（只增不剪）。
   *
   * 用途只有一个：判断 `insufficientAccounts`（决策 10(5)）—— 「单账号出口 / 全无主 key 的出口」
   * 上「跨账号相关性」这个**前提**不成立，判据**结构上**触不到。它必须在窗口之外另存一份：
   * 窗口级 `size < N` 与「前提不成立」是两件不同的事，混起来会让**未命中**把标定带偏
   * （拿「判据没响」当成「出口没问题」）。上界同样是该出口上的账号数。
   */
  accountsOnEgress: Set<string>;
}

/* ------------------------------------------------------------------ *
 * 校验：构造期 fail-fast（数值纪律的看门人）
 * ------------------------------------------------------------------ */

function assertBudget(budget: EgressBudget): void {
  if (!Number.isInteger(budget.capacity) || budget.capacity < 1) {
    throw new Error(`egress budget.capacity must be a positive integer, got ${budget.capacity}`);
  }
  if (!Number.isFinite(budget.windowMs) || budget.windowMs <= 0) {
    throw new Error(`egress budget.windowMs must be > 0, got ${budget.windowMs}`);
  }
  // 保留额与容量是**同一张账**：reserveForData > capacity 意味着数据面自己都不够、管理面口径无意义
  if (!Number.isInteger(budget.reserveForData) || budget.reserveForData < 0 || budget.reserveForData > budget.capacity) {
    throw new Error(
      `egress budget.reserveForData must be an integer in [0, capacity], got ${budget.reserveForData}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 实现
 * ------------------------------------------------------------------ */

export function createEgressGate(options: EgressGateOptions = {}): EgressGate {
  const now = options.now ?? Date.now;
  const maxCooldownMs = options.maxCooldownMs ?? MAX_COOLDOWN_MS;
  const budget = options.budget ?? EGRESS_BUDGET_PLACEHOLDER;
  const attributionWindowMs = options.attributionWindowMs ?? DEFAULT_ATTRIBUTION_WINDOW_MS;
  const distinctAccounts = options.distinctAccounts ?? DEFAULT_DISTINCT_ACCOUNTS;
  const mode = options.mode ?? 'shadow';
  const onShadow = options.onShadow;

  assertBudget(budget);
  if (!Number.isInteger(distinctAccounts) || distinctAccounts < 2) {
    // N=1 = 「裸 429 即判出口」（决策 10 已否掉的形态）：它不是「更灵敏」，是把每一次限流都算成出口问题
    throw new Error(`egress distinctAccounts must be an integer >= 2, got ${distinctAccounts}`);
  }
  if (!Number.isFinite(attributionWindowMs) || attributionWindowMs <= 0) {
    throw new Error(`egress attributionWindowMs must be > 0, got ${attributionWindowMs}`);
  }

  const ladderOptions = options.ladderMs === undefined ? {} : { ladderMs: options.ladderMs };

  /** 冷却表：**只有 `observeLimited` 会创建条目** —— `snapshot()` 直接迭代它（神出鬼没的条目 = 假帧） */
  const cooldowns = new Map<string, CooldownState>();

  /**
   * 预算桶：`egressId → 窗口内已取走的时刻（升序）`。
   * **不在 `snapshot()` 里**（文件头第 3 条）：一次人工刷新会连打几十枚，桶要是进表，
   * 前端会看到 §7 帧无端抖动 —— 而那是「我们自己取的配额」，不是「上游在限我们」。
   */
  const buckets = new Map<string, number[]>();

  /** 归因窗：`egressId → 足迹`。同样**不进 `snapshot()`**（它是诊断态，不是可用态） */
  const attribution = new Map<string, AttributionState>();

  function strikesOf(egressId: string): AttributionState {
    let state = attribution.get(egressId);
    if (state === undefined) {
      state = { window: new Map(), accountsOnEgress: new Set() };
      attribution.set(egressId, state);
    }
    return state;
  }

  function coolOf(egressId: string, retryAfterMs?: number): number {
    const state = cooldowns.get(egressId) ?? { consecutive: 0, until: 0 };
    state.consecutive += 1;
    const ms = nextCooldownMs({
      reason: 'RATE_LIMITED',
      consecutiveFails: state.consecutive,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      maxCooldownMs,
      ...ladderOptions,
    });
    state.until = now() + ms;
    cooldowns.set(egressId, state);
    return state.until;
  }

  return {
    /**
     * 取配额。**顺序不可换**：先看冷却、再看桶（决策 3）—— 一个正在冷却的出口即便桶里有余额，
     * 放行也是错的（冷却的语义是「对面在忙，别再打」）。
     *
     * `consumer` 只影响**上限**：`'management'` 的可用量是 `capacity − reserveForData`。
     * 这是**保留额**（决策 8）：池子大、一次人工刷新合规地吃干预算也能饿死数据面的反面。
     *
     * **同步、无 `await`、无 Promise**（验证 13）：端口签名刻意同步，把异步挡在实现侧。
     */
    reserve(egressId: string, consumer: EgressConsumer): EgressReservation {
      const t = now();

      const cooling = cooldowns.get(egressId);
      if (cooling !== undefined && cooling.until > t) {
        return { allowed: false, reason: 'cooldown', retryAfterMs: cooling.until - t };
      }

      const limit = consumer === 'management' ? budget.capacity - budget.reserveForData : budget.capacity;
      const took = buckets.get(egressId) ?? [];
      // 滑动窗口：惰性剪掉滑出的时刻（`<=` 因为 t 本身也在窗内）
      let drop = 0;
      while (drop < took.length && took[drop]! <= t - budget.windowMs) drop += 1;
      if (drop > 0) took.splice(0, drop);

      if (took.length >= limit) {
        // 恢复时刻 = 最早那枚滑出窗口的时刻（不是「整窗重来」—— 那会把 60s 窗口读成翻滚窗口）
        const retryAfterMs = took[took.length - limit]! + budget.windowMs - t;
        return { allowed: false, reason: 'budget', retryAfterMs };
      }

      took.push(t);
      buckets.set(egressId, took);
      return { allowed: true };
    },

    /**
     * 收到 429：**全域函数**（端口 v10）—— 任何分支都不抛、不返回 `undefined`。
     *
     * 内部异常**就地降级**为 `{ attribution: 'key', cooldownUntilMs: null }` 并在 shadow 记录里
     * 打 `degraded`。降级路径**不 `cool()`**：「炸了但保险起见冷一下」正是把误报从
     * 「错一次短冷却」放大回「误退出口」的那条路。
     *
     * 判据（决策 10）：同一出口、`attributionWindowMs` **滑动**窗内、≥ `distinctAccounts` 个
     * **不同** `accountId`。`accountId === null` 贡献 0（没归属就没有「跨账号」这个命题）。
     */
    observeLimited(input: EgressLimitedInput): EgressVerdict {
      let verdict: EgressVerdict = { attribution: 'key', cooldownUntilMs: null };
      let record: EgressShadowRecord | null = null;

      try {
        const t = now();
        const state = strikesOf(input.egressId);
        const accountId = input.subject.accountId;

        if (accountId !== null) {
          state.accountsOnEgress.add(accountId);
          // 同一账号重复命中只更新时刻，不新增条目 —— 去重的单位是**账号**，不是事件
          state.window.set(accountId, { lastTs: t, types: [LIMITED_TYPE] });
        }

        // 惰性剪枝（决策 10(3)）：`< t − windowMs` 才算滑出。**窗口滑动的证据在这里**，不是翻滚
        for (const [id, strike] of state.window) {
          if (strike.lastTs < t - attributionWindowMs) state.window.delete(id);
        }

        const distinct = state.window.size;
        // 前提不成立（决策 10(5)）：该出口上**从未见过** N 个账号 ⇒ 判据结构上触不到。
        // 它与「窗口里账号不够」是两件事：单账号出口永远数不满，但那是**没前提**，不是**没命中**。
        const insufficient = state.accountsOnEgress.size < distinctAccounts;
        const wouldFire = distinct >= distinctAccounts;

        record = {
          egressId: input.egressId,
          distinctAccounts: distinct,
          types: [LIMITED_TYPE],
          wouldFire,
          insufficientAccounts: insufficient,
          degraded: false,
        };

        if (wouldFire && mode === 'active') {
          // 决策 10(4)：命中 ⇒ 本次**判给出口**（key 不背这一笔）+ `cool` **一次** ⇒ 阶梯**只进一档**。
          // 「一次一条」是靠 cooldowns 表本身实现的：冷却期内再命中不重复推进（见下面的 until 判断）。
          const cooling = cooldowns.get(input.egressId);
          const alreadyCooling = cooling !== undefined && cooling.until > t;
          const until = alreadyCooling
            ? cooling.until
            : coolOf(input.egressId, input.retryAfterMs);
          verdict = { attribution: 'egress', cooldownUntilMs: until };
          // **不摘除**（决策 10(4) 第 3 步）：出口留在池子里，靠 `reserve` 的冷却态挡住
        }
      } catch {
        // 全域：判据炸了不动状态（见方法头注释）
        verdict = { attribution: 'key', cooldownUntilMs: null };
        record = {
          egressId: safeEgressId(input),
          distinctAccounts: 0,
          types: [],
          wouldFire: false,
          insufficientAccounts: false,
          degraded: true,
        };
      }

      if (record !== null && onShadow !== undefined) {
        try {
          onShadow(record);
        } catch {
          // shadow 出口是**观测**，不是数据面：它抛异常不得改变任何结论（决策 9(5)）
        }
      }

      return verdict;
    },

    /**
     * 出口**真的答了**（仅上游证据）⇒ 清连续计数。
     *
     * **不清归因窗**（决策 3 + 10）：一次成功说明「这个出口现在通」，但它不改变过去 60s 里
     * 确实有 N 个账号被限过这个事实；把窗清掉等于让判据被一次成功永久重置。
     */
    observeSuccess(egressId: string): void {
      const state = cooldowns.get(egressId);
      if (state !== undefined) state.consecutive = 0;
    },

    cooldownUntil(egressId: string): number | null {
      const state = cooldowns.get(egressId);
      if (state === undefined) return null;
      // 过期条目返回 null（读面语义），但**不从表里删** —— 删掉就等于替 `snapshot()` 做了过滤
      return state.until > now() ? state.until : null;
    },

    /**
     * 契约 §7 v1.5.0 ②：`untilMs` 是**绝对时刻**、返回**全量**（含已过期）。
     *
     * 签名与语义**逐字不动**（PM 批一约束）。这也解释了为什么它读 `cooldowns` 而不是
     * 遍历 `buckets`：预算桶不属于「可用态」，它进来就会让 §7 帧跟着人工刷新抖动。
     */
    snapshot(): readonly { host: string; untilMs: number }[] {
      const out: { host: string; untilMs: number }[] = [];
      for (const [host, state] of cooldowns) out.push({ host, untilMs: state.until });
      return out;
    },
  };
}

/**
 * 降级路径里取 `egressId`：`input` 本身已经不可信（可能是个毒化 getter），
 * 读它也可能抛 —— 再套一层，保证「全域」在**最后一步**也成立。
 */
function safeEgressId(input: EgressLimitedInput): string {
  try {
    return input.egressId;
  } catch {
    return '';
  }
}
