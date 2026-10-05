// 用户组仓储。契约 §4。
//
// 网关 key 明文纪律（本文件最重要的一条）：
//   明文只在 createGroup / issueGatewayKey / resetGatewayKey 的**返回值**里出现一次，
//   库内只留 sha256 摘要 + maskedKey。没有任何函数能"再取回"明文 ——
//   不是靠约定，是根本没有那条代码路径。
//
// 滑动续期、配额计数都在这里读；配额**判定**在网关侧（M3），管理面只报用量。

import { ApiError } from '../../api/errors.js';
import type { GatewayKeyDto, GatewayKeyIssuedDto, GroupDto, Page } from '../../api/dto.js';
import { nowIso, utcDay } from '../../util/time.js';
import { maskKey, sha256Hex } from '../crypto.js';
import type { Db } from '../database.js';
import { gatewayKeySecret, newId } from '../ids.js';
import { appendChange } from './change-log.js';
import { translateWriteError } from './write-errors.js';

interface GroupRow {
  id: string;
  name: string;
  rpm: number | null;
  tpm: number | null;
  daily_quota: number | null;
  enabled: number;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface UsageRow {
  requests: number;
  tokens: number;
  costCents: number;
}

function todayUsage(db: Db, groupId: string): UsageRow {
  const dayStart = `${utcDay()}T00:00:00.000Z`;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(total_tokens), 0) AS tokens,
              COALESCE(SUM(cost_cents), 0)   AS costCents
       FROM usage_logs
       WHERE group_id = ? AND ts >= ?`,
    )
    .get(groupId, dayStart) as UsageRow | undefined;
  return row ?? { requests: 0, tokens: 0, costCents: 0 };
}

/** 该组的网关 key 摘要。顺序固定（created_at, id），保证 gatewayKeyMasked 稳定。 */
function liveGatewayKeys(db: Db, groupId: string): { id: string; masked_key: string }[] {
  return db
    .prepare(
      `SELECT id, masked_key FROM gateway_keys
       WHERE group_id = ?
       ORDER BY created_at, id`,
    )
    .all(groupId) as { id: string; masked_key: string }[];
}

export interface ListGatewayKeysQuery {
  page: number;
  pageSize: number;
}

/**
 * 网关 key 列表（契约 §4 `GET /api/groups/:id/keys`）。
 *
 * 排序必须与 `liveGatewayKeys` **逐字一致**：契约承诺列表第一项的 maskedKey 恒等于
 * `Group.gatewayKeyMasked`，两处 ORDER BY 一旦分开演化，这条承诺就会在某一版里悄悄失效。
 * 所以下面那句 SQL 是故意复制而不是抽公共前缀 —— 复制的是会被 diff 看见的东西。
 */
export function listGatewayKeys(
  db: Db,
  groupId: string,
  query: ListGatewayKeysQuery,
): Page<GatewayKeyDto> {
  if (!getGroupRow(db, groupId)) throw ApiError.notFound('用户组', groupId);

  const total = (
    db
      .prepare('SELECT COUNT(*) AS n FROM gateway_keys WHERE group_id = ?')
      .get(groupId) as { n: number }
  ).n;
  const rows = db
    .prepare(
      `SELECT id, masked_key, created_at FROM gateway_keys
       WHERE group_id = ?
       ORDER BY created_at, id LIMIT ? OFFSET ?`,
    )
    .all(groupId, query.pageSize, (query.page - 1) * query.pageSize) as {
    id: string;
    masked_key: string;
    created_at: string;
  }[];

  return {
    items: rows.map((r) => ({ id: r.id, maskedKey: r.masked_key, createdAt: r.created_at })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

function toDto(row: GroupRow, keys: { id: string; masked_key: string }[], usage: UsageRow): GroupDto {
  return {
    id: row.id,
    name: row.name,
    gatewayKeyMasked: keys[0]?.masked_key ?? null,
    rpm: row.rpm,
    tpm: row.tpm,
    dailyQuota: row.daily_quota,
    dailyQuotaUsed: usage.tokens,
    todayUsage: usage,
    keyCount: keys.length,
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getGroupRow(db: Db, id: string): GroupRow | null {
  return (db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined) ?? null;
}

export function getGroup(db: Db, id: string): GroupDto | null {
  const row = getGroupRow(db, id);
  if (!row) return null;
  return toDto(row, liveGatewayKeys(db, id), todayUsage(db, id));
}

export interface ListGroupsQuery {
  q?: string | undefined;
  page: number;
  pageSize: number;
}

export function listGroups(db: Db, query: ListGroupsQuery): Page<GroupDto> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.q !== undefined && query.q !== '') {
    where.push('name LIKE ?');
    params.push(`%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM groups ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM groups ${clause} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as GroupRow[];

