# 10. `key_runtime`：网关运行态镜像落库，且不参与冷启动

- 状态：已接受（2026-10-06）
- 日期：2026-10-06
- 决策者：管家 · 管理后端（`key_runtime` 归 `src/db`）
- 提出人：路由者 · 网关内核（M3 适配层收口时作为"开放待办 1"报备：`key_runtime` 从未持久化）

## 背景与问题

契约 §3 的 Key 对象有四个字段标着「**网关运行态**，管理端只读」：

```
health: "healthy" | "cooling" | "disabled"      // disabled 优先于 cooling
cooldownUntil: ISO8601 | null                   // health=cooling 时非空
consecutiveFailures: int
lastFailureReason: AUTH_INVALID | RATE_LIMITED | INSUFFICIENT_BALANCE | UPSTREAM_ERROR | NETWORK
```

承载体是 `key_runtime` 表（schema 里存在，`key_id` 主键，含 `consecutive_failures / cooldown_until /
last_failure_reason / last_failure_at / updated_at`），管理端的读路径也早就接上了：

- `src/db/repo/keys.ts` 的 `SELECT_BASE` 把它 `LEFT JOIN` 进来，`deriveHealth()` 据此派生 `health`；
- `?health=disabled|cooling|healthy` 的筛选在 SQL 里按同一判据过滤（`keys.ts:144-155`）；
- `src/db/repo/models.ts` 的 `availableKeysByUpstream` 也用它排掉冷却中的 key。

**但全仓没有任何一行代码写它。** 实测（`dev/api @ d842cf3`）：

```
$ grep -rn "key_runtime" src/ --include=*.ts | grep -v schema.ts
src/db/repo/keys.ts:54,167   (LEFT JOIN，读)
src/db/repo/models.ts:54     (LEFT JOIN，读)
$ grep -rn "INTO key_runtime\|UPDATE key_runtime" src/ web/
(空)
```

于是出现一个**比"重启丢状态"更严重的问题**：不是"运行态会丢"，而是"运行态**从来没有过**"。

- `cooldown_until` 永远是 `NULL` ⇒ `deriveHealth()` 恒返回 `healthy`（除非管理员把 key 停用），
  画师仪表盘上的「key 健康状态」会**永远全绿**，哪怕一把 key 已经连挂 20 次；
- `?health=cooling` 的筛选**永远返回空**，`consecutiveFailures` 恒为 `0`；
- 契约 §3 的四个字段在可观测层面是**假数据**——不是"暂时没数据"，是"字段存在但永远报安好"。

路由者报备的原话是"网关重启后 key 健康态归零"。核查后要把它改写成更准确的一句：
**网关运行态只活在 KeyPool 的进程内存里，管理端看不到，重启前后都看不到。**

## 备选方案

| 方案 | 结论 |
|---|---|
| A. 只写一条 ADR 记「重启即归零」为既定降级，不落库 | **否**。降级的前提是"曾经有、现在退让"；这里是"从来没有"。采纳它等于承认契约 §3 的四个字段永久失效，且要另外删掉 `key_runtime` 表、`LEFT JOIN` 与 `?health=` 筛选（更小的改动面，但等于把已发布的字段和筛选能力砍掉）。这不是降级，是**把功能删掉换省事** |
| B. 让 `/api/keys` 直接读网关进程内的池（同进程注入 provider） | 否。管理端列表是 SQL 侧分页 + 排序 + `?health=` 筛选，改成内存合并要重写分页/筛选语义；且会让 `src/api` 直接依赖网关内核，破坏 AGENTS.md §8 的边界。同进程不是理由——那条边界是为了让两边的知识不互相渗透，省掉一次写库不值得把它拆了 |
| C. **周期性批量镜像到 `key_runtime`**（攒批、去重、只写真变了的行，跑在定时器上） | **采纳** |
| D. 每次成功/失败立即写库 | 否。`reportSuccess/reportFailure` 在 `/v1/*` 请求线程上，同步写库直接把 TTFB 卖给 SQLite 写锁，验收 ⑥⑧ 当场破，也违反契约 §9「热路径零同步 DB 写」 |

## 决策

### 1. 方向单向：池是权威源，表是镜像

```
KeyPool（进程内存，权威） ──批量镜像──▶ key_runtime（SQLite） ──LEFT JOIN──▶ /api/keys（只读展示）
```

- **网关进程是 `key_runtime` 的唯一写者**（单写者原则，AGENTS.md §5）；管理端依旧一行都不写，
  `src/db/repo/keys.ts` 里不提供写入口（这条纪律靠"不提供 API"保证，不靠文档约定）。
- 镜像**不是契约**：网关运行时**不读**它（`src/wiring/store.ts` 的 `KEYS_SQL` 只读 `upstream_keys`）。
  唯一的读取方是管理面。

### 2. 写入形态：攒批 + 差集，绝不在请求线程上

- 由定时器驱动（与 `usage-sink` 同款形态），约 **1s** 一次；一次事务写完一批。
- 只写**值真的变了**的行：池里成功一次会把 `consecutiveFails` 归零，若每次都写，健康 key 会按 QPS
  产生无意义的写放大。差集比较放在 flusher 侧（内存里的 last-written 快照），不放在 SQL 里。
