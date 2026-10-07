// `POST /api/supplier-accounts/import` 的 `text` 解析（契约 §15.2）。
//
// ## 这里有两件事绝对不能做
//
// 1. **失败行不得回带原文。** `text` 的每一行都含明文密码，而解析结果最终会进
//    `tasks.result.items[]`（§15.3）—— 那是会被前端渲染、会被 `GET /api/tasks/:id`
//    读出来、会留在 tasks 表里的地方。所以 `LineProblem` 里**只有行号与一句原因**，
//    没有任何形式的原始切片：不做"截断保留"，不留"前 4 位"。
//    代价是报错时操作员要自己对着原文数第几行 —— 这正是给行号的原因。
//
// 2. **不猜。** 分隔符与表头都按 §15.2 明写的三种容忍处理；一处拿不准（见
//    `splitCells` 的第二条守卫）就报一行失败，而不是拼出一个看起来像手机的错号
//    —— 错号的后果是拿别人的账号去撞风控，而**它不会报错**。

import { sha256Hex } from '../db/crypto.js';
import { maskIdentifier, normalizeIdentifier } from './identifiers.js';

/** 解析失败行的统一码（§15.2「逐行报原因」）。具体原因在 `message` 里。 */
export const LINE_PARSE_FAILED = 'LINE_PARSE_FAILED';

export interface ParsedImportRow {
  /** 1-based 行号，对着粘贴的原文数 */
  line: number;
  /** 归一化**真值**。只活在调用方栈内，随密码一起进密文（`supplier/credentials.ts`） */
  identifier: string;
  /** 入库到 `supplier_accounts.identifier` 的**掩码** */
  maskedIdentifier: string;
  identifierHash: string;
  /** 明文密码。同一个纪律：只活在栈内 */
  password: string;
}

export interface LineProblem {
  line: number;
  /** 一句人话。**不含原文任何片段** —— 见文件头第 1 条 */
  message: string;
}

export interface ImportParse {
  rows: ParsedImportRow[];
  problems: LineProblem[];
}

/** 表头行的判据词。**两个单元格都必须是表头词**才认（见 `looksLikeHeader`）。 */
const HEADER_ACCOUNT = new Set([
  '手机号',
  '账号',
  '帐号',
  'account',
  'identifier',
  'phone',
  'username',
  'mobile',
  '用户名',
]);
const HEADER_SECRET = new Set(['密码', 'password', 'passwd', 'pass', 'pwd', 'secret', 'credentials']);

/**
 * 首列是"表头词"、且次列也是"表头词"。
 *
 * **要求两列同时命中**，而不是"次列是 `密码` 就算表头"：后者会把一行真实数据
 * `abc,password` 静默吃掉（而它本来会以"掩不出掩码"报一行失败，那才是可查的）。
 * 表头行的唯一职责是别让人把第一行数据当成账号，而这个判据两列同时命中的概率
 * 在实际清单里是 1，在真实账号里是 0。
 */
function looksLikeHeader(accountCell: string, secretCell: string): boolean {
  return (
    HEADER_ACCOUNT.has(accountCell.trim().toLowerCase()) &&
    HEADER_SECRET.has(secretCell.trim().toLowerCase())
  );
}

/** 整格全是手机号字符（`+` 数字 空白 `-` `()`）。用于 `splitCells` 的第二条守卫。 */
const PHONE_CHARS = /^[+\d\s\-()]+$/;

