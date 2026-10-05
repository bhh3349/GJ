// Key 路由。契约 §3。
//
// 本文件与 key 明文的关系只有一处：`POST /api/keys` 的请求体。
// 它被**原样**转交给 createKey，那里立刻加密落盘；本文件不持有、不复制、
// 不把它写进任何审计 detail 或日志行。
//
// 「未知 ≠ 0」在路由层的落点：`PUT /api/keys/:id/balance` 的 body 里
// `balance: 0` 与 `balance: null` 是两条不同的分支，绝不会被合并。

import type { FastifyInstance } from 'fastify';
import type { KeyCategory, KeyHealth } from '../dto.js';
import {
  batchSetEnabled,
  createKey,
  deleteKey,
  getKey,
  listKeys,
  setKeyBalance,
  updateKey,
} from '../../db/repo/keys.js';
import { ApiError } from '../errors.js';
import { auditWrite } from '../http.js';
import { idParam, includeDeletedProp, nullableInteger, nullableString, pageProps, revisionProp } from '../schemas.js';
import { countRefreshableKeys, loadUsableTemplate, refreshBalances } from '../services/balance-refresh.js';
import { startTask } from '../task-runner.js';
import type { ApiContext } from '../app.js';

interface ListKeysQuery {
  page: number;
  pageSize: number;
  upstreamId?: string;
  category?: KeyCategory;
  enabled?: boolean;
  health?: KeyHealth;
  q?: string;
  includeDeleted: boolean;
}

interface DetailQuery {
  includeDeleted: boolean;
}

interface TokenPlanBody {
  remainingTokens: number;
  expiresAt: string | null;
}

interface CreateKeyBody {
  upstreamId: string;
  key: string;
  category: KeyCategory;
  label?: string;
  weight?: number;
  balance?: number | null;
  tokenPlan?: TokenPlanBody | null;
}

interface UpdateKeyBody {
  label?: string;
  enabled?: boolean;
  weight?: number;
  category?: KeyCategory;
  tokenPlan?: TokenPlanBody | null;
  revision: number;
}

interface BalanceBody {
  balance: number | null;
  currency?: string;
  note?: string;
}

interface BatchBody {
  ids: string[];
  action: 'enable' | 'disable';
}

interface BatchRefreshBody {
  upstreamId?: string;
  keyIds?: string[];
}

const tokenPlanSchema = {
  type: ['object', 'null'],
  required: ['remainingTokens'],
  properties: {
    remainingTokens: { type: 'integer', minimum: 0 },
    expiresAt: nullableString,
  },
} as const;

