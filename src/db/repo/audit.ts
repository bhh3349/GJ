// 审计仓储。契约 §6 —— 最小集：登录 / 登出 / **所有写操作**。
//
// 为什么连"失败的登录"也要写：审计的价值在于"谁在什么时候试过什么"。
// 只记成功的登录，等于把暴力破解的痕迹全部丢掉。
//
// 关于"只读不删"：这里仍然**没有** delete 函数 —— 逐行删审计的能力故意不开放，
// 那是"谁能抹掉自己的痕迹"的入口。`pruneAudit` 是唯一的清理路径，而它按**时间窗**删，
// 不认 id、不认 actor、不认 action：调用方说不出"删掉某一条"，只能说"N 天以前的都不要了"。

import type { AuditDto, Page } from '../../api/dto.js';
import { nowIso } from '../../util/time.js';
import type { Db } from '../database.js';
import { newId } from '../ids.js';

interface AuditRow {
  id: string;
  ts: string;
  actor: string;
  ip: string;
  action: string;
  target_type: string;
  target_id: string | null;
  result: string;
  detail: string | null;
}

export interface AuditEntry {
  actor: string;
  ip: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  result: 'ok' | 'fail';
  detail?: string | null;
}

export function appendAudit(db: Db, entry: AuditEntry): void {
  db.prepare(
    `INSERT INTO audit_log (id, ts, actor, ip, action, target_type, target_id, result, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('audit'),
    nowIso(),
    entry.actor,
    entry.ip,
    entry.action,
    entry.targetType,
    entry.targetId ?? null,
    entry.result,
    entry.detail ?? null,
  );
}

export function listAudit(db: Db, page: number, pageSize: number): Page<AuditDto> {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
  const rows = db
    .prepare('SELECT * FROM audit_log ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?')
    .all(pageSize, (page - 1) * pageSize) as AuditRow[];

  return {
    items: rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      actor: r.actor,
      ip: r.ip,
      action: r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      result: r.result === 'ok' ? 'ok' : 'fail',
    })),
    total,
    page,
    pageSize,
  };
}

/**
 * 保留策略：删掉 `retentionDays` 天以前的审计行。与 `usage_logs` / 快照同口径
 * （`pruneLogs` / `pruneHealthSnapshots` 的形状），但**保留期是独立配置**
 * （`AUDIT_RETENTION_DAYS`，默认 180 天）—— 见 `src/config.ts` 那一行的理由。
 *
 * **为什么是 `<` 而不是 `<=`**：与另两个 prune 逐字一致。取整到毫秒边界的行
 * （cutoff 恰好等于 `ts`）应该被**留下**，它是"刚刚还在窗口内"的那一条。
 *
 * **没有 try/catch**：同 `appendAudit`。仓储层是薄层，异常处理归调用方
 * （`src/server.ts` 的维护定时器已经全包了）。
 */
export function pruneAudit(db: Db, retentionDays: number, now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  return db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff).changes;
}
