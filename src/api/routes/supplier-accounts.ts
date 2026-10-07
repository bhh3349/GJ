// 供应商账号路由。契约 §15.2。
//
// **本期只落五个端点**（列表 / 详情的读面 + 扁平套餐 / 导出 / 删除），这是刻意的：
// 其余六个全都要打上游**管理面**接口（import / refresh / :id/login / :id/test / keys / keys/sync）。
//
// 订正一句此前写在这里的话：那六个等的是**凭据**，不是"协议没定"。管理面协议 §15 一直都在
// （端点、信封、quota 单位、掩码规则都成文），悬空的 §16.1.1 是**数据面**（`/v1/*` relay），
// 与本文件的六个端点无关 —— 把两件事并成一件，会让"能离线做的"跟着"卡凭据的"一起停摆。
// 驱动器与 HTTP 缝已落 `src/supplier/tierflow.ts`（离线可测、零网络）；六条端点接线如实测推进。
// 这五个一个上游请求都不发，所以今天就能落地，且落完就是**真数据** —— 空表也是真数据。
//
// 鉴权/CSRF 不在这里写：`app.ts` 的 onRequest 闸门已经覆盖 `/api/*` 全量，
// 这正是把闸门放在钩子而不是散在各 handler 里的目的（新加一个路由不会漏判）。
//
// 路由顺序：`subscriptions` / `export` 两个**静态**段写在 `:id` 之前。find-my-way
// 本身按静态优先匹配、不依赖注册顺序，但读的人不该需要知道这件事才能确认
// `/api/supplier-accounts/export` 不会被当成 `:id = "export"`。

import type { FastifyInstance } from 'fastify';
import {
  deleteSupplierAccount,
  listAllSupplierAccounts,
  listSupplierAccounts,
  listSupplierSubscriptions,
  requireSupplierAccount,
} from '../../db/repo/supplier-accounts.js';
import type { ApiContext } from '../app.js';
import { auditWrite } from '../http.js';
import { idParam, pageProps } from '../schemas.js';
import {
  CSV_BOM,
  buildSupplierAccountsCsv,
} from '../services/supplier-accounts-export.js';

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
  const { db, config } = ctx;

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

  /**
   * 跨账号的扁平套餐列表（契约 §15.2）。**只读、不发上游请求**。
   *
   * 与详情里那个嵌套 `subscriptions[]` 是**同一份数据的两个切面**：那边回答"这个账号有哪些套餐"，
   * 这边回答"这堆账号的套餐排在一起、接下来谁到期"。排序因此按 `end_at` 而不是 `updated_at`
   * （见仓储层的长注释）。
   */
  app.get<{ Querystring: { upstreamId?: string; page: number; pageSize: number } }>(
    '/api/supplier-accounts/subscriptions',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...pageProps,
            upstreamId: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    (req) =>
      listSupplierSubscriptions(db, {
        upstreamId: req.query.upstreamId,
        page: req.query.page,
        pageSize: req.query.pageSize,
      }),
  );

  /**
   * 对账表导出（契约 §15.2）。**只读，但会写一条审计** —— 见下方注释。
   *
   * 不回 JSON：这一格的产出物就是文件本身，前端用一个 `<a download>` 直接带走。
   * `Content-Disposition` 由服务端给，前端不必自己拼文件名（拼了就两份实现）。
   */
  app.get<{ Querystring: { upstreamId?: string } }>(
    '/api/supplier-accounts/export',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { upstreamId: { type: 'string', maxLength: 64 } },
        },
      },
    },
    (req, reply) => {
      const accounts = listAllSupplierAccounts(db, req.query.upstreamId);
      const csv = buildSupplierAccountsCsv(accounts);

      // **GET 也写审计，这是刻意的一处**：契约 §6 的"登录 / 登出 / 所有写操作"是**下限**不是上限，
      // 而批量导出是这面上唯一一次"把全部账号清单一次性带出后端"的动作 ——
      // 不留痕的话，"谁在什么时候导过名单"事后完全不可查，而这是最该可查的那一件事。
      // `detail` 只放行数：identifier 列表正是本次要带出去的东西，写进审计等于又抄一份到别处。
      auditWrite(db, req, config, {
        action: 'supplier.export',
        targetType: 'supplier_account',
        targetId: null,
        detail: `rows=${accounts.length}`,
      });

      // 时间戳用 UTC 日期而不是本地日期：服务器时区不该改变导出文件的文件名
      // （同一个动作在不同时区的机器上产出不同文件名，归档时会被当成两份不同的表）。
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="supplier-accounts-${day}.csv"`)
        // BOM 在**外面**拼（见 service 里的注释）：让 `buildSupplierAccountsCsv` 的返回值
        // 就是表本身，测试断言不必跟一个看不见的字符缠斗。
        .send(CSV_BOM + csv);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/supplier-accounts/:id',
    { schema: { params: idParam } },
    (req) => requireSupplierAccount(db, req.params.id),
  );

  /**
   * 删账号（契约 §15.2）。`force != true` 且名下有已入池 key → `409 ACCOUNT_HAS_KEYS`。
   *
   * 与 `DELETE /api/upstreams/:id`（ADR-0016）关键差别：**这里一把 key 都不删，只解绑**。
   * 账号删了，它名下的 key 仍然可用（密文与 `upstream_keys` 行都在，网关照常转发），
   * 真删 key 会让网关在下一轮快照里少一批可用 key —— **删除账号的动作打穿了流量**。
   * 解绑后那把 key 从"账号代表其余额"变回"自己就是一份钱"，带着已有余额回到 §2 的 keysBalance。
   */
  app.delete<{ Params: { id: string }; Querystring: { force?: boolean } }>(
    '/api/supplier-accounts/:id',
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
      deleteSupplierAccount(db, req.params.id, req.query.force === true);
      auditWrite(db, req, config, {
        action: 'supplier.account.delete',
        targetType: 'supplier_account',
        targetId: req.params.id,
        detail: req.query.force === true ? 'force' : null,
      });
      return reply.code(204).send();
    },
  );
}
