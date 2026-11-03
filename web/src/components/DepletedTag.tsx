/**
 * 透支锁存标签（契约 §20 / ADR-0041）。
 *
 * ## 为什么是**独立**一个标签，而不是 `HealthTag` 的第四档
 *
 * `health`（健康 / 冷却 / 已禁用）答的是**网关运行态**，`depleted` 答的是**资金事实**，
 * 两者正交：`health="healthy"` + `depleted=true` 是**完全合法的组合** —— 这把 key 没被停用、
 * 没在冷却，只是没钱了、网关不会选它（§20.1）。
 *
 * 但它**不是**与「健康」并排的第二等标签（v1.24.0 补记 / 业主原话「都透支了还健康呢」）：
 * `depleted=true` 的行里，**主 chip 只能是「透支」**，运行态细节（冷却 / 连续失败）降为
 * 次行灰字或 tooltip。所以调用方（KeysPage 健康格）在透支行只画这一个标签，
 * 不再并排一个绿色「健康」。
 *
 * 颜色 = **红**：业主 2026-11-03 口径（透支是"没钱付账、网关已排除它"，不是可忽略的提示）。
 * 早先这里用橙，理由是"红留给真出事"；业主看板后定红，账号池与账号详情共用本组件，口径统一。
 */
import { Tag, Tooltip } from 'antd';

import type { DepletedReason } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatIso, formatRelative } from '@/utils/format';

/**
 * `reason` 决定"是谁的钱包空了"，这是操作员下一步动作的分岔点：
 * 前者去充这把 key（或换一把），后者去充那个**账号**（充 key 没用）。
 *
 * v1.19.0 起 `'account'` 有**两种来源**（§21.3 把废号池的级联腿复用在这一格上）：
 * 账号透支级联、账号进废号池。这一格分不出是哪一种，所以文案把两条都写上去 ——
 * 只说「欠费」会让一个因套餐耗尽进池的账号被读成"充钱就好"。
 *
 * v1.21.0 把账号那一档的**判据**收窄了（ADR-0045）：不再是"余额见底一项"，而是
 * **余额见底且套餐也不可用**才连坐。文案必须按这句写 —— 写成"账号欠费"，业主就会
 * 以为给账号充点钱就该回池，而实际上一边有钱另一边没了照样会被锁（反过来说，
 * 他现在看到的"有套餐余额还是被锁"正是收窄前的旧判据留下的历史锁，靠「解除透支」清）。
 */
const REASON_HINT: Record<DepletedReason, string> = {
  balance: '余额 / 套餐余量已耗尽',
  account: '所属账号停了它（余额见底且套餐也不可用，或账号已进废号池）',
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
    // 「重新启用」是旧写法，而 `enable` **不清锁**（后端定死）—— 只留「不做会怎样」这一句。
    '网关已排除它出选路；只有人工「解除透支」才清，余额回升不会自动解锁',
  ];
  if (depletedAt) parts.push(`最早发现于 ${formatIso(depletedAt)}（${formatRelative(depletedAt)}）`);

  return (
    <Tooltip title={parts.join('；')}>
      <Tag
        bordered={false}
        style={{
          marginInlineEnd: 0,
          color: tokens.color.error,
          background: tokens.tint.error,
          whiteSpace: 'nowrap',
        }}
      >
        透支
      </Tag>
    </Tooltip>
  );
}
