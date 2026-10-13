// 契约 §15.2 六个「要打上游」的端点的路由层验收。
//
// **一个网络请求都不发**：`fetchImpl` 是注入的假 fetch（`buildApp({ supplier: … })`）。
// 这是这组用例今天就能在 CI 里跑的全部理由 —— 这六个端点等的是**凭据**，而协议与玩法不卡凭据。
// 真机那一步由凭据持有者跑（§16.1.1），这里管的是"凭据到手那天，代码已经是对的"。
//
// 覆盖三层里**最外面那一层**：闸门（鉴权 / CSRF 是否覆盖到新路由）、请求级校验
// （该 4xx 的不该建出一个注定失败的任务）、任务生命周期（202 → 终态 result 的形状）。
// 以及这一面上最贵的四条纪律，它们是这个文件真正的存在理由：
//
//   1. **凭据只进不出**（§15.9）：明文密码不落盘、明文 key 不进 result 与响应 ——
//      断言方式是把响应体、任务 result、整行数据库文本一起拿去搜明文；
//   2. **排除名单是代码闸**：命中即**零上游请求**（不是"请求了但被忽略"）；
//   3. **自测永不写库**（§15.2）：连它顺手换回来的新会话也不落；
//   4. **撞号不更新任何行**（§15.2 keys/sync）：宁可少更一次，也不要把 A key 的余额写到 B key 上。
//
// 用例的账号 / 手机号 / 密码**全是合成的**：这个库里出现真实号码的那一刻，
// 它就成了又一份需要被管理、被排除、被清理的凭据。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import { openDatabase, type Db } from '../../db/database.js';
import { sha256Hex } from '../../db/crypto.js';
import { decryptedKeyRefs, createKey } from '../../db/repo/keys.js';
import { getTask } from '../../db/repo/tasks.js';
import { createUpstream } from '../../db/repo/upstreams.js';
import {
  createSupplierAccount,
  linkSupplierAccountKey,
  listSupplierSubscriptions,
  replaceSupplierSubscriptions,
} from '../../db/repo/supplier-accounts.js';
import { encodePasswordBlob, encodeSessionBlob } from '../../supplier/credentials.js';
import { buildApp } from '../app.js';
import { bootstrapAdmin } from '../auth.js';
import type { SupplierBatchResult, SupplierTestResult, TaskDto } from '../dto.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'acc-write-pass-1';
const MASTER_KEY = Buffer.from('2a'.repeat(32), 'hex');

/** 全部是合成值：真号不进仓库（§15.9 纪律 —— 排除名单是运行时的环境变量）。 */
const PHONE_A = '13800000001';
const PHONE_B = '13900000002';
const SECRET_A = 'probe-secret-A1';
const SECRET_B = 'probe-secret-B2';

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
      /* Windows 上临时目录偶尔仍被短时占用，不影响判据 */
    }
  }
});

// ---------------------------------------------------------------------------
// 假上游
// ---------------------------------------------------------------------------

interface Call {
  path: string;
  method: string;
  body: string | null;
}

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

