// 心跳生产者的验收测试（契约 §7 `egress_pool` 三条字段 + ADR-0020 决策 8 + ADR-0021 决策 9(4)）。
//
// 钉死的判据（每条对应一类会静默出错的事故）：
//   1. 冷启动 = online + null（口径 3：重启回到它，契约内行为）；
//   2. 3 败摘除 / 5min 滞回回池（决策 8 的两参数）；
//   3. 无证据不翻转状态（口径 1：断供看到的是 lastHeartbeatAt 变旧，不是状态翻转）；
//   4. 合成 429 零证据（口径 2：一次人工全量刷新不得摘除整池）；
//   5. 收件箱按内容指纹防重吃（systemd 每拍覆写 ≠ 每拍一份新证据）；
//   6. 同一拍 A 优先于 B（两个入口叠加会把「3 拍 3 败」变成「3 拍 6 样本」）；
//   7. `EXIT_IP_SHAPE` 与管理面 `/test` 那条正则**逐字同一条**（复制的代价由这条断言承担）；
//   8. 帧的 `cooldownUntil` 从闸现取（探活态与限流态两个事实源并列，不互盖）。
//
// 全部离线：时间/文件/网络都走注入（temp 目录 + 假 fetch），零上游请求。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  HEARTBEAT_EVICT_AFTER_FAILURES,
  HEARTBEAT_REJOIN_HYSTERESIS_MS,
  startHeartbeatProducer,
  type HeartbeatProducer,
} from './heartbeat.js';
import { EGRESS_LOCAL_HEADER, EGRESS_LOCAL_VALUE, permissiveEgressGate, type EgressFetchFor, type EgressGate } from './port.js';

const HK = { egressId: 'eg_hk1', name: 'hk-1', proxyUrl: 'http://10.0.0.1:8080' } as const;
const US = { egressId: 'eg_us1', name: 'us-1', proxyUrl: 'http://10.0.0.2:8080' } as const;

/** 假时钟：手动推进，测试里没有任何真等待。 */
function fakeClock(startMs: number) {
  let ms = startMs;
  return {
    now: () => ms,
    advance: (delta: number) => {
      ms += delta;
    },
  };
}

function makeGate(overrides: Partial<EgressGate> = {}): EgressGate {
  return { ...permissiveEgressGate, ...overrides };
}

/**
 * 可控 echo：`mode()` 决定这一拍回什么。
 * `bad` 回非 IP（bad_response=失败证据）；`good` 回登记的 IP；`deny` 回带标记头的合成 429。
 */
function makeFetch() {
  const calls: string[] = [];
  let mode: 'good' | 'bad' | 'deny' = 'good';
  let ip = '203.0.113.7';
  const fetchFor: EgressFetchFor = (_egressId, _consumer) =>
    ((async (input: unknown) => {
      calls.push(String(input));
      if (mode === 'deny') {
        return new Response('{"error":{"code":"RATE_LIMITED"}}', { status: 429, headers: { [EGRESS_LOCAL_HEADER]: EGRESS_LOCAL_VALUE } });
      }
      return new Response(mode === 'good' ? ip : 'not-an-ip-at-all-behind-a-portal', { status: 200 });
    }) as unknown as typeof globalThis.fetch);
  return {
    fetchFor,
    calls,
    set(next: 'good' | 'bad' | 'deny', newIp?: string) {
      mode = next;
      if (newIp !== undefined) ip = newIp;
    },
  };
}

let tmpRoots: string[] = [];
function inboxDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hb-inbox-'));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  tmpRoots = [];
});

