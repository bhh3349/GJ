/**
 * 网关内核 - `/v1/*` 路由层（Fastify 插件）
 * 冻结依据：docs/api-contract.md §10
 *
 * 职责边界：本文件只做「HTTP ↔ 引擎」的搬运，不含任何重试/选路逻辑。
 *   - 鉴权：`Authorization: Bearer <网关key>` → 用户组；失败 401（OpenAI 错误体）
 *   - 限流：RPM/TPM/日配额，超限 429
 *   - 响应：非流式直接写 JSON；流式 `reply.send(stream)` 由 Fastify 做背压，**不缓冲**
 *   - 错误：一律 OpenAI 形状，与管理面 `{code,message}` 严格分开
 *
 * 纪律：网关 key 明文只在本文件的局部变量里活着，禁止进日志/错误体/响应。
 */

import { Readable } from 'node:stream';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { GatewayEngine } from './engine.js';
import { GATEWAY_ERROR_CODES, GatewayError, openAIError } from './errors.js';
import type { RateLimiter } from './limiter.js';
import type { GatewayAuth, GroupContext } from './ports.js';

export interface GatewayRoutesOptions {
  engine: GatewayEngine;
  auth: GatewayAuth;
  limiter?: RateLimiter;
  /** `/internal/snapshot` 的 Bearer；不设则只允许本机回环地址访问 */
  internalToken?: string;
  /** 请求体上限（字节），默认 8MB —— 多模态 base64 图片会顶到这个量级 */
  bodyLimitBytes?: number;
}

/** 建了档案但接口不实现的端点：501，而不是 404（契约 §10） */
const UNSUPPORTED_PREFIXES: readonly string[] = ['/v1/images/', '/v1/audio/', '/v1/rerank', '/v1/moderations', '/v1/files', '/v1/fine_tuning'];

