// key 运行态镜像仓储单测（`src/db/repo/key-runtime.ts`）
//
// 判据不是"能写进去"，而是四条边界（ADR-0010）：
//   1. epoch ms → ISO8601 UTC 的转换只在这里发生，且 null 落成 SQL NULL（不是 0、不是空串）；
//   2. 重复写是幂等的 —— 冷启动后"全量重写"靠的就是这条；
//   3. 一行都没有时**不写**（不产生空事务、不白占写锁）；
//   4. 管理端读路径（`src/db/repo/keys.ts` 的 health 派生与 `?health=` 筛选）能立刻看到镜像值 ——
//      这条很关键：镜像的唯一目的就是让管理端说真话，写完读不出来等于没写。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';

import { openDatabase, type Db } from '../database.js';
import { createKey, listKeys } from './keys.js';
import { createUpstream } from './upstreams.js';
import { sha256Hex } from '../crypto.js';
import { upsertKeyRuntimeStates } from './key-runtime.js';
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
