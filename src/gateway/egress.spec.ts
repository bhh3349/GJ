/**
 * 出口（IP 级）预算闸 / 冷却态 / 归因判据 单测
 * 依据：docs/adr/0021-egress-budget-seam.md（决策 2/3/5/8/10）+ docs/api-contract.md §16.7
 *
 * 本文件盯死四类「不写就会静默做错」的地方：
 *   1. **桶拒绝不写冷却、不推进阶梯**（决策 5 表内第 2 行）：额度是我们自己算出来的账，
 *      顺手 `cool()` 会在几十毫秒内爬满封顶档 —— 验证 9 的自伤回归。
 *   2. **归因判据只此一处**（决策 4a / 验证 7）：判据数的是「同一出口 60s 滑动窗内 ≥3 个**不同账号**」，
 *      本地 reject 与 key 级失败都不得混进来（否则一个被打空预算的出口会拿自己拒出来的脸冷掉自己）。
 *   3. **`snapshot()` 全量、绝对时刻、含已过期、且**预算桶不进这张表（契约 v1.5.0 ② / 决策 3）。
 *   4. **默认 shadow = 行为零漂移**（决策 7 / 10(6)）：判据照常扫窗、照常产记录，但恒回 `'key'`。
 *
 * 另外两张**不许漂移**的锁：
 *   · 出口标识归一化已并轨到端口（`egressIdOfUrl`）—— 原 `egressHostOf` 的 fixture 表整张迁到这里，
 *     外加一条源码扫描锁：`src/gateway/` 下**不得再出现** `new URL(`（同语义第二份实现的老路）。
 *   · 引擎读的是**台账给的稳定 id**（`target.egressId`，段二起）：Tier 1 = 归一化 host、
 *     Tier 2 = `egress_proxies.id`。引擎**不再**从 `baseUrl` 推导，**也不得重做归一化**
 *     （拿稳定 id 去 `egressIdOfUrl` 会恒得 `null` ⇒ 出口被整个丢掉 = 「一个出口零个桶 ⇒ 无上限」）。
 *     批一的 fixture 仍按 `egressIdOfUrl(baseUrl)` 填 tier-1 形状，故那批用例换读后逐字不变；
 *     Tier-2 形状（稳定 id ≠ host）另有一组用例，见「出口 id 由台账给」。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { egressIdOfUrl, retryAfterSecOf } from '../egress/port.js';
import type { EgressGate, EgressShadowRecord } from '../egress/port.js';
import { EGRESS_LOCAL_HEADER } from '../egress/port.js';
import { EGRESS_BUDGET_PLACEHOLDER, createEgressGate } from './egress.js';
import { createGatewayEngine } from './engine.js';
import type { AttemptEvent, FetchLike, ForwardResult } from './engine.js';
import { createKeyPool } from './key-pool.js';
import type { KeyPoolInternal } from './key-pool.js';
import type { GroupContext, ModelCatalog, SecretResolver, UpstreamTarget } from './ports.js';
import type { KeyConfig, PoolSnapshot } from './types.js';

/* ------------------------------ 测试台 ------------------------------ */

let clock = 1_700_000_000_000;
const now = (): number => clock;

/** 一 tick = 1ms；滑动窗证据全靠它 */
const tick = (ms: number): void => {
  clock += ms;
};

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

interface HarnessOptions {
  keys: KeyConfig[];
  steps: Script[];
  /** keyId → accountId（`undefined` 视为无主 key ⇒ `null`）。归因判据按它去重 */
  accounts?: Record<string, string>;
  /** upstreamId → baseUrl 覆写（测等价写法收敛时用） */
  baseUrls?: Record<string, string>;
  /**
   * upstreamId → 台账给的出口 id（`UpstreamTarget.egressId`）。**不填 = Tier 1 形状**
   * （`egressIdOfUrl(baseUrl)`）；填了才是 Tier 2：稳定 id 与 host 解耦，两者**不再相等**。
   * 显式 `null` 用来喂 fail-open 那一支（未绑出口）。
   */
  egressIds?: Record<string, string | null>;
  gate?: EgressGate;
  /** 覆盖池（测「候选非空但 beginAttempt 拒绝」这类竞态形状时用桩池，见 engine.spec.ts） */
  pool?: KeyPoolInternal;
  /** 逐次尝试事件（判「有没有产假失败行」「轮换有没有终止」用） */
  attempts?: AttemptEvent[];
}

function makeHarness(options: HarnessOptions) {
  clock = 1_700_000_000_000;
  const keys = options.keys;
  const pool: KeyPoolInternal = options.pool ?? createKeyPool({ now });
  if (options.pool === undefined) {
    const upstreams: PoolSnapshot['upstreams'] = [{ upstreamId: 'up1', enabled: true, models: null }];
    pool.applySnapshot({ revision: 1, upstreams, keys });
  }

  const baseUrlOf = (upstreamId: string): string => options.baseUrls?.[upstreamId] ?? `https://${upstreamId}.example.com/v1`;

  const secrets: SecretResolver = {
    resolve: (keyId) => {
      const found = keys.find((k) => k.keyId === keyId);
      if (found === undefined) return null;
      const baseUrl = baseUrlOf(found.upstreamId);
      const override = options.egressIds?.[found.upstreamId];
      const target: UpstreamTarget = {
        upstreamId: found.upstreamId,
        baseUrl,
        apiKey: `sk-${keyId}`,
        // 出口 id **由台账给**（段二起引擎只读这一列）。`egressIds` 未覆盖时按 Tier 1 形状填
        // `egressIdOfUrl(baseUrl)` —— 于是批一那批用例换读前后逐字不变（桩与真实
        // `src/wiring/secrets.ts` 同形：那一层算一次，热路径只读）。
        egressId: override === undefined ? egressIdOfUrl(baseUrl) : override,
        accountId: options.accounts?.[keyId] ?? null,
      };
      return target;
    },
  };
  const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };

  const gate = options.gate ?? createEgressGate({ now });
  const { fetchImpl, calls } = scriptedFetch(options.steps);
  const engine = createGatewayEngine({
    pool,
    secrets,
    models,
    fetchImpl,
    now,
    egress: gate,
    ...(options.attempts === undefined ? {} : { onAttempt: (e) => options.attempts?.push(e) }),
  });

  return { pool, engine, calls, gate };
}

/** 一次调用记录下的出站请求（判「一个字节都没发」与「标记头没上行」用） */
interface Outbound {
  url: string;
  headers: Record<string, string>;
}

