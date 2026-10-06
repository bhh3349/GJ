// 上游路由。契约 §2。
//
// baseUrl 的规范化放在这里而不是仓储层：它是**外部输入的口径**，
// 落到库里的应当是已经规整过的形态，这样网关侧拼路径时不需要再猜。

import type { FastifyInstance } from 'fastify';
import { assertUsable, isHttpUrl, normalizeBalanceQuery } from '../../db/balance-query.js';
import {
  createUpstream,
  deleteUpstream,
  getUpstream,
  listUpstreams,
  updateUpstream,
} from '../../db/repo/upstreams.js';
import { ApiError } from '../errors.js';
import { auditWrite } from '../http.js';
import { idParam, pageProps, revisionProp } from '../schemas.js';
import { assertQueryable } from '../services/balance-query.js';
import { countRefreshableKeys, refreshBalances } from '../services/balance-refresh.js';
import { runUpstreamBalanceTest, describeTestForAudit } from '../services/balance-selftest.js';
import { startTask } from '../task-runner.js';
import type { ApiContext } from '../app.js';

/**
 * 契约 §2：必须 http(s)://，无尾斜杠（根路径除外）。
 * 根路径的斜杠也一并去掉 —— 留着它，网关会拼出 `https://host//v1/models`，
 * 多数上游能容忍，少数会 404，而那是最难查的一类故障。
 */
export function normalizeBaseUrl(raw: string): string {
  const value = raw.trim();
  if (!isHttpUrl(value)) {
    throw ApiError.invalidParam('baseUrl', 'baseUrl 必须是 http(s) 地址');
  }
  const u = new URL(value);
  if (u.search !== '' || u.hash !== '') {
    throw ApiError.invalidParam('baseUrl', 'baseUrl 不能带查询串或锚点');
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

interface ListQuery {
  page: number;
  pageSize: number;
  q?: string;
  enabled?: boolean;
}

interface CreateBody {
  name: string;
  baseUrl: string;
  enabled?: boolean;
  balanceQuery?: unknown;
}

interface UpdateBody {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  balanceQuery?: unknown;
  revision: number;
}

const balanceQueryProp = { type: 'object', additionalProperties: true } as const;

export function registerUpstreamRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config } = ctx;

  app.get<{ Querystring: ListQuery }>(
    '/api/upstreams',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...pageProps,
            q: { type: 'string', maxLength: 200 },
            enabled: { type: 'boolean' },
          },
        },
      },
    },
    (req) =>
      listUpstreams(db, {
        q: req.query.q,
        enabled: req.query.enabled,
        page: req.query.page,
        pageSize: req.query.pageSize,
      }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/upstreams/:id',
    { schema: { params: idParam } },
    (req) => {
      const upstream = getUpstream(db, req.params.id);
      if (!upstream) throw ApiError.notFound('上游', req.params.id);
      return upstream;
    },
  );

  app.post<{ Body: CreateBody }>(
    '/api/upstreams',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'baseUrl'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            baseUrl: { type: 'string', minLength: 1, maxLength: 500 },
            enabled: { type: 'boolean' },
            balanceQuery: balanceQueryProp,
          },
        },
      },
    },
    (req, reply) => {
      const { name, baseUrl, enabled, balanceQuery } = req.body;

      // 模板先规范化再校验：允许"先存一个没配好的模板、稍后再补"，
      // 但一旦 enabled=true 就必须完整，否则刷新任务会挨个失败。
      let template: unknown;
      if (balanceQuery !== undefined) {
        const normalized = normalizeBalanceQuery(balanceQuery);
        if (normalized.enabled) assertUsable(normalized);
        template = normalized;
      }

      const created = createUpstream(db, {
        name,
        baseUrl: normalizeBaseUrl(baseUrl),
        enabled,
        balanceQuery: template,
      });
      auditWrite(db, req, config, {
        action: 'upstream.create',
        targetType: 'upstream',
        targetId: created.id,
      });
      return reply.code(201).send(created);
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateBody }>(
    '/api/upstreams/:id',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['revision'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            baseUrl: { type: 'string', minLength: 1, maxLength: 500 },
            enabled: { type: 'boolean' },
            balanceQuery: balanceQueryProp,
            revision: revisionProp,
          },
        },
      },
    },
    (req) => {
      const { name, baseUrl, enabled, balanceQuery, revision } = req.body;

      let template: unknown;
      if (balanceQuery !== undefined) {
        const normalized = normalizeBalanceQuery(balanceQuery);
        if (normalized.enabled) assertUsable(normalized);
        template = normalized;
      }

      const updated = updateUpstream(db, req.params.id, {
        name,
        baseUrl: baseUrl === undefined ? undefined : normalizeBaseUrl(baseUrl),
        enabled,
        balanceQuery: template,
        revision,
      });
      auditWrite(db, req, config, {
        action: 'upstream.update',
        targetType: 'upstream',
        targetId: updated.id,
      });
      return updated;
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { force?: boolean } }>(
    '/api/upstreams/:id',
    {
      schema: {
        params: idParam,
        querystring: {
          type: 'object',
          properties: { force: { type: 'boolean', default: false } },
        },
      },
    },
    (req, reply) => {
      deleteUpstream(db, req.params.id, req.query.force === true);
      auditWrite(db, req, config, {
        action: 'upstream.delete',
        targetType: 'upstream',
        targetId: req.params.id,
        detail: req.query.force === true ? 'force' : null,
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/upstreams/:id/balance/refresh',
    { schema: { params: idParam } },
    (req, reply) => {
      const { id } = req.params;
      // 前置校验：三段解析都拿不到查询方式时直接 422，而不是建一个注定全 skipped 的任务
      // 让前端转圈到轮询结束。
      assertQueryable(db, id);

      const total = countRefreshableKeys(db, { upstreamId: id });
      const task = startTask(db, 'balance_refresh', total, (reporter) =>
        refreshBalances(db, config.masterKey, { upstreamId: id }, reporter),
      );
      auditWrite(db, req, config, {
        action: 'upstream.balance_refresh',
        targetType: 'upstream',
        targetId: id,
        detail: task.id,
      });
      return reply.code(202).send({ taskId: task.id });
    },
  );

  /**
   * 余额自测（契约 §2 / ADR-0012 §3）。
   *
   * **刻意不声明 body schema**：请求体整体可省略（省略 = 用已存模板），而声明了
   * `type: 'object'` 的 schema 会把"没带 body"判成校验失败。字段级校验因此全部
   * 落在 `parseDraft` 里 —— 那边能把 `details.field` 精确指到 `parse.balance` 这一层，
   * 比 fastify 的结构化报错更适合给前端标红输入框。
   *
   * 业务性失败（上游不可达 / 取不到值）一律 `200 + ok:false`：自测是**诊断**，
   * 前端要展示诊断结论，不该被错误分支吃掉。
   */
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/upstreams/:id/balance-template/test',
    { schema: { params: idParam } },
    async (req, reply) => {
      const result = await runUpstreamBalanceTest(
        db,
        req.params.id,
        req.body,
        config.masterKey,
      );
      // 审计只记"测了什么来源、成没成"：草稿模板里有 `{key}` 占位符与端点地址，
      // 不该被抄进审计表（替换后的串更不行）。
      auditWrite(db, req, config, {
        action: 'upstream.balance_selftest',
        targetType: 'upstream',
        targetId: req.params.id,
        detail: describeTestForAudit(result),
      });
      // 显式 200：诊断结论走正常响应体，不走错误分支
      return reply.code(200).send(result);
    },
  );
}
