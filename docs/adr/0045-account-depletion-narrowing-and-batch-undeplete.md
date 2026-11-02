# ADR-0045：账号级透支连坐收窄为「余额且套餐都见底」+ 批量解除透支

- 状态：**已接受（Accepted，2026-11-03）**——业主现场反馈（见「触发」），Chief 裁决两条：判据收窄（根治）+ 批量解除（补救）。
- 关联：**ADR-0041**（透支锁存，被本文修订：其 §20.6 账号级级联的判据从「只看余额」收窄为「余额且套餐」）、
  **ADR-0043**（废号池，本文复用其「且」口径与套餐有效性判定）、**ADR-0003**（未知 ≠ 0，判据延续）；
  契约 §20.2（判据表）/ §20.6（账号级级联）/ §20.5（解除入口）/ §15.2（端点表）/ §15.3（批量 result）。
- 车道：`src/db/depletion.ts`（判据）、`src/db/repo/depletion-latch.ts`（无改动，级联函数原样）、
  `src/api/services/supplier-accounts.ts`（判定腿传参）、`src/api/routes/supplier-accounts.ts`（新批量端点）。
  前端 `web/`（批量按钮）由画师同批承接，载体 `dev/web-m2`。

## 触发（业主原话，2026-11-03）

> 「现在有套餐余额，还是透支了，需要一个一个解除，要么你加个批量解除，要么你就那边的 key
> 没有余额就停用那边的 key，这种余额 key 透支，不应该禁止该账号下所有的 key」

截图现场：账号 `余额 ¥0.00`、`套餐余额 ¥29.90（1 个套餐）`、`健康：余额偏低 / 透支`。
也就是说**账号还有 29.90 的套餐额度，却被打上透支锁、名下 key 全被级联停用**。

## 背景：判据歪在哪

1. `isAccountDepleted`（`src/db/depletion.ts`）= `isBalanceDepleted`：**只看余额**，
   `balanceCents < 10` 分即判 true，**完全不看套餐余量**。
2. `latchAccountIfDepleted`（`services/supplier-accounts.ts:811`）判出来后连做两件事：
   账号自身 `depleted_at` 置位 + `latchAccountCascade` **把名下所有池内 key 打 `depleted_reason='account'`**
   （`repo/depletion-latch.ts:59`，含 token-plan 类）。
3. 于是「余额 0 + 套餐 29.90」这种账号：套餐 key 明明能干活，却被连坐锁死；
   而锁存是**粘性**的（§20.3，只置位不自动清），只能逐个 `POST /:id/undeplete` 手工救。

对比 **ADR-0043 废号池**：那条判据是「套餐余量 <1 **且** 余额 <1 元」，理由写得明明白白——
「一个套餐还剩 800 万 token、只是余额不足 1 元的号，现在还能干活，把它停掉等于白扔那 800 万」。
**同一个道理本该同样适用于账号级连坐**，但 §20.6 写成了「余额一项见底就连坐全部」。
ADR-0041 当时的语境是「账号欠费 ⇒ 它名下 key 打出去也是 402」，而那条推理漏了
**套餐 key 花的是套餐额度、不是账号余额**——余额见底不影响套餐 key 出量。

## 决策 1：账号级连坐收窄为「余额见底 且 套餐不可用」

`isAccountDepleted` 增加套餐输入，判据改为：

```
账号级连坐（账号自身 depleted_at + 级联名下全部 key）成立 ⇔
  ① 余额见底：unlimited = false 且 balanceCents !== null 且 balanceCents < 10 分
  ② 且 套餐不可用：plan 存在 且（已过期 或 余量 < 1）
```

逐条边界（与 ADR-0043 / ADR-0003 同向）：

- `balanceCents === null`（从没查到）⇒ **不连坐**。未知 ≠ 0。
- `unlimited = true` ⇒ 不连坐（它的余额恒 `NULL`，结构上够不着）。
- `plan === null`（台账没有套餐行）⇒ **不连坐**。判不出「套餐也见底」，当时宁可不锁；
  这个账号的**余额类 key 仍会被自己的判据 `isBalanceDepleted` 逐把锁上**（`depleted_reason='balance'`），
  没有任何一把真正该停的 key 因为这条收窄而留在池里。
- `plan.remainingTokens === null`（上游没说用了多少）⇒ 不连坐（未知 ≠ 0）。
- `plan.expiresAt !== null && expiresAt <= now` ⇒ 过期**把套餐余量按 0 计**（与 ADR-0043 同口径），
  此时只看余额一项是否见底。
- 余量阈值：`>= 1` 即可用（token 是整数，与 ADR-0043 `< 1` 同口径）。
- 余额阈值**不变**：`DEPLETED_BALANCE_THRESHOLD_CENTS = 10`（0.1 元）。
  **不是**废号池的 100 分：透支是「这把 key 付不起账」的灵敏判据，废号是「这个号没残值」的狠判据，
  两把尺子各有各的语境，不合并。

**key 级判据零改动**（`isBalanceDepleted` / `isTokenPlanDepleted`）：余额 key 余额见底照样各自锁，
套餐 key 余量 0 照样各自锁——变的是**「连坐」这一层**，不是每一把 key 自己的账。

