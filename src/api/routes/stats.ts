// 统计路由。契约 §6。
//
// 本文件只做三件事：解析参数 → 调用聚合函数 → 原样返回。
// **一行聚合 SQL 都不写在这里** —— 口径（余额三规则、缺桶补 0、降档回显）
// 全部收在 src/db/ 里，只有一处可改。
//
// 两个刻意的取舍：
//   1. overview 的余额块**剥掉** byUpstream[].keys：这个接口是仪表盘 1s 轮询的，
//      把几百条 key 明细挂上去等于每秒搬一次全量数据。要明细的去 /api/stats/balance。
//   2. `window` 与降档后的 `bucket` 一律**回显后端实际用的值**（画师明确要求），
//      前端按回显渲染，不许用本地时间自算。

import type { FastifyInstance } from 'fastify';
import { computeGlobalBalance } from '../../db/balance.js';
import { computeOverview, computeUsage, type UsageBucket, type UsageGroupBy } from '../../db/stats.js';
import { listKeyHealth } from '../../db/repo/keys.js';
import { ApiError } from '../errors.js';
import { isIso8601WithTz } from '../../util/time.js';
import type { ApiContext } from '../app.js';

interface OverviewQuery {
  window?: string;
}

interface UsageQueryParams {
  from: string;
  to: string;
  bucket: UsageBucket;
  groupBy: UsageGroupBy;
  upstreamId?: string;
  groupId?: string;
  model?: string;
}

/** 契约 §14.3 只读端点。`upstreamId` 查无此上游 → `200` + 该条为空（列表型过滤，不报 404）。 */
interface BalanceSyncQuery {
  upstreamId?: string;
  window?: string;
}

const WINDOW_RE = /^(\d{1,5})(s|m|h)$/;
const MAX_WINDOW_SECONDS = 86_400;

/**
 * 解析 `window`：`60s` / `5m` / `1h`。
 *
 * 回显的是**归一化后的原始字符串**（小写去空白），而不是换算成秒 ——
 * 前端拿它当卡片的标题（"近 5 分钟"），换算过的 300s 会让人对不上。
 */
export function parseWindow(raw: string | undefined): { seconds: number; label: string } {
  const label = (raw ?? '60s').trim().toLowerCase();
  const m = WINDOW_RE.exec(label);
  const amount = m?.[1] === undefined ? Number.NaN : Number(m[1]);
  const unit = m?.[2];
  if (!Number.isFinite(amount) || amount <= 0 || unit === undefined) {
    throw ApiError.invalidParam('window', 'window 形如 60s / 5m / 1h');
  }
  const seconds = unit === 's' ? amount : unit === 'm' ? amount * 60 : amount * 3600;
  if (seconds > MAX_WINDOW_SECONDS) {
    throw ApiError.invalidParam('window', 'window 最长 24h');
  }
  return { seconds, label };
}

export function registerStatsRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db } = ctx;

  app.get<{ Querystring: OverviewQuery }>(
    '/api/stats/overview',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { window: { type: 'string', maxLength: 10 } },
        },
      },
    },
    (req) => {
      const { seconds, label } = parseWindow(req.query.window);
      const metrics = computeOverview(db, seconds);
      const global = computeGlobalBalance(db);
      return {
        ...metrics,
        window: label,
        balance: {
          global: {
            totalBalance: global.totalBalance,
            balanceKeyCount: global.balanceKeyCount,
            balanceUnknownKeyCount: global.balanceUnknownKeyCount,
            unlimitedKeyCount: global.unlimitedKeyCount,
            tokenPlanKeyCount: global.tokenPlanKeyCount,
            accountsBalanceUnknownCount: global.accountsBalanceUnknownCount,
            currency: global.currency,
            // 明细在 /api/stats/balance，见文件头
            byUpstream: global.byUpstream.map((u) => ({
              upstreamId: u.upstreamId,
              name: u.name,
              totalBalance: u.totalBalance,
              balanceKeyCount: u.balanceKeyCount,
              balanceUnknownKeyCount: u.balanceUnknownKeyCount,
              unlimitedKeyCount: u.unlimitedKeyCount,
              tokenPlanKeyCount: u.tokenPlanKeyCount,
              accountCount: u.accountCount,
              accountsBalance: u.accountsBalance,
              accountsBalanceUnknownCount: u.accountsBalanceUnknownCount,
              keysBalance: u.keysBalance,
            })),
          },
        },
        keyHealth: listKeyHealth(db),
      };
    },
  );

  app.get('/api/stats/balance', () => ({ global: computeGlobalBalance(db) }));

  app.get<{ Querystring: BalanceSyncQuery }>(
    '/api/stats/balance/sync',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            upstreamId: { type: 'string', maxLength: 64 },
            window: { type: 'string', maxLength: 10 },
          },
        },
      },
    },
    (req) => {
      // 默认 **6h**（契约 §14.3），与 overview 的 60s 不同，理由不是口味：
      // 同步是 15 分钟级的节奏，60s 窗口里几乎必然一个点都没有 —— 而"空图"
      // 会被读成"没在同步"。上限仍是共用的 24h。
      const { seconds } = parseWindow(req.query.window ?? '6h');
      // 只读：这里只是把调度器内存里的状态与库里的快照拼起来，**不触发任何查询**（§14.3）。
      return ctx.balanceSync.status(seconds, req.query.upstreamId);
    },
  );

  app.get<{ Querystring: UsageQueryParams }>(
    '/api/stats/usage',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['from', 'to', 'bucket', 'groupBy'],
          properties: {
            from: { type: 'string', minLength: 1, maxLength: 40 },
            to: { type: 'string', minLength: 1, maxLength: 40 },
            bucket: { type: 'string', enum: ['1m', '5m', '1h', '1d'] },
            groupBy: { type: 'string', enum: ['key', 'upstream', 'group', 'model'] },
            upstreamId: { type: 'string', maxLength: 64 },
            groupId: { type: 'string', maxLength: 64 },
            model: { type: 'string', maxLength: 200 },
          },
        },
      },
    },
    (req) => {
      const { from, to, bucket, groupBy, upstreamId, groupId, model } = req.query;
      // 时间必须是**带时区**的 ISO8601：不带时区的字符串会被 Date.parse 按本地时区解释，
      // 服务器换个 TZ 环境，同一份图表数据就整体偏移几小时，且没人会发现。
      if (!isIso8601WithTz(from)) throw ApiError.invalidParam('from', 'from 必须是带时区的 ISO8601');
      if (!isIso8601WithTz(to)) throw ApiError.invalidParam('to', 'to 必须是带时区的 ISO8601');
      if (Date.parse(from) >= Date.parse(to)) {
        throw ApiError.invalidParam('to', 'to 必须晚于 from');
      }
      // 降档发生在 computeUsage 里，返回的 result.bucket 是**实际**用的档位，原样透传给前端
      return computeUsage(db, { from, to, bucket, groupBy, upstreamId, groupId, model });
    },
  );
}
