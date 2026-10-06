// 网关适配层 - `ErrorEventSink`：把网关的失败事件攒批落库（契约 §12.1 / ADR-0013）。
//
// 与 `usage-sink.ts` 同一条硬约束：`record()` **只入队**，不落库、不 await。
//
// 除了「攒批」，本文件还承担两件在契约里被点名的事：
//   1. **分型派生**（`deriveCategory` / `deriveSeverity`）。网关只报事实（状态码 + 码值），
//      分型与严重级在这里按 §12.1 的映射表算出来。放这里而不是网关侧，是为了让
//      "什么算 error 级"只有一个实现处 —— 网关只要按端口签名如实上报，就不可能漂移。
//   2. **脱敏**。`message` 可能带上游回显的凭据，落盘前必须过 `scrubMessage`。
//      仓储层还会再抹一遍（幂等），两处都做不是冗余：少抹一次是不可逆的。

import { appendGatewayErrorEvents } from '../db/repo/gateway-events.js';
import type { GatewayErrorEventInput } from '../db/repo/gateway-events.js';
import type { GatewayErrorCategory, GatewayErrorSeverity } from '../api/dto.js';
import type { Db } from '../db/database.js';
import type { ErrorEventEntry, ErrorEventSink } from '../gateway/ports.js';
import { CLIENT_ABORTED_STATUS } from '../db/repo/gateway-events.js';
import { fallbackMask, scrubMessage } from '../util/redact.js';

const DEFAULT_FLUSH_INTERVAL_MS = 500;
const DEFAULT_MAX_QUEUE = 2000;

/** 契约 §10 里网关会用到的码值。与 `src/gateway/errors.ts` 的 GATEWAY_ERROR_CODES **值**一致。 */
const CODE = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_API_KEY: 'INVALID_API_KEY',
  GROUP_DISABLED: 'GROUP_DISABLED',
  NO_AVAILABLE_KEY: 'NO_AVAILABLE_KEY',
  UNSUPPORTED_ENDPOINT: 'UNSUPPORTED_ENDPOINT',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  NOT_FOUND: 'NOT_FOUND',
} as const;

/**
 * capability → category 的映射表（契约 §12.1，**唯一实现处**）。
 *
 * 刻意先按 `gatewayCode` 分派、再退回状态码，而不是反过来按状态码认：
 * 429 同时对应 `RATE_LIMITED`（限流）与 `QUOTA_EXCEEDED`（配额）两个**不同分型**，
 * 只看状态码会把两者糊成一个，而它们的处置完全相反 ——
 * 限流是"退避重试"，配额用尽是"今天别来了，去找管理员"。
 */
function categoryOfCode(code: string | null): GatewayErrorCategory | null {
  switch (code) {
    case CODE.INVALID_REQUEST:
    case CODE.NOT_FOUND:
    case CODE.UNSUPPORTED_ENDPOINT:
      return 'CLIENT_REQUEST';
    case CODE.INVALID_API_KEY:
    case CODE.GROUP_DISABLED:
      return 'AUTH_FAILED';
    case CODE.RATE_LIMITED:
      return 'RATE_LIMITED';
    case CODE.QUOTA_EXCEEDED:
      return 'QUOTA_EXCEEDED';
    case CODE.NO_AVAILABLE_KEY:
      return 'NO_AVAILABLE_KEY';
    case CODE.UPSTREAM_ERROR:
      return 'UPSTREAM_ERROR';
    case CODE.UPSTREAM_TIMEOUT:
      return 'UPSTREAM_TIMEOUT';
    default:
      // 非 null 但不在表里：不许猜。落到 INTERNAL 并从 `gatewayCode` 原样保留，
      // 这样"契约表漏登记了一个码"在数据里看得见，而不是被静默归到某个相近分型。
      return null;
  }
}

/** 导出给测试与契约核对用；生产路径只经 `toInput` 调用。 */
export function deriveCategory(entry: Pick<ErrorEventEntry, 'status' | 'gatewayCode'>): GatewayErrorCategory {
  const byCode = categoryOfCode(entry.gatewayCode);
  if (byCode !== null) return byCode;
  // 客户端断开**没有** gatewayCode（引擎不会为它造一个 §10 里不存在的码），只能由状态码认
  if (entry.status === CLIENT_ABORTED_STATUS) return 'CLIENT_ABORTED';
  return 'INTERNAL';
}

/**
 * `severity` 由 `category` 决定，**不由 HTTP 状态现推**（契约 §12.1）。
 *
 * 分界是归因侧：429 与 502 都是失败，但一个在调用方/配额侧（warn）、一个在系统侧（error）。
 * 值班与助手按 severity 先分诊 —— 这个值必须在服务端定死，不能让消费方各自推断。
 */
