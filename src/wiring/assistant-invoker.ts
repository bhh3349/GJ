/**
 * 内置 AI 助手 —— 网关侧实现（契约 v1.2.0 §13.4 / ADR-0015 §7）。
 *
 * 端口签名冻结在 `src/api/assistant-port.ts`（**消费方**一侧的类型），本文件是它的**唯一实现处**。
 * 位置只能是 `src/wiring/`：只有这一层能同时拿到 `stack.pool`（key 健康）与 `store.secrets`（明文出口），
 * 而 `src/api` 不许 import 网关内部实现、`src/gateway` 不许 import db/api（AGENTS.md §8）。
 *
 * 三个**本文件独有**的决定，写在这里免得下次有人顺手"优化"掉：
 *
 *   1) **共享 pool、另起一个 engine 实例，且一个 sink 都不挂。**
 *      `stack.engine` 上挂着 usage sink 与 error sink；直接拿它用 = 助手调用写进 `usage_logs`
 *      = 污染业务 QPS / 成功率，正是契约 §13.4 明令禁止的那一条。而契约同时要求 key 健康同源
 *      （`reportFailure`/`reportSuccess` 同路径）。两件事同时成立的唯一形状是：**同一个
 *      `KeyPoolInternal`、另一个 `createGatewayEngine` 实例、logs/errors/onUsage 全不传** ——
 *      引擎里 `recordLog`/`reportError` 对缺省 sink 本就是 no-op（engine.ts 如此实现），
 *      于是"零 usage 落库、零错误事件"是**结构性**成立的，不靠调用方自觉。
 *      引擎一行不改，符合 ADR-0015 §4「引擎侧预期零改动」。
 *
 *   2) **合成 group 只活在这一次调用内部。** `ForwardRequest.group` 是必填，引擎只从它取
 *      `groupId` 喂给两个 sink；本引擎两个 sink 都没挂，所以这个值不落任何地方、不解引用、
 *      不参与限流（限流是 routes 层的事，内部调用不过 routes）。它不是 ADR-0015 否掉的 A2 里
 *      那个"假 groupId"（那一个会写进 `usage_logs`），而是一个纯形式参数。
 *
 *   3) **断流走引擎既有 signal 入口，不新增旁路。** `signal` 原样透传进 `chatCompletions`
 *      （engine.ts:94），客户端断开 / 用户点取消 → `abort()` → 引擎既有 `linkedAbort` 与 499 处置
 *      自然接上；499 那条路径**不会** `reportFailure`（engine.ts:577 的判据），所以用户按 ESC
 *      不会把一把好 key 打进冷却。未接上这条 signal = 白烧 token + 占住并发槽位（§13.4 定为缺陷）。
 *
 * 计量口径（§13.4）：计入 key 健康、不计入业务流量口径；本文件另外把 token / 次数记进
 * 调用方传入的 `AssistantMetrics`（§12.2 的 `assistant` 只读字段就是它）。
 */

import type {
  AssistantMessage,
  AssistantModelInvoker,
  AssistantStreamEvent,
} from '../api/assistant-port.js';
import { createGatewayEngine } from '../gateway/engine.js';
import type { FetchLike } from '../gateway/engine.js';
import { GATEWAY_ERROR_CODES } from '../gateway/errors.js';
import type { GatewayError } from '../gateway/errors.js';
import type { KeyPoolInternal } from '../gateway/key-pool.js';
import type { GroupContext, ModelCatalog, SecretResolver } from '../gateway/ports.js';
import { POOL_SATURATED_RETRY_AFTER_SEC } from '../gateway/errors.js';
import { generateRequestId } from '../util/request-id.js';

/**
 * 合成用户组：**形式参数**，不出这一次函数调用（见文件头 2）。
 * `enabled/rpm/tpm/dailyQuota` 引擎一个都不读 —— 列出来只是为了让"它不参与任何配额判断"
 * 这件事在类型上就成立，而不是靠读引擎源码确认。
 */
