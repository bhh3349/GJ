// M5 验收证据探针 —— 第 4 条「`/v1/models` 与模型档案 enabled=true 逐项 0 差异」。
//
// 这条判据的正主在 `src/db/repo/models.ts:4` 的注释里：两侧读的是同一份可用性事实，
// 一旦各自算一份就必然漂移，档案卡开始骗人。所以探针**两边都走真实路径**取数：
//   上游（本地假上游，非 mock 桩）→ `POST /api/models/sync` → DB 档案 → 网关 `GET /v1/models`
// 然后比 id 集合的对称差。
//
// 负向对照是这条探针的重点：只做"同步完两边相等"是不够的 —— 两边都返回空集也相等。
// 所以第二阶段把一把模型 `enabled=false`，要求它**同时**从两侧消失且对称差仍为空。
//
// 不改仓库任何行为：不新增脚本名、不碰四闸、不写 src/。
// 用法：pnpm exec tsx scripts/m5/v1-models-parity.ts
import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/api/app.js';
import { bootstrapAdmin } from '../../src/api/auth.js';
import { openDatabase } from '../../src/db/database.js';
import { createGroup } from '../../src/db/repo/groups.js';
import { createKey } from '../../src/db/repo/keys.js';
import { createUpstream } from '../../src/db/repo/upstreams.js';
import { createGatewayRuntime, mountGatewayRoutes } from '../../src/wiring/runtime.js';
import type { AppConfig } from '../../src/config.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'm5-parity-pass-1';
/** 上游宣布的模型（含一个带 "/" 的名字，专门用来逼出 URL/编码类差异）。 */
const UPSTREAM_MODELS = ['gpt-4o-mini', 'gpt-4o', 'claude-3-5-sonnet', 'vendor/model-a', 'text-embedding-3-small', 'o1-mini', 'grok-2'];

/**
 * 证据出处：报告里的 `base` 必须是**本次运行**的代码基线。
 * 原先是钉死的 `main@4516b24` —— 换个检出重跑，就会把「在哪份代码上量的」写错，
 * 而这是证据报告里最不能错的一栏。
 */
function baseLabel(): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    const sha = execSync('git rev-parse --short HEAD').toString().trim();
    return `${branch}@${sha}`;
  } catch {
    return 'unknown';
  }
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
    allowedOrigins: [],
    adminToken: null,
    readonlyToken: null,
    logRetentionDays: 30,
    healthSnapshotRetentionDays: 90,
    // 0 = 关闭余额自动同步：探针运行期间不许后台任务发网络请求，否则量到的是它的抖动
    balanceSyncMinutes: 0,
    balanceSnapshotRetentionDays: 90,
    maxAttempts: 3,
    maxConcurrencyPerKey: 4,
    cooldownLadderSeconds: [0, 60, 300, 900, 1800],
    // 助手未接线：本探针不碰 /api/assistant/*
    assistantModel: null,
    egressHeartbeatInboxDir: null,
  };
}

