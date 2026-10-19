// 鉴权路由。契约 §1。
//
// 三条纪律：
//   1. **响应体里永不出现 token** —— 会话只走 Set-Cookie（HttpOnly）。前端读不到，
//      也就没有"顺手存进 localStorage"这种泄漏面。
//   2. 登录成功与失败**都写审计**。只记成功等于把暴力破解的痕迹全丢掉。
//   3. 账号不存在时也走一次同等代价的口令校验，避免用响应耗时枚举用户名。
//
// v1.15.9 / ADR-0038 追加第四条：
//   4. **`POST /api/auth/password` 改自己的口令**（消费面与管理员面共用同一条路径，
//      因为它改的是**会话本人**那一行，与角色无关）。三条子纪律：
//      · 必须**验旧口令**（只判"已登录"是不够的：一条被偷走的会话就能改掉口令，
//        把真正的主人锁在门外）；
//      · **旧口令错也写审计**（同第 2 条：不记失败等于把爆破痕迹丢掉），
//        且共用 `loginLimiter` —— 否则改密端点就是一条**不受限速**的口令猜测通道，
//        而它猜的目标比登录页更值钱（猜到即可永久接管）；
//      · 成功后**踢掉该账号的其他会话**（同一句 `DELETE FROM sessions WHERE username = ?`
//        减去当前 token）。改口令的语义就是"我怀疑别人有我的凭据"，
//        只改散列而不撤会话等于什么都没做。

import type { FastifyInstance } from 'fastify';
import { appendAudit } from '../../db/repo/audit.js';
import type { SessionDto } from '../dto.js';
import { createSession, destroySession, findAdmin, hashPassword, verifyPassword } from '../auth.js';
import { sha256Hex } from '../../db/crypto.js';
import { ApiError } from '../errors.js';
import { buildClearCookie, buildSessionCookie, clientIp, sessionCookieValue } from '../http.js';
import type { ApiContext } from '../app.js';

interface LoginBody {
  username: string;
  password: string;
}

interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

/**
 * 口令下限与建号（§19.7 `createUserBodySchema`）**同一个数字**。
 * 两处各写一遍的失败形状不是"将来要改两个地方"，而是**新口令可以比建号时更弱**：
 * 建号要 8 位、改密只要 1 位，于是绕开下限的路径就是"先建一个弱口令账号再改"。
 */
const PASSWORD_MIN_LENGTH = 8;

