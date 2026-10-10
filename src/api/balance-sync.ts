// 余额自动同步调度器（契约 §14.1–14.4 / ADR-0017）。
//
// 它只做四件事，且**四件事的节奏各自独立**：
//   1. 排程：每上游一个 `nextAttemptAt`，到点就跑既有的 `refreshBalances`（**不新增查询路径**）；
//   2. 记账：退避（连续失败 2^n 封顶 6h）、单飞（同上游同时只跑一次）、抖动（±10%）；
//   3. 收尾：一轮覆盖整个上游的同步结束后写快照 + 判方向级漂移；
//   4. 清理：按 `BALANCE_SNAPSHOT_RETENTION_DAYS` 周期裁快照表。
//
// 几处刻意的取舍，都是"实现里最容易顺手改坏"的位置：
//
//   - **拍节式（tick）而不是每上游一条 setTimeout 链**：上游可以在运行时被增删，
//     一条 `setTimeout` 链只能记住"排程那一刻存在哪些上游"，新建的上游会静默地永远不被同步。
//     tick 每轮现查一次上游表，增删自动跟上。代价是每 15s 一次极轻量的 SELECT。
//   - **首轮也带抖动**：否则开机那一刻 N 个上游同时开火。15 分钟的 ±10% 只有 3 分钟的
//     摊平宽度，而"同时"这件事只有抖动救得了（退避与单飞都救不了）。
//   - **全局并发上限复用 `REFRESH_CONCURRENCY`**：两处各拍一个上限，早晚会漂成
//     "手动刷新打 4 个、自动同步打 12 个"，症状只是上游那边偶尔 429。
//   - **清理定时器与自动同步开关无关**：`BALANCE_SYNC_MINUTES=0` 时手动刷新照样写快照，
//     表照样长；把裁剪切进"只在写入时裁一次"则是无界增长最容易被漏掉的形状 ——
//     上游删掉后不再产生新快照，裁剪就永远不被触发。
//   - **失败判定只看「本轮有没有拿到任何有效值」**（详见 judgeRound）：ADR 决策 1 的
//     字面表述（`failed > 0 且 ok == 0` 与「`unknown` 算失败」）彼此不能同时成立 ——
//     `unknown` 是 `ok` 的子集，`ok == 0` 时 `unknown` 必为 0。这里落的是它的**意图**：
//     配置错了就退到后面等人改，没做的事（`skipped`）不罚。
//
// 状态全在进程内存（重启归零，同 §3 `key_runtime` 的既定降级 ADR-0010）；
// 快照与同步时刻落库，重启不丢。

import type { Db } from '../db/database.js';
import { computeGlobalBalance } from '../db/balance.js';
import {
  appendBalanceSnapshot,
  latestBalanceSnapshot,
  latestSnapshotTsPerUpstream,
  listBalanceSnapshots,
  previousBalanceSnapshot,
  pruneBalanceSnapshots,
  sumTokensBetween,
} from '../db/repo/balance-snapshots.js';
import { listUpstreamIdsAndNames } from '../db/repo/upstreams.js';
import type {
  BalanceDriftAlertDto,
  BalanceDriftCode,
  BalanceSyncSeriesDto,
  BalanceSyncStatusDto,
  BalanceSyncUpstreamStateDto,
} from './dto.js';
import { REFRESH_CONCURRENCY, refreshBalances, type RefreshDone, type UpstreamRefreshResult } from './services/balance-refresh.js';
import type { TaskReporter } from './task-runner.js';

/** 冻结值（ADR-0017 决策 1 / 契约 §14.1），回显进 `auto`，前端不得自算。 */
export const BALANCE_SYNC_JITTER_RATIO = 0.1;
export const BALANCE_SYNC_BACKOFF_CAP_MINUTES = 360;

/** 排程拍节：够快（最坏晚 15s 起跑），又不至于让空转的 tick 变成负担。 */
const DEFAULT_TICK_MS = 15_000;
/** 裁剪拍节：一小时一次足够，且与自动同步的开关/节奏完全解耦。 */
const DEFAULT_PRUNE_INTERVAL_MS = 3_600_000;

