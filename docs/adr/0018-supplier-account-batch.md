# 18. TierFlow 批量账号面：账号是凭据容器，批量新建 key 是唯一入池通路

- 状态：**提案 · 待 Bo 拍板**（未冻结、未实现；拍板后翻「生效」并落 §15 契约 v1.4.0）
- 日期：2026-10-07（同日 rc2：并入画师的 6 个契约问题 → 新增决策 7 / 8，修正掩码匹配与加列迁移口径）
- 决策者：管家 · 管理后端（提案）、Bo（业务口径拍板）、画师（字段依赖）、路由者（池写入面确认）
- 关联：ADR-0003（余额三口径 / 未知≠0）/ ADR-0006（明文纪律）/ ADR-0012（三段解析）
  / ADR-0016（物理删除上游子树）/ ADR-0017（余额唯一事实源 = 上游接口 + 自动同步）
- 输入：《TierFlow 接口与工作台文档》（Bo 提供，2026-10-06 记录）

## 背景与问题

Bo 在 TierFlow（`https://tierflow.cn`）上有 **27 个账号 / 29 把 key（掩码）/ 27 个「轻享版」套餐**，
并已自建一个零依赖 Python 工作台（`workbench/`，`192.168.1.66:8790`）把「批量登录 → 刷余额 →
建 key → 同步已有 key/套餐」跑通了。诉求：**把这个批量能力并进本项目**，不要再维护两套资产视图。

但 TierFlow 与本项目现有模型有**三处结构性差异**，不解决就无法"并进来"：

1. **管理凭据是会话，不是 sk- key。** 查余额（`/api/user/self`）、列 key（`/api/token/search`）、
   建 key（`POST /api/token/`）、读套餐（`/api/subscription/self`）全部要求
   `Cookie: session=…` **且** `TF-User: <uid>`（缺一即 401）。现有 `upstream_keys.secret` 是
   **单值密钥**列，装不下「手机号 + 密码 + uid + 会话」这一组凭据。
   → 账号必须是**独立资源**，不能拿 key 凑。
2. **余额的归属是账号，不是 key。** 一个账号下有 N 把 key，共享同一份 `quota`；且工作台建出来的
   key 是 `unlimited_quota: true`，它自己的 `remain_quota` 没有货币意义。现有三级口径
   （key → 上游 → 全局，ADR-0003）在"一个账号多把 key"时会**把同一份钱数数几次**。
3. **key 明文只有一次机会。** 明文仅出现在创建响应里（`data.key`），列表 / 详情 / 套餐 key 一律掩码，
   站点不支持找回。→ 「同步已有 key」拿到的是 `NcBZ********WnWw` 这种**不可用**字符串；
   把 TierFlow 资产接进网关池的**唯一**通路是**批量新建 key 时当场落库**。

## 决策 0：个例不外溢 —— 账号面是并列资源，通用路径零条件分支

Bo 明确"这只是个例，不用应用到全部供应商"。落法不是"在通用代码里写 `if (tierflow)`"，
而是：

- `upstreams` 加一列 **`supplier TEXT`**（`NULL` = 通用上游；本版唯一取值 `"tierflow"`），
  显式声明"这个上游走账号面"，**不靠猜 baseUrl 的 host**（猜错会静默走错驱动器）。
- 账号面是**并列的顶层资源**（`/api/supplier-accounts`），不织进 `/api/keys`、`/api/upstreams`
  的既有分支。通用上游的端点、字段、口径**逐字不变**。
- 驱动器代码集中在 `src/api/services/supplier/tierflow.ts`（供应商专有），
  通用层只认"账号驱动"这一个窄接口 —— 以后要接第二家，是**加一个驱动器**，不是改通用层。

## 决策 1：账号 = `SupplierAccount` 资源；密码与会话与 key 同等密级

`supplier_accounts` 存 `identifier`(手机号/邮箱)、`password_cipher`、`uid`、`session_cipher`、
`session_expires_at`、`balance_cents`、`status`。

