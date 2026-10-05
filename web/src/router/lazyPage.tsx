import { Suspense, lazy, type ComponentType } from 'react';

import { LoadingState } from '@/components/states/StateBlock';

/**
 * 路由级分包包装。
 * 每个页面走独立 chunk，保证首屏只加载当前页（首屏 LCP 目标 < 2s）。
 */
export function lazyPage(factory: () => Promise<{ default: ComponentType }>) {
  const Lazy = lazy(factory);
  return (
    <Suspense fallback={<LoadingState tip="正在加载页面…" minHeight={320} />}>
      <Lazy />
    </Suspense>
  );
}
