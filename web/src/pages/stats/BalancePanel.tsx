/**
 * 余额三口径下钻（`GET /api/stats/balance`）—— 全局 → 上游 → 单 key。
 *
 * 契约 §6 / ADR-0003 四条红线，这里逐条落地：
 * 1. 合计只统计 `category="balance"` 的 key，token-plan 类**不进金额**；
 * 2. 全局合计 = 各上游合计之和（所以这里不重算，直接显示后端给的数）；
 * 3. 任一层只要有未知项，`balanceUnknownKeyCount > 0` 必须单独呈现，**未知不得补 0**；
 * 4. 已软删的 key 不进任何合计与未知计数（后端已处理，前端不补人）。
 *
 * 金额一律走 `BalanceText`，`null` 显示「未知」而不是 ¥0.00。
 */
import { ReloadOutlined } from '@ant-design/icons';
import { Button, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { statsApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import type { BalanceKeyRow, BalanceScope } from '@/api/types';
import { BalanceText } from '@/components/BalanceText';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';
import { formatCount } from '@/utils/format';

const { Text } = Typography;

function CountCell({ value, tone }: { value: number | undefined; tone: 'default' | 'warning' }) {
  if (value === undefined) {
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        —
      </Text>
    );
  }
  return (
    <Text
      style={{
        fontSize: 12,
        fontVariantNumeric: 'tabular-nums',
        color: value > 0 && tone === 'warning' ? tokens.color.warning : tokens.color.textSecondary,
      }}
    >
      {formatCount(value)}
    </Text>
  );
}

const keyColumns: ColumnsType<BalanceKeyRow> = [
  {
    title: 'key',
    dataIndex: 'maskedKey',
    width: 110,
    render: (value: string) => (
      <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value}</Text>
    ),
  },
  {
    title: '余额',
    dataIndex: 'balance',
    width: 170,
    render: (_: unknown, row) => (
      <BalanceText
        value={row.balance}
        source={row.balanceSource ?? null}
        updatedAt={row.balanceUpdatedAt ?? null}
        showMeta
      />
    ),
  },
  {
    title: '是否计入合计',
    key: 'note',
    render: (_: unknown, row) =>
      row.balance === null ? (
        <Tooltip title="该 key 未录入余额，或上游查询不到。未知 ≠ 0，不计入合计。">
          <Tag bordered={false} style={{ marginInlineEnd: 0, background: tokens.tint.warning, color: tokens.color.warning }}>
            未计入
          </Tag>
        </Tooltip>
      ) : (
        <Tag bordered={false} style={{ marginInlineEnd: 0, background: tokens.tint.success, color: tokens.color.success }}>
          已计入
        </Tag>
      ),
  },
];

export function BalancePanel() {
  const balance = useResource(() => statsApi.balance(), []);
  const [expanded, setExpanded] = useState<readonly string[]>([]);

  const global = balance.data?.global;
  const rows = global?.byUpstream ?? [];

  const columns: ColumnsType<BalanceScope> = [
    {
      title: '上游',
      key: 'name',
      width: 220,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 13 }}>{row.name ?? row.upstreamId ?? '—'}</Text>
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>
            {row.upstreamId ?? ''}
          </Text>
        </div>
      ),
    },
    {
      title: '合计余额',
      dataIndex: 'totalBalance',
      width: 160,
      render: (_: unknown, row) => <BalanceText value={row.totalBalance} strong />,
    },
    {
      title: '计金额 key',
      dataIndex: 'balanceKeyCount',
      width: 110,
      render: (value: number | undefined) => <CountCell value={value} tone="default" />,
    },
    {
      title: '未知 key',
      dataIndex: 'balanceUnknownKeyCount',
      width: 110,
      render: (_: unknown, row) => (
        <Tooltip title="余额未知的 key 数量。未知不得补 0 计入合计，所以这里必须单独可见。">
          <span>
            <CountCell value={row.balanceUnknownKeyCount} tone="warning" />
          </span>
        </Tooltip>
      ),
    },
    {
      title: '套餐类 key',
      dataIndex: 'tokenPlanKeyCount',
      width: 120,
      render: (_: unknown, row) => (
        <Tooltip title="token-plan 类 key：不参与任何金额合计。">
          <span>
            <CountCell value={row.tokenPlanKeyCount} tone="default" />
          </span>
        </Tooltip>
      ),
    },
  ];

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: tokens.space.lg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.space.md,
          marginBottom: tokens.space.md,
        }}
      >
        <Space size={tokens.space.sm} align="center">
          <Text style={{ fontSize: 13, fontWeight: 600 }}>余额三口径</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            全局合计 = 各上游合计之和（后端给，不在前端重算）
          </Text>
        </Space>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={balance.refreshing}
          onClick={balance.reload}
        >
          刷新
        </Button>
      </div>

      {balance.error && balance.data ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState
            error={balance.error}
            onRetry={balance.reload}
            title="刷新失败，以下为上一次成功的数据"
          />
        </div>
      ) : null}

      {balance.loading ? (
        <LoadingState tip="正在加载余额…" minHeight={200} />
      ) : balance.error && !balance.data ? (
        <ErrorState
          error={balance.error}
          onRetry={balance.reload}
          variant="page"
          title="余额加载失败"
        />
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              gap: tokens.space.lg,
              paddingBottom: tokens.space.md,
              marginBottom: tokens.space.md,
              borderBottom: `1px solid ${tokens.color.border}`,
            }}
          >
            <div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                全局合计（balance 类 key）
              </Text>
              <span style={{ fontSize: 22, fontWeight: 600 }}>
                <BalanceText value={global?.totalBalance ?? null} strong />
              </span>
            </div>
            <Space size={tokens.space.lg} wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>
                计金额 key <CountCell value={global?.balanceKeyCount} tone="default" />
              </Text>
              <Tooltip title="余额未知的 key 数量（未知 ≠ 0，不计入合计）">
                <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                  未知 key <CountCell value={global?.balanceUnknownKeyCount} tone="warning" />
                </Text>
              </Tooltip>
              <Tooltip title="token-plan 类 key 不计入任何金额合计">
                <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                  套餐类 key <CountCell value={global?.tokenPlanKeyCount} tone="default" />
                </Text>
              </Tooltip>
              {global?.currency ? (
                <Tag
                  bordered={false}
                  style={{ marginInlineEnd: 0, background: tokens.tint.neutral, color: tokens.color.textSecondary }}
                >
                  币种 {global.currency}
                </Tag>
              ) : null}
            </Space>
          </div>

          <Table<BalanceScope>
            rowKey={(row) => row.upstreamId ?? row.name ?? 'unknown'}
            size="small"
            columns={columns}
            dataSource={rows}
            loading={balance.refreshing}
            pagination={false}
            expandable={{
              expandedRowKeys: [...expanded],
              onExpandedRowsChange: (keys) => setExpanded(keys.map(String)),
              expandedRowRender: (row) => (
                <Table<BalanceKeyRow>
                  rowKey="keyId"
                  size="small"
                  columns={keyColumns}
                  dataSource={row.keys ?? []}
                  pagination={false}
                  locale={{
                    emptyText: (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        该上游没有可用于金额统计的 key。
                      </Text>
                    ),
                  }}
                />
              ),
            }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有可统计余额的 key。"
                />
              ),
            }}
          />
        </>
      )}
    </div>
  );
}
