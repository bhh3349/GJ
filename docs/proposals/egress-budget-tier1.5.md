# Tier 1.5 出口级令牌桶 —— 扩域方案（v2：对齐 ADR-0021 端口签名 · 草案）

- 作者：路由者（`src/gateway/` 实现面；ADR-0021 决策 1 定的"处置权在 `src/gateway/egress.ts`"）
- 冻结依据：`docs/api-contract.md` §16.7 Tier 1.5 / §15.5 / §7 `egress_cooldown`
  / `docs/adr/0020-egress-ip-rate-limit.md` / **`docs/adr/0021-egress-budget-seam.md`（端口签名与共用口径）**
  / ADR-0017 补遗草案 v1.7.0
- **本稿对 ADR-0021 的立场**：端口签名与共用口径**照单接受**（同步签名、不排队、数值全注入、
  唯一集散点 = fetch 装饰器、缺省逐字节同现状、快照签名逐字不动）；**五处要改**，见 §4 ——
  其中两条是**实现照原样写会当场出错**（自伤 30min、假冷好 key），三条是**缺件**（保留额度、
  唯一归一化、成功入口）。这五条都动端口形状或动冷却语义 ⇒ **必须在冻结前裁**。
- 本草案的边界：**定结构、定接口、定作用域；数值全部占位**。落到契约正文字句的活归管家（S1）。
- 前置事实（路由者实测，2026-10-07）：**出口预算 ≈5–6 请求/窗口、成功请求同样计入、按出口 IP 聚合、
  与账号/key 无关**；429 不带 `Retry-After`、不带 `X-RateLimit-*`；恢复约 1–2 分钟。

---

## 0. 结论（先说结果）

| # | 结论 | 谁需要知道 |
|---|---|---|
| 1 | **闸是"提交速率闸"，不是"并发闸"** —— 实测口径是"打出去几次"、成功也计入 ⇒ token 在**提交那一刻消耗、不退还**。并发度（`REFRESH_CONCURRENCY=4`）与它正交，不进桶。 | 管家（§14 / §15.5 口径） |
| 2 | **桶与冷却表是同一个对象**（ADR-0021 决策 1/5）：`src/gateway/egress.ts` 的 `createEgressCooldown()` 扩成闸，**不新起第二个实例** —— 两个实例 = 双倍预算 = 静默失效，且 §7 帧会读到另一个对象。 | 双方（装配） |
| 3 | **§14 自动同步不是"结构上不可能"，是"突发打出去了"** —— 26 请求/轮、1 轮/15min ≈ 1.73 req/min，在 5–6/窗口下**放得下**；打爆它的是 `REFRESH_CONCURRENCY=4` 把它压进同一秒。桶把它摊平即可，不必永久关死（但标定前仍按 PM 裁决先 `BALANCE_SYNC_MINUTES=0`）。 | 管家 + PM（排期） |
| 4 | **一律不排队**（ADR-0021 决策 6）—— 我草案 v1 里的 `acquire(maxWaitMs)` **按决策 6 删除**。代价写明：手动全量刷新会**立刻**回一批 `failed`（不再是"卡 47 秒后成功"），与前端的二次确认文案配合正好。 | 管家 + 画师 |
| 5 | **桶拒绝不写冷却，只终止本轮轮换**（§4 异议 2）—— 照 ADR-0021 决策 5 行 1 原样写，**一次手动刷新 = 数据面 30 分钟黑洞**（实测推演见 §4）。 | PM + 管家（**需裁**） |

---

## 1. 结构：一个对象、端口在中性目录、实现在 `src/gateway/`

```
src/egress/            ← ADR-0021 决策 1（只依赖标准库；管家落）
  port.ts         EgressGate 接口 + EgressReservation/EgressVerdict + permissiveEgressGate
  fetch-gate.ts   createEgressFetch(gate, inner?) + egressIdOfUrl()
        ▲                                  ▲
        │ import（两侧都消费，放 src/api 会让 gateway 反向 import 管理面）
src/gateway/egress.ts     ← 我落：闸的实现（令牌桶 + 冷却态 + 检测器状态），**同一个实例**
src/api/app.ts            ← 管家落：ApiContext.egress / BuildAppOptions.egress（形状同 assistant）
src/server.ts             ← 接线：造一次、注入两处（buildApp + 网关装配）
```