/** 与 `scriptedFetch` 同形，但留下 `init.headers` —— 只看 url 判不了"没上行标记头" */
function capturingFetch(steps: Script[]): { fetchImpl: FetchLike; calls: Outbound[] } {
  const calls: Outbound[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...((init.headers ?? {}) as Record<string, string>) } });
    const step = steps[index];
    index += 1;
    if (step === undefined) throw new Error(`unexpected fetch call #${index} to ${url}`);
    return step(url, init);
  };
  return { fetchImpl, calls };
}

function chatBody(): Record<string, unknown> {
  return { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
}

async function run(h: ReturnType<typeof makeHarness>): Promise<ForwardResult> {
  return (await h.engine.chatCompletions({
    group: GROUP,
    model: 'gpt-4o-mini',
    body: chatBody(),
    stream: false,
    requestId: REQUEST_ID,
  })) as ForwardResult;
}

async function call(h: ReturnType<typeof makeHarness>): Promise<Extract<ForwardResult, { kind: 'error' }>> {
  const result = await run(h);
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

/** 归因判据的最小输入（`subject.keyId` 只在足迹位，不进计数） */
function limited(egressId: string, accountId: string | null, keyId = `k-${accountId ?? 'none'}`) {
  return { egressId, correlationId: 'req-x', subject: { accountId, keyId } };
}

/* ------------------------------ 出口标识：并轨锁 ------------------------------ */

describe('egressIdOfUrl（原 egressHostOf fixture 表整张迁来）', () => {
  it('取 host（含端口）并小写归一 —— 等价写法收敛成同一个桶（验证 16）', () => {
    assert.equal(egressIdOfUrl('https://API.Example.com/v1'), 'api.example.com');
    assert.equal(egressIdOfUrl('https://tierflow.cn:8443/v1'), 'tierflow.cn:8443');
    // 同一个出口的四种写法必须落进同一个桶，否则限流按写法分裂成多份（等于没限）
    assert.equal(egressIdOfUrl('https://api.example.com/v1'), 'api.example.com');
    assert.equal(egressIdOfUrl('https://api.example.com:443/v1/chat'), 'api.example.com', '默认端口被 URL 收敛掉');
    assert.equal(egressIdOfUrl('https://api.example.com'), 'api.example.com', '尾斜杠/无路径同形');
    assert.equal(egressIdOfUrl('https://api.example.com/v1?x=1'), 'api.example.com', 'query 不进 host');
  });

  it('解析不出 host → null（fail-open：宁可退回旧的 key 级处置，也不拿假出口去冷掉别的上游）', () => {
    assert.equal(egressIdOfUrl(''), null);
    assert.equal(egressIdOfUrl('not a url'), null);
    assert.equal(egressIdOfUrl('/v1'), null);
  });

  it('并轨回归锁：`src/gateway/` 下不得再出现第二份归一化（`new URL(`）', () => {
    // 本文件替换掉的 `egressHostOf` 正是「同语义两份实现」的老路：两份一旦对
    // 「默认端口 / 大小写 / 尾斜杠」有任何一处读法不同，症状是**限流按写法分裂**（等于没限）。
    // 归一化只许在 `src/egress/port.ts` 一处；这里对整条网关车道做源码扫描锁死。
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const offenders: string[] = [];
    for (const entry of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
      const source = readFileSync(join(dir, entry), 'utf8');
      if (source.includes('new URL(')) offenders.push(entry);
    }
    assert.deepEqual(offenders, [], '出口归一化已并轨到 ../egress/port.js，本地不得再解析 URL');
    // 两条消费路径都得从端口 import（改了实现而调用方抄一份，就是并轨破裂的开始）
    assert.ok(readFileSync(join(dir, 'engine.ts'), 'utf8').includes("'../egress/port.js'"));
    assert.ok(readFileSync(join(dir, 'egress.ts'), 'utf8').includes("'../egress/port.js'"));
  });

  it('生产装配锁：`src/server.ts` 造一次、同一个实例注入两处（决策 4c）', () => {
    // "一个进程一份"没法靠单测的运行期断言来判 —— `src/server.ts` 的 `main()` 一 import 就跑。
    // 于是退到源码面：**这一处只许有一次 `createEgressGate(` 调用**，且同一个标识符同时交给
    // 两条车道。造两份不是性能问题而是正确性问题 —— 上游按**来源 IP** 计数，
    // 两侧各扣各的 = 各自以为还有额度；而症状只表现为"闸不怎么拦"，没有任何报错。
    const source = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');
    assert.equal((source.match(/createEgressGate\(/g) ?? []).length, 1, '闸只许造一次');
    // 两个对象字面量都是扁的，`[^}]` 够用（跨到下一个 `}` 之前必须出现 `egress`）
    assert.match(source, /createGatewayRuntime\(\{[^}]*\begress\b[^}]*\}\)/, '数据面（网关装配）拿到它');
    assert.match(source, /buildApp\(\{[^}]*\begress\b[^}]*\}\)/, '管理面（`ApiContext.egress`）拿到的是同一个变量');
    assert.match(source, /EGRESS_BUDGET_PLACEHOLDER/, '预算值引用端口那一份，不在这里抄数字（标定只改一处）');
    assert.match(source, /mode:\s*'active'/, '⑧ 转正：判据真正启用，接线层显式注入 active（PM 裁定 1）');
  });
});

/* ------------------------------ 预算桶（决策 8） ------------------------------ */

