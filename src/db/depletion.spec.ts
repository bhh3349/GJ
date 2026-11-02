// 透支锁存的**判据**（契约 §20.2 / ADR-0041 决策 2）。
//
// 这里钉的不是"函数返回了 true"，而是**五个容易写反的边界**。它们的共同点是：
// 写反了不报错、不抛异常、测试也不崩 —— 只是库里多一批（或少一批）锁存行，
// 而那种错误只会在生产上以"怎么这把 key 不接流量了 / 怎么钱充了还不回池"的形式出现：
//
//   1. **`NULL` 不是 0**（ADR-0003）：查不到 ≠ 没钱。写反 → 一批还没查过余额的新 key
//      在第一次刷新前就被锁死，且**没有任何一条日志**说为什么。
//   2. **`unlimited` 结构上够不着这把锁**：它的 `balance_cents` 恒 `NULL`，本就判不到；
//      但代码里显式再判一次 —— 这条不变量由驱动器与落库纪律两处共同维持，
//      任何一处松了，沉默的后果是"一整批无限额度 key 集体锁存"。
//   3. **阈值是"低于"不是"不高于"**：`< 10`。`10` 分本身**不锁**。
//      差一个等号，锁存的是一把刚好够打一次请求的 key。
//   4. **套餐只认 `=== 0`，不认 `<= 0`**：负余量在落库前已被夹到 0，
//      判据只认契约里写的那一个值。
//   5. **两个判据各看各的列**：一把 balance 类 key 的 `token_plan_remaining`
//      可能是改类别时的历史残留，拿它去判会锁一把有钱的 key（分派在 `latchIfBalanceDepleted`）。

import { describe, expect, it } from 'vitest';

import {
  DEPLETED_BALANCE_THRESHOLD_CENTS,
  isAccountDepleted,
  isBalanceDepleted,
  isTokenPlanDepleted,
} from './depletion.js';

describe('§20.2 阈值只有一份：10 分 = ¥0.1', () => {
  it('常量就是 10 —— 契约 §20.2 的表格与本文件逐字相同', () => {
    expect(DEPLETED_BALANCE_THRESHOLD_CENTS).toBe(10);
  });
});

describe('§20.2 余额类：已知且 < 阈值才锁', () => {
  it('0 与负数**都锁**（"付不起账"包含"欠费"）', () => {
    for (const cents of [0, -1, -215, -331119]) {
      expect(isBalanceDepleted({ unlimited: false, balanceCents: cents }), `balance=${cents}`).toBe(true);
    }
  });

  it('阈值本身**不锁**：`< 10` 不是 `<= 10`', () => {
    expect(isBalanceDepleted({ unlimited: false, balanceCents: DEPLETED_BALANCE_THRESHOLD_CENTS })).toBe(false);
    expect(isBalanceDepleted({ unlimited: false, balanceCents: DEPLETED_BALANCE_THRESHOLD_CENTS - 1 })).toBe(true);
    expect(isBalanceDepleted({ unlimited: false, balanceCents: 1280 })).toBe(false);
  });

  it('未知（NULL）**不锁**：查不到 ≠ 没钱（ADR-0003）', () => {
    expect(isBalanceDepleted({ unlimited: false, balanceCents: null })).toBe(false);
  });

  it('`unlimited` 显式拦一道：即便有人把 0 塞进 balanceCents 也不锁', () => {
    // 现实里 `unlimited=1` 的行 `balance_cents` 必须是 NULL（§15.7），所以这个组合
    // 不该出现。但"不该出现"不是"不会出现"——上游的 -331119 占位值落库一次就够。
    expect(isBalanceDepleted({ unlimited: true, balanceCents: 0 })).toBe(false);
    expect(isBalanceDepleted({ unlimited: true, balanceCents: -331119 })).toBe(false);
    expect(isBalanceDepleted({ unlimited: true, balanceCents: null })).toBe(false);
  });
});

describe('§20.2 套餐类：落库余量 `=== 0` 才锁', () => {
  it('0 锁；正数不锁', () => {
    expect(isTokenPlanDepleted({ remainingTokens: 0 })).toBe(true);
    expect(isTokenPlanDepleted({ remainingTokens: 1 })).toBe(false);
    expect(isTokenPlanDepleted({ remainingTokens: 1_000_000 })).toBe(false);
  });

  it('NULL **不锁**：那是"上游没说用了多少"，不是"一点没剩"', () => {
    expect(isTokenPlanDepleted({ remainingTokens: null })).toBe(false);
  });

  it('负数**不锁**：判据只认 `=== 0`，夹到 0 是写侧的事（契约 §20.2）', () => {
    // 这一条看起来反直觉，但它是刻意的：上游并发计费的瞬时态可能给出 `used > total`，
    // 那个负数在 `backfillSubscriptionTokenPlan` 落库前已被 `Math.max(0, …)` 夹成 0。
    // 判据依赖写侧会把它变成"两处各判一次、两处可以不一致"，所以这里**只**认契约写的那个值。
    expect(isTokenPlanDepleted({ remainingTokens: -5 })).toBe(false);
  });
});

