/** Bo 指示（2026-10-11）：全站页头不带小字提示。 */
import type { ReactNode } from 'react';

import { tokens } from '@/theme/tokens';

export interface PageHeaderProps {
  title: string;
  description?: string | undefined;
  extra?: ReactNode;
}

/**
 * 页头：全站统一标题区，避免各页自己拼 Typography。
 * description 是形参兼容：各页已按 Bo 指示不再传小字，仅历史调用可传、不再渲染。
 */
export function PageHeader({ title, extra }: PageHeaderProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: tokens.space.md,
        marginBottom: tokens.space.lg,
      }}
    >
      <div>
        <h1
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 600,
            letterSpacing: '-0.01em',
            color: tokens.color.textPrimary,
          }}
        >
          {title}
        </h1>
      </div>
      {extra ? <div>{extra}</div> : null}
    </div>
  );
}
