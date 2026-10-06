/**
 * 管理面 HTTP 客户端。
 * 契约来源：docs/api-contract.md（尚未冻结，本文件只实现已冻结的传输层口径，不含任何业务字段假设）。
 *
 * 已冻结口径：
 * - 管理面 API 与前端同源，会话 token 走 HttpOnly + SameSite=Lax Cookie → credentials: 'include'
 * - 写请求带 X-Requested-With: XMLHttpRequest（CSRF 校验第三道）
 * - /api/* 错误体统一 { code, message, details? }
 * - 错误码 UNAUTHORIZED(401) / SESSION_EXPIRED(401) 需跳登录
 */

const API_BASE = '/api';

/** 会话失效时派发，由路由层统一跳登录。 */
export const SESSION_EXPIRED_EVENT = 'sub:session-expired';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'ApiError';
    this.code = body.code;
    this.status = status;
    this.details = body.details ?? null;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** 网络层失败（未拿到 HTTP 响应）与业务错误的统一收口，供 ErrorState 渲染。 */
export function describeError(error: unknown): { code: string; message: string } {
  if (isApiError(error)) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { code: 'ABORTED', message: '请求已取消' };
  }
  if (error instanceof Error) {
    return { code: 'NETWORK_ERROR', message: error.message };
  }
  return { code: 'UNKNOWN', message: '未知错误' };
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, QueryValue>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }

  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function isWriteMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/**
 * 401 会话失效（UNAUTHORIZED / SESSION_EXPIRED）统一在此派发。
 * 管理面**任何**传输层都必须走它 —— 包括不走 `apiFetch` 的 SSE（`assistant.ts`），
 * 否则 401 只会变成气泡里的一行错，用户不会被踢回登录页。
 */
export function notifyIfSessionExpired(status: number, code: string | null): void {
  if (status === 401 && (code === 'UNAUTHORIZED' || code === 'SESSION_EXPIRED')) {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: code }));
  }
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };

  if (isWriteMethod(method)) {
    headers['X-Requested-With'] = 'XMLHttpRequest';
  }

  let payload: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  const init: RequestInit = {
    method,
    headers,
    credentials: 'include',
  };
  if (payload !== undefined) init.body = payload;
  if (options.signal) init.signal = options.signal;

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, {
      code: 'NETWORK_ERROR',
      message: '无法连接到管理面，请检查服务是否运行',
    });
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const body: ApiErrorBody =
      parsed && typeof parsed === 'object' && 'code' in parsed && 'message' in parsed
        ? (parsed as ApiErrorBody)
        : { code: `HTTP_${response.status}`, message: response.statusText || '请求失败' };

    notifyIfSessionExpired(response.status, body.code);

    throw new ApiError(response.status, body);
  }

  return parsed as T;
}

type MethodOptions = Omit<RequestOptions, 'method' | 'body'>;

/** exactOptionalPropertyTypes 下避免展开可选属性，显式装配。 */
function withMethod(method: NonNullable<RequestOptions['method']>, options: MethodOptions): RequestOptions {
  const merged: RequestOptions = { method };
  if (options.query !== undefined) merged.query = options.query;
  if (options.signal !== undefined) merged.signal = options.signal;
  return merged;
}

function withBody(
  method: NonNullable<RequestOptions['method']>,
  body: unknown,
  options: MethodOptions,
): RequestOptions {
  const merged = withMethod(method, options);
  if (body !== undefined) merged.body = body;
  return merged;
}

export const api = {
  get: <T>(path: string, options: MethodOptions = {}) => apiFetch<T>(path, withMethod('GET', options)),
  post: <T>(path: string, body?: unknown, options: MethodOptions = {}) =>
    apiFetch<T>(path, withBody('POST', body, options)),
  put: <T>(path: string, body?: unknown, options: MethodOptions = {}) =>
    apiFetch<T>(path, withBody('PUT', body, options)),
  patch: <T>(path: string, body?: unknown, options: MethodOptions = {}) =>
    apiFetch<T>(path, withBody('PATCH', body, options)),
  del: <T>(path: string, options: MethodOptions = {}) =>
    apiFetch<T>(path, withMethod('DELETE', options)),
};
