# ADR-0037：用户组模型授权 —— 「哪些组下的账号用哪些模型」

- 状态：**已接受（2026-10-17，Bo 报「第四别人的用户组是可以授权模型的，哪些组下的账号用哪些模型」）**
- 关联：契约 **§4**（新增「模型授权」节 + `authorizedModels` 字段 + GET/PUT 两端点）、
  **§5**（`enabled` 行验收 4 改口）、**§10**（新增 403 `MODEL_NOT_AUTHORIZED` + `/v1/models` 行改口 +
  码值落地笔 11→12）、**§12.1**（`AUTH_FAILED` 分型行扩到三码）、**§19.6**（消费面同源收窄）、
  **§19.9**（`group_models` 纯加表 + 两条显式级联）
- 车道：**三条车道各一段** —— `src/db/`（表 + 仓储）、`src/api/`（端点）、
  `src/gateway/` + `src/wiring/`（强制点）；`web/` 画师收尾
- 交付：**v1.15.8 已交付**（2026-10-17）。后端四闸全绿 + 六条变异验证；
  `web/` 组行「授权模型」抽屉；本机真实进程手工验收记录见下文「手工验收记录」节
- 触发：Bo 投诉 5，投诉 1–4 已在 v1.15.4–v1.15.7 交付
- 提案依据：`docs/proposals/1panel-*-v1.md` 决策 6（`group_models(group_id, model_id)` 或 CSV 列；
  「路由者的路由引擎需读这条授权（涉 `src/gateway/`，接口先行）」）

## 背景：三个收缩维度，缺了第三个

组这个实体已有两个收缩维度，各管一头：

| 维度 | 管什么 | 在哪 |
|---|---|---|
| `rpm` / `tpm` / `dailyQuota` | 用**多少** | §4 配额三字段 + `src/gateway/limiter.ts` |
| `upstream_keys.model_limits` | **哪把上游 key** 能跑哪个模型 | §3 / §16.3，`src/gateway/key-pool.ts` 的 `matchesModel()` |
| **组 → 模型**（本版） | **这一组的人**许不许用这个模型 | 此前**不存在** —— Bo 的原话就是这一格 |

关键区分：`model_limits` 是 **key 的属性**（"这把凭据能跑什么"），不是**组的属性**
（"这些人能用什么"）。两把 key 白名单不同、同属一组时，"这个组能用哪些模型"没有答案；
反过来，组授权了模型 A，key 白名单没含 A，照样打不通 —— **两者是交集，不是替代**。
本版只加组的这一层，不碰 key 层（那是 §3/§16.3 的冻结件）。

## 决策

### 1. 授权事实住在 `GroupContext` 里，实时读库 —— 不进快照、不进 key 池

`src/gateway/ports.ts` 的 `GroupContext` 加一个字段：

```ts
export interface GroupContext {
  groupId: string;
  name: string;
  enabled: boolean;
  rpm: number | null;
  tpm: number | null;
  dailyQuota: number | null;
  /** 该组授权的模型名列表；null = 不限（可用全部已启用模型）。v1.15.8。 */
  authorizedModels: readonly string[] | null;
}
```

- **为什么不进快照**（`SNAPSHOT_ENTITIES = {upstream, key, model, balance}`）：group 与
  gateway_key 本来就被**刻意排除**在快照实体之外 —— 鉴权与限流走 `src/wiring/auth.ts` 的
  **实时读库**（`findGroupByGatewayKeyHash`，索引点查、单行），换来"撤销/改配额下一个请求生效"。
  授权是**同一个性质的属性**（管理员改了授权，应当立刻生效，而不是等 1s 轮询），
  所以它跟着 `GroupContext` 走，`auth.ts` 的查询**已经 JOIN groups 拿到整行**，
  补一次 `SELECT model_id FROM group_models WHERE group_id = ?`（每请求一次，主键前缀查，微秒级）。
- **为什么不进 key 池**：`getAvailableKeys(model)` 的签名是 **PM 冻结件**
  （`src/gateway/key-pool.ts` 头注，变更需走契约流程），而且它管的是"哪把 key 可用"，
  管不到"这个组可不可以调" —— 前者有候选集，后者是**非黑即白的准入**，判在候选集建立之前。
- **为什么 `readonly string[] | null` 而不是 `Set`**：与 `GroupDto.authorizedModels`
  （JSON 数组）同形，`auth.ts` 直接透传，不再造一份转换。

