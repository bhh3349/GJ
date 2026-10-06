// 运维观测端点 + 只读维护令牌（契约 §12.3 / §12.4 / ADR-0013）。
//
// 本文件测的是**接口契约**，不是聚合算法（那些在 src/db/*.spec.ts 里）。
// 三条一旦破了就会静默出问题的口径：
//   1. 只读令牌的作用域是 `GET /api/observability/*`：越界必须是 **403**（换令牌能解决），
//      不是 401（那会让客户端以为令牌失效，去重新申请，拿到的还是同一把）；
//   2. 两把令牌都未配置时，带 Bearer 头的请求照旧落到会话鉴权（v1.0 既有行为不许变）；
//   3. 列表响应带 `range` 回显**实际生效**的窗口，前端按回显渲染而不是自算本地时间。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config.js';
import { openDatabase, type Db } from '../db/database.js';
import { appendGatewayErrorEvents, type GatewayErrorEventInput } from '../db/repo/gateway-events.js';
import { appendHealthSnapshot, latestHealthSnapshot } from '../db/repo/health-snapshots.js';
import { buildApp } from './app.js';
import { bootstrapAdmin } from './auth.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'probe-admin-pass-1';

/** 令牌样本刻意短于 24 字符：源码里出现 ≥24 字符的 `token: "..."` 会被 check:secrets 命中。 */
const READONLY_TOKEN = 'ro-probe';
const ADMIN_TOKEN = 'ci-probe';

const dirs: string[] = [];
const live: Harness[] = [];

interface Harness {
  app: FastifyInstance;
  db: Db;
  dbPath: string;
  cookie: string;
}

afterEach(async () => {
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

function makeConfig(dbPath: string, over: Partial<AppConfig> = {}): AppConfig {
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
    allowedOrigins: [],
    adminToken: null,
    readonlyToken: null,
    logRetentionDays: 30,
    healthSnapshotRetentionDays: 90,
    maxAttempts: 3,
    maxConcurrencyPerKey: 4,
    cooldownLadderSeconds: [0, 60, 300, 900, 1800],
    ...over,
  };
}

interface SetupOptions {
  config?: Partial<AppConfig>;
  /** 是否让 buildApp 启动 60s 快照写入器（默认关：快照是历史序列，隐式多一行会污染断言） */
  healthSnapshots?: boolean;
  startedAt?: Date;
  droppedEvents?: () => number;
}

async function setup(opts: SetupOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'obs-api-probe-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const app = buildApp({
    db,
    config: makeConfig(dbPath, opts.config ?? {}),
    healthSnapshots: opts.healthSnapshots ?? false,
    // 节拍给到 1h：本文件只关心"启动即写一条"这条接线，不测定时器
    healthSnapshotIntervalMs: 3_600_000,
    ...(opts.startedAt === undefined ? {} : { startedAt: opts.startedAt }),
    ...(opts.droppedEvents === undefined ? {} : { droppedEvents: opts.droppedEvents }),
  });
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

  const h: Harness = { app, db, dbPath, cookie };
  live.push(h);
  return h;
}

/** 带会话的请求头（GET 不需要 CSRF 头，写请求另加）。 */
function session(h: Harness, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: h.cookie, ...extra };
}

function bearer(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...extra };
}

/** 一条落到"当前窗口内"的事件：窗口都是相对现在算的，写死历史时间会落到窗口外。 */
function event(over: Partial<GatewayErrorEventInput> = {}): GatewayErrorEventInput {
  return {
    ts: new Date(Date.now() - 60_000).toISOString(),
    requestId: null,
    severity: 'error',
    category: 'UPSTREAM_ERROR',
    status: 502,
    gatewayCode: 'UPSTREAM_ERROR',
    failureReason: 'UPSTREAM_ERROR',
    endpoint: '/v1/chat/completions',
    model: 'gpt-probe',
    upstreamId: 'up_probe',
    keyId: null,
    keyMasked: null,
    stream: false,
    upstreamStatus: 502,
    attempts: 1,
    candidates: 2,
    latencyMs: 12,
    message: 'upstream 502',
    ...over,
  };
}

