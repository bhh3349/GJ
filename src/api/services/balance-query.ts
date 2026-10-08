// 余额查询的「解析 → 执行」中枢（契约 §2 解析顺序 / ADR-0012 §1–§4）。
//
// 这个文件存在的唯一理由：**把"用哪条路查"和"怎么查"收成一处**。
// 刷新任务（异步、批量）与自测端点（同步、单次）都必须走同一套判定，
// 否则会出现"刷新用 preset、自测用模板"这种自相矛盾的诊断结论 ——
// 而这种不一致恰恰最难发现，因为两边单独看都对。
//
// 三段解析（互斥、有优先级）：
//   ① 用户模板 enabled=true  → 模板引擎
//   ② host 命中内置 preset    → preset 执行器
//   ③ 都没有                  → 不发请求，skipped + BALANCE_QUERY_UNSUPPORTED
//
// 安全纪律（与 balance/template.ts 同一套，不因为多一层抽象而放松）：
// 明文 key 只在 `executePlan` 的栈内存在，替换过 `{key}` 的 URL / headers / body
// 既不落盘也不回显 —— 对外暴露的 `endpoint` 只取 `协议//host/path`（已剥 query）。

import {
  normalizeBalanceQuery,
  type BalanceQueryTemplate,
  type BalanceUnit,
} from '../../db/balance-query.js';
import {
  queryBalance,
  safeEndpointLabel,
  type ParsedBalance,
  type QueryTarget,
} from '../../balance/template.js';
import {
  findPresetByBaseUrl,
  presetEndpoint,
  type BalancePresetSpec,
} from '../../balance/preset.js';
import type { Db } from '../../db/database.js';
import { getUpstreamRow } from '../../db/repo/upstreams.js';
import { ApiError } from '../errors.js';
import type { HintCode } from '../dto.js';

/* --------------------------- 失败引导（ADR-0012 §4） --------------------------- */

const HINT_TEXT: Record<HintCode, string> = {
  BALANCE_QUERY_UNSUPPORTED:
    '该上游没有可用的余额查询方式（未启用模板，也未命中内置 preset）。请在「余额查询」里填好 URL 与余额取值路径，用自测确认能取到数后启用。',
  BALANCE_PARSE_MISMATCH:
    '上游正常返回了，但按当前取值路径取不到金额。请用「余额自测」查看响应原文，改字段路径后重试。',
  BALANCE_UPSTREAM_UNREACHABLE:
    '上游不可达、超时或返回了错误状态。这多半是暂时的，稍后重试即可，不必改配置。',
  BALANCE_AUTH_REJECTED:
    '上游以 401/403 拒绝了这把 key：可能它已失效，也可能该端点需要另一种凭据（例如账号 access token，而不是转发用的 sk- 接口 key）。',
  // 文案**不得越证据**（契约 §2 / ADR-0017 补遗 3）：429 无专用码、出口级与 key 级同形
  // （§16.7 v1.6.2），故只列两种可能，**不得**写成"出口被限流"这类确定性归因。
  BALANCE_EGRESS_RATE_LIMITED:
    '本次请求被限流（429）：可能是出口 IP 的请求预算已用尽，也可能该 key 自身撞到限额；稍后重试即可，不必改配置。',
};

/** `hint` 是面向用户的一句话，可直接展示；中文写死在这里，避免前后端各写一份逐渐走样。 */
export function hintText(code: HintCode): string {
  return HINT_TEXT[code];
}

/**
 * 单次查询结果 → 引导码。
 *
 * `hasValue` 由调用方按 key 类别判定（balance 类看金额、token-plan 类看余量），
 * 因为"解析成功但取不到数"这件事本身与类别相关，本函数不该猜。
 */
export function hintForQueryResult(result: {
  errorCode: 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED' | null;
  httpStatus: number;
  hasValue: boolean;
}): HintCode | null {
  if (result.errorCode === 'PARSE_FAILED') return 'BALANCE_PARSE_MISMATCH';
  if (result.errorCode === 'UPSTREAM_UNREACHABLE') {
    // 429 一行通吃：**判据是状态码本身，不是标记头**（ADR-0017 补遗 3「实现落点」2）。
    // 按标记头分流会造出一个新的误报类 —— 未带标记的**上游出口级** 429（上游按 IP 限我们）
    // 会被判成"key 自身限额"，与补遗 3 要消灭的误报**镜像同形**。
    if (result.httpStatus === 429) return 'BALANCE_EGRESS_RATE_LIMITED';
    return result.httpStatus === 401 || result.httpStatus === 403
      ? 'BALANCE_AUTH_REJECTED'
      : 'BALANCE_UPSTREAM_UNREACHABLE';
  }
  // 请求成功：取到数就不需要引导；取不到就是字段路径没配准
  return result.hasValue ? null : 'BALANCE_PARSE_MISMATCH';
}