/** 假上游：只实现 `/v1/models`，并记录收到的 Authorization，证明同步真的带凭证出了网。 */
function startFakeUpstream(): Promise<{ server: Server; baseUrl: string; seenAuth: string[] }> {
  const seenAuth: string[] = [];
  const server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? '<none>');
    if (req.method === 'GET' && req.url === '/v1/models') {
      const body = JSON.stringify({
        object: 'list',
        data: UPSTREAM_MODELS.map((id, i) => ({ id, object: 'model', created: 1_700_000_000 + i, owned_by: 'probe' })),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}/v1`, seenAuth });
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), 'm5-models-parity-'));
const dbPath = join(dir, 'gateway.db');
const config = makeConfig(dbPath);
const db = openDatabase({ path: dbPath });
const api = buildApp({ db, config: makeConfig(dbPath) });
bootstrapAdmin(db, { ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS });

const upstream = await startFakeUpstream();
const upstreamRow = createUpstream(db, { name: 'probe-upstream', baseUrl: upstream.baseUrl });
createKey(db, { upstreamId: upstreamRow.id, key: 'probe-plaintext-key-1', category: 'balance' }, config.masterKey);

const login = await api.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { username: ADMIN_USER, password: ADMIN_PASS },
  headers: { 'x-requested-with': 'fetch' },
});
if (login.statusCode !== 200) throw new Error(`登录失败 ${login.statusCode}: ${login.body}`);
const rawCookie = login.headers['set-cookie'];
const cookie = String(Array.isArray(rawCookie) ? rawCookie[0] : rawCookie).split(';')[0] ?? '';
const rest = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: Record<string, unknown>): Promise<{ statusCode: number; body: string }> =>
  api.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers: { cookie, 'x-requested-with': 'fetch' } });

// --- 阶段 1：真实同步 -----------------------------------------------------
const syncRes = await rest('POST', '/api/models/sync', { upstreamId: upstreamRow.id });
if (syncRes.statusCode !== 202) throw new Error(`同步任务未受理 ${syncRes.statusCode}: ${syncRes.body}`);
const taskId = (JSON.parse(syncRes.body) as { taskId: string }).taskId;

let task: { status: string; result: unknown; message: string | null };
for (;;) {
  const poll = await rest('GET', `/api/tasks/${taskId}`);
  task = JSON.parse(poll.body) as typeof task;
  if (task.status === 'succeeded' || task.status === 'failed') break;
  await new Promise((r) => setTimeout(r, 25));
}
if (task.status !== 'succeeded') throw new Error(`同步任务失败: ${JSON.stringify(task.result)} ${task.message ?? ''}`);

// --- 阶段 2：网关侧取数（真实 gateway key 鉴权 + 真实路由）------------------
const { gatewayKey } = createGroup(db, { name: 'probe-group' });
const runtime = createGatewayRuntime({ db, config: makeConfig(dbPath) });
await mountGatewayRoutes(runtime);
// 关键一步：网关服务的是**快照**，不是 DB 直读。同步刚落库、快照还是旧的，
// 不 refreshNow 就取数，量到的是"配置刷新延迟"而不是"0 差异"。
runtime.refreshNow();

async function gatewayModels(): Promise<string[]> {
  const res = await runtime.app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: { authorization: `Bearer ${gatewayKey.gatewayKey}` },
  });
  if (res.statusCode !== 200) throw new Error(`/v1/models 返回 ${res.statusCode}: ${res.body}`);
  const body = JSON.parse(res.body) as { data: { id: string }[] };
  return body.data.map((m) => m.id);
}

function archiveEnabledNames(): string[] {
  const rows = db
    .prepare('SELECT name FROM models WHERE upstream_id = ? AND enabled = 1 ORDER BY name')
    .all(upstreamRow.id) as { name: string }[];
  return rows.map((r) => r.name);
}

const symmetricDiff = (a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } => {
  const sa = new Set(a);
  const sb = new Set(b);
  return { onlyA: [...sa].filter((x) => !sb.has(x)).sort(), onlyB: [...sb].filter((x) => !sa.has(x)).sort() };
};

const gwAfterSync = await gatewayModels();
const dbAfterSync = archiveEnabledNames();
const diffAfterSync = symmetricDiff(gwAfterSync, dbAfterSync);

// --- 阶段 3：负向对照 —— 停用一把，要求两侧同时消失且仍 0 差异 ---------------
const modelsRes = await rest('GET', `/api/models?upstreamId=${upstreamRow.id}&page=1&pageSize=100`);
const page = JSON.parse(modelsRes.body) as { items: { id: string; name: string; revision: number }[] };
const victim = page.items.find((m) => m.name === 'gpt-4o');
if (victim === undefined) throw new Error('找不到用于停用的模型 gpt-4o');
const patchRes = await rest('PATCH', `/api/models/${victim.id}`, { enabled: false, revision: victim.revision });
if (patchRes.statusCode !== 200) throw new Error(`停用失败 ${patchRes.statusCode}: ${patchRes.body}`);
runtime.refreshNow();

const gwAfterDisable = await gatewayModels();
const dbAfterDisable = archiveEnabledNames();
const diffAfterDisable = symmetricDiff(gwAfterDisable, dbAfterDisable);

const report = {
  probe: 'v1-models-parity',
  base: baseLabel(),
  upstreamModelCount: UPSTREAM_MODELS.length,
  syncTaskResult: task.result,
  syncSawAuthorization: upstream.seenAuth[0]?.startsWith('Bearer ') === true,
  afterSync: { gatewayCount: gwAfterSync.length, archiveCount: dbAfterSync.length, diff: diffAfterSync },
  afterDisable: {
    disabled: 'gpt-4o',
    gatewayCount: gwAfterDisable.length,
    archiveCount: dbAfterDisable.length,
    gatewayStillHasVictim: gwAfterDisable.includes('gpt-4o'),
    diff: diffAfterDisable,
  },
  verdict:
    diffAfterSync.onlyA.length === 0 &&
    diffAfterSync.onlyB.length === 0 &&
    diffAfterDisable.onlyA.length === 0 &&
    diffAfterDisable.onlyB.length === 0 &&
    gwAfterDisable.includes('gpt-4o') === false &&
    gwAfterSync.length === UPSTREAM_MODELS.length &&
    diffAfterDisable.onlyB.length === 0 &&
    dbAfterDisable.includes('gpt-4o') === false
      ? 'PASS'
      : 'FAIL',
};

console.log(JSON.stringify(report, null, 2));

await runtime.stop();
await runtime.app.close();
await api.close();
db.close();
await new Promise<void>((r) => upstream.server.close(() => r()));
rmSync(dir, { recursive: true, force: true });
