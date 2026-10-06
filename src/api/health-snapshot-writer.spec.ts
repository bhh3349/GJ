// 60s 健康快照写入器（契约 §12.2 / ADR-0013 §5）。
//
// 判据都围绕"这条历史序列能不能被信任"：
//   1. 启动即写一条 —— 否则新建的实例在头 60s 里 history 是空的，
//      而那个窗口恰好是"刚部署完想看它稳不稳"最需要它的时候；
//   2. 写的是**当时算出来的那一份**：p50/p99 直接进库，读的时候不重算
//      （usage_logs 有保留期，事后重算只会得到另一种历史）；
//   3. 定时器回调里**绝不抛**：丢一拍快照可以接受（下一拍补上），
//      为它把进程带下去不可接受。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../db/database.js';
import { appendHealthSnapshot, latestHealthSnapshot, listHealthSnapshots } from '../db/repo/health-snapshots.js';
import { appendUsageLog } from '../db/repo/logs.js';
import { SNAPSHOT_INTERVAL_MS, SNAPSHOT_WINDOW_SECONDS, createHealthSnapshotWriter } from './health-snapshot-writer.js';

const dirs: string[] = [];
const open: Db[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响判据 */
    }
  }
});

function setup(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'snap-probe-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  open.push(db);
  return db;
}

function count(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM gateway_health_snapshots').get() as { n: number }).n;
}

function writer(db: Db, over: Partial<Parameters<typeof createHealthSnapshotWriter>[0]> = {}) {
  return createHealthSnapshotWriter({
    db,
    startedAt: new Date(Date.now() - 120_000),
    droppedEvents: () => 3,
    retentionDays: 90,
    ...over,
  });
}

describe('writeOnce', () => {
  it('写一条与实时口径一致的快照（同一份算法，不是另算一遍）', () => {
    const db = setup();
    appendUsageLog(db, {
      ts: new Date().toISOString(),
      groupId: null,
      model: 'gpt-probe',
      upstreamId: null,
      keyId: null,
      keyMasked: '****robe',
      status: 200,
      errorCode: null,
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      isEstimated: false,
      latencyMs: 42,
      ttfbMs: null,
      stream: false,
      costCents: 0,
    });

    expect(writer(db).writeOnce()).toBe(true);
    const snap = latestHealthSnapshot(db);
    expect(snap?.windowSec).toBe(SNAPSHOT_WINDOW_SECONDS);
    expect(snap?.requests).toBe(1);
    expect(snap?.p50Ms).toBe(42);
    expect(snap?.p99Ms).toBe(42);
    expect(snap?.dbOk).toBe(true);
    expect(snap?.errorCount).toBe(0);
  });

  it('库不可用时返回 false、调 onError，**不抛**（定时器里抛出会变成 unhandled rejection）', () => {
    const db = setup();
    const errs: unknown[] = [];
    const w = writer(db, { onError: (e) => errs.push(e) });
    db.close();
    expect(() => w.writeOnce()).not.toThrow();
    expect(w.writeOnce()).toBe(false);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('节拍', () => {
  it('start() 立刻写一条，然后按 60s 节拍续写', () => {
    const db = setup();
    const w = writer(db);
    w.start();
    expect(count(db)).toBe(1);
    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS * 3);
    expect(count(db)).toBe(4);
    w.stop();
  });

  it('start() 幂等：重复调用不会多出第二个定时器', () => {
    const db = setup();
    const w = writer(db);
    w.start();
    w.start();
    w.start();
    expect(count(db)).toBe(1);
    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS);
    expect(count(db)).toBe(2);
    w.stop();
  });

  it('stop() 之后不再写（关停时不补写：那会把"服务已经不稳"这段时间盖进历史）', () => {
    const db = setup();
    const w = writer(db);
    w.start();
    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS);
    expect(count(db)).toBe(2);
    w.stop();
    vi.advanceTimersByTime(SNAPSHOT_INTERVAL_MS * 5);
    expect(count(db)).toBe(2);
  });

  it('stop() 幂等', () => {
    const db = setup();
    const w = writer(db);
    w.start();
    w.stop();
    expect(() => w.stop()).not.toThrow();
  });
});

describe('保留期', () => {
  it('过期快照在写入时被裁掉，新的一条留下', () => {
    const db = setup();
    appendHealthSnapshot(db, {
      ts: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      windowSec: 300,
      qps: 0,
      successRate: 1,
      requests: 0,
      errors: 0,
      p50Ms: null,
      p99Ms: null,
      keyTotal: 0,
      keyHealthy: 0,
      keyCooling: 0,
      keyDisabled: 0,
      dbOk: true,
      errorCount: 0,
    });
    expect(count(db)).toBe(1);

    const w = writer(db, { retentionDays: 1 });
    expect(w.writeOnce()).toBe(true);
    const page = listHealthSnapshots(db, { page: 1, pageSize: 10 });
    expect(page.total).toBe(1);
    expect(page.items[0]?.windowSec).toBe(SNAPSHOT_WINDOW_SECONDS);
  });
});
