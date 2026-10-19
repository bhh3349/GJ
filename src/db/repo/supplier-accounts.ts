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
import { nowIso } from '../../util/time.js';
import { decryptSecret } from '../crypto.js';
import type { Db } from '../database.js';
import { newId } from '../ids.js';
import { appendChange } from './change-log.js';
import { translateWriteError } from './write-errors.js';

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
  /** §16.7 Tier 2 的账号级出口绑定；`NULL` = 走宿主出口（配置事实，不是未知） */
  egress_id: string | null;
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
  balance_cents, balance_updated_at, session_expires_at, egress_id, revision, created_at, updated_at,
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
    // §16.7 Tier 2 写路径的读面（v1.13.0）：这一列此前只被快照读（`src/wiring/store.ts`），
    // 管理面从不 SELECT 它 —— 于是「能写却看不见」。`NULL` 原样透出（= 走宿主出口）。
    egressId: row.egress_id,
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
): { id: string; identifier: string } | null {
  return (
    (db
      .prepare('SELECT id, identifier FROM supplier_accounts WHERE upstream_id = ? AND identifier_hash = ?')
      .get(upstreamId, identifierHash) as { id: string; identifier: string } | undefined) ?? null
  );
}

/**
 * 按**上游 uid** 找行。cookie-only 导入（§15.9）的唯一稳定身份：
 * 手里只有会话时拿不到真值手机号/邮箱，`identifier_hash` 无法按原有口径算，
 * 只能先问上游 `GET /api/me` 拿 `data.id`，再用它判重。
 *
 * 一个 uid 在同一上游理应只有一行；历史上若有重复（手工塞过数据），取最早建的那行，
 * 保证同一批导入命中的是同一行，而不是随机行。
 */
export function findSupplierAccountByUid(
  db: Db,
  upstreamId: string,
  uid: string,
): { id: string; identifier: string } | null {
  return (
    (db
      .prepare(
        `SELECT id, identifier FROM supplier_accounts
          WHERE upstream_id = ? AND uid = ?
          ORDER BY created_at, id LIMIT 1`,
      )
      .get(upstreamId, uid) as { id: string; identifier: string } | undefined) ?? null
  );
}

/**
 * 按**掩码列**找行。cookie-only 导入的第二道判重：上游 `/api/me` 回的 `phoneMasked`
 * 与既有行（当初按真值手机号导入、`uid` 尚未回填）的 `identifier` 是同一形态。
 *
 * 掩码不是唯一身份（同尾号可能撞），所以只在 uid 查不到时用；命中多行时取最早的一行。
 */
