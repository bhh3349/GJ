// §15.9 cookie-only 会话批量导入（v1.16.3）。
//
// ## 它解决的是哪一种输入
//
// 操作员手上**只有 cookie**，没有手机号 / 邮箱。文件每行就是一枚会话：
//
//   tr_session=xxxxx; Path=/
//   yyyyy
//
// 脚本先向上游 `GET /api/me` 问出 `id` / `name` / `phoneMasked`，再用**上游 uid**
// 判重并落库。与 `session-import-batch.ts` 的关系：
//
//   - 标识已知 → 零上游请求，本地归一化 + 掩码 + sha256(真值) 判重（原通路，不变）；
//   - 只有 cookie → 每枚会话 1 次 `GET /api/me`，用上游 uid 判重（本模块）。
//
// 两条通路写的是同一张表、同一批不变量（一个账号一行、会话只落密文、只展示掩码）。
//
// ## 纪律没有被这条通路放宽
//
// - 会话值只从**操作员本机文件**或 `POST /api/supplier-accounts/import-sessions`
//   的**粘贴文本**进入（v1.16.4，业主显式接受粘贴值过一次管理面 HTTP 的代价，见 §15.9）；
//   无论哪条入口，都不落日志、不回显、只落密文；
// - 输出只有行号 / 掩码 / 原因，**不回显会话值**，也不回显上游返回的原始身份对象；
// - 身份解析只发 GET，不碰 `tr_csrf`，不建立"用会话换新会话"的能力。
//
// ## 排除名单在这里为什么是**入口拒绝**
//
// `SUPPLIER_EXCLUDED_IDENTIFIERS` 装的是真实手机号 / 邮箱，判定按真值做。cookie-only
// 手里只有掩码，无法判断"这一枚会话是不是名单里的号"。静默跳过判定 = 把一条硬约束
// 变成建议，所以这条通路在名单非空时**整体拒绝**，并提示改用标识 + 会话模式。

import type { Db } from '../db/database.js';
import { sha256Hex } from '../db/crypto.js';
import { getUpstreamRow } from '../db/repo/upstreams.js';
import { normalizeSessionValue } from './session-import-batch.js';
import { importResolvedSupplierSession } from './session-import.js';
import { resolveTokenRhythmIdentity } from './session-resolve.js';

export interface CookieOnlyRow {
  /** 1-based 行号，对着操作员的文件数。 */
  line: number;
  /** 会话值本身。只活在本次调用内，不返回、不打印。 */
  session: string;
}

export interface CookieOnlyProblem {
  line: number;
  /** 一句人话。**不含会话值**。 */
  message: string;
}

export interface CookieOnlyParse {
  rows: CookieOnlyRow[];
  problems: CookieOnlyProblem[];
}

/** 首行可能的表头（归一化后整行匹配）。 */
const HEADER_WORDS = new Set([
  'cookie',
  'cookies',
  'session',
  'tr_session',
  'cookie值',
  '会话',
  '会话值',
]);

/**
 * 解析"每行一枚会话"的文件。空行与 `#` 注释跳过；首行表头只吃一次；
 * 同一枚会话在文件里出现第二次 → 跳过并报一行（避免同一账号重复问上游）。
 */
export function parseCookieOnlyText(text: string): CookieOnlyParse {
  const rows: CookieOnlyRow[] = [];
  const problems: CookieOnlyProblem[] = [];
  const lines = text.split(/\r\n|\r|\n/);
  const seen = new Set<string>();
  let headerChecked = false;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i] ?? '';
    const lineNo = i + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const session = normalizeSessionValue(trimmed);
    if (session === '') {
      problems.push({ line: lineNo, message: '这一行没有会话值（Cookie 的 value 不能为空）' });
      continue;
    }

    if (!headerChecked) {
      headerChecked = true;
      if (HEADER_WORDS.has(session.toLowerCase()) && !trimmed.includes('=')) {
        continue;
      }
    }

    if (seen.has(session)) {
      problems.push({ line: lineNo, message: '这一行与前面某一行是同一枚会话，已跳过（保留第一行）' });
      continue;
    }
    seen.add(session);

    rows.push({ line: lineNo, session });
  }

  return { rows, problems };
}

export interface CookieOnlyOutcome {
  line: number;
  /** 成功行的掩码；失败行为 `null`。 */
  identifier: string | null;
  accountId: string | null;
  created: boolean;
  ok: boolean;
  message: string;
  /** 失败行的机器可读原因（成功行为 `null`）；**不含会话值**。 */
  reason: string | null;
}

export interface CookieOnlyReport {
  outcomes: CookieOnlyOutcome[];
  problems: CookieOnlyProblem[];
  summary: { total: number; created: number; updated: number; failed: number; problems: number };
}

