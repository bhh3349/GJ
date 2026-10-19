# API 契约 v1.0-frozen

> 作者：管家 · 管理后端　｜　状态：**v1.0-frozen（PM 已核验冻结，见 ADR-0007）**　｜　｜　当前版本：**v1.16.4**　｜
> 本文件是**唯一接口事实源**。冻结后任何一方不得单方面改字段；改动走本文件 + `docs/adr/`。
> 覆盖范围：管理面 `/api/*`（REST + WS）。网关面 `/v1/*` 见 §10。
>
> **补遗 v1.0.1（2026-10-06，PM 已追认）**：§4 新增 `GET /api/groups/:id/keys`，并给 `reset` 的响应补上 `id`。动机与影响见 ADR-0008。
>
> **v1.8.1（2026-10-09，#16 契约面 —— 刷新结果 / 自测结果新增可选 `retryAfterSeconds`）**：ADR-0017 落地清单 #16。
> ① **字段**：`retryAfterSeconds?: number`（§3 余额刷新任务 `result`、§2 `BalanceTestResult`），**可选、非破坏新增**；
> `number` 整数秒（≥1，本地拒绝的 `Retry-After` 由 `retryAfterSecOf` 向上取整）；**缺省 / `null` = 无建议，前端不显示**。
> ② **值的唯一来源 = 本地拒绝**：`isLocalEgressReject`（fetch-gate 合成的 429，`x-sub2api-egress-local: 1` 标记头）
> 的 `retry-after` 响应头 —— **上游真 429 恒不带该字段**：按状态码分流是 `hintCode` 的判据（ADR-0017 补遗 3），
> 而**值**只来自我们自己的桶（上游对出口级 429 **从不发** `Retry-After`，§16.7 v1.6.2；带一个上游值就与"不上行标记头"的纪律冲突）。
> ③ **三个展示位**：单查询自测（§2 `BalanceTestResult`）= 必带（`null` = 无建议）；余额刷新任务 `result`（§3）= 必带
> （`null` = 无建议；本轮多个本地拒绝取**最大** —— 对调用方唯一有用的等待量）；**`/v1/*` 数据面零变更**（§10 既有口径不动）。
> ④ **§14.2 零改动**：本字段不触碰写库纪律（429 仍属"一个字都不写"），三型计数语义逐字不变；
> `SCHEMA_VERSION` 仍为 2、零 DDL、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增。
> ⑤ **前端纪律（#12）**：仅在字段非 `null` / 非 absent 时展示"等多久"；`hintCode=BALANCE_EGRESS_RATE_LIMITED`
> 而 `retryAfterSeconds` 缺省 = 本轮只有**上游** 429，不得反推出口状态（§7 三条硬约束不变）。
> **无既有字段改名、无字段删除、无端点增删、`/v1/*` 零变更、零迁移**。
>
> **v1.8.2（2026-10-12，管理面手册对照实测订正 —— 锚 `a2ed7c2`，纯文档零代码）**：路由者按 Bo 的《TierFlow 接口调用手册》逐端点对线上**真实请求**验证（§16.1.1.b），抓到三处静默偏差 + 一处手册错，代码已随 `a2ed7c2` 修，本版把实测事实订正进正文：
> ① **§15.1 `subscriptions` 行补上游形状**：`all_subscriptions[]` **元素包一层** `{subscription:{…}, has_key, auto_renew}`，套餐字段在 `subscription` 内层 —— 原正文只写「`all_subscriptions: []`」没写元素形状，实现照外层读 `sub_no` ⇒ 全部读不到 ⇒ 整行静默丢弃（套餐表 0 行、无任何报错）。
> ② **§15.1 金额口径换算基准锚点订正**：`/api/status → config.quota_per_unit` → **`/api/user/self → data.quota_per_unit`**（实测无 `config` 层，手册 §1.4 同源错抄）；换算公式与 `Math.round` 纪律不变。
> ③ **上游时间键成文**：套餐时间键 = **`start_time` / `end_time`**（epoch 秒）；§15.1 / §15.2 的 `start_at` / `end_at` 是**本契约 DTO 的对外字段名**，归一化责任在写入侧不变。
> ④ **`/api/token/search` 默认 `page_size=10` 成文**：`keys/sync` 对账必须显式 `p=1&size=100`，否则 key 超 10 把静默截断（少对账 / 掩码撞号误判）。
> ⑤ **同批补笔**：ADR-0011 §2 键 3 补「时效窗」限定（30 分钟内无失败视同 -1）并订正实现锚点 `keys.ts:526` → `:559` —— 即 M6-D ④ 记账挂账的那笔契约/ADR 小笔。
> **无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL —— 纯文档，零代码。**

> **v1.9.0（2026-10-12，套餐专属 key 轮换 / 重置 —— Bo 指示落地）**：新增 **§15.13 `POST /api/supplier-accounts/rotate-key`**。Bo 提供的手册（`TierFlow接口调用手册.md` §5.3）已把上游端点 `POST /api/subscription/self/token/rotate` 标为**「✅ 实测」**（"重置响应会直接下发新 Key 明文，可直接保存使用；重置后旧 Key 立即失效"）；Bo 据此明确指示"重置套餐 key 做了没？没做就做一下"。**这解除了 v1.4.0 冻结时 §15.8 第 8 问设下的前提**——当时该端点自标「未实测」，约定"实测确认能取回明文 + Bo 要 → 独立的一次契约变更（新增 ADR + 改 §15）"。本次即那次变更：
> ① **新端点**（§15.2 表 + §15.13）：`POST /api/supplier-accounts/rotate-key` body `{upstreamId, ids?, subNo?}` → `202 {taskId}`，任务类型 `supplier_rotate_key`，逐行结果复用 §15.3 的 `SupplierBatchResult`，**`action` 枚举新增第 6 个值 `rotate`**（被重登过的行报 `relogin`）。
> ② **取回明文 → 入池**：重置响应**直接下发新 key 明文**，服务端当场 `aes-256-gcm` 写入 `upstream_keys`（`category='token-plan'`，走既有 `createKey` 路径），响应 / result **只回 `keyId` + `keyMasked`**，明文不经浏览器（与 §15.2 `keys` 同一条纪律）。
> ③ **四步固定次序（纪律，不是实现细节）**：**(1) 先落库、后失效** —— 新 key 入库成功之后才禁用旧 key；**(2) `subNo` 省略 = 该账号最新到期的套餐**（与 §15.2 `GET /subscriptions` 的 `end_at` 排序同源）；**(3) 旧 key 只在掩码「精确相等且唯一」时被认领并禁用**，撞号 / 认领不到一律不动任何 key（§15.2 `KEY_MASK_AMBIGUOUS` 同一条取向：宁可留一把已失效的旧 key，也不误禁别人的 key）；**(4) 重置不改变账号 `status`**（§15.1 `status` 是"最近一次查询"的结论，重置不是查询；失败只写 `statusMessage`）。
> ④ **`token_plan_remaining` 落 `NULL`**（不猜一个 0）：余量由后续 `keys/sync` / 余额刷新回填（**该"后续"已于 v1.13.1 落地**，见文末 v1.13.1 条）。**`unlimited` 不适用**（`token-plan` 行不落 `unlimited`，§15.7）。
> ⑤ **`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增**：`SUBSCRIPTION_NOT_FOUND` 与 `KEY_PLAINTEXT_MISSING` 是**逐行 `items[].code`**（§15.4 同一条：不进口径码表）；新增审计动作 `supplier.rotate-key`（`detail` 只放计数）。
> ⑥ **`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL**（本面第一把 `token-plan` key 是**新数据行**，不是新列）；`src/gateway/` **零改动**（网关按 `category` + `balance_cents` 选路，`unlimited=0` + `balance_cents IS NULL` 走既有「未知 ≠ 0、仍可用」分支）。
> ⑦ **同步订正 §15.8 第 8 问**：原文"若将来…实测确认…"的前提已满足，指针改指本节 §15.13；**"套餐剩余不进 `totalBalance` / 不进 §14 快照 / 不进网关准入判断"三条零改动**（重置进池的是**套餐专属 key 凭据**，用的仍是套餐自己的额度池）。
> ⑧ 已知边界（写在这里，不留待发现）：**上游明文在结果面不可取回**（重置只此一次）——所以"先落库、后失效"是硬次序；池内**旧 key 不删台账行**（保留对账历史）；全新 key 未与本地上游记录对账前，`token_plan_remaining` 为 `NULL`，网关按"未知"处理（**v1.13.2 起"未知"的语义 = 排在所有余额 key 之前、任何真实有额的套餐 key 之后**，见 v1.13.2 ① / ADR-0030 决策 1）。动机与影响见 **ADR-0022**。
> **v1.10.0（2026-10-13，助手聊天支持按请求选择站内模型 —— Bo 要求落地）**：**§13.1 请求体新增可选字段 `model`**（string）。动机见 **ADR-0023**。
> ① **缺省 / 空串 = 用装配侧 `ASSISTANT_MODEL`**：**零行为变更** —— 老前端 / 老脚本完全不发这个字段时，行为与 v1.9.0 逐字节相同。
> ② **校验口径 = 站内已启用模型集合**：与 §5 `GET /api/models?enabled=true`、`/v1/models` **同一判据**（`models.enabled = 1` **且**其上游 `upstreams.enabled = 1`）。
> ③ **不在集合内 → `400 INVALID_PARAM`**（`details.field = "model"`）：这是**解析层非法**（请求写错了），**不是** §13.3 那类「请求合理但太大」的 `truncated` —— 两者不许混（§13.1 既有纪律）。**不静默回落缺省**：回落会让用户以为「切换生效了」，只能靠猜。
> ④ **端口签名只增不改**：`AssistantModelInvoker.stream(messages, signal, model?)` —— 第三参可选，既有实现与全部桩零改动。
> ⑤ **三项既有纪律零变更**：无状态（§13 纪律 1，所选模型不落库、每轮自带）、计量口径（§13.4：**同一个 key 池、同一个 engine 装配**，照常计入 key 健康、不计入业务流量）、三重上限（§13.3）。
> ⑥ **前端只调管理 API**：选择框选项复用 §5 列表端点，**不新开端点**（新端点必有第二份口径）。
> **无字段改名、无字段删除（纯新增可选字段）、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL、`src/gateway/` 零改动。**
>
> **v1.11.0（2026-10-14，模型能力探测 —— Bo 要求落地）**：新增 **§5 `POST /api/models/:id/probe`**，给模型档案的 `capabilities` 加一个**机器来源**（Bo：「获取模型后……就要去测试模型的参数……我用我们的 url 和 key 获取模型要能识别这些模型的功能」）；**§10 `GET /v1/models` 只加字段**。动机与影响见 **`docs/adr/0024-model-capability-probe.md`**。
> ① **新端点** `POST /api/models/:id/probe` body `{targets?, apply?}` → `200 ModelProbeResult`：打**能力专属**的上游请求，用**响应本身**判 `vision` / `stream` / `function_call` / `json_mode` 四项；`supported` 是**三态** `true` / `false` / `null`（判不出），**只有 `true` 进 `capabilities`**。请求体**服务端内置、不接受调用方注入**（`false` 的可归因性依赖它）；**只看状态码、不解析文案**；`401/403/404/429/5xx/超时` 一律 `null`。
> ② **唯一 schema 变更：纯加两列** `models.capabilities_source`（`manual` \| `probe` \| `NULL`）与 `models.last_probed_at`，走既有 `hasColumn` + `ALTER` 通道 —— **纯加列 ⇒ 照 v1.1.1 / v1.4.x 先例，`SCHEMA_VERSION` 仍为 2**（迁移判据是"列在不在"，不是版本号）。
> ③ **来源规则三条**：`PATCH` 传了 `capabilities` ⇒ `manual`；探测**只在 `NULL` 或 `'probe'` 时写**、**`manual` 永不被 `probe` 覆盖**（ADR-0009 §4 的第二个写入方，规则同向），落库用**条件 `UPDATE` 单语句原子**（不需要 `revision` 参数、不与并发 `PATCH` 竞态）；`last_probed_at` **每次都刷**。档案卡因此**三态可分辨**：非空 = 有该能力 / `[]` + `probe` = **已探测、不支持** / `[]` + `NULL` = **未知（没问过）**。
> ④ **计量隔离四条（要害）**：零 `reportFailure` / `reportSuccess`（探测**不进引擎** —— 上游对不支持的能力回 4xx，那是**模型的性质，不是 key 的故障**）、零 `usage_logs`、出站**必走装配层注入的 `fetchImpl`**（接线层已包成 `fetchFor(egressId,'management')`，ADR-0021 决策 4；**禁止裸 `fetch`**；走 `management` 消费者、**不占数据面保留额度**）、计量**随动作走**（响应 `requests` + 任务 `result.probe` + 审计 `model.probe`），**不并进 §12.2**（离散动作 ≠ 常驻流量）。
> ⑤ **自动补探**（Bo 要的"获取模型后自动识别"）：`POST /api/models/sync` **尾部**对**候选**（本次同步涉及且 `capabilities_source IS NULL`）补探，**已探测过的不重复烧**；**默认开**、两个闸可关（请求体 `{probe:false}` / 环境变量 `MODEL_PROBE_ENABLED=false`）；单轮上限 `MODEL_PROBE_MAX_MODELS`（占位 10）**+ 出口预算拒绝即停**；探测失败**不改任务成败**（计数进 `result.probe.failed`）。
> ⑥ **端点上不做的一件事（登记）**：上游 `supported_endpoint_types` **本笔不吸** —— 它的语义单位是**端点类型**，不是**模型能力**，塞进 `capabilities` 等于往闭集枚举里加一个没定义的值（前端 `capability` 筛选立刻多出一个点了什么都查不出的选项）。要留只做**独立只读字段** `endpointTypes`（与 `capabilities` 并列、不合并），**另开一笔**。
> ⑦ **`contextLength` 仍不动**：上游不给就永远 `null`；本笔**不**做"撞窗口反推"（烧真流量且不给数字，ADR-0009 §1 的"永不编造"照旧）。
> ⑧ **`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增**（`reason` 五枚是**逐端点诊断字段**，与 §15.4 `SUBSCRIPTION_NOT_FOUND` 同一条：不进口径码表）；`/v1/*` **只加字段、不改既有四字段形状**、集合口径零变更；`SCHEMA_VERSION` 仍为 2、**零迁移**（纯加列）。
>
> **v1.11.1（2026-10-14，助手页错误汇总面板 —— Bo：「不是价格错误汇总。是日志的错误日志汇总表，这样方便和助手对话复制」）**：新增 **§13.6 助手页错误汇总面板（数据口径）**，**零新端点、零字段、零后端改动** —— 面板行复用已有 §12.3 端点，把「取数 / 计数 / 点行注入」三处口径钉成一处事实源。动机与影响见 **`docs/adr/0025-assistant-error-summary-panel.md`**。
> ① **面板行 = §12.3 `GET /api/observability/errors` 原样响应**（§0.3 分页信封 + `range`；默认排序 `ts DESC, id DESC`，`from`/`to` 全省略 = 该端点既有默认近 1h）。前端不得换字段、重排行、自造聚合。
> ② **顶部「9 分型计数条」= §12.2 `events.byCategory`**，**不得**用面板那份分页响应现算计数（分页只覆盖第 1 页，计数是全窗口，两个数不同口径）。
> ③ **点行注入只走 §13.1 `logContext` 白名单字段**（`window` / `from` / `to` / `category` / `severity` / `model` / `requestId`；行里的事件 id 不注入，`requestId` 见 §6「关联键」）；**禁止把行文本（`message` / 掩码 / 拼接句子）塞进 `messages`** —— §13 纪律 3「日志隔离」不接受自由文本查询。
> ④ **裁定 `done.citations` 不加「进页即注入」默认快照**（§13.2 语义一字不动）：自动快照每轮命中 §13.3「50 条」上限 → `truncated` 常驻失真，且面板上线后「复制」痛点已解，价值不抵代价；要翻案走新 ADR。
> ⑤ **全局视野靠点行注入**（点计数条 = `logContext.category` 多值），不靠自动快照；⑥ 面板（`from`/`to`）与计数条（`window`）允许不同窗口，后端只回显 `range`（§12.3）/ `window`（§12.2），一致性归前端渲染，**不新增字段**。
> ⑦ **零代码变更**：`src/api/` + `src/gateway/` + `src/db/` 一行未改；`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL、零迁移。
>
> **v1.11.2（2026-10-14，sync 选 key 候选修复 + 探测口径三点补充 —— Bo 拍板「停用 `****amMc`」「探测 commit 携带共享凭据选择器」「sync `result` 增加该字段属契约增量，需你补契约一行」）**：新增 **§5 同步与探测的共享凭据选择器**，并把 ADR-0024 的三处落地口径钉死。动机、A/B 取证与备选见 **`docs/adr/0026-sync-credential-rotation.md`**。
> ① **修法（ADR-0026）**：新增 `src/api/services/credential-rotation.ts` —— 候选 = 该上游已启用 key，按「台账绑定 `status='active'` 账号的优先 → `created_at,id` 稳定序」排序（解密出口/排序键不动）；`tryWithRotation` 逐把尝试，**401/403 记 `reason:"auth"` 换下一把**，装配默认**试 3 把**（常量，不进契约），预算耗尽回**最后一个**错误并带 `credentials` 可观测位。
> ② **同步接线 + 可观测位**：`syncModels` 候选从「第一把启用 key」改为共享选择器；成功上游的 `SyncSummary` 新增**可选**字段 `credentials: {tried, usedMaskedKeys, switched}`（省略 = 未换过；**只含计数与掩码、不含明文**）。
> ③ **口径补充三处（正文已并入对应小节）**：来源规则第 3 条条件 `UPDATE` 的 WHERE 补「本轮 `now` 已知」半句；探测端点**同步返回** `200 ModelProbeResult`（不 `202` 不打任务，单上游多模型超时预算时才退任务面）；`MODEL_PROBE_MAX_MODELS` 落**装配侧 env 默认 = 10**（数值不进契约）。
> **无字段改名、无字段删除；`/v1/*` 零变更；`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增；`SCHEMA_VERSION` 仍为 2（v1.11.0 的两列随本笔实现落 `ALTER`，仍零迁移）。**

> **v1.12.0（2026-10-14，管理面同源托管前端产物 —— PM 交付链探查缺口 3）**：新增 **§17 管理面静态托管**。管理面此前只跑 `/api/*`，`GET :4001/` 回 JSON 404；开发态靠 Vite（:5173），生产没有任何 UI 入口。动机与影响见 **`docs/adr/0027-admin-web-hosting.md`**。
> ① **同源托管**：`GET /`（及 SPA 深链路由）回 `web/dist` 的 `index.html`，`/assets/*` 静态资源同源 —— Cookie 不跨域、WS `/api/stats/live` 同源升级，与开发态 Vite 代理口径一致。
> ② **注册顺序**：`/api/*` 路由全部先注册，静态托管最后 —— `/api/*` 永远先于静态命中。
> ③ **插件形态 `wildcard:false`（逐文件路由）**：不为未存在的路径注册 `/*` catch-all；SPA 深链由**应用级 404 兜底**承接 —— 非 GET 方法、非 `/api`、非 `/v1` 的 GET 未命中 → `sendFile('index.html')`（200）；其余未命中（非 GET 方法 / `/api/*` / `/v1/*`）维持既有 JSON 404（`{"code":"NOT_FOUND",…}`）。`assertAdminPath()` 前端护栏（永不允许拼 `/v1` 前缀）继续有效。
> ④ **root 来源 = 新可选 env `ADMIN_WEB_DIST`**：**默认空 = 关闭托管**（行为与改动前逐字节相同），**显式配置才开**（不做"探测 `web/dist` 存在就托管" —— 那是把部署开关变成测试环境依赖）；目录缺失**不 fail-fast**（启动 warn 一条，托管退化，Vite build 没跑是常态）。
> ⑤ **缓存纪律**：`index.html` 不缓存；带指纹的 `/assets/*` 长缓存 `maxAge=30d, immutable`（Vite 产物文件名自带内容 hash）。
> ⑥ **零鉴权面变更**：静态资源不经会话鉴权（onRequest 闸门只管 `/api/*`）；`/api/*` / `/v1/*` 行为零字节变更；`SCHEMA_VERSION` 仍为 2、零 DDL、零迁移；`src/gateway/` 零改动。
>
> **v1.12.1（2026-10-14，§17 两处勘误 —— PM 复核报告点出、管家活体复现，代码 + 判据同轮收口）**：`src/` 与 §17 表两行同步修正，ADR-0027 补遗记录判据。
> ① **缓存判据按 content-type，不按 URL**：首版 onSend 按 URL 含 `/assets/` 判缓存，而 404 兜底回的 `index.html` 也落在 `/assets/` 路径上 —— 实测 `GET /assets/<不存在文件>` 与 `GET /assets/` 均回 200 HTML 且带 `immutable`，入口壳被长缓存 30 天。收口：content-type 含 `html` 一律 `no-cache`，`immutable` 只挂真正命中的静态资源。
> ② **机器面判据收紧为段边界**：裸 `/api`、`/v1`（无尾斜杠）首版漏进 SPA 支回 200 HTML（实测）；收口为 `p === '/api' || p.startsWith('/api/')`（`/v1` 同）—— 裸前缀归 JSON 404，`/apifoo` 类同前缀不同段仍回 SPA（不是路由，浏览器深链语义不变）。
> ③ **零行为面变更**：`/api/*` / `/v1/*` 既有响应零字节变更；`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增；`SCHEMA_VERSION` 仍为 2、零 DDL、零迁移；`src/gateway/` 零改动。测试 +4 判据（静态未命中回落 no-cache ×2、裸前缀 404 ×2、`/apifoo` SPA 正控、缺失目录三路径 404）。
> **v1.12.2（2026-10-14，接入信息只读面 —— PM 交付链探查缺口 2 / 画师「接口先行」点单）**：新增 **§18 `GET /api/access-info`（只读、无副作用、零新存储）**。动机与影响见 **`docs/adr/0028-gateway-access-info.md`**。
> ① **回什么**：`{gateway:{scheme,portGateway,hostGateway}, admin:{scheme,portAdmin,hostAdmin}, publicHost, adminWebDistEnabled}` —— **`gatewayUrl` / `adminUrl` 两个完整 URL 字段刻意不设**：服务端只知道端口与绑定地址，不知道公网 host；`0.0.0.0` / `127.0.0.1` 都不是对外可访问地址，服务端拼 URL 必然猜错。URL 拼接责任在前端：`publicHost || window.location.hostname` + 端口。
> ② **`publicHost` 覆盖值落 `.env`（新可选 `PUBLIC_HOST`，默认空 = `null`），不落库**：host 属部署环境属性，归 `.env` 口径，免 DB / 免 schema / 免审计面；设置后即为接入页对外展示的权威基址（不带 scheme）。
> ③ **组 key 不进本响应**：网关 key 明文只在签发响应出现一次（§4：`POST /api/groups` / `POST /api/groups/:id/keys`），掩码列表走既有 `GET /api/groups`（`gatewayKeyMasked` + `keyCount`）——接入页「复制 key」指向用户组发 key 流程，无状态只读面不得变成第二个 key 读面。
> ④ **零行为面变更**：`/api/*` / `/v1/*` 既有响应零字节变更；`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增（本端点无错误分支，鉴权失败同 §1 既有 401/403）；`SCHEMA_VERSION` 仍为 2、零 DDL、零迁移；`src/gateway/` 零改动。
> **v1.13.0（2026-10-14，账号绑出口写路径 + 读面 —— 交付链缺口 1/2 的地基，PM 派单 / 画师「接口先行」点单）**：新增 **§15.2 `PATCH /api/supplier-accounts/:id`（收 `egressId` + `revision`）**，并**非破坏**给 **§15.1 `SupplierAccount` 加一格 `egressId`**。动机与影响见 **`docs/adr/0029-supplier-account-egress-binding.md`**。
> ① **修的是"能建出口、绑不上账号"这条断链**：`supplier_accounts.egress_id` 的 DDL 与快照读早落（§16.7 / ADR-0021 决策 5 的 E 接缝，`src/wiring/store.ts` 的 `account_egress_id`），而管理面 12 条路由里**一条都写不了它** —— 出口池的配置面（§16.7.2 七条）建得出条目，账号却永远绑不上去。本版补上唯一写入口。
> ② **读面同批补（这是画师点单的核心）**：`SupplierAccount.egressId`（`string | null`，`null` = **未绑定、走宿主出口**，是配置事实不是未知）。此前三条纪律把读面写死为"没有"（§15.12 第 3 行"穷尽、不加 `egressId`"、§16.7 绑定纪律之三"`egress_id` 不进任何 DTO"、§7 帧本期不发射）—— 结果就是**盲写**：用户点完在界面上看不见结果。**本版把它们逐条改口并给出理由**（不是悄悄推翻）：那三条的动机是"建表 ≠ 前端要处理它"（防的是提前造一个无数据的读面），而写路径一旦存在，缺读面就从"不做多余的事"变成"做了一半"。**出口池的状态**（在线 / 冷却 / 出口 IP）**仍然只有 §7 帧一条读面**，本格只答"这个账号自己绑了谁"。
> ③ **活性校验（§16.7 裁定 6 账号侧对称条落地）**：`egressId` 指向**不存在或已 `retired`** 的出口 ⇒ `400 INVALID_PARAM`（`details.field = 'egressId'`）；`null` 合法（解绑 = 回宿主出口）。判据先于乐观锁："填错了"必须报成填错，不能伪装成并发冲突。
> ④ **`change_log` 广播（ADR-0021 决策 5 / `schema.ts` 那段 ⚠ 约定）**：改这一列 = 改网关快照里**每把 key 的出口归属**，而 `supplier_accounts` **不在** `SNAPSHOT_ENTITIES` 里 ⇒ 按**受影响的每把 `pooled_key_id`** 各发一条 `entity='key'` 变更，**与写入同一事务**。漏发的表现不是报错，是那把 key 的出口永远停在旧值（出口预算按 id 分桶 ⇒ 一根出口两个桶 ⇒ 放行量翻倍）。
> ⑤ **乐观锁 `revision` 必填**（§0.2）：不符 ⇒ `409 REVISION_MISMATCH`（带 `expected` / `actual`，同 `keys.ts` / `upstreams.ts`）。**值未变 = 空操作**（不推 `revision`、不发广播）：否则连点两次同一个出口会白推一次快照重建，而 `applySnapshot` 会把 token-plan key 的乐观扣减清零。
> ⑥ **审计**：`supplier.account.update`，`detail` 只放 `egress=<id>` / `egress=null`（**不含凭据**，本路由也收不到凭据）。
> ⑦ **`export` CSV 列清单本版不动**（登记理由）：对账表的列口径属 §15.2 另一条正文；为一个新格单开一次列变更，会把"本笔只做绑定链"的面撑大，要加走下一笔显式决定。
> ⑧ **零行为面变更**：`/v1/*` 零变更（`src/gateway/` **零改动**）；`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` **零新增**（本笔新码一个都不需要：`400 INVALID_PARAM` / `409 REVISION_MISMATCH` / `404 NOT_FOUND` 全是既有的）；`SCHEMA_VERSION` 仍为 2、**零 DDL、零迁移**（列早在 §16.7 批次就建好了）。
> **无既有字段改名、无字段删除（纯加一格可空字段）、无端点删除。**
>
> **v1.13.1（2026-10-14，出口协议面收口 —— §16.7.2 补一句「只支持 HTTP(S) CONNECT」 + 一条入口阻断用例）**：PM 复验点名两处 —— 面板警示条与后端事实相反（已修，`29e7479`）、`grep socks5 src/` 零命中（blocking 用例不存在）。本版把口径钉进正文、把判据钉进用例。落笔依据见 **`docs/adr/0021-egress-budget-seam.md`**（决策 9 落笔边界）与 `docs/proposals/egress-proxy-onboarding.md` §1.1。
> ① **协议面成文（§16.7.2）**：出口**只支持 HTTP(S)（CONNECT 隧道）**。`normalizeEgressUrl` 只收 `http:` / `https:`，**`socks5://` / `socks4://` 等非 HTTP(S) 协议在创建 / 保存那一刻即被入口拒下**：`400 INVALID_PARAM`（`details.field = 'url'`）。**不存在「静默直连」** —— 被拒 = 行没落库 = 没有出口可用，而**不是**「忽略协议、改从宿主 IP 出站」（同 ADR-0021 决策 9(5) 「不得静默回落」的取向）。理由是可实现性：`undici` 的 `ProxyAgent` **不支持 SOCKS**，换 fetch 栈与「stream 透传不缓冲」的既有实现冲突（onboarding §1.1）。
> ② **判据落地**：新增一条入口阻断用例（`src/api/routes/egress.spec.ts`）：`POST /api/egress {url: "socks5://…"}` → `400 INVALID_PARAM`（`details.field='url'`）**且零行落库** —— 把「协议面」从「实现里写了」变成「闸上有判据」（同批删除面板那句说反话的警示条文案，`29e7479`）。
> ③ **零行为面变更**：`/api/*` / `/v1/*` 既有响应零字节变更（`normalizeEgressUrl` 判据一字未改，本版只补文档与用例）；`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增；`SCHEMA_VERSION` 仍为 2、零 DDL、零迁移；`src/gateway/` 零改动。
>
> **v1.13.2（2026-10-16，套餐 key 优先于余额 key —— ADR-0011 排序键 2 追认 + ADR-0022 §4 的"回填"腿落地）**：动机是用户需求原文「先处理套餐 key 比较合理毕竟套餐 key 只有 30 天有效期」。落笔依据见 **`docs/adr/0030-plan-key-before-balance-key.md`**。
> ① **排序口径变更（`src/gateway/key-pool.ts`，1 个常量）**：`remainingQuotaOf` 对「套餐余量未知」（`token_plan_remaining IS NULL`）的哨兵值 **`-1 → 1`**。取 `1` 是唯一同时满足两个约束的值：**`> 0`** ⇒ 压过 balance 类的常量 0（余额 key 整类沉到套餐 key 之后）；**`≤ 任何可用套餐 key 的真实余量`** ⇒ `isUsable` 已排除余量 0 的套餐 key，"可用"的已知余量最小就是 1，未知值不会盖过任何一把真实有额的套餐 key。**`/v1/*` 响应零字节变更、无新错误码** —— 变的只是 `getAvailableKeys` 返回列表的**内部顺序**（§"返回顺序即优先级"本就是 ADR-0011 立的规矩）。
> ② **回填腿（ADR-0022 §4 / v1.9.0 ④ 承诺的"后续"首次落地）**：`GET /subscriptions` 每轮同步拿到的 `basic_token_total` / `basic_token_used` / `end_time`，回写到该账号**已入池的套餐 key**（`token-plan`）的 `token_plan_remaining` / `token_plan_expires_at`。三条取值纪律：**单位是 Token 个数**（`basic_*` 与 `amount_*` 是两套池，前者**绝不**过 `quotaToCents`）；**`basic_token_total` 取不到 ⇒ 整行跳过**（`null` = 上游没说，写 0 会让那把 key 被静默排除出选路）—— **v1.14.0 起同款纪律扩到 `basic_token_used`**（原实现对它 `?? 0`，是替上游下一个它没下过的结论，见本文件 v1.14.0 ⑤ / ADR-0031 决策 5）；**余量可递减** ⇒ 不复用 `applyTemplateTokenPlan`（`COALESCE` 写不进更小的数）。掩码撞号 / 认领不到 ⇒ 一行不动（同 §15.2 `KEY_MASK_AMBIGUOUS` 取向）。
> ③ **广播**：每把被回填的 key 在同一事务里各发一条 `entity='balance'` 的 `change_log`（该实体在 `SNAPSHOT_ENTITIES` 内 ⇒ 网关下次 `refresh()` 重建快照，配额列即刻生效）。
> ④ **`/v1/*` 与 `src/gateway/` 零改动**：准入过滤（`isUsable` 的 `balanceCents === null || > 0` / 套餐到期 / 余量 ≠ 0）**一字未动**，"未知 ≠ 不可用"完整保留 —— 本版只改"未知排在谁前面"。`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` **零新增**；`SCHEMA_VERSION` 仍为 2、**零 DDL、零迁移**（回填写的是既有列）。
> ⑤ **已知边界（不粉饰，写在这里不留待发现）**：套餐 key 只服务部分模型（实测 `TierSense` 回 **404**），而 404 按 §10 属"客户端错、原样透传、不换 key" ⇒ 套餐 key 排前之后，套餐不支持的模型可能直接拿到那个 404。**这不是 v1.13.2 引入的新风险**（套餐 key 有已知余量时 ADR-0011 时代它已排在前面）；修法要动 `classify.ts` 的 404 口径或给 rotate 写 `model_limits`，属独立契约决策，留待后续 ADR。
>
> **v1.14.0（2026-10-16，站点换算比不再写死 —— `createToken` 走上游真值；附一处回填文档漂移订正）**：动机是契约 §15.1 自己的那一句「换算基准 `quota_per_unit` 每次查询时从上游读、不写死 —— 供应商改了换算比，我们的数不会跟着错」，而**写侧只剩一处例外、且恰好是"花钱"的那一处**：`createToken` 建固定额度 key 时把 `quotaCents`（分）换算成上游的 `remain_quota` 用的是写死的 `DEFAULT_QUOTA_PER_UNIT`（500000）。落笔依据见 **`docs/adr/0031-quota-per-unit-from-upstream.md`**。
> ① **换算比由调用方给**：`createToken` 入参新增**可选** `quotaPerUnit`（站点自己的 `/api/user/self → data.quota_per_unit`），实现里 `?? DEFAULT_QUOTA_PER_UNIT`。**可选**是因为 `unlimited:true` 时上游根本不看这个数（body 里没有 `remain_quota` 可错），必填会逼调用方为一个不会被读的字段找值。
> ② **`supplier_accounts` 加两列纯缓存**：`quota_per_unit` INTEGER NULL / `quota_read_at` TEXT NULL，**均可空、无默认、不进 `SupplierAccount` DTO**。`NULL` = **从没读到过**（不是 500000 —— 给默认值会让"没读过"伪装成"读过 500000"，`quota_read_at IS NULL` 这条判据就失效）。写入由**四条已经在打 `/api/user/self` 的腿**顺手完成：登录探活 / 余额刷新 / 自测 / `keys/sync`，**零新增上游请求**。只在**真读到**时写（同 §14.2 `balance_updated_at` 的纪律：查失败一个字都不写，否则把上一次真值抹成"没读到"）。
> ③ **建 key 时不为拿比值多发一次请求**：取值是 `cred.quotaPerUnit ?? undefined`（**从库里读**）。§15.5「单账号请求数：建 key = 2」那行**逐字不变** —— 加一发 `/api/user/self` 就是 3 次，那是破坏一条已发布的契约行。判据用例钉的是 **`count('/api/user/self')` 在建 key 前后不变**，不是"请求数等于 2"。代价说清楚：库里的比值**可能过期**，本版选「一个可能过期的真值」对「一个永远错的常量」—— 站点不改比值时前者**永远正确**，站点一改错到下次刷新为止；后者站点一改就**立刻错**。
> ④ **§15.13 rotate 腿的第二处写死同批修**：`mapSubscriptions(..., DEFAULT_QUOTA_PER_UNIT)` → `cred.quotaPerUnit ?? DEFAULT_QUOTA_PER_UNIT`。rotate 是**单请求**动作，只读缓存、不刷新缓存（刷新账号级缓存是下一轮 `refresh` 的职权）。
> ⑤ **回填文档漂移订正（零代码契约含义变化，实现对齐 ADR-0030 决策 2 的原文）**：`backfillSubscriptionTokenPlan` 原对 `basic_token_used` 用 `?? 0`，与 ADR-0030 只写的「`basic_token_total` 取不到 ⇒ 整行跳过」不一致。订正为**两格任一未知 ⇒ 整行跳过**，`token_plan_remaining` 保持 `NULL`。`?? 0` 的语义是替上游下一个它没下过的结论（"这个套餐一点没用过"），而这一减产出**具体的数**（= 全额），它会以"我们查过了"的面目进网关选路键 2、进 `balance_updated_at`、进前端。**代价不是这把 key 被踢出选路**：`remainingQuotaOf` 对 `NULL` 回 `UNKNOWN_PLAN_QUOTA`（= 1），`1 !== 0` ⇒ 仍可用、`1 > 0` ⇒ 仍排在余额 key 前，只是落在"未知"档不参与精确排序 —— **宁可排序粗一格，也不要编一个余量**。
> ⑥ **影响面清单**：`/api/*` 响应**零字节变更**（两列不进 DTO）；`/v1/*` **零变更**、`src/gateway/` **零改动**（本版不碰选路）；`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` **零新增**（没有任何新的失败形态 —— 只是让一条既有路径取对值）；上游请求数**零增加**；审计动作**零新增**（记比值是缓存维护，不是管理动作）。**DDL：两列纯加列，`SCHEMA_VERSION` 仍为 2、零迁移脚本。**
>
> **v1.14.1（2026-10-16，五张表的保留策略 —— 从"表只会长"到"每张表都有人扫"）**：动机是清完一遍 prune 调用方之后剩下的形状 —— 五个 prune 函数里**两个有实现、零生产调用方**（`pruneGatewayErrorEvents` / `pruneChanges`，前者连 spec 都有、生产里从不运行），`audit_log` / `tasks` 连函数都没有。一个"存在但没人调用"的清理函数比"没有这个函数"更坏：它让"这张表有保留期"看起来**已实现**。落笔依据见 **`docs/adr/0032-table-retention-policy.md`**。
> ① **新增 `pruneAudit`（`audit_log`）+ 独立保留期 `AUDIT_RETENTION_DAYS`（默认 180 天）**：**不并进 `LOG_RETENTION_DAYS`** —— 两张表回答的问题不同，`usage_logs` 是"跑过多少流量"、`audit_log` 是"**谁在什么时候改过什么**"，安全事件的追溯期本就长于用量明细的有用期。**仍然没有 delete 函数**：`pruneAudit` 按**时间窗**删，不认 id / actor / action —— 逐行删审计的能力是"谁能抹掉自己的痕迹"的入口，那个口子不开。
> ② **新增 `pruneTasks`（`tasks`）+ `TASK_RETENTION_DAYS`（默认 7 天）**：只删**已终态**且 `finished_at < cutoff` 的行。`finished_at IS NOT NULL` 这条谓词**单独写出来，即使删掉它现在也恰好安全**（SQL 里 `NULL < cutoff` 恒为假，2026-10-16 变异验证确认删掉谓词用例**不红**）；它真正拦的是 `COALESCE(finished_at, started_at)` 那次"嫌 NULL 比较别扭"的改写（换成它用例**立刻红**）—— 那一版会让在跑的任务按开始时间被裁掉，`getTask` 开始给轮询的前端回 404。删除后**无级联**（`tasks` 没有子表，已删 id 回 404 是正确语义）。
> ③ **`change_log` 按行数裁（`CHANGE_LOG_KEEP_ROWS`，默认 10000），不按天数**：它是**广播信道**不是历史，判据是"消费者的 `seq` 追到哪了"。安全性论证在 `src/db/repo/change-log.ts` 头注（消费者 `drainChanges` 每拍把 `lastSeq` 推到读到的最后一条、1s 节拍、一个节拍上界几十条 ⇒ `keep = 10_000` 余量约两个数量级），两个前提（消费者进程活着 / `keep` 不小于一次暂停的累积量）写进注释而不是藏在数字里 —— 所以它**必须是配置**。
> ④ **`gateway_error_events` 按契约原样接上，不新配旋钮**：`pruneGatewayErrorEvents` 保留期取 `LOG_RETENTION_DAYS` —— §12.1 第 1488 行「保留期与 `usage_logs` 同口径（`LOG_RETENTION_DAYS`，默认 30 天）」是**已发布的契约行**，本版做的是把实现补齐到与契约一致，不是顺手改掉它。真要提高错误事件保留期，走契约修订。
> ⑤ **五张表挂同一个 6h 定时器，另两张留在原地**：`pruneAudit` / `pruneTasks` / `pruneGatewayErrorEvents` / `pruneChanges` 四条同挂 `6 * HOUR_MS`、逐条 try/catch（清垃圾失败不该带走整台服务）。**不为它们各起一个定时器** —— 多三个定时器就多三条可能在关停时漏清的尾巴。`gateway_health_snapshots` / `balance_snapshots` **不并进来**：它们的写入方已有自己的定时器，再挂一个全局清理器就成了"同一个表两个节拍"，两边保留期一旦配得不一样，谁先跑谁后跑决定库的大小。
> ⑥ **影响面清单**：`/api/*` 响应**零变更**（保留策略不碰任何 DTO、不改任何查询口径）；`/v1/*` **零变更**、`src/gateway/` **零改动**；**DDL 零**（`SCHEMA_VERSION` 仍为 2、零迁移脚本 —— 删行不需要动表结构）；`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` **零新增**；审计动作**零新增**（裁剪是维护动作，给它记一条审计会自我抵消）；三个新旋钮**全部有默认值，缺省行为 = 本版口径**。判据 `src/db/repo/retention.spec.ts`（16 条，全部经变异验证）。
>
> **v1.14.2（2026-10-16，出口探活端点可配 —— 一个会静默骗人的故障形状）**：动机不是"多一个开关"，是 `api.ipify.org` 从网关所在网络不可达时**回显端点会主动骗人**：`/api/egress/:id/test` 对一台完全健康的代理回 `ok=false`，并把那个 false 写进 `egress_proxies.last_test_ok` —— 面板上唯一那个"我的出口通不通"的信号在最坏情况下恒假，照着它删代理的人删掉的是能用的机器。心跳生产者入口 B 同源且更隐蔽：端点不可达 = 每拍一条失败证据，累计到 `HEARTBEAT_EVICT_AFTER_FAILURES`(3) 就把好节点**静默摘除**（无报错，只是可用出口少一个）。落笔依据见 **`docs/adr/0033-egress-echo-url-configurable.md`**。
> ① **新增 `EGRESS_ECHO_URL`**（空 / 未设 = 用缺省值）：取值只做 trim、**不做 URL 语法校验** —— 一个连不上的端点就是一次失败的探测，那正是探测的职责；而"拒绝启动"会让填错别名的用户在启动阶段看到一句与网络无关的报错。
> ② **缺省值只有一份字面量** —— `EGRESS_ECHO_URL_DEFAULT`（`src/egress/port.ts`），两个消费者（`/test` 与心跳入口 B）都从那里取。两处各写一遍的失败形状**不是**"以后要改两个地方"，而是两个消费者可以配不同的值而毫无症状：面板说这台通（打新端点）、心跳说这台死了（还打旧的），两边日志还都写着"探测正常" —— 用户看到的是"同一条数据两个互相矛盾的真相"。
> ③ **缺省值不变**：本版**不**把缺省换成国内可达的目标。换缺省会静默改变所有现存部署的探测语义（含那些"我测过、面板显示通"的记录），而那件事该由部署者显式做。
> ④ **影响面清单**：`/api/*` 响应**零字节变更**（同一个端点、同一个字段，只是它去打的那条 URL 变成可配）；`/v1/*` **零变更**、`src/gateway/` **零改动**；**DDL 零**（`SCHEMA_VERSION` 仍为 2、零迁移）；`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` **零新增**；审计动作**零新增**（探活是诊断不是管理动作，这条 v1.7.1 起就没变）。判据：`src/egress/heartbeat.spec.ts`（缺省走缺省 / 配了走配的 / 字面量唯一性三条）+ `src/api/routes/egress.spec.ts`（同形两条，断言打进假件的 URL）+ `src/config.spec.ts`（空串 = null），**全部经变异验证**。
>
> **v1.16.4（2026-10-18，Cookie 粘贴进管理面 —— 业主显式接受"自用项目，值过一次 HTTP"）**：**动机是 Bo 的两句话**：「我感觉好麻烦，还是直接做到web吧，我这个人自用项目不会泄露的」与「不是上传文件，只是粘贴cookie到输入框」。v1.16.3 的 cookie-only 导入仍要求回终端跑脚本（30 个号 = 30 次命令），本版把同一条解析链接到管理面：① **新增端点** `POST /api/supplier-accounts/import-sessions`（body `{upstreamId,text}` → `202 {taskId}`，任务类型 `supplier_import_sessions`），`text` 每行一枚会话；**仅 TokenRhythm**，TierFlow 入口 `422`（它有密码通路，没有理由把会话值送进浏览器）。② 服务端直接复用 `importSupplierSessionCookies`（v1.16.3 的逐行解析 / `GET /api/me` 身份解析 / uid 判重 / 加密落库**一行未复制**），逐行结果复用 §15.3 `SupplierBatchResult`；**`action` 枚举新增第 7 个值 `import`**（只登记会话，没有发生登录）。解析失败行 `LINE_PARSE_FAILED` 归 `skipped`；401 `SESSION_EXPIRED`、连不上 `UPSTREAM_UNREACHABLE` 归 `failed`；403 仍**不**映射成会话过期（ADR-0040 钉子）。③ **入口闸在任务创建前**：非 TR 上游 / 排除名单非空 → `422 UNPROCESSABLE`；空文本、只有表头注释 → `400 INVALID_PARAM`。④ **纪律的显式例外**：§15.9 纪律 1「不进 HTTP 面」从此有且只有这一条例外，理由是业主对"粘贴值经过浏览器与代理"的明确风险接受；值**不写日志、不进审计 detail、不回显**（响应 / 任务 result / 错误 message 只有掩码），落库即密文，前端提交后立刻 `resetFields()`、不写本地存储。⑤ **前端**：`SupplierCapabilities` 增 `sessionImport` 位（TierFlow `false` / TR `true`），「导入账号」按钮对 TR 改为**可用**的「导入 Cookie」，弹窗按能力位切换成 cookie 粘帖框（不新增第二个弹窗）。**影响面**：`/api/*` **新增 1 个端点**（其余零变更）；`/v1/*`、`src/gateway/` **零改动**；**DDL 零**（`SCHEMA_VERSION` 仍为 2）；`ERROR_CODES` **零新增**（422/400 复用既有码）；审计动作**零新增**（复用 `supplier.import`，detail 只有计数）；`web/` **零新依赖**。**判据**：新增 **5 条**路由用例（成功落库与不回显 / 重复行 skipped + 过期行 failed / TierFlow 422 / 排除名单 422 / 空文本 400），全量套件 **1127 passed**（node22）；后端 `tsc` rc=0；`web/` `tsc --noEmit` rc=0。详见 §15.2 / §15.3 / §15.9 / §15.14 与 ADR-0040 决策 8。

> **v1.16.3（2026-10-18，cookie-only 导入 —— 没有手机号/邮箱也能把会话批量入池）**：**动机是 Bo 的一句实情**：「我只能提供cookie」。v1.16.2 的批量文件仍要求每行带标识，而 TokenRhythm 操作员手上常常只有会话 —— 标识这一栏对他们不可填。本版补的**不是新入口，是同一离线脚本的第二种输入形态**：① `SUPPLIER_SESSION_COOKIE_ONLY=1` + `SUPPLIER_SESSION_BATCH_FILE`（每行一枚会话，`tr_session=…; Path=/` 或裸 value 均可；`Cookie:` 前缀也容忍）。② 新增 `src/supplier/session-resolve.ts`：用会话发**一次** `GET /api/me`，取 `data.id`（UUID）/ `data.name` / `data.phoneMasked`（无则 `emailMasked`）；401 = 会话失效，403 = 上游拒绝**不**当会话过期（ADR-0040 钉子）；上游若回未掩码值，本地再掩，掩不出即拒绝该行。③ 新增 `src/supplier/session-import-cookie.ts`：逐行解析 + 解析身份 + 落库；**单行失败不中断整批**，输出只有行号 / 掩码 / 原因。④ 判重键改为**上游 uid**：`identifier_hash = sha256('tokenrhythm:uid:<id>')`；既有行按 `uid → 掩码 → 摘要` 顺序命中，所以"先按真值导入、后按 cookie 重导"仍汇入同一行（`importResolvedSupplierSession` 只覆写会话与权威信息，不改既有行的展示掩码/摘要）。**排除名单非空时该模式整体拒绝**（名单按真值匹配，只有掩码无法验证；静默放行等于把硬约束变成建议）。**与标识+会话模式的唯一区别是每行 1 次 GET**；四条纪律（不进 HTTP 面 / 不经 Agent 与本仓 / 入库即作废 / 只服务管理面）逐条不变，值仍只从本机文件读、仍只打印掩码、前端仍无会话输入控件。**影响面**：`/api/*` **零新增、零删除端点**；`/v1/*`、`src/gateway/` **零改动**；**DDL 零**（`SCHEMA_VERSION` 仍为 2）；`ERROR_CODES` **零新增**；审计动作**零新增**。**判据**：新增 **18 条**离线用例（`session-resolve.spec.ts` 8 条 + `session-import-cookie.spec.ts` 10 条），全量套件 **1122 passed**（node22）；typecheck rc=0。详见 §15.9 / §15.14.2 与 ADR-0040 决策 6。
>
> **v1.16.2（2026-10-18，离线会话导入支持批量文件 —— 入池通路不变，省掉"每号跑一次脚本"）**：**动机**是 Bo 在看到「导入账号」对 TokenRhythm 置灰后的追问：「如果不能导入，那我怎么批量添加cookie然后添加账号呢」。v1.16.1 把 TR 的**唯一**入池通路定死为 §15.9 的离线一次性会话导入，但脚本一次只读一个 `SUPPLIER_IDENTIFIER` + 一个会话 —— 27 个号就是 27 次命令，实操上会把人推回"找个 HTTP 入口吧"的错误方向。本版把同一件事做成循环，**不开任何 HTTP 入口**：① 新增 `src/supplier/session-import-batch.ts` —— `parseSessionBatchText()`（每行 `标识<分隔符>会话`，分隔符 TAB / 逗号 / 空白，空行与 `#` 注释跳过，首行可带 `identifier,session` / `账号,cookie` 表头；**会话一侧可整段粘贴 `tr_session=…; Path=/`，只取 value**；同一账号出现两次保留第一行并报一行）+ `importSupplierSessionBatch()`（逐行调用既有的 `importSupplierSession`，**单行失败不中断整批**，报告只含行号 / 掩码 / 原因）。② `scripts/import-supplier-session.ts` 新增 `SUPPLIER_SESSION_BATCH_FILE`（`-` = 从 stdin 读），单账号模式保持原样；退出码 0 = 全部成功、1 = 至少一行失败 / 未解析、2 = 配置缺失。**纪律一条不改**：值只从运行时环境变量或本机文件读，输出只有掩码，失败信息不回显会话值或标识原文，**前端仍然没有任何会话值输入控件**（只把按钮 tooltip 改成提示可批量）。**影响面**：`/api/*` **零新增、零删除端点**；`/v1/*`、`src/gateway/` **零改动**；**DDL 零**（`SCHEMA_VERSION` 仍为 2）；`ERROR_CODES` **零新增**；审计动作**零新增**；新增模块与脚本是离线工具，不进请求链路。**判据**：`src/supplier/session-import-batch.spec.ts` **7 条**（三种分隔 / 表头 / Cookie 清洗 / 重复行 / 逐行报错不回显 / 批量落库与覆写 / 排除名单），全量套件 **1104 passed**（node22），明文扫描 PASS（364 文件 / 0 命中）；并在一份**测试库副本**上跑通真实脚本（3 新建、2 行跳过、退出码 1；库内无明文会话，临时文件已 shred）。详见 §15.9 与 ADR-0040 决策 6。
>
> **v1.16.1（2026-10-18，TokenRhythm 的登录形状订正 —— "端点存在"不等于"密码登录可用"）**：**动机是 Bo 的直接纠正**：「这个只能是 cookie 登录啊……还有创建 key 功能呢批量创建。你能不能好好看看接口文档」。v1.16.0 把「`POST /api/auth/login` 能发通、能拿到 400/401」误读成「这家支持账号密码登录」，于是在驱动器里实现了一条 `login()`，并据此把 HTTP `import` / `:id/login` 写成"登录 + 刷新"。**复核结论**：该端点**从不校验密码** —— 无论 `{account,password}` 取什么值都回 401 `UNAUTHORIZED`（与过期会话同码同文案），12 轮探针里**没有一次成功登录**；站点文档也从"已持有 `tr_session`"开始，真实登录是验证码 / `login-or-register` 流程，网关不应代跑。**订正三处**：① **驱动器 `login()` 改为零请求的能力缺口**，直接回 `rejected`（消息只说明"只有会话鉴权"，不回显标识 / 密码）；`callWithRelogin` 因此对 TR **永不发重登请求**（无密码 → 直接 `session_expired`；即便库里有历史密码，`login()` 也是零请求拒绝）。② **`POST /api/supplier-accounts/import` 与 `POST /:id/login` 对 TR 在入口 422**（`UNPROCESSABLE`）—— 不解析文本、不发上游请求、不写库；入口判据集中在一张 `SUPPLIER_PASSWORD_LOGIN` 能力表，不散落 `if (supplier === …)`。③ **新增 §15.9 的离线一次性会话导入落地件**：`src/supplier/session-import.ts`（归一化 → 掩码 / 摘要 → 排除名单 → 建行或按 `(upstreamId, identifierHash)` 覆写 `encrypted_session`；**零上游请求**；绝不回显会话值；落 `status="unknown"` 等 `refresh` 验活）+ `scripts/import-supplier-session.ts`（操作员本机、值只从运行时环境变量或本机文件读、只打印掩码）。**批量建 key 的代码未变**：`POST /api/supplier-accounts/keys` → `createKeysForAccount` → `client.createToken`，TR 仍是 1 次上游请求 `{name}` + CSRF 双提交；本轮把"TR 能建 key"从**代码存在**变成**可验收**（有会话账号即可跑通）。**契约同步**：§15.9 加 TR 例外（`credentialSource` 恒 `session`，无补录密码升级路径）、§15.2 `import` 加入口 422、§15.14.1 能力表新增「账号密码登录」行、§15.14.2 事实 1 与三条硬纪律重写、§15.14.3 的 `import` 预算改为 **0**。**影响面**：`/api/*` **零新增、零删除端点**；`/v1/*`、`src/gateway/` **零改动**；**DDL 零**；`ERROR_CODES` **零新增**（422 复用 `UNPROCESSABLE`）；审计动作**零新增**；**前端** `SUPPLIER_CAPABILITIES` 新增 `passwordLogin` 位（TR = `false` ⇒ 「导入账号」按钮禁用并提示走离线导入 —— 镜像服务端入口 422，不画点了必然失败的按钮；**不新增任何会话值输入控件**）。**判据**：离线用例新增 6 条（`session-import.spec.ts`），TR 驱动器与路由用例改为会话语义后全量 **1097 passed**（node22）；typecheck rc=0；明文扫描 PASS（362 文件 / 0 命中）；`web/` `tsc --noEmit` 0 错 + `vite build` ✓。**LAN 实例实测**（真会话，只走离线导入）：导入落库 → `refresh` 转 `active`（余额 2366 分）→ `keys` 批量建 key 成功（1/1，`****D6MI`，`unlimited=1`、`balance_cents/model_limits=NULL`）→ `import` / `:id/login` 均回 422。详见 ADR-0040 的 v1.16.1 订正段。
>
> **v1.16.0（2026-10-18，第二家账号面供应商 TokenRhythm —— ADR-0018 决策 0「以后要接第二家，是加一个驱动器」的兑现）**：**动机**是 Bo 给出第二家的接口文档并指令实现批量化：「让你添加第二个特殊供应商 tokenrhythm，让你实现它的批量化……两个供应商的接口不一样。tokenrhythm 的接口需要你自己实测，然后再决定怎么加」。**先实测后设计**：12 轮现场探针钉死四条与文档不符的事实（① 文档**整篇没有登录端点**（**v1.16.1 订正**：`POST /api/auth/login` 端点存在，但**从不认证密码** —— 任何输入一律 401，不能作为登录通路；见下）；② 文档说 CSRF 要「`Origin` + `Referer` + `Sec-Fetch-Site` 三件套」，**实测硬性只有 `Sec-Fetch-Site: same-origin`**，单变量 A/B 钉死；③ 文档说 CSRF token「每次请求后立即失效」，实测**轮换但非一次性**；④ 文档**没有余额接口**，实测 `GET /api/wallet/summary` → `availableBalanceCny` 8 位小数 CNY 字符串），全文见 **§15.14.2** 与 ADR-0040。**结构上实现同一个 `TierFlowClient` 协议**（`src/supplier/tokenrhythm.ts`）—— 六个批量端点（`import` / `refresh` / `:id/login` / `:id/test` / `keys` / `keys/sync`）连同被动重登、账号级节奏、逐行累加那一整套机制**一行不改**，`clientFor()` 按 `upstreams.supplier` 选驱动器。**两家真正的差异不是字段名，是能力集**：TokenRhythm **没有**套餐（订阅腿零请求回 `[]`）、**没有** key 额度（`unlimited` / `quotaCents`）、**没有**模型白名单、**没有** `quota_per_unit`（落常量 `100`，只为"分"口径自洽，建 key 不消费它）。差异表达为**两张具名能力闸**而不是散落的 `if (supplier === 'tokenrhythm')`（§15.14.1）：`keys` 拒收 `unlimited:false` / 非空 `models`、`rotate-key` 对无套餐供应商整体 `422`，**默认路径零闸**（`parseKeySpec` 的默认值恰是 TR 唯一合法形状）；前端是同一份事实的镜像 —— `SUPPLIER_CAPABILITIES: Record<SupplierKind,{plans,keyQuota}>` 一张表 + 六个消费点全部查表（套餐台账页签 / rotate 按钮×2 / 建 key 弹窗额度三项 / 资金池卡片数 / 套餐余额列 / 展开行套餐块），**没有一处写死供应商名**。**§15.12 锚 1 改口**：前端判据从等值比较 `supplier === "tierflow"` 改为**集合成员** `supplier ∈ SUPPLIER_ACCOUNT_KINDS`（`hasSupplierAccountPanel()`）—— 等值比较的失败模式是**静默的**（接入第二家不报错，只是新供应商一个入口都没有）。**已知边界写在这里不留待发现**：TR **没有可用的密码登录**（**v1.16.1 订正**：`/api/auth/login` 从不认证密码）⇒ 没有被动重登，入池只走 §15.9 离线会话导入；**403 与 401 是两条路**，403 `CSRF_INVALID` **绝不映射成 `session_expired`**（凭据是无辜的，那会把操作员引去重新导入一枚还有效的会话）；key 数量上限是**上游侧事实**，不本地造"剩余配额"数；`data.id` 是 UUID ⇒ 池内 key 的 `tokenNo` 落 `null`，台账按**掩码尾 4** 对账（实测与真值一致）。**影响面清单**：`/api/*` **零新增、零删除端点**（六个批量端点 + `rotate-key` 复用既有路径，差异全在驱动器与闸门内）；`/v1/*`、`src/gateway/` **零改动**；**DDL 零**（`supplier_accounts.supplier` 列建表起就在，值域扩一项而已，`SCHEMA_VERSION` 仍为 2、零迁移）；`ERROR_CODES` **零新增**（422 用既有 `UNPROCESSABLE`，逐行码同 §15.4 处理）；审计动作**零新增**（`supplier.*` 六个动作不带供应商后缀，本就按动作记）；`web/` **零新依赖**。**判据**：离线用例 **34 条**（`src/supplier/tokenrhythm.spec.ts` 27 条 + `src/api/routes/supplier-accounts-tokenrhythm.spec.ts` 7 条），全量套件 **1092 passed**（node22）；`web/` `tsc --noEmit` 0 错 + `vite build` ✓ + 能力分支字符串进 chunk；**LAN 实例手工验收**：枚举放行（旧 dist 回 `INVALID_PARAM supplier 不合法`，即路由层生效的对照证据）、四闸生效（rotate-key 422 / `unlimited:false` 422 / `models` 422 / 合法形状被空池 422 拦下 = 没误伤合法请求）、TierFlow 侧回归无感（49 账号、套餐台账照常）。详见 **`docs/adr/0040-tokenrhythm-second-supplier.md`**。
>
> **v1.15.1（2026-10-17，消费面接入 URL 放行 + `web/` 消费面工作区交付 —— 一份"自己否定了自己"的契约订正）**：**动机**是 v1.15.0 把 **§19.1**（`/api/access-info`（§18）**不放行**给 `role=user`）与 **§19.5**（消费面自己拼 `(publicHost ?? location.hostname) + portGateway`，而 `publicHost` / `portGateway` **只存在于 §18 那一个端点**）写在了同一版里 —— 两条合起来得到的是一个**逻辑上不可能满足**的公式：Bo 要的"普通用户只能通过用户前端获取 url 和 key"里的 **url 那一项取不到**。落地前端时撞上的是实测 403（`role=user` 打 `/api/access-info` → `403 FORBIDDEN`），而 **ADR-0034「影响面」表写的恰恰相反**（"响应体不变，只是多一种身份能读它"）—— 即**契约漂移离了它自己的 ADR**，实现站在了契约那一边。本版按 ADR-0034 的裁定订正契约（不是改实现去凑一份漂移的文本）：**① §19.1 授面表改口**：`/api/access-info`（§18）**放行**给 `role=user`（读 `publicHost` / `portGateway` / `portAdmin`），**仍不放行**的清单保持原样；**② §19.5 改写**：从"管理员从 §18 取、口头告诉用户"改为"消费面直接读 §18，前端按同一公式拼"，并说明**为什么不新开 `/api/console/access-info`**（两个端点回同一份值 = 两份口径，ADR-0033 决策 2 同理由，这里禁的还是第二个端点）；**③ 回应 v1.15.0 立此条的顾虑**（"回 `hostGateway` 绑定地址，对普通用户无意义且易误读成可访问地址"）—— 那是**展示纪律**不是边界问题：绑定地址从不与端口拼接（前端 §18 已有 `joinHostPort` 同一实现），且本端点泄的严格**少于** `/api/console/keys` 已经给出去的东西（那把 key 掩码）；**④ `web/` 交付**：`/console` 工作区三页（接入与 key / 我的用量 / 模型广场）+ 登录按 `role` 分流（`/admin` ⇄ `/console`）+ 消费面越权兜底。**〔v1.15.2 订正：此条写早了，落地时它并不成立 —— 当时只有后端（`console.spec.ts` 30 条全绿），`web/` 侧一条都没写：`SessionInfo` 无 `role`、无 `consoleApi`、无 `/console` 路由、登录仍无条件跳 `/dashboard`。后端授面是**已交付且已变异验证**的事实，"前端也交了"是**计划写成了既成事实**。本版把它改回"未交付"，并把前端列为 v1.15.2 的待办（见下）—— 与 v1.15.1 订正 v1.15.0 是同一种病：契约把**打算做**写成了**已做完**。判据只能是 `git grep`，不是印象。〕****`/v1/*` 零变更、`src/gateway/` 零改动、DDL 零（`SCHEMA_VERSION` 仍为 2、零迁移）、`ERROR_CODES`/`GATEWAY_ERROR_CODES`/`hintCode` 零新增**（放行不产生新错误码，403 分支只是少一条路径）；**新增一条授面用例**（`src/api/routes/console.spec.ts`：`role=user` 打 `/api/access-info` → 200 且字段与管理员同源）+ **一条变异**（把放行清单里这一行删掉 → 红）。**前端零新依赖**（复用 `useResource` / `Panel` / `UsageChart` / `lazyPage`）。*
>
> **v1.15.12（2026-10-18，收起侧栏的把手从底部通栏换成品牌行右侧的图标按钮 —— Bo 原话「你按钮下面的收起侧边栏的按钮不能改个方式吗？换个位置，换个按钮不要这样的一整条，现在很多 agent 的 web 端的侧边栏收起都是在上面的啊」）**：**动机**是**上一版留下的一个直接后果**：`AccountMenu` 钉到左下角之后，它下面正好压着 antd 的折叠把手 —— 那条 `position:fixed` + 满宽 + 自带底色的 `.ant-layout-sider-trigger`，也就是"一整条"。三个毛病：① 通栏色块与侧栏内容不成一套，看着像系统贴上去的；② 它占住左下角，逼得 `aside` 得留一条 `padding-bottom = triggerHeight` 的**空隙**，于是刚刚挪下去的账号按钮只能**悬空一截**，永远贴不到底；③ 位置在底部，而底部已经是账号的地盘。落地：**① `Sider` 传 `trigger={null}`** —— antd 的 `Sider.js` 里 `triggerDom` 只在 `trigger !== null` 时渲染，同时 `has-trigger` 类不再加、那条 `padding-bottom` 也一并消失（`layout/style/sider.js` 的 `&-has-trigger` 规则）；**② 新增 `web/src/components/SidebarCollapseButton.tsx`** —— 28px 的图标按钮（`MenuFoldOutlined` / `MenuUnfoldOutlined`），挂**品牌行右侧**（agent web 端的通行位置，Bo 指定），`marginInlineStart:'auto'` 自己顶到最右，折叠态品牌名消失后它独占一行居中。与 `AccountMenu` 同一条抽件理由（两个外壳各写一份就会漂移）与同一条分包纪律；**③ 底部账号格由 `padding: '… 0'` 改成四边同值**（把手没了，这一格该**贴底**，实测底边距 aside 底边 8px = `space.sm`，不再是悬空的 40px）；**④ 折叠态的品牌行内边距跟着收**（`collapsed ? '0 4px' : '0 8px 0 24px'`）—— 64px 里是"品牌点 8px + gap 8px + 按钮 28px"，展开态那 24px 的左内边距会把按钮**挤出可视区**，而品牌行带 `overflow:hidden`，被裁掉**不报错**，症状是"侧栏再也收不回去"（按钮本来就只有这一个）。**踩到并修掉的一处**：`color` 与 `background` 一开始写在组件的内联 style 里，内联样式**压得住样式表**，于是 `.sider-collapse:hover` 永远不生效 —— 实测悬停前后 `background` 都是 `rgba(0,0,0,0)`、`color` 都是 `rgb(95,112,137)`；把两者移进 `global.css` 的同一条规则组后，悬停实测变成 `rgb(22,32,46)` / `rgb(230,237,247)`（= `bgContainerHover` / `textPrimary`）。这条与 `.account-trigger` 那次是同一种病的两面：**状态样式要么全在内联、要么全在 CSS，两头各写一份必然只有一份生效**。
> **影响面**：`/api/*` 响应**零字节变更**、`/v1/*` **零变更**、`src/gateway/` **零改动**、**DDL 零**、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` **零新增**、审计动作**零新增**、**前端零新依赖**。改动面 = 新增 1 文件（`components/SidebarCollapseButton.tsx`）+ 两个外壳 + `global.css` 一组规则。
> **判据（同一版无 runner，仍是真跑）**：`.ant-layout-sider-trigger` **零个**（改前 1 个）；展开态按钮在 `y=14`（= 56px 品牌行的垂直居中）、右距侧栏边 9px；点它 216 → 64、再点 64 → 216（`aria-expanded` 同步）；折叠态按钮 x=31、宽 28，**完整落在 64px 内**（不被裁）；三档视口 1440×620 / 1024×700 / 1920×1080 下按钮都在视口内且**点得动**（侧栏宽度真的变），矮窗口下账号格贴底不被挤出屏幕；管理面 `role=admin` 与消费面 `role=user` 各走一遍，菜单项分别是 `["admin","用户中心","修改密码","退出登录"]` 与 `["lanuser","修改密码","退出登录"]`（普通用户仍**没有**「管理中心」），两档 console 零报错。
>
> **v1.15.11（2026-10-18，账号入口从顶栏搬到侧栏左下角 —— 一份纯 `web/` 的 1panel 观感改动，Bo 原话「可以把这个用户按钮改成1panel那样放在左下角吗？」）**：**动机不是新功能**，是那个按钮长在**顶栏右侧**：它是一条**会话级**入口（账号 / 切换工作区 / 修改密码 / 退出登录），与"当前在看哪一页"无关，而顶栏那一格承担的语义恰恰是"我在哪一页"。落地四件：
> ① **新增 `web/src/components/AccountMenu.tsx`** —— 菜单体**从两个 Layout 里各抄的一份收成一份**。抽出组件不是为了复用本身，是因为**位置一改就要改两处**，而改漏一处的失败形状是"管理面在左下角、消费面还在右上角"：单看任一边的源码都看不出错了，只有把两个外壳并排看才露馅（这也是它当初会重复的原因 —— 两份内容当时是同一次写的）。放 `src/components/` 而不是 `src/layouts/` 或 `pages/console/`，为的是同一条分包纪律（v1.15.9 那份理由原样）：它只含 antd + `authApi`，**消费面 chunk 引它不会顺带拉进管理面代码**。
> ② **两个外壳的 Sider 改成一列三格**：品牌（`flex:none`）/ `Menu`（`flex:1` + `minHeight:0` + `overflowY:auto`，**菜单自身可滚**）/ 账号按钮（`flex:none`，钉在底）。**不用 `position:fixed/absolute`**：antd 的 `.ant-layout-sider-children` 本身就是 `height:100%`，而 `collapsible` 的 `aside` 已带 `padding-bottom = 折叠把手高度`（`.ant-layout-sider-trigger` 是 fixed 的那一个）—— 所以 flex 末格的**自然位置**就在把手正上方，不需要任何绝对值；侧栏宽度随折叠变（216 / 64），写死偏移量会在折叠时错位，而这是**必然被走到**的状态。
> ③ **顶栏右侧不再留第二份入口**（管理面只剩 `ConnectionBadge`，消费面右侧清空）。理由是状态而不是审美：账号菜单里唯一的本地状态是 `ChangePasswordModal` 的开关，两份挂载 = 两份 state = 一个能只关一边的漂移点；而 `ChangePasswordModal` 本就随菜单一起搬进了 `AccountMenu`（挂载点从两个变成一个）。**没有留 `variant` 开关**：改完之后调用方只有一种形状，"将来也许还要顶栏那版"不是保留两条渲染分支的理由 —— 那两条分支会长歪。折叠态只留头像，名字改走原生 `title`。
> ④ **hover 反馈走 CSS（`.account-trigger`，`web/src/styles/global.css`）而不是内联 style**：`Dropdown` 会把 props 转给子元素，而 antd 的 HOC 在内联样式**之后**写 `style`，用内联的 `:hover` 等价写法（onMouseEnter 改 state）会多一个渲染周期且与 CSS 覆盖顺序打架。
> **授面与角色收敛一个字都没重写**：「切换工作区」仍由 `router/workspaces.ts` 的 `workspaceSwitchItems(role, current)` 给 —— 所以 `role=user` 的菜单里**天然没有**「管理中心」那一项（实测他每条 `/api/*` 都是 403，给入口就是骗他），「修改密码」「退出登录」仍在。登出入口**刻意留在各外壳**（`onLogout` 由外壳传入）：管理面退出要顺带 `stopLive()` + `resetLiveData()` 并弹确认框，消费面没有实时通道要断 —— 那是外壳的**结构**差异，不是 UI 差异，不该被共享组件替任何一边猜。
> **影响面**：`/api/*` 响应**零字节变更**、`/v1/*` **零变更**、`src/gateway/` **零改动**、**DDL 零**（`SCHEMA_VERSION` 仍为 2、零迁移）、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` **零新增**、审计动作**零新增**、**前端零新依赖**。改动面 = 新增 1 文件（`components/AccountMenu.tsx`）+ 两个外壳 + `global.css` 三条规则。
> **判据（`web/` 无 runner，同 ADR-0034 遗留 7 那条）**：`tsc --noEmit` 0 + `vite build` ✓ + **分包核查**（`AccountMenu` 落在共享入口 chunk，其唯一静态依赖是 react chunk；`ModelsPage-*` / `SupplierAccountsPage-*` 仍是 lazy，`ConsoleModelsPage-*` 独立 —— 即"抽共享组件"没有把管理面代码拉进消费面路径）+ **真实浏览器走查**（管理面：展开态 / 折叠态菜单项、切换到用户中心、改密弹窗、退出确认；消费面 `role=user`：菜单**不含**「管理中心」且改密可用；两档角色 console **零报错**；三档视口 1440×620 / 1024×700 / 1920×1080 下按钮底边恒距折叠把手顶 1px —— 矮窗口是这次改动唯一可能自己引入的失败形状：菜单变长会把末格往下推）。
> **顺手记一条运维副作用（本次实测踩到，不是代码 bug）**：重新构建 `web/dist` 之后**必须重启进程**。`@fastify/static` 配 `wildcard:false`（ADR-0027 决策 3）是在 **boot 时**固化文件路由表的，新的哈希入口没有对应路由，请求会被 SPA fallback 接住并回 `content-type: text/html` —— 浏览器侧的症状是 `Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"`，**页面全白而服务一切正常**（`/api/*` 照答、健康检查照绿）。同一条也解释了为什么"改了前端但看不到变化"有两种相反的原因（没重启 = 旧入口还在路由表里 / 重启前构建两次 = 白屏），排查时先看 `/assets/index-*.js` 的 `content-type`，别看浏览器缓存。
> **文档里"两个外壳的账号菜单"那几处（§19.7 / §19 改密段、ADR-0034、ADR-0038）不改写**：它们说的是**入口挂在哪一类菜单里**、不含位置断言，本版之后仍然成立；版本日志是事实记录不是当前状态快照，批量回填旧条目会把"当时是怎么定的"抹掉。
>
> **v1.15.10（2026-10-18，端点类别准入 —— `models.type` 第一次进服务路径，Bo 实测报「来你来测试一下能不能用」→ 定位后裁定「按你建议来」）**：**动机**是 Bo 给的一把真实 key 加 Base URL 实测时，`POST /v1/embeddings` 回了 `404 Invalid URL`。**第一版诊断是错的，Bo 当场纠正**：「tierflow 该上游没有向量模型，你应该是脑子抽风了。这种模型类别是网关的基础功能，而不是上游供应商必须提供的模型」—— 我最初建议"把 embeddings 从文档里那条三端点清单删掉"，那是**把问题倒过来看**。重查代码后的正确结论是：**网关有「模型类别」也有「端点」，却从不把两者对上**。三个证据：① 读路径的 SELECT（`listEnabledGatewayModels`）不带 `m.type`，`ModelDescriptor` 里也没有这个字段，`routes.ts` / `engine.ts` / `key-pool.ts` 里 `.type` **零次读取** —— `type` 只活在 DDL、管理面 CRUD 和模型广场的展示/筛选里；② 两个 handler 结构逐字同形，`requireModelAuthorized` 只按**名字**判授权，从不问类别；③ 引擎把 4xx **原样透传**（`classifyUpstreamStatus` 对 404 判 `null`，这条本身是对的 —— §10 铁律不许一个写错参数的调用方把整池 key 打进冷却），于是**上游的 404 被当成一次正常调用落库**：`attempts:1`（真敲了上游）、`error_code` 空，而 `todayUsage()` **不带状态过滤** ⇒ 管理面组用量行与消费面额度卡（同一句 SQL，§4 / §19.3c 的"字节级一致"）上的 `requests` 双双虚高。落地三件：**① `models.type` 进服务路径** —— 读路径 SELECT 补 `m.type`、`EnabledGatewayModel` 与 `ModelDescriptor` 各补 `type`、`store.ts` 快照重建时建 `name → type` 内存表；`ModelCatalog` 端口新增**同步**方法 `typeOf(name): ModelType | null`（同步是硬要求：转发线程上一次 await 就是一次 TTFB 增量），**走快照**而不是像 `listEnabledModels` 那样实时读库 —— 理由是它属于**转发路径的准入判据**，与选路共用"哪些名字进了快照"这一份事实，于是本闸**永远不会拒掉一个路由器还能路由的名字**（窗口期退回旧行为，不收窄成"列表里有、打过去 400"）。**② 路由层按 `(端点, 类别)` 准入** —— `/v1/embeddings` 只放 `embedding`、`/v1/chat/completions` 只放 `chat`，判在**引擎之前**（与 `GROUP_DISABLED` / `MODEL_NOT_AUTHORIZED` / 限流同一族：0 次真实尝试、候选集不建、不计 key 健康、不碰冷却、事件与响应同源）。**为什么是路由层而不是引擎层**：ADR-0037 决策 4 那条结构理由原样成立 —— 内部助手 `wiring/assistant-invoker.ts` **直调引擎、不过路由层**，判在引擎等于把助手卷进判定。**为什么码选 `400 INVALID_REQUEST` + `param=model` 而不是新码**：这是"你把这个名字用在了不服务它的端点上"，属 `INVALID_REQUEST` 原义；与授权/组停用那类"人不对"（401/403）分开。`GATEWAY_ERROR_CODES` **12 → 12，零新增**。**门序**：组停用 → 限流 → 名字缺失 → 组授权 → **类别**（授权在前是刻意的：没授权该拿"找人开权限"，而不是"换个模型名"这条错误建议）。**未登记的名字本闸不表态**（交给候选集给既有 503）。**③ §10 `GET /v1/models` 每项非破坏新增一格 `type`** —— 准入按类别把关就必须把类别说出来，否则调用方只能盲试端点。**`endpointTypes` 仍恒 `null`、一个字没动**：它是"上游 `supported_endpoint_types`"的预留位（ADR-0024 备选 C），语义是**端点类型**不是**模型类别**，两者不是同一个东西 —— 本版给了前者一个**生产者**的说法是错的，别把这行读成"那个缝终于补上了"。**`src/gateway/` 与 `/api/*` 的其余部分零改动**，DDL 零（`models.type` 建表起就在、`SCHEMA_VERSION` 仍为 2），`ERROR_CODES` 零新增。**闭环测量（真实 LAN 实例，tierflow 上游）**：`POST /v1/embeddings` 打 `tierflow_pro`（登记类别 `chat`）改前 = `404 Invalid URL (POST /v1/embeddings)` + `x-gateway-attempts: 1`；改后 = **`400 INVALID_REQUEST`，无 `x-gateway-attempts` 头、`usage_logs` 零新增行**。判据见 ADR-0039（**新增 8 条用例**：`model-category.spec.ts` 7 条 + `store.spec.ts` 的 `typeOf` 用例 1 条；另有 `routes.spec.ts` 的 `/v1/models` 新字段断言与既有 catalog 桩的 `typeOf` 补齐 —— 这些是**既有用例的扩展断言**，不计入新增条数。4 条变异：拆掉 embeddings 那道闸 / 把闸挪到引擎调用之后 / 闸恒放行 / SELECT 漏 `m.type`，四条全红）。
>
> **v1.15.9（2026-10-18，消费面 key 自助 + 改自己口令 + 额度卡 + 模型广场升级 —— Bo 看 1panel 实测差异后裁定「身份绑定和双因素认证可以不做，其他的能实现吗」→「可以按你的建议来」）**：**动机**是 ADR-0034 锁掉的两件事**被拒的理由不对称**，而其中一条**算错了**：key 自助签发被拒是**风险论证**（"组内任一成员可无限增发、共烧同一个配额池"—— 可以被护栏消掉），自助改口令被拒是**成本估计**（"收益低于成本"—— 可以被实测推翻）。真正的分歧不在"该不该多给用户一点能力"，而在**"不给"的收益被高估了**：ADR-0034 写"用户端获取 key = 看掩码 + 从管理员那里拿明文一次"，但**明文只在签发那一次存在**，而管理面的签发发生在**组**的视角里 —— "给组里第五个客户端发一把 key"意味着管理员要找到组、找到那一行、签发、再把明文抄给用户（经 IM / 邮件 / 便签），而管理面**从未见过"这是谁要的那一把"**（`gateway_keys.label` 这一列**建表起就在**，从来没人写、没人读）。于是"没有自助"的真实形状不是"更安全"，是**整组的 key 生命周期卡在一个管理员手上、且每次经手都要过一次明文**。落地四件事：**① §19.3b 新增三条写路由**（`POST /api/console/keys` 签发 / `PATCH /api/console/keys/:keyId` 改名 / `DELETE …/:keyId` 吊销），护栏 `KEY_SELF_ISSUE_LIMIT = 10` 把持数钉上限、到顶 **422 `UNPROCESSABLE`**（语义合法但业务拒绝，同 §15.4 判据）且**判在签发之前**（先签再判要回滚一次写、还留 id 空洞与两条 change_log）；上限经 `GET /api/console/keys` 的新格 `keyLimit` 回给前端（**上限是服务端的事实**，前端自行数 `keys.length` 等于复刻同一个数字，将来一定漂移 → 一个"点了必然失败"的按钮）；**归属只来自会话**（`groupId` 故意不进 schema：ajv 剥掉之后请求照常成功、调用方以为自己指定了组，比明确拒绝更坏），改名/吊销越权判据 **404 不是 403**（403 会告诉调用方"这个 keyId 存在、只是不属于你"，那正是枚举别人 key 的反馈信号）；审计**复用** `gateway_key.issue` / `.update` / `.delete`（"从哪个面动的"不是"这把 key 有过什么历史"的一半）；**写权限下放后 CSRF 一个字都没动**（闸门在鉴权前校验，消费面不豁免）。**② §1 新增 `POST /api/auth/password`**（改**自己**的口令；**没有 `:username`** —— 少一个参数就是少一类越权面）：旧口令必填且必须验（否则一条被偷走的会话就能改掉口令、把主人锁在门外），**限速与登录共用同一个闸**（不共用则它是一条不受限速的口令猜测通道，而猜中的收益比登录页更高）、新口令 == 旧口令 → 400 **`INVALID_PARAM`**（不拦会产生"改成功但什么都没变"），成功 → `204` + **当前会话留着、其他会话全踢**（同一事务；用 `username` 而非"登录时间"判会话 —— 同账号不同机器的会话之间没有任何可比较的先后）。**前端因此绝不能跳登录页**（跳了用户会以为改失败了），`ChangePasswordModal` 成功后就地给结果卡写明"谁被踢了、谁还在"。**③ §19.3c 新增 `GET /api/console/quota`**：**每一格都是既有字段的透传**（与 §4 `GroupDto` 同一句 `todayUsage()` SQL，"用量页显示的数字"与"管理面组列表显示的数字"是同一句话）；未分配组回 **`null` 而不是 0**（"没有配额"与"配额是 0"是两件事，回 0 会让前端把"你还没进组"渲染成一排 0/0 进度条，而用户会去查"我为什么被限流了"）；组被删而会话还指着它 → 回"未分配"形状（200），不是 500。**④ §4 `GatewayKeyDto` 非破坏新增 `label`**（`string | null`，空串/纯空白经 `normalizeLabel` 收成 `null`，改名与签发**共用这一个出口**）。**闸门零改动**：`inConsoleScope(path)` **只判前缀、不判方法**，三条写路由天然落在这道闸门里 —— 但这条红利同时是警告（**这个前缀下任何写路由的授面就是"该组用户"，新增前必须先想清楚"这一下动的是不是他自己的组"**）；`POST /api/auth/password` 则是**字面路径 + 方法门**放行一行（`GET` 它**不放行** —— 本仓无 405，实测 `role=user` 拿 `403`、`role=admin` 拿 `404`，见 §1 的实测订正）。**`/v1/*` 零变更、`src/gateway/` 零改动、DDL 零**（`label` 列建表起就在，`SCHEMA_VERSION` 仍为 2）、**`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增**（`UNPROCESSABLE` / `INVALID_PARAM` / `INVALID_CREDENTIALS` / `TOO_MANY_ATTEMPTS` / `NOT_FOUND` / `CSRF_REJECTED` 全是既有码）、**审计动作零新增**。**`web/` 四处**：API Keys 页（签发 / 改名 / 吊销 / 一次性明文 / 上限提示）、用量页额度卡（`null` = 不限 → 显示「不限」而**不是一根 0 长度的进度条**；`limit === 0` → 满格红色而**不是 0%**，因为 `0%` 会被读成"一点都没用"）、模型广场升级（接入地址 + **只列网关真实注册的三条** `/v1/models` `/v1/chat/completions` `/v1/embeddings` —— 网关把 `/v1/images/` 等六类一律 501，照 OpenAI 文档列一张更长的表是一份**半真的清单**，比短的那份坏；筛选纪律**改口**：服务端收窄 = **集合**（前端不许碰）、用户关键字 = **视图**（那是他要求的），所以恒显 `已筛选 N / 共 M` 的橙标、筛空给「清除筛选（共 M 个）」而不是空白页 —— 没有这一条，"被筛掉了"会被读成"没有这个模型"）、两个外壳的账号菜单各挂 `ChangePasswordModal`（放在 `src/components/`：放进 `pages/console/` 会让**管理面 chunk 依赖消费面 chunk**，方向反了）。**明确不做**（Bo 已裁定）：身份绑定、双因素认证 / 账号锁定 —— 理由不是成本，是**前者需要一个新的信任根**（绑谁 / 谁证明 / 证明失效怎么办，三个问题各自能吃掉一版），后者要 `admin_users` 之外一整套状态，而恢复码发不出去等于"忘了手机号 = 账号废了"。**遗留四条不粉饰**：① 同组成员可吊销同组 key（护栏管"签几把"不管"谁吊销的"—— 组在这个产品里本来就是互相信任的配额池，真要按人隔离第一件该做的是**按人拆配额**，不是给 key 加 owner）；② 自助签发的 key 与管理面签发的**完全同形**，事后只能从 `audit_log.actor` 分辨；③ `KEY_SELF_ISSUE_LIMIT` 是常量不是配置；④ 改密不跳登录页只保证"当前这条会话还在"，同时被踢的另一个标签页会在下一次请求拿到 401 弹回登录页而**没有任何解释**（要消掉它需要一条跨会话通知通道）。判据见 ADR-0038（服务端 17 条用例 + 6 条变异；`web/` 无 runner，只能靠一次真实浏览器走查）。
>
> **v1.15.8（2026-10-17，用户组模型授权 —— Bo 报的"别人的用户组是可以授权模型的，哪些组下的账号用哪些模型"）**：**动机**：组的两个既有收缩维度各管一头 —— `rpm`/`tpm`/`dailyQuota` 管"用多少"，`upstream_keys.model_limits`（§3/§16.3）管"哪把上游 key 能跑哪个模型"；**"这一组的人许不许用这个模型"没有任何一处能表达**。落地四件事：**① §4 新增「模型授权」** —— `GET`/`PUT /api/groups/:id/models`（`PUT` 整组替换，body `{models: string[] | null, revision}` **两格都必填**：`models` 可空、`null`/`[]` 同义 = 不限，`revision` 是乐观锁（与 `PATCH` 同一条），**本契约不制造网关实现不了的第三态**，沿 §15.7/§16.3 冻结口径；授权键是**模型名**不是 `model_id`，理由与代价见 §4 该节）；**`Group` 对象非破坏新增 `authorizedModels`**（`string[] | null`，与 `gatewayKeyMasked` 同一呈现层：管理面列表可读、PUT 可写）。**② §10 新增 403 `MODEL_NOT_AUTHORIZED`**（`GATEWAY_ERROR_CODES` **11 → 12**，type=`authentication_error`：凭据对了、人不对，与 `GROUP_DISABLED` 同族；0 次真实尝试、不计 key 健康、产 §12.1 事件归 `AUTH_FAILED`）—— **同笔订正一处既有漂移**：`NO_AVAILABLE_EGRESS` 一直没登进 `error-event-sink.ts` 的分型映射，503 事件被归成 `INTERNAL`（error 级），本版补进 `NO_AVAILABLE_KEY` 分型并用例钉住（不静默改，ADR-0037 决策 5）。**③ 网关强制 + 同源收窄**：`GroupContext` 增 `authorizedModels`（实时读库，撤销立即生效同级），路由层在 `readModel` 之后、引擎之前判（chat/embeddings 两个 handler），`/v1/models`、`/api/console/models` 按组收窄 —— §5 `enabled` 行、§10 `/v1/models` 行、§19.6 同批**改口**：同源三角从"全局 0 差异"变成"**enabled 判据 ∩ 组授权，按组成立**"；未授权收缩的组看到的集合与改版前逐项相同（验收 4 对既有部署原样成立）。**④ DDL：`group_models` 纯加表**（`group_id`/`model_id` 双外键、复合主键，`SCHEMA_VERSION` 仍为 2）—— **全库无 `ON DELETE` 子句，两条级联必须显式**：删组清该组授权行（`deleteGroup` 事务内）、删上游清指向被删档案的授权行（`deleteUpstream` force 路径），漏任意一条 = 对应删除操作 500（实测钉过，见 ADR-0037 判据）。**管理面**：`groupsApi.getAuthorizedModels`/`setAuthorizedModels` + `GroupsPage` 组行「授权模型」抽屉（模型多选、保存后就地更新该行、不整页刷新）+ `authorizedModels` 进 `GroupDto`/`web` 类型。**消费面零端点变更**（`/api/console/models` 的收窄在既有端点内）。**助手零波及**：内部调用不过路由层（`assistant-invoker` 直接打引擎），天然豁免 —— 这正是强制放在路由层而不是引擎层的判据之一。**判据**：授权组打列表内模型 → 200；打列表外 → **403 `MODEL_NOT_AUTHORIZED`**、`attempts=0`、事件 `AUTH_FAILED`/warn；`/v1/models` 与 `/api/console/models` 按组同源；`PUT` 后下一请求即生效（实时）；删组/删上游不 500。全部经变异验证（见 ADR-0037「判据」表）。
> **v1.15.7（2026-10-17，Base URL 必须带 `/v1` + 管理面逐把 key 管理面 —— **零新增端点的口径订正 + `web/` 交付**）**：**动机**是 Bo 的原话「1panel 的管理界面没有发 key 的按钮，都是用户界面用户自己发 key。**Base Url 地址也不正确**」。查下来是**三种不同的病各自长在同一个症状上**，所以这一版一条端点都不加，改的是**口径**与**前端触点**：
> ① **"Base URL 不正确"= 前端少了一段字面量 `/v1`（不是服务端算错了 host）**：§18 的公式 `(publicHost ?? window.location.hostname) + ':' + portGateway` 给出的是**服务根**（如 `http://10.0.0.5:4000`），而网关只认 `/v1/*` —— 实测：`GET /models` → 404、`GET /v1/models` 无 key → 401，**前缀是路由的一部分，不是可有可无的写法**。于是管理面「接入信息」与消费面「接入与 key」两页把服务根当 Base URL 展示，用户抄进客户端得到的第一个响应就是 404 —— **而站点自己给的地址打不通，是最容易让人怀疑整个网关坏了的失败形状**。本版把两处展示改成 `…:4000/v1`，并在公式上加一行：**§18 / §19.5 的拼接结果后面必须带 `/v1` 才是"填进客户端的 Base URL"**；服务根仍然照旧单独展示（它服务静态页与 `/api/*`，是有用的，只是不该被叫 Base URL）。**服务端零字段变更** —— 不新增 `gatewayBaseUrl` 之类字段的理由见 ADR-0036（ADR-0028 决策 2 原样成立：服务端不知道公网 host，拼 URL 必然猜错；本版补的是**同一个前端公式的后缀**，不是第二个事实源）。
> ② **"没有发 key 的按钮"= 有按钮、但粒度不对**：`POST /api/groups/:id/keys`（签发）、`…/:keyId/reset`（重置）、`DELETE …/:keyId`（吊销）三个端点**自 §4 起就在**、且 `api.spec.ts` 早有整套用例，`GroupsPage` 上也一直有「签发新 key」—— 缺的是**逐把的视野与操作**：那一行只显示一个 `gatewayKeyMasked` + 「共 N 把」，于是"这把是哪把、哪把该重置、哪把该吊销"在界面上无答案，`groupsApi.resetKey` / `removeKey` 两个函数**零调用方**（`git grep` 可查）。本版在组行上开一个**「key 管理」抽屉**：列出该组全部 key（`GET /api/groups/:id/keys`，唯一能拿到 `:keyId` 的读面），逐把提供**重置**（Popconfirm 明说"旧 key 立即失效"）与**吊销**（Popconfirm，删行即失效），抽屉里另有「签发新一把」。**重置/签发后当场用 `GatewayKeyRevealModal` 展示明文一次**（§4 铁律不变：明文只在那一帧的响应体里），并在同一格里把**带 `/v1` 的 Base URL** 与掩码并排给出 —— 抄 key 的人下一个问题就是"填哪儿"。
> ③ **一处错到会误导人的文案**：消费面 §19.5 那页写「以 `sk-` 开头的完整串」，而网关 key **以 `gw-` 开头**（`src/db/ids.ts`：刻意不用 `sk-`，"不该长得像上游 key"）—— 照那句话去列表里找 `sk-` 开头的串，找到的是**空集**；本版改为 `gw-`。同一处口径在 §4 补齐（此前契约**从未**写过网关 key 的形状，只在 §12 的脱敏正则里出现过 `gw-…`）。
> **④ 验收时抓到的第 4 个病（P0，先于本版三个版本就在）**：`GroupsPage.onCreated` 把建组响应里的 `gatewayKey` 当字符串用，而它是**嵌套对象** ⇒ 建组后 React 抛 `Objects are not valid as a React child`、**整页进错误边界**。类型检查与四道门禁全绿也拦不住（类型声明与服务端不一致时，编译期只能验"内部自洽"）。本版修类型 + 把两行明文位置**对照写进 §4**（见下「建组响应的 `gatewayKey` 是对象」），并记进 ADR-0036 遗留 7、8。同一次真跑还抓到两处小病：建组路径漏给 Base URL、三处 JSX 里的 `**加粗**` 被原样渲染成星号（已改 `<Text strong>`，全库扫描确认只剩这三处）。
> **吊销后列表就地更新、不整页刷新**（v1.15.4 / ADR-0035 那条纪律的同一形状）：抽屉内的行由本次响应就地改写，与 `UsersPage`「归属组」就地改、`GroupsPage` 删除后 `list.reload()` 同一层意思 —— 让操作者自己按 F5 等于把"删没删掉"变回猜谜。
> **不用假按钮凑数**：抽屉里**没有**"显示明文"（没有任何端点能取回，按钮点了只能失败 —— 比没有按钮更坏，同 §19.3 那句）、**没有**"复制到别处"、**没有**批量重置。
> **影响面**：`/api/*` 响应**零字节变更**（同一个端点、同一批字段，本版一个字段都没动；§4 的 6 个组/key 端点全在，**零新增**）；`/v1/*` **零变更**、`src/gateway/` **零改动**；**DDL 零**（`SCHEMA_VERSION` 仍为 2、零迁移）；`ERROR_CODES`/`GATEWAY_ERROR_CODES`/`hintCode` **零新增**；审计动作零新增（签发 / 重置 / 吊销三个既有动作覆盖）。**判据全部在 `web/`**（该目录无 test runner，ADR-0034 遗留 7 / ADR-0036 遗留同一条 ⇒ 本版**必须手工验收**）：起服务 → 管理面接入页看到 `…:4000/v1` → 组行「key 管理」列出 N 把 → 重置第 1 把（旧 key 打 `/v1/models` → **401**、新 key → **200**）→ 吊销第 2 把（抽屉里那一行当场消失、**不刷新整页**）。理由与反向代价见 **`docs/adr/0036-admin-key-management-ui.md`**。
>
> **v1.15.6（2026-10-17，首库种子「管理组」+ 归属组可改 —— Bo 报的"管理员的账号无法使用路由"）**：**动机**是 Bo 的原话「第一个用户组没有管理组，管理员的账号无法使用路由」。实测把这条链的每一环都试了一遍：`groups` 表可用、`POST /api/groups` 建组即签发第一把 key、`gateway_keys` 的 `key_hash` 鉴权与组级限流全在、管理面 `GroupsPage` 的建组 / 签发 / 重置 / 吊销全在 —— **缺的是连接点**：`admin_users.group_id` 对管理员是 `NULL`，而**没有任何端点能把一个已存在的账号放进组里**（建号时能带 `groupId`，那是唯一一次机会；而 §19.7 明写"换组"的答案是删掉重建 —— 管理员删不掉自己）。于是"功能做了但完全没法用"精确地落在这一处：**不是缺能力，是缺一条从"我的账号"到"我的配额池"的正常路径**，且它对每一个新部署都成立。本版两件事：**① §4 首库种子** —— `bootstrapAdmin` 在"库里一个账号都没有"那一刻建一个名为 `管理组` 的**普通组**（复用仓储层 `createGroup`，因此自动走 C1 签发第一把 key）并把首个管理员放进去，管理员**开箱即有一把能打 `/v1/*` 的 key**；明文 key 只在进程内存存在一次、写进**启动日志一行**（**这与 `bootstrapAdmin` 拒绝把口令打进日志的纪律矛盾，是明知代价的选择**：口令他能记得、能存密码管理器，而网关 key 明文**没有任何其它路径**（§4 铁律），不打日志等于种子白做 —— 缓解与反向代价见 ADR-0035 遗留 1、2）；**② §19.7 新增一条 `PATCH /api/users/:username`**，body **只接受 `groupId`**（`role` / `password` / `displayName` 一律忽略、原样不可改），未知组 → `400 INVALID_PARAM`（**不是 500**，顺手把 `updateUser` 补上 `translateWriteError` —— `createUser` 一直有、它没有），归属改了**同一个会话立刻生效**（`SessionInfo.groupId` 现读，ADR-0034 落下的性质白拿）+ 审计动作 **`user.update`**。**口径订正**：v1.15.0 写的"没有任何'改用户'的端点……换角色 / 换组 / 忘口令一律删掉重建"**把"换组"改口**——删号的代价是连带吊销那个人的全部会话、并把他从 `audit_log` 的 actor 里断成两截，而他只是**进错了配额池**；`role` 那条理由原样成立（不可逆），**这正是"只开 `groupId` 不开 `role`"的判据：两者的失败形状不同**（ADR-0035 决策 2）。**关键判据是种子待在"库空"这个分支里、不进 `migrate()`**：那是"这个库是新的"的唯一判据，而 `migrate()` 是所有测试 harness 的公共前置（`openDatabase` → `migrate()`），既有用例里有按**全局计数**断言的（`console.spec.ts` 那条 `SELECT COUNT(*) FROM gateway_keys` 恒等于 1），种子进去就等于悄悄改了几十条用例的前置条件。**老库升级零动作**（`adminCount > 0` 直接返回）：不替用户做"给管理员补个组"的配额决策，走新加的 PATCH（可见、有审计）。**`/api/*` 其余零变更、`/v1/*` 零变更、`src/gateway/` 零改动、DDL 零（`SCHEMA_VERSION` 仍为 2、零迁移）、`ERROR_CODES`/`GATEWAY_ERROR_CODES`/`hintCode` 零新增**；判据见 ADR-0035「判据」表八条（含**端到端那条**：引导时签发的 key 打 `/v1/models` → 200 —— "管理员能用路由"必须是可执行的事实）+ 三条变异（删掉"放进组"那一步 / PATCH 放行 `role` / 种子挪进 `migrate()`）。**`web/` 交付**：`UsersPage` 的**归属组**可编（那条 PATCH 的出口，其余字段仍不可编）+ `usersApi.update`；零新依赖、无自动化测试（ADR-0034 遗留 7 同一条），必须手工验收。
>
> **v1.15.5（2026-10-17，`role=user` 登不进来的 P0 —— 授面表漏了"登得进来"那一格）**：**动机不是新需求，是 v1.15.0 / v1.15.3 合起来交付的一个真 bug**：v1.15.0 建了第二种身份与服务端授面，v1.15.3 建了 `/console` 工作区与登录分流，v1.15.4 建了管理面建号入口 —— 三版各自都自洽，合起来却是**一个也登不进去的消费面**：管理员用 v1.15.4 的页面建一个普通用户 → 那个人登录 → 被送到 `/console` → `AuthGate` 第一件事打 `GET /api/auth/session` → **403** → 渲染成"无法连接管理面"的全屏错态（403 不是 `UNAUTHORIZED`，不会被派发成跳登录页），于是 §19 那三页、路由分流、`ConsoleLayout` 全部够不着。**这是实测撞出来的，不是读代码读出来的**（Bo 说"起个测试吧，放开局域网访问"，用真实浏览器从局域网 IP 走完整流程才发现）。**成因**：`src/api/app.ts` 的闸门对 `role=user` 只放行 `/api/console/**` 与 `GET /api/access-info`，而**"登录之后要能证明自己是谁"这件事本身没有路径** —— 授面表判的是"能看哪些数据"，漏判的是"能落哪个地"。`/api/auth/session` 与 `/api/auth/logout` 这两个端点**只碰 cookie 里那个会话自己**（前者读 `req.auth`，后者删 `sessions` 里这一行），放行它们不扩大任何暴露面：不读别人的行、不回上游 Base URL、不回账号池、不回 key、不写审计。**放行是"这一个字面路径"，不是"再开一个 `/api/auth/` 前缀"** —— 前缀放行会连 `POST /api/auth/login` 的邻居一起放，而那里迟早会长出别的东西；判据写成 `Set(['/api/auth/session', '/api/auth/logout'])` + 方法门（`session` 只放 `GET`，`logout` 只放 `POST`），`PUT /api/auth/session` 仍 403。**为什么修在闸门而不是让前端别打**：那等于把"登不登得进来"交给浏览器，而 `AuthGate` 的第一跳在任何前端重写里都躲不掉。**§19.1 授面表补两行**（见该表），并把 `role` 授面的**分工**写明：闸门判"能打哪些前缀"，路径自己判"这条路径的授面谁来做"（v1.15.2 的 WS 那一格就是这么补的，同一形状）。**`/v1/*` 零变更、`src/gateway/` 零改动、DDL 零（`SCHEMA_VERSION` 仍为 2、零迁移）、`ERROR_CODES`/`GATEWAY_ERROR_CODES`/`hintCode` 零新增**（放行只是少一条 403 路径，不产生新码）；**新增 5 条授面用例**（`src/api/routes/console.spec.ts`：session 200 且只回自己 / logout 204 后 session 401 / `PUT /api/auth/session` 403 / `GET /api/auth/logout` ∈ [403, 405] / 两个用户各看各的）+ **一条变异**（把 `inConsoleAuthScope` 改成恒 `false` → **3 红 32 过**，证明确实能抓住它；注意变异不能是"删掉调用"，那会让 `noUnusedLocals` 编译失败，红的是编译器不是测试）。**验收口径**：后端四条门禁全绿（typecheck rc=0 / **992 tests** / build rc=0 / secret scan PASS 337 文件 0 命中）。**已知不粉饰的一条**：这个 bug 在 v1.15.0 交付后的**第三版**才被发现，而 ADR-0034 遗留 7 早就写明"`web/` 侧没有任何自动化测试……每次改路由分流都要手工登一次两种身份的账号"—— 那条手工步骤在 v1.15.3 / v1.15.4 都被跳过了（验收口径只写了 `tsc` + `vite build`），**守则写了却没人执行，等于没写**。*
> **v1.15.4（2026-10-17，管理面「用户管理」页交付 + §19.7 契约订正 —— 一张漏了必填字段的表）**：**动机**是 Bo 要"普通用户只能通过用户前端获取 url 和 key"（v1.15.0 起），而那个普通用户**至今没有任何地方能建** —— `POST /api/users` 从 v1.15.0 就在，`web/` 侧一条入口都没有：管理员要发一个账号得手打 `curl`，而**口令明文只存在于那一次的响应里**（§4 铁律），`curl` 出来的口令会留在 shell 历史里。本版把这条缺口补上。**交付物全在 `web/`**（`/api/*` REST 零变更、`/v1/*` 零变更、`src/gateway/` 零改动、DDL 零、`ERROR_CODES`/`GATEWAY_ERROR_CODES`/`hintCode` 零新增 —— **一个后端文件都没动**，因为 §19.7 的端点 v1.15.0 就验收过了）：`/users` 页（列表 + 删除）+ `UserFormModal`（**只有新建**）+ `PasswordRevealModal`（口令一次性展示）+ `usersApi` + `UserDto`/`UserCreateRequest` + 侧栏一项 + 懒加载路由。**为什么这一页只有建 / 删、没有编辑入口**：不是因为没做完，是因为**背后没有端点** —— `updateUser` 在 `src/db/repo/users.ts` 里只动 `groupId` / `displayName` 且**刻意不碰 `role`**，而它**没挂路由**（§19.7 已补记）。所以"换角色 / 换组 / 忘口令"的答案一律是删掉重建；前端做一个点了必失败的表单，比没有表单更坏。**口令一次性展示的纪律照 `GatewayKeyRevealModal` 抄**（同一形状、同一理由）：显式复制按钮（不是文本右侧小图标，手滑点了关闭就没有第二次）+ 明说"现在不抄，之后就拿不到了" + **不给"再次查看"**（重看只能重建号，而那会让旧口令立刻失效 —— 一个点了只会失败的按钮，比没有按钮更坏）+ 关闭即置 `reveal` 回 `null`，明文不残留在任何 state 里。**`role` 默认 `user`**：这个页面存在的理由就是发普通用户；而选 `admin` 时**弹一个 Alert**（"他能改上游凭据、签发 key、删除用户，也能删掉包括你在内的所有账号"）—— 给共同使用者请用普通用户。**归属组下拉失败不阻塞建号**（`groupId` 可选，空 = 未分配，那个人进消费面看到的是"你还没有被分配到组"，**不是报错**）；为它把整页打成错态，是拿一个次要功能挡主要功能。**§19.7 契约订正（本版真正动文档的原因）**：v1.15.0 首次写下这张表时，`POST /api/users` 的 body 写的是 `{username, password, groupId?, displayName?}` —— **漏了 `role`，而它必填**。实测三种输入：少给 `role` → `400 INVALID_PARAM`（`details.field='role'`），给了合法值 → `201`，给了枚举外的值 → 同样 `400`。漏写的形状是**一个照契约手写的请求必 400**：契约说可省、实现说不，这种漂移只在"按文档集成"的人那里炸，而照代码抄的人永远看不见。订正方式是**把 `role` 补进表里并标为必填**，不是把实现的 `required` 摘掉 —— 缺省 `role` 意味着建号方可以不知道自己建出来的是管理员还是普通用户，那是拿授面当默认值。**同一次订正里还补了响应体**：表里写的 `201 {username, role, groupId, createdAt}` 少 `displayName` 与 `updatedAt`，而实现回的是全字段 `UserDto`（`web/src/api/types.ts` 的 `UserDto` 按它写，不是按表写）。**验收口径**：`web/` 侧无自动化测试，判据是 `tsc --noEmit` 全绿 + `vite build` 全绿 + `UsersPage` 独立分包；后端四条门禁全绿（typecheck / 987 tests / build / secret scan）。**已知不粉饰的一条**：本版与 v1.15.3 之间**没有后端改动**，所以 987 这个数没变 —— 这一版的全部风险在前端，而前端**零自动化覆盖**（无 test script、无 runner），唯一的护栏是编译器和构建。建号 / 删号这两个动作**必须手工登录验一次**（建一个普通用户 → 抄走口令 → 登进 `/console` → 删掉），ADR-0034 的遗留 7 说的就是这件事。*
>
> **v1.15.3（2026-10-17，`web/` 消费面工作区交付 —— v1.15.1 的④、v1.15.2 的遗留②至此结清）**：**动机**是 v1.15.1 立下的那条④**写早了**（v1.15.2 已订正），而 v1.15.2 又把它记为"仍未交付"——两版契约都为同一件事留了一条待办，Bo 的需求（"普通用户只能通过用户前端获取 url 和 key，能看自己的用量统计，还有个模型列表"）到今天才真正有界面可落。本版**不改任何接口**：`/api/*` REST 零变更、`/v1/*` 零变更、`src/gateway/` 零改动、DDL 零（`SCHEMA_VERSION` 仍为 2、零迁移）、`ERROR_CODES`/`GATEWAY_ERROR_CODES`/`hintCode` 零新增 —— 因为 §19 的授面在 v1.15.0 / v1.15.1 / v1.15.2 三版里已经做完并变异验证过了，这一版只是让**界面**追上**边界**。交付物全在 `web/`：`/console` 三页（§19.5 接入与 key / §19.4 我的用量 / §19.6 模型广场）+ `consoleNav` + `ConsoleLayout` + `SessionInfo.role` + `consoleApi`（4 个端点：`/console/session` / `/console/keys` / `/console/usage` / `/console/models`）+ 登录与根路径按 `role` 分流。**为什么 `ConsoleLayout` 是一个独立外壳而不是 `<AppLayout role="user" />`**：两者的差异不是"少几个菜单项"，而是三件结构性的事 —— ① 不订阅 `WS /api/stats/live`（`role=user` 开它只会撞 4401，被 `live.ts` 派发成"会话失效"弹回登录页，而他的会话好得很；**正解是别开，不是开了再处理**）；② 不挂 `useSupplierNav`（那个 hook 打 `upstreamsApi.list()`，对 `role=user` 是 403，会把侧边栏变成一条常驻错误）；③ 顶栏不显示管理面专有项。塞进同一个组件就是满屏条件分支。**为什么 `consoleNav` 不是 `navItems` 加个 filter**：管理面那 9 项一条都不属于普通用户（仪表盘是全站聚合、上游管理是 Base URL 与凭据、Key 管理能看到**所有** key、用户组是配额设置）；做成 filter 会在两处留下同一个判断（哪几项对 user 可见），一旦漂移，侧边栏就会出现"点了就 403"的入口 —— 比没有入口更坏。**三页各自的纪律**：接入页的 URL 三个字段**只从 §18 一个来源取**（`accessInfoApi.get()`，不新开 `/api/console/access-info`），key **只显掩码**（明文只存在于管理员签发那一次的 201 响应体，服务端没有"再取回"的路径，所以这一页**不给"复制明文"按钮** —— 按钮点了也只能失败，那是比没有按钮更坏的信号）；用量页 `groupBy` 只给 key / upstream / model（**不给 group**：组级是别人的数据），指标表**排除 `costCents`**（组配额是共享的，显示成个人账单会被误读）；模型广场**不做任何本地过滤**（不按"看起来可用"筛、不把停用的藏起来 —— `enabled: false` 照实显示成置灰标签，因为用户照列表去调用拿到 404 比看到"已停用"更坏）。〔**v1.15.8 订正**：上面这一句的**前半**（不做本地过滤）原样成立且更强；**后半**（`enabled: false` 照实显示成置灰标签）描述的是一个**协议上不存在**的状态 —— §19.6 的 SQL 判据恒 `enabled = 1`，响应体里**没有 `enabled` 字段**（见 §19.6）。`web` 侧当时正是照这句话建了 `enabled` 分支，真实后果是**每个模型都被标成「已停用」**（字段恒 `undefined`），并被 v1.15.8 的验收抓出。删掉的是那个分支，不是这条纪律 —— "不制造会骗人的信号"这一层不变，只是当时写下的那半句自己就是那个信号。〕**验收口径**：`web/` 侧**没有自动化测试**（无 test script、无 runner，这是事实不是遗漏），所以判据是 `tsc --noEmit` 全绿 + `vite build` 全绿 + 三个 console chunk 各自独立分包（`role=admin` 的会话不会下载它们）；后端四条门禁（typecheck / 987 tests / build / secret scan）全绿，其中 `console.spec.ts` 30 条覆盖 §19 全部七条授面判据。**已知不粉饰的一条**：`consoleNav` 这个文件必须叫 `.tsx` 而不是 `.ts` —— 它导出的是**含 JSX 的元素**（`icon: <ApiOutlined />`），写成 `.ts` 时 `tsc` 报 6 个 `TS1005`（第 29 / 35 / 41 行各一对"`>` expected / `,` expected"），这是**命名**问题不是逻辑问题，`mv` 一下即过；列在这里是因为"为什么这个 nav 是 tsx"看起来不像需要解释的事，而下一个照抄 `.ts` 的人会再撞一次。
>
> **v1.15.2（2026-10-17，实时通道授面补齐 —— 一个**因为闸门有例外而打开的洞**）**：动机不是新需求，是补 v1.15.0 / v1.15.1 **自己留下的**一格：**§7 的 `WS /api/stats/live` 是 `app.ts` 鉴权闸门的唯一例外**（升级请求回不了 HTTP 401，否则浏览器只报 1006，前端分不清"会话过期"与"服务不可用"）。那个例外的代价是**闸门的 `role` 判定也一起被跳过** —— 实测 `role=user` 拿自己的会话即可握手成功并持续收到 `metrics` 帧，其中 `qps` / `successRate` / `balanceGlobal`（**全站**余额）/ `egress_pool` 全是 §19.1 明写"不给普通用户"的东西（同一个身份打 REST 的 `/api/stats/overview` 会 403）。**同一份数据两条通道、两种授面结果**，而 WS 那条是漏的。本版把它补齐：`live.ts` 的握手期会话判定（`handshakeSession`）从"只验会话活不活"改为**同时判 `role`**（`role=user` → 回绝），拒绝码取 `4401`（前端 `live.ts` 已有"跳登录页"分支，而这里要说的真话是"你的身份不该开这条通道"；WS 侧可表达的语义只有这一个码，`1008` 会走默认退避重连分支、把用户送进一个永远连不上的循环）。**为什么修在握手而不是把闸门例外缩小**：例外本身是对的（1006 vs 4401 的分辨只能这么来），要缩小的是**例外的授面代价**；而授面判据放在通道自己的握手里，等于"每条路径自己负责自己的授面"，与 §0.5"闸门判一次"的分工并不冲突 —— 闸门判不了的路径（本版就一条）由路径自己判，且判据同一份（`role`）。**`/api/*` REST 零变更、`/v1/*` 零变更、`src/gateway/` 零改动、DDL 零（`SCHEMA_VERSION` 仍为 2、零迁移）、`ERROR_CODES`/`GATEWAY_ERROR_CODES`/`hintCode` 零新增**（4401 是 §7 既有 WS 关闭码，不是新错误码）；**新增一条授面用例**（`src/api/routes/live.spec.ts`：`role=user` 走完握手 → 4401 且**一帧都不收**，同一 harness 上 admin 仍收到 `metrics` 作屏障）+ **一条变异**（删掉 `handshakeSession` 里的 `role` 判定 → 红，失败信息直接指名 `ready` 漏出去了）。**遗留两条不粉饰**：① 前端 `AppLayout` 的 `startLive()` 目前对**整个**登录区生效，`role=user` 进 `/console` 也会开这条通道并被 4401 弹回登录页 —— 这是**实现侧的 UX 缺陷**，契约不管前端怎么接线，但记在这里以免它被当成"后端又坏了"；〔**v1.15.3 订正：①已不成立** —— `role=user` 现在落在 `ConsoleLayout`（`web/src/layouts/ConsoleLayout.tsx`），那一个外壳**刻意不调 `startLive()`**：正解是别开这条连接，不是开了再处理它的错误。改动是路由层分流（`router.tsx` 的 `Workspace`）+ 一个独立的消费面外壳，**没有**去动 `live.ts` 的退避逻辑，也没有给 `role=user` 开后门。〕② **`web/` 消费面工作区仍未交付**（v1.15.1 的④写早了，见该条订正），即 §19 到目前为止是**只有后端**的一节 —— 普通用户今天仍登不进任何地方（`admin_users` 里没有 `role=user` 的账号时无所谓，一旦管理员建了一个，他登录后会被送到 `/dashboard` 然后逐个 403）。〔**v1.15.3 订正：②也已不成立**，`web/` 侧已交付：`/console` 三页（接入与 key / 我的用量 / 模型广场，`web/src/pages/console/`）+ `consoleNav` + `ConsoleLayout` + `SessionInfo.role` + `consoleApi` + 登录按 role 分流（`LoginPage` 用登录响应里的 `role` 选 `/console` 或 `/dashboard`）+ 根路径与管理面越权的兜底（`HomeRoute` / `NotFoundRoute`）。**但 v1.15.2 这一版的立论仍要保留**：WS 那条洞是真的，4401 是真的，测试与变异是真的，全部与前端何时交付无关。前端落地后 `ConsoleLayout` 不开这条通道，只是让"连不上"变成"不连"，**不改变**服务端必须拒这条握手的事实 —— 换一个客户端（脚本、第三方面板）照样能试。**前端这一侧没有自动化测试**（`web/` 无 test script、无 runner），验收口径是 `tsc --noEmit` + `vite build` 全绿 + 三个 console chunk 各自独立分包（`role=admin` 的会话不会下载它们）。〕
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

> **v1.6.3（2026-10-07，账号面 Tier B 落地 —— §15.2 六个「要打上游管理接口」的端点接线）**：**本条为补记**（`98d506a` 落地时改了版本号与文末索引，**变更块漏写** —— 与 v1.4.3 同一类漏，补记不改任何内容）：① `import` / `refresh` / `:id/login` / `:id/test` / `keys` / `keys/sync` 六个端点接线，四个批量端点回 `202 {taskId}`、结果在任务终态 `result`，`:id/login` 与 `:id/test` 同步回 `200`，**零契约改动**；② §15.3 `skipped` 口径成文（= 没做过的行：`LINE_PARSE_FAILED` + `EXCLUDED_IDENTIFIER`；`failed` = 做过但不成的行 ⇒ `ok + failed + skipped = total` 恒成立）；③ §15.7 补登 `supplier.account.login` / `supplier.account.test` 两个审计动作（`detail` 只放计数 / 标志）；④ 同批修一处实现缺陷（`replaceSupplierAccountKeyLedger()` 的 `db.transaction(fn)` 漏调用 ⇒ `keys/sync` 静默空转却报 `rows: N`）。**无字段改名 / 删除、无端点增删、`ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2。**

> **v1.6.4（2026-10-07，出口池卡片的读面登记 —— 画师 S3 前置件的答复）**：① **裁定：不开新 REST 端点、也不并入 `overview`** —— v1.4.9 已冻结「出口状态不走 REST、§7 是唯一读面」，§16.7 同款写着「`egress_id` 不进任何 DTO」；画师给的是二选一（新端点 / 并进 `overview`），**两支都不走**，落在 **§7 新增池级差分帧 `egress_pool`**。② **为什么必须是"池级"帧、不能沿用 `egress:${egressId}` 那种每出口一条**：§7 差分通道**没有墓碑**（v1.5.0 已写死）⇒ 每出口一帧时，**0 个出口 = 零帧**，与「**根本没接线**」在通道上**同形** —— 画师那条边界（0 出口 ≠ 全离线）**在契约层就无法表达**。池级帧取 `id: "egress:pool"`、**无条件注册**进 `tickNow` 的 `live` 集合，`nodes: []` 才是"已接线、当前 0 个出口"。③ **字段表见 §7**（`egressId` / `name` / `status` / `exitIp` / `expectedExitIp` / `lastHeartbeatAt` / `cooldownUntil`），四个终局名画师卡片直接消费，不用反推实现。④ **本期不发射、前端不得接线**（与 §7 既有三条硬约束同款），并且**多一条前置**：`status` / `lastHeartbeatAt` / `exitIp` 三条的**生产者不存在** —— `deploy/vps-egress/pool-probe.sh` 按设计是**无状态**的（不摘除、不回池），**心跳没有接收端**；按 v1.5.0 刚写死的「**禁止先加字段、后补生产者**」，这三条字段必须与**心跳上报链**同一批落地，否则就是同一条纸面字段的第二次犯。⑤ **本轮零代码、零前端改动**（画师明确不插队、挂 S3、不动 `web/` 一行）；契约改动只有本文首本节 + §7 + §8 + §16.7 四处。**无端点增删**（新增的是**帧**，不是端点）、**无既有字段改名/删除**、**`ERROR_CODES` 零新增**、**`GATEWAY_ERROR_CODES` 零新增**、**`/v1/*` 零变更**、**`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码。**
>
> **版本号订正（2026-10-07，v1.6.5 批，只改号不改内容）**：本块最初落笔时误标 **v1.6.2** —— 与 `5af638d`（**10:44**，「§16.7 出口级 429 实测形状登记」）**同号撞车**：同一个号在**变更块**里指本条（池级差分帧），在**文末版本索引**里指那一条（429 形状），**索引与变更块互相矛盾**；且本块**从未进索引**（它落地于 **13:46**，晚于 v1.6.3 的 **11:39**）。本批按落地时间重编号为 **v1.6.4** 并补进索引，§7 三处引用（`:958` / `:1047` / `:2506`）同批改名。

> **v1.6.5（2026-10-07，§16.1 数据面实测登记 —— 路由者「两问已答」的落位）**：**本条不新增字段、不新增端点、不改任何实现**，做的是**把已经在 `origin` 上的一次带 key 实测登记进契约**，并顺手修两处台账缺陷（v1.6.3 变更块漏写、v1.6.4 同号撞车，均见上两段）：
> ① **新增 §16.1.2「实测登记：数据面两问的带 key 记录（锚 `5bb58a1`）」** —— 把 `scripts/probe-tierflow-datapath.ts:37–51` 的结论逐条落到 §16.1 判据表：**「存在 OpenAI 兼容 relay」成立、「只有自有协议」排除**（`GET /v1/models` → 200 + `{data:[…]}` 7 个模型）；**`classifyUpstreamStatus` 纯状态码驱动成立**（错误一律非 2xx + OpenAI 信封，`looksLikeFailureBody` 从未命中）；P4 零余额 key → 401 `Invalid token` ⇒ **`AUTH_INVALID` 当前处置正确、`classify` 零改动**；P3 错误体在首包之前到 ⇒ pre-first-chunk 改判**技术可行**（**是否改判归 §16.2 / 路由者，本节不做该决定**）。
> ② **证据强度分两级写死**（这是本条最容易被读错的一格）：**形状轴**（路径存在性 / 401-403 分岔 / 错误信封）无凭据即可复跑，§16.1.1.a 两轮 + 本轮分片复跑各一次，**是复现过的**；**成功体轴**（200 + 7 模型 / TTFB / SSE 帧形状）是**单点记录**（探针按设计只打 stdout、不落盘 ⇒ **无第二份原始产物**可交叉核），故状态写 **「记录在案、可复核」**，**不写「已复现」**；抬成复现只差**持有人本地再跑一次**（§16.6 执行链，key 不经任何人手）。
> ③ **时间戳错位一并记下**：契约 §16.7 的 v1.6.2 登记落在 **10:44**，该记录落在 **11:16** —— **契约早了 32 分钟**，此后**没有任何一笔更新过 §16.1.1.a / §16.5**，于是「未实测 / P0 的另一半仍未做」被当成现状传了若干轮。**"台账里没有"不等于"没发生"** —— 这条对**契约作者**同样成立。
> ④ **§16.5 行 2 状态更新**（⏳ 未实测 → ✅ 记录已到）、**§16.6 第 1/2 项钉死条件判为已满足**（**实测值与占位值逐字相同 ⇒ 钉死 = 不改实现**：`baseUrl` 仍 `https://tierflow.cn`、仍走 OpenAI 兼容默认路径、`classify` 不做 200+`success:false` 改判、**仍不进 DTO**）、**§16.1.1.a 加一行指针**（免得两处对同一件事各说一套 —— 本契约反复踩过的坑）。
> ⑤ **纪律照旧、一条不减**：本条**不据此改 `classify`、不据此动 §16.2、不据此新增/变更任何 DTO 或字段**；`/v1/*` **零变更**、`ERROR_CODES` / `GATEWAY_ERROR_CODES` **零新增**、`SCHEMA_VERSION` 仍为 2。**无字段改名、无字段删除、无端点增删 —— 纯文档，零代码。** 见 `docs/adr/0018-supplier-account-batch.md` 决策 11「补记 v1.6.5」。

> **v1.7.0（2026-10-08，出口预算接缝 + 余额同步补遗 —— 枚举新增，非破坏）**：本条是 **ADR-0021（出口预算接缝 v10）** 与 **ADR-0017 补遗 v1.7.0（补遗 1–6）** 的**契约侧落点**，两批并笔。**净变化：`GATEWAY_ERROR_CODES` +1、`ERROR_CODES` +1、`hintCode` +1**，其余全是口径订正与登记。
>
> ① **出口面两枚新码（ADR-0021 决策 9）**：`NO_AVAILABLE_EGRESS`（503 / `server_error` / **不带 `Retry-After`**，`GATEWAY_ERROR_CODES` **10 → 11**）与 `EGRESS_HAS_ACCOUNTS`（409 / `details: {accountCount}` / **不提供 `force`**，`ERROR_CODES` **16 → 17**），落 §10 与 §0.4。§10 的 `RATE_LIMITED` 一行触发条件扩到出口面：**出口预算耗尽 / 绑定的出口全部冷却**（同样是 0 次真实尝试、不计任何 key 健康、不写出口冷却、一律带 `Retry-After`）。§10 补注写死两条边界：`Retry-After` 的适用范围**只到出口面那两枚码**、**不得泛化到整表**（`NO_AVAILABLE_KEY` 是 v1.2.1 / §13.4 已冻的**可重试 503**）；且 `503 NO_AVAILABLE_EGRESS` 是**唯一**"只能改配置"的 503。
> ② **§16.7 出口生命周期裁定 + 列清单换轴**：`egress_proxies` 的 `enabled` 回归列换成**单轴 `status`**（`active`|`retired`）+ `retired_reason`（`replaced`|`manual`，**退役必填**）+ `retired_at`；`url` **归一化后 UNIQUE**；新增「v1.7.0 裁定：出口的生命周期 —— 状态单轴、`url` 唯一、池空是显式终态」六条（单轴 / **`retired` 不删行** / `url` 唯一 + **回池只有复用自己的 `egressId`** / **自动摘除不落库** / **池空不回落宿主直连**且"永远选不出"与"现在用不了"**分属两枚码** / 退役被引用则 **409 且无 `force`**，账号侧对称 `400 INVALID_PARAM`）。
> ★ **同批落 `src/db/schema.ts` 的 DDL 逐字替换**（ADR-0021 放行笔 #1）：表**未发布 ⇒ 零迁移**、`SCHEMA_VERSION` 仍为 2、**纯加表 + 加列**。故**本条不是纯文档**，带这一处代码改动。
> ③ **`hintCode` 四值 → 五值**（§2 / §14.2）：新增 `BALANCE_EGRESS_RATE_LIMITED`，**判据 = HTTP 状态码 `429` 本身、不看标记头**（上游真 429 与本地合成的 429 **归同一行**）；并把 `BALANCE_UPSTREAM_UNREACHABLE` 的触发列改成"不可达 / 超时 / 非 2xx（**429 除外**）" —— **只加行不改列 = 两行互相包含**，前端取到哪行会退化成行序这种实现细节。文案纪律**不得越证据**（"可能是出口预算、也可能该 key 自身撞到限额"）；**码名保留 `BALANCE_EGRESS_RATE_LIMITED`**（Bo 2026-10-07 裁定，ADR 曾建议改短名），故前端 `HINT_CONFIG` 第 5 项的 `title` **同样**必须按这条纪律写。§14.2 的**写库纪律表不动**（429 同属"一个字都不写"）。
> ④ **§14.1 退避归零改三条判据**：①有值 ②成功比例达标（**分母排除 `skipped`**；阈值占位 80% **是实现常量、不进契约**）③**本轮无 429**；推进条件同批改写（旧口径"`failed > 0 且 ok == 0`"在**共用出口预算**下是**结构性缺陷**：26 把里 6 把成功也能读作健康 ⇒ 每 15 分钟准时再烧一次窗口、**永不退让**）。§14.3 的 `consecutiveFailures` / `nextAttemptAt` **语义改述**为"最近一轮**整体健康度**"。
> ⑤ **§14.3 / §14.4：`knownKeyCount` 语义成文 + 漂移加前置条件**：`knownKeyCount` = **"余额当前有值的 key 数"**（**含本轮没读到、沿用旧值的 key**），**不是**"本轮查到的 key 数"；漂移**前置条件** = **本轮有出口级限流（`rateLimited > 0`）时两个码都不判定**。**明确不收窄 `usedTokens`**（收窄会让 `BALANCE_SPENT_WITHOUT_TRAFFIC` 对"这条上游真的有人在用"**失明**，且引入第二个口径）。**零 DDL、零新列**。
> ⑥ **§14.1 写死间隔的"唯一来源 / 唯一读面"**：来源 = 服务端环境变量 `BALANCE_SYNC_MINUTES`；读面 = §14.3 的 `auto.intervalMinutes`（**只读回显**）；**本版没有任何"改间隔"的写入口**，`min_interval_minutes` 这类名字**从未存在**。
> ⑦ **新增两小节**：**§14.7 手动刷新"二次确认"交互契约**（一次点击 = **一批**上游请求、与数据面**共用**出口预算；**必须有明确结论、不得转圈**；被拒是**任务结论**不是 key 归因；退避只约束**自动**同步、手动**照常可发**）与 **§15.13「S3 消费锚」**（三处字段级事实的唯一判据与正文锚点：`upstream.supplier === "tierflow"` / `result.items` 上限 500 / `SupplierAccount` DTO）。
>
> **本版未落（留在后续批次，别当已做）**：ADR-0017 落地清单 **#1**（§14.1 第 3 条 + §14.5 的「TTFB 判据自动满足」后半句作废）、**#5**（§16.7 Tier 1.5 九条正文）、**#6**（§15.5「27 账号一轮 ≈1 分钟」按新口径重算 ≈14 min）、**#7**（§7 `egress_cooldown`「本期不发射」翻篇 —— **有前置**：ADR-0021 v8 定的翻篇起点是"**判据真正启用**"，不是契约落地）；清单 **#9–#16 全是代码 / 前端**，含两处**码表长度断言**（`src/api/balance-sync.spec.ts` 的 `ERROR_CODES` / `GATEWAY_ERROR_CODES` 长度）与常量本体（`src/api/errors.ts`、`src/gateway/errors.ts`）—— **本版契约先走，代码同笔跟进**。**清欠（v1.8.0）：#1 / #5 / #6 已落正文、#7 前置经确认不改状态（本块整体保留为历史）；#9–#16 代码同笔跟进。**
>
> **纪律照旧**：无既有字段改名 / 无字段删除 / 无类型变更 / **无端点增删**（新增的是**码值**和**帧**，不是端点）；`/v1/*` **零变更**；`SCHEMA_VERSION` 仍为 2、**零迁移**（`egress_proxies` 的列变化**不算迁移**：表未发布、零数据）。

> **v1.8.0（2026-10-09，ADR-0017 落地清单挂账清欠 —— #1 / #5 / #6 落正文、#7 前置确认，纯文档零代码）**：v1.7.0「本版未落」登记的三条契约侧挂账一次性清掉；**本版不新增任何码值、端点、字段、帧**。
>
> ① **清单 #1 —— §14 前言第 3 条「TTFB 判据不受影响」与 §14.5「TTFB 判据自动满足」的**后半句作废**（ADR-0017 补遗 1 订正文案逐字落）**：耦合不在 HTTP 耗时这一层，而在**出口 IP 请求预算**（比 HTTP 低一层）：自动同步与数据面**共用同一出口的请求预算**，同步能把它挤到 429 而 TTFB 看不见。订正后口径：**`src/gateway/` 零改动；`/v1/*` 请求路径零新增同步读写 —— 但这不等于「与数据面无耦合」；TTFB 判据不再自动满足，须与出口预算共同验收（ADR-0021 §验证）。**
>
> ② **清单 #5 —— §16.7 新增「Tier 1.5 九条」正文**（按 ADR-0017 补遗 5 终版九条全收，**判据取 v6 订正版**：冷却写入口径 = **同出口 60s 滑动窗口内 ≥3 个不同账号**同型 429，不再是「第 2 把不同 key」）：① 作用域点名扩到管理面全部打上游的消费者（§14 三刷新端点含自动同步 / §15.2 六端点 / 余额自测 / 探活）；② 计价单位 = **一次上游 HTTP 请求 = 一枚 token**（不是一把 key；刷新一个账号 = 2 枚）；③ `RATE_LIMITED` 触发条件加**第四条路径「出口预算耗尽」**（0 次真实尝试 / 不计 key 健康 / 不写出口冷却 / 一律带 `Retry-After`）；④ **管理面消费者不得占用数据面保留额度**（`reserveForData: 1` 与 `capacity: 5` 同条登记，占位）；⑤ 桶钥匙 = `egressId`，与 Tier 1 冷却键同源，**`egressHostOf` 随迁退休**、归一化唯一入口 = `egressIdOfUrl`（解析失败 → `null` → 放行）；⑥⑦ 冷却两条来源**分列**：**上游确认**（60s 窗口 ≥3 账号判据）写冷却阶梯，**桶拒绝**走「终止本轮轮换 + `Retry-After`」、不推进阶梯 / 不写冷却 / **不发射 §7 帧**；⑧ 终态形状四断言（`429 RATE_LIMITED` + `Retry-After` **不是** `502` / `attempts` 恒 0 / 不写 key 失败行 / `inner` 零调用 + `consecutive`·`until` 逐字节不变）；⑨ 检测器转正 = `egressLimitedOnSecondKey` 默认值替换 + 判据入参改**窗口化 `distinctAccounts`**（`scope` 参数作废）；两个识别器退休、判据唯一化到闸内。
>
> ③ **清单 #6 —— §15.5 重算「27 个账号一轮刷新 ≈ 1 分钟」**：按新口径 `ceil(总请求数 / 有效容量) × 窗口`、**有效容量扣掉数据面保留额**（占位下 5−1=4）：`ceil(52/4)×60s` = 13 min（26 key 记账）/ `ceil(54/4)×60s` = **14 min**（27 账号记账，本节取这条）；**0.6s 账号间隔保留为账号级内层纪律，出口级速率由 Tier 1.5 取代**。**这些数全部是「单出口」口径，出口 > 1 时逐出口各自成立、不得跨出口加总。** 并脚注登记 **ADR-0017 补遗 6 的量化重开门槛**：15 分钟内管理面可用 token ≥ 一轮全部请求数（占位 54 枚）**且数据面满载时仍满足** —— 占位值下 60 枚/15min ≥ 54 枚但余量仅 6 枚（10%）、两种记账都不够一整轮重试 ⇒ **占位值下不重开**；容量回填后**只改数、不改代码**，重算输入 = `capacity` / `reserveForData` / 账号数三者一起。
>
> ④ **清单 #7 前置确认，不改「本期状态」**：`egress_cooldown` 帧翻篇的起点是「**判据真正启用**」而非契约落地 —— 识别器转正落地在**代码同笔**（见下）；ADR-0021 v8 的前置纪律不放松。**§7「本期状态（v1.4.9）」与 §16.7 v1.4.8 裁定 ① 本版零改动。**
>
> ⑤ **S4 实测登记（补记）**：带 key 流式往返已发生（实测锚 = PM S4 探针 run，2026-10-09）—— HTTP 200 `text/event-stream`、**TTFB ≈ 436ms（首 chunk）**、17 个 `data:` 帧 + `[DONE]`、15 个 `delta.content`；非流式 HTTP 200、811ms、`finish_reason=stop`、usage 正常回显。**行为发现一条：请求发的是别名 `tierflow_pro`、响应 `model` 字段实测回 `qwen3.8-flash` —— 上游会把别名改写成底层真实模型名回发**，网关透传 / 展示面必须吃下这个差异（本登记**不据此改 DTO、不据此改 `classify`**；`model` 字段语义 = **回显上游响应原值**）。§16.6 三项占位值钉死条件（P0 报告）在 v1.6.5 已判「满足、且实测值与占位值逐字相同 ⇒ 钉死 = 不改实现」，**本次实测与既有判定同向，不产生任何代码义务**。探针 key 用后即删、0 遗留，排除号全程未参与。
>
> ⑥ **代码同笔跟进（已并行开工，不属本笔）**：ADR-0017 落地清单 **#9–#16**（`judgeRound` / `judgeDrift` 判据、`rateLimited` 旁路计数、第 5 个 hint 分支、`retryAfterSeconds` 提示面、两处**码表长度断言**与常量本体、Tier 1.5 闸内判据、web `HINT_CONFIG` 第 5 项 + 兜底）。**§16.2 pre-first-chunk 改判复核结论：不改判 —— §16.1.2 已实测「错误一律非 2xx」成立，200+`success:false` 改判不需要做，本版对该节零改动（基线核对时顺带复核，非本笔新账）。**§16.5 / §16.6 / §15.6 三处复核无欠账（#3 白名单 4 处 + 1 spec、#16 `retryAfterSeconds` 均属 #9–#16 代码同笔）；§15.6「27 账号 ≈1 分钟」无此表述、无需修改（#6 的全部口径落 §15.5 正文，见 ③）。
>
> **版本索引订正（不升版）**：v1.3.0 已补 v1.2.2 / v1.3.0 两条、v1.6.5 已补 v1.6.4 —— **PM 台账里的「P3 #3 文末索引漏 v1.2.2 / ADR-0016」在当前基线上核对为已修，本笔无可落之文，登记关闭。**
>
> **纪律照旧**：无字段改名 / 无字段删除 / 无类型变更 / 无端点增删 / 无码值增删 / 无帧新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零迁移 —— **纯文档，零代码。**

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
| `EGRESS_HAS_ACCOUNTS` | 409 | **v1.7.0 新增**。退役（`retired`）一个仍被账号引用的出口（`supplier_accounts.egress_id`），`details: {accountCount}`。**这条不提供 `force`**（ADR-0021 决策 9(6)） | **不弹 `force` 二次确认**：引导用户先把这些账号**改绑**到另一个 `active` 出口（改绑是显式动作，见 §16.7）；文案要说清"该出口仍被 N 个账号占用" |
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
- **两种身份（v1.15.0，§19 / ADR-0034）**：会话对应的 `admin_users.role` 为 `admin` 或 `user`。
  `admin` 打全部 `/api/*`；`user` **只能进 `/api/console/**`（只读）**，落在既有 `/api/**` 上一律 **403 `FORBIDDEN`**。
  **`/api/console/**` 不是白名单例外** —— 它仍然全量鉴权（未登录 401），只是多一种身份能读。
  判据在闸门里按前缀判一次（同 `inReadonlyScope()` 的纪律：新增路由不可能"忘了判作用域"）。
  **`role` 每次鉴权从 `admin_users` 现读**，不存 `sessions`（存了就有"改了角色、旧会话还是老角色"的窗口）。
  **`/v1/*` 与后台身份无关**（走网关 key，§10）—— 消费面改的是"谁能登进后台看数据"，不是"谁能调网关"。

### 0.6 数据保留策略（v1.14.1）

一张表只进不出，撞上的不是"磁盘满"，而是**一次拷不动的备份 / 跑不完的迁移**——那时候没人说得清是哪张表吃掉的。所以每张会累积的表都必须有一个**真在运行**的清理路径。

| 表 | 清理函数 | 保留期 | 配置 | 节拍 |
|---|---|---|---|---|
| `usage_logs` | `pruneLogs` | 30 天 | `LOG_RETENTION_DAYS` | 6h（`src/server.ts`） |
| `gateway_error_events` | `pruneGatewayErrorEvents` | **30 天（同 `usage_logs`，§12.1 明文）** | `LOG_RETENTION_DAYS` | 6h（同 `usage_logs` 那一个定时器） |
| `audit_log` | `pruneAudit` | **180 天** | `AUDIT_RETENTION_DAYS` | 6h（同上） |
| `tasks` | `pruneTasks` | 7 天，**只删终态** | `TASK_RETENTION_DAYS` | 6h（同上） |
| `change_log` | `pruneChanges` | **10000 行**（行数，不是天数） | `CHANGE_LOG_KEEP_ROWS` | 6h（同上） |
| `gateway_health_snapshots` | `pruneHealthSnapshots` | 90 天 | `HEALTH_SNAPSHOT_RETENTION_DAYS` | **自己的 1h**（`src/api/health-snapshot-writer.ts`） |
| `balance_snapshots` | `pruneBalanceSnapshots` | 90 天 | `BALANCE_SNAPSHOT_RETENTION_DAYS` | **自己的定时器**（`src/api/balance-sync.ts`） |
| `sessions` | `purgeExpiredSessions` | 会话过期即删 | —（无配置） | 1h |

三条纪律：

1. **审计的保留期独立于用量日志**。`usage_logs` 回答"跑过多少流量"，`audit_log` 回答"**谁在什么时候改过什么**"——安全事件的追溯期本就长于用量明细的有用期。拿 30 天裁审计，等于让"三个月前谁改过配置"比"三天前跑过多少请求"更早消失。`pruneAudit` **只按时间窗删**，不认 id / actor / action（逐行删审计的能力是"谁能抹掉自己的痕迹"的入口）。
2. **`change_log` 按行数不按天数**。它是广播信道不是历史，判据是"消费者的 `seq` 追到哪了"。安全性论证（消费者 `lastSeq` 每拍推进、1s 节拍、一个节拍上界几十条）与两个前提见 `src/db/repo/change-log.ts` 头注 —— 所以 `keep` **必须是配置**，不是写死在代码里的"够大了"。
3. **快照表留在各自的写入方**，不并进 `src/server.ts` 的全局定时器：它们的写入方已有自己的节拍，再挂一个全局清理器就成了"同一个表两个节拍"，两边保留期一旦配得不一样，**谁先跑谁后跑决定库的大小**。

所有 prune 一律 `< cutoff`（不是 `<=`）：取整到毫秒边界的行应该被**留下**，它是"刚刚还在窗口内"的那一条。清理失败**不带走进程**（逐条 try/catch），下一轮还会再来。

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

### `POST /api/auth/password`（v1.15.9 / ADR-0038 决策 3）
```json
{ "currentPassword": "...", "newPassword": "..." }
```
→ `204`（无响应体）

改的是**会话本人**那一行。**没有 `:username` 路径参数** —— 本契约里**不存在**"改别人的口令"
这个能力（少一个参数就是少一类越权面），两种身份走同一条路径。

| 失败 | 码 | `details` | 副作用 |
|---|---|---|---|
| 未登录 | `401 UNAUTHORIZED` | — | — |
| 当前口令不对 | `401 INVALID_CREDENTIALS` | — | 审计 `auth.password` / `fail` / `invalid_current_password`；占限速额度 |
| 新口令与当前相同 | `400 INVALID_PARAM` | `field: 'newPassword'` | 审计 `auth.password` / `fail` / `same_as_current`；占限速额度 |
| 限速（每 IP 5 次/分钟） | `429 TOO_MANY_ATTEMPTS` | `limitPerMinute: 5` | 审计 `auth.password` / `fail` / `rate_limited` |
| 口令太短（< 8） | `400 INVALID_PARAM` | `field: 'newPassword'` | 无（schema 层拒，请求没进来） |

- **旧口令必填且必须验**：少这一格的话，**一条被偷走的会话就能直接改掉口令、把真正的主人锁在门外**。
  校验走 `verifyPassword`（与登录同一个函数，不复刻算法）。
- **限速与登录共用同一个闸**（就是上面 5 次/分钟那一个）。不共用的话这条端点就是一条**不受限速的
  口令猜测通道**，而它猜中的收益比登录页更高 —— 登录进去还得找到别的东西，改密猜中了直接接管
  这个账号。前端因此照 `LoginPage` 的做法起 60 秒倒计时，而不是让人反复点一个必然失败的按钮。
- **新口令与旧口令相同必须拒**：不拦的话"改密成功"可能什么都没变（散列重算一遍、其他会话被踢，
  而口令还是那一串），用户以为自己换了。
- **成功之后：当前会话留着、该账号的其他会话全踢**，同一个事务：
  `UPDATE admin_users SET password_hash = ?` + `DELETE FROM sessions WHERE username = ? AND token_hash != ?`
  （本会话的 `token_hash`；取不到时**退化成全踢** —— 宁可让本人重登一次，
  也不要留下一条可能被别人持有的会话）。
  - **前端因此绝不能在成功后跳登录页**：跳了用户会以为改失败了（或以为自己把自己踢了）。
  - 用 `username` 而不是"登录时间"来判会话：同一账号在不同机器上的会话之间**没有任何可比较的先后**
    （`last_seen_at` 是最后一次请求，不是创建时刻）。
- **`PASSWORD_MIN_LENGTH = 8`**，与 §19.7 建号**同一把尺子**（判据在服务端，前端那格只是提示）。
- **闸门放行是"字面路径 + 方法门"**（v1.15.9）：`POST` 放行给 `role=user`，`GET` **不放行** ——
  **路径放行不等于方法放行**，前缀放行会把将来长在 `/api/auth/` 下的别的东西一起放掉
  （与 `session` 只放 `GET`、`logout` 只放 `POST` 同形，§19.1）。
  〔**v1.15.9 实测订正**：这一格的"不放行"**不是 405**，本仓根本没有 405 —— `buildApp`
  没挂 `setNotAllowedHandler`，方法不匹配落进 `setNotFoundHandler`。真实响应按身份分两样：
  `role=user` 打 `GET /api/auth/password` → **`403 FORBIDDEN`「当前账号只能访问消费面」**
  （方法门不给放行 → 落到 `role` 判定的 `403`），`role=admin` 打它 → **`404 NOT_FOUND`**
  「接口不存在」（闸门放行、但没有这条路由）。两个都不是 405，也都不是 200。
  判据表钉的是"**路径放行 ≠ 方法放行**"这一件事，用 `[403, 404, 405]` 三者容错 ——
  写文档时把它念成了 405 是**过度具体**，实测见 ADR-0038「手工走查」。〕
- 写方法照旧过 CSRF（§0.5）：缺 `X-Requested-With` → `403 CSRF_REJECTED`。

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
| `supplier` | ✅ `null` | **只读语义、可写入**。`null` = 通用上游；`"tierflow"` / `"tokenrhythm"` = 走 §15 账号面。前端账号池分区的**唯一判据**是**集合成员** `supplier ∈ SUPPLIER_ACCOUNT_KINDS`（§15.12 锚 1，v1.16.0 改口 —— 等值比较在第二家接入时不报错，只会让新供应商静默没有入口；不解析 `baseUrl` 猜） |
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
| `PATCH` | `/api/upstreams/:id` | 改，body 任意子集 + `revision`（含 `supplier?`，取值 `null \| "tierflow" \| "tokenrhythm"`，省略 = 不改） |
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
③ 账号型驱动（★v1.4.0 新增；★v1.16.0 扩为在册供应商）→ 上游 supplier 是 §15 在册账号型
                             （`"tierflow"` / `"tokenrhythm"`）时按账号逐个查（§15），
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
| `BALANCE_AUTH_REJECTED` | 401 / 403（`failed` 子型） | 提示 key 可能失效，或该端点需要另一种凭据 |
| `BALANCE_EGRESS_RATE_LIMITED` | **429**（`failed` 子型；**v1.7.0 新增**） | 提示稍后重试、**不必改配置**；**不得**写成"出口被限流" |
| `BALANCE_UPSTREAM_UNREACHABLE` | 不可达 / 超时 / 非 2xx（**429 除外**）（`failed`） | 提示稍后重试，**不**引导改配置 |
| `null` | `ok` 且解析出数 | 无需引导 |

- **v1.7.0：`hintCode` 四值 → 五值**（枚举新增，非破坏）。第 5 值 `BALANCE_EGRESS_RATE_LIMITED` 的
  **判据是 HTTP 状态码 `429` 本身，不看任何标记头** —— 上游真的 429 与本地合成的 429（ADR-0021 决策 4a，
  装饰器产出、带 `x-sub2api-egress-local: 1` 标记头）**归同一行**。理由：标记头只证明"**我们自己的桶拒了**"，
  **不证明**"给 429 的是这把 key 的额度"；而**未带标记的上游出口级 429**会被判成"key 自身限额"，
  与本节要消灭的误报**镜像同形**。**故两行的触发条件按状态码一条线切**：`429` 一行、**非 429 的 `failed`** 另一行。
- **文案纪律（不得越证据）**：429 无专用上游码、**出口级与 key 级同形**（§16.7 v1.6.2）⇒ `hintText` 只能写
  "**本次请求被限流（429）**：可能是出口 IP 的请求预算已用尽，也可能该 key 自身撞到限额；稍后重试即可，
  **不必改配置**"，**不得**写成"出口被限流"这类**确定性归因**。这是 ADR-0021 决策 4 让本地拒绝与上游 429
  "证据面同形"在文案上的直接后果。
- **码名保留 `BALANCE_EGRESS_RATE_LIMITED`**（Bo 2026-10-07 裁定；ADR-0017 补遗 3 曾建议改 `BALANCE_RATE_LIMITED`）。
  由此**多带一条前端纪律**：`web/src/components/BalanceHint.tsx` 的 `HINT_CONFIG` 第 5 项的 `title` 是**另一处用户可见文案**，
  **同样必须按"不越证据"写** —— `title` 写死"出口限流"就把后端刚立的文案纪律从这一处漏掉。
- 触发列**全仓只有本表一处**：§14.2 那张表是**写库纪律**表（不可达 / 超时 / 非 2xx ⇒ **一个字都不写**），
  429（上游的与本地合成的**同属"不写"**）⇒ **那张表不动**。
- **`hint` 的 `Retry-After` 连带**：本地拒绝会带 `Retry-After`（= 到下一枚 token 的时间），而全仓 API 侧此前
  **无人读 `retry-after`** ⇒ 文案若写"稍后重试"却给不出秒数，前端只能说"稍后"、说不出"等多久"。
  落法（**v1.8.1 已落地**）：`QueryOutcome` 增 `retryAfterSeconds?: number`（值的唯一来源 = 本地拒绝带回的 `Retry-After`，
  上游真 429 恒不带），并带进刷新任务 `result` 与 `BalanceTestResult`（§3 / §2 本版正文）—— 非破坏新增一个可选字段。
- `hint`：`string | null`，面向用户的一句话（中文，可直接展示）。
- 刷新任务 `result` 在原 `{checked, ok, failed, unknown, skipped}` 基础上增加 `hintCode` / `hint` 两字段，**v1.8.1 再增 `retryAfterSeconds`**（可选、可 `null`，见 §3）；计数语义**逐字不变**。
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
  "hint": null,
  "retryAfterSeconds": null
}
```

| 字段 | 说明 |
|---|---|
| `source` | `"user-template"` \| `"preset"` —— 本次实际用的是哪一条（③ 走不到，无查询方式时直接 422） |
| `endpoint` | **规范化后的 `协议//host/path`**，已剥掉 query。绝不回显替换过 `{key}` 的 URL |
| `parsed.balance` | 分；`null` = 取不到（与"0"严格区分）。**自测永不写库**，所以 `balanceUpdatedAt` / `balanceSource` 不因此改变 |
| `raw` | 上游响应体，**已抹掉明文 key 的所有出现**并截断至 8KB。取值路径没配对时，用户靠它看出来该填什么 |
| `errorCode` | `null`（成功）\| `"UPSTREAM_UNREACHABLE"` \| `"PARSE_FAILED"`；HTTP 仍是 `200` |
| `retryAfterSeconds` | `int` \| `null`（**v1.8.1 新增**）。本地拒绝带回的 `Retry-After`（整数秒）；**上游真 429 恒 `null`**（见上"值的唯一来源"）；其余情形 `null` |

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
| `POST` | `/api/keys/:id/balance/refresh` | 按模板查单个 key 余额 → `202 {taskId}`（异步，轮询 `GET /api/tasks/:id`；`result` 含可选 `retryAfterSeconds`，v1.8.1） |
| `POST` | `/api/keys/:id/test-balance` | **自测**：用该 key 的生效查询方式真实打一次 → `200 BalanceTestResult`（同步、不写库，见 §2） |
| `POST` | `/api/keys/batch` | `{ids: [], action: "enable"\|"disable"}` → `{updated: 5}` |
| `POST` | `/api/keys/balance/refresh` | 批量查余额 → `202 {taskId}`（`result` 含可选 `retryAfterSeconds`，v1.8.1） |

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

### 余额刷新任务 `result` 的 `retryAfterSeconds`（v1.8.1）

`POST /api/keys/:id/balance/refresh` 与 `POST /api/keys/balance/refresh` 的任务 `result` 新增**可选** `retryAfterSeconds?: number`（`hintCode` / `hint` 同批字段，非破坏）：

- **取值**：`int` 整数秒（≥1）｜`null`。**值的唯一来源 = 本地拒绝**（`isLocalEgressReject`，fetch-gate 合成 429 的 `retry-after` 头）；
  本轮**多个**本地拒绝取**最大**（对调用方唯一有用的等待量 —— 等完最大那个，全部 token 都已恢复）。
- **上游真 429 恒 `null` / absent**：按状态码分流是 `hintCode` 的判据（§2），**值**只来自我们自己的桶 —— 上游对出口级 429 从不发 `Retry-After`（§16.7 v1.6.2）。
- **`null` = 无建议，前端不显示**；`hintCode=BALANCE_EGRESS_RATE_LIMITED` 且本字段为 `null` ⇒ 本轮只有上游 429，**不得反推出口状态**（§7 纪律）。
- **§14.2 零改动**：写库纪律表不动（429 仍"一个字都不写"）；三型计数语义逐字不变；零 DDL，`SCHEMA_VERSION` 仍为 2。

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
  "authorizedModels": ["deepseek-chat"],
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
`authorizedModels` 为 `null` ⇒ **不限模型**（该组可用全部已启用模型）；为列表 ⇒ 该组**只能**请求列出的模型名（见下「模型授权」）。

> **首库种子「管理组」（v1.15.6 / ADR-0035）**：一个**全新的库**首次启动时
> （`admin_users` 为空那一刻），引导流程会建一个名为 `管理组` 的组并把首个管理员
> 放进它 —— 于是管理员**开箱即有一把能打 `/v1/*` 的 key**。
> 这是**普通组**，不是特权：它出现在本节的列表里，配额可改、key 可加、组可删
> （删掉后管理员退回"未分配"，账号本身不受影响）。
> 种子**推荐配额为空**（不限）—— 那是个政策决定，不是默认值：部署者建站后
> 应当自己给它设 `rpm` / `tpm` / `dailyQuota`（见 ADR-0035 遗留 2）。
> **已有账号的库（升级）零动作**：`bootstrapAdmin` 在 `adminCount > 0` 时直接返回，
> 而"给管理员补一个组"这件事**不替用户做** —— 走 §19.7 那条 PATCH（可见、有审计）。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/groups?q=&page=&pageSize=` | 列表 |
| `POST` | `/api/groups` | `{name, rpm?, tpm?, dailyQuota?}` → `201`；**建组时自动签发第一个网关 key**，响应**额外带 `gatewayKey`（仅此一次）**。注意**形状与下一行不同**：这里是**嵌套对象** `{id, gatewayKey, maskedKey, createdAt}`（`{...group, gatewayKey: issued}` 摊平），明文在 `gatewayKey.gatewayKey` —— 见下「建组响应的 `gatewayKey` 是对象」 |
| `GET` | `/api/groups/:id` | 详情（**不含**明文） |
| `PATCH` | `/api/groups/:id` | `{name?, rpm?, tpm?, dailyQuota?, enabled?, revision}` |
| `GET` | `/api/groups/:id/models` | 该组模型授权（**只读**）→ `{models: string[] \| null, authorizedModels: [{id, name, upstreamId}]}`；`models: null` = 不限（见下「模型授权」） |
| `PUT` | `/api/groups/:id/models` | body `{models: string[] \| null, revision}`（**两格都必填**）→ `200 {models, authorizedModels, group: Group}`；`null`/`[]` = 不限（**整组替换**，不是增量）；含未知模型名 → `400 INVALID_PARAM`（`details.field='models'`）；`revision` 不匹配 → `409 REVISION_MISMATCH` |
| `DELETE` | `/api/groups/:id` | → `204` |
| `GET` | `/api/groups/:id/keys?page=&pageSize=` | 该组网关 key 列表（**不含**明文）→ 分页信封，项见下 |
| `POST` | `/api/groups/:id/keys` | 再签发一把，body `{label?}` → `201 {id, gatewayKey, maskedKey, label, createdAt}`，**明文仅此一次**（`label` v1.15.9） |
| `POST` | `/api/groups/:id/keys/:keyId/reset` | 重置 → `200 {id, gatewayKey, maskedKey, label, createdAt}`，旧 key **立即失效**（**新钥匙不带名字**，见下） |
| `DELETE` | `/api/groups/:id/keys/:keyId` | → `204` |

> **网关 key 明文纪律**：只在创建/重置响应里出现**一次**，之后绝不可再取回。前端创建弹窗关闭即从内存丢弃，**不缓存、不写 localStorage**。库内只存 sha256 摘要。
>
> **建组响应的 `gatewayKey` 是对象，不是字符串（v1.15.7 补登，实测踩过）**：上表两行的**明文位置不同形**，
> 这是本节最容易抄错的一处 ——
> `POST /api/groups` 回的是 `{...group, gatewayKey: {id, gatewayKey, maskedKey, createdAt}}`
> （仓储层 `createGroup` 的返回值就是把 `group` 与 `issued` 两件事拼在一起，路由层原样摊平），
> 所以**明文在 `gatewayKey.gatewayKey`**、掩码在 `gatewayKey.maskedKey`；
> 而 `POST /api/groups/:id/keys`（与 `…/:keyId/reset`）回的是**顶层四格**，明文就在 `gatewayKey`。
> 本版实测：`web/src/api/types.ts` 曾把前者写成 `gatewayKey: string`，
> **类型检查全绿、四道门禁全绿**，而运行期把那个对象直接喂给弹窗 →
> React 抛 `Objects are not valid as a React child`，**建组后整页进错误边界**。
> 教训不是"前端大意了"，是**契约此前从未把这两处形状写下来对照** ——
> 一份没写明形状的响应，前端只能靠猜，而猜错时编译期一声不出（契约只记"额外带明文"）。
> 服务端形状**本版不改**（改它要动 `dto.ts` 与既有用例，那是另一版的裁定）；这里补的是**对照文本**。
>
> **key 的形状（v1.15.7 补登）**：`gw-` + 24 字节 base64url（`src/db/ids.ts`）。
> 前缀刻意**不是** `sk-`：这是**我们自己签发**的凭据，不该长得像上游 key
> （上游 key 长 `sk-…`，两者出现在同一张表 / 同一份日志里时，"这把是哪种"必须一眼可判）。
> 此前契约正文从未登记过这个形状，只在 §12 的脱敏正则里出现过 `gw-…`；
> `web/` 消费面一度按 `sk-` 措辞引导用户去列表里找，**照它去找得到的是空集**（v1.15.7 已改）。
>
> **`label` 在重置腿上是 `null`（v1.15.9 登记，实测确认）**：`resetGatewayKey` 是「删旧行 + 插新行」
> 且**不传 `label`**（管理面的两个调用点 `createGroup` / `resetGatewayKey` 都不传 ——
> 它们的语义是"建组附赠一把"与"换掉这把"，不是"起个名"）。
> 后果要说清：**一把改过名的 key 被重置之后，名字没了**。这不是漏写 ——
> 重置换的是**凭据本体**，旧名字描述的是"那把被换掉的"；沿用旧名字会让列表里出现
> "小王的笔记本"却是一把小王从没见过的新钥匙（他手里的旧钥匙已经失效了），
> 那是比"没名字"坏得多的信号。**消费面的自助重置不存在**（自助只有签发 / 改名 / 吊销），
> 所以用户侧看到的行为是"我改了名的 key 一直在"，只有管理员重置会清名。
>
> **逐把 key 的管理面（v1.15.7 登记，端点零新增）**：本节四条 key 端点（列表 / 签发 / 重置 / 吊销）
> 都是**逐把**的，但管理面长期只把它们收在一个"整组"的视角下（每行一个 `gatewayKeyMasked` + `共 N 把`），
> 于是"哪把该重置、哪把该吊销"在界面上无答案。**客户端该有的形状是一个组内 key 列表**：
> 列表来自 `GET /api/groups/:id/keys`（**它是唯一给出 `:keyId` 的读面**），
> 行上直接给重置 / 吊销（各自一个确认，重置要明说**旧 key 立即失效**），
> 签发 / 重置成功后当场展示明文一次并**同时给出带 `/v1` 的 Base URL**。吊销成功后就地删掉那一行，
> **不整页刷新**。`web/` 侧的落法见 ADR-0036。

### 模型授权（v1.15.8 / ADR-0037）

Bo 的原话：「别人的用户组是可以授权模型的，哪些组下的账号用哪些模型。」—— 本组之前**一个字段都不缺**
（`upstream_keys.model_limits` 管的是"哪把上游 key 能跑哪个模型"，§3 / §16.3），
缺的是**组这一层的收缩**：没有任何地方能表达「这个组的账号只许用这几个模型」。

**形状**：`POST /api/groups/:id/models` 不存在 —— 授权是**整组的一个属性**，不是可累加的集合成员，
所以用 `PUT`（全量替换）而不是 `POST`/`DELETE` 逐项增删。这与 `PUT /api/keys/:id/balance` 同一条理由：
**`null`（不限）与 `[]`（一个都不许）是两个不同的事实，省略字段表达不了"置回不限"**，
所以 `models` **必填且可空**。

| 请求体 | 语义 | 落库 |
|---|---|---|
| `{"models": null}` | **不限模型**（该组可用全部已启用模型） | 删掉该组在 `group_models` 里的**全部行** |
| `{"models": []}` | 与 `null` **同义**（不限）—— 见下"三态" | 同 `null`：删全部行 |
| `{"models": ["a","b"]}` | 只许请求 `a` / `b` | 删旧行 + 插 `a` / `b` 两行（**同一事务**） |

**三态只有两态：不落在"不限 / 受限"之外再分一层**。本契约沿 §15.7 / §16.3 的冻结口径
（`src/db/model-limits.ts` 的 `serializeModelLimits`）：`null` / `[]` **同义 = 不限**，
出口恒不出现 `[]`，**本契约不制造一个网关实现不了的第三态**。
明确**不**支持"显式一个都不许"：它要求网关把"组没有任何可用模型"与"组未授权任何模型"
分开表达，而后者与"组被禁用"（`GROUP_DISABLED`）的失败形状几乎一样、排障含义却相反；
真有这个需求，正确的形状是**禁用组**，不是把授权列表设空。

**键是模型名，不是 `model_id`**（ADR-0037 决策 2）：

- 网关侧判的是**客户端请求的模型名**（`/v1/models` 给出去的是 `m.name`，
  `POST /v1/chat/completions` 收到的也是名字），所以授权必须**按名字**判，
  否则得在热路径上做一次名字→id 的映射，而那个映射今天**不存在**（`resolveUpstreamModel`
  是恒等透传，档案表没有别名列）。
- 代价**写在这里**：`models.name` **不是全局唯一**（`UNIQUE (upstream_id, name)`，
  两条上游可以有同名模型）。所以授权一个名字 = 授权**所有叫这个名字的档案**。
  这是**有意的**：`/v1/models` 上本来就分不出两条同名档案（`id` 字段给的就是 `m.name`），
  按 id 授权会造出"列表里有它、授权表里没有它"的假象。
- 表里仍存 `model_id`（`REFERENCES models(id)`），但它是**落库时由名字解析出来的**：
  解析不到（名字不存在 / 上游已删）→ `400 INVALID_PARAM`（`details.field = 'models'`）。
  **不做静默忽略**：把拼错的名字静默丢掉，等于给用户一个"保存成功但什么都没授权"的面。

**热生效**：授权改变的**下一个 `/v1/*` 请求**即生效，与网关 key 撤销同级
（`src/wiring/auth.ts` 的实时读库口径，不走快照、不等 1s 轮询）。

**乐观锁**：`revision` 必填（与 `PATCH /api/groups/:id` 同一条 —— 授权是组行的一个属性，
两个管理员同时编辑同一个组的授权时，后写者必须知道前面有人写过），不匹配 →
`409 REVISION_MISMATCH`（`details.expected` / `details.actual`）。**PUT 成功会递增
`groups.revision`** —— 组行上的其他编辑（改名、配额）因此也能感知"授权动过了"。

**级联**：删组 → 该组的 `group_models` 行一起删（组没了，它的授权无从谈起）；
删上游 → 该上游下模型档案被硬删时，指向它们的授权行也一起删
（**否则外键违约，删上游直接 500** —— `foreign_keys=ON` 且全库无 `ON DELETE` 子句，见 §19.9）。
删组 / 删上游**都不删模型档案本身**，所以"授权列表里少了一个"的唯一成因是它被删了，
不是"授权被顺带清空"。

**写入侧的两条边界（`PUT` 的失败形状）**：

- **名字解析先于写库**：`models` 里有一个解析不到的名字 → 整次 `PUT` 回
  `400 INVALID_PARAM`（`details.field = 'models'`，message 列出未知的那些名字），
  **库零变更**（`revision` 都不动）—— 不静默丢掉拼错的名字（决策 2）。
- **未知组 → 404**：`:id` 不存在时 `GET`/`PUT` 都回 `404 NOT_FOUND`，
  与 `PATCH /api/groups/:id` 一致。

**解析面不限 `enabled`**（写侧判据，与 §5「启用/停用」是两件事）：
授权一个**存在但当前被停用**的名字是**合法**动作 —— 停用是档案的临时状态、
授权是组的长期策略，把前者当后者的前置条件会把"先授权、再启用"变成一条
没人记得住的**操作顺序约束**（而那条约束的失败表现是"保存没生效"）。
**代价说清**：这种授权当**打不通**（档案停用走不到它），但**仍然在授权列表里**，
所以它会出现在 `GET` 的 `authorizedModels` 里、**不在** `/v1/models` 的收窄结果里 ——
管理面抽屉对此**必须显式提示**（不然就是又一种"看得见但不生效"的会骗人的信号，
ADR-0037 决策 9 有抽屉侧的具体落法）。

### 网关 key 列表项（`GET /api/groups/:id/keys`；`GatewayKeyDto`）
```json
{
  "id": "gwk_9a12",
  "maskedKey": "****9f3c",
  "label": "小王的笔记本",
  "createdAt": "2026-10-01T03:00:00.000Z"
}
```
- `id` 就是 `:keyId` 的取值 —— **本端点存在的唯一理由**：`Group` 对象只暴露 `gatewayKeyMasked`，前端拿不到 `keyId`，重置/吊销两个端点无从触达。
- `label` **非破坏新增**（v1.15.9 / ADR-0038）：人类给这把 key 起的名字，`string | null`（`null` = 没名字）。
  这一列**建表起就在**（`src/db/schema.ts`），只是从来没人写、也没人读；v1.15.9 把签发权下放到消费面之后，
  "哪把是给哪个客户端的"没有答案就成了一个真问题 —— 它是**签发（可选带上）与改名（可改可清）**共同写的一格。
  - **空串与纯空白一律归一化成 `null`**（`normalizeLabel`），所以只有两态，**没有 `""`**：
    库里两种"空"并存之后，前端判空的那句就得写两遍，而漏掉的那遍会把 `''` 渲染成一个看不见的 `<Tag>`。
  - **它不参与任何判据**：不加进 `key_hash`、不影响鉴权、不影响排序（排序仍固定 `createdAt, id`）。
    改一个名字**不会**让任何客户端掉线。
- **不返回** `updatedAt`：网关 key 的改法是「删旧行 + 插新行」（重置即失效），`updated_at` 恒等于 `created_at`，回一个永远相等的字段只会让人以为它可以不同。
  **〔v1.15.9 补记：改名是唯一的例外 —— 它会写 `updated_at`，而这一版**仍然不回**这个字段：
  理由不是"它现在还恒等"（改过名的行已经不恒等了），是"回了它就要有人在界面上解释这个差异"，
  而名字什么时候改的对使用者没有意义。这一格留着，以便将来真要"最近改名时间"时不必再动形状。〕**
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
| `type` | `chat` \| `embedding` \| `image` \| `audio` \| `rerank` | **模型类别**（v1.15.10 起它**进服务路径**，见 §10「端点类别准入」）。写入面：`POST /api/models/sync` 按**名字**推断（`inferModelType`，§5 同步映射表）、`PATCH /api/models/:id` 人手改（人工优先，同步不覆盖已手工改过的行）。**建了 `image`/`audio`/`rerank` 的档案不等于那个端点能用** —— 三类端点一律 `501`（§10 `UNSUPPORTED_PREFIXES`）；类别的用途是"**哪个端点服务它**"，不是"它能不能跑"。本字段**没有** `POST /api/models` 创建端点（档案只能经同步出生） |
| `capabilities` | `stream` \| `function_call` \| `vision` \| `json_mode` 的数组 | |
| `capabilitiesSource` | `manual` \| `probe` \| `null` | **v1.11.0 新增、只读**（`PATCH` 不收）。来源标记，与 `capabilities` 一起解读：`manual` = 人手 `PATCH` 写的（**探测永不覆盖**）；`probe` = 机器探测写的；`null` = 从没问过。`ADMIN`/前端只读，用来区分「不知道」与「问过、不支持」 |
| `lastProbedAt` | ISO8601 \| `null` | **v1.11.0 新增、只读**。最近一次能力探测的时刻（**探测每次都刷，与是否覆盖 `capabilities` 无关**）；`null` = 从没探测过 |
| `endpointTypes` | `null` | **v1.11.0 登记、本期恒 `null`**。上游 `supported_endpoint_types` 的预留位；语义是**端点类型**不是模型能力，**不得**并入 `capabilities`。本期不采集（见「能力探测」⑥） |
| `contextLength` | `int` \| `null` | 上游没给就是 `null`，前端显示 `—` |
| `price` | 对象 \| `null` | `inputPer1k`/`outputPer1k` 单位**分**。**缺失是 `null` 不是 0**，前端显示 `—` |
| `availableKeyIds` | `string[]` | 当前**可服务**该模型的 key（已启用、非冷却、余额 > 0、**且模型在其白名单内**）。空数组 = 暂不可用 |

> **白名单口径（v1.4.2 补，因 §3 新增 `models`）**：`availableKeyIds` 的筛选必须**同时**满足
> **生效白名单** —— `models` 为 `null`/空（不限）**或** 含本模型的 `name`。生效白名单 = `key.models` 非空时取它，
> 否则继承上游级限制（网关 `keyModels()` 的既有口径，`src/gateway/key-pool.ts`）。
> 少这一条，档案卡会列出"能跑这个模型"的 key 里混进白名单外的一把 —— 而网关侧 `matchesModel()` 会拒绝它，
> 于是页面上「可用 key 有 3 把」与实测「2 把在跑」长期对不上，且**没有任何报错**可以追。
> `models` 是**上游事实、只读**：`PATCH /api/keys/:id` 不收该字段，本地想覆盖是 P6 `key_models` 的事（尚未落地）。
| `enabled` | bool | 决定是否出现在 `/v1/models`。验收 4 要求两边**逐项 0 差异** —— **v1.15.8 改口**：`/v1/models` 的集合 = `enabled` 判据 **∩ 该组授权**（§4「模型授权」）；**未授权任何收缩的组**（`authorizedModels: null`）看到的集合与改版前**逐项相同**，验收 4 的原判据对这类组原样成立 |

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/models?upstreamId=&type=&capability=&enabled=&q=&page=&pageSize=` | 卡片列表 |
| `GET` | `/api/models/:id` | 档案卡详情 |
| `PATCH` | `/api/models/:id` | `{enabled?, type?, capabilities?, contextLength?, price?, displayName?, revision}` |
| `POST` | `/api/models/sync` | `{upstreamId?}` 省略则全量 → `202 {taskId}`；v1.11.0 起**尾部自动补探**（可关，见 §5 能力探测） |
| `POST` | `/api/models/:id/probe` | **v1.11.0 新增**。`{targets?, apply?}` → `200 ModelProbeResult`（打能力专属上游请求、按响应判能力；见本节「能力探测」）。**同步返回**（ADR-0024 决策 1 原文：不 `202`、不打任务；仅当单上游多模型超出单轮预算、需跨模型续跑时才退任务面 `result.probe`） |

`POST /api/models/sync` 是**异步任务**（上游拉取可能慢），不阻塞 HTTP。前端轮询 `GET /api/tasks/:id` 拿真实进度——**不许做假进度条**。

### `POST /api/models/sync` 的字段映射（ADR-0009）

上游 `/v1/models` 只回 `{id, object, created, owned_by}` —— **没有**能力、上下文长度、价格。所以同步只写它确实知道的东西：

| 字段 | 同步写入 | 理由 |
|---|---|---|
| `name` | 上游 `id` | 唯一有证据的字段 |
| `type` | **按名字推断**（规则表见 ADR-0009），命不中为 `chat` | 推断是显式的、可覆盖的：建档之后以库里现值为准，`PATCH /api/models/:id` 改过就不再被同步回退 |
| `displayName` | `null` | 上游不给；不拿 `name` 顶替 |
| `capabilities` | `[]`（**不改人工值**） | 空数组 + `capabilitiesSource=null` = **未声明**（没问过），不是「没有任何能力」；**已探测过**的行保留探测结果（见「能力探测」③） |
| `contextLength` | `null` | 未知，前端显示 `—` |
| `price` | `null` | 未知 **≠ 0**。编一个价格会让统计口径从第一秒起就是假的 |
| `enabled` | 建档写 `1` | 建档即启用；是否真正服务由管理员在档案卡上关 |
| `lastSyncedAt` | 本次同步时间 | 回答「上次拉到数据是什么时候」；内容没变也会刷新，前端用它判新鲜度 |

两条不变量（改代码前先读这两条）：

1. **永不编造**：上游没给的字段一律留空。任何「合理默认值」都是造假。
2. **未知不覆盖已知**：同步只在**建档**时写这些字段；对已存在的模型，`null`/`[]` 不是「新值」，不构成覆盖理由。管理员 `PATCH` 补的 `price`/`capabilities`/`contextLength`/`type`/`displayName` 在下一次同步后原样保留 —— 否则「同步一次就抹掉刚录的价格」比不填更坏。

任务 `result` 里带 `inferredTypeCount`：本次**建档**时靠推断定类型的条数。管理员据此知道有多少条 `type` 是猜的、不是从上游读来的。

#### 能力探测 `POST /api/models/:id/probe`（v1.11.0 新增）

上游 `/v1/models` 只回 `{id, object, created, owned_by}` —— 能力那几格**上游永远不给**（ADR-0009）。
本节给它一个**机器来源**：拿档案里那把已启用的 key，发**能力专属**的上游请求，用**响应本身**判
`vision` / `stream` / `function_call` / `json_mode`，把结论写回档案卡。**不猜、不编默认值**。

**这是 Bo 明确要的能力**（原话：「获取模型后……就要去测试模型的参数……我用我们的 url 和 key
获取模型要能识别这些模型的功能」）。动机、被否掉的备选与代价见 `docs/adr/0024-model-capability-probe.md`。

##### 请求

```json
{ "targets": ["vision", "stream", "function_call", "json_mode"], "apply": true }
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `targets` | 四项能力名数组，可省 | 省 = 全探。**只接受这四枚**，其余 → `400 INVALID_PARAM`（`details.field="targets"`） |
| `apply` | bool，缺省 `false` | `true` = 把探测到的 `true` **写回档案**（走④的来源规则）；`false` = **只回结果、一个字节都不写库** |

##### 响应 `ModelProbeResult`（`200`，同步返回）

```json
{
  "modelId": "mdl_5e10",
  "modelName": "tierflow_pro",
  "upstreamId": "up_7f3a",
  "probedAt": "2026-10-14T09:12:00.000Z",
  "requests": 4,
  "items": [
    { "capability": "vision", "supported": true, "status": 200, "durationMs": 1180, "reason": null },
    { "capability": "stream", "supported": true, "status": 200, "durationMs": 640, "reason": null },
    { "capability": "function_call", "supported": false, "status": 400, "durationMs": 410, "reason": "upstream_4xx" },
    { "capability": "json_mode", "supported": null, "status": 429, "durationMs": 90, "reason": "rate_limited" }
  ],
  "applied": ["vision", "stream"],
  "capabilities": ["stream", "vision"],
  "capabilitiesSource": "probe"
}
```

- `supported` 是**三态**，不是布尔：`true` = 支持 / `false` = **上游明确拒绝** / `null` = **判不出**（下面那张表的非 4xx 分支）。
- `applied`：本次**真写进档案**的项（`apply:false` 时恒 `[]`）；`capabilities` / `capabilitiesSource` 是**写后现值**（`apply:false` 时也是现值，便于前端直接渲染）。
- `reason` 是**逐端点诊断字段**（与 §15.4 `SUBSCRIPTION_NOT_FOUND` 同一条：**不进口径码表** `ERROR_CODES`），取值：`upstream_4xx` / `rate_limited`(429) / `auth`(401/403) / `not_found`(404) / `server_error`(5xx) / `timeout` / `network`（后两者 `status` 为 `null`）。
- **探测永不写 `usage_logs`**，故本响应里没有 token 数；`requests` = 本次真打出去的上游请求数。

##### 判据表（**能力专属请求 + 只看响应**，不解析任何文案）

| 能力 | 探针请求（服务端内置） | `true` | `false` | `null` |
|---|---|---|---|---|
| `vision` | `POST /v1/chat/completions`，`messages` 带一张**内置小图**（data URL，≥20×20 PNG）+ `max_tokens` 压到最小 | `2xx`（上游把图收下并作答了） | `4xx`（**你要的干净报错**：不支持时上游当场拒，几乎不烧 token —— 路由者实测原话 `the image length and width do not meet the model restrictions`） | `401/403/404/429/5xx` / 超时 / 网络 |
| `stream` | 同 chat，`stream:true` | `2xx` **且** `content-type` 以 `text/event-stream` 开头 | `2xx` 但**不是**事件流 | 同上 |
| `function_call` | 同 chat，带一个**必然可解析**的 `tools` | `2xx` | `4xx` | 同上 |
| `json_mode` | 同 chat，`response_format:{type:"json_object"}` | `2xx` | `4xx` | 同上 |

> **`2xx` 的吹哨纪律（一条不变量）**：所有探针都用 `max_tokens` 压到最小并显式传最小可用参数集 ——
> `true` 的语义完全建立在「上游真的把这次请求处理了」之上。请求体一旦被调用方注入（例如塞一堆
> 不可用参数），`2xx` 与 `4xx` 都不再只反映能力，判据当场失效。所以**请求体由服务端内置**。

**`contextLength` 本笔不做** —— 撞窗口反推烧的是真流量、且**给不出数字**（只能回答"撞到过 5 万这个量级"），
与 ADR-0009「永不编造」同向：留 `null`（前端显示 `—`），上游哪天给字段再零成本吸。

##### 计量隔离（四条硬约束，实现必须逐条满足）

1. **零 `reportFailure` / `reportSuccess`** —— 探测**不进网关引擎**。不支持能力时上游回 `4xx`，那是**模型的
   性质、不是 key 的故障**；若从引擎走，一次能力探测就会把一把好 key 打进冷却并拉低业务成功率。
   （口径同 §13.4 助手「计入 key 健康」的**反面**：助手撞坏的是 key，这里撞坏的是模型。）
2. **零 `usage_logs`** —— 探测不出现在 §6 `overview` / `usage` 的 QPS、成功率、token 里。
3. **出站必走装配层注入的 `fetchImpl`**：接线层已把它包成 `fetchFor(egressId,'management')`（ADR-0021 决策 4），
   探测是**第九类出站**，必须占**同一个出口桶**、走 `'management'` 消费者（**不得占数据面保留额度**）。
   **禁止裸 `fetch`** —— 旁路 = 在 IP 预算上再开一个洞。
4. **计量随动作走**：本次探测的请求数只出现在**本响应** `requests`、**同步任务** `result.probe` 与**审计**
   `model.probe`（`detail` 只放计数）里。**不并进 §12.2**（`assistant.*` 是常驻流量计量，探测是离散动作、次数由
   `model.probe` 审计查得到）。**`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增。**

##### 来源与落库规则（`capabilities_source`，与 ADR-0009 §4 同向）

1. `PATCH /api/models/:id` **传了** `capabilities` ⇒ `capabilities_source = 'manual'`；**没传就不动它**（若本来是 `null` 就还是 `null`）。
2. 探测在 `apply:true` 时**只写 `true` 的项**，且**只在 `capabilities_source` 为 `NULL` 或 `'probe'` 时写** ——
   `'manual'` **永不被探测覆盖**；`false` / `null` 的结果**从不写库**（"不支持"和"判不出"都不该抹掉已知的能力位）。
3. 落库走**一条条件 `UPDATE`**（`WHERE id=? AND (capabilities_source IS NULL OR capabilities_source <> 'manual' OR last_probed_at IS NULL OR last_probed_at < now)`，`now` = 本轮探测时刻 —— 单语句原子、同表同列零竞态）**原子完成**，
   因此**不需要 `revision` 参数、也不会与并发 `PATCH` 竞态**（并发下 `PATCH` 赢、探测那次丢弃）。
4. `last_probed_at` **每次都刷**（无论 `apply` 与否、无论这次有没有覆盖 `capabilities`）—— 它回答的是「上次问过没有」。
5. **三态可分辨**（前端据此渲染，别把三种读成一种）：`capabilities` 非空 = **有**该能力 /
   `[]` + `capabilitiesSource='probe'` = **问过、不支持** / `[]` + `capabilitiesSource=null` = **未知（还没问过）**。

##### 同步尾部自动补探（Bo 要的"获取模型后自动识别"）

`POST /api/models/sync` 在**尾部**对本次同步涉及的模型补探一次，让"拉到模型 → 自动识别功能"闭环：

- **候选 = 本次同步涉及且 `capabilities_source IS NULL` 的模型** —— `manual` / 已 `probe` 的**一律跳过**，不重复烧。
- **默认开**，两个闸都能关：请求体 `{"probe": false}`（单次调用关）；环境变量 `MODEL_PROBE_ENABLED=false`（装配侧全局关）。
- **单轮上限 `MODEL_PROBE_MAX_MODELS`**（**装配侧 env 默认 = `10`**，数值不进契约；超出的模型留在 `capabilities_source IS NULL`，下一轮再补）；探测对单个模型**同步返回** `200 ModelProbeResult`，仅当单上游候选模型数超预算、需跨模型续跑时才退任务面（`result.probe` 六计数）；
  **出口预算拒绝（`rate_limited`）即停**本轮，不再往后打。
- **探测失败不改任务成败**：`syncModels` 成功/失败判据**只用列表拉取结果**；探测的计数进任务 `result.probe`
  （`{candidates, probed, applied, skipped, failed, requests}`），并写审计 `model.probe`。
- 幂等性写在 §5 字段映射表那一行：**已探测过的行，同步不把它翻回未知**。

---

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

> **本通道只对 `role=admin` 开（v1.15.2，§19.1）**。第 2 步的会话校验**同时判 `role`**：
> `role=user` 同样在第 2 步被拒，码 **`4401`**，且**不会收到任何一帧**（连 `ready` 都没有）。
> 理由是 `metrics` 帧里的 `qps` / `successRate` / `balanceGlobal` / `egress_pool`
> 与 `/api/stats/overview`（§6）**同一份数据**，而 §19.1 明写那个端点不给普通用户 ——
> 同一条链路两种授面结果就是把授面做成了筛子。
> 判据落在 `live.ts` 的 `handshakeSession`（**建连之前**，不是连上之后挑字段），
> 用例 `src/api/routes/live.spec.ts`「role=user 开实时通道」。
> **为什么不用 `1008`**：1008 在前端走 `default` 退避重连分支，会把一个
> "你的身份不该开这条通道"的事实渲染成"网络不好，再试试"，而重新登录一万次也不会变。


### 关闭码

| code | 含义 | 前端动作 |
|---|---|---|
| `4401` | 会话失效 **或身份不该开本通道**（`role=user`，v1.15.2） | 跳登录页 |
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

**`egress_pool`** — 出口池节点（**池级一帧**，不是每出口一帧；S3 仪表盘「出口池」卡片的数据源，v1.6.4 登记）
```json
{
  "type": "egress_pool",
  "serverTime": "2026-10-07T09:12:00.000Z",
  "nodes": [
    { "egressId": "eg_3f9a", "name": "vps-hk-1", "status": "online",
      "exitIp": "203.0.113.7", "expectedExitIp": "203.0.113.7",
      "lastHeartbeatAt": "2026-10-07T09:11:45.000Z", "cooldownUntil": null }
  ]
}
```

| 字段 | 类型 | 语义（**终局名，别改名**） |
|---|---|---|
| `egressId` | string | **不透明字符串**，只当键用（同 §7 既有纪律；Tier 2 = `egress_proxies.id`）。**前端不得解析它的内容** |
| `name` | string | 节点显示名（`egress_proxies.name`）。**用户可改** ⇒ 只作展示，**不作键** |
| `status` | `"online" \| "offline"` | **池化层探活态**，只由探活链给出。前端**不得**按 `lastHeartbeatAt` 的"新鲜度"自己算健康（同 key 健康纪律：运行态由服务端算、管理端只读） |
| `exitIp` | string \| null | 探活**观测**到的出口 IP（`null` = 本次心跳未带回） |
| `expectedExitIp` | string \| null | **登记值**（`egress_proxies` 配置的出口 IP；`null` = 未登记期望值） |
| `lastHeartbeatAt` | ISO8601 \| null | 最近一次心跳的**绝对时刻**（**不得**发"距今多少秒"，同 §7 其余时间字段口径） |
| `cooldownUntil` | ISO8601 \| null | 上游限流态，**与 `egress_cooldown` 帧同源同值**（同一 tick、同一份出口快照） |

> **`exitIp` 与 `expectedExitIp` 不等时必须显式呈现。** 这个比对是 `pool-probe.sh` 已经做的那件事，也是
> 「**填了代理但流量仍走宿主 IP**」这类静默故障**唯一的告警点** —— 不能在 UI 上丢掉，否则配错代理等于全绿。

**四条纪律**：

- **`nodes: []` = 已接线且当前 0 个出口** ⇒ 前端渲染「未配置出口」空态，**不得**渲染成"节点全部离线"
  （上线即报假故障）。**反过来同样成立：收不到本帧 ≠ 0 个出口** —— 收不到只说明"未接线 / 未发射"，
  按本节既有纪律，**缺省不是证据**。
- **N 节点自适应**：`nodes` 长度由后端给，前端**不得写死 2**（PM 拍的是"2 台先行、后续可加"），也不得按节点数自推池容量。
- **前端不合成健康态**：`status`（探活）与 `cooldownUntil`（上游限流）是**两种不可用**，网关侧对二者
  **任一不可用即不选该出口**（ADR-0021 决策 8）；卡片**并列展示两项即可**，
  **不得算"健康分"、不得用一个盖住另一个**（"池说存活、冷却说还冷着"正是一个枚举盖另一个枚举造出来的）。
- **差分指纹必带 `lastHeartbeatAt` 与 `cooldownUntil`**：前者每 30s 一次心跳（是**真变化**，该推）；
  后者会**自然到期**，那一刻没有任何写入、只有时间流逝 —— 与 `key_health` 同一个坑，同一个解法。

**接线是四处、不是三处**（在 `egress_cooldown` 那三处之上多一条）：除 `buildTickFrames` 造帧、
`tickNow` 推帧、把 `egress:pool` 注册进 `tickNow` 的 `live` 集合外，**池帧必须无条件注册** ——
`nodes` 为空也要注册。不注册就是"0 个出口"退回"零帧"，本帧存在的理由当场消失（与上面第一条互为前提）。

**本期状态（同 `egress_cooldown`）**：形状已冻结，但**本期不发射**，三条硬约束原样适用
（**前端不得接线** / **不得把"没收到"当健康** / **不得从 `429` / `Retry-After` / 日志反推**）。
本帧**额外**多一条前置：`status` / `lastHeartbeatAt` / `exitIp` 三条的**生产者不存在** ——
`pool-probe.sh` 无状态、心跳**没有接收端**，按 v1.5.0「**禁止先加字段、后补生产者**」，
它们必须与**心跳上报链**同一批落地。第 **4** 个自检信号：
`git grep -c 'egress:pool' dev/api -- src/api/routes/live.ts`（今天 **0**）。

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
| 8 | 出口池卡片：节点标识 / 在线状态 / 出口 IP / 最近心跳（S3，不插队 `web/`） | §7 `egress_pool` 帧（v1.6.4） | ⏳ 形状已冻结；**本期不发射**，生产者为 S3 前置（心跳上报链） |

---

## 9. 与网关面的边界

- 管理面**不改**网关运行态：`health`/`cooldownUntil`/`consecutiveFailures` 只读。
- 反向的一条同样成立：**`key_runtime` 只由网关进程写**，管理面只读（单写者原则）。写入是约 1s 一次的**批量镜像**，不落在 `/v1/*` 请求线程上 —— 见 ADR-0010。
- 管理面写 key 时递增 `revision`；网关靠共享 SQLite(WAL) + `change_log` + 1s 轮询兜底感知变更。
- **热路径零同步 DB 写**：`/v1/*` 上的用量日志异步批量落库，不得挡在 TTFB 前面。

## 10. 网关面 `/v1/*`（路由者负责，此处仅登记口径）

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | stream / 非 stream。**只服务 `type='chat'` 的模型**（v1.15.10 端点类别准入，见下） |
| `GET /v1/models` | 集合 = 模型档案 `enabled=true` **∩ 该组授权**（验收 4，v1.15.8 改口 —— 见 §5 `enabled` 行与 §19.6）。**v1.11.0 只加字段**：每项新增 `capabilities` / `contextLength` / `endpointTypes`（`endpointTypes` 本期恒 `null` = 未采集），既有 `id` / `object` / `created` / `owned_by` **四字段形状零变更**。**v1.15.10 再加一格 `type`**（同 §5 `ModelDto.type`，同一份 `models.type` 列）—— 准入按类别把关，就必须把类别说出来，否则调用方只能盲试端点 |
| `POST /v1/embeddings` | **只服务 `type='embedding'` 的模型**（v1.15.10，见下） |
| `image` / `audio` / `rerank` | 建档案，接口返回 `501 UNSUPPORTED_ENDPOINT` |
| `GET /internal/snapshot` | 本机观测 |

**端点类别准入（v1.15.10 / ADR-0039）**

两个服务端点各只服务一个类别：`/v1/chat/completions` ← `chat`，`/v1/embeddings` ← `embedding`。
登记类别与端点不符 → **`400 INVALID_REQUEST` + `param=model`**（沿用既有码，**零新增**），
文案里报出该模型的登记类别与端点名。

> **这一条修的是什么**（写清楚，否则下一个人会以为它是"顺手加的校验"）：
> 在此之前 `models.type` **只活在建档与展示里** —— 服务路径上没有任何一层读它
> （读路径的 SELECT 不带这一列、`ModelDescriptor` 里没有这个字段、路由与引擎里零次 `.type` 读取）。
> 于是把任何**登记过的** chat 名字打到 `/v1/embeddings`，请求会被**原样转发**给上游的
> `/embeddings` 路径；上游回 404，而网关把 4xx **原样透传**（`classifyUpstreamStatus` 对 404 判
> `null` = 不是 key 的错，这是对的），于是这**一次 404 被当成一次正常调用**落进 `usage_logs`：
> `x-gateway-attempts: 1`（真的敲了上游）、`error_code = NULL`、并且因为 `todayUsage()`
> **不带状态过滤**，管理面的组用量行与消费面的额度卡（同一句 SQL，§4 / §19.3c）
> 上那个 `requests` 数字会跟着虚高。**类别是网关自己的登记事实**：
> 上游没有向量模型时，正确行为是**网关在出站之前说"这个端点不服务这个类别的模型"**，
> 而不是把问题变成上游的一条 404 —— 后者既烧一次真实尝试，又把失败记成成功。

- **判在路由层、引擎之前**（与 `GROUP_DISABLED` / `MODEL_NOT_AUTHORIZED` / 限流同一族）：
  **0 次真实尝试**、候选集根本不建、不计任何 key 健康、不碰冷却；§12.1 事件与响应同源（归 `INVALID_REQUEST`）。
  与授权门**同一位置、同一排**（都在 `readModel` 之后、"body 其余部分"之前），两个 handler **都要有**。
- **门序**：组停用（403）→ 限流（429）→ 名字缺失（400）→ 组授权（403 `MODEL_NOT_AUTHORIZED`）→ **类别（400）**。
  授权在前是刻意的：没被授权用这个模型的调用方该拿到"没授权"（方向是"找人开权限"），
  而不是"类别不对"（方向变成"换模型名"，那是错的建议）。
- **未登记的模型名本闸不表态**（照旧进引擎）：存在性由候选集回答（既有 `503 NO_AVAILABLE_KEY`，
  同样是 0 次真实尝试）。这条限定了本闸**永远不会拒掉一个路由器还能路由的名字** ——
  否则就是另一种"列表里有、打过去不通"（§19.6）。类别判据取自**快照**（与选路同一拍子），
  未登记的窗口期退回旧行为（上游 404 透传），而不是收窄成 400。
- **修好的形状**（同一条请求，改前 / 改后）：chat 名打 `/v1/embeddings`，
  改前 = 上游 404 透传 + `attempts=1` + 一行 `usage_logs`（`requests` 计数 +1）；
  改后 = 本地 `400` + `attempts` 头根本没有（`x-gateway-attempts` 只由引擎的转发结果写）+ 零 `usage_logs`。
- **同类风险（登记备查，非本版修复）**：若某个上游对**不支持的路径**回 403（而不是 404），
  本缺陷的旧行为会经 `classifyUpstreamStatus` 判成 `AUTH_INVALID` → `reportFailure` →
  key 冷却 → 连续失败自动停用 —— 也就是说**调用方打错端点能打坏一池 key**。
  TierFlow 回 404，所以这条在本部署上没有触发；准入闸落地后它从"整池"缩到"单个名字"，
  但"正常聊天名也可能被上游回 403"这条残余风险仍归 §16.3 的 key 健康口径管辖。

- 错误体：`{ "error": { "message": "...", "type": "...", "code": "..." } }`。
- 每个 `/v1/*` 请求都带 `x-request-id`：入站值合法则沿用、否则重新生成，并在**响应头**回写最终值；同一值原样透传上游，并落 `usage_logs` / `gateway_error_events` 的 `request_id` 列（口径见 §6「关联键」）。该头是本节的**唯一新增要求**，不动错误码表、不动错误体。

**`/v1/*` 错误码登记表**（改动需同步 `src/gateway/errors.ts` 的 `GATEWAY_ERROR_CODES`）

| code | HTTP | `type` | 触发条件 |
|---|---|---|---|
| `INVALID_REQUEST` | 400 | `invalid_request_error` | body 不是 JSON 对象、缺 `model`/`messages`/`input`；**或模型登记类别与该端点不符**（v1.15.10 / ADR-0039，`param=model` —— 消息里写清登记类别与端点名。**0 次真实尝试**、零 `usage_logs`） |
| `INVALID_API_KEY` | 401 | `authentication_error` | 网关 key 缺失/未知/已吊销（**不区分**"不存在"与"已禁用"，避免探测窗口） |
| `GROUP_DISABLED` | 403 | `authentication_error` | 网关 key 有效但所属用户组被禁用（`enabled=false`） |
| `MODEL_NOT_AUTHORIZED` | 403 | `authentication_error` | **v1.15.8 新增**（ADR-0037）。网关 key 有效、组已启用，但请求的模型不在该组授权列表里。**0 次真实尝试**（在路由层就拒，候选集根本不建）、不计任何 key 健康、`failureReason: null`。**type 取 `authentication_error`** 不是 `invalid_request_error`：调用方没有写错任何东西，是**凭据（组）不被允许用这个模型** —— 与 `GROUP_DISABLED` 同一族（"你这个人进不来"，不是"这个请求格式不对"）。与 404 / 503 NO_AVAILABLE_KEY 的分界：模型存在且服务端在跑（`/v1/models` 能列出它），只是**这个组**不被授权 —— 分不清"模型不存在"与"没授权"会让调用方拿 403 去探测别的组有什么模型，所以这里**明说**是授权问题 |
| `NOT_FOUND` | 404 | `invalid_request_error` | `/v1/*` 下未知路径 |
| `RATE_LIMITED` | 429 | `rate_limit_error` | 用户组 RPM / TPM 超限、**网关池饱和**（候选非空、0 次真实尝试、全候选并发已满，ADR-0011），**或出口预算耗尽 / 绑定的出口全部在冷却**（v1.7.0，ADR-0021 决策 9(5)：**同样是 0 次真实尝试、不计任何 key 健康、不写出口冷却、一律带 `Retry-After`**） |
| `QUOTA_EXCEEDED` | 429 | `insufficient_quota` | 用户组日配额（token）超限 |
| `UNSUPPORTED_ENDPOINT` | 501 | `invalid_request_error` | image / audio / rerank 等未实现端点 |
| `UPSTREAM_ERROR` | 502 | `api_error` | **候选存在但用尽**：重试上限内每把 key 都失败 |
| `NO_AVAILABLE_KEY` | 503 | `server_error` | **候选为空**：该模型一把可用 key 都没有；或**候选存在但密文解不出**（元数据在、`secrets.resolve === null`，0 次真实尝试的配置异常，ADR-0011） |
| `NO_AVAILABLE_EGRESS` | 503 | `server_error` | **v1.7.0 新增**（ADR-0021 决策 9(5)）。**池中没有任何活着的出口绑定**：绑定的出口全部 `retired`，或出口池模式启用后一个出口都未登记。**不回落宿主直连**（回落破"独享"前提与上游 IP 白名单，且没有人看得见）；**不带 `Retry-After`**（等待无效、只能改配置）。**不含"账号级未绑"** —— 某个账号 `egress_id IS NULL` 是**配置事实**、照常走宿主出口，不是池空 |
| `UPSTREAM_TIMEOUT` | 504 | `api_error` | 所有尝试都超时（首字节超时，默认 120s） |

> 502 与 503 的分界是**候选集是否为空**，不是"最终有没有成功"：池子里有 key 但全试完仍失败 → `502 UPSTREAM_ERROR`；一把都选不出来 → `503 NO_AVAILABLE_KEY`。两者的排障含义完全不同（前者查上游，后者查池子/档案）。
> **0 次真实尝试不是上游故障（ADR-0011）**：候选非空却在派发前被并发槽位全部挡回（`skippedSaturated > 0` 且无可解析异常）→ `429 RATE_LIMITED` + `Retry-After: 1`，message 明示 `pool saturated`；候选里有 key 但密文解析不出 → `503 NO_AVAILABLE_KEY`（message 明示 `unresolvable`）。两条都**不得报 502**，且都是 0 次真实尝试、`failureReason: null` —— 不计入任何 key 的健康计数。
> **429 响应一律带 `Retry-After`（秒，int）**：用户组 RPM / TPM 超限、日配额超限（`QUOTA_EXCEEDED`）与网关池饱和（`RATE_LIMITED`）三条路径都写该头（池饱和头部由 ADR-0011 起补），两类 `rate_limit_error` 语义统一为"退避后可重试"。调用方按该头退避，不解析 message 文本。
> **`Retry-After` 的回答面（v1.7.0 补，ADR-0021 决策 9(5)）**：它的语义是「**等多久**」——
> **带确定性恢复时刻的不可用态才给**：出口**在冷却** → `min(cooldownUntil) − now`；**预算耗尽** → 到下一枚 token 的时间。
> 反过来，**没有它，等待就是无效的** —— 但这句话的定义域是**出口面这两枚码**（`NO_AVAILABLE_EGRESS` 与出口面 `RATE_LIMITED`），
> **不得**拿去对 §10 全表做全局断言：`NO_AVAILABLE_KEY` 就是那枚**可重试**的 503（v1.2.1 / §13.4 明令"请稍后重试"必须同时覆盖 `429 RATE_LIMITED` 与 `503 NO_AVAILABLE_KEY`）。
> **v1.7.0 新增码的两条边界**：① `503 NO_AVAILABLE_EGRESS` 的"不带 `Retry-After`"是**码值级**不变量，
> 且**只有本码**享有"§10 里唯一只能改配置的 503"这个读法 —— 落笔与实现**不得**把它写成"503 一律不带"；
> ② §16.7 那句「不新增错误码、不新增 HTTP 状态」**不冲突**，它管的是**出口被上游限流**
> （调用方仍在"退避后可重试"语义内 ⇒ 照旧 `429 RATE_LIMITED`），本码管的是**候选集合永久为空**（未绑 / 全部 `retired`；
> 预算耗尽与全部冷却走 429）—— 与 `NO_AVAILABLE_KEY` 同族、同一个判据形状。
> **§12.1 的 `category` 仍是 9 值**："出口选不出"与"key 选不出"是**同一个分诊对象**（候选为空、0 次真实尝试、查池子与配置），
> 精确值由 `gatewayCode` 承担；新增第 10 个分型要同时动契约枚举、`observability-params.ts` 的 9 分型、前端筛选器与两条断言，信息量为零。§13.5 助手的终止帧码值表同批补入。
> **v1.15.8 的 `MODEL_NOT_AUTHORIZED` 同样不新增第 10 个分型**：它归 **`AUTH_FAILED`**（403 / "凭据对了、人不对"，
> 与 `GROUP_DISABLED` 同一行）—— 授权是**组身份的属性**，不是调用方写错了请求。
> **码值落地笔**：`GATEWAY_ERROR_CODES` **10 → 11**。本条只登记**码值与触发条件**；`src/gateway/errors.ts` 的常量
> 与其长度断言（`src/api/balance-sync.spec.ts` 的两行：`ERROR_CODES` 16 / `GATEWAY_ERROR_CODES` 10）
> **必须与实现同笔落** —— 二者是"契约侧钉码表长度"的快照，漏改即红。
> **v1.15.8 落地笔**：`GATEWAY_ERROR_CODES` **11 → 12**（同一判据：`src/api/balance-sync.spec.ts`
> 的长度断言与 §10 本表、`src/wiring/error-event-sink.ts` 的分型映射**同笔落**）。
> **同笔订正一处既有漂移**：`NO_AVAILABLE_EGRESS`（v1.7.0 进表）从未登进
> `error-event-sink.ts` 的分型映射，503 事件一直被归成 `INTERNAL`（error 级）——
> 而本表上方"§12.1 的 category 仍是 9 值"那句的意图**本来就是**它与 `NO_AVAILABLE_KEY`
> 同一个分诊对象。本版把它补进 `NO_AVAILABLE_KEY` 分型并加用例钉住，**不静默改**（ADR-0037 决策 5）。
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
| `AUTH_FAILED` | `warn` | 401 / 403 | `INVALID_API_KEY` / `GROUP_DISABLED` / `MODEL_NOT_AUTHORIZED`（v1.15.8） | 网关 key 缺失/未知/已吊销（401），key 有效但用户组被禁用（403），或组不被授权用该模型（403，ADR-0037） |
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
- 保留期与 `usage_logs` 同口径（`LOG_RETENTION_DAYS`，默认 30 天）。**这条从 v1.1.0 起就是契约行，但实现侧直到 v1.14.1 才真正接上** —— `pruneGatewayErrorEvents` 一直存在且有 spec，生产环境里零调用方。补接时**没有**顺手改这条：真要给错误事件单独的保留期，走契约修订，不夹带在"补齐实现"里。

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

## 13. 内置 AI 助手聊天 `POST /api/assistant/chat`（v1.2.0；v1.10.0 增可选 `model`；v1.11.1 增 §13.6）

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
| `model` | string | ❌ | **本轮助手使用的站内模型名**（v1.10.0）。缺省 / 空串 = 装配侧 `ASSISTANT_MODEL`（零行为变更）。校验 = **站内已启用模型集合**（与 §5 `GET /api/models?enabled=true`、`/v1/models` 同一判据：`models.enabled=1` 且其上游 `upstreams.enabled=1`）；不在集合内 → `400 INVALID_PARAM`（`details.field="model"`，**不静默回落缺省** —— 解析层非法，非 §13.3 的 `truncated`） |
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

- **模型名的三级来源（v1.10.0）**：装配侧 `ASSISTANT_MODEL`（`.env`，缺省模型）→ 请求体可选 `model`（§13.1，**逐请求覆盖**）→ 端口 `stream(messages, signal, model?)` 第三参（**只增不改**，缺省=第三参缺省值）。实际生效值 = **请求显式指定且合法的 `model`，否则 `ASSISTANT_MODEL`**；`src/gateway/` 零改动（走既有 `chatCompletions({ model })` 入口），选择面 = 站内已启用模型集合（§5）。
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

### 13.6 助手页错误汇总面板（数据口径，v1.11.1）

本节登记助手页左栏那张**错误事件表**的数据口径。**本节不新增任何端点、字段、枚举；后端与网关零改动** —— 它是**前端消费口径**，落在契约里的理由是：面板与对话共用 §12 / §13 同一份数据面，口径必须只有一处事实源。动机与影响见 **`docs/adr/0025-assistant-error-summary-panel.md`**。

1. **面板数据源（唯一）** —— `GET /api/observability/errors`（§12.3），默认窗口与默认排序 `ts DESC, id DESC` 全部照该端点原样取；`from`/`to` 全省略时用的就是它既有的默认窗口（近 1h）。
   - 每一行 = 一个 `GatewayErrorEvent`（§12.1）。面板渲染哪几列属前端排布，**行内容不得加工**：既不得拼字段造出「新对象」，也不得截 `message` 来「省地方」——`summary`（截到 120 字符）这个动作只有 `citations` 有权做（§13.2）。
2. **计数条（顶部 9 分型）** —— 数据源 = §12.2 `events.byCategory`（按 `window` 归一，与仪表盘「错误分型」同源）。**不得**用面板那份分页响应现算计数：分页只覆盖第 1 页，计数是全窗口，「第 1 页 20 条里某类有 7 条」不等于「这一小时只有 7 条」。两个数不是同一口径，本节把这条差异写成硬规则。
3. **点行注入（受控口径）** —— 点一行 = 把该行能表达的条件写进**下一次**请求的 `logContext`，**字段名与取值域一字不改**：

   | 行里的东西 | 注入到哪 | 说明 |
   |---|---|---|
   | `category` | `logContext.category` | 行值是 §12.1 九分型之一，天然在枚举内 |
   | `severity` | `logContext.severity` | 单值 `warn` \| `error` |
   | `model` | `logContext.model` | 未过鉴权的行该列是 `null` → **不注入这个字段**（注入空串是第二回事） |
   | `requestId` | `logContext.requestId` | 关联键见 §6「关联键 `x-request-id`」；**事件 id 本身不是注入项** |
   | 面板生效窗口 | `logContext.from` / `logContext.to` | 取 §12.3 回显的 `range`，**前端不自算** |

   **禁止**把行文本（`message` / `gatewayCode` 文案 / key 掩码 / 拼接出来的「错误摘要句子」）塞进 `messages`。§13 纪律 3 是「只收 §12.3 结构化 DTO 过滤参数白名单，**不接受自由文本查询**」；自由文本注入等于绕过白名单，还顺手把「脱敏 + 抹名之后仍不得外传」的内容（§12.1 写入纪律）送进 prompt。
   - 取值非法（如 `category` 不在枚举）与手填过滤条件同一路径：**`400 INVALID_PARAM`**（`details.field` 指明），属解析层非法，**不是** §13.3 的 `truncated`（§13.1 既有纪律）。
4. **`citations` 不加默认快照（本次裁定 `no`）** —— §13.2 保持原语义：**本次回答注入了观测事件才有引用，`logContext` 省略 = 纯闲聊 = `[]`**。
   - 理由一（量级）：自动快照会**每轮**都注入观测事件，极易撞上 §13.3「50 条 × ≤24h」上限 ⇒ `done.truncated` 常年 `true` ⇒ 前端那个「上下文已被截断」提示失去区分力 —— 它存在的意义正是「这一轮真的被截了」。
   - 理由二（价值）：Bo 要的是**可复制的错误行**，该痛点已由第 1 条的面板解决；自动快照不新增任何一行可复制的内容。
   - 理由三（成本）：每轮注入 = 每轮多一段日志进 prompt = 每次会话都付钱去买用户自己已经看得见的数据。
   - 要改这个裁定走新 ADR，**不在本节顺手改**。
5. **全局视野的替代路径（不新增字段）** —— 要看「近 1h 错在哪几类」，点计数条即注入 `category` 多值（等价于手填 `logContext.category`）。计数条本身**不是** `logContext` 字段，它是导航控件。
6. **窗口一致性归渲染、不新增字段** —— 面板按 `from`/`to` 取数，计数条按 `window`（`60s` \| `5m` \| `1h`）取数，两者**允许不同窗口**。后端只负责回显（`range` 与 `window` 各回各的，§12.2 / §12.3 既有），前端渲染层负责让用户看得见当前是哪个窗口；契约**不**加字段把两者绑成一个。
7. **零代码变更登记** —— 后端（`src/api/`）、网关（`src/gateway/`）、库（`src/db/`）三侧本节**一行未改**。门禁同 v1.10.0：`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL、零迁移。责任方：前端（画师）落面板与点行注入；消费端点早已实现（活性实测 `200`），**无后端待办**。

---

## 14. 余额同步（v1.3.0）

本节是 **M6-C**：**不新增任何"钱"的口径**，只把 M6-A 已经做完的余额查询做成「自动、有历史、能看出漂移」。三条纪律贯穿全节：

1. **余额的唯一事实源 = 上游接口返回值**（模板 / preset 查得，或人手动录入）。本节**不做本地扣减、不引入单价、不派生"可用余额"** —— 两次查询之间余额一直在变，本地算出来的数必然在某些窗口里撒谎。
2. **查不到就是查不到**：不写 `0`、不估算、不用旧值刷新时间戳（14.2）。
3. **网关零改动**：本版在 `/v1/*` 请求路径上**零新增同步读写**（15 分钟一次的定时器 + 只读端点）。~~TTFB 判据不受影响~~ —— **后半句作废（v1.8.0 / ADR-0017 补遗 1）**：耦合不在 HTTP 耗时这一层，而在**出口 IP 请求预算**（比 HTTP 低一层）—— 自动同步与数据面**共用同一出口的请求预算**，同步能把数据面挤到 429 而 TTFB 看不见。**`src/gateway/` 零改动；`/v1/*` 请求路径零新增同步读写，但这不等于「与数据面无耦合」——TTFB 判据不再自动满足，须与出口预算共同验收（ADR-0021 §验证）。**

### 14.1 触发与节奏

| 触发 | 行为 |
|---|---|
| **自动同步**（本节新增） | 每上游独立节奏，基准间隔 **15 分钟**（`BALANCE_SYNC_MINUTES`，`0` = **关闭自动同步**）；每轮延迟在 **±10%** 内抖动 |
| **手动刷新**（既有，零变更） | `POST /api/upstreams/:id/balance/refresh`、`POST /api/keys/:id/balance/refresh`、`POST /api/keys/balance/refresh` 全部保留，语义 / 形状 / 状态码逐字不变 |

- **间隔只有一个来源、一个读面（v1.7.0 写死）**：来源 = **服务端环境变量 `BALANCE_SYNC_MINUTES`**（`0` = 关闭）；
  读面 = `GET /api/stats/balance/sync` 的 `auto.intervalMinutes` —— **只读回显**。
  **本版没有任何"改间隔"的写入口**：不发 `PUT/PATCH …/auto-sync`、请求体**不加**间隔字段、
  **不复用** `min_interval_minutes` 这类名字（**该名从未在本契约出现过，出现即是笔误**）。前端**不得自算间隔**／**不得把"改间隔"做成界面动作** ——
  生效参数（间隔 / 抖动 / 退避上限）一律取自 `auto` 回显。
- **退避**：同一上游**连续失败** n 次后，下一次自动尝试延后 `min(base × 2^n, 6h)`（15m → 30m → 1h → 2h → 4h → 6h 封顶）。
- **归零条件（v1.7.0 改写：从"任何一次拿到值"改为三条同时成立）**：

  | 判据 | 内容 |
  |---|---|
  | ① 有值 | `ok - unknown > 0` |
  | ② 成功比例达标 | `(ok - unknown) / (checked - skipped) ≥ 阈值` —— **分母排除 `skipped`**（没做的事不进分母） |
  | ③ 本轮无 429 | `rateLimited == 0` |

  - **阈值（占位 80%）不进本契约**：它是**实现常量**，PM 可后调；进契约的是**归零条件的形状**。
  - ③ **与比例无关、是独立一条**：429 是**出口挤压**的直接证据 —— **25 把成功 + 1 把 429 也退让一档**。
  - **`rateLimited` 含本地合成的 429**（ADR-0021 决策 4a 的标记头识别）：闸接线后出口预算耗尽由我们自己合成 429，
    **同样计入本判据**。这是**有意**的 —— 自拒绝与上游 429 都指向"这一轮额度不够"，退避该退就得退；
    且这样"永不退让"这条缺陷在闸接线的**当天**就消失，不必等标定。与 ADR-0021 决策 5 **不冲突**：
    那条管**冷却**只由上游证据推进，本条管**退避**（两者是不同的动作）。
  - 不满足归零条件而**确实发起了请求**（`checked - skipped > 0`）⇒ **推进退避**（沿用上面的 `min(base × 2^n, 6h)`，`n` = 连续计数）。
  - `checked - skipped == 0` ⇒ **`noop`**：不推进也不归零。
  - **手动刷新成功同样归零** —— 人已经证明能查通了，不该让他等 6 小时。
  - **一条判据、两条路径**：批量刷新与**自测**那条同步路径**共用同一个判据**（同一份 429 判定），
    否则会出现"刷新说限流、自测说不可达"的**自相矛盾诊断**。
  - **代价（明写）**：一批坏 key（例如 7 把已失效的 401）会把这个上游的自动同步拖慢到 30m / 1h ——
    而这些 key 的正确处置在 §15 的重登路径上、不在同步节奏上。这个代价是**故意付**的：
    相比之下，"用共用的出口预算给 7 把死 key 每 15 分钟烧一次"更贵，且它**同时烧掉数据面的额度**。
  - `rateLimited` **不需要新列**：`QueryExecution.httpStatus` 已有，现算即可；那个计数只穿过**内部**的收尾汇总类型，
    **不出 REST 面** ⇒ §14.2 的三型计数口径**零变更**。
- **推进退避的触发（v1.7.0 对齐）**：**不再是**"本轮 `failed > 0 且 ok == 0`"，而是**上面三条归零条件未同时成立、且 `checked - skipped > 0`**。
  旧口径在出口预算这条约束下是**结构性缺陷**：26 把里 6 把成功、20 把撞 429 也会被读作"健康"，`nextAttemptAt` 照 15 分钟排回去
  ⇒ **每 15 分钟准时再烧一次窗口，永不退让**；而实测已证出口预算**按 IP 聚合、放缓不减少被拒次数**
  ⇒「退让」是唯一有效动作，恰恰是旧口径做不到的那个。
  `skipped`（该上游没配查询方式）**不推进退避**（没做的事不该被罚）；`unknown`（请求成功但取不到值）**算不健康** —— 配置问题退到后面等人改，比每 15 分钟打一次上游强。
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
- **刷新任务 `result.retryAfterSeconds` 与本表无关（v1.8.1）**：它是任务 `result` 的解释字段（非破坏新增，见 §3），429 仍落在"不可达 / 超时 / 非 2xx"这一行的**处置**里 —— 一个字都不写；本表零改动。
- `balanceSource` 枚举**不变**（仍只有 `"manual"` / `"template"`）；`hintCode` **四值 → 五值**（v1.7.0，枚举新增，非破坏）—— 五值口径见 §2「失败引导字段」。
- **本表是"写库纪律"表，不是"触发条件"表**（v1.7.0 明写）：429（**上游的与本地合成的同属一类**）落在"不可达 / 超时 / 非 2xx"这一行的**处置**里 —— **一个字都不写**，
  **不要**给这一行加"429 除外"：那会把"失败不写库"这条纪律改坏。`hintCode` 的分行（429 单独一行）只影响 §2 那张**引导**表，与本表无关。

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
| `auto` | 自动同步的**生效参数回显**（前端不得自算间隔 / 抖动 / 退避）。`enabled=false` 时 `nextRunAt=null`。**`intervalMinutes` 是只读回显** —— 它的唯一来源是服务端环境变量 `BALANCE_SYNC_MINUTES`，**本版没有任何写入口**（§14.1） |
| `lastSyncedAt` / `lastTrigger` | 最近一次同步**完成**的时刻与触发方（`"auto"` \| `"manual"`）—— **任意触发都算** |
| `nextRunAt` | 自动同步下一次计划时刻（已含抖动）；关闭时为 `null` |
| `upstreams[]` | 每上游运行态：`consecutiveFailures`（退避用）、`nextAttemptAt`（退避中非空，否则 `null`）、`inFlight`。**v1.7.0 语义改述**：这两个字段描述的**不再是**"最近一轮有没有一把成功"（旧口径），而是**最近一轮的整体健康度** —— 即 §14.1 那三条归零条件**未同时成立**时为退避态。"有一个 429 就退让一档"是**有意**的，前端**不得**把 `consecutiveFailures > 0` 直接渲染成"上游挂了"（成因可能是出口挤压，见 §2 文案纪律） |
| `series[].points[]` | **该上游的快照点本身，自带 `t`**。`totalBalanceCents` 为 `null` = 那一刻全未知（**不是 0**） |
| `drift` | 窗口内的漂移提示（14.4）；`alerts` 按 `to` **倒序**，上限 20 条 |

- **`points[]` 为什么还要带 `unlimitedKeyCount`（v1.6.0 补）**：快照点的 `knownKeyCount` 是**推导值**，不是独立查出来的数 —— 它在代码里写作 `balanceKeyCount - unknownKeyCount - unlimitedKeyCount`。v1.4.0 把无限额度 key 从 `unknownKeyCount` 里摘出去之后，若这一格不落库，那个减法就**把无限额度 key 悄悄算成"已知"**：`known + unknown ≠ balanceKeyCount`，而**没有任何一格能解释少掉的这几把 key** —— 前端只会看到一个对不上的账，且它看起来完全正常。故此列随 §15.7 同批 `ALTER`（`INTEGER NOT NULL DEFAULT 0`），老快照填 `0`（加 §15 之前不可能有 unlimited key，正是它该有的值）。
- **与 §6 的 `axis` 口径刻意不同，本节没有等长 `axis`**：同步节奏本身是**不规则的**（抖动 + 退避 + 关闭期），要造一条均匀轴就得发明不存在的点。前端按 `points[].t` 画时间序列；**不补点、更不补 0**。
- **`asOf` 的两个层级别混**：key 级 = `balanceUpdatedAt`（该 key 最近一次真的查到）；上游级 = `series[].points[].t`。前端标注"数据新鲜度"用 **key 级**那个，趋势图用上游级。
- 该端点**只读**：不改任何状态、**不触发任何查询**（要查去点三个手动端点）。鉴权走登录会话（§0.5），**不用** `READONLY_TOKEN` —— 带只读令牌打进来 → `403 FORBIDDEN`（§12.4 的作用域仍只有 `GET /api/observability/*`）。

- **`knownKeyCount` 的语义（v1.7.0 成文）**：它是 **"余额当前有值的 key 数"** —— **含本轮没读到、沿用旧值的 key**；
  **不是**"本轮查到的 key 数"。`unknownKeyCount` 才是"**查了但没值**"（`balance_cents IS NULL`）。
  **部分冻结的一轮里这两个数会同时偏离直觉**（被 429 冻住的 key 沿用旧值 ⇒ 仍计入 `knownKeyCount`）⇒
  **前端不得用 `knownKeyCount` 的变化去推"这轮查到了几把"**（那个数在刷新任务的 `result.checked` / `ok` 里）。
- **明确不收窄 `usedTokens` 口径（v1.7.0 否掉一个备选）**：曾考虑把 `usedTokens` 改成"只算本轮真的查到的 key 的流量"。
  它看着更"对齐"，但会引入**第二个口径**：`usage_logs` 记的是"这把网关 key 被用过"，而一把余额查失败的 key
  **仍在转发流量** —— 把它从窗口流量里抠掉，等于让系统对"这条上游真的有人在用"**失明**，而
  `BALANCE_SPENT_WITHOUT_TRAFFIC`（"余额在掉、我们这边零流量 ⇒ 别处直连在用"）**正是靠全量流量成立**。
  **一个判据的两个输入各用一个口径，好过让两个判据共用一个错口径。**

### 14.4 漂移提示（非破坏，只提示）

**本地没有单价**：`usage_logs` 里只有 token，`balance` 里只有分，**两者没有可比量纲**。所以判据只用**方向 + 零 / 非零**，明确**不做量级比较、不判"对不对得上账"**。

| 码 | 触发（相邻两次快照 + 同窗口 token 用量） | 含义 |
|---|---|---|
| `BALANCE_SPENT_WITHOUT_TRAFFIC` | 余额**下降** > 0，而同窗口本网关 token 用量 = **0** | 同一把 key 可能被别处直连在用，或上游改了口径 |
| `BALANCE_UNCHANGED_WITH_TRAFFIC` | 余额**不变**（差额 = 0），而同窗口 token 用量 > 0 | 查得值可能是缓存 / 套餐口径，或查询端点已失效、一直在回陈旧值 |
| （余额上升） | — | **不告警**：充值 / 上游按周期重置都正常 |
| （任一端 `totalBalanceCents` 为 `null`） | — | **不判定**：未知与未知之间没有"差额"可言 |
| （**本轮有出口级限流**） | — | **不判定**（v1.7.0 前置条件，见下） |

- **前置条件（v1.7.0 加）**：本轮存在出口级限流（`rateLimited > 0`）时，上面两个码都**不判定**。
  理由与本表"任一端为 `null` 不判定"**同源**：那条差额里混着"**我们没读到**"的 key，拿它去下"读数不新鲜"的结论**必然误伤** ——
  **一个根本没查的 key 会被报成"余额没在动"**。**宁缺勿假**这条纪律本节已用三次（§14.2 不写 0、§14.3 单 key 不写快照、本条）。
  触发链说清楚：被 429 冻住的 key "一个字都不写"（§14.2 正确）⇒ 余额**停在旧值**，**但流量照样计进 `usedTokens`**
  ⇒ 得到"余额合计不变（大部分 key 没读到）+ 窗口内有流量" ⇒ **`BALANCE_UNCHANGED_WITH_TRAFFIC` 被我们自己的 429 点着**。
  **不新增列、不新增计数、零 DDL**：判据输入就是 §14.1 已经要算出来的那个 `rateLimited`。

- 出口只有两个：一条 `warn` 日志（只记**码 + upstreamId + 窗口**，不记 key 明文，ADR-0006 同纪律）+ 进程内计数 `balance_drift_total{code}`（经本节端点只读暴露）。**不进 `ERROR_CODES`、不影响任何 HTTP 状态、不拦请求、不改任何数**。
- 少于 2 条快照不做判定；阈值与灵敏度不进契约。

### 14.5 与既有口面的关系

- **`GET /api/stats/balance`（§6 余额三口径 / ADR-0003）零变更**：字段、形状、语义都不动。它答的是"现在有多少"，§14 答的是"这一路上怎么变的"。
- **`PUT /api/keys/:id/balance`（手动录入）与三个手动刷新端点零变更**（§2 / §3）。
- **`GET /api/stats/usage` 的 `costCents` 口径零变更**：仍是估算展示，本版**不把它升级成账**、不下线。
- **`src/gateway/` 零改动**：`key_runtime` 镜像、准入三条闸门（RPM / TPM / 日配额）都不动。本版**不新增任何事前拦截** —— 拿一个可能已经过期的查得值去拒请求，等于把估算误差变成用户可见的 `429`。~~TTFB 判据自动满足~~ —— **后半句作废（v1.8.0 / ADR-0017 补遗 1）**：**`src/gateway/` 零改动、`/v1/*` 请求路径零新增同步读写 —— 但这不等于「与数据面无耦合」**：自动同步与数据面**共用同一出口的请求预算**（§16.7 Tier 1.5），该预算是**隐性约束**、不体现在请求路径的耗时上。**故自动同步的间隔必须由出口预算标定决定**（标定前按最坏情况 = 出口地板取值，见 §15.5 重开门槛脚注与 ADR-0021 决策 8）；**TTFB 判据不再自动满足，须与出口预算共同验收。**

### 14.6 错误码、迁移与鉴权

**零新增枚举**：`ERROR_CODES` 与 `GATEWAY_ERROR_CODES` 长度不变（**指本版**；v1.7.0 在**出口面**新增的两枚码见 §10 / §0.4，**不是本节产物**）；两个漂移码是**提示码**（地位同 `hintCode`，不进 `ERROR_CODES`）。`window` 不可解析或超上限 → `400 INVALID_PARAM`（`details.field`）；`upstreamId` 查无此上游 → `200` + 该条为空（列表型过滤，不报 404）。`SCHEMA_VERSION` 不变（纯加表 + 纯进程内状态），**零迁移**。

### 14.7 手动刷新的"二次确认"（交互契约，v1.7.0 登记）

**为什么交互要写进契约**：一次手动刷新**不是一次请求** —— 它是一**批**上游请求（**一把 key 一次请求**；§15.5 按账号记账时一个账号 2 次），
而出口预算**与数据面共用**（§16.7 Tier 1.5 / ADR-0021）⇒ **这个按钮能挤掉客户端流量**，不是"多点一下没关系"的动作。

- **量级由服务端给，前端不得自造承诺**：一次"刷新整个上游"的请求数 = 该上游被查的 key 数（或账号数 ×2）。
  前端**不得**在按钮/弹窗上写一个自己算出来的数字（`§15.3` 的 `result` 才是权威计数）。
- **一次点击必须落到一个明确结论**：完成（`result` 计数 + `hintCode`）／部分被拒（`failed` 计数 + `hintCode=BALANCE_EGRESS_RATE_LIMITED`）／任务级失败。
  **"点了之后一直转圈"不可接受** —— 任务在后台跑（`202` + `GET /api/tasks/:id`），前端要**等到终态**。
- **二次确认的文案要说清代价**：会**真的打上游**、会**占出口预算**、可能**挤到数据面**。不写代价的"确认刷新？"不算二次确认。
- **被拒也是结果，不是坏态**：出口预算耗尽时任务**照常完成**，`failed` 计数**照记**（那是**任务结论**，不是 key 归因 —— key 健康计数不动，见 §16.7 终态形状），
  `hintCode` 落 `BALANCE_EGRESS_RATE_LIMITED`（§2 文案纪律：**不得**写成"出口被限流"）。
  **且不得把按钮置灰等 6 小时**：退避只约束**自动**同步，手动刷新**照常可发**（§14.1）。
- **同上游单飞**（§14.1）：上一轮未结束时本轮**跳过**（不排队、不堆积）⇒ 连点**不等于**多刷一遍，前端不必也不该去"排队"。

---

## 15. 供应商账号面（v1.4.0 / v1.4.1；v1.16.0 起服务在册的多家供应商）

本节服务**在册的账号型供应商**（`upstreams.supplier ∈ {"tierflow", "tokenrhythm"}`），是 Bo 指定的**个例**：
它解决"一个上游下有几十个账号、每个账号各有一套管理凭据"，**不**抽象成通用多供应商框架。
**本节已冻结**（2026-10-07，Bo 拍板）。原 `docs/契约草案-v1.4.0-供应商账号面.md` 已并入本节，草案文件不再存在。

> **〔v1.16.0：第二家 TokenRhythm 接入（ADR-0040）〕** 本节的正文（端点表、DTO、批量结果形状、
> 节奏、凭据纪律）**逐字适用于两家**，因为结构上两家共用一个驱动器协议（六个批量端点复用同一套
> 机制），差异**只在能力集** —— 能力集另立 **§15.14 能力表**，是"某家有没有某个概念"的唯一判据。
> 读本节时请把「TierFlow」读作「在册的账号型供应商」，凡是**只有 TierFlow 成立**的地方
> （套餐、key 额度、模型白名单、`quota_per_unit`）**都已在 §15.14 逐条标出**。

### 15.0 定位与边界

- **通用上游零变更**：`supplier` 为 `null` 的上游，§2 / §3 / §6 / §14 的端点、字段、口径逐字不变。
- **账号 ≠ key**：账号是**凭据容器**（账号 + 密码 + 会话 + uid），一个账号下有 N 把 sk- key 与
  M 个套餐。账号**不能**用 `/api/keys` 承载（那是网关的转发凭据）。
- **账号面是并列的顶层资源**（`/api/supplier-accounts`），不织进 `/api/keys`、`/api/upstreams` 的既有分支。
- **明文纪律同 ADR-0006**：账号密码与会话值**永不**出现在任何响应、日志、审计 detail、任务 result、
  错误信息里。出口只有账号掩码（手机号掩码 / 邮箱掩码，§15.1 `identifier` 行）。会话生命周期见 §15.9。

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
  "egressId": null,
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
| `subscriptions` | 数组（0..N） | 套餐摘要。**恒为数组**，无套餐为 `[]` —— 上游 `/api/subscription/self` 返回的是 `all_subscriptions: []`，单数对象表达不了它。**上游元素形状（v1.8.2 实测订正）**：每个元素都包一层 `{subscription:{…}, has_key, auto_renew}`，套餐字段在 `subscription` 内层，解析先解包再取字段（v1.8.2 前照外层读 `sub_no` → 全部读不到 → 整行静默丢弃，套餐表变空，无任何报错） |
| `credentialSource` | `"password"` \| `"session"` | 该账号**当前持有的凭据形态**。`password` = 库里有存档密码，**会话过期可自动重登**；`session` = 只有会话、无密码，**过期即不可自动恢复**（§15.9）。**由这一个字段回答"能不能自动重登"**，前端不自行推断 |
| `hasSession` | bool | 会话是否在手。**只回答有无**，会话值永不出后端。与 `credentialSource` **正交**：`credentialSource="password"` 且 `hasSession=false` 是合法态（密码在手、当前无有效会话，等下一次重登） |
| `sessionExpiresAt` | ISO8601 \| `null` | 会话到期时刻，供前端提示"需重登" |
| `egressId` | string \| `null` | **v1.13.0 新增，非破坏**。该账号绑定的出口（§16.7 Tier 2，`eg_` 前缀**不透明 id**，前端不得解析其内容）。**`null` = 未绑定，走宿主出口** —— 那是**配置事实**，不是"未知"、不是"不可用"（§16.7「`null` 的两种来源必须分开」）。**答的是"这个账号自己绑了谁"，不是"这个出口现在活着吗"** —— 池的在线 / 冷却 / 出口 IP 仍然只有 §7 帧一条读面（§7 三条硬约束不变）。写入口 = `PATCH /api/supplier-accounts/:id` |
| `revision` | int | 乐观锁，写请求带 `revision`，不符 → `409 REVISION_MISMATCH` |

**金额口径**：TierFlow 内部单位为 `quota`（`1 元 = 500000 quota`，换算基准 = `GET /api/user/self → data.quota_per_unit`）。**v1.8.2 实测订正**：该键在信封 `data` 层、**无 `config` 子层**（原文 `/api/status → config.quota_per_unit` 属手册 §1.4 同源错抄）。
**换算成"分"是后端的责任**，出口里**不出现 `quota` 原值**（唯一的例外是自测的 `parsed.quotaPerUnit`，
它是**比例**不是金额）。换算基准 `quota_per_unit` 每次查询时**从上游读**、不写死 ——
供应商改了换算比，我们的数不会跟着错。

**「不写死」管两个方向，读侧与写侧都要守**（v1.14.0 补成文）：读侧是 `quota → 分`
（`quotaToCents` / `mapSubscription`，一律收形参、无内部默认值可言）；**写侧是 `分 → quota`** ——
`createToken` 建固定额度 key 时发出去的 `remain_quota`。写侧一度是这条纪律**唯一的例外**
（写死 `DEFAULT_QUOTA_PER_UNIT` = 500000），站点把比值改成 250000 时，1000 分（10 元）的 key
会发 5 000 000 quota（= **20 元**）—— **多给一倍，且 HTTP 200、不报错、管理面每个可见信号都说"成了"**。
v1.14.0 起写侧同样走上游真值：比值由调用方给，建 key 腿**从库里读**（不为它多发一次请求，§15.5 那行不变），
读不到才落回文档默认值 —— 那是**诚实的缺省**（缺的就是"我们不知道这个站点的比值"）。
两列缓存的形状与四条写入腿见 ADR-0031 决策 2；**该两列不进本 DTO**（前端不换算，§「出口命名铁律」）。

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
| `POST` | `/api/supplier-accounts/import-sessions` | 粘贴 Cookie 导入（**仅 TokenRhythm**，v1.16.4） → `202 {taskId}` |
| `POST` | `/api/supplier-accounts/refresh` | 刷余额（quota + 套餐） → `202 {taskId}` |
| `POST` | `/api/supplier-accounts/:id/login` | 单账号重登 → `200 SupplierAccount` |
| `POST` | `/api/supplier-accounts/:id/test` | 连接自测（真实打一次） → `200 SupplierTestResult` |
| `POST` | `/api/supplier-accounts/keys` | 批量**新建** key 并入池 → `202 {taskId}` |
| `POST` | `/api/supplier-accounts/keys/sync` | 同步已有 key（掩码）+ 套餐 → `202 {taskId}` |
| `POST` | `/api/supplier-accounts/rotate-key` | 轮换 / 重置**套餐专属 key** → `202 {taskId}`（§15.13，v1.9.0） |
| `GET` | `/api/supplier-accounts/subscriptions?upstreamId=&page=&pageSize=` | 套餐列表 |
| `GET` | `/api/supplier-accounts/export?upstreamId=` | CSV 导出（**对账表，见下**） → `text/csv` |
| `PATCH` | `/api/supplier-accounts/:id` | 改账号（**本版只收 `egressId` + `revision`**，见下） → `200 SupplierAccount`（§16.7 Tier 2 / v1.13.0） |
| `DELETE` | `/api/supplier-accounts/:id?force=false` | 删除账号（见下） |

> **上表是两家共用的端点集**（v1.16.0；v1.16.4 增加 `import-sessions`）。**逐端点对第二家
> TokenRhythm 的差异**，判据全在 §15.14 能力表：① `keys` 拒收 `unlimited:false` / 非空
> `models`（`422`，**省略即合法**）；② `rotate-key` 整体 `422`（它没有套餐）；③ `subscriptions`
> 恒回空页（订阅腿零请求）；④ `import-sessions` 是 **TR 专属**（TierFlow 入口 `422`），
> 而 `import` 对 TR 入口 `422`（密码型专属）。其余端点**逐字同形** —— 请求体、响应形状、
> 任务模型、状态机一家一版是没有的。

#### `POST /api/supplier-accounts/import`

```json
{ "upstreamId": "up_7f3a", "text": "手机号,密码\n162****4225,********\n" }
```

- `text`：`手机号,密码` 行文本（粘贴或 CSV 文件名皆可）。容忍**表头行**、`+86` 前缀、空格/制表符/分号分隔。
  解析失败的行**跳过并逐行报原因**，不整批失败。
- 上游必须 `supplier` 是 §15 在册账号型（`"tierflow"` / `"tokenrhythm"`，§15.14），否则 `422 UNPROCESSABLE`。
  **v1.16.1 起 TokenRhythm 在此处入口 422**：这家只有会话鉴权、没有密码登录（§15.14.1），
  本端点的 `text` 管道对它**不适用** —— 不解析、不发请求。TR 入池走 §15.9 的离线一次性会话导入。
- TierFlow：解析失败的行**跳过并逐行报原因**，不整批失败；`maskIdentifier` 对掩不了的账号
  （纯字母用户名等）**拒绝该行并逐行报原因**，绝不存原文。
- 已存在的 `identifier` **不重复建行**，执行"重登 + 刷新"，`action: "relogin"` 在逐行结果里标明。
- **每号只试一次登录**（供应商风控），失败即记 `login_failed`。
- **本端点只收密码型凭据**（`text` 管道）。会话型凭据**不走 HTTP**，见 §15.9。
- 对已是 `credentialSource="session"` 的 `identifier` **补录密码**是本端点的正常用法（不是特例）：
  走"重登 + 刷新"，`action: "relogin"`，该行**就地升级**为 `credentialSource="password"`
  并从此纳入自动重登（§15.9）—— 不新建行、不改 `id`。
  **〔不适用于 TokenRhythm：这家没有密码登录，补录密码无处可登；它没有"升级为密码型"这条路。〕**

#### `POST /api/supplier-accounts/import-sessions`（v1.16.4，仅 TokenRhythm）

```json
{ "upstreamId": "up_7f3a", "text": "tr_session=xxxxx; Path=/\ntr_session=yyyyy; Path=/" }
```

- `text`：**每行一枚会话**。`tr_session=…; Path=/`、裸 value、带 `Cookie:` 前缀均可；
  空行与 `#` 注释跳过；首行可带 `cookie` / `session` 等表头。同一枚会话出现两次**保留第一行**
  并报一行（归 `skipped`），不会为重复行再打一次上游。
- 每行发**一次** `GET /api/me` 解析身份（`data.id` / `data.name` / `data.phoneMasked`，
  无手机号则 `emailMasked`）；判重键是**上游 uid**（`sha256('tokenrhythm:uid:<id>')`），
  写库时按 `uid → 掩码 → 摘要` 命中既有行，只覆写会话与权威信息（§15.9 v1.16.3）。
  `upstreams.base_url` 存的是网关根（`https://host/v1`），而 `/api/me` 在**站点根**：
  与驱动器一致，先剥掉末尾 `/v1` 再拼（否则会打成 `/v1/api/me`，上游 404 被误判成身份不可用）。
- 逐行结果复用 §15.3 `SupplierBatchResult`，`action="import"`。解析失败行 `code="LINE_PARSE_FAILED"`
  归 `skipped`；401 会话失效 `code="SESSION_EXPIRED"`、连不上 `code="UPSTREAM_UNREACHABLE"` 归 `failed`；
  403 **不是**会话过期（`code=null`，原因在 `message`，§15.14.2 钉子）。
- 入口闸：非 TokenRhythm 上游、或排除名单非空（名单按真值匹配，而这里只有掩码）→
  `422 UNPROCESSABLE`；空文本 / 只有表头注释 → `400 INVALID_PARAM`。全部**在任务创建前**拒绝。
- **这是唯一收会话明文的 `POST`**：值不写日志、不进审计 `detail`、不出现在任务 result 或错误
  `message`；落库即密文。风险取舍与边界见 §15.9 纪律 1（v1.16.4）。

#### `POST /api/supplier-accounts/refresh`

```json
{ "upstreamId": "up_7f3a", "ids": ["acc_3f21"] }
```

`ids` 省略 = 全部账号。会话失效**自动用存档密码重登**；**无存档密码的账号不重登**，
直接计 `failed` 并置 `status="session_expired"`（§15.9 有解释：只有会话、没有密码时无从重登）。
**TokenRhythm 账号全部落这一类**（这家没有密码登录，§15.14.1）：过期后请重新执行离线会话导入。
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

> **`unlimited` / `quotaCents` / `models` 三格是能力位，不是通用字段**（v1.16.0，§15.14.1）：
> 上表按 **TierFlow 口径**写。**没有这些概念的供应商**（TokenRhythm）在这三格上
> **拒收显式值** —— `unlimited:false` → `422 UNPROCESSABLE`、非空 `models` → `422 UNPROCESSABLE`；
> **省略**（默认 `unlimited:true`、无白名单）恰是它的**唯一合法形状**，原样放行。
> 判据是 §15.14 能力表，**不是**"这个电话是谁打的" —— 新增第三家供应商时按同一张表判。

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

> **〔v1.16.0〕没有套餐概念的供应商（§15.14.1）恒回空页**（`{items:[],total:0}`）：
> 端点仍 `200`、形状不变 —— 不是 `404`、不是 `422`。理由：**"这家没有套餐"不是一次失败**，
> 而"该上游下没有账号"才是（那种情形按 §15.4 走 `422`）。前端按能力位**根本不画这个页签**，
> 这个空页是给直接调 API 的人看的诚实答案。

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

#### `PATCH /api/supplier-accounts/:id`（v1.13.0，账号绑出口）

```json
{ "egressId": "eg_9f31c2a0b4d5", "revision": 3 }
```

| 字段 | 说明 |
|---|---|
| `egressId` | 目标出口 id（`eg_…`）。**`null` = 解绑、回宿主出口**（合法值，不是"清空成未知"）。省略字段 = 同 `null` |
| `revision` | **必填**（§0.2 乐观锁）。不符 ⇒ `409 REVISION_MISMATCH`，`details: {expected, actual}` |

- **响应**：`200 SupplierAccount`（改完的那一行，含新 `egressId` 与推进后的 `revision`）。
- **活性校验**：`egressId` 指向不存在或已 `retired` 的出口 ⇒ `400 INVALID_PARAM`（`details.field = "egressId"`）。
  **不提供 `force`**（同 §16.7 裁定 6 的取向）：绑一个退役出口只有"填错了"一种解释，
  而它让这个号**永远发不出去**，且不报错。`null` 不走这条校验 —— 宿主出口不是"一个出口条目"。
- **判据顺序**：活性校验 → 乐观锁 → 值未变短路。把乐观锁放前面，会让"填错出口"在并发场景下
  被报成 `REVISION_MISMATCH`（前端于是去刷新重试，而真因永远不显示）。
- **值未变 = 空操作**：`egressId` 与库里相同 ⇒ 直接回当前行，**不推 `revision`、不发 `change_log`**。
  连点两次同一个出口不该白推一次网关快照重建（重建会清 token-plan 的乐观扣减，代价见 §9）。
- **`change_log`（必需，不是可选）**：改这一列改的是网关快照里**每把 key 的出口归属**，
  而 `supplier_accounts` **不在** `SNAPSHOT_ENTITIES`（快照只认 `upstream` / `key` / `model` / `balance`）
  ⇒ 按**受影响的每把 `pooled_key_id`** 各发一条 `entity = "key"`、`op = "update"`。
  与写入**同一事务**：崩在中间会让"库里有、网关看不见"成为永久状态。
  **漏发的症状不是报错**：那批 key 的出口永远停在旧值，出口预算按 id 分桶 ⇒ 一根出口两个桶 ⇒ **放行量翻倍**。
- **审计**：`supplier.account.update`，`detail = "egress=<id>"` / `"egress=null"`。
- **不改的东西**：不改 `status` / `statusMessage`（那是"最近一次查询"的结论，改出口不是查询）、
  不碰任何凭据列、不动 key 台账、不动 `upstream_keys`（网关侧零改动）。

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
- **〔v1.16.0〕TokenRhythm 的 `parsed` / `raw` 形状**：`balanceCents` 来自
  `availableBalanceCny` 字符串换算（§15.14.2），`quotaPerUnit` 恒 `100`（**约定值不是上游真值**，
  诊断"换算比改没改"要看 TR 自己的信封而不是它），`subscriptionCount` 恒 `0`；
  `raw` 是 TR 信封两腿（`me` + `wallet/summary`）原样 —— 同样抹凭据、截断 8KB。

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

- `action`：`login` \| `relogin` \| `refresh` \| `create` \| `sync` \| `rotate` \| `import`。
  **每个值都必须有生产者**，不留"枚举里有、没人发"的空值：`login` = `import` 里**新建**的账号
  首次登录成功；`relogin` = 已有账号在 `import` / `refresh` / `keys` 中被重登；`refresh` = `refresh`；
  `create` = `keys`；`sync` = `keys/sync`；`rotate` = `rotate-key`（§15.13）；
  `import` = `import-sessions`（v1.16.4，只登记会话、**没有发生登录**）。
- `code`：供应商错误码原样（如 `LOGIN_INVALID_CREDENTIALS`）或本节错误码；`message` 一句人话。
- **逐行结果不含任何凭据**（`keyMasked` 是掩码，`keyId` / `tokenNo` 是内部标识）。
- 进度**只由真正干完的账号推进**（复用 `startTask` 的 `step()`），不做假进度条。
- **`skipped` 的口径（v1.6.3 补白，v1.6.5 从 §16.1.1.a 错挂处迁回本节）**：本节列了四个计数，
  而 **`skipped` 此前从未被定义过**。**`skipped` = 没做过的行**，落两处 —— 解析不了的行
  （`LINE_PARSE_FAILED`，§15.2 `import`「解析失败的行跳过并逐行报原因」）与命中排除名单的行
  （`EXCLUDED_IDENTIFIER`，§15.9）；**`failed` = 做过但不成的行**。于是
  **`ok + failed + skipped = total` 恒成立** —— 这是操作员唯一能拿来核对的等式，四个计数必须自洽。
  要点是**解析失败归 `skipped` 而不是 `failed`**：它确实"没做过"；两种读法都说得通，
  所以它必须是**一处**决定，不能两个端点各写一套。

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
**v1.13.0 补一句**：`PATCH /api/supplier-accounts/:id` 的三种失败也全落在上面这几枚 ——
出口不存在 / 已 `retired` ⇒ `400 INVALID_PARAM`（`details.field = 'egressId'`）、
`revision` 不符 ⇒ `409 REVISION_MISMATCH`、账号不存在 ⇒ `404 NOT_FOUND`。**本笔零新增码。**
`KEY_MASK_AMBIGUOUS`（§15.2）与 `LOGIN_INVALID_CREDENTIALS` 等供应商错误码**不进** `ERROR_CODES`，
只出现在 `items[].code` 与 `statusMessage` —— 它们是**上游的话**，不是我们的错误分类。

### 15.5 节奏与礼貌（不是性能问题，是能不能长期跑的问题）

| 项 | 值 | 依据 |
|---|---|---|
| 账号间间隔 | **0.6s**（当前实现值） | ~~工作台 29 号跑下来未触发限流~~ —— **依据已降级**（§16.7 Tier 1.5，v1.4.8 在本行收口）：该结论只在"单出口 + 当时那种请求密度"下成立，对**按 IP 计数**的限流**不成立**。Tier 1.5 落地后本行口径改为**「同一出口共用一条速率」**，值待实测标定。**v1.8.0（#6 重算）**：出口级速率由 **§16.7.3 Tier 1.5 令牌桶**取代 —— **0.6s 保留为账号级内层纪律，管不住出口**，一轮总时长按**出口级**公式算，见本节下方重算行与重开门槛 |
| 单账号请求数 | 刷新 = 2（`/api/user/self` + `/api/subscription/self`）；建 key = 2（创建 + 回查 `token_no`）—— **建 key 那格只对 TierFlow 成立，TokenRhythm = 1（§15.14.3）** | 少打一次是一次 |
| 建 key 的换算比取值 | **从库里读** `supplier_accounts.quota_per_unit`，**不为它多发一次 `/api/user/self`**（v1.14.0）—— **没有 `quota_per_unit` 概念的供应商（§15.14.1）不适用**，它的建 key 不消费比值（1 次请求、body 只有名字） | 那会是 3 次，破坏上一行。代价是比值**可能过期**；取舍见 ADR-0031 决策 3（「可能过期的真值」对「永远错的常量」） |
| 上游并发上限 | 复用 `REFRESH_CONCURRENCY` | 不新拍一个数，避免手动/自动漂成两个并发度 |
| 登录重试 | **每号一次**，不重试 | 避免触发账号锁定 |
| keyword 搜索 | 留空拉全量再本地过滤 | 供应商搜索不可靠（文档 §8.5） |
| 删除上游 key | 无尾斜杠路径 | 带斜杠 307（文档 §8.4） |

> **本表是 TierFlow 口径（v1.4.0 起）**。第二家 TokenRhythm 的**请求数差异只有一处**：
> **建 key = 1 次**（TierFlow 是 2 —— 上游 `POST /api/api-keys` 一次就回明文，没有"种子 + 回查"两步），
> 其余（`test` 2 / `refresh` 2 / `keys/sync` 3 —— 订阅腿零请求）**与 TierFlow 同数**，
> 账号间间隔、并发上限、登录每号一次这三条纪律两家通用。逐行对照见 **§15.14.3**。

~~27 个账号一轮刷新 ≈ 1 分钟~~ —— **v1.8.0 重算（#6，口径见 §16.7.3）**：一轮总时长 = **`ceil(总请求数 / 有效容量) × 窗口`**，**有效容量要扣掉数据面保留额** —— 占位值下（`capacity: 5` − `reserveForData: 1` = 4 枚/窗口）：**26 把 key 记账 = `ceil(52/4)×60s` ≈ 13 分钟；27 个账号记账 = `ceil(54/4)×60s` ≈ 14 分钟（本节取这条）**。恒定补桶速率 ≈10.4 分钟只是实现说明，**不进契约承诺**。**这些数全部是「单出口」口径**（本期部署形态：1 个出口 IP + 27 个账号 + 全部 key）；**出口 > 1 时逐出口各自成立，不得把多个出口的 token 加总去凑一轮总数**。0.6s 账号间隔**保留为账号级内层纪律**，出口级速率**由 Tier 1.5 取代**。故：**一律异步任务**，不阻塞 HTTP。

> **本节的 0.6s 不是出口级规则**（v1.4.8 收口）：它是**每账号**的礼貌间隔，**管不住出口** ——
> 27 个账号各自守 0.6s，出口侧照样可以超速。出口级速率见 **§16.7 Tier 1.5**（同一出口共用一条速率，
> 值为占位、待实测标定）。本节其余各行的**值全部不变**，被收回的只有上表那条**依据**。
>
> **v1.8.0 补（#6 脚注）：自动同步的重开门槛（ADR-0017 补遗 6，量化、可判定）** —— 15 分钟内管理面可用 token 数 **≥ 一轮全部请求数**（占位 = 27 账号 × 2 = **54 枚**），**且数据面满载时仍满足**。占位值下管理面 = `capacity − reserveForData` = **4 枚/窗口**（瞬时上限口径）⇒ 60 枚/15min ≥ 54 枚但**余量仅 6 枚（10%）**，按 26 把 key 记账余量 8 枚（15%）—— **两种记账都不够一整轮重试，且第二条不满足 ⇒ 占位值下不重开**（与 `BALANCE_SYNC_MINUTES=0` 的现行裁决一致）。恒定补桶 ≈10.4 min 是实现说明，**不得用来放宽本门槛**（门槛取瞬时上限）。容量回填到 20+/窗口后本门槛可满足，**只改数、不改代码**；门槛数随 `capacity` / `reserveForData` / 账号数三者一起重算，任一变化本结论即失效。标定输入必须从**承运那 26 把 key 的同一个出口 IP** 打（别的出口量的是另一个桶）。

### 15.6 与既有口面的关系（非破坏清单）

**`supplier` 怎么设**：`POST /api/upstreams` 与 `PATCH /api/upstreams/:id` 接受可选 `supplier`
（`null` \| `"tierflow"` \| `"tokenrhythm"`，默认 `null`；**v1.16.0 扩枚举**，ADR-0040），走既有的 `revision` + `change_log` 写入路径。

- **不另加 `accountPool: {enabled, provider}` 这类包装字段**：那会和 `supplier` 说同一件事，
  两个字段早晚漂成不一致。前端判据就是 **`supplier ∈ SUPPLIER_ACCOUNT_KINDS`**（§15.12 锚 1，
  v1.16.0 改口为集合成员判定）—— 一个事实一个字段。
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
  - **v1.13.0 补登一个动作**：`supplier.account.update`（`detail = "egress=<id>"` / `"egress=null"`）。
     就是 `PATCH /api/supplier-accounts/:id`；`detail` **只放绑定结果**，不含凭据（该路由也收不到凭据）。
     "谁把这个号挪到了哪个出口"是这条链上最该留痕的一类动作（取向同下一条 `export`）。
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
  该端点在供应商文档里自己标的是「未实测」，不能拿它当既成事实写进契约。 **（v1.9.0 前提已满足并落地）**：该端点上游已实测会下发明文，Bo 指示落地 —— 见 **§15.13**（ADR-0022）。**与本节"不进 `totalBalance` / 不进 §14 快照 / 不进网关准入判断"三条并行不悖**：那三条讲的是**套餐额度**的展示口径，本次动的是**凭据**的入池通路。

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
| **会话型**（冷备） | 操作员本地的一份**离线导出文件**（手机号 → uid / session / username / quota）；或**粘贴的 cookie 清单** | 离线一次性导入（`scripts/import-supplier-session.ts`）；**TokenRhythm** 另可走 `POST /api/supplier-accounts/import-sessions`（v1.16.4，粘贴），见下 | ❌ **无密码即无法重登** |

同一 `identifier` 两路都到过时，`credentialSource` 取 **`password`**（密码是超集能力：有密码就一定能登，
有会话不一定）—— 这是一个账号只有一行，两路输入**汇入同一行**，不建第二行。

**会话型导入的四条纪律**：

1. **凭据原则上不进 HTTP 面；v1.16.4 起有一处显式例外**：原则上不给 `/api/*` 开"提交会话值"的
   入口 —— 那个端点一旦存在，浏览器、代理日志、前端 `localStorage` 就都成了会话明文的过路点。
   **例外只有一个**：`POST /api/supplier-accounts/import-sessions`（**仅 TokenRhythm**，v1.16.4）
   接收**粘贴进页面的 cookie 文本**。这是业主（Bo）在确认成本后**显式接受的风险取舍**：
   原话是「感觉好麻烦，还是直接做到web吧，我这个人自用项目不会泄露的」「不是上传文件，只是粘贴
   cookie到输入框」。它换掉的是"30 个号逐个回终端跑脚本"，**不接受**的是把值留在任何可读面上 ——
   例外只到这一条端点：**不写日志、不进审计 `detail`、不回显**（响应 / 任务 result / 错误 message
   都只有掩码），落库即密文；前端提交后立刻 `resetFields()`，不写 `localStorage` / URL。
   除这条端点外，**离线一次性导入仍是唯一入口**；TierFlow 不开放任何会话值 HTTP 入口。
2. **不经 Agent / 不进本仓**：该文件的内容**不读入任何 AI 会话上下文、不进 git、不进日志、不进聊天记录**。
   仓库里只有"如何导入"的说明，没有值本身。
3. **入库后即视为该文件作废**：`session_cipher`（aes-256-gcm，`MASTER_KEY`）落库成功后，
   该文件即完成使命 —— 之后的余额同步只读库里那份密文。文件由操作员自行销毁。
4. **会话只服务管理面**：`session` / `TF-User` **绝不**写入 `upstream_keys`、**绝不**进入
   网关侧的 `SecretResolver`。网关只吃 `sk-` 明文 + `baseUrl`（§16）。

**已知代价（写在这里，不留给以后发现）**：**只有会话、没有密码的账号，会话一过期就回不来**。
`session_expires_at` 到期后 `refresh` 无法自动重登（无密码可登），该账号落 `status="session_expired"`，
需要操作员**再次执行一次性导入**（贴新会话）或**补录密码**（走 §15.2 `import`）。
〔**TokenRhythm：后半句不适用** —— 它没有密码登录，补录密码也无处可登，过期只能重新离线导入。〕
所以：对**有密码登录的供应商**，长期看**密码型凭据才是完整形态**，会话型导入是"先把今天的余额接进来"的过渡通路。
**这条不是缺陷，是取舍** —— 会话型入口的价值就在于不必先拿到 27 个密码。

> **〔v1.16.1：TokenRhythm 只有"会话型"这一种来源〕** 本节上面那套**双路径**（密码型为第一事实源、
> 会话型为冷备 / 加速通道）是 **TierFlow 的形状**，对 TokenRhythm **不成立**：TR 站点只有会话鉴权
> （Cookie `tr_session`），**没有可用的账号密码登录**（§15.14.1 / §15.14.2 事实 1）—— 因此
> `credentialSource` 对 TR **恒为 `session`**；「补录密码后走自动重登」这条升级路径**不存在**，
> 会话过期只能由操作员**重新执行一次离线导入**。`POST /api/supplier-accounts/import` 对 TR
> **入口直接 422**（不解析文本、不发请求）；TR 的入池通路是本节离线脚本，v1.16.4 起另加
> `POST /api/supplier-accounts/import-sessions`（同一条 cookie-only 解析链，见下一条）。
> 本节的纪律 2/3/4 对 TR 原样适用；**纪律 1 对 TR 的唯一例外就是 v1.16.4 那条端点**。
>
> 另有一条**写请求边界**：TR 的写失败有**两条路**，**401 `UNAUTHORIZED`** = 会话真过期，
> **403 `CSRF_INVALID`** = CSRF 头不合规（**凭据是无辜的**）。**403 绝不映射成 `session_expired`**
> —— 那会把一次本可自愈的 CSRF 失败报成"会话过期"，把操作员引去重新导入一枚本来还有效的会话。
> 详见 §15.14.2。
>
> **〔v1.16.2：批量导入 = 同一个脚本读一份本机文件〕** 多账号不需要新入口，只需要把"一个号一次"
> 换成"一份文件一次"：`SUPPLIER_SESSION_BATCH_FILE=/path/to/sessions.txt`（`-` = stdin）。
> 文件每行 `标识<分隔符>会话`，分隔符 **TAB / 逗号 / 空白** 任一；空行与 `#` 注释跳过；
> 首行可以是 `identifier,session` / `账号,cookie` 表头；会话一侧可以整段粘贴
> `tr_session=…; Path=/`，脚本只取 value。**同一账号出现两次保留第一行**并报一行；
> **单行失败不中断整批**（一份 30 个号的文件不该因为第 7 行少一格就只导入前 6 个）。
> 输出仍只给**掩码 + 行号 + 原因**，会话值与标识原文都不回显；落库仍是 `status="unknown"`，
> 导入后由一次 `refresh` 验活。四条纪律（不进 HTTP 面 / 不经 Agent 与本仓 / 入库即作废 / 只服务管理面）
> **对批量模式逐条适用** —— 批量只放大行数，不改变风险形状。
>
> **〔v1.16.3：只有 cookie、没有手机号/邮箱 —— 身份问上游，不要求操作员填标识〕**
> `SUPPLIER_SESSION_COOKIE_ONLY=1` + `SUPPLIER_SESSION_BATCH_FILE`：文件每行**只放一枚会话**
> （`tr_session=…; Path=/`、裸 value、带 `Cookie:` 前缀均可）。脚本对每行发**一次**
> `GET /api/me`（§15.14.2），取 `data.id` / `data.name` / `data.phoneMasked`（无手机号则
> `emailMasked`）用于判重与展示。**判重键是上游 uid**：`identifier_hash =
> sha256('tokenrhythm:uid:<id>')` —— 它**不是**手机号/邮箱真值的摘要，不能与密码型/真值型
> 账号的摘要互比；写库时按 `uid → 掩码 → 摘要` 顺序找既有行，所以"先按真值导入过、后按
> cookie 重导"仍汇入同一行，只覆写会话与权威信息，**不改**既有行的展示掩码/摘要。展示列落
> 上游返回的掩码；上游若回未掩码值，本地再掩，掩不出即拒绝该行（绝不落真值）。**这条通路会
> 打上游**（标识+会话模式仍是零上游请求），但值仍只从操作员本机文件读、仍只输出掩码、仍不
> 经过管理面 HTTP —— 四条纪律逐条不变。**排除名单非空时该通路整体拒绝**：名单按真值匹配，
> 只有掩码无法验证，静默放行等于把硬约束变成建议。**已知代价**：每行 1 次 GET（30 行 ≈ 30 次
> 串行请求）；`status` 仍落 `unknown`，由一次 `refresh` 转 `active`。
>
> **〔v1.16.4：同一解析链开了管理面粘贴入口（仅 TR）—— 业主显式风险接受〕**
> `POST /api/supplier-accounts/import-sessions` 的 `text` 每行一枚会话，服务端调用的仍是
> `importSupplierSessionCookies`（本节的 cookie-only 解析与落库逻辑**一行未复制**），所以
> 判重键、掩码纪律、逐行失败语义全部一致。该端点**只**为 TokenRhythm 开：TierFlow 入口 422，
> 因为它有密码通路，没有理由把会话值送进浏览器。**四条的现状**：纪律 1 有上述唯一例外；
> 纪律 2/3/4 **不变**（值不进聊天 / 不进日志 / 落库即作废 / 只服务管理面）。**排除名单非空时
> 入口 422**，与离线 cookie-only 模式同一理由。**边界**：这是"自用项目 + 已接受代理/浏览器
> 过路点"的取舍，不是"会话值可以随便放"——任何日志、审计、错误体里都不许出现它。

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
- **〔v1.16.1〕TokenRhythm 的上表两行与"升级路径"都不存在**：这家只有会话鉴权
  （§15.14.1），没有可用密码登录。它的账号**恒为 `credentialSource="session"`**，
  过期即落 `session_expired`，恢复方式只有**重新执行一次离线导入**；`import` / `:id/login`
  在入口 422，所以也不会出现"补录密码升级"这一步。

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

### 15.12 S3 消费锚（三处字段级事实，v1.7.0 登记）

**为什么单开一小节**：消费面读本节时**分三处**取事实，而这三处的判据**各自只写在正文的一个地方**。
本节**不复述口径**，只把**入口锚点**钉在一起 —— 免得后来者按派单文字**另发明一套判据**
（本契约反复踩过的坑：同一件事两处各说一套）。

| # | 事实 | 唯一判据 | 正文锚点 |
|---|---|---|---|
| 1 | 一个上游走不走**账号面** | **`upstream.supplier ∈ SUPPLIER_ACCOUNT_KINDS`**（集合成员判定，**v1.16.0 改口**；原判据是等值比较 `=== "tierflow"`）—— **不解析 `baseUrl` 猜**（"域名里带 tierflow"**不是**判据） | §2 `supplier` 行；§15.6 末段（**一个事实一个字段**）；§15.14 能力表 |
| 2 | 批量任务的**逐行明细** | **`result.items`** —— **终态才出现**，**上限 500 行**；超出保留**前 500 行** + `truncated: true` + `itemsTotal` 给**真实行数**；**本期不分页** | §15.3 |
| 3 | **账号对象形状** | **`SupplierAccount` DTO（§15.1 全字段）** —— **穷尽**（**v1.13.0 起这一格里多了 `egressId`**，见下注） | §15.1；§16.7 绑定纪律之三（**已按 v1.13.0 改口**） |

- **锚 1 在 v1.16.0 从等值改成集合成员**（理由，ADR-0040 决策 3）：等值比较的失败模式是**静默**的 ——
  接入第二家时不报错、也不 404，只是**新供应商在前端一个入口都没有**（按钮不出现、页签不出现）。
  改成 `supplier ∈ SUPPLIER_ACCOUNT_KINDS`（`hasSupplierAccountPanel()`）后，新供应商只要进了
  `§2` 的枚举就**自动**获得全部入口；**能力差异**（有没有套餐 / 有没有 key 额度）由 `§15.14` 能力表
  单独管，**不写进这条判据**。前端镜像表与服务端能力闸是**同一个事实的两份呈现**，锚点都指 §15.14。
- **三条全是读面，没有一条要前端自算**：`supplier` 是字段、`items` / `truncated` / `itemsTotal` 是服务端给的、DTO 是穷尽的。
- **出口状态没有 REST 读面**（§16.7 三条绑定纪律之三，**v1.13.0 起重新表述**）：**出口池的"状态"**
  （在线 / 冷却 / 出口 IP / 心跳）读面**只有 §7 帧**（`egress_cooldown` + v1.6.4 的池级 `egress_pool`）；
  而**"这个账号自己绑了哪个出口"**是 `supplier_accounts` 这一行的属性，自 v1.13.0 起**进 DTO**
  （`SupplierAccount.egressId`）。两者不是一件事：前者是**池的实时健康**，后者是**账号的配置**。
  **v1.13.0 改口的理由**：原来那条纪律的动机是"建表 ≠ 前端要处理它"（防的是**提前**造一个无数据的读面）；
  而写路径（`PATCH /api/supplier-accounts/:id`）一旦落地，缺读面就从"不做多余的事"变成"做了一半"——
  用户能点、点了看不见结果。**纪律的目的是不造没人用的字段，不是禁止字段存在。**

---

### 15.13 `POST /api/supplier-accounts/rotate-key` —— 套餐专属 key 轮换 / 重置（v1.9.0，ADR-0022）

> **〔v1.16.0：本节只对"有套餐概念的供应商"成立〕** 没有套餐的供应商（TokenRhythm，§15.14.1）
> **在端点入口直接回 `422 UNPROCESSABLE`，零上游请求** —— 套餐 key 这类东西在那边不存在，
> 走完全程只会得到一次无谓的上游往返。**端点路径与任务类型不变**（`supplier_rotate_key`），
> 差别只在入口闸；前端按 `SUPPLIER_CAPABILITIES[.].plans` 决定画不画那个按钮。

**为什么有这个端点**：TierFlow 的**套餐专属 key** 与 §4 的余额 key 是两类东西（手册 §5.5）——
每套餐**固定 1 把、不能新建 / 删除，只能重置**，且**重置响应直接下发新 key 明文**、旧 key 立即失效。
v1.4.0 冻结时该上游端点自标「未实测」，§15.8 第 8 问因此把"允许重置"挂成待定项；
Bo 的手册（§5.3）已把它标为**「✅ 实测」**，本次据 Bo 指示落地。

**请求**（`202 {taskId}`；任务类型 `supplier_rotate_key`，用 `GET /api/tasks/:id` 取终态）：

```json
{ "upstreamId": "up_7f3a", "ids": ["acc_3f21a9c1b704"], "subNo": "SB1261003742775" }
```

| 字段 | 说明 |
|---|---|
| `ids` | 目标账号；**省略 = 该上游全部账号**（与 §15.2 `refresh` 同口径 —— 会话过期的账号正是最该被重置的那个） |
| `subNo` | **可选**；省略 = 各目标账号**最新到期**的套餐（`end_at` 最大，`NULL` 排最后） |

**响应**：复用 §15.3 `SupplierBatchResult`；**`action` 枚举新增第 6 个值 `rotate`** ——
`rotate` = 正常重置；`relogin` = 该行在重置过程中被被动重登（§15.9）。逐行只回 `keyId` + `keyMasked`。

**语义（顺序即纪律，四条同时成立）**：

1. **先落库、后失效**。新 key 明文只在重置响应里出现**这一次** ⇒ 先把明文送进密文库
   （`upstream_keys`，`aes-256-gcm`）**成功之后**，才禁用被替换的旧 key。
   顺序反了就存在"旧 key 已废、新明文已丢、这个账号再没有可用套餐 key"的**不可恢复态**。
2. **`subNo` 省略取"最新到期"**（不是"最新更新"）：一个账号叠多个套餐时，正在生效的那个才是
   用户说"重置这个套餐的 key"时指的那个。名下**没有套餐记录** → 该行 `items[].code = "SUBSCRIPTION_NOT_FOUND"`。
3. **旧 key 只在掩码「精确相等且唯一」时被认领并禁用**，且**认领锚点是「重置前」的旧掩码** ——
   实现须在重置**之前**先查一次该套餐 key 的掩码（`GET /api/subscription/self/token?sub_no=`）
   并拍"重置前台账快照"。**实测（2026-10-12）**：上游重置换尾（同一把套餐 key 重置前后后 4 位不同，
   `…iHLd` → `…5w2l`），故**拿重置响应里的新掩码去台账找旧 key 永远落空**；旧掩码查询失败时本次
   **不自动禁用**旧 key（按"认领不到"处理）。命中 0 条（不在池内）或 >1 条（后 4 位撞号）
   一律**不动任何 key** —— 与 §15.2 `keys/sync` 的 `KEY_MASK_AMBIGUOUS` 同一条取向：
   宁可留一把**已失效**的旧 key，也不要把 A 账号的 key 禁到 B 账号头上。此时该行仍 `ok:true`
   （新 key 已入池），`message` 说明"旧 key 未自动禁用、请人工核对"。
4. **重置不改变账号 `status`**。§15.1 的 `status` 是"最近一次查询"的结论，重置不是查询：
   失败时只写 `statusMessage`（同 §15.2 `refresh` 的 `failurePatch` 取向），成功也不把它顶成 `active`。

**落库**：新 key 写入 `upstream_keys`，`category = "token-plan"`（池内**第一把**该类行，见 §15.8 第 6/8 问的本次修订），
`label` = `套餐-<plan_title>`，`enabled = 1`；**`token_plan_remaining` 落 `NULL`**（余量未知 ≠ 0，
由后续 `keys/sync` / 余额刷新回填 —— **v1.13.2 起该回填真实存在**：`GET /subscriptions` 每轮同步把
`basic_token_total - basic_token_used` 写回该账号已入池的套餐 key，见 v1.13.2 ② / ADR-0030 决策 2）；
**`unlimited` 不适用**（`token-plan` 行不落该列，§15.7）。
出站请求**只带 `sub_no`**；明文 key **永不**出现在响应 / 日志 / 审计 / 任务 result 里。

**错误面**：

| 情形 | 表现 |
|---|---|
| 未重置即失败（不可达 / 超时 / 401 重登后仍失败 / 上游 success:false） | `items[].ok=false`，`code` = 通用码（`UPSTREAM_UNREACHABLE` / `SESSION_EXPIRED` / 上游原码）；账号状态按 §15.2 `refresh` 同一条更新 |
| 上游 ok 但重置响应里**没有 key 明文** | `items[].ok=false`，`code = "KEY_PLAINTEXT_MISSING"`；**不落一把空 key**（此时旧 key 可能已被上游废掉，必须让人看见） |
| 该账号名下无套餐记录 | `items[].ok=false`，`code = "SUBSCRIPTION_NOT_FOUND"`（**不发上游重置**） |
| 该账号只有会话、无可用会话 | `items[].ok=false`，`code = "SESSION_EXPIRED"`（**不发上游**；重置是写操作，不在此顺手登一次） |
| 命中排除名单（§15.9） | 计 `skipped`，`code = "EXCLUDED_IDENTIFIER"`，**零上游请求** |

> `SUBSCRIPTION_NOT_FOUND` / `KEY_PLAINTEXT_MISSING` **不进 `ERROR_CODES`**（`items[].code`，同 §15.4
> 对 `LOGIN_INVALID_CREDENTIALS` / `KEY_MASK_AMBIGUOUS` 的处理）。鉴权同 §0.5 登录会话（不用 `READONLY_TOKEN`）；
> 审计 `action = "supplier.rotate-key"`，`detail` 只放计数（§15.7）。

---

### 15.14 能力表 —— 第二家账号面供应商 TokenRhythm（v1.16.0，ADR-0040）

**为什么单开一小节**：§15 其余各节的端点、字段、状态机**对两家完全同形**（同六个端点、同 DTO、
同任务模型），差异**只在"某家有没有某个概念"**。这一节是那个**唯一判据**：服务端能力闸、前端
`SUPPLIER_CAPABILITIES`、本契约的三处说法都锚在这里。**通用层不认识"是哪一家"**：它只问能力表。

**接入方式（ADR-0018 决策 0 的兑现）**：**加一个驱动器**，不是加一套框架。两家各一个文件
（`src/supplier/tierflow.ts` / `src/supplier/tokenrhythm.ts`），实现**同一个 `TierFlowClient` 协议**；
`clientFor()` 按 `upstreams.supplier` 选驱动器，**六个批量端点 + 被动重登 + 账号级节奏 + 逐行累加
一行不改**。通用层唯一改动是 `SUPPLIER_KINDS` 多一个值。`/api/*` **零新增、零删除端点**。

#### 15.14.1 能力表（"有没有这个概念"的唯一判据）

| 概念 | TierFlow | TokenRhythm | 表现 |
|---|---|---|---|
| **账号密码登录** | ✅ | ❌ | TR 站点**只有会话鉴权**（Cookie `tr_session`）。`POST /api/auth/login` 端点存在但**从不认证密码**（任何输入一律 401 `UNAUTHORIZED`，与过期同码同文案），真实登录是验证码流程，网关**不**代跑。⇒ TR **只能**走 §15.9 的离线一次性会话导入入池：`import` 与 `:id/login` **入口直接 422**，零上游请求；前端不提供会话值输入控件。只有 cookie 时用 `SUPPLIER_SESSION_COOKIE_ONLY=1`，逐行 `GET /api/me` 解析 uid / 掩码（§15.9） |
| 套餐（`subscriptions`） | ✅ | ❌ | TR 的 `subscriptions()` **不发请求**直接回 `[]`（订阅腿天然 no-op，**总请求预算不涨**）；前端不画套餐台账页签 / 不画套餐余额列 / 不画资金池两个套餐卡 |
| key 额度（`unlimited` / `quotaCents`） | ✅ | ❌ | TR 的 key **只有名字**，无额度概念；`tokens()` 一律按 `unlimited:true, remainQuota:null`（§15.7 无限额度落 SQL `NULL` 的既有口径）上报 |
| 模型白名单（`models`） | ✅ | ❌ | 同上，TR 全部 `models:null`；前端建 key 弹窗不画白名单字段 |
| 套餐 key 轮换（§15.13） | ✅ | ❌ | `rotate-key` 对 TR **端点入口直接 422**，零上游请求 |
| `quota_per_unit` | ✅ 上游真值 | ❌ | 落常量 `100`（1 元 = 100 分），只为"分"口径自洽 —— 建 key 不消费它，**不是**上游真值 |
| 账号钱包余额 | ✅ | ✅ | 两家都有，同为 §15.1 `balanceCents` 分口径、`currency: 'CNY'` |

**入口闸（服务端权威，前端镜像表只是"少画一个控件"）**：

- `POST …/keys`：`unlimited:false` → `422 UNPROCESSABLE`「TokenRhythm 的 key 没有额度概念，不支持
  unlimited=false / quotaCents（§15.14 能力表）」；非空 `models` → `422 UNPROCESSABLE`「TokenRhythm
  的 key 不支持模型白名单（models），请省略该字段（§15.14 能力表）」。
- `POST …/rotate-key`（TR 上游）→ `422 UNPROCESSABLE`「TokenRhythm 无套餐概念，不支持套餐 key
  轮换（§15.14 能力表）」。
- `POST …/import`（TR 上游）→ `422 UNPROCESSABLE`「TokenRhythm 只支持会话凭据（tr_session）……
  账号入池请走 §15.9 的一次性离线会话导入」；`POST …/:id/login`（TR 上游）→ **同样 422**
  （即使库里存着一枚看起来有效的会话）。两处都**不解析文本、不发上游请求、不写库**。
- `POST …/import-sessions`（v1.16.4）是 **TR 专属**：**TierFlow 上游入口 422**（它有密码通路）；
  TR 上游另受"排除名单非空 → 422"约束。拒绝发生在任务创建前，零上游请求。
- **默认路径零闸**：`parseKeySpec` 的默认值（`unlimited:true`、无白名单）恰是 TR 的**唯一合法形状**，
  原样放行 —— 闸只拦**显式指定**了不存在概念的请求。**空池**（该上游 0 账号）仍走 §15.2 的
  `422`「没有可处理的账号」，与能力无关。

#### 15.14.2 TokenRhythm 上游实测形状（12 轮探针，2026-10-18/19；与随附文档不符处以实测为准）

| # | 事实 | 文档说法 | 实测 |
|---|---|---|---|
| 1 | **登录方式** | **整篇没有登录端点**（文档从已持有 `tr_session` 开始） | **端点存在但不认证密码**：`POST /api/auth/login` 传 `{account,password}` 的任何取值都回 401 `UNAUTHORIZED`（与过期会话同码同文案），**从未观测到一次成功登录**；真实登录是验证码 / `login-or-register` 流程。⇒ **TR 只支持会话凭据**，入池只走 §15.9 离线导入（v1.16.1 订正：v1.16.0 把"能发通这个端点"误读成了"密码登录可用"） |
| 2 | **写请求 CSRF 生效条件** | 「`Origin` + `Referer` + `Sec-Fetch-Site` 三件套」 | **硬性只有 `Sec-Fetch-Site: same-origin`**（单变量 A/B：只有它 200，没有它必 403 `CSRF_INVALID`；`Origin` / `Referer` 顶替不了） |
| 3 | **CSRF token 一次性？** | 「每次请求后轮换，旧 token 立即失效」 | 确**轮换**但**非一次性**（复用最新一枚连发两次写均 200） |
| 4 | **余额来源** | **文档没有余额接口** | `GET /api/wallet/summary` → `data.availableBalanceCny`，8 位小数 **CNY 字符串**（`"23.66510789"`）⇒ `cnyToCents()`（只在驱动器这一处换算；解析不出有限数落 `null`，不猜） |

**三条硬纪律**：

1. **403 与 401 是两条路，403 绝不映射成 `session_expired`**。伪造会话 + 合法 csrf 回 403；
   真过期回 401 `UNAUTHORIZED`。把 403 当过期会把一次 CSRF 失败误报成"会话失效"，
   把操作员引去重新导入一枚本来还有效的会话。
2. **TR 没有"登录失败"这个状态可用**：唯一的鉴权事实是会话是否有效（401 = 失效）。驱动器
   `login()` 是**零请求的能力缺口**，直接回 `rejected`；`import` / `:id/login` 在入口 422。
   因此 TR 的账号状态只会落 **`session_expired`**（不会落 `login_failed`），恢复方式只有
   **重新执行一次离线会话导入** —— 不是缺陷，是这家站点没有密码通道的直接后果。
3. **信封 `{code,message,data,traceId}`，`code` 是数字 `0` 才算成功**（业务错误给字符串码
   `"UNAUTHORIZED"` / `"BAD_REQUEST"` / `"CSRF_INVALID"`）。

**其余实测钉子**：`GET /api/me` 的 `data` 含 `id`（UUID）、`name`、`phoneMasked`（`192****5609`）、
`emailMasked` —— cookie-only 导入用它解析身份（每行 1 次 GET，§15.9）；key 列表 `GET /api/api-keys`（**无分页，一页全量**）；建 key `POST /api/api-keys
{name}` = **1 次请求**（TierFlow 是 2 次），`data.key` 完整明文**只此一次**、`data.id` 是 **UUID**
（⇒ 池内 key 的 `token_plan` / 上游 id 列落 `null` 属预期，台账按**掩码**匹配）；掩码 `sk_tr_5o****6Us8C0`
的可见尾 4 与明文真值尾 4 **一致** ⇒ §15.2 `keys/sync` 的掩码对账判据与 TierFlow 同形；**停用的 key
仍在列表里**（删除的才消失）⇒ 台账以"上游还认的"为准；**key 数量上限是上游侧事实**（超限时上游按钮
置灰）—— 我们不预知上限，不本地造一个"剩余配额"数。

#### 15.14.3 请求节奏（§15.5 预算表增补）

| 动作 | TierFlow | TokenRhythm |
|---|---|---|
| `test` | 2 | 2（`/api/me` + `/api/wallet/summary`） |
| `refresh` | 2 | 2（同上两腿） |
| `keys/sync` | 3 | 3（self 两腿 + subscriptions[no-op **0 请求**] + tokens —— **总预算不破**） |
| `keys`（建 key / 每把） | 2 | **1** |
| `import` | 每号 1 次登录 | **0**（入口 422；这家没有密码登录可打） |
| `import-sessions`（v1.16.4） | —（TierFlow 入口 422） | 每枚会话 **1**（`GET /api/me` 解析身份） |
| `rotate-key` | 1 / 账号 | **0**（端点入口 422） |

**TR 的密码型导入不是"少打一次登录"，而是整条路不存在**：`POST /api/supplier-accounts/import`
对 TR **入口直接 422**（§15.14.1 入口闸），不解析 `text`、不发请求。入池通路是 **§15.9 的离线
一次性会话导入**（`scripts/import-supplier-session.ts`，操作员本机；多账号用
`SUPPLIER_SESSION_BATCH_FILE` 一份文件一次导入，见 §15.9 v1.16.2 条），以及 v1.16.4 的管理面
粘贴入口 `POST /api/supplier-accounts/import-sessions`（每枚会话 1 次 `GET /api/me`，上表最后一行）：
离线脚本复用与 HTTP 导入
同一套标识纪律 —— `normalizeIdentifier` 对纯数字走手机号路、邮箱走邮箱路，**其他形态**（纯字母
用户名）`maskIdentifier` 掩不了（手机号至少 7 位 / 邮箱要有域名）⇒ **拒绝写入**，
**绝不退化存原文**。导入结果落 `status="unknown"`（"已落库"不等于"验过活"），
之后由一次 `refresh`（2 次请求）把有效性确认成 `active` 或 `session_expired`。

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
> 真正把 P0 推过线的仍是**一次带 key 的成功往返**。
> **v1.6.5 补一句**：那一次**已经发生过**（记录锚 `5bb58a1`，见 **§16.1.2**）—— 本段上面「那一步只能由
> Bo 注入 `PROBE_KEY` / `PROBE_MODEL` 后跑」的对象已出现过一次；但它**是记录、不是复现**
> （探针不落盘 ⇒ 无第二份原始产物）。要把它从"记录在案"抬成"已复现"，仍只差**同一个动作再跑一次**
> （§16.6 执行链，key 不经任何人手）。本节三条纪律**一条不减**。

#### 16.1.1.b 管理面实测登记：手册对照线上逐端点验证（锚 `a2ed7c2`，2026-10-12）

路由者按 Bo 的《TierFlow 接口调用手册》逐端点对线上**真实请求**验证（只读 GET、复用封存会话、
PROBE 预算 9 次出网、凭据零落地）。抓到三处**静默**偏差 + 一处手册错，代码已随 `a2ed7c2` 修：

| # | 端点 | 实测事实 | 原实现 | 后果 |
|---|---|---|---|---|
| 1 | `GET /api/subscription/self` | 元素包一层 `{subscription:{…}, has_key, auto_renew}` | 外层读 `sub_no` → 全读不到 | 套餐行整体静默丢弃 |
| 2 | 同上 | 时间键 `start_time` / `end_time`（epoch 秒） | 读 `start_at` / `end_at` | 到期时间恒 `null` |
| 3 | `GET /api/token/search` | 默认 `page_size=10` | 只发 `keyword=` 不带分页 | key 超 10 把静默截断 |
| 4 | 换算比 | `data.quota_per_unit=500000`，无 `config` 层 | 先读 `config.` 再回退 | 靠回退蒙对；手册 §1.4 本身写错 |

对得上的（实测确认无需改）：登录体 `identifier`、Cookie `session` + 请求头 `TF-User`（缺 TF-User 实测 401）、
`DELETE /api/token/{token_no}` 无尾斜杠、掩码后 4 位匹配、建 key 回查 `token_no`。
证据留档（不进仓）：`.ekko-tmp/doc-verify/report-doc-audit.md`。契约正文随 v1.8.2 订正（§15.1 两处 + 本节登记）。

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

#### 16.1.2 实测登记：数据面两问的**带 key 记录**（锚 `5bb58a1`，2026-10-07）

**记录在案**：`dev/gateway-rotation` 的车道 tip **`5bb58a1`**（`origin` 可达；提交时间
**`2026-10-07 11:16:45 +0800`**）把一次**带真 key 探测**的结论写回了探针脚本头部
（`scripts/probe-tierflow-datapath.ts:37–51`）。逐条落进 §16.1 判据表：

| §16.1 判据 | 记录值 | 落位 |
|---|---|---|
| 存在 OpenAI 兼容 relay | `GET /v1/models` → **200**，体 `{data:[{id,object:"model",created,owned_by:"custom",…}]}`，**7 个模型** | ✅ **成立** |
| 只有自有协议 | 该 host 错误面是 OpenAI 信封，且 `/v1/models` 确有实现（§16.1.1.a 已独立复跑） | ❌ **排除** |
| `classifyUpstreamStatus` 纯状态码驱动 | 错误**一律非 2xx**：`401 code:""` / `403 routing_override_forbidden` / `404 model_not_found` / `429 rate_limit_exceeded`；`looksLikeFailureBody` **从未命中** | ✅ **成立** ⇒ §16.2 的 200+`success:false` 改判**不需要做** |
| P4 零余额 key | **401 `Invalid token`**（`code` 为空），与「token 不存在」**同形状** | ✅ 现判 `AUTH_INVALID` → 计失败 + 冷却**正确，`classify` 零改动** |
| P3 错误体时序（`stream:true`） | 错误体**在首包之前**到（404 普通 JSON、`sse:false`） | ⇒ pre-first-chunk 改判**技术做得到**；**是否改判归 §16.2 / 路由者，本节不做该决定** |

**证据强度（本节最要紧的一格 —— 别读成"已复现"）**

- **形状轴（无凭据即可复跑）= 复现过的**：路径存在性、401/403 分岔由「请求头里有没有 `Authorization`」决定、
  错误信封形状 —— §16.1.1.a 两轮 + 本轮 `PROBE_ONLY=P0a,P0b,P1` 分片复跑，共三次独立观测。
- **成功体轴（带 key）= 单点记录，未复现**：`200 + 7 个模型` / TTFB / SSE 帧形状来自上面那一份记录。
  探针按设计**只打 stdout、不落盘**（脚本 `:23`）⇒ 它**没有第二份原始产物**可与记录交叉核。
  ⇒ 状态只写 **「记录在案、可复核」**，**不写「已复现」**。
  抬成复现的成本 = **一次** `PROBE_KEY=… PROBE_MODEL=… pnpm probe:tierflow`（1–2 次请求，在出口预算内），
  由持有人在**本地** export 后跑（§16.6 执行链）—— **key 仍不经任何人手、不进本群**。
- **时间戳错位（为什么全屋先前读成"零输出"）**：§16.7 的 v1.6.2 登记落在 `5af638d`（**10:44**），
  这条记录落在 `5bb58a1`（**11:16**）—— **契约早了 32 分钟**，此后**没有任何一笔更新过 §16.1.1.a / §16.5**，
  于是「未实测 / P0 的另一半仍未做」被当成现状流转了若干轮。**"台账里没有"不等于"没发生"** ——
  **缺省不是证据**（§16.7 决策 10 同款），这条对**契约作者**同样成立。
- **同一份记录里的项目级约束**：出口 IP 次数预算 **~5–6 请求/窗口**，**成功请求同样计入、与账号/key 无关**
  —— 与 §16.7「≈8 次触发」同族，**不扩容吞吐**。
- **纪律照旧、一条不减**：本节**不据此改 `classify`、不据此动 §16.2、不据此新增或变更任何 DTO / 字段**。
  它改的只有**状态**（未实测 → 记录在案）与 §16.5 / §16.6 两处的状态行。

> **同处一处错挂的迁移（v1.6.5）**：本位置此前挂着 **v1.6.3「账号面 Tier B 落地」整段补白**
> （§15.2 六端点接线 / §15.3 `skipped` 口径 / §15.7 两审计动作 / 台账事务修复）—— 那是 **§15 的内容
> 挂在 §16.1.1.a 底下**：按节号到 §15.3 找 `skipped` 定义**找不到**（正文只有示例 JSON 里的计数），
> 而文末索引已宣称"已成文"。v1.6.5 把 `skipped` 口径**迁回 §15.3**（§15.7 两个审计动作本来就已落在
> `:2018–2019`），此处只留这条指针。**同类形状（"索引说已落、正文找不到"）本契约已犯三次** ——
> v1.4.3 变更块漏写、v1.4.7 的 §16.5 残留、本次 v1.6.4 同号撞车。记在这里当反面清单，
> 免得下一版又靠"索引里写着"当验收依据。

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
| **数据面路径与协议**（`/v1/*` 还是自有协议） | §16.1 + §16.1.1 + **§16.1.2** | ✅ **记录已到（v1.6.5）**：`5bb58a1` 的带 key 记录把 §16.1 判据表收口为「**存在 OpenAI 兼容 relay** / **只有自有协议**已排除」。**实测值与 §16.6 的默认假设逐字相同 ⇒ S1 零改动**（不加 DTO 字段、不写 `classify` 改判）。**带 key 半是单点记录、不是复现**（§16.1.2「证据强度」），复核 = 持有人本地再跑一次 |
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

> **v1.6.5 状态（三项占位值的钉死条件）**：第 1、2 两项的钉死条件是「P0 报告」—— **该条件已满足**
> （记录锚见 §16.1.2）。但**"钉死"在本案里等于"不改任何实现"**：两项的**实测值与上表的占位值逐字相同**
> ⇒ `baseUrl` 仍 `https://tierflow.cn`、数据面仍走 **OpenAI 兼容默认路径**、`classify` **仍不做**
> 200+`success:false` 改判、该字段**仍不进 DTO**。故本次**不产生任何代码义务**；
> 变化只在状态（占位 → 有实测记录支撑）。第 3 项原本就"不等实测"。**上方兜底条款继续有效**
>（v1.8.0 S4 二次实测登记，锚 = PM S4 探针 run，2026-10-09）：带 key 的**流式成功往返**已发生 —— HTTP 200 `text/event-stream`、**TTFB ≈ 436ms（首 chunk）**、17 个 `data:` 帧 + `[DONE]`、15 个 `delta.content` 帧；非流式 HTTP 200、811ms、`finish_reason=stop`、usage 正常回显。**行为发现：请求发的是别名 `tierflow_pro`，响应 `model` 字段实测回 `qwen3.8-flash` —— 上游会把别名改写成底层真实模型名回发**；网关透传 / 展示面要吃下这个差异，本登记**不据此改 DTO、不据此改 `classify`**（`model` 字段语义 = 回显上游响应原值）。本次实测与 v1.6.5 的钉死判定**同向**，仍不产生代码义务。探针 key 用后即删、0 遗留；排除号全程未参与。
> （它管的是"没有报告"的情形，也管"记录被复核推翻"的情形）。

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
`egress_proxies`（`id` / `name`（唯一）/ `url`（只放 `scheme://host:port`，**不含 `user:pass`**；**归一化后唯一**）/
`secret`（aes-256-gcm 密文 BLOB，与 `upstream_keys.secret` 同一形状；**明文永不落盘**；`null` = 免认证）/
`region` / `note` / **`status`**（`'active'` \| `'retired'`，缺省 `'active'`）/ **`retired_reason`**（`'replaced'` \| `'manual'`）/
**`retired_at`** / `created_at` / `updated_at`）与 `supplier_accounts.egress_id`（**可空**，缺省 `null` = 用宿主出口）。
**列清单以 v1.7.0 为准**（`enabled` 那一个回归列已换成单轴 `status`）：建表语句**逐字替换**、**表未发布 ⇒ 零迁移**、`SCHEMA_VERSION` 仍为 2。
**纯加表 + 加列，非破坏。** 三条绑定纪律（v1.4.8 写死）：

- **绑定粒度 = 账号级（`supplier_accounts.egress_id`），不是 key 级。** 27 个账号本来就是 27 个
  风控指纹，拆到账号才有意义；key 挂在账号下自然继承，**不为它加列**。
- **每出口账号数上限 = 6（占位）**：等 A/B/C 标定报告到手按实测回填。**回填改的是这个数，不是结构。**
- **`egress_id` 不进任何 DTO**（`SupplierAccount` 不加字段、§14 端点不加字段）：出口状态的读面**只有 §7**
  （`egress_cooldown` 帧 + v1.6.4 登记的池级 `egress_pool` 帧），**没有 REST 读面**。
  **建表 ≠ 前端要处理它** —— 前者是存储预留，后者才是行为变更。
  > **v1.13.0 改口（本节纪律之三的适用范围收窄）**：以上管的是**出口池的状态**（在线 / 冷却 / 出口 IP）——
  > 那一条**完全不变**，仍然只有 §7 帧。**账号自己绑了哪个出口**是另一件事（`supplier_accounts` 的配置列），
  > 自 v1.13.0 起进 `SupplierAccount.egressId`（§15.1），写入口 = `PATCH /api/supplier-accounts/:id`（§15.2）。
  > 改口的理由与边界见 §15.12 注。

**v1.7.0 裁定：出口的生命周期 —— 状态单轴、`url` 唯一、池空是显式终态**（ADR-0021 决策 9，Bo 2026-10-07 拍）

触发是 Bo 那句「**已经占用的出口肯定不再使用了啊，换其他的出口**」。它把生命周期说清了：
**换 IP 是旧出口报废，不是同一个出口改了地址** —— 于是"改 IP 顺手清桶 = 合法重置"这条反驳自动消解。

1. **状态是单轴，不是 `enabled` + 退役位两列。** `enabled` 与 `retired` 能组合出"启用且已退役"这种
   矛盾态，而选择器要滤**两处** ⇒ 漏一处就是一个**静默选错的出口**。表**未发布、零数据** ⇒ 改列此刻零成本。
2. **`retired` 不删行。** 删了它，历史用量、统计、§7 帧就**失去了宿主** —— `egressId` 必须**比 IP 活得久**。
   退役只让它退出候选，`retired_reason ∈ {'replaced','manual'}` 且**必填**（DDL `CHECK` 拦）：
   一行没有原因的 `retired`，半年后没人能判断它能不能删。
3. **`url` 唯一（归一化后）。** 两个洞：同一个 `scheme://host:port` 两行 = 两个 `egressId` = **两个桶** = 放行量翻倍；
   而**退役后重建一个同 URL 的出口** ⇒ 新 `egressId` ⇒ **桶是满的** —— 等于"改个名字白拿一次额度"，
   这条路径恰好由本次"旧出口报废、换新出口"这个**正常操作**触发。
   ⇒ **回池只有一条路：复用原 `egressId` 改回 `active`**，不新建行。归一化必须复用 `src/egress/egressIdOfUrl`
   那一份，否则 `UNIQUE` 拦不住 `HTTPS://A.EXAMPLE:443` 与 `https://a.example` 是同一个出口。
4. **自动摘除不落库。** 「心跳 30s / 连续 3 次失败摘除 / 回池滞回 5min」是**瞬时健康态**，读面是 §7 池级帧。
   写进 `status` 的后果有三条：重启后不回来、回池滞回无处存活、与 §7 的字段合成**第二套健康语义**
   （**读面合并 ≠ 状态机合并**）⇒ **库里的 `retired` 只表达人工报废这一件事**；"节点活不活"永远不进表。
   连带：**读面合并后 `§7` 只出一份帧**，该出口对外可见的 `until` = 池健康与上游冷却**较晚的那个**；
   而**写面各自独立、互不清零**（节点回池不得清零上游冷却阶梯 —— 否则一次 VPS 重启就把"上游确实在限我们"的证据洗掉）。
5. **池空是显式终态，不回落宿主直连 —— 但"永远选不出"与"现在用不了"是两枚不同的码。** 先分**能不能等**：
   - **只能去改配置（等待无效）⇒ `503 NO_AVAILABLE_EGRESS`**（`GATEWAY_ERROR_CODES` **10 → 11**）。
     **不带 `Retry-After`**：给一个 `Retry-After` 是假承诺，还会把"该去改配置"误导成"等一会儿就好"。
     **不得**静默回落宿主出口 —— 回落破"独享"前提与上游 IP 白名单，而且**没有人看得见**，是"静默故障"的教科书形状。
   - **等一会儿就能用 ⇒ `429 RATE_LIMITED` + `Retry-After`，不进 503**：成因是**预算耗尽**与**绑定的出口全部在冷却**。
     这两者都不是"池子坏了"：出口**存在**、也曾经可用，缺的只是"**现在**"；而 `503 server_error` 这个分型
     对"几秒 / 几分钟后就能重试"的场景本身就是**错的语义**。`Retry-After` 取**确定性恢复时刻**（见 §10 补注）。
   - **终态形状与本地拒绝同款**：这两条路径都**没敲过上游** ⇒ `attempts` 恒 **0**、**不写 key 失败行**、
     客户端拿到的是 `429` **不是** `502`。
   - **一条实现约束（选择器侧）**：**只滤冷却，不滤预算**。预算留到**选中之后那一次** `reserve()` 处置 ——
     `cooldownUntil(egressId)` 是现成的只读值，滤它零副作用；而 `reserve()` **不得**当探针用（它有副作用：
     扣掉一枚 token，且这次预留**无人认领**）。**本轮不做只读探针**（那是新增端口方法、属跨车道形状）。
   - 码名**不叫** `EGRESS_POOL_EXHAUSTED`：码值描述"选不出出口"这个**事实**，不描述**归因**（谁限的、谁的责任）。
   - `egress_id IS NULL` 的账号**照常走宿主出口**：那是**配置事实**，不是回落（§16.7 上文"`null` 的两种来源必须分开"）。
6. **退役被引用 ⇒ 拦下，且没有 `force`。** 管理面新增 **`409 EGRESS_HAS_ACCOUNTS`**
   （`ERROR_CODES` **16 → 17**，`details: {accountCount}`，见 §0.4）。**这条不提供 `force`** —— `force` 在这里
   只能表达"把这些账号丢回宿主出口"，而那正是第 5 条禁止的静默回落；迁移必须走**显式动作**
   （把账号 `egressId` 改到另一个 `active` 出口）。同族：`UPSTREAM_HAS_KEYS` / `ACCOUNT_HAS_KEYS`（"删之前先把依赖摆出来"）。
   **账号侧对称一条**：`POST/PATCH /api/supplier-accounts` 传**不存在或已 `retired`** 的 `egressId` ⇒
   `400 INVALID_PARAM`（`details.field = 'egressId'`），不留"绑上去了但永远发不出去"的账号。
   **v1.13.0 已落地**：建账号走批量 `import`（非 REST 建行），故这支判据落在
   **`PATCH /api/supplier-accounts/:id`**（§15.2，唯一写入口）上 —— 见 ADR-0029。

**两条落笔边界**：① 本裁定**只登记列清单与生命周期口径** —— 出口池的 REST 端点（资源根 `/api/egress`，
**已被 `deploy/vps-egress/README.md` 与 `pool-probe.sh` 引用为"事实源"**，README 台账里写明"S2 落 `/api/egress` 时同批改"）
的**具体子路径与 DTO 随实现同批登记**，本节不先造字段名；② 第 5 / 6 条产出的两枚码
（`NO_AVAILABLE_EGRESS` / `EGRESS_HAS_ACCOUNTS`）的**常量落地与两行长度断言**同理随实现同笔（见 §10 补注）。

### 16.7.2 出口池 REST 配置面 `/api/egress`（v1.7.1；ADR-0021 决策 9 落笔边界 ① 的实现同批登记）

> 本小节是 §16.7「Tier 2 的 DDL 已落」里登记的 REST 面（资源根 `/api/egress`，实现为
> `src/api/routes/egress.ts` + `src/db/repo/egress.ts`）。上面 1–6 条是**存储与生命周期**的口径；
> 本小节是**管理面读写**的口径，两者同批落地、同一份事实源（`egress_proxies` 表）。
> 鉴权 / CSRF / 审计走 §1 与 §0.4 既有口径：会话或 `ADMIN_TOKEN`；**写方法必须带 `X-Requested-With`**
> （缺 → `403 CSRF_REJECTED`）；审计动作 `egress.create` / `egress.update` / `egress.retire` / `egress.reactivate`
>（`targetType: 'egress'`，`detail` 只放 reason 等标志，不放凭据）。

**Upstream 之外的第 10 类资源对象 `EgressProxy`（全字段）：**

```json
{
  "id": "eg_9f2c",
  "name": "hk-1",
  "url": "https://proxy.example:8443",
  "region": "hk",
  "note": "primary",
  "status": "active",
  "retiredReason": null,
  "retiredAt": null,
  "authSet": false,
  "lastTestAt": null,
  "lastTestOk": null,
  "createdAt": "2026-10-09T00:00:00.000Z",
  "updatedAt": "2026-10-09T00:00:00.000Z"
}
```

| 字段 | 类型 | 可空 | 说明 |
|---|---|---|---|
| `id` | string | ❌ | `eg_` 前缀，不透明；**退役不删行** ⇒ `egressId` 比 IP 活得久（本节裁定 2） |
| `name` | string | ❌ | 唯一。同名冲突 → `409 CONFLICT`（`details.field = 'name'`） |
| `url` | string | ❌ | 只放 `scheme://host:port`，**归一化后唯一**；归一化复用 `src/egress` 的同一份（`egressIdOfUrl`），`HTTPS://A.EXAMPLE:443` 与 `https://a.example` 判同一出口 |
| `region` / `note` | string | ✅ | 备注字段，自由文本 |
| `status` | `"active" \| "retired"` | ❌ | **单轴**（本节裁定 1）。只滤 active，不存在"启用且已退役"组合态 |
| `retiredReason` | `"replaced" \| "manual"` | ✅ | 退役**必带原因**（DDL `CHECK` 拦）；回池不清 |
| `retiredAt` | ISO8601 | ✅ | 退役即写；回池不清（历史可读性，裁定 2） |
| `authSet` | boolean | ❌ | **推导值**：凭据是否已设。`secret`（aes-256-gcm BLOB）**不出任何响应体** |
| `lastTestAt` | ISO8601 | ✅ | 最近一次 `/test` 时刻；`null` = 未测 |
| `lastTestOk` | boolean | ✅ | `null` = 未测（**未知 ≠ 失败**，`0.2` 同纪律）；DTO 由列 `0/1/NULL` 转换 |

**端点表：**

| 方法 | 路径 | 请求体 | 成功 | 失败 |
|---|---|---|---|---|
| `GET` | `/api/egress` | —（`?status=active\|retired` 可选） | `200 {items: [...]}`（默认全量，按 `name` 排序） | 401 / 403 同 §1 |
| `POST` | `/api/egress` | `{name, url, username?, password?, region?, note?}` | `201 EgressProxy`（明文凭据**仅在本次请求时被加密落盘**，不回显、不落日志） | `400 INVALID_PARAM`（`details.field` 指到具体字段；**含 SSRF 拦截**：回环 / 私网 / 链路本地 / 云元数据段一律 400，`details.field = 'url'`）；同名 → `409 CONFLICT name`；同 URL → `400 INVALID_PARAM url`（归一化后判同一出口，退役后请回池复用原 id，本节裁定 3） |
| `GET` | `/api/egress/:id` | — | `200 EgressProxy` | `404 NOT_FOUND` |
| `PATCH` | `/api/egress/:id` | `{name?, region?, note?, username?, password?}`（任意子集，空 body → `200` 行未变） | `200 EgressProxy` | `404`；同名 → `409 CONFLICT name` |
| `POST` | `/api/egress/:id/retire` | `{reason: 'replaced' \| 'manual'}`（必填） | `200 {ok, status:'retired'}` | `400 INVALID_PARAM`（缺/非法 reason）；`404`；已退役再退 → `409 CONFLICT`；仍被账号引用 → `409 EGRESS_HAS_ACCOUNTS`（`details: {accountCount}`，**无 `force`**，本节裁定 6，**不写成功审计**） |
| `POST` | `/api/egress/:id/reactivate` | — | `200 EgressProxy` | `404`；非 retired → `409 CONFLICT` |
| `POST` | `/api/egress/:id/test` | — | `200 {ok, egressIp, latencyMs, error}` | `404`；**出口预算耗尽** → `429 TOO_MANY_ATTEMPTS`（`details.retryAfterSec`，判据同 §10 出口面 `RATE_LIMITED`：0 次真实尝试、不计 key 健康）；`retire` 后不可测 |

**协议面（只支持 HTTP(S)，约定 v1.13.1）**：出口**只收 `http://` / `https://`**（HTTP CONNECT 隧道）；**`socks5://` / `socks4://` 等非 HTTP(S) 协议在创建 / 保存那一刻即被入口拒下**，报 `400 INVALID_PARAM`（`details.field = 'url'`，message 指明协议）。这条拦的就是「**静默直连**」：被拒即**零行落库**，**没有**「忽略协议、改从宿主 IP 出站」这条路径（同本节裁定 5 「不得静默回落」的取向）；理由是可实现性 —— `undici` 的 `ProxyAgent` **不支持 SOCKS**，换 fetch 栈与「stream 透传不缓冲」的既有实现冲突（`docs/proposals/egress-proxy-onboarding.md` §1.1）；判据用例见 `src/api/routes/egress.spec.ts`（`socks5://` → `400` 且零行）。
`url` 校验（创建 / 重建同判）：`http(s)://`、**不得含 `user:pass@`**、不得含查询串或锚点 → 否则 `400 INVALID_PARAM`（`details.field='url'`）。
SSRF 拦截（`details.field='url'`）：**IPv4 段 `0.0.0.0/8` / `10/8` / `127/8` / `169.254/16`（云元数据） / `172.16/12` / `192.168/16`**
与 IPv6 `::1` / `fc00::` / `fd00::` / `fe80::` 一律 `400`，`details.field='url'`。
（IPv4 高位段比较**必须**先无符号化（`>>> 0`）：`(value & mask)` 在 JS 里回落 int32 负数，
与正数 network 常量比较恒 false —— `169.254/16` / `172.16/12` / `192.168/16` 三段就会全部漏拦。）
代理认证：`username` + `password` **都非空**才落 `secret`（`u:p` 合并加密、aes-256-gcm、主密钥；
**明文凭据只经内存、不落盘、不进日志、不回显**）；二者**都为空**才是免认证出口；一空一非空 = **不落**（同 §16.7「凭据不存值」）。PATCH 传 username/password 是**整体换凭据**（不是子集更新，密码无法子集更新）；
二者**都为空** = 清除凭据（`authSet` 从 `true` 回到 `false`）。

**`/test`（探活）：**

- **出站缝**：探活出站请求走**装配层注入**的 `egressProbeFetch`（缺省 = 全局 fetch，线上不传 = 行为与直调 fetch 逐字节相同；
  测试注入假件 ⇒ 用例零网络）。与 §15 `supplier.fetchImpl` 同一条纪律：**测试不发真实出站请求**。
- **流量归因**：探活流量**计入管理面消费**（`egress.reserve(egressId, 'management')`）—— 探活也吃出口预算，不是免费流量。
- **不读账号凭据**：本端点只读 `egress_proxies.secret`（出口自己的凭据），不读供应商账号凭据。
- **成功**：`ok=true` + `egressIp`（回显端点正文，必须是 IP 形状）+ `latencyMs`；**失败**：`ok=false` + `egressIp: null` + `error`（HTTP 状态或错误 message，**不含凭据**）。
- **落库**：无论成败都写 `last_test_at` / `last_test_ok`（`lastTestOk` 列 0/1；`NULL` = 未测）。**不写审计**（诊断，无配置变更）。
- **回显端点**：缺省 `https://api.ipify.org`（运维探针同款，pool-probe.sh 的 `--echo-url` 缺省同源）。
  **v1.14.2 起可配**（`EGRESS_ECHO_URL`，见下）：空 / 未设 = 用上面的缺省值。

**`url` 的 `user:pass@` deny-case**：`POST /api/egress` 带 `user:pass@` → `400 INVALID_PARAM`（`details.field='url'`，message 含"凭据"），
**且字面量不落库**（0 行）。同款断言在 `src/security/plaintext-scan.ts` 的 `proxy-url-credentials` 规则（check:secrets 门禁），
deny-case 样例见 README §6 台账。

**回显端点可配（v1.14.2 / ADR-0033）**：`EGRESS_ECHO_URL`（空 / 未设 = 用上面那个缺省值）。

这条不是"多一个开关"，它修的是**一个会静默骗人的故障形状**：回显端点从网关所在网络不可达时，
`/test` 会对一台**完全健康**的代理回 `ok=false`，并把那个 false 写进 `egress_proxies.last_test_ok` ——
面板上唯一那个"我的出口通不通"的信号在最坏情况下恒假，而照着它删代理的人删掉的是能用的机器。
心跳生产者入口 B 同源且更隐蔽：端点不可达 = 每拍一条失败证据，累计到
`HEARTBEAT_EVICT_AFTER_FAILURES`(3) 就把好节点**静默摘除**（无报错，只是可用出口少一个）。

三条纪律：

1. **缺省值只有一份字面量** —— `EGRESS_ECHO_URL_DEFAULT`（`src/egress/port.ts`），
   两个消费者（`/test` 与心跳入口 B）都从那里取。两处各写一遍的失败形状不是"以后要改两个地方"，
   而是**两个消费者可以配不同的值而毫无症状**：面板说这台通（打新端点）、心跳说这台死了（还打旧的），
   两边日志还都写着"探测正常"。由 `heartbeat.spec.ts` 的字面量唯一性判据守着。
2. **缺省值不变** —— 本版不把缺省换成国内可达的目标。换缺省会**静默改变所有现存部署**的探测语义
   （含那些"我测过、面板显示通"的记录），而那件事该由部署者显式做。
3. **不做 URL 语法校验** —— 一个连不上的端点就是一次失败的探测，那正是探测的职责；
   而"拒绝启动"会让填错别名的用户在启动阶段看到一句与网络无关的报错。

**运维侧同款旋钮**：`deploy/vps-egress/pool-probe.sh` 的 `EGRESS_ECHO_URL`（早于本版存在，
`--echo-url` 亦可单次覆盖）。两边**应配同一个值** —— 一个是面板/心跳在用，一个是 VPS 侧自检在用。

**迁移（v1.7.1）**：`egress_proxies` 的 `last_test_at` / `last_test_ok` 是**既有表加列** ——
早期批次（v1.4.8 Tier 2 DDL）已随开库建进**运行中的库**，`CREATE TABLE IF NOT EXISTS` 撞上已存在的表是空操作。
`migrate()` 照 v1.1.1 / v1.4.x 先例补 `hasColumn()` + `ALTER TABLE` 分支（可空、无默认，老行 NULL = 未测）；
spec 三条判据：新库自带、老库真被 ALTER 到、重复跑不抛 duplicate column name。
`SCHEMA_VERSION` 仍为 2（加列非搬迁，版本号只当记账用）。



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

> **〔v1.15.10 补一笔：这个形状已经有过一次真实触发面，只是那一次不靠 403〕**
> ADR-0039 修的那个缺陷是它的**孪生**：`models.type` 从不进服务路径 ⇒ 任何登记过的 chat 名字
> 都会被原样转发到上游的 `/embeddings`，也就是**调用方打错端点 = 网关替他去敲一次上游**。
> tierflow 对不支持的路径回 404，404 在 `classify.ts` 里判 `null` ⇒ 不烧 key，所以那条路径
> 在本部署上只污染用量；**若上游回的是 403，同样一条请求就会走 `AUTH_INVALID` → 冷却 → 连续失败自动停用**。
> 准入闸落地后，**类别已知**的错用不再出站（0 次真实尝试）；剩下的暴露面只有
> "**未登记**的名字"（本闸不表态，见 §10）—— 而那种名字在回 403 的上游上照样能烧 key。
> 本条仍然**不改 `classify`**：拒绝的理由没变 —— 未经证实的形状不改冻结判据。
> 但"客户端写错参数"**已经在网关侧被收窄了一层**，这条备注就是为了下次有人翻到这里时
> 知道：**别再把它当成纯理论**。

### 16.7.3 出口预算令牌桶：Tier 1.5 九条（v1.8.0；ADR-0017 补遗 5 / ADR-0021 决策 8·10）

**作用域（点名，一句"刷新"带过不算扩域）**：所有发往**同一出口**的请求共用一条速率 —— **§14 三个刷新端点（含自动同步）/ §15.2 六个端点 / 余额自测 / 探活 / 建 key / 重登 / 数据面 `/v1/*`**。

| # | 条目 | 口径 |
|---|---|---|
| ① | 计价单位 | **一次上游 HTTP 请求 = 一枚 token**（不是一把 key）：刷新一个账号 = **2 枚**（`/api/user/self` + `/api/subscription/self`），一轮 27 账号 ≈ **54 枚**（26 把 key 记账 ≈ 52 枚） |
| ② | 触发路径 | `RATE_LIMITED` 加**第四条路径「出口预算耗尽」**：**0 次真实尝试 / 不计任何 key 健康 / 不写出口冷却 / 一律带 `Retry-After`**；与 §10「0 次真实尝试不是上游故障」同刀。**零新码值**（复用 `RATE_LIMITED`，与 ADR-0011 的池饱和同形） |
| ③ | 保留额度 | **管理面消费者不得占用数据面保留额度**（否则单次人工刷新可合法饿死客户端流量）；占位值 `reserveForData: 1` 与 `capacity: 5` 同条登记 |
| ④ | 键一致 | 桶钥匙 = `egressId`，与 Tier 1 冷却键**同源**；Tier 2 落地时两处**一起**换成 `egress_proxies.id`；**禁止"桶按代理、冷却按 host"的分裂脑**；**`egressHostOf` 随迁退休**，归一化唯一入口 = `egressIdOfUrl`（解析失败 → `null` → 放行） |
| ⑤ | 冷却来源（其一） | **上游确认**：出口冷却**只由上游证据写入** —— 判据 = **同出口 60s 滑动窗口内 ≥3 个不同账号**同型 429（v6 订正版；不再是"第 2 把不同 key"），写入走 Tier 1 阶梯（`max(Retry-After, 60s)` 地板、封顶 30min） |
| ⑥ | 冷却来源（其二） | **桶拒绝**：走"终止本轮轮换 + `Retry-After`"，**不推进阶梯、不写冷却、不发射 §7 帧** —— §7 `egress_cooldown` 帧的成因**只有"上游确认"一种** |
| ⑦ | 终态形状 | 桶拒绝的客户端终态**必须是 `429 RATE_LIMITED` + `Retry-After`，不是 `502 UPSTREAM_ERROR`**；`attempts` 恒为 **0**；**不写 key 失败行**（KeyPool / `key_runtime` 不动；管理面任务级 `failed` 照记）；事件流**不得出现假失败行**、`inner` fetch 零调用、出口 `consecutive` / `until` **逐字节不变**。四条断言随实现落进用例（ADR-0021 §验证为唯一权威清单） |
| ⑧ | 检测器转正 | `egressLimitedOnSecondKey` **默认值替换**（换掉 `neverEgressLimited`）+ 判据入参改**窗口化 `distinctAccounts`**（v6："`distinctKeysFailed429` 参数化为 `scope`"**作废**，`scope` 字段退休）；两个识别器退休，判据唯一化到闸内。**转正 = §7 `egress_cooldown` 帧从此开始发射的起点**（v1.4.9「本期不发射」由**代码同笔**翻篇，本节不改 §7 文本） |
| ⑨ | 容量口径 | 所有容量数字（`capacity` / `reserveForData` / 每轮 token 数 / §15.5 的 ≈14 min 与重开门槛）都是**「单出口」口径**：出口 > 1 时**逐出口各自成立，不得跨出口加总** |

> **§15.5 连带（v1.8.0 已同批落）**：「27 个账号一轮刷新 ≈ 1 分钟」按 ⑥ 重算为 **≈14 min**（`ceil(54/4)×60s`，单出口口径），0.6s 降为账号级内层纪律，重开门槛（ADR-0017 补遗 6）登记为 §15.5 脚注。本表是那三处改动的唯一口径源。

---

*已冻结：v1.0-frozen，冻结裁决见 `docs/adr/0007-api-contract-freeze-c1-c5.md`。字段改动必须改本契约并新增 ADR。v1.1.0 补遗见 `docs/adr/0013-observability-readonly-query.md`；v1.1.1 补遗（关联键 `x-request-id`，§6 / §10 / §12.1 / §12.3）见 `docs/adr/0014-request-id-correlation.md`；v1.1.2 补遗（§10 登记 `GROUP_DISABLED` + §12.1 `AUTH_FAILED` 扩 403 + 四条产出边界）见 `docs/adr/0013-observability-readonly-query.md`「落地补遗」；v1.2.0（§13 内置 AI 助手聊天 + §12.2 `assistant` 字段）见 `docs/adr/0015-assistant-chat.md`；v1.2.1（§13.4「槽位撞满」二分口径：全候选满并发 `503 NO_AVAILABLE_KEY` / 竞态窗口 `429 RATE_LIMITED`，零新增枚举、零代码改动）为文本对齐；v1.2.2（§2 `DELETE /api/upstreams/:id` 从属资源处置：`force!=true` 拦 key 与模型并报 `{keyCount, modelCount}`、`force=true` 按依赖序物理删整棵子树，修订 §11 C4）见 `docs/adr/0016-delete-upstream-subtree.md`；v1.3.0（§14 余额同步：自动同步节奏与退避、NULL 口径、快照与 `asOf`、方向级漂移提示；同批撤销「单价 × 用量的本地扣减账本」方案）见 `docs/adr/0017-balance-sync-source-of-truth.md`；v1.4.0（§15 供应商账号面 + §16 TierFlow 数据面约束：账号作独立资源、批量新建 key 为唯一入池通路、账号级余额第四口径、套餐不建成 key、`upstream_keys.unlimited`、凭据会话一次性离线导入、`…Cents` 金额口径；`ERROR_CODES` 首次新增 1 个 `ACCOUNT_HAS_KEYS`）见 `docs/adr/0018-supplier-account-batch.md`；v1.4.1（§15.1 非破坏新增 `credentialSource`；§15.9 补凭据双路径定位、自动重登的触发与账号级互斥；§15.3 收口 `action` 枚举的生产者）见 `docs/adr/0018-supplier-account-batch.md` 决策 10；v1.4.2（§3 `KeyDto` 非破坏新增 `models` 模型白名单 + §5 `availableKeyIds` 补白名单条件 + §15.2 `keys` 入参可选 `models` + §15.7 加列 `upstream_keys.model_limits` + §16.1.1 悬空件登记 + §16.5 S1 字段对账）见 `docs/adr/0019-key-model-whitelist.md`；v1.4.3（§16.1.1 **执行主体改锚**：凭据由持有者运行时注入、可明示指定执行会话代跑，路由者只出探针与结论；新增 **§16.6 S4 验收锚定**含执行链三步与三项 S1 占位值表 —— 其中"数据面路径与协议"**明确不落 DTO**；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增**）见 `docs/adr/0018-supplier-account-batch.md` 决策 11；v1.4.4（§16.7 **出口级（IP 级）限流**：定性为第三层限流、取证"轮换放大"回路、归因纪律"IP 级 429 不计 key 健康 + 冷却上移到出口 + 冷却期内不换 key"、处置三档 Tier 1/1.5/2、识别规则按悬空件登记、§15.5 那条依据降级；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 对外行为零变更**）见 `docs/adr/0020-egress-ip-rate-limit.md`；v1.4.3 变更块为**补记**（冻版时正文与版本号已改、变更块漏写，仅补记录、无内容变更）；v1.4.5（§15.7 补 `unlimited=1 ⇒ balance_cents` 落 `NULL` 的**落库规则** + §16.3 该行改写与"白名单还差几处"的量词订正 + 同批落地 `src/db/schema.ts` 三列守卫 `ALTER` 与老库升版 spec + 补记 v1.4.3 变更块；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`SCHEMA_VERSION` 仍为 2**）为落地面收口；v1.4.6（§16.3 白名单口径**裁定**：路由者报回三条中 (a) 确认为既有登记的「4 处 + 1 spec」缺口、(b)(c) 按**非缺陷**关闭 —— 契约四处一致 `[]` ≡ `null` ≡ 不限、与冻结件 `matchesModel()` 同向；§15.2 待实测块**新增**一条「上游 `model_limits_enabled=true` + 空 CSV = 全禁还是不限」，实测前归一化仍为 `NULL`；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2**）；v1.4.7（§16.3 补**拓扑中立取件纪律** —— canonical 落点唯一、车道基线早于该批 `ALTER` 时按路径取件、不派生第二份 `schema.ts`；§16.5 两处文本订正：残留「网关侧还差一行」→ **4 处 + 1 个 spec**、「另两项不需要等任何人」限定为**契约层**；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2**）；v1.4.8（§16.7 两处悬空件**裁定** —— 识别规则**本期不启用**、登记世界 (c)（同一出口第 2 把不同 key 亦 429，代价：确认前第一把仍被记过）并写明「默认关闭期间 Tier 1 是**缝**不是**修**、自伤回路尚未掐断」；出口冷却 **= `max(Retry-After, 60s)`** 地板成文（此前只写"尊重"没写地板，是契约漏写）；**新增 §7 帧 `egress_cooldown`**（`egressId` 不透明字符串、`cooldownUntil` ISO8601、解除推 `null`）并同日写进 ADR-0020 决策 7；§15.5 依据降级落到**表内那一行本身**（此前只在本节写、表内仍是旧依据）、§15.9 / §16.4 两处 0.6s 引用补出口级指引；Tier 1.5「**同一出口共用一条速率**」口径定死、数值占位；Tier 2 订正旧文"若做"（DDL 已落）并写死**账号级绑定非 key 级** / **每出口账号数上限 6 占位** / **`egress_id` 不进任何 DTO**；**无字段改名、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2** —— 唯一的对外形状新增是那条 §7 帧）；v1.4.9（**§7 `egress_cooldown` 帧的「本期状态」裁定** —— 形状已冻结、**本期不发射**（识别器默认关闭 ⇒ 冷却不置起；发帧实现未落 ⇒ `live.ts` 零 egress 代码），故**本期出口级冷却对管理面不可观测**：前端**不得接线**、**不得把"未收到该帧"当作"出口健康"**（缺省不是证据）、不得反推；接入点写死为**接线层注入**（AGENTS.md §8，形状同 `ApiContext.assistant`），生产者归路由者 `src/gateway/egress.ts`；同裁定补进 §16.7 裁定 ① 并给出两条自检信号；**无字段增删、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.4.10（**§7 `egress_cooldown` 帧的投递语义收口** —— v1.4.8 那句「立即推（不等到下一帧）」是从 `key_health` 抄的，而本帧被 §7 自己定为唯一读面、**不走 REST** ⇒ 照字面实现即**纯事件推**：**刷新 / 重连拿不到"此刻正在冷却"**，前端只能把「全部 key 暂停路由」渲染成正常（最长 30min），且反推被禁 ⇒ **无合规自纠手段**；裁定改为**随每 tick 差分帧下发**（`id: egress:${egressId}`、`sig` 必带 `cooldownUntil`，新连接 `seen` 为空 ⇒ **首 tick 自然全量**），与 `key_health` / `balance` / `task` 同列，**零新增端点、零帧形状变更**，代价写明 **≤1 tick（1s）**；同批**证据订正**：`key_health` 的基线**不是** `metrics` 帧（`live.ts` 该帧不带 `keyHealth[]`）而是与其同款的差分帧首 tick 全量；自检信号由两个增为**三个**（新增差分帧注册面 `git grep -c 'egress:' dev/api -- src/api/routes/live.ts`）；**不改变 v1.4.9「本期不发射」的结论**；**无字段改名、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.4.11（**§7 `egress_cooldown` 生产者形态收口** —— 把 v1.4.8 / v1.4.10 那句「网关的**出口冷却表**」订正为**进程内注册表**：`src/gateway/egress.ts` 的 `createEgressCooldown()` 内部是 `Map<string, EgressState>`、**不落库、重启归零**，经 `stack.ts` 装配注入（`egress?: EgressCooldown`）；同批写死**发帧必须同进程读被注入的实例、不查库**（跨进程读不到则帧发不出来），并补记接线为**三处**（造帧 / 推帧 / 注册进 `tickNow` 的 `live` 集合 —— 漏第三处则帧每秒重发）；帧字段名 / 形状 / v1.4.10 投递语义（差分帧 + 首 tick 全量）/ 三条硬约束 / 三个自检信号 / v1.4.9「本期不发射」结论**全部不动**；**无字段改名、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.5.0（**§7 `egress_cooldown` 读面与 `reason` 两处收口** —— ① **放行纯增量只读** `EgressCooldown.snapshot(): readonly { host, untilMs }[]`（**签名只增不改**、`KeyPool` / `KeyConfig` / engine 零改动）：v1.4.10 钉了「`sig` 必带 `cooldownUntil`」却**没查生产者供不供得出**，实测 `egress.ts` 只有 `isCooling(host)` / `remainingMs(host)`（**须先知道 host**）、**无枚举读、无 `until` 读口** ⇒ 属**已冻结语义的缺件**；**语义钉死两条** —— `untilMs` 必须是**绝对时刻**（禁止 `now() + remainingMs()` 反算，否则指纹每 tick 变、每 tick 白推）、快照必须是**全量**（`live.ts` 差分通道**无墓碑**，id 消失只从 `seen` 删、不发帧 ⇒ 只报冷却中的话**解除帧永不发出**）；推论：冷却层**不得 prune 已过期条目**；② **删除 §7 帧 `reason` 字段**（`cool()` 是唯一变更入口且 `reason` 硬编码 `RATE_LIMITED`、`EgressState` 不存它 ⇒ **常量不是状态**；且本帧从未发射、零消费者，**删除此刻免费**），将来若出现第二种成因**同批加字段与生产者**；③ **不改变 v1.4.9「本期不发射」**，属接线前前置件；**§7 帧首次字段删除**故升 v1.5.0，**无端点增删、无其他字段改名、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.5.1（**S1 冻结稿** —— 不新增字段 / 端点，只把 S1 口径落到正文并补索引：**§15.10 新增**「Python 工作台退役与数据迁移口径」（ADR-0018 决策 6 早有结论、**§15 正文此前没有** —— 工作台退役、**`workbench.db` 不迁**、账号靠 §15.2 `import` 重建、旧 29 把掩码 key **作废不回捞**统一重建、批量建 key 作为供应商内建能力**不新增端点/任务类型**）；**§15.11 新增 S1 冻结索引表**（八项逐条给出正文落点与状态）；**§2 补**「通用模板不加换算字段」（个例不外溢，`parse.unit` 三值不变、不新增枚举）；**§6 补规则 6**「无限与未知分列，不得相加/顶替」；**同批订正派单三处锚点**（①② 口径 v1.4.0/v1.4.1 早已冻结、解析顺序在 **§2 非 §14** 且早已落、**会话文件路径按 §15.9 纪律 1 不进契约正文**）；**§14 / §7 本次零改动**；**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.6.0（**S2 落地收口的契约订正**，代码已落 `dev/api @ e76a2d6` —— §15 冻结稿里三处「声明与代码对不上」逐条订正：① §15.6「本次唯一动的既有聚合就是 `balanceUnknownKeyCount` 加一个条件」**不成立** （漏了**推导值** `knownKeyCount` —— 它是 `balanceKeyCount - balanceUnknownKeyCount`，正是从那一处改动里算出来的，无限额度 key 会被反过来数成"已知"），实为**两处**既有聚合 + **加一列** `balance_snapshots.unlimited_key_count`（老表加列，随 §15.7 批 `ALTER`），并补不变量的**互斥**写法；② §15.2 `DELETE` 的「解绑（`account_id` 置 `NULL`）」**指的列不存在** —— 归属本来就是 `supplier_account_keys.pooled_key_id` 台账，**刻意不补列**（第二个事实源），并写死 `ACCOUNT_HAS_KEYS` 的 `keyCount` **必须 JOIN `upstream_keys` 回来数**（台账行无外键，`deleteUpstream` 物理删 key 后成悬空引用 ⇒ 照台账数会让账号**永远删不掉**）；③ §14 快照点**不是"零改动"**、§6 `keys[]`/`keysBalance` 的集合同一性此前未成文、`currency` **漏查一张表** —— 补 **§6 规则 7**（`keys[]` 与 `keysBalance` 同一集合、只列无账号归属的 key、带 `unlimited`；**未知 key 仍在列表里**）与 **§6 规则 8**（`currency` 取值集合跟**贡献方**走、与金额判据逐字对齐 —— `supplier_accounts.balance_currency` **存在**，老口径只查 key ⇒ 钱全在账号上的上游恒回 `null`）；**同批补全 §6 两处 `byUpstream[]` 示例**并**修一处真错**（`keys[]` 条目示例误写 `balanceUnknownKeyCount`，同位置应为 `unlimited`）；**无字段改名、无字段删除、无端点增删、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2**）。v1.6.1（**S2「账号面 Tier A」落地** —— 三条**不打上游管理接口**的端点实现收口：`GET /api/supplier-accounts/subscriptions`（补形状 `Page<SupplierSubscriptionRowDto>` = §15.1 套餐摘要 + `accountId` / **掩码** `accountIdentifier` / `upstreamId`，排序 `end_at ASC` + `NULL` 最后）、`GET /api/supplier-accounts/export`（补列 `upstreamId` + 七条机械形状：`text/csv; charset=utf-8`、`Content-Disposition` 的 UTC 日期文件名、UTF-8 BOM、CRLF、RFC 4180 引号、**公式注入防护**（文本前缀单引号、数值不前缀）、**不分页**）、`DELETE /api/supplier-accounts/:id`（补 `204` / 被拦**不写成功审计**）；§15.7 补登两个审计动作 `supplier.export`（**GET 也写审计**：批量带走全部账号清单是账号面上最该留痕的动作，§6 的"所有写操作"是下限不是上限）与 `supplier.account.delete`；同批把 `subscriptionEndAt`（= 套餐 `end_at` 最大值，依赖**写入侧**归一化 ISO8601）写进正文；**全部是补白，无一处推翻既有口径**；**无字段改名、无字段删除、无端点增删、`ERROR_CODES` 零新增**（`ACCOUNT_HAS_KEYS` 随本批落地）、**`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL 改动**）。v1.6.2（**§16.7 出口级限流的实测形状登记** —— 路由者零凭据探针把决策 4 三样输入里的第 2 样「原始响应」打出来了，**这一样不卡凭据**（出口级限流不需要 key 就能触发）：① **响应形状** = OpenAI 信封 `{error:{code,message,type}}`（`type` 恒 `tierflow_error`）、`code: rate_limit_exceeded`，响应头**不含 `Retry-After`**（仅 `Date` / `Content-Type` / `Content-Length` / `Connection` / `X-Tf-Version: v5.5.6` / `X-Tierflow-Request-Id`）⇒ **订正 v1.4.8 裁定 ② 的理由（值不动）**：`max(Retry-After, 60s)` **永远取右边**、实际就是 60s 固定起步，理由由「**尊重**上游退避」改为「**上游什么都不给**」；**实现保持不动**且**不得**简化成裸常量（该分支是未来会自动复活的兼容路径，删掉零收益）；② **触发与自愈**：无间隔连发**第 8 次**触发（前 7 次均正常 401）、约 **1–2 分钟**自恢复（非封 IP）⇒ 本节「轮换放大器」**不是理论**；对 Tier 1.5 **只给触发证据、不给速率标定** —— 已知 8 次/约 60s 自愈，**未知窗口长度** ⇒ **数值仍占位**，标定需一次专门的退避时长实测；唯一可写进结论的是「出口级可持续速率**必然远低于**每账号 0.6s（27 账号 ≈ 出口侧 45 req/s）」，这是 v1.4.8 降级 §15.5 依据的**实证支持**；探针脚本自身一次全跑发 7 次请求正卡在 8 次预算上 ⇒ 已加 `PROBE_PACE_MS`（默认 700ms，**探针纪律、非契约义务**，不留间隙会把后半段污染成 429 假结论）；③ **判别力**：出口级 429 **无专用码、无专用字段** ⇒ 世界 **(b) 由实测排除**，而 (a) 退化为「只能解析文案」、文案解析又被决策 4 明令禁止 ⇒ **(a)(b) 两条路都不通**；但「key 级 429 同码」**从未观测**（需带 key 往返 = P0 的另一半）⇒ 把「按码分不开两个世界」写成结论**为时过早**，登记为**推断**、不据此改判；**v1.4.8 裁定 ①「本期三条都不启用、识别器默认关闭」不变**，只把理由从「**没有证据**」改为「**有证据，且证据指向 (c)**」；启用仍需一次明文决定（(i)/(ii) 二选一），**本批不放行**、§7 `egress_cooldown` **本期仍不发射**；④ **§16.1.1.a 订正一处判据**：401/403 的分岔由「**请求头里有没有 `Authorization`**」决定，**不由路径、也不由 key 是否有效**决定（`GET /v1/models` 无头 → 401 `Invalid token`；带畸形 `sk-` → 403 `routing_override_forbidden`；`POST /v1/chat/completions` 带畸形 `sk-` → 同一个 403）—— v1.6.0 那句「另一条**路径**上出现 403」是**误导**，应读作「带了 `Authorization` 头的那一侧」，**旁证性质与三条纪律不变**；**补登** P0 的「**路径存在性**」这一半已定（三条均 401/403 而非 404 ⇒ `/v1/models` 已实现，§16.1「只有自有协议」那一支**进一步削弱**），但**已鉴权面一条未定**（TTFB / SSE 帧形状 / `model` 取值 / pre-first-chunk 改判依据全缺），**S1 字段继续 `null` 占位**；**新增一处未证实风险**：畸形 `sk-` 落 **403 `routing_override_forbidden`**，而 403 在 `classify.ts` 落 `AUTH_INVALID` ⇒ 计失败 + 进冷却，**若有效 key 在某些写错的客户端参数下也能拿到它，一个调用方的低级错误就会把整池 key 烘掉**（§10 铁律要防的正是这个）—— **登记，不据此改 `classify`、不据此动冷却**，要带 key 往返才能定；**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）见 `docs/adr/0020-egress-ip-rate-limit.md`「v1.6.2 补记」；v1.6.3（**账号面 Tier B 落地** —— §15.2 六个「要打上游管理接口」的端点接线（`import` / `refresh` / `:id/login` / `:id/test` / `keys` / `keys/sync`），**全部按既有约定实现、零契约改动**；同批把 §15.3 `skipped` 的**口径成文**（此前四个计数里只有它没定义）：`skipped` = **没做过的行**（`LINE_PARSE_FAILED` 解析失败 + `EXCLUDED_IDENTIFIER` 排除名单命中），`failed` = **做过但不成的行**，故 `ok + failed + skipped = total` 恒成立；§15.7 补登两个审计动作 `supplier.account.login` / `supplier.account.test`（`detail` 同样只放计数 / 标志）；**同批修一处实现缺陷**（`replaceSupplierAccountKeyLedger()` 的 `db.transaction(fn)` 漏了调用 `()` ⇒ `keys/sync` 静默空转却报 `rows: N`）；**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL 改动**）；v1.6.4（**出口池卡片读面的裁定与登记**（本条最初误标 v1.6.2，与 `5af638d` 同号撞车，v1.6.5 批按落地时间重编号并补进本索引）：**不开新 REST 端点、也不并入 `overview`**，改在 **§7 新增池级差分帧 `egress_pool`**（`id: "egress:pool"`、**无条件注册**进 `tickNow` 的 `live` 集合，`nodes: []` 才表示"已接线、当前 0 个出口" —— 每出口一帧会因差分通道**没有墓碑**而使「0 出口」与「未接线」同形）；字段 `egressId` / `name` / `status` / `exitIp` / `expectedExitIp` / `lastHeartbeatAt` / `cooldownUntil`；**本期不发射、前端不得接线**，且其中 `status` / `lastHeartbeatAt` / `exitIp` 三条**生产者不存在** ⇒ 按 v1.5.0 写死的「**禁止先加字段、后补生产者**」必须与**心跳上报链**同批落地；**无端点增删**（新增的是**帧**）、**无既有字段改名 / 删除**、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码）；v1.6.5（**§16.1 数据面实测登记** —— 新增 **§16.1.2**：把 **`5bb58a1`**（`origin` 可达，2026-10-07 **11:16**）探针脚本头部 `:37–51` 的**带 key 探测记录**逐条落进 §16.1 判据表 —— `GET /v1/models` → **200** + `{data:[…]}`、**7 个模型** ⇒ 「**存在 OpenAI 兼容 relay**」**成立**、「**只有自有协议**」**排除**；错误**一律非 2xx** + OpenAI 信封（401 `code:""` / 403 `routing_override_forbidden` / 404 `model_not_found` / 429 `rate_limit_exceeded`）⇒ `classifyUpstreamStatus` **纯状态码驱动成立**、**§16.2 的 200+`success:false` 改判不需要做**；P4 零余额 key → 401 `Invalid token`（`code` 空、与「token 不存在」同形）⇒ 现判 `AUTH_INVALID` **正确、`classify` 零改动**；P3 错误体**在首包之前**到 ⇒ pre-first-chunk 改判**技术做得到**（**是否改判仍归 §16.2 / 路由者，本节不做该决定**）；并**分两级写死证据强度** —— **形状轴**（路径存在性 / 401-403 分岔 / 错误信封）无凭据可复跑、**是复现过的**；**成功体轴**（200 + 7 模型 / TTFB / SSE 帧）是**单点记录、未复现**（探针按设计只打 stdout、**不落盘** ⇒ 无第二份原始产物可交叉核），抬成复现只差**持有人在本地再跑一次**；同批记下**时间戳错位**（契约 v1.6.2 登记在 **10:44**、记录在 **11:16**，契约早 32 分钟且此后无人更新 §16.1.1.a / §16.5 ⇒ 「未实测」被当成现状流转了若干轮 —— **缺省不是证据**，对契约作者同样成立）、更新 **§16.5 行 2** 状态（⏳ 未实测 → ✅ 记录已到）与 **§16.6 第 1/2 项**的钉死条件（**已满足，但实测值 = 占位值 ⇒ 钉死 = 不改实现**）、**§16.1.1.a 补指针**；**同批修三处台账缺陷**：v1.6.3 变更块**补记**（冻版漏写）、v1.6.4 **同号撞车重编号**并补进索引、v1.6.3 的 §15.3 `skipped` 口径**从 §16.1.1.a 错挂处迁回 §15.3**；**无字段改名、无字段删除、无端点增删、无 DTO 变更、`ERROR_CODES` 零新增、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2 —— 纯文档，零代码**）；v1.7.0（**出口预算接缝 + 余额同步补遗的契约落点**，**枚举新增 3 个**：`GATEWAY_ERROR_CODES` +1（`NO_AVAILABLE_EGRESS`(503)）、`ERROR_CODES` +1（`EGRESS_HAS_ACCOUNTS`(409)）、`hintCode` +1（`BALANCE_EGRESS_RATE_LIMITED`）；**§10** 登记 `NO_AVAILABLE_EGRESS` 一行、`RATE_LIMITED` 触发条件扩到出口面（**出口预算耗尽 / 绑定出口全部冷却**：0 次真实尝试、不计 key 健康、不写出口冷却、带 `Retry-After`）、补注写死 `Retry-After` 适用范围**只到出口面两枚码**（不得泛化：`NO_AVAILABLE_KEY` 是 v1.2.1 / §13.4 已冻的**可重试 503**）；**§0.4** 登记 `EGRESS_HAS_ACCOUNTS` 一行（**不提供 `force`**）；**§16.7** 列清单换轴（`enabled` → 单轴 `status` + `retired_reason` + `retired_at`，`url` **归一化后 UNIQUE**）+ 新增「v1.7.0 裁定：出口的生命周期」六条（单轴 / `retired` 不删行 / `url` 唯一且**回池只有复用自己的 `egressId`** / **自动摘除不落库** / **池空不回落宿主直连**、且"永远选不出"与"现在用不了"**分属两枚码** / 退役被引用则 **409 且无 `force`**、账号侧对称 `400 INVALID_PARAM`）；★ 同批落 **`src/db/schema.ts` 的 `egress_proxies` DDL 逐字替换**（ADR-0021 放行笔 #1，**表未发布 ⇒ 零迁移**，故本版**不是纯文档**）；**§2 / §14.2** 加第 5 个 `hintCode` 行并把 `BALANCE_UPSTREAM_UNREACHABLE` 触发列改为"非 2xx（**429 除外**）"（**只加行不改列 = 两行互相包含**；判据 = **状态码 429 本身、不看标记头**；文案**不得越证据**；码名按 Bo 裁定**保留 `BALANCE_EGRESS_RATE_LIMITED`** ⇒ 前端 `HINT_CONFIG` 第 5 项 `title` 同受此纪律约束）；**§14.1** 退避归零改**三条判据**（有值 + 成功比例达标且**分母排除 `skipped`** + **本轮无 429**；阈值占位 80% 属实现常量、**不进契约**）并把推进条件从"`failed > 0 且 ok == 0`"改写（旧口径在共用出口预算下**永不退让**）、写死间隔的**唯一来源**（环境变量 `BALANCE_SYNC_MINUTES`）与**唯一读面**（`auto.intervalMinutes` 只读回显，**本版无写入口**，`min_interval_minutes` 从未存在）；**§14.3** `consecutiveFailures` / `nextAttemptAt` **语义改述**为"最近一轮整体健康度"、`knownKeyCount` 语义成文（**"余额当前有值的 key 数"**，含本轮没读到沿用旧值的 key）、**明确不收窄 `usedTokens`**；**§14.4** 加前置条件（**本轮有出口级限流则不判定**）；**新增 §14.7** 手动刷新"二次确认"交互契约；**新增 §15.13** S3 消费锚（三处字段级事实的唯一判据与正文锚点：`upstream.supplier === "tierflow"` / `result.items` 上限 **500** / `SupplierAccount` DTO）；**未落**（留后续批次）：ADR-0017 落地清单 #1 / #5 / #6 / #7（#7 有前置：翻篇起点是"**判据真正启用**"而非契约落地）与 #9–#16（代码 / 前端，含两处**码表长度断言**）；**无既有字段改名、无字段删除、无类型变更、无端点增删、无 DTO 变更、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零迁移**）；v1.7.1（026-10-09，§16.7 egress REST 配置面落地收口，代码已落 `dev/api` —— §16.7 落笔边界 ① 的实现同批登记 + 四修法）**：① **§16.7 新增 §16.7.2**（出口池 REST 配置面 `/api/egress`：对象 `EgressProxy` 全字段表（`id` `eg_` 前缀 / `name` / `url` 归一化后唯一 / `region` / `note` / **单轴 `status`** / `retiredReason` / `retiredAt` / 推导值 `authSet`（`secret` BLOB 不出响应体）/ `lastTestAt` / `lastTestOk`（`null` = 未测，未知 ≠ 失败）/ `createdAt` / `updatedAt`）+ 端点表七条（`GET` 列表（`?status=` 过滤）/ `POST` 建（SSRF 拦截 + 同名 409 + 同 URL 400 + `user:pass@` deny）/ `GET :id` / `PATCH :id`（空 body = 行未变；传 username/password = 整体换凭据或清除）/ `POST :id/retire`（reason 必填；被引用 → `409 EGRESS_HAS_ACCOUNTS` 无 `force`、不写成功审计）/ `POST :id/reactivate` / `POST :id/test`（`egressProbeFetch` 装配层注入缝离线化 + 探活计 `management` 预算 + 不读账号凭据 + 成败都落 `last_test_at`/`last_test_ok`、不写审计））；② **实现同批修四处**：`migrate()` 照 v1.1.1/v1.4.x 先例补 `egress_proxies` 两列（`last_test_at`/`last_test_ok`）的 `hasColumn`+`ALTER` 分支（可空无默认，老行 NULL = 未测；spec 三条：新库自带 / 老库真被 ALTER / 重复跑幂等）、`isBlockedIpv4` 比较前 `>>> 0`（`(value & mask)` 在 JS 回落 int32 负数与正数 network 常量比较恒 false，`169.254/16` / `172.16/12` / `192.168/16` 三段曾全部漏拦，云元数据 `169.254.169.254` 曾返 201）、CONFLICT 冲突面收敛为 `details.field='name'`（SQLite UNIQUE 报错带全限定列名，按它机器判；删"或 url"措辞，`details.field` 纪律 = 前端只标红一栏）、`/test` 加 `egressProbeFetch` 装配层注入缝（缺省全局 fetch，spec 注入假件回 `203.0.113.7` 零网络）+ 探活走 `egress.reserve(egressId,'management')`+`observeSuccess`（探活也吃出口预算）；③ **下游件同批**：`pool-probe.sh` 加 `--from-api [URL]`（从 `GET /api/egress` 取清单，`ADMIN_TOKEN` 鉴权；TSV 模式保留为 DB 未建档时的一次性清单）、README §4/§6 台账随批更新；④ **`ERROR_CODES` 零新增**（`EGRESS_HAS_ACCOUNTS` 已随 v1.7.0 登记）、`GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、§0.4/§10 无新增行（§16.7.2 内登记，不重复登记进全局表）；**字段改名零、字段删除零、既有端点增删零**（新增的是 §16 资源根 `/api/egress`，§2/§3/§4/§5/§6/§7/§14/§15 全部零改）。以上各版同属本契约的同一冻结面。v1.8.0（**2026-10-09，ADR-0017 落地清单挂账清欠 —— #1（§14 前言/§14.5 的「TTFB 判据（不受影响/自动满足）」后半句作废、耦合改记出口预算层）/ #5（新增 §16.7.3 Tier 1.5 令牌桶九条：计价单位、触发路径、保留额度、键一致、冷却两来源分列（60s 窗口 ≥3 账号 / 桶拒绝不发帧）、终态四断言、检测器转正、单出口口径）/ #6（§15.5 重算 ≈14 min（ceil(54/4)×60s）+ 重开门槛脚注 + 0.6s 降为账号级内层纪律）/ #7 前置确认（翻篇起点 = 判据真正启用，§7 本期状态零改动）/ S4 二次实测登记（流式 TTFB ≈436ms、`model` 别名改写行为发现，不改 DTO/classify）/ P3 #3 索引漏项核对为已修；**纯文档零代码，代码侧 #9–#16 同笔跟进**）见 `docs/adr/0017-balance-sync-source-of-truth.md`「落地清单」；v1.8.1（**2026-10-09，#16 契约面** —— 刷新任务 `result` / `BalanceTestResult` 新增可选 `retryAfterSeconds`，值的唯一来源 = 本地拒绝带回的 `Retry-After`、上游真 429 恒不带、多拒绝取最大、§14.2 零改动、零 DDL、`SCHEMA_VERSION` 仍为 2、`/v1/*` 零变更；代码同笔：`QueryOutcome` / `PresetRunResult` / `QueryExecution` / `RefreshSummary` 类型面透传，ADR-0017 清单 #16 收口）见 `docs/adr/0017-balance-sync-source-of-truth.md`「落地清单 #16」；v1.8.2（**2026-10-12，管理面手册对照实测订正 —— 锚 `a2ed7c2`**：§15.1 补 `all_subscriptions[]` 元素包一层 `{subscription:{…}, has_key, auto_renew}` + 金额口径锚点订正为 `data.quota_per_unit` + 上游时间键 `start_time`/`end_time`（epoch 秒）成文 + `/api/token/search` 默认 `page_size=10` 成文；新增 §16.1.1.b 管理面实测登记；同批补 ADR-0011 §2 键 3「时效窗」限定与锚点 `keys.ts:526` → `:559` 订正；**纯文档零代码，无字段改名 / 删除、无端点增删、无 DTO 变更、`ERROR_CODES` / `GATEWAY_ERROR_CODES` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2**）。（**版本索引订正 2026-10-07，不升版**：本索引此前在 v1.2.1 之后漏记 v1.2.2 / v1.3.0 两条，本次补齐 —— 仅索引行，无内容变更。**第二次订正（v1.6.5 批，不升版）**：补记 v1.6.4 —— 它此前**只有变更块、没有索引行**，且块号与 `5af638d` 的 v1.6.2 **撞车**；本批按落地时间重编号并补进索引，同样**仅索引行，无内容变更**。）*

v1.10.0（**2026-10-13，助手按请求选择站内模型** —— §13.1 请求体新增**可选** `model`（缺省 / 空串 = 装配侧 `ASSISTANT_MODEL`，**零行为变更**）；校验口径 = 站内已启用模型集合（与 §5 `enabled=true` / `/v1/models` 同一判据），不在集合内 → `400 INVALID_PARAM`（`details.field="model"`，**不静默回落**）；端口 `AssistantModelInvoker.stream(messages, signal, model?)` **只增不改**；无状态 / 计量口径 / 三重上限三项零变更；**无字段改名、无字段删除、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL、`src/gateway/` 零改动**。*

v1.11.0（**2026-10-14，模型能力探测** —— 新增 **§5 `POST /api/models/:id/probe`**，给 `capabilities` 加机器来源；**§10 `GET /v1/models` 只加字段**。Bo 原话：「获取模型后……就要去测试模型的参数……我用我们的 url 和 key 获取模型要能识别这些模型的功能」）：
① **新端点** `POST /api/models/:id/probe` body `{targets?, apply?}` → `200 ModelProbeResult`；请求体**服务端内置**、**只看状态码不解析文案**；`supported` **三态** `true`/`false`/`null`，**只有 `true` 进 `capabilities`**；`401/403/404/429/5xx/超时` 一律 `null`。
② **唯一 schema 变更 = 纯加两列** `models.capabilities_source`（`manual`**|**`probe`**|**`NULL`）与 `models.last_probed_at`，走 `hasColumn` + `ALTER` 通道 —— **纯加列 ⇒ `SCHEMA_VERSION` 仍为 2**（同 v1.1.1 / v1.4.x，迁移判据是"列在不在"）。
③ **来源规则**：`PATCH` 传 `capabilities` ⇒ `manual`；探测只在 `NULL`/`probe` 时写、**`manual` 永不被覆盖**（ADR-0009 §4 的第二个写入方），落库用条件 `UPDATE` 单语句原子（不需要 `revision`）；`last_probed_at` 每次都刷；档案卡**三态可分辨**（非空 = 有该能力 / `[]`+`probe` = **已探测、不支持** / `[]`+`NULL` = **未知**）。
④ **计量隔离四条**：零 `reportFailure`/`reportSuccess`（**不进引擎** —— 上游对不支持的能力回 4xx，那是**模型的性质、不是 key 的故障**）、零 `usage_logs`、出站**必走注入的 `fetchImpl`**（`fetchFor(egressId,'management')`，ADR-0021 决策 4，**禁止裸 `fetch`**）、计量随动作走（响应 `requests` + `result.probe` + 审计 `model.probe`）**不并进 §12.2**。
⑤ **自动补探**：`POST /api/models/sync` 尾部对候选（`capabilities_source IS NULL`）补探，**默认开**、两闸可关（`{probe:false}` / `MODEL_PROBE_ENABLED=false`）、单轮上限 `MODEL_PROBE_MAX_MODELS`（占位 10）+ 预算拒绝即停；**探测失败不改任务成败**。
⑥ **`supported_endpoint_types` 本笔不吸**（语义单位是**端点类型**不是**模型能力**，塞进闭集枚举会让前端 `capability` 筛选多出一个查不出的选项）；要留只做**独立只读字段** `endpointTypes`（**另开一笔**，本期 §10 恒 `null`）。
⑦ **`contextLength` 仍不动**（撞窗口反推烧真流量且不给数字）；
⑧ **`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增**（`reason` 是逐端点诊断字段，同 §15.4）、`/v1/*` **只加字段、既有四字段形状与集合口径零变更**、`SCHEMA_VERSION` 仍为 2、**零迁移**。

v1.11.1（**2026-10-14，助手页错误汇总面板的数据口径** —— 新增 **§13.6**，Bo 原话「不是价格错误汇总。是日志的错误日志汇总表，这样方便和助手对话复制」）：**纯前端消费口径登记，零新端点、零字段新增、零 DTO 变更、零代码改动**。① 面板行 = §12.3 `GET /api/observability/errors` 原样响应（默认近 1h、`ts DESC, id DESC`）；② 顶部 9 分型计数条 = §12.2 `events.byCategory`，**不得**用分页响应现算计数；③ 点行注入只走 §13.1 `logContext` 白名单字段（`window` / `from` / `to` / `category` / `severity` / `model` / `requestId`），**禁止把行文本塞进 `messages`**（§13 纪律 3「日志隔离」不接受自由文本查询）；④ **裁定 `done.citations` 不加默认快照** —— 自动快照每轮撞 §13.3「50 条」上限使 `truncated` 常驻失真，且面板上线后「复制」痛点已解、价值不抵代价；全局视野改由点行注入 `category` 多值承担（§13.2 语义一字未动）；⑤ 面板（`from`/`to`）与计数条（`window`）允许不同窗口，后端只回显（§12.3 `range` / §12.2 `window`），一致性归前端渲染，**不新增字段**；⑥ 取证：`observabilityApi.errors()` 自 `56d0dbb` 起零调用点、§12.3 端点活性实测 `200` —— 实现早已就位，缺的是消费侧。**`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL、`src/api/` + `src/gateway/` + `src/db/` 零改动**（`docs/adr/0025-assistant-error-summary-panel.md`）。

v1.11.2（**2026-10-14，sync 选 key 候选修复 + 探测口径三点补充** —— sync 401 根因 = `pickSyncKey` 选中无台账绑定的孤儿 key `****amMc`（`key_232d66a4385d`，上游侧已失效、零观测面），A/B 实测 `****amMc`→401 / 台账绑定 key→200，Bo 拍板停用 + 共享凭据选择器）：① 新增 `src/api/services/credential-rotation.ts` 共享凭据选择器（候选 = 已启用 +（有则）台账绑定 active 账号优先，`created_at,id` 稳定序；`tryWithRotation` 401/403 记 `auth` 换下一把、装配默认试 3 把、预算耗尽回最后一个错误）；② `SyncSummary` 新增可选可观测位 `credentials: {tried, usedMaskedKeys, switched}`（只含计数与掩码、不含明文）；③ 探测口径钉死三处：条件 `UPDATE` 的 WHERE 补 `now` 半句、端点**同步返回** `200 ModelProbeResult`（不 202 不打任务，单上游多模型超时预算才退任务面 `result.probe`）、`MODEL_PROBE_MAX_MODELS` 落装配侧 env 默认（数值不进契约）。**无字段改名、无字段删除、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零迁移**（`docs/adr/0026-sync-credential-rotation.md`）。
---

## 17. 管理面静态托管（v1.12.0；v1.12.1 勘误两处判据）

| 项 | 口径 |
|---|---|
| 服务面 | 管理面（`PORT_ADMIN`，默认 :4001）同时服务 `/api/*` 与前端产物 |
| root | env `ADMIN_WEB_DIST`（**默认空 = 关闭托管**；显式配相对/绝对目录路径才开，不做目录探测） |
| `GET /` | `index.html`（SPA 入口，**不缓存**） |
| 静态资源 | 带指纹产物（Vite 文件名自带内容 hash）`Cache-Control: public, max-age=2592000, immutable`（30 天）；**判定按响应 `content-type`，不按 URL** —— 兜底回落 `index.html` 时一律 `no-cache` |
| SPA 深链 | 非机器面（**段边界**：`/api` 与 `/api/*`、`/v1` 与 `/v1/*`）的 GET 未命中 → `index.html`（200）；机器面与非 GET 维持 JSON 404。裸 `/api`、`/v1` 归机器面 404 |
| 顺序 | `/api/*` 路由全部先注册，静态最后；`wildcard:false`，不注册 `/*` catch-all |
| 鉴权 | 静态资源不经会话闸门（onRequest 只判 `/api/*`）；`/api/*` / `/v1/*` 行为零变更 |
| 目录缺失 | 不 fail-fast：启动 warn，托管退化（0 条静态路由 + 兜底退化为 404） |

## 18. 接入信息 `GET /api/access-info`（v1.12.2；只读、无副作用）

| 项 | 口径 |
|---|---|
| 定位 | 给「接入信息」页一次取齐**自报口径**：网关 / 管理面的端口与绑定地址、对外 host 覆盖值、前端托管开关。**不含组 key** —— 掩码走 §4 `GET /api/groups`（`gatewayKeyMasked`），明文只在签发响应出现一次 |
| 方法 / 鉴权 | `GET`；会话或 `ADMIN_TOKEN`（§1）。无错误分支 —— 本资源永远存在，字段值可能为 `null`，不存在 404 语义 |
| 响应 | `200 {gateway:{scheme,portGateway,hostGateway}, admin:{scheme,portAdmin,hostAdmin}, publicHost, adminWebDistEnabled}` |
| `scheme` | 恒 `"http"`（TLS 终结在反代，服务端不感知，§17 同口径） |
| `portGateway` / `portAdmin` | int，config `PORT_GATEWAY`（默认 4000）/ `PORT_ADMIN`（默认 4001），**不写死** |
| `hostGateway` / `hostAdmin` | **绑定地址**（config `HOST_GATEWAY` / `HOST_ADMIN`，如 `0.0.0.0` / `127.0.0.1`）——是监听语义，**不是可访问地址**；前端展示时禁止把绑定地址直接拼给用户 |
| `publicHost` | env `PUBLIC_HOST`（默认空 = `null`）。对外基址覆盖值（如 `gw.example.com`，不带 scheme），落 `.env` 不落库；设置后 = 接入页展示的权威 host |
| `adminWebDistEnabled` | boolean，`ADMIN_WEB_DIST` 非空即 `true`（§17 root 口径）；前端据此提示「生产直开 :4001」还是「先起 Vite」 |
| URL 拼接责任 | 前端：`(publicHost ?? window.location.hostname)` + 端口；本端点**不回**任何完整 URL。**给出的是服务根**（它同时服务静态页与 `/api/*`）；**填进 OpenAI 兼容客户端的 Base URL 还要再加 `/v1`**（v1.15.7）—— 网关只认 `/v1/*`，少这一段就是 404 |
| 边界 | 零新存储、零 DDL、零迁移、零审计（纯只读）；`src/gateway/` 零改动 |

**实现锚（2026-10-14）**：路由落在 `src/api/routes/access-info.ts`（装配注册于 `src/api/app.ts`）；`publicHost` 取值源 = `AppConfig.publicHost`（`src/config.ts`，env `PUBLIC_HOST`）。用例 `src/api/routes/access-info.spec.ts` 钉三条：形状口径、值全来自 config 现读（无第二份事实源）、只读（GET 不写审计）；`adminWebDistEnabled` 的口径 = **配置了 `ADMIN_WEB_DIST` 吗**（配了不存在的目录仍为 `true`，不做运行期 `stat` 探测 —— 目录缺失是启动期 warn + 404 的退化，不改这个配置事实）。本笔**零 DDL、零迁移、`SCHEMA_VERSION` 仍为 2、`ERROR_CODES`/`GATEWAY_ERROR_CODES`/`hintCode` 零新增、`/v1/*` 零变更、`src/gateway/` 零改动**。

v1.13.0（**2026-10-14，账号绑出口写路径 + 读面** —— 新增 **§15.2 `PATCH /api/supplier-accounts/:id`**（收 `egressId` + `revision`；活性校验 = 不存在 / 已 `retired` ⇒ `400 INVALID_PARAM`、值未变短路、与写入同事务按受影响的每把 `pooled_key_id` 发 `change_log`），并**非破坏**给 **§15.1 `SupplierAccount` 加一格 `egressId`**（`null` = 未绑定、走宿主出口）；**§15.12 第 3 行 / §16.7 绑定纪律之三按本版改口**（收窄为"出口池的**状态**仍只有 §7 帧；账号**自己的绑定**进 DTO），§16.7 裁定 6 账号侧对称条落地指向本端点；新增审计动作 `supplier.account.update`；**`export` CSV 列清单本版不动并登记理由**；**无字段改名 / 删除、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增（三种失败全是既有码）、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL、零迁移、`src/gateway/` 零改动**；v1.13.1（**2026-10-14，出口协议面收口 —— §16.7.2 补一句「出口只支持 HTTP(S) CONNECT；`socks5://` / `socks4://` 一类非 HTTP(S) 协议在创建 / 保存那一刻即被入口 `400 INVALID_PARAM url` 拒下，不存在静默直连」**，并新增一条入口阻断用例（`src/api/routes/egress.spec.ts`）钉住判据；**无字段改名 / 删除、无端点增删、无 DTO 变更、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、`/v1/*` 零变更、`SCHEMA_VERSION` 仍为 2、零 DDL、零迁移。**）*

v1.14.0（**2026-10-16，站点换算比不再写死 —— `createToken` 走上游真值；附一处回填文档漂移订正** —— §15.1 金额口径补「『不写死』管两个方向，读侧与写侧都要守」一段（写侧曾是唯一例外：`createToken` 把 `quotaCents` 换算成 `remain_quota` 时写死 `DEFAULT_QUOTA_PER_UNIT` = 500000，站点比值改成 250000 时 1000 分的 key 会发 5 000 000 quota = **20 元**，多给一倍且 HTTP 200 不报错）；`createToken` 入参新增**可选** `quotaPerUnit`（省略 = 落回文档默认值，那是诚实的缺省）；`supplier_accounts` **加两列纯缓存** `quota_per_unit` INTEGER NULL / `quota_read_at` TEXT NULL（均可空无默认、**不进 `SupplierAccount` DTO**、`NULL` = 从没读到过），由登录探活 / 余额刷新 / 自测 / `keys/sync` 四条**已经在打 `/api/user/self`** 的腿顺手写、**零新增上游请求**、只在**真读到**时写；建 key 腿取值 `cred.quotaPerUnit ?? undefined`（**从库里读**，§15.5「建 key = 2 次」逐字不变，判据钉的是 `count('/api/user/self')` 前后不变）；§15.13 rotate 腿第二处写死同批修（单请求动作只读缓存不刷新缓存）；**`backfillSubscriptionTokenPlan` 的 `basic_token_used` 由 `?? 0` 订正为整行跳过**（两格任一未知 ⇒ `token_plan_remaining` 保持 `NULL`，代价只是落在"未知"档不参与精确排序，`UNKNOWN_PLAN_QUOTA` = 1 保证仍可用、仍排在余额 key 前）；**无字段改名 / 删除、无端点增删、无 DTO 变更、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、`/v1/*` 零变更、`src/gateway/` 零改动、零新增审计动作、上游请求数零增加；DDL = 两列纯加列，`SCHEMA_VERSION` 仍为 2、零迁移脚本。**）*

v1.14.1（**2026-10-16，五张表的保留策略** —— 新增 **§0.6 数据保留策略**（八张会累积的表逐张给出清理函数 / 保留期 / 配置 / 节拍，三条纪律：**审计保留期独立于用量日志**、**`change_log` 按行数不按天数**、**快照表留在各自写入方**）；动机是清完一遍 prune 调用方之后的形状 —— `pruneGatewayErrorEvents` / `pruneChanges` **有实现、零生产调用方**（一个"存在但没人调用"的清理函数让"这张表有保留期"看起来已实现），`audit_log` / `tasks` 连函数都没有；新增 `pruneAudit`（`AUDIT_RETENTION_DAYS`，默认 **180 天**，**只按时间窗删**、不认 id/actor/action）与 `pruneTasks`（`TASK_RETENTION_DAYS`，默认 7 天，**只删终态**，`finished_at IS NOT NULL` 显式写出——变异验证：删掉谓词用例不红、换成 `COALESCE(finished_at, started_at)` 立刻红，所以它拦的是那次"嫌 NULL 比较别扭"的改写）；`gateway_error_events` **按 §12.1 既有契约行接上**、不新配旋钮（`LOG_RETENTION_DAYS`）；`change_log` 接 `CHANGE_LOG_KEEP_ROWS`（默认 10000 行）；四条同挂一个 6h 定时器、逐条 try/catch；**`/api/*` 响应零变更、`/v1/*` 零变更、`src/gateway/` 零改动、DDL 零（`SCHEMA_VERSION` 仍为 2、零迁移）、`ERROR_CODES`/`GATEWAY_ERROR_CODES`/`hintCode` 零新增、审计动作零新增**（裁剪是维护动作，给它记一条审计会自我抵消）；三个新旋钮全部有默认值；判据 `src/db/repo/retention.spec.ts` 16 条全部经变异验证）*

v1.14.2（**2026-10-16，出口探活端点可配 —— 一个会静默骗人的故障形状** —— 新增环境变量 **`EGRESS_ECHO_URL`**（空 / 未设 = 用缺省端点；取值只 trim、**不做 URL 语法校验**：连不上的端点就是一次失败的探测，而"拒绝启动"会让填错别名的用户在启动阶段看到一句与网络无关的报错）；动机不是"多一个开关"：回显端点从网关所在网络不可达时，`POST /api/egress/:id/test` 会对一台**完全健康**的代理回 `ok=false` 并把那个 false 写进 `egress_proxies.last_test_ok`，面板上唯一那个"我的出口通不通"的信号在最坏情况下**恒假**，照着它删代理的人删掉的是能用的机器；心跳生产者入口 B 同源且更隐蔽：端点不可达 = 每拍一条失败证据，累计到 `HEARTBEAT_EVICT_AFTER_FAILURES`(3) 就把好节点**静默摘除**（无报错，只是可用出口少一个）；**缺省值只有一份字面量** `EGRESS_ECHO_URL_DEFAULT`（`src/egress/port.ts`），两个消费者（`/test` 与心跳入口 B）都从那里取 —— 两处各写一遍的失败形状不是"以后要改两个地方"，而是两个消费者可以配不同值而毫无症状：面板说这台通（打新端点）、心跳说这台死了（还打旧的），两边日志还都写着"探测正常"；**缺省值不变**（本版不把缺省换成国内可达的目标，换缺省会静默改变所有现存部署的探测语义）；运维侧同款旋钮 `deploy/vps-egress/pool-probe.sh` 的 `EGRESS_ECHO_URL` 早于本版存在，两边应配同一个值；**`/api/*` 响应零字节变更、`/v1/*` 零变更、`src/gateway/` 零改动、DDL 零（`SCHEMA_VERSION` 仍为 2、零迁移）、`ERROR_CODES`/`GATEWAY_ERROR_CODES`/`hintCode` 零新增、审计动作零新增**；判据 `src/egress/heartbeat.spec.ts`（缺省走缺省 / 配了走配的 / 字面量唯一性）+ `src/api/routes/egress.spec.ts`（同形两条，断言打进假件的 URL）+ `src/config.spec.ts`（空串 = null）全部经变异验证）*

---

## 19. 消费面 `/api/console/*`（v1.15.0；按组收窄 —— **读 + 本组 key 自助（v1.15.9）**）

给**普通用户**（`role=user`）的五件事：拿接入 URL 和 key 掩码、**自己签发 / 改名 / 吊销本组的 key**、
看自己组的用量、**看本组额度还剩多少**、看模型列表。
动机与"为什么这不是纯前端双视图"见 **`docs/adr/0034-console-user-role.md`**；
**v1.15.9 把"只读"这条限死了的那一半拆开**见 **`docs/adr/0038-console-key-selfservice-and-password.md`**。

> **本节标题里的"只读"在 v1.15.9 被改写**，写在这里以免下一个人按老标题理解：
> v1.15.0–v1.15.8 的消费面**一个写方法都没有**，而那条规则的理由是**一条风险论证**
> （下发签发权 = 组内任一成员可无限增发、共烧同一个配额池）。
> v1.15.9 用 `KEY_SELF_ISSUE_LIMIT` 那道护栏**消掉了那个代价**，于是签下放（§19.3b）。
> **改口令那条更直接**：`POST /api/auth/password`（§1）改的恒是会话本人，
> 而它顶掉的是 §19.7 的"忘口令 = 删掉重建"。
> **本章唯一没有被碰过的那一句是"明文没有再取回的路径"** —— 它一个字都没动，
> 而它才是"只读"这个词真正在守的东西。

### 19.1 授面（§0.5 的扩展，不是例外）

| 前缀 | `role=admin` | `role=user` |
|---|---|---|
| `/api/**`（既有，**一字未改**） | ✅ | **403 `FORBIDDEN`**（唯一例外见下） |
| `/api/access-info`（§18） | ✅ | ✅ **（v1.15.1 放行**，只为拼 §19.5 那条 URL） |
| `/api/console/**`（本节，**读 + 本组 key 自助**） | ✅ | ✅（数据按组收窄；写方法只有 §19.3b 那一组） |
| `GET /api/auth/session`（§1） | ✅ | ✅ **（v1.15.5 放行**，见下） |
| `POST /api/auth/logout`（§1） | ✅ | ✅ **（v1.15.5 放行**，见下） |
| `POST /api/auth/password`（§1） | ✅ | ✅ **（v1.15.9 放行**，见下） |
| `WS /api/stats/live`（§7） | ✅ | **4401（v1.15.2 补齐**，见下） |
| `/v1/**`（§10） | 不适用 —— 走 `Authorization: Bearer <网关key>`，与后台身份**无关** | 同 |

- 判据在 `src/api/app.ts` 的 `onRequest` 闸门里**一次判完**（前缀判定），
  与 `inReadonlyScope()` 对 `READONLY_TOKEN` 的做法同源（`app.ts` 头注：判定放闸门，
  新增路由不可能"忘了判作用域"）。
- **`role` 每次鉴权从 `admin_users` 现读**，不存进 `sessions` —— 存了就要处理
  "管理员改了角色、旧会话还是老角色"的窗口，而现读只是一次主键点查。
- **消费面从"零写方法"变成"key 自助这一组写方法"（v1.15.9 / ADR-0038 订正决策 3）**。
  v1.15.0–v1.15.8 本节写的是"全部是 `GET`，任何写方法落在这里 → 405"，
  而那一句的**理由**（把签发权下放给 `user` 等于组内任一成员可无限增发、共烧同一个配额池）
  被 `KEY_SELF_ISSUE_LIMIT` 这道护栏消掉了，见 §19.3b。
  **"没有写方法"那条仍然成立，只是范围变了**：除 §19.3b 明列的三条之外，
  `/api/console/**` 上仍然**没有**任何写方法（`PUT /api/console/usage` → 该用例钉的是
  `[404, 405]` 二者之一；**实测是 `404 NOT_FOUND`「接口不存在: PUT /api/console/usage」**，
  见 §1 那条实测订正与本 ADR 的手工走查记录）。
- **`GET /api/auth/session` 与 `POST /api/auth/logout`（§1）必须放行（v1.15.5）**：
  这两个端点**只碰 cookie 里那个会话自己**（`session` 读 `req.auth`，`logout` 删 `sessions`
  里这一行），不放行的后果不是"少一个功能"，是**普通用户完全登不进来** ——
  `web/src/auth/AuthGate.tsx` 进受保护区域第一件事就是打 `/api/auth/session`，
  403 会被渲染成"无法连接管理面"的全屏错态（403 不是 `UNAUTHORIZED`，
  不派发跳登录页），于是整个消费面够不着。**授面表判的是"能看哪些数据"，
  漏判的是"能落哪个地"** —— 这两行补的是后者。
- **`POST /api/auth/password`（§1）也必须放行（v1.15.9）**，理由与上一条**同形**：
  它改的恒是**会话本人**那一行（`req.auth.username`），`role` 与"能不能改自己的密码"无关。
  不放行的后果对 `role=user` 是"我永远改不了自己的密码"（消费面是他唯一的入口，
  而 §19.7 那条"忘口令 = 删号重建"会连带吊销他全部会话、把他的审计痕迹断成两截），
  对 `role=admin` 则毫无影响（他本来就在 `/api/**` 里面）。
  - 同样是**字面路径 + 方法门**：`POST` 放行，`GET /api/auth/password` → **非 200**
    （用例钉住"路径放行不等于方法放行"）。**这一格本仓不是 405** —— `buildApp` 没挂
    `setNotAllowedHandler`，方法不匹配一律落进 `setNotFoundHandler`（`src/api/app.ts:607`），
    而"不放行"对**两种身份有两种错法**（实测）：`role=user` → **403 `FORBIDDEN`**
    「当前账号只能访问消费面」（先撞闸门的 `role` 判定）、`role=admin` → **404 `NOT_FOUND`**
    「接口不存在」。用例对此**容错**（`expect([403, 404, 405]).toContain(res.statusCode)`，
    `console.spec.ts:1409`），所以测试没红、是文档写细了 —— 详见 §1 的实测订正与
    ADR-0038「手工走查」§2.6。
  - 它没有扩大暴露面的新地方：不读别人的行、不回任何口令或散列、写审计用新字面量
    `auth.password`（`audit_log.action` 是自由 TEXT，零 schema 变更）。
  - 放行是**这两个字面路径 + 方法门**（`session` 只放 `GET`，`logout` 只放 `POST`），
    **不是再开一个 `/api/auth/` 前缀**：前缀放行会把将来长在 `/api/auth/` 下的
    别的东西一起放掉，而字面路径不会。`PUT /api/auth/session` 仍 403。
  - **为什么不扩大暴露面**：两者都不读别人的行（判据来自 `req.auth`）、不回上游 Base URL、
    不回账号池、不回 key 掩码、不写审计。`GET /api/auth/session` 回的
    `{username, role, groupId, expiresAt}` 全部是**调用者自己的属性**。
  - 分工与 v1.15.2 那条同形：**闸门判"能打哪些前缀"，路径自己判"这条路径的授面谁来做"**。
- **`/api/access-info`（§18）是唯一放行的既有管理面端点**（v1.15.1 / ADR-0034 裁定）：
  它是 `publicHost` / `portGateway` / `portAdmin` 的**唯一来源**，而 §19.5 的 URL 公式
  要用的正是它们 —— 不放行则"通过用户前端获取 URL"这件事逻辑上办不到
  （v1.15.0 把 §19.1 与 §19.5 写在了一起而不相容，本版按 ADR-0034 订正文本）。
  - **为什么不是 `/api/console/**` 下的新端点**：两个端点回同一份值 = 两份口径，
    而两份口径将来一定漂移（ADR-0033 决策 2 同理由，这里禁的是第二个端点）。
  - **为什么这不扩大暴露面**：绑定的 `hostGateway` / `hostAdmin` 是**监听地址**
    （`0.0.0.0` / `127.0.0.1`），按 §18 纪律**从不与端口拼接**给用户；
    且它泄漏的严格**少于** `/api/console/keys` 已经给出去的东西（那把 key 掩码）。
    既没有上游 Base URL、没有账号池、没有审计日志，也没有密钥明文。

- **`WS /api/stats/live`（§7）对 `role=user` 一律 4401（v1.15.2）**：本路径是
  `app.ts` 鉴权闸门的唯一例外（升级请求回不了 HTTP 401），而**例外的代价是闸门的
  `role` 判定也被跳过** —— v1.15.0 / v1.15.1 只补了 REST 那一侧的授面，
  WS 这一侧的同一个洞没人看见：同一个身份打 `/api/stats/overview` 得 403，
  却能在这条通道上每秒收到同一份聚合（含 `balanceGlobal` 全站余额）。
  判据落在 `live.ts` 的握手期会话判定里（**建连之前**，不是连上之后挑字段），
  拒绝码 `4401` —— 前端 `live.ts` 已有"跳登录页"分支，而这里要说的真话是
  "你的身份不该开这条通道"，重新登录也不会变。用例见 `src/api/routes/live.spec.ts`。

### 19.2 `GET /api/console/session`

→ `200`
```json
{ "username": "alice", "role": "user", "groupId": "grp_9f2c", "expiresAt": "2026-10-18T12:00:00.000Z" }
```

| 字段 | 说明 |
|---|---|
| `role` | `"admin"` \| `"user"`。前端据此分流 `/`（管理面）/ `/console` |
| `groupId` | 该用户归属的组；**`null` = 未分配**（此时四个读端点回空 + `assigned:false`，**不是 500**；三个写端点回 `400 INVALID_PARAM`，见 §19.3b） |

**〔v1.15.9 订正〕** 上两格都动过字面：
- `groupId` 那格的"**三个**列表端点"是 v1.15.0 的账（keys / usage / models），
  v1.15.9 加了 `GET /api/console/quota` 之后是**四个**读端点。**读的降级与写的拒绝故意不同形**：
  读回空（"看不到"，无害），写回 `400`（"签一把必然打不通的废 key"比拒绝更坏），
  见 §19.3b 最后一条。未分配的 `quota` 回的是**各格 `null`**而不是 0（§19.3c）。
- `role` 那格原先写的是 `/admin ⇄ /console`，而**前端没有 `/admin` 这个路由**：
  `router.tsx` 里 `HomeRoute` 对 `role=admin` 重定向到 `/dashboard`。这是 ADR-0034 末尾
  「与 A 档的判据差别」那处假地址的同一处笔误，v1.15.3 已在其正文订正，此处一并改口。

未登录 → `401 UNAUTHORIZED`（§1 同口径）。

### 19.3 `GET /api/console/keys`

→ `200`
```json
{ "groupId": "grp_9f2c", "keys": [ { "id": "gk_1a2b", "maskedKey": "****9f3c", "label": "小王的笔记本", "createdAt": "..." } ], "assigned": true, "keyLimit": 10 }
```

- 元素形状**逐字复用 §4 `GatewayKeyDto`**（`id` / `maskedKey` / `label` / `createdAt`）——
  **不新增字段、不改名**。顺序固定 `createdAt, id`（同 §4）。
  `label` 是 v1.15.9 随 §4 一起非破坏新增的（`string | null`，空串归一化成 `null`）。
- `keyLimit` **非破坏新增**（v1.15.9）：自助签发的把数上限（**服务端的事实**，当前 10，见 §19.3b）。
  前端据此把"签发新 key"按钮置灰并说明原因。
  **为什么不要求前端自己数 `keys.length`**：那等于让前端复刻同一个数字，
  而复刻出来的那份将来一定漂移 —— 上限改了前端还按旧数拦，用户看到的是一个"点了必然失败"的按钮。
- **只有掩码**：网关 key 明文只存在于**签发**（`POST /api/groups/:id/keys`，§4；
  与 §19.3b 的自助签发）的 201 响应体里（§4 铁律 / ADR-0006），
  **没有任何"再取回"的代码路径**。本节**没有**"显示明文"的端点，本契约也**不提供**。
  **〔v1.15.9 订正**：本节原先写"消费面因此**不含签发端点**"，理由是"下发签发权等于让组内
  任一成员无限增发、共烧同一个配额池，要单独一条 ADR"。那条理由是**风险论证**，
  而它已经被 `KEY_SELF_ISSUE_LIMIT` 这道护栏消掉 —— ADR-0038 就是那条 ADR，
  签发端点见 §19.3b。**"没有再取回明文"这半句一个字都没动**，它才是本节真正要守的东西。〕**
- `groupId: null` → `{ "groupId": null, "keys": [], "assigned": false, "keyLimit": 10 }`。
  **`assigned:false` 时仍然回 `keyLimit`**：它是**这个端点的一条规则**，与调用方有没有组无关；
  回 `null` 会让前端多一个"拿不到上限"的分支，而那个分支没有对应的事实。
- 归属**不来自请求参数**：`?groupId=` 一律忽略（判据：构造别组 id 回的仍是本组）。
- **不透传 `page` / `pageSize` / `total`**：消费面不需要翻页，而自助上限是 10 把 ——
  列表规模有了上界之后，"翻页"这一层就更是纯粹的负担。

### 19.3b 自助签发 / 改名 / 吊销（v1.15.9 / ADR-0038 决策 1）

| 方法 | 路径 | body | 成功 | 明文 |
|---|---|---|---|---|
| `POST` | `/api/console/keys` | `{label?}` | `201 GatewayKeyIssuedDto` | ✅ **仅此一次** |
| `PATCH` | `/api/console/keys/:keyId` | `{label?}` | `200 GatewayKeyDto` | ❌ |
| `DELETE` | `/api/console/keys/:keyId` | — | `204` | ❌ |

**这是消费面唯一的一组写方法**，所以下面每一条都同时是"授面"与"语义"。

- **`label` 三处语义必须一致**（`normalizeLabel` 是唯一出口，签发与改名共用）：
  **省略**与 `""` 与 `null` **都是"没有名字"**（落库 `NULL`）；
  非空字符串 `trim` 后落库；`maxLength: 100`。
  `label` **不是 required** —— `{}` 是一次合法的"不改名"，而把它设成 required 会让
  "清掉名字"必须传 `{label: ""}` 或 `{label: null}` 两种写法之一（两种都得支持，那就不如都不要求）。
- **护栏 `KEY_SELF_ISSUE_LIMIT`（按组的**把数**上限，当前 10）**：到顶 → **`422 UNPROCESSABLE`**，
  `details: {limit, used}`。
  - **422 而不是 400 / 409**：请求本身完全合法（表单填得对、身份也对），挡下它的是**这个组的现状**
    （已经 10 把了）—— 与 §15.4「`UNPROCESSABLE` = 语义合法但业务拒绝」同一条判据。
  - **判在签发之前**：先签再判的话，被拒的那一下也得回滚一次写（`issueGatewayKey` 不返回事务句柄），
    而"签了再删"还会在库里留下一段没解释的 id 空洞与两条 `change_log`。
  - **为什么是"把数"不是"每天几次"**：攻击面是**同一配额池被多方共享**，与签发频率无关 ——
    一天签 1 把烧光池子和一天签 10 把烧光池子没有区别。把数上限直接钉住"池子的份数"。
  - 上限是**常量不是配置**（ADR-0038 遗留 3）：真不够用时改常量 + 一次发版，
    成本低于一个"谁能改、改了要不要通知正在签发的人"的配置面。
- **归属只来自会话**：写入的 `group_id` 恒取 `groupIdOf(req)`。body 里的 `groupId`
  **故意不写进 schema** —— 它会被 ajv 剥掉，而"剥掉之后请求照常成功、调用方以为自己指定了组"
  比明确拒绝更坏（§19.4 同一条：不声明就是明确忽略）。
- **未分配组（`groupId === null`）一律 `400 INVALID_PARAM`**（`details.field = 'groupId'`）——
  这**与读端点的"可读降级"故意不同形**（§19.3 回空 + `assigned:false`）：
  没有组就没有配额池，签出来的 key 打 `/v1` 会被网关判成"组不存在"。
  **读的失败是"看不到"（无害），写的失败是"签出一把废 key"（有害）**。
- **越权判据是 `404` 不是 `403`**：改名 / 吊销的 SQL 是 `WHERE id = ? AND group_id = ?`，
  命中不到就 404。**403 会告诉调用方"这个 keyId 存在、只是不属于你"** ——
  而那正是枚举别人 key 的反馈信号（§19.3 同一条，本版沿用而非新造）。
- **CRUD 面已满，不多一个"重置"**：管理面有 `reset`（§4），消费面**刻意没有**。
  重置的语义是"这把 key 泄了、换一把"，而自助已经能"吊销 + 签发"做到同一件事，
  多一条路由只多一个要判的越权面。**代价**：重置在管理面会清掉 `label`（§4 已写明），
  而"吊销 + 签发"的组合是两次显式动作、用户能自己填名字 —— 这一侧反而更清楚。
- **审计复用管理面那一套动作名**：`gateway_key.issue` / `gateway_key.update` / `gateway_key.delete`，
  `targetType: 'group'`、`targetId` = 本组、`detail` **只记掩码或 keyId**（§4 铁律：审计里永不出现明文）。
  **不新造 `gateway_key.self_issue`** —— 审计的问题是"谁在什么时候动过这把 key"，
  而"从哪个面动的"不是这个问题的一半（actor 已经回答了）；拆成两个动作会让
  "某把 key 的全部历史"要按两个 action 查两次。
- **CSRF 照旧**：写方法在**鉴权之前**过三层校验（§0.5），消费面不豁免 ——
  缺 `X-Requested-With` → `403 CSRF_REJECTED`。这是"写权限下放"真正的安全底线，一个字都没动。
- **闸门零改动**（读这一条的人最容易看错）：`inConsoleScope(path)` **只判前缀、不判方法**，
  这三条路由天然落在那道闸门里。**但这条红利同时是警告** ——
  这个前缀下**任何**写路由的授面就是"该组用户"，所以新增写路由前必须先想清楚
  **"这一下动的是不是他自己的组"**，而不是先看闸门。本版三条的答案是"是"（判据来自会话）；
  下一条写路由如果答案不是"是"，那么**它是错的，不是闸门要改**。

### 19.3c `GET /api/console/quota`（v1.15.9 / ADR-0038 决策 4）

→ `200`
```json
{
  "groupId": "grp_9f2c", "assigned": true,
  "rpm": 60, "tpm": 120000, "dailyQuota": 500000, "dailyQuotaUsed": 123456,
  "todayUsage": { "requests": 431, "tokens": 123456, "costCents": 8901 }
}
```

| 字段 | 说明 |
|---|---|
| `rpm` / `tpm` / `dailyQuota` | 与 §4 `GroupDto` **同源**；`null` = **不限** |
| `dailyQuotaUsed` | 今日已用 token（与 `todayUsage.tokens` 同一个数，单列一格是为了不让前端去算） |
| `todayUsage` | 就是 §4 `GroupDto` 的那一格 |

- **每一格都是既有字段的透传，本面不算第二遍**：它们与 §4 `GroupDto` 来自**同一句
  `todayUsage()` SQL**。所以"消费面用量页显示的数字"与"管理面组列表显示的数字"
  是**同一句话**，不是两份可能对不上的账 —— 契约用例钉的正是这一条
  （把管理面 `GET /api/groups/:id` 的那几格取出来与消费面**逐字比对**；
  只断言"这次读对了"并不证明"两面同一份口径"）。
- **未分配组回 `null` 而不是 0**：`assigned: false`，各格 `null`、`dailyQuotaUsed` 与
  `todayUsage` 为 `0`。**"没有配额"与"配额是 0"是两件事** —— 前者是"你还没进组"，
  后者是"你今天一点都不许用"。回 0 会让前端把第一种渲染成第二种（一排 0/0 的进度条），
  而用户会去查"我为什么被限流了"。
- **组被管理员删掉、而会话还指着它** → 回**未分配那一形状**（`200`），**不是 500**：
  对用户来说这就是"你暂时没有组"，而 500 会让他去报告一个不存在的问题。
  （会话里的 `groupId` 每次鉴权现读，所以下一次请求它已经是 `null`。）
- **前端两种 0 必须画得不一样**（`web/` 侧纪律，服务端不依赖它）：
  `null` = 不限 → 显示「不限」，**不是一根 0 长度的进度条**；
  `limit === 0`（封顶）→ **满格红色**，**不是 0%**。
  （`used / 0` 是 `NaN`，而 `0%` 会被读成"一点都没用"—— 恰恰相反，"日配额 0"是**一点都不许用**。）

### 19.4 `GET /api/console/usage`

→ `200`（**响应体形状与 §6 `GET /api/stats/usage` 逐字相同**）

| 参数 | 必填 | 说明 |
|---|---|---|
| `from` / `to` | ✅ | ISO8601 |
| `groupBy` | ✅ | `key` \| `upstream` \| `model`（**不含 `group`** —— 消费面恒按本组收窄，按组分箱只会得到一根恒等的线） |
| `bucket` | ✅ | `1m` \| `5m` \| `1h` \| `1d` |
| `upstreamId` / `model` | ❌ | 过滤；`groupId` 参数**被忽略**（§19.3 同一条） |

- `series[].key` 恒为本组范围内的 id；**别组一行都不出现**（`usage_logs.group_id = 本组`）。
- `isEstimatedTokenCount` / `points[].promptTokens|completionTokens|estimatedTokens` / `costCents`
  口径**与 §6 逐字相同**，不因消费面重新定义。
- `groupId: null` → `axis` 空 + `series: []`。

### 19.5 接入 URL（**不新增端点**，放行 §18 那一个）

消费面**不新增**接入信息端点，直接读 §18 `GET /api/access-info`
（**v1.15.1 起放行给 `role=user`**，见 §19.1 那张表）。URL 拼接责任在前端（同 §18）：

```
(publicHost ?? window.location.hostname) + ':' + portGateway        // 服务根
(publicHost ?? window.location.hostname) + ':' + portGateway + '/v1' // ← 填进客户端的 Base URL
```

- **上面两条只差一段字面量 `/v1`，而少了它拿到的是 404**（v1.15.7）：网关面的路由是
  `/v1/chat/completions` / `/v1/models` / `/v1/embeddings`，**前缀是路由的一部分**。
  消费面因此把带 `/v1` 的那一条**当作「API 地址」展示并可复制**（业务口径的地址是它），
  服务根只作为"本服务的入口"出现。这不是第二个公式 —— 是同一个公式加固定后缀，
  且 **`/v1` 只写在前端一处**（拼装函数里），不在页面上手抄。
- `publicHost` 为空（未配 `PUBLIC_HOST`）时用浏览器所在机器的名字 —— 这与管理员面
  §18 接入页是**同一个公式、同一个兜底**，不是第二份。
- **新开一个 `/api/console/access-info` 就会有第二份口径**，而两份口径将来一定漂移
  （ADR-0033 决策 2 的同一条理由，这里禁的是第二个端点）。
- key 明文**不在**本面：用户看到的是 `/api/console/keys` 的掩码列表（§19.3）。
  **〔v1.15.9 订正**：这一条原写"明文由管理员在建用户 / 建组时给一次"，现在还有**第二条路** ——
  用户自己签发那一次（§19.3b），明文同样只在 201 响应体里出现**一次**、没有任何取回路径。
  **两条路给的是同一种 key**（同表、同 `key_hash` 鉴权、同配额池），只是谁能发起。
  管理面那条路仍然在（`POST /api/groups/:id/keys`，§4），一个字都没删。〕**
- **本页的接口说明只列网关真实注册的三条**（`GET /v1/models`、`POST /v1/chat/completions`、
  `POST /v1/embeddings`），认证只写 `Authorization: Bearer <网关 key>`（v1.15.9）。
  网关把 `/v1/images/`、`/v1/audio/`、`/v1/rerank`、`/v1/moderations`、`/v1/files`、
  `/v1/fine_tuning` 一律 **501 `UNSUPPORTED_ENDPOINT`**（§10）。
  照 OpenAI 的文档列一张更长的表 = **一份半真的清单**，比短的那份坏 ——
  用户会照着打，然后拿到一个他没做错任何事的错误。

### 19.6 `GET /api/console/models`

→ `200`
```json
{ "models": [ { "id": "mdl_7f3a", "name": "my88/gpt-4o-mini", "displayName": "GPT-4o mini", "type": "chat", "capabilities": ["vision","stream"], "contextLength": 128000 } ] }
```

- **口径 = §5 `GET /api/models?enabled=true` 的同一判据**（`models.enabled = 1` **且**
  其上游 `upstreams.enabled = 1`），与 `/v1/models`（§10）**同源** ——
  用户端看到的"我能用哪些模型"必须与网关实际准入的集合一致，否则又是一个会骗人的信号。
  **v1.15.8 收窄**：本端点**按会话的组**收窄 —— 该组授权了模型列表时，只回列表内的
  （与该组 key 打 `/v1/models` 看到的集合**同一判据**）；未授权收缩（`authorizedModels: null`）
  的组回全量，与改版前逐项相同。"能用哪些"与"实际准入"的一致性因此**按组成立**，不是全局。
- **`enabled` 字段不回，因为恒为 `true`**：SQL 判据本身就是 `enabled = 1`，
  响应里不可能出现 `false` 的行。回一个恒真字段只会教人去处理一个不存在的三态
  （v1.15.0 初写此节时把 `enabled` 放进了示例 —— 那是照 §5 的形状多抄了一个字段，
  实现从第一天就没回过它。这是**订正**，不是 v1.15.8 的变更：实现没有动，动的是本节的字。）
- **分页口径（本节与 §0.3 不完全一致，如实写明）**：查询串接受 `page` / `pageSize`
  （**缺省 `pageSize=100`、上限 200**，与 §0.3 的缺省 20 不同），但响应体**不带 §0.3 信封**
  —— 没有 `items` / `total` / `page` / `pageSize`，只有 `{models: [...]}`。
  所以**翻页对调用方不可见**：拿不到 `total` 就无法判断"还有没有下一页"。
  本站模型是百量级、一次取全，消费面前端也**不传这两个参数**，所以实际不影响使用；
  但按契约集成的调用方**不该**依赖 `?page=2` 能翻页 —— 真要分页，正确做法是把本端点
  补成 §0.3 信封（那是一次破坏性变更，需走契约流程），不是在这里偷偷偏移。
- **不含** `upstreamId` / `upstreamName` / 价格 / 余额：那些是管理员面的信息。
  价格与余额对普通用户既无用又是上游信息的泄漏面。
  调用时 `model` 字段填 `name`（§10：请求键是模型名），**不是** `id`（`mdl_*`）——
  `id` 是档案行号，网关热路径上没有"行号→名字"的映射，填它只会 404。
- **消费面实现的既有漂移（v1.15.8 订正）**：`web` 的 `ConsoleModel` 曾写成
  `{id, displayName, enabled}` —— 与本节形状不符，而**两边各自类型自洽**，
  四闸全绿也拦不住（`web/` 无测试 runner）。真实后果是**用户可见的**：
  `enabled` 恒 `undefined` ⇒ 每个模型都渲染成「已停用」、页面上的「只看可用」
  一按**清空列表**；可复制值给的是 `mdl_*`，照抄去调用**必 404**（本节已写明该填 `name`）。
  修法是删掉那个开关与「已停用」分支（这个三态在协议上不存在）并把可复制值改成 `name`。
  **登记在这里的理由**：它是"契约写对了、实现没跟上"的典型 —— 只有把**真实响应**
  喂给**真实页面**才能发现，这正是 §19 头注那条"消费面数据归属只来自服务端"纪律的
  另一半（前端不得自行推断服务端没给的字段）。
- **筛选纪律：服务端收窄 = 集合，用户关键字 = 视图（v1.15.9 / ADR-0038 决策 5）**：
  v1.15.3 写下的"模型广场**不做任何本地过滤**"针对的是**把服务端批准的模型藏起来**
  （那个不存在的 `enabled` 三态就是这么来的，见上一条）。**那一层的禁则不变**。
  新加的一层是：用户**主动敲的关键字 / 选的类型**是**视图**（那是他要的），可以做 ——
  **前提是筛选器必须自报家门**：恒显 `已筛选 N / 共 M`，筛空时给的是
  「清除筛选（共 M 个）」而不是一个空白页。**没有这一条，"被筛掉了"会被读成"没有这个模型"**，
  而那正是本条要防的那个错，只是换了一条路径。
  筛选项本身也**从返回数据里长出来**（type → count 的映射），不是从标签表里抄 ——
  给一个必然产出空结果的筛选项，本身就是一种误导信号。
  〔这一层是 `web/` 侧纪律，**契约面零变更**：本节一个字段都没动。写在这里是因为
  它是"会骗人的信号"这条纪律的延续，而那条纪律的家在本节。〕

### 19.7 管理面用户端点（`role=admin`）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/users` | body `{username, password, role, groupId?, displayName?}` → `201 {username, role, groupId, displayName, createdAt, updatedAt}` |
| `GET` | `/api/users` | 列表（分页，§0.3 信封）；**不回 `password_hash`** |
| `PATCH` | `/api/users/:username` | body `{groupId: string \| null}` → `200 UserDto`（**只改归属组**，v1.15.6 新增） |
| `DELETE` | `/api/users/:username` | `204`；同时吊销该用户的会话（`DELETE FROM sessions WHERE username = ?`） |

#### `PATCH /api/users/:username` —— 只改归属组（v1.15.6 / ADR-0035 决策 2）

```json
{ "groupId": "grp_2b91" }
```

- **接受且只接受 `groupId`**（`string` 或 `null`；`null` = 退回未分配）。请求体里
  出现 `role` / `password` / `displayName` / `username` 一律**忽略**（`additionalProperties`
  照 §0.2 的既有口径不写 `false`），它们照旧不可改。
- `200` + 全字段 `UserDto`（与 `POST` 的 201 同一形状）。未知用户 → `404 NOT_FOUND`。
- `groupId` 指向不存在的组 → **`400 INVALID_PARAM`**（`details.field = 'groupId'`），
  **不是 500** —— 一个坏入参不该被诊成服务端故障。
- **归属改了立刻生效**：`SessionInfo.groupId` 每次鉴权从 `admin_users` 现读
  （ADR-0034，「为什么 role 不存进 sessions」同一理由），所以**不需要**重新登录，
  也不需要"改完踢他下线"。
- 审计动作 **`user.update`**，`detail` 只记 `{groupId}`（**不含口令、不含散列**）。
- **这条端点存在的唯一理由**是"归属错了要能修"。它**不是**"用户可编辑"的开端：
  见下面那条口径订正。

- `username` 唯一、`password` 走 §1 同一套 scrypt（`hashPassword`，不复刻算法）。
- **`role` 是必填、不是可选**：`required: ['username', 'password', 'role']`，枚举 `admin | user`，
  缺它或值不合法都是 `400 INVALID_PARAM`（`details.field = 'role'`）。
  **〔v1.15.4 订正：v1.15.0 首次写下这张表时把 `role` 漏在 body 外、写成可缺省，
  而 `src/api/routes/users.ts` 的 `createUserBodySchema` 从一开始就 `required` 它。
  漏写的形状是**一个照契约手写的请求必 400**：契约说可省、实现说不，
  这种漂移只会在"按文档集成"的人那里炸，而按代码抄的人永远看不见。
  订正方式是补进表里，不是把实现的 `required` 摘掉 —— 缺省 `role` 意味着
  建号方可以不知道自己建出来的是管理员还是普通用户，那是拿授面当默认值。〕**
- **不能删自己**：`username === 当前会话 username` → `400 INVALID_PARAM`
  （否则管理员把自己锁在管理面外面，而库已经空了、只能改库）。
- 不能删最后一个 `role=admin`（同上的锁死风险）。
- **"改用户"只有一条路径，且只改归属组**（**v1.15.6 订正**）：
  `PATCH /api/users/:username {groupId}`（见上）。**没有重置口令、没有改角色、
  没有改 `displayName`** —— 那三件事的答案仍然是**删掉重建**。
  **〔v1.15.0 原话是"没有任何'改用户'的端点……换角色 / 换组 / 忘口令一律删掉重建"。
  v1.15.6 把"换组"这一项改口**，因为它与"删了重建"的代价不成比例：删号会连带吊销
  那个人的全部会话，并把他从 `audit_log` 的 actor 里断成两截（前一段用旧名、
  后一段用同名的新行）—— 而他只是**进错了配额池**。而 `role` 那条理由原样成立，
  这正是"只开 `groupId` 不开 `role`"的判据：两者的失败形状不同（详见 ADR-0035 决策 2）。〕**
  `role` 一旦可改，"把自己降级"就成了一次普通请求，而降完就改不回来
  （§19.7 的最后一条锁死风险），这是一个只能靠"不给这个能力"防住的坑。
  **〔v1.15.4 补记：`web/src/pages/UsersPage.tsx` 因此只有建 / 删、没有编辑入口 ——
  前端不做那个表单，是因为那个表单背后没有端点。**〔v1.15.6 订正：这一页现在有
  **归属组**一个可编字段（就是上面那条 PATCH 的出口），其余仍不可编。〕**〕**
- **"忘口令 = 删掉重建"这一条作废（v1.15.9 / ADR-0038 决策 3）**：
  用户改**自己的**口令走 `POST /api/auth/password`（§1），**管理面仍然没有
  "重置别人的口令"这个能力**。
  - **两件事的差别不是"多一个少一个端点"，是"谁能发起"**：前者改的恒是**会话本人**
    （`req.auth.username`，没有路径参数），后者会让**一个管理员能静默接管任何账号**
    （写一个新散列、原主人再也进不来，而原主人**收不到任何通知**）。
    改自己的口令是"我的账号我说了算"，改别人的口令是"你的账号我说了算"。
  - **所以 `web/src/pages/UsersPage.tsx` 仍然没有"重置密码"入口** ——
    前端不做那个表单，是因为那个表单背后**仍然**没有端点。
    用户改密码的入口在两个外壳的账号菜单里（`ChangePasswordModal`，§19.3b 同一条纪律：
    它是会话级动作，不属于任何一页）。
  - **删号重建的代价**（这一条是订正的动机）：删号会吊销本人全部会话、
    并把他从 `audit_log` 的 actor 里断成两截。为一个改口令付这个代价，
    成本估计显然算错了 —— 这正是 ADR-0038 要订正的那一处。
- **口令明文只在 `POST` 那一次存在于调用方内存里**：响应不回它（库里只有 scrypt 散列，
  此后无端点可取回）。所以建号界面必须**当场展示 + 显式复制 + 明说"之后拿不到"**，
  且**不给"再次查看"按钮** —— 那个按钮点了只能失败，比没有按钮更坏。
  **改口令的端点同样只进不出**：`POST /api/auth/password` 收两个口令、回 `204`，
  响应体里没有任何口令或散列（§1）。
- 审计动作：`user.create` / `user.delete` / **`user.update`**（v1.15.6；**`auth.login` 不新增** —— 它已在写且已区分成败）。

### 19.8 登录响应扩展（§1）

`POST /api/auth/login` 的响应体**新增** `role`：

```json
{ "username": "alice", "role": "user", "expiresAt": "2026-10-18T12:00:00.000Z" }
```

- **纯新增可选字段**：老前端不读它，行为与 v1.15.0 之前逐字节相同。
- 为什么进登录响应而不是让前端再调一次 session：登录那一刻就要决定跳管理面首页还是
  `/console`，多一次往返只让"跳错地方"多一个时序窗口。`role` 是用户自己的属性，回给它不扩大暴露面。
- **〔v1.15.3 订正：本条与 v1.15.1 的④写的"跳 `/admin` ⇄ `/console`"里的 `/admin` 不存在。〕**
  前端管理面首页是 **`/dashboard`**（`web/src/router/router.tsx` 的 `path: 'dashboard'`），
  全仓没有 `/admin` 这个路由 —— 它是从"管理面"这个词顺手推出来的地址，落地时一对就发现对不上。
  实际分流是 `role=admin → /dashboard`、`role=user → /console`，两处（登录响应、根路径
  `HomeRoute`）**读同一个字段、同一个映射**，不各自写一遍。

### 19.9 DDL 与迁移

```sql
ALTER TABLE admin_users ADD COLUMN role      TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE admin_users ADD COLUMN group_id  TEXT REFERENCES groups(id);
```

- **纯加列，`SCHEMA_VERSION` 仍为 2**（迁移判据是"列在不在"，同 v1.1.1 / v1.4.x / v1.14.0）。
- `role` 的 `DEFAULT 'admin'` **不是随手填的**：老库里唯一的账号本来就是管理员，
  填 `user` 会让升级后**现有管理员失去管理面**（"升级即锁死自己"）。判据钉这一条。
- `group_id` **可空、无默认**：`NULL` = 未分配（§19.2 的可读降级）。
- `sessions` **零变更**。
- **v1.15.6 / ADR-0035 零 DDL**：管理组与"首个管理员进组"是**首启引导的动作**
  （`bootstrapAdmin` 在"库里一个账号都没有"时建组 + 写 `group_id`），不是表结构变更 ——
  三张表（`groups` / `gateway_keys` / `admin_users`）的列与本条**逐字不变**，
  `SCHEMA_VERSION` 仍为 **2**。**为什么种子不放 `migrate()`**：那是所有测试的公共前置，
  而既有用例里有按**全局计数**断言的（`console.spec.ts` 那条
  `SELECT COUNT(*) FROM gateway_keys` 恒等于 1）—— 种子进去就等于改了几十条用例的前置条件。

- **v1.15.8 / ADR-0037：`group_models` 纯加表**，`SCHEMA_VERSION` 仍为 2
  （纯加表先例：`gateway_error_events` §12.1 / `supplier_accounts` §15 —— 加表对老库零动作）：

```sql
CREATE TABLE IF NOT EXISTS group_models (
  group_id TEXT NOT NULL REFERENCES groups(id),
  model_id TEXT NOT NULL REFERENCES models(id),
  PRIMARY KEY (group_id, model_id)
);
```

  - `PRIMARY KEY (group_id, model_id)`：同一组对同一档案重复授权是**同一件事**，不是两行。
  - **两条显式级联（全库 `foreign_keys=ON` 且无 `ON DELETE` 子句，漏一条 = 删除操作 500）**：
    ① `deleteGroup` 事务内 `DELETE FROM group_models WHERE group_id = ?`（在删 `groups` 行**之前**）；
    ② `deleteUpstream` force 路径删 `models` 行**之前**
    `DELETE FROM group_models WHERE model_id IN (被删档案的 id)`。
  - **模型同步（§5）不产生孤儿授权**：`upsertModelFromSync` 对已存在的档案行**只 UPDATE、从不 DELETE/重建**
    （"未知不覆盖已知"，§5 同步映射表），`models.id` 在同步下**稳定** —— 所以授权行不会因一次同步失效。
    档案行真正消失只有一条路：`deleteUpstream`（force），那是 ② 覆盖的那条。
  - 老库升级**零动作**：新表建好即空，空表 = 所有组不限模型，与升级前行为逐字相同。

### 19.10 影响面汇总

| 面 | 变更 |
|---|---|
| `/api/*`（管理面） | **零端点变更**；`/api/access-info` 响应体不变，但**授面多放一种身份**读它（v1.15.1，见 §19.1 表）。**v1.15.8** `GroupDto` 非破坏新增 `authorizedModels`；**v1.15.9** `GatewayKeyDto` 非破坏新增 `label`（§4）。**v1.16.0 零新增、零删除端点**：`Upstream.supplier` 取值集合由 `[null,"tierflow"]` 扩成 `[null,"tierflow","tokenrhythm"]`（§2，**schema enum 一处**；`upstreams` 路由的 `supplierProp` enum 同步 + `requireSupplierUpstream` 错误文案），六个批量端点与 `rotate-key` **复用既有路径**，第二家与本家的差异全在驱动器（`src/supplier/tokenrhythm.ts`）与两张能力闸内（§15.14.1） |
| `/api/console/*` | **新增 3 个只读端点**（§19.2–19.4、§19.6）；**v1.15.8** `models` 按组收窄（零端点/零字段变更，集合语义变）；**v1.15.9 再加 4 个**：`GET /api/console/quota`（§19.3c）+ **三条写路由** `POST/PATCH/DELETE /api/console/keys[/:keyId]`（§19.3b，消费面唯一的一组写方法），`GET /api/console/keys` 响应非破坏新增 `keyLimit` |
| `/api/users*` | **新增 3 个管理端点**（§19.7）；**v1.15.6 再加 1 个**（`PATCH /api/users/:username`，只改 `groupId`） |
| `POST /api/auth/login` | 响应体**新增** `role`（纯新增） |
| `POST /api/auth/password` | **v1.15.9 新增**（§1）：改**会话本人**的口令；**不存在**"改别人的口令"这个能力 |
| `/v1/*` | **零端点、零路径变更**；网关 key 鉴权走 `key_hash`，与后台身份无关（**v1.15.8** 新增 1 码 `MODEL_NOT_AUTHORIZED` 是那版的事）。**v1.15.10 加一道类别准入 + `/v1/models` 每项加一格 `type`**（§10：既有四字段零变更、零新增码）。**v1.16.0 零改动** ——（第二家供应商是**管理面账号池**的概念，与数据面无关） |
| `src/gateway/` | **零改动**（选路 / 限流 / KeyPool / cooldown 一行不动；**v1.15.9 同样零改动** —— 自助签发的 key 走的是同一条 `key_hash` 鉴权）。**v1.15.10 动了路由版（`routes.ts` 准入闸）+ 端口（`ports.ts` 一个字段一个方法）+ 装配（`stack.ts` 把 catalog 也交给路由层）** —— 但**引擎、KeyPool、limiter、cooldown 仍是一行不动**：准入判在它们**之前** |
| DDL | 两列纯加列；`SCHEMA_VERSION` 仍为 **2**、零迁移分支（**v1.15.8** `group_models` 纯加表；**v1.15.9 零 DDL** —— `gateway_keys.label` 建表起就在；**v1.15.10 同样零 DDL** —— `models.type` 建表起就在，本版只是第一次有人**读**它；**v1.16.0 同样零 DDL** —— `supplier_accounts.supplier` 列建表起就在，本版只是把值域扩一项） |
| `ERROR_CODES` | **零新增**（越权 `FORBIDDEN`、未登录 `UNAUTHORIZED`、删自己 `INVALID_PARAM` 全是既有码；**v1.15.8 / v1.15.9 同样零新增** —— 到上限用 `UNPROCESSABLE`、旧口令错用 `INVALID_CREDENTIALS`、限速用 `TOO_MANY_ATTEMPTS`，全是既有码；**v1.16.0 同样零新增** —— §15.14 两张能力闸用既有 `UNPROCESSABLE`，逐行码走 `items[].code` 不进口径码表） |
| 审计动作 | 新增 `user.create` / `user.delete`（**v1.15.6** `user.update`；**v1.15.9** `auth.password`，而 key 自助**复用**既有的 `gateway_key.issue` / `.update` / `.delete`）。**v1.16.0 零新增** —— `supplier.*` 六个动作**不带供应商后缀**（本就按动作记），第二家进来不产生新动作 |
| 强制点 | **v1.15.9 唯一的新硬判据 `KEY_SELF_ISSUE_LIMIT = 10`**（`src/api/routes/console.ts`，按组的把数上限） |
| `web/`（前端） | **v1.15.3 交付**：`/console` 工作区三页 + `ConsoleLayout` + `consoleNav` + `SessionInfo.role` + `consoleApi` + 登录与根路径按 `role` 分流。**零新依赖、零后端改动**（这一版只是让界面追上 v1.15.0–v1.15.2 已做完的边界）；无自动化测试，判据是 `tsc --noEmit` + `vite build` 全绿 + 三个 console chunk 独立分包。**v1.15.4 追加**：`/users` 管理页 + `usersApi` + `UserDto`/`UserCreateRequest` + 两个弹窗（建号表单、口令一次性展示）—— **同样零后端改动**（§19.7 的端点 v1.15.0 就在，本版只是补上前端入口），同样无自动化测试。**v1.15.5 零改动**（本版是服务端闸门放行两条既有路径，前端早已在打它们；前端唯一的"改动"是它现在能登进来了）。**v1.15.9 追加四处**：API Keys 页（签发 / 改名 / 吊销 / 一次性明文 / 上限提示）、用量页额度卡、模型广场升级（接入地址 + 三端点清单 + 分类搜索）、两个外壳账号菜单各挂 `ChangePasswordModal`（放在 `src/components/` —— 放进 `pages/console/` 会让**管理面 chunk 依赖消费面 chunk**，方向反了）。**v1.15.11 追加**：账号入口从两个外壳的顶栏搬到**侧栏左下角**（1panel 观感）—— 菜单体收成共享的 `src/components/AccountMenu.tsx`（`ChangePasswordModal` 随之只挂载一份，顶栏不再有第二份入口；管理面顶栏只剩 `ConnectionBadge`），Sider 变一列三格（菜单自身可滚、账号格钉在底）。**v1.15.12 追加**：**收起侧栏的把手**从底部那条通栏色块换成**品牌行右侧的 28px 图标按钮**（`src/components/SidebarCollapseButton.tsx`，`Sider` 传 `trigger={null}` 关掉 antd 自带的）—— 两个外壳同一套，折叠态按钮不被裁、账号格随把手消失而**贴底**。**两版都是纯前端零后端改动**，无自动化测试，判据是 `tsc --noEmit` + `vite build` + 分包核查 + 双角色三视口真实浏览器走查（版本日志有全表） |
| `src/api/app.ts` 闸门 | **v1.15.5 放行两行**（`GET /api/auth/session` / `POST /api/auth/logout`，见 §19.1 表）；**v1.15.9 再放行一行**（`POST /api/auth/password`，字面路径 + 方法门）；v1.15.0–v1.15.4 的既有判定（`/api/console/**` + `GET /api/access-info`）**一字未改** |

**v1.16.0 的空调子们**：`/v1/*` **零端点、零路径变更**、`src/gateway/` **零改动**、
DDL 零（`SCHEMA_VERSION` 仍为 2）、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、
审计动作零新增、`/api/*` 零端点新增/删除、`web/` 零新依赖
（`web/src/api/types.ts` 一张能力位表 + 六处消费点改判定，无新包）。

**v1.15.10 的空调子们**：`/v1/*` 零端点变更（只加了一道本地准入与一格响应字段）、
DDL 零（`SCHEMA_VERSION` 仍为 2）、`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增、
**`engine.ts` / `key-pool.ts` / `limiter.ts` / `classify.ts` 零改动**、
`/api/*` 与 `/api/console/*` 零改动、`web/` 零改动。

**v1.15.9 的空调子们**（这一版改的东西多，所以把"没动的"列出来更省事）：
`/v1/*` 零变更、`src/gateway/` 零改动、DDL 零（`SCHEMA_VERSION` 仍为 2）、
`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增；`inConsoleScope()` **零改动**
（它只判前缀不判方法，三条写路由天然落在里面）。

v1.15.0（**2026-10-17，消费面用户与角色授面 —— 「普通用户前端」不是纯前端双视图** —— 新增 **§19 消费面 `/api/console/*`**（`GET /api/console/session|keys|usage|models` 四个只读端点 + `POST /api/users` / `GET /api/users` / `DELETE /api/users/:username` 三个管理端点）+ **§1 登录响应新增 `role`**（纯新增可选字段）；动机：Bo 要的是 1panel 报告 §1.4 的 **B 档**（真普通用户），A 档（纯前端 `/admin ⇄ /console` 双视图）做不出这个东西 —— 后端 `admin_users` 没有 `role` 列、`/api/*` 全量鉴权且只有一个身份，一个普通用户即使登进前端，他打的每个 `/api/*` 都会拿到**管理员能看到的一切**（上游 Base URL、上游 key 掩码、真实账号池、审计日志）；所以"加个用户前端"实际是**引入第二种身份 + 服务端授面**，`web/` 只是出口；**授面在闸门里按前缀判一次**（`user` 落在既有 `/api/**` → 403 `FORBIDDEN`），与 `inReadonlyScope()` 同一条纪律 —— 判据放闸门，新增路由不可能"忘了判作用域"；**`role` 每次鉴权从 `admin_users` 现读、不存 `sessions`**（现读只是一次主键点查，存了就有"改了角色旧会话还是老角色"的窗口）；**消费面全部是 `GET`，不含 key 签发** —— 网关 key 明文只存在于签发那一次（§4 铁律），把签发权下放给 `user` 等于组内任一成员可无限增发、共烧同一个配额池，要单独一条 ADR，本版明确不做。**〔v1.15.9 订正：那条 ADR 就是 ADR-0038 —— 消费面现在**不是**"全部 `GET`"，`POST` / `PATCH` / `DELETE /api/console/keys[/:keyId]` 三条写路由已下放（§19.3b），"无限增发"改用护栏消掉（`KEY_SELF_ISSUE_LIMIT = 10`，按组把数，到顶 `422`）。**没有被动过的是后半句的结论**：明文仍然只在 `201` 里出现一次、仍然没有"再取回"的路径 —— 它才是"只读"这个词真正在守的东西。〕**；**`usage_logs` 没有 user 维度**（按 `group_id` 记），所以"自己的用量" = 本组用量，`groupBy` 因此不含 `group`（按组分箱只会得到一根恒等的线）；**`GET /api/console/models` 与 §5 / §10 `/v1/models` 同一判据**（用户端看到的"能用哪些模型"必须与网关实际准入的集合一致，否则又是一个会骗人的信号）；**接入 URL 不新开端点**（新开就有第二份口径，ADR-0033 决策 2 同理由，这里禁的是第二个端点）；**DDL = 两列纯加列**（`admin_users.role TEXT NOT NULL DEFAULT 'admin'` / `admin_users.group_id TEXT REFERENCES groups(id)`），**`SCHEMA_VERSION` 仍为 2、零迁移分支**（判据"列在不在"，同 v1.1.1 / v1.4.x / v1.14.0）；`role` 的 `DEFAULT 'admin'` **不是随手填的** —— 老库里唯一的账号本来就是管理员，填 `user` 会让升级后现有管理员**失去管理面**（"升级即锁死自己"）；`group_id` 可空 = 未分配，此时三个列表端点回空 + `assigned:false`，**不是 500**（**〔v1.15.9：读端点从三个变四个** —— `GET /api/console/quota` 加了进来；未分配的它是各格 `null` 而非 0〕**）；**`/api/*` 管理面零端点变更、零字段变更**（`/api/access-info` 响应体不变且**不放行**给 `user` —— 它回 `hostGateway` 这类绑定地址，对普通用户无意义且易误读成可访问地址。**〔v1.15.1 订正：此句与 ADR-0034「影响面」表的裁定相反、且与本版 §19.5 的 URL 公式不相容，改口见 v1.15.1 ①②③〕**）；**`/v1/*` 零变更**（网关 key 鉴权走 `key_hash`，与后台身份无关）；**`src/gateway/` 零改动**（选路 / 限流 / KeyPool / cooldown 一行不动）；**`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增**（越权 `FORBIDDEN`、未登录 `UNAUTHORIZED`、删自己 `INVALID_PARAM` 全是既有码）；审计动作新增 `user.create` / `user.delete`（`auth.login` 不新增，它已在写且已区分成败）；判据见 ADR-0034「判据」表七条 + 三条变异（删掉前缀判定 / `WHERE group_id = ?` 改成读 `req.query.groupId` / `DEFAULT 'admin'` 改成 `'user'`）；**遗留三条不粉饰**：① **配额是组级不是人级**（`src/gateway/limiter.ts` 按 `groupId` 计 rpm/tpm/daily_quota，"多人共享同组"的真实语义是共享同一个配额池、同一批 key、同一份用量统计 —— 同组 10 人打满 `daily_quota` 时 10 人一起被 `QUOTA_EXCEEDED`；要按人拆必须动 `limiter` + `KeyPool`，是独立的一笔）；② **用户端不能自己发 key**（决策 3）；③ **没有自助改密码 / MFA / 账号锁定**（`loginLimiter` 是 IP 级的，单管理员 + 少数用户场景下收益低于成本）。**〔v1.15.9 订正这两条：② 与 ③ 的前半都被 ADR-0038 推翻** —— ② 被护栏消掉（同上），③ 的"改密码"从"收益低于成本"变成 `POST /api/auth/password`（写这条成本估计时用的是**删号重建**那个答案，而删号会吊销本人全部会话、把 `audit_log` 里的 actor 断成两截）；**③ 的后半（MFA / 账号锁定）与"身份绑定"继续不做**，理由从"收益低"改成"它要一整套新状态/新信任根，做半个比不做更坏"，且 Bo 已明确裁定不做。〕**）
