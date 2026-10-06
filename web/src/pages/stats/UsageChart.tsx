/**
 * 用量图 —— ECharts **按需引入**：只注册实际用到的图表 / 组件 / 渲染器，
 * 既不整包引入，也不进 `manualChunks`，所以 echarts 只会落在 `/stats` 这条路由的 chunk 里，
 * 不碰首屏关键路径（PM 挂账的 antd 体积项另有单独一轮，这里不掺和）。
 *
 * 契约纪律：
 * - `axis` 与 `series[].points` **等长且下标对齐**由后端保证（契约 §6）。
 *   前端**不做二次聚合、不补桶**：长度不一致就照后端返回的画，并在页面上明说，
 *   宁可显示缺口，也不编造 0。
 * - 时间轴传进来是 ISO8601 UTC，展示按本地时区；`bucket` 决定刻度粒度。
 * - `null` 语义在这里不适用（计数缺失补 0 是契约允许的），金额单位仍是分。
 */
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import dayjs from 'dayjs';
import { useEffect, useRef } from 'react';

import type { UsageBucket, UsageSeries } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCompact, formatCount } from '@/utils/format';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export type UsageMetric = 'requests' | 'tokens' | 'promptTokens' | 'completionTokens' | 'costCents' | 'errors';

export const METRIC_LABEL: Record<UsageMetric, string> = {
  requests: '请求数',
  tokens: 'tokens',
  promptTokens: '输入 tokens',
  completionTokens: '输出 tokens',
  costCents: '成本',
  errors: '错误数',
};

/** 深色底上的序列配色：主色打头，其余按可辨识度排。 */
const PALETTE = [
  tokens.color.primary,
  tokens.color.success,
  tokens.color.warning,
  tokens.color.info,
  '#A78BFA',
  '#F472B6',
  '#22D3EE',
  '#FB923C',
  '#4ADE80',
  '#818CF8',
];

function colorAt(index: number): string {
  return PALETTE[index % PALETTE.length] ?? tokens.color.primary;
}

/** 轴刻度粒度由后端回显的 bucket 决定，不由「用户以为选了什么」决定。 */
function axisTimeFormat(bucket: UsageBucket): string {
  if (bucket === '1d') return 'MM-DD';
  if (bucket === '1h') return 'MM-DD HH:mm';
  return 'HH:mm';
}

function formatMetric(metric: UsageMetric, value: number): string {
  if (metric === 'costCents') return formatCents(value);
  return formatCount(value);
}

/** 轴标签要短，否则挤成一团。 */
function formatAxisLabel(metric: UsageMetric, value: number): string {
  if (metric === 'costCents') return formatCents(value);
  return formatCompact(value);
}

/** 系列名来自上游/模型/组名，进 HTML tooltip 前一律转义。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface UsageChartProps {
  axis: readonly string[];
  series: readonly UsageSeries[];
  metric: UsageMetric;
  bucket: UsageBucket;
  stacked: boolean;
  height?: number;
}

function buildOption(
  axis: readonly string[],
  series: readonly UsageSeries[],
  metric: UsageMetric,
  bucket: UsageBucket,
  stacked: boolean,
): EChartsCoreOption {
  const tickFormat = axisTimeFormat(bucket);

  return {
    backgroundColor: 'transparent',
    animationDuration: 240,
    grid: { left: 4, right: 12, top: 36, bottom: 4, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: tokens.color.borderStrong } },
      backgroundColor: tokens.color.bgContainerHover,
      borderColor: tokens.color.border,
      borderWidth: 1,
      padding: 10,
      textStyle: { color: tokens.color.textPrimary, fontSize: 12 },
      formatter: (params: unknown): string => {
        if (!Array.isArray(params) || params.length === 0) return '';
        const rows = params as readonly {
          dataIndex?: unknown;
          seriesIndex?: unknown;
          marker?: unknown;
          seriesName?: unknown;
          value?: unknown;
        }[];
        const firstIndex = rows[0]?.dataIndex;
        const index = typeof firstIndex === 'number' ? firstIndex : -1;
        const bucketTime = index >= 0 ? axis[index] : undefined;
        const head =
          bucketTime === undefined
            ? '—'
            : `${dayjs(bucketTime).format('YYYY-MM-DD HH:mm')}（本地）`;
        const body = rows
          .map((row) => {
            const value = typeof row.value === 'number' ? row.value : 0;
            const marker = typeof row.marker === 'string' ? row.marker : '';
            const name = typeof row.seriesName === 'string' ? row.seriesName : '';
            // 该点是否含估算 token（is_estimated=1）：seriesIndex/dataIndex 回查原始 points。
            const point =
              typeof row.seriesIndex === 'number' && typeof row.dataIndex === 'number'
                ? series[row.seriesIndex]?.points[row.dataIndex]
                : undefined;
            const estimated = point !== undefined && point.estimatedTokens > 0;
            const estimatedTag = estimated
              ? `&nbsp;<span style="color:${tokens.color.warning}">· 含估算</span>`
              : '';
            return `${marker}${escapeHtml(name)}&nbsp;&nbsp;<b>${formatMetric(metric, value)}</b>${estimatedTag}`;
          })
          .join('<br/>');
        return `<div style="color:${tokens.color.textSecondary};font-size:11px;margin-bottom:4px">${head}</div>${body}`;
      },
    },
    legend: {
      type: 'scroll',
      top: 0,
      left: 0,
      icon: 'roundRect',
      itemWidth: 8,
      itemHeight: 8,
      itemGap: 12,
      textStyle: { color: tokens.color.textSecondary, fontSize: 11 },
      inactiveColor: tokens.color.textTertiary,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: axis.map((item) => dayjs(item).format(tickFormat)),
      axisLine: { lineStyle: { color: tokens.color.border } },
      axisTick: { show: false },
      axisLabel: { color: tokens.color.textTertiary, fontSize: 11, hideOverlap: true },
    },
    yAxis: {
      type: 'value',
      splitLine: { lineStyle: { color: tokens.color.border, type: 'dashed' } },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: tokens.color.textTertiary,
        fontSize: 11,
        formatter: (value: number) => formatAxisLabel(metric, value),
      },
      minInterval: metric === 'costCents' ? undefined : 1,
    },
    series: series.map((item, index) => ({
      name: item.label,
      type: 'line',
      smooth: true,
      showSymbol: series.length <= 8,
      symbolSize: 5,
      lineStyle: { width: 1.8, color: colorAt(index) },
      itemStyle: { color: colorAt(index) },
      emphasis: { focus: 'series' },
      // 堆叠开关：只有开启时才带 stack，避免 exactOptionalPropertyTypes 下的 undefined。
      ...(stacked ? { stack: 'total', areaStyle: { opacity: 0.16, color: colorAt(index) } } : {}),
      // 直接按后端 points 顺序取，长度不一致也不补 0（契约说等长，不等长就是不等长）。
      data: item.points.map((point) => point[metric]),
    })),
  };
}

export function UsageChart({ axis, series, metric, bucket, stacked, height = 340 }: UsageChartProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const chart = init(holder, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    // 侧边栏折叠、窗口缩放都要跟着重算尺寸，否则图会留白。
    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(holder);
    return () => {
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // notMerge：切换 groupBy/metric 时序列条数会变，合并会残留上一条的系列。
    chart.setOption(buildOption(axis, series, metric, bucket, stacked), true);
  }, [axis, series, metric, bucket, stacked]);

  return <div ref={holderRef} style={{ width: '100%', height }} />;
}
