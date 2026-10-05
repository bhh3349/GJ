import { Badge, Tooltip } from 'antd';

import { useConnectionStatus, type ConnectionStatus } from '@/realtime/connection';
import { tokens } from '@/theme/tokens';

const LABELS: Record<ConnectionStatus, { text: string; color: string; hint: string }> = {
  idle: { text: '未连接', color: tokens.color.textTertiary, hint: '实时通道尚未建立' },
  connecting: { text: '连接中', color: tokens.color.warning, hint: '正在建立 /api/stats/live' },
  ready: { text: '实时', color: tokens.color.success, hint: '实时推送已就绪' },
  reconnecting: { text: '重连中', color: tokens.color.warning, hint: '连接中断，正在退避重连' },
  closed: { text: '已断开', color: tokens.color.error, hint: '实时通道已关闭' },
};

/** 顶栏实时通道指示灯。状态来自真实 WS 运行态，不做装饰。 */
export function ConnectionBadge() {
  const status = useConnectionStatus();
  const meta = LABELS[status];

  return (
    <Tooltip title={meta.hint}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: tokens.space.sm,
          fontSize: 12,
          color: tokens.color.textSecondary,
        }}
      >
        <Badge color={meta.color} />
        {meta.text}
      </span>
    </Tooltip>
  );
}
