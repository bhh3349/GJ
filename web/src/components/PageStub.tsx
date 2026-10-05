import type { ReactNode } from 'react';

import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/states/StateBlock';

export interface PageStubProps {
  title: string;
  description?: string;
  /** 该页最终要承载的能力清单，冻结契约后逐条落地替换本占位 */
  pending: readonly string[];
  extra?: ReactNode;
}

/**
 * 页面占位骨架。
 * 硬约束：禁止假数据 —— 契约未冻结前页面呈现真实空态 + 待接清单，不放任何编造的指标/列表。
 */
export function PageStub({ title, description, pending, extra }: PageStubProps) {
  return (
    <>
      <PageHeader title={title} description={description} extra={extra} />
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--bg-container)',
        }}
      >
        <EmptyState
          title="等待 docs/api-contract.md 冻结"
          description={
            <div>
              <div>本页为真实空态，未使用任何 mock 数据。</div>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18, textAlign: 'left' }}>
                {pending.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          }
          minHeight={320}
        />
      </div>
    </>
  );
}
