// 供应商账号路由。契约 §15.2 的 11 个端点全在这里。
//
// 分成两半，读的时候可以分开看：
//   - **不打上游**的五个（列表 / 详情 / 扁平套餐 / 导出 / 删除）：直接读仓储层，今天就是真数据；
//   - **要打上游管理面**的六个（import / refresh / :id/login / :id/test / keys / keys/sync）：
//     全部经 `src/supplier/tierflow.ts` 驱动器，本文件只做「解析请求 → 建任务 → 写审计」——
//     没有一行 HTTP 细节，也没有一行加解密。
//
// 订正一句此前写在这里的话：那六个等的是**凭据**（真实的手机号+密码 / 会话），不是"协议没定"。
// 管理面协议 §15 一直都在（端点、信封、quota 单位、掩码规则都成文），悬空的 §16.1.1 是**数据面**
// （`/v1/*` relay），与本文件的六个端点无关 —— 把两件事并成一件，会让"能离线做的"跟着"卡凭据的"一起停摆。
//
// **凭据纪律（§15.9）在本文件的表现只有一条：请求里只进不出。** `import` 收明文密码，
// 其余端点一个凭据字段都不收，响应里也没有任何一处能把它们带回来（`keyMasked` 是掩码）。
//
// 四个批量端点回 `202 {taskId}`，而"成了几行"要等任务跑完才知道 —— 于是审计写在**收尾回调**里，
// actor / ip 在请求那一刻用 `captureAuditActor` 取下来（理由见 http.ts 里那个函数的注释）。
// 这也是这几个 handler 不能照抄 `auditWrite(db, req, …)` 的原因：回调跑起来时 req 早过了它的一生。
//
// 鉴权/CSRF 不在这里写：`app.ts` 的 onRequest 闸门已经覆盖 `/api/*` 全量，
// 这正是把闸门放在钩子而不是散在各 handler 里的目的（新加一个路由不会漏判）。
//
// 路由顺序：`subscriptions` / `export` / `import` / `refresh` / `keys` / `keys/sync` 这些**静态**段
// 统统写在 `:id` 之前。find-my-way 本身按静态优先匹配、不依赖注册顺序，但读的人不该需要知道
// 这件事才能确认 `/api/supplier-accounts/export` 不会被当成 `:id = "export"`。

import type { FastifyInstance } from 'fastify';
import { appendAudit } from '../../db/repo/audit.js';
import {
  deleteSupplierAccount,
  listAllSupplierAccounts,
  listSupplierAccounts,
  listSupplierSubscriptions,
  requireSupplierAccount,
} from '../../db/repo/supplier-accounts.js';
import type { SupplierBatchResult } from '../dto.js';
import type { ApiContext } from '../app.js';
import { auditWrite, captureAuditActor } from '../http.js';
import { idParam, pageProps } from '../schemas.js';
import {
  loginSupplierAccount,
  startSupplierImport,
  startSupplierKeys,
  startSupplierKeysSync,
  startSupplierRefresh,
  testSupplierAccount,
} from '../services/supplier-accounts.js';
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

// ---- 六个要打上游的端点的请求体形状（§15.2）----
//
// 字段全部**可选**，必填性交给服务层判：那边抛的 `INVALID_PARAM` 带的是精确到字段的中文说明
// （`count 必须是 1..10 的整数`），比 schema 那句通用的"参数不合法"更配前端的标红输入框。
// schema 只拦下真正会成为请求级错误的东西：类型不对、`upstreamId` 整个缺失。
//
// `models` / `quotaCents` / `label` 写成 `['…','null']`：契约里这三个字段的"空"是用 `null`
// 表达的（§15.2 `models: null` = 不设白名单），只声明 `array` / `integer` 会把合法的 `null` 拒掉 ——
// 而那正是前端默认要发的值。

interface ImportBody {
  upstreamId?: string;
  text?: string;
}

interface BatchBody {
  upstreamId?: string;
  ids?: string[];
}

interface KeysBody extends BatchBody {
  count?: number;
  namePrefix?: string;
  unlimited?: boolean;
  quotaCents?: number | null;
  models?: string[] | null;
  label?: string | null;
}

/** 批量端点的审计 `detail`：**只放计数**（§15.7）。 */
function batchDetail(result: SupplierBatchResult): string {
  return `ok=${result.ok} failed=${result.failed} skipped=${result.skipped} total=${result.total}`;
}

