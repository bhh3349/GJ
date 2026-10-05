// 模型档案仓储。契约 §5。
//
// `availableKeyIds` 的口径必须与网关 KeyPool 的选路候选**逐项一致**：
// 验收第 4 条要求 `/v1/models` 与「模型档案 enabled=true」0 差异，
// 前端档案卡上的"可用 key"如果和网关实际会用的 key 不同，这个页面就是在骗人。
//
// 所以可用性判据在这里只写一份，M3 的 snapshot 构造必须复用同一个函数。

import { ApiError } from '../../api/errors.js';
import type { ModelCapability, ModelDto, ModelType, Page } from '../../api/dto.js';
import { nowIso } from '../../util/time.js';
import type { Db } from '../database.js';
import { newId } from '../ids.js';
import { appendChange } from './change-log.js';
import { translateWriteError } from './write-errors.js';

interface ModelRow {
  id: string;
  name: string;
  display_name: string | null;
  upstream_id: string;
  type: ModelType;
  capabilities: string;
  context_length: number | null;
  price_input_per_1k: number | null;
  price_output_per_1k: number | null;
  enabled: number;
  last_synced_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
}

const SELECT_BASE = 'SELECT * FROM models';

function parseCapabilities(raw: string): ModelCapability[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed.filter((c) => typeof c === 'string') as ModelCapability[]) : [];
  } catch {
    return [];
  }
}

/**
 * 「可服务」判据（与网关 KeyPool 一致）：
 *   已启用、未软删、不在冷却中，且额度未被证伪 ——
 *   余额/套餐余量为 `null` 表示**未知**，未知仍参与选路（未知 ≠ 0），所以放行；
 *   只有明确 `<= 0` 才排除。
 */
const AVAILABLE_KEYS_SQL = `
SELECT k.upstream_id AS upstreamId, k.id AS id
FROM upstream_keys k
LEFT JOIN key_runtime r ON r.key_id = k.id
WHERE k.deleted_at IS NULL
  AND k.enabled = 1
  AND (r.cooldown_until IS NULL OR r.cooldown_until <= ?)
  AND (
        (k.category = 'balance'    AND (k.balance_cents IS NULL OR k.balance_cents > 0))
     OR (k.category = 'token-plan' AND (k.token_plan_remaining IS NULL OR k.token_plan_remaining > 0))
  )
ORDER BY k.id
`;

/** 一次算出所有上游的可用 key，避免模型列表 N+1。 */
export function availableKeysByUpstream(db: Db, nowIsoStr = new Date().toISOString()): Map<string, string[]> {
  const rows = db.prepare(AVAILABLE_KEYS_SQL).all(nowIsoStr) as { upstreamId: string; id: string }[];
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.upstreamId) ?? [];
    list.push(r.id);
    map.set(r.upstreamId, list);
  }
  return map;
}

