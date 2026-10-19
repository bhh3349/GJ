# ADR-0039：端点类别准入 —— 「模型类别」这个网关基础功能，第一次进服务路径

- 状态：**已接受（2026-10-18，Bo 实测报「来你来测试一下能不能用」→ 定位后裁定「按你建议来」）**
- 关联：契约 **§5**（`type` 行补说明）、**§10**（新增「端点类别准入」节 + 两个端点行改口 +
  `/v1/models` 每项加一格 `type` + `INVALID_REQUEST` 行扩触发条件）、**§16.3**（403 误伤那条备注
  补"孪生形状已触发过"）、**§19.10**（影响面）
- 车道：**两条车道** —— `src/gateway/`（路由 + 端口）、`src/wiring/`（快照 + 装配）；
  `src/db/` 只多读一列（SELECT 补 `m.type`，无 DDL）；`src/api/`、`web/` 零改动
- 交付：**v1.15.10 已交付**（2026-10-18）。四闸 + web 两闸全绿；四条变异全红；
  真实 LAN 实例手工验收见下文「手工验收记录」节
- 提案依据：Bo 在 v1.15.9 交付后给的一把真实 key（`gw-PYq8…`，Base URL `http://192.168.1.66:4000/v1`）
  实测「能不能用」，`POST /v1/embeddings` 回 404
- 实测口径更正（**一次我自己的取证失误，记下来**）：验收中途我曾判定 Bo 那把 key 已失效 ——
  依据是库内 `gateway_keys.key_hash` 与 `sha256(明文)` 对不上。**那个判断是错的**：我拿来比对的
  明文是从 `/tmp` 里一份**被截断的副本**（`gw-PYq8RGgWJ…`，尾部是我早先拼接时留下的拼接痕迹），
  真正的明文是 `gw-PYq8ZHkgG7tccxO-uZTN3oJbuDyS9vYt`，它的 sha256 **正好命中**
  `gwk_b53ee524a84e`（`****9vYt`）。教训与 §16.3 那条同源：**哈希对不上只能说明"我手上这份明文不是那一份"，
  不能反推"那把 key 被作废了"**。本 ADR 下方表 1–5 行全部是 Bo 那把真实 key 打出来的；
  第 6/7 行也用同一把 key 复核过一遍（结果逐字一致）。中途为排除干扰临时签发的那把 key
  已 `DELETE`（204），库内该组仍只有 Bo 那一把。

## 背景：一个功能做了一半，而且我第一遍看反了

### Bo 的纠正（原话，因为它是本 ADR 的起点）

> 「tierflow 该上游没有向量模型，你应该是脑子抽风了。这种模型类别是网关的基础功能，
> 而不是上游供应商必须提供的模型」

我的第一版诊断是「这个上游没有向量模型 ⇒ 把 embeddings 从文档那条三端点清单里删掉」。
**那是把问题倒过来看**：它把"网关该做的事"改写成"上游该提供的东西"。
正确的问题是 —— **网关登记了模型的类别，然后在转发时完全不用它**。

### 证据链（三层，都是"没有"：没有一处在读 `type`）

| 层 | 事实 | 位置 |
|---|---|---|
| 读路径 | `listEnabledGatewayModels` 的 SELECT **不带 `m.type`**；`EnabledGatewayModel` 没有 `type` | `src/db/repo/models.ts:370`（改前） |
| 端口 | `ModelDescriptor` 没有 `type`；`ModelCatalog` 只有 `listEnabledModels` / `resolveUpstreamModel` | `src/gateway/ports.ts:57`（改前） |
| 服务路径 | `routes.ts` / `engine.ts` / `key-pool.ts` 里 `.type` **零次读取**（`grep` 全文可验） | — |

于是 `type` 只活在三个**非服务**的地方：DDL 的 CHECK、管理面 CRUD、模型广场的展示与筛选。
「有类别」和「有端点」是两条互不相交的事实。

### 症状（实测，改前）

```
POST /v1/embeddings   model=tierflow_pro   （档案里登记为 type='chat'）
→ 404  x-gateway-attempts: 1  x-gateway-ttfb-ms: 1186
   body: {"error":{"message":"Invalid URL (POST /v1/embeddings)", ...}}
```

三件事同时发生，而三件都不该发生：

