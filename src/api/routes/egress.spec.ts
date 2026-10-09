// 出口路由验收：鉴权 / 契约 / 生命周期 / 凭据与 SSRF。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../config.js';
import { decryptSecret } from '../../db/crypto.js';
import { openDatabase, type Db } from '../../db/database.js';
import { buildApp } from '../app.js';
import { bootstrapAdmin } from '../auth.js';
import type { EgressProxyDto } from '../../db/repo/egress.js';

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'egress-route-pass-1';
const MASTER_KEY = Buffer.from('2a'.repeat(32), 'hex');

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
    balanceSyncMinutes: 0,
    balanceSnapshotRetentionDays: 90,
    ...over,
  };
}

export async function setup(probeFetch?: typeof fetch): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'egress-route-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');
  const db = openDatabase({ path: dbPath });
  const app = buildApp({
    db,
    config: makeConfig(dbPath),
    balanceSync: false,
    healthSnapshots: false,
    ...(probeFetch === undefined ? {} : { egressProbeFetch: probeFetch }),
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

export async function post(h: Harness, url: string, payload?: Record<string, unknown>) {
  const res = await h.app.inject({
    method: 'POST',
    url,
    headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

async function patch(h: Harness, url: string, payload: Record<string, unknown>) {
  const res = await h.app.inject({
    method: 'PATCH',
    url,
    headers: { cookie: h.cookie, 'x-requested-with': 'fetch' },
    payload,
  });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

function egressRow(db: Db, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM egress_proxies WHERE id = ?').get(id) as Record<string, unknown>;
}

describe('/api/egress 闸门', () => {
  it('无会话 GET → 401', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/egress' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('写请求缺 X-Requested-With → 403 CSRF_REJECTED', async () => {
    const h = await setup();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/egress',
      headers: { cookie: h.cookie },
      payload: { name: 'hk-1', url: 'http://proxy.example:8080' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'CSRF_REJECTED' });
  });
});

describe('/api/egress 校验', () => {
  it('URL 带凭据 → 400，且字面量不落库', async () => {
    const h = await setup();
    const url = `http://${'u'}:${'p'}@proxy.example:8080`;
    const res = await post(h, '/api/egress', { name: 'bad', url });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'url' } });
    expect((res.body as { message?: string }).message).toContain('凭据');
    const rows = h.db.prepare('SELECT COUNT(*) AS n FROM egress_proxies').get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('SSRF：回环 / 私网 / 元数据地址全部 400', async () => {
    const h = await setup();
    for (const host of ['127.0.0.1', '10.0.0.8', '169.254.169.254', '192.168.1.10', '172.16.0.9']) {
      const res = await post(h, '/api/egress', { name: `bad-${host}`, url: `http://${host}:8080` });
      expect(res.status, host).toBe(400);
      expect((res.body as { details?: { field?: string } }).details?.field).toBe('url');
    }
  });

  it('同一 URL 等价写法判重 → 400 INVALID_PARAM url', async () => {
    const h = await setup();
    const first = await post(h, '/api/egress', { name: 'hk-1', url: 'https://Proxy.Example:8443' });
    expect(first.status).toBe(201);
    const second = await post(h, '/api/egress', { name: 'hk-1b', url: 'https://proxy.example:8443/' });
    expect(second.status).toBe(400);
    expect((second.body as { details?: { field?: string } }).details?.field).toBe('url');
  });

  it('同名判重 → 409 CONFLICT name', async () => {
    const h = await setup();
    await post(h, '/api/egress', { name: 'same', url: 'https://a.example:8080' });
    const res = await post(h, '/api/egress', { name: 'same', url: 'https://b.example:8080' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'CONFLICT', details: { field: 'name' } });
  });
});

describe('/api/egress 生命周期', () => {
  it('创建 → 列表 → 详情：凭据只回 authSet，secret 密文可用主密钥解开', async () => {
    const h = await setup();
    const created = await post(h, '/api/egress', {
      name: 'hk-1',
      url: 'https://proxy.example:8443',
      username: 'egress-user',
      password: 'egress-pass-1',
      region: 'hk',
      note: 'primary',
    });
    expect(created.status).toBe(201);
    const dto = created.body as unknown as EgressProxyDto;
    expect(dto).toMatchObject({
      name: 'hk-1',
      url: 'https://proxy.example:8443',
      status: 'active',
      authSet: true,
      lastTestAt: null,
      lastTestOk: null,
    });
    expect(JSON.stringify(dto)).not.toContain('egress-pass-1');
    const row = egressRow(h.db, dto.id);
    expect(decryptSecret(row['secret'] as Buffer, MASTER_KEY)).toBe('egress-user:egress-pass-1');

    const list = await h.app.inject({ method: 'GET', url: '/api/egress', headers: { cookie: h.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [created.body] });

    const one = await h.app.inject({ method: 'GET', url: `/api/egress/${dto.id}`, headers: { cookie: h.cookie } });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual(created.body);
  });

  it('PATCH 不带任何字段 → 200 且 revision 语义同族：行未变，secret 未重写', async () => {
    const h = await setup();
    const created = await post(h, '/api/egress', { name: 'hk-1', url: 'https://proxy.example:8443' });
    const id = (created.body as { id: string }).id;
    const before = egressRow(h.db, id);
    const res = await patch(h, `/api/egress/${id}`, {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(created.body);
    const after = egressRow(h.db, id);
    expect(after['secret']).toEqual(before['secret']);
    expect(after['updated_at']).toBe(before['updated_at']);
  });

  it('PATCH 换凭据：明文不落盘，authSet 可从 true 回到 false', async () => {
    const h = await setup();
    const created = await post(h, '/api/egress', {
      name: 'hk-1',
      url: 'https://proxy.example:8443',
      username: 'u',
      password: 'old-secret-1',
    });
    const id = (created.body as { id: string }).id;
    const res = await patch(h, `/api/egress/${id}`, { username: 'u', password: 'new-secret-2' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('new-secret-2');
    const row = egressRow(h.db, id);
    expect(decryptSecret(row['secret'] as Buffer, MASTER_KEY)).toBe('u:new-secret-2');

    const cleared = await patch(h, `/api/egress/${id}`, { username: '', password: '' });
    expect((cleared.body as { authSet?: boolean }).authSet).toBe(false);
  });

  it('retire 必带原因；成功后不删行；retired_at 不因回池清空', async () => {
    const h = await setup();
    const created = await post(h, '/api/egress', { name: 'hk-1', url: 'https://proxy.example:8443' });
    const id = (created.body as { id: string }).id;
    const noReason = await post(h, `/api/egress/${id}/retire`, {});
    expect(noReason.status).toBe(400);
    const badReason = await post(h, `/api/egress/${id}/retire`, { reason: 'oops' });
    expect(badReason.status).toBe(400);

    const retired = await post(h, `/api/egress/${id}/retire`, { reason: 'manual' });
    expect(retired.status).toBe(200);
    expect(egressRow(h.db, id)).toMatchObject({ status: 'retired', retired_reason: 'manual' });
    expect((egressRow(h.db, id)['retired_at'] as string).endsWith('Z')).toBe(true);

    const again = await post(h, `/api/egress/${id}/retire`, { reason: 'manual' });
    expect(again.status).toBe(409);

    const reactivated = await post(h, `/api/egress/${id}/reactivate`);
    expect(reactivated.status).toBe(200);
    const body = reactivated.body as { status: string; retiredReason: string | null; retiredAt: string | null };
    expect(body).toMatchObject({ status: 'active', retiredReason: 'manual' });
    expect(body.retiredAt).toBe(egressRow(h.db, id)['retired_at']);
  });

  it('仍被账号引用的 retire → 409 EGRESS_HAS_ACCOUNTS + accountCount，零副作用且不写成功审计', async () => {
    const h = await setup();
    const created = await post(h, '/api/egress', { name: 'hk-1', url: 'https://proxy.example:8443' });
    const id = (created.body as { id: string }).id;
    const at = '2026-10-09T00:00:00.000Z';
    h.db
      .prepare(
        `INSERT INTO supplier_accounts (
           id, upstream_id, supplier, identifier, identifier_hash, username, uid,
           encrypted_password, encrypted_session, session_expires_at,
           status, status_message, balance_cents, balance_currency, balance_updated_at,
           egress_id, revision, created_at, updated_at
         ) VALUES ('acc_probe', 'up_probe', 'tierflow', '138****8000', 'hash-probe', NULL, NULL,
                   ?, NULL, NULL, 'unknown', NULL, NULL, NULL, NULL, ?, 1, ?, ?)`,
      )
      .run(Buffer.from('fake-ciphertext'), id, at, at);

    const res = await post(h, `/api/egress/${id}/retire`, { reason: 'manual' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'EGRESS_HAS_ACCOUNTS', details: { accountCount: 1 } });
    expect(egressRow(h.db, id)).toMatchObject({ status: 'active', retired_reason: null, retired_at: null });
    const audits = h.db.prepare(`SELECT result FROM audit_log WHERE action = 'egress.retire'`).all() as {
      result: string;
    }[];
    expect(audits).toHaveLength(0);
  });
});

describe('/api/egress/:id/test', () => {
  it('回显成功（离线假件、零网络）：ok + egressIp + lastTestOk=true', async () => {
    const probe: typeof fetch = async () => new Response('203.0.113.7', { status: 200 });
    const h = await setup(probe);
    const created = await post(h, '/api/egress', { name: 'hk-1', url: 'https://proxy.example:8443' });
    const id = (created.body as { id: string }).id;
    const testRes = await post(h, `/api/egress/${id}/test`);
    expect(testRes.status).toBe(200);
    expect(testRes.body).toMatchObject({ ok: true, egressIp: '203.0.113.7' });
    expect((testRes.body as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0);
    expect(egressRow(h.db, id)).toMatchObject({ last_test_ok: 1 });
    expect((egressRow(h.db, id)['last_test_at'] as string).endsWith('Z')).toBe(true);
  });
});