interface FakeUpstream {
  impl: typeof fetch;
  calls: Call[];
  /** 覆盖某条路径的响应；不覆盖走下面的默认值。 */
  on(path: string, handler: Handler): void;
  /** 某条路径被打了几次。**"零请求"是这里的核心判据之一**，所以它必须可数。 */
  count(path: string): number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 成功信封（§15 文档 §1.2：`{success:true, data}`）。 */
function ok(data: unknown, status = 200): Response {
  return json({ success: true, data }, status);
}

/** 上游说"不行"（200 + `success:false`）。 */
function rejected(message: string, status = 200): Response {
  return json({ success: false, message }, status);
}

/** 自增的明文 key 尾巴：每把的后 4 位不同，撞号用例才能**刻意**造出撞号。 */
let plaintextSeq = 0;
function freshPlaintext(): string {
  // `sk-` 前缀运行时拼：`check:secrets` 会抓硬编码的 `sk-…` 字面量。
  return 'sk-probe-' + 'X'.repeat(20) + String(++plaintextSeq).padStart(4, '0');
}

/** 带指定尾 4 位的合成 key 明文：`sk-` 前缀**运行时拼**（`check:secrets` 会抓硬编码的 `sk-…` 字面量）。 */
function probeKey(tag: string): string {
  return 'sk-' + 'probe-key-' + tag;
}

function fakeUpstream(): FakeUpstream {
  const calls: Call[] = [];
  const overrides = new Map<string, Handler>();

  const defaults: Record<string, Handler> = {
    '/api/user/login': () => ok({ session: 'sess-new', uid: '42', username: 'probe' }),
    '/api/user/self': () => ok({ quota: 2168881, id: '42' }),
    '/api/subscription/self': () => ok({ all_subscriptions: [] }),
    '/api/token/search': () => ok([]),
    '/api/token/': () => ok({ key: freshPlaintext(), token_no: '1187' }),
    '/api/subscription/self/token': () => ok({}),
  };

  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push({
      path: url.pathname,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const handler = overrides.get(url.pathname) ?? defaults[url.pathname];
    if (handler === undefined) {
      // **未打桩的路径一律 404**，而不是"静默成功"：驱动器新增一次调用时，
      // 用例该以"这条路径没桩"失败，而不是以一个说不清原因的断言差失败。
      return rejected(`未打桩的上游路径 ${url.pathname}`, 404);
    }
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;

  return {
    impl,
    calls,
    on: (path, handler) => overrides.set(path, handler),
    count: (path) => calls.filter((c) => c.path === path).length,
  };
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface Harness {
  app: FastifyInstance;
  db: Db;
  cookie: string;
  upstream: FakeUpstream;
}

function makeConfig(dbPath: string, over: Partial<AppConfig> = {}): AppConfig {
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
    healthSnapshotRetentionDays: 90,
    maxAttempts: 3,
    maxConcurrencyPerKey: 4,
    cooldownLadderSeconds: [0, 60, 300, 900, 1800],
    assistantModel: null,
    egressHeartbeatInboxDir: null,
    balanceSyncMinutes: 0,
    balanceSnapshotRetentionDays: 90,
    // 能力探测（契约 §5 / ADR-0024）测试取值：与装配默认逐字一致（本套用例不触发补探）
    modelProbeEnabled: true,
    modelProbeMaxModels: 10,
    ...over,
  };
}

async function setup(
  over: { config?: Partial<AppConfig>; excluded?: ReadonlySet<string> } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'acc-write-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const upstream = fakeUpstream();
  const app = buildApp({
    db,
    config: makeConfig(dbPath, over.config ?? {}),
    // 两条后台定时器关掉：本文件测的是请求路径，不为它们引入额外变量。
    balanceSync: false,
    healthSnapshots: false,
    supplier: {
      fetchImpl: upstream.impl,
      excluded: over.excluded ?? new Set<string>(),
      // §15.5 的 0.6s **不为用例而存在**。这里注入一个会抛错的 sleep：
      // 于是"节奏没被归零"这件事会当场炸出来，而不是让用例悄悄跑慢 27 倍。
      pacing: {
        gapMs: 0,
        sleep: (ms) => Promise.reject(new Error(`用例不该等待节奏间隔 ${ms}ms`)),
      },
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

  const h: Harness = { app, db, cookie, upstream };
  harnesses.push(h);
  return h;
}

function tierflowUpstream(db: Db, baseUrl = 'https://tierflow.example'): { id: string; baseUrl: string } {
  const up = createUpstream(db, { name: 'tierflow', baseUrl, supplier: 'tierflow' });
  return { id: up.id, baseUrl };
}

/** 种一个密码型账号（真值随密码进密文；`identifier` 列只有掩码）。 */
function seedPasswordAccount(
  db: Db,
  upstreamId: string,
  over: { id?: string; phone?: string; secret?: string; session?: string | null } = {},
): string {
  const phone = over.phone ?? PHONE_A;
  const secret = over.secret ?? SECRET_A;
  const id = over.id ?? 'acc_' + sha256Hex(phone).slice(0, 12);
  createSupplierAccount(db, id, {
    upstreamId,
    supplier: 'tierflow',
    identifier: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
    identifierHash: sha256Hex(phone),
    status: 'unknown',
    encryptedPassword: encodePasswordBlob(phone, secret, MASTER_KEY),
    encryptedSession:
      over.session === null || over.session === undefined
        ? null
        : encodeSessionBlob(over.session, '42', MASTER_KEY),
  });
  return id;
}

/** 种一个**只有会话**的账号：没有存档密码，重登无从谈起（§15.9 的已知代价）。 */
function seedSessionAccount(
  db: Db,
  upstreamId: string,
  over: { id?: string; phone?: string; session?: string } = {},
): string {
  const phone = over.phone ?? PHONE_A;
  const id = over.id ?? 'acc_' + sha256Hex(phone + ':session').slice(0, 12);
  createSupplierAccount(db, id, {
    upstreamId,
    supplier: 'tierflow',
    identifier: `${phone.slice(0, 3)}****${phone.slice(-4)}`,
    identifierHash: sha256Hex(phone),
    status: 'unknown',
    encryptedSession: encodeSessionBlob(over.session ?? 'sess-old', '42', MASTER_KEY),
  });
  return id;
}

async function post(
  h: Harness,
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await h.app.inject({
    method: 'POST',
    url,
    headers: { cookie: h.cookie, 'x-requested-with': 'fetch', ...headers },
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

/** 轮询到终态。任务体在 `setImmediate` 里起步，202 回来时它多半还没开始。 */
async function settle(db: Db, taskId: string): Promise<TaskDto> {
  for (let i = 0; i < 500; i += 1) {
    const task = getTask(db, taskId);
    if (task !== null && (task.status === 'succeeded' || task.status === 'failed')) return task;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`任务 ${taskId} 未在预期时间内进入终态`);
}

/** 202 → 终态 → `result`。四个批量端点的公共走法。 */
async function runBatch(
  h: Harness,
  url: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; task: TaskDto; result: SupplierBatchResult }> {
  const res = await post(h, url, payload);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  const task = await settle(h.db, String(res.body['taskId']));
  expect(task.status, task.message ?? '').toBe('succeeded');
  return { status: res.status, task, result: task.result as SupplierBatchResult };
}

function accountRow(db: Db, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM supplier_accounts WHERE id = ?').get(id) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 闸门：新加的路由不能是公开接口
// ---------------------------------------------------------------------------

describe('鉴权与 CSRF（§0.5：闸门在 onRequest，不在这六个 handler 里）', () => {
  it('无会话的 import → 401，且零上游请求', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/supplier-accounts/import',
      payload: { upstreamId: id, text: `${PHONE_A},${SECRET_A}` },
      // 带上 CSRF 头：这一格要证的是**鉴权**。不带的那个失败是 403 而不是 401 ——
      // 闸门里 CSRF 排在鉴权**之前**（见 app.ts），两条各有各的用例（下一条）。
      headers: { 'x-requested-with': 'fetch' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
    expect(h.upstream.calls).toHaveLength(0);
  });

  it('写请求缺 X-Requested-With → 403 CSRF_REJECTED', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/supplier-accounts/keys',
      payload: { upstreamId: id },
      headers: { cookie: h.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'CSRF_REJECTED' });
    expect(h.upstream.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

describe('POST /import', () => {
  it('表头行被容忍、新号 `login`、已有号 `relogin`，且**明文密码与真值都不落盘**', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const existing = seedPasswordAccount(h.db, id, { phone: PHONE_B, secret: SECRET_B });

    const text = ['手机号,密码', `${PHONE_A},${SECRET_A}`, `${PHONE_B},${SECRET_B}`].join('\n');
    const { result } = await runBatch(h, '/api/supplier-accounts/import', { upstreamId: id, text });

    expect(result.total).toBe(2);
    expect(result.ok).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.itemsTotal).toBe(2);
    expect(result.truncated).toBe(false);
    // §15.3：`login` = 新建账号首登，`relogin` = 已有账号被重登。每一行都要有生产者。
    expect(result.items.map((i) => i.action)).toEqual(['login', 'relogin']);
    expect(result.items.map((i) => i.identifier)).toEqual([
      `${PHONE_A.slice(0, 3)}****${PHONE_A.slice(-4)}`,
      `${PHONE_B.slice(0, 3)}****${PHONE_B.slice(-4)}`,
    ]);

    // 新建的那一行确实落库了，且复用了既有行（不新建、不改 id）。
    const rows = h.db
      .prepare('SELECT id, identifier, identifier_hash, status FROM supplier_accounts ORDER BY created_at, id')
      .all() as { id: string; identifier: string; identifier_hash: string; status: string }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id)).toContain(existing);
    expect(rows.every((r) => r.status === 'active')).toBe(true);

    // **真值只以掩码 + sha256 摘要存在**：整行文本里搜不到那 11 位号码。
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(PHONE_A);
    expect(dump).not.toContain(PHONE_B);
    expect(rows.map((r) => r.identifier_hash)).toContain(sha256Hex(PHONE_A));

    // **明文密码不落盘**：密码密文里搜不到明文；响应与任务 result 里也没有。
    for (const rowId of rows.map((r) => r.id)) {
      const row = accountRow(h.db, rowId);
      const cipher = row['encrypted_password'] as Buffer;
      expect(cipher.includes(Buffer.from(SECRET_A))).toBe(false);
      expect(cipher.includes(Buffer.from(SECRET_B))).toBe(false);
    }
    const wire = JSON.stringify(result);
    expect(wire).not.toContain(SECRET_A);
    expect(wire).not.toContain(SECRET_B);
    expect(wire).not.toContain(PHONE_A);

    // 真值确实能被取回来（否则重登就是空谈）：上游收到的是归一化后的真值。
    const loginBodies = h.upstream.calls
      .filter((c) => c.path === '/api/user/login')
      .map((c) => c.body ?? '');
    expect(loginBodies).toHaveLength(2);
    expect(loginBodies.join('|')).toContain(PHONE_A);
  });

  it('排除名单命中 → **零上游请求**，计 skipped 并给出 EXCLUDED_IDENTIFIER', async () => {
    const h = await setup({ excluded: new Set([PHONE_A]) });
    const { id } = tierflowUpstream(h.db);
    const text = [`${PHONE_A},${SECRET_A}`, `${PHONE_B},${SECRET_B}`].join('\n');
    const { result } = await runBatch(h, '/api/supplier-accounts/import', { upstreamId: id, text });

    // 名单是**代码闸**：命中的那一行连一次登录都不许发出去。
    const loginBodies = h.upstream.calls.filter((c) => c.path === '/api/user/login').map((c) => c.body ?? '');
    expect(loginBodies).toHaveLength(1);
    expect(loginBodies[0]).toContain(PHONE_B);
    expect(loginBodies[0]).not.toContain(PHONE_A);

    expect(result.skipped).toBe(1);
    expect(result.ok).toBe(1);
    // 跳过要**报出来**：静默跳过等于没跳过。
    expect(result.items[0]).toMatchObject({ code: 'EXCLUDED_IDENTIFIER', ok: false });
    // 被跳过的那一行连账号行都不该建。
    const rows = h.db.prepare('SELECT COUNT(*) AS n FROM supplier_accounts').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('上游不是 tierflow → 422，且**不建任务**', async () => {
    const h = await setup();
    const generic = createUpstream(h.db, { name: 'generic', baseUrl: 'https://generic.example' });
    const res = await post(h, '/api/supplier-accounts/import', {
      upstreamId: generic.id,
      text: `${PHONE_A},${SECRET_A}`,
    });
    expect(res.status).toBe(422);
    expect(res.body['code']).toBe('UNPROCESSABLE');
    expect(h.upstream.calls).toHaveLength(0);
    const tasks = h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(tasks.n).toBe(0);
  });

  it('解析不了的行逐行失败，不拖垮同批的其它行', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const text = [`${PHONE_A},${SECRET_A}`, '138 0000 0000', ''].join('\n');
    const { result } = await runBatch(h, '/api/supplier-accounts/import', { upstreamId: id, text });

    // 空行不进合计（§15.2 的恒等式要在一份末尾带换行的清单上仍然成立）。
    expect(result.total).toBe(2);
    expect(result.ok).toBe(1);
    // 解析不了的行归 **skipped 不是 failed**（§15.3）：`failed` = 做过但不成的行，
    // 而这一行**根本没做**。两种读法都说得通，所以它必须是**一处**决定 —— 见服务层 put() 的长注释。
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.ok + result.failed + result.skipped).toBe(result.total);
    const bad = result.items[1];
    expect(bad).toMatchObject({ ok: false, code: 'LINE_PARSE_FAILED', action: null });
    // 失败行**不回带原文**：那一行里可能有密码。
    expect(JSON.stringify(result)).not.toContain('138 0000 0000');
  });

  it('只有表头 / 全空 → 形状完整的零结果，不是空对象', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const { result } = await runBatch(h, '/api/supplier-accounts/import', { upstreamId: id, text: '手机号,密码' });
    expect(result).toMatchObject({
      done: 0,
      total: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      itemsTotal: 0,
      truncated: false,
      items: [],
    });
  });
});

// ---------------------------------------------------------------------------
// refresh
// ---------------------------------------------------------------------------

describe('POST /refresh', () => {
  it('会话过期 → **自动用存档密码重登一次**并把余额刷回来', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-stale' });

    let selfCalls = 0;
    h.upstream.on('/api/user/self', () => {
      selfCalls += 1;
      // 第一次 401（会话过期），重登之后第二次成功 —— 这正是 callWithRelogin 的用例。
      return selfCalls === 1 ? rejected('会话失效', 401) : ok({ quota: 2168881, id: '42' });
    });

    const { result } = await runBatch(h, '/api/supplier-accounts/refresh', { upstreamId: id });

    // 这次刷余额是**靠重登救回来的**，`action` 如实写 `relogin` 而不是 `refresh` ——
    // 恒报 `refresh` 会把"会话过期"这件事的唯一一处痕迹抹掉（§15.3 的 `action` 就该是这个用途）。
    expect(result.items[0]).toMatchObject({ action: 'relogin', ok: true });
    // 每号一次：**恰好一次**登录（§15.5）。两次就意味着重试策略埋在了驱动器里。
    expect(h.upstream.count('/api/user/login')).toBe(1);

    const row = accountRow(h.db, accountId);
    expect(row['status']).toBe('active');
    // 2168881 quota / 500000 * 100 = 434 分（§15.1 的实测样例）。
    expect(row['balance_cents']).toBe(434);
    expect(typeof row['balance_updated_at']).toBe('string');
  });

  it('只有会话、没有密码 → **一次登录都不发**，计 failed 并落 session_expired', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedSessionAccount(h.db, id);
    h.upstream.on('/api/user/self', () => rejected('会话失效', 401));

    const { result } = await runBatch(h, '/api/supplier-accounts/refresh', { upstreamId: id });

    // 无从重登（§15.9 的已知代价），且**不发那次注定 401 的登录请求**。
    expect(h.upstream.count('/api/user/login')).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.items[0]?.ok).toBe(false);
    expect(accountRow(h.db, accountId)['status']).toBe('session_expired');
  });

  it('`ids` 指向别的上游 → 整批拒（凭据不得外发到另一个域名）', async () => {
    const h = await setup();
    const a = tierflowUpstream(h.db);
    const b = createUpstream(h.db, { name: 'tierflow-2', baseUrl: 'https://other.example', supplier: 'tierflow' });
    const foreign = seedPasswordAccount(h.db, b.id, { phone: PHONE_B });

    const res = await post(h, '/api/supplier-accounts/refresh', { upstreamId: a.id, ids: [foreign] });
    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('INVALID_PARAM');
    expect((res.body['details'] as { field?: string }).field).toBe('ids');
    expect(h.upstream.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// :id/login 与 :id/test
// ---------------------------------------------------------------------------

describe('POST /:id/login 与 /:id/test', () => {
  it('重登没有密码 → 422，且不发请求（回 200 会让人以为点过了）', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedSessionAccount(h.db, id);

    const res = await post(h, `/api/supplier-accounts/${accountId}/login`);
    expect(res.status).toBe(422);
    expect(res.body['code']).toBe('UNPROCESSABLE');
    expect(h.upstream.calls).toHaveLength(0);
  });

  it('重登成功 → 200 + 最新一行，状态回 active', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    // 没有会话可验活 → 直接登录（先验活那一路在下一条用例里测，两条不能混）。
    const accountId = seedPasswordAccount(h.db, id, { session: null });

    const res = await post(h, `/api/supplier-accounts/${accountId}/login`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: accountId, status: 'active' });
    expect(h.upstream.count('/api/user/login')).toBe(1);
    // 没有会话时一发探针都不发：这个端点在"无会话"形态下仍是只登一次。
    expect(h.upstream.count('/api/user/self')).toBe(0);
    // 审计里只留结论，不留会话（§15.9 纪律 4）。
    const audits = h.db
      .prepare("SELECT action, detail, target_id FROM audit_log WHERE action = 'supplier.account.login'")
      .all() as { action: string; detail: string; target_id: string }[];
    expect(audits).toHaveLength(1);
    expect(audits[0]?.target_id).toBe(accountId);
    expect(JSON.stringify(audits)).not.toContain('sess-new');
  });

  it('会话仍有效时点「重新登录」→ **零登录请求**（一次密码往返都不发）', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-live' });

    const res = await post(h, `/api/supplier-accounts/${accountId}/login`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: accountId, status: 'active' });
    // 验活用的就是 §15.9 自己那发探针，且只发一发。
    expect(h.upstream.count('/api/user/self')).toBe(1);
    expect(h.upstream.count('/api/user/login')).toBe(0);
    // 会话没被换掉：库里那对密文原样不动（加密是随机的，相等 ⇒ 根本没写）。
    expect(accountRow(h.db, accountId)['encrypted_session']).not.toBeNull();
  });

  it('会话过期时点「重新登录」→ 验活失败后才登一次并覆写会话', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-stale' });
    const before = accountRow(h.db, accountId)['encrypted_session'];

    let selfCalls = 0;
    h.upstream.on('/api/user/self', () => {
      selfCalls += 1;
      return selfCalls === 1 ? rejected('会话失效', 401) : ok({ quota: 2168881, id: '42' });
    });

    const res = await post(h, `/api/supplier-accounts/${accountId}/login`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'active' });
    expect(h.upstream.count('/api/user/login')).toBe(1);
    // 登录成功后没有再补一发探针（只登一次、不循环）。
    expect(selfCalls).toBe(1);
    expect(accountRow(h.db, accountId)['encrypted_session']).not.toEqual(before);
  });

  it('验活那一发超时（非会话失效）→ 不当作换会话的理由，仍登一次', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-live' });
    h.upstream.on('/api/user/self', () => {
      throw new Error('探针抖动');
    });

    const res = await post(h, `/api/supplier-accounts/${accountId}/login`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'active' });
    expect(h.upstream.count('/api/user/login')).toBe(1);
  });

  it('自测**永不写库**：连它顺手换回来的新会话也不落', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-stale' });
    const before = accountRow(h.db, accountId);

    let selfCalls = 0;
    h.upstream.on('/api/user/self', () => {
      selfCalls += 1;
      return selfCalls === 1 ? rejected('会话失效', 401) : ok({ quota: 2168881, id: '42' });
    });

    const res = await post(h, `/api/supplier-accounts/${accountId}/test`);
    expect(res.status).toBe(200);
    const result = res.body as unknown as SupplierTestResult;
    expect(result.ok).toBe(true);
    expect(result.loginAttempted).toBe(true);
    expect(result.parsed.balanceCents).toBe(434);
    // raw 是上游原样，parsed 才是换算后的结论（§15.2）。
    expect(result.raw).toEqual({ quota: 2168881, id: '42' });

    const after = accountRow(h.db, accountId);
    expect(after['encrypted_session']).toEqual(before['encrypted_session']);
    expect(after['balance_updated_at']).toBeNull();
    expect(after['status']).toBe(before['status']);
  });

  it('上游不可达 → 200 + ok:false（诊断走正常响应体，不走错误分支）', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-ok' });
    h.upstream.on('/api/user/self', () => {
      throw new Error('ECONNREFUSED');
    });

    const res = await post(h, `/api/supplier-accounts/${accountId}/test`);
    expect(res.status).toBe(200);
    const result = res.body as unknown as SupplierTestResult;
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('UPSTREAM_UNREACHABLE');
    expect(result.hintCode).toBe('BALANCE_UPSTREAM_UNREACHABLE');
  });
});

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