1. **真的敲了上游**：`x-gateway-attempts: 1` —— 请求被原样转发到上游的 `/embeddings` 路径。
2. **上游的 404 被当成一次正常调用落库**：引擎对 `classifyUpstreamStatus` 判 `null` 的 4xx
   **原样透传**（这条本身是**对的** —— §10 铁律不许一个写错参数的调用方把整池 key 打进冷却），
   于是这次 404 走的是"业务响应"那条路：`usage_logs` 落一行、`error_code` 为空。
3. **两端看到的 `requests` 数字虚高**：`todayUsage()` 是
   `SELECT COUNT(*), SUM(total_tokens), SUM(cost_cents) FROM usage_logs WHERE group_id=? AND ts>=?`
   —— **不带状态过滤**。管理面组用量行与消费面额度卡用的是**同一句 SQL**（契约 §4 / §19.3c
   的"字节级一致"是刻意设计），所以这个虚高在**两个面同时**出现。`dailyQuota` 不受影响
   （0 token），但 **RPM 被消耗**（限流判在转发之前）。

### 为什么类别是网关的事，不是上游的事

`models.type` 是**谁建的档谁填**的字段：`POST /api/models/sync` 按名字推断（`inferModelType`），
`PATCH /api/models/:id` 人手改（人工优先）。它是**网关侧的登记事实**。
上游没有向量模型是**一个正常的部署状态**（tierflow 就是），网关该回答的是
「你把这个名字用在了不服务它的端点上」，而不是替调用方去敲一次必然 404 的上游。

### 为什么不能靠"同步一份 embedding 档案"绕过去（查过，不成立）

- 档案**只能经同步出生**：`src/api/routes/models.ts` 里只有 GET / GET :id / PATCH :id / POST sync /
  POST :id/probe，**没有 `POST /api/models`**。
- `type` 在 `upsertModelFromSync` 插入时定稿，**更新时取 `existing.type`**
  （`const nextType = existing.type; // 推断只用于建档，人工 PATCH 优先`）。
- 能力探测**只讲 chat**（stream / function_call / vision / json_mode），从不写 `type`。
- 于是：**没有任何操作能在 tierflow 这类只有 chat 模型的上游上变出一行 `embedding` 档案**。
  一个只靠"去建一个 embedding 档案"的方案，在这台机器上**永远无法验证**。

## 决策

### 1. `models.type` 进服务路径，**走快照**而不是实时读库

三处补 `type`：

- `listEnabledGatewayModels` 的 SELECT 补 `m.type AS type`，`EnabledGatewayModel` 加 `type: ModelType`；
- `ModelDescriptor` 加 `type: ModelType`（`ModelType` 在 `ports.ts` **本地定义**一份 ——
  `src/gateway` 不得 import `src/api`，与本文件同族的先例是 `KeyCategory`；两处注释互相钉住）；
- `store.ts` 的 `rebuild()` 建 `typeByName: Map<string, ModelType>`，与 `snapshot` **同一拍子**。

**端口方法 `typeOf(clientModel): ModelType | null` 是同步的**，理由是硬的：
转发线程上一次 `await` 就是一次可观测的 TTFB 增量（验收 6）。
它与 `listEnabledModels` 的**读口径刻意不同**（后者实时读库，因为验收 4 要求
"改一个 `enabled` 后 `/v1/models` 立刻变"），这不是不一致而是分层：

- `typeOf` 是**转发路径的准入判据**，而快照就是选路判据（`UpstreamConfig.models` =
  "谁登记了谁才可能被选到"）。两者必须用**同一份**事实，否则闸口会与选路打架。
- 代价是 1s 窗口：窗口期内名字还没进快照 ⇒ `typeOf` 返回 `null` ⇒ **本闸放行**，
  而同一窗口里 `getAvailableKeys` 也建不出候选集 ⇒ 既有 503。
  也就是说**本闸永远不会拒掉一个路由器还能路由的名字** —— 它只可能"晚一秒才生效"，
  不会产生"列表里有、打过去 400"这种会骗人的信号（§19.6 那条纪律）。

### 2. 准入判在**路由层**，引擎**之前** —— 与三个既有门同一族

复用 ADR-0037 决策 4 的候选集三分析（逐条仍然成立）：

