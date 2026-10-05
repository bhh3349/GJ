/**
 * 统计 —— 按 key / 上游 / 用户组 / 时间的用量聚合。
 *
 * 契约纪律：
 * - §6：**后端返回序列化好的时间轴，前端不二次聚合**。`axis` 与每条 `series[].points`
 *   等长且下标对齐，缺失桶由后端补 0；前端只取数、画图，不改口径。
 * - C2：`bucket` 允许后端降级，**以后端回显为准**（`usage.data.bucket`），
 *   与用户选择不一致时明确标注，而不是继续按用户选的粒度画。
 * - 预设区间是**相对窗口**：每次请求按「当前时刻」重算 from/to，所以打开自动刷新时图表
 *   是真的跟着时间走；一旦选了自定义绝对区间，自动刷新自动让位（绝对窗口不会因时间推移而变化）。
 * - `isEstimatedTokenCount > 0` 必须在图上可区分（契约明写）：这些 token 计入了配额，
 *   但不是上游真实报数。
 * - 金额单位是分，token 是 int，时间 ISO8601 UTC 传参、本地时区展示。
 */
import { ReloadOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  DatePicker,
  Input,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';

import { groupsApi, statsApi, upstreamsApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import type { Group, Upstream, UsageBucket, UsageGroupBy, UsageQuery } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { StatCard } from '@/components/StatCard';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/StateBlock';
import { BalancePanel } from '@/pages/stats/BalancePanel';
import { METRIC_LABEL, UsageChart, type UsageMetric } from '@/pages/stats/UsageChart';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCompact, formatCount, formatIso } from '@/utils/format';

const { Text } = Typography;

// ── 相对窗口预设 ──────────────────────────────────────────────────────────

type Preset = '1h' | '6h' | '24h' | '7d';

const PRESETS: readonly Preset[] = ['1h', '6h', '24h', '7d'];

const PRESET_LABEL: Record<Preset, string> = {
  '1h': '最近 1 小时',
  '6h': '最近 6 小时',
  '24h': '最近 24 小时',
  '7d': '最近 7 天',
};

const PRESET_HOURS: Record<Preset, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 24 * 7 };

/** 预设同时匹配一个「配得上这个跨度」的粒度：避免 1m × 7 天这种桶数炸掉的组合。 */
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

const GROUP_BY_LABEL: Record<UsageGroupBy, string> = {
  key: '按 key',
  upstream: '按上游',
  group: '按用户组',
  model: '按模型',
};

const METRIC_ORDER: readonly UsageMetric[] = ['requests', 'tokens', 'costCents', 'errors'];

/** 自动刷新间隔：统计页是聚合查询，不需要仪表盘那种每秒帧。 */
const AUTO_REFRESH_MS = 15_000;

const EMPTY_AXIS: readonly string[] = [];
const EMPTY_SERIES: readonly never[] = [];