describe('reserve：逐出口令牌桶 + 数据面保留额', () => {
  const budget = { capacity: 5, windowMs: 60_000, reserveForData: 1 };

  it('同一出口连取 capacity 枚后即被拒，`retryAfterMs` = 最早那枚滑出窗口的时刻（滑动，非整窗重来）', () => {
    const gate = createEgressGate({ now, budget });
    for (let i = 0; i < 5; i += 1) assert.deepEqual(gate.reserve('a.example.com', 'data'), { allowed: true });

    const denied = gate.reserve('a.example.com', 'data');
    assert.equal(denied.allowed, false);
    assert.equal(denied.allowed === false ? denied.reason : null, 'budget');
    assert.equal(denied.allowed === false ? denied.retryAfterMs : 0, 60_000, '等最早那枚滑出，不是等满一整窗');

    // 半程仍被拒（滑动窗）：到 59s 为止一枚都还没滑出
    tick(59_000);
    assert.equal(gate.reserve('a.example.com', 'data').allowed, false);

    // 到 60s + 1ms，五枚全滑出 → 恢复
    tick(1_001);
    assert.equal(gate.reserve('a.example.com', 'data').allowed, true);
  });

  it('保留额（决策 8）：管理面只吃 `capacity − reserveForData`，数据面永远留着那一枚', () => {
    const gate = createEgressGate({ now, budget });
    for (let i = 0; i < 4; i += 1) assert.equal(gate.reserve('a.example.com', 'management').allowed, true);

    // 管理面第 5 枚被拒 —— 此刻"剩余 1" 正是留给数据面的
    const denied = gate.reserve('a.example.com', 'management');
    assert.equal(denied.allowed, false);
    // 同一张账：数据面仍能取走那一枚（两者之和 = capacity，不是两张配额表）
    assert.equal(gate.reserve('a.example.com', 'data').allowed, true);
    assert.equal(gate.reserve('a.example.com', 'data').allowed, false, '取完恰好到 capacity');
  });

  it('出口之间独立记账（验证 16）：一个出口打满不影响另一个', () => {
    const gate = createEgressGate({ now, budget });
    for (let i = 0; i < 5; i += 1) gate.reserve('a.example.com', 'data');
    assert.equal(gate.reserve('a.example.com', 'data').allowed, false);
    assert.equal(gate.reserve('b.example.com', 'data').allowed, true);
  });

  it('冷却优先于桶（决策 3）：出口在冷却中 ⇒ 即便桶里有余额也拒，且理由是 `cooldown`', () => {
    const gate = createEgressGate({ now, mode: 'active' });
    for (const accountId of ['acc-1', 'acc-2', 'acc-3']) gate.observeLimited(limited('a.example.com', accountId));

    const denied = gate.reserve('a.example.com', 'data');
    assert.equal(denied.allowed, false);
    assert.equal(denied.allowed === false ? denied.reason : null, 'cooldown');
    assert.equal(denied.allowed === false ? denied.retryAfterMs : 0, 60_000);
  });

  it('同步签名（验证 13）：`reserve` / `observeLimited` 都不返回 thenable', () => {
    const gate = createEgressGate({ now, budget });
    const r = gate.reserve('a.example.com', 'data');
    assert.equal((r as { then?: unknown }).then, undefined);
    const v = gate.observeLimited(limited('a.example.com', 'acc-1'));
    assert.equal((v as { then?: unknown }).then, undefined);
  });

  it('构造参数 fail-fast：容量/窗口/保留额/N 明显写错时当场抛，不静默按 0 跑', () => {
    assert.throws(() => createEgressGate({ now, budget: { capacity: 0, windowMs: 60_000, reserveForData: 0 } }));
    assert.throws(() => createEgressGate({ now, budget: { capacity: 5, windowMs: 0, reserveForData: 0 } }));
    assert.throws(() => createEgressGate({ now, budget: { capacity: 2, windowMs: 60_000, reserveForData: 3 } }));
    // N=1 = 「裸 429 即判出口」（决策 10 已否掉的形态）
    assert.throws(() => createEgressGate({ now, distinctAccounts: 1 }));
  });

  it('占位数值锁（决策 8）：PM 已裁定写死，标定回来只改数、不改结构', () => {
    assert.deepEqual(EGRESS_BUDGET_PLACEHOLDER, { capacity: 5, windowMs: 60_000, reserveForData: 1 });
  });
});

/* ------------------------------ 归因判据（决策 10） ------------------------------ */

describe('observeLimited：跨账号相关性', () => {
  const gate = (over: Parameters<typeof createEgressGate>[0] = {}) => createEgressGate({ now, mode: 'active', ...over });

  it('第 1/2 个账号仍判 key 级；第 3 个不同账号才判出口级（N=3 初值）', () => {
    const g = gate();
    assert.deepEqual(g.observeLimited(limited('a.example.com', 'acc-1')), { attribution: 'key', cooldownUntilMs: null });
    assert.deepEqual(g.observeLimited(limited('a.example.com', 'acc-2')), { attribution: 'key', cooldownUntilMs: null });

    const third = g.observeLimited(limited('a.example.com', 'acc-3'));
    assert.equal(third.attribution, 'egress');
    assert.equal(third.cooldownUntilMs, clock + 60_000, '首次命中只第一档（决策 10(4)）');
    assert.equal(g.cooldownUntil('a.example.com'), clock + 60_000);
    // 别的出口一概不受影响
    assert.equal(g.cooldownUntil('b.example.com'), null);
  });

  it('判据按**账号**去重：同一账号 5 把 key 全挂也只算 1 个账号', () => {
    const g = gate();
    for (let i = 0; i < 5; i += 1) {
      assert.equal(g.observeLimited(limited('a.example.com', 'acc-1', `k-${i}`)).attribution, 'key');
    }
    assert.equal(g.cooldownUntil('a.example.com'), null, '5 把 key 不等于 5 个账号');
  });

  it('`accountId === null`（无主 key）贡献 0：两把无主 key 不得凑出 1 个账号', () => {
    const g = gate();
    assert.equal(g.observeLimited(limited('a.example.com', null, 'k-1')).attribution, 'key');
    assert.equal(g.observeLimited(limited('a.example.com', null, 'k-2')).attribution, 'key');
    assert.equal(g.cooldownUntil('a.example.com'), null);
  });

  it('窗口是**滑动**不是翻滚：`t0` 的账号在 `t0+60s` 之后不再计入', () => {
    const g = gate();
    g.observeLimited(limited('a.example.com', 'acc-1')); // t0
    tick(30_000);
    g.observeLimited(limited('a.example.com', 'acc-2')); // t0+30s
    tick(31_000); // t0+61s：acc-1 已滑出，acc-2 还在
    assert.equal(g.observeLimited(limited('a.example.com', 'acc-3')).attribution, 'key', '此刻窗内只有 acc-2/acc-3');
    // t0+61s 起算，acc-2 仍在窗内（t0+30s > t0+1s）⇒ 再补一个账号即命中
    assert.equal(g.observeLimited(limited('a.example.com', 'acc-4')).attribution, 'egress');
  });

  it('连续命中不重复推进阶梯（决策 10(4)：「首次命中只第一档」）', () => {
    const g = gate();
    for (const accountId of ['acc-1', 'acc-2', 'acc-3']) g.observeLimited(limited('a.example.com', accountId));
    const first = g.cooldownUntil('a.example.com');

    // 冷却期内再来一轮（4/5/6 号账号）：仍判出口级（结论不变），但**不**把阶梯再往上顶一档
    tick(1_000);
    const again = g.observeLimited(limited('a.example.com', 'acc-4'));
    assert.equal(again.attribution, 'egress');
    assert.equal(again.cooldownUntilMs, first, '不缩短、也不延长 —— 一轮冷却只推一档');
    assert.equal(g.cooldownUntil('a.example.com'), first);
  });

  it('尊重上游 Retry-After（§16.7）：更长的一律照收；短于 60s 的抬到 60s', () => {
    const withRetryAfter = (retryAfterMs: number) => {
      const g = gate();
      g.observeLimited(limited('a.example.com', 'acc-1'));
      g.observeLimited(limited('a.example.com', 'acc-2'));
      g.observeLimited({ ...limited('a.example.com', 'acc-3'), retryAfterMs });
      return g;
    };

    assert.equal(withRetryAfter(120_000).cooldownUntil('a.example.com'), clock + 120_000);
    assert.equal(
      withRetryAfter(45_000).cooldownUntil('a.example.com'),
      clock + 60_000,
      '宁可多等，不可早放（与 key 级同一口径）',
    );
  });

  it('observeSuccess 清连续计数，但**不清归因窗、也不解冷却**', () => {
    const g = gate();
    for (const accountId of ['acc-1', 'acc-2', 'acc-3']) g.observeLimited(limited('a.example.com', accountId));
    const until = g.cooldownUntil('a.example.com');

    g.observeSuccess('a.example.com');
    assert.equal(g.cooldownUntil('a.example.com'), until, '在途请求成功不该提前解开整出口的冷却');

    tick(60_000); // 冷却自然到期，连续计数已被成功清零 → 下一轮重新从 60s 起
    assert.equal(g.cooldownUntil('a.example.com'), null);
    for (const accountId of ['acc-4', 'acc-5', 'acc-6']) g.observeLimited(limited('a.example.com', accountId));
    assert.equal(g.cooldownUntil('a.example.com'), clock + 60_000, '计数已归零，不接着上一轮爬档');
  });

  it('出口之间互不牵连（冷却与窗口都是逐出口的）', () => {
    const g = gate();
    for (const accountId of ['acc-1', 'acc-2', 'acc-3']) g.observeLimited(limited('a.example.com', accountId));
    assert.equal(g.cooldownUntil('a.example.com') !== null, true);
    assert.equal(g.cooldownUntil('b.example.com'), null);
    // b 出口上单独数：两个账号不够
    assert.equal(g.observeLimited(limited('b.example.com', 'acc-1')).attribution, 'key');
    assert.equal(g.observeLimited(limited('b.example.com', 'acc-2')).attribution, 'key');
  });
});

