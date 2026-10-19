// 消费面验收。契约 §19 / ADR-0034。
//
// 本套用例钉的是 ADR-0034「判据」表那七条 —— 全部是"这条权限边界是否真实存在"的判据，
// 不是形状回归。所以断言写得比别处硬：`toEqual` 整个响应体，而不是 `.toBe(200)`。
//
// 七条 + 三条变异见 ADR-0034 末尾。这里额外钉两条本文件自己引入的形状：
// `role` 进登录响应（§19.8）与消费面**零写方法**（决策 3）。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../config.js';
import { openDatabase, type Db } from '../../db/database.js';
import { createGroup } from '../../db/repo/groups.js';
import { createUser, type UserRole } from '../../db/repo/users.js';
import { buildApp } from '../app.js';
import { bootstrapAdmin, hashPassword } from '../auth.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'console-admin-pass-1';
const MASTER_KEY = Buffer.from('3b'.repeat(32), 'hex');

const dirs: string[] = [];
const harnesses: Harness[] = [];

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
      /* Windows 上临时目录偶尔仍被短时占用 */
    }
  }
});

interface Harness {
  app: FastifyInstance;
  db: Db;
  adminCookie: string;
  /** db 文件路径。只有"明文不落盘"那一条用例要它（要读 `-wal` / `-shm` 的裸字节）。 */
  dbPath: string;
}

/** db 文件 + WAL + SHM 的裸字节。与 `api.spec.ts` 里那份同源（同一件事两处各写一遍会漂移）。 */
function readRawFiles(dbPath: string): Buffer {
  return Buffer.concat(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p)),
  );
}

function containsPlaintext(raw: Buffer, plaintext: string): boolean {
  const forms = [
    Buffer.from(plaintext, 'utf8'),
    Buffer.from(Buffer.from(plaintext, 'utf8').toString('base64'), 'utf8'),
    Buffer.from(Buffer.from(plaintext, 'utf8').toString('hex'), 'utf8'),
  ];
  return forms.some((f) => f.length > 0 && raw.includes(f));
}

function makeConfig(dbPath: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    masterKey: MASTER_KEY,
    dbPath,
    portGateway: 4000,
    hostGateway: '0.0.0.0',
    portAdmin: 4001,
    hostAdmin: '127.0.0.1',
    sessionTtlHours: 24,
    cookieSecure: false,
    trustProxy: false,
    allowedOrigins: [],
    adminToken: null,
    readonlyToken: null,
    logRetentionDays: 30,
    auditRetentionDays: 180,
    taskRetentionDays: 7,
    changeLogKeepRows: 10_000,
    healthSnapshotRetentionDays: 90,
    maxAttempts: 3,
    maxConcurrencyPerKey: 4,
    cooldownLadderSeconds: [0, 60, 300, 900, 1800],
    assistantModel: null,
    egressHeartbeatInboxDir: null,
    egressEchoUrl: null,
    balanceSyncMinutes: 0,
    balanceSnapshotRetentionDays: 90,
    modelProbeEnabled: true,
    modelProbeMaxModels: 10,
    adminWebDist: null,
    egressBudgetCapacity: null,
    publicHost: null,
    ...over,
  };
}

async function setup(over: Partial<AppConfig> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'console-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const app = buildApp({
    db,
    config: makeConfig(dbPath, over),
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
  expect(res.statusCode).toBe(200);
  const raw = res.headers['set-cookie'];
  const adminCookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
  const h: Harness = { app, db, adminCookie, dbPath };
  harnesses.push(h);
  return h;
}

/** 建一个用户并登录，拿他的 cookie。`group` 直接给 group_id（绕过 API，测的是授面不是建号）。 */
async function loginAs(
  h: Harness,
  username: string,
  opts: { role?: UserRole; groupId?: string | null } = {},
): Promise<string> {
  createUser(h.db, {
    username,
    passwordHash: hashPassword('console-user-pass-1'),
    role: opts.role ?? 'user',
    groupId: opts.groupId ?? null,
  });
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'console-user-pass-1' },
    headers: { 'x-requested-with': 'fetch' },
  });
  expect(res.statusCode).toBe(200);
  const raw = res.headers['set-cookie'];
  return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
}

/**
 * 写请求的公共头。
 *
 * `x-requested-with` 是 CSRF 闸门的要求（`src/api/http.ts` 的 `verifyCsrf`：所有写方法
 * 都要带）。本文件大量用例是写方法，不带它会拿到 403 `CSRF_REJECTED` ——
 * 那与"授面拒绝"是同一个状态码、完全不同的原因，读失败信息时分不清。
 */
const WRITE_HEADERS = { 'x-requested-with': 'fetch' } as const;

/**
 * 以管理员身份发一个写请求。
 *
 * `content-type` **只在真的有 body 时挂**：本文件的 `DELETE`（`/api/users/:username`）
 * 没有 body，而 `content-type: application/json` + 空 body 是 Fastify 的
 * `FST_ERR_CTP_EMPTY_JSON_BODY`（一个**请求侧**的 400）。真实前端
 * （`web/src/api/http.ts` 的 `del`）不带这个头 —— `withMethod` 不设 `body`，
 * 于是 `Content-Type` 短路在 `if (options.body !== undefined)`。跟它对齐，
 * 测的才是同一条路。
 */
function adminWrite(
  h: Harness,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method,
    url,
    headers: { cookie: h.adminCookie, ...WRITE_HEADERS },
    ...(payload === undefined ? {} : { payload }),
  });
}