### 2. 授权键是**模型名**，不是 `model_id` —— 落库存 id、判定按名

**判定面按名**：`/v1/models` 给出去的是 `m.name`，`POST /v1/chat/completions` 收到的也是名字，
网关热路径上**不存在**名字→id 的映射（`resolveUpstreamModel` 是恒等透传，档案表没有别名列）。
按 id 授权意味着热路径要先查档案表把名字翻成 id —— 一次点查 + 一条不存在语义
（"请求的名字对应两条档案、一条授权一条没授权"算什么？）。

**落库面按 id**：`group_models.model_id REFERENCES models(id)`。授权一个名字时
`db/repo/models.ts` 按 `upstream_id + name` 解析 id —— **所有叫这个名字的档案一起授权**。

- **为什么"全部同名档案"是有意的**：`/v1/models` 的 `id` 字段给的就是 `m.name`
  （`src/wiring/store.ts` 的 `listEnabledModels`），消费方（ChatGPT-Next-Web 等）
  手里**只有名字**。两条上游同名模型时，按 id 授权会造出"列表里有它、打过去 403"的假象；
  按名授权与"调用方看到什么就能打什么"严格一致。
- **代价（写在这里，不粉饰）**：不能表达"授权 up1 的 `gpt-4o`、不授权 up2 的 `gpt-4o`"。
  需要这个粒度的部署，应当先在档案上禁用其中一条（`enabled=false`）——
  那是全局的档案管理，不是组的授权。
- **名字解析不到 → `400 INVALID_PARAM`（`details.field='models'`），不静默忽略**：
  把拼错的名字静默丢掉，等于给一个"保存成功但什么都没授权"的面；
  报错让管理员当场看到拼错在哪。

### 3. `PUT` 整组替换，`null`/`[]` 同义 = 不限 —— 不造第三态

- **为什么 `PUT` 不是 `POST`/`DELETE` 逐项增删**：授权是**整组的一个属性**（一个集合的当前值），
  不是可累加的成员列表。整组替换让"当前授权是什么"永远只有一个事实源
  （一次 PUT 的 body），而逐项增删会造出"两个管理员同时编辑"的合并问题
  （乐观锁 `revision` 因此照抄 `PATCH /api/groups/:id`：**body 带 `revision`**，
  不匹配 → 409 `REVISION_MISMATCH`）。
- **为什么 `models` 必填且可空**：`PUT /api/keys/:id/balance` 同一条 ——
  `null`（不限）与省略是两件事；省略字段表达不了"置回不限"。
- **`[]` 与 `null` 同义**（沿 §15.7/§16.3 冻结口径 `serializeModelLimits`：出口恒不出现"空集"），
  **明确不支持"显式一个都不许"**：
  - 它要求网关把"组被禁用"（`GROUP_DISABLED`，该组谁都不许调）与
    "组被授权成空集"（只这个模型都不许）分开 —— 两者失败形状几乎一样（都是 403/401 一族）、
    排障含义却相反（一个查账号状态、一个查授权列表）；
  - 真要"这个组谁都别调"，**禁用组**就是那个按钮（§4 的 `enabled` 开关，界面上一格）；
  - 落库侧 `[]` 归一成"删全部行" = `null`，与 `serializeModelLimits` 的"不落空集"逐字同构
    （`src/db/model-limits.ts` 的注释：**契约不制造一个实现不了的三态**）。

### 4. 强制点在**路由层**（`readModel` 之后、引擎之前），不在引擎、不在 key 池

三个候选位置，逐一否掉：

- **引擎层（`engine.ts` 的 `forward()`）**：否。`forward` 是**转发路径**，它已经拿到了
  候选集、算过了限流；在那里拒等于让"授权失败"看起来像"转发失败"。
  更硬的理由是**助手**：`src/wiring/assistant-invoker.ts` 直接调引擎、**不过路由层**
  （文件头决策 2：「限流是 routes 层的事，内部调用不过 routes」）—— 引擎层强制会把
  `internal-assistant` 也卷进授权判定（它的合成组该授什么模型？），而路由层强制
  让助手**天然豁免**：它不过路由，就没有授权检查，与它"不参与限流、零 usage 落库"同一条结构事实。