/* ------------------------------ shadow 观察模式（决策 10(6)） ------------------------------ */

describe('shadow 模式：只记不动', () => {
  function withSink(over: Parameters<typeof createEgressGate>[0] = {}) {
    const records: EgressShadowRecord[] = [];
    const g = createEgressGate({ now, ...over, onShadow: (r) => records.push(r) });
    return { g, records };
  }

  it('恒回 `key`（判据默认关），但每条观测都留下记录 —— 「不调用」与「没发现」必须可区分', () => {
    const { g, records } = withSink();
    for (const accountId of ['acc-1', 'acc-2', 'acc-3']) {
      assert.equal(g.observeLimited(limited('a.example.com', accountId)).attribution, 'key');
    }

    assert.equal(records.length, 3, '一次观测一条记录（不是「命中才记」）');
    assert.deepEqual(records.map((r) => r.distinctAccounts), [1, 2, 3]);
    assert.deepEqual(records.map((r) => r.wouldFire), [false, false, true], 'wouldFire 与判据同源');
    assert.equal(records[2]?.insufficientAccounts, false);
    assert.deepEqual(records[2]?.types, ['RATE_LIMITED']);
    assert.ok(records.every((r) => r.degraded === false));
    assert.equal(g.snapshot().length, 0, '观察模式不落任何状态');
  });

  it('`insufficientAccounts` = 「这个出口上从未见过 N 个账号」，与「窗内未命中」是两件事', () => {
    const { g, records } = withSink();
    g.observeLimited(limited('a.example.com', 'acc-1'));
    assert.equal(records[0]?.insufficientAccounts, true, '单账号出口上「跨账号相关性」这个前提不成立');

    // 先造出 5 个账号（够多），等它们全滑出窗 → 此刻是**真的没命中**，不是**没前提**
    const g2 = withSink();
    for (const accountId of ['a', 'b', 'c', 'd', 'e']) g2.g.observeLimited(limited('a.example.com', accountId));
    tick(60_001);
    g2.g.observeLimited(limited('a.example.com', 'a'));
    const last = g2.records[g2.records.length - 1];
    assert.equal(last?.insufficientAccounts, false, '见过 5 个账号 ⇒ 前提成立');
    assert.equal(last?.wouldFire, false, '但窗内只有 1 个 ⇒ 未命中');
    assert.equal(last?.distinctAccounts, 1, '剪枝后窗内计数回到 1');
  });

  it('shadow 出口（onShadow）抛异常不得改变结论，也不得影响数据面', () => {
    const g = createEgressGate({ now, mode: 'active', onShadow: () => { throw new Error('sink 炸了'); } });
    for (const accountId of ['acc-1', 'acc-2']) {
      assert.equal(g.observeLimited(limited('a.example.com', accountId)).attribution, 'key');
    }
    assert.equal(g.observeLimited(limited('a.example.com', 'acc-3')).attribution, 'egress', '结论照出');
  });

  it('全域/降级（端口 v10）：输入不可读 ⇒ 就地降级为 key 级 + 记录 `degraded`，且不动状态', () => {
    const { g, records } = withSink({ mode: 'active' });
    const poisoned = {
      egressId: 'a.example.com',
      correlationId: 'req-x',
      get subject(): { accountId: string | null; keyId: string } {
        throw new Error('毒化的凭据足迹');
      },
    };

    let verdict: { attribution: string; cooldownUntilMs: number | null } | undefined;
    assert.doesNotThrow(() => {
      verdict = g.observeLimited(poisoned);
    });
    assert.deepEqual(verdict, { attribution: 'key', cooldownUntilMs: null });
    assert.equal(records.length, 1);
    assert.equal(records[0]?.degraded, true, '「炸了」与「什么都没发现」必须可区分');
    assert.equal(records[0]?.wouldFire, false);
    assert.equal(g.cooldownUntil('a.example.com'), null, '降级路径不得冷却出口（误报放大那条路）');
    assert.equal(g.snapshot().length, 0);
  });
});