- 实现体不 import `src/api` / `src/db`（AGENTS.md §8），只用 `src/gateway/cooldown.ts` 的既有阶梯常量。
- **桶是"闸"的第三块状态，不是第三个类**：`egress.ts` 内部 `Map<egressId, EgressState>` 加两个字段
  （`tokens` / `refilledAtMs`），`cool` / `noteSuccess` / `snapshot` 逐字不动。
- `snapshot()` 签名**逐字不改**（契约 v1.5.0 冻结）—— 桶**不进** §7 帧：帧表达的是"上游在限流我们"
  这层事实，桶是额度、不是冷却（§9 第 5 条）。

---

## 2. 桶模型

```
tokens(egressId) ∈ [0, capacity]
refill = capacity / windowMs                      # 恒定速率补桶
reserve(egressId, consumer):
  refill()
  floor = consumer === 'data' ? 0 : reserveForData
  if (tokens - 1 < floor) return {allowed:false, reason:'budget', retryAfterMs: msToNextToken()}
  tokens -= 1; return {allowed:true}
```

三条刻意选择：

1. **提交即消耗、无 `release`。** 做成"持 token 到响应返回"就是并发闸，与实测口径（成功也计数、
   与耗时无关）不符，还会把慢请求变成对别人的限流。
2. **恒定速率补桶，不是整窗回满。** 整窗回满会在窗口边界放出一次 `capacity` 大小的突发，而窗口语义
   未知（可能滑动）；恒定补桶对两种窗口都安全，代价是我们**可能比上游更保守**（刻意的安全余量）。
3. **先查冷却再取 token**：冷却期内**不取 token**（不消耗预算），直接回既有 429；两者都拒绝时
   `Retry-After` 取较长者。

---

## 3. 作用域（ADR-0021 决策 6 的口径：一律不等）

| 车道 | 消费者 | 取件位置 | 空桶时 |
|---|---|---|---|
| 数据面 | `/v1/chat/completions`、`/v1/models`、助手聊天（同池） | 引擎每次上游尝试前的 fetch 装饰器 | 429 `RATE_LIMITED` + `Retry-After`，**0 次真实尝试、不换 key、不计 key 健康** |
| 管理面 | §14 三个刷新端点（含自动同步） | 同上（`fetchImpl` 注入缝） | 本轮照常结束，逐项记 `failed`；自动同步按 ADR-0017 补遗 2 的新判据推进退避 |
| 管理面 | §15.2 `import` / `refresh` / `keys` / `keys/sync` | 同上 | 逐项不等、**整批不中止** |
| 管理面 | §15.2 `:id/login` / `:id/test`（同步 200） | 同上 | 不等，直接拒（同步端点就该快速失败，见 §0 结论 4） |
| 管理面 | 探活 | 同上 | 不等；**失败不得被读成"这把 key 坏了"** |

**计价单位 = 一次上游 HTTP 请求，不是"一把 key"。** §15.5 明载「刷新 = 2 请求/账号
（`/api/user/self` + `/api/subscription/self`）」⇒ 刷新一个账号消耗 **2 枚** token；一轮 26 key
全量刷新 ≈ **52 枚**。这条不写清，管家侧会按"1 key = 1 枚"建模，把预算算大一倍。

**唯一集散点 = fetch 装饰器**（ADR-0021 决策 4）：`breaker` 不在二十来个调用点各加一道 ——
走 `stack.ts` 那条"一次接好、接漏了不报错只静默失效"的同一个教训。

---

## 4. 五处要改（签名级异议 —— 请 PM / 管家在冻结前裁）

> 前两条是**照 ADR-0021 原样实现会当场出错**；后三条是**缺件**。逐条给推演，不给结论。