function toDto(row: ModelRow, availability: Map<string, string[]>): ModelDto {
  const price =
    row.price_input_per_1k === null && row.price_output_per_1k === null
      ? null
      : { inputPer1k: row.price_input_per_1k, outputPer1k: row.price_output_per_1k };
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    upstreamId: row.upstream_id,
    type: row.type,
    capabilities: parseCapabilities(row.capabilities),
    contextLength: row.context_length,
    price,
    availableKeyIds: availability.get(row.upstream_id) ?? [],
    enabled: row.enabled === 1,
    lastSyncedAt: row.last_synced_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getModelRow(db: Db, id: string): ModelRow | null {
  return (db.prepare(`${SELECT_BASE} WHERE id = ?`).get(id) as ModelRow | undefined) ?? null;
}

export function getModel(db: Db, id: string): ModelDto | null {
  const row = getModelRow(db, id);
  if (!row) return null;
  return toDto(row, availableKeysByUpstream(db));
}

export interface ListModelsQuery {
  upstreamId?: string | undefined;
  type?: ModelType | undefined;
  capability?: ModelCapability | undefined;
  enabled?: boolean | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
}

export function listModels(db: Db, query: ListModelsQuery): Page<ModelDto> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (query.upstreamId !== undefined) {
    where.push('upstream_id = ?');
    params.push(query.upstreamId);
  }
  if (query.type !== undefined) {
    where.push('type = ?');
    params.push(query.type);
  }
  if (query.enabled !== undefined) {
    where.push('enabled = ?');
    params.push(query.enabled ? 1 : 0);
  }
  if (query.capability !== undefined) {
    // capabilities 是 JSON 数组。用 LIKE 匹配 `"x"` 而不是裸 x，
    // 否则搜 `stream` 会命中 `streaming` 之类的子串，筛选结果看起来对不上。
    where.push('capabilities LIKE ?');
    params.push(`%"${query.capability}"%`);
  }
  if (query.q !== undefined && query.q !== '') {
    where.push('(name LIKE ? OR display_name LIKE ?)');
    const like = `%${query.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(like, like);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM models ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`${SELECT_BASE} ${clause} ORDER BY name, id LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as ModelRow[];

  const availability = availableKeysByUpstream(db);
  return {
    items: rows.map((r) => toDto(r, availability)),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export interface UpdateModelInput {
  enabled?: boolean | undefined;
  type?: ModelType | undefined;
  capabilities?: ModelCapability[] | undefined;
  contextLength?: number | null | undefined;
  price?: { inputPer1k: number | null; outputPer1k: number | null } | null | undefined;
  displayName?: string | null | undefined;
  revision: number;
}

export function updateModel(db: Db, id: string, patch: UpdateModelInput): ModelDto {
  const current = getModelRow(db, id);
  if (!current) throw ApiError.notFound('模型', id);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.type !== undefined) {
    sets.push('type = ?');
    params.push(patch.type);
  }
  if (patch.capabilities !== undefined) {
    sets.push('capabilities = ?');
    params.push(JSON.stringify(patch.capabilities));
  }
  if (patch.contextLength !== undefined) {
    sets.push('context_length = ?');
    params.push(patch.contextLength);
  }
  if (patch.price !== undefined) {
    sets.push('price_input_per_1k = ?', 'price_output_per_1k = ?');
    params.push(patch.price?.inputPer1k ?? null, patch.price?.outputPer1k ?? null);
  }
  if (patch.displayName !== undefined) {
    sets.push('display_name = ?');
    params.push(patch.displayName);
  }

  if (sets.length === 0) return toDto(current, availableKeysByUpstream(db));

  sets.push('revision = revision + 1', 'updated_at = ?');
  params.push(nowIso());

  const info = db
    .prepare(`UPDATE models SET ${sets.join(', ')} WHERE id = ? AND revision = ?`)
    .run(...params, id, patch.revision);
  if (info.changes === 0) {
    const still = getModelRow(db, id);
    if (!still) throw ApiError.notFound('模型', id);
    throw new ApiError('REVISION_MISMATCH', '该模型已被他人修改，请刷新后重试', {
      expected: patch.revision,
      actual: still.revision,
    });
  }

  const updated = getModelRow(db, id);
  if (!updated) throw ApiError.notFound('模型', id);
  appendChange(db, 'model', id, 'update', updated.revision);
  return toDto(updated, availableKeysByUpstream(db));
}

export interface SyncedModel {
  upstreamId: string;
  name: string;
  displayName: string | null;
  type: ModelType;
  capabilities: ModelCapability[];
  contextLength: number | null;
  price: { inputPer1k: number | null; outputPer1k: number | null } | null;
}

export interface UpsertResult {
  action: 'inserted' | 'updated' | 'unchanged';
  id: string;
}

/**
 * 同步落库。**不覆盖 `enabled`** —— 那是管理员在档案卡上的业务判断，
 * 上游重新拉一次列表就把它翻回去，等于把管理员的开关当成了缓存。
 */
export function upsertModelFromSync(db: Db, m: SyncedModel): UpsertResult {
  const at = nowIso();
  const existing = db
    .prepare('SELECT * FROM models WHERE upstream_id = ? AND name = ?')
    .get(m.upstreamId, m.name) as ModelRow | undefined;

  const capsJson = JSON.stringify(m.capabilities);
  const priceIn = m.price?.inputPer1k ?? null;
  const priceOut = m.price?.outputPer1k ?? null;

  if (!existing) {
    const id = newId('model');
    try {
      db.prepare(
        `INSERT INTO models (id, name, display_name, upstream_id, type, capabilities, context_length,
                             price_input_per_1k, price_output_per_1k, enabled, last_synced_at,
                             revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
      ).run(id, m.name, m.displayName, m.upstreamId, m.type, capsJson, m.contextLength, priceIn, priceOut, at, at, at);
    } catch (err) {
      throw translateWriteError(err, 'name');
    }
    appendChange(db, 'model', id, 'insert', 1);
    return { action: 'inserted', id };
  }

  // 更新分支：**未知不覆盖已知**（契约 §5 / ADR-0009）。
  //
  // 同步只知道三件事：名字、同步时间、以及从名字猜出来的 type。`displayName: null`、
  // `capabilities: []`、`price: null` 表达的是"上游没说"，**不是"上游说它没有"** ——
  // 所以它们不构成写入理由。初版这里是无条件覆盖的，后果是管理员 PATCH 补好的价格
  // 在下一次同步后静默变回 `null`：空值是"已知的未知"，被抹掉是"静默的数据丢失"，
  // 后者的失效模式差一个量级。
  //
  // `enabled` 同理不参与（见函数头）：它是管理员的业务判断，不是同步的缓存。
  const nextDisplayName = existing.display_name; // 同步从不产生 displayName
  const nextType = existing.type; // 推断只用于建档，人工 PATCH 优先
  const nextCaps = m.capabilities.length > 0 ? capsJson : existing.capabilities;
  const nextContext = m.contextLength ?? existing.context_length;
  const nextPriceIn = priceIn ?? existing.price_input_per_1k;
  const nextPriceOut = priceOut ?? existing.price_output_per_1k;

  const changed =
    existing.display_name !== nextDisplayName ||
    existing.type !== nextType ||
    existing.capabilities !== nextCaps ||
    existing.context_length !== nextContext ||
    existing.price_input_per_1k !== nextPriceIn ||
    existing.price_output_per_1k !== nextPriceOut;

  if (!changed) {
    // 内容没变也要刷新 lastSyncedAt：它回答的是"上次拉到数据是什么时候"，
    // 不是"上次内容变化是什么时候"。前端用它判断数据新鲜度。
    // revision 不涨、也不写 change_log —— 否则每同步一次都会给全部模型推一次前端刷新。
    db.prepare('UPDATE models SET last_synced_at = ? WHERE id = ?').run(at, existing.id);
    return { action: 'unchanged', id: existing.id };
  }

  db.prepare(
    `UPDATE models
     SET display_name = ?, type = ?, capabilities = ?, context_length = ?,
         price_input_per_1k = ?, price_output_per_1k = ?, last_synced_at = ?,
         revision = revision + 1, updated_at = ?
     WHERE id = ?`,
  ).run(
    nextDisplayName,
    nextType,
    nextCaps,
    nextContext,
    nextPriceIn,
    nextPriceOut,
    at,
    at,
    existing.id,
  );
  appendChange(db, 'model', existing.id, 'update', existing.revision + 1);
  return { action: 'updated', id: existing.id };
}

/** 供 /v1/models 与「已启用集合」对齐用（验收 4）。 */
export function listEnabledModelNames(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT m.name FROM models m
       JOIN upstreams u ON u.id = m.upstream_id
       WHERE m.enabled = 1 AND u.enabled = 1
       ORDER BY m.name`,
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}
