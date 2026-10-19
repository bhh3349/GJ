// 管理面用户端点。契约 §19.7 / ADR-0034 / ADR-0035。
//
// 这个文件是**唯一**能造出 `role=user` 的地方。消费面（`routes/console.ts`）全程只读，
// 所以"谁能登进普通用户前端"完全由这里决定。三条纪律：
//
//   1. **口令在路由层散列一次，之后只有散列值流动**（§1 同一套 scrypt，`hashPassword` 复用，
//      不复刻算法）。`password` 字段进不了 DTO，响应体与审计 detail 里都永不出现。
//   2. **不提供改角色的方法**。改角色 = 删了重建；**改归属组是唯一一个可改字段**
//      （`PATCH /api/users/:username`，ADR-0035 决策 2）—— 两者的失败形状不同：
//      进错组改回来即可（下一个请求就是新组），而 `role` 一旦能改，
//      "把自己降级"就成了一次普通请求，降完改不回来（不可逆）。
//   3. **不写 `change_log`**。用户既不影响选路、限流、KeyPool 也不影响上游集合，
//      给网关发一条广播只会让它白跑一次"看看该重载什么"，而答案是永远不变
//      （与 `db/repo/users.ts` 头部同一条理由）。
//      但**审计要写**：`user.create` / `user.update` / `user.delete` 是"谁在什么时候
//      给了谁一个身份、把他放进了哪个配额池"，正是 §6 最小集（所有写操作）要覆盖的东西。

import type { FastifyInstance } from 'fastify';

import { createUser, deleteUser, listUsers, setUserGroup, type UserRole } from '../../db/repo/users.js';
import type { Page, UserDto } from '../dto.js';
import { hashPassword } from '../auth.js';
import { auditWrite } from '../http.js';
import { nullableString, pageProps } from '../schemas.js';
import type { ApiContext } from '../app.js';

interface CreateUserBody {
  username: string;
  password: string;
  role: UserRole;
  groupId?: string | null | undefined;
  displayName?: string | null | undefined;
}

const createUserBodySchema = {
  type: 'object',
  required: ['username', 'password', 'role'],
  properties: {
    // 长度上限是防滥用；唯一性判据在库（PRIMARY KEY，撞了走 translateWriteError）。
    username: { type: 'string', minLength: 1, maxLength: 64 },
    // 与 §1 登录同一把尺子：至少 8 位。这里复用的是**同一个数字**而不是另立一个
    // （"建号时 6 位可以、登录时也要 6 位"是两处口径，将来一定漂移）。
    password: { type: 'string', minLength: 8, maxLength: 512 },
    // 闭集。schema 枚举先挡一层，仓储层 `normalizeRole` 再兜底（库是 TEXT 列、没有 CHECK）——
    // 两层都要的理由：schema 挡得住正常客户端，挡不住将来有人直接写库。
    role: { type: 'string', enum: ['admin', 'user'] },
    groupId: nullableString,
    displayName: nullableString,
  },
} as const;

/**
 * `PATCH /api/users/:username` 的 body：**只有一个字段**，且是必填的。
 *
 * 为什么 `groupId` 必填（不能省略成"不改"）：省略一个只有单字段的 PATCH 等于
 * 一次什么都不做的请求 —— 它一定会返回 200 并写一条 `user.update` 审计，
 * 而审计里那条记录说的是"有人改了这个用户的归属"，其实什么都没改。
 * 要求显式给值，`null` 也是一个值（= 退回未分配）。
 */
const updateUserBodySchema = {
  type: 'object',
  required: ['groupId'],
  properties: {
    groupId: nullableString,
  },
} as const;

const listUsersQuerySchema = {
  type: 'object',
  properties: {
    ...pageProps,
    // 管理面的用户表比上游表小得多（一个管理员 + 若干使用者），默认 20 与 §0.3 一致，
    // 不另立默认值 —— 立了就是"分页有两套默认"。
  },
} as const;

export function registerUserRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config } = ctx;

  app.post<{ Body: CreateUserBody }>(
    '/api/users',
    { schema: { body: createUserBodySchema } },
    (req, reply) => {
      const { username, password, role, groupId, displayName } = req.body;
      const created = createUser(db, {
        username,
        passwordHash: hashPassword(password),
        role,
        groupId,
        displayName,
      });
      auditWrite(db, req, config, {
        action: 'user.create',
        targetType: 'user',
        targetId: username,
        // detail 只记角色与归属组：**不记 password，也不记任何口令散列**。
        // 一个把口令写进审计的系统，等于把"谁都能读审计的人"变成"知道所有口令的人"。
        detail: JSON.stringify({ role, groupId: groupId ?? null }),
      });
      return reply.code(201).send(created);
    },
  );

  // §19.7 列表。**不回 password_hash** —— 不是"序列化时记得跳过"，是 SQL 里就没有这一列
  // （`db/repo/users.ts` 的读面一律不 SELECT 它）。
  app.get<{ Querystring: { page?: number; pageSize?: number } }>(
    '/api/users',
    { schema: { querystring: listUsersQuerySchema } },
    (req): Page<UserDto> => {
      // schema 已把 page/pageSize 补过默认值；这里的 `?? 1 / ?? 20` 是给
      // **不经 schema 的调用方**（比如将来的 CLI）兜底，不是重复判一遍。
      return listUsers(db, { page: req.query.page ?? 1, pageSize: req.query.pageSize ?? 20 });
    },
  );

  /*
    §19.7 / ADR-0035 决策 2：**只改归属组**。

    这条端点存在的唯一理由是"归属错了要能修" —— 删号重建的代价是连带吊销那个人的
    全部会话、并把他从 `audit_log` 的 actor 里断成两截，而他只是进错了配额池。

    schema **只列 `groupId`**：请求体里带 `role` / `password` / `displayName` 会被
    忽略（`additionalProperties` 按 §0.2 的既有口径不写 `false`，未知字段静默丢弃）。
    这不是"漏了校验"，是**刻意只开一个字段**：`role` 可改会让"把自己降级"变成
    一次普通请求而降完改不回来（见文件头第 2 条纪律）。
  */
  app.patch<{ Params: { username: string }; Body: { groupId: string | null } }>(
    '/api/users/:username',
    { schema: { body: updateUserBodySchema } },
    (req) => {
      const updated = setUserGroup(db, req.params.username, req.body.groupId);
      auditWrite(db, req, config, {
        // 与 create 同一条纪律：detail 只记归属，**绝不记口令或散列**。
        action: 'user.update',
        targetType: 'user',
        targetId: req.params.username,
        detail: JSON.stringify({ groupId: req.body.groupId }),
      });
      return updated;
    },
  );

  app.delete<{ Params: { username: string } }>('/api/users/:username', (req, reply) => {
    const target = req.params.username;
    // 两个下限（不能删自己 / 不能删最后一个 admin）在仓储层判，不在这里判：
    // 那是**数据完整性约束**，判在仓储层意味着将来任何调用方都绕不过去；
    // 判在路由层则只保护这一条 HTTP 路径。
    // 会话吊销与删用户在**同一个事务**里（仓储层），中间不存在"人没了、cookie 还有效"的窗口。
    deleteUser(db, target, req.auth?.username ?? '');
    auditWrite(db, req, config, {
      action: 'user.delete',
      targetType: 'user',
      targetId: target,
    });
    return reply.code(204).send();
  });
}
