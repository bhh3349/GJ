# ADR-0031：站点换算比从上游读、不写死 —— `quota_per_unit` 缓存与 `createToken` 的取值纪律

- 状态：**已接受（2026-10-16，PM 批准「按你的建议动手」）**
- 关联：**契约 §15.1 金额口径（v1.8.2 实测订正那条）**；§15.5「单账号请求数」表；ADR-0018（凭据与建 key 通路）；
  ADR-0022 §4（套餐 key 轮换，本 ADR 顺手修掉它 rotate 腿的第二处写死）
- 车道：驱动器（`src/supplier/tierflow.ts`）+ 管家（`src/db/schema.ts` 两列纯加列迁移、
  `src/db/repo/supplier-accounts.ts` 读写两格、`src/api/services/supplier-accounts.ts` 四处接线）
- 触发：审计项 D —— `createToken` 把换算基准写死成 `DEFAULT_QUOTA_PER_UNIT`（500000），
  而契约 §15.1 明写「换算基准 `quota_per_unit` 每次查询时从上游读、不写死 —— 供应商改了换算比，我们的数不会跟着错」。

## 背景：一条被遵守了 99 处的纪律，在最后一处失效

`quota_per_unit` 的「不写死」纪律**不是新规矩**。v1.8.2（2026-10-12）把它钉进契约正文，
起因就是实测抓到 `/api/status → config.quota_per_unit` 是手册错抄、真值在 `/api/user/self → data.quota_per_unit`。
那条订正之后，**读侧**全部合规：`readQuotaPerUnit` 每次都从 `/api/user/self` 的信封里现读，
`quotaToCents` / `centsToQuota` / `mapSubscription` 也一律收一个 `quotaPerUnit` 形参、没有内部默认值可言。

**写侧只剩一处例外，而那一处恰好是"花钱"的那一处**：

```ts
// src/supplier/tierflow.ts（修前）
body['remain_quota'] = centsToQuota(input.quotaCents ?? 0, DEFAULT_QUOTA_PER_UNIT);
```

`createToken` 建固定额度的 key 时，把「分」换算回上游的 `quota`。站点把比值从 500000 改成
250000（= 站点 1 元只发 250000 quota），我们要建 1000 分（10 元）的 key：

| 换算基准 | 发出去的 `remain_quota` | 站点那边等于 | 后果 |
|---|---|---|---|
| 站点真实比值 250000 | 2 500 000 | 10 元 | 对 |
| 写死的 `DEFAULT_QUOTA_PER_UNIT` 500000 | 5 000 000 | **20 元** | **凭空多一倍额度** |

注意这个错的方向：**不是"建不出来"，也不是"报错"，而是"多给"**。上游按我们发出去的数字记账，
key 拿在手里就是比我们想给的多一倍。对个人自用这是亏，对任何多租户形态这是越权。
而且它**不报错、不告警**：HTTP 200、`success: true`、明文 key 正常返回、`keyCount` 正常 +1 ——
管理面上每一个可见信号都说"成了"。

**为什么它会活到现在**：`DEFAULT_QUOTA_PER_UNIT` 这个名字自带合理性 ——
它是一个**文档默认值**，而"文档默认值"在没有别的东西可读时的确是最后一条正确的退路。
问题只在于：`createToken` 的调用方**拿得到**真值（那三条腿已经在打 `/api/user/self`），
却没有任何一条路把它递进来。于是"拿得到"退化成了"拿不到"，"该读上游"退化成了"用常量"。

## 决策

### 1. 换算比由调用方给进来，驱动器不再自己决定

`createToken` 的入参新增**可选** `quotaPerUnit`：

```ts
createToken(credential, input: {
  name: string;
  unlimited: boolean;
  quotaCents: number | null;
  models?: readonly string[] | null;
  quotaPerUnit?: number | undefined;   // 站点自己的换算比；省略 = 落回文档默认值
}): Promise<TierFlowResult<…>>
```

实现里 `quotaPerUnit: input.quotaPerUnit ?? DEFAULT_QUOTA_PER_UNIT`。

**为什么不是让驱动器自己去打一发 `/api/user/self`**：见决策 3，那是被 §15.5 明文禁止的。
**为什么是可选的而不是必填**：`unlimited:true` 时上游根本不看这个数（`pendingCreateTokenBody`
只在 `!unlimited` 分支发 `remain_quota`），必填会逼着调用方为一个不会被读的字段去找值。
可选 + 缺省落回文档默认值，语义是**诚实的缺省**：缺的就是"我们不知道这个站点的比值"。

### 2. 比值由三条已经在打 `/api/user/self` 的腿顺手记在账号上

`supplier_accounts` 加两列（**纯加列，`SCHEMA_VERSION` 不递增**）：