const changePasswordBodySchema = {
  type: 'object',
  required: ['currentPassword', 'newPassword'],
  properties: {
    currentPassword: { type: 'string', minLength: 1, maxLength: 512 },
    newPassword: { type: 'string', minLength: PASSWORD_MIN_LENGTH, maxLength: 512 },
  },
} as const;

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

      const body: SessionDto = {
        username: info.username,
        // §19.8：登录那一刻就要决定跳 `/admin` 还是 `/console`，多一次往返只让
        // "跳错地方"多一个时序窗口。role 是用户自己的属性，回给它不扩大暴露面。
        role: info.role,
        expiresAt: info.expiresAt,
      };
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
    // 与登录响应同一形状（§19.8）。刷新页面时前端也靠它决定渲染哪个工作区 ——
    // 两个端点给同一个字段、同一个口径，才不会出现"登录时说是 user、刷新后当 admin 渲染"。
    const body: SessionDto = {
      username: auth.username,
      role: auth.role,
      expiresAt: auth.expiresAt,
    };
    return body;
  });

  /**
   * 改自己的口令（v1.15.9 / ADR-0038 决策 3）。
   *
   * **没有 `:username` 路径参数**：改的恒是会话本人。带路径参数就得判"你能不能改别人的"，
   * 而那个问题的答案在这一版里是"不存在这个能力" —— 少一个参数就是少一类越权面
   * （§19.7 那条"前端不做那个表单是因为没有那个端点"的同一条纪律）。
   *
   * **改完当前会话留着、其他会话踢掉**。顺序与理由：
   *   1. 先验旧口令（`verifyPassword`，与登录同一个函数，不复刻算法）；
   *   2. 写新散列 + 删掉**除本会话外**的全部会话，**同一个事务**；
   *   3. 审计。
   * 不删当前会话是因为"我改了密码，然后我自己被踢出去、得马上再登一次"是一件
   * 纯粹多余的事；而其他会话必须死 —— 那正是这次改密的动机。
   * 用 `username` 而不是"登录时间"来判会话，因为同一账号在不同机器上的会话
   * 之间没有任何可比较的先后（`last_seen_at` 是最后一次请求，不是创建时刻）。
   */
  app.post<{ Body: ChangePasswordBody }>(
    '/api/auth/password',
    { schema: { body: changePasswordBodySchema } },
    (req, reply) => {
      const auth = req.auth;
      if (auth === null) throw new ApiError('UNAUTHORIZED', '未登录');
      const ip = clientIp(req, config.trustProxy);
      const { currentPassword, newPassword } = req.body;

      // 限速与登录**共用同一个闸**（契约 §1 的 5 次/分钟）。不共用的话这条端点就是
      // 一条不受限速的口令猜测通道 —— 而它猜中的收益比登录页更高：登录进去还得找到
      // 别的东西，改密猜中了直接接管这个账号（新口令一写，真正的主人再也进不来）。
      if (loginLimiter.check(ip) < 0) {
        appendAudit(db, {
          actor: auth.username,
          ip,
          action: 'auth.password',
          targetType: 'session',
          result: 'fail',
          detail: 'rate_limited',
        });
        throw new ApiError('TOO_MANY_ATTEMPTS', '尝试过于频繁，请一分钟后再试', {
          limitPerMinute: 5,
        });
      }

      const me = findAdmin(db, auth.username);
      // 会话有效但账号行没了（管理员在别处删了他）：与 §1 `sessionInfoOf` 同一条
      // 判据 —— 这里回 401 而不是 500，前端据此跳登录页。
      if (me === null) throw new ApiError('UNAUTHORIZED', '账号不存在');

      if (!verifyPassword(currentPassword, me.password_hash)) {
        loginLimiter.record(ip);
        // 失败**也要写审计**（同登录那条：不记失败等于把爆破痕迹全丢掉）。
        // `detail` 只说"旧口令不对" —— 不回显任何口令、散列或用户输入。
        appendAudit(db, {
          actor: auth.username,
          ip,
          action: 'auth.password',
          targetType: 'session',
          result: 'fail',
          detail: 'invalid_current_password',
        });
        throw new ApiError('INVALID_CREDENTIALS', '当前密码不正确');
      }

      // 新口令与旧口令相同：拒绝。不拦的话"改密成功"可能什么都没变（散列重算一遍、
      // 其他会话被踢，而口令还是那一串），用户以为自己换了。
      if (newPassword === currentPassword) {
        loginLimiter.record(ip);
        appendAudit(db, {
          actor: auth.username,
          ip,
          action: 'auth.password',
          targetType: 'session',
          result: 'fail',
          detail: 'same_as_current',
        });
        throw new ApiError('INVALID_PARAM', '新密码不能与当前密码相同', { field: 'newPassword' });
      }

      loginLimiter.reset(ip);
      // 当前会话的 token_hash：**在事务外**取一次（`sessionCookieValue` 读的是请求头，
      // 与库无关），事务里用同一个值两次（一次删、一次保）。
      const token = sessionCookieValue(req);
      const keepHash = token === null ? null : sha256Hex(token);
      db.transaction(() => {
        db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE username = ?').run(
          hashPassword(newPassword),
          new Date().toISOString(),
          auth.username,
        );
        // 踢掉该账号的**其他**会话。`keepHash === null`（理论上不可能走到 ——
        // 能到这里说明闸门验过会话、而它是从 cookie 里读的）时退化成"全踢"，
        // 那是安全的失败方向：宁可让本人重登一次，也不要留下一条可能被别人持有的会话。
        if (keepHash === null) {
          db.prepare('DELETE FROM sessions WHERE username = ?').run(auth.username);
        } else {
          db.prepare('DELETE FROM sessions WHERE username = ? AND token_hash != ?').run(
            auth.username,
            keepHash,
          );
        }
      })();

      // `detail` 只记"别的会话被撤了几条" —— 那正是"改密之后还有谁在线"这个问题的答案。
      // 不记口令、不记散列、不记旧口令（同 §1）。
      appendAudit(db, {
        actor: auth.username,
        ip,
        action: 'auth.password',
        targetType: 'session',
        result: 'ok',
        detail: 'other_sessions_revoked',
      });
      return reply.code(204).send();
    },
  );
}
