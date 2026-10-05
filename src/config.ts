// 启动配置的唯一读取点。与 .env.example 逐项对应。
//
// 纪律：**关键配置缺失就 fail-fast**，不做"降级成不加密/不鉴权"这种兜底。
// MASTER_KEY 的长度校验交给 src/db/crypto.ts，这里只负责把它取出来。
// 端口/开关这类有合理默认值的项才允许缺省。

import { loadMasterKeyFromEnv } from './db/crypto.js';

export interface AppConfig {
  masterKey: Buffer;
  dbPath: string;
  portAdmin: number;
  hostAdmin: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  /** 空数组 = 仅同源 */
  allowedOrigins: string[];
  /** CI 机器令牌；为空表示关闭（契约 §0.5） */
  adminToken: string | null;
  logRetentionDays: number;
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字，实际为 ${JSON.stringify(raw)}`);
  return Math.floor(n);
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const origins = (env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  const adminToken = (env['ADMIN_TOKEN'] ?? '').trim();

  return {
    // 缺 MASTER_KEY 或长度不对会在这里抛 CryptoConfigError，进程起不来 —— 这是有意的
    masterKey: loadMasterKeyFromEnv(env),
    dbPath: env['DB_PATH'] ?? './data/gateway.db',
    portAdmin: intFromEnv(env, 'PORT_ADMIN', 4001),
    hostAdmin: env['HOST_ADMIN'] ?? '127.0.0.1',
    sessionTtlHours: intFromEnv(env, 'SESSION_TTL_HOURS', 24),
    cookieSecure: boolFromEnv(env, 'COOKIE_SECURE', false),
    trustProxy: boolFromEnv(env, 'TRUST_PROXY', false),
    allowedOrigins: origins,
    adminToken: adminToken === '' ? null : adminToken,
    logRetentionDays: intFromEnv(env, 'LOG_RETENTION_DAYS', 30),
  };
}