/** 写一份 `pool-probe.sh --json` 形状的证据文件（行键=host，与 egressIdOfUrl 同套归一）。 */
function writeInbox(
  dir: string,
  name: string,
  rows: { host: string; ok: boolean; status: string; egressIp?: string; expectedIp?: string }[],
  checkedAt: string,
): void {
  const doc = {
    checkedAt,
    echoUrl: 'https://api.ipify.org',
    results: rows.map((r) => ({
      name: r.host,
      host: r.host,
      region: '',
      ok: r.ok,
      status: r.status,
      egressIp: r.egressIp ?? '',
      expectedIp: r.expectedIp ?? '',
      latencyMs: 100,
      samples: 1,
      slow: false,
      detail: r.status === 'ok' ? '' : 'probe said no',
    })),
  };
  writeFileSync(join(dir, name), JSON.stringify(doc), 'utf8');
}

/** 收件箱里按 host 给一份成功/失败文件。 */
function inboxOk(dir: string, host: string, ip: string, checkedAt: string): void {
  writeInbox(dir, 'probe.json', [{ host, ok: true, status: 'ok', egressIp: ip, expectedIp: ip }], checkedAt);
}
function inboxFail(dir: string, host: string, checkedAt: string): void {
  writeInbox(dir, 'probe.json', [{ host, ok: false, status: 'proxy_unreachable', egressIp: '', expectedIp: '' }], checkedAt);
}

function hk0(producer: HeartbeatProducer) {
  const n = producer.poolSnapshot().find((x) => x.egressId === 'eg_hk1');
  if (n === undefined) throw new Error('hk1 missing');
  return n;
}

describe('冷启动（口径 3 / 决策 8）', () => {
  it('未吃任何证据：online + 三条字段全 null，cooldownUntil 从闸现取为 null', () => {
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    const hb = startHeartbeatProducer({ gate: makeGate(), nodes: [HK], inboxDir: null, now: clock.now });
    expect(hb.poolSnapshot()).toHaveLength(1);
    expect(hk0(hb)).toMatchObject({
      egressId: 'eg_hk1',
      name: 'hk-1',
      status: 'online',
      exitIp: null,
      expectedExitIp: null,
      lastHeartbeatAt: null,
      cooldownUntil: null,
    });
    hb.stop();
  });
});

describe('收件箱轮询（入口 A）', () => {
  it('一份证据 → 记 IP + lastHeartbeatAt；同一文件重拍**不重吃**（内容指纹）', async () => {
    const dir = inboxDir();
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    inboxOk(dir, '10.0.0.1:8080', '203.0.113.7', '2026-10-10T00:00:00.000Z');
    const hb = startHeartbeatProducer({ gate: makeGate(), nodes: [HK], inboxDir: dir, now: clock.now });

    await hb.tick();
    const a = hk0(hb);
    expect(a.exitIp).toBe('203.0.113.7');
    expect(a.lastHeartbeatAt).toBe('2026-10-10T00:00:00.000Z');

    clock.advance(30_000);
    await hb.tick(); // 文件没变 → 指纹已吃过，本拍无证据
    expect(hk0(hb)).toEqual(a); // lastHeartbeatAt **没有**被推进 → 证据未被重复消费
    hb.stop();
  });

  it('ip_mismatch 算失败证据，但 exitIp 仍带出来（「填了代理却走宿主 IP」的告警原料不能丢）', async () => {
    const dir = inboxDir();
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    writeInbox(dir, 'probe.json', [{ host: '10.0.0.1:8080', ok: false, status: 'ip_mismatch', egressIp: '198.51.100.9', expectedIp: '203.0.113.7' }], '2026-10-10T00:00:30.000Z');
    const hb = startHeartbeatProducer({ gate: makeGate(), nodes: [HK], inboxDir: dir, now: clock.now });
    await hb.tick();
    const snap = hk0(hb);
    expect(snap.status).toBe('online'); // 1 败，未达阈值
    expect(snap.exitIp).toBe('198.51.100.9');
    expect(snap.expectedExitIp).toBe('203.0.113.7');
    expect(snap.lastHeartbeatAt).toBe('2026-10-10T00:00:30.000Z');
    hb.stop();
  });

  it('半截 JSON（写入方 crash 中途）= 本拍无证据、不进指纹；覆盖成完整文件后下一拍吃到', async () => {
    const dir = inboxDir();
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    writeFileSync(join(dir, 'probe.json'), '{"checkedAt":"2026-10-10T00:00:00.000Z","res', 'utf8');
    const hb = startHeartbeatProducer({ gate: makeGate(), nodes: [HK], inboxDir: dir, now: clock.now });
    await hb.tick();
    expect(hk0(hb).lastHeartbeatAt).toBeNull();
    inboxOk(dir, '10.0.0.1:8080', '203.0.113.7', '2026-10-10T00:01:00.000Z');
    clock.advance(60_000);
    await hb.tick();
    expect(hk0(hb).exitIp).toBe('203.0.113.7');
    hb.stop();
  });
});

