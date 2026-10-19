// 保留策略裁剪（`audit_log` / `tasks` / `change_log`）—— 契约 §6 / §5 / §9。
//
// 这三个 prune 是 2026-10-16 新接进维护定时器的（此前 `pruneAudit` / `pruneTasks`
// 根本不存在，`pruneChanges` / `pruneGatewayErrorEvents` 存在但**零生产调用方**）。
// 它们共同的危险是**删错东西且不报错**：
//   · 审计多删一行 = 一条不可追查的管理动作；
//   · 任务删掉一条在跑的 = 前端轮询拿到 404；
//   · 广播裁过头 = 消费者漏一次变更，而漏了**没有任何信号**。
// 所以这里钉的不是"能删"，而是三条边界：`<` 而非 `<=`、只删终态、裁得动但不越界。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../database.js';
import { appendAudit, pruneAudit } from './audit.js';
import { appendChange, pruneChanges } from './change-log.js';
import { createTask, finishTask, getTask, pruneTasks } from './tasks.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'retention-probe-'));
  dirs.push(dir);
  return openDatabase({ path: join(dir, 'gateway.db') });
}

/** 审计行只能走 `appendAudit`（它自己打 `nowIso()`），历史行直接插库。 */
function insertAudit(db: Db, ts: string, action = 'probe.action'): void {
  db.prepare(
    `INSERT INTO audit_log (id, ts, actor, ip, action, target_type, target_id, result, detail)
     VALUES (?, ?, 'probe', '127.0.0.1', ?, 'probe', 'probe_1', 'ok', NULL)`,
  ).run(`aud_${ts}`, ts, action);
}

function auditCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
}

describe('pruneAudit（契约 §6，默认 180 天）', () => {
  it('只删严格早于 cutoff 的行；边界那条（ts === cutoff）留着', () => {
    const db = setup();
    const now = new Date('2026-10-16T00:00:00.000Z');
    const cutoff = new Date(now.getTime() - 180 * 86_400_000).toISOString();

    insertAudit(db, cutoff);
    insertAudit(db, '2026-04-18T23:59:59.999Z');
    insertAudit(db, '2026-10-15T12:00:00.000Z');

    expect(pruneAudit(db, 180, now)).toBe(1);
    expect(auditCount(db)).toBe(2);
    const left = db.prepare('SELECT ts FROM audit_log ORDER BY ts').all() as { ts: string }[];
    expect(left.map((r) => r.ts)).toEqual([cutoff, '2026-10-15T12:00:00.000Z']);
  });

  it('`<` 而不是 `<=`：拿毫秒差一行做判据，不是"差一天"这种粗粒度', () => {
    const db = setup();
    const now = new Date('2026-10-16T00:00:00.000Z');
    const cutoff = new Date(now.getTime() - 180 * 86_400_000);
    // cutoff - 1ms：必须删；cutoff：必须留。两者只差一毫秒。
    insertAudit(db, new Date(cutoff.getTime() - 1).toISOString());
    insertAudit(db, cutoff.toISOString());

    expect(pruneAudit(db, 180, now)).toBe(1);
    expect(auditCount(db)).toBe(1);
  });

  it('可反复调用（周期任务的语义），没有可删的行时回 0', () => {
    const db = setup();
    const now = new Date('2026-10-16T00:00:00.000Z');
    insertAudit(db, '2026-04-18T23:59:59.999Z');

    expect(pruneAudit(db, 180, now)).toBe(1);
    expect(pruneAudit(db, 180, now)).toBe(0);
  });

  it('空表不炸（维护定时器第一次跑时表很可能是空的）', () => {
    const db = setup();
    expect(pruneAudit(db, 180, new Date('2026-10-16T00:00:00.000Z'))).toBe(0);
  });

  it('retentionDays = 0 不是"清空全表"：严格 `<` 让 `ts === now` 那条留下', () => {
    const db = setup();
    const now = new Date('2026-10-16T00:00:00.000Z');
    insertAudit(db, now.toISOString());
    insertAudit(db, '2026-10-15T23:59:59.999Z');

    // cutoff = now，所以"刚刚写的那条"按同一套 `<` 纪律留在窗口内。
    // 这不是漏洞：`retentionDays = 0` 的语义是"一天都不留"，而"这一毫秒"仍属于今天。
    expect(pruneAudit(db, 0, now)).toBe(1);
    expect(auditCount(db)).toBe(1);
  });

  it('`appendAudit` 写的行同样在裁的射程内（没有只认手插行的隐歧）', () => {
    const db = setup();
    appendAudit(db, { actor: 'probe', ip: '127.0.0.1', action: 'probe.append', targetType: 'probe', result: 'ok' });
    // 默认 `now` 让刚写的行落在窗口内 —— 180 天保留期下它必须活下来
    expect(pruneAudit(db, 180)).toBe(0);
    expect(auditCount(db)).toBe(1);
  });
});

