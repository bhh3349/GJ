// Fastify 应用装配：错误收口、鉴权闸门、CSRF、路由注册。
//
// 这里有两道「全量」闸门，都不允许有白名单例外（契约 §0.5）：
//   1. `/api/*` 除 `POST /api/auth/login` 外全部要求有效会话；
//   2. 写方法全部过 CSRF 三层校验。
// 实现方式是把闸门放在 onRequest 钩子里一次判完，而不是散在每个 handler 里 ——
// 后者只要有人新加一个路由忘了写守卫，就静默变成公开接口。
//
// 错误体在 setErrorHandler 里统一成 `{code,message,details?}`，
// 包括 Fastify 自己的 schema 校验错误：它默认的形状不符合契约，
// 且前端拿不到 `details.field` 就没法把表单那一栏标红。

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/database.js';
import { LoginRateLimiter, requireSession, type SessionInfo } from './auth.js';
import { ApiError } from './errors.js';
import { isWriteMethod, sessionCookieValue, verifyCsrf } from './http.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerKeyRoutes } from './routes/keys.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerModelRoutes } from './routes/models.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerUpstreamRoutes } from './routes/upstreams.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: (SessionInfo & { viaMachineToken: boolean }) | null;
  }
}

export interface ApiContext {
  db: Db;
  config: AppConfig;
  loginLimiter: LoginRateLimiter;
}

/** 唯一免鉴权路径（契约 §0.5）。用 method+path 精确匹配，不用前缀。 */
function isPublic(method: string, path: string): boolean {
  return method === 'POST' && path === '/api/auth/login';
}

function validationField(error: { validation?: unknown }): string {
  const list = error.validation;
  if (!Array.isArray(list) || list.length === 0) return 'body';
  const first = list[0] as { instancePath?: unknown; params?: unknown };
  const params = (first.params ?? {}) as Record<string, unknown>;
  const missing = params['missingProperty'];
  if (typeof missing === 'string') return missing;
  if (typeof first.instancePath === 'string' && first.instancePath !== '') {
    return first.instancePath.replace(/^\//, '').replace(/\//g, '.');
  }
  return 'body';
}

export interface BuildAppOptions {
  db: Db;
  config: AppConfig;
  logger?: boolean;
  /**
   * 登录限速器可由调用方注入：它持有一份按 IP 的内存计数，需要**周期性 prune**
   * 才不会让大量不同来源 IP 把它撑爆。进程入口拿到同一个实例才能定期清理，
   * 否则这里创建的实例没人有机会 prune（进程不重启就一直攒）。
   */
  loginLimiter?: LoginRateLimiter;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { db, config } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    // 管理面只收小 JSON；给个上限免得一个超长 body 把单线程事件循环卡住
    bodyLimit: 1 * 1024 * 1024,
    trustProxy: config.trustProxy,
  });

  const ctx: ApiContext = {
    db,
    config,
    loginLimiter: opts.loginLimiter ?? new LoginRateLimiter(),
  };

  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const path = req.url.split('?')[0] ?? req.url;

    // 非 /api/* 的路径（例如将来挂静态资源）不在这里判，交给各自的处理器
    if (!path.startsWith('/api/')) return;

    // CSRF 在鉴权**之前**：login 也同样受保护（登录 CSRF 是一种真实的攻击面，
    // 诱使受害者的浏览器用攻击者的账号登入，之后受害者的操作全落在对方账号里）。
    // 契约里对 CSRF 的要求是"所有写请求"，从未把 login 排除在外。
    if (isWriteMethod(req.method)) verifyCsrf(req, config.allowedOrigins);

    if (isPublic(req.method, path)) return;

    // CI 机器令牌：只认 Bearer，不参与浏览器流程；未配置即为关闭
    const authz = req.headers.authorization;
    if (config.adminToken !== null && typeof authz === 'string' && authz.startsWith('Bearer ')) {
      const presented = authz.slice('Bearer '.length).trim();
      if (presented !== '' && presented === config.adminToken) {
        req.auth = { username: 'ci', expiresAt: new Date(Date.now() + 60_000).toISOString(), viaMachineToken: true };
        return;
      }
      throw new ApiError('UNAUTHORIZED', '令牌无效');
    }

    req.auth = { ...requireSession(db, sessionCookieValue(req), config.sessionTtlHours), viaMachineToken: false };
  });

  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ApiError) {
      void reply.code(error.status).send(error.toBody());
      return;
    }

    // Fastify 的错误类型在这里是 unknown（不是每个抛出物都是 Error）。
    // 先收窄成"可能带 statusCode/validation 的东西"，再决定回什么。
    const thrown = error as { statusCode?: unknown; validation?: unknown };
    const status = typeof thrown.statusCode === 'number' ? thrown.statusCode : 500;
    if (status === 400 && thrown.validation !== undefined) {
      const field = validationField({ validation: thrown.validation });
      const body = new ApiError('INVALID_PARAM', `参数 ${field} 不合法`, { field }).toBody();
      void reply.code(400).send(body);
      return;
    }

    // 未预期的异常：日志里留全量，响应里只给通用信息。
    // 把 driver 的原始报错回给客户端，等于免费送一份内部结构说明。
    req.log.error({ err: error }, '未处理的请求异常');
    void reply.code(500).send({ code: 'INTERNAL', message: '服务端异常，请稍后重试' });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ code: 'NOT_FOUND', message: `接口不存在: ${req.method} ${req.url}` });
  });

  registerAuthRoutes(app, ctx);
  registerUpstreamRoutes(app, ctx);
  registerKeyRoutes(app, ctx);
  registerGroupRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  registerStatsRoutes(app, ctx);
  registerMiscRoutes(app, ctx);

  return app;
}
