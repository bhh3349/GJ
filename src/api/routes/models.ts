// 模型档案路由。契约 §5。
//
// `availableKeyIds` 由仓储层的 `availableKeysByUpstream` 统一算，本文件不自己拼 SQL ——
// 验收第 4 条要求 `/v1/models` 与档案卡 `enabled=true` 逐项 0 差异，一旦这里另写一份
// 可用性判据，两份很快就会漂移，然后档案卡开始骗人。
//
// `POST /api/models/sync` 是异步任务：202 立刻返回 taskId，真进度由同步服务推进。
// 前端轮询 `GET /api/tasks/:id`（契约明令不许做假进度条）。

import type { FastifyInstance } from 'fastify';
import type { ModelCapability, ModelType } from '../dto.js';
import { getModel, listModels, updateModel } from '../../db/repo/models.js';
import { ApiError } from '../errors.js';
import { auditWrite } from '../http.js';
import { idParam, nullableInteger, pageProps, revisionProp } from '../schemas.js';
import { resolveSyncTargets, syncModels } from '../services/model-sync.js';
import { startTask } from '../task-runner.js';
import type { ApiContext } from '../app.js';

interface ListQuery {
  upstreamId?: string;
  type?: ModelType;
  capability?: ModelCapability;
  enabled?: boolean;
  q?: string;
  page: number;
  pageSize: number;
}

interface PriceBody {
  inputPer1k: number | null;
  outputPer1k: number | null;
}

interface UpdateBody {
  enabled?: boolean;
  type?: ModelType;
  capabilities?: ModelCapability[];
  contextLength?: number | null;
  price?: PriceBody | null;
  displayName?: string | null;
  revision: number;
}

interface SyncBody {
  upstreamId?: string;
}

const MODEL_TYPES = ['chat', 'embedding', 'image', 'audio', 'rerank'] as const;
const MODEL_CAPABILITIES = ['stream', 'function_call', 'vision', 'json_mode'] as const;

export function registerModelRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config } = ctx;

  app.get<{ Querystring: ListQuery }>(
    '/api/models',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...pageProps,
            upstreamId: { type: 'string', maxLength: 64 },
            type: { type: 'string', enum: MODEL_TYPES },
            capability: { type: 'string', enum: MODEL_CAPABILITIES },
            enabled: { type: 'boolean' },
            q: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    (req) =>
      listModels(db, {
        upstreamId: req.query.upstreamId,
        type: req.query.type,
        capability: req.query.capability,
        enabled: req.query.enabled,
        q: req.query.q,
        page: req.query.page,
        pageSize: req.query.pageSize,
      }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/models/:id',
    { schema: { params: idParam } },
    (req) => {
      const model = getModel(db, req.params.id);
      if (!model) throw ApiError.notFound('模型', req.params.id);
      return model;
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateBody }>(
    '/api/models/:id',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['revision'],
          properties: {
            enabled: { type: 'boolean' },
            type: { type: 'string', enum: MODEL_TYPES },
            capabilities: {
              type: 'array',
              items: { type: 'string', enum: MODEL_CAPABILITIES },
              maxItems: 4,
              uniqueItems: true,
            },
            // 上游没给就是 null。允许显式写 null 把它改回"未知"，
            // 所以这里必须是 ['integer','null'] 而不是 nullable 之外的东西。
            contextLength: { type: ['integer', 'null'], minimum: 1 },
            price: {
              type: ['object', 'null'],
              properties: {
                inputPer1k: nullableInteger,
                outputPer1k: nullableInteger,
              },
            },
            displayName: { type: ['string', 'null'], maxLength: 100 },
            revision: revisionProp,
          },
        },
      },
    },
    (req) => {
      const { enabled, type, capabilities, contextLength, price, displayName, revision } = req.body;
      const updated = updateModel(db, req.params.id, {
        enabled,
        type,
        capabilities,
        contextLength,
        // price 为 null = 清空价格（改回未知），price 省略 = 不动
        price: price === undefined ? undefined : price === null ? null : {
          inputPer1k: price.inputPer1k ?? null,
          outputPer1k: price.outputPer1k ?? null,
        },
        displayName,
        revision,
      });
      auditWrite(db, req, config, {
        action: 'model.update',
        targetType: 'model',
        targetId: updated.id,
      });
      return updated;
    },
  );

  app.post<{ Body: SyncBody }>(
    '/api/models/sync',
    {
      schema: {
        body: {
          type: 'object',
          properties: { upstreamId: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    (req, reply) => {
      const upstreamId = (req.body ?? {}).upstreamId;
      // 先解析目标：指定的上游不存在时要当场 404，而不是建个任务让前端轮询到失败。
      const targets = resolveSyncTargets(db, upstreamId);

      const task = startTask(db, 'model_sync', targets.length, (reporter) =>
        syncModels(db, config.masterKey, upstreamId, reporter),
      );
      auditWrite(db, req, config, {
        action: 'model.sync',
        targetType: 'upstream',
        targetId: upstreamId ?? null,
        detail: `task=${task.id} upstreams=${targets.length}`,
      });
      return reply.code(202).send({ taskId: task.id });
    },
  );
}
