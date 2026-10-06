/**
 * 网关内核 - 转发引擎（/v1/* 核心链路）
 * 冻结依据：docs/api-contract.md §9（边界）/ §10（网关面口径）
 *
 * 铁律（验收 2 / 5 / 6 / 7 都压在这几条上）：
 *   1. **首字节前才可换 key**：`fetch` 拿到响应头即「首字节前」；一旦把 body 交给客户端，
 *      再断就只能发 SSE 错误 + [DONE]，绝不重放（重放 = 客户端看到重复内容）。
 *   2. **只有五类失败换 key**：见 classify.ts。400/404/422 原样透传，不换、不计失败。
 *   3. **热路径零同步 DB 写**：本文件不 import 任何 db/api 模块；密钥走内存端口，
 *      用量与错误事件走各自的 sink（`record()` 只入队，不 await）。
 *   4. **并发位必须 finally 释放**：成功/失败/客户端断开三条路径都要 `endAttempt`，
 *      漏一条会让 key 永久卡在满并发（表现为「池子还有 key 但选不出来」）。
 */

import { REQUEST_ID_HEADER } from '../util/request-id.js';
import type { KeyPoolInternal } from './key-pool.js';
import { classifyUpstreamStatus, parseRetryAfter } from './classify.js';
import { GatewayError, GATEWAY_ERROR_CODES, noAvailableKeyError, openAIError, poolMisconfiguredError, poolSaturatedError, upstreamError } from './errors.js';
import type {
  ErrorEventEntry,
  ErrorEventSink,
  GroupContext,
  ModelCatalog,
  ModelDescriptor,
  SecretResolver,
  UpstreamTarget,
  UsageLogEntry,
  UsageLogSink,
} from './ports.js';
import type { FailureReason, TokenUsage } from './types.js';
import { createStreamUsageTracker, resolveUsage } from './usage.js';

/** 可注入的 fetch（单测传桩；运行时保持全局 fetch，零包装） */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface EngineOptions {
  pool: KeyPoolInternal;
  secrets: SecretResolver;
  models: ModelCatalog;
  logs?: UsageLogSink;
  /**
   * 错误事件出口（契约 §12.1 / ADR-0013 §7）。
   *
   * 与 `logs` 的分工：用量是**每请求一条**，这里只在**失败终态**产一条。
   * 只报事实（状态码 + §10 码值 + 尝试/候选数），分型与严重级由实现侧派生 ——
   * 本文件不认识 category 这个概念，也就不会与契约漂移。
   */
  errors?: ErrorEventSink;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** 单次调用最大尝试次数（含首次），默认 3；上限仍受候选 key 数约束 */
  maxAttempts?: number;
  /** 允许跨上游换 key，默认 true；置 false 时同上游耗尽即停 */
  crossUpstreamRetry?: boolean;
  /** 上游首字节超时（ms），默认 120s。只作用于「拿到响应头之前」，不掐长流 */
  upstreamTimeoutMs?: number;
  /** 逐次尝试的观测钩子（指标/日志用，抛异常会被吞掉） */
  onAttempt?: (event: AttemptEvent) => void;
  /**
   * 用量回执：成功结算时同步调用（非流式 = 响应就绪时；流式 = 流结束时）。
   * 存在的意义是让限流层能拿到 token 记账，而不用把限流逻辑塞进引擎。
   */
  onUsage?: (event: { groupId: string; keyId: string; usage: TokenUsage; ttfbMs: number }) => void;
}

export interface AttemptEvent {
  keyId: string;
  upstreamId: string;
  attempt: number;
  outcome: 'success' | 'failure' | 'skipped';
  reason?: FailureReason;
  status?: number;
  ttfbMs?: number;
}