| 列 | 类型 | 语义 |
|---|---|---|
| `quota_per_unit` | `INTEGER` NULL | 该账号站点自己的换算比。**`NULL` = 从没读到过**，不是 500000 |
| `quota_read_at` | `TEXT` NULL | 比值是什么时候读到的。**`NULL` = 从没读到过** |

写入口共四处，全部**零新增上游请求**：

| 腿 | 位置 | 说明 |
|---|---|---|
| 登录后的会话探活 | `loginAccount` | `probe.ok` 时记。新建账号第一手数据 |
| 余额刷新 | `refreshAccount` | 折进**已有的那一次 UPDATE**（不是第二次 UPDATE，避免 `revision` 被无谓 bump 两次） |
| 自测 | `testAccount` | 只记比值与时刻，**不碰 `status`** —— 自测是诊断动作，不该因为它把 `session_expired` 改成 `active` |
| `keys/sync` 对账 | `syncForAccount` | 读到就记 |

**只在真读到时写**，同 `balance_updated_at` 的纪律（§14.2）：查失败**一个字都不写**。
反面写法是把 `quota_read_at` 一并清空 —— 那会把上一次**真值**抹成"没读到"，
而两者在取值上同形（都用默认值）、在语义上不同（一个可能过期、一个从来没有过）。

**为什么两列而不是一列**：`quota_per_unit` 单独存在时无法回答"这个比值还能不能信"。
有了 `quota_read_at`，"该不该信它"是一条可判定的判据（虽然本 ADR 的建 key 腿**不**用它判定 —— 见决策 3）。

### 3. 建 key 时不为拿比值多发一次请求（§15.5 的预算是死的）

§15.5 表把「建 key = 2 次请求（创建 + 回查 `token_no`）」写成明文。
**加一发 `/api/user/self` 就是 3 次**，那不是"多一次礼貌问题"，是**破坏一条已发布的契约行**。

所以建 key 腿的取值是：

```ts
const quotaPerUnit = cred.quotaPerUnit ?? undefined;
```

**从库里读**。拿不到才落回文档默认值 —— 那条路只有"从没 refresh / sync / 自测过的新账号"会走到。

这里必须把代价说清楚，因为它不显然：**库里的比值可能是过期的**（站点上周改了比值，我们三天前读的）。
所以本 ADR 的选择是「一个可能过期的真值」对「一个永远错的常量」——
前者在站点不改比值时**永远正确**，站点改了之后错到下次刷新为止；后者在站点不改比值时**也**对
（因为文档默认值此刻就是事实），站点一改就**立刻错**。两者的分界是"站点改没改比值"，
而在那之前，前者没有任何额外成本。

**判据用例**：`src/api/routes/supplier-accounts-write.spec.ts` 有一条
「建 key **不为拿比值多发一次请求**」—— 它断言的不是"请求数等于 2"，而是
**`count('/api/user/self')` 在建 key 前后不变**。那才是这条决策的实质。

### 4. 顺手修掉 rotate 腿的第二处写死

`mapSubscriptions(subRows.result.data, DEFAULT_QUOTA_PER_UNIT)` ——
§15.13 的套餐 key 轮换/重置腿。它同样在读 `/api/user/self`，
改成 `cred.quotaPerUnit ?? DEFAULT_QUOTA_PER_UNIT`。

**为什么这条只读缓存、不刷新缓存**：rotate 腿按 §15.13 是**单请求**动作（重置那把 key），
它的职责是把 `basic_token_total` / `used` 写回 `token_plan_remaining`，
不是顺手刷新账号级缓存。比值在这里只是**换算套餐金额**的中间量，读了就该用、用完不必留。
（要留也该由下一轮 `refresh` 留，那是它的职权。）

### 5. 套餐余量回填：`basic_token_used` 缺失 ⇒ 整行跳过（文档漂移订正）

同批订正 `backfillSubscriptionTokenPlan` 的一处**文档漂移**：ADR-0030 决策 2 的三条纪律里
只写了「`basic_token_total` 取不到 ⇒ 整行跳过」，实现却对 `basic_token_used` 用了 `?? 0`。

`?? 0` 的语义是替上游下一个它没下过的结论 ——「这个套餐一点没用过」。
而这一减会产出一个**具体的数**（= 全额），它接着进网关的选路键 2、进 `balance_updated_at`、
进前端那一格。一个"我们并不知道"的数从此以"我们查过了"的面目存在。

**修正为：两格任一未知 ⇒ 整行跳过，`token_plan_remaining` 保持 `NULL`。**

**代价不是这把 key 被踢出选路**（这是本决策唯一需要论证的地方）：`KeyPool.remainingQuotaOf`
对 `NULL` 回 `UNKNOWN_PLAN_QUOTA`（= 1，ADR-0030 决策 1），`1 !== 0` ⇒ `isUsable` 判定仍为可用，
且 `1 > 0` ⇒ 仍排在所有余额 key **之前**。用户要的「先烧套餐」一点没变，
变的只是这把 key 不参与**精确**排序（它落在"未知"那一档）。

