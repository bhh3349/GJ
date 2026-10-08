// 装配口缺省值的锁（ADR-0021 决策 4 的注入缝）。
//
// 这里**只锁实例身份**，不锁行为 —— `ApiContext.egress` 本期还没有消费者
// （把管理面那七类出站包进 `fetchFor(egressId, 'management')` 是批二的事），
// 拿行为去断言，等于给一件还没接线的东西编一份期望：它会绿，但它测的是我编的那份期望。
//
// 真正会出错的是另一件事：缺省闸被写成**第二份**。`?? { ...permissiveEgressGate }`
// 这类写法读起来无害，实际造出了第二个"什么都没接"的闸 —— 将来给端口里那份换成真实现时，
// 这一份不会跟着换，于是"未接线"有了两种行为，而两种都看不出来。
// 身份断言是唯一能提前拦住它的东西。

import { describe, expect, it } from 'vitest';
import { permissiveEgressGate, type EgressGate } from '../egress/port.js';
import { resolveEgressGate } from './app.js';

describe('出口闸装配口（ADR-0021 决策 4）', () => {
  it('未注入 ⇒ 缺省就是端口里那个 permissiveEgressGate，不是形状相同的第二份', () => {
    expect(resolveEgressGate(undefined)).toBe(permissiveEgressGate);
  });

  it('注入的实例原样透出：不包装、不复制、不改写', () => {
    const injected: EgressGate = {
      reserve: () => ({ allowed: true }),
      observeLimited: () => ({ attribution: 'key', cooldownUntilMs: null }),
      observeSuccess: () => {},
      cooldownUntil: () => null,
      snapshot: () => [],
    };
    expect(resolveEgressGate(injected)).toBe(injected);
  });
});