describe('§19.1 授面：role=user 只能进 /api/console/**', () => {
  it('打 /api/upstreams → 403 FORBIDDEN（授面在服务端，不是前端隐藏）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-upstreams');
    const res = await h.app.inject({ method: 'GET', url: '/api/upstreams', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('FORBIDDEN');
  });

  /**
   * 这条是"403 不是隐藏"的关键：打 `/api/supplier-accounts`（**真实账号池**）。
   * A 档（纯前端双视图）的实现里这个请求会 200 并回全部账号 —— 那不是理论风险，
   * 是那个实现必然的结果。
   */
  it('打 /api/supplier-accounts → 403 FORBIDDEN（真实账号池不外泄）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-accounts');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/supplier-accounts',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('写方法同样 403：user 打 POST /api/groups → 403（不是 405 / 不是 201）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-write');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie, ...WRITE_HEADERS },
      payload: { name: 'user-made-group' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('FORBIDDEN');
  });

  it('role=admin 打 /api/console/* 正常（新面不缩小管理员）', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/console/session',
      headers: { cookie: h.adminCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ username: ADMIN_USER, role: 'admin' });
  });

  it('未登录打 /api/console/session → 401（消费面不豁免鉴权）', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/console/session' });
    expect(res.statusCode).toBe(401);
  });

  /**
   * §19.1 表里**唯一**放行的既有管理面端点（v1.15.1 / ADR-0034 裁定）。
   *
   * 为什么需要这一条：§19.5 那条 URL 公式用的是
   * `(publicHost ?? location.hostname) + ':' + portGateway`，
   * 而 `publicHost` / `portGateway` **只存在于 `/api/access-info`**。不放行它，
   * 「普通用户在前端拿到接入 URL」这件事逻辑上办不到 —— v1.15.0 把 §19.1（不放行）
   * 与 §19.5（自己拼）写在同一版里，合起来是一个不可能满足的公式。
   * 契约按 ADR-0034「影响面」表的裁定订正为放行，本用例钉住这个订正后的口径。
   *
   * 同时钉"放行的只有这一个"：同文件里其它管理面端点仍是 403（上面三条已钉），
   * 而**写方法**打同一个路径也仍 403 —— 例外是"这一个只读端点"，不是一个前缀。
   */
  it('GET /api/access-info 放行：接入 URL 的三个字段是本面唯一来源', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-access');
    const res = await h.app.inject({ method: 'GET', url: '/api/access-info', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      gateway: { portGateway: number };
      admin: { portAdmin: number };
      publicHost: string | null;
    };
    expect(typeof body.gateway.portGateway).toBe('number');
    expect(typeof body.admin.portAdmin).toBe('number');
    expect(body.publicHost === null || typeof body.publicHost === 'string').toBe(true);
    // 与管理员读到的是**同一份值**，不是第二份口径（这是"不放行新端点"换来的东西）。
    const adminRes = await h.app.inject({
      method: 'GET',
      url: '/api/access-info',
      headers: { cookie: h.adminCookie },
    });
    expect(adminRes.statusCode).toBe(200);
    expect(adminRes.json()).toEqual(res.json());
  });

  it('放行只到 GET：user 打 POST /api/access-info 仍 403（例外不是一个前缀）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-access-write');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/access-info',
      headers: { cookie, ...WRITE_HEADERS },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code: string }).code).toBe('FORBIDDEN');
  });
});

describe('§19.2 GET /api/console/session', () => {
  it('回 username / role / groupId / expiresAt；未分配用户 groupId 为 null', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-session');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/console/session',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.username).toBe('u-session');
    expect(body.role).toBe('user');
    expect(body.groupId).toBeNull();
    expect(typeof body.expiresAt).toBe('string');
  });
});

describe('§19.3 GET /api/console/keys', () => {
  it('只回本组 key，且全是掩码（明文无路径）', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const other = createGroup(h.db, { name: 'other-group' });
    const cookie = await loginAs(h, 'u-keys', { groupId: mine.group.id });

    const res = await h.app.inject({ method: 'GET', url: '/api/console/keys', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupId).toBe(mine.group.id);
    expect(body.assigned).toBe(true);
    expect(body.keys).toHaveLength(1);
    // 掩码形状：`****` + 后 4 位。**绝不含明文** —— 明文只在 createGroup 的返回值里出现过一次。
    expect(body.keys[0].maskedKey).toBe(mine.gatewayKey.maskedKey);
    expect(body.keys[0].maskedKey.startsWith('****')).toBe(true);
    expect(body.keys[0].maskedKey).not.toBe(other.gatewayKey.maskedKey);
    // 响应体里任何位置都不该出现任何一组的明文 key
    expect(res.body).not.toContain(mine.gatewayKey.gatewayKey);
  });

  it('?groupId=<别组> 被忽略，回的还是本组（归属不来自请求参数）', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const other = createGroup(h.db, { name: 'other-group' });
    const cookie = await loginAs(h, 'u-forge', { groupId: mine.group.id });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/console/keys?groupId=${other.group.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupId).toBe(mine.group.id);
    expect(body.keys.map((k: { id: string }) => k.id)).toEqual([mine.gatewayKey.id]);
  });

  it('未分配组 → keys 空 + assigned:false（不是 404，更不是 500）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-unassigned', { groupId: null });
    const res = await h.app.inject({ method: 'GET', url: '/api/console/keys', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    // `keyLimit` 是**本端点的一条规则**（自助上限），与调用方有没有组无关 ——
    // 未分配时回 null 会让前端多一个"拿不到上限"的分支，而那个分支没有对应的事实。
    expect(res.json()).toEqual({ groupId: null, keys: [], assigned: false, keyLimit: 10 });
  });
});

describe('§19.4 GET /api/console/usage', () => {
  /** 灌一条本组、一条别组的调用记录。 */
  function seedUsage(h: Harness, myGroupId: string, otherGroupId: string): void {
    const at = new Date().toISOString();
    for (const groupId of [myGroupId, otherGroupId]) {
      h.db
        .prepare(
          `INSERT INTO usage_logs (id, ts, group_id, model, upstream_id, key_id, key_masked, status,
             prompt_tokens, completion_tokens, total_tokens, is_estimated, stream, cost_cents)
           VALUES (?, ?, ?, 'gpt-test', 'ups_test', 'gwk_test', '****test', 200, 10, 20, 30, 0, 0, 0)`,
        )
        .run(`log_${groupId}`, at, groupId);
    }
  }

  it('只聚合本组的调用（别组一行都不带）', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const other = createGroup(h.db, { name: 'other-group' });
    seedUsage(h, mine.group.id, other.group.id);
    const cookie = await loginAs(h, 'u-usage', { groupId: mine.group.id });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/console/usage?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&bucket=1d&groupBy=model`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // 形状与 §6 GET /api/stats/usage 逐字相同（复用 computeUsage）
    expect(Object.keys(body).sort()).toEqual(
      ['axis', 'bucket', 'from', 'groupBy', 'isEstimatedTokenCount', 'series', 'to'].sort(),
    );
    // 两条日志用的是同一个 model 名，按 model 分箱只会得到**一条** series ——
    // 如果 groupId 没生效（别组那行也进来了），这条 series 的 requests 会是 2。
    expect(body.series).toHaveLength(1);
    expect(body.series[0].key).toBe('gpt-test');
    expect(body.series[0].points.reduce((n: number, p: { requests: number }) => n + p.requests, 0)).toBe(1);
  });

  it('?groupId=<别组> 被忽略（schema 剥掉后 groupBy 仍按本组收窄）', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const other = createGroup(h.db, { name: 'other-group' });
    seedUsage(h, mine.group.id, other.group.id);
    const cookie = await loginAs(h, 'u-usage-forge', { groupId: mine.group.id });

    const res = await h.app.inject({
      method: 'GET',
      url: `/api/console/usage?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&bucket=1d&groupBy=key&groupId=${other.group.id}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const keys = res.json().series.map((s: { key: string }) => s.key);
    expect(keys).not.toContain(other.group.id);
  });

  it('groupBy=group → 400（enum 里没有它：按组分箱只会得到一根恒等的线）', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const cookie = await loginAs(h, 'u-usage-group', { groupId: mine.group.id });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/console/usage?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&bucket=1d&groupBy=group`,
      headers: { cookie },
    });
    // 明确拒绝，而不是"列在 enum 里而服务端忽略"—— 那是一个看起来能选、选了没效果的控件
    expect(res.statusCode).toBe(400);
  });

  it('未分配组 → 空轴 + 空 series（前端画空图，不报错）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-usage-empty', { groupId: null });
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/console/usage?from=1970-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z&bucket=1d&groupBy=key`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      from: '1970-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
      bucket: '1d',
      groupBy: 'key',
      axis: [],
      series: [],
      isEstimatedTokenCount: 0,
    });
  });
});

