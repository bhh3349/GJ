# 24. 模型能力探测：给 `capabilities` 加一个机器来源

- 状态：**已落（2026-10-14；Bo 要求 + 管理面实现）** —— 契约 §5（v1.11.0）+ §10 只加字段。
- 日期：2026-10-14
- 决策者：Bo（「我就是要实现自动检测，获取模型后。如果模型无法返回具体参数，我们就要去测试模型的参数，然后我们路由的模型，我用我们的 url 和 key 获取模型要能识别这些模型的功能」）+ 管家（后端落地 / 契约）
- 关联：ADR-0009（模型同步的字段映射 —— 本 ADR 是它写死的**重开触发条件**的第一次命中）、ADR-0021（出口预算接缝 —— 探测是第九类出站）、契约 §5 / §10 / §12.2 / §13.4

## 背景与问题

上游 `/v1/models` 只回 `{id, object, created, owned_by}`，能力 / 上下文长度 / 价格**一个都不给**（ADR-0009）。
因此模型档案的 `capabilities` 从第一天起恒为 `[]`，唯一的写入途径是管理员 `PATCH`。

Bo 的要求是**把这件事自动化**：拉到模型之后，由系统自己去问模型有什么能力，并且
**「我用我们的 url 和 key 获取模型要能识别这些模型的功能」** —— 即结论要能被下游（`GET /v1/models`）看见。

ADR-0009 的文件头与「M4 评估结论」两处写死了重开条件：

> 同步开始从上游产出非空的 `capabilities` / `contextLength` / `price`（即 `model-sync.ts` 的解析器不再只读 `id`）
> —— 那一刻「人工置空被同步覆盖」从不可能变成可能；
> 出现第二种自动写入方（**上游探测**、价格抓取任务等）……

本 ADR 就是那条条件的**第二次命中**（「上游探测」）：档案的 `capabilities` 从此**有了第二个写入方**。
所以本笔必须同批解决「管理员手工值被机器覆盖」这个静默丢失，否则不如不做。

## 决策

### 1. 新端点 `POST /api/models/:id/probe`（§5）

请求 `{targets?, apply?}`，响应 `200 ModelProbeResult`（同步返回，不打任务）。
四项能力 `vision` / `stream` / `function_call` / `json_mode`，各打一发**能力专属**的上游请求，
**只看响应、不解析任何文案**：`2xx` 为 `true`、上游回 `4xx` 为 `false`、
`401/403/404/429/5xx/超时/网络` 为 `null`（判不出）。

`supported` 是**三态**而不是布尔 —— 因为「上游明确拒绝」与「我们没问出结论」是**两件事**，
把它们压成一个 `false` 就等于把「未知」写成「不支持」，正是 ADR-0009 一直在防的那类假数据。

请求体由**服务端内置**，不接受调用方注入：`true` 的语义建立在「上游真的把这次请求处理了」之上，
一旦请求体可注入（例如塞一堆不可用参数），`2xx` 与 `4xx` 都不再只反映能力，判据当场失效。

`contextLength` **本笔不做**：撞窗口反推烧的是真流量、且**给不出数字**。
留 `null`，上游哪天给字段再零成本吸 —— 与 ADR-0009 §1「永不编造」同向。

### 2. 唯一 schema 变更：纯加两列

- `models.capabilities_source`：`'manual'` | `'probe'` | `NULL`
- `models.last_probed_at`：ISO8601 | `NULL`

走既有的 `hasColumn()` + `ALTER` 通道（v1.1.1 / v1.4.x / v1.7.1 三次先例）。
**判据是"列在不在"，不是版本号**，所以纯加列 ⇒ **`SCHEMA_VERSION` 仍为 2、零迁移**。

**没有给全表加 `manual_fields`**（ADR-0009 备选 F）：那是「哪些字段被人工碰过」的布尔集合，
而本笔真正要回答的是**「这一格是谁写的」** —— 一个**带值的来源标记**，同 `balanceSource`（ADR-0003）
与 ADR-0009 M4 结论第 4 点指出的形状。一列 `capabilities_source` 足够，且不引入需要回溯填充的历史列。

### 3. 来源规则：`manual` 永不被 `probe` 覆盖

1. `PATCH` 传了 `capabilities` ⇒ `capabilities_source = 'manual'`；**没传就不动**。
2. 探测只在 `NULL` 或 `'probe'` 时写，且**只写 `true` 的项**；`false` / `null` **从不写库**。
3. 落库是**一条条件 `UPDATE`**（`WHERE id=? AND (capabilities_source IS NULL OR capabilities_source <> 'manual')`）
   —— 单语句原子，**不需要 `revision` 参数**（并发下 `PATCH` 赢、探测那次丢弃），因此不与乐观锁竞态。
4. `last_probed_at` 一次不漏地刷（无论 `apply` 与否、无论这次有没有覆盖）。

于是档案卡**三态可分辨**：非空 = **有**该能力 / `[]` + `probe` = **问过、不支持** / `[]` + `NULL` = **未知（还没问过）**。

### 4. 计量隔离四条（要害）

