/**
 * 指标卡。仪表盘四个总览卡共用。
 *
 * `stale=true` 用于实时通道断开时：数字整体降透明度并显式标注「非实时」，
 * 而不是继续把上一帧当实时值展示（契约 §7 前端契约）。
 */
import { Skeleton, Tooltip } from 'antd';
import type { ReactNode } from 'react';

import { tokens } from '@/theme/tokens';

export interface StatCardProps {
  label: string;
  value: ReactNode;
  /** 单位或口径说明，跟在数字后面。 */
  unit?: ReactNode;
  /** 底部小字：窗口口径、副指标。 */
  caption?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'error';
  loading?: boolean;
  stale?: boolean;
  /** 数值来源说明，悬浮可见。 */
  hint?: string;
}

const TONE_COLOR: Record<NonNullable<StatCardProps['tone']>, string> = {
  default: tokens.color.textPrimary,
  success: tokens.color.success,
  warning: tokens.color.warning,
  error: tokens.color.error,
};

export function StatCard({
  label,
  value,
  unit,
  caption,
  tone = 'default',
  loading = false,
  stale = false,
  hint,
}: StatCardProps) {
  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: tokens.space.lg,
        minHeight: 96,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: tokens.space.sm,
        opacity: stale && !loading ? 0.62 : 1,
        transition: `opacity ${tokens.motion.base} ${tokens.motion.easing}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.space.sm,
        }}
      >
        <span style={{ fontSize: 12, color: tokens.color.textSecondary }}>{label}</span>
        {stale && !loading ? (
          <Tooltip title="实时通道已断开，此数值为断开前的最后一帧，不是当前值。">
            <span style={{ fontSize: 11, color: tokens.color.warning }}>非实时</span>
          </Tooltip>
        ) : null}
      </div>

      {loading ? (
        <Skeleton.Input active size="small" style={{ width: 120, height: 26 }} />
      ) : (
        <Tooltip title={hint}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 6,
              color: TONE_COLOR[tone],
              fontSize: 24,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1.15,
            }}
          >
            <span>{value}</span>
            {unit ? (
              <span style={{ fontSize: 12, fontWeight: 400, color: tokens.color.textTertiary }}>
                {unit}
              </span>
            ) : null}
          </div>
        </Tooltip>
      )}

      <div style={{ fontSize: 12, color: tokens.color.textTertiary, minHeight: 18 }}>{caption}</div>
    </div>
  );
}
