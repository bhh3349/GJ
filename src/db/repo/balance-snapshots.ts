// 余额快照仓储（契约 §14.3 / ADR-0017）。**本文件是快照表唯一的读写入口。**
//
// 快照 = **状态**，不是动作：一条快照记的是"该上游此刻所有未软删 key 的余额状态"，
// 不是"本次刷了多少把"。所以这里没有 ok/failed/checked 任何一列 ——
// 那些是动作的结果（在 `tasks` 表里），把它混进来会造出第二份"刷新作业记录"。
//
// 写入只有一个时机：**覆盖整个上游**的同步收尾（自动同步 / 上游刷新 / 批量刷新的
// 上游那部分）。单 key 手动刷新**不写** —— 那时上游合计里只有一把 key 是新值、
// 其余是旧值，记成"上游此刻的状态"会是一条半新半旧的假快照，比缺一个点更坏。
//
// 无外键 + 名字快照：ADR-0016 起删上游是物理删除整棵子树，`REFERENCES upstreams(id)`
// 会让"删上游"再踩一次 500；而快照行留着仍有展示名可读（同 usage_logs.key_masked）。

import type { Db } from '../database.js';
import { newId } from '../ids.js';

export interface BalanceSnapshotInput {
  upstreamId: string;
  /** 名字**快照**，不是 join 来的：上游删掉后这一行必须还能读懂 */
  upstreamName: string;
  /** 快照时刻；同时是该上游的上游级 `asOf` */
  ts: string;
  /** 分；`null` = 该上游 balance 类 key 全部未知（**不是 0**） */
  totalBalanceCents: number | null;
  knownKeyCount: number;
  unknownKeyCount: number;
  tokenPlanKeyCount: number;
  trigger: 'auto' | 'manual';
}

export interface BalanceSnapshotRow {
  id: string;
  upstreamId: string;
  upstreamName: string;
  ts: string;
  totalBalanceCents: number | null;
  knownKeyCount: number;
  unknownKeyCount: number;
  tokenPlanKeyCount: number;
  trigger: 'auto' | 'manual';
}

interface RawRow {
  id: string;
  upstream_id: string;
  upstream_name: string;
  ts: string;
  total_balance_cents: number | null;
  known_key_count: number;
  unknown_key_count: number;
  token_plan_key_count: number;
  trigger: 'auto' | 'manual';
}

function toRow(r: RawRow): BalanceSnapshotRow {
  return {
    id: r.id,
    upstreamId: r.upstream_id,
    upstreamName: r.upstream_name,
    ts: r.ts,
    totalBalanceCents: r.total_balance_cents,
    knownKeyCount: r.known_key_count,
    unknownKeyCount: r.unknown_key_count,
    tokenPlanKeyCount: r.token_plan_key_count,
    trigger: r.trigger,
  };
}

/** 追加一条快照。**不做 upsert**：同一个 ts 出现两条比丢掉一条更安全（同健康快照的取舍）。 */
export function appendBalanceSnapshot(db: Db, input: BalanceSnapshotInput): string {
  const id = newId('balanceSnapshot');
  db.prepare(
    `INSERT INTO balance_snapshots (
       id, upstream_id, upstream_name, ts, total_balance_cents,
       known_key_count, unknown_key_count, token_plan_key_count, trigger, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.upstreamId,
    input.upstreamName,
    input.ts,
    input.totalBalanceCents,
    input.knownKeyCount,
    input.unknownKeyCount,
    input.tokenPlanKeyCount,
    input.trigger,
    new Date().toISOString(),
  );
  return id;
}

export interface ListBalanceSnapshotsQuery {
  from?: string | undefined;
  to?: string | undefined;
  upstreamId?: string | undefined;
}

/**
 * 窗口内的快照，按 `(upstream_id, ts, id)` 升序。
 *
 * 排序里带 `id` 是必要的：同一毫秒出现两条（两条路径同时收尾）时，
 * 只按 ts 排两个查询会给出不同次序，趋势线于是会"抖"一下 —— 而那是纯粹的假象。
 * 升序是给趋势线用的（从左向右生长）；倒序由调用方自己翻。
 */
export function listBalanceSnapshots(db: Db, query: ListBalanceSnapshotsQuery = {}): BalanceSnapshotRow[] {
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
  if (query.upstreamId !== undefined) {
    where.push('upstream_id = ?');
    params.push(query.upstreamId);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM balance_snapshots ${clause} ORDER BY upstream_id, ts, id`)
    .all(...params) as RawRow[];
  return rows.map(toRow);
}

/** 全局最近一条快照（任意上游、任意触发）。表为空时 `null`。 */
export function latestBalanceSnapshot(db: Db): BalanceSnapshotRow | null {
  const row = db
    .prepare('SELECT * FROM balance_snapshots ORDER BY ts DESC, id DESC LIMIT 1')
    .get() as RawRow | undefined;
  return row === undefined ? null : toRow(row);
}

/** 每上游最近一条快照的 `ts`（`lastSyncedAt` 用它）。没有任何快照的上游不出现在结果里。 */
export function latestSnapshotTsPerUpstream(db: Db): Map<string, string> {
  const rows = db
    .prepare('SELECT upstream_id AS upstreamId, MAX(ts) AS ts FROM balance_snapshots GROUP BY upstream_id')
    .all() as { upstreamId: string; ts: string }[];
  return new Map(rows.map((r) => [r.upstreamId, r.ts]));
}

/**
 * 某上游在 `beforeTs` **之前**最近的一条快照（漂移判定要的"相邻两次"）。
 * 严格早于：同一毫秒的另一条不算"上一次"，否则差额衡量的是一瞬间而不是一个区间。
 */
export function previousBalanceSnapshot(db: Db, upstreamId: string, beforeTs: string): BalanceSnapshotRow | null {
  const row = db
    .prepare(
      `SELECT * FROM balance_snapshots
       WHERE upstream_id = ? AND ts < ?
       ORDER BY ts DESC, id DESC LIMIT 1`,
    )
    .get(upstreamId, beforeTs) as RawRow | undefined;
  return row === undefined ? null : toRow(row);
}

/**
 * 区间 `(fromExclusive, toInclusive]` 内该上游的 token 用量。
 *
 * 刻意**不按 key 过滤**：快照是上游级的，用它做对照的用量也必须是上游级的 ——
 * 换了 key 但仍是这个上游在用，余额照样在掉。
 */
export function sumTokensBetween(db: Db, upstreamId: string, fromExclusive: string, toInclusive: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS n FROM usage_logs
       WHERE upstream_id = ? AND ts > ? AND ts <= ?`,
    )
    .get(upstreamId, fromExclusive, toInclusive) as { n: number };
  return row.n;
}

/**
 * 保留期。由调用方按**独立周期**跑（不是只在启动时跑一次，也不是挂在写入路径上）：
 * 上游被删掉之后就不再产生新快照，此时"写入时顺手裁一次"永远不会被触发，
 * 而表还在继续增长 —— 那正是无界增长最容易被漏掉的形状。
 */
export function pruneBalanceSnapshots(db: Db, retentionDays: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return db.prepare('DELETE FROM balance_snapshots WHERE ts < ?').run(cutoff).changes;
}
