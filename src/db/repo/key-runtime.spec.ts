// key 运行态镜像仓储单测（`src/db/repo/key-runtime.ts`）
//
// 判据不是"能写进去"，而是四条边界（ADR-0010）：
//   1. epoch ms → ISO8601 UTC 的转换只在这里发生，且 null 落成 SQL NULL（不是 0、不是空串）；
//   2. 重复写是幂等的 —— 冷启动后"全量重写"靠的就是这条；
//   3. 一行都没有时**不写**（不产生空事务、不白占写锁）；
//   4. 管理端读路径（`src/db/repo/keys.ts` 的 health 派生与 `?health=` 筛选）能立刻看到镜像值 ——
//      这条很关键：镜像的唯一目的就是让管理端说真话，写完读不出来等于没写。
//   5. 父行不活（被软删 / 行已消失）时**不写也不抛**，且同一批里其余活 key 照常落库 ——
//      这条是 P3 #4 补的：原来 VALUES 形态的一批里只要有一把死 key，整批运行态一起回滚。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';

import { openDatabase, type Db } from '../database.js';
import { createKey, listKeys } from './keys.js';
import { createUpstream } from './upstreams.js';
import { sha256Hex } from '../crypto.js';
import { deleteOrphanKeyRuntimeStates, upsertKeyRuntimeStates } from './key-runtime.js';
import type { KeyRuntimeStateRow } from './key-runtime.js';

/* ------------------------------ 测试台 ------------------------------ */

const MASTER_KEY = Buffer.from('4c'.repeat(32), 'hex');

/** 运行时拼装的假上游 key：形状像真的，但源码里没有这个字面量（扫描器不命中自己）。 */
function probeSecret(tag: string): string {
  return ['sk', 'probe', tag, sha256Hex(`key-runtime-${tag}`).slice(0, 32)].join('-');
}

const dirs: string[] = [];
const dbs: Db[] = [];

afterEach(() => {
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
      /* Windows 上偶尔仍被短时占用，临时目录不影响判据 */
    }
  }
});

interface Harness {
  db: Db;
  keyId: string;
}

