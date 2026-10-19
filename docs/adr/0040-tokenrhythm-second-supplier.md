# ADR-0040：第二家账号面供应商 TokenRhythm —— 驱动器复用 + 能力位分发

- 状态：**已接受（2026-10-18，Bo 指令「现在我给出第二个特殊供应商……让你实现它的批量化，你可以阅读 TierFlow 的批量实现方法。两个供应商的接口不一样。tokenrhythm 的接口需要你自己实测，然后再决定怎么加」）**
- 关联：契约 **§15**（头部改写 + 新增 **§15.14 能力表**）、**§2**（`supplier` 枚举、`PATCH` 取值、余额解析顺序③改口）、
  **§15.6**（`supplier` 怎么设 + 前端判据句改口）、**§15.12 锚 1**（等值比较 → 集合成员判定）、
  **§19.10**（影响面）、**ADR-0018 决策 0**（"以后要接第二家，是加一个驱动器"的兑现）
- 车道：`src/supplier/tokenrhythm.ts`（新驱动器）+ `src/api/`（`clientFor` 分发、§15.14 入口闸、
  `upstreams` 路由枚举）+ `web/src/`（能力位镜像 `SUPPLIER_CAPABILITIES` + 六处消费点）
- 交付：**v1.16.0**（后端 27 + 9 条新用例全绿；`web/` `tsc` + `vite build` 绿；
  LAN 实例手工验收见文末「手工验收记录」）；**v1.16.1 订正**（登录形状：TR 只有 cookie/会话，
  `import` / `:id/login` 入口 422，新增离线会话导入 + 6 条离线用例）；
  **v1.16.2**（同一脚本支持 `SUPPLIER_SESSION_BATCH_FILE` 批量文件 + 7 条离线用例）；
  **v1.16.3**（只有 cookie 时的身份解析：逐行 `GET /api/me` + uid 判重 + 18 条离线用例）；
  **v1.16.4**（管理面粘贴 Cookie 入口，业主显式风险接受 + 5 条路由用例）

## 背景

ADR-0018 决策 0 写死的前提：账号面是 Bo 指定的**个例**（TierFlow），通用层只认
"账号驱动"这一个窄接口 —— "以后要接第二家，是**加一个驱动器**，不是改通用层"。
§15 头部同样写明「**不**抽象成通用多供应商框架」。

2026-10-18 Bo 给出第二家的接口文档（`tokenrhythm.studio`，基元律动），指令是把它的批量化做出来。
本 ADR 记录三件事：**接口实测推翻文档的四处**、**为什么结构上复用而不是新开一套**、
**能力差异怎么表达才不会在第三家接入时静默出错**。

## 实测事实（12 轮探针，2026-10-18/19；与文档不符处以实测为准）

| # | 事实 | 文档说法 | 实测 |
|---|---|---|---|
| 1 | **登录方式** | **整篇没有登录接口**（文档从已持有 `tr_session` 开始） | `POST /api/auth/login` **存在，但从不认证密码**：`{account,password}` 的任何取值都回 401 `UNAUTHORIZED`（与过期会话同码同文案），**从未观测到一次成功登录**；真实登录是验证码 / `login-or-register` 流程。⇒ **只支持会话凭据**（**v1.16.1 订正**：v1.16.0 把"能发通端点"误读成了"密码登录可用"） |
| 2 | **CSRF 生效条件** | 「`Origin` + `Referer` + `Sec-Fetch-Site` 三件套」 | **硬性要求只有 `Sec-Fetch-Site: same-origin`**（单变量 A/B：只有它 200，没有它必 403 `CSRF_INVALID`；`Origin`/`Referer` 顶替不了） |
| 3 | **CSRF token 一次性** | 「每次请求后服务端轮换，旧 token 立即失效」 | 响应确**轮换**但**非一次性**：复用最新一枚连发两次写均 200 |
| 4 | **余额来源** | **文档没有余额接口**（只有按 key 的用量统计） | `GET /api/wallet/summary` → `data.availableBalanceCny`，8 位小数 **CNY 字符串**（`"23.66510789"`） |