export interface ForwardRequest {
  group: GroupContext;
  /** 网关面路径，如 `/v1/chat/completions` */
  endpoint: string;
  /** 上游相对路径，如 `/chat/completions`（与 baseUrl 拼接） */
  upstreamPath: string;
  /** 客户端模型名 */
  model: string;
  body: Record<string, unknown>;
  stream: boolean;
  /**
   * 关联键（契约 §6 / ADR-0014）。**必填**：路由层在入站处 `resolveRequestId` 得到最终值，
   * 引擎把它原样透传上游、并写进 `usage_logs` 与 `gateway_error_events` 两处出口。
   *
   * 引擎**不自己生成、也不校验**这个值（那是 `src/util/request-id.ts` 的唯一职责）——
   * 这里只做一个搬运工，否则同一个请求会在两个地方各得一个 id。
   */
  requestId: string;
  signal?: AbortSignal;
}

export type ForwardResult =
  | {
      kind: 'json';
      status: number;
      payload: unknown;
      keyId: string;
      upstreamId: string;
      usage: TokenUsage;
      ttfbMs: number;
      attempts: number;
    }
  | {
      kind: 'stream';
      status: number;
      body: ReadableStream<Uint8Array>;
      keyId: string;
      upstreamId: string;
      ttfbMs: number;
      attempts: number;
    }
  | { kind: 'error'; error: GatewayError; attempts: number };

export interface GatewayEngine {
  chatCompletions(req: Omit<ForwardRequest, 'endpoint' | 'upstreamPath'>): Promise<ForwardResult>;
  embeddings(req: Omit<ForwardRequest, 'endpoint' | 'upstreamPath' | 'stream'>): Promise<ForwardResult>;
  /** `GET /v1/models` 数据源；与模型档案「已启用」集合 0 差异（验收 4） */
  listModels(): Promise<ModelDescriptor[]>;
  snapshot(): InternalSnapshot;
}

