// 余额查询模板引擎（契约 §2 balanceQuery）。
//
// 它做的事情很窄：把配置里的模板 + 一把 key 明文，变成一次 HTTP 调用，再把响应
// 按配置的取值路径翻译成"分"。之所以做成配置驱动而不是给每家上游写适配器，
// 是因为上游多半是同一套 new-api / one-api 的变体，差异只在字段路径上。
//
// 安全纪律（贯穿本文件）：
//   - 替换掉 `{key}` 之后的 URL / headers / body **一律不落盘、不记日志、不进错误信息**。
//     上游连不上时，错误信息里只出现**模板原文**（含占位符）和上游主机名，绝不含明文。
//   - `decrypted` 只在本函数栈内存在，随调用结束即可被回收。
//
// 单位换算在这里收口：`yuan`/`dollar` ×100 → 分，`cents` 原样。
// 契约明确「统一到分是后端的责任」，所以上游给什么单位都必须在这一点收敛，
// 否则一个"元"被当成"分"存进去，金额会小 100 倍，而且看起来还挺合理。

import type { BalanceQueryTemplate, BalanceUnit } from '../db/balance-query.js';
import { unitToCentsFactor } from '../db/balance-query.js';
import { readLocalRetryAfterSeconds } from '../egress/fetch-gate.js';

export class BalanceQueryError extends Error {
  readonly code: 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED';
  constructor(code: 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED', message: string) {
    super(message);
    this.name = 'BalanceQueryError';
    this.code = code;
  }
}

/** 只用于调试输出：把 URL 里的敏感 query 去掉，并剥掉任何疑似凭据的片段。 */
export function safeEndpointLabel(urlTemplate: string): string {
  try {
    const u = new URL(urlTemplate);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(无效 URL)';
  }
}

/**
 * 取值路径求值：`data.balance_infos[0].total_balance`
 * 支持点号与下标；任一段缺失返回 undefined（**不是**抛错，缺失是常态，
 * 上游字段改名的正确表现是"查不到余额"，而不是整个刷新任务崩掉）。
 */
export function getByPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const rawSeg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    let seg = rawSeg;
    while (seg.length > 0) {
      const bracket = seg.indexOf('[');
      if (bracket < 0) {
        cur = index(cur, seg);
        break;
      }
      const prop = seg.slice(0, bracket);
      if (prop !== '') cur = index(cur, prop);
      const close = seg.indexOf(']', bracket);
      if (close < 0) return undefined;
      const idxRaw = seg.slice(bracket + 1, close);
      const idx = Number(idxRaw);
      if (!Number.isInteger(idx) || idx < 0) return undefined;
      cur = Array.isArray(cur) ? cur[idx] : undefined;
      seg = seg.slice(close + 1);
    }
  }
  return cur;
}

function index(obj: unknown, prop: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[prop];
}

