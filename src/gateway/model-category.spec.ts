/**
 * 端点类别准入（契约 §10 / ADR-0039）
 *
 * 守的是本次修的那个缺陷：`models.type` 曾经只活在建档与展示里，服务路径一次都不读它 ——
 * 于是任何登记过的 chat 名字打到 `/v1/embeddings` 都会被**原样转发**给上游的 `/embeddings`，
 * 上游的 404 反而被当成一次正常调用落库（`usage_logs` 多一行、`x-gateway-attempts: 1`、
 * `todayUsage()` 不带状态过滤 ⇒ 两端看到的 `requests` 都虚高）。
 *
 * 两条最容易破的线：
 *   1. **判在引擎之前**：拒绝必须 0 次真实尝试（`seen.length === 0`）—— 一旦这条红了，
 *      说明闸被挪到了引擎里，等于"类别错"会被记成"转发失败"、还可能烧 key 健康。
 *   2. **两个 handler 都要有**：漏一个就是绕过（与授权门同一条纪律）。
 *
 * 未登记的名字本闸**不表态**：存在性由引擎侧的候选集回答（既有 503），
 * 本闸只回答"这个登记过的类别，这个端点服不服务"。
 */

import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { describe, it } from 'vitest';

import type { ForwardResult, GatewayEngine } from './engine.js';
import { GATEWAY_ERROR_CODES } from './errors.js';
import type { GroupContext, GatewayAuth, ModelCatalog, ModelDescriptor } from './ports.js';
import { gatewayRoutes } from './routes.js';

/* ------------------------------ 测试台 ------------------------------ */

const GROUP: GroupContext = {
  groupId: 'grp_1',
  name: '测试组',
  enabled: true,
  rpm: null,
  tpm: null,
  dailyQuota: null,
  authorizedModels: null,
};

const EMBED: ModelDescriptor = {
  id: 'text-embedding-3-small',
  type: 'embedding',
  createdAt: '2026-10-02T00:00:00.000Z',
  ownedBy: 'openai',
  capabilities: [],
  contextLength: null,
  endpointTypes: null,
};
const CHAT_MODEL: ModelDescriptor = {
  id: 'gpt-4o',
  type: 'chat',
  createdAt: '2026-10-06T00:00:00.000Z',
  ownedBy: 'openai',
  capabilities: ['stream'],
  contextLength: 128_000,
  endpointTypes: null,
};
const IMAGE_MODEL: ModelDescriptor = {
  id: 'dall-e-3',
  type: 'image',
  createdAt: '2026-10-02T00:00:00.000Z',
  ownedBy: 'openai',
  capabilities: [],
  contextLength: null,
  endpointTypes: null,
};

function catalogOf(models: ModelDescriptor[]): ModelCatalog {
  const byName = new Map(models.map((m) => [m.id, m.type]));
  return {
    listEnabledModels: async () => models,
    resolveUpstreamModel: (m: string) => m,
    typeOf: (m: string) => byName.get(m) ?? null,
  };
}

interface Harness {
  app: FastifyInstance;
  /** 引擎**真的**被调到的次数 —— 0 才是"判在引擎之前" */
  seen: Array<Record<string, unknown>>;
}

async function build(models: ModelDescriptor[], auth?: GatewayAuth): Promise<Harness> {
  const seen: Array<Record<string, unknown>> = [];
  const ok: ForwardResult = {
    kind: 'json',
    status: 200,
    payload: { object: 'list', data: [] },
    keyId: 'k1',
    upstreamId: 'up1',
    usage: { prompt: 1, completion: 0, total: 1, isEstimated: false },
    ttfbMs: 3,
    attempts: 1,
  };
  const engine: GatewayEngine = {
    async chatCompletions(req) {
      seen.push({ endpoint: '/v1/chat/completions', ...req });
      return ok;
    },
    async embeddings(req) {
      seen.push({ endpoint: '/v1/embeddings', ...req });
      return ok;
    },
    async listModels() {
      return models;
    },
    snapshot() {
      return { at: '2026-10-06T12:00:00.000Z', keys: [] };
    },
  };

  const app = Fastify();
  await app.register(gatewayRoutes, {
    engine,
    models: catalogOf(models),
    auth: auth ?? { authenticate: async (key) => (key === 'gk-ok' ? GROUP : null) },
  });
  await app.ready();
  return { app, seen };
}

const AUTH = { authorization: 'Bearer gk-ok' };
const CHAT = '/v1/chat/completions';
const EMBEDDINGS = '/v1/embeddings';

/* ------------------------------ 用例 ------------------------------ */

