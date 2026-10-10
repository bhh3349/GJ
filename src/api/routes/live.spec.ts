// 实时通道 `WS /api/stats/live` 的验收测试（契约 §7）。
//
// 这里断言的都是**线上不可观测、但一破就静默出错**的东西：
//   1. 未登录时是「升级成功后 4401」而不是 HTTP 401 —— 401 会让浏览器把连接报成
//      异常中断（1006），前端于是把"会话过期"当成"服务不可用"，跳登录页变成无限退避重连；
//   2. 跨站 Origin 被拒 —— 少了这条，任何网页都能借受害者的 Cookie 读走我们的仪表盘；
//   3. 未知余额推 `null` 而不是 `0`（ADR-0003 的纪律在实时通道上同样成立，
//      推成 0 会让"查不到"看起来像"没钱了"）；
//   4. 状态没变就不重复推（差分），否则 1s 一帧的全量 key 列表会把内网带宽和前端渲染都吃掉；
//   5. 关停用 1012 而不是 1000。（用错码前端会"永不重连"，一次部署重启把所有仪表盘
//      永久留在断开态。）
//
// 关闭码在断言里写**字面量**而不是引 `WS_CLOSE`：契约 §7 才是判据，
// 引用被测代码里的常量会让"常量被改错"这类回归测试不出来。
//
// **确定性纪律**（本文件不接受"睡一觉再断言"）：
//   帧到达是事件，不是时间。等待一律挂在 socket 的 `message`/`close` 事件上
//   （`waitFor*` 的 timeout 只把"永远等不到"变成一条带上下文的失败信息，不参与通过路径）；
//   "状态没变就不推"这类**否定断言**用 `metrics` 做拍边界屏障 —— 同一拍里它是**首帧**，
//   所以"收到第 n 帧 metrics"等价于"第 n-1 拍发出的帧全部已经过线"，无需赌时间窗。
//   拍子本身也归测试所有（`liveAutoTick: false`）：真实的 1s 定时器只要还在跑，
//   长用例就会被它插进额外的拍，屏障计数随之失真。
//   唯一的真实时钟断言是就绪超时：那个 5s 是契约自己规定的数字，缩短它就是在测另一个契约。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { AppConfig } from '../../config.js';
import type { EgressPoolNode } from '../../egress/heartbeat.js';
import { openDatabase, type Db } from '../../db/database.js';
import { buildApp } from '../app.js';
import { bootstrapAdmin } from '../auth.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'live-probe-pass-1';

const dirs: string[] = [];
const live: Harness[] = [];
const sockets: WebSocket[] = [];

/** 与 api.spec.ts 同一条纪律：收尾统一在 afterEach，否则断言失败会漏句柄，清理错误盖掉真失败。 */
afterEach(async () => {
  for (const s of sockets.splice(0)) {
    try {
      s.terminate();
    } catch {
      /* 已关 */
    }
  }
  for (const h of live.splice(0)) {
    await h.app.close().catch(() => undefined);
    try {
      h.db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上偶尔仍被短时占用，临时目录不影响判据 */
    }
  }
});

interface Harness {
  app: FastifyInstance;
  db: Db;
  cookie: string;
}

function makeConfig(dbPath: string): AppConfig {
  return {
    masterKey: Buffer.from('2a'.repeat(32), 'hex'),
    dbPath,
    portGateway: 0,
    hostGateway: '127.0.0.1',
    portAdmin: 0,
    hostAdmin: '127.0.0.1',
    sessionTtlHours: 24,
    cookieSecure: false,
    trustProxy: false,
    // 空数组 = 仅同源。跨站用例必须在这个（默认）口径下被拒
    allowedOrigins: [],
    adminToken: null,
    readonlyToken: null,
    logRetentionDays: 30,
    healthSnapshotRetentionDays: 90,
    maxAttempts: 3,
    maxConcurrencyPerKey: 4,
    cooldownLadderSeconds: [0, 60, 300, 900, 1800],
    assistantModel: null,
    egressHeartbeatInboxDir: null,
    // 余额自动同步在测试配置里默认关：本套用例不为它开后台定时器（它有自己的 spec）
    balanceSyncMinutes: 0,
    balanceSnapshotRetentionDays: 90,
  };
}