> 列名用 `balance_cents` 而不是 `quota_cents`：`quota` 是**供应商的单位**，我们库里一律是分，
> 沿用 `upstream_keys.balance_cents` 的命名，读代码的人不会以为这列还要再换算一次。

- 密码与会话用**同一把 `MASTER_KEY`**、同一个 `aes-256-gcm` 加密器（`src/db/crypto.ts`），
  `BLOB` 落盘 —— 与 `upstream_keys.secret` 同一条纪律，不新造第二套密钥管理。
- **出口只有手机号掩码**（`162****4225`，沿用 key 的 `****后4` 做法）。任何响应/日志/审计 detail/
  任务 result/错误信息里都不出现密码或会话值；错误只保留供应商码（如 `LOGIN_INVALID_CREDENTIALS`）。
- 会话 30 天过期 → 用存档密码自动重登（工作台已验证的路径），`status` 反映
  `session_expired` / `login_failed`，前端据此提示"需重登"。
- **出站主机固定**为该上游 `baseUrl` 的 host，驱动器不接受请求里传入的 URL —— 否则这个"能带会话
  发请求"的功能就是一个 SSRF 跳板。

## 决策 2：批量新建的 key **直接进网关 key 池**（本决策是"结合"的实质）

工作台每建一把 key 都能看到一次明文。我们把这一刻**接住**：

```
建 key（明文只此一次） → 当场 aes-256-gcm 写入 upstream_keys（category='balance'）
                        → 走既有 createKey 路径（revision / change_log / masked_key 派生列）
                        → 网关 ≤1s 轮询后即可用于 /v1/* 转发
```

- 于是 TierFlow 的 27 个账号从"外部工具里的一堆记录"变成**网关真实可用的 key 池**。
- **掩码 key 不冒充可用凭据**：同步回来的掩码单独计数 `maskedKeyCount`，与真正入池的
  `keyCount` **分列**，前端不得把两者合并成"key 数"。这是 ADR-0003 "未知≠0" 的同一条纪律：
  不可用的凭据不能在 UI 上长得像可用的。
- 已有 29 把 key 的明文**永久拿不回来**（掩码不可逆），因此"同步已有 key"的定位是
  **对账**，不是补齐池子。要补池子只有一条路：批量新建。
- **明文不经浏览器**：上游在本服务端发起，明文在服务端进程内从创建响应直接进加密器，
  前端只拿到 `keyId` + `maskedKey`。因此本节**没有** §3 `POST /api/keys` 那个"只显示一次、
  强制复制"的浮层 —— 那个浮层存在的前提是"人手里有明文"，这里不成立。
- **对账只能按后 4 位**：`maskKey()` 落盘的 `masked_key` 是 `****` + 后 4 位，没有前 4 位；
  上游掩码是「前 4 + 后 4」且部分端点带 `sk-` 前缀。两头取交集只剩**后 4 位**，
  比对前须剥 `sk-`。后 4 撞号则**不更新**（宁可漏一次，不能把余额写到另一把 key 上）。
- **掩码清单要落表**（`supplier_account_keys`）：§15.1 的 `maskedKeyCount` 是**已持久化的对账结果**，
  不是"上一次 sync 时数了一下"。若不落表，这个数在刷新后就没了，且"这账号到底有哪几把 key"
  这个问题每次都要重打一遍上游（27 号 × 每秒请求 = 白烧配额）。
  该表只存 `token_no` + **掩码** + `is_subscription_key` + 过期时间，**没有 secret 列** ——
  结构上就放不下凭据（同 ADR-0013 的构造性脱敏）。池内 key 的归属走 `upstream_keys.account_id`。

## 决策 3：余额新增**账号级**第四口径（防双算）

