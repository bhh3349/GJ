# ADR-0046：套餐数据单源 —— 台账写进哪，key 列就跟到哪

- 状态：已接受（2026-11-03）
- 相关：ADR-0003（未知 ≠ 0）、ADR-0018（套餐不建 key）、ADR-0022（套餐 key 轮换 / 「不猜」）、
  ADR-0043（废号池）、ADR-0045（账号连坐收窄）
- 契约：v1.22.0（§3 `tokenPlan` 增 `amountTotalCents` / `amountUsedCents`；§15.3 变更条）

## 触发

业主 2026-11-03 拿两张截图对比：

1. **Key 管理**：`套餐-轻享版 ****m8d0` 等 10 行，每行 `8M / 8M`、`到期 2026-12-03 06:06:41`；
2. **账号池「套餐台账」**：同一批账号，`套餐剩余 ¥29.90（100%）`、`基础额度 800 万（100%，已用 0）`、`到期 …`。

原话：

> 这才是套餐 key 的真实数据，明明已经有了为什么不同步到 key 管理，key 管理居然还要重新打一遍上游。数据也没显示对。

三件事被同时点出来：

- **A 数据链断裂**：台账里有、Key 管理不跟着更新，要人再点一次「同步套餐余量」（= 同一账号再打一遍上游）。
- **B 显示不全**：台账的 ¥ 额度面（`¥29.90`）在 Key 管理那一格完全看不见，只看得见 token 那一半。
- **C 显示错误**：台账「到期」列把 **还有 29 天** 渲染成 `29 天前`，读起来像已过期。

## 根因

### A：回填腿只接了一半

`backfillSubscriptionTokenPlan`（`repo/supplier-accounts.ts`）的文件头写着：

> ADR-0022 落库时刻意把 `token_plan_remaining` 留 `NULL`，承诺「由后续 `keys/sync` / **余额刷新**回填」。

实际调用点只有 `keys/sync`（`services/supplier-accounts.ts`）。**`refresh`（账号池「刷新余额」）把上游套餐响应
写进台账（`replaceSupplierSubscriptions`）后直接返回，没有回填 key 列**；`rotate-key` 同理 —— 新 key 以
`token_plan_remaining = NULL` 入池，尽管重置响应里就带着这份套餐的额度。

于是业主看到的现象是必然的：台账新、key 列旧/NULL，而**唯一**能补的按钮是再打一遍上游。

### B：读面只带 token 那一半

`repo/keys.ts` 的 `linksByKeys` 从台账 join 出 `basic_token_total`（`totalTokens`），**没带 `amount_total_cents` /
`amount_used_cents`**。同一个 `supplier_account_subscriptions` 行里的钱额度，前端拿不到。

### C：过去式格式化器被用在了未来时间上

`web/src/utils/format.ts` 的 `formatRelative` 先算 `Date.now() - t` 再取绝对值，**一律输出「N 天前」**。
它本来服务「余额更新于 / 最后失败于」这类过去时刻；被 `SupplierSubscriptionsTable` 的「到期」列复用时，
`2026-12-03` 会显示成 `29 天前`。

## 决策

### 1. 台账与 key 列在同一笔里更新（写侧）

`refresh` 与 `rotate-key` 在写台账的**同一笔**里调 `backfillSubscriptionTokenPlan`：

- `refresh`：`replaceSupplierSubscriptions` 之后立即回填（台账行必须先就位，回填按 `key_masked` 认领池内 key）。
- `rotate-key`：新 key 入池后立刻用**本次重置响应**的套餐行回填（掩码取 `call.result.data.maskedKey`，
  与 `upsertSupplierSubscription` 写的 `keyMasked` 同一来源）。`plan` 为 `null` 时三格都取不到 → 整行跳过。

回填失败不阻塞主流程：它只是让那把 key 少留一轮「未知」，仍可选路（`UNKNOWN_PLAN_QUOTA`）。

### 2. 钱额度进 §3（读侧）

`tokenPlan` 增 `amountTotalCents` / `amountUsedCents`（`int | null`，单位分），与 `totalTokens` **同一唯一匹配条件**
（`key_masked` 唯一命中一行）。

**三格各自透传**：token 未知不拖累金额、金额未知不拖累 token。实现上把 `if (n !== 1 || totalTokens === null) continue`
放宽为 `if (n !== 1) continue`，逐格赋 `null`/值 —— 「宁缺勿假」按**格**执行，不按行连坐。

### 3. 到期列用到期专用格式化（展示侧）

`formatRelative` 保持过去式语义不动（它服务「更新于 / 失败于」）。到期一律走新的
`formatUntil`（`还剩 N 天` / `已过期 N 天`，精确时刻进 tooltip）。前端 owner = 画师，载体 `dev/web-m2`。

## 后果

- **业主视角**：点一次「刷新余额」后，Key 管理立刻能看见余量 / 总量 / ¥额度 / 到期，不必再点「同步套餐余量」。
- **上游请求数**：从「刷新 + 同步」两轮降到一轮。`keys/sync` 仍是唯一会**补 `key_masked`** 的路径
  （`fillSubscriptionKeyMasks` 按套餐逐条查、成本高），所以「上游列表不带掩码」的账号仍需它，这是已知边界。
- **网关选路不变**：仍读 `upstream_keys.token_plan_remaining`。变的是**这列现在总是跟着台账走**，
  所以「管理面显示」与「网关选路」不会各执一词。
- **零 DDL**；`rotate-key` 的新 key 不再以「未同步」入池（旧行为见 ADR-0022 的「不猜」，
  那条**没被推翻**：响应里没有额度时仍然是 `NULL`）。

## 判据（测试锚点）

| 判据 | 落点 |
|---|---|
| `refresh` 后 key 的 `token_plan_remaining / expires_at` 等于台账同一行的 `total - used / end_at` | `supplier-accounts-write.spec.ts`「refresh 顺带回填…」 |
| 回填后 `GET /api/keys/:id` 给出余量/总量/到期，**且零上游调用** | 同上（`h.upstream.calls` 前后相等） |
| `rotate-key` 新 key 的余量来自本次响应（`8,000,000 − 2,666,169`），到期 = 台账 `end_at` | 同文件 rotate 用例 |
| 金额两格：唯一匹配时带出；token 未知不拖累金额 | `repo/keys.spec.ts` 两条 |
| 变异：摘掉回填调用 → 首条红；金额两格写死 `null` → 后两条红 | 已做，红后还原 |

## 已知边界

1. **`refresh` 不补 `key_masked`**：上游列表没给掩码的行，回填跳过（宁缺勿假）。要补掩码请用 `keys/sync`。
2. **多套餐同掩码**：三格一起回 `null`（撞号不猜，与回填腿同取向）。
3. **钱额度不是计费口径**：`¥29.90` 是套餐的高级额度面（quota），`amount_used_cents` 由上游给；
   它不参与余额/透支判据（那是 `balance_cents` 与 `basic_token_*` 的事，见 ADR-0041 / ADR-0043 / ADR-0045）。
4. **到期显示是前端责任**：后端只给 ISO8601 UTC；「还剩 / 已过期」的措辞与颜色在前端，不得改契约字段。