- **key 池层**：否（见决策 1 —— 冻结件 + 语义不符）。
- **路由层（本版）**：`requireGroup`（401/403 禁用）→ `passLimiter`（429）→
  `asJsonObject` → `readModel`（400 缺 model）→ **`requireModelAuthorized`（403，本版新增）** →
  `messages`/`input` 校验 → 引擎。落在这排队的理由：
  - 它和 `GROUP_DISABLED` / 限流是**同一类拒绝**（凭据/策略侧、0 次真实尝试、
    候选集根本不建 —— §10 的 0-attempt 判据原样成立：`failureReason: null`、不计 key 健康、
    不碰冷却）；
  - `reportRejection` + `authedFacts` 就在旁边，事件（§12.1）与响应同源 ——
    事件里 `attempts: 0`、`candidates: null`、`clientModel` 已填，**零新增字段**；
  - **`/v1/models` 不强制**：它是**读面**，调用方需要它来发现自己能用什么；
    收窄（见决策 6）已经够了，对它 403 只会把"你被授权了什么"变成猜谜。

`src/gateway/routes.ts` 加的入口形状（与 `passLimiter` 同形）：

```ts
function requireModelAuthorized(request, reply, group: GroupContext, model: string): boolean
```

`group.authorizedModels === null` 或 `includes(model)` → 放行（`*` 不特判：
授权列表按字面匹配，**通配符归 key 白名单的既有语义**（§16.3 `matchesModel`），两层不混）。
否则 403 `MODEL_NOT_AUTHORIZED` + 事件。

### 5. 新增 403 `MODEL_NOT_AUTHORIZED`，分型归 `AUTH_FAILED` —— 并同笔订正一处既有漂移

**为什么是新码不是复用**：

- 复用 `GROUP_DISABLED`（同 403 / 同 type）：**说谎**。组没禁用，值班看到 403
  `GROUP_DISABLED` 会去查账号状态，查不到任何问题 —— 排障被引向错误方向。
- 复用 `INVALID_REQUEST`（400）：更糟。调用方没有写错任何东西，让客户端把 400 当
  "重试也没用"处理是对的，但把"没授权"归进"请求格式错"会让重试逻辑永远救不了它。
- 403 `MODEL_NOT_AUTHORIZED` + `type: authentication_error`：与 `GROUP_DISABLED`
  同族（"凭据对了、人不对"），客户端的处置一致（找管理员，不是改代码）。

**代价链（全部同笔落，漏一条即红）**：

| 点 | 变更 |
|---|---|
| `src/gateway/errors.ts` | `GATEWAY_ERROR_CODES` 11 → 12 + 构造器 `modelNotAuthorizedError` |
| `src/api/balance-sync.spec.ts` | `expect(Object.keys(GATEWAY_ERROR_CODES)).toHaveLength(12)`（该断言自带历史注释：新增码必须有契约与 ADR 背书 —— 本 ADR 即是） |
| `src/wiring/error-event-sink.ts` | `CODE` 加一行 + `categoryOfCode` 加 case → `AUTH_FAILED` |
| `error-event-sink.spec.ts` | 分型表加一行 |
| §0.4 | **零变更**（那是管理面 `{code,message}` 的表，网关码不进它 —— §10 与 §0.4 本来就是两套） |

**同笔订正（不静默）**：`NO_AVAILABLE_EGRESS`（v1.7.0 进 §10 表，`GATEWAY_ERROR_CODES`
的第 11 个码）**从未登进 `error-event-sink.ts` 的 `CODE` 映射** —— 503
`NO_AVAILABLE_EGRESS` 事件至今被 `deriveCategory` 归成 **`INTERNAL`（error 级）**。
而 §10 那句「§12.1 的 category 仍是 9 值：'出口选不出'与'key 选不出'是同一个分诊对象」
的**意图本来就是**它归 `NO_AVAILABLE_KEY` 分型 —— 这是"契约表加了码、实现侧映射没跟上"
的既有漂移，先于本版存在。本版把它补进 `NO_AVAILABLE_KEY` 分型并加用例钉住
（不静默改：改了什么、为什么，都写在这里）。

### 6. 同源三角改口：从"全局 0 差异"到"enabled 判据 ∩ 组授权，按组成立"

`/v1/models`（§10）≡ 档案 enabled（§5）≡ `/api/console/models`（§19.6）的
**逐项 0 差异**不变量，被"按组收窄"**刻意打破了一半**：授权了列表的组，看到的集合
**严格小于** enabled 集合。契约三处同批改口（§5 `enabled` 行 / §10 `/v1/models` 行 / §19.6）：

