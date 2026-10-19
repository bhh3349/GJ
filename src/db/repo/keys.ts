// Key 仓储。契约 §3 —— 本文件是「key 明文永不落盘」的执行点。
//
// 明文只从 createKey 的参数进来一次，立刻 encryptSecret 落 BLOB。
// 除 createKey 入参与 balance 刷新时的解密出口外，本文件里不存在任何持有明文的变量，
// 也不返回明文字段（maskedKey 是唯一出口形态）。
//
// health / cooldownUntil / consecutiveFailures 是**网关运行态**（key_runtime 表）：
// 管理面只读，且**本文件不提供任何写它们的函数** —— 这条纪律靠"不提供 API"来保证，
// 比靠文档约定可靠。全仓唯一写 key_runtime 的地方是 `./key-runtime.ts`，
// 调用方只有网关进程的运行态镜像（约 1s 一次批量刷写，见 ADR-0010）。

import { ApiError } from '../../api/errors.js';
import type { FailureReasonCode, KeyCategory, KeyDto, KeyHealth, Page } from '../../api/dto.js';
import { nowIso, utcDay } from '../../util/time.js';
import { decryptSecret, encryptSecret, maskKey } from '../crypto.js';
import type { Db } from '../database.js';
import { isBalanceDepleted, isTokenPlanDepleted } from '../depletion.js';
import { latchKeyDepleted } from './depletion-latch.js';
import type { DepletedReason } from '../depletion.js';
import { newId } from '../ids.js';
import { parseModelLimits, serializeModelLimits } from '../model-limits.js';
import { appendChange } from './change-log.js';
import { translateWriteError } from './write-errors.js';

interface KeyRow {
  id: string;
  upstream_id: string;
  label: string;
  masked_key: string;
  secret: Buffer;
  category: KeyCategory;
  enabled: number;
  weight: number;
  unlimited: number;
  model_limits: string | null;
  balance_cents: number | null;
  balance_currency: string | null;
  balance_updated_at: string | null;
  balance_source: 'manual' | 'template' | null;
  token_plan_remaining: number | null;
  token_plan_expires_at: string | null;
  depleted_at: string | null;
  depleted_reason: DepletedReason | null;
  today_tokens: number;
  today_day: string | null;
  revision: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  rt_fails: number | null;
  rt_cooldown: string | null;
  rt_reason: string | null;
  rt_at: string | null;
}

const SELECT_BASE = `
SELECT k.*,
       r.consecutive_failures  AS rt_fails,
       r.cooldown_until        AS rt_cooldown,
       r.last_failure_reason   AS rt_reason,
       r.last_failure_at       AS rt_at
FROM upstream_keys k
LEFT JOIN key_runtime r ON r.key_id = k.id
`;

/** health 派生：disabled 优先于 cooling（契约 §3 明确指定了优先级）。 */
function deriveHealth(row: KeyRow, nowMs: number): KeyHealth {
  if (row.enabled !== 1) return 'disabled';
  if (row.rt_cooldown !== null && Date.parse(row.rt_cooldown) > nowMs) return 'cooling';
  return 'healthy';
}