export interface InternalSnapshot {
  at: string;
  keys: ReturnType<KeyPoolInternal['view']>;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createGatewayEngine(options: EngineOptions): GatewayEngine {
  const { pool, secrets, models, logs } = options;
  const errors = options.errors;
  const doFetch: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const crossUpstreamRetry = options.crossUpstreamRetry ?? true;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;

  function emit(event: AttemptEvent): void {
    try {
      options.onAttempt?.(event);
    } catch {
      /* 观测钩子不得影响转发 */
    }
  }

  function recordLog(entry: UsageLogEntry): void {
    if (logs === undefined) return;
    try {
      logs.record(entry); // 只入队，不 await（验收 8：日志不得抖动 TTFB）
    } catch {
      /* 日志出口坏了不能连累转发 */
    }
  }

  function emitUsage(groupId: string, keyId: string, usage: TokenUsage, ttfbMs: number): void {
    try {
      options.onUsage?.({ groupId, keyId, usage, ttfbMs });
    } catch {
      /* 记账钩子抛异常不得影响已完成的响应 */
    }
  }

  /**
   * 失败事件的事实集合（契约 §12.1）。**缺省即「不知道」，不为了填满字段而编造** ——
   * `upstreamStatus: null`（一次都没打到上游）与 `0` 是两件事，`keyId: ''`（没有某把 key
   * 可言）与「有 key 但认不出哪把」也是两件事。
   */
  interface ErrorFacts {
    failureReason?: FailureReason | null;
    keyId?: string;
    upstreamId?: string;
    upstreamStatus?: number | null;
    attempts?: number;
    candidates?: number | null;
  }

  /**
   * 产出一条错误事件。**唯一的产出点**，各失败终态只填事实。
   *
   * `status` / `gatewayCode` / `message` 取的是**同一份回给客户端的响应体**，
   * 不是另算一遍 —— 事件与响应因此天然一致，不会出现"客户端看到 502、事件里记 504"。
   *
   * 客户端断开的 499 刻意传 `gatewayCode: null`：§10 里没有这个码（它只存在于事件流），
   * 实现侧据状态码归入 `CLIENT_ABORTED`。编一个码出来会让调用方去 §10 表里找它。
   */
  function reportError(
    req: ForwardRequest,
    started: number,
    outcome: { status: number; gatewayCode: string | null; message: string | null },
    facts: ErrorFacts = {},
  ): void {
    if (errors === undefined) return;
    const ts = now();
    try {
      const entry: ErrorEventEntry = {
        at: new Date(ts).toISOString(),
        status: outcome.status,
        gatewayCode: outcome.gatewayCode,
        failureReason: facts.failureReason ?? null,
        endpoint: req.endpoint,
        clientModel: req.model,
        keyId: facts.keyId ?? '',
        upstreamId: facts.upstreamId ?? '',
        stream: req.stream,
        upstreamStatus: facts.upstreamStatus ?? null,
        attempts: facts.attempts ?? 0,
        candidates: facts.candidates ?? null,
        latencyMs: Math.max(0, ts - started),
        // 关联键与同一次请求的 usage_logs 行同值（契约 §6）：0 次真实尝试的两条终态
        // 上游侧毫无痕迹，这个键是唯一能把事件和那次调用对上的东西（ADR-0014 §3）。
        requestId: req.requestId,
        message: outcome.message,
      };
      errors.record(entry); // 只入队（端口契约：O(1)、不抛、不同步落库）
    } catch {
      /* 观测出口坏了不得连累转发 —— 与 emit/recordLog 同处置 */
    }
  }

  /** `GatewayError` 形态的便捷重载：状态码/码值/文案全部取自即将回给客户端的那一份 */
  function reportGatewayError(req: ForwardRequest, started: number, error: GatewayError, facts: ErrorFacts = {}): void {
    reportError(
      req,
      started,
      { status: error.httpStatus, gatewayCode: error.body.error.code, message: error.body.error.message },
      facts,
    );
  }

  function logAttempt(
    req: ForwardRequest,
    info: {
      keyId: string;
      upstreamId: string;
      statusCode: number;
      usage: TokenUsage | null;
      ttfbMs: number;
      attempts: number;
      failureReason: FailureReason | null;
      started: number;
    },
  ): void {
    recordLog({
      groupId: req.group.groupId,
      keyId: info.keyId,
      upstreamId: info.upstreamId,
      model: models.resolveUpstreamModel(req.model),
      clientModel: req.model,
      endpoint: req.endpoint,
      stream: req.stream,
      statusCode: info.statusCode,
      promptTokens: info.usage?.prompt ?? 0,
      completionTokens: info.usage?.completion ?? 0,
      totalTokens: info.usage?.total ?? 0,
      isEstimated: info.usage?.isEstimated ?? false,
      ttfbMs: info.ttfbMs,
      latencyMs: now() - info.started,
      attempts: info.attempts,
      failureReason: info.failureReason,
      requestId: req.requestId,
      at: new Date(now()).toISOString(),
    });
  }

  async function forward(req: ForwardRequest): Promise<ForwardResult> {
    const started = now();
    const candidates = await pool.getAvailableKeys(req.model);
    if (candidates.length === 0) {
      const error = noAvailableKeyError(req.model);
      // `attempts=0` + `candidates=0`：池里一把候选都没有（模型没建档 / 全被禁用）。
      // 与下面的「候选存在但密文全解不出」**同一个 503**，但归因完全不同 —— 这两个数字
      // 就是值班区分它们的地方（契约 §12.1），所以必须是真数出来的，不能是习惯性填的 0。
      reportGatewayError(req, started, error, { attempts: 0, candidates: 0 });
      return { kind: 'error', error, attempts: 0 };
    }

    const upstreamBody: Record<string, unknown> = { ...req.body, model: models.resolveUpstreamModel(req.model) };

    let attempts = 0;
    let lastReason: FailureReason | null = null;
    let lastStatus = 0;
    let lastTimedOut = false;
    let previousUpstreamId: string | null = null;
    // 0 真实尝试的分型（ADR-0011）：三件事共用「attempts===0」但含义完全不同，
    // 客户端的重试策略与值班归因都靠它们分开 —— 不得再合流到 502 UPSTREAM_ERROR。
    let skippedSaturated = 0; // beginAttempt=false：并发槽位全满 → 429 RATE_LIMITED
    let skippedUnresolvable = 0; // secrets.resolve()===null：配置侧异常 → 503
    let attemptableCandidates = 0; // 进入循环、未被 crossUpstreamRetry/maxAttempts 剪掉的候选数

    for (const candidate of candidates) {
      if (attempts >= maxAttempts) break;
      // 上一把已经试过别的上游且不允许跨上游 → 停
      if (!crossUpstreamRetry && previousUpstreamId !== null && candidate.upstreamId !== previousUpstreamId) break;
      attemptableCandidates += 1;

      // 满并发的 key 直接跳过：不算失败、不进冷却，换下一把
      if (!pool.beginAttempt(candidate.keyId)) {
        skippedSaturated += 1;
        emit({ keyId: candidate.keyId, upstreamId: candidate.upstreamId, attempt: attempts, outcome: 'skipped' });
        continue;
      }

      const target = secrets.resolve(candidate.keyId);
      if (target === null) {
        // 密文缺失 / key 已被删：配置侧问题，不计 key 失败
        skippedUnresolvable += 1;
        pool.endAttempt(candidate.keyId);
        emit({ keyId: candidate.keyId, upstreamId: candidate.upstreamId, attempt: attempts, outcome: 'skipped' });
        continue;
      }

      attempts += 1;
      previousUpstreamId = candidate.upstreamId;

      const link = linkedAbort(req.signal, upstreamTimeoutMs);
      let response: Response;
      try {
        response = await doFetch(joinUrl(target.baseUrl, req.upstreamPath), {
          method: 'POST',
          headers: buildUpstreamHeaders(target, req.requestId),
          body: JSON.stringify(upstreamBody),
          signal: link.signal,
        });
      } catch {
        const timedOut = link.timedOut();
        link.dispose();
        pool.endAttempt(candidate.keyId);

        if (req.signal?.aborted === true && !timedOut) {
          // 客户端自己断开 —— 不计失败、不换 key（换了也没人收）
          emit({ keyId: candidate.keyId, upstreamId: candidate.upstreamId, attempt: attempts, outcome: 'skipped' });
          const aborted = new GatewayError(499, GATEWAY_ERROR_CODES.UPSTREAM_ERROR, 'client closed request', 'api_error');
          // 记 keyId 是「当时正在打哪把」，不是「哪把坏了」：failureReason 留 null，
          // 别让一次用户按 ESC 在事件流里读成一次 key 故障。
          reportError(
            req,
            started,
            { status: 499, gatewayCode: null, message: 'client closed request' },
            { keyId: candidate.keyId, upstreamId: candidate.upstreamId, attempts, candidates: candidates.length },
          );
          return { kind: 'error', error: aborted, attempts };
        }

        pool.reportFailure(candidate.keyId, 'NETWORK');
        lastReason = 'NETWORK';
        lastStatus = 0;
        lastTimedOut = timedOut;
        emit({ keyId: candidate.keyId, upstreamId: candidate.upstreamId, attempt: attempts, outcome: 'failure', reason: 'NETWORK' });
        continue;
      }

      const ttfbMs = now() - started;

      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        link.dispose();
        pool.endAttempt(candidate.keyId);

        const reason = classifyUpstreamStatus(response.status);
        if (reason === null) {
          // 客户端错（400/404/422…）：原样透传，不换 key、不计 key 失败。
          //
          // **刻意不产错误事件**：网关这边一切正常（选路、转发、回传都成功了），
          // 诊断信息是上游自己给的那份，原样在响应里。硬要记一条，就得为 4xx 编一个
          // §10 里不存在的码（表里没有 422 这一行），编出来的码会污染事件流
          // "码值 → 分型"的映射 —— 这是留给契约方决定的缺口，不在网关侧自行补位。
          emit({ keyId: candidate.keyId, upstreamId: candidate.upstreamId, attempt: attempts, outcome: 'success', status: response.status, ttfbMs });
          logAttempt(req, {
            keyId: candidate.keyId,
            upstreamId: candidate.upstreamId,
            statusCode: response.status,
            usage: null,
            ttfbMs,
            attempts,
            failureReason: null,
            started,
          });
          return {
            kind: 'json',
            status: response.status,
            payload: parseJsonOr(raw, response.status),
            keyId: candidate.keyId,
            upstreamId: candidate.upstreamId,
            usage: zeroUsage(),
            ttfbMs,
            attempts,
          };
        }

        pool.reportFailure(candidate.keyId, reason, {
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now()),
        });
        lastReason = reason;
        lastStatus = response.status;
        lastTimedOut = false;
        emit({ keyId: candidate.keyId, upstreamId: candidate.upstreamId, attempt: attempts, outcome: 'failure', reason, status: response.status, ttfbMs });
        continue;
      }

      if (req.stream) {
        if (response.body === null) {
          // 200 但没有 body：上游坏了，按 UPSTREAM_ERROR 换 key（仍在首字节前）
          link.dispose();
          pool.endAttempt(candidate.keyId);
          pool.reportFailure(candidate.keyId, 'UPSTREAM_ERROR');
          lastReason = 'UPSTREAM_ERROR';
          lastStatus = response.status;
          lastTimedOut = false;
          emit({ keyId: candidate.keyId, upstreamId: candidate.upstreamId, attempt: attempts, outcome: 'failure', reason: 'UPSTREAM_ERROR', status: response.status });
          continue;
        }

        // 首字节已到：撤掉 TTFB 计时器（长流不能被它掐断），把并发位与 key
        // 「托付」给流包装器，由它在流终结时归还
        link.disarmTimeout();
        const body = instrumentStream({
          upstream: response.body,
          link,
          keyId: candidate.keyId,
          upstreamId: candidate.upstreamId,
          req,
          started,
          ttfbMs,
          attempts,
          candidates: candidates.length,
          upstreamStatus: response.status,
        });
        emit({ keyId: candidate.keyId, upstreamId: candidate.upstreamId, attempt: attempts, outcome: 'success', status: response.status, ttfbMs });
        return { kind: 'stream', status: 200, body, keyId: candidate.keyId, upstreamId: candidate.upstreamId, ttfbMs, attempts };
      }

      const raw = await response.text().catch(() => '');
      link.dispose();
      pool.endAttempt(candidate.keyId);

      const payload = parseJsonOr(raw, response.status);
      const usage = resolveUsage(upstreamBody, payload);
      pool.reportSuccess(candidate.keyId, usage, ttfbMs);
      emitUsage(req.group.groupId, candidate.keyId, usage, ttfbMs);
      logAttempt(req, {
        keyId: candidate.keyId,
        upstreamId: candidate.upstreamId,
        statusCode: response.status,
        usage,
        ttfbMs,
        attempts,
        failureReason: null,
        started,
      });
      emit({ keyId: candidate.keyId, upstreamId: candidate.upstreamId, attempt: attempts, outcome: 'success', status: response.status, ttfbMs });
      return {
        kind: 'json',
        status: response.status,
        payload,
        keyId: candidate.keyId,
        upstreamId: candidate.upstreamId,
        usage,
        ttfbMs,
        attempts,
      };
    }

