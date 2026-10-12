/**
 * 套餐到期时间轴（Bo 2026-10-12 改进 ④）。
 *
 * 台账那张表按 `end_at ASC` 排，回答的是「接下来谁到期」，但**看不出节奏**：
 * 31 个套餐里有没有哪一天扎堆、哪几天是空的，得逐行读日期。
 * 这条时间轴把「哪几天有套餐到期、各几个」画成一天一根柱：今天在最左，14 天内高亮，
 * 点一根柱就把下面的表筛成那天到期的那些。
 *
 * 四条纪律：
 * - **没有到期时间的套餐不上轴**。上游没给 `end_at` 就没法把它放到某一天，
 *   硬塞进"今天"是把「不知道」画成一个确定的点。这类条数单独说出去（`unknownCount`）。
 * - **已过期的日子照画**（它们还在台账里、还是事实），但标成灰色并写「已过期」——
 *   把它们藏起来等于把"这个号早断了"这条信息藏起来。
 * - **轴的天数是数据决定的**（从最早到期日到今天之间），不写死宽度；跨度过大时
 *   按周聚合（`WEEK_SPAN_DAYS`），免得一天一根柱挤成一片。
 * - **今天不在数据范围内也要画出来** —— 时间轴的锚点是"今天"，没有它没法判断"还有几天"。
 */
import { Tooltip, Typography } from 'antd';
import { useMemo } from 'react';

import type { SupplierSubscriptionRow } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatCount } from '@/utils/format';
import { EXPIRING_WITHIN_DAYS, daysUntil } from '@/utils/supplierHealth';

const { Text } = Typography;

/** 跨度超过这么多天就按周聚合（一天一根柱会挤成一片）。 */
const WEEK_SPAN_DAYS = 45;

/** 本地日历日的键（`YYYY-MM-DD`）。上游给的是 ISO8601 UTC，这里按**本地日**归堆。 */
function localDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

interface Bucket {
  key: string;
  label: string;
  /** 该桶的代表日（用于 tooltip 与高亮判断）。 */
  date: Date;
  count: number;
  expired: boolean;
  /** 桶里有几条离今天 ≤ EXPIRING_WITHIN_DAYS（用于"即将到期"高亮）。 */
  soon: boolean;
}

export interface SubscriptionExpiryTimelineProps {
  rows: readonly SupplierSubscriptionRow[];
  /** 当前选中的日（`null` = 没选）。 */
  selectedDay: string | null;
  onSelectDay: (dayKey: string | null) => void;
}

