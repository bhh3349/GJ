/**
 * 余额同步观测区（契约 §14 / §14.3 `GET /api/stats/balance/sync`）。
 *
 * 这是余额"自动同步"这条链**唯一**的读面，三件事：生效参数回显、趋势、漂移。
 * 三条纪律在本文件里必须看得见：
 *
 * 1. **只读**。§14.3 逐字："该端点**只读**：不改任何状态、**不触发任何查询**"。
 *    所以这里**没有任何开关 / 输入框** —— 自动同步开不开、间隔多少分钟，是部署侧
 *    `BALANCE_SYNC_MINUTES` 的事，契约里**不存在**写它的端点（也没有 `min_interval_minutes`
 *    这样的每上游字段）。"想改就去改部署配置"这句话比一个点了就报错的假开关有用。
 * 2. **参数只回显**。`auto.*` 是服务端投影，**前端不得自算**间隔 / 抖动 / 退避（§14.3 逐字）。
 *    页面照抄 `auto`，不做任何 `interval * jitter` 之类的推演。
 * 3. **`null` 不补 0**。`totalBalanceCents === null` = 那一刻全未知；`nextRunAt === null`
 *    = 自动同步关着（不是"还没排到"）。两种都要显式说出来，而不是显示成 0 / 空。
 *
 * 图表走 `React.lazy`：echarts 只在用户真的进到这一块时才下载，不碰首屏关键路径。
 */
import { InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Segmented, Space, Tag, Tooltip, Typography } from 'antd';
import { Suspense, lazy, useState } from 'react';

import { statsApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import { BalanceDriftPanel } from '@/pages/stats/BalanceDriftPanel';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';
import { formatIso, formatPercent, formatRelative } from '@/utils/format';

// echarts 只在需要时下载；`BalancePanel` 那类纯表格不受影响。
const BalanceTrendChart = lazy(() => import('@/pages/stats/BalanceTrendChart'));

const { Text } = Typography;

/** 契约 §14.3：`Ns` / `Nm` / `Nh`，上限 24h。这里给三档常用值，**不发明**别的。 */
const WINDOWS = ['1h', '6h', '24h'] as const;
type SyncWindow = (typeof WINDOWS)[number];

function StatLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 96 }}>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {label}
      </Text>
      <Text style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>{children}</Text>
    </div>
  );
}

export interface BalanceSyncSectionProps {
  /** 只看某个上游（上游页可传）；缺省 = 全部上游。 */
  upstreamId?: string;
  /** 是否展示漂移面板。仪表盘要，窄处不要。 */
  showDrift?: boolean;
}

export function BalanceSyncSection({ upstreamId, showDrift = true }: BalanceSyncSectionProps) {
  const [window, setWindow] = useState<SyncWindow>('6h');
  const sync = useResource(
    () => statsApi.balanceSync(upstreamId ? { upstreamId, window } : { window }),
    [upstreamId, window],
  );

  const data = sync.data;
  const auto = data?.auto;

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
          flexWrap: 'wrap',
        }}
      >
        <Space size={tokens.space.sm} align="center" wrap>
          <Text style={{ fontSize: 13, fontWeight: 600 }}>余额同步</Text>
          <Tooltip title="只读观测口：不改状态、不触发查询。自动同步的开关与间隔由部署侧 BALANCE_SYNC_MINUTES 决定，管理面上没有写入口。">
            <Text type="secondary" style={{ fontSize: 12 }}>
              自动同步状态与趋势 <InfoCircleOutlined style={{ fontSize: 11 }} />
            </Text>
          </Tooltip>
        </Space>
        <Space size={tokens.space.sm} align="center">
          <Segmented
            size="small"
            value={window}
            options={WINDOWS.map((value) => ({ label: value, value }))}
            onChange={(value) => setWindow(value as SyncWindow)}
          />
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={sync.refreshing}
            onClick={sync.reload}
          >
            刷新
          </Button>
        </Space>
      </div>

      {sync.error && sync.data ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={sync.error} onRetry={sync.reload} title="刷新失败，以下为上一次成功的数据" />
        </div>
      ) : null}

      {sync.loading ? (
        <LoadingState tip="正在加载余额同步状态…" minHeight={200} />
      ) : sync.error && !sync.data ? (
        <ErrorState error={sync.error} onRetry={sync.reload} variant="page" title="余额同步状态加载失败" />
      ) : data && auto ? (
        <>
          <Space size={tokens.space.xl} wrap style={{ marginBottom: tokens.space.md }}>
            <StatLine label="自动同步">
              {auto.enabled ? (
                <Tag
                  bordered={false}
                  style={{ marginInlineEnd: 0, background: tokens.tint.success, color: tokens.color.success }}
                >
                  运行中
                </Tag>
              ) : (
                <Tooltip title="BALANCE_SYNC_MINUTES=0 ⇒ 未注册定时器。手动刷新三个端点不受影响。">
                  <Tag
                    bordered={false}
                    style={{ marginInlineEnd: 0, background: tokens.tint.neutral, color: tokens.color.textSecondary }}
                  >
                    已关闭
                  </Tag>
                </Tooltip>
              )}
            </StatLine>
            <StatLine label="基准间隔">
              {auto.enabled ? `${auto.intervalMinutes} 分钟` : '—'}
            </StatLine>
            <StatLine label="抖动">±{formatPercent(auto.jitterRatio, 0)}</StatLine>
            <StatLine label="退避上限">{`${auto.backoffCapMinutes} 分钟`}</StatLine>
            <StatLine label="最近同步">
              {data.lastSyncedAt ? (
                <Tooltip title={`${formatIso(data.lastSyncedAt)} · 触发方 ${data.lastTrigger ?? '未知'}`}>
                  <span>{formatRelative(data.lastSyncedAt)}</span>
                </Tooltip>
              ) : (
                <Text type="secondary">从未同步</Text>
              )}
            </StatLine>
            <StatLine label="下次计划">
              {data.nextRunAt ? (
                <Tooltip title={formatIso(data.nextRunAt)}>
                  {/* 含抖动的计划时刻 —— 直接显示后端给的值，前端不自算。 */}
                  <span>{formatRelative(data.nextRunAt)}</span>
                </Tooltip>
              ) : (
                <Tooltip title="自动同步已关闭（nextRunAt=null），不是「还没排到」。">
                  <Text type="secondary">—</Text>
                </Tooltip>
              )}
            </StatLine>
          </Space>

          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: tokens.space.sm }}>
            观测窗口 {formatIso(data.window.from)} → {formatIso(data.window.to)}（该窗口只影响下面这张图与漂移统计，
            与同步节奏无关）
          </Text>

          {data.series.length === 0 ? (
            <div
              style={{
                height: 200,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: tokens.color.textSecondary,
                fontSize: 13,
              }}
            >
              窗口内还没有余额快照。快照只在「覆盖整个上游」的同步后写入，单 key 手动刷新不写快照。
            </div>
          ) : (
            <Suspense
              fallback={
                <div
                  style={{
                    height: 320,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: tokens.color.textTertiary,
                    fontSize: 12,
                  }}
                >
                  正在加载图表…
                </div>
              }
            >
              <BalanceTrendChart series={data.series} />
            </Suspense>
          )}

          {showDrift ? (
            <div style={{ marginTop: tokens.space.lg }}>
              <BalanceDriftPanel drift={data.drift} upstreams={data.upstreams} />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