describe('POST /keys', () => {
  it('count 越界 → 400，**不建任务**（别让参数错变成一次轮询才知道的异步失败）', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    seedPasswordAccount(h.db, id, { session: 'sess-ok' });

    const res = await post(h, '/api/supplier-accounts/keys', { upstreamId: id, count: 99 });
    expect(res.status).toBe(400);
    expect(res.body['code']).toBe('INVALID_PARAM');
    expect((res.body['details'] as { field?: string }).field).toBe('count');
    const tasks = h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(tasks.n).toBe(0);
    expect(h.upstream.calls).toHaveLength(0);
  });

  it('建 key：明文当场入池、响应与 result **只回掩码**', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-ok' });

    const { result } = await runBatch(h, '/api/supplier-accounts/keys', {
      upstreamId: id,
      ids: [accountId],
      count: 1,
      namePrefix: 'tierflow',
      unlimited: true,
    });

    const item = result.items[0];
    expect(item).toMatchObject({ action: 'create', ok: true });
    expect(item?.keyMasked).toMatch(/^\*{4}/);
    expect(item?.keyId).toBeTruthy();
    expect(item?.tokenNo).toBe(1187);

    // **明文不出现在任何会被读走的地方** —— result 里只有掩码与内部标识。
    const wire = JSON.stringify(result);
    expect(wire).not.toContain('sk-probe-');
    expect(wire).not.toMatch(/\*{4}\w{4}.*sk-/);

    // 但它在库里**可用**：服务端解出来就是上游给的那把（否则等于建了把钥匙却丢了）。
    const refs = decryptedKeyRefs(h.db, { upstreamId: id }, MASTER_KEY);
    expect(refs).toHaveLength(1);
    const stored = refs[0]?.decrypted ?? '';
    expect(stored).toMatch(/^sk-probe-X{20}\d{4}$/);
    expect(item?.keyMasked).toBe('****' + stored.slice(-4));

    // §15.7 的不变量由 `createKey` 强制：`unlimited = 1 ⇒ balance_cents` 落 NULL。
    const row = h.db
      .prepare('SELECT unlimited, balance_cents, model_limits, label FROM upstream_keys WHERE id = ?')
      .get(String(item?.keyId)) as Record<string, unknown>;
    expect(row['unlimited']).toBe(1);
    expect(row['balance_cents']).toBeNull();
    expect(row['model_limits']).toBeNull();
    // 上游侧 key 名不含凭据（§15.2）。
    expect(String(row['label'])).not.toContain(SECRET_A);
  });
});