- 新不变量：`/v1/models(某把 key)` = `/api/console/models(同组会话)` =
  **enabled 判据 ∩ 该组授权** —— 每个组内部仍逐项 0 差异；
- **未授权收缩的组**（`authorizedModels: null`）：集合与改版前**逐项相同** ——
  既有验收 4 对全部存量组原样成立，升级零行为变更；
- `/api/console/models` 按会话的组收窄（消费面数据归属只来自会话，§19 头注既有纪律）。

**为什么消费面必须跟着收窄**：模型广场存在的理由就是回答"我能用哪些模型"
（§19.6 原文：「与网关实际准入的集合一致，否则又是一个会骗人的信号」）。
授权了组的用户在广场上看到列表外的模型、打过去 403 —— 那正是同一句
"会骗人的信号"。收窄在**服务端**做（console.ts 的 SQL 加一个判据），不给前端过滤：
前端过滤是"列表对了、集合没对"。

### 7. 级联：两条显式清理，漏一条 = 删除操作 500

全库 `foreign_keys = ON` 且**无 `ON DELETE` 子句**（schema.ts 刻意如此，删组事务注释：
"谁受什么影响由这里显式决定"）。`group_models` 带两条外键，所以：

1. **`deleteGroup`** 事务内、删 `groups` 行**之前**：`DELETE FROM group_models WHERE group_id = ?`；
2. **`deleteUpstream`（force 路径）**、删 `models` 行**之前**：
   `DELETE FROM group_models WHERE model_id IN (被删档案的 id 集合)`。

实测钉过（better-sqlite3 内存库）：不清理先删 → `FOREIGN KEY constraint failed`。
**两个删除路径都必须变异验证**（把清理行删掉 → 红）。

**模型同步不产生孤儿**（这条写进 §19.9）：`upsertModelFromSync` 对已存在档案
**只 UPDATE、从不 DELETE/重建**（§5「未知不覆盖已知」），`models.id` 在同步下稳定 ——
授权行不会因一次同步失效。档案行消失只有一条路：`deleteUpstream`（force），那是 ②。

### 8. 管理面出口：`GET`/`PUT /api/groups/:id/models` + 审计 `group.models.update`

- **`GET`** 回 `{models: string[] | null, authorizedModels: [{id, name, upstreamId}]}`：
  `models` 是**可写回的授权名列表**（PUT 的 body 就吃这个形状），
  `authorizedModels` 是**展开后的档案行**（管理面要显示"这条授权落到哪个上游"）。
  两者并存是刻意的：只给展开行，前端要把行再拼回名字列表才能编辑；
  只给名字，界面上分不清同名档案。**不给 `model_id` 裸值**：对界面无意义。
- **`PUT`** body `{models: string[] | null, revision}`：`revision` 必填（乐观锁，与
  `PATCH /api/groups/:id` 同一条），返回同 `GET` 的形状 + 新的 `GroupDto`。
- **审计** `group.models.update`，`detail` = JSON `{from, to}`（两个名字列表，截断由
  audit 层既有纪律兜）—— "授权从什么改成什么"是这条审计最有价值的一列
  （与 `key.balance` 记"置为未知还是具体金额"同一条理由）。
  `audit_log.action` 是自由 TEXT（schema 无 CHECK），**零 schema 变更**。
- **组行 `authorizedModels`**：`GroupDto` 非破坏新增（与 `gatewayKeyMasked` 同一呈现层），
  `listGroups` 的 N+1 查询多一次每行的授权名查询 —— 组数是几十的量级，可接受；
  **不**做"只在详情端点给"（列表页的授权列就要它）。

### 9. `web/`：组行「授权模型」抽屉

- **抽屉不是新页面**：授权是**某一个组**的属性（ADR-0036 决策 2 同理由，先例四处）。
- 抽屉内容：说明行（`null` = 不限）+ 模型多选（数据源 `/api/models?enabled=true`，
  只列已启用档案）+ 保存（`PUT`，带 `revision`）。
- **保存成功后就地更新组行**（`authorizedModels` 那一格），**不整页刷新**
  （v1.15.4 / ADR-0035 / ADR-0036 同一条纪律——Bo 投诉 2 的形状）。
- **不给"全部拒绝"选项**：UI 上没有第三态可选（决策 3），清空选择 = 不限，
  文案明说。
