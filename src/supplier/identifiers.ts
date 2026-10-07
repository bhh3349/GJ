// 账号标识（手机号 / 邮箱）的归一化、掩码与**排除名单**。
//
// 三件事挤在一个文件里是因为它们是同一个问题的三个面：归一化决定"两行是不是同一个号"
// （写入侧算 `identifier_hash`）、掩码决定"库里那一行给人看的是什么"、
// 排除名单决定"这一行今天能不能被碰"。三处各写一份归一化，就会出现
// "判重时算 `+86162…`、排除时比 `162…`、显示时用原文"—— 而症状是**某个号被静默漏掉**。

/**
 * 归一化：把"同一个号的各种写法"收成一个字符串（`identifier_hash` 的输入）。
 *
 * 契约 §15.2 `import` 明写要容忍**表头行、`+86` 前缀、空格 / 制表符 / 分号分隔**。
 * 容忍的落点在这里，不在解析器里 —— 解析器只管切列。
 *
 * 两条路各按自己的规矩收：
 *   - **手机号**（`+` / 数字 / 分隔符构成的）：只留数字；`86` 前缀（`+86` / `0086` / `86`）
 *     且总长恰为 13 位时剥掉，得 11 位。剥的条件写死成"11 + 2"，是为了不把
 *     一个本来就以 86 开头的 11 位号误剥成 9 位。
 *   - **邮箱**：trim + 小写。**不去分隔符**，`a.b@x.com` 和 `ab@x.com` 是两个人。
 *
 * 收不出东西（空串、纯符号）返回 `null` —— 调用方按"这一行跳不过去"处理，不造行。
 */
export function normalizeIdentifier(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const looksLikePhone = /^[+\d\s\-()]+$/.test(trimmed);
  if (looksLikePhone) {
    let digits = trimmed.replace(/\D/g, '');
    // `0086` 先剥（国际写法），再判 `86`：顺序反了 `008613800000000` 会剩下 `0086…`。
    if (digits.startsWith('0086')) {
      digits = digits.slice(4);
    } else if (digits.length === 13 && digits.startsWith('86')) {
      digits = digits.slice(2);
    }
    return digits === '' ? null : digits;
  }

  // 其余（邮箱等）只做 trim + 小写：**不去分隔符**，`a.b@x.com` 和 `ab@x.com` 是两个人。
  return trimmed.toLowerCase();
}

/**
 * 展示用掩码 —— 入库到 `supplier_accounts.identifier` 的就是它。
 *
 * **真值不出后端**（§15.1：`identifier` 是掩码，真值只以 sha256 摘要存在）。
 * 手机号取 `前3 + **** + 后4`（契约样例 `162****4225`）；
 * 邮箱只留首字符与域名，`ab@x.com` → `a*@x.com`。
 *
 * 短到没法掩的输入**返回 `null`，不返回原文** —— 掩码函数在任何输入下退化输出原文，
 * 就是一条静默的明文泄漏路径。
 */
export function maskIdentifier(normalized: string): string | null {
  if (/^\d+$/.test(normalized)) {
    if (normalized.length < 7) return null;
    return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
  }

  const at = normalized.indexOf('@');
  if (at <= 0) return null;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at);
  const head = local.slice(0, 1);
  return `${head}*${domain}`;
}

/** 排除名单的环境变量名。**值是运行时给的，不进仓、不进文档正文**（§15.9 纪律 1/2）。 */
export const EXCLUDED_IDENTIFIERS_ENV = 'SUPPLIER_EXCLUDED_IDENTIFIERS';

/**
 * 解析排除名单：逗号 / 分号 / 换行分隔，每项按 `normalizeIdentifier` 归一化。
 *
 * ## 为什么名单走环境变量，而不是写进代码
 *
 * 排除名单里装的是**真实手机号**。把它写进源码 = 写进 git = 一个不该在仓库里
 * 长期留存的个人标识符，而且它会一路复制到每一条车道、每一个 fork。
 * 环境变量让"今天的纪律"活在运行时，代码里只留"有一条纪律"这件事。
 *
 * ## 它防的是什么
 *
 * 操作员在群里下过一条硬约束：**某个号永不参与任何测试**。这条如果只存在于
 * 人的记忆或群聊记录里，那么下一次批量导入时它就是一个**没有人会想起来**的条件 ——
 * 而代价是拿一个真实账号去撞供应商风控。所以它必须是一条**代码里的闸**：
 * 名单非空的运行时，导入 / 建 key 的候选集先过 `isExcluded()`，
 * 命中即跳过（**跳过要计数并报出来**，静默跳过等于没跳过）。
 *
 * 默认空名单 = 不排除任何号。**空不等于放行**：空只说明"这一次没人给出排除项"，
 * 别把它读成"这一批都安全"。
 */
export function parseExcludedIdentifiers(
  env: Record<string, string | undefined> = process.env,
): ReadonlySet<string> {
  const raw = env[EXCLUDED_IDENTIFIERS_ENV];
  if (raw === undefined || raw.trim() === '') return new Set<string>();

  const out = new Set<string>();
  for (const piece of raw.split(/[,;\r\n]+/)) {
    const normalized = normalizeIdentifier(piece);
    if (normalized !== null) out.add(normalized);
  }
  return out;
}

/** 是否为排除项。传入的可以是未归一化的原文 —— 归一化只在这里做一次。 */
export function isExcluded(
  identifier: string,
  excluded: ReadonlySet<string>,
): boolean {
  if (excluded.size === 0) return false;
  const normalized = normalizeIdentifier(identifier);
  // 收不出东西的输入**不当作排除**：它不是"被排除的号"，是"这一行根本没法处理"，
  // 该由解析器按"跳过并报原因"处置（§15.2），混在这里会让两件事的计数对不上。
  return normalized !== null && excluded.has(normalized);
}
