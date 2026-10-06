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
 * 删除上游。
 * C4 裁决：force=true 时级联**软删**其下 key（enabled=0 + deletedAt），保留历史日志外键。
 * 硬删 key 会让 usage_logs.key_id 变成悬空外键，历史记录从此对不上账。
 */
export function deleteUpstream(db: Db, id: string, force: boolean): void {
  const row = getUpstreamRow(db, id);
  if (!row) throw ApiError.notFound('上游', id);

  const counts = countsByUpstream(db).get(id) ?? { keyCount: 0, enabledKeyCount: 0 };
  if (counts.keyCount > 0 && !force) {
    throw new ApiError('UPSTREAM_HAS_KEYS', '该上游下仍有 key，删除会一并停用它们', {
      keyCount: counts.keyCount,
    });
  }

  const at = nowIso();
  db.transaction(() => {
    if (counts.keyCount > 0) {
      db.prepare(
        `UPDATE upstream_keys
         SET enabled = 0, deleted_at = ?, revision = revision + 1, updated_at = ?
         WHERE upstream_id = ? AND deleted_at IS NULL`,
      ).run(at, at, id);
      appendChange(db, 'key', id, 'update', null);
    }
    db.prepare('DELETE FROM upstreams WHERE id = ?').run(id);
    appendChange(db, 'upstream', id, 'delete', null);
  })();
}
