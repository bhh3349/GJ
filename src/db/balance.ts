// 余额三口径聚合（ADR-0003 / 契约 §6）。
//
// 三条不可违背的规则，在代码里的落点：
//   1. 只统计 category='balance' 的 key —— 每条 SQL 的 CASE 都带这个条件；
//   2. 全局合计 = 各上游合计之和 —— 全局**不是**另跑一条 SQL 算出来的，
//      而是把 byUpstream 的数值在 JS 里加总。让两者在结构上不可能漂移：
//      即使将来改了口径，也只有一处需要改。
//   3. 未知不得补 0 —— 合计用 SUM(已知值)，全未知时自然得 NULL 而不是 0。
//   4. 已软删的 key 不进任何合计与未知计数 —— 每个子查询都带 deleted_at IS NULL。
//
// 「未知 ≠ 0」这条是整个余额功能的信任基础：把查不到当 0，用户会以为 key 真的没钱了。

import type { Db } from './database.js';

export interface KeyBalanceEntry {
  keyId: string;
  maskedKey: string;
  balance: number | null;
  balanceUpdatedAt: string | null;
  balanceSource: string | null;
}

export interface UpstreamBalance {
  upstreamId: string;
  name: string;
  /** 分；全部未知时为 null（不是 0） */
  totalBalance: number | null;
  balanceKeyCount: number;
  balanceUnknownKeyCount: number;
  tokenPlanKeyCount: number;
  keys: KeyBalanceEntry[];
}

export interface GlobalBalance {
  totalBalance: number | null;
  balanceKeyCount: number;
  balanceUnknownKeyCount: number;
  tokenPlanKeyCount: number;
  /** 已知余额的币种；混币或全部未知时为 null */
  currency: string | null;
  byUpstream: UpstreamBalance[];
}

interface AggRow {
  upstreamId: string;
  name: string;
  balanceKeyCount: number;
  balanceUnknownKeyCount: number;
  tokenPlanKeyCount: number;
  totalBalance: number | null;
}

interface KeyRow {
  id: string;
  upstream_id: string;
  masked_key: string;
  balance_cents: number | null;
  balance_updated_at: string | null;
  balance_source: string | null;
}

const PER_UPSTREAM_SQL = `
SELECT
  u.id AS upstreamId,
  u.name AS name,
  COUNT(CASE WHEN k.category = 'balance' THEN 1 END)                                   AS balanceKeyCount,
  COUNT(CASE WHEN k.category = 'balance' AND k.balance_cents IS NULL THEN 1 END)       AS balanceUnknownKeyCount,
  COUNT(CASE WHEN k.category = 'token-plan' THEN 1 END)                                AS tokenPlanKeyCount,
  SUM(CASE WHEN k.category = 'balance' THEN k.balance_cents END)                       AS totalBalance
FROM upstreams u
LEFT JOIN upstream_keys k ON k.upstream_id = u.id AND k.deleted_at IS NULL
GROUP BY u.id, u.name
ORDER BY u.name
`;

const KEY_ROWS_SQL = `
SELECT id, upstream_id, masked_key, balance_cents, balance_updated_at, balance_source
FROM upstream_keys
WHERE deleted_at IS NULL AND category = 'balance'
ORDER BY created_at, id
`;

/**
 * 全量余额快照。单上游视角与全局视角一次算完，避免上游列表页 N+1。
 * 数据量级（几百个 key）下全表扫 + JS 分组远比 per-upstream 反复查库划算。
 */
export function computeGlobalBalance(db: Db): GlobalBalance {
  const aggRows = db.prepare(PER_UPSTREAM_SQL).all() as AggRow[];
  const keyRows = db.prepare(KEY_ROWS_SQL).all() as KeyRow[];

  const keysByUpstream = new Map<string, KeyBalanceEntry[]>();
  const currencies = new Set<string>();
  for (const r of keyRows) {
    const list = keysByUpstream.get(r.upstream_id) ?? [];
    list.push({
      keyId: r.id,
      maskedKey: r.masked_key,
      balance: r.balance_cents,
      balanceUpdatedAt: r.balance_updated_at,
      balanceSource: r.balance_source,
    });
    keysByUpstream.set(r.upstream_id, list);
  }

  // 币种单独查一次：混币时 currency 返回 null，让前端能看出"这个合计跨了币种"，
  // 而不是把一个无意义的数字当成真的总额。
  const currencyRows = db
    .prepare(
      `SELECT DISTINCT balance_currency AS c FROM upstream_keys
       WHERE deleted_at IS NULL AND category = 'balance'
         AND balance_cents IS NOT NULL AND balance_currency IS NOT NULL`,
    )
    .all() as { c: string }[];
  for (const r of currencyRows) currencies.add(r.c);

  const byUpstream: UpstreamBalance[] = aggRows.map((a) => ({
    upstreamId: a.upstreamId,
    name: a.name,
    totalBalance: a.totalBalance,
    balanceKeyCount: a.balanceKeyCount,
    balanceUnknownKeyCount: a.balanceUnknownKeyCount,
    tokenPlanKeyCount: a.tokenPlanKeyCount,
    keys: keysByUpstream.get(a.upstreamId) ?? [],
  }));

  // 规则 2：全局 = 各上游之和。逐项相加而不是重跑 SQL。
  let totalBalance: number | null = null;
  let balanceKeyCount = 0;
  let balanceUnknownKeyCount = 0;
  let tokenPlanKeyCount = 0;
  for (const u of byUpstream) {
    balanceKeyCount += u.balanceKeyCount;
    balanceUnknownKeyCount += u.balanceUnknownKeyCount;
    tokenPlanKeyCount += u.tokenPlanKeyCount;
    if (u.totalBalance !== null) totalBalance = (totalBalance ?? 0) + u.totalBalance;
  }

  return {
    totalBalance,
    balanceKeyCount,
    balanceUnknownKeyCount,
    tokenPlanKeyCount,
    currency: currencies.size === 1 ? ([...currencies][0] ?? null) : null,
    byUpstream,
  };
}

/** 单上游余额（上游详情/列表用），复用同一套口径。 */
export function computeUpstreamBalance(db: Db, upstreamId: string): UpstreamBalance | null {
  const all = computeGlobalBalance(db);
  return all.byUpstream.find((u) => u.upstreamId === upstreamId) ?? null;
}