function setup(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'key-runtime-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  dbs.push(db);
  const up = createUpstream(db, { name: 'up-a', baseUrl: 'https://a.example.com' }).id;
  const key = createKey(db, { upstreamId: up, key: probeSecret('alpha'), category: 'balance' }, MASTER_KEY);
  return { db, keyId: key.id };
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

function state(over: Partial<KeyRuntimeStateRow> & { keyId: string }): KeyRuntimeStateRow {
  return {
    consecutiveFails: 0,
    cooldownUntilMs: null,
    lastFailureReason: null,
    lastFailureAtMs: null,
    ...over,
  };
}

/* ------------------------------ 用例 ------------------------------ */
/* ------------------------- P3 #4：孤儿行（ADR-0010 已知缺口 1） ------------------------- */

/**
 * 造一把"父行已经不活"的 key 及其镜像残留。
 *
 * `key_runtime.key_id` 有外键且开库就 `foreign_keys = ON`，所以**正常路径下造不出**孤儿行 ——
 * 而表里真会出现这种行（软删 key 不碰本表，是 ADR-0010 点名的缺口）。
 * 这里临时关外键再删父行，模拟"历史上已经留下的残局"，而不是新造一条写路径。
 */
function makeOrphan(db: Db, opts: { mode: 'soft-deleted' | 'hard-deleted' }): string {
  const up = createUpstream(db, { name: `up-${opts.mode}`, baseUrl: `https://${opts.mode}.example.com` }).id;
  const keyId = createKey(db, { upstreamId: up, key: probeSecret(`o-${opts.mode}`), category: 'balance' }, MASTER_KEY).id;
  upsertKeyRuntimeStates(db, [state({ keyId, consecutiveFails: 4, lastFailureReason: 'NETWORK', lastFailureAtMs: 1_760_000_000_000 })]);
  if (opts.mode === 'soft-deleted') {
    db.prepare("UPDATE upstream_keys SET enabled = 0, deleted_at = '2026-10-08T00:00:00.000Z' WHERE id = ?").run(keyId);
  } else {
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM upstream_keys WHERE id = ?').run(keyId);
    db.pragma('foreign_keys = ON');
  }
  return keyId;
}

describe('父行不活时的写入守卫（P3 #4：不抛、不写、不连坐）', () => {
  it('软删 key 的行不再被刷新，返回值只算真写进去的行', () => {
    const h = setup();
    const dead = makeOrphan(h.db, { mode: 'soft-deleted' });

    // 同一把死 key 再写一次：守卫让 SELECT 不产行 → 0 changes，且不抛
    assert.equal(upsertKeyRuntimeStates(h.db, [state({ keyId: dead, consecutiveFails: 9, lastFailureReason: 'AUTH_INVALID', lastFailureAtMs: 1_760_000_001_000 })]), 0);
    const row = runtimeRows(h.db).find((r) => r.key_id === dead);
    assert.ok(row, '守卫不删行（清理另有入口），只是不再给它续命');
    assert.equal(row?.consecutive_failures, 4, '残留行停在最后一次有效写入，不被死值覆盖');
    assert.equal(row?.last_failure_reason, 'NETWORK');
  });

  it('一批里混一把已消失的 key：其余活 key 必须照常落库（原 VALUES 形态会整批回滚）', () => {
    const h = setup();
    const ghostKey = makeOrphan(h.db, { mode: 'hard-deleted' });
    // 现在这批 = 一把活 key + 一把父行已消失的 key。
    // VALUES 形态在这里抛 SQLITE_CONSTRAINT_FOREIGNKEY，事务把活 key 一起回滚；
    // 守卫形态只跳过死的那条。
    const n = upsertKeyRuntimeStates(
      h.db,
      [state({ keyId: h.keyId, consecutiveFails: 2, lastFailureReason: 'UPSTREAM_ERROR', lastFailureAtMs: 1_760_000_002_000 }), state({ keyId: ghostKey, consecutiveFails: 7 })],
      '2026-10-08T00:00:02.000Z',
    );
    assert.equal(n, 1, '只有活的那条计入返回值');

    const live = runtimeRows(h.db).find((r) => r.key_id === h.keyId);
    assert.ok(live, '活 key 的运行态必须在');
    assert.equal(live.consecutive_failures, 2);
    assert.equal(live.updated_at, '2026-10-08T00:00:02.000Z', '同批有死行不能把活行一起拖回滚');
  });

  it('硬删的父行 + 新 keyId（池里还持着已消失的 key）：不抛外键，0 写入', () => {
    const h = setup();
    const gone = makeOrphan(h.db, { mode: 'hard-deleted' });
    // 表里那一行被 pragma OFF 的删除留下了；再来一次"新建"（同 keyId 的 INSERT 走 update 分支）
    assert.doesNotThrow(() => upsertKeyRuntimeStates(h.db, [state({ keyId: gone, consecutiveFails: 3 })], 'X'));
    // 一个从没存在过的 keyId：守卫同样跳过，不产生指向空的外键违反
    assert.doesNotThrow(() => upsertKeyRuntimeStates(h.db, [state({ keyId: 'key_never_existed', consecutiveFails: 3 })], 'X'));
    assert.equal(runtimeRows(h.db).filter((r) => r.key_id === 'key_never_existed').length, 0, '绝不新建指向缺失父行的行');
  });
});

describe('孤儿行清理（ADR-0010 已知缺口 1）', () => {
  it('两类孤儿都收掉：父行已消失的 + 父行被软删的；活 key 一行不动；重复跑 0 行', () => {
    const h = setup();
    const soft = makeOrphan(h.db, { mode: 'soft-deleted' });
    const hard = makeOrphan(h.db, { mode: 'hard-deleted' });
    // 再补一把"禁用但父行还活着"的 key：它不是孤儿，管理端照样读得到
    // 本层那张 key 也要有一行镜像，否则下面"活行不动"的断言会数错
    upsertKeyRuntimeStates(h.db, [state({ keyId: h.keyId, consecutiveFails: 1, lastFailureReason: 'NETWORK', lastFailureAtMs: 1_760_000_004_000 })]);
    const up = createUpstream(h.db, { name: 'up-disabled', baseUrl: 'https://disabled.example.com' }).id;
    const disabled = createKey(h.db, { upstreamId: up, key: probeSecret('disabled'), category: 'balance' }, MASTER_KEY).id;
    upsertKeyRuntimeStates(h.db, [state({ keyId: disabled, consecutiveFails: 1, lastFailureReason: 'NETWORK', lastFailureAtMs: 1_760_000_003_000 })]);
    h.db.prepare('UPDATE upstream_keys SET enabled = 0 WHERE id = ?').run(disabled);

    assert.equal(deleteOrphanKeyRuntimeStates(h.db), 2, '只收孤儿：软删 + 硬删各一');
    const left = runtimeRows(h.db).map((r) => r.key_id).sort();
    assert.deepEqual(left, [h.keyId, disabled].sort(), '活 key（含被禁用的）的运行态必须在 —— 孤儿判据是"没人再能读到"，不是"池里没有了"');
    assert.equal(deleteOrphanKeyRuntimeStates(h.db), 0, '幂等：第二次跑删 0 行');
    assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(), [], '清完后外键检查必须为空');
  });

  it('清完之后管理端读路径不受影响（活 key 的 health 仍来自镜像）', () => {
    const h = setup();
    const soft = makeOrphan(h.db, { mode: 'soft-deleted' });
    upsertKeyRuntimeStates(h.db, [state({ keyId: h.keyId, consecutiveFails: 2, cooldownUntilMs: Date.now() + 60_000, lastFailureReason: 'RATE_LIMITED', lastFailureAtMs: Date.now() })]);
    deleteOrphanKeyRuntimeStates(h.db);
    const items = listKeys(h.db, { includeDeleted: false, page: 1, pageSize: 20 }).items;
    assert.equal(items.length, 1, '只剩活的那把');
    assert.equal(items[0]?.health, 'cooling');
    assert.equal(runtimeRows(h.db).find((r) => r.key_id === soft), undefined, '软删 key 的镜像行已被收掉，不再留不可达残留');
    assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(), []);
  });
});



