# 12. M6-A 余额查询：内置 preset、失败引导与自测端点（契约 v1.0.5）

- 状态：已接受（范围与 DoD 由 PM 于 2026-10-06 冻结，见群聊任务单）
- 日期：2026-10-06
- 决策者：管家 · 管理后端
- 提出人：Bo（业务指令：默认查询优先，查不到再让用户提供查询方法）

## 背景与问题

Bo 的指令把 M6-A 收敛成一件事：**余额查询要"开箱能出数"，出不来就明确引导用户自己提供查询方法**。落地前实测现状，缺口正好是这两头：

1. **查得到的那头缺"默认"**。`DEFAULT_BALANCE_QUERY` 是 `enabled:false / url:null`（`src/db/balance-query.ts:31`）。新上游若不手工配模板，`loadUsableTemplate` 直接抛 `UNPROCESSABLE`，批量刷新里表现为**全部 `skipped`** —— 引擎发达，但默认状态下一次请求都不发。
2. **查不到的那头缺"引导"**。`RefreshSummary` 已经正确分了四型（`ok / failed / unknown / skipped`，`src/api/services/balance-refresh.ts:33`），但**分型只到服务端为止**：前端拿到 `unknown: 50` 无从知道"是该换字段路径，还是该等上游恢复"。缺一个可读的指引字段。
3. **配模板那次尝试缺"当场验证"**。用户填完 `parse.balance` 只能等异步任务回结果，一轮几分钟。`balance-template/test`、`test-balance` 两个自测端点自 P3 起就挂在需求文档 §五.2（当时定性"未落地提案"），本次收回。

三条都不涉及扣减与对账（那两块已按 Bo 的"只显示余额"指令下线）。

## 备选方案

### A. 默认查询怎么做

| 方案 | 结论 |
|---|---|
| A1. 内置 preset 注册表，按上游 host 精确匹配，只读不落库 | **采纳（本批仅注册 `openai`）** |
| A2. 兜底"探测式"默认模板：对未知上游轮询一组常见端点/字段路径 | 否（见下） |
| A3. 把默认值直接写进 `upstreams.balance_query` 落库 | 否。会让"用户显式配的模板"与"系统预填值"在库里无法区分，日后预填值升级要么静默改变在跑的上游行为，要么需要一次数据迁移 |

**A2 被否的三条硬理由**（这是本 ADR 最需要留痕的一处）：

- **域名不可判**。new-api / one-api 是自建部署，host 任意，`https://api.某公司.com` 无法从域名判断它是什么。按 host 猜等于瞎猜。
- **单位不可判**。one-api 系的 `quota` 既不是分也不是元，默认 `500000 quota = 1 USD`，且这个比值**部署方可改**。套进 `unit: 'cents'` 会算出一个**看起来完全合理、但整体差若干数量级**的余额 —— 这是比"未知"严重得多的失效模式：未知会被前端标灰，错值会被当成真值展示。踩「禁假数据」。
- **鉴权对象不同**。`/api/user/self` 类端点要的是用户 access token，而 `upstream_keys` 里存的是转发用的 `sk-` 接口 key。默认模板拿着接口 key 去打，稳定 401 —— 而 401 在当前分型里是 `failed`，会把"这个上游压根不支持默认查询"误报成"上游挂了"。

所以默认查询只覆盖**口径与鉴权都能确认**的上游，其余走 `skipped` + 引导。这不是偷懒，是 Bo 那句"查不到再让用户提供查询方法"的正面实现：**猜不出来的就不猜，直接问**。

### B. 自测端点的语义

| 方案 | 结论 |
|---|---|
| B1. 同步执行一次查询、**不写库**、回全量诊断信息 | **采纳** |
| B2. 复用异步刷新任务，前端轮询 | 否。自测的全部价值是"改字段路径 → 立刻看到结果"的秒级回路，异步把它变成又一轮几分钟的等待 |
| B3. 自测成功就顺手把余额写库 | 否。测试是**预览**语义，写库会让"我只是试试"这种操作产生持久副作用；真要落库有 `PUT /api/keys/:id/balance` 与 `refresh` 两条明路 |

### C. 失败引导的形状

| 方案 | 结论 |
|---|---|
| C1. 新增 `hintCode` + `hint` 两个字段（非破坏新增） | **采纳** |
| C2. 新增 `BALANCE_UNKNOWN` 错误码进 `ERROR_CODES` | 否。PM 已冻结本轮不新增错误码；且"查不到余额"不是 HTTP 层的失败，刷新任务本身是成功的（`202` + `ok` 计数），塞进错误码表会让它具备一个不该有的 HTTP 状态 |
| C3. 前端自己按 `unknown/failed/skipped` 计数推断 | 否。三型计数**不足以**定位原因：`unknown: 50` 既可能是字段路径错（改模板），也可能是上游全账户无额度返回了空对象（等着就行）。原因在服务端才知道，就该由服务端说 |

## 决策

### 1. 余额查询解析顺序（三段，互斥、有优先级）

```
① 用户模板 enabled=true        → 现有模板引擎（契约 §2 balanceQuery，零改动）
② host 命中内置 preset          → 内置执行器（本批仅 openai）
③ 都没有                        → skipped，附 hintCode=BALANCE_QUERY_UNSUPPORTED
```

**preset 永不覆盖用户模板，永不落库**：它是每次查询时现算的判定，库里只有用户自己的 `balance_query`。`skipped` 的语义不变（"压根没发请求"），只是现在多带一句为什么。

