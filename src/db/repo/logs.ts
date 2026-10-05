// 调用记录仓储。契约 §6。
//
// 写入方是**网关**（M3），管理面只读 —— 这里不提供 update/delete：
// 调用记录是账，能被改的账就不是账。保留 30 天靠定期清理，不是靠改写。

import type { LogDto, Page } from '../../api/dto.js';
import { nowIso } from '../../util/time.js';
import type { Db } from '../database.js';
import { newId } from '../ids.js';

interface LogRow {
  id: string;
  ts: string;
  group_id: string | null;
  model: string | null;
  upstream_id: string | null;
  key_masked: string;
  status: number;
  error_code: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  is_estimated: number;
  latency_ms: number | null;
  ttfb_ms: number | null;
  stream: number;
}

function toDto(r: LogRow): LogDto {
  return {
    id: r.id,
    ts: r.ts,
    groupId: r.group_id,
    model: r.model,
    upstreamId: r.upstream_id,
    keyMasked: r.key_masked,
    status: r.status,
    errorCode: r.error_code,
    tokens: {
      prompt: r.prompt_tokens,
      completion: r.completion_tokens,
      total: r.total_tokens,
      // 契约 §6：前端图表要能标注"含估算"，这个布尔就是那个开关。
      isEstimated: r.is_estimated === 1,
    },
    latencyMs: r.latency_ms,
    ttfbMs: r.ttfb_ms,
    stream: r.stream === 1,
  };
}

export interface UsageLogInput {
  ts?: string | undefined;
  groupId: string | null;
  model: string | null;
  upstreamId: string | null;
  keyId: string | null;
  keyMasked: string;
  status: number;
  errorCode?: string | null | undefined;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  isEstimated: boolean;
  latencyMs?: number | null | undefined;
  ttfbMs?: number | null | undefined;
  stream: boolean;
  costCents?: number | undefined;
}

/**
 * 追加一条调用记录。
 *
 * 注意：这个方法**不参与热路径**。网关侧是攒批后异步落库（契约 §9「热路径零同步 DB 写」），
 * 这里只是那个批量写入的落点。谁要是在 /v1/* 的请求线程里直接调它，TTFB 就会抖。
 */
export function appendUsageLog(db: Db, log: UsageLogInput): string {
  const id = newId('log');
  db.prepare(
    `INSERT INTO usage_logs (
       id, ts, group_id, model, upstream_id, key_id, key_masked, status, error_code,
       prompt_tokens, completion_tokens, total_tokens, is_estimated,
       latency_ms, ttfb_ms, stream, cost_cents
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    log.ts ?? nowIso(),
    log.groupId,
    log.model,
    log.upstreamId,
    log.keyId,
    log.keyMasked,
    log.status,
    log.errorCode ?? null,
    log.promptTokens,
    log.completionTokens,
    log.totalTokens,
    log.isEstimated ? 1 : 0,
    log.latencyMs ?? null,
    log.ttfbMs ?? null,
    log.stream ? 1 : 0,
    log.costCents ?? 0,
  );
  return id;
}

export interface ListLogsQuery {
  from?: string | undefined;
  to?: string | undefined;
  groupId?: string | undefined;
  model?: string | undefined;
  status?: number | undefined;
  upstreamId?: string | undefined;
  keyId?: string | undefined;
  includeDeleted: boolean;
  page: number;
  pageSize: number;
}

export function listLogs(db: Db, query: ListLogsQuery): Page<LogDto> {
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.from !== undefined) {
    where.push('ts >= ?');
    params.push(query.from);
  }
  if (query.to !== undefined) {
    where.push('ts <= ?');
    params.push(query.to);
  }
  if (query.groupId !== undefined) {
    where.push('group_id = ?');
    params.push(query.groupId);
  }
  if (query.model !== undefined) {
    where.push('model = ?');
    params.push(query.model);
  }
  if (query.status !== undefined) {
    where.push('status = ?');
    params.push(query.status);
  }
  if (query.upstreamId !== undefined) {
    where.push('upstream_id = ?');
    params.push(query.upstreamId);
  }
  if (query.keyId !== undefined) {
    where.push('key_id = ?');
    params.push(query.keyId);
    // 契约 §6：默认不查已软删资源；includeDeleted=true 时按 id 过滤仍可命中已软删的 key。
    // 判据放在**被引用资源**上，而不是日志行本身 —— 日志行从不删除。
    if (!query.includeDeleted) {
      where.push('key_id IN (SELECT id FROM upstream_keys WHERE deleted_at IS NULL)');
    }
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM usage_logs ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM usage_logs ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as LogRow[];

  return { items: rows.map(toDto), total, page: query.page, pageSize: query.pageSize };
}

/** 保留策略：契约口径 30 天。按 ts 删，不按 id。 */
export function pruneLogs(db: Db, retentionDays: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return db.prepare('DELETE FROM usage_logs WHERE ts < ?').run(cutoff).changes;
}