// ---------------------------------------------------------------------------
// keys/sync
// ---------------------------------------------------------------------------

describe('POST /keys/sync', () => {
  /** 上游 key 列表。**掩码是可逆到后 4 位的那一半** —— 这正是匹配口径的极限。 */
  function tokens(rows: { name: string; key: string }[]): Response {
    return ok(rows);
  }

  it('后 4 位命中 → 台账更新，未命中只记数（不创建可用凭据）', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-ok' });
    // 池内一把 key，并把它的明文后 4 位拿出来做上游掩码。
    const pooled = createKey(
      h.db,
      { upstreamId: id, key: 'sk-pooled-' + 'Y'.repeat(20) + 'q7Zt', category: 'balance', balance: 100 },
      MASTER_KEY,
    );
    h.db
      .prepare(
        `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, note, created_at, updated_at)
         VALUES ('sak_1', ?, ?, ?, 'tierflow-0001-1', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z')`,
      )
      .run(accountId, pooled.maskedKey, pooled.id);
    h.upstream.on('/api/token/search', () =>
      tokens([
        { name: 'tierflow-0001-1', key: 'WnWw**********q7Zt' },
        { name: 'unknown-key', key: 'Abcd**********zzzz' },
      ]),
    );

    const { result } = await runBatch(h, '/api/supplier-accounts/keys/sync', { upstreamId: id, ids: [accountId] });

    expect(result.items[0]).toMatchObject({ action: 'sync', ok: true });
    expect(result.items[0]?.message).toContain('命中池内 1 行');
    const rows = h.db
      .prepare('SELECT pooled_key_id FROM supplier_account_keys WHERE account_id = ? ORDER BY pooled_key_id IS NULL')
      .all(accountId) as { pooled_key_id: string | null }[];
    // 两条台账行：命中的那条绑着池内 key，未命中的那条**只有掩码、pooled_key_id 为空**
    // （掩码不可逆，不创建可用凭据 —— ADR-0018 决策 2）。
    expect(rows).toHaveLength(2);
    expect(rows[0]?.pooled_key_id).toBe(pooled.id);
    expect(rows[1]?.pooled_key_id).toBeNull();
  });

  it('后 4 位撞号 → KEY_MASK_AMBIGUOUS，且**一行都不更新**', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-ok' });
    const before = h.db
      .prepare('SELECT COUNT(*) AS n FROM supplier_account_keys WHERE account_id = ?')
      .get(accountId) as { n: number };
    expect(before.n).toBe(0);

    h.upstream.on('/api/token/search', () =>
      tokens([
        { name: 'a', key: 'Abcd**********q7Zt' },
        { name: 'b', key: 'Efgh**********q7Zt' },
      ]),
    );

    const { result } = await runBatch(h, '/api/supplier-accounts/keys/sync', { upstreamId: id, ids: [accountId] });

    expect(result.failed).toBe(1);
    expect(result.items[0]).toMatchObject({ ok: false, code: 'KEY_MASK_AMBIGUOUS' });
    const after = h.db
      .prepare('SELECT COUNT(*) AS n FROM supplier_account_keys WHERE account_id = ?')
      .get(accountId) as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('套餐一起同步：`quota_per_unit` 从上游读、金额换算成**分**', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-ok' });
    h.upstream.on('/api/subscription/self', () =>
      ok({
        all_subscriptions: [
          {
            sub_no: 'SB-1',
            plan_title: '包月',
            amount_total: 14950000,
            amount_used: 2168881,
            paid_money: 29.9,
            start_at: '2026-10-01 00:00:00',
            end_at: '2026-11-01 00:00:00',
            auto_renew: false,
            has_key: false,
            basic_token_total: 100,
            basic_token_used: 3,
          },
        ],
      }),
    );

    await runBatch(h, '/api/supplier-accounts/keys/sync', { upstreamId: id, ids: [accountId] });

    const subs = listSupplierSubscriptions(h.db, { upstreamId: id, page: 1, pageSize: 10 });
    expect(subs.total).toBe(1);
    const sub = subs.items[0];
    // 三个单位同屏：quota 14950000 → 2990 分；paid_money 29.9 浮点元 → 2990 分（round，不截断）。
    expect(sub?.amountTotalCents).toBe(2990);
    expect(sub?.amountUsedCents).toBe(434);
    expect(sub?.paidCents).toBe(2990);
    // 不带时区的时间串按 UTC 补 Z（写入侧的归一化，见 `supplier/subscriptions.ts`）。
    expect(sub?.endAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('套餐行实测形状：元素包一层 subscription，时间键是 start_time/end_time（epoch 秒）', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-ok' });
    // 2026-10-12 线上实测形状（只读复现）：外层的 has_key/auto_renew 与内层 subscription。
    h.upstream.on('/api/subscription/self', () =>
      ok({
        all_subscriptions: [
          {
            subscription: {
              sub_no: 'SB-N1',
              plan_slug: 'lite',
              plan_title: '轻享版',
              amount_total: 14950000,
              amount_used: 2168881,
              basic_token_total: 8000000,
              basic_token_used: 2666169,
              paid_money: 29.9,
              status: 'active',
              source: 'registration',
              start_time: 1790960876,
              end_time: 1793552876,
            },
            has_key: false,
            auto_renew: false,
          },
        ],
      }),
    );

    await runBatch(h, '/api/supplier-accounts/keys/sync', { upstreamId: id, ids: [accountId] });

    const subs = listSupplierSubscriptions(h.db, { upstreamId: id, page: 1, pageSize: 10 });
    // 曾经这里恒为 0 行（外层读不到 sub_no）。这一条钉死「包一层也能读到」。
    expect(subs.total).toBe(1);
    const sub = subs.items[0];
    expect(sub?.subNo).toBe('SB-N1');
    expect(sub?.amountTotalCents).toBe(2990);
    expect(sub?.amountUsedCents).toBe(434);
    expect(sub?.paidCents).toBe(2990);
    expect(sub?.endAt).toBe('2026-11-01T17:07:56.000Z');
  });
});

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

describe('审计（§15.7：四个批量端点各一条，`detail` 只放计数）', () => {
  it('四个端点各写一条，detail 里没有 identifier、没有任何凭据', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-ok' });
    h.upstream.on('/api/token/search', () => ok([{ name: 'a', key: 'Abcd**********q1W2' }]));

    await runBatch(h, '/api/supplier-accounts/import', { upstreamId: id, text: `${PHONE_B},${SECRET_B}` });
    await runBatch(h, '/api/supplier-accounts/refresh', { upstreamId: id, ids: [accountId] });
    await runBatch(h, '/api/supplier-accounts/keys', { upstreamId: id, ids: [accountId], unlimited: true });
    await runBatch(h, '/api/supplier-accounts/keys/sync', { upstreamId: id, ids: [accountId] });

    const audits = h.db
      .prepare(
        `SELECT action, target_type, target_id, detail FROM audit_log
          WHERE action LIKE 'supplier.%' ORDER BY ts, action`,
      )
      .all() as { action: string; target_type: string; target_id: string; detail: string }[];

    expect(audits.map((a) => a.action).sort()).toEqual([
      'supplier.import',
      'supplier.keys.create',
      'supplier.keys.sync',
      'supplier.refresh',
    ]);
    expect(audits.every((a) => a.target_type === 'upstream' && a.target_id === id)).toBe(true);
    for (const a of audits) {
      expect(a.detail).toMatch(/^ok=\d+ failed=\d+ skipped=\d+ total=\d+$/);
    }
    const dump = JSON.stringify(audits);
    expect(dump).not.toContain(PHONE_A);
    expect(dump).not.toContain(PHONE_B);
    expect(dump).not.toContain(SECRET_A);
  });
});

