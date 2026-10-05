/**
 * WS 实时通道 `/api/stats/live` 客户端 —— 契约 §7 的逐条实现。
 *
 * 纪律：
 * - URL 里**不带 token**，会话走 Cookie（浏览器自动带）。
 * - 首帧发 `{"type":"auth"}`，**仅就绪确认**，不传任何凭据。
 * - 5s 内未收到 `ready` → 主动断开，服务端会给 `4408` → **重连一次**。
 * - 关闭码：`4401` 会话失效 → 跳登录；`1012` 服务重启 → 退避重连；`1000` 登出 → 不重连。
 * - 断线期间**不把旧帧当实时值**：`useLive()` 暴露 `status` 与 `lastFrameAt`，由页面据此降级呈现。
 */
import { SESSION_EXPIRED_EVENT } from '@/api/http';
import {
  WS_CLOSE,
  type LiveBalanceMessage,
  type LiveErrorMessage,
  type LiveKeyHealthMessage,
  type LiveMessage,
  type LiveMetricsMessage,
  type LiveReadyMessage,
  type LiveTaskMessage,
} from '@/api/types';

/** 实时通道运行态。`idle` = 尚未启动（如登录页）。 */
export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

/** 契约 §7：5s 内未就绪则断开。 */
const READY_TIMEOUT_MS = 5000;
/** 契约 §7：退避 1s→2s→4s→max 15s。 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15000;

export interface LiveSnapshot {
  status: ConnectionStatus;
  /** 最近一帧指标。断线后**不清空**，但 `status !== 'ready'` 时页面必须标注非实时。 */
  metrics: LiveMetricsMessage | null;
  /** 最近一次 ready 的 serverTime，用于判断帧的新鲜度。 */
  serverTime: string | null;
  intervalMs: number | null;
  /** 本地时钟收到最后一帧 metrics 的时刻（ms）。 */
  lastFrameAt: number | null;
  /** 按 keyId 收敛的最近健康态变化。 */
  keyHealth: Record<string, LiveKeyHealthMessage>;
  /** 按 keyId 收敛的最近余额变化（验收 3：5s 内呈现）。 */
  balances: Record<string, LiveBalanceMessage>;
  tasks: Record<string, LiveTaskMessage>;
  /** 服务端主动报错（`{type:"error"}`）的最近一条。 */
  lastError: LiveErrorMessage | null;
  /** 已发起的连接次数，便于排障。 */
  attempt: number;
}

const EMPTY: LiveSnapshot = {
  status: 'idle',
  metrics: null,
  serverTime: null,
  intervalMs: null,
  lastFrameAt: null,
  keyHealth: {},
  balances: {},
  tasks: {},
  lastError: null,
  attempt: 0,
};

let snapshot: LiveSnapshot = EMPTY;
const listeners = new Set<() => void>();
let socket: WebSocket | null = null;
let readyTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = BACKOFF_BASE_MS;
/** 4408 只重连一次：ready 成功后重新武装。 */
let readyRetryUsed = false;
let stopped = true;