### 异议 1：`reserve()` 没有 `consumer` 参数 ⇒ 保留额无从实现，管理面可合法饿死数据面

- ADR-0021 决策 3：`reserve(egressId: string): EgressReservation`。
- 后果：管理面一次全量刷新 = **52 枚 = 8.7 个窗口**的额度，可以**合法**把整段预算吃干；
  客户端流量在随后整段窗口里全 429。这正是 §16.7 要治的"自伤"的下一个形状 ——
  一个后端动作把数据面打死。
- 建议：`reserve(egressId, consumer: 'data' | 'management')`，`reserveForData` 占位 **1**。
- **占位为什么是 1 而不是 `ceil(capacity/2)`**（我草案 v1 写的 3 是错的）：capacity=5 时
  `ceil(5/2)=3` ⇒ 管理面只剩 2 枚/分钟 = **30 枚/15min < 52** ⇒ **自动同步一轮永远跑不完**，
  退化成长期欠账（每轮欠 22 枚），PM 的"先关自动同步"就从"止血"变成"唯一出路"。
  占位 1 ⇒ 管理面 4 枚/分钟 ≈ 60 枚/15min ≥ 52，一轮约 10 分钟跑完；数据面任何窗口都至少留 1 枚。
  标定回来后按数据面/管理面实际占比回填，**只改数、不改结构**。
- 这一条与 ADR-0021 决策 8 的 `{capacity:5}` 是**配套**的：没有保留额时 capacity 就是"先到先得"，
  谁先打谁赢，与管理面是不是 26 连发无关。

### 异议 2（最要紧）：决策 5 行 1「预算拒绝 ⇒ 立刻 `cool(egressId, …)`」在现有 `cool()` 语义下**会推进升档阶梯**

- 现有 `src/gateway/egress.ts` 的 `cool()` 每次调用 `consecutive += 1`，时长按
  `cooldown.ts` 的阶梯取 `min(max(reasonBase, ladder(n)), 30min)`；`s.until = max(s.until, now + ms)`
  ⇒ **只增不减**。
- 一次手动全量刷新（capacity=5、52 请求、`REFRESH_CONCURRENCY=4`）的推演：
  前 5 枚放行，**第 6 枚起每次拒绝都调一次 `cool()`**：

  | 第几次拒绝 | `consecutive` | 阶梯档 | 出口冷却 |
  |---|---|---|---|
  | 1 | 1 | 0 | 60s |
  | 2 | 2 | 1m | 60s |
  | 3 | 3 | 5m | 5m |
  | 4 | 4 | 15m | 15m |
  | 5 及以后 | ≥5 | 30m（封顶） | **30m** |

  ⇒ **一次点击、几十毫秒内爬满封顶档**；此后 `until` 只增不减，数据面 **30 分钟**黑洞。
- 更坏的一点：这不是"上游在惩罚我们"，是**我们自己的算术** —— §7 `egress_cooldown` 帧却会把它
  当作"上游限流中"播给前端，排障方向反掉（与 ADR-0011 §4 修掉的那类错误同形）。
- 建议（我倾向的落法）：**桶拒绝不写冷却**，改为「**终止本次请求的候选轮换** + 429 +
  `Retry-After = ceil(到下一枚 token 的毫秒)`」。三种效果全部保留：0 次真实尝试、不记 key 失败、
  不换 key（轮换放大器仍被掐断），而：
  - **保留额才真的成立** —— 否则冷却把数据面一起挡在门外，`reserveForData` 形同虚设（异议 1 的前提）；
  - 阶梯只由**上游证据**推进 —— 阶梯表达的是"对面在惩罚我们"的强度，我们自己的补桶算术不配用它；
  - §7 帧语义干净（只反映上游证据）。
- 若坚持"拒绝即冷却"，**最低限度**必须：时长 = 到下一枚 token 的时间，且**不 `consecutive += 1`**
  （即 `cool()` 要拆出一条"不推进阶梯"的写入路径）。那仍会改 §7 帧语义，所以仍属契约面、仍要 PM 裁。

