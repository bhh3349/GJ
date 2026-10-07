// 对账表 CSV 序列化（契约 §15.2 `export`）的单元验收。
//
// 与路由层的分工：路由那边测"这条路径的产物类型 / 审计 / 筛选"，这边只测**序列化本身** ——
// 它是一个纯函数，所以这里可以只对着字符串断言，不必起 app、不必种库。
//
// 守的是三件**都不会报错、只会静默出错**的事：
//   1. 公式注入：`=HYPERLINK(...)` 开头的单元格在 Excel 里会被**执行**；
//   2. 数值被当成文本：防注入防过头会把 `-100` 也前缀成文本，于是这份对账表在 Excel 里
//      求不了和 —— 防注入防掉了本表的用途；
//   3. 列错位：表头与数据行不同源时，错位在 CSV 里不报错，只是"列名对不上数"。

import { describe, expect, it } from 'vitest';
import type { SupplierAccountDto, SupplierSubscriptionDto } from '../dto.js';
import {
  SUPPLIER_ACCOUNT_CSV_HEADERS,
  buildSupplierAccountsCsv,
  csvText,
} from './supplier-accounts-export.js';

function sub(over: Partial<SupplierSubscriptionDto> = {}): SupplierSubscriptionDto {
  return {
    subNo: 'SB-1',
    planTitle: null,
    planSlug: null,
    amountTotalCents: null,
    amountUsedCents: null,
    paidCents: null,
    basicTokenTotal: null,
    basicTokenUsed: null,
    status: null,
    source: null,
    startAt: null,
    endAt: null,
    autoRenew: null,
    hasKey: false,
    keyMasked: null,
    updatedAt: '2026-10-07T00:00:00.000Z',
    ...over,
  };
}

function account(over: Partial<SupplierAccountDto> = {}): SupplierAccountDto {
  return {
    id: 'acc_1',
    upstreamId: 'up_1',
    supplier: 'tierflow',
    identifier: '138****8000',
    username: null,
    uid: null,
    status: 'active',
    statusMessage: null,
    balanceCents: 1280,
    balanceUpdatedAt: '2026-10-07T00:00:00.000Z',
    keyCount: 2,
    unlimitedKeyCount: 1,
    maskedKeyCount: 0,
    subscriptions: [],
    credentialSource: 'password',
    hasSession: true,
    sessionExpiresAt: null,
    revision: 1,
    createdAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-10-07T00:00:00.000Z',
    ...over,
  };
}

/** 切一行成单元格。**不用 `split(',')`**：引号内的分隔符正是本文件要测的东西之一。 */
function cells(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const lines = (csv: string): string[] => csv.split('\r\n').slice(0, -1);

describe('表头与行形状：表头即列序', () => {
  it('首行是 SUPPLIER_ACCOUNT_CSV_HEADERS，且 CRLF 收尾（末尾一个空串已被切掉）', () => {
    const csv = buildSupplierAccountsCsv([account()]);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines(csv)[0]).toBe(SUPPLIER_ACCOUNT_CSV_HEADERS.join(','));
  });

  it('每一行的列数与表头一致 —— 错位不报错，只让列名对不上数', () => {
    const csv = buildSupplierAccountsCsv([account(), account({ id: 'acc_2', uid: 'u-2' })]);
    for (const line of lines(csv)) {
      expect(cells(line)).toHaveLength(SUPPLIER_ACCOUNT_CSV_HEADERS.length);
    }
  });

  it('零账号时仍有表头 —— 空表要能打开，不是零字节文件', () => {
    const csv = buildSupplierAccountsCsv([]);
    expect(lines(csv)).toEqual([SUPPLIER_ACCOUNT_CSV_HEADERS.join(',')]);
  });
});

