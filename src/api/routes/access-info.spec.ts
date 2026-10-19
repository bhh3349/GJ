// 接入信息只读面验收：形状 / 零副作用 / 配置回显权威性。契约 §18 / ADR-0028。
//
// 本套用例只钉三件事，全部是"这一页能不能被信"的判据：
//   1. 形状与字段口径（`scheme` 恒 http、`adminWebDistEnabled` 是**配置事实**不是运行期探测）；
//   2. 值全部来自 config 现读（改 config ⇒ 响应跟着变，没有第二份事实源）；
//   3. 只读、无副作用（GET 不写审计、不碰库）。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import { openDatabase, type Db } from '../../db/database.js';
import { buildApp } from '../app.js';
import { bootstrapAdmin } from '../auth.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'access-info-pass-1';
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
  cookie: string;
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
    publicHost: null,
    ...over,
  };
}

async function setup(over: Partial<AppConfig> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'access-info-'));
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
  const cookie = String(Array.isArray(raw) ? raw[0] : raw).split(';')[0] ?? '';
  const h: Harness = { app, db, cookie };
  harnesses.push(h);
  return h;
}

describe('GET /api/access-info（契约 §18）', () => {
  it('回 §18 形状：端口 / 绑定地址 / publicHost / adminWebDistEnabled，scheme 恒 http', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/access-info',
      headers: { cookie: h.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      gateway: { scheme: 'http', portGateway: 4000, hostGateway: '0.0.0.0' },
      admin: { scheme: 'http', portAdmin: 4001, hostAdmin: '127.0.0.1' },
      publicHost: null,
      adminWebDistEnabled: false,
    });
  });

  it('值全部来自 config 现读（端口 / host / publicHost 改了响应就跟着变，无第二份事实源）', async () => {
    const h = await setup({
      portGateway: 8080,
      hostGateway: '10.0.0.5',
      portAdmin: 9090,
      hostAdmin: '10.0.0.6',
      publicHost: 'gw.example.com',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/access-info',
      headers: { cookie: h.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      gateway: { scheme: 'http', portGateway: 8080, hostGateway: '10.0.0.5' },
      admin: { scheme: 'http', portAdmin: 9090, hostAdmin: '10.0.0.6' },
      publicHost: 'gw.example.com',
      adminWebDistEnabled: false,
    });
  });

  /**
   * `adminWebDistEnabled` 的口径是「**配置了** `ADMIN_WEB_DIST` 吗」（§17 root 口径），
   * 不是「此刻真的在托管」。这里给一个**不存在**的目录：字段仍为 true —— 目录缺失是
   * 运行期退化（启动 warn + 404），不改这个**配置事实**，否则前端会把"配了但目录没构建"
   * 误读成"没配托管"。
   */
  it('adminWebDistEnabled = 配置事实（配了不存在的目录仍为 true，不做运行期探测）', async () => {
    const h = await setup({ adminWebDist: join(tmpdir(), 'definitely-not-built-dist-xyz') });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/access-info',
      headers: { cookie: h.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().adminWebDistEnabled).toBe(true);
  });

  it('只读、无副作用：GET 不写审计（audit_log 零新增）', async () => {
    const h = await setup();
    const before = (h.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    await h.app.inject({ method: 'GET', url: '/api/access-info', headers: { cookie: h.cookie } });
    const after = (h.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('鉴权：会话缺失 → 401（走 §1 既有闸门，本端点不自判）', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/access-info' });
    expect(res.statusCode).toBe(401);
  });

  it('机器令牌（ADMIN_TOKEN Bearer）可读', async () => {
    const h = await setup({ adminToken: 'ci-access-info' });
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/access-info',
      headers: { authorization: 'Bearer ci-access-info' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().gateway.portGateway).toBe(4000);
  });
});
