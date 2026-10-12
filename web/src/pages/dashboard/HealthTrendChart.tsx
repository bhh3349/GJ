/**
 * 请求量 / 延迟趋势图（契约 §12.2 健康快照 `GET /api/observability/health/snapshots`）。
 *
 * 数据源是**每 60s 一条的历史快照**，不是 §6 的实时帧 —— 所以这条线回答的是
 * "刚才这一小时流量长什么样"，与仪表盘顶部那排卡（当前窗口值）不是同一件事。
 *
 * 三条纪律：
 * 1. **快照是当时算出来的历史，不允许事后重算**（契约 §12.2）。这里只画后端给的数，
 *    不做本地二次聚合、不补点。
 * 2. **`p50Ms` / `p99Ms` 为 `null` 时断线，不画 0**。契约明写 `samples=0` 时两个分位是
 *    `null` 而不是 0 —— 把「没有样本」画成「0ms 延迟」是这条线上最容易造的假。
 * 3. **`successRate` 在 `requests=0` 时后端给 `1` 是约定不是断言**，所以这条序列按
 *    `requests>0` 的桶取值，无流量的桶是 `null`（断线），不画一条贴着 100% 的假平线。
 */
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import dayjs from 'dayjs';
import { useEffect, useMemo, useRef } from 'react';

import type { ObservabilityHealthSnapshot } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatCount, formatLatency, formatPercent } from '@/utils/format';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

export type HealthMetric = 'requests' | 'errors' | 'p50' | 'p99' | 'successRate';

export const HEALTH_METRIC_LABEL: Record<HealthMetric, string> = {
  requests: '请求数',
  errors: '错误数',
  p50: 'P50 延迟',
  p99: 'P99 延迟',
  successRate: '成功率',
};

/** 该指标是否走左轴（计数）还是右轴（延迟 ms / 百分比）。 */
function isCountMetric(metric: HealthMetric): boolean {
  return metric === 'requests' || metric === 'errors' || metric === 'successRate';
}

function valueAt(row: ObservabilityHealthSnapshot, metric: HealthMetric): number | null {
  switch (metric) {
    case 'requests':
      return row.requests;
    case 'errors':
      return row.errors;
    case 'p50':
      return row.p50Ms;
    case 'p99':
      return row.p99Ms;
    case 'successRate':
      // 无流量的桶不算成功率 —— 后端那个 1 是约定，画出来是一条不存在的平线。
      return row.requests > 0 ? row.successRate * 100 : null;
    default:
      return null;
  }
}

function formatValue(metric: HealthMetric, value: number | null): string {
  if (value === null) return '无样本';
  if (metric === 'p50' || metric === 'p99') return formatLatency(value);
  if (metric === 'successRate') return formatPercent(value / 100, 1);
  return formatCount(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface HealthTrendChartProps {
  /** 后端给的快照，`ts DESC`。本组件内部按时间升序画。 */
  snapshots: readonly ObservabilityHealthSnapshot[];
  metrics: readonly HealthMetric[];
  height?: number;
}

export default function HealthTrendChart({
  snapshots,
  metrics,
  height = 260,
}: HealthTrendChartProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);

  const { axis, columns } = useMemo(() => {
    const ordered = [...snapshots].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    return {
      axis: ordered.map((row) => row.ts),
      columns: metrics.map((metric) => ordered.map((row) => valueAt(row, metric))),
    };
  }, [snapshots, metrics]);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    const chart = init(holder, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
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

    const hasRightAxis = metrics.some((metric) => !isCountMetric(metric));

    const option: EChartsCoreOption = {
      backgroundColor: 'transparent',
      animationDuration: 240,
      grid: { left: 4, right: hasRightAxis ? 4 : 12, top: 34, bottom: 4, containLabel: true },
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
          const rows = params as readonly { dataIndex?: unknown; seriesIndex?: unknown; marker?: unknown; seriesName?: unknown }[];
          const rawIndex = rows[0]?.dataIndex;
          const index = typeof rawIndex === 'number' ? rawIndex : -1;
          const stamp = index >= 0 ? axis[index] : undefined;
          const head = stamp === undefined ? '—' : `${dayjs(stamp).format('MM-DD HH:mm')}（本地 · 快照时刻）`;
          const body = rows
            .map((row) => {
              const seriesIndex = typeof row.seriesIndex === 'number' ? row.seriesIndex : -1;
              const metric = metrics[seriesIndex];
              const marker = typeof row.marker === 'string' ? row.marker : '';
              const name = typeof row.seriesName === 'string' ? row.seriesName : '';
              const value = index >= 0 ? columns[seriesIndex]?.[index] : null;
              const shown =
                value === null || value === undefined
                  ? `<span style="color:${tokens.color.textTertiary}">无样本</span>`
                  : `<b>${escapeHtml(formatValue(metric ?? 'requests', value))}</b>`;
              return `${marker}${escapeHtml(name)}&nbsp;&nbsp;${shown}`;
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
        data: axis.map((t) => dayjs(t).format('HH:mm')),
        axisLine: { lineStyle: { color: tokens.color.border } },
        axisTick: { show: false },
        axisLabel: { color: tokens.color.textTertiary, fontSize: 11, hideOverlap: true },
      },
      yAxis: [
        {
          type: 'value',
          name: hasRightAxis ? '计数' : undefined,
          nameTextStyle: { color: tokens.color.textTertiary, fontSize: 10 },
          splitLine: { lineStyle: { color: tokens.color.border, type: 'dashed' } },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: tokens.color.textTertiary, fontSize: 11 },
          minInterval: 1,
        },
        {
          type: 'value',
          name: '延迟 ms',
          nameTextStyle: { color: tokens.color.textTertiary, fontSize: 10 },
          show: hasRightAxis,
          splitLine: { show: false },
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: tokens.color.textTertiary, fontSize: 11 },
        },
      ],
      series: metrics.map((metric, index) => ({
        name: HEALTH_METRIC_LABEL[metric],
        type: 'line',
        smooth: false,
        showSymbol: axis.length <= 90,
        symbolSize: 4,
        yAxisIndex: isCountMetric(metric) ? 0 : 1,
        lineStyle: { width: 1.8, color: tokens.chart.series[index % tokens.chart.series.length] },
        itemStyle: { color: tokens.chart.series[index % tokens.chart.series.length] },
        areaStyle:
          metric === 'requests'
            ? { opacity: 0.14, color: tokens.chart.series[index % tokens.chart.series.length] }
            : undefined,
        emphasis: { focus: 'series' },
        // 断线不连：`null` 是「那一刻没有样本」，连过去就是凭空画一段不存在的延迟。
        connectNulls: false,
        data: columns[index] ?? [],
      })),
    };

    chart.setOption(option, true);
  }, [axis, columns, metrics]);

  return <div ref={holderRef} style={{ width: '100%', height }} />;
}