/** 漂移提示的保留上限：输出只取 20 条，这里多留一个量级供窗口过滤。 */
const DRIFT_ALERT_BUFFER = 200;
export const DRIFT_ALERT_LIMIT = 20;
/** 超过最大可查窗口（24h，契约 §14.3）的提示留着也没人查得到。 */
const DRIFT_ALERT_MAX_AGE_MS = 86_400_000;

/** 自动同步**不落 `tasks` 表**：每 15 分钟 N 行会把任务列表变成噪音，而自动同步没有
 *  "调用方在等结果"。它的可观测性走 §14.3（`lastSyncedAt` / `lastTrigger` / `series`）。 */
const NOOP_REPORTER: TaskReporter = {
  id: 'balance-sync-auto',
  setTotal: () => {},
  step: () => {},
  note: () => {},
};

/** 只用到这三个方法，够接 Fastify 的 logger，也够测试塞一个假的。 */
export interface BalanceSyncLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface BalanceSyncOptions {
  db: Db;
  masterKey: Buffer;
  /** `BALANCE_SYNC_MINUTES`：`0` = 关闭自动同步（手动三个端点不受影响）。负数在 config 层就拦掉了 */
  intervalMinutes: number;
  /** `BALANCE_SNAPSHOT_RETENTION_DAYS` */
  retentionDays: number;
  log?: BalanceSyncLog | undefined;
  /** 覆盖时钟，仅测试用。 */
  now?: (() => Date) | undefined;
  /**
   * 覆盖随机源（返回 `[0, 1)`），仅测试用。注入 `() => 0.5` 可让抖动系数正好是 1.0 ——
   * 退避阶梯的断言要的是"30m / 1h / 2h"这种精确值，不能被抖动搅成区间判断。
   */
  random?: (() => number) | undefined;
  /**
   * 出站 fetch，**必填、无兜底**（ADR-0021 决策 4c）。由装配根 `buildApp` 解析后透传给
   * `refreshBalances`；测试注入假 fetch 也走同一条路（原先这里允许缺省再靠下游回落全局 `fetch`，
   * 那等于"自动同步这条线静默绕开注入缝"）。
   */
  fetchImpl: typeof fetch;
  /** 排程拍节，仅测试用。 */
  tickMs?: number | undefined;
  /** 裁剪拍节，仅测试用。 */
  pruneIntervalMs?: number | undefined;
  /**
   * `false` = 不注册任何真实定时器，测试用 `tick()` / `pruneNow()` 手动驱动。
   * 默认 `true`（生产就是靠定时器跑的）。
   */
  timers?: boolean | undefined;
}

export interface BalanceSync {
  /** 幂等。注册排程与裁剪两条定时器，并立刻排一次程（**不会**立刻同步：首轮带抖动）。 */
  start(): void;
  /** 幂等。只清定时器：已在飞的那一轮让它自己跑完（进程正在关，它最多留下一行被吞掉的日志）。 */
  stop(): void;
  /** 跑一轮"到点就起"的排程。`await` 会等到本轮**起跑的那些**上游结束，便于测试断言。 */
  tick(): Promise<void>;
  /** 立刻裁一次，返回删除行数。 */
  pruneNow(): number;
  /** 刷新收尾钩子（自动与手动**共用**同一个入口，见 §14.3 "任意触发都算"）。 */
  onRefreshDone(done: RefreshDone): void;
  /** 只读聚合，**不触发任何查询、不改任何状态**（契约 §14.3）。 */
  status(windowSeconds: number, upstreamId?: string | undefined): BalanceSyncStatusDto;
  /** 当前在飞的上游数（测试断言并发上限用）。 */
  inFlightCount(): number;
}

interface UpstreamState {
  consecutiveFailures: number;
  /** epoch ms；`0` = 尚未排程（下一个 tick 按基准间隔 + 抖动排一次） */
  nextAttemptAt: number;
  inFlight: boolean;
}

