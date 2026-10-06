// 运维观测路由。契约 §12.3 / ADR-0013。
//
// 本文件只做四件事：解析参数 → 调用聚合 → 原样返回 → 回显实际窗口。
// **一行聚合 SQL 都不写在这里** —— 分位算法、分型映射、DB 探测全在 `src/db/observability.ts`
// 与 `src/db/repo/` 里，只有一处可改（与 routes/stats.ts 同一条纪律）。
//
// 全部端点**只读**：不写审计、不产生副作用。即便请求方拿的是只读维护令牌，
// 也只在这几条路径上被放行（作用域校验在 app.ts 的 onRequest 闸门里，不放这里 ——
// 放在闸门里就不可能有人新加一条观测路由时忘了判）。
//
// 每一条列表响应都带 `range`：回显**实际生效**的窗口，前端按回显渲染、不自算本地时间。
// 同 §6 回显降档后 `bucket` 的惯例。

import type { FastifyInstance } from 'fastify';
import type { GatewayErrorCategory, GatewayErrorSeverity } from '../dto.js';
import { computeHealthMetrics } from '../../db/observability.js';
import {
  getGatewayErrorEvent,
  listGatewayErrorEvents,
} from '../../db/repo/gateway-events.js';
import { listHealthSnapshots } from '../../db/repo/health-snapshots.js';
import { ApiError } from '../errors.js';
import { pageProps, idParam } from '../schemas.js';
import { isIso8601WithTz } from '../../util/time.js';
import type { ApiContext } from '../app.js';
import { parseWindow } from './stats.js';

/**
 * 事件/快照查询的窗口跨度上限。**30 天**与环境里的保留期解耦：
 * 保留期决定"库里还有多久的数据"，上限决定"一次查询允许搬多少"。
 * 混成一个值的话，把保留期从 30 天调到 90 天会顺带让单次查询变慢三倍。
 */
const MAX_SPAN_DAYS = 30;
const MAX_SPAN_MS = MAX_SPAN_DAYS * 86_400_000;

/** 两个列表端点各自的默认窗口（契约 §12.3）。 */
const DEFAULT_ERRORS_WINDOW_MS = 3600_000; // 1h
const DEFAULT_SNAPSHOTS_WINDOW_MS = 6 * 3600_000; // 6h

const CATEGORIES: readonly GatewayErrorCategory[] = [
  'CLIENT_REQUEST',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'NO_AVAILABLE_KEY',
  'UPSTREAM_ERROR',
  'UPSTREAM_TIMEOUT',
  'CLIENT_ABORTED',
  'INTERNAL',
];

const SEVERITIES: readonly GatewayErrorSeverity[] = ['warn', 'error'];

interface TreeQuery {
  window?: string;
}

interface ListQuery {
  from?: string;
  to?: string;
  category?: string;
  severity?: string;
  upstreamId?: string;
  keyId?: string;
  model?: string;
  /** 关联键精确匹配（契约 §6「关联键 `x-request-id`」/ ADR-0014） */
  requestId?: string;
  page?: number;
  pageSize?: number;
}

/**
 * 解析时间窗：`from`/`to` 都可省。
 *
 * 三条规则都写在这里，不散在 handler 里：
 *   1. 必须是**带时区**的 ISO8601（不带时区会被 `Date.parse` 按服务器本地时区解释，
 *      换个 TZ 环境同一份查询就整体偏移几小时，且没人会发现）；
 *   2. 只给 `to` 或都不给 → `from` 取 `to - 默认跨度`；只给 `from` → `to` 取现在；
 *   3. 跨度上限 30 天，超限 400，`details.field='from'`。
 */