- **候选集按名去重，且与 `AssistantModelSelect` 同一条判据**（`/api/models?enabled=true`
  ∩ `/api/upstreams?enabled=true`）：给管理员看到一个打不通的名字，是又一种会骗人的信号。
- **两处"抽屉比端点更诚实"的补丁**（手工验收时发现的真形状，不是预设计）：
  - **已授权但不在候选集里的名字**（档案/上游被停用）会在多选里消失 —— 而授权面
    **刻意不限 `enabled`**（`resolveModelIdsByName` 的注释：停用是临时状态），
    于是那些名字既打不通又看不见、还**点不掉**。抽屉因此把它们**补进选项**
    （标「当前不可用」）并给一条警示 —— 不替用户删（授权是长期策略，自动清理
    等于替人做了个不可见的长期决定）。
  - **`409 REVISION_MISMATCH` 就地显示**，不只是一个飘过去的 toast：toast 消失了
    屏幕上就没有任何东西告诉用户"还差一步重读"。抽屉里给一条常驻 Alert +
    「重读最新」按钮（重读 `GET /api/groups/:id` 拿回当前 `revision`）——
    重读前保存按钮禁用（拿一个已知过期的版本号再发一次 = 把同一个错再犯一遍），
    重读**不自动合并草稿**（两个管理员各改一半，替谁合并都可能合掉对方的意图）。
- **消费面收窄零改动，但本版顺手修掉一个真 P0**（手工验收时发现，不是预设计）：
  收窄本身前端一行不用改（数据源就是服务端收窄后的 `/api/console/models`，决策 6）。
  但验收时把**服务端真实响应**摆到页面前才发现：`web` 的 `ConsoleModel` 类型写的是
  `{id, displayName, enabled}`，而服务端从第一天回的就是
  `{id, name, displayName, type, capabilities, contextLength}` —— **没有 `enabled`、有 `name`**。
  两个后果都是用户可见的，且都是"页面在对着一个不存在的字段编故事"：
  - `item.enabled` 恒 `undefined` ⇒ falsy ⇒ **每个模型都渲染成「已停用」**，
    而「只看可用」开关一按**把列表清空**（`filter(item => item.enabled)` 恒空）——
    用户看到的是"站里一个模型都没有"。
  - 卡片上可复制的那个值是 `item.id`（`mdl_*` 档案行号），而 §10 的请求键是**模型名** ——
    照抄它去调用**必 404**。整页没有一个可用的值可给用户。
  - 修法是**删掉**开关与「已停用」分支（服务端 SQL 判据恒 `enabled = 1`，
    这个三态在协议上不存在），并把可复制值改成 `item.name` —— 不是补一个恒真的字段。
  为什么既有四闸没拦住：`web/` **没有测试 runner**（遗留 4），而两边各自类型自洽
  （服务端 DTO 与前端 interface 都是"合法的 TS"），唯一能发现它的是**把真响应喂给真页面**。

## 影响面

| 面 | 变更 |
|---|---|
| DDL | **`group_models` 纯加表**（双外键 + 复合主键）；`SCHEMA_VERSION` 仍为 **2**（纯加表先例：`gateway_error_events` §12.1） |
| 级联 | `deleteGroup` / `deleteUpstream` 各加一条显式清理（**漏一条 = 500**，变异验证覆盖） |
| `/api/*` | **新增 2 端点**（`GET`/`PUT /api/groups/:id/models`）+ `GroupDto` 非破坏新增 `authorizedModels`；其余**零字节变更** |
| `/v1/*` | **新增 1 码**（403 `MODEL_NOT_AUTHORIZED`）；chat/embeddings 加强制门；`/v1/models` 按组收窄；其余零变更 |
| `/api/console/*` | `/api/console/models` 按组收窄（**零端点变更、零字段变更**，集合语义变） |
| `src/gateway/` | `ports.ts`（`GroupContext` 加字段）、`routes.ts`（强制门）、`errors.ts`（新码）—— limiter / key-pool / engine **零改动**（engine 不判授权；KeyPool 冻结签名不动） |
| `src/wiring/` | `auth.ts`（实时补查授权列表）、`error-event-sink.ts`（新码分型 + `NO_AVAILABLE_EGRESS` 补登）、`assistant-invoker.ts`（`ASSISTANT_GROUP` 字面量加 `authorizedModels: null`）、`store.ts` 零改动 |
| `ERROR_CODES` | **零新增**（管理面仍用 `INVALID_PARAM` / `REVISION_MISMATCH` / `NOT_FOUND` 既有码） |
| `GATEWAY_ERROR_CODES` | **11 → 12**（`balance-sync.spec.ts` 长度断言同笔） |
| §12.1 分型 | **仍是 9 值**；`AUTH_FAILED` 行扩到三码；`NO_AVAILABLE_EGRESS` 补进 `NO_AVAILABLE_KEY` 分型（既有漂移订正） |
| 审计动作 | 新增 **`group.models.update`**（自由 TEXT，零 schema 变更） |
| 快照 | **零变更**（`SNAPSHOT_ENTITIES` 不动；授权实时读） |
| 助手 | **零波及**（不过路由层，天然豁免 —— 决策 4 的判据） |
| `web/` | `GroupsPage` 授权抽屉 + `groupsApi` 两函数 + 类型；`ConsoleModelsPage` **收窄零改动**，但**顺手订正了一个真 P0**（`ConsoleModel` 类型与服务端响应不符，见决策 9 末条） |