/**
 * 批量刷新结果 → 引导码。
 *
 * 三型计数可能同时非零（50 把 key 里有 3 把 401、47 把正常），而 hint 只能给一句。
 * 取**最需要用户动作**的那一档：先失败（有东西坏了）、再未知（配置要改）、
 * 最后未支持（什么都还没配）。顺序写死在这里，前端与测试都按它断言。
 *
 * `rateLimited` 是**第 5 个旁路计数**（ADR-0017 补遗 3「实现落点」1）：不参与三型计数口径，
 * 只服务 hint。它插在 `authRejected` 与 `BALANCE_UPSTREAM_UNREACHABLE` **之间** ——
 * 401/403 最具体且要用户动作，429 次之（等等就行），其余才算"上游坏了"。
 * 只接单查询侧（`hintForQueryResult`）的话，批量路径**永远给不出这个码**，而批量恰恰是会被打满的那条路。
 */
export function hintForSummary(counts: {
  failed: number;
  unknown: number;
  skipped: number;
  authRejected: number;
  rateLimited: number;
}): HintCode | null {
  if (counts.failed > 0) {
    if (counts.authRejected > 0) return 'BALANCE_AUTH_REJECTED';
    if (counts.rateLimited > 0) return 'BALANCE_EGRESS_RATE_LIMITED';
    return 'BALANCE_UPSTREAM_UNREACHABLE';
  }
  if (counts.unknown > 0) return 'BALANCE_PARSE_MISMATCH';
  if (counts.skipped > 0) return 'BALANCE_QUERY_UNSUPPORTED';
  return null;
}

/* ------------------------------ 解析：用哪条路查 ------------------------------ */

export type QueryPlanSource = 'user-template' | 'preset';

export type QueryPlan =
  | {
      kind: 'template';
      source: 'user-template';
      presetId: null;
      /** `协议//host/path`，已剥 query。绝不回显替换过 `{key}` 的串 */
      endpoint: string;
      unit: BalanceUnit;
      template: BalanceQueryTemplate;
      timeoutMs: number;
    }
  | {
      kind: 'preset';
      source: 'preset';
      presetId: string;
      endpoint: string;
      unit: BalanceUnit;
      preset: BalancePresetSpec;
      /** preset 按 origin 自建端点，所以执行时要拿回 baseUrl */
      baseUrl: string;
      /** preset 没有自己的超时配置，沿用该上游模板里用户设的那个值 */
      timeoutMs: number;
    }
  | {
      kind: 'none';
      /** 什么都没配 / 配了但没配完。都表现为"没发请求"，刷新的分型同为 `skipped` */
      reason: 'no-template' | 'template-incomplete';
    };

/**
 * 真正会发起请求的两个分支。`kind:'none'` 不是"查失败"，而是"压根不发请求"，
 * 所以它不属于可执行计划 —— 需要执行的地方都应该收窄到这个别名，
 * 而不是各自写一遍 `Extract<...>`（写散了迟早会有一处漏掉）。
 */
export type ExecutableQueryPlan = Extract<QueryPlan, { kind: 'template' | 'preset' }>;

/**
 * 把一份**已确认可用**的模板包成执行计划。
 *
 * 自测草稿也走这里：草稿没有 enabled 语义（契约 §2「一次自测没有启用/停用之分」），
 * 只要 url 与 parse.balance 齐备就该能执行，调用方负责先校验。
 */
export function planForTemplate(
  template: BalanceQueryTemplate,
): Extract<QueryPlan, { kind: 'template' }> {
  return {
    kind: 'template',
    source: 'user-template',
    presetId: null,
    endpoint: safeEndpointLabel(template.url ?? ''),
    unit: template.parse.unit,
    template,
    timeoutMs: template.timeoutMs,
  };
}

/**
 * 纯函数解析：给一个 baseUrl 与已存模板，判断该走哪条路。
 *
 * `enabled=true` 但模板残缺（缺 url / 缺 parse.balance）时**退回 none 而不是落到 preset**：
 * 用户明确打开了模板，此刻静默改用另一条路取数，会让他看到一个来源意外的数字。
 * 残缺本身是配置问题，该被指出来（刷新 → skipped + 引导，自测 → 422），不该被兜底掩盖。
 */