    // 收尾分型（ADR-0011）：
    //   - attempts > 0：真敲过上游 → 502/504 按 lastReason（既有冻结口径不变）
    //   - attempts === 0 且有候选：全是「跳过」—— 分饱和与配置异常两型，都不许报 502
    //   - 真实失败发生在中途、后续候选被剪掉：lastReason 已带住，走 502/504
    if (attempts === 0 && attemptableCandidates > 0) {
      if (skippedSaturated > 0 && skippedUnresolvable === 0) {
        // 池饱和：所有候选并发槽位全满。上游没有任何故障，让客户端带 Retry-After 短退避。
        logAttempt(req, { keyId: '', upstreamId: '', statusCode: 429, usage: null, ttfbMs: now() - started, attempts, failureReason: null, started });
        const error = poolSaturatedError(attemptableCandidates);
        reportGatewayError(req, started, error, { attempts, candidates: candidates.length });
        return { kind: 'error', error, attempts };
      }
      // 密文缺失/解析不到（可能叠加饱和）：配置侧异常，值班去查密文，不给客户端退避信号
      logAttempt(req, { keyId: '', upstreamId: '', statusCode: 503, usage: null, ttfbMs: now() - started, attempts, failureReason: null, started });
      const error = poolMisconfiguredError(skippedUnresolvable, skippedSaturated);
      // 归因全在这两个数上：`attempts=0` + `candidates>0` 一眼指向配置/密文，
      // 不用再去翻日志里那行「pool misconfigured」找线索（契约 §12.1）。
      reportGatewayError(req, started, error, { attempts, candidates: candidates.length });
      return { kind: 'error', error, attempts };
    }

