# ADR-0030：套餐 key 优先于余额 key —— ADR-0011 排序键 2 追认

- 状态：**已接受（2026-10-16，PM 批准「可以按你的方案优化」）**
- 关联：**ADR-0011 决策 1/§2（被本文追认修正）**；ADR-0022 §「与 ADR-0018 / ADR-0011 的关系」（被本文修订）；
  `docs/dev-constraints.md` §三.6；契约 v1.13.1 §15.2 / §15.13
- 车道：网关内核（`src/gateway/key-pool.ts`，1 个常量）+ 管家（`src/db/repo/supplier-accounts.ts` 新增回填、
  `src/api/services/supplier-accounts.ts` 接线）
- 触发：用户需求原文 ——「TierFlow 不是有两种 key，能不能先做套餐 key 判断……先处理套餐 key 比较合理
  毕竟套餐 key 只有 30 天有效期」。

## 背景：ADR-0011 落下的两个半截，缺一个都不成立

用户的诉求是一个**优先级**：先用套餐 key，再用余额 key。落地它需要两件事同时为真，
而 ADR-0011 之后这两件事**都不真**：

| # | 需要为真的事 | 2026-10-16 之前的实际状态 | 后果 |
|---|---|---|---|
| 1 | 池内套餐 key 知道自己还剩多少额度 | `token_plan_remaining` 落 `NULL`（ADR-0022 §4 承诺"由后续 `keys/sync` / 余额刷新回填"，**那个"后续"从来不存在**） | 排序键 2 对套餐 key 恒为哨兵值，真实余量不参与选路 |
| 2 | 哨兵值**大于** balance 类的常量 0 | `tokenPlanRemainingTokens === null → return -1`（ADR-0011 §1 代码块原文） | 哨兵 −1 **小于** 0 ⇒ 余量未知的套餐 key 排在**每一把余额 key 之后** |

两条叠起来的实际行为与用户目标**正好相反**：一把刚 rotate 出来、尚未回填的套餐 key，
在选路里排在一把余额 999999 分的余额 key **后面** —— 套餐 30 天有效期一天天流逝，
流量全走余额 key。**只做 1 不做 2**：排序仍反着，套餐 key 有额度也排在余额 key 后；
**只做 2 不做 1**：`token_plan_remaining` 还是 NULL，修了排序也排不出真实优先级。
所以本 ADR 两项一起落地。

### 为什么"回填"那一腿现在才补（而不是 ADR-0022 当时）

ADR-0022 §4 把回填留给"后续"，因为当时**没有回填的数据源**：rotate 的响应只给明文，
不给余量。而 `GET /subscription/self`（`TIERFLOW_PATHS.subscriptions`）恰好每轮同步都会调一次，
它的 `all_subscriptions[]` 里就带着 `basic_token_total` / `basic_token_used` / `end_time`
（字段名与 `sk-` 剥离规则见 `src/supplier/subscriptions.ts` 文件头，实测 2026-10-12）。
数据源一直都在，缺的只是把它接到 `upstream_keys` 上的那一步。

## 决策

### 1. `remainingQuotaOf`：未知哨兵 `-1 → 1`

```ts
/** 「套餐余量未知」在排序键 2 上的取值（ADR-0011 追认，2026-10-16）。 */
const UNKNOWN_PLAN_QUOTA = 1;
```

**取 `1` 是唯一同时满足两个约束的值**，不是随手挑的正数：

1. `> 0`：压过 balance 类的常量 0 —— 余额 key 排在所有套餐 key 之后（这是用户诉求本身）；
2. `≤ 任何可用套餐 key 的真实余量` —— `isUsable` 已把余量 0 的套餐 key 排除，
   所以"可用"的已知余量**最小就是 1**。未知值因此不会盖过任何一把真实有额的套餐 key。

反面教材写在这里以免复发：若图省事取 `Number.MAX_SAFE_INTEGER`，"刚 rotate、还没回填"的 key
会压过一把只剩 2 个 token 的套餐 key —— 那才叫本末倒置（该被先用完的是**快没了的**那把）。

`isUsable` 的 `remainingQuotaOf(...) !== 0` 判定**不受影响**（`1 !== 0` ⇒ 仍可用）。
ADR-0011 的"未知 ≠ 不可用"纪律完整保留，本文改的只是它排在**谁前面**。

### 2. 回填腿：`backfillSubscriptionTokenPlan`（补上 ADR-0022 §4 承诺的"后续"）

`src/db/repo/supplier-accounts.ts` 新增一个写函数，由 `syncForAccount` 在
`replaceSupplierSubscriptions` 之后调用（此刻 `fillSubscriptionKeyMasks` 刚把 `key_masked` 补全，
而台账里已有的入池套餐 key 是上一次 rotate 留下的，不受本轮影响）。三条取值纪律：