/* ------------------------------ 快照读面（契约 v1.5.0 ②） ------------------------------ */

describe('snapshot()：签名与语义逐字不动', () => {
  it('`untilMs` 是**绝对时刻**：跨 tick 前进后逐字不变（发帧指纹靠它稳定）', () => {
    const g = createEgressGate({ now, mode: 'active' });
    for (const accountId of ['acc-1', 'acc-2', 'acc-3']) g.observeLimited(limited('a.example.com', accountId));
    const until = g.cooldownUntil('a.example.com');
    assert.ok(until !== null);

    const first = g.snapshot();
    assert.deepEqual(first, [{ host: 'a.example.com', untilMs: until }]);

    tick(120_000); // 三个 tick 之后
    assert.deepEqual(g.snapshot()[0]?.untilMs, until, '时钟前进 → untilMs 不动（剩余量才动）');
    assert.equal(g.cooldownUntil('a.example.com'), null, '剩余量为 0：读面如此，但条目仍留在快照里');
  });

  it('快照是**全量**：已过期条目仍在内（差分通道无墓碑，滤掉它 = 解除帧永不发出）', () => {
    const g = createEgressGate({ now, mode: 'active' });
    for (const accountId of ['acc-1', 'acc-2', 'acc-3']) g.observeLimited(limited('a.example.com', accountId));
    g.observeLimited({ ...limited('b.example.com', 'acc-2'), retryAfterMs: 120_000 });
    assert.equal(g.snapshot().length, 1, 'b 只见过 1 个账号，没冷却 ⇒ 不进快照');

    tick(60_000); // a 恰好到期
    const snap = g.snapshot();
    assert.equal(snap.length, 1, 'a 仍在快照里，不因过期被滤掉');
    assert.ok((snap[0]?.untilMs ?? 0) <= clock, 'a 在快照里的形状是「untilMs <= now」，不是缺席');

    // 从未冷却过的出口不进快照（快照 = 该层记录过的出口，不是全部已知出口）
    assert.equal(snap.find((e) => e.host === 'never.example.com'), undefined);
  });

  it('只读面不产生状态；`observeSuccess` / `reserve` 都不改 `untilMs`', () => {
    const g = createEgressGate({ now, mode: 'active' });
    g.observeSuccess('ghost.example.com');
    g.snapshot();
    assert.equal(g.snapshot().length, 0, '只读/无冷却路径不落条目');

    for (const accountId of ['acc-1', 'acc-2', 'acc-3']) g.observeLimited(limited('a.example.com', accountId));
    const until = g.snapshot()[0]?.untilMs;
    g.observeSuccess('a.example.com');
    g.reserve('a.example.com', 'data');
    assert.deepEqual(g.snapshot(), [{ host: 'a.example.com', untilMs: until }]);
  });

  it('**预算桶不在这张表里**（决策 3）：一次人工刷新（47 次拒绝）不得让 §7 帧有任何变化', () => {
    // 验证 9 的自伤回归在闸内的那半：桶拒绝是我们**自己**算出来的账，没有上游证据
    // ⇒ 既不写冷却、也不推进阶梯、更不得让快照跟着抖动（否则前端会看到「出口限流中」无端闪烁）。
    const records: EgressShadowRecord[] = [];
    const g = createEgressGate({ now, budget: { capacity: 5, windowMs: 60_000, reserveForData: 1 }, onShadow: (r) => records.push(r) });

    let allowed = 0;
    for (let i = 0; i < 47; i += 1) if (g.reserve('a.example.com', 'data').allowed) allowed += 1;

    assert.equal(allowed, 5, '容量 5 = 放行 5 枚');
    assert.equal(g.snapshot().length, 0, '42 次本地拒绝 ⇒ §7 帧零变化');
    assert.equal(g.cooldownUntil('a.example.com'), null, '桶拒绝不写冷却（写了就是自己把自己冷掉）');
    assert.deepEqual(records, [], '本地拒绝不进观察面 —— 这是「自伤闭环」唯一的结构性防线（决策 10(5)）');
  });
});

/* ------------------------------ 端口小件 ------------------------------ */

describe('retryAfterSecOf', () => {
  it('向上取整且至少 1s（全仓唯一实现，已并轨到端口）', () => {
    assert.equal(retryAfterSecOf(0), 1);
    assert.equal(retryAfterSecOf(1), 1);
    assert.equal(retryAfterSecOf(60_000), 60);
    assert.equal(retryAfterSecOf(60_001), 61);
  });
});

/* ------------------------------ 引擎接线 ------------------------------ */