describe('pruneTasks（契约 §5，默认 7 天）', () => {
  it('只删**已终态**且早于 cutoff 的行', () => {
    const db = setup();
    const now = new Date('2026-10-16T00:00:00.000Z');
    const cutoff = new Date(now.getTime() - 7 * 86_400_000);

    const old = createTask(db, 'probe.old', 1);
    finishTask(db, old.id, 'succeeded', { message: 'done' });
    // cutoff 之前一毫秒 —— `finished_at < cutoff` 才为真
    db.prepare('UPDATE tasks SET finished_at = ? WHERE id = ?').run(
      new Date(cutoff.getTime() - 1).toISOString(),
      old.id,
    );

    const fresh = createTask(db, 'probe.fresh', 1);
    finishTask(db, fresh.id, 'failed', { message: 'boom' });

    expect(pruneTasks(db, 7, now)).toBe(1);
    expect(getTask(db, old.id)).toBeNull();
    expect(getTask(db, fresh.id)?.status).toBe('failed');
  });

  // 注意这条判据的**真实防护范围**，别把它当成比实际更强的东西（2026-10-16 实测）：
  // 直接把谓词删成 `finished_at < ?` 时本用例**依然绿** —— SQL 里 `NULL < cutoff`
  // 恒为假，所以在跑的任务碰巧也是安全的。它真正拦的是注释里点名的那次"优化"：
  // 有人嫌 NULL 比较别扭，补一个 `COALESCE(finished_at, started_at)` ——
  // 那一版会让在跑的任务按**开始时间**被裁掉，而前端轮询会开始收到 404。
  // 两者都已用变异验证过：前者不红，后者红。所以这条钉的是"不许引入 started_at 兜底"。
  it('在跑的（queued / running）无论多老都不删 —— `finished_at IS NOT NULL` 这条谓词', () => {
    const db = setup();
    const now = new Date('2026-10-16T00:00:00.000Z');
    const ancient = new Date('2020-01-01T00:00:00.000Z').toISOString();

    const queued = createTask(db, 'probe.queued', 3);
    db.prepare('UPDATE tasks SET started_at = ? WHERE id = ?').run(ancient, queued.id);
    const running = createTask(db, 'probe.running', 3);
    db.prepare("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?").run(ancient, running.id);

    expect(pruneTasks(db, 7, now)).toBe(0);
    expect(getTask(db, queued.id)?.status).toBe('queued');
    expect(getTask(db, running.id)?.status).toBe('running');
  });

  it('边界：finished_at 恰好等于 cutoff 留着（`<` 而非 `<=`）', () => {
    const db = setup();
    const now = new Date('2026-10-16T00:00:00.000Z');
    const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();

    const t = createTask(db, 'probe.edge', 1);
    finishTask(db, t.id, 'succeeded');
    db.prepare('UPDATE tasks SET finished_at = ? WHERE id = ?').run(cutoff, t.id);

    expect(pruneTasks(db, 7, now)).toBe(0);
    expect(getTask(db, t.id)?.status).toBe('succeeded');
  });

  it('`result` 是 JSON 也不影响裁剪：整行删掉，不解析', () => {
    const db = setup();
    const now = new Date('2026-10-16T00:00:00.000Z');
    const t = createTask(db, 'probe.bigresult', 1);
    finishTask(db, t.id, 'succeeded', { result: { rows: [1, 2, 3] } });
    db.prepare('UPDATE tasks SET finished_at = ? WHERE id = ?').run('2026-01-01T00:00:00.000Z', t.id);

    expect(pruneTasks(db, 7, now)).toBe(1);
    expect(getTask(db, t.id)).toBeNull();
  });

  it('空表不炸', () => {
    const db = setup();
    expect(pruneTasks(db, 7, new Date('2026-10-16T00:00:00.000Z'))).toBe(0);
  });
});

describe('pruneChanges（契约 §9，默认 10000 行）', () => {
  /** 读当前最大 seq —— 裁剪线是相对水位算的，不是绝对 seq。 */
  function maxSeq(db: Db): number {
    return (db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM change_log').get() as { n: number }).n;
  }

  it('表没超过 keep 时一行不删', () => {
    const db = setup();
    for (let i = 0; i < 5; i++) appendChange(db, 'key', 'key_probe', 'update', null);
    expect(maxSeq(db)).toBe(5);

    pruneChanges(db, 10);
    expect(maxSeq(db)).toBe(5);
    expect((db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n).toBe(5);
  });

  it('超过 keep 时只删最旧的，留下的正好是 keep 条且 seq 连续', () => {
    const db = setup();
    for (let i = 0; i < 12; i++) appendChange(db, 'key', `key_${i}`, 'update', null);

    pruneChanges(db, 5);

    const rows = db.prepare('SELECT seq FROM change_log ORDER BY seq').all() as { seq: number }[];
    expect(rows.map((r) => r.seq)).toEqual([8, 9, 10, 11, 12]);
    expect(maxSeq(db)).toBe(12);
  });

  it('恰好等于 keep 一条不删（裁剪线是 `<= max - keep`，水位 - keep 那条必须留下）', () => {
    const db = setup();
    for (let i = 0; i < 6; i++) appendChange(db, 'key', 'key_probe', 'update', null);

    pruneChanges(db, 6);

    expect((db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n).toBe(6);
  });

  it('消费者的 `lastSeq` 永远低于裁剪线以下不会成立：可反复调用且单调收敛', () => {
    const db = setup();
    for (let i = 0; i < 3; i++) appendChange(db, 'key', 'key_probe', 'update', null);

    // 第一次：3 条 < 10，不动
    pruneChanges(db, 10);
    expect((db.prepare('SELECT COUNT(*) AS n FROM change_log').get() as { n: number }).n).toBe(3);
    // 再写 15 条 → 共 18 条，裁到 10
    for (let i = 0; i < 15; i++) appendChange(db, 'key', 'key_probe', 'update', null);
    pruneChanges(db, 10);
    const rows = db.prepare('SELECT seq FROM change_log ORDER BY seq').all() as { seq: number }[];
    expect(rows).toHaveLength(10);
    expect(rows[0]?.seq).toBe(9);
  });

  it('空表不炸', () => {
    const db = setup();
    expect(() => pruneChanges(db, 10)).not.toThrow();
    expect(maxSeq(db)).toBe(0);
  });
});
