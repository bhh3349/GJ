// 适配层单测 - `key_runtime` 运行态镜像（`src/wiring/key-runtime-flusher.ts`）
//
// 依据：ADR-0010。这一层存在的理由不是"重启会丢状态"，而是**全仓从来没有一行写 `key_runtime`**——
// 管理端的 `?health=` 筛选与仪表盘健康灯恒为 healthy / 0，契约 §3 的四个字段在可观测层面
// 是假数据（不是"暂时没数据"）。所以本文件的判据尽量落在**管理端读路径**上：
// 真 SQLite → 真 `createKeyPool` → 真 flusher → `listKeys` 按 `health` 筛选，
// 而不是"表里能查到行"。
//
// 三个必须盯住的边界：
//   1. 启动第一个周期**全量写**，把上一进程遗留的陈旧行（冷却可能还在未来）纠正过来；
//   2. 无变化**不写**（成功一次会把 consecutiveFails 归零，全量写会变成按 QPS 的写放大）；
//   3. 落库失败**不推进记账**（乐观推进会让镜像永久停在这一版，而且表面看不出异常）。
//
// 明文探针在运行时拼装：源码里没有上游 key 的字面量，扫描器不会命中自己。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, it, vi } from 'vitest';

import { openDatabase, type Db } from '../db/database.js';
import { createKey, listKeys } from '../db/repo/keys.js';
import { createUpstream } from '../db/repo/upstreams.js';
import { MAX_COOLDOWN_MS } from '../gateway/cooldown.js';
import { createKeyPool } from '../gateway/key-pool.js';
import type { KeyPoolInternal } from '../gateway/key-pool.js';
import type { KeyConfig, PoolSnapshot } from '../gateway/types.js';
import { createKeyRuntimeFlusher } from './key-runtime-flusher.js';
import type { KeyRuntimeFlusher } from './key-runtime-flusher.js';

/* ------------------------------ 测试台 ------------------------------ */

const MASTER_KEY = Buffer.from('a7'.repeat(32), 'hex');

function probeSecret(tag: string): string {
  return ['sk', 'probe', tag, randomBytes(16).toString('hex')].join('-');
}

const dirs: string[] = [];
const dbs: Db[] = [];
const flushers: KeyRuntimeFlusher[] = [];