## 判据（全部经变异验证）

| 用例 | 钉住什么 |
|---|---|
| 组授权 `["m-a"]`：打 `m-a` → 200（转发起） | 授权放行是**真的放行** |
| 同组打 `m-b` → **403 `MODEL_NOT_AUTHORIZED`**、`attempts=0`、`candidates=null`、`failureReason=null` | 0-attempt 判据（§10）：没碰候选集、没碰 key 健康 |
| 同组打 `m-b` → 事件 `category=AUTH_FAILED`、`severity=warn`、`model=m-b` | §12.1 分型落对行 |
| `authorizedModels: null` 的组：打任意已启用模型 → 200、`/v1/models` 与改版前逐项相同 | **升级零行为变更**（验收 4 对存量组原样成立） |
| 授权 `[]` ⇒ 落库后 `GET` 回 `null`、行为与 `null` 全同 | `[]`/`null` 同义（不造第三态） |
| PUT 带未知模型名 → `400 INVALID_PARAM`、库**零变更** | 不静默忽略 |
| PUT `revision` 不匹配 → 409 `REVISION_MISMATCH` | 乐观锁 |
| PUT 后**下一个请求**即按新授权判（不重启） | 实时读（决策 1） |
| 组 A 授权 `[m-a]`、组 B `null`：两把 key 各打 `/v1/models` → A 只有 m-a、B 全量 | 按组收窄、互不干扰 |
| 同组会话 `/api/console/models` = 该组 key 的 `/v1/models` 逐项 0 差异 | 同源三角（决策 6） |
| key 白名单 ∩ 组授权的**交集**判定：组授权 m-a、key 白名单只含 m-b → 打 m-a 也拒（503 候选空或 403） | 两层是交集不是替代（背景表） |
| 删组（带授权行）→ 200/204、授权行随之消失 | 级联 ① |
| 删上游 force（其档案被某组授权）→ 不 500、指向被删档案的授权行消失 | 级联 ②（FK 实测钉过） |
| 503 `NO_AVAILABLE_EGRESS` 事件 → `category=NO_AVAILABLE_KEY`（不再 INTERNAL） | 同笔订正（决策 5） |
| `GATEWAY_ERROR_CODES` 长度 = 12 | 码值落地笔 |

**变异清单**（每条删掉/改坏 → 对应用例红）：
① `requireModelAuthorized` 的 `includes` 判定改成恒 `true` → 403 用例红；
② `auth.ts` 不补查授权列表（恒 `null`）→ 收窄用例红；
③ `deleteGroup` 不清 `group_models` → 级联 ① 用例红（FK 500）；
④ `deleteUpstream` 不清授权行 → 级联 ② 用例红；
⑤ `categoryOfCode` 不认 `MODEL_NOT_AUTHORIZED` → 事件分型用例红；
⑥ `serializeAuthorizedModels` 的 `[]`→`null` 归一去掉 → 同义用例红。

**变异清单**（每条删掉/改坏 → 对应用例红）：
① `requireModelAuthorized` 的 `includes` 判定改成恒 `true` → 403 用例红；
② `auth.ts` 不补查授权列表（恒 `null`）→ 收窄用例红；
③ `deleteGroup` 不清 `group_models` → 级联 ① 用例红（FK 500）；
④ `deleteUpstream` 不清授权行 → 级联 ② 用例红；
⑤ `categoryOfCode` 不认 `MODEL_NOT_AUTHORIZED` → 事件分型用例红；
⑥ `serializeAuthorizedModels` 的 `[]`→`null` 归一去掉 → 同义用例红。

