// 内置 AI 助手聊天路由（契约 §13.1 / §13.2 / §13.5 / ADR-0015）。
//
// 本文件只做四件事：解析（解析层非法才 400）→ 取数（复用 §12.3 白名单）→ 组装 prompt → 写 SSE 帧。
// 上限裁剪、prompt 渲染、citation 投影、帧序列化**全在** `services/assistant-chat.ts`，
// 因为那几件是"能逐个钉住的纯函数"；取数参数解析在 `services/observability-params.ts`，
// 与 §12.3 观测页**共用同一套**——两套口径一定会分叉成"同一筛选条件两个页面两个答案"。
//
// 两条纪律写在这里提醒后来者：
//   1. **对话不落库**。本文件对 DB 只有读（错误事件 / 健康指标）+ 一次审计不写；
//      唯一写路径是 invoker 内部的 key 健康结算（§13.4 明写：助手撞坏 key 照常进冷却）。
//   2. **解析层的 400 与量级上限的裁剪不能混**（§13.1）。请求写错了回 400（回 truncated 会掩盖错误）；
//      请求合理但太大一律裁剪 + `done.truncated:true`（回 400 会打断一轮正常追问）。
//      这条差异是**契约明写**的，所以量级上限留在本文件、取值规则下沉到共享解析层。

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AssistantMessage, AssistantModelInvoker } from '../assistant-port.js';
import type { GatewayErrorEventDto, HealthMetricsDto } from '../dto.js';
import { computeHealthMetrics } from '../../db/observability.js';
import { listGatewayErrorEvents } from '../../db/repo/gateway-events.js';
import { ApiError } from '../errors.js';
import type { ApiContext } from '../app.js';
import {
  DEFAULT_ERRORS_WINDOW_MS,
  parseCategories,
  parseRangeBounds,
  parseSeverity,
  toIso,
} from '../services/observability-params.js';
import {
  MAX_INJECTED_EVENTS,
  MAX_INJECT_WINDOW_MS,
  applyMessageCaps,
  buildInvokerMessages,
  renderDataBlock,
  sseFrame,
  toCitation,
  type Citation,
} from '../services/assistant-chat.js';
import { parseWindow } from './stats.js';

/**
 * §10 码值。**刻意写成字面量而不是 import `GATEWAY_ERROR_CODES`**：
 * 依赖方向是 api → （自己的服务层），而 `src/gateway/errors.ts` 属于「路由者」的车道，
 * 跨车道 import 会绕出一个环（AGENTS.md §8）。这两个值由 §10 冻结，改动必须同时改契约。
 */
const CODE_UPSTREAM_ERROR = 'UPSTREAM_ERROR';

/** 终止帧（`done` / `error`）的 `status` 取值：§10 表里 `UPSTREAM_ERROR` 对应 502。 */
const STATUS_UPSTREAM_ERROR = 502;

interface ChatMessageBody {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface LogContextBody {
  window?: string;
  from?: string;
  to?: string;
  category?: string;
  severity?: string;
  upstreamId?: string;
  keyId?: string;
  model?: string;
  requestId?: string;
}

interface ChatBody {
  messages: ChatMessageBody[];
  logContext?: LogContextBody;
}

/**
 * 请求体 schema。
 *
 * **只有两处"不设限"是刻意的**，改之前先读 §13.3：
 *   - `messages` 不写 `maxItems`：条数超 24 是**裁剪**语义，写成 schema 约束就变成 400；
 *   - `content` 不写 `maxLength`：单条超 8000 token 同理，回 400 等于把这条规则从"截断"改成"拒绝"。
 * 反过来 `role` 的 enum 与 `messages` 的 `minItems: 1` 都**该**在 schema 里：它们是解析层的非法，
 * 400 + `details.field` 正是契约要的结果。`logContext` 各字段的长度上限只是防超长 body
 * （真正的枚举/时区校验在下面按 §12.3 的规则做，错误信息才带得上字段名）。
 */
const chatBodySchema = {
  type: 'object',
  required: ['messages'],
  properties: {
    messages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['role', 'content'],
        properties: {
          role: { type: 'string', enum: ['system', 'user', 'assistant'] },
          content: { type: 'string' },
        },
      },
    },
    logContext: {
      type: 'object',
      properties: {
        window: { type: 'string', maxLength: 10 },
        from: { type: 'string', minLength: 1, maxLength: 40 },
        to: { type: 'string', minLength: 1, maxLength: 40 },
        category: { type: 'string', maxLength: 200 },
        severity: { type: 'string', maxLength: 10 },
        upstreamId: { type: 'string', maxLength: 64 },
        keyId: { type: 'string', maxLength: 64 },
        model: { type: 'string', maxLength: 200 },
        requestId: { type: 'string', minLength: 8, maxLength: 64 },
      },
    },
  },
} as const;

