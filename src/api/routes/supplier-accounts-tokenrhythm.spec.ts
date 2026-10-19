// TokenRhythm 在路由/服务层的分发验收（契约 §15.14）。
//
// 驱动器本身的形状（信封 / CSRF 自愈 / 掩码换算）在 `supplier/tokenrhythm.spec.ts`
// 已经离线钉死；这个文件回答的是**另一层**的问题：`upstreams.supplier = 'tokenrhythm'`
// 这一位能力位，是否真的让六个批量端点把活派给了 TokenRhythm 驱动器 ——
// 发出去的请求打到 TokenRhythm 的路径、带 TokenRhythm 的形状，TierFlow 的
// 路径一条都不出现。**一个网络请求都不发**（`fetchImpl` 注入），但假上游复刻实测的
// CSRF 机器（只有 2xx 回发新 tr_csrf、写请求按双提交 + Sec-Fetch-Site 校验），
// 于是"分发对了但写请求缺礼数"这一类错在这里就会当场 403。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import { openDatabase, type Db } from '../../db/database.js';
import { sha256Hex } from '../../db/crypto.js';
import { createKey, decryptedKeyRefs } from '../../db/repo/keys.js';
import { getTask } from '../../db/repo/tasks.js';
import { createUpstream } from '../../db/repo/upstreams.js';
import { createSupplierAccount } from '../../db/repo/supplier-accounts.js';
import { encodePasswordBlob, encodeSessionBlob } from '../../supplier/credentials.js';
import { buildApp } from '../app.js';
import { bootstrapAdmin } from '../auth.js';
import type { SupplierBatchResult, SupplierTestResult, TaskDto } from '../dto.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'acc-tr-dispatch-1';
const MASTER_KEY = Buffer.from('2b'.repeat(32), 'hex');

/** 合成账号（§15 用例纪律：这个库里不出现真实号码 / 密码）。 */
const TR_ID = '19200000001';
const TR_SECRET = 'tr-probe-secret-A9';
const TR_ID_MASKED = '192****0001';

/** 建出的那把 key：明文只在栈内与密文里出现，尾巴与上游掩码一致（实测样例形状）。 */
const CREATED_PLAINTEXT = 'sk_tr_' + 'q'.repeat(20) + '6Us8';
const CREATED_ID = 'c3d9a4f0-1111-4222-8333-444455556666';

// ---------------------------------------------------------------------------
// 假上游：TokenRhythm 形状（复刻 tokenrhythm.spec.ts 的 CSRF 机器）
// ---------------------------------------------------------------------------

interface Call {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface TrSpec {
  status: number;
  body: unknown;
  cookies?: readonly string[];
}

function fakeTokenrhythm(): { impl: typeof fetch; calls: Call[]; count(path: string): number } {
  const calls: Call[] = [];
  let serverCsrf: string | null = null;
  let issued = 0;

  const me = { status: 200, body: { code: 0, message: 'ok', data: { id: 'u-1', name: 'tr-probe', phoneMasked: TR_ID_MASKED } } };
  const wallet = {
    status: 200,
    body: { code: 0, message: 'ok', data: { currency: 'CNY', availableBalanceCny: '23.66510789' } },
  };
  const keyList = {
    status: 200,
    body: {
      code: 0,
      message: 'ok',
      data: [
        { id: CREATED_ID, name: 'tokenrhythm-0001-1', maskedKey: 'sk_tr_5o****6Us8', keyPrefix: 'sk_tr_5o', status: 'active' },
        { id: 'd4e0b5f1-2222-4333-9444-555566667777', name: 'other-key', maskedKey: 'sk_tr_ab****zzzz', keyPrefix: 'sk_tr_ab', status: 'active' },
      ],
    },
  };

  const routes: Record<string, (call: Call, ctx: { csrf: string | null }) => TrSpec> = {
    'GET /api/me': (call) => {
      // 让用例能造一枚"真过期"的会话：401 是唯一的会话失效信号（ADR-0040）。
      if (cookieOf(call, 'tr_session') === 'expired-session') {
        return { status: 401, body: { code: 'UNAUTHORIZED', message: '未认证或登录已过期' } };
      }
      return me;
    },
    'GET /api/wallet/summary': () => wallet,
    'GET /api/api-keys': () => keyList,
    // 建 key 是写操作：双提交 + Sec-Fetch-Site 缺一不可（实测口径）。
    'POST /api/api-keys': (call, ctx) => {
      const header = call.headers['x-csrf-token'] ?? null;
      const cookie = cookieOf(call, 'tr_csrf');
      if (header === null || header !== ctx.csrf || header !== cookie || call.headers['sec-fetch-site'] !== 'same-origin') {
        return { status: 403, body: { code: 'CSRF_INVALID', message: '请求安全校验失败，请刷新页面后重试' } };
      }
      const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
      return {
        status: 200,
        body: {
          code: 0,
          message: 'ok',
          data: { id: CREATED_ID, key: CREATED_PLAINTEXT, maskedKey: 'sk_tr_5o****6Us8', name: body['name'] },
        },
      };
    },
  };

  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = {
      path: url.pathname,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);
    const handler = routes[`${call.method} ${call.path}`];
    const spec: TrSpec =
      handler === undefined ? { status: 404, body: { code: 'NOT_FOUND', message: `接口不存在 ${call.path}` } } : handler(call, { csrf: serverCsrf });
    const res = new Response(JSON.stringify(spec.body), { status: spec.status, headers: { 'content-type': 'application/json' } });
    // 多枚 Set-Cookie 逐条 append（getSetCookie 语义），且**只有 2xx 回发新 tr_csrf**（实测）。
    if (spec.status >= 200 && spec.status < 300) {
      issued += 1;
      serverCsrf = `csrf-${issued}`;
      res.headers.append('set-cookie', `tr_csrf=${serverCsrf}; Path=/; HttpOnly`);
    }
    for (const c of spec.cookies ?? []) res.headers.append('set-cookie', c);
    return res;
  }) as unknown as typeof fetch;

  return { impl, calls, count: (path) => calls.filter((c) => c.path === path).length };
}

