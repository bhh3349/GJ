// 60s 健康快照写入器（契约 §12.2 / ADR-0013 §5）。
//
// 为什么由**管理进程**持有这个定时器，而不是网关进程：
//   `/v1/*` 是热路径，单写者原则下它连一次同步写都不该有（AGENTS.md §5）。
//   快照写入是"后台周期性任务"，它不该和请求抢写锁。管理面这边没有 TTL 压力，
//   60s 一次的写完全落在噪声里。
//
// 生命周期挂在 `buildApp` 上、由 Fastify 的 `onClose` 收尾：冻结的关停顺序里
// `app.close()` 早于 `db.close()`（src/wiring/shutdown.ts），所以不需要改那份顺序表。
//
// 写的是**当时算出来的那一份**，不事后重算：usage_logs 会被保留期裁掉，
// 用今天的库重算昨天的窗口只会得到另一种历史 —— 那正是最难被发现的假数据。

import { appendHealthSnapshot, pruneHealthSnapshots } from '../db/repo/health-snapshots.js';
import { computeHealthMetrics } from '../db/observability.js';
import type { Db } from '../db/database.js';

/** 快照节拍。契约 §12.2 冻结为 60s。 */
export const SNAPSHOT_INTERVAL_MS = 60_000;
/** 快照自身的统计窗口。固定 5m 而不是可配：快照是历史序列，两段不同窗口的序列拼在一起没有意义。 */
export const SNAPSHOT_WINDOW_SECONDS = 300;
/** 清理节拍：每小时一次足够（一天才 1440 行）。 */
const PRUNE_INTERVAL_MS = 3600_000;

export interface HealthSnapshotWriterOptions {
  db: Db;
  startedAt: Date;
  /** 错误事件累计丢弃数；sink 未接入时恒 0 */
  droppedEvents: () => number;
  /** 快照保留天数（config.healthSnapshotRetentionDays） */
  retentionDays: number;
  onError?: (err: unknown) => void;
  /** 覆盖节拍，仅测试用 */
  intervalMs?: number;
  /** 覆盖窗口，仅测试用 */
  windowSeconds?: number;
}

export interface HealthSnapshotWriter {
  /** 启动定时器（幂等） */
  start(): void;
  /** 停定时器。不补写 —— 关停时再写一条会把"服务已经不稳"这段时间盖进历史 */
  stop(): void;
  /** 立即写一条（测试与启动首拍用） */
  writeOnce(): boolean;
}

export function createHealthSnapshotWriter(options: HealthSnapshotWriterOptions): HealthSnapshotWriter {
  const { db, startedAt, retentionDays } = options;
  const intervalMs = Math.max(1, options.intervalMs ?? SNAPSHOT_INTERVAL_MS);
  const windowSeconds = options.windowSeconds ?? SNAPSHOT_WINDOW_SECONDS;

  let timer: NodeJS.Timeout | null = null;
  let lastPruneMs = 0;

  /**
   * 写一条。返回是否成功。
   *
   * 失败**只记日志、不抛出**：定时器回调里抛出的异常会变成 unhandled rejection，
   * 而丢一拍快照是可接受的（下一拍就补上了），为它把进程带下去不可接受。
   */
  function writeOnce(): boolean {
    try {
      const health = computeHealthMetrics({
        db,
        windowSeconds,
        windowLabel: `${windowSeconds}s`,
        startedAt,
        droppedEvents: options.droppedEvents(),
      });

      appendHealthSnapshot(db, {
        ts: health.generatedAt,
        windowSec: windowSeconds,
        qps: health.traffic.qps,
        successRate: health.traffic.successRate,
        requests: health.traffic.requests,
        errors: health.traffic.errors,
        p50Ms: health.traffic.latencyMs.p50,
        p99Ms: health.traffic.latencyMs.p99,
        keyTotal: health.keys.total,
        keyHealthy: health.keys.healthy,
        keyCooling: health.keys.cooling,
        keyDisabled: health.keys.disabled,
        dbOk: health.db.ok,
        errorCount: health.events.total,
      });

      maybePrune();
      return true;
    } catch (err) {
      options.onError?.(err);
      return false;
    }
  }

  function maybePrune(): void {
    const now = Date.now();
    if (now - lastPruneMs < PRUNE_INTERVAL_MS) return;
    lastPruneMs = now;
    try {
      pruneHealthSnapshots(db, retentionDays);
    } catch (err) {
      // 清理失败不影响写入：下个周期再试，最坏情况是库大一点
      options.onError?.(err);
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      // 启动即写一条：否则新建的实例在头 60s 里 history 是空的，
      // 而这个窗口恰好是"刚部署完想看它稳不稳"最需要它的时候。
      writeOnce();
      timer = setInterval(() => {
        writeOnce();
      }, intervalMs);
      // 别吊住进程退出：退出前由 app 的 onClose 显式 stop()
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    writeOnce,
  };
}
