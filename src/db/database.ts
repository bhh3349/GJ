// 共享 SQLite 连接的唯一开库入口。
//
// WAL 不是可选项：网关进程与（同进程内的）管理面各自持有自己的连接，
// 没有 WAL 时管理端一次写就会把网关的读全部挡在锁外，直接违反「API 响应 < 100ms」。
// busy_timeout 是给 checkpoint 之类的短锁留一点重试余量，而不是用来掩盖长事务。

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { migrate } from './schema.js';

export type Db = Database.Database;

export interface OpenOptions {
  /** 单测/临时库传 ':memory:'；生产传文件路径 */
  path: string;
  /** 关掉 WAL（仅内存库或特殊场景用） */
  noWal?: boolean;
}

export function openDatabase(opts: OpenOptions): Db {
  const { path } = opts;
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new Database(path);
  if (opts.noWal !== true) {
    // 内存库不支持 WAL，better-sqlite3 会静默退回 memory journal，这里显式跳过避免误判
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

/**
 * 只读连接。给「查 balance / 查健康态」这类纯读路径用，
 * 拿不到写锁也就不会因为误写而污染运行态（契约 §9：管理面不改运行态）。
 */
export function openReadonly(path: string): Db {
  const db = new Database(path, { readonly: true });
  db.pragma('busy_timeout = 5000');
  return db;
}