/** 从请求头里取 Cookie 值。 */
function cookieOf(call: Call, name: string): string | null {
  const raw = call.headers['cookie'] ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** TokenRhythm 驱动器该打（与不该打）的全部路径 —— 分发对错的唯一判据。 */
const TR_PATHS = new Set(['/api/me', '/api/wallet/summary', '/api/api-keys']);

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  db: Db;
  cookie: string;
  upstreamId: string;
  upstream: ReturnType<typeof fakeTokenrhythm>;
}

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
      /* 已关 */
    }
  }
});

function makeConfig(dbPath: string): AppConfig {
  return {
    masterKey: MASTER_KEY,
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
  };
}

async function setup(options: { excluded?: readonly string[] } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'acc-tr-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const upstream = fakeTokenrhythm();
  const app = buildApp({
    db,
    config: makeConfig(dbPath),
    balanceSync: false,
    healthSnapshots: false,
    supplier: {
      fetchImpl: upstream.impl,
      excluded: new Set<string>(options.excluded ?? []),
      // 0.6s 节奏不为用例存在：gapMs:0 且 sleep 一旦被等就抛错。
      pacing: { gapMs: 0, sleep: (ms) => Promise.reject(new Error(`用例不该等待节奏间隔 ${ms}ms`)) },
    },
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

  // TokenRhythm 型上游：能力位决定分发（ADR-0018 决策 0），这里就是被测对象。
  // 带上 `/v1`：真实上游的 `base_url` 是网关根，而身份 / 钱包 / key 都在站点根下。
  // 少了这一段，`/api/me` 会被拼成 `/v1/api/me`，假上游回 404 —— 本文件的所有用例都会红。
  const up = createUpstream(db, { name: 'tokenrhythm', baseUrl: 'https://tokenrhythm.example/v1', supplier: 'tokenrhythm' });

  const h: Harness = { app, db, cookie, upstreamId: up.id, upstream };
  harnesses.push(h);
  return h;
}

/** 种一个 TokenRhythm 账号（默认带活会话 —— 各端点自己声明"没会话"的用例另行覆盖）。 */
function seedTrAccount(
  db: Db,
  upstreamId: string,
  over: { password?: string | null; session?: string | null } = {},
): string {
  const id = 'acc_' + sha256Hex(TR_ID + ':tr').slice(0, 12);
  createSupplierAccount(db, id, {
    upstreamId,
    supplier: 'tokenrhythm',
    identifier: TR_ID_MASKED,
    identifierHash: sha256Hex(TR_ID),
    status: 'unknown',
    ...(over.password === null ? {} : { encryptedPassword: encodePasswordBlob(TR_ID, over.password ?? TR_SECRET, MASTER_KEY) }),
    ...(over.session === null
      ? { encryptedSession: null }
      : { encryptedSession: encodeSessionBlob(over.session ?? 'sess-tr-live', 'u-1', MASTER_KEY) }),
  });
  return id;
}

async function post(
  h: Harness,
  url: string,
  payload?: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: 'POST',
    url,
    headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function settle(db: Db, taskId: string): Promise<TaskDto> {
  for (let i = 0; i < 500; i += 1) {
    const task = getTask(db, taskId);
    if (task !== null && (task.status === 'succeeded' || task.status === 'failed')) return task;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`任务 ${taskId} 未在预期时间内进入终态`);
}

async function runBatch(
  h: Harness,
  url: string,
  payload: Record<string, unknown>,
): Promise<{ task: TaskDto; result: SupplierBatchResult }> {
  const res = await post(h, url, payload);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const task = await settle(h.db, String(res.body['taskId']));
  expect(task.status, task.message ?? '').toBe('succeeded');
  return { task, result: task.result as SupplierBatchResult };
}

function accountRow(db: Db, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM supplier_accounts WHERE id = ?').get(id) as Record<string, unknown>;
}

/** 断言：发出的请求**全部**落在 TokenRhythm 的路径集里 —— TierFlow 的路径一条都不该出现。 */
function assertOnlyTokenrhythmPaths(h: Harness): void {
  const foreign = h.upstream.calls.filter((c) => !TR_PATHS.has(c.path));
  expect(
    foreign.map((c) => `${c.method} ${c.path}`),
    '分发到了 TokenRhythm 之外的路径',
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

describe('TokenRhythm 分发接线（§15.14 / ADR-0018 决策 0）', () => {
  it('import：入口 422（会话型供应商没有密码登录），零上游请求、零行写入', async () => {
    const h = await setup();
    const res = await post(h, '/api/supplier-accounts/import', {
      upstreamId: h.upstreamId,
      text: `${TR_ID},${TR_SECRET}`,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body['code']).toBe('UNPROCESSABLE');
    // 拒绝发生在解析文本 / 发请求之前：没有任何线路，也没有任何账号行。
    expect(h.upstream.calls).toHaveLength(0);
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM supplier_accounts').get()).toEqual({ n: 0 });
    // 凭据不能借错误消息回显。
    expect(JSON.stringify(res.body)).not.toContain(TR_SECRET);
  });

  it(':id/login：TokenRhythm 无密码重登，入口 422（即使会话看起来是活的）', async () => {
    const h = await setup();
    const accountId = seedTrAccount(h.db, h.upstreamId, { session: 'sess-tr-live' });

    const res = await post(h, `/api/supplier-accounts/${accountId}/login`);
    expect(res.status).toBe(422);
    expect(res.body['code']).toBe('UNPROCESSABLE');
    // 能力缺口在入口答，不拿会话去撞上游。
    expect(h.upstream.calls).toHaveLength(0);
    expect(accountRow(h.db, accountId)['status']).toBe('unknown');
  });

  it(':id/test：诊断走 TR 两腿，余额 2367 分、套餐数 0（无套餐腿是零请求）', async () => {
    const h = await setup();
    const accountId = seedTrAccount(h.db, h.upstreamId, { session: 'sess-tr-live' });

    const res = await post(h, `/api/supplier-accounts/${accountId}/test`);
    expect(res.status).toBe(200);
    const result = res.body as unknown as SupplierTestResult;
    expect(result.ok).toBe(true);
    expect(result.parsed.balanceCents).toBe(2367);
    // subscriptions() 对 TokenRhythm 是零请求的空数组 —— 套餐数是确定的 0，不是 null。
    expect(result.parsed.subscriptionCount).toBe(0);

    assertOnlyTokenrhythmPaths(h);
    expect(h.upstream.calls).toHaveLength(2);
  });

  it('keys：默认形状建出 1 把 —— 上游只收 {name}，name 前缀跟随供应商，明文入池只回掩码', async () => {
    const h = await setup();
    const accountId = seedTrAccount(h.db, h.upstreamId, { session: 'sess-tr-live' });

    const { result } = await runBatch(h, '/api/supplier-accounts/keys', {
      upstreamId: h.upstreamId,
      ids: [accountId],
      count: 1,
      unlimited: true,
    });

    const item = result.items[0];
    expect(item).toMatchObject({ action: 'create', ok: true, keyMasked: '****6Us8' });
    expect(item?.tokenNo).toBeNull(); // data.id 是 UUID，解不出整数 → null（§15.14）
    assertOnlyTokenrhythmPaths(h);

    // 写请求走完整 CSRF 礼数（假上游按双提交 + Sec-Fetch-Site 校验，缺了当场 403），
    // 且 body 只有 {name} —— 额度/白名单字段一条都不许漏给上游。
    const create = h.upstream.calls.find((c) => c.path === '/api/api-keys' && c.method === 'POST');
    expect(create).toBeTruthy();
    expect(JSON.parse(String(create?.body))).toEqual({ name: 'tokenrhythm-0001-1' });
    expect(h.upstream.count('/api/me')).toBe(1); // 只为种 csrf 的一次 GET

    // 明文入了池（服务端解出来就是上游给的那把），但 result 里只有掩码。
    const refs = decryptedKeyRefs(h.db, { upstreamId: h.upstreamId }, MASTER_KEY);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.decrypted).toBe(CREATED_PLAINTEXT);
    expect(JSON.stringify(result)).not.toContain(CREATED_PLAINTEXT);

    const row = h.db
      .prepare('SELECT unlimited, balance_cents, model_limits, label FROM upstream_keys WHERE id = ?')
      .get(String(item?.keyId)) as Record<string, unknown>;
    expect(row['unlimited']).toBe(1);
    expect(row['balance_cents']).toBeNull();
    expect(row['model_limits']).toBeNull();
    // 默认 namePrefix 跟随供应商：混装池子里分得出这把是谁建的。
    expect(row['label']).toBe('tokenrhythm-0001-1');
    // 建 key 不为拿比值多发一次请求：quota_per_unit 仍是 NULL（§15.5 预算不破）。
    expect(accountRow(h.db, accountId)['quota_per_unit']).toBeNull();
  });

  it('keys：unlimited=false / models 对 TokenRhythm 是入口 422 —— 不建任务、零上游请求', async () => {
    const h = await setup();
    const accountId = seedTrAccount(h.db, h.upstreamId, { session: 'sess-tr-live' });

    for (const payload of [
      { unlimited: false, quotaCents: 1000 },
      { models: ['gpt-4o'] },
    ]) {
      const res = await post(h, '/api/supplier-accounts/keys', { upstreamId: h.upstreamId, ids: [accountId], ...payload });
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body['code']).toBe('UNPROCESSABLE');
    }

    const tasks = h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(tasks.n).toBe(0);
    expect(h.upstream.calls).toHaveLength(0);
  });

  it('rotate-key：TokenRhythm 无套餐概念，整端点 422（不是逐行 SUBSCRIPTION_NOT_FOUND）', async () => {
    const h = await setup();
    const res = await post(h, '/api/supplier-accounts/rotate-key', { upstreamId: h.upstreamId });
    expect(res.status).toBe(422);
    expect(res.body['code']).toBe('UNPROCESSABLE');
    const tasks = h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(tasks.n).toBe(0);
    expect(h.upstream.calls).toHaveLength(0);
  });

  it('keys/sync：TR 的 key 列表对台账 —— 命中 1 行、未命中 1 行，总请求恰好 3 次', async () => {
    const h = await setup();
    const accountId = seedTrAccount(h.db, h.upstreamId, { session: 'sess-tr-live' });
    // 池内一把 key，尾巴与上游第一行一致。
    const pooled = createKey(
      h.db,
      { upstreamId: h.upstreamId, key: 'sk_tr_' + 'r'.repeat(20) + '6Us8', category: 'balance', balance: 100 },
      MASTER_KEY,
    );
    h.db
      .prepare(
        `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, note, created_at, updated_at)
         VALUES ('sak_tr_1', ?, ?, ?, 'tokenrhythm-0001-1', '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z')`,
      )
      .run(accountId, pooled.maskedKey, pooled.id);

    const { result } = await runBatch(h, '/api/supplier-accounts/keys/sync', { upstreamId: h.upstreamId, ids: [accountId] });

    expect(result.items[0]).toMatchObject({ action: 'sync', ok: true });
    expect(result.items[0]?.message).toContain('命中池内 1 行');
    assertOnlyTokenrhythmPaths(h);
    // me + wallet/summary + api-keys，恰好 3 次 —— 套餐腿对 TR 是零请求，
    // 与 TierFlow 的 sync（self/subscription/token 三发）请求数持平。
    expect(h.upstream.calls).toHaveLength(3);

    const rows = h.db
      .prepare('SELECT pooled_key_id FROM supplier_account_keys WHERE account_id = ? ORDER BY pooled_key_id IS NULL')
      .all(accountId) as { pooled_key_id: string | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.pooled_key_id).toBe(pooled.id);
    expect(rows[1]?.pooled_key_id).toBeNull(); // 未命中：只记掩码，不创建可用凭据
  });
});

describe('Cookie 粘贴导入（v1.16.4 / §15.9 管理面入口）', () => {
  const PASTED = 'sess-tr-paste-A9';

  it('import-sessions：202 → 任务成功，逐行 action=import，值只落密文、不回显', async () => {
    const h = await setup();

    const res = await post(h, '/api/supplier-accounts/import-sessions', {
      upstreamId: h.upstreamId,
      text: `tr_session=${PASTED}; Path=/`,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    const task = await settle(h.db, String(res.body['taskId']));
    expect(task.status, task.message ?? '').toBe('succeeded');
    const result = task.result as SupplierBatchResult;
    expect(result).toMatchObject({ done: 1, total: 1, ok: 1, failed: 0, skipped: 0, truncated: false });
    expect(result.items[0]).toMatchObject({
      action: 'import',
      ok: true,
      identifier: TR_ID_MASKED,
      code: null,
    });
    expect(result.items[0]?.accountId).toBeTruthy();

    // 会话明文不进任务结果、不进审计 detail。
    expect(JSON.stringify(task)).not.toContain(PASTED);
    const audits = h.db.prepare("SELECT detail FROM audit_log WHERE action = 'supplier.import'").all() as {
      detail: string | null;
    }[];
    expect(audits.length).toBe(1);
    expect(audits[0]?.detail ?? '').not.toContain(PASTED);

    // 落库是密文，身份展示列是上游给的掩码。
    const row = accountRow(h.db, String(result.items[0]?.accountId));
    expect(row['identifier']).toBe(TR_ID_MASKED);
    expect(Buffer.isBuffer(row['encrypted_session'])).toBe(true);
    expect(String(row['encrypted_session'])).not.toContain(PASTED);

    assertOnlyTokenrhythmPaths(h);
    expect(h.upstream.count('/api/me')).toBe(1); // 每枚会话恰好一次身份查询
  });

  it('import-sessions：重复行算 skipped，过期会话算 failed，单行失败不挡整批', async () => {
    const h = await setup();

    const res = await post(h, '/api/supplier-accounts/import-sessions', {
      upstreamId: h.upstreamId,
      text: [
        `tr_session=${PASTED}`,
        `tr_session=${PASTED}`, // 同一枚会话：解析阶段即跳过
        'tr_session=expired-session', // 上游 401
      ].join('\n'),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    const task = await settle(h.db, String(res.body['taskId']));
    expect(task.status).toBe('succeeded');
    const result = task.result as SupplierBatchResult;
    expect(result).toMatchObject({ done: 3, total: 3, ok: 1, failed: 1, skipped: 1 });

    const byLine = new Map(result.items.map((item) => [item.identifier, item]));
    // 失败行没有掩码，按 action/code 找它。
    const failed = result.items.find((item) => !item.ok && item.code === 'SESSION_EXPIRED');
    expect(failed).toMatchObject({ action: 'import', identifier: null, ok: false });
    expect(failed?.message).toContain('401');
    // 解析失败行的 code 是 LINE_PARSE_FAILED（归 skipped）。
    const skipped = result.items.find((item) => item.code === 'LINE_PARSE_FAILED');
    expect(skipped?.ok).toBe(false);
    expect(byLine.get(TR_ID_MASKED)?.ok).toBe(true);

    expect(JSON.stringify(task)).not.toContain('expired-session');
    expect(JSON.stringify(task)).not.toContain(PASTED);
    expect(h.upstream.count('/api/me')).toBe(2); // 重复行没再打上游
    assertOnlyTokenrhythmPaths(h);
  });

  it('import-sessions：TierFlow 上游入口 422，不建任务、零上游请求', async () => {
    const h = await setup();
    const tf = createUpstream(h.db, { name: 'tierflow', baseUrl: 'https://tf.example', supplier: 'tierflow' });

    const res = await post(h, '/api/supplier-accounts/import-sessions', {
      upstreamId: tf.id,
      text: `tr_session=${PASTED}`,
    });
    expect(res.status).toBe(422);
    expect(res.body['code']).toBe('UNPROCESSABLE');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
    expect(h.upstream.calls).toHaveLength(0);
  });

  it('import-sessions：排除名单非空 → 入口 422（名单按真值匹配，掩码无法验证）', async () => {
    const h = await setup({ excluded: [TR_ID] });

    const res = await post(h, '/api/supplier-accounts/import-sessions', {
      upstreamId: h.upstreamId,
      text: `tr_session=${PASTED}`,
    });
    expect(res.status).toBe(422);
    expect(res.body['code']).toBe('UNPROCESSABLE');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
    expect(h.upstream.calls).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toContain(PASTED);
  });

  it('import-sessions：没有可导入行（只有表头）→ 400，不建任务', async () => {
    const h = await setup();
    const res = await post(h, '/api/supplier-accounts/import-sessions', {
      upstreamId: h.upstreamId,
      text: 'cookie\n# 注释',
    });
    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('INVALID_PARAM');
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
  });
});
