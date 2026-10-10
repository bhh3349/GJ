// `GET /api/stats/balance/sync`（契约 §14.3 / §14.6）的路由层验收。
//
// 与 `src/api/balance-sync.spec.ts` 分工**不重叠**：那边测调度器的节奏（抖动 / 退避 /
// 单飞 / 裁剪）与快照的写入时机，这边只测**这一条线上路径**上会被读到的形状与口径：
//
//   1. **窗口**：默认 `6h`（不是 overview 的 60s），回显的是 `{from, to}` 而不是标签；
//      不可解析 / 超 24h → `400 INVALID_PARAM` + `details.field="window"`；
//   2. **本节没有等长 `axis`**（§14.3 明确与 §6 不同）：`series[].points[]` 自带 `t`。
//      这条不是排版偏好 —— 同步节奏本身不规则（抖动 + 退避 + 关闭期），
//      造一条均匀轴就得发明不存在的点；
//   3. **`lastSyncedAt` 不受窗口限制**：它答的是"最近一次同步完成于何时"，
//      窗口里一个点都没有时它照样有值（否则"很久没同步"会被读成"从没同步过"）；
//   4. **`totalBalanceCents: null` 一路原样传出来**，绝不落成 `0`（§0.2 未知 ≠ 没钱）；
//   5. **只读**：不改业务状态、**不发任何上游请求**（要查去点三个手动端点）；
//   6. **鉴权走会话**，不带令牌打进来 → `403 FORBIDDEN`（§12.4 的作用域仍只有
//      `GET /api/observability/*`）—— 用 `401` 会让客户端以为"换一把令牌"能解决。
//
// 两条测试基建纪律（沿用 `live.spec.ts`）：
//   - 建 app 时 `balanceSync: false`：路由要调度器对象，但本文件不为它注册后台定时器
//     （它有自己的 spec）。**不影响 `auto.enabled` 的回显** —— 那个字段答的是"配置里
//     自动同步开着吗"，由 `config.balanceSyncMinutes` 决定（app.ts 注释写死了这条）；
//   - 快照一律用 `appendBalanceSnapshot` 直接种，`ts` 相对**真实时钟**取 ——
//     路由拿的是调度器里的真实 `now()`，种一个虚构时刻会让点落在窗口外而静默为空。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import { openDatabase, type Db } from '../../db/database.js';
import { appendBalanceSnapshot } from '../../db/repo/balance-snapshots.js';
import { createUpstream } from '../../db/repo/upstreams.js';
import type { BalanceSyncStatusDto } from '../dto.js';
import { buildApp } from '../app.js';
import { bootstrapAdmin } from '../auth.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'sync-probe-pass-1';
// 桩令牌**运行时拼**（同 `observability.spec.ts` 的桩 key）：`TOKEN = '<25 个字面量>'`
// 会被自己的 `check:secrets`（`assigned-secret` 规则，≥24 字符即命中）抓成"硬编码凭据" ——
// 扫描器不认识"这是测试"，只认识形状。
const READONLY_TOKEN = 'readonly-sync-' + 'probe-token';

const MIN = 60_000;
const HOUR = 3_600_000;

const dirs: string[] = [];
const harnesses: Harness[] = [];

/** 与 api.spec.ts 同一条纪律：收尾统一在 afterEach，否则断言失败会漏句柄，清理错误盖掉真失败。 */
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
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
      /* Windows 上临时目录偶尔仍被短时占用，不影响判据 */
    }
  }
});

interface Harness {
  app: FastifyInstance;
  db: Db;
  cookie: string;
}

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
    assistantModel: null,
    egressHeartbeatInboxDir: null,
    // 默认关：本文件不测调度器节奏，只测路由。要测 `auto.enabled=true` 的用例自己覆盖。
    balanceSyncMinutes: 0,
    balanceSnapshotRetentionDays: 90,
    ...over,
  };
}

async function setup(over: Partial<AppConfig> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'bal-sync-route-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const app = buildApp({
    db,
    config: makeConfig(dbPath, over),
    // 不启动余额自动同步定时器（它有自己的 spec）；`healthSnapshots: false` 是为了
    // 不让建 app 的隐式副作用往库里多写一行 —— 本文件有"零写入"断言，少一个变量少一份解释成本。
    balanceSync: false,
    healthSnapshots: false,
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

  const h: Harness = { app, db, cookie };
  harnesses.push(h);
  return h;
}