/** 注入侧的取数结果。`truncated` 只反映**量级上限**（§13.3），解析层非法早就抛 400 了。 */
interface Injection {
  windowLabel: string | null;
  health: HealthMetricsDto | null;
  events: GatewayErrorEventDto[];
  eventsTotal: number;
  range: { from: string; to: string } | null;
  citations: Citation[];
  truncated: boolean;
}

const EMPTY_INJECTION: Injection = {
  windowLabel: null,
  health: null,
  events: [],
  eventsTotal: 0,
  range: null,
  citations: [],
  truncated: false,
};

/** `logContext` 是否"全空"。省略或全空 = 纯闲聊、不注入日志（§13.1）。 */
function isBlankLogContext(ctx: LogContextBody): boolean {
  return Object.values(ctx).every((v) => v === undefined || v.trim() === '');
}

/**
 * 取数：健康指标 + 错误事件。
 *
 * `window` 与 `from`/`to` **各管各的**（§13.1 表）：前者是健康指标窗口，后者是错误事件窗口。
 * 刻意不把 `window` 顺带当成错误事件的默认跨度 —— 那样就有了第二套时间口径，
 * 而两个窗口各自的原值都会写进 `[观测数据]` 块，模型看得见它读的是哪一段。
 */
function collectInjection(db: ApiContext['db'], ctx: ApiContext, raw: LogContextBody | undefined, now: Date): Injection {
  if (raw === undefined || isBlankLogContext(raw)) return EMPTY_INJECTION;

  let truncated = false;

  let windowLabel: string | null = null;
  let health: HealthMetricsDto | null = null;
  if (raw.window !== undefined && raw.window.trim() !== '') {
    // 枚举外的 `window` 是解析层非法 → 400（与 §12.3 同规则）
    const parsed = parseWindow(raw.window);
    windowLabel = parsed.label;
    health = computeHealthMetrics({
      db,
      windowSeconds: parsed.seconds,
      windowLabel: parsed.label,
      startedAt: ctx.startedAt,
      droppedEvents: ctx.droppedEvents(),
      assistant: ctx.assistantMetrics,
    });
  }

  // 取值规则（带时区 ISO8601、缺省跨度、`to > from`）与 §12.3 同源；跨度上限不同：
  // §12.3 超 30 天回 400，这里超 24h **收窄窗口**（§13.3）。
  const { fromMs, toMs } = parseRangeBounds({ from: raw.from, to: raw.to }, DEFAULT_ERRORS_WINDOW_MS, now);
  const narrowedFrom = toMs - fromMs > MAX_INJECT_WINDOW_MS ? toMs - MAX_INJECT_WINDOW_MS : fromMs;
  if (narrowedFrom !== fromMs) truncated = true;

  const page = listGatewayErrorEvents(db, {
    from: toIso(narrowedFrom),
    to: toIso(toMs),
    categories: parseCategories(raw.category),
    severity: parseSeverity(raw.severity),
    upstreamId: raw.upstreamId,
    keyId: raw.keyId,
    model: raw.model,
    requestId: raw.requestId,
    page: 1,
    // 只取最近 50 条：注入条数上限。总量靠 `total` 拿到（用于告诉模型"这只是最近 50 条"），
    // 不为了展示一个数字把几万行搬进内存。
    pageSize: MAX_INJECTED_EVENTS,
  });
  if (page.total > MAX_INJECTED_EVENTS) truncated = true;

  return {
    windowLabel,
    health,
    events: page.items,
    eventsTotal: page.total,
    range: { from: toIso(narrowedFrom), to: toIso(toMs) },
    // 引用顺序 = 注入块里的出现顺序（`ts DESC`，与 §12.3 查询同序），前端按原序展示
    citations: page.items.map(toCitation),
    truncated,
  };
}

export function registerAssistantRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, assistant } = ctx;

  app.post<{ Body: ChatBody }>(
    '/api/assistant/chat',
    {
      schema: { body: chatBodySchema },
      // 鉴权不在这里判：`/api/*` 的会话闸门在 app.ts 的 onRequest 里（§13.5）。
      // 这也正是 `READONLY_TOKEN` 落在本端点自动 403 的原因 —— 作用域白名单只开给
      // `GET /api/observability/*`，本路由不在其中。
    },
    async (req, reply) => {
      // ── 开流之前的全部工作：任何一步抛错都还能回普通 JSON 400/500 ──
      const caps = applyMessageCaps(req.body.messages);
      const injection = collectInjection(db, ctx, req.body.logContext, new Date());
      const dataBlock = renderDataBlock({
        windowLabel: injection.windowLabel,
        health: injection.health,
        events: injection.events,
        eventsTotal: injection.eventsTotal,
        range: injection.range,
      });
      const messages = buildInvokerMessages(caps.messages, dataBlock);

      await streamChat({
        reply,
        invoker: assistant,
        messages,
        citations: injection.citations,
        truncated: caps.truncated || injection.truncated,
      });
    },
  );
}

