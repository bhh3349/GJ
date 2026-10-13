// 能力探测服务（契约 §5 v1.11.0 / ADR-0024）。
//
// 上游 /v1/models 只回 {id, object, created, owned_by} —— 能力那几格上游永远不给（ADR-0009）。
// 本服务给档案一个**机器来源**：拿该上游的 key 发**能力专属**请求，用**响应本身**判
// vision / stream / function_call / json_mode。不猜、不编默认值、不解析任何文案。
//
// 计量隔离四条（实现必须逐字满足，改代码前先读）：
//   1. 零 reportFailure / reportSuccess —— 探测**不进网关引擎**。4xx 是模型的性质，不是 key 的故障；
//   2. 零 usage_logs —— 不出现在 §6 的 QPS / 成功率 / token 里；
//   3. 出站必走调用方注入的 fetchImpl（装配层已包成 fetchFor(egressId,'management')，ADR-0021），
//      **禁止裸 fetch** —— 旁路 = 在 IP 预算上再开一个洞；
//   4. 计量随动作走：只进本响应 `requests` / 同步任务 `result.probe` / 审计 `model.probe`（detail 只放计数）。
//
// 凭据获取走**共享凭据选择器**（ADR-0026）：401/403 换下一把、默认试 3 把。探测判据里
// 401/403 → supported:null **依赖这个选择器先换把** —— 否则死首 key 会让探测全 null。

import type { Db } from '../../db/database.js';
import type { ModelCapability } from '../dto.js';
import { applyProbeCapabilities, getModelRow, listProbeCandidates } from '../../db/repo/models.js';
import { CREDENTIAL_ATTEMPT_BUDGET, tryWithRotation, UpstreamCredentialError } from './credential-rotation.js';
import { isHttpUrl } from '../../db/balance-query.js';
import { PROBE_PNG_DATA_URL } from './probe-image.js';
import { nowIso } from '../../util/time.js';

/** 单发探测的超时。能力探测是"问一次就走"，与模型同步同一量级。 */
const PROBE_TIMEOUT_MS = 20_000;

/** 四项能力（闭集，与 dto `ModelCapability` 同源）。 */
export const ALL_PROBE_CAPABILITIES: readonly ModelCapability[] = [
  'stream',
  'function_call',
  'vision',
  'json_mode',
];

export function isProbeCapability(v: string): v is ModelCapability {
  return (ALL_PROBE_CAPABILITIES as readonly string[]).includes(v);
}

export type ModelCapabilitySource = 'manual' | 'probe' | null;

export interface ModelProbeItem {
  capability: ModelCapability;
  supported: boolean | null;
  status: number | null;
  durationMs: number;
  /** 逐端点诊断字段（不进 ERROR_CODES）：upstream_4xx / rate_limited / auth / not_found / server_error / timeout / network / not_event_stream */
  reason: string | null;
}

export interface ModelProbeResult {
  modelId: string;
  modelName: string;
  upstreamId: string;
  probedAt: string;
  requests: number;
  items: ModelProbeItem[];
  /** 本次真写进档案的项（`apply:false` 时恒 []） */
  applied: ModelCapability[];
  /** 写后现值（`apply:false` 时也是现值，前端可直接渲染） */
  capabilities: ModelCapability[];
  capabilitiesSource: ModelCapabilitySource;
}

export interface ModelSyncProbeCounters {
  candidates: number;
  probed: number;
  applied: number;
  skipped: number;
  failed: number;
  requests: number;
}

/**
 * 组装 chat/completions 地址。与 `modelsEndpoint` 的 `/v1` 去重规则**逐字同源**：
 * baseUrl 自带 `/v1` 时不再拼一次（`/v1/v1/chat/completions` 会 404）。
 */
