/**
 * 仪表盘 —— 先回答"网关现在好不好"，再回答"钱还剩多少"。
 *
 * ## 这一页的排布依据（Bo 2026-10-12：「整个系统只有余额才配显示？」）
 *
 * 旧版把余额摆在第一排四张卡之一，页面底部还压一整块余额观测区 —— 一屏读下来像财务报表，
 * 而这个系统的本职是**转发流量**。现在按"运维先看什么"重排：
 *
 * 1. **流量与服务健康**（QPS / 成功率 / 延迟 P50·P99 / key 池健康 / DB 健康 / 运行时长）；
 * 2. **用量**（窗口内 token、错误事件分型）；
 * 3. **余额退到第二区**，与流量趋势并列，不再独占一排。
 *
 * ## 数据来源四条，口径各归各的，不混用
 *
 * 1. `GET /api/stats/overview?window=` —— §6 快照（含后端算好的 `window`，**前端不得自算 QPS**）；
 * 2. `WS /api/stats/live` —— §7 每秒一帧的实时值；
 * 3. `GET /api/observability/health?window=` —— §12.2 健康指标，**延迟分位与 DB 健康只有这里有**；
 * 4. `GET /api/stats/balance/sync?window=` —— §14.3 余额快照序列与漂移（只读，独立降级）。
 *
 * §12 与 §6 的 `traffic.*` 是**同一份 SQL、同一口径**（契约 §12.2 表内明写），
 * 所以 QPS / 成功率仍以实时帧优先、§6 快照兜底；§12 只补 §6 没有的东西（延迟、DB、事件、uptime）。
 * 两处都给的数一旦不一致，页面按 §6/WS 显示 —— 不在这里做"取平均"这种第三口径。
 *
 * 断线纪律（契约 §7）：通道不新鲜时**退回快照并标注**，绝不把上一帧当实时值继续展示。
 */
