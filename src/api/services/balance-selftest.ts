// 余额自测（契约 §2 / ADR-0012 §3）：两个端点共用的诊断实现。
//
// 与刷新任务的三条根本差别，决定了本文件是独立的一份而不是刷新那边的一个开关：
//   1. **同步**。自测的全部价值是"改字段路径 → 立刻看到结果"的秒级回路；
//   2. **绝不写库**。测试是预览语义，不该因为"我只是试试"就产生持久副作用；
//   3. **回全量诊断**（含上游响应原文）。刷新要省内存、要跑几十次，自测只跑一次。
//
// 安全纪律中最要紧的一条在这里：上游响应体在回给浏览器**之前**必须过
// `sanitizeUpstreamBody` —— 抹掉明文 key 的每一次出现并截断至 8KB。
// 上游偶尔会把 key 回显在报错体里（"invalid api key sk-xxx"），原样转发
// 等于把明文从服务端搬到前端，是本项目"明文永不落盘/外露"红线的直接违反。

import {
  isHttpUrl,
  normalizeBalanceQuery,
  type BalanceQueryTemplate,
  type BalanceUnit,
  type HttpMethod,
} from '../../db/balance-query.js';
import type { Db } from '../../db/database.js';
import {
  decryptedKeyRefs,
  firstUsableBalanceKeyId,
  getKeyRow,
  type DecryptedKeyRef,
} from '../../db/repo/keys.js';
import { getUpstreamRow } from '../../db/repo/upstreams.js';
import { sanitizeUpstreamBody } from '../../balance/raw.js';
import { ApiError } from '../errors.js';
import {
  assertQueryable,
  executePlan,
  hintForQueryResult,
  hintText,
  planForTemplate,
  type ExecutableQueryPlan,
} from './balance-query.js';
import type { BalanceTestResult } from '../dto.js';
import type { QueryTarget } from '../../balance/template.js';

type ResolvedPlan = ExecutableQueryPlan;

/* ------------------------------ 草稿模板的解析 ------------------------------ */