const ASSISTANT_GROUP: GroupContext = {
  groupId: 'internal-assistant',
  name: 'internal-assistant',
  enabled: true,
  rpm: null,
  tpm: null,
  dailyQuota: null,
};

/** 助手自身调用用的模型名由**装配侧**给定，不来自请求体（契约 §13.1 没有 `model` 字段） */
export interface AssistantMetrics {
  /** 助手调用总次数（§12.2 `assistant.requests`） */
  requests: number;
  /** 以 `error` 终止帧结束的次数（§12.2 `assistant.errors`） */
  errors: number;
  /** 累计 token（上游 usage 或估算；§12.2 `assistant.tokens`） */
  tokens: { prompt: number; completion: number; total: number };
}

export function createAssistantMetrics(): AssistantMetrics {
  return { requests: 0, errors: 0, tokens: { prompt: 0, completion: 0, total: 0 } };
}

export interface AssistantInvokerOptions {
  /** 与业务**同一把**池子：key 健康 / 冷却 / 失败计数同源（§13.4） */
  pool: KeyPoolInternal;
  secrets: SecretResolver;
  models: ModelCatalog;
  /** 助手自身用的客户端模型名（须已在模型档案里建档并绑到上游 key） */
  model: string;
  /** 计数出口，直接挂到 `/api/observability/health` 的 `assistant` 字段 */
  metrics: AssistantMetrics;
  /** 测试桩；运行时保持全局 fetch */
  fetchImpl?: FetchLike;
  upstreamTimeoutMs?: number;
  maxAttempts?: number;
}

/** §10 码值的"说人话"归因文案。**只用自己的文案**，不把上游/引擎原文透给前端（见 `toErrorEvent`） */
const HUMAN_MESSAGE: Record<string, string> = {
  [GATEWAY_ERROR_CODES.NO_AVAILABLE_KEY]:
    '池中没有可派发的 key（模型未建档、key 全部禁用或密文不可解），先查上游与 key 状态',
  [GATEWAY_ERROR_CODES.RATE_LIMITED]: '池中候选 key 并发已满，稍后重试',
  [GATEWAY_ERROR_CODES.QUOTA_EXCEEDED]: '用户组日配额已耗尽，今天不再受理',
  [GATEWAY_ERROR_CODES.UPSTREAM_ERROR]: '上游调不通，候选 key 已全部尝试',
  [GATEWAY_ERROR_CODES.UPSTREAM_TIMEOUT]: '上游首字节超时，候选 key 已全部尝试',
};

/** §10 表里各码值对应的 HTTP 状态；**不是**本次 SSE 响应的状态（流已开，恒 200） */
const CODE_STATUS: Record<string, number> = {
  [GATEWAY_ERROR_CODES.NO_AVAILABLE_KEY]: 503,
  [GATEWAY_ERROR_CODES.RATE_LIMITED]: 429,
  [GATEWAY_ERROR_CODES.QUOTA_EXCEEDED]: 429,
  [GATEWAY_ERROR_CODES.UPSTREAM_ERROR]: 502,
  [GATEWAY_ERROR_CODES.UPSTREAM_TIMEOUT]: 504,
};

/** 兜底归因文案的截断上限：宁可句子短，也不让上游文案把气泡撑爆 */
const FALLBACK_MESSAGE_MAX_CHARS = 200;