六条**全部实际做过**（就地改坏 → 跑对应用例确认红、且**报错消息与预期一致** → 还原 → 复跑绿；
还原后 `grep MUTATION` = 0 命中）。两处过程记录：
- ⑤ 第一刀多删了一行（`case MODEL_NOT_AUTHORIZED` 连同 `return 'AUTH_FAILED';` 一起删），
  结果把 `GROUP_DISABLED` 也从链上摘掉，红出来的失败是 `INVALID_API_KEY → RATE_LIMITED` ——
  **不是**预期的分型错误。重做成"只删 `case` 那一行"才红出
  `MODEL_NOT_AUTHORIZED: expected 'INTERNAL' to be 'AUTH_FAILED'`。
  这说明变异验证本身也会假绿：**红必须红在该用例的理由上**，红了就算数是自欺。
- ①–④、⑥ 均一次命中，失败消息即上表右列。

## 手工验收记录（2026-10-17，本机真实进程 + 真实上游）

四闸全绿（`typecheck` / `test` 1031 passed / 62 files / `build` / `check:secrets` 346 文件 0 命中）
**不等于功能可用** —— 以下是真跑出来的记录（网关 :4000，管理面 :4001，
`/tmp/subtest/test.env`，`DB_PATH=./data/test-lan.db`，`ADMIN_WEB_DIST=web/dist`）：

| 动作（真实调用） | 实测结果 |
|---|---|
| `GET /api/groups` | 每行带 `authorizedModels: null`；`GET /api/groups/:id/models` → `{models: null, authorizedModels: []}` |
| `PUT {models:["tierflow"], revision:2}` | 200；回 `group.revision=3`、`group.authorizedModels=["tierflow"]` |
| PUT 之后**不重启**，`GET /v1/models` | `['tierflow']`（改前是三个）—— **热生效，实测** |
| 打未授权 `tierflow_pro` / `TierSense` | 403 `MODEL_NOT_AUTHORIZED`、`type=authentication_error`、`param=model` |
| 打已授权 `tierflow` | 200，真转发（上游回 `Qwen3.8-Flash`） |
| PUT 带过期 `revision:2`（实际 3） | 409，`details:{expected:2, actual:3}` |
| `PUT {models:[], revision:3}` | 回 `models: null`、`authorizedModels: []`、`revision:4` —— **`[]` 归一成 `null`，实测** |
| `role=user` 会话 `GET /api/console/models` | 收窄后 `names = ['TierSense','tierflow']`，与同组 key 的 `/v1/models` 的 `id` 集**逐项相同** |
| `GET /api/observability/errors` | 三条 403 事件全为 `category=AUTH_FAILED` / `severity=warn` / `gatewayCode=MODEL_NOT_AUTHORIZED` / `model` 有值 |
| 带授权行删组 | 204（**不 500**）—— 级联 ① |
| `PUT {models:["no-such-model-xyz"]}` | 400 `INVALID_PARAM`（`details.field=models`），且随后 `GET` 显示授权与 `revision` **未变** —— 库零变更 |
| `GET /api/audit` | `group.models.update` / `targetType=group` 两条（列表 DTO 按 §17 不含 `detail`） |
| 浏览器（CDP，真实 Chromium 打 `:4001`） | 组行新增「授权模型」列：`不限 · 设置授权` / `2 个模型 · 调整授权`；无 console 错误 |
| 抽屉打开（截图留档） | 说明行 + 已选两个 chip + 「当前授权落到 2 条模型档案」+ 改动立即生效 Alert |
| 抽屉里去勾 `tierflow` → 保存 | toast「已保存模型授权」、抽屉关闭、**行就地变「1 个模型」**（未刷新整页）；随后网关 `/v1/models` = `['TierSense']`、打 `tierflow` → 403 |
| 停用 `TierSense` 档案后重开抽屉 | 出现警示「有 1 个已授权模型当前不可用」，chip 显示为 `TierSense（当前不可用）` |
| 抽屉开着时从 API 改该组授权（模拟第二管理员）→ 点保存 | 就地出现「版本冲突」Alert、toast 带 `{"expected":6,"actual":7}`、**保存按钮变 disabled** |
| 点「重读最新」 | 冲突 Alert 消失、草稿重锚到服务端当前值（`tierflow_pro`）、保存恢复可用；再保存 → 成功 |
| 清空选择 → 保存 | 就地警示「保存后将清空该组的全部授权行」→ toast「已清空授权（该组恢复为不限）」、行变「不限 · 设置授权」；服务端 `models: null`、网关看到全部三个 |
| 恢复现场 | `TierSense` 重新启用；测试账号 `acc-v1158` 已删（204） |