export default function StatsPage() {
  const [preset, setPreset] = useState<Preset>('24h');
  const [customRange, setCustomRange] = useState<[Dayjs, Dayjs] | null>(null);
  const [bucket, setBucket] = useState<UsageBucket>('1h');
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('upstream');
  const [metric, setMetric] = useState<UsageMetric>('requests');
  const [stacked, setStacked] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tick, setTick] = useState(0);

  const [upstreamId, setUpstreamId] = useState<string | undefined>(undefined);
  const [groupId, setGroupId] = useState<string | undefined>(undefined);
  const [model, setModel] = useState('');

  const usingCustomRange = customRange !== null;

  // 自定义绝对区间下没有「滚动」可言，自动刷新对它没意义，所以直接停掉。
  useEffect(() => {
    if (!autoRefresh || usingCustomRange) return;
    const timer = window.setInterval(() => {
      // 后台标签页不拉数据：省得开着页面挂一整夜在打聚合接口。
      if (document.visibilityState === 'visible') setTick((value) => value + 1);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, usingCustomRange]);

  const query = useMemo<UsageQuery>(() => {
    // tick 在依赖里：每跳一次就用新的 now 重新组窗口，这才是「实时更新」。
    const now = dayjs();
    const start = customRange ? customRange[0] : now.subtract(PRESET_HOURS[preset], 'hour');
    const end = customRange ? customRange[1] : now;
    return {
      from: start.toISOString(),
      to: end.toISOString(),
      bucket,
      groupBy,
      ...(upstreamId ? { upstreamId } : {}),
      ...(groupId ? { groupId } : {}),
      ...(model ? { model } : {}),
    };
  }, [preset, customRange, bucket, groupBy, upstreamId, groupId, model, tick]);

  const queryKey = JSON.stringify(query);
  const usage = useResource(() => statsApi.usage(JSON.parse(queryKey)), [queryKey]);

  const upstreams = useResource(() => upstreamsApi.list({ pageSize: 200 }), []);
  const groups = useResource(() => groupsApi.list({ pageSize: 200 }), []);

  const axis = useMemo(() => usage.data?.axis ?? EMPTY_AXIS, [usage.data]);
  const series = useMemo(() => usage.data?.series ?? EMPTY_SERIES, [usage.data]);

  /** 后端回显的粒度才是实际粒度（C2）。 */
  const effectiveBucket = usage.data?.bucket ?? bucket;

  const totals = useMemo(() => {
    let requests = 0;
    let tokens = 0;
    let costCents = 0;
    let errors = 0;
    for (const item of usage.data?.series ?? []) {
      for (const point of item.points) {
        requests += point.requests;
        tokens += point.tokens;
        costCents += point.costCents;
        errors += point.errors;
      }
    }
    return { requests, tokens, costCents, errors };
  }, [usage.data]);

  /** 契约要求等长；不等长就照原样画并说出来，不补桶、不补 0。 */
  const shapeWarning = useMemo(() => {
    const data = usage.data;
    if (!data) return null;
    const bad = data.series.filter((item) => item.points.length !== data.axis.length);
    if (bad.length === 0) return null;
    return `有 ${bad.length} 条序列的点数与时间轴不等长（契约 §6 要求等长且下标对齐）：${bad
      .slice(0, 3)
      .map((item) => item.label)
      .join('、')}${bad.length > 3 ? ' 等' : ''}。图表按后端返回原样绘制，未做补桶。`;
  }, [usage.data]);

  const metricOptions = METRIC_ORDER.map((value) => ({ label: METRIC_LABEL[value], value }));

  return (
    <>
      <PageHeader
        title="统计"
        description="按 key / 上游 / 用户组 / 时间的用量聚合"
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
              icon={<ReloadOutlined />}
              loading={usage.refreshing}
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
            // 换跨度顺手把粒度调到匹配档位，省得用户手动纠。
            setBucket(PRESET_BUCKET[next]);
          }}
        />
        <DatePicker.RangePicker
          size="small"
          showTime={{ format: 'HH:mm' }}
          placeholder={['自定义开始', '自定义结束']}
          value={customRange}
          onChange={(values) => {
            const start = values?.[0];
            const end = values?.[1];
            if (!start || !end) {
              setCustomRange(null);
              return;
            }
            setCustomRange([start, end]);
          }}
        />
        {usingCustomRange ? (
          <Tag
            bordered={false}
            style={{ marginInlineEnd: 0, background: tokens.tint.info, color: tokens.color.info }}
          >
            自定义区间
          </Tag>
        ) : null}

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
          style={{ width: 130 }}
          value={groupBy}
          options={(Object.keys(GROUP_BY_LABEL) as UsageGroupBy[]).map((value) => ({
            label: GROUP_BY_LABEL[value],
            value,
          }))}
          onChange={(value: UsageGroupBy) => setGroupBy(value)}
        />

        <Select
          allowClear
          size="small"
          style={{ width: 160 }}
          placeholder="全部上游"
          value={upstreamId}
          options={(upstreams.data?.items ?? []).map((item: Upstream) => ({
            label: item.name,
            value: item.id,
          }))}
          onChange={(value: string | undefined) => setUpstreamId(value)}
        />
        <Select
          allowClear
          size="small"
          style={{ width: 160 }}
          placeholder="全部用户组"
          value={groupId}
          options={(groups.data?.items ?? []).map((item: Group) => ({
            label: item.name,
            value: item.id,
          }))}
          onChange={(value: string | undefined) => setGroupId(value)}
        />
        <Tooltip title="按模型名精确匹配">
          <Input.Search
            size="small"
            allowClear
            style={{ width: 190 }}
            placeholder="模型名"
            onSearch={(value) => setModel(value)}
          />
        </Tooltip>
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
          hint="各序列各坐标点求和；统计口径完全来自后端返回的时间轴。"
        />
        <StatCard
          label="tokens"
          value={usage.data ? formatCompact(totals.tokens) : '—'}
          caption={usage.data ? `完整值 ${formatCount(totals.tokens)}` : '等待数据'}
          loading={usage.loading}
        />
        <StatCard
          label="成本"
          value={usage.data ? formatCents(totals.costCents) : '—'}
          caption="价格未知的模型不计入（未知 ≠ 0）"
          loading={usage.loading}
          hint="按模型档案的单价（分 / 1k tokens）折算；上游没给价格的模型不参与累加。"
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

      {usingCustomRange ? null : (
        <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: tokens.space.sm }}>
          区间为相对窗口，最近一次查询：{formatIso(query.from)} → {formatIso(query.to)}
        </Text>
      )}

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
              <Tooltip title="契约 C2：后端可按数据量降级粒度，前端按回显渲染。">
                <Tag
                  bordered={false}
                  style={{ marginInlineEnd: 0, background: tokens.tint.info, color: tokens.color.info }}
                >
                  后端回显粒度 {BUCKET_LABEL[usage.data.bucket]}
                </Tag>
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
            message={`含估算用量：${formatCount(usage.data.isEstimatedTokenCount)} 条调用的 token 是按字符估算的（is_estimated=1）`}
            description="这些用量已计入配额与图表，但不是上游真实报数；对账时请单独剔除。"
          />
        ) : null}

        {usage.loading ? (
          <LoadingState tip="正在加载用量…" minHeight={340} />
        ) : usage.error && !usage.data ? (
          <ErrorState error={usage.error} onRetry={usage.reload} variant="page" title="用量加载失败" />
        ) : series.length === 0 ? (
          <EmptyState
            title="该区间没有用量数据"
            description="换个时间区间或放宽筛选条件；也确认这段时间里确实有调用发生。"
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
            <UsageChart
              axis={axis}
              series={series}
              metric={metric}
              bucket={effectiveBucket}
              stacked={stacked}
            />
          </div>
        )}
      </div>

      <BalancePanel />
    </>
  );
}