### 异议 3：决策 4「装饰器在响应为 429 时调一次 `observeLimited`」**做不到**，且照字面做会**假冷好 key**

- 装饰器手上只有 URL（→ `egressId`），**没有 `subject`（keyId / accountId）、也没有 `correlationId`** ——
  这两个量在引擎的尝试循环里，fetch 调用栈上不可见。数据面唯一能"编"出来的是把 key 塞进请求头，
  那是把凭据散进更低的层（ADR-0006 同纪律，不做）。
- 而且照字面做必错：桶拒绝时装饰器**合成**的 429 会被引擎当上游证据走既有 429 分支
  （`src/gateway/engine.ts:438`）⇒ `observeLimited(subject = 那把 key)` ⇒ 第 1 把记 key 失败 ⇒
  **每次窗口打满时，27 把候选里的第一把都被假记一次过**，反复几次就真进 key 冷却 ——
  正是 §16.7 归因纪律明令禁止的"把好 key 停掉"（`egress.spec.ts` 开头第 1 条）。
- 建议：
  1. 装饰器只做 `reserve` + 合成 429，并给合成的响应打一个**本地标记头**
     （`x-sub2api-egress-local: 1`）——**仅进程内**，不随出站请求上行、不透给客户端；
  2. `observeLimited` 由**知道 `subject` / `correlationId` 的调用方**调：数据面 =
     `engine.ts:438` 那处既有的 `egressKeys429` 改为 `gate.observeLimited(...)`；管理面 = 各自循环喂
     `correlationId = 一轮刷新 / 一个批量任务`。判据**只留闸里一份** —— `classify.ts` 的
     `EgressLimitDetector` / `neverEgressLimited` / `egressLimitedOnSecondKey` 随之退休
     （它俩是"识别规则悬空件"的过渡形态，转正后就是同一个判据的第二个实现）；
  3. 引擎 429 分支见到本地标记 ⇒ 走**既有 `skippedEgress` 那一族**（0 次真实尝试、不计 key 健康、
     终态仍是 `egressRateLimitedError`）⇒ **零新客户端形状、零新错误码**。
- 附带一条 ADR 没写的规则：`egressIdOfUrl` **解析不出 URL ⇒ 返回 `null` ⇒ 放行**（fail-open）。
  理由与 `egressHostOf` 的 `null` 语义同向：宁可退回旧的 key 级处置，也不拿一个假出口去冷掉别的上游。

### 异议 4：决策 2 的"归一化只有一份实现"**目前不成立** —— 现网已有第二份

- `src/gateway/egress.ts:egressHostOf(baseUrl)` 已被 `engine.ts` / `stack.ts` / `egress.spec.ts` 使用，
  规则（`new URL(baseUrl).host` 小写）与 `egressIdOfUrl` **语义相同但不是同一个函数**。
- 两份并存 = ADR-0021 决策 2 自己点名的"同一个出口两个键"的雷**当场就埋下**（冷却各冷一半、
  预算各扣一份，等于把 5–6 变成 10–12）。
- 建议：ADR 里点名 **`egressHostOf` 删除**（`src/egress/egressIdOfUrl` 成为唯一实现），
  `engine.ts` / `stack.ts` / spec 改引用；过渡期若想留兼容，只留一行 re-export 且**加 spec 断言两者同值**。
  （这条动的是我 lane 的既有代码，但 ADR 正文要点名，否则下一个人还会照着 `egressHostOf` 写。）

### 异议 5：端口缺"成功"入口 —— `noteSuccess` 是阶梯退档的唯一路径

- ADR-0021 决策 3 的 `EgressGate` 四成员（`reserve` / `observeLimited` / `cooldownUntil` / `snapshot`）
  里没有成功入口，但 `noteSuccess()` 是**阶梯退档的唯一路径**（`egress.spec.ts` 有断言）。
  管理面尤其需要：一轮刷新成功理应退档，否则只要历史上撞过一次 429，此后每次撞都从高档位起步。
