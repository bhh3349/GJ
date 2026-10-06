// 管理面统一错误体：{ code, message, details? }（契约 §0.1 / §0.4）。
//
// 为什么要一个 ApiError 类而不是到处 return reply.code(400).send({...})：
//   1. 错误码 → HTTP 状态的映射只有这一处，不会出现同一码两个状态；
//   2. 抛出去让 fastify 的 errorHandler 统一收口，路由代码里不必反复写 send；
//   3. details 的形状（尤其 INVALID_PARAM 的 details.field）被契约明确要求，集中构造更不容易漏。

/** 契约 §0.4 错误码总表 —— 这是全集，新增码必须同步改契约。 */
export const ERROR_CODES = [
  'INVALID_PARAM',
  'UNAUTHORIZED',
  'SESSION_EXPIRED',
  'INVALID_CREDENTIALS',
  'CSRF_REJECTED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'REVISION_MISMATCH',
  'UPSTREAM_HAS_KEYS',
  // 契约 §0.4 / §15.2（v1.4.0 登记）：删账号但其名下有已入池 key。
  // **注意与 UPSTREAM_HAS_KEYS 的区别**：上游那条是"删了 key 必然不可达"，
  // 账号这条是"删了 key 仍然可用"，所以两者都拦，但 `force=true` 的**语义不同** ——
  // 上游是真删子树、账号只是**解绑**（§15.2）。
  'ACCOUNT_HAS_KEYS',
  'UNPROCESSABLE',
  'TOO_MANY_ATTEMPTS',
  'INTERNAL',
  'UPSTREAM_UNREACHABLE',
  'TASK_FAILED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_PARAM: 400,
  UNAUTHORIZED: 401,
  SESSION_EXPIRED: 401,
  INVALID_CREDENTIALS: 401,
  CSRF_REJECTED: 403,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  REVISION_MISMATCH: 409,
  UPSTREAM_HAS_KEYS: 409,
  ACCOUNT_HAS_KEYS: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_ATTEMPTS: 429,
  INTERNAL: 500,
  UPSTREAM_UNREACHABLE: 502,
  TASK_FAILED: 500,
};

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.details = details;
  }

  /** 契约要求 `details.field` 指明出错字段，前端据此把表单那一栏标红。 */
  static invalidParam(field: string, message: string): ApiError {
    return new ApiError('INVALID_PARAM', message, { field });
  }

  static notFound(what: string, id: string): ApiError {
    return new ApiError('NOT_FOUND', `${what} 不存在`, { id });
  }

  toBody(): ErrorBody {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}
