// 余额刷新（契约 §2 / §3）：把模板引擎接进异步任务系统。
//
// 本文件是**唯一**会把 key 明文交给网络的地方，所以纪律写在这里：
//   - 明文只在 refreshBalances 的栈内存在，随本次调用结束即被回收；
//   - 明文不参与任何日志、不写审计 detail、不进任务 result（result 只放计数）；
//   - 单把 key 失败只记它自己的失败，不影响同批其它 key（批量刷新里一把 key 查不到
//     不该让剩下 50 把的进度一起丢掉）。
//
// 并发跑上游查询是必须的（几十把 key 串行会拖到分钟级），但也不能不限并发 ——
// 并发拉满等于对上游做一次小型 DDoS，还会触发对方限流，把本来能成功的查询也打成失败。

import type { Db } from '../../db/database.js';
import { assertUsable, normalizeBalanceQuery, type BalanceQueryTemplate } from '../../db/balance-query.js';
import {
  applyTemplateBalance,
  applyTemplateTokenPlan,
  decryptedKeyRefs,
  type DecryptedKeyRef,
} from '../../db/repo/keys.js';
import { getUpstreamRow } from '../../db/repo/upstreams.js';
import { ApiError } from '../errors.js';
import { queryBalance, type QueryOutcome, type QueryTarget } from '../../balance/template.js';
import type { TaskReporter } from '../task-runner.js';

/** 同时最多打几个上游请求。够快，又不至于把对方限流触发出来。 */
const CONCURRENCY = 4;

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
  /** 上游没有可用的查询模板，压根没发起请求。与"失败"分开计数，别把没做的事算成做砸了 */
  skipped: number;
}

type Attempt = { kind: 'query'; outcome: QueryOutcome } | { kind: 'skipped' };

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

/**
 * 取该上游的可用模板。
 *
 * `enabled=false` 是**业务拒绝**（该上游只允许手动录入），不是参数错 —— 所以抛
 * UNPROCESSABLE 而不是 INVALID_PARAM，前端一眼能看出"这不是我填错了"。
 */
export function loadUsableTemplate(db: Db, upstreamId: string): BalanceQueryTemplate {
  const row = getUpstreamRow(db, upstreamId);
  if (!row) throw ApiError.notFound('上游', upstreamId);
  const template = normalizeBalanceQuery(JSON.parse(row.balance_query) as unknown);
  if (!template.enabled) {
    throw new ApiError('UNPROCESSABLE', '该上游未启用余额查询模板，只能手动录入余额');
  }
  assertUsable(template);
  return template;
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
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshSummary> {
  const refs = decryptedKeyRefs(db, scope, masterKey);
  reporter.setTotal(refs.length);

  // 模板按上游缓存；缓存里存 null 表示"这个上游用不了模板"，与"还没查过"区分开
  const templates = new Map<string, BalanceQueryTemplate | null>();

  const attempts = await mapLimit<DecryptedKeyRef, Attempt>(refs, CONCURRENCY, async (ref) => {
    let template = templates.get(ref.upstreamId);
    if (template === undefined) {
      try {
        template = loadUsableTemplate(db, ref.upstreamId);
      } catch {
        template = null;
      }
      templates.set(ref.upstreamId, template);
    }
    if (template === null) {
      reporter.step();
      return { kind: 'skipped' };
    }

    const target: QueryTarget = {
      keyId: ref.keyId,
      maskedKey: ref.maskedKey,
      decrypted: ref.decrypted,
    };
    const outcome = await queryBalance(template, target, fetchImpl);
    applyOutcome(db, ref, outcome);
    reporter.step();
    return { kind: 'query', outcome };
  });

  return summarize(attempts);
}

/** 查询结果落库。金额只写 balance 类 key，余量只写 token-plan 类 key。 */
function applyOutcome(db: Db, ref: DecryptedKeyRef, outcome: QueryOutcome): void {
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
  for (const a of attempts) {
    if (a.kind === 'skipped') {
      skipped += 1;
      continue;
    }
    const o = a.outcome;
    if (!o.ok) {
      failed += 1;
      continue;
    }
    ok += 1;
    // 解析成功但金额/余量缺失 = 未知。这里必须与"失败"分开计数：
    // 上游改了字段名时，表现就是"全部成功但全部未知"，那和"上游挂了"是两回事。
    if (o.parsed === null || (o.parsed.balanceCents === null && o.parsed.remainingTokens === null)) {
      unknown += 1;
    }
  }
  return { checked: attempts.length, ok, failed, unknown, skipped };
}
