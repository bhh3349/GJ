// G1 门禁：证明 better-sqlite3 不只是"装上了"，而是"真能用"。
//
// 为什么需要这个脚本：pnpm 10 默认拦截依赖构建脚本，better-sqlite3 的原生绑定
// 会被静默跳过，而 `pnpm install` 仍然退出 0。只看退出码 = 假绿。
// 见 docs/adr/0005-pnpm-build-script-allowlist.md。
//
// 用法：pnpm run check:sqlite

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const checks = [];
const fail = (step, err) => {
  checks.push({ step, ok: false, err: err?.message ?? String(err) });
  report();
  process.exit(1);
};

function report() {
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.step}${c.ok ? '' : ` -- ${c.err}`}`);
  }
}

// 1. 原生模块能加载（这一步在未构建时会抛 "Could not locate the bindings file"）
let Database;
try {
  Database = require('better-sqlite3');
  checks.push({ step: "require('better-sqlite3')", ok: true });
} catch (err) {
  fail("require('better-sqlite3')", err);
}

// 2. 能开库 + WAL 真的生效 + 读写回路通
const dir = mkdtempSync(join(tmpdir(), 'g1-sqlite-'));
const dbPath = join(dir, 'g1.db');
try {
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  const mode = db.pragma('journal_mode', { simple: true });
  if (mode !== 'wal') throw new Error(`journal_mode 期望 'wal'，实际 '${mode}'`);
  checks.push({ step: 'open db + WAL journal mode', ok: true });

  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)');
  db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
  const row = db.prepare('SELECT v FROM t WHERE id = 1').get();
  if (row?.v !== 'hello') throw new Error(`读回值不符：${JSON.stringify(row)}`);
  checks.push({ step: 'DDL + insert + select 回路', ok: true });

  // 3. 加密相关能力自检：node:crypto 的 aes-256-gcm 可用（key 落盘加密依赖它）
  const { randomBytes, createCipheriv, createDecipheriv } = await import('node:crypto');
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update('secret', 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  if (pt !== 'secret') throw new Error('aes-256-gcm 往返结果不符');
  checks.push({ step: 'aes-256-gcm 加解密往返', ok: true });

  db.close();
} catch (err) {
  fail('sqlite/crypto 功能验证', err);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

report();
console.log('\nG1 PASS');
