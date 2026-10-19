# ADR-0041：透支锁存 —— 余额 / 套餐余量耗尽即锁出选路，只有人工解锁才回池

- 状态：**已接受（2026-10-19，Bo 指令「那现在是不是能优化一下这个余额key和套餐key都透支意味着余额低于0.1的账号和关联key全部标记或者直接停用。不会再回到正常的池。用户可以自己再次核查，如果余额还有可以重新启用」+「不只是余额key哈，套餐key也一样的」）**
- 关联：契约 **§20**（新增，本决策的正文）、**§3**（Key 对象 + `GET /api/keys` 筛选 + `POST /api/keys/batch`）、
  **§12.2**（`keys.depleted` 计数）、**§15.1**（`SupplierAccount` 对象）、**§15.2**（`displace` 端点）、
  **§15.7**（`unlimited` 落 NULL）、**§15.13**（套餐 key 的来源）、**§14.2**（NULL 口径）、
  **ADR-0003**（未知 ≠ 0）、**ADR-0010**（`key_runtime` 镜像与新鲜度）、**ADR-0011 / ADR-0030**（选路排序）、
  **ADR-0017**（余额同步为唯一事实源）、**ADR-0018 决策 3**（同一份钱只数一次：账号余额代表其名下 key）
- 车道：`src/db/`（两表加列 + 判定腿）+ `src/gateway/`（`isUsable` 一行早退）+ `src/wiring/store.ts`
  （快照取列）+ `src/api/`（DTO / 筛选 / 两个写入口）+ `web/`（透支标与「重新启用」）
- 交付：**契约 v1.17.0**。`/v1/*` 零端点变更（变的是"哪些 key 进候选"），
  `GATEWAY_ERROR_CODES` / `hintCode` / `ERROR_CODES` 零新增，`SCHEMA_VERSION` 仍为 2（纯加四列）。

## 背景

### 现在发生的事

网关**已经在**选路时排除了"没钱的 key"：

```ts
// src/gateway/key-pool.ts isUsable()
if (key.category === 'balance') return key.balanceCents === null || key.balanceCents > 0;
// token-plan：remainingQuotaOf(key, rt) !== 0
```

问题不在于"排除没排除"，在于**排除这件事没有任何痕迹**，而且口径不够狠：

1. **`<= 0` 才排除，`1..9` 分照跑**。余额 3 分（0.03 元）的 key 会被选中，打上游、拿 402 /
   `INSUFFICIENT_BALANCE`、进冷却 —— 一次注定失败的请求，账单上多一条错误。
2. **排除只发生在内存里**。管理面上那把 key 的三灯是 `healthy`、`enabled=true`、
   余额那一格写着 `3`。**列表里看不出它已经不再接流量** —— 用户的原话是"还在报余额不足"，
   而界面上每个可见信号都说它好着。
3. **`autoDisabled` 不能当这把锁**：它是 `AUTH_INVALID` 连续失败的保护动作，**任何一次成功就自动清掉**
   （`key-pool.ts` 成功分支），且**不落库、重启归零**（ADR-0010 的既定降级）。
   用它表达"没钱了"会出现两种反向错误：一次成功请求把"没钱"解封；重启把一池透支 key 全放回。
4. **套餐 key 同形**：`token_plan_remaining = 0` 时同样只是静默落在候选外，没有任何标记。
   而套餐 key 是**先烧**的那一批（ADR-0030），它烧完了却看不出来，用户只能靠请求失败去猜。

### 用户要的形状

- 余额类 key：**自己余额 < 0.1 元**（含 0 与负数）⇒ 锁存。
- 套餐类 key：**套餐余量烧完（= 0）** ⇒ 锁存（这次明确追加：「不只是余额key哈，套餐key也一样的」）。
- 账号：**账号余额 < 0.1 元** ⇒ 标记账号自身，并**联动**其名下池内 key。
- **不会再自动回到正常的池**；人工「重新启用」才解除；解除后如果下一次刷新仍然透支，**会再次锁存**。

