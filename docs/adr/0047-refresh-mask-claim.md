# ADR-0047：`refresh` 补齐掩码认领键 —— 回填腿要有路可走

- 状态：已接受（2026-11-03）
- 相关：ADR-0003（未知 ≠ 0）、ADR-0018（套餐不建 key / 掩码不可逆）、ADR-0022（套餐 key 轮换）、
  ADR-0046（套餐数据单源 —— 本 ADR 修它的验证腿）、ADR-0045（账号连坐收窄）
- 契约：v1.22.1（§15.2 `refresh` 回填腿补掩码认领；§15.3 变更条）

## 触发

ADR-0046 上线（镜像 `5b76b0f60462`）后，业主在面板里点了一次「刷新」，基建在部署机上**只读**读库取证：

- `audit_log`：`2026-11-03T00:29:46.008Z supplier.refresh ok=1 failed=0 total=1`，任务 `succeeded`（277ms）；
- 台账：`acc_508cd21bce49` 的行 `updated_at` 正好被重写成 `00:29:46.005Z` —— 刷新确实打到了上游、也确实写了台账；
- **key 侧：零写入**。`upstream_keys.updated_at` 停在 `22:17:46.708Z`、`revision` 仍 1，`change_log` 无新行。

也就是说：ADR-0046 补的那条回填腿**被调用了**，却**一行都没写**。业主那句「明明是已有的数据，
key 管理还是要重新打一遍上游」会以新形状复发 —— 等套餐用量涨起来，台账会变、key 侧不会变。

## 根因

回填的**认领键**是 `key_masked`（`backfillSubscriptionTokenPlan`：按掩码在池内找**唯一**一把 key）。
而上游套餐列表（生产实测）**不带** `key` 字段，于是：

1. `mapSubscription` 给 `keyMasked = null`；
2. `refresh` 用这批行 `replaceSupplierSubscriptions` —— 该函数语义是"照抄全集"，把上一轮
   `keys/sync` 辛苦补好的 `key_masked` **一起照抄成 `NULL`**（`DELETE` + `INSERT`）；
3. `backfillSubscriptionTokenPlan` 走到 `if (masked === null) continue` —— 整行跳过，零写入。

三板斧各自都"没错"（掩码不可逆、认领必须唯一、未知不该编），拼起来却成了**死锁**：
`keys/sync` 补的掩码被 `refresh` 抹掉 → 回填认领不到 → 下一轮继续抹。生产真库的这条记录
`has_key=1 / key_masked=null` 就是死锁留下的现场。

`rotate-key` 有同一条腿：它也整体替换台账（其它套餐行的掩码会一起被抹），只是它顺手把目标套餐
用重置响应的新掩码 `upsert` 回去了，所以症状只落在"其它套餐"上。

## 决策

### 1. `refresh` 在写台账之前补掩码（两段）

顺序与 `keys/sync` 那一段逐字同构：**补掩码 → 写台账 → 回填**。

1. **播种**：读库里同一 `sub_no` 已知的掩码（`knownSubscriptionMasks`）先填回映射结果里 ——
   多数账号的掩码早就在手，这一步**零上游请求**；
2. **补漏**：只有"从没拿到过掩码"的行才走 `fillSubscriptionKeyMasks`（`/api/subscription/self/token?sub_no=`，
   §16.1.1 待实测那几个之一），**best-effort**：这一腿失败**不改变刷新的成败**，掩码留 `NULL`。

代价：最坏情况每个缺掩码的套餐多一次上游 GET；正常情况下（掩码已知）**零新增请求**。

### 2. `replaceSupplierSubscriptions` 的例外：已知掩码不退回未知

"整体替换照抄全集"有一条例外 —— **掩码**：

| 本轮入参 | 上一行 | 落库 |
|---|---|---|
| `keyMasked` 有值（含 `rotate` 响应给的新掩码） | 任意 | **本轮值**（更新的那个） |
| `keyMasked` 为空，`hasKey === true` | 有掩码 | **沿用上一行** |
| `keyMasked` 为空，`hasKey === true` | 无掩码 | `NULL`（本来就没有，宁缺勿假） |
| `hasKey !== true` | 有掩码 | `NULL`（掩码是"有 key"的从属事实） |

**跨 `sub_no` 绝不串用**：把 A 套餐的掩码安到 B 套餐行上，回填就会把 A 的余量写进 B 那把 key，
比留 NULL 坏一个数量级（与 §15.2 撞号不更新同一条取向）。

### 3. 不改的形状

- `tokenPlan` 三格语义不动：认领不到仍是 `NULL` = 「未同步」，前端照旧渲染「未同步」；
- `keys/sync` 不变，仍是**唯一会从上游 key 列表反查掩码**的路径（`/api/token/search` 那条）；
- 零 DDL、零端点、零枚举、零字段、零 DTO 变更。

## 后果

- **业主视角**：刷新一次就把套餐余量 / 到期带进 Key 管理；掩码早已在手的账号**不多打一次上游**。
  仍显示「未同步」的，只剩"上游从头到尾没给过掩码"那一类，兜底是 `keys/sync`（前端 tooltip 指名这条路）。
- **ADR-0046 的「已知边界 1」作废**：`refresh` 现在会补 `key_masked`（播种 + 补漏两段）。
- **`rotate-key` 顺带受益**：其它套餐行的掩码不再被整体替换抹掉。
- **网关选路不变**：仍读 `upstream_keys.token_plan_remaining`；变的是它现在**真的**跟着台账走。

## 判据（测试锚点）

| 判据 | 落点 |
|---|---|
| 套餐列表不带掩码 ⇒ 刷新补掩码（恰好一次上游调用）、台账掩码非空、key 列回填成 `total - used` | `supplier-accounts-write.spec.ts`「生产形状」 |
| 第二轮刷新：库里已有掩码 ⇒ **零新增**补掩码调用，掩码不退回未知 | 同文件「第二轮刷新」 |
| 补掩码腿 500 ⇒ 刷新仍 `ok:true`，掩码 `NULL`，key 侧**与刷新前逐字相同** | 同文件「best-effort」 |
| 整体替换：无掩码 + `hasKey=true` 沿用；带新掩码以本轮为准；`hasKey=false` 清空；跨 `sub_no` 不串用 | `repo/supplier-accounts.spec.ts` 四条 |
| 变异五项（摘补掩码调用 / 不沿用掩码 / 不播种 / `hasKey=false` 仍沿用 / 跨 `sub_no` 串用）全部先红后还原 | 已做（`_team/tmp/mutate-0047.ps1`） |

## 已知边界

1. **补掩码端点是 `§16.1.1 待实测`**：`/api/subscription/self/token` 的形状没钉死，所以这一腿是
   best-effort。真机返回形状变了 ⇒ 掩码补不到，刷新照常成功、key 侧留「未同步」，`keys/sync` 兜底。
2. **一次刷新最多为每个缺掩码套餐多打一次上游 GET**：批量刷 10 个账号、10 个都缺掩码时是 10 次。
   已知取舍：宁可多问一次，也不要让 key 侧永远显示「未同步」而去逼用户手动点同步。
3. **`key_masked` 一旦丢了就只能重问上游**（掩码不可逆，ADR-0018）：所以"沿用"是保底，
   不是可以省掉补掩码腿的理由。