**宁可排序粗一格，也不要编一个余量** —— 前者让顺序偶尔不最优，后者让一个假数以真数据的身份
流进网关、进统计、进前端。

## 影响面

| 面 | 变更 |
|---|---|
| `/api/*` 响应 | **零变更**。`quota_per_unit` / `quota_read_at` 是 `supplier_accounts` 的内部列，**不进 `SupplierAccount` DTO**（§15.1 表不加行 —— 前端不需要它，而"加一个没人读的字段"正是契约要防的） |
| `/v1/*` | **零变更**。`src/gateway/` **零改动**（本 ADR 不碰选路，只碰"建 key 时发多少 quota 出去"） |
| DDL | **两列纯加列**（`quota_per_unit` INTEGER / `quota_read_at` TEXT），均可空、无默认。`SCHEMA_VERSION` 仍为 2、**零迁移脚本** |
| `ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` | **零新增**。本 ADR 没有任何新的失败形态 —— 它只是让一条既有路径取对值 |
| 上游请求数 | **零增加**。§15.5「建 key = 2 次」逐字不变，并有判据用例钉住 |
| 审计动作 | **零新增**。记比值是 `updateSupplierAccount` 的既有写入路径，复用 `supplier.account.update` 之外的内部写（不产生审计行 —— 它是缓存维护，不是管理动作） |

## 判据

| 用例 | 钉住什么 |
|---|---|
| `src/supplier/tierflow.spec.ts`：固定额度建 key 用站点比值 | 比值 250000 + 1000 分 ⇒ `remain_quota` = 2 500 000（写死那一版发 5 000 000） |
| 同上：比值缺省落回文档默认 | `quotaPerUnit` 省略 ⇒ `remain_quota` = 5 000 000（**钉住缺省路径的形状**，不是"允许写死"） |
| 同上：无限额度时比值不参与 | `unlimited:true` + 一个错得离谱的比值 ⇒ body 里**没有** `remain_quota` 可错 |
| `src/api/routes/supplier-accounts-write.spec.ts`：refresh 顺手记比值 | refresh 后 `quota_per_unit` = 站点真值、`quota_read_at` 非空，随后建 key 用它换算 |
| 同上：从没 refresh 过的账号 | `quota_per_unit IS NULL` ⇒ 落回文档默认（**老库 / 新账号的形状，不猜**） |
| 同上：建 key 不多发请求 | `count('/api/user/self')` 在建 key 前后**不变** |
| `src/db/repo/supplier-accounts.spec.ts`：`basic_token_used` 缺失 | 整行跳过、`token_plan_remaining` 保持 `NULL`、**零广播**（一次空转不该叫醒网关清零乐观扣减） |

## 备选与否决

| 备选 | 否决理由 |
|---|---|
| 驱动器自己打一发 `/api/user/self` 取比值 | 违反 §15.5「建 key = 2 次」。**那条表的全部意义就是"少打一次是一次"**，为一个可以顺手拿到的数破例，等于宣告该表可协商 |
| 建 key 前强制要求先 refresh（拿不到就 400） | 把"账号新鲜度"这个**独立关注点**塞进建 key 的必经路径。新账号第一件事本来就是 import（import 已经打登录探活、比值就在那时记下），真的拿不到时落回文档默认值也是**诚实**的 |
| 把比值写进 `SupplierAccount` DTO 给前端 | 前端**不换算**（§15.1 出口命名铁律：任何货币字段以 `Cents` 结尾）。给它一个 `quotaPerUnit` 只会诱导它自己除 —— 那正是铁律要防的事 |
| 给 `quota_per_unit` 一列默认值 500000 | 那会让"没读过"伪装成"读过 500000"，而 `quota_read_at IS NULL` 这条判据（"该不该信这个比值"）就再也用不上了。**可空无默认**是让"从没读到过"保持可判定的唯一形状 |
| `basic_token_used` 按 0 算 | 见决策 5：那是替上游下一个它没下过的结论，且产出的具体数会以"查过了"的面目流进网关、统计、前端 |

## 遗留（不粉饰）

1. **库里的比值可能过期**（决策 3 已论证取舍）。彻底解法是建 key 时真读一次上游，代价是破 §15.5；
   或给 `quota_read_at` 加一个"超过 N 小时不信它"的判据 —— 那会让行为随**时间**变化，
   而"建 key 发出多少额度"变成时间相关，比"可能过期"更难推理。本 ADR 选后者也不选。
2. **`quota_read_at` 目前只写、不读**。它是为"该不该信这个比值"这条判据留的位置，
   本 ADR 没有任何地方用它判定。留而不用的理由：没有它，"过期"连**可判定性**都没有。
3. **rotate 腿读的是缓存**（决策 4）：单请求动作不可能既读账号级缓存又刷新它。
