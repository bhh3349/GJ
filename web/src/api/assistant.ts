/**
 * §13 内置 AI 助手聊天 —— SSE 传输层（契约 v1.2.0）。
 *
 * **为什么不用 `EventSource`**：它只支持 GET、带不了请求体与自定义头，而本节端点是
 * `POST` + JSON body + `X-Requested-With`（CSRF 第三道）。所以只能 `fetch` + `ReadableStream` 手解帧。
 *
 * 本层只做「字节 → `AssistantFrame`」的搬运与协议校验：
 * - **不缓冲整段回答** —— 增量逐帧往上传，不把 TTFB 拖到「生成完」；
 * - **不判业务收尾** —— 是否截断、要不要重试，由页面按 `done` / `error` 决定；
 * - **不自动重试** —— 重试是用户动作（契约 §13.2：重试 = 新请求、`seq` 从 1 重来）。
 *
 * 终止语义：服务端「恰好一个终止帧」。本层读到 `done` / `error` 即停止读取并释放连接；
 * 若流自然结束却没见到终止帧，调用方据「未收到终止帧」判**断流**（保留已收文本 + 可重试）。
 */
import { ApiError, notifyIfSessionExpired, type ApiErrorBody } from './http';
import type { AssistantChatRequest, AssistantCitation, AssistantFrame } from './types';

const ASSISTANT_CHAT_PATH = '/api/assistant/chat';

/** 客户端侧诊断码。**不是** §10 网关码值，永不出现在 SSE 帧里，只用于内联错态展示。 */
const STREAM_MALFORMED = 'STREAM_MALFORMED';

function protocolError(message: string): ApiError {
  return new ApiError(0, { code: STREAM_MALFORMED, message });
}

/** 裸 SSE 帧：`event:` 名 + 多行 `data:` 按规范用 `\n` 拼接后的载荷。 */
interface RawSseFrame {
  event: string;
  data: string;
}

/**
 * 找最早的帧分隔（空行）。
 * 两种行尾都要认：`\r\n\r\n` 里不含 `\n\n`，两条模式互斥，取下标更小的那个即可。
 * 跨 chunk 的 `\r` + `\n` 由「先拼进 buffer 再扫描」自然覆盖。
 */
function findBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/** 注释行（`:` 开头，心跳占位）与空行一律丢掉；返回 `null` 表示这帧没有内容。 */
function parseRawFrame(raw: string): RawSseFrame | null {
  let event = '';
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (event === '' && dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** citation 只信服务端给的结构；缺 `id` / `ts` 的条目直接丢，不补假值。 */
function readCitations(value: unknown): AssistantCitation[] {
  if (!Array.isArray(value)) return [];

  const citations: AssistantCitation[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = raw['id'];
    const ts = raw['ts'];
    if (typeof id !== 'string' || typeof ts !== 'string') continue;

    const gatewayCode = raw['gatewayCode'];
    const category = raw['category'];
    const severity = raw['severity'];
    const model = raw['model'];
    const summary = raw['summary'];

    citations.push({
      id,
      ts,
      gatewayCode: typeof gatewayCode === 'string' ? gatewayCode : null,
      category: typeof category === 'string' ? category : '',
      severity: severity === 'warn' ? 'warn' : 'error',
      model: typeof model === 'string' ? model : null,
      summary: typeof summary === 'string' ? summary : '',
    });
  }
  return citations;
}

/**
 * 帧 → 强类型事件。
 * 未知 `event:` 名一律**抛**而不是跳过：契约只冻结了三帧，静默丢帧会让回答悄悄缺一截。
 */
function toAssistantFrame(raw: RawSseFrame): AssistantFrame {
  const label = raw.event === '' ? '(缺 event:)' : raw.event;

  let payload: unknown;
  try {
    payload = JSON.parse(raw.data);
  } catch {
    throw protocolError(`SSE 帧 data 不是合法 JSON（event=${label}）`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw protocolError(`SSE 帧 data 不是对象（event=${label}）`);
  }

  const body = payload as Record<string, unknown>;
  const seq = body['seq'];
  if (typeof seq !== 'number' || !Number.isInteger(seq)) {
    throw protocolError(`SSE 帧缺少整数 seq（event=${label}）`);
  }

  switch (raw.event) {
    case 'delta': {
      const text = body['text'];
      // `text` 允许是空串（首字节占位 / 心跳），但类型必须是 string。
      if (typeof text !== 'string') throw protocolError('delta 帧的 text 不是 string');
      return { kind: 'delta', seq, text };
    }
    case 'done': {
      const citations = body['citations'];
      return {
        kind: 'done',
        seq,
        truncated: body['truncated'] === true,
        citations: readCitations(citations),
      };
    }
    case 'error': {
      const code = body['code'];
      const message = body['message'];
      const status = body['status'];
      const retryAfterSec = body['retryAfterSec'];
      if (typeof code !== 'string') throw protocolError('error 帧缺少 code');

      return {
        kind: 'error',
        seq,
        code,
        message: typeof message === 'string' ? message : '助手调用失败',
        // §13.2：`status` 是 §10 表里该码值的 HTTP 状态，不是本次响应状态（流已开恒 200）。
        status: typeof status === 'number' ? status : 0,
        retryAfterSec: typeof retryAfterSec === 'number' ? retryAfterSec : null,
      };
    }
    default:
      throw protocolError(`未知 SSE 事件名：${label}`);
  }
}

/** 未开流就失败的仍是 `{code, message}` 信封（401 / 403 / 400），与 `apiFetch` 同口径。 */
async function readErrorBody(response: Response): Promise<ApiErrorBody> {
  let parsed: unknown = null;
  try {
    const text = await response.text();
    if (text) parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }

  if (parsed !== null && typeof parsed === 'object' && 'code' in parsed && 'message' in parsed) {
    return parsed as ApiErrorBody;
  }
  return { code: `HTTP_${response.status}`, message: response.statusText || '请求失败' };
}

export interface AssistantStreamOptions {
  /** 用户点「取消」/ 组件卸载即 abort —— 必须一路传到 `fetch`，否则上游不会断。 */
  signal?: AbortSignal;
}

/**
 * 发一轮对话，逐帧产出。
 *
 * 用法前提（页面侧负责）：**全量发历史**，服务端裁剪并以 `done.truncated` 回报；
 * 前端**不**自己做上限裁剪，否则用户看到的截断原因会与服务端口径分叉。
 */
export async function* streamAssistantChat(
  body: AssistantChatRequest,
  options: AssistantStreamOptions = {},
): AsyncGenerator<AssistantFrame, void, void> {
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      // SSE 也是写请求：少了它会被 CSRF 校验挡在 403。
      'X-Requested-With': 'XMLHttpRequest',
    },
    credentials: 'include',
    body: JSON.stringify(body),
  };
  if (options.signal) init.signal = options.signal;

  let response: Response;
  try {
    response = await fetch(ASSISTANT_CHAT_PATH, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, {
      code: 'NETWORK_ERROR',
      message: '无法连接到管理面，请检查服务是否运行',
    });
  }

  if (!response.ok) {
    const errorBody = await readErrorBody(response);
    notifyIfSessionExpired(response.status, errorBody.code);
    throw new ApiError(response.status, errorBody);
  }

  const reader = response.body?.getReader();
  if (!reader) throw protocolError('响应没有可读流，SSE 未开启');

  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    let streamDone = false;
    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        // flush 残留多字节字符（UTF-8 汉字可能被 chunk 切开）。
        buffer += decoder.decode();
        streamDone = true;
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      let boundary = findBoundary(buffer);
      while (boundary !== null) {
        const rawText = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        boundary = findBoundary(buffer);

        const parsed = parseRawFrame(rawText);
        if (!parsed) continue;

        const frame = toAssistantFrame(parsed);
        yield frame;
        // 终止帧恰好一个：读到就收工，别等服务端关流。
        if (frame.kind !== 'delta') return;
      }
    }

    // 流自然结束：服务端最后一帧没有以空行收尾时，尾巴还得解一次。
    const tail = parseRawFrame(buffer);
    if (tail) {
      const frame = toAssistantFrame(tail);
      yield frame;
      if (frame.kind !== 'delta') return;
    }
  } finally {
    // 主动释放 socket，而不是等 GC（否则连接会挂到超时）。
    void reader.cancel().catch(() => undefined);
  }
}
