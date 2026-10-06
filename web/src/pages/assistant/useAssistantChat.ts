/**
 * 聊天页状态机（契约 §13）。
 *
 * 三条纪律落在这一层：
 * - **对话只在内存** —— 状态就在这个 hook 的 `useState` 里，不写 `sessionStorage`、不写服务端（§13 头注 1）。
 * - **全量发历史、不本地裁剪** —— 每次请求把整段对话原样回传，上限由服务端裁并以 `done.truncated` 回报（§13.3）。
 * - **失败说人话** —— 终止帧的 `error` 原样留在气泡里，不弹 toast 掩盖；断流保留已收文本（§13.2）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { streamAssistantChat } from '@/api/assistant';
import { ApiError, describeError } from '@/api/http';
import type {
  AssistantChatRequest,
  AssistantCitation,
  AssistantLogContext,
  AssistantMessage,
} from '@/api/types';

/** §13 约定：首字超过这个时间**不判失败**，只把「正在思考」换成「仍在等待上游」并把取消按钮亮出来。 */
export const FIRST_BYTE_SLOW_MS = 15_000;

export type AssistantTurnPhase =
  /** 请求已发出，首字未到。 */
  | 'pending'
  /** 首字已到，正在增量。 */
  | 'streaming'
  /** 收到 `done` 终止帧。 */
  | 'done'
  /** 收到 `error` 终止帧，或未开流即失败（401/403/400）。 */
  | 'error'
  /** 用户点「取消」，已 abort 上游。 */
  | 'aborted'
  /** 没等到终止帧流就断了 —— 保留已收文本，可重试。 */
  | 'interrupted';

export interface AssistantErrorInfo {
  code: string;
  message: string;
  /** §10 表里该码值对应的 HTTP 状态；客户端侧诊断码为 `0`。 */
  status: number;
  retryAfterSec: number | null;
}

export interface AssistantTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 用户回合没有流式生命周期，恒为 `done`。 */
  phase: AssistantTurnPhase;
  /** 仅 `done` 帧携带；`error` / `aborted` 恒为空数组。 */
  citations: AssistantCitation[];
  /** `done.truncated`：三重上限任一命中。 */
  truncated: boolean;
  error: AssistantErrorInfo | null;
  slowFirstByte: boolean;
  /** 收到过 `seq` 跳变，提示可能丢帧。 */
  seqGap: boolean;
}

let turnSeq = 0;

function newTurn(role: AssistantTurn['role'], content = ''): AssistantTurn {
  turnSeq += 1;
  return {
    id: `turn_${turnSeq}`,
    role,
    content,
    phase: role === 'user' ? 'done' : 'pending',
    citations: [],
    truncated: false,
    error: null,
    slowFirstByte: false,
    seqGap: false,
  };
}

/**
 * 组本轮请求的 `messages`（全量历史 + 新问题）。
 * 空内容的助手回合（失败/取消且一个字没吐）会**跳过** —— 喂一个空 assistant 轮比为它留位更糟。
 */
function buildMessages(history: readonly AssistantTurn[], nextUserText: string): AssistantMessage[] {
  const messages: AssistantMessage[] = [];
  for (const turn of history) {
    if (turn.content === '') continue;
    messages.push({ role: turn.role, content: turn.content });
  }
  messages.push({ role: 'user', content: nextUserText });
  return messages;
}

export interface UseAssistantChatResult {
  turns: AssistantTurn[];
  /** 有在途请求（单流：同一时刻最多一条）。 */
  streaming: boolean;
  /** 正在跑的那条助手回合 id，供气泡显示取消按钮。 */
  activeTurnId: string | null;
  send: (text: string, logContext: AssistantLogContext | null) => void;
  /** 重放最后一个问题：丢弃其后内容，`seq` 从 1 重来（新请求新流）。 */
  retry: (logContext: AssistantLogContext | null) => void;
  cancel: () => void;
  clear: () => void;
}

