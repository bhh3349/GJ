// 网关错误事件仓储。契约 §12.1 / ADR-0013。
//
// 与 logs.ts 同一条纪律：**只追加、不修改**。事件是"当时发生了什么"的记录，
// 改一条事件等于篡改历史；保留期靠 prune 整批删，不靠改写。
//
// 这里是 `gateway_error_events` 的**唯一写入口**，也是"落盘前脱敏"的最后一站：
// sink 侧已经抹过一遍，这里再抹一遍 —— 抹两次是幂等的（`****` 不再匹配任何凭据形状），
// 但少抹一次是不可逆的。安全要落在"写不出去"，不是落在"调用方记得先抹"。

import type {
  GatewayErrorCategory,
  GatewayErrorEventDto,
  GatewayErrorSeverity,
  Page,
} from '../../api/dto.js';
import { nowIso } from '../../util/time.js';
import { fallbackMask, scrubMessage } from '../../util/redact.js';
import type { Db } from '../database.js';
import { newId } from '../ids.js';

/** 客户端中途断开的状态码。只存在于事件流里，不对应任何真实响应（契约 §12.1）。 */
export const CLIENT_ABORTED_STATUS = 499;

interface EventRow {
  id: string;
  ts: string;
  severity: string;
  category: string;
  status: number;
  gateway_code: string | null;
  failure_reason: string | null;
  endpoint: string;
  model: string | null;
  upstream_id: string | null;
  key_id: string | null;
  key_masked: string | null;
  stream: number;
  upstream_status: number | null;
  attempts: number;
  candidates: number | null;
  latency_ms: number | null;
  message: string | null;
}

function toDto(r: EventRow): GatewayErrorEventDto {
  return {
    id: r.id,
    ts: r.ts,
    severity: r.severity as GatewayErrorSeverity,
    category: r.category as GatewayErrorCategory,
    status: r.status,
    gatewayCode: r.gateway_code,
    failureReason: r.failure_reason as GatewayErrorEventDto['failureReason'],
    endpoint: r.endpoint,
    model: r.model,
    upstreamId: r.upstream_id,
    keyId: r.key_id,
    keyMasked: r.key_masked,
    stream: r.stream === 1,
    upstreamStatus: r.upstream_status,
    attempts: r.attempts,
    candidates: r.candidates,
    latencyMs: r.latency_ms,
    message: r.message,
  };
}

/**
 * 落库形态的事件。`severity` / `category` 由**调用方派生**（sink 侧按契约 §12.1 的映射表），
 * 仓储不猜 —— 分型映射只有一个实现处，散成两份就会漂移。
 */
export interface GatewayErrorEventInput {
  /** 缺省取当前时刻。网关侧应显式传**网关侧时刻**，落库不重打 */
  ts?: string | undefined;
  severity: GatewayErrorSeverity;
  category: GatewayErrorCategory;
  status: number;
  gatewayCode: string | null;
  failureReason: string | null;
  endpoint: string;
  model: string | null;
  upstreamId: string | null;
  keyId: string | null;
  /** 传 `null` 表示"与某把具体 key 无关"；传空串按"不知道是哪把"处理成 `****` */
  keyMasked: string | null;
  stream: boolean;
  upstreamStatus: number | null;
  attempts: number;
  candidates: number | null;
  latencyMs: number | null;
  message: string | null;
}

