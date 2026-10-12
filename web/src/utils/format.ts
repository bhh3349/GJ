/**
 * 展示层格式化。契约 §0.2 的红线在这里落地：
 * - 金额一律「分 → 元」换算后展示，**不在业务组件里做除法**。
 * - `null` 是「未知」，`0` 是「确实是 0」，两者文案不同、颜色不同，绝不合流。
 * - 负数的符号用**真减号** U+2212（见 `formatCents`）：连字符比数字窄，等宽数字列会跳版。
 */
import dayjs from 'dayjs';

/** 金额（分）。`null` 用 `—`：适用于「上游没给」的价格、上下文档位。 */
export function formatCents(value: number | null | undefined, currency = 'CNY'): string {
  if (value === null || value === undefined) return '—';
  const symbol = currency === 'CNY' ? '¥' : `${currency} `;
  // 负数用**真减号** U+2212 而不是连字符：连字符在等宽字形里比数字窄，
  // 一列金额里混进几个负数就跳版；减号与「+」「-」同宽，tabular-nums 才真的对齐。
  const units = Math.abs(value) / 100;
  const body = units.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '\u2212' : ''}${symbol}${body}`;
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

/**
 * Token 计数（上游 `basic_token_*` 那一套）。
 *
 * 口径由 Bo 2026-10-12 定死：那是**套餐赠送的剩余 Token**，调用基础模型时扣减，
 * 1 个就是 1 个 Token，**不是钱、不折元**（曾按 1 元 = 500000 quota 折过，已撤）。
 * 中文量级用「万」做主单位；到 1000 万以上再附一个 `M` —— 上游手册和上游自己的页面
 * 都写 `8.0M` 这种形式，读的人要能和屏幕上那个数对上，所以两个单位同时给。
 */
export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const sign = value < 0 ? '\u2212' : '';
  const abs = Math.abs(value);
  if (abs < 10_000) return `${sign}${abs.toLocaleString('zh-CN')}`;
  if (abs < 10_000_000) {
    return `${sign}${(abs / 10_000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 万`;
  }
  const wan = Math.round(abs / 10_000).toLocaleString('zh-CN');
  return `${sign}${wan} 万（${(abs / 1_000_000).toFixed(1)}M）`;
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

/**
 * 进程运行时长（秒 → 「8h 33m」这类可读串）。契约 §12.2 `uptimeSec` 给的是**整数秒**。
 *
 * 上限只到「天」：`uptimeSec` 是进程口径（重启归零），不是"系统装了多久"，
 * 所以不往年月换算 —— 那会读成一个不存在的精度。
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** 字节数 → 人类可读（用于 §12.2 `db.fileSizeBytes` / `walSizeBytes`）。`null` 是「取不到」，不是 0。 */
export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[index]}`;
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
