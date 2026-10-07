// HTTP 层零碎：Cookie 读写、客户端 IP、CSRF。
//
// 不引 @fastify/cookie 是刻意的：这里需要的只是"解析一个 sid、写一个 HttpOnly Cookie"，
// 十几行就能写完且语义完全可见；换成依赖后，反而要额外确认它的默认
// `sameSite`/`path`/编码行为是否和我们冻结的口径一致。少一个依赖，少一处需要审计的默认值。

import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { appendAudit } from '../db/repo/audit.js';
import type { Db } from '../db/database.js';
import { ApiError } from './errors.js';

export const SESSION_COOKIE = 'sid';

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === '') continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function sessionCookieValue(req: FastifyRequest): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

/**
 * 契约 §1：`HttpOnly; SameSite=Lax; Path=/`，生产加 `Secure`。
 * 不设 `Domain` —— host-only Cookie 无法被子域读取，是同源部署下最紧的一档。
 */
export function buildSessionCookie(token: string, opts: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

export function buildClearCookie(opts: { secure: boolean }): string {
  const parts = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 客户端 IP：只有显式信任代理时才看 X-Forwarded-For，否则伪造该头就能绕过登录限速。 */
export function clientIp(req: FastifyRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (typeof raw === 'string' && raw !== '') {
      const first = raw.split(',')[0]?.trim();
      if (first !== undefined && first !== '') return first;
    }
  }
  return req.ip;
}

/**
 * 审计用的调用者标识。
 *
 * 放在本文件而不是 app.ts：路由模块要写审计，而 app.ts 又要 import 路由模块，
 * 从 app.ts 取这个函数会形成"路由 ↔ 装配"的运行期循环引用。类型可以循环
 * （`import type` 不产生代码），**值不行** —— 这里刻意不给自己留这个坑。
 */
export function actorOf(req: FastifyRequest): string {
  return req.auth?.username ?? 'anonymous';
}

export interface AuditWriteInput {
  action: string;
  targetType: string;
  targetId?: string | null;
  result?: 'ok' | 'fail';
  detail?: string | null;
}

/**
 * 写一条审计。契约 §6：覆盖"登录 / 登出 / **所有写操作**"。
 *
 * 收成一个函数而不是让每个 handler 手写 appendAudit：actor 与 ip 的取值方式
 * 只写一遍，就不会出现某个路由忘了带 ip（审计里那行直接失去价值）。
 */
export function auditWrite(
  db: Db,
  req: FastifyRequest,
  config: AppConfig,
  entry: AuditWriteInput,
): void {
  appendAudit(db, {
    actor: actorOf(req),
    ip: clientIp(req, config.trustProxy),
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    result: entry.result ?? 'ok',
    detail: entry.detail ?? null,
  });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * "谁、从哪个 IP 做的" —— **在这一刻**取下来，供**异步**收尾写审计用。
 *
 * 为什么要有它：批量端点（§15.2 的 import / refresh / keys / keys/sync）回 `202` 时
 * 才知道任务号，而"干了多少、成了几行"要等任务跑完（27 个号 ≈ 1 分钟）才有 ——
 * 那时 `req` 早过了它的一生。把 `auditWrite(db, req, …)` 的调用点推迟到那一刻，
 * 读的是响应发出之后的请求对象；把两个字段先取下来，语义才确定。
 *
 * 这也是 `auditWrite` 本身**不改**的原因：它服务的是同步 handler（绝大多数），
 * 异步收尾是少数派，给多数派加一个 `req | captured` 联合类型去迁就它不划算。
 */
export function captureAuditActor(
  req: FastifyRequest,
  config: AppConfig,
): { actor: string; ip: string } {
  return { actor: actorOf(req), ip: clientIp(req, config.trustProxy) };
}

export function isWriteMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

/**
 * `Origin` 与 `Host` 是否同一站点。
 *
 * 导出给实时通道复用（routes/live.ts）：WebSocket 不受同源策略保护，且没有 CSRF
 * 那三层头可查，Origin 是那条链路上唯一的结构性防线。两处口径必须一致 ——
 * 不一致就会留下一条绕过路径：写请求被 CSRF 挡住，但 WS 能推数据出去。
 */
/** scheme 的默认端口后缀。`URL` 会把它们从 host 里吃掉，裸字符串不会，见下。 */
const DEFAULT_PORT_SUFFIX: Record<string, string> = { 'http:': ':80', 'https:': ':443' };

export function originHostMatches(origin: string, host: string | undefined): boolean {
  if (host === undefined) return false;
  try {
    const u = new URL(origin);
    // `URL` 会把 scheme 的默认端口**规范化掉**（`http://a.com:80` → host `a.com`），
    // 而 `Host` 头是裸字符串、原样保留。两边不先归一化，同一站点就会被判成跨站：
    // 浏览器发的是 `Origin: http://a.com`（默认端口不写），
    // 而反代若用 `$http_host` 透传，我们收到的 `Host` 就是 `a.com:80` → 判不同源。
    // 后果不是"多拒一个请求"那么轻：所有写请求被 CSRF 挡下（403 CSRF_REJECTED），
    // WS 升级直接 1008，仪表盘永远连不上 —— 且两边都难定位到是"端口写法"的问题。
    // 这不会放宽攻击面：比较的仍是同一个主机名，只是容忍默认端口的两种写法。
    const suffix = DEFAULT_PORT_SUFFIX[u.protocol];
    let normalizedHost = host.toLowerCase();
    if (suffix !== undefined && normalizedHost.endsWith(suffix)) {
      normalizedHost = normalizedHost.slice(0, -suffix.length);
    }
    return u.host.toLowerCase() === normalizedHost;
  } catch {
    return false;
  }
}

/**
 * CSRF 校验，顺序固定（契约 §0.5）：`Origin` → `Sec-Fetch-Site` → `X-Requested-With`。
 *
 * 三层不是"或"关系而是**逐层叠加**：任何一层给出否定信号就直接拒。
 * 之所以还要第三层 `X-Requested-With`，是因为它无法由 HTML 表单跨站发起
 * （简单表单只能发 form 编码的三个安全头），这是最后一道结构性防线。
 *
 * 只读请求不校验 —— 契约说的是"写请求"。
 */
export function verifyCsrf(req: FastifyRequest, allowedOrigins: readonly string[]): void {
  if (!isWriteMethod(req.method)) return;

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    const ok =
      allowedOrigins.length > 0
        ? allowedOrigins.includes(origin)
        : originHostMatches(origin, req.headers.host);
    if (!ok) throw new ApiError('CSRF_REJECTED', '请求来源不被允许，请刷新页面后重试');
  }

  const site = req.headers['sec-fetch-site'];
  const siteValue = Array.isArray(site) ? site[0] : site;
  if (typeof siteValue === 'string' && siteValue !== '') {
    // `none` 是用户直接输入地址栏（非跨站发起），放行；`same-site` 仍可能来自兄弟子域，拒。
    if (siteValue !== 'same-origin' && siteValue !== 'none') {
      throw new ApiError('CSRF_REJECTED', '跨站请求被拒绝，请刷新页面后重试');
    }
  }

  const xrw = req.headers['x-requested-with'];
  const xrwValue = Array.isArray(xrw) ? xrw[0] : xrw;
  if (typeof xrwValue !== 'string' || xrwValue === '') {
    throw new ApiError('CSRF_REJECTED', '缺少 X-Requested-With 头，请刷新页面后重试');
  }
}
