/**
 * 展示层格式化。契约 §0.2 的红线在这里落地：
 * - 金额一律「分 → 元」换算后展示，**不在业务组件里做除法**。
 * - `null` 是「未知」，`0` 是「确实是 0」，两者文案不同、颜色不同，绝不合流。
 */
import dayjs from 'dayjs';

/** 金额（分）。`null` 用 `—`：适用于「上游没给」的价格、上下文档位。 */
export function formatCents(value: number | null | undefined, currency = 'CNY'): string {
  if (value === null || value === undefined) return '—';
  const units = value / 100;
  const symbol = currency === 'CNY' ? '¥' : `${currency} `;
  return `${symbol}${units.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * 余额（分）。`null` 用「未知」——**这不是 `—` 也不是 `0`**。
 * 契约 ADR-0003：未知不得补 0 计入合计，UI 必须能把两者分开看。
 */
export function formatBalance(value: number | null | undefined, currency = 'CNY'): string {
  if (value === null || value === undefined) return '未知';
  return formatCents(value, currency);
}

/** 整数计数（token / 请求数）。 */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('zh-CN');
}

/** 紧凑计数：列表里省宽度，如 `154.0k`。 */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (Math.abs(value) < 1000) return String(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** 契约给的是 0..1 小数，不是百分数。 */
export function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

/** ISO8601 UTC → 本地时间。契约禁止无时区时间串，这里按本地时区呈现。 */
export function formatIso(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD HH:mm:ss') : '—';
}

/** 相对时间，用于「余额更新于 / 最后失败于」。 */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = dayjs(value);
  if (!parsed.isValid()) return '—';
  const diffMs = Date.now() - parsed.valueOf();
  const abs = Math.abs(diffMs);
  if (abs < 60_000) return '刚刚';
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)} 分钟前`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)} 小时前`;
  return `${Math.floor(abs / 86_400_000)} 天前`;
}

export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** 冷却剩余时间，展示为「冷却中 · 剩 4m」这类可读文案。 */
export function formatCooldown(until: string | null | undefined): string | null {
  if (!until) return null;
  const parsed = dayjs(until);
  if (!parsed.isValid()) return null;
  const remainMs = parsed.valueOf() - Date.now();
  if (remainMs <= 0) return null;
  if (remainMs < 60_000) return `剩 ${Math.ceil(remainMs / 1000)}s`;
  if (remainMs < 3_600_000) return `剩 ${Math.ceil(remainMs / 60_000)}m`;
  return `剩 ${Math.ceil(remainMs / 3_600_000)}h`;
}
