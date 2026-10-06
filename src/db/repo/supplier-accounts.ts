// 供应商账号仓储。契约 §15。
//
// **本文件只覆盖「不需要打上游管理接口」的那一半**，且这是刻意的：11 个端点里
// import / refresh / login / keys / keys/sync 全都要打上游，而 §16.1.1 那件
// 「数据面路径与协议」的悬空件还没收口。先把这一半立稳，前端就能对着
// **真实（可能为空的）**数据建表格与对账表，而不是对着 mock 建完再返工一遍。
//
// 于是这里有**三条**路径：读面（列表 / 详情 / 扁平淡餐 / 导出）、
// 按台账判据的 `countPooledKeys`、以及 `deleteSupplierAccount`（删本地行 + 解绑，
// **不发任何上游请求** —— 它是本期唯一能在离线环境下测完整的写路径）。
//
// 凭据纪律（比 groups.ts 更严一档）：
//   本文件**从不 SELECT 那两个 BLOB**。`credentialSource` / `hasSession` 都是问
//   `encrypted_password IS NOT NULL` 得来的 —— 判"有没有"根本不需要密文，
//   于是密文连进程都进不来。这不是优化，是把"密文只在写路径里出现"变成结构事实。
//
// 一个推导出来的坑，写在最前面：`credentialSource` **不是库里的一列**。
// 契约 §15.1 要求它和 `hasSession` 正交，所以两路凭据必须分列存；
// 一列存不下「有密码 + 当前无会话」这个合法态，而那个态恰恰是自动重登的触发条件。

import type {
  Page,
  SupplierAccountDto,
  SupplierAccountStatus,
  SupplierSubscriptionDto,
  SupplierSubscriptionRowDto,
} from '../../api/dto.js';
import { ApiError } from '../../api/errors.js';
import type { Db } from '../database.js';

/**
 * 账号行。**注意这里刻意没有 `encrypted_password` / `encrypted_session`** ——
 * 取的是两个布尔，不是两个 BLOB（见文件头）。BLOB 真加进来，
 * 这个类型就成了唯一一个"手里握着全部账号凭据密文"的类型，谁 import 它谁就沾上。
 */