- 新增 `supplier_accounts.balance_cents`（分，`NULL` = 未知 ≠ 0）。
- 上游合计口径修订（**形状不变、组成可变**）：
  `totalBalance = Σ(该上游账号的 quota) + Σ(不属于任何账号的 balance 类 key 的 balance)`
  即**归属账号的 key 不进上游合计** —— 它们的钱已经在账号那一格里数过了。不这样写，
  "一个账号建 3 把 key"会把余额数 3 遍。
- 非破坏新增拆分字段 `accountCount` / `accountsBalance` / `accountsBalanceUnknownCount` /
  `keysBalance`：前端能一眼说清"这个合计是怎么拼出来的"，而不是再看到一个大数字。
- 全局合计（§6）同规则累加，并给出 `accountsBalanceUnknownCount`。

## 决策 4：复用既有任务系统与 §14 调度器，不新造第二套节拍

- 四个批量端点（导入 / 刷余额 / 建 key / 同步）全部走**既有** `startTask` + `GET /api/tasks/:id`
  轮询模型（工作台就是 `job_id` + 0.9s 轮询，交互形状天然对得上）。
- 账号余额刷新接进 §2 的**解析顺序**多一档（`① 用户模板 → ② 内置 preset → ③ 账号型驱动 → ④ skipped`），
  tierflow.cn 不命中任何 preset、用户也没配模板，于是自然走 ③。
- 好处是 §14 的**自动同步 / 退避 / 单飞 / 快照 / 漂移全部零改动复用**：账号合计就是该上游这轮的
  "余额状态"，`balance_snapshots` 表**零新增列**。
- 定时同步若开启：27 个账号 × (0.6s 间隔 + 约 1.5s/次) ≈ **1 分钟一轮**，远小于 15 分钟基准间隔，
  与单飞语义相容。

## 决策 5：限速礼貌照抄工作台已验证的参数

逐个执行 + **每账号 0.6s 间隔**；上游请求并发上限**复用 `REFRESH_CONCURRENCY`**（不新拍一个数，
否则手动刷新与自动同步早晚漂成两个并发度）；登录每号**只试一次**（避免触发账号锁定）；
keyword 搜索不可靠 → 留空拉全量再本地过滤；删除 key 用**无尾斜杠**路径（带斜杠会 307）。
这些坑都写进驱动器的测试，不留在文档里靠人记。

## 决策 6：Python 工作台退役（避免双事实源）

接入后工作台**不再写**任何数据（可保留为只读应急工具，或直接下线）。账号清单用我们的批量导入
重建即可（粘贴 `手机号,密码` 或选 CSV，容忍表头 / `+86` / 空格 / 分号），
**不需要迁移 `workbench.db`** —— 那里面真正值钱的只有账号清单与密码，其余（余额、掩码 key、套餐）
都是可重新拉取的派生数据。

## 决策 7：套餐挂账号，**不**建成 key（表格是两级，不是三级）

套餐**不**落成 `upstream_keys` 行，也**不**新增 `category='token-plan'`（或第三种 category）：

- **余额粒度不对**：套餐余额是 `(amount_total - amount_used)`，账号级的量；`token-plan` key 行的
  单个 `token_plan_remaining` 装不下 `amount_total/amount_used/basic_token_*/paid_cents/有效期`，
  硬塞就是往一个字段里编一个不存在的数。
- **套餐 key 只拿得到掩码**（`{"key":"sk-k58R**********vFnt","masked":true}`）——
  建成行等于造一把不可用凭据，与决策 2 同一条纪律。
- **它是 N 个**：上游返回 `all_subscriptions: []`，一个账号可叠多个套餐。
- 因此 `upstream_keys` **不引入** `subscription_id` 外键。套餐与池内 key 之间只有
  "后 4 位掩码可能对上"这一条**弱对账**关系，把弱关系写成强外键会让 UI 暗示
  "这把 key 属于这个套餐"，而事实是"这个账号买过这些套餐"。

## 决策 8：无限额度 key 要有一列自己的身份（`upstream_keys.unlimited`）

