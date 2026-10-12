/**
 * 账号池「舰队点阵」（Bo 2026-10-12 参考工作台后提的改进 ⑦）。
 *
 * 表格回答「这一个号怎么样」，但要回答「**这一池号现在整体是什么样子**」，
 * 读的人得把 31 行逐行扫完再心算一遍。点阵把每个号压成一个点、按同一套健康色上色，
 * 一眼能看出：好的占多少、问题挤在哪一头、有没有一片同时变橙。
 *
 * 六条纪律：
 * - **判据不新造**：颜色来自 `utils/supplierHealth.ts` 的 `accountHealthOf`，
 *   与表里那一列「健康」是同一个函数、同一套 tone —— 同一件事在两处不会一个红一个黄。
 * - **点不替代行**：这块只负责"看见 + 定位"，点一个点打开那个号的详情浮层；
 *   要看数、要动手，仍旧回表格与抽屉，不在点上叠第二套动线。
 * - **未知不是正常**：`未查询过` / `余额未知` 用中性灰，绝不染成绿 ——
 *   把"不知道"画成"没事"是这一块最容易犯的错，而且错得很漂亮。
 * - **三种"没有点"是三句话**：还没取到 → "正在取…"；取回失败 → 明说取不回来；
 *   取回 0 个号 → "还没有账号"。把前两种画成一片空的绿点，或把"取不到"说成"都没事"，
 *   都是拿缺省当证据。
 * - **没取全时写明覆盖范围**：池子比一页上限大时点数只覆盖取回的部分，必须说，否则是个假数。
 * - **排序稳定可复现**：按严重度成序（连接问题在前、正常在后），同档内按掩码定序 ——
 *   刷新不会让点乱跳，问题那一片永远在最左边，颜色一致时还能靠位置认出同一个号。
 */
import { Tooltip, Typography } from 'antd';

import type { SupplierAccount } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCount } from '@/utils/format';
import {
  HEALTH_SEVERITY_ORDER,
  accountHealthOf,
  healthTint,
  type HealthKey,
  type HealthTone,
} from '@/utils/supplierHealth';

const { Text } = Typography;

/** 严重度 → 序号。与 `accountHealthOf` 的判定链同一序，所以这块不会再有一套"谁更急"。 */
const RANK = new Map<HealthKey, number>(HEALTH_SEVERITY_ORDER.map((key, index) => [key, index]));

/** 排序用的稳定键：先严重度，再掩码，最后 id —— 同分不随刷新换位置。 */
function compareForMatrix(a: SupplierAccount, b: SupplierAccount): number {
  const rank = (RANK.get(accountHealthOf(a).key) ?? 99) - (RANK.get(accountHealthOf(b).key) ?? 99);
  if (rank !== 0) return rank;
  const byIdentifier = (a.identifier ?? '').localeCompare(b.identifier ?? '');
  return byIdentifier !== 0 ? byIdentifier : a.id.localeCompare(b.id);
}

/** 点阵里一个点。尺寸固定 11px：31 个点要能一眼数出疏密，再大就糊成一片色块。 */
function Dot({
  account,
  active,
  onSelect,
}: {
  account: SupplierAccount;
  active: boolean;
  onSelect: (accountId: string) => void;
}) {
  const health = accountHealthOf(account);
  const tint = healthTint(health.tone);
  const balanceLine =
    account.balanceCents === null
      ? '余额未知（不计入任何合计）'
      : `余额 ${formatCents(account.balanceCents)}`;
  return (
    <Tooltip
      title={
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>{account.identifier}</Text>
          <Text style={{ fontSize: 11, color: tint.color }}>{health.label}</Text>
          <Text style={{ fontSize: 11 }}>{balanceLine}</Text>
          <Text style={{ fontSize: 11, opacity: 0.75 }}>{health.hint}</Text>
        </div>
      }
    >
      <button
        type="button"
        aria-label={`账号 ${account.identifier} · ${health.label}`}
        onClick={() => {
          onSelect(account.id);
        }}
        style={{
          width: 11,
          height: 11,
          padding: 0,
          border: active ? `2px solid ${tokens.color.primary}` : '2px solid transparent',
          borderRadius: '50%',
          background: tint.color,
          boxShadow: active ? `0 0 0 2px ${tokens.color.bgContainer}` : `0 0 0 2px ${tint.background}`,
          cursor: 'pointer',
          transition: `transform ${tokens.motion.fast} ${tokens.motion.easing}`,
        }}
      />
    </Tooltip>
  );
}

