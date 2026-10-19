/**
 * 网关内核 - `/v1/*` 路由层（Fastify 插件）
 * 冻结依据：docs/api-contract.md §10
 *
 * 职责边界：本文件只做「HTTP ↔ 引擎」的搬运，不含任何重试/选路逻辑。
 *   - 鉴权：`Authorization: Bearer <网关key>` → 用户组；失败 401（OpenAI 错误体）
 *   - 限流：RPM/TPM/日配额，超限 429
 *   - 响应：非流式直接写 JSON；流式 `reply.send(stream)` 由 Fastify 做背压，**不缓冲**
 *   - 错误：一律 OpenAI 形状，与管理面 `{code,message}` 严格分开
 *   - 事件：被拒的请求产一条错误事件（契约 §12.1），只报事实；分型与严重级由实现侧派生
 *   - 关联键：入站 `x-request-id` 在这里定稿（校验/重生成 → 回写响应头 → 下传引擎）。
 *     本文件是它唯一的判定处，别处一次都不判 —— 见 `src/util/request-id.ts`（契约 §6 / ADR-0014）
 *
 * 纪律：网关 key 明文只在本文件的局部变量里活着，禁止进日志/错误体/响应。
 */

import { Readable } from 'node:stream';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { REQUEST_ID_HEADER, resolveRequestId } from '../util/request-id.js';
import type { GatewayEngine } from './engine.js';
import { GATEWAY_ERROR_CODES, GatewayError, openAIError } from './errors.js';
import type { RateLimiter } from './limiter.js';
import type { ErrorEventSink, GatewayAuth, GroupContext, ModelCatalog, ModelType } from './ports.js';

export interface GatewayRoutesOptions {
  engine: GatewayEngine;
  /**
   * 模型档案只读视图（ADR-0039）。**必填**，虽然引擎也持有同一个 catalog。
   *
   * 为什么同一份 catalog 要给两层：用途不同。引擎用它转发（`resolveUpstreamModel` 改模型名、
   * `listEnabledModels` 出列表）；本层用 `typeOf` 做**端点类别准入** —— 那是与
   * `GROUP_DISABLED` / 模型授权同一族的准入判定，按 ADR-0037 决策 4 的结构理由必须判在**路由层**：
   * 判在引擎等于把内部助手（`wiring/assistant-invoker.ts` 直接调引擎、不过路由层）卷进判定。
   *
   * 要求必填而不给缺省：缺省实现只有两种写法（恒放行 = 静默失效，或恒拒绝 = 全部打不通），
   * 两种都把「忘了接」伪装成「故意这么配」。同 `stack.ts` 对 `egressSelectable` 的那条纪律。
   */
  models: ModelCatalog;
  auth: GatewayAuth;
  limiter?: RateLimiter;
  /**
   * 错误事件出口（契约 §12.1 / ADR-0013 §7）。本层只报**被拒**的请求：
   * 鉴权/限流/参数校验/未知端点。转发失败的事件由引擎在失败终态产出（它才知道
   * 尝试次数、用了哪把 key、上游状态码）—— 两边分工不重叠，同一次失败只产一条。
   */
  errors?: ErrorEventSink;
  /** `/internal/snapshot` 的 Bearer；不设则只允许本机回环地址访问 */
  internalToken?: string;
  /** 请求体上限（字节），默认 8MB —— 多模态 base64 图片会顶到这个量级 */
  bodyLimitBytes?: number;
}

/** 建了档案但接口不实现的端点：501，而不是 404（契约 §10） */
const UNSUPPORTED_PREFIXES: readonly string[] = ['/v1/images/', '/v1/audio/', '/v1/rerank', '/v1/moderations', '/v1/files', '/v1/fine_tuning'];

/**
 * 两个服务端点的路径字面量。**只为准入拒绝的文案**（ADR-0039）而抽出：
 * 文案里要报端点名，而 `app.post('/v1/chat/completions', …)` 的路径串在 handler 里再抄一遍
 * 就是第二处实现 —— 抄错一个字符时，注册与文案会各说各话。
 */
const CHAT_ENDPOINT = '/v1/chat/completions';
const EMBEDDINGS_ENDPOINT = '/v1/embeddings';