/** 本轮该上游的记账结论。 */
type RoundVerdict =
  /** 拿到了至少一个有效值 → 退避归零 */
  | 'value'
  /** 发起了请求、但一个有效值都没拿到 → 退避 +1 */
  | 'failure'
  /** 什么也没做（没配查询方式 / 压根没有 key）→ 既不推进也不归零 */
  | 'noop';

export function createBalanceSync(options: BalanceSyncOptions): BalanceSync {
  const { db, masterKey, intervalMinutes, retentionDays, log } = options;
  const now = options.now ?? ((): Date => new Date());
  const random = options.random ?? Math.random;
  const fetchImpl = options.fetchImpl;
  const tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  const pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const withTimers = options.timers ?? true;

  const enabled = intervalMinutes > 0;
  const states = new Map<string, UpstreamState>();
  // 进程内计数与提示环形缓冲：重启归零（同 `events.dropped` 的"本进程"口径）。
  const driftCounts: Record<BalanceDriftCode, number> = {
    BALANCE_SPENT_WITHOUT_TRAFFIC: 0,
    BALANCE_UNCHANGED_WITH_TRAFFIC: 0,
  };
  const driftAlerts: BalanceDriftAlertDto[] = [];

  let tickTimer: NodeJS.Timeout | null = null;
  let pruneTimer: NodeJS.Timeout | null = null;
  /**
   * 显式记"启动过"。**不能只靠两个 timer 句柄判**：测试里 `timers:false` 两个句柄
   * 永远是 null，那样 `start()` 就不再幂等 —— 每调一次就多排一轮程、多裁一次表。
   */
  let started = false;
  let stopping = false;

  function getState(upstreamId: string): UpstreamState {
    let st = states.get(upstreamId);
    if (st === undefined) {
      st = { consecutiveFailures: 0, nextAttemptAt: 0, inFlight: false };
      states.set(upstreamId, st);
    }
    return st;
  }

  /** 抖动：`[1-r, 1+r] × ms`。取整到毫秒 —— 断言里出现 899999.9999999999 只会制造噪音。 */
  function jitter(ms: number): number {
    return Math.round(ms * (1 - BALANCE_SYNC_JITTER_RATIO + 2 * BALANCE_SYNC_JITTER_RATIO * random()));
  }

  /**
   * 该上游下一次尝试距现在多久：`min(base × 2^n, 6h)` 再抖动。
   *
   * 指数先夹住（`2 ** n` 在大 n 下会变成 `Infinity`，`Math.min` 虽然还能兜住，
   * 但那是"兜住"不是"算对"），再夹住结果 —— 6h 封顶必须在跑了很久之后依然生效。
   */
  function backoffMs(failures: number): number {
    const n = Math.min(Math.max(failures, 0), 16);
    const raw = Math.min(intervalMinutes * 60_000 * 2 ** n, BALANCE_SYNC_BACKOFF_CAP_MINUTES * 60_000);
    return jitter(raw);
  }

  /**
   * 本轮怎么记账。判据是 ADR 决策 1 的**意图**：只要拿到过一个有效值就是成功，
   * 一个都没拿到（且确实发起了请求）就是失败，什么都没做就不罚。
   *
   * `valued = ok - unknown`：`unknown` 是 `ok` 的子集（请求 2xx 但取不到数），
   * 不减掉它就会把"上游改了字段名、每次都成功但每次都拿不到数"读成健康 ——
   * 而那正是最该退避等人工介入的形态。
   */
  /** 判据②的达标线（§14.1：**阈值是实现常量、不进契约**）。 */
  const SUCCESS_RATIO_THRESHOLD = 0.8;

  /**
   * 本轮怎么记账（ADR-0017 补遗 2 / 契约 §14.1 三判据，v1.7.0 改写）：
   *   ① 有值 —— `ok - unknown > 0`（原判据，不变）；
   *   ② 成功比例达标 —— `(ok - unknown) / (checked - skipped) ≥ 80%`，**分母排除 `skipped`**；
   *   ③ 本轮无 429 —— `rateLimited == 0`（429 是**压力在挤压**的直接证据：25 成功 + 1 个 429
   *      也不是健康的一轮；判据 = 状态码本身，上游真 429 与本地合成的 429 归同一行）。
   * 三条**同时成立**才算归零，推进条件照旧 `min(base × 2^n, 6h)`。
   *
   * `noop` 依旧不看 429：什么都没做的一轮（没配查询方式 / 压根没有 key）没有失败样本，
   * `rateLimited` 恒为 0 —— 无从谈"本轮有 429"。
   */
  function judgeRound(r: UpstreamRefreshResult): RoundVerdict {
    if (r.checked === 0) return 'noop';
    const valued = r.ok - r.unknown;
    // 判据①③：无有效值、或本轮出现过 429（挤压的直接证据）→ 不归零。
    // 三判据是**同时成立**才算归零 —— 把 429 判据放在 return 'value' 之后会被 ① 短路，
    // "25 成功 + 1 个 429"就会读成健康的一轮（ADR-0017 补遗 2 点名的反例）。
    if (valued <= 0 || r.rateLimited > 0) {
      // 一把都没发出去（该上游没配查询方式）：没做的事不该被罚
      if (r.skipped === r.checked) return 'noop';
      return 'failure';
    }
    // 判据②：分母排除 `skipped` —— 没做的事不算进"该成功的轮次"
    const denominator = r.checked - r.skipped;
    if (denominator > 0 && valued / denominator < SUCCESS_RATIO_THRESHOLD) return 'failure';
    return 'value';
  }

  /**
   * 刷新收尾：退避记账 → 写快照 → 判漂移。
   *
   * **异常必须在这里吞掉**：抛出去会把一次刷新结果正常的任务标成 `failed`
   * （快照写失败 ≠ 余额刷新失败），而调用方（`refreshBalances` 的调用者）不会兜底。
   */
  function onRefreshDone(done: RefreshDone): void {
    try {
      // 是否覆盖整个上游对**这一轮**是常量；单 key 手动刷新写的就是半新半旧的假快照（§14.3）。
      const whole = done.wholeUpstream;
      for (const r of done.upstreams) {
        const st = getState(r.upstreamId);
        const verdict = judgeRound(r);

        if (verdict === 'value') {
          st.consecutiveFailures = 0;
        } else if (verdict === 'failure' && whole) {
          // 只有**整上游**的一轮才推进退避：一把 key 单独失败（它自己坏了）不足以
          // 说明这个上游"查不通"，拿部分证据去退避只会让好上游一起被拖慢。
          // §14.1（v1.7.0）改写后这里覆盖两型：0 有效值（原口径）与「有值但比例 <80%
          // 或本轮有 429」—— 在共用出口预算下，后者若不退让就是"每 15 分钟准时再烧一次窗口"。
          st.consecutiveFailures += 1;
        }

        st.nextAttemptAt = now().getTime() + backoffMs(st.consecutiveFailures);

        if (whole) writeSnapshotOnce(r.upstreamId, done.at, done.trigger, r.rateLimited);
      }
    } catch (err) {
      log?.error({ err }, '余额快照写入失败（刷新本身的结果不受影响）');
    }
  }

  /**
   * 写一条快照 = 照下"该上游**此刻**所有未软删 key 的余额状态"。
   *
   * 数字直接取自 `computeGlobalBalance`（ADR-0003 的三口径），不再另写一套 SQL ——
   * 快照与 §6 余额页要是各算各的，迟早出现"总数对不上单上游之和"。
   */
  function writeSnapshotOnce(upstreamId: string, at: string, trigger: 'auto' | 'manual', rateLimitedThisRound: number): void {
    const u = computeGlobalBalance(db).byUpstream.find((x) => x.upstreamId === upstreamId);
    // 上游在刷新过程中被删了：不写"孤儿快照"（这一行会永远没有对应的上游可读）
    if (u === undefined) return;

    appendBalanceSnapshot(db, {
      upstreamId: u.upstreamId,
      upstreamName: u.name,
      ts: at,
      totalBalanceCents: u.totalBalance,
      // known 必须**同时**减掉无限额度那一格：无限额度 key 的 balance 恒为 null，
      // 但从 v1.4.0 起它不再进 unknown（ADR-0018 决策 8）。少减这一项，
      // 27 把无限 key 就会被算成"余额已知 27 把" —— 一个查不到任何数值的"已知"。
      knownKeyCount: u.balanceKeyCount - u.balanceUnknownKeyCount - u.unlimitedKeyCount,
      unknownKeyCount: u.balanceUnknownKeyCount,
      unlimitedKeyCount: u.unlimitedKeyCount,
      tokenPlanKeyCount: u.tokenPlanKeyCount,
      trigger,
    });
    judgeDrift(upstreamId, at, u.totalBalance, rateLimitedThisRound);
  }

  /**
   * 方向级漂移判定（ADR-0017 决策 4）。**只能是方向级**：本地没有单价，
   * "余额掉了 3 元"与"用了 12000 token"之间没有可比量纲 —— 硬折成钱就得引入单价表，
   * 那是被撤销的上一版。所以这里只判方向 + 零/非零，不做量级比较。
   *
   * `totalBalanceCents` 是**刚从参数传进来**的这次查得值，而不是回表再读一遍：
   * 回读要按 `(upstream_id, ts)` 精确命中，而同一毫秒完全可能落下两条 —— 读错一条
   * 就会算出一个不存在的差额。
   */
  function judgeDrift(upstreamId: string, ts: string, totalBalanceCents: number | null, rateLimitedThisRound: number): void {
    const prev = previousBalanceSnapshot(db, upstreamId, ts);
    if (prev === null) return; // 少于 2 条不判
    const a = prev.totalBalanceCents;
    // 任一端未知（含"那一刻全未知"）：未知与未知之间没有差额可言
    if (a === null || totalBalanceCents === null) return;
    // 前置条件（v1.7.0 加，契约 §14.4）：本轮存在出口级限流时两个码都**不判定**。
    // 被 429 冻住的 key "一个字都不写"（§14.2 正确）⇒ 余额停在旧值，但流量照样计进
    // `usedTokens` —— "余额没动 + 有流量"是**挤压的读数**，不是漂移证据（宁缺勿假）。
    // 零 DDL：判据输入就是 §14.1 已经算出来的那个 `rateLimited`。
    if (rateLimitedThisRound > 0) return;

    const delta = totalBalanceCents - a;
    const usedTokens = sumTokensBetween(db, upstreamId, prev.ts, ts);

    let code: BalanceDriftCode | null = null;
    if (delta < 0 && usedTokens === 0) code = 'BALANCE_SPENT_WITHOUT_TRAFFIC';
    else if (delta === 0 && usedTokens > 0) code = 'BALANCE_UNCHANGED_WITH_TRAFFIC';
    // 余额上升不告警（充值 / 上游按周期重置都正常）
    if (code === null) return;

    driftCounts[code] += 1;
    pushDriftAlert({ code, upstreamId, from: prev.ts, to: ts, usedTokens });
    // 只记码 + upstreamId + 窗口：不记 key 明文，也不记金额明细（ADR-0006 同纪律）。
    log?.warn(
      { code, upstreamId, from: prev.ts, to: ts, usedTokens, balanceDriftTotal: driftCounts[code] },
      '余额漂移提示',
    );
  }

  /** 环形缓冲。追加顺序 ≈ 快照时序，所以**头部就是最旧的**，从头部丢即可。 */
  function pushDriftAlert(alert: BalanceDriftAlertDto): void {
    driftAlerts.push(alert);
    // 超过最大可查窗口（24h）的提示留着也没人查得到 —— 而窗口内的一定不会被这一条丢掉。
    const cutoff = now().getTime() - DRIFT_ALERT_MAX_AGE_MS;
    for (;;) {
      const head = driftAlerts[0];
      if (head === undefined || Date.parse(head.to) >= cutoff) break;
      driftAlerts.shift();
    }
    while (driftAlerts.length > DRIFT_ALERT_BUFFER) driftAlerts.shift();
  }

  /**
   * 跑一轮排程。**同步占位**很关键：`inFlight` 与并发计数都在第一个 `await` 之前落下，
   * 否则两个重叠的 tick（上一轮还没结束、下一拍又到）会同时看中同一个上游 ——
   * 单飞就是这么破的。
   */
  async function tick(): Promise<void> {
    if (!enabled || stopping) return;
    const nowMs = now().getTime();
    const ups = listUpstreamIdsAndNames(db);

    // 已删上游的状态跟着清掉：不留着只会让 `nextRunAt` 被一个不存在的上游钉在过去
    const live = new Set(ups.map((u) => u.id));
    for (const id of [...states.keys()]) {
      if (!live.has(id)) states.delete(id);
    }

    let inFlight = countInFlight();
    const starting: Promise<void>[] = [];
    for (const u of ups) {
      const st = getState(u.id);
      if (st.nextAttemptAt === 0) {
        // 首轮排程也带抖动。排完**不立刻跑**：这一拍它还不"到点"。
        st.nextAttemptAt = nowMs + backoffMs(st.consecutiveFailures);
      }
      if (inFlight >= REFRESH_CONCURRENCY) continue; // 上限复用全量刷新的并发数，别另拍一个
      if (st.inFlight || st.nextAttemptAt > nowMs) continue;
      st.inFlight = true;
      st.nextAttemptAt = 0; // 由本轮收尾重排；收尾没排（无 key / 钩子异常）时下面兜底
      inFlight += 1;
      starting.push(runOne(u.id, st));
    }
    await Promise.all(starting);
  }

  async function runOne(upstreamId: string, st: UpstreamState): Promise<void> {
    try {
      await refreshBalances(db, masterKey, { upstreamId }, NOOP_REPORTER, {
        trigger: 'auto',
        onUpstreamDone: onRefreshDone,
        fetchImpl,
      });
    } catch (err) {
      // `refreshBalances` 内部已把"单把 key 失败"消化成计数；走到这里说明是库/接线级异常。
      // 它也必须自己把节奏排回去：钩子没跑 ⇒ `nextAttemptAt` 还停在 0 ⇒ 每拍重试 = 忙等。
      st.consecutiveFailures += 1;
      log?.error({ err, upstreamId }, '余额自动同步失败');
    } finally {
      if (st.nextAttemptAt === 0) st.nextAttemptAt = now().getTime() + backoffMs(st.consecutiveFailures);
      st.inFlight = false;
    }
  }

  function countInFlight(): number {
    let n = 0;
    for (const st of states.values()) if (st.inFlight) n += 1;
    return n;
  }

  /**
   * 保留期裁剪。**独立节拍、与自动同步开关无关**（PM 实现期第 1 条）：
   * 长跑进程永不清理就是无界增长，而上游删掉后不再有新快照，挂在写入路径上的"顺手裁一次"永远触发不到。
   */
  function pruneNow(): number {
    try {
      const removed = pruneBalanceSnapshots(db, retentionDays, now());
      if (removed > 0) log?.info({ removed, retentionDays }, '余额快照保留期裁剪');
      return removed;
    } catch (err) {
      log?.error({ err }, '余额快照裁剪失败');
      return 0;
    }
  }

  function status(windowSeconds: number, upstreamId?: string | undefined): BalanceSyncStatusDto {
    const nowMs = now().getTime();
    const to = new Date(nowMs).toISOString();
    const from = new Date(nowMs - windowSeconds * 1000).toISOString();

    const latest = latestBalanceSnapshot(db);
    const lastTs = latestSnapshotTsPerUpstream(db);

    const upstreams: BalanceSyncUpstreamStateDto[] = listUpstreamIdsAndNames(db)
      .filter((u) => upstreamId === undefined || u.id === upstreamId)
      .map((u) => {
        const st = states.get(u.id);
        return {
          upstreamId: u.id,
          name: u.name,
          lastSyncedAt: lastTs.get(u.id) ?? null,
          consecutiveFailures: st?.consecutiveFailures ?? 0,
          nextAttemptAt: planOf(st),
          inFlight: st?.inFlight ?? false,
        };
      });

    // series 来自**快照行**而不是上游表：上游被物理删除后（ADR-0016）这一路历史仍要能读
    const series: BalanceSyncSeriesDto[] = [];
    for (const row of listBalanceSnapshots(db, {
      from,
      to,
      ...(upstreamId === undefined ? {} : { upstreamId }),
    })) {
      let s = series[series.length - 1];
      if (s === undefined || s.upstreamId !== row.upstreamId) {
        s = { upstreamId: row.upstreamId, label: row.upstreamName, points: [] };
        series.push(s);
      }
      s.points.push({
        t: row.ts,
        totalBalanceCents: row.totalBalanceCents,
        knownKeyCount: row.knownKeyCount,
        unknownKeyCount: row.unknownKeyCount,
        unlimitedKeyCount: row.unlimitedKeyCount,
        tokenPlanKeyCount: row.tokenPlanKeyCount,
      });
    }

    const alerts = driftAlerts
      .filter((a) => a.to >= from && a.to <= to && (upstreamId === undefined || a.upstreamId === upstreamId))
      .sort((x, y) => (x.to < y.to ? 1 : x.to > y.to ? -1 : 0)) // 按 `to` 倒序（契约 §14.3）
      .slice(0, DRIFT_ALERT_LIMIT);

    return {
      auto: {
        enabled,
        intervalMinutes,
        jitterRatio: BALANCE_SYNC_JITTER_RATIO,
        backoffCapMinutes: BALANCE_SYNC_BACKOFF_CAP_MINUTES,
      },
      lastSyncedAt: latest?.ts ?? null,
      lastTrigger: latest?.trigger ?? null,
      nextRunAt: enabled ? nextRunAt() : null,
      window: { from, to },
      upstreams,
      series,
      drift: {
        since: from,
        // counts 是**进程内累计**（`balance_drift_total{code}`），不是窗口内量 ——
        // 与 `events.dropped` 同属"本进程"口径，重启归零。
        counts: { ...driftCounts },
        alerts,
      },
    };
  }

  /** 该上游的下一次计划时刻。`0` = 还没排程（或正被一轮占用），两种情况都还没有"下一次"。 */
  function planOf(st: UpstreamState | undefined): string | null {
    if (!enabled || st === undefined || st.nextAttemptAt <= 0) return null;
    return new Date(st.nextAttemptAt).toISOString();
  }

  /** 全部上游里最早的那个计划时刻；没有上游（或都没排程）时 `null`。 */
  function nextRunAt(): string | null {
    let min = 0;
    for (const st of states.values()) {
      if (st.nextAttemptAt <= 0) continue;
      if (min === 0 || st.nextAttemptAt < min) min = st.nextAttemptAt;
    }
    return min === 0 ? null : new Date(min).toISOString();
  }

  function start(): void {
    if (started) return;
    started = true;
    stopping = false;

    // 自动同步关闭时**不注册排程定时器**（契约 §14.1）；`status` 也会回 `enabled=false` / `nextRunAt=null`。
    if (enabled) {
      void tick();
      if (withTimers) {
        tickTimer = setInterval(() => void tick(), tickMs);
        tickTimer.unref();
      }
    }

    // 裁剪与开关无关：手动刷新照样写快照。
    pruneNow();
    if (withTimers) {
      pruneTimer = setInterval(() => pruneNow(), pruneIntervalMs);
      pruneTimer.unref();
    }
  }

  function stop(): void {
    stopping = true;
    started = false;
    if (tickTimer !== null) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (pruneTimer !== null) {
      clearInterval(pruneTimer);
      pruneTimer = null;
    }
  }

  return {
    start,
    stop,
    tick,
    pruneNow,
    onRefreshDone,
    status,
    inFlightCount: countInFlight,
  };
}
