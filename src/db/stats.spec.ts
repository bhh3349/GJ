// `/api/stats/usage` 的 token 维度口径（契约 §6 · 补遗 v1.0.5 / ADR-0012）。
//
// M6-A 往每个点加了 `promptTokens` / `completionTokens` / `estimatedTokens` 三个字段。
// 这里测的不是"字段在不在"，而是三条一旦破了就会静默出错的**不变式**：
//   1. `tokens === promptTokens + completionTokens`。上游偶尔上报一个与
//      prompt+completion 对不上的 total（`src/gateway/usage.ts` 的 `total ?? p + c`），
//      若各取各的，同一张图上"总 tokens"与"输入/输出"两条线会在个别桶上对不齐 ——
//      这种小偏差几乎不会被发现，却会让整张图失去可信度；
//   2. `isEstimatedTokenCount === 全轴 estimatedTokens 之和`（同源，不靠两条 SQL 碰巧一致）；
//   3. 点的数据与 `usage_logs` 明细**对得上**（DoD 第⑥条：抽样对账）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './database.js';
import { appendUsageLog, type UsageLogInput } from './repo/logs.js';
import { computeUsage } from './stats.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响判据 */
    }
  }
});

function setup(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'stats-probe-'));
  dirs.push(dir);
  return openDatabase({ path: join(dir, 'gateway.db') });
}

/** 只填必要字段，其余给安全默认值 —— 测试要读的是 token 口径，不是别的列。 */
function log(ts: string, model: string, tokens: Partial<UsageLogInput> & { promptTokens: number }): UsageLogInput {
  const completionTokens = tokens.completionTokens ?? 0;
  return {
    ts,
    requestId: null,
    groupId: null,
    model,
    upstreamId: null,
    keyId: null,
    keyMasked: '****abcd',
    status: 200,
    errorCode: null,
    promptTokens: tokens.promptTokens,
    completionTokens,
    // 默认与 p+c 一致；要模拟"上游上报的 total 不一致"，用例里显式覆盖它
    totalTokens: tokens.totalTokens ?? tokens.promptTokens + completionTokens,
    isEstimated: tokens.isEstimated ?? false,
    latencyMs: null,
    ttfbMs: null,
    stream: false,
    costCents: tokens.costCents ?? 0,
  };
}

const FROM = '2026-10-05T00:00:00.000Z';
const TO = '2026-10-05T01:00:00.000Z';

describe('usage 的 token 维度', () => {
  it('每个点都满足 tokens === promptTokens + completionTokens（即便上游 total 对不上）', () => {
    const db = setup();
    // 第二条刻意让 total_tokens 与 p+c 不一致，模拟上游上报了一个自相矛盾的 total
    appendUsageLog(db, log('2026-10-05T00:10:00.000Z', 'gpt-probe', { promptTokens: 100, completionTokens: 50 }));
    appendUsageLog(
      db,
      log('2026-10-05T00:20:00.000Z', 'gpt-probe', {
        promptTokens: 30,
        completionTokens: 20,
        totalTokens: 999,
      }),
    );

    const res = computeUsage(db, { from: FROM, to: TO, bucket: '5m', groupBy: 'model' });
    const points = res.series.flatMap((s) => s.points);
    const withData = points.filter((p) => p.requests > 0);

    expect(withData.length).toBeGreaterThan(0);
    for (const p of points) expect(p.tokens).toBe(p.promptTokens + p.completionTokens);
    // 反证：被丢弃的那个 999 没被算进去
    expect(res.series.reduce((sum, s) => sum + s.points.reduce((a, p) => a + p.tokens, 0), 0)).toBe(200);
    db.close();
  });

  it('estimatedTokens 按条数计，且全轴求和 === isEstimatedTokenCount', () => {
    const db = setup();
    appendUsageLog(db, log('2026-10-05T00:05:00.000Z', 'gpt-probe', { promptTokens: 10 }));
    appendUsageLog(db, log('2026-10-05T00:06:00.000Z', 'gpt-probe', { promptTokens: 10, isEstimated: true }));
    appendUsageLog(db, log('2026-10-05T00:40:00.000Z', 'gpt-probe', { promptTokens: 10, isEstimated: true }));

    const res = computeUsage(db, { from: FROM, to: TO, bucket: '5m', groupBy: 'model' });
    const sum = res.series.reduce((acc, s) => acc + s.points.reduce((a, p) => a + p.estimatedTokens, 0), 0);

    expect(sum).toBe(2);
    expect(res.isEstimatedTokenCount).toBe(sum);
    // 含估算的桶被打标，不含的保持 0
    const buckets = res.series[0]?.points ?? [];
    expect(buckets.filter((p) => p.estimatedTokens > 0).length).toBe(2);
  });

  it('轴的每个点都补齐（缺桶补 0），且与明细对账一致', () => {
    const db = setup();
    appendUsageLog(db, log('2026-10-05T00:00:00.000Z', 'm-a', { promptTokens: 10, completionTokens: 5 }));
    appendUsageLog(db, log('2026-10-05T00:30:00.000Z', 'm-a', { promptTokens: 20, completionTokens: 7 }));
    appendUsageLog(db, log('2026-10-05T00:31:00.000Z', 'm-b', { promptTokens: 1, completionTokens: 1 }));

    const res = computeUsage(db, { from: FROM, to: TO, bucket: '5m', groupBy: 'model' });
    for (const s of res.series) expect(s.points.length).toBe(res.axis.length);

    // 与明细对账（DoD 第⑥条）：逐模型比对 SUM(prompt) / SUM(completion) / COUNT(*)
    for (const s of res.series) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n, COALESCE(SUM(prompt_tokens), 0) AS p, COALESCE(SUM(completion_tokens), 0) AS c
           FROM usage_logs WHERE model = ? AND ts >= ? AND ts <= ?`,
        )
        .get(s.label, FROM, TO) as { n: number; p: number; c: number };
      expect(s.points.reduce((a, x) => a + x.requests, 0)).toBe(row.n);
      expect(s.points.reduce((a, x) => a + x.promptTokens, 0)).toBe(row.p);
      expect(s.points.reduce((a, x) => a + x.completionTokens, 0)).toBe(row.c);
    }
    db.close();
  });
});
