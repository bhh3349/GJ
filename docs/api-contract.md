# API 契约 v1.0-frozen

> 作者：管家 · 管理后端　｜　状态：**v1.0-frozen（PM 已核验冻结，见 ADR-0007）**　｜　当前版本：**v1.6.3**
> 本文件是**唯一接口事实源**。冻结后任何一方不得单方面改字段；改动走本文件 + `docs/adr/`。
> 覆盖范围：管理面 `/api/*`（REST + WS）。网关面 `/v1/*` 见 §10。
>
> **补遗 v1.0.1（2026-10-06，PM 已追认）**：§4 新增 `GET /api/groups/:id/keys`，并给 `reset` 的响应补上 `id`。动机与影响见 ADR-0008。
>
> **补遗 v1.0.2（2026-10-06）**：① §3 `POST /api/keys/:id/balance/refresh` 的响应补成 `202 {taskId}`（原文只写了用途、没写形状，而实现从第一天起就回 `202 {taskId}`，属于文本与实现的既存分歧，本次抹平）；② §5 新增「`POST /api/models/sync` 的字段映射」小节，把「只落能证明的、其余一律未知」写成明文规则；③ §5 补一句「同步不覆盖人工值」。除此之外 v1.0.1 全部内容不变 —— 无字段改名、无类型变更、无端点删除。动机与影响见 ADR-0009。
>
> **补遗 v1.0.3（2026-10-06）**：① §3 写明 `health` 等四个运行态字段的**来源与新鲜度**（网关进程 1s 批量镜像落 `key_runtime`，重启后归零），动机见 ADR-0010；② §6 新增「`costCents` 金额口径」小节 —— 契约此前**暴露**了 `costCents`（§4 Group、§6 usage 点）却从未**定义**它，未知单价该记 0 还是 null 无据可依；③ §10 把「无可用 key」与「候选用尽」两个 Terminating 结果拆开登记（`503 NO_AVAILABLE_KEY` ≠ `502 UPSTREAM_ERROR`，原文一句话把两者混在一起，与实现不符），并登记已在使用但未登记的 `504 UPSTREAM_TIMEOUT`。三处都是**文本对齐实现**，无字段改名、无类型变更、无端点增删。
>
> **勘误（2026-10-06，不升版）**：§7「关闭码」补登 **`1008`**（跨站 Origin 被拒）—— 服务端自 M4 起就发这个码，关闭码表漏登了这一行（路由者 M4 复核 P3 提出）。定性为**既有实现、文档补记**：无字段改名、无类型变更、无端点增删、**两侧实现零改动**（服务端已发 `1008`、前端 `live.ts` 已落 `default` 分支），同 v1.0.3 的 `504 UPSTREAM_TIMEOUT`，故**不 bump 版本**，留待下一次真正的字段/形状变更时统一升版。§7 另补「未登记码通则」一句，堵住"按码白名单实现"这个坑。
>
> **补遗 v1.0.4（2026-10-06）**：§10 错误码表按 **ADR-0011** 扩充两处**触发条件**（码值 / HTTP / `type` 全部不变）：① `RATE_LIMITED`(429) 增加「**网关池饱和**」触发路径（候选非空、0 次真实尝试、全候选并发已满），与用户组 RPM / TPM 超限共用码值；② `NO_AVAILABLE_KEY`(503) 增加「**候选存在但密文解不出**」的配置异常路径。同时写明 **429 一律带 `Retry-After`**，并明确「0 次真实尝试」**不得报 502**、不计入任何 key 的健康计数。无字段改名、无类型变更、无端点增删，`GATEWAY_ERROR_CODES` 无新增值。

> **补遗 v1.0.5（2026-10-06）**：M6-A「余额查询与展示」契约落地。① §2 Upstream 对象新增**只读**字段 `balancePreset`（内置 preset 命中情况，未命中为 `null`）；② §2/§3 新增两个**自测端点** `POST /api/upstreams/:id/balance-template/test`、`POST /api/keys/:id/test-balance`，共用一个 `BalanceTestResult` 响应体，**同步执行、绝不写库**；③ §2 新增「余额查询解析顺序与失败引导」小节，定义三段解析顺序（用户模板 → 内置 preset → `skipped`）、`hintCode` / `hint` 两个**非破坏**引导字段（**不进 `ERROR_CODES`、不影响 HTTP 状态**）；④ §6 `/api/stats/usage` 每个点补 `promptTokens` / `completionTokens` / `estimatedTokens` 三个非破坏字段（token 维度，不带钱）。无字段改名、无字段删除、无类型变更、`ERROR_CODES` 零新增，`balanceQuery` 模板契约**未改动**。动机与影响见 ADR-0012。

> **v1.1.0（2026-10-06，M6-B 接口阶段）**：新增 **§12 运维观测** —— ①网关**错误事件**结构化 schema（`GatewayErrorEvent`，落表 `gateway_error_events`）；②**健康指标**口径与 **60s 健康快照**（落表 `gateway_health_snapshots`）；③**四个只读查询端点** `/api/observability/*`（结构化 JSON、机器可读、支持时间窗 + 分型 + 分页过滤）；④**只读维护令牌** `READONLY_TOKEN`（独立于管理员会话、与 `ADMIN_TOKEN` 互斥、作用域仅 `/api/observability/*` 的 GET）。**新增 4 端点 / 2 表 / 1 令牌；无字段改名、无字段删除、无类型变更、`ERROR_CODES` 零新增、§10 网关错误码表零新增** —— 事件里的 `category` / `severity` 是**事件分类维度**（给机器分组用），不是错误码，不进 `ERROR_CODES`。版本号由补遗序列（v1.0.1–v1.0.5）升为 **v1.1.0**：本节开的是一个**新面**（新命名空间 + 新鉴权主体），与前面几版"文本对齐实现"不是同一档次。动机与影响见 ADR-0013。
>
> **勘误（2026-10-06，不升版）**：§12.1 的 `keyMasked` 一栏原写「无"那一把 key"可言时为 `null`」，与实现不符 —— sink 侧一律写 `****`（4 位掩码的退化形态，与 `usage_logs.key_masked` 同约定）；"没有哪把具体 key"这个事实由 `keyId` 为 `null` 承担，不由 `keyMasked` 为 `null` 承担。纯文本对齐实现：无字段改名、无类型变更、无端点增删。同批把 `docs/adr/0013` §7 的端口签名块按已落地的 `ErrorEventEntry` 订正（初稿的 `GatewayErrorEventInput` / `ts` / `model` 与实现不符）。§12 其余内容不变。

> **v1.1.1（2026-10-06，M6-B 接口阶段收口）**：补上**关联键 `x-request-id` 全链路透传**（冻结约束里早已写死、全仓尚未实现的那条缺口，PM 裁决"现在补、不留第二阶段"）。① §6 `GET /api/logs` 与 §12.1 `GatewayErrorEvent` 各新增**只读**字段 `requestId`（同键同值，`usage_logs` / `gateway_error_events` 各补一列），并新增同键精确匹配筛选位 `requestId`；② §6 新增「关联键 `x-request-id`」小节：入站缺失/非法/超长即重生成（白名单 `^[A-Za-z0-9._-]{8,64}$`）、响应头必回写、原样透传上游、落两表同值；③ §10 写明每个 `/v1/*` 请求都带该头（唯一的头侧新增要求）。**无字段改名、无字段删除、无类型变更、`ERROR_CODES` 零新增、§10 错误码表零新增** —— `requestId` 是**数据字段**（给"错误事件 ↔ 用量明细" join 用），不是错误码、不进 `ERROR_CODES`。动机与影响见 ADR-0014。

> **补遗 v1.1.2（2026-10-06，M6-B 接口阶段收口）**：登记网关已在用但 §10 漏登的 **`GROUP_DISABLED`(403)**（key 有效、用户组被禁用，`type=authentication_error`），并把 §12.1 的 `AUTH_FAILED` 分型从「仅 401」扩为「401 / 403」、对应码从「仅 `INVALID_API_KEY`」扩为「`INVALID_API_KEY` / `GROUP_DISABLED`」——由此网关对 403 组禁用**开始产事件**（此前宁缺不产）。同时把四条产出边界写进 §12.1：仅 `/v1/*`、未过鉴权 `model=null`、上游 4xx 透传不产事件、Fastify 413/415 等不产事件。**无字段改名、无字段删除、无类型变更、`ERROR_CODES` 零新增、`category` 枚举 9 值不变**（`GROUP_DISABLED` 归入既有 `AUTH_FAILED`，不新增分型）。动机与影响见 ADR-0013「落地补遗」。

> **v1.2.0（2026-10-06，M6-B 第二阶段）**：新增 **§13 内置 AI 助手聊天** —— ① `POST /api/assistant/chat`（SSE 流）端点；② SSE 帧契约（`delta` / `done` / `error` + 单调递增 `seq` + `done` 内联 `citations`，终止帧 `error.code` 复用 §10 码值）；③ 三重上限（`messages` 条数 24 / 单条 token 8000 / 总 token 16000 / 日志注入 50 条 × ≤24h，超限回 `done.truncated:true` 不静默截）；④ 鉴权走登录会话（§0.5），**不复用 `READONLY_TOKEN`**（§12.4 作用域之外自动 `403 FORBIDDEN`）；⑤ `GET /api/observability/health` 新增只读字段 `assistant`（助手独立计量：**计入 key 健康、不计入业务流量口径**）；⑥ SSE 失败终止帧 `error` 复用 **§10 码值**（`code` / `status` / 429 带 `retryAfterSec`）零新增枚举，`seq` 从 1 起、单请求内单调、重试重置；`truncated` 挂在 `done` 上（非独立帧）；`citations` 元素带可展示标签 `model` + `summary`；⑦ 助手与业务**同池同语义占上游并发槽位**、撞满即 429 `RATE_LIMITED`，断流走**同一条 signal 入口** abort 上游（引擎零新增分支）。**无字段改名、无字段删除、无类型变更、`ERROR_CODES` 零新增、§10 网关错误码表零新增、`SCHEMA_VERSION` 不变、零新表零迁移**（对话不落库、服务端无状态）。动机与影响见 ADR-0015。

> **v1.2.1（2026-10-07，M6-B 第二阶段收口）**：§13.4 把「槽位撞满」由一句简写（"撞满即 429 `RATE_LIMITED`"）改成**二分口径**：**全候选满并发**（`getAvailableKeys` 的 `isUsable` 已把满并发 key 过滤掉、候选集为空）是稳定出口 → **`503 NO_AVAILABLE_KEY`**；**429 `RATE_LIMITED`（"网关池饱和"）只出现在「选路返回 → `beginAttempt` 占位」的竞态窗口**，是偶发出口。给前端留一条硬要求：`429` 与 `503` 两条都要能落"稍后重试"分支。**§10 码表零新增、`ERROR_CODES` 零新增、无字段改名/删除/类型变更、帧契约与 `seq` 语义零变更** —— 本条是把 v1.2.0 的简写**订正为与实现一致**（§10 的「候选非空、0 次真实尝试、全候选并发已满」本来就是准的那一条），属文本对齐，不涉及两端代码改动。

> **v1.2.2（2026-10-07，M6-B 第二阶段收口）**：修正 `DELETE /api/upstreams/:id` 的**从属资源处置**（§2 / §11 C4）。原文（C4 裁决）要求 `force=true` 时「级联**软删** key + 硬删上游行」，但 `upstream_keys.upstream_id` 与 `models.upstream_id` 都是 `REFERENCES upstreams(id)` 且连接开了 `foreign_keys=ON` —— **软删不解除行级外键**，上游下只要还有一行 key（哪怕 `deletedAt` 已置）或一行模型档案，`DELETE FROM upstreams` 就被 SQLite 拒掉：实测 `500 INTERNAL`（`SQLITE_CONSTRAINT_FOREIGNKEY`，前端「上游管理」页的删除按钮在这条路上是死的）。本版改为：① `force!=true` 时**key 与模型一起**拦，`409 UPSTREAM_HAS_KEYS`，`details: {keyCount, modelCount}` —— **`modelCount` 是纯新增只读字段**，老客户端只读 `keyCount` 照常工作；② `force=true` 时按依赖序**物理删除整棵子树**（`key_runtime` → `upstream_keys` → `models` → `upstreams`，单事务），响应仍是 `204`。**`ERROR_CODES` 零新增、端点零增删、无字段改名 / 删除 / 类型变更、Upstream 对象零变化、`SCHEMA_VERSION` 不变、零迁移**。动机与影响见 ADR-0016（**修订 §11 C4 的 key 处置**）。
>
> **v1.3.0（2026-10-07，M6-C）**：新增 **§14 余额同步** —— ①**自动同步**：每上游独立节奏、基准 **15 分钟 ± 10% 抖动**、失败**指数退避**（`min(base×2^n, 6h)`）、同上游**单飞**；`BALANCE_SYNC_MINUTES=0` 关闭（手动三端点语义**零变更**）；②**NULL 口径**：查不到就**一个字都不写**（保留上次查得值**与它真实的查得时刻**，从未查到则仍为 `null`），**绝不补 0、绝不估算、绝不用旧值刷新时间戳**；③**快照与 `asOf`**：新表 `balance_snapshots`（无外键 + 上游名快照，ADR-0016 删上游后历史仍可读），新增**只读**端点 `GET /api/stats/balance/sync`（同步状态 + 带 `asOf` 的余额序列 + 漂移提示）；④**漂移提示**（非破坏）：`BALANCE_SPENT_WITHOUT_TRAFFIC` / `BALANCE_UNCHANGED_WITH_TRAFFIC` 两码，**只 warn + 计数**，不进 `ERROR_CODES`、不拦请求、不改任何数 —— **本地没有单价，所以漂移只能是方向级提示，不能判钱**。**无字段改名、无字段删除、无类型变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`SCHEMA_VERSION` 不变、零迁移、零新鉴权**；`§6 余额三口径` / `§2 §3 手动刷新` / `src/gateway/` **全部零改动**。★ 同批撤销「单价 × 用量的本地扣减账本」方案（原 0017 草案），理由见 ADR-0017「被撤销的上一版」。动机与影响见 ADR-0017；同批顺手补上文末版本索引漏记的 v1.2.1 之后各版（P3）。

