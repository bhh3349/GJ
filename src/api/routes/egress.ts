// 出口路由。契约 §16.7 Tier 2 的配置面。

import type { FastifyInstance } from 'fastify';
import {
  createEgressProxy,
  decryptEgressProxySecret,
  listEgressProxies,
  normalizedEgressIdOfUrl,
  normalizeEgressUrl,
  reactivateEgressProxy,
  requireEgressProxy,
  retireEgressProxy,
  updateEgressProxy,
  type EgressLifecycle,
  type RetiredReason,
} from '../../db/repo/egress.js';
import type { ApiContext } from '../app.js';
import { ApiError } from '../errors.js';
import { auditWrite } from '../http.js';
import { idParam } from '../schemas.js';

const SSRF_BLOCKED_V4 = [
  ['0.0.0.0/8', 0, 0x000000ff],
  ['10.0.0.0/8', 0x0a000000, 0xff000000],
  ['127.0.0.0/8', 0x7f000000, 0xff000000],
  ['169.254.0.0/16', 0xa9fe0000, 0xffff0000],
  ['172.16.0.0/12', 0xac100000, 0xfff00000],
  ['192.168.0.0/16', 0xc0a80000, 0xffff0000],
] as const;

const SSRF_BLOCKED_V6 = ['::1', 'fc00', 'fd00', 'fe80'] as const;

function parseIpv4(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function isBlockedIpv4(address: string): boolean {
  const value = parseIpv4(address);
  if (value === null) return false;
  // value 已是 >>> 0 的无符号值，但 (value & mask) 的结果回到 **int32**：
  // 0xa9fe0000 & 0xffff0000 = -1445965824（负数），与正数 network 常量比较恒 false ——
  // 169.254 / 172.16 / 192.168 三段就是这样全部漏拦的。比较前必须再 >>> 0 一次。
  for (const [, network, mask] of SSRF_BLOCKED_V4) {
    if (((value & mask) >>> 0) === network) return true;
  }
  return false;
}

function isBlockedIpv6(address: string): boolean {
  const value = address.toLowerCase();
  if (value === '::1' || value === '::') return true;
  for (const prefix of SSRF_BLOCKED_V6) {
    if (value.startsWith(prefix)) return true;
  }
  return false;
}

function assertPublicProxyHost(rawUrl: string): void {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname;
  if (host.includes('%') || host.endsWith('.')) {
    throw ApiError.invalidParam('url', '代理地址必须使用可解析的公网主机名');
  }
  if (host.includes(':')) {
    if (isBlockedIpv6(host)) {
      throw ApiError.invalidParam('url', '出口不得指向内网或链路本地地址');
    }
    return;
  }
  if (!host.includes('.')) {
    throw ApiError.invalidParam('url', '代理地址必须使用可解析的公网主机名');
  }
  if (isBlockedIpv4(host)) {
    throw ApiError.invalidParam('url', '出口不得指向内网或链路本地地址');
  }
}

const lifecycleProp = { type: 'string', enum: ['active', 'retired'] } as const;
const nullableStringProp = { type: ['string', 'null'] } as const;

const createBody = {
  type: 'object',
  required: ['name', 'url'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    url: { type: 'string', minLength: 1, maxLength: 500 },
    username: { type: 'string', minLength: 0, maxLength: 128 },
    password: { type: 'string', minLength: 0, maxLength: 512 },
    region: nullableStringProp,
    note: nullableStringProp,
  },
} as const;

const updateBody = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    region: nullableStringProp,
    note: nullableStringProp,
    username: { type: 'string', minLength: 0, maxLength: 128 },
    password: { type: 'string', minLength: 0, maxLength: 512 },
  },
} as const;

const retireBody = {
  type: 'object',
  required: ['reason'],
  properties: { reason: { type: 'string', enum: ['replaced', 'manual'] } },
} as const;

const listQuery = {
  type: 'object',
  properties: { status: lifecycleProp },
  additionalProperties: true,
} as const;

function proxyUrlWithCredentials(base: string, credentials: string): string {
  const parsed = new URL(base);
  const at = credentials.indexOf(':');
  if (at < 0) return base;
  return `${parsed.protocol}//${encodeURIComponent(credentials.slice(0, at))}:${encodeURIComponent(credentials.slice(at + 1))}@${parsed.host}`;
}

/**
 * 探活出站的注入缝（契约 §16.7 / ADR-0021 决策 4c 同款纪律）。
 *
 * 缺省**延迟**取全局 fetch：写成模块级常量会在 import 那一刻绑死，测试就换不掉了。
 * 线上不传 ⇒ 行为与直调 fetch 逐字节相同；spec 注入假件 ⇒ 用例零网络。
 * 没有这层缝，/test 的成功用例就得真打 api.ipify.org —— 沙箱/CI 里既不可复现，
 * 也违背"测试不发真实出站请求"的项目纪律。
 */

