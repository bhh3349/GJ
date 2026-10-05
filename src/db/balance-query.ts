// 余额查询模板：类型、默认值、规范化。
//
// 安全要点（契约 §2 的安全注记）：
//   headers 里的 `{key}` 是**占位符**，只在执行查询时被替换。
//   替换后的字符串永不落盘、永不进日志、永不回显 —— 所以本文件里
//   不存在任何"把替换结果拼进模板再存回去"的路径。

import { ApiError } from '../api/errors.js';

export type BalanceUnit = 'yuan' | 'cents' | 'dollar';
export type HttpMethod = 'GET' | 'POST';

export interface BalanceQueryTemplate {
  enabled: boolean;
  url: string | null;
  method: HttpMethod;
  /** 值里可含 `{key}` 占位符；这里存的**永远是模板原文** */
  headers: Record<string, string>;
  body: string | null;
  parse: {
    /** 取值路径，如 data.balance_infos[0].total_balance */
    balance: string | null;
    currency: string | null;
    remainingTokens: string | null;
    expiresAt: string | null;
    unit: BalanceUnit;
  };
  timeoutMs: number;
}

export const DEFAULT_BALANCE_QUERY: BalanceQueryTemplate = {
  enabled: false,
  url: null,
  method: 'GET',
  headers: {},
  body: null,
  parse: {
    balance: null,
    currency: null,
    remainingTokens: null,
    expiresAt: null,
    unit: 'yuan',
  },
  timeoutMs: 5000,
};

const UNITS: readonly BalanceUnit[] = ['yuan', 'cents', 'dollar'];

/** 单位 → 分的换算系数。`yuan` 与 `dollar` 都是"元"级，×100 到分。 */
export function unitToCentsFactor(unit: BalanceUnit): number {
  return unit === 'cents' ? 1 : 100;
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asPathOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * 把外部输入（DB 里的 JSON，或请求体）规范成模板对象。
 *
 * 只做形状与安全校验；**业务校验**（enabled=true 时 url/parse.balance 必填）
 * 交给 assertUsable()，因为"存一个暂时没配好的模板"是合法操作，
 * 只有真要执行查询时才必须完整。
 */
export function normalizeBalanceQuery(input: unknown): BalanceQueryTemplate {
  const raw = asRecord(input);
  const parseRaw = asRecord(raw['parse']);

  const methodRaw = typeof raw['method'] === 'string' ? raw['method'].toUpperCase() : 'GET';
  const method: HttpMethod = methodRaw === 'POST' ? 'POST' : 'GET';

  const unitRaw = typeof parseRaw['unit'] === 'string' ? parseRaw['unit'] : 'yuan';
  const unit: BalanceUnit = UNITS.includes(unitRaw as BalanceUnit)
    ? (unitRaw as BalanceUnit)
    : 'yuan';

  const headers: Record<string, string> = {};
  const headersRaw = asRecord(raw['headers']);
  for (const [k, v] of Object.entries(headersRaw)) {
    if (typeof v === 'string') headers[k] = v;
  }

  const timeoutRaw = raw['timeoutMs'];
  const timeoutMs =
    typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0
      ? Math.min(Math.floor(timeoutRaw), 60_000)
      : DEFAULT_BALANCE_QUERY.timeoutMs;

  return {
    enabled: raw['enabled'] === true,
    url: asStringOrNull(raw['url']),
    method,
    headers,
    body: asStringOrNull(raw['body']),
    parse: {
      balance: asPathOrNull(parseRaw['balance']),
      currency: asPathOrNull(parseRaw['currency']),
      remainingTokens: asPathOrNull(parseRaw['remainingTokens']),
      expiresAt: asPathOrNull(parseRaw['expiresAt']),
      unit,
    },
    timeoutMs,
  };
}

export function serializeBalanceQuery(t: BalanceQueryTemplate): string {
  return JSON.stringify(t);
}

/** 执行查询前的完整性校验。 */
export function assertUsable(t: BalanceQueryTemplate): void {
  if (t.url === null || !isHttpUrl(t.url)) {
    throw ApiError.invalidParam('balanceQuery.url', '启用余额查询时 url 必须是 http(s) 地址');
  }
  if (t.parse.balance === null) {
    throw ApiError.invalidParam(
      'balanceQuery.parse.balance',
      '启用余额查询时必须给出 balance 取值路径',
    );
  }
}