### 被否掉的三个方案（都写在这里，免得下一个人再想一遍）

| 方案 | 为什么否 |
|---|---|
| **直接把 `enabled` 置 0** | 用户第一句里说的"或者直接停用"最省事，但它把两件事压成一件：`enabled` 是**管理员的配置意图**，锁存是**系统按钱算出来的结论**。置 0 之后谁也不知道这把 key 是被谁关的（§3 只有 `enabled` 一位），批量启用会一次性解除全部锁存（等于把"永不回池"作废），而且用户点「启用」得到的反馈是"成功"，实际下一轮刷新又被关回去 —— 一个自己会打架的开关。 |
| **扩展 `health` 枚举加第四个值 `depleted`** | `health` 是**网关进程内的运行态**（ADR-0010：≤1s 滞后、重启归零），而透支是**落库的配置级事实**、必须跨重启存活 —— 塞进 `health` 等于把一个持久事实放进一个会归零的信封。且它的消费者是**冻结面**：§12.2 的 `healthy/cooling/disabled` 三格是一套划分、`gateway_health_snapshots` 有对应三列（历史不可重算）、§7 的 `key_health` 帧也在用它。加值 = 动三张面 + 一列历史。 |
| **纯计算：每次读时按余额现算，不落库** | 看着最"无状态"，但它做不到用户要的那一步 —— **"用户自己核查后重新启用"需要记住"上一次他被锁过"**。纯计算的话，用户把余额手动改回 50 分，标记当场消失；而下一轮刷新读回 3 分又出现。用户要的是"我核查过、我确认，我说了才回池"，那是一份**人工决定**，必须有地方存。 |

## 决策

### 1. 新增第四轴：`depleted`（锁存标记），与 `enabled` / `health` 各管一件事

| 轴 | 谁写 | 存哪 | 管什么 |
|---|---|---|---|
| `enabled` | 管理员（`PATCH` / `batch`） | `upstream_keys.enabled` | **配置意图**：我想不想让这把 key 参与 |
| `health` | 网关进程（镜像，ADR-0010） | `key_runtime` | **运行态**：冷却 / 自动禁用（≤1s 滞后、重启归零） |
| `depleted` | **判定腿**（余额/余量落库时） | `upstream_keys.depleted_at` + `_reason` | **资金事实**：这把 key 现在没能力付账 |
| 人工 | 管理员（本版新增的两个入口） | 同上（`NULL` = 未锁存） | 我核查过了，放它回池 |

三轴**正交**：一把 key 可以 `enabled=true` + `health=healthy` + `depleted=true`。
这不是含糊，是**准确** —— 三灯答的是"网关侧有没有把它按住"，`depleted` 答的是"它有没有钱"。
契约 §3 因此加一句硬约束：**前端在 `depleted=true` 时不得只画三灯**（那等于把"没钱"渲染成"可用"）。

### 2. 判据（三处，常量只有一份）

| 对象 | 锁存条件 | 反向（永不锁存） |
|---|---|---|
| 余额类 key | `balance_cents` 非 NULL **且** `< 10` 分（= 0.1 元；含 0 与负数） | `balance_cents IS NULL`（未知 ≠ 0，ADR-0003）、`unlimited = 1` |
| 套餐类 key | 落库的 `token_plan_remaining` 非 NULL **且** `= 0` | `NULL`（"上游没说"≠ 0）、到期（到期由 `isUsable` 既有的时效判据管，那是**另一件事**，不混进 `depleted`） |
| 账号 | `balance_cents` 非 NULL **且** `< 10` 分 | `balance_cents IS NULL`、上游 `unlimited`（此时 `balanceCents` 按设计落 NULL） |

- 阈值 `DEPLETED_BALANCE_THRESHOLD_CENTS = 10` 与两个纯判据（`isBalanceDepleted` /
  `isTokenPlanDepleted`）**只有一份实现**：`src/db/depletion.ts`。判定腿、写库腿、前端文案都指它。
