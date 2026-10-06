// `balance_snapshots` 仓储（契约 §14.3 / ADR-0017）。
//
// 这里钉住的是四条一旦破了就静默出错的口径：
//   1. **`NULL` 与 `0` 是两条不同的行** —— `total_balance_cents` 可空就是为它存在的
//      （"那一刻全未知" ≠ "确实没钱了"）；
//   2. **追加，不 upsert** —— 同一 `ts` 出现两条比丢掉一条安全（同健康快照的取舍）；
//   3. **`previousBalanceSnapshot` 严格早于** —— 同一毫秒的另一条不算"上一次"，
//      否则漂移判定的差额衡量的是一瞬间而不是一个区间；
//   4. **无外键 + 名字快照** —— 上游按 ADR-0016 物理删除后，快照行仍在且展示名可读。
//
// 保留期那条（周期裁剪）在调度器 spec 里断言"跑起来了"，这里只断言"裁得对"。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../database.js';
import { newId } from '../ids.js';
import { createKey } from './keys.js';
import { createUpstream, deleteUpstream } from './upstreams.js';
import {
  appendBalanceSnapshot,
  latestBalanceSnapshot,
  latestSnapshotTsPerUpstream,
  listBalanceSnapshots,
  previousBalanceSnapshot,
  pruneBalanceSnapshots,
  sumTokensBetween,
  type BalanceSnapshotInput,
} from './balance-snapshots.js';

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

function setup(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'balsnap-probe-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  open.push(db);
  return db;
}

function input(over: Partial<BalanceSnapshotInput> = {}): BalanceSnapshotInput {
  return {
    upstreamId: 'up_probe',
    upstreamName: 'probe-up',
    ts: '2026-10-07T00:00:00.000Z',
    totalBalanceCents: 12345,
    knownKeyCount: 2,
    unknownKeyCount: 1,
    tokenPlanKeyCount: 3,
    trigger: 'auto',
    ...over,
  };
}

