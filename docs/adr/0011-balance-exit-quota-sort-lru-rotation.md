# 11. 路由排序：balance 退出「剩余额度」键，兜底位改 LRU（单调序号）；0 真实尝试分型 502/503/429

- 状态：已接受（2026-10-06，PM 裁决批准即生效；本文同时是 Bo 终审备案件）
- 日期：2026-10-06
- 决策者：PM（裁决 ③④⑤）
- 提出人：路由者 · 网关内核（M5 验收 §九.1 失败上报）
- 关联：需求文档 §四.1 / §九.1、dev-constraints §三（本 ADR 回写）、api-contract §10 错误码表（429 触发条件同步，见 §6）

## 背景与问题

M5 验收 §九.1「轮询出量：2 上游 × 3 key，连续 60 次请求，每个健康 key 成功占比 ≥ 10%」**失败**。
实测：60 次串行请求，`k1` 独吞 100%，其余五把 key 出量 0。

根因是 M0 冻结的贪心排序（需求文档 §四.1：`权重 → 剩余额度 → 上次失败时间`）在 **balance 类 key**
上退化成了恒定全序：

1. `remainingQuotaOf` 的 balance 分支直接返回 `balanceCents`。余额（分）是**计费资金**，
   不随单次请求递减——60 次成功后 `balanceCents` 一点没变；
2. 于是排序键 2 在六把 key 上是 `10000 > 9000 > … > 5000` 的**唯一胜出者**，每次选路结果相同；
3. 键 3（上次失败时间）与键 4（稳定排序兜底=快照序）在键 2 已有唯一胜者时**永远轮不到生效**；
4. 结果：余额最高者垄断全部流量，其余 key 饿死。**验收 §九.1 的存在本身否定这种垄断**——
   这是 M0 冻结件的缺陷，不是实现 bug：实现忠实于冻结文本，冻结文本与验收判据冲突。

PM 的探针复现（裁决 ①）：把「场景 B 六把 key 余额互不相同」单独跑，A/B 都是 `k1=60 (100%)`、最低 0.0%
—— 证明**只动兜底位换 LRU 救不了 B**（键 2 在 B 里没有并列，兜底位到不了）。裁决 ③ 取 (b) 方案精神，
要求实现分两段。

## PM 裁决（原文口径）

- **③** 验收 §九.1 无条件成立（不做"余额优先消耗"的例外豁免）。实现两段式：
  1. `remainingQuotaOf` balance 分支改**常量 0** —— 余额退出排序键 2；`isUsable` 的
     `balance>0`/null 可用性过滤**不动**（这是"能不能用"，不是"先用谁"）；
  2. 排序兜底位从快照序改为 **LRU（最久未用优先，从未使用=最早）**；
  3. `RuntimeExtras` 增加"最近使用时间"，在 `beginAttempt` 成功占到并发位时打点；
     **不得进 `view()`** —— `/internal/snapshot`、`key_runtime` 镜像、契约响应形状零变化；
  4. 验收判据：A（余额未知）/ B（余额互不相同）/ C（token-plan 余量相等）各 60 次串行，每 key ≥10%
     （期望 10/10/10/10/10/10）；token-plan 场景 C 的既有轮转路径不得回退。
- **④** M0 冻结语义变更走契约+ADR 双轨：立本 ADR-0011，回写 dev-constraints §三 排序口径为
  `权重 →（token-plan 剩余额度）→ 上次失败时间 → LRU`；需求文档 §四.1 字面不动（只在 ADR 里记录），
  供 Bo 终审备案，不阻塞施工。
- **⑤** 502/503 对齐：候选为空 → 503 `NO_AVAILABLE_KEY`（保持）；**池饱和**（候选非空、并发槽位全满、
  0 次真实尝试）→ **429 + `Retry-After` 短退避**，code 复用 `RATE_LIMITED`，message 明示
  "pool saturated / 并发槽位已满，请退避重试"，**不得再报 502**；
  `secrets.resolve === null` 造成的 0 尝试是**配置异常**，单独分型归 503/500，不与并发饱和混。记入本 ADR。

## 决策

