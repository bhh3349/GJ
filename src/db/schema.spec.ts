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
