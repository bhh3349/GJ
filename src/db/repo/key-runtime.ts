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
// 本文件是全仓**唯一**能改这张表的地方（`upstreams.ts` 的删上游子树走级联删除，见 ADR-0016）。
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

/**
 * 带**活父行守卫**的 upsert。
 *
 * 为什么不写成 `VALUES (...) ON CONFLICT DO UPDATE`（原来的形状）：
 * `key_runtime.key_id` 是 `REFERENCES upstream_keys(id)` 且开库就 `foreign_keys = ON`
 * （`src/db/database.ts`）。网关内存池落后于管理端写入时，池里可能还持有一把**行已被删掉**
 * 的 key（ADR-0016 物理删除子树 / 该 ADR 末尾给本层留的那条待评估项）。这时 `VALUES` 形态
 * 的那次 INSERT 会抛 `SQLITE_CONSTRAINT_FOREIGNKEY`，而刷写是**一次事务一批** ——
 * 一把死 key 能把同一拍里所有活 key 的运行态一起回滚（实测：批内第二条撞 FK，第一条
 * 的 `updated_at` 也停在旧值），下一拍再来一次。表现为「健康灯不更新」，不是报错。
 *
 * `INSERT … SELECT … WHERE EXISTS(活父行)` 把这件事变成**跳过**：父行不存在或被软删时
 * SELECT 不产行，`ON CONFLICT DO UPDATE` 也就不会执行（实测 `changes = 0`、不抛、
 * 同批其余行照常提交）。
 *
 * 守卫判据与 `keys.ts` 的列表口径一致：`deleted_at IS NULL` 才算活父行 —— 软删的 key
 * 在管理端已经不可达，别再为它刷新运行态（那是给死行续命，也是孤儿行的来源）。
 */
const UPSERT_SQL = `
INSERT INTO key_runtime
       (key_id, consecutive_failures, cooldown_until, last_failure_reason, last_failure_at, updated_at)
SELECT @keyId, @consecutiveFailures, @cooldownUntil, @lastFailureReason, @lastFailureAt, @updatedAt
 WHERE EXISTS (
   SELECT 1 FROM upstream_keys k WHERE k.id = @keyId AND k.deleted_at IS NULL
 )
ON CONFLICT(key_id) DO UPDATE SET
       consecutive_failures = excluded.consecutive_failures,
       cooldown_until       = excluded.cooldown_until,
       last_failure_reason  = excluded.last_failure_reason,
       last_failure_at      = excluded.last_failure_at,
       updated_at           = excluded.updated_at
`;

/**
 * 清掉没有活父行的运行态行（孤儿行）。
 *
 * 判据两条，一条都不能省：
 *   1. 父行不存在 —— key 被物理删除（ADR-0016 的子树删除先删 `key_runtime`，
 *      但删除顺序之外仍可能出现：该批次回滚、或别处直接删行）；
 *   2. 父行存在但 `deleted_at` 非空 —— key 被软删，管理端列表按 live key 过滤，
 *      这行从此不可读（ADR-0010「已知缺口 1」点名的正是这一类）。
 *
 * **不删**只是移出快照、但父行仍活着的 key 的运行态（比如被禁用的 key）：那种行管理端
 * 照样读得到，删掉它就是丢数据。孤儿行的定义是「没人再能读到它」，不是「池里没有了」。
 *
 * 幂等：第二次跑删 0 行。可安全重复调用，所以调用方不需要记账。
 *
 * @returns 实际删掉的行数
 */
const DELETE_ORPHANS_SQL = `
DELETE FROM key_runtime
 WHERE NOT EXISTS (
   SELECT 1 FROM upstream_keys k
    WHERE k.id = key_runtime.key_id AND k.deleted_at IS NULL
 )
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
 * 只写传进来的行，且只写**父行还活着**的行（见 `UPSERT_SQL` 的守卫）；不传的行保持原样。
 * 本函数**不删行** —— 孤儿行清理是 `deleteOrphanKeyRuntimeStates()`，由刷写器在启动拍
 * 与「池里刚消失 key」的拍调用（ADR-0010 已知缺口 1 的清理规则）。
 *
 * @returns 实际写入的行数（被守卫跳过的行**不计**，所以它可能小于 `states.length`）
 */
export function upsertKeyRuntimeStates(
  db: Db,
  states: readonly KeyRuntimeStateRow[],
  at: string = nowIso(),
): number {
  if (states.length === 0) return 0;

  const stmt = db.prepare(UPSERT_SQL);
  let written = 0;
  const write = db.transaction((rows: readonly KeyRuntimeStateRow[]) => {
    written = 0;
    for (const row of rows) {
      const res = stmt.run({
        keyId: row.keyId,
        consecutiveFailures: row.consecutiveFails,
        cooldownUntil: msToIso(row.cooldownUntilMs),
        lastFailureReason: row.lastFailureReason,
        lastFailureAt: msToIso(row.lastFailureAtMs),
        updatedAt: at,
      });
      written += res.changes;
    }
  });
  write(states);
  return written;
}

/**
 * 清理孤儿行（判据见 `DELETE_ORPHANS_SQL`）。跑在网关进程的刷写拍上，
 * 不在 `/v1/*` 请求线程上 —— 与 `upsertKeyRuntimeStates` 同一条纪律（ADR-0010 §2）。
 *
 * 成本：`key_runtime` 行数量级是「key 总数」，`NOT EXISTS` 走主键点查父行，
 * 不需要每拍调用（调用方只在启动态与「池里刚消失 key」时调）。
 */
export function deleteOrphanKeyRuntimeStates(db: Db): number {
  return db.prepare(DELETE_ORPHANS_SQL).run().changes;
}