上游给无限额度 key 的是 `{unlimited_quota: true, remain_quota: -331119}` —— `remain_quota` 是
**无意义的负数**。而 `upstream_keys.balance_cents` 的 `NULL` 语义已被钉死为"**未知**"
（ADR-0003）。两者共用一个 `NULL` 就必然二选一错：要么把 -331119 当余额渲染，
要么把无限额度算进"余额未知"—— 于是仪表盘上永久挂一条"有 N 把 key 余额未知"的告警，
而那 N 把**根本没有余额这个概念**。

- 加 `upstream_keys.unlimited INTEGER NOT NULL DEFAULT 0`（老库全 0，零影响）。
- 计数口径随之修订（`src/db/balance.ts`，**唯一**要动的既有聚合点）：
  只给 `balanceUnknownKeyCount` 加 `AND unlimited = 0`，另出平行的 `unlimitedKeyCount`。
  **刻意不动 `balanceKeyCount` 与 `totalBalance`** —— 把它们改成"排除 unlimited"是更"干净"的
  分区，但会动到两个既有字段的语义（前端的不变量、§14 快照的字段都会跟着变），
  而收益只是让不变量好看一点。
- 不变量：**`balanceKeyCount + tokenPlanKeyCount = keyCount`（既有，保持不动）**；
  `unlimitedKeyCount ≤ balanceKeyCount`、`balanceUnknownKeyCount ≤ balanceKeyCount`；
  "无限额度"与"未知"在 `balanceKeyCount` 内**互不重叠**。
- 前端渲染无限额度 key 时显示**「无限额度」徽标**，不是 `—` 也不是"未知"。

## 备选方案与为什么否掉

| 备选 | 否掉理由 |
|---|---|
| 把账号塞进 `upstream_keys`（`secret` 存密码） | 语义污染：网关会把密码当 `sk-` key 拿去发请求；`masked_key` / 余额列全部失去意义 |
| 每个账号建一个 upstream | 上游列表从 1 条变 27 条；模型档案重复 27 份；网关选路语义（模型 → 上游 → key）被账号维度污染 |
| 只做只读对账，不入池 | 那就不是"结合"，只是把工作台换个皮肤；TierFlow 的钱仍然进不了网关 |
| 通用化"任意供应商账号面"（多供应商抽象） | Bo 明说个例；抽象在没有第二个实例前只会做出错误的接口形状（代价高、收益零） |
| 余额按 key 存（每账号所有 key 各存一份 quota） | 直接把 ADR-0003 的合计口径做成双算，且"每把 key 的余额"是编出来的数（无事实源） |
| 套餐建成 `category='token-plan'` 的 key | 余额粒度对不上（套餐是账号级）；套餐 key 只有掩码，建出来即不可用凭据；且套餐是 N 个不是 1 个（决策 7） |
| 无限额度沿用 `balance_cents = NULL` | 与"未知"同形，必然把 27 把无限 key 报成"余额未知"（决策 8） |

## 影响

