// 启动配置的唯一读取点。与 .env.example 逐项对应。
//
// 纪律：**关键配置缺失就 fail-fast**，不做"降级成不加密/不鉴权"这种兜底。
// MASTER_KEY 的长度校验交给 src/db/crypto.ts，这里只负责把它取出来。
// 端口/开关这类有合理默认值的项才允许缺省。

import { loadMasterKeyFromEnv } from './db/crypto.js';

export interface AppConfig {
  masterKey: Buffer;
  dbPath: string;
  /** 网关面（OpenAI 兼容，对外服务） */
  portGateway: number;
  hostGateway: string;
  /** 管理面（REST + WS，默认只监听回环） */
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
  /** 单次调用的最大尝试次数（含首次）；默认 3（冻结常量） */
  maxAttempts: number;
  /** 每把上游 key 的并发上限；默认 4（冻结常量） */
  maxConcurrencyPerKey: number;
  /** 失败冷却阶梯（秒），下标 = 连续失败次数 - 1；默认 1m/5m/15m/30m（冻结常量） */
  cooldownLadderSeconds: number[];
}

/** 冻结默认阶梯（与 `src/gateway/cooldown.ts` 的常量同值；这里是唯一读取 env 的地方） */
const DEFAULT_COOLDOWN_LADDER_SECONDS: readonly number[] = [60, 300, 900, 1800];

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字，实际为 ${JSON.stringify(raw)}`);
  return Math.floor(n);
}

/**
 * 正整数项（尝试次数、并发上限这类）。
 *
 * 为什么单独一个函数而不是复用 intFromEnv：`MAX_CONCURRENCY_PER_KEY=0` 不会被任何地方拦住，
 * 它会让每把 key 的并发闸门恒为"已满"，症状是「池子里有 6 把健康 key，却一把也选不出来」——
 * 一个纯粹由配置打错造成的全站 503，且不会报错。这类值必须是正数，否则启动就失败。
 */
function positiveIntFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = intFromEnv(env, name, fallback);
  if (n < 1) throw new Error(`${name} 必须 >= 1，实际为 ${JSON.stringify(env[name])}`);
  return n;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

/**
 * 冷却阶梯（秒）。逗号分隔，如 `60,300,900,1800`。
 *
 * 为什么在这里做严格校验而不是读进来直接用：阶梯是**单调升档**语义，配错不会报错，
 * 只会让某把 key 冷却成 1ms 或被长期锁死，而症状看起来像"上游挂了"。
 * 所以非空、正整数、非递减三条不满足就拒绝启动（与 MAX_CONCURRENCY_PER_KEY 同款纪律）。
 * 注意封顶仍是 `MAX_COOLDOWN_MS`：最后一档超过 30min 会被封顶，不是静默截断阶梯。
 */
function cooldownLadderFromEnv(env: NodeJS.ProcessEnv): number[] {
  const raw = env['COOLDOWN_LADDER_SECONDS'];
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_COOLDOWN_LADDER_SECONDS];

  const parts = raw.split(',').map((s) => s.trim());
  const secs = parts.map((p) => {
    const n = Number(p);
    if (p === '' || !Number.isInteger(n) || n < 1) {
      throw new Error(`COOLDOWN_LADDER_SECONDS 必须是逗号分隔的正整数秒，实际为 ${JSON.stringify(raw)}`);
    }
    return n;
  });

  for (let i = 1; i < secs.length; i += 1) {
    const prev = secs[i - 1] ?? 0;
    const cur = secs[i] ?? 0;
    if (cur < prev) {
      throw new Error(`COOLDOWN_LADDER_SECONDS 必须非递减（阶梯是升档语义），实际为 ${JSON.stringify(raw)}`);
    }
  }
  return secs;
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
    // 网关面默认对外（0.0.0.0）：它是给客户端用的；管理面默认只听回环（见下），别搞反。
    portGateway: intFromEnv(env, 'PORT_GATEWAY', 4000),
    hostGateway: env['HOST_GATEWAY'] ?? '0.0.0.0',
    portAdmin: intFromEnv(env, 'PORT_ADMIN', 4001),
    hostAdmin: env['HOST_ADMIN'] ?? '127.0.0.1',
    sessionTtlHours: intFromEnv(env, 'SESSION_TTL_HOURS', 24),
    cookieSecure: boolFromEnv(env, 'COOKIE_SECURE', false),
    trustProxy: boolFromEnv(env, 'TRUST_PROXY', false),
    allowedOrigins: origins,
    adminToken: adminToken === '' ? null : adminToken,
    logRetentionDays: intFromEnv(env, 'LOG_RETENTION_DAYS', 30),
    maxAttempts: positiveIntFromEnv(env, 'MAX_ATTEMPTS', 3),
    maxConcurrencyPerKey: positiveIntFromEnv(env, 'MAX_CONCURRENCY_PER_KEY', 4),
    cooldownLadderSeconds: cooldownLadderFromEnv(env),
  };
}
