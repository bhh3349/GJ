/**
 * 仪表盘 —— QPS / 成功率 / 余额总览 / key 健康状态。
 *
 * 数据来源两条，口径写在契约里，页面必须尊重：
 * 1. `GET /api/stats/overview?window=` 给**快照**（含后端算好的 `window`，前端不得自算 QPS）；
 * 2. `WS /api/stats/live` 给**每秒一帧**的实时值。
 *
 * 断线纪律（契约 §7）：通道不新鲜时**退回快照并标注**，绝不把上一帧当实时值继续展示。
 */
import { ReloadOutlined } from '@ant-design/icons';
import { Button, Empty, Segmented, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useEffect, useMemo, useRef, useState } from 'react';

import { statsApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import type { KeyHealth, KeyHealthRow, StatsWindow } from '@/api/types';
import { BalanceText } from '@/components/BalanceText';
import { HealthTag } from '@/components/HealthTag';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { isLiveFresh } from '@/realtime/live';
import { useLive } from '@/realtime/useLive';
import { tokens } from '@/theme/tokens';
import { formatCompact, formatCount, formatIso, formatPercent } from '@/utils/format';

const WINDOWS: readonly StatsWindow[] = ['60s', '5m', '15m', '1h'];

const { Text } = Typography;

function healthCounts(rows: readonly KeyHealthRow[]): Record<KeyHealth, number> {
  const counts: Record<KeyHealth, number> = { healthy: 0, cooling: 0, disabled: 0 };
  for (const row of rows) counts[row.health] += 1;
  return counts;
}

export default function DashboardPage() {
  const [window, setWindow] = useState<StatsWindow>('60s');
  const { data, error, loading, refreshing, reload } = useResource(
    () => statsApi.overview(window),
    [window],
  );
  const live = useLive();

  const fresh = isLiveFresh(live);
  const liveMetrics = fresh ? live.metrics : null;

  // 断线重连成功后拉一次快照，把断线期间的空档补上。
  const previousStatusRef = useRef(live.status);
  useEffect(() => {
    if (previousStatusRef.current !== 'ready' && live.status === 'ready') reload();
    previousStatusRef.current = live.status;
  }, [live.status, reload]);

  const keyRows = useMemo<KeyHealthRow[]>(() => {
    const merged = new Map<string, KeyHealthRow>();
    for (const row of data?.keyHealth ?? []) merged.set(row.keyId, row);
    for (const [keyId, frame] of Object.entries(live.keyHealth)) {
      merged.set(keyId, {
        keyId,
        maskedKey: frame.maskedKey,
        upstreamId: frame.upstreamId,
        health: frame.health,
        ...(frame.cooldownUntil ? { cooldownUntil: frame.cooldownUntil } : {}),
      });
    }
    return [...merged.values()];
  }, [data, live.keyHealth]);

  const counts = useMemo(() => healthCounts(keyRows), [keyRows]);

  const qps = liveMetrics?.qps ?? data?.qps ?? null;
  const successRate = liveMetrics?.successRate ?? data?.successRate ?? null;
  const requests = liveMetrics?.requests ?? data?.requests ?? null;
  const tokensTotal = liveMetrics?.tokensTotal ?? data?.tokens.total ?? null;
  const balanceTotal = liveMetrics?.balanceGlobal ?? data?.balance.global.totalBalance ?? null;
  const balanceUnknown = liveMetrics?.balanceUnknownKeyCount ?? data?.balance.global.balanceUnknownKeyCount ?? null;
  const tokenPlanCount = data?.balance.global.tokenPlanKeyCount ?? null;
  const windowLabel = liveMetrics?.window ?? data?.window ?? window;

  const sourceLabel = liveMetrics
    ? `实时 · 窗口 ${windowLabel}`
    : data
      ? `快照 · ${formatIso(data.generatedAt)}`
      : '等待数据';

  if (loading) {
    return (
      <>
        <PageHeader title="仪表盘" description="QPS、成功率、余额总览、key 健康状态" />
        <LoadingState tip="正在加载总览…" minHeight={420} />
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <PageHeader title="仪表盘" description="QPS、成功率、余额总览、key 健康状态" />
        <ErrorState error={error} onRetry={reload} variant="page" title="总览加载失败" />
      </>
    );
  }

  const columns: ColumnsType<KeyHealthRow> = [
    {
      title: 'Key',
      dataIndex: 'maskedKey',
      render: (value: string) => <Text style={{ fontFamily: tokens.font.mono }}>{value}</Text>,
    },
    {
      title: '上游',
      dataIndex: 'upstreamId',
      render: (value: string) => <Text type="secondary">{value}</Text>,
    },
    {
      title: '健康态',
      dataIndex: 'health',
      width: 180,
      render: (_: unknown, row) => (
        <HealthTag health={row.health} cooldownUntil={row.cooldownUntil ?? null} />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="仪表盘"
        description="QPS、成功率、余额总览、key 健康状态"
        extra={
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md }}>
            <Tooltip title="时间窗口由后端下发，前端不用本地时间自算 QPS。">
              <span>
                <Segmented
                  size="small"
                  value={window}
                  options={WINDOWS.map((item) => ({ label: item, value: item }))}
                  onChange={(value) => {
                    setWindow(value as StatsWindow);
                  }}
                />
              </span>
            </Tooltip>
            <Tooltip title={sourceLabel}>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={refreshing}
                onClick={reload}
              >
                刷新
              </Button>
            </Tooltip>
          </div>
        }
      />

      {error ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={error} onRetry={reload} title="刷新失败，以下为上一次成功的数据" />
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: tokens.space.md,
          marginBottom: tokens.space.lg,
        }}
      >
        <StatCard
          label="QPS"
          value={qps === null ? '—' : qps.toFixed(2)}
          unit={`窗口 ${windowLabel}`}
          caption={sourceLabel}
          stale={live.metrics !== null && !fresh}
          hint="由后端按时间窗口计算并随响应下发；实时帧每秒更新一次。"
        />
        <StatCard
          label="成功率"
          value={successRate === null ? '—' : formatPercent(successRate)}
          caption={requests === null ? '等待数据' : `${formatCount(requests)} 次请求`}
          tone={successRate !== null && successRate < 0.99 ? 'warning' : 'success'}
          stale={live.metrics !== null && !fresh}
        />
        <StatCard
          label="窗口内 token"
          value={formatCompact(tokensTotal)}
          caption={
            data
              ? `prompt ${formatCompact(data.tokens.prompt)} · completion ${formatCompact(
                  data.tokens.completion,
                )}`
              : '等待数据'
          }
          stale={live.metrics !== null && !fresh}
        />
        <StatCard
          label="全局余额（balance 类 key）"
          value={<BalanceText value={balanceTotal} strong />}
          caption={
            <span>
              未知 <Text style={{ color: tokens.color.warning }}>{formatCount(balanceUnknown)}</Text>{' '}
              个 · token-plan {formatCount(tokenPlanCount)} 个（不计入合计）
            </span>
          }
          stale={live.metrics !== null && !fresh}
          hint="合计只统计 category=balance 的 key；未知不为 0，单独计数。"
        />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(280px, 1fr) 2fr',
          gap: tokens.space.md,
        }}
      >
        <div
          style={{
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            background: tokens.color.bgContainer,
            padding: tokens.space.lg,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: tokens.space.md }}>
            Key 健康分布
          </div>
          <div style={{ display: 'grid', gap: tokens.space.sm }}>
            <HealthLine label="健康" count={counts.healthy} color={tokens.color.success} />
            <HealthLine label="冷却中" count={counts.cooling} color={tokens.color.warning} />
            <HealthLine label="已禁用" count={counts.disabled} color={tokens.color.textTertiary} />
          </div>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: tokens.space.md }}>
            健康态是网关运行态，管理端只读；启停请到 Key 管理页。
          </Text>
        </div>

        <div
          style={{
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            background: tokens.color.bgContainer,
            padding: tokens.space.sm,
          }}
        >
          <Table<KeyHealthRow>
            rowKey="keyId"
            size="small"
            columns={columns}
            dataSource={keyRows}
            pagination={false}
            scroll={{ y: 260 }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有 key。到「上游管理」建上游后，在「Key 管理」添加。"
                />
              ),
            }}
          />
        </div>
      </div>
    </>
  );
}

function HealthLine({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.space.sm }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Text>
      </span>
      <Text style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>{count}</Text>
    </div>
  );
}
