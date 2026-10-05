/**
 * 订阅实时通道快照。用 `useSyncExternalStore` 直接读 live.ts 的单例状态，
 * 不引入额外状态库，也不做二次缓存（二次缓存会让「断线后展示旧值」变得难以察觉）。
 */
import { useSyncExternalStore } from 'react';

import { getLiveSnapshot, subscribeLive, type LiveSnapshot } from './live';

export function useLive(): LiveSnapshot {
  return useSyncExternalStore(subscribeLive, getLiveSnapshot, getLiveSnapshot);
}