async function setup(
  seams: { egressPool?: () => readonly EgressPoolNode[] } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'live-probe-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  // 关掉真实的 1s 推帧定时器：拍子只由 `tick(h, box, n)` 驱动。
  // 留着它的话，一条用例只要跑过 1s，屏障计数就会被它插进来的拍污染。
  // 默认**不注入**出口池 provider：发射缝必须能在「压根没接线」这个状态下被验，
  // 而不是只验「接线了但池子空」—— 那是两个不同的事实（方案 A 的缺省语义）。
  const app = buildApp({ db, config: makeConfig(dbPath), liveAutoTick: false, ...seams });
  bootstrapAdmin(db, { ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS });

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: ADMIN_USER, password: ADMIN_PASS },
    headers: { 'x-requested-with': 'fetch' },
  });
  expect(res.statusCode, `登录失败: ${res.body}`).toBe(200);
  const raw = res.headers['set-cookie'];
  const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
  const h: Harness = { app, db, cookie };
  live.push(h);
  return h;
}

/** 带会话 + CSRF 头的 REST 请求头。 */
function auth(h: Harness, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: h.cookie, 'x-requested-with': 'fetch', ...extra };
}

type Frame = Record<string, unknown>;

function frameText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString('utf8');
  return String(raw);
}

interface Box {
  socket: WebSocket;
  received: Frame[];
  closeCode: number | null;
  closeReason: string;
  count(type: string): number;
  frames(type: string): Frame[];
  last(type: string): Frame | undefined;
  waitFor(type: string, timeoutMs?: number): Promise<Frame>;
  /** 等**任意一帧**满足谓词（用于"同一个 type 的第二个/第三个值"这种断言）。 */
  waitForFrame(pred: (f: Frame) => boolean, label: string, timeoutMs?: number): Promise<Frame>;
  waitForCount(type: string, n: number, timeoutMs?: number): Promise<void>;
  waitClose(timeoutMs?: number): Promise<number>;
}

/** 收帧盒子：把异步到达的帧攒起来，并在帧到达的那一刻唤醒等待者。 */
function createBox(socket: WebSocket): Box {
  const received: Frame[] = [];
  let closeCode: number | null = null;
  let closeReason = '';

  /**
   * 等待者只在**事件**里被唤醒：帧到达即检查，不轮询。
   * 轮询式等待（`for(;;) sleep(5)`）在实现上仍是对的，但它把"多久之后算失败"和
   * "多久之后算成功"绑在同一个真实时钟上 —— 这里是刻意不留这条缝。
   */
  const waiters = new Set<{ check: () => boolean }>();

  const signal = (): void => {
    for (const w of [...waiters]) {
      if (w.check()) waiters.delete(w); // check() 命中时内部已经 resolve
    }
  };

  socket.on('message', (raw: unknown) => {
    try {
      received.push(JSON.parse(frameText(raw)) as Frame);
    } catch {
      // 非 JSON 帧不该出现；丢掉，让"等不到某帧"的断言去暴露
    }
    signal();
  });
  socket.on('close', (code: number, reason: Buffer) => {
    closeCode = code;
    closeReason = reason.toString('utf8');
    signal();
  });

  const describeReceived = (): string =>
    received.map((m) => String(m['type'])).join(',') || '（无）';

  function waitFor<T>(check: () => T | undefined, label: string, timeoutMs: number): Promise<T> {
    const hit = check();
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`等待「${label}」超时（${timeoutMs}ms）；已收帧：${describeReceived()}`));
      }, timeoutMs);
      const waiter: { check: () => boolean } = {
        check: () => {
          const value = check();
          if (value === undefined) return false;
          clearTimeout(timer);
          resolve(value);
          return true;
        },
      };
      waiters.add(waiter);
    });
  }

  return {
    socket,
    received,
    get closeCode() {
      return closeCode;
    },
    get closeReason() {
      return closeReason;
    },
    count: (type) => received.filter((m) => m['type'] === type).length,
    frames: (type) => received.filter((m) => m['type'] === type),
    last: (type) => received.filter((m) => m['type'] === type).pop(),
    waitFor: (type, timeoutMs = 3000) => waitFor(() => received.find((m) => m['type'] === type), type, timeoutMs),
    waitForFrame: (pred, label, timeoutMs = 3000) => waitFor(() => received.find(pred), label, timeoutMs),
    waitForCount: async (type, n, timeoutMs = 3000) => {
      await waitFor(
        () => (received.filter((m) => m['type'] === type).length >= n ? true : undefined),
        `第 ${n} 帧 ${type}`,
        timeoutMs,
      );
    },
    waitClose: (timeoutMs = 3000) => waitFor(() => (closeCode === null ? undefined : closeCode), 'close', timeoutMs),
  };
}

