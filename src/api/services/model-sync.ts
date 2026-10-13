// 模型同步（契约 §5）：从上游拉 `/v1/models` → 建档 → 档案卡。
//
// 关于"不造假"的取舍（重要，别改回去）：
//   OpenAI 兼容的 `/v1/models` 只返回 `{id, object, created, owned_by}` —— 它**没有**
//   能力、上下文长度、价格。这些字段在档案卡上是"未知"，不是"随便填一个"。
//   所以同步只落三样东西：模型名（id）、按名字推断的 `type`、同步时间。
//   `capabilities` 一律留空、`price`/`contextLength` 一律 null，
//   等人用 PATCH /api/models/:id 补 —— 编出来的能力会让"筛选 stream 模型"
//   这个功能从第一秒起就在骗人。
//
// `type` 的推断规则是**显式且可覆盖**的：命中关键词才算，命不中一律 chat。
// 推断结果会写进任务 result 的 counts，让管理员知道有多少条是猜出来的。

import type { Db } from '../../db/database.js';
import type { ModelType } from '../dto.js';
import { isHttpUrl } from '../../db/balance-query.js';
import { getUpstreamRow } from '../../db/repo/upstreams.js';
import { upsertModelFromSync, type SyncedModel } from '../../db/repo/models.js';
import { ApiError } from '../errors.js';
import type { TaskReporter } from '../task-runner.js';
import {
  CREDENTIAL_ATTEMPT_BUDGET,
  tryWithRotation,
  UpstreamCredentialError,
  type CredentialAttempt,
} from './credential-rotation.js';
import { probeCandidatesAfterSync, type ModelSyncProbeCounters } from './model-probe.js';

const FETCH_TIMEOUT_MS = 15_000;

export interface SyncSummary {
  upstreams: number;
  failedUpstreams: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** 本次**建档**时按名字推断出的 type 条数 —— 不是从上游读来的，管理员应当知道 */
  inferredTypeCount: number;
  errors: { upstreamId: string; upstreamName: string; message: string }[];
  /**
   * 本轮**发生过换把**时的可观测位（契约 §5 v1.11.2 / ADR-0026）：`switched === 0` 时**省略** ——
   * 字段出现即代表「第一把 key 的凭据失效、换了下一把」。聚合本次任务全部上游；**只含计数与掩码**、
   * 不含明文（`DecryptedKeyRef` 不带 `toJSON`，明文出不了序列化）。
   */
  credentials?: CredentialAttempt;
  /**
   * 尾部自动补探的六计数（契约 §5 v1.11.0 ⑤ / ADR-0024）：候选/探了/写入/跳过/失败/请求数。
   * `MODEL_PROBE_ENABLED=false` 或请求体 `{probe:false}` 时不带该字段 —— "没跑探测"与
   * "跑了但全 0"是两种状态，前端面板要区分着渲染。
   */
  probe?: ModelSyncProbeCounters;
}

interface TargetUpstream {
  id: string;
  name: string;
  baseUrl: string;
}

/** 同步目标：指定上游只同步它，否则同步全部**已启用**的上游。 */
export function resolveSyncTargets(db: Db, upstreamId: string | undefined): TargetUpstream[] {
  if (upstreamId !== undefined) {
    const row = getUpstreamRow(db, upstreamId);
    if (!row) throw ApiError.notFound('上游', upstreamId);
    return [{ id: row.id, name: row.name, baseUrl: row.base_url }];
  }
  const rows = db
    .prepare('SELECT id, name, base_url FROM upstreams WHERE enabled = 1 ORDER BY name')
    .all() as { id: string; name: string; base_url: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name, baseUrl: r.base_url }));
}

/**
 * 组装模型列表地址。
 *
 * baseUrl 允许自带 `/v1`（很多人就是这么存的），此时不能再拼一次 ——
 * `https://x/v1/v1/models` 会 404，而管理员只会看到"同步失败"，查半天。
 */
