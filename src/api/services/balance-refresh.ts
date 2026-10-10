// 余额刷新（契约 §2 / §3）：把余额查询接进异步任务系统。
//
// 本文件是**唯一**会把 key 明文交给网络的地方，所以纪律写在这里：
//   - 明文只在 refreshBalances 的栈内存在，随本次调用结束即被回收；
//   - 明文不参与任何日志、不写审计 detail、不进任务 result（result 只放计数）；
//   - 单把 key 失败只记它自己的失败，不影响同批其它 key（批量刷新里一把 key 查不到
//     不该让剩下 50 把的进度一起丢掉）。
//
// 并发跑上游查询是必须的（几十把 key 串行会拖到分钟级），但也不能不限并发 ——
// 并发拉满等于对上游做一次小型 DDoS，还会触发对方限流，把本来能成功的查询也打成失败。
//
// 「用哪条路查」不在本文件判断：那是 balance-query.ts 的三段解析（模板 → preset → 无）。
// 刷新与自测共用它，两边的结论才是同源的。

import type { Db } from '../../db/database.js';
import {
  applyTemplateBalance,
  applyTemplateTokenPlan,
  decryptedKeyRefs,
  type DecryptedKeyRef,
} from '../../db/repo/keys.js';
import type { QueryTarget } from '../../balance/template.js';
import type { HintCode } from '../dto.js';
import {
  assertQueryable,
  executePlan,
  hintForSummary,
  hintText,
  type QueryExecution,
  type QueryPlan,
} from './balance-query.js';
import type { TaskReporter } from '../task-runner.js';

/**
 * 同时最多打几个上游请求。够快，又不至于把对方限流触发出来。
 *
 * **导出是给自动同步用的**：调度器限制"同时几个上游在跑"时要复用这个数，
 * 而不是另拍一个 —— 两处各有一个并发上限，早晚会漂成"同一次余额查询，
 * 手动刷新打 4 个、自动同步打 12 个"，而症状只是上游那边偶尔 429。
 */
export const REFRESH_CONCURRENCY = 4;
const CONCURRENCY = REFRESH_CONCURRENCY;

export interface RefreshScope {
  upstreamId?: string | undefined;
  keyIds?: readonly string[] | undefined;
}

export interface RefreshSummary {
  checked: number;
  ok: number;
  failed: number;
  /** 查得到但响应里没有金额 —— 契约口径：这是"未知"，不是 0 */
  unknown: number;
  /** 上游没有可用的查询方式，压根没发起请求。与"失败"分开计数，别把没做的事算成做砸了 */
  skipped: number;
  /**
   * 给前端的一句引导（ADR-0012 §4）。**不是错误码**：不进 `ERROR_CODES`、
   * 不影响 HTTP 状态、不影响 `202` 任务本身的成败 —— 它只回答"接下来该做什么"。
   */
  hintCode: HintCode | null;
  hint: string | null;
  /**
   * 本轮本地出口拒绝带回的最大 `Retry-After`（整数秒 ≥1；`null` = 无建议）。
   * 多个本地拒绝取**最大**（对调用方唯一有用的那个等待量；ADR-0017 清单 #16 / 契约 v1.8.1）。
   * 上游真 429 不产生该值 —— 值只来自本地拒绝（`fetch-gate` 合成响应头），不按来源分型。
   */
  retryAfterSeconds: number | null;
}

/**
 * 该上游本轮各型计数。**只为收尾钩子**（写快照 / 退避归零 / 漂移判定）而存在：
 * 对外返回的 `RefreshSummary` 形状按契约 §3 增补可选 `retryAfterSeconds`（v1.8.1，非破坏新增）。
 */
export interface UpstreamRefreshResult {
  upstreamId: string;
  checked: number;
  /** 请求成功数（2xx，**含**取不到金额的那些） */
  ok: number;
  failed: number;
  unknown: number;
  skipped: number;
  /**
   * 本轮 429 数（ADR-0017 补遗 2）：**判据 = `httpStatus === 429` 本身**，
   * 不看标记头 —— 上游真 429 与本地合成的 429（闸接线后由装饰器合成）**归同一行**。
   * 只穿**内部**的收尾汇总类型（§14.1 判据③ / §14.4 前置的判据输入），**不出 REST 面**，
   * §14.2 的三型计数口径零变更。
   */
  rateLimited: number;
}

/** 一轮刷新收尾时交给钩子的东西。`trigger` 与 `wholeUpstream` 由本函数保证，调用方不必自证。 */
export interface RefreshDone {
  /** 本轮完成时刻（= 快照的 `ts` / 上游级 `asOf`） */
  at: string;
  trigger: 'auto' | 'manual';
  /**
   * 本轮是否**覆盖了整个上游**：`scope.keyIds === undefined` 才是。
   *
   * 判据刻意只看"有没有给 key 列表"，不去证明"给的列表正好是全部 key" ——
   * 后者要么多查一次库、要么在 key 增删的竞态里给出错答案，而错的代价是
   * **造出一条半新半旧的假快照**（比缺一个点坏得多）。保守判定在这里是免费的。
   */
  wholeUpstream: boolean;
  /** 本轮有 key 参与的上游（顺序 = 上游首次出现顺序） */
  upstreams: readonly UpstreamRefreshResult[];
}