另两条实测钉子（与文档一致或补白）：

- **403 与 401 是两条路**：伪造会话 + 合法 csrf 回 403；真过期回 401 `UNAUTHORIZED`。
  所以 **403 绝不能映射成 `session_expired`**（那会把一次 CSRF 失败误报成"会话失效"，
  把操作员引去重新导入一枚本来还有效的会话）。文档的「CSRF 失败表现」没有写这条边界。
- **没有"登录失败"这个状态可用**（v1.16.1 订正）：唯一的鉴权事实是会话是否有效（401 = 失效）。
  驱动器 `login()` 是**零请求的能力缺口**（直接 `rejected`），批量 `import` / `:id/login` 在入口 422；
  因此 TokenRhythm 的账号只会落 `session_expired`，不会落 `login_failed`。
- 掩码 `sk_tr_5o****6Us8C0` 的可见尾 4 与明文真值的尾 4 **一致**（`sk_tr_agdXBT…RF-BD8` ↔
  `sk_tr_ag****RF-BD8`）⇒ tierflow 的 `maskTail` / `maskFromUpstream` 原样可用。
- `data.id` 是 **UUID**（不是 TierFlow 的整数 token id）⇒ 池内 key 的 `token_plan`/上游 id 列落
  `null` 属预期，不是缺陷。

## 决策

### 1. 结构上实现同一个 `TierFlowClient` 接口 —— 六个批量端点原样复用

`src/supplier/tokenrhythm.ts` 实现 `tierflow.ts` 导出的同一个 `TierFlowClient` 协议。
`import / refresh / :id/login / :id/test / keys / keys/sync` 六个端点连同**被动重登、账号级节奏、
逐行累加**那一整套机制**一行不改** —— `clientFor`（`src/api/services/supplier-accounts.ts`）按
`upstreams.supplier` 列选驱动器，其余全部调用方无感。
〔v1.16.1：TR 的 `import` / `:id/login` 在**入口** 422（没有密码登录，§15.14.1），批量建 key 那条
路径不变；通用层的"被动重登"对 TR 只会拿到一个零请求的 `rejected`，不会误打上游。〕

这正是 ADR-0018 决策 0 预留的那条路：**接第二家 = 加一个驱动器**。通用层的唯一改动是
`SUPPLIER_KINDS` 从 `['tierflow']` 扩成 `['tierflow','tokenrhythm']`（一处）。

**三家差异全在驱动器内部的具名操作里**：

| 操作 | TierFlow | TokenRhythm |
|---|---|---|
| `login` | `POST /api/user/login` | **不存在**（v1.16.1）：零请求直接 `rejected`；入池只走 §15.9 离线会话导入 |
| `self`（余额腿） | `/api/user/self`（quota 整数） | `/api/me` + `/api/wallet/summary` 两腿（`availableBalanceCny` 字符串 ×100 → 分） |
| `subscriptions` | `/api/subscription/self`（真套餐） | **不发请求**直接回 `[]`（套餐腿天然 no-op，总请求数不涨） |
| `tokens` | `/api/token/search`（**必须显式 `p=1&size=100`**，v1.8.2 教训） | `GET /api/api-keys`（无分页，一页全量） |
| `createToken` | `POST /api/token`（2 次请求：种子 + 建） | `POST /api/api-keys {name}`（**1 次请求**；body 只有名字） |
| `rotateSubscriptionToken` | 真轮换（§15.13） | **不存在**：不发请求、直接 `rejected`（正常路径入口已 422，这里是兜底） |
| `quotaPerUnit` | 上游真值（ADR-0031） | 落常量 `100`（1 元 = 100 分，只为"分"口径自洽；建 key 不消费它） |

### 2. 能力差异表达为**能力位**，不表达为 `if (supplier === 'tokenrhythm')` 的散落判断

