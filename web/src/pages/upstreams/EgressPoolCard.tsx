/**
 * 出口池卡片 —— 消费 §7 池级差分帧 `egress_pool`（v1.6.4 登记；producer 与发射缝已随
 * ② 收口笔 `308804a` 合 main，本卡是 ③ 接线笔）。
 *
 * 三态**不可塌缩成两态**（契约 §7 纪律一）：
 * - **从未收到帧**（`snapshot.egressPool === null`）= 未接线 / 未发射 ⇒ **缺省不是证据**，
 *   这里只显示"等待首帧"，**不得**渲染「0 个出口」或「全部离线」；
 * - **`nodes: []`** = 已接线且当前 0 个出口 ⇒ 「未配置出口」空态（是事实，不是故障）；
 * - **`nodes` 有值** = 正常渲染，N 节点自适应（长度由后端给，前端不写死、不按节点数自推池容量）。
 *
 * 两条展示红线：
 * 1. `exitIp ≠ expectedExitIp` 必须显式标红告警 —— 这是「填了代理但流量仍走宿主 IP」这类
 *    静默故障**唯一的告警点**，丢了它配错代理等于全绿。
 * 2. `status`（探活态）与 `cooldownUntil`（上游限流态）是**两种不可用**，**并列成列展示**，
 *    不得合成"健康分"、不得用一个盖住另一个。
 *
 * 前端不合成健康态：`status` 只由探活链给出，**不得**按 `lastHeartbeatAt` 的"新鲜度"自算。
 * 断线期间不把旧帧当实时值：非 ready 时表头显式标注"快照可能已过期"。
 * 依旧**不从 REST 取出口状态**（`egress_id` 不进任何 DTO，§15.12 锚 3）。
 */
