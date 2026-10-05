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
 */
export function bootstrapAdmin(db: Db, env: NodeJS.ProcessEnv = process.env): void {
  if (adminCount(db) > 0) return;
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
}

export function createSession(db: Db, username: string, ttlHours: number): { token: string; info: SessionInfo } {
  const token = newSessionToken();
  const at = nowIso();
  const expiresAt = isoAfterHours(ttlHours);
  db.prepare(
    `INSERT INTO sessions (id, token_hash, username, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(token.slice(0, 12), sha256Hex(token), username, at, at, expiresAt);
  return { token, info: { username, expiresAt } };
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
  return { username: row.username, expiresAt };
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