describe('§20.6 账号：余额见底 **且** 套餐不可用才连坐（v1.21.0 / ADR-0045）', () => {
  // 钉住"过期那一刻"：NOW 落在 PAST 与 FUTURE 之间。
  const NOW = Date.parse('2026-11-03T04:00:00.000Z');
  const FUTURE = '2026-12-31T00:00:00.000Z';
  const PAST = '2026-10-31T00:00:00.000Z';

  it('业主现场：余额 ¥0 + 套餐还剩 800 万 ⇒ **不连坐**（套餐 key 花的是套餐额度）', () => {
    // 这是 ADR-0045 的核心用例：截图里那个账号「余额 ¥0.00、套餐 ¥29.90」被连坐锁死，
    // 而套餐 key 明明能出量。收窄后它不该再被连坐。
    expect(
      isAccountDepleted({
        unlimited: false,
        balanceCents: 0,
        plan: { remainingTokens: 8_000_000, expiresAt: FUTURE },
        now: NOW,
      }),
    ).toBe(false);
  });

  it('余额 0 + 套餐余量 0 ⇒ 连坐（两项都见底）', () => {
    expect(
      isAccountDepleted({
        unlimited: false,
        balanceCents: 0,
        plan: { remainingTokens: 0, expiresAt: FUTURE },
        now: NOW,
      }),
    ).toBe(true);
  });

  it('余额 0 + 套餐已过期（余量仍 800 万）⇒ 连坐（过期把余量按 0 计）', () => {
    expect(
      isAccountDepleted({
        unlimited: false,
        balanceCents: 0,
        plan: { remainingTokens: 8_000_000, expiresAt: PAST },
        now: NOW,
      }),
    ).toBe(true);
  });

  it('台账没有套餐行 ⇒ 不连坐（判不出"套餐也见底"；余额 key 仍被自己的判据逐把锁）', () => {
    expect(isAccountDepleted({ unlimited: false, balanceCents: 0, plan: null, now: NOW })).toBe(false);
  });

  it('余额未知 / 无限额度 ⇒ 不连坐（ADR-0003；连坐也要求"值非 NULL"）', () => {
    const plan = { remainingTokens: 0, expiresAt: FUTURE };
    expect(isAccountDepleted({ unlimited: false, balanceCents: null, plan, now: NOW })).toBe(false);
    expect(isAccountDepleted({ unlimited: true, balanceCents: null, plan, now: NOW })).toBe(false);
    // unlimited 即便带着一个 0 也够不着（上游 unlimited 的 balanceCents 按设计恒 null）。
    expect(isAccountDepleted({ unlimited: true, balanceCents: 0, plan, now: NOW })).toBe(false);
  });

  it('余额还够（500 分）+ 套餐耗尽 ⇒ 不连坐（余额一项不成立；套餐 key 由自己的判据锁）', () => {
    expect(
      isAccountDepleted({
        unlimited: false,
        balanceCents: 500,
        plan: { remainingTokens: 0, expiresAt: FUTURE },
        now: NOW,
      }),
    ).toBe(false);
  });

  it('套餐余量未知（上游没说）⇒ 不连坐（未知 ≠ 0）', () => {
    expect(
      isAccountDepleted({
        unlimited: false,
        balanceCents: 0,
        plan: { remainingTokens: null, expiresAt: FUTURE },
        now: NOW,
      }),
    ).toBe(false);
  });

  it('余量 1（最小可用值）⇒ 不连坐；余量 0 才连坐（token 是整数，边界 `< 1`）', () => {
    const base = { unlimited: false, balanceCents: 0, now: NOW };
    expect(isAccountDepleted({ ...base, plan: { remainingTokens: 1, expiresAt: FUTURE } })).toBe(false);
    expect(isAccountDepleted({ ...base, plan: { remainingTokens: 0, expiresAt: FUTURE } })).toBe(true);
  });

  it('到期时间解析不出来 ⇒ 当"没说"处理（不因为坏时间串锁整批 key）', () => {
    expect(
      isAccountDepleted({
        unlimited: false,
        balanceCents: 0,
        plan: { remainingTokens: 8_000_000, expiresAt: 'not-a-date' },
        now: NOW,
      }),
    ).toBe(false);
  });
});