import { Alert, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';

import type { EgressPoolNode } from '@/api/types';
import { useLive } from '@/realtime/useLive';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

function formatTime(iso: string | null): string {
  if (iso === null) return '—';
  // 契约发 ISO8601 UTC 绝对时刻；展示按本地时区渲染。
  return dayjs(iso).format('HH:mm:ss');
}

function StatusTag({ node }: { node: EgressPoolNode }) {
  const online = node.status === 'online';
  return (
    <Tag
      bordered={false}
      style={{
        marginInlineEnd: 0,
        background: online ? tokens.tint.success : tokens.tint.error,
        color: online ? tokens.color.success : tokens.color.error,
      }}
    >
      {online ? '在线' : '离线'}
    </Tag>
  );
}

export function EgressPoolCard() {
  const live = useLive();
  const frame = live.egressPool;

  const columns: ColumnsType<EgressPoolNode> = [
    {
      title: '出口',
      dataIndex: 'name',
      width: 160,
      render: (value: string, node) => (
        <Tooltip title={`egressId: ${node.egressId}（不透明键，前端不解析）`}>
          <Text style={{ fontSize: 12, fontWeight: 600 }}>{value}</Text>
        </Tooltip>
      ),
    },
    {
      title: '探活态',
      key: 'status',
      width: 90,
      render: (_, node) => <StatusTag node={node} />,
    },
    {
      /** 与探活态**并列**、不合并：冷却中的节点探活可以仍是 online，两列各说各的事。 */
      title: '限流冷却',
      key: 'cooldown',
      width: 150,
      render: (_, node) => {
        if (node.cooldownUntil === null) return <Text type="secondary">—</Text>;
        const active = dayjs(node.cooldownUntil).valueOf() > dayjs().valueOf();
        return (
          <Tag
            bordered={false}
            style={{
              marginInlineEnd: 0,
              background: active ? tokens.tint.warning : tokens.tint.neutral,
              color: active ? tokens.color.warning : tokens.color.textTertiary,
            }}
          >
            {active
              ? `冷却至 ${formatTime(node.cooldownUntil)}`
              : `已到期 ${formatTime(node.cooldownUntil)}`}
          </Tag>
        );
      },
    },
    {
      title: '出口 IP',
      key: 'exitIp',
      render: (_, node) => {
        const mismatch =
          node.exitIp !== null &&
          node.expectedExitIp !== null &&
          node.exitIp !== node.expectedExitIp;
        if (mismatch) {
          return (
            <Space size={tokens.space.xs} wrap>
              <Text
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 12,
                  color: tokens.color.error,
                  fontWeight: 600,
                }}
              >
                {node.exitIp}
              </Text>
              <Text
                style={{
                  fontFamily: tokens.font.mono,
                  fontSize: 12,
                  color: tokens.color.textTertiary,
                }}
              >
                ≠ 期望 {node.expectedExitIp}
              </Text>
            </Space>
          );
        }
        return (
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>
            {node.exitIp ?? '未带回'}
          </Text>
        );
      },
    },
    {
      title: '最近心跳',
      dataIndex: 'lastHeartbeatAt',
      width: 100,
      render: (value: string | null) => (
        <Tooltip title={value ?? '冷启动，尚无真证据'}>
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{formatTime(value)}</Text>
        </Tooltip>
      ),
    },
  ];

  const shell = (children: ReactNode) => (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: tokens.space.lg,
      }}
    >
      {children}
    </div>
  );

  const header = (label: string, tone: 'neutral' | 'info') => (
    <Space size={tokens.space.sm} align="center" wrap style={{ marginBottom: tokens.space.md }}>
      <Text style={{ fontSize: 13, fontWeight: 600 }}>出口池</Text>
      <Tag
        bordered={false}
        style={{
          marginInlineEnd: 0,
          background: tone === 'info' ? tokens.tint.info : tokens.tint.neutral,
          color: tone === 'info' ? tokens.color.info : tokens.color.textSecondary,
        }}
      >
        {label}
      </Tag>
    </Space>
  );

  // ── 三态渲染 ────────────────────────────────────────────────────────────

  // 态一：从未收到池帧 = 未接线 / 未发射。缺省不是证据 —— 不推断出口数量。
  if (frame === null) {
    return shell(
      <>
        {header('等待首帧', 'neutral')}
        <Alert
          type="info"
          showIcon
          style={{ background: tokens.tint.neutral, border: 'none' }}
          message={
            <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
              尚未收到 §7 池级帧 <Text code>egress_pool</Text>。收不到帧只说明「未接线 /
              未发射」—— 缺省不是证据，这里不推断出口数量，也不显示「0 个出口」或「全部离线」。
            </Text>
          }
        />
      </>,
    );
  }

  // 态二：已接线、当前 0 个出口 = 「未配置出口」空态（这是事实，不是故障）。
  if (frame.nodes.length === 0) {
    return shell(
      <>
        {header('已接线 · 0 个出口', 'neutral')}
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Text type="secondary" style={{ fontSize: 12 }}>
              未配置出口 —— 通道已接线且回报池为空，不是离线故障。
            </Text>
          }
        />
      </>,
    );
  }

  // 态三：有节点，正常渲染（N 自适应，不写死数量）。
  const stale = live.status !== 'ready';
  const anyMismatch = frame.nodes.some(
    (n) => n.exitIp !== null && n.expectedExitIp !== null && n.exitIp !== n.expectedExitIp,
  );
  return shell(
    <>
      <Space size={tokens.space.sm} align="center" wrap style={{ marginBottom: tokens.space.md }}>
        <Text style={{ fontSize: 13, fontWeight: 600 }}>出口池</Text>
        <Tag
          bordered={false}
          style={{ marginInlineEnd: 0, background: tokens.tint.info, color: tokens.color.info }}
        >
          {frame.nodes.length} 个出口
        </Tag>
        {stale ? (
          <Tag
            bordered={false}
            style={{
              marginInlineEnd: 0,
              background: tokens.tint.warning,
              color: tokens.color.warning,
            }}
          >
            连接 {live.status} · 快照可能已过期
          </Tag>
        ) : null}
      </Space>

      {anyMismatch ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: tokens.space.md, background: tokens.tint.error, border: 'none' }}
          message={
            <Text style={{ fontSize: 12, color: tokens.color.error }}>
              有出口的实测 IP 与登记期望值不符 —— 可能「填了代理但流量仍走宿主 IP」。
              这是该静默故障唯一的告警点，不可忽略。
            </Text>
          }
        />
      ) : null}

      <Table<EgressPoolNode>
        rowKey="egressId"
        size="small"
        columns={columns}
        dataSource={frame.nodes}
        pagination={false}
      />
    </>,
  );
}
