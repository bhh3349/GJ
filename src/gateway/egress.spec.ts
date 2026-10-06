/**
 * 出口级（IP 级）限流单测
 * 依据：docs/api-contract.md §16.7 / docs/adr/0020-egress-ip-rate-limit.md
 *
 * 本文件盯死 §16.7 的三条归因纪律，每一条都对应一个"不写就会静默做错"的地方：
 *   1. IP 级 429 **不计任何 key 的健康** —— 记了就是"把好 key 停掉"
 *   2. 冷却对象在**出口**上，且**冷却期内不换 key** —— 同出口轮换是放大器不是容错
 *   3. 冷却期内的终态是 **429 + Retry-After**，不是 503 NO_AVAILABLE_KEY
 *      （候选被出口冷却滤光，与"池里一把都没有"在客户端眼里必须可区分）
 *
 * 另有一条**不许漂移**的回归：识别器为默认（恒 false）时，行为与改动前逐字节相同 ——
 * 识别规则是 ADR-0020 决策 4 的悬空件，未定时不得让新通道自己加戏。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { egressLimitedOnSecondKey, neverEgressLimited } from './classify.js';
import { createEgressCooldown, egressHostOf, retryAfterSecOf } from './egress.js';
import { createGatewayEngine } from './engine.js';
import type { FetchLike, ForwardResult } from './engine.js';
import { createKeyPool } from './key-pool.js';
import type { KeyPoolInternal } from './key-pool.js';
import type { GroupContext, ModelCatalog, SecretResolver, UpstreamTarget } from './ports.js';
import type { KeyConfig, PoolSnapshot } from './types.js';

/* ------------------------------ 测试台 ------------------------------ */

let clock = 1_700_000_000_000;
const now = (): number => clock;

const GROUP: GroupContext = { groupId: 'grp_1', name: '测试组', enabled: true, rpm: null, tpm: null, dailyQuota: null };
const REQUEST_ID = 'req-egress-spec-0001';

function keyConfig(keyId: string, upstreamId = 'up1', over: Partial<KeyConfig> = {}): KeyConfig {
  return {
    keyId,
    upstreamId,
    category: 'balance',
    status: 'enabled',
    weight: 1,
    models: null,
    balanceCents: 10_000,
    tokenPlanRemainingTokens: null,
    tokenPlanExpiresAt: null,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

type Script = (url: string, init: RequestInit) => Response | Promise<Response>;

function scriptedFetch(steps: Script[]): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url);
    const step = steps[index];
    index += 1;
    if (step === undefined) throw new Error(`unexpected fetch call #${index} to ${url}`);
    return step(url, init);
  };
  return { fetchImpl, calls };
}

function makeHarness(options: {
  keys: KeyConfig[];
  steps: Script[];
  detector?: typeof neverEgressLimited;
  egress?: ReturnType<typeof createEgressCooldown>;
  /** 覆盖池（测「候选非空但 beginAttempt 拒绝」这类竞态形状时用桩池，见 engine.spec.ts） */
  pool?: KeyPoolInternal;
}) {
  clock = 1_700_000_000_000;
  const keys = options.keys;
  const pool: KeyPoolInternal = options.pool ?? createKeyPool({ now });
  if (options.pool === undefined) {
    const upstreams: PoolSnapshot['upstreams'] = [{ upstreamId: 'up1', enabled: true, models: null }];
    pool.applySnapshot({ revision: 1, upstreams, keys });
  }

  const secrets: SecretResolver = {
    resolve: (keyId) => {
      const found = keys.find((k) => k.keyId === keyId);
      if (found === undefined) return null;
      const target: UpstreamTarget = { upstreamId: found.upstreamId, baseUrl: `https://${found.upstreamId}.example.com/v1`, apiKey: `sk-${keyId}` };
      return target;
    },
  };
  const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };

  const egress = options.egress ?? createEgressCooldown({ now });
  const { fetchImpl, calls } = scriptedFetch(options.steps);
  const engine = createGatewayEngine({
    pool,
    secrets,
    models,
    fetchImpl,
    now,
    egress,
    egressLimitDetector: options.detector ?? neverEgressLimited,
  });

  return { pool, engine, calls, egress };
}