1. **零 `reportFailure` / `reportSuccess`** —— 探测**不进网关引擎**。不支持能力时上游回 `4xx`，
   那是**模型的性质、不是 key 的故障**；从引擎走的话，一次能力探测会把一把好 key 打进冷却、
   还拉低业务成功率。这一条与 §13.4 助手「**计入** key 健康」恰好相反，别照着助手抄。
2. **零 `usage_logs`** —— 不污染 §6 `overview` / `usage` 的 QPS、成功率、token。
3. **出站必走装配层注入的 `fetchImpl`**（接线层已包成 `fetchFor(egressId,'management')`，ADR-0021 决策 4）。
   探测是**第九类出站**，占**同一个出口桶**、走 `'management'` 消费者（**不得占数据面保留额度**）。
   旁路 = 在 IP 预算上再开一个洞 —— 而 §16.7 实测的出口预算只有 ≈8 次请求。
4. **计量随动作走**：只出现在响应 `requests`、同步任务 `result.probe`、审计 `model.probe`。
   **不并进 §12.2**（`assistant.*` 是常驻流量计量，本端点是离散动作、次数由审计查得到）。

### 5. 自动补探（Bo 要的"获取模型后自动识别"）

`POST /api/models/sync` **尾部**对候选补探，形成闭环：

- 候选 = **本次同步涉及**且 `capabilities_source IS NULL` 的模型；`manual` / 已 `probe` 的跳过（不重复烧）。
- **默认开**，两个闸都能关：单次 `{"probe": false}` / 全局 `MODEL_PROBE_ENABLED=false`。
- **单轮上限 `MODEL_PROBE_MAX_MODELS`**（占位 `10`）+ **出口预算拒绝即停**。
  Bo 的决定是"要自动化"，所以默认开；但花钱的上限留在装配侧，不由调用方随意放大。
- **探测失败不改任务成败**：`syncModels` 的成败判据**只用列表拉取结果**；
  用 §16.7 的话说，「模型同步失败」与「探测没问出结论」是两个完全不同的分诊对象。

## 备选方案（否掉的）

| 方案 | 结论 |
|---|---|
| A. 前端按钮 + 人手 `PATCH`（零契约） | 否。Bo 明确要「自动检测」，按钮不叫自动；且人手 `PATCH` 写出来的是 `manual`，机器来源仍然不存在 |
| B. 把探测并进 `POST /api/models/sync` 自动产出非空 `capabilities`（不区分来源） | 否。这正是 ADR-0009 §4 说的静默丢失：管理员 `PATCH` 的能力下一次同步就没了 |
| C. 吸上游 `supported_endpoint_types` 进 `capabilities` | 否。语义单位是**端点类型**不是**模型能力**；塞进闭集枚举会多出一个前端点了查不出结果的选项，而真正想要的 `stream` 一个也没拿到。要留只做**独立只读字段** `endpointTypes`（另开一笔） |
| D. 撞窗口反推 `contextLength` | 否。烧真流量且给不出数字 |
| E. 探测写 `usage_logs` / 报 key 健康（"统一口径"） | 否。见决策 4：4xx 是模型的属性，记账会污染 key 健康与业务成功率 |
| F. 给全表加 `manual_fields` | 否。见决策 2：要的是"谁写的"带值标记，不是"是否被人工碰过" |

## 影响

- **后端（管家）**：`src/api/services/model-probe.ts`（探针与判据）、`src/api/routes/models.ts`（端点 + `PATCH` 写 `manual` + 同步尾部补探）、`src/api/services/model-sync.ts`（候选筛选 + `result.probe`）、`src/db/repo/models.ts`（条件 `UPDATE` + 两个只读字段）、`src/db/schema.ts`（两列 `ALTER` + DDL 文本）。
- **网关（路由者）**：`/api/models/:id/probe` 是管理面端点，**网关不参与探测**；但 §10 `GET /v1/models` **只加字段**（`capabilities` / `contextLength` / `endpointTypes`）在**路由者车道**落 —— 档案既然探得出，就得传得出去（Bo 的最后半句）。
- **前端（画师）**：档案卡渲染三态（「有 / 已探测·不支持 / 未知」）+ `capabilitiesSource` 徽标 + 探测按钮。
- **契约**：§5 新增「能力探测」小节 + 端点表一行 + 字段表三行；§10 一行加字段；版本号 → v1.11.0。

## 门禁与边界

- `ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` **零新增**（`reason` 五枚是**逐端点诊断字段**，与 §15.4 `SUBSCRIPTION_NOT_FOUND` 同一条：不进口径码表）。
- `/v1/*` **只加字段**：既有 `id` / `object` / `created` / `owned_by` 四字段形状与「与档案 `enabled=true` 逐项 0 差异」的集合口径**零变更**。
- `SCHEMA_VERSION` 仍为 2、**零迁移**（纯加列）；`src/gateway/` 的**探测路径**零改动（探测不进引擎）。
- 已知边界（写在这里，不留待发现）：`endpointTypes` 本期**恒 `null`**（未采集，字段是先登记语义、不是先占位）；图像生成 / 音频 / embed / rerank 四类**不发请求无法证伪**，仍留未知；探测对**每模型 × 每能力**各一发，全量补探的花费 = 模型数 × 4，靠 `MODEL_PROBE_MAX_MODELS` 与预算拒绝封顶。