describe('写入与类型口径', () => {
  it('epoch ms 落成 ISO8601 UTC；null 落成 SQL NULL 而不是 0 / 空串', () => {
    const h = setup();
    // 契约 §0.2：时间一律 ISO8601 UTC。这里刻意用一个非整秒的 ms 值，抓"忘了转换"的实现
    const cooldownUntil = Date.parse('2026-10-06T12:05:00.500Z');
    const lastFailureAt = Date.parse('2026-10-06T12:00:00.000Z');

    const n = upsertKeyRuntimeStates(
      h.db,
      [
        state({ keyId: h.keyId, consecutiveFails: 3, cooldownUntilMs: cooldownUntil, lastFailureReason: 'AUTH_INVALID', lastFailureAtMs: lastFailureAt }),
      ],
      '2026-10-06T12:00:01.000Z',
    );

    assert.equal(n, 1);
    const [row] = runtimeRows(h.db);
    assert.ok(row);
    assert.equal(row.key_id, h.keyId);
    assert.equal(row.consecutive_failures, 3);
    assert.equal(row.cooldown_until, '2026-10-06T12:05:00.500Z', '落库的必须是 ISO 串，不是 epoch ms 数字');
    assert.equal(row.last_failure_reason, 'AUTH_INVALID');
    assert.equal(row.last_failure_at, '2026-10-06T12:00:00.000Z');
    assert.equal(row.updated_at, '2026-10-06T12:00:01.000Z');

    // 从未失败过的 key：三列都是 NULL。写成 0 / '' 的实现在这一条上会红
    upsertKeyRuntimeStates(h.db, [state({ keyId: h.keyId })], '2026-10-06T12:00:02.000Z');
    const [reset] = runtimeRows(h.db);
    assert.ok(reset);
    assert.equal(reset.cooldown_until, null);
    assert.equal(reset.last_failure_reason, null);
    assert.equal(reset.last_failure_at, null);
    assert.equal(reset.consecutive_failures, 0);
  });

  it('重复写同一行是幂等的（冷启动后"全量重写"依赖这条）', () => {
    const h = setup();
    const rows = [state({ keyId: h.keyId, consecutiveFails: 2, cooldownUntilMs: 1_760_000_000_000, lastFailureReason: 'NETWORK', lastFailureAtMs: 1_759_999_000_000 })];

    upsertKeyRuntimeStates(h.db, rows, 'A');
    upsertKeyRuntimeStates(h.db, rows, 'B');

    assert.equal(runtimeRows(h.db).length, 1, '同一 key 只有一行（主键 upsert，不是 append）');
    const [row] = runtimeRows(h.db);
    assert.equal(row?.updated_at, 'B', '后一次写覆盖前一次（镜像语义：以最新一次刷写为准）');
  });

  it('空数组不写（不产生空事务）', () => {
    const h = setup();
    assert.equal(upsertKeyRuntimeStates(h.db, []), 0);
    assert.equal(runtimeRows(h.db).length, 0);
  });
});

