// §15.9 批量离线会话导入的离线用例（零网络）。
//
// 钉三件事：**格式**（TAB / 逗号 / 空白、表头、注释、重复行）、**清洗**（`tr_session=`
// 与 `; Path=/` 只留 value）、**不回显**（失败与成功输出都不含会话明文或标识原文）。

import { describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/database.js';
import { createUpstream } from '../db/repo/upstreams.js';
import { readSupplierCredential } from '../db/repo/supplier-accounts.js';
import {
  importSupplierSessionBatch,
  normalizeSessionValue,
  parseSessionBatchText,
} from './session-import-batch.js';

const MASTER_KEY = Buffer.from('4d'.repeat(32), 'hex');

function makeDb(): { db: Db; upstreamId: string } {
  const db = openDatabase({ path: ':memory:', noWal: true });
  const up = createUpstream(db, {
    name: 'tr',
    baseUrl: 'https://tokenrhythm.example',
    supplier: 'tokenrhythm',
  });
  return { db, upstreamId: up.id };
}

describe('parseSessionBatchText', () => {
  it('支持 TAB / 逗号 / 空白三种分隔，跳过空行与 # 注释', () => {
    const parsed = parseSessionBatchText(
      [
        '# 本机文件，不要提交到仓库',
        '19200000001\tsess-tab',
        '19200000002,sess-comma',
        '19200000003 sess-space',
        '',
      ].join('\n'),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.rows.map((row) => row.identifier)).toEqual([
      '19200000001',
      '19200000002',
      '19200000003',
    ]);
    expect(parsed.rows.map((row) => row.session)).toEqual(['sess-tab', 'sess-comma', 'sess-space']);
    expect(parsed.rows.map((row) => row.line)).toEqual([2, 3, 4]);
  });

  it('首行表头只吃一次：identifier,session / 账号,cookie', () => {
    for (const header of ['identifier,session', '账号,cookie']) {
      const parsed = parseSessionBatchText(`${header}\n19200000001,sess-a`);
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.problems).toEqual([]);
    }
  });

  it('会话一侧可以整段粘贴 Cookie：只留 tr_session 的 value', () => {
    const parsed = parseSessionBatchText(
      '19200000001\tname=abc; tr_session=sess-real; Path=/; HttpOnly',
    );
    expect(parsed.rows[0]?.session).toBe('sess-real');
    expect(normalizeSessionValue('"tr_session=sess-quoted"')).toBe('sess-quoted');
    expect(normalizeSessionValue('sess-bare')).toBe('sess-bare');
  });

  it('同一账号第二次出现 → 跳过并报一行，保留第一行', () => {
    const parsed = parseSessionBatchText(
      ['19200000001,sess-first', '19200000001,sess-second'].join('\n'),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.session).toBe('sess-first');
    expect(parsed.problems).toHaveLength(1);
    expect(parsed.problems[0]?.line).toBe(2);
  });

  it('缺分隔符 / 标识不可归一化 / 会话为空 / 重复 → 逐行报原因，且不回显任何输入片段', () => {
    const secret = 'sess-do-not-echo';
    const parsed = parseSessionBatchText(
      [
        '19200000001', // 1: 没有分隔符
        'abc,sess-x', // 2: 掩不了码
        '19200000003,   ', // 3: 会话为空（切不出第二格）
        '19200000001,sess-first', // 4: 合法，占住这个号
        `19200000001,${secret}`, // 5: 重复 → 跳过，且问题里不能出现 secret
      ].join('\n'),
    );
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.problems).toHaveLength(4);
    expect(JSON.stringify(parsed.problems)).not.toContain(secret);
    expect(JSON.stringify(parsed.problems)).not.toContain('19200000001');
  });
});

describe('importSupplierSessionBatch', () => {
  it('逐行落库：新建 / 覆写 / 失败互不打断，报告只含掩码', () => {
    const { db, upstreamId } = makeDb();
    const first = importSupplierSessionBatch(db, MASTER_KEY, {
      upstreamId,
      text: ['19200000001,sess-a', '19200000002,sess-b'].join('\n'),
    });
    expect(first.summary).toEqual({ total: 2, created: 2, updated: 0, failed: 0, problems: 0 });

    const second = importSupplierSessionBatch(db, MASTER_KEY, {
      upstreamId,
      text: [
        '19200000001,sess-a2', // 覆写
        'bad-identifier,sess-c', // 解析失败
        '19200000003,sess-d', // 新建
        '12345,sess-e', // 太短，掩不了码
      ].join('\n'),
    });
    expect(second.summary).toEqual({ total: 2, created: 1, updated: 1, failed: 0, problems: 2 });
    expect(second.outcomes.map((item) => item.created)).toEqual([false, true]);
    expect(JSON.stringify(second)).not.toContain('sess-');

    const count = db.prepare('SELECT COUNT(*) AS n FROM supplier_accounts').get() as { n: number };
    expect(count.n).toBe(3);

    // 覆写行解回来的是新会话，且掩码是列表页的形态。
    const updated = second.outcomes[0];
    expect(updated?.identifier).toBe('192****0001');
    expect(readSupplierCredential(db, updated?.accountId ?? '', MASTER_KEY)?.session).toBe('sess-a2');
  });

  it('排除名单命中 → 该行失败，其余行照常写入', () => {
    const { db, upstreamId } = makeDb();
    const report = importSupplierSessionBatch(db, MASTER_KEY, {
      upstreamId,
      text: ['19200000001,sess-a', '19200000002,sess-b'].join('\n'),
      excluded: new Set(['19200000001']),
    });
    expect(report.summary).toEqual({ total: 2, created: 1, updated: 0, failed: 1, problems: 0 });
    expect(report.outcomes[0]?.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain('sess-');
  });
});
