/**
 * 余额漂移提示面板（契约 §14.4）。
 *
 * **这一格的全部纪律就是"不判钱"** —— 契约逐字写着：本地**没有单价**
 * （`usage_logs` 只有 token、`balance` 只有分，两者没有可比量纲），
 * 所以判据只用**方向 + 零/非零**，**不做量级比较、不判"对不对得上账"**。
 * 任何"少了多少钱""疑似被偷跑"的文案都是越界，本组件不得出现。
 *
 * 三条显示规则：
 * 1. 漂移是 **warn 级非破坏**提示 —— 不拦请求、不改任何数，所以**不用错误态红色**渲染整体，
 *    也不提供任何"修复/重算"按钮（没有那样的端点）。
 * 2. `counts` 是**进程内计数**（重启归零、`balance_drift_total{code}`），与下方 `alerts`
 *    （窗口内、上限 20 条）**不是一回事**，两者分开标注，别混成一个数。
 * 3. 余额**上升不告警**（充值 / 上游按周期重置都正常），后端也不会给这样的 alert。
 */
import { Alert, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import type { BalanceDrift, BalanceDriftAlert, BalanceDriftCode, BalanceSyncUpstreamState } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatCount, formatIso } from '@/utils/format';

const { Text } = Typography;

/** 码 → 人话。**只说方向**，不换算金额。 */
const CODE_TEXT: Record<BalanceDriftCode, { label: string; explain: string }> = {
  BALANCE_SPENT_WITHOUT_TRAFFIC: {
    label: '有支出无流量',
    explain: '余额下降 > 0，而同窗口本网关 token 用量 = 0。可能：同一把 key 被别处直连在用，或上游改了口径。',
  },
  BALANCE_UNCHANGED_WITH_TRAFFIC: {
    label: '有流量余额不变',
    explain: '余额差额 = 0，而同窗口 token 用量 > 0。可能：查得值是缓存 / 套餐口径，或查询端点已失效、一直在回陈旧值。',
  },
};

export interface BalanceDriftPanelProps {
  drift: BalanceDrift;
  /** 用于把 `upstreamId` 换成人能读的名字；取不到就退回 id（**不编名字**）。 */
  upstreams: readonly BalanceSyncUpstreamState[];
}

export function BalanceDriftPanel({ drift, upstreams }: BalanceDriftPanelProps) {
  const nameOf = (upstreamId: string): string =>
    upstreams.find((item) => item.upstreamId === upstreamId)?.name ?? upstreamId;

  const columns: ColumnsType<BalanceDriftAlert> = [
    {
      title: '提示',
      dataIndex: 'code',
      width: 150,
      render: (code: BalanceDriftCode) => {
        const meta = CODE_TEXT[code];
        return (
          <Tooltip title={meta.explain}>
            <Tag
              bordered={false}
              style={{ marginInlineEnd: 0, background: tokens.tint.warning, color: tokens.color.warning }}
            >
              {meta.label}
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '上游',
      dataIndex: 'upstreamId',
      render: (upstreamId: string) => <Text style={{ fontSize: 13 }}>{nameOf(upstreamId)}</Text>,
    },
    {
      title: '判定窗口',
      key: 'window',
      render: (_: unknown, row) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {formatIso(row.from)} → {formatIso(row.to)}
        </Text>
      ),
    },
    {
      title: (
        <Tooltip title="该窗口内本网关的 token 用量（上游级，不按 key 过滤）。本地无单价，所以它只用来区分「零 / 非零」，不与金额比较。">
          <span>窗口内 tokens</span>
        </Tooltip>
      ),
      dataIndex: 'usedTokens',
      width: 130,
      align: 'right',
      render: (value: number) => (
        <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{formatCount(value)}</Text>
      ),
    },
  ];

  const spent = drift.counts.BALANCE_SPENT_WITHOUT_TRAFFIC ?? 0;
  const unchanged = drift.counts.BALANCE_UNCHANGED_WITH_TRAFFIC ?? 0;

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: tokens.space.lg,
      }}
    >
      <div style={{ marginBottom: tokens.space.md }}>
        <Space size={tokens.space.sm} align="center" wrap>
          <Text style={{ fontSize: 13, fontWeight: 600 }}>余额漂移提示</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            方向级 · 只提示不判钱（本地无单价）
          </Text>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: tokens.space.md, background: tokens.tint.neutral, border: 'none' }}
        message={
          <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
            判据只用「余额方向 + token 用量是否为零」，口径为上游级快照对比。它并不表示账目对不上，
            也不代表有任何请求被拦截 —— 漂移只 warn + 计数，不拦请求、不改任何数。
          </Text>
        }
      />

      <Space size={tokens.space.lg} wrap style={{ marginBottom: tokens.space.md }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          进程内累计 · 有支出无流量{' '}
          <Text style={{ fontSize: 12, color: spent > 0 ? tokens.color.warning : tokens.color.textSecondary }}>
            {formatCount(spent)}
          </Text>
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          进程内累计 · 有流量余额不变{' '}
          <Text
            style={{ fontSize: 12, color: unchanged > 0 ? tokens.color.warning : tokens.color.textSecondary }}
          >
            {formatCount(unchanged)}
          </Text>
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          重启归零，与下方窗口内条目不是同一个计数
        </Text>
      </Space>

      <Table<BalanceDriftAlert>
        rowKey={(row) => `${row.code}:${row.upstreamId}:${row.to}`}
        size="small"
        columns={columns}
        dataSource={drift.alerts}
        pagination={false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {`窗口（自 ${formatIso(drift.since)} 起）内没有漂移提示。`}
                </Text>
              }
            />
          ),
        }}
      />
    </div>
  );
}
