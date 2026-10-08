// 出口预算闸 fetch 装饰器的验收测试（ADR-0021 决策 4 / 4a / 4b / 4c / 5 / 7；验证清单 3 / 5 / 6 / 14 / 16）。
//
// 本文件钉的是**装饰器这一层能独立证明的**那些条：
//   3  拒绝不发请求（`inner` 零调用）+ 429 + `Retry-After`；
//   5  标记头只出现在合成响应上，**不上行**；
//   6  保留额度按 `consumer` 分岔（端口把消费方原样交给闸，装饰器不自己判）；
//   14 缺省闸无害（逐字节同"没包这一层"）；
//   16 出口隔离 —— 两个 `egressId` 各自取件，不串桶。
//
// ⚠️ 终态形状那条（验证 #10「客户端拿到 429 而不是 502」）**不在这里**：它要引擎把
//    `attempts` 减回 1、不进台账归因（判据只在闸内一处：`EgressGate.observeLimited`）、
//    不 `reportFailure` 才成立，属路由者车道的
//    `engine.spec.ts`。本文件只能证到「装饰器没发请求、也没让调用方以为成功」这一半。
//
// 桩 fetch 一律用闭包记参数，不引入任何真实网络。

import { describe, expect, it } from 'vitest';
import { EGRESS_LOCAL_BODY, createEgressFetch, isLocalEgressReject } from './fetch-gate.js';
import {
  EGRESS_LOCAL_HEADER,
  EGRESS_LOCAL_VALUE,
  permissiveEgressGate,
  type EgressGate,
  type EgressLimitedInput,
  type EgressReservation,
} from './port.js';

/** 记录取件与归因的假闸。**不导出到生产代码** —— 端口不该为了测试多出构造入口 */
function makeGate(decision: EgressReservation | 'throw') {
  const calls = {
    reserve: [] as { egressId: string; consumer: string }[],
    observeLimited: [] as EgressLimitedInput[],
    observeSuccess: [] as string[],
  };
  const gate: EgressGate = {
    reserve: (egressId, consumer) => {
      calls.reserve.push({ egressId, consumer });
      if (decision === 'throw') throw new Error('gate exploded');
      return decision;
    },
    observeLimited: (input) => {
      calls.observeLimited.push(input);
      return { attribution: 'key', cooldownUntilMs: null };
    },
    observeSuccess: (egressId) => {
      calls.observeSuccess.push(egressId);
    },
    cooldownUntil: () => null,
    snapshot: () => [],
  };
  return { gate, calls };
}

