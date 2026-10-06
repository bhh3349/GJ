// 健康指标计算（契约 §12.2 / ADR-0013）。
//
// 这一层的风险不在"算错了会崩"，而在"算出一个看起来对的假数字"：
//   1. 分位用最近秩 —— 必须恰好是**某一次真实请求**的延迟。插值会给出一个
//      没有任何请求达到过的值，在"这 5 分钟到底慢不慢"这个问题上那是假数据；
//   2. 无样本 ≠ 0：`p50/p99` 必须是 `null`，不能补 0（补 0 会把"没流量"说成"极快"）；
//   3. 窗口回显用户输入的那一个字符串：`300s` 与 `5m` 秒数相同但不是同一个东西，
//      前端按回显勾选项，由秒数反推会让它勾错；
//   4. `db.fileSizeBytes/walSizeBytes` 是参考值，取不到一律 null（不编 0）；
//      响应里**不含库文件路径**（那是部署细节）。

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './database.js';
import { appendUsageLog, type UsageLogInput } from './repo/logs.js';
import { SCHEMA_VERSION } from './schema.js';
import { appendGatewayErrorEvent } from './repo/gateway-events.js';
import { computeHealthMetrics, inspectDb, latencyPercentiles, percentile } from './observability.js';

const dirs: string[] = [];
const open: Db[] = [];

