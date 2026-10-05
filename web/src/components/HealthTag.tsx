/**
 * Key 健康态标签。`health` 是网关运行态，**管理端只读**（契约 §9）。
 * 冷却中的 key 要把剩余时间直接写在标签上，避免管理员去别处换算。
 */
import { Tag, Tooltip } from 'antd';

import type { FailureReason, KeyHealth } from '@/api/types';
import { formatCooldown } from '@/utils/format';
import { tokens } from '@/theme/tokens';

const HEALTH_META: Record<KeyHealth, { text: string; color: string; bg: string; hint: string }> = {
  healthy: {
    text: '健康',
    color: tokens.color.success,
    bg: tokens.tint.success,
    hint: '网关当前可用',
  },
  cooling: {
    text: '冷却中',
    color: tokens.color.warning,
    bg: tokens.tint.warning,
    hint: '连续失败触发冷却，到期后半开重试',
  },
  disabled: {
    text: '已禁用',
    color: tokens.color.textTertiary,
    bg: tokens.tint.neutral,
    hint: '管理端 enabled=false，网关不再选用',
  },
};

/** 契约 §10：只有这五类计入 key 失败。 */
const REASON_LABEL: Record<FailureReason, string> = {
  AUTH_INVALID: '凭据无效',
  RATE_LIMITED: '上游限流',
  INSUFFICIENT_BALANCE: '余额不足',
  UPSTREAM_ERROR: '上游错误',
  NETWORK: '网络异常',
};

export interface HealthTagProps {
  health: KeyHealth;
  cooldownUntil?: string | null | undefined;
  lastFailureReason?: FailureReason | null | undefined;
  consecutiveFailures?: number | undefined;
}

export function HealthTag({
  health,
  cooldownUntil = null,
  lastFailureReason = null,
  consecutiveFailures = 0,
}: HealthTagProps) {
  const meta = HEALTH_META[health];
  const cooldown = health === 'cooling' ? formatCooldown(cooldownUntil) : null;

  const hintParts = [meta.hint];
  if (health === 'cooling' && cooldown) hintParts.push(`解冻倒计时 ${cooldown}`);
  if (consecutiveFailures > 0) hintParts.push(`连续失败 ${consecutiveFailures} 次`);
  if (lastFailureReason) hintParts.push(`最近失败原因：${REASON_LABEL[lastFailureReason]}`);

  return (
    <Tooltip title={hintParts.join('；')}>
      <Tag
        bordered={false}
        style={{ marginInlineEnd: 0, color: meta.color, background: meta.bg, whiteSpace: 'nowrap' }}
      >
        {meta.text}
        {cooldown ? ` · ${cooldown}` : ''}
      </Tag>
    </Tooltip>
  );
}

export function failureReasonLabel(reason: FailureReason | null | undefined): string {
  return reason ? REASON_LABEL[reason] : '—';
}
