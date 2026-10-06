// 适配层单测 - 用量攒批落库（`src/wiring/usage-sink.ts`）
//
// 硬约束（PM 冻结）：`record()` **只入队、不落库、不 await**。它跑在 `/v1/*` 的请求线程上，
// 一旦这里出现 `db.prepare().run()`，TTFB 就被 SQLite 的写锁吃掉了（验收 6 / 8）。
// 所以本文件第一个用例就是"record 之后表里仍然是 0 行"，最后一个用例才是"flush 之后是 N 行"。
//
// 另一条同样重要：**账不能被悄悄丢**。队列溢出与落库失败都必须计数（`dropped()`），
// 否则"用量少了"会变成一个只有对账时才会发现的悬案。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

import { openDatabase, type Db } from '../db/database.js';
import type { UsageLogEntry } from '../gateway/ports.js';
import { createUsageLogSink } from './usage-sink.js';
import type { UsageSink } from './usage-sink.js';

/* ------------------------------ 测试台 ------------------------------ */

const dirs: string[] = [];
const dbs: Db[] = [];
const sinks: UsageSink[] = [];

afterEach(() => {
  // 必须停掉定时器：漏一个 500ms 的 interval，vitest 会在退出时挂住
  for (const s of sinks.splice(0)) s.close();
  for (const db of dbs.splice(0)) {
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
      /* Windows 上偶尔仍被短时占用 */
    }
  }
  // 放在最后：先让 close() 用假定时器把手上的 interval 清掉，再卸掉假时钟
  vi.useRealTimers();
});

interface Harness {
  db: Db;
  sink: UsageSink;
}

interface SinkOverrides {
  maxQueue?: number;
  flushIntervalMs?: number;
  dropped?: string[];
  errors?: unknown[];
}

function setup(over: SinkOverrides = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-sink-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  dbs.push(db);

  const dropped: string[] = over.dropped ?? [];
  const errors: unknown[] = over.errors ?? [];
  const sink = createUsageLogSink({
    db,
    maskOf: (keyId) => (keyId === '' ? '****' : `****${keyId.slice(-4)}`),
    costCentsOf: (model, prompt, completion) => (model.startsWith('gpt-4o') ? prompt + completion : 0),
    ...(over.maxQueue === undefined ? {} : { maxQueue: over.maxQueue }),
    ...(over.flushIntervalMs === undefined ? {} : { flushIntervalMs: over.flushIntervalMs }),
    onError: (err) => errors.push(err),
    onOverflow: (n) => dropped.push(`overflow:${n}`),
  });
  sinks.push(sink);
  return { db, sink };
}

function entry(over: Partial<UsageLogEntry> = {}): UsageLogEntry {
  return {
    groupId: 'grp_1',
    keyId: 'key_abcd1234',
    upstreamId: 'up_1',
    model: 'gpt-4o',
    clientModel: 'gpt-4o',
    endpoint: '/v1/chat/completions',
    stream: false,
    statusCode: 200,
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    isEstimated: false,
    ttfbMs: 12.5,
    latencyMs: 300,
    attempts: 1,
    failureReason: null,
    at: '2026-10-06T12:00:00.000Z',
    requestId: 'req-test-0001',
    ...over,
  };
}

function rowCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get() as { n: number }).n;
}

interface LogRow {
  ts: string;
  group_id: string | null;
  model: string;
  upstream_id: string | null;
  key_id: string | null;
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
  cost_cents: number;
}

function rows(db: Db): LogRow[] {
  return db.prepare('SELECT * FROM usage_logs ORDER BY ts, model').all() as LogRow[];
}

/* ------------------------------ 用例 ------------------------------ */

describe('入队', () => {
  it('record 只入队：表里一行都不写（热路径零同步 DB 写）', () => {
    const h = setup();
    h.sink.record(entry());
    h.sink.record(entry({ clientModel: 'gpt-4o-mini' }));

    assert.equal(rowCount(h.db), 0, 'record 里出现任何 INSERT 都会把 TTFB 卖给 SQLite 写锁');
    assert.equal(h.sink.pending(), 2);
    assert.equal(h.sink.dropped(), 0);
  });
});

