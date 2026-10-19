// 用户仓储（契约 §19.7 / ADR-0034）。
//
// 这个文件只钉**仓储层自己那三条下限**，不钉 HTTP 形状（那在 `src/api/routes/console.spec.ts`）：
//   1. 不能删自己；
//   2. 不能删最后一个 admin；
//   3. 删用户与会话吊销在**同一个事务**里。
//
// 为什么这三条必须有一份仓储层用例：第 2 条在 **HTTP 面上打不着** ——
// 要命中它得同时满足"actor 不是被删的那个"且"被删的是唯一 admin"，
// 而 actor 自己也是个 admin 行，于是库里至少有 2 个 admin，`adminCount <= 1` 恒假。
// 所以它是**纵深防御**，保护的是绕过 HTTP 的调用方（CLI、将来的迁移脚本、手写脚本）。
// 只在 HTTP 上测它，测到的是一个假动作；只在仓储层测它，才真的走到那个分支。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../database.js';
import { createSession, requireSession } from '../../api/auth.js';
import { ApiError } from '../../api/errors.js';
import { adminCount, createUser, deleteUser, findUser } from './users.js';

const dirs: string[] = [];
const open: Db[] = [];

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响判据 */
    }
  }
});

function setup(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'users-repo-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  open.push(db);
  return db;
}

/** 散列值不进库也行 —— 本文件的用例不登录，`createUser` 只当它是 opaque string。 */
const HASH = 'not-a-real-hash';

describe('deleteUser 的下限（契约 §19.7）', () => {
  it('删自己 → 400 INVALID_PARAM，库里那个人还在', () => {
    const db = setup();
    createUser(db, { username: 'solo-admin', passwordHash: HASH, role: 'admin' });
    try {
      deleteUser(db, 'solo-admin', 'solo-admin');
      throw new Error('本该抛 INVALID_PARAM');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('INVALID_PARAM');
    }
    // 守卫零副作用：人还在（否则"挡住"变成了"删掉了但报错"）
    expect(findUser(db, 'solo-admin')).not.toBeNull();
  });

  it('删最后一个 admin → 400，即使操作者不是被删的那个', () => {
    const db = setup();
    // 两个 admin。keeper 删掉 solo 之后，solo 是唯一 admin。
    createUser(db, { username: 'keeper', passwordHash: HASH, role: 'admin' });
    createUser(db, { username: 'solo', passwordHash: HASH, role: 'admin' });
    expect(adminCount(db)).toBe(2);
    deleteUser(db, 'keeper', 'solo'); // 2 → 1，允许
    expect(adminCount(db)).toBe(1);
    // 现在 solo 是唯一 admin。由一个普通用户当 actor 也删不掉他 ——
    // 这条守卫**不认 actor 是谁**，认的是"删完还剩几个 admin"。
    try {
      deleteUser(db, 'solo', 'some-user');
      throw new Error('本该抛 INVALID_PARAM');
    } catch (err) {
      expect((err as ApiError).code).toBe('INVALID_PARAM');
    }
    expect(adminCount(db)).toBe(1);
    expect(findUser(db, 'solo')).not.toBeNull();
  });

  it('普通用户不受"最后一个 admin"约束（删完 admin 数不变）', () => {
    const db = setup();
    createUser(db, { username: 'the-admin', passwordHash: HASH, role: 'admin' });
    createUser(db, { username: 'plain', passwordHash: HASH, role: 'user' });
    deleteUser(db, 'plain', 'the-admin');
    expect(findUser(db, 'plain')).toBeNull();
    expect(adminCount(db)).toBe(1);
  });

  it('删用户与会话吊销同事务：人没了，会话也没了', () => {
    const db = setup();
    createUser(db, { username: 'doomed', passwordHash: HASH, role: 'user' });
    // 真建一条会话（不是桩）：`createSession` 自己走 sha256 落库
    const { token } = createSession(db, 'doomed', 24);
    const before = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE username = ?').get('doomed') as {
      n: number;
    };
    expect(before.n).toBe(1);

    deleteUser(db, 'doomed', 'the-admin');
    const after = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE username = ?').get('doomed') as {
      n: number;
    };
    expect(after.n).toBe(0);
    // 会话行必须真的没了，而不是留着一条查不到人的孤儿
    // （孤儿会话不会被 purgeExpiredSessions 之外的东西清掉）
    expect(findUser(db, 'doomed')).toBeNull();
    // 那把 token 也必须打不开任何东西 —— 这是"同事务吊销"真正要保证的
    // `SESSION_EXPIRED` 而不是 `UNAUTHORIZED`：这把 token 是真的、只是它的主人没了。
    // 前端靠这个区分「去登录」与「从未登录」，所以这里必须是前者。
    try {
      requireSession(db, token, 24);
      throw new Error('本该拒绝');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('SESSION_EXPIRED');
    }
  });

  it('删不存在的用户 → 404 NOT_FOUND', () => {
    const db = setup();
    createUser(db, { username: 'the-admin', passwordHash: HASH, role: 'admin' });
    try {
      deleteUser(db, 'nobody', 'the-admin');
      throw new Error('本该抛 NOT_FOUND');
    } catch (err) {
      expect((err as ApiError).code).toBe('NOT_FOUND');
    }
  });

  it('人没了会话还在（不走 deleteUser 的路径）→ requireSession 拒绝，不塞一个 admin', () => {
    const db = setup();
    createUser(db, { username: 'ghost', passwordHash: HASH, role: 'user' });
    const { token } = createSession(db, 'ghost', 24);
    // 手工把人删掉但**留着会话** —— 模拟"并发删除"那个窗口
    // （先删人再删会话的两步实现会留下这种东西，而它是永生的）
    db.prepare('DELETE FROM admin_users WHERE username = ?').run('ghost');
    try {
      requireSession(db, token, 24);
      throw new Error('本该拒绝');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      // `SESSION_EXPIRED` 而不是 `UNAUTHORIZED`：token 本身有效，只是人没了。
      // **且绝不可能是 admin** —— 那是 sessionInfoOf 的失败形状，见 auth.ts 的注释。
      expect((err as ApiError).code).toBe('SESSION_EXPIRED');
    }
  });
});
