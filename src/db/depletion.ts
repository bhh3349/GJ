// 透支锁存判据（契约 §20 / ADR-0041）。**本文件是阈值与判据的唯一实现。**
//
// 为什么单独一个文件而不是塞进 `repo/keys.ts`：判定腿有七个落库点（两处模板回写、手动录入余额、
// 手动改套餐余量、建 key 带金额、套餐余量回填、账号刷新级联），分布在两个 repo 与一个 service 里。
// 判据写七遍的失败形状不是"以后要改七处"，而是**七处会不一致**：一处用 `<= 0`、一处用 `< 10`、一处忘了 `unlimited`，
// 于是"为什么这把 key 被锁了而那把没有"变成一个只能读代码回答的问题。
// 契约 §20.2 的表格与本文件的常量**逐字相同**。
//
// 「未知 ≠ 0」在这条路上的落点（ADR-0003）：`NULL` 一律**不锁**。
// 查不到余额不等于没钱 —— 把未知当 0 会让一批还没查过余额的新 key 在第一次刷新前就被锁死。
// 「无限额度」同理：`unlimited = 1` 的 key 其 `balance_cents` 恒为 `NULL`（§15.7），
// 结构上就够不着这把锁，但代码里显式再判一次 —— 这条不变量由驱动器与落库纪律两处共同维持，
// 任何一处松了，沉默的后果是"一整批无限额度 key 集体锁存"。

// 账号级连坐要看套餐快照（v1.21.0 / ADR-0045）：类型取 `scrap.ts` 那一份，
// 保证「什么算套餐余量」只有一种算法（`currentPlanForScrap` 的判据与它同源）。
// 只 `import type`：单向类型依赖，运行时零引用（`scrap.ts` 不反向 import 本文件）。
import type { AccountPlanSnapshot } from './scrap.js';

/** 余额低于这个数（分）= 付不起账。10 分 = 0.1 元，含 0 与负数。契约 §20.2。 */
export const DEPLETED_BALANCE_THRESHOLD_CENTS = 10;

/** `upstream_keys.depleted_reason` / `supplier_accounts.depleted_reason` 的取值。契约 §20.2。 */
export type DepletedReason =
  /** 自己的余额（`balance` 类）或套餐余量（`token-plan` 类）耗尽 */
  | 'balance'
  /** 其所属账号欠费级联（§20.6） */
  | 'account';

/**
 * 余额类 key：**已知的**余额低于阈值 ⇒ 透支。
 *
 * `balanceCents === null` 是"未知"（还没查到），不是"没钱" —— 不锁。
 * `unlimited` 类不参与（它的 `balanceCents` 恒 `null`，这里显式拦一道）。
 */
export function isBalanceDepleted(input: {
  unlimited: boolean;
  balanceCents: number | null;
}): boolean {
  if (input.unlimited) return false;
  if (input.balanceCents === null) return false;
  return input.balanceCents < DEPLETED_BALANCE_THRESHOLD_CENTS;
}

/**
 * 套餐类 key：**已知的**套餐余量烧完（= 0）⇒ 透支。
 *
 * 只判 `=== 0`，不判 `<= 0`：负余量在落库前已被 `backfillSubscriptionTokenPlan` 夹到 0
 * （上游并发计费的瞬时态可能给出 `used > total`），所以库里不该出现负数；
 * 真出现了也按 0 处理更省事，但那是**写侧**的事，判据只认契约里写的那一个值。
 *
 * `null` = "上游没说用了多少"（不是 0）⇒ 不锁。这一条是 `backfillSubscriptionTokenPlan`
 * 那三条取值纪律的直接延续：把未知伪装成"确定的无"，比留一个 `NULL` 坏得多。
 *
 * **到期不进这里**：`token_plan_expires_at` 过期是"这份套餐不能用了"，不是"钱包空了"，
 * 由 `isUsable` 既有的时效判据管（§20.2）。
 */
export function isTokenPlanDepleted(input: { remainingTokens: number | null }): boolean {
  if (input.remainingTokens === null) return false;
  return input.remainingTokens === 0;
}

/**
 * 账号级连坐：**余额见底 且 套餐也不可用**（契约 §20.2 / §20.6；v1.21.0 收窄，ADR-0045）。
 *
 * **ADR-0041 的「只看余额」已被修订**（业主现场：余额 ¥0、套餐 ¥29.90 的账号被判透支，
 * 名下套餐 key 全被连坐锁死）。套餐 key 花的是**套餐额度**、不是账号余额 —— 余额见底不影响它出量，
 * 而连坐是粘性的（只能人工解除），误锁一批能用的 key 代价明显更大。
 *
 * 判据与 `scrap.ts` 的废号池同源（「且」不是「或」），但**阈值与后果都更轻**：
 * 这里 10 分（0.1 元）、只打 `depleted_at` 不动 `enabled`；那边 100 分（1 元）、还要停用 key。
 *
 * 「未知 ≠ 0」（ADR-0003）在三条路上都成立：
 * - `balanceCents === null` ⇒ 不连坐（`isBalanceDepleted` 已拦）；
 * - `plan === null`（台账没有套餐行）⇒ **不连坐**：判不出"套餐也见底"，
 *   而该账号的余额类 key 仍会被自己的判据逐把锁上，没有该停的 key 因此留在池里；
 * - `plan.remainingTokens === null` ⇒ 不连坐（上游没说用了多少）。
 *
 * 过期**把套餐余量按 0 计**（与 ADR-0043 同口径）：此时只看余额一项是否见底。
 */
export function isAccountDepleted(input: {
  unlimited: boolean;
  balanceCents: number | null;
  /** 该账号当前套餐快照（`repo/supplier-accounts.ts` 的 `currentPlanForScrap` 同口径）；`null` = 台账无套餐行 */
  plan: AccountPlanSnapshot | null;
  /** 判定时刻（epoch ms）；省略取 `Date.now()`。测试要能钉住"过期那一刻" */
  now?: number;
}): boolean {
  // ① 余额这一项：未知 / 无限 / 还有钱 ⇒ 不连坐（与余额类 key 同一口径）。
  if (!isBalanceDepleted(input)) return false;

  // ② 套餐这一项：没有台账行 ⇒ 判不出，不连坐。
  const plan = input.plan;
  if (plan === null) return false;

  // ③ 过期把余量按 0 计（业主口径，同 ADR-0043）。
  const now = input.now ?? Date.now();
  if (plan.expiresAt !== null) {
    const expiresAt = Date.parse(plan.expiresAt);
    // 解析不出来的到期时间当"没说"处理：不因为一个坏时间串把整批 key 锁掉。
    if (Number.isFinite(expiresAt) && expiresAt <= now) return true;
  }

  // ④ 未过期：余量未知不连坐；余量 < 1（token 是整数，即 0）⇒ 套餐也没了。
  if (plan.remainingTokens === null) return false;
  return plan.remainingTokens < 1;
}