describe('落库', () => {
  it('flush 一次事务写完一批，且列映射与契约一致', () => {
    const h = setup();
    h.sink.record(entry());
    const n = h.sink.flush();

    assert.equal(n, 1);
    assert.equal(h.sink.pending(), 0);
    const [row] = rows(h.db);
    assert.ok(row);
    assert.equal(row.ts, '2026-10-06T12:00:00.000Z');
    assert.equal(row.group_id, 'grp_1');
    assert.equal(row.model, 'gpt-4o');
    assert.equal(row.key_id, 'key_abcd1234');
    assert.equal(row.key_masked, '****1234');
    assert.equal(row.status, 200);
    assert.equal(row.error_code, null);
    assert.equal(row.total_tokens, 120);
    assert.equal(row.is_estimated, 0);
    assert.equal(row.ttfb_ms, 12.5);
    assert.equal(row.latency_ms, 300);
    assert.equal(row.stream, 0);
    assert.equal(row.cost_cents, 120, 'prompt+completion 按注入的换算器算');
  });

  it('空队列 flush 是 0，不产生空事务', () => {
    const h = setup();
    assert.equal(h.sink.flush(), 0);
  });

  it('落库的是客户端模型名，不是上游真实名；金额按上游名换算', () => {
    const h = setup();
    h.sink.record(entry({ model: 'gpt-4o-2024-11-20', clientModel: 'gpt-4o' }));
    h.sink.flush();

    const [row] = rows(h.db);
    assert.ok(row);
    // 管理端日志页按客户端发的名字筛选：用户搜自己发出去的名字必须搜得到
    assert.equal(row.model, 'gpt-4o');
    assert.equal(row.cost_cents, 120, '换算用的是上游真实名（注入的换算器只认 gpt-4o）');
  });

  it('「全失败」那条终态日志的空串外键转成 NULL（不留指向空主键的假关联）', () => {
    const h = setup();
    h.sink.record(entry({ keyId: '', upstreamId: '', groupId: '', statusCode: 503, failureReason: 'NO_AVAILABLE_KEY', promptTokens: 0, completionTokens: 0, totalTokens: 0 }));
    h.sink.flush();

    const [row] = rows(h.db);
    assert.ok(row);
    assert.equal(row.key_id, null);
    assert.equal(row.upstream_id, null);
    assert.equal(row.group_id, null);
    assert.equal(row.key_masked, '****');
    assert.equal(row.error_code, 'NO_AVAILABLE_KEY');
  });

  // 假定时器：到点由测试推进。原来那条 `setInterval(20)` + `sleep(80)` 的判据里
  // 掺了"机器这 80ms 有多闲"，在 CI 上偶发红；推进时间轴才是"到点"的确定含义。
  // `toFake` 只点名 interval，不碰 Date（本文件没有依赖真实当下的断言，但不留这条缝）。
  it('定时器到点自动落库（不是只在退出时刷）', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = setup({ flushIntervalMs: 20 });
    h.sink.record(entry());

    assert.equal(rowCount(h.db), 0, 'record 只入队：没到点前一行都不该有');

    vi.advanceTimersByTime(20);
    assert.equal(rowCount(h.db), 1);
    assert.equal(h.sink.pending(), 0);
  });
});

describe('丢账计数', () => {
  it('队列溢出丢最旧的一批并计数（保住"最近发生了什么"）', () => {
    const overflow: string[] = [];
    const h = setup({ maxQueue: 3, dropped: overflow });
    for (const model of ['m1', 'm2', 'm3', 'm4', 'm5']) h.sink.record(entry({ clientModel: model }));

    assert.equal(h.sink.pending(), 3);
    assert.equal(h.sink.dropped(), 2);
    assert.deepEqual(overflow, ['overflow:1', 'overflow:1']);

    h.sink.flush();
    assert.deepEqual(
      rows(h.db).map((r) => r.model),
      ['m3', 'm4', 'm5'],
    );
  });

  it('落库真异常：丢这一批 + 计数 + 回调，而不是抛到请求线程上', () => {
    const errors: unknown[] = [];
    const h = setup({ errors });
    h.sink.record(entry());
    h.sink.record(entry());
    h.db.exec('DROP TABLE usage_logs'); // 模拟 schema 不对/磁盘故障这类真异常

    assert.equal(h.sink.flush(), 0);
    assert.equal(h.sink.dropped(), 2);
    assert.equal(errors.length, 1);
    assert.equal(h.sink.pending(), 0, '坏批不该塞回队首让新记录排在一个坏连接后面');
  });

  it('close() 停表 + 最后一次 flush（退出时不丢最后一批）', () => {
    const h = setup({ flushIntervalMs: 5 });
    h.sink.record(entry());
    h.sink.close();

    assert.equal(rowCount(h.db), 1);
    assert.equal(h.sink.pending(), 0);
    // 再记一条也不会被定时器刷走（表已停），但 flush 仍然可用
    h.sink.record(entry({ clientModel: 'after-close' }));
    assert.equal(rowCount(h.db), 1);
    assert.equal(h.sink.flush(), 1);
  });
});