/** GET 一次并把 JSON 收成 DTO。断言状态码放在调用方，好让失败信息带上原始 body。 */
async function getSync(
  h: Harness,
  query = '',
  headers: Record<string, string> = {},
): Promise<{ status: number; body: BalanceSyncStatusDto }> {
  const res = await h.app.inject({
    method: 'GET',
    url: `/api/stats/balance/sync${query}`,
    headers: { cookie: h.cookie, 'x-requested-with': 'fetch', ...headers },
  });
  return { status: res.statusCode, body: res.json() as BalanceSyncStatusDto };
}

function at(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function seed(
  db: Db,
  upstream: { id: string; name: string },
  ts: string,
  totalBalanceCents: number | null,
  trigger: 'auto' | 'manual' = 'auto',
): void {
  appendBalanceSnapshot(db, {
    upstreamId: upstream.id,
    upstreamName: upstream.name,
    ts,
    totalBalanceCents,
    knownKeyCount: totalBalanceCents === null ? 0 : 1,
    unknownKeyCount: totalBalanceCents === null ? 1 : 0,
    unlimitedKeyCount: 0,
    tokenPlanKeyCount: 0,
    trigger,
  });
}

function span(window: { from: string; to: string }): number {
  return Date.parse(window.to) - Date.parse(window.from);
}

describe('窗口（契约 §14.3）', () => {
  it('缺省窗口是 6h（不是 overview 的 60s），且回显的是 {from,to}', async () => {
    const h = await setup();
    const { status, body } = await getSync(h);

    expect(status).toBe(200);
    expect(span(body.window)).toBe(6 * HOUR);
    // `to` 贴着"现在"：窗口的右端点是**请求时刻**，不是某条快照的时刻
    expect(Math.abs(Date.now() - Date.parse(body.window.to))).toBeLessThan(5_000);
  });

  it('显式 window 被采纳：1h / 60m 同义，24h 是上限且仍放行', async () => {
    const h = await setup();
    expect(span((await getSync(h, '?window=1h')).body.window)).toBe(HOUR);
    expect(span((await getSync(h, '?window=60m')).body.window)).toBe(HOUR);
    expect(span((await getSync(h, '?window=3600s')).body.window)).toBe(HOUR);

    const max = await getSync(h, '?window=24h');
    expect(max.status).toBe(200);
    expect(span(max.body.window)).toBe(24 * HOUR);
  });

  it('不可解析 / 超 24h / 零值 → 400 INVALID_PARAM，且 details.field 指名 window', async () => {
    const h = await setup();
    for (const bad of ['abc', '5', 'h', '0m', '25h', '1441m']) {
      const res = await h.app.inject({
        method: 'GET',
        url: `/api/stats/balance/sync?window=${bad}`,
        headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
      });
      expect(res.statusCode, `window=${bad} 应被拒: ${res.body}`).toBe(400);
      const body = res.json() as { code?: string; details?: { field?: string } };
      expect(body.code, `window=${bad}`).toBe('INVALID_PARAM');
      expect(body.details?.field, `window=${bad}`).toBe('window');
    }
  });
});

describe('形状（契约 §14.3）', () => {
  it('series 按上游分段、points 自带 t 且升序；**本节没有等长 axis**', async () => {
    const h = await setup();
    const a = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const b = createUpstream(h.db, { name: 'up-b', baseUrl: 'https://b.example.com' });
    // `ts` 只算一次：`at()` 读的是真实时钟，两次调用可能差几毫秒 ——
    // 拿"再算一次的字符串"去比库里的值，是一条会偶发失败的断言。
    const t40 = at(40 * MIN);
    const t10 = at(10 * MIN);
    // 故意乱序种入，好让"升序"是真的被排过而不是碰巧
    seed(h.db, a, t10, 20000);
    seed(h.db, a, t40, 12345);
    seed(h.db, b, at(20 * MIN), 777);

    const { status, body } = await getSync(h);
    expect(status).toBe(200);

    // **不按位置断言 series**：`series` 按 `upstream_id` 排序，而 id 是随机 6 字节 hex
    // （`newId`）—— 位置是掷硬币，今天过明天挂。按 id 取段，段内再断言点的顺序。
    expect(body.series.map((s) => s.upstreamId).sort()).toEqual([a.id, b.id].sort());
    const seriesA = body.series.find((s) => s.upstreamId === a.id);
    const seriesB = body.series.find((s) => s.upstreamId === b.id);
    expect(seriesA?.label).toBe('up-a');
    expect(seriesA?.points.map((p) => p.t)).toEqual([t40, t10]);
    expect(seriesA?.points.map((p) => p.totalBalanceCents)).toEqual([12345, 20000]);
    expect(seriesB?.points).toHaveLength(1);
    // `upstreams[]` 是另一条排序（按 name），两条序列各自独立成段、不交叉
    expect(body.upstreams.map((u) => u.upstreamId)).toEqual([a.id, b.id]);

    // 形状断言：`points` 自己带时间轴，任何等长 `axis` 都会让前端以为点是均匀的
    expect(body).not.toHaveProperty('axis');
    expect(JSON.stringify(body)).not.toContain('"axis"');
    for (const s of body.series) {
      for (const p of s.points) expect(Date.parse(p.t)).toBeGreaterThan(0);
    }
  });

  it('`totalBalanceCents: null` 原样传出来，绝不落成 0（§0.2 未知 ≠ 没钱）', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-null', baseUrl: 'https://n.example.com' });
    seed(h.db, up, at(30 * MIN), null);
    seed(h.db, up, at(10 * MIN), 0);

    const { body } = await getSync(h);
    const points = body.series[0]?.points ?? [];
    expect(points.map((p) => p.totalBalanceCents)).toEqual([null, 0]);
    expect(points[0]?.totalBalanceCents).toBeNull();
    expect(points[0]?.unknownKeyCount).toBe(1);
  });

  it('`lastSyncedAt` / `lastTrigger` 不受窗口限制（窗口里没点也答得出"最近一次"）', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-old', baseUrl: 'https://o.example.com' });
    // 10 小时前：落在默认 6h 窗口之外，却仍是"最近一次同步"
    const oldTs = at(10 * HOUR);
    seed(h.db, up, oldTs, 5000, 'manual');

    const { body } = await getSync(h);
    expect(body.series).toEqual([]);
    expect(body.lastSyncedAt).toBe(oldTs);
    expect(body.lastTrigger).toBe('manual');
    // 上游运行态里那个 `lastSyncedAt` 同样来自快照表，不是窗口内的
    expect(body.upstreams.find((u) => u.upstreamId === up.id)?.lastSyncedAt).toBe(oldTs);
  });

  it('没有任何快照时 lastSyncedAt / lastTrigger 为 null，series 为空数组', async () => {
    const h = await setup();
    const { body } = await getSync(h);
    expect(body.lastSyncedAt).toBeNull();
    expect(body.lastTrigger).toBeNull();
    expect(body.series).toEqual([]);
    expect(body.upstreams).toEqual([]);
  });

  it('`drift.since` 就是 `window.from`，counts 两码齐全且恒为 int', async () => {
    const h = await setup();
    const { body } = await getSync(h, '?window=5m');

    expect(body.drift.since).toBe(body.window.from);
    expect(Object.keys(body.drift.counts).sort()).toEqual([
      'BALANCE_SPENT_WITHOUT_TRAFFIC',
      'BALANCE_UNCHANGED_WITH_TRAFFIC',
    ]);
    for (const v of Object.values(body.drift.counts)) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    // 漂移是提示不是闸门：本端点不带任何"阻塞态"字段
    expect(body.drift.alerts).toEqual([]);
  });
});

