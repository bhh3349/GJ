// 废号池判据（契约 §21.2 / ADR-0043）。纯函数，不发请求、不碰库。
//
// 这个文件存在的理由只有一个：**判据的每一条都能被单独钉住**。
// 落库腿（`repo/scrap-latch.ts`）与判定腿（service 层）都只是调用方 ——
// 判错的后果是"号被误停"或"该停的没停"，两者都要靠这里先立住。

import { describe, expect, it } from 'vitest';
import {
  decideAccountScrap,
  SCRAP_BALANCE_THRESHOLD_CENTS,
  type AccountPlanSnapshot,
} from './scrap.js';

/** 判定时刻钉死，避免用例随真实时间漂（过期判据依赖它）。 */
const NOW = Date.parse('2026-11-03T00:00:00.000Z');

function plan(over: Partial<AccountPlanSnapshot> = {}): AccountPlanSnapshot {
  return { remainingTokens: 8_000_000, expiresAt: '2026-12-31T00:00:00.000Z', ...over };
}

describe('decideAccountScrap：阈值', () => {
  it('阈值 = 100 分（1 元）', () => {
    expect(SCRAP_BALANCE_THRESHOLD_CENTS).toBe(100);
  });

  it('余额恰好 1 元（100 分）**不**进池 —— 「低于 1」不含等于', () => {
    expect(
      decideAccountScrap({ balanceCents: 100, plan: plan({ remainingTokens: 0 }), now: NOW }),
    ).toEqual({ scrap: false });
  });

  it('余额 99 分 + 套餐烧到 0 → 进池', () => {
    expect(
      decideAccountScrap({ balanceCents: 99, plan: plan({ remainingTokens: 0 }), now: NOW }),
    ).toEqual({ scrap: true, reason: 'plan_exhausted' });
  });
});

describe('decideAccountScrap：两项都要见底（「且」不是「或」）', () => {
  it('套餐烧完但余额还够 → **不**进池（那 800 万本来就用完了，钱还在，号还能买新的）', () => {
    expect(
      decideAccountScrap({ balanceCents: 5000, plan: plan({ remainingTokens: 0 }), now: NOW }),
    ).toEqual({ scrap: false });
  });

  it('余额不足但套餐还剩很多 → **不**进池（业主不想白扔剩下的套餐）', () => {
    expect(
      decideAccountScrap({ balanceCents: 0, plan: plan({ remainingTokens: 6_000_000 }), now: NOW }),
    ).toEqual({ scrap: false });
  });

  it('两项都见底 → 进池', () => {
    expect(
      decideAccountScrap({ balanceCents: 0, plan: plan({ remainingTokens: 0 }), now: NOW }),
    ).toEqual({ scrap: true, reason: 'plan_exhausted' });
  });
});

describe('decideAccountScrap：过期把套餐余量清零', () => {
  const expired = plan({ remainingTokens: 6_000_000, expiresAt: '2026-11-01T00:00:00.000Z' });

  it('过期 + 余额不足 → 进池，reason=plan_expired（**哪怕套餐台账还剩 600 万**）', () => {
    expect(decideAccountScrap({ balanceCents: 50, plan: expired, now: NOW })).toEqual({
      scrap: true,
      reason: 'plan_expired',
    });
  });

  it('过期 + 余额还够 → **不**进池（钱能顶上去）', () => {
    expect(decideAccountScrap({ balanceCents: 5000, plan: expired, now: NOW })).toEqual({
      scrap: false,
    });
  });

  it('到期时刻正好等于 now → 算过期（`<=`，与 isUsable 的时效判据同口径）', () => {
    expect(
      decideAccountScrap({
        balanceCents: 0,
        plan: plan({ remainingTokens: 1_000_000, expiresAt: new Date(NOW).toISOString() }),
        now: NOW,
      }),
    ).toEqual({ scrap: true, reason: 'plan_expired' });
  });
});

describe('decideAccountScrap：未知 ≠ 0（ADR-0003）', () => {
  it('余额未知（null）→ 不判，不进池', () => {
    expect(decideAccountScrap({ balanceCents: null, plan: plan({ remainingTokens: 0 }), now: NOW }))
      .toEqual({ scrap: false });
  });

  it('套餐余量未知（null）且未过期 → 不判，不进池', () => {
    expect(decideAccountScrap({ balanceCents: 0, plan: plan({ remainingTokens: null }), now: NOW }))
      .toEqual({ scrap: false });
  });

  it('台账里没有套餐行（plan=null）→ 判不出「套餐耗尽」，不进池', () => {
    expect(decideAccountScrap({ balanceCents: 0, plan: null, now: NOW })).toEqual({ scrap: false });
  });

  it('到期时间串解析不出来 → 当"没说"处理，不因坏串把号废掉', () => {
    expect(
      decideAccountScrap({
        balanceCents: 0,
        plan: plan({ remainingTokens: 0, expiresAt: '不是时间' }),
        now: NOW,
      }),
    ).toEqual({ scrap: true, reason: 'plan_exhausted' });
  });

  it('套餐无到期日（null）→ 不按过期处理，走余量判据', () => {
    expect(
      decideAccountScrap({ balanceCents: 0, plan: plan({ remainingTokens: 0, expiresAt: null }), now: NOW }),
    ).toEqual({ scrap: true, reason: 'plan_exhausted' });
  });
});