describe('§19.6 GET /api/console/models', () => {
  it('只回 enabled 的模型（与 §5 / §10 /v1/models 同一判据）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-models');
    const res = await h.app.inject({ method: 'GET', url: '/api/console/models', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().models)).toBe(true);
    // 空库下也是 200 + 空数组（不是 404）
    expect(res.json().models).toEqual([]);
  });

  it('未登录 → 401', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/console/models' });
    expect(res.statusCode).toBe(401);
  });
});

describe('§19.8 登录响应新增 role', () => {
  it('role 进登录响应体（登录那一刻就要决定跳 /admin 还是 /console）', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: ADMIN_USER, password: ADMIN_PASS },
      headers: { 'x-requested-with': 'fetch' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('admin');
  });

  it('普通用户登录响应 role=user，GET /api/console/session 同值', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-login-role');
    // **刻意不打 `/api/auth/session`**：那是管理面端点，`role=user` 打它是 403（授面在服务端）。
    // 刷新页面时前端据此分流，所以消费面要有自己的会话端点（§19.2）——
    // 少一个，普通用户刷新一下就掉到登录页，而那不是"会话过期"。
    const res = await h.app.inject({ method: 'GET', url: '/api/console/session', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toBe('user');
    expect(res.json().username).toBe('u-login-role');
  });
});