describe('公式注入（供应商侧数据全是外部文本）', () => {
  it.each(['=', '+', '-', '@', '\t', '\r'])('%j 开头 → 前缀单引号', (lead) => {
    const raw = `${lead}cmd|x`;
    // 断言**解出来的值**（而不是原始串）：制表符/回车两个引子还会额外触发 RFC 4180 引号，
    // 直接对字符串断言就会把"防注入做对了"和"引号转义做对了"两件事搅在一起。
    const [decoded] = cells(csvText(raw));
    expect(decoded).toBe(`'${raw}`);
  });

  it('典型载荷整句仍可读，只是不再被求值', () => {
    const payload = '=HYPERLINK("http://evil.example/","click")';
    const [decoded] = cells(csvText(payload));
    expect(decoded).toBe(`'${payload}`);
    // 单引号是前缀、不是转义：载荷原样留着（改内容就篡改了供应商给的原文）。
    // 这一句载荷同时含 `"` 与 `,`，会被 RFC 4180 再包一层引号 ——
    // 两层防护各自成立，解出来的值仍只有**一个**前缀单引号。
    expect(decoded?.startsWith(`'=`)).toBe(true);
    expect(decoded?.match(/'/g)).toHaveLength(1);
  });

  it('数值**不**前缀 —— `-100` 是负数不是公式（余额为负是上游允许的）', () => {
    const csv = buildSupplierAccountsCsv([account({ balanceCents: -331119 })]);
    const row = cells(lines(csv)[1] ?? '');
    expect(row[SUPPLIER_ACCOUNT_CSV_HEADERS.indexOf('balanceCents')]).toBe('-331119');
  });
});

describe('RFC 4180 引号', () => {
  it('含逗号 / 引号 / 换行的值加引号，内部引号翻倍', () => {
    expect(csvText('a,b')).toBe('"a,b"');
    expect(csvText('a"b')).toBe('"a""b"');
    expect(csvText('a\nb')).toBe('"a\nb"');
  });

  it('首尾空格加引号 —— 不加会被 Excel 吃掉，"值变了"看起来像我们的 bug', () => {
    expect(csvText(' pad ')).toBe('" pad "');
  });

  it('普通过（无逗号无引号无空格）不加引号：表在文本编辑器里保持可读', () => {
    expect(csvText('138****8000')).toBe('138****8000');
  });

  it('null → 空单元格（未知 ≠ 0，也 ≠ 字符串 "null"）', () => {
    const csv = buildSupplierAccountsCsv([account({ balanceCents: null, uid: null })]);
    const row = cells(lines(csv)[1] ?? '');
    expect(row[SUPPLIER_ACCOUNT_CSV_HEADERS.indexOf('balanceCents')]).toBe('');
    expect(row[SUPPLIER_ACCOUNT_CSV_HEADERS.indexOf('uid')]).toBe('');
  });
});

describe('套餐两列：计数与"覆盖到什么时候"', () => {
  it('subscriptionCount 是条数；subscriptionEndAt 取**最晚**的 end_at', () => {
    const csv = buildSupplierAccountsCsv([
      account({
        subscriptions: [
          sub({ subNo: 'SB-1', endAt: '2026-11-01T00:00:00.000Z' }),
          sub({ subNo: 'SB-2', endAt: '2026-12-01T00:00:00.000Z' }),
          sub({ subNo: 'SB-3', endAt: '2026-10-20T00:00:00.000Z' }),
        ],
      }),
    ]);
    const row = cells(lines(csv)[1] ?? '');
    expect(row[SUPPLIER_ACCOUNT_CSV_HEADERS.indexOf('subscriptionCount')]).toBe('3');
    expect(row[SUPPLIER_ACCOUNT_CSV_HEADERS.indexOf('subscriptionEndAt')]).toBe(
      '2026-12-01T00:00:00.000Z',
    );
  });

  it('套餐全无到期时间 → 空单元格（不是 0，也不是最后一条的 null）', () => {
    const csv = buildSupplierAccountsCsv([
      account({ subscriptions: [sub({ endAt: null }), sub({ subNo: 'SB-2', endAt: null })] }),
    ]);
    const row = cells(lines(csv)[1] ?? '');
    expect(row[SUPPLIER_ACCOUNT_CSV_HEADERS.indexOf('subscriptionEndAt')]).toBe('');
  });

  it('没有套餐 → 计数 0、到期时间空', () => {
    const row = cells(lines(buildSupplierAccountsCsv([account()]))[1] ?? '');
    expect(row[SUPPLIER_ACCOUNT_CSV_HEADERS.indexOf('subscriptionCount')]).toBe('0');
    expect(row[SUPPLIER_ACCOUNT_CSV_HEADERS.indexOf('subscriptionEndAt')]).toBe('');
  });
});

describe('凭据纪律：入参形状里就没有凭据字段', () => {
  it('整份 CSV 不含密码/会话/密文的任何痕迹，且 identifier 只有掩码', () => {
    const csv = buildSupplierAccountsCsv([account()]);
    expect(csv).not.toMatch(/password|session|cipher|encrypted|secret/i);
    expect(csv).toContain('138****8000');
  });
});
