// 上游套餐行 → 库内写形态（契约 §15.1 `SupplierSubscriptionDto` / §15.2 `refresh`）。
//
// ## 为什么这张映射表要单独一个文件
//
// 它是**上游字段名**与我们列名之间唯一的一处翻译。契约只钉了我们这一侧的字段
// （`subNo` / `amountTotalCents` / `paidCents` / `endAt`…），上游那侧的名字写在
// 供应商自己的接口里，与 §16.1.1 同批**待实测**。单独立文件的收益是：实测回来
// 字段名对不上时，改动落在一个**没有别的东西**的文件里 —— 而不是散在 refresh /
// keys/sync / test 三个调用点各改一遍，且改漏一处不会报错（那一处会静默变成 null）。
//
// ## 三条取值纪律
//
// 1. **三个金额单位同屏**（ADR-0018 / §15.1）：上游 `amount_total` 是 **quota**、
//    `paid_money` 是**浮点元**、我们的列一律 **int 分**。换算只在这里做，
//    且一律 `Math.round` 不截断（`29.9 * 100 = 2989.9999999999995`，截断系统性少一分）。
// 2. **取不到就是 `null`**，不是 0、不是空串。上游没给的字段（老套餐没有 `source`）
//    与被我们读漏的字段，在库里都该是"未知"，而不是一个会被前端当真的 0。
// 3. **`sub_no` 读不出来就整行丢掉**：它是套餐的唯一标识（表上有 `UNIQUE(account_id, sub_no)`），
//    没有它这一行既不能去重也不能更新。丢掉是安全的 —— 下次同步还在。

import { maskFromUpstream, quotaToCents } from './tierflow.js';
import type { SupplierSubscriptionWrite } from '../db/repo/supplier-accounts.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 取一个非空字符串；其余（数字、空串、缺失）一律 `null` —— 见文件头第 2 条。 */
function readString(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function readNumber(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    // 上游偶尔把数字写成字符串（`"29.9"`）。**只接受能整体解析的** ——
    // `Number('29.9元')` 是 NaN，而 `parseFloat('29.9元')` 是 29.9（静默吞掉单位）。
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

function readBool(source: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

/** 带时区的时间串：能被 `Date.parse` 解析出确定时刻的那些。 */
function readZonedIso(value: string): string | null {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * 上游时间 → ISO8601 UTC。
 *
 * ## 这里有一处**时区假设**，全文件唯一的一处
 *
 * 上游给的是 `2026-11-01 00:00:00` 这种**不带时区**的串，而 §0.2 明写
 * 「不带时区的时间串视为非法」。三种处理里：
 *   - 原样存 → 库里混着 `…T…Z` 与 `… …` 两种形态，SQLite 字符串排序直接错
 *     （`'2026-11-01 23:00'` 排在 `'2026-11-01T00:00Z'` **前面**，而它更晚）；
 *   - 存 `null` → 到期时间整列消失，而这列正是 `GET /subscriptions` 的排序键；
 *   - **按 UTC 补 `Z`** → 若上游其实是 UTC+8，所有值整体平移 8 小时。
 *     **排序不受影响**（同一来源的平移是均匀的），只有"精确到小时"的展示会偏 ——
 *     而"接下来谁到期"这个用途要的是顺序，不是那个小时。
 *
 * 选第三种，并把假设写在这里（也写进待实测清单）：它把一个**可以靠实测一处修正**的
 * 偏差留下来，而不是一个会静默打乱排序的形态。epoch 数字走第一条，没有这个假设。
 */
export function normalizeUpstreamTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 秒 / 毫秒两种上游都给过。1e12 是分界：秒级 epoch 到 33658 年才够到它。
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (/^\d+$/.test(trimmed)) return normalizeUpstreamTime(Number(trimmed));

  const zoned = readZonedIso(trimmed);
  if (zoned !== null) return zoned;

  // `YYYY-MM-DD[ T]HH:MM[:SS]` 不带时区 → 按 UTC 补 `Z`（见上方长注释）
  const naive = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(trimmed);
  if (naive !== null) {
    const secs = (naive[2] ?? '').length === 5 ? `${naive[2]}:00` : (naive[2] ?? '');
    const ms = Date.parse(`${naive[1]}T${secs}Z`);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }

  // 读不懂就 null。**不原样存** —— 库里出现一个解析不了的到期时间，
  // 排序会把它排到一个谁也说不清的位置，而 null 至少排最后且是诚实的。
  return null;
}

/** 上游掩码 → 我们池内同形掩码（`****` + 后 4 位）。剥 `sk-` 的理由见 §15.2 `keys/sync`。 */
// 先 `import` 再 `export`，**不能**写成 `export { x } from …`：那种写法只重导出、
// 不把名字绑进本文件的作用域，而 `mapSubscription` 下面要用它（写成重导出会让这一处
// 变成 TS2304）。转发与自用是两件事，需要两个语句。
export { maskFromUpstream };

/**
 * 一行业上游套餐 → 库内写形态。`sub_no` 读不出时返回 `null`（整行丢弃，见文件头第 3 条）。
 *
 * `quotaPerUnit` 是**比例**（默认 500000，§15.1）：`amount_total` / `amount_used`
 * 都是 quota，必须除它才对得上人民币。
 */
export function mapSubscription(
  raw: unknown,
  quotaPerUnit: number,
): SupplierSubscriptionWrite | null {
  const row = asRecord(raw);
  if (row === null) return null;

  const subNo = readString(row, 'sub_no', 'subNo');
  if (subNo === null) return null;

  // `paid_money` 是**浮点元**，不是 quota：只 round，不过 quotaToCents。
  const paidYuan = readNumber(row, 'paid_money', 'paidMoney');
  const keyMasked = maskFromUpstream(readString(row, 'key', 'key_masked', 'keyMasked') ?? '');
  const hasKeyFlag = readBool(row, 'has_key', 'hasKey');

  return {
    subNo,
    planTitle: readString(row, 'plan_title', 'planTitle'),
    planSlug: readString(row, 'plan_slug', 'planSlug'),
    amountTotalCents: quotaToCents(row['amount_total'] ?? row['amountTotal'], quotaPerUnit),
    amountUsedCents: quotaToCents(row['amount_used'] ?? row['amountUsed'], quotaPerUnit),
    paidCents: paidYuan === null ? null : Math.round(paidYuan * 100),
    basicTokenTotal: readNumber(row, 'basic_token_total', 'basicTokenTotal'),
    basicTokenUsed: readNumber(row, 'basic_token_used', 'basicTokenUsed'),
    status: readString(row, 'status'),
    source: readString(row, 'source'),
    startAt: normalizeUpstreamTime(row['start_at'] ?? row['startAt']),
    endAt: normalizeUpstreamTime(row['end_at'] ?? row['endAt']),
    // **三态**（§15.1）：`null` = 上游根本没给这个字段，**不是 false**。
    // 合并两态等于替供应商下结论"不会自动续费"。
    autoRenew: readBool(row, 'auto_renew', 'autoRenew'),
    // `has_key` 缺失但有掩码时按"有"算：掩码本身就是"有 key"的证据，
    // 反过来（有 has_key=true 却没掩码）也成立 —— 两处有一处为真即真。
    hasKey: hasKeyFlag === true || keyMasked !== null,
    keyMasked,
  };
}