## 决策 2：新增批量解除透支（`POST /api/supplier-accounts/undeplete`）

粘性设计（ADR-0041 §20.3）是刻意的：不自动回池，必须人工确认「我确实要放回去」。
但历史误锁（按旧判据锁上的）不会因为判据修正而自动消失——**必须给一次批量出口**，否则业主
仍得一个个点。所以：

- 端点 `POST /api/supplier-accounts/undeplete`，body `{upstreamId?, ids?}` → `202 {taskId}`
  （与 `refresh` / `keys` / `keys/sync` / `rotate-key` 同款批量形态，逐行结果复用 §15.3 `SupplierBatchResult`）。
- 任务类型 `supplier_undeplete`；`SupplierBatchResult.items[].action` 枚举新增 **`undeplete`**。
- 逐行语义 = 既有单账号 `POST /:id/undeplete` 逐字复用（`clearAccountDepletedCascade`）：
  清账号锁 + 清名下 `depletedReason='account'` 的 key 锁（`enabled=1`），**不动** `'balance'` 的锁
  （一把自己余额不足的 key，不因解账号的锁而回池）。
- 不需要 `revision`（同单账号版：这不是改字段，是解除自动置位的标记）。
- 审计：`supplier.undeplete`，`detail` 只放计数（`accounts=N keys=M`）。
- 空 `ids` = 该上游全部账号（与 `refresh` 同口径）；单账号 404 落逐行 `NOT_FOUND`（不整批失败，
  与 v1.18.2 `oneOrItem` 兜底同一条纪律）。

## 影响面

| 面 | 变更 |
|---|---|
| `/v1/*` | **零字节变更**：`isUsable` 的 `depleted` 过滤、排序、滑池全部不动；变的只是**哪些 key 会被打上锁** |
| `ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` | **零新增**（新端点只用既有 `NOT_FOUND` / `INVALID_PARAM`；`undeplete` 是逐行 `action` 值，不进口径码表） |
| DDL | **零**：判据用的是既有列（`supplier_accounts.balance_cents` + `supplier_account_subscriptions.basic_token_*` / `end_at`） |
| `src/gateway/` | **零改动** |
| 前端 | 账号池批量操作加「解除透支」一项（画师 `dev/web-m2`） |
| 历史数据 | 判据修正**不会**自动解锁已锁的账号（粘性）——业主用新批量端点清一次即可 |

## 判据（实现阶段执行）

`depletion.spec.ts`：

1. 余额 0 + 套餐余量 800 万 ⇒ **不连坐**（业主现场那个账号，本文的核心用例）；
2. 余额 0 + 套餐余量 0 ⇒ 连坐；
3. 余额 0 + 套餐已过期（余量仍 800 万）⇒ 连坐（过期按 0 计）；
4. 余额 0 + 无套餐台账（`plan === null`）⇒ 不连坐；
5. 余额未知（`null`）⇒ 不连坐；`unlimited=true` ⇒ 不连坐；
6. 余额 500 分 + 套餐耗尽 ⇒ 不连坐（余额还够，套餐耗尽只管套餐 key）；
7. 套餐余量未知（`null`）⇒ 不连坐。

`supplier-accounts-write.spec.ts`：

8. 批量 `undeplete`：一好一坏（坏 = 不存在 id）⇒ `ok + failed = total`、任务 `succeeded`、坏行 `NOT_FOUND`；
9. 批量 `undeplete` 只清 `'account'` 锁，`'balance'` 锁保留、`enabled` 不动；
10. 判据收窄后的刷新腿：余额 0 + 套餐有量的账号刷新后**账号不锁、套餐 key 不锁**（端到端一条）。

**变异验证**：① 判据改回「只看余额」⇒ 用例 1/4/7 红；② 把「且」改「或」⇒ 用例 6 红；
③ 批量端点漏 `clearAccountDepletedCascade` 的 `'account'` 过滤 ⇒ 用例 9 红。

## 已知边界（写清不留待发现）

1. **账号级标记本身也收窄了**：以前「余额 0 + 套餐有量」的账号会在列表里显示"透支"，
   现在不会——那是**修正**，不是回归：它确实还有 29.90 能干活。
2. 判断依赖套餐台账质量：`supplier_account_subscriptions` 没有行 / `basic_token_*` 为 NULL 时
   一律不连坐。代价是「真该连坐但台账缺失」的账号会晚一轮才锁——比误锁整批 key 轻。
3. 与废号池**不重叠**：废号池阈值 1 元、且进池会 `enabled=0`；本条阈值 0.1 元、只打 `depleted_at`、
   不动 `enabled`。一个账号可能「不进废池但余额 key 被锁」（0.5 元余额的情形），这是两把尺子的正常结果。
4. 批量解除是**人工动作**，不会在下一轮刷新被"再锁回来"吗？会——如果新判据仍成立（余额见底 +
   套餐不可用），下一轮刷新会重新锁。那时该看的是 `depletedReason` 与套餐余量，不是怀疑按钮。