describe('upstreamId 过滤（契约 §14.6：列表型过滤，查无此上游不报 404）', () => {
  it('给了 upstreamId 就只回该上游的运行态与序列', async () => {
    const h = await setup();
    const a = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    const b = createUpstream(h.db, { name: 'up-b', baseUrl: 'https://b.example.com' });
    seed(h.db, a, at(10 * MIN), 100);
    seed(h.db, b, at(10 * MIN), 200);

    const { status, body } = await getSync(h, `?upstreamId=${a.id}`);
    expect(status).toBe(200);
    expect(body.upstreams.map((u) => u.upstreamId)).toEqual([a.id]);
    expect(body.series.map((s) => s.upstreamId)).toEqual([a.id]);
    expect(body.series[0]?.points[0]?.totalBalanceCents).toBe(100);
  });

  it('未知 upstreamId → 200 且该条为空（不是 404）', async () => {
    const h = await setup();
    const a = createUpstream(h.db, { name: 'up-a', baseUrl: 'https://a.example.com' });
    seed(h.db, a, at(10 * MIN), 100);

    const { status, body } = await getSync(h, '?upstreamId=up_does_not_exist');
    expect(status).toBe(200);
    expect(body.upstreams).toEqual([]);
    expect(body.series).toEqual([]);
    // 全局口径不受过滤影响：过滤的是"看哪一条"，不是"最近有没有同步过"
    expect(body.lastSyncedAt).not.toBeNull();
  });
});