export function createAssistantInvoker(options: AssistantInvokerOptions): AssistantModelInvoker {
  const engine = createGatewayEngine({
    pool: options.pool,
    secrets: options.secrets,
    models: options.models,
    // 只收 token：`emitUsage` 是 json 与 stream **两条成功路径唯一的共同收尾点**，
    // 挂在它上面既不会漏、也不会和 `result.usage` 重复计（json 路径会两边都到）。
    onUsage: (event) => {
      const usage = event.usage;
      options.metrics.tokens.prompt += usage.prompt;
      options.metrics.tokens.completion += usage.completion;
      options.metrics.tokens.total += usage.total;
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs: options.upstreamTimeoutMs }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });

  return {
    // async generator：函数体到第一次 `next()` 才跑，所以"O(1) 建立、不得抛"是结构性的，
    // 不是靠 try/catch 兜出来的（端口契约 §13.4 第 3 条）。
    async *stream(messages, signal): AsyncIterable<AssistantStreamEvent> {
      options.metrics.requests += 1;
      try {
        for await (const event of run(messages, signal)) {
          if (event.kind === 'error') options.metrics.errors += 1;
          yield event;
        }
      } catch {
        // 走到这里说明是引擎/上游之外的意外（池查询抛了之类）。契约要求终止必为 done 或 error，
        // 所以这里也要发一个终止帧，绝不让 SSE 挂到超时。
        options.metrics.errors += 1;
        yield {
          kind: 'error',
          code: GATEWAY_ERROR_CODES.UPSTREAM_ERROR,
          message: '助手内部调用异常，请稍后重试',
          status: 502,
        };
      }
    },
  };

  async function* run(messages: AssistantMessage[], signal: AbortSignal): AsyncGenerator<AssistantStreamEvent> {
    const result = await engine.chatCompletions({
      group: ASSISTANT_GROUP,
      model: options.model,
      body: {
        model: options.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
        // 让上游在最后一个 chunk 带上 usage（引擎的 tracker 会采信）；
        // 上游不支持时 tracker 自动回落到 §0.2 估算口径，不会因此失败。
        stream_options: { include_usage: true },
      },
      stream: true,
      // 关联键必填。内部调用自己生成一个：它只进上游请求头（两个 sink 都没挂），
      // 复用一个固定值反而会让同一条上游 trace 看起来像重放。
      requestId: generateRequestId(),
      signal,
    });

    if (result.kind === 'error') {
      // 客户端已经走了（用户点了取消 / 断了），帧没人收，也不再产终止帧噪声。
      if (signal.aborted) return;
      yield toErrorEvent(result.error);
      return;
    }

    // 非流式兜底（理论上不会走到：我们请求的就是 stream:true）。真走到了也把内容吐出来，
    // 不让助手因为一个上游的怪脾气整条哑掉。
    if (result.kind === 'json') {
      const text = readChoiceText(result.payload);
      if (text !== '') yield { kind: 'delta', text };
      yield { kind: 'done' };
      return;
    }

    yield* relayStream(result.body, signal);
  }

  /** 上游 SSE → 助手事件。逐行解析，跨 chunk 的半行留在 buffer 里等下一次拼接。 */
  async function* relayStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ): AsyncGenerator<AssistantStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        // 类型从 reader 自己推，不用 `ReadableStreamReadResult` —— 它在本项目的 lib 组合下
        // 不是全局可见的（TS2304），写死了就要靠 lib 配置吃饭。引擎里是同一个写法（engine.ts:598）。
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          // 上游中途掉线：引擎已在其错误帧里写过 `{error:...}`，但那是给 /v1/* 客户端看的；
          // 助手侧不等它，直接发说人话的终止帧（§13.2「不得让前端等到超时」）。
          if (signal.aborted) return;
          yield {
            kind: 'error',
            code: GATEWAY_ERROR_CODES.UPSTREAM_ERROR,
            message: HUMAN_MESSAGE[GATEWAY_ERROR_CODES.UPSTREAM_ERROR] as string,
            status: 502,
          };
          return;
        }

        if (chunk.done) {
          yield { kind: 'done' };
          return;
        }

        // 客户端已经走了：后面的字节不再有人收，一个帧都不发。
        // 注意**不能**只靠下面 read() 的 catch —— 断开时引擎会先往流里补一个
        // 上游错误帧（给 /v1/* 客户端收尾用）再把流正常关闭，那条路径是"读到数据"而不是"抛出"。
        if (signal.aborted) return;

        buffer += decoder.decode(chunk.value, { stream: true });
        let idx = buffer.indexOf('\n');
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (signal.aborted) return;
          const frame = parseFrame(line);
          if (frame !== null) {
            if (frame.kind === 'text') {
              yield { kind: 'delta', text: frame.text };
            } else if (frame.kind === 'done') {
              yield { kind: 'done' };
              return;
            } else {
              yield frame.event;
              return;
            }
          }
          idx = buffer.indexOf('\n');
        }
      }
    } finally {
      // 早退（error / abort / 消费方 stopped）时显式放开上游流，别把它悬在那儿。
      // 正常结束路径上这是一次 no-op。真正的 upstream abort 由 signal 那条线负责。
      void reader.cancel().catch(() => {});
    }
  }
}

