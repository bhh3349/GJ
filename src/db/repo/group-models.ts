// 组 → 模型授权（契约 §4「模型授权」/ ADR-0037）。表 `group_models(group_id, model_id)`。
//
// 这个文件存在的理由与 `db/model-limits.ts` 同一条：**同一件事有四个读方**，
// 口径分开演化就会造出"页面上看得见、网关上不生效"那种不报错的漂移。
//   读（管理面列表/详情）：`toDto` 要每行的授权名 → `listAuthorizedModelNames`
//   读（管理面抽屉）：`GET /api/groups/:id/models` 的展开项 → `listAuthorizedModelEntries`
//   读（网关热路径）：`wiring/auth.ts` 的 `GroupContext.authorizedModels` → `listAuthorizedModelNames`
//   写：`PUT /api/groups/:id/models` → `setAuthorizedModels`
//
// 三条口径（每一条都对应 ADR-0037 的一个决策，改这里先改那里）：
//   1. **出口恒不出现 `[]`**：没有任何授权行 ⇒ `null`（= 不限）。与 §15.7/§16.3 的
//      `serializeModelLimits` 逐字同构 —— 契约不制造一个实现不了的第三态（决策 3）。
//   2. **判定按名字、落库按 id**：表里存 `model_id`（外键要它），读出去一律是
//      `models.name`，因为网关热路径上只有名字（决策 2）。
//   3. **同名档案一起授权**：一个名字解析到几个 `models` 行就插几行，但**读出去去重** ——
//      授权是"名字集合"，不是"档案集合"（决策 2 的代价，已登记为 ADR-0037 遗留 1）。

import { ApiError } from '../../api/errors.js';
import type { GroupModelEntryDto, GroupModelsDto } from '../../api/dto.js';
import { nowIso } from '../../util/time.js';
import type { Db } from '../database.js';
import { appendChange } from './change-log.js';

/**
 * 读侧：该组授权的模型**名**（去重，按名排序）。
 *
 * 回 `null` 而不是 `[]`：两者同义（= 不限），出口固定成一种形态，调用方不必判两次。
 * 这句是 HOT PATH —— 网关每请求一次（`wiring/auth.ts`），主键前缀查，微秒级。
 */
export function listAuthorizedModelNames(db: Db, groupId: string): string[] | null {
  const rows = db
    .prepare(
      `SELECT DISTINCT m.name AS name
       FROM group_models gm
       JOIN models m ON m.id = gm.model_id
       WHERE gm.group_id = ?
       ORDER BY name`,
    )
    .all(groupId) as { name: string }[];
  return rows.length === 0 ? null : rows.map((r) => r.name);
}

/**
 * 读侧：展开成"授权落到哪个上游"的行（契约 §4 的 `authorizedModels` 字段）。
 *
 * 与 `listAuthorizedModelNames` **刻意分开两条 SQL**，不是懒得抽：名字列表要的是
 * 去重后的**集合**（给开关用），展开行要的是**每一条授权**（给界面看"同名两条都在"用）。
 * 一条 SQL 同时满足两者只能靠再分组一次，那才是把两个口径塞进同一处。
 */
export function listAuthorizedModelEntries(db: Db, groupId: string): GroupModelEntryDto[] {
  return db
    .prepare(
      `SELECT m.id AS id, m.name AS name, m.upstream_id AS upstreamId
       FROM group_models gm
       JOIN models m ON m.id = gm.model_id
       WHERE gm.group_id = ?
       ORDER BY m.name, m.id`,
    )
    .all(groupId) as GroupModelEntryDto[];
}

export function getGroupModels(db: Db, groupId: string): GroupModelsDto {
  if (!groupExists(db, groupId)) throw ApiError.notFound('用户组', groupId);
  return {
    models: listAuthorizedModelNames(db, groupId),
    authorizedModels: listAuthorizedModelEntries(db, groupId),
  };
}

function groupExists(db: Db, groupId: string): boolean {
  return db.prepare('SELECT 1 AS ok FROM groups WHERE id = ?').get(groupId) !== undefined;
}

