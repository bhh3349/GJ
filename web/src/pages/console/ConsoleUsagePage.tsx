/**
 * 消费面 · 我的用量 —— §19.4 `GET /api/console/usage`。
 *
 * 与管理面「统计」页的关系：**同一个后端端点族的响应形状**（契约 §19.4 明写
 * "与 §6 逐字相同"），只多一层"恒按本组收窄"。所以这里刻意**不做**一套新的画图逻辑 ——
 * 直接复用管理面那个 `UsageChart`（它只吃 `axis` / `series` / `metric` / `bucket`，
 * 不关心数据来自哪个端点）。
 *
 * 与管理面那页**有意的差异**，每一处都是契约裁的，不是省事：
 * - **没有"按上游 / 按用户组"切换**。消费面恒按本组收窄：`groupBy=group` 传了也是
 *   400（enum 里没有它），而"按上游"对本组用户还有意义、"按组"没有。
 *   所以下拉里只有 `key` / `model` 两项 —— 少一个选项比给一个会 400 的选项诚实。
 * - **没有组选择器**。归属来自服务端会话，`?groupId=` 传了也被忽略
 *   （判据：构造别组 id 回的仍是本组）。前端连这个参数都没有，
 *   用户就写不出"我想看别组"的请求。
 * - **没有成本口径的解释义务**……不，有的：`costCents` 照 §6 口径折算，
 *   但本页不展示它。理由不是"用户不需要知道花了多少钱"，
 *   而是组级配额是共享的（ADR-0034 遗留 1），把成本摊到个人眼前
 *   会让人以为那是**自己**的账单 —— 一个会骗人的数字比没有数字更糟。
 *   请求数与 tokens 是同组共享的事实，成本在组级也是同一个事实，
 *   但它最容易被误读成个人账单，所以本页只放前三项指标。
 */
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, DatePicker, Segmented, Select, Space, Switch, Tooltip, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';

import { consoleApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import type { ConsoleUsageQuery, UsageBucket, UsageStats } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/StateBlock';
import { ConsoleQuotaPanel } from '@/pages/console/ConsoleQuotaPanel';
import { METRIC_LABEL, UsageChart, type UsageMetric } from '@/pages/stats/UsageChart';
import { tokens } from '@/theme/tokens';
import { formatCompact, formatCount, formatIso } from '@/utils/format';

const { Text } = Typography;

type Preset = '1h' | '6h' | '24h' | '7d';

const PRESETS: readonly Preset[] = ['1h', '6h', '24h', '7d'];

const PRESET_LABEL: Record<Preset, string> = {
  '1h': '最近 1 小时',
  '6h': '最近 6 小时',
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
};

const PRESET_HOURS: Record<Preset, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 24 * 7 };

/** 与管理面统计页同一张表：预设同时匹配一个配得上该跨度的粒度。 */
const PRESET_BUCKET: Record<Preset, UsageBucket> = {
  '1h': '1m',
  '6h': '5m',
  '24h': '1h',
  '7d': '1d',
};

const BUCKET_LABEL: Record<UsageBucket, string> = {
  '1m': '1 分钟',
  '5m': '5 分钟',
  '1h': '1 小时',
  '1d': '1 天',
};

/** §19.4：`groupBy` 的 enum 里**没有 `group`** —— 这里就不给它一个选项。 */
const GROUP_BY_LABEL: Record<Exclude<ConsoleUsageQuery['groupBy'], never>, string> = {
  key: '按 key',
  upstream: '按上游',
  model: '按模型',
};

/** 同上：不含 `costCents`（见文件头第三条）。 */
const METRIC_ORDER: readonly UsageMetric[] = [
  'requests',
  'tokens',
  'promptTokens',
  'completionTokens',
  'errors',
];

const AUTO_REFRESH_MS = 15_000;

const EMPTY_AXIS: readonly string[] = [];
const EMPTY_SERIES: readonly never[] = [];