### 1. `remainingQuotaOf`：balance 分支返回常量 0

```ts
function remainingQuotaOf(key: KeyConfig, rt: RuntimeExtras): number {
  if (key.category === 'token-plan') {
    if (key.tokenPlanRemainingTokens === null) return -1; // 未知 → 排序靠后，不排除
    return Math.max(0, key.tokenPlanRemainingTokens - rt.spentTokens);
  }
  return 0; // balance：ADR-0011
}
```

- **token-plan 分支语义不变**：套餐余量是随请求真实递减的配额，乐观扣减（`spentTokens`）天然产生轮转，
  这是验收 1 在该类目上的既有路径（场景 C 回归不得回退）。
- **可用性过滤与排序解耦**：`isUsable` 里 balance 的 `balanceCents === null || > 0` 判据原样保留
  （未知 ≠ 0：余额未知仍可用；≤0 排除）。"退出排序" ≠ "退出池子"。

### 2. 排序比较器：五键终版

```
1. weight 降序
2. remainingQuotaOf 降序          // 只对 token-plan 有意义；balance 类恒 0 → 键 2 全平
3. lastFailureAt 升序（从未失败 = -1 = 最早）
4. lastUsedSeq 升序               // LRU：最久未用优先；从未使用 = 0 = 最早
5. 快照序兜底                     // 序号全异的场景到不了这里，纯防御位
```

### 3. 实现注记：为什么是 `lastUsedSeq`（单调序号）而不是 PM 字面的 `lastUsedAt`（墙钟）⚠️ 待 PM 追认

第一版按裁决字面实现 `rt.lastUsedAt = now()`，轮询 spec A/B 照样红：`k1 = 38~42/60（63%~70%）`。
原因：**实测 60 次串行请求整轮跑在 ~1ms 内**，`Date.now()`（含注入钟）的毫秒分辨率让多把 key 拿到
**同一个 stamp** → 键 4 并列 → 落到键 5 快照序 → 快照第一把照样吃掉全部流量 —— 饥饿只是换了一层键复活。

改法：池闭包持有一个单调计数器 `usedSeq`，`beginAttempt` 成功占到并发位时 `rt.lastUsedSeq = ++usedSeq`。
序号与请求速率无关，任意吞吐/队列深度下都是**严格全序**，键 4 永不并列，饥饿在构造上不可能复发。
语义与 "lastUsedAt asc" 完全一致（最久未用优先），只是把"时间"从墙钟换成使用序 —— **墙钟分辨率不够
不代表轮询语义可以打折**。此偏差记录在案，代码注释同步指向本 ADR。

- 打点位置保持裁决要求：`beginAttempt` 成功路径（真的要去敲上游才算"用过"；满并发被拒不计）。
- `lastUsedSeq` **不进 `view()`**、不落 `key_runtime` 镜像、不出现在 `/internal/snapshot` 与任何
  契约响应 —— 它是选路内部游标，不是对外健康态。key-pool.spec 有用例断言 `view()` 输出形状零变化。

### 4. engine 分型：`attempts === 0` 但候选非空 ≠ 上游故障

冻结口径"分界是候选集是否为空"有一个漏洞：**候选列表返回时非空，但逐个 `beginAttempt` 全被拒**
（并发槽位在选路与派发之间被占满）—— 0 次真实上游尝试却报了 `502 UPSTREAM_ERROR`，把"池子忙"
谎报成"上游坏了"，排障方向整个反掉。新分支（候选循环之后、502/504 组装之前）：

| 计数形态 | 响应 | 理由 |
|---|---|---|
| `skippedSaturated > 0` 且 `skippedUnresolvable === 0` | **429 `RATE_LIMITED` + `retry-after: 1`**，message `pool saturated: N key(s) at max concurrency, retry shortly` | 客户端退避重试即可恢复，不是故障 |
| `skippedUnresolvable > 0`（含混合形态） | **503 `NO_AVAILABLE_KEY`**，message `no candidate dispatchable: N key(s) unresolvable[, M saturated]` | 配置异常（快照有 key、密文解不出），重试无用，要人去查 |
| `attempts > 0` 全失败 | 502/504（**原口径不动**） | 真的敲过上游且每把都失败，才是上游故障 |