/**
 * 把一行切成 `[账号, 密码]`；切不出第二格返回 `null`。
 *
 * 三条路按可靠性递减，**第一条命中就不走后面**：
 *
 *   1. **显式分隔符**（`,` `;` 制表符）：在**第一次**出现处切，不是 `split` 全部 ——
 *      密码里完全可能有一个逗号，`split(',')` 会把它切掉半截，而且切开后
 *      密码变短**不会报错**，只会变成"密码错误"。
 *   2. **手机号前缀 + 空白**：`+86 162 3456 7890 pwd` 这种数字里带空白的写法。
 *      正则让数字/空白吃到最后一段连续空白处，其余整段作密码。
 *   3. **首个空白**：邮箱 / 用户名开头的情况。
 *
 * **守卫（2 与 3 共用）**：这两条路都没有显式分隔符，而 `138 0000 0000`
 * （一个用空白分组的手机号、**没有密码**）会在这里被切成"账号 `138 0000` + 密码 `0000`"，
 * 归一化后是一个**看起来完全合法的错号**。所以当"密码"整格仍是手机号字符时一律
 * 判定切分失败 —— 宁可报一行让人去看，也不造一个查不出来的错号。
 * 显式分隔符那条路**不受此限**：`162…,123456` 的密码就是纯数字，那是合法的。
 */
function splitCells(line: string): [string, string] | null {
  const explicit = /[,;\t]/.exec(line);
  if (explicit !== null) {
    return [line.slice(0, explicit.index), line.slice(explicit.index + 1)];
  }

  const phoneLead = /^([+\d][\d\s\-()]*)\s+(\S.*)$/.exec(line);
  if (phoneLead !== null) {
    const account = phoneLead[1] ?? '';
    const secret = phoneLead[2] ?? '';
    if (!PHONE_CHARS.test(secret)) return [account, secret];
  }

  const ws = /^(\S+)\s+(.*)$/.exec(line);
  if (ws !== null) {
    const account = ws[1] ?? '';
    const secret = ws[2] ?? '';
    if (secret !== '' && !PHONE_CHARS.test(secret)) return [account, secret];
  }
  return null;
}

/**
 * 解析粘贴 / 上传的清单。
 *
 * 空行**不进合计**（既不是账号也不是失败行）：把空行算成"失败"会让
 * `ok + failed + skipped = total` 这个恒等式在一份末尾带换行的清单上直接不成立，
 * 而那个恒等式是操作员核对"我贴了 27 行、它处理了 27 行"的唯一凭据。
 */
export function parseAccountText(text: string): ImportParse {
  const rows: ParsedImportRow[] = [];
  const problems: LineProblem[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  /** 判重发生在归一化后的**真值**上：同一个号写成 `+86162…` 与 `162…` 是一个人。 */
  const seen = new Set<string>();
  let headerConsumed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    if (line.trim() === '') continue;

    const cells = splitCells(line);
    if (cells === null) {
      problems.push({ line: lineNo, message: '这一行没有分隔符，读不出「账号 + 密码」两格' });
      continue;
    }
    const [accountCell, secretCell] = cells;

    if (!headerConsumed) {
      headerConsumed = true;
      if (looksLikeHeader(accountCell, secretCell)) continue;
    }

    const identifier = normalizeIdentifier(accountCell);
    if (identifier === null) {
      problems.push({ line: lineNo, message: '账号一格是空的' });
      continue;
    }
    const masked = maskIdentifier(identifier);
    if (masked === null) {
      // **不做"掩不了就存原文"的兜底**：`maskIdentifier` 在任何输入下退化输出原文
      // 就是一条静默的明文泄漏路径（见该函数注释），所以这里只能拒绝这一行。
      problems.push({ line: lineNo, message: '账号太短，掩不了码（手机号至少 7 位 / 邮箱要有域名）' });
      continue;
    }

    // 两侧都 trim：粘贴的清单几乎总在分隔符后带一个空格，而"密码首尾真带空格"
    // 的概率远低于前者。**只在两侧** trim，中间的空格一个字都不动。
    const password = secretCell.trim();
    if (password === '') {
      problems.push({ line: lineNo, message: '密码一格是空的（会话型凭据不走这个端点，见 §15.9）' });
      continue;
    }

    if (seen.has(identifier)) {
      problems.push({ line: lineNo, message: '这一行与前面某一行是同一个账号，已跳过' });
      continue;
    }
    seen.add(identifier);

    rows.push({
      line: lineNo,
      identifier,
      maskedIdentifier: masked,
      identifierHash: sha256Hex(identifier),
      password,
    });
  }

  return { rows, problems };
}