import { ReloadOutlined } from '@ant-design/icons';
import { Button, Segmented, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';

import { observabilityApi, statsApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import type { KeyHealth, KeyHealthRow, StatsWindow } from '@/api/types';
import { BalanceText } from '@/components/BalanceText';
import { HealthTag } from '@/components/HealthTag';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { StatCard } from '@/components/StatCard';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { BalanceSyncSection } from '@/pages/stats/BalanceSyncSection';
import type { HealthMetric } from '@/pages/dashboard/HealthTrendChart';
import { categoryLabel } from '@/utils/observabilityLabels';
import { isLiveFresh } from '@/realtime/live';
import { useLive } from '@/realtime/useLive';
import { tokens } from '@/theme/tokens';
import {
  formatBytes,
  formatCompact,
  formatCount,
  formatDuration,
  formatIso,
  formatLatency,
  formatPercent,
} from '@/utils/format';

// echarts 按需下载：这条趋势图在首屏之下，不该进关键路径（验收：首屏 < 2s）。
const HealthTrendChart = lazy(() => import('@/pages/dashboard/HealthTrendChart'));

const { Text } = Typography;

const WINDOWS: readonly StatsWindow[] = ['60s', '5m', '15m', '1h'];

/** §12.2 健康窗口与 §6 不同：**没有** `15m`（契约 §12.2 明写），所以 `15m` 落到 `1h`。 */
function toObservabilityWindow(window: StatsWindow): '60s' | '5m' | '1h' {
  if (window === '60s') return '60s';
  if (window === '5m') return '5m';
  return '1h';
}

/**
 * 快照取多少条：每 60s 一条，200 条 = 3 小时 20 分的形状，够看出"什么时候开始不对"。
 * **上限 200 不是口味**：后端分页校验 `pageSize ≤ 200`（`src/api/schemas.ts` 的 `pageProps`），
 * 240 会被整条请求拒掉，趋势图直接加载失败。
 */
const SNAPSHOT_PAGE_SIZE = 200;

function healthCounts(rows: readonly KeyHealthRow[]): Record<KeyHealth, number> {
  const counts: Record<KeyHealth, number> = { healthy: 0, cooling: 0, disabled: 0 };
  for (const row of rows) counts[row.health] += 1;
  return counts;
}

export default function DashboardPage() {
  const [window, setWindow] = useState<StatsWindow>('60s');
  const [trendMetrics, setTrendMetrics] = useState<'traffic' | 'latency'>('traffic');
  const { data, error, loading, refreshing, reload } = useResource(
    () => statsApi.overview(window),
    [window],
  );
  const live = useLive();

  /** §12.2 健康指标：延迟分位、DB 健康、错误分型、uptime 的唯一来源。 */
  const health = useResource(
    () => observabilityApi.health(toObservabilityWindow(window)),
    [window],
  );

  /** §12.3 历史快照（只读）。失败只影响这条趋势图，不打整页。 */
  const snapshots = useResource(
    () => observabilityApi.snapshots({ pageSize: SNAPSHOT_PAGE_SIZE }),
    [],
  );

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

  const traffic = health.data?.traffic ?? null;
  const latency = traffic?.latencyMs ?? null;

  const qps = liveMetrics?.qps ?? data?.qps ?? null;
  const successRate = liveMetrics?.successRate ?? data?.successRate ?? null;
  const requests = liveMetrics?.requests ?? data?.requests ?? null;
  const tokensTotal = liveMetrics?.tokensTotal ?? data?.tokens.total ?? null;
  const balanceTotal = liveMetrics?.balanceGlobal ?? data?.balance.global.totalBalance ?? null;
  const balanceUnknown =
    liveMetrics?.balanceUnknownKeyCount ?? data?.balance.global.balanceUnknownKeyCount ?? null;
  const tokenPlanCount = data?.balance.global.tokenPlanKeyCount ?? null;
  const windowLabel = liveMetrics?.window ?? data?.window ?? window;

  const sourceLabel = liveMetrics
    ? `实时 · 窗口 ${windowLabel}`
    : data
      ? `快照 · ${formatIso(data.generatedAt)}`
      : '等待数据';

  /** 契约明写：`requests=0` 时 `successRate=1` 是**约定而非断言**，仍要显示"无流量"。 */
  const noTraffic = requests === 0;

  const keyPool = health.data?.keys ?? null;
  const db = health.data?.db ?? null;
  const events = health.data?.events ?? null;
  const eventBuckets = useMemo(
    () => [...(events?.byCategory ?? [])].sort((a, b) => b.count - a.count),
    [events],
  );

  if (loading) {
    return (
      <>
        <PageHeader title="仪表盘" />
        <LoadingState tip="正在加载总览…" minHeight={420} />
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <PageHeader title="仪表盘" />
        <ErrorState error={error} onRetry={reload} variant="page" title="总览加载失败" />
      </>
    );
  }

  const columns: ColumnsType<KeyHealthRow> = [
    {
      title: 'Key',
      dataIndex: 'maskedKey',
      width: 150,
      render: (value: string) => (
        <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value}</Text>
      ),
    },
    {
      title: '上游',
      dataIndex: 'upstreamId',
      width: 170,
      render: (value: string) => (
        <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>
          {value}
        </Text>
      ),
    },
    {
      title: '健康态',
      dataIndex: 'health',
      render: (_: unknown, row) => (
        <HealthTag health={row.health} cooldownUntil={row.cooldownUntil ?? null} />
      ),
    },
  ];

  const trendColumns: readonly HealthMetric[] =
    trendMetrics === 'traffic' ? ['requests', 'errors'] : ['p50', 'p99'];

  return (
    <>
      <PageHeader
        title="仪表盘"
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
                loading={refreshing || health.refreshing}
                onClick={() => {
                  reload();
                  health.reload();
                  snapshots.reload();
                }}
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

      {/* ── 第一排：流量本身 ───────────────────────────────────────────── */}
      <div className="stat-grid">
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
          value={successRate === null || noTraffic ? '—' : formatPercent(successRate)}
          caption={
            noTraffic
              ? '窗口内无流量（后端的 successRate=1 是约定，不是实测）'
              : `${formatCount(requests)} 次请求 · ${formatCount(data?.errors ?? traffic?.errors ?? 0)} 次失败`
          }
          tone={
            noTraffic
              ? 'default'
              : successRate !== null && successRate < 0.99
                ? 'warning'
                : 'success'
          }
          stale={live.metrics !== null && !fresh}
        />
        <StatCard
          label="延迟 P50 / P99"
          value={
            latency === null || latency.samples === 0 ? (
              '—'
            ) : (
              <span>
                {formatLatency(latency.p50)}
                <span style={{ fontSize: 14, fontWeight: 400, color: tokens.color.textTertiary }}>
                  {' / '}
                </span>
                {formatLatency(latency.p99)}
              </span>
            )
          }
          caption={
            latency === null
              ? health.error
                ? '观测面加载失败 —— 延迟未知'
                : '等待数据'
              : `${formatCount(latency.samples)} 个样本（取真实分位，不做插值）`
          }
          hint="取自真实调用日志的端到端耗时：p50 = 一半请求快于这个值，p99 = 99% 的请求快于这个值。窗口内没有样本时显示「—」，不是 0ms。"
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
      </div>

      {/* ── 第二排：服务与池子的健康（余额不在这里） ────────────────────── */}
      <div className="panel-grid-3">
        <Panel
          size="sm"
          title="key 池健康"
          hint="网关侧的 key 运行态，管理端只读；数值每秒同步一次。冷却与连续失败由网关判定，不由这里决定。"
          extra={
            keyPool ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {`共 ${formatCount(keyPool.total)} 把`}
              </Text>
            ) : null
          }
        >
          {health.error && !health.data ? (
            <ErrorState error={health.error} onRetry={health.reload} title="观测面加载失败" minHeight={140} />
          ) : (
            <div style={{ display: 'grid', gap: tokens.space.sm }}>
              <HealthLine label="健康" count={keyPool?.healthy ?? counts.healthy} color={tokens.color.success} />
              <HealthLine label="冷却中" count={keyPool?.cooling ?? counts.cooling} color={tokens.color.warning} />
              <HealthLine label="已禁用" count={keyPool?.disabled ?? counts.disabled} color={tokens.color.textTertiary} />
              <Text type="secondary" style={{ fontSize: 11, marginTop: tokens.space.xs }}>
                健康态由网关决定，管理端只读；下面是当前窗口内出现过的 key 明细。
              </Text>
            </div>
          )}
        </Panel>

        <Panel
          size="sm"
          title="服务与存储"
          hint="运行时长是本次进程启动至今的时间，重启即归零。数据库那一格是真跑一次查询的结果，不是「连接对象还在」。"
        >
          <div style={{ display: 'grid', gap: tokens.space.sm }}>
            <MetaLine
              label="运行时长"
              value={health.data ? formatDuration(health.data.uptimeSec) : '—'}
              hint={health.data ? `启动于 ${formatIso(health.data.startedAt)}` : undefined}
            />
            <MetaLine
              label="DB 读写"
              value={
                db === null ? (
                  '—'
                ) : (
                  <Tag
                    bordered={false}
                    style={{
                      marginInlineEnd: 0,
                      background: db.ok ? tokens.tint.success : tokens.tint.error,
                      color: db.ok ? tokens.color.success : tokens.color.error,
                    }}
                  >
                    {db.ok ? '正常' : '异常'}
                  </Tag>
                )
              }
              hint={db ? `探测耗时 ${db.queryMs}ms · schema v${db.schemaVersion}` : undefined}
            />
            <MetaLine
              label="库文件 / WAL"
              value={db ? `${formatBytes(db.fileSizeBytes)} / ${formatBytes(db.walSizeBytes)}` : '—'}
              hint="取不到是「—」（如 :memory: 库），不是 0。"
            />
          </div>
        </Panel>

        <Panel
          size="sm"
          title="错误事件分型"
          hint="只列窗口内真正发生过的类型，没发生的不补 0。分两档归因：调用方与配额侧为提醒，系统侧为故障。"
          extra={
            events ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {`窗口内 ${formatCount(events.total)} 条`}
              </Text>
            ) : null
          }
        >
          {events && eventBuckets.length === 0 ? (
            <div style={{ display: 'grid', gap: tokens.space.sm }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                窗口内没有错误事件 —— 这是「没有发生过」，不是「没查到」。
              </Text>
              <MetaLine
                label="累计丢弃"
                value={formatCount(events.dropped)}
                hint="本次进程启动以来，因队列溢出或落库失败而累计丢弃的事件数。丢事件不许静默，所以这一格常驻。"
                tone={events.dropped > 0 ? 'warning' : 'default'}
              />
            </div>
          ) : events ? (
            <div style={{ display: 'grid', gap: tokens.space.sm }}>
              {eventBuckets.map((bucket) => (
                <MetaLine
                  key={bucket.category}
                  label={categoryLabel(bucket.category)}
                  value={formatCount(bucket.count)}
                  hint={`${bucket.category} · severity=${bucket.severity} · 最近 ${formatIso(bucket.lastAt)}`}
                  tone={bucket.severity === 'error' ? 'error' : 'warning'}
                />
              ))}
              {events.dropped > 0 ? (
                <MetaLine
                  label="累计丢弃"
                  value={formatCount(events.dropped)}
                  tone="warning"
                  hint="进程启动以来累计，不是窗口内。"
                />
              ) : null}
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              等待数据
            </Text>
          )}
        </Panel>
      </div>

      {/* ── 第三排：流量趋势（历史快照） + key 明细 ─────────────────────── */}
      <div className="panel-grid-wide">
        <Panel
          title="流量与延迟趋势"
          description="每 60 秒存一条的服务健康快照 —— 是当时算出来的历史，不会事后重算。"
          extra={
            <Segmented
              size="small"
              value={trendMetrics}
              options={[
                { label: '请求 / 错误', value: 'traffic' },
                { label: '延迟 P50 / P99', value: 'latency' },
              ]}
              onChange={(value) => setTrendMetrics(value as 'traffic' | 'latency')}
            />
          }
        >
          {snapshots.error && !snapshots.data ? (
            <ErrorState error={snapshots.error} onRetry={snapshots.reload} title="快照加载失败" minHeight={200} />
          ) : snapshots.loading ? (
            <LoadingState tip="正在加载历史快照…" minHeight={260} />
          ) : (snapshots.data?.items.length ?? 0) === 0 ? (
            <div style={{ minHeight: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Text type="secondary" style={{ fontSize: 13 }}>
                还没有健康快照 —— 服务启动后每 60s 落一条。
              </Text>
            </div>
          ) : (
            <Suspense
              fallback={
                <div style={{ height: 260, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    正在加载图表…
                  </Text>
                </div>
              }
            >
              <HealthTrendChart
                snapshots={snapshots.data?.items ?? []}
                metrics={trendColumns}
              />
            </Suspense>
          )}
        </Panel>

        <Panel
          title="Key 明细"
          description={`${formatCount(keyRows.length)} 把 key 出现在本窗口的观测里`}
          gap={false}
          size="sm"
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          <Table<KeyHealthRow>
            rowKey="keyId"
            size="small"
            columns={columns}
            dataSource={keyRows}
            pagination={false}
            tableLayout="fixed"
            scroll={{ y: 286 }}
            locale={{
              emptyText: (
                <div style={{ padding: tokens.space.lg, textAlign: 'center' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    暂无 key
                  </Text>
                </div>
              ),
            }}
          />
        </Panel>
      </div>

      {/* ── 第四排：余额（退到第二区，与流量并列而不是独占一排） ────────── */}
      <div className="panel-grid-balance">
        <Panel
          size="sm"
          title="余额总览"
          hint="合计只统计「余额类」key；余额未知的按未知单独计数、不当 0 累加；套餐类 key 不进金额合计。"
        >
          <div style={{ display: 'grid', gap: tokens.space.md }}>
            <div>
              <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                全局合计（balance 类 key）
              </Text>
              <span style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em' }}>
                <BalanceText value={balanceTotal} strong />
              </span>
            </div>
            <MetaLine
              label="未知余额的 key"
              value={formatCount(balanceUnknown)}
              tone={balanceUnknown && balanceUnknown > 0 ? 'warning' : 'default'}
              hint="余额未知不等于 0，不计入合计。"
            />
            <MetaLine label="不计金额的套餐类 key" value={formatCount(tokenPlanCount)} />
            <Text type="secondary" style={{ fontSize: 11 }}>
              要看余额从哪来、什么时候查的、有没有漂移，去下面的余额同步观测区或统计页。
            </Text>
          </div>
        </Panel>

        <Panel
          size="sm"
          title="网关调用侧"
          description="转发系统的第一性问题：能不能服务、服务得怎么样。"
        >
          <div style={{ display: 'grid', gap: tokens.space.md }}>
            <MetaLine
              label="本窗口请求"
              value={formatCount(requests)}
              hint="与统计页同一份口径。两处偶有不一致时，本页以实时帧与总览为准。"
            />
            <MetaLine
              label="可服务 key"
              value={keyPool ? `${formatCount(keyPool.healthy)} / ${formatCount(keyPool.total)}` : '—'}
              tone={keyPool && keyPool.healthy === 0 ? 'error' : 'default'}
              hint="只有「启用 + 不在冷却 + 余额大于 0」的 key 才会被网关选中对外服务。"
            />
            <MetaLine
              label="助手流量"
              value={
                health.data
                  ? `${formatCount(health.data.assistant.requests)} 次 · ${formatCount(health.data.assistant.errors)} 次失败`
                  : '—'
              }
              hint="内置助手单独计量：它的失败会拉低 key 健康，但不计入业务 QPS 与成功率。这是本次进程内的累计，重启归零。"
            />
          </div>
        </Panel>
      </div>

      {/*
        余额同步观测区（只读）。独立取数：`/stats/overview` 不带余额历史，
        所以这一块自己打 `/api/stats/balance/sync`，失败不影响上面的实时面板。
        echarts 在该组件内部按需加载，不进首屏关键路径。
      */}
      <div style={{ marginTop: tokens.space.lg }}>
        <BalanceSyncSection />
      </div>
    </>
  );
}

function HealthLine({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.space.md }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.space.sm, minWidth: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flex: 'none' }} />
        <Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Text>
      </span>
      <Text style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>{count}</Text>
    </div>
  );
}

interface MetaLineProps {
  label: string;
  value: React.ReactNode;
  hint?: string | undefined;
  tone?: 'default' | 'warning' | 'error';
}

const TONE_TEXT: Record<NonNullable<MetaLineProps['tone']>, string> = {
  default: tokens.color.textPrimary,
  warning: tokens.color.warning,
  error: tokens.color.error,
};

function MetaLine({ label, value, hint, tone = 'default' }: MetaLineProps) {
  const body = (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: tokens.space.md,
      }}
    >
      <Text type="secondary" style={{ fontSize: 12, minWidth: 0 }}>
        {label}
      </Text>
      <Text
        style={{
          fontSize: 13,
          fontVariantNumeric: 'tabular-nums',
          color: TONE_TEXT[tone],
          flex: 'none',
        }}
      >
        {value}
      </Text>
    </div>
  );
  return hint ? <Tooltip title={hint}>{body}</Tooltip> : body;
}