const METHODS: readonly string[] = ['GET', 'POST'];
const UNITS: readonly BalanceUnit[] = ['yuan', 'cents', 'dollar'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalPath(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * 把请求体解析成一个**可直接执行**的草稿模板。
 *
 * 刻意比 `normalizeBalanceQuery` 严格：那边是"存库时可以宽容，用的时候再拦"，
 * 这边是**即将发起网络请求**的最后一道门，任何含糊都会被绕过成一次莫名其妙的失败。
 * 缺 `method` 不默认成 GET —— 拿 GET 去打一个只认 POST 的端点，用户会看到
 * "上游返回 405"，而真正的原因是他少填了一个字段。
 *
 * `details.field` 用的是**请求体里的路径**（`url` / `parse.balance`），
 * 不是 `balanceQuery.url`：这个端点的 body 本身就是模板，前端要把红框落在哪一栏没有歧义。
 */
function parseDraft(input: unknown, stored: BalanceQueryTemplate): BalanceQueryTemplate {
  const rawInput = input === undefined || input === null ? {} : asRecord(input);
  if (rawInput === null) throw ApiError.invalidParam('body', '请求体必须是 JSON 对象');

  // 空对象（或没传 body）= 用已存模板当草稿。只要给了任一执行字段就按**完整草稿**校验，
  // 不做字段级合并：合并会让"我明明改了它"和"服务端用的还是旧值"混在一起，诊断结论就不可信了。
  const hasDraft = Object.keys(rawInput).some((k) => k !== 'keyId');
  const raw: Record<string, unknown> = hasDraft
    ? rawInput
    : {
        url: stored.url,
        method: stored.method,
        headers: stored.headers,
        body: stored.body,
        parse: stored.parse,
        timeoutMs: stored.timeoutMs,
      };

  const urlRaw = raw['url'];
  const url = typeof urlRaw === 'string' ? urlRaw.trim() : '';
  if (!isHttpUrl(url)) {
    throw ApiError.invalidParam(
      'url',
      hasDraft ? 'url 必须是 http(s) 地址' : '未传草稿时用已存模板，而该模板还没填好 url',
    );
  }

  const methodRaw = raw['method'];
  const method = typeof methodRaw === 'string' ? methodRaw.toUpperCase() : '';
  if (!METHODS.includes(method)) {
    throw ApiError.invalidParam('method', 'method 只能是 GET 或 POST');
  }

  const headersRaw = raw['headers'] === undefined || raw['headers'] === null ? {} : raw['headers'];
  const headersObj = asRecord(headersRaw);
  if (headersObj === null) throw ApiError.invalidParam('headers', 'headers 必须是 JSON 对象');
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(headersObj)) {
    if (typeof v !== 'string') throw ApiError.invalidParam('headers', `请求头 ${k} 的值必须是字符串`);
    headers[k] = v;
  }

  const bodyRaw = raw['body'];
  let body: string | null = null;
  if (bodyRaw !== undefined && bodyRaw !== null && bodyRaw !== '') {
    if (typeof bodyRaw !== 'string') throw ApiError.invalidParam('body', 'body 必须是字符串');
    body = bodyRaw;
  }

  const timeoutRaw = raw['timeoutMs'];
  if (typeof timeoutRaw !== 'number' || !Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
    throw ApiError.invalidParam('timeoutMs', 'timeoutMs 必须是正数（毫秒）');
  }

  const parseRaw = asRecord(raw['parse']);
  if (parseRaw === null) throw ApiError.invalidParam('parse', 'parse 必须是对象');

  const balance = optionalPath(parseRaw['balance']);
  if (balance === null) {
    throw ApiError.invalidParam(
      'parse.balance',
      hasDraft ? '必须给出余额取值路径' : '未传草稿时用已存模板，而该模板还没填余额取值路径',
    );
  }

  const unitRaw = parseRaw['unit'];
  if (typeof unitRaw !== 'string' || !UNITS.includes(unitRaw as BalanceUnit)) {
    throw ApiError.invalidParam('parse.unit', 'unit 只能是 yuan / cents / dollar');
  }

  return {
    // 草稿没有持久化语义，enabled 恒为 true —— 它只是"这份草稿可用"的记号，
    // 不会被写回任何地方。契约明确：传了 enabled 也忽略。
    enabled: true,
    url,
    method: method as HttpMethod,
    headers,
    body,
    parse: {
      balance,
      currency: optionalPath(parseRaw['currency']),
      remainingTokens: optionalPath(parseRaw['remainingTokens']),
      expiresAt: optionalPath(parseRaw['expiresAt']),
      unit: unitRaw as BalanceUnit,
    },
    // 上限与 normalizeBalanceQuery 一致：自测也不该挂 10 分钟。
    timeoutMs: Math.min(Math.floor(timeoutRaw), 60_000),
  };
}

/* -------------------------------- 执行与组装 -------------------------------- */

interface RawTestOutcome {
  plan: ResolvedPlan;
  ref: DecryptedKeyRef;
  ok: boolean;
  httpStatus: number;
  durationMs: number;
  parsed: { balanceCents: number | null; currency: string | null; remainingTokens: number | null; expiresAt: string | null } | null;
  errorCode: 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED' | null;
  raw: unknown;
  /** 契约 §2 v1.8.1：单查询透传（`QueryExecution.retryAfterSeconds`，本地拒绝带值，其余 null） */
  retryAfterSeconds: number | null;
  /** 本次**该类别关心的那个数**取到了没有；决定 ok 与引导码 */
  hasValue: boolean;
}

function buildResult(outcome: RawTestOutcome): BalanceTestResult {
  const p = outcome.parsed;
  const hintCode = hintForQueryResult({
    errorCode: outcome.errorCode,
    httpStatus: outcome.httpStatus,
    hasValue: outcome.hasValue,
  });
  // 契约 §2 v1.8.1：自测也带"等多久"。`RawTestOutcome` 不透传 `retryAfterSeconds`：上游真 429
  // 恒 null（值面只收本地拒绝，与刷新同纪律）；本地拒绝单发 ⇒ 无多拒绝取最大问题，恒用单值。
  return {
    ok: outcome.ok && outcome.hasValue,
    keyId: outcome.ref.keyId,
    maskedKey: outcome.ref.maskedKey,
    source: outcome.plan.source,
    presetId: outcome.plan.presetId,
    endpoint: outcome.plan.endpoint,
    httpStatus: outcome.httpStatus,
    durationMs: outcome.durationMs,
    parsed: {
      balance: p?.balanceCents ?? null,
      currency: p?.currency ?? null,
      remainingTokens: p?.remainingTokens ?? null,
      expiresAt: p?.expiresAt ?? null,
      unit: outcome.plan.unit,
    },
    raw: outcome.raw === undefined ? null : sanitizeUpstreamBody(outcome.raw, outcome.ref.decrypted),
    errorCode: outcome.errorCode,
    hintCode,
    hint: hintCode === null ? null : hintText(hintCode),
    retryAfterSeconds: outcome.retryAfterSeconds ?? null,
  };
}

/**
 * 取该 key 的明文引用。密钥解不出来/行不在都算 404 —— 对调用方而言
 * "查不到这个 key"与"这个 key 不属于该上游"没有区别，都是指错了对象。
 */
function requireRef(db: Db, upstreamId: string, keyId: string, masterKey: Buffer): DecryptedKeyRef {
  const found = decryptedKeyRefs(db, { upstreamId, keyIds: [keyId] }, masterKey)[0];
  if (!found) throw ApiError.notFound('Key', keyId);
  return found;
}

function targetOf(ref: DecryptedKeyRef): QueryTarget {
  return { keyId: ref.keyId, maskedKey: ref.maskedKey, decrypted: ref.decrypted };
}

/**
 * 审计 detail 的内容（两个路由共用）。
 *
 * 只记"用了哪条路、成没成、拿到什么状态码"，**绝不记草稿模板、URL、响应体** ——
 * 那些位置都可能出现端点地址与 `{key}` 替换后的残影。审计表是长期留存的地方，
 * 不是诊断信息该去的地方（诊断在响应体里，用户看一眼就够）。
 */
export function describeTestForAudit(
  result: Pick<BalanceTestResult, 'source' | 'ok' | 'errorCode' | 'httpStatus'>,
): string {
  return result.ok
    ? `${result.source} ok`
    : `${result.source} fail:${result.errorCode ?? 'unknown'} ${result.httpStatus}`;
}

/* --------------------------------- 两个入口 --------------------------------- */

/**
 * `POST /api/upstreams/:id/balance-template/test` —— 用草稿模板打一次真实查询。
 *
 * 不写库：`balance_cents` / `balance_source` / `balance_updated_at` 一律不碰。
 * 也**不用** preset 做兜底 —— 用户在测他自己填的东西，拿 preset 的结果回他
 * 会让他以为草稿是对的。
 *
 * `fetchImpl` 是**必填**（没有 `= fetch`）：自测打出去的是真实上游请求，和 §14 刷新、
 * §15.2 批量扣的是同一张出口配额表。留一个全局缺省，等于这条出站**永远绕过闸**，
 * 而且编译期看不出来（ADR-0021 决策 4 要防的就是"漏了一处没走闸"）。
 * 缺省值只在 `buildApp` 那一处填（`ctx.supplier.fetchImpl`），路由层照原样透传。
 */
export async function runUpstreamBalanceTest(
  db: Db,
  upstreamId: string,
  body: unknown,
  masterKey: Buffer,
  fetchImpl: typeof fetch,
): Promise<BalanceTestResult> {
  const row = getUpstreamRow(db, upstreamId);
  if (!row) throw ApiError.notFound('上游', upstreamId);

  const stored = normalizeBalanceQuery(JSON.parse(row.balance_query) as unknown);
  const draft = parseDraft(body, stored);

  const requestedKeyId = asRecord(body)?.['keyId'];
  let ref: DecryptedKeyRef;
  if (typeof requestedKeyId === 'string' && requestedKeyId !== '') {
    // 显式指定的 key 必须属于该上游，否则 404（契约 §2）
    ref = requireRef(db, upstreamId, requestedKeyId, masterKey);
  } else {
    const fallback = firstUsableBalanceKeyId(db, upstreamId);
    if (fallback === null) {
      throw new ApiError('UNPROCESSABLE', '该上游下没有可用的余额类 key（需要一把 enabled=true 的 balance key）');
    }
    ref = requireRef(db, upstreamId, fallback, masterKey);
  }

  const plan = planForTemplate(draft);
  const exec = await executePlan(plan, targetOf(ref), fetchImpl, { captureRaw: true });
  return buildResult({
    plan,
    ref,
    ok: exec.ok,
    httpStatus: exec.httpStatus,
    durationMs: exec.durationMs,
    parsed: exec.parsed,
    errorCode: exec.errorCode,
    raw: exec.raw,
    retryAfterSeconds: exec.retryAfterSeconds,
    // 草稿没有类别概念，所以"取到数"= 余额或余量任一取到。
    // 单看 balance 会让 token-plan 上游的自测永远 ok:false —— 那不是诊断，那是误导。
    hasValue: exec.parsed !== null && (exec.parsed.balanceCents !== null || exec.parsed.remainingTokens !== null),
  });
}

/**
 * `POST /api/keys/:id/test-balance` —— 用该 key 所属上游的**生效查询方式**打一次。
 *
 * "生效"= ① 用户模板 → ② 内置 preset；两条都无 → 422。所以这个端点的结论
 * 与批量刷新给这个 key 的结论是同源的：自测通了，刷新就该通。
 *
 * `fetchImpl` 必填，理由同 `runUpstreamBalanceTest`：两条自测是**同一个出口**的两次出站，
 * 一个留缺省、一个必填，等于两者在闸上不同源。
 */
export async function runKeyBalanceTest(
  db: Db,
  keyId: string,
  masterKey: Buffer,
  fetchImpl: typeof fetch,
): Promise<BalanceTestResult> {
  const row = getKeyRow(db, keyId);
  if (!row || row.deleted_at !== null) throw ApiError.notFound('Key', keyId);

  // assertQueryable 在"没有可用查询方式"时直接抛 422，所以这里拿到的必然是可执行计划，
  // 不需要（也不可能）再判一次 none。
  const plan = assertQueryable(db, row.upstream_id);
  const ref = requireRef(db, row.upstream_id, keyId, masterKey);

  const exec = await executePlan(plan, targetOf(ref), fetchImpl, { captureRaw: true });
  return buildResult({
    plan,
    ref,
    ok: exec.ok,
    httpStatus: exec.httpStatus,
    durationMs: exec.durationMs,
    parsed: exec.parsed,
    errorCode: exec.errorCode,
    raw: exec.raw,
    retryAfterSeconds: exec.retryAfterSeconds,
    hasValue:
      exec.parsed !== null &&
      (ref.category === 'balance'
        ? exec.parsed.balanceCents !== null
        : exec.parsed.remainingTokens !== null),
  });
}
