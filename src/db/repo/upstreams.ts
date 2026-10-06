// 上游仓储。契约 §2。
//
// 写路径统一遵守两条纪律：
//   1. 乐观锁：客户端带 revision，UPDATE ... WHERE revision = ?。
//      受影响行数为 0 时**必须再查一次**区分"不存在"与"版本不符"——
//      直接回 REVISION_MISMATCH 会让删除竞态变成一个误导性的错误。
//   2. 每次写都递增 revision 并写 change_log，网关据此感知变更。

import { ApiError } from '../../api/errors.js';
import type { BalancePresetDto, Page, UpstreamDto } from '../../api/dto.js';
import { findPresetByBaseUrl } from '../../balance/preset.js';
import { nowIso } from '../../util/time.js';
import { computeGlobalBalance } from '../balance.js';
import {
  DEFAULT_BALANCE_QUERY,
  normalizeBalanceQuery,
  serializeBalanceQuery,
  type BalanceQueryTemplate,
} from '../balance-query.js';
import type { Db } from '../database.js';
import { newId } from '../ids.js';
import { appendChange } from './change-log.js';
import { translateWriteError } from './write-errors.js';

interface UpstreamRow {
  id: string;
  name: string;
  base_url: string;
  enabled: number;
  balance_query: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface CountRow {
  id: string;
  keyCount: number;
  enabledKeyCount: number;
}

const COUNTS_SQL = `
SELECT upstream_id AS id,
       COUNT(*) AS keyCount,
       COUNT(CASE WHEN enabled = 1 THEN 1 END) AS enabledKeyCount
FROM upstream_keys
WHERE deleted_at IS NULL
GROUP BY upstream_id
`;

function countsByUpstream(db: Db): Map<string, { keyCount: number; enabledKeyCount: number }> {
  const rows = db.prepare(COUNTS_SQL).all() as CountRow[];
  return new Map(rows.map((r) => [r.id, { keyCount: r.keyCount, enabledKeyCount: r.enabledKeyCount }]));
}

function toDto(
  row: UpstreamRow,
  counts: Map<string, { keyCount: number; enabledKeyCount: number }>,
  balance: Map<string, { totalBalance: number | null; unknown: number; tokenPlan: number }>,
): UpstreamDto {
  const c = counts.get(row.id) ?? { keyCount: 0, enabledKeyCount: 0 };
  const b = balance.get(row.id) ?? { totalBalance: null, unknown: 0, tokenPlan: 0 };
  const template = normalizeBalanceQuery(JSON.parse(row.balance_query) as unknown);
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    enabled: row.enabled === 1,
    keyCount: c.keyCount,
    enabledKeyCount: c.enabledKeyCount,
    totalBalance: b.totalBalance,
    balanceUnknownKeyCount: b.unknown,
    tokenPlanKeyCount: b.tokenPlan,
    balanceQuery: template,
    // 只读、可推导：preset 从不落库，这里每次现算。命中与否只看 host，
    // `effective` 才是"当前真正生效的是它吗"——用户模板一启用，它就变成 false。
    balancePreset: balancePresetOf(row.base_url, template),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function balancePresetOf(baseUrl: string, template: BalanceQueryTemplate): BalancePresetDto | null {
  const preset = findPresetByBaseUrl(baseUrl);
  if (preset === null) return null;
  return { id: preset.id, label: preset.label, matchedBy: 'host', effective: !template.enabled };
}

function balanceIndex(db: Db): Map<string, { totalBalance: number | null; unknown: number; tokenPlan: number }> {
  const all = computeGlobalBalance(db);
  return new Map(
    all.byUpstream.map((u) => [
      u.upstreamId,
      { totalBalance: u.totalBalance, unknown: u.balanceUnknownKeyCount, tokenPlan: u.tokenPlanKeyCount },
    ]),
  );
}

export function getUpstreamRow(db: Db, id: string): UpstreamRow | null {
  return (db.prepare('SELECT * FROM upstreams WHERE id = ?').get(id) as UpstreamRow | undefined) ?? null;
}

/**
 * 全部上游的 `id + name`（不分页、不做 q/enabled 过滤）。余额自动同步的调度与
 * §14.3 的运行态列表用它。
 *
 * **刻意不看 `enabled`**：禁用只影响 `/v1/*` 选路，不影响"这个上游还剩多少钱"。
 * 把禁用上游排除在外还会制造一个静默错：它被禁用正是因为没钱了，而余额从此不再更新，
 * 于是"什么时候能重新启用"这个问题永远答不上来。
 */
export function listUpstreamIdsAndNames(db: Db): { id: string; name: string }[] {
  return db.prepare('SELECT id, name FROM upstreams ORDER BY name').all() as { id: string; name: string }[];
}

export function getUpstream(db: Db, id: string): UpstreamDto | null {
  const row = getUpstreamRow(db, id);
  if (!row) return null;
  return toDto(row, countsByUpstream(db), balanceIndex(db));
}

export interface ListUpstreamsQuery {
  q?: string | undefined;
  enabled?: boolean | undefined;
  page: number;
  pageSize: number;
}

export function listUpstreams(db: Db, query: ListUpstreamsQuery): Page<UpstreamDto> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.q !== undefined && query.q !== '') {
    where.push('(name LIKE ? OR base_url LIKE ?)');
    // 转义 LIKE 通配符，否则用户搜 `%` 会命中全部 —— 看起来像"搜索坏了"
    const like = `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like);
  }
  if (query.enabled !== undefined) {
    where.push('enabled = ?');
    params.push(query.enabled ? 1 : 0);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM upstreams ${clause}`).get(...params) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT * FROM upstreams ${clause} ORDER BY name LIMIT ? OFFSET ?`,
    )
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as UpstreamRow[];

  const counts = countsByUpstream(db);
  const balance = balanceIndex(db);
  return {
    items: rows.map((r) => toDto(r, counts, balance)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export interface CreateUpstreamInput {
  name: string;
  baseUrl: string;
  enabled?: boolean | undefined;
  balanceQuery?: unknown;
}

export function createUpstream(db: Db, input: CreateUpstreamInput): UpstreamDto {
  const id = newId('upstream');
  const at = nowIso();
  const template: BalanceQueryTemplate =
    input.balanceQuery === undefined
      ? { ...DEFAULT_BALANCE_QUERY }
      : normalizeBalanceQuery(input.balanceQuery);

  try {
    db.prepare(
      `INSERT INTO upstreams (id, name, base_url, enabled, balance_query, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(id, input.name, input.baseUrl, input.enabled === false ? 0 : 1, serializeBalanceQuery(template), at, at);
  } catch (err) {
    throw translateWriteError(err, 'name');
  }
  appendChange(db, 'upstream', id, 'insert', 1);
  const created = getUpstream(db, id);
  if (!created) throw new ApiError('INTERNAL', '创建后读取失败');
  return created;
}

