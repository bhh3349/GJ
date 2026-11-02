// 废号池判据（契约 §21 / ADR-0043）。**本文件是阈值与判据的唯一实现。**
//
// 为什么单独一个文件（同 `depletion.ts` 的理由）：判定腿有两个落库点（账号余额刷新、
// 套餐同步回填），分布在 service 层。判据写两遍的失败形状不是"以后要改两处"，
// 而是**两处会不一致** —— 一处用 `< 100`、一处用 `<= 100`、一处忘了"未知不等于 0"，
// 于是"为什么这个号进废池了那个没有"变成一个只能读代码回答的问题。
//
// ## 判据（业主原话 → 口径）
//
// 「优先判断套餐余额，如果套餐余额低于 1，余额低于 1 直接把该账号进入废号池」
// 「过期的账号余额低于 1，不管套餐是否还有余额该账号一律进入废号池」
//
// 落成两条：
//   1. **套餐余量 < 1 且 账号余额 < 1 元** ⇒ 废（两个资源都见底）
//   2. **套餐已过期**（`expires_at <= now`）⇒ 套餐余量按 **0** 计，此时只看余额：
//      余额 < 1 元 ⇒ 废，reason 记 `plan_expired`
//
// 为什么是「且」而不是「或」—— 这是本文件最要紧的一条，业主原话里第三句给了判据：
// 「过期的账号**不管套餐是否还有余额**……一律进废号池」。这句话只有在"套餐余量本来是
// 能救这个号的一项"的前提下才有额外含义：过期把它清零了，于是它救不了。如果判据是
// "任一耗尽即废"，那么过期那句完全多余（余额不足本来就已单独判废）。
// 反过来按"且"读，业务上也站得住：**一个套餐还剩 800 万 token、只是余额不足 1 元的号，
// 现在还能干活**，把它停掉等于白扔那 800 万。业主要停的是"什么都不剩"的号。
//
// ## 「未知 ≠ 0」（ADR-0003，全仓铁律）
//
// `balanceCents === null`（还没查到余额）⇒ **不废**。把未知当 0 会让一批还没查过余额的
// 新号在第一次刷新前就被打进废池，而废池是粘性的（只有人工能解除）。
// 同理 `remainingTokens === null`（上游没说用了多少）⇒ 不废；`plan === null`（台账里
// 没有套餐行）⇒ 不废 —— 没有套餐记录的号判不出"套餐耗尽"，宁可留在池子里。
//
// ## 到期不进 `depletion.ts`
//
// `depletion.ts` 的文件头明确写了"到期不进去"：过期是"这份套餐不能用了"，由 `isUsable`
// 的时效判据管。废号池这里不一样：**过期是判据的一部分**（它把套餐余量这一项清零），
// 所以它必须在这里。两个文件的边界是"钱包够不够付账" vs "这个号还有没有残值"。

/** 余额低于这个数（分）= 「钱见底」。**100 分 = 1 元**（业主原话「余额低于 1」）。 */
export const SCRAP_BALANCE_THRESHOLD_CENTS = 100;

/**
 * `supplier_accounts.scrap_reason` 的取值。
 *
 * 只有两个值，因为它们回答的是**套餐那一项怎么见底的**；余额那一项恒为「< 1 元」
 * （进废池的必要条件之一），不需要单独一个枚举去说。
 */
export type ScrapReason =
  /** 套餐未过期，但余量烧到 0（token 是整数，`< 1` 即 `0`） */
  | 'plan_exhausted'
  /** 套餐已过期：余量按 0 计（哪怕台账还剩几百万），余额也已不足 */
  | 'plan_expired';

/** 有效套餐余量：`basic_token_total - basic_token_used`，二者任一未知则为 `null`。 */
export interface AccountPlanSnapshot {
  /** 剩余 token 个数；`null` = 上游没说 / 台账没有这两列，不是 0 */
  remainingTokens: number | null;
  /** 套餐到期时刻（ISO8601 UTC）；`null` = 上游没给到期时间（长期/未知） */
  expiresAt: string | null;
}

export interface ScrapInput {
  /** 账号余额（分）；`null` = 未知 */
  balanceCents: number | null;
  /** 该账号**当前**套餐（同 `latestSubscriptionSubNo` 口径：最新到期的那一条）；`null` = 台账没有套餐行 */
  plan: AccountPlanSnapshot | null;
  /** 判定时刻（epoch ms）；省略取 `Date.now()`。测试要能钉住"过期那一刻" */
  now?: number;
}

export type ScrapDecision =
  | { scrap: false }
  | { scrap: true; reason: ScrapReason };

const NOT_SCRAP: ScrapDecision = { scrap: false };

/**
 * 判一个账号该不该进废号池。**纯函数**：不读库、不写库、不看时钟（除非调用方不给 `now`）。
 */
export function decideAccountScrap(input: ScrapInput): ScrapDecision {
  // ① 余额这一项：未知不废；≥ 阈值不废（还有钱，套餐耗不耗都还能干活）。
  if (input.balanceCents === null) return NOT_SCRAP;
  if (input.balanceCents >= SCRAP_BALANCE_THRESHOLD_CENTS) return NOT_SCRAP;

  // ② 套餐这一项：没有台账行 ⇒ 判不出耗尽，不废。
  const plan = input.plan;
  if (plan === null) return NOT_SCRAP;

  // ③ 过期把套餐余量清零（业主第三条）：此时不看还剩多少 token，只看余额已不足。
  const now = input.now ?? Date.now();
  if (plan.expiresAt !== null) {
    const expiresAt = Date.parse(plan.expiresAt);
    // 解析不出来的到期时间当"没说"处理：不因为一个坏时间串把号废掉。
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      return { scrap: true, reason: 'plan_expired' };
    }
  }

  // ④ 未过期：余量未知不废；余量 < 1（token 是整数，即 0）且余额已不足 ⇒ 废。
  if (plan.remainingTokens === null) return NOT_SCRAP;
  if (plan.remainingTokens < 1) return { scrap: true, reason: 'plan_exhausted' };

  return NOT_SCRAP;
}