describe('摘除与滞回（决策 8 两参数）', () => {
  it(`连续 ${HEARTBEAT_EVICT_AFTER_FAILURES} 条失败证据摘除，摘除后 exitIp 清空`, async () => {
    const dir = inboxDir();
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    const hb = startHeartbeatProducer({ gate: makeGate(), nodes: [HK], inboxDir: dir, now: clock.now });
    for (let i = 0; i < HEARTBEAT_EVICT_AFTER_FAILURES + 1; i += 1) {
      clock.advance(30_000);
      inboxFail(dir, '10.0.0.1:8080', new Date(clock.now()).toISOString());
      await hb.tick();
    }
    const snap = hk0(hb);
    expect(snap.status).toBe('offline');
    expect(snap.exitIp).toBeNull();
    hb.stop();
  });

  it('成功证据清连败：2 败 + 1 成 + 2 败 ≠ 摘除（连败是"连续"，不是"累计"）', async () => {
    const probe = makeFetch();
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    const hb = startHeartbeatProducer({ gate: makeGate(), nodes: [HK], inboxDir: null, probe: true, fetchFor: probe.fetchFor, now: clock.now });
    probe.set('bad');
    await hb.tick(); // 败 1
    await hb.tick(); // 败 2
    probe.set('good', '203.0.113.7');
    await hb.tick(); // 成 → 连败清零
    probe.set('bad');
    await hb.tick(); // 败 1
    await hb.tick(); // 败 2 —— 仍不到 3
    expect(hk0(hb).status).toBe('online');
    hb.stop();
  });

  it('摘除后滞回内的成功**不回池**；摘除满 5min 后的成功才回池', async () => {
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    const probe = makeFetch();
    const hb = startHeartbeatProducer({ gate: makeGate(), nodes: [HK], inboxDir: null, probe: true, fetchFor: probe.fetchFor, now: clock.now });
    probe.set('bad');
    for (let i = 0; i < HEARTBEAT_EVICT_AFTER_FAILURES; i += 1) {
      clock.advance(30_000);
      await hb.tick();
    }
    expect(hk0(hb).status).toBe('offline'); // 摘除于 T+90s
    probe.set('good', '203.0.113.7');
    clock.advance(2 * 60_000); // T+3.5min：滞回内
    await hb.tick();
    expect(hk0(hb).status).toBe('offline');
    clock.advance(2 * 60_000); // T+5.5min：距摘除 4.5min，仍内
    await hb.tick();
    expect(hk0(hb).status).toBe('offline');
    clock.advance(60_000); // T+6.5min：距摘除 5.5min ≥ 滞回
    await hb.tick();
    const snap = hk0(hb);
    expect(snap.status).toBe('online');
    expect(snap.exitIp).toBe('203.0.113.7');
    expect(HEARTBEAT_REJOIN_HYSTERESIS_MS).toBe(5 * 60_000);
    hb.stop();
  });
});