| 候选 | 否掉的理由 |
|---|---|
| **不在引擎** | `engine.forward()` 已经建好候选集、算过限流，在那里拒等于让"类别错"长得像"转发失败"（会记 attempts、可能烧 key 健康）。更硬的理由是**助手**：`wiring/assistant-invoker.ts` **直调引擎、不过路由层**，判在引擎等于把内部助手卷进判定（它的合成组该算什么类别？）；放在路由层，助手**天然豁免** —— 与它"不参与限流、零 usage 落库"同一条结构事实。**本版没有动 `engine.ts` 一行**，这一点由 grep 可验。 |
| **不在 key 池** | `getAvailableKeys(model)` 的签名是冻结件；且它管的是"哪把 key 可用"（**已经建了候选集**，太晚了）。 |
| **在路由层** | 与 `GROUP_DISABLED` / `MODEL_NOT_AUTHORIZED` / 限流是**同一类拒绝**：凭据/策略侧、**0 次真实尝试**、候选集根本不建、§10 的 0-attempt 判据原样成立（`failureReason: null`、不计 key 健康、不碰冷却）。`reportRejection` + `authedFacts` 就在旁边，事件（§12.1）与响应同源。 |

实现形状：`requireModelCategory(request, reply, model, endpoint, accepted)`，
**两个 handler 各调一次**（漏一个就是绕过，与授权门同一条纪律），位置与 `requireModelAuthorized` 同排
（`readModel` 之后、"body 其余部分"之前）。

### 3. 码选 `400 INVALID_REQUEST` + `param=model`，**零新增码**

`GATEWAY_ERROR_CODES` 12 → 12。

- **不用新码**：§10 表已是 12 条，而这一条完全落在 `INVALID_REQUEST` 的原义里 ——
  "你把这个名字用在了不服务它的端点上"是**参数错**。新码的信息增量是零，
  代价是动契约枚举、`observability-params.ts` 的分型、前端筛选器和三条断言（同 §10 对
  `NO_AVAILABLE_EGRESS` 与 `MODEL_NOT_AUTHORIZED` 的两次判断：**不新增分型**）。
- **`type` 取 `invalid_request_error` 而不是 `authentication_error`**：与 `MODEL_NOT_AUTHORIZED`
  正好相反的那一半 —— 调用方**确实写错了东西**（组没授权是"人不对"，类别不对是"参数不对"）。
- **`param=model`**：§10 表里 `INVALID_REQUEST` 的既有三个触发点（body 非对象、缺 `model`、
  缺 `messages`/`input`）都没带 `param`；本条带，因为排障需要立刻知道**是哪个字段用错了**。
- 文案必须**自解释**（报出登记类别与端点名）：
  ``model `gpt-4o` is registered as category `chat`, which `/v1/embeddings` does not serve (this endpoint serves `embedding` only); use a `embedding` model here``
  —— 只说"不支持"会让调用方回来问"那我该打哪个端点"。

### 4. 未登记的模型名，本闸**不表态**

`typeOf` 返回 `null` ⇒ 放行 ⇒ 照旧进引擎，由候选集给既有 `503 NO_AVAILABLE_KEY`。

**这是本决策里最容易做错的一格**：顺手把"未登记"也判成 400 看起来"更严"，
实际改变了另一条既有判据（存在性由引擎回答），并且会造出"路由器还能路由、路由版却 400"的怪状态。
本闸只回答**一个**问题：**这个登记过的类别，这个端点服不服务**。

### 5. `/v1/models` 每项加一格 `type`（非破坏）

准入按类别把关，就必须把类别**说出来**。不说 = 让调用方盲试端点（打错了收 400，
还得回来问"那我该打哪个"）。它的值来自**同一份 `models.type` 列**，与档案卡 `ModelDto.type`
同源。既有四字段（`id` / `object` / `created` / `owned_by`）零变更。

### 6. 门序：授权在类别之前

`组停用 → 限流 → 名字缺失 → 组授权 → 类别`

授权**先于**类别是刻意的：一个没被授权用这个模型的调用方，该拿到"没授权"（方向是"找人开权限"），
而不是"类别不对"（方向变成"换个模型名"—— 那是**错的建议**，因为换个 chat 名字打 embeddings
照样不通，而换个 embedding 名字他也没被授权）。

## 判据

### 单测（`src/gateway/model-category.spec.ts`，7 条）

