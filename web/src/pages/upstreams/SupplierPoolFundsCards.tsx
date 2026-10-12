/**
 * 账号池三个**资金池**卡（钱包 / 套餐高级额度 / 基础额度）。
 *
 * 一块卡一个池，**刻意不合并成一张"总余额"表**：三个池子来自三个不同的地方
 * （账号钱包、套餐高级额度、套餐赠送的基础额度），互不相通、相加得出的是一个不存在的数。
 * 所以：三个尺寸不同的大字 + 三个量纲徽标 + 顶部一句「互不相通，不可相加」。
 *
 * 三条渲染纪律（口径全在 `utils/poolFunds.ts`，这里只负责说人话）：
 * - **未知不补 0**：余额未知的账号不计入合计，但必须数出来（「m 个未知不计」）。
 * - **只给全池数**：服务端没给池级口径、页内又没取回全池时**不显示合计** ——
 *   一个"第 1 页的合计"比"没有合计"更坏，它长得像池子的钱。
 * - **基础额度以原值计数为主值**：上游给的是 `basic_token_*` 计数，它**是不是**可折元的 quota
 *   站内还没有一锤实测（套餐台账那一列暂按 1 元 = 500000 折元渲染，是**推断**不是结论）。
 *   所以这里主值给原值、副行把折元写成**带前提的参考值**（「若按…」），不冒充结论。
 */
import { Tooltip, Typography } from 'antd';
import type { ReactNode } from 'react';

import type { Upstream } from '@/api/types';
import { BalanceText } from '@/components/BalanceText';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCount } from '@/utils/format';
import type { PoolFunds } from '@/utils/poolFunds';
import { LOW_BALANCE_CENTS } from '@/utils/supplierHealth';

const { Text } = Typography;

/** 与套餐台账那一列同一换算比（1 元 = 500000 quota）；这里只用于「若按此口径」的参考值。 */
const QUOTA_PER_UNIT = 500_000;

interface PoolCardProps {
  label: string;
  /** 量纲徽标（¥ / 计数）。让三个池子一眼看出不是一个单位。 */
  unit: string;
  value: ReactNode;
  /** 大字下方的口径说明。 */
  caption: ReactNode;
  /** 尺寸档：钱包 > 高级额度 > 基础额度，用视觉层级表达"能花的钱"到"不确定的量"。 */
  size: 'lg' | 'md' | 'sm';
  hint: string;
  /** 数值取不到时的补充文案（比如"合计只覆盖取回的部分"）。 */
  pending?: string | undefined;
}

const SIZE_FONT: Record<PoolCardProps['size'], number> = { lg: 26, md: 21, sm: 17 };