export interface RefreshOptions {
  /**
   * 出站 fetch。**必填、无兜底**（ADR-0021 决策 4c「8 处 fetchImpl 兜底全拆」）。
   *
   * 原为 `options.fetchImpl ?? fetch`：那正是"外层注入了闸包装、内层静默回落全局 fetch"
   * 的那一类 —— 接线看起来改了，流量照旧绕开闸，且**没有任何报错**。
   * 现在漏传 = 编译错误；生产值由 `buildApp` 一处解析（`ApiContext.supplier.fetchImpl`）。
   */
  fetchImpl: typeof fetch;
  /**
   * 触发方。只影响快照行的 `trigger` 列与它在同步状态里的归类，
   * **不改变任何刷新行为** —— 三个手动端点的语义零变更（契约 §14.1）。
   */
  trigger?: 'auto' | 'manual' | undefined;
  /**
   * 刷新收尾钩子：本轮只要有 key 参与就调一次（快照 / 退避 / 漂移接在这里）。
   *
   * **实现方必须自己吞掉异常**：钩子抛出去会把一次刷新结果正常的任务标成 `failed`
   * （快照写失败 ≠ 余额刷新失败），那是把两件事混成一件。本函数不做静默兜底。
   */
  onUpstreamDone?: ((done: RefreshDone) => void) | undefined;
}

type Attempt =
  | { upstreamId: string; kind: 'query'; outcome: QueryExecution }
  | { upstreamId: string; kind: 'skipped' };


