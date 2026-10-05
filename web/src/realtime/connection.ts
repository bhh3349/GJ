/**
 * WS 连接状态（/api/stats/live）的运行态存储。
 * 真实状态由后续的 ws 客户端写入；在客户端落地前状态就是 'idle'（未连接），不伪造。
 */
import { useSyncExternalStore } from 'react';

export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting' | 'closed';

let status: ConnectionStatus = 'idle';
const listeners = new Set<() => void>();

export function setConnectionStatus(next: ConnectionStatus): void {
  if (next === status) return;
  status = next;
  for (const listener of listeners) listener();
}

export function getConnectionStatus(): ConnectionStatus {
  return status;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useConnectionStatus(): ConnectionStatus {
  return useSyncExternalStore(subscribe, getConnectionStatus, getConnectionStatus);
}
