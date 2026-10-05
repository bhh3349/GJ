// 时间口径唯一的收敛点。
//
// 契约 §0.2：时间一律 ISO8601 **UTC**，形如 2026-10-06T12:00:00.000Z。
// 落库也用同一形态的 TEXT —— 这样 SQLite 里字符串排序 == 时间排序，
// 时间范围查询可以直接用 `ts >= ?` 走索引，不需要再套 datetime() 函数（那会让索引失效）。

/** 当前时刻，ISO8601 UTC，毫秒精度。 */
export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(date: Date): string {
  return date.toISOString();
}

/**
 * 严格校验 ISO8601 且**必须带时区**。
 * 契约 §0.2 明确「不带时区的时间串视为非法」——`2026-10-06T12:00:00` 这种串
 * 在不同机器上会被解释成不同时刻，放进查询条件是静默错数据，所以这里直接拒绝。
 */
const ISO_WITH_TZ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isIso8601WithTz(value: string): boolean {
  if (!ISO_WITH_TZ.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

/** UTC 自然日（YYYY-MM-DD）。用于 todayTokens / 日配额的归属日。 */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** 会话过期时刻 */
export function isoAfterHours(hours: number, from: Date = new Date()): string {
  return new Date(from.getTime() + hours * 3600_000).toISOString();
}

/**
 * bucket 起点对齐。契约 §6：桶边界按 UTC 对齐，且必须与响应里的 `axis` 一致。
 * 用毫秒做加法而不是 setMinutes，是为了绕开本地时区对 Date 的那些隐式影响。
 */
const BUCKET_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

export function bucketMs(bucket: string): number | null {
  return BUCKET_MS[bucket] ?? null;
}

export function floorToBucket(iso: string, bucket: string): string {
  const ms = BUCKET_MS[bucket];
  if (ms === undefined) throw new Error(`未知 bucket: ${bucket}`);
  return new Date(Math.floor(Date.parse(iso) / ms) * ms).toISOString();
}
