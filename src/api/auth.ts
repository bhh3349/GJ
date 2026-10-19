// 管理面鉴权：口令校验、会话、登录限速。契约 §1 / ADR-0002。
//
// 三条硬性设计：
//   1. **口令用 scrypt**（node:crypto 内置）。首选是 Argon2id，但那要引原生依赖，
//      在一个"宁可少依赖"的仓里不划算；scrypt 同样是内存硬函数，
//      且有 node 内置实现，不会因为环境缺预编译包而装不上。
//      hash 串自带算法与参数，将来换算法可以按行迁移。
//   2. **会话 token 只存 sha256 摘要**。库被读走（备份、误提交）也拿不到可用会话。
//   3. **响应体里永不出现 token**，只有 Set-Cookie（HttpOnly）。前端 JS 读不到，
//      也就没有"存在 localStorage"这种泄漏面。
//
// 登录限速用进程内滑动窗口：单管理员单实例，够用且零依赖。
// 多实例部署时需要换成共享存储 —— 这一点记在 ADR-0002 的待办里。

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { sha256Hex } from '../db/crypto.js';
import type { Db } from '../db/database.js';
import { newSessionToken } from '../db/ids.js';
import { createGroup, findGroupByName } from '../db/repo/groups.js';
import { findUser, setUserGroup } from '../db/repo/users.js';
import { isoAfterHours, nowIso } from '../util/time.js';
import { ApiError } from './errors.js';

// --- 口令 ---------------------------------------------------------------

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), derived.toString('base64')].join('$');
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !saltB64 || !hashB64) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }
  const derived = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: n, r, p });
  // 定长比较：避免用比较耗时泄漏"前几位对了"
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface AdminUserRow {
  username: string;
  password_hash: string;
}

export function findAdmin(db: Db, username: string): AdminUserRow | null {
  return (
    (db.prepare('SELECT username, password_hash FROM admin_users WHERE username = ?').get(username) as
      | AdminUserRow
      | undefined) ?? null
  );
}

export function adminCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM admin_users').get() as { n: number }).n;
}

/**
 * 首次启动引导。库空且没有 ADMIN_PASSWORD 时**拒绝启动**。
 *
 * 不采用"随机生成并打印到日志"的常见做法：日志常常被收集、转发、留存，
 * 把管理员口令打进标准输出，等于把它复制到一个生命周期完全不可控的地方。
 * 与 MASTER_KEY 的处理保持一致 —— 缺关键配置就 fail-fast。
 *
 * **返回值是数据、不是副作用**（v1.15.6 / ADR-0035 决策 1）：种子组那件事要
 * 往标准输出打一行明文 key，而这个函数有 13 处直接调用（全是 spec）。把 I/O
 * 放进来意味着**每次跑测试都印一行 key** —— 噪音还是小事，真问题是
 * "谁负责把凭据送到人眼前"从一个决定变成十三条路径。所以这里只**返回**种子结果，
 * 由 `server.ts` 那一个真实调用点决定怎么呈现（`src/api/auth.ts` 保持零 I/O）。
 */
export interface BootstrapResult {
  /** 本次是否真的造了管理员（`false` = 库里本来就有账号，整段是 no-op）。 */
  created: boolean;
  /**
   * 首个管理员归属的「管理组」。库空且成功引导时恒非空 —— 管理员必须有一把能打
   * `/v1/*` 的 key，否则这个网关对他就是一个"看得见、进不去"的东西。
   */
  adminGroup?: { id: string; name: string };
  /** 建组时自动签发的那把网关 key 的**明文**。只在这一次返回值里存在，库内只有 sha256。 */
  adminGatewayKey?: string;
}

/** 种子组的名字。**只此一处字面量** —— 用户可见文案与日志都从这里取。 */
export const BOOTSTRAP_ADMIN_GROUP_NAME = '管理组';

