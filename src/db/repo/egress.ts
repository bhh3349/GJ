// 出口代理仓储。契约 §16.7 Tier 2 的配置面。

import { ApiError } from '../../api/errors.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { Db } from '../database.js';
import { newId } from '../ids.js';
import { nowIso } from '../../util/time.js';
import { appendChange } from './change-log.js';
import { egressIdOfUrl } from '../../egress/port.js';

export type EgressLifecycle = 'active' | 'retired';
export type RetiredReason = 'replaced' | 'manual';

export interface EgressProxyDto {
  id: string;
  name: string;
  url: string;
  region: string | null;
  note: string | null;
  status: EgressLifecycle;
  retiredReason: RetiredReason | null;
  retiredAt: string | null;
  authSet: boolean;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  createdAt: string;
  updatedAt: string;
}

interface EgressRow {
  id: string;
  name: string;
  url: string;
  secret: Buffer | null;
  region: string | null;
  note: string | null;
  status: EgressLifecycle;
  retired_reason: RetiredReason | null;
  retired_at: string | null;
  last_test_at: string | null;
  last_test_ok: number | null;
  created_at: string;
  updated_at: string;
}

const SELECT_COLS = `
  id, name, url, secret, region, note, status, retired_reason, retired_at,
  last_test_at, last_test_ok, created_at, updated_at
`;

export interface CreateEgressInput {
  name: string;
  url: string;
  username?: string;
  password?: string;
  region?: string | null;
  note?: string | null;
}

export interface UpdateEgressInput {
  name?: string;
  region?: string | null;
  note?: string | null;
  username?: string;
  password?: string;
  lastTestAt?: string;
  lastTestOk?: boolean;
}