function chatBody(): Record<string, unknown> {
  return { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
}

async function call(h: ReturnType<typeof makeHarness>): Promise<Extract<ForwardResult, { kind: 'error' }>> {
  const result = (await h.engine.chatCompletions({
    group: GROUP,
    model: 'gpt-4o-mini',
    body: chatBody(),
    stream: false,
    requestId: REQUEST_ID,
  })) as ForwardResult;
  assert.equal(result.kind, 'error', '本组用例都期望终态是错误');
  return result as Extract<ForwardResult, { kind: 'error' }>;
}

function runtimeOf(pool: KeyPoolInternal, keyId: string) {
  const rt = pool.view().find((r) => r.keyId === keyId);
  assert.ok(rt !== undefined, `key ${keyId} 不在运行态里`);
  return rt;
}

const EGRESS_429 = (): Response => jsonResponse({ error: { message: 'too many requests from your client ip' } }, 429);
const OK = (): Response => jsonResponse({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

/* ------------------------------ 出口标识 ------------------------------ */

describe('egressHostOf', () => {
  it('取 host（含端口）并小写归一', () => {
    assert.equal(egressHostOf('https://API.Example.com/v1'), 'api.example.com');
    assert.equal(egressHostOf('https://tierflow.cn:8443/v1'), 'tierflow.cn:8443');
  });

  it('解析不出 host → null（宁可退回旧的 key 级处置，也不拿假出口去冷掉别的上游）', () => {
    assert.equal(egressHostOf(''), null);
    assert.equal(egressHostOf('not a url'), null);
    assert.equal(egressHostOf('/v1'), null);
  });
});

/* ------------------------------ 冷却表 ------------------------------ */

describe('createEgressCooldown', () => {
  it('未冷却时只读不产生状态', () => {
    const egress = createEgressCooldown({ now });
    assert.equal(egress.isCooling('a.example.com'), false);
    assert.equal(egress.remainingMs('a.example.com'), 0);
    egress.clear();
    assert.equal(egress.isCooling('a.example.com'), false);
  });

  it('无 Retry-After → 60s 起；连续命中按阶梯升档、30min 封顶', () => {
    const egress = createEgressCooldown({ now });

    egress.cool('a.example.com');
    assert.equal(egress.remainingMs('a.example.com'), 60_000, '首档 = RATE_LIMITED 基础冷却 60s');

    clock += 60_000;
    egress.cool('a.example.com');
    assert.equal(egress.remainingMs('a.example.com'), 60_000, '第二档 1m');

    clock += 60_000;
    egress.cool('a.example.com');
    assert.equal(egress.remainingMs('a.example.com'), 5 * 60_000, '第三档 5m');

    clock += 5 * 60_000;
    egress.cool('a.example.com');
    assert.equal(egress.remainingMs('a.example.com'), 15 * 60_000, '第四档 15m');

    clock += 15 * 60_000;
    egress.cool('a.example.com');
    assert.equal(egress.remainingMs('a.example.com'), 30 * 60_000, '第五档封顶 30min');

    clock += 30 * 60_000;
    egress.cool('a.example.com');
    assert.equal(egress.remainingMs('a.example.com'), 30 * 60_000, '已到封顶档，不再往上爬');
  });

  it('尊重上游 Retry-After（§16.7）：更长的一律照收', () => {
    const egress = createEgressCooldown({ now });
    egress.cool('a.example.com', 120_000);
    assert.equal(egress.remainingMs('a.example.com'), 120_000);
  });

  it('短于 60s 的 Retry-After 会被**抬到 60s**（沿用 key 级冻结口径：宁可多等，不可早放）', () => {
    // 刻意复用 `cooldown.ts` 的 `reasonBaseCooldownMs`：RATE_LIMITED = max(Retry-After, 60s)。
    // 上游说 45s 就放行，我们仍冷 60s —— 方向是安全的那一侧，且与 key 级同一条口径，
    // 不在这里发明第二套算法。§16.7「尊重 Retry-After」按「不短于它」读。
    const egress = createEgressCooldown({ now });
    egress.cool('a.example.com', 45_000);
    assert.equal(egress.remainingMs('a.example.com'), 60_000);
  });

  it('已有更长的冷却不被缩短（并发的两次冷却取更远的那次）', () => {
    const egress = createEgressCooldown({ now });
    egress.cool('a.example.com', 300_000);
    egress.cool('a.example.com', 10_000);
    assert.equal(egress.remainingMs('a.example.com'), 300_000);
  });

  it('noteSuccess 清计数但**不清冷却窗口**（在途请求成功不该提前解开整出口的冷却）', () => {
    const egress = createEgressCooldown({ now });
    egress.cool('a.example.com');
    egress.noteSuccess('a.example.com');
    assert.equal(egress.isCooling('a.example.com'), true, '冷却窗口仍在');

    clock += 60_000;
    egress.cool('a.example.com');
    assert.equal(egress.remainingMs('a.example.com'), 60_000, '计数已归零 → 重新从 60s 起，不接着上一轮爬档');
  });

  it('出口之间互不牵连', () => {
    const egress = createEgressCooldown({ now });
    egress.cool('a.example.com');
    assert.equal(egress.isCooling('b.example.com'), false);
  });
});

/* ------------------------------ 快照读面（契约 v1.5.0 ②） ------------------------------ */

describe('createEgressCooldown().snapshot()', () => {
  it('`untilMs` 是**绝对时刻**：跨 tick 前进后，同一条冷却的 untilMs 逐字不变', () => {
    // 这条盯的是发帧指纹的稳定性。若实现返回"剩余量"，每 tick 都在变 ⇒ `sig` 永远算"变了"
    // ⇒ 每 tick 白推一帧（§7 要避免的正是这个噪声）。绝对时刻才让"自然到期"表现为一次跳变。
    const egress = createEgressCooldown({ now });
    const until = egress.cool('a.example.com', 300_000);

    const first = egress.snapshot();
    assert.equal(first.length, 1);
    assert.equal(first[0]?.untilMs, until, 'cool() 的返回值与快照的 untilMs 同一个数');

    clock += 120_000; // 三个 tick 之后
    const second = egress.snapshot();
    assert.equal(second[0]?.untilMs, until, '时钟前进 → untilMs 不动（剩余量才动）');
    assert.equal(egress.remainingMs('a.example.com'), 180_000, '剩余量确实在变 —— 但快照不受影响');
  });

  it('快照是**全量**：已过期条目仍在内（差分通道无墓碑，滤掉它 = 解除帧永不发出）', () => {
    // 冷却自然到期没有任何写入动作。若这里按 `untilMs > now` 过滤，到期那一刻该出口直接从
    // 本 tick 集合消失 ⇒ live.ts 只把它从 `seen` 删掉、不发帧 ⇒ 前端永远停在「出口限流中」。
    // 发帧侧按 `untilMs > now ? ISO8601 : null` 出字段，所以"过期仍在内"是解除帧的前提，不是冗余。
    const egress = createEgressCooldown({ now });
    egress.cool('a.example.com', 300_000);
    // 注意：冷却有 `max(Retry-After, 60s)` 地板（§16.7 裁定②），没有更短的档 ——
    // 所以"过期"用时钟前进到 60s 之后制造，而不是喂一个 10s 的 Retry-After。
    egress.cool('b.example.com');

    clock += 60_000; // b 恰好到期，a 仍在冷却
    const snap = egress.snapshot();

    assert.equal(snap.length, 2, '两条都在快照里，不因过期被滤掉');
    const a = snap.find((e) => e.host === 'a.example.com');
    const b = snap.find((e) => e.host === 'b.example.com');
    assert.ok(a !== undefined && b !== undefined);
    assert.equal(egress.isCooling('b.example.com'), false, 'b 确实不在冷却了');
    assert.ok(b.untilMs <= clock, 'b 在快照里的形状是"untilMs <= now"，不是缺席');
    assert.equal(egress.isCooling('a.example.com'), true, 'a 仍在冷却 —— 全量与"冷却中"并不互斥');

    // 从未冷却过的 host 不进快照（快照 = 该层记录过的出口，不是全部已知出口）
    assert.equal(snap.find((e) => e.host === 'never.example.com'), undefined);
  });

  it('只读、不产生状态：noteSuccess / 未知 host 都不会凭空长出条目，也不清 `until`', () => {
    const egress = createEgressCooldown({ now });
    egress.noteSuccess('ghost.example.com');
    egress.snapshot();
    assert.equal(egress.snapshot().length, 0, '只读面不落条目');

    egress.cool('a.example.com');
    const until = egress.snapshot()[0]?.untilMs;
    egress.noteSuccess('a.example.com');
    assert.equal(egress.snapshot()[0]?.untilMs, until, '成功只清连续计数，快照的 until 不动（与接口注释同口径）');

    const listed = egress.snapshot();
    const again = egress.snapshot();
    assert.deepEqual(again, listed, '两次快照内容一致：快照不消耗状态');
  });

  it('`clear()` 后快照归空（测试重置用；生产路径不 prune 过期条目）', () => {
    const egress = createEgressCooldown({ now });
    egress.cool('a.example.com');
    assert.equal(egress.snapshot().length, 1);
    egress.clear();
    assert.equal(egress.snapshot().length, 0);
  });
});

describe('retryAfterSecOf', () => {
  it('向上取整且至少 1s', () => {
    assert.equal(retryAfterSecOf(0), 1);
    assert.equal(retryAfterSecOf(1), 1);
    assert.equal(retryAfterSecOf(60_000), 60);
    assert.equal(retryAfterSecOf(60_001), 61);
  });
});

/* ------------------------------ 识别缝 ------------------------------ */

describe('识别器', () => {
  const input = (over: Partial<Parameters<typeof egressLimitedOnSecondKey>[0]> = {}) => ({
    status: 429,
    body: 'too many requests from your client ip',
    headers: new Headers(),
    egressHost: 'a.example.com',
    distinctKeysFailed429: 2,
    ...over,
  });

  it('默认恒 false —— 识别规则是悬空件，未定前不加戏', () => {
    assert.equal(neverEgressLimited(input()), false);
  });

  it('自证据：同一出口上第 2 把不同 key 也 429 才算出口级（不看任何文案）', () => {
    assert.equal(egressLimitedOnSecondKey(input({ distinctKeysFailed429: 1 })), false, '只有一把 key 429 → 仍是 key 级');
    assert.equal(egressLimitedOnSecondKey(input({ distinctKeysFailed429: 2 })), true);
    assert.equal(egressLimitedOnSecondKey(input({ status: 500 })), false, '只对 429 生效');
    assert.equal(egressLimitedOnSecondKey(input({ egressHost: null })), false, '出口未知 → 不判出口级');
  });
});

/* ------------------------------ 引擎接线 ------------------------------ */

describe('引擎：出口级 429 的归因上移（§16.7）', () => {
  it('第二把 key 也 429 → 归出口：不记该 key 健康、不换 key、回 429 + Retry-After', async () => {
    const h = makeHarness({ keys: [keyConfig('k1'), keyConfig('k2')], steps: [EGRESS_429, EGRESS_429], detector: egressLimitedOnSecondKey });

    const result = await call(h);

    assert.equal(result.error.httpStatus, 429);
    assert.equal(result.error.body.error.code, 'RATE_LIMITED', '§16.7：不新增错误码');
    assert.equal(result.error.body.error.type, 'rate_limit_error');
    assert.equal(result.error.retryAfterSec, 60, '出口冷却 60s 原样告诉客户端');

    assert.equal(h.calls.length, 2, '自证据要第二把 key 才能确认 —— 只打了两把，不是把候选轮光');

    // 归因纪律：确认出口级的那一把**不进冷却**；第一把在判明之前已按 key 级记过，这是自证据的固有代价
    assert.equal(runtimeOf(h.pool, 'k2').cooldownUntil, null, '判明出口级的那把 key 不得被记账');
    assert.notEqual(runtimeOf(h.pool, 'k1').cooldownUntil, null, '第一把在判明前已按 key 级记过（自证据的固有代价，非缺陷）');
  });

  it('冷却期内连一把都不试：0 次上游请求，仍回 429 + Retry-After', async () => {
    const egress = createEgressCooldown({ now });
    const h = makeHarness({ keys: [keyConfig('k1'), keyConfig('k2')], steps: [], detector: egressLimitedOnSecondKey, egress });
    const host = egressHostOf('https://up1.example.com/v1');
    assert.ok(host !== null);
    egress.cool(host, 120_000);

    const result = await call(h);

    assert.equal(h.calls.length, 0, '冷却期内不发任何上游请求 —— 同出口轮换必然再撞');
    assert.equal(result.error.httpStatus, 429);
    assert.equal(result.error.retryAfterSec, 120, 'Retry-After = 出口剩余冷却');
    assert.equal(runtimeOf(h.pool, 'k1').cooldownUntil, null, '0 次真实尝试 → 不计 key 健康');
  });

  it('候选被出口冷却滤光时终态是 429，**不是** 503 NO_AVAILABLE_KEY', async () => {
    const egress = createEgressCooldown({ now });
    const h = makeHarness({ keys: [keyConfig('k1'), keyConfig('k2')], steps: [], detector: egressLimitedOnSecondKey, egress });
    const host = egressHostOf('https://up1.example.com/v1');
    assert.ok(host !== null);
    egress.cool(host);

    const result = await call(h);

    assert.notEqual(result.error.httpStatus, 503, '503 是"池里一把都没有"的稳定出口，用在这里会把可重试说成别重试');
    assert.equal(result.error.body.error.code, 'RATE_LIMITED');
  });

  it('出口冷却不牵连**别的出口**：另一出口的候选照常顶上', async () => {
    const egress = createEgressCooldown({ now });
    // up1 冷却；k2 在 up2 上（不同 host）→ 应当被正常使用并返回 200
    const pool: KeyPoolInternal = createKeyPool({ now });
    pool.applySnapshot({
      revision: 1,
      upstreams: [
        { upstreamId: 'up1', enabled: true, models: null },
        { upstreamId: 'up2', enabled: true, models: null },
      ],
      keys: [keyConfig('k1', 'up1'), keyConfig('k2', 'up2')],
    });
    const secrets: SecretResolver = {
      resolve: (keyId) => {
        const up = keyId === 'k1' ? 'up1' : 'up2';
        return { upstreamId: up, baseUrl: `https://${up}.example.com/v1`, apiKey: `sk-${keyId}` };
      },
    };
    const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };
    const { fetchImpl, calls } = scriptedFetch([OK]);
    const engine = createGatewayEngine({ pool, secrets, models, fetchImpl, now, egress, egressLimitDetector: egressLimitedOnSecondKey });

    const host = egressHostOf('https://up1.example.com/v1');
    assert.ok(host !== null);
    egress.cool(host);

    const result = (await engine.chatCompletions({
      group: GROUP,
      model: 'gpt-4o-mini',
      body: chatBody(),
      stream: false,
      requestId: REQUEST_ID,
    })) as ForwardResult;

    assert.equal(calls.length, 1, 'up1 被跳过，只打 up2 那一次');
    assert.equal(calls[0], 'https://up2.example.com/v1/chat/completions');
    assert.equal(result.kind, 'json');
  });
});

describe('引擎：识别器为默认时行为零漂移', () => {
  it('429 仍按 key 级处置并换下一把（既有口径，ADR-0020 决策 4 未定前的唯一行为）', async () => {
    const h = makeHarness({ keys: [keyConfig('k1'), keyConfig('k2')], steps: [EGRESS_429, OK] });

    const result = (await h.engine.chatCompletions({
      group: GROUP,
      model: 'gpt-4o-mini',
      body: chatBody(),
      stream: false,
      requestId: REQUEST_ID,
    })) as ForwardResult;

    assert.equal(result.kind, 'json', '换一把能救 → 客户端 200');
    assert.equal(h.calls.length, 2);
    assert.notEqual(runtimeOf(h.pool, 'k1').cooldownUntil, null, 'k1 按 RATE_LIMITED 记冷却（改动前的行为）');
  });

  it('池饱和仍回 429 且 Retry-After 恒为 1s（分型未被出口级分支改动）', async () => {
    // 真实池的 isUsable 会把满并发的 key 挡在候选外（→ 候选空 → 503），
    // 「候选非空但 beginAttempt 拒绝」只在并发竞态里出现，所以这里用桩池把该形状喂给引擎。
    const candidates = [{ keyId: 'k1', upstreamId: 'up1', category: 'balance' as const, weight: 1 }];
    const stub: KeyPoolInternal = {
      getAvailableKeys: async () => candidates,
      reportFailure: () => undefined,
      reportSuccess: () => undefined,
      applySnapshot: () => undefined,
      beginAttempt: () => false,
      endAttempt: () => undefined,
      view: () => [
        {
          keyId: 'k1',
          failCount: 0,
          consecutiveFails: 0,
          cooldownUntil: null,
          lastFailureAt: null,
          lastFailureReason: null,
          lastLatencyMs: null,
          inflight: 0,
        },
      ],
    };
    const h = makeHarness({ keys: [keyConfig('k1')], steps: [], pool: stub });

    const result = await call(h);

    assert.equal(result.error.httpStatus, 429);
    assert.equal(result.error.retryAfterSec, 1, '饱和走短退避 1s，未被出口级分支改动');
    assert.equal(h.calls.length, 0);
  });
});
