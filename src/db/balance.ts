// 余额三口径聚合（ADR-0003 / 契约 §6）。v1.6.0 起并入 §15 账号级第四口径。
//
// 几条不可违背的规则，在代码里的落点：
//   1. 只统计 category='balance' 的 key —— 每条 SQL 的 CASE 都带这个条件；
//   2. 全局合计 = 各上游合计之和 —— 全局**不是**另跑一条 SQL 算出来的，
//      而是把 byUpstream 的数值在 JS 里加总。让两者在结构上不可能漂移：
//      即使将来改了口径，也只有一处需要改。
//   3. 未知不得补 0 —— 合计用 SUM(已知值)，全未知时自然得 NULL 而不是 0。
//   4. 已软删的 key 不进任何合计与未知计数 —— 每个子查询都带 deleted_at IS NULL。
//   5. **同一份钱只数一次**（ADR-0018 决策 3）：上游合计
//      = Σ账号余额 + Σ**未被任何账号归属**的 key 余额。归属给账号的 key 不进 key 那一格，
//      否则"一个账号建 3 把 key"会把余额数 3 遍。归属判据见 UNOWNED_KEY。
//   6. 无限额度 ≠ 未知（ADR-0018 决策 8）：`unlimited = 1` 的 key 恒 `balance_cents IS NULL`，
//      但它**不算未知**，而是进平行的 unlimitedKeyCount。两者在 balanceKeyCount 内互不重叠。
//
// 「未知 ≠ 0」这条是整个余额功能的信任基础：把查不到当 0，用户会以为 key 真的没钱了。

import type { Db } from './database.js';

export interface KeyBalanceEntry {
  keyId: string;
  maskedKey: string;
  balance: number | null;
  balanceUpdatedAt: string | null;
  balanceSource: string | null;
  /**
   * 契约 §2「无限额度」徽标（v1.6.0 补）。
   *
   * 必须在这一层就带出来，不能只留给 §3 的 `/api/keys`：无限额度 key 的 `balance` **恒为
   * `null`**（§15.7 的落库规则），于是余额页**单独看这个端点**时，它与"还没查到余额"逐字同形。
   * 少了这一位，前端只能把无限额度 key 渲染成"未知" —— 那正是 §15.6 加 `unlimited`
   * 这一列要消灭的现象（仪表盘永久报警"有 N 把 key 余额未知"）。
   *
   * 注：它**不进** §7 的 `balance` 差分帧（帧里那把 key 从不出现在候选中，见 `live.ts` 的
   * `balanceUpdatedAt === null` 跳过），所以本字段只扩 REST 面，不动帧形状。
   */
  unlimited: boolean;
}

export interface UpstreamBalance {
  upstreamId: string;
  name: string;
  /** 分；全部未知时为 null（不是 0）。组成：`Σ账号 + Σ无账号归属 key`（§15.6） */
  totalBalance: number | null;
  balanceKeyCount: number;
  /** `category='balance' AND unlimited=0 AND balance_cents IS NULL`（§2 / §15.6） */
  balanceUnknownKeyCount: number;
  /** `balanceKeyCount` 的子集，**不额外相加、也不进未知计数**（§2） */
  unlimitedKeyCount: number;
  tokenPlanKeyCount: number;
  /** §15 账号数（通用上游恒为 0） */
  accountCount: number;
  /** 账号级余额合计，分；`null` = 无账号或全未知 */
  accountsBalance: number | null;
  accountsBalanceUnknownCount: number;
  /** `totalBalance` 里**由 key 贡献的那一半**，供前端拆解合计，不是新增的一份钱（§2） */
  keysBalance: number | null;
  keys: KeyBalanceEntry[];
}

export interface GlobalBalance {
  totalBalance: number | null;
  balanceKeyCount: number;
  balanceUnknownKeyCount: number;
  unlimitedKeyCount: number;
  tokenPlanKeyCount: number;
  accountsBalanceUnknownCount: number;
  /** 已知余额的币种；混币或全部未知时为 null */
  currency: string | null;
  byUpstream: UpstreamBalance[];
}

interface AggRow {
  upstreamId: string;
  name: string;
  balanceKeyCount: number;
  balanceUnknownKeyCount: number;
  unlimitedKeyCount: number;
  tokenPlanKeyCount: number;
  keysBalance: number | null;
}

interface AccountAggRow {
  upstreamId: string;
  accountCount: number;
  accountsBalance: number | null;
  accountsBalanceUnknownCount: number;
}

interface KeyRow {
  id: string;
  upstream_id: string;
  masked_key: string;
  balance_cents: number | null;
  balance_updated_at: string | null;
  balance_source: string | null;
  unlimited: number;
}

