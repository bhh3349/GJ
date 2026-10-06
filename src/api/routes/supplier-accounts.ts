// 供应商账号路由。契约 §15.2。
//
// **本期只落两个只读端点**（列表 + 详情），这是刻意的：其余九个全都要打上游管理接口，
// 而 §16.1.1 的「数据面路径与协议」悬空件尚未收口 —— 在协议定死之前写调用方代码，
// 正是本仓 AGENTS.md「接口先行」要挡的那件事（不在契约未定时写调用方代码）。
// 读面不依赖任何上游调用，所以它今天就能落地，且落完就是**真数据** —— 空表也是真数据。
//
// 鉴权/CSRF 不在这里写：`app.ts` 的 onRequest 闸门已经覆盖 `/api/*` 全量，
// 这正是把闸门放在钩子而不是散在各 handler 里的目的（新加一个路由不会漏判）。

import type { FastifyInstance } from 'fastify';
import { listSupplierAccounts, requireSupplierAccount } from '../../db/repo/supplier-accounts.js';
import type { ApiContext } from '../app.js';
import { idParam, pageProps } from '../schemas.js';

interface ListQuery {
  upstreamId?: string;
  status?: string;
  q?: string;
  page: number;
  pageSize: number;
}

/**
 * 契约 §15.1 的四值枚举。
 *
 * 写成 `enum` 而不是放行的自由字符串，是为了让 `?status=activ` 这种打错**当场 400**：
 * 放飞的话它会静默返回空列表，而"筛出来是空的"和"筛的那个值根本不存在"
 * 在前端看起来一模一样，且都没有报错可追。
 */
const SUPPLIER_ACCOUNT_STATUSES = ['active', 'login_failed', 'session_expired', 'unknown'] as const;

export function registerSupplierAccountRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  app.get<{ Querystring: ListQuery }>(
    '/api/supplier-accounts',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...pageProps,
            upstreamId: { type: 'string', maxLength: 64 },
            status: { type: 'string', enum: [...SUPPLIER_ACCOUNT_STATUSES] },
            q: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    (req) =>
      listSupplierAccounts(db, {
        upstreamId: req.query.upstreamId,
        status: req.query.status,
        q: req.query.q,
        page: req.query.page,
        pageSize: req.query.pageSize,
      }),
  );

  app.get<{ Params: { id: string } }>(
    '/api/supplier-accounts/:id',
    { schema: { params: idParam } },
    (req) => requireSupplierAccount(db, req.params.id),
  );
}