function PoolCard({ label, unit, value, caption, size, hint, pending }: PoolCardProps) {
  return (
    <div
      style={{
        flex: '1 1 220px',
        minWidth: 220,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: tokens.space.md,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.space.xs,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.xs }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {label}
        </Text>
        <span
          style={{
            fontSize: 10,
            lineHeight: '16px',
            padding: '0 6px',
            borderRadius: tokens.radius.sm,
            background: tokens.tint.neutral,
            color: tokens.color.textTertiary,
          }}
        >
          {unit}
        </span>
      </div>
      <Tooltip title={hint}>
        <div
          style={{
            fontSize: SIZE_FONT[size],
            fontWeight: 600,
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1.15,
            color: tokens.color.textPrimary,
            minHeight: SIZE_FONT[size] * 1.15,
          }}
        >
          {value}
        </div>
      </Tooltip>
      <div style={{ fontSize: 11, color: tokens.color.textTertiary, lineHeight: 1.5 }}>{caption}</div>
      {pending ? (
        <div style={{ fontSize: 11, color: tokens.color.warning, lineHeight: 1.5 }}>{pending}</div>
      ) : null}
    </div>
  );
}

export interface SupplierPoolFundsCardsProps {
  /** null = 全池还没取回来（首帧）。不渲染任何数字，也不渲染 0。 */
  funds: PoolFunds | null;
  /** 服务端池级口径来源（`accountsBalance` 是全池账号级合计）。 */
  upstream: Upstream | null;
}

export function SupplierPoolFundsCards({ funds, upstream }: SupplierPoolFundsCardsProps) {
  if (!funds) return null;

  const walletTotal = upstream?.accountsBalance ?? (funds.complete ? funds.wallet.total : null);
  const premiumTotal = funds.complete ? funds.premium.total : null;
  const basicTotal = funds.complete ? funds.basic.total : null;
  const partialNote = '合计要取回全池才给数';

  const basicAsMoney = basicTotal === null ? null : basicTotal / QUOTA_PER_UNIT;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.space.sm, flexWrap: 'wrap' }}>
        <Text style={{ fontSize: 13, fontWeight: 600 }}>账号池三个资金池</Text>
        <Tooltip title="钱包是上游账号里的钱；高级额度是套餐里的钱；基础额度是套餐赠送的计数。三笔各自花各自的，网关选用 key 时看的也不是这三个数之和。">
          <Text type="secondary" style={{ fontSize: 11 }}>
            互不相通 · 不可相加
          </Text>
        </Tooltip>
        {!funds.complete ? (
          <Text style={{ fontSize: 11, color: tokens.color.warning }}>
            {`只取回 ${formatCount(funds.wallet.countedCount + funds.wallet.unknownCount)} / ${formatCount(funds.accountTotal)} 个账号`}
          </Text>
        ) : null}
      </div>

      <div style={{ display: 'flex', gap: tokens.space.md, flexWrap: 'wrap' }}>
        <PoolCard
          size="lg"
          label="钱包余额"
          unit="¥"
          value={<BalanceText value={walletTotal} strong />}
          caption={
            <>
              {`${formatCount(funds.wallet.countedCount)} 个账号余额已知 · 未知 ${formatCount(funds.wallet.unknownCount)} 个不计入`}
              {funds.wallet.exhaustedCount > 0 || funds.wallet.lowCount > 0 ? (
                <div style={{ color: tokens.color.warning }}>
                  {`已触顶 ${formatCount(funds.wallet.exhaustedCount)} 个 · 不足 ¥${(LOW_BALANCE_CENTS / 100).toFixed(2)} ${formatCount(funds.wallet.lowCount)} 个`}
                </div>
              ) : (
                <div>没有触顶或低余额的号</div>
              )}
            </>
          }
          hint="账号级钱包合计。与 key 级余额是两个口径：这一格的钱不是 key 的余额，两者不相加。"
          pending={walletTotal === null ? partialNote : undefined}
        />
        <PoolCard
          size="md"
          label="套餐高级额度"
          unit="¥"
          value={<BalanceText value={premiumTotal} strong />}
          caption={
            <>
              {`${formatCount(funds.premium.countedCount)} 条套餐计入合计 · ${formatCount(funds.premium.unknownCount)} 条缺额（未知，不计入）`}
              <div>套餐额度不是 key 余额，不进任何 key 合计，也不参与网关准入判断。</div>
            </>
          }
          hint="Σ(套餐 amount_total − amount_used)。任一端缺失即视为未知，不补 0。"
          pending={premiumTotal === null ? partialNote : undefined}
        />
        <PoolCard
          size="sm"
          label="基础额度"
          unit="计数"
          value={
            basicTotal === null ? (
              <Text type="secondary" italic style={{ fontSize: 17 }}>
                未知
              </Text>
            ) : (
              formatCount(basicTotal)
            )
          }
          caption={
            <>
              {`${formatCount(funds.basic.countedCount)} 条套餐计入 · ${formatCount(funds.basic.unknownCount)} 条缺额（未知，不计入）`}
              <div>
                {basicAsMoney === null
                  ? '上游给的 basic_token_* 原值计数；能否折元还没有实测结论。'
                  : `若按 1 元 = 500000 折则约 ${formatCents(Math.round(basicAsMoney * 100))} —— 这是**带前提的参考值**，不是结论。`}
              </div>
            </>
          }
          hint="套餐赠送的基础额度剩余，取上游原值计数。它与上面两个池不是一个单位：能不能折元要等一次已知流量的实测（看站点两个计数器的降幅）才能定。"
          pending={basicTotal === null ? partialNote : undefined}
        />
      </div>
    </div>
  );
}