afterEach(() => {
  // 必须停掉定时器：漏一个 1s 的 interval，vitest 会在退出时挂住
  for (const f of flushers.splice(0)) f.close();
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
  pool: KeyPoolInternal;
  flusher: KeyRuntimeFlusher;
  upstreamId: string;
  /** 按权重降序，k1 在前；与 `poolSnapshot` 的顺序一致 */
  keyIds: [string, string];
  clock: number;
  errors: unknown[];
}

interface FlusherOverrides {
  flushIntervalMs?: number;
  /** 覆盖池的时钟（默认用「离现在最近的整秒 + 123ms」，好让管理端读路径的时间比较成立） */
  clock?: number;
}

/**
 * 池的时钟必须落在**真实当下附近**：`listKeys` 的 `deriveHealth` 用的是 `Date.now()`，
 * 不是为了这个测试注入的时钟。用 2023 年的固定时刻会让"冷却中"在管理端读路径上恒不成立，
 * 测出来的就是假结论。+123ms 是为了让 ISO 转换断言能抓到"把 ms 截成整秒"这类错误。
 */
function clockNearNow(): number {
  return Math.floor(Date.now() / 1000) * 1000 + 123;
}

function setup(over: FlusherOverrides = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-mirror-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  dbs.push(db);

  // 真上游 + 真 key 行：`listKeys` 的 LEFT JOIN 从 `upstream_keys` 出发，
  // 快照里的 keyId 必须真的存在，否则测的就不是管理端实际会看到的东西
  const upstreamId = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' }).id;
  const keyId1 = createKey(db, { upstreamId, key: probeSecret('k1'), category: 'balance', weight: 5, balance: 10_000 }, MASTER_KEY).id;
  const keyId2 = createKey(db, { upstreamId, key: probeSecret('k2'), category: 'balance', weight: 1, balance: 10_000 }, MASTER_KEY).id;

  const clock = over.clock ?? clockNearNow();
  const pool = createKeyPool({ now: () => clock });

  const snapshot: PoolSnapshot = {
    revision: 1,
    upstreams: [{ upstreamId, enabled: true, models: null }],
    keys: [keyConfig(keyId1, upstreamId), keyConfig(keyId2, upstreamId)],
  };
  pool.applySnapshot(snapshot);

  const errors: unknown[] = [];
  const flusher = createKeyRuntimeFlusher({
    db,
    pool,
    flushIntervalMs: over.flushIntervalMs ?? 1000,
    onError: (err) => errors.push(err),
  });
  flushers.push(flusher);

  return { db, pool, flusher, upstreamId, keyIds: [keyId1, keyId2], clock, errors };
}

function keyConfig(keyId: string, upstreamId: string, over: Partial<KeyConfig> = {}): KeyConfig {
  return {
    keyId,
    upstreamId,
    category: 'balance',
    status: 'enabled',
    weight: 1,
    models: null,
    balanceCents: 10_000,
    tokenPlanRemainingTokens: null,
    tokenPlanExpiresAt: null,
    ...over,
  };
}

interface RuntimeRow {
  key_id: string;
  consecutive_failures: number;
  cooldown_until: string | null;
  last_failure_reason: string | null;
  last_failure_at: string | null;
  updated_at: string;
}

function runtimeRows(db: Db): RuntimeRow[] {
  return db.prepare('SELECT * FROM key_runtime ORDER BY key_id').all() as RuntimeRow[];
}

function healthOf(h: Harness, health: 'healthy' | 'cooling' | 'disabled'): string[] {
  return listKeys(h.db, { health, includeDeleted: false, page: 1, pageSize: 50 }).items.map((k) => k.id).sort();
}

/** 直接塞一行陈旧运行态，模拟"上一进程留下的"（本表在这条测试之前从未被写过） */
function seedStaleRow(db: Db, keyId: string, cooldownUntilIso: string): void {
  db.prepare(
    `INSERT INTO key_runtime (key_id, consecutive_failures, cooldown_until, last_failure_reason, last_failure_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(keyId, 7, cooldownUntilIso, 'AUTH_INVALID', cooldownUntilIso, cooldownUntilIso);
}

/* ------------------------------ 用例 ------------------------------ */

describe('启动全量标脏', () => {
  it('第一个周期写全部池 key，并把上一进程遗留的陈旧行纠正过来', () => {
    const h = setup();
    // 上一进程：k1 连续失败 7 次、冷却停在未来（若不被纠正，管理端会一直读成 cooling）
    const staleCooldown = new Date(h.clock + MAX_COOLDOWN_MS).toISOString();
    seedStaleRow(h.db, h.keyIds[0], staleCooldown);

    assert.equal(h.flusher.flush(), 2, '没有记账过 = 全部脏，冷启动必须全量写');

    const rows = runtimeRows(h.db);
    assert.equal(rows.length, 2);
    const stale = rows.find((r) => r.key_id === h.keyIds[0]);
    assert.ok(stale);
    assert.equal(stale.consecutive_failures, 0, '陈旧计数必须被纠正，而不是与现状取更大值');
    assert.equal(stale.cooldown_until, null, 'null 落 SQL NULL，不落 0 或空串');
    assert.equal(stale.last_failure_reason, null);
    assert.equal(stale.last_failure_at, null);
    assert.equal(typeof stale.updated_at, 'string');

    // 管理端读路径：上一进程的"冷却中"消失，两把 key 都是 healthy
    assert.deepEqual(healthOf(h, 'healthy'), [...h.keyIds].sort());
    assert.deepEqual(healthOf(h, 'cooling'), []);
  });

  it('空池不产生空事务（0 行就是 0 次写）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wiring-mirror-'));
    dirs.push(dir);
    const db = openDatabase({ path: join(dir, 'gateway.db') });
    dbs.push(db);

    const pool = createKeyPool({ now: Date.now });
    const flusher = createKeyRuntimeFlusher({ db, pool });
    flushers.push(flusher);

    assert.equal(flusher.flush(), 0);
    assert.equal(runtimeRows(db).length, 0);
  });
});

describe('差集刷写', () => {
  it('值没变就不写：连续 flush 只有第一拍产生写入', () => {
    const h = setup();
    assert.equal(h.flusher.flush(), 2);
    assert.equal(h.flusher.written(), 2);

    assert.equal(h.flusher.flush(), 0, '成功一次会把 consecutiveFails 归零，全量写就是按 QPS 的写放大');
    assert.equal(h.flusher.flush(), 0);
    assert.equal(h.flusher.written(), 2);
  });

  it('只有变化的那把 key 被写（另一把不受牵连）', () => {
    const h = setup();
    h.flusher.flush();

    h.pool.reportFailure(h.keyIds[1], 'UPSTREAM_ERROR');
    assert.equal(h.flusher.flush(), 1);
    assert.equal(h.flusher.written(), 3);

    h.pool.reportSuccess(h.keyIds[1], { prompt: 10, completion: 0, total: 10, isEstimated: false }, 20);
    assert.equal(h.flusher.flush(), 1, '成功把计数与冷却都清了，这是一次真的状态变化');
    assert.equal(h.flusher.flush(), 0);
  });

  /**
   * P3 #4 的两条：孤儿行的产生与收掉。
   *
   * 上面那条用例钉的是「移出快照但父行还活着」**不能**被清掉（禁用/暂时不在快照里的 key，
   * 管理端照样读得到它的运行态，删了就是丢数据）。
   * 下面两条钉的是另一半：父行已经不活的行，既不能再被刷新（守卫），也不能一直留着（清理）。
   */
  it('池里还持着"父行已被物理删除"的 key：镜像不再整批失败，且该行被清掉（ADR-0016 登记的窗口）', () => {
    const h = setup();
    h.flusher.flush();

    // 管理端把 k2 整把删掉（父行消失），但网关池这一拍还持着它 —— 这正是 ADR-0016
    // 末尾给本层留的那条待评估项。原来 VALUES 形态在这里抛外键、整批回滚：
    // k1 的运行态也写不进去，表现为"健康灯不动"，日志里只有一行 onError。
    h.db.pragma('foreign_keys = OFF');
    h.db.prepare('DELETE FROM upstream_keys WHERE id = ?').run(h.keyIds[1]);
    h.db.pragma('foreign_keys = ON');
    h.pool.reportFailure(h.keyIds[1], 'NETWORK');
    h.pool.reportFailure(h.keyIds[0], 'AUTH_INVALID');

    assert.equal(h.flusher.flush(), 1, '只写活的那条；死的那条被守卫跳过，不连坐');
    assert.equal(h.errors.length, 0, '不该再有 onError —— 死 key 不是故障');

    const k1 = runtimeRows(h.db).find((r) => r.key_id === h.keyIds[0]);
    assert.ok(k1, 'k1 的运行态必须在（原形态下它被整批回滚带走了）');
    assert.equal(k1.consecutive_failures, 1);
    assert.equal(runtimeRows(h.db).find((r) => r.key_id === h.keyIds[1]), undefined, '父行已消失的镜像行由清理收掉');
    assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(), [], '清完不留外键违反');
    assert.equal(h.flusher.orphansDeleted(), 1);
  });

  it('软删 key 的镜像行也被收掉，而"只是移出快照"的不收（孤儿判据 = 父行不活）', () => {
    const h = setup();
    h.flusher.flush();
    assert.equal(runtimeRows(h.db).length, 2);

    // k1 被软删（管理端从此读不到它）；k2 只是被移出快照，父行仍活着且可读
    h.db.prepare("UPDATE upstream_keys SET enabled = 0, deleted_at = ? WHERE id = ?").run('2026-10-08T00:00:00.000Z', h.keyIds[0]);
    h.pool.applySnapshot({ revision: 2, upstreams: [{ upstreamId: h.upstreamId, enabled: true, models: null }], keys: [keyConfig(h.keyIds[1], h.upstreamId)] });

    h.flusher.flush();
    const left = runtimeRows(h.db).map((r) => r.key_id);
    assert.deepEqual(left, [h.keyIds[1]], '软删的那条收掉，仍可读的那条留着');
    assert.equal(h.flusher.orphansDeleted(), 1);
  });

  it('key 移出快照但父行还活着：表里的行保留（孤儿判据 = 父行不活，不是"池里没有了"）', () => {
    const h = setup();
    h.flusher.flush();
    h.pool.applySnapshot({ revision: 2, upstreams: [{ upstreamId: h.upstreamId, enabled: true, models: null }], keys: [] });

    assert.equal(h.flusher.flush(), 0);
    assert.equal(runtimeRows(h.db).length, 2, '禁用/暂时移出快照的 key 不是孤儿：管理端照样读得到，清掉就是丢数据');
  });

  it('状态没变就不重复写：冷却时刻是绝对时刻，不是每拍递减的倒计时', () => {
    const h = setup();
    h.pool.reportFailure(h.keyIds[0], 'NETWORK');
    h.flusher.flush();
    const afterFailure = h.flusher.written();

    h.flusher.flush();
    assert.equal(h.flusher.written(), afterFailure, 'cooldownUntil 在 view() 里是绝对的 epoch ms，重复读不会产生差异');
  });
});

describe('管理端读路径', () => {
  it('失败经镜像后：health=cooling 命中、cooldownUntil 是 ISO8601 UTC、healthy 不再含它', () => {
    const h = setup();
    h.flusher.flush();
    assert.deepEqual(healthOf(h, 'cooling'), []);

    h.pool.reportFailure(h.keyIds[0], 'AUTH_INVALID');
    assert.equal(h.flusher.flush(), 1);

    // 直接查库：ms → ISO 只在仓储里发生（契约 §0.2），用完整字符串相等证明没有被截到秒
    const row = runtimeRows(h.db).find((r) => r.key_id === h.keyIds[0]);
    assert.ok(row);
    assert.equal(row.consecutive_failures, 1);
    assert.equal(row.last_failure_reason, 'AUTH_INVALID');
    assert.equal(row.cooldown_until, new Date(h.clock + MAX_COOLDOWN_MS).toISOString());
    assert.equal(row.last_failure_at, new Date(h.clock).toISOString());

    // 管理端（契约 §3）：cooling 命中该 key，healthy 不再含它，dur 为未来时刻
    assert.deepEqual(healthOf(h, 'cooling'), [h.keyIds[0]]);
    assert.deepEqual(healthOf(h, 'healthy'), [h.keyIds[1]]);
    const dto = listKeys(h.db, { includeDeleted: false, page: 1, pageSize: 50 }).items.find((k) => k.id === h.keyIds[0]);
    assert.ok(dto);
    assert.equal(dto.health, 'cooling');
    assert.equal(dto.consecutiveFailures, 1);
    assert.ok((dto.cooldownUntil ?? '') > new Date(h.clock).toISOString());
  });

  it('累计失败数 failCount 不落库：表里只有连续失败数（重启归零是契约内行为）', () => {
    const h = setup();
    h.pool.reportFailure(h.keyIds[0], 'UPSTREAM_ERROR');
    h.flusher.flush();
    h.pool.reportSuccess(h.keyIds[0], { prompt: 1, completion: 0, total: 1, isEstimated: false }, 5);
    h.flusher.flush();

    const rt = h.pool.view().find((r) => r.keyId === h.keyIds[0]);
    assert.equal(rt?.failCount, 1, '进程内累计失败数仍然记得');

    const row = runtimeRows(h.db).find((r) => r.key_id === h.keyIds[0]);
    assert.ok(row);
    assert.equal(row.consecutive_failures, 0, '表里只存连续失败数；累计数只活在 /internal/snapshot');
    assert.equal(row.cooldown_until, null, '成功一次即退出冷却');
    assert.equal(row.last_failure_reason, 'UPSTREAM_ERROR', '最近一次失败原因保留（契约 §3 就是"最后一次失败"）');
    assert.deepEqual(healthOf(h, 'healthy'), [...h.keyIds].sort());
  });
});

describe('失败与退出', () => {
  it('落库真异常：丢这一拍 + 回调，且**不推进记账**（下一拍仍会写）', () => {
    const h = setup();
    h.flusher.flush();
    const before = h.flusher.written();

    h.pool.reportFailure(h.keyIds[0], 'NETWORK');
    // 真异常（表没了），不是忙等：把表改名，写入必失败
    h.db.exec('ALTER TABLE key_runtime RENAME TO key_runtime_hidden');
    assert.equal(h.flusher.flush(), 0);
    assert.equal(h.errors.length, 1);
    assert.equal(h.flusher.written(), before);

    // 表回来后必须还能写：乐观推进记账会让这一版状态永久丢失，且表面看不出异常
    h.db.exec('ALTER TABLE key_runtime_hidden RENAME TO key_runtime');
    assert.equal(h.flusher.flush(), 1);
    const row = runtimeRows(h.db).find((r) => r.key_id === h.keyIds[0]);
    assert.equal(row?.last_failure_reason, 'NETWORK');
  });

  // 下面两条是**定时器语义**的用例，用假定时器把时间轴交给测试推：
  // 原来的形态是 `setInterval(20)` + `await sleep(90)`，那是拿"机器在这 90ms 里
  // 有没有被别的东西占住"当判据 —— 负载一高就偶发红，而且红得没有信息量。
  // `toFake` 只点名 interval，**不碰 Date**：`clockNearNow()` 与读路径的 deriveHealth
  // 都靠真实当下，冻结时钟会让"冷却中"在管理端恒不成立（那就变成测假结论了）。
  it('定时器到点自动刷（不是只在退出时刷）', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = setup({ flushIntervalMs: 20 });
    h.pool.reportFailure(h.keyIds[0], 'UPSTREAM_ERROR');

    assert.equal(runtimeRows(h.db).length, 0, '没到点之前一行都不该有');

    vi.advanceTimersByTime(20);
    const row = runtimeRows(h.db).find((r) => r.key_id === h.keyIds[0]);
    assert.equal(row?.last_failure_reason, 'UPSTREAM_ERROR');
  });

  it('close() 停表 + 最后一次 flush（退出时不丢最后一拍）', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const h = setup({ flushIntervalMs: 5 });
    h.flusher.close();
    assert.equal(runtimeRows(h.db).length, 2, 'close 里带了最后一次 flush');

    h.pool.reportFailure(h.keyIds[0], 'NETWORK');
    // 推进 200 拍。停表必须是**结构性**的：原来那条 `sleep(40)` 只能证明
    // "这 40ms 里恰好没触发"，而 40ms 刚好是 flushIntervalMs 的 8 倍，纯属碰运气。
    vi.advanceTimersByTime(1000);
    const row = runtimeRows(h.db).find((r) => r.key_id === h.keyIds[0]);
    assert.equal(row?.last_failure_reason, null, '表已停，不该再有自动写入');
    assert.equal(h.flusher.flush(), 1, '但 flush 仍可显式调用');
  });
});
