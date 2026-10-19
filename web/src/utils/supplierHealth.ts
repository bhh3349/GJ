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

/**
 * 健康档的严重度顺序 = 判定链顺序（连接 → 钱 → 正常）。
 * 舰队点阵的排序与「需要处理」清单的顺序都从这一个序读 —— 同一个"谁更急"，不许两套。
 */
export const HEALTH_SEVERITY_ORDER: readonly HealthKey[] = [
  'login-failed',
  'session-expired',
  'never-checked',
  'exhausted',
  'low',
  'balance-unknown',
  'ok',
];

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

// ── 到期与筛选：与上面那一档是**两个维度**，别混 ────────────────────────────────
//
// `accountHealthOf` 回答「这个号现在什么状态」（一档），而「即将到期」是**时间维度**：
// 一个余额充足的号也可能 3 天后套餐到期。两者都进「需要处理」清单，但判据各算各的 ——
// 把到期塞进健康档会让「正常」这个标签自相矛盾。

/** 相对今天还剩几天（负数 = 到期时刻已过）。时间串缺失或非法时为 `null`，**不猜 0**。 */
export function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  return Math.floor((ts - Date.now()) / 86_400_000);
}

/**
 * 这个账号名下「即将到期（含已过期）」的套餐条数。
 * 上游没给到期时间的套餐**不进这个计数** —— 没有时刻就没法说它快到期，
 * 硬算会把「不知道」说成「还有 14 天」。
 */
export function expiringCount(account: SupplierAccount, withinDays = EXPIRING_WITHIN_DAYS): number {
  let count = 0;
  for (const row of account.subscriptions) {
    const days = daysUntil(row.endAt);
    if (days !== null && days <= withinDays) count += 1;
  }
  return count;
}

/** 清单里的一个筛选项：判据 + 人话 + 现在命中几个。 */
export interface PoolFilter {
  key: PoolFilterKey;
  label: string;
  count: number;
  /** 这条为什么进清单（进悬浮说明）。 */
  hint: string;
  /** 严重度配色。与 `accountHealthOf` 同一套 tone，同一件事在两处不会一个红一个黄。 */
  tone: HealthTone;
}

/**
 * 「需要处理」的筛选项。**判定链之外的维度也在里面**（无会话 / 即将到期），
 * 所以这里的 key 面比 `HealthKey` 宽 —— 它们是两种不同的问法。
 */
export type PoolFilterKey =
  | 'login-failed'
  | 'session-expired'
  | 'never-checked'
  | 'balance-unknown'
  | 'depleted'
  | 'exhausted'
  | 'low'
  | 'no-session'
  | 'expiring';

/** 一个账号是否命中某个筛选项。**唯一实现**：清单计数与表格筛选共用它，不会一个说 3 一个显示 2。 */
export function matchesPoolFilter(account: SupplierAccount, key: PoolFilterKey): boolean {
  switch (key) {
    case 'login-failed':
      return account.status === 'login_failed';
    case 'session-expired':
      return account.status === 'session_expired';
    case 'never-checked':
      return account.status === 'unknown';
    case 'no-session':
      return !account.hasSession;
    case 'exhausted':
      return account.balanceCents !== null && account.balanceCents < 0;
    case 'low': {
      const balance = account.balanceCents;
      return balance !== null && balance >= 0 && balance < LOW_BALANCE_CENTS;
    }
    case 'balance-unknown':
      return account.status !== 'unknown' && account.balanceCents === null;
    /**
     * 透支锁存（§20.6）。注意它**不是**上面 `exhausted` / `low` 两档的重述：
     * - 这一条是**库里的持久标记**（`depleted`），只有人工解除；
     * - `exhausted` / `low` 是**此刻按余额现算**的一档，余额回升当场变色。
     * 一把刚充完钱的账号可以同时是 `depleted=true`（还锁着，名下的 key 仍在池外）
     * 与「正常」（余额已回到阈值之上）—— 合并成一个判据就会把这个"钱到了但还没解"的状态藏掉。
     */
    case 'depleted':
      return account.depleted;
    case 'expiring':
      return expiringCount(account) > 0;
  }
}

/** 清单顺序 = 严重度顺序（连接 → 钱 → 时间），**不是**先来后到。 */
const FILTER_ORDER: readonly PoolFilterKey[] = [
  'login-failed',
  'session-expired',
  'no-session',
  'never-checked',
  'depleted',
  'exhausted',
  'low',
  'balance-unknown',
  'expiring',
];

const FILTER_LABEL: Record<PoolFilterKey, string> = {
  'login-failed': '登录失败',
  'session-expired': '会话过期',
  'no-session': '无会话',
  'never-checked': '未查询过',
  depleted: '透支锁存',
  exhausted: '额度耗尽',
  low: '余额偏低',
  'balance-unknown': '余额未知',
  expiring: `即将到期（${EXPIRING_WITHIN_DAYS} 天内）`,
};

const FILTER_TONE: Record<PoolFilterKey, HealthTone> = {
  'login-failed': 'error',
  'session-expired': 'error',
  'no-session': 'muted',
  'never-checked': 'muted',
  depleted: 'orange',
  exhausted: 'orange',
  low: 'warning',
  'balance-unknown': 'muted',
  expiring: 'warning',
};

const FILTER_HINT: Record<PoolFilterKey, string> = {
  'login-failed': '这一轮登录上游没成功。名下的 key 还在跑，但这个号的余额与套餐刷不新。',
  'session-expired': '存档会话过期了。有存档密码的号点「重新登录」就能自动换一本；没有的只能人工重导凭据。',
  'no-session': '没有可用会话。所有要打上游的动作都得先登录一次，慢且多一次锁号风险。',
  'never-checked': '从没成功查过。「未查询过」不是「正常」，两者在数据上是两件事。',
  // 依据在契约 §20.6 / ADR-0041；文案本身不带术语（见 `src/security/web-layout-parity.spec.ts` 的锁）。
  depleted:
    '这个账号的余额低于 ¥0.10，已被锁存 —— 它名下所有已入池的 key 也一并被锁在池外。余额回升**不会**自动解除，要用「解除透支」。',
  exhausted: '上游侧触到额度上限（实测超出只有几毛，是封顶特征不是欠费）。名下的 key 会开始拿不到流量。',
  low: `余额不足 ¥${(LOW_BALANCE_CENTS / 100).toFixed(2)}，还能用一阵，但离停止供应不远了。`,
  'balance-unknown': '能登录，但这次没拿到余额。未知不计入任何合计，也不参与低余额提示。',
  expiring: `名下套餐在 ${EXPIRING_WITHIN_DAYS} 天内到期（含已过期）—— 到期即为事实，与余额多少无关。`,
};

/**
 * 由池内账号算出「需要处理」清单。`count === 0` 的项**不返回** ——
 * 清单是待办列表，不是图例；摆一排 0 会让人以为那些格子坏了。
 */
export function buildPoolFilters(accounts: readonly SupplierAccount[]): PoolFilter[] {
  return FILTER_ORDER.map((key) => ({
    key,
    label: FILTER_LABEL[key],
    hint: FILTER_HINT[key],
    tone: FILTER_TONE[key],
    count: accounts.filter((account) => matchesPoolFilter(account, key)).length,
  })).filter((item) => item.count > 0);
}