describe('auto 回显（契约 §14.3：前端不得自算间隔 / 抖动 / 退避）', () => {
  it('BALANCE_SYNC_MINUTES=0 → enabled=false 且 nextRunAt=null', async () => {
    const h = await setup({ balanceSyncMinutes: 0 });
    const { body } = await getSync(h);
    expect(body.auto).toEqual({
      enabled: false,
      intervalMinutes: 0,
      jitterRatio: 0.1,
      backoffCapMinutes: 360,
    });
    expect(body.nextRunAt).toBeNull();
  });

  it('BALANCE_SYNC_MINUTES=15 → enabled=true 且三个参数是冻结值', async () => {
    const h = await setup({ balanceSyncMinutes: 15 });
    const { body } = await getSync(h);
    expect(body.auto).toEqual({
      enabled: true,
      intervalMinutes: 15,
      jitterRatio: 0.1,
      backoffCapMinutes: 360,
    });
    // 本文件用 `balanceSync:false` 建 app（不注册定时器），所以没有"下一次计划时刻"可回 ——
    // `null` 在这里是**事实**（确实还没排程），不是被测试开关篡改出来的。
    expect(body.nextRunAt).toBeNull();
    for (const u of body.upstreams) expect(u.nextAttemptAt).toBeNull();
  });
});

describe('只读（契约 §14.3）', () => {
  it('一次 GET 不改任何业务状态，也不发任何上游请求', async () => {
    const h = await setup();
    const up = createUpstream(h.db, { name: 'up-ro', baseUrl: 'https://ro.example.com' });
    seed(h.db, up, at(10 * MIN), 100);

    const count = (table: string): number =>
      (h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const before = {
      snapshots: count('balance_snapshots'),
      changes: count('change_log'),
      keys: count('upstream_keys'),
      runtime: count('key_runtime'),
    };

    // "不触发任何查询"直接钉在出口上：这条路径上唯一可能的出网口是 fetch
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = ((input: unknown): never => {
      calls.push(String(input));
      throw new Error('只读端点不该发任何上游请求');
    }) as unknown as typeof fetch;
    try {
      const { status } = await getSync(h);
      expect(status).toBe(200);
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(calls).toEqual([]);
    expect({
      snapshots: count('balance_snapshots'),
      changes: count('change_log'),
      keys: count('upstream_keys'),
      runtime: count('key_runtime'),
    }).toEqual(before);
  });
});

describe('鉴权（契约 §14.3 / §14.6）', () => {
  it('无会话 → 401 UNAUTHORIZED', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/stats/balance/sync' });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { code?: string }).code).toBe('UNAUTHORIZED');
  });

  it('READONLY_TOKEN 打进来 → 403 FORBIDDEN（作用域不扩，不是 401）', async () => {
    const h = await setup({ readonlyToken: READONLY_TOKEN });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/stats/balance/sync',
      headers: { authorization: `Bearer ${READONLY_TOKEN}` },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code?: string }).code).toBe('FORBIDDEN');

    // 同一把令牌在观测面（§12.4 的作用域）仍然好使 —— 否则这条用例证明的只是"令牌坏了"
    const allowed = await h.app.inject({
      method: 'GET',
      url: '/api/observability/health',
      headers: { authorization: `Bearer ${READONLY_TOKEN}` },
    });
    expect(allowed.statusCode).toBe(200);
  });
});