export async function gatewayRoutes(app: FastifyInstance, opts: GatewayRoutesOptions): Promise<void> {
  const { engine, auth, limiter } = opts;

  // 本插件作用域内的兜底：把 Fastify 自己的错误（坏 JSON、超长 body…）也翻成 OpenAI 形状。
  // 封装在插件里，不会串到管理面的 `{code,message}` 上。
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    if (error instanceof GatewayError) {
      void reply.code(error.httpStatus).send(error.body);
      return;
    }
    const status = error.statusCode ?? 500;
    const code = status === 400 ? GATEWAY_ERROR_CODES.INVALID_REQUEST : GATEWAY_ERROR_CODES.UPSTREAM_ERROR;
    const type = status === 400 ? 'invalid_request_error' : 'server_error';
    app.log.warn({ status, name: error.name }, 'gateway: unhandled error');
    // 5xx 不回显内部 message：依赖层的报错常把 host、key 前缀、SQL 片段带出来，
    // 这些是调用方不该看到的东西（4xx 是自己校验出来的文案，回显是安全的）。
    const message = status < 500 ? error.message : 'internal gateway error';
    void reply.code(status).send(openAIError(code, message, type));
  });

  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? '';
    if (UNSUPPORTED_PREFIXES.some((p) => url.startsWith(p))) {
      void reply
        .code(501)
        .send(openAIError(GATEWAY_ERROR_CODES.UNSUPPORTED_ENDPOINT, `endpoint not supported: ${url}`, 'invalid_request_error'));
      return;
    }
    void reply.code(404).send(openAIError(GATEWAY_ERROR_CODES.NOT_FOUND, `no such endpoint: ${url}`, 'invalid_request_error'));
  });

  /** 取网关 key → 用户组上下文；抛 401 由 errorHandler 统一写 */
  async function requireGroup(request: FastifyRequest, reply: FastifyReply): Promise<GroupContext | null> {
    const raw = request.headers.authorization;
    const key = bearerToken(typeof raw === 'string' ? raw : undefined);
    if (key === null) {
      void reply.code(401).send(openAIError(GATEWAY_ERROR_CODES.INVALID_API_KEY, 'missing bearer gateway key', 'authentication_error'));
      return null;
    }
    const group = await auth.authenticate(key);
    if (group === null) {
      // 只回笼统信息：不区分「不存在」与「已禁用」，避免成为 key 探测窗口
      void reply.code(401).send(openAIError(GATEWAY_ERROR_CODES.INVALID_API_KEY, 'invalid gateway key', 'authentication_error'));
      return null;
    }
    if (!group.enabled) {
      void reply.code(403).send(openAIError('GROUP_DISABLED', 'user group is disabled', 'authentication_error'));
      return null;
    }
    return group;
  }

  /** 限流检查；通过后返回 true */
  function passLimiter(group: GroupContext, reply: FastifyReply): boolean {
    if (limiter === undefined) return true;
    const verdict = limiter.check(group);
    if (verdict.ok) return true;
    const code = verdict.reason === 'QUOTA_EXCEEDED' ? GATEWAY_ERROR_CODES.QUOTA_EXCEEDED : GATEWAY_ERROR_CODES.RATE_LIMITED;
    const type = verdict.reason === 'QUOTA_EXCEEDED' ? 'insufficient_quota' : 'rate_limit_error';
    if (verdict.retryAfterSec !== undefined) void reply.header('retry-after', String(verdict.retryAfterSec));
    void reply.code(429).send(openAIError(code, verdict.detail ?? 'rate limit exceeded', type));
    return false;
  }

  /**
   * 写回转发结果，**必须把 reply 返回给调用方并由 handler `return` 出去**。
   *
   * 原因（踩过的坑）：Fastify 的 `wrap-thenable` 在 async handler 解析成 undefined 时，
   * 若 `reply.sent === false && raw.headersSent === false` 会补一次 `reply.send(undefined)`。
   * 流式响应走 `sendStream`，只用 `res.setHeader()` 记头、不发头，所以这两个条件同时成立 →
   * 补发的那次 send 命中空 payload 分支，写出 `content-length: 0` 并直接 end，
   * 上游一个字节都到不了客户端。返回 reply 后 Fastify 改为等 `eos`，那时 `sent` 已为 true，不再补发。
   */
  function writeForwardResult(reply: FastifyReply, result: Awaited<ReturnType<GatewayEngine['chatCompletions']>>): FastifyReply {
    if (result.kind === 'error') {
      if (result.error.httpStatus === 499) {
        // 客户端已断开：别往空气里写响应
        reply.hijack();
        reply.raw.end();
        return reply;
      }
      if (result.error.retryAfterSec !== undefined) reply.header('retry-after', String(result.error.retryAfterSec));
      return reply.code(result.error.httpStatus).send(result.error.body);
    }

    if (result.kind === 'json') {
      return reply
        .code(result.status)
        .header('x-gateway-key-id', result.keyId)
        .header('x-gateway-attempts', String(result.attempts))
        .header('x-gateway-ttfb-ms', String(Math.round(result.ttfbMs)))
        .send(result.payload);
    }

    // 流式：不设 content-length、不缓冲，逐块交给 Fastify 做背压转发。
    // 流结束的记账在引擎的流包装器里完成（成功 / 上游中断 / 客户端断开三条路径）。
    return reply
      .code(200)
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache, no-transform')
      .header('connection', 'keep-alive')
      .header('x-accel-buffering', 'no') // 反代（nginx）不许缓冲，否则 TTFB 直接废掉
      .header('x-gateway-key-id', result.keyId)
      .header('x-gateway-attempts', String(result.attempts))
      .header('x-gateway-ttfb-ms', String(Math.round(result.ttfbMs)))
      .send(toNodeReadable(result.body));
  }

  app.post('/v1/chat/completions', async (request, reply) => {
    const group = await requireGroup(request, reply);
    if (group === null) return;
    if (!passLimiter(group, reply)) return;

    const body = asJsonObject(request.body);
    if (body === null) {
      return void reply.code(400).send(openAIError(GATEWAY_ERROR_CODES.INVALID_REQUEST, 'request body must be a JSON object', 'invalid_request_error'));
    }
    const model = readModel(body);
    if (model === null) {
      return void reply
        .code(400)
        .send(openAIError(GATEWAY_ERROR_CODES.INVALID_REQUEST, '`model` is required and must be a non-empty string', 'invalid_request_error', 'model'));
    }
    if (body.messages === undefined) {
      return void reply.code(400).send(openAIError(GATEWAY_ERROR_CODES.INVALID_REQUEST, '`messages` is required', 'invalid_request_error', 'messages'));
    }

    const link = clientAbortSignal(request, reply);
    try {
      const result = await engine.chatCompletions({ group, model, body, stream: body.stream === true, signal: link.signal });
      return writeForwardResult(reply, result);
    } finally {
      // 流式路径下 signal 的监听由流的生命周期兜住；这里只清 request 侧监听器
      link.dispose();
    }
  });

  app.post('/v1/embeddings', async (request, reply) => {
    const group = await requireGroup(request, reply);
    if (group === null) return;
    if (!passLimiter(group, reply)) return;

    const body = asJsonObject(request.body);
    if (body === null) {
      return void reply.code(400).send(openAIError(GATEWAY_ERROR_CODES.INVALID_REQUEST, 'request body must be a JSON object', 'invalid_request_error'));
    }
    const model = readModel(body);
    if (model === null) {
      return void reply
        .code(400)
        .send(openAIError(GATEWAY_ERROR_CODES.INVALID_REQUEST, '`model` is required and must be a non-empty string', 'invalid_request_error', 'model'));
    }
    if (body.input === undefined) {
      return void reply.code(400).send(openAIError(GATEWAY_ERROR_CODES.INVALID_REQUEST, '`input` is required', 'invalid_request_error', 'input'));
    }

    const link = clientAbortSignal(request, reply);
    try {
      const result = await engine.embeddings({ group, model, body, signal: link.signal });
      return writeForwardResult(reply, result);
    } finally {
      link.dispose();
    }
  });

  app.get('/v1/models', async (request, reply) => {
    const group = await requireGroup(request, reply);
    if (group === null) return;
    if (!passLimiter(group, reply)) return;

    const models = await engine.listModels();
    return void reply.send({
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: createdSeconds(m.createdAt),
        owned_by: m.ownedBy,
      })),
    });
  });

  // 本机观测口：默认只允许回环访问，配了 internalToken 则要求 Bearer
  app.get('/internal/snapshot', async (request, reply) => {
    if (opts.internalToken !== undefined) {
      const token = bearerToken(request.headers.authorization);
      if (token !== opts.internalToken) {
        return void reply.code(401).send(openAIError(GATEWAY_ERROR_CODES.INVALID_API_KEY, 'invalid internal token', 'authentication_error'));
      }
    } else if (!isLoopback(request.ip)) {
      return void reply.code(403).send(openAIError('FORBIDDEN', 'internal snapshot is loopback-only', 'invalid_request_error'));
    }
    return void reply.send(engine.snapshot());
  });
}

