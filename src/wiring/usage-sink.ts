// 网关适配层 - `UsageLogSink`：把转发链路的用量记录攒批落库。
//
// 硬约束（PM 冻结、AGENTS.md §5 同款）：
//   `record()` **只入队，不落库、不 await**。它跑在 /v1/* 的请求线程上，
//   一旦在这里 `db.prepare().run()`，TTFB 就被 SQLite 的写锁吃掉了（验收 6 / 8）。
//   所以：入队是 O(1) 的内存操作，落库交给定时器 + 退出时的最后一次 flush。
//
// 为什么攒批而不是「一条一个异步 task」：
//   单写者原则（AGENTS.md §5）—— 同一份 SQLite 只有一个写者。攒批 + 单事务写入
//   天然串行，也把每次 N 条记录压成 1 次 fsync 级别的成本。
//
// 账不能被悄悄丢：队列有上限（默认 5000 条）。满了丢**最旧**的一批并在 `dropped()` 里计数；
// 落库失败（真异常，不是忙等）同样计数 —— 这个数字必须能被看到，否则"用量少了"会变成
// 一个只有对账时才会发现的悬案。

import { appendUsageLog } from '../db/repo/logs.js';
import type { UsageLogInput } from '../db/repo/logs.js';
import type { Db } from '../db/database.js';
import type { UsageLogEntry, UsageLogSink } from '../gateway/ports.js';

const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_MAX_QUEUE = 5000;

export interface UsageSinkOptions {
  db: Db;
  /** keyId → `****后4位`；keyId 为空（如"全失败"终态）时实现返回 `****` */
  maskOf(keyId: string): string;
  /** 金额换算（分）。单价未知由实现返回 0 */
  costCentsOf(upstreamModel: string, promptTokens: number, completionTokens: number): number;
  /** 刷写间隔，默认 500ms */
  flushIntervalMs?: number;
  /** 队列上限，默认 5000 */
  maxQueue?: number;
  /** 刷写/入队异常回调（只传条数与错误对象；不传记录内容） */
  onError?: (err: unknown, dropped: number) => void;
  onOverflow?: (dropped: number) => void;
}

export interface UsageSink extends UsageLogSink {
  /** 立即排空并落库，返回本次写入条数（测试/退出时用） */
  flush(): number;
  /** 当前待落库条数 */
  pending(): number;
  /** 因队列溢出或落库失败而未落库的条数（累计） */
  dropped(): number;
  /** 停定时器 + 最后一次 flush */
  close(): void;
}

export function createUsageLogSink(options: UsageSinkOptions): UsageSink {
  const { db, maskOf, costCentsOf } = options;
  const maxQueue = Math.max(1, options.maxQueue ?? DEFAULT_MAX_QUEUE);
  const flushIntervalMs = Math.max(1, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);

  const queue: UsageLogEntry[] = [];
  let droppedCount = 0;

  /** 队列满：丢最旧的一批（保住"最近发生了什么"，这对排障比保住最旧的更有用） */
  function makeRoom(): void {
    const overflow = queue.length - maxQueue + 1;
    if (overflow <= 0) return;
    queue.splice(0, overflow);
    droppedCount += overflow;
    options.onOverflow?.(overflow);
  }

  function toInput(entry: UsageLogEntry): UsageLogInput {
    // 引擎在所有尝试都失败时会带 keyId/upstreamId = ''（没有"那把 key"可言），
    // 空串进 DB 会变成一个指向空主键的假外键，转成 null。
    const keyId = entry.keyId === '' ? null : entry.keyId;
    return {
      ts: entry.at,
      groupId: entry.groupId === '' ? null : entry.groupId,
      // 落库的是**客户端请求的模型名**：管理端日志页按它筛选，
      // 用户搜自己发出去的名字才搜得到；上游真实名只用于金额换算。
      model: entry.clientModel,
      upstreamId: entry.upstreamId === '' ? null : entry.upstreamId,
      keyId,
      keyMasked: maskOf(entry.keyId),
      status: entry.statusCode,
      errorCode: entry.failureReason,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: entry.totalTokens,
      isEstimated: entry.isEstimated,
      latencyMs: entry.latencyMs,
      ttfbMs: entry.ttfbMs,
      stream: entry.stream,
      costCents: costCentsOf(entry.model, entry.promptTokens, entry.completionTokens),
    };
  }

  function flush(): number {
    if (queue.length === 0) return 0;
    const batch = queue.splice(0, queue.length);
    try {
      // 一个事务写完一批：单写者原则下这是最省的形态（一次提交而不是 N 次）
      const write = db.transaction((rows: UsageLogEntry[]) => {
        for (const row of rows) appendUsageLog(db, toInput(row));
      });
      write(batch);
      return batch.length;
    } catch (err) {
      // 真异常（磁盘满 / schema 不对），不是忙等（busy_timeout 已配 5s）。
      // 丢这一批并计数：把旧批次塞回队首只会让"新记录排队等一个坏连接"，越积越糟。
      droppedCount += batch.length;
      options.onError?.(err, batch.length);
      return 0;
    }
  }

  const timer = setInterval(() => {
    flush();
  }, flushIntervalMs);
  // 别吊住进程退出：退出前由 server.ts 显式 close() 做最后一次 flush
  if (typeof timer.unref === 'function') timer.unref();

  return {
    record(entry: UsageLogEntry): void {
      if (queue.length >= maxQueue) makeRoom();
      queue.push(entry);
    },
    flush,
    pending: () => queue.length,
    dropped: () => droppedCount,
    close(): void {
      clearInterval(timer);
      flush();
    },
  };
}
