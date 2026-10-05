/**
 * 余额展示 —— 契约里的「防造假」红线在 UI 上的唯一出口。
 *
 * `null`（未知）与 `0`（确实是 0）必须是两种观感和两种文案：
 * - `null` → 灰字「未知」+ 悬浮说明，**不显示金额符号**；
 * - `0`    → 正常金额「¥0.00」。
 * 任何页面都不得绕过本组件自行渲染余额。
 */
import { Tag, Tooltip, Typography } from 'antd';

import type { BalanceSource, Cents } from '@/api/types';
import { formatBalance, formatRelative } from '@/utils/format';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

const SOURCE_LABEL: Record<BalanceSource, string> = {
  manual: '手动',
  template: '模板',
};

const SOURCE_HINT: Record<BalanceSource, string> = {
  manual: '人工录入（优先于模板查询结果，见契约 C5）',
  template: '按上游余额查询模板取回',
};

export interface BalanceTextProps {
  value: Cents | null | undefined;
  currency?: string | undefined;
  source?: BalanceSource | null | undefined;
  updatedAt?: string | null | undefined;
  /** 是否附带来源/更新时间标注。列表里建议关闭。 */
  showMeta?: boolean;
  strong?: boolean;
}

export function BalanceText({
  value,
  currency = 'CNY',
  source = null,
  updatedAt = null,
  showMeta = false,
  strong = false,
}: BalanceTextProps) {
  const unknown = value === null || value === undefined;

  const text = unknown ? (
    <Tooltip title="余额未知：尚未录入，或上游查询不到。未知 ≠ 0，不计入任何合计。">
      <Text type="secondary" italic>
        未知
      </Text>
    </Tooltip>
  ) : (
    <Text strong={strong} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {formatBalance(value, currency)}
    </Text>
  );

  if (!showMeta) return text;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.space.sm }}>
      {text}
      {source ? (
        <Tooltip title={SOURCE_HINT[source]}>
          <Tag
            bordered={false}
            style={{ marginInlineEnd: 0, background: tokens.tint.neutral, color: tokens.color.textSecondary }}
          >
            {SOURCE_LABEL[source]}
          </Tag>
        </Tooltip>
      ) : null}
      {updatedAt ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {formatRelative(updatedAt)}
        </Text>
      ) : null}
    </span>
  );
}