/** `{key}` 占位符替换。替换结果绝不出本函数。 */
export function substitute(template: string, secret: string): string {
  return template.split('{key}').join(secret);
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export interface ParsedBalance {
  /** 分；null = 响应里没有该字段（未知，不是 0） */
  balanceCents: number | null;
  currency: string | null;
  remainingTokens: number | null;
  expiresAt: string | null;
}

export function convertToCents(value: number, unit: BalanceUnit): number {
  // 四舍五入到整数分：上游偶尔给 12.345 元，直接截断会让账目慢慢偏小
  return Math.round(value * unitToCentsFactor(unit));
}

/** 按模板解析上游响应体。纯函数，好测。 */
export function parseBalanceResponse(template: BalanceQueryTemplate, body: unknown): ParsedBalance {
  const { parse } = template;

  let balanceCents: number | null = null;
  if (parse.balance !== null) {
    const raw = getByPath(body, parse.balance);
    const num = toNumber(raw);
    if (num !== null) balanceCents = convertToCents(num, parse.unit);
  }

  return {
    balanceCents,
    currency: parse.currency === null ? null : asStringOrNull(getByPath(body, parse.currency)),
    remainingTokens:
      parse.remainingTokens === null ? null : toNumber(getByPath(body, parse.remainingTokens)),
    expiresAt: parse.expiresAt === null ? null : asStringOrNull(getByPath(body, parse.expiresAt)),
  };
}

function asStringOrNull(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

export interface QueryOutcome {
  maskedKey: string;
  ok: boolean;
  parsed: ParsedBalance | null;
  errorCode: 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED' | null;
  message: string | null;
  /**
   * HTTP 状态；`0` = 没拿到响应（不可达 / 超时）。
   * 有它才分得出 `failed` 的子型：401/403 是"鉴权被拒"（该改配置或换 key），
   * 其余才是"上游挂了"（等等就行）。两者给用户的引导完全不同（ADR-0012 §4）。
   */
  httpStatus: number;
  /**
   * 上游响应体原文。**仅当调用方显式要求采集时才有值**（自测诊断用）；
   * 批量刷新不采集 —— 省内存，也少一处明文可能外溢的面。
   * 拿到它的人必须先过 `balance/raw.ts` 的 sanitizeUpstreamBody 才能外露。
   */
  raw?: unknown;
  /**
   * 本地出口拒绝带回的 `Retry-After`（整数秒 ≥1，ceil；ADR-0017 清单 #16 / 契约 v1.8.1）。
   * 生产唯一来源 = `isLocalEgressReject`（fetch-gate 合成的 429，响应头自带 retry-after）；
   * 上游真 429 **不填** —— 出口级与 key 级证据面同形、不按来源分型（§16.7 v1.6.2）。
   * 缺省（absent）= 无建议，前端不显示。
   */
  retryAfterSeconds?: number;
}

/** 执行选项。默认全关：批量刷新不需要响应体，也不该为此付内存。 */
export interface QueryOptions {
  captureRaw?: boolean;
}

export interface QueryTarget {
  keyId: string;
  maskedKey: string;
  /** 明文，仅本次调用有效 */
  decrypted: string;
}

/**
 * 执行一次余额查询。
 *
 * 失败**不抛异常**，而是返回 `ok:false` 的结果：批量刷新里一把 key 查不到
 * 不该让其余 50 把的进度一起丢掉。由调用方决定怎么汇总。
 */
export async function queryBalance(
  template: BalanceQueryTemplate,
  target: QueryTarget,
  // **必填、无兜底**（ADR-0021 决策 4c「8 处 fetchImpl 兜底全拆」）：这是**最终出站层**，
  // 漏传 = 编译错误。写成 `= fetch` 的话，上面任何一层忘了透传，流量就静默绕过闸 ——
  // 而"配了出口但流量仍走宿主 IP"正是这条缝最贵的那类故障。
  fetchImpl: typeof fetch,
  options: QueryOptions = {},
): Promise<QueryOutcome> {
  const captureRaw = options.captureRaw === true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), template.timeoutMs);

  try {
    if (template.url === null) {
      return { maskedKey: target.maskedKey, ok: false, parsed: null, errorCode: 'PARSE_FAILED', message: '未配置查询地址', httpStatus: 0 };
    }
    const url = substitute(template.url, target.decrypted);
    const headers: Record<string, string> = { Accept: 'application/json' };
    for (const [k, v] of Object.entries(template.headers)) {
      headers[k] = substitute(v, target.decrypted);
    }
    const hasBody = template.method === 'POST' && template.body !== null;
    if (hasBody) headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';

    const res = await fetchImpl(url, {
      method: template.method,
      headers,
      body: hasBody ? substitute(template.body ?? '', target.decrypted) : undefined,
      signal: controller.signal,
    });

    // 先读文本再解析，而不是 res.json()：非 JSON 的响应（HTML 报错页、网关拦截页）
    // 是自测里最常见的一类故障，把它归到"上游不可达"会让人去查网络，
    // 而归到 PARSE_FAILED 并让他看 raw，一眼就知道是端点打错了。
    const text = await res.text();
    let body: unknown = null;
    let jsonOk = true;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      jsonOk = false;
    }

    if (!res.ok) {
      return {
        maskedKey: target.maskedKey,
        ok: false,
        parsed: null,
        errorCode: 'UPSTREAM_UNREACHABLE',
        // 只说状态码与主机名 —— 不把 URL 原文写进来，它可能已被替换过
        message: `上游返回 ${res.status}（${safeEndpointLabel(template.url)}）`,
        httpStatus: res.status,
        raw: captureRaw ? (jsonOk ? body : text) : undefined,
        retryAfterSeconds: readLocalRetryAfterSeconds(res),
      };
    }
    if (!jsonOk) {
      return {
        maskedKey: target.maskedKey,
        ok: false,
        parsed: null,
        errorCode: 'PARSE_FAILED',
        message: '上游响应不是合法 JSON',
        httpStatus: res.status,
        raw: captureRaw ? text : undefined,
      };
    }

    return {
      maskedKey: target.maskedKey,
      ok: true,
      parsed: parseBalanceResponse(template, body),
      errorCode: null,
      message: null,
      httpStatus: res.status,
      raw: captureRaw ? body : undefined,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      maskedKey: target.maskedKey,
      ok: false,
      parsed: null,
      errorCode: 'UPSTREAM_UNREACHABLE',
      message: aborted ? `查询超时（${template.timeoutMs}ms）` : '上游不可达',
      httpStatus: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
