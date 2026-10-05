import { Badge, Tooltip } from 'antd';

import { type ConnectionStatus } from '@/realtime/live';
import { useLive } from '@/realtime/useLive';
import { tokens } from '@/theme/tokens';

const LABELS: Record<ConnectionStatus, { text: string; color: string; hint: string }> = {
  idle: { text: '未连接', color: tokens.color.textTertiary, hint: '实时通道尚未建立' },
  connecting: { text: '连接中', color: tokens.color.warning, hint: '正在建立 /api/stats/live' },
  ready: { text: '实时', color: tokens.color.success, hint: '实时推送已就绪（1s 一帧）' },
  reconnecting: {
    text: '已断开·重连中',
    color: tokens.color.error,
    hint: '通道中断，退避重连中；期间页面上的数字不是实时值',
  },
  closed: { text: '已断开', color: tokens.color.error, hint: '实时通道已关闭，不会自动重连' },
};

/** 顶栏实时通道指示灯。状态来自真实 WS 运行态，不做装饰。 */
export function ConnectionBadge() {
  const { status } = useLive();
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