describe('引擎：出口级 429 的归因上移（§16.7 / 决策 10）', () => {
  const active = () => ({ gate: createEgressGate({ now, mode: 'active' }) });

  it('同一出口第 3 个不同账号 429 → 归出口：不记该 key 健康、不换 key、回 429 + Retry-After', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2'), keyConfig('k3')],
      steps: [EGRESS_429, EGRESS_429, EGRESS_429],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      ...active(),
    });

    const result = await call(h);

    assert.equal(result.error.httpStatus, 429);
    assert.equal(result.error.body.error.code, 'RATE_LIMITED', '§16.7：不新增错误码');
    assert.equal(result.error.body.error.type, 'rate_limit_error');
    assert.equal(result.error.retryAfterSec, 60, '出口冷却 60s 原样告诉客户端');
    assert.equal(h.calls.length, 3, '跨账号相关性要 3 个账号才能确认 —— 不是把候选轮光');

    // 归因纪律：判明出口级的那一把**不进冷却**；前两把在判明之前已按 key 级记过（判据的固有延迟）
    assert.equal(runtimeOf(h.pool, 'k3').cooldownUntil, null, '判明出口级的那把 key 不得被记账');
    assert.notEqual(runtimeOf(h.pool, 'k1').cooldownUntil, null, '判明前已按 key 级记过（不是缺陷）');
  });

  it('同一账号的 3 把 key 全 429 ⇒ 仍判 key 级（不会冷掉整个出口）', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2'), keyConfig('k3')],
      steps: [EGRESS_429, EGRESS_429, EGRESS_429],
      accounts: { k1: 'acc-1', k2: 'acc-1', k3: 'acc-1' },
      ...active(),
    });

    const result = await call(h);

    assert.notEqual(result.error.httpStatus, 429, '不是出口级 ⇒ 走既有 502 终态，不当成出口退避');
    assert.equal(result.error.httpStatus, 502);
    assert.equal(h.gate.cooldownUntil('up1.example.com'), null, '出口没被冷掉');
    assert.notEqual(runtimeOf(h.pool, 'k3').cooldownUntil, null, '三把 key 各自按 key 级记冷却');
  });

  it('冷却期内连一把都不试：0 次上游请求，仍回 429 + Retry-After', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2'), keyConfig('k3')],
      steps: [EGRESS_429, EGRESS_429, EGRESS_429],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      ...active(),
    });
    assert.equal((await call(h)).error.httpStatus, 429, '第一次：判明出口级并落冷却');
    const cooledUntil = h.gate.cooldownUntil('up1.example.com');
    assert.ok(cooledUntil !== null);

    // 第二次：同一出口已在冷却 → 一个请求都不发
    h.calls.length = 0;
    const result = await call(h);

    assert.equal(h.calls.length, 0, '冷却期内不发任何上游请求 —— 同出口轮换必然再撞');
    assert.equal(result.error.httpStatus, 429);
    assert.equal(result.error.body.error.code, 'RATE_LIMITED');
    assert.equal(result.error.retryAfterSec, 60, 'Retry-After = 出口剩余冷却');
    assert.deepEqual(h.gate.snapshot(), [{ host: 'up1.example.com', untilMs: cooledUntil }], '快照（§7 帧的源）不动');
  });

  it('候选被出口冷却滤光时终态是 429，**不是** 503 NO_AVAILABLE_KEY', async () => {
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2'), keyConfig('k3')],
      steps: [EGRESS_429, EGRESS_429, EGRESS_429],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      ...active(),
    });
    await call(h);
    h.calls.length = 0;

    const result = await call(h);

    assert.notEqual(result.error.httpStatus, 503, '503 是「池里一把都没有」的稳定出口，用在这里会把可重试说成别重试');
    assert.equal(result.error.body.error.code, 'RATE_LIMITED');
    assert.equal(result.error.retryAfterSec, 60);
  });

  it('出口冷却不牵连**别的出口**：另一出口的候选照常顶上', async () => {
    const gate = createEgressGate({ now, mode: 'active' });
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
        const baseUrl = `https://${up}.example.com/v1`;
        return { upstreamId: up, baseUrl, apiKey: `sk-${keyId}`, egressId: egressIdOfUrl(baseUrl), accountId: null };
      },
    };
    const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };
    const { fetchImpl, calls } = scriptedFetch([OK]);
    const engine = createGatewayEngine({ pool, secrets, models, fetchImpl, now, egress: gate });

    // 先把 up1 冷掉（三个不同账号）
    for (const accountId of ['acc-1', 'acc-2', 'acc-3']) gate.observeLimited(limited('up1.example.com', accountId));

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

  it('出口标识并轨（端到端）：等价写法（大小写 + 非默认端口）落进**同一个桶**', async () => {
    // Tier 1 下台账给的 id 就是归一化 host（`egressIdOfUrl`，在 `src/wiring/secrets.ts` 算一次），
    // 与闸内的键必须逐字相同：两边对「大小写/默认端口」读法只要差一处，
    // 限流就按写法分裂成两份（等于没限）。本用例喂的正是那一步的产物。
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2'), keyConfig('k3')],
      steps: [EGRESS_429, EGRESS_429, EGRESS_429],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      baseUrls: { up1: 'https://UP1.Example.com:8443/v1' },
      ...active(),
    });

    await call(h);

    assert.equal(h.gate.cooldownUntil('up1.example.com:8443'), clock + 60_000, '归一化后的小写 host:port');
    assert.deepEqual(h.gate.snapshot(), [{ host: 'up1.example.com:8443', untilMs: clock + 60_000 }]);
  });
});