| # | 判据 |
|---|---|
| 1 | embeddings 打 chat 类 → 400 + `INVALID_REQUEST` + `invalid_request_error` + `param=model`；文案含模型名、登记类别、端点名；**`seen.length === 0`** |
| 2 | chat 打 embedding 类 → 400 同形（**反向也要挡**，不是"只挡 embedding"） |
| 3 | 正向：两个端点各自的类别都放行，引擎**真的**收到请求（`seen.length === 2`） |
| 4 | 两个 handler 都要有这道闸：`image` 类在两个端点都被判 400 |
| 5 | **未登记**的名字照旧进引擎（`seen.length === 1`）—— 本闸不许把存在性也拒掉 |
| 6 | 门序：禁用组 → 403 `GROUP_DISABLED`；未授权 → 403 `MODEL_NOT_AUTHORIZED`（都不许被 400 顶掉） |
| 7 | `/v1/models` 照旧列出所有类别（读面不受准入影响） |

另加 `routes.spec.ts` 的 `/v1/models` 新字段断言（`type` 与档案逐项一致、三种类别都出得来）
与 `store.spec.ts` 的 `typeOf` 用例（走快照、未登记 `null`、停用即消失、与 `listEnabledModels` 同拍子）。

### 变异（四条，**全部必须红**）

| 变异 | 结果 |
|---|---|
| 拆掉 embeddings 那道闸（模拟"漏一个 handler"） | **红 2 条**（判据 1、4） |
| 把闸挪到 `engine.embeddings()` **调用之后**（模拟"判在引擎里"） | **红 2 条**（判据 1、4 —— `seen.length` 变成 1） |
| `requireModelCategory` 恒放行（模拟"catalog 没接上"） | **红 3 条**（判据 1、2、4 —— 反向那一条也红，证明两个方向都在判） |
| `listEnabledGatewayModels` 的 SELECT 漏掉 `m.type` | **红 1 条**（store 的 `typeOf` 用例） |

第三条变异有个副作用值得记：它**不会**让判据 5（未登记放行）变红 —— 因为那一格断言的是**放行**。
一个只会"恒拒"或只会"恒放"的实现无法同时满足判据 1/2/4 与判据 5，这正是那四条用例的设计目的。

## 手工验收记录（真实 LAN 实例，tierflow 上游）

实例：`/tmp/subtest/test.env`（`DB_PATH=./data/test-lan.db`），按 **PID** 重启（`pkill -f` 会误杀
全部实例，且 MASTER_KEY 只从进程 env 读、进程死透后凭据全废 —— 本仓的既有纪律）。
库里当时的三行档案：`TierSense` / `tierflow` / `tierflow_pro`，**全部 `type='chat'`**。

| # | 请求 | 改前 | 改后 |
|---|---|---|---|
| 1 | `POST /v1/embeddings` `model=tierflow_pro` | `404`（上游原文 `Invalid URL (POST /v1/embeddings)`）、`x-gateway-attempts: 1`、`usage_logs` +1 行 | **`400 INVALID_REQUEST`**、`param=model`、文案报出登记类别 `chat`、**无 `x-gateway-attempts` 头**、`usage_logs` **零新增行** |
| 2 | `POST /v1/chat/completions` `model=tierflow_pro` | 200/上游语义（chat 类走 chat 端点，本来就对） | 逐字不变（回归基线） |
| 3 | `GET /v1/models` | 三项，无 `type` | 三项，各带 `type: "chat"`；`capabilities` / `contextLength` / `endpointTypes`（仍 `null`）逐项不变 |
| 4 | `POST /v1/embeddings` `model=从未登记的名字` | `503 NO_AVAILABLE_KEY` | **逐字不变** —— 本闸不表态（决策 4 的现场证据） |
| 5 | `usage_logs`（`group_id=grp_206bfbafb970`）**逐次点查** | 改前基线 `COUNT(*) = 20` | 两次 400（11:55:22.412 / 12:03:43.903）与一次 503（11:55:30.592）**前后计数都不动**；只有真的出站了的那些调用（两次 chat 200、两次放行后的上游 404）各 +1 |
| 6 | 把 `tierflow_pro` 经 `PATCH /api/models/:id` **临时改成 `embedding`**，再打 `POST /v1/chat/completions` | （改前无此形状可测 —— `type` 根本不进服务路径） | **`400 INVALID_REQUEST`**、文案反向报出 `registered as category `embedding`, which `/v1/chat/completions` does not serve`、**无 `x-gateway-attempts` 头**；错误事件 `category=CLIENT_REQUEST, attempts=0` |
| 7 | 同一把 `embedding` 类别、改打 `POST /v1/embeddings` | — | **本闸放行**：`404` + **`x-gateway-attempts: 1`**（tierflow 确实没有向量模型），`usage_logs` +1 行 |

