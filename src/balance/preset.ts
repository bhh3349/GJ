// 内置余额查询 preset（契约 §2 / ADR-0012 §1–§2）。
//
// 定位：用户没配模板时**唯一**能"开箱出数"的来源。它是每次查询现算的判定，
// **永不覆盖用户模板、永不落库** —— 库里只有用户自己的 balance_query。
//
// 注册表的门槛（ADR-0012 备选方案 A2 被否的三条理由的正面形式）：
// 一个上游要进这张表，必须同时拿准三件事 —— 口径（哪个字段是"剩余"）、
// 单位（分/元/美元）、鉴权（用哪种凭据）。只有 OpenAI 官方 API 三件都确定。
// 自建的 new-api / one-api：域名不可判（自建，host 任意）、`quota` 单位随部署方
// 配置（默认 500000 quota = 1 USD，且可改）、该端点要的是用户 access token 而不是
// 转发用的 sk- 接口 key。猜错会写出一个**看起来完全合理、但整体差若干数量级**的
// 余额 —— 这比"未知"严重得多：未知会被前端标灰，错值会被当成真值展示。
// 所以其余上游一律走 skipped + 引导用户自己填，这正是 Bo「查不到再让用户提供
// 查询方法」那句指令的正面实现：猜不出来的就不猜，直接问。

import type { BalanceUnit } from '../db/balance-query.js';
import { convertToCents, getByPath, toNumber, type ParsedBalance } from './template.js';

/** 单次 preset 查询的结果。字段与 `QueryOutcome` 对齐，便于上层统一汇总。 */
export interface PresetRunResult {
  ok: boolean;
  parsed: ParsedBalance | null;
  errorCode: 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED' | null;
  message: string | null;
  /** HTTP 状态；0 = 没拿到响应（不可达 / 超时） */
  httpStatus: number;
  /** 上游响应体**原文**。调用方负责抹 key + 截断后才可外露（见 balance/raw.ts） */
  raw: unknown;
}

export interface PresetRunInput {
  /** 该上游配置的 baseUrl。preset 只从中取 origin，不拼接用户配的路径 */
  baseUrl: string;
  /** 明文 key，仅本次调用栈内存在 */
  secret: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
}

export interface BalancePresetSpec {
  id: string;
  label: string;
  /** 精确匹配的 host（含端口）。命中任一即算命中本 preset */
  hosts: readonly string[];
  /** 主端点路径。仅用于诊断展示（`协议//host/path`），执行时的真实 URL 由 run() 自建 */
  primaryPath: string;
  /** 本 preset 换算后落到"分"的上游单位。仅用于诊断回显 */
  unit: BalanceUnit;
  run(input: PresetRunInput): Promise<PresetRunResult>;
}

/* ------------------------------ OpenAI ------------------------------ */

const OPENAI_HOSTS = ['api.openai.com'] as const;
const SUBSCRIPTION_PATH = '/v1/dashboard/billing/subscription';
const USAGE_PATH = '/v1/dashboard/billing/usage';

/**
 * 用量查询的日期窗口。
 *
 * 该端点要求显式给区间，官方对区间长度有上限（100 天），所以取 99 天留一天余量。
 * 已知局限：这样得到的"已用"是**窗口内**的用量，账户若有窗口之前的消费就会
 * 被漏掉，余额偏大。ADR-0012 已把"preset 只覆盖 OpenAI 且口径以官方算法为准"
 * 记在案；要更准需要官方给出账期起点，届时走 ADR 补遗。
 */
const USAGE_WINDOW_DAYS = 99;

/**
 * 失败的种类。分它不是为了措辞好看，是因为它决定 `errorCode`、进而决定给用户的引导：
 * `parse` 是"配置/端点变了，改配置"，`http`/`network` 才是"上游的事，稍后重试"。
 * 归错档会让用户对着一个根本没坏的网络查半天（或反过来，对着一个错的端点干等）。
 */
type HttpFailureKind = 'http' | 'parse' | 'network';

interface HttpJson {
  ok: boolean;
  status: number;
  body: unknown;
  /** 面向用户的失败原因。**不含** URL 与任何凭据 —— 它们只出现在 header 里 */
  failure: { kind: HttpFailureKind; message: string } | null;
}

/** 与模板引擎同一套分型纪律：只有"响应不是合法 JSON"算解析失败。 */
function errorCodeOf(failure: HttpFailureKind): 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED' {
  return failure === 'parse' ? 'PARSE_FAILED' : 'UPSTREAM_UNREACHABLE';
}