/**
 * 批量端点的收尾审计。
 *
 * 四条路由用的是同一个函数，为的是 `detail` 的形状**只有一份**：契约 §15.7 钉了"只放计数"，
 * 而四个 handler 各写一遍就容易出现 `ok=1 failed=0` 与 `ok:1` 两种写法并存 ——
 * 事后想按 `detail` 做聚合的人会发现有两套格式，且没有任何一处会报错。
 *
 * **不带 `task=<id>`**：那句话的字面是"只放计数"，任务号是第一个非计数字段，
 * 而任务行自己带着起止时间，顺着 `ts` 对得上。要维护的是一个能被当作事实的形状。
 */
function auditBatch(
  ctx: ApiContext,
  who: { actor: string; ip: string },
  action: string,
  upstreamId: string,
  result: SupplierBatchResult,
): void {
  appendAudit(ctx.db, {
    actor: who.actor,
    ip: who.ip,
    action,
    targetType: 'upstream',
    targetId: upstreamId,
    result: 'ok',
    detail: batchDetail(result),
  });
}

export function registerSupplierAccountRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config, supplier } = ctx;

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

  /**
   * 批量导入（契约 §15.2）。`text` = 「手机号,密码」行文本 → 逐行登录并刷一次。
   *
   * **本端点只收密码型凭据**；会话型凭据不走 HTTP（§15.9 纪律 1，走操作员本机的一次性离线导入）。
   * 对已是 `credentialSource="session"` 的号补录密码是本端点的正常用法：就地升级为密码型，
   * 不新建行、不改 `id`（见服务层 `importOne`）。
   *
   * `text` 的字段级校验放在服务层：那边要按行给"第 3 行缺密码"这种逐行原因，
   * schema 只能给出一个整体结论。
   */
  app.post<{ Body: ImportBody }>(
    '/api/supplier-accounts/import',
    {
      schema: {
        body: {
          type: 'object',
          required: ['upstreamId'],
          properties: {
            upstreamId: { type: 'string', minLength: 1, maxLength: 64 },
            text: { type: 'string' },
          },
        },
      },
    },
    (req, reply) => {
      // actor / ip 必须在**这一刻**取下来（见文件头）：任务的收尾回调跑起来时，
      // 这个请求对象早过了它的一生。
      const who = captureAuditActor(req, config);
      const upstreamId = req.body.upstreamId ?? '';
      const task = startSupplierImport(supplier, req.body, {
        onFinish: (result) => auditBatch(ctx, who, 'supplier.import', upstreamId, result),
      });
      return reply.code(202).send({ taskId: task.id });
    },
  );

  /**
   * 刷余额（契约 §15.2）。`ids` 省略 = 该上游全部账号（**不按状态筛** ——
   * 会话过期的号正是最该被刷一遍的那个）。
   *
   * 无存档密码的账号不重登，直接计 `failed` 并置 `status="session_expired"`（§15.9）。
   * 那个判定在服务层，这里不做——它要先解密凭据才知道，而路由层不该碰密文。
   */
  app.post<{ Body: BatchBody }>(
    '/api/supplier-accounts/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['upstreamId'],
          properties: {
            upstreamId: { type: 'string', minLength: 1, maxLength: 64 },
            ids: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 500 },
          },
        },
      },
    },
    (req, reply) => {
      const who = captureAuditActor(req, config);
      const upstreamId = req.body.upstreamId ?? '';
      const task = startSupplierRefresh(supplier, req.body, {
        onFinish: (result) => auditBatch(ctx, who, 'supplier.refresh', upstreamId, result),
      });
      return reply.code(202).send({ taskId: task.id });
    },
  );

  /**
   * 批量新建 key 并入池（契约 §15.2）。**这是本节的目的所在。**
   *
   * 上游明文只在创建响应里出现一次，服务端当场 `aes-256-gcm` 落库（走既有 `createKey` 路径）；
   * 响应与任务 result **只回 `keyId` + `keyMasked`**。浏览器全程不持有明文 ——
   * 所以前端**不做**"一次性明文浮层"（§3 那条路是人从供应商控制台复制明文，才需要它）。
   *
   * `count` 的 1..10 校验在服务层、建任务**之前**：`count: 99` 该在这次 HTTP 里就 400，
   * 而不是变成一个"建了任务、立刻失败"的异步错误（前端要轮询一次才知道自己参数写错了）。
   */
  app.post<{ Body: KeysBody }>(
    '/api/supplier-accounts/keys',
    {
      schema: {
        body: {
          type: 'object',
          required: ['upstreamId'],
          properties: {
            upstreamId: { type: 'string', minLength: 1, maxLength: 64 },
            ids: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 500 },
            count: { type: 'integer' },
            namePrefix: { type: 'string' },
            unlimited: { type: 'boolean' },
            quotaCents: { type: ['integer', 'null'] },
            // 空数组与省略同义（§3）：两者都归一化为 `NULL` = 不限模型，服务层负责归一。
            models: { type: ['array', 'null'], items: { type: 'string' } },
            label: { type: ['string', 'null'], maxLength: 200 },
          },
        },
      },
    },
    (req, reply) => {
      const who = captureAuditActor(req, config);
      const upstreamId = req.body.upstreamId ?? '';
      const task = startSupplierKeys(supplier, req.body, {
        onFinish: (result) => auditBatch(ctx, who, 'supplier.keys.create', upstreamId, result),
      });
      return reply.code(202).send({ taskId: task.id });
    },
  );

  /**
   * 同步已有 key（掩码）+ 套餐（契约 §15.2）。
   *
   * 与 `keys` 的差别是**只读上游、只写台账**：命中的掩码只更新 `maskedKeyCount` 与账号状态，
   * 未命中的**只记数**（掩码不可逆，不创建可用凭据）；后 4 位撞号时不更新任何行（`KEY_MASK_AMBIGUOUS`）。
   */
  app.post<{ Body: BatchBody }>(
    '/api/supplier-accounts/keys/sync',
    {
      schema: {
        body: {
          type: 'object',
          required: ['upstreamId'],
          properties: {
            upstreamId: { type: 'string', minLength: 1, maxLength: 64 },
            ids: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 500 },
          },
        },
      },
    },
    (req, reply) => {
      const who = captureAuditActor(req, config);
      const upstreamId = req.body.upstreamId ?? '';
      const task = startSupplierKeysSync(supplier, req.body, {
        onFinish: (result) => auditBatch(ctx, who, 'supplier.keys.sync', upstreamId, result),
      });
      return reply.code(202).send({ taskId: task.id });
    },
  );

  /**
   * 单账号重登（契约 §15.2）。**同步**端点，回 `200 SupplierAccount`，不是任务。
   *
   * 它存在的意义就是"用存档密码换一个新会话"，所以没有密码时**当场 422**：
   * 回 200 再让 `status` 说"没重登成"，会让点了按钮的人以为自己点过了。
   *
   * 无论登成没登成都回 200 + 最新那一行 —— 失败原因（供应商错误码一类）写在
   * `status` / `statusMessage` 上，那是**操作的结果**，不是请求有问题（同 §2 自测的取向）。
   *
   * 审计：§15.7 只点名了四个批量端点与 export / delete，这里是**按 §6 的"所有写操作"下限**补的 ——
   * 一次真实登录会改写 `supplier_accounts` 的会话，而这正是本面上最该留痕的动作之一
   * （§2 的 `balance-selftest` 也是"不写业务状态、但仍写一条审计"，同款处理）。
   */
  app.post<{ Params: { id: string } }>(
    '/api/supplier-accounts/:id/login',
    { schema: { params: idParam } },
    async (req) => {
      const account = await loginSupplierAccount(supplier, req.params.id);
      auditWrite(db, req, config, {
        action: 'supplier.account.login',
        targetType: 'supplier_account',
        targetId: req.params.id,
        detail: `status=${account.status}`,
        // 重登失败不用 `result: 'fail'` 表达：那会让审计看起来像"这个请求出错了"，
        // 而请求本身是成功的（结论已如实写在响应里）。失败由 `status` 说得更准。
      });
      return account;
    },
  );

  /**
   * 连接自测（契约 §15.2，真实打一次上游）。**同步**端点，回 `200 SupplierTestResult`。
   *
   * 业务性失败（不可达 / 上游 `success:false`）一律 `200 + ok:false`：自测是**诊断**，
   * 结论本身就是要展示的东西，不该被错误分支吃掉（同 §2 `BalanceTestResult`）。
   *
   * **永不写库**（`balanceUpdatedAt` 不因此改变）—— 包括不落它顺手换回来的新会话，
   * 代价是连测两次就登两次，`loginAttempted` 让这件事在结果里看得见（见服务层的长注释）。
   * 审计是唯一例外，理由同 `:id/login`。
   */
  app.post<{ Params: { id: string } }>(
    '/api/supplier-accounts/:id/test',
    { schema: { params: idParam } },
    async (req, reply) => {
      const result = await testSupplierAccount(supplier, req.params.id);
      auditWrite(db, req, config, {
        action: 'supplier.account.test',
        targetType: 'supplier_account',
        targetId: req.params.id,
        detail: `ok=${result.ok ? 1 : 0} httpStatus=${result.httpStatus} loginAttempted=${result.loginAttempted ? 1 : 0}`,
      });
      // 显式 200：诊断结论走正常响应体，不走错误分支
      return reply.code(200).send(result);
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