export interface UpdateUpstreamInput {
  name?: string | undefined;
  baseUrl?: string | undefined;
  enabled?: boolean | undefined;
  balanceQuery?: unknown;
  revision: number;
}

export function updateUpstream(db: Db, id: string, patch: UpdateUpstreamInput): UpstreamDto {
  const current = getUpstreamRow(db, id);
  if (!current) throw ApiError.notFound('上游', id);

  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.baseUrl !== undefined) {
    sets.push('base_url = ?');
    params.push(patch.baseUrl);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.balanceQuery !== undefined) {
    sets.push('balance_query = ?');
    params.push(serializeBalanceQuery(normalizeBalanceQuery(patch.balanceQuery)));
  }

  if (sets.length === 0) return toDto(current, countsByUpstream(db), balanceIndex(db));

  sets.push('revision = revision + 1', 'updated_at = ?');
  params.push(nowIso());

  // 乐观锁：revision 在 WHERE 里，写和判断是同一条语句，中间没有可乘之机
  const info = db
    .prepare(`UPDATE upstreams SET ${sets.join(', ')} WHERE id = ? AND revision = ?`)
    .run(...params, id, patch.revision);

  if (info.changes === 0) {
    // 再查一次：不是"版本不符"，而是"这一行已经没了"
    if (!getUpstreamRow(db, id)) throw ApiError.notFound('上游', id);
    throw new ApiError('REVISION_MISMATCH', '上游已被他人修改，请刷新后重试', {
      expected: patch.revision,
      actual: current.revision,
    });
  }

  const updated = getUpstreamRow(db, id);
  if (!updated) throw ApiError.notFound('上游', id);
  appendChange(db, 'upstream', id, 'update', updated.revision);
  return toDto(updated, countsByUpstream(db), balanceIndex(db));
}

