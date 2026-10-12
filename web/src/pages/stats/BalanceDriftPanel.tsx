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
import { Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import type { BalanceDrift, BalanceDriftAlert, BalanceDriftCode, BalanceSyncUpstreamState } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatCount, formatIso } from '@/utils/format';

const { Text } = Typography;

/**
 * 码 → 人话。**只说方向**，不换算金额。
 *
 * 导出是刻意的：横幅（`components/BalanceDriftBanner`）也要说这两个名字，
 * 而"有支出无流量"这五个字是**纪律文案**（不许写成"少了多少钱"），
 * 抄一份就是第二个事实源 —— 改一处漏一处的代价正好落在最不该出错的那句话上。
 */
export const DRIFT_CODE_TEXT: Record<BalanceDriftCode, { label: string; explain: string }> = {
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
        const meta = DRIFT_CODE_TEXT[code];
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
      width: 170,
      ellipsis: true,
      render: (upstreamId: string) => <Text style={{ fontSize: 13 }}>{nameOf(upstreamId)}</Text>,
    },
    {
      // 两个 ISO 时间串并排是这一行最宽的内容；不声明宽度时它会吃掉整行剩余宽度，
      // 把左边的「提示」标签挤到换行。声明后窄屏走横向滚动。
      title: '判定窗口',
      key: 'window',
      width: 330,
      render: (_: unknown, row) => (
        <Text type="secondary" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
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
      </Space>

      <Table<BalanceDriftAlert>
        rowKey={(row) => `${row.code}:${row.upstreamId}:${row.to}`}
        size="small"
        columns={columns}
        dataSource={drift.alerts}
        pagination={false}
        tableLayout="fixed"
        scroll={{ x: 650 }}
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
