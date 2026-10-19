// cookie-only 批量导入的离线用例（fetchImpl 注入，零真实网络）。
//
// 钉三件事：文件每行只放会话也能导入；身份用上游 uid 判重（同一账号重复导入不长第二行）；
// 失败行只报行号/原因，会话值不出现在任何返回结构里。

import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../db/crypto.js';
import { openDatabase, type Db } from '../db/database.js';
import { createUpstream } from '../db/repo/upstreams.js';
import { readSupplierCredential, updateSupplierAccount } from '../db/repo/supplier-accounts.js';
import { importSupplierSession } from './session-import.js';
import {
  importSupplierSessionCookies,
  parseCookieOnlyText,
} from './session-import-cookie.js';

const MASTER_KEY = Buffer.from('3c'.repeat(32), 'hex');

interface Call {
  url: string;
  method: string;
  cookie: string | null;
}

type IdentitySpec =
  | { status: 200; data: { id: string; name?: string; phoneMasked?: string; emailMasked?: string } }
  | { status: 401 | 403 | 500 };

function fakeUpstream(bySession: Record<string, IdentitySpec>): {
  impl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const cookie = headers['Cookie'] ?? headers['cookie'] ?? null;
    calls.push({ url: String(input), method: init?.method ?? 'GET', cookie });
    const session = cookie === null ? '' : cookie.replace(/^tr_session=/, '');
    const spec: IdentitySpec = bySession[session] ?? {
      status: 401 as const,
    };
    if (spec.status !== 200) {
      return new Response(
        JSON.stringify({ code: 'UNAUTHORIZED', message: '未认证或登录已过期' }),
        { status: spec.status, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ code: 0, message: 'ok', data: spec.data }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function makeDb(supplier = 'tokenrhythm'): { db: Db; upstreamId: string } {
  const db = openDatabase({ path: ':memory:', noWal: true });
  const up = createUpstream(db, {
    name: 'tr',
    baseUrl: 'https://tokenrhythm.example',
    supplier,
  });
  return { db, upstreamId: up.id };
}

describe('parseCookieOnlyText（每行一枚会话）', () => {
  it('跳过空行/注释/表头，容忍整段 Cookie，重复会话只留第一行', () => {
    const parsed = parseCookieOnlyText(
      [
        'cookie',
        '# 注释',
        'tr_session=sess-a; Path=/',
        '',
        'sess-b',
        'Cookie: tr_session=sess-c',
        'sess-b',
      ].join('\n'),
    );
    expect(parsed.rows.map((row) => row.session)).toEqual(['sess-a', 'sess-b', 'sess-c']);
    expect(parsed.problems).toEqual([
      { line: 7, message: '这一行与前面某一行是同一枚会话，已跳过（保留第一行）' },
    ]);
  });

  it('解析阶段的失败信息不回显会话值（行内会话本身只在内存里）', () => {
    const parsed = parseCookieOnlyText('sess-secret-a\nsess-secret-a');
    // rows 是内部结构，本来就带着会话值（调用方要用它打上游）；对外输出只取 problems，
    // 因此泄漏判据落在 problems 上，而不是整个解析对象。
    expect(JSON.stringify(parsed.problems)).not.toContain('sess-secret');
  });
});

describe('importSupplierSessionCookies（cookie-only 批量导入）', () => {
  it('两枚会话 → 两行账号；掩码来自上游，摘要按 uid 落', async () => {
    const { db, upstreamId } = makeDb();
    const up = fakeUpstream({
      'sess-a': { status: 200, data: { id: 'u-1', name: 'n1', phoneMasked: '192****5609' } },
      'sess-b': { status: 200, data: { id: 'u-2', name: 'n2', phoneMasked: '138****0002' } },
    });

    const result = await importSupplierSessionCookies(db, MASTER_KEY, {
      upstreamId,
      text: 'sess-a\nsess-b\n',
      fetchImpl: up.impl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.summary).toEqual({
      total: 2,
      created: 2,
      updated: 0,
      failed: 0,
      problems: 0,
    });
    expect(result.report.outcomes.map((item) => item.identifier)).toEqual([
      '192****5609',
      '138****0002',
    ]);
    expect(up.calls).toHaveLength(2);

    const rows = db
      .prepare('SELECT identifier, identifier_hash, uid, username, status FROM supplier_accounts ORDER BY identifier')
      .all() as { identifier: string; identifier_hash: string; uid: string; username: string; status: string }[];
    expect(rows).toHaveLength(2);
    const row1 = rows.find((row) => row.uid === 'u-1');
    expect(row1?.identifier_hash).toBe(sha256Hex('tokenrhythm:uid:u-1'));
    expect(row1?.username).toBe('n1');
    expect(row1?.status).toBe('unknown');
    expect(JSON.stringify(result.report)).not.toContain('sess-');
  });

  it('同一账号换一枚会话再导入 → 覆写同一行，不长第二行', async () => {
    const { db, upstreamId } = makeDb();
    const first = fakeUpstream({
      'sess-old': { status: 200, data: { id: 'u-1', name: 'n1', phoneMasked: '192****5609' } },
    });
    const one = await importSupplierSessionCookies(db, MASTER_KEY, {
      upstreamId,
      text: 'sess-old',
      fetchImpl: first.impl,
    });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    const accountId = one.report.outcomes[0]?.accountId;
    expect(accountId).toBeTruthy();

    const second = fakeUpstream({
      'sess-new': { status: 200, data: { id: 'u-1', name: 'n1', phoneMasked: '192****5609' } },
    });
    const two = await importSupplierSessionCookies(db, MASTER_KEY, {
      upstreamId,
      text: 'sess-new',
      fetchImpl: second.impl,
    });
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(two.report.summary.updated).toBe(1);
    expect(two.report.summary.created).toBe(0);
    expect(two.report.outcomes[0]?.accountId).toBe(accountId);

    const count = db.prepare('SELECT COUNT(*) AS n FROM supplier_accounts').get() as { n: number };
    expect(count.n).toBe(1);
    expect(readSupplierCredential(db, accountId!, MASTER_KEY)?.session).toBe('sess-new');
  });

  it('既有行按真值导入过、uid 已回填 → 按 uid 命中，不新建', async () => {
    const { db, upstreamId } = makeDb();
    const existing = importSupplierSession(db, MASTER_KEY, {
      upstreamId,
      identifier: '19200005609',
      session: 'sess-old',
    });
    expect(existing.ok).toBe(true);
    if (!existing.ok) return;
    updateSupplierAccount(db, existing.accountId, { uid: 'u-1' });

    const up = fakeUpstream({
      'sess-new': { status: 200, data: { id: 'u-1', name: 'n1', phoneMasked: '192****5609' } },
    });
    const result = await importSupplierSessionCookies(db, MASTER_KEY, {
      upstreamId,
      text: 'sess-new',
      fetchImpl: up.impl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.outcomes[0]?.created).toBe(false);
    expect(result.report.outcomes[0]?.accountId).toBe(existing.accountId);
    const count = db.prepare('SELECT COUNT(*) AS n FROM supplier_accounts').get() as { n: number };
    expect(count.n).toBe(1);
    expect(readSupplierCredential(db, existing.accountId, MASTER_KEY)?.session).toBe('sess-new');
  });

  it('既有行 uid 尚未回填 → 按掩码命中，也不新建', async () => {
    const { db, upstreamId } = makeDb();
    const existing = importSupplierSession(db, MASTER_KEY, {
      upstreamId,
      identifier: '19200005609',
      session: 'sess-old',
    });
    expect(existing.ok).toBe(true);
    if (!existing.ok) return;

    const up = fakeUpstream({
      'sess-new': { status: 200, data: { id: 'u-1', name: 'n1', phoneMasked: '192****5609' } },
    });
    const result = await importSupplierSessionCookies(db, MASTER_KEY, {
      upstreamId,
      text: 'sess-new',
      fetchImpl: up.impl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.outcomes[0]?.created).toBe(false);
    expect(result.report.outcomes[0]?.accountId).toBe(existing.accountId);
  });

  it('单行失效不中断整批；失败原因不含会话值', async () => {
    const { db, upstreamId } = makeDb();
    const up = fakeUpstream({
      'sess-bad': { status: 401 },
      'sess-good': { status: 200, data: { id: 'u-2', name: 'n2', phoneMasked: '138****0002' } },
    });
    const result = await importSupplierSessionCookies(db, MASTER_KEY, {
      upstreamId,
      text: 'sess-bad\nsess-good\n',
      fetchImpl: up.impl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.summary).toMatchObject({ total: 2, created: 1, failed: 1 });
    expect(result.report.outcomes[0]?.message).toContain('401');
    expect(JSON.stringify(result.report)).not.toContain('sess-bad');
    expect(JSON.stringify(result.report)).not.toContain('sess-good');
  });

  it('重复会话只问上游一次', async () => {
    const { db, upstreamId } = makeDb();
    const up = fakeUpstream({
      'sess-a': { status: 200, data: { id: 'u-1', name: 'n1', phoneMasked: '192****5609' } },
    });
    const result = await importSupplierSessionCookies(db, MASTER_KEY, {
      upstreamId,
      text: 'sess-a\nsess-a\n',
      fetchImpl: up.impl,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(up.calls).toHaveLength(1);
    expect(result.report.problems).toHaveLength(1);
  });

  it('排除名单非空 → 入口整体拒绝，零上游请求（名单按真值匹配，cookie-only 无法验证）', async () => {
    const { db, upstreamId } = makeDb();
    const up = fakeUpstream({});
    const result = await importSupplierSessionCookies(db, MASTER_KEY, {
      upstreamId,
      text: 'sess-a',
      excluded: new Set(['19200005609']),
      fetchImpl: up.impl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('excluded_unverifiable');
    expect(up.calls).toHaveLength(0);
  });

  it('非 TokenRhythm 上游 → 入口拒绝（这条通路只对它成立）', async () => {
    const { db, upstreamId } = makeDb('tierflow');
    const up = fakeUpstream({});
    const result = await importSupplierSessionCookies(db, MASTER_KEY, {
      upstreamId,
      text: 'sess-a',
      fetchImpl: up.impl,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unsupported_supplier');
    expect(up.calls).toHaveLength(0);
  });
});
