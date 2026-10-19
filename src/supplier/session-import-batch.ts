// §15.9 离线会话导入的**批量**形态：一份本机文件里放多行「标识 + 会话」。
//
// ## 为什么批量仍然在离线脚本里，而不是开一个 HTTP 入口
//
// 会话值等价于"已经登录的浏览器"。§15.9 纪律 1 把入口定死为操作员本机的离线导入，
// 因为多账号并不会改变风险的形状 —— 它只会把明文过路点从一枚放大到 N 枚。
// 批量只是想省掉"每个号跑一次脚本"，所以这里做的是**同一件事的循环**：
// 零上游请求、只打印掩码、会话值不进任何 message / 返回值 / 日志。
//
// ## 文件格式（刻意只有一种，且分隔符显式）
//
//   每行：`<标识><TAB 或 逗号 或 空白><会话>`
//   - 空行与 `#` 开头的注释行不进合计；
//   - 首行可以是表头（`identifier,session` / `账号,cookie`），只吃一次；
//   - 会话一侧可以整段粘贴 `tr_session=…; Path=/`，这里只取 cookie 的 value；
//   - 同一标识在文件里出现第二次 → 跳过并报一行（保留第一行，避免"最后一行赢"的暗坑）。
//
// **失败行不回显会话，也不回显标识原文**：输出只用行号 + 原因；成功行只给掩码。
// 这与 `import-text.ts` 的第 1 条纪律同源（结果可能进日志/终端历史）。

import type { Db } from '../db/database.js';
import { importSupplierSession } from './session-import.js';
import { maskIdentifier, normalizeIdentifier } from './identifiers.js';

export interface SessionBatchRow {
  /** 1-based 行号，对着操作员的文件数 */
  line: number;
  /** 归一化真值。只活在本次调用内，不返回、不打印。 */
  identifier: string;
  /** 会话值本身（已去掉 cookie 名与属性）。只活在本次调用内。 */
  session: string;
}

export interface SessionBatchProblem {
  line: number;
  /** 一句人话。**不含会话值，也不含标识原文**（掩码也不给 —— 解析失败时可能根本没有合法标识）。 */
  message: string;
}

export interface SessionBatchParse {
  rows: SessionBatchRow[];
  problems: SessionBatchProblem[];
}

/** 表头词：首列与次列**同时命中**才认（同 `import-text.ts` 的理由）。 */
const HEADER_IDENTIFIER = new Set([
  'identifier',
  'account',
  'phone',
  'mobile',
  'email',
  'username',
  '手机号',
  '账号',
  '帐号',
  '邮箱',
  '用户名',
]);
const HEADER_SESSION = new Set(['session', 'cookie', 'tr_session', '会话', '会话值', 'cookie值']);

/**
 * 切出 `[标识, 会话]`。分隔符按出现位置取**最早的一个**：TAB / 逗号 / 空白。
 *
 * 不提供"整段 `split`"：会话值可能包含 `=`、`;`，切碎了不会报错，只会变成
 * "会话过期" —— 那是最难排查的一种失败。
 */
function splitBatchLine(line: string): [string, string] | null {
  const m = /[\t,]|\s/.exec(line);
  if (m === null) return null;
  const at = m.index;
  const first = line.slice(0, at).trim();
  const rest = line.slice(at + 1).trim();
  if (first === '' || rest === '') return null;
  return [first, rest];
}

/** 去掉 CSV 引号、`tr_session=` 前缀与 `; Path=/` 这类属性，只留 cookie 的 value。 */
export function normalizeSessionValue(raw: string): string {
  let value = raw.trim();
  // 整段复制浏览器请求头时常见 `Cookie: tr_session=…` / `Set-Cookie: …`。
  // 不先剥这层，分号切分后第一段带着 `Cookie:` 前缀，`name=value` 判据认不出来。
  value = value.replace(/^(?:set-)?cookie\s*:\s*/i, '');
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  if (quoted && value.length >= 2) value = value.slice(1, -1).trim();

  const segments = value
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  if (segments.length === 0) return '';

  // 整段 Cookie 头：优先找 tr_session（这家唯一认的名字），否则第一个 `name=value`。
  const named = segments.find((item) => /^tr_session=/i.test(item));
  const firstNamed = segments[0] ?? '';
  const picked =
    named ??
    (/^[A-Za-z0-9_.-]+=/.test(firstNamed) ? firstNamed : segments.join('; '));
  const eq = picked.indexOf('=');
  return (eq >= 0 ? picked.slice(eq + 1) : picked).trim();
}

