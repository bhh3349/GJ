/**
 * KeyPool 纯逻辑单测
 * 运行方式：pnpm test（vitest run，与根 package.json 的 test 脚本一致）
 * 覆盖：过滤 / 排序 / 冷却阶梯与封顶 / 并发上限 / 成功结算 / 自动禁用 / 未知余额口径
 * 依据：docs/dev-constraints.md §三 §四
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { MAX_COOLDOWN_MS, MINUTE, NETWORK_BASE_MS, nextCooldownMs } from './cooldown.js';
import { createKeyPool } from './key-pool.js';
import type { KeyConfig, PoolSnapshot, TokenUsage } from './types.js';

let clock = 1_700_000_000_000;
const now = (): number => clock;

function balanceKey(keyId: string, over: Partial<KeyConfig> = {}): KeyConfig {
  return {
    keyId,
    upstreamId: 'up1',
    category: 'balance',
    status: 'enabled',
    weight: 1,
    models: null,
    balanceCents: 1000,
    tokenPlanRemainingTokens: null,
    tokenPlanExpiresAt: null,
    ...over,
  };
}

function snapshot(keys: KeyConfig[], upstreams: PoolSnapshot['upstreams'] = [{ upstreamId: 'up1', enabled: true, models: null }]): PoolSnapshot {
  return { revision: 1, upstreams, keys };
}

const usage = (total: number): TokenUsage => ({ prompt: total, completion: 0, total, isEstimated: false });

describe('getAvailableKeys 过滤', () => {
  it('排除 disabled / 上游停用 / 余额为 0 / 套餐过期 / 模型不匹配，保留未知余额', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(
      snapshot([
        balanceKey('ok'),
        balanceKey('disabled', { status: 'disabled' }),
        balanceKey('zero', { balanceCents: 0 }),
        balanceKey('unknown', { balanceCents: null }),
        balanceKey('other-model', { models: ['gpt-4o'] }),
        balanceKey('expired', { category: 'token-plan', tokenPlanRemainingTokens: 100, tokenPlanExpiresAt: '2020-01-01T00:00:00Z' }),
        balanceKey('orphan', { upstreamId: 'up-missing' }),
      ]),
    );

    const ids = (await pool.getAvailableKeys('gpt-4o-mini')).map((c) => c.keyId);
    assert.deepEqual(ids.sort(), ['ok', 'unknown']);
    assert.ok(!ids.includes('zero'), '余额为 0 必须排除');
    assert.ok(ids.includes('unknown'), '未知余额不得当作 0（未知≠0）');
  });
});

describe('getAvailableKeys 排序', () => {
  it('权重 → 剩余额度 → 上次失败时间', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(
      snapshot([
        balanceKey('k1', { weight: 1, balanceCents: 500 }),
        balanceKey('k2', { weight: 2, balanceCents: 100 }),
        balanceKey('k3', { weight: 2, balanceCents: 900 }),
        balanceKey('k4', { weight: 2, balanceCents: 900 }),
      ]),
    );

    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['k3', 'k4', 'k2', 'k1'],
      '同权重按剩余额度降序，额度相同按快照序稳定',
    );

    pool.reportFailure('k3', 'NETWORK');
    clock += 60 * MINUTE; // 冷却已过，lastFailureAt 仍保留
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['k4', 'k3', 'k2', 'k1'],
      '额度相同则从未失败者优先',
    );
  });
});

describe('冷却映射', () => {
  it('NETWORK 首失 15s，连续失败走 1m→5m→15m→30m 封顶', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('k1')]));

    const seen: number[] = [];
    for (let i = 1; i <= 6; i += 1) {
      pool.reportFailure('k1', 'NETWORK');
      const rt = pool.view().find((r) => r.keyId === 'k1');
      assert.ok(rt?.cooldownUntil != null);
      seen.push(rt.cooldownUntil - clock);
      assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '冷却中不得入选');
      clock += (seen[seen.length - 1] ?? 0) + 1; // 等冷却结束，制造下一次连续失败
    }
    assert.deepEqual(seen, [NETWORK_BASE_MS, MINUTE, 5 * MINUTE, 15 * MINUTE, MAX_COOLDOWN_MS, MAX_COOLDOWN_MS]);
  });

  it('AUTH_INVALID / INSUFFICIENT_BALANCE 恒为长冷却 30min；429 尊重 Retry-After', () => {
    assert.equal(nextCooldownMs({ reason: 'AUTH_INVALID', consecutiveFails: 1 }), MAX_COOLDOWN_MS);
    assert.equal(nextCooldownMs({ reason: 'INSUFFICIENT_BALANCE', consecutiveFails: 1 }), MAX_COOLDOWN_MS);
    assert.equal(nextCooldownMs({ reason: 'RATE_LIMITED', consecutiveFails: 1 }), MINUTE);
    assert.equal(nextCooldownMs({ reason: 'RATE_LIMITED', consecutiveFails: 1, retryAfterMs: 120_000 }), 120_000);
  });
});

describe('reportSuccess', () => {
  it('清失败计数与冷却，并按 tokens 结算（token-plan 乐观扣减）', async () => {
    clock = 1_700_000_000_000;
    const collected: Array<{ keyId: string; total: number; latencyMs: number }> = [];
    const pool = createKeyPool({ now, usageSink: (keyId, tokens, latencyMs) => collected.push({ keyId, total: tokens.total, latencyMs }) });
    pool.applySnapshot(snapshot([balanceKey('tp1', { category: 'token-plan', tokenPlanRemainingTokens: 100, balanceCents: null })]));

    pool.reportFailure('tp1', 'UPSTREAM_ERROR');
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0);
    clock += 2 * MINUTE;

    pool.reportSuccess('tp1', usage(100), 42);
    assert.equal(pool.view()[0]?.consecutiveFails, 0);
    assert.equal(pool.view()[0]?.lastLatencyMs, 42);
    assert.deepEqual(collected, [{ keyId: 'tp1', total: 100, latencyMs: 42 }]);

    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '套餐余量耗尽后不再入选');
  });
});

describe('并发上限与自动禁用', () => {
  it('满并发的 key 暂不入选，且不计失败、不进冷却', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('k1', { maxConcurrency: 4 })]));

    for (let i = 0; i < 4; i += 1) assert.equal(pool.beginAttempt('k1'), true);
    assert.equal(pool.beginAttempt('k1'), false, '第 5 个并发位必须拒绝');
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '满并发不入候选');
    assert.equal(pool.view()[0]?.consecutiveFails, 0, '满并发不算失败');

    pool.endAttempt('k1');
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 1, '释放后立即可用');
  });

  it('key 未配 maxConcurrency 时取 PoolOptions.defaultMaxConcurrency，未传则默认 4', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now, defaultMaxConcurrency: 2 });
    pool.applySnapshot(snapshot([balanceKey('k1')]));

    assert.equal(pool.beginAttempt('k1'), true);
    assert.equal(pool.beginAttempt('k1'), true);
    assert.equal(pool.beginAttempt('k1'), false, '第 3 个并发位必须拒绝（defaultMaxConcurrency=2 被忽略则为 4）');
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0);
  });

  it('AUTH_INVALID 连续 5 次自动禁用并告警', async () => {
    clock = 1_700_000_000_000;
    const alerts: string[] = [];
    const pool = createKeyPool({ now });
    pool.onAlert = (e) => alerts.push(`${e.type}:${e.keyId}`);
    pool.applySnapshot(snapshot([balanceKey('k1')]));

    for (let i = 0; i < 5; i += 1) {
      pool.reportFailure('k1', 'AUTH_INVALID');
      clock += MAX_COOLDOWN_MS + 1;
    }
    assert.deepEqual(alerts, ['AUTH_INVALID_AUTO_DISABLED:k1']);
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '自动禁用后不再入选');
  });
});

describe('applySnapshot', () => {
  it('刷新后移除已删除 key 的运行态，保留仍在册 key 的冷却', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('k1'), balanceKey('k2')]));
    pool.reportFailure('k1', 'NETWORK');

    pool.applySnapshot({ revision: 2, upstreams: [{ upstreamId: 'up1', enabled: true, models: null }], keys: [balanceKey('k1')] });
    assert.deepEqual(pool.view().map((r) => r.keyId), ['k1']);
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '冷却跨越快照刷新仍生效');
  });
});