/**
 * 跑第 `n` 拍，返回时保证**第 `n-1` 拍**发出的帧全部已经到齐。
 *
 * 屏障之所以成立：`live.ts` 在同一拍里把 `metrics` 作为**首帧**发出（下一用例钉死这条），
 * 而单条连接上的帧保序，所以"收到第 n 帧 metrics"⇒"第 n-1 拍的所有帧都已经过线"。
 * 于是否定断言（"不该多出一帧 key_health"）不必再靠 settle 赌时间窗：
 * 想断言前 n 拍，就多跑一拍当屏障，然后读到的就是前 n 拍的完整集合。
 */
async function tick(h: Harness, box: Box, n: number): Promise<void> {
  h.app.liveHub.tickNow();
  await box.waitForCount('metrics', n);
}

/** 仅注入连接（不握手），用于"握手之前就该被拒"的用例。 */
async function openSocket(h: Harness, headers: Record<string, string> = {}): Promise<Box> {
  const socket = await h.app.injectWS('/api/stats/live', { headers });
  sockets.push(socket);
  return createBox(socket);
}

/** 完整握手：连接 → 首帧 `{"type":"auth"}` → 等 `ready`。 */
async function attach(h: Harness): Promise<Box> {
  const box = await openSocket(h, { cookie: h.cookie });
  box.socket.send(JSON.stringify({ type: 'auth' }));
  await box.waitFor('ready');
  return box;
}

async function createUpstream(h: Harness): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/upstreams',
    headers: auth(h),
    payload: { name: 'live-up', baseUrl: 'https://upstream.example.com' },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/**
 * 伪造 key 明文。**必须运行时拼接**，不能写成连续字面量：
 * `check:secrets` 的 provider-key-literal 规则会把它当成真 key 抓出来（本文件第一版
 * 就因此红过），而"扫到疑似 key 就改豁免"是消掉判据，不是修问题。
 * 与 api.spec.ts 的 probeSecret() 同一手法。
 */
function probeKey(label: string): string {
  return ['sk', 'live', 'probe', label].join('-');
}

async function createBalanceKey(h: Harness, upstreamId: string, balance: number): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/keys',
    headers: auth(h),
    payload: { upstreamId, key: probeKey('balance-0001'), category: 'balance', balance },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

describe('WS /api/stats/live 握手与鉴权', () => {
  it('未登录：升级成功但立刻 4401（不是 HTTP 401）', async () => {
    const h = await setup();
    const box = await openSocket(h); // 不带 Cookie
    expect(await box.waitClose()).toBe(4401);
  });

  it('跨站 Origin 被拒：1008，且不发 ready', async () => {
    const h = await setup();
    const box = await openSocket(h, { cookie: h.cookie, origin: 'https://evil.example' });
    expect(await box.waitClose()).toBe(1008);
    expect(box.count('ready')).toBe(0);
  });

  it('同源 Origin 放行：含"默认端口只写在 Host 里"的写法', async () => {
    const h = await setup();
    // 第一种是最常见的一档：非默认端口，两边都带端口
    const plain = await openSocket(h, { cookie: h.cookie, origin: 'http://localhost:8080', host: 'localhost:8080' });
    plain.socket.send(JSON.stringify({ type: 'auth' }));
    expect((await plain.waitFor('ready'))['intervalMs']).toBe(1000);

    // 第二种：浏览器发 `Origin: http://localhost`（默认端口不写），
    // 而反代用 $http_host 透传成 `Host: localhost:80`。这是同一站点，
    // 判成跨站的话写请求会被 CSRF 全挡下、仪表盘永远连不上。
    const proxied = await openSocket(h, { cookie: h.cookie, origin: 'http://localhost', host: 'localhost:80' });
    proxied.socket.send(JSON.stringify({ type: 'auth' }));
    expect((await proxied.waitFor('ready'))['intervalMs']).toBe(1000);
  });

  it('非升级的普通 GET 落回 404，不绕过鉴权闸门', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/stats/live', headers: auth(h) });
    expect(res.statusCode).toBe(404);
  });

  it('就绪超时：5s 内不发 auth 帧 → 服务端 4408', { timeout: 20_000 }, async () => {
    const h = await setup();
    const box = await openSocket(h, { cookie: h.cookie });
    const startedAt = Date.now();
    // 唯一一处必须走真实时钟的断言。5s 是契约自己规定的数字，缩短它就等于在测另一个契约。
    // 下界是确定的（定时器不会提前触发）：没有它，"实现改成 1s 就关"这种回归测不出来。
    expect(await box.waitClose(15_000)).toBe(4408);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_800);
    expect(box.count('ready')).toBe(0);
  });
});