- 冻结的写入 API（已随本 ADR 落地，`src/db/repo/key-runtime.ts`）：

  ```ts
  upsertKeyRuntimeStates(
    db: Db,
    states: readonly { keyId; consecutiveFails; cooldownUntilMs; lastFailureReason; lastFailureAtMs }[],
    at?: string,
  ): number
  ```

  入参用 **epoch ms**（与 `KeyRuntimeState` 一致），**ISO8601 UTC 的转换只在仓储里发生**（契约 §0.2）。
  `null` 落成 SQL `NULL`，不落成 `0` 或 `''`。
- 该函数**只 upsert，不删行**；不传的行保持原样。

### 3. 不参与冷启动：重启即归零是**既定降级**（本次正式记录）

进程启动时**不从 `key_runtime` 恢复**冷却与连续失败计数。理由：

- 持久化的冷却只能让池子**更保守**。若重启前全部 key 都在冷却中（最坏：AUTH_INVALID 档 30min），
  恢复它们会让网关在重启后**继续 503 长达 30 分钟**，而此刻马上重试、让每把已知坏 key 各付一次
  失败代价，反而能立刻发现"上游其实已经好了"。
- 后者的代价是**有界的**：每把已知坏 key 最多吃一次失败，且被 `maxAttempts=3` 的重试覆盖 ——
  客户端在池中还有健康 key 时依然拿 200。前者是**可观测的可用性损失**，会被记成"重启后半小时全站 503"。
- 用一个有界的延迟抖动，换掉一个无界的可用性损失，是划算的。**故不恢复。**

### 4. 但镜像不许撒谎：首次刷写必须写全量

上一进程留下的行在重启后**是陈旧的**（冷却可能还在未来）。若只写"本 tick 有变化"的 key，
这些陈旧行会一直躺在表里被管理端当成现状读出来 —— 又变成假数据。

因此 flusher 的判据是「**全量池状态 vs 上次已写值**的差集」，且**启动时把全部快照 key 标脏**：
第一个刷写周期（≤1s）内，全量状态（含归零的 `consecutiveFailures=0 / cooldown_until=NULL`）
被写回，陈旧行在一个周期内被纠正。管理端的"新鲜度预算"是 5s（验收 ③），1s 满足。

### 5. `failCount`（累计失败总数）不落库

池里的 `failCount` 是**进程内累计**，`key_runtime` 只存 `consecutive_failures`。契约 §3 也只要后者。
累计数只在 `/internal/snapshot` 上存在 —— **不落库、不承诺**。这样重启后"累计失败数归零"是
契约内行为，不是背离。管理端要长期失败统计，看 `usage_logs.error_code` 聚合（这是账，不受重启影响）。

## 影响

- **管理端（管家）**：`?health=` 筛选与健康灯第一次有真实数据；契约 §3 补上"来源与新鲜度"说明（v1.0.3）。
  `/api/*` 的响应形状与字段**零变更**。
- **网关（路由者）**：新增一个 flusher（`src/wiring/` 内的接线层，与 `usage-sink.ts` 同族）：
  定时器 → `pool.view()` → 与上次已写值比差集 → `upsertKeyRuntimeStates()`。**不碰 `src/gateway/`**。
  两条硬约束不变：`SecretResolver.resolve()` 仍是同步内存读；`UsageLogSink.record()` 仍只入队不 await。
- **前端（画师）**：无接口变更；Dashboard 的 key 健康灯在网关运行后第一次会真的变色。
- **schema**：**无变更**（`key_runtime` 表本就存在且列够用）。这一点也是选 C 而非 A 的理由之一 ——
  采纳 C 的净成本只是"一个 flusher"，而采纳 A 要删表删筛选。

## 已知缺口（不在本次范围）

1. **软删 key 的残留行**：`key_runtime` 行在 key 软删后保留（本函数只 upsert 不删）。当前无可见影响
   （管理端列表按 live key 过滤），但表的清理规则要补 —— 记入 **M4 的 `src/db` 改造清单**
   （与 ADR-0008 的 `gateway_keys.deleted_at` 列删除、ADR-0009 的 `models.manual_fields` 同批）。
2. **`kill -9` 丢最后 ≤1s 运行态**：与 `usage-sink` 同款权衡（攒批 vs 丢批），可接受；且重启即归零已裁决。
3. **镜像滞后 1s**：管理端读到的运行态最多滞后 1s。对"看板上的健康灯"够用，**不要**拿它做自动化决策
   （如"冷却中就跳过"）——那类判断必须走网关内部状态。
4. **`costCents` 未知单价计 0** 与本 ADR 无关，但同属"契约没定义就实现"的欠账，已在契约 v1.0.3 §6 写明口径。

## 门禁核验

在 `.worktrees/api`（分支 `dev/api`，基点 `main = d842cf3`）实测：

| 闸 | 结果 |
|---|---|
| `pnpm run typecheck` | 0 error |
| `pnpm run test` | 见回执（新增 `src/db/repo/key-runtime.spec.ts`） |
| `pnpm run check:secrets` | 见回执 |
| `pnpm run build` | PASS |

新用例的判据不是"能写进去"，而是四条边界：① ms→ISO 转换与 `null` 口径（非整秒的 ms 值专门抓"忘了转换"）；
② 重复写幂等（冷启动全量重写依赖它）；③ 空数组不产生空事务；
④ **管理端读路径立刻可见** —— 写完 `health` 从 `healthy` 变 `cooling`、`?health=` 筛选口径一致、
冷却过期自动回 `healthy`、且 `enabled=false` 仍然是 `disabled`（运行态不越权覆盖管理端开关，契约 §3 优先级）。