export function modelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v1$/i.test(trimmed) ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

const TYPE_HINTS: readonly { re: RegExp; type: ModelType }[] = [
  { re: /embed/i, type: 'embedding' },
  { re: /rerank/i, type: 'rerank' },
  { re: /(whisper|tts|audio|speech|voice|sovits)/i, type: 'audio' },
  { re: /(dall-e|dalle|stable-diffusion|flux|midjourney|imagen|sd[-_]?xl|image)/i, type: 'image' },
];

export function inferModelType(name: string): ModelType {
  for (const hint of TYPE_HINTS) {
    if (hint.re.test(name)) return hint.type;
  }
  return 'chat';
}

/** 从响应体里取出模型名数组。只认 OpenAI 形状与裸数组，其余一律判为"结构不认识"。 */
export function parseModelNames(body: unknown): string[] {
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
      ? ((body as { data: unknown[] }).data)
      : null;
  if (list === null) throw new Error('响应结构不是 OpenAI /v1/models（既没有 data 数组也不是数组）');

  const names: string[] = [];
  for (const item of list) {
    if (typeof item === 'string' && item !== '') {
      names.push(item);
      continue;
    }
    if (typeof item === 'object' && item !== null) {
      const id = (item as { id?: unknown }).id;
      if (typeof id === 'string' && id !== '') names.push(id);
    }
  }
  return [...new Set(names)];
}