export type EgressProbeFetch = typeof fetch;

export function registerEgressRoutes(
  app: FastifyInstance,
  ctx: ApiContext,
  egressProbeFetch: EgressProbeFetch = (...args) => fetch(...args),
): void {
  const { db, config, egress } = ctx;

  app.get<{ Querystring: { status?: EgressLifecycle } }>(
    '/api/egress',
    { schema: { querystring: listQuery } },
    (req) => {
      const items = listEgressProxies(db);
      if (req.query.status === undefined) return { items };
      return { items: items.filter((e) => e.status === req.query.status) };
    },
  );

  app.post<{ Body: { name: string; url: string; username?: string; password?: string; region?: string | null; note?: string | null } }>(
    '/api/egress',
    { schema: { body: createBody } },
    (req, reply) => {
      const url = normalizeEgressUrl(req.body.url);
      assertPublicProxyHost(url);
      if (normalizedEgressIdOfUrl(url) === null) {
        throw ApiError.invalidParam('url', '解析不出出口地址');
      }
      const created = createEgressProxy(db, req.body, config.masterKey);
      auditWrite(db, req, config, { action: 'egress.create', targetType: 'egress', targetId: created.id });
      return reply.code(201).send(created);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/egress/:id',
    { schema: { params: idParam } },
    (req) => requireEgressProxy(db, req.params.id),
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; region?: string | null; note?: string | null; username?: string; password?: string } }>(
    '/api/egress/:id',
    { schema: { params: idParam, body: updateBody } },
    (req) => {
      const updated = updateEgressProxy(db, req.params.id, req.body, config.masterKey);
      auditWrite(db, req, config, { action: 'egress.update', targetType: 'egress', targetId: updated.id });
      return updated;
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: RetiredReason } }>(
    '/api/egress/:id/retire',
    { schema: { params: idParam, body: retireBody } },
    (req) => {
      retireEgressProxy(db, req.params.id, req.body.reason, new Date().toISOString());
      auditWrite(db, req, config, {
        action: 'egress.retire',
        targetType: 'egress',
        targetId: req.params.id,
        detail: req.body.reason,
      });
      return { ok: true, status: 'retired' as const };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/egress/:id/reactivate',
    { schema: { params: idParam } },
    (req) => {
      const updated = reactivateEgressProxy(db, req.params.id, new Date().toISOString());
      auditWrite(db, req, config, { action: 'egress.reactivate', targetType: 'egress', targetId: updated.id });
      return updated;
    },
  );

  app.post<{ Params: { id: string } }>('/api/egress/:id/test', { schema: { params: idParam } }, async (req) => {
    const row = requireEgressProxy(db, req.params.id);
    const gate = egress.reserve(row.id, 'management');
    if (!gate.allowed) {
      throw new ApiError('TOO_MANY_ATTEMPTS', '出口预算已耗尽', {
        retryAfterSec: Math.max(1, Math.ceil(gate.retryAfterMs / 1000)),
      });
    }
    const started = Date.now();
    try {
      const blobRow = row.authSet
        ? (db.prepare('SELECT secret FROM egress_proxies WHERE id = ?').get(row.id) as { secret: Buffer })
        : null;
      const proxyUrl = blobRow === null
        ? row.url
        : proxyUrlWithCredentials(row.url, decryptEgressProxySecret(blobRow.secret, config.masterKey));
      const { ProxyAgent } = await import('undici');
      const res = await egressProbeFetch('https://api.ipify.org', {
        dispatcher: new ProxyAgent(proxyUrl),
      } as unknown as RequestInit);
      const egressIp = (await res.text()).trim();
      const ok = res.ok && /^[0-9a-fA-F:.]{3,45}$/.test(egressIp);
      if (ok) egress.observeSuccess(row.id);
      const at = new Date().toISOString();
      updateEgressProxy(db, row.id, { lastTestAt: at, lastTestOk: ok }, config.masterKey);
      return {
        ok,
        egressIp: ok ? egressIp : null,
        latencyMs: Date.now() - started,
        error: ok ? null : `HTTP ${res.status}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : '出口测试失败';
      const at = new Date().toISOString();
      updateEgressProxy(db, row.id, { lastTestAt: at, lastTestOk: false }, config.masterKey);
      return { ok: false, egressIp: null, latencyMs: Date.now() - started, error: message };
    }
  });
}