export function findSupplierAccountByIdentifier(
  db: Db,
  upstreamId: string,
  identifier: string,
): { id: string; identifier: string } | null {
  return (
    (db
      .prepare(
        `SELECT id, identifier FROM supplier_accounts
          WHERE upstream_id = ? AND identifier = ?
          ORDER BY created_at, id LIMIT 1`,
      )
      .get(upstreamId, identifier) as { id: string; identifier: string } | undefined) ?? null
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
 * **要发 `change_log`（ADR-0021 决策 5 起改口）**：解绑确实不改 `upstream_keys` 的任何一列，
 * 但它改的是网关快照里的**归属** —— 那把 key 的 `accountId` / 出口从"账号的"变回"自己的"。
 * 本段注释早先写的是"网关侧没有任何变化可推"，那在快照只读 `upstreams` / `upstream_keys` / `models`
 * 时是对的；E 接缝把台账并进了快照输入，那个前提就没了。漏发的后果不是报错，
 * 是网关那边这笔归属**永远不更新**。
 * 仍然**不动池内 key**（密文与行都在，网关照常转发）—— 理由见上。
 * 留痕仍由 `audit_log` 负责（同 ADR-0008 对网关 key 的处理）。
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

  // 先记下"解绑了谁"：删完台账行就再也问不出受影响的是哪几把 key 了。
  const linked = listLinkedPooledKeyIds(db, id);

  db.transaction(() => {
    // 套餐行与台账行都 `REFERENCES supplier_accounts(id)`，必须先删 —— 否则删账号行直接
    // `SQLITE_CONSTRAINT_FOREIGNKEY`（同 ADR-0016 那条 500 的成因，只是这里更短）。
    db.prepare('DELETE FROM supplier_account_subscriptions WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM supplier_account_keys WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM supplier_accounts WHERE id = ?').run(id);
    // 与删除同一事务：崩在中间会让"库里已解绑、网关还认着账号"成为**永久**状态。
    for (const pooled of linked) appendChange(db, 'key', pooled, 'update', null);
  })();
}

// ---------------------------------------------------------------------------
// 写路径（§15.2 六个要打上游的端点）
// ---------------------------------------------------------------------------
//
// 与上面的读面**分开一段**，因为两段面对的约束不同：读面只 SELECT 公开列，
// 写路径要碰两个凭据 BLOB。凭据纪律在这里收紧成一条：
//   **密文只在 `createSupplierAccount` / `updateSupplierAccount` 的入参里出现一次，
//   此后本文件不再持有它**；解密只有一个出口 `readSupplierCredential`，而它返回的对象
//   **只活在调用方栈内**，不得进入任何 DTO / 任务 result / 审计 detail（§15.9 纪律 4）。

/** 账号的最小定位信息。批量端点先列它，再决定对谁干活。 */
export interface SupplierAccountRef {
  id: string;
  upstreamId: string;
  /** **掩码**（列表展示用；真值只以 `identifier_hash` 存在） */
  identifier: string;
  identifierHash: string;
  status: SupplierAccountStatus;
}

interface RefRow {
  id: string;
  upstream_id: string;
  identifier: string;
  identifier_hash: string;
  status: string;
}

function toRef(r: RefRow): SupplierAccountRef {
  return {
    id: r.id,
    upstreamId: r.upstream_id,
    identifier: r.identifier,
    identifierHash: r.identifier_hash,
    status: r.status as SupplierAccountStatus,
  };
}

/**
 * 按条件列账号（`refresh` / `keys` / `keys/sync` 的目标集）。
 *
 * `ids` 给了就**只认这些 id**（不再叠加 `upstreamId`/`status` 过滤）—— 这是刻意的：
 * 调用方明确指名了账号时，再套一层"状态必须是 active"会让一次手动重登在
 * `session_expired` 的账号上静默变成"什么都不做"，而操作员点那个按钮的**全部目的**
 * 就是把它从 `session_expired` 里救回来。过滤条件用于"省略 ids 时选谁"，
 * 不用于"我点名的这个还算不算数"。
 */
export function listSupplierAccountRefs(
  db: Db,
  query: {
    upstreamId?: string | undefined;
    ids?: readonly string[] | undefined;
    statuses?: readonly string[] | undefined;
  },
): SupplierAccountRef[] {
  if (query.ids !== undefined) {
    if (query.ids.length === 0) return [];
    // 重复 id 去重：调用方传了 50 个 id 不代表要干 50 次活。
    const unique = [...new Set(query.ids)];
    const rows = db
      .prepare(
        `SELECT id, upstream_id, identifier, identifier_hash, status
           FROM supplier_accounts WHERE id IN (${placeholders(unique.length)})
          ORDER BY created_at DESC, id`,
      )
      .all(...unique) as RefRow[];
    return rows.map(toRef);
  }

  const where: string[] = [];
  const params: unknown[] = [];
  if (query.upstreamId !== undefined && query.upstreamId !== '') {
    where.push('upstream_id = ?');
    params.push(query.upstreamId);
  }
  if (query.statuses !== undefined && query.statuses.length > 0) {
    where.push(`status IN (${placeholders(query.statuses.length)})`);
    params.push(...query.statuses);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT id, upstream_id, identifier, identifier_hash, status
         FROM supplier_accounts ${clause}
        ORDER BY created_at DESC, id`,
    )
    .all(...params) as RefRow[];
  return rows.map(toRef);
}

export interface CreateSupplierAccountInput {
  upstreamId: string;
  supplier: string;
  /** **掩码**（`maskIdentifier` 的产物）—— 真值不落这一列 */
  identifier: string;
  identifierHash: string;
  username?: string | null | undefined;
  uid?: string | null | undefined;
  status: SupplierAccountStatus;
  statusMessage?: string | null | undefined;
  /** 已经 `encryptSecret` 过的密文；`null` = 这一路凭据没有 */
  encryptedPassword?: Buffer | null | undefined;
  encryptedSession?: Buffer | null | undefined;
  sessionExpiresAt?: string | null | undefined;
}

/**
 * 建一行账号。`id` 由调用方给（`acc_…`，`newId('supplierAccount')`）。
 *
 * 两路凭据都空 → 撞 DDL 的 `CHECK (encrypted_password IS NOT NULL OR encrypted_session IS NOT NULL)`。
 * **不在这里兜底**：那种行是永远登不上的死行，能在写入点炸出来是最好的结果。
 */
export function createSupplierAccount(db: Db, id: string, input: CreateSupplierAccountInput): void {
  const at = nowIso();
  try {
    db.prepare(
      `INSERT INTO supplier_accounts (
         id, upstream_id, supplier, identifier, identifier_hash, username, uid,
         encrypted_password, encrypted_session, session_expires_at,
         status, status_message, balance_cents, balance_currency, balance_updated_at,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 1, ?, ?)`,
    ).run(
      id,
      input.upstreamId,
      input.supplier,
      input.identifier,
      input.identifierHash,
      input.username ?? null,
      input.uid ?? null,
      input.encryptedPassword ?? null,
      input.encryptedSession ?? null,
      input.sessionExpiresAt ?? null,
      input.status,
      input.statusMessage ?? null,
      at,
      at,
    );
  } catch (err) {
    throw translateWriteError(err, 'upstreamId');
  }
}

/**
 * 账号的一次写入。**所有字段都是"给了才改"**（`undefined` = 不动这一列）。
 *
 * 这一点不是风格：刷新只拿到余额、重登只拿到会话、导入拿到密码 —— 三件事各改各的列，
 * 用"整行覆写"的话，一次余额刷新会把刚重登得到的会话抹成 NULL
 * （然后账号静默回到"没有会话"状态，而列表上看起来一切正常）。
 */
export interface UpdateSupplierAccountInput {
  username?: string | null | undefined;
  uid?: string | null | undefined;
  status?: SupplierAccountStatus | undefined;
  statusMessage?: string | null | undefined;
  /** 密文；**给了就覆写**（§15.9「覆写 `session_cipher`」） */
  encryptedSession?: Buffer | null | undefined;
  /** 明文密码经 `encryptSecret` 后的密文；只在使用方拿到新密码时给 */
  encryptedPassword?: Buffer | null | undefined;
  sessionExpiresAt?: string | null | undefined;
  balanceCents?: number | null | undefined;
  balanceCurrency?: string | null | undefined;
  /** 只在**真查到**余额时给（§14.2：查失败不动它，否则会渲染成"刚查过"） */
  balanceUpdatedAt?: string | null | undefined;
  /**
   * 站点换算比（`/api/user/self → data.quota_per_unit`）与读到它的时刻。
   *
   * **两格必须一起给**：只给比值不给时刻，`quota_read_at IS NULL` 这条"该不该信它"的
   * 判据就失效了，一个过期比值会被当成刚读到的。同 `balanceCents` / `balanceUpdatedAt`
   * 那一对，只是这里存的是**比例**而不是金额（§15.1：它是比例，不是钱）。
   *
   * 只在**真读到**时给（查失败不动）—— 见 DDL 里"可空无默认"的理由。
   */
  quotaPerUnit?: number | null | undefined;
  quotaReadAt?: string | null | undefined;
}

export function updateSupplierAccount(db: Db, id: string, patch: UpdateSupplierAccountInput): void {
  const sets: string[] = [];
  const params: unknown[] = [];

  const put = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.username !== undefined) put('username', patch.username);
  if (patch.uid !== undefined) put('uid', patch.uid);
  if (patch.status !== undefined) put('status', patch.status);
  if (patch.statusMessage !== undefined) put('status_message', patch.statusMessage);
  if (patch.encryptedSession !== undefined) put('encrypted_session', patch.encryptedSession);
  if (patch.encryptedPassword !== undefined) put('encrypted_password', patch.encryptedPassword);
  if (patch.sessionExpiresAt !== undefined) put('session_expires_at', patch.sessionExpiresAt);
  if (patch.balanceCents !== undefined) put('balance_cents', patch.balanceCents);
  if (patch.balanceCurrency !== undefined) put('balance_currency', patch.balanceCurrency);
  if (patch.balanceUpdatedAt !== undefined) put('balance_updated_at', patch.balanceUpdatedAt);
  if (patch.quotaPerUnit !== undefined) put('quota_per_unit', patch.quotaPerUnit);
  if (patch.quotaReadAt !== undefined) put('quota_read_at', patch.quotaReadAt);

  // 一次空 patch 直接返回：写一条 `UPDATE ... SET revision = revision + 1` 会让
  // 一个"什么都没改"的调用把乐观锁版本推进一格，前端下次提交就撞 REVISION_MISMATCH。
  if (sets.length === 0) return;

  // `revision + 1` 与 `updated_at` 永远一起动（§0.2 乐观锁口径）。
  sets.push('revision = revision + 1', 'updated_at = ?');
  params.push(nowIso(), id);

  db.prepare(`UPDATE supplier_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * 契约 §15.2 `PATCH /api/supplier-accounts/:id` —— **账号绑出口**（§16.7 Tier 2 写路径，v1.13.0 / ADR-0029）。
 *
 * 本函数是 `supplier_accounts.egress_id` 的**唯一**写入口。它之前一个都没有：DDL 与快照读
 * 早在 §16.7 批次就落了（`src/wiring/store.ts` 的 `account_egress_id`、ADR-0021 决策 5 的 E 接缝），
 * 而管理面 12 条路由里没有一条能写它 —— 于是「建得出出口、却绑不上账号」，
 * 出口池这半边功能整条悬空。
 *
 * 三件必须一起做的事（漏哪件都是静默的）：
 *   1. **活性校验**（§16.7 裁定 6 账号侧对称条）：`egressId` 指向**不存在或已 `retired`** 的出口
 *      ⇒ `400 INVALID_PARAM`（`details.field = 'egressId'`）。不留"绑上去了但永远发不出去"的账号 ——
 *      那种行不报错、不告警，只在某天有人问"为什么这个号没走代理"时才被发现。
 *      `null` 是**合法值**：解绑 = 回到宿主出口（§16.7「`egress_id IS NULL` 的账号照常走宿主出口」）。
 *   2. **`change_log` 广播**（ADR-0021 决策 5 / `src/db/schema.ts` 那段 ⚠ 约定）：
 *      改这一列改的是网关快照里**每把 key 的出口归属**，而 `supplier_accounts` **不在**
 *      `SNAPSHOT_ENTITIES` 里（快照只认 `upstream` / `key` / `model` / `balance`）。所以必须按
 *      **受影响的那几把 `pooled_key_id`** 各发一条 `entity='key'` 的变更。
 *      漏发的表现不是报错，是那把 key 的出口**永远停在旧值**上 —— 出口预算按 id 分桶，
 *      于是同一根出口被算成两根、放行量翻倍（§16.7 点名的第一条洞）。
 *      广播与写入**同一事务**：崩在中间会让"库里有、网关看不见"成为永久状态。
 *   3. **乐观锁**（§0.2）：`revision` 不符 ⇒ `409 REVISION_MISMATCH`（带 `expected` / `actual`，
 *      与 `keys.ts` / `upstreams.ts` 同款）。两个运维同时在页面上改同一个号的出口时，
 *      后提交的人必须知道自己覆盖了前一个人，而不是静默取胜。
 *
 * **值未变 = 空操作**：`egressId` 与库里相同 ⇒ 直接回当前 DTO，**不推进 `revision`、不发广播**
 * （同 `updateSupplierAccount` 的空 patch 口径）。否则"点两次同一个出口"会白推一次快照重建，
 * 而 `applySnapshot` 会把 token-plan key 的乐观扣减清零 —— 一次无意义的点击不该有那个副作用。
 *
 * 与 `updateSupplierAccount` **不合并**：那个函数的入参里有三个密文列，而本函数一个凭据都不碰。
 * 合在一起会让"绑出口"这条路径的签名里出现 `encrypted_password`，那正是 §15.9 纪律 4
 * 要避免的形状（凭据只出现在真正需要它的路径上）。
 */
export function setSupplierAccountEgress(
  db: Db,
  id: string,
  egressId: string | null,
  revision: number,
): SupplierAccountDto {
  const current = db
    .prepare('SELECT egress_id, revision FROM supplier_accounts WHERE id = ?')
    .get(id) as { egress_id: string | null; revision: number } | undefined;
  if (current === undefined) throw ApiError.notFound('供应商账号', id);

  // 活性校验在乐观锁**之前**：先答"这个值本身合不合法"，再答"你要改的那一行还是不是你以为的那一行"。
  // 反过来的话，一个填错的出口 id 会在并发场景下被报成 REVISION_MISMATCH，前端会去刷新页面重试，
  // 而真正的问题（这个出口根本不能用）永远显示不出来。
  if (egressId !== null) {
    const egress = db
      .prepare('SELECT status FROM egress_proxies WHERE id = ?')
      .get(egressId) as { status: string } | undefined;
    if (egress === undefined) {
      throw ApiError.invalidParam('egressId', '指定的出口不存在');
    }
    if (egress.status !== 'active') {
      throw ApiError.invalidParam('egressId', '该出口已退役，请改用 active 出口或回池复用原条目');
    }
  }

  if (current.revision !== revision) {
    throw new ApiError('REVISION_MISMATCH', '该账号已被他人修改，请刷新后重试', {
      expected: revision,
      actual: current.revision,
    });
  }

  // 值未变 ⇒ 空操作（连 revision 都不推）。放在乐观锁之后：并发场景下"值没变"本身也可能是
  // 别人刚改成的结果，那种情况下上面那条 409 已经先响过了，走不到这里。
  if (current.egress_id === egressId) return requireSupplierAccount(db, id);

  // 受影响的那几把 key 先取下来：`change_log` 要按它们逐条广播（见上面的理由 2）。
  const affected = listLinkedPooledKeyIds(db, id);

  db.transaction(() => {
    db.prepare(
      'UPDATE supplier_accounts SET egress_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
    ).run(egressId, nowIso(), id);
    for (const pooled of affected) appendChange(db, 'key', pooled, 'update', null);
  })();

  return requireSupplierAccount(db, id);
}

/** 一个账号在库里的两路凭据（**已解密**）。只在调用方栈内存在，不得进 DTO（§15.9 纪律 4）。 */
export interface SupplierCredential {
  id: string;
  upstreamId: string;
  /** 归一化真值（重登时要原样提交给上游）；会话型账号取不到真值时是 `''` */
  identifier: string;
  identifierHash: string;
  /** 掩码，仅用于在结果里标明"这是哪个号" */
  maskedIdentifier: string;
  password: string | null;
  session: string | null;
  tfUser: string | null;
  /**
   * 站点换算比（`quota_per_unit`）与读到它的时刻。**`null` = 从没读到过**，
   * 不是 500000 —— 这两件事在取值上都表现为"用默认值"，但一个是"不知道"、
   * 一个是"知道是 500000"，建 key 时只有前者该落回默认（审计项 D）。
   *
   * 与凭据**同一次 SELECT** 出来：它只是一列，不为它多发一次查询。
   */
  quotaPerUnit: number | null;
  quotaReadAt: string | null;
}

interface CredRow {
  id: string;
  upstream_id: string;
  identifier: string;
  identifier_hash: string;
  encrypted_password: Buffer | null;
  encrypted_session: Buffer | null;
  quota_per_unit: number | null;
  quota_read_at: string | null;
}

/**
 * 解密一个账号的凭据。**本文件唯一的解密出口**。
 *
 * `identifier` 真值不在库里（只有 sha256 摘要）—— 而重登要用真值调 `/api/user/login`。
 * 所以真值随密码一起存在密码密文里（见 `supplier/credentials.ts` 的文件头）：
 * 只有密码型账号才需要"拿真值去登录"，而它恰好是唯一能存下真值的那种账号。
 * 会话型账号（无密码）返回 `identifier: ''`，调用方据 `password === null` 就知道用不上它。
 */
export function readSupplierCredential(db: Db, id: string, masterKey: Buffer): SupplierCredential | null {
  const row = db
    .prepare(
      `SELECT id, upstream_id, identifier, identifier_hash, encrypted_password, encrypted_session,
              quota_per_unit, quota_read_at
         FROM supplier_accounts WHERE id = ?`,
    )
    .get(id) as CredRow | undefined;
  if (row === undefined) return null;

  const passwordBlob = row.encrypted_password;
  const sessionBlob = row.encrypted_session;

  let identifier = '';
  let password: string | null = null;
  if (passwordBlob !== null) {
    const parsed = parseCredentialBlob(decryptSecret(passwordBlob, masterKey));
    identifier = parsed.identifier;
    password = parsed.secret;
  }

  let session: string | null = null;
  let tfUser: string | null = null;
  if (sessionBlob !== null) {
    const parsed = parseCredentialBlob(decryptSecret(sessionBlob, masterKey));
    session = parsed.secret;
    tfUser = parsed.tfUser;
  }

  return {
    id: row.id,
    upstreamId: row.upstream_id,
    identifier,
    identifierHash: row.identifier_hash,
    maskedIdentifier: row.identifier,
    password,
    session,
    tfUser,
    // 换算比不是凭据，跟着一起读出来（审计项 D：建 key 要用它换算 quotaCents）。
    // `quota_per_unit` 可空 —— 老库里这一列可能是 NULL（从没读到过），照原样传出。
    quotaPerUnit: row.quota_per_unit ?? null,
    quotaReadAt: row.quota_read_at ?? null,
  };
}

/**
 * 凭据密文的载荷形态。
 *
 * 为什么要 JSON 而不是裸串：`session` 那一路**还有一个 `TF-User` 要一起存**
 * （§15.9 明写"换一枚新 `session`（+ `TF-User`），覆写 `session_cipher`"），
 * 而库里只有一列 `encrypted_session`。给它加一列等于把"一次登录的产物"
 * 拆成两列、两处都可能只写一半；JSON 让它**原子地**进出一个 BLOB。
 * 密码那一路顺带存真值 `identifier`（见 `readSupplierCredential` 的注释）。
 */
export function parseCredentialBlob(raw: string): {
  secret: string;
  identifier: string;
  tfUser: string | null;
} {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const secret = typeof rec['secret'] === 'string' ? rec['secret'] : null;
      if (secret !== null && secret !== '') {
        return {
          secret,
          identifier: typeof rec['identifier'] === 'string' ? rec['identifier'] : '',
          tfUser: typeof rec['tfUser'] === 'string' && rec['tfUser'] !== '' ? rec['tfUser'] : null,
        };
      }
    }
  } catch {
    /* 落到下面的旧形态 */
  }
  // 兼容"裸串"形态：`encryptSecret('…')` 一类的历史 / 手工写入。
  // **保留这条分支**：库里若真有一行是裸串，报错会让那个账号永远读不出会话，
  // 而按裸串解释至少能让它继续工作。
  return { secret: raw, identifier: '', tfUser: null };
}

/** 账号的套餐行（写侧形态）。`end_at` 的 ISO 归一化责任在调用方（§15.2）。 */
export interface SupplierSubscriptionWrite {
  subNo: string;
  planTitle?: string | null | undefined;
  planSlug?: string | null | undefined;
  amountTotalCents?: number | null | undefined;
  amountUsedCents?: number | null | undefined;
  paidCents?: number | null | undefined;
  basicTokenTotal?: number | null | undefined;
  basicTokenUsed?: number | null | undefined;
  status?: string | null | undefined;
  source?: string | null | undefined;
  startAt?: string | null | undefined;
  endAt?: string | null | undefined;
  autoRenew?: boolean | null | undefined;
  hasKey?: boolean | undefined;
  keyMasked?: string | null | undefined;
}

/**
 * 整批替换一个账号的套餐行。
 *
 * **替换而不是 upsert**：上游给的是"此刻这个账号的全部套餐"，我们照抄这个全集。
 * 只做 upsert 的话，一个**在上游已被删掉**的套餐会永远留在我们库里 ——
 * 于是 `subscriptionCount` 长期偏大，而到期排序里会飘着一个早就不存在的套餐。
 */
export function replaceSupplierSubscriptions(
  db: Db,
  accountId: string,
  subs: readonly SupplierSubscriptionWrite[],
): void {
  const at = nowIso();
  db.transaction(() => {
    db.prepare('DELETE FROM supplier_account_subscriptions WHERE account_id = ?').run(accountId);
    const insert = db.prepare(
      `INSERT INTO supplier_account_subscriptions (
         id, account_id, sub_no, plan_title, plan_slug, amount_total_cents, amount_used_cents,
         paid_cents, basic_token_total, basic_token_used, status, source, start_at, end_at,
         auto_renew, has_key, key_masked, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of subs) {
      insert.run(
        newId('supplierSubscription'),
        accountId,
        s.subNo,
        s.planTitle ?? null,
        s.planSlug ?? null,
        s.amountTotalCents ?? null,
        s.amountUsedCents ?? null,
        s.paidCents ?? null,
        s.basicTokenTotal ?? null,
        s.basicTokenUsed ?? null,
        s.status ?? null,
        s.source ?? null,
        s.startAt ?? null,
        s.endAt ?? null,
        // 三态：`null` = 上游没给这个字段，**不是 false**（§15.1）。落库保持 NULL。
        s.autoRenew === undefined || s.autoRenew === null ? null : s.autoRenew ? 1 : 0,
        s.hasKey === true ? 1 : 0,
        s.keyMasked ?? null,
        at,
      );
    }
  })();
}

/**
 * 该账号**最新到期**的套餐号（`end_at` 最大；`NULL` 排最后）。
 *
 * 用途只有一个：§15.12 重置套餐 key 时 `subNo` 省略的默认取值。取"最晚到期"而不是"最新更新"，
 * 与 §15.2 `GET /subscriptions` 的排序取向一致 —— 一个账号叠多个套餐时，正在生效的那个才是
 * 用户说"重置这个套餐的 key"时指的那个。
 *
 * 名下没有套餐记录 → `null`（调用方据此报 `SUBSCRIPTION_NOT_FOUND`，**不猜一个 subNo**）。
 */
export function latestSubscriptionSubNo(db: Db, accountId: string): string | null {
  const row = db
    .prepare(
      `SELECT sub_no FROM supplier_account_subscriptions
        WHERE account_id = ?
        ORDER BY (end_at IS NULL), end_at DESC, sub_no DESC
        LIMIT 1`,
    )
    .get(accountId) as { sub_no: string } | undefined;
  return row === undefined ? null : row.sub_no;
}

/**
 * 单行**插入或更新**一个套餐（唯一键 `(account_id, sub_no)`）。
 *
 * 为什么不复用 `replaceSupplierSubscriptions`：那个函数是**整批替换**（先 `DELETE` 再插入），
 * 前提是"调用方手里有这个账号此刻的全部套餐"。§15.12 重置 key 拿到的却可能是**部分**套餐快照
 * （顺带对账那一次请求失败时 `mapped` 为空）—— 拿一份部分快照去整批替换，会把其余套餐行**删掉**：
 * `subscriptionCount` 变小、到期排序里少行，且**没有任何报错可追**。
 * 于是这里只动一行，且只把**本次确知为真**的两格（`has_key` / `key_masked`）写实。
 *
 * ## 为什么 UPDATE 分支只碰两列（审计项 C）
 *
 * 早先是一条 `ON CONFLICT … DO UPDATE SET <全部列>`。调用方（`rotateOne` ④）在顺带对账
 * **失败**时手里没有任何套餐字段，只能整批填 `null` 进来 —— 而 `DO UPDATE` 那句
 * `plan_title = excluded.plan_title` 会把**上一轮 refresh 写实的 `plan_title` /
 * `amount_total_cents` / `end_at` / `auto_renew` …** 一并抹成 NULL。
 * 症状是"重置了一次 key，这个套餐的金额与到期日凭空消失"，而前端看不出它是丢了
 * （NULL 与"上游没给"在界面上是同一副样子）。
 *
 * 现在拆成两条语句：INSERT 仍然收全量（**新行本来就没有旧值可保护**），
 * UPDATE 只写 `has_key` / `key_masked` —— 也就是本函数真正知道的那两格。
 * 代价是行已存在时其余列**永远不在这里更新**；那正是我们要的：
 * 那些列的唯一事实源是 `replaceSupplierSubscriptions`（整批替换，一次上游快照）。
 */
export function upsertSupplierSubscription(
  db: Db,
  accountId: string,
  sub: SupplierSubscriptionWrite,
): void {
  const at = nowIso();
  const insert = db.prepare(
    `INSERT INTO supplier_account_subscriptions (
       id, account_id, sub_no, plan_title, plan_slug, amount_total_cents, amount_used_cents,
       paid_cents, basic_token_total, basic_token_used, status, source, start_at, end_at,
       auto_renew, has_key, key_masked, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, sub_no) DO NOTHING`,
  );
  const stamp = db.prepare(
    `UPDATE supplier_account_subscriptions
        SET has_key = ?, key_masked = ?, updated_at = ?
      WHERE account_id = ? AND sub_no = ?`,
  );

  // 先插（新行 = 全量）。冲突时 DO NOTHING，再走 UPDATE 只动两格。
  // 用 `changes === 0` 而不是 `rowid` 判在不在：better-sqlite3 的 `run()` 回的就是
  // 实际改动行数，而"插进去"与"已存在"在这里都要走同一条 UPDATE 路径
  // —— 刚插进去的那行 `has_key` / `key_masked` 已经是入参值，再 stamp 一次是幂等的。
  insert.run(
    newId('supplierSubscription'),
    accountId,
    sub.subNo,
    sub.planTitle ?? null,
    sub.planSlug ?? null,
    sub.amountTotalCents ?? null,
    sub.amountUsedCents ?? null,
    sub.paidCents ?? null,
    sub.basicTokenTotal ?? null,
    sub.basicTokenUsed ?? null,
    sub.status ?? null,
    sub.source ?? null,
    sub.startAt ?? null,
    sub.endAt ?? null,
    // 三态：`null` = 上游没给这个字段，**不是 false**（§15.1）。落库保持 NULL。
    sub.autoRenew === undefined || sub.autoRenew === null ? null : sub.autoRenew ? 1 : 0,
    sub.hasKey === true ? 1 : 0,
    sub.keyMasked ?? null,
    at,
  );
  stamp.run(sub.hasKey === true ? 1 : 0, sub.keyMasked ?? null, at, accountId, sub.subNo);
}

/** 台账行（写侧形态）。`pooledKeyId` 非空 = 已入池，空 = 只拿到掩码。 */
export interface SupplierAccountKeyWrite {
  maskedKey: string;
  pooledKeyId?: string | null | undefined;
  note?: string | null | undefined;
}

/**
 * 套餐行（读侧形态，回填用）。
 *
 * 只取**回填真正需要的四格**：`basicTokenTotal` / `basicTokenUsed` 算出余量，
 * `endAt` 定到期，`keyMasked` 定位池里的那把 key。`SupplierSubscriptionWrite` 本身
 * 就能表达这四格，但回填在**读侧**调用（`syncForAccount` 手里是刚写进去的那批），
 * 拿写侧类型当入参会把"这个值可能是上游没给的 null"这件事讲混。
 */
export interface SupplierSubscriptionBackfill {
  subNo: string;
  basicTokenTotal?: number | null | undefined;
  basicTokenUsed?: number | null | undefined;
  endAt?: string | null | undefined;
  keyMasked?: string | null | undefined;
}

/**
 * 把上游套餐的**基础 Token 余量**回填给池内那把套餐 key（`token-plan`）。
 *
 * ## 为什么必须有这一步
 *
 * ADR-0022 落库时刻意把 `token_plan_remaining` 留 `NULL`（余量未知 ≠ 0），
 * 承诺"由后续 `keys/sync` / 余额刷新回填"。**本函数就是那个"后续"** ——
 * 不填的话，`KeyPool.remainingQuotaOf` 对 `NULL` 返回哨兵值，套餐 key
 * 永远排在余额 key 后面，而用户要的恰恰相反（先烧套餐）。
 *
 * ## 三条取值纪律（每一条都对着一个具体的错法）
 *
 * 1. **单位是 Token 个数，不是钱**。`basic_token_total` / `basic_token_used`
 *    上游给的是**Token 数**（轻享版 8,000,000 = 800 万），绝不能过 `quotaToCents`
 *    （那会把 800 万除成 16 分）。套餐的**高级**额度 `amount_*` 才是 quota。
 *    所以这里直接相减，一次换算都不做。
 * 2. **两个都取不到就整行跳过**。`null` 表示"上游没说"，不是 0。
 *    写 0 会让网关把这把 key 当成"额度耗尽"直接排除出选路 ——
 *    而那把 key 明明还能用，这是把"未知"伪装成"确定的无"。
 *    **`basicTokenUsed` 缺失同样跳过**（不是按 0 算）：理由见实现里那段。
 *    跳过的代价不是这把 key 不可用，是它在选路键 2 上落在"未知"那一档
 *    （`UNKNOWN_PLAN_QUOTA`）—— 仍排在余额 key 前，只是不参与精确排序。
 * 3. **余量可以递减**，所以这里**不能**用 `applyTemplateTokenPlan`：那个函数用
 *    `COALESCE(?, token_plan_remaining)` 防止模板覆盖手工值，代价是
 *    **永远写不进一个更小的数**。而套餐余量只会越用越少 —— 用 COALESCE 的话
 *    第一次同步之后就再也不更新了，前端会一直显示 800 万。
 *
 * ## 匹配口径
 *
 * 按 `key_masked`（`****` + 后 4 位）在台账里找**唯一**一把已入池的 key。
 * 撞号 / 找不到 ⇒ 这一行不动（同 §15.2 `KEY_MASK_AMBIGUOUS` 的取向：
 * 宁可留一个 NULL，也不把 A 套餐的余量写到 B 套餐的 key 上）。
 *
 * 匹配到的 key 若不是 `token-plan` 类（理论上不该发生：套餐 key 由 rotate 建，
 * 必然是 `token-plan`），照样跳过 —— 把套餐余量写到一把余额 key 上，
 * 会让 `KeyPool` 把它当套餐 key 排序，两套计费池就此混在一起。
 */
export function backfillSubscriptionTokenPlan(
  db: Db,
  accountId: string,
  subs: readonly SupplierSubscriptionBackfill[],
): void {
  const linked = listLinkedPooledKeyMasks(db, accountId);
  if (linked.length === 0 || subs.length === 0) return;

  const at = nowIso();
  const update = db.prepare(
    `UPDATE upstream_keys
       SET token_plan_remaining = ?, token_plan_expires_at = ?, balance_updated_at = ?, updated_at = ?
     WHERE id = ? AND category = 'token-plan' AND deleted_at IS NULL`,
  );

  const touched = new Set<string>();
  db.transaction(() => {
    for (const sub of subs) {
      // 纪律 1 + 2：先算余量。**任一格未知 ⇒ 这一行没有可写的数。**
      //
      // `basicTokenUsed` 缺失时**不能按 0 算**（这里早先是 `?? 0`，是文档漂移）：
      // `null` 的语义是"上游没说用了多少"，按 0 算等于替上游下一个它没下过的结论
      // （"这个套餐一点没用过"）。而这一减会产出一个**具体的数**（= 全额），
      // 它接着进网关的选路键 2、进 `balance_updated_at`、进前端那一格 ——
      // 一个"我们并不知道"的数从此以"我们查过了"的面目存在。
      //
      // 留 NULL 的代价**不是**这把 key 被踢出选路：`KeyPool.remainingQuotaOf`
      // 对 NULL 回 `UNKNOWN_PLAN_QUOTA`（= 1），仍然排在余额 key 之前 ——
      // 用户要的"先烧套餐"一点没变，只是这把 key 不参与精确排序。那是正确的代价：
      // 宁可排序粗一格，也不要编一个余量。
      if (sub.basicTokenTotal === null || sub.basicTokenTotal === undefined) continue;
      if (sub.basicTokenUsed === null || sub.basicTokenUsed === undefined) continue;
      const remaining = sub.basicTokenTotal - sub.basicTokenUsed;
      // 上游的 used 可能大于 total（并发计费的瞬时态）。负余量在网关侧会被
      // `remainingQuotaOf` 的 `Math.max(0, …)` 归一成 0 = 不可用，那是**正确**的
      // （池子确实空了）；但存一个负数进库会让前端显示"-200"，所以这里就夹到 0。
      const remainingTokens = Math.max(0, remaining);

      const masked = sub.keyMasked;
      if (masked === null || masked === undefined || masked === '') continue;
      const hits = linked.filter((row) => row.maskedKey === masked);
      if (hits.length !== 1) continue; // 撞号 / 找不到：不动
      const pooledKeyId = hits[0]?.pooledKeyId;
      if (pooledKeyId === undefined) continue;

      update.run(remainingTokens, sub.endAt ?? null, at, at, pooledKeyId);
      touched.add(pooledKeyId);
    }

    // 广播与写入同一事务（同 `replaceSupplierAccountKeyLedger`）：崩在中间会让
    // "库里有新余量、网关还在用旧快照"成为**永久**状态 —— 而快照里那把 key 的
    // `tokenPlanRemainingTokens` 正是选路键 2 与可用性判据。`'balance'` 与 `'key'`
    // 都在 `SNAPSHOT_ENTITIES` 里，两个都能叫醒网关；取 `'balance'` 是因为这一动
    // 改的是**额度**那一族列（`token_plan_remaining` / `token_plan_expires_at`）。
    for (const pooled of touched) appendChange(db, 'balance', pooled, 'update', null);
  })();
}

/**
 * 整批替换一个账号的 key 台账。
 *
 * 与套餐同理**整体替换**：`keys/sync` 拿到的是"这个账号此刻的全部 key"。
 * 但这里多一条 —— **已入池的行不能因为一次同步没看见它就消失**。
 * 上游列表是掩码、池里是明文，一次拉取失败 / 掩码撞号都会让某把 key "看不见"，
 * 而它可能正在被网关使用；台账行一没，`keyCount` 就少一把，删账号的 409 判定跟着失效。
 * 所以入池行**只增不减**：本次未命中的入池行原样保留，只重建"仅掩码"的那些行。
 */
export function replaceSupplierAccountKeyLedger(
  db: Db,
  accountId: string,
  rows: readonly SupplierAccountKeyWrite[],
): void {
  const at = nowIso();
  const insert = db.prepare(
    `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  /** 本次动过的入池 key（= 网关快照里"这把 key 属于谁"变了的那些），见事务尾部的广播。 */
  const touched = new Set<string>();
  db.transaction(() => {
    // 只清"仅掩码"的行（`pooled_key_id IS NULL`）—— 见上面的理由。
    db.prepare('DELETE FROM supplier_account_keys WHERE account_id = ? AND pooled_key_id IS NULL').run(accountId);

    // 同一批内"仅掩码"行的去重集合：上游分页返回两条一样的掩码时不该在台账里长两行。
    // 入池行不走这个集合 —— 它们由 `pooled_key_id` 唯一确定，重复的入池 id 会被
    // 第二条 UPDATE 命中（changes=1）而不会重复插入，天然幂等。
    const seenMasked = new Set<string>();

    for (const r of rows) {
      const pooled = r.pooledKeyId ?? null;
      if (pooled !== null) {
        touched.add(pooled);
        const updated = db
          .prepare(
            `UPDATE supplier_account_keys SET masked_key = ?, note = ?, updated_at = ?
              WHERE account_id = ? AND pooled_key_id = ?`,
          )
          .run(r.maskedKey, r.note ?? null, at, accountId, pooled);
        if (updated.changes > 0) continue;
        insert.run(newId('supplierAccountKey'), accountId, r.maskedKey, pooled, r.note ?? null, at, at);
        continue;
      }
      if (seenMasked.has(r.maskedKey)) continue;
      seenMasked.add(r.maskedKey);
      insert.run(newId('supplierAccountKey'), accountId, r.maskedKey, null, r.note ?? null, at, at);
    }

    // 台账动 = 网关快照里的「这把 key 属于哪个账号 / 从哪个出口出」动了 ⇒ 必须广播。
    // 快照只认 change_log 里那几个实体名，而**台账表名不在其中**（store.ts 的 SNAPSHOT_ENTITIES）：
    // 漏发不会报错、不会变慢，只会让 `accountId` 长期停在旧值上 ——
    // 而它正是出口限流按账号去重的键，一个人被数成好几份时判据只会更晚才响。
    // 广播与写入同一个事务：崩在中间会让"库里有、网关看不见"成为**永久**状态。
    for (const pooled of touched) appendChange(db, 'key', pooled, 'update', null);
    // 这个 `()` 不能省：`db.transaction(fn)` **只构造**一个事务函数，不执行。
    // 少了它，整个函数变成一次静默空转 —— 而它照样 `return { rows: rows.length }`，
    // 于是调用方看到"更新了 2 行"、库里一行没动。这类 bug 不会报错、不会变慢，
    // 只会让台账和事实长期分叉（`keyCount` 偏小 → 删账号的 409 判定跟着失效）。
  })();
}

/** 账号当前挂着的、已入池的 key id（`keys/sync` 与 `keys` 要跳过它们，避免重复入池）。 */
export function listLinkedPooledKeyIds(db: Db, accountId: string): string[] {
  const rows = db
    .prepare('SELECT pooled_key_id FROM supplier_account_keys WHERE account_id = ? AND pooled_key_id IS NOT NULL')
    .all(accountId) as { pooled_key_id: string }[];
  return rows.map((r) => r.pooled_key_id);
}

/**
 * 已入池 key 的**掩码**（`keys/sync` 对账用）。
 *
 * 走 `JOIN upstream_keys … AND deleted_at IS NULL`，与 `keyCount`（`countsFor()`）**同一口径**：
 * 软删掉的 key 不该再参与"后 4 位"匹配，否则一次同步会把一把已经删了的 key 的掩码
 * 匹配到新 key 上 —— 而台账行还在（它没有外键，见 §15.2），只靠台账数不出来这件事。
 */
export function listLinkedPooledKeyMasks(
  db: Db,
  accountId: string,
): { pooledKeyId: string; maskedKey: string }[] {
  const rows = db
    .prepare(
      `SELECT sak.pooled_key_id AS pooled_key_id, uk.masked_key AS masked_key
         FROM supplier_account_keys sak
         JOIN upstream_keys uk ON uk.id = sak.pooled_key_id AND uk.deleted_at IS NULL
        WHERE sak.account_id = ? AND sak.pooled_key_id IS NOT NULL`,
    )
    .all(accountId) as { pooled_key_id: string; masked_key: string }[];
  return rows.map((r) => ({ pooledKeyId: r.pooled_key_id, maskedKey: r.masked_key }));
}

/**
 * 追加 / 更新一行「已入池」台账（`keys` 端点当场建完 key 后调，§15.2）。
 *
 * **为什么不复用 `replaceSupplierAccountKeyLedger`**：那个函数是**整体替换**语义
 * （它会把 `pooled_key_id IS NULL` 的"仅掩码"行全删掉重建）。建 key 只多了一把，
 * 拿一次"建 key"去清掉上一次同步攒下的对账行，等于用一个动作悄悄毁掉另一件事的产出。
 * 整体替换归 `keys/sync`，单向追加归这里 —— 两个语义两种入口。
 *
 * 幂等：同一个 `pooledKeyId` 再调一次只是把掩码/备注覆写一遍（`changes > 0` 就不插入），
 * 所以重跑一次批量建 key 不会在台账里长重复行。
 */
export function linkSupplierAccountKey(
  db: Db,
  accountId: string,
  pooledKeyId: string,
  maskedKey: string,
  note: string | null = null,
): void {
  const at = nowIso();
  const updated = db
    .prepare(
      `UPDATE supplier_account_keys SET masked_key = ?, note = ?, updated_at = ?
        WHERE account_id = ? AND pooled_key_id = ?`,
    )
    .run(maskedKey, note, at, accountId, pooledKeyId);
  if (updated.changes === 0) {
    db.prepare(
      `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId('supplierAccountKey'), accountId, maskedKey, pooledKeyId, note, at, at);
  }
  // 台账动 ⇒ 网关快照里这把 key 的归属变了（理由与 `replaceSupplierAccountKeyLedger` 尾部逐字相同）。
  appendChange(db, 'key', pooledKeyId, 'update', null);
}

/** 上游的 `supplier` 与根地址。`import` 前必须 `supplier === 'tierflow'`，否则 `422`（§15.2）。 */
export function upstreamSupplier(
  db: Db,
  upstreamId: string,
): { baseUrl: string; supplier: string | null } | null {
  const row = db.prepare('SELECT base_url, supplier FROM upstreams WHERE id = ?').get(upstreamId) as
    | { base_url: string; supplier: string | null }
    | undefined;
  return row === undefined ? null : { baseUrl: row.base_url, supplier: row.supplier };
}