/** 读一次 JSON 端点。失败不抛，返回 ok:false —— 与模板引擎同一套纪律。 */
async function getJson(
  url: string,
  secret: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<HttpJson> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    let jsonOk = true;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      jsonOk = false;
      body = text;
    }
    if (!res.ok) {
      return { ok: false, status: res.status, body, failure: { kind: 'http', message: `上游返回 ${res.status}` } };
    }
    // 先读文本再解析，而不是 res.json()：非 JSON 的响应（HTML 报错页、被网关拦下的页）
    // 是排查时最常见的一类，得让它和"网络不通"分开，否则用户会去查一个没坏的网络。
    if (!jsonOk) {
      return { ok: false, status: res.status, body, failure: { kind: 'parse', message: '上游响应不是合法 JSON' } };
    }
    return { ok: true, status: res.status, body, failure: null };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      body: null,
      failure: {
        kind: 'network',
        message: aborted ? `查询超时（${timeoutMs}ms）` : '上游不可达',
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function billingWindow(now: Date): { start: string; end: string } {
  const dayMs = 86_400_000;
  return {
    start: new Date(now.getTime() - USAGE_WINDOW_DAYS * dayMs).toISOString().slice(0, 10),
    end: now.toISOString().slice(0, 10),
  };
}

/**
 * OpenAI 官方计费：`subscription − usage` 双请求相减。
 *
 * 单请求取不到"剩余" —— `subscription` 只给总额度，`usage` 只给已用量，
 * 两个数相减是官方唯一能拿到余额的算法（ADR-0012 §2 的依据列）。
 * `total_usage` 的单位是**美分**，所以先 /100 折回美元再统一换算到分。
 */
async function runOpenAi(input: PresetRunInput): Promise<PresetRunResult> {
  let origin: string;
  try {
    origin = new URL(input.baseUrl).origin;
  } catch {
    return { ok: false, parsed: null, errorCode: 'PARSE_FAILED', message: '上游 baseUrl 不是合法地址', httpStatus: 0, raw: null };
  }

  const { start, end } = billingWindow(new Date());
  const sub = await getJson(`${origin}${SUBSCRIPTION_PATH}`, input.secret, input.timeoutMs, input.fetchImpl);
  if (!sub.ok || sub.failure !== null) {
    const kind = sub.failure?.kind ?? 'network';
    return {
      ok: false,
      parsed: null,
      errorCode: errorCodeOf(kind),
      message: sub.failure?.message ?? null,
      httpStatus: sub.status,
      raw: { subscription: sub.body, usage: null },
    };
  }

  // 两个响应都带回去：这个 preset 不可编辑，raw 的唯一用途是让用户看出
  // "官方到底返回了什么"，从而判断是账户没额度还是接口变了。
  const usage = await getJson(`${origin}${USAGE_PATH}?start_date=${start}&end_date=${end}`, input.secret, input.timeoutMs, input.fetchImpl);
  const raw = { subscription: sub.body, usage: usage.body };

  const hardLimitUsd = toNumber(getByPath(sub.body, 'hard_limit_usd'));
  if (hardLimitUsd === null) {
    return { ok: false, parsed: null, errorCode: 'PARSE_FAILED', message: '订阅接口未返回 hard_limit_usd', httpStatus: sub.status, raw };
  }
  // 总额度拿到了、已用量没拿到时**不猜**：直接拿 hard_limit_usd 当余额会给出一个
  // 偏大的假值（已用越多偏得越离谱）。宁可报失败，让它落到"稍后重试"。
  if (!usage.ok || usage.failure !== null) {
    const kind = usage.failure?.kind ?? 'network';
    return {
      ok: false,
      parsed: null,
      errorCode: errorCodeOf(kind),
      message: usage.failure?.message ?? null,
      httpStatus: usage.status,
      raw,
    };
  }
  const totalUsageUsdCents = toNumber(getByPath(usage.body, 'total_usage'));
  if (totalUsageUsdCents === null) {
    return { ok: false, parsed: null, errorCode: 'PARSE_FAILED', message: '用量接口未返回 total_usage', httpStatus: usage.status, raw };
  }

  const balanceUsd = hardLimitUsd - totalUsageUsdCents / 100;
  return {
    ok: true,
    parsed: {
      balanceCents: convertToCents(balanceUsd, 'dollar'),
      currency: 'USD',
      remainingTokens: null,
      expiresAt: null,
    },
    errorCode: null,
    message: null,
    httpStatus: sub.status,
    raw,
  };
}

const OPENAI_PRESET: BalancePresetSpec = {
  id: 'openai',
  label: 'OpenAI 官方计费',
  hosts: OPENAI_HOSTS,
  primaryPath: SUBSCRIPTION_PATH,
  unit: 'dollar',
  run: runOpenAi,
};

/**
 * 注册表。**只有这一个** —— 多注册一个就需要一份该上游的实测响应（口径 + 鉴权），
 * 没有实测不进注册表。要扩，走 ADR 补遗（ADR-0012 §2 末尾）。
 */
export const BALANCE_PRESETS: readonly BalancePresetSpec[] = [OPENAI_PRESET];

/** 按 baseUrl 的 host 精确匹配 preset。判不出来就返回 null —— 不猜。 */
export function findPresetByBaseUrl(baseUrl: string): BalancePresetSpec | null {
  let host: string;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return null;
  }
  return BALANCE_PRESETS.find((p) => p.hosts.includes(host)) ?? null;
}

export function presetById(id: string): BalancePresetSpec | null {
  return BALANCE_PRESETS.find((p) => p.id === id) ?? null;
}

/** preset 的主端点标签（`协议//host/path`，无 query、无凭据），用于自测响应展示。 */
export function presetEndpoint(baseUrl: string, preset: BalancePresetSpec): string {
  try {
    const u = new URL(baseUrl);
    return `${u.protocol}//${u.host}${preset.primaryPath}`;
  } catch {
    return '(无效 URL)';
  }
}
