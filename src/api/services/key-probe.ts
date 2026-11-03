// key 探活（契约 §3 v1.24.0 / ADR-0049）—— 「试调一次」按钮的后端。
//
// 业主诉求：新发一把 key，点一下就知道它**现在**能不能用。探活回答的正是这句话；
// 「它有没有被用过、第一次是什么时候」是 `firstUsedAt`（v1.23.0 / ADR-0048）的事。
//
// 计量隔离四条（与 `model-probe.ts` 逐字同源，改代码前先读）：
//   1. **零 reportFailure / reportSuccess** —— 探活不进网关引擎、不碰 `KeyRuntimeState`。
//      尤其是 `reportSuccess` 会清 `autoDisabled`：一次手点把「401 风暴里被自动停用的 key」
//      探活复活，等于管理员亲手放回一把死 key。探活 = 纯观测，健康态只由数据面写。
//   2. **零 usage_logs** —— 这不是客户流量，写进去会污染 QPS / 成功率 / 成本账。
//   3. 出站必走调用方注入的 `fetchImpl`（装配层已包成 `fetchFor(egressId,'management')`），
//      **禁止裸 fetch** —— 旁路 = 在 IP 预算上再开一个洞。
//   4. 计量随动作走：只进本响应 + 审计 `key.probe`（detail 只放结论与计数，
//      **零 key 明文、零上游 body 原文**，路由层负责）。
//
// 与「能力探测」的区别：能力探测测的是**模型**，凭据用共享选择器轮换（401 换下一把）；
// 探活测的正是**这一把**，401 就是结论，绝不换把（ADR-0049 决策 2）。

import type { Db } from '../../db/database.js';
import { decryptedKeyRefs, getKeyRow } from '../../db/repo/keys.js';
import { getUpstreamRow } from '../../db/repo/upstreams.js';
import { parseModelLimits } from '../../db/model-limits.js';
import { sanitizeUpstreamBody } from '../../balance/raw.js';
import { ApiError } from '../errors.js';
import { nowIso } from '../../util/time.js';

import { chatCompletionsEndpoint } from './model-probe.js';
import { modelsEndpoint } from './model-sync.js';

/** 单发探活超时（路由者定的量级：10–15s；120s 数据面默认对一次手点太长）。 */
const PROBE_TIMEOUT_MS = 12_000;

/** 同一把 key 两次探活的最小间隔（6 次/分钟）。 */
const MIN_INTERVAL_MS = 10_000;

/** 全局并发上限：探活是管理员手点，2 路封顶防手抖连点打爆上游。 */
const MAX_CONCURRENT = 2;

/** 上游错误文案出口前的截断长度（已过 sanitize，明文不会在，但仍不把上游日志搬进来）。 */
const MAX_MESSAGE_CHARS = 512;

export type KeyProbeCode =
  | 'UPSTREAM_UNREACHABLE'
  | 'TIMEOUT'
  | 'AUTH_REJECTED'
  | 'MODEL_REJECTED'
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'EMPTY_RESPONSE';

export interface KeyProbeResult {
  ok: boolean;
  keyId: string;
  maskedKey: string;
  /** `"chat"` = 真打一次 max_tokens=1；`"models"` = 无可用模型时退化为探 /v1/models（零 token）。 */
  kind: 'chat' | 'models';
  /** kind=chat 时是本次用的模型；kind=models 时恒 null。 */
  model: string | null;
  endpoint: string;
  httpStatus: number | null;
  durationMs: number;
  /** null = ok。业务失败也回 200（与 BalanceTestResult 同口径：诊断不该被错误分支吃掉）。 */
  probeCode: KeyProbeCode | null;
  /** 上游 error.code，已过 sanitizeUpstreamBody 再截断 64 字符（零明文红线，与 message 同一切法）；null = 上游没给或没走到上游。 */
  upstreamErrorCode: string | null;
  /** 上游错误文案，已过 sanitizeUpstreamBody 并截断；null = 没有可回显的文案。 */
  upstreamMessage: string | null;
  checkedAt: string;
}

/* --------------------------- 频控与并发（进程内） --------------------------- */