interface StreamChatOptions {
  reply: FastifyReply;
  invoker: AssistantModelInvoker;
  messages: AssistantMessage[];
  citations: Citation[];
  truncated: boolean;
}

/**
 * 把 invoker 的事件流转成 SSE 帧。
 *
 * 这里有个**必须写死**的顺序：`hijack()` 一定要在第一次写之前 —— 一旦 Fastify 开始序列化响应体，
 * 再 hijack 也换不回原始 socket 了。hijack 之后本函数对错误负全责：Fastify 的
 * `setErrorHandler` 已经够不着这条连接，任何抛出都会变成一个"没收尾就断掉的流"，
 * 而前端对断流的处置是"保留已收文本 + 可重试"，比一个明确的终止帧差。
 */
async function streamChat(opts: StreamChatOptions): Promise<void> {
  const { reply, invoker, messages, citations, truncated } = opts;

  reply.hijack();
  reply.raw.writeHead(200, {
    // 三个头一个都不能少（§13.2）：
    //   - text/event-stream：前端据此按 SSE 解析，也决定浏览器不做整包压缩缓冲；
    //   - no-cache(+no-transform)：中间层不许缓存，也不许"顺手"改写/聚合响应体；
    //   - X-Accel-Buffering: no：nginx 默认会把 text/event-stream 攒满才吐 ——
    //     少了这个头，SSE 会退化成"生成完一次性出现"，而**本机测试永远发现不了**。
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
  // 先把响应头推出去：模型首个 token 可能要等几百毫秒，不 flush 的话客户端这段时间
  // 连"请求已被接受"都不知道。（注入式测试的 mock 响应没有这个方法，故可选调用。）
  reply.raw.flushHeaders?.();

  // 客户端断开（关页面 / 点取消 / 网络掉）→ 同一条 signal 进 `chatCompletions`，
  // 引擎既有的 `linkedAbort` + 499 处置自然接上，引擎侧零新增分支（§13.4）。
  // 不接这条 = 白烧 token + 占着并发槽位，属缺陷。
  //
  // 挂在 `reply.raw` 上而不是 `req.raw` 上：请求体在 handler 开跑前就读完了，
  // 请求对象的 close 在部分版本上会立刻触发 —— 那样每次调用都会在开头就把自己 abort 掉。
  const controller = new AbortController();
  const onClientGone = (): void => controller.abort();
  reply.raw.on('close', onClientGone);

  let seq = 0;
  let terminal = false; // 是否已写过终止帧（`done` 或 `error`）；契约要求恰好一帧

  const write = (event: 'delta' | 'done' | 'error', payload: unknown): void => {
    if (reply.raw.writableEnded || reply.raw.destroyed) return;
    reply.raw.write(sseFrame(event, payload));
  };

  const writeError = (code: string, message: string, status: number, retryAfterSec?: number): void => {
    if (terminal) return;
    // `retryAfterSec` 恒在（不适用的码值给 `null`）：帧的字段集合固定，前端不需要为"键在不在"加分支。
    write('error', { seq: ++seq, code, message, status, retryAfterSec: retryAfterSec ?? null });
    terminal = true;
  };

  try {
    for await (const event of invoker.stream(messages, controller.signal)) {
      // 客户端已经走了：后面的帧没人收，继续读只是替一个不存在的读者烧 token
      if (controller.signal.aborted) break;

      if (event.kind === 'delta') {
        write('delta', { seq: ++seq, text: event.text });
        continue;
      }
      if (event.kind === 'done') {
        // `truncated` 不是独立帧，只是 `done` 上的一个 bool（§13.2）
        write('done', { seq: ++seq, truncated, citations });
        terminal = true;
        break;
      }
      writeError(event.code, event.message, event.status, event.retryAfterSec);
      break;
    }

    if (!terminal && !controller.signal.aborted) {
      // 端口契约（§13.4）要求实现"必给终止帧"。真出现"迭代器正常结束却没给"就是实现违约；
      // 这里补一个失败终止帧，而不是让前端一直等到超时 —— 后者在值班场景里最坏：
      // 界面上是个还在转的圈，而实际早就什么都没有了。
      writeError(CODE_UPSTREAM_ERROR, '助手未返回终止帧，连接已中断', STATUS_UPSTREAM_ERROR);
    }
  } catch {
    // invoker 承诺"不抛"，但那是承诺不是保证。吞掉异常换成失败终止帧：
    // 这条流已经开了 200，没有别的办法把失败告诉客户端。
    if (!terminal && !controller.signal.aborted) {
      writeError(CODE_UPSTREAM_ERROR, '助手调用异常，连接已中断', STATUS_UPSTREAM_ERROR);
    }
  } finally {
    reply.raw.off('close', onClientGone);
    // 无论如何都要关：`end()` 才让浏览器侧把这次 fetch 标记为完成（而不是"连接被重置"）。
    if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.end();
  }
}
