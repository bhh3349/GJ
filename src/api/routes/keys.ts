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
import { clearKeyDepletedAndEnable } from '../../db/repo/depletion-latch.js';
import { ApiError } from '../errors.js';
import { auditWrite, captureAuditActor } from '../http.js';
import { idParam, includeDeletedProp, nullableInteger, nullableString, pageProps, revisionProp } from '../schemas.js';
import { assertQueryable } from '../services/balance-query.js';
import { countRefreshableKeys, refreshBalances } from '../services/balance-refresh.js';
import { runKeyBalanceTest, describeTestForAudit } from '../services/balance-selftest.js';
import { probeKey, probeKeyOnce } from '../services/key-probe.js';
import { startTask } from '../task-runner.js';
import type { ApiContext } from '../app.js';

interface ListKeysQuery {
  page: number;
  pageSize: number;
  upstreamId?: string;
  category?: KeyCategory;
  enabled?: boolean;
  health?: KeyHealth;
  /** §20.8：透支锁存筛选（第四轴，可与 enabled / health 并用） */
  depleted?: boolean;
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
  /**
   * `'undeplete'`（§20.5 / ADR-0041）= 清锁存 + `enabled = 1`，一个动作。
   *
   * **`'enable'` 不清锁**（有意，不是遗漏）：批量启用是"把停用的都打开"，
   * 如果它顺手清锁，一次批量启用就能把整池透支 key 放回去 —— 业主说的
   * "不会再回到正常的池"当场作废。两条路分得很清。
   */
  action: 'enable' | 'disable' | 'undeplete';
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
            depleted: { type: 'boolean' },
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
        depleted: req.query.depleted,
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
      // 建 key 自动保活（ADR-0050 / 契约 §3.1）：新 key 落库后**立刻用真 key 打一次上游**。
      // fire-and-forget —— 不阻塞这个 201、不重试、不碰 first_used_at / 健康态，
      // 结论只落一条 `key.probe` 审计（detail 前缀 `auto=1`）。
      probeKeyOnce(db, created.id, config.masterKey, ctx.supplier.fetchImpl, captureAuditActor(req, config));
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
      // 前置校验，理由同上游批量刷新：三条路都拿不到查询方式就别起任务
      assertQueryable(db, key.upstreamId);

      const task = startTask(db, 'balance_refresh', 1, (reporter) =>
        refreshBalances(db, config.masterKey, { keyIds: [id] }, reporter, {
          trigger: 'manual',
          // 出站 fetch 走管理面那把（ADR-0021 决策 4c：兜底已拆，漏传是编译错误）
          fetchImpl: ctx.supplier.fetchImpl,
          // 单 key 作用域 → **不写快照**（那时上游合计里只有这一把是新值，记成"上游此刻的状态"
          // 会是一条半新半旧的假相，§14.3）。收尾仍然要跑：手动查通了就把退避归零。
          onUpstreamDone: ctx.balanceSync.onRefreshDone,
        }),
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

  /**
   * 单 key 余额自测（契约 §3 / §2 的 `BalanceTestResult`）。
   *
   * 无请求体：用该 key 所属上游的**生效查询方式**（用户模板 → 内置 preset）。
   * 与 `POST /api/keys/:id/balance/refresh` 的区别只有两处 —— 同步、不写库；
   * 查询方式完全同源，所以"自测通了这个 key 的刷新就会通"这句话成立。
   */
  app.post<{ Params: { id: string } }>(
    '/api/keys/:id/test-balance',
    { schema: { params: idParam } },
    async (req, reply) => {
      const result = await runKeyBalanceTest(db, req.params.id, config.masterKey, ctx.supplier.fetchImpl);
      auditWrite(db, req, config, {
        action: 'key.balance_selftest',
        targetType: 'key',
        targetId: req.params.id,
        detail: describeTestForAudit(result),
      });
      return reply.code(200).send(result);
    },
  );

  /**
   * key 探活（契约 §3 v1.24.0 / ADR-0049）—— 前端「试调一次」按钮的后端。
   *
   * 同步执行；业务失败回 `200` + `ok:false`（诊断类，与 `test-balance` 同口径）。
   * **唯一落库动作 = 下面这条审计**：detail 里零 key 明文、零上游 body 原文，
   * 只留 kind / model / 结论 / 状态码 / 错码 / 耗时。探活不动 `key_runtime`、不写 `usage_logs`。
   */
  app.post<{ Params: { id: string }; Body: { model?: string; timeoutMs?: number } | undefined }>(
    '/api/keys/:id/probe',
    {
      schema: {
        params: idParam,
        body: {
          // 无请求体必须也合法（与 test-balance 同族：管理员点一下就发，不带 payload）
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            model: { type: 'string', minLength: 1, maxLength: 200 },
            timeoutMs: { type: 'integer', minimum: 2000, maximum: 15000 },
          },
        },
      },
    },
    async (req, reply) => {
      const result = await probeKey(db, req.params.id, config.masterKey, ctx.supplier.fetchImpl, {
        model: req.body?.model,
        timeoutMs: req.body?.timeoutMs,
      });
      auditWrite(db, req, config, {
        action: 'key.probe',
        targetType: 'key',
        targetId: req.params.id,
        detail: `kind=${result.kind} model=${result.model ?? '-'} ok=${result.ok ? 1 : 0} status=${result.httpStatus ?? '-'} code=${result.probeCode ?? '-'} ${result.durationMs}ms`,
      });
      return reply.code(200).send(result);
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
            action: { type: 'string', enum: ['enable', 'disable', 'undeplete'] },
          },
        },
      },
    },
    (req) => {
      const { ids, action } = req.body;
      // 'undeplete' 走另一个仓储函数（清锁 + enabled=1），**不复用** batchSetEnabled：
      // 那两个动作的差别正是本条存在的理由，把它做成 batchSetEnabled 的一个开关
      // 等于亲手把"enable 不清锁"这条纪律埋掉。
      const updated =
        action === 'undeplete'
          ? clearKeyDepletedAndEnable(db, ids)
          : batchSetEnabled(db, ids, action === 'enable');
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
        refreshBalances(db, config.masterKey, scope, reporter, {
          trigger: 'manual',
          // 出站 fetch 走管理面那把（ADR-0021 决策 4c：兜底已拆，漏传是编译错误）
          fetchImpl: ctx.supplier.fetchImpl,
          // 不带 keyIds 时 scope 覆盖整个上游 → 每个受影响的上游各写一条快照；
          // 带了 keyIds 就是部分刷新，`wholeUpstream` 为假，一条都不写（§14.3）。
          onUpstreamDone: ctx.balanceSync.onRefreshDone,
        }),
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