1. **单位是 Token 个数，不是钱**：`basic_token_*` 绝不走 `quotaToCents`
   （1 元 = 500000 quota 是 **`amount_*`** 那套池的换算率；`basic_*` 本来就是个数值）。
   误除一次的后果是 800 万 → 16，网关侧等于"这把 key 只剩 16 个 token"。
2. **两个都取不到就整行跳过**：`basic_token_total` 为 `null` 是"上游没说"，
   不是 0 —— 写 0 会让那把 key 被 `isUsable` 静默排除出选路。
3. **余量可递减**，所以**不能**复用 `applyTemplateTokenPlan`（它写 `COALESCE(?, 列)`，
   永远填不进更小的数）：这是必须单开一个函数的全部理由。

其余形状：`UPDATE … WHERE id = ? AND category = 'token-plan'`（余额 key 结构上摸不到，
`hits.length !== 1` 的掩码撞号直接跳过 —— 宁可留 NULL，也不把 A 套餐的余量写到 B 的 key 上）；
`Math.max(0, total - used)` 夹掉上游计费的负余量瞬态；
每把命中的 key 在同一 `db.transaction` 里各发一条 `appendChange(db, 'balance', …)`
（`'balance'` 在 `SNAPSHOT_ENTITIES` 里，配额列变了就该让网关重快照）。

### 3. 为什么这次**没有**复活 ADR-0011 的"按余额排序"

ADR-0011 §1 把 balance 类钉成常量 0 的理由（余额是计费资金、不随请求递减，
按它排序 = 余额最高者垄断流量、破验收 §九.1）与本文**完全无关**：本文让余额 key
整类沉到套餐 key 之后，靠的是**类目**而非**余额高低**；余额 key 之间仍在键 2 上全平，
轮转照旧交给 LRU。`src/gateway/rotation.spec.ts` 的 A/B/C 三场景与
"余额最高者不得超过半"判据**继续全绿**即为此事的回归面。

## 代价与已知边界（不粉饰）

1. **套餐 key 打不动的模型不会再被换 key 兜住**：实测（2026-10-12）套餐 key 只服务 `tierflow` /
   `tierflow_pro` 一类模型，`TierSense` 回 **404 `request_scheme_not_found`**。而 404 在
   `classifyUpstreamStatus` 里归 `null` = 客户端错、**原样透传不换 key**（契约 §10 既定）。
   ⇒ 套餐 key 排前之后，一个套餐不支持的模型可能直接拿到那个 404。
   **这不是本文引入的新风险**：只要套餐 key 有**已知**余量，ADR-0011 时代它就已经排在余额 key 前面了；
   本文只是把"刚 rotate 完还没回填"的那段时间窗也纳入同一语义。
   **刻意不在本文修**：修法要动 `classify.ts` 的 404 口径（把"上游不认识这个模型"从客户端错
   里分出来）或给 rotate 写 `model_limits` 白名单，都是独立的契约决策 —— 留给后续 ADR，
   并已在 p2 计划外单列。真要立刻绕开，管理面把 `model_limits` 显式写窄即可（既有能力）。
2. **回填有延迟**：`token_plan_remaining` 在两次同步之间可能是 `NULL`。按本文口径它排在有额套餐
   key 之后、余额 key 之前 —— 这个位置是**刻意**的：它同时保住了"先用套餐"与"真实余量优先"。
3. **乐观扣减的口径仍不精确**：`reportSuccess` 对所有 token-plan key 一律
   `spentTokens += tokens.total`，而套餐的 `basic_*` 池与 `amount_*` 池是分开的
   （用户口径：低端请求扣赠送的 8M、复杂请求走高级余额）。这把 key 的排序档位会被
   `amount_*` 消耗**额外压低**。属 ADR-0011 既有行为，本文未动，留作下一步。

## 验证口径（已落）

- `src/gateway/key-pool.spec.ts`：新增「套餐 key 一律排在余额 key 之前」用例
  （余额 key 刻意给 999999 分仍必须沉底）+ 反向钉「哨兵 1 不越过真实余量 2」；
  原「token-plan 仍按套餐余量降序」用例的 `tp-unknown` 期望位同步更新。
- `src/db/repo/supplier-accounts.spec.ts`：回填腿共 **9 条**（单位是 token 不是钱 /
  used 缺失即未用过 / 总额未知零写入零广播 / 余量递减真的写进去 / 每把命中 key 一条广播 /
  掩码撞号不动 / 余额 key 结构上摸不到 / 负余量夹 0 / 空输入零写入）。
- 四闸（`/opt/node22/bin/node` 下实跑）：`typecheck` RC=0 ｜ 全量 `test` **909 → 910 passed** ｜
  `check:secrets` 0 命中 ｜ `rotation.spec.ts` A/B/C 与「余额最高者不得垄断」判据**无回退**
  （验收 §九.1 仍成立 —— 本文没有复活按余额排序，余额 key 之间照旧在键 2 上全平）。