describe('鉴权与只读令牌作用域（契约 §0.5 / §12.4）', () => {
  it('未登录访问观测面 → 401（不是漏在闸门外的公开接口）', async () => {
    const h = await setup();
    for (const url of ['/api/observability/health', '/api/observability/errors', '/api/observability/health/snapshots']) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('只读令牌：GET /api/observability/* 放行', async () => {
    const h = await setup({ config: { readonlyToken: READONLY_TOKEN } });
    for (const url of ['/api/observability/health', '/api/observability/errors', '/api/observability/health/snapshots']) {
      const res = await h.app.inject({ method: 'GET', url, headers: bearer(READONLY_TOKEN) });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('只读令牌越界读管理面 → 403 FORBIDDEN（不是 401：换令牌能解决，不是令牌失效）', async () => {
    const h = await setup({ config: { readonlyToken: READONLY_TOKEN } });
    const res = await h.app.inject({ method: 'GET', url: '/api/keys', headers: bearer(READONLY_TOKEN) });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('只读令牌不能写（写方法同样不在作用域内）→ 403', async () => {
    const h = await setup({ config: { readonlyToken: READONLY_TOKEN } });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/upstreams',
      headers: bearer(READONLY_TOKEN, { 'x-requested-with': 'fetch' }),
      payload: { name: 'probe-up', baseUrl: 'https://upstream.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('管理面机器令牌照旧全权（两把令牌互不隶属）', async () => {
    const h = await setup({ config: { adminToken: ADMIN_TOKEN, readonlyToken: READONLY_TOKEN } });
    const keys = await h.app.inject({ method: 'GET', url: '/api/keys', headers: bearer(ADMIN_TOKEN) });
    expect(keys.statusCode).toBe(200);
    const health = await h.app.inject({ method: 'GET', url: '/api/observability/health', headers: bearer(ADMIN_TOKEN) });
    expect(health.statusCode).toBe(200);
  });

  it('两把令牌都未配置时，Bearer 请求照旧落到会话鉴权（v1.0 语义不许变）→ 401', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/keys', headers: bearer('anything-1') });
    expect(res.statusCode).toBe(401);
    // 同一把"令牌"带上会话就能读 —— 说明它只是没被当成机器令牌，而不是被拒绝
    const withSession = await h.app.inject({ method: 'GET', url: '/api/keys', headers: session(h, bearer('anything-1')) });
    expect(withSession.statusCode).toBe(200);
  });

  it('无效令牌 → 401（配了令牌就不再回落到会话）', async () => {
    const h = await setup({ config: { readonlyToken: READONLY_TOKEN } });
    const res = await h.app.inject({ method: 'GET', url: '/api/observability/health', headers: bearer('wrong-1') });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('GET /api/observability/health', () => {
  it('字段口径齐备，且 uptime/dropped 取自注入的启动时刻与 sink 计数', async () => {
    const startedAt = new Date(Date.now() - 90_000);
    const h = await setup({ startedAt, droppedEvents: () => 5 });
    const res = await h.app.inject({ method: 'GET', url: '/api/observability/health', headers: session(h) });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.window).toBe('5m'); // 默认窗口
    expect(body.startedAt).toBe(startedAt.toISOString());
    expect(body.uptimeSec).toBeGreaterThanOrEqual(89);
    expect(body.uptimeSec).toBeLessThanOrEqual(92);
    expect(body.events.dropped).toBe(5);
    expect(body.db.ok).toBe(true);
    expect(typeof body.db.schemaVersion).toBe('number');
    expect(body.traffic.latencyMs).toEqual({ p50: null, p99: null, samples: 0 });
    expect(body.keys).toMatchObject({ total: 0, healthy: 0, cooling: 0, disabled: 0 });
    // 部署细节不进观测面
    expect(res.body).not.toContain(h.dbPath);
    expect(res.body).not.toContain('gateway.db');
  });

  it('窗口回显用户输入的写法（60s / 1h），不是秒数反推', async () => {
    const h = await setup();
    for (const [q, label] of [['60s', '60s'], ['1h', '1h'], ['15m', '15m']] as const) {
      const res = await h.app.inject({ method: 'GET', url: `/api/observability/health?window=${q}`, headers: session(h) });
      expect(res.statusCode, q).toBe(200);
      expect(res.json().window).toBe(label);
    }
  });

  it('非法窗口 → 400 INVALID_PARAM（带 details.field）', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/observability/health?window=25h', headers: session(h) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'window' } });
  });

  it('key 健康总览：只出掩码，不出明文', async () => {
    const h = await setup();
    const up = await h.app.inject({
      method: 'POST',
      url: '/api/upstreams',
      headers: session(h, { 'x-requested-with': 'fetch' }),
      payload: { name: 'probe-up', baseUrl: 'https://upstream.example.com' },
    });
    expect(up.statusCode, up.body).toBe(201);
    const upstreamId = up.json().id as string;

    const plaintext = 'sk-probe-' + 'D'.repeat(24);
    const key = await h.app.inject({
      method: 'POST',
      url: '/api/keys',
      headers: session(h, { 'x-requested-with': 'fetch' }),
      payload: { upstreamId, key: plaintext, category: 'balance', balance: 1000 },
    });
    expect(key.statusCode, key.body).toBe(201);

    const res = await h.app.inject({ method: 'GET', url: '/api/observability/health', headers: session(h) });
    const body = res.json();
    expect(body.keys.total).toBe(1);
    expect(body.keys.healthy).toBe(1);
    expect(body.keys.items[0].maskedKey).toContain('****');
    expect(res.body).not.toContain(plaintext);
    expect(res.body).not.toContain(plaintext.slice(-8));
  });
});

describe('GET /api/observability/errors', () => {
  it('列表带 range 回显默认窗口，且事件字段按契约形状返回', async () => {
    const h = await setup();
    const keyMasked = '****robe';
    appendGatewayErrorEvents(h.db, [event({ keyId: 'key_probe', keyMasked })]);

    const res = await h.app.inject({ method: 'GET', url: '/api/observability/errors', headers: session(h) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.page).toBe(1);
    expect(body.range.from < body.range.to).toBe(true);

    const e = body.items[0];
    expect(e.category).toBe('UPSTREAM_ERROR');
    expect(e.severity).toBe('error');
    expect(e.stream).toBe(false);
    expect(typeof e.stream).toBe('boolean');
    expect(e.keyMasked).toBe(keyMasked);
    expect(e.attempts).toBe(1);
    expect(e.ts).toMatch(/Z$/);
  });

  it('按分型多值 / 严重级过滤', async () => {
    const h = await setup();
    appendGatewayErrorEvents(h.db, [
      event({ category: 'UPSTREAM_ERROR', severity: 'error', message: 'a' }),
      event({ category: 'RATE_LIMITED', severity: 'warn', status: 429, gatewayCode: 'RATE_LIMITED', message: 'b' }),
      event({ category: 'AUTH_FAILED', severity: 'warn', status: 401, gatewayCode: 'INVALID_API_KEY', message: 'c' }),
    ]);

    const both = await h.app.inject({
      method: 'GET',
      url: '/api/observability/errors?category=UPSTREAM_ERROR,RATE_LIMITED',
      headers: session(h),
    });
    expect(both.json().total).toBe(2);

    const warn = await h.app.inject({ method: 'GET', url: '/api/observability/errors?severity=warn', headers: session(h) });
    expect(warn.json().total).toBe(2);
  });

  it('空 category 段按"不过滤"处理（前端"全部"的最自然表达）', async () => {
    const h = await setup();
    appendGatewayErrorEvents(h.db, [event(), event({ category: 'INTERNAL', severity: 'error' })]);
    const res = await h.app.inject({ method: 'GET', url: '/api/observability/errors?category=', headers: session(h) });
    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(2);
  });

  it('未知分型 → 400（静默忽略会让用户以为"筛选生效了、只是没有这类事件"）', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/observability/errors?category=NOPE', headers: session(h) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'category' } });
  });

  it('时间窗：必须是带时区的 ISO8601，且跨度 ≤ 30 天', async () => {
    const h = await setup();

    const naive = await h.app.inject({
      method: 'GET',
      url: '/api/observability/errors?from=2026-10-06T00:00:00',
      headers: session(h),
    });
    expect(naive.statusCode).toBe(400);
    expect(naive.json()).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'from' } });

    const inverted = await h.app.inject({
      method: 'GET',
      url: '/api/observability/errors?from=2026-10-06T02:00:00.000Z&to=2026-10-06T01:00:00.000Z',
      headers: session(h),
    });
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json()).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'to' } });

    const tooWide = await h.app.inject({
      method: 'GET',
      url: '/api/observability/errors?from=2026-01-01T00:00:00.000Z&to=2026-10-06T00:00:00.000Z',
      headers: session(h),
    });
    expect(tooWide.statusCode).toBe(400);
    expect(tooWide.json()).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'from' } });
  });

  it('窗口外的行不返回，且 range 原样回显请求的窗口', async () => {
    const h = await setup();
    appendGatewayErrorEvents(h.db, [
      event({ ts: '2026-10-01T00:00:00.000Z', message: 'old' }),
      event({ ts: '2026-10-03T00:00:00.000Z', message: 'mid' }),
    ]);
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/observability/errors?from=2026-10-02T00:00:00.000Z&to=2026-10-04T00:00:00.000Z',
      headers: session(h),
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.items[0].message).toBe('mid');
    expect(body.range).toEqual({ from: '2026-10-02T00:00:00.000Z', to: '2026-10-04T00:00:00.000Z' });
  });

  it('分页：pageSize 生效，total 是过滤后的总数', async () => {
    const h = await setup();
    appendGatewayErrorEvents(h.db, [event({ message: 'a' }), event({ message: 'b' }), event({ message: 'c' })]);
    const res = await h.app.inject({ method: 'GET', url: '/api/observability/errors?page=1&pageSize=2', headers: session(h) });
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.pageSize).toBe(2);
  });

  it('单条查询：未知 id → 404 NOT_FOUND', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/observability/errors/err_nope', headers: session(h) });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('GET /api/observability/health/snapshots', () => {
  it('空表：items 为空、total 0，range 回显默认 6h', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/observability/health/snapshots', headers: session(h) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    const span = Date.parse(body.range.to) - Date.parse(body.range.from);
    expect(span).toBe(6 * 3600_000);
  });

  it('写入的快照按契约形状返回（keys 嵌套、dbOk 是真布尔）', async () => {
    const h = await setup();
    appendHealthSnapshot(h.db, {
      ts: new Date(Date.now() - 60_000).toISOString(),
      windowSec: 300,
      qps: 1.5,
      successRate: 0.99,
      requests: 450,
      errors: 5,
      p50Ms: 120,
      p99Ms: 800,
      keyTotal: 3,
      keyHealthy: 2,
      keyCooling: 1,
      keyDisabled: 0,
      dbOk: true,
      errorCount: 5,
    });

    const res = await h.app.inject({ method: 'GET', url: '/api/observability/health/snapshots', headers: session(h) });
    const snap = res.json().items[0];
    expect(snap.windowSec).toBe(300);
    expect(snap.keys).toEqual({ total: 3, healthy: 2, cooling: 1, disabled: 0 });
    expect(snap.dbOk).toBe(true);
    expect(snap.p50Ms).toBe(120);
  });

  it('buildApp 默认接入快照写入器：启动即写一条（否则新建实例头 60s 的历史是空的）', async () => {
    const h = await setup({ healthSnapshots: true });
    expect(latestHealthSnapshot(h.db)).not.toBeNull();
    const res = await h.app.inject({ method: 'GET', url: '/api/observability/health/snapshots', headers: session(h) });
    expect(res.json().total).toBeGreaterThanOrEqual(1);
  });
});