export interface SupplierFleetMatrixProps {
  /** 整池快照（与资金池卡、需要处理清单同一份数据，不另发请求）。`null` = 手里还没有数据。 */
  accounts: SupplierAccount[] | null;
  /** 池内账号总数（服务端全池口径，用来判断快照是否取全）。 */
  accountTotal: number;
  /** 当前打开详情浮层的账号 id（给它一圈蓝环，让人知道点的是哪一个）。 */
  activeAccountId: string | null;
  /** 整池快照**取回失败**且手里没有旧数据。它与「还没到」是两件事：一个是不知道，一个是知道取不到。 */
  failed: boolean;
  onSelect: (accountId: string) => void;
}

/** 图例只列**点阵里真实存在**的档，与「需要处理」清单同一姿态：待办/图例不摆空项。 */
function legendOf(ordered: readonly SupplierAccount[]): { key: HealthKey; label: string; tone: HealthTone; count: number }[] {
  const counts = new Map<HealthKey, { label: string; tone: HealthTone; count: number }>();
  for (const account of ordered) {
    const health = accountHealthOf(account);
    const prev = counts.get(health.key);
    if (prev) prev.count += 1;
    else counts.set(health.key, { label: health.label, tone: health.tone, count: 1 });
  }
  return HEALTH_SEVERITY_ORDER.flatMap((key) => {
    const item = counts.get(key);
    return item ? [{ key, ...item }] : [];
  });
}

export function SupplierFleetMatrix({
  accounts,
  accountTotal,
  activeAccountId,
  failed,
  onSelect,
}: SupplierFleetMatrixProps) {
  const ordered = accounts ? [...accounts].sort(compareForMatrix) : null;
  const covered = ordered?.length ?? 0;
  const partial = ordered !== null && covered < accountTotal;

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
        <Text style={{ fontSize: 13, fontWeight: 600 }}>舰队点阵</Text>
        {ordered === null ? (
          <Text type={failed ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
            {failed ? '整池账号没取回来，所以这里画不出点阵' : '正在取整池账号…'}
          </Text>
        ) : ordered.length === 0 ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            这个上游还没有账号 —— 用下面「导入账号」开始
          </Text>
        ) : (
          <Tooltip title="每个点是一个账号，颜色就是下面那一列「健康」（同一个说法）。点一个点，打开那个账号的详情。">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {`${formatCount(ordered.length)} 个号 · 一个点一个号 · 问题档排左边，点它看详情`}
            </Text>
          </Tooltip>
        )}
        {partial ? (
          <Tooltip title="这一块按取回的账号画。池子比一页上限还大时，点阵只覆盖取回的部分，不是全池。">
            <Text style={{ fontSize: 11, color: tokens.color.warning }}>
              {`只覆盖取回的 ${formatCount(covered)} / ${formatCount(accountTotal)} 个账号`}
            </Text>
          </Tooltip>
        ) : null}
      </div>

      {ordered && ordered.length > 0 ? (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
            {ordered.map((account) => (
              <Dot
                key={account.id}
                account={account}
                active={account.id === activeAccountId}
                onSelect={onSelect}
              />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.sm }}>
            {legendOf(ordered).map((item) => {
              const tint = healthTint(item.tone);
              return (
                <span
                  key={item.key}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 11,
                    color: tokens.color.textSecondary,
                  }}
                >
                  <span
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: '50%',
                      background: tint.color,
                      flexShrink: 0,
                    }}
                  />
                  {`${item.label} ${formatCount(item.count)}`}
                </span>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
