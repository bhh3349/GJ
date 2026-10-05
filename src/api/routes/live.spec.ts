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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import type { AppConfig } from '../../config.js';
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
    logRetentionDays: 30,
    maxAttempts: 3,
    maxConcurrencyPerKey: 4,
    cooldownLadderSeconds: [0, 60, 300, 900, 1800],
  };
}

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'live-probe-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const app = buildApp({ db, config: makeConfig(dbPath) });
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
  last(type: string): Frame | undefined;
  waitFor(type: string, timeoutMs?: number): Promise<Frame>;
  waitClose(timeoutMs?: number): Promise<number>;
}

/** 收帧盒子：把异步到达的帧攒起来，断言侧按类型取。 */
function createBox(socket: WebSocket): Box {
  const received: Frame[] = [];
  let closeCode: number | null = null;
  let closeReason = '';

  socket.on('message', (raw: unknown) => {
    try {
      received.push(JSON.parse(frameText(raw)) as Frame);
    } catch {
      // 非 JSON 帧不该出现；丢掉，让"等不到某帧"的断言去暴露
    }
  });
  socket.on('close', (code: number, reason: Buffer) => {
    closeCode = code;
    closeReason = reason.toString('utf8');
  });

  const waitUntil = async <T>(get: () => T | undefined, label: string, timeoutMs: number): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = get();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) {
        throw new Error(`等待「${label}」超时（${timeoutMs}ms）；已收帧：${received.map((m) => String(m['type'])).join(',') || '（无）'}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };

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
    last: (type) => received.filter((m) => m['type'] === type).pop(),
    waitFor: (type, timeoutMs = 3000) => waitUntil(() => received.find((m) => m['type'] === type), type, timeoutMs),
    waitClose: (timeoutMs = 3000) => waitUntil(() => (closeCode === null ? undefined : closeCode), 'close', timeoutMs),
  };
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

/** 让已写出的帧走完事件循环（帧是异步到达的，断言前要让它落地）。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
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

  it('就绪超时：5s 内不发 auth 帧 → 服务端 4408', { timeout: 15_000 }, async () => {
    const h = await setup();
    const box = await openSocket(h, { cookie: h.cookie });
    // 这里的 5s 是契约自己规定的数字，缩短它就等于在测另一个契约
    expect(await box.waitClose(8000)).toBe(4408);
    expect(box.count('ready')).toBe(0);
  });
});

describe('WS /api/stats/live 推帧', () => {
  it('ready 带 serverTime/intervalMs；metrics 每 tick 一帧，口径与 §7 对齐', async () => {
    const h = await setup();
    const box = await openSocket(h, { cookie: h.cookie });
    box.socket.send(JSON.stringify({ type: 'auth' }));

    const ready = await box.waitFor('ready');
    expect(ready['intervalMs']).toBe(1000);
    expect(new Date(String(ready['serverTime'])).toISOString()).toBe(ready['serverTime']);

    h.app.liveHub.tickNow();
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
    h.app.liveHub.tickNow();
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
    h.app.liveHub.tickNow();
    await settle();
    expect(box.last('balance')?.['balance']).toBe(300);

    // 置回"未知"：必须是 null，不能被顺手写成 0
    const cleared = await h.app.inject({
      method: 'PUT',
      url: `/api/keys/${keyId}/balance`,
      headers: auth(h),
      payload: { balance: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    h.app.liveHub.tickNow();
    const afterClear = box.last('balance');
    await settle();
    const frames = box.received.filter((m) => m['type'] === 'balance');
    expect(frames[frames.length - 1]?.['balance']).toBeNull();
    expect(afterClear?.['balance']).toBe(300); // settle 前最后一帧仍是旧值：确认不是碰巧
  });

  it('差分：状态没变的 key 不重复推 key_health', async () => {
    const h = await setup();
    const upstreamId = await createUpstream(h);
    await createBalanceKey(h, upstreamId, 500);

    const box = await attach(h);
    h.app.liveHub.tickNow();
    await box.waitFor('key_health');
    await settle();

    h.app.liveHub.tickNow();
    h.app.liveHub.tickNow();
    await settle();
    // 三帧 metrics（每 tick 都有），但 key_health 只在第一 tick 出现一次
    expect(box.count('key_health')).toBe(1);
    expect(box.count('metrics')).toBeGreaterThanOrEqual(3);
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
