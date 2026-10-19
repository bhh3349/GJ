/**
 * §15.9 会话型凭据的**离线一次性导入**（操作员本机执行，不是 HTTP 端点）。
 *
 * ── 什么时候用它 ────────────────────────────────────────────────────────────
 * - TokenRhythm：**唯一**的入池通路。这家只有会话鉴权（`tr_session`），没有
 *   账号密码登录（§15.14.1「密码登录 ❌」），所以文本导入对它是 422。
 * - TierFlow：冷备 / 加速通道（有存档密码的账号优先走 `POST /api/supplier-accounts/import`）。
 *
 * ── 凭据纪律（§15.9 纪律 1/2，照着做，别改）────────────────────────────────
 * - 会话值只从**运行时环境变量**读，或从一个**本机文件**读（`SUPPLIER_SESSION_FILE` /
 *   `SUPPLIER_SESSION_BATCH_FILE`）；不写进仓库、不写进 `.env`、不进日志、不进聊天。
 * - 本脚本**只打印掩码**；成功输出里没有会话值，失败信息也不回显它。
 * - 值读进内存 → 加密（aes-256-gcm / `MASTER_KEY`）→ 落库。之后那份文件即可销毁。
 *
 * ── 单账号 ──────────────────────────────────────────────────────────────────
 *   set -a; . /tmp/subtest/test.env; set +a          # MASTER_KEY / DB_PATH 与实例一致
 *   SUPPLIER_UPSTREAM_ID=up_0480ca6f2598 \
 *   SUPPLIER_IDENTIFIER=19200005609 \
 *   SUPPLIER_SESSION_FILE=/path/to/session.txt \
 *   /opt/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/import-supplier-session.ts
 *
 * `SUPPLIER_SESSION_FILE` 里只放**会话值本身**（`tr_session` 的 value；不要 `tr_session=`，
 * 也不要整段 `Cookie:`）；也可以改用 `SUPPLIER_SESSION` 直接给值（会留在 shell 历史里，
 * 优先用文件）。
 *
 * ── 批量（一次导入多个账号）──────────────────────────────────────────────────
 *   SUPPLIER_UPSTREAM_ID=up_0480ca6f2598 \
 *   SUPPLIER_SESSION_BATCH_FILE=/path/to/sessions.txt \
 *   /opt/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/import-supplier-session.ts
 *
 * 文件每行 `标识<分隔符>会话`，分隔符用 **TAB / 逗号 / 空白** 任一；空行与 `#` 注释跳过；
 * 首行可以是 `identifier,session` / `账号,cookie` 表头。会话一侧可以整段粘贴
 * `tr_session=…; Path=/`，脚本只取 value。同一账号出现两次保留第一行并报一行。
 * **单行失败不中断整批**；退出码 1 表示至少一行没成功。`SUPPLIER_SESSION_BATCH_FILE=-`
 * 表示从 stdin 读（`cat sessions.txt | …`）。批量模式下 `SUPPLIER_IDENTIFIER` /
 * `SUPPLIER_SESSION*` 不参与。
 *
 * ── 只有 cookie、没有手机号/邮箱（TokenRhythm）────────────────────────────────
 *   SUPPLIER_UPSTREAM_ID=up_0480ca6f2598 \
 *   SUPPLIER_SESSION_COOKIE_ONLY=1 \
 *   SUPPLIER_SESSION_BATCH_FILE=/path/to/cookies.txt \
 *   /opt/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/import-supplier-session.ts
 *
 * 文件每行**只放一枚会话**（`tr_session=…; Path=/` 或裸 value 均可）。脚本用
 * `GET /api/me` 问出上游 uid / 用户名 / `phoneMasked`，用 uid 判重后落库：
 * 每行 1 次 GET，仍然只打印掩码，会话值不进任何输出。该模式目前只支持 TokenRhythm，
 * 且排除名单非空时整体拒绝（名单按真值匹配，cookie-only 无法验证）。
 *
 * 可选：`SUPPLIER_TF_USER`（TierFlow 的 `TF-User`；TokenRhythm 不用）、
 * `SUPPLIER_USERNAME` / `SUPPLIER_UID`（顺手记下，拿不到就留空）、
 * `SUPPLIER_SESSION_EXPIRES_AT`（ISO 时间；没有依据就省略，表示"未知"）。
 * 批量模式下这三个值应用到**每一行**；逐行不同的情况请分文件跑。
 *
 * 退出码：0 = 全部写入成功；1 = 至少一行业务拒绝 / 解析失败；2 = 配置缺失。
 */

import { readFileSync } from 'node:fs';
import { parseMasterKey } from '../src/db/crypto.js';
import { openDatabase } from '../src/db/database.js';
import { parseExcludedIdentifiers } from '../src/supplier/identifiers.js';
import { importSupplierSession } from '../src/supplier/session-import.js';
import {
  importSupplierSessionBatch,
  normalizeSessionValue,
} from '../src/supplier/session-import-batch.js';
import { importSupplierSessionCookies } from '../src/supplier/session-import-cookie.js';

function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function fail(code: number, message: string): never {
  console.error(`导入失败：${message}`);
  process.exit(code);
}

/** `-` = stdin：文件不必落盘，值不经过 shell 历史。 */
function readLocalFile(path: string): string {
  try {
    return path === '-' ? readFileSync(0, 'utf8') : readFileSync(path, 'utf8');
  } catch {
    fail(2, `读不到文件（${path}）`);
  }
}

const dbPath = env('DB_PATH');
const masterKeyRaw = env('MASTER_KEY');
const upstreamId = env('SUPPLIER_UPSTREAM_ID');

