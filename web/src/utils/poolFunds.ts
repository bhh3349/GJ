/**
 * 账号池三个**资金池**的汇总口径（唯一实现，渲染层不重复算）。
 *
 * 三个池子来自三个不同的地方，**互不相通、不可相加**：
 *
 * 1. **钱包余额**（¥）= 各账号 `balanceCents` 之和（账号级，上游的钱包）。
 * 2. **套餐高级额度**（¥）= 各账号名下套餐 `amount_total - amount_used` 之和。
 * 3. **基础额度**（Token）= 各账号名下套餐 `basic_token_total - basic_token_used` 之和。
 *    上游给的是 `basic_token_*`，**单位是 Token**（Bo 2026-10-12 定死：套餐赠送的剩余
 *    Token，调用基础模型时扣减，1M = 100 万 Token）。它**不是钱、不折元** —— 站内曾按
 *    「1 元 = 500000 quota」折元渲染，那是错误推断，已整块撤掉。
 *    所以三个池子是**两个量纲**（¥ / Token），这一点比"哪个数大"更重要。
 *
 * 三条纪律：
 * - **未知不进合计**：`balanceCents === null` 的账号不计入钱包合计，单独计数说出去（§0.2）。
 * - **套餐与基础额度**任一端缺失即视为未知；一个套餐缺数**不会**让整池合计变 0，
 *   而是计入 `missing` 数并如实说明「n 条套餐缺额（未知，不计入）」。
 * - **只有取回全池才汇总**：账号数超过单页上限时，页内累加得到的是"第 1 页的合计"，
 *   那比"没有合计"更坏 —— 所以 `complete=false` 时**不给数**（钱包那一格改吃服务端的
 *   `accountsBalance`，它是全池口径）。
 */
import type { SupplierAccount, SupplierSubscription, Upstream } from '@/api/types';
import { formatCents } from '@/utils/format';
import { LOW_BALANCE_CENTS } from '@/utils/supplierHealth';

export interface PoolTotals {
  /** 合计（钱包与高级额度是分，基础额度是 Token 个数）。一员都未知时为 0，但**读的人看 `unknownCount`**。 */
  total: number;
  /** 计入合计的条目数（账号数 / 套餐条数）。 */
  countedCount: number;
  /** 因未知而**没有**计入的条目数。 */
  unknownCount: number;
}

export interface PoolFunds {
  /** 是否取回了全池（false 时三个池子都不给页内合计）。 */
  complete: boolean;
  wallet: PoolTotals & {
    /** 余额已知的账号里低于阈值的个数。 */
    lowCount: number;
    /** 余额已知且 < 0 的账号个数（上游侧触到额度上限）。 */
    exhaustedCount: number;
  };
  premium: PoolTotals;
  basic: PoolTotals;
  /** 池内账号总数（服务端给的全池口径，不受分页影响）。 */
  accountTotal: number;
  /** 池内套餐总条数。 */
  subscriptionCount: number;
}

/**
 * 单条套餐的剩余（分）：`amount_total - amount_used`，两端任缺即 `null`（未知），**不是 0**。
 * §15.8 第 6 问的口径；表格列、账号行内合计、资金池卡三处同源，都吃这一个函数。
 */
export function subscriptionRemainingCents(row: SupplierSubscription): number | null {
  const total = row.amountTotalCents;
  const used = row.amountUsedCents;
  return total === null || used === null ? null : total - used;
}

/**
 * 一个账号名下**全部套餐的剩余合计**（分），给账号池那一列与详情抽屉用。
 *
 * 三条口径（调用方靠这三种返回值分别渲染「—」/「未知」/金额）：
 * - `count === 0`（名下没有套餐）→ `null`，调用方按「—」渲染，**不得**渲染成 ¥0.00（那是"有额度且为 0"）。
 * - 有套餐但**一条都算不出**（两端全缺）→ `countedCount === 0` 的对象（不是 `null`！），调用方按「未知」渲染。
 * - 部分算得出 → 只合计算得出的那些，并把算不出的条数放进 `unknownCount` 说出去。
 */
export function accountSubscriptionRemaining(row: SupplierAccount): PoolTotals | null {
  const sums = sumKnown(row.subscriptions.map(subscriptionRemainingCents));
  if (row.subscriptions.length === 0) return null;
  return sums;
}

/**
 * 账号行 / 展开行 / 抽屉副行那句「· 剩余 ¥X」的尾巴。三处共用一个判据与措辞，不许漂移：
 * 没有套餐 → 空字符串（调用方只渲染套餐数即可）；有套餐但全算不出 → `· 剩余未知`；
 * 否则 → `· 剩余 ¥X`。
 */
export function subscriptionRemainingTail(row: SupplierAccount): string {
  const sums = accountSubscriptionRemaining(row);
  if (sums === null) return '';
  if (sums.countedCount === 0) return ' · 剩余未知';
  return ` · 剩余 ${formatCents(sums.total)}`;
}

/** 套餐基础额度剩余（上游原值 = Token 个数，不是钱）：同上，任缺即 null。 */
function basicRemaining(row: SupplierSubscription): number | null {
  const total = row.basicTokenTotal;
  const used = row.basicTokenUsed;
  return total === null || used === null ? null : total - used;
}

function sumKnown(values: (number | null)[]): PoolTotals {
  let total = 0;
  let countedCount = 0;
  let unknownCount = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) {
      unknownCount += 1;
    } else {
      total += value;
      countedCount += 1;
    }
  }
  return { total, countedCount, unknownCount };
}

export interface ComputePoolFundsInput {
  items: SupplierAccount[];
  total: number;
  pageSize: number;
}

/** 三个池子的页内汇总。`complete=false` 时调用方**不得**拿这里的数当池级数。 */
export function computePoolFunds({ items, total, pageSize }: ComputePoolFundsInput): PoolFunds {
  const wallet = sumKnown(items.map((row) => row.balanceCents));
  let lowCount = 0;
  let exhaustedCount = 0;
  for (const row of items) {
    const balance = row.balanceCents;
    if (balance === null || !Number.isFinite(balance)) continue;
    if (balance < 0) exhaustedCount += 1;
    else if (balance < LOW_BALANCE_CENTS) lowCount += 1;
  }

  const subscriptions: SupplierSubscription[] = [];
  for (const row of items) subscriptions.push(...row.subscriptions);

  return {
    complete: items.length >= total && items.length <= pageSize,
    wallet: { ...wallet, lowCount, exhaustedCount },
    premium: sumKnown(subscriptions.map(subscriptionRemainingCents)),
    basic: sumKnown(subscriptions.map(basicRemaining)),
    accountTotal: total,
    subscriptionCount: subscriptions.length,
  };
}

/**
 * 钱包那一格的**池级**合计：优先吃服务端 `accountsBalance`（全池口径、与页内无关），
 * 没有才退回页内累加。`null` 是"账号级合计未知"，不是 0。
 */
export function poolWalletTotal(funds: PoolFunds, upstream: Upstream | null): number | null {
  return upstream?.accountsBalance ?? (funds.complete ? funds.wallet.total : null);
}
