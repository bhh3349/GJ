// 用户仓储。契约 §19.7 / ADR-0034。
//
// 这个文件只服务一件事：**第二种身份**（`role ∈ {admin, user}`）。
// 在它之前，`admin_users` 里的每一行都是管理员 —— 而消费面要的"普通用户登录"
// 在服务端根本不存在（`/api/*` 全量鉴权且只有一个身份）。
//
// 三条纪律（写在这里，免得下一个人"顺手"破掉）：
//   1. **口令散列永不进 DTO**。本文件的读面一律不 SELECT `password_hash` ——
//      不是"序列化时记得跳过"，是 SQL 里就没有这一列。
//   2. **`role` 每次鉴权现读**（`findUser`），不缓存、不存进 `sessions`。
//      存了就有"管理员改了角色、旧会话还是老角色"的窗口，而现读只是一次主键点查。
//   3. **不能删自己、不能删最后一个 admin**。这两个上限不是产品洁癖：
//      删自己 = 把当前会话的管理员从库里抹掉，而他已经登进来了，下次刷新就 401；
//      删最后一个 admin = 管理面再也没有人能进，只能改库脱身。
//
// **本文件不写 `change_log`**：那张表是给**网关进程**的广播信道（读者是 `src/gateway/` 的
// 1s 轮询，用来感知"该重载什么了"）。用户既不影响选路、也不影响限流、更不影响 KeyPool ——
// 给它发一条广播，只会让网关白跑一次"看看是不是上游变了"的重载，而答案是永远不变。

import { ApiError } from '../../api/errors.js';
import type { Page, UserDto } from '../../api/dto.js';
import { nowIso } from '../../util/time.js';
import type { Db } from '../database.js';
import { translateWriteError } from './write-errors.js';

/** 角色只有两个值。闭集 —— 前端与闸门都按这两个字面量判，不引入第三档。 */
export type UserRole = 'admin' | 'user';

/**
 * 把库里的 `role` 文本收窄成闭集。
 *
 * 为什么需要它：`role` 是 TEXT 列（没有 CHECK 约束 —— 加约束会让将来加第三种身份
 * 变成一次迁移），所以"某个值不是 admin"必须**显式**处理。
 * **缺省按 `user` 而不是按 `admin`**：一个不认识的 role 如果放行成管理员，
 * 那是一个"默认放行"的失败形状 —— 将来手改库写错一个字母，就 quietly 多出一个超管。
 * 反过来按 `user`，最坏是那个人登进来发现管理面进不去，然后来问你。
 */
export function normalizeRole(role: string): UserRole {
  return role === 'admin' ? 'admin' : 'user';
}

export interface UserRow {
  username: string;
  role: string;
  group_id: string | null;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * 按用户名取用户。**鉴权路径每次都走这里**（`requireSession` → 本函数），
 * 所以它刻意不 join、不查口令 —— 只要 role 与 group_id。
 */
export function findUser(db: Db, username: string): UserRow | null {
  return (
    (db
      .prepare('SELECT username, role, group_id, display_name, created_at, updated_at FROM admin_users WHERE username = ?')
      .get(username) as UserRow | undefined) ?? null
  );
}

/** 管理员数量（删用户前的下限判据）。 */
export function adminCount(db: Db): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM admin_users WHERE role = 'admin'").get() as { n: number }).n;
}

export interface ListUsersQuery {
  page: number;
  pageSize: number;
}