- **为什么不做成 env 开关**：这把锁判的是"钱够不够打一次请求"，0.1 元是业主给的业务口径不是部署参数。
  可配的话，`depletedReason` 就得读成"按本部署的阈值"，而契约只能写"以部署配置为准"——
  运维看到一把 key 被锁，无法从契约回答"为什么是这把"。判定腿的常量数与契约数**逐字相同**。
- **`unlimited` 结构上够不着这把锁**（这是要害，不是冗余防御）：无限额度 key 的 `balance_cents`
  恒为 `NULL`（§15.7：上游占位值 `-331119` 落库会把"无限"变成"欠费"，ADR-0018 决策 8）。
  判定腿只对**写进来的非 NULL 值**判，所以它天然不中；代码里仍**显式**再判一次 `unlimited`，
  理由与 §15.6 那句一样：这条不变量由两处（驱动器 + 落库纪律）共同维持，任何一处松了，
  沉默的后果是"一整批无限额度 key 集体锁存"。

### 3. 锁存是**粘性**的：判定腿只置位，永不自动清除

```
若 判据成立 且 depleted_at IS NULL  → 置位（记下首次发现的那一刻与原因）
若 判据不再成立                     → 什么都不做（保持锁存）
```

- **首次发现的那一刻只写一次**（`WHERE depleted_at IS NULL`）：反复刷新不会把时间戳推新，
  `depleted_at` 因此是"最早发现它没钱的时刻"，可当审计用；也让"每轮刷新都写一行"变成零写。
- **解除只有一个入口**：管理面的人工动作（决策 6）。用户原话「不会再回到正常的池」+「用户可以自己
  再次核查，如果余额还有可以重新启用」—— **"核查"是人的动作，不是判据的动作**。
- **解除之后若下次刷新仍透支 ⇒ 再次置位**：这是要的（用户接受），也是"锁存不是一次性误判"的证明。
- 反面拒绝的方案是"余额回升自动解锁"：它把"人核查过"这一步删掉了。余额回升 ≠ 这把 key 可以再用 ——
  余额可能是被另一次请求烧掉的、可能是上游读数抖了一下、也可能用户就是想先人工确认一遍。

### 4. 判定腿挂在**所有**余额/余量落库处，且都在管理面后台线程上

| 落库点 | 文件 | 挂在哪 |
|---|---|---|
| 模板查询回写（余额类） | `db/repo/keys.ts` `applyTemplateBalance` | 写完 `balance_cents` 之后按新值判 |
| 模板查询回写（套餐类） | `db/repo/keys.ts` `applyTemplateTokenPlan` | 写完 `token_plan_remaining` 之后按新值判 |
| 手动录入余额 | `db/repo/keys.ts` `setKeyBalance` | 同上（人工录一个 0 也该锁） |
| 手动改套餐余量 | `db/repo/keys.ts` `updateKey`（`tokenPlan` 写分支） | 与上一行同一条判据：手填 `0` 也是"人工录一个 0"（编辑弹窗对套餐 key 就走这里） |
| 建 key 时带上金额/余量 | `db/repo/keys.ts` `createKey` | INSERT 后立即按新建行判：生而为 `0` 的 key 生而该锁，不等下一轮刷新 |
| 套餐余量回填 | `db/repo/supplier-accounts.ts` `backfillSubscriptionTokenPlan` | 每条写入行按算出的余量判 |
| 账号刷新 | `api/services/supplier-accounts.ts` `refreshAccount` | 写完账号余额后判账号 + 级联 |

- **热路径零新增**：以上全部发生在余额刷新任务 / 管理面写请求里，`/v1/*` 转发线程上仍然一行 SQL 都没有
  （AGENTS.md §5 那条纪律不动）。
- **"在途消耗"不触发锁存**（登记边界）：套餐 key 的余量在内存里随请求递减
  （`remainingQuotaOf = token_plan_remaining - rt.spentTokens`），而**库里的数只在下一次余量回填时变**。
  所以一把套餐 key 可能在内存里已经烧干（被 `isUsable` 排除，不接流量）却还没被锁存 ——
  它会在下一次 `keys/sync` / 余额刷新落库时补上。要"烧干当场锁存"就得在热路径写库，代价大于收益。