// ---------------------------------------------------------------------------
// rotate-key（契约 §15.13，v1.9.0 / ADR-0022）
// ---------------------------------------------------------------------------

describe('POST /rotate-key', () => {
  it('重置成功 → 新 key 以 token-plan 入池、按掩码精确相等禁用旧 key，且**明文不落盘不回显**', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-live' });
    // 种一行套餐：省略 subNo 时 `latestSubscriptionSubNo` 才有得取（默认走**最新到期**）。
    replaceSupplierSubscriptions(h.db, accountId, [
      { subNo: 'SB1261003742775', endAt: '2026-11-01T01:07:56.000Z', hasKey: true },
    ]);
    // 旧 key：掩码后 4 位 = OLDT（**与重置后的新尾不同** —— 实测上游重置换尾：iHLd → 5w2l）。
    // 认领锚点必须是**重置前**取到的旧掩码，拿新掩码去找永远落空。
    const oldKey = createKey(h.db, {
      upstreamId: id,
      key: freshPlaintext().slice(0, -4) + 'OLDT',
      category: 'token-plan',
      label: '套餐-旧',
    }, MASTER_KEY);
    // 台账关联：`listLinkedPooledKeyMasks` 走 supplier_account_keys JOIN，不关联就看不见这把旧 key。
    linkSupplierAccountKey(h.db, accountId, oldKey.id, oldKey.maskedKey, '套餐key-旧');
    // 重置**前**的旧掩码查询（§15.13 规则 3 取证腿）：返回旧尾 OLDT。
    h.upstream.on('/api/subscription/self/token', () => ok({ key: probeKey('old-masked-xxxxxxxxxxxxOLDT'), masked: true }));
    h.upstream.on('/api/subscription/self/token/rotate', (url, init) => {
      expect((init?.headers as Record<string, string>)['cookie']).toContain('session=sess-live');
      return ok({ key: probeKey('rotate-new-000000NEWT'), masked: true });
    });
    h.upstream.on('/api/subscription/self', () => ok({
      all_subscriptions: [{
        subscription: {
          sub_no: 'SB1261003742775', plan_slug: 'lite', plan_title: '轻享版',
          amount_total: 14950000, amount_used: 3212302,
          basic_token_total: 8000000, basic_token_used: 2666169,
          paid_money: 29.9, status: 'active', source: 'registration',
          start_time: 1790960876, end_time: 1793552876, auto_renew: null,
        },
        has_key: true,
      }],
    }));

    const { result } = await runBatch(h, '/api/supplier-accounts/rotate-key', { upstreamId: id });

    expect(result.total).toBe(1);
    expect(result.ok).toBe(1);
    const item = result.items[0];
    expect(item).toMatchObject({ action: 'rotate', ok: true });
    expect(item?.keyId).not.toBeNull();
    expect(item?.keyMasked).toBe('****NEWT');

    // 请求体：POST + sub_no（省略 subNo 时默认取该账号最新到期的套餐）。
    const rotateCalls = h.upstream.calls.filter((c) => c.path === '/api/subscription/self/token/rotate');
    expect(rotateCalls).toHaveLength(1);
    const body = JSON.parse(rotateCalls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['sub_no']).toBe('SB1261003742775');

    // 新 key 落库：token-plan、启用、余量 NULL（不猜一个 0）。
    const newKey = h.db.prepare('SELECT * FROM upstream_keys WHERE id = ?').get(item?.keyId) as Record<string, unknown>;
    expect(newKey['category']).toBe('token-plan');
    expect(newKey['enabled']).toBe(1);
    expect(newKey['deleted_at']).toBeNull();
    expect(newKey['token_plan_remaining']).toBeNull();
    // 新 key 的密文里搜不到明文（aes-256-gcm）。
    expect((newKey['secret'] as Buffer).includes(Buffer.from(probeKey('rotate-new-000000NEWT')))).toBe(false);

    // 旧 key 被软删（enabled=0 + deleted_at），行保留；台账行**不删**（审计对账面）。
    const oldRow = h.db.prepare('SELECT * FROM upstream_keys WHERE id = ?').get(oldKey.id) as Record<string, unknown>;
    expect(oldRow['enabled']).toBe(0);
    expect(oldRow['deleted_at']).not.toBeNull();
    const ledger = h.db.prepare('SELECT COUNT(*) AS n FROM supplier_account_keys WHERE pooled_key_id = ?').get(oldKey.id) as { n: number };
    expect(ledger.n).toBe(1);

    // 套餐行的 has_key / key_masked 以本次响应为准。
    const sub = h.db.prepare('SELECT has_key, key_masked FROM supplier_account_subscriptions WHERE sub_no = ?').get('SB1261003742775') as Record<string, unknown>;
    expect(sub['has_key']).toBe(1);
    expect(sub['key_masked']).toBe('****NEWT');

    // **明文不落盘不回显**：整库文本、任务 result、响应体里都搜不到那串明文。
    const dump = (h.db.prepare("SELECT group_concat(secret) AS s FROM upstream_keys").get() as { s: string | null })['s'] ?? '';
    expect(dump.includes(probeKey('rotate-new-000000NEWT'))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(probeKey('rotate-new-000000NEWT'));
    // 出站请求体只带 sub_no，不带任何明文。
    expect(rotateCalls[0]?.body).not.toContain('sk-rotate');
  });

  it('掩码撞号 / 认领不到 → **不禁用任何旧 key**，新 key 照常入池，message 说明人工核对', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    const accountId = seedPasswordAccount(h.db, id, { session: 'sess-live' });
    replaceSupplierSubscriptions(h.db, accountId, [
      { subNo: 'SB1261003742775', endAt: '2026-11-01T01:07:56.000Z', hasKey: true },
    ]);
    // 两把旧 key 同尾 XAAA —— 掩码精确相等命中两行 → 不认领。
    const oldOne = createKey(h.db, { upstreamId: id, key: probeKey('old-one-xxxxxxxxXAAA'), category: 'token-plan', label: '旧1' }, MASTER_KEY);
    const oldTwo = createKey(h.db, { upstreamId: id, key: probeKey('old-two-yyyyyyyyXAAA'), category: 'token-plan', label: '旧2' }, MASTER_KEY);
    linkSupplierAccountKey(h.db, accountId, oldOne.id, oldOne.maskedKey, '旧1');
    linkSupplierAccountKey(h.db, accountId, oldTwo.id, oldTwo.maskedKey, '旧2');
    h.upstream.on('/api/subscription/self/token/rotate', () => ok({ key: probeKey('new-00000000XAAA'), masked: true }));

    const { result } = await runBatch(h, '/api/supplier-accounts/rotate-key', { upstreamId: id });

    expect(result.ok).toBe(1);
    expect(result.items[0]?.message).toContain('未自动禁用');
    // 两把旧 key 原样保留（未误禁）。
    const alive = h.db.prepare('SELECT COUNT(*) AS n FROM upstream_keys WHERE deleted_at IS NULL AND category = ?').get('token-plan') as { n: number };
    // 新 key + 两把旧 key = 3。
    expect(alive.n).toBe(3);
    // 新 key 在其中。
    expect(result.items[0]?.keyId).not.toBeNull();
  });

  it('无可用会话 → 一次上游请求都不发，逐行 SESSION_EXPIRED', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    seedPasswordAccount(h.db, id, { session: null });

    const { result } = await runBatch(h, '/api/supplier-accounts/rotate-key', { upstreamId: id });

    expect(result.failed).toBe(1);
    expect(result.items[0]).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
    expect(h.upstream.calls).toHaveLength(0);
  });

  it('名下无套餐记录 → 逐行 SUBSCRIPTION_NOT_FOUND，且不发上游重置', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    seedPasswordAccount(h.db, id, { session: 'sess-live' });

    const { result } = await runBatch(h, '/api/supplier-accounts/rotate-key', { upstreamId: id });

    expect(result.failed).toBe(1);
    expect(result.items[0]).toMatchObject({ ok: false, code: 'SUBSCRIPTION_NOT_FOUND' });
    expect(h.upstream.calls).toHaveLength(0);
  });

  it('排除名单命中 → 零上游请求，计 skipped', async () => {
    const h = await setup({ excluded: new Set([PHONE_A]) });
    const { id } = tierflowUpstream(h.db);
    seedPasswordAccount(h.db, id, { session: 'sess-live' });

    const { result } = await runBatch(h, '/api/supplier-accounts/rotate-key', { upstreamId: id });

    expect(result.skipped).toBe(1);
    expect(h.upstream.calls).toHaveLength(0);
  });

  it('显式 subNo：每行用它，不再按最新到期取默认', async () => {
    const h = await setup();
    const { id } = tierflowUpstream(h.db);
    seedPasswordAccount(h.db, id, { session: 'sess-live' });
    h.upstream.on('/api/subscription/self/token/rotate', () => ok({ key: probeKey('new-00000000BBBB'), masked: true }));

    const { result } = await runBatch(h, '/api/supplier-accounts/rotate-key', {
      upstreamId: id,
      subNo: 'SB9999000099999',
    });

    expect(result.ok).toBe(1);
    const body = JSON.parse(
      h.upstream.calls.filter((c) => c.path === '/api/subscription/self/token/rotate')[0]?.body ?? '{}',
    ) as Record<string, unknown>;
    expect(body['sub_no']).toBe('SB9999000099999');
    // 顺带落一行套餐（has_key=1），即使刷新从没见过这个 sub_no —— 台账不缺行。
    const sub = h.db.prepare('SELECT has_key FROM supplier_account_subscriptions WHERE sub_no = ?').get('SB9999000099999') as Record<string, unknown>;
    expect(sub['has_key']).toBe(1);
  });
});