/**
 * 名字 → 档案 id 集合（写侧解析）。
 *
 * **解析面不限 `enabled`**：授权一个"存在但当前被停用"的名字是合法动作 ——
 * 停用是档案的临时状态，授权是组的长期策略，把前者当后者的前置条件会让
 * "先授权、再启用"变成操作顺序约束（那种约束没人记得住，只会让人觉得"保存没生效"）。
 * 真正不存在（名字打错 / 档案被删）才报错。
 *
 * 导出是为了让用例能直接钉住"未知名字报错、库里零变更"这条（ADR-0037 判据）。
 */
export function resolveModelIdsByName(
  db: Db,
  names: readonly string[],
): { ids: string[]; unknown: string[] } {
  const stmt = db.prepare('SELECT id FROM models WHERE name = ? ORDER BY id');
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const rows = stmt.all(name) as { id: string }[];
    if (rows.length === 0) unknown.push(name);
    else for (const r of rows) ids.push(r.id);
  }
  return { ids, unknown };
}

/**
 * 写侧：整组替换（契约 §4，`PUT /api/groups/:id/models`）。
 *
 * 顺序**不能换**：
 *   1. 解析名字 → 先解析再动库，所以"含未知名字"是**库零变更**的失败（决策 2）；
 *   2. 一个事务里：乐观锁更新 `groups.revision`（0 行 = 409/404）→ 删旧行 → 插新行；
 *   3. `appendChange('group', id, 'update', 新 revision)`。
 *
 * 为什么乐观锁复用 `groups.revision` 而不是给授权单独一个 revision：授权是**组行的属性**
 * （决策 3），给它一个独立的版本号就等于承认"组有两个可并发编辑的版本"，
 * 而后端没有任何地方会同时返回两个 —— 前端只能拿到一个，另一个就成了没人维护的摆设。
 */
export function setAuthorizedModels(
  db: Db,
  groupId: string,
  names: readonly string[] | null,
  revision: number,
): GroupModelsDto {
  if (!groupExists(db, groupId)) throw ApiError.notFound('用户组', groupId);

  // 去重：授权是名字**集合**。`["a","a"]` 与 `["a"]` 落库结果相同，
  // 不去重就会插两遍行（同名档案本来就多行，再加重复项，行数会失真得离谱）。
  const wanted = names === null ? [] : [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))];
  const { ids, unknown } = resolveModelIdsByName(db, wanted);
  if (unknown.length > 0) {
    // 不静默忽略：拼错的名字被丢掉 = 一个"保存成功但什么都没授权"的面（决策 2）。
    throw ApiError.invalidParam('models', `模型不存在：${unknown.join('、')}`);
  }

  db.transaction(() => {
    const info = db
      .prepare('UPDATE groups SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
      .run(nowIso(), groupId, revision);
    if (info.changes === 0) {
      const still = db.prepare('SELECT revision FROM groups WHERE id = ?').get(groupId) as
        | { revision: number }
        | undefined;
      if (!still) throw ApiError.notFound('用户组', groupId);
      throw new ApiError('REVISION_MISMATCH', '该用户组已被他人修改，请刷新后重试', {
        expected: revision,
        actual: still.revision,
      });
    }

    // 整组替换 = 删全部 + 插新的，同一事务。`null` 与 `[]` 都走到这里且都只删不插
    // —— 两个语义在**落库层面本来就是同一件事**，出口才不需要第三个形态。
    db.prepare('DELETE FROM group_models WHERE group_id = ?').run(groupId);
    const insert = db.prepare('INSERT OR IGNORE INTO group_models (group_id, model_id) VALUES (?, ?)');
    for (const id of ids) insert.run(groupId, id);
  })();

  // 事务提交且上面那句 UPDATE 成功才走到这里 ⇒ 新 revision 就是 `revision + 1`。
  // **不"再查一次库"**：并发写入下那次查询会读到别人的 revision，广播出去的版本号就错了。
  appendChange(db, 'group', groupId, 'update', revision + 1);
  return {
    models: listAuthorizedModelNames(db, groupId),
    authorizedModels: listAuthorizedModelEntries(db, groupId),
  };
}
