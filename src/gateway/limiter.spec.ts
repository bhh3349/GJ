/**
 * 用户组限流单测（RPM / TPM / 日配额）
 * 依据：docs/api-contract.md §4（rpm / tpm / dailyQuota，null = 不限）
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'vitest';

import { createRateLimiter } from './limiter.js';
import type { GroupContext } from './ports.js';

const BASE = Date.parse('2026-10-06T12:00:00.000Z');
let clock = BASE;
const now = (): number => clock;
const at = (iso: string): void => {
  clock = Date.parse(iso);
};

// 每个用例从同一个基准时刻开始 —— 否则上一个用例拨过的时钟会悄悄污染下一个
beforeEach(() => {
  clock = BASE;
});

function group(over: Partial<GroupContext> = {}): GroupContext {
  return { groupId: 'g1', name: '测试组', enabled: true, rpm: null, tpm: null, dailyQuota: null, ...over };
}

describe('RPM', () => {
  it('rpm=null 不限流', () => {
    const limiter = createRateLimiter({ now });
    for (let i = 0; i < 100; i += 1) assert.equal(limiter.check(group()).ok, true);
  });

  it('到量即拒：rpm=3 → 第 4 次 RATE_LIMITED，带 retry-after=1', () => {
    const limiter = createRateLimiter({ now });
    const g = group({ rpm: 3 });
    assert.equal(limiter.check(g).ok, true);
    assert.equal(limiter.check(g).ok, true);
    assert.equal(limiter.check(g).ok, true);

    const verdict = limiter.check(g);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'RATE_LIMITED');
    assert.equal(verdict.retryAfterSec, 1);
    assert.equal(limiter.check(g).ok, false, '被拒的请求不该把自己算进计数');
  });

  it('同一秒内的计数不会提前滑出窗口，满 60s 后整体归零', () => {
    const limiter = createRateLimiter({ now });
    const g = group({ rpm: 5 });
    for (let i = 0; i < 5; i += 1) assert.equal(limiter.check(g).ok, true);
    assert.equal(limiter.check(g).ok, false);

    at('2026-10-06T12:00:30.000Z'); // 半程，桶还没滑出去
    assert.equal(limiter.check(g).ok, false);

    at('2026-10-06T12:01:00.000Z'); // 满 60s
    assert.equal(limiter.check(g).ok, true);
  });

  it('每个用户组各自计数，互不串味', () => {
    const limiter = createRateLimiter({ now });
    const a = group({ groupId: 'a', rpm: 1 });
    const b = group({ groupId: 'b', rpm: 1 });
    assert.equal(limiter.check(a).ok, true);
    assert.equal(limiter.check(a).ok, false);
    assert.equal(limiter.check(b).ok, true);
  });

  it('group.enabled=false 一律拒绝', () => {
    const limiter = createRateLimiter({ now });
    const verdict = limiter.check(group({ enabled: false }));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'RATE_LIMITED');
  });
});

describe('TPM', () => {
  it('token 回填后超限即拒（事后窗口，不预扣）', () => {
    const limiter = createRateLimiter({ now });
    const g = group({ tpm: 100 });

    assert.equal(limiter.check(g).ok, true);
    limiter.commitTokens('g1', 60);
    assert.equal(limiter.check(g).ok, true);

    limiter.commitTokens('g1', 40);
    const verdict = limiter.check(g);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'RATE_LIMITED');
    assert.match(verdict.detail ?? '', /tpm 100\/100/);
  });

  it('token 落在请求结束的那一秒，60s 后滑出', () => {
    const limiter = createRateLimiter({ now });
    const g = group({ tpm: 10 });
    limiter.check(g);
    limiter.commitTokens('g1', 10);
    assert.equal(limiter.check(g).ok, false);

    at('2026-10-06T12:01:00.000Z');
    assert.equal(limiter.check(g).ok, true);
  });

  it('tokens<=0 不记账（避免 0 值把桶撑成脏数据）', () => {
    const limiter = createRateLimiter({ now });
    limiter.commitTokens('g1', 0);
    limiter.commitTokens('g1', -5);
    assert.equal(limiter.dayTokensOf('g1'), 0);
  });
});

describe('日配额', () => {
  it('按 UTC 自然日累计，超限 QUOTA_EXCEEDED + retry-after 指向次日 00:00', () => {
    const limiter = createRateLimiter({ now });
    const g = group({ dailyQuota: 1000 });

    limiter.check(g);
    limiter.commitTokens('g1', 1000);
    assert.equal(limiter.dayTokensOf('g1'), 1000);

    const verdict = limiter.check(g);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'QUOTA_EXCEEDED');
    assert.equal(verdict.retryAfterSec, 12 * 60 * 60, '12:00Z 距次日零点还有 12 小时');
  });

  it('跨 UTC 日自动归零', () => {
    const limiter = createRateLimiter({ now });
    const g = group({ dailyQuota: 10 });
    limiter.check(g);
    limiter.commitTokens('g1', 10);
    assert.equal(limiter.check(g).ok, false);

    at('2026-10-07T00:00:01.000Z');
    assert.equal(limiter.dayTokensOf('g1'), 0);
    assert.equal(limiter.check(g).ok, true);
  });

  it('未出现过的组 dayTokensOf 返回 0，不建窗口', () => {
    const limiter = createRateLimiter({ now });
    assert.equal(limiter.dayTokensOf('never-seen'), 0);
  });
});

describe('reset', () => {
  it('reset(groupId) 只清该组；reset() 清全部', () => {
    const limiter = createRateLimiter({ now });
    const a = group({ groupId: 'a', rpm: 1 });
    const b = group({ groupId: 'b', rpm: 1 });
    assert.equal(limiter.check(a).ok, true);
    assert.equal(limiter.check(b).ok, true);

    limiter.reset('a');
    assert.equal(limiter.check(a).ok, true);
    assert.equal(limiter.check(b).ok, false, 'b 不该被顺手清掉');

    limiter.reset();
    assert.equal(limiter.check(b).ok, true);
  });
});