/** 记参数的假上游 fetch：只回答一次 200，绝不碰网络 */
function makeInner() {
  const calls: { input: unknown; init: unknown }[] = [];
  const inner = (async (input: unknown, init?: unknown) => {
    calls.push({ input, init });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { inner, calls };
}

const DENY: EgressReservation = { allowed: false, reason: 'budget', retryAfterMs: 1_500 };
const DENY_COOLDOWN: EgressReservation = { allowed: false, reason: 'cooldown', retryAfterMs: 60_000 };

describe('fail-open：`egressId === null`（决策 2）', () => {
  it('直通 `inner`，**0 次裁决**，不合成任何响应', async () => {
    const { gate, calls } = makeGate(DENY);
    const { inner, calls: innerCalls } = makeInner();
    const fetchFor = createEgressFetch(gate, inner);

    const res = await fetchFor(null, 'data')('https://api.example.com/v1/models');

    expect(res.status).toBe(200);
    expect(calls.reserve).toEqual([]);
    expect(innerCalls).toHaveLength(1);
    expect(isLocalEgressReject(res)).toBe(false);
  });
});

describe('放行：原样转发（决策 4）', () => {
  it('`inner` 收到**同一组** `(input, init)`，装饰器不碰请求', async () => {
    const { gate, calls } = makeGate({ allowed: true });
    const { inner, calls: innerCalls } = makeInner();
    const fetchFor = createEgressFetch(gate, inner);

    const init = { method: 'POST', body: '{"model":"m"}' } as const;
    const res = await fetchFor('api.example.com', 'data')('https://api.example.com/v1/chat/completions', init);

    expect(res.status).toBe(200);
    expect(calls.reserve).toEqual([{ egressId: 'api.example.com', consumer: 'data' }]);
    expect(innerCalls[0]?.input).toBe('https://api.example.com/v1/chat/completions');
    expect(innerCalls[0]?.init).toBe(init);
  });

  it('标记头**不上行**（只存在于进程内合成响应，不进发往上游的请求）', async () => {
    const { gate } = makeGate({ allowed: true });
    const { inner, calls: innerCalls } = makeInner();
    const fetchFor = createEgressFetch(gate, inner);

    await fetchFor('api.example.com', 'management')('https://api.example.com/v1/models', {
      headers: { authorization: 'redacted' },
    });

    expect(innerCalls).toHaveLength(1);
    expect(JSON.stringify(innerCalls[0])).not.toContain(EGRESS_LOCAL_HEADER);
  });
});

describe('拒绝：合成 429，零上游调用（决策 4b / PM 裁 1）', () => {
  it('`inner` **零调用**，回 429 + `Retry-After` + 标记头 + 能过 classify 的 body', async () => {
    const { gate, calls } = makeGate(DENY);
    const { inner, calls: innerCalls } = makeInner();
    const fetchFor = createEgressFetch(gate, inner);

    const res = await fetchFor('api.example.com', 'data')('https://api.example.com/v1/models');

    expect(innerCalls).toEqual([]); // ① 一次网络都没发
    expect(calls.reserve).toHaveLength(1);
    expect(res.status).toBe(429); // ② 429，不是 502（502 由引擎侧那半条断言守，见文件头）
    expect(res.headers.get('retry-after')).toBe('2'); // 1500ms → ceil → 2s
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(isLocalEgressReject(res)).toBe(true); // ③ 引擎凭它不换 key / 不记 key 失败
    expect(JSON.parse(EGRESS_LOCAL_BODY)).toEqual({ error: { code: 'RATE_LIMITED' } });
    expect(await res.text()).toBe(EGRESS_LOCAL_BODY);
  });

  it('`reason` 两态**同形**（决策 3）：`cooldown` 与 `budget` 对调用方没有可观察差异', async () => {
    const budget = await createEgressFetch(makeGate(DENY).gate, makeInner().inner)('a.example', 'data')('https://a.example/v1');
    const cool = await createEgressFetch(makeGate(DENY_COOLDOWN).gate, makeInner().inner)('a.example', 'data')('https://a.example/v1');

    const shape = (r: Response) => ({ status: r.status, retryAfter: r.headers.get('retry-after'), marker: r.headers.get(EGRESS_LOCAL_HEADER) });
    expect(shape(budget)).toEqual({ status: 429, retryAfter: '2', marker: EGRESS_LOCAL_VALUE });
    expect(shape(cool)).toEqual({ status: 429, retryAfter: '60', marker: EGRESS_LOCAL_VALUE });
  });

  it('拒绝路径**不调 `observeLimited`**（决策 4a：归因只有一份判据，装饰器不参与）', async () => {
    const { gate, calls } = makeGate(DENY);
    const { inner } = makeInner();
    const fetchFor = createEgressFetch(gate, inner);

    await fetchFor('api.example.com', 'data')('https://api.example.com/v1/models');

    expect(calls.observeLimited).toEqual([]);
    expect(calls.observeSuccess).toEqual([]);
  });
});

describe('识别侧：`isLocalEgressReject`（决策 4a）', () => {
  it('认得合成响应，不认上游真 429', async () => {
    const synthesized = await createEgressFetch(makeGate(DENY).gate, makeInner().inner)('a.example', 'data')('https://a.example/v1');
    const upstream = new Response('{"error":{"code":"RATE_LIMITED"}}', { status: 429, headers: { 'content-type': 'application/json' } });

    expect(isLocalEgressReject(synthesized)).toBe(true);
    expect(isLocalEgressReject(upstream)).toBe(false); // 上游真 429 必须走原有归因路径
  });

  it('标记取值必须**逐字**等于常量（不许把 `1` 当成"有头就算"）', () => {
    const wrong = new Response(null, { status: 429, headers: { [EGRESS_LOCAL_HEADER]: 'true' } });
    expect(isLocalEgressReject(wrong)).toBe(false);
  });
});

describe('消费方与出口隔离（决策 8 / 验证 6 / 16）', () => {
  it('`consumer` 原样交给闸，装饰器不自己判保留额', async () => {
    const { gate, calls } = makeGate({ allowed: true });
    const { inner } = makeInner();
    const fetchFor = createEgressFetch(gate, inner);

    await fetchFor('a.example', 'data')('https://a.example/v1');
    await fetchFor('a.example', 'management')('https://a.example/v1');

    expect(calls.reserve).toEqual([
      { egressId: 'a.example', consumer: 'data' },
      { egressId: 'a.example', consumer: 'management' },
    ]);
  });

  it('两个 `egressId` 各自取件，互不串桶（出口 A 的拒绝不影响出口 B）', async () => {
    const denials = new Map<string, EgressReservation>([
      ['a.example', DENY],
      ['b.example', { allowed: true }],
    ]);
    const seen: string[] = [];
    const gate: EgressGate = {
      ...makeGate(DENY).gate,
      reserve: (egressId) => {
        seen.push(egressId);
        return denials.get(egressId) ?? { allowed: true };
      },
    };
    const fetchFor = createEgressFetch(gate, makeInner().inner);

    expect((await fetchFor('a.example', 'data')('https://a.example/v1')).status).toBe(429);
    expect((await fetchFor('b.example', 'data')('https://b.example/v1')).status).toBe(200);
    expect(seen).toEqual(['a.example', 'b.example']);
  });
});

describe('闸内部抛异常 ⇒ 就地 fail-open', () => {
  it('异常**不**变成 5xx、**不**变成合成 429，`inner` 照常被打一次', async () => {
    const { gate } = makeGate('throw');
    const { inner, calls: innerCalls } = makeInner();
    const fetchFor = createEgressFetch(gate, inner);

    const res = await fetchFor('a.example', 'data')('https://a.example/v1');

    expect(res.status).toBe(200);
    expect(isLocalEgressReject(res)).toBe(false);
    expect(innerCalls).toHaveLength(1);
  });
});

describe('缺省闸无害（决策 7 / 验证 14）', () => {
  it('注入 `permissiveEgressGate` 后与"没包这一层"逐字节同形', async () => {
    const { inner: bareInner, calls: bareCalls } = makeInner();
    const { inner: gatedInner, calls: gatedCalls } = makeInner();
    const gated = createEgressFetch(permissiveEgressGate, gatedInner);

    const init = { method: 'GET' } as const;
    const bare = await bareInner('https://a.example/v1', init);
    const wrapped = await gated('a.example', 'management')('https://a.example/v1', init);

    expect(wrapped.status).toBe(bare.status);
    expect(await wrapped.text()).toBe(await bare.text());
    expect(isLocalEgressReject(wrapped)).toBe(false);
    expect(gatedCalls).toEqual(bareCalls);
  });

  it('缺省闸下 `egressId` 写什么都放行（含空串 —— 归一化失败不该在这里被二次判定）', async () => {
    const { inner, calls: innerCalls } = makeInner();
    const fetchFor = createEgressFetch(permissiveEgressGate, inner);

    expect((await fetchFor('', 'data')('https://a.example/v1')).status).toBe(200);
    expect(innerCalls).toHaveLength(1);
  });
});