describe('引擎：未接线/默认时行为零漂移（决策 7）', () => {
  it('不注入闸（缺省 `permissiveEgressGate`）：429 按 key 级处置、换下一把', async () => {
    // 缺省闸恒放行、恒判 key 级 ⇒ 与改动前逐字节相同。这是「接缝 ≠ 修」的可执行表达式。
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot({
      revision: 1,
      upstreams: [{ upstreamId: 'up1', enabled: true, models: null }],
      keys: [keyConfig('k1'), keyConfig('k2')],
    });
    const secrets: SecretResolver = {
      resolve: (keyId) => {
        const baseUrl = 'https://up1.example.com/v1';
        return { upstreamId: 'up1', baseUrl, apiKey: `sk-${keyId}`, egressId: egressIdOfUrl(baseUrl), accountId: null };
      },
    };
    const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };
    const { fetchImpl, calls } = scriptedFetch([EGRESS_429, OK]);
    const engine = createGatewayEngine({ pool, secrets, models, fetchImpl, now });

    const result = (await engine.chatCompletions({
      group: GROUP,
      model: 'gpt-4o-mini',
      body: chatBody(),
      stream: false,
      requestId: REQUEST_ID,
    })) as ForwardResult;

    assert.equal(result.kind, 'json', '换一把能救 → 客户端 200');
    assert.equal(calls.length, 2);
    assert.notEqual(runtimeOf(pool, 'k1').cooldownUntil, null, 'k1 按 RATE_LIMITED 记 key 级冷却（改动前的行为）');
  });

  it('shadow 模式（判据默认关）：3 个不同账号全 429 仍走 key 级，出口不被冷掉，但记录已产出', async () => {
    const records: EgressShadowRecord[] = [];
    const gate = createEgressGate({ now, onShadow: (r) => records.push(r) });
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2'), keyConfig('k3')],
      steps: [EGRESS_429, EGRESS_429, EGRESS_429],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      gate,
    });

    const result = await call(h);

    assert.equal(result.error.httpStatus, 502, '判据默认关 ⇒ 与改动前一致（三把都按 key 级失败）');
    assert.equal(h.calls.length, 3);
    assert.equal(gate.snapshot().length, 0, '观察模式不落状态');
    assert.equal(records.length, 3, '标定要能分辨「没接线 / 没发现 / 判据炸了」');
    assert.equal(records[2]?.wouldFire, true, '真启用会不会挂钩 —— 标定吃这个数');
    assert.deepEqual(records.map((r) => r.distinctAccounts), [1, 2, 3]);
    assert.notEqual(runtimeOf(h.pool, 'k3').cooldownUntil, null, 'shadow 下第三把仍按 key 级记过');
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


/* ------------------ 引擎读台账给的稳定 id（Tier 2 形态） ------------------ */

describe('引擎：出口 id 由台账给（target.egressId，不再解析 baseUrl）', () => {
  const active = () => ({ gate: createEgressGate({ now, mode: 'active' }) });

  it('稳定 id ≠ host：冷却落在台账那个 id 上，**host 不被冷**（引擎没在解析 baseUrl）', async () => {
    // Tier 2 的出口是账号级的 `egress_proxies.id`，从 base URL 里**解析不出来**。
    // 这条用例把两者刻意分开：`egr_9f2c1a` 是台账给的，`up1.example.com` 是 baseUrl 的 host。
    // 引擎若还在归一化 baseUrl，冷掉的就是后者 —— 而真实的 Tier 2 出口于是永远不冷却（等于没闸）。
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2'), keyConfig('k3')],
      steps: [EGRESS_429, EGRESS_429, EGRESS_429],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      egressIds: { up1: 'egr_9f2c1a' },
      ...active(),
    });

    const result = await call(h);

    assert.equal(result.error.httpStatus, 429);
    assert.equal(h.gate.cooldownUntil('egr_9f2c1a'), clock + 60_000, '冷却记在台账给的稳定 id 上');
    assert.equal(h.gate.cooldownUntil('up1.example.com'), null, 'host 不是出口 —— 引擎不得再解析 baseUrl');
    assert.deepEqual(h.gate.snapshot(), [{ host: 'egr_9f2c1a', untilMs: clock + 60_000 }]);
  });

  it('该出口冷却期内 0 次出站：说明读取的是台账 id，而不是"从来就没匹配上"', async () => {
    // 上一条只证明"冷在了稳定 id 上"。若引擎两侧读法是两个键（冷却查 host、判据写 id），
    // 也会出现"稳定 id 上有一条冷却、host 上没有"的画面 —— 所以必须补一条**行为面**的判据：
    // 冷却真的把它挡住了。同一个出口被挡住 ⇒ 查的与写的是同一个键。
    const gate = createEgressGate({ now, mode: 'active' });
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2'), keyConfig('k3')],
      steps: [EGRESS_429, EGRESS_429, EGRESS_429],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      egressIds: { up1: 'egr_9f2c1a' },
      gate,
    });
    assert.equal((await call(h)).error.httpStatus, 429, '第一轮判明出口级');

    h.calls.length = 0;
    const result = await call(h);

    assert.equal(h.calls.length, 0, '冷却期内一把都不试 —— 同出口轮换必然再撞');
    assert.equal(result.error.httpStatus, 429);
    assert.equal(result.error.body.error.code, 'RATE_LIMITED');
    assert.equal(result.error.retryAfterSec, 60);
  });

  it('稳定 id 不做二次归一化：不像 host 的 id 照样进桶（拿去 `egressIdOfUrl` 会恒得 null）', async () => {
    // 这是段二最容易踩的一脚：顺手对 `target.egressId` 再跑一次 `egressIdOfUrl`，
    // 结果恒是 `null`（"egr_9f2c1a" 不是 URL）⇒ **一个出口零个桶 = 无上限**，
    // 且症状是"闸接了但从来不拦"，与"没接线"同形。这里用预算桶把它钉死。
    const gate = createEgressGate({ now, budget: { capacity: 2, windowMs: 60_000, reserveForData: 0 } });
    const h = makeHarness({ keys: [keyConfig('k1')], steps: [OK], egressIds: { up1: 'egr_9f2c1a' }, gate });

    assert.deepEqual(gate.reserve('egr_9f2c1a', 'data'), { allowed: true });
    assert.deepEqual(gate.reserve('egr_9f2c1a', 'data'), { allowed: true });
    const denied = gate.reserve('egr_9f2c1a', 'data');
    assert.equal(denied.allowed, false, '桶按**原样的**稳定 id 记账（同一把键）');

    // 引擎侧同样按原样那个键取配额：桶已空 ⇒ 本地拒绝，而不是"换个键还有余额"
    const result = await call(h);
    assert.equal(result.error.httpStatus, 429);
    assert.equal(result.error.body.error.code, 'RATE_LIMITED');
    assert.equal(h.calls.length, 0, '一个字节都没发');
  });

  it('`target.egressId === null` ⇒ fail-open：不裁决、不冷任何出口、照旧走 key 级', async () => {
    // 决策 2：解析不出出口 ⇒ 宁可退回旧的 key 级处置，也不拿一个假出口去冷掉别的上游。
    // **不得**在这里回退去解析 baseUrl（那个 host 是宿主的，不是这次要用的出口）
    // —— Tier 2 下 `egress_id IS NULL` 的 Tier-1 回退发生在快照重建那一层（`src/wiring/secrets.ts`）。
    const gate = createEgressGate({ now, mode: 'active' });
    const h = makeHarness({
      keys: [keyConfig('k1')],
      steps: [EGRESS_429, EGRESS_429, EGRESS_429],
      accounts: { k1: 'acc-1' },
      egressIds: { up1: null },
      gate,
    });

    const result = await call(h);

    assert.equal(result.error.httpStatus, 502, '出口未知 ⇒ 沿用既有 key 级终态，不是 429');
    assert.deepEqual(gate.snapshot(), [], '没有假出口被冷掉');
    assert.equal(gate.cooldownUntil('up1.example.com'), null, '不得回退去解析 baseUrl 当出口');
    assert.notEqual(runtimeOf(h.pool, 'k1').cooldownUntil, null, 'key 级处置照旧');
  });
});

/* ---------------- 本地预算拒绝：四件事一件都不能少（决策 4b / 4c） ---------------- */