export function deriveSeverity(category: GatewayErrorCategory): GatewayErrorSeverity {
  switch (category) {
    case 'NO_AVAILABLE_KEY':
    case 'UPSTREAM_ERROR':
    case 'UPSTREAM_TIMEOUT':
    case 'INTERNAL':
      return 'error';
    default:
      return 'warn';
  }
}

export interface ErrorEventSinkOptions {
  db: Db;
  /** keyId → `****后4位`；keyId 为空或未知时实现返回 `****`（与 usage-sink 同约定） */
  maskOf(keyId: string): string;
  flushIntervalMs?: number;
  maxQueue?: number;
  onError?: (err: unknown, dropped: number) => void;
  onOverflow?: (dropped: number) => void;
}

export interface BufferedErrorEventSink extends ErrorEventSink {
  /** 立即排空并落库，返回本次写入条数（测试/退出时用） */
  flush(): number;
  pending(): number;
  /** 因队列溢出或落库失败而未落库的条数（**累计**，经 `/health` 的 `events.dropped` 暴露） */
  dropped(): number;
  close(): void;
}

export function createErrorEventSink(options: ErrorEventSinkOptions): BufferedErrorEventSink {
  const { db, maskOf } = options;
  const maxQueue = Math.max(1, options.maxQueue ?? DEFAULT_MAX_QUEUE);
  const flushIntervalMs = Math.max(1, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);

  const queue: GatewayErrorEventInput[] = [];
  let droppedCount = 0;

  /**
   * 队列满：丢**最旧**的。与 usage-sink 相反的选择理由：
   * 用量日志丢旧的是因为它量大且可重建；错误事件是稀疏的，丢旧的同样是"保住刚发生的",
   * 但**必须计数** —— 一个会静默丢数据的观测系统比没有观测系统更误导（契约 §12.2 `dropped`）。
   */
  function makeRoom(): void {
    const overflow = queue.length - maxQueue + 1;
    if (overflow <= 0) return;
    queue.splice(0, overflow);
    droppedCount += overflow;
    options.onOverflow?.(overflow);
  }

  /**
   * 端口入参 → 落库形态。**所有空串归一化与派生都在这里**，落库路径只有这一条。
   *
   * `at` 直接沿用网关侧时刻：事件描述的是"当时发生了什么"，写入耗时不是事实的一部分。
   * 用 `nowIso()` 重打会把这个信息抹掉，排障时看到的时间就永远是"入库时间"。
   */
  function toInput(entry: ErrorEventEntry): GatewayErrorEventInput {
    const category = deriveCategory(entry);
    const keyId = entry.keyId === '' ? null : entry.keyId;
    return {
      ts: entry.at,
      // 关联键（契约 §6 / ADR-0014）。空串归一化放在仓储侧 `toParams`（那里是本表唯一写入口，
      // 规则只需要存在一次）——这里原样透传，网关侧的必填 `string` 不会被中途改成别的形状。
      requestId: entry.requestId,
      severity: deriveSeverity(category),
      category,
      status: entry.status,
      gatewayCode: entry.gatewayCode,
      failureReason: entry.failureReason,
      endpoint: entry.endpoint,
      model: entry.clientModel,
      upstreamId: entry.upstreamId === '' ? null : entry.upstreamId,
      keyId,
      // 没有 keyId 就谈不上"哪把 key"：写 `****` 而不是 null，
      // 因为 null 的语义是"这次失败与某把具体 key 无关"（契约 §12.1），两者不能混同。
      keyMasked: keyId === null ? fallbackMask() : maskOf(keyId),
      stream: entry.stream,
      upstreamStatus: entry.upstreamStatus,
      attempts: entry.attempts,
      candidates: entry.candidates,
      latencyMs: entry.latencyMs,
      message: scrubMessage(entry.message),
    };
  }

  function flush(): number {
    if (queue.length === 0) return 0;
    const batch = queue.splice(0, queue.length);
    try {
      // 仓储侧一个事务写完一批（`appendGatewayErrorEvents` 内部即单事务）
      appendGatewayErrorEvents(db, batch);
      return batch.length;
    } catch (err) {
      // 与 usage-sink 同处置：丢这一批并计数，不塞回队首（那会让新事件排队等一个坏连接）
      droppedCount += batch.length;
      options.onError?.(err, batch.length);
      return 0;
    }
  }

  const timer = setInterval(() => {
    flush();
  }, flushIntervalMs);
  // 别吊住进程退出：退出前由 server.ts 显式 close() 做最后一次 flush
  if (typeof timer.unref === 'function') timer.unref();

  return {
    record(entry: ErrorEventEntry): void {
      // 派生与脱敏放在**入队前**：队列里的东西必须是已净化的，
      // 否则"内存里那一份"与"落盘那一份"有两套形态，迟早有人读到前者。
      if (queue.length >= maxQueue) makeRoom();
      queue.push(toInput(entry));
    },
    flush,
    pending: () => queue.length,
    dropped: () => droppedCount,
    close(): void {
      clearInterval(timer);
      flush();
    },
  };
}
