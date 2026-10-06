// 健康快照仓储。契约 §12.2 / ADR-0013。
//
// 快照是**当时算出来的历史**：写入方算完即写，读取方只读不算。
// "不事后重算"是本表的全部意义 —— usage_logs 会被保留期裁掉，
// 用今天的库去重算昨天的窗口只会得到另一种历史，而那正是最难被发现的假数据。

import type { HealthSnapshotDto, Page } from '../../api/dto.js';
import type { Db } from '../database.js';
import { newId } from '../ids.js';

interface SnapshotRow {
  id: string;
  ts: string;
  window_sec: number;
  qps: number;
  success_rate: number;
  requests: number;
  errors: number;
  p50_ms: number | null;
  p99_ms: number | null;
  key_total: number;
  key_healthy: number;
  key_cooling: number;
  key_disabled: number;
  db_ok: number;
  error_count: number;
}

function toDto(r: SnapshotRow): HealthSnapshotDto {
  return {
    id: r.id,
    ts: r.ts,
    windowSec: r.window_sec,
    qps: r.qps,
    successRate: r.success_rate,
    requests: r.requests,
    errors: r.errors,
    p50Ms: r.p50_ms,
    p99Ms: r.p99_ms,
    keys: {
      total: r.key_total,
      healthy: r.key_healthy,
      cooling: r.key_cooling,
      disabled: r.key_disabled,
    },
    dbOk: r.db_ok === 1,
    errorCount: r.error_count,
  };
}

export interface HealthSnapshotInput {
  ts: string;
  windowSec: number;
  qps: number;
  successRate: number;
  requests: number;
  errors: number;
  /** `null` = 窗口内无样本（未知 != 0） */
  p50Ms: number | null;
  p99Ms: number | null;
  keyTotal: number;
  keyHealthy: number;
  keyCooling: number;
  keyDisabled: number;
  dbOk: boolean;
  errorCount: number;
}

/** 追加一条快照。**不做 upsert**：同一个 ts 出现两条比丢掉一条更安全 —— 前者看得见，后者看不见。 */
export function appendHealthSnapshot(db: Db, input: HealthSnapshotInput): string {
  const id = newId('healthSnapshot');
  db.prepare(
    `INSERT INTO gateway_health_snapshots (
       id, ts, window_sec, qps, success_rate, requests, errors, p50_ms, p99_ms,
       key_total, key_healthy, key_cooling, key_disabled, db_ok, error_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.ts,
    input.windowSec,
    input.qps,
    input.successRate,
    input.requests,
    input.errors,
    input.p50Ms,
    input.p99Ms,
    input.keyTotal,
    input.keyHealthy,
    input.keyCooling,
    input.keyDisabled,
    input.dbOk ? 1 : 0,
    input.errorCount,
  );
  return id;
}

export interface ListSnapshotsQuery {
  from?: string | undefined;
  to?: string | undefined;
  page: number;
  pageSize: number;
}

/** 快照列表，`ts DESC, id DESC`（同毫秒也有确定次序，翻页不重不漏）。 */
export function listHealthSnapshots(db: Db, query: ListSnapshotsQuery): Page<HealthSnapshotDto> {
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
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM gateway_health_snapshots ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM gateway_health_snapshots ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as SnapshotRow[];

  return { items: rows.map(toDto), total, page: query.page, pageSize: query.pageSize };
}

/** 最近一条快照；表为空时 `null`。 */
export function latestHealthSnapshot(db: Db): HealthSnapshotDto | null {
  const row = db
    .prepare('SELECT * FROM gateway_health_snapshots ORDER BY ts DESC, id DESC LIMIT 1')
    .get() as SnapshotRow | undefined;
  return row === undefined ? null : toDto(row);
}

/**
 * 保留期。快照量级远小于 usage_logs（60s 一条 = 一天 1440 行），
 * 所以给一个比日志长得多的默认保留期；由调用方决定传多少天。
 */
export function pruneHealthSnapshots(db: Db, retentionDays: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return db.prepare('DELETE FROM gateway_health_snapshots WHERE ts < ?').run(cutoff).changes;
}
