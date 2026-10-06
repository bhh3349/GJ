// 统计聚合。契约 §6。
//
// 一条纪律贯穿本文件：**后端返回序列化好的时间轴，前端不二次聚合**。
// 所以 axis 与每个 series[].points 必须等长且下标对齐 —— 缺桶补 0。
// （这里补 0 是**对的**：缺桶意味着"这个区间没有调用"，是真实的 0，
//   与余额的"未知"完全是两回事。ADR-0003 的 null 纪律不适用于计数。）
//
// bucket 计算在 SQL 里用 substr 做，不依赖 SQLite 的日期函数解析 'Z' 后缀：
// ts 是我们自己写进去的固定格式，substr 的语义是完全确定的，
// 而 strftime 对不同 SQLite 版本的 ISO8601 解析行为不完全一致。

import type { Db } from './database.js';
import { bucketMs, floorToBucket } from '../util/time.js';

export type UsageGroupBy = 'key' | 'upstream' | 'group' | 'model';
export type UsageBucket = '1m' | '5m' | '1h' | '1d';

const BUCKET_LADDER: readonly UsageBucket[] = ['1m', '5m', '1h', '1d'];

/** 单张图最多画这么多点。超了就降档（C2 裁决：允许降级，响应回显实际 bucket）。 */
const MAX_POINTS = 500;

/** 与 floorToBucket(JS) 输出完全一致的 SQL 片段。 */
function bucketExprSql(bucket: UsageBucket): string {
  switch (bucket) {
    case '1m':
      return `substr(ts, 1, 16) || ':00.000Z'`;
    case '5m':
      return `substr(ts, 1, 14) || printf('%02d', (CAST(substr(ts, 15, 2) AS INTEGER) / 5) * 5) || ':00.000Z'`;
    case '1h':
      return `substr(ts, 1, 13) || ':00:00.000Z'`;
    case '1d':
      return `substr(ts, 1, 10) || 'T00:00:00.000Z'`;
  }
}

/**
 * 按 C2 裁决自动降档：保持"点数不超过 MAX_POINTS"的最细档位。
 * 返回**实际使用**的 bucket，路由必须把它回显给前端（前端按回显渲染）。
 */
export function resolveBucket(fromIso: string, toIso: string, requested: UsageBucket): UsageBucket {
  const span = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(span) || span <= 0) return requested;

  let index = BUCKET_LADDER.indexOf(requested);
  if (index < 0) index = 0;
  while (index < BUCKET_LADDER.length - 1) {
    const current = BUCKET_LADDER[index];
    if (current === undefined) break;
    const step = bucketMs(current);
    if (step === null || span / step <= MAX_POINTS) break;
    index += 1;
  }
  return BUCKET_LADDER[index] ?? requested;
}

export interface OverviewMetrics {
  window: string;
  generatedAt: string;
  qps: number;
  successRate: number;
  requests: number;
  errors: number;
  tokens: { prompt: number; completion: number; total: number };
}

/**
 * 仪表盘窗口指标。
 *
 * `requests = 0` 时 `successRate` 取 1（无失败样本），这是约定而非事实断言 ——
 * 前端领到 `requests === 0` 必须显示"无流量"，不得把 100% 渲染成一个"很好"的假象。
 */
