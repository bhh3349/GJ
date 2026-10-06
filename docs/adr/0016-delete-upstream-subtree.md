# 16. 删上游：从属资源按依赖序物理删除整棵子树（修订 §11 C4 的 key 处置）

- 状态：**已实施，待 PM 追认**（本 ADR 修订 §11 C4 的冻结口径，请 PM 复核取舍）
- 日期：2026-10-07
- 决策者：管家 · 管理后端（契约 §2 归属；C4 原文属 PM 裁决，故标注待追认）
- 提出人：画师 · 前端（真实会话实测：上游管理页删除按钮 500）
- 关联：api-contract §2 / §11 C4、ADR-0007（C1–C5 冻结）、ADR-0008（网关 key 吊销即物理删除）、ADR-0010（key_runtime 镜像）

## 背景与问题

画师用真会话打 `DELETE /api/upstreams/:id?force=true` 复现：**该上游有已建档模型时稳定 500 `INTERNAL` / `SQLITE_CONSTRAINT_FOREIGNKEY`**，前端删除按钮在这条路上是死的。

定位到根因时发现范围比报告更大 —— **不是"模型才算"，只要上游下有 key 也一样 500**：

```sql
upstream_keys.upstream_id TEXT NOT NULL REFERENCES upstreams(id)   -- schema.ts:57
models.upstream_id        TEXT NOT NULL REFERENCES upstreams(id)   -- schema.ts:119
```

连接开了 `PRAGMA foreign_keys = ON`（`db/database.ts:32`）。外键是**行级**约束：`upstream_keys` 的软删（`enabled=0` + `deleted_at` 置值）**不解除引用**，行还在，父行就删不掉。

于是 §11 C4 裁决的「`force=true` 时级联**软删** key（`enabled=false` + `deletedAt`），保留历史日志外键」在本 schema 下**不可实现**：软删 key 的下一步 `DELETE FROM upstreams` 必定违约。旧实现只判 key、从不删 key 行，所以任何带 key 的上游想删都必然 500 —— 这条路径此前没有任何用例覆盖，缺陷一直没暴露。

新增回归用例把根因单独钉住了（`src/api/api.spec.ts`「删上游：从属资源处置」）：软删 key 后直接 `DELETE FROM upstreams` 仍抛 `FOREIGN KEY`。

## 候选方案

| 方案 | 做法 | 代价 |
|---|---|---|
| **A. 上游软删**（C4 原意的最近可行改造） | `upstreams` 新增 `deleted_at` + 部分唯一索引；key / 模型行全留 | 需要给**所有**读路径加过滤：列表 / 详情 / 余额合计 / 统计维度 / 模型可用性 / 网关快照 `UPSTREAMS_SQL`，漏一处就是"已删上游继续被路由"这类静默错；名称唯一约束要改部分索引；`POST /api/keys` 要拒已删上游。约 7 个文件 + 每处一套"不泄漏"用例。这是**新功能**（软删上游），不是一个修复 |
| **B. 物理删除整棵子树**（本 ADR） | 单事务按依赖序删 `key_runtime` → `upstream_keys` → `models` → `upstreams` | 与 C4 的"软删 key"字面冲突（见下"为什么可以放弃软删"）；已删 key 的运行态镜像行一并消失（ADR-0010 的已知缺口不再扩大） |

## 决策：方案 B

### 1. 守卫（`force != true`）拦的是"从属资源"，不只 key

```
上游下有 key（未软删）或模型档案 → 409 UPSTREAM_HAS_KEYS
details: { keyCount: <未软删 key 数>, modelCount: <模型档案数> }
```

`modelCount` 是**纯新增只读字段**，`code` 复用不新增枚举 —— 前端动作用的是同一个（弹二次确认 → 带 `force=true` 重发），不需要第二个分支。**注意 code 名从"有 key"扩为"仍有从属资源"，`keyCount` 可能为 0 而 `modelCount > 0`**，前端文案要能表达"该上游下还有 N 个模型档案会一起删"。

拦下时零副作用（用例断言：上游行与模型行都还在）。

### 2. `force = true`：单事务按依赖序删

```
key_runtime   (key_id → upstream_keys(id))
upstream_keys (upstream_id → upstreams(id))
models        (upstream_id → upstreams(id))
upstreams
```