**手工验收额外抓到的一个既有 P0（非本版引入，但由本版验收发现）**：
消费面模型广场此前**每个模型都显示「已停用」**、点「只看可用」**列表清空** ——
`web` 的 `ConsoleModel` 类型写成 `{id, displayName, enabled}`，
而 §19.6 服务端从第一天回的就是 `{id, name, displayName, type, capabilities, contextLength}`
（**无 `enabled`、有 `name`**）。`undefined` 恒 falsy ⇒ 每个模型都被标停用；
卡片上唯一可复制的值还是 `mdl_*` 档案行号（网关请求键是**模型名**，照抄必 404）——
用户拿到的是一个既说"全都不能用"、又没给可调用值的页面。修法：删掉那个开关与
「已停用」分支（该三态在协议上不存在）、可复制值改 `item.name`。
**为什么四闸全绿也拦不住**：两边各自类型自洽（服务端 DTO 与前端 interface 都是合法 TS），
而 `web/` 无测试 runner（遗留 4）—— 这是"**只有把真实响应喂给真实页面才能发现**"的
教科书案例，也正是本条手工验收存在的理由。修后真浏览器复验：
`/console/models` 渲染 3 个模型、显示并可复制**名字**、无「已停用」标签
（截图 `/tmp/subtest/v1158-console-models-fixed.png`）。

**遗留 4（`web/` 无自动化测试）在本版仍成立** —— 上表 8 条浏览器行为是手工 + CDP 脚本跑的，
不是 CI 能重放的东西。这是本版**已知且登记**的验收强度上限。
**上一条 P0 就是这条遗留的代价实例**：它在本版开工前就存在、活了两个版本，
直到有人真的把页面打开（而不是跑测试）才被发现。本版不承诺"下次补 runner"，
但要承认这一类缺陷的发现渠道只有手工验收。

## 遗留（不粉饰）

1. **同名模型跨上游不可区分**（决策 2 的代价）：授权一个名字 = 全部同名档案。
   需要按档案区分的部署只能禁用档案 —— 这是粒度上限，不是 bug。
2. **403 会承认"这个模型存在"**（决策 4）：收窄之后未授权的模型名**不出现在**
   `/v1/models` 里，但绕过列表直接猜名字的调用方拿到的是一条 403（而不是 404）——
   等于承认模型 X 存在。**可接受**：403 的存在性泄漏只对"猜别的组授权了什么"有意义，
   而那需要先持有一把有效 key；且 §10 已把 `INVALID_API_KEY` 的"不区分不存在与已禁用"
   写在另一条理由上（防 key 探测），两件事不冲突。
3. **每请求一次授权查询**（决策 1）：`SELECT model_id FROM group_models WHERE group_id = ?`
   每请求一次（有组授权时）。主键前缀查、微秒级；若某天授权列表变成千行量级，
   应改读 `auth.ts` 内一个 per-group 的短缓存 —— 那会重新引入"改授权不立即生效"窗口，
   届时按 ADR-0035 的实时性论证重新裁定，本版不做。
4. **`web/` 仍无自动化测试**（ADR-0034 遗留 7 / ADR-0036 遗留 1 同一条，第 N 次登记）。
   授权抽屉靠手工验收；本版不承诺"下次补 runner"。
5. **组行授权列在列表页**（决策 8）：`listGroups` 每行多一次授权查询（N+1 +1）。
   组数是几十的量级；若列表页变慢，正确做法是把授权列挪进详情端点，不是加缓存。
6. **提案的备选 C（CSV 列挂在 `groups` 上）未走**：CSV 列省一张表，但"组 → 多行"的
   查询、级联、审计都要在 TEXT 里打转，且与 §15.7 的 `model_limits`（也是 CSV）
   撞名 —— 两个 CSV、两个语义、两套解析。表是更贵的初始成本、更便宜的后续成本。