export function computeOverview(db: Db, windowSeconds: number): OverviewMetrics {
  const now = new Date();
  const from = new Date(now.getTime() - windowSeconds * 1000).toISOString();

  const row = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
              COALESCE(SUM(prompt_tokens), 0)     AS prompt,
              COALESCE(SUM(completion_tokens), 0) AS completion,
              COALESCE(SUM(total_tokens), 0)      AS total
       FROM usage_logs
       WHERE ts >= ?`,
    )
    .get(from) as { requests: number; errors: number; prompt: number; completion: number; total: number };

  const requests = row.requests;
  return {
    window: `${windowSeconds}s`,
    generatedAt: now.toISOString(),
    // 窗口长度由**后端**给出（画师明确要求），前端不得用本地时间自算，否则对不上
    qps: windowSeconds > 0 ? Math.round((requests / windowSeconds) * 100) / 100 : 0,
    successRate: requests === 0 ? 1 : Math.round(((requests - row.errors) / requests) * 10000) / 10000,
    requests,
    errors: row.errors,
    tokens: { prompt: row.prompt, completion: row.completion, total: row.total },
  };
}

/**
 * 图表上的一个点（契约 §6，M6-A 补 token 维度）。
 *
 * `tokens` **按构造**等于 `promptTokens + completionTokens`，不是独立取 `total_tokens`：
 * 上游偶尔上报的 total 与 prompt+completion 对不上（见 `src/gateway/usage.ts` 的
 * `total: total ?? p + c`），若各取各的，同一张图上"总 tokens"线与"输入/输出"两条线
 * 会在个别桶上对不齐 —— 这种小偏差几乎不会被发现，却会让整张图失去可信度。
 */
export interface UsagePoint {
  t: string;
  requests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  /** 该桶内 `is_estimated=1` 的调用**条数**（不是 token 数），>0 时前端标「含估算」 */
  estimatedTokens: number;
  costCents: number;
  errors: number;
}

export interface UsageSeries {
  key: string;
  label: string;
  points: UsagePoint[];
}

export interface UsageResult {
  from: string;
  to: string;
  bucket: UsageBucket;
  groupBy: UsageGroupBy;
  axis: string[];
  series: UsageSeries[];
  /**
   * `is_estimated=1` 的调用条数。**由各点 `estimatedTokens` 求和得出**，
   * 不另发一条 COUNT 查询 —— 这样契约里"它恒等于全轴 estimatedTokens 之和"
   * 就是构造性成立，而不是靠两条 SQL 的口径碰巧一致。
   */
  isEstimatedTokenCount: number;
}

export interface UsageQuery {
  from: string;
  to: string;
  bucket: UsageBucket;
  groupBy: UsageGroupBy;
  upstreamId?: string | undefined;
  groupId?: string | undefined;
  model?: string | undefined;
}

const GROUP_BY_SQL: Record<UsageGroupBy, { idExpr: string; labelExpr: string; join: string }> = {
  key: { idExpr: 'l.key_id', labelExpr: 'l.key_masked', join: '' },
  // label 取名字而不是 id：图表图例要给人看，id 是给机器用的
  upstream: { idExpr: 'l.upstream_id', labelExpr: "COALESCE(u.name, l.upstream_id)", join: 'LEFT JOIN upstreams u ON u.id = l.upstream_id' },
  group: { idExpr: 'l.group_id', labelExpr: "COALESCE(g.name, l.group_id)", join: 'LEFT JOIN groups g ON g.id = l.group_id' },
  model: { idExpr: 'l.model', labelExpr: 'l.model', join: '' },
};

export function computeUsage(db: Db, query: UsageQuery): UsageResult {
  const bucket = resolveBucket(query.from, query.to, query.bucket);
  const step = bucketMs(bucket);
  if (step === null) throw new Error(`未知 bucket: ${bucket}`);

  const g = GROUP_BY_SQL[query.groupBy];
  const where: string[] = ['l.ts >= ?', 'l.ts <= ?', `${g.idExpr} IS NOT NULL`];
  const params: unknown[] = [query.from, query.to];

  if (query.upstreamId !== undefined) {
    where.push('l.upstream_id = ?');
    params.push(query.upstreamId);
  }
  if (query.groupId !== undefined) {
    where.push('l.group_id = ?');
    params.push(query.groupId);
  }
  if (query.model !== undefined) {
    where.push('l.model = ?');
    params.push(query.model);
  }
  const clause = `WHERE ${where.join(' AND ')}`;

  const rows = db
    .prepare(
      `SELECT ${bucketExprSql(bucket)} AS bucket,
              ${g.idExpr} AS seriesKey,
              ${g.labelExpr} AS seriesLabel,
              COUNT(*) AS requests,
              COALESCE(SUM(l.prompt_tokens), 0)     AS promptTokens,
              COALESCE(SUM(l.completion_tokens), 0) AS completionTokens,
              COALESCE(SUM(CASE WHEN l.is_estimated = 1 THEN 1 ELSE 0 END), 0) AS estimatedTokens,
              COALESCE(SUM(l.cost_cents), 0)   AS costCents,
              COALESCE(SUM(CASE WHEN l.status >= 400 THEN 1 ELSE 0 END), 0) AS errors
       FROM usage_logs l
       ${g.join}
       ${clause}
       GROUP BY bucket, seriesKey
       ORDER BY seriesLabel`,
    )
    .all(...params) as {
    bucket: string;
    seriesKey: string;
    seriesLabel: string | null;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    estimatedTokens: number;
    costCents: number;
    errors: number;
  }[];

  // 轴：从 from 向下取整到桶边界，一直铺到 to（含）。必须与 points 严格等长。
  const startMs = Date.parse(floorToBucket(query.from, bucket));
  const endMs = Date.parse(query.to);
  const axis: string[] = [];
  for (let t = startMs; t <= endMs; t += step) axis.push(new Date(t).toISOString());
  if (axis.length === 0) axis.push(new Date(startMs).toISOString());

  const indexOf = new Map(axis.map((t, i) => [t, i]));
  const seriesMap = new Map<string, UsageSeries>();

  for (const r of rows) {
    let s = seriesMap.get(r.seriesKey);
    if (!s) {
      // 缺桶补 0：先把整条轴铺满 0，再按实际数据覆写
      s = {
        key: r.seriesKey,
        label: r.seriesLabel ?? r.seriesKey,
        points: axis.map((t) => ({
          t,
          requests: 0,
          tokens: 0,
          promptTokens: 0,
          completionTokens: 0,
          estimatedTokens: 0,
          costCents: 0,
          errors: 0,
        })),
      };
      seriesMap.set(r.seriesKey, s);
    }
    const i = indexOf.get(r.bucket);
    if (i === undefined) continue; // 落在轴外的桶（边界半开）直接丢弃，避免点数与轴错位
    const point = s.points[i];
    if (point === undefined) continue;
    point.requests += r.requests;
    point.promptTokens += r.promptTokens;
    point.completionTokens += r.completionTokens;
    // 契约保证的不变式，在这里由构造保证（见 UsagePoint 的注释）
    point.tokens = point.promptTokens + point.completionTokens;
    point.estimatedTokens += r.estimatedTokens;
    point.costCents += r.costCents;
    point.errors += r.errors;
  }

  const allSeries = [...seriesMap.values()];
  return {
    from: query.from,
    to: query.to,
    bucket,
    groupBy: query.groupBy,
    axis,
    series: allSeries,
    // 由各点求和得出：与 points 同源，两个数永远不会互相打架（见 UsageResult 注释）
    isEstimatedTokenCount: allSeries.reduce(
      (sum, s) => sum + s.points.reduce((acc, p) => acc + p.estimatedTokens, 0),
      0,
    ),
  };
}