第 6/7 行合起来是**双向性**的现场证据，也是判据 2 与判据 3 的对应：同一个名字、同一份档案，
**换端点即翻转结论** —— 说明闸口判的是 `(端点, 类别)` 这一对，既不是"恒拒 embedding"
也不是"恒拒 tierflow_pro"。第 7 行同时钉住决策 4 的边界：放行之后**照旧由引擎回答**，
所以"放行"在真实上游上依然是那条老 404（**未登记与非本端点类别是两回事**，
本闸只回答后者）。验收后 `tierflow_pro` 已用 `PATCH` 复原成 `chat`（`revision` 5），
临时签发的那把 key 已删除（`DELETE /api/groups/:id/keys/:keyId` → 204），
库里该组仍只有 Bo 那把 `****9vYt`。

**这一格是本 ADR 存在的意义**：第 1 行那条 404 在改前既烧了一次真实上游尝试，
又在用量里被记成一次"正常调用"；改后它**在出站之前**就被拒，`requests` 不再虚高。

## 遗留（不粉饰）

1. **`image` / `audio` / `rerank` 三个类别仍然没有任何端点服务它们**：本版把
   `image` 类打两个服务端点判 400，而不是 501 —— 因为 400 说的是"类别不对"，
   501 说的是"这个端点没实现"。**两个都真，本条只回答前者**（`/v1/images/generations`
   仍然是 501，一个字没动）。这个重叠不合并：合并就得在路由层先做路径分类，
   而那正是 `setNotFoundHandler` 已经在做的事。
2. **`endpointTypes` 仍然恒 `null`**（ADR-0024 备选 C 的预留位）。它是**上游
   `supported_endpoint_types`** 的只读位，语义是**端点类型**不是**模型类别** —— 本版给它
   补了生产者的说法是**错的**，别把本 ADR 读成"那个缝终于补上了"。本版用的是 `models.type`。
3. **快照的 1s 窗口**（决策 1 的代价）：窗口内新登记的名字本闸不表态 ⇒ 退回旧行为
   （上游 404 透传 + 一次真实尝试）。窗口最长 1s，且**只影响"刚登记完立刻打错端点"**。
   要消掉它就得让 `typeOf` 实时查库，那会在转发线程上加一次 SQL —— 显式不做。
4. **同名跨上游仍是同一个答案**（`typeByName` 是 `Map<name, type>`，后写覆盖）：
   与 `modelsByUpstream` / ADR-0037 遗留 1 同一条粒度上限。同名档案类别不同时，
   闸口按最后一行判 —— 真出现这种部署，正确做法是让名字唯一，不是给闸口加优先级规则。
5. **一条只在本版被"缩窄"而没有被消除的风险**：若某个上游对**不支持的路径**回 403，
   `classifyUpstreamStatus` 判 `AUTH_INVALID` → `reportFailure` → key 冷却 → 连续失败自动停用。
   也就是说**调用方打错端点能打坏一池 key**。tierflow 回 404 所以没触发；准入闸把
   "类别已知的错用"从"整池"缩到零，但**未登记的名字**那条路仍然出站。§16.3 已登记该形状，
   本版**不改 `classify`**（拒绝的理由没变：未经证实的形状不改冻结判据），只把备注
   从"纯理论"改成"它的孪生形状已经触发过一次"。
6. **`type` 的推断仍然是名字正则**（`inferModelType`，`/embed/i` 等四条）：
   一个名字里不含这些词的向量模型会被登记成 `chat`，然后被本闸 400 挡住。
   这不是本版引入的问题，但本版让它**从"静默的 404"变成"显式的 400"** —— 也就是说，
   推断错的档案现在会**主动报错**，而管理面 `PATCH /api/models/:id` 正是修它的地方。
   本版**不做**"探测端点来自动定类别"（那是一次真实出站，是另一笔）。
