// 鉴权路由。契约 §1。
//
// 三条纪律：
//   1. **响应体里永不出现 token** —— 会话只走 Set-Cookie（HttpOnly）。前端读不到，
//      也就没有"顺手存进 localStorage"这种泄漏面。
//   2. 登录成功与失败**都写审计**。只记成功等于把暴力破解的痕迹全丢掉。
//   3. 账号不存在时也走一次同等代价的口令校验，避免用响应耗时枚举用户名。

import type { FastifyInstance } from 'fastify';
import { appendAudit } from '../../db/repo/audit.js';
import type { SessionDto } from '../dto.js';
import { createSession, destroySession, findAdmin, hashPassword, verifyPassword } from '../auth.js';
import { ApiError } from '../errors.js';
import { buildClearCookie, buildSessionCookie, clientIp, sessionCookieValue } from '../http.js';
import type { ApiContext } from '../app.js';

interface LoginBody {
  username: string;
  password: string;
}

const loginBodySchema = {
  type: 'object',
  required: ['username', 'password'],
  properties: {
    // 长度上限只是防滥用；真正的判据是 scrypt 比对
    username: { type: 'string', minLength: 1, maxLength: 64 },
    password: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const;

/**
 * 账号不存在时用来"陪跑"一次 scrypt 的占位哈希。
 * 惰性生成：模块加载时就跑一次 N=16384 的 scrypt 会平白拖慢启动。
 */
let placeholderHash: string | null = null;
function placeholderPasswordHash(): string {
  placeholderHash ??= hashPassword('placeholder-not-a-real-password');
  return placeholderHash;
}

export function registerAuthRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config, loginLimiter } = ctx;

  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    { schema: { body: loginBodySchema } },
    (req, reply) => {
      const ip = clientIp(req, config.trustProxy);
      const { username, password } = req.body;

      if (loginLimiter.check(ip) < 0) {
        appendAudit(db, {
          actor: username,
          ip,
          action: 'auth.login',
          targetType: 'session',
          result: 'fail',
          detail: 'rate_limited',
        });
        throw new ApiError('TOO_MANY_ATTEMPTS', '尝试过于频繁，请一分钟后再试', {
          limitPerMinute: 5,
        });
      }

      const admin = findAdmin(db, username);
      // 先算口令再判账号是否存在：两个分支的耗时差不出量级，响应时间就不能当用户名探针
      const matched = verifyPassword(password, admin?.password_hash ?? placeholderPasswordHash());

      if (!matched || admin === null) {
        loginLimiter.record(ip);
        appendAudit(db, {
          actor: username,
          ip,
          action: 'auth.login',
          targetType: 'session',
          result: 'fail',
          detail: 'invalid_credentials',
        });
        throw new ApiError('INVALID_CREDENTIALS', '账号或密码不正确');
      }

      // 登录成功即清空该 IP 的失败计数：已经是本人了，不该继续背着之前的次数
      loginLimiter.reset(ip);
      const { token, info } = createSession(db, admin.username, config.sessionTtlHours);
      appendAudit(db, {
        actor: admin.username,
        ip,
        action: 'auth.login',
        targetType: 'session',
        result: 'ok',
      });

      const body: SessionDto = { username: info.username, expiresAt: info.expiresAt };
      return reply
        .header(
          'set-cookie',
          buildSessionCookie(token, {
            maxAgeSeconds: config.sessionTtlHours * 3600,
            secure: config.cookieSecure,
          }),
        )
        .code(200)
        .send(body);
    },
  );

  app.post('/api/auth/logout', (_req, reply) => {
    // 能走到这里说明 onRequest 的鉴权闸门已经放行，req.auth 一定有值
    const token = sessionCookieValue(_req);
    if (token !== null) destroySession(db, token);
    appendAudit(db, {
      actor: _req.auth?.username ?? 'anonymous',
      ip: clientIp(_req, config.trustProxy),
      action: 'auth.logout',
      targetType: 'session',
      result: 'ok',
    });
    return reply
      .header('set-cookie', buildClearCookie({ secure: config.cookieSecure }))
      .code(204)
      .send();
  });

  app.get('/api/auth/session', (req) => {
    const auth = req.auth;
    if (auth === null) throw new ApiError('UNAUTHORIZED', '未登录');
    const body: SessionDto = { username: auth.username, expiresAt: auth.expiresAt };
    return body;
  });
}
