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
import { listAuthorizedModelNames } from './group-models.js';
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

/**
 * 名称列（`gateway_keys.label`）的归一化。**只有这一个出口**，两个写入点
 * （签发时带名 / 事后改名）都走它 —— 两处各写一遍 trim 的失败形状是
 * "改名之后能清空、签发时清不掉"，同一个值在列表里长成两种样子。
 *
 * 空串与纯空白一律收成 `NULL`（= 没名字），而不是存一个 `''`：库里两种"空"
 * 并存之后，前端判空的那一句就得写两遍，而漏掉的那遍会把 `''` 渲染成一个
 * 看不见的 `<Tag>`（视觉上是"这里有东西但看不清"）。
 */
function normalizeLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const trimmed = label.trim();
  return trimmed === '' ? null : trimmed;
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
      `SELECT id, masked_key, label, created_at FROM gateway_keys
       WHERE group_id = ?
       ORDER BY created_at, id LIMIT ? OFFSET ?`,
    )
    .all(groupId, query.pageSize, (query.page - 1) * query.pageSize) as {
    id: string;
    masked_key: string;
    label: string | null;
    created_at: string;
  }[];

  return {
    items: rows.map((r) => ({
      id: r.id,
      maskedKey: r.masked_key,
      label: r.label,
      createdAt: r.created_at,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

function toDto(
  row: GroupRow,
  keys: { id: string; masked_key: string }[],
  usage: UsageRow,
  authorizedModels: string[] | null,
): GroupDto {
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
    authorizedModels,
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 单个组转 DTO 的**唯一入口** —— 三处读点（getGroup / findGroupByName / listGroups）都走它。
 *
 * 为什么要收成一个函数：`authorizedModels` 是**第 4 个每行查询**（前三个是 liveGatewayKeys /
 * todayUsage，加了它就是 +1）。四处各写一遍 ⇒ 早晚有一处忘掉，而那处的表现是
 * "这个端点的 Group 少了 authorizedModels"，一个只在某个页面看得见的字段缺失。
 */
function toDtoLoaded(db: Db, row: GroupRow): GroupDto {
  return toDto(
    row,
    liveGatewayKeys(db, row.id),
    todayUsage(db, row.id),
    listAuthorizedModelNames(db, row.id),
  );
}

export function getGroupRow(db: Db, id: string): GroupRow | null {
  return (db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined) ?? null;
}

export function getGroup(db: Db, id: string): GroupDto | null {
  const row = getGroupRow(db, id);
  if (!row) return null;
  return toDtoLoaded(db, row);
}

/** 按名字查组。`groups.name` 是 UNIQUE，所以最多一行。 */
export function findGroupByName(db: Db, name: string): GroupDto | null {
  const row = db.prepare('SELECT * FROM groups WHERE name = ?').get(name) as GroupRow | undefined;
  if (!row) return null;
  return toDtoLoaded(db, row);
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
    items: rows.map((r) => toDtoLoaded(db, r)),
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

  if (sets.length === 0) return toDtoLoaded(db, current);

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
  return toDtoLoaded(db, updated);
}

export function deleteGroup(db: Db, id: string): void {
  if (!getGroupRow(db, id)) throw ApiError.notFound('用户组', id);
  db.transaction(() => {
    // **指向 groups(id) 的外键有三处，三处都得先解开**，漏一处就恒 500：
    //   1. `gateway_keys.group_id`（NOT NULL）—— 子行先删。组没了，它的网关 key
    //      也必须失效：留着就是一把能通过鉴权但找不到组的凭据。
    //   2. `admin_users.group_id`（可空）—— 成员**置回未分配**，不是删账号。
    //      删组不该顺带销毁登录身份（那是用户管理页的职责），而 §19.2 / ADR-0034
    //      决策 5 已把 `NULL` 定义成合法可读的降级（消费面回空列表，不是报错），
    //      所以"未分配"是这里唯一正确的落点。
    //   3. `group_models.group_id`（v1.15.8 / ADR-0037）—— 授权直接删。它**不是**
    //      像成员那样"置回未分配"：授权只对这一个组有意义，组没了它就没有归属可言，
    //      留着是一行指向不存在的组的孤儿。这一条漏掉的表现同样是删组 500
    //      （`foreign_keys=ON`，全库无 ON DELETE 子句）。
    // 三处外键都**没有 ON DELETE 子句**（schema.ts 刻意如此）：删组时谁受什么影响
    // 由这里显式决定，不让 SQLite 的隐式行为在没人看的地方替我们决定。
    //
    // 曾经的顺序只删了 gateway_keys 就删 groups，于是"组里有用户"这条路径静默坏了：
    // 转发面不受影响，断的是用户组生命周期管理（画师实测到的 500）。回归用例见
    // api.spec.ts「组里挂着成员时删组」一组 —— 缺的正是这一条覆盖。
    db.prepare('DELETE FROM gateway_keys WHERE group_id = ?').run(id);
    db.prepare(
      'UPDATE admin_users SET group_id = NULL, updated_at = ? WHERE group_id = ?',
    ).run(nowIso(), id);
    db.prepare('DELETE FROM group_models WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    appendChange(db, 'group', id, 'delete', null);
  })();
}

/**
 * 签发一把新的网关 key。返回的 gatewayKey 是全仓唯一的明文出口。
 *
 * `label` 可选（v1.15.9）：消费面自助签发要让用户给 key 起个名，否则"哪把是给
 * 哪个客户端的"在列表里没有答案。管理面两个调用点（`createGroup` / `resetGatewayKey`）
 * 不传它 —— 它们的语义是"建组附赠一把"与"换掉这把"，不是"起个名"，
 * 默认 `NULL` 保持老行为逐字不变。
 */
export function issueGatewayKey(
  db: Db,
  groupId: string,
  label?: string | null | undefined,
): GatewayKeyIssuedDto {
  if (!getGroupRow(db, groupId)) throw ApiError.notFound('用户组', groupId);

  const secret = gatewayKeySecret();
  const id = newId('gatewayKey');
  const at = nowIso();
  const name = normalizeLabel(label);
  db.prepare(
    `INSERT INTO gateway_keys (id, group_id, key_hash, masked_key, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, groupId, sha256Hex(secret), maskKey(secret), name, at, at);
  appendChange(db, 'gateway_key', id, 'insert', null);

  return { id, gatewayKey: secret, maskedKey: maskKey(secret), label: name, createdAt: at };
}

/**
 * 当前组的 key 把数（护栏用，v1.15.9）。
 *
 * **为什么护栏要一个专门的点查而不是复用 `listGatewayKeys`**：那个函数先
 * `getGroupRow` 再数一遍、再拉一页行，三句 SQL 换一个数字。护栏在**签发之前**
 * 就要这个数，拿它当"能不能签发"的判据 —— 一句 `COUNT(*)` 就够，
 * 多查的行在这个位置上没有任何用途。
 */
export function countGatewayKeys(db: Db, groupId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM gateway_keys WHERE group_id = ?').get(groupId) as {
    n: number;
  }).n;
}

/**
 * 给一把 key 改名（v1.15.9 消费面自助）。
 *
 * `label` 可空：`null` / 空串 = 清掉名字。**返回改后的整行**（不是 void）——
 * 调用方（路由）要把它回给前端，而"回一个刚写进去的值"与"让前端自己拼一个
 * 大概的值"是两件事：后者在 trim 与空串归一化上与库不一致。
 *
 * 越权判据与 `deleteGatewayKey` 同形：`WHERE id = ? AND group_id = ?`，
 * `changes === 0` → 404（**不是 403** —— 不泄漏该 keyId 是否存在，§19.3 同一条）。
 */
export function renameGatewayKey(
  db: Db,
  groupId: string,
  keyId: string,
  label: string | null | undefined,
): GatewayKeyDto {
  const name = normalizeLabel(label);
  const info = db
    .prepare('UPDATE gateway_keys SET label = ?, updated_at = ? WHERE id = ? AND group_id = ?')
    .run(name, nowIso(), keyId, groupId);
  if (info.changes === 0) throw ApiError.notFound('网关 key', keyId);

  const row = db
    .prepare('SELECT id, masked_key, label, created_at FROM gateway_keys WHERE id = ?')
    .get(keyId) as { id: string; masked_key: string; label: string | null; created_at: string };
  appendChange(db, 'gateway_key', keyId, 'update', null);
  return {
    id: row.id,
    maskedKey: row.masked_key,
    label: row.label,
    createdAt: row.created_at,
  };
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
