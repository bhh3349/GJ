// message 净化（契约 §12.1「落盘前脱敏」/ ADR-0013 §5）。
//
// 这里测的是**三件一旦破了就不可逆**的事：
//   1. 已知形状的凭据必须被抹掉（漏抹一次，明文就永久进了库）；
//   2. 普通归因文本**不许**被抹（过度脱敏会把 message 变成一串星号，
//      而"上游到底说了什么"正是这个字段存在的意义）；
//   3. 抹与截的**顺序**：先截后抹会留下"恰好被切成一半"的凭据尾巴。
//
// 凭据样本一律运行时拼装（`shaped()`），源码里不存在真 key 形状的字面量 ——
// 否则 `pnpm check:secrets` 会在自己的测试文件里命中，把扫描器变成狼来了。

import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_CHARS, fallbackMask, scrubCredentials, scrubMessage } from './redact.js';

/**
 * 拼一个"形状对得上、但源码里没有这个字面量"的凭据。
 *
 * 返回 `Bearer ` 之外的裸串：前 3 位用来让读者看出是哪一类，后面是填充。
 */
function shaped(prefix: string, n = 24): string {
  return `${prefix}${'A'.repeat(n)}`;
}

describe('scrubCredentials：已知形状的凭据', () => {
  it('抹掉 Authorization 头里的 Bearer 令牌，保留 Bearer 字样', () => {
    const out = scrubCredentials(`upstream said: Authorization: Bearer ${shaped('eyJ')} (401)`);
    expect(out).not.toContain(shaped('eyJ'));
    expect(out).toContain('Bearer ****');
    // 归因信息还在：看得到是哪一段被抹的
    expect(out).toContain('upstream said');
    expect(out).toContain('(401)');
  });

  it('抹掉 sk- 系上游 key 与 gw- 网关 key 两种前缀', () => {
    const upstream = shaped('sk-probe-');
    const gateway = shaped('gw-');
    const out = scrubCredentials(`a=${upstream} b=${gateway}`);
    expect(out).not.toContain(upstream);
    expect(out).not.toContain(gateway);
    expect(out.match(/\*\*\*\*/g)?.length).toBe(2);
  });

  it('抹掉 api_key= / x-api-key: / "token": 这类字段值，但保留字段名', () => {
    const v = shaped('val', 16);
    const out = scrubCredentials(`invalid api_key=${v}`);
    expect(out).not.toContain(v);
    // 字段名留着 —— 抹完仍看得出"原本是哪个字段出的问题"
    expect(out).toBe('invalid api_key=****');

    const out2 = scrubCredentials(`{"x-api-key": "${v}"}`);
    expect(out2).not.toContain(v);
    expect(out2).toContain('x-api-key');
  });

  it('幂等：抹过的结果再抹一次不变（仓储层会二次净化，不能因此变形）', () => {
    const once = scrubCredentials(`Bearer ${shaped('tok')}`);
    expect(scrubCredentials(once)).toBe(once);
  });

  it('不误伤普通归因文本（数字、URL、模型名、上游原话）', () => {
    const text = 'upstream 502 after 1234ms; model=gpt-4o-mini; retry-after=30; https://api.example.com/v1';
    expect(scrubCredentials(text)).toBe(text);
  });
});

describe('scrubMessage：message 字段的完整落盘形态', () => {
  it('null / undefined / 空白 → null（不留空串这种第二形态的"空"）', () => {
    expect(scrubMessage(null)).toBeNull();
    expect(scrubMessage(undefined)).toBeNull();
    expect(scrubMessage('')).toBeNull();
    expect(scrubMessage('  \t \r\n ')).toBeNull();
  });

  it('控制字符与换行压成单空格：message 是一行摘要，不是多行堆栈', () => {
    expect(scrubMessage('upstream\nerror\n\n  at  line 1')).toBe('upstream error at line 1');
    expect(scrubMessage('a\u0007b')).toBe('a b');
  });

  it('超长截断到 MAX_MESSAGE_CHARS 并带省略号', () => {
    const out = scrubMessage('x'.repeat(MAX_MESSAGE_CHARS * 2));
    expect(out).not.toBeNull();
    expect(out?.length).toBe(MAX_MESSAGE_CHARS);
    expect(out?.endsWith('…')).toBe(true);
  });

  it('先抹再截：跨越截断点的凭据不会留下可辨认的一半', () => {
    // 凭据正好落在 512 字符边界附近 —— 若先截后抹，`sk-probe-AAAA…` 会被切成
    // 前半段留在库里，而"能认出是哪家 key"这一点信息量恰恰在那前半段上。
    const tail = shaped('sk-probe-');
    const raw = `${'x'.repeat(MAX_MESSAGE_CHARS - 10)} ${tail} trailing`;
    const out = scrubMessage(raw) ?? '';

    expect(out.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(out).not.toContain('sk-');
    expect(out).not.toContain(tail.slice(0, 12));
  });

  it('落盘形态与 clean 输入一致时不做无谓改写', () => {
    expect(scrubMessage('upstream 503')).toBe('upstream 503');
  });
});

describe('fallbackMask', () => {
  it('是 **** 而不是空串/null（"有关联但认不出哪把"与"与 key 无关"不能混同）', () => {
    expect(fallbackMask()).toBe('****');
  });
});