> **v1.4.0（2026-10-07，M6-D 供应商账号面 / Bo 拍板冻结）**：新增 **§15 供应商账号面（TierFlow 专用）** 与 **§16 TierFlow 数据面接入约束**。① **账号是独立顶层资源**（`/api/supplier-accounts`，11 端点）——TierFlow 的管理凭据是「手机号 + 密码 + 会话 + uid」而**不是 sk-**，塞进 `upstream_keys` 会让网关把密码当 key 拿去转发（ADR-0018 决策 1）；② **批量新建 key 是唯一入池通路** —— 上游明文只出现一次、掩码不可逆，服务端取回后当场 aes-256-gcm 落库，**明文不经浏览器**，响应只回 `keyId` + `keyMasked`（决策 2）；③ **新增账号级余额口径（第四级）**：上游合计组成改为 `Σ账号 quota + Σ无账号归属 key balance`，防"一号多 key 把同一份钱数几遍"，**形状非破坏**（决策 3）；④ **套餐挂账号、不建成 key** —— 套餐余额是账号级的、套餐 key 只有掩码、且是 N 个不是 1 个，因此不引入 `category='token-plan'` 新行、不引入 `subscription_id`，前端表格两级（决策 7）；⑤ **新增 `upstream_keys.unlimited` 列** —— 无限额度 key 上游给的是 `remain_quota: -331119` 这种无意义负数，与 `balance_cents IS NULL`（已钉死为"未知"）同形会二选一错，加列后只改 `balanceUnknownKeyCount` 一处既有聚合（决策 8）；⑥ **凭据生命周期**（§15.9）：密码型走 HTTP 只进不回，**会话型只走操作员本机的一次性离线导入**（不经 HTTP、不进仓库/日志/聊天），入库即视为该文件作废；**只有会话没有密码的账号，会话过期后无法自动重登**，这是明示取舍；⑦ **金额口径**：本面货币字段一律 `…Cents`(int 分)，`quota_per_unit` 每次从上游读、**不写死**，`Math.round` 不截断；⑧ §2 非破坏新增 `supplier` / `accountCount` / `accountsBalance` / `accountsBalanceUnknownCount` / `keysBalance` / `unlimitedKeyCount` 六个字段与 `POST/PATCH /api/upstreams` 可选 `supplier`，§2 余额解析顺序由三段扩为**四段**（尾插账号型驱动，前两档判定逻辑不变），§3 `KeyDto` 非破坏新增 `unlimited`，§6 合计口径按 ③ 修订并补两条规则。**`ERROR_CODES` 新增 1 个**（`ACCOUNT_HAS_KEYS`(409)）—— 这是本契约自 v1.0 冻结以来**第一次**新增错误码枚举，故单列一笔；供应商自己的错误码（`LOGIN_INVALID_CREDENTIALS` 等）**不进** `ERROR_CODES`。**`SCHEMA_VERSION` 仍为 2**，但**必须真发 `ALTER`**（`CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作，加列走 `migrate()` 里 `hasColumn()` 守卫的 `ALTER TABLE`，照 `request_id` 那批）。**`/v1/*` 零变更**（数据面约束见 §16，其中"数据面路径是否为 OpenAI 兼容"是**实测待钉项**）。动机与影响见 ADR-0018；§15 与路由者/画师上轮"套餐建成 `token-plan` key"的写法**相反**，裁决理由见 §15.8 第 8 问。原草案文件 `docs/契约草案-v1.4.0-供应商账号面.md` 已并入 §15 并删除。

> **v1.4.1（2026-10-07，M6-D 拍板二拍）**：§15.1 非破坏新增 **`credentialSource`**（`"password"` \| `"session"`，回答"能不能自动重登"，前端不自行推断），§15.9 补**凭据双路径定位**（密码型 = 第一事实源、会话型 = 冷备/加速通道，两者并存不互斥）与**自动重登的触发、账号级互斥、节奏**，§15.3 收口 `action` 枚举的生产者。**无字段改名、无字段删除、无端点增删、`ERROR_CODES` 零新增、`/v1/*` 零变更**。动机与影响见 ADR-0018 决策 10。

> **v1.4.2（2026-10-07，TierFlow 接入面补遗）**：① §3 `KeyDto` 非破坏新增 **`models`**（模型白名单，`string[] \| null`；`null` 与空数组同为"不限"，**与网关冻结件 `matchesModel()` 的口径一致** —— 本契约不制造实现不了的三态），数据源为上游 `model_limits` CSV —— **本条修的是一处断链**：§16.3 早已把 CSV 映射到网关侧 `KeyConfig.models`，但**管理面没有任何一列承载它**（`KeyConfig.models` 在 `src/wiring/store.ts` 里至今硬编码 `null`），网关永远读不到值，白名单在实现上等于不存在；② §15.2 `keys` 入参新增**可选** `models`（建 key 时落库，上游回显优先，两边都没有则 `NULL`），并写明 `keys/sync` **不**回填该列（掩码撞号风险 > 少同步一次）；③ §5 `availableKeyIds` 口径**补齐生效白名单条件** —— 少这一条，档案卡「可用 key」与网关实跑会长期对不上，且没有任何报错可追；④ §15.7 加列 `upstream_keys.model_limits TEXT`，**可空无默认**（老行 `NULL` = 不限，与加列前逐字一致；空串/空 CSV 归一化为 `NULL`，不落 `''`）；⑤ §16.1.1 **新增悬空件登记**：数据面实测（P0–P4）的执行主体是**凭据持有者本人**，不是任何 AI 会话，附产物 / 回执 / 兜底口径；⑥ §16.5 三项 S1 字段依赖对账。**无字段改名、无字段删除、无端点增删、`ERROR_CODES` 零新增、`/v1/*` 零变更、`KeyConfig` / `KeyPool` 签名零改动、`SCHEMA_VERSION` 仍为 2 但必须真发 `ALTER`**（`src/wiring/store.ts` 有一行**取值**改动待路由者确认：`models: null` → 读该列，**不是签名变更**）。动机与影响见 ADR-0019。

> **v1.4.3（2026-10-07，M6-D 探测面）**：① §16.1.1 **执行主体改锚** —— 把「谁持凭据」与「谁敲命令」拆开：凭据**只**由持有者运行时注入（`PROBE_KEY` / `PROBE_MODEL`），敲命令可以是持有者本人，也可以是他**明示指定的执行会话**（含 AI 会话）；代跑**不放松 §15.9 纪律 2**，账号密码 / 会话值仍不进 AI 上下文。② 新增 **§16.6 S4 验收锚定**（执行链三步 + 三项 S1 占位值表），其中「数据面路径与协议」**明确不落 DTO** —— 给通用 `Upstream` 加一个供应商专用字段，就是拿个例往通用层开口子（ADR-0018 决策 0）。**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增。** 见 ADR-0018 决策 11。
>
> （**本条为补记（2026-10-07）**：v1.4.3 冻版当时只改了正文与版本号、**漏写本变更块**，索引里却已经记了 v1.4.3 —— 补记正文未改任何内容。记在这里是因为"版本索引有、变更块没有"正是下游按版本号自检时最容易踩空的一处。）

> **v1.4.4（2026-10-07，出口级限流）**：新增 **§16.7 出口级（IP 级）限流** —— Bo 报回上游 `too many requests from your client ip`。① 定性：这是**第三层**限流（按来源 IP 计数），§16.4 只写了上游级 / 账号级两层，而 TierFlow 是「1 个出口 IP + 27 个账号 + 全部 key」，**所有 key 共命运**；② **取证**：当前实现下 IP 级 429 会被 `classify.ts:18` 判成普通 `RATE_LIMITED`、由 `engine.ts:399` 记在**当时那把 key** 头上、按 `cooldown.ts:56` 起步 60s 并升档至 30min，而池是**严格 key 级**（`key-pool.ts:30` 无出口级状态）—— 于是"换 key 重试"在出口不变的前提下**必然再撞**，一个客户端请求内即可逐把冷掉候选 key，**上游给的一下被轮换放大成全池 30 分钟不可用**；③ **归因纪律**：IP 级 429 **不计入任何 key 健康**（同 §10「0 次真实尝试不计 key 健康」），冷却对象由 key **上移到出口**（本期 = `upstream.host`），冷却期内**不换 key、径直回 `429 RATE_LIMITED` + `Retry-After`**；④ **处置三档**：Tier 1 出口级短冷却（仅需响应证据）/ Tier 1.5 出口级令牌桶 / Tier 2 出口 IP 池（需 Bo 拍代理资源，届时新表 `egress_proxies` + `supplier_accounts.egress_id` 可空，非破坏）；⑤ **识别规则不写死** —— 只有一句 message 文本，按悬空件登记，需响应体/响应头与退避时长；⑥ §15.5「0.6s 未触发限流」那条**依据降级**（值不变）—— 0.6s 是每账号口径，对按 IP 计数的限流不成立。**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 对外行为零变更、`SCHEMA_VERSION` 不变**（Tier 1/1.5 是网关内核改动，Tier 2 未拍）。动机与影响见 ADR-0020。

> **v1.4.5（2026-10-07，落地面收口 —— 路由者两问的答复）**：① §15.7 补一条**落库规则**：`unlimited = 1` ⇒ `balance_cents` **必须落 `NULL`** —— 上游对无限额度 key 回的是 `{unlimited_quota: true, remain_quota: -331119}`，那个负数是**无意义占位**、不是"欠费"；落进去就成了一把"已欠费"的 key，而网关可用性过滤是 `balance_cents <= 0 → 排除`，于是它被**静默排除出选路**：不报错、不告警、不进冷却，客户端只看到「没有可用 key」。同时写明**网关不消费 `unlimited`**（`KeyConfig` 无此字段），落 `NULL` 则走既有的「未知 ≠ 0、仍可用」分支，路由者「零改动」成立。② §16.3 该行按 ① 改写；并把「白名单还差一行」的**量词改准** —— 是 **4 处 + 1 个 spec**（`KEYS_SQL` 选列 / `KeyRow` 加列 / 解析函数 / `store.ts` 取值），不是一行。③ **同批落地**：`src/db/schema.ts` 落 §15.7 三列（`upstreams.supplier`、`upstream_keys.unlimited`、`upstream_keys.model_limits`）的 `hasColumn()` 守卫 `ALTER`，并补 `src/db/schema.spec.ts` 的老库升版判据（新库自带 / 老库真被 ALTER / 重复 migrate 不抛 `duplicate column name`）。④ 补记 v1.4.3 漏写的变更块（正文未改）。**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2。**

> **v1.4.6（2026-10-07，白名单口径裁定 —— 路由者 §16.3 三条的答复）**：路由者就 §16.3「key 映射 1:1」报回三条不一致，逐条读码 + 读契约核实，结论是**一条是本契约早已登记的缺口、两条不成立**，无一条是方向性缺陷：① **(a) 成立，但非新发现** —— `src/wiring/store.ts` 至今硬编码 `models: null`、`KEYS_SQL` 不选 `model_limits`，与 §16.3 已写的「还差 4 处 + 1 个 spec」逐字对上，是**待落的既有账**；② **(b) 不成立 —— 本契约从未把 `[]` 定义为「全禁」**（本段是首次引入该词，仅用于记录该误读；裁定落笔前全篇无此表述）：§3 / §5 / §15.2 / §16.5 四处一致写「`[]` 与 `null` 同义 = 不限」，且 §3 明写这是**刻意对齐冻结件 `matchesModel()`**（"本契约不制造一个实现不了的三态"）；实现（`key-pool.ts` `length === 0 → true`）与契约**同向**，非反向；③ **(c) 随之不成立** —— `keyModels()` 空 → 继承 upstream，正是 §5 写明的既有口径，且继承 upstream 后再 `matchesModel` 等价于不限（upstream 清单即全集）；④ **新增一条真正的悬空项**（这条提问的价值所在）：上游 `model_limits_enabled=true` + **空 CSV** 在 TierFlow 侧究竟意为「全禁」还是「不限」—— 我们现一律归一化为 `NULL`(=不限)，若上游实为「全禁」，这就是一条**静默放流**；已并入 §15.2 的 §16.1 待实测块，实测前维持 `NULL`。⑤ 裁定：**§16.3 白名单本期做**（§16.5 行 3 早已写「不等实测，S2 直接落」）—— 4 处 + 1 spec 立即可落，前置 DDL（`upstream_keys.model_limits`）已落。**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2。**
>
> **v1.4.7（2026-10-07，落地面可达性收口 —— 路由者 §16.3 两问的答复）**：① **`unlimited` 那行本版无新增** —— 路由者报回的病灶（`KeyConfig` 无该字段、`isUsable` 对 `balance_cents <= 0` 判否 → **静默排除出选路**）与 v1.4.5 已写的 §15.7 落库规则**逐字同向**；三处落点（§15.7 规则 / §16.3 该行 / `src/db/schema.ts` 列注释）v1.4.5 均已齐，故**本版不改这一行**。② **§16.3 补一条拓扑中立纪律**：那批 DDL 的 **canonical 落点只有一处**，就是 `src/db/schema.ts` 里 §15.7 的 `hasColumn()` 守卫 `ALTER`（v1.4.5）；**任何车道要消费 `model_limits` 而基线早于这批 `ALTER` 时，按路径取件把它搬到自己的基线上，不得派生第二份 `schema.ts`** —— 两份同名文件各自演化比"等一次取件"贵得多，且它的崩法（`no such column`）只在开库时才露面。③ **§16.5 两处文本订正**：残留的「网关侧还差一行」改回与 §16.3 一致的 **4 处 + 1 个 spec**（v1.4.5 订正了 §16.3，§16.5 漏改，同一事实两处不一致）；「另两项不需要等任何人」限定为**契约层**成立、**落地层第三项仍须先有一次 DDL**（前置 v1.4.5 已满足，取件归车道）。**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2。**

> **v1.4.8（2026-10-07，出口级三条收口 —— 路由者 §16.7 两问的答复）**：① **裁定 §16.7 两处悬空件**（路由者原话"我不按文案猜、不在契约未定前接线"，这个纪律是对的）：**(一) 识别规则本期哪条都不启用** —— 把纯自证据路径登记为**世界 (c)**（同出口第 2 把不同 key 亦 429），代价写明（确认前第一把 key 仍被记过，受害者 27→1），启用需 (i) Bo 的原始响应到手按 (a)/(b) 落，或 (ii) PM/Bo **明示放行** (c)；**(二) 出口冷却适用 60s 地板** —— 把「尊重 `Retry-After`」读作「不短于它」，即 **出口冷却 = `max(Retry-After, 60s)`**，无该头则 60s 起、封顶 30min、阶梯同 key 级；此前的文字只写"尊重"没写地板，是**本契约漏写、不是实现偏差**，故路由者的实现保持不动。② **一条必须说穿的后果**：识别器默认关闭期间 **Tier 1 是"缝"不是"修"** —— 运行时行为与改动前**逐字节相同**，"IP 级 429 被轮换放大成 30min 全池故障"这条**自伤回路尚未被掐断**；公告与回执**不得**写成"自伤回路已掐断"。③ **新增 §7 实时通道帧 `egress_cooldown`**（`egressId` / `cooldownUntil` / `reason`）—— 出口冷却的**唯一读面**，**不新增 HTTP 端点、§14 端点侧不加字段**；`egressId` 定为**不透明字符串**（本期 = 出口 host，Tier 2 后 = `egress_proxies.id`），前端不得解析其内容，否则 Tier 2 一落地就变成一次前端改造。④ **§15.5 依据降级在源头收口**：表内那行"工作台 29 号跑下来未触发限流"改为**划删 + 指向 §16.7**（v1.4.4 只在本节 §16.7 写了降级，**§15.5 表内没改**，同一事实两处不一致——与 v1.4.7 修的 §16.5 是同一类残留）；§15.9 / §16.4 两处 0.6s 引用补出口级指引。⑤ **Tier 1.5 口径本期定死、数值占位**：§15.5 口径改为**「同一出口共用一条速率」**，作用域（刷新 / 建 key / 重登 / 探活 / 数据面）现在锁死，**数值等实测退避时长**。⑥ **Tier 2 订正本节旧文"若做"**：DDL 已进 `src/db/schema.ts`（`egress_proxies` + `supplier_accounts.egress_id` 可空），并写死三条绑定纪律 —— **绑定粒度 = 账号级非 key 级**、**每出口账号数上限 = 6（占位，待标定回填）**、**`egress_id` 不进任何 DTO**。**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2（Tier 2 那两张表/列在 v1.4.4 之后的 `001ae15` 已落）。**

> **v1.4.9（2026-10-07，出口级读面本期状态的裁定 —— 画师「本期暴露不暴露」的答复）**：① **裁定：本期不暴露（对管理面不可观测），但形状已冻结。** 画师给的是一道二选一（暴露 → 给读面落点；不暴露 → 契约写死"不可观测、前端不得推断"）。**答案落在第二支**，但要说清它为什么不等于"漏"：读面**有**（§7 `egress_cooldown` 帧，v1.4.8 已冻结字段名与形状），**只是本期发不出来** —— 两个原因各自独立成立：**(一) 触发条件未启用**：该帧由出口冷却置起，而识别器默认 `neverEgressLimited`（恒 `false`，§16.7 裁定 ①）⇒ **冷却不会被置起**，帧无从来；**(二) 发帧实现未落**：`src/api/routes/live.ts` 零 egress 代码（`key_health` / `balance` / `task` 三条帧已落，这条没有）。② **三条硬约束进 §7**：**前端不得接线**（对着不来的帧写渲染 = 渲染一个不会发生的事件）、**不得把"未收到该帧"当作"出口健康"**（本期没有任何字段能证明出口正常，**缺省不是证据** —— 否则用户会把一片绿的面板当 bug 报给前端，而根因是契约没写这一句）、**不得从 `429` / `Retry-After` / 日志反推**（既有纪律，此处重申）。③ **接入点写死为接线层注入**：`src/api` 不可直连网关内部（AGENTS.md §8），出口状态须经 `src/server.ts` 注入，形状与 `ApiContext.assistant` 同一套（缺省 = 明确的"未接线"）；生产者是路由者 `src/gateway/egress.ts`，**管家侧发帧 + 路由者侧生产者，两侧都到位才有帧**。④ **给出可自检信号**（免去第四个人再问一遍）：发帧面 `git grep -c egress dev/api -- src/api/routes/live.ts`（今天 0）、触发面 `git grep -n neverEgressLimited dev/gateway-rotation -- src/gateway/`（今天有命中）。**同步进 §16.7 裁定 ①**（同一裁定的第二个后果，两处一致）。**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 本版纯文档，零代码。**

> **v1.4.10（2026-10-07，`egress_cooldown` 帧**投递语义**收口 —— 画师「刷新 / 重连拿不到初始态」的答复）**：① **缺口成立，且是 v1.4.8 自己写出来的**：那句「开始 / 变更 / 解除时**立即**推（不等到下一帧）」是从 `key_health` 抄的 —— 而 `key_health` 有兜底、本帧没有（本帧被 §7 自己定为**唯一读面**且**不走 REST**）⇒ 照字面实现就是**纯事件推**，**刷新 / 重连拿不到"此刻正在冷却"**，前端会把「全部 key 暂停路由」渲染成正常（最长 30min），且它被禁止从 `429` / `Retry-After` / 日志反推，**没有任何合规自纠手段**。② **裁定：改为随 §7 每 tick 差分帧下发**（`id: egress:${egressId}`、`sig` 必带 `cooldownUntil`；每 tick 走 `buildTickFrames` / `pushIfChanged`），新客户端 `seen` 为空 ⇒ **首 tick 自然全量**，基线由此成立；冷却自然到期时 `sig` 变 ⇒ 照样推 `cooldownUntil: null`。与 `key_health` / `balance` / `task` **同列**，**零新增端点、零帧形状变更**；代价写明：冷却开始到可见**最多晚一个 tick（1s）**。③ **一条证据订正进 §7**：`key_health` 的基线**不是**由 `metrics` 帧承担（`live.ts` 的 `metrics` 帧只带数字与全量余额，**不带 `keyHealth[]`**；带 `keyHealth[]` 的是 REST 的 §6 `/api/stats/overview`），而是它与本帧同款的**差分帧首 tick 全量**；`balance` 的 REST 兜底在 `live.ts` 注释里写明 —— 记住错的那半边，下一个人会照样设计出没有基线的帧。④ **自检信号由两个增为三个**（新增**差分帧注册面** `git grep -c 'egress:' dev/api -- src/api/routes/live.ts`，今天 0）：只非 0 发帧面 = 帧发了但不带基线，**正是本次要堵的形状**。⑤ **本条不改变「本期不发射」**（v1.4.9 原样有效）：投递语义是**接线后**的行为，本期仍零 egress 代码、三条硬约束（不得接线 / 缺省不是证据 / 不得反推）一条不减。**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码。**

> **v1.4.11（2026-10-07，`egress_cooldown` 生产者形态收口 —— 画师接线提醒的答复）**：① **一处措辞歧义收口，无语义变更**：v1.4.8 / v1.4.10 把生产者写成「网关的**出口冷却表**」，"表"字会被读成**一张库表**，接线时按它去查库就发不出帧。实测订正为**进程内注册表**：`src/gateway/egress.ts` 的 `createEgressCooldown()` 内部是 `const state = new Map<string, EgressState>()`（`egress.ts:88`），**出口冷却不落库、重启归零**，经 `stack.ts` 装配注入（`stack.ts:52 egress?: EgressCooldown` / `:87`）。② **同批写死一条实现约束**：发帧**必须在同一进程内读那个被注入的实例、不查库** —— 跨进程读不到它，这条帧根本发不出来。③ **接线是"三处"不是"两处"**（v1.4.10 只写了 `buildTickFrames` / `pushIfChanged` 两处，漏了第三处）：除造帧、推帧外，**还必须把 `egress:${egressId}` 注册进 `tickNow` 的 `live` 集合**（`live.ts:321-324`）。漏了它，`seen` 里这条每 tick 被清（`live.ts:359-361`），帧**每秒重发**（不谎报，但白推）—— 与"指纹必带 `cooldownUntil`"是同一类"不写下来就会踩"的坑。④ **零变更面**：帧字段名 / 形状 / 投递语义（v1.4.10 差分帧 + 首 tick 全量）、三条硬约束、三个自检信号、v1.4.9「本期不发射」的结论**全部不动**；**无字段改名、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码。**

> **v1.5.0（2026-10-07，`egress_cooldown` 读面与 `reason` 两处收口 —— 路由者「`snapshot()` 放行 + `reason` 定或删」的答复）**：① **放行一次纯增量只读读面**：`EgressCooldown` 加 `snapshot(): readonly { host: string; untilMs: number }[]` —— 只读、**不产生状态**（与 `isCooling` / `remainingMs` 同族），**签名只增不改**，`KeyPool` / `KeyConfig` / engine 零改动。**理由不是"顺手加的"**：v1.4.10 把 `sig` 钉成必带 `cooldownUntil`，却**从未查过生产者供不供得出它** —— 实测只有 `isCooling(host)` / `remainingMs(host)`（**两个都要先知道 host**；`const state` 在闭包内、`EgressState` 未导出），且**没有 `until` 的读口**（只有 `cool()` 的返回值）⇒ 这是**已冻结语义的缺件**，不是新功能。② **两条语义钉死**（都不是风格问题）：**(a) `untilMs` 是绝对时刻、不是剩余量** —— 发帧侧**不得**用 `now() + remainingMs()` 反算，否则结果每 tick 都变 ⇒ `sig` 永远"变了" ⇒ **每 tick 白推**；真实 `until` 在冷却期内是常量，「自然到期」才表现为一次跳变（推 `cooldownUntil: null`）。**(b) 快照是全量**（该出口层**记录过的全部出口**），**不是"只在冷却期内的"** —— `live.ts` 的差分通道**没有墓碑**：一个 id 从本 tick 集合消失，只是被从 `seen` 删掉（`live.ts:359-361`）、**不发任何帧** ⇒ 只报"正在冷却的出口"的话，**解除帧永不发出**，前端永远停在「出口限流中」—— 正是 v1.4.10 要堵的形状。**推论（生产者纪律）**：冷却层**不得为省内存 prune 已过期条目**（要 prune 得先给差分通道加墓碑，那是另一笔）。③ **`reason` 字段删除**：`EgressCooldown` 只有**一个**变更入口 `cool(host, retryAfterMs?)`，其 `reason` **硬编码为 `RATE_LIMITED`**、`EgressState = {consecutive, until}` **不存它** ⇒ 该字段在本帧里是**常量，不是状态**；而**常量字段比没有字段更贵**（前端照着写一个恒真分支，信息量为零）。且本帧**从未发射过、零消费者**（三个自检信号全 0），**删除在此刻是免费的** —— 首发之后再删就变成一次前端改造。将来若真出现第二种出口级冷却成因，**同批把字段与生产者一起加回**（**禁止先加字段、后补生产者**）。④ **不改变 v1.4.9「本期不发射」**：以上都是**接线前的前置件**，识别器仍关着、帧仍不发射、三条硬约束一条不减；且**不阻塞本周期**（帧本来就发不出来）。**本版是 §7 帧的首次字段删除**（`reason`），故升 **v1.5.0**：**无端点增删、无其他字段改名、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码。**

> **v1.5.1（2026-10-07，S1 冻结稿 —— PM 派单「§15 冻结 + 四补遗」的答复）**：本版**不新增任何字段、不新增端点**，只把 S1 冻结的口径逐条落到正文。**先订正三处锚点**，因为其中两处会让派单说反话：**(一) ① 双路径凭据口径与 ② 账号级余额口径早已冻结**（① `v1.4.0` 决策 9 + `v1.4.1` 决策 10 已落 §15.9；② `v1.4.0` 已落 §15.6 与 §6 规则 1/2/5）—— 本次不是"新写"，是**补一张索引让它们可被找到**；**(二) 「解析顺序尾插账号型驱动」不在 §14、且早已落**（`v1.4.0` 已落 **§2**「余额查询解析顺序」；§15.6 末行自己就写着"该段在 §2，不在 §14"）—— **§14 本次零改动**；**(三) 「会话导入」的载体文件名不进契约正文**（§15.9 纪律 1 明写路径由运行时环境变量给出、**不写进文档正文**）—— 写进去等于给"去哪找那份会话"留索引，**本次不写**。**本版实际补的是两处真缺口**：① **§15.10 新增「Python 工作台退役与数据迁移口径」** —— ADR-0018 决策 6 早有该结论，但**§15 正文从头到尾没有它**（此前只有 §15.3 / §15.5 两处顺带提及），正文缺一条就得靠人去翻 ADR，正是本车道反复出现的"ADR 有、契约没有"；写明工作台退役、**`workbench.db` 不迁**、账号靠 §15.2 `import` 重建、**旧 29 把掩码 key 作废不回捞**（掩码不可逆，ADR-0018 决策 2）而统一重建成新 key、批量建 key 不独立移植而作为供应商内建能力（**不新增端点、不新增任务类型**）；② **§2 补「通用模板不加换算字段」**（`scale` / `quota_per_unit` 之类）**+ §6 补规则 6「无限与未知分列」**、**§15.11 新增 S1 冻结索引表**（八项逐条给出正文落点与状态）。**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码。**

> **v1.6.0（2026-10-07，S2 落地收口的契约订正 —— 代码已落 `dev/api @ e76a2d6`）**：S2 起服务端实现时，§15 冻结稿里有**三处"声明与代码对不上"**被逐条撞出来，本版把它们订正到与已落代码一致。**三处都不是"新决定"，是冻结稿写下的那句描述本身不成立**：
> ① **§15.6「本次唯一动的既有聚合就是 `balanceUnknownKeyCount` 加一个条件」不成立** —— 漏了一个**推导值**：§14.3 快照点的 `knownKeyCount` 不是独立查出来的，它是 `balanceKeyCount - balanceUnknownKeyCount`，**正是从那一处改动里算出来的**。无限额度 key 一旦不再计入未知，这个减法就把它们**反过来数成"已知"**。故实际动了**两处**既有聚合，并连带**加一列** `balance_snapshots.unlimited_key_count`（老表加列，随 §15.7 同批 `ALTER`）—— 不加这一列，快照点 `known + unknown ≠ balanceKeyCount`，且**没有任何一格能解释少掉的那几把 key**。§15.6 同时补上不变量的**互斥**写法（各计数必须来自 `balance_cents` / `unlimited` 两列上的互斥 `CASE`，**不得用减法凑**）。
> ② **§15.2 `DELETE` 的「解绑（`account_id` 置 `NULL`）」指的列不存在** —— `upstream_keys.account_id` 在任何 DDL 里都没有，`ALTER` 批里也没有。归属关系**本来就**由 `supplier_account_keys.pooled_key_id` 这条台账表达（`keys/sync` 写它、§15.1 `keyCount` 从它数出来、第四口径的 `Σ无账号归属 key` 也按它算）。**刻意不给 `upstream_keys` 补这一列**：那等于给同一个事实造**第二个事实源**，两者迟早漂成不一致，而漂的那一刻没有任何东西会报错。**同批写死一个陷阱**：`ACCOUNT_HAS_KEYS` 的 `keyCount` **必须 JOIN `upstream_keys` 回来数、不能数台账行** —— 加台账行没有外键，`deleteUpstream`（ADR-0016）物理删 key 时**不动**台账，那批行会变成悬空引用；照台账行数的话，删过一次上游的账号将**永远删不掉**（弹窗警告"连带 N 把 key 解绑"，而那 N 把早已不存在）。§15.1 的 `countsFor()` 已是这个口径。
> ③ **§14 快照点不是"零改动"，§6 `keys[]` / `keysBalance` 的集合同一性此前没成文，`currency` 则漏查了一张表** —— 两处补成文：**§6 规则 7**（`keys[]` 与 `keysBalance` 取**同一集合**、只列**无账号归属**的 key、每条带 `unlimited`；**未知 key 仍在列表里**，否则未知从"可见的空白"变成"不存在"）；**§6 规则 8**（`currency` 的取值集合跟着**贡献方**走，判据与金额那一格**逐字对齐**）。规则 8 落在一个真缺口上：`supplier_accounts.balance_currency` **是存在的**，而老口径只查 `upstream_keys` ⇒ 钱**全在账号上**的 TierFlow 上游恒回 `currency: null` —— 账号行里明明躺着 `'CNY'`。那不是"诚实的未知"，是漏查一张表，**而且偏偏发生在钱最多的那条上游上**；反过来，归属出去的 key 若把币种混进来，一把"账号已代表其余额"的 key 能把单币种上游**凭空判成混币**。
> **同批补全示例**：§6 `overview` / `balance` 两个响应的 `byUpstream[]` 补齐五个 v1.4.0 已登记但示例里漏写的字段；**并修一处真错** —— `§6` 的 `keys[]` 条目示例把 `balanceUnknownKeyCount` 写进了 key 条目（该字段从来不属于 per-key 条目，同位置应为 `unlimited`）。**无字段改名、无字段删除、无端点增删、`ERROR_CODES` 零新增**（`ACCOUNT_HAS_KEYS` 在 v1.4.0 已登记，其代码侧落地随 §15.2 `DELETE` 端点实现提交）、**`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更**；**`SCHEMA_VERSION` 仍为 2**，但**必须真发 `ALTER`**（`balance_snapshots.unlimited_key_count` 是给 v1.3.0 就建好的老表加列）。唯一 DDL 新增就是这一列。

> **v1.6.1（2026-10-07，S2「账号面 Tier A」落地 —— 三条本地端点实现收口）**：S2 除已落的 §15.1/§15.6 聚合外，本期再落**三条不打上游管理接口**的端点（`GET /subscriptions`、`GET /export`、`DELETE /:id`，代码落于 `dev/api`）。冻结稿对这些路径**给了端点名与用途、没给形状与机械细节**，本版把实现时被强制决定的那些逐条写死 —— 全部是**补白**，无一处推翻既有口径：
> ① **§15.2 新增「扁平套餐列表的响应形状与排序」** —— 此前表里只有一行路径，没说它是 `Page<…>`、也没说每行带不带归属。写死：`Page<SupplierSubscriptionRowDto>`，每行 = §15.1 的 `SupplierSubscriptionDto` **加三个归属字段**（`accountId` / `accountIdentifier`（**掩码**）/ `upstreamId`），排序 `end_at ASC` + **`NULL` 排最后** + `sub_no` / `id` 兜底全序。**归属字段是这个端点存在的理由**：跨账号的扁平列表里，一个没有主语的 `subNo` 对不了账。
> ② **§15.2 `export` 补「机械形状」** —— 列序**首位补 `upstreamId`**（§15.2 原文的列清单没有它，而不带 `upstreamId` 过滤时，导出的表里没有任何一列能说明"这行是哪个上游的账号"，对账时分不出归属）；并写死 `Content-Type: text/csv; charset=utf-8`、`Content-Disposition` 文件名 `supplier-accounts-YYYYMMDD.csv`（UTC 日期）、**UTF-8 BOM**（无 BOM 时 Windows Excel 按 GBK 解，打开即乱码，会被当成数据损坏去查后端）、CRLF 行尾、RFC 4180 引号规则、以及**公式注入防护**（见 §15.2）。**导出不分页**：对账表分页导出**就是错的**（拿到的"账号总数"取决于点第几页）。
> ③ **审计动作名补登两个 + 一条例外成文** —— §15.7 原登记四个批量端点，本版补 `supplier.export` 与 `supplier.account.delete`（`detail` 一律**只放计数 / 标志**，不放 identifier 列表）。**`export` 是 GET 却写审计，这是刻意的**：§6 的"登录 / 登出 / 所有写操作"是**下限不是上限**，而批量导出是账号面上唯一一次"把全部账号清单一次性带出后端"的动作 —— 不留痕的话，"谁在什么时候导过名单"事后完全不可查，而这是最该可查的那一件事。
> ④ **§15.2 `DELETE` 补响应码与审计**：成功 `204`（无响应体）、被拦 `409 ACCOUNT_HAS_KEYS`（**拦下时零副作用、不写成功审计** —— 审计里有一条 `ok` 会让人以为删成了）；成功时 `detail` 为 `force`（非 `force` 删除为 `null`）。
> **同批成文一条依赖**：`export` 的 `subscriptionEndAt` = 该账号所有套餐 **`end_at` 的最大值**（取最晚 = "被接续覆盖到什么时候"，取中间值会让已续过的账号看起来快到期），全为 `NULL` 时空单元格（**不是 `0`**）；其实现依赖 `end_at` 已是 ISO8601 UTC（§15.1），**归一化责任在写入侧**（导入路径），读侧不猜上游格式。
> **无字段改名、无字段删除、无端点增删、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、**零 DDL 改动**（`ACCOUNT_HAS_KEYS` 与其 409 映射随本批落地）。**

---

## 0. 通用约定

### 0.1 两套错误体，不许混

| 面 | 路径 | 成功 | 失败 |
|---|---|---|---|
| 管理面 | `/api/*` | 资源本体 | `{ code, message, details? }` |
| 网关面 | `/v1/*` | OpenAI 形状 | `{ error: { message, type, code } }` |

### 0.2 类型口径（强制）

| 概念 | 类型 | 说明 |
|---|---|---|
| 金额 | `int`，单位**分** | 永久禁止 float 存钱。拿不到就是 `null`，**不是 0** |
| token | `int` | 永远是整数，不出现 `1234.5` |
| 时间 | `string` ISO8601 **UTC** | `2026-10-06T12:00:00.000Z`。不带时区的时间串视为非法 |
| id | `string` | 不透明，前端不得解析 |
| 布尔 | `true/false` | 不用 `0/1` |

### 0.3 分页（所有列表统一）

请求：`?page=1&pageSize=20`　（`page` 从 1 起；`pageSize` 默认 20，**上限 200**，超限返回 400 `INVALID_PARAM`）

响应：
```json
{ "items": [], "total": 137, "page": 1, "pageSize": 20 }
```

`items` 为空是**合法**响应（空态），不是错误。前端不得因此显示错误态。

### 0.4 错误码总表

| code | HTTP | 含义 | 前端动作 |
|---|---|---|---|
| `INVALID_PARAM` | 400 | 参数校验失败，`details.field` 指明字段 | 表单标红 |
| `UNAUTHORIZED` | 401 | 未登录 | 跳登录 |
| `SESSION_EXPIRED` | 401 | 会话过期/被踢 | 跳登录 |
| `INVALID_CREDENTIALS` | 401 | 账号密码错 | 提示，清空密码 |
| `CSRF_REJECTED` | 403 | CSRF 校验未过 | 提示刷新重试 |
| `FORBIDDEN` | 403 | 已登录但无权 | 提示 |
| `NOT_FOUND` | 404 | 资源不存在 | 提示 + 返回列表 |
| `CONFLICT` | 409 | 唯一约束冲突（重名等） | 表单标红 |
| `REVISION_MISMATCH` | 409 | 乐观锁版本不符（并发编辑） | 提示"已被他人修改"，拉最新 |
| `UPSTREAM_HAS_KEYS` | 409 | 删上游但其下仍有从属资源（key / 模型档案），`details: {keyCount, modelCount}` | 弹二次确认，带 `force=true` 重发 |
| `ACCOUNT_HAS_KEYS` | 409 | **v1.4.0 新增**。删 §15 账号但其名下有已入池 key，`details: {keyCount}` | 弹二次确认（文案要说清"连带 N 把 key 解绑"），带 `force=true` 重发 |
| `UNPROCESSABLE` | 422 | 语义合法但业务拒绝 | 展示 message |
| `TOO_MANY_ATTEMPTS` | 429 | 登录限速（5 次/分钟） | 倒计时禁用按钮 |
| `INTERNAL` | 500 | 服务端异常 | 提示 + 可重试 |
| `UPSTREAM_UNREACHABLE` | 502 | 查余额时上游不可达 | key 余额标记为未知 |
| `TASK_FAILED` | 500 | 异步任务失败 | 展示任务 message |

### 0.5 鉴权与 CSRF

- 会话走 **`HttpOnly` + `SameSite=Lax` Cookie**（生产加 `Secure`）。**响应体里永远不出现 token**，前端 JS 读不到。
- `/api/*` **除 `POST /api/auth/login` 外全量鉴权**，无白名单例外。
- 写请求（`POST/PUT/PATCH/DELETE`）CSRF 校验顺序固定：`Origin` → `Sec-Fetch-Site`（缺失则跳过）→ `X-Requested-With`。不过则 403 `CSRF_REJECTED`。
- `ADMIN_TOKEN` 仅作 CI 机器令牌，走 `Authorization: Bearer <ADMIN_TOKEN>`，**不参与浏览器流程**，默认关闭。
- `READONLY_TOKEN`（v1.1.0 新增）是**只读维护令牌**：同一套 `Authorization: Bearer` 形式，但**作用域只有 `GET /api/observability/*`**，落在别的路径或用了写方法一律 `403 FORBIDDEN`。它**不等于**管理员会话、也不等于 `ADMIN_TOKEN`；未配置即关闭；两者配成同一个值会在启动时被拒。详见 §12.4。
- `POST /api/assistant/chat`（v1.2.0，§13）**只用登录会话鉴权**：`ADMIN_TOKEN` / `READONLY_TOKEN` 落在它上面都不算通过（`ADMIN_TOKEN` 因非会话仍被 `requireSession` 挡下、`READONLY_TOKEN` 因作用域外被 `403 FORBIDDEN` 挡下）。聊天**消耗模型额度**，所以既不降格成只读、也不交给 CI 机器令牌。

---

## 1. 鉴权 `/api/auth/*`

### `POST /api/auth/login`
```json
{ "username": "admin", "password": "..." }
```
→ `200`
```json
{ "username": "admin", "expiresAt": "2026-10-07T12:00:00.000Z" }
```
`Set-Cookie: sid=...; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`

会话 24h **滑动续期**：每次通过鉴权的请求刷新 `expiresAt`。
失败：`INVALID_CREDENTIALS`(401) / `TOO_MANY_ATTEMPTS`(429，每 IP 5 次/分钟)。
副作用：写审计（成功与失败**都写**）。

### `POST /api/auth/logout`
无请求体 → `204`，清 Cookie，写审计。

### `GET /api/auth/session`
→ `200 { "username": "admin", "expiresAt": "..." }`
未登录 → `401 UNAUTHORIZED`。前端启动时调它决定是否跳登录页。

---

## 2. 上游 `/api/upstreams`

### Upstream 对象（全字段）
```json
{
  "id": "up_7f3a",
  "name": "my88",
  "baseUrl": "https://api.my88.com",
  "enabled": true,
  "supplier": null,
  "keyCount": 6,
  "enabledKeyCount": 5,
  "totalBalance": 128400,
  "balanceUnknownKeyCount": 2,
  "unlimitedKeyCount": 0,
  "tokenPlanKeyCount": 1,
  "accountCount": 0,
  "accountsBalance": null,
  "accountsBalanceUnknownCount": 0,
  "keysBalance": 128400,
  "balanceQuery": {
    "enabled": true,
    "url": "https://api.my88.com/user/balance",
    "method": "GET",
    "headers": { "Authorization": "Bearer {key}" },
    "body": null,
    "parse": {
      "balance": "data.balance_infos[0].total_balance",
      "currency": "data.balance_infos[0].currency",
      "remainingTokens": null,
      "expiresAt": null,
      "unit": "yuan"
    },
    "timeoutMs": 5000
  },
  "balancePreset": { "id": "openai", "label": "OpenAI 官方计费", "matchedBy": "host", "effective": false },
  "revision": 4,
  "createdAt": "2026-10-01T03:00:00.000Z",
  "updatedAt": "2026-10-06T09:12:00.000Z"
}
```

字段语义（**都是画师 §三.3 要的**）：

| 字段 | 可空 | 说明 |
|---|---|---|
| `supplier` | ✅ `null` | **只读语义、可写入**。`null` = 通用上游；`"tierflow"` = 走 §15 账号面。前端账号池分区的**唯一判据**（不解析 `baseUrl` 猜） |
| `totalBalance` | ✅ `null` | 上游合计，**分**。全部未知时为 `null`（不是 0）。**组成**：`Σ账号 quota + Σ无账号归属的 balance 类 key`（v1.4.0 修订，见 §15.6 / ADR-0018 决策 3） |
| `balanceUnknownKeyCount` | ❌ | 余额未知的 key 数。**未知 ≠ 0**，前端必须单独呈现。口径为 `category='balance' AND unlimited=0 AND balance_cents IS NULL`（v1.4.0） |
| `unlimitedKeyCount` | ❌ | `balanceKeyCount` 中无限额度（`unlimited=1`）的条数，**是子集、不额外相加**，也不进"未知"计数（v1.4.0） |
| `tokenPlanKeyCount` | ❌ | token-plan 类 key 数。这类**不进** `totalBalance` |
| `accountCount` | ❌ | §15 账号数（通用上游恒为 `0`） |
| `accountsBalance` | ✅ `null` | 账号级余额合计，**分**（通用上游恒为 `null`）。`null` = 无账号或全未知 |
| `accountsBalanceUnknownCount` | ❌ | 账号级余额未知数（`NULL ≠ 0`，ADR-0003 同纪律） |
| `keysBalance` | ✅ `null` | 本上游 `totalBalance` 里**由 key 贡献的那一半**，供前端拆解合计，**不是新增的一份钱** |
| `balanceQuery.parse.unit` | ❌ | `"yuan"`(×100→分) / `"cents"`(原样) / `"dollar"`(×100→分)。**统一到分是后端的责任** |
| `balanceQuery.enabled` | ❌ | `false` 表示该上游只能手动录入余额 |
| `balancePreset` | ✅ `null` | **只读**。按 `baseUrl` 的 host 命中的内置查询 preset；未命中为 `null`。传了也不生效（可推导字段，非入参） |
| `revision` | ❌ | 乐观锁。写请求带 `revision`，不符则 409 `REVISION_MISMATCH` |

> **安全**：`headers` 里的 `{key}` 是**占位符**，执行时才替换，**替换后的字符串永不落盘、永不进日志、永不回显**。`GET` 时返回的是含占位符的原始模板。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/upstreams?q=&enabled=&page=&pageSize=` | 列表 |
| `POST` | `/api/upstreams` | 建，body `{name, baseUrl, enabled?, supplier?, balanceQuery?}` → `201` |
| `GET` | `/api/upstreams/:id` | 详情 |
| `PATCH` | `/api/upstreams/:id` | 改，body 任意子集 + `revision`（含 `supplier?`，取值 `null \| "tierflow"`，省略 = 不改） |
| `DELETE` | `/api/upstreams/:id?force=false` | 删。有 key **或模型档案**且 `force!=true` → `409 UPSTREAM_HAS_KEYS`，`details: {keyCount: 6, modelCount: 3}`；`force=true` 按依赖序删整棵子树 → `204`（见下） |
| `POST` | `/api/upstreams/:id/balance/refresh` | 按模板查该上游全部 key 余额 → `202 {taskId}` |
| `POST` | `/api/upstreams/:id/balance-template/test` | **自测**：用草稿模板真实打一次查询 → `200 BalanceTestResult`（见下） |

`baseUrl` 校验：必须 `http(s)://`，无尾斜杠（根路径除外）。不合法 → `400 INVALID_PARAM`。

#### 删除的从属资源处置（ADR-0016，修订 §11 C4）

`upstream_keys.upstream_id` 与 `models.upstream_id` 都是 `REFERENCES upstreams(id)`，且连接开了
`foreign_keys=ON` —— **软删不解除行级外键**：上游下只要还有一行 key（哪怕 `deletedAt` 已置）或一行模型，
`DELETE FROM upstreams` 就会被 SQLite 直接拒掉。所以「软删 key + 硬删上游行」这条口径在本 schema 下
**不可实现**，本版按下面两条执行：

| `force` | 行为 |
|---|---|
| `!= true` | 上游下有**任一**从属资源（key 或模型档案）→ `409 UPSTREAM_HAS_KEYS`，`details: {keyCount, modelCount}`（两个计数都给，二次确认要把数量说清）。拦下时**零副作用**。 |
| `true` | 单事务按依赖序物理删除：`key_runtime`（运行态镜像，指向 key）→ `upstream_keys` → `models` → `upstreams`。`204`。 |

- **计数口径**：`keyCount` 只数**未软删**的 key（与 §2 Upstream 对象的 `keyCount` 同源），`modelCount` 数该上游全部模型档案。因此 `keyCount=0, modelCount=0` 时上游下的历史软删 key 行会随上游一起消失（它们已经不可达）。
- **历史可读性不靠这些行**：`usage_logs` 把 `keyMasked` / `model` 名字**存在日志行自己身上**（表里 `key_id` / `upstream_id` 本就没有外键声明），删行不会让历史对不上账；删除动作由 `audit_log` 留痕。
- **代价**：`force=true` 会一并丢掉**管理员在档案卡上手改的开关 / 价格**（模型档案随上游消失）——这正是 `force!=true` 必须报两个计数的原因。
- 前端：`409 UPSTREAM_HAS_KEYS` 分支照旧（弹二次确认 → 带 `force=true` 重发），**只是文案要能表达"模型 M 个也会一起删"**。

### 余额查询解析顺序与失败引导

查询一个 key 的余额时，**按顺序取第一个可用的**（互斥、有优先级）：

```
① 用户模板 enabled=true   → 现有模板引擎（上文 balanceQuery，本版零改动）
② host 命中内置 preset     → 内置执行器（见 balancePreset）
③ 账号型驱动（★v1.4.0 新增）→ 上游 supplier="tierflow" 时按账号逐个查（§15），
                             结果汇总成该上游的余额；本档只看 supplier，不看 baseUrl host
④ 都没有                   → 不发请求，计入 skipped，并带 hintCode=BALANCE_QUERY_UNSUPPORTED
```

- **③ 是尾插一档，前两档的判定逻辑与优先级逐字不变**：`supplier=null` 的上游永远走不到 ③，
  通用上游的行为**零变更**。③ 与 ② 的区别是判据不同（② 看 host、③ 看声明字段），
  不是新增一条猜测路径 —— **不猜，只看 `supplier`**（§15.6）。
- tierflow.cn 不命中任何 preset、用户也没配模板，于是自然落 ③。
- **S1 冻结（v1.5.1）：通用模板不加换算字段**（`scale` / `quota_per_unit` 之类）。TierFlow 的
  `quota → 分` 换算是个例，落在 ③ 账号型驱动里（§15.1 金额口径），**不往通用 `balanceQuery`
  模板里加字段** —— 与 ADR-0018 决策 0「个例不外溢」同一条理由：给通用模板开一个只有一家上游
  用得上的口子，等于让所有上游的模板契约为一家的单位问题扩容。`parse.unit` **保持既有三值
  （`yuan` / `cents` / `dollar`）不变、不新增枚举值**；换算式 `Math.round(quota / quota_per_unit
  * 100)` 是 §15 的**实现细节**，不是模板能力。
- **解析顺序四段是 v1.4.0 已冻结的现状**（尾插 ③），**不是 S1 待办**；本段即它的正文，**它不在 §14**
  （§14 是自动同步 / 快照 / 漂移，余额口径零改动，见 §15.6 末行）。

**内置 preset 永不覆盖用户模板、永不落库**：库里只有用户自己的 `balanceQuery`，preset 是每次查询时现算的判定。
本版注册表只有 `openai`（host = `api.openai.com`；`subscription − usage` 双请求相减，USD→分）。
其余上游（含自建 new-api / one-api）**不做猜测式兜底** —— 自建域名不可判、`quota` 单位随部署方配置、该端点鉴权用的是用户 access token 而非 `sk-` 接口 key，猜错会写出**看起来合理但错误**的余额。这正是"查不到就引导用户提供查询方法"的适用场景。

#### 失败引导字段（非破坏新增）

`hintCode` + `hint` 出现在①余额刷新任务的 `result`、②`BalanceTestResult`。**不是错误码**：不进 `ERROR_CODES`、不映射 HTTP 状态、不影响 `202` 任务本身的成败判定。

| `hintCode` | 触发 | 前端应做 |
|---|---|---|
| `BALANCE_QUERY_UNSUPPORTED` | 无用户模板且无 preset（`skipped`） | 引导用户提供查询方法（打开自测表单） |
| `BALANCE_PARSE_MISMATCH` | 请求成功但取值路径取不到（`unknown`） | 引导用户改字段路径，就地再自测 |
| `BALANCE_UPSTREAM_UNREACHABLE` | 不可达 / 超时 / 非 2xx（`failed`） | 提示稍后重试，**不**引导改配置 |
| `BALANCE_AUTH_REJECTED` | 401 / 403（`failed` 子型） | 提示 key 可能失效，或该端点需要另一种凭据 |
| `null` | `ok` 且解析出数 | 无需引导 |

- `hint`：`string | null`，面向用户的一句话（中文，可直接展示）。
- 刷新任务 `result` 在原 `{checked, ok, failed, unknown, skipped}` 基础上增加 `hintCode` / `hint` 两字段；计数语义**逐字不变**。
- **三型口径不变**（`unknown` / `failed` / `skipped` 仍分开计数，失败仍不写库，`balance_cents NULL = 未知 ≠ 0`）。`hintCode` 只是解释，不改变分型。

#### 自测端点请求体

`POST /api/upstreams/:id/balance-template/test`：

```json
{
  "keyId": "key_9c21",
  "url": "https://api.my88.com/user/balance",
  "method": "GET",
  "headers": { "Authorization": "Bearer {key}" },
  "body": null,
  "parse": { "balance": "data.balance_infos[0].total_balance", "currency": "data.currency", "remainingTokens": null, "expiresAt": null, "unit": "yuan" },
  "timeoutMs": 5000
}
```

- 请求体整体**可省略**（或传 `{}`）→ 用该上游已存的 `balanceQuery` 作草稿。
- **不含 `enabled`**：`enabled` 是持久化语义，一次自测没有"启用/停用"之分；传了忽略。
- `keyId` **可选**：省略时取该上游第一把 `enabled=true` 且 `category="balance"` 的 key；显式指定时必须属于该上游（否则 `404 NOT_FOUND`）。上游下无可用 key → `422 UNPROCESSABLE`。
- 字段合法性同 `balanceQuery`：`url` 必须 http(s)、`method` 仅 `GET|POST`、`timeoutMs` 正数、`unit` 在枚举内，否则 `400 INVALID_PARAM`（`details.field` 指到具体字段）。

`POST /api/keys/:id/test-balance`：**无请求体**，用该 key 所属上游的**生效查询方式**（① 用户模板 → ② 内置 preset）；两条都无 → `422 UNPROCESSABLE`。

**安全**：草稿模板即用即弃 —— 不落盘、不进日志、不进审计；替换过 `{key}` 的 URL 不回显（详见 `endpoint` 字段）。

#### `BalanceTestResult`（两个自测端点共用）

```json
{
  "ok": true,
  "keyId": "key_9c21",
  "maskedKey": "****a1b2",
  "source": "user-template",
  "presetId": null,
  "endpoint": "https://api.my88.com/user/balance",
  "httpStatus": 200,
  "durationMs": 132,
  "parsed": { "balance": 12345, "currency": "CNY", "remainingTokens": null, "expiresAt": null, "unit": "yuan" },
  "raw": { "data": { "balance_infos": [ { "total_balance": 123.45 } ] } },
  "errorCode": null,
  "hintCode": null,
  "hint": null
}
```

| 字段 | 说明 |
|---|---|
| `source` | `"user-template"` \| `"preset"` —— 本次实际用的是哪一条（③ 走不到，无查询方式时直接 422） |
| `endpoint` | **规范化后的 `协议//host/path`**，已剥掉 query。绝不回显替换过 `{key}` 的 URL |
| `parsed.balance` | 分；`null` = 取不到（与"0"严格区分）。**自测永不写库**，所以 `balanceUpdatedAt` / `balanceSource` 不因此改变 |
| `raw` | 上游响应体，**已抹掉明文 key 的所有出现**并截断至 8KB。取值路径没配对时，用户靠它看出来该填什么 |
| `errorCode` | `null`（成功）\| `"UPSTREAM_UNREACHABLE"` \| `"PARSE_FAILED"`；HTTP 仍是 `200` |

**状态码约定**：自测是**诊断**，业务性的"上游不可达 / 取不到值"一律 `200` + `ok:false`（前端要展示诊断结论，不该被错误分支吃掉）；只有**请求本身**有问题才 4xx/5xx，且复用既有码：

| 情形 | 响应 |
|---|---|
| 上游 / key 不存在 | `404 NOT_FOUND` |
| 草稿模板形状非法（`url` 非 http(s)、`method` 非 GET/POST、`timeoutMs` 非正、`unit` 不在枚举） | `400 INVALID_PARAM`（`details.field` 指到具体字段） |
| 无用户模板且无 preset（无查询方式可测） | `422 UNPROCESSABLE`（复用，message 指引配置模板） |
| 未登录 | `401 UNAUTHORIZED` |

---

## 3. Key `/api/keys`

### Key 对象（全字段，覆盖画师 §三.2）
```json
{
  "id": "key_9c21",
  "upstreamId": "up_7f3a",
  "label": "my88-主号-1",
  "maskedKey": "****a1b2",
  "category": "balance",
  "unlimited": false,
  "models": null,
  "enabled": true,
  "weight": 1,
  "balance": 12345,
  "balanceCurrency": "CNY",
  "balanceUpdatedAt": "2026-10-06T09:12:00.000Z",
  "balanceSource": "template",
  "tokenPlan": null,
  "health": "healthy",
  "cooldownUntil": null,
  "consecutiveFailures": 0,
  "lastFailureReason": null,
  "lastFailureAt": null,
  "todayTokens": 84213,
  "revision": 2,
  "createdAt": "2026-10-01T03:00:00.000Z",
  "updatedAt": "2026-10-06T09:12:00.000Z",
  "deletedAt": null
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `maskedKey` | `"****a1b2"` | **后端唯一出口**。明文只在 `POST` 请求体里进，之后**任何**响应/日志/导出都不出现 |
| `category` | `"balance"` \| `"token-plan"` | `token-plan` 时 `balance` 恒为 `null`，看 `tokenPlan` |
| `unlimited` | `bool` | **v1.4.0 新增**。`true` = 上游侧无限额度（`unlimited_quota`），此时 `balance` 恒为 `null` 但**语义不是"未知"** —— 前端必须渲染「无限额度」徽标，不得渲染 `—` / "未知" / 任何负值。老 key 恒为 `false` |
| `models` | `string[]` \| `null` | **v1.4.2 新增**。该 key 的**模型白名单**，取自上游 `model_limits` CSV（TierFlow `model_limits_enabled=true` 时）。`null` = **无白名单、不限模型**（老 key 恒为 `null`，行为与 v1.4.1 逐字相同）。**`[]` 与 `null` 同义**：网关冻结件 `matchesModel()` 对二者同判为"不限"（`src/gateway/key-pool.ts`，v1.1 口径"留空即按 upstream 继承"），本契约**不制造一个实现不了的三态** —— 空 CSV 在落库时归一化为 `NULL`，库里不会出现空串。**只读**：`PATCH /api/keys/:id` 不收该字段。生效范围见 §5「白名单口径」 |
| `balance` | `int`(分) \| `null` | `null` = **未知**（查不到或从未录入）。前端显示"未知"，不得显示 0。`unlimited=true` 时 `null` 表示"无限"，要看 `unlimited` 才分得清（§15.6） |
| `balanceSource` | `"manual"` \| `"template"` \| `null` | 数据来源，用于 UI 标注可信度 |
| `tokenPlan` | 对象 \| `null` | `{ "remainingTokens": int, "expiresAt": ISO8601\|null }` |
| `health` | `"healthy"` \| `"cooling"` \| `"disabled"` | **网关运行态**，管理端只读。`disabled` 优先于 `cooling` |
| `cooldownUntil` | ISO8601 \| `null` | `health=cooling` 时非空 |
| `consecutiveFailures` | int | 连续失败次数，决定冷却档位 |
| `lastFailureReason` | 枚举 \| `null` | `AUTH_INVALID` \| `RATE_LIMITED` \| `INSUFFICIENT_BALANCE` \| `UPSTREAM_ERROR` \| `NETWORK` |
| `todayTokens` | int | 自然日（UTC）累计 token |

> `health` 是**网关进程内**的运行时状态。管理端**不能写** `health`，只能写 `enabled`。`enabled=false` ⇒ 后端返回 `health="disabled"`，即使此前在冷却中。
>
> **这四个字段的来源与新鲜度（ADR-0010）**：网关进程是 `key_runtime` 表的**唯一写者**，它按约 **1s** 一次的节奏把内存里的运行态批量镜像进去（攒批、去重、只在值真的变了才写，且**不在 `/v1/*` 请求线程上**执行）。因此：管理端读到的运行态**最多滞后 1s**；`?health=cooling` 筛选与健康灯的口径由此表提供，而不是「永远 health」。
> **重启后归零**：`key_runtime` **不参与冷启动**——网关启动时不恢复冷却与连续失败计数，第一个镜像周期会把全量状态（含归零的那些）写回，管理端在重启后 1s 内看到的就是归零后的真实值。这是**既定降级**，理由与备选方案见 ADR-0010。
> 注意 `failCount`（累计失败总数）**只在 `/internal/snapshot` 上存在**，不落库、不在本对象里 —— 契约没承诺它。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/keys?upstreamId=&category=&enabled=&health=&q=&page=&pageSize=&includeDeleted=` | 列表（默认 `maskedKey`，默认不含已软删） |
| `POST` | `/api/keys` | 建，body `{upstreamId, key, category, label?, weight?, balance?, tokenPlan?}` → `201` |
| `GET` | `/api/keys/:id` | 详情；已软删的 key 返回 404 `NOT_FOUND`（`?includeDeleted=true` 显式可查） |
| `PATCH` | `/api/keys/:id` | 改 `{label?, enabled?, weight?, category?, tokenPlan?, revision}` |
| `DELETE` | `/api/keys/:id` | 删 → `204` |
| **`PUT`** | **`/api/keys/:id/balance`** | **手动录入余额**（见下） |
| `POST` | `/api/keys/:id/balance/refresh` | 按模板查单个 key 余额 → `202 {taskId}`（异步，轮询 `GET /api/tasks/:id`） |
| `POST` | `/api/keys/:id/test-balance` | **自测**：用该 key 的生效查询方式真实打一次 → `200 BalanceTestResult`（同步、不写库，见 §2） |
| `POST` | `/api/keys/batch` | `{ids: [], action: "enable"\|"disable"}` → `{updated: 5}` |
| `POST` | `/api/keys/balance/refresh` | 批量查余额 → `202 {taskId}` |

### `PUT /api/keys/:id/balance` — 手动录入

请求：
```json
{ "balance": 12345, "currency": "CNY", "note": "客服核对" }
```
- `balance`：`int` 分，**必填**，可为 `0`（0 是合法值，与"未知"严格区分）。
- `currency`：可选，默认取上游配置。
- 响应 `200` 返回完整 Key 对象，其中 `balanceSource="manual"`、`balanceUpdatedAt=now`。

**把 balance 置回"未知"**：`{ "balance": null }` → `balance=null`、`balanceSource=null`。用于撤销错误录入。

> 这是"防造假"的关键：`0` 和 `null` 在契约层就是两个值，前端不能把它们渲染成同一个东西。

### `POST /api/keys` 请求体
```json
{
  "upstreamId": "up_7f3a",
  "key": "sk-xxxxxxxxxxxxxxxx",
  "category": "balance",
  "label": "my88-主号-1",
  "weight": 1,
  "balance": null,
  "tokenPlan": null
}
```
`key` 明文**只在此处进入系统**，服务端立即 aes-256-gcm 加密落盘，响应只回 `maskedKey`。

---

## 4. 用户组 `/api/groups`

### Group 对象（覆盖画师 §三.7）
```json
{
  "id": "grp_2b91",
  "name": "内部-文案组",
  "gatewayKeyMasked": "****9f3c",
  "rpm": 600,
  "tpm": 120000,
  "dailyQuota": 5000000,
  "dailyQuotaUsed": 1832450,
  "todayUsage": { "requests": 412, "tokens": 1832450, "costCents": 4820 },
  "keyCount": 1,
  "enabled": true,
  "revision": 1,
  "createdAt": "2026-10-01T03:00:00.000Z",
  "updatedAt": "2026-10-06T09:12:00.000Z"
}
```
`rpm` / `tpm` / `dailyQuota` 为 `null` ⇒ **不限**。（画师 §三.7 明确要求。）

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/groups?q=&page=&pageSize=` | 列表 |
| `POST` | `/api/groups` | `{name, rpm?, tpm?, dailyQuota?}` → `201`；**建组时自动签发第一个网关 key**，响应**额外带 `gatewayKey` 明文（仅此一次）** |
| `GET` | `/api/groups/:id` | 详情（**不含**明文） |
| `PATCH` | `/api/groups/:id` | `{name?, rpm?, tpm?, dailyQuota?, enabled?, revision}` |
| `DELETE` | `/api/groups/:id` | → `204` |
| `GET` | `/api/groups/:id/keys?page=&pageSize=` | 该组网关 key 列表（**不含**明文）→ 分页信封，项见下 |
| `POST` | `/api/groups/:id/keys` | 再签发一把 → `201 {id, gatewayKey, maskedKey, createdAt}`，**明文仅此一次** |
| `POST` | `/api/groups/:id/keys/:keyId/reset` | 重置 → `200 {id, gatewayKey, maskedKey, createdAt}`，旧 key **立即失效** |
| `DELETE` | `/api/groups/:id/keys/:keyId` | → `204` |

> **网关 key 明文纪律**：只在创建/重置响应里出现**一次**，之后绝不可再取回。前端创建弹窗关闭即从内存丢弃，**不缓存、不写 localStorage**。库内只存 sha256 摘要。

### 网关 key 列表项（`GET /api/groups/:id/keys`）
```json
{
  "id": "gwk_9a12",
  "maskedKey": "****9f3c",
  "createdAt": "2026-10-01T03:00:00.000Z"
}
```
- `id` 就是 `:keyId` 的取值 —— **本端点存在的唯一理由**：`Group` 对象只暴露 `gatewayKeyMasked`，前端拿不到 `keyId`，重置/吊销两个端点无从触达。
- **不返回** `updatedAt`：网关 key 的改法是「删旧行 + 插新行」（重置即失效），`updated_at` 恒等于 `created_at`，回一个永远相等的字段只会让人以为它可以不同。
- 排序固定 `createdAt, id`，因此 **`Group.gatewayKeyMasked` 恒等于列表第一项的 `maskedKey`**（组内至少 1 把 key 时）。
- 明文、`key_hash` 均不出现在本端点，任何情况下都不出现。
- **吊销是硬删**（行不在即失效），不会出现在本列表；痕迹只留在 `audit_log`。因此本端点没有 `includeDeleted`（契约 §3 上游 key 的软删口径不适用于网关 key）。
- 未知组 → `404 NOT_FOUND`；`:keyId` 不属于该组时，重置/吊销一律 `404`（不返回 403，不泄漏 key 的存在性）。

---

## 5. 模型 `/api/models`

### Model 对象（覆盖画师 §三.4）
```json
{
  "id": "mdl_5e10",
  "name": "deepseek-chat",
  "displayName": "DeepSeek Chat",
  "upstreamId": "up_7f3a",
  "type": "chat",
  "capabilities": ["stream", "function_call", "json_mode"],
  "contextLength": 65536,
  "price": { "inputPer1k": 100, "outputPer1k": 200 },
  "availableKeyIds": ["key_9c21", "key_9c22"],
  "enabled": true,
  "lastSyncedAt": "2026-10-06T09:00:00.000Z",
  "revision": 1,
  "createdAt": "2026-10-01T03:00:00.000Z",
  "updatedAt": "2026-10-06T09:00:00.000Z"
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `type` | `chat` \| `embedding` \| `image` \| `audio` \| `rerank` | |
| `capabilities` | `stream` \| `function_call` \| `vision` \| `json_mode` 的数组 | |
| `contextLength` | `int` \| `null` | 上游没给就是 `null`，前端显示 `—` |
| `price` | 对象 \| `null` | `inputPer1k`/`outputPer1k` 单位**分**。**缺失是 `null` 不是 0**，前端显示 `—` |
| `availableKeyIds` | `string[]` | 当前**可服务**该模型的 key（已启用、非冷却、余额 > 0、**且模型在其白名单内**）。空数组 = 暂不可用 |

> **白名单口径（v1.4.2 补，因 §3 新增 `models`）**：`availableKeyIds` 的筛选必须**同时**满足
> **生效白名单** —— `models` 为 `null`/空（不限）**或** 含本模型的 `name`。生效白名单 = `key.models` 非空时取它，
> 否则继承上游级限制（网关 `keyModels()` 的既有口径，`src/gateway/key-pool.ts`）。
> 少这一条，档案卡会列出"能跑这个模型"的 key 里混进白名单外的一把 —— 而网关侧 `matchesModel()` 会拒绝它，
> 于是页面上「可用 key 有 3 把」与实测「2 把在跑」长期对不上，且**没有任何报错**可以追。
> `models` 是**上游事实、只读**：`PATCH /api/keys/:id` 不收该字段，本地想覆盖是 P6 `key_models` 的事（尚未落地）。
| `enabled` | bool | 决定是否出现在 `/v1/models`。验收 4 要求两边**逐项 0 差异** |

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/models?upstreamId=&type=&capability=&enabled=&q=&page=&pageSize=` | 卡片列表 |
| `GET` | `/api/models/:id` | 档案卡详情 |
| `PATCH` | `/api/models/:id` | `{enabled?, type?, capabilities?, contextLength?, price?, displayName?, revision}` |
| `POST` | `/api/models/sync` | `{upstreamId?}` 省略则全量 → `202 {taskId}` |

`POST /api/models/sync` 是**异步任务**（上游拉取可能慢），不阻塞 HTTP。前端轮询 `GET /api/tasks/:id` 拿真实进度——**不许做假进度条**。

### `POST /api/models/sync` 的字段映射（ADR-0009）

上游 `/v1/models` 只回 `{id, object, created, owned_by}` —— **没有**能力、上下文长度、价格。所以同步只写它确实知道的东西：

| 字段 | 同步写入 | 理由 |
|---|---|---|
| `name` | 上游 `id` | 唯一有证据的字段 |
| `type` | **按名字推断**（规则表见 ADR-0009），命不中为 `chat` | 推断是显式的、可覆盖的：建档之后以库里现值为准，`PATCH /api/models/:id` 改过就不再被同步回退 |
| `displayName` | `null` | 上游不给；不拿 `name` 顶替 |
| `capabilities` | `[]` | 空数组 = **未声明**，不是「没有任何能力」 |
| `contextLength` | `null` | 未知，前端显示 `—` |
| `price` | `null` | 未知 **≠ 0**。编一个价格会让统计口径从第一秒起就是假的 |
| `enabled` | 建档写 `1` | 建档即启用；是否真正服务由管理员在档案卡上关 |
| `lastSyncedAt` | 本次同步时间 | 回答「上次拉到数据是什么时候」；内容没变也会刷新，前端用它判新鲜度 |

两条不变量（改代码前先读这两条）：

1. **永不编造**：上游没给的字段一律留空。任何「合理默认值」都是造假。
2. **未知不覆盖已知**：同步只在**建档**时写这些字段；对已存在的模型，`null`/`[]` 不是「新值」，不构成覆盖理由。管理员 `PATCH` 补的 `price`/`capabilities`/`contextLength`/`type`/`displayName` 在下一次同步后原样保留 —— 否则「同步一次就抹掉刚录的价格」比不填更坏。

任务 `result` 里带 `inferredTypeCount`：本次**建档**时靠推断定类型的条数。管理员据此知道有多少条 `type` 是猜的、不是从上游读来的。

### 任务对象 `GET /api/tasks/:id`
```json
{
  "id": "task_3f7a",
  "type": "model_sync",
  "status": "running",
  "progress": { "done": 34, "total": 88 },
  "message": null,
  "result": null,
  "startedAt": "2026-10-06T09:00:00.000Z",
  "finishedAt": null
}
```
`status`：`queued` \| `running` \| `succeeded` \| `failed`。`failed` 时 `message` 非空、`result` 为 `null`。

---

## 6. 统计 `/api/stats/*`

### `costCents` 金额口径（强制，全节通用）

`costCents` 由**网关进程在用量落库时**按上游真实模型名算一次，存进 `usage_logs.cost_cents`；本节所有 `costCents`（`/api/stats/overview` 的 `todayUsage`、`/api/stats/usage` 的 `series[].points`、§4 `Group.todayUsage`）都是对它的 `SUM`。

```
costCents = round(promptTokens    / 1000 * priceInputPer1k)
          + round(completionTokens / 1000 * priceOutputPer1k)      // 单位：分，整数
```

**单价缺失（`models.price_*_per_1k = NULL`）时该项按 `0` 计，不做任何估算、不按同类模型代填。** 于是 `costCents=0` 有两种含义：真的免费/无消耗，或**单价未知**——调用方要区分就必须看模型档案里的价格是否为 `null`，不能把 `0` 当"免费"。

> 与 §0.2「拿不到就是 `null`，不是 0」的关系：那条管的是**余额**（未知余额必须 `null`，因为它是可查询的事实）；而 `costCents` 是**统计聚合**，桶里缺失必须补 0（同 §6「缺失桶补 `0`」）。两者不冲突，但**未知单价计 0 会低报成本**——这是已知缺口，等 M4/M5 决定要不要引入「未知价格触发的估算标记」，届时走契约 + ADR。

### `GET /api/stats/overview?window=60s`
仪表盘 4 张卡 + key 健康灯。
```json
{
  "window": "60s",
  "generatedAt": "2026-10-06T09:12:00.000Z",
  "qps": 3.42,
  "successRate": 0.9941,
  "requests": 205,
  "errors": 2,
  "tokens": { "prompt": 120000, "completion": 34000, "total": 154000 },
  "balance": {
    "global": {
      "totalBalance": 512300,
      "balanceUnknownKeyCount": 3,
      "tokenPlanKeyCount": 2,
      "byUpstream": [
        { "upstreamId": "up_7f3a", "name": "my88", "totalBalance": 384800, "keysBalance": 384800,
          "accountsBalance": null, "accountCount": 0, "accountsBalanceUnknownCount": 0,
          "balanceUnknownKeyCount": 2, "unlimitedKeyCount": 0, "tokenPlanKeyCount": 1 }
      ]
    }
  },
  "keyHealth": [
    { "keyId": "key_9c21", "maskedKey": "****a1b2", "upstreamId": "up_7f3a", "health": "healthy" },
    { "keyId": "key_9c22", "maskedKey": "****c3d4", "upstreamId": "up_7f3a", "health": "cooling", "cooldownUntil": "2026-10-06T09:17:00.000Z" }
  ]
}
```

> `window` 必须由**后端**给（画师明确要求）。前端不得用本地时间自算 QPS，否则对不上。

### 余额三口径 `GET /api/stats/balance`
```json
{
  "global": {
    "totalBalance": 512300,
    "balanceKeyCount": 6,
    "balanceUnknownKeyCount": 3,
    "unlimitedKeyCount": 0,
    "tokenPlanKeyCount": 2,
    "accountsBalanceUnknownCount": 0,
    "currency": "CNY",
    "byUpstream": [
      {
        "upstreamId": "up_7f3a", "name": "my88",
        "totalBalance": 384800,
        "keysBalance": 384800,
        "accountsBalance": null,
        "accountCount": 0,
        "accountsBalanceUnknownCount": 0,
        "balanceKeyCount": 4,
        "balanceUnknownKeyCount": 2,
        "unlimitedKeyCount": 0,
        "tokenPlanKeyCount": 1,
        "keys": [
          { "keyId": "key_9c21", "maskedKey": "****a1b2", "balance": 12345, "balanceUpdatedAt": "...", "balanceSource": "template", "unlimited": false },
          { "keyId": "key_9c23", "maskedKey": "****e5f6", "balance": null, "unlimited": false }
        ]
      }
    ]
  }
}
```

**四条不可违背的规则**（ADR-0003）：
1. 合计**只统计 `category="balance"` 的 key**。token-plan 类不进金额。**v1.4.0 起**：§15 账号的余额是**账号级**的一格，**不再由它名下的 key 重复计入**（ADR-0018 决策 3）。
2. 全局合计 = 各上游合计之和。**v1.4.0 起**：上游合计的组成是 `Σ账号 + Σ无账号归属 key`，形状不变。
3. 任一层只要有未知项，`balanceUnknownKeyCount` 必须 > 0，前端必须单独呈现。**未知不得补 0 计入合计。**
4. 已软删（`deletedAt` 非空）的 key **不进**任何合计与未知计数，历史日志外键保留。
5. **v1.4.0 新增**：`unlimited` 类不计入未知（§15.6），套餐余额（`subscriptions[]`）**不进**本端点任何合计。
6. **v1.5.1 补（S1 冻结）：「无限」与「未知」分列两个计数，互不重叠、不得相加、不得互相顶替。** `unlimitedKeyCount` 是"无限额度"那一格，`balanceUnknownKeyCount` 是"有余额概念但没查到"那一格。无限额度 key 的 `balance` 是 `null`，但**它不进未知计数** —— 否则仪表盘会永久报警"有 N 把 key 余额未知"，而那 N 把根本没有余额概念。前端渲染以 §3 的 `unlimited` 徽标为准（§15.6）。
7. **v1.6.0 补（S2 落地收口）：`keys[]` 与 `keysBalance` 取**同一集合** —— 只列**无账号归属**的 key。** `keys[]` 每个条目带 `unlimited: boolean`（与 §3 `KeyDto` 同名字段同义）。这条不是新口径，是 §15.6 第四口径的实现前提：一把 key 若已归给某账号，它的余额由**账号那一格**代表，`keys[]` 里再出现一次，前端把这段列表一加就得到双倍。故二者必须同进同出 —— 归属出去的 key 从 `keys[]` 与 `keysBalance` **同时**消失，剩下的 key 两边**逐把对应**。通用上游没有台账行 ⇒ 每把 key 都是"无账号归属" ⇒ `keys[]` 与加 §15 之前**逐字相同**。
   - **未知 key 仍在 `keys[]` 里**：这张列表是余额页的数据源，"余额未知"必须能被人看见（规则 3 要求前端单独呈现）。把未知项从列表删掉，未知就从"可见的空白"变成"不存在"。
8. **v1.6.0 补：`currency` 的取值集合跟着**贡献方**走 —— 钱算一次，币种也只跟着算一次。** 该字段由**两个来源**的币种取并集得出：`upstream_keys.balance_currency`（**仅未归属账号的那些**、且 `balance_cents IS NOT NULL`）与 `supplier_accounts.balance_currency`（仅 `balance_cents IS NOT NULL` 的账号）。判据与金额那一格**逐字对齐**：不贡献金额的一方，其币种也不得进来。
   - 归属出去的 key 若把币种混进来，一把"账号已代表其余额"的 key 能把单币种上游**凭空判成混币**（`currency` 变 `null`）。
   - 反过来，钱**全在账号上**的 TierFlow 上游必须从账号行取币种。只查 key 的老口径在这类上游上恒回 `null` —— 那不是"诚实的未知"，是漏查一张表，而且偏偏发生在钱最多的那条上游上。
   - 混币（并集 > 1）或全部未知 → `null`。**不得为了界面好看补一个 `"CNY"`**：那等于替上游下结论。

### `GET /api/stats/usage`
覆盖画师 §三.5，**后端返回序列化好的时间轴，前端不二次聚合**。

| 参数 | 取值 | 必填 |
|---|---|---|
| `from` / `to` | ISO8601 | ✅ |
| `groupBy` | `key` \| `upstream` \| `group` \| `model` | ✅ |
| `bucket` | `1m` \| `5m` \| `1h` \| `1d` | ✅ |
| `upstreamId` / `groupId` / `model` | 过滤 | ❌ |

```json
{
  "from": "2026-10-05T09:00:00.000Z",
  "to": "2026-10-06T09:00:00.000Z",
  "bucket": "1h",
  "groupBy": "upstream",
  "axis": ["2026-10-05T09:00:00.000Z", "2026-10-05T10:00:00.000Z"],
  "series": [
    {
      "key": "up_7f3a",
      "label": "my88",
      "points": [
        { "t": "2026-10-05T09:00:00.000Z", "requests": 120, "tokens": 84000, "promptTokens": 60000, "completionTokens": 24000, "estimatedTokens": 0, "costCents": 320, "errors": 1 }
      ]
    }
  ],
  "isEstimatedTokenCount": 12
}
```
- `axis` 与每个 `series[].points` **等长且下标对齐**，缺失桶补 `0`（这里是计数，补 0 是对的——与余额的 `null` 语义不同）。
- `isEstimatedTokenCount`：`is_estimated=1` 的调用条数。前端图表需可标注"含估算"。
- 每个点另带 `promptTokens` / `completionTokens` / `estimatedTokens`（同一桶内 `is_estimated=1` 的调用条数）——token 维度拆到点上，前端才能画输入/输出双线、并**只**给含估算的那几段打标。`tokens` 恒等于 `promptTokens + completionTokens`；`isEstimatedTokenCount` 恒等于全轴 `estimatedTokens` 之和。
- `costCents` 保留（金额口径见上方「`costCents` 金额口径」）。**本轮不下线、不新增计费**。

### `GET /api/logs` — 调用记录
`?from=&to=&groupId=&model=&status=&upstreamId=&keyId=&requestId=&page=&pageSize=&includeDeleted=`（默认不查已软删资源；`includeDeleted=true` 时按 id 过滤仍可命中已软删的 upstream/key/group；`requestId` 见下方「关联键」）

```json
{
  "items": [
    {
      "id": "log_88a1",
      "ts": "2026-10-06T09:11:58.000Z",
      "requestId": "3f9a1c2e-7d4b-4a11-9c88-2b6f0e5d1a77",
      "groupId": "grp_2b91",
      "model": "deepseek-chat",
      "upstreamId": "up_7f3a",
      "keyMasked": "****a1b2",
      "status": 200,
      "errorCode": null,
      "tokens": { "prompt": 812, "completion": 340, "total": 1152, "isEstimated": false },
      "latencyMs": 842,
      "ttfbMs": 210,
      "stream": true
    }
  ],
  "total": 1, "page": 1, "pageSize": 20
}
```
`keyMasked` 只 4 位。**日志里永远没有 key 明文、没有请求体明文里的 Authorization。**

#### 关联键 `x-request-id`（全链路，v1.1.1 / ADR-0014）

同一个客户端请求的**唯一关联键**。它把一次 `/v1/*` 调用在 `usage_logs`、`gateway_error_events` 与上游侧日志之间串成一条线——第二阶段的 AI 助手「读日志 → 定位问题」靠它，不靠时间窗 + 模型名猜。

| 环节 | 规则 |
|---|---|
| 取值 | 请求进入时读 `x-request-id`；**缺失、非法或超长**一律重新生成。合法格式：`^[A-Za-z0-9._-]{8,64}$`（白名单字符，保证它能安全进响应头、进查询串、进日志文本） |
| 回写 | 无论入站有没有，响应头**一定**带 `x-request-id` = 最终生效的那个值。调用方按回执排障，不靠猜 |
| 透传 | 同一个值**原样**透传上游，上游自己的日志能对上 |
| 落库 | `usage_logs.request_id` 与 `gateway_error_events.request_id` 各一列、同键同值。两表都可查：`GET /api/logs?requestId=`、`GET /api/observability/errors?requestId=` |
| 热路径 | 生成/校验/回写全是 O(1) 内存操作，**不新增任何同步 DB 写**（§9） |

- 入站值**不信任、也不报错**：只做格式白名单校验，不过就重新生成。一个坏 ID 不该让调用方的请求失败（对比 §0.4 的 400 只用于"参数不合法会导致结果不可信"）。
- 非法判定含**超长与非法字符**：把任意长的入站串原样回写，等于替调用方污染响应头与日志列。
- `request_id` ≠ `id`：`id` 是**记录行**的主键（一行日志一个），`request_id` 是**调用**的键——一次调用 = 1 行 `usage_logs` + 0..n 条 `gateway_error_events`。0 次真实尝试的终态（429 池饱和 / 503 密文不可解，见 §10）同样带 `requestId`，它们是**最需要定位**的那几条。
- 历史行（本列上线前写入的）为 `NULL`，与前端的 `null` 渲染一致：**`null` 表示"当时还没有这个字段"，不表示"这次调用没有 ID"**。

### `GET /api/audit` — 审计（最小集）
覆盖：**登录 / 登出 / 所有写操作**。
```json
{ "items": [ { "id": "aud_1", "ts": "...", "actor": "admin", "ip": "127.0.0.1", "action": "key.create", "targetType": "key", "targetId": "key_9c21", "result": "ok" } ], "total": 1, "page": 1, "pageSize": 20 }
```

---

## 7. 实时通道 `WS /api/stats/live`

### 握手
1. 浏览器带 Cookie 发起 `GET ws://<host>:4001/api/stats/live`（**URL 里不带 token**）。
2. 服务端校验会话。失败 → 立即关闭，码 **`4401`**。
3. 前端**首帧**发 `{"type":"auth"}`（**仅就绪确认，不传 token**）。
4. 服务端回 `{"type":"ready"}`。**5s 内未就绪 → 前端主动断开**（服务端也会关，码 `4408`）。

### 关闭码

| code | 含义 | 前端动作 |
|---|---|---|
| `4401` | 会话失效 | 跳登录页 |
| `4408` | 就绪超时 | **重连一次** |
| `1012` | 服务重启 | 退避重连（1s→2s→4s→max 15s） |
| `1008` | 跨站 Origin 被拒（未通过 §0.5 同源判定）—— **既有实现、文档补记** | 退避重连（走 `default` 分支，同 `1012`；源侧修好即自愈） |
| `1000` | 正常关闭（登出） | 不重连 |

**未登记码通则**：上表以外的**任何**关闭码 —— 含异常断开的 `1006`、浏览器侧的 `1005`/`1009` —— 一律走 `default` 分支：退避重连（1s→2s→4s→max 15s）。前端**不得**实现成"只有登记过的码才重连"的白名单，否则新增码会变成静默断连。

### 消息结构

**`ready`**
```json
{ "type": "ready", "serverTime": "2026-10-06T09:12:00.000Z", "intervalMs": 1000 }
```

**`metrics`** — 每 **1s** 一帧
```json
{
  "type": "metrics",
  "window": "60s",
  "serverTime": "2026-10-06T09:12:00.000Z",
  "qps": 3.42,
  "successRate": 0.9941,
  "requests": 205,
  "tokensTotal": 154000,
  "balanceGlobal": 512300,
  "balanceUnknownKeyCount": 3
}
```

**`key_health`** — 状态变化时**立即**推（不等到下一帧）
```json
{
  "type": "key_health",
  "serverTime": "...",
  "keyId": "key_9c22",
  "upstreamId": "up_7f3a",
  "maskedKey": "****c3d4",
  "health": "cooling",
  "cooldownUntil": "2026-10-06T09:17:00.000Z",
  "lastFailureReason": "RATE_LIMITED"
}
```

**`egress_cooldown`** — 随 §7 **每 tick 差分帧**下发（1s 拍子；与 `key_health` / `balance` / `task`
同列，**新连接首 tick 全量** —— 投递语义见下方「基线」，契约 §16.7 Tier 1）
```json
{
  "type": "egress_cooldown",
  "serverTime": "2026-10-06T09:12:00.000Z",
  "egressId": "tierflow.cn",
  "cooldownUntil": "2026-10-06T09:17:00.000Z"
}
```

> **v1.5.0：本帧没有 `reason` 字段**（v1.4.8 曾写 `reason: "RATE_LIMITED"`）。`EgressCooldown`
> （`egress.ts`）只有**一个**变更入口 `cool(host, retryAfterMs?)`，其中的 `reason` **硬编码为
> `RATE_LIMITED`**，表内（`EgressState = {consecutive, until}`）**也不存它** ⇒ 该字段在本帧里是
> **常量**，不是状态。**常量字段比没有字段更贵**：前端会照着它写一个恒真的分支，而它携带的信息量为零
> （出口级冷却本期只有这一种成因）。且本帧**从未发射过、零消费者**（三个自检信号全为 0），
> **删除在此刻是免费的** —— 首发之后再删就变成一次前端改造。将来若真出现第二种出口级冷却成因，
> **同批把字段与生产者一起加回**（**禁止先加字段、后补生产者** —— 契约字段没有生产者，前端只能对着
> 一个恒不出现的值写分支）。

**这是出口冷却的唯一读面。** 四条纪律：

- **前端不得从 `429` 响应体、`Retry-After` 或日志反推出口状态。** 出口被限流在调用方那侧与
  "池饱和"**同形**（都是 `429 RATE_LIMITED`，见 §10），反推**必然猜错**。要看出口状态，只看这一帧。
- **`egressId` 是不透明字符串**，只当 Map 的键用：本期取值即出口 host（归一为小写、含非默认端口，
  §16.7），Tier 2 出口池落地后改为 `egress_proxies.id`。**前端不得解析它的内容** ——
  解析了，Tier 2 一落地就变成一次前端改造；不解析，换的是值不是形状。
- **冷却解除时推同一帧、`cooldownUntil: null`**，前端据此撤掉提示。`cooldownUntil` 是 **ISO8601 时间戳**
  （§0 时间口径），不是秒数、也不是"剩余毫秒"：同一个概念在这条通道里**只有这一个名字、这一种形状**
  （与上面的 `key_health.cooldownUntil` 是同一口径）。
- **差分指纹必须带 `cooldownUntil`**：冷却会**自然到期**，那一刻没有任何写入动作，只有时间流逝。
  指纹不带它，到期后前端会一直停在"出口限流中"—— 与 `key_health` 同一个坑，同一个解法。

**基线（v1.4.10 收口）—— 本帧是差分帧，不是纯事件推。** v1.4.8 那句「开始 / 变更 / 解除时**立即**推
（不等到下一帧）」是从 `key_health` 抄过来的，但 `key_health` 有兜底、本帧没有 ⇒ 照字面实现就是
**纯事件推**，后果是**刷新 / 重连拿不到"此刻正在冷却"这个事实**：前端会把「全部 key 暂停路由」
渲染成正常（最长 30min），而它被上面第一条纪律禁止从 `429` / `Retry-After` / 日志反推 ——
**没有任何合规手段自纠**。所以落法是：与另三类帧同列，`id: egress:${egressId}`、
`sig` 必带 `cooldownUntil`，每 tick 走 `buildTickFrames` / `pushIfChanged`；新客户端 `seen` 为空
⇒ **首 tick 自然全量**，基线由此成立（冷却自然到期时 `sig` 变化，照样推 `cooldownUntil: null`）。
**接线时有三处、不是两处**：除 `buildTickFrames` 造帧、`tickNow` 推帧外，**还必须把 `egress:${egressId}`
注册进 `tickNow` 的 `live` 集合**（`live.ts:321-324`，该集合决定"本 tick 仍存在"）—— 漏了它，
`seen` 里的这条每 tick 被清（`live.ts:359-361`），帧会**每秒重发一次**（不谎报，但白推）。

**读面（v1.5.0 放行）—— 生产者必须供「全量 + 绝对 `until`」，两条都是硬要求。** v1.4.10 把 `sig` 钉成
**必带 `cooldownUntil`**，却没查过**生产者供不供得出它** —— 实测 `EgressCooldown`（`src/gateway/egress.ts`）
只有 `isCooling(host)` / `remainingMs(host)`：**两个都要先知道 host、且没有枚举读**（`const state =
new Map()` 在闭包内、`EgressState` 未导出），也**没有 `until` 的读口**（只有 `cool()` 的返回值）。
于是放行一次**纯增量只读**：`snapshot(): readonly { host: string; untilMs: number }[]` —— 只读、
不产生状态（与 `isCooling` / `remainingMs` 同族），**签名只增不改**，`KeyPool` / `KeyConfig` / engine
零改动。两条语义钉死，都不是风格问题：

- **`untilMs` 必须是绝对时刻，不是剩余量。** 发帧侧**不得**用 `now() + remainingMs(host)` 反算 ——
  那样结果**每 tick 都变**，`sig` 永远"变了"，**每 tick 白推一帧**（本帧要避免的正是这个噪声）；
  而真实 `until` 在冷却期内是**常量**，「自然到期」才表现为**一次**跳变（推 `cooldownUntil: null`）。
- **快照必须是全量，不是"只在冷却期内的"。** `live.ts` 的差分通道**没有墓碑**：一个 id 从本 tick
  的集合里消失，只是被从 `seen` 里删掉（`live.ts:359-361`），**不发任何帧**。所以若快照只报"正在
  冷却的出口"，解除那一刻该出口**直接消失** ⇒ **解除帧永不发出**，前端永远停在「出口限流中」——
  正是 v1.4.10 写的那个形状。快照须含**该出口层记录过的全部出口**（未在冷却者 `untilMs <= now`），
  发帧侧按 `untilMs > now ? ISO8601(untilMs) : null` 出字段、`sig` 取该结果 ⇒ 解除时**恰好推一次** `null`。
- **推论（生产者的纪律）**：冷却层**不得为省内存 prune 已过期条目** —— 一旦 prune，上一条立刻失效。
  真要 prune，得先给差分通道加墓碑，那是**另一笔**（不是这一笔的附带动作）。

这段与 §7「本期不发射」**不冲突**：那是本期状态，这是接线前的**前置件**。**它不阻塞本周期**
（识别器关着，帧本来就发不出来），但必须在**接线那一天之前**落 —— 否则接线当天发现的会是
「接口能注入、帧拼不出来」。

同批一条**证据订正**（免得下一个人照错的半边设计基线）：`key_health` 的基线**不是**由 `metrics` 帧承担 ——
`live.ts` 的 `metrics` 帧只带数字与全量余额，**不带 `keyHealth[]`**（带 `keyHealth[]` 的是 REST 的
§6 `/api/stats/overview`）；它靠的正是与本帧同款的**差分帧首 tick 全量**。`balance` 的兜底则是
REST 全量 `/api/stats/balance`（`live.ts` 注释里写明：通道只报"变化"）。**本帧两条都没有，所以必须自带基线。**

代价写明：冷却开始到前端可见**最多晚一个 tick（1s）**。对仪表盘足够（冷却最短 60s），
换来的是这条"唯一读面"**能自纠**。

渲染口径：冷却期间显示「出口限流中，全部 key 暂停路由（至 `cooldownUntil`）」。**不新增 HTTP 端点、
§14 端点侧不加字段** —— 出口状态不走 REST。

**本期状态（v1.4.9）：形状已冻结，但本期不发射。** 上面那些字段名是**终局**（别改名、别自己造）；
但**本期在通道里收不到这一帧**，两个原因各自独立成立，缺一个都不够：

- **触发条件未启用**：本帧由「出口级冷却被置起」触发，而识别器默认 `neverEgressLimited`（恒 `false`，
  §16.7 裁定 ①）⇒ **出口冷却本期不会被置起**，帧自然无从来。
- **发帧实现未落**：`src/api/routes/live.ts` 目前**零 egress 代码**（`key_health` / `balance` / `task`
  三条帧已落，这条没有）。

于是**本期出口级冷却对管理面不可观测**。这是本节"唯一读面"在本期的推论，请按它读，三条都是硬约束：

- **前端不得接线**：对着一个不来的帧写渲染，是在渲染一个**不会发生的事件**。接线上线当天我在这里喊一次。
- **前端不得把"没收到该帧"当作"出口健康"**：本期**没有任何字段**能证明出口正常，**缺省不是证据**。
  把它渲染成一片健康，正是本契约开篇那句"数字在两次拉取之间是陈旧的、而前端**无从知道自己手上的
  数字多旧**"的实时版 —— 用户会把它当 bug 报给前端，而错在契约没写这一句。
- **接入点已定，两侧合起来才发得出一帧**：`src/api` **不可**直连网关内部（AGENTS.md §8），出口状态
  须经**接线层注入**，形状与 `ApiContext.assistant` 同一套（`src/server.ts` 注入；缺省是"明确的未接线"
  而不是转不完的圈）。生产者是路由者 `src/gateway/egress.ts` 的 `createEgressCooldown()` —— 它是
  **进程内注册表（`Map<host, EgressState>`），不是库表**（出口冷却**不落库、重启归零**），经
  `stack.ts` 装配注入（`egress?: EgressCooldown`）。**发帧必须在同一进程内读这个被注入的实例，不查库** ——
  跨进程读不到它，这条帧就根本发不出来。**管家侧的发帧 + 路由者侧的生产者，两边都到位才有帧**。

自检信号（三个都变号才算真接线，任一为 0 就是没接）：发帧面
`git grep -c egress dev/api -- src/api/routes/live.ts`（今天 **0**）；**差分帧注册面**
`git grep -c 'egress:' dev/api -- src/api/routes/live.ts`（今天 **0** —— 本条为 v1.4.10 新增：
它不为 0 才说明基线机制落了地，只非 0 前者说明帧发了但不带基线）；触发面
`git grep -n neverEgressLimited dev/gateway-rotation -- src/gateway/`（今天**有命中**，
换成真识别器后才可能出帧）。

**上面「本期状态」不因 v1.4.10 改变**：投递语义（基线）是**接线后**的行为，本期仍**零 egress 代码、
帧仍不发射** —— 「不得接线 / 缺省不是证据 / 不得反推」三条硬约束原样有效。

**`balance`** — 余额变动时推（验收 3 要求 Web 端 **5s 内**呈现）
```json
{
  "type": "balance",
  "serverTime": "...",
  "keyId": "key_9c21",
  "maskedKey": "****a1b2",
  "balance": 11245,
  "balanceUpdatedAt": "...",
  "balanceSource": "template",
  "globalTotalBalance": 511200,
  "balanceUnknownKeyCount": 3
}
```

**`task`** — 异步任务进度
```json
{ "type": "task", "taskId": "task_3f7a", "status": "running", "progress": { "done": 34, "total": 88 }, "message": null }
```

**`error`** — 服务端主动报错
```json
{ "type": "error", "code": "INTERNAL", "message": "..." }
```

> **前端契约**：断线期间**不得**把上一帧数字继续当实时值展示。画师已在需求里要求"卡片右上角显示『已断开·重连中』"，后端 `serverTime` 用于判断帧是否新鲜。

---

## 8. 画师 §三 字段依赖对照表

| # | 画师要求 | 落在本契约 | 状态 |
|---|---|---|---|
| 1 | 分页 `{items,total,page,pageSize}` + 错误 `{code,message}` | §0.1 §0.3 | ✅ |
| 2 | Key 全字段（含 `maskedKey`/`category`/`balance` 可空/`health`/`lastFailureReason`/`todayTokens`） | §3 Key 对象 | ✅ |
| 3 | Upstream 全字段 + 余额模板编辑字段 | §2 Upstream 对象 | ✅ 模板字段 = `url/method/headers/body/parse/timeoutMs/enabled` |
| 4 | Model 全字段（type/capabilities/contextLength/price 可空/availableKeyIds） | §5 Model 对象 | ✅ |
| 5 | `groupBy`/`from`/`to`/`bucket`，返回序列化时间轴 | §6 `/api/stats/usage` | ✅ `axis` + `series[].points` 下标对齐 |
| 6 | WS 消息结构 + 窗口口径示例 | §7 | ✅ |
| 7 | Group 全字段，配额 `null` = 不限 | §4 Group 对象 | ✅ |

---

## 9. 与网关面的边界

- 管理面**不改**网关运行态：`health`/`cooldownUntil`/`consecutiveFailures` 只读。
- 反向的一条同样成立：**`key_runtime` 只由网关进程写**，管理面只读（单写者原则）。写入是约 1s 一次的**批量镜像**，不落在 `/v1/*` 请求线程上 —— 见 ADR-0010。
- 管理面写 key 时递增 `revision`；网关靠共享 SQLite(WAL) + `change_log` + 1s 轮询兜底感知变更。
- **热路径零同步 DB 写**：`/v1/*` 上的用量日志异步批量落库，不得挡在 TTFB 前面。

## 10. 网关面 `/v1/*`（路由者负责，此处仅登记口径）

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | stream / 非 stream |
| `GET /v1/models` | 集合必须与模型档案 `enabled=true` **逐项 0 差异**（验收 4） |
| `POST /v1/embeddings` | |
| `image` / `audio` / `rerank` | 建档案，接口返回 `501 UNSUPPORTED_ENDPOINT` |
| `GET /internal/snapshot` | 本机观测 |

- 错误体：`{ "error": { "message": "...", "type": "...", "code": "..." } }`。
- 每个 `/v1/*` 请求都带 `x-request-id`：入站值合法则沿用、否则重新生成，并在**响应头**回写最终值；同一值原样透传上游，并落 `usage_logs` / `gateway_error_events` 的 `request_id` 列（口径见 §6「关联键」）。该头是本节的**唯一新增要求**，不动错误码表、不动错误体。

**`/v1/*` 错误码登记表**（改动需同步 `src/gateway/errors.ts` 的 `GATEWAY_ERROR_CODES`）

| code | HTTP | `type` | 触发条件 |
|---|---|---|---|
| `INVALID_REQUEST` | 400 | `invalid_request_error` | body 不是 JSON 对象、缺 `model`/`messages`/`input` |
| `INVALID_API_KEY` | 401 | `authentication_error` | 网关 key 缺失/未知/已吊销（**不区分**"不存在"与"已禁用"，避免探测窗口） |
| `GROUP_DISABLED` | 403 | `authentication_error` | 网关 key 有效但所属用户组被禁用（`enabled=false`） |
| `NOT_FOUND` | 404 | `invalid_request_error` | `/v1/*` 下未知路径 |
| `RATE_LIMITED` | 429 | `rate_limit_error` | 用户组 RPM / TPM 超限，**或网关池饱和**（候选非空、0 次真实尝试、全候选并发已满，ADR-0011） |
| `QUOTA_EXCEEDED` | 429 | `insufficient_quota` | 用户组日配额（token）超限 |
| `UNSUPPORTED_ENDPOINT` | 501 | `invalid_request_error` | image / audio / rerank 等未实现端点 |
| `UPSTREAM_ERROR` | 502 | `api_error` | **候选存在但用尽**：重试上限内每把 key 都失败 |
| `NO_AVAILABLE_KEY` | 503 | `server_error` | **候选为空**：该模型一把可用 key 都没有；或**候选存在但密文解不出**（元数据在、`secrets.resolve === null`，0 次真实尝试的配置异常，ADR-0011） |
| `UPSTREAM_TIMEOUT` | 504 | `api_error` | 所有尝试都超时（首字节超时，默认 120s） |

> 502 与 503 的分界是**候选集是否为空**，不是"最终有没有成功"：池子里有 key 但全试完仍失败 → `502 UPSTREAM_ERROR`；一把都选不出来 → `503 NO_AVAILABLE_KEY`。两者的排障含义完全不同（前者查上游，后者查池子/档案）。
> **0 次真实尝试不是上游故障（ADR-0011）**：候选非空却在派发前被并发槽位全部挡回（`skippedSaturated > 0` 且无可解析异常）→ `429 RATE_LIMITED` + `Retry-After: 1`，message 明示 `pool saturated`；候选里有 key 但密文解析不出 → `503 NO_AVAILABLE_KEY`（message 明示 `unresolvable`）。两条都**不得报 502**，且都是 0 次真实尝试、`failureReason: null` —— 不计入任何 key 的健康计数。
> **429 响应一律带 `Retry-After`（秒，int）**：用户组 RPM / TPM 超限、日配额超限（`QUOTA_EXCEEDED`）与网关池饱和（`RATE_LIMITED`）三条路径都写该头（池饱和头部由 ADR-0011 起补），两类 `rate_limit_error` 语义统一为"退避后可重试"。调用方按该头退避，不解析 message 文本。
> 另有一个不对外承诺的内部结果：客户端中途断开时引擎会构造 `499 UPSTREAM_ERROR`，此时对端已不可达，`499` 不出现在任何真实响应里，**不入本表**。

- 失败枚举（计入 key 失败，仅这五类）：`AUTH_INVALID` / `RATE_LIMITED` / `INSUFFICIENT_BALANCE` / `UPSTREAM_ERROR` / `NETWORK`。400/404/422 与客户端断开**不计**失败。

---

## 11. C1–C5 裁决（已冻结，详见 ADR-0007）

| # | 问题 | PM 裁决 |
|---|---|---|
| C1 | 建组自动签发第一把网关 key | **通过**：自动签发，明文仅在创建响应出现一次（同网关 key 明文纪律） |
| C2 | usage bucket 自动降级 | **通过**：允许降级，响应必须回显实际 `bucket`，前端按回显渲染 |
| C3 | 日志导出端点 | **通过**：不加端点，前端自行导出 |
| C4 | 删上游 force=true 的 key 处置 | **通过**：级联软删（`enabled=false` + `deletedAt`），保留历史日志外键。**v1.2.2 修订**：该口径与 `upstream_keys → upstreams` 的行级外键冲突（软删不解除引用），改按 ADR-0016 物理删除整棵子树 |
| C5 | 手动余额覆盖模板值 | **通过**：不保护，手动录入总是优先并置 `balanceSource=manual` |

---

## 12. 运维观测 `/api/observability/*`（v1.1.0）

本节是**只读观测面**的唯一事实源：网关把「错误事件」与「健康指标快照」落结构化存储，管理面提供机器可读的查询接口。服务的两个消费者是**排障的人**与**内嵌 AI 助手**（第二阶段，只读分析 + 给建议）。三条纪律贯穿全节：

1. **只读** —— 本节所有端点不接受任何写方法；观测面不产生副作用。
2. **鉴权** —— 除管理员会话外，可配一把**独立只读维护令牌**（§12.4），作用域仅本节。
3. **脱敏** —— 落盘前抹掉一切 key 明文；事件里只有 `keyId` 与 `****后4位`。

### 12.1 错误事件 `GatewayErrorEvent`

**定义**：网关处理 `/v1/*` 时，**一次被拒或一次失败**产生一条事件。成功请求不产生事件（成功量在 §6 `usage_logs` 里）。

**产出边界（落地补遗 v1.1.2，四条都经路由者实现 + 测试钉住）**：

1. **仅 `/v1/*`**：非 `/v1/*` 的请求（含扫描器探测，如 `/wp-admin.php`）**不产事件**——队列满时丢最旧，扫描噪声会把真实故障挤出队列。
2. **未过鉴权（401）`model` 恒为 `null`**：不读 body，匿名请求不得往事件表写任意字段。已过鉴权（含 403 `GROUP_DISABLED`）才读 body 填 `model` / `stream`。
3. **上游 4xx（400/404/422 等）原样透传，不产事件**：网关侧未失败，诊断信息在上游那份响应体里，与 §10「400/404/422 不计失败」同一口径。
4. **Fastify 自产的其余 4xx（413 超大 body / 415 不支持媒体类型等）不产事件**：不在 §10 码表（`setErrorHandler` 只对 `400`→`INVALID_REQUEST` 与 `≥500`→`INTERNAL` 上报，见 ADR-0013 已知缺口）。

落表 `gateway_error_events`（纯加表，`SCHEMA_VERSION` 不变）。

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | ❌ | `err_` 前缀，不透明 |
| `ts` | ISO8601 UTC | ❌ | 事件发生时刻，**网关侧时刻**，落库不重打 |
| `requestId` | string \| null | ✅ | **关联键**（§6「关联键 `x-request-id`」）：与同一请求的 `usage_logs.request_id` 同值。池饱和 / 密文不可解这类 **0 次真实尝试**的终态同样带值——它们最需要定位。本列上线前的历史行为 `null` |
| `severity` | `"warn"` \| `"error"` | ❌ | 由 `category` 决定（见下表），不由 HTTP 状态现推 |
| `category` | 枚举 9 值 | ❌ | **事件分型**，见下表 |
| `status` | int | ❌ | 最终回给客户端的 HTTP 状态；客户端断开写 `499`（该值只存在于事件流） |
| `gatewayCode` | string \| null | ✅ | §10 `GATEWAY_ERROR_CODES` 里的码 |
| `failureReason` | 5 类枚举 \| null | ✅ | 与 §3 `lastFailureReason` **同一套枚举**；未触达上游为 `null` |
| `endpoint` | string | ❌ | 如 `/v1/chat/completions` |
| `model` | string \| null | ✅ | **客户端请求的模型名**（非凭据），与 §6 日志同口径 |
| `upstreamId` | string \| null | ✅ | 抹名引用：只记 id，不记 baseUrl / 上游名 |
| `keyId` | string \| null | ✅ | 抹名引用：只记 id |
| `keyMasked` | string \| null | ✅ | `****后4位`；**永不出现明文**。没有"哪一把 key"可言时（`keyId` 为 `null`）产出侧写 **`****`**（4 位掩码的退化形态），**不是 `null`** —— 与 `usage_logs.key_masked` 同约定；类型保留 `string \| null` 但产出侧永不写 `null`，消费方按"总是有值"渲染即可 |
| `stream` | bool | ❌ | |
| `upstreamStatus` | int \| null | ✅ | 上游返回的原始状态码；一次都没打到上游为 `null` |
| `attempts` | int | ❌ | **真实**上游尝试次数（`0` = 一次都没发出去） |
| `candidates` | int \| null | ✅ | 本次候选 key 数（`NO_AVAILABLE_KEY` 时为 `0`） |
| `latencyMs` | int \| null | ✅ | 自请求进入到产事件的耗时 |
| `message` | string \| null | ✅ | 人类可读归因。**落盘前脱敏 + 截断 512 字符** |

#### `category` 分型表（唯一判据）

| `category` | `severity` | HTTP | 对应 §10 码 | 排障含义 |
|---|---|---|---|---|
| `CLIENT_REQUEST` | `warn` | 400 / 404 / 501 | `INVALID_REQUEST` / `NOT_FOUND` / `UNSUPPORTED_ENDPOINT` | 调用方写错，**不是网关问题** |
| `AUTH_FAILED` | `warn` | 401 / 403 | `INVALID_API_KEY` / `GROUP_DISABLED` | 网关 key 缺失/未知/已吊销（401），或 key 有效但用户组被禁用（403） |
| `RATE_LIMITED` | `warn` | 429 | `RATE_LIMITED`（含池饱和，ADR-0011） | 退避后可重试 |
| `QUOTA_EXCEEDED` | `warn` | 429 | `QUOTA_EXCEEDED` | 用户组日配额用尽 |
| `NO_AVAILABLE_KEY` | `error` | 503 | `NO_AVAILABLE_KEY` | 查池子与模型档案（候选为空的**或**密文解不出的） |
| `UPSTREAM_ERROR` | `error` | 502 | `UPSTREAM_ERROR` | 候选存在但用尽 → 查上游 |
| `UPSTREAM_TIMEOUT` | `error` | 504 | `UPSTREAM_TIMEOUT` | 上游首字节超时 |
| `CLIENT_ABORTED` | `warn` | 499（内部） | 引擎内部 `499` | 调用方中途断开；**仅存在于事件流**，真实响应里没有这个状态，§10 也未登记 |
| `INTERNAL` | `error` | 500 | 网关自身未预期异常 | 网关自己的问题 |

`severity` 的分界是**归因侧**，不是"HTTP 是不是 >= 500"：429 与 502 都是失败，但一个在调用方/配额侧（`warn`）、一个在系统侧（`error`）。助手与值班按 `severity` 先分诊、再按 `category` 定位。

#### 三层口径不可互相替代（下游最容易搞错的一处）

| 字段 | 是什么 | 谁在用 |
|---|---|---|
| `category` | **事件分型**（9 值，本节定义） | 机器聚合、助手分诊 |
| `gatewayCode` | **面向调用方**的错误码（§10 表） | 客户端按它分支 |
| `failureReason` | **计入 key 失败**的 5 类（决定冷却） | 池健康、冷却阶梯 |

一次 `UPSTREAM_ERROR` 事件里三者可能分别是 `UPSTREAM_ERROR` / `UPSTREAM_ERROR` / `AUTH_INVALID`（三把候选 key 全 401、用尽后报 502）—— 这是**正确**的，不是数据不一致。反过来说：**任何一方都别指望用另一个字段反推**。

#### 写入纪律

- 网关侧只做**入队**（O(1) 内存操作），落库由定时批量完成 —— **热路径零同步 DB 写**（§9）。
- 队列有上限；溢出时丢**最旧**的一批并计数，累计丢弃数由 `/api/observability/health` 的 `events.dropped` 暴露。**丢事件不许静默**。
- **落盘前脱敏**：`keyMasked` 只有 4 位；`message` 过 scrub（`Bearer <token>` / `sk-…` / `gw-…` 形状一律替换成 `****`）并截断 512 字符。明文 key 不进事件、不进日志、不进错误体。
- 保留期与 `usage_logs` 同口径（`LOG_RETENTION_DAYS`，默认 30 天）。

### 12.2 健康指标 `GET /api/observability/health`

`?window=60s|5m|1h`（默认 `5m`，上限 24h，与 §6 `/api/stats/overview` 同一条解析规则，回显归一化后的原字符串）。

```json
{
  "generatedAt": "2026-10-06T09:12:00.000Z",
  "window": "5m",
  "uptimeSec": 86412,
  "startedAt": "2026-10-05T09:11:48.000Z",
  "traffic": {
    "qps": 3.42,
    "successRate": 0.9941,
    "requests": 1024,
    "errors": 6,
    "tokens": { "prompt": 120000, "completion": 34000, "total": 154000 },
    "latencyMs": { "p50": 640, "p99": 5120, "samples": 1018 }
  },
  "keys": {
    "total": 8, "healthy": 6, "cooling": 1, "disabled": 1,
    "items": [
      { "keyId": "key_9c21", "maskedKey": "****a1b2", "upstreamId": "up_7f3a", "health": "healthy", "cooldownUntil": null, "consecutiveFailures": 0 }
    ]
  },
  "db": { "ok": true, "schemaVersion": 2, "fileSizeBytes": 2883584, "walSizeBytes": 40960, "queryMs": 1 },
  "events": {
    "total": 12,
    "dropped": 0,
    "byCategory": [
      { "category": "UPSTREAM_ERROR", "severity": "error", "count": 4, "lastAt": "2026-10-06T09:11:02.000Z" }
    ]
  },
  "assistant": {
    "requests": 12,
    "errors": 1,
    "tokens": { "prompt": 8000, "completion": 2000, "total": 10000 }
  }
}
```

| 字段 | 口径 |
|---|---|
| `uptimeSec` / `startedAt` | 服务进程已运行时长（`process.uptime()`）。网关面与管理面在同一进程内，所以这一条即"服务启动了多久" |
| `traffic.*` | 与 §6 `overview` **同一份 SQL、同一口径**；`requests=0` 时 `successRate=1` 是约定而非断言，前端仍必须显示"无流量" |
| `traffic.latencyMs` | `usage_logs.latency_ms` 的**最近秩**分位（nearest-rank，不做插值）：`p50` 取第 `ceil(0.5n)` 小、`p99` 取第 `ceil(0.99n)` 小的样本。`samples` 是参与计算的样本数；`samples=0` 时两个分位是 `null`（**不是 0**） |
| `keys.*` | 与 §3 Key 的 `health` / `cooldownUntil` / `consecutiveFailures` 同源（`key_runtime` 表，新鲜度 ≤1s，ADR-0010） |
| `db.ok` | **真跑一次** `SELECT 1` 的结果，不是"连接对象还在"。`queryMs` 是这次探测的耗时 |
| `db.fileSizeBytes` / `walSizeBytes` | 取不到为 `null`（如 `:memory:` 库）。**不返回库文件路径** —— 路径是部署细节，不进 API |
| `events.total` | 窗口内事件条数 |
| `events.byCategory` | 只列**出现过**的分型，**不补 0**。与 §6 时间轴补 0 不同：这里没有"时间轴完整性"约束，补 0 只会让响应变长、并掩盖"从没发生过" |
| `events.dropped` | 进程启动以来因队列溢出 / 落库失败**累计丢弃**的事件条数（不是窗口内） |
| `assistant.*`（v1.2.0，§13.4） | 内置助手的**独立计量**：`requests` = 助手调用总次数；`errors` = 以 `error` 终止帧结束的次数；`tokens` = 累计（上游 usage 或估算）。**进程内计数、重启归零、不落表**；与 `events.dropped` 同属"本进程"口径，不是窗口内量。**计入 key 健康（`keys.*`）、不计入 `traffic.*`**（不写 `usage_logs`，不污染业务 QPS / 成功率） |

#### 健康快照（`gateway_health_snapshots`）

每 **60s** 落一条：`ts` / `windowSec` / `qps` / `successRate` / `requests` / `errors` / `p50Ms` / `p99Ms` / `keyTotal` / `keyHealthy` / `keyCooling` / `keyDisabled` / `dbOk` / `errorCount`。

- 快照是**当时算出来的历史**，不允许事后重算：`usage_logs` 会被保留期裁掉，重算会得到另一种历史 —— 那正是"看起来合理的假数据"。
- 写入发生在管理进程内、单写者、**不在 `/v1/*` 热路径**上（§5）。

### 12.3 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/observability/health` | 健康指标（实时算，不读快照表） |
| `GET` | `/api/observability/health/snapshots?from=&to=&page=&pageSize=` | 历史快照，`ts DESC, id DESC`；默认最近 **6h** |
| `GET` | `/api/observability/errors?from=&to=&category=&severity=&upstreamId=&keyId=&model=&requestId=&page=&pageSize=` | 错误事件查询，`ts DESC, id DESC`；默认最近 **1h** |
| `GET` | `/api/observability/errors/:id` | 单条事件详情；未知 id → `404 NOT_FOUND` |

- `from` / `to`：带时区 ISO8601（§0.2）。省略 `to` = 现在；`from`/`to` 全省略 = 该端点的默认窗口；跨度上限 **30 天**，超限 `400 INVALID_PARAM`（`details.field="from"`）。
- `category` 支持**逗号分隔多值**（最多 9 个），任一不在 §12.1 枚举内 → `400 INVALID_PARAM`（`details.field="category"`）。
- `severity`：单值，`warn` \| `error`。
- `upstreamId` / `keyId` / `model` / `requestId`：单值精确匹配（`requestId` 见 §6「关联键」）。
- 响应在 §0.3 分页信封之上**追加** `range: { from, to }`，回显**实际**生效的窗口（同 §6 回显降档后 `bucket` 的惯例：前端按回显渲染，不自算）。
- 全部端点**只读**，无副作用、不写审计。

### 12.4 只读维护令牌

- 配置：`READONLY_TOKEN`（env）。空 = **关闭**（默认）。与 `ADMIN_TOKEN` 配成同一个值 → **启动即拒绝**，理由见下。
- 用法：`Authorization: Bearer <READONLY_TOKEN>`。命中后主体为 `readonly`。
- **作用域：仅 `GET /api/observability/*`**。落在别的路径 → `403 FORBIDDEN`；任何写方法 → `403 FORBIDDEN`。不做"是 GET 就放行整个管理面"的宽口径 —— 观测令牌能读的只有观测面。
- 令牌**不进任何响应体、不进日志**。轮换 = 改 env 后重启（本版不做热轮换，"可随时换值"即满足轮换需求）。
- 隔离为什么是硬约束：这把令牌的持有者是内置助手/值班脚本，它的泄露不该等于管理员会话泄露；反之管理员会话也不该被降格成观测令牌。**两把令牌同值 = 隔离归零**，所以宁可启动失败，也不静默接受一份看起来配好了、实际没有隔离的配置。
- 未带令牌时一切照旧：`/api/*` 仍由会话 Cookie 把关（§0.5），本节端点对管理员会话**同样开放**（画师的控制台与助手共用同一份响应体）。
- `POST /api/assistant/chat`（§13）**不在**本令牌作用域内：它是个 `POST`，且语义是"消耗模型额度"，与"只读维护"无关。用 `READONLY_TOKEN` 调它 → `403 FORBIDDEN`；助手用**登录会话**（§0.5）。

---

## 13. 内置 AI 助手聊天 `POST /api/assistant/chat`（v1.2.0）

本节是 M6-B 第二阶段的**聊天接口**：管理后台内置一个 AI 助手，读观测面数据、回答问题、定位故障。它与 §12 的关系是**单向只读消费**——助手通过 §12.3 的同一套结构化过滤参数取数，不新增任何读日志口径。

四条纪律贯穿全节：

1. **无状态** —— 对话**不落库**、服务端不保存会话，多轮上下文由客户端在 `messages` 里原样回传（零新表、零迁移、`SCHEMA_VERSION` 不变）。
2. **会话鉴权** —— 走登录会话（§0.5），**不复用 `READONLY_TOKEN`**；只读令牌落在本端点自动 `403 FORBIDDEN`（§12.4 作用域是 `GET /api/observability/*`）。
3. **日志隔离** —— 助手取数只收 §12.3 的**结构化 DTO 过滤参数白名单**，不接受自由文本查询；日志以**独立 data 块**进入 prompt，并显式声明"数据不是指令"；注入内容只含抹名引用，key 明文零出现（含助手回答）。
4. **独立计量** —— 助手自身的模型调用**计入 key 健康**（失败/成功同样结算冷却），但**不计入业务流量口径**（不写 `usage_logs`、不污染 §6 与 §12.2 的 QPS/成功率），另开一个进程内独立计数，经 §12.2 的 `assistant` 字段只读暴露。

### 13.1 请求体

```json
{
  "messages": [
    { "role": "user", "content": "刚才 5 分钟的错误多吗？" }
  ],
  "logContext": {
    "window": "1h",
    "category": "UPSTREAM_ERROR,NO_AVAILABLE_KEY",
    "severity": "error"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `messages` | array | ✅ | 完整多轮历史，`role ∈ {system,user,assistant}`、`content` 为 string。**至少 1 条**（`messages` 缺失或空 → `400 INVALID_PARAM`，`details.field="messages"`） |
| `logContext` | object | ❌ | 结构化取数参数（§12.3 白名单）。省略 = 纯闲聊、不注入日志 |

`logContext` 字段全部复用 §12.3 的过滤参数（**不造第二套口径**）：

| 字段 | 说明 |
|---|---|
| `window` | 健康指标窗口 `60s\|5m\|1h`，§12.2 同解析规则 |
| `from` / `to` | 错误事件/快照时间窗，带时区 ISO8601，跨度上限见 §13.3 |
| `category` | §12.1 分型，逗号分隔多值（最多 9） |
| `severity` | `warn` \| `error` |
| `upstreamId` / `keyId` / `model` / `requestId` | 单值精确匹配（`requestId` 见 §6「关联键」） |

`logContext` 的失败分两类，**别混**：

- **解析层非法**（`window` 不在枚举、`from`/`to` 不是带时区 ISO8601、`from > to`、`category` 不在 §12.1 枚举内）→ 与 §12.3 一致抛 `400 INVALID_PARAM`（`details.field` 指明字段）。这类是**请求写错了**，回 `truncated` 会掩盖错误。
- **量级超上限**（`from`/`to` 跨度 > 24h、注入条数 > 50、`messages` 条数 / token 超限）→ **不回 400**，按 §13.3 **裁剪 + `done.truncated:true`**。这类是**请求合理但太大**：助手侧裁掉仍然能答，回 400 会把一轮正常的追问打断，而用户并不知道服务端还有一道 24h 的注入口径。

省略或全空 = 不注入日志。

### 13.2 SSE 帧契约

响应是 SSE 流，三种帧，**恰好一个终止帧**（`done` 或 `error`）后连接关闭。响应头必带：

- `Content-Type: text/event-stream; charset=utf-8`
- `Cache-Control: no-cache, no-transform`
- `X-Accel-Buffering: no`

```
event: delta
data: {"seq":1,"text":"最近 5 分钟…"}

event: delta
data: {"seq":2,"text":"…"}

event: done
data: {"seq":3,"truncated":false,"citations":[{"id":"err_9c21","ts":"2026-10-06T09:11:02.000Z","gatewayCode":"NO_AVAILABLE_KEY","category":"NO_AVAILABLE_KEY","severity":"error","model":"gpt-4o","summary":"no candidate dispatchable: 3 key(s) unresolvable"}]}
```

失败终止帧长这样（流已开、HTTP 状态已是 200，所以码值与状态只在 `data` 里）：

```
event: error
data: {"seq":4,"code":"RATE_LIMITED","message":"池中候选 key 并发已满，稍后重试","status":429,"retryAfterSec":1}
```

| 帧 | `event:` | `data:` | 说明 |
|---|---|---|---|
| 增量 | `delta` | `{seq, text}` | 模型输出增量 |
| 终止（成功） | `done` | `{seq, truncated, citations}` | 唯一成功终止帧 |
| 终止（失败） | `error` | `{seq, code, message, status, retryAfterSec}` | 唯一失败终止帧 |

- `seq`：**单调递增**、**从 1 起**的 int，每帧加一（前端据此检测乱序/丢帧）。作用域是**单次请求**：用户点"重试"发的是一条新请求，`seq` **从 1 重新开始**（不是跨请求连续递增）。
- `text` 可以是空串（心跳/首字节占位），前端**不据此**判断结束；结束只认终止帧。
- **`truncated` 不是独立帧**，只是 `done` 上的一个 bool 字段（前端不需要为它加分支）。
- `done.truncated`：**三重上限任一命中**即为 `true`（§13.3）。前端据此提示"上下文已被截断"。
- `done.citations`：本次回答**注入的观测事件引用**（**服务端派生**，不是从模型输出里解析 id——那不可靠且会被幻觉污染）。MVP 只展示、不跳转；数组可为空。
- `error.code`：**§10 网关码值**，复用既有码表，**零新增枚举**（`NO_AVAILABLE_KEY`(503) / `RATE_LIMITED`(429) / `QUOTA_EXCEEDED`(429) / `UPSTREAM_ERROR`(502) / `UPSTREAM_TIMEOUT`(504)）；`error.message` 是"说人话"的归因文案。
- `error.status`：该码值在 §10 表里对应的 HTTP 状态（int）。**它不是本次响应的 HTTP 状态**（SSE 已开流，响应状态恒为 200），前端只在气泡里展示/分支用。
- `error.retryAfterSec`：仅 429 两类（`RATE_LIMITED` / `QUOTA_EXCEEDED`）带，int 秒，与 §10「429 响应一律带 `Retry-After`」同口径；其它码值为 `null`。SSE 已开流后无法再写响应头，所以退避时间走帧内字段。
- 内部调用撞 503 `NO_AVAILABLE_KEY` / 429 池饱和时**必须发 `error` 终止帧**，不得让前端等到超时。

> **429 别糊成一种**（延续 §10 / §12.1 的分法）：池饱和（候选非空、0 次真实尝试、槽位全满）是 **429 `RATE_LIMITED`**，语义"稍后重试"；用户组日配额耗尽才是 **429 `QUOTA_EXCEEDED`**，语义"今天别来"。助手内部调用不走 `/v1/*` 的组级限流，所以它只会撞到前者；契约仍把两者分开写，是为了终止帧的码值语义与 §10 表逐字一致。

#### citation 对象

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | ❌ | 错误事件 id（§12.3 `GET /api/observability/errors/:id` 可查） |
| `ts` | ISO8601 UTC | ❌ | 事件发生时刻 |
| `gatewayCode` | string | ✅ | §10 码值（事件可能没有，如 499 客户端断开 → `null`） |
| `category` | string | ❌ | §12.1 分型 |
| `severity` | string | ❌ | §12.1 `warn` \| `error` |
| `model` | string | ✅ | 事件里的 `clientModel`；未过鉴权的请求恒为 `null`（§12.1 产出边界） |
| `summary` | string | ❌ | **给前端渲染的短摘要**：取 §12.1 `message`（**已 scrub + 截断 512**），再截到 **120 字符**。这是 `citations` 能被"只展示不跳转"渲染出内容的最小可读标签 |

- `summary` 与 `model` 是**脱敏后的既有字段**，不是新数据源：`summary` 直接来自事件行、已过 §12.1 的钥匙抹名与 `scrub`；**不含 key 明文**（含 4 位掩码以外的任何原文）。助手回答里外都不得出现 key 明文（§13 头注纪律 3）。
- 引用顺序 = 事件在注入块里的出现顺序（`ts DESC`，与 §12.3 查询同序），前端按原序展示即可。

### 13.3 三重上限（超限回 `done.truncated:true`，不静默截）

| 上限 | 值 | 超限行为 |
|---|---|---|
| `messages` 条数 | **24** | 丢弃最旧，保留最近 24 条 |
| 单条 token | **8000** | 截断该条 `content` |
| 总 token | **16000** | 从最旧开始丢弃，直到不超 |
| 日志注入条数 × 时间窗 | **50 条** × **≤24h** | 条数超 50 只留最近 50；`from`/`to` 跨度超 24h 收窄窗口 |

- token 估算口径与 §0.2 / 网关 `estimatePromptTokens` **同一套**：ASCII 0.25 token/字符、非 ASCII（中日文等）1 token/字符，向上取整。**只作限额的确定性代理**，不影响计费。
- 任一上限命中 → `done.truncated = true`。**绝不静默截断**：截了就必须让客户端知道。
- **四条上限一律裁剪、一律 `truncated:true`，没有一条回 400**（含日志注入条数与窗口跨度；`400` 只留给 §13.1 的解析层非法）。前端据此提示"上下文已被截断 / 注入范围已收窄"，不静默。

### 13.4 内部调用与计量

- 助手调用**不走 `/v1/*` 公网鉴权**，而是同一进程内直接调 `gateway.engine`（同一 `Db` 句柄、同一 key 池）：选路、key 健康、冷却、失败计数与业务请求**同源**。
- **计入 key 健康**：`reportFailure` / `reportSuccess` 与业务调用同路径，助手撞坏 key 同样进冷却。**对助手坏的 key，对业务同样是坏的**，所以照常报失败，不为助手开"免检"旁路。
- **不计入业务流量口径**：不写 `usage_logs`，因此不出现在 §6 `overview`/`usage` 与 §12.2 `traffic.*` 的 QPS/成功率里。
- **独立计数**（进程内、重启归零、不落表）：由 §12.2 的 `assistant` 字段只读暴露。
- **助手占用上游并发槽位，与业务同池同语义**：内部调用不过 `/v1/*`，所以 **RPM / TPM / 日配额那层不拦助手** —— 这是有意的（助手不该被组级配额当成业务调用掐掉），代价是助手能一直吃 key 的并发槽位。MVP **不为助手单独预留槽位**（同池最简），因此由 `assistant.*` 独立计数 + 本节这句口径，让值班能把"助手把槽位吃满"与"业务流量打满"分开归因：
  - `keys.*`（健康/冷却/失败计数）**包含**助手的影响；
  - `traffic.*` / §6 QPS / 成功率 / token 用量**不包含**助手。
- **"槽位撞满"在真实池语义下有两个出口，两个都照 §10 原样透传、都不新增枚举**（v1.2.1 限定，见文首补遗；§10 的 `RATE_LIMITED`：「候选非空、0 次真实尝试、全候选并发已满」是准的那一条）：
  - **全候选都满并发**（`getAvailableKeys` 在 `isUsable` 处把满并发的 key 全部过滤掉，候选集为空）→ 选路阶段即失败：**`503 NO_AVAILABLE_KEY`**。这是"所有 key 都被占住"的**稳定形态**，助手侧与业务侧同码。
  - **"选路返回 → `beginAttempt` 占位"之间的竞态窗口**（候选非空、0 次真实尝试，到占位时槽位刚被抢走）→ **`429 RATE_LIMITED`**（`retryAfterSec=1`，即 §10「网关池饱和」那条路径）。该窗口窄、不必然出现，是"撞满"的**偶发出口，不是常规出口**。
  - 因此：调用方**按 `code` 分支**，"请稍后重试"必须同时覆盖 `429 RATE_LIMITED` 与 `503 NO_AVAILABLE_KEY`；**"撞满即 429"的简写不再成立**——本版起以本条的二分口径为准。
- **断流 = abort 上游，走同一条 signal 入口，不新增旁路**：助手链路自造一个 `AbortController`，其 `signal` 与业务请求一样进 `chatCompletions({ signal })`；客户端断开或用户点"取消"即 `abort()`，由引擎既有的 `linkedAbort` 合并上游超时、既有 499 处置（`CLIENT_ABORTED`，不计 key 失败）自然接上。**引擎侧零新增分支**；未接上这条 signal 的助手实现 = 白烧 token + 占住并发槽位，属缺陷。

### 13.5 鉴权与作用域

- 走登录会话（§0.5），**不用** `READONLY_TOKEN`。`Authorization: Bearer <READONLY_TOKEN>` 落在本端点 → **403 `FORBIDDEN`**（§12.4 作用域收窄在 `GET /api/observability/*`，本端点不新增任何白名单）。
- 回归闸（照搬 §12.4 的形状）：未鉴权 → 401；带会话 → 200；两把令牌都未配置时带 Bearer → 照旧回落会话鉴权（v1.0 语义零变更）。

---

## 14. 余额同步（v1.3.0）

本节是 **M6-C**：**不新增任何"钱"的口径**，只把 M6-A 已经做完的余额查询做成「自动、有历史、能看出漂移」。三条纪律贯穿全节：

1. **余额的唯一事实源 = 上游接口返回值**（模板 / preset 查得，或人手动录入）。本节**不做本地扣减、不引入单价、不派生"可用余额"** —— 两次查询之间余额一直在变，本地算出来的数必然在某些窗口里撒谎。
2. **查不到就是查不到**：不写 `0`、不估算、不用旧值刷新时间戳（14.2）。
3. **网关零改动**：本版在 `/v1/*` 请求路径上**零新增同步读写**（15 分钟一次的定时器 + 只读端点），TTFB 判据不受影响。

### 14.1 触发与节奏

| 触发 | 行为 |
|---|---|
| **自动同步**（本节新增） | 每上游独立节奏，基准间隔 **15 分钟**（`BALANCE_SYNC_MINUTES`，`0` = **关闭自动同步**）；每轮延迟在 **±10%** 内抖动 |
| **手动刷新**（既有，零变更） | `POST /api/upstreams/:id/balance/refresh`、`POST /api/keys/:id/balance/refresh`、`POST /api/keys/balance/refresh` 全部保留，语义 / 形状 / 状态码逐字不变 |

- **退避**：同一上游**连续失败** n 次后，下一次自动尝试延后 `min(base × 2^n, 6h)`（15m → 30m → 1h → 2h → 4h → 6h 封顶）；任何一次拿到值即归零。**手动刷新成功同样归零** —— 人已经证明能查通了，不该让他等 6 小时。
- **「失败」的判定**：本轮该上游 `failed > 0 且 ok == 0`。`skipped`（该上游没配查询方式）**不推进退避**（没做的事不该被罚）；`unknown`（请求成功但取不到值）**算失败** —— 配置问题退到后面等人改，比每 15 分钟打一次上游强。
- **单飞**：同一上游同一时刻只跑一次；上一轮未结束时本轮**跳过**该上游（不排队、不堆积）。
- **重启归零**：退避与单飞状态在**进程内存**里，重启即清空（与 §3 `key_runtime` 的"重启后归零"同款既定降级，ADR-0010）；**快照与同步时刻落库，重启不丢**。
- 关闭自动同步时不注册定时器（`auto.enabled=false`、`nextRunAt=null`），且**不影响**手动刷新与既有读数。

### 14.2 同步写法（NULL 口径，强制）

| 本次结果 | 写库 | `balanceUpdatedAt` |
|---|---|---|
| 查到值 | 覆写 `balance` / `balanceCurrency`，`balanceSource="template"` | **= 本次查得时刻** |
| 不可达 / 超时 / 非 2xx（`failed`） | **一个字都不写** | **不变** |
| 请求成功但取不到金额（`unknown`） | **一个字都不写** | **不变** |
| 从未查到过（新 key / 手录后撤销） | 保持 `null` | `null` |

- **绝不写 `0`**：`0` 是合法余额，与"未知"严格区分（§0.2）。
- **绝不用旧值刷新时间戳**：查失败时 `balanceUpdatedAt` 保持不动 —— 它是"最近一次**真的查到**的时刻"；把它推到"现在"等于把陈旧读数伪装成实时读数，比不显示更坏。
- `category="token-plan"` 的 key 同理（`tokenPlan.remainingTokens` 与其 `expiresAt`）。
- `balanceSource` 枚举**不变**（仍只有 `"manual"` / `"template"`）；`hintCode` 四值**不变**。

### 14.3 快照、`asOf` 与只读端点

**快照 = 状态，不是动作**：一条快照记的是该上游**此刻**所有未软删 key 的余额状态 —— 它是"照下来的一张相"，不是"这次刷了多少把"的作业记录（后者在 `GET /api/tasks/:id`）。只在**覆盖整个上游**的同步后写（自动同步 / 上游刷新 / 批量刷新里该上游的那部分）；**单 key 手动刷新不写快照** —— 那时上游合计里只有一把 key 是新值、其余是旧值，记成"上游此刻的状态"会是一条半新半旧的假相。

`GET /api/stats/balance/sync?upstreamId=&window=`

| 参数 | 取值 | 必填 |
|---|---|---|
| `upstreamId` | 单值精确匹配 | ❌（缺省 = 全部上游） |
| `window` | `Ns` / `Nm` / `Nh`，上限 24h，**默认 `6h`**（解析规则同 §6 `overview`，回显后端实际用的值） | ❌ |

```json
{
  "auto": { "enabled": true, "intervalMinutes": 15, "jitterRatio": 0.1, "backoffCapMinutes": 360 },
  "lastSyncedAt": "2026-10-07T02:15:03.114Z",
  "lastTrigger": "auto",
  "nextRunAt": "2026-10-07T02:30:41.902Z",
  "window": { "from": "2026-10-06T20:15:00.000Z", "to": "2026-10-07T02:15:00.000Z" },
  "upstreams": [
    { "upstreamId": "up_7f3a", "name": "my88", "lastSyncedAt": "2026-10-07T02:15:03.114Z",
      "consecutiveFailures": 0, "nextAttemptAt": "2026-10-07T02:30:41.902Z", "inFlight": false }
  ],
  "series": [
    { "upstreamId": "up_7f3a", "label": "my88",
      "points": [
        { "t": "2026-10-07T02:15:03.114Z", "totalBalanceCents": 384800, "knownKeyCount": 4, "unknownKeyCount": 2, "unlimitedKeyCount": 0, "tokenPlanKeyCount": 1 }
      ] }
  ],
  "drift": {
    "since": "2026-10-06T20:15:00.000Z",
    "counts": { "BALANCE_SPENT_WITHOUT_TRAFFIC": 1, "BALANCE_UNCHANGED_WITH_TRAFFIC": 0 },
    "alerts": [
      { "code": "BALANCE_SPENT_WITHOUT_TRAFFIC", "upstreamId": "up_7f3a",
        "from": "2026-10-07T01:00:00.000Z", "to": "2026-10-07T01:15:00.000Z", "usedTokens": 0 }
    ]
  }
}
```

| 字段 | 说明 |
|---|---|
| `auto` | 自动同步的**生效参数回显**（前端不得自算间隔 / 抖动 / 退避）。`enabled=false` 时 `nextRunAt=null` |
| `lastSyncedAt` / `lastTrigger` | 最近一次同步**完成**的时刻与触发方（`"auto"` \| `"manual"`）—— **任意触发都算** |
| `nextRunAt` | 自动同步下一次计划时刻（已含抖动）；关闭时为 `null` |
| `upstreams[]` | 每上游运行态：`consecutiveFailures`（退避用）、`nextAttemptAt`（退避中非空，否则 `null`）、`inFlight` |
| `series[].points[]` | **该上游的快照点本身，自带 `t`**。`totalBalanceCents` 为 `null` = 那一刻全未知（**不是 0**） |
| `drift` | 窗口内的漂移提示（14.4）；`alerts` 按 `to` **倒序**，上限 20 条 |

- **`points[]` 为什么还要带 `unlimitedKeyCount`（v1.6.0 补）**：快照点的 `knownKeyCount` 是**推导值**，不是独立查出来的数 —— 它在代码里写作 `balanceKeyCount - unknownKeyCount - unlimitedKeyCount`。v1.4.0 把无限额度 key 从 `unknownKeyCount` 里摘出去之后，若这一格不落库，那个减法就**把无限额度 key 悄悄算成"已知"**：`known + unknown ≠ balanceKeyCount`，而**没有任何一格能解释少掉的这几把 key** —— 前端只会看到一个对不上的账，且它看起来完全正常。故此列随 §15.7 同批 `ALTER`（`INTEGER NOT NULL DEFAULT 0`），老快照填 `0`（加 §15 之前不可能有 unlimited key，正是它该有的值）。
- **与 §6 的 `axis` 口径刻意不同，本节没有等长 `axis`**：同步节奏本身是**不规则的**（抖动 + 退避 + 关闭期），要造一条均匀轴就得发明不存在的点。前端按 `points[].t` 画时间序列；**不补点、更不补 0**。
- **`asOf` 的两个层级别混**：key 级 = `balanceUpdatedAt`（该 key 最近一次真的查到）；上游级 = `series[].points[].t`。前端标注"数据新鲜度"用 **key 级**那个，趋势图用上游级。
- 该端点**只读**：不改任何状态、**不触发任何查询**（要查去点三个手动端点）。鉴权走登录会话（§0.5），**不用** `READONLY_TOKEN` —— 带只读令牌打进来 → `403 FORBIDDEN`（§12.4 的作用域仍只有 `GET /api/observability/*`）。

### 14.4 漂移提示（非破坏，只提示）

**本地没有单价**：`usage_logs` 里只有 token，`balance` 里只有分，**两者没有可比量纲**。所以判据只用**方向 + 零 / 非零**，明确**不做量级比较、不判"对不对得上账"**。

| 码 | 触发（相邻两次快照 + 同窗口 token 用量） | 含义 |
|---|---|---|
| `BALANCE_SPENT_WITHOUT_TRAFFIC` | 余额**下降** > 0，而同窗口本网关 token 用量 = **0** | 同一把 key 可能被别处直连在用，或上游改了口径 |
| `BALANCE_UNCHANGED_WITH_TRAFFIC` | 余额**不变**（差额 = 0），而同窗口 token 用量 > 0 | 查得值可能是缓存 / 套餐口径，或查询端点已失效、一直在回陈旧值 |
| （余额上升） | — | **不告警**：充值 / 上游按周期重置都正常 |
| （任一端 `totalBalanceCents` 为 `null`） | — | **不判定**：未知与未知之间没有"差额"可言 |

- 出口只有两个：一条 `warn` 日志（只记**码 + upstreamId + 窗口**，不记 key 明文，ADR-0006 同纪律）+ 进程内计数 `balance_drift_total{code}`（经本节端点只读暴露）。**不进 `ERROR_CODES`、不影响任何 HTTP 状态、不拦请求、不改任何数**。
- 少于 2 条快照不做判定；阈值与灵敏度不进契约。

### 14.5 与既有口面的关系

- **`GET /api/stats/balance`（§6 余额三口径 / ADR-0003）零变更**：字段、形状、语义都不动。它答的是"现在有多少"，§14 答的是"这一路上怎么变的"。
- **`PUT /api/keys/:id/balance`（手动录入）与三个手动刷新端点零变更**（§2 / §3）。
- **`GET /api/stats/usage` 的 `costCents` 口径零变更**：仍是估算展示，本版**不把它升级成账**、不下线。
- **`src/gateway/` 零改动**：`key_runtime` 镜像、准入三条闸门（RPM / TPM / 日配额）都不动。本版**不新增任何事前拦截** —— 拿一个可能已经过期的查得值去拒请求，等于把估算误差变成用户可见的 `429`。

### 14.6 错误码、迁移与鉴权

**零新增枚举**：`ERROR_CODES` 与 `GATEWAY_ERROR_CODES` 长度不变；两个漂移码是**提示码**（地位同 `hintCode`，不进 `ERROR_CODES`）。`window` 不可解析或超上限 → `400 INVALID_PARAM`（`details.field`）；`upstreamId` 查无此上游 → `200` + 该条为空（列表型过滤，不报 404）。`SCHEMA_VERSION` 不变（纯加表 + 纯进程内状态），**零迁移**。

---

## 15. 供应商账号面（TierFlow 专用，v1.4.0 / v1.4.1）

本节只服务 **TierFlow**（`upstreams.supplier = "tierflow"`），是 Bo 指定的**个例**：
它解决"一个上游下有几十个账号、每个账号各有一套管理凭据"，**不**抽象成通用多供应商框架。
**本节已冻结**（2026-10-07，Bo 拍板）。原 `docs/契约草案-v1.4.0-供应商账号面.md` 已并入本节，草案文件不再存在。

### 15.0 定位与边界

- **通用上游零变更**：`supplier` 为 `null` 的上游，§2 / §3 / §6 / §14 的端点、字段、口径逐字不变。
- **账号 ≠ key**：账号是**凭据容器**（手机号 + 密码 + 会话 + uid），一个账号下有 N 把 sk- key 与
  M 个套餐。账号**不能**用 `/api/keys` 承载（那是网关的转发凭据）。
- **账号面是并列的顶层资源**（`/api/supplier-accounts`），不织进 `/api/keys`、`/api/upstreams` 的既有分支。
- **明文纪律同 ADR-0006**：账号密码与会话值**永不**出现在任何响应、日志、审计 detail、任务 result、
  错误信息里。出口只有手机号掩码。会话生命周期见 §15.9。

### 15.1 `SupplierAccount` 对象（全字段）

```json
{
  "id": "acc_3f21a9c1b704",
  "upstreamId": "up_7f3a",
  "supplier": "tierflow",
  "identifier": "162****4225",
  "username": "user_j4iCrFEB",
  "uid": "1234054733954",
  "status": "active",
  "statusMessage": null,
  "balanceCents": 434,
  "balanceUpdatedAt": "2026-10-07T02:15:03.114Z",
  "keyCount": 1,
  "unlimitedKeyCount": 1,
  "maskedKeyCount": 1,
  "subscriptions": [
    {
      "subNo": "SB1261003742775",
      "planTitle": "轻享版",
      "planSlug": "lite",
      "amountTotalCents": 2990,
      "amountUsedCents": 642,
      "basicTokenTotal": 8000000,
      "basicTokenUsed": 2666169,
      "paidCents": 2990,
      "status": "active",
      "source": "registration",
      "startAt": "2026-10-02T01:07:56.000Z",
      "endAt": "2026-11-01T01:07:56.000Z",
      "autoRenew": null,
      "hasKey": true,
      "keyMasked": "****vFnt",
      "updatedAt": "2026-10-07T02:15:03.114Z"
    }
  ],
  "credentialSource": "password",
  "hasSession": true,
  "sessionExpiresAt": "2026-11-06T02:15:03.114Z",
  "revision": 3,
  "createdAt": "2026-10-07T01:00:00.000Z",
  "updatedAt": "2026-10-07T02:15:03.114Z"
}
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `identifier` | `"162****4225"` \| `"u***@x.com"` | **掩码**。手机号保留后 4 位，邮箱保留域名。真值不出后端 |
| `status` | `"active"` \| `"login_failed"` \| `"session_expired"` \| `"unknown"` | `active` = 会话在手且最近一次查询成功；`unknown` = 从未成功查询过 |
| `statusMessage` | `string` \| `null` | 面向人的一句话。**只放供应商错误码或通用原因**，不含凭据 |
| `balanceCents` | `int`(分) \| `null` | 账号余额。上游 `/api/user/self → quota` **由后端**按 `quota_per_unit` 换算成**分**。**`null` = 未知 ≠ 0**（ADR-0003 同一条纪律） |
| `balanceUpdatedAt` | ISO8601 \| `null` | 最近一次**真的查到时**刻。查失败不动它（§14.2 同纪律） |
| `keyCount` | int | 归属本账号、**已入池**（`upstream_keys` 未软删）的 key 数 |
| `unlimitedKeyCount` | int | `keyCount` 中无限额度（`upstream_keys.unlimited = 1`）的条数。**是子集，不额外相加** |
| `maskedKeyCount` | int | 只拿到掩码、**进不了池**的 key 数（对账用）。**不得与 `keyCount` 相加**成"key 总数" |
| `subscriptions` | 数组（0..N） | 套餐摘要。**恒为数组**，无套餐为 `[]` —— 上游 `/api/subscription/self` 返回的是 `all_subscriptions: []`，单数对象表达不了它 |
| `credentialSource` | `"password"` \| `"session"` | 该账号**当前持有的凭据形态**。`password` = 库里有存档密码，**会话过期可自动重登**；`session` = 只有会话、无密码，**过期即不可自动恢复**（§15.9）。**由这一个字段回答"能不能自动重登"**，前端不自行推断 |
| `hasSession` | bool | 会话是否在手。**只回答有无**，会话值永不出后端。与 `credentialSource` **正交**：`credentialSource="password"` 且 `hasSession=false` 是合法态（密码在手、当前无有效会话，等下一次重登） |
| `sessionExpiresAt` | ISO8601 \| `null` | 会话到期时刻，供前端提示"需重登" |
| `revision` | int | 乐观锁，写请求带 `revision`，不符 → `409 REVISION_MISMATCH` |

**金额口径**：TierFlow 内部单位为 `quota`（`1 元 = 500000 quota`，`/api/status → config.quota_per_unit`）。
**换算成"分"是后端的责任**，出口里**不出现 `quota` 原值**（唯一的例外是自测的 `parsed.quotaPerUnit`，
它是**比例**不是金额）。换算基准 `quota_per_unit` 每次查询时**从上游读**、不写死 ——
供应商改了换算比，我们的数不会跟着错。

**出口命名铁律**：**本面任何货币字段一律以 `Cents` 结尾**，值恒为 int 分。这条是为了让"我手上这个数
要不要 ÷500000 或 ×100"这个问题在字段名上就答完 —— 前端永远不做换算，也不该看见 `quota`
（上游用 quota、`paid_money` 用**浮点元**、我们用**整数分**，三个单位同屏时肉眼分不出来）。

**舍入**：`quota → 分` 一律 `Math.round(quota / quota_per_unit * 100)`，**不截断**
（`14950000/500000 = 29.90 元 → 2990 分`；`2168881/500000 = 4.337762 元 → 434 分`；
`3212302/500000 = 6.424604 元 → 642 分`）。上游 `paid_money: 29.9` 是**浮点元**，
`29.9 * 100 = 2989.9999999999995` —— 必须 round，截断会系统性少算一分。

### 15.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/supplier-accounts?upstreamId=&status=&q=&page=&pageSize=` | 列表 |
| `GET` | `/api/supplier-accounts/:id` | 详情 |
| `POST` | `/api/supplier-accounts/import` | 批量导入并逐个登录 → `202 {taskId}` |
| `POST` | `/api/supplier-accounts/refresh` | 刷余额（quota + 套餐） → `202 {taskId}` |
| `POST` | `/api/supplier-accounts/:id/login` | 单账号重登 → `200 SupplierAccount` |
| `POST` | `/api/supplier-accounts/:id/test` | 连接自测（真实打一次） → `200 SupplierTestResult` |
| `POST` | `/api/supplier-accounts/keys` | 批量**新建** key 并入池 → `202 {taskId}` |
| `POST` | `/api/supplier-accounts/keys/sync` | 同步已有 key（掩码）+ 套餐 → `202 {taskId}` |
| `GET` | `/api/supplier-accounts/subscriptions?upstreamId=&page=&pageSize=` | 套餐列表 |
| `GET` | `/api/supplier-accounts/export?upstreamId=` | CSV 导出（**对账表，见下**） → `text/csv` |
| `DELETE` | `/api/supplier-accounts/:id?force=false` | 删除账号（见下） |

#### `POST /api/supplier-accounts/import`

```json
{ "upstreamId": "up_7f3a", "text": "手机号,密码\n162****4225,********\n" }
```

- `text`：`手机号,密码` 行文本（粘贴或 CSV 文件名皆可）。容忍**表头行**、`+86` 前缀、空格/制表符/分号分隔。
  解析失败的行**跳过并逐行报原因**，不整批失败。
- 上游必须 `supplier="tierflow"`，否则 `422 UNPROCESSABLE`。
- 已存在的 `identifier` **不重复建行**，执行"重登 + 刷新"，`action: "relogin"` 在逐行结果里标明。
- **每号只试一次登录**（供应商风控），失败即记 `login_failed`。
- **本端点只收密码型凭据**（`text` 管道）。会话型凭据**不走 HTTP**，见 §15.9。
- 对已是 `credentialSource="session"` 的 `identifier` **补录密码**是本端点的正常用法（不是特例）：
  走"重登 + 刷新"，`action: "relogin"`，该行**就地升级**为 `credentialSource="password"`
  并从此纳入自动重登（§15.9）—— 不新建行、不改 `id`。

#### `POST /api/supplier-accounts/refresh`

```json
{ "upstreamId": "up_7f3a", "ids": ["acc_3f21"] }
```

`ids` 省略 = 全部账号。会话失效**自动用存档密码重登**；**无存档密码的账号不重登**，
直接计 `failed` 并置 `status="session_expired"`（§15.9 有解释：只有会话、没有密码时无从重登）。
节奏与礼貌参数见 §15.5。

#### `POST /api/supplier-accounts/keys`

```json
{
  "upstreamId": "up_7f3a",
  "ids": ["acc_3f21a9c1b704"],
  "count": 1,
  "namePrefix": "tierflow",
  "unlimited": true,
  "quotaCents": null,
  "models": null,
  "label": null
}
```

| 字段 | 说明 |
|---|---|
| `ids` | 目标账号；省略 = 该上游全部 `active` 账号 |
| `count` | 每账号建几把，`1..10`，超出 → `400 INVALID_PARAM` |
| `namePrefix` | 上游侧 key 名 = `<namePrefix>-<identifier后4>-<序号>`，**不含凭据** |
| `unlimited` | `true`（**默认**）→ 上游 `unlimited_quota: true` 且**入池行落 `upstream_keys.unlimited = 1`**；`false` → 必须给 `quotaCents`（int 分，由我们换算成上游 quota，前端不乘 500000） |
| `label` | 入池后的 `upstream_keys.label`；省略则用上游侧 key 名 |
| `models` | **v1.4.2 新增，可选**。模型白名单，`string[]`。省略**或空数组** = **不设白名单**（落 `NULL` = 不限模型，与 v1.4.1 现状一致 —— 空数组与省略同义，见 §3）。给了值 → 上游侧 `model_limits_enabled=true` + `model_limits` = 逗号拼接，入池行**同批**落 `upstream_keys.model_limits`（上游原样 CSV） |

> **`models` 的写入责任（v1.4.2）**：白名单是**上游事实**，我们只是把它落库、原样透出（§3）。
> 建 key 时**由我们提交的值**为准；上游若在创建响应里回显 `model_limits`，以回显值覆盖提交值；
> 两边都没有 → 落 `NULL`。**归一化**：空串 / 空 CSV / 仅空白一律写 `NULL`，**不写 `''`**
> —— 库里两个值、语义一个值，早晚有人按 `''` 写查询。
> `keys/sync` **不**回填该列（掩码匹配只认后 4 位、可能撞号，
> 拿不准的匹配去写白名单会把 A key 的限制安到 B key 上，代价远大于"少同步一次"）。
> **待实测（与 §16.1 同批）**：上游创建接口是否接受 `model_limits`、回显是否带该字段；
> 以及 **CSV 项与我们 `models.name` 是否同构** —— 不同构则 `matchesModel()` 永远不命中，
> 表现为"白名单里的模型全不可用"。实测前按上句"两边都没有 → `NULL`"处理，不猜。
> **v1.4.6 追加**：上游 `model_limits_enabled=true` 时**空 CSV** 的含义 —— 「全禁」还是「不限」。
> 我们现按后者归一化为 `NULL`；若实测为「全禁」，则 §15.7 的归一化规则与 `matchesModel()` 的
> 空数组口径**双双需要重写**。这是**唯一**会把「全禁」静默变「不限」的方向，故单列一条。

**这是本节的目的所在**：明文只在创建响应出现一次，服务端**当场** `aes-256-gcm` 写入
`upstream_keys`（走既有 `createKey` 路径：`masked_key` 派生列 + `revision` + `change_log`），
响应与任务 result **只回 `maskedKey` 与 `keyId`**。网关 ≤1s 轮询后即可用于 `/v1/*`。

**明文不经浏览器**：`sk-…` 由**我们的服务端**从上游创建响应里拿到、当场加密落库，
任务 result 与任何 API 响应**只回 `keyId` 与 `keyMasked`**。

> 与 §3 `POST /api/keys` 的差别是**方向**：§3 是"人从供应商控制台复制明文 → 交给服务端"，
> 明文必然经过浏览器，所以我们有"只显示一次"的浮层。本节是服务端自己去上游取 ——
> **浏览器全程不持有明文**，因此前端**不做**"一次性明文 + 强制复制"浮层，也就没有"用户没复制
> 就丢了"这个失败模式。前端这一步只看到 `202 {taskId}` → 轮询 → 逐行 `keyMasked`，
> 拿到的是**回执**（`keyMasked` + `tokenNo` + "凭据已托付网关，无需留存"），不是凭据本身。

#### `GET /api/supplier-accounts/subscriptions?upstreamId=&page=&pageSize=`（v1.6.1 补形状）

**跨账号**的扁平套餐列表 —— 与 §15.1 详情里那个嵌套 `subscriptions[]` 是**同一份数据的两个切面**：
那条回答"这个账号有哪些套餐"，这条回答"这堆账号的套餐排在一起、接下来谁到期"。

响应：§0.3 分页信封，`items[]` = `SupplierSubscriptionRowDto` = §15.1 的 `SupplierSubscriptionDto`
**加上三个归属字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `accountId` | string | 套餐属于哪个账号 |
| `accountIdentifier` | string | **掩码**手机号 / 邮箱。与 §15.1 同一条纪律：**真值不出后端** |
| `upstreamId` | string | 该账号所在上游 |

- 归属字段是**这个端点存在的理由**：扁平列表里一个没有主语的 `subNo` 对不了账，
  而"这是哪个号的"正是打开这一页要问的第一句话。字段形状**复用** `SupplierSubscriptionDto`，
  不另造一套（否则两处会漂）。
- **排序 `end_at ASC`，`NULL` 排最后**，末位 `sub_no` / `id` 兜底成全序。
  - 不按惯用的 `updated_at DESC`：本端点的用途就是看"接下来谁到期"，按更新时间排会把
    一个下月到期、昨天刚刷新过的套餐顶到最前面。
  - 不处理 `NULLS` 的话 SQLite 把 `NULL` 当最小值，会把"没有到期时间"的全部排到**最前**，
    把真正快到期的挤出首页。判定键是 `(end_at IS NULL), end_at, sub_no, id`。

#### `GET /api/supplier-accounts/export`

CSV，一行一账号，列为：
`upstreamId, identifier(掩码), uid, status, statusMessage, balanceCents, balanceUpdatedAt,
keyCount, unlimitedKeyCount, maskedKeyCount, subscriptionCount, subscriptionEndAt,
createdAt, updatedAt`。

- **`upstreamId` 列是 v1.6.1 补的**（v1.4.0 的列清单里没有它）：不带 `upstreamId` 查询参数时
  导出的是全部账号，而表里若没有归属列，读的人分不出每一行是哪个上游的账号 —— 对账表的基本要求。
- **不含密码、不含会话、不含任何 key 明文或掩码** —— 密码与会话不是"数据"，是凭据（ADR-0006）。
- 因此**这份 CSV 不能用来重建账号**（重建需要密码）。它是**对账 / 审计表**，不是备份。
  备份口径是**库文件级备份**（密文形态）。
- **重建输入只认人工维护的「手机号+密码」清单**（§15.2 `import` 的 `text` 一栏粘贴，
  不落盘、不落 `localStorage`、不回填表单）。这条与上一条必须同时写进导出按钮的说明里，
  否则"导出 → 换台机器导入 → 27 个号全登不上"会是一个很难查的坑。

**机械形状（v1.6.1 补 —— 冻结稿只给了"CSV"两个字，实现时这七条都是被强制的）：**

| 项 | 取值 | 为什么必须写死 |
|---|---|---|
| `Content-Type` | `text/csv; charset=utf-8` | 少了 `charset` 有些客户端按 Latin-1 解 |
| `Content-Disposition` | `attachment; filename="supplier-accounts-YYYYMMDD.csv"`（**UTC** 日期） | 文件名由服务端给，前端不必自己拼（拼了就两份实现）；用 UTC 是因为服务器时区不该改变文件名 —— 否则同一动作在不同时区的机器上产出两个名字，归档时会被当成两份表 |
| BOM | **有**（`EF BB BF`） | 无 BOM 时 Windows Excel 按本地代码页（简中 = GBK）解，打开即乱码；而"导出打开是乱码"会被当成数据损坏去查一遍后端 |
| 行尾 | **CRLF**（RFC 4180） | Excel 对 LF 也能读，但 CRLF 是两个客户端都无歧义的那个 |
| 引号 | 含 `,` `"` 换行，或**首尾有空格**时加引号，内部 `"` 翻倍 | 首尾空格不加引号会被 Excel 吃掉，肉眼看起来是"我们导出的值变了" |
| **公式注入** | 文本单元格以 `=` `+` `-` `@` **或制表符 / 回车**开头时，**前缀一个单引号** | 表里的 `identifier` / `uid` / `statusMessage` 全是**供应商侧**的外部文本，Excel 会把它们当**公式执行**（`=HYPERLINK(...)` 一类足以在打开对账表的人机器上拉外链或触发 DDE）—— 导出这个**纯读动作**因此是一条代码执行路径。单引号是各家都认的"这是文本"标记。**数值单元格一律不前缀**：`-100` 是负数不是公式，前缀会把整数变文本，于是这份表在 Excel 里求不了和、排不了序 —— 防注入防掉了本表的用途 |
| 分页 | **不分页**（无 `page` / `pageSize`） | 对账表分页导出**就是错的**：拿到的"账号总数"取决于导出时点了第几页。账号面是人工导入的规模（个位数到几十），一次全量是安全的 |

- `subscriptionCount` = 套餐条数；`subscriptionEndAt` = 该账号所有套餐 **`end_at` 的最大值**
  （取最晚 = "被接续覆盖到什么时候"；取中间值会让一个已续过期的账号看起来快到期）。
  全为 `NULL`（上游没给到期时间）时空单元格 —— **不是 `0`、不是 `-`**。
  该列依赖 `end_at` 已是 ISO8601 UTC（§15.1），**归一化责任在写入侧**（导入路径）：
  上游格式不一时在**读侧**猜格式，只会把"数据没归一化"这个真问题盖成"偶尔排序不对"。
- **审计**：每次导出写一条 `audit_log`（`action = "supplier.export"`，`detail = "rows=N"`）。
  **`export` 是 GET 却写审计，这是刻意的** —— 见 §15.7。

#### `POST /api/supplier-accounts/keys/sync`

拉取该账号在站点上的**全部 key（掩码）** + 套餐 + 套餐专属 key，与池内 `upstream_keys` 对账。

**匹配口径：只按「后 4 位」**，不是"前 4 + 后 4"：

- 我们的 `masked_key` 是 `maskKey()` 的产物 —— `****` + **后 4 位**，字典里没有前 4 位
  （`src/db/crypto.ts`，`sk-…` 的 `-` 也算进 slice）。上游给的却是 `NcBZ**********WnWw`
  这种"前 4 + 后 4"。**只有后 4 位是两边都有的**。
- 比对前先把上游掩码**剥掉 `sk-` 前缀**：`/api/token/search` 的掩码不含 `sk-`，
  而 `/api/subscription/self/token` 给的是 `sk-k58R**********vFnt` —— 不剥就永远匹配不上。
- 后 4 位撞号（同一账号下多把 key 后 4 相同）→ **不更新任何行**，该行 `code: "KEY_MASK_AMBIGUOUS"`。
  宁可少更新一次，也不要把余额写到另一把 key 上。

命中的掩码只更新 `maskedKeyCount` 与账号状态；未命中的掩码**只记数** ——
**不创建可用凭据**（掩码不可逆，见 ADR-0018 决策 2）。

#### `DELETE /api/supplier-accounts/:id?force=`

| `force` | 行为 |
|---|---|
| `!= true` | 该账号名下有**已入池的 key** → `409 ACCOUNT_HAS_KEYS`，`details: { keyCount: 1 }`。拦下时零副作用 |
| `true` | 删账号行与套餐行；**池内 key 保留但解绑** —— 它们可能正在被网关使用，删账号不等于停服务 |

- **响应码（v1.6.1 补）**：成功 `204`（无响应体），被拦 `409`，账号不存在 `404`（删两次的第二次也是 `404`，
  不静默当成功）。
- **审计（v1.6.1 补）**：成功时写一条 `audit_log`（`action = "supplier.account.delete"`，
  `detail = "force"` 或 `null`）。**被拦下（409）时不写成功审计** —— 审计里留一条 `ok` 会让人以为删成了。
- **不写 `change_log`**：网关快照只消费 `upstream_keys` / `upstreams` / `models`，而本操作
  **一行 key 都没动**（解绑不改 key 行的任何一列），故网关侧**没有任何变化可推**。
  发一条它不认识的 entity 只会让快照消费方多一个要忽略的分支。

**「解绑」的机制是什么（v1.6.0 订正）**：解绑 = **删掉 `supplier_account_keys` 台账行**，不是把某一列置 `NULL`。v1.4.0 的 ADR-0018 决策 2 把它写成"`/upstream_keys.account_id` 置 `NULL`"，但**`upstream_keys.account_id` 这个列在任何 DDL 里都不存在**，v1.4.x 的 `ALTER` 批里也没有它 —— 归属关系**本来就**由 `supplier_account_keys.pooled_key_id` 这条台账表达（§15.2 `keys/sync` 写它、§15.1 `keyCount` 从它数出来）。

- **刻意不给 `upstream_keys` 补一列**：那等于给同一个事实造**第二个事实源** —— `keyCount` 走台账、归属走列，两者迟早漂成不一致，而漂的那一刻没有任何东西会报错。一个事实一个载体。
- **`pooled_key_id` 不设外键**：`deleteUpstream`（ADR-0016）会整批**物理删除** `upstream_keys`，加了外键就把那条已冻结、已被测的删除路径变成 500 —— 与 `upstream_id` 同一个理由。
- 因此**解绑是删台账行**（key 行留在原处、继续被网关使用），而**删上游是删 key 行**（台账行随之成为悬空引用，`NOT EXISTS` 子查询天然跳过）。两条路径的不同处置见下一条注。
- **`ACCOUNT_HAS_KEYS` 的 `keyCount` 必须 JOIN 回来数，不能数台账行**：`deleteUpstream`（ADR-0016）物理删除 `upstream_keys` 时**不动** `supplier_account_keys` —— 加台账行没有外键，那批行会变成指向已删 key 的悬空引用。若 409 判定直接 `COUNT(*) FROM supplier_account_keys WHERE account_id = ?`，删过一次上游的账号就会**永远删不掉**：弹窗警告"连带 N 把 key 解绑"，而那 N 把 key 早已不存在，`force=true` 也解绑不出任何东西。（§15.1 的 `keyCount` 已是这个口径 —— `countsFor()` 走 `LEFT JOIN upstream_keys uk … AND uk.deleted_at IS NULL`，判定照抄它即可。）

> 与 ADR-0016（删上游物理删整棵子树）取向不同，理由是：上游删了 key 必然不可达；**账号删了 key 仍然可用**。
> ADR-0016 的口径**未变**，本节只是说明为什么账号面不套用它的理由。

#### `SupplierTestResult`（连接自测）

```json
{
  "ok": true,
  "accountId": "acc_3f21a9c1b704",
  "identifier": "162****4225",
  "httpStatus": 200,
  "durationMs": 812,
  "loginAttempted": false,
  "parsed": { "balanceCents": 434, "quotaPerUnit": 500000, "subscriptionCount": 1 },
  "raw": { "success": true, "data": { "quota": 2168881 } },
  "errorCode": null,
  "hintCode": null,
  "hint": null
}
```

- **自测永不写库**（`balanceUpdatedAt` 不因此改变），与 §2 `BalanceTestResult` 同口径。
- `parsed` 是**换算后**的结论（`balanceCents` 为分），`raw` 才是上游原样 —— 想要 quota 原值看 `raw`，
  想在页面上显示金额看 `parsed.balanceCents`。**前端禁止读 `raw` 里的数字当金额渲染。**
- `quotaPerUnit` 是**比例**（非金额），保留是为了诊断"换算比是不是被供应商改了"。
- `raw` 已抹掉所有凭据出现并截断至 8KB；`loginAttempted=true` 表示本次为验证密码而真实登录过。
- 业务性失败（不可达 / 供应商 `success:false`）一律 `200` + `ok:false`（诊断语义，同 §2）；
  只有请求本身有问题才 4xx/5xx。

### 15.3 批量任务 result（四个批量端点共用形状）

```json
{
  "done": 27, "total": 27, "ok": 24, "failed": 3, "skipped": 0,
  "itemsTotal": 27, "truncated": false,
  "items": [
    { "accountId": "acc_3f21a9c1b704", "identifier": "162****4225",
      "action": "create", "ok": true, "code": null, "message": null,
      "keyId": "key_9c21", "keyMasked": "****WnWw", "tokenNo": 1187 }
  ],
  "hintCode": null, "hint": null
}
```

- `action`：`login` \| `relogin` \| `refresh` \| `create` \| `sync`。**每个值都必须有生产者**，
  不留"枚举里有、没人发"的空值：`login` = `import` 里**新建**的账号首次登录成功；
  `relogin` = 已有账号在 `import` / `refresh` / `keys` 中被重登；`refresh` = `refresh`；
  `create` = `keys`；`sync` = `keys/sync`。
- `code`：供应商错误码原样（如 `LOGIN_INVALID_CREDENTIALS`）或本节错误码；`message` 一句人话。
- **逐行结果不含任何凭据**（`keyMasked` 是掩码，`keyId` / `tokenNo` 是内部标识）。
- 进度**只由真正干完的账号推进**（复用 `startTask` 的 `step()`），不做假进度条。

**逐行结果落在 `result.items`，不新增 Task 字段、不新增 `GET /api/tasks/:id/items`。**
理由三条，都与"它只在终态有意义"有关：

1. 中途的行**还在变**：第 3 行的余额会被第 4 行的重登结果改写。前端拿到的半份结果下一帧就被推翻，
   而 §7 的 `task` 帧是**按 `status|done/total|message` 差分的** —— 想把行推进去，就得把行并进
   `sig`，于是每处理完一行就把整份列表重推一遍。
2. `tasks.result` 已经是一个 JSON 列，本节的形状**本来就在里面**；为一个 1 分钟的中间态
   另开端点，等于为一笔收据建一张表。
3. 于是前端的时间线是：真实 `progress` 走条 → 终态一次性渲染逐行表。27 个账号一轮 ≈ 30~60s，
   这期间的 UI 是进度条而不是滚动日志 —— **这点与工作台不同，是刻意的**。

**上限与截断**：`items` 最多 **500** 行；超出时保留前 500 行、`truncated: true`，
`itemsTotal` 给真实行数（用 `ok`/`failed`/`skipped` 三个计数仍可拿到完整汇总）。
500 行的 result ≈ 75KB，是 `GET /api/tasks/:id` 单次响应的可接受上限；2000 行粘贴导入时
前端必须显示"逐行明细已截断"提示，不能让用户以为只处理了 500 个。
**本期不分页**：`items` 只出现在**终态**，头 500 行 + 真实总数足够定位问题；
真要全量明细用 `export`（§15.2）。

### 15.4 错误码增量

`ERROR_CODES` **只新增一个**：

| code | HTTP | 触发 |
|---|---|---|
| `ACCOUNT_HAS_KEYS` | 409 | `DELETE /api/supplier-accounts/:id` 未带 `force=true` 且名下有已入池 key |

其余复用既有码：`INVALID_PARAM`(400)、`UNAUTHORIZED`(401)、`NOT_FOUND`(404)、
`REVISION_MISMATCH`(409)、`UNPROCESSABLE`(422，上游不是账号型 / 无可用账号)。
`KEY_MASK_AMBIGUOUS`（§15.2）与 `LOGIN_INVALID_CREDENTIALS` 等供应商错误码**不进** `ERROR_CODES`，
只出现在 `items[].code` 与 `statusMessage` —— 它们是**上游的话**，不是我们的错误分类。

### 15.5 节奏与礼貌（不是性能问题，是能不能长期跑的问题）

| 项 | 值 | 依据 |
|---|---|---|
| 账号间间隔 | **0.6s**（当前实现值） | ~~工作台 29 号跑下来未触发限流~~ —— **依据已降级**（§16.7 Tier 1.5，v1.4.8 在本行收口）：该结论只在"单出口 + 当时那种请求密度"下成立，对**按 IP 计数**的限流**不成立**。Tier 1.5 落地后本行口径改为**「同一出口共用一条速率」**，值待实测标定 |
| 单账号请求数 | 刷新 = 2（`/api/user/self` + `/api/subscription/self`）；建 key = 2（创建 + 回查 `token_no`） | 少打一次是一次 |
| 上游并发上限 | 复用 `REFRESH_CONCURRENCY` | 不新拍一个数，避免手动/自动漂成两个并发度 |
| 登录重试 | **每号一次**，不重试 | 避免触发账号锁定 |
| keyword 搜索 | 留空拉全量再本地过滤 | 供应商搜索不可靠（文档 §8.5） |
| 删除上游 key | 无尾斜杠路径 | 带斜杠 307（文档 §8.4） |

27 个账号一轮刷新 ≈ 1 分钟。故：**一律异步任务**，不阻塞 HTTP。

> **本节的 0.6s 不是出口级规则**（v1.4.8 收口）：它是**每账号**的礼貌间隔，**管不住出口** ——
> 27 个账号各自守 0.6s，出口侧照样可以超速。出口级速率见 **§16.7 Tier 1.5**（同一出口共用一条速率，
> 值为占位、待实测标定）。本节其余各行的**值全部不变**，被收回的只有上表那条**依据**。

### 15.6 与既有口面的关系（非破坏清单）

**`supplier` 怎么设**：`POST /api/upstreams` 与 `PATCH /api/upstreams/:id` 接受可选 `supplier`
（`null` \| `"tierflow"`，默认 `null`），走既有的 `revision` + `change_log` 写入路径。

- **不另加 `accountPool: {enabled, provider}` 这类包装字段**：那会和 `supplier` 说同一件事，
  两个字段早晚漂成不一致。前端判据就是 **`upstream.supplier === "tierflow"`** —— 一个事实一个字段。
- 建/改上游表单里加**一个可选「供应商」下拉**（默认「通用」），只有这一处；
  选定后该上游**详情页**才出现账号池分区。通用上游的表单其余部分逐字不变。
- **host 判断留在后端**：前端不解析 `baseUrl` 猜供应商 —— 猜错会静默渲染出一个功能全 422 的分区。

| 处 | 变更 | 性质 |
|---|---|---|
| §2 `Upstream` 对象 | 新增 `supplier`、`accountCount`、`accountsBalance`、`accountsBalanceUnknownCount`、`keysBalance`、`unlimitedKeyCount` | **非破坏新增** |
| §2 `totalBalance` | 形状不变（`int \| null`）；**组成**改为 `Σ账号 quota + Σ无账号归属 key balance` | 组成修订，见 ADR-0018 决策 3 |
| §2 `POST/PATCH /api/upstreams` | 请求体新增可选 `supplier`（省略 = `null`） | **非破坏新增** |
| §2 `balanceUnknownKeyCount` | 口径改为 **`category='balance' AND unlimited=0 AND balance_cents IS NULL`** | 语义修订（见下） |
| **§2 余额解析顺序**（该段在 §2，不在 §14） | 三段扩为四段（尾插**账号型驱动**一档） | 顺序兼容：前两档判定逻辑不变 |
| §3 `KeyDto` | 新增 `unlimited: boolean` | **非破坏新增** |
| §3 `POST /api/keys` | 请求体、响应形状**零变更**；新增行为的只是 `createKey` 多了个可选入参 `unlimited` | 零变更（调用方无感） |
| §6 余额三口径 | 全局合计同规则；新增 `accountsBalanceUnknownCount`、`unlimitedKeyCount` | 非破坏新增 |
| §6 / §2 `byUpstream[]` | 新增 `accountCount`、`accountsBalance`、`accountsBalanceUnknownCount`、`keysBalance`、`unlimitedKeyCount`（与 §2 同名字段同义） | **非破坏新增**（v1.6.0 在示例中补全） |
| §6 `keys[]` 条目 | 新增 `unlimited: boolean`；**集合收窄为"无账号归属的 key"** | 非破坏新增 + 集合修订（v1.6.0，见 §6 规则 7） |
| §6 `currency` | 取值集合改为 **key 与账号两个贡献来源的并集** | 语义修订（v1.6.0，见 §6 规则 8） |
| §14.3 `points[]` | 新增 `unlimitedKeyCount`（列 `balance_snapshots.unlimited_key_count`） | **非破坏新增**（v1.6.0） |
| §14.3 `points[].knownKeyCount` | 由 `balanceKeyCount - unknown` 改为 **再减 `unlimitedKeyCount`** | 语义修订（v1.6.0，见 §15.6 订正） |
| §6 `GET /api/stats/balance` | 形状不变 | 零变更 |
| §14 自动同步 / 漂移 / 退避 / 单飞 | **零改动**（账号合计天然落进 `total_balance_cents`，派生值也从同一个聚合来） | 零变更 |
| §14.3 快照**点** | `knownKeyCount` 的推导式改一处 + 加一格 `unlimitedKeyCount`（列 `balance_snapshots.unlimited_key_count`） | **非零改动**（v1.6.0 订正；v1.4.0 原写"零改动"是不成立的，理由见下） |
| §15.2 `GET /subscriptions` 响应 | 补形状：`Page<SupplierSubscriptionRowDto>`（= §15.1 `SupplierSubscriptionDto` + `accountId` / `accountIdentifier`(掩码) / `upstreamId`），排序 `end_at ASC` + `NULL` 最后 | **非破坏新增**（v1.6.1 补白：冻结稿此前只给了端点名） |
| §15.2 `export` CSV 列 | 补首位一列 `upstreamId` | **非破坏新增**（v1.6.1；不带 `upstreamId` 过滤时，原列清单里没有任何一列能说明归属） |
| §15.2 `export` 机械形状 | 补 `Content-Type` / `Content-Disposition` / BOM / CRLF / RFC 4180 引号 / **公式注入防护** / 不分页 | **补白**（v1.6.1；实现时被强制的七条，此前未成文） |
| §15.2 `DELETE /:id` 响应与审计 | 补 `204` / 被拦不写成功审计 / `action = supplier.account.delete` | **补白**（v1.6.1） |
| `/v1/*` | **零变更**（数据面另见 §16） | 零变更 |

**`unlimited` 这一列为什么必须有**（不是"顺手加的"）：

- `upstream_keys` 现在只有 `balance_cents`，`NULL` 的语义被钉死为"**未知**"。而 TierFlow 的
  无限额度 key 上游给的是 `{unlimited_quota: true, remain_quota: -331119}` ——
  `remain_quota` 是个**无意义的负数**。没有这一列，无限额度 key 和"还没查到余额的 key"
  在库里长得一模一样，于是只能二选一：要么把 -331119 当余额渲染（错的），
  要么把它算进"余额未知"（于是仪表盘永久报警"有 N 把 key 余额未知"，而那 N 把根本没有余额概念）。
- 落法：`upstream_keys.unlimited INTEGER NOT NULL DEFAULT 0`。老库全部 `0`，
  所以既有的 `balanceKeyCount` / `totalBalance` / **既有不变量**全都不变。
- **v1.6.0 订正：「本次唯一动的既有聚合就是 `balanceUnknownKeyCount` 加一个条件」是错的。** 这句话在 v1.4.0 写下时漏了一个**推导值**：§14.3 快照点的 `knownKeyCount` 不是独立查出来的，它是 `balanceKeyCount - balanceUnknownKeyCount` —— **从上面那一处改动里算出来的**。无限额度 key 一旦不再计入未知，这个减法就会把它们**反过来数成"已知"**。所以本次实际动了**两处**既有聚合：
  - `balanceUnknownKeyCount` 加 `unlimited = 0` 条件（原计划内的那一处）；
  - **`knownKeyCount` 改写为 `balanceKeyCount - unknownKeyCount - unlimitedKeyCount`**，并给 `balance_snapshots` **加一列 `unlimited_key_count`**（§15.7 同批 `ALTER`、§14.3 已写明理由）。不加这一列，前端拿到的快照点 `known + unknown ≠ balanceKeyCount`，且**没有任何一格能解释少掉的那几把 key**。
- **不变量**（要写成断言）：
  - 未软删 key 满足 **`balanceKeyCount + tokenPlanKeyCount = keyCount`**（**既有不变量，保持不动**）
  - 且 **`unlimitedKeyCount ≤ balanceKeyCount`**、**`balanceUnknownKeyCount ≤ balanceKeyCount`**
  - 三者关系：`balanceKeyCount` 里，`unlimited` 是"无限额度"那一格，"未知"是"有余额概念但没查到"
    那一格，**互不重叠** —— 所以无限额度 key **不会**把 `balanceUnknownKeyCount` 顶上去。
  - **v1.6.0 新增（快照点口径）**：`knownKeyCount + unknownKeyCount + unlimitedKeyCount = balanceKeyCount`（§14.3 的 `points[]`）。各计数的来源必须是 `balance_cents` 与 `unlimited` 两列上的**互斥** `CASE`，不得用减法凑 —— 一个计数不是"总数减掉另两个"。
- **刻意不做的事**：不加第三种 `category`、不把 `balanceKeyCount` 改成"排除 unlimited"。
  那两种做法都会动到既有字段语义，而它们要解决的问题（"无限额度别报未知"）
  用 `unlimitedKeyCount` 一个平行计数就够。
- 前端渲染：无限额度 key 的 `balance` 是 `null`，但**必须**配 `unlimited: true` 徽标，
  显示"无限额度"而**不是** `—` 或"未知"。**`unlimited` 优先于任何负值**：同一把 key 上两者
  同时出现时显示无限额度徽标，不显示数字（不会出现"无限额度 −¥0.16"）。

### 15.7 迁移与鉴权

- `SCHEMA_VERSION` **不递增**，但**必须真发 `ALTER`**：
  - `supplier_accounts` / `supplier_account_subscriptions` / `supplier_account_keys` 是**纯加表** ——
    `CREATE TABLE IF NOT EXISTS` 每次开库直接生效，够了。
  - `upstreams.supplier`、`upstream_keys.unlimited`、`upstream_keys.model_limits`（v1.4.2）、
    **`balance_snapshots.unlimited_key_count`（v1.6.0）**是
    **给既有表加列** ——
    **只改 DDL 文本对已经在跑的库没有任何作用**，`CREATE TABLE IF NOT EXISTS` 遇到已存在的表是空操作。
    必须走 `migrate()` 里 `hasColumn()` 守卫的 `ALTER TABLE … ADD COLUMN`，
    照 `request_id` 那一批的先例（`src/db/schema.ts` v1.1.1 段）。
    - **`balance_snapshots.unlimited_key_count INTEGER NOT NULL DEFAULT 0` 是老表加列**（它在 v1.3.0 就建了），
      所以它在**同一个 `ALTER` 批次**里，不能只靠改 `CREATE TABLE` 文本 —— 已经在跑的库不会重建表。
      老快照填 `0` 正是对的：加 §15 之前不可能存在 unlimited key，那一刻该格本来就是 0。
      它的存在理由见 §14.3（`knownKeyCount` 是推导值，没有这一格就对不上账）。
  - 守卫**必须是 `hasColumn()` 而不是 `user_version`**：`ALTER TABLE ADD COLUMN` **不幂等**，
    重复执行直接抛 `duplicate column name`，把启动一起带走。
  - `upstreams.supplier` 可空无默认；`upstream_keys.unlimited INTEGER NOT NULL DEFAULT 0`
    （有默认值，老行填 0，正是我们要的语义）；`upstream_keys.model_limits TEXT` **可空、无默认**
    —— 老行填 `NULL` 正好等于"不限模型"，与加列前的行为逐字一致。**空串 / 空 CSV 一律归一化为 `NULL`**，
    不落 `''`：库里两个值、语义一个值，早晚有人按 `''` 写查询（§3 / §15.2 同一条归一化规则）。
  - **`unlimited = 1` ⇒ `balance_cents` 必须落 `NULL`**（v1.4.5）。这是**写路径强制的落库规则**，
    不是渲染约定 —— 渲染约定管不住"库里存了什么"。上游对无限额度 key 回的是
    `{unlimited_quota: true, remain_quota: -331119}`，那个负数是**无意义占位**，不是"欠费"。
    一旦把 `-331119` 落进 `balance_cents`，网关的可用性过滤是 `balance_cents <= 0 → 排除`
    （`src/gateway/key-pool.ts`），这把 key 就被**静默排除出选路**：不报错、不告警、不进冷却，
    客户端只看到「没有可用 key」——**没有任何一处能追**。落 `NULL` 则走既有的
    「未知 ≠ 0，仍可用」分支；「无限额度」这件事全靠 §3 的 `unlimited` 徽标表达。
    配套钉一句：**网关不消费 `unlimited`**（`KeyConfig` 无此字段，选路只看 `category` + `balance_cents`）——
    正因为网关不读它，这条落库规则才是「网关侧零改动」成立的前提，而不是可选项（§16.3）。
  - 用户版本号仍是 `2`：没有数据搬迁、没有重写表，只是补列补表 ——
    与 v1.1.1 加 `request_id` 时同一条判断。
- 鉴权：同 §0.5 登录会话，**不使用** `READONLY_TOKEN`（带只读令牌打进来 → `403 FORBIDDEN`）。
- 审计：四个批量端点各写一条 `audit_log`（`action` = `supplier.import` / `supplier.refresh` /
  `supplier.keys.create` / `supplier.keys.sync`），`detail` **只放计数**，不放 identifier 列表、
  不放任何凭据。
  - **v1.6.1 补登两个动作**：`supplier.export`（`detail = "rows=N"`）与
    `supplier.account.delete`（`detail = "force"` / `null`）。两者的判定与 `detail` 口径同上一段。
  - **v1.6.3 补登两个动作**：`supplier.account.login`（`detail = "status=<status>"`）与
    `supplier.account.test`（`detail = "ok=<0|1> httpStatus=<n> loginAttempted=<0|1>"`）。
    两个都是**同步**端点、都**真的打一次上游**，口径同上 —— 只放计数 / 标志。
    `login` 失败**不写 `result: 'fail'`**：请求本身是成功的，结论已如实写在响应的 `status` 上；
    写成 `fail` 会让审计读起来像"这个请求出错了"。`:id/test` 与 §2 的 `balance-template/test`
    同款：**不写业务状态、但仍写一条审计**。
  - **`export` 是 GET 却写审计，这是刻意的**：§6 的"登录 / 登出 / 所有写操作"是**下限不是上限**，
    而批量导出是账号面上唯一一次"把全部账号清单一次性带出后端"的动作 —— 不留痕的话，
    "谁在什么时候导过名单"事后完全不可查，而这是最该可查的那一件事。
    这条只改"审计覆盖面"，**不改鉴权面**：`export` 仍是普通管理会话（§0.5），
    **不使用** `READONLY_TOKEN`，与本节其余端点同。
  - 被拦下的写（如 `409 ACCOUNT_HAS_KEYS`）**不写成功审计**：留一条 `ok` 会让人以为删成了。

### 15.8 本期裁定速查（原画师六问 + 两处跨车道冲突的裁决）

| # | 问题 | 结论 | 落在哪 |
|---|---|---|---|
| 1 | 逐行结果要不要 `Task.items[]` / 新端点 | **都不要**：留在 `result.items`，**终态才出现**，上限 500 + `truncated`/`itemsTotal`，本期不分页 | §15.3 |
| 2 | 密码的出入口 | **只进不回**：请求体收，响应/日志/审计 detail/任务 result/错误 message/`raw` 一律没有。出口只有掩码 `identifier` | §15.0 / §15.2 `export` |
| 3 | 明文 key 是否经浏览器中转 | **不经**。服务端自己去上游取、当场加密落库，只回 `keyId`+`keyMasked` → 前端做**回执浮层**，不做"一次性明文"浮层 | §15.2 `keys` |
| 4 | 金额口径 | 换算在**后端**，`quota_per_unit` **每次从上游读**；本面货币字段一律 `…Cents`(int 分)，`Math.round` 不截断 | §15.1 |
| 5 | `unlimited_quota:true` + `remain_quota:-331119` | `balance = null` + `unlimited: true` 徽标，**绝不**渲染负数；需新增 `upstream_keys.unlimited` 列 | §15.6 |
| 6 | 套餐算不算 key | **不算**。套餐挂**账号**，不建 `category='token-plan'` 行 → 表格是**两级**（账号 → key），套餐是账号下的第二个分区 | 见下 |
| 7 | 会话从哪来、怎么退场 | 会话型凭据**只走离线一次性导入**（不经 HTTP、不进仓库/日志/聊天），入库即视为该文件作废 | §15.9 |
| 8 | 套餐能不能进池被网关"先烧" | **不能**。套餐 key 只拿得到掩码 → 本上游池内**没有** `token-plan` 行 | 见下 |
| 9 | 密码与会话孰为第一事实源（2026-10-07 二拍） | **密码型是第一事实源，会话型是冷备 / 加速通道**；一个账号只建一行，两路输入汇入同一行，`credentialSource` 取 `password`；会话过期由存档密码自动重登续命 | §15.9 |
| 10 | key 的模型白名单放哪（v1.4.2） | 新增 `upstream_keys.model_limits` + §3 `models`，**只读**（上游事实）；`null` / 空 = 不限（与网关 `matchesModel()` 冻结口径一致）。本地覆盖是 P6 `key_models` 的事，本期不做 | §3 / §15.2 / §16.3 / §16.5 |

**第 6 问展开（这条最容易被做成错的形状）**：

不把套餐建成 key，三个理由：

1. **余额粒度不对**。套餐余额是 `(amount_total - amount_used)`，是**账号级**的量；
   `category='token-plan'` 的 key 行只有一个 `token_plan_remaining` 字段，装不下
   `amount_total/amount_used/basic_token_*/paid_cents/有效期` 这一组，也不该装。
2. **套餐 key 我们只拿得到掩码**。`GET /api/subscription/self/token?sub_no=` 返回
   `{"key": "sk-k58R**********vFnt", "masked": true}` —— 建行等于造一把**不可用凭据**，
   正是 ADR-0018 决策 2 拒绝的事。
3. **它是 N 个，不是 1 个**。上游给的是 `all_subscriptions: []`，一个账号可叠多个套餐。

所以：`SupplierAccount.subscriptions[]` 是账号下的**独立分区**，
`upstream_keys` 里**没有** `subscription_id` 这种外键 —— 套餐与池内 key 之间只有
"后 4 位掩码可能对上"这一条弱对账关系（§15.2 `keys/sync`）。

**前端形状**：账号表格 **两级** —— 账号行 → 展开是「池内 key（N 把，有 `unlimited` 徽标）」
+「套餐（M 个，显示剩余额度与到期）」。**不要在 key 下面再挂套餐**，那会暗示
"这把 key 属于这个套餐"，而事实是"这个账号买过这些套餐"。

**第 8 问展开（跨车道冲突的裁决，2026-10-07）**：路由者与画师在上一轮都按
"套餐 key 建 `category='token-plan'`、参与 ADR-0011 的「token-plan 优先于 balance」排序"写过影响面，
**与第 6 问的结论相反**。本节按第 6 问落：**套餐不建 key**。由此产生三条必须一起生效的推论：

- **本上游池内没有 `token-plan` 行**，所以 ADR-0011 的"先烧套餐再烧余额"对 TierFlow
  **不适用** —— 池内只有 `category='balance'` 的行（含 `unlimited=1` 的无限额度行）。
  排序口径本身**零改动**，只是本上游没有第一档的输入。
- 套餐的"剩余"只在**账号面展示**（`subscriptions[]`），**不进** `totalBalance`、
  **不进** §14 快照、**不进**任何网关准入判断。
- 若将来 `/api/subscription/self/token/rotate` 经实测确认能取回明文，且 Bo 决定要"先烧套餐"，
  那是**独立的一次契约变更**（新增 ADR + 改本节），不在本期范围内 ——
  该端点在供应商文档里自己标的是「未实测」，不能拿它当既成事实写进契约。

**第 2 问补充**：`uid` 是本对象里唯一**不掩码**的账号标识（它是内部数字 ID，不是凭据）。
`username`（`user_j4iCrFEB`）与上游站点登录名同值，同样不掩码 —— 但**它不是登录凭据**，
登录凭据是 `identifier`(手机号) + `password`，`password` 永不出口。

### 15.9 凭据来源与会话生命周期（v1.4.0 新增，v1.4.1 补双路径定位）

本节的账号凭据有**两条来源**，纪律同一条：**只进不回、用后即弃**。

**两条路径的定位（2026-10-07 二拍，Bo 提出"也可以密码接口批量登录"）**：
**密码型是第一事实源，会话型是冷备 / 加速通道**，两者并存、不互斥 —— 不是"先会话、以后再换密码"的临时态，
而是会话到期后**由存档密码自动续命**的长期形态。用户侧没有任何一步必须提供会话文件。

| 来源 | 载体 | 入口 | 能否自动重登 |
|---|---|---|---|
| **密码型**（第一事实源） | 人工维护的「手机号,密码」清单（粘贴 / CSV） | `POST /api/supplier-accounts/import` 的 `text` | ✅ 会话过期用存档密码重登 |
| **会话型**（冷备） | 操作员本地的一份**离线导出文件**（手机号 → uid / session / username / quota） | **离线一次性导入**（非 HTTP），见下 | ❌ **无密码即无法重登** |

同一 `identifier` 两路都到过时，`credentialSource` 取 **`password`**（密码是超集能力：有密码就一定能登，
有会话不一定）—— 这是一个账号只有一行，两路输入**汇入同一行**，不建第二行。

**会话型导入的四条纪律**：

1. **不进 HTTP 面**：不给 `/api/*` 开"提交会话值"的入口 —— 那个端点一旦存在，
   浏览器、代理日志、前端 `localStorage` 就都成了会话明文的过路点。会话型导入只由
   **操作员在本机执行一次性导入**完成，路径由**运行时环境变量**给出（不写进配置仓库、不写进文档正文）。
   **前端不提供任何会话值输入控件**："粘贴会话"这个词在本契约里只指**操作员在其本机导入脚本里粘贴**，
   不存在"页面上贴 cookie"这条路径（ADR-0018 备选方案表最后一行就是否决它的理由）。
2. **不经 Agent / 不进本仓**：该文件的内容**不读入任何 AI 会话上下文、不进 git、不进日志、不进聊天记录**。
   仓库里只有"如何导入"的说明，没有值本身。
3. **入库后即视为该文件作废**：`session_cipher`（aes-256-gcm，`MASTER_KEY`）落库成功后，
   该文件即完成使命 —— 之后的余额同步只读库里那份密文。文件由操作员自行销毁。
4. **会话只服务管理面**：`session` / `TF-User` **绝不**写入 `upstream_keys`、**绝不**进入
   网关侧的 `SecretResolver`。网关只吃 `sk-` 明文 + `baseUrl`（§16）。

**已知代价（写在这里，不留给以后发现）**：**只有会话、没有密码的账号，会话一过期就回不来**。
`session_expires_at` 到期后 `refresh` 无法自动重登（无密码可登），该账号落 `status="session_expired"`，
需要操作员**再次执行一次性导入**（贴新会话）或**补录密码**（走 §15.2 `import`）。
所以：长期看，**密码型凭据才是完整形态**，会话型导入是"先把今天的余额接进来"的过渡通路。
**这条不是缺陷，是取舍** —— 会话型入口的价值就在于不必先拿到 27 个密码。

- **`quota` 字段（离线文件里带的）只当首次对账参考**，**不入库为余额**：
  入库后余额一律以管理面拉取为准（ADR-0017：上游接口是余额唯一事实源）。
- **3 个登录失败号不丢弃**：导入时记 `status="login_failed"` + `statusMessage`（供应商错误码），
  否则"这个号为什么不在列表里"会重复发生。
- 到期时间：文件里的会话有效期由操作员说明给出（本次为**约 30 天**），
  写入 `session_expires_at` 供前端提示"需重登"；**它是估计值，不是保证值** ——
  真实失效由"下次查询返回 401"来证实，证实即落 `session_expired`。

**重登：触发、互斥、节奏（v1.4.1 补）**

重登 = 用存档密码调 `/api/user/login` 换一枚新 `session`（+ `TF-User`），覆写 `session_cipher`
并更新 `session_expires_at`。它是**唯一**会把 `session_expired` 拉回 `active` 的路径。

| 触发 | 时机 | 行为 |
|---|---|---|
| **被动** | 任一管理面请求（`refresh` / `keys` / `keys/sync` / `import` / `:id/test`）收到 401/403 | 用存档密码重登 **1 次** → 成功则**重试本次请求一次**；再失败 → `status="login_failed"`，本轮到此为止 |
| **主动** | §14 定时同步开始时，账号同时满足 `credentialSource="password"` 且 `sessionExpiresAt - now < 24h` | 先重登、再刷余额 —— 把失效挡在这一轮**之前**，而不是等它变成一轮 `failed` |

- **`credentialSource="session"` 的账号两路都不触发**：直接落 `status="session_expired"`，
  连一次注定 401 的请求都不发。这正是 `credentialSource` 这个字段存在的理由 ——
  它让"该不该试着重登"在**发请求之前**就有答案。
- **不新增调度器**：主动重登挂在 §14 **已有的**定时同步上（ADR-0018 决策 4「不新造第二套节拍」），
  不引入 cron、不引入第二套退避参数。
- **账号级互斥**：同一账号的重登与刷新**共用一把账号级锁**，并共用 §15.5 的 0.6s 串行队列 ——
  27 个账号并发重登就是自己撞自己的登录接口，也正是站点风控最容易抓的形状。
  **但账号级锁只管得住账号级**：出口侧另有 **IP 级**限流（§16.7 Tier 1.5），
  27 把账号锁各自守规矩，出口仍可能超速 —— 两层都要，缺一层就等于没有。
- **每号一次**：与 §15.5 登录口径一致，**失败不重试、不循环**（避免触发账号锁定）。
  连续 `login_failed` 的账号**不自动重试**，由操作员在页面上手动触发 `:id/login`。
- **升级路径**：`credentialSource="session"` 的账号经 `import` 补录密码（同一 `identifier`）后，
  该行**就地**升级为 `"password"` 并纳入自动重登 —— 不新建行、不改 `id`；
  这也是把冷备升成完整形态的**唯一**路径。

### 15.10 Python 工作台退役与数据迁移口径（v1.5.1 补成文，ADR-0018 决策 6）

**工作台退役**（Bo 2026-10-07 拍板，M6-D）：接入本节之后，Python 工作台**不再写任何数据**，
它没有独立的数据面地位，**不构成第二事实源**。

- **`workbench.db` 不迁移**。那里面唯一不可再生的只有**账号清单与密码**（人工维护的「手机号,密码」
  清单）；其余（余额、掩码 key、套餐）都是**可从上游重新拉取的派生数据**。
- **账号靠导入重建**：走 §15.2 `import` 的 `text`（粘贴 / CSV，容忍表头 / `+86` / 空格 / 分号），
  **不写迁移脚本、不做库对库搬运**。
- **旧 29 把掩码 key 作废、不回捞**：掩码不可逆（ADR-0018 决策 2），回捞只能重登去取；统一按
  §15.2 `keys` **重新建 key** 入池 —— 这正是"批量新建 key 是唯一入池通路"的落地形态。
- **工作台的批量建 key 思路不独立移植**，而是融入本节**作为供应商内建能力**：逐行 import / 建 key
  都是 §15.2 的既有端点，**不新增端点、不新增任务类型**。
- **数据面路径按双凭据重建**（手机号 + 密码 = 第一事实源，§15.9）：数据面出口是 §16 的接入约束，
  与工作台的转发实现**无关** —— 工作台退役**不改变 §16 的任何结论**。

### 15.11 S1 冻结记录（2026-10-07，Bo 拍板）

本节的冻结口径已随 v1.4.0 / v1.4.1 / v1.4.2 逐条落入正文。本小节只做一件事：**把"哪些已冻结、
落在哪"钉成一张表** —— 免得后来者按派单文字在正文里找不到，或者把已落下的事重做一遍。

| S1 冻结项 | 正文落点 | 状态 |
|---|---|---|
| **凭据双路径**：手机号 + 密码 = 第一事实源；会话 = 冷备 / 加速通道 | §15.9（四条纪律 + 重登触发 / 互斥 / 节奏） | ✅ v1.4.0 / v1.4.1 已冻结 |
| 批量登录 **0.6s 串行、每号只登一次**、失败号留 `login_failed` + 供应商错误码 | §15.5 + §15.9 | ✅ 已有（**注意**：§15.5 那行"0.6s 依据"已按 §16.7 降级，**值不变**） |
| 会话导入 = **一次性、用后即弃**，不进 HTTP / 本仓 / 日志 / 聊天 | §15.9 纪律 1–4 | ✅ 已冻结 |
| **账号级余额** = Σ账号 quota + Σ无账号归属 key 余额（防双算） | §15.6 + §6 规则 1 / 2 / 5 | ✅ v1.4.0 已冻结 |
| 「无限」与「未知」**分列**（`unlimitedKeyCount` / `balanceUnknownKeyCount`） | §15.6 + §6 规则 6 | ✅ 已冻结（v1.5.1 在 §6 补成文；**v1.6.0 补派生值与快照列** —— 见下） |
| **通用模板不加换算字段**（个例不外溢） | §2「余额查询解析顺序」末注 | ✅ v1.5.1 补成文 |
| **解析顺序四段**（尾插 ③ 账号型驱动） | **§2**（**不在 §14**） | ✅ v1.4.0 已冻结 |
| **Python 工作台退役、`workbench.db` 不迁** | §15.10 | ✅ v1.5.1 补成文（ADR-0018 决策 6 早有，**正文此前没有**） |

> **两条纪律的边界要说清**：① `credentialSource` 与 `hasSession` **正交**（§15.1），不得写成一对；
> ② 会话型导入的**文件路径由运行时环境变量给出**（§15.9 纪律 1）—— **本契约正文不写它的名字或路径**。
> 后者不是遗漏，是纪律：**写下路径就等于给"去哪里找那份会话"留了一条索引。**

> **S2 落地的三处订正（v1.6.0，代码已落 `dev/api @ e76a2d6`）**：上表八项**口径本身全部不变**，
> 但其中三项在写代码时被撞出"**冻结稿那句话描述的不是代码里的事**"：
> ① 第四口径（第 4 行）的归属载体 —— 冻结稿写的 `/upstream_keys.account_id` **不存在**，归属本来就在 `supplier_account_keys.pooled_key_id` 台账上（§15.2 `DELETE`）；
> ② 「无限与未知分列」（第 5 行）的**连带走漏** —— 分列本身对，但**还有一个推导值** `knownKeyCount` 是从同一个聚合算出来的，改一处必须改两处外加一列（§15.6 / §14.3）；
> ③ 第四口径让「钱全在账号上」成为常态，于是 §6 `currency` 只查 key 的口径**漏了一张表**（§6 规则 8）。
> 三条的完整理由与订正文字分别在 §15.2 / §15.6 / §14.3 / §6。

---

## 16. TierFlow 数据面（`/v1/*`）接入约束（v1.4.0，路由者车道）

本节只登记**数据面**（网关转发链路）的接入约束。管理面在 §15；路由者的实现影响面另见 ADR-0018「影响」。

### 16.1 一个必须在 S2 之前钉死的未知

供应商文档里出现过的端点（`/api/token/`、`/api/user/login`、`/api/subscription/self/token`、`/api/status`）
**全部是管理面**。数据面（relay）路径**至今没有任何人写出来过** ——
既没有出现在的契约里，也没有出现在三方任何一份影响面清单里。

| 实测结论 | 后果 |
|---|---|
| 存在 OpenAI 兼容 relay | 按通用上游接入，`KeyConfig` / `KeyPool` **零签名改动** |
| **只有自有协议** | 这家**接不进通用上游** —— 性质从"改两处"升级为"要 Bo 重新拍板"，必须升级处理，不能就地糊 |

**判据按默认假设试**：`baseUrl = https://tierflow.cn` + OpenAI 兼容路径。
**实测未完成前，本节其余条款不产生实现义务**（别按未证实的形状写代码）。

#### 16.1.1 悬空件登记：数据面实测（**不得挂成"路由者随后自测"**）

这个未知**没有任何一个 AI 会话能自己消掉**，登记如下 —— 写成"某车道随后自测"会变成一条永远
没人认领的待办，届时以"契约没冻结"或"没人给凭据"两种形式各卡一轮。

| 项 | 口径 |
|---|---|
| **未知** | 数据面 relay 路径与协议；以及 P1–P4 四类错误体的形状与时序 |
| **执行主体** | **凭据持有者本人（Bo）**；或**由他在运行时把凭据注入执行环境后、明示指定的执行会话（含管家）代跑** —— 见 §16.6。**路由者不是执行主体**，只出探针与结论 |
| **为什么不是"某车道随后自测"** | 两个 AI 会话都不持有凭据、也不读任何凭据文件（账号凭据在授权工作区 `C:\WorkSpace\sub` 之外；§15.9 纪律 2 明写会话值"不经 Agent / 不进本仓"）。**但"AI 不持凭据"≠"AI 不能代跑"**：凭据由 Bo 在运行时注入环境后，代跑者只面对"环境里已有的一枚网关 key"，永远不接触账号密码 / 会话文件 —— 这条区分是 v1.4.3 改锚的实质（见 §16.6） |
| **产物** | `pnpm probe:tierflow` 的**脱敏报告**（P0–P4，只打 stdout、不落盘、全量 `scrubCredentials`） |
| **回执** | 报告整段贴回本群（凭据不会跟着出来）。**不需要**贴 cookie / 密码 / 任何明文 |
| **执行前提** | `PROBE_KEY` + `PROBE_MODEL` 由执行者运行时注入（P4 另需 `PROBE_EXHAUSTED_KEY`）；值不落 `.env`、不提交、不进聊天 |
| **收口** | 路由者：拿到报告当天钉 §16.2 的 pre-first-chunk 改判与本节的数据面路径（执行主体不是他，结论是他的交付） |
| **兜底** | Bo 不跑、也不转述结果 → 本节保持"未实测"，**S1 与之相关的字段一律留 `null` 占位**，按默认假设接入但不写 `classify` 改判；**不因为"缺数据"就跳过而当成已确认** |

> **与 §15.9 的边界对齐**：这里注入的是**最终产物**（`sk-` 明文 + baseUrl + 路径），不是账号凭据。
> 探针不需要知道 key 是谁建的、从哪来 —— 会话型导入那条路径（谁下单、谁持有 cookie）与本节无关，
> 但两条的纪律是同一条：**凭据经过谁，都要在事前说清楚**。

#### 16.1.1.a 已收旁证：路由者的**无凭据**探针（2026-10-07 群内报告，v1.6.0 落地收存）

路由者在群内报回过一次**不需要任何凭据**的探针结果（他持无凭据，故这次探针本身不含 `PROBE_KEY`）。
按 PM 派单"管家落 §16.1.1 待实测块时收下"，**登记为旁证，不登记为实测结论**：

| 观测 | 内容 |
|---|---|
| 错误体形状 | 全部是 **OpenAI 形状** `{ "error": { "message", "type", "code" } }` |
| 一条分叉 | 畸形 / 缺失凭据 → **401**；另一条路径上出现 **403 `routing_override_forbidden`** |
| 凭据面 | **零凭据**：不给 key 也拿得到上述响应 |

**这条旁证能定什么**（可以落进实现的部分）：

- 该 host 上**存在一个说 OpenAI 形状错误体的面**，且它在**鉴权之前**就有一层自己的判定 ——
  `routing_override_forbidden` 这种码不是 OpenAI 官方错误码表里的东西，是**它自己加的一层**。
  这削弱了 §16.1「只有自有协议」那一支的可能性，但**不等于推翻**。
- **错误体形状可依 OpenAI 口径处理**：解析 `error.code` / `error.type` 的那条读法至少不会白写。

**这条旁证不能定什么**（这就是它仍是"未实测"的原因）：

- **形状（未鉴权面的错误体形状）≠ 协议（已鉴权面的成功体与 relay 路径）**。403 是在**鉴权之前**发出的，
  它证明的是"这层网关长这样"，**不是**"拿到 key 之后 `/v1/chat/completions` 就能跑通"。
  一个自有协议后端完全可以在前面套一层 OpenAI 形状的错误网关。
- **P1–P4 四类错误体的形状与时序一条都没定**（余额耗尽 / 令牌失效 / 限流 / 上游 5xx 在**已鉴权**路径上是什么样），
  §16.2 的 pre-first-chunk 改判**依据不足，仍不改判**。
- **数据面 relay 路径仍未证实**：没有一次**带 key 的成功往返**（TTFB、SSE 帧形状、`model` 取值），
  本节的判据表（存在 relay / 只有自有协议）**两行都还是候选**。

> **纪律（写下来免得被当成已确认）**：这条旁证**不进 §16.5 的字段对账**、**不触发 §16.2 的 `classify` 改判**、
> **不改变 §16.6 的三项占位值**，S1 相关字段**继续留 `null` 占位**。
> 兜底规则不变：**不因为"缺数据"就跳过而当成已确认**（本节表格「兜底」行）。
> 无凭据探针**可以反复跑**（它不消耗任何凭据）—— 但重复跑同一形状不增加证据量，
> 真正把 P0 推过线的仍是**一次带 key 的成功往返**，那一步只能由 Bo 注入 `PROBE_KEY` / `PROBE_MODEL` 后跑。

**v1.6.2 订正与补登（路由者第二轮无凭据探针，2026-10-07）**

**① 订正一处判据（不改结论量级）**：上表那句「畸形 / 缺失凭据 → **401**；另一条**路径**上出现 **403**」
里的「**路径**」是**误导**。实测三条把分岔条件隔离出来了：

| 探针 | 请求 | 结果 |
|---|---|---|
| P0a | `GET /v1/models`，**无** `Authorization` | **401** `code:""`，`Invalid token` |
| P0b | `GET /v1/models`，**畸形** `sk-` | **403** `code:"routing_override_forbidden"` |
| P1 | `POST /v1/chat/completions`，**畸形** `sk-` | **403** `code:"routing_override_forbidden"` |

⇒ 401/403 的分岔由「**请求头里有没有 `Authorization`**」决定，**不由路径、也不由 key 是否有效**决定。
上表那句应读作「403 出现在**带了 `Authorization` 头**的那一侧」。**旁证的性质不变**
（仍是旁证、仍不进 §16.5、仍不改 §16.2 改判、仍不改 §16.6 占位值）。

**② 补登：P0 的「路径存在性」这一半已定** —— 三条都是 **401/403 而不是 404** ⇒ 该 host
**实现了** `/v1/models`，§16.1 判据表里「**只有自有协议**」那一支**进一步削弱**（再削一次，仍不推翻）。
**已鉴权面的协议兼容性一条都没定**：没有一次带 key 的成功往返 ⇒ TTFB、SSE 帧形状、`model` 取值、
§16.2 的 pre-first-chunk 改判依据**全部仍缺**，S1 相关字段**继续留 `null` 占位**。

**③ 补登一处新风险（未证实，不进字段对账）**：**畸形 `sk-` → 403 `routing_override_forbidden`**
（码值为 `routing_override_forbidden` 而非鉴权类码，看着是**路由覆盖**语义，未必等于"鉴权失败"）。
而 403 在 `classify.ts` 落 `AUTH_INVALID` ⇒ 计 key 失败 + 进冷却。**若一把有效 key 在某种写错的
客户端参数下也能拿到它，一个调用方的低级错误就会把整池 key 烘掉** —— §10 铁律要防的正是这个。
**完全未证实**：要 P0 的带 key 往返才能定。**登记，不据此改 `classify`、不据此动冷却**；
实测形状与推论同见 §16.7「v1.6.2 实测登记」第 (4) 条。

**v1.6.3 账号面 Tier B 落地（管家，2026-10-07）**

§15.2 六个「要打上游管理接口」的端点接线落库（`dev/api`），同步补登 §15.7 的两个审计动作。
本版**只补白，不推翻任何既有口径**：

**① 六个端点全部按 §15.2 既有约定实现，零契约改动**：`import` / `refresh` / `:id/login` /
`:id/test` / `keys` / `keys/sync`。四个批量端点回 `202 {taskId}`，结果在任务终态 `result`
（§15.3 形状，`ok + failed + skipped = total`）；`:id/login` 与 `:id/test` 是**同步**端点，
回 `200`。**不新增端点、不新增字段、不改 DTO**。

**② `skipped` 的口径成文**（§15.3 列了四个计数但**从未定义 `skipped`**）：
**`skipped` = 没做过的行**，落两处 —— 解析不了的行（`LINE_PARSE_FAILED`，§15.2 `import`
「解析失败的行跳过并逐行报原因」）与命中排除名单的行（`EXCLUDED_IDENTIFIER`，§15.9）；
**`failed` = 做过但不成的行**。于是 `ok + failed + skipped = total` 恒成立 ——
这是操作员唯一能拿来核对的等式，四个计数必须自洽。
要点是**解析失败归 skipped 而不是 failed**：它确实"没做过"。
两种读法都说得通，所以它必须是**一处**决定，不能两个端点各写一套。

**③ §15.7 补登两个审计动作**：`supplier.account.login`（`detail = "status=<status>"`）与
`supplier.account.test`（`detail = "ok=<0|1> httpStatus=<n> loginAttempted=<0|1>"`）。
理由：§15.7 原来只登记四个批量端点 + v1.6.1 补的两个，而 `:id/login` 会**真的打一次上游登录
并改写会话**，是本面上最该留痕的动作之一；`:id/test` 与 §2 的 `balance-template/test` 同款
（**不写业务状态、但仍写一条审计**）。两个 `detail` 同样**只放计数 / 标志**，不放凭据。
`login` 失败**不写 `result: 'fail'`**：那会让审计看起来像"这个请求出错了"，而请求本身是成功的
（结论已如实写在响应的 `status` 上）。

**④ 一处实现订正（无契约影响）**：`replaceSupplierAccountKeyLedger()` 里
`db.transaction(fn)` **只构造事务、不执行**，漏了调用 `()` ⇒ `keys/sync` 长期"报成功、
一行没写"，而调用方看到的是 `rows: 2`。新写的路由层用例把这个静默空转照出来了。
它不改契约、不改 DTO，但它解释了为什么台账可能与事实分叉（`keyCount` 偏小 ⇒
删账号的 409 判定跟着失效）。

**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、
`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL 改动。**

### 16.2 上游返回 `200` + `success:false` 的识别窗口（**pre-first-chunk**）

文档 §1.2 / §8.2 明说业务错误**通常返回 HTTP 200**，成败看 `success` 字段。而
`classifyUpstreamStatus()` 是**纯状态码驱动**（401/403/402/429/≥500）。若 `/v1/chat/completions`
也走 200 + `success:false`，则余额耗尽 / 令牌失效会被判成**成功调用** —— 不计失败、不进冷却、
还 `reportSuccess`，死 key 永远被选中，直接打穿「单 key 故障 100ms 内切换」。

**改动边界（路由者划定，本节收下）**：

- 识别**只在 stream 首包发出之前**生效；判定为失败时按既有 Terminating 语义处理，客户端只看到一次
  正常的上游错误响应。
- **首包一旦发出，就不得再改 HTTP 状态**：只能记失败、进冷却、切换重试。
  "客户端先收到 200、随后断流"就是**有感知**，直接违反 §10 的验收口径。
- 因此这是 **pre-first-chunk 的识别**，不是响应结束时的整包校验 —— 后者在 stream 模式下没有落点。

### 16.3 key 映射（1:1，无需改 `KeyConfig` / `KeyPool`）

| TierFlow | 我们已有字段 |
|---|---|
| 普通 key（`unlimited_quota=true` / 固定 `remain_quota`） | `category='balance'`，其余**只落 `balance_cents`**（§15.6 / §15.7）。**网关不消费 `unlimited`** —— `KeyConfig` 没有这个字段，选路只看 `category` + `balance_cents`。因此 `unlimited=1` 的行 **`balance_cents` 必须落 `NULL`**：上游那个 `remain_quota: -331119` 是占位负数，落进去会被 `isUsable` 判成"没钱"而**静默排除出选路**（无报错、无告警、无冷却） |
| `model_limits_enabled` + `model_limits` CSV | `upstream_keys.model_limits` → §3 Key 对象 `models` → `KeyConfig.models` —— 白名单语义正好对上 `matchesModel()`（v1.4.2 补齐了中间那一跳：在此之前 CSV 只映射到了网关字段，**管理面根本没有一列装它**，网关拿不到值） |
| `status: 1\|2` | `KeyStatus enabled\|disabled` |

一个上游挂多 key 是**既有能力**；`getAvailableKeys` / `reportFailure` / `reportSuccess` 签名**零改动**。

> **v1.4.2 的落地缺口，点名给路由者**：`KeyConfig.models` 字段**早就存在**且 `matchesModel()` /
> `keyModels()` 语义完全够用（`null` / 空 = 不限、非空 = 白名单、`*` 通配），**但 `src/wiring/store.ts`
> 至今把每个 key 的 `models` 硬编码为 `null`**（原注释："档案里没有 key→模型 的关联，故按 upstream 继承"）。
> 管理面加了列、DTO 加了字段之后，**还差的不是"一行"，是 4 处 + 1 个 spec**（v1.4.5 订正量词，
> 路由者对了一遍代码）：`KEYS_SQL` 选出该列、`KeyRow` 加 `model_limits`、一个解析函数
> （`null` / `''` / 纯空白 → `null`，CSV 去空白丢空项，`*` 原样透出）、`store.ts` 取值
> `models: parseModelLimits(k.model_limits)`；外加一例回归（`KeyDto.models=['a']` →
> `getAvailableKeys('b')` 不含该 key）。
> **前置在这张契约的落地面上**：`model_limits` 列本身由 §15.7 那批 `ALTER` 提供（v1.4.5 已落
> `src/db/schema.ts`）—— 列不存在时 `prepare` 直接抛 `no such column`，是**数据面崩**
> 而不是静默降级，所以读侧必须等这次 DDL。
> **可达性（v1.4.7）**：这批 `ALTER` 的 **canonical 落点只有一处** —— `src/db/schema.ts` 里那批
> `hasColumn()` 守卫语句。**车道基线早于它时，按路径取件把这批 `ALTER` 搬到自己的基线上，
> 不派生第二份 `schema.ts`**；两份同名文件各自演化，比"等一次取件"贵得多，
> 且它的崩法（`no such column`）只在开库那一刻露面。
> 这是**取值改动，不是签名改动** —— `KeyConfig` / `KeyPool` 契约不变，路由者"签名零改动"的说法依然成立。

> **v1.4.6 裁定（路由者报回的「`[]` 语义反向」）**：经核实**不存在**。本契约四处
> （§3 / §5 / §15.2 / §16.5）一律写 `[]` ≡ `null` ≡ **不限**，**无一处作相反定义**
> （「全禁」一词由 v1.4.6 首次引入，仅用于记录该误读本身）；实现侧 `matchesModel()` 对空数组返回 `true`（不限）与之**同向**，`keyModels()` 空 → 继承 upstream
> 亦为 §5 写明的既有口径。故 (b)(c) 两条按**非缺陷**关闭，**不需要**为 `[]` 再定语义。
> 唯一真缺口仍是 (a)：`KEYS_SQL` 选列 / `KeyRow` 加列 / 解析函数 / `store.ts` 取值 **4 处 + 1 spec**，
> 前置 DDL（`upstream_keys.model_limits`）已在 v1.4.5 落库。
> 不补这几处，白名单在页面上看得见、在网关上不生效，且**不会报任何错**（同 §5 那条"对不上且无报错"）。

### 16.4 风控与探活（上游级 vs 账号级）

- **探活（如新增）按 `(upstream, account)` 串行** + 最小间隔 **0.6s**（§15.5 同一条礼貌口径），
  每账号只试一次 —— TierFlow 是"同一 host + 27 个账号 + 站点侧风控"，并发探活等于自找封禁。
  **但 `(upstream, account)` 串行管不到出口**：探活请求同样从宿主出口出去，与刷新 / 建 key / 重登
  共用**同一个 IP 配额**（§16.7 Tier 1.5）—— 探活不是"免费"的，它计入出口速率。
- **上游级熔断保留**：27 把 key 真的共用同一个 host，一起冷却**是对的行为**；
  但要与"单账号被风控"区分开（后者只该影响该账号名下的 key）。
- **现有实现没有主动探活**，只有被动冷却。是否新增探活不在本期范围（本期改动面：
  错误体识别 + 探活限速两处，**且探活仅在新增时受本条约束**）。
- **本节只有两层（上游级 / 账号级）；TierFlow 还有第三层：按来源 IP 计数的出口级限流**，
  见 **§16.7** —— 那一层的处置方向与本节相反：**不换 key、不记 key 健康、冷却上移到出口**。

### 16.5 S1 字段依赖对账（路由者提的 3 项，v1.4.2）

路由者声明只消费三个字段、其余账号/套餐/余额层级不消费。逐项落位：

| 字段 | 落位 | 状态 |
|---|---|---|
| `baseUrl` | §2 Upstream 对象既有字段 | ✅ **已有**，无需改动。TierFlow 取值 `https://tierflow.cn`（默认假设，见 §16.1） |
| **数据面路径与协议**（`/v1/*` 还是自有协议） | §16.1 + §16.1.1 | ⏳ **未实测**，按 §16.1.1 登记为悬空件。**S1 先占位、实测后钉进 §16 实现约束**；占位期间不产生实现义务 |
| **`model_limits` CSV → 可用模型清单** | §3 Key 对象 `models` + §15.2 `keys` 入参 + §15.7 加列 | ✅ **v1.4.2 已落**（这是本版补的缺口：原先只在 §16.3 提了一句"映射到 `KeyConfig.models`"，**没有任何一列承载它**，网关读不到值） |

> 三项里第二项是**唯一**需要外部输入的；另两项**在契约层**不需要等任何人（**落地层**第三项仍须先有
> 一次 DDL —— 该前置 v1.4.5 已满足，但车道基线能否取到它归车道，见 §16.3 末注）。特别是第三项
> **不依赖** P0 —— 白名单是管理面事实，与数据面协议无关，所以它不该被挂在"等实测"后面陪着一起等。
>
> **第三项的本车道上限**：契约侧（列 + DTO + 入参 + §5 过滤口径）已落；**网关侧还差 4 处 + 1 个 spec**
> —— `KEYS_SQL` 选列 / `KeyRow` 加列 / 解析函数 / `src/wiring/store.ts` 取值（§16.3 末注）。
> **签名零改动**，但**取值**确实要动，路由者原话"`KeyConfig` / `KeyPool` 签名不动"**依然成立**，
> 只是不等于"零改动"。

> 三项在 S1 期间的**占位值**见 §16.6。

### 16.6 S4 验收锚定：探针执行链与三项 S1 占位值（v1.4.3）

**执行链（2026-10-07 改锚：凭据由持有者注入，执行可指定代跑）**

1. **取得 key** —— 两条路都成立，**不必等 §15 落地**：
   - **既有路（今天即可用）**：人工把一枚真实 `sk-` 粘贴进 §3 `POST /api/keys`（请求体有 `key: string`，实现已在）。
     探针只吃最终产物，**不关心这枚 key 是谁建的、从哪来**；
   - **§15 路（S2 之后）**：`/api/supplier-accounts/*` 批量建 key。
   > **推论要写明**：**P0 / P1 不挂在 S2 后面**。探针需要的是"一枚可用 key + 一个真实模型 id"，
   > 不是账号面端点。把 P0 排成"等 S2 建完 key"是排期上的假依赖。
2. **注入**：`PROBE_KEY` / `PROBE_MODEL`（P4 另需 `PROBE_EXHAUSTED_KEY`）由 **Bo 在运行时**注入执行者环境；
   值不落 `.env`、不提交、不进聊天、不贴群。**执行者不读任何凭据文件**（那 27 个账号的会话文件与本步无关，见 §15.9）。
3. **执行**：**Bo 本人，或他在注入凭据后明示指定的执行会话（含管家）代跑**。
   Bo 是**唯一**注入凭据的人；代跑者只面对"运行时环境里已有的一枚网关 key"。
   **代跑不放松 §15.9 纪律 2** —— 账号密码 / 会话值在任何情况下都不进 AI 上下文。

**路由者的交付边界（收窄，写死）**：**只负责探针脚本 + 官网结论**，不代持凭据、不作为执行主体。
结论 = 报告到手当天钉死 §16.1 的数据面路径与 §16.2 的 pre-first-chunk 改判。

**三项 S1 占位值（实测前逐项照此写，不许各车道自行发明）**

| # | 字段 | 载体 | 未实测期间的占位值 | 钉死条件 |
|---|---|---|---|---|
| 1 | `baseUrl` | §2 Upstream DTO（**既有字段**，不新增） | `"https://tierflow.cn"`（默认假设） | P0 报告 |
| 2 | **数据面路径与协议** | **不进 DTO** —— 它是 §16 的**网关接入约束**，不是 Upstream 对象字段 | `null` 语义 = "按 OpenAI 兼容默认路径接入；`classify` **不做** 200+`success:false` 改判" | P0 / P1 报告 |
| 3 | `model_limits` → 可用模型清单 | §3 `KeyDto.models` + §15.2 `keys` 入参 + §15.7 列 | `null`（= 不限，与 `[]` 同义，ADR-0019 决策 2） | **不等实测** —— S2 直接落 |

> **第 2 项为什么明确不落 DTO**：给通用 `Upstream` 对象加一个供应商专用的路径字段，就是拿个例往通用层
> 开口子（ADR-0018 决策 0「个例不外溢」的同一条理由）。数据面路径是**网关侧接入常量**，实测结论只改
> §16 正文 + 路由者实现，**不改管理面契约**。**S1「先占位」不许体现为新增 DTO 字段。**

**兜底（较 v1.4.2 不变）**：Bo 既不跑也不指定代跑 → §16.1 相关字段一律 `null` 占位、按默认假设接入、
**不写 `classify` 改判**、**不把"缺数据"当已确认**。

### 16.7 出口级（IP 级）限流：归因与处置（v1.4.4）

**触发**（Bo 2026-10-07 报回，原文）：`Error: too many requests from your client ip`。

这条**既不是账号级、也不是 key 级** —— 它按**来源 IP** 计数。TierFlow 当前部署形态是
「**1 个出口 IP** + 27 个账号 + 全部 key」，所以**所有 key 共命运**：换 key 不改变出口，也就换不掉被限流的对象。
§16.4 只写了「上游级 vs 账号级」两层，这是**第三层**。

**现网它会滚成全池故障 —— 而且是网关自己放大出来的**（逐环取证，读的是当前 `main`）：

| 环 | 位置 | 行为 |
|---|---|---|
| 1 | `src/gateway/classify.ts:18` | `429 → 'RATE_LIMITED'` —— **纯状态码驱动，不分** IP 级还是 key 级 |
| 2 | `src/gateway/engine.ts:399` | `pool.reportFailure(candidate.keyId, 'RATE_LIMITED', {retryAfterMs})` —— 记在**当时正在打的那把 key** 头上 |
| 3 | `src/gateway/cooldown.ts:56` | 无 `Retry-After` → **60s** 起步；连续失败按阶梯 1m → 5m → 15m → **30m** |
| 4 | `src/gateway/key-pool.ts:30` | 池**只有 key 级状态**（`reportFailure(keyId, …)`），**没有**上游级 / 出口级冷却 |

于是：IP 级 429 → 冷掉 key₁ → 引擎换 key₂ 重试 → **出口 IP 没变** → 再 429 → 冷掉 key₂ → …
**一个客户端请求之内就能把候选 key 逐把冷掉**，后续请求无候选 → `503 NO_AVAILABLE_KEY`；
重回候选的 key 再撞一次，`consecutiveFails` 升档 → 最长 **30 分钟**全池不可用。

> 一句话：**"换 key 能救"这个前提在 IP 级限流下不成立，而引擎照换不误。**
> 故障不是上游给的那一下，是轮换把它放大成的那一片。

**归因纪律（本期定死，不依赖任何外部证据）**

- **IP 级 429 不计入任何 key 的健康计数**，也不触发 `AUTH_INVALID` 那类自动停用。
  与 §10「0 次真实尝试不计 key 健康」是同一把刀：**谁没错，不给谁记过**。
- **冷却对象从 key 上移到出口**（本期"出口" = `upstream.host`）：同出口下的 key 共用一道冷却。
- **冷却期内不做换 key 重试** —— 同 IP 轮换必然再撞，轮换在这里不是容错，是**放大器**。
- 对客户端仍走 §10 既有口径：`429 RATE_LIMITED` + `Retry-After`。**不新增错误码、不新增 HTTP 状态**
  —— 出口被限流在调用方那侧与"池饱和"同形（都是"退避后可重试"），语义正确。

**前置未知（按 §16.1.1 同款悬空件登记，需外部输入）**

识别规则**现在不写死**，因为手上只有一句 message 文本。需要补三样：

1. 这条报错的**来源**（Python 工作台 / 本仓网关 / 别的脚本）—— 决定它是历史遗留还是现网在流；
2. **原始响应**：HTTP 状态码 + 完整响应体 + 响应头（尤其有没有 `Retry-After`）；
3. **退避多久恢复**：能自愈 = 限速窗口（Tier 1 可治）；长时间不恢复 = 封 IP（**必须** Tier 2）。

两种可能的世界，落法不同：

- **(a) 与普通 429 同形**（只有 body 文案不同）→ 走 §16.2 同款 **pre-first-chunk** 识别窗口，按供应商错误码 / 文案判；
- **(b) 上游给了专用码或专用字段** → 直接按码判，**不解析文案**（文案会变，码不会）；
- **(c) 纯自证据**（v1.4.8 登记）：同一出口上**第 2 把不同 key 也 429** 即判出口级
  （实现即 `classify.ts` 的 `egressLimitedOnSecondKey`）。它**不需要上游吐原始响应**，
  代价必须一起记：**确认之前的第一把 key 仍会被按 key 级记过** —— 把受害者从 27 把缩到 1 把，
  不是零成本。它是 (a)/(b) 之外的**第三条路，不是它们的替代**。

**处置三档**

| 档 | 内容 | 依赖 | 车道 |
|---|---|---|---|
| **Tier 1** | 识别后**不调 `reportFailure(keyId)`**；改落**出口级短冷却**（= **`max(Retry-After, 60s)`**，无该响应头则 60s 起、封顶 30min，阶梯同 key 级 —— **地板见下方裁定 ②**）；冷却期内**不轮换 key，径直回 `429 RATE_LIMITED` + `Retry-After`** | 只需上面 (1)(2) 两项证据 | 路由者（`src/gateway/`） |
| **Tier 1.5** | **出口级令牌桶**：所有发往同一出口的请求（刷新 / 建 key / 重登 / 探活 / 数据面）共用一条速率，取代"每账号各自 0.6s"。**口径与作用域本期定死，数值占位** —— 只等下面 (3) 的实测退避时长，回填时**不改结构、只改数** | 需 (3) 的实测退避时长 | 路由者 + 管家（§15.5 口径，v1.4.8 已收口） |
| **Tier 2** | **出口 IP 池**：账号分组绑不同出口（proxy / 多宿 IP），把"27 账号 = 1 个 IP"拆成"N 个 IP"。**DDL 已落**（`src/db/schema.ts`，见下），余下是实配与标定 | Bo 已给资源清单（港×3 / 京×1 / 美×1 + 宿主出口 = 6 个候选）；出口数待 A/B/C 标定 | 管家（schema 已落；**DTO 本期零改动**） |

**Tier 2 的 DDL 已落**（v1.4.8 订正本节旧文"若做"）：`src/db/schema.ts` 已有
`egress_proxies`（`id` / `name` / `url`（只放 `scheme://host:port`，**不含 `user:pass`**）/
`secret`（aes-256-gcm 密文 BLOB，与 `upstream_keys.secret` 同一形状；**明文永不落盘**）/
`region` / `note` / `enabled`）与 `supplier_accounts.egress_id`（**可空**，缺省 `null` = 用宿主出口）。
**纯加表 + 加列，非破坏。** 三条绑定纪律（v1.4.8 写死）：

- **绑定粒度 = 账号级（`supplier_accounts.egress_id`），不是 key 级。** 27 个账号本来就是 27 个
  风控指纹，拆到账号才有意义；key 挂在账号下自然继承，**不为它加列**。
- **每出口账号数上限 = 6（占位）**：等 A/B/C 标定报告到手按实测回填。**回填改的是这个数，不是结构。**
- **`egress_id` 不进任何 DTO**（`SupplierAccount` 不加字段、§14 端点不加字段）：出口状态唯一的读面
  是 §7 的 `egress_cooldown` 帧。**建表 ≠ 前端要处理它** —— 前者是存储预留，后者才是行为变更。

**§15.5 那条依据要收回一句**：`账号间间隔 0.6s —— 工作台 29 号跑下来未触发限流`
这条**只在"单出口 + 当时那种请求密度"下成立**，而 IP 级限流已被触发过，说明**条件变了，或它本来就是侥幸**。
0.6s 是**每账号**的礼貌间隔，对**按 IP 计数**的限流**不成立** —— 27 个账号各自守 0.6s，出口侧照样可以超速。
本节**不改 §15.5 的值**（值仍复用），但那条**依据**从"实测未触发"降级为"待 Tier 1.5 按出口级口径重新标定"——
**v1.4.8 已把这句落到 §15.5 表内那行本身**（此前只写在本节，表内仍是旧依据）。

**v1.4.8 裁定：路由者 §16.7 两问**

**① 识别规则 —— 本期哪条都不启用。** 登记 (c) 为准候选，启用另需一次明文决定。
路由者报回「识别缝已接好、默认 `neverEgressLimited`（恒 `false`）」，**这个默认是对的**，
但它有一个必须说穿的后果：

> **识别器默认关闭期间，Tier 1 是"缝"，不是"修"。** 运行时行为与改动前**逐字节相同** ——
> "IP 级 429 被轮换放大成 30min 全池故障"这条**自伤回路还没有被掐断**。

所以 Tier 1 本期的交付物是**通道 + 归因纪律的可执行化**，不是故障的消失。
公告与回执**不得**写成"自伤回路已掐断"。启用条件二选一：**(i)** Bo 的原始响应到手 →
按 (a) 落、有专用码则 (b) 优先；**(ii)** PM / Bo **明示放行** (c) 作过渡。
**在 (i) 或 (ii) 之前，识别器保持默认关闭。**

**这条裁定的第二个后果（v1.4.9 补记）：§7 的 `egress_cooldown` 帧本期不发射。** 识别器默认关闭
⇒ 出口冷却不会被置起 ⇒ 帧无从来；且发帧实现本身也未落（`src/api/routes/live.ts` 零 egress 代码）。
所以**本期出口级冷却对管理面不可观测**：管理面**不得**从 `429` / `Retry-After` / 日志反推，
**也不得**把"未收到该帧"当作"出口健康"（缺省不是证据）。接入点与自检信号见 §7 该帧的「本期状态」。

**v1.4.10 补：该帧的投递语义定为「随每 tick 差分帧下发、新连接首 tick 全量」**（§7「基线」）——
**不做成纯事件推**：本帧是出口冷却的**唯一读面**且**不走 REST**，纯事件推会让刷新 / 重连拿不到
"此刻正在冷却"，而反推又被明令禁止 ⇒ 前端无合规自纠手段。代价是最多晚 1 tick（1s）可见。
这与 §7 的「本期不发射」**不冲突**：那是本期状态，这是接线后的行为。

**② 出口冷却适用 60s 地板 —— 本裁定把「尊重 `Retry-After`」读作「不短于它」。**
即 **出口冷却 = `max(Retry-After, 60s)`**；无该响应头则 60s 起、**封顶 30min**，阶梯与 key 级同源。
路由者的实现（`egress.ts` 复用 `cooldown.ts` 的 RATE_LIMITED 口径）**据此保持不动**：
本节此前只写"尊重 `Retry-After`"而没写地板，**是本契约的漏写，不是实现的偏差**。
取舍写明：地板会在上游给短退避时**多冷一段**（`Retry-After: 45` → 仍冷 60s），
代价是可用性、收益是不给"上游吐个小值就秒回"留缝 —— 安全侧，且不发明第二套算法。

**v1.6.2 实测登记：出口级 429 的原始形状（路由者无凭据探针，2026-10-07）**

本节把「**原始响应**」登记为悬空件（决策 4 三样输入里的第 2 样）。它**不需要 key 就能触发**，
所以路由者用零凭据探针打出来了 —— **这一样不卡凭据，现已到手**。下面三条是**实测**，每条都写明
它**能改什么、不能改什么**；第 4 条是**新增的未证实风险**。

**(1) 响应形状 —— 出口级 429 与普通 429 同形，且不带 `Retry-After`**

```json
{"error":{"message":"too many requests from your client ip","type":"tierflow_error","param":"","code":"rate_limit_exceeded"}}
```

响应头只有 `Date` / `Content-Type` / `Content-Length` / `Connection` / `X-Tf-Version: v5.5.6` /
`X-Tierflow-Request-Id` —— **没有 `Retry-After`**。

- **订正裁定 ② 的理由（值不动）**：「出口冷却 = `max(Retry-After, 60s)`」这个式子在实测下
  **永远取右边** —— 上游从不发该头，实际就是 **60s 固定起步**。v1.4.8 写的「无该响应头则 60s 起」
  **本身是对的**，要订正的是它给的理由：不再是「**尊重**上游的退避」，而是「**上游什么都不给**」。
  **实现保持不动** —— `max()` 分支当前不可达，但保留它的成本为零，且上游哪天开始发该头即自动生效。
  **不得**因为"现在取不到"就把它简化成裸常量：那会把一条**未来自动复活**的兼容路径删掉。
- 形状是 **OpenAI 错误信封**（`{error:{code,message,type}}`，`type` 恒 `tierflow_error`），
  与 §16.1.1.a 收存的旁证同族 —— 该 host 的错误面确实是 OpenAI 口径。

**(2) 触发阈值与自愈 —— 预算只有 ≈8 次请求，约 1–2 分钟自恢复**

无间隔连发：**第 8 次**触发（前 7 次均为正常 401）；触发后**单次**请求继续吃 429，
约 **1–2 分钟**后单次请求已回 401（**自愈**，非封 IP）。

- 这直接打在验收要害上：预算这么小，本节的「**轮换放大器**」**不是理论** ——
  一个客户端请求内换 2 把 key 就吃掉 2/8，换满即触发。
- **对 Tier 1.5 只走到这一步，别多走**：这条给的是**触发证据**，**不是速率标定**。
  已知：8 次无间隔请求即触发、约 60s 量级自愈。**未知：窗口长度**（「每 N 秒 8 次」还是
  「突发 8 次后惩罚性冷 60s」）。因此**唯一能写进结论的一句**是：出口级可持续速率**必然远低于**
  「每账号 0.6s」（27 个账号各自守 0.6s ≈ 出口侧 45 req/s）—— 这正是 v1.4.8 把 §15.5 那条依据
  降级的**实证支持**。**Tier 1.5 的数值仍是占位**，标定要一次**专门的退避时长实测**（第 3 样输入）。
- **探针纪律（登记在此只为解释"为什么要慢跑"，不是契约义务）**：探针脚本一次全跑发 7 次请求，
  **正卡在 8 次预算上** —— 已加 `PROBE_PACE_MS`（默认 700ms）间隔。**不留间隙会把后半段
  污染成 429 假结论**，这是"探针自己制造观测偏差"的典型形状。

**(3) `code: rate_limit_exceeded` 没有判别力 —— 但「同码」那半句仍是推断，别写死**

实测到的**只有出口级**这一侧（上条）。而「key 级 429 也是同一个 code」**从未被观测过** ——
那需要一次**带 key** 的往返（P0 的另一半，仍未做）。所以：

- **可下结论的**：出口级 429 **无专用码、无专用字段** ⇒ 世界 **(b) 由实测排除**；
  它也**不是** (a) 意义上「与普通 429 仅文案不同」可用的那条路 —— 文案判别依赖一句自然会变、
  会本地化、会随上游版本漂的英文（`from your client ip`），而本契约**明令不解析文案**（决策 4）。
  **故 (a) 与 (b) 两条路都不通。**
- **不可下结论的**：把「按码判分不开两个世界」写成结论**为时过早** —— 它成立的前提
  （key 级同码）**尚未观测**。它现在的地位与 §16.1.1.a 的旁证同级：**登记，但不据此改判**。
- **对落地的影响**：无论那半句最后真不真，**能落地的仍然只有 (c) 纯自证据**
  （`egressLimitedOnSecondKey`）—— 它不看码、不看文案，只看「同一出口第 2 把不同 key 也 429」。
  **v1.4.8 裁定 ①「本期三条都不启用、识别器保持默认关闭」不变**；本批只把它的理由从
  「**没有证据**」改成「**有证据，且证据指向 (c)**」。**启用仍需一次明文决定**（(i) 或 (ii)，二选一），
  **本批不放行**，§7 `egress_cooldown` 帧**本期仍不发射**。
- 顺带一句给值班口径：`code` 同形 ⇒ **日志/告警里看不出是哪一层**，
  这正是决策 7 拒绝让管理面"从 429 反推"的原因，**不是**可以靠加一个码解决的事。

**(4) 新增登记（未证实）：403 `routing_override_forbidden` 会不会误伤整池**

同一探针实测到：**畸形 `sk-` 拿到的不是 401，而是 403 `routing_override_forbidden`**（详见 §16.1.1.a）。
而 403 在 `classify.ts` 里落 `AUTH_INVALID` ⇒ 计 key 失败 + 进冷却。要当心的是这个组合：
**若一把有效 key 在某种写错的客户端参数下也能拿到它，一个调用方的低级错误就会把整池 key 烘掉**
—— 正是 §10 铁律要防的事。**这条完全未证实**（要 P0 的带 key 往返才能定），
**登记，不据此改 `classify`，也不据此动冷却**。

---

*已冻结：v1.0-frozen，冻结裁决见 `docs/adr/0007-api-contract-freeze-c1-c5.md`。字段改动必须改本契约并新增 ADR。v1.1.0 补遗见 `docs/adr/0013-observability-readonly-query.md`；v1.1.1 补遗（关联键 `x-request-id`，§6 / §10 / §12.1 / §12.3）见 `docs/adr/0014-request-id-correlation.md`；v1.1.2 补遗（§10 登记 `GROUP_DISABLED` + §12.1 `AUTH_FAILED` 扩 403 + 四条产出边界）见 `docs/adr/0013-observability-readonly-query.md`「落地补遗」；v1.2.0（§13 内置 AI 助手聊天 + §12.2 `assistant` 字段）见 `docs/adr/0015-assistant-chat.md`；v1.2.1（§13.4「槽位撞满」二分口径：全候选满并发 `503 NO_AVAILABLE_KEY` / 竞态窗口 `429 RATE_LIMITED`，零新增枚举、零代码改动）为文本对齐；v1.2.2（§2 `DELETE /api/upstreams/:id` 从属资源处置：`force!=true` 拦 key 与模型并报 `{keyCount, modelCount}`、`force=true` 按依赖序物理删整棵子树，修订 §11 C4）见 `docs/adr/0016-delete-upstream-subtree.md`；v1.3.0（§14 余额同步：自动同步节奏与退避、NULL 口径、快照与 `asOf`、方向级漂移提示；同批撤销「单价 × 用量的本地扣减账本」方案）见 `docs/adr/0017-balance-sync-source-of-truth.md`；v1.4.0（§15 供应商账号面 + §16 TierFlow 数据面约束：账号作独立资源、批量新建 key 为唯一入池通路、账号级余额第四口径、套餐不建成 key、`upstream_keys.unlimited`、凭据会话一次性离线导入、`…Cents` 金额口径；`ERROR_CODES` 首次新增 1 个 `ACCOUNT_HAS_KEYS`）见 `docs/adr/0018-supplier-account-batch.md`；v1.4.1（§15.1 非破坏新增 `credentialSource`；§15.9 补凭据双路径定位、自动重登的触发与账号级互斥；§15.3 收口 `action` 枚举的生产者）见 `docs/adr/0018-supplier-account-batch.md` 决策 10；v1.4.2（§3 `KeyDto` 非破坏新增 `models` 模型白名单 + §5 `availableKeyIds` 补白名单条件 + §15.2 `keys` 入参可选 `models` + §15.7 加列 `upstream_keys.model_limits` + §16.1.1 悬空件登记 + §16.5 S1 字段对账）见 `docs/adr/0019-key-model-whitelist.md`；v1.4.3（§16.1.1 **执行主体改锚**：凭据由持有者运行时注入、可明示指定执行会话代跑，路由者只出探针与结论；新增 **§16.6 S4 验收锚定**含执行链三步与三项 S1 占位值表 —— 其中"数据面路径与协议"**明确不落 DTO**；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增**）见 `docs/adr/0018-supplier-account-batch.md` 决策 11；v1.4.4（§16.7 **出口级（IP 级）限流**：定性为第三层限流、取证"轮换放大"回路、归因纪律"IP 级 429 不计 key 健康 + 冷却上移到出口 + 冷却期内不换 key"、处置三档 Tier 1/1.5/2、识别规则按悬空件登记、§15.5 那条依据降级；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 对外行为零变更**）见 `docs/adr/0020-egress-ip-rate-limit.md`；v1.4.3 变更块为**补记**（冻版时正文与版本号已改、变更块漏写，仅补记录、无内容变更）；v1.4.5（§15.7 补 `unlimited=1 ⇒ balance_cents` 落 `NULL` 的**落库规则** + §16.3 该行改写与"白名单还差几处"的量词订正 + 同批落地 `src/db/schema.ts` 三列守卫 `ALTER` 与老库升版 spec + 补记 v1.4.3 变更块；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`SCHEMA_VERSION` 仍为 2**）为落地面收口；v1.4.6（§16.3 白名单口径**裁定**：路由者报回三条中 (a) 确认为既有登记的「4 处 + 1 spec」缺口、(b)(c) 按**非缺陷**关闭 —— 契约四处一致 `[]` ≡ `null` ≡ 不限、与冻结件 `matchesModel()` 同向；§15.2 待实测块**新增**一条「上游 `model_limits_enabled=true` + 空 CSV = 全禁还是不限」，实测前归一化仍为 `NULL`；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2**）；v1.4.7（§16.3 补**拓扑中立取件纪律** —— canonical 落点唯一、车道基线早于该批 `ALTER` 时按路径取件、不派生第二份 `schema.ts`；§16.5 两处文本订正：残留「网关侧还差一行」→ **4 处 + 1 个 spec**、「另两项不需要等任何人」限定为**契约层**；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2**）；v1.4.8（§16.7 两处悬空件**裁定** —— 识别规则**本期不启用**、登记世界 (c)（同一出口第 2 把不同 key 亦 429，代价：确认前第一把仍被记过）并写明「默认关闭期间 Tier 1 是**缝**不是**修**、自伤回路尚未掐断」；出口冷却 **= `max(Retry-After, 60s)`** 地板成文（此前只写"尊重"没写地板，是契约漏写）；**新增 §7 帧 `egress_cooldown`**（`egressId` 不透明字符串、`cooldownUntil` ISO8601、解除推 `null`）并同日写进 ADR-0020 决策 7；§15.5 依据降级落到**表内那一行本身**（此前只在本节写、表内仍是旧依据）、§15.9 / §16.4 两处 0.6s 引用补出口级指引；Tier 1.5「**同一出口共用一条速率**」口径定死、数值占位；Tier 2 订正旧文"若做"（DDL 已落）并写死**账号级绑定非 key 级** / **每出口账号数上限 6 占位** / **`egress_id` 不进任何 DTO**；**无字段改名、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2** —— 唯一的对外形状新增是那条 §7 帧）；v1.4.9（**§7 `egress_cooldown` 帧的「本期状态」裁定** —— 形状已冻结、**本期不发射**（识别器默认关闭 ⇒ 冷却不置起；发帧实现未落 ⇒ `live.ts` 零 egress 代码），故**本期出口级冷却对管理面不可观测**：前端**不得接线**、**不得把"未收到该帧"当作"出口健康"**（缺省不是证据）、不得反推；接入点写死为**接线层注入**（AGENTS.md §8，形状同 `ApiContext.assistant`），生产者归路由者 `src/gateway/egress.ts`；同裁定补进 §16.7 裁定 ① 并给出两条自检信号；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.4.10（**§7 `egress_cooldown` 帧的投递语义收口** —— v1.4.8 那句「立即推（不等到下一帧）」是从 `key_health` 抄的，而本帧被 §7 自己定为唯一读面、**不走 REST** ⇒ 照字面实现即**纯事件推**：**刷新 / 重连拿不到"此刻正在冷却"**，前端只能把「全部 key 暂停路由」渲染成正常（最长 30min），且反推被禁 ⇒ **无合规自纠手段**；裁定改为**随每 tick 差分帧下发**（`id: egress:${egressId}`、`sig` 必带 `cooldownUntil`，新连接 `seen` 为空 ⇒ **首 tick 自然全量**），与 `key_health` / `balance` / `task` 同列，**零新增端点、零帧形状变更**，代价写明 **≤1 tick（1s）**；同批**证据订正**：`key_health` 的基线**不是** `metrics` 帧（`live.ts` 该帧不带 `keyHealth[]`）而是与其同款的差分帧首 tick 全量；自检信号由两个增为**三个**（新增差分帧注册面 `git grep -c 'egress:' dev/api -- src/api/routes/live.ts`）；**不改变 v1.4.9「本期不发射」的结论**；**无字段改名、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.4.11（**§7 `egress_cooldown` 生产者形态收口** —— 把 v1.4.8 / v1.4.10 那句「网关的**出口冷却表**」订正为**进程内注册表**：`src/gateway/egress.ts` 的 `createEgressCooldown()` 内部是 `Map<string, EgressState>`、**不落库、重启归零**，经 `stack.ts` 装配注入（`egress?: EgressCooldown`）；同批写死**发帧必须同进程读被注入的实例、不查库**（跨进程读不到则帧发不出来），并补记接线为**三处**（造帧 / 推帧 / 注册进 `tickNow` 的 `live` 集合 —— 漏第三处则帧每秒重发）；帧字段名 / 形状 / v1.4.10 投递语义（差分帧 + 首 tick 全量）/ 三条硬约束 / 三个自检信号 / v1.4.9「本期不发射」结论**全部不动**；**无字段改名、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.5.0（**§7 `egress_cooldown` 读面与 `reason` 两处收口** —— ① **放行纯增量只读** `EgressCooldown.snapshot(): readonly { host, untilMs }[]`（**签名只增不改**、`KeyPool` / `KeyConfig` / engine 零改动）：v1.4.10 钉了「`sig` 必带 `cooldownUntil`」却**没查生产者供不供得出**，实测 `egress.ts` 只有 `isCooling(host)` / `remainingMs(host)`（**须先知道 host**）、**无枚举读、无 `until` 读口** ⇒ 属**已冻结语义的缺件**；**语义钉死两条** —— `untilMs` 必须是**绝对时刻**（禁止 `now() + remainingMs()` 反算，否则指纹每 tick 变、每 tick 白推）、快照必须是**全量**（`live.ts` 差分通道**无墓碑**，id 消失只从 `seen` 删、不发帧 ⇒ 只报冷却中的话**解除帧永不发出**）；推论：冷却层**不得 prune 已过期条目**；② **删除 §7 帧 `reason` 字段**（`cool()` 是唯一变更入口且 `reason` 硬编码 `RATE_LIMITED`、`EgressState` 不存它 ⇒ **常量不是状态**；且本帧从未发射、零消费者，**删除此刻免费**），将来若出现第二种成因**同批加字段与生产者**；③ **不改变 v1.4.9「本期不发射」**，属接线前前置件；**§7 帧首次字段删除**故升 v1.5.0，**无端点增删、无其他字段改名、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.5.1（**S1 冻结稿** —— 不新增字段 / 端点，只把 S1 口径落到正文并补索引：**§15.10 新增**「Python 工作台退役与数据迁移口径」（ADR-0018 决策 6 早有结论、**§15 正文此前没有** —— 工作台退役、**`workbench.db` 不迁**、账号靠 §15.2 `import` 重建、旧 29 把掩码 key **作废不回捞**统一重建、批量建 key 作为供应商内建能力**不新增端点/任务类型**）；**§15.11 新增 S1 冻结索引表**（八项逐条给出正文落点与状态）；**§2 补**「通用模板不加换算字段」（个例不外溢，`parse.unit` 三值不变、不新增枚举）；**§6 补规则 6**「无限与未知分列，不得相加/顶替」；**同批订正派单三处锚点**（①② 口径 v1.4.0/v1.4.1 早已冻结、解析顺序在 **§2 非 §14** 且早已落、**会话文件路径按 §15.9 纪律 1 不进契约正文**）；**§14 / §7 本次零改动**；**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.6.0（**S2 落地收口的契约订正**，代码已落 `dev/api @ e76a2d6` —— §15 冻结稿里三处「声明与代码对不上」逐条订正：① §15.6「本次唯一动的既有聚合就是 `balanceUnknownKeyCount` 加一个条件」**不成立** （漏了**推导值** `knownKeyCount` —— 它是 `balanceKeyCount - balanceUnknownKeyCount`，正是从那一处改动里算出来的，无限额度 key 会被反过来数成"已知"），实为**两处**既有聚合 + **加一列** `balance_snapshots.unlimited_key_count`（老表加列，随 §15.7 批 `ALTER`），并补不变量的**互斥**写法；② §15.2 `DELETE` 的「解绑（`account_id` 置 `NULL`）」**指的列不存在** —— 归属本来就是 `supplier_account_keys.pooled_key_id` 台账，**刻意不补列**（第二个事实源），并写死 `ACCOUNT_HAS_KEYS` 的 `keyCount` **必须 JOIN `upstream_keys` 回来数**（台账行无外键，`deleteUpstream` 物理删 key 后成悬空引用 ⇒ 照台账数会让账号**永远删不掉**）；③ §14 快照点**不是"零改动"**、§6 `keys[]`/`keysBalance` 的集合同一性此前未成文、`currency` **漏查一张表** —— 补 **§6 规则 7**（`keys[]` 与 `keysBalance` 同一集合、只列无账号归属的 key、带 `unlimited`；**未知 key 仍在列表里**）与 **§6 规则 8**（`currency` 取值集合跟**贡献方**走、与金额判据逐字对齐 —— `supplier_accounts.balance_currency` **存在**，老口径只查 key ⇒ 钱全在账号上的上游恒回 `null`）；**同批补全 §6 两处 `byUpstream[]` 示例**并**修一处真错**（`keys[]` 条目示例误写 `balanceUnknownKeyCount`，同位置应为 `unlimited`）；**无字段改名、无字段删除、无端点增删、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2**）。v1.6.1（**S2「账号面 Tier A」落地** —— 三条**不打上游管理接口**的端点实现收口：`GET /api/supplier-accounts/subscriptions`（补形状 `Page<SupplierSubscriptionRowDto>` = §15.1 套餐摘要 + `accountId` / **掩码** `accountIdentifier` / `upstreamId`，排序 `end_at ASC` + `NULL` 最后）、`GET /api/supplier-accounts/export`（补列 `upstreamId` + 七条机械形状：`text/csv; charset=utf-8`、`Content-Disposition` 的 UTC 日期文件名、UTF-8 BOM、CRLF、RFC 4180 引号、**公式注入防护**（文本前缀单引号、数值不前缀）、**不分页**）、`DELETE /api/supplier-accounts/:id`（补 `204` / 被拦**不写成功审计**）；§15.7 补登两个审计动作 `supplier.export`（**GET 也写审计**：批量带走全部账号清单是账号面上最该留痕的动作，§6 的"所有写操作"是下限不是上限）与 `supplier.account.delete`；同批把 `subscriptionEndAt`（= 套餐 `end_at` 最大值，依赖**写入侧**归一化 ISO8601）写进正文；**全部是补白，无一处推翻既有口径**；**无字段改名、无字段删除、无端点增删、`ERROR_CODES` 零新增**（`ACCOUNT_HAS_KEYS` 随本批落地）、**`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL 改动**）。v1.6.2（**§16.7 出口级限流的实测形状登记** —— 路由者零凭据探针把决策 4 三样输入里的第 2 样「原始响应」打出来了，**这一样不卡凭据**（出口级限流不需要 key 就能触发）：① **响应形状** = OpenAI 信封 `{error:{code,message,type}}`（`type` 恒 `tierflow_error`）、`code: rate_limit_exceeded`，响应头**不含 `Retry-After`**（仅 `Date` / `Content-Type` / `Content-Length` / `Connection` / `X-Tf-Version: v5.5.6` / `X-Tierflow-Request-Id`）⇒ **订正 v1.4.8 裁定 ② 的理由（值不动）**：`max(Retry-After, 60s)` **永远取右边**、实际就是 60s 固定起步，理由由「**尊重**上游退避」改为「**上游什么都不给**」；**实现保持不动**且**不得**简化成裸常量（该分支是未来会自动复活的兼容路径，删掉零收益）；② **触发与自愈**：无间隔连发**第 8 次**触发（前 7 次均正常 401）、约 **1–2 分钟**自恢复（非封 IP）⇒ 本节「轮换放大器」**不是理论**；对 Tier 1.5 **只给触发证据、不给速率标定** —— 已知 8 次/约 60s 自愈，**未知窗口长度** ⇒ **数值仍占位**，标定需一次专门的退避时长实测；唯一可写进结论的是「出口级可持续速率**必然远低于**每账号 0.6s（27 账号 ≈ 出口侧 45 req/s）」，这是 v1.4.8 降级 §15.5 依据的**实证支持**；探针脚本自身一次全跑发 7 次请求正卡在 8 次预算上 ⇒ 已加 `PROBE_PACE_MS`（默认 700ms，**探针纪律、非契约义务**，不留间隙会把后半段污染成 429 假结论）；③ **判别力**：出口级 429 **无专用码、无专用字段** ⇒ 世界 **(b) 由实测排除**，而 (a) 退化为「只能解析文案」、文案解析又被决策 4 明令禁止 ⇒ **(a)(b) 两条路都不通**；但「key 级 429 同码」**从未观测**（需带 key 往返 = P0 的另一半）⇒ 把「按码分不开两个世界」写成结论**为时过早**，登记为**推断**、不据此改判；**v1.4.8 裁定 ①「本期三条都不启用、识别器默认关闭」不变**，只把理由从「**没有证据**」改为「**有证据，且证据指向 (c)**」；启用仍需一次明文决定（(i)/(ii) 二选一），**本批不放行**、§7 `egress_cooldown` **本期仍不发射**；④ **§16.1.1.a 订正一处判据**：401/403 的分岔由「**请求头里有没有 `Authorization`**」决定，**不由路径、也不由 key 是否有效**决定（`GET /v1/models` 无头 → 401 `Invalid token`；带畸形 `sk-` → 403 `routing_override_forbidden`；`POST /v1/chat/completions` 带畸形 `sk-` → 同一个 403）—— v1.6.0 那句「另一条**路径**上出现 403」是**误导**，应读作「带了 `Authorization` 头的那一侧」，**旁证性质与三条纪律不变**；**补登** P0 的「**路径存在性**」这一半已定（三条均 401/403 而非 404 ⇒ `/v1/models` 已实现，§16.1「只有自有协议」那一支**进一步削弱**），但**已鉴权面一条未定**（TTFB / SSE 帧形状 / `model` 取值 / pre-first-chunk 改判依据全缺），**S1 字段继续 `null` 占位**；**新增一处未证实风险**：畸形 `sk-` 落 **403 `routing_override_forbidden`**，而 403 在 `classify.ts` 落 `AUTH_INVALID` ⇒ 计失败 + 进冷却，**若有效 key 在某些写错的客户端参数下也能拿到它，一个调用方的低级错误就会把整池 key 烘掉**（§10 铁律要防的正是这个）—— **登记，不据此改 `classify`、不据此动冷却**，要带 key 往返才能定；**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）见 `docs/adr/0020-egress-ip-rate-limit.md`「v1.6.2 补记」；v1.6.3（**账号面 Tier B 落地** —— §15.2 六个「要打上游管理接口」的端点接线（`import` / `refresh` / `:id/login` / `:id/test` / `keys` / `keys/sync`），**全部按既有约定实现、零契约改动**；同批把 §15.3 `skipped` 的**口径成文**（此前四个计数里只有它没定义）：`skipped` = **没做过的行**（`LINE_PARSE_FAILED` 解析失败 + `EXCLUDED_IDENTIFIER` 排除名单命中），`failed` = **做过但不成的行**，故 `ok + failed + skipped = total` 恒成立；§15.7 补登两个审计动作 `supplier.account.login` / `supplier.account.test`（`detail` 同样只放计数 / 标志）；**同批修一处实现缺陷**（`replaceSupplierAccountKeyLedger()` 的 `db.transaction(fn)` 漏了调用 `()` ⇒ `keys/sync` 静默空转却报 `rows: N`）；**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL 改动**）。以上各版同属本契约的同一冻结面。（**版本索引订正 2026-10-07，不升版**：本索引此前在 v1.2.1 之后漏记 v1.2.2 / v1.3.0 两条，本次补齐 —— 仅索引行，无内容变更。）*
