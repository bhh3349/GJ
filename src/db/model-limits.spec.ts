// `model_limits` 编解码口径（契约 §15.7 落库 / §16.3 读取 / §3 `[]` ≡ `null`）。
//
// 单独钉一遍的理由：这个 codec 有两个读方（管理面 `KeyDto.models`、网关 `KeyConfig.models`）
// 和一个写方（`createKey`）。它错的方式是**静默的** —— 白金名单在页面上看得见、
// 在网关上不生效，不报错、不进冷却（§16.3「对不上且无报错」），
// 所以口径必须由本文件钉死，而不是靠两边各自"看起来一样"。

import { describe, expect, it } from 'vitest';
import { parseModelLimits, serializeModelLimits } from './model-limits.js';

describe('serializeModelLimits：空一律归一化为 NULL，不落 \'\'', () => {
  it('正常值 → 逗号拼接', () => {
    expect(serializeModelLimits(['gpt-4o', 'claude-3-5-sonnet'])).toBe('gpt-4o,claude-3-5-sonnet');
  });

  it('`null` / `undefined` ⇒ `null`', () => {
    expect(serializeModelLimits(null)).toBeNull();
    expect(serializeModelLimits(undefined)).toBeNull();
  });

  it('`[]` ⇒ `null`（§3：空数组与不限同义，库里不出现 `\'\'`）', () => {
    expect(serializeModelLimits([])).toBeNull();
  });

  it('全空白 ⇒ `null`（不是 `\'\'`，也不是 `\' \'`）', () => {
    expect(serializeModelLimits(['', '   ', '\t'])).toBeNull();
  });

  it('去空白、丢空项，但不改模型名本身（`*` 原样透出）', () => {
    expect(serializeModelLimits([' gpt-4o ', '', '  ', '*'])).toBe('gpt-4o,*');
  });
});

describe('parseModelLimits：空三态归一为 null，`null` 与 `[]` 出口同形', () => {
  it('正常 CSV → 数组', () => {
    expect(parseModelLimits('gpt-4o,claude-3-5-sonnet')).toEqual(['gpt-4o', 'claude-3-5-sonnet']);
  });

  it('`null` / `\'\'` / 纯空白 ⇒ `null`（老库若残留 `\'\'`，读侧也当不限）', () => {
    expect(parseModelLimits(null)).toBeNull();
    expect(parseModelLimits('')).toBeNull();
    expect(parseModelLimits('   ')).toBeNull();
    expect(parseModelLimits(',,')).toBeNull();
  });

  it('去空白、丢空项，`*` 原样透出', () => {
    expect(parseModelLimits(' gpt-4o , ,*')).toEqual(['gpt-4o', '*']);
  });

  it('往返：写进去再读出来，集合不变（且空值往返恒为 `null`，不漂成 `[]`）', () => {
    for (const input of [['a', 'b'], ['*'], []] as string[][]) {
      expect(parseModelLimits(serializeModelLimits(input))).toEqual(input.length === 0 ? null : input);
    }
    expect(parseModelLimits(serializeModelLimits(null))).toBeNull();
  });
});
