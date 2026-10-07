/**
 * 余额趋势图（契约 §14.3 `series[].points[]`）。
 *
 * ECharts **按需引入**，与 `UsageChart` 同款：只注册用到的东西。
 * 本组件由仪表盘经 `React.lazy` 载入，所以 echarts 不进首屏关键路径（验收：首屏 < 2s）。
 *
 * 三条契约纪律，逐条落地，别"顺手"改：
 * 1. **没有等长轴**：§14.3 明写"节奏不规则（抖动 + 退避 + 关闭期），要造一条均匀轴就得发明
 *    不存在的点 ⇒ 前端按 `points[].t` 画时间序列"。所以这里取的轴 = **所有快照时刻的并集**，
 *    某上游在该刻没有快照就是 `null`（断线），**不插值、不补点**。
 * 2. **`null` ≠ 0**：`totalBalanceCents === null` 表示"那一刻该上游全未知"。
 *    补成 0 会在图上画出一条"余额跌到零"的假线 —— 这正是 §14.2 花整节禁止的事。
 * 3. **不判钱、不判漂移**：本组件只画金额。漂移是方向级提示，归 `BalanceDriftPanel`，
 *    不在图上加任何"异常"标记。
 */
import { LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { init, use, type EChartsCoreOption, type EChartsType } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import dayjs from 'dayjs';
import { useEffect, useMemo, useRef } from 'react';

import type { BalanceSyncPoint, BalanceSyncSeries } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCount } from '@/utils/format';

use([LineChart, GridComponent, LegendComponent, TooltipComponent, CanvasRenderer]);

/** 轴标签粒度：窗口最大 24h（§14.3），所以只到分钟。 */
function axisLabel(t: string): string {
  return dayjs(t).format('MM-DD HH:mm');
}

function colorAt(index: number): string {
  const palette = tokens.chart.series;
  return palette[index % palette.length] ?? tokens.color.primary;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface Built {
  /** 所有快照时刻的并集（升序）。 */
  axis: string[];
  /** 每条序列按轴对齐后的取值；缺快照处是 `null`（断线，不是 0）。 */
  columns: (number | null)[][];
}

function buildAxis(series: readonly BalanceSyncSeries[]): Built {
  const stamps = new Set<string>();
  for (const item of series) for (const point of item.points) stamps.add(point.t);
  const axis = [...stamps].sort((a, b) => Date.parse(a) - Date.parse(b));

  const index = new Map<string, number>();
  axis.forEach((t, i) => index.set(t, i));

  const columns = series.map((item) => {
    const column: (number | null)[] = axis.map(() => null);
    for (const point of item.points) {
      const i = index.get(point.t);
      // 重复时刻理论上不该出现（同一上游同一刻两条快照）；真出现就留后一条，不累加。
      if (i !== undefined) column[i] = point.totalBalanceCents;
    }
    return column;
  });

  return { axis, columns };
}

function pointAt(series: readonly BalanceSyncSeries[], seriesIndex: number, t: string): BalanceSyncPoint | undefined {
  return series[seriesIndex]?.points.find((point) => point.t === t);
}

function buildOption(series: readonly BalanceSyncSeries[], built: Built): EChartsCoreOption {
  const { axis, columns } = built;

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
        const rows = params as readonly { dataIndex?: unknown; seriesIndex?: unknown; marker?: unknown; seriesName?: unknown }[];
        const rawIndex = rows[0]?.dataIndex;
        const index = typeof rawIndex === 'number' ? rawIndex : -1;
        const stamp = index >= 0 ? axis[index] : undefined;
        const head =
          stamp === undefined ? '—' : `${dayjs(stamp).format('YYYY-MM-DD HH:mm')}（快照时刻 · 本地）`;

        const body = rows
          .map((row) => {
            const seriesIndex = typeof row.seriesIndex === 'number' ? row.seriesIndex : -1;
            const marker = typeof row.marker === 'string' ? row.marker : '';
            const name = typeof row.seriesName === 'string' ? row.seriesName : '';
            const point = stamp === undefined ? undefined : pointAt(series, seriesIndex, stamp);
            if (point === undefined) {
              // 该刻这条序列没有快照点 —— 明说"无快照"，绝不写 0。
              return `${marker}${escapeHtml(name)}&nbsp;&nbsp;<span style="color:${tokens.color.textTertiary}">无快照</span>`;
            }
            const value =
              point.totalBalanceCents === null
                ? `<span style="color:${tokens.color.warning}">未知</span>`
                : `<b>${formatCents(point.totalBalanceCents)}</b>`;
            const counts = `已知 ${formatCount(point.knownKeyCount)} · 未知 ${formatCount(point.unknownKeyCount)} · 无限 ${formatCount(point.unlimitedKeyCount)} · 套餐 ${formatCount(point.tokenPlanKeyCount)}`;
            return `${marker}${escapeHtml(name)}&nbsp;&nbsp;${value}<div style="color:${tokens.color.textTertiary};font-size:11px;padding-left:14px">${counts}</div>`;
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
      data: axis.map(axisLabel),
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
        formatter: (value: number) => formatCents(value),
      },
    },
    series: series.map((item, index) => ({
      name: item.label,
      type: 'line',
      smooth: false,
      showSymbol: true,
      symbolSize: 5,
      lineStyle: { width: 1.8, color: colorAt(index) },
      itemStyle: { color: colorAt(index) },
      emphasis: { focus: 'series' },
      // 断点不连线：缺快照就是缺快照，连过去会凭空画出一段不存在的余额。
      connectNulls: false,
      data: columns[index] ?? [],
    })),
  };
}

export interface BalanceTrendChartProps {
  series: readonly BalanceSyncSeries[];
  height?: number;
  loading?: boolean;
}

export default function BalanceTrendChart({ series, height = 320, loading = false }: BalanceTrendChartProps) {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const built = useMemo(() => buildAxis(series), [series]);

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
    chart.setOption(buildOption(series, built), true);
  }, [series, built]);

  if (loading) {
    return (
      <div
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.color.textTertiary,
          fontSize: 12,
        }}
      >
        正在加载余额趋势…
      </div>
    );
  }

  return <div ref={holderRef} style={{ width: '100%', height }} />;
}
