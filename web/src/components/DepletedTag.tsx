/**
 * 透支锁存标签（契约 §20 / ADR-0041）。
 *
 * ## 为什么是**独立**一个标签，而不是 `HealthTag` 的第四档
 *
 * `health`（健康 / 冷却 / 已禁用）答的是**网关运行态**，`depleted` 答的是**资金事实**，
 * 两者正交：`health="healthy"` + `depleted=true` 是**完全合法的组合** —— 这把 key 没被停用、
 * 没在冷却，只是没钱了、网关不会选它（§20.1）。
 *
 * 把它塞进 `HealthTag` 的 `HEALTH_META` 会造成**互斥的假象**：一把健康的透支 key
 * 只会画出「透支」，读的人于是以为它不健康 —— 而它健康得很，问题在钱包里。
 * 所以这里**必须**与 `HealthTag` 并排画（见 KeysPage 的健康态列），不得只画一个。
 *
 * 橙（`tokens.color.orange`）而不是红：红色留给"真出事"（登录失败 / 会话过期），
 * 透支是"已经耗尽、不是故障" —— 与 `color` 表里 `orange` 那段注释同一口径。
 */
import { Tag, Tooltip } from 'antd';

import type { DepletedReason } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatIso, formatRelative } from '@/utils/format';

/**
 * `reason` 决定"是谁的钱包空了"，这是操作员下一步动作的分岔点：
 * 前者去充这把 key（或换一把），后者去充那个**账号**（充 key 没用）。
 */
const REASON_HINT: Record<DepletedReason, string> = {
  balance: '它自己的余额 / 套餐余量已耗尽',
  account: '它所属的账号欠费（账号级联标记）',
};

export interface DepletedTagProps {
  depleted: boolean;
  depletedAt?: string | null | undefined;
  depletedReason?: DepletedReason | null | undefined;
}

/** `depleted=false` 时**什么都不画**（没有"未透支"这种标签，那是噪声）。 */
export function DepletedTag({ depleted, depletedAt = null, depletedReason = null }: DepletedTagProps) {
  if (!depleted) return null;

  const reason = depletedReason ? REASON_HINT[depletedReason] : '原因未记录';
  const parts = [
    `透支锁存：${reason}`,
    '网关已把它排除出选路。只有人工「重新启用」才解除 —— 余额回升**不会**自动解锁。',
  ];
  if (depletedAt) parts.push(`最早发现于 ${formatIso(depletedAt)}（${formatRelative(depletedAt)}）`);

  return (
    <Tooltip title={parts.join('；')}>
      <Tag
        bordered={false}
        style={{
          marginInlineEnd: 0,
          color: tokens.color.orange,
          background: tokens.tint.orange,
          whiteSpace: 'nowrap',
        }}
      >
        透支
      </Tag>
    </Tooltip>
  );
}
