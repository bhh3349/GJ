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

/**
 * 把一段响应体读成契约 §0.4 的错误信封。不是信封（如反代吐的 HTML 502）就按 HTTP 状态兜一个 ——
 * 造一个 `HTTP_502` 比让调用方拿到 `message: undefined` 更容易排查。
 *
 * 收成函数是因为它现在有**两个**调用点：`apiFetch` 与文件下载（后者不能复用 `apiFetch`，
 * 它读的是二进制而不是 JSON）。两份实现会让同一次 401 在两个通道里表现不一致。
 */
function toErrorBody(status: number, statusText: string, text: string): ApiErrorBody {
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return parsed && typeof parsed === 'object' && 'code' in parsed && 'message' in parsed
    ? (parsed as ApiErrorBody)
    : { code: `HTTP_${status}`, message: statusText || '请求失败' };
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
    const body = toErrorBody(response.status, response.statusText, text);

    notifyIfSessionExpired(response.status, body.code);

    throw new ApiError(response.status, body);
  }

  return parsed as T;
}

/** 从 `Content-Disposition` 里取文件名。取不到就返回 `null` —— **不编一个**。 */
function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? null;
}

/**
 * 触发一次文件下载（管理面上**唯一**的产出物型端点：§15.2 的 CSV 对账表导出）。
 *
 * 为什么不用 `window.open` / 一个裸 `<a href>`：那样**拿不到失败反馈** ——
 * 401 / 403 / 网络失败会被浏览器渲染成新标签页里的一段 JSON 或白屏，
 * 用户看到的是"点了没反应"。走 fetch 才能把 loading / 成功 / 失败收进同一条通道。
 *
 * 文件名**由服务端给**（`Content-Disposition`，日期已被服务端钉成 UTC）：
 * 前端自己拼就多出第二份实现，且同一动作在不同时区的机器上会产出不同文件名。
 *
 * 返回实际落盘的文件名（服务端没给时是 `null`），供调用方在成功提示里说出来。
 */
export async function downloadFile(path: string, options: MethodOptions = {}): Promise<string | null> {
  const init: RequestInit = {
    method: 'GET',
    headers: { Accept: 'text/csv, application/octet-stream' },
    credentials: 'include',
  };
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

  if (!response.ok) {
    const body = toErrorBody(response.status, response.statusText, await response.text());
    notifyIfSessionExpired(response.status, body.code);
    throw new ApiError(response.status, body);
  }

  const filename = filenameFrom(response.headers.get('content-disposition'));
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    if (filename) anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // 立刻撤销：blob URL 持有整份文件的内存，而下载已经开始读取它了。
    URL.revokeObjectURL(url);
  }
  return filename;
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