describe('§19.7 管理面用户端点', () => {
  it('POST /api/users 建一个 role=user 的用户 → 201，响应体不含 password_hash', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'assign-me' });
    const res = await adminWrite(h, 'POST', '/api/users', {
      username: 'newbie',
      password: 'newbie-pass-1234',
      role: 'user',
      groupId: mine.group.id,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.username).toBe('newbie');
    expect(body.role).toBe('user');
    expect(body.groupId).toBe(mine.group.id);
    expect(res.body).not.toContain('password');
  });

  it('POST /api/users 密码少于 8 位 → 400', async () => {
    const h = await setup();
    const res = await adminWrite(h, 'POST', '/api/users', {
      username: 'shortpw',
      password: 'short',
      role: 'user',
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/users 用户名重复 → 409 / 400（translateWriteError），不静默覆盖', async () => {
    const h = await setup();
    const first = await adminWrite(h, 'POST', '/api/users', {
      username: 'dup',
      password: 'dup-pass-1234',
      role: 'user',
    });
    expect(first.statusCode).toBe(201);
    const res = await adminWrite(h, 'POST', '/api/users', {
      username: 'dup',
      password: 'dup-pass-1234',
      role: 'user',
    });
    expect([400, 409]).toContain(res.statusCode);
  });

  it('GET /api/users 列表不含 password_hash', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: h.adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('password_hash');
    expect(res.json().items.length).toBeGreaterThan(0);
  });

  it('DELETE /api/users/:u → 204 且该用户会话同时失效（同事务吊销）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-to-delete');
    const before = await h.app.inject({
      method: 'GET',
      url: '/api/console/session',
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    const res = await adminWrite(h, 'DELETE', '/api/users/u-to-delete');
    expect(res.statusCode).toBe(204);

    const after = await h.app.inject({ method: 'GET', url: '/api/console/session', headers: { cookie } });
    // 人没了 cookie 还有效 = 中间态。同事务吊销之后，旧 cookie 必须打不开任何东西。
    expect(after.statusCode).toBe(401);
  });

  it('不能删自己 → 400 INVALID_PARAM', async () => {
    const h = await setup();
    const res = await adminWrite(h, 'DELETE', `/api/users/${ADMIN_USER}`);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('INVALID_PARAM');
  });

  it('不能删最后一个 admin → 400', async () => {
    const h = await setup();
    const made = await adminWrite(h, 'POST', '/api/users', {
      username: 'second-admin',
      password: 'second-admin-pass-1',
      role: 'admin',
    });
    expect(made.statusCode).toBe(201);
    const third = await adminWrite(h, 'POST', '/api/users', {
      username: 'third-admin',
      password: 'third-admin-pass-1',
      role: 'admin',
    });
    expect(third.statusCode).toBe(201);
    // 3 个 admin。删掉第二个还剩 2 个 —— **允许**。
    // 判据是"删完还剩几个"：剩 0 才拦，剩 1 不拦（那一个人就是唯一的管理员，
    // 而管理面还进得去 —— 拦到剩 1 是过度收紧，会让"两个管理员互相删不掉对方"
    // 这种正常运维变成不可能）。
    const ok = await adminWrite(h, 'DELETE', '/api/users/second-admin');
    expect(ok.statusCode).toBe(204);
    // 再删第三个：删完只剩 1 个 admin —— 仍然允许
    const stillOk = await adminWrite(h, 'DELETE', '/api/users/third-admin');
    expect(stillOk.statusCode).toBe(204);
    // 现在库里只有 `admin` 一个 admin 了。
    //
    // **下面这条是"守卫在 HTTP 面上打不着"的诚实记录**：要在 HTTP 上命中
    // `adminCount <= 1`，得同时满足"actor 不是被删的那个"且"被删的是唯一 admin"——
    // 而 actor 自己也是个 admin 行，所以库里至少有 2 个 admin，`adminCount <= 1`
    // 恒假。唯一能触发的路径是**并发两次删除**（SQLite 单连接串行化，
    // 第二次进来时第一次已经提交，于是它看到的是新计数）或仓储层的直接调用方。
    //
    // 所以这一条守卫是**纵深防御**：它保护的是"绕过 HTTP 的调用方"，
    // 不是"一个恶意 HTTP 请求"。把它测在 HTTP 上只能测出一个假动作 ——
    // 删 `admin` 自己会被"不能删自己"先挡住，删 `fourth-admin` 会成功（剩 1 个）。
    // 这里两条都走一遍，钉住"HTTP 面上的真实行为"，而不是编一个够不着的期望。
    const fourth = await adminWrite(h, 'POST', '/api/users', {
      username: 'fourth-admin',
      password: 'fourth-admin-pass-1',
      role: 'admin',
    });
    expect(fourth.statusCode).toBe(201);
    // 删 fourth-admin 后仍剩 1 个 admin（`admin` 本人）→ 允许
    const allowed = await adminWrite(h, 'DELETE', '/api/users/fourth-admin');
    expect(allowed.statusCode).toBe(204);
    const rows = h.db
      .prepare("SELECT username FROM admin_users WHERE role = 'admin' ORDER BY username")
      .all() as { username: string }[];
    expect(rows.map((r) => r.username)).toEqual([ADMIN_USER]);
    // 最后一个是自己 → 走"不能删自己"，不是"不能删最后一个 admin"
    const selfDelete = await adminWrite(h, 'DELETE', `/api/users/${ADMIN_USER}`);
    expect(selfDelete.statusCode).toBe(400);
    expect((selfDelete.json() as { code: string }).code).toBe('INVALID_PARAM');
  });

  it('role=user 打 /api/users → 403 FORBIDDEN', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-users-scope');
    const res = await h.app.inject({ method: 'GET', url: '/api/users', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  // v1.15.6 / ADR-0035 决策 2：`PATCH /api/users/:username` 只改归属组。
  //
  // 这四条钉的是"改归属组这条路的四个面"：改得成、当场生效、只改得动一个字段、
  // 坏入参是 400 不是 500。第 3 条尤其重要 —— 它是**刻意的忽略**而不是漏校验，
  // 所以要有用例把它从"看起来像 bug"变成"钉住的行为"。
  describe('§19.7 PATCH /api/users/:username —— 只改归属组（v1.15.6）', () => {
    it('改归属组 → 200 且回完整 UserDto；同一会话立刻生效（不要求重新登录）', async () => {
      const h = await setup();
      const mine = createGroup(h.db, { name: 'patch-target' });
      const cookie = await loginAs(h, 'u-patch', { groupId: null });

      // 改之前：没组，消费面照实说 assigned:false
      const before = await h.app.inject({ method: 'GET', url: '/api/console/session', headers: { cookie } });
      expect(before.json().groupId).toBe(null);

      const res = await adminWrite(h, 'PATCH', '/api/users/u-patch', { groupId: mine.group.id });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.username).toBe('u-patch');
      expect(body.groupId).toBe(mine.group.id);
      // 形状与 create/list 同一个 UserDto：漏了字段的下游会静默少一列
      expect(Object.keys(body).sort()).toEqual(
        ['createdAt', 'displayName', 'groupId', 'role', 'updatedAt', 'username'].sort(),
      );
      expect(res.body).not.toContain('password');

      // **同一个 cookie，不重新登录** —— 这是"归属改动当场生效"的判据。
      // role/groupId 每次鉴权从库里现读（`sessionInfoOf` / `touchSession`），
      // 存进 sessions 就会留下"管理员改完了、旧会话还是老组"的窗口。
      const after = await h.app.inject({ method: 'GET', url: '/api/console/session', headers: { cookie } });
      expect(after.json().groupId).toBe(mine.group.id);
    });

    it('body 里带 role / password 被忽略：role 不变、口令不变（不是漏校验，是只开一个字段）', async () => {
      const h = await setup();
      const cookie = await loginAs(h, 'u-patch-extra', { role: 'user', groupId: null });
      const hashBefore = (h.db.prepare('SELECT password_hash FROM admin_users WHERE username = ?').get(
        'u-patch-extra',
      ) as { password_hash: string }).password_hash;

      const res = await adminWrite(h, 'PATCH', '/api/users/u-patch-extra', {
        groupId: null,
        // 这三个字段**都不在 schema 的 properties 里**：Ajv 按 §0.2 的既有口径
        // 静默丢弃未知字段（没有 additionalProperties:false）。
        // 之所以不写 false：那样一个多带字段的正常客户端会收到 400，
        // 而这条端点的语义是"只改 groupId"，多带的东西无视掉比报错更贴语义。
        role: 'admin',
        password: 'attacker-chosen-pass',
        displayName: '改个名',
      });
      expect(res.statusCode).toBe(200);

      const row = h.db
        .prepare('SELECT role, password_hash, display_name FROM admin_users WHERE username = ?')
        .get('u-patch-extra') as { role: string; password_hash: string; display_name: string | null };
      // 升权没发生 —— 这一条就是"role 不可改"在 HTTP 面上的证据
      expect(row.role).toBe('user');
      expect(row.password_hash).toBe(hashBefore);
      expect(row.display_name).toBe(null);
      // 而它自己的会话仍然是 user：连"提权后旧会话读到的 role"都还是 user
      const sess = await h.app.inject({ method: 'GET', url: '/api/console/session', headers: { cookie } });
      expect(sess.json().role).toBe('user');
    });

    it('不存在的 groupId → 400 INVALID_PARAM（不是 500）；details.field 指名 groupId', async () => {
      const h = await setup();
      await loginAs(h, 'u-patch-badgroup', { groupId: null });
      const res = await adminWrite(h, 'PATCH', '/api/users/u-patch-badgroup', { groupId: 'grp_does_not_exist' });
      // 这是**真 bug 的回归锁**：`updateUser` 当初漏了 translateWriteError（createUser 有），
      // 于是一个坏外键从 SQLite 冒上来变成 500 —— 前端报"服务端故障"，
      // 运维照着 500 去查服务，真正的问题却在请求体里。
      expect(res.statusCode).toBe(400);
      const body = res.json() as { code: string; details?: { field?: string } };
      expect(body.code).toBe('INVALID_PARAM');
      expect(body.details?.field).toBe('groupId');
    });

    it('缺 groupId 字段 / 用户不存在 → 400 / 404', async () => {
      const h = await setup();
      await loginAs(h, 'u-patch-missing', { groupId: null });
      // `groupId` 必填（可以是 null，但字段得在）：省略一个只有单字段的 PATCH
      // 等于一次"什么都不做却写一条 user.update 审计"的请求。
      const missing = await adminWrite(h, 'PATCH', '/api/users/u-patch-missing', {});
      expect(missing.statusCode).toBe(400);

      // 显式 null 是合法的值（= 退回未分配），与"字段缺失"必须分开
      const nulled = await adminWrite(h, 'PATCH', '/api/users/u-patch-missing', { groupId: null });
      expect(nulled.statusCode).toBe(200);
      expect(nulled.json().groupId).toBe(null);

      const noSuch = await adminWrite(h, 'PATCH', '/api/users/u-nobody-here', { groupId: null });
      expect(noSuch.statusCode).toBe(404);
    });

    it('写审计：user.update 一条，detail 只有 groupId（不含口令/散列）', async () => {
      const h = await setup();
      const mine = createGroup(h.db, { name: 'audit-patch' });
      await loginAs(h, 'u-patch-audit', { groupId: null });
      await adminWrite(h, 'PATCH', '/api/users/u-patch-audit', { groupId: mine.group.id });

      const row = h.db
        .prepare("SELECT action, target_type, target_id, detail FROM audit_log WHERE action = 'user.update'")
        .get() as { action: string; target_type: string; target_id: string; detail: string | null } | undefined;
      expect(row).toBeDefined();
      expect(row?.target_type).toBe('user');
      expect(row?.target_id).toBe('u-patch-audit');
      expect(row?.detail).toContain(mine.group.id);
      // detail 只记归属：一个把口令写进审计的系统，等于把"谁都能读审计的人"变成"知道所有口令的人"
      expect(row?.detail).not.toContain('password');
      expect(row?.detail).not.toContain('scrypt');
    });
  });

  // v1.15.5：这一条是**真 bug 的回归锁**，不是补一个漂亮的用例。
  // v1.15.4 交付「用户管理」页时实测：建得出普通用户，却没有任何一个普通用户登得进
  // 消费面 —— `AuthGate` 进受保护区域第一件事打 `GET /api/auth/session`，
  // 而闸门的放行清单里只有 `/api/console/**` 与 `/api/access-info`。
  // 403 不是 `UNAUTHORIZED`，前端不会跳登录页，而是渲染成"无法连接管理面"的全屏错态。
  // 于是路由分流、`ConsoleLayout`、三页消费面全部够不着。
  describe('§19.1 例外：会话自身的两个端点（v1.15.5）', () => {
    it('GET /api/auth/session → 200 且回自己的 username/role（AuthGate 靠它渲染工作区）', async () => {
      const h = await setup();
      const cookie = await loginAs(h, 'u-session-ok');
      const res = await h.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      // 整个响应体逐一钉住：多一个字段就是一次静默的暴露面扩大
      expect(res.json()).toEqual({
        username: 'u-session-ok',
        role: 'user',
        expiresAt: expect.any(String),
      });
    });

    it('POST /api/auth/logout → 204 且会话真的失效（退得出去，不是只能关浏览器）', async () => {
      const h = await setup();
      const cookie = await loginAs(h, 'u-logout-ok');
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie, 'x-requested-with': 'fetch' },
      });
      expect(res.statusCode).toBe(204);
      // 退完再打 session 必须 401 —— 否则"退出了"是个假动作，浏览器里 cookie 还在
      const after = await h.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie } });
      expect(after.statusCode).toBe(401);
    });

    it('PUT /api/auth/session → 403（路径放行不等于方法放行）', async () => {
      const h = await setup();
      const cookie = await loginAs(h, 'u-session-method');
      const res = await h.app.inject({
        method: 'PUT',
        url: '/api/auth/session',
        headers: { cookie, 'x-requested-with': 'fetch' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('GET /api/auth/logout → 非 200（GET 不该能退登，也就不能被人拿 <img> 打）', async () => {
      const h = await setup();
      const cookie = await loginAs(h, 'u-logout-method');
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/auth/logout',
        headers: { cookie },
      });
      // 这一格**不是 405**：`buildApp` 没挂 `setNotAllowedHandler`，方法不匹配一律落进
      // `setNotFoundHandler`（`src/api/app.ts:607`）。所以"不放行"有两种错法，
      // 实测 `role=user` 拿 403（闸门的 role 判定先命中）、`role=admin` 拿 404。
      // 两者都证明"不能退"，断言因此对 403/404/405 全容错 —— 钉的是**非 200**这件事，
      // 而不是某一个具体码（写死具体码会让将来换 handler 的实现变化误报）。
      expect([403, 404, 405]).toContain(res.statusCode);
    });

    it('session 端点不泄漏别人的数据：回的 username 就是 cookie 里那个', async () => {
      const h = await setup();
      const a = await loginAs(h, 'u-iso-a');
      const b = await loginAs(h, 'u-iso-b');
      const ra = await h.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: a } });
      const rb = await h.app.inject({ method: 'GET', url: '/api/auth/session', headers: { cookie: b } });
      expect((ra.json() as { username: string }).username).toBe('u-iso-a');
      expect((rb.json() as { username: string }).username).toBe('u-iso-b');
    });
  });

  it('建用户写审计：user.create / user.delete 各一条，detail 不含口令', async () => {
    const h = await setup();
    await adminWrite(h, 'POST', '/api/users', {
      username: 'audited',
      password: 'audited-pass-1234',
      role: 'user',
    });
    await adminWrite(h, 'DELETE', '/api/users/audited');
    const rows = h.db
      .prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'user.%' ORDER BY ts")
      .all() as { action: string; detail: string | null }[];
    expect(rows.map((r) => r.action)).toEqual(['user.create', 'user.delete']);
    // `user.create` 的 detail 记角色与归属组（**不记口令**）；`user.delete` 没有 detail
    // —— 它记的是"删了谁"，而 `target_id` 已经是那个 username 了，再写一遍是冗余。
    // 所以这里逐行断言的是"没有任何一行出现口令"，而不是"每一行都有 detail"：
    // `null.toContain(...)` 在 vitest 里会抛，得先收窄。
    for (const r of rows) {
      expect(r.detail ?? '').not.toContain('audited-pass-1234');
    }
    // 反向钉住 create 那条**确实**带了角色信息 ——
    // 否则"不记口令"会因为"什么都没记"而恒真，测不出任何东西。
    expect(rows[0]?.detail).toContain('"role":"user"');
  });
});