export function SubscriptionExpiryTimeline({
  rows,
  selectedDay,
  onSelectDay,
}: SubscriptionExpiryTimelineProps) {
  const { buckets, unknownCount, expiredCount, soonCount } = useMemo(() => {
    const today = startOfLocalDay(new Date());
    const dated: { date: Date; days: number; expired: boolean }[] = [];
    let unknown = 0;

    for (const row of rows) {
      const days = daysUntil(row.endAt);
      if (days === null || !row.endAt) {
        unknown += 1;
        continue;
      }
      const at = startOfLocalDay(new Date(row.endAt));
      dated.push({ date: at, days, expired: days < 0 });
    }

    if (dated.length === 0) {
      return { buckets: [] as Bucket[], unknownCount: unknown, expiredCount: 0, soonCount: 0 };
    }

    const times = dated.map((item) => item.date.getTime());
    const minMs = Math.min(today.getTime(), ...times);
    const maxMs = Math.max(today.getTime(), ...times);
    const minDate = new Date(minMs);
    const spanDays = Math.round((maxMs - minMs) / 86_400_000);
    const weekly = spanDays > WEEK_SPAN_DAYS;

    // 按天（或按周）建桶，**包括中间那些 0 的天** —— 空档也是信息（这几天没有套餐到期）。
    const map = new Map<string, Bucket>();
    const totalDays = spanDays + (weekly ? 6 : 0);
    for (let i = 0; i <= totalDays; i += weekly ? 7 : 1) {
      const date = addDays(minDate, i);
      const key = localDayKey(date);
      map.set(key, {
        key,
        label: weekly
          ? `${date.getMonth() + 1}/${date.getDate()} 起一周`
          : `${date.getMonth() + 1}/${date.getDate()}`,
        date,
        count: 0,
        expired: false,
        soon: false,
      });
    }

    let expired = 0;
    let soon = 0;
    for (const item of dated) {
      const key = localDayKey(weekly
        ? (() => {
            const offset = Math.floor((item.date.getTime() - minMs) / 86_400_000 / 7) * 7;
            return addDays(minDate, offset);
          })()
        : item.date);
      const bucket = map.get(key);
      if (!bucket) continue;
      bucket.count += 1;
      if (item.expired) {
        bucket.expired = true;
        expired += 1;
      }
      if (item.days <= EXPIRING_WITHIN_DAYS) {
        bucket.soon = true;
        soon += 1;
      }
    }

    return {
      buckets: [...map.values()],
      unknownCount: unknown,
      expiredCount: expired,
      soonCount: soon,
    };
  }, [rows]);

  if (rows.length === 0) return null;

  const maxCount = buckets.reduce((max, bucket) => Math.max(max, bucket.count), 0);
  const todayKey = localDayKey(startOfLocalDay(new Date()));

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgBase,
        padding: `${tokens.space.sm}px ${tokens.space.md}px ${tokens.space.md}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.space.sm,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.space.sm, flexWrap: 'wrap' }}>
        <Text style={{ fontSize: 12, fontWeight: 600 }}>到期时间轴</Text>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {`${formatCount(soonCount)} 条 ${EXPIRING_WITHIN_DAYS} 天内到期 · 已过期 ${formatCount(expiredCount)} 条`}
        </Text>
        {unknownCount > 0 ? (
          <Tooltip title="上游没给 end_at —— 没有时刻就放不到某一天，硬塞进「今天」就是替供应商下结论。">
            <Text type="secondary" style={{ fontSize: 11 }}>
              {`${formatCount(unknownCount)} 条无到期时间（不上轴）`}
            </Text>
          </Tooltip>
        ) : null}
        {selectedDay !== null ? (
          <Text
            role="button"
            tabIndex={0}
            onClick={() => {
              onSelectDay(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelectDay(null);
            }}
            style={{ fontSize: 11, color: tokens.color.primary, cursor: 'pointer', userSelect: 'none' }}
          >
            清掉这一天的筛选
          </Text>
        ) : (
          <Text type="secondary" style={{ fontSize: 11 }}>
            点一根柱只看那天到期
          </Text>
        )}
      </div>

      {buckets.length === 0 ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          台账里没有一条带到期时间的套餐。
        </Text>
      ) : (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, overflowX: 'auto', paddingBottom: 2 }}>
          {buckets.map((bucket) => {
            const height = maxCount === 0 ? 0 : Math.max(3, Math.round((bucket.count / maxCount) * 44));
            const isToday = bucket.key === todayKey;
            const on = selectedDay === bucket.key;
            const color = bucket.expired
              ? tokens.color.textTertiary
              : bucket.soon
                ? tokens.color.orange
                : tokens.color.primary;
            return (
              <Tooltip
                key={bucket.key}
                title={
                  bucket.count === 0
                    ? `${bucket.label}：没有套餐到期`
                    : `${bucket.label}：${formatCount(bucket.count)} 条到期${bucket.expired ? '（含已过期）' : ''}`
                }
              >
                <button
                  type="button"
                  aria-pressed={on}
                  aria-label={`${bucket.label} ${bucket.count} 条到期`}
                  onClick={() => {
                    onSelectDay(on ? null : bucket.key);
                  }}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 2,
                    minWidth: 22,
                    padding: '2px 2px 0',
                    border: 'none',
                    borderRadius: tokens.radius.sm,
                    background: on ? tokens.tint.info : 'transparent',
                    cursor: bucket.count === 0 ? 'default' : 'pointer',
                    fontFamily: tokens.font.sans,
                  }}
                >
                  <span
                    style={{
                      fontSize: 10,
                      color: bucket.count === 0 ? tokens.color.textTertiary : color,
                      fontVariantNumeric: 'tabular-nums',
                      lineHeight: '12px',
                    }}
                  >
                    {bucket.count === 0 ? '' : formatCount(bucket.count)}
                  </span>
                  <span
                    style={{
                      width: 12,
                      height,
                      borderRadius: 3,
                      background: bucket.count === 0 ? tokens.color.border : color,
                      boxShadow: isToday ? `0 0 0 2px ${tokens.tint.info}` : 'none',
                      transition: `height ${tokens.motion.fast} ${tokens.motion.easing}`,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 10,
                      color: isToday ? tokens.color.info : tokens.color.textTertiary,
                      lineHeight: '12px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {isToday ? '今天' : bucket.label}
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      )}
    </div>
  );
}