/**
 * 「这把 key **没有**账号归属」的判据（§15.6 / ADR-0018 决策 3）。
 *
 * 归属由 `supplier_account_keys.pooled_key_id` 这一条**台账**表达，而不是 `upstream_keys`
 * 上的一列 —— 后者在 schema 里**不存在**，且即使加出来也是同一件事的第二个事实源
 * （`countsFor()` 数 §15.1 的 keyCount 走的已经是这张台账）。ADR-0018 决策 2 里
 * "归属走 `upstream_keys.account_id`" 那句已按此订正，见契约 §15.2。
 *
 * 台账的 `pooled_key_id` **刻意无外键**（ADR-0018 决策 2）：删上游会物理删 `upstream_keys`，
 * 有外键就会把那条既定路径变成 500。所以这里用 `NOT EXISTS` 而不是 `LEFT JOIN ... IS NULL`，
 * 语义更直白，也不受行重复影响。
 */
const UNOWNED_KEY = `NOT EXISTS (
      SELECT 1 FROM supplier_account_keys sak
      WHERE sak.pooled_key_id = k.id AND sak.account_id IS NOT NULL
    )`;

const PER_UPSTREAM_SQL = `
SELECT
  u.id AS upstreamId,
  u.name AS name,
  COUNT(CASE WHEN k.category = 'balance' THEN 1 END)                                   AS balanceKeyCount,
  COUNT(CASE WHEN k.category = 'balance' AND k.unlimited = 0 AND k.balance_cents IS NULL THEN 1 END) AS balanceUnknownKeyCount,
  COUNT(CASE WHEN k.category = 'balance' AND k.unlimited = 1 THEN 1 END)               AS unlimitedKeyCount,
  COUNT(CASE WHEN k.category = 'token-plan' THEN 1 END)                                AS tokenPlanKeyCount,
  SUM(CASE WHEN k.category = 'balance' AND ${UNOWNED_KEY} THEN k.balance_cents END)    AS keysBalance
FROM upstreams u
LEFT JOIN upstream_keys k ON k.upstream_id = u.id AND k.deleted_at IS NULL
GROUP BY u.id, u.name
ORDER BY u.name
`;

/**
 * 账号级合计（§15 面）。通用上游在这张表里没有行 → `LEFT JOIN` 后 `COUNT` 恒 0、
 * `SUM` 恒 `NULL`，与 §2「通用上游 `accountCount` 恒 0 / `accountsBalance` 恒 `null`」一致，
 * 不需要在 JS 里按 supplier 分支。
 *
 * `accountsBalance` 用 `SUM(balance_cents)`：全未知时自然得 `NULL` 而不是 0（规则 3）。
 * 已软删的账号不存在（§15.2 的删账号是物理删），故无需 `deleted_at` 条件。
 */
const ACCOUNT_AGG_SQL = `
SELECT
  u.id AS upstreamId,
  COUNT(a.id)                                       AS accountCount,
  SUM(a.balance_cents)                              AS accountsBalance,
  COUNT(CASE WHEN a.id IS NOT NULL AND a.balance_cents IS NULL THEN 1 END) AS accountsBalanceUnknownCount
FROM upstreams u
LEFT JOIN supplier_accounts a ON a.upstream_id = u.id
GROUP BY u.id
`;

/**
 * `keys[]` 与 `keysBalance` 取的是**同一个集合**：未被账号归属的 balance 类 key。
 * 归属给账号的 key 不进这里 —— 它们的钱已经在账号那一格数过（决策 3），
 * 两处都列会让前端把合计拆解成双倍。
 *
 * 通用上游没有台账行，于是每条 key 都是"未归属"，`keys[]` 与加账号之前**逐字相同**。
 */
const KEY_ROWS_SQL = `
SELECT k.id, k.upstream_id, k.masked_key, k.balance_cents, k.balance_updated_at, k.balance_source, k.unlimited
FROM upstream_keys k
WHERE k.deleted_at IS NULL AND k.category = 'balance' AND ${UNOWNED_KEY}
ORDER BY k.created_at, k.id
`;

/**
 * 全量余额快照。单上游视角与全局视角一次算完，避免上游列表页 N+1。
 * 数据量级（几百个 key）下全表扫 + JS 分组远比 per-upstream 反复查库划算。
 */
