/**
 * 账号池「一个号要不要处理」的唯一实现。
 *
 * 三处消费同一个函数，避免同一组阈值在两页各写一套：
 * - 账号池列表「状态」列的分层（active 也再分一档）；
 * - 账号池顶部「需要处理」清单与它带的筛选（本文件后续补到期相关判据）；
 * - 资金池卡副行的计数。
 *
 * 三条纪律：
 * 1. **阈值只在本文定义**（`¥0.50`、`14 天` 是我们这边的产品约定，不是上游给的），改一处即全站生效。
 * 2. **上游没给余额 = 未知，不是 0，也不等于「快用完了」** —— 未知单独一档、中性色，
 *    绝不参与低余额提示：否则一个查失败的号会让人以为它没钱了。
 * 3. **额度封顶用橙不用红**。实测上游的"透支"只是超出 ¥0.01–0.16 的封顶特征，不是欠费；
 *    红色留给「登录失败 / 会话过期」这种真出事的两档。
 */
import type { SupplierAccount } from '@/api/types';
import { tokens } from '@/theme/tokens';

/** 余额低于此值（分）算「余额偏低」。¥0.50。 */
export const LOW_BALANCE_CENTS = 50;

/** 到期时刻落在此天数内算「即将到期」。 */
export const EXPIRING_WITHIN_DAYS = 14;

export type HealthTone = 'success' | 'warning' | 'orange' | 'error' | 'muted';

/**
 * 一档账号健康态。
 * `key` 是稳定标识，给筛选与计数当键；`label` / `hint` 才是给人看的，两者不参与任何判断。
 */
export type HealthKey =
  | 'login-failed'
  | 'session-expired'
  | 'never-checked'
  | 'exhausted'
  | 'low'
  | 'balance-unknown'
  | 'ok';

export interface AccountHealth {
  key: HealthKey;
  label: string;
  tone: HealthTone;
  /** 为什么落到这一档（一句话，进 tooltip）。 */
  hint: string;
}

/** 一档颜色（唯一出口，组件里不再各写各的 tint/color 配对）。 */
export function healthTint(tone: HealthTone): { color: string; background: string } {
  switch (tone) {
    case 'success':
      return { color: tokens.color.success, background: tokens.tint.success };
    case 'warning':
      return { color: tokens.color.warning, background: tokens.tint.warning };
    case 'orange':
      return { color: tokens.color.orange, background: tokens.tint.orange };
    case 'error':
      return { color: tokens.color.error, background: tokens.tint.error };
    case 'muted':
      return { color: tokens.color.textSecondary, background: tokens.tint.neutral };
  }
}

/**
 * 判定链，**自上而下第一个命中即停**：
 * 登录/会话/未查询（上游侧连接事实）优先于余额（钱的多少），因为连不上时余额那个数本身就不可信。
 */
export function accountHealthOf(account: SupplierAccount): AccountHealth {
  if (account.status === 'login_failed') {
    return {
      key: 'login-failed',
      label: '登录失败',
      tone: 'error',
      hint: '这一轮没能登录上游。名下 key 仍在，但账号级的余额与套餐刷不新。',
    };
  }
  if (account.status === 'session_expired') {
    return {
      key: 'session-expired',
      label: '会话过期',
      tone: 'error',
      hint: '存档会话已过期。有存档密码的号可以点「重新登录」自动换一本。',
    };
  }
  if (account.status === 'unknown') {
    return {
      key: 'never-checked',
      label: '未查询过',
      tone: 'muted',
      hint: '从没成功查过这个号。「未查询过」不是「正常」，两者在数据上是两件事。',
    };
  }
  const balance = account.balanceCents;
  if (balance === null) {
    return {
      key: 'balance-unknown',
      label: '余额未知',
      tone: 'muted',
      hint: '账号能登录，但这次没拿到余额。未知不计入任何合计，也不参与低余额提示。',
    };
  }
  if (balance < 0) {
    return {
      key: 'exhausted',
      label: '额度耗尽',
      tone: 'orange',
      hint: '上游侧已触到额度上限。实测超出只有几毛，是封顶特征，不是欠费 —— 名下 key 会开始拿不到流量。',
    };
  }
  if (balance < LOW_BALANCE_CENTS) {
    return {
      key: 'low',
      label: '余额偏低',
      tone: 'warning',
      hint: `余额不足 ¥${(LOW_BALANCE_CENTS / 100).toFixed(2)}，还能用一阵，但离停止供应不远了。`,
    };
  }
  return {
    key: 'ok',
    label: '正常',
    tone: 'success',
    hint: '能登录，余额也在阈值之上。',
  };
}
