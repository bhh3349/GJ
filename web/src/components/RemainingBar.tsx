/**
 * 「还剩多少」的百分比 + 进度线（Bo 2026-10-12 改进 ⑥）。
 *
 * 一列金额读不出**节奏**：¥3.20 是"快用完了"还是"刚开的一瓶"，取决于总额是多少。
 * 所以这一格给两条信息：剩余金额（原样）+ 剩余占总额的比例。
 *
 * 三条纪律：
 * - **比例算不出来就不画**。总额 ≤ 0 或任一端未知时 `ratio` 是 `null`：
 *   一根 0% 的条看起来像"用光了"，而事实是"不知道"。
 * - **剩余 ≤ 10% 转琥珀、= 0 转橙**（与账号健康档同一套色），让人一眼挑出该续的那几个。
 * - 负数（上游侧触到额度上限）**按 0 画条、按比例显示 `−`**：条长不能是负的，
 *   但那个超出是事实，得写出来（红减号是 U+2212，与连字符区分，等宽对齐才不跳）。
 */
import { Tooltip, Typography } from 'antd';

import { tokens } from '@/theme/tokens';

const { Text } = Typography;

/** 剩余占比低于此值转琥珀。 */
const LOW_RATIO = 0.1;

export interface RemainingBarProps {
  /** 0..1；`null` = 算不出来（未知），此时**不画条、不显示百分比**。 */
  ratio: number | null;
  /** 百分比左侧的那句金额文案（由调用方给，本组件不参与金额口径）。 */
  children: React.ReactNode;
  /** 悬浮补充说明。 */
  hint?: string | undefined;
  /** 条下方的次要口径（总额 / 已用这类）。不传就不占一行。 */
  caption?: React.ReactNode;
}

export function RemainingBar({ ratio, children, hint, caption = null }: RemainingBarProps) {
  const clamped = ratio === null ? null : Math.min(1, Math.max(0, ratio));
  const exhausted = ratio !== null && ratio <= 0;
  const low = clamped !== null && clamped < LOW_RATIO;
  const color = exhausted
    ? tokens.color.orange
    : low
      ? tokens.color.warning
      : tokens.color.success;

  const bar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-end', minWidth: 96 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        {children}
        {ratio === null ? null : (
          <Text
            style={{
              fontSize: 11,
              color,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            {/*
              百分比按 `ratio` 原值显示、条长按 `clamped` 画：剩余是负数（上游侧超出上限）时
              条不能是负长度，但那个超出是事实，写成 `−n%` 而不是假装 0%。
            */}
            {`${ratio < 0 ? '\u2212' : ''}${Math.round(Math.abs(ratio) * 100)}%`}
          </Text>
        )}
      </div>
      <div
        style={{
          width: 88,
          height: 3,
          borderRadius: 2,
          background: tokens.color.border,
          overflow: 'hidden',
        }}
      >
        {clamped === null ? null : (
          <div
            style={{
              width: `${clamped * 100}%`,
              height: '100%',
              background: color,
              transition: `width ${tokens.motion.base} ${tokens.motion.easing}`,
            }}
          />
        )}
      </div>
      {caption ? (
        <Text
          type="secondary"
          style={{ fontSize: 11, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
        >
          {caption}
        </Text>
      ) : null}
    </div>
  );

  if (!hint) return bar;
  return <Tooltip title={hint}>{bar}</Tooltip>;
}