describe('写入与读取（契约 §14.3）', () => {
  it('追加后可读回，字段逐一对应（金额用分、计数用 int）', () => {
    const db = setup();
    const id = appendBalanceSnapshot(db, input({ ts: '2026-10-07T01:00:00.000Z' }));

    const rows = listBalanceSnapshots(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id,
      upstreamId: 'up_probe',
      upstreamName: 'probe-up',
      ts: '2026-10-07T01:00:00.000Z',
      totalBalanceCents: 12345,
      knownKeyCount: 2,
      unknownKeyCount: 1,
      tokenPlanKeyCount: 3,
      trigger: 'auto',
    });
  });

  it('`total_balance_cents = null` 与 `0` 存成两条不同的行，读回来也不被合并', () => {
    const db = setup();
    appendBalanceSnapshot(db, input({ ts: '2026-10-07T01:00:00.000Z', totalBalanceCents: null }));
    appendBalanceSnapshot(db, input({ ts: '2026-10-07T02:00:00.000Z', totalBalanceCents: 0 }));

    const rows = listBalanceSnapshots(db);
    expect(rows.map((r) => r.totalBalanceCents)).toEqual([null, 0]);
    expect(rows[0]?.totalBalanceCents).toBeNull();
    expect(rows[1]?.totalBalanceCents).toBe(0);
  });

  it('同一 `ts` 追加两次留下两行（不做 upsert）', () => {
    const db = setup();
    appendBalanceSnapshot(db, input({ totalBalanceCents: 100 }));
    appendBalanceSnapshot(db, input({ totalBalanceCents: 200 }));

    const rows = listBalanceSnapshots(db);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it('按 `(upstream_id, ts, id)` 升序返回，窗口过滤按 ts 闭区间', () => {
    const db = setup();
    appendBalanceSnapshot(db, input({ upstreamId: 'up_b', ts: '2026-10-07T01:00:00.000Z' }));
    appendBalanceSnapshot(db, input({ upstreamId: 'up_a', ts: '2026-10-07T03:00:00.000Z' }));
    appendBalanceSnapshot(db, input({ upstreamId: 'up_a', ts: '2026-10-07T02:00:00.000Z' }));

    const all = listBalanceSnapshots(db);
    expect(all.map((r) => `${r.upstreamId}@${r.ts}`)).toEqual([
      'up_a@2026-10-07T02:00:00.000Z',
      'up_a@2026-10-07T03:00:00.000Z',
      'up_b@2026-10-07T01:00:00.000Z',
    ]);

    const windowed = listBalanceSnapshots(db, {
      from: '2026-10-07T02:00:00.000Z',
      to: '2026-10-07T03:00:00.000Z',
      upstreamId: 'up_a',
    });
    expect(windowed).toHaveLength(2);
  });

  it('`latestBalanceSnapshot` 取全局最近一条；空表回 null', () => {
    const db = setup();
    expect(latestBalanceSnapshot(db)).toBeNull();

    appendBalanceSnapshot(db, input({ upstreamId: 'up_a', ts: '2026-10-07T05:00:00.000Z' }));
    appendBalanceSnapshot(db, input({ upstreamId: 'up_b', ts: '2026-10-07T09:00:00.000Z' }));
    const latest = latestBalanceSnapshot(db);
    expect(latest?.upstreamId).toBe('up_b');
    expect(latest?.ts).toBe('2026-10-07T09:00:00.000Z');
  });

  it('`latestSnapshotTsPerUpstream` 每上游一条 MAX(ts)，没快照的上游不出现', () => {
    const db = setup();
    appendBalanceSnapshot(db, input({ upstreamId: 'up_a', ts: '2026-10-07T01:00:00.000Z' }));
    appendBalanceSnapshot(db, input({ upstreamId: 'up_a', ts: '2026-10-07T04:00:00.000Z' }));
    appendBalanceSnapshot(db, input({ upstreamId: 'up_b', ts: '2026-10-07T02:00:00.000Z' }));

    const map = latestSnapshotTsPerUpstream(db);
    expect(map.get('up_a')).toBe('2026-10-07T04:00:00.000Z');
    expect(map.get('up_b')).toBe('2026-10-07T02:00:00.000Z');
    expect(map.has('up_c')).toBe(false);
  });
});

describe('漂移判定的两次相邻快照（契约 §14.4）', () => {
  it('`previousBalanceSnapshot` 取严格早于的那条，同毫秒的另一条不算"上一次"', () => {
    const db = setup();
    appendBalanceSnapshot(db, input({ ts: '2026-10-07T01:00:00.000Z', totalBalanceCents: 111 }));
    appendBalanceSnapshot(db, input({ ts: '2026-10-07T02:00:00.000Z', totalBalanceCents: 222 }));

    const prev = previousBalanceSnapshot(db, 'up_probe', '2026-10-07T02:00:00.000Z');
    expect(prev?.totalBalanceCents).toBe(111);

    // 同一毫秒：`ts < ?` 把它排除掉，于是拿到的仍是更早那条（而不是"自己"）
    const sameMs = previousBalanceSnapshot(db, 'up_probe', '2026-10-07T01:00:00.000Z');
    expect(sameMs).toBeNull();
  });

  it('只认自己上游：另一上游有更晚的快照也不会被当成"上一次"', () => {
    const db = setup();
    appendBalanceSnapshot(db, input({ upstreamId: 'up_a', ts: '2026-10-07T01:00:00.000Z' }));
    appendBalanceSnapshot(db, input({ upstreamId: 'up_b', ts: '2026-10-07T02:00:00.000Z' }));

    expect(previousBalanceSnapshot(db, 'up_a', '2026-10-07T03:00:00.000Z')?.upstreamId).toBe('up_a');
    expect(previousBalanceSnapshot(db, 'up_c', '2026-10-07T03:00:00.000Z')).toBeNull();
  });

  it('`sumTokensBetween` 是左开右闭，且**不按 key 过滤**（换了 key 仍是这个上游在用）', () => {
    const db = setup();
    const insert = db.prepare(
      `INSERT INTO usage_logs (id, ts, upstream_id, key_id, key_masked, status, total_tokens)
       VALUES (?, ?, ?, ?, '****probe', 200, ?)`,
    );
    // 窗口左端点上的那条不计入（左开）
    insert.run(newId('log'), '2026-10-07T01:00:00.000Z', 'up_probe', 'key_a', 100);
    insert.run(newId('log'), '2026-10-07T01:00:00.001Z', 'up_probe', 'key_a', 40);
    insert.run(newId('log'), '2026-10-07T02:00:00.000Z', 'up_probe', 'key_b', 60);
    // 窗口右端点之外：不计入
    insert.run(newId('log'), '2026-10-07T02:00:00.001Z', 'up_probe', 'key_a', 999);
    // 别的上游：不计入
    insert.run(newId('log'), '2026-10-07T01:30:00.000Z', 'up_other', 'key_c', 777);

    expect(sumTokensBetween(db, 'up_probe', '2026-10-07T01:00:00.000Z', '2026-10-07T02:00:00.000Z')).toBe(100);
  });

  it('窗口内一条用量都没有时回 0（不是 null）—— 漂移判据要拿它做 `=== 0` 判断', () => {
    const db = setup();
    expect(sumTokensBetween(db, 'up_probe', '2026-10-07T01:00:00.000Z', '2026-10-07T02:00:00.000Z')).toBe(0);
  });
});

describe('保留期裁剪（契约 §14.3）', () => {
  it('只删早于 `now - retentionDays` 的行，边界那条留着', () => {
    const db = setup();
    const now = new Date('2026-10-07T12:00:00.000Z');
    // 边界：正好 90 天前 —— `ts < cutoff` 是严格小于，所以它必须留下
    appendBalanceSnapshot(db, input({ ts: '2026-07-09T12:00:00.000Z' }));
    appendBalanceSnapshot(db, input({ ts: '2026-07-09T11:59:59.999Z' }));
    appendBalanceSnapshot(db, input({ ts: '2026-10-07T11:00:00.000Z' }));

    expect(pruneBalanceSnapshots(db, 90, now)).toBe(1);
    expect(listBalanceSnapshots(db).map((r) => r.ts)).toEqual([
      '2026-07-09T12:00:00.000Z',
      '2026-10-07T11:00:00.000Z',
    ]);
  });

  it('可反复调用（周期任务的语义），没有可删的行时回 0', () => {
    const db = setup();
    const now = new Date('2026-10-07T12:00:00.000Z');
    appendBalanceSnapshot(db, input({ ts: '2026-07-09T11:00:00.000Z' }));

    expect(pruneBalanceSnapshots(db, 90, now)).toBe(1);
    expect(pruneBalanceSnapshots(db, 90, now)).toBe(0);
  });
});

describe('无外键 + 名字快照（对偶 ADR-0016 的物理删除）', () => {
  it('上游按依赖序物理删除后，快照行仍在且 `upstream_name` 可读', () => {
    const db = setup();
    const masterKey = Buffer.from('2a'.repeat(32), 'hex');
    const up = createUpstream(db, { name: 'probe-up', baseUrl: 'https://upstream.example.com' });
    // 桩 key 一律**运行时拼**（同 `observability.spec.ts`）：`sk-` 后面接 ≥20 位字面量
    // 会被自己的 `check:secrets` 抓成"疑似真 key"—— 扫描器不分测试与生产。
    createKey(db, { upstreamId: up.id, key: 'sk-probe-' + 'B'.repeat(24), category: 'balance' }, masterKey);
    appendBalanceSnapshot(db, {
      upstreamId: up.id,
      upstreamName: up.name,
      ts: '2026-10-07T01:00:00.000Z',
      totalBalanceCents: 5000,
      knownKeyCount: 1,
      unknownKeyCount: 0,
      tokenPlanKeyCount: 0,
      trigger: 'auto',
    });

    // 有 key 时必须显式 force —— 没有外键，删除不会因为快照行而卡住
    expect(() => deleteUpstream(db, up.id, false)).toThrow();
    deleteUpstream(db, up.id, true);

    const rows = listBalanceSnapshots(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.upstreamId).toBe(up.id);
    expect(rows[0]?.upstreamName).toBe('probe-up');
    expect(rows[0]?.totalBalanceCents).toBe(5000);
  });
});
