/**
 * §12.1 错误分型 / §12.3 事件字段在 UI 上的**唯一**中文标签事实源。
 *
 * 为什么单独立一个文件：分型标签原先长在 DashboardPage 里（`CATEGORY_LABEL`）。
 * 助手页的「价格与错误汇总表」需要同一份分型口径 —— 如果在那里再抄一遍，
 * 两处就会开始漂移（同码不同名，读的人以为分型变了）。九个分型**逐字取自契约枚举**，
 * 不在这里自造分类，也不按 HTTP 状态现推分型（契约：`category` 是唯一判据）。
 */
import type { ObservabilityCategory, ObservabilitySeverity } from '@/api/types';
import { tokens } from '@/theme/tokens';

export const CATEGORY_LABEL: Record<ObservabilityCategory, string> = {
  CLIENT_REQUEST: '调用方写错',
  AUTH_FAILED: '鉴权失败',
  RATE_LIMITED: '限流',
  QUOTA_EXCEEDED: '配额用尽',
  NO_AVAILABLE_KEY: '无可用 key',
  UPSTREAM_ERROR: '上游错误',
  UPSTREAM_TIMEOUT: '上游超时',
  CLIENT_ABORTED: '客户端断开',
  INTERNAL: '网关自身异常',
};

/** 分型 → 人话归因（一句）。口径全部来自契约 §12.1 的分型表，不加判断、不建议。 */
export const CATEGORY_HINT: Record<ObservabilityCategory, string> = {
  CLIENT_REQUEST: '请求体本身不合法，没打到上游。',
  AUTH_FAILED: '网关 key 缺失或不认识，未过鉴权。',
  RATE_LIMITED: '撞上 RPM / TPM / 日配额或上游 429。',
  QUOTA_EXCEEDED: '该用户组当日配额已用完。',
  NO_AVAILABLE_KEY: '该模型没有可用 key（全冷却、全禁用或余额未知被挡）。',
  UPSTREAM_ERROR: '上游回了 4xx / 5xx。',
  UPSTREAM_TIMEOUT: '上游超时未回。',
  CLIENT_ABORTED: '客户端在响应结束前断开（499）。',
  INTERNAL: '网关自身异常。',
};

/** 分型可能是契约九个之外的历史值（枚举只会加不会删），所以取值必须容错。 */
export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category as ObservabilityCategory] ?? category;
}

export function categoryHint(category: string): string | null {
  return CATEGORY_HINT[category as ObservabilityCategory] ?? null;
}

/**
 * `warn` = 调用方 / 配额侧（不是我们的故障），`error` = 系统侧。
 * 沿用 §12.1 的语义色，不复用 HTTP 状态色 —— 同一个 429 可能是限流（warn）也可能是上游拒绝。
 */
export function severityTone(severity: ObservabilitySeverity): { color: string; bg: string } {
  return severity === 'warn'
    ? { color: tokens.color.warning, bg: tokens.tint.warning }
    : { color: tokens.color.error, bg: tokens.tint.error };
}