export async function gatewayRoutes(app: FastifyInstance, opts: GatewayRoutesOptions): Promise<void> {
  const { engine, auth, limiter, models } = opts;
  const errors = opts.errors;

  /** 事件里只记路径：`?x=1` 是每次调用都不同的噪声，聚合时只会把同一个端点拆成无数条 */
  function pathOf(request: FastifyRequest): string {
    const url = request.raw.url ?? '';
    const query = url.indexOf('?');
    return query === -1 ? url : url.slice(0, query);
  }

  /**
   * 关联键（契约 §6 / ADR-0014）。**每个请求只判一次**，判完缓存在这里。
   *
   * 用 `WeakMap` 而不是 `decorateRequest`：装饰器要往 `FastifyRequest` 的全局类型上挂字段，
   * 而那等于让网关内核去改一个管理面也在用的共享接口 —— 本文件只需在插件作用域内共享这一个值，
   * 闭包里的 WeakMap 就够，且随请求对象一起被回收。
   *
   * 缓存是刻意的最小化重复：hook 里判过一次之后，各处（回写/下传/事件）读到的必然是**同一个值**。
   * 没有缓存的话，一次"重复头"的请求可能在两处各生成一个新 UUID —— 那就白叫关联键了。
   */
  const requestIds = new WeakMap<FastifyRequest, string>();

  function requestIdOf(request: FastifyRequest): string {
    const known = requestIds.get(request);
    if (known !== undefined) return known;
    const id = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
    requestIds.set(request, id);
    return id;
  }

  // 入站即定稿：**所有**响应（含 4xx/5xx、兜底 404、未实现端点的 501）都带这个头。
  // 放在 `onRequest` 而不是各 handler 里，是为了"一定回写"不依赖每个 handler 记得写 ——
  // 契约 §6 用的是「无论入站有没有，响应头**一定**带」。
  app.addHook('onRequest', (request, reply, done) => {
    reply.header(REQUEST_ID_HEADER, requestIdOf(request));
    done();
  });

  /**
   * 产出「被拒」事件（契约 §12.1）。**唯一的产出点**，各拒绝点只填事实 × 3：
   * 状态码 / §10 码值 / 文案 —— 全部取自**同一份已构造的响应体**，事件与响应因此天然一致。
   *
   * 两处刻意的收窄：
   *   1. **只对 `/v1/*` 生效**。网关端口是公开的，扫描器会把任意路径打进来，而兜底 404
   *      对它们一律回错 —— 那些不是"网关调用失败"。记进去的代价不止是噪声：队列满时丢的是
   *      **最旧**的一批，也就是真实故障。§12.1 的定义域写的本来也是「网关处理 `/v1/*` 时」。
   *   2. **`clientModel` / `stream` 只在鉴权通过之后取**（由调用方显式传）。未通过鉴权的请求
   *      不该有往事件表里写字的能力，哪怕只是一个模型名 —— 那是一条匿名可控的写入路径。
   *
   * 全程 `try/catch`：端口契约要求 `record()` 不抛，但这里连"实现不守约"也不许连累转发。
   */
  function reportRejection(
    request: FastifyRequest,
    reply: FastifyReply,
    outcome: { status: number; gatewayCode: string | null; message: string | null },
    facts: { clientModel?: string | null; stream?: boolean } = {},
  ): void {
    if (errors === undefined) return;
    const endpoint = pathOf(request);
    if (!endpoint.startsWith('/v1/')) return;
    try {
      errors.record({
        at: new Date().toISOString(),
        status: outcome.status,
        gatewayCode: outcome.gatewayCode,
        // 被拒的请求一次上游都没碰到：没有 key 失败可言，也没有"哪把 key"
        failureReason: null,
        endpoint,
        // 关联键取自入站时已定稿的值 —— 被拒的请求同样要能和调用方手上的回执对上，
        // 否则"调用方说 429"这件事在事件表里查不到（ADR-0014 §3 的同一条理由）。
        requestId: requestIdOf(request),
        clientModel: facts.clientModel ?? null,
        stream: facts.stream ?? false,
        keyId: '',
        upstreamId: '',
        upstreamStatus: null,
        attempts: 0,
        candidates: null,
        latencyMs: Math.max(0, Math.round(reply.elapsedTime)),
        message: outcome.message,
      });
    } catch {
      /* 观测出口坏了不得影响本就该回给客户端的拒绝响应 */
    }
  }

  /**
   * 从请求体里取事件要用的两个非凭据字段。**只允许在鉴权通过之后调**：
   * 输出侧没有任何判据依赖它，读的是给排障看的模型名（§12.1 `model` 与日志同口径）。
   */
  function authedFacts(request: FastifyRequest): { clientModel: string | null; stream: boolean } {
    const body = asJsonObject(request.body);
    if (body === null) return { clientModel: null, stream: false };
    return { clientModel: readModel(body), stream: body.stream === true };
  }

  // 本插件作用域内的兜底：把 Fastify 自己的错误（坏 JSON、超长 body…）也翻成 OpenAI 形状。
  // 封装在插件里，不会串到管理面的 `{code,message}` 上。
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof GatewayError) {
      reportRejection(request, reply, {
        status: error.httpStatus,
        gatewayCode: error.body.error.code,
        message: error.body.error.message,
      });
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
    // 事件里的码值**不照抄上面那个 `code`**：它给非 400 一律塞 UPSTREAM_ERROR（响应侧的
    // 冻结口径，不动），但"网关自己抛了未预期异常"记成"上游有问题"会把值班引到错误的方向。
    // 端口契约给了正解：网关自身未预期异常传 `null`，实现侧据状态码归入 INTERNAL(500)
    // —— 与 §12.1 表里 `INTERNAL` 那一行（500 / 网关自身未预期异常）严格对上。
    if (status === 400 || status >= 500) {
      reportRejection(request, reply, { status, gatewayCode: status === 400 ? code : null, message });
    }
    // 其余的 4xx（413 超大 body / 415 不支持的媒体类型…）：请求根本没进网关自己的逻辑，
    // §10 表里没有它们的码、§12.1 的分型表里也没有对应行 —— 不猜，不记。见 ADR-0013 的缺口清单。
    void reply.code(status).send(openAIError(code, message, type));
  });

  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url ?? '';
    if (UNSUPPORTED_PREFIXES.some((p) => url.startsWith(p))) {
      const message = `endpoint not supported: ${url}`;
      reportRejection(request, reply, { status: 501, gatewayCode: GATEWAY_ERROR_CODES.UNSUPPORTED_ENDPOINT, message });
      void reply.code(501).send(openAIError(GATEWAY_ERROR_CODES.UNSUPPORTED_ENDPOINT, message, 'invalid_request_error'));
      return;
    }
    const message = `no such endpoint: ${url}`;
    reportRejection(request, reply, { status: 404, gatewayCode: GATEWAY_ERROR_CODES.NOT_FOUND, message });
    void reply.code(404).send(openAIError(GATEWAY_ERROR_CODES.NOT_FOUND, message, 'invalid_request_error'));
  });

  /** 取网关 key → 用户组上下文；抛 401 由 errorHandler 统一写 */
  async function requireGroup(request: FastifyRequest, reply: FastifyReply): Promise<GroupContext | null> {
    const raw = request.headers.authorization;
    const key = bearerToken(typeof raw === 'string' ? raw : undefined);
    if (key === null) {
      const message = 'missing bearer gateway key';
      reportRejection(request, reply, { status: 401, gatewayCode: GATEWAY_ERROR_CODES.INVALID_API_KEY, message });
      void reply.code(401).send(openAIError(GATEWAY_ERROR_CODES.INVALID_API_KEY, message, 'authentication_error'));
      return null;
    }
    const group = await auth.authenticate(key);
    if (group === null) {
      // 只回笼统信息：不区分「不存在」与「已禁用」，避免成为 key 探测窗口
      const message = 'invalid gateway key';
      reportRejection(request, reply, { status: 401, gatewayCode: GATEWAY_ERROR_CODES.INVALID_API_KEY, message });
      void reply.code(401).send(openAIError(GATEWAY_ERROR_CODES.INVALID_API_KEY, message, 'authentication_error'));
      return null;
    }
    if (!group.enabled) {
      // 契约 v1.1.2（ADR-0013 落地补遗）已把 `GROUP_DISABLED` 登记进 §10 并归入 `AUTH_FAILED`，
      // 故这里**产事件**（此前因「码值未登记、只能被实现侧归成 INTERNAL」而刻意不产）。
      // 403 是**已过鉴权**的拒绝：key 有效、只是组被禁用 —— 照 §12.1 产出边界②的推论，
      // 应读 body 填 `model` / `stream`（那条收窄针对的是"未过鉴权不读 body"的匿名写入路径）。
      const message = 'user group is disabled';
      reportRejection(
        request,
        reply,
        { status: 403, gatewayCode: GATEWAY_ERROR_CODES.GROUP_DISABLED, message },
        authedFacts(request),
      );
      void reply.code(403).send(openAIError(GATEWAY_ERROR_CODES.GROUP_DISABLED, message, 'authentication_error'));
      return null;
    }
    return group;
  }

  /** 限流检查；通过后返回 true */
  function passLimiter(request: FastifyRequest, reply: FastifyReply, group: GroupContext): boolean {
    if (limiter === undefined) return true;
    const verdict = limiter.check(group);
    if (verdict.ok) return true;
    const code = verdict.reason === 'QUOTA_EXCEEDED' ? GATEWAY_ERROR_CODES.QUOTA_EXCEEDED : GATEWAY_ERROR_CODES.RATE_LIMITED;
    const type = verdict.reason === 'QUOTA_EXCEEDED' ? 'insufficient_quota' : 'rate_limit_error';
    const message = verdict.detail ?? 'rate limit exceeded';
    if (verdict.retryAfterSec !== undefined) void reply.header('retry-after', String(verdict.retryAfterSec));
    // 两类 429 在这里才分得开：码值不同 → §12.1 分出的 `RATE_LIMITED` 与 `QUOTA_EXCEEDED`
    // 是两个 category（一个是"退避重试"、一个是"今天别来了"），绝不能由状态码现推。
    reportRejection(request, reply, { status: 429, gatewayCode: code, message }, authedFacts(request));
    void reply.code(429).send(openAIError(code, message, type));
    return false;
  }

  /**
   * 组模型授权检查（契约 §4「模型授权」/ §10 v1.15.8 / ADR-0037 决策 4）；通过后返回 true。
   *
   * **为什么判在路由层**（这是本版最要紧的一个位置选择，三个候选逐一否过）：
   *   - **不在引擎**：`engine.forward()` 是转发路径，已经建好候选集、算过限流，在那里拒等于
   *     让"授权失败"长得像"转发失败"。更硬的理由是**助手** —— `wiring/assistant-invoker.ts`
   *     直接调引擎、不过路由层，引擎层强制会把内部助手卷进授权判定（它的合成组该授什么模型？）；
   *     放在路由层，助手**天然豁免**，与它"不参与限流、零 usage 落库"同一条结构事实。
   *   - **不在 key 池**：`getAvailableKeys(model)` 的签名是冻结件，且它管的是"哪把 key 可用"
   *     （有候选集），而授权是**非黑即白的准入**，判在候选集建立之前。
   *   - **在路由层**：与 `GROUP_DISABLED` / 限流是**同一类拒绝**（凭据/策略侧、0 次真实尝试、
   *     候选集根本不建），§10 的 0-attempt 判据原样成立（`failureReason: null`、不计 key 健康、
   *     不碰冷却）；`reportRejection` + `authedFacts` 就在旁边，事件（§12.1）与响应同源。
   *
   * **不特判 `*`**：授权列表按字面匹配。通配符归 key 白名单的既有语义（§16.3 `matchesModel`），
   * 两层不混 —— 在授权层再实现一次通配，等于让"组授权"与"key 白名单"有两套不同的匹配规则。
   *
   * **`/v1/models` 不走这道门**：它是读面，调用方需要它来发现自己能用什么；按组收窄（见那个
   * handler）已经够了，对它 403 只会把"你被授权了什么"变成猜谜。
   */
  function requireModelAuthorized(
    request: FastifyRequest,
    reply: FastifyReply,
    group: GroupContext,
    model: string,
  ): boolean {
    if (group.authorizedModels === null || group.authorizedModels.includes(model)) return true;
    const message = `model not authorized for this group: ${model}`;
    reportRejection(
      request,
      reply,
      { status: 403, gatewayCode: GATEWAY_ERROR_CODES.MODEL_NOT_AUTHORIZED, message },
      authedFacts(request),
    );
    void reply
      .code(403)
      .send(openAIError(GATEWAY_ERROR_CODES.MODEL_NOT_AUTHORIZED, message, 'authentication_error', 'model'));
    return false;
  }

  /**
   * 端点类别准入（契约 §10 / ADR-0039）；通过后返回 true。
   *
   * **修的是什么**：在此之前 `models.type` 只活在建档与展示里，服务路径一次都不读它 ——
   * 网关有「模型类别」也有「端点」，却从不把两者对上。于是把任何登记过的 chat 名字
   * 打到 `/v1/embeddings`，请求会被原样转发给上游的 `/embeddings` 路径，上游的 404
   * 被当成一次**正常调用**落库（`usage_logs` 多一行、`x-gateway-attempts: 1`、
   * 而 `todayUsage()` 不带状态过滤 ⇒ 两端看到的 `requests` 都虚高）。类别是**网关侧**的
   * 登记事实，上游没有向量模型是**本网关**要回答的问题，不是推给上游的 404。
   *
   * **为什么判在路由层**：与 `requireModelAuthorized` 逐条同构 ——
   *   · 判在引擎会把内部助手（`wiring/assistant-invoker.ts` 直调引擎、不过路由层）卷进判定；
   *   · 判在 key 池则要动冻结签名 `getAvailableKeys(model)`，且那是"哪把 key 可用"的层
   *     （已经建了候选集，太晚了）；
   *   · 判在这里 = 与 `GROUP_DISABLED` / 授权 / 限流同一族：**0 次真实尝试**、候选集根本不建、
   *     不碰 key 健康、不进冷却，事件（§12.1）与响应共用同一份文案。
   *
   * **未登记的名字本闸不表态**（`typeOf` → `null` ⇒ 放行）：存在性不是本层要回答的问题，
   * 它由引擎侧的候选集回答（既有 503 `NO_AVAILABLE_KEY`，同样是 0 次真实尝试）。
   * 这也保证本闸**永远不会拒掉一个路由器还能路由的名字** —— 否则就成了另一种"列表里有、打过去不通"。
   *
   * **码选 400 `INVALID_REQUEST` + `param=model`**，零新增码：这是"你把这个名字用在了不服务它的端点上"，
   * 属于 §10 `INVALID_REQUEST` 的原义（调用方参数错），与授权/组停用那类"人不对"（401/403）分开。
   */
  function requireModelCategory(
    request: FastifyRequest,
    reply: FastifyReply,
    model: string,
    endpoint: string,
    accepted: ModelType,
  ): boolean {
    const type = models.typeOf(model);
    if (type === null || type === accepted) return true;
    const message =
      `model \`${model}\` is registered as category \`${type}\`, which \`${endpoint}\` does not serve ` +
      `(this endpoint serves \`${accepted}\` only); use a \`${accepted}\` model here`;
    void rejectInvalid(request, reply, message, 'model');
    return false;
  }

  /**
   * 参数校验失败：400 `INVALID_REQUEST`，事件与响应共用同一份文案。
   * `param` 只进响应体（§12.1 的事件没有这个字段），排障侧靠 message 定位字段。
   */
  function rejectInvalid(request: FastifyRequest, reply: FastifyReply, message: string, param?: string): FastifyReply {
    reportRejection(
      request,
      reply,
      { status: 400, gatewayCode: GATEWAY_ERROR_CODES.INVALID_REQUEST, message },
      authedFacts(request),
    );
    return reply.code(400).send(openAIError(GATEWAY_ERROR_CODES.INVALID_REQUEST, message, 'invalid_request_error', param));
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

  app.post(CHAT_ENDPOINT, async (request, reply) => {
    const group = await requireGroup(request, reply);
    if (group === null) return;
    if (!passLimiter(request, reply, group)) return;

    const body = asJsonObject(request.body);
    if (body === null) {
      return rejectInvalid(request, reply, 'request body must be a JSON object');
    }
    const model = readModel(body);
    if (model === null) {
      return rejectInvalid(request, reply, '`model` is required and must be a non-empty string', 'model');
    }
    // 授权门排在"模型名字合法"之后、"body 其余部分"之前：名字都读不出来时该报 400 而不是 403，
    // 而授权是**策略**判定，比 messages/input 这类形状校验更早（形状错的东西不该先过策略）。
    if (!requireModelAuthorized(request, reply, group, model)) return;
    // 类别门与授权门同排（ADR-0039）：chat 端点只服务 chat 类 —— 判在引擎之前，0 次真实尝试
    if (!requireModelCategory(request, reply, model, CHAT_ENDPOINT, 'chat')) return;
    if (body.messages === undefined) {
      return rejectInvalid(request, reply, '`messages` is required', 'messages');
    }

    const link = clientAbortSignal(request, reply);
    try {
      const result = await engine.chatCompletions({
        group,
        model,
        body,
        stream: body.stream === true,
        // 关联键从这里下传：引擎把它透传上游、写进两条出口（契约 §6）
        requestId: requestIdOf(request),
        signal: link.signal,
      });
      return writeForwardResult(reply, result);
    } finally {
      // 流式路径下 signal 的监听由流的生命周期兜住；这里只清 request 侧监听器
      link.dispose();
    }
  });

  app.post(EMBEDDINGS_ENDPOINT, async (request, reply) => {
    const group = await requireGroup(request, reply);
    if (group === null) return;
    if (!passLimiter(request, reply, group)) return;

    const body = asJsonObject(request.body);
    if (body === null) {
      return rejectInvalid(request, reply, 'request body must be a JSON object');
    }
    const model = readModel(body);
    if (model === null) {
      return rejectInvalid(request, reply, '`model` is required and must be a non-empty string', 'model');
    }
    if (!requireModelAuthorized(request, reply, group, model)) return;
    // 同一个门的第二处（两处都要有，漏一个就是绕过 —— 与既有 embeddings 授权用例同一条纪律）：
    // embeddings 端点只服务 embedding 类。这正是本次要修的缺陷现场：登记为 chat 的名字
    // 此前会被原样转发到上游 `/embeddings`，上游 404 反而被当成一次正常调用落库。
    if (!requireModelCategory(request, reply, model, EMBEDDINGS_ENDPOINT, 'embedding')) return;
    if (body.input === undefined) {
      return rejectInvalid(request, reply, '`input` is required', 'input');
    }

    const link = clientAbortSignal(request, reply);
    try {
      const result = await engine.embeddings({ group, model, body, requestId: requestIdOf(request), signal: link.signal });
      return writeForwardResult(reply, result);
    } finally {
      link.dispose();
    }
  });

  app.get('/v1/models', async (request, reply) => {
    const group = await requireGroup(request, reply);
    if (group === null) return;
    if (!passLimiter(request, reply, group)) return;

    const models = await engine.listModels();
    // 按组收窄（契约 §10 v1.15.8 改口 / ADR-0037 决策 6）：集合 = 档案 enabled 判据 **∩ 该组授权**。
    // 收窄在**这里**（服务端、网关侧），与 /api/console/models 同一条判据 —— 两个面报的是
    // 同一个集合，否则又是"列表里有它、打过去 403"那种会骗人的信号（§19.6）。
    // **未授权收缩的组（null）逐项不变**：这就是升级的零行为变更（既有验收 4 对存量组原样成立）。
    // 过滤在 engine.listModels() 之后、映射之前：引擎不知道授权（它不该知道，决策 4）。
    const visible =
      group.authorizedModels === null
        ? models
        : models.filter((m) => group.authorizedModels?.includes(m.id) === true);
    return void reply.send({
      object: 'list',
      data: visible.map((m) => ({
        id: m.id,
        object: 'model',
        created: createdSeconds(m.createdAt),
        owned_by: m.ownedBy,
        // v1.11.0 只加字段（契约 §10）：既有四字段形状与集合口径零变更。
        // capabilities/contextLength 与档案卡逐项 0 差异；endpointTypes 本期恒 null = 未采集（§10 登记）。
        capabilities: m.capabilities,
        contextLength: m.contextLength,
        endpointTypes: m.endpointTypes,
        // v1.15.10 只加字段（ADR-0039）：**调用方要的正是这一格** —— 准入闸按类别把关之后，
        // 不把类别说出来就等于让调用方盲试端点（打错了收 400，还得回来问"那我该打哪个"）。
        // 与档案卡 `ModelDto.type` 同源（同一份 `models.type` 列），口径逐字一致。
        type: m.type,
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