TokenRhythm **没有**的概念：套餐（subscriptions）、key 额度（quota/unlimited）、模型白名单
（model_limits）、quota_per_unit。这些差异如果按供应商散落写 `if`，第三家接入时
每一处都要重新审一遍"这一条对第三家成立吗"。落法：

- **服务端**：两张具名能力闸（`keys` 端点拒收 `unlimited:false` / 非空 `models`；
  `rotate-key` 端点对无套餐供应商整体 422），注释统一锚「§15.14 能力表」。
  **默认路径零闸**：`parseKeySpec` 的默认值（`unlimited:true`、无白名单）恰是 TokenRhythm
  唯一合法形状，原样放行 —— 只拦**显式指定**了不存在概念的请求。
- **前端**：`SUPPLIER_CAPABILITIES: Record<SupplierKind, {plans, keyQuota, passwordLogin}>` 一张表
  （`web/src/api/types.ts`），消费点（套餐台账页签、rotate 按钮×2、建 key 弹窗额度三项、
  资金池卡片数、套餐余额列、展开行套餐块、导入账号按钮）全部查表，**没有一处写死供应商名**。
  `passwordLogin: false`（v1.16.1 新增）让 TokenRhythm 的「导入账号」按钮禁用并提示走离线导入 ——
  镜像服务端的入口 422，不画一个点了必然失败的按钮。

### 3. 前端判据从等值比较改为**集合成员判定**（§15.12 锚 1 改口的理由）

原锚 1 写的是 `upstream.supplier === "tierflow"`。等值比较有一个阴险的失败模式：
**接入第二家时不报错，只是第二家静默没有入口**（按钮不出现、页签不出现）。
改口为 `supplier ∈ SUPPLIER_ACCOUNT_KINDS`（`hasSupplierAccountPanel()`）之后，
新供应商只要进了枚举就自动获得全部入口；能力差异由 `SUPPLIER_CAPABILITIES` 单独管。
前端镜像表与服务端闸门是**同一个事实的两份呈现**，锚点都指 §15.14。

### 4. 建币种归属：TokenRhythm 的钱也是 CNY 分

`availableBalanceCny` → `cnyToCents()`（只在驱动器这一处换算；解析不出有限数落 `null`，
不猜）。账号余额与池内 key 余额共用 §15.1 的 `balanceCents` 分口径，`currency: 'CNY'`。
**TokenRhythm 的 key 无额度概念** ⇒ `tokens()` 全部按 `unlimited:true, remainQuota:null` 上报，
与 §15.7「无限额度落 NULL」既有口径**完全同形** —— 网关侧与统计侧零新分支。

### 5. 请求节奏（§15.5 预算表增补三行）

| 动作 | TierFlow | TokenRhythm |
|---|---|---|
| `test`（自测） | 2 | 2（`/api/me` + `/api/wallet/summary`） |
| `refresh` | 2 | 2（同上两腿） |
| `keys/sync` | 3 | 3（self + subscriptions[no-op 0 请求] + tokens —— **总预算不破**） |
| `keys`（建 key/把） | 2 | 1 |
| `import` | 每号 1 次登录 | **0**（v1.16.1：入口 422，没有登录可打） |
| cookie-only 离线导入 | — | **每枚会话 1**（`GET /api/me` 解析 uid / 掩码，v1.16.3） |
| `rotate-key` | 1/账号 | **端点入口 422，0 上游请求** |

### 6. TokenRhythm 的入池 = 离线一次性会话导入（v1.16.1 订正；v1.16.2 支持批量）

HTTP `import` 对 TR **不适用**（没有密码登录）：`POST /api/supplier-accounts/import` 在**入口**
直接 422 `UNPROCESSABLE`，不解析 `text`、不发请求。入池唯一通路是 §15.9 的离线一次性导入：

- 模块 `src/supplier/session-import.ts`：`normalizeIdentifier` → `maskIdentifier` → 排除名单 →
  `(upstreamId, identifierHash)` 命中则覆写 `encrypted_session`、否则建行；**零上游请求**，
  绝不回显会话值，落 `status="unknown"`（"已落库"不等于"验过活"）。
