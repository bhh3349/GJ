// gateway_keys 的 v1 → v2 搬迁（ADR-0008：网关 key 吊销是硬删，删 deleted_at 列）。
//
// 这个文件测的是**老库升上来之后还对不对**，而不是"新库建得对不对"：
// 删列是一条只跑一次的搬迁，写错了不会当场报错 —— 它要么把历史行整批复活成有效凭据，
// 要么在某些库上静默不执行（于是代码里所有 `deleted_at` 引用在下一次查询才炸）。
// 所以两条都钉死：列确实没了、且 deleted_at 非空的行确实被删掉而不是被复活。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256Hex } from './crypto.js';
import { openDatabase, type Db } from './database.js';
import { SCHEMA_VERSION, migrate } from './schema.js';
import { deleteGatewayKey, findGroupByGatewayKeyHash, issueGatewayKey, listGatewayKeys } from './repo/groups.js';

const dirs: string[] = [];
const live: Db[] = [];
afterEach(() => {
  for (const db of live.splice(0)) {
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

function tempDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'schema-migrate-'));
  dirs.push(d);
  return join(d, 'gateway.db');
}

function open(path: string): Db {
  const db = openDatabase({ path });
  live.push(db);
  return db;
}

function columnsOf(db: Db, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map((r) => r.name);
}