describe('WS /api/stats/live 推帧', () => {
  it('同一拍内 metrics 是首帧 —— 本文件所有「第 n 帧 metrics = 拍屏障」都建立在这条上', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    await createBalanceKey(h, upstreamId, 500);

    const box = await attach(h);
    await tick(h, box, 1);
    await box.waitFor('key_health');
    // 屏障锚点：metrics 先于本拍的差分帧。顺序变了这条会当场红，
    // 而不是让别的用例静默失去屏障、退回"赌时间窗"。
    expect(box.received[0]?.['type']).toBe('ready');
    expect(box.received[1]?.['type']).toBe('metrics');
  });

  it('ready 带 serverTime/intervalMs；metrics 每 tick 一帧，口径与 §7 对齐', async () => {
    const h = await setup();
    const box = await openSocket(h, { cookie: h.cookie });
    box.socket.send(JSON.stringify({ type: 'auth' }));

    const ready = await box.waitFor('ready');
    expect(ready['intervalMs']).toBe(1000);
    expect(new Date(String(ready['serverTime'])).toISOString()).toBe(ready['serverTime']);

    await tick(h, box, 1);
    const metrics = await box.waitFor('metrics');
    expect(metrics['window']).toBe('60s');
    expect(metrics['requests']).toBe(0);
    expect(metrics['tokensTotal']).toBe(0);
    // 一把 key 都没有 = 余额未知。未知是 null，不是 0（ADR-0003）
    expect(metrics['balanceGlobal']).toBeNull();
    expect(metrics['balanceUnknownKeyCount']).toBe(0);
  });

  it('余额变动推 balance 帧；置回未知推 null 而不是 0', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    const keyId = await createBalanceKey(h, upstreamId, 1200);

    const box = await attach(h);
    await tick(h, box, 1);
    const first = await box.waitFor('balance');
    expect(first['keyId']).toBe(keyId);
    expect(first['balance']).toBe(1200);
    expect(first['balanceSource']).toBe('manual');
    expect(first['globalTotalBalance']).toBe(1200);

    // 录入新金额
    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/keys/${keyId}/balance`,
      headers: auth(h),
      payload: { balance: 300 },
    });
    expect(put.statusCode, put.body).toBe(200);
    await tick(h, box, 2);
    await box.waitForFrame((f) => f['type'] === 'balance' && f['balance'] === 300, 'balance=300');

    // 置回"未知"：必须是 null，不能被顺手写成 0
    const cleared = await h.app.inject({
      method: 'PUT',
      url: `/api/keys/${keyId}/balance`,
      headers: auth(h),
      payload: { balance: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    await tick(h, box, 3);
    await box.waitForFrame((f) => f['type'] === 'balance' && f['balance'] === null, 'balance=null');
    await tick(h, box, 4); // 屏障：第 3 拍全部到齐

    // 断言**整条序列**而不是"最后读到什么就是什么"：多推一帧、漏推一帧、
    // 或把 null 写成 0，都会在这里现形
    expect(box.frames('balance').map((f) => f['balance'])).toEqual([1200, 300, null]);
  });

  it('差分：状态没变的 key 不重复推 key_health', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    await createBalanceKey(h, upstreamId, 500);

    const box = await attach(h);
    await tick(h, box, 1);
    await box.waitFor('key_health');

    // 第 2、3 拍照跑，第 4 拍只当屏障：它到齐即证明前 3 拍一帧不漏地都在
    await tick(h, box, 2);
    await tick(h, box, 3);
    await tick(h, box, 4);

    // 新连接的首拍推全量（它什么都没记过），此后状态没变就不该再有 key_health
    expect(box.count('key_health')).toBe(1);
    expect(box.count('metrics')).toBe(4); // 每拍恰好一帧
  });

  it('egress_pool 未接线：每拍首连发一帧 `nodes: []`，状态没变就不重复推', async () => {
    // 方案 A 的缺省语义 —— 这条是本笔发射缝的**唯一**判据，别删：
    // 「没接线」必须表现成**一帧空池**（生产者在场、池为空），而不是**没有帧**。
    // 少了这一帧，前端 EgressPoolCard 会永远停在「等待数据」，而它等的东西根本不会来。
    const h = await setup();
    const box = await attach(h);

    await tick(h, box, 1);
    const pool = await box.waitFor('egress_pool');
    expect(pool['serverTime']).toBeTruthy();
    expect(pool['nodes']).toEqual([]);

    await tick(h, box, 2);
    await tick(h, box, 3);
    await tick(h, box, 4); // 屏障：第 3 拍全部到齐

    // 差分：指纹没变（仍是空池）就只该有第一帧那一条
    expect(box.count('egress_pool')).toBe(1);
  });

  it('egress_pool 接线后：状态翻转推新帧；`cooldownUntil` 自然到期也推（不靠写入动作）', async () => {
    // 这台状态机是可造的（provider 每次调用回什么由测试决定），所以能精确钉住
    // 「同 tick 同一份快照」与指纹纪律。真实生产者由 heartbeat.spec.ts 判。
    const node = (over: Partial<EgressPoolNode>): EgressPoolNode => ({
      egressId: '10.0.0.9:8080',
      name: 'vps-hk-1',
      status: 'online',
      exitIp: '203.0.113.7',
      expectedExitIp: '203.0.113.7',
      lastHeartbeatAt: '2026-10-09T00:00:00.000Z',
      cooldownUntil: null,
      ...over,
    });
    let current: readonly EgressPoolNode[] = [node({})];
    const h = await setup({ egressPool: () => current });
    const box = await attach(h);

    await tick(h, box, 1);
    const first = await box.waitFor('egress_pool');
    expect(first['nodes']).toEqual(current);

    // 一次状态翻转（在线 → 摘除）必须推新帧
    current = [node({ status: 'offline', exitIp: null, cooldownUntil: null })];
    await tick(h, box, 2);
    await box.waitForFrame(
      (f) =>
        f['type'] === 'egress_pool' &&
        (f['nodes'] as Array<Record<string, unknown>>)[0]?.['status'] === 'offline',
      'egress_pool=offline',
    );

    // 冷却**自然到期**那一刻没有任何写入：指纹不带 cooldownUntil 的话，
    // 卡片会停在「冷却中」直到下一次状态变化 —— 与 key_health 同一个坑。
    current = [node({ status: 'online', exitIp: '203.0.113.7' })];
    await tick(h, box, 3);
    await box.waitForFrame(
      (f) =>
        f['type'] === 'egress_pool' &&
        (f['nodes'] as Array<Record<string, unknown>>)[0]?.['status'] === 'online',
      'egress_pool 回池',
    );
    await tick(h, box, 4); // 屏障

    expect(box.count('egress_pool')).toBe(3);
  });

  it('会话在连接中途失效：4401 关连接（不是等到自然过期）', async () => {
    const h = await setup();
    const box = await attach(h);

    // 撤销会话（等价于管理员改口令/会话被清理）
    h.db.prepare('DELETE FROM sessions').run();

    // 复查是每 5 个 tick 一次：这里用 tickNow 把它推快，不依赖真实时钟
    for (let i = 0; i < 5; i += 1) h.app.liveHub.tickNow();
    expect(await box.waitClose()).toBe(4401);
    expect(h.app.liveHub.size()).toBe(0);
  });
});

describe('WS /api/stats/live 关停', () => {
  it('服务关停：1012 而不是 1000（1000 = 前端不再重连）', async () => {
    const h = await setup();
    const box = await attach(h);

    await h.app.close();
    expect(await box.waitClose()).toBe(1012);
  });
});