const INSERT_SQL = `INSERT INTO gateway_error_events (
  id, ts, severity, category, status, gateway_code, failure_reason, endpoint, model,
  upstream_id, key_id, key_masked, stream, upstream_status, attempts, candidates, latency_ms, message
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/** 入参 → 落库参数（含脱敏与掩码兜底）。批量写入与单条写入共用，防止两条路径口径分叉。 */
function toParams(input: GatewayErrorEventInput): unknown[] {
  return [
    newId('errorEvent'),
    input.ts ?? nowIso(),
    input.severity,
    input.category,
    input.status,
    input.gatewayCode,
    input.failureReason,
    input.endpoint,
    input.model,
    input.upstreamId,
    input.keyId,
    // 空串是"有 key 但认不出是哪把"，落成 `****`；显式 `null` 才保留 null 语义
    input.keyMasked === null ? null : input.keyMasked === '' ? fallbackMask() : input.keyMasked,
    input.stream ? 1 : 0,
    input.upstreamStatus,
    input.attempts,
    input.candidates,
    input.latencyMs,
    scrubMessage(input.message),
  ];
}

/** 追加一条事件。返回新 id。 */
export function appendGatewayErrorEvent(db: Db, input: GatewayErrorEventInput): string {
  const params = toParams(input);
  db.prepare(INSERT_SQL).run(...params);
  return params[0] as string;
}

/**
 * 批量追加（sink 的落点）。一个事务写完一批：单条一事务在 500ms 攒批下会产生
 * 成百次 fsync，而 WAL 下每事务的提交开销远大于行本身。
 */
export function appendGatewayErrorEvents(db: Db, inputs: readonly GatewayErrorEventInput[]): number {
  if (inputs.length === 0) return 0;
  const stmt = db.prepare(INSERT_SQL);
  const write = db.transaction((rows: readonly GatewayErrorEventInput[]) => {
    for (const row of rows) stmt.run(...toParams(row));
  });
  write(inputs);
  return inputs.length;
}

export interface ListEventsQuery {
  from?: string | undefined;
  to?: string | undefined;
  categories?: readonly GatewayErrorCategory[] | undefined;
  severity?: GatewayErrorSeverity | undefined;
  upstreamId?: string | undefined;
  keyId?: string | undefined;
  model?: string | undefined;
  page: number;
  pageSize: number;
}

function eventWhere(query: ListEventsQuery): { clause: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.from !== undefined) {
    where.push('ts >= ?');
    params.push(query.from);
  }
  if (query.to !== undefined) {
    where.push('ts <= ?');
    params.push(query.to);
  }
  if (query.categories !== undefined && query.categories.length > 0) {
    // 多值分型：`IN (?,?,?)` 展开。列表已由路由层校验过枚举，这里只拼占位符，
    // **绝不把值拼进 SQL**（值全部走绑定参数）。
    where.push(`category IN (${query.categories.map(() => '?').join(',')})`);
    params.push(...query.categories);
  }
  if (query.severity !== undefined) {
    where.push('severity = ?');
    params.push(query.severity);
  }
  if (query.upstreamId !== undefined) {
    where.push('upstream_id = ?');
    params.push(query.upstreamId);
  }
  if (query.keyId !== undefined) {
    where.push('key_id = ?');
    params.push(query.keyId);
  }
  if (query.model !== undefined) {
    where.push('model = ?');
    params.push(query.model);
  }

  return { clause: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * 事件查询。
 *
 * 排序是 `ts DESC, id DESC` 而不是只有 `ts`：同毫秒的并发失败非常常见（一次上游抖动
 * 会同时打掉一批请求），只按 ts 排序时翻页结果**不确定** —— 第二页可能重复或漏掉记录。
 * 加上 id 是为了让次序有确定的全序，翻页才成立。
 */
export function listGatewayErrorEvents(db: Db, query: ListEventsQuery): Page<GatewayErrorEventDto> {
  const { clause, params } = eventWhere(query);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM gateway_error_events ${clause}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM gateway_error_events ${clause} ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as EventRow[];

  return { items: rows.map(toDto), total, page: query.page, pageSize: query.pageSize };
}

/** 单条事件。未知 id → `null`（路由层转 404 NOT_FOUND）。 */
export function getGatewayErrorEvent(db: Db, id: string): GatewayErrorEventDto | null {
  const row = db.prepare('SELECT * FROM gateway_error_events WHERE id = ?').get(id) as EventRow | undefined;
  return row === undefined ? null : toDto(row);
}

export interface CategorySummary {
  category: GatewayErrorCategory;
  severity: GatewayErrorSeverity;
  count: number;
  lastAt: string;
}

/**
 * 窗口内的分型计数（契约 §12.2 `events.byCategory`）。
 *
 * **只列出现过的分型，不补 0**：这里没有"时间轴完整性"约束（不同于 §6 的 usage 轴），
 * 补 0 只会让响应变长，并掩盖"这种失败一次都没发生过"这个本身有价值的信息。
 *
 * severity 取自**行内**的值而不是按 category 现推：万一未来同一分型的 severity 变过，
 * 历史行仍要如实反映当时的判定。
 */
export function summarizeErrorEvents(
  db: Db,
  from: string,
  to: string,
): { total: number; byCategory: CategorySummary[] } {
  const rows = db
    .prepare(
      `SELECT category, severity, COUNT(*) AS count, MAX(ts) AS lastAt
       FROM gateway_error_events
       WHERE ts >= ? AND ts <= ?
       GROUP BY category, severity
       ORDER BY count DESC, category`,
    )
    .all(from, to) as { category: string; severity: string; count: number; lastAt: string }[];

  const byCategory = rows.map((r) => ({
    category: r.category as GatewayErrorCategory,
    severity: r.severity as GatewayErrorSeverity,
    count: r.count,
    lastAt: r.lastAt,
  }));

  return { total: byCategory.reduce((sum, r) => sum + r.count, 0), byCategory };
}

/** 保留策略：与 usage_logs 同口径（契约 §12.1）。 */
export function pruneGatewayErrorEvents(db: Db, retentionDays: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return db.prepare('DELETE FROM gateway_error_events WHERE ts < ?').run(cutoff).changes;
}