/** 待刷新 key 的条数。路由在起任务前用它填 progress.total，避免前端看到 0/0。 */
export function countRefreshableKeys(db: Db, scope: RefreshScope): number {
  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (scope.upstreamId !== undefined) {
    where.push('upstream_id = ?');
    params.push(scope.upstreamId);
  }
  if (scope.keyIds !== undefined && scope.keyIds.length > 0) {
    where.push(`id IN (${scope.keyIds.map(() => '?').join(', ')})`);
    params.push(...scope.keyIds);
  }
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM upstream_keys WHERE ${where.join(' AND ')}`).get(...params) as {
      n: number;
    }
  ).n;
}

/** 有限并发的 map。保持输入顺序，便于把结果与 key 一一对上。 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      const item = items[i];
      if (item === undefined) return;
      out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 执行一次刷新。传入的 reporter 由任务系统提供，进度**只在这里推进**。
 *
 * 任何一把 key 查询失败都不会抛出去：任务失败会让前端丢掉整批结果，
 * 而"3 把成功 1 把超时"恰恰是最常见的情况，应当正常收尾并如实汇报。
 * 同理，上游没配模板时把它算作 `skipped` 而不是 `failed` —— 没做的事不能算成做砸了。
 */
export async function refreshBalances(
  db: Db,
  masterKey: Buffer,
  scope: RefreshScope,
  reporter: TaskReporter,
  options: RefreshOptions,
): Promise<RefreshSummary> {
  const fetchImpl = options.fetchImpl;
  const refs = decryptedKeyRefs(db, scope, masterKey);
  reporter.setTotal(refs.length);

  // 查询计划按上游缓存；缓存里存 null 表示"这个上游没有可用的查询方式"，
  // 与"还没查过"区分开 —— 否则每个 key 都会去解析一次（虽然便宜，但会掩盖真错误）。
  const plans = new Map<string, Extract<QueryPlan, { kind: 'template' | 'preset' }> | null>();

  const attempts = await mapLimit<DecryptedKeyRef, Attempt>(refs, CONCURRENCY, async (ref) => {
    let plan = plans.get(ref.upstreamId);
    if (plan === undefined) {
      try {
        plan = assertQueryable(db, ref.upstreamId);
      } catch {
        // 上游被删掉、或压根没配查询方式：都表现为"这次不查"，不是"查砸了"
        plan = null;
      }
      plans.set(ref.upstreamId, plan);
    }
    if (plan === null) {
      reporter.step();
      return { upstreamId: ref.upstreamId, kind: 'skipped' };
    }

    const target: QueryTarget = {
      keyId: ref.keyId,
      maskedKey: ref.maskedKey,
      decrypted: ref.decrypted,
    };
    // 批量刷新不采集上游原文：省内存，也少一处明文可能外溢的面。
    // 要看得见响应原文，走自测端点（那边 captureRaw 打开）。
    const outcome = await executePlan(plan, target, fetchImpl);
    applyOutcome(db, ref, outcome);
    reporter.step();
    return { upstreamId: ref.upstreamId, kind: 'query', outcome };
  });

  const summary = summarize(attempts);

  // 收尾钩子：快照、退避、漂移全在这里接上。刻意放在**刷新已经全部落库之后** ——
  // 快照记的是"此刻的状态"，必须先让本轮的值真的写进 upstream_keys。
  const hook = options.onUpstreamDone;
  if (hook !== undefined) {
    const perUpstream = groupByUpstream(attempts);
    if (perUpstream.length > 0) {
      hook({
        at: new Date().toISOString(),
        trigger: options.trigger ?? 'manual',
        // 只看"有没有给 key 列表"：给了就是部分刷新，快照宁缺勿假（详见 RefreshDone）。
        wholeUpstream: scope.keyIds === undefined,
        upstreams: perUpstream,
      });
    }
  }

  return summary;
}

/** 按上游聚合本轮计数，保持上游首次出现的顺序（结果可预期，测试不必排序）。 */
function groupByUpstream(attempts: readonly Attempt[]): UpstreamRefreshResult[] {
  const acc = new Map<string, UpstreamRefreshResult>();
  for (const a of attempts) {
    const item = acc.get(a.upstreamId) ?? {
      upstreamId: a.upstreamId,
      checked: 0,
      ok: 0,
      failed: 0,
      unknown: 0,
      skipped: 0,
      rateLimited: 0,
    };
    item.checked += 1;
    if (a.kind === 'skipped') {
      item.skipped += 1;
    } else if (!a.outcome.ok) {
      item.failed += 1;
      // 补遗 3「实现落点」1：与 summarize 的旁路计数**同源同值、各自独立** ——
      // 一个进收尾汇总类型（判据用），一个出 hint（`hintForSummary` 用），不得并成一个字段。
      if (a.outcome.httpStatus === 429) item.rateLimited += 1;
    } else {
      item.ok += 1;
      // 与 summarize 同一条判据：请求成功但拿不到数 = 未知，不是失败也不是成功
      if (a.outcome.parsed === null || (a.outcome.parsed.balanceCents === null && a.outcome.parsed.remainingTokens === null)) {
        item.unknown += 1;
      }
    }
    acc.set(a.upstreamId, item);
  }
  return [...acc.values()];
}


/** 查询结果落库。金额只写 balance 类 key，余量只写 token-plan 类 key。 */
function applyOutcome(db: Db, ref: DecryptedKeyRef, outcome: QueryExecution): void {
  if (!outcome.ok || outcome.parsed === null) return;

  if (ref.category === 'balance') {
    // C5：手动录入不设保护，模板值照样覆盖；覆盖后 balanceSource 变成 template，
    // 前端据此标注数据来源可信度。
    applyTemplateBalance(db, ref.keyId, {
      balanceCents: outcome.parsed.balanceCents,
      currency: outcome.parsed.currency,
      remainingTokens: null,
      expiresAt: null,
    });
    return;
  }

  applyTemplateTokenPlan(db, ref.keyId, {
    remainingTokens: outcome.parsed.remainingTokens,
    expiresAt: outcome.parsed.expiresAt,
  });
}

function summarize(attempts: readonly Attempt[]): RefreshSummary {
  let ok = 0;
  let failed = 0;
  let unknown = 0;
  let skipped = 0;
  // 只服务于 hint：不参与任何计数口径（契约明确"三型计数逐字不变"）。
  let authRejected = 0;
  // 第 5 个旁路计数（ADR-0017 补遗 3「实现落点」1）：与 `authRejected` 同处现算、同样不进三型口径。
  // `retryAfterSeconds` 同族旁路面：只由**本地**拒绝带值（`QueryOutcome.retryAfterSeconds`），
  // 多个本地拒绝取最大（§3 v1.8.1：对调用方唯一有用的等待量）。
  let retryAfterSeconds: number | null = null;
  // 与补遗 2 那个进 `UpstreamRefreshResult` 的 `rateLimited` **同源同值、各自独立** ——
  // 一个不出 REST 面（收尾钩子用），一个要出（hint 用），不得并成一个对外字段。
  let rateLimited = 0;
  for (const a of attempts) {
    if (a.kind === 'skipped') {
      skipped += 1;
      continue;
    }
    const o = a.outcome;
    if (!o.ok) {
      failed += 1;
      if (o.httpStatus === 401 || o.httpStatus === 403) authRejected += 1;
      // 429 一行通吃：判据是状态码本身，不看标记头（上游真 429 与本地合成的 429 同归这一档）。
      if (o.httpStatus === 429) rateLimited += 1;
      const secs = o.retryAfterSeconds;
      if (secs !== null && (retryAfterSeconds === null || secs > retryAfterSeconds)) retryAfterSeconds = secs;
      continue;
    }
    ok += 1;
    // 解析成功但金额/余量缺失 = 未知。这里必须与"失败"分开计数：
    // 上游改了字段名时，表现就是"全部成功但全部未知"，那和"上游挂了"是两回事。
    if (o.parsed === null || (o.parsed.balanceCents === null && o.parsed.remainingTokens === null)) {
      unknown += 1;
    }
  }
  const hintCode = hintForSummary({ failed, unknown, skipped, authRejected, rateLimited });
  return {
    checked: attempts.length,
    ok,
    failed,
    unknown,
    skipped,
    hintCode,
    hint: hintCode === null ? null : hintText(hintCode),
    // 非空 ⇒ 429 引导硬要求""等多久要说得出来""（契约 §2 v1.8.1）
    retryAfterSeconds,
  };
}
