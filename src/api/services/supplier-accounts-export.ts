// 供应商账号对账表导出（契约 §15.2 `GET /api/supplier-accounts/export`）。
//
// 这一格是**给人用 Excel 打开的**，而 Excel 会把单元格内容当公式执行 —— 于是"导出"
// 这个纯读动作变成了一条**代码执行路径**。表里的 `identifier` / `uid` / `statusMessage`
// 全是**供应商侧**的数据（不是我们自己写的），所以这个面必须自己防，不能指望上游不塞 `=`。
// 同一条纪律的另一面：本文件**永不输出凭据** —— 入参是 `SupplierAccountDto`，而那个形状里
// 根本没有密码/会话字段（§15.0），所以"导出的表里不会夹带凭据"是结构事实，不是本文件的承诺。

import type { SupplierAccountDto, SupplierSubscriptionDto } from '../dto.js';

/**
 * 表头即列序，两者**同源**。
 *
 * 分成两个数组写，迟早在加列时只改一处：错位在 CSV 里**不报错**，只是"列名对不上数据"，
 * 而读到那份表的人只会以为我们的余额算错了。
 */
export const SUPPLIER_ACCOUNT_CSV_HEADERS = [
  'upstreamId',
  'identifier',
  'uid',
  'status',
  'statusMessage',
  'balanceCents',
  'balanceUpdatedAt',
  'keyCount',
  'unlimitedKeyCount',
  'maskedKeyCount',
  'subscriptionCount',
  'subscriptionEndAt',
  'createdAt',
  'updatedAt',
] as const;

/** RFC 4180 用 CRLF。Excel 对 LF 也能读，但 CRLF 是两个客户端都无歧义的那个。 */
const EOL = '\r\n';

/**
 * Excel 在 Windows 上默认按本地代码页（简体中文 = GBK）解 CSV，没有 BOM 就是一片乱码 ——
 * 而"导出打开是乱码"会被当成数据损坏，去查一遍后端。BOM 放在**路由**里拼，
 * 让本文件的返回值保持"就是表本身"（测试断言不必带上一个看不见的字符）。
 */
export const CSV_BOM = '﻿';

/**
 * 文本单元格：公式注入防护 + RFC 4180 必要引号。
 *
 * 公式注入（formula injection）：以 `=` `+` `-` `@` 开头（以及制表符 / 回车开头）的
 * 单元格会被 Excel / Numbers / Sheets 当**公式**求值，`=HYPERLINK(...)` 一类足以在
 * 打开对账表的人的机器上拉外链或触发 DDE。前缀一个单引号是各家都认的"这是文本"标记。
 */
export function csvText(value: string | null): string {
  if (value === null) return '';
  let s = value;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // 含分隔符 / 引号 / 换行，或首尾有空格时必须加引号（RFC 4180 §2.5–2.7）。
  // 首尾空格不引号时 Excel 会直接吃掉，肉眼看起来是"我们导出的值变了"。
  if (/["\r\n,]/.test(s) || s !== s.trim()) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * 数值单元格。**刻意不走 `csvText`**：`-100` 是负数不是公式，前缀单引号会把它变成
 * 文本，于是这份对账表在 Excel 里求不了和、也排不了序 —— 防注入防掉了本表的用途。
 * 这些数都是我们自己算出来的 int（金额分、计数），没有外部文本混进来的路径。
 */
export function csvNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

/**
 * 套餐的"覆盖到什么时候"= 所有套餐里最晚的 `end_at`。
 *
 * 取最晚而不是"第一个"或"当前生效那个"：这份表的用途是**对账**（谁的套餐快到期），
 * 而账号是被套餐**接续**覆盖的 —— 取任何一个中间值都会让一个已续过期的账号看起来快到期了。
 * 全部无到期时间（上游没给）时是空串，不是 `0` / 不是 `-`。
 *
 * 依赖 `end_at` 已是 ISO8601 UTC（§15.1），才可以用字符串比较代替时间比较。
 * 这条依赖落在**写入侧**：导入路径负责归一化上游格式。上游格式不一时在**读侧**猜格式，
 * 只会把"数据没归一化"这个真问题盖成"偶尔排序不对"。
 */
function latestEndAt(subscriptions: SupplierSubscriptionDto[]): string | null {
  let max: string | null = null;
  for (const s of subscriptions) {
    if (s.endAt !== null && (max === null || s.endAt > max)) max = s.endAt;
  }
  return max;
}

/** 账号列表 → CSV 文本（含表头行，末尾有 EOL；**不含 BOM**，见 `CSV_BOM`）。 */
export function buildSupplierAccountsCsv(accounts: SupplierAccountDto[]): string {
  const lines: string[] = [SUPPLIER_ACCOUNT_CSV_HEADERS.join(',')];
  for (const a of accounts) {
    lines.push(
      [
        csvText(a.upstreamId),
        csvText(a.identifier),
        csvText(a.uid),
        csvText(a.status),
        csvText(a.statusMessage),
        csvNumber(a.balanceCents),
        csvText(a.balanceUpdatedAt),
        csvNumber(a.keyCount),
        csvNumber(a.unlimitedKeyCount),
        csvNumber(a.maskedKeyCount),
        csvNumber(a.subscriptions.length),
        csvText(latestEndAt(a.subscriptions)),
        csvText(a.createdAt),
        csvText(a.updatedAt),
      ].join(','),
    );
  }
  return lines.join(EOL) + EOL;
}