    const detail =
      lastReason === null
        ? 'no key accepted the request'
        : `last failure ${lastReason}${lastStatus > 0 ? ` (HTTP ${lastStatus})` : ''}`;
    logAttempt(req, { keyId: '', upstreamId: '', statusCode: 502, usage: null, ttfbMs: now() - started, attempts, failureReason: lastReason, started });
    const error =
      lastTimedOut && lastReason === 'NETWORK'
        ? new GatewayError(504, GATEWAY_ERROR_CODES.UPSTREAM_TIMEOUT, `all ${attempts} attempt(s) timed out`, 'api_error')
        : upstreamError(`all ${attempts} attempt(s) failed: ${detail}`);
    // 全试完了还是失败：没有"那把 key"可言（外键留空），但**最后一次**失败原因必须留下来 ——
    // 排障时「502 里藏着 401」完全是另一种处置，靠 attempts + failureReason + upstreamStatus
    // 三个数把三层口径都钉住（§12.1 那张"不可互相反推"的表就是为这一条写的）。
    reportGatewayError(req, started, error, {
      failureReason: lastReason,
      attempts,
      candidates: candidates.length,
      upstreamStatus: lastStatus > 0 ? lastStatus : null,
    });
    return { kind: 'error', error, attempts };
  }

  /* ---------------------------------------------------------------- *
   * 流式包装：上游 SSE → 客户端，不缓冲
   * ---------------------------------------------------------------- */

  function instrumentStream(ctx: {
    upstream: ReadableStream<Uint8Array>;
    link: ReturnType<typeof linkedAbort>;
    keyId: string;
    upstreamId: string;
    req: ForwardRequest;
    started: number;
    ttfbMs: number;
    attempts: number;
    candidates: number;
    /** 上游在流中断前给出的状态（正常是 200）——「说好了 200 然后掉线」这件事本身是线索 */
    upstreamStatus: number;
  }): ReadableStream<Uint8Array> {
    const tracker = createStreamUsageTracker();
    const reader = ctx.upstream.getReader();
    let settled = false;

    const streamLog = (statusCode: number, usage: TokenUsage | null, failureReason: FailureReason | null): void => {
      logAttempt(ctx.req, {
        keyId: ctx.keyId,
        upstreamId: ctx.upstreamId,
        statusCode,
        usage,
        ttfbMs: ctx.ttfbMs,
        attempts: ctx.attempts,
        failureReason,
        started: ctx.started,
      });
    };

    const settle = (kind: 'success' | 'client-abort' | 'upstream-error'): void => {
      if (settled) return;
      settled = true;
      ctx.link.dispose();
      pool.endAttempt(ctx.keyId); // 三条路径都必须归还并发位

      if (kind === 'success') {
        const usage = tracker.finish(ctx.req.body);
        pool.reportSuccess(ctx.keyId, usage, ctx.ttfbMs);
        emitUsage(ctx.req.group.groupId, ctx.keyId, usage, ctx.ttfbMs);
        streamLog(200, usage, null);
        return;
      }

      if (kind === 'client-abort') {
        // 客户端断开：不计失败、不进冷却（否则用户一按 ESC 就把 key 打进冷却），只留痕
        streamLog(499, null, null);
        // 高频正常现象，不是故障（§12.1 给它单独分型、severity=warn）。
        // 与上面的 499 同一处置：`gatewayCode: null`，实现侧据状态码归入 CLIENT_ABORTED。
        reportError(
          ctx.req,
          ctx.started,
          { status: 499, gatewayCode: null, message: 'client closed request' },
          { keyId: ctx.keyId, upstreamId: ctx.upstreamId, attempts: ctx.attempts, candidates: ctx.candidates },
        );
        return;
      }

      // 流中途上游断：已写出首字节，不可换 key，按契约发错误帧收尾
      if (ctx.req.signal?.aborted !== true) pool.reportFailure(ctx.keyId, 'NETWORK');
      streamLog(502, null, 'NETWORK');
      // 状态码与 usage_logs 保持一致（这里也是 502）：同一次故障在两个存储里
      // 报出两个状态，排障时最难解释的就是这种不一致。
      reportError(
        ctx.req,
        ctx.started,
        { status: 502, gatewayCode: GATEWAY_ERROR_CODES.UPSTREAM_ERROR, message: 'upstream stream interrupted' },
        {
          failureReason: 'NETWORK',
          keyId: ctx.keyId,
          upstreamId: ctx.upstreamId,
          upstreamStatus: ctx.upstreamStatus,
          attempts: ctx.attempts,
          candidates: ctx.candidates,
        },
      );
    };

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch {
          // 上游中断：发一帧 SSE 错误 + [DONE]，让客户端 SDK 能干净收尾
          if (!settled) {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(openAIError(GATEWAY_ERROR_CODES.UPSTREAM_ERROR, 'upstream stream interrupted', 'api_error'))}\n\n`),
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          }
          settle('upstream-error');
          controller.close();
          return;
        }

        if (result.done) {
          settle('success');
          controller.close();
          return;
        }

        tracker.push(decoder.decode(result.value, { stream: true }));
        controller.enqueue(result.value);
      },

      cancel(reason) {
        settle('client-abort');
        void reader.cancel(reason).catch(() => undefined);
      },
    });
  }

  return {
    chatCompletions(req) {
      return forward({ ...req, endpoint: '/v1/chat/completions', upstreamPath: '/chat/completions' });
    },

    embeddings(req) {
      return forward({ ...req, endpoint: '/v1/embeddings', upstreamPath: '/embeddings', stream: false });
    },

    async listModels(): Promise<ModelDescriptor[]> {
      return models.listEnabledModels();
    },

    snapshot(): InternalSnapshot {
      return { at: new Date(now()).toISOString(), keys: pool.view() };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/**
 * 首字节超时 + 客户端连通的中止信号。
 * 拿到响应头后立刻 dispose()：长流不会被超时掐死；客户端断开仍经 clientSignal 传导。
 */
function linkedAbort(
  clientSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; disarmTimeout: () => void; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref(); // 别吊住进程退出

  const onClientAbort = (): void => controller.abort();
  if (clientSignal !== undefined) {
    if (clientSignal.aborted) controller.abort();
    else clientSignal.addEventListener('abort', onClientAbort, { once: true });
  }

  return {
    signal: controller.signal,
    // 超时只管「首字节」。流式响应拿到响应头之后必须撤掉计时器：
    // 否则一次长生成（>120s 很常见）会被 TTFB 超时掐断，还会给这把无辜的 key 记一次 NETWORK 冷却。
    // 撤计时器不等于 dispose —— 客户端断开仍要经 clientSignal 传导。
    disarmTimeout: () => clearTimeout(timer),
    dispose: () => {
      clearTimeout(timer);
      clientSignal?.removeEventListener('abort', onClientAbort);
    },
    timedOut: () => fired,
  };
}

function buildUpstreamHeaders(target: UpstreamTarget, requestId: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    // 关联键原样透传上游（契约 §6）：上游自己的日志因此能和我们这两张表对上。
    // 能原样发出去是因为它**已经过白名单校验**（`resolveRequestId`）——
    // 任意 header 值直接透传是注入面，这里透传的是唯一一处集中校验过的值。
    [REQUEST_ID_HEADER]: requestId,
    // ⚠️ key 明文全进程只出现在这一行；进日志/错误体一律禁止
    authorization: `Bearer ${target.apiKey}`,
  };
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function parseJsonOr(raw: string, status: number): unknown {
  if (raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { error: { message: raw.slice(0, 512), type: 'api_error', code: `UPSTREAM_${status}` } };
  }
}

function zeroUsage(): TokenUsage {
  return { prompt: 0, completion: 0, total: 0, isEstimated: false };
}