  return {
    items: rows.map((r) => toDto(r, liveGatewayKeys(db, r.id), todayUsage(db, r.id))),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export interface CreateGroupInput {
  name: string;
  rpm?: number | null | undefined;
  tpm?: number | null | undefined;
  dailyQuota?: number | null | undefined;
}

export interface CreateGroupResult {
  group: GroupDto;
  /** 明文，仅此一次 */
  gatewayKey: GatewayKeyIssuedDto;
}

/** C1 裁决：建组即自动签发第一把网关 key，明文仅在创建响应出现一次。 */
export function createGroup(db: Db, input: CreateGroupInput): CreateGroupResult {
  const id = newId('group');
  const at = nowIso();
  try {
    db.prepare(
      `INSERT INTO groups (id, name, rpm, tpm, daily_quota, enabled, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    ).run(id, input.name, input.rpm ?? null, input.tpm ?? null, input.dailyQuota ?? null, at, at);
  } catch (err) {
    throw translateWriteError(err, 'name');
  }
  appendChange(db, 'group', id, 'insert', 1);

  const issued = issueGatewayKey(db, id);
  const group = getGroup(db, id);
  if (!group) throw new ApiError('INTERNAL', '创建后读取失败');
  return { group, gatewayKey: issued };
}

export interface UpdateGroupInput {
  name?: string | undefined;
  rpm?: number | null | undefined;
  tpm?: number | null | undefined;
  dailyQuota?: number | null | undefined;
  enabled?: boolean | undefined;
  revision: number;
}

export function updateGroup(db: Db, id: string, patch: UpdateGroupInput): GroupDto {
  const current = getGroupRow(db, id);
  if (!current) throw ApiError.notFound('用户组', id);

  const sets: string[] = [];
  const params: unknown[] = [];
  // null 是**有效值**（= 不限），所以判空用 `!== undefined` 而不是真值判断。
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.rpm !== undefined) {
    sets.push('rpm = ?');
    params.push(patch.rpm);
  }
  if (patch.tpm !== undefined) {
    sets.push('tpm = ?');
    params.push(patch.tpm);
  }
  if (patch.dailyQuota !== undefined) {
    sets.push('daily_quota = ?');
    params.push(patch.dailyQuota);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }

  if (sets.length === 0) return toDto(current, liveGatewayKeys(db, id), todayUsage(db, id));

  sets.push('revision = revision + 1', 'updated_at = ?');
  params.push(nowIso());

  try {
    const info = db
      .prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ? AND revision = ?`)
      .run(...params, id, patch.revision);
    if (info.changes === 0) {
      const still = getGroupRow(db, id);
      if (!still) throw ApiError.notFound('用户组', id);
      throw new ApiError('REVISION_MISMATCH', '该用户组已被他人修改，请刷新后重试', {
        expected: patch.revision,
        actual: still.revision,
      });
    }
  } catch (err) {
    throw translateWriteError(err, 'name');
  }

  const updated = getGroupRow(db, id);
  if (!updated) throw ApiError.notFound('用户组', id);
  appendChange(db, 'group', id, 'update', updated.revision);
  return toDto(updated, liveGatewayKeys(db, id), todayUsage(db, id));
}

export function deleteGroup(db: Db, id: string): void {
  if (!getGroupRow(db, id)) throw ApiError.notFound('用户组', id);
  db.transaction(() => {
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    // 组没了，它的网关 key 也必须失效 —— 留着就是一把能通过鉴权但找不到组的凭据。
    db.prepare('DELETE FROM gateway_keys WHERE group_id = ?').run(id);
    appendChange(db, 'group', id, 'delete', null);
  })();
}

/** 签发一把新的网关 key。返回的 gatewayKey 是全仓唯一的明文出口。 */
export function issueGatewayKey(db: Db, groupId: string): GatewayKeyIssuedDto {
  if (!getGroupRow(db, groupId)) throw ApiError.notFound('用户组', groupId);

  const secret = gatewayKeySecret();
  const id = newId('gatewayKey');
  const at = nowIso();
  db.prepare(
    `INSERT INTO gateway_keys (id, group_id, key_hash, masked_key, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(id, groupId, sha256Hex(secret), maskKey(secret), at, at);
  appendChange(db, 'gateway_key', id, 'insert', null);

  return { id, gatewayKey: secret, maskedKey: maskKey(secret), createdAt: at };
}

/** 重置：旧 key **立即失效**（契约 §4）。实现上是删旧行 + 插新行，同一事务。 */
export function resetGatewayKey(db: Db, groupId: string, keyId: string): GatewayKeyIssuedDto {
  const row = db
    .prepare('SELECT id FROM gateway_keys WHERE id = ? AND group_id = ?')
    .get(keyId, groupId);
  if (!row) throw ApiError.notFound('网关 key', keyId);

  let issued: GatewayKeyIssuedDto | null = null;
  db.transaction(() => {
    db.prepare('DELETE FROM gateway_keys WHERE id = ?').run(keyId);
    appendChange(db, 'gateway_key', keyId, 'delete', null);
    issued = issueGatewayKey(db, groupId);
  })();
  if (!issued) throw new ApiError('INTERNAL', '重置失败');
  return issued;
}

export function deleteGatewayKey(db: Db, groupId: string, keyId: string): void {
  const info = db
    .prepare('DELETE FROM gateway_keys WHERE id = ? AND group_id = ?')
    .run(keyId, groupId);
  if (info.changes === 0) throw ApiError.notFound('网关 key', keyId);
  appendChange(db, 'gateway_key', keyId, 'delete', null);
}

/** 网关鉴权用：按明文摘要查组。明文不落盘，所以只能这样查。 */
export function findGroupByGatewayKeyHash(db: Db, hash: string): GroupRow | null {
  const row = db
    .prepare(
      `SELECT g.* FROM gateway_keys k
       JOIN groups g ON g.id = k.group_id
       WHERE k.key_hash = ?`,
    )
    .get(hash) as GroupRow | undefined;
  return row ?? null;
}