/**
 * 解析批量文件。空行与注释行**不进合计**（同 `parseAccountText` 的恒等式纪律）。
 */
export function parseSessionBatchText(text: string): SessionBatchParse {
  const rows: SessionBatchRow[] = [];
  const problems: SessionBatchProblem[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  const seen = new Set<string>();
  let headerChecked = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const cells = splitBatchLine(line);
    if (cells === null) {
      problems.push({ line: lineNo, message: '这一行没有分隔符，读不出「标识 + 会话」两格' });
      continue;
    }
    const [identifierCell, sessionCell] = cells;

    if (!headerChecked) {
      headerChecked = true;
      if (
        HEADER_IDENTIFIER.has(identifierCell.toLowerCase()) &&
        HEADER_SESSION.has(sessionCell.toLowerCase())
      ) {
        continue;
      }
    }

    const identifier = normalizeIdentifier(identifierCell);
    if (identifier === null) {
      problems.push({ line: lineNo, message: '标识一格无法归一化（手机号 / 邮箱）' });
      continue;
    }
    const masked = maskIdentifier(identifier);
    if (masked === null) {
      // 同 `session-import.ts`：掩不了码就拒绝，绝不退化存原文。
      problems.push({
        line: lineNo,
        message: '标识太短，掩不了码（手机号至少 7 位 / 邮箱要有域名）',
      });
      continue;
    }

    const session = normalizeSessionValue(sessionCell);
    if (session === '') {
      problems.push({ line: lineNo, message: '会话一格是空的（Cookie 的 value 不能为空）' });
      continue;
    }

    if (seen.has(identifier)) {
      problems.push({ line: lineNo, message: '这一行与前面某一行是同一个账号，已跳过（保留第一行）' });
      continue;
    }
    seen.add(identifier);

    rows.push({ line: lineNo, identifier, session });
  }

  return { rows, problems };
}

export interface SessionBatchOutcome {
  line: number;
  /** 成功行的掩码；失败行为 `null`（不回显标识原文）。 */
  identifier: string | null;
  accountId: string | null;
  created: boolean;
  ok: boolean;
  message: string;
}

export interface SessionBatchReport {
  outcomes: SessionBatchOutcome[];
  problems: SessionBatchProblem[];
  summary: { total: number; created: number; updated: number; failed: number; problems: number };
}

export interface ImportSessionBatchInput {
  upstreamId: string;
  text: string;
  tfUser?: string | null;
  username?: string | null;
  uid?: string | null;
  excluded?: ReadonlySet<string> | undefined;
  sessionExpiresAt?: string | null | undefined;
}

/**
 * 逐行导入。**单行失败不中断整批** —— 一份 30 个号的文件不该因为第 7 行少了一格
 * 就只导入前 6 个。真正的环境故障（密钥错、磁盘满）仍由 `importSupplierSession` 抛出。
 */
export function importSupplierSessionBatch(
  db: Db,
  masterKey: Buffer,
  input: ImportSessionBatchInput,
): SessionBatchReport {
  const parsed = parseSessionBatchText(input.text);
  const outcomes: SessionBatchOutcome[] = [];

  for (const row of parsed.rows) {
    const result = importSupplierSession(db, masterKey, {
      upstreamId: input.upstreamId,
      identifier: row.identifier,
      session: row.session,
      tfUser: input.tfUser,
      username: input.username,
      uid: input.uid,
      excluded: input.excluded,
      sessionExpiresAt: input.sessionExpiresAt,
    });
    if (result.ok) {
      outcomes.push({
        line: row.line,
        identifier: result.identifier,
        accountId: result.accountId,
        created: result.created,
        ok: true,
        message: result.created ? '新建' : '覆写既有行',
      });
    } else {
      outcomes.push({
        line: row.line,
        identifier: null,
        accountId: null,
        created: false,
        ok: false,
        message: result.message,
      });
    }
  }

  const created = outcomes.filter((item) => item.ok && item.created).length;
  const updated = outcomes.filter((item) => item.ok && !item.created).length;
  const failed = outcomes.filter((item) => !item.ok).length;
  return {
    outcomes,
    problems: parsed.problems,
    summary: {
      total: parsed.rows.length,
      created,
      updated,
      failed,
      problems: parsed.problems.length,
    },
  };
}