export interface ImportSessionCookiesInput {
  upstreamId: string;
  text: string;
  tfUser?: string | null;
  sessionExpiresAt?: string | null | undefined;
  /** 非空即整体拒绝（见文件头）。 */
  excluded?: ReadonlySet<string> | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /**
   * 进度回调：`total` 含解析失败行，`done` 为已处理行数。
   * 任务面板用它显示"已处理 n / N"；回调本身**拿不到任何会话值**。
   */
  onLine?: ((done: number, total: number) => void) | undefined;
}

export type ImportSessionCookiesResult =
  | { ok: true; report: CookieOnlyReport }
  | { ok: false; reason: string; message: string };

/** 入口闸：上游、供应商能力、排除名单。放在打任何上游请求之前。 */
function entryProblem(
  db: Db,
  input: ImportSessionCookiesInput,
): { ok: false; reason: string; message: string } | null {
  const upstream = getUpstreamRow(db, input.upstreamId);
  if (upstream === null) {
    return { ok: false, reason: 'upstream_not_found', message: `上游 ${input.upstreamId} 不存在` };
  }
  if (upstream.supplier !== 'tokenrhythm') {
    return {
      ok: false,
      reason: 'unsupported_supplier',
      message:
        'cookie-only 身份解析目前只支持 TokenRhythm（只有它没有密码登录且 /api/me 返回掩码）；' +
        '其他供应商请用「标识 + 会话」模式',
    };
  }
  if (input.excluded !== undefined && input.excluded.size > 0) {
    return {
      ok: false,
      reason: 'excluded_unverifiable',
      message:
        '排除名单按真实手机号/邮箱匹配，而 cookie-only 只能拿到掩码，无法验证；' +
        '为避免静默绕过名单，本批整体拒绝。请改用「标识 + 会话」模式，或清空排除名单后再跑',
    };
  }
  return null;
}

/**
 * 逐行解析身份并导入。**单行失败不中断整批** —— 一枚失效会话不该挡住后面 49 枚。
 *
 * 每行最多 1 次上游请求（`GET /api/me`）；失败行只报行号 + 原因。
 */
export async function importSupplierSessionCookies(
  db: Db,
  masterKey: Buffer,
  input: ImportSessionCookiesInput,
): Promise<ImportSessionCookiesResult> {
  const blocked = entryProblem(db, input);
  if (blocked !== null) return blocked;

  const upstream = getUpstreamRow(db, input.upstreamId);
  // entryProblem 已确认存在；这里的判空只为让类型收窄，不会改变行为。
  if (upstream === null) {
    return { ok: false, reason: 'upstream_not_found', message: `上游 ${input.upstreamId} 不存在` };
  }

  const parsed = parseCookieOnlyText(input.text);
  const outcomes: CookieOnlyOutcome[] = [];
  // 解析失败的行也算"已处理"：进度条从 problems.length 起步，跑到总行数。
  const total = parsed.rows.length + parsed.problems.length;
  let done = parsed.problems.length;
  input.onLine?.(done, total);

  for (const row of parsed.rows) {
    const resolved = await resolveTokenRhythmIdentity({
      baseUrl: upstream.base_url,
      session: row.session,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs,
    });

    if (!resolved.ok) {
      outcomes.push({
        line: row.line,
        identifier: null,
        accountId: null,
        created: false,
        ok: false,
        message: resolved.message,
        reason: resolved.reason,
      });
    } else {
      const { identity } = resolved;
      const result = importResolvedSupplierSession(db, masterKey, {
        upstreamId: input.upstreamId,
        identifier: identity.identifier,
        // 判重键：上游 uid。前缀把"uid 摘要"与"真值摘要"在语义上分开。
        identifierHash: sha256Hex(`tokenrhythm:uid:${identity.uid}`),
        session: row.session,
        tfUser: input.tfUser,
        username: identity.username,
        uid: identity.uid,
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
          reason: null,
        });
      } else {
        outcomes.push({
          line: row.line,
          identifier: null,
          accountId: null,
          created: false,
          ok: false,
          message: result.message,
          reason: 'persist_failed',
        });
      }
    }

    done += 1;
    input.onLine?.(done, total);
  }

  const created = outcomes.filter((item) => item.ok && item.created).length;
  const updated = outcomes.filter((item) => item.ok && !item.created).length;
  const failed = outcomes.filter((item) => !item.ok).length;
  return {
    ok: true,
    report: {
      outcomes,
      problems: parsed.problems,
      summary: {
        total: parsed.rows.length,
        created,
        updated,
        failed,
        problems: parsed.problems.length,
      },
    },
  };
}