function emit(patch: Partial<LiveSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function resolveUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/stats/live`;
}

function clearReadyTimer(): void {
  if (readyTimer !== null) {
    clearTimeout(readyTimer);
    readyTimer = null;
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer !== null) return;
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  emit({ status: 'reconnecting' });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function handleMessage(raw: string): void {
  let parsed: LiveMessage;
  try {
    parsed = JSON.parse(raw) as LiveMessage;
  } catch {
    return; // 非法帧直接丢，不污染状态。
  }

  switch (parsed.type) {
    case 'ready': {
      const ready: LiveReadyMessage = parsed;
      clearReadyTimer();
      readyRetryUsed = false;
      backoffMs = BACKOFF_BASE_MS;
      emit({ status: 'ready', serverTime: ready.serverTime, intervalMs: ready.intervalMs });
      break;
    }
    case 'metrics': {
      emit({
        metrics: parsed,
        serverTime: parsed.serverTime,
        lastFrameAt: Date.now(),
        status: 'ready',
      });
      break;
    }
    case 'key_health': {
      emit({ keyHealth: { ...snapshot.keyHealth, [parsed.keyId]: parsed } });
      break;
    }
    case 'balance': {
      emit({ balances: { ...snapshot.balances, [parsed.keyId]: parsed } });
      break;
    }
    case 'task': {
      emit({ tasks: { ...snapshot.tasks, [parsed.taskId]: parsed } });
      break;
    }
    case 'error': {
      emit({ lastError: parsed });
      break;
    }
    default:
      break;
  }
}

function connect(): void {
  if (stopped) return;
  emit({ status: 'connecting', attempt: snapshot.attempt + 1 });

  let ws: WebSocket;
  try {
    ws = new WebSocket(resolveUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    // 首帧仅作就绪确认，不传 token。
    ws.send(JSON.stringify({ type: 'auth' }));
    clearReadyTimer();
    readyTimer = setTimeout(() => {
      // 5s 未就绪：主动断开。服务端也会关（4408），onclose 里走「重连一次」分支。
      emit({ status: 'reconnecting' });
      ws.close(WS_CLOSE.READY_TIMEOUT, 'ready timeout');
    }, READY_TIMEOUT_MS);
  };

  ws.onmessage = (event: MessageEvent<string>) => {
    if (socket !== ws) return;
    if (typeof event.data === 'string') handleMessage(event.data);
  };

  ws.onerror = () => {
    // onerror 后必然跟 onclose，重连逻辑只放在 onclose，避免双触发。
  };

  ws.onclose = (event: CloseEvent) => {
    if (socket !== ws) return;
    socket = null;
    clearReadyTimer();

    if (stopped) {
      emit({ status: 'closed' });
      return;
    }

    switch (event.code) {
      case WS_CLOSE.SESSION_EXPIRED: {
        // 会话失效：不再重连，交给路由层跳登录。
        stopped = true;
        emit({ status: 'closed' });
        window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, { detail: 'SESSION_EXPIRED' }));
        return;
      }
      case WS_CLOSE.NORMAL: {
        // 正常关闭（登出）：不重连。
        stopped = true;
        emit({ status: 'closed' });
        return;
      }
      case WS_CLOSE.READY_TIMEOUT: {
        if (!readyRetryUsed) {
          readyRetryUsed = true;
          emit({ status: 'reconnecting' });
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, BACKOFF_BASE_MS);
          return;
        }
        scheduleReconnect();
        return;
      }
      case WS_CLOSE.SERVICE_RESTART: {
        scheduleReconnect();
        return;
      }
      default: {
        // 1006 等异常断开（含管理面未启动）：按退避重连，恢复后自动续上。
        scheduleReconnect();
      }
    }
  };
}

/** 登录后的受保护布局里启动。重复调用是幂等的。 */
export function startLive(): void {
  if (!stopped) return;
  stopped = false;
  readyRetryUsed = false;
  backoffMs = BACKOFF_BASE_MS;
  connect();
}

/** 退出登录或离开受保护区域时调用。 */
export function stopLive(): void {
  stopped = true;
  readyRetryUsed = false;
  clearReadyTimer();
  clearReconnectTimer();
  const ws = socket;
  socket = null;
  if (ws) {
    // 摘掉回调，避免 stop 触发 onclose 又把状态改回去。
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close(WS_CLOSE.NORMAL, 'client stop');
    } catch {
      /* 忽略关闭异常 */
    }
  }
  emit({ status: 'closed' });
}

/** 登出时清掉上一会话残留的帧，避免下一个账号看到别人的数字。 */
export function resetLiveData(): void {
  snapshot = { ...EMPTY, status: snapshot.status };
  for (const listener of listeners) listener();
}

export function subscribeLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLiveSnapshot(): LiveSnapshot {
  return snapshot;
}

/** 帧是否新鲜：只有 `ready` 且最近一帧在 3× 间隔内，才算实时值。 */
export function isLiveFresh(snap: LiveSnapshot = snapshot): boolean {
  if (snap.status !== 'ready' || snap.lastFrameAt === null) return false;
  const interval = snap.intervalMs ?? 1000;
  return Date.now() - snap.lastFrameAt <= Math.max(interval * 3, 3000);
}
