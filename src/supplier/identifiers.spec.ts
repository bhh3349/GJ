// 标识归一化 / 掩码 / 排除名单的离线用例。
//
// **本文件里没有、也不得有真实手机号**：排除名单的用例一律用 `1x` 段的合成号。
// 把真号码写进源码 = 写进 git = 一个不该在仓库里长期留存的个人标识符 ——
// 排除名单走环境变量（见 identifiers.ts 的文件头），用例只需证明"机制成立"。

import { describe, expect, it } from 'vitest';
import {
  EXCLUDED_IDENTIFIERS_ENV,
  isExcluded,
  maskIdentifier,
  normalizeIdentifier,
  parseExcludedIdentifiers,
} from './identifiers.js';

describe('归一化（§15.2 import 要容忍的写法）', () => {
  it('+86 前缀只在"11 位 + 86 = 13 位"时剥掉', () => {
    expect(normalizeIdentifier('+8613800000000')).toBe('13800000000');
    expect(normalizeIdentifier('8613800000000')).toBe('13800000000');
    expect(normalizeIdentifier('008613800000000')).toBe('13800000000');
  });

  it('本来就是 11 位、以 86 开头的号不被误剥', () => {
    expect(normalizeIdentifier('86138000000')).toBe('86138000000');
  });

  it('空格 / 制表符 / 连字符 / 括号一律吃掉', () => {
    expect(normalizeIdentifier(' 138 0000-0000 ')).toBe('13800000000');
    expect(normalizeIdentifier('138(0000)0000')).toBe('13800000000');
  });

  it('邮箱 trim + 小写，但不去分隔符 —— a.b@x 与 ab@x 是两个人', () => {
    expect(normalizeIdentifier('  A.B@X.com ')).toBe('a.b@x.com');
    expect(normalizeIdentifier('ab@x.com')).not.toBe(normalizeIdentifier('a.b@x.com'));
  });

  it('收不出东西返回 null —— 调用方按"这一行跳过并报原因"处理，不造行', () => {
    expect(normalizeIdentifier('   ')).toBeNull();
    expect(normalizeIdentifier('+-()')).toBeNull();
    expect(normalizeIdentifier('')).toBeNull();
  });
});

describe('展示掩码（§15.1：identifier 是掩码，真值不出后端）', () => {
  it('手机号按契约样例同形：前 3 + **** + 后 4', () => {
    expect(maskIdentifier('13800000000')).toBe('138****0000');
  });

  it('邮箱只留首字符与域名', () => {
    expect(maskIdentifier('a.b@x.com')).toBe('a*@x.com');
  });

  it('短到没法掩时返回 null，**不返回原文** —— 退化输出原文就是一条静默明文泄漏', () => {
    expect(maskIdentifier('12345')).toBeNull();
    expect(maskIdentifier('@x.com')).toBeNull();
    expect(maskIdentifier('x')).toBeNull();
  });
});

describe('排除名单（Bo 的硬约束落成代码闸）', () => {
  it('默认空名单：没给就是没给，不是"都安全"', () => {
    expect(parseExcludedIdentifiers({}).size).toBe(0);
    expect(isExcluded('13800000000', parseExcludedIdentifiers({}))).toBe(false);
  });

  it('逗号 / 分号 / 换行都当分隔符，项内写法先归一化', () => {
    const env = { [EXCLUDED_IDENTIFIERS_ENV]: '+8613800000000; 13900000000\n 13700000000 ' };
    const set = parseExcludedIdentifiers(env);
    expect(set.size).toBe(3);
    expect(set.has('13800000000')).toBe(true);
  });

  it('命中判据在原文上也能用 —— 排除项的比对不能因为写法不同而漏', () => {
    const set = parseExcludedIdentifiers({ [EXCLUDED_IDENTIFIERS_ENV]: '13800000000' });
    expect(isExcluded('+86 138 0000 0000', set)).toBe(true);
  });

  it('空名单时零开销，且不把"收不出东西"的输入算成排除', () => {
    const set = parseExcludedIdentifiers({ [EXCLUDED_IDENTIFIERS_ENV]: '13800000000' });
    // 这不是"被排除的号"，是"这一行根本没法处理" —— 两件事的计数必须分得开。
    expect(isExcluded('   ', set)).toBe(false);
  });
});
