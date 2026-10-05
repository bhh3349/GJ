import { Alert, Button, Empty, Result, Spin, Typography } from 'antd';
import type { ReactNode } from 'react';

import { describeError } from '@/api/http';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

export interface LoadingStateProps {
  tip?: string;
  minHeight?: number;
}

/** 加载态：所有异步区块必须用它，禁止裸 Spin 或空白。 */
export function LoadingState({ tip = '加载中…', minHeight = 240 }: LoadingStateProps) {
  return (
    <div
      style={{
        minHeight,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.space.md,
      }}
    >
      <Spin size="large" />
      <Text type="secondary">{tip}</Text>
    </div>
  );
}

export interface EmptyStateProps {
  title?: string;
  description?: ReactNode;
  action?: ReactNode;
  minHeight?: number;
}

/** 空态：区分「确实没有数据」与「还没接上数据源」，文案由调用方给，不写假数据。 */
export function EmptyState({
  title = '暂无数据',
  description,
  action,
  minHeight = 240,
}: EmptyStateProps) {
  return (
    <div
      style={{
        minHeight,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <div style={{ maxWidth: 420 }}>
            <div style={{ color: tokens.color.textPrimary, fontWeight: 500 }}>{title}</div>
            {description ? (
              <div style={{ color: tokens.color.textTertiary, marginTop: tokens.space.xs }}>
                {description}
              </div>
            ) : null}
          </div>
        }
      >
        {action}
      </Empty>
    </div>
  );
}

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  minHeight?: number;
  /** 401/会话失效时展示整页结果页而不是内联块 */
  variant?: 'inline' | 'page';
}

/** 错态：统一收口 ApiError / 网络错误，永远带可重试入口。 */
export function ErrorState({
  error,
  onRetry,
  title = '加载失败',
  minHeight = 240,
  variant = 'inline',
}: ErrorStateProps) {
  const { code, message } = describeError(error);

  if (variant === 'page') {
    return (
      <Result
        status="error"
        title={title}
        subTitle={message}
        extra={
          onRetry ? (
            <Button type="primary" onClick={onRetry}>
              重试
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <div style={{ minHeight, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Alert
        type="error"
        showIcon
        style={{ maxWidth: 520 }}
        message={title}
        description={
          <div>
            <div>{message}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              错误码：{code}
            </Text>
          </div>
        }
        action={
          onRetry ? (
            <Button size="small" onClick={onRetry}>
              重试
            </Button>
          ) : null
        }
      />
    </div>
  );
}
