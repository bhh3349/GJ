// 出口预算闸**端口**的验收测试（ADR-0021 决策 2 / 3 / 7；验证清单 1 / 2 / 14 / 16）。
//
// 本文件只钉**端口这一层能独立证明的东西**：归一化收敛、`null` 的 fail-open 口径、
// 缺省闸逐字节同现状、标记头常量、`Retry-After` 取整。
// 令牌桶 / 冷却阶梯 / 窗口化判据在 `src/gateway/egress.ts`（路由者车道），不在本文件。
//
// ✅ ADR 验证 #1 / #2 的**并轨回归锁**已落（`b67b3f3`）：`egressHostOf` 已随 ADR-0021 段二**删净**
//    （`src/gateway/engine.ts` 现直接引用 `egressIdOfUrl`），"两个实现同值"那条锁因此**没有对象** ——
//    并轨期结束，现行形态是**单一实现约束**：全仓只有 `egressIdOfUrl` 一个归一化实现
//    （口径见 `docs/adr/0021-egress-budget-seam.md:189`）。原 `egressHostOf` 的 fixture 表整张
//    迁到 `src/gateway/egress.spec.ts`（describe 名「原 egressHostOf fixture 表整张迁来」），
//    由那里的源码扫描锁守 —— 本文件不再承担该锁。

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EGRESS_LOCAL_HEADER,
  EGRESS_LOCAL_VALUE,
  egressIdOfUrl,
  permissiveEgressGate,
  retryAfterSecOf,
  type EgressLimitedInput,
} from './port.js';

describe('egressIdOfUrl（决策 2：全仓唯一归一化 —— 口径见 docs/adr/0021-egress-budget-seam.md:189）', () => {
  it('等价写法收敛到同一个 id：大小写 / 默认端口 / 尾斜杠 / query / fragment / 路径', () => {
    const same = [
      'https://api.example.com/v1/chat/completions',
      'https://API.Example.com/v1',
      'HTTPS://Api.Example.COM',
      'https://api.example.com:443/v1',
      'https://api.example.com/v1/../v1?page=2#frag',
      'https://api.example.com',
    ];
    for (const url of same) expect(egressIdOfUrl(url)).toBe('api.example.com');
  });

  it('非默认端口保留（端口不同 = 出口不同，不得合并）', () => {
    expect(egressIdOfUrl('https://tierflow.cn:8443/v1')).toBe('tierflow.cn:8443');
    expect(egressIdOfUrl('http://a.example:80/v1')).toBe('a.example'); // http 的默认端口仍收敛
  });

  it('解析失败 / 取不到 host → null（fail-open：不拒请求、不记 key 失败、不冷别人的出口）', () => {
    for (const url of ['', 'not a url', '/v1', '::::', 'https://']) {
      expect(egressIdOfUrl(url)).toBeNull();
    }
  });
});

describe('retryAfterSecOf（决策 6：只算数，等待策略归调用方）', () => {
  it('向上取整且至少 1s', () => {
    expect(retryAfterSecOf(0)).toBe(1);
    expect(retryAfterSecOf(1)).toBe(1);
    expect(retryAfterSecOf(999)).toBe(1);
    expect(retryAfterSecOf(1_000)).toBe(1);
    expect(retryAfterSecOf(1_001)).toBe(2);
    expect(retryAfterSecOf(60_000)).toBe(60);
  });

  it('时钟抖动 / 负剩余量不会算出 0 或负数（`Retry-After: 0` 会让调用方立刻重试、把窗口打得更死）', () => {
    expect(retryAfterSecOf(-1)).toBe(1);
    expect(retryAfterSecOf(-60_000)).toBe(1);
  });
});

describe('缺省闸 permissiveEgressGate（决策 7：逐字节同现状）', () => {
  const event = (over: Partial<EgressLimitedInput> = {}): EgressLimitedInput => ({
    egressId: 'api.example.com',
    correlationId: 'corr-1',
    subject: { accountId: 'acct-1', keyId: 'k1' },
    ...over,
  });

  it('`reserve` 恒放行（两个消费方都放行 —— 缺省闸连保留额都不实现）', () => {
    expect(permissiveEgressGate.reserve('api.example.com', 'data')).toEqual({ allowed: true });
    expect(permissiveEgressGate.reserve('api.example.com', 'management')).toEqual({ allowed: true });
  });

  it('`observeLimited` 恒回 `attribution:key` —— 包括账号为 null（无主 key）与异常入参', () => {
    expect(permissiveEgressGate.observeLimited(event())).toEqual({
      attribution: 'key',
      cooldownUntilMs: null,
    });
    expect(permissiveEgressGate.observeLimited(event({ subject: { accountId: null, keyId: 'k2' } }))).toEqual({
      attribution: 'key',
      cooldownUntilMs: null,
    });
  });

  it('`observeLimited` 是全域函数：不返回 undefined、不抛（v10）', () => {
    const verdict = permissiveEgressGate.observeLimited(
      // 故意不给 `subject`：实现侧读到就炸，端口必须仍回一个完整判决
      { egressId: '', correlationId: '', retryAfterMs: 30_000 } as unknown as EgressLimitedInput,
    );
    expect(verdict.attribution).toBe('key');
    expect(verdict.cooldownUntilMs).toBeNull();
  });

  it('冷却面空实现：`cooldownUntil` 恒 null、`snapshot()` 恒空数组、`observeSuccess` 无副作用', () => {
    expect(permissiveEgressGate.cooldownUntil('api.example.com')).toBeNull();
    expect(permissiveEgressGate.snapshot()).toEqual([]);
    expect(() => permissiveEgressGate.observeSuccess('api.example.com')).not.toThrow();
    expect(permissiveEgressGate.snapshot()).toEqual([]);
  });

  it('缺省闸**不**因为反复看到 429 而自己长出状态（"缺省不是证据"）', () => {
    for (let i = 0; i < 47; i += 1) {
      permissiveEgressGate.observeLimited(event({ subject: { accountId: `acct-${i}`, keyId: `k${i}` } }));
    }
    expect(permissiveEgressGate.cooldownUntil('api.example.com')).toBeNull();
    expect(permissiveEgressGate.snapshot()).toEqual([]);
  });
});

describe('进程内标记头常量（决策 4a：唯一字面量来源）', () => {
  it('名字与取值逐字冻结', () => {
    expect(EGRESS_LOCAL_HEADER).toBe('x-sub2api-egress-local');
    expect(EGRESS_LOCAL_VALUE).toBe('1');
  });

  it('装饰器不许把字面量再写一遍（"唯一来源"的回归锁：改字面量只改这一处）', () => {
    const source = readFileSync(new URL('./fetch-gate.ts', import.meta.url), 'utf8');
    expect(source.includes("x-sub2api-egress-local")).toBe(false);
    expect(source.includes("from './port.js'")).toBe(true);
  });
});