function resolveRange(
  query: Pick<ListQuery, 'from' | 'to'>,
  defaultSpanMs: number,
  now: Date,
): { from: string; to: string } {
  const rawTo = query.to;
  const rawFrom = query.from;

  if (rawTo !== undefined && !isIso8601WithTz(rawTo)) {
    throw ApiError.invalidParam('to', 'to 必须是带时区的 ISO8601');
  }
  if (rawFrom !== undefined && !isIso8601WithTz(rawFrom)) {
    throw ApiError.invalidParam('from', 'from 必须是带时区的 ISO8601');
  }

  const toMs = rawTo === undefined ? now.getTime() : Date.parse(rawTo);
  const fromMs = rawFrom === undefined ? toMs - defaultSpanMs : Date.parse(rawFrom);

  if (fromMs >= toMs) throw ApiError.invalidParam('to', 'to 必须晚于 from');
  if (toMs - fromMs > MAX_SPAN_MS) {
    throw ApiError.invalidParam('from', `查询跨度最长 ${MAX_SPAN_DAYS} 天`);
  }

  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

/**
 * 解析 `category`：逗号分隔多值（最多 9 个）。
 *
 * 空串/纯空白段**按"不过滤"处理**（不是错误）：前端"全部分型"这个选项最自然的表达
 * 就是一个空字符串，为一个正常 UI 状态回 400 只会逼前端在发请求前加特判。
 * 但一旦给了非空的段，就必须全部落在枚举内 —— 静默忽略未知分型会让用户以为
 * "筛选生效了、只是没有这类事件"，那是真的误导。
 */
function parseCategories(raw: string | undefined): GatewayErrorCategory[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return undefined;

  const out: GatewayErrorCategory[] = [];
  for (const p of parts) {
    if (!(CATEGORIES as readonly string[]).includes(p)) {
      throw ApiError.invalidParam('category', `未知分型 ${p}；取值见契约 §12.1`);
    }
    if (!out.includes(p as GatewayErrorCategory)) out.push(p as GatewayErrorCategory);
  }
  return out;
}

function parseSeverity(raw: string | undefined): GatewayErrorSeverity | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim();
  if (v === '') return undefined;
  if (!(SEVERITIES as readonly string[]).includes(v)) {
    throw ApiError.invalidParam('severity', 'severity 取值 warn | error');
  }
  return v as GatewayErrorSeverity;
}

export function registerObservabilityRoutes(app: FastifyInstance, ctx: ApiContext): void {
  // 刻意不取 `ctx.config`：本模块**不自己判鉴权**。只读令牌的作用域校验在 app.ts 的
  // onRequest 闸门里（见文件头），路由层拿到请求时身份已经定了。
  const { db } = ctx;

  app.get<{ Querystring: TreeQuery }>(
    '/api/observability/health',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { window: { type: 'string', maxLength: 10 } },
        },
      },
    },
    (req) => {
      // 默认 5m（不是 §6 overview 的 60s）：健康页是"刚才那一阵怎么样"的问题，
      // 1 分钟的窗口在低流量下样本太少，P99 基本等于"最后几次请求里最慢的那次"。
      const { seconds, label } = parseWindow(req.query.window ?? '5m');
      return computeHealthMetrics({
        db,
        windowSeconds: seconds,
        windowLabel: label,
        startedAt: ctx.startedAt,
        droppedEvents: ctx.droppedEvents(),
      });
    },
  );

  app.get<{ Querystring: ListQuery }>(
    '/api/observability/health/snapshots',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', minLength: 1, maxLength: 40 },
            to: { type: 'string', minLength: 1, maxLength: 40 },
            ...pageProps,
          },
        },
      },
    },
    (req) => {
      const { from, to } = resolveRange(req.query, DEFAULT_SNAPSHOTS_WINDOW_MS, new Date());
      const page = listHealthSnapshots(db, {
        from,
        to,
        page: req.query.page ?? 1,
        pageSize: req.query.pageSize ?? 20,
      });
      return { ...page, range: { from, to } };
    },
  );

  app.get<{ Querystring: ListQuery }>(
    '/api/observability/errors',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', minLength: 1, maxLength: 40 },
            to: { type: 'string', minLength: 1, maxLength: 40 },
            category: { type: 'string', maxLength: 200 },
            severity: { type: 'string', maxLength: 10 },
            upstreamId: { type: 'string', maxLength: 64 },
            keyId: { type: 'string', maxLength: 64 },
            model: { type: 'string', maxLength: 200 },
            requestId: { type: 'string', minLength: 8, maxLength: 64 },
            ...pageProps,
          },
        },
      },
    },
    (req) => {
      const { from, to } = resolveRange(req.query, DEFAULT_ERRORS_WINDOW_MS, new Date());
      const page = listGatewayErrorEvents(db, {
        from,
        to,
        categories: parseCategories(req.query.category),
        severity: parseSeverity(req.query.severity),
        upstreamId: req.query.upstreamId,
        keyId: req.query.keyId,
        model: req.query.model,
        requestId: req.query.requestId,
        page: req.query.page ?? 1,
        pageSize: req.query.pageSize ?? 20,
      });
      return { ...page, range: { from, to } };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/observability/errors/:id',
    { schema: { params: idParam } },
    (req) => {
      const event = getGatewayErrorEvent(db, req.params.id);
      if (event === null) throw ApiError.notFound('错误事件', req.params.id);
      return event;
    },
  );
}
