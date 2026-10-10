// M5 验收证据探针 —— 第 3 条「余额变动 5s 内经 WS 呈现」。
//
// 这个文件只做一件事：把"PUT 录入余额 → 前端收到 balance 帧"的真实耗时量出来并打印。
// 纪律：
//   * 用**真实的 1s ticker**（buildApp 默认 liveAutoTick: true），不借 tickNow() 提前跑拍 ——
//     验收问的正是"真实推帧节奏下多久呈现"，拿 tickNow 量等于把被判据量掉的时钟自己按掉。
//   * 等待挂在帧到达事件上，timeout 只把"永远等不到"变成失败，不参与通过路径。
//   * 不改仓库任何行为：不新增脚本名、不碰四闸、不写 src/。
//
// 用法（在检出于 main@4516b24 的 worktree 里）：pnpm exec tsx scripts/m5/balance-ws-latency.ts
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/api/app.js';
import { bootstrapAdmin } from '../../src/api/auth.js';
import { openDatabase } from '../../src/db/database.js';
import { createKey } from '../../src/db/repo/keys.js';
import { createUpstream } from '../../src/db/repo/upstreams.js';
import type { AppConfig } from '../../src/config.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'm5-probe-pass-1';
const BALANCE_CENTS = 123_45;

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

const dir = mkdtempSync(join(tmpdir(), 'm5-balance-ws-'));
const dbPath = join(dir, 'gateway.db');
const db = openDatabase({ path: dbPath });
const app = buildApp({ db, config: makeConfig(dbPath) });
bootstrapAdmin(db, { ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS });

const upstream = createUpstream(db, { name: 'probe-upstream', baseUrl: 'https://upstream.invalid' });
const key = createKey(
  db,
  { upstreamId: upstream.id, key: 'probe-plaintext-key-1', category: 'balance', label: 'probe' },
  makeConfig(dbPath).masterKey,
);

const login = await app.inject({
  method: 'POST',
  url: '/api/auth/login',
  payload: { username: ADMIN_USER, password: ADMIN_PASS },
  headers: { 'x-requested-with': 'fetch' },
});
if (login.statusCode !== 200) throw new Error(`登录失败 ${login.statusCode}: ${login.body}`);
const rawCookie = login.headers['set-cookie'];
const cookie = String(Array.isArray(rawCookie) ? rawCookie[0] : rawCookie).split(';')[0] ?? '';

const socket = await app.injectWS('/api/stats/live', { headers: { cookie } });

interface Waiter {
  label: string;
  done: boolean;
  at: number;
  resolve: () => void;
}
const waiters: Waiter[] = [];
let closeCode: number | null = null;

function arm(label: string): Waiter {
  const w: Waiter = { label, done: false, at: 0, resolve: () => undefined };
  waiters.push(w);
  return w;
}
function settle(label: string): void {
  for (const w of waiters) {
    if (!w.done && w.label === label) {
      w.done = true;
      w.at = performance.now();
      w.resolve();
    }
  }
}

socket.on('message', (raw: unknown) => {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8');
  let frame: { type?: string; keyId?: string; balance?: number | null } = {};
  try {
    frame = JSON.parse(text) as typeof frame;
  } catch {
    return;
  }
  if (frame.type === 'ready') settle('ready');
  if (frame.type === 'balance' && frame.keyId === key.id) settle('balance');
});
socket.on('close', (code: number) => {
  closeCode = code;
  settle('close');
});

function waitFor(label: string, timeoutMs: number): Promise<number> {
  const w = waiters.find((x) => x.label === label && !x.done);
  if (w === undefined) throw new Error(`未武装的等待: ${label}`);
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`等待 ${label} 超时 ${timeoutMs}ms（closeCode=${closeCode ?? 'null'}）`));
    }, timeoutMs);
    // 刻意**不** unref：hub 的 1s ticker 是 unref 的（线上语义：不为进程续命），
    // 探针里若把等待定时器也 unref，事件循环会提前空掉，量到的不是延迟而是"进程退出"。
    w.resolve = () => {
      clearTimeout(timer);
      resolve(w.at);
    };
  });
}

const readyWaiter = arm('ready');
const tConnect = performance.now();
socket.send(JSON.stringify({ type: 'auth' }));
const tReady = await waitFor('ready', 5000);

// 先等一拍 metrics，确认 ticker 已经在跑：否则"PUT 后立刻建连"会把 ticker 启动时间
// 算进呈现延迟里，量出来的数偏乐观。
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('等不到第一拍 metrics 帧（ticker 未启动？）')), 5000);
  const onMsg = (raw: unknown): void => {
    const text = typeof raw === 'string' ? raw : Buffer.from(raw as Uint8Array).toString('utf8');
    if (text.includes('"type":"metrics"')) {
      clearTimeout(timer);
      socket.off('message', onMsg);
      resolve();
    }
  };
  socket.on('message', onMsg);
});

const balanceWaiter = arm('balance');
const tPut = performance.now();
const put = await app.inject({
  method: 'PUT',
  url: `/api/keys/${key.id}/balance`,
  payload: { balance: BALANCE_CENTS },
  headers: { cookie, 'x-requested-with': 'fetch' },
});
if (put.statusCode !== 200) throw new Error(`余额录入失败 ${put.statusCode}: ${put.body}`);
const tAccepted = performance.now();
const tFrame = await waitFor('balance', 5000);

const row = db.prepare('SELECT balance_cents, balance_updated_at FROM upstream_keys WHERE id = ?').get(key.id) as
  | { balance_cents: number | null; balance_updated_at: string | null }
  | undefined;

console.log(
  JSON.stringify(
    {
      probe: 'balance-ws-latency',
      base: baseLabel(),
      acceptMs: 5000,
      readyMs: Math.round(tReady - tConnect),
      putHandlerMs: Number((tAccepted - tPut).toFixed(1)),
      putToFrameMs: Math.round(tFrame - tAccepted),
      totalFromPutMs: Math.round(tFrame - tPut),
      dbBalanceCents: row?.balance_cents ?? null,
      dbBalanceUpdatedAt: row?.balance_updated_at ?? null,
      verdict: tFrame - tPut < 5000 ? 'PASS' : 'FAIL',
    },
    null,
    2,
  ),
);

socket.terminate();
await app.close();
db.close();
rmSync(dir, { recursive: true, force: true });