async function fetchModelNames(
  upstream: TargetUpstream,
  credential: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const url = modelsEndpoint(upstream.baseUrl);
  if (!isHttpUrl(url)) throw new Error('上游 baseUrl 不是合法的 http(s) 地址');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${credential}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 只回状态码与主机名：URL 本身没被替换过，但错误信息会被前端和审计看到，
      // 少给它一点内部拓扑总是好的
      const message = `上游 /v1/models 返回 ${res.status}`;
      // 401/403 = 凭据失效，交给选择器换下一把（ADR-0026）；其余状态码不是换 key 能解决的
      if (res.status === 401 || res.status === 403) throw new UpstreamCredentialError(res.status, message);
      throw new Error(message);
    }
    return parseModelNames((await res.json()) as unknown);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`上游 /v1/models 超时（${FETCH_TIMEOUT_MS}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 全量/单上游同步。
 *
 * 单个上游失败**不让整个任务失败**：一个上游挂了，其余上游的档案照样该更新。
 * 但如果**所有**上游都失败，那这次同步事实上什么也没做成，必须让任务落到 failed，
 * 否则前端会显示"同步成功 0 条"，管理员以为上游已经没有模型了。
 */
export async function syncModels(
  db: Db,
  masterKey: Buffer,
  upstreamId: string | undefined,
  reporter: TaskReporter,
  /**
   * 出站 fetch。**必填、无兜底**（ADR-0021 决策 4c「8 处 fetchImpl 兜底全拆」）。
   *
   * 原为 `= fetch`：`POST /api/models/sync` 同样打上游，兜底在时**路由漏传也不会报错**，
   * 于是"注入的假 fetch / 闸包装"在这条路上失守（`routes/models.ts` 当时就没传）。
   */
  fetchImpl: typeof fetch,
  /** 凭据换把预算（ADR-0026）。默认装配常量 `CREDENTIAL_ATTEMPT_BUDGET`，测试可注入更小值。 */
  rotationBudget: number = CREDENTIAL_ATTEMPT_BUDGET,
  /** 尾部自动补探（§5 v1.11.0 ⑤）。省略 = 不补探（`MODEL_PROBE_ENABLED=false` 的装配侧形态）。 */
  probeOptions?: { enabled: boolean; limit: number; budget?: number },
): Promise<SyncSummary> {
  const targets = resolveSyncTargets(db, upstreamId);
  reporter.setTotal(targets.length);

  const summary: SyncSummary = {
    upstreams: targets.length,
    failedUpstreams: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    inferredTypeCount: 0,
    errors: [],
  };

  // 换把可观测位聚合本次任务全部上游（契约 §5 v1.11.2）：`switched === 0` 时整字段省略。
  const usedMaskedKeys: string[] = [];
  let credTried = 0;
  let credSwitched = 0;


  for (const upstream of targets) {
    try {
      const rotation = await tryWithRotation(
        db,
        upstream.id,
        masterKey,
        rotationBudget,
        async (ref) => {
          try {
            const names = await fetchModelNames(upstream, ref.decrypted, fetchImpl);
            return { outcome: 'ok' as const, value: names };
          } catch (err) {
            // 只有凭据类错误（401/403）才换把；超时/网络/5xx 直接抛，交给下面的 catch 记失败
            if (err instanceof UpstreamCredentialError) return { outcome: 'retry' as const, error: err };
            throw err;
          }
        },
        '该上游没有已启用的 key，无法拉取模型列表',
      );

      credTried += rotation.attempts.tried;
      credSwitched += rotation.attempts.switched;
      usedMaskedKeys.push(...rotation.attempts.usedMaskedKeys);

      // "本次同步涉及"的模型 id：**按上游分堆**。跨上游共用一份列表，会把 B 的模型
      // 用 A 的 baseUrl 去探（探测打到错的上游，结论还是"看起来像样"的）。
      const syncedModelIds: string[] = [];
      for (const name of rotation.result) {
        const type = inferModelType(name);
        const model: SyncedModel = {
          upstreamId: upstream.id,
          name,
          displayName: null,
          type,
          // 见文件头：上游没给的一律留空，不猜
          capabilities: [],
          contextLength: null,
          price: null,
        };
        const result = upsertModelFromSync(db, model);
        syncedModelIds.push(result.id); // "本次同步涉及"的显式记录：补探候选与时间戳等值无关（见 listProbeCandidates）
        if (result.action === 'inserted') {
          summary.inserted += 1;
          // 只有**建档**时 type 才来自推断：已存在的行以库中现值为准（ADR-0009 §3），
          // 所以这个计数回答的是"本次新猜了几条"，不是"本次猜了几分"。
          summary.inferredTypeCount += 1;
        } else if (result.action === 'updated') summary.updated += 1;
        else summary.unchanged += 1;
      }

      // 尾部自动补探（§5 v1.11.0 ⑤ / ADR-0024）：只补探**本次拉列表成功**的上游。
      // 探测失败不改任务成败（异常吞进 counters.failed）。
      if (probeOptions?.enabled === true && syncedModelIds.length > 0) {
        const counters = await probeCandidatesAfterSync(
          db,
          masterKey,
          { id: upstream.id, baseUrl: upstream.baseUrl },
          syncedModelIds,
          { limit: probeOptions.limit, budget: probeOptions.budget, fetchImpl },
        );
        const prev = summary.probe ?? { candidates: 0, probed: 0, applied: 0, skipped: 0, failed: 0, requests: 0 };
        summary.probe = {
          candidates: prev.candidates + counters.candidates,
          probed: prev.probed + counters.probed,
          applied: prev.applied + counters.applied,
          skipped: prev.skipped + counters.skipped,
          failed: prev.failed + counters.failed,
          requests: prev.requests + counters.requests,
        };
      }
    } catch (err) {
      summary.failedUpstreams += 1;
      summary.errors.push({
        upstreamId: upstream.id,
        upstreamName: upstream.name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    reporter.step();
  }

  if (credSwitched > 0) {
    summary.credentials = { tried: credTried, usedMaskedKeys, switched: credSwitched };
  }


  if (summary.upstreams > 0 && summary.failedUpstreams === summary.upstreams) {
    throw new Error(
      `全部 ${summary.upstreams} 个上游都同步失败：${summary.errors[0]?.message ?? '未知原因'}`,
    );
  }
  return summary;
}
