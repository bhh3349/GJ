import type { ReactNode } from 'react';

import { tokens } from '@/theme/tokens';

export interface PageHeaderProps {
  title: string;
  description?: string | undefined;
  extra?: ReactNode;
}

/** 页头：全站统一标题区，避免各页自己拼 Typography。 */
export function PageHeader({ title, description, extra }: PageHeaderProps) {
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
        {description ? (
          <div
            style={{
              marginTop: tokens.space.xs,
              fontSize: 12,
              color: tokens.color.textTertiary,
            }}
          >
            {description}
          </div>
        ) : null}
      </div>
      {extra ? <div>{extra}</div> : null}
    </div>
  );
}