export function listUsers(db: Db, query: ListUsersQuery): Page<UserDto> {
  const total = (db.prepare('SELECT COUNT(*) AS n FROM admin_users').get() as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT username, role, group_id, display_name, created_at, updated_at
       FROM admin_users
       ORDER BY created_at, username
       LIMIT ? OFFSET ?`,
    )
    .all(query.pageSize, (query.page - 1) * query.pageSize) as UserRow[];
  return {
    items: rows.map((r) => ({
      username: r.username,
      role: normalizeRole(r.role),
      groupId: r.group_id,
      displayName: r.display_name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    page: query.page,
    pageSize: query.pageSize,
    total,
  };
}

export interface CreateUserInput {
  username: string;
  passwordHash: string;
  role: UserRole;
  groupId?: string | null | undefined;
  displayName?: string | null | undefined;
}

export function createUser(db: Db, input: CreateUserInput): UserDto {
  const now = nowIso();
  try {
    db.prepare(
      `INSERT INTO admin_users (username, password_hash, role, group_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.username,
      input.passwordHash,
      input.role,
      input.groupId ?? null,
      input.displayName ?? null,
      now,
      now,
    );
  } catch (err) {
    throw translateWriteError(err, '用户名已存在');
  }
  return {
    username: input.username,
    role: input.role,
    groupId: input.groupId ?? null,
    displayName: input.displayName ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 改用户。当前只用于分配 / 改派组（`group_id`）与启停用的 `displayName`。
 *
 * **role 不在可改字段里**：改角色走"删了重建"。这不是懒 ——
 * 一个 `PATCH /api/users/:u {role}` 会让"把自己从 admin 降成 user"变成一次普通请求，
 * 而降完他就再也改不回来了（`/api/users` 只有 admin 能进）。删重建至少要求
 * 操作者手里还有一个 admin 会话、且删的不能是自己。
 *
 * **约束错误要译**（v1.15.6 补，ADR-0035 决策 2）：`group_id` 有 FK 指向 `groups(id)`
 * 且 `foreign_keys = ON`，所以一个不存在的组 id 会在这里撞 `SQLITE_CONSTRAINT_FOREIGNKEY`。
 * 不译的后果不是"少了句人话"，是**一个坏入参变成 500** —— 前端把校验错误报成
 * "服务端故障"，运维照着 500 去查服务，而真正的问题在请求体里。
 * `createUser` 一直译着这一条，是它漏了（同一张表、同一个 FK，两条写路径两种行为）。
 */
export interface UpdateUserInput {
  groupId?: string | null | undefined;
  displayName?: string | null | undefined;
}

export function updateUser(db: Db, username: string, patch: UpdateUserInput): UserDto {
  const existing = findUser(db, username);
  if (existing === null) throw ApiError.notFound('用户', username);
  const now = nowIso();
  const sets: string[] = [];
  const args: (string | null)[] = [];
  if ('groupId' in patch) {
    sets.push('group_id = ?');
    args.push(patch.groupId ?? null);
  }
  if ('displayName' in patch) {
    sets.push('display_name = ?');
    args.push(patch.displayName ?? null);
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    args.push(now);
    args.push(username);
    try {
      db.prepare(`UPDATE admin_users SET ${sets.join(', ')} WHERE username = ?`).run(...args);
    } catch (err) {
      // `uniqueField` 取 `groupId`：本函数眼下唯一会撞约束的就是这个字段。
      // 将来若开 `displayName` 的写路径，这里要改成按出错的那一列分流 ——
      // 把 FK 错报成"取值不在允许范围内"会让人去查一个没有约束的列。
      throw translateWriteError(err, 'groupId');
    }
  }
  const after = findUser(db, username);
  if (after === null) throw ApiError.notFound('用户', username);
  return {
    username: after.username,
    role: normalizeRole(after.role),
    groupId: after.group_id,
    displayName: after.display_name,
    createdAt: after.created_at,
    updatedAt: after.updated_at,
  };
}

/**
 * 只改归属组（`PATCH /api/users/:username` 的仓储入口，ADR-0035 决策 2）。
 *
 * 与 `updateUser({groupId})` 的差别**不是功能而是意图**：这条是路由直接调的、
 * 有契约与 ADR 背书的公开语义；`updateUser` 是"将来可能扩字段"的通用写口。
 * 分成两条是为了让"这条端点能改什么"在读路由层时一眼可见 ——
 * 从 `updateUser` 的 patch 类型里推"线上到底能改哪些字段"要跳三个文件。
 */
export function setUserGroup(db: Db, username: string, groupId: string | null): UserDto {
  return updateUser(db, username, { groupId });
}

/**
 * 删用户，并**在同一个事务里吊销他的全部会话**。
 *
 * 为什么必须同事务：分两步的话，中间态是"库里没这个人了、他的 cookie 还有效"。
 * 而那一段时间里 `requireSession` → `findUser` 拿到 null —— 一个已删除的用户
 * 还能带着旧 cookie 打请求，而每次都会走到"用户不存在"这条分支。
 * 更要紧的是**反向竞态**：如果先删会话再删用户，两步之间一次并发登录
 * 可以造出一条"库里没有、会话还在"的孤儿会话，它永远不会被 `purgeExpiredSessions` 之外的东西清掉。
 */
export function deleteUser(db: Db, username: string, actor: string): void {
  const existing = findUser(db, username);
  if (existing === null) throw ApiError.notFound('用户', username);
  // 删自己：当前会话的管理员把自个儿从库里抹掉。他这次请求还能过，下一次刷新就 401，
  // 而如果他正好是最后一个 admin，管理面此后再也进不去（只能改库）。
  if (username === actor) {
    throw ApiError.invalidParam('username', '不能删除当前登录的账号');
  }
  // 删最后一个 admin：同上，但即使操作者不是被删的那个也成立。
  if (existing.role === 'admin' && adminCount(db) <= 1) {
    throw ApiError.invalidParam('username', '不能删除最后一个管理员账号');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE username = ?').run(username);
    db.prepare('DELETE FROM admin_users WHERE username = ?').run(username);
  })();
}

/** 给引导流程用：库里有没有任何 admin。没有 → 拒绝启动（`bootstrapAdmin`）。 */
export function hasAnyAdmin(db: Db): boolean {
  return adminCount(db) > 0;
}