export function useAssistantChat(): UseAssistantChatResult {
  // ref 是权威副本：流式回调在一个闭包里跑很多帧，不能依赖 state 的渲染时序。
  const turnsRef = useRef<AssistantTurn[]>([]);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef<string | null>(null);
  const firstByteTimerRef = useRef<number | null>(null);

  const commit = useCallback((updater: (prev: AssistantTurn[]) => AssistantTurn[]) => {
    turnsRef.current = updater(turnsRef.current);
    setTurns(turnsRef.current);
  }, []);

  const patchTurn = useCallback(
    (turnId: string, updater: (turn: AssistantTurn) => AssistantTurn) => {
      commit((prev) => prev.map((turn) => (turn.id === turnId ? updater(turn) : turn)));
    },
    [commit],
  );

  const clearFirstByteTimer = useCallback(() => {
    if (firstByteTimerRef.current !== null) {
      window.clearTimeout(firstByteTimerRef.current);
      firstByteTimerRef.current = null;
    }
  }, []);

  const runStream = useCallback(
    async (
      messages: AssistantMessage[],
      turnId: string,
      logContext: AssistantLogContext | null,
    ): Promise<void> => {
      const controller = new AbortController();
      abortRef.current = controller;
      activeTurnIdRef.current = turnId;
      setActiveTurnId(turnId);
      setStreaming(true);

      firstByteTimerRef.current = window.setTimeout(() => {
        patchTurn(turnId, (turn) =>
          turn.phase === 'pending' ? { ...turn, slowFirstByte: true } : turn,
        );
      }, FIRST_BYTE_SLOW_MS);

      const body: AssistantChatRequest = { messages };
      // `exactOptionalPropertyTypes`：空上下文就**不发这个字段**（省略 = 纯闲聊，§13.1）。
      if (logContext) body.logContext = logContext;

      /** `seq` 单请求内从 1 起单调递增；跳变即丢帧/乱序。 */
      let expectedSeq = 1;
      let sawTerminal = false;

      try {
        for await (const frame of streamAssistantChat(body, { signal: controller.signal })) {
          if (frame.seq !== expectedSeq) {
            patchTurn(turnId, (turn) => ({ ...turn, seqGap: true }));
          }
          expectedSeq = frame.seq + 1;

          if (frame.kind === 'delta') {
            clearFirstByteTimer();
            patchTurn(turnId, (turn) => ({
              ...turn,
              phase: 'streaming',
              slowFirstByte: false,
              content: turn.content + frame.text,
            }));
          } else if (frame.kind === 'done') {
            sawTerminal = true;
            patchTurn(turnId, (turn) => ({
              ...turn,
              phase: 'done',
              slowFirstByte: false,
              truncated: frame.truncated,
              citations: frame.citations,
              error: null,
            }));
          } else {
            sawTerminal = true;
            patchTurn(turnId, (turn) => ({
              ...turn,
              phase: 'error',
              slowFirstByte: false,
              error: {
                code: frame.code,
                message: frame.message,
                status: frame.status,
                retryAfterSec: frame.retryAfterSec,
              },
            }));
          }
        }

        if (!sawTerminal && !controller.signal.aborted) {
          // 服务端没发终止帧就断流 —— 不是「答完了」，是「话说一半」。
          patchTurn(turnId, (turn) => ({ ...turn, phase: 'interrupted', slowFirstByte: false }));
        }
      } catch (error) {
        if (controller.signal.aborted) {
          // 用户在 cancel() 里已经把 phase 写成 aborted，这里不覆盖。
        } else if (error instanceof ApiError) {
          const hasContent = (turnsRef.current.find((turn) => turn.id === turnId)?.content ?? '') !== '';
          patchTurn(turnId, (turn) => ({
            ...turn,
            // 开流后才坏（协议/传输）→ 算断流；一个字没收到就失败 → 算错误。
            phase: hasContent ? 'interrupted' : 'error',
            slowFirstByte: false,
            error: {
              code: error.code,
              message: error.message,
              status: error.status,
              retryAfterSec: null,
            },
          }));
        } else {
          const { code, message } = describeError(error);
          patchTurn(turnId, (turn) => ({
            ...turn,
            phase: 'interrupted',
            slowFirstByte: false,
            error: { code, message, status: 0, retryAfterSec: null },
          }));
        }
      } finally {
        clearFirstByteTimer();
        if (abortRef.current === controller) abortRef.current = null;
        activeTurnIdRef.current = null;
        setActiveTurnId(null);
        setStreaming(false);
      }
    },
    [clearFirstByteTimer, patchTurn],
  );

  const send = useCallback(
    (text: string, logContext: AssistantLogContext | null) => {
      const content = text.trim();
      if (content === '' || abortRef.current !== null) return;

      const history = buildMessages(turnsRef.current, content);
      const userTurn = newTurn('user', content);
      const assistantTurn = newTurn('assistant');
      commit((prev) => [...prev, userTurn, assistantTurn]);

      void runStream(history, assistantTurn.id, logContext);
    },
    [commit, runStream],
  );

  const retry = useCallback(
    (logContext: AssistantLogContext | null) => {
      if (abortRef.current !== null) return;

      const current = turnsRef.current;
      let lastUserIndex = -1;
      for (let i = current.length - 1; i >= 0; i -= 1) {
        if (current[i]?.role === 'user') {
          lastUserIndex = i;
          break;
        }
      }
      if (lastUserIndex === -1) return;

      const userTurn = current[lastUserIndex];
      if (!userTurn) return;

      const history = buildMessages(current.slice(0, lastUserIndex), userTurn.content);
      const assistantTurn = newTurn('assistant');
      commit((prev) => [...prev.slice(0, lastUserIndex + 1), assistantTurn]);

      void runStream(history, assistantTurn.id, logContext);
    },
    [commit, runStream],
  );

  const cancel = useCallback(() => {
    const controller = abortRef.current;
    const turnId = activeTurnIdRef.current;
    if (!controller) return;

    // 先落状态再 abort：abort 会让 for-await 抛 AbortError，catch 里按「已取消」放行。
    if (turnId !== null) {
      patchTurn(turnId, (turn) => ({ ...turn, phase: 'aborted', slowFirstByte: false }));
    }
    controller.abort();
  }, [patchTurn]);

  const clear = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    commit(() => []);
  }, [commit]);

  useEffect(
    () => () => {
      // 卸载即断上游：不 abort 就是白烧 token + 占住并发槽位（§13.4）。
      clearFirstByteTimer();
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [clearFirstByteTimer],
  );

  return { turns, streaming, activeTurnId, send, retry, cancel, clear };
}
