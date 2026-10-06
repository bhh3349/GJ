// 关联键生成/校验（契约 §6「关联键 `x-request-id`」/ ADR-0014）。
//
// 这里钉住的是**三类一旦破了就静默出问题**的行为：
//   1. 非法入站值不会被沿用（沿用 = 替调用方把任意串写进我们的响应头与两张表的列）；
//   2. 非法值**不抛**（它是诊断信息缺失，不是业务参数错误，不该让请求失败）；
//   3. 生成的值本身就是合法的（自己产的东西过不了自己的闸，等于这条闸是装饰）。

import { describe, expect, it } from 'vitest';
import {
  MAX_REQUEST_ID_CHARS,
  REQUEST_ID_HEADER,
  generateRequestId,
  isValidRequestId,
  resolveRequestId,
} from './request-id.js';

describe('isValidRequestId', () => {
  it('头名与契约一致（小写连字符形式，回写与解析同一处定义）', () => {
    expect(REQUEST_ID_HEADER).toBe('x-request-id');
  });

  it('接受 UUID / 带前缀 trace id / 点下划线', () => {
    expect(isValidRequestId('3f9a1c2e-7d4b-4a11-9c88-2b6f0e5d1a77')).toBe(true);
    expect(isValidRequestId('req_20261006.abcdef')).toBe(true);
    expect(isValidRequestId('0123456789abcdef')).toBe(true);
  });

  it('拒绝空、过短、超长、非法字符、非字符串', () => {
    expect(isValidRequestId('')).toBe(false);
    expect(isValidRequestId('short7')).toBe(false); // 7 位，不够
    expect(isValidRequestId('a'.repeat(MAX_REQUEST_ID_CHARS + 1))).toBe(false);
    expect(isValidRequestId('has space 1234')).toBe(false);
    expect(isValidRequestId('crlf\r\nInjected: 1')).toBe(false); // 响应头注入
    expect(isValidRequestId("quote'and\"dquote\"")).toBe(false);
    expect(isValidRequestId('中文不是白名单字符')).toBe(false);
    expect(isValidRequestId(undefined)).toBe(false);
    expect(isValidRequestId(['dup', 'dup2'])).toBe(false); // 重复头：不挑一个用
    expect(isValidRequestId({ toString: () => 'x'.repeat(20) })).toBe(false);
  });

  it('长度边界：恰好 8 与恰好 64 都算合法', () => {
    expect(isValidRequestId('a'.repeat(8))).toBe(true);
    expect(isValidRequestId('a'.repeat(MAX_REQUEST_ID_CHARS))).toBe(true);
  });
});

describe('resolveRequestId', () => {
  it('合法入站值原样沿用（调用方自己排的 id 必须能对上）', () => {
    const inbound = 'req_20261006-deadbeef';
    expect(resolveRequestId(inbound)).toBe(inbound);
  });

  it('缺失 / 非法 / 超长 → 重新生成，且**不抛**', () => {
    for (const bad of [undefined, '', 'x', 'a'.repeat(200), 'bad id\r\n', 42, ['a', 'b']]) {
      const out = resolveRequestId(bad);
      expect(isValidRequestId(out)).toBe(true);
    }
  });

  it('生成的值本身合法，且两次不同（不是常量占位）', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(isValidRequestId(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('非法入站值不截断成"半个 id"（截一段回写等于伪造一个我们没遵守的 id）', () => {
    const long = 'a'.repeat(200);
    const out = resolveRequestId(long);
    expect(out).not.toBe(long.slice(0, MAX_REQUEST_ID_CHARS));
    expect(out).not.toContain('a'.repeat(64));
  });
});