if (dbPath === undefined) fail(2, '缺少 DB_PATH（与实例使用同一个库）');
if (masterKeyRaw === undefined) fail(2, '缺少 MASTER_KEY（必须与实例一致，否则写入的密文读不回来）');
if (upstreamId === undefined) fail(2, '缺少 SUPPLIER_UPSTREAM_ID');

const batchFile = env('SUPPLIER_SESSION_BATCH_FILE');
const sessionFile = env('SUPPLIER_SESSION_FILE');
const sessionInline = env('SUPPLIER_SESSION');
const cookieOnly = ['1', 'true', 'yes', 'on'].includes(
  (env('SUPPLIER_SESSION_COOKIE_ONLY') ?? '').toLowerCase(),
);

if (cookieOnly && batchFile === undefined) {
  fail(2, 'SUPPLIER_SESSION_COOKIE_ONLY=1 需要同时给 SUPPLIER_SESSION_BATCH_FILE（每行一枚会话）');
}
if (batchFile === undefined && sessionFile === undefined && sessionInline === undefined) {
  fail(
    2,
    '缺少 SUPPLIER_SESSION_BATCH_FILE（批量）或 SUPPLIER_SESSION_FILE / SUPPLIER_SESSION（单个）',
  );
}

// 先把文件读进内存，再开库：读不到文件时不要留下一个已打开的连接。
const batchText = batchFile === undefined ? undefined : readLocalFile(batchFile);
let singleSession = sessionInline ?? '';
if (batchText === undefined && sessionFile !== undefined) {
  singleSession = readLocalFile(sessionFile);
}

const masterKey = parseMasterKey(masterKeyRaw);
const db = openDatabase({ path: dbPath });

async function run(): Promise<void> {
  try {
    const shared = {
      tfUser: env('SUPPLIER_TF_USER') ?? null,
      username: env('SUPPLIER_USERNAME') ?? null,
      uid: env('SUPPLIER_UID') ?? null,
      excluded: parseExcludedIdentifiers(process.env),
      sessionExpiresAt: env('SUPPLIER_SESSION_EXPIRES_AT') ?? null,
    };

    if (cookieOnly) {
      // 身份由上游 /api/me 解析；SUPPLIER_USERNAME / UID 不参与（上游才是权威）。
      const result = await importSupplierSessionCookies(db, masterKey, {
        upstreamId,
        text: batchText ?? '',
        tfUser: shared.tfUser,
        excluded: shared.excluded,
        sessionExpiresAt: shared.sessionExpiresAt,
      });
      if (!result.ok) {
        fail(1, result.message);
      }

      const { outcomes, problems, summary } = result.report;
      for (const outcome of outcomes) {
        const who = outcome.identifier ?? '（未写入）';
        console.log(
          outcome.ok
            ? `第 ${outcome.line} 行 ${who}：${outcome.message}（${outcome.accountId ?? '-'}）`
            : `第 ${outcome.line} 行 ${who}：导入失败 —— ${outcome.message}`,
        );
      }
      for (const problem of problems) {
        console.log(`第 ${problem.line} 行：跳过 —— ${problem.message}`);
      }
      console.log(
        `cookie-only 导入完成：共 ${summary.total} 行，新建 ${summary.created}、` +
          `覆写 ${summary.updated}、失败 ${summary.failed}；另有 ${summary.problems} 行未解析。`,
      );
      console.log(
        '下一步：在管理面执行一次「刷新」（状态目前是 unknown，刷新后转 active 并更新余额）。',
      );

      if (summary.failed > 0 || summary.problems > 0) process.exitCode = 1;
      return;
    }

  if (batchText !== undefined) {
    const report = importSupplierSessionBatch(db, masterKey, {
      upstreamId,
      text: batchText,
      ...shared,
    });

    for (const outcome of report.outcomes) {
      const who = outcome.identifier ?? '（未写入）';
      console.log(
        outcome.ok
          ? `第 ${outcome.line} 行 ${who}：${outcome.message}（${outcome.accountId ?? '-'}）`
          : `第 ${outcome.line} 行 ${who}：导入失败 —— ${outcome.message}`,
      );
    }
    for (const problem of report.problems) {
      console.log(`第 ${problem.line} 行：跳过 —— ${problem.message}`);
    }

    const { total, created, updated, failed, problems } = report.summary;
    console.log(
      `批量导入完成：共 ${total} 行，新建 ${created}、覆写 ${updated}、失败 ${failed}；` +
        `另有 ${problems} 行未解析。`,
    );
    console.log('下一步：在管理面执行一次「刷新」验活（导入本身不发任何上游请求）。');

    if (failed > 0 || problems > 0) process.exitCode = 1;
  } else {
    const identifier = env('SUPPLIER_IDENTIFIER');
    if (identifier === undefined) {
      fail(2, '缺少 SUPPLIER_IDENTIFIER（手机号 / 邮箱真值，只用于算掩码与摘要）');
    }

    // 整段 Cookie / `name=value` / 结尾换行都容忍：只取 value（同批量模式）。
    const session = normalizeSessionValue(singleSession);

    const result = importSupplierSession(db, masterKey, {
      upstreamId,
      identifier,
      session,
      ...shared,
    });

    if (!result.ok) {
      fail(1, result.message);
    }
    console.log(
      `会话已写入：账号 ${result.identifier}（${result.accountId}，${result.created ? '新建' : '覆写既有行'}）`,
    );
    console.log('下一步：在管理面执行一次「刷新」验活（导入本身不发任何上游请求）。');
  }
  } finally {
    db.close();
  }
}

void run();
