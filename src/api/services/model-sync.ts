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
import { decryptedKeyRefs, listKeys } from '../../db/repo/keys.js';
import { getUpstreamRow } from '../../db/repo/upstreams.js';
import { upsertModelFromSync, type SyncedModel } from '../../db/repo/models.js';
import { ApiError } from '../errors.js';
import type { TaskReporter } from '../task-runner.js';

const FETCH_TIMEOUT_MS = 15_000;

export interface SyncSummary {
  upstreams: number;
  failedUpstreams: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** 按名字推断出的 type 条数 —— 不是从上游读来的，管理员应当知道 */
  inferredTypeCount: number;
  errors: { upstreamId: string; upstreamName: string; message: string }[];
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

/** 该上游用哪把 key 去拉列表：第一把已启用的（明文只在本次 fetch 内存在）。 */
function pickSyncKey(db: Db, upstreamId: string, masterKey: Buffer): string | null {
  const page = listKeys(db, {
    upstreamId,
    enabled: true,
    includeDeleted: false,
    page: 1,
    pageSize: 1,
  });
  const keyId = page.items[0]?.id;
  if (keyId === undefined) return null;
  const refs = decryptedKeyRefs(db, { keyIds: [keyId] }, masterKey);
  return refs[0]?.decrypted ?? null;
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
      throw new Error(`上游 /v1/models 返回 ${res.status}`);
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
  fetchImpl: typeof fetch = fetch,
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

  for (const upstream of targets) {
    try {
      const credential = pickSyncKey(db, upstream.id, masterKey);
      if (credential === null) throw new Error('该上游没有已启用的 key，无法拉取模型列表');

      const names = await fetchModelNames(upstream, credential, fetchImpl);
      for (const name of names) {
        const type = inferModelType(name);
        summary.inferredTypeCount += 1;
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
        if (result.action === 'inserted') summary.inserted += 1;
        else if (result.action === 'updated') summary.updated += 1;
        else summary.unchanged += 1;
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

  if (summary.upstreams > 0 && summary.failedUpstreams === summary.upstreams) {
    throw new Error(
      `全部 ${summary.upstreams} 个上游都同步失败：${summary.errors[0]?.message ?? '未知原因'}`,
    );
  }
  return summary;
}