- 建议：端口加 `observeSuccess(egressId: string): void`。
  `isCooling` / `remainingMs` / `cool` / `clear` 留在具体类（`src/gateway/egress.ts`）作超集，
  engine 现有调用零改动；加一条编译期断言 `const _: EgressGate = createEgressCooldown()` 防漂移。

---

## 5. 装配（ADR-0021 决策 1/4）

```
src/server.ts（接线层）
  const gate = createEgressCooldown({ capacity, windowMs, reserveForData });   // 造一次
  ├─ 网关装配：createGatewayStack({ ..., egress: gate })                        // 数据面
  └─ buildApp({ ..., egress: gate })                                            // 管理面（ApiContext）
src/api/app.ts：const egress = opts.egress ?? permissiveEgressGate;
                SupplierOps.fetchImpl / RefreshOptions.fetchImpl 的默认值外面套 createEgressFetch(egress, inner)
```

- **装饰器包在注入缝之外**：`inner = options.fetchImpl ?? globalThis.fetch`（ADR-0021 决策 4「测试注入假
  fetch 时仍然经过闸」）。测试不传真闸时是 `permissiveEgressGate` ⇒ Map 查找即返回 ⇒ **零漂移**。
- **缺省（未接线）必须显式且静默无害**：`permissiveEgressGate` 恒放行、恒 `scope:'key'`，运行时行为与
  改动前**逐字节相同**（ADR-0021 决策 7）。回执里**不得**写"轮换放大器已掐断"。
- **生产接线用 spec 兜**：一条用例走生产装配路径造 app，断言数据面与管理面拿到**同一个** GATE 实例
  （`stack.egress === ctx.egress`）—— 这是唯一能防"两处各建一个、预算翻倍"的写法。

---

## 6. 与冷却 / 检测器的关系（ADR-0021 决策 5 的落法）

- **Tier 1.5 是预防，Tier 1 是兜底。** 桶算对了就不该再撞 429；撞了说明容量标定偏大，Tier 1 接手。
- **共用同一个冷却表**（同一个对象，不是同一个形状）：上游证据的行 2 / 行 3 照 ADR-0021 不动 ——
  同 `correlationId` 内第 2 把不同 key 429 ⇒ `scope:'egress'` ⇒ `cool()` 且**不记 key 失败**；
  第 1 把 ⇒ `scope:'key'`，沿用既有路径记该 key 失败（代价照 §16.7 登记：受害者 27→1）。
- **同一把 key 重复 429 不升级**（判据是"第 2 把**不同** key"）—— 状态在闸里按
  `Map<correlationId, Set<subject>>` 记，任务结束即弃（管理面按轮/按批给 `correlationId`）。
- **429 归因三分**（`hintForSummary` 的 `RATE_LIMITED` 分支按这个写，ADR-0011 §4 同形）：
  ① 出口级 → 不记 key 失败、出口短冷却；② key/账号级 → 记 key 失败、换 key；③ 分不清 → 保守按 key 级
  （现状），因为按出口级误判会"放过一把真坏的 key"。**本地桶拒绝是第 ① 类的子集**，由标记头识别，不经检测器。

---

## 7. 验收与测试清单

