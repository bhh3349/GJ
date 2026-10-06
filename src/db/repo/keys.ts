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
import { newId } from '../ids.js';
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
  balance_cents: number | null;
  balance_currency: string | null;
  balance_updated_at: string | null;
  balance_source: 'manual' | 'template' | null;
  token_plan_remaining: number | null;
  token_plan_expires_at: string | null;
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
}

export function createKey(db: Db, input: CreateKeyInput, masterKey: Buffer): KeyDto {
  const upstream = db.prepare('SELECT id FROM upstreams WHERE id = ?').get(input.upstreamId);
  if (!upstream) throw ApiError.invalidParam('upstreamId', '上游不存在');

  const id = newId('key');
  const at = nowIso();
  const masked = maskKey(input.key);
  const blob = encryptSecret(input.key, masterKey);
  const isBalance = input.category === 'balance';

  try {
    db.prepare(
      `INSERT INTO upstream_keys (
         id, upstream_id, label, masked_key, secret, category, enabled, weight,
         balance_cents, balance_currency, balance_updated_at, balance_source,
         token_plan_remaining, token_plan_expires_at,
         today_tokens, today_day, revision, deleted_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1, NULL, ?, ?)`,
    ).run(
      id,
      input.upstreamId,
      input.label ?? masked,
      masked,
      blob,
      input.category,
      input.weight ?? 1,
      isBalance ? (input.balance ?? null) : null,
      isBalance ? 'CNY' : null,
      isBalance && input.balance !== undefined && input.balance !== null ? at : null,
      isBalance && input.balance !== undefined && input.balance !== null ? 'manual' : null,
      isBalance ? null : (input.tokenPlan?.remainingTokens ?? null),
      isBalance ? null : (input.tokenPlan?.expiresAt ?? null),
      utcDay(),
      at,
      at,
    );
  } catch (err) {
    throw translateWriteError(err, 'upstreamId');
  }

  appendChange(db, 'key', id, 'insert', 1);
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
  const ctx = nowContext();
  return toDto(updated, ctx.nowMs, ctx.nowDay);
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

  const updated = getKeyRow(db, id);
  if (!updated) throw ApiError.notFound('Key', id);
  appendChange(db, 'balance', id, 'update', updated.revision);
  const ctx = nowContext();
  return toDto(updated, ctx.nowMs, ctx.nowDay);
}

/** 模板查询回写（C5：手动录入永远优先，所以这里只在模板路径显式调用时才覆盖）。 */
export function applyTemplateBalance(
  db: Db,
  id: string,
  value: { balanceCents: number | null; currency: string | null; remainingTokens?: number | null; expiresAt?: string | null },
): void {
  const at = nowIso();
  if (value.balanceCents === null) {
    // 查不到 ≠ 0：保持"未知"，只更新查询时间，不改 balance_source
    db.prepare('UPDATE upstream_keys SET balance_updated_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
    appendChange(db, 'balance', id, 'update', null);
    return;
  }
  db.prepare(
    `UPDATE upstream_keys
     SET balance_cents = ?, balance_currency = ?, balance_updated_at = ?, balance_source = 'template',
         token_plan_remaining = COALESCE(?, token_plan_remaining),
         token_plan_expires_at = COALESCE(?, token_plan_expires_at),
         revision = revision + 1, updated_at = ?
     WHERE id = ?`,
  ).run(value.balanceCents, value.currency, at, value.remainingTokens ?? null, value.expiresAt ?? null, at, id);
  appendChange(db, 'balance', id, 'update', null);
}

/**
 * token-plan 类的模板回写。
 *
 * 与 applyTemplateBalance 分开是因为两者的"未知"落在不同列上：
 * 金额未知是 balance_cents IS NULL，套餐余量未知是 token_plan_remaining 保持原值。
 * 合并成一个函数会让"这次到底改了哪一列"变得含糊，而这两列恰好是
 * 前端区分"没钱"与"不知道"的依据。
 */
export function applyTemplateTokenPlan(
  db: Db,
  id: string,
  value: { remainingTokens: number | null; expiresAt: string | null },
): void {
  const at = nowIso();
  if (value.remainingTokens === null && value.expiresAt === null) {
    // 上游没给余量：保持"未知"，只记一次查询时间
    db.prepare('UPDATE upstream_keys SET balance_updated_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
    appendChange(db, 'balance', id, 'update', null);
    return;
  }
  db.prepare(
    `UPDATE upstream_keys
     SET token_plan_remaining = COALESCE(?, token_plan_remaining),
         token_plan_expires_at = COALESCE(?, token_plan_expires_at),
         balance_updated_at = ?, updated_at = ?,
         revision = revision + 1
     WHERE id = ?`,
  ).run(value.remainingTokens, value.expiresAt, at, at, id);
  appendChange(db, 'balance', id, 'update', null);
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
