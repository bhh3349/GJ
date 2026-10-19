// §15.2 六个"要打上游"的端点共用的实现（契约 §15.2–§15.9）。
//
// ## 为什么这六个挤在一个文件里
//
// 它们共用同一批零件：同一把 HTTP 缝、同一个账号级队列（0.6s / 并发 4）、同一套
// 被动重登策略（`callWithRelogin`）、同一种逐行结果累加。拆成六个文件的结果是
// 六份"看起来一样但有一处不一样"的队列与擦除代码 —— 而不一样的那一处不会报错，
// 只会让某一个端点的礼貌间隔或擦除范围与其余五个不同。
//
// ## 四条贯穿全文件的纪律
//
// 1. **凭据只进不出**。明文密码 / 会话只在函数栈内存在；`statusMessage`、任务 result、
//    审计 detail 里的每一个字符串都先过 `scrubCredentials`。§15.9 纪律 4 更硬一条：
//    `session` **绝不去** `upstream_keys`、**绝不进**网关的 `SecretResolver` ——
//    本文件只往 `supplier_accounts.encrypted_session` 写它。
// 2. **失败不抛异常，落进逐行结果**。批量里一个账号失败不该让其余账号的结果一起丢
//    （§15.3 逐行）。唯一会抛的是**请求本身有问题**（上游不是 tierflow、账号不存在、
//    `count` 越界、`ids` 跨上游），那些在任务开始**之前**就该 4xx。
// 3. **不猜**。上游没给的字段一律 `null`（不是 0、不是空串），拿不准的匹配不做
//    （`KEY_MASK_AMBIGUOUS`），读不懂的值不落库。这条与 §15 全节的取向一致。
// 4. **一次活里每号只重登一次**（§15.9「每号一次」）。一个账号一轮活会连发好几次请求
//    （refresh 两次、建 key 每把一次），若每处都让 `callWithRelogin` 自行决定，一轮下来
//    能登好几回 —— 而"连续重登"正是供应商风控最容易抓的形状。`createReloginBudget`
//    把额度做成一个显式对象，用掉之后凭据里的密码就没了，不需要第二处判断。
//
// ## 待实测面
//
// 本文件里凡标「待实测」的，都是 §16.1.1 登记的形状（登录请求体、凭据怎么带、
// 建 key 请求体、套餐专属 key 端点）。它们被刻意收在 `supplier/tierflow.ts` 的
// 三个 `pending*` 函数里，**这里一行都不额外容错** —— 容错留两处就会漂。

import { sanitizeUpstreamBody } from '../../balance/raw.js';
import type { Db } from '../../db/database.js';
import { newId } from '../../db/ids.js';
import { createKey, deleteKey } from '../../db/repo/keys.js';
import {
  backfillSubscriptionTokenPlan,
  createSupplierAccount,
  findSupplierAccountByIdentifierHash,
  latestSubscriptionSubNo,
  linkSupplierAccountKey,
  listLinkedPooledKeyMasks,
  listSupplierAccountRefs,
  readSupplierCredential,
  replaceSupplierAccountKeyLedger,
  replaceSupplierSubscriptions,
  requireSupplierAccount,
  upsertSupplierSubscription,
  updateSupplierAccount,
  upstreamSupplier,
  type SupplierAccountKeyWrite,
  type SupplierAccountRef,
  type SupplierCredential,
  type SupplierSubscriptionBackfill,
  type SupplierSubscriptionWrite,
  type UpdateSupplierAccountInput,
} from '../../db/repo/supplier-accounts.js';
import { encodePasswordBlob, encodeSessionBlob, scrubCredentials } from '../../supplier/credentials.js';
import { excludedHashSet, isExcludedHash, parseExcludedIdentifiers } from '../../supplier/identifiers.js';
import { LINE_PARSE_FAILED, parseAccountText, type LineProblem, type ParsedImportRow } from '../../supplier/import-text.js';
import { createAccountQueue, type AccountQueue } from '../../supplier/pacing.js';
import {
  importSupplierSessionCookies,
  parseCookieOnlyText,
} from '../../supplier/session-import-cookie.js';
import { mapSubscription } from '../../supplier/subscriptions.js';
import { createTokenrhythmClient } from '../../supplier/tokenrhythm.js';
import {
  callWithRelogin,
  createTierFlowClient,
  DEFAULT_QUOTA_PER_UNIT,
  maskFromUpstream,
  maskTail,
  TIERFLOW_PATHS,
  type AccountCredential,
  type TierFlowClient,
  type TierFlowFailure,
} from '../../supplier/tierflow.js';
import type {
  SupplierAccountDto,
  SupplierBatchAction,
  SupplierBatchItem,
  SupplierBatchResult,
  SupplierTestResult,
  TaskDto,
} from '../dto.js';
import { ApiError } from '../errors.js';
import { startTask } from '../task-runner.js';
import { REFRESH_CONCURRENCY } from './balance-refresh.js';

/**
 * `items` 的上限（§15.3）。超出时保留前 500 行 + `truncated: true`，
 * 三个计数仍是全量 —— 前端据此显示"逐行明细已截断"，而不是"只处理了 500 个"。
 */
export const MAX_BATCH_ITEMS = 500;

/**
 * 会话有效期的**估计值**（§15.9：「本次为约 30 天」）。
 *
 * 它是估计、不是保证 —— 真实失效由"下次请求返回 401"来证实，证实即落 `session_expired`。
 * 这一列的唯一用途是让前端提示"该重登了"，所以一个偏保守的估计比一个精确但会过期的
 * 承诺更合适。写成常量是为了让"要不要改成 7 天"这件事有一个唯一的落点。
 */
const SESSION_TTL_DAYS = 30;

/** §15.2 `keys`：`count` 每账号建几把，`1..10`，超出 → `400 INVALID_PARAM`。 */
const KEY_COUNT_MIN = 1;
const KEY_COUNT_MAX = 10;

/** `keys` 端点里一句话解释不了的情形（不进 `ERROR_CODES`，同 `KEY_MASK_AMBIGUOUS` —— §15.4）。 */
export const KEY_PLAINTEXT_MISSING = 'KEY_PLAINTEXT_MISSING';
/** 命中排除名单、**已跳过并计入 `skipped`**（写死成常量，因为它是纪律不是实现细节）。 */
export const EXCLUDED_IDENTIFIER = 'EXCLUDED_IDENTIFIER';
/** 后 4 位撞号（§15.2 `keys/sync`）—— 与 `tierflow.ts` 的 `maskTail` 判据同源。 */
export const KEY_MASK_AMBIGUOUS = 'KEY_MASK_AMBIGUOUS';

/** 能直接拿去发请求的会话（`AccountCredential` 里那一对的非空形态）。 */
type SessionCred = { session: string; tfUser: string | null };

// ---------------------------------------------------------------------------
// 上下文与注入缝
// ---------------------------------------------------------------------------

/**
 * 六个端点共同的外部依赖。
 *
 * `fetchImpl` / `pacing` 是**注入**的而不是模块级默认值：测试注入假 fetch ⇒ 全部用例
 * 离线跑、零网络、零 0.6s 等待（§15.5 的间隔在测试里只会让每个用例慢四秒）。
 * 线上由 `buildApp` 填默认值，业务代码看不见这层。
 */
export interface SupplierOps {
  db: Db;
  masterKey: Buffer;
  fetchImpl: typeof fetch;
  /** 排除名单的**真值**形态（`parseExcludedIdentifiers` 的产物）；内部转成摘要比对。 */
  excluded: ReadonlySet<string>;
  /** 账号级队列的节奏。测试注入 `gapMs: 0` 与同步 sleep。 */
  pacing?: {
    gapMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  };
  /** 取"现在"。唯一用途是 `session_expires_at` 与 `balance_updated_at` 两个时间戳。 */
  now?: () => Date;
}

/**
 * 装配层唯一看得见的那几个字段（= `SupplierOps` 去掉库与主密钥）。
 *
 * 与 `SupplierOps` 分开写而不是 `Omit<…>`：除 `fetchImpl` 外都可省，省略时各有各的默认
 * （排除名单读运行时环境、节奏用 §15.5 的 0.6s），而 `SupplierOps`
 * 里它们**必须有值** —— 默认值的填充只发生在 `buildApp` 一处，业务代码永远拿到填好的。
 * `fetchImpl` 不在这张"可省"名单里（ADR-0021 决策 4c）：它是出站唯一出口，
 * 缺省只能由装配根给，且给了就是**有值**，没有第二处兜底。
 */
export interface SupplierSeams {
  /**
   * 出站 fetch。**必填、无兜底**（ADR-0021 决策 4c「8 处 fetchImpl 兜底全拆」）。
   *
   * 默认值**不在这里**：`buildApp` 一处解析（`opts.supplier?.fetchImpl ?? fetch`），
   * 与 `resolveEgressGate` 同一条纪律 —— 业务代码拿到的永远是有值的 `SupplierOps.fetchImpl`。
   */
  fetchImpl: typeof fetch;
  excluded?: ReadonlySet<string>;
  pacing?: SupplierOps['pacing'];
  now?: () => Date;
}

/**
 * 拿缝 + 库 + 主密钥拼出一个能用的 `SupplierOps`。路由层每请求调一次。
 *
 * `excluded` 的兜底是**再读一次环境**而不是空集合：空集合的语义是"这一次没人给出排除项"，
 * 拿它当"接线的人忘了传"的兜底，会把一条**硬约束**静默降级成"没有约束" ——
 * 而这条约束防的是拿真实账号去撞供应商风控。兜底成 `parseExcludedIdentifiers()`
 * 则最坏情况只是重复读一次环境变量。
 */
export function supplierOps(db: Db, masterKey: Buffer, seams: SupplierSeams): SupplierOps {
  return {
    db,
    masterKey,
    fetchImpl: seams.fetchImpl,
    excluded: seams.excluded ?? parseExcludedIdentifiers(),
    pacing: seams.pacing,
    now: seams.now,
  };
}

/**
 * 批量端点收尾时的回带（路由用它写审计 —— 参见 `http.ts` 的 `captureAuditActor`）。
 *
 * **必须整支透传给 `startTask` 的第 5 参**（`models.ts` 的 `model_sync` 就是那样写的），
 * 不许在 `work()` 里手调 —— 手调的后果是审计抛错会把一个**已经跑完**的批量倒置成
 * failed、result 一起丢（审计项 E：`appendAudit` 是裸的 `.run()`，DB 忙 / FK 一炸就抛）。
 * 第 5 参在终态落库**之后**调用，抛错影响不到任务本身。
 */
export interface BatchHooks {
  onFinish?: (result: SupplierBatchResult | null, failed: boolean) => void;
}

function now(ctx: SupplierOps): Date {
  return ctx.now === undefined ? new Date() : ctx.now();
}