describe('§19.3b 消费面 key 自助（v1.15.9 / ADR-0038 订正决策 3）', () => {
  /**
   * 这一组用例钉的是**ADR-0038 对 ADR-0034 决策 3 的订正**：消费面从"零写方法"
   * 变成"key 自助这一组写方法 + 护栏"。所以本组保留原来那两条用例的**判据形状**
   * （量前后差、不信绝对数、明文不能落盘），而不是把它们删掉 ——
   * 被订正的规则最危险的状态是"旧用例跟着一起没了"，于是没人再钉新规则。
   *
   * `PUT /api/console/usage → 404/405` 那条**原样留着**：它钉的是"读端点没有写方法"，
   * 而 v1.15.9 只下了 key 这一组写权限，`/usage` 上的写方法照旧不存在。
   */

  it('签发 → 201 + 明文只在这一次响应里 + label 落库 + 审计（前后差量法）', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const cookie = await loginAs(h, 'u-issue', { groupId: mine.group.id });
    // 量**前后差**而不是绝对值：v1.15.6 起首启引导会多种一个「管理组」并给它签发一把 key。
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM gateway_keys').get() as { n: number }).n;

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/console/keys',
      headers: { cookie, ...WRITE_HEADERS },
      payload: { label: '我的桌面客户端' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const issued = res.json() as {
      id: string;
      gatewayKey: string;
      maskedKey: string;
      label: string | null;
      createdAt: string;
    };
    // 明文在这里出现（§4 形状：`gw-` 前缀），且是本组那把 —— 不是别组的
    expect(issued.gatewayKey.startsWith('gw-')).toBe(true);
    expect(issued.maskedKey.startsWith('****')).toBe(true);
    expect(issued.maskedKey).toBe(`****${issued.gatewayKey.slice(-4)}`);
    expect(issued.label).toBe('我的桌面客户端');

    // 库里**只多了一行**，且那把 key 属于本组
    const after = (h.db.prepare('SELECT COUNT(*) AS n FROM gateway_keys').get() as { n: number }).n;
    expect(after).toBe(before + 1);
    const row = h.db
      .prepare('SELECT group_id, key_hash, label FROM gateway_keys WHERE id = ?')
      .get(issued.id) as { group_id: string; key_hash: string; label: string | null };
    expect(row.group_id).toBe(mine.group.id);
    expect(row.label).toBe('我的桌面客户端');
    // 库里**没有明文**：只有 sha256 摘要（拿明文现算一次比对）
    expect(row.key_hash).not.toBe(issued.gatewayKey);
    expect(row.key_hash).toHaveLength(64);

    // 审计：复用管理面那一个动作码（不新造 `gateway_key.self_issue`），detail 只有掩码
    const audits = h.db
      .prepare("SELECT actor, action, detail FROM audit_log WHERE action = 'gateway_key.issue'")
      .all() as { actor: string; action: string; detail: string | null }[];
    const mineAudit = audits.filter((a) => a.actor === 'u-issue');
    expect(mineAudit).toHaveLength(1);
    expect(mineAudit[0]?.detail).toBe(issued.maskedKey);
    expect(JSON.stringify(audits)).not.toContain(issued.gatewayKey);
  });

  it('label 留空 / 纯空白 / 不传 → 全部收成 null（只有一种"没名字"）', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const cookie = await loginAs(h, 'u-issue-label', { groupId: mine.group.id });

    const labels: (string | null)[] = [];
    const ids: string[] = [];
    for (const payload of [{ label: '   ' }, { label: '' }, {}]) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/console/keys',
        headers: { cookie, ...WRITE_HEADERS },
        payload,
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json() as { id: string; label: string | null };
      labels.push(body.label);
      ids.push(body.id);
    }
    // 三种写法归一化成同一个值 —— 库里两种"空"并存的话，前端判空的那一句得写两遍
    expect(labels).toEqual([null, null, null]);
    // 逐行查这三把（**不数本组 NULL 的行数**：建组自带那把 key 的 label 也是 NULL，
    // 数总数就把"引导流程种了几把"混进了这条用例的判据里）
    const stored = h.db
      .prepare(`SELECT id, label FROM gateway_keys WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { id: string; label: string | null }[];
    expect(stored).toHaveLength(3);
    expect(stored.every((r) => r.label === null)).toBe(true);
  });

  it('护栏：到上限后签发 → 422 UNPROCESSABLE，且**一把都不多**', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const cookie = await loginAs(h, 'u-issue-cap', { groupId: mine.group.id });
    // **只数本组的行**（不数全表）：v1.15.6 起首启引导会建一个「管理组」并给它签发一把 key，
    // 全表计数会把"引导种了几把"混进来；而这条用例的量是"我这个组几把了"。
    const mineCount = (): number =>
      (h.db.prepare('SELECT COUNT(*) AS n FROM gateway_keys WHERE group_id = ?').get(mine.group.id) as {
        n: number;
      }).n;
    // 建组自带 1 把，所以再签 9 把正好到 10（上限 10 由服务端 `KEY_SELF_ISSUE_LIMIT` 钉）
    for (let i = 0; i < 9; i += 1) {
      const ok = await h.app.inject({
        method: 'POST',
        url: '/api/console/keys',
        headers: { cookie, ...WRITE_HEADERS },
        payload: { label: `k${i}` },
      });
      expect(ok.statusCode, ok.body).toBe(201);
    }
    const atCap = mineCount();

    const over = await h.app.inject({
      method: 'POST',
      url: '/api/console/keys',
      headers: { cookie, ...WRITE_HEADERS },
      payload: { label: 'the 11th' },
    });
    // 422 而不是 400/409：表单填得对、身份也对，挡下它的是**这个组的现状**
    expect(over.statusCode, over.body).toBe(422);
    const body = over.json() as { code: string; details: { limit: number; used: number } };
    expect(body.code).toBe('UNPROCESSABLE');
    expect(body.details.limit).toBe(10);
    expect(body.details.used).toBe(10);

    // 真正的判据：被拒的那一下**没有落新 key**
    expect(mineCount()).toBe(atCap);
    // 且真的到了上限（否则"没变"会因为"本来就没到"而恒真）
    expect(atCap).toBe(10);

    // 护栏只挡**自己签**：管理员那条路照旧没有这个上限（他的签发按钮在组列表里，
    // 与"我这个组几把了"无关）—— 不然"该拆组了"的用户会被一个前端按钮彻底锁死。
    const adminIssue = await adminWrite(h, 'POST', `/api/groups/${mine.group.id}/keys`);
    expect(adminIssue.statusCode, adminIssue.body).toBe(201);
  });

  it('未分配组 → 400（不是 404、更不是 500）：签一把必然打不通的 key 不是"少个功能"', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-issue-nogroup', { groupId: null });
    for (const [method, url] of [
      ['POST', '/api/console/keys'],
      ['PATCH', '/api/console/keys/gwk_whatever'],
      ['DELETE', '/api/console/keys/gwk_whatever'],
    ] as const) {
      const res = await h.app.inject({
        method,
        url,
        headers: { cookie, ...WRITE_HEADERS },
        payload: method === 'DELETE' ? undefined : {},
      });
      expect(res.statusCode, `${method} ${url}: ${res.body}`).toBe(400);
      expect((res.json() as { details: { field: string } }).details.field).toBe('groupId');
    }
  });

  it('改名：PATCH → 200，回的是**库里那个值**（trim 后），不是入参', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const cookie = await loginAs(h, 'u-rename', { groupId: mine.group.id });
    const keyId = mine.gatewayKey.id;

    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/console/keys/${keyId}`,
      headers: { cookie, ...WRITE_HEADERS },
      payload: { label: '  生产环境  ' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { id: string; label: string | null; maskedKey: string; createdAt: string };
    expect(body.id).toBe(keyId);
    // 回的是归一化之后的值 —— 让前端自己 trim 一遍就是第二份口径
    expect(body.label).toBe('生产环境');
    expect(body.maskedKey).toBe(mine.gatewayKey.maskedKey);
    // 响应里没有任何明文（改名这条路**不可能**给出明文）
    expect(res.body).not.toContain(mine.gatewayKey.gatewayKey);
    expect(res.body).not.toContain('"gatewayKey"');

    // 清名字：`null` 是合法值，不是"清空"以外的意思
    const cleared = await h.app.inject({
      method: 'PATCH',
      url: `/api/console/keys/${keyId}`,
      headers: { cookie, ...WRITE_HEADERS },
      payload: { label: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((cleared.json() as { label: string | null }).label).toBe(null);
  });

  it('吊销 → 204 且那一行真的没了；列表与 Group.keyCount 同步', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const cookie = await loginAs(h, 'u-revoke', { groupId: mine.group.id });
    const first = mine.gatewayKey.id;

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/console/keys/${first}`,
      headers: { cookie, ...WRITE_HEADERS },
    });
    expect(res.statusCode, res.body).toBe(204);
    // 硬删（ADR-0008）：行没了，不是打了删除标记
    expect(
      (h.db.prepare('SELECT COUNT(*) AS n FROM gateway_keys WHERE id = ?').get(first) as { n: number }).n,
    ).toBe(0);
    // 列表跟着空了，`assigned` 仍是 true（组还在，只是里面一把 key 都没有）
    const list = await h.app.inject({ method: 'GET', url: '/api/console/keys', headers: { cookie } });
    expect((list.json() as { keys: unknown[]; assigned: boolean }).keys).toHaveLength(0);
    expect((list.json() as { assigned: boolean }).assigned).toBe(true);
    // 再删一次 → 404（重复点不该静默成功）
    const again = await h.app.inject({
      method: 'DELETE',
      url: `/api/console/keys/${first}`,
      headers: { cookie, ...WRITE_HEADERS },
    });
    expect(again.statusCode).toBe(404);
  });

  it('跨组越权一律 404（不是 403）：改名 / 吊销别人的 key 都碰不到', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const other = createGroup(h.db, { name: 'other-group' });
    const cookie = await loginAs(h, 'u-cross', { groupId: mine.group.id });
    const victim = other.gatewayKey.id;

    for (const [method, payload] of [
      ['PATCH', { label: 'hijacked' }],
      ['DELETE', undefined],
    ] as const) {
      const res = await h.app.inject({
        method,
        url: `/api/console/keys/${victim}`,
        headers: { cookie, ...WRITE_HEADERS },
        ...(payload === undefined ? {} : { payload }),
      });
      // 404 而不是 403：403 会说"这个 keyId 存在、只是不属于你" —— 那正是枚举的反馈信号
      expect(res.statusCode, `${method}: ${res.body}`).toBe(404);
    }
    // 越权失败必须**零副作用**：别组那把 key 还在，名字没被改
    const row = h.db
      .prepare('SELECT label FROM gateway_keys WHERE id = ?')
      .get(victim) as { label: string | null };
    expect(row.label).toBe(null);
  });

  it('写方法照旧要过 CSRF：不带 x-requested-with → 403 CSRF_REJECTED（消费面不豁免）', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const cookie = await loginAs(h, 'u-csrf', { groupId: mine.group.id });
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM gateway_keys').get() as { n: number }).n;

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/console/keys',
      headers: { cookie }, // ← 故意不带 x-requested-with
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { code: string }).code).toBe('CSRF_REJECTED');
    // 被 CSRF 挡下的那一下同样不能落 key
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM gateway_keys').get() as { n: number }).n).toBe(before);
  });

  it('消费面没有别的写路径：PUT /api/console/usage → 404 / 405（实测 404）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-no-write');
    const res = await h.app.inject({
      method: 'PUT',
      url: '/api/console/usage',
      headers: { cookie, ...WRITE_HEADERS },
      payload: {},
    });
    // 本仓**没有 405**：`buildApp` 没挂 `setNotAllowedHandler`，方法不匹配一律落进
    // `setNotFoundHandler`（`src/api/app.ts:607`），所以实测拿到的是 404 `NOT_FOUND`
    // 「接口不存在: PUT /api/console/usage」（这里是 `role=user`，而 `/api/console/**`
    // 对 user 是放行的，所以不会先撞 403）。对 405 保留容错，是因为钉的是
    // "**这条读端点没有写方法**"这件事，而不是某个具体码。
    expect([404, 405]).toContain(res.statusCode);
  });

  it('明文不落盘：签发完关库，裸文件里找不到那把 key（含被吊销的）', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const cookie = await loginAs(h, 'u-plaintext', { groupId: mine.group.id });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/console/keys',
      headers: { cookie, ...WRITE_HEADERS },
      payload: { label: '被测的这把' },
    });
    const issued = res.json() as { id: string; gatewayKey: string };

    // 吊销它，再关库 —— 删行不等于它从没写过，两种情况都要在同一份裸文件里查
    await h.app.inject({
      method: 'DELETE',
      url: `/api/console/keys/${issued.id}`,
      headers: { cookie, ...WRITE_HEADERS },
    });
    const dbPath = h.dbPath;
    await h.app.close();
    h.db.close();
    const raw = readRawFiles(dbPath);
    expect(containsPlaintext(raw, issued.gatewayKey)).toBe(false);
    // 反向钉住：把明文拼进去，同一个探针必须为 true（否则"找不到"是恒真的）
    expect(containsPlaintext(Buffer.concat([raw, Buffer.from(issued.gatewayKey, 'utf8')]), issued.gatewayKey)).toBe(true);
  });
});

describe('§19.3c GET /api/console/quota（v1.15.9）', () => {
  it('口径与 §4 GroupDto 同源：同一组的 owner 在两面看到同一句话', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'quota-group' });
    // 直接改库设配额（本端点测的是"读出来的对不对"，不是"改配额的端点"）
    h.db
      .prepare('UPDATE groups SET rpm = 60, tpm = 120000, daily_quota = 500000 WHERE id = ?')
      .run(mine.group.id);
    const at = new Date().toISOString();
    h.db
      .prepare(
        `INSERT INTO usage_logs (id, ts, group_id, model, upstream_id, key_id, key_masked, status,
           prompt_tokens, completion_tokens, total_tokens, is_estimated, stream, cost_cents)
         VALUES ('log_q1', ?, ?, 'gpt-test', 'ups_test', 'gwk_test', '****test', 200, 10, 20, 30, 0, 0, 7)`,
      )
      .run(at, mine.group.id);
    const cookie = await loginAs(h, 'u-quota', { groupId: mine.group.id });

    const res = await h.app.inject({ method: 'GET', url: '/api/console/quota', headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      groupId: mine.group.id,
      assigned: true,
      rpm: 60,
      tpm: 120000,
      dailyQuota: 500000,
      dailyQuotaUsed: 30,
      todayUsage: { requests: 1, tokens: 30, costCents: 7 },
    });

    // **逐字同源**：管理面读同一个组，那几格必须一样（这是本用例真正的判据 ——
    // 上面那些数字写死在这里只证明"这次读对了"，不证明"两面是同一份口径"）。
    const adminView = await h.app.inject({
      method: 'GET',
      url: `/api/groups/${mine.group.id}`,
      headers: { cookie: h.adminCookie },
    });
    const g = adminView.json() as {
      rpm: number | null;
      tpm: number | null;
      dailyQuota: number | null;
      dailyQuotaUsed: number;
      todayUsage: { requests: number; tokens: number; costCents: number };
    };
    const consoleView = res.json() as typeof g;
    expect(consoleView.rpm).toBe(g.rpm);
    expect(consoleView.tpm).toBe(g.tpm);
    expect(consoleView.dailyQuota).toBe(g.dailyQuota);
    expect(consoleView.dailyQuotaUsed).toBe(g.dailyQuotaUsed);
    expect(consoleView.todayUsage).toEqual(g.todayUsage);
  });

  it('未分配组 → 回 null 而不是 0（"没有配额"与"配额是 0"是两件事）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-quota-nogroup', { groupId: null });
    const res = await h.app.inject({ method: 'GET', url: '/api/console/quota', headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      groupId: null,
      assigned: false,
      rpm: null,
      tpm: null,
      dailyQuota: null,
      dailyQuotaUsed: 0,
      todayUsage: { requests: 0, tokens: 0, costCents: 0 },
    });
  });

  it('组被管理员删掉、而会话还指着它 → 回"未分配"那一形状，不是 500', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'doomed' });
    const cookie = await loginAs(h, 'u-quota-doomed', { groupId: mine.group.id });
    // 用管理面端点删组：这条路径的收尾（`admin_users.group_id` 置回 NULL）是既有行为
    const del = await adminWrite(h, 'DELETE', `/api/groups/${mine.group.id}`);
    expect(del.statusCode, del.body).toBe(204);
    // 会话里的 groupId 是**每次鉴权现读**的（ADR-0034），所以下一次请求它已经是 null ——
    // 这里钉的正是那条性质，而不是"库里那一行没了还能不能渲染"
    const res = await h.app.inject({ method: 'GET', url: '/api/console/quota', headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { assigned: boolean }).assigned).toBe(false);
  });
});

describe('§1b POST /api/auth/password 改自己的口令（v1.15.9 / ADR-0038 决策 3）', () => {
  /** 同一个账号的第二个会话（模拟"另一台设备"）。 */
  async function loginAgain(h: Harness, username: string, password: string): Promise<string> {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username, password },
      headers: { 'x-requested-with': 'fetch' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const raw = res.headers['set-cookie'];
    return String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
  }

  it('普通用户改密成功 → 204；新口令能登、旧口令不能；**其他会话被踢、当前会话留着**', async () => {
    const h = await setup();
    const mine = createGroup(h.db, { name: 'my-group' });
    const deviceA = await loginAs(h, 'u-pass', { groupId: mine.group.id });
    // 同一账号在"另一台设备"再登一次 —— 这条用例的全部判据都建立在"两条会话并存"上
    const deviceB = await loginAgain(h, 'u-pass', 'console-user-pass-1');

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: deviceB, ...WRITE_HEADERS },
      payload: { currentPassword: 'console-user-pass-1', newPassword: 'brand-new-pass-2' },
    });
    expect(res.statusCode, res.body).toBe(204);

    // 当前会话留着：改完密码不必马上再登一次
    const stillMe = await h.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: deviceB },
    });
    expect(stillMe.statusCode, stillMe.body).toBe(200);
    expect((stillMe.json() as { username: string }).username).toBe('u-pass');

    // 其他会话**死了** —— 那正是这次改密的动机，只改散列而不撤会话等于什么都没做
    const others = await h.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: deviceA },
    });
    expect(others.statusCode).toBe(401);

    // 新口令能登、旧口令不能
    const withNew = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'u-pass', password: 'brand-new-pass-2' },
      headers: { 'x-requested-with': 'fetch' },
    });
    expect(withNew.statusCode, withNew.body).toBe(200);
    const withOld = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'u-pass', password: 'console-user-pass-1' },
      headers: { 'x-requested-with': 'fetch' },
    });
    expect(withOld.statusCode).toBe(401);

    // 审计：成功一条。detail 里不出现任何口令
    const rows = h.db
      .prepare("SELECT result, detail FROM audit_log WHERE action = 'auth.password'")
      .all() as { result: string; detail: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('ok');
    expect(JSON.stringify(rows)).not.toContain('brand-new-pass-2');
    expect(JSON.stringify(rows)).not.toContain('console-user-pass-1');
    // 库里也没有明文口令 —— 只有 scrypt 散列
    const hash = (
      h.db.prepare('SELECT password_hash FROM admin_users WHERE username = ?').get('u-pass') as {
        password_hash: string;
      }
    ).password_hash;
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('brand-new-pass-2');
  });

  it('管理员也是走同一条路径（改自己的口令与 role 无关）', async () => {
    const h = await setup();
    const res = await adminWrite(h, 'POST', '/api/auth/password', {
      currentPassword: ADMIN_PASS,
      newPassword: 'admin-new-pass-9',
    });
    expect(res.statusCode, res.body).toBe(204);
    // 改完这个会话还能用
    const me = await h.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: h.adminCookie },
    });
    expect(me.statusCode).toBe(200);
  });

  it('旧口令不对 → 401 INVALID_CREDENTIALS + 审计记 fail（不记失败等于把爆破痕迹丢掉）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-pass-wrong');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie, ...WRITE_HEADERS },
      payload: { currentPassword: 'not-my-password', newPassword: 'whatever-new-1' },
    });
    expect(res.statusCode, res.body).toBe(401);
    expect((res.json() as { code: string }).code).toBe('INVALID_CREDENTIALS');
    // 口令没被改动：旧口令照旧能登
    const good = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'u-pass-wrong', password: 'console-user-pass-1' },
      headers: { 'x-requested-with': 'fetch' },
    });
    expect(good.statusCode).toBe(200);

    const rows = h.db
      .prepare("SELECT result, detail FROM audit_log WHERE action = 'auth.password'")
      .all() as { result: string; detail: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toBe('fail');
    expect(rows[0]?.detail).toBe('invalid_current_password');
  });

  it('新旧口令相同 → 400（否则"改密成功"可能什么都没变，而用户以为自己换了）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-pass-same');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie, ...WRITE_HEADERS },
      payload: { currentPassword: 'console-user-pass-1', newPassword: 'console-user-pass-1' },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { details: { field: string } }).details.field).toBe('newPassword');
  });

  it('新口令短于 8 位 → 400：与建号同一把尺子（不是"改密可以更弱"）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-pass-short');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie, ...WRITE_HEADERS },
      payload: { currentPassword: 'console-user-pass-1', newPassword: '1234567' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { code: string }).code).toBe('INVALID_PARAM');
  });

  it('未登录 → 401（改密不豁免鉴权）', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { ...WRITE_HEADERS },
      payload: { currentPassword: 'x'.repeat(9), newPassword: 'y'.repeat(9) },
    });
    expect(res.statusCode).toBe(401);
  });

  it('不带 x-requested-with → 403 CSRF_REJECTED（写方法一律过 CSRF，改密不例外）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-pass-csrf');
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'console-user-pass-1', newPassword: 'brand-new-pass-3' },
    });
    expect(res.statusCode, res.body).toBe(403);
    expect((res.json() as { code: string }).code).toBe('CSRF_REJECTED');
  });

  it('GET /api/auth/password → 非 200（路径放行不等于方法放行；本仓无 405）', async () => {
    const h = await setup();
    const cookie = await loginAs(h, 'u-pass-method');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/auth/password',
      headers: { cookie },
    });
    // 见下面 PUT /api/console/usage 那条的同一条注释：本仓**没有 405**，
    // 方法不匹配落进 `setNotFoundHandler`。`role=user` 实测 403（role 判定先命中）、
    // `role=admin` 实测 404。断言钉的是"**路径放行 ≠ 方法放行**"（即非 200），
    // 对三个码全容错。
    expect([403, 404, 405]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(200);
  });
});