- **锁存不阻断余额刷新**：`decryptedKeyRefs` 只过滤软删，锁存/停用的 key 照常被刷新 ——
  这正是"用户可以自己再次核查"的载体（核查完读到新值，再决定要不要解锁）。

### 5. 账号级：标记账号自身 + 级联其名下池内 key

- 账号余额 `< 10` 分 ⇒ `supplier_accounts` 置位（`reason='balance'`），并给该账号**名下所有已入池、
  未软删**的 key 置位（`supplier_account_keys.pooled_key_id`，`reason='account'`）。
- 级联走**一次 SQL**（`INSERT`/`UPDATE` 按 `account_id` 选出 `pooled_key_id`），不逐把循环。
- **级联包含套餐 key**（按用户原话"关联key全部"），且这是**登记的可推翻推断**：

  ≥ TierFlow 的套餐是单独购买的，账号钱包与套餐额度是两笔钱。账号欠费时套餐 key 是否真的还能用，
  **我们没有实测证据**。本版按用户的话全量级联（宁可少一把候选，也不要"看起来能跑、打出去就 402"）。
  如果实测证明账号欠费不影响套餐 key，收窄只需一处：级联 SQL 加 `AND uk.category = 'balance'`。
  写在这里，不留待发现。

- 账号的"无限额度"（上游 `unlimited` ⇒ `balanceCents = null`）同样**永不锁存**。
- 账号 DTO 的 `status` **不动**：`status` 说的是会话/登录健康（`active` / `login_failed` /
  `session_expired` / `unknown`），透支是资金事实，两回事。一个 `active` 且余额为 0 的账号是**正常态**。

### 6. 解除入口：一个扩枚举 + 一个新端点，零新错误码

| 入口 | 形状 | 语义 |
|---|---|---|
| key 批量（**扩枚举**） | `POST /api/keys/batch {ids, action:"undeplete"}` → `{updated}` | **清锁 + `enabled=1`**（幂等）。审计 `key.batch_undeplete` |
| 账号（**新端点**） | `POST /api/supplier-accounts/:id/undeplete` → `200 SupplierAccount` | 清账号锁 + 清该账号名下 `reason='account'` 的 key 锁（同样 `enabled=1`） |

- **命名与语义**：用户第一句说的是"重新启用"，所以这两个入口是**一个动作**（解锁 + 启用），
  不是一个"清标记"加一个"启用"让用户点两次。key 的 `enabled` 从**不为锁存所动**（决策 1），
  所以这里置 1 不会覆盖"锁存造成的停用"这种东西 —— 它只可能覆盖一次**人工停用**。
- **`enable` 不清锁**（有意）：批量启用是"把停用的都打开"，如果它顺手清锁，一次批量启用就能把整池
  透支 key 放回去，用户说的"不会再回到正常的池"当场作废。两条路分得很清。
- **账号解除不要求 `revision`**：它不是"改字段"，是"解除一个自动置位的标记"，没有可覆盖的编辑冲突；
  要求 `revision` 只会让"页面开着放了一会儿再点"报 `409 REVISION_MISMATCH`。
  （对照：`PATCH /:id` 改 `egressId` 要 `revision`，因为那是**替换一个编辑值**。）两者都 `revision+1`。
- **零新错误码**：`NOT_FOUND` / `INVALID_PARAM` 都是既有码；key 批量那条沿用既有的"按 id 过滤"语义
  （不存在的 id 静默不计入 `updated`）。

### 7. 网关侧：一行早退 + 快照取一列，广播沿用既有信道

- `KeyConfig` 新增**必填** `depleted: boolean`（`src/gateway/types.ts`）⇒ 编译器会点出**每一个**构造点
  （生产构造点是 `wiring/store.ts` 一处；另有 9 个 spec 文件）。
  必填而非可选：可选字段漏赋值的默认值是 `false`（= 放行），这是**错误方向**上的默认。