- 脚本 `scripts/import-supplier-session.ts`：操作员本机执行，会话值只从运行时环境变量或本机文件
  读入，输出只打印掩码（§15.9 纪律 1/2）。
- **批量（v1.16.2）**：同一脚本设 `SUPPLIER_SESSION_BATCH_FILE=<本机文件>`（`-` = stdin）即逐行导入。
  模块 `src/supplier/session-import-batch.ts` 负责解析（`标识<TAB|,|空白>会话`、`#` 注释、
  可选表头、`tr_session=…; Path=/` 只取 value、同号重复保留第一行）与逐行循环；
  **单行失败不中断整批**，报告只有行号 / 掩码 / 原因。这不是新入口 —— 批量只放大行数，
  四条纪律逐条不变，`/api/*` 零新增。
- **只有 cookie、没有手机号/邮箱（v1.16.3）**：设 `SUPPLIER_SESSION_COOKIE_ONLY=1` +
  `SUPPLIER_SESSION_BATCH_FILE`，文件每行只放一枚会话。模块
  `src/supplier/session-resolve.ts` 用会话发**一次** `GET /api/me`，取 `data.id`（UUID）/
  `data.name` / `data.phoneMasked`（无则 `emailMasked`）；401 = `session_expired`，
  **403 不等于会话过期**（是上游拒绝，ADR 实测钉子）；上游回未掩码值则本地再掩，掩不出即
  拒绝该行。模块 `src/supplier/session-import-cookie.ts` 逐行循环，单行失败不中断。
  **判重键改用上游 uid**：`identifier_hash = sha256('tokenrhythm:uid:<id>')`；写库时按
  `uid → 掩码 → 摘要` 顺序命中既有行（覆盖"先按真值导入、uid 已回填或尚未回填"两种），
  命中只覆写会话与权威信息，**不改**既有行的展示掩码/摘要（改了会让它和真值通路失去对应）。
  展示列落上游返回的掩码。**排除名单非空时整体拒绝**：名单按真值匹配，cookie-only 只有
  掩码，无法验证；静默放行等于把硬约束变成建议。代价是每行 1 次 GET；`status` 仍落
  `unknown`，由一次 `refresh` 转 `active`。
- 掩码纪律不变：纯数字走手机号路、邮箱走邮箱路；**其他形态**（纯字母用户名）掩不了 ⇒
  **拒绝写入并报原因**，绝不退化存原文。
- 导入之后由一次 `refresh`（2 次请求）把 `unknown` 确认为 `active` 或 `session_expired`。

### 7. 已知边界（写在这里，不留待发现）

- **没有密码重登**（v1.16.1）⇒ TokenRhythm 账号过期后只能重新执行离线会话导入；
  `login_failed` 这个出口对 TR 不会出现，落的是 `session_expired`。
  **不再声称**"两个出口都在、只是区分度低一档" —— 那是基于一条不存在的登录通路写的。
- **key 上限是上游侧事实**（"账号有创建数量上限，超限时按钮置灰"）—— 我们不预知上限，
  建超了由上游报错、逐行结果如实回显，不本地造一个"剩余配额"数。
- **`keys/sync` 对账依赖掩码尾 4**：TokenRhythm 掩码尾 4 与真值一致（实测），与 TierFlow
  同一匹配判据；`data.id` 是 UUID，DTO `tokenNo` 落 `null` —— 台账按掩码匹配，不受影响。
- **停用的 key 仍在列表里**（删除的才消失）—— 台账口径与 TierFlow 一致：以"上游还认的"为准。

### 8. 管理面粘贴 Cookie 入口（v1.16.4，业主显式风险接受）