describe('引擎：本地预算拒绝（标记头 ⇒ 不换 key、不记失败、attempts 减回 1）', () => {
  /**
   * 把桶打空：`capacity` 枚由本用例显式取走，随后引擎那次 `reserve` 必被拒。
   * `reserveForData: 0` 是为了让"数据面"这一个消费方自己就能把桶吃到见底
   * （保留额只挡管理面，见决策 8）。
   */
  const EXHAUSTED = { capacity: 1, windowMs: 60_000, reserveForData: 0 } as const;

  function spentGate() {
    const gate = createEgressGate({ now, mode: 'active', budget: { ...EXHAUSTED } });
    assert.deepEqual(gate.reserve('up1.example.com', 'data'), { allowed: true });
    assert.equal(gate.reserve('up1.example.com', 'data').allowed, false, '桶已空（用例前提）');
    return gate;
  }

  it('终态是 429 + Retry-After，**不是 502**（决策 4b：本地拒绝不算一次尝试）', async () => {
    const h = makeHarness({ keys: [keyConfig('k1')], steps: [OK], gate: spentGate() });

    const result = await call(h);

    assert.equal(result.error.httpStatus, 429, '「本地上限，等一等再来」不是「上游故障」');
    assert.equal(result.error.body.error.code, 'RATE_LIMITED');
    assert.equal(result.error.body.error.type, 'rate_limit_error');
    assert.ok((result.error.retryAfterSec ?? 0) >= 1, '合成 429 带的 Retry-After 原样透给客户端');
    assert.equal(result.attempts, 0, 'attempts 减回 1 ⇒ 收尾分型读到"一个上游都没碰到"');
  });

  it('一个字节都没发：`inner` fetch 零调用（合成的 429 不落网络）', async () => {
    const h = makeHarness({ keys: [keyConfig('k1'), keyConfig('k2')], steps: [OK, OK], gate: spentGate() });

    await call(h);

    assert.equal(h.calls.length, 0);
  });

  it('不记 key 失败：无冷却、无失败计数、事件流里**没有**假失败行（决策 4a 第 2 条）', async () => {
    // 这是本分支最贵的一条：本地拒绝被当成 upstream 证据记一次失败，几轮下来
    // **真的把好 key 停掉**。四类证据都断一遍，缺一条就有一个入口能漏过去。
    const attempts: AttemptEvent[] = [];
    const gate = createEgressGate({ now, mode: 'active', budget: { ...EXHAUSTED } });
    gate.reserve('up1.example.com', 'data');
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2')],
      steps: [OK, OK],
      gate,
      attempts,
    });

    await call(h);

    const rt = runtimeOf(h.pool, 'k1');
    assert.equal(rt.cooldownUntil, null, '没有 key 级冷却');
    assert.equal(rt.consecutiveFails, 0, '连续失败数没被推进（推进它就会走升档阶梯）');
    assert.equal(rt.failCount, 0);
    assert.ok(!attempts.some((e) => e.outcome === 'failure'), `事件流不得出现 failure：${JSON.stringify(attempts)}`);
    assert.deepEqual(
      attempts.map((e) => e.outcome),
      ['skipped'],
      '只发一条 skipped（见下一条：轮换就此终止）',
    );
  });

  it('终止本轮候选轮换（决策 4a/5 表 + 影响表①）：剩下的候选一个都不碰', async () => {
    // 本地拒绝落在**同一个出口**上，换一把 key 必然再撞同一张桶（决策 4a「不换 key」）。
    // 判别方式：三把候选都可用、桶已空 —— 终止 ⇒ **一条** skipped；继续 ⇒ 三条。
    // 两者都 `calls.length === 0`，所以只断"零调用"是断不出来的。
    const attempts: AttemptEvent[] = [];
    const gate = createEgressGate({ now, mode: 'active', budget: { ...EXHAUSTED } });
    gate.reserve('up1.example.com', 'data');
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2'), keyConfig('k3')],
      steps: [OK, OK, OK],
      gate,
      attempts,
    });

    await call(h);

    assert.equal(attempts.length, 1, '第一个候选就撞上本地拒绝 ⇒ 本轮结束，不去试第二把');
    assert.equal(attempts[0]?.attempt, 0, '事件回报的 attempt 是 0 —— 「真实尝试」计数里没有这一次');
  });

  it('出口冷却态逐字节不变：不 `cool()`、不推进阶梯、不发 §7 帧（决策 5 表内第 1 行）', async () => {
    const gate = createEgressGate({ now, mode: 'active', budget: { ...EXHAUSTED } });
    gate.reserve('up1.example.com', 'data');
    const before = gate.snapshot();
    const h = makeHarness({ keys: [keyConfig('k1'), keyConfig('k2')], steps: [OK, OK], gate });

    await call(h);

    assert.deepEqual(gate.snapshot(), before, '桶拒绝是**我们自己**的账，不是对面忙');
    assert.equal(gate.cooldownUntil('up1.example.com'), null);
  });

  it('不进台账归因：本地拒绝不喂 `observeLimited`（否则闸拿自己拒出来的脸冷掉自己）', async () => {
    // 决策 10(5) 末条点名的自伤闭环形态：一个被打空预算的出口拿自己产出的 N 张脸判成
    // 「被上游限」再把自己冷掉。shadow 记录是这条纪律的可观测面 —— 它必须**一条都不产**。
    const records: EgressShadowRecord[] = [];
    const gate = createEgressGate({ now, mode: 'active', budget: { ...EXHAUSTED }, onShadow: (r) => records.push(r) });
    gate.reserve('up1.example.com', 'data');
    const h = makeHarness({
      keys: [keyConfig('k1'), keyConfig('k2'), keyConfig('k3')],
      steps: [OK, OK, OK],
      accounts: { k1: 'acc-1', k2: 'acc-2', k3: 'acc-3' },
      gate,
    });

    await call(h);

    assert.deepEqual(records, [], '观察到 0 次 —— 判据只在闸内一处，本地拒绝不得旁路喂它');
    assert.equal(gate.cooldownUntil('up1.example.com'), null);
  });

  it('放行的请求照旧：原样转发，且**标记头不上行**（进程内标记不得透给上游）', async () => {
    const gate = createEgressGate({ now, mode: 'active', budget: { capacity: 5, windowMs: 60_000, reserveForData: 0 } });
    const { fetchImpl, calls } = capturingFetch([OK]);
    const secrets: SecretResolver = {
      resolve: () => ({ upstreamId: 'up1', baseUrl: 'https://up1.example.com/v1', apiKey: 'sk-k1', egressId: 'up1.example.com', accountId: null }),
    };
    const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };
    const pool: KeyPoolInternal = createKeyPool({ now });
    pool.applySnapshot({
      revision: 1,
      upstreams: [{ upstreamId: 'up1', enabled: true, models: null }],
      keys: [keyConfig('k1')],
    });
    const engine = createGatewayEngine({ pool, secrets, models, fetchImpl, now, egress: gate });

    const result = (await engine.chatCompletions({
      group: GROUP,
      model: 'gpt-4o-mini',
      body: chatBody(),
      stream: false,
      requestId: REQUEST_ID,
    })) as ForwardResult;

    assert.equal(result.kind, 'json');
    assert.equal(calls.length, 1);
    const sent = Object.keys(calls[0]?.headers ?? {}).map((h) => h.toLowerCase());
    assert.ok(!sent.includes(EGRESS_LOCAL_HEADER), `进程内标记头不得上行：${JSON.stringify(sent)}`);
  });
});