顺序不是风格问题：先删运行态镜像，否则删 key 那一步先违约。每个实体发一条 change_log（`key` / `model` / `upstream` 各 `delete`），网关快照按 entity 增量重建 —— 漏发 `model` 那条会让已删模型继续被路由。

### 3. 为什么可以放弃 C4 的"软删 key"（这条是修订冻结件的理由，请 PM 重点看）

1. **软删原本想要的好处基本不可达**：上游行删掉后，那些 disabled 的 key 行既不在上游列表里、也无法在下拉里选到（选择器没有这个上游），只有 `GET /api/keys?includeDeleted=true` 不带上游过滤时才会以"孤儿"形态出现 —— 名义上保留、实际上不可达。
2. **历史可读性不依赖这些行**：`usage_logs` 把 `key_masked` 与 `model` 名字**存在日志行自己身上**（该表 `key_id` / `upstream_id` 本就没有外键声明，schema.ts:134-153 是"抹名引用"），删行不会让历史对不上账。C4 原文"保留历史日志外键"的担忧，指的是一条**从未声明过**的外键；而上游行本来就会被删、`upstream_id` 本来就会悬空 —— 修完这条，两者口径反而一致了。
3. **与既有先例同构**：网关 key 吊销就是**物理删除 + `audit_log` 留痕**（ADR-0008，且明确写了"没有 `deleted_at`"）。上游删除同样由 `audit_log` 记录（`upstream.delete`，`detail=force`）。
4. **代价已明示给用户**：`force=true` 会丢掉管理员在档案卡上手改的开关 / 价格（模型档案随上游消失），所以守卫必须把 `modelCount` 报出来让二次确认说清数量。

不选方案 A 的核心判断：**为了保住一批不可达的孤儿行，去给路由关键路径（快照 / 余额 / 统计）加七处过滤条件，风险远大于收益。**

## 影响

- **`src/db/repo/upstreams.ts`**：`deleteUpstream` 重写；新增 `listUpstreamKeyIds`（**含软删**，它们同样挡外键）/ `listUpstreamModelIds`。
- **契约**：§0.4 `UPSTREAM_HAS_KEYS` 行、§2 端点表 + 新增「删除的从属资源处置」小节、§11 C4 行标注修订；版本 v1.2.1 → **v1.2.2**。`ERROR_CODES` 零新增、端点零增删。
- **前端**：`409` 分支逻辑不变，**文案需能表达 `modelCount`**（`web/src/pages/UpstreamsPage.tsx` 的二次确认）。
- **网关（路由者车道，已知且待评估）**：key 行消失后，网关内存池若还持有该 key，下一次 `key_runtime` 镜像刷写会撞 `key_runtime.key_id` 外键 → **整批失败一 tick**（`onError` 记日志，`key-pool` 快照最多 1s 后被 change_log 刷新，自动恢复）。要彻底消掉这个窗口，可在 `src/db/repo/key-runtime.ts` 的 upsert 上加 `WHERE EXISTS (SELECT 1 FROM upstream_keys WHERE id = @keyId)` 跳过孤儿行 —— 本 ADR 未做（属镜像层行为变更，需路由者确认后再动）。
- **schema / 迁移**：零变更（`SCHEMA_VERSION` 不变）。

## 验证

`src/api/api.spec.ts` 新增 4 例（走真实 HTTP 路由 + 真实 SQLite）：

1. 只有模型、没有 key：`force!=true` 仍 409，且 `details` 为 `{keyCount:0, modelCount:1}`、拦下零副作用；
2. 根因：key 软删后 `DELETE FROM upstreams` 仍抛 `FOREIGN KEY`（证明 C4 原文不可实现，不是"模型才算"）；
3. `force=true`：上游 / 模型 / key / `key_runtime` 四张表该上游的行全为 0，且 `change_log` 里 `model` / `key` / `upstream` 各有一条 `delete`；端点侧 `GET /api/upstreams/:id` → 404、`GET /api/models` 不再含它；
4. 只带 key 的路径不回归：`force=false` → 409（`modelCount: 0`）、`force=true` → 204。

闸门：`pnpm typecheck` RC=0 ｜ `vitest run` 34 文件 / 403 passed / 1 skipped ｜ `check:secrets` 0 命中。
