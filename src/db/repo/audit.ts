// 审计仓储。契约 §6 —— 最小集：登录 / 登出 / **所有写操作**。
//
// 为什么连"失败的登录"也要写：审计的价值在于"谁在什么时候试过什么"。
// 只记成功的登录，等于把暴力破解的痕迹全部丢掉。
//
// 审计只读不删：没有 delete 函数。要清理历史只能直连库，那是有意为之的门槛。

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