function toDto(row: KeyRow, nowMs: number, nowDay: string): KeyDto {
  const isBalance = row.category === 'balance';
  return {
    id: row.id,
    upstreamId: row.upstream_id,
    label: row.label,
    maskedKey: row.masked_key,
    category: row.category,
    enabled: row.enabled === 1,
    weight: row.weight,
    // 与 category 同一层纪律：只有 balance 类才谈得上"无限额度"。token-plan 行即使历史残留
    // `unlimited = 1`，出口也必须是 false —— 那个类别不看余额（§3 表格里两个分支互斥）。
    unlimited: isBalance && row.unlimited === 1,
    // 契约 §3 `models`（v1.4.2）：模型白名单，来源是库里的 CSV 列而不是到上游现查 ——
    // 网关读的是**同一个列**（`src/wiring/store.ts`），两边必须逐字同源。
    models: parseModelLimits(row.model_limits),
    // 类别决定可见字段：token-plan 的 balance 恒为 null，balance 类的 tokenPlan 恒为 null。
    // 存储列可能有过期残留（改类别时），所以在**读路径**再拦一道，
    // 保证无论库里什么状态，响应都不会违反契约。
    balance: isBalance ? row.balance_cents : null,
    balanceCurrency: isBalance ? row.balance_currency : null,
    balanceUpdatedAt: isBalance ? row.balance_updated_at : null,
    balanceSource: isBalance ? row.balance_source : null,
    tokenPlan: isBalance
      ? null
      : { remainingTokens: row.token_plan_remaining ?? 0, expiresAt: row.token_plan_expires_at },
    // 透支锁存（§20.8）：非空即锁存。`depletedAt` / `depletedReason` 原样透出 ——
    // 前者是审计（"最早发现它付不起账的时刻"），后者告诉人"是它自己没钱还是账号欠费级联"。
    depleted: row.depleted_at !== null,
    depletedAt: row.depleted_at,
    depletedReason: row.depleted_reason,
    health: deriveHealth(row, nowMs),
    cooldownUntil: row.rt_cooldown,
    consecutiveFailures: row.rt_fails ?? 0,
    lastFailureReason: row.rt_reason === null ? null : (row.rt_reason as KeyDto['lastFailureReason']),
    lastFailureAt: row.rt_at,
    // 昨日累计在读取时归零，而不是靠定时任务；没有定时任务就永远差一天的实现更不容易出错
    todayTokens: row.today_day === nowDay ? row.today_tokens : 0,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function nowContext(): { nowMs: number; nowDay: string } {
  return { nowMs: Date.now(), nowDay: utcDay() };
}

export function getKeyRow(db: Db, id: string): KeyRow | null {
  return (db.prepare(`${SELECT_BASE} WHERE k.id = ?`).get(id) as KeyRow | undefined) ?? null;
}

export function getKey(db: Db, id: string, includeDeleted: boolean): KeyDto | null {
  const row = getKeyRow(db, id);
  if (!row) return null;
  if (row.deleted_at !== null && !includeDeleted) return null;
  const ctx = nowContext();
  return toDto(row, ctx.nowMs, ctx.nowDay);
}

export interface ListKeysQuery {
  upstreamId?: string | undefined;
  category?: KeyCategory | undefined;
  enabled?: boolean | undefined;
  health?: KeyHealth | undefined;
  /** §20.8：透支锁存筛选，与 `enabled` / `health` 同形（正交轴，可与它们并用） */
  depleted?: boolean | undefined;
  q?: string | undefined;
  includeDeleted: boolean;
  page: number;
  pageSize: number;
}

export function listKeys(db: Db, query: ListKeysQuery): Page<KeyDto> {
  const where: string[] = [];
  const params: unknown[] = [];
  const nowMs = Date.now();
  const nowIsoStr = new Date(nowMs).toISOString();

  if (!query.includeDeleted) where.push('k.deleted_at IS NULL');
  if (query.upstreamId !== undefined) {
    where.push('k.upstream_id = ?');
    params.push(query.upstreamId);
  }
  if (query.category !== undefined) {
    where.push('k.category = ?');
    params.push(query.category);
  }
  if (query.enabled !== undefined) {
    where.push('k.enabled = ?');
    params.push(query.enabled ? 1 : 0);
  }
  if (query.health !== undefined) {
    // 与 deriveHealth 保持同一判据；这里重写一遍是为了让筛选在 SQL 里完成。
    // 两处必须同改 —— 见本文件底部的一致性测试。
    if (query.health === 'disabled') where.push('k.enabled = 0');
    if (query.health === 'cooling') {
      where.push('k.enabled = 1 AND r.cooldown_until IS NOT NULL AND r.cooldown_until > ?');
      params.push(nowIsoStr);
    }
    if (query.health === 'healthy') {
      where.push('k.enabled = 1 AND (r.cooldown_until IS NULL OR r.cooldown_until <= ?)');
      params.push(nowIsoStr);
    }
  }
  if (query.depleted !== undefined) {
    // §20.8：判据只有一处（`depleted_at IS NULL`），与 toDto 的 `depleted` 同源。
    where.push(query.depleted ? 'k.depleted_at IS NOT NULL' : 'k.depleted_at IS NULL');
  }
  if (query.q !== undefined && query.q !== '') {
    where.push('(k.label LIKE ? OR k.masked_key LIKE ?)');
    const like = `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM upstream_keys k LEFT JOIN key_runtime r ON r.key_id = k.id ${clause}`,
      )
      .get(...params) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `${SELECT_BASE} ${clause} ORDER BY k.created_at, k.id LIMIT ? OFFSET ?`,
    )
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as KeyRow[];

  const ctx = nowContext();
  return {
    items: rows.map((r) => toDto(r, ctx.nowMs, ctx.nowDay)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** 仪表盘 key 健康灯用：全部未软删 key 的 health 与冷却时刻（不分页）。 */
export function listKeyHealth(
  db: Db,
): { keyId: string; maskedKey: string; upstreamId: string; health: KeyHealth; cooldownUntil: string | null }[] {
  const rows = db
    .prepare(`${SELECT_BASE} WHERE k.deleted_at IS NULL ORDER BY k.created_at, k.id`)
    .all() as KeyRow[];
  const ctx = nowContext();
  return rows.map((r) => ({
    keyId: r.id,
    maskedKey: r.masked_key,
    upstreamId: r.upstream_id,
    health: deriveHealth(r, ctx.nowMs),
    cooldownUntil: r.rt_cooldown,
  }));
}

/**
 * 观测面（契约 §12.2）用的 key 健康明细。比 `listKeyHealth` 多一个 `consecutiveFailures`。
 *
 * 又是一个「形状不同就另开一个函数」的例子（同 `listLiveKeyStates` 的理由）：
 * `/api/stats/overview` 的 keyHealth 项已冻结成 5 个字段，
 * 给它加可选字段会让人以为是"同一个东西的可选形态"，而这两份契约是各自冻结的。
 * WHERE 与 SELECT_BASE 与另外两处逐字一致 —— 同一批 key 的三个视角，
 * 任何一处漏掉软删过滤，仪表盘就会多出几盏"看不见的 key"。
 */
export function listKeyHealthDetail(db: Db): {
  keyId: string;
  maskedKey: string;
  upstreamId: string;
  health: KeyHealth;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  depleted: boolean;
}[] {
  const rows = db
    .prepare(`${SELECT_BASE} WHERE k.deleted_at IS NULL ORDER BY k.created_at, k.id`)
    .all() as KeyRow[];
  const ctx = nowContext();
  return rows.map((r) => ({
    keyId: r.id,
    maskedKey: r.masked_key,
    upstreamId: r.upstream_id,
    health: deriveHealth(r, ctx.nowMs),
    cooldownUntil: r.rt_cooldown,
    consecutiveFailures: r.rt_fails ?? 0,
    // §20.8：与 `health` 正交的一格。`deriveHealth` 一行不动 —— 透支不是第四个 health 值。
    depleted: r.depleted_at !== null,
  }));
}

export interface LiveKeyState {
  keyId: string;
  maskedKey: string;
  upstreamId: string;
  health: KeyHealth;
  cooldownUntil: string | null;
  lastFailureReason: FailureReasonCode | null;
}

/**
 * 实时通道用的运行态快照。比 `listKeyHealth` 多一个 `lastFailureReason` ——
 * 契约 §7 的 `key_health` 帧要它，而 §6 `/api/stats/overview` 的 `keyHealth`
 * 项形状已经冻结成 5 个字段，不能顺手加一个。
 * 两处口径既然不同就分成两个函数：加可选参数会让人以为"同一个东西的可选形态"，
 * 而它们其实是两份各自冻结的契约。
 */
export function listLiveKeyStates(db: Db): LiveKeyState[] {
  // WHERE 必须与 `listKeyHealth` 逐字一致：两者是同一批 key 的两个视角，
  // 一旦这里漏掉软删过滤，仪表盘的灯就会比列表多出几盏"看不见的 key"。
  const rows = db
    .prepare(`${SELECT_BASE} WHERE k.deleted_at IS NULL ORDER BY k.created_at, k.id`)
    .all() as KeyRow[];
  const ctx = nowContext();
  return rows.map((r) => ({
    keyId: r.id,
    maskedKey: r.masked_key,
    upstreamId: r.upstream_id,
    health: deriveHealth(r, ctx.nowMs),
    cooldownUntil: r.rt_cooldown,
    lastFailureReason: r.rt_reason === null ? null : (r.rt_reason as FailureReasonCode),
  }));
}

export interface CreateKeyInput {
  upstreamId: string;
  /** 明文，仅此一次；本函数返回前它已被加密且不再被引用 */
  key: string;
  category: KeyCategory;
  label?: string | undefined;
  weight?: number | undefined;
  balance?: number | null | undefined;
  tokenPlan?: { remainingTokens: number; expiresAt: string | null } | null | undefined;
  /** §15.7：`true` ⇒ 上游无限额度（`unlimited_quota`）。见下方落库规则。 */
  unlimited?: boolean | undefined;
  /**
   * §15.2（v1.4.2）：模型白名单。省略 / `[]` / 全空白 ⇒ 落 `NULL` = **不限模型**。
   *
   * 只给 §15 批量建 key 用 —— §3 `POST /api/keys` 的请求体**零变更**，不收该字段
   * （白名单是"上游账号面"的事实，手工建 key 没有它）。
   */
  models?: string[] | null | undefined;
}

export function createKey(db: Db, input: CreateKeyInput, masterKey: Buffer): KeyDto {
  const upstream = db.prepare('SELECT id FROM upstreams WHERE id = ?').get(input.upstreamId);
  if (!upstream) throw ApiError.invalidParam('upstreamId', '上游不存在');

  const id = newId('key');
  const at = nowIso();
  const masked = maskKey(input.key);
  const blob = encryptSecret(input.key, masterKey);
  const isBalance = input.category === 'balance';
  /**
   * §15.7 落库规则：`unlimited = 1` ⇒ `balance_cents` **必须落 NULL**（v1.4.5）。
   *
   * 上游对无限额度 key 回的是 `{unlimited_quota: true, remain_quota: -331119}`，那个负数是
   * **无意义占位、不是"欠费"**。落进去就成了一把"已欠费"的 key，而网关可用性过滤是
   * `balance_cents <= 0 → 排除` —— 于是它被**静默排除出选路**：不报错、不告警、不进冷却，
   * 客户端只看到"没有可用 key"。落 NULL 则走既有的「未知 ≠ 0、仍可用」分支。
   *
   * 这条规则在这里**强制**，而不是靠调用方自觉：调用方（§15 驱动器）同时拿到
   * `unlimited_quota` 与那个负数，忘了丢负数的代价是一个静默故障。
   */
  const unlimited = isBalance && input.unlimited === true;
  const balance = unlimited ? null : (input.balance ?? null);

  try {
    db.prepare(
      `INSERT INTO upstream_keys (
         id, upstream_id, label, masked_key, secret, category, enabled, weight,
         balance_cents, balance_currency, balance_updated_at, balance_source,
         token_plan_remaining, token_plan_expires_at, unlimited, model_limits,
         today_tokens, today_day, revision, deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, NULL, ?, ?)`,
    ).run(
      id,
      input.upstreamId,
      input.label ?? masked,
      masked,
      blob,
      input.category,
      input.weight ?? 1,
      balance,
      isBalance ? 'CNY' : null,
      isBalance && balance !== null ? at : null,
      isBalance && balance !== null ? 'manual' : null,
      isBalance ? null : (input.tokenPlan?.remainingTokens ?? null),
      isBalance ? null : (input.tokenPlan?.expiresAt ?? null),
      unlimited ? 1 : 0,
      serializeModelLimits(input.models),
      utcDay(),
      at,
      at,
    );
  } catch (err) {
    throw translateWriteError(err, 'upstreamId');
  }

  appendChange(db, 'key', id, 'insert', 1);
  // 建 key 也判（§20.4 判定腿）：生而为 0 的 key 生而该锁，不等下一轮余额刷新。
  // `unlimited` 在 INSERT 处已把 `balance_cents` 强制为 NULL，结构上够不着这条判据；
  // 这里显式走同一个合并调用点，而不是靠那条不变量兜底（同 `depletion.ts` 头注的理由）。
  const written = getKeyRow(db, id);
  if (!written) throw new ApiError('INTERNAL', '创建后读取失败');
  latchIfBalanceDepleted(db, written);
  const created = getKey(db, id, false);
  if (!created) throw new ApiError('INTERNAL', '创建后读取失败');
  return created;
}

export interface UpdateKeyInput {
  label?: string | undefined;
  enabled?: boolean | undefined;
  weight?: number | undefined;
  category?: KeyCategory | undefined;
  tokenPlan?: { remainingTokens: number; expiresAt: string | null } | null | undefined;
  revision: number;
}

export function updateKey(db: Db, id: string, patch: UpdateKeyInput): KeyDto {
  const current = getKeyRow(db, id);
  if (!current) throw ApiError.notFound('Key', id);
  if (current.deleted_at !== null) throw ApiError.notFound('Key', id);

  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.label !== undefined) {
    sets.push('label = ?');
    params.push(patch.label);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.weight !== undefined) {
    sets.push('weight = ?');
    params.push(patch.weight);
  }
  if (patch.category !== undefined && patch.category !== current.category) {
    sets.push('category = ?');
    params.push(patch.category);
    if (patch.category === 'token-plan') {
      // 契约 §3：token-plan 时 balance 恒为 null。改类别时把金额列清干净，
      // 否则库里留着一个永远不该被读到的金额，将来有人直连库查账就会被骗。
      sets.push('balance_cents = NULL', 'balance_currency = NULL', 'balance_updated_at = NULL', 'balance_source = NULL');
    }
  }
  if (patch.tokenPlan !== undefined) {
    sets.push('token_plan_remaining = ?', 'token_plan_expires_at = ?');
    params.push(patch.tokenPlan?.remainingTokens ?? null, patch.tokenPlan?.expiresAt ?? null);
  }

  if (sets.length === 0) {
    const ctx = nowContext();
    return toDto(current, ctx.nowMs, ctx.nowDay);
  }

  sets.push('revision = revision + 1', 'updated_at = ?');
  params.push(nowIso());

  const info = db
    .prepare(`UPDATE upstream_keys SET ${sets.join(', ')} WHERE id = ? AND revision = ?`)
    .run(...params, id, patch.revision);

  if (info.changes === 0) {
    const still = getKeyRow(db, id);
    if (!still || still.deleted_at !== null) throw ApiError.notFound('Key', id);
    throw new ApiError('REVISION_MISMATCH', '该 key 已被他人修改，请刷新后重试', {
      expected: patch.revision,
      actual: still.revision,
    });
  }

  const updated = getKeyRow(db, id);
  if (!updated) throw ApiError.notFound('Key', id);
  appendChange(db, 'key', id, 'update', updated.revision);

  // 手动改套餐余量也判（§20.4 判定腿的 `tokenPlan` 写分支）：编辑弹窗把一个套餐 key 的
  // 余量改成 0，与手动把一个余额 key 录成 0 是同一个动作的两张脸 —— 缺这一句，
  // "所有落库处都判"（ADR-0041 决策 4）就是一句没兑现的话。
  // **只在这条分支写过的列上判**：改 label/weight/enabled 不重开资金判据，否则
  // 一次改名就能把一把「解除后余额仍是 0」的 key 重新锁上，而那不是这次 PATCH 做的事。
  let after = updated;
  if (patch.tokenPlan !== undefined) {
    latchIfBalanceDepleted(db, updated);
    // 判完再读：锁存自己会 `revision + 1`，拿打标前的行建 DTO 会让这次响应少报一格
    // revision（调用方下一次 PATCH 当场 REVISION_MISMATCH）、并对着刚被锁的 key
    // 说"未透支"（同 `setKeyBalance` 的那条纪律）。
    const reread = getKeyRow(db, id);
    if (!reread) throw ApiError.notFound('Key', id);
    after = reread;
  }
  const ctx = nowContext();
  return toDto(after, ctx.nowMs, ctx.nowDay);
}

/**
 * 手动录入余额（契约 §3 `PUT /api/keys/:id/balance`）。
 *
 * 「防造假」的关键落点：`balance=0` 与 `balance=null` 是两条不同的分支。
 * 0 会写 balance_cents=0；null 会把列清回 NULL 并把 source 也置空。
 * 绝不允许"null 顺手写成 0" —— 那会让一个查询失败的 key 看起来像余额耗尽。
 */
export function setKeyBalance(
  db: Db,
  id: string,
  input: { balance: number | null; currency?: string | undefined },
): KeyDto {
  const current = getKeyRow(db, id);
  if (!current) throw ApiError.notFound('Key', id);
  if (current.deleted_at !== null) throw ApiError.notFound('Key', id);
  if (current.category !== 'balance') {
    throw new ApiError('UNPROCESSABLE', 'token-plan 类 key 不接受金额录入，请改用 tokenPlan');
  }

  const at = nowIso();
  if (input.balance === null) {
    db.prepare(
      `UPDATE upstream_keys
       SET balance_cents = NULL, balance_currency = NULL, balance_updated_at = ?,
           balance_source = NULL, revision = revision + 1, updated_at = ?
       WHERE id = ?`,
    ).run(at, at, id);
  } else {
    // currency 未给时沿用该 key 已有的币种，没有则按 CNY。上游配置里的 currency 是
    // **取值路径**（从响应里读哪个字段），不是币种常量，所以不能拿它当默认值。
    const currency = input.currency ?? current.balance_currency ?? 'CNY';
    db.prepare(
      `UPDATE upstream_keys
       SET balance_cents = ?, balance_currency = ?, balance_updated_at = ?,
           balance_source = 'manual', revision = revision + 1, updated_at = ?
       WHERE id = ?`,
    ).run(input.balance, currency, at, at, id);
  }

  const written = getKeyRow(db, id);
  if (!written) throw ApiError.notFound('Key', id);
  appendChange(db, 'balance', id, 'update', written.revision);
  // 手动录入也判（§20.4）：人工录一个 0 同样该锁 —— "人工核实"是把值**写得更准**，
  // 不是把判据关掉。方向反过来就荒谬了：认真核查后填入真实余额，反而逃过锁存。
  latchIfBalanceDepleted(db, written);
  // **判完再读一次**：锁存是这一步的结果，而 `written` 是判**之前**那一行的快照。
  // 拿它建 DTO 会让这次响应说"余额 0、未透支"—— 恰好是**唯一**一次能看见打标的响应
  // （调用方就是刚把钱录成 0 的那个人），却报了打标前的状态，`revision` 也少一格。
  const ctx = nowContext();
  const after = getKeyRow(db, id);
  if (!after) throw ApiError.notFound('Key', id);
  return toDto(after, ctx.nowMs, ctx.nowDay);
}

/**
 * 判据 + 落库的合并调用点（判定腿**通用**的那一句）。只对**写进来的非 NULL 值**判：
 * `balance_cents IS NULL` 是"未知"（ADR-0003），不是"没钱"。
 *
 * 两个判据各看各的列 —— 余额类看 `balance_cents`，套餐类看 `token_plan_remaining`。
 * 这里按 `category` 分派而不是两列都判：一把 balance 类 key 的
 * `token_plan_remaining` 是历史残留（改类别时没清干净），拿它去判会锁一把有钱的 key。
 */
function latchIfBalanceDepleted(db: Db, row: KeyRow): void {
  const depleted =
    row.category === 'balance'
      ? isBalanceDepleted({ unlimited: row.unlimited === 1, balanceCents: row.balance_cents })
      : isTokenPlanDepleted({ remainingTokens: row.token_plan_remaining });
  if (!depleted) return;
  // `DepletedReason` 只有两个值（§20.2 钉死）：套餐余量耗尽与余额不足**同一句话的事实**
  // （"这把 key 付不起账"），分两个值只会让前端多一个处理方式完全相同的分支。
  // 要区分看 `category`。ADR-0041 决策 8 的三值清单是笔误，契约 §20.2 为准。
  latchKeyDepleted(db, row.id, 'balance');
}

/**
 * 模板查询回写（C5：手动录入永远优先，所以这里只在模板路径显式调用时才覆盖）。
 *
 * 「取不到值」的分支是**真空操作**（契约 §14.2 / ADR-0017 决策 2）：不写金额（未知 ≠ 0），
 * 也**不推 `balance_updated_at`**。那个时间戳的全部价值就是"最近一次真的查到数的时刻"
 * （§14.3 `asOf`），把它推新等于把一条陈旧读数伪装成实时读数 —— 比不显示更坏。
 * 顺带也就没有 `change_log`：什么都没变，不该把网关叫醒重建一次快照。
 */
export function applyTemplateBalance(
  db: Db,
  id: string,
  value: { balanceCents: number | null; currency: string | null; remainingTokens?: number | null; expiresAt?: string | null },
): void {
  const at = nowIso();
  if (value.balanceCents === null) return;
  db.prepare(
    `UPDATE upstream_keys
     SET balance_cents = ?, balance_currency = ?, balance_updated_at = ?, balance_source = 'template',
         token_plan_remaining = COALESCE(?, token_plan_remaining),
         token_plan_expires_at = COALESCE(?, token_plan_expires_at),
         revision = revision + 1, updated_at = ?
     WHERE id = ?`,
  ).run(value.balanceCents, value.currency, at, value.remainingTokens ?? null, value.expiresAt ?? null, at, id);
  appendChange(db, 'balance', id, 'update', null);
  // 判定腿（§20.4）：按**刚写进去的值**判。重读一次而不是用 `value` —— COALESCE 之后
  // 库里的值可能与 `value` 不同（`remainingTokens` 为 null 时保留旧值），
  // 而锁存判的必须是**落库后的那一列**。
  const row = getKeyRow(db, id);
  if (row !== null) latchIfBalanceDepleted(db, row);
}

/**
 * token-plan 类的模板回写。
 *
 * 与 applyTemplateBalance 分开是因为两者的"未知"落在不同列上：
 * 金额未知是 balance_cents IS NULL，套餐余量未知是 token_plan_remaining 保持原值。
 * 合并成一个函数会让"这次到底改了哪一列"变得含糊，而这两列恰好是
 * 前端区分"没钱"与"不知道"的依据。
 *
 * 「一个字都没给」同样是**真空操作**，理由与 applyTemplateBalance 一字不差（§14.2）。
 */
export function applyTemplateTokenPlan(
  db: Db,
  id: string,
  value: { remainingTokens: number | null; expiresAt: string | null },
): void {
  const at = nowIso();
  if (value.remainingTokens === null && value.expiresAt === null) return;
  db.prepare(
    `UPDATE upstream_keys
     SET token_plan_remaining = COALESCE(?, token_plan_remaining),
         token_plan_expires_at = COALESCE(?, token_plan_expires_at),
         balance_updated_at = ?, updated_at = ?,
         revision = revision + 1
     WHERE id = ?`,
  ).run(value.remainingTokens, value.expiresAt, at, at, id);
  appendChange(db, 'balance', id, 'update', null);
  // 判定腿（§20.4）：同 applyTemplateBalance —— 重读落库后的那一列。
  // `remainingTokens === null` 时 COALESCE 保留旧值，而"上游没说用了多少"（NULL）
  // **不锁**：库里那时要么是旧值（照旧值判，正确），要么仍是 NULL（判据当场返回 false）。
  const row = getKeyRow(db, id);
  if (row !== null) latchIfBalanceDepleted(db, row);
}

/** 软删。保留行是为了让 usage_logs.key_id 外键仍有落点（契约 §0.4 / C4）。 */
export function deleteKey(db: Db, id: string): void {
  const current = getKeyRow(db, id);
  if (!current || current.deleted_at !== null) throw ApiError.notFound('Key', id);

  const at = nowIso();
  db.prepare(
    `UPDATE upstream_keys
     SET enabled = 0, deleted_at = ?, revision = revision + 1, updated_at = ?
     WHERE id = ?`,
  ).run(at, at, id);
  appendChange(db, 'key', id, 'delete', current.revision + 1);
}

export function batchSetEnabled(db: Db, ids: readonly string[], enabled: boolean): number {
  if (ids.length === 0) return 0;
  const at = nowIso();
  const placeholders = ids.map(() => '?').join(', ');
  const info = db
    .prepare(
      `UPDATE upstream_keys
       SET enabled = ?, revision = revision + 1, updated_at = ?
       WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    )
    .run(enabled ? 1 : 0, at, ...ids);
  if (info.changes > 0) appendChange(db, 'key', ids.join(','), 'update', null);
  return info.changes;
}

export interface DecryptedKeyRef {
  keyId: string;
  upstreamId: string;
  maskedKey: string;
  category: KeyCategory;
  /** 明文，仅供发起一次上游查询；调用方**不得**落盘/记日志/回显 */
  decrypted: string;
}

/**
 * 自测时"没指定 key"用哪一把：该上游第一把启用的余额类 key。
 *
 * 排序键与 `decryptedKeyRefs` 逐字一致（`created_at, id`）—— 两处不一致会让
 * "第一把"在自测与刷新里指向不同的 key，而用户看到的只是两个不同的余额。
 * 本函数只管诊断选谁，不参与网关的路由选 key（那套算法在 `src/gateway/`）。
 */
export function firstUsableBalanceKeyId(db: Db, upstreamId: string): string | null {
  const row = db
    .prepare(
      `SELECT id FROM upstream_keys
       WHERE upstream_id = ? AND deleted_at IS NULL AND enabled = 1 AND category = 'balance'
       ORDER BY created_at, id
       LIMIT 1`,
    )
    .get(upstreamId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * 余额刷新专用出口：解密出可用的 key 明文。
 *
 * 这是全仓极少数会拿到明文的函数之一，所以：
 *   - 只返回给调用方一个短生命周期对象，不缓存；
 *   - 调用方（balance refresh）在 finally 里不做任何序列化；
 *   - 该函数的返回类型刻意不带 `toJSON`，避免 JSON.stringify 顺手把它吐进日志。
 */
export function decryptedKeyRefs(db: Db, filter: { upstreamId?: string | undefined; keyIds?: readonly string[] | undefined }, masterKey: Buffer): DecryptedKeyRef[] {
  const where: string[] = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (filter.upstreamId !== undefined) {
    where.push('upstream_id = ?');
    params.push(filter.upstreamId);
  }
  if (filter.keyIds !== undefined && filter.keyIds.length > 0) {
    where.push(`id IN (${filter.keyIds.map(() => '?').join(', ')})`);
    params.push(...filter.keyIds);
  }
  const rows = db
    .prepare(`SELECT id, upstream_id, masked_key, category, secret FROM upstream_keys WHERE ${where.join(' AND ')} ORDER BY created_at, id`)
    .all(...params) as { id: string; upstream_id: string; masked_key: string; category: KeyCategory; secret: Buffer }[];

  return rows.map((r) => ({
    keyId: r.id,
    upstreamId: r.upstream_id,
    maskedKey: r.masked_key,
    category: r.category,
    decrypted: decryptSecret(r.secret, masterKey),
  }));
}
