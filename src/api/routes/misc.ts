// 杂项路由：调用日志、审计、任务查询。
//
// 三者都是**只读**，也都不接受任何"能不能看"的参数 —— 全量鉴权闸门已经关过了（app.ts）。
//
// `GET /api/logs` 的 `includeDeleted` 口径与别处不同：它不是"把软删资源也列出来"，
// 而是"按 id 过滤时允许命中已软删的 upstream/key/group"。历史日志的外键在资源删掉后
// 仍然指向旧 id（契约要求保留），不放开这个开关，用户就查不到自己刚删掉那把 key 的记录。

import type { FastifyInstance } from 'fastify';
import { listAudit } from '../../db/repo/audit.js';
import { listLogs } from '../../db/repo/logs.js';
import { getTask } from '../../db/repo/tasks.js';
import { ApiError } from '../errors.js';
import { includeDeletedProp, idParam, pageProps } from '../schemas.js';
import { isIso8601WithTz } from '../../util/time.js';
import type { ApiContext } from '../app.js';

interface LogsQuery {
  from?: string;
  to?: string;
  groupId?: string;
  model?: string;
  status?: number;
  upstreamId?: string;
  keyId?: string;
  includeDeleted: boolean;
  page: number;
  pageSize: number;
}

export function registerMiscRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  app.get<{ Querystring: LogsQuery }>(
    '/api/logs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...pageProps,
            from: { type: 'string', minLength: 1, maxLength: 40 },
            to: { type: 'string', minLength: 1, maxLength: 40 },
            groupId: { type: 'string', maxLength: 64 },
            model: { type: 'string', maxLength: 200 },
            status: { type: 'integer', minimum: 100, maximum: 599 },
            upstreamId: { type: 'string', maxLength: 64 },
            keyId: { type: 'string', maxLength: 64 },
            includeDeleted: includeDeletedProp,
          },
        },
      },
    },
    (req) => {
      const { from, to } = req.query;
      // ts 列存的就是带 Z 的 ISO8601，字符串比较即时间比较；不带时区的输入
      // 会变成一次永远匹配不上的查询（静默返回空），所以这里必须当场拒掉。
      if (from !== undefined && !isIso8601WithTz(from)) {
        throw ApiError.invalidParam('from', 'from 必须是带时区的 ISO8601');
      }
      if (to !== undefined && !isIso8601WithTz(to)) {
        throw ApiError.invalidParam('to', 'to 必须是带时区的 ISO8601');
      }
      return listLogs(db, {
        from,
        to,
        groupId: req.query.groupId,
        model: req.query.model,
        status: req.query.status,
        upstreamId: req.query.upstreamId,
        keyId: req.query.keyId,
        includeDeleted: req.query.includeDeleted,
        page: req.query.page,
        pageSize: req.query.pageSize,
      });
    },
  );

  app.get<{ Querystring: { page: number; pageSize: number } }>(
    '/api/audit',
    { schema: { querystring: { type: 'object', properties: { ...pageProps } } } },
    (req) => listAudit(db, req.query.page, req.query.pageSize),
  );

  app.get<{ Params: { id: string } }>(
    '/api/tasks/:id',
    { schema: { params: idParam } },
    (req) => {
      const task = getTask(db, req.params.id);
      if (!task) throw ApiError.notFound('任务', req.params.id);
      return task;
    },
  );
}