**背景**：v1.16.1–v1.16.3 把 TR 的入池钉在"操作员回终端跑脚本"上。Bo 在实操后提出
「如果不能导入，那我怎么批量添加cookie然后添加账号呢」，随后明确否掉文件上传方案：
「不是上传文件，只是粘贴cookie到输入框」，并给出风险判断：「感觉好麻烦，还是直接做到web吧，
我这个人自用项目不会泄露的」。**这是业主对"粘贴值经过一次管理面 HTTP"的明确接受**，
不是实现方绕过 §15.9 纪律 1。

**决定**：新增 `POST /api/supplier-accounts/import-sessions`（`{upstreamId,text}` →
`202 {taskId}`，任务类型 `supplier_import_sessions`）。`text` 每行一枚会话，服务端**调用
v1.16.3 已有的 `importSupplierSessionCookies`**（解析 / 身份解析 / uid 判重 / 加密落库零复制）。
逐行结果复用 §15.3 `SupplierBatchResult`，`action` 增加第 7 个值 `import`（只登记会话，
**没有发生登录**）。身份查询与驱动器同源换算：`upstreams.base_url` 的网关后缀 `/v1` 先剥掉，
再拼站点根的 `/api/me`（不剥会打成 `/v1/api/me`，404 被误读成身份不可用）。入口闸全部在任务创建前：

| 条件 | 结果 |
|---|---|
| 上游不是 TokenRhythm（含 TierFlow） | `422 UNPROCESSABLE`，零上游请求 |
| 排除名单非空 | `422 UNPROCESSABLE`（名单按真值匹配，掩码无法验证） |
| 文本为空 / 只有表头与注释 | `400 INVALID_PARAM`，不建任务 |

**风险边界（没有被放宽的部分）**：

- 值**不写日志、不进审计 `detail`、不回显**：响应、任务 result、错误 `message` 只有掩码或行号；
- 落库即 `aes-256-gcm` 密文（`MASTER_KEY`），`status="unknown"`，由一次 `refresh` 验活；
- 前端提交后立刻 `resetFields()`，不写 `localStorage` / URL / 前端日志；
- TierFlow **不开放**这条端点 —— 它有密码通路，没有理由扩大暴露面；
- 每行仍要打一次 `GET /api/me`（与离线 cookie-only 模式同一预算）。

**已知代价（业主已接受）**：粘贴值会经过浏览器进程、管理面 HTTP 请求与任何中间代理；
对自用项目接受这一点，换取"30 个号不必逐个回终端"。若将来部署到共享环境，这条端点应整体关闭。

## 影响面

| 面 | 变更 |
|---|---|
| `/api/*` 端点 | v1.16.0 零新增；**v1.16.4 新增 1 个** `POST /api/supplier-accounts/import-sessions`（仅 TR） |
| §2 `Upstream` | `supplier` 取值集合 `null` → `[null,'tierflow','tokenrhythm']`（schema enum 一处）；字段形状零变更 |
| `upstreams` 路由 schema | `supplierProp` enum 扩一项；`requireSupplierUpstream` 错误文案同步 |
| `supplier_accounts` | **零 DDL**（`supplier` 列建表起就在，值域扩一项而已）；`SCHEMA_VERSION` 仍为 2 |
| `ERROR_CODES` | **零新增**（422 用既有 `UNPROCESSABLE`；逐行码同 §15.4 处理） |
| 审计动作 | **零新增**（v1.16.4 的粘贴导入复用 `supplier.import`，`detail` 只有计数） |
| `/v1/*`、`src/gateway/` | **零改动** |
| `web/` | 判据改集合成员 + 能力位表 + 六个消费点查表化；**零新依赖** |

## v1.16.1 订正：登录形状

v1.16.0 的实测记录写着「`POST /api/auth/login`，body 字段名是 `account`」。这句话本身没错，
但**推论错了**：端点能收请求 ≠ 它能认证密码。复核（Bo 直接指出「这个只能是 cookie 登录啊」）：