interface AccountRow {
  id: string;
  upstream_id: string;
  supplier: string;
  identifier: string;
  username: string | null;
  uid: string | null;
  has_password: number;
  has_session: number;
  session_expires_at: string | null;
  status: string;
  status_message: string | null;
  balance_cents: number | null;
  balance_updated_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

/** 每账号的三个**派生**计数（§15.1）。`unlimitedKeyCount` 是 `keyCount` 的子集，不相加。 */
interface KeyCounts {
  keyCount: number;
  unlimitedKeyCount: number;
  maskedKeyCount: number;
}

const ZERO_COUNTS: KeyCounts = { keyCount: 0, unlimitedKeyCount: 0, maskedKeyCount: 0 };

interface SubscriptionRow {
  sub_no: string;
  plan_title: string | null;
  plan_slug: string | null;
  amount_total_cents: number | null;
  amount_used_cents: number | null;
  paid_cents: number | null;
  basic_token_total: number | null;
  basic_token_used: number | null;
  status: string | null;
  source: string | null;
  start_at: string | null;
  end_at: string | null;
  auto_renew: number | null;
  has_key: number;
  key_masked: string | null;
  updated_at: string;
}

/**
 * 账号的**公开列**，单独常量而不是 `SELECT *`。
 *
 * 两个理由：一是 `SELECT *` 会把两个凭据 BLOB 拉进进程（上面那条纪律就废了），
 * 二是将来加列时，`SELECT *` 会让新列**静默**出现在这里、`SELECT` 常量则会把它挡在门外 ——
 * 一个默认拒绝、一个默认放行，凭据面永远该选前者。
 */
const ACCOUNT_COLS = `
  id, upstream_id, supplier, identifier, username, uid, status, status_message,
  balance_cents, balance_updated_at, session_expires_at, revision, created_at, updated_at,
  (encrypted_password IS NOT NULL) AS has_password,
  (encrypted_session  IS NOT NULL) AS has_session
`;

function placeholders(n: number): string {
  // n 由调用方保证 ≥ 1：空数组拼出 `IN ()` 是语法错误，不是空集。
  return new Array(n).fill('?').join(', ');
}

/**
 * 一批账号的三个计数。**一次查询算完整页**，不是每账号三次 ——
 * 验收线是「响应 < 100ms」，而这是唯一一处随 pageSize（上限 200）线性放大的地方。
 */
function countsFor(db: Db, accountIds: string[]): Map<string, KeyCounts> {
  const out = new Map<string, KeyCounts>();
  if (accountIds.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT k.account_id AS accountId,
              SUM(CASE WHEN k.pooled_key_id IS NOT NULL AND uk.deleted_at IS NULL
                       THEN 1 ELSE 0 END) AS keyCount,
              SUM(CASE WHEN k.pooled_key_id IS NOT NULL AND uk.deleted_at IS NULL AND uk.unlimited = 1
                       THEN 1 ELSE 0 END) AS unlimitedKeyCount,
              SUM(CASE WHEN k.pooled_key_id IS NULL THEN 1 ELSE 0 END) AS maskedKeyCount
       FROM supplier_account_keys k
       LEFT JOIN upstream_keys uk ON uk.id = k.pooled_key_id
       WHERE k.account_id IN (${placeholders(accountIds.length)})
       GROUP BY k.account_id`,
    )
    .all(...accountIds) as ({ accountId: string } & KeyCounts)[];

  for (const r of rows) {
    out.set(r.accountId, {
      keyCount: r.keyCount,
      unlimitedKeyCount: r.unlimitedKeyCount,
      maskedKeyCount: r.maskedKeyCount,
    });
  }
  return out;
}

/** 一批账号的套餐。**恒为数组**：没有套餐就是 `[]`，不是 `null`、也不是缺键（§15.1）。 */
function subscriptionsFor(db: Db, accountIds: string[]): Map<string, SupplierSubscriptionDto[]> {
  const out = new Map<string, SupplierSubscriptionDto[]>();
  if (accountIds.length === 0) return out;

  // 排序固定 `updated_at DESC, id`：契约没规定套餐顺序，但**列表与详情必须同序** ——
  // 不定序的话，同一个账号在两条路径上会给出不同顺序的数组，前端比对时会以为数据变了。
  const rows = db
    .prepare(
      `SELECT account_id AS accountId, sub_no, plan_title, plan_slug,
              amount_total_cents, amount_used_cents, paid_cents,
              basic_token_total, basic_token_used,
              status, source, start_at, end_at, auto_renew, has_key, key_masked, updated_at
       FROM supplier_account_subscriptions
       WHERE account_id IN (${placeholders(accountIds.length)})
       ORDER BY updated_at DESC, id`,
    )
    .all(...accountIds) as ({ accountId: string } & SubscriptionRow)[];

  for (const r of rows) {
    const list = out.get(r.accountId) ?? [];
    list.push(toSubscriptionDto(r));
    out.set(r.accountId, list);
  }
  return out;
}

/**
 * 套餐行 → DTO。**抽出来单独一个函数**是因为它有两个调用方（账号的 `subscriptions[]`
 * 与扁平套餐列表），而 `autoRenew` 那个三态转换一旦只在其中一处写对，另一处就会把
 * "上游没给这个字段"（`null`）静默压成 `false` —— 替供应商下结论，且两边看起来都对。
 */
function toSubscriptionDto(r: SubscriptionRow): SupplierSubscriptionDto {
  return {
    subNo: r.sub_no,
    planTitle: r.plan_title,
    planSlug: r.plan_slug,
    amountTotalCents: r.amount_total_cents,
    amountUsedCents: r.amount_used_cents,
    paidCents: r.paid_cents,
    basicTokenTotal: r.basic_token_total,
    basicTokenUsed: r.basic_token_used,
    status: r.status,
    source: r.source,
    startAt: r.start_at,
    endAt: r.end_at,
    // 三态：0/1 转 bool，NULL 保持 null（＝上游没给这个字段，不是 false）
    autoRenew: r.auto_renew === null ? null : r.auto_renew === 1,
    hasKey: r.has_key === 1,
    keyMasked: r.key_masked,
    updatedAt: r.updated_at,
  };
}

function toDto(
  row: AccountRow,
  counts: KeyCounts,
  subscriptions: SupplierSubscriptionDto[],
): SupplierAccountDto {
  return {
    id: row.id,
    upstreamId: row.upstream_id,
    supplier: row.supplier,
    identifier: row.identifier,
    username: row.username,
    uid: row.uid,
    status: row.status as SupplierAccountStatus,
    statusMessage: row.status_message,
    balanceCents: row.balance_cents,
    balanceUpdatedAt: row.balance_updated_at,
    keyCount: counts.keyCount,
    unlimitedKeyCount: counts.unlimitedKeyCount,
    maskedKeyCount: counts.maskedKeyCount,
    subscriptions,
    // 有存档密码就是 password（密码是超集能力：有密码就一定能登，§15.9）。
    // 两列全空的行被 DDL 的 CHECK 挡住，所以这里不必再有第三个分支 ——
    // 真要有了，那是约束被绕过，不是这里该兜的情况。
    credentialSource: row.has_password === 1 ? 'password' : 'session',
    hasSession: row.has_session === 1,
    sessionExpiresAt: row.session_expires_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ListSupplierAccountsQuery {
  upstreamId?: string | undefined;
  status?: string | undefined;
  /** 模糊匹配**掩码后的** identifier / username / uid —— 真值不在库里，也没法拿它搜 */
  q?: string | undefined;
  page: number;
  pageSize: number;
}

/** 契约 §15.2 `GET /api/supplier-accounts`。 */
export function listSupplierAccounts(
  db: Db,
  query: ListSupplierAccountsQuery,
): Page<SupplierAccountDto> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.upstreamId !== undefined && query.upstreamId !== '') {
    where.push('upstream_id = ?');
    params.push(query.upstreamId);
  }
  if (query.status !== undefined && query.status !== '') {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.q !== undefined && query.q !== '') {
    // 转义 LIKE 的通配符：不转义的话，用户搜 `_` 会匹配到任意单字符 ——
    // 一个"搜了没搜到"的假阴性，比报错难查得多（同 listGroups 的口径）。
    const like = `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push('(identifier LIKE ? ESCAPE ? OR username LIKE ? ESCAPE ? OR uid LIKE ? ESCAPE ?)');
    params.push(like, '\\', like, '\\', like, '\\');
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM supplier_accounts ${clause}`).get(...params) as {
    n: number;
  }).n;

  const rows = db
    .prepare(
      `SELECT ${ACCOUNT_COLS} FROM supplier_accounts ${clause}
       ORDER BY created_at DESC, id LIMIT ? OFFSET ?`,
    )
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as AccountRow[];

  const ids = rows.map((r) => r.id);
  const counts = countsFor(db, ids);
  const subs = subscriptionsFor(db, ids);

  return {
    items: rows.map((r) => toDto(r, counts.get(r.id) ?? ZERO_COUNTS, subs.get(r.id) ?? [])),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * 契约 §15.2 `GET /api/supplier-accounts/:id`。
 *
 * 与列表**共用** `ACCOUNT_COLS` / `toDto` / 两个批量函数（传单元素数组）：
 * 详情与列表项的形状由契约钉成同一个 `SupplierAccount`，两条查询路径分开写，
 * 迟早会出现"列表里有的字段详情里没有"这种只在某一页上暴露的差异。
 */
export function getSupplierAccount(db: Db, id: string): SupplierAccountDto | null {
  const row = db
    .prepare(`SELECT ${ACCOUNT_COLS} FROM supplier_accounts WHERE id = ?`)
    .get(id) as AccountRow | undefined;
  if (!row) return null;

  const counts = countsFor(db, [row.id]).get(row.id) ?? ZERO_COUNTS;
  const subs = subscriptionsFor(db, [row.id]).get(row.id) ?? [];
  return toDto(row, counts, subs);
}

/** 路由用的抛错版：`null` 与"不存在"的二义性不留给调用方。 */
export function requireSupplierAccount(db: Db, id: string): SupplierAccountDto {
  const found = getSupplierAccount(db, id);
  if (!found) throw ApiError.notFound('供应商账号', id);
  return found;
}

/**
 * 契约 §15.2 `GET /api/supplier-accounts/export` 的数据面 —— **全量、不分页**。
 *
 * 不分页是刻意的：对账表分页导出**就是错的**（拿到的"账号总数"取决于导出时点了第几页）。
 * 账号面是"人手动导入"的规模（当前个位数到几十），一次全量是安全的；
 * 它与 `listSupplierAccounts` 共用 `ACCOUNT_COLS` / `toDto` / 两个批量函数 ——
 * 导出另写一条 query，迟早出现"表里的余额和页面上的余额不一样"这种只在导出的那份上暴露的差异，
 * 而它偏偏是拿去对账的那一份。
 */
export function listAllSupplierAccounts(db: Db, upstreamId?: string): SupplierAccountDto[] {
  const params: unknown[] = [];
  let clause = '';
  if (upstreamId !== undefined && upstreamId !== '') {
    clause = 'WHERE upstream_id = ?';
    params.push(upstreamId);
  }

  const rows = db
    .prepare(
      `SELECT ${ACCOUNT_COLS} FROM supplier_accounts ${clause}
       ORDER BY created_at DESC, id`,
    )
    .all(...params) as AccountRow[];

  const ids = rows.map((r) => r.id);
  const counts = countsFor(db, ids);
  const subs = subscriptionsFor(db, ids);
  return rows.map((r) => toDto(r, counts.get(r.id) ?? ZERO_COUNTS, subs.get(r.id) ?? []));
}

/** 同一上游内按真值摘要判重（§15.9「一个账号只建一行」的判据）。写路径会用。 */
export function findSupplierAccountByIdentifierHash(
  db: Db,
  upstreamId: string,
  identifierHash: string,
): { id: string } | null {
  return (
    (db
      .prepare('SELECT id FROM supplier_accounts WHERE upstream_id = ? AND identifier_hash = ?')
      .get(upstreamId, identifierHash) as { id: string } | undefined) ?? null
  );
}

export interface ListSubscriptionsQuery {
  upstreamId?: string | undefined;
  page: number;
  pageSize: number;
}

/**
 * 契约 §15.2 `GET /api/supplier-accounts/subscriptions` —— **跨账号**的扁平套餐列表。
 *
 * 与 §15.1 详情里那个 `subscriptions[]` 的关系：那条是"这个账号有哪些套餐"（嵌套、两级表格），
 * 这条是"这堆账号的套餐排在一起看"（对账：接下来谁到期）。**同一份数据、两个切面**，
 * 所以字段形状**复用** `SupplierSubscriptionDto`，只在外面补三个归属字段 ——
 * 扁平列表里没有归属的 `subNo` 是一串没有主语的编号。
 *
 * 排序按 `end_at`（即将到期的在前），而不是列表面惯用的 `updated_at DESC`：这个端点的用途
 * 就是看"接下来谁到期"，按更新时间排会把一个下月到期、昨天刚刷新过的套餐顶到最前面。
 * `NULLS` 处理放在排序键的第一项上（`(end_at IS NULL)`）：SQLite 把 `NULL` 当最小值，
 * 不额外处理的话"没有到期时间"的会全部排到**最前**，把真正快到期的挤出首页。
 * 末位用 `id` 兜底，保证排序是全序 —— 不定序时同一页在两次请求里可能给出不同行。
 */
export function listSupplierSubscriptions(
  db: Db,
  query: ListSubscriptionsQuery,
): Page<SupplierSubscriptionRowDto> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.upstreamId !== undefined && query.upstreamId !== '') {
    where.push('a.upstream_id = ?');
    params.push(query.upstreamId);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM supplier_account_subscriptions s
                JOIN supplier_accounts a ON a.id = s.account_id
                ${clause}`;

  const total = (db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;

  const rows = db
    .prepare(
      `SELECT s.sub_no, s.plan_title, s.plan_slug, s.amount_total_cents, s.amount_used_cents,
              s.paid_cents, s.basic_token_total, s.basic_token_used, s.status, s.source,
              s.start_at, s.end_at, s.auto_renew, s.has_key, s.key_masked, s.updated_at,
              a.id AS accountId, a.identifier AS accountIdentifier, a.upstream_id AS upstreamId
       ${from}
       ORDER BY (s.end_at IS NULL), s.end_at, s.sub_no, s.id
       LIMIT ? OFFSET ?`,
    )
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as (SubscriptionRow & {
    accountId: string;
    accountIdentifier: string;
    upstreamId: string;
  })[];

  return {
    items: rows.map((r) => ({
      ...toSubscriptionDto(r),
      accountId: r.accountId,
      accountIdentifier: r.accountIdentifier,
      upstreamId: r.upstreamId,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/**
 * 名下**已入池**的 key 数 —— 判据与 §15.1 `keyCount` **逐字一致**（`countsFor` 的同一条件）。
 *
 * 三个条件缺一不可，缺哪个都出事，且出事的方式都是静默的：
 *   · `pooled_key_id IS NOT NULL` —— 只有掩码的行不是池内 key。拿它拦删除，等于因为
 *     "我们看到过一个掩码"而禁止删账号，而那是删不掉又解释不通的一类。
 *   · **JOIN 命中** —— 台账行**没有外键**，`deleteUpstream`（ADR-0016）物理删 key 时不动
 *     台账，于是删过一次上游的账号会留下**悬空台账行**（`pooled_key_id` 指向已不存在的 key）。
 *     直接 `COUNT(*) FROM supplier_account_keys WHERE account_id = ?` 会把这些算进去：
 *     弹窗警告"连带 N 把 key 解绑"，而那 N 把早已不存在 —— 账号被一个**幻觉**永久拦住，
 *     `force=true` 也解绑不出任何东西。
 *   · `deleted_at IS NULL` —— 软删的 key 不在池里（§15.1 同口径）。
 */
export function countPooledKeys(db: Db, accountId: string): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM supplier_account_keys k
           JOIN upstream_keys uk ON uk.id = k.pooled_key_id AND uk.deleted_at IS NULL
          WHERE k.account_id = ?`,
      )
      .get(accountId) as { n: number }
  ).n;
}

/**
 * 契约 §15.2 `DELETE /api/supplier-accounts/:id?force=`。
 *
 * `force != true` 且名下有已入池 key → `409 ACCOUNT_HAS_KEYS`，**拦下时零副作用**
 * （先判定、后开事务）。`force = true` → 删账号行、套餐行、台账行。
 *
 * **池内 key 一行都不动**：这是本节与 `deleteUpstream`（ADR-0016 物理删整棵子树）**取向相反**
 * 的一处，理由不是风格 —— 上游删了 key 必然不可达，而**账号删了 key 仍然可用**（key 的密文
 * 与 `upstream_keys` 行都在，网关照常转发）。所以这里只**解绑**：删掉 `supplier_account_keys`
 * 的台账行，`upstream_keys` 保持原样。解绑在第四口径（§15.6）里的效果正是我们要的 ——
 * 那把 key 从"账号代表其余额"变回"自己就是一份钱"，于是它带着**已有的 `balance_cents`**
 * 回到 §2 的 `keysBalance` 那一格。若这里顺手把 key 也删了，网关会在下一轮快照里少一把可用 key，
 * 客户端开始报"没有可用 key"——**删除账号的动作打穿了流量**。
 *
 * **不发 `change_log`**：网关快照只消费 `upstream_keys` / `upstreams` / `models`，
 * 而本操作一行 key 都没动（解绑不改 key 行的任何一列），所以网关侧**没有任何变化可推**。
 * 发一条它不认识的 entity 只会让快照消费方多一个要忽略的分支。
 * 留痕由 `audit_log` 负责（同 ADR-0008 对网关 key 的处理）。
 */
export function deleteSupplierAccount(db: Db, id: string, force: boolean): void {
  const exists = db.prepare('SELECT id FROM supplier_accounts WHERE id = ?').get(id);
  if (!exists) throw ApiError.notFound('供应商账号', id);

  const keyCount = countPooledKeys(db, id);
  if (keyCount > 0 && !force) {
    throw new ApiError(
      'ACCOUNT_HAS_KEYS',
      `该账号名下有 ${keyCount} 把已入池的 key：继续删除会把它们解绑（key 本身保留，仍可被网关使用）`,
      { keyCount },
    );
  }

  db.transaction(() => {
    // 套餐行与台账行都 `REFERENCES supplier_accounts(id)`，必须先删 —— 否则删账号行直接
    // `SQLITE_CONSTRAINT_FOREIGNKEY`（同 ADR-0016 那条 500 的成因，只是这里更短）。
    db.prepare('DELETE FROM supplier_account_subscriptions WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM supplier_account_keys WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM supplier_accounts WHERE id = ?').run(id);
  })();
}
