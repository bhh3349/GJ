// key 运行态仓储（`key_runtime` 表）。冻结依据：docs/api-contract.md §3 / §9，ADR-0010。
//
// 方向是**单向**的，别搞反：
//   网关进程 → key_runtime → 管理端只读展示（`health` / `cooldownUntil` / `consecutiveFailures`）
// 网关内存里的 KeyPool 才是运行态的**权威源**；本表只是它的**镜像**，供管理端在 SQL 里
// 分页/筛选（`src/db/repo/keys.ts` 的 LEFT JOIN 与 `?health=` 都读它），以及给冷启动留个
// 最后状态。镜像不是契约，**网关运行时从不读它** —— 冷启动也不读，见 ADR-0010 第 3 条。
//
// 谁写：**只有网关进程**，且只在批量刷写时写（约 1s 一次，不在 `/v1/*` 请求线程上）。
// 管理端不提供任何写入口 —— `src/db/repo/keys.ts` 里没有、也不会有 upsert 本表的函数。
//
// 时间列一律 ISO8601 UTC 字符串（契约 §0.2），而 KeyPool 内部用 epoch ms，
// 转换只在本文件发生，别让 ms 数字漏进 SQL。

import { nowIso } from '../../util/time.js';
import type { Db } from '../database.js';
import type { FailureReason } from '../../gateway/types.js';

/** 一把 key 的当前运行态（epoch ms；与 `KeyRuntimeState` 对齐，但只取要落库的字段） */
export interface KeyRuntimeStateRow {
  keyId: string;
  /** 连续失败次数；决定冷却档位。成功一次即归零 */
  consecutiveFails: number;
  /** 冷却截止（epoch ms）；null = 不在冷却中 */
  cooldownUntilMs: number | null;
  lastFailureReason: FailureReason | null;
  /** 最后一次失败时刻（epoch ms）；null = 从未失败 */
  lastFailureAtMs: number | null;
}

const UPSERT_SQL = `
INSERT INTO key_runtime
       (key_id, consecutive_failures, cooldown_until, last_failure_reason, last_failure_at, updated_at)
VALUES (@keyId, @consecutiveFailures, @cooldownUntil, @lastFailureReason, @lastFailureAt, @updatedAt)
ON CONFLICT(key_id) DO UPDATE SET
       consecutive_failures = excluded.consecutive_failures,
       cooldown_until       = excluded.cooldown_until,
       last_failure_reason  = excluded.last_failure_reason,
       last_failure_at      = excluded.last_failure_at,
       updated_at           = excluded.updated_at
`;

/** epoch ms → ISO8601 UTC；null 原样透传（"没有"就是 SQL NULL，不写成 0 或空串） */
function msToIso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * 批量镜像运行态。一次事务写完一批（单写者原则下这是最省的形态）。
 *
 * 幂等：同一行重复写只是覆盖同值，所以调用方可以放心"全量重写"——
 * 这正是冷启动后纠正上一进程遗留行的手段（ADR-0010 第 4 条）。
 *
 * 只写传进来的行：**不删任何行**。key 被软删后它的运行态行会留在表里，
 * 但管理端列表按 live key 过滤，看不见；清理由 M4 的 `src/db` 改造清单负责（ADR-0010 已知缺口）。
 *
 * @returns 实际写入的行数
 */
export function upsertKeyRuntimeStates(
  db: Db,
  states: readonly KeyRuntimeStateRow[],
  at: string = nowIso(),
): number {
  if (states.length === 0) return 0;

  const stmt = db.prepare(UPSERT_SQL);
  const write = db.transaction((rows: readonly KeyRuntimeStateRow[]) => {
    for (const row of rows) {
      stmt.run({
        keyId: row.keyId,
        consecutiveFailures: row.consecutiveFails,
        cooldownUntil: msToIso(row.cooldownUntilMs),
        lastFailureReason: row.lastFailureReason,
        lastFailureAt: msToIso(row.lastFailureAtMs),
        updatedAt: at,
      });
    }
  });
  write(states);
  return states.length;
}