| 输入 | 观测 |
|---|---|
| 正确账号 + 正确密码 | 401 `UNAUTHORIZED`「未认证或登录已过期」 |
| 正确账号 + 错误密码 | 401 `UNAUTHORIZED`（同码同文案） |
| 任意其他形状 | 401 / 400，**没有任何一次成功响应** |

⇒ 该端点**从不校验密码**；站点文档也从"已持有 `tr_session`"开始，真实登录是验证码流程。
**订正落地**：驱动器 `login()` 零请求直接 `rejected`；`POST /api/supplier-accounts/import` 与
`POST /:id/login` 对 TR 入口 422；入池改走 §15.9 离线一次性会话导入（决策 6）。
**没有改**：批量建 key 的路径（`keys` → `createToken`）与能力闸 —— 它们与登录形状无关。

## 判据（验收记录）

- **离线用例 64 条**：`src/supplier/tokenrhythm.spec.ts` 26 条（信封解码 / CNY 字符串 → 分 /
  两腿 self / subscriptions no-op / tokens 无分页 / createToken 明文一次性 / rotate 兜底 /
  CSRF 403 ≠ 401 / 登录零请求）+ `src/api/routes/supplier-accounts-tokenrhythm.spec.ts`
  7 条（入口 422 三闸 / 驱动器分发 / 掩码兼容 / 批量建 key / 任务逐行）+
  `src/supplier/session-import.spec.ts` 6 条（掩码 / 密文可解 / 覆写不增行 / 三类拒绝）+
  `src/supplier/session-import-batch.spec.ts` 7 条（v1.16.2：三种分隔 / 表头 / Cookie 清洗 /
  重复行 / 逐行报错不回显 / 批量落库与覆写 / 排除名单）+
  `src/supplier/session-resolve.spec.ts` 8 条（v1.16.3：身份字段 / 401≠403 / 信封
  UNAUTHORIZED / 未掩码值本地再掩 / email 兜底 / 缺 id / 网络与非 JSON）+
  `src/supplier/session-import-cookie.spec.ts` 10 条（v1.16.3：每行一枚会话 / 去重 /
  uid 判重 / 掩码兜底判重 / 单行失败不中断 / 不回显会话 / 排除名单入口拒绝 / 供应商闸）。
  全量套件 **1122 passed**（node22）。
- **`web/`**：`tsc --noEmit` 0 错 + `vite build` ✓；bundle 内能力分支字符串
  （「账号池钱包」「唯一的钱」「没有额度与模型白名单」）在 `SupplierAccountsPage-*.js` chunk 中可 grep。
- **LAN 实例手工验收**（见下）：枚举放行、四闸生效、TierFlow 侧回归无感。

## 手工验收记录（LAN 实例，2026-10-18）

| 步骤 | 期望 | 实测 |
|---|---|---|
| `POST /api/upstreams {"supplier":"tokenrhythm"}` | 201 | ✅ `up_0480ca6f2598`（**改前**的旧 dist 回 `INVALID_PARAM supplier 不合法` —— 即枚举在路由层生效的对照证据） |
| `GET /api/supplier-accounts?upstreamId=<TR>` | 200 空页 | ✅ `{"items":[],"total":0}` |
| `POST …/rotate-key`（TR 上游） | 422 | ✅ 「TokenRhythm 无套餐概念，不支持套餐 key 轮换（§15.14 能力表）」 |
| `POST …/keys {unlimited:false}`（TR 上游） | 422 | ✅ 「TokenRhythm 的 key 没有额度概念…」 |
| `POST …/keys {models:[…]}`（TR 上游） | 422 | ✅ 「TokenRhythm 的 key 不支持模型白名单…」 |
| `POST …/keys {unlimited:true}`（TR 上游，0 账号） | 422「没有可处理的账号」 | ✅（合法形状走正常路径，被空池拦下 —— 闸门没误伤合法请求） |
| `POST …/refresh`（TR 上游，0 账号） | 422「没有可处理的账号」 | ✅ |
| TierFlow 上游回归 | 无感 | ✅ 账号列表 49 个、套餐台账照常返回 |