- `KEYS_SQL` 增取 `k.depleted_at`；`isUsable()` 在 `key.status !== 'enabled'` 之后**紧接着**早退
  `if (key.depleted) return false;`（放在冷却/并发判据之前：锁存是不可恢复的，先判它省掉后面全部计算）。
- **广播用既有信道**：每次置位/清除都 `appendChange('key', …)` + `revision + 1`。
  `'key'` 在 `SNAPSHOT_ENTITIES` 里 ⇒ 网关 ≤1s 重建快照（ADR-0010 那条链），**不需要任何新机制**。
- **`/v1/*` 零端点、零帧、零错误码变更**：变的只是"候选集合里少了几把"，对外形状一个字不动。
  一个被锁空了的上游照旧回 `503 NO_AVAILABLE_KEY`（既有码）。

### 8. 读面

- **§3 Key 对象**：`depleted: boolean` + `depletedAt: string|null` + `depletedReason: "balance"|"token_plan"|"account"|null`。
- **`GET /api/keys`**：新增筛选 `depleted=true|false`（与既有 `enabled` / `health` 同形）。
- **§15.1 `SupplierAccount`**：同样三个字段（账号的 `reason` 只可能是 `"balance"`）。
- **`GET /api/supplier-accounts`**：新增筛选 `depleted=true|false`。
- **§12.2 健康指标**：`keys.depleted` 计数 + `keys.items[].depleted`。
  它**不参与** `healthy + cooling + disabled = total` 那套划分（正交轴，不得相加）；
  加它是必须的 —— 不加的话健康页会把一批"永不接流量的 key"报成 `healthy`，
  这恰好是本 ADR 要消灭的那种"每个可见信号都说好"的故障形状。
- **不动**：§6 `overview.keyHealth`（5 字段已冻结）、§7 `key_health` 帧（1s 帧不为一个低频配置事实改形状）、
  `gateway_health_snapshots`（**登记**：快照是"当时算出来的历史"，补一列会让全部历史行的该列为 0，
  而 0 在这里是**一个具体的断言**"那一刻没有透支 key"；透支是当前状态，读实时面即可）。
- **不动**：§19 消费面零改动。普通用户没有"key 池"这个概念（§19.1），池被锁空时他拿到的仍是
  503 `NO_AVAILABLE_KEY`——那是他本来就该看到的形状。

### 9. 与 `autoDisabled` 的边界（写清楚，因为两者最像）

| | `autoDisabled` | `depleted` |
|---|---|---|
| 触发 | 连续 `AUTH_INVALID` ≥ N 次（网关自己数） | 余额 / 余量落库时按判据算 |
| 载体 | **内存**（`key_runtime` 不存，见 ADR-0010） | **落库**（`depleted_at`） |
| 清除 | **任何一次成功请求立即清** | **只有人工** |
| 存活 | 重启归零 | 跨重启、跨部署 |
| 表达 | 三灯之一（`health=disabled`） | 第四轴（三灯不动） |

一句话：`autoDisabled` 是"网关觉得这把 key 现在有问题"，`depleted` 是"这把 key 没钱了，
而且这条事实在人核查之前不会变"。

## 影响面

