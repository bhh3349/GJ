/**
 * 验收 §九.1 回归：路由轮询出量分布
 * 依据：需求文档 §九.1「每个健康 key 成功占比 ≥10%」+ ADR-0011（balance 退出排序键 2、LRU 兜底）
 *
 * 背景：M0 冻结的贪心排序（权重 → 剩余额度 → 上次失败时间）在 balance 类上退化成
 * 「余额最高者永远胜出」的单 key 饥饿——余额（分）是计费资金，不随请求递减，
 * 三个排序键在 balance 类上每次成功后都不变。验收 §九.1 的存在本身否定这种垄断。
 *
 * 判据：连续 60 次请求，每把健康 key 出量 ≥10%（即 ≥6 次）；同场景用旧排序会得到 100/0/0/0/0/0。
 * 场景对齐探针（.ekko-tmp/probe-poll.ts，ADR-0011 起删除）：A 余额未知 / B 余额互不相同 / C token-plan 余量相等。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { createGatewayEngine } from './engine.js';
import type { FetchLike } from './engine.js';
import { createKeyPool } from './key-pool.js';
import type { GroupContext, ModelCatalog, SecretResolver, UpstreamTarget } from './ports.js';
import type { KeyConfig, PoolSnapshot } from './types.js';

const GROUP: GroupContext = { groupId: 'grp_poll', name: '轮询回归', enabled: true, rpm: null, tpm: null, dailyQuota: null };
const ROUNDS = 60;
const MIN_SHARE = 0.1; // 验收 §九.1：每 key ≥10%

function key(keyId: string, upstreamId: string, over: Partial<KeyConfig> = {}): KeyConfig {
  return {
    keyId,
    upstreamId,
    category: 'balance',
    status: 'enabled',
    weight: 1,
    models: null,
    balanceCents: null,
    tokenPlanRemainingTokens: null,
    tokenPlanExpiresAt: null,
    ...over,
  };
}

const upstreams: PoolSnapshot['upstreams'] = [
  { upstreamId: 'up1', enabled: true, models: null },
  { upstreamId: 'up2', enabled: true, models: null },
];

/** 2 上游 × 3 key、权重全相等、连续 60 次串行请求 → 每把 key 的出量次数 */
async function pollDistribution(keys: KeyConfig[]): Promise<Map<string, number>> {
  const snapshot: PoolSnapshot = { revision: 1, upstreams, keys };
  const pool = createKeyPool({});
  pool.applySnapshot(snapshot);
  const secrets: SecretResolver = {
    resolve: (keyId) => {
      const found = keys.find((x) => x.keyId === keyId);
      if (found === undefined) return null;
      const target: UpstreamTarget = { upstreamId: found.upstreamId, baseUrl: `https://${found.upstreamId}.example.com/v1`, apiKey: `sk-${keyId}` };
      return target;
    },
  };
  const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ id: 'cmpl_poll', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const engine = createGatewayEngine({ pool, secrets, models, fetchImpl });

  const hits = new Map<string, number>();
  for (let i = 0; i < ROUNDS; i += 1) {
    const r = await engine.chatCompletions({ group: GROUP, model: 'gpt-4o-mini', body: { messages: [] }, stream: false });
    if (r.kind !== 'json') throw new Error(`轮询场景不应出现错误响应：${JSON.stringify('kind' in r ? r.kind : r)}`);
    hits.set(r.keyId, (hits.get(r.keyId) ?? 0) + 1);
  }
  return hits;
}

function assertEveryKeyAtLeastTenPercent(hits: Map<string, number>, keys: KeyConfig[], label: string): void {
  const rows = keys.map((k) => {
    const n = hits.get(k.keyId) ?? 0;
    return `${k.keyId}(${k.upstreamId})=${n} (${((n / ROUNDS) * 100).toFixed(1)}%)`;
  });
  const min = Math.min(...keys.map((k) => hits.get(k.keyId) ?? 0));
  assert.ok(
    min / ROUNDS >= MIN_SHARE,
    `${label}：验收 §九.1 要求每把健康 key 出量 ≥10%，实际最低 ${min}/${ROUNDS} —— [${rows.join('  ')}]`,
  );
}

describe('验收 §九.1：路由轮询出量分布（ADR-0011）', () => {
  it('A：balance / 余额未知 —— 6 把 key 全平（旧排序为 100/0/0/0/0/0）', async () => {
    const keys = [
      key('k1', 'up1'), key('k2', 'up1'), key('k3', 'up1'),
      key('k4', 'up2'), key('k5', 'up2'), key('k6', 'up2'),
    ];
    const hits = await pollDistribution(keys);
    assertEveryKeyAtLeastTenPercent(hits, keys, 'A 余额未知');
    assert.equal(hits.size, 6, '6 把 key 全部参与出量，不许有 key 饿死');
  });

  it('B：balance / 余额互不相同 —— 余额高低不得决定垄断（旧排序 k1=100%，最低 0）', async () => {
    const keys = [
      key('k1', 'up1', { balanceCents: 10_000 }), key('k2', 'up1', { balanceCents: 9_000 }), key('k3', 'up1', { balanceCents: 8_000 }),
      key('k4', 'up2', { balanceCents: 7_000 }), key('k5', 'up2', { balanceCents: 6_000 }), key('k6', 'up2', { balanceCents: 5_000 }),
    ];
    const hits = await pollDistribution(keys);
    assertEveryKeyAtLeastTenPercent(hits, keys, 'B 余额互不相同');
    assert.equal(hits.size, 6);
    // 余额最高（10_000）的 k1 不得拿到过半流量 —— 垄断即失败，哪怕其余 key 也过了 10%
    const top = Math.max(...keys.map((k) => hits.get(k.keyId) ?? 0));
    assert.ok(top <= ROUNDS / 2, `余额最高者不得垄断流量（实际 ${top}/${ROUNDS}）`);
  });

  it('C：token-plan / 余量相等 —— 乐观扣减天然轮转，不得回退', async () => {
    const keys = [
      key('k1', 'up1', { category: 'token-plan', tokenPlanRemainingTokens: 1_000_000 }),
      key('k2', 'up1', { category: 'token-plan', tokenPlanRemainingTokens: 1_000_000 }),
      key('k3', 'up1', { category: 'token-plan', tokenPlanRemainingTokens: 1_000_000 }),
      key('k4', 'up2', { category: 'token-plan', tokenPlanRemainingTokens: 1_000_000 }),
      key('k5', 'up2', { category: 'token-plan', tokenPlanRemainingTokens: 1_000_000 }),
      key('k6', 'up2', { category: 'token-plan', tokenPlanRemainingTokens: 1_000_000 }),
    ];
    const hits = await pollDistribution(keys);
    assertEveryKeyAtLeastTenPercent(hits, keys, 'C token-plan');
    assert.equal(hits.size, 6);
  });

  it('isUsable 的可用性过滤不被本次改动放松：余额 0 / 过期仍排除', async () => {
    const keys = [
      key('ok', 'up1'),
      key('zero', 'up1', { balanceCents: 0 }),
      key('expired', 'up1', { category: 'token-plan', tokenPlanRemainingTokens: 100, tokenPlanExpiresAt: '2020-01-01T00:00:00Z' }),
    ];
    const hits = await pollDistribution(keys);
    assert.ok(!hits.has('zero'), '余额为 0 的 key 必须保持排除（ADR-0011 只动排序，不动过滤）');
    assert.ok(!hits.has('expired'), '过期 key 必须保持排除');
    assert.deepEqual([...hits.keys()], ['ok']);
  });
});
