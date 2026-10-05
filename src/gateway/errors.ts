/**
 * 网关内核 - OpenAI 兼容错误体
 * 冻结依据：docs/api-contract.md §0.1（两套错误体不许混）/ §10（网关面口径）
 *
 * 纪律：`/v1/*` 只出 OpenAI 形状 `{error:{message,type,code}}`，绝不出现 `{code,message}`。
 * 码值来源分两类：
 *   - 项目冻结码：NO_AVAILABLE_KEY / UNSUPPORTED_ENDPOINT（契约 §10 明文写死）
 *   - OpenAI 规范码：invalid_api_key / rate_limit_exceeded / insufficient_quota / ...
 * 新增码值前先在群里对一次，避免调用方按码分支时踩空。
 */

/** OpenAI 侧 error.type 取值（上游 SDK 会按 type 分支，别自创） */
export type GatewayErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'insufficient_quota'
  | 'api_error'
  | 'server_error';

export interface OpenAIErrorPayload {
  message: string;
  type: GatewayErrorType;
  code: string;
  param?: string | null;
}

export interface OpenAIErrorBody {
  error: OpenAIErrorPayload;
}

/** 项目在 /v1/* 上会用到的全部错误码；改动需同步契约 §10 */
export const GATEWAY_ERROR_CODES = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_API_KEY: 'INVALID_API_KEY',
  NO_AVAILABLE_KEY: 'NO_AVAILABLE_KEY',
  UNSUPPORTED_ENDPOINT: 'UNSUPPORTED_ENDPOINT',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  NOT_FOUND: 'NOT_FOUND',
} as const;

export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[keyof typeof GATEWAY_ERROR_CODES];

export function openAIError(
  code: string,
  message: string,
  type: GatewayErrorType = 'invalid_request_error',
  param?: string,
): OpenAIErrorBody {
  const payload: OpenAIErrorPayload = { message, type, code };
  if (param !== undefined) payload.param = param;
  return { error: payload };
}

/** 内部抛出用；路由层 catch 后原样写出，不再二次包装 */
export class GatewayError extends Error {
  readonly httpStatus: number;
  readonly body: OpenAIErrorBody;

  constructor(httpStatus: number, code: string, message: string, type: GatewayErrorType = 'invalid_request_error', param?: string) {
    super(message);
    this.name = 'GatewayError';
    this.httpStatus = httpStatus;
    this.body = openAIError(code, message, type, param);
  }
}

export const unauthorizedError = (message = 'missing or invalid gateway key'): GatewayError =>
  new GatewayError(401, GATEWAY_ERROR_CODES.INVALID_API_KEY, message, 'authentication_error');

export const noAvailableKeyError = (model: string): GatewayError =>
  new GatewayError(503, GATEWAY_ERROR_CODES.NO_AVAILABLE_KEY, `no available key for model: ${model}`, 'server_error');

export const upstreamError = (message: string): GatewayError =>
  new GatewayError(502, GATEWAY_ERROR_CODES.UPSTREAM_ERROR, message, 'api_error');

export const unsupportedEndpointError = (path: string): GatewayError =>
  new GatewayError(501, GATEWAY_ERROR_CODES.UNSUPPORTED_ENDPOINT, `endpoint not supported: ${path}`, 'invalid_request_error');