| 面 | 变更 |
|---|---|
| `upstream_keys` | **+2 列**（`depleted_at TEXT` / `depleted_reason TEXT`）；`hasColumn()` 守卫、`SCHEMA_VERSION` 仍为 2 |
| `supplier_accounts` | **+2 列**（同上）；老库升级**零动作**（新列 NULL = 未锁存，与加列前逐字相同） |
| `/v1/*` | **零端点、零路径、零帧、零码变更**；`src/gateway/` 只动 `key-pool.ts` 一行 + `types.ts` 一个字段 |
| `/api/*` | `POST /api/keys/batch` **action 枚举 +1**（不新增端点）；`POST /api/supplier-accounts/:id/undeplete` **新增 1 个**；`GET /api/keys` / `GET /api/supplier-accounts` 各 **+1 可选筛选**；三处 DTO **纯加字段** |
| `ERROR_CODES` | **零新增**（`NOT_FOUND` / `INVALID_PARAM` / `UNPROCESSABLE` 全是既有码） |
| `GATEWAY_ERROR_CODES` / `hintCode` | **零新增**（透支不产生错误事件：它是状态不是事件；锁存时刻由 `depletedAt` 读出） |
| 审计动作 | 新增 `key.batch_undeplete` / `supplier.account.undeplete`；**不新增"锁存"的审计动作**（那是系统动作，不是人的动作；它有自己的时间戳） |
| DDL | 四列纯加列，**零迁移分支**、`SCHEMA_VERSION` 仍为 **2** |
| `web/` | KeysPage / SupplierAccountsPage 透支标 + 筛选 + 「重新启用」；**零新依赖** |
| 升级即生效的后果（**写在最前**） | 部署后**下一轮余额刷新**会给所有现存透支 key 打标。这不是回归，是本版的目的；但它同时意味着"列表里会突然多出一批红标" —— 运维要知道那是预期形状，不是故障 |

## 判据

- **离线用例**：`src/db/depletion.spec.ts`（判据纯函数：`<10` 含 0 与负数、NULL 不锁、unlimited 不锁、
  套餐 `0` 锁 / `NULL` 不锁）+ `src/gateway/key-pool.spec.ts`（`depleted` 的 key 不进候选；
  与 `enabled` / `autoDisabled` 互不干扰）+ `src/db/repo/keys.spec.ts`（粘性：二次置位不改时间戳；
  清锁写 `revision+1` 且发 `'key'` 广播）+ `src/api/routes/keys.spec.ts`（批量 `undeplete`：
  清锁 + `enabled=1` + 审计 + 不存在的 id 不计入）+ 账号侧
  （账号 `<10` 级联名下池内 key；`unlimited` 账号不锁；`:id/undeplete` 只清 `reason='account'` 的 key）。
- **活体验收（LAN 4000）**：手里有透支 key ⇒ 打标后 `/v1/models`+一次真实转发看不到它参与
  （用 `?depleted=true` 与候选排除两侧对照）⇒ 人工 `undeplete` ⇒ 该 key 回到候选
  ⇒ 再刷一次余额（仍 <10）⇒ **重新锁存**（这是"解除后仍透支会再锁"的判据）。
- **门禁**：`tsc --noEmit` / `check:sqlite` / `check:secrets` / `vitest run` 全绿（node22）。

## 已知边界（写在这里，不留待发现）

1. **在途消耗不即时锁存**（决策 4）：套餐 key 在内存里烧干后，要等下一次余量回填落库才被打标。
2. **级联含套餐 key 是推断**（决策 5）：一行 SQL 可收窄，前提是实测出"账号欠费不影响套餐额度"。
3. **"重新启用"是复合动作**（决策 6）：解锁与 `enabled=1` 一起做。本版**不提供**"只清锁、保持停用"的入口；
   真要那个组合，先点「重新启用」再 `PATCH enabled=false`。
4. **不做阈值配置**（决策 2）：0.1 元是业务裁定，不是部署参数。
5. **透支不进错误事件面**：不新增 `GatewayErrorEvent` 分型（§12.1 零新增）。要看"什么时候锁的"读 `depletedAt`。
6. **老库的 DDL 约束漂移**：新库的 `CREATE TABLE` 文本里 `depleted_reason` 带 `CHECK`，
   老库的 `ALTER TABLE ADD COLUMN` 只加 `TEXT`（SQLite 的 ADD COLUMN 加约束有限制，且仓内既有批次同款）。
   判据在**写路径**（判定腿只写三个枚举值），不在 DDL。这条漂移登记在此，不装作不存在。
7. **与本版无关但会同时被注意到的**：`decryptedKeyRefs` 仍会刷新 `enabled=0` 的 key（既有行为），
   于是"停用的 key 余额也在更新"。本版不改它 —— 它正是"人工核查"能读到新值的原因。