export function bootstrapAdmin(db: Db, env: NodeJS.ProcessEnv = process.env): BootstrapResult {
  if (adminCount(db) > 0) return { created: false };
  const username = env['ADMIN_USERNAME'] ?? 'admin';
  const password = env['ADMIN_PASSWORD'];
  if (password === undefined || password.length < 8) {
    throw new Error(
      '首次启动需要 ADMIN_PASSWORD（至少 8 位）以创建管理员账号；创建后可移除该变量。',
    );
  }
  const at = nowIso();
  db.prepare(
    'INSERT INTO admin_users (username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run(username, hashPassword(password), at, at);

  /*
    种子「管理组」并把首个管理员放进它（ADR-0035 决策 1）。

    **为什么必须在这里、在 `adminCount === 0` 这个分支里**：这是"库是新的"的
    唯一判据。放进 `migrate()` 会让每一个 harness 都长出一个组，而
    `openDatabase` → `migrate()` 是所有用例的公共前置 —— 既有用例里有按
    **全局计数**断言的（`console.spec.ts` 那条 `COUNT(*) FROM gateway_keys` 恒等于 1），
    种子进去就等于悄悄改了几十条用例的前置条件，红的会是它们，而它们测的不是这件事。

    **老库不走这里**（上面的 early return）：不替用户做"给你补一个组"这个配额决策。
    老库管理员要组，走 `PATCH /api/users/:username`（可见、有审计）。
  */
  const existing = findGroupByName(db, BOOTSTRAP_ADMIN_GROUP_NAME);
  if (existing !== null) {
    // **复用分支不签发第二把 key**：新 key 是一份新的可用凭据，而没有人要求过它。
    // （只在"老库有同名组、账号却又全被删空"这种边角走到。）
    setUserGroup(db, username, existing.id);
    return { created: true, adminGroup: { id: existing.id, name: existing.name } };
  }

  const created = createGroup(db, { name: BOOTSTRAP_ADMIN_GROUP_NAME });
  setUserGroup(db, username, created.group.id);
  return {
    created: true,
    adminGroup: { id: created.group.id, name: created.group.name },
    adminGatewayKey: created.gatewayKey.gatewayKey,
  };
}

// --- 登录限速 -----------------------------------------------------------

export const LOGIN_RATE_LIMIT_PER_MIN = 5;

export class LoginRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number = LOGIN_RATE_LIMIT_PER_MIN) {}

  /** 返回剩余可尝试次数；已超限返回 -1。 */
  check(ip: string, nowMs: number = Date.now()): number {
    const windowStart = nowMs - 60_000;
    const recent = (this.hits.get(ip) ?? []).filter((t) => t > windowStart);
    this.hits.set(ip, recent);
    if (recent.length >= this.limit) return -1;
    return this.limit - recent.length;
  }

  record(ip: string, nowMs: number = Date.now()): void {
    const recent = this.hits.get(ip) ?? [];
    recent.push(nowMs);
    this.hits.set(ip, recent);
  }

  /** 登录成功后清空：成功说明是本人，不该继续背负之前的失败计数。 */
  reset(ip: string): void {
    this.hits.delete(ip);
  }

  /** 周期性清理，避免被大量不同 IP 撑爆内存。 */
  prune(nowMs: number = Date.now()): void {
    const windowStart = nowMs - 60_000;
    for (const [ip, times] of this.hits) {
      const recent = times.filter((t) => t > windowStart);
      if (recent.length === 0) this.hits.delete(ip);
      else this.hits.set(ip, recent);
    }
  }
}

// --- 会话 ---------------------------------------------------------------

export interface SessionInfo {
  username: string;
  expiresAt: string;
  /**
   * 身份（v1.15.0 / §19 / ADR-0034）。**每次鉴权从 `admin_users` 现读**，
   * 不存进 `sessions` —— 存了就有"管理员改了角色、旧会话还是老角色"的窗口，
   * 而现读只是一次主键点查（`username` 是 PRIMARY KEY）。
   */
  role: 'admin' | 'user';
  /** 归属组（§19.2）。`null` = 未分配 */
  groupId: string | null;
}