export function chatCompletionsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v1$/i.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/** 探测请求体：**服务端内置**（契约「2xx 的吹哨纪律」——调用方没有任何注入面）。 */
function probeRequestBody(capability: ModelCapability, modelName: string): Record<string, unknown> {
  const messages: unknown[] =
    capability === 'vision'
      ? [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What color is this square? Reply with one word.' },
              { type: 'image_url', image_url: { url: PROBE_PNG_DATA_URL } },
            ],
          },
        ]
      : [{ role: 'user', content: 'Reply with the single word: ok' }];

  const payload: Record<string, unknown> = {
    model: modelName,
    messages,
    // max_tokens 压到最小：true 的语义完全建立在「上游真的处理了这次请求」之上
    max_tokens: 16,
    stream: capability === 'stream',
  };
  if (capability === 'function_call') {
    payload['tools'] = [
      {
        type: 'function',
        function: {
          name: 'get_balance',
          description: 'Get the current balance.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ];
    payload['tool_choice'] = 'auto';
  }
  if (capability === 'json_mode') {
    payload['response_format'] = { type: 'json_object' };
  }
  return payload;
}

/**
 * 判据表分类：只看状态码与 content-type 头，不解析任何文案。
 *
 * `4xx`（除 401/403/404/429）⇒ **supported:false** —— 那是「上游明确拒绝」（契约示例：
 * function_call 400 ⇒ false + `upstream_4xx`）。把它记成 null 会丢掉三态里中间那一态，
 * 档案卡上「已探测、不支持」与「还没问过」就又是同一个读法了。
 * `null` 只留给：auth（401/403，凭据问题不是能力问题）、404、429、5xx、超时、网络。
 */
function classifyStatus(status: number): { supported: boolean | null; reason: string } {
  if (status === 429) return { supported: null, reason: 'rate_limited' };
  if (status === 401 || status === 403) return { supported: null, reason: 'auth' };
  if (status === 404) return { supported: null, reason: 'not_found' };
  if (status >= 500) return { supported: null, reason: 'server_error' };
  return { supported: false, reason: 'upstream_4xx' };
}

/**
 * 单发探测。凭据类失败（401/403）**不在这里分类** —— 直接抛 `UpstreamCredentialError`
 * 交给选择器换下一把；到不了选择器时（预算耗尽）由 `probeModel` 记 `reason:"auth"`。
 */
async function runOneProbe(
  baseUrl: string,
  modelName: string,
  capability: ModelCapability,
  credential: string,
  fetchImpl: typeof fetch,
): Promise<ModelProbeItem> {
  const url = chatCompletionsEndpoint(baseUrl);
  if (!isHttpUrl(url)) {
    // 地址本身不合法 ⇒ 按网络类记账（判不出，不是"不支持"），不把整个响应炸成 500
    return { capability, supported: null, status: null, durationMs: 0, reason: 'network' };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${credential}`,
      },
      body: JSON.stringify(probeRequestBody(capability, modelName)),
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;

    if (res.status === 401 || res.status === 403) {
      throw new UpstreamCredentialError(res.status, `上游 ${capability} 探测返回 ${res.status}`);
    }

    if (res.status >= 200 && res.status < 300) {
      if (capability === 'stream') {
        const ct = (res.headers.get('content-type') ?? '').trim().toLowerCase();
        const isEventStream = ct.startsWith('text/event-stream');
        return {
          capability,
          supported: isEventStream,
          status: res.status,
          durationMs,
          reason: isEventStream ? null : 'not_event_stream',
        };
      }
      // 其余能力：2xx = 上游把请求收下并作答了。读完即弃，不再烧 token。
      try {
        await res.arrayBuffer();
      } catch {
        /* 读不动不影响判据：状态码 2xx 已经是结论 */
      }
      return { capability, supported: true, status: res.status, durationMs, reason: null };
    }

    return { capability, ...classifyStatus(res.status), status: res.status, durationMs };
  } catch (err) {
    if (err instanceof UpstreamCredentialError) throw err; // 交给选择器换把
    const durationMs = Date.now() - started;
    if (err instanceof Error && err.name === 'AbortError') {
      return { capability, supported: null, status: null, durationMs, reason: 'timeout' };
    }
    return { capability, supported: null, status: null, durationMs, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function parseCaps(raw: string): ModelCapability[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? (parsed.filter((c): c is ModelCapability => typeof c === 'string' && isProbeCapability(c)))
      : [];
  } catch {
    return [];
  }
}

function parseSource(raw: string | null): ModelCapabilitySource {
  return raw === 'manual' || raw === 'probe' ? raw : null;
}

export interface ProbeOptions {
  targets: readonly ModelCapability[];
  apply: boolean;
  /** 每项探测的换把预算（ADR-0026）；缺省装配常量。 */
  budget?: number;
  fetchImpl: typeof fetch;
}

/**
 * 探测一个模型（契约 §5 `POST /api/models/:id/probe`）。
 *
 * - `apply:false`：**只回结果、一个字节都不写库**（`last_probed_at` 也不刷 —— 预览不留观测痕迹）。
 * - `apply:true`：判为 `true` 的项并进档案（`manual` 永不被覆盖）；`last_probed_at` 每次都刷。
 * - 凭据走共享选择器；预算耗尽 / 无 key → 该项 `supported:null, reason:"auth"`（**不判假**）。
 */
export async function probeModel(
  db: Db,
  masterKey: Buffer,
  upstream: { id: string; baseUrl: string },
  model: { id: string; name: string },
  options: ProbeOptions,
): Promise<ModelProbeResult> {
  const probedAt = nowIso();
  const items: ModelProbeItem[] = [];
  let requests = 0;

  for (const capability of options.targets) {
    try {
      const rotation = await tryWithRotation(
        db,
        upstream.id,
        masterKey,
        options.budget ?? CREDENTIAL_ATTEMPT_BUDGET,
        async (ref) => {
          try {
            return {
              outcome: 'ok' as const,
              value: await runOneProbe(upstream.baseUrl, model.name, capability, ref.decrypted, options.fetchImpl),
            };
          } catch (err) {
            // 凭据类失败（401/403）交给选择器换下一把；其余错误本函数不抛（已按 null 记账）
            if (err instanceof UpstreamCredentialError) return { outcome: 'retry' as const, error: err };
            throw err;
          }
        },
        '该上游没有已启用的 key，无法探测',
      );
      items.push(rotation.result);
      requests += rotation.attempts.tried;
    } catch {
      // 凭据类失败（预算耗尽 / 无 key）：判不出，不判假
      items.push({ capability, supported: null, status: null, durationMs: 0, reason: 'auth' });
    }
  }

  const trueCaps = items.filter((i) => i.supported === true).map((i) => i.capability);
  const applied: ModelCapability[] = [];

  if (options.apply) {
    const row = getModelRow(db, model.id);
    if (row !== null) {
      // 并上探到的 true 项。`manual` 那行由 repo 层的 CASE 守卫原样保留（规则 2），
      // 但 last_probed_at 照刷（规则 4）—— 两个规则在同一句 UPDATE 里同时满足。
      const merged = JSON.stringify([...new Set([...parseCaps(row.capabilities), ...trueCaps])]);
      // 返回值 = 「这一行可写」：manual 行返回 false（契约 §5 ③ applied 因此恒不含被 manual 挡下的项）
      if (applyProbeCapabilities(db, model.id, { capsJson: merged, probedAt })) applied.push(...trueCaps);
    }
  }

  const after = getModelRow(db, model.id);
  return {
    modelId: model.id,
    modelName: model.name,
    upstreamId: upstream.id,
    probedAt,
    requests,
    items,
    applied,
    capabilities: after === null ? [] : parseCaps(after.capabilities),
    capabilitiesSource: after === null ? null : parseSource(after.capabilities_source),
  };
}

/**
 * 同步尾部补探（契约 §5 v1.11.0 ⑤ / ADR-0024 决策 5）。
 *
 * - 候选 = 本次同步涉及的模型（调用方传 id）里 `capabilities_source IS NULL` 的那些；
 * - 单轮上限 `limit`（装配侧 `MODEL_PROBE_MAX_MODELS`，占位 10），超出留到下一轮；
 * - **出口预算拒绝（`rate_limited`）即停**本轮，剩余候选计入 `skipped`；
 * - **探测失败不改任务成败**：所有异常在这里吞掉并计 `failed`，成败判据只在列表拉取。
 */
export async function probeCandidatesAfterSync(
  db: Db,
  masterKey: Buffer,
  upstream: { id: string; baseUrl: string },
  syncedModelIds: readonly string[],
  options: { limit: number; budget?: number; fetchImpl: typeof fetch },
): Promise<ModelSyncProbeCounters> {
  const counters: ModelSyncProbeCounters = {
    candidates: 0,
    probed: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    requests: 0,
  };
  const candidates = listProbeCandidates(db, syncedModelIds, options.limit);
  counters.candidates = candidates.length;

  for (const candidate of candidates) {
    try {
      const result = await probeModel(db, masterKey, upstream, candidate, {
        targets: ALL_PROBE_CAPABILITIES,
        apply: true,
        budget: options.budget,
        fetchImpl: options.fetchImpl,
      });
      counters.probed += 1;
      counters.applied += result.applied.length;
      counters.requests += result.requests;
      if (result.items.some((i) => i.reason === 'rate_limited')) {
        // 出口预算拒绝即停：本轮的剩余候选留到下一轮（ADR-0024 ⑤）
        counters.skipped += candidates.length - counters.probed;
        break;
      }
    } catch {
      counters.failed += 1;
    }
  }
  return counters;
}