function toDto(row: EgressRow): EgressProxyDto {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    region: row.region,
    note: row.note,
    status: row.status,
    retiredReason: row.retired_reason,
    retiredAt: row.retired_at,
    authSet: row.secret !== null,
    lastTestAt: row.last_test_at,
    lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowOf(db: Db, id: string): EgressRow | null {
  return (db.prepare(`SELECT ${SELECT_COLS} FROM egress_proxies WHERE id = ?`).get(id) as EgressRow | undefined) ?? null;
}

function countAccounts(db: Db, id: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM supplier_accounts WHERE egress_id = ?').get(id) as { n: number }).n;
}

export function listEgressProxies(db: Db): EgressProxyDto[] {
  const rows = db.prepare(`SELECT ${SELECT_COLS} FROM egress_proxies ORDER BY name, id`).all() as EgressRow[];
  return rows.map(toDto);
}

export function getEgressProxy(db: Db, id: string): EgressProxyDto | null {
  const row = rowOf(db, id);
  return row === null ? null : toDto(row);
}

export function requireEgressProxy(db: Db, id: string): EgressProxyDto {
  const found = getEgressProxy(db, id);
  if (found === null) throw ApiError.notFound('出口', id);
  return found;
}

export function countEgressAccounts(db: Db, id: string): number {
  return countAccounts(db, id);
}

export function normalizeEgressUrl(raw: string): string {
  const text = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw ApiError.invalidParam('url', '代理 URL 必须是合法地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw ApiError.invalidParam('url', '代理协议必须是 http 或 https');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw ApiError.invalidParam('url', '代理 URL 不得包含 user:pass@ 凭据');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw ApiError.invalidParam('url', '代理 URL 不得包含查询串或锚点');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function normalizedEgressIdOfUrl(url: string): string | null {
  return egressIdOfUrl(url);
}

function secretBlob(input: CreateEgressInput | UpdateEgressInput, masterKey: Buffer): Buffer | null {
  if (input.username === undefined || input.password === undefined || input.username === '' || input.password === '') {
    return null;
  }
  return encryptSecret(`${input.username}:${input.password}`, masterKey);
}

export function createEgressProxy(db: Db, input: CreateEgressInput, masterKey: Buffer): EgressProxyDto {
  const at = nowIso();
  const url = normalizeEgressUrl(input.url);
  const id = newId('egress');
  const blob = secretBlob(input, masterKey);
  try {
    db.prepare(
      `INSERT INTO egress_proxies (id, name, url, secret, region, note, status, retired_reason, retired_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, NULL, ?, ?)`,
    ).run(id, input.name, url, blob, input.region ?? null, input.note ?? null, at, at);
  } catch (err) {
    throw translateEgressWriteError(err, 'name 或 url');

  }
  appendChange(db, 'egress', id, 'insert', null);
  const created = getEgressProxy(db, id);
  if (created === null) throw new ApiError('INTERNAL', '创建出口后读取失败');
  return created;
}

export function updateEgressProxy(
  db: Db,
  id: string,
  patch: UpdateEgressInput,
  masterKey: Buffer,
): EgressProxyDto {
  const current = rowOf(db, id);
  if (current === null) throw ApiError.notFound('出口', id);

  const sets: string[] = [];
  const params: unknown[] = [];
  const put = (column: string, value: unknown): void => {
    sets.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.name !== undefined) put('name', patch.name);
  if (patch.region !== undefined) put('region', patch.region);
  if (patch.note !== undefined) put('note', patch.note);
  if (patch.lastTestAt !== undefined) put('last_test_at', patch.lastTestAt);
  if (patch.lastTestOk !== undefined) put('last_test_ok', patch.lastTestOk ? 1 : 0);
  if (patch.username !== undefined || patch.password !== undefined) {
    const blob = secretBlob(patch, masterKey);
    put('secret', blob);
  }

  if (sets.length === 0) return toDto(current);
  sets.push('updated_at = ?');
  params.push(nowIso(), id);
  try {
    db.prepare(`UPDATE egress_proxies SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch (err) {
    throw translateEgressWriteError(err, 'name');
  }
  appendChange(db, 'egress', id, 'update', null);
  return requireEgressProxy(db, id);
}

export function retireEgressProxy(db: Db, id: string, reason: RetiredReason, at: string): void {
  const current = rowOf(db, id);
  if (current === null) throw ApiError.notFound('出口', id);
  if (current.status === 'retired') throw new ApiError('CONFLICT', '该出口已经退役');
  const accountCount = countAccounts(db, id);
  if (accountCount > 0) {
    throw new ApiError('EGRESS_HAS_ACCOUNTS', '该出口仍被供应商账号占用', { accountCount });
  }
  db.prepare(
    `UPDATE egress_proxies SET status = 'retired', retired_reason = ?, retired_at = ?, updated_at = ? WHERE id = ?`,
  ).run(reason, at, at, id);
  appendChange(db, 'egress', id, 'update', null);
}

export function reactivateEgressProxy(db: Db, id: string, at: string): EgressProxyDto {
  const current = rowOf(db, id);
  if (current === null) throw ApiError.notFound('出口', id);
  if (current.status !== 'retired') throw new ApiError('CONFLICT', '仅已退役的出口可回池');
  db.prepare(`UPDATE egress_proxies SET status = 'active', updated_at = ? WHERE id = ?`).run(at, id);
  appendChange(db, 'egress', id, 'update', null);
  return requireEgressProxy(db, id);
}

export function decryptEgressProxySecret(blob: Buffer, masterKey: Buffer): string {
  return decryptSecret(blob, masterKey);
}

function translateEgressWriteError(err: unknown, uniqueField: string): Error {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  if (code.startsWith('SQLITE_CONSTRAINT')) {
    if (message.includes('egress_proxies.url')) {
      return ApiError.invalidParam('url', '同一出口地址已存在，退役后请回池复用原条目');
    }
    if (message.includes('UNIQUE')) {
      // SQLite 的 UNIQUE 报错带全限定列名（"UNIQUE constraint failed: egress_proxies.name"），
      // 它是唯一可机器判的冲突面 —— 不解析它，name 撞了只能落进兜底的
      // "name 或 url 已存在"，那种措辞会让前端把两栏一起标红（契约 §0.4 details.field 纪律）。
      const m = /UNIQUE constraint failed: egress_proxies\.([A-Za-z_]+)/.exec(message);
      if (m !== null && m[1] !== undefined && m[1] !== 'url') {
        return new ApiError('CONFLICT', `${m[1]} 已存在，请换一个`, { field: m[1] });
      }
      return new ApiError('CONFLICT', `${uniqueField} 已存在，请换一个`, { field: uniqueField });
    }
    if (message.includes('CHECK')) {
      return ApiError.invalidParam(uniqueField, '取值不在允许范围内');
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}