describe('口径 1：无证据不翻转状态（停摆 ≠ 离线）', () => {
  it('inbox 断供 1 小时：状态维持、lastHeartbeatAt 只是变旧', async () => {
    const dir = inboxDir();
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    inboxOk(dir, '10.0.0.1:8080', '203.0.113.7', '2026-10-10T00:00:00.000Z');
    const hb = startHeartbeatProducer({ gate: makeGate(), nodes: [HK], inboxDir: dir, now: clock.now });
    await hb.tick();
    clock.advance(60 * 60_000); // 断供：目录里没有新文件
    await hb.tick();
    const snap = hk0(hb);
    expect(snap.status).toBe('online');
    expect(snap.lastHeartbeatAt).toBe('2026-10-10T00:00:00.000Z'); // 旧值原样保留 —— 新鲜度归读面，不归生产者
    hb.stop();
  });
});

describe('口径 2：合成 429 零证据（本地拒绝不计失败）', () => {
  it('闸恒拒 → 连续 10 拍全被拒：不摘除、不产生 lastHeartbeatAt', async () => {
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    const probe = makeFetch();
    probe.set('deny');
    const hb = startHeartbeatProducer({ gate: makeGate(), nodes: [HK], inboxDir: null, probe: true, fetchFor: probe.fetchFor, now: clock.now });
    for (let i = 0; i < 10; i += 1) {
      clock.advance(30_000);
      await hb.tick();
    }
    const snap = hk0(hb);
    expect(snap.status).toBe('online');
    expect(snap.lastHeartbeatAt).toBeNull();
    expect(probe.calls).toHaveLength(10); // 每拍确实尝试过，只是被闸拒了
    hb.stop();
  });
});

describe('A 优先于 B（同一拍不叠两份证据）', () => {
  it('收件箱已覆盖的节点，本拍不再探活（探活调用只发生在未覆盖节点上）', async () => {
    const dir = inboxDir();
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    inboxOk(dir, '10.0.0.1:8080', '203.0.113.7', '2026-10-10T00:00:00.000Z');
    const probe = makeFetch();
    probe.set('good', '198.51.100.9');
    const hb = startHeartbeatProducer({ gate: makeGate(), nodes: [HK, US], inboxDir: dir, probe: true, fetchFor: probe.fetchFor, now: clock.now });
    await hb.tick();
    const snap = Object.fromEntries(hb.poolSnapshot().map((n) => [n.egressId, n]));
    expect(snap.eg_hk1?.exitIp).toBe('203.0.113.7'); // 来自收件箱
    expect(snap.eg_us1?.exitIp).toBe('198.51.100.9'); // 来自探活
    expect(probe.calls).toHaveLength(1); // hk 没被打第二次
    hb.stop();
  });
});

describe('帧字段与闸同源', () => {
  it('cooldownUntil 现取自闸：与 status 并列出现（两事实源不互盖）', () => {
    const untilMs = Date.parse('2026-10-10T00:05:00.000Z');
    const clock = fakeClock(Date.parse('2026-10-10T00:00:00.000Z'));
    const hb = startHeartbeatProducer({ gate: makeGate({ cooldownUntil: () => untilMs }), nodes: [HK], inboxDir: null, now: clock.now });
    const snap = hk0(hb);
    expect(snap.status).toBe('online'); // 池健康没被冷却盖掉
    expect(snap.cooldownUntil).toBe('2026-10-10T00:05:00.000Z'); // 绝对时刻 ISO8601 UTC
    hb.stop();
  });
});

describe('复制代价的判据（两处正则逐字同源）', () => {
  it('heartbeat.ts 与 routes/egress.ts 的 /test 用同一条 IP 形状正则', async () => {
    const { readFileSync } = await import('node:fs');
    const here = readFileSync(new URL('./heartbeat.ts', import.meta.url), 'utf8');
    const there = readFileSync(new URL('../api/routes/egress.ts', import.meta.url), 'utf8');
    const shape = /^[0-9a-fA-F:.]{3,45}$/.source;
    expect(here).toContain(shape);
    expect(there).toContain(shape);
  });
});