/** v1 形态的库：gateway_keys **带** deleted_at，且已经有一行"已软删"的历史行。 */
function seedV1Database(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      rpm INTEGER, tpm INTEGER, daily_quota INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE gateway_keys (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES groups(id),
      key_hash TEXT NOT NULL UNIQUE,
      masked_key TEXT NOT NULL,
      label TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const at = '2026-10-01T00:00:00.000Z';
  legacy
    .prepare('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('grp_v1', '老组', at, at);
  // 一行健康的 + 一行"已软删"的。后者在 v2 里必须消失：它是一把已吊销的凭据。
  legacy
    .prepare(
      `INSERT INTO gateway_keys (id, group_id, key_hash, masked_key, label, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
    )
    .run('gwk_live', 'grp_v1', sha256Hex('legacy-live-secret'), '****live', at, at);
  legacy
    .prepare(
      `INSERT INTO gateway_keys (id, group_id, key_hash, masked_key, label, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run('gwk_revoked', 'grp_v1', sha256Hex('legacy-revoked-secret'), '****revk', at, at, at);
  legacy.pragma('user_version = 1');
  legacy.close();
}

describe('gateway_keys v1 → v2 搬迁', () => {
  it('新库本就没有 deleted_at 列，且版本号已推进', () => {
    const db = open(tempDbPath());
    expect(columnsOf(db, 'gateway_keys')).not.toContain('deleted_at');
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('老库开库即删列，已软删的行被删除（不是被复活）', () => {
    const path = tempDbPath();
    seedV1Database(path);

    const db = open(path);
    expect(columnsOf(db, 'gateway_keys')).not.toContain('deleted_at');
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    const rows = db.prepare('SELECT id FROM gateway_keys ORDER BY id').all() as { id: string }[];
    expect(rows.map((r) => r.id)).toEqual(['gwk_live']);

    // 被删的那行不能靠摘要查回来 —— 这条才是"吊销"真正的判据
    expect(findGroupByGatewayKeyHash(db, sha256Hex('legacy-revoked-secret'))).toBeNull();
    expect(findGroupByGatewayKeyHash(db, sha256Hex('legacy-live-secret'))?.id).toBe('grp_v1');
  });

  it('迁移是幂等的：连跑三次结果一致', () => {
    const path = tempDbPath();
    seedV1Database(path);
    const db = open(path);
    migrate(db);
    migrate(db);
    expect(columnsOf(db, 'gateway_keys')).not.toContain('deleted_at');
    expect((db.prepare('SELECT COUNT(*) AS n FROM gateway_keys').get() as { n: number }).n).toBe(1);
  });
});

describe('网关 key 吊销即时生效（硬删）', () => {
  it('删掉的 key 摘要查不到组，列表也不再包含它', () => {
    const db = open(tempDbPath());
    const at = '2026-10-06T00:00:00.000Z';
    db.prepare('INSERT INTO groups (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      'grp_a',
      'A',
      at,
      at,
    );
    const issued = issueGatewayKey(db, 'grp_a');
    expect(listGatewayKeys(db, 'grp_a', { page: 1, pageSize: 20 }).total).toBe(1);

    deleteGatewayKey(db, 'grp_a', issued.id);

    expect(listGatewayKeys(db, 'grp_a', { page: 1, pageSize: 20 }).total).toBe(0);
    expect(findGroupByGatewayKeyHash(db, sha256Hex(issued.gatewayKey))).toBeNull();
  });
});

// v1.4.x 的三列（契约 §15.7）：`upstreams.supplier`、`upstream_keys.unlimited`、`upstream_keys.model_limits`。
// 这一组测的不是"新库建得对不对"，而是**老库升不升得上来** —— 恰恰是这三列最容易漏的一环：
// 它们加在**既有表**上，而 `CREATE TABLE IF NOT EXISTS` 撞上已存在的表是空操作，
// 所以"只改 DDL 文本"会在新库上看不出任何异常，却让每一台老库永远缺列（下一次 SELECT 才炸）。
// 三条判据分别钉：新库自带、老库真被 ALTER 到、以及重复跑不抛 duplicate column name。

/** v1.4.2 之前形态的库：`upstreams` / `upstream_keys` 都没有那三列，且各已有一行数据。 */
function seedPreV14Database(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE upstreams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, balance_query TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE upstream_keys (
      id TEXT PRIMARY KEY, upstream_id TEXT NOT NULL REFERENCES upstreams(id),
      label TEXT NOT NULL, masked_key TEXT NOT NULL, secret BLOB NOT NULL,
      category TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, weight INTEGER NOT NULL DEFAULT 1,
      balance_cents INTEGER, balance_currency TEXT, balance_updated_at TEXT, balance_source TEXT,
      token_plan_remaining INTEGER, token_plan_expires_at TEXT,
      today_tokens INTEGER NOT NULL DEFAULT 0, today_day TEXT,
      revision INTEGER NOT NULL DEFAULT 1, deleted_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  const at = '2026-10-01T00:00:00.000Z';
  legacy
    .prepare('INSERT INTO upstreams (id, name, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('up_old', '老上游', 'https://legacy.example', at, at);
  // 一行**有余额**的普通 key。加列后它必须仍是 `unlimited = 0` 且余额分文不动 ——
  // "老行填默认 0"不是默认值好看，而是这行语义上确实不是无限额度。
  legacy
    .prepare(
      `INSERT INTO upstream_keys (id, upstream_id, label, masked_key, secret, category, balance_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'balance', ?, ?, ?)`,
    )
    .run('key_old', 'up_old', '老 key', '****old1', Buffer.from([0, 1, 2, 3]), 12345, at, at);
  legacy.close();
}

describe('v1.4.x 加列（supplier / unlimited / model_limits）', () => {
  it('新库直接带三列，版本号不动', () => {
    const db = open(tempDbPath());
    expect(columnsOf(db, 'upstreams')).toContain('supplier');
    expect(columnsOf(db, 'upstream_keys')).toEqual(
      expect.arrayContaining(['unlimited', 'model_limits']),
    );
    // 纯加列：没有数据搬迁、没有重写表，用户版本号仍停在 2（§15.7 与 v1.1.1 同一条判断）。
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('老库必须真发 ALTER，且老行语义与加列前逐字一致', () => {
    const path = tempDbPath();
    seedPreV14Database(path);

    // 前置断言：老库**确实**没有这两列。少了它，下面即使 migrate 什么都没做也可能"看起来通过"
    // （查不存在的列会抛，但用 SELECT * 之类的写法就容易糊弄过去）。
    const legacy = new Database(path);
    expect(columnsOf(legacy, 'upstream_keys')).not.toContain('unlimited');
    expect(columnsOf(legacy, 'upstream_keys')).not.toContain('model_limits');
    expect(columnsOf(legacy, 'upstreams')).not.toContain('supplier');
    legacy.close();

    const db = open(path);
    expect(columnsOf(db, 'upstreams')).toContain('supplier');
    expect(columnsOf(db, 'upstream_keys')).toEqual(
      expect.arrayContaining(['unlimited', 'model_limits']),
    );

    const row = db
      .prepare('SELECT unlimited, model_limits, balance_cents FROM upstream_keys WHERE id = ?')
      .get('key_old') as {
      unlimited: number;
      model_limits: string | null;
      balance_cents: number | null;
    };
    expect(row.unlimited).toBe(0); // 老行 = 非无限额度
    expect(row.model_limits).toBeNull(); // 不是 ''：库里两个值、语义一个值早晚被写错查询
    expect(row.balance_cents).toBe(12345); // 加列不动既有余额

    const up = db.prepare('SELECT supplier FROM upstreams WHERE id = ?').get('up_old') as {
      supplier: string | null;
    };
    expect(up.supplier).toBeNull(); // 老上游不走供应商能力位，与加列前逐字一致
  });

  it('加列是幂等的：重复 migrate 不抛 duplicate column name', () => {
    const path = tempDbPath();
    seedPreV14Database(path);
    const db = open(path); // openDatabase 内已跑过一次 migrate
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    // 断言"补了一次"而不是"补了三次"：守卫若按 user_version 判，这里会多出重名列或直接抛。
    expect(columnsOf(db, 'upstream_keys').filter((c) => c === 'model_limits')).toHaveLength(1);
    expect(columnsOf(db, 'upstream_keys').filter((c) => c === 'unlimited')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 台账 pooled_key_id 的部分唯一索引（ADR-0021 决策 5 的 E 接缝）
// ---------------------------------------------------------------------------
//
// 网关的 KEYS_SQL 要 join 这张台账才知道"这把 key 属于谁"，一对一是那条 join 的前提。
// 这里钉两件事：索引的**部分**语义（纯掩码行允许重复），以及库里已经有 fan-out 时的
// fail-closed —— 那种库必须开不了门，且报出来的得是**具体的 pooled_key_id**，
// 而不是一句"服务起不来"背后翻 DDL 才找得到病根的 `SQLITE_CONSTRAINT`。

function seedSupplierAccountForLedger(db: Db, id: string): void {
  const at = '2026-10-08T00:00:00.000Z';
  db.prepare(
    `INSERT INTO supplier_accounts (id, upstream_id, supplier, identifier, identifier_hash,
       status, encrypted_password, revision, created_at, updated_at)
     VALUES (?, 'up_seed', 'tierflow', ?, ?, 'active', ?, 1, ?, ?)`,
  ).run(id, id, sha256Hex(id), Buffer.alloc(16), at, at);
}

function seedLedgerRow(db: Db, id: string, accountId: string, pooledKeyId: string | null): void {
  const at = '2026-10-08T00:00:00.000Z';
  db.prepare(
    `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, note, created_at, updated_at)
     VALUES (?, ?, 'sk-****0000', ?, NULL, ?, ?)`,
  ).run(id, accountId, pooledKeyId, at, at);
}

function indexNames(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe('台账 pooled_key_id 部分唯一索引', () => {
  it('入池行独占、纯掩码行可重复（部分索引，不是全局 UNIQUE）', () => {
    const db = open(tempDbPath());
    expect(indexNames(db)).toContain('uq_supplier_account_keys_pooled');

    seedSupplierAccountForLedger(db, 'sa_1');
    seedSupplierAccountForLedger(db, 'sa_2');
    seedLedgerRow(db, 'sak_1', 'sa_1', null);
    // 同一个掩码出现两次是**正常事件**（只有后 4 位，撞号天天有）—— 全局 UNIQUE 会把它变成约束报错
    expect(() => seedLedgerRow(db, 'sak_2', 'sa_2', null)).not.toThrow();

    seedLedgerRow(db, 'sak_3', 'sa_1', 'key_1');
    // 同一把入池 key 被两条台账行引用 = 它在网关池里会出现两遍 → 必须拦下
    expect(() => seedLedgerRow(db, 'sak_4', 'sa_2', 'key_1')).toThrow(/UNIQUE/);
  });

  it('库里已有 fan-out 行：开库 fail-closed，报出具体 pooled_key_id，不静默', () => {
    const db = open(tempDbPath());
    // 回到"索引还没落"的历史库态：删掉索引，再塞进重复的入池行
    db.exec('DROP INDEX uq_supplier_account_keys_pooled');
    seedSupplierAccountForLedger(db, 'sa_1');
    seedSupplierAccountForLedger(db, 'sa_2');
    seedLedgerRow(db, 'sak_1', 'sa_1', 'key_fanout');
    seedLedgerRow(db, 'sak_2', 'sa_2', 'key_fanout');

    let message = '';
    try {
      migrate(db);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('fan-out');
    expect(message).toContain('key_fanout'); // 点名到行，而不是一句 SQLITE_CONSTRAINT
    expect(indexNames(db)).not.toContain('uq_supplier_account_keys_pooled'); // 没建，也就没有半个状态

    // 人工判定后删掉多余那一行 → 同一个库能正常升上来
    db.prepare('DELETE FROM supplier_account_keys WHERE id = ?').run('sak_2');
    expect(() => migrate(db)).not.toThrow();
    expect(indexNames(db)).toContain('uq_supplier_account_keys_pooled');
  });
});

// ---------------------------------------------------------------------------
// v1.7.1：egress_proxies 的 last_test_at / last_test_ok 老库升版
// ---------------------------------------------------------------------------
//
// 与 v1.4.x 三列同一形状的缺环：这两列是后来才加进 CREATE TABLE 文本的，而早期批次
// 已随开库把这张表建进了运行中的库 —— CREATE TABLE IF NOT EXISTS 撞上已存在的表是
// 空操作，那些库的列永远进不来，GET /api/egress 的 SELECT 一跑就炸。
// 三条判据：新库自带、老库真被 ALTER 到、重复跑不抛 duplicate column name。

function seedPreEgressTestColsDatabase(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE egress_proxies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      url TEXT NOT NULL UNIQUE,
      secret BLOB,
      region TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      retired_reason TEXT,
      retired_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (status <> 'retired' OR retired_reason IS NOT NULL)
    );
  `);
  const at = '2026-10-08T00:00:00.000Z';
  legacy
    .prepare(
      `INSERT INTO egress_proxies (id, name, url, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    )
    .run('eg_old', '老出口', 'https://legacy.example:8443', at, at);
  legacy.close();
}

describe('v1.7.1 加列（egress_proxies last_test_at / last_test_ok）', () => {
  it('新库直接带两列', () => {
    const db = open(tempDbPath());
    expect(columnsOf(db, 'egress_proxies')).toEqual(
      expect.arrayContaining(['last_test_at', 'last_test_ok']),
    );
  });

  it('老库必须真发 ALTER，老行 NULL = 未测（不是 0 / false）', () => {
    const path = tempDbPath();
    seedPreEgressTestColsDatabase(path);

    // 前置断言：种子库确实没有这两列
    const legacy = new Database(path);
    expect(columnsOf(legacy, 'egress_proxies')).not.toContain('last_test_at');
    expect(columnsOf(legacy, 'egress_proxies')).not.toContain('last_test_ok');
    legacy.close();

    const db = open(path);
    expect(columnsOf(db, 'egress_proxies')).toEqual(
      expect.arrayContaining(['last_test_at', 'last_test_ok']),
    );
    const row = db
      .prepare('SELECT last_test_at, last_test_ok FROM egress_proxies WHERE id = ?')
      .get('eg_old') as { last_test_at: string | null; last_test_ok: number | null };
    expect(row.last_test_at).toBeNull();
    expect(row.last_test_ok).toBeNull();
  });

  it('加列幂等：重复 migrate 不抛 duplicate column name', () => {
    const path = tempDbPath();
    seedPreEgressTestColsDatabase(path);
    const db = open(path);
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    expect(columnsOf(db, 'egress_proxies').filter((c) => c === 'last_test_ok')).toHaveLength(1);
  });
});

/* ---------------- v1.11.0 能力探测两列（契约 §5，ADR-0024）---------------- */

/** v1.11.0 之前形态的 models 表：没有 capabilities_source / last_probed_at，且已有一行档案。 */
function seedPreV111ModelsDatabase(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE upstreams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, balance_query TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE models (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, display_name TEXT,
      upstream_id TEXT NOT NULL REFERENCES upstreams(id),
      type TEXT NOT NULL CHECK (type IN ('chat','embedding','image','audio','rerank')),
      capabilities TEXT NOT NULL DEFAULT '[]',
      context_length INTEGER, price_input_per_1k INTEGER, price_output_per_1k INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1, last_synced_at TEXT,
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (upstream_id, name)
    );
  `);
  const at = '2026-10-10T00:00:00.000Z';
  legacy
    .prepare('INSERT INTO upstreams (id, name, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('up_old_111', '老上游', 'https://legacy.example', at, at);
  // 一行 capabilities 非空的档案：加列绝不能动它（"没问过"由新列的 NULL 表达，不是把能力清空）
  legacy
    .prepare(
      `INSERT INTO models (id, name, upstream_id, type, capabilities, created_at, updated_at)
       VALUES (?, ?, ?, 'chat', ?, ?, ?)`,
    )
    .run('mdl_old_111', '老模型', 'up_old_111', '["stream"]', at, at);
  legacy.close();
}

describe('v1.11.0 加列（models capabilities_source / last_probed_at）', () => {
  it('新库直接带两列，SCHEMA_VERSION 不递增', () => {
    const db = open(tempDbPath());
    expect(columnsOf(db, 'models')).toEqual(
      expect.arrayContaining(['capabilities_source', 'last_probed_at']),
    );
    // 纯加列 ⇒ 版本号不动（迁移判据是"列在不在"，不是版本号 —— 与 v1.1.1 / v1.4.x / v1.7.1 同一条）
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('老库必须真发 ALTER，老行两列都是 NULL（= 从没问过），既有 capabilities 分文不动', () => {
    const path = tempDbPath();
    seedPreV111ModelsDatabase(path);

    // 前置断言：种子库确实没有这两列。少了它，"migrate 什么都没做"也可能看起来通过。
    const legacy = new Database(path);
    expect(columnsOf(legacy, 'models')).not.toContain('capabilities_source');
    expect(columnsOf(legacy, 'models')).not.toContain('last_probed_at');
    legacy.close();

    const db = open(path);
    expect(columnsOf(db, 'models')).toEqual(
      expect.arrayContaining(['capabilities_source', 'last_probed_at']),
    );
    const row = db
      .prepare('SELECT capabilities, capabilities_source, last_probed_at FROM models WHERE id = ?')
      .get('mdl_old_111') as {
      capabilities: string;
      capabilities_source: string | null;
      last_probed_at: string | null;
    };
    // 两列都必须是 NULL 而不是 '' / 0：三态里「还没问过」这一态就靠 NULL 表达
    expect(row.capabilities_source).toBeNull();
    expect(row.last_probed_at).toBeNull();
    expect(row.capabilities).toBe('["stream"]'); // 加列不动既有能力那格
  });

  it('加列幂等：重复 migrate 不抛 duplicate column name', () => {
    const path = tempDbPath();
    seedPreV111ModelsDatabase(path);
    const db = open(path);
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    expect(columnsOf(db, 'models').filter((c) => c === 'capabilities_source')).toHaveLength(1);
    expect(columnsOf(db, 'models').filter((c) => c === 'last_probed_at')).toHaveLength(1);
  });
});

/* ---------------- v1.15.0 admin_users 两列（契约 §19.9 / ADR-0034）---------------- */

/**
 * v1.15.0 之前形态的 `admin_users`：没有 role / group_id / display_name，
 * 且**已经有一个管理员账号 + 一条会话**（老库的典型状态）。
 *
 * 为什么要连 sessions 一起造：ADR-0034 的判据表里有一条是
 * "老库升级后唯一账号 `role='admin'`"（升级不锁死现有管理员）。
 * 只建表不建行的话，那条判据测的是空表 —— 而空表上任何默认值都"看起来对"。
 */
function seedPreV115AdminUsersDatabase(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      rpm INTEGER, tpm INTEGER, daily_quota INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE admin_users (
      username      TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id           TEXT PRIMARY KEY,
      token_hash   TEXT NOT NULL UNIQUE,
      username     TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      expires_at   TEXT NOT NULL
    );
  `);
  const at = '2026-10-01T00:00:00.000Z';
  legacy
    .prepare(
      'INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
    )
    .run('legacy-admin', 'legacy-hash-not-real', at, at);
  legacy
    .prepare(
      'INSERT INTO sessions (id, token_hash, username, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('sess_old', 'deadbeef', 'legacy-admin', at, at, '2027-10-01T00:00:00.000Z');
  legacy
    .prepare("INSERT INTO groups (id, name, created_at, updated_at) VALUES ('grp_old', '老组', ?, ?)")
    .run(at, at);
  legacy.close();
}

describe('v1.15.0 加列（admin_users role / group_id / display_name，契约 §19.9）', () => {
  it('新库直接带三列，SCHEMA_VERSION 不递增', () => {
    const db = open(tempDbPath());
    expect(columnsOf(db, 'admin_users')).toEqual(
      expect.arrayContaining(['role', 'group_id', 'display_name']),
    );
    // 纯加列 ⇒ 版本号不动。判据是"列在不在"，不是版本号
    // （同 v1.1.1 / v1.4.x / v1.7.1 / v1.11.0 那几批的一条纪律）
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('老库升级：唯一管理员补 role=admin（升级不锁死自己），会话不受影响', () => {
    const path = tempDbPath();
    seedPreV115AdminUsersDatabase(path);

    // 前置断言：种子库确实没有这三列。少了它，"migrate 什么都没做"也可能看起来通过。
    const legacy = new Database(path);
    expect(columnsOf(legacy, 'admin_users')).not.toContain('role');
    expect(columnsOf(legacy, 'admin_users')).not.toContain('group_id');
    legacy.close();

    const db = open(path);
    const row = db
      .prepare('SELECT username, role, group_id FROM admin_users WHERE username = ?')
      .get('legacy-admin') as { username: string; role: string; group_id: string | null };
    // **本批最要紧的一条**：老行补 `admin` 而不是 `user`。
    // 填 `user` 会让升级后的现有管理员落在 `/api/**` 上全部 403，而那时候
    // 库里可能已经没有第二个 admin 了 —— "升级即锁死自己"，只能改库脱身。
    expect(row.role).toBe('admin');
    // 未分配组：NULL = 未分配，不是 '' 也不是某把组的 id
    expect(row.group_id).toBeNull();
    // 会话一行不动（§19.9：`sessions` 零变更）
    const sess = db.prepare('SELECT username FROM sessions WHERE id = ?').get('sess_old') as {
      username: string;
    };
    expect(sess.username).toBe('legacy-admin');
  });

  it('加列幂等：重复 migrate 不抛 duplicate column name', () => {
    const path = tempDbPath();
    seedPreV115AdminUsersDatabase(path);
    const db = open(path);
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    expect(columnsOf(db, 'admin_users').filter((c) => c === 'role')).toHaveLength(1);
    expect(columnsOf(db, 'admin_users').filter((c) => c === 'group_id')).toHaveLength(1);
    expect(columnsOf(db, 'admin_users').filter((c) => c === 'display_name')).toHaveLength(1);
  });
});

/* ------------- v1.17.2 / ADR-0042：gateway_error_events 三腿四列 ------------- */

/** v1.17.2 之前形态的 gateway_error_events：四列都还没有，且已有一行历史事件。 */
function seedPreV1172ErrorEventsDatabase(path: string): void {
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE gateway_error_events (
      id TEXT PRIMARY KEY, ts TEXT NOT NULL, request_id TEXT,
      severity TEXT NOT NULL CHECK (severity IN ('warn','error')),
      category TEXT NOT NULL, status INTEGER NOT NULL, gateway_code TEXT,
      failure_reason TEXT, endpoint TEXT NOT NULL, model TEXT,
      upstream_id TEXT, key_id TEXT, key_masked TEXT,
      stream INTEGER NOT NULL DEFAULT 0, upstream_status INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0, candidates INTEGER, latency_ms INTEGER,
      message TEXT
    );
  `);
  legacy
    .prepare(
      `INSERT INTO gateway_error_events (id, ts, severity, category, status, endpoint, stream, attempts)
       VALUES ('err_old', '2026-10-19T01:39:00.000Z', 'error', 'NO_AVAILABLE_KEY', 429, '/v1/chat/completions', 0, 0)`,
    )
    .run();
  legacy.close();
}

describe('v1.17.2 加列（gateway_error_events 三腿四列，ADR-0042）', () => {
  it('新库直接带四列，SCHEMA_VERSION 不递增', () => {
    const db = open(tempDbPath());
    expect(columnsOf(db, 'gateway_error_events')).toEqual(
      expect.arrayContaining(['client_key_masked', 'source_ip', 'invalid_key_fingerprint', 'attempt_trail']),
    );
    // 纯加列 ⇒ 版本号不动（判据是"列在不在"，同 v1.4.x / v1.7.1 / v1.11.0 / v1.15.0 那几批）
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('老库必须真发 ALTER，老行四列 NULL = "该事件没带这腿"（不是空串、不是被回填）', () => {
    const path = tempDbPath();
    seedPreV1172ErrorEventsDatabase(path);

    // 前置断言：种子库确实没有这四列。少了它，"migrate 什么都没做"也可能看起来通过。
    const legacy = new Database(path);
    expect(columnsOf(legacy, 'gateway_error_events')).not.toContain('client_key_masked');
    expect(columnsOf(legacy, 'gateway_error_events')).not.toContain('source_ip');
    expect(columnsOf(legacy, 'gateway_error_events')).not.toContain('invalid_key_fingerprint');
    expect(columnsOf(legacy, 'gateway_error_events')).not.toContain('attempt_trail');
    legacy.close();

    const db = open(path);
    expect(columnsOf(db, 'gateway_error_events')).toEqual(
      expect.arrayContaining(['client_key_masked', 'source_ip', 'invalid_key_fingerprint', 'attempt_trail']),
    );
    const row = db
      .prepare('SELECT client_key_masked, source_ip, invalid_key_fingerprint, attempt_trail FROM gateway_error_events WHERE id = ?')
      .get('err_old') as Record<'client_key_masked' | 'source_ip' | 'invalid_key_fingerprint' | 'attempt_trail', string | null>;
    // 部署后不存在存量行被回填的中间态：新腿只随**新事件**逐条产生
    expect(row.client_key_masked).toBeNull();
    expect(row.source_ip).toBeNull();
    expect(row.invalid_key_fingerprint).toBeNull();
    expect(row.attempt_trail).toBeNull();
  });

  it('加列幂等：重复 migrate 不抛 duplicate column name', () => {
    const path = tempDbPath();
    seedPreV1172ErrorEventsDatabase(path);
    const db = open(path);
    expect(() => {
      migrate(db);
      migrate(db);
    }).not.toThrow();
    for (const column of ['client_key_masked', 'source_ip', 'invalid_key_fingerprint', 'attempt_trail']) {
      expect(columnsOf(db, 'gateway_error_events').filter((c) => c === column)).toHaveLength(1);
    }
  });
});