function sessionExpiry(ctx: SupplierOps): string {
  return new Date(now(ctx).getTime() + SESSION_TTL_DAYS * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 读一个必填字符串。空串 / 非字符串都算缺失 —— 空串在这里永远不是合法值。 */
function requiredString(body: unknown, field: string): string {
  const value = asRecord(body)?.[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.invalidParam(field, `${field} 不能为空`);
  }
  return value.trim();
}

/** §15 / §15.14 在册的供应商能力位。`null` 是通用上游，不在这张能力表上。 */
const SUPPLIER_KINDS = ['tierflow', 'tokenrhythm'] as const;
type SupplierKind = (typeof SUPPLIER_KINDS)[number];

function isSupplierKind(value: string | null): value is SupplierKind {
  return value === 'tierflow' || value === 'tokenrhythm';
}

/**
 * §15.14.1 能力表「密码登录」：这家**有没有**"用账号密码换一枚会话"这条路。
 *
 * TokenRhythm **没有** —— 站点对 `/api/*` 只有会话鉴权（`tr_session`），`/api/auth/login`
 * 那个路径对任何账号密码一律 401（v1.16.1 订正；真登录走 `/api/auth/login-or-register`
 * 的验证码流程，网关不代做）。所以这家**只能**走 §15.9 的会话型凭据。
 *
 * 这张位决定的不是"画不画一个按钮"，而是**整个导入端点收不收**：文本导入的每一行
 * 都以"用密码登一次"为前提，对一家没有密码登录的供应商，那个前提整条不成立
 * （不是"某些行会失败"，是"一行都不可能成"）。
 *
 * 写成表而不是几个 `=== 'tokenrhythm'`：第三家接入时，"这家能不能密码登录"要有
 * **一个**落点，而不是散在导入 / 重登 / 刷新三处各判一次（那三处漂了不会报错）。
 */
const SUPPLIER_PASSWORD_LOGIN: Record<SupplierKind, boolean> = {
  tierflow: true,
  tokenrhythm: false,
};

function supplierSupportsPasswordLogin(supplier: SupplierKind): boolean {
  return SUPPLIER_PASSWORD_LOGIN[supplier];
}

/**
 * 上游必须存在且 `supplier` 是 §15 在册的账号型供应商（§15.2 `import` 明写，其余五个同理）。
 *
 * 用 `422 UNPROCESSABLE` 而不是 400：请求本身完全合法，是**这个上游**不适合做这件事
 * （§15.4 把 UNPROCESSABLE 的触发写成"上游不是账号型 / 无可用账号"）。
 *
 * 返回值带上 `supplier`：调用方拿它选驱动器（`clientFor`）与判能力差异
 * （`keys` 端点对 TokenRhythm 拒收额度/白名单，§15.14）。
 */
function requireSupplierUpstream(db: Db, upstreamId: string): { baseUrl: string; supplier: SupplierKind } {
  const up = upstreamSupplier(db, upstreamId);
  if (up === null) throw ApiError.notFound('上游', upstreamId);
  if (!isSupplierKind(up.supplier)) {
    throw new ApiError(
      'UNPROCESSABLE',
      '该上游不是供应商账号型（supplier 必须是 "tierflow" 或 "tokenrhythm"），无法执行管理面操作',
    );
  }
  return { baseUrl: up.baseUrl, supplier: up.supplier };
}

/**
 * 按上游的能力位选驱动器。两家驱动器**结构上实现同一个 `TierFlowClient`** ——
 * 六个批量端点、被动重登、账号级节奏对两者都原样工作；差异全在驱动器内部
 * 的具名操作里（TokenRhythm 的能力表见 `supplier/tokenrhythm.ts` 文件头 / §15.14）。
 */
function clientFor(ctx: SupplierOps, baseUrl: string, supplier: SupplierKind): TierFlowClient {
  const options = { baseUrl, fetchImpl: ctx.fetchImpl };
  return supplier === 'tokenrhythm' ? createTokenrhythmClient(options) : createTierFlowClient(options);
}

function accountCredential(cred: SupplierCredential): AccountCredential {
  return {
    identifier: cred.identifier,
    password: cred.password,
    session: cred.session,
    tfUser: cred.tfUser,
  };
}

/** 库里那一对列 → 可用会话。`session` 为 `null` 时整对无意义（`tfUser` 单独存在没有用）。 */
function sessionOf(cred: { session: string | null; tfUser: string | null }): SessionCred | null {
  return cred.session === null ? null : { session: cred.session, tfUser: cred.tfUser };
}

/** 一次成功请求之后手上必然有的会话：重登成功就是新的那个，否则是这次用的那个。 */
function sessionAfter(renewed: SessionCred | null, used: SessionCred): SessionCred {
  return renewed ?? used;
}

/**
 * 一个账号在一轮活里的重登额度（§15.9「每号一次」）。
 *
 * 额度用掉之后把 `password` 抹成 `null` 再交给 `callWithRelogin` —— 它自己的逻辑就是
 * "没有密码就不发那次注定 401 的请求、也不重登"，于是额度这件事**只有一个落点**，
 * 不必在几个端点里各写一个 `if (relogged) skip`。
 */
function createReloginBudget(cred: SupplierCredential): {
  credential: (session: SessionCred) => AccountCredential;
  note: (relogged: boolean) => void;
} {
  let spent = false;
  return {
    credential(session: SessionCred): AccountCredential {
      const base = accountCredential(cred);
      return {
        ...base,
        session: session.session,
        tfUser: session.tfUser,
        password: spent ? null : base.password,
      };
    },
    note(relogged: boolean): void {
      if (relogged) spent = true;
    },
  };
}

/**
 * 上游失败 → `items[].code`。
 *
 * `rejected` / `http_error` 刻意给 `null`：那两类里说话的是**上游自己**，
 * 它的话在 `message` 里（§15.4：`LOGIN_INVALID_CREDENTIALS` 一类供应商错误码
 * **不进** `ERROR_CODES`，只出现在 `items[].code` 与 `statusMessage`）。
 * 我们这一侧没有额外信息可加，编一个我们自己的码只会把它的话盖掉。
 */
function codeForFailure(failure: TierFlowFailure): string | null {
  switch (failure) {
    case 'unreachable':
    case 'timeout':
      return 'UPSTREAM_UNREACHABLE';
    case 'session_expired':
      return 'SESSION_EXPIRED';
    case 'rejected':
    case 'http_error':
      return null;
  }
}

/**
 * 过滤上游给回来的一句话。
 *
 * 上游的报错体里会带凭据（"invalid session xxx"），也可能带着我们提交过去的手机号 ——
 * 而 `identifier` 真值按 §15.9 是**不出后端**的东西。所以凡是要落进 `statusMessage`
 * 或逐行 `message` 的字符串，一律先过这里。
 */
function safeMessage(
  message: string,
  cred: Pick<SupplierCredential, 'password' | 'session' | 'identifier'>,
): string {
  return scrubCredentials(message, [cred.password, cred.session, cred.identifier]);
}

/**
 * `raw` 的多凭据净化。
 *
 * `sanitizeUpstreamBody` 一次只吃一个明文，而一个账号有**三条**可能被上游回显的串
 * （密码 / 会话 / 真值标识符），重登过的话会话还不止一条。折着调用是安全的：
 * 截断是按字符预算做的，后一轮拿到的是前一轮已被压到预算内的值，结果不会越滚越大。
 *
 * 空值一律跳过 —— `scrubCredentials` 的纪律是"空串不是秘密"，拿它去比会把每一处
 * 都替换成掩码。
 */
function scrubRaw(raw: unknown, secrets: readonly (string | null | undefined)[]): unknown {
  let out: unknown = raw === undefined ? null : raw;
  for (const secret of secrets) {
    if (secret === null || secret === undefined || secret === '') continue;
    out = sanitizeUpstreamBody(out, secret);
  }
  return out;
}

/** 掩码标识符的后 4 位（上游侧 key 名用；掩码不足 4 位时整串）。 */
function tailOfMasked(masked: string): string {
  return masked.length <= 4 ? masked : masked.slice(-4);
}

/**
 * 上游 `token_no` → DTO 的 `number`。
 *
 * 驱动器返回的是**字符串**（上游有时给数字、有时给串，统一收成串），而契约 §15.3 的
 * 样例写的是 `"tokenNo": 1187`（number）。整串解析得出来才转 —— `Number('1187a')`
 * 是 NaN，不能拿它当"编号"。转不出来就 `null`：编号是回查用的内部标识，
 * 给一个 `NaN` 会让前端渲染出 "NaN"。
 */
function toTokenNo(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// 批量结果累加（§15.3）
// ---------------------------------------------------------------------------

function emptyItem(
  partial: Partial<SupplierBatchItem> &
    Pick<SupplierBatchItem, 'accountId' | 'identifier' | 'action' | 'ok'>,
): SupplierBatchItem {
  return {
    code: null,
    message: null,
    keyId: null,
    keyMasked: null,
    tokenNo: null,
    ...partial,
  };
}

/**
 * 逐行结果的累加器。
 *
 * 行按**输入次序**排（`index`），不按完成次序 —— 并发 4 之下完成次序是随机的，
 * 而读结果的人是在对着一份名单核对"第 7 行怎么了"。随机次序会让每一份 result
 * 长得都不一样，且"哪一行还没出现"这件事失去意义。
 */
class BatchTally {
  private readonly slots: (SupplierBatchItem | null)[];
  private doneCount = 0;
  private okCount = 0;
  private failedCount = 0;
  private skippedCount = 0;
  /** 出现过的失败码，只用于收尾选 hint（§15.3 `hintCode`）。 */
  private readonly failureCodes = new Set<string>();

  constructor(readonly total: number) {
    this.slots = new Array<SupplierBatchItem | null>(total).fill(null);
  }

  /**
   * `skipped` 的口径（§15.3 把四个计数写出来了但**没有定义 `skipped`**，这里是取它的读法）：
   * **没做过的行**。解析不了的行（§15.2 `import`：「解析失败的行跳过并逐行报原因」）
   * 与命中排除名单的行（§15.9：命中即跳过、跳过要计数）都归这里；
   * `failed` 则是**做过但不成的行**。于是 `ok + failed + skipped = total` 恒成立 ——
   * 这是操作员唯一能拿来核对的等式，四个计数必须自洽。
   */
  put(index: number, item: SupplierBatchItem): void {
    if (index < 0 || index >= this.slots.length) return;
    this.slots[index] = item;
    this.doneCount += 1;
    if (item.ok) this.okCount += 1;
    else if (item.code === EXCLUDED_IDENTIFIER || item.code === LINE_PARSE_FAILED) this.skippedCount += 1;
    else this.failedCount += 1;
    if (!item.ok && item.code !== null) this.failureCodes.add(item.code);
  }

  build(): SupplierBatchResult {
    // 槽位不该有空洞（每一行都会走到 put），但真出现时宁可在 items 里少一行，
    // 也不要把 `null` 塞进 DTO（那会变成前端 map 时的一个 TypeError）。
    const items = this.slots.filter((item): item is SupplierBatchItem => item !== null);
    const itemsTotal = items.length;
    const hintCode = this.pickHint();
    return {
      done: this.doneCount,
      total: this.total,
      ok: this.okCount,
      failed: this.failedCount,
      skipped: this.skippedCount,
      itemsTotal,
      truncated: itemsTotal > MAX_BATCH_ITEMS,
      items: items.slice(0, MAX_BATCH_ITEMS),
      hintCode,
      hint: hintCode === null ? null : UPSTREAM_UNREACHABLE_HINT,
    };
  }

  /**
   * 只给"上游不可达"这一档出 hint。
   *
   * `BALANCE_AUTH_REJECTED` 的文案写的是"这把 key"，套到账号会话失效上会指错对象 ——
   * `HintCode` 现有成员里没有为账号面写过的那一个，所以这一档**不出 hint**，
   * 原因留在逐行 `message` 里（那里能说清是密码错还是会话过期）。
   */
  private pickHint(): SupplierBatchResult['hintCode'] {
    return this.failureCodes.has('UPSTREAM_UNREACHABLE') ? 'BALANCE_UPSTREAM_UNREACHABLE' : null;
  }
}

/**
 * "上游不可达"那一档的 hint（§15.3 `hintCode` 的**唯一生产者**）。
 *
 * 写成单个常量而不是 `Record<HintCode, string>` 表：`HintCode` 现有成员里
 * 只有这一个能用在账号面上。`BALANCE_AUTH_REJECTED` 的文案写的是"这把 key"，
 * 套到账号会话失效上会指错对象；把它和本常量并排摆在一张表里，等于邀请下一个人
 * 顺手把那一档也接上 —— 而接上的那一刻错的是**文案里的对象**，不会报错。
 */
const UPSTREAM_UNREACHABLE_HINT =
  '上游不可达、超时或返回了错误状态。这多半是暂时的，稍后重试即可，不必改配置。';

// ---------------------------------------------------------------------------
// 账号级：登录 / 刷新（被 import / refresh / login 共用）
// ---------------------------------------------------------------------------

/** 把重登换来的新会话落库（§15.9「覆写 `session_cipher`」）。 */
function persistRenewed(ctx: SupplierOps, accountId: string, renewed: SessionCred | null): void {
  if (renewed === null) return;
  updateSupplierAccount(ctx.db, accountId, {
    encryptedSession: encodeSessionBlob(renewed.session, renewed.tfUser, ctx.masterKey),
    sessionExpiresAt: sessionExpiry(ctx),
  });
}

/**
 * 把 `/api/user/self` 读到的站点换算比落库（审计项 D 的"记住"那一半）。
 *
 * ## 为什么建 key 需要它、又不能为它多发一次请求
 *
 * `createToken` 在 `unlimited:false` 时要把 `quotaCents` 换算成上游的 `remain_quota`
 * （`分 → quota`，`src/supplier/tierflow.ts` 的 `centsToQuota`）。比值写死 500000
 * 的那一版在站点改了比值时**成比例地错**，且不报错：站点实际 250000/元、我们要 1000 分，
 * 发出去的会是 5000000 quota（= 20 元）而不是 2500000（= 10 元）—— 凭空多一倍额度。
 *
 * 拿现成比值的两条路都不通：**建 key = 2 次请求**是 §15.5 表里钉死的（创建 + 回查
 * `token_no`），加一发 `/api/user/self` 就是 3 次，那条预算动不得；而 `refresh` /
 * `keys/sync` / 自测三条腿**已经在打** `/api/user/self` 了 —— 比值是顺手拿到的，
 * 只是拿到就扔。所以正确形状是**顺手记下来**，让建 key 那条腿不必再问一次。
 *
 * ## 只在真读到时写
 *
 * 同 `balance_updated_at` 的纪律（§14.2）：查失败**不动**这两列。写 NULL 会把上一次
 * 真值抹成"没读过"，而两者在建 key 时都表现为"用默认值" —— 一次网络抖动就白丢一次
 * 真值，且没有任何东西会提示这件事发生了。
 *
 * ## 为什么不在 `refreshOne` 里多包一层
 *
 * 那里已经有一条 `selfCall`，比值就在 `selfCall.result.data.quotaPerUnit` 上，
 * 与余额**同一次请求**拿到。单独一个函数而不是塞进 `persistRenewed`：后者管的是会话，
 * 这件事管的是比例，混在一起会让"这两列什么时候被写"变得要读代码才知道。
 */
function persistQuotaPerUnit(ctx: SupplierOps, accountId: string, quotaPerUnit: number): void {
  updateSupplierAccount(ctx.db, accountId, {
    quotaPerUnit,
    quotaReadAt: now(ctx).toISOString(),
  });
}

/**
 * 失败该写什么状态。
 *
 * **只有 401/403 才动 `status`，其余只写 `statusMessage`。** 理由：`status` 是一列
 * 给人看的结论，而一次网络抖动改不出结论 —— 把它从 `active` 改成别的，操作员会去查
 * 一个不存在的问题。`session_expired` 那一档再分两路：有密码却还是 401，意味着
 * **重登也失败了**（`callWithRelogin` 只在重登失败后才回这个），那按 `login_failed`
 * 记，操作员知道该去查密码；只有会话的账号本来就无从重登，记 `session_expired`
 * （§15.2：无存档密码的账号不重登，直接计 failed 并置 `session_expired`）。
 */
function failurePatch(
  result: { failure: TierFlowFailure; message: string },
  cred: SupplierCredential,
): UpdateSupplierAccountInput {
  const message = safeMessage(result.message, cred);
  if (result.failure !== 'session_expired') return { statusMessage: message };
  return {
    status: cred.password !== null ? 'login_failed' : 'session_expired',
    statusMessage: message,
  };
}

interface AccountOutcome {
  ok: boolean;
  relogged: boolean;
  code: string | null;
  message: string | null;
}

/**
 * 用存档密码登一次（§15.5：**每号一次，不重试**）。
 *
 * 与 `callWithRelogin` 分开是因为它解决的不是同一个问题：那边是"会话过了，续一下"，
 * 这边是"要么没有会话、要么操作员手工要求重来一次"。共同点是都只登一次、都不循环。
 *
 * **先验活、别急着换会话**：手里已有会话时先打一发 `/api/user/self` —— 它既是 §15.9 自己用的
 * 同款探针（`refresh` 首发即它），也是这个端点唯一需要回答的问题"当前会话还活着吗"。活着就
 * 不再用密码换一枚新的：一次登录 = 一次密码往返，是站点风控最该被珍惜的东西（"每号一次"）。
 * 没有会话时**一发探针都不发**，直接登录。两条路都不新增任何请求次数 —— 省下的那发登录
 * 正好抵掉多出来的那发探针。
 */
async function loginAccount(
  ctx: SupplierOps,
  client: TierFlowClient,
  cred: SupplierCredential,
): Promise<AccountOutcome> {
  if (cred.password === null || cred.identifier === '') {
    // 会话型账号无从重登（§15.9 已知代价）。**不发那次注定 401 的请求** ——
    // `credentialSource` 这个字段存在的意义正是在发请求之前就有答案。
    const message = '该账号只有会话、没有存档密码，无从重登';
    updateSupplierAccount(ctx.db, cred.id, { status: 'session_expired', statusMessage: message });
    return { ok: false, relogged: false, code: 'SESSION_EXPIRED', message };
  }

  // 会话在手 → 先验活。活着就是"已登录"，不再换一枚新会话（零密码往返）。
  const existing = sessionOf(cred);
  if (existing !== null) {
    const probe = await client.self(existing);
    if (probe.ok) {
      updateSupplierAccount(ctx.db, cred.id, { status: 'active', statusMessage: null });
      // 顺手记下站点换算比（审计项 D）：这一发探针本来就是 `/api/user/self`，
      // 比值已经在 `probe.data.quotaPerUnit` 上，记下来不花任何请求。
      persistQuotaPerUnit(ctx, cred.id, probe.data.quotaPerUnit);
      return { ok: true, relogged: false, code: null, message: null };
    }
    // 非"会话失效"的失败（网络抖动 / 上游 5xx）**不当作换会话的理由**：照旧往下走登录 ——
    // 登录是修账号 / 拿会话的动作，不该因为一发探针抖了就整行失败。
  }

  const res = await client.login(cred.identifier, cred.password);
  if (!res.ok) {
    const message = safeMessage(res.message, cred);
    // 登录失败 = 密码或账号不对。落 `login_failed` 而不是 `session_expired`：
    // 两者对操作员的下一步动作完全不同（改密码 vs 等一等再试）。
    updateSupplierAccount(ctx.db, cred.id, { status: 'login_failed', statusMessage: message });
    return { ok: false, relogged: false, code: codeForFailure(res.failure), message };
  }

  const patch: UpdateSupplierAccountInput = {
    encryptedSession: encodeSessionBlob(res.data.session, res.data.tfUser, ctx.masterKey),
    sessionExpiresAt: sessionExpiry(ctx),
    status: 'active',
    statusMessage: null,
  };
  if (res.data.username !== null) patch.username = res.data.username;
  if (res.data.uid !== null) patch.uid = res.data.uid;
  updateSupplierAccount(ctx.db, cred.id, patch);
  return { ok: true, relogged: false, code: null, message: null };
}

/**
 * 刷一个账号：`/api/user/self` + `/api/subscription/self`（§15.5 表：刷新 = 2 次请求）。
 *
 * **两条腿都成功才算这一行成功**。部分成功时**已经拿到的数据照常落库** ——
 * 拿到了余额却因为套餐接口抖了一下就丢掉，等于让一次抖动毁掉一次已经完成的查询。
 * 落库与"这一行算不算成功"是两件事，这里把它们分开。
 *
 * 余额按 §14.2 的口径：**只有真查到（或有确定结论）才写那几列**。具体地 ——
 * 上游说 `unlimited` 时 `balanceCents` 为 `null` 但那是**确定结论**（"没有有限余额"），
 * 连同 `balanceUpdatedAt` 一起写；上游既没给数又不是无限时，一个字都不写
 * （写 `NULL` 会把上一次查到的真实余额抹成"未知"，而它们在前端长得一样）。
 */
async function refreshAccount(
  ctx: SupplierOps,
  client: TierFlowClient,
  cred: SupplierCredential,
): Promise<AccountOutcome> {
  let active = cred;
  let relogged = false;

  // 会话那一列为空（库里只有密码，或上一轮登录没换成会话）。`callWithRelogin` 在这种
  // 情形下**不发请求就判 `session_expired`** —— 它守的是"没有会话就别打上游"，而这里
  // 手里有密码，那是一次正常登录、不是重登。少了这一步，`refresh` 在这种账号上
  // 永远修不回来（而 `refresh` 正是操作员用来修东西的那个端点）。
  if (sessionOf(active) === null) {
    const logged = await loginAccount(ctx, client, active);
    if (!logged.ok) {
      return { ok: false, relogged: false, code: logged.code, message: logged.message };
    }
    const reread = readSupplierCredential(ctx.db, active.id, ctx.masterKey);
    if (reread === null) {
      return {
        ok: false,
        relogged: true,
        code: 'INTERNAL',
        message: '账号已重登但凭据读不回来（多半是 MASTER_KEY 与写入时不一致）',
      };
    }
    active = reread;
    relogged = true;
  }

  const start = sessionOf(active);
  if (start === null) {
    // `loginAccount` 成功即写了会话，所以到不了这里。写成抛错而不是兜底一个空会话：
    // 哪天真到得了，炸在调用点比拿空串去打上游好定位。
    throw new Error('内部错误：登录成功后仍没有可用会话');
  }

  const budget = createReloginBudget(active);

  const selfCall = await callWithRelogin(client, budget.credential(start), (c) => client.self(c));
  persistRenewed(ctx, active.id, selfCall.renewed);
  budget.note(selfCall.relogged);
  relogged = relogged || selfCall.relogged;

  if (!selfCall.result.ok) {
    updateSupplierAccount(ctx.db, active.id, failurePatch(selfCall.result, active));
    return {
      ok: false,
      relogged,
      code: codeForFailure(selfCall.result.failure),
      message: safeMessage(selfCall.result.message, active),
    };
  }

  const self = selfCall.result.data;
  const patch: UpdateSupplierAccountInput = { status: 'active' };
  if (self.username !== null) patch.username = self.username;
  if (self.uid !== null) patch.uid = self.uid;
  if (self.balanceCents !== null || self.unlimited) {
    patch.balanceCents = self.balanceCents;
    patch.balanceCurrency = self.currency;
    patch.balanceUpdatedAt = now(ctx).toISOString();
  }
  // 换算比与余额**同一次请求**拿到（这一发 `/api/user/self` 两个数都回）。
  // 写进同一个 patch 而不是另发一次 `updateSupplierAccount`：那会让一次刷新
  // 对同一行写两条 UPDATE、`revision` 无谓跳两格（前端一次提交就撞 REVISION_MISMATCH）。
  patch.quotaPerUnit = self.quotaPerUnit;
  patch.quotaReadAt = now(ctx).toISOString();

  const subsCall = await callWithRelogin(client, budget.credential(sessionAfter(selfCall.renewed, start)), (c) =>
    client.subscriptions(c),
  );
  persistRenewed(ctx, active.id, subsCall.renewed);
  budget.note(subsCall.relogged);
  relogged = relogged || subsCall.relogged;

  if (!subsCall.result.ok) {
    // 余额已经拿到了，照写；只是这一行按失败报出去 —— 刷新承诺的是"余额 + 套餐"两样。
    patch.statusMessage = safeMessage(subsCall.result.message, active);
    updateSupplierAccount(ctx.db, active.id, patch);
    return {
      ok: false,
      relogged,
      code: codeForFailure(subsCall.result.failure),
      message: safeMessage(subsCall.result.message, active),
    };
  }

  replaceSupplierSubscriptions(ctx.db, active.id, mapSubscriptions(subsCall.result.data, self.quotaPerUnit));
  patch.statusMessage = null;
  updateSupplierAccount(ctx.db, active.id, patch);
  return { ok: true, relogged, code: null, message: null };
}

/**
 * 上游套餐行 → 库内写形态。
 *
 * `sub_no` 读不出的行**整行丢弃**（`mapSubscription` 返回 `null`）—— 它是套餐的唯一标识，
 * 没有它这一行既不能去重也不能更新（见 `supplier/subscriptions.ts` 文件头第 3 条）。
 */
function mapSubscriptions(rows: readonly unknown[], quotaPerUnit: number): SupplierSubscriptionWrite[] {
  const out: SupplierSubscriptionWrite[] = [];
  for (const row of rows) {
    const mapped = mapSubscription(row, quotaPerUnit);
    if (mapped !== null) out.push(mapped);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 目标集解析
// ---------------------------------------------------------------------------

function readIds(body: unknown): string[] | undefined {
  const raw = asRecord(body)?.['ids'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw ApiError.invalidParam('ids', 'ids 必须是字符串数组');
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || id.trim() === '') {
      throw ApiError.invalidParam('ids', 'ids 里每一项都必须是非空字符串');
    }
    out.push(id.trim());
  }
  return out;
}

/**
 * 批量端点选谁干活。
 *
 * `ids` 省略时按 `statusesWhenAll` 过滤，给了就**只认这些 id**（连状态都不看）：
 * 操作员明确点名一个 `session_expired` 的账号，目的正是把它救回来；
 * 再套一层"状态必须 active"会让那次点击静默变成"什么都没做"（见仓储层的长注释）。
 *
 * 代价是仓储层的 id 分支**不叠加 `upstreamId` 过滤**，于是点名的 id 可能属于**别的上游**。
 * 这在别处只是"多做一件多余的事"，在这里不行：地址是从 `upstreamId` 那条 baseUrl 取的，
 * 拿 A 上游账号的会话去请求 B 上游的域名就是**一次凭据外发**。所以归属必须在这里核对，
 * 且**对不上就整批拒** —— 部分接受等于部分外发。
 */
function resolveTargets(
  db: Db,
  upstreamId: string,
  ids: readonly string[] | undefined,
  statusesWhenAll: readonly string[] | undefined,
): SupplierAccountRef[] {
  const refs = listSupplierAccountRefs(db, {
    upstreamId,
    ids,
    statuses: ids === undefined ? statusesWhenAll : undefined,
  });

  if (ids !== undefined && refs.some((ref) => ref.upstreamId !== upstreamId)) {
    throw ApiError.invalidParam('ids', 'ids 里有不属于该上游的账号');
  }

  // 点名的 id 里若有不存在的（仓储层静默略过），**不报错** —— 契约 §15.2 只要求
  // "指定的账号都不存在"时 422；一批里少一两个通常是刚被删掉了。`total` 会随之变小，
  // 那是操作员该看见的事实，不是 bug。所以只有"一个都没剩"才拦：
  if (refs.length === 0) {
    throw new ApiError(
      'UNPROCESSABLE',
      ids === undefined ? '该上游下没有可处理的账号' : '指定的账号都不存在',
    );
  }
  return refs;
}

/** 队列的并发度**复用** `REFRESH_CONCURRENCY`（§15.5：不新拍一个数，避免两处漂成两个并发度）。 */
function accountQueue(ctx: SupplierOps): AccountQueue {
  return createAccountQueue({ concurrency: REFRESH_CONCURRENCY, ...ctx.pacing });
}

// ---------------------------------------------------------------------------
// 1) POST /api/supplier-accounts/import
// ---------------------------------------------------------------------------

/** 一行的处理单元。失败行与账号行**按行号合流**，读的人才能对着原文数行。 */
type ImportUnit =
  | { kind: 'problem'; index: number; line: number; problem: LineProblem }
  | { kind: 'account'; index: number; line: number; row: ParsedImportRow };

export function startSupplierImport(ctx: SupplierOps, body: unknown, hooks: BatchHooks = {}): TaskDto {
  const upstreamId = requiredString(body, 'upstreamId');
  const text = asRecord(body)?.['text'];
  if (typeof text !== 'string' || text.trim() === '') {
    throw ApiError.invalidParam('text', 'text 不能为空（每行「账号,密码」）');
  }
  const { baseUrl, supplier } = requireSupplierUpstream(ctx.db, upstreamId);
  // §15.14.1 能力表「密码登录」：TokenRhythm **没有**这条路（站点只有会话鉴权）。
  // 整个端点在入口 422，而不是让每一行各自 `login_failed` —— 20 行粘进来收 20 条
  // 「登录失败」，读者会去数哪行错了；而事实是**一行都不可能成**，该说的是这个。
  if (!supplierSupportsPasswordLogin(supplier)) {
    throw new ApiError(
      'UNPROCESSABLE',
      'TokenRhythm 只支持会话凭据（tr_session），没有账号密码登录，无法走文本导入（§15.14.1 能力表）。'
        + '账号入池请走 §15.9 的一次性离线会话导入',
    );
  }

  const parsed = parseAccountText(text);
  // 空行在解析器里就没进合计（见该函数注释），所以这里合起来的**都是真行**：
  // 能处理的账号 + 处理不了的问题行。`ok + failed + skipped = total` 由它们构成。
  const units: ImportUnit[] = [
    ...parsed.rows.map((row): ImportUnit => ({ kind: 'account', index: 0, line: row.line, row })),
    ...parsed.problems.map((problem): ImportUnit => ({ kind: 'problem', index: 0, line: problem.line, problem })),
  ].sort((a, b) => a.line - b.line);
  units.forEach((unit, i) => {
    unit.index = i;
  });

  return startTask(
    ctx.db,
    'supplier_import',
    units.length,
    async (reporter) => {
      const tally = new BatchTally(units.length);
      if (units.length === 0) {
        // 全是空行 / 只有一行表头。回一份**形状完整**的零结果，不是空对象。
        return tally.build();
      }

      const excluded = excludedHashSet(ctx.excluded);
      const queue = accountQueue(ctx);

      const running: Promise<void>[] = units.map((unit) => {
        if (unit.kind === 'problem') {
          // 解析不了的行**不打上游**，所以不占队列槽位 —— 27 行密码错不该让真正要干的活
          // 多等 0.6s × 27。它当场就有结论。
          tally.put(
            unit.index,
            emptyItem({
              accountId: null,
              identifier: null,
              action: null,
              ok: false,
              code: LINE_PARSE_FAILED,
              message: unit.problem.message,
            }),
          );
          reporter.step();
          return Promise.resolve();
        }
        return queue.run(async () => {
          tally.put(unit.index, await importOne(ctx, baseUrl, supplier, upstreamId, unit.row, excluded));
          reporter.step();
        });
      });

      await Promise.all(running);
      return tally.build();
    },
    hooks.onFinish,
  );
}

// ---------------------------------------------------------------------------
// 1b) POST /api/supplier-accounts/import-sessions（v1.16.4，TokenRhythm）
// ---------------------------------------------------------------------------

/** §15.9 cookie-only 的身份解析原因 → `items[].code`（供应商自己的话留在 message）。 */
function codeForSessionImportFailure(reason: string | null): string | null {
  switch (reason) {
    case 'upstream_unreachable':
      return 'UPSTREAM_UNREACHABLE';
    case 'session_expired':
      return 'SESSION_EXPIRED';
    default:
      // `upstream_rejected` / `envelope_invalid` / `identity_unavailable` / 落库失败：
      // 没有比 message 更准确的分类，编一个只会盖掉真正的原因。
      return null;
  }
}

/**
 * 把**粘贴进管理面**的 cookie 清单导入账号池（§15.9 v1.16.4）。
 *
 * 与 `startSupplierImport` 的关系：同一个批量任务/逐行结果形状，输入形态不同。
 * 这里不做登录 —— 会话本身就是凭据，因此 `action` 是新值 `import`（不是 `login`：
 * 一行都没有发生过登录）。每行仍要向上游 `GET /api/me` 问出 uid 与掩码。
 *
 * 入口闸（全部在任务开始前，避免"建了任务才发现一行都不能做"）：
 * - 供应商必须是 TokenRhythm（TierFlow 走「标识 + 会话」/「账号 + 密码」）；
 * - 排除名单必须为空（名单按真值匹配，而这里只有掩码，无法验证）。
 */
export function startSupplierSessionImport(
  ctx: SupplierOps,
  body: unknown,
  hooks: BatchHooks = {},
): TaskDto {
  const upstreamId = requiredString(body, 'upstreamId');
  const text = asRecord(body)?.['text'];
  if (typeof text !== 'string' || text.trim() === '') {
    throw ApiError.invalidParam('text', 'text 不能为空（每行一枚 tr_session）');
  }

  const { supplier } = requireSupplierUpstream(ctx.db, upstreamId);
  if (supplier !== 'tokenrhythm') {
    throw new ApiError(
      'UNPROCESSABLE',
      'Cookie 粘贴导入只支持 TokenRhythm（它没有密码登录）；其他供应商请用「账号,密码」导入',
    );
  }
  if (ctx.excluded.size > 0) {
    throw new ApiError(
      'UNPROCESSABLE',
      '排除名单非空时无法做 Cookie 导入：名单按真实手机号/邮箱匹配，而 Cookie 只能解析出掩码，'
        + '无法验证。请改用「账号,密码」导入，或清空排除名单后再试',
    );
  }

  // 先解析一次只为拿总行数（任务对象在创建时就要有 total）；导入函数内部会再解析，
  // 解析本身是纯内存操作，重复一次比把"已解析对象"塞进两个模块的接口更不容易漂。
  const parsed = parseCookieOnlyText(text);
  const total = parsed.rows.length + parsed.problems.length;
  if (total === 0) {
    throw ApiError.invalidParam('text', '没有可导入的 Cookie（空行、注释与表头不算）');
  }
  const units = [
    ...parsed.problems.map((problem) => ({ kind: 'problem' as const, line: problem.line })),
    ...parsed.rows.map((row) => ({ kind: 'row' as const, line: row.line })),
  ].sort((a, b) => a.line - b.line);
  const indexByLine = new Map(units.map((unit, index) => [unit.line, index]));

  return startTask(
    ctx.db,
    'supplier_import_sessions',
    total,
    async (reporter) => {
      const tally = new BatchTally(total);
      for (const problem of parsed.problems) {
        const index = indexByLine.get(problem.line);
        if (index === undefined) continue;
        tally.put(
          index,
          emptyItem({
            accountId: null,
            identifier: null,
            action: null,
            ok: false,
            code: LINE_PARSE_FAILED,
            message: problem.message,
          }),
        );
      }

      const imported = await importSupplierSessionCookies(ctx.db, ctx.masterKey, {
        upstreamId,
        text,
        excluded: ctx.excluded,
        fetchImpl: ctx.fetchImpl,
        // 进度 = 已处理行数（含解析失败行），与任务创建时的 total 同一口径。
        onLine: (done) => reporter.step(done),
      });
      if (!imported.ok) {
        // 入口闸已经在返回值之前拦过；走到这里说明上游在任务中途消失/被改类型，
        // 属于环境异常，让任务以 failed 收场比伪造一份逐行结果诚实。
        throw new Error(imported.message);
      }

      for (const outcome of imported.report.outcomes) {
        const index = indexByLine.get(outcome.line);
        if (index === undefined) continue;
        tally.put(
          index,
          emptyItem({
            accountId: outcome.accountId,
            identifier: outcome.identifier,
            action: 'import',
            ok: outcome.ok,
            code: outcome.ok ? null : codeForSessionImportFailure(outcome.reason),
            message: outcome.ok ? null : outcome.message,
          }),
        );
      }

      return tally.build();
    },
    hooks.onFinish,
  );
}

/**
 * 导一行：判排除 → 建行或补录 → 登录 → 刷新。
 *
 * 「补录密码」不是特例而是本端点的正常用法（§15.9 升级路径）：一个只有会话的账号，
 * 拿着同一个 `identifier` 从 `import` 进来时**就地升级**成密码型 —— 不新建行、不改 `id`。
 * 所以"已存在"与"不存在"两条路的分岔只在**建不建行**，往下走的是同一段。
 */
async function importOne(
  ctx: SupplierOps,
  baseUrl: string,
  supplier: SupplierKind,
  upstreamId: string,
  row: ParsedImportRow,
  excluded: ReadonlySet<string>,
): Promise<SupplierBatchItem> {
  if (isExcludedHash(row.identifierHash, excluded)) {
    // **跳过要计数并报出来**（`skipped`），静默跳过等于没跳过。
    return emptyItem({
      accountId: null,
      identifier: row.maskedIdentifier,
      action: null,
      ok: false,
      code: EXCLUDED_IDENTIFIER,
      message: '该账号在排除名单里，本次未做任何登录尝试',
    });
  }

  const existing = findSupplierAccountByIdentifierHash(ctx.db, upstreamId, row.identifierHash);
  const isNew = existing === null;
  // §15.3 收口了这两个值的生产者：`login` = import 里**新建**的账号首次登录成功，
  // `relogin` = **已有**账号被重登。所以 `action` 只看"这一行是不是新建的"，
  // 不看后续刷新的过程中有没有再撞上会话失效 —— 中途那次重登属于刷新那一段，
  // 而新建账号本来就不是"已有账号"。
  const action: SupplierBatchAction = isNew ? 'login' : 'relogin';

  let accountId: string;
  if (isNew) {
    accountId = newId('supplierAccount');
    // 账号行记下**所属供应商**（不是写死 tierflow）：这张能力位决定后续五个端点
    // 给它选哪个驱动器，上游的 supplier 改了，账号行跟着改（§15.14 与 ADR-0018 决策 0）。
    createSupplierAccount(ctx.db, accountId, {
      upstreamId,
      supplier,
      identifier: row.maskedIdentifier,
      identifierHash: row.identifierHash,
      status: 'unknown',
      // 真值随密码一起进密文（见 `supplier/credentials.ts` 文件头）：它是重登的唯一来源，
      // 而库里那一列存的是掩码，推不回来。
      encryptedPassword: encodePasswordBlob(row.identifier, row.password, ctx.masterKey),
    });
  } else {
    accountId = existing.id;
    // 已有行：覆写密码密文（可能就是这次新补录的）。会话**不清** —— 清掉的话，
    // 这次导入若在登录前就断了，这个账号会从"还能用"退化成"只有密码"。
    updateSupplierAccount(ctx.db, accountId, {
      encryptedPassword: encodePasswordBlob(row.identifier, row.password, ctx.masterKey),
    });
  }

  const cred = readSupplierCredential(ctx.db, accountId, ctx.masterKey);
  if (cred === null) {
    // 刚建的行读不回来，只可能是密钥不对（换过 `MASTER_KEY`）。这是环境故障，照常报一行。
    return emptyItem({
      accountId,
      identifier: row.maskedIdentifier,
      action,
      ok: false,
      code: 'INTERNAL',
      message: '账号已写入但凭据读不回来（多半是 MASTER_KEY 与写入时不一致）',
    });
  }

  const client = clientFor(ctx, baseUrl, supplier);
  const logged = await loginAccount(ctx, client, cred);
  if (!logged.ok) {
    return emptyItem({
      accountId,
      identifier: cred.maskedIdentifier,
      action,
      ok: false,
      code: logged.code,
      message: logged.message,
    });
  }

  // 登录刚写进新会话，重读一次再刷 —— 用旧的（可能是过期的）会话去刷会把一次成功的
  // 登录紧接着变成一次 401。
  const refreshed = readSupplierCredential(ctx.db, accountId, ctx.masterKey);
  if (refreshed === null) {
    return emptyItem({
      accountId,
      identifier: cred.maskedIdentifier,
      action,
      ok: false,
      code: 'INTERNAL',
      message: '账号已登录但凭据读不回来（多半是 MASTER_KEY 与写入时不一致）',
    });
  }

  const outcome = await refreshAccount(ctx, client, refreshed);
  return emptyItem({
    accountId,
    identifier: cred.maskedIdentifier,
    action,
    ok: outcome.ok,
    code: outcome.code,
    message: outcome.message,
  });
}

// ---------------------------------------------------------------------------
// 2) POST /api/supplier-accounts/refresh
// ---------------------------------------------------------------------------

export function startSupplierRefresh(ctx: SupplierOps, body: unknown, hooks: BatchHooks = {}): TaskDto {
  const upstreamId = requiredString(body, 'upstreamId');
  const ids = readIds(body);
  const { baseUrl, supplier } = requireSupplierUpstream(ctx.db, upstreamId);
  // `ids` 省略 = 全部账号（§15.2）。**不按状态过滤** —— 会话过期的账号正是最该被刷一遍的那个。
  const targets = resolveTargets(ctx.db, upstreamId, ids, undefined);

  return startTask(
    ctx.db,
    'supplier_refresh',
    targets.length,
    async (reporter) => {
      const tally = new BatchTally(targets.length);
      const excluded = excludedHashSet(ctx.excluded);
      const queue = accountQueue(ctx);

      await Promise.all(
        targets.map((ref, index) =>
          queue.run(async () => {
            tally.put(index, await refreshOne(ctx, baseUrl, supplier, ref, excluded));
            reporter.step();
          }),
        ),
      );

      return tally.build();
    },
    hooks.onFinish,
  );
}

async function refreshOne(
  ctx: SupplierOps,
  baseUrl: string,
  supplier: SupplierKind,
  ref: SupplierAccountRef,
  excluded: ReadonlySet<string>,
): Promise<SupplierBatchItem> {
  if (isExcludedHash(ref.identifierHash, excluded)) {
    return emptyItem({
      accountId: ref.id,
      identifier: ref.identifier,
      action: null,
      ok: false,
      code: EXCLUDED_IDENTIFIER,
      message: '该账号在排除名单里，本次未做任何登录尝试',
    });
  }

  const cred = readSupplierCredential(ctx.db, ref.id, ctx.masterKey);
  if (cred === null) {
    return emptyItem({
      accountId: ref.id,
      identifier: ref.identifier,
      action: 'refresh',
      ok: false,
      code: 'INTERNAL',
      message: '凭据读不回来（多半是 MASTER_KEY 与写入时不一致）',
    });
  }

  const out = await refreshAccount(ctx, clientFor(ctx, baseUrl, supplier), cred);
  return emptyItem({
    accountId: ref.id,
    identifier: cred.maskedIdentifier,
    // 真重登过就报 `relogin` —— §15.3 明写这个端点里"被重登"要以 `relogin` 出现在逐行结果里。
    action: out.relogged ? 'relogin' : 'refresh',
    ok: out.ok,
    code: out.code,
    message: out.message,
  });
}

// ---------------------------------------------------------------------------
// 3) POST /api/supplier-accounts/:id/login（同步，非任务）
// ---------------------------------------------------------------------------

export async function loginSupplierAccount(ctx: SupplierOps, id: string): Promise<SupplierAccountDto> {
  const cred = readSupplierCredential(ctx.db, id, ctx.masterKey);
  if (cred === null) throw ApiError.notFound('供应商账号', id);

  const { baseUrl, supplier } = requireSupplierUpstream(ctx.db, cred.upstreamId);
  // §15.14.1 能力表「密码登录」：这家没有这条路 ⇒ 手工重登**整体不适用**，先于
  // "有没有存档密码"判 —— 顺序反了的话，对一个补录过密码的 TR 账号会真发一次
  // 注定 401 的登录（那行密码是导入期落进去的陈货，发出去只会惊动风控）。
  if (!supplierSupportsPasswordLogin(supplier)) {
    throw new ApiError(
      'UNPROCESSABLE',
      'TokenRhythm 只有会话鉴权，没有密码重登（§15.14.1 能力表）。会话过期请重新执行一次性离线会话导入（§15.9）',
    );
  }
  // 手工触发的一次重登。**没有密码就直接 422** —— 这个端点的全部意义就是"用密码换会话"。
  // 回 200 再让 `status` 说"没重登成"，会让点了按钮的人以为点过了。
  if (cred.password === null || cred.identifier === '') {
    throw new ApiError(
      'UNPROCESSABLE',
      '该账号只有会话、没有存档密码，无从重登（§15.9）。请用 import 补录「手机号,密码」',
    );
  }

  await loginAccount(ctx, clientFor(ctx, baseUrl, supplier), cred);
  // 无论成败都回 200 + 最新一行：失败原因（供应商错误码一类）写在 `status` / `statusMessage` 上，
  // 与 §2 自测同一条取向 —— 这是**操作的结果**，不是请求有问题。
  return requireSupplierAccount(ctx.db, id);
}

// ---------------------------------------------------------------------------
// 4) POST /api/supplier-accounts/:id/test（同步，非任务）
// ---------------------------------------------------------------------------

/**
 * 连接自测（§15.2 `SupplierTestResult`）。
 *
 * 三条与 §2 `BalanceTestResult` 逐字同口径：**永不写库**、业务性失败一律 `200 + ok:false`、
 * `raw` 是上游原样而 `parsed` 才是换算后的结论。
 *
 * 与其余五个端点唯一的区别是它**不写库但会重登**：会话过期时 `callWithRelogin` 会真的
 * 登一次并把新会话带回来，而这里**不落那条新会话**。这是刻意的 —— 自测被明确要求
 * "永不写库"，而"测一次顺手把会话刷新了"正是最容易被当成顺手好事的越界。
 * 代价是连测两次就登两次；`loginAttempted` 让这件事在结果里看得见。
 */
export async function testSupplierAccount(ctx: SupplierOps, id: string): Promise<SupplierTestResult> {
  const cred = readSupplierCredential(ctx.db, id, ctx.masterKey);
  if (cred === null) throw ApiError.notFound('供应商账号', id);

  const { baseUrl, supplier } = requireSupplierUpstream(ctx.db, cred.upstreamId);

  const startedMs = Date.now();
  const failure = (
    httpStatus: number,
    loginAttempted: boolean,
    raw: unknown,
    errorCode: string,
  ): SupplierTestResult => ({
    ok: false,
    accountId: cred.id,
    identifier: cred.maskedIdentifier,
    httpStatus,
    durationMs: Date.now() - startedMs,
    loginAttempted,
    parsed: { balanceCents: null, quotaPerUnit: null, subscriptionCount: null },
    raw,
    errorCode,
    hintCode: errorCode === 'UPSTREAM_UNREACHABLE' ? 'BALANCE_UPSTREAM_UNREACHABLE' : null,
    hint: errorCode === 'UPSTREAM_UNREACHABLE' ? UPSTREAM_UNREACHABLE_HINT : null,
  });

  const start = sessionOf(cred);
  if (start === null) {
    // 没有会话也没有密码可换（有密码的话自测也**不许**顺手登 —— 见上）。
    // **不发那次注定 401 的请求**：把它变成一次真实的失败会比"没做"更难解释。
    return failure(0, false, null, 'SESSION_EXPIRED');
  }

  const budget = createReloginBudget(cred);
  const client = clientFor(ctx, baseUrl, supplier);

  const selfCall = await callWithRelogin(client, budget.credential(start), (c) => client.self(c));
  budget.note(selfCall.relogged);

  // 一次自测里有两条可能的会话：原件与重登换来的那个。**两条都要擦** ——
  // 上游回显的是它当时收到的那一条，而失败时恰恰最可能是过期的那条。
  const secrets: (string | null | undefined)[] = [
    cred.password,
    cred.session,
    cred.identifier,
    selfCall.renewed?.session,
  ];

  if (!selfCall.result.ok) {
    return failure(
      selfCall.result.httpStatus,
      selfCall.relogged,
      scrubRaw(selfCall.result.raw, secrets),
      errorCodeForFailure(selfCall.result.failure),
    );
  }

  const self = selfCall.result.data;
  // 自测也是 `/api/user/self` 的一次真实调用，比值同样在手上（审计项 D）。
  // 落库只记比值与时刻，**不碰账号状态** —— 自测是诊断动作，
  // 不该因为它把 `status` 从 `session_expired` 改成 `active`（那是登录/刷新的职权）。
  persistQuotaPerUnit(ctx, cred.id, self.quotaPerUnit);
  const subsCall = await callWithRelogin(client, budget.credential(sessionAfter(selfCall.renewed, start)), (c) =>
    client.subscriptions(c),
  );
  // 套餐数取不到就 `null`：自测是诊断，套餐接口抖一下不该把整次自测判成失败。
  const subscriptionCount = subsCall.result.ok ? subsCall.result.data.length : null;

  return {
    ok: true,
    accountId: cred.id,
    identifier: cred.maskedIdentifier,
    httpStatus: selfCall.result.httpStatus,
    durationMs: Date.now() - startedMs,
    // 两条腿都可能触发重登，任一条真的登过就算"本次为验证密码而真实登录过"。
    loginAttempted: selfCall.relogged || subsCall.relogged,
    parsed: {
      balanceCents: self.balanceCents,
      // 换算比是**比例**不是金额，保留是为了诊断"供应商是不是改了比值"（§15.2）。
      quotaPerUnit: self.quotaPerUnit,
      subscriptionCount,
    },
    raw: scrubRaw(self.raw, secrets),
    errorCode: null,
    hintCode: null,
    hint: null,
  };
}

/**
 * 自测的 `errorCode`。与 `codeForFailure` 分开：那一套是给 `items[].code` 用的短码，
 * 这一套是 `SupplierTestResult.errorCode`（诊断语义，要能自己说清是哪一类）。
 */
function errorCodeForFailure(failure: TierFlowFailure): string {
  switch (failure) {
    case 'unreachable':
    case 'timeout':
      return 'UPSTREAM_UNREACHABLE';
    case 'session_expired':
      return 'SESSION_EXPIRED';
    case 'rejected':
      return 'UPSTREAM_REJECTED';
    case 'http_error':
      return 'UPSTREAM_HTTP_ERROR';
  }
}

// ---------------------------------------------------------------------------
// 5) POST /api/supplier-accounts/keys（批量建 key 并入池）
// ---------------------------------------------------------------------------

interface KeySpec {
  count: number;
  namePrefix: string;
  unlimited: boolean;
  quotaCents: number | null;
  models: string[] | null;
  label: string | null;
}

function parseKeySpec(body: unknown, supplier: SupplierKind): KeySpec {
  const raw = asRecord(body) ?? {};

  const countRaw = raw['count'] === undefined ? 1 : raw['count'];
  if (
    typeof countRaw !== 'number' ||
    !Number.isInteger(countRaw) ||
    countRaw < KEY_COUNT_MIN ||
    countRaw > KEY_COUNT_MAX
  ) {
    throw ApiError.invalidParam('count', `count 必须是 ${KEY_COUNT_MIN}..${KEY_COUNT_MAX} 的整数`);
  }

  const prefixRaw = raw['namePrefix'];
  // 默认前缀跟随供应商（`supplier` 就是驱动器名）：上游侧 key 名是
  // `<prefix>-<尾4>-<序号>`，默认值写死 `tierflow` 会让 TokenRhythm 的 key 也叫 `tierflow-…`，
  // 在一个混装两家供应商的池子里分不出它是谁建出来的。
  let namePrefix: string = supplier;
  if (prefixRaw !== undefined && prefixRaw !== null) {
    if (typeof prefixRaw !== 'string' || prefixRaw.trim() === '') {
      throw ApiError.invalidParam('namePrefix', 'namePrefix 必须是非空字符串');
    }
    namePrefix = prefixRaw.trim();
  }

  const unlimited = raw['unlimited'] === undefined ? true : raw['unlimited'] === true;
  let quotaCents: number | null = null;
  if (!unlimited) {
    const q = raw['quotaCents'];
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 0) {
      throw ApiError.invalidParam('quotaCents', 'unlimited=false 时必须给出整数 quotaCents（单位：分）');
    }
    quotaCents = q;
  }

  const modelsRaw = raw['models'];
  let models: string[] | null = null;
  if (modelsRaw !== undefined && modelsRaw !== null) {
    if (!Array.isArray(modelsRaw)) throw ApiError.invalidParam('models', 'models 必须是字符串数组');
    const list: string[] = [];
    for (const m of modelsRaw) {
      if (typeof m !== 'string') throw ApiError.invalidParam('models', 'models 里每一项都必须是字符串');
      if (m.trim() !== '') list.push(m.trim());
    }
    // 空数组 = 不设白名单（§3 / §15.2 v1.4.2）：落 `NULL`，**不落 `''`**。
    models = list.length === 0 ? null : list;
  }

  const labelRaw = raw['label'];
  let label: string | null = null;
  if (labelRaw !== undefined && labelRaw !== null) {
    if (typeof labelRaw !== 'string') throw ApiError.invalidParam('label', 'label 必须是字符串');
    label = labelRaw.trim() === '' ? null : labelRaw.trim();
  }

  return { count: countRaw, namePrefix, unlimited, quotaCents, models, label };
}

export function startSupplierKeys(ctx: SupplierOps, body: unknown, hooks: BatchHooks = {}): TaskDto {
  const upstreamId = requiredString(body, 'upstreamId');
  const ids = readIds(body);
  const { baseUrl, supplier } = requireSupplierUpstream(ctx.db, upstreamId);
  // 字段校验放在建任务**之前**：`count: 99` 应当在这一次 HTTP 里 400，
  // 而不是变成一个"建了任务、立刻失败"的异步错误（前端要轮询一次才知道自己参数写错了）。
  // 顺序在 `requireSupplierUpstream` 之后：`namePrefix` 的默认值跟随供应商，得先知道是谁。
  const spec = parseKeySpec(body, supplier);
  // §15.14 能力表：TokenRhythm 的 key **无额度、无模型白名单**（服务端就没有这两个概念）。
  // `parseKeySpec` 的默认值是 `unlimited:true` 且没有白名单 —— 那正是 TokenRhythm 唯一
  // 支持的形状，原样放行；只有调用方**显式指定**了 `unlimited:false` 或非空 `models` 时才 422
  // （在入口报，而不是让驱动器静默丢掉参数 —— 静默丢参数会造出一把"以为设了额度其实没有"的 key）。
  if (supplier === 'tokenrhythm') {
    if (!spec.unlimited) {
      throw new ApiError(
        'UNPROCESSABLE',
        'TokenRhythm 的 key 没有额度概念，不支持 unlimited=false / quotaCents（§15.14 能力表）',
      );
    }
    if (spec.models !== null) {
      throw new ApiError(
        'UNPROCESSABLE',
        'TokenRhythm 的 key 不支持模型白名单（models），请省略该字段（§15.14 能力表）',
      );
    }
  }
  // 省略 ids = 该上游全部 **active** 账号（§15.2 的措辞与 refresh 不同，这里照它写）。
  const targets = resolveTargets(ctx.db, upstreamId, ids, ['active']);

  return startTask(
    ctx.db,
    'supplier_keys',
    targets.length,
    async (reporter) => {
      const tally = new BatchTally(targets.length);
      const excluded = excludedHashSet(ctx.excluded);
      const queue = accountQueue(ctx);

      await Promise.all(
        targets.map((ref, index) =>
          queue.run(async () => {
            tally.put(index, await createKeysOne(ctx, baseUrl, supplier, upstreamId, ref, spec, excluded));
            reporter.step();
          }),
        ),
      );

      return tally.build();
    },
    hooks.onFinish,
  );
}

async function createKeysOne(
  ctx: SupplierOps,
  baseUrl: string,
  supplier: SupplierKind,
  upstreamId: string,
  ref: SupplierAccountRef,
  spec: KeySpec,
  excluded: ReadonlySet<string>,
): Promise<SupplierBatchItem> {
  if (isExcludedHash(ref.identifierHash, excluded)) {
    return emptyItem({
      accountId: ref.id,
      identifier: ref.identifier,
      action: null,
      ok: false,
      code: EXCLUDED_IDENTIFIER,
      message: '该账号在排除名单里，本次未建任何 key',
    });
  }

  const cred = readSupplierCredential(ctx.db, ref.id, ctx.masterKey);
  if (cred === null) {
    return emptyItem({
      accountId: ref.id,
      identifier: ref.identifier,
      action: 'create',
      ok: false,
      code: 'INTERNAL',
      message: '凭据读不回来（多半是 MASTER_KEY 与写入时不一致）',
    });
  }

  const outcome = await createKeysForAccount(ctx, clientFor(ctx, baseUrl, supplier), upstreamId, cred, spec);
  // §15.3：`create` = `keys`；这个端点里被重登则以 `relogin` 出现在逐行结果里。
  const action: SupplierBatchAction = outcome.relogged ? 'relogin' : 'create';
  if (outcome.error !== null) {
    return emptyItem({
      accountId: ref.id,
      identifier: cred.maskedIdentifier,
      action,
      ok: false,
      code: outcome.error.code,
      message: outcome.error.message,
    });
  }

  const first = outcome.created[0] ?? null;
  return emptyItem({
    accountId: ref.id,
    identifier: cred.maskedIdentifier,
    action,
    ok: true,
    // 一把 key 一行结果，而 `count` 可以 >1；这一行报**第一把**，其余把数写进 message。
    // 报最后一把也行，但"第一把"是确定会有的那把 —— 后面的可能因为中途失败而不存在。
    keyId: first?.keyId ?? null,
    keyMasked: first?.maskedKey ?? null,
    tokenNo: first?.tokenNo ?? null,
    message:
      outcome.created.length > 1
        ? `本账号共建出 ${outcome.created.length} 把 key，此处列的是第一把`
        : null,
  });
}

interface CreateOutcome {
  relogged: boolean;
  created: { keyId: string; maskedKey: string; tokenNo: number | null }[];
  error: { code: string | null; message: string } | null;
}

async function createKeysForAccount(
  ctx: SupplierOps,
  client: TierFlowClient,
  upstreamId: string,
  cred: SupplierCredential,
  spec: KeySpec,
): Promise<CreateOutcome> {
  const start = sessionOf(cred);
  if (start === null) {
    // 建 key 是写操作，**不在这里顺手登一次**（同自测的理由：一个动作只做一件事）。
    // 操作员该先去 `:id/login` 或 `refresh` 把会话拿回来。
    return {
      relogged: false,
      created: [],
      error: { code: 'SESSION_EXPIRED', message: '该账号没有可用会话，请先重登再建 key' },
    };
  }

  const budget = createReloginBudget(cred);
  let session: SessionCred = start;
  let relogged = false;
  const created: CreateOutcome['created'] = [];

  // 站点换算比（审计项 D）。`unlimited:true` 时上游不看这个数（`pendingCreateTokenBody`
  // 只在 `!unlimited` 分支发 `remain_quota`），所以 `undefined` 传给驱动器就等于
  // 让它落回 `DEFAULT_QUOTA_PER_UNIT` —— 那条路只有"从没 refresh 过的新账号"会走到。
  //
  // **不为它多发一次 `/api/user/self`**：§15.5 表钉死"建 key = 2 次请求"（创建 + 回查
  // `token_no`），加一发就是 3 次。比值由 `refresh` / `keys/sync` / 自测三条腿顺手记在
  // `supplier_accounts.quota_per_unit` 上（那三条**已经在打** `/api/user/self`），
  // 这里只负责把它用上。宁可拿到一个可能过期的真值，也不用一个永远错的常量。
  const quotaPerUnit = cred.quotaPerUnit ?? undefined;

  for (let seq = 1; seq <= spec.count; seq += 1) {
    // 上游侧 key 名 = `<prefix>-<identifier后4>-<序号>`，**不含凭据**（§15.2）。
    const name = `${spec.namePrefix}-${tailOfMasked(cred.maskedIdentifier)}-${seq}`;
    const call = await callWithRelogin(client, budget.credential(session), (c) =>
      client.createToken(c, {
        name,
        unlimited: spec.unlimited,
        quotaCents: spec.quotaCents,
        models: spec.models,
        quotaPerUnit,
      }),
    );
    persistRenewed(ctx, cred.id, call.renewed);
    budget.note(call.relogged);
    relogged = relogged || call.relogged;

    if (!call.result.ok) {
      return {
        relogged,
        created,
        error: {
          code: codeForFailure(call.result.failure),
          message: describeWithProgress(safeMessage(call.result.message, cred), created.length),
        },
      };
    }
    session = sessionAfter(call.renewed, session);

    const data = call.result.data;
    if (data.plaintext === null) {
      // 没有明文就**没法入池**（掩码不可逆，ADR-0018 决策 2）。这一把在上游已经建出来了 ——
      // 说清楚这件事，否则下一次同步会看见一把我们没记账的 key。
      return {
        relogged,
        created,
        error: {
          code: KEY_PLAINTEXT_MISSING,
          message: describeWithProgress(
            '上游建 key 响应里没有明文 key，无法入池（待实测：创建响应是否回显 key）',
            created.length,
          ),
        },
      };
    }

    // 明文**只在这一行的栈内**。`createKey` 返回前它已 aes-256-gcm 落库，
    // 之后既不进 result、不进响应、不进日志（§15.2「明文不经浏览器」）。
    const key = createKey(
      ctx.db,
      {
        upstreamId,
        key: data.plaintext,
        category: 'balance',
        label: spec.label ?? name,
        unlimited: spec.unlimited,
        // §15.7 不变量由 `createKey` 强制（unlimited ⇒ balance 落 NULL），这里不重复判。
        balance: spec.quotaCents,
        models: spec.models,
      },
      ctx.masterKey,
    );
    linkSupplierAccountKey(ctx.db, cred.id, key.id, key.maskedKey, name);
    created.push({ keyId: key.id, maskedKey: key.maskedKey, tokenNo: toTokenNo(data.tokenNo) });
  }

  updateSupplierAccount(ctx.db, cred.id, { status: 'active', statusMessage: null });
  return { relogged, created, error: null };
}

/**
 * 把"已经建出几把"接在失败原因后面。
 *
 * 不说的话，一次失败会让人以为"什么都没发生" —— 而前面那几把 key **已经在上游存在、
 * 也已经在池里**，重试一次就会多出几把。这是本文件里最容易造成重复扣量的一件事。
 */
function describeWithProgress(message: string, createdSoFar: number): string {
  return createdSoFar === 0 ? message : `${message}（本账号已建出 ${createdSoFar} 把）`;
}

// ---------------------------------------------------------------------------
// 6) POST /api/supplier-accounts/rotate-key（§15.13 套餐 key 轮换，契约 v1.9.0 / ADR-0022）
// ---------------------------------------------------------------------------

/**
 * **规则 1（先落库、后失效）的落库腿**：新 key 明文进密文库 + 记台账。
 * 明文**只在这一行的栈内** —— `createKey` 返回前已 aes-256-gcm 落库，
 * 之后不进 result、不进响应、不进日志（§15.2「明文不经浏览器」同一条纪律）。
 *
 * `tokenPlan` **刻意省略**：`createKey` 会把 `token_plan_remaining` 落 `NULL` = 余量未知，
 * 不会凭空写一个 0（§15.2「不猜」；真实余量由 `keys/sync` / 余额刷新回填）。
 */
function poolRotatedKey(
  ctx: SupplierOps,
  upstreamId: string,
  accountId: string,
  input: { plaintext: string; subNo: string; planTitle: string },
): string {
  const key = createKey(
    ctx.db,
    {
      upstreamId,
      key: input.plaintext,
      category: 'token-plan',
      label: `套餐-${input.planTitle}`,
    },
    ctx.masterKey,
  );
  linkSupplierAccountKey(ctx.db, accountId, key.id, key.maskedKey, `套餐key轮换-${input.subNo}`);
  return key.id;
}

/**
 * **规则 1 的失效腿**：禁用被替换的旧 key（软删：`enabled=0` + `deleted_at`，行保留）。
 * 调用前提 = 新 key 已经落库 —— 顺序反了，一次失败就会造成"新旧全失"。
 * 台账行**不删**：它记录的是"这把旧 key 曾属于该账号"的历史，删除会把审计对账面抹掉。
 */
function disableSupersededKey(ctx: SupplierOps, oldKeyId: string): void {
  try {
    deleteKey(ctx.db, oldKeyId);
  } catch {
    // 已被并发删掉 / 已软删：目标态（旧 key 不可用）已达成，不是错误。
  }
}

/**
 * 旧 key 认领腿之取证：在发重置请求**之前**查一次该套餐专属 key 的掩码（`GET …/token?sub_no=`）。
 *
 * **实测（2026-10-12）**：上游重置换尾 —— 同一把套餐 key 重置前后后 4 位不同（`…iHLd` → `…5w2l`）。
 * 所以认领锚点只能是**重置前**这一查的结果；拿新掩码去台账找旧 key **永远落空**。
 * **best-effort**：直连（不带被动重登，同 `fillSubscriptionKeyMasks`），查不到 / 失败一律 `null`（不猜），
 * 那时本次不自动禁用旧 key，由 `message` 提示人工核对。
 */
async function fetchSubscriptionKeyMask(
  client: TierFlowClient,
  session: SessionCred,
  subNo: string,
): Promise<string | null> {
  const res = await client.request({
    method: 'GET',
    path: TIERFLOW_PATHS.subscriptionTokens,
    query: { sub_no: subNo },
    credential: session,
  });
  return res.ok ? findMaskInPayload(res.data) : null;
}

/**
 * 旧 key 定位（§15.13 规则 3）：**只按掩码精确相等**认领，且锚点是**重置前**的旧掩码 `oldMasked`
 * （见 `fetchSubscriptionKeyMask`：上游重置换尾，新掩码对不上）。
 * 撞号 / 找不到都不动旧 key —— 旧 key 会失效，但池里**不会误禁**别人的 key；
 * `message` 把这句话说清楚，操作员的手动兜底是本面上的启用/禁用按钮。
 */
function pickSupersededTokenRow(
  ledger: readonly { pooledKeyId: string; maskedKey: string }[],
  oldMasked: string | null,
): { pooledKeyId: string; maskedKey: string } | null {
  if (oldMasked === null || oldMasked === '') return null;
  const hits = ledger.filter((row) => row.maskedKey === oldMasked);
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

export function startSupplierRotateKey(ctx: SupplierOps, body: unknown, hooks: BatchHooks = {}): TaskDto {
  const upstreamId = requiredString(body, 'upstreamId');
  const ids = readIds(body);
  // `subNo` 可选（§15.13）：给了 = 每个目标账号都重置**这一个**套餐号；省略 = 各自**最新到期**的套餐。
  const rawSubNo = asRecord(body)?.['subNo'];
  if (rawSubNo !== undefined && rawSubNo !== null && (typeof rawSubNo !== 'string' || rawSubNo.trim() === '')) {
    throw ApiError.invalidParam('subNo', 'subNo 必须是非空字符串');
  }
  const subNo = typeof rawSubNo === 'string' && rawSubNo.trim() !== '' ? rawSubNo.trim() : null;
  const { baseUrl, supplier } = requireSupplierUpstream(ctx.db, upstreamId);
  // §15.14 能力表：TokenRhythm 没有套餐，"重置套餐专属 key"这个动作对它不存在。
  // 在入口 422，而不是让每个账号在 `latestSubscriptionSubNo` 上落一行 SUBSCRIPTION_NOT_FOUND
  // —— 那是 TierFlow 的"该账号没套餐记录"，对 TokenRhythm 是**整类上游**都没有，语义不同。
  if (supplier === 'tokenrhythm') {
    throw new ApiError('UNPROCESSABLE', 'TokenRhythm 无套餐概念，不支持套餐 key 轮换（§15.14 能力表）');
  }
  // 省略 ids = 该上游**全部**账号（与 refresh 同口径）：会话过期的账号正是"点重置想救回来"的那个。
  const targets = resolveTargets(ctx.db, upstreamId, ids, undefined);

  return startTask(
    ctx.db,
    'supplier_rotate_key',
    targets.length,
    async (reporter) => {
      const tally = new BatchTally(targets.length);
      const excluded = excludedHashSet(ctx.excluded);
      const queue = accountQueue(ctx);

      await Promise.all(
        targets.map((ref, index) =>
          queue.run(async () => {
            tally.put(index, await rotateOne(ctx, baseUrl, supplier, upstreamId, ref, excluded, subNo));
            reporter.step();
          }),
        ),
      );

      return tally.build();
    },
    hooks.onFinish,
  );
}

/**
 * 一个账号的重置（§15.13 语义顺序，三条次序纪律都不是风格问题）：
 *
 * 1. **先落库、后失效** —— 新 key 明文只在重置响应里出现这一次；先把明文送进密文库，
 *    之后任何一步失败都只是"旧 key 还挂着"的**安全态**，不存在"新 key 明文已丢"的不可恢复态。
 * 2. **只按掩码精确相等认领旧 key** —— 撞号 / 找不到都不禁用：宁可留一把已失效的旧 key，
 *    也不要把 A 账号的 key 禁到 B 账号头上（§15.2 `KEY_MASK_AMBIGUOUS` 同一条取向）。
 * 3. **重置不改账号状态判定** —— §15.1 的 `status` 是"最近一次查询"的结论，重置不是查询；
 *    失败只写 `statusMessage`（同 `failurePatch` 的取向），成功不把它顶成 `active`。
 */
async function rotateOne(
  ctx: SupplierOps,
  baseUrl: string,
  supplier: SupplierKind,
  upstreamId: string,
  ref: SupplierAccountRef,
  excluded: ReadonlySet<string>,
  subNo: string | null,
): Promise<SupplierBatchItem> {
  if (isExcludedHash(ref.identifierHash, excluded)) {
    return emptyItem({
      accountId: ref.id,
      identifier: ref.identifier,
      action: null,
      ok: false,
      code: EXCLUDED_IDENTIFIER,
      message: '该账号在排除名单里，本次未做任何重置',
    });
  }

  const cred = readSupplierCredential(ctx.db, ref.id, ctx.masterKey);
  if (cred === null) {
    return emptyItem({
      accountId: ref.id,
      identifier: ref.identifier,
      action: 'rotate',
      ok: false,
      code: 'INTERNAL',
      message: '凭据读不回来（多半是 MASTER_KEY 与写入时不一致）',
    });
  }

  const start = sessionOf(cred);
  if (start === null) {
    // 重置是写操作，**不在这里顺手登一次**（同 `keys` 的理由：一个动作只做一件事）。
    return emptyItem({
      accountId: ref.id,
      identifier: cred.maskedIdentifier,
      action: 'rotate',
      ok: false,
      code: 'SESSION_EXPIRED',
      message: '该账号没有可用会话，请先重登或刷新后再重置',
    });
  }

  // `subNo` 省略 = 该账号**最新到期**的套餐（`end_at` 最大；名下无套餐记录则这一行失败）。
  const targetSubNo = subNo ?? latestSubscriptionSubNo(ctx.db, ref.id);
  if (targetSubNo === null) {
    return emptyItem({
      accountId: ref.id,
      identifier: cred.maskedIdentifier,
      action: 'rotate',
      ok: false,
      code: 'SUBSCRIPTION_NOT_FOUND',
      message: '该账号名下没有套餐记录，无法重置套餐 key（先执行一次刷新或 keys/sync）',
    });
  }

  const budget = createReloginBudget(cred);
  const client = clientFor(ctx, baseUrl, supplier);

  // §15.13 规则 3 的取证腿：重置**之前**先取旧掩码（重置换尾，拿新掩码永远认领不到旧 key），
  // 并拍一张"重置前台账快照"（新 key 入台账后再读会把新 key 自己当成旧 key）。
  const oldMasked = await fetchSubscriptionKeyMask(client, start, targetSubNo);
  const ledgerBefore = listLinkedPooledKeyMasks(ctx.db, ref.id);

  // ① 上游重置（拿到新明文 = 本端点的唯一意义）。重试预算同全线：callWithRelogin 的一次被动重登。
  const call = await callWithRelogin(client, budget.credential(start), (c) =>
    client.rotateSubscriptionToken(c, targetSubNo),
  );
  persistRenewed(ctx, ref.id, call.renewed);
  budget.note(call.relogged);

  if (!call.result.ok) {
    updateSupplierAccount(ctx.db, ref.id, failurePatch(call.result, cred));
    return emptyItem({
      accountId: ref.id,
      identifier: cred.maskedIdentifier,
      action: call.relogged ? 'relogin' : 'rotate',
      ok: false,
      code: codeForFailure(call.result.failure),
      message: safeMessage(call.result.message, cred),
    });
  }

  // ② 顺手对账套餐（驱动器 `subscriptions` 一次请求；失败不阻塞主流程 —— 重置已经成功）。
  const subRows = await callWithRelogin(client, budget.credential(sessionAfter(call.renewed, start)), (c) =>
    client.subscriptions(c),
  );
  persistRenewed(ctx, ref.id, subRows.renewed);
  budget.note(subRows.relogged);
  // 换算比取**这个账号自己读到过的那个**，与 `createKeysForAccount` 同一来源
  // （`supplier_accounts.quota_per_unit`，审计项 D）。重置套餐 key 这一路没有
  // `/api/user/self` 可打（§15.13：重置是**一次**请求），所以只能靠缓存 ——
  // 宁可要一个可能过期的真值，也不用写死的 500000 把套餐金额整列算错。
  const mapped = subRows.result.ok
    ? mapSubscriptions(subRows.result.data, cred.quotaPerUnit ?? DEFAULT_QUOTA_PER_UNIT)
    : [];
  if (mapped.length > 0) replaceSupplierSubscriptions(ctx.db, ref.id, mapped);
  const plan = mapped.find((row) => row.subNo === targetSubNo) ?? null;

  // ③ 新 key 落库（规则 1 的前半段：先落库）。
  const plaintext = call.result.data.plaintext;
  if (plaintext === null) {
    // 驱动器契约上 ok 必带明文（无明文时它自己回 rejected）；真出现时**不落一把空 key**，
    // 按 `KEY_PLAINTEXT_MISSING` 报出去 —— 上游的旧 key 此时已失效，必须让人看见。
    return emptyItem({
      accountId: ref.id,
      identifier: cred.maskedIdentifier,
      action: call.relogged ? 'relogin' : 'rotate',
      ok: false,
      code: KEY_PLAINTEXT_MISSING,
      message: '上游重置成功但响应里没有 key 明文，未能入池（请人工核实并在上游确认旧 key 是否已失效）',
    });
  }
  const planTitle = plan?.planTitle ?? plan?.planSlug ?? targetSubNo;
  const keyId = poolRotatedKey(ctx, upstreamId, ref.id, {
    plaintext,
    subNo: targetSubNo,
    planTitle,
  });

  // ④ 套餐行的 has_key / key_masked 以**本次响应**为准（请求前旧掩码已经是废的）。
  upsertSupplierSubscription(ctx.db, ref.id, {
    subNo: targetSubNo,
    planTitle: plan?.planTitle ?? null,
    planSlug: plan?.planSlug ?? null,
    amountTotalCents: plan?.amountTotalCents ?? null,
    amountUsedCents: plan?.amountUsedCents ?? null,
    paidCents: plan?.paidCents ?? null,
    basicTokenTotal: plan?.basicTokenTotal ?? null,
    basicTokenUsed: plan?.basicTokenUsed ?? null,
    status: plan?.status ?? null,
    source: plan?.source ?? null,
    startAt: plan?.startAt ?? null,
    endAt: plan?.endAt ?? null,
    autoRenew: plan?.autoRenew ?? null,
    hasKey: true,
    keyMasked: call.result.data.maskedKey,
  });

  // ⑤ 旧 key 退场（规则 1 的后半段：后失效）。锚点是**重置前**取到的旧掩码 `oldMasked`
  //    （实测重置换尾；拿新掩码永远认领不到 —— 见 `pickSupersededTokenRow`）。
  const superseded = pickSupersededTokenRow(ledgerBefore, oldMasked);
  let message: string | null = null;
  if (superseded !== null) {
    disableSupersededKey(ctx, superseded.pooledKeyId);
  } else {
    message = '新 key 已入池；旧 key 未能按掩码认领（撞号或不在池内），未自动禁用，请人工核对';
  }

  return emptyItem({
    accountId: ref.id,
    identifier: cred.maskedIdentifier,
    action: call.relogged || subRows.relogged ? 'relogin' : 'rotate',
    ok: true,
    keyId,
    keyMasked: call.result.data.maskedKey,
    tokenNo: null,
    message,
  });
}

// ---------------------------------------------------------------------------
// 6) POST /api/supplier-accounts/keys/sync
// ---------------------------------------------------------------------------

export function startSupplierKeysSync(ctx: SupplierOps, body: unknown, hooks: BatchHooks = {}): TaskDto {
  const upstreamId = requiredString(body, 'upstreamId');
  const ids = readIds(body);
  const { baseUrl, supplier } = requireSupplierUpstream(ctx.db, upstreamId);
  const targets = resolveTargets(ctx.db, upstreamId, ids, ['active']);

  return startTask(
    ctx.db,
    'supplier_keys_sync',
    targets.length,
    async (reporter) => {
      const tally = new BatchTally(targets.length);
      const excluded = excludedHashSet(ctx.excluded);
      const queue = accountQueue(ctx);

      await Promise.all(
        targets.map((ref, index) =>
          queue.run(async () => {
            tally.put(index, await syncKeysOne(ctx, baseUrl, supplier, ref, excluded));
            reporter.step();
          }),
        ),
      );

      return tally.build();
    },
    hooks.onFinish,
  );
}

async function syncKeysOne(
  ctx: SupplierOps,
  baseUrl: string,
  supplier: SupplierKind,
  ref: SupplierAccountRef,
  excluded: ReadonlySet<string>,
): Promise<SupplierBatchItem> {
  const item = (partial: Partial<SupplierBatchItem> & { ok: boolean }): SupplierBatchItem =>
    emptyItem({ accountId: ref.id, identifier: ref.identifier, action: 'sync', ...partial });

  if (isExcludedHash(ref.identifierHash, excluded)) {
    return emptyItem({
      accountId: ref.id,
      identifier: ref.identifier,
      action: null,
      ok: false,
      code: EXCLUDED_IDENTIFIER,
      message: '该账号在排除名单里，本次未同步任何 key',
    });
  }

  const cred = readSupplierCredential(ctx.db, ref.id, ctx.masterKey);
  if (cred === null) {
    return item({ ok: false, code: 'INTERNAL', message: '凭据读不回来（多半是 MASTER_KEY 与写入时不一致）' });
  }

  const outcome = await syncForAccount(ctx, clientFor(ctx, baseUrl, supplier), cred);
  if (!outcome.ok) return item({ ok: false, code: outcome.code, message: outcome.message });
  return item({
    ok: true,
    identifier: cred.maskedIdentifier,
    message: `台账 ${outcome.rows} 行，其中命中池内 ${outcome.matched} 行`,
  });
}

interface SyncOutcome {
  ok: boolean;
  code: string | null;
  message: string | null;
  rows: number;
  matched: number;
}

/**
 * 一个账号的对账。
 *
 * **三次请求**：`/api/user/self`（取 `quota_per_unit` 与服务端确认账号还活着）+
 * `/api/subscription/self`（套餐）+ `/api/token/search`（key 列表）。
 * §15.5 的表只钉了"刷新 = 2、建 key = 2"，没给 sync 定数；这里**不为省一次请求去猜换算比** ——
 * `quotaToCents` 拿一个错的比例会把套餐金额整列算错，而错了之后没有任何东西会报错
 * （§15.1 那三个单位同屏的坑）。
 *
 * 匹配口径**只按后 4 位**（§15.2）：`maskTail` 先剥 `sk-`，再取末 4 位。
 * 撞号（同一账号下多把 key 后 4 相同）时**一行都不更新**，只报 `KEY_MASK_AMBIGUOUS`。
 */
async function syncForAccount(
  ctx: SupplierOps,
  client: TierFlowClient,
  cred: SupplierCredential,
): Promise<SyncOutcome> {
  const start = sessionOf(cred);
  if (start === null) {
    return { ok: false, code: 'SESSION_EXPIRED', message: '该账号没有可用会话，请先重登再同步', rows: 0, matched: 0 };
  }

  const budget = createReloginBudget(cred);
  let session: SessionCred = start;

  const selfCall = await callWithRelogin(client, budget.credential(session), (c) => client.self(c));
  persistRenewed(ctx, cred.id, selfCall.renewed);
  budget.note(selfCall.relogged);
  if (!selfCall.result.ok) {
    updateSupplierAccount(ctx.db, cred.id, failurePatch(selfCall.result, cred));
    return {
      ok: false,
      code: codeForFailure(selfCall.result.failure),
      message: safeMessage(selfCall.result.message, cred),
      rows: 0,
      matched: 0,
    };
  }
  session = sessionAfter(selfCall.renewed, session);
  const quotaPerUnit = selfCall.result.data.quotaPerUnit;
  // 同步顺手记下比值（审计项 D）：这一发 `/api/user/self` 本来就是为拿它才打的
  // （上面的注释写明了"不为省一次请求去猜换算比"），拿到不记，下一个动作
  // 又得用 500000 去猜一遍。记在**读失败之前**：比值本身已经拿到了，
  // 下面套餐接口抖不抖与它无关。
  persistQuotaPerUnit(ctx, cred.id, quotaPerUnit);

  const subsCall = await callWithRelogin(client, budget.credential(session), (c) => client.subscriptions(c));
  persistRenewed(ctx, cred.id, subsCall.renewed);
  budget.note(subsCall.relogged);
  if (!subsCall.result.ok) {
    return {
      ok: false,
      code: codeForFailure(subsCall.result.failure),
      message: safeMessage(subsCall.result.message, cred),
      rows: 0,
      matched: 0,
    };
  }
  session = sessionAfter(subsCall.renewed, session);

  const subs = mapSubscriptions(subsCall.result.data, quotaPerUnit);
  await fillSubscriptionKeyMasks(client, session, subs);
  if (subs.length > 0) {
    replaceSupplierSubscriptions(ctx.db, cred.id, subs);
    // 顺手把套餐余量回填给池里那把套餐 key（ADR-0022 承诺的"后续"腿）。
    // 放在 `replaceSupplierSubscriptions` 之后、`tokens()` 之前：此刻 `key_masked`
    // 刚从上游补全（`fillSubscriptionKeyMasks`），而台账里还没有本轮的新 key ——
    // 但**已入池的套餐 key 是上一次 rotate 留下的**，它们已经在台账里，不受本轮影响。
    // 回填失败不该让整次同步失败：它只是让那把 key 多留一轮 `NULL`（= 未知，仍可选路）。
    backfillSubscriptionTokenPlan(ctx.db, cred.id, subs as readonly SupplierSubscriptionBackfill[]);
  }

  const tokensCall = await callWithRelogin(client, budget.credential(session), (c) => client.tokens(c));
  persistRenewed(ctx, cred.id, tokensCall.renewed);
  budget.note(tokensCall.relogged);
  if (!tokensCall.result.ok) {
    return {
      ok: false,
      code: codeForFailure(tokensCall.result.failure),
      message: safeMessage(tokensCall.result.message, cred),
      rows: 0,
      matched: 0,
    };
  }

  const tokens = tokensCall.result.data;

  // 池内已入池的 key，按"后 4 位"建索引。多把落同一个 tail 就是撞号。
  const byTail = new Map<string, string[]>();
  for (const linked of listLinkedPooledKeyMasks(ctx.db, cred.id)) {
    const tail = maskTail(linked.maskedKey);
    if (tail === null) continue;
    byTail.set(tail, [...(byTail.get(tail) ?? []), linked.pooledKeyId]);
  }

  // 上游那一侧同一个 tail 出现两次，与池内撞号是**同一件事的两面**：都说明这 4 位分不出是谁。
  const upstreamTailCount = new Map<string, number>();
  for (const token of tokens) {
    if (token.tail === null) continue;
    upstreamTailCount.set(token.tail, (upstreamTailCount.get(token.tail) ?? 0) + 1);
  }

  const ambiguous = [...upstreamTailCount].some(
    ([tail, n]) => n > 1 || (byTail.get(tail)?.length ?? 0) > 1,
  );
  if (ambiguous) {
    // **一行都不更新**（§15.2）：宁可少更一次，也不要把 A key 的余额写到 B key 上。
    // 这里也**不写 status** —— 撞号不是账号的毛病，是数据形状的毛病。
    return {
      ok: false,
      code: KEY_MASK_AMBIGUOUS,
      message: '同一账号下有多把 key 的后 4 位相同，本次未更新任何行',
      rows: 0,
      matched: 0,
    };
  }

  const rows: SupplierAccountKeyWrite[] = [];
  const seenPooled = new Set<string>();
  let matched = 0;
  for (const token of tokens) {
    // 掩码短到连后 4 位都取不出来 → 这一行没有可用信息，跳过（不落一行假的）。
    if (token.tail === null) continue;
    const masked = maskFromUpstream(token.mask);
    if (masked === null) continue;

    const hits = byTail.get(token.tail);
    const note = token.name === '' ? null : token.name;
    if (hits !== undefined && hits.length === 1) {
      const pooledKeyId = hits[0] as string;
      // 同一个池内 key 被上游两行指到（不该发生，但真发生时）只记一次 ——
      // 台账行重复会让 `keyCount` 偏大，而 `keyCount` 是删账号 409 的判据。
      if (!seenPooled.has(pooledKeyId)) {
        seenPooled.add(pooledKeyId);
        matched += 1;
        rows.push({ maskedKey: masked, pooledKeyId, note });
      }
      continue;
    }
    // 未命中 → 只记掩码（**不创建可用凭据**，掩码不可逆，ADR-0018 决策 2）。
    rows.push({ maskedKey: masked, pooledKeyId: null, note });
  }

  replaceSupplierAccountKeyLedger(ctx.db, cred.id, rows);
  updateSupplierAccount(ctx.db, cred.id, { status: 'active', statusMessage: null });
  return { ok: true, code: null, message: null, rows: rows.length, matched };
}

/**
 * 套餐行没自带掩码时，补一次"套餐专属 key"查询（§15.2 sync 的第三个来源）。
 *
 * **best-effort**：这条路（`/api/subscription/self/token?sub_no=`）是 §16.1.1 待实测的那几个
 * 之一，形状没钉死。它失败不该让一次同步整体失败 —— 少一列掩码与"整个账号对不了账"
 * 不是同一量级的损失。所以失败静默跳过，`key_masked` 留 `NULL`（未知，不是空串）。
 *
 * 它**不重登**：这里用的是直连 `client.request`（不带被动重登），会话若在此刻过期，
 * 结果就是这几行掩码留空 —— 而下一步的 `tokens()` 会把会话失效这件事正常报出来，
 * 不必在这里再登一次。
 */
async function fillSubscriptionKeyMasks(
  client: TierFlowClient,
  session: SessionCred,
  subs: SupplierSubscriptionWrite[],
): Promise<void> {
  for (const sub of subs) {
    // 已经有的不重复拉（少打一次是一次）；上游说没有 key 的更不用拉。
    if (sub.hasKey !== true || sub.keyMasked != null) continue;
    const res = await client.request({
      method: 'GET',
      path: TIERFLOW_PATHS.subscriptionTokens,
      query: { sub_no: sub.subNo },
      credential: session,
    });
    if (!res.ok) continue;
    const mask = findMaskInPayload(res.data);
    if (mask === null) continue;
    sub.keyMasked = mask;
  }
}

/** 在（形状未实测的）响应里找一个像掩码的串。找不到就 `null` —— 不猜。 */
function findMaskInPayload(payload: unknown): string | null {
  const record = asRecord(payload);
  for (const key of ['key', 'masked_key', 'token']) {
    const value = record?.[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const mask = maskFromUpstream(value);
      if (mask !== null) return mask;
    }
  }
  return null;
}