const lastProbeAt = new Map<string, number>();
let active = 0;
const waiters: Array<() => void> = [];

/** 距下次可探的毫秒数（0 = 现在就能探）。给路由层把 `Retry-After` 算准。 */
export function probeCooldownMs(keyId: string): number {
  const last = lastProbeAt.get(keyId);
  if (last === undefined) return 0;
  return Math.max(0, last + MIN_INTERVAL_MS - Date.now());
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  }
}

/* ------------------------------ 响应解析 ------------------------------ */

interface Envelope {
  /** 200 + `success:false` 的上游信封（TierFlow 等）——数据面把它当 fail，探活同口径（§16.2）。 */
  success?: unknown;
  code?: unknown;
  error?: unknown;
  choices?: unknown;
  data?: unknown;
  message?: unknown;
}

function asEnvelope(value: unknown): Envelope | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Envelope)
    : null;
}

/** 从信封里抠 (code, message)：OpenAI 形 `{error:{code,message}}` 与平铺 `{code,message}` 都认。 */
function errorParts(env: Envelope): { code: string | null; message: string | null } {
  const err = asEnvelope(env.error);
  const code = pickShort(err?.['code'] ?? env['code']);
  const message = pickShort(err?.['message'] ?? env['message']);
  return { code, message };
}

function pickShort(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.length > 64 ? `${value.slice(0, 64)}…` : value;
}

function truncate(s: string): string {
  return s.length > MAX_MESSAGE_CHARS ? `${s.slice(0, MAX_MESSAGE_CHARS)}…` : s;
}

function fail(
  base: Omit<KeyProbeResult, 'ok' | 'probeCode' | 'upstreamErrorCode' | 'upstreamMessage'>,
  probeCode: KeyProbeCode,
  upstreamErrorCode: string | null,
  upstreamMessage: string | null,
): KeyProbeResult {
  return { ...base, ok: false, probeCode, upstreamErrorCode, upstreamMessage };
}

/* ------------------------------ 主流程 ------------------------------ */

export interface KeyProbeOptions {
  model?: string | undefined;
  timeoutMs?: number | undefined;
}

