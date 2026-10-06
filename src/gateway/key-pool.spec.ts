/**
 * KeyPool 纯逻辑单测
 * 运行方式：pnpm test（vitest run，与根 package.json 的 test 脚本一致）
 * 覆盖：过滤 / 排序 / 冷却阶梯与封顶 / 并发上限 / 成功结算 / 自动禁用 / 未知余额口径
 * 依据：docs/dev-constraints.md §三 §四
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { MAX_COOLDOWN_MS, MINUTE, NETWORK_BASE_MS, UPSTREAM_ERROR_BASE_MS, nextCooldownMs } from './cooldown.js';
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
  it('权重 → 剩余额度(token-plan) → 上次失败时间 → LRU；balance 类不按余额排序', async () => {
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
      ['k2', 'k3', 'k4', 'k1'],
      'balance 类在键 2 上全平（余额不再排序），同权重档回落到快照序；跨档仍按权重降序',
    );

    pool.reportFailure('k3', 'NETWORK');
    clock += 60 * MINUTE; // 冷却已过，lastFailureAt 仍保留
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['k2', 'k4', 'k3', 'k1'],
      '键 3（上次失败时间）仍生效：k3 带着失败记录沉到同档的 k2/k4 之后',
    );

    // ADR-0011 的核心回归：键 4 LRU —— 用掉谁，谁就沉到同档队尾。
    pool.beginAttempt('k2');
    pool.endAttempt('k2');
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['k4', 'k2', 'k3', 'k1'],
      'k2 刚用过 → 同档内让位给从未用过的 k4（旧行为里 k2 会永远霸占头把）',
    );

    clock += 1;
    pool.beginAttempt('k4');
    pool.endAttempt('k4');
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['k2', 'k4', 'k3', 'k1'],
      'k4 用过之后轮到 k2（stamp T < T+1）—— 头把在 k2/k4 之间确定性轮转',
    );
  });

  it('token-plan 仍按套餐余量降序（键 2 语义只对 token-plan 保留）', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(
      snapshot([
        balanceKey('tp-rich', { category: 'token-plan', balanceCents: null, tokenPlanRemainingTokens: 900 }),
        balanceKey('tp-poor', { category: 'token-plan', balanceCents: null, tokenPlanRemainingTokens: 100 }),
        balanceKey('tp-unknown', { category: 'token-plan', balanceCents: null, tokenPlanRemainingTokens: null }),
      ]),
    );
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['tp-rich', 'tp-poor', 'tp-unknown'],
      '余量降序，未知(-1)靠后但不排除',
    );
    pool.reportSuccess('tp-rich', { prompt: 400, completion: 0, total: 400, isEstimated: false }, 10);
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['tp-rich', 'tp-poor', 'tp-unknown'],
      '乐观扣减后 900-400=500 仍 > 100，序不变（扣减真实生效即可，轮转由键 2 单调性自然产生）',
    );
    pool.reportSuccess('tp-rich', { prompt: 450, completion: 0, total: 450, isEstimated: false }, 10);
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['tp-poor', 'tp-rich', 'tp-unknown'],
      '累计扣到余量 50（>0 仍可用）后 tp-poor 胜出 —— 这是验收 1 在 token-plan 上的既有轮转路径，不得回退',
    );
  });

  it('lastUsedSeq 不进 view()（内部轮转游标，不对外承诺）', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('k1')]));
    pool.beginAttempt('k1');
    pool.endAttempt('k1');
    const rt = pool.view().find((r) => r.keyId === 'k1');
    assert.ok(rt !== undefined);
    assert.equal('lastUsedAt' in rt, false, 'view() 输出形状零变化（/internal/snapshot、key_runtime 镜像不受影响）');
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

  it('阶梯可整条替换（env COOLDOWN_LADDER_SECONDS）：升档按自定义，封顶与基础冷却不变', () => {
    // 阶梯与基础冷却取 max：调低阶梯不会把某类失败压到基础冷却以下
    assert.equal(nextCooldownMs({ reason: 'UPSTREAM_ERROR', consecutiveFails: 3, ladderMs: [1_000, 2_000] }), UPSTREAM_ERROR_BASE_MS);
    // 调高阶梯立刻生效（第 2 档 60s 而不是冻结的 5m），超出长度取最后一档
    assert.equal(nextCooldownMs({ reason: 'UPSTREAM_ERROR', consecutiveFails: 2, ladderMs: [30_000, 60_000] }), 60_000);
    assert.equal(nextCooldownMs({ reason: 'UPSTREAM_ERROR', consecutiveFails: 9, ladderMs: [30_000, 60_000] }), 60_000);
    // 超长阶梯仍被封顶在 MAX_COOLDOWN_MS（30min），不是静默截断阶梯
    assert.equal(nextCooldownMs({ reason: 'NETWORK', consecutiveFails: 2, ladderMs: [0, 99 * MINUTE] }), MAX_COOLDOWN_MS);
    // 长冷却不会因为换阶梯而变短
    assert.equal(nextCooldownMs({ reason: 'AUTH_INVALID', consecutiveFails: 3, ladderMs: [1_000, 2_000] }), MAX_COOLDOWN_MS);
  });

  it('池按自定义阶梯计算冷却（PoolOptions.cooldownLadderMs 真的生效）', () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now, cooldownLadderMs: [30_000, 60_000, 120_000] });
    pool.applySnapshot(snapshot([balanceKey('k1')]));

    pool.reportFailure('k1', 'UPSTREAM_ERROR');
    assert.equal((pool.view()[0]?.cooldownUntil ?? 0) - clock, 30_000, '第 1 档');

    clock += 30_001; // 等冷却过去，制造第 2 次连续失败
    pool.reportFailure('k1', 'UPSTREAM_ERROR');
    assert.equal((pool.view()[0]?.cooldownUntil ?? 0) - clock, 60_000, '第 2 档，而不是冻结的 5m');
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