| 面 | 改动 |
|---|---|
| `src/db/schema.ts` | 加表 `supplier_accounts` / `supplier_account_subscriptions` / `supplier_account_keys`；加列 `upstreams.supplier`、`upstream_keys.unlimited`。**加列必须走 `migrate()` 里 `hasColumn()` 守卫的 `ALTER TABLE`** —— `CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作，只改 DDL 文本老库升不上来。`SCHEMA_VERSION` 仍为 2（照 `request_id` 那一批：加列不算搬迁） |
| `src/db/balance.ts` | 上游 / 全局合计 SQL 增账号一格 + `unlimitedKeyCount`；`balanceUnknownKeyCount` 加 `unlimited = 0`（**唯一**要动的既有聚合点） |
| `src/db/repo/**` | 新增 `supplier-accounts.ts`；`createKey` 复用不新增写路径（多一个可选入参 `unlimited`） |
| `src/api/services/supplier/tierflow.ts` | 新增驱动器（登录 / 余额 / 建 key / 列表 / 套餐），唯一接触会话明文的地方 |
| `src/api/routes/supplier-accounts.ts` | 新增 §15 端点 |
| 契约 | v1.4.0：新增 §15；§2 Upstream 非破坏新增 6 字段 + `POST/PATCH /api/upstreams` 可选 `supplier`；§3 `KeyDto` 新增 `unlimited`；§6 合计口径补账号级 |
| `web/` | 画师新增「供应商账号」页（列表 / 导入 / 批量操作进度 / 套餐明细） |
| `src/gateway/` | **零改动**：写入的还是同一张 `upstream_keys`，走的还是同一条 `change_log` + 1s 轮询；余额不在热路径上 |
| 安全扫描 | `check:secrets` 现有规则不变；新增"响应序列化里不得出现密码/会话真值"的断言（注入真值后断言不出现在响应 JSON 中） |

## 代价与已知风险（不粉饰）

1. **密码必须入库**（加密），否则"会话过期自动重登"和"批量重登"都做不了。这是本功能的前提，
   不是可以省掉的一步。
2. **供应商改版会静默弄坏驱动器**：接口是逆向 + 实测得来的，无版本承诺。缓解：单账号
   "测试连接/自测"端点暴露真实响应，坏了一测就知道，而不是等余额变陈旧。
3. **27 个账号的批量刷新是分钟级**：不是慢，是礼貌（0.6s 间隔）换来的。故走异步任务 + 进度，
   不阻塞 HTTP。
4. **掩码 key 的存档价值极低**：同步它们只为了"这账号到底有哪几把 key"的对账，不能拿来用。

## 待拍板项（Bo）

1. **批量新建的 key 是否直接进网关 key 池**（决策 2）→ 建议：**是**。否则本功能与网关无关。
2. **是否引入账号级余额口径**（决策 3）→ 建议：**是**。否则 27 个账号的 ¥ 要么看不见，
   要么按 key 双算；代价是 §2/§6 的合计组成变化（形状非破坏）。
3. **Python 工作台退役还是保留只读**（决策 6）→ 建议：**退役**。
4. **默认建 key 额度**：无限额度（与工作台一致，余额看账号）还是固定金额 → 建议：**默认无限**，
   固定额度作为可选参数保留。

## 验收口径（拍板后才展开为 DoD）

- 批量导入 27 号 → `ok ≥ 26`，逐行结果可查，3 个失败号给出供应商错误码。
- 批量建 key → 每把都出现在 `GET /api/keys`，网关可实际用其转发（`/v1/chat/completions` 通）。
- **key 明文与账号密码/会话不落盘、不回显、不进日志**（含 `check:secrets` 与响应体断言）。
- 余额合计：`totalBalance` = Σ账号 quota + Σ无账号归属 key 余额，**不存在同一份钱数两次**。
- 批量操作有真实进度（不造假进度条），失败逐行可见，单账号失败不影响其余账号。
- **出口无 quota 原值**：断言 §15 所有响应体里不出现 `quota` 字样的**金额**字段
  （`parsed.quotaPerUnit` 是比例，白名单）；`amountTotalCents` 由 `amount_total / quota_per_unit * 100`
  **四舍五入**得来（`14950000 → 2990`、`2168881 → 434`、`3212302 → 642`）。
- **计数不变量**（断言）：未软删 key 满足
  `balanceKeyCount + tokenPlanKeyCount = keyCount`（既有，本次不得改变），
  且 `unlimitedKeyCount ≤ balanceKeyCount`。
- **无限额度不报未知**：27 把 `unlimited_quota` key 落库后，`accountsBalanceUnknownCount` /
  `balanceUnknownKeyCount` **不因它们增加**，UI 显示「无限额度」徽标。
- **加列可重复跑**：对一份 v2 老库连开两次库，`migrate()` 不抛 `duplicate column name`
  （照 `request_id` 那批的既有断言）。