export function resolveQueryPlan(baseUrl: string, template: BalanceQueryTemplate): QueryPlan {
  if (template.enabled) {
    if (template.url === null || template.parse.balance === null) {
      return { kind: 'none', reason: 'template-incomplete' };
    }
    return planForTemplate(template);
  }

  const preset = findPresetByBaseUrl(baseUrl);
  if (preset !== null) {
    return {
      kind: 'preset',
      source: 'preset',
      presetId: preset.id,
      endpoint: presetEndpoint(baseUrl, preset),
      unit: preset.unit,
      preset,
      baseUrl,
      timeoutMs: template.timeoutMs,
    };
  }

  return { kind: 'none', reason: 'no-template' };
}

/** 从库里读该上游的模板并解析。上游不存在 → 404。 */export function loadQueryPlan(db: Db, upstreamId: string): QueryPlan {
  const row = getUpstreamRow(db, upstreamId);
  if (!row) throw ApiError.notFound('上游', upstreamId);
  return resolveQueryPlan(row.base_url, normalizeBalanceQuery(JSON.parse(row.balance_query) as unknown));
}

/**
 * 需要"一定能查"的场景（刷新、按 key 自测）用它。
 *
 * 返回类型**窄化掉 `kind:'none'`**：本函数在无查询方式时直接抛错，所以调用方
 * 拿到的一定是可执行的计划。把这一点写进类型而不是靠调用方自己再判一次，
 * 是为了"不可能存在一条既调用 assertQueryable 又处理 none 的分支"。
 *
 * 无查询方式抛 `UNPROCESSABLE` 而不是 `INVALID_PARAM`：用户什么都没填错，
 * 只是这件事现在还做不了 —— 两者给前端的引导完全不同。
 */
export function assertQueryable(db: Db, upstreamId: string): ExecutableQueryPlan {
  const plan = loadQueryPlan(db, upstreamId);
  if (plan.kind === 'none') {
    throw new ApiError(
      'UNPROCESSABLE',
      plan.reason === 'template-incomplete'
        ? '该上游的余额查询模板已启用但未填完整（需要 url 与 balance 取值路径）'
        : '该上游没有可用的余额查询方式，请先配置余额查询模板',
    );
  }
  return plan;
}

/* -------------------------------- 执行：真的去打 -------------------------------- */

export interface QueryExecution {
  ok: boolean;
  parsed: ParsedBalance | null;
  errorCode: 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED' | null;
  message: string | null;
  /** 0 = 没拿到响应（不可达 / 超时） */
  httpStatus: number;
  durationMs: number;
  /** 上游原文。仅当 `captureRaw` 时非 undefined，且**必须先过 balance/raw.ts 才能外露** */
  raw: unknown;
}

export interface ExecuteOptions {
  captureRaw?: boolean;
}

/**
 * 执行一次查询。`plan` 由上面两个解析函数产出，所以调用方不可能"跳过解析直接查"。
 *
 * 失败不抛异常，一律返回 `ok:false` 的结果：批量刷新里一把 key 查不到
 * 不该让其余 50 把的进度一起丢掉。
 */
export async function executePlan(
  plan: ExecutableQueryPlan,
  target: QueryTarget,
  fetchImpl: typeof fetch = fetch,
  options: ExecuteOptions = {},
): Promise<QueryExecution> {
  const captureRaw = options.captureRaw === true;
  const started = performance.now();

  const outcome =
    plan.kind === 'template'
      ? await queryBalance(plan.template, target, fetchImpl, { captureRaw })
      : await runPreset(plan, target.decrypted, fetchImpl, captureRaw);

  return {
    ok: outcome.ok,
    parsed: outcome.parsed,
    errorCode: outcome.errorCode,
    message: outcome.message,
    httpStatus: outcome.httpStatus,
    durationMs: Math.round(performance.now() - started),
    raw: captureRaw ? outcome.raw : undefined,
  };
}

/** preset 与模板引擎的返回形状对齐后交给同一个出口。 */
async function runPreset(
  plan: Extract<QueryPlan, { kind: 'preset' }>,
  secret: string,
  fetchImpl: typeof fetch,
  captureRaw: boolean,
): Promise<{
  ok: boolean;
  parsed: ParsedBalance | null;
  errorCode: 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED' | null;
  message: string | null;
  httpStatus: number;
  raw: unknown;
}> {
  const res = await plan.preset.run({
    baseUrl: plan.baseUrl,
    secret,
    timeoutMs: plan.timeoutMs,
    fetchImpl,
  });
  // preset 的执行器总会把上游原文带回来（它的端点不可编辑，raw 是唯一能解释"为什么取不到"的东西）。
  // 不采集时在这里丢掉，别让它被上层无意间留着 —— 那是明文 key 可能出现的地方之一。
  return captureRaw ? res : { ...res, raw: undefined };
}
