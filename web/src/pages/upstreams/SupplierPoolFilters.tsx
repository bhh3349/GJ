/**
 * 账号池的「需要处理」清单（Bo 2026-10-12 参考工作台后提的改进 ②）。
 *
 * 它**同时是告警与筛选器**：每一条既是"现在有几件要处理"，点了就直接把账号表筛成那几条。
 * 这样"看到问题"与"去处理它"之间没有一步"那我去哪儿筛"。
 *
 * 四条纪律：
 * - **计数与筛选共用一个判据**（`utils/supplierHealth.ts` 的 `matchesPoolFilter`），
 *   不会出现"清单说 3 个、点进去 2 行"。
 * - **0 的项不渲染**：这是待办列表不是图例，摆一排 0 会让人以为那些格子坏了。
 * - **没有待办时明确说"没有"**，而不是整块消失 —— 消失了读的人分不清"都没事"与"这块还没做"。
 *   而整池快照**还没到**时说的是另一句话（「正在取…」）：拿空数组当"都没事"就是把缺省当证据。
 * - 全池没取全时**标题里写明覆盖范围**：筛出来的"3 个"如果只覆盖了取回的那部分，
 *   必须说，否则那是个假数。
 */
import { Tooltip, Typography } from 'antd';

import { tokens } from '@/theme/tokens';
import { formatCount } from '@/utils/format';
import { healthTint, type PoolFilter, type PoolFilterKey } from '@/utils/supplierHealth';

const { Text } = Typography;

export interface SupplierPoolFiltersProps {
  filters: PoolFilter[];
  /** 当前生效的筛选（`null` = 没筛）。 */
  active: PoolFilterKey | null;
  onToggle: (key: PoolFilterKey) => void;
  /** 覆盖了多少个账号 / 池内共多少个（取不全时提示用）。 */
  coveredCount: number;
  accountTotal: number;
  /** 整池快照还没到：这时候**不能说"没有需要处理的账号"**（缺省不是证据）。 */
  ready: boolean;
}

export function SupplierPoolFilters({
  filters,
  active,
  onToggle,
  coveredCount,
  accountTotal,
  ready,
}: SupplierPoolFiltersProps) {
  const partial = coveredCount < accountTotal;
  const total = filters.reduce((sum, item) => sum + item.count, 0);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.space.sm,
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: `${tokens.space.sm}px ${tokens.space.md}px`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.space.sm, flexWrap: 'wrap' }}>
        <Text style={{ fontSize: 13, fontWeight: 600 }}>需要处理</Text>
        {!ready ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            正在取整池账号…
          </Text>
        ) : filters.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            没有需要处理的账号
          </Text>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {`${formatCount(total)} 件 · 点一条就把下面的账号表筛成那几条`}
          </Text>
        )}
        {partial ? (
          <Tooltip title="这一块按取回的账号算。池子比一页上限还大时，计数只覆盖取回的部分，不是全池。">
            <Text style={{ fontSize: 11, color: tokens.color.warning }}>
              {`只覆盖取回的 ${formatCount(coveredCount)} / ${formatCount(accountTotal)} 个账号`}
            </Text>
          </Tooltip>
        ) : null}
        {active !== null ? (
          <Text
            role="button"
            tabIndex={0}
            onClick={() => {
              onToggle(active);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onToggle(active);
            }}
            style={{
              fontSize: 11,
              color: tokens.color.primary,
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            清掉筛选
          </Text>
        ) : null}
      </div>

      {filters.length > 0 ? (
        <div style={{ display: 'flex', gap: tokens.space.sm, flexWrap: 'wrap' }}>
          {filters.map((item) => {
            const tint = healthTint(item.tone);
            const on = active === item.key;
            return (
              <Tooltip key={item.key} title={item.hint}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    onToggle(item.key);
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '3px 10px',
                    borderRadius: 999,
                    border: `1px solid ${on ? tint.color : tokens.color.border}`,
                    background: on ? tint.background : tokens.color.bgBase,
                    color: tint.color,
                    fontSize: 12,
                    fontFamily: tokens.font.sans,
                    cursor: 'pointer',
                    transition: `all ${tokens.motion.fast} ${tokens.motion.easing}`,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: tint.color,
                      flexShrink: 0,
                    }}
                  />
                  <span>{item.label}</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {formatCount(item.count)}
                  </span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