export async function probeKey(
  db: Db,
  keyId: string,
  masterKey: Buffer,
  fetchImpl: typeof fetch,
  options: KeyProbeOptions = {},
): Promise<KeyProbeResult> {
  const row = getKeyRow(db, keyId);
  if (!row || row.deleted_at !== null) throw ApiError.notFound('Key', keyId);
  const upstream = getUpstreamRow(db, row.upstream_id);
  if (upstream === null) throw ApiError.notFound('Upstream', row.upstream_id);

  const cooldown = probeCooldownMs(keyId);
  if (cooldown > 0) {
    throw new ApiError('TOO_MANY_ATTEMPTS', `同一把 key 每 ${Math.round(MIN_INTERVAL_MS / 1000)} 秒只能探活一次`, {
      retryAfterSeconds: Math.ceil(cooldown / 1000),
    });
  }

  // 明文只走 SecretsResolver 这一条路（decryptedKeyRefs），不另开解密入口（ADR-0049 决策 3）。
  const [ref] = decryptedKeyRefs(db, { keyIds: [keyId] }, masterKey);
  if (ref === undefined) {
    throw new ApiError('UNPROCESSABLE', '这把 key 的密文无法解密（MASTER_KEY 是否换过？）');
  }

  const whitelist = parseModelLimits(row.model_limits);
  let model: string | null = null;
  let kind: 'chat' | 'models' = 'chat';
  if (options.model !== undefined) {
    if (whitelist !== null && !whitelist.includes(options.model)) {
      throw ApiError.invalidParam('model', '该模型不在这把 key 的白名单里');
    }
    model = options.model;
  } else if (whitelist !== null && whitelist.length > 0) {
    // 白名单第一条 —— 显式取自 key 自己的约束，**不硬编码默认模型**：
    // 猜错模型名会把 4xx 误判成「key 不可用」（路由者复核时点的坑）。
    model = whitelist[0]!;
  } else {
    // 既没有白名单也没点名：不猜模型，退化为 /v1/models 探活（零 token，验鉴权与连通）。
    kind = 'models';
  }

  lastProbeAt.set(keyId, Date.now());
  const checkedAt = nowIso();
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? PROBE_TIMEOUT_MS, 2_000), 15_000);

  return withSlot(async () => {
    const base = {
      keyId,
      maskedKey: ref.maskedKey,
      kind,
      model,
      endpoint: kind === 'chat' ? chatCompletionsEndpoint(upstream.base_url) : modelsEndpoint(upstream.base_url),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(base.endpoint, {
        method: kind === 'chat' ? 'POST' : 'GET',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${ref.decrypted}`,
        },
        body:
          kind === 'chat'
            ? JSON.stringify({
                model,
                messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
                max_tokens: 1,
                stream: false,
              })
            : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      if (err instanceof Error && err.name === 'AbortError') {
        return fail({ ...base, httpStatus: null, durationMs, checkedAt }, 'TIMEOUT', null, null);
      }
      return fail({ ...base, httpStatus: null, durationMs, checkedAt }, 'UPSTREAM_UNREACHABLE', null, null);
    } finally {
      clearTimeout(timer);
    }
    const durationMs = Date.now() - started;

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const env = asEnvelope(body);
    const parts = env === null ? { code: null, message: null } : errorParts(env);
    // 上游回显过明文也不许出门：`message` 与 `code` 都过同一把 sanitize（以同一把 key 的明文作密钥），
    // 再各自按口径截断。零明文是红线不是概率题 —— 不赌上游会不会把凭据回显进 `error.code`（路由者复核硬化项）。
    const message =
      parts.message === null ? null : truncate(sanitizeField(parts.message, 'message', ref.decrypted));
    const errorCode = parts.code === null ? null : pickShort(sanitizeField(parts.code, 'code', ref.decrypted));

    if (res.status >= 200 && res.status < 300) {
      if (env !== null && env['success'] === false) {
        // 200 + success:false 的信封：与数据面同口径，算 fail（§16.2）。
        return fail({ ...base, httpStatus: res.status, durationMs, checkedAt }, 'UPSTREAM_ERROR', errorCode, message);
      }
      const hasPayload =
        kind === 'chat' ? Array.isArray(env?.choices) && env.choices.length > 0 : Array.isArray(env?.data);
      if (hasPayload) {
        return {
          ...base,
          ok: true,
          httpStatus: res.status,
          durationMs,
          probeCode: null,
          upstreamErrorCode: null,
          upstreamMessage: null,
          checkedAt,
        };
      }
      return fail({ ...base, httpStatus: res.status, durationMs, checkedAt }, 'EMPTY_RESPONSE', errorCode, message);
    }

    // 分类仍看原始 code（`quota` 正则只是内部判据，不出出口）；对外一律给 sanitize 过的 errorCode。
    const classified = classifyStatus(res.status, parts.code);
    return fail({ ...base, httpStatus: res.status, durationMs, checkedAt }, classified, errorCode, message);
  });
}

/**
 * 单个上游字符串字段过 sanitize：`{ [field]: raw }` → `sanitizeUpstreamBody` → 按原字段名抠回。
 * 上游偶尔把 key 明文回显在 `error.code` 里（与 message 同一条泄漏路径），原样外露 = 把明文从服务端搬到浏览器。
 */
function sanitizeField(raw: string, field: 'code' | 'message', secret: string): string {
  const out = asEnvelope(sanitizeUpstreamBody({ [field]: raw }, secret))?.[field];
  return typeof out === 'string' ? out : '';
}

function classifyStatus(status: number, upstreamCode: string | null): KeyProbeCode {
  if (status === 401 || status === 403) return 'AUTH_REJECTED';
  if (status === 402) return 'QUOTA_EXHAUSTED';
  if (status === 429) {
    // insufficient_quota 这类"额度烧干"的 429 是钱的问题，不是频率的问题（ADR-0049 判据表）。
    return upstreamCode !== null && /quota/i.test(upstreamCode) ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED';
  }
  if (status === 404 || status === 400 || status === 422) return 'MODEL_REJECTED';
  return 'UPSTREAM_ERROR';
}