type ParsedFrame =
  | { kind: 'text'; text: string }
  | { kind: 'done' }
  | { kind: 'error'; event: AssistantStreamEvent };

/** 解析一条 SSE 行。非 data 行、空 data、半行 JSON 一律忽略（心跳不是你的事）。 */
function parseFrame(line: string): ParsedFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return null;
  const data = trimmed.slice(5).trim();
  if (data === '') return null;
  if (data === '[DONE]') return { kind: 'done' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null; // 上游偶发半行 / 心跳
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  // 引擎在"首字节后上游断流"时写进来的错误帧：`{error:{message,type,code}}`。
  // 它是 §10 码值，转成助手终止帧的语义完全一致，不新增枚举。
  const error = (parsed as { error?: unknown }).error;
  if (typeof error === 'object' && error !== null) {
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : GATEWAY_ERROR_CODES.UPSTREAM_ERROR;
    return { kind: 'error', event: errorEvent(code) };
  }

  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return null;
  const delta = (first as { delta?: unknown }).delta;
  if (typeof delta !== 'object' || delta === null) return null;
  const content = (delta as { content?: unknown }).content;
  if (typeof content !== 'string' || content === '') return null;
  return { kind: 'text', text: content };
}

/** 非流式响应里的正文（兜底路径用） */
function readChoiceText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const first = choices[0];
  if (typeof first !== 'object' || first === null) return '';
  const message = (first as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

/**
 * 引擎的 `GatewayError` → 助手终止帧。
 *
 * 文案一律取自 `HUMAN_MESSAGE`（说人话），**不透传引擎/上游原文**：那些是给值班看的事故现场，
 * 进前端气泡只会有两个后果 —— 术语淹没人、以及多一条可能夹带上游回显的文本进浏览器。
 * 事故现场在 §12.1 的事件流里，这里只负责让人看懂"为什么没答上来"。
 */
function toErrorEvent(error: GatewayError): AssistantStreamEvent {
  const code = error.body.error.code;
  const event: AssistantStreamEvent = {
    kind: 'error',
    code,
    message: readableMessage(code, error.body.error.message),
    status: error.httpStatus,
  };
  if (error.retryAfterSec !== undefined) return { ...event, retryAfterSec: error.retryAfterSec };
  return event;
}

function errorEvent(code: string): AssistantStreamEvent {
  const status = CODE_STATUS[code] ?? 502;
  const event: AssistantStreamEvent = { kind: 'error', code, message: readableMessage(code, ''), status };
  // 429 两类才带退避秒数，与 §10「429 一律带 Retry-After」同口径；流已开，只能走帧内字段。
  // 助手走不到组级配额，实际只可能撞池饱和（ADR-0011 冻结 1s）。
  if (status === 429) return { ...event, retryAfterSec: POOL_SATURATED_RETRY_AFTER_SEC };
  return event;
}

function readableMessage(code: string, fallback: string): string {
  const known = HUMAN_MESSAGE[code];
  if (known !== undefined) return known;
  // 未登记的码值（§10 未来新增）不要装作认识它：给一句带码值的实话 + 截断后的引擎原文。
  // 引擎的 message 由 failureReason + HTTP 状态拼成（engine.ts:495），不含 key 明文；
  // 截断是防它随上游文案变长。
  const tail = fallback.slice(0, FALLBACK_MESSAGE_MAX_CHARS);
  return tail === '' ? `网关返回 ${code}` : `网关返回 ${code}：${tail}`;
}