| 对象 | 用例 | 判据 |
|---|---|---|
| 桶算术 | 容量 / 补速 / 不超发 | 提交 `capacity` 次后一律拒；`retryAfterMs` 与下一枚 token 时刻一致（时钟注入） |
| 桶算术 | 恒定补速无窗口边界突发 | 跨窗口边界连打，任意 `windowMs` 内成功数 ≤ `capacity` |
| 保留额度 | 管理面吃不到 `reserveForData` 之下 | 管理面连打至多 `capacity - reserveForData` 枚；数据面随后仍取得到保留额 |
| **自伤回归（异议 2）** | 管理面连撞 47 次拒绝 | 出口冷却是 **0 次写入**；阶梯档位不变（`consecutive` 不动）；数据面 `Retry-After ≤ windowMs` |
| **假冷回归（异议 3）** | 桶拒绝一次 | 该 key 的 `consecutiveFails` / `cooldownUntil` **逐字节不变**；只打了一次"请求"且**零次上游调用** |
| 数据面 | 冷却期内 | 0 次上游请求；终态 429 + `Retry-After`（**不是** 503 `NO_AVAILABLE_KEY`） |
| 数据面 | TTFB | 有 token 时闸门**无 await、无 I/O**：`reserve` 的调用栈里不出现 Promise |
| 检测器 | 同一 `correlationId` | 第 1 把 → `scope:'key'` 且记该 key 失败；第 2 把不同 key → `scope:'egress'` 且**不记**；同一把重复 → 仍 `key` |
| 跨消费方 | 同一出口共享 | 管理面把配额打完后，数据面**立刻**拿到 429（同进程、同实例） |
| 键一致性 | 桶键 = 冷却键 | 两者取自同一函数（`egressIdOfUrl`）；`egressHostOf` 已不存在（异议 4） |
| 缺省闸 | 注入 `permissiveEgressGate` | 全部既有用例逐字节不变（防"缝变修"的回归锁） |
| 小数不泄漏 | 拒绝路径与归因路径 | 日志 / 审计 / 任务 `result` 里不出现 key 明文（ADR-0006 同纪律） |

---

## 8. 数值占位与回填位置

| 常量 | 占位值 | 回填来源 | 回填方式 |
|---|---|---|---|
| `capacity` | **5**（对齐 ADR-0021 决策 8 = 实测下界，最保守侧；我草案 v1 写的 6 作废） | 静默一夜重跑的标定（S4 前置项） | env / 配置，**不改结构** |
| `windowMs` | **60_000** | 同上（"恢复约 1–2 分钟"） | 同上 |
| `reserveForData` | **1**（理由见异议 1） | 标定后按数据面/管理面实际占比定 | 同上 |

**给 PM 的排期依据（占位值下）**：管理面可用 ≈ 4 枚/分钟 ≈ **60 枚/15min ≥ 52** ⇒
一轮全量刷新约 10 分钟跑完，**放得下**；但余量很薄（60 vs 52），任何重试都会吃掉它。
⇒ 标定回来前，PM 的「先关自动同步」在容量 5–6 下**仍是对的**（不是"跑不动"，是"余量太薄、
重试即欠账"）；容量回填到 20+/窗口 后可重新打开，且**只改数、不改代码**。
同批说明：**§15.5 表内「27 个账号一轮刷新 ≈ 1 分钟」在出口级口径下必须重算** ——
新口径 = `ceil(总请求数 / 有效容量) × 窗口`，有效容量要扣掉数据面保留额。

---

## 9. 边界与未决（诚实登记）

1. **跨进程不在闸内。** 桶是进程内内存态（与 `limiter.ts` / 出口冷却表同款既定降级 + 同款 TODO）。
   **Python 工作台 / 任何独立脚本打的出口请求，闸看不见**（工作台已按 §15.10 退役，脚本这条口子仍在）。
   多实例部署会把同出口预算乘上进程数 —— 与 `limiter.ts` 的 TODO 是同一条账，本批不做。
2. **`capacity` 的地板性未定**：5–6 是**脏 IP 上的实测值**（本次会话在同一 IP 上打过大量 401/403），
   不能直接当成干净部署 IP 的产能基线。标定前按最坏情况写死是**安全侧**。
3. **出口窗口语义未知**（固定窗 / 滑动窗 / 令牌桶）：恒定补桶对两者都安全，但可能比上游更保守。
4. **`reserveForData` 是新语义**，需要契约一句话（异议 1）—— 没有它，管理面可以合法地饿死数据面。
5. **桶不产生任何对外形状**：不新增端点、不新增错误码、不改 `/v1/*` 对外行为（只有"什么时候拒绝、
   什么时候放行"变了），`ERROR_CODES` / `GATEWAY_ERROR_CODES` 零新增，`SCHEMA_VERSION` 不变。
   §7 `egress_cooldown` 帧**不为桶加字段**（桶不是冷却态，它是额度）。
