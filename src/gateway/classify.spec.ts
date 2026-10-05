/**
 * 失败分类与 Retry-After 单测
 * 依据：docs/api-contract.md §10「失败枚举（计入 key 失败，仅这五类）」
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { classifyUpstreamStatus, parseRetryAfter } from './classify.js';

describe('classifyUpstreamStatus', () => {
  it('五类失败各自归类', () => {
    assert.equal(classifyUpstreamStatus(401), 'AUTH_INVALID');
    assert.equal(classifyUpstreamStatus(403), 'AUTH_INVALID');
    assert.equal(classifyUpstreamStatus(402), 'INSUFFICIENT_BALANCE');
    assert.equal(classifyUpstreamStatus(429), 'RATE_LIMITED');
    assert.equal(classifyUpstreamStatus(500), 'UPSTREAM_ERROR');
    assert.equal(classifyUpstreamStatus(502), 'UPSTREAM_ERROR');
    assert.equal(classifyUpstreamStatus(503), 'UPSTREAM_ERROR');
  });

  it('400/404/422 不计失败 —— 否则一个写错参数的调用方能打空整个池子', () => {
    assert.equal(classifyUpstreamStatus(400), null);
    assert.equal(classifyUpstreamStatus(404), null);
    assert.equal(classifyUpstreamStatus(413), null);
    assert.equal(classifyUpstreamStatus(422), null);
  });

  it('3xx 不归类（fetch 已自动跟随；真漏出来也不该赖 key）', () => {
    assert.equal(classifyUpstreamStatus(304), null);
  });
});

describe('parseRetryAfter', () => {
  const nowMs = Date.parse('2026-10-06T12:00:00.000Z');

  it('秒数 → 毫秒', () => {
    assert.equal(parseRetryAfter('60', nowMs), 60_000);
    assert.equal(parseRetryAfter(' 30 ', nowMs), 30_000);
  });

  it('HTTP-date → 相对毫秒', () => {
    assert.equal(parseRetryAfter('Tue, 06 Oct 2026 12:00:45 GMT', nowMs), 45_000);
  });

  it('缺失 / 畸形 / 过去时间 → undefined（回落 cooldown 默认值）', () => {
    assert.equal(parseRetryAfter(null, nowMs), undefined);
    assert.equal(parseRetryAfter(undefined, nowMs), undefined);
    assert.equal(parseRetryAfter('', nowMs), undefined);
    assert.equal(parseRetryAfter('abc', nowMs), undefined);
    assert.equal(parseRetryAfter('0', nowMs), undefined);
    assert.equal(parseRetryAfter('Tue, 06 Oct 2026 11:59:00 GMT', nowMs), undefined);
  });
});