export default function ConsoleUsagePage() {
  const [preset, setPreset] = useState<Preset>('24h');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [bucket, setBucket] = useState<UsageBucket>('1h');
  const [groupBy, setGroupBy] = useState<ConsoleUsageQuery['groupBy']>('model');
  const [metric, setMetric] = useState<UsageMetric>('requests');
  const [stacked, setStacked] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tick, setTick] = useState(0);

  const usingCustomRange = customRange !== null;

  useEffect(() => {
    if (!autoRefresh || usingCustomRange) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setTick((value) => value + 1);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, usingCustomRange]);

  const query = useMemo<ConsoleUsageQuery>(() => {
    const now = dayjs();
    const start = customRange ? customRange[0] : now.subtract(PRESET_HOURS[preset], 'hour');
    const end = customRange ? customRange[1] : now;
    return {
      from: start.toISOString(),
      to: end.toISOString(),
      bucket,
      groupBy,
    };
  }, [preset, customRange, bucket, groupBy, tick]);

  const queryKey = JSON.stringify(query);
  const usage = useResource<UsageStats>(
    () => consoleApi.usage(JSON.parse(queryKey) as ConsoleUsageQuery),
    [queryKey],
  );

  const axis = useMemo(() => usage.data?.axis ?? EMPTY_AXIS, [usage.data]);
  const series = useMemo(() => usage.data?.series ?? EMPTY_SERIES, [usage.data]);
  const effectiveBucket = usage.data?.bucket ?? bucket;

  const totals = useMemo(() => {
    let requests = 0;
    let tokens = 0;
    let errors = 0;
    for (const item of usage.data?.series ?? []) {
      for (const point of item.points) {
        requests += point.requests;
        tokens += point.tokens;
        errors += point.errors;
      }
    }
    return { requests, tokens, errors };
  }, [usage.data]);

  /** 契约要求等长；不等长就照原样画并说出来，不补桶、不补 0。 */
  const shapeWarning = useMemo(() => {
    const data = usage.data;
    if (!data) return null;
    const bad = data.series.filter((item) => item.points.length !== data.axis.length);
    if (bad.length === 0) return null;
    return `有 ${bad.length} 条序列的点数与时间轴不等长。图表按后端返回原样绘制，未做补桶。`;
  }, [usage.data]);

  const metricOptions = METRIC_ORDER.map((value) => ({ label: METRIC_LABEL[value], value }));

  return (
    <>
      <PageHeader
        title="我的用量"
        extra={
          <Space>
            <Tooltip
              title={
                usingCustomRange
                  ? '使用自定义区间时不做自动刷新：绝对窗口不随时间推移变化。'
                  : `每 ${AUTO_REFRESH_MS / 1000} 秒按当前时刻重算窗口并重查（页面不可见时暂停）。`
              }
            >
              <Space size={6}>
                <Switch
                  size="small"
                  checked={autoRefresh && !usingCustomRange}
                  disabled={usingCustomRange}
                  onChange={setAutoRefresh}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  自动刷新
                </Text>
              </Space>
            </Tooltip>
            <Button
              size="small"
              icon={<ReloadOutlined spin={usage.refreshing} />}
              onClick={() => {
                setTick((value) => value + 1);
                usage.reload();
              }}
            >
              刷新
            </Button>
          </Space>
        }
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: tokens.space.md }}
        message="这里统计的是你所在组的全部用量"
        description="配额与用量按组共享（同组多人共用同一批 key 与配额），不是某个人的单独账单。"
      />

      {/*
        额度卡放在**筛选器之前**：它答的是"我现在还剩多少、上限是多少"，
        与下面选哪个时间窗无关（它是"今天"，不是"这个窗口"）。
        放下面会让人以为它跟着时间窗变 —— 而它不变，正是它的意思。
        数据来自 §19.3c，与上面那张 Alert 说的"按组共享"是同一件事的两个面。
      */}
      <div style={{ marginBottom: tokens.space.md }}>
        <ConsoleQuotaPanel />
      </div>

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: tokens.space.sm,
          marginBottom: tokens.space.md,
        }}
      >
        <Segmented
          size="small"
          value={preset}
          options={PRESETS.map((value) => ({ label: PRESET_LABEL[value], value }))}
          onChange={(value) => {
            const next = value as Preset;
            setPreset(next);
            setCustomRange(null);
            setBucket(PRESET_BUCKET[next]);
          }}
        />
        <Select
          size="small"
          style={{ width: 120 }}
          value={bucket}
          options={(Object.keys(BUCKET_LABEL) as UsageBucket[]).map((value) => ({
            label: BUCKET_LABEL[value],
            value,
          }))}
          onChange={(value: UsageBucket) => setBucket(value)}
        />
        <Select
          size="small"
          style={{ width: 120 }}
          value={groupBy}
          options={(Object.keys(GROUP_BY_LABEL) as ConsoleUsageQuery['groupBy'][]).map((value) => ({
            label: GROUP_BY_LABEL[value],
            value,
          }))}
          onChange={(value: ConsoleUsageQuery['groupBy']) => setGroupBy(value)}
        />
        <DatePicker.RangePicker
          size="small"
          showTime={{ format: 'HH:mm' }}
          placeholder={['自定义开始', '自定义结束']}
          value={customRange}
          onChange={(values) => {
            const start = values?.[0];
            const end = values?.[1];
            setCustomRange(start && end ? [start, end] : null);
          }}
        />
        {usingCustomRange ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            自定义区间（自动刷新已让位：绝对窗口不随时间推移变化）
          </Text>
        ) : null}
      </div>

      {usage.error && usage.data ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={usage.error} onRetry={usage.reload} title="刷新失败，以下为上一次成功的数据" />
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: tokens.space.md,
          marginBottom: tokens.space.lg,
        }}
      >
        <StatCard
          label="请求数"
          value={usage.data ? formatCount(totals.requests) : '—'}
          caption={usage.data ? `${formatIso(usage.data.from)} → ${formatIso(usage.data.to)}` : '等待数据'}
          loading={usage.loading}
        />
        <StatCard
          label="tokens"
          value={usage.data ? formatCompact(totals.tokens) : '—'}
          caption={usage.data ? `完整值 ${formatCount(totals.tokens)}` : '等待数据'}
          loading={usage.loading}
        />
        <StatCard
          label="错误数"
          value={usage.data ? formatCount(totals.errors) : '—'}
          tone={totals.errors > 0 ? 'warning' : 'default'}
          caption={
            usage.data
              ? `${formatCount(usage.data.series.length)} 条序列 · ${formatCount(usage.data.axis.length)} 个桶`
              : '等待数据'
          }
          loading={usage.loading}
        />
      </div>

      {shapeWarning ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <Alert type="warning" showIcon message="序列与时间轴长度不一致" description={shapeWarning} />
        </div>
      ) : null}

      <div
        style={{
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          background: tokens.color.bgContainer,
          padding: tokens.space.lg,
          marginBottom: tokens.space.lg,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.space.md,
            marginBottom: tokens.space.md,
          }}
        >
          <Space size={tokens.space.md} wrap>
            <Segmented
              size="small"
              value={metric}
              options={metricOptions}
              onChange={(value) => setMetric(value as UsageMetric)}
            />
            <Tooltip title="把各序列按桶累加叠起来；关掉就是各条独立趋势。">
              <Space size={6}>
                <Switch size="small" checked={stacked} onChange={setStacked} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  堆叠
                </Text>
              </Space>
            </Tooltip>
          </Space>
          <Space size={tokens.space.md} wrap>
            {usage.data && usage.data.bucket !== bucket ? (
              <Tooltip title="数据量大时后端可能自动降低粒度，以实际回显为准。">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  后端回显粒度 {BUCKET_LABEL[usage.data.bucket]}
                </Text>
              </Tooltip>
            ) : null}
            <Text type="secondary" style={{ fontSize: 12 }}>
              {GROUP_BY_LABEL[groupBy]} · 粒度 {BUCKET_LABEL[effectiveBucket]}
            </Text>
          </Space>
        </div>

        {usage.data && usage.data.isEstimatedTokenCount > 0 ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: tokens.space.md }}
            message={`含估算用量 ${formatCount(usage.data.isEstimatedTokenCount)} 条（按字符估算，非上游真实报数）`}
          />
        ) : null}

        {usage.loading ? (
          <LoadingState tip="正在加载用量…" minHeight={340} />
        ) : usage.error && !usage.data ? (
          <ErrorState error={usage.error} onRetry={usage.reload} variant="page" title="用量加载失败" />
        ) : series.length === 0 ? (
          <EmptyState
            title="该区间没有用量数据"
            minHeight={340}
            action={
              <Button
                size="small"
                onClick={() => {
                  setCustomRange(null);
                  setPreset('7d');
                  setBucket(PRESET_BUCKET['7d']);
                }}
              >
                看最近 7 天
              </Button>
            }
          />
        ) : (
          <div style={{ opacity: usage.refreshing ? 0.72 : 1, transition: `opacity ${tokens.motion.base}` }}>
            <UsageChart axis={axis} series={series} metric={metric} bucket={effectiveBucket} stacked={stacked} />
          </div>
        )}
      </div>
    </>
  );
}