export function registerKeyRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config } = ctx;

  app.get<{ Querystring: ListKeysQuery }>(
    '/api/keys',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...pageProps,
            upstreamId: { type: 'string', maxLength: 64 },
            category: { type: 'string', enum: ['balance', 'token-plan'] },
            enabled: { type: 'boolean' },
            health: { type: 'string', enum: ['healthy', 'cooling', 'disabled'] },
            q: { type: 'string', maxLength: 200 },
            includeDeleted: includeDeletedProp,
          },
        },
      },
    },
    (req) =>
      listKeys(db, {
        upstreamId: req.query.upstreamId,
        category: req.query.category,
        enabled: req.query.enabled,
        health: req.query.health,
        q: req.query.q,
        includeDeleted: req.query.includeDeleted,
        page: req.query.page,
        pageSize: req.query.pageSize,
      }),
  );

  app.get<{ Params: { id: string }; Querystring: DetailQuery }>(
    '/api/keys/:id',
    {
      schema: {
        params: idParam,
        querystring: { type: 'object', properties: { includeDeleted: includeDeletedProp } },
      },
    },
    (req) => {
      const key = getKey(db, req.params.id, req.query.includeDeleted);
      if (!key) throw ApiError.notFound('Key', req.params.id);
      return key;
    },
  );

  app.post<{ Body: CreateKeyBody }>(
    '/api/keys',
    {
      schema: {
        body: {
          type: 'object',
          required: ['upstreamId', 'key', 'category'],
          properties: {
            upstreamId: { type: 'string', minLength: 1, maxLength: 64 },
            // 明文唯一入口。上限只是防滥用（正常 key 几十字符）。
            key: { type: 'string', minLength: 1, maxLength: 512 },
            category: { type: 'string', enum: ['balance', 'token-plan'] },
            label: { type: 'string', maxLength: 100 },
            weight: { type: 'integer', minimum: 0, maximum: 1000 },
            balance: nullableInteger,
            tokenPlan: tokenPlanSchema,
          },
        },
      },
    },
    (req, reply) => {
      const { upstreamId, key, category, label, weight, balance, tokenPlan } = req.body;
      const created = createKey(
        db,
        {
          upstreamId,
          key,
          category,
          label,
          weight,
          balance,
          tokenPlan: tokenPlan ?? null,
        },
        config.masterKey,
      );
      // 审计里只出现 maskedKey（created.maskedKey），绝不含明文
      auditWrite(db, req, config, {
        action: 'key.create',
        targetType: 'key',
        targetId: created.id,
        detail: created.maskedKey,
      });
      return reply.code(201).send(created);
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateKeyBody }>(
    '/api/keys/:id',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['revision'],
          properties: {
            label: { type: 'string', maxLength: 100 },
            enabled: { type: 'boolean' },
            weight: { type: 'integer', minimum: 0, maximum: 1000 },
            category: { type: 'string', enum: ['balance', 'token-plan'] },
            tokenPlan: tokenPlanSchema,
            revision: revisionProp,
          },
        },
      },
    },
    (req) => {
      const { label, enabled, weight, category, tokenPlan, revision } = req.body;
      const updated = updateKey(db, req.params.id, {
        label,
        enabled,
        weight,
        category,
        tokenPlan: tokenPlan === null ? null : tokenPlan,
        revision,
      });
      auditWrite(db, req, config, {
        action: 'key.update',
        targetType: 'key',
        targetId: updated.id,
        detail: updated.maskedKey,
      });
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/keys/:id',
    { schema: { params: idParam } },
    (req, reply) => {
      deleteKey(db, req.params.id);
      auditWrite(db, req, config, {
        action: 'key.delete',
        targetType: 'key',
        targetId: req.params.id,
      });
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { id: string }; Body: BalanceBody }>(
    '/api/keys/:id/balance',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          // balance 必填：缺省和"置回未知"是两件事，不允许用省略来表达后者
          required: ['balance'],
          properties: {
            balance: nullableInteger,
            currency: { type: 'string', minLength: 3, maxLength: 8 },
            note: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    (req) => {
      const { balance, currency, note } = req.body;
      const updated = setKeyBalance(db, req.params.id, { balance, currency });
      auditWrite(db, req, config, {
        action: 'key.balance',
        targetType: 'key',
        targetId: updated.id,
        // 记"置为未知"还是具体金额，是审计里最有价值的一列
        detail: balance === null ? 'set-unknown' : `${balance}${currency ?? ''} ${note ?? ''}`.trim(),
      });
      return updated;
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/keys/:id/balance/refresh',
    { schema: { params: idParam } },
    (req, reply) => {
      const { id } = req.params;
      const key = getKey(db, id, false);
      if (!key) throw ApiError.notFound('Key', id);
      // 前置校验，理由同上游批量刷新：模板不可用就别起任务
      loadUsableTemplate(db, key.upstreamId);

      const task = startTask(db, 'balance_refresh', 1, (reporter) =>
        refreshBalances(db, config.masterKey, { keyIds: [id] }, reporter),
      );
      auditWrite(db, req, config, {
        action: 'key.balance_refresh',
        targetType: 'key',
        targetId: id,
        detail: task.id,
      });
      return reply.code(202).send({ taskId: task.id });
    },
  );

  app.post<{ Body: BatchBody }>(
    '/api/keys/batch',
    {
      schema: {
        body: {
          type: 'object',
          required: ['ids', 'action'],
          properties: {
            ids: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 500 },
            action: { type: 'string', enum: ['enable', 'disable'] },
          },
        },
      },
    },
    (req) => {
      const { ids, action } = req.body;
      const updated = batchSetEnabled(db, ids, action === 'enable');
      auditWrite(db, req, config, {
        action: `key.batch_${action}`,
        targetType: 'key',
        targetId: null,
        detail: `${updated}/${ids.length}`,
      });
      return { updated };
    },
  );

  app.post<{ Body: BatchRefreshBody }>(
    '/api/keys/balance/refresh',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            upstreamId: { type: 'string', maxLength: 64 },
            keyIds: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 500 },
          },
        },
      },
    },
    (req, reply) => {
      const body = req.body ?? {};
      const scope = {
        upstreamId: body.upstreamId,
        keyIds: body.keyIds !== undefined && body.keyIds.length > 0 ? body.keyIds : undefined,
      };
      const total = countRefreshableKeys(db, scope);
      const task = startTask(db, 'balance_refresh', total, (reporter) =>
        refreshBalances(db, config.masterKey, scope, reporter),
      );
      auditWrite(db, req, config, {
        action: 'key.balance_refresh_batch',
        targetType: 'key',
        targetId: scope.upstreamId ?? null,
        detail: task.id,
      });
      return reply.code(202).send({ taskId: task.id });
    },
  );
}