/**
 * 该上游下的**全部** key id，含已软删的。
 *
 * 必须含软删：`upstream_keys.upstream_id REFERENCES upstreams(id)` 是**行级**约束，
 * 软删（`deleted_at` 置值）并不解除它 —— 只要还有一行 key 指着上游，上游行就删不掉。
 */
function listUpstreamKeyIds(db: Db, upstreamId: string): string[] {
  return (
    db.prepare('SELECT id FROM upstream_keys WHERE upstream_id = ?').all(upstreamId) as { id: string }[]
  ).map((r) => r.id);
}

/** 该上游下的模型档案 id。 */
function listUpstreamModelIds(db: Db, upstreamId: string): string[] {
  return (
    db.prepare('SELECT id FROM models WHERE upstream_id = ?').all(upstreamId) as { id: string }[]
  ).map((r) => r.id);
}

/**
 * 删除上游：**整棵子树物理删除**（ADR-0016，修订 C4 的 key 处置）。
 *
 * 为什么不能像 C4 原文那样"软删 key + 硬删上游行"：`upstream_keys.upstream_id`
 * 与 `models.upstream_id` 都是 `REFERENCES upstreams(id)` 且 `foreign_keys=ON`，
 * **软删不解除行级外键** —— 上游下只要还有一行 key（哪怕已软删）或一行模型，
 * `DELETE FROM upstreams` 就直接 `SQLITE_CONSTRAINT_FOREIGNKEY`（画师实测到的 500）。
 *
 * 所以这里按依赖序硬删：`key_runtime`（指向 key）→ `upstream_keys` → `models` → `upstreams`，
 * 单事务内完成，并为每个实体发一条 change_log（网关快照按 entity 增量重建）。
 * 顺序不是风格问题：先删运行态镜像，否则删 key 那一步必违约。
 *
 * 历史可读性不依赖这些行：`usage_logs` 把 `key_masked` / `model` 名字**存在日志行自己身上**
 * （表里 `key_id` / `upstream_id` 本就没有外键声明），删行不会让历史"对不上账"；
 * 删除动作由 `audit_log` 留痕（与 ADR-0008 对网关 key 的处理同构）。代价是
 * **管理员在档案卡上手改的开关 / 价格会随档案一起消失**，所以 `force!=true` 时
 * key 与模型一起拦，`details` 两个计数都给，前端二次确认必须把数量说清。
 */
export function deleteUpstream(db: Db, id: string, force: boolean): void {
  const row = getUpstreamRow(db, id);
  if (!row) throw ApiError.notFound('上游', id);

  const counts = countsByUpstream(db).get(id) ?? { keyCount: 0, enabledKeyCount: 0 };
  const modelIds = listUpstreamModelIds(db, id);

  if ((counts.keyCount > 0 || modelIds.length > 0) && !force) {
    throw new ApiError('UPSTREAM_HAS_KEYS', '该上游下仍有从属资源：继续删除会一并删除其 key 与模型档案', {
      keyCount: counts.keyCount,
      modelCount: modelIds.length,
    });
  }

  db.transaction(() => {
    const keyIds = listUpstreamKeyIds(db, id);
    if (keyIds.length > 0) {
      db.prepare(
        'DELETE FROM key_runtime WHERE key_id IN (SELECT id FROM upstream_keys WHERE upstream_id = ?)',
      ).run(id);
      db.prepare('DELETE FROM upstream_keys WHERE upstream_id = ?').run(id);
      for (const keyId of keyIds) appendChange(db, 'key', keyId, 'delete', null);
    }
    if (modelIds.length > 0) {
      db.prepare('DELETE FROM models WHERE upstream_id = ?').run(id);
      for (const modelId of modelIds) appendChange(db, 'model', modelId, 'delete', null);
    }
    db.prepare('DELETE FROM upstreams WHERE id = ?').run(id);
    appendChange(db, 'upstream', id, 'delete', null);
  })();
}