两条硬要求都落了：饱和分支**绝不 502**（裁决 ⑤ 原文），`secrets.resolve === null` **单独分型不混入饱和**。
两条分支各记一条 `logAttempt`（429/503、`keyId=''`、`failureReason: null` —— 0 真实尝试不污染任何 key 的健康计数）。
`retry-after` 经 `GatewayError.retryAfterSec` 透传到 `routes.ts writeForwardResult`，与用户组限流 429 同一写头路径。

### 5. ⚠️ 503 复用 `NO_AVAILABLE_KEY` 而非新 code/500 —— 待 PM/管家追认

裁决 ⑤ 对配置异常写的是"归 503/500"。终版选择 **503 + 复用 `NO_AVAILABLE_KEY`**：
语义上"没有一把 key 真的可派发"成立（可派发 ⊆ 候选），且避免给错误码表添新值。
"还是 500 内部错误"的另一种读法未采纳 —— 网关此时状态自洽，缺的是配置，不是代码不变量。

### 6. 饱和分型在真实池上是**竞态窗形态**（测试缝隙说明）

真实 `KeyPool.isUsable` 会把满并发的 key **预先过滤出候选**，所以"候选非空但全饱和"在稳态下不可达，
只在「`getAvailableKeys` 返回之后、`beginAttempt` 逐把占位之前」的窗口内出现（并发请求恰好填满槽位）。
engine.spec 用 `stubPool`（列候选 + `beginAttempt` 一律拒绝）搭出这条分支 —— 这不是人造状态，
就是生产竞态窗的形状；稳态饱和（预过滤即空候选）走的是既有 503 `noAvailableKeyError`，同样不是 502。

## 影响

- **`src/gateway/key-pool.ts`**：`RuntimeExtras` 增 `lastUsedSeq`；比较器键 2/4/5 如 §2；`beginAttempt` 打点。
  `view()` / `applySnapshot` / `reportFailure` / `reportSuccess` 形状与语义零变化。
- **`src/gateway/engine.ts` + `errors.ts` + `routes.ts`**：新增 §4 分型与 `poolSaturatedError` /
  `poolMisconfiguredError` / `retryAfterSec` 透传。`GatewayError` ctor 尾部可选参，既有构造点不动。
- **契约**：api-contract §10 的 `RATE_LIMITED` 行触发条件需从"用户组 RPM/TPM 超限"扩为
  "…超限 **或 网关池饱和（0 真实尝试，全候选并发已满）**"；两张 429 语义仍统一
  （退避后可重试、`retry-after` 必带）。等管家同步确认（派单已含）。
- **管理端/前端**：零接口变更。`health`/`cooldownUntil`/`consecutiveFailures`/`lastFailureReason`
  四字段来源不变；饱和分型 `failureReason: null` 不计入任何 key 失败。
- **dev-constraints §三**：签名注释与硬约束回写为本 ADR §2 的五键口径（随本分支提交）。
- **dev-constraints §六**：`test:gateway` 从"语义名未落地"转正式（`vitest run src/gateway`，
  含 `rotation.spec.ts` 轮询分布判据）；`test:fault` / `bench:ttfb` 维持未落地标注。

## 验证（判据不是"排序代码写了"，而是分布）

`src/gateway/rotation.spec.ts`：2 上游 × 3 key、权重相等、连续 60 次串行请求走**真实 engine + 真实池**
（fetch 打桩），判据 = 每把 key 出量 ≥10%，另加两个反向钉：
- B 场景额外断言 `top ≤ 30`（余额最高者不得超过半 —— 哪怕其余 key 都过 10%，垄断仍判失败）；
- `isUsable` 过滤不被放松：余额 0 / 套餐过期仍排除（本 ADR 只动排序，不动过滤）。

实测：A/B/C 全部 10/10/10/10/10/10；旧排序下 A/B 为 60/0/0/0/0/0。key-pool.spec 另钉 LRU 确定性轮转
（用掉谁谁沉队尾、跨权重档仍按权重）与 `view()` 形状不变。