describe('端点类别准入（ADR-0039）', () => {
  it('embeddings 端点打 chat 类模型 → 400 INVALID_REQUEST + param=model，且 0 次真实尝试', async () => {
    const h = await build([CHAT_MODEL, EMBED]);
    const res = await h.app.inject({
      method: 'POST',
      url: EMBEDDINGS,
      headers: AUTH,
      payload: { model: 'gpt-4o', input: 'hi' },
    });

    assert.equal(res.statusCode, 400);
    const err = (res.json() as { error: { code: string; type: string; param?: string; message: string } }).error;
    assert.equal(err.code, GATEWAY_ERROR_CODES.INVALID_REQUEST, '复用既有码：这是"参数用错了端点"，不是人不对');
    assert.equal(err.type, 'invalid_request_error');
    assert.equal(err.param, 'model');
    // 文案要能自解释：报出登记类别与端点，排障不需要再去查档案
    assert.match(err.message, /`gpt-4o`/, '文案要点名是哪个模型');
    assert.match(err.message, /`chat`/, '文案要报出该模型的登记类别');
    assert.match(err.message, new RegExp(`\\\`${EMBEDDINGS}\\\``), '文案要报出端点');
    assert.equal(h.seen.length, 0, '判在引擎之前：候选集根本不建，上游一次都没敲');
    await h.app.close();
  });

  it('chat 端点打 embedding 类模型 → 400 同样的形状，且 0 次真实尝试（反向也要挡）', async () => {
    const h = await build([CHAT_MODEL, EMBED]);
    const res = await h.app.inject({
      method: 'POST',
      url: CHAT,
      headers: AUTH,
      payload: { model: 'text-embedding-3-small', messages: [{ role: 'user', content: 'hi' }] },
    });

    assert.equal(res.statusCode, 400);
    const err = (res.json() as { error: { code: string; param?: string; message: string } }).error;
    assert.equal(err.code, GATEWAY_ERROR_CODES.INVALID_REQUEST);
    assert.equal(err.param, 'model');
    assert.match(err.message, /`embedding`/);
    assert.equal(h.seen.length, 0);
    await h.app.close();
  });

  it('正向：两个端点各自的类别都放行，引擎真的收到了请求', async () => {
    const h = await build([CHAT_MODEL, EMBED]);

    const chat = await h.app.inject({ method: 'POST', url: CHAT, headers: AUTH, payload: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(chat.statusCode, 200, 'chat 类打 chat 端点必须真的放行');
    const embed = await h.app.inject({ method: 'POST', url: EMBEDDINGS, headers: AUTH, payload: { model: 'text-embedding-3-small', input: 'hi' } });
    assert.equal(embed.statusCode, 200, 'embedding 类打 embeddings 端点必须真的放行');

    assert.equal(h.seen.length, 2, '放行必须是**真的**放行，不是"看起来放行"');
    assert.deepEqual(
      h.seen.map((s) => s.endpoint),
      [CHAT, EMBEDDINGS],
    );
    await h.app.close();
  });

  it('两个 handler 都要有这道闸：漏一个就是绕过（同一个名字在两处都被判）', async () => {
    // image 类在两处都不该放行 —— 若只装了 chat handler 那一道，embeddings 会漏过去
    const h = await build([CHAT_MODEL, EMBED, IMAGE_MODEL]);
    for (const [url, payload] of [
      [EMBEDDINGS, { model: 'dall-e-3', input: 'hi' }],
      [CHAT, { model: 'dall-e-3', messages: [{ role: 'user', content: 'hi' }] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const res = await h.app.inject({ method: 'POST', url, headers: AUTH, payload });
      assert.equal(res.statusCode, 400, `${url} 应挡下 image 类`);
      assert.equal((res.json() as { error: { param?: string } }).error.param, 'model');
    }
    assert.equal(h.seen.length, 0);
    await h.app.close();
  });

  it('**未登记**的名字本闸不表态 → 照旧进引擎（存在性由候选集回答，不在这里 400）', async () => {
    const h = await build([CHAT_MODEL, EMBED]);
    const res = await h.app.inject({
      method: 'POST',
      url: EMBEDDINGS,
      headers: AUTH,
      payload: { model: 'never-registered', input: 'hi' },
    });

    assert.equal(res.statusCode, 200, '未登记 ⇒ typeOf 返回 null ⇒ 放行，由引擎侧给 503/404');
    assert.equal(h.seen.length, 1, '本闸绝不许把"没登记"也拒在这里 —— 那是另一类判据，会让列表与闸口打架');
    await h.app.close();
  });

  it('门序：组被禁用 / 未授权 都**先于**类别门报自己的码（不许被 400 顶掉）', async () => {
    const disabled = await build([CHAT_MODEL, EMBED], {
      authenticate: async (key) => (key === 'gk-ok' ? { ...GROUP, enabled: false } : null),
    });
    const disabledRes = await disabled.app.inject({ method: 'POST', url: EMBEDDINGS, headers: AUTH, payload: { model: 'gpt-4o', input: 'hi' } });
    assert.equal(disabledRes.statusCode, 403);
    assert.equal((disabledRes.json() as { error: { code: string } }).error.code, GATEWAY_ERROR_CODES.GROUP_DISABLED);
    await disabled.app.close();

    const unauthorized = await build([CHAT_MODEL, EMBED], {
      authenticate: async (key) => (key === 'gk-ok' ? { ...GROUP, authorizedModels: ['text-embedding-3-small'] } : null),
    });
    const deniedRes = await unauthorized.app.inject({ method: 'POST', url: EMBEDDINGS, headers: AUTH, payload: { model: 'gpt-4o', input: 'hi' } });
    assert.equal(deniedRes.statusCode, 403, '没授权的模型不许因为"类别也不对"就变成 400 —— 排障方向会反');
    assert.equal((deniedRes.json() as { error: { code: string } }).error.code, GATEWAY_ERROR_CODES.MODEL_NOT_AUTHORIZED);
    assert.equal(unauthorized.seen.length, 0);
    await unauthorized.app.close();
  });

  it('/v1/models 照旧列出所有类别（读面不受准入影响）', async () => {
    const h = await build([CHAT_MODEL, EMBED, IMAGE_MODEL]);
    const res = await h.app.inject({ method: 'GET', url: '/v1/models', headers: AUTH });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(
      (res.json() as { data: Array<{ id: string }> }).data.map((m) => m.id),
      ['gpt-4o', 'text-embedding-3-small', 'dall-e-3'],
      '准入是写面的门：读面必须照样告诉调用方登记了什么',
    );
    await h.app.close();
  });
});