/* ------------------------------------------------------------------ */

function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readModel(body: Record<string, unknown>): string | null {
  const model = body.model;
  return typeof model === 'string' && model !== '' ? model : null;
}

/**
 * 客户端断开信号。
 * 用 `reply.raw` 的 'close' + `writableFinished` 判定，而不是 `request.raw.on('close')`：
 * 后者在「请求体读完」时就会触发，会把每个正常请求都当成断开（曾经踩过）。
 * 判定规则：连接关掉时响应还没写完 → 客户端真的跑了。
 */
function clientAbortSignal(request: FastifyRequest, reply: FastifyReply): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onClose = (): void => {
    if (!reply.raw.writableFinished) controller.abort();
  };
  const onFinish = (): void => dispose();
  const dispose = (): void => {
    reply.raw.off('close', onClose);
    reply.raw.off('finish', onFinish);
  };

  reply.raw.on('close', onClose);
  reply.raw.on('finish', onFinish);
  return { signal: controller.signal, dispose };
}

/** 只取 `Bearer <token>`；其余形态一律视为无凭证 */
function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === '' ? null : token;
}

function createdSeconds(iso: string): number {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.floor(at / 1000) : 0;
}

function isLoopback(ip: string | undefined): boolean {
  if (ip === undefined) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function toNodeReadable(stream: ReadableStream<Uint8Array>): Readable {
  // Node 的 Readable.fromWeb 收的是 node:stream/web 的 ReadableStream；
  // 运行时同一个对象，类型来自两套声明（undici vs node），故此处收窄类型。
  return Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0]);
}