### 2. 内置 preset 注册表（本批 1 个）

| id | 匹配 | 执行 | 单位换算 | 依据 |
|---|---|---|---|---|
| `openai` | host = `api.openai.com` | `GET /v1/dashboard/billing/subscription` − `GET /v1/dashboard/billing/usage` | USD → 分（×100） | 总额度减已用是官方唯一能拿到"剩余"的算法，单请求取不到 |

`balance` = `subscription.hard_limit_usd − usage.total_usage / 100`（`usage.total_usage` 单位是美分），结果 × 100 到分。

**只有这一个**。理由同上 A2：多注册一个就需要一份该上游的实测响应（口径 + 鉴权），没有实测不进注册表。要扩注册表，走同一条 ADR 补遗。

### 3. 新增两个自测端点

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/upstreams/:id/balance-template/test` | 用**草稿模板**（body 传，可缺省＝用已存模板）打一次真实查询，回诊断 |
| `POST` | `/api/keys/:id/test-balance` | 用该 key 所属上游的**生效查询方式**（用户模板或 preset）打一次，回诊断 |

两者共用同一个响应体 `BalanceTestResult`，且**都不写库**（不碰 `balance_cents` / `balance_source` / `balance_updated_at`）。

草稿模板**不进库、不回显替换后的串**：与 `refresh` 同一套安全纪律（`{key}` 只在执行栈内替换）。

### 4. 失败引导字段

`hintCode` + `hint`，出现在①刷新任务的 `result`、②自测响应。**不进 `ERROR_CODES`，不影响 HTTP 状态**。

| `hintCode` | 何时 | 前端该做什么 |
|---|---|---|
| `BALANCE_QUERY_UNSUPPORTED` | 无用户模板且无 preset（`skipped`） | 引导用户填查询方法（打开自测表单） |
| `BALANCE_PARSE_MISMATCH` | 请求成功但取值路径取不到（`unknown`） | 引导用户改字段路径，就地再自测 |
| `BALANCE_UPSTREAM_UNREACHABLE` | 不可达/超时/非 2xx（`failed`） | 提示稍后重试，不引导改配置 |
| `BALANCE_AUTH_REJECTED` | 401/403（`failed` 子型） | 提示 key 可能失效或该端点需要另一种凭据 |
| `null` | `ok` 且解析出数 | 无需引导 |

### 5. `balancePreset` 只读字段（Upstream 对象）

```json
"balancePreset": { "id": "openai", "label": "OpenAI 官方计费", "matchedBy": "host", "effective": false }
```

`effective` = "当前真正生效的是它"（即用户模板未启用）。未命中任何 preset 时为 `null`。**只读**，`POST`/`PATCH` 传入一律忽略（不是参数错，是可推导字段）。前端据此在余额查询卡片上标注"已自动识别为 …"，让用户知道不配模板也能出数。

### 6. token 维度补缺（`GET /api/stats/usage`）

现状每个点只有 `tokens`（`SUM(total_tokens)`）与全局一个 `isEstimatedTokenCount`，画不了"输入/输出对比"，也标不出**哪一段**是估算。补三个非破坏字段：

```json
{ "t": "...", "requests": 120, "tokens": 84000,
  "promptTokens": 60000, "completionTokens": 24000, "estimatedTokens": 0,
  "costCents": 320, "errors": 1 }
```

`costCents` **保留不动**（本轮"不带钱"指不新增计费/扣减，不是删字段 —— 删已冻结字段是破坏性变更，且它与本决策无关）。

## 影响

- **后端（管家）**：新增 preset 注册表与执行器、两个路由、`hint` 派生、usage 聚合补三列。**无 schema 变更**（preset 不落库、hint 不落库，usage 三列全由既有 `usage_logs` 列聚合得出）。`ERROR_CODES` 零新增。
- **前端（画师）**：新增"余额查询配置 + 自测"表单与失败引导；`balancePreset` 用于来源标注；用量图可加输入/输出双线。**无破坏性变更**。
- **网关（路由者）**：**零影响**。全批不碰 `src/gateway/**`，不碰 `/v1/*`，不改热路径。`bench:ttfb` 属回归确认（证不劣化），非新增判据。
- **契约**：新增 2 端点 + 4 个响应字段，无字段改名/删除/类型变更 → 补遗 v1.0.5，`v1.0-frozen` 主版本不动（同 v1.0.1–v1.0.4 惯例）。
- **安全**：`{key}` 替换语义不变；自测响应里的上游原文**必须抹掉所有明文 key 出现**并截断；草稿模板与替换结果不落盘、不进日志、不进审计 detail。

## 门禁核验

（实现完成、四闸跑完后回填本节。）

## 已知缺口（不在本次范围）

- **preset 只覆盖 OpenAI**：其余上游一律走"引导用户提供查询方法"。扩注册表需要该上游的实测响应，逐条走 ADR 补遗。
- **余额自动扣减、对账零误差**：按 Bo 指令下线，不在 M6-A。`price_input_per_1k` / `price_output_per_1k` 保留为可选展示字段（允许 NULL），不参与路由过滤、不参与扣减、不显示推算值。
- **结构化日志 + metrics**：转 M6-B（metrics 有 `/api/*` 鉴权口径需另拍）。
- **`BALANCE_UNKNOWN` 错误码**：本轮不新增；若日后确需，单独走契约 + ADR 双轨。