afterEach(() => {
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

function setup(): { db: Db; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'obs-probe-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  open.push(db);
  return { db, dbPath };
}

/** 插一条调用日志。`latencyMs` 是这里唯一关心的判据。 */
function log(ts: string, latencyMs: number | null, status = 200): UsageLogInput {
  return {
    ts,
    requestId: null,
    groupId: null,
    model: 'gpt-probe',
    upstreamId: null,
    keyId: null,
    keyMasked: '****robe',
    status,
    errorCode: null,
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    isEstimated: false,
    latencyMs,
    ttfbMs: null,
    stream: false,
    costCents: 0,
  };
}

/** 相对"现在"的时刻（窗口都是相对现在算的，固定历史时间会落在窗口外）。 */
function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe('percentile：最近秩，不做插值', () => {
  it('P50/P99 落在真实样本上', () => {
    const { db } = setup();
    const from = agoIso(60_000);
    for (const ms of [40, 10, 30, 20]) appendUsageLog(db, log(agoIso(1000), ms));

    // n=4：p50 → ceil(2)=2 → 第 2 小 = 20；p99 → ceil(3.96)=4 → 第 4 小 = 40
    expect(percentile(db, from, 0.5)).toBe(20);
    expect(percentile(db, from, 0.99)).toBe(40);
    // 不插值：不会出现 25 / 39.7 这种"没有任何一次请求达到过"的值
    const samples = [10, 20, 30, 40];
    expect(samples).toContain(percentile(db, from, 0.5));
    expect(samples).toContain(percentile(db, from, 0.99));
  });

  it('单样本：P50 与 P99 都是它本人', () => {
    const { db } = setup();
    appendUsageLog(db, log(agoIso(1000), 7));
    const p = latencyPercentiles(db, agoIso(60_000));
    expect(p.p50).toBe(7);
    expect(p.p99).toBe(7);
    expect(p.samples).toBe(1);
  });

  it('无样本 → null 而不是 0；样本数照实为 0', () => {
    const { db } = setup();
    const p = latencyPercentiles(db, agoIso(60_000));
    expect(p.samples).toBe(0);
    expect(p.p50).toBeNull();
    expect(p.p99).toBeNull();
    expect(percentile(db, agoIso(60_000), 0.5)).toBeNull();
  });

  it('窗口外的样本不计入，latency 缺失的行也不算样本', () => {
    const { db } = setup();
    appendUsageLog(db, log(agoIso(3600_000), 999)); // 窗口外
    appendUsageLog(db, log(agoIso(1000), null)); // 无延迟（未完成/未记录）
    appendUsageLog(db, log(agoIso(1000), 12));
    const p = latencyPercentiles(db, agoIso(60_000));
    expect(p.samples).toBe(1);
    expect(p.p50).toBe(12);
  });
});

describe('inspectDb', () => {
  it('ok 是真跑了一次查询的结果，版本号与 schema 一致', () => {
    const { db } = setup();
    const info = inspectDb(db);
    expect(info.ok).toBe(true);
    expect(info.schemaVersion).toBe(SCHEMA_VERSION);
    expect(info.fileSizeBytes).toBeGreaterThan(0);
    expect(typeof info.queryMs).toBe('number');
  });

  it('不泄漏库文件路径（部署细节不进观测面）', () => {
    const { db, dbPath } = setup();
    expect(JSON.stringify(inspectDb(db))).not.toContain(dbPath);
    expect(JSON.stringify(inspectDb(db))).not.toContain('gateway.db');
  });

  it('WAL 大小：文件在就取实际大小，取不到就是 null（不编 0）', () => {
    const { db, dbPath } = setup();
    appendUsageLog(db, log(agoIso(1000), 5)); // 有写入才有 -wal
    const walPath = `${dbPath}-wal`;
    const info = inspectDb(db);
    expect(info.walSizeBytes).toBe(existsSync(walPath) ? statSync(walPath).size : null);
  });

  it('库关掉之后 ok=false，但**不抛**（观测面要能报告"库出问题了"）', () => {
    const { db } = setup();
    db.close();
    const info = inspectDb(db);
    expect(info.ok).toBe(false);
  });
});

describe('computeHealthMetrics', () => {
  it('窗口回显用户输入的字符串（5m 不能反推成 300s）', () => {
    const { db } = setup();
    const m = computeHealthMetrics({
      db,
      windowSeconds: 300,
      windowLabel: '5m',
      startedAt: new Date(),
      droppedEvents: 0,
    });
    expect(m.window).toBe('5m');
    expect(m.generatedAt).toMatch(/Z$/);
  });

  it('uptime 用启动时记下的那个值算，不用进程 uptime 现推', () => {
    const { db } = setup();
    const startedAt = new Date(Date.now() - 90_000);
    const m = computeHealthMetrics({ db, windowSeconds: 60, windowLabel: '60s', startedAt, droppedEvents: 0 });
    expect(m.uptimeSec).toBeGreaterThanOrEqual(89);
    expect(m.uptimeSec).toBeLessThanOrEqual(92);
    expect(m.startedAt).toBe(startedAt.toISOString());
  });

  it('流量口径与 §6 overview 同源：requests/errors/successRate/tokens', () => {
    const { db } = setup();
    appendUsageLog(db, log(agoIso(1000), 10));
    appendUsageLog(db, log(agoIso(1000), 20));
    appendUsageLog(db, log(agoIso(1000), 30, 502));

    const m = computeHealthMetrics({ db, windowSeconds: 300, windowLabel: '5m', startedAt: new Date(), droppedEvents: 0 });
    expect(m.traffic.requests).toBe(3);
    expect(m.traffic.errors).toBe(1);
    // 2/3 成功，四舍五入到 4 位
    expect(m.traffic.successRate).toBeCloseTo(0.6667, 4);
    expect(m.traffic.tokens).toEqual({ prompt: 30, completion: 15, total: 45 });
    expect(m.traffic.latencyMs.samples).toBe(3);
    expect(m.traffic.latencyMs.p50).toBe(20);
  });

  it('无流量时 successRate=1（不是 0）且分位为 null', () => {
    const { db } = setup();
    const m = computeHealthMetrics({ db, windowSeconds: 300, windowLabel: '5m', startedAt: new Date(), droppedEvents: 0 });
    expect(m.traffic.requests).toBe(0);
    expect(m.traffic.successRate).toBe(1);
    expect(m.traffic.latencyMs).toEqual({ p50: null, p99: null, samples: 0 });
  });

  it('错误分型计数取自窗口内的结构化事件，dropped 是进程累计值', () => {
    const { db } = setup();
    const base = {
      ts: agoIso(1000),
      requestId: null,
      gatewayCode: 'UPSTREAM_ERROR',
      failureReason: 'UPSTREAM_ERROR',
      endpoint: '/v1/chat/completions',
      model: 'gpt-probe',
      upstreamId: 'up_probe',
      keyId: 'key_probe',
      keyMasked: '****robe',
      stream: false,
      upstreamStatus: 502,
      attempts: 1,
      candidates: 2,
      latencyMs: 12,
      message: 'upstream 502',
    };
    appendGatewayErrorEvent(db, { ...base, severity: 'error', category: 'UPSTREAM_ERROR', status: 502 });
    appendGatewayErrorEvent(db, { ...base, severity: 'warn', category: 'RATE_LIMITED', status: 429, gatewayCode: 'RATE_LIMITED' });

    const m = computeHealthMetrics({ db, windowSeconds: 300, windowLabel: '5m', startedAt: new Date(), droppedEvents: 7 });
    expect(m.events.total).toBe(2);
    expect(m.events.dropped).toBe(7);
    expect(m.events.byCategory.map((r) => r.category).sort()).toEqual(['RATE_LIMITED', 'UPSTREAM_ERROR']);
  });

  it('无 key 时 key 总览是零值而不是缺字段', () => {
    const { db } = setup();
    const m = computeHealthMetrics({ db, windowSeconds: 60, windowLabel: '60s', startedAt: new Date(), droppedEvents: 0 });
    expect(m.keys).toEqual({ total: 0, healthy: 0, cooling: 0, disabled: 0, items: [] });
    expect(m.db.ok).toBe(true);
  });
});
