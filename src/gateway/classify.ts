/**
 * 网关内核 - 上游失败分类
 * 冻结依据：docs/api-contract.md §10「失败枚举（计入 key 失败，仅这五类）」
 *
 * 铁律：只有这五类计入 key 失败并触发换 key / 冷却：
 *   AUTH_INVALID(401/403) / RATE_LIMITED(429) / INSUFFICIENT_BALANCE(402) /
 *   UPSTREAM_ERROR(5xx) / NETWORK(连接、读取超时、ECONNRESET)
 * 400/404/422 是「客户端自己的错」，原样透传、**不换 key、不计失败** ——
 * 否则一个写错参数的调用方能把整池 key 全打进冷却。
 */

import type { FailureReason } from './types.js';

/** 上游 HTTP 状态码 → 失败原因；null = 不计失败（客户端错） */
export function classifyUpstreamStatus(status: number): FailureReason | null {
  if (status === 401 || status === 403) return 'AUTH_INVALID';
  if (status === 402) return 'INSUFFICIENT_BALANCE';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UPSTREAM_ERROR';
  return null;
}

/**
 * 解析 Retry-After（秒数或 HTTP-date）→ 毫秒。
 * 无法解析 / 为过去时间 → undefined（由 cooldown.ts 落回默认 60s）。
 */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  const raw = header.trim();
  if (raw === '') return undefined;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds * 1000 : undefined;
  }

  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  const delta = at - nowMs;
  return delta > 0 ? delta : undefined;
}

/** 取 AbortSignal 超时导致的中止（与「客户端主动断开」区分开） */
export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

export function isTimeoutError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'TimeoutError';
}

/**
 * 网络层异常 → NETWORK（超时、ECONNRESET、DNS 失败一律同一档冷却）。
 * 注意：调用方必须先判「客户端主动断开」——那种情况不计失败、也不换 key。
 */
export function classifyNetworkError(_err: unknown): FailureReason {
  return 'NETWORK';
}

/* ------------------------------------------------------------------ *
 * 出口级（IP 级）429 的识别缝
 * 冻结依据：docs/api-contract.md §16.7 / docs/adr/0020 决策 4
 * ------------------------------------------------------------------ */

/** 识别器拿到的全部原始材料（上游响应原样，不做任何预处理） */
export interface EgressLimitInput {
  /** 恒为 429（调用方已判，本缝不重复判状态码之外的东西） */
  status: number;
  /** 原始响应体文本；读不出时为 `''` */
  body: string;
  /** 原始响应头（`Retry-After` 等） */
  headers: Headers;
  /** 出口标识（上游 host）；`null` = baseUrl 解析不出，本缝不得判为出口级 */
  egressHost: string | null;
  /**
   * **本客户端请求内**、同一出口上已吃到 429 的**不同** key 数（含当前这一把）。
   * 只有自证据型识别器用得上；按码识别的世界忽略它。
   */
  distinctKeysFailed429: number;
}

export type EgressLimitDetector = (input: EgressLimitInput) => boolean;

/**
 * 默认识别器：**一律不判为出口级**。
 *
 * 这不是「还没写」，是 ADR-0020 决策 4 的裁决：识别规则按悬空件登记，
 * 手上只有一句 message 文案，凭文案做匹配是这类改动里最容易埋雷的做法
 * （文案会变、会被本地化、会随上游版本漂）。缺省即此函数 → Tier 1 的出口级
 * 冷却通道**已接好但不触发**，现网行为与改动前逐字节相同。
 *
 * 识别规则落地时，只替换这一个函数（见下方 `egressLimitedOnSecondKey`）。
 */
export const neverEgressLimited: EgressLimitDetector = () => false;

/**
 * 自证据识别器（**尚未进契约，未启用**；ADR-0020 决策 4 的两个世界 (a)(b) 之外的第三条路）。
 *
 * 不看任何上游文案，只看**形状**：同一出口上、同一客户端请求内，**第 2 把不同的 key**
 * 也吃到 429。key 级限流按 key/账号独立计数，两把不同的 key 在同一出口上几乎同时触限，
 * 是**出口级聚合饱和**的签名 —— 这个签名恰好就是 §16.7 描述的放大回路本身。
 *
 * 为什么值得单列：它**不需要那份原始响应**就能上线，因此不被「等证据」卡住；
 * 且它与 (a)(b) 正交 —— 证据到手后按码判更准，可以叠在它上面。
 *
 * 误判代价有界：真出现「两把 key 各自撞自己的限流」时，代价是把该出口短冷一次并回 429，
 * 而此刻那两把 key 本来也答不了；对比现状（轮换把候选逐把冷掉、最长 30min 全池不可用），
 * 方向相反。启用前需 §16.7 补一句定案。
 */
export const egressLimitedOnSecondKey: EgressLimitDetector = (input) =>
  input.status === 429 && input.egressHost !== null && input.distinctKeysFailed429 >= 2;
