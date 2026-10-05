// 用户组路由。契约 §4。
//
// 本文件是全仓**第二个**能碰到网关 key 明文的地方（第一个是仓储层的 issue/reset）。
// 纪律与 createKey 一致，且更严：明文只作为响应的一个字段返回，绝不进审计 detail、
// 绝不进日志。审计里出现的永远只有 `maskedKey`。
//
// 配额字段的 `null` 是**有效值**（= 不限），不是"未提供"。所以 patch 的判空必须是
// `!== undefined`，schema 里也必须显式写上 'null' 类型 —— 两者少一个，前端就没法
// 把"限速 100"改回"不限速"。

import type { FastifyInstance } from 'fastify';
import {
  createGroup,
  deleteGatewayKey,
  deleteGroup,
  getGroup,
  issueGatewayKey,
  listGroups,
  resetGatewayKey,
  updateGroup,
} from '../../db/repo/groups.js';
import { ApiError } from '../errors.js';
import { auditWrite } from '../http.js';
import { idParam, nullableInteger, pageProps, revisionProp } from '../schemas.js';
import type { ApiContext } from '../app.js';

interface ListQuery {
  q?: string;
  page: number;
  pageSize: number;
}

interface CreateBody {
  name: string;
  rpm?: number | null;
  tpm?: number | null;
  dailyQuota?: number | null;
}

interface UpdateBody {
  name?: string;
  rpm?: number | null;
  tpm?: number | null;
  dailyQuota?: number | null;
  enabled?: boolean;
  revision: number;
}

/** 配额三兄弟：非负整数或 null（null = 不限）。 */
const quotaProp = { type: ['integer', 'null'], minimum: 0 } as const;

const groupKeyParams = {
  type: 'object',
  required: ['id', 'keyId'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    keyId: { type: 'string', minLength: 1, maxLength: 64 },
  },
  additionalProperties: true,
} as const;

export function registerGroupRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config } = ctx;

  app.get<{ Querystring: ListQuery }>(
    '/api/groups',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { ...pageProps, q: { type: 'string', maxLength: 200 } },
        },
      },
    },
    (req) =>
      listGroups(db, { q: req.query.q, page: req.query.page, pageSize: req.query.pageSize }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/groups/:id',
    { schema: { params: idParam } },
    (req) => {
      const group = getGroup(db, req.params.id);
      if (!group) throw ApiError.notFound('用户组', req.params.id);
      return group;
    },
  );

  app.post<{ Body: CreateBody }>(
    '/api/groups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            rpm: quotaProp,
            tpm: quotaProp,
            dailyQuota: quotaProp,
          },
        },
      },
    },
    (req, reply) => {
      const { name, rpm, tpm, dailyQuota } = req.body;
      const { group, gatewayKey } = createGroup(db, { name, rpm, tpm, dailyQuota });
      // C1：建组即签发第一把 key。审计只记 maskedKey —— 明文进审计等于明文落盘。
      auditWrite(db, req, config, {
        action: 'group.create',
        targetType: 'group',
        targetId: group.id,
        detail: gatewayKey.maskedKey,
      });
      return reply.code(201).send({ ...group, gatewayKey });
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateBody }>(
    '/api/groups/:id',
    {
      schema: {
        params: idParam,
        body: {
          type: 'object',
          required: ['revision'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 100 },
            rpm: quotaProp,
            tpm: quotaProp,
            dailyQuota: quotaProp,
            enabled: { type: 'boolean' },
            revision: revisionProp,
          },
        },
      },
    },
    (req) => {
      const { name, rpm, tpm, dailyQuota, enabled, revision } = req.body;
      const updated = updateGroup(db, req.params.id, {
        name,
        rpm,
        tpm,
        dailyQuota,
        enabled,
        revision,
      });
      auditWrite(db, req, config, {
        action: 'group.update',
        targetType: 'group',
        targetId: updated.id,
      });
      return updated;
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/groups/:id',
    { schema: { params: idParam } },
    (req, reply) => {
      deleteGroup(db, req.params.id);
      auditWrite(db, req, config, {
        action: 'group.delete',
        targetType: 'group',
        targetId: req.params.id,
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/groups/:id/keys',
    { schema: { params: idParam } },
    (req, reply) => {
      const issued = issueGatewayKey(db, req.params.id);
      auditWrite(db, req, config, {
        action: 'gateway_key.issue',
        targetType: 'group',
        targetId: req.params.id,
        detail: issued.maskedKey,
      });
      return reply.code(201).send(issued);
    },
  );

  app.post<{ Params: { id: string; keyId: string } }>(
    '/api/groups/:id/keys/:keyId/reset',
    { schema: { params: groupKeyParams } },
    (req) => {
      const { id, keyId } = req.params;
      // 旧 key 在同一个事务里被删掉，返回后立即失效（契约 §4）
      const issued = resetGatewayKey(db, id, keyId);
      auditWrite(db, req, config, {
        action: 'gateway_key.reset',
        targetType: 'group',
        targetId: id,
        detail: issued.maskedKey,
      });
      return issued;
    },
  );

  app.delete<{ Params: { id: string; keyId: string } }>(
    '/api/groups/:id/keys/:keyId',
    { schema: { params: groupKeyParams } },
    (req, reply) => {
      const { id, keyId } = req.params;
      deleteGatewayKey(db, id, keyId);
      auditWrite(db, req, config, {
        action: 'gateway_key.delete',
        targetType: 'group',
        targetId: id,
        detail: keyId,
      });
      return reply.code(204).send();
    },
  );
}