describe('管理端读路径立刻可见（镜像的唯一目的）', () => {
  it('写完 health 从 healthy 变 cooling，且 ?health= 筛选口径与之一致', () => {
    const h = setup();

    const before = listKeys(h.db, { includeDeleted: false, page: 1, pageSize: 20 });
    assert.equal(before.items[0]?.health, 'healthy', '没写过运行态时是 healthy（cooldown_until 为 NULL）');

    // 冷却到未来 → cooling
    upsertKeyRuntimeStates(h.db, [
      state({ keyId: h.keyId, consecutiveFails: 2, cooldownUntilMs: Date.now() + 60_000, lastFailureReason: 'RATE_LIMITED', lastFailureAtMs: Date.now() }),
    ]);

    const dto = listKeys(h.db, { includeDeleted: false, page: 1, pageSize: 20 }).items[0];
    assert.equal(dto?.health, 'cooling');
    assert.equal(dto?.consecutiveFailures, 2);
    assert.equal(dto?.lastFailureReason, 'RATE_LIMITED');
    assert.ok(typeof dto?.cooldownUntil === 'string' && Date.parse(dto.cooldownUntil) > Date.now());

    assert.equal(listKeys(h.db, { includeDeleted: false, page: 1, pageSize: 20, health: 'cooling' }).total, 1);
    assert.equal(listKeys(h.db, { includeDeleted: false, page: 1, pageSize: 20, health: 'healthy' }).total, 0);

    // 冷却已过期 → 又回 healthy（镜像写的是"截止时刻"，不是"是否在冷却"的布尔，过期自动失效）
    upsertKeyRuntimeStates(h.db, [
      state({ keyId: h.keyId, consecutiveFails: 2, cooldownUntilMs: Date.now() - 1_000, lastFailureReason: 'RATE_LIMITED', lastFailureAtMs: Date.now() - 120_000 }),
    ]);
    assert.equal(listKeys(h.db, { includeDeleted: false, page: 1, pageSize: 20 }).items[0]?.health, 'healthy');
  });

  it('enabled=false 仍然是 disabled，运行态不越权覆盖管理端开关（契约 §3 优先级）', () => {
    const h = setup();
    upsertKeyRuntimeStates(h.db, [
      state({ keyId: h.keyId, consecutiveFails: 1, cooldownUntilMs: Date.now() + 60_000, lastFailureReason: 'UPSTREAM_ERROR', lastFailureAtMs: Date.now() }),
    ]);
    h.db.prepare('UPDATE upstream_keys SET enabled = 0 WHERE id = ?').run(h.keyId);

    assert.equal(listKeys(h.db, { includeDeleted: false, page: 1, pageSize: 20 }).items[0]?.health, 'disabled');
  });
});