6. **`x-sub2api-egress-local` 标记头（异议 3）需要一个不泄漏的断言**：它只出现在进程内合成的响应上，
   既不上行也不透客户端，由 §7 的 spec 表守。

---

## 10. 需要契约补的七句（交给管家落 S1）

1. **§16.7 Tier 1.5 作用域**：从「刷新 / 建 key / 重登 / 探活 / 数据面」明确扩到**管理面全部打上游的
   消费者**，逐条点名 §14 三个刷新端点 + §15.2 六个端点 + 探活（PM 2026-10-07 裁决第一条）。
2. **计价单位**：**一次上游 HTTP 请求 = 一枚 token**（不是一把 key）；§15.5「刷新 = 2 请求/账号」据此换算。
3. **`RATE_LIMITED` 触发条件加第四条路径**：**出口预算耗尽**（0 次真实尝试、不计任何 key 健康、
   一律带 `Retry-After`）。与 §10「0 次真实尝试不是上游故障」同刀，**零新码值**。
4. **数据面保留额度**（异议 1）：写一句「管理面消费者不得占用数据面保留额度，否则单次人工刷新
   可合法饿死客户端流量」，并登记为占位值。
5. **桶钥匙 = `egressId`，与 Tier 1 冷却键同源**（异议 4）：Tier 2 落地时两处**一起**换成
   `egress_proxies.id`；禁止"桶按代理、冷却按 host"的分裂脑；`egressHostOf` 删除。
6. **§15.5 表内「27 个账号一轮刷新 ≈ 1 分钟」重算**（见 §8），并写清「0.6s 账号间隔**保留**为账号级
   内层纪律，出口级速率**由 Tier 1.5 取代**」（v1.4.8 已定口径，这里只补值的关系）。
7. **冷却写入的两条来源分列**（异议 2）：出口冷却**只由上游证据写入**（同出口第 2 把不同 key 亦 429）；
   桶拒绝走"终止本轮轮换 + `Retry-After`"，**不推进阶梯、不写冷却**；§7 帧因此只反映上游证据。

**本文档不含任何代码改动**（`docs/proposals/` 未纳入构建，纯文档）。契约补遗与五处异议裁定落定前，
`src/gateway/` 不动 —— 按"接口先行"的纪律。

---

## 附：与 ADR-0021 草案的逐条对账

| ADR-0021 | 本稿 |
|---|---|
| 决策 1 端口在 `src/egress/`、实现在 `src/gateway/egress.ts`、同一个实例 | **接受**（新顶层目录属 PM 裁定项，我无异议：放 `src/api` 会让 gateway 反向 import 管理面） |
| 决策 2 归一化只有一份实现 `egressIdOfUrl` | **接受，但要点名删除 `egressHostOf`**（异议 4）+ 补 fail-open 规则 |
| 决策 3 同步签名 / 不排队 / 数值全注入 / `snapshot` 逐字不动 | **接受**；要求加 `consumer` 参数（异议 1）与 `observeSuccess`（异议 5） |
| 决策 4 唯一集散点 = fetch 装饰器；拒绝合成 429 | **接受**；但 `observeLimited` 的调用权归调用方，合成响应带本地标记（异议 3） |
| 决策 5 预算拒绝即 `cool()`；检测器转正共用冷却 | **接受共用冷却与检测器**；**反对"拒绝即 `cool()`"**（异议 2）；检测器状态收进闸内一份 |
| 决策 6 一律不等 | **接受**（我草案 v1 的 `acquire(maxWaitMs)` 删除） |
| 决策 7 缺省逐字节同现状 / `BALANCE_SYNC_MINUTES=0` 是唯一真止血 | **接受**，并照此写回执口径 |
| 决策 8 占位 `{capacity:5, windowMs:60_000}` / 只改数不改结构 | **接受**（v1 的 6 作废）；补 `reserveForData` 占位 1 |
