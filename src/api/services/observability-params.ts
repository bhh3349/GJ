// 观测取数参数的**共享解析层**（契约 §12.3 / §13.1）。
//
// 为什么单独一个模块，而不是各路由自备一份：§13.1 写死了助手取数"复用 §12.3 的过滤参数
// （**不造第二套口径**）"。两处各写一份 `category` 解析迟早会分叉成"观测页认 9 个分型、
// 助手认 8 个"，而且分叉不报错 —— 只表现为"同一个筛选条件，两个页面给两个答案"。
// 所以枚举校验、时间窗取值的规则都只在这里写一遍。
//
// **不放在这里的是量级上限**：§12.3 的 30 天跨度超限回 `400`，§13.3 的 24h 注入窗超限回
// "裁剪 + `done.truncated:true`"。这个差异是契约明写的（合理但太大的请求不该被打断），
// 不是口径分叉，所以由各自路由在 `parseRangeBounds` 之上施加。

import type { GatewayErrorCategory, GatewayErrorSeverity } from '../dto.js';
import { ApiError } from '../errors.js';
import { isIso8601WithTz } from '../../util/time.js';

/** 契约 §12.1 的 9 个分型。**不是错误码**（与 §10 `GATEWAY_ERROR_CODES` 是两回事）。 */
export const CATEGORIES: readonly GatewayErrorCategory[] = [
  'CLIENT_REQUEST',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'NO_AVAILABLE_KEY',
  'UPSTREAM_ERROR',
  'UPSTREAM_TIMEOUT',
  'CLIENT_ABORTED',
  'INTERNAL',
];

export const SEVERITIES: readonly GatewayErrorSeverity[] = ['warn', 'error'];

/** 错误事件列表的默认窗口：`GET /api/observability/errors` 与助手日志注入共用（契约 §12.3 / §13.1）。 */
export const DEFAULT_ERRORS_WINDOW_MS = 3600_000; // 1h

export interface RangeQuery {
  from?: string;
  to?: string;
}

export interface RangeMs {
  fromMs: number;
  toMs: number;
}

/**
 * 解析时间窗的**取值规则**（不含任何跨度上限）：`from`/`to` 都可省。
 *
 * 两条规则，缺一条都会静默出错：
 *   1. 必须是**带时区**的 ISO8601 —— 不带时区会被 `Date.parse` 按服务器本地时区解释，
 *      换个 TZ 环境同一份查询就整体偏移几小时，且没人会发现；
 *   2. 只给 `to` 或都不给 → `from` 取 `to - 默认跨度`；只给 `from` → `to` 取现在。
 *
 * 返回毫秒而不是字符串：调用方要各自施加不同的跨度上限（见文件头），
 * 换算成 ISO 再解析回来只会多一次精度丢失的机会。
 */
export function parseRangeBounds(query: RangeQuery, defaultSpanMs: number, now: Date): RangeMs {
  const rawTo = query.to;
  const rawFrom = query.from;

  if (rawTo !== undefined && !isIso8601WithTz(rawTo)) {
    throw ApiError.invalidParam('to', 'to 必须是带时区的 ISO8601');
  }
  if (rawFrom !== undefined && !isIso8601WithTz(rawFrom)) {
    throw ApiError.invalidParam('from', 'from 必须是带时区的 ISO8601');
  }

  const toMs = rawTo === undefined ? now.getTime() : Date.parse(rawTo);
  const fromMs = rawFrom === undefined ? toMs - defaultSpanMs : Date.parse(rawFrom);

  if (fromMs >= toMs) throw ApiError.invalidParam('to', 'to 必须晚于 from');

  return { fromMs, toMs };
}

export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 解析 `category`：逗号分隔多值（最多 9 个）。
 *
 * 空串/纯空白段**按"不过滤"处理**（不是错误）：前端"全部分型"这个选项最自然的表达
 * 就是一个空字符串，为一个正常 UI 状态回 400 只会逼前端在发请求前加特判。
 * 但一旦给了非空的段，就必须全部落在枚举内 —— 静默忽略未知分型会让用户以为
 * "筛选生效了、只是没有这类事件"，那是真的误导。
 */
export function parseCategories(raw: string | undefined): GatewayErrorCategory[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return undefined;

  const out: GatewayErrorCategory[] = [];
  for (const p of parts) {
    if (!(CATEGORIES as readonly string[]).includes(p)) {
      throw ApiError.invalidParam('category', `未知分型 ${p}；取值见契约 §12.1`);
    }
    if (!out.includes(p as GatewayErrorCategory)) out.push(p as GatewayErrorCategory);
  }
  return out;
}

/** 解析 `severity`：单值 `warn` \| `error`；空串按"不过滤"处理（同 `parseCategories`）。 */
export function parseSeverity(raw: string | undefined): GatewayErrorSeverity | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === '') return undefined;
  if (!(SEVERITIES as readonly string[]).includes(v)) {
    throw ApiError.invalidParam('severity', 'severity 取值 warn | error');
  }
  return v as GatewayErrorSeverity;
}
