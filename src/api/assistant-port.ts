// 内置 AI 助手 —— 管理面与网关内核之间的**冻结端口**（契约 v1.2.0 §13，ADR-0015 §7）
//
// 方向与 ADR-0013 的 `ErrorEventSink` 相反：后者是「网关产、管理面收」，这里是「管理面调、网关侧供」。
// 类型落在消费方一侧（src/api），实现落在胶水层（src/wiring/，那里能同时拿到 gateway.engine 与 key 掩码），
// 由 server.ts 接线注入 —— 管理面不 import 网关内部实现（AGENTS.md §8 架构边界）。
//
// 本文件是**纯类型 + 一个「未接线」默认实现**：不 import 任何网关模块、不碰 DB、无副作用。
// 改这里就是改契约，必须同时改 docs/api-contract.md §13 与 ADR-0015 §7。

/** 送进模型的单条消息。`content` 已由路由层渲染成纯文本（system 提示词 + 日志 data 块）。 */
export interface AssistantMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 内部调用产出的事件流。
 *
 * 刻意**不含** `seq` / `truncated` / `citations`：那些是 SSE 帧的产物，由路由层组装。
 * invoker 不懂 SSE、也不懂观测事件分型，于是不会与契约漂移（与 ADR-0013 §7 同一条理由）。
 */
export type AssistantStreamEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done' }
  | {
      kind: 'error';
      /** 契约 §10 网关码值，**零新增枚举** */
      code: string;
      /** 「说人话」的归因文案 */
      message: string;
      /** §10 表里该码值对应的 HTTP 状态；**不是**本次 SSE 响应的状态（流已开，恒 200） */
      status: number;
      /** 仅 429 两类（RATE_LIMITED / QUOTA_EXCEEDED）带；其它省略 */
      retryAfterSec?: number;
    };

/**
 * 一次内部模型调用的入口。路由者按此签名在 `src/wiring/` 侧实现。
 *
 * 三条硬要求（契约 §13.4）：
 *   1. `messages` 是**已过三重上限裁剪**的完整消息，invoker 不再裁剪；
 *   2. `signal` 必须接进 `chatCompletions({ signal })` 既有入口 —— 客户端断开/用户取消即 abort 上游，
 *      走引擎既有的 499 处置（`CLIENT_ABORTED`，不计 key 失败）。不接 = 白烧 token + 占住并发槽位；
 *   3. 返回的 AsyncIterable 必须 **O(1) 建立、不得抛**，终止必为 `done` 或 `error`（恰好一个）。
 *
 * 计量口径：助手调用**计入 key 健康**（reportFailure/reportSuccess 同路径）、
 * **不计入业务流量口径**（不写 usage_logs），另计进程内独立计数经 §12.2 `assistant` 只读暴露。
 */
export interface AssistantModelInvoker {
  stream(messages: AssistantMessage[], signal: AbortSignal): AsyncIterable<AssistantStreamEvent>;
}

/**
 * 「未接线」默认实现：发一个 §10 码值的 error 终止帧，让前端**立刻**看到说人话的失败，
 * 而不是让 SSE 挂到超时。语义恰好落在既有 `NO_AVAILABLE_KEY`(503) 上
 * （「池里没有能派发的 key」），因此不需要新码值。
 */
export const unwiredAssistantInvoker: AssistantModelInvoker = {
  async *stream(): AsyncIterable<AssistantStreamEvent> {
    yield {
      kind: 'error',
      code: 'NO_AVAILABLE_KEY',
      message: 'assistant model invoker is not wired',
      status: 503,
    };
  },
};
