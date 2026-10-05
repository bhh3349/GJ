# 8. 网关 key 列表端点：补上 `GET /api/groups/:id/keys`（契约 v1.0.1）

- 状态：已接受（PM 于 2026-10-06 追认通过，契约 → v1.0.1）
- 日期：2026-10-06
- 决策者：管家 · 管理后端
- 提出人：画师 · 前端（在 §8 真实接口接入时发现端点不可达）

## 背景与问题

契约 v1.0-frozen §4 冻结了三个网关 key 的**写**端点：

```
POST   /api/groups/:id/keys                  再签发一把
POST   /api/groups/:id/keys/:keyId/reset     重置（旧 key 立即失效）
DELETE /api/groups/:id/keys/:keyId           吊销
```

而冻结的 `Group` 对象只暴露 `gatewayKeyMasked` 与 `keyCount`。

于是出现一个**死结**：这后两个端点都以 `:keyId` 为入参，但全仓没有任何端点把 `keyId` 交给前端。前端只能签发、不能重置、不能吊销 —— 三个端点里有两个在 UI 上物理不可达。

这不是前端漏做，是冻结时的漏项：`Group` 对象的字段是按「列表要显示什么」定的，而 `keyId` 是**操作入参**，两类字段当时被放在一起权衡，把入参那半边漏了。冻结纪律要求改字段走契约 + ADR，所以补在 ADR 里，不在实现里悄悄加。

## 备选方案

| 方案 | 结论 |
|---|---|
| A. 新增 `GET /api/groups/:id/keys` 子资源，回 `id + maskedKey + createdAt` | **采纳** |
| B. 把 `keys[]` 内联进 `Group` 对象 | 否。组列表页会因此每条都多查一次派生数据（N+1），且组多 key 时列表响应无界增长；分页纪律（§0.3）也套不上 |
| C. 重置/吊销改按 `maskedKey` 后缀定位 | 否。掩码只有后 4 位，**不唯一**，两把 key 撞后缀就会吊销错人 —— 在凭据管理上是不可接受的失效模式 |
| D. 改成「按组整体重置」 | 否。会**降级**已有能力：现在无法只吊销泄漏的那一把而保留其余可用。而且它同样是契约变更，收益却是负的 |

选 A 的理由就是它不改变任何既有语义：`reset`/`DELETE` 仍是按 `keyId`，只是把 `keyId` 的来源补上。

## 决策

### 1. 新增端点

`GET /api/groups/:id/keys?page=&pageSize=` → §0.3 分页信封，项为：

```json
{ "id": "gwk_9a12", "maskedKey": "****9f3c", "createdAt": "2026-10-01T03:00:00.000Z" }
```

**只有三个字段，其中 `updatedAt` 是故意不回的**：网关 key 的改法是「删旧行 + 插新行」（重置即失效），`updated_at` 恒等于 `created_at`。回一个永远相等的字段，只会让调用方以为它可能不同。宁缺勿滥。

### 2. `reset` 响应补 `id`

契约原文写的是 `200 {gatewayKey, maskedKey}`，**实现从一开始就多回了一个 `id`**（`GatewayKeyIssuedDto`）。这是契约文本与实现的既存分歧，本次一并抹平：`reset` 与 `POST .../keys` 同形，都回 `{id, gatewayKey, maskedKey, createdAt}`。

不补的话，重置会在**更深一层**复现同一个死结：旧 keyId 失效、新 keyId 拿不到，刚重置完的 key 又不可操作了。

### 3. 不变量与边界（写进契约 §4）

- 排序固定 `createdAt, id`；**`Group.gatewayKeyMasked` 恒等于列表第一项的 `maskedKey`**。这要求仓储层 `liveGatewayKeys` 与 `listGatewayKeys` 两处 `ORDER BY` 逐字一致 —— 所以那句 SQL 是**故意复制**而非抽公共前缀：复制的部分会在 diff 里露头，抽掉之后两处分开演化、承诺静默失效。
- **无 `includeDeleted`**：网关 key 吊销是**硬删**（行不在即失效），没有可列出的已删项。§3 上游 key 的软删口径不适用于网关 key。
- 未知组 → `404`（不是空列表；空列表会让前端以为「这个组没有 key」）。
- `:keyId` 不属于该组 → `404` 而非 `403`：不泄漏该 keyId 是否存在。
- 明文与 `key_hash` 都不在本端点的任何响应字段里。

## 影响

- **前端（画师）**：用户组页可做单把 key 的重置/吊销；判据从「列表有没有数据」变成「列表里拿到的 id 能不能真的驱动 `reset`」。
- **后端（管家）**：`GatewayKeyDto` + 仓储 `listGatewayKeys` + 一条路由，无 schema 变更（`gateway_keys` 表结构本就够用）。
- **网关（路由者）**：**无影响**。`reset` 的事务语义没动；`findGroupByGatewayKeyHash` 仍按 `deleted_at IS NULL` 过滤。
- **兼容性**：纯新增端点 + 一个响应字段。既有调用方零破坏。

## 门禁核验

在 `.worktrees/api`（分支 `dev/api`，基点 `bbe3252`）实测：

| 闸 | 结果 |
|---|---|
| `pnpm run typecheck` | 0 error |
| `pnpm run test` | **40 passed (4 files)**，其中 `src/api/api.spec.ts` 13 例（+2 新例） |
| `pnpm run check:secrets` | 104 文件 / 450 KB，**0 命中** |
| `pnpm run build` | PASS |

两条新用例的判据不是「端点返回 200」，而是：

1. 列表回来的 `keyId` **真的能驱动 `reset`**（重置后该 id 从列表消失、总数不变）；跨组用别组的 keyId 重置 → `404` 且**本组那把 key 仍在**（越权无副作用）；未知组 → `404`。
2. 吊销后 key 从列表消失、`Group.keyCount` 同步、重复吊销 → `404`；并把**两把 key 的明文**（含已吊销那把）一起丢进 `db + -wal + -shm` 裸字节扫描，附正向对照证明扫描函数确实抓得到。

## 已知缺口（不在本次范围）

- **软删 vs 硬删：已裁决（2026-10-06，PM 定案）——保留硬删。** `gateway_keys.deleted_at` 列删除、吊销路径维持物理删除，本端点**不引入** `includeDeleted` 语义。理由：网关 key 是凭据，吊销即应当失效且无需可恢复；吊销痕迹由 `audit_log` 承担；软删只会把「已吊销的 key」重新引入查询面，牵出无补偿价值的过滤分支。列删除 + 查询里 `deleted_at IS NULL` 过滤的清理**记入 M4 的 `src/db` 改造清单**（与 ADR-0009 提到的 `models.manual_fields` 评估同批 schema 变更），到点执行，不再另开 ADR。
- `label` 列存在但签发路径恒写 `NULL`，所以 DTO 里没回它。要让 gateway key 可命名，是独立的一次改动。