export function computeGlobalBalance(db: Db): GlobalBalance {
  const aggRows = db.prepare(PER_UPSTREAM_SQL).all() as AggRow[];
  const keyRows = db.prepare(KEY_ROWS_SQL).all() as KeyRow[];
  const accountRows = db.prepare(ACCOUNT_AGG_SQL).all() as AccountAggRow[];

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
      unlimited: r.unlimited === 1,
    });
    keysByUpstream.set(r.upstream_id, list);
  }

  const accountAggByUpstream = new Map<string, AccountAggRow>();
  for (const r of accountRows) accountAggByUpstream.set(r.upstreamId, r);

  // 币种单独查一次：混币时 currency 返回 null，让前端能看出"这个合计跨了币种"，
  // 而不是把一个无意义的数字当成真的总额。
  //
  // **两个来源都要查，且判据与金额那一格逐字一致 —— 钱算一次，币种也只跟着算一次。**
  //   · 归属给账号的 key 不贡献金额（规则 1），那它的币种也不该进来：一把"账号已代表其
  //     余额"的 key 若把币种混进来，能把一个本来单币种的上游凭空判成"混币"。
  //   · 反过来，钱**全在账号上**的 TierFlow 上游必须从 `supplier_accounts` 取币种（该列
  //     存在，账号驱动器写它）。只查 key 的话，账号行里明明躺着 'CNY'，合计却报 null ——
  //     那不是"诚实的未知"，是漏查了一张表；而它偏偏发生在钱最多的那条上游上。
  const keyCurrencyRows = db
    .prepare(
      `SELECT DISTINCT k.balance_currency AS c FROM upstream_keys k
       WHERE k.deleted_at IS NULL AND k.category = 'balance'
         AND k.balance_cents IS NOT NULL AND k.balance_currency IS NOT NULL
         AND ${UNOWNED_KEY}`,
    )
    .all() as { c: string }[];
  for (const r of keyCurrencyRows) currencies.add(r.c);

  const accountCurrencyRows = db
    .prepare(
      `SELECT DISTINCT balance_currency AS c FROM supplier_accounts
       WHERE balance_cents IS NOT NULL AND balance_currency IS NOT NULL`,
    )
    .all() as { c: string }[];
  for (const r of accountCurrencyRows) currencies.add(r.c);

  const byUpstream: UpstreamBalance[] = aggRows.map((a) => {
    const acc = accountAggByUpstream.get(a.upstreamId);
    return {
      upstreamId: a.upstreamId,
      name: a.name,
      // 规则 4：合计 = 账号那一格 + 未归属 key 那一格。两格都未知才是未知。
      totalBalance: addNullable(a.keysBalance, acc?.accountsBalance ?? null),
      balanceKeyCount: a.balanceKeyCount,
      balanceUnknownKeyCount: a.balanceUnknownKeyCount,
      unlimitedKeyCount: a.unlimitedKeyCount,
      tokenPlanKeyCount: a.tokenPlanKeyCount,
      accountCount: acc?.accountCount ?? 0,
      accountsBalance: acc?.accountsBalance ?? null,
      accountsBalanceUnknownCount: acc?.accountsBalanceUnknownCount ?? 0,
      keysBalance: a.keysBalance,
      keys: keysByUpstream.get(a.upstreamId) ?? [],
    };
  });

  // 规则 2：全局 = 各上游之和。逐项相加而不是重跑 SQL。
  let totalBalance: number | null = null;
  let balanceKeyCount = 0;
  let balanceUnknownKeyCount = 0;
  let unlimitedKeyCount = 0;
  let tokenPlanKeyCount = 0;
  let accountsBalanceUnknownCount = 0;
  for (const u of byUpstream) {
    balanceKeyCount += u.balanceKeyCount;
    balanceUnknownKeyCount += u.balanceUnknownKeyCount;
    unlimitedKeyCount += u.unlimitedKeyCount;
    tokenPlanKeyCount += u.tokenPlanKeyCount;
    accountsBalanceUnknownCount += u.accountsBalanceUnknownCount;
    if (u.totalBalance !== null) totalBalance = (totalBalance ?? 0) + u.totalBalance;
  }

  return {
    totalBalance,
    balanceKeyCount,
    balanceUnknownKeyCount,
    unlimitedKeyCount,
    tokenPlanKeyCount,
    accountsBalanceUnknownCount,
    currency: currencies.size === 1 ? ([...currencies][0] ?? null) : null,
    byUpstream,
  };
}

/**
 * `a + b`，但 `null` 是「未知」不是 0（规则 3）：只有两边都未知才是未知，
 * 一边未知时不得把另一边当成总数的一部分以外的任何东西。
 */
function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** 单上游余额（上游详情/列表用），复用同一套口径。 */
export function computeUpstreamBalance(db: Db, upstreamId: string): UpstreamBalance | null {
  const all = computeGlobalBalance(db);
  return all.byUpstream.find((u) => u.upstreamId === upstreamId) ?? null;
}
