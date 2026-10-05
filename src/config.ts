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
  /**
   * 失败冷却阶梯（秒），下标 = 连续失败次数 - 1。
   * 默认 = 冻结阶梯 0/1m/5m/15m/30m（首档 0，即首次失败只吃该 reason 的基础冷却）
   */
  cooldownLadderSeconds: number[];
}

/**
 * 冻结默认阶梯（秒）：0 / 1m / 5m / 15m / 30m。
 *
 * 与 `src/gateway/cooldown.ts` 的 `DEFAULT_COOLDOWN_LADDER_MS` **逐项同值**（乘 1000 后）。
 * 这条等价关系是硬约束，不是巧合：env 未设时 `runtime.ts` 仍会把本值灌进 `PoolOptions`，
 * 于是"默认路径"完全绕开内核常量 —— 两边一旦漂移，真实进程用的就是另一个阶梯，
 * 而门禁全绿也看不出来。`config.spec.ts` 里有一例回归专门钉死这个等式。
 *
 * 首档必须是 0，别"修"成 60：冻结语义是 n=1 → 用 reason 基础冷却
 * （NETWORK 15s / UPSTREAM_ERROR 10s / RATE_LIMITED 60s），
 * 首档给 60 会让一次失败的 key 被停 60s 而不是 15s。
 */
const DEFAULT_COOLDOWN_LADDER_SECONDS: readonly number[] = [0, 60, 300, 900, 1800];

/**
 * 「十进制整数字面量」两张网，只认 0-9（可带一个前导负号）。
 *
 * 为什么不直接 `Number(raw)`：`Number` 的接受面比"配置项"该有的宽得多，
 * 且**全部静默**——`0x10`=16、`1e3`=1000、`30.9` 被 `Math.floor` 成 30、
 * `-0` 满足 `n < 0` 为假。这类值读进来不会报错，只会让端口/保留天数/冷却档位
 * 变成另一个数，症状看起来像"代码有 bug"。所以入口只放十进制字面量过，
 * 其余一律 fail-fast（与 MASTER_KEY 缺失即拒绝启动同款纪律）。
 * 注意 `Number('abc')`=NaN、`Number('1_000')`=NaN 本来就会被有限性检查拦下，
 * 这里收的是那些"能算出数、但显然不是配置本意"的形状。
 */
const DECIMAL_INT_RE = /^-?\d+$/;
/** 非负变体（冷却阶梯按定义不允许负数，连 `-0` 也不放行）。 */
const DECIMAL_UINT_RE = /^\d+$/;

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  if (!DECIMAL_INT_RE.test(text)) {
    throw new Error(`${name} 必须是十进制整数（不接受 0x/科学计数/小数），实际为 ${JSON.stringify(raw)}`);
  }
  const n = Number(text);
  // 位数多到溢出成 Infinity 的照样拦下；其余情况正则已保证是整数，不需要 Math.floor
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是十进制整数，实际为 ${JSON.stringify(raw)}`);
  return n;
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
 * 冷却阶梯（秒）。逗号分隔，如 `0,60,300,900,1800`。
 *
 * 为什么在这里做严格校验而不是读进来直接用：阶梯是**单调升档**语义，配错不会报错，
 * 只会让某把 key 冷却成 1ms 或被长期锁死，而症状看起来像"上游挂了"。
 * 所以非空、非负整数、非递减三条不满足就拒绝启动（与 MAX_CONCURRENCY_PER_KEY 同款纪律）。
 *
 * **首档允许 0**，这一条是有来历的：冻结阶梯的首档就是 0（首次失败 = 只吃 reason 基础冷却）。
 * 早先要求"正整数"时，默认值只能编成 `60,300,900,1800`，整条阶梯相对冻结值上移一档、
 * 丢掉首档 0，一次失败的 NETWORK key 被停 60s 而不是 15s —— 门禁绿着，谁也没发现。
 * 别再把 0 判成非法；同时 0 只在首档有意义，`60,0` 这种递减仍照旧拒绝。
 * 注意封顶仍是 `MAX_COOLDOWN_MS`：最后一档超过 30min 会被封顶，不是静默截断阶梯。
 */
function cooldownLadderFromEnv(env: NodeJS.ProcessEnv): number[] {
  const raw = env['COOLDOWN_LADDER_SECONDS'];
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_COOLDOWN_LADDER_SECONDS];

  const parts = raw.split(',').map((s) => s.trim());
  const secs = parts.map((p) => {
    // 同样只认十进制字面量：`0x10`/`1e3`/`60.0` 用 Number 都能算出合法的非负整数，
    // 于是"配错"被静默吞成"另一个档位"——正是上面那段注释说的那类故障。
    const n = Number(p);
    if (!DECIMAL_UINT_RE.test(p) || !Number.isInteger(n)) {
      throw new Error(`COOLDOWN_LADDER_SECONDS 必须是逗号分隔的非负整数秒（十进制字面量，不接受 0x/科学计数/小数），实际为 ${JSON.stringify(raw)}`);
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
