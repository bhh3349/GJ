// §15.9 离线会话导入的离线用例（零网络）。
//
// 这里钉的是"会话怎么落库"这件事本身：掩码 / 摘要由真值算出、密文可解回、
// 同一账号重复导入只覆写（不长第二行）、不能掩码的标识与排除名单必须拒绝。
// 上游是否接受这枚会话**不在这里回答** —— 导入刻意不发任何请求。

import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/database.js';
import { createUpstream } from '../db/repo/upstreams.js';
import { readSupplierCredential } from '../db/repo/supplier-accounts.js';
import { importSupplierSession } from './session-import.js';

const MASTER_KEY = Buffer.from('3c'.repeat(32), 'hex');
const TR_ID = '19200000009';
const TR_SESSION = 'sess-offline-import-77';

function makeDb(over: { supplier?: string | null } = {}): { db: Db; upstreamId: string } {
  const db = openDatabase({ path: ':memory:', noWal: true });
  const up = createUpstream(db, {
    name: 'tr',
    baseUrl: 'https://tokenrhythm.example',
    supplier: over.supplier === undefined ? 'tokenrhythm' : over.supplier,
  });
  return { db, upstreamId: up.id };
}

function accountRow(db: Db, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM supplier_accounts WHERE id = ?').get(id) as Record<string, unknown>;
}

describe('importSupplierSession（§15.9 离线导入）', () => {
  it('新建：标识落掩码 / 摘要，会话只以密文落库，且能解回原值', () => {
    const { db, upstreamId } = makeDb();
    const res = importSupplierSession(db, MASTER_KEY, {
      upstreamId,
      identifier: TR_ID,
      session: TR_SESSION,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.created).toBe(true);
    expect(res.identifier).toBe('192****0009');
    expect(res.accountId).toMatch(/^acc_/);

    const row = accountRow(db, res.accountId);
    expect(row['supplier']).toBe('tokenrhythm');
    expect(row['identifier']).toBe('192****0009');
    expect(row['encrypted_password']).toBeNull();
    expect(row['encrypted_session']).not.toBeNull();
    // 明文会话不落任何列。
    expect(JSON.stringify(row)).not.toContain(TR_SESSION);

    const cred = readSupplierCredential(db, res.accountId, MASTER_KEY);
    expect(cred?.session).toBe(TR_SESSION);
    expect(cred?.password).toBeNull();
    // 会话型账号推不回真值（真值只随密码密文保存）。
    expect(cred?.identifier).toBe('');
  });

  it('同一账号重复导入 = 覆写既有行，不长第二行', () => {
    const { db, upstreamId } = makeDb();
    const first = importSupplierSession(db, MASTER_KEY, {
      upstreamId,
      identifier: TR_ID,
      session: 'sess-old',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // 同一号码的另一种写法（+86 前缀）归一化后必须命中同一行。
    const second = importSupplierSession(db, MASTER_KEY, {
      upstreamId,
      identifier: `+86 ${TR_ID}`,
      session: 'sess-new',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.accountId).toBe(first.accountId);

    const count = db.prepare('SELECT COUNT(*) AS n FROM supplier_accounts').get() as { n: number };
    expect(count.n).toBe(1);
    expect(readSupplierCredential(db, first.accountId, MASTER_KEY)?.session).toBe('sess-new');
  });

  it('掩码收不出的标识 → 拒绝（绝不落原文）', () => {
    const { db, upstreamId } = makeDb();
    for (const identifier of ['abc', '123', 'not-an-email']) {
      const res = importSupplierSession(db, MASTER_KEY, { upstreamId, identifier, session: 'sess-x' });
      expect(res.ok).toBe(false);
      if (res.ok) continue;
      expect(res.reason).toBe('identifier_invalid');
      expect(res.message).not.toContain('sess-x');
    }
    const count = db.prepare('SELECT COUNT(*) AS n FROM supplier_accounts').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('排除名单命中 → 拒绝，不写行', () => {
    const { db, upstreamId } = makeDb();
    const res = importSupplierSession(db, MASTER_KEY, {
      upstreamId,
      identifier: TR_ID,
      session: 'sess-x',
      excluded: new Set([TR_ID]),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('excluded');
    const count = db.prepare('SELECT COUNT(*) AS n FROM supplier_accounts').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('上游不存在 / 不是供应商账号型 → 明确拒绝', () => {
    const { db, upstreamId } = makeDb({ supplier: null });
    const notSupplier = importSupplierSession(db, MASTER_KEY, {
      upstreamId,
      identifier: TR_ID,
      session: 'sess-x',
    });
    expect(notSupplier.ok).toBe(false);
    if (notSupplier.ok) return;
    expect(notSupplier.reason).toBe('not_supplier_upstream');

    const missing = importSupplierSession(db, MASTER_KEY, {
      upstreamId: 'up_missing',
      identifier: TR_ID,
      session: 'sess-x',
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe('upstream_not_found');
  });

  it('会话值为空 → 拒绝（不建"有行没凭据"的死行）', () => {
    const { db, upstreamId } = makeDb();
    const res = importSupplierSession(db, MASTER_KEY, { upstreamId, identifier: TR_ID, session: '   ' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('session_empty');
  });
});