export function createSession(db: Db, username: string, ttlHours: number): { token: string; info: SessionInfo } {
  const token = newSessionToken();
  const at = nowIso();
  const expiresAt = isoAfterHours(ttlHours);
  db.prepare(
    `INSERT INTO sessions (id, token_hash, username, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(token.slice(0, 12), sha256Hex(token), username, at, at, expiresAt);
  return { token, info: sessionInfoOf(db, username, expiresAt) };
}

/**
 * 把 username + expiresAt 补成完整的 SessionInfo。
 *
 * 单独抽出来是因为有三个调用方（createSession / touchSession / requireSession 的
 * 机器令牌腿以外的路径），而它们必须拿到**同一种形状** —— 漏一处的失败形状是
 * "某个路径上 req.auth.role 是 undefined"，而 `undefined === 'admin'` 为假，
 * 于是管理员在**那一条路径**上被当成普通用户挡下。这类 bug 不会让任何测试红，
 * 除非有一条用例专门打那条路径。
 */
function sessionInfoOf(db: Db, username: string, expiresAt: string): SessionInfo {
  const user = findUser(db, username);
  // 库里没有这个人（刚被删、或引导前的瞬态）—— 当成未登录，而不是塞一个 admin 进去。
  // 塞 admin 是一个"默认放行"的失败形状，而那正是授面要防的东西。
  if (user === null) throw new ApiError('UNAUTHORIZED', '未登录');
  return { username, expiresAt, role: user.role === 'admin' ? 'admin' : 'user', groupId: user.group_id };
}

/**
 * 校验并**滑动续期**（契约 §1）。
 * 过期的会话直接删掉，不留在表里等着被扫 —— 一张只增不减的会话表，
 * 迟早会有人图省事给它加个"全部信任"的清理策略。
 */
export function touchSession(db: Db, token: string, ttlHours: number): SessionInfo | null {
  const hash = sha256Hex(token);
  const row = db
    .prepare('SELECT username, expires_at FROM sessions WHERE token_hash = ?')
    .get(hash) as { username: string; expires_at: string } | undefined;
  if (!row) return null;

  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
    return null;
  }

  const expiresAt = isoAfterHours(ttlHours);
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(
    nowIso(),
    expiresAt,
    hash,
  );
  // 用户可能在这一瞬间被删掉（并发删除）。那时不该放行 —— 见 sessionInfoOf 的注释。
  const user = findUser(db, row.username);
  if (user === null) return null;
  return { username: row.username, expiresAt, role: user.role === 'admin' ? 'admin' : 'user', groupId: user.group_id };
}

export function destroySession(db: Db, token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
}

export function purgeExpiredSessions(db: Db, nowMs: number = Date.now()): number {
  return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(new Date(nowMs).toISOString()).changes;
}

/** 会话失效时抛 401 SESSION_EXPIRED（前端据此跳登录，与"从未登录"区分开）。 */
export function requireSession(db: Db, token: string | null, ttlHours: number): SessionInfo {
  if (token === null) throw new ApiError('UNAUTHORIZED', '未登录');
  const info = touchSession(db, token, ttlHours);
  if (!info) throw new ApiError('SESSION_EXPIRED', '会话已过期，请重新登录');
  return info;
}

/**
 * 只读的会话存活判定，**不续期**。
 *
 * 给 WS 长连接用：那条连接已经建立，会话失效时不能抛 401（HTTP 响应早发完了），
 * 只能主动关连接 —— 而每秒都 `touchSession` 会在长时间挂着的仪表盘上
 * 每秒写一次库，把"滑动续期"变成一条常驻写路径。所以改成只读、低频复查。
 */
export function sessionAlive(db: Db, token: string): boolean {
  const row = db
    .prepare('SELECT expires_at FROM sessions WHERE token_hash = ?')
    .get(sha256Hex(token)) as { expires_at: string } | undefined;
  return row !== undefined && Date.parse(row.expires_at) > Date.now();
}
