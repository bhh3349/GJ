// 健康指标计算（契约 §12.2 / ADR-0013）。
//
// 两条口径决定散在各处，集中说明在这里：
//
//   1. **分位用最近秩（nearest-rank），不做插值**。取法是
//      `ORDER BY latency_ms LIMIT 1 OFFSET ceil(p·n)-1` —— 一次索引扫描拿一行，
//      不把样本搬进内存。插值法（如线性内插）会给出一个**没有任何一次真实请求**
//      达到过的延迟值，在一个"我这 5 分钟到底慢不慢"的问题上，那是假数据。
//
//   2. **流量口径与 §6 overview 同源**：直接复用 `computeOverview`，
//      不在这里重写一份 SQL。两处口径一旦分叉，仪表盘与健康页会给出两个数，
//      而用户只会相信其中任意一个 —— 那种修复成本远高于省下的这次函数调用。

import { statSync } from 'node:fs';
import type { HealthDbDto, HealthKeysDto, HealthMetricsDto, LatencyPercentilesDto } from '../api/dto.js';
import { listKeyHealthDetail } from './repo/keys.js';
import { summarizeErrorEvents } from './repo/gateway-events.js';
import { computeOverview } from './stats.js';
import type { Db } from './database.js';

/**
 * 最近秩分位。
 *
 * `n = 0` 时返回 `null`（不是 0）：窗口内没有样本，与"延迟是 0ms"是两件事。
 * 这是 ADR-0003 那条 null 纪律在延迟上的同一处应用。
 */
export function percentile(db: Db, fromIso: string, p: number, samples?: number): number | null {
  const n = samples ?? countLatencySamples(db, fromIso);
  if (n === 0) return null;

  // ceil(p·n) ∈ [1, n]；转成 0-based offset 后必然落在 [0, n-1]，无需再夹
  const offset = Math.max(1, Math.ceil(p * n)) - 1;
  const row = db
    .prepare(
      `SELECT latency_ms AS ms
       FROM usage_logs
       WHERE ts >= ? AND latency_ms IS NOT NULL
       ORDER BY latency_ms ASC, id ASC
       LIMIT 1 OFFSET ?`,
    )
    .get(fromIso, offset) as { ms: number } | undefined;
  return row?.ms ?? null;
}

function countLatencySamples(db: Db, fromIso: string): number {
  return (
    db
      .prepare('SELECT COUNT(*) AS n FROM usage_logs WHERE ts >= ? AND latency_ms IS NOT NULL')
      .get(fromIso) as { n: number }
  ).n;
}

/** 一次算完 P50/P99 与样本数。样本数只查一次，两个分位共用。 */
export function latencyPercentiles(db: Db, fromIso: string): LatencyPercentilesDto {
  const samples = countLatencySamples(db, fromIso);
  return {
    p50: percentile(db, fromIso, 0.5, samples),
    p99: percentile(db, fromIso, 0.99, samples),
    samples,
  };
}

/**
 * DB 状态。
 *
 * `ok` 是**真跑一次 `SELECT 1`** 的结果，不是"连接对象还在"：
 * WAL 损坏、磁盘写满、`busy_timeout` 被长事务吃光，都发生在连接建立**之后**，
 * 一个恒为 true 的字段等于没有。
 *
 * **不返回库文件路径**：那是部署细节（含主机目录结构），观测面不需要它。
 */
export function inspectDb(db: Db): HealthDbDto {
  const started = performance.now();
  let ok = false;
  try {
    db.prepare('SELECT 1 AS ok').get();
    ok = true;
  } catch {
    ok = false;
  }
  const queryMs = Math.round(performance.now() - started);

  let schemaVersion = 0;
  try {
    schemaVersion = db.pragma('user_version', { simple: true }) as number;
  } catch {
    schemaVersion = 0;
  }

  return {
    ok,
    schemaVersion,
    fileSizeBytes: mainFileSize(db),
    walSizeBytes: walFileSize(db),
    queryMs,
  };
}

function mainFileSize(db: Db): number | null {
  try {
    const pages = db.pragma('page_count', { simple: true }) as number;
    const pageSize = db.pragma('page_size', { simple: true }) as number;
    return pages * pageSize;
  } catch {
    return null;
  }
}

/**
 * WAL 文件大小。SQLite 没有查询 WAL 大小的 pragma，只能看文件系统。
 * 取不到（内存库、文件被外部滚动、权限不足）一律 `null` —— 这个字段是"参考值"，
 * 为它编一个 0 会让"WAL 膨胀了"这个信号彻底消失。
 */
function walFileSize(db: Db): number | null {
  const name = db.name;
  if (typeof name !== 'string' || name === '' || name === ':memory:') return null;
  try {
    return statSync(`${name}-wal`).size;
  } catch {
    return null;
  }
}

function summarizeKeys(db: Db): HealthKeysDto {
  const items = listKeyHealthDetail(db);
  const out: HealthKeysDto = { total: items.length, healthy: 0, cooling: 0, disabled: 0, items };
  for (const item of items) {
    if (item.health === 'healthy') out.healthy += 1;
    else if (item.health === 'cooling') out.cooling += 1;
    else out.disabled += 1;
  }
  return out;
}

export interface ComputeHealthOptions {
  db: Db;
  /** 指标窗口秒数（路由层已按 `parseWindow` 归一化并限过上限） */
  windowSeconds: number;
  /**
   * 回显给前端的窗口**原字符串**（`60s` / `5m` / `1h`）。
   * 刻意不由秒数反推：`300s` 与 `5m` 秒数相同但用户输入的不是同一个东西，
   * 回显用户输入的那一个，前端才知道自己该勾哪个选项。见 §12.2。
   */
  windowLabel: string;
  /** 服务启动时刻。**用启动时记下的那个值**，不要用 `now - uptime()` 现推：现推会随调用漂移 */
  startedAt: Date;
  /** 进程启动以来累计丢弃的事件条数（来自 sink） */
  droppedEvents: number;
  /** 注入"现在"，便于测试；缺省取真实时间 */
  now?: Date | undefined;
}

/**
 * 组装 `GET /api/observability/health` 的响应体。
 *
 * 注意 `traffic.qps` / `traffic.successRate` 取自 `computeOverview` —— 它内部有自己的
 * `now`。这里不试图对齐两个 `now`：窗口是"滚动的最近 N 秒"，两次 `new Date()` 相差
 * 微秒级，纠结这点差异的收益远小于让两处口径**同源**带来的确定性。
 */
export function computeHealthMetrics(opts: ComputeHealthOptions): HealthMetricsDto {
  const now = opts.now ?? new Date();
  const overview = computeOverview(opts.db, opts.windowSeconds);
  const from = new Date(now.getTime() - opts.windowSeconds * 1000).toISOString();
  const to = now.toISOString();

  const events = summarizeErrorEvents(opts.db, from, to);

  return {
    generatedAt: now.toISOString(),
    // 回显用户输入的那个窗口字符串，不由秒数反推（见 ComputeHealthOptions.windowLabel）
    window: opts.windowLabel,
    uptimeSec: Math.floor((now.getTime() - opts.startedAt.getTime()) / 1000),
    startedAt: opts.startedAt.toISOString(),
    traffic: {
      qps: overview.qps,
      successRate: overview.successRate,
      requests: overview.requests,
      errors: overview.errors,
      tokens: overview.tokens,
      latencyMs: latencyPercentiles(opts.db, from),
    },
    keys: summarizeKeys(opts.db),
    db: inspectDb(opts.db),
    events: {
      total: events.total,
      dropped: opts.droppedEvents,
      byCategory: events.byCategory,
    },
  };
}
