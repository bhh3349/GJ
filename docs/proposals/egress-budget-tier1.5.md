# Tier 1.5 出口级令牌桶 —— 扩域方案（v3：**终版（修订后）** · 待与补遗同批放行）

- 作者：路由者（`src/gateway/` 实现面；ADR-0021 决策 1 定的"处置权在 `src/gateway/egress.ts`"）
- 冻结依据：`docs/api-contract.md` §16.7 Tier 1.5 / §15.5 / §7 `egress_cooldown`
  / `docs/adr/0020-egress-ip-rate-limit.md` / **`docs/adr/0021-egress-budget-seam.md`** / ADR-0017 补遗 v1.7.0
- **本稿状态**：v2 的五条签名级异议**已由 PM 2026-10-07 全部裁定**（五条全判"改"，其中第 2 条按"不自裁、
  摊开语义"的要求由 PM 裁掉）；ADR-0021 的三条待裁项也已裁定（新目录**收**、占位值**收**、**同批放行**）。
  本稿是**按裁定修订后的终版**，与管家的 ADR-0017 补遗 v1.7.0 + ADR-0021 修订稿**同批过目、一起推**。
- 本稿边界：**定结构、定接口、定作用域；数值占位已由 PM 钉死**。落到契约正文字句的活归管家（S1）。
- **零代码改动**：`docs/proposals/` 未纳入构建。契约 v1.7.0 放行前 `src/gateway/` 不动（"接口先行"纪律）。
- 前置事实（路由者实测，2026-10-07）：**出口预算 ≈5–6 请求/窗口、成功请求同样计入、按出口 IP 聚合、
  与账号/key 无关**；429 不带 `Retry-After`、不带 `X-RateLimit-*`；恢复约 1–2 分钟。

---

## 0. 结论

| # | 结论 | 谁需要知道 |
|---|---|---|
| 1 | **闸是"提交速率闸"，不是"并发闸"** —— 实测口径是"打出去几次"、成功也计入 ⇒ token 在**提交那一刻消耗、不退还**。并发度（`REFRESH_CONCURRENCY=4`）与它正交，不进桶。 | 管家（§14 / §15.5 口径） |
| 2 | **桶与冷却表是同一个对象**：`src/gateway/egress.ts` 的 `createEgressCooldown()` 扩成闸，**不新起第二个实例** —— 两个实例 = 双倍预算 = 静默失效，且 §7 帧会读到另一个对象。 | 双方（装配） |
| 3 | **§14 自动同步不是"结构上不可能"，是"突发打出去了"** —— 26 请求/轮、1 轮/15min ≈ 1.73 req/min，在 5–6/窗口下**放得下**；打爆它的是 `REFRESH_CONCURRENCY=4` 把它压进同一秒。桶摊平即可。但**标定前仍按 PM 裁决先 `BALANCE_SYNC_MINUTES=0`**（零代码止血）。 | 管家 + PM（排期） |
| 4 | **一律不排队**（ADR-0021 决策 6）—— 草案 v1 的 `acquire(maxWaitMs)` 删除。代价写明：手动全量刷新会**立刻**回一批 `failed`（不再是"卡 47 秒后成功"），与前端的二次确认文案正好配合。 | 管家 + 画师 |
| 5 | **桶拒绝不写冷却、不推进阶梯、不发射 §7 帧**（PM 裁定，本稿 §4 裁定 2）—— 出口冷却阶梯**只由上游证据推进**。 | 双方 + 画师（§7 帧语义） |
| 6 | **"保留额 / 不写冷却 / 本地标记头"是三脚架**（§4 裁定 1/2/3）—— 抽掉任何一条，另两条的收益当场反转：不写冷却而**没有**标记头 ⇒ 数据面回到 27 次候选轮换（比现状更坏）。 | 双方（实现顺序） |

---

## 1. 结构：一个对象、端口在中性目录、实现在 `src/gateway/`

```
src/egress/            ← ADR-0021 决策 1（只依赖标准库；管家落。PM 已裁定新目录"收"）
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
  这层事实，桶是额度、不是冷却（§4 裁定 2 定的语义，本稿 §9 第 5 条复述）。

---

## 2. 桶模型

```
tokens(egressId) ∈ [0, capacity]
refill = capacity / windowMs                      # 恒定速率补桶
reserve(egressId, consumer):                      # consumer: 'data' | 'management'
  refill()
  floor = consumer === 'management' ? reserveForData : 0
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
| 数据面 | `/v1/chat/completions`、`/v1/models`、助手聊天（同池） | 引擎每次上游尝试前的 fetch 装饰器 | 429 `RATE_LIMITED` + `Retry-After`；**0 次真实尝试、不换 key、不计 key 健康、不写出口冷却**（§4 裁定 2/3/6） |
| 管理面 | §14 三个刷新端点（含自动同步） | 同上（`fetchImpl` 注入缝） | 本轮照常结束，逐项记 `failed`；自动同步按 ADR-0017 补遗 2 的新判据推进退避 |
| 管理面 | §15.2 `import` / `refresh` / `keys` / `keys/sync` | 同上 | 逐项不等、**整批不中止** |
| 管理面 | §15.2 `:id/login` / `:id/test`（同步 200） | 同上 | 不等，直接拒（同步端点就该快速失败，见 §0 结论 4） |
| 管理面 | 探活 / 余额自测 | 同上 | 不等；**失败不得被读成"这把 key 坏了"** |

**计价单位 = 一次上游 HTTP 请求，不是"一把 key"。** §15.5 明载「刷新 = 2 请求/账号
（`/api/user/self` + `/api/subscription/self`）」⇒ 刷新一个账号消耗 **2 枚** token；一轮 26 key
全量刷新 ≈ **52 枚**。这条不写清，管家侧会按"1 key = 1 枚"建模，把预算算大一倍。

**唯一集散点 = fetch 装饰器**（ADR-0021 决策 4）：不在二十来个调用点各加一道 ——
走 `stack.ts` 那条"一次接好、接漏了不报错只静默失效"的同一个教训。

---

## 4. 五条异议的裁定与落法（**已裁**）

> PM 2026-10-07 逐条裁定：**五条全判"改"**，其中第 2 条按"不自裁、摊开语义"的要求由 PM 裁掉。
> 本节记录**裁定结论 + 落法 + 被我订正的事实**；不再是待裁项。**另附实施细则 6**（本稿新照出的一条，
> 属我车道内的实现口径，不含跨车道返工，但**必须进 ADR/契约的验收口径**，否则验收会按 502 通过）。

### 裁定 1（原异议 1）：`reserve()` 加 `consumer`，**保留额度占位 = 1** ⇒ 判"改"

- 落法：`reserve(egressId, consumer: 'data' | 'management')`；`floor = consumer === 'management' ? reserveForData : 0`。
  `reserveForData` **与决策 8 的 `capacity` 写进同一条**（PM 明确要求）。
- **占位为什么是 1 而不是 `ceil(capacity/2)`**：capacity=5 时 `ceil(5/2)=3` ⇒ 管理面只剩 2 枚/窗口
  = **30 枚/15min < 52** ⇒ 自动同步一轮**永远跑不完**，退化成长期欠账（每轮欠 22 枚），
  PM 的"先关自动同步"就从"止血"变成"唯一出路" —— 那违背管家 v1 里"管理面额度 45 < 52、跑不完整"的诚实账。
- **精确算术（三种口径，验收按最保守那条）**：

  | 口径 | 管理面可用 | 52 枚要多久 |
  |---|---|---|
  | 瞬时上限（**PM 裁定口径**，写进契约） | `capacity − reserveForData` = **4 枚/窗口** ⇒ 60 枚/15min ≥ 52 | `ceil(52/4) × 60s` = **13 min** |
  | 恒定补桶实际（数据面不用预算时） | 初始 4 枚 + 5 枚/分钟补桶 | ≈ **10 min**（稳态 10.4 min） |
  | 数据面满载时 | 保留额归数据面，管理面被压到 ≤ 5 − 数据面需求 | 更慢，**不承诺** |

  ⇒ 契约只写**瞬时上限那条**（它是"数据面永远至少剩 1 枚"的直接推论，也是唯一能对客户承诺的）；
  后两条作为实现说明留在本稿。**验收判据**：15 分钟内管理面拿到的 token 数 ≥ 52 才允许重新打开自动同步
  （占位值下**不满足**，故先关 —— 见 §8）。

### 裁定 2（原异议 2）：**桶拒绝不写出口冷却** ⇒ 判"不写"（PM 语义裁定原文口径）

- 裁定三条（管家落补遗时照此写）：
  1. 出口冷却阶梯**只由上游证据推进**（`consecutive` 只在**上游** 429/限流响应时 `+1`）。桶拒绝是
     **我们自己的预算耗尽**，不是对面忙 —— 把"自己这边忙"推进 §7 帧，与 ADR-0011 §4 刚修掉的错误同形。
  2. 一次点击（52 枚需求）不写冷却 ⇒ 数据面最长暴露窗口 = **到下一枚 token 补满为止**（量级**秒级**，
     不是 30 分钟），且保留额保证数据面在桶里永远有得取；写冷却才会把数据面一起挡在门外、§7 帧播报
     "上游限流中"，假信号放大。
  3. **§7 帧含义随动**：桶拒绝**不发射** §7 帧；§7 帧**只保留给上游证据**，与裁定 1 的保留额配套成立。
- **落法**：桶拒绝路径 = `{allowed:false, reason:'budget', retryAfterMs: 到下一枚 token}` ⇒
  装饰器合成 429 + `Retry-After`；**不调 `cool()`**。
- ⚠️ **原稿此处有一处算错，本稿订正**（v2 的阶梯推演表第 2 行）。按 `nextCooldownMs` 复算
  （`cool()` 每次 `consecutive += 1`、阶梯 `[0, 1m, 5m, 15m, 30m]`、`base = max(Retry-After, 60s)`）：

  | 第几次拒绝 | `consecutive` | 阶梯档 | 出口冷却（v2 写错） | **订正后** |
  |---|---|---|---|---|
  | 1 | 1 | `[0]`=0 | 60s | **60s** ✓ |
  | 2 | 2 | `[1]`=1m | ~~60s~~ | **1m** ← 订正 |
  | 3 | 3 | `[2]`=5m | 5m | **5m** ✓ |
  | 4 | 4 | `[3]`=15m | 15m | **15m** ✓ |
  | 5 及以后 | ≥5 | `[4]`=30m（封顶） | 30m | **30m** ✓ |

  ⇒ 结论不变（**一次点击、几十毫秒内爬满封顶档，数据面 30 分钟黑洞**），但阶梯**上档更快一档**：
  第 4 次拒绝即 15 分钟。**这张表现在是"已否决备选的推演"，不是待办** —— 保留它是为了让后面的人
  知道"照 ADR-0021 决策 5 行 1 字面实现"具体坏在哪一步。

### 裁定 3（原异议 3）：`observeLimited` 调用位置上移 + 本地标记头 + URL 解析 fail-open ⇒ 判"改"，三条全收

- **做不到**：装饰器手上只有 URL（→ `egressId`），**没有 `subject`（keyId / accountId）、也没有
  `correlationId`** —— 这两个量在引擎的尝试循环里，fetch 调用栈上不可见。数据面唯一能"编"出来的是把 key
  塞进请求头，那是把凭据散进更低的层（ADR-0006 同纪律，不做）。
- **照字面做必错**：桶拒绝时装饰器**合成**的 429 会被引擎当上游证据走既有 429 分支
  （`src/gateway/engine.ts:438`）⇒ `pool.reportFailure(candidate.keyId, 'RATE_LIMITED')`（`:473`）
  ⇒ 第一把候选被假记一次过 ⇒ **每次窗口打满时第一把都被假记**，反复几次真进 key 冷却 ——
  正是 §16.7 归因纪律明令禁止的"把好 key 停掉"（`egress.spec.ts` 开头第 1 条）。
- **落法（三条全收）**：
  1. 装饰器只 `reserve` + 合成 429，并给合成的响应打**本地标记头**
     `x-sub2api-egress-local: 1` ——**仅进程内**，不随出站请求上行、不透给客户端；
  2. `observeLimited` 由**知道 `subject` / `correlationId` 的调用方**调：数据面 =
     `engine.ts:440` 那处既有的识别器调用改为 `gate.observeLimited(...)`；管理面 = 各自循环喂
     `correlationId = 一轮刷新 / 一个批量任务`。判据**只留闸里一份** —— `classify.ts` 的
     `neverEgressLimited`（`:94`）/ `egressLimitedOnSecondKey`（`:110`）随之退休；
  3. 引擎 429 分支见到本地标记 ⇒ 走**既有 `skippedEgress` 那一族** ⇒ **零新客户端形状、零新错误码**
     （细则见本节的**实施细则 6**，v2 那句"走那一族"**不够**）。
- **ADR 未写、本稿补的一条**：`egressIdOfUrl` **解析不出 URL ⇒ `null` ⇒ 放行**（fail-open）。
  理由与 `egressHostOf` 的 `null` 语义同向：宁可退回旧的 key 级处置，也不拿一个假出口去冷掉别的上游。
  方向是"**解析不出出口就不做出口级裁决**"，不阻断请求。

### 裁定 4（原异议 4）：点名删 `egressHostOf` ⇒ 判"改"

- 现网 `src/gateway/egress.ts:27` 的 `egressHostOf(baseUrl)` 已被 `engine.ts:19/348` 与
  `egress.spec.ts:19/137`（共 6 处调用点）使用，规则（`new URL(baseUrl).host` 小写、含端口）与
  `egressIdOfUrl` **语义相同但不是同一个函数**。
- 两份并存 = ADR-0021 决策 2 自己点名的"同一个出口两个键"当场就埋下（冷却各冷一半、预算各扣一份，
  等于把 5–6 变成 10–12）。
- **落法**：ADR-0021 §决策 2 补一句「`egressHostOf` 随迁退休，归一化唯一入口 = `egressIdOfUrl`」；
  `engine.ts` / `egress.spec.ts` 改引用；过渡期若留兼容，**只留一行 re-export 且加 spec 断言两者同值**
  （两个函数各写一遍就是这条雷本身）。这条动的是我车道的既有代码，但 ADR 正文必须点名，
  否则下一个人还会照着 `egressHostOf` 写。

### 裁定 5（原异议 5）：端口补 `observeSuccess` ⇒ 判"改"

- `noteSuccess()`（`egress.ts:80/146`）是**阶梯退档的唯一路径**（`egress.spec.ts` 有断言：清
  `consecutive`、**不清 `until`**）。ADR-0021 决策 3 的四成员（`reserve` / `observeLimited` /
  `cooldownUntil` / `snapshot`）里没有成功入口 ⇒ 管理面一轮刷新成功退不了档 ⇒ 两边都只能绕过端口改状态，
  与"缺省 = 明确未接线"的注入缝纪律矛盾。
- **落法**：端口加 `observeSuccess(egressId: string): void`，**管理面循环轮末喂**
  （`correlationId` 作用域内的成功也退档）。`isCooling` / `remainingMs` / `cool` / `clear` 留在具体类
  （`src/gateway/egress.ts`）作超集，engine 现有调用零改动；加一条编译期断言
  `const _: EgressGate = createEgressCooldown()` 防漂移。

### 实施细则 6（**本稿新照出**）：本地拒绝必须"不算一次尝试"，否则客户端拿到的是 **502 而不是 429**

- 事实：`engine.ts:357` 的 `attempts += 1` 发生在 `doFetch` **之前**；而收尾分型
  （`:553` `if (attempts === 0 && attemptableCandidates > 0)`）**只有 `attempts === 0` 才回 429**，
  否则落到 `:575-583` 的 502 `UPSTREAM_ERROR`。`:344-346` 的注释已把口径钉死：
  **`attempts` 数的是"真敲过上游"的次数**（收尾分型、§12.1 的"不可互相反推"表都靠它）。
- ⇒ 桶在装饰器里拒绝时，那次 `doFetch` 一次网络都没发，但 `attempts` 已经 `+1`。v2 §4 异议 3 里
  "走既有 `skippedEgress` 那一族"**只做了一半**：照那半句写，`:553` 的条件不成立 ⇒
  **客户端拿到 502 `UPSTREAM_ERROR`，不是 §16.7 要求的 429 + `Retry-After`**，
  且 `:451`/`:477` 那两行会把一次"假失败 + 假 key 归因"写进事件流与用量日志。
- **落法（我车道内，`src/gateway/engine.ts` 一处）**：见到本地标记 ⇒ 按既有 `skippedEgress` 分支的形状处理，
  **外加把 `attempts` 减回 1**（本地拒绝 = 0 次真实尝试），`pool.endAttempt(candidate.keyId)`、
  `emit({outcome:'skipped'})`、`egressRetryAfterMs = max(…, retryAfterMs)`、`continue`。
  于是：客户端 = `:562` 的 `egressRateLimitedError`（429）、`attempts` 恒为 0、事件流里**没有**假失败行。
- **验收判据（必须进契约/ADR 的用例清单，否则验收会按 502 通过）**：桶拒绝一次 ⇒
  ① 客户端状态 429 + `Retry-After`（**断言不是 502**）；② `attempts` 计 **0**；③ `inner` fetch **零调用**；
  ④ 该出口的 `consecutive` / `until` **逐字节不变**（与裁定 2 同一条断言）。

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
- **共用同一个冷却表**（同一个对象，不是同一个形状）：
  - **上游**证据照 ADR-0021 不动 —— 同 `correlationId` 内第 2 把不同 key 429 ⇒ `scope:'egress'` ⇒
    `cool()` 且**不记 key 失败**；第 1 把 ⇒ `scope:'key'`，沿用既有路径记该 key 失败
    （代价照 §16.7 登记：受害者 27→1）。
  - **桶拒绝**（我们自己的预算耗尽）⇒ **不进这张表**（裁定 2）。
- **同一把 key 重复 429 不升级**（判据是"第 2 把**不同** key"）—— 状态在闸里按
  `Map<correlationId, Set<subject>>` 记，任务结束即弃（管理面按轮/按批给 `correlationId`）。
- **`egressLimitedOnSecondKey` 转正的两处**（PM 已明文放行，管家登记进契约）：
  ① 默认值从 `neverEgressLimited` 换掉；② 判据入参 `distinctKeysFailed429`（`classify.ts:79` 现写
  "**本客户端请求内**"）**参数化为"当前作用域内"**（`request` / `batch`）—— 否则管理面那侧喂不出这个量。
- **429 归因三分**（`hintForSummary` 的 `RATE_LIMITED` 分支按这个写，ADR-0011 §4 同形）：
  ① 出口级 → 不记 key 失败、出口短冷却；② key/账号级 → 记 key 失败、换 key；③ 分不清 → 保守按 key 级
  （现状），因为按出口级误判会"放过一把真坏的 key"。**本地桶拒绝是第 ① 类的子集**，由标记头识别，不经检测器。

---

## 7. 验收与测试清单

| 对象 | 用例 | 判据 |
|---|---|---|
| 桶算术 | 容量 / 补速 / 不超发 | 提交 `capacity` 次后一律拒；`retryAfterMs` 与下一枚 token 时刻一致（时钟注入） |
| 桶算术 | 恒定补速无窗口边界突发 | 跨窗口边界连打，任意 `windowMs` 内成功数 ≤ `capacity` |
| 保留额度（裁定 1） | 管理面吃不到 `reserveForData` 之下 | 管理面连打至多 `capacity − reserveForData` 枚；数据面随后**仍取得到**保留额 |
| **自伤回归（裁定 2）** | 管理面连撞 47 次拒绝 | 出口冷却是 **0 次写入**；`consecutive` 不动、`until` 不动；§7 帧 **0 次发射**（`snapshot()` 逐字不变） |
| **假冷回归（裁定 3）** | 桶拒绝一次 | 该 key 的 `consecutiveFails` / `cooldownUntil` **逐字节不变**；零次上游调用 |
| **终态形状（细则 6）** | 桶拒绝一次 | 客户端 **429 `RATE_LIMITED` + `Retry-After`（断言不是 502）**；`attempts` 计 **0**；事件流**无** `outcome:'failure'` 行 |
| 数据面 | 冷却期内（上游证据置的） | 0 次上游请求；终态 429 + `Retry-After`（**不是** 503 `NO_AVAILABLE_KEY`） |
| 数据面 | TTFB | 有 token 时闸门**无 await、无 I/O**：`reserve` 的调用栈里不出现 Promise |
| 检测器 | 同一 `correlationId` | 第 1 把 → `scope:'key'` 且记该 key 失败；第 2 把不同 key → `scope:'egress'` 且**不记**；同一把重复 → 仍 `key` |
| 检测器 | 作用域参数化（§6 第二处） | 管理面按 `batch` 作用域也能凑齐"第 2 把不同 key"（`request` 作用域下永远凑不齐） |
| 退档（裁定 5） | 轮末 `observeSuccess` | 一轮成功后退档：`consecutive` 归零、`until` 不动 |
| fail-open（裁定 3 补） | `egressIdOfUrl` 解析不出 | 放行、不取 token、不写任何状态 |
| 跨消费方 | 同一出口共享 | 管理面把配额打完后，数据面**立刻**拿到 429（同进程、同实例） |
| 键一致性（裁定 4） | 桶键 = 冷却键 | 两者取自同一函数（`egressIdOfUrl`）；`egressHostOf` 已不存在 |
| 缺省闸 | 注入 `permissiveEgressGate` | 全部既有用例逐字节不变（防"缝变修"的回归锁） |
| 小数不泄漏 | 拒绝路径与归因路径 | 日志 / 审计 / 任务 `result` 里不出现 key 明文（ADR-0006 同纪律） |

---

## 8. 数值占位（**PM 已裁定写死**）

| 常量 | 值 | 来源 / 纪律 |
|---|---|---|
| `capacity` | **5** | 实测下界（最保守侧）；草案 v1 写的 6 作废 |
| `windowMs` | **60_000** | "恢复约 1–2 分钟"；窗口语义未测，恒定补桶对它安全 |
| `reserveForData` | **1** | 裁定 1；**与 `capacity` 写进 ADR-0021 决策 8 同一条** |

- **回填纪律**：**只改数、不改结构**（唯一绑定点在接线处 / env / 配置）。
- **给 PM 的排期依据（占位值下，按最保守的"瞬时上限"口径）**：管理面 = 4 枚/窗口 ⇒ 60 枚/15min，
  一轮 52 枚 **放得下，但余量只有 8 枚（15%）** —— 任何重试都会吃掉它。
  ⇒ 标定回来前，PM 的「先关自动同步」**仍是对的**（不是"跑不动"，是"余量太薄、重试即欠账"）；
  容量回填到 20+/窗口 后可重新打开，且**只改数、不改代码**。
- **§15.5 表内「27 个账号一轮刷新 ≈ 1 分钟」必须重算**：新口径
  = `ceil(总请求数 / 有效容量) × 窗口`，有效容量要扣掉数据面保留额（占位值下 = 4）。

---

## 9. 边界与未决（诚实登记）

1. **跨进程不在闸内。** 桶是进程内内存态（与 `limiter.ts` / 出口冷却表同款既定降级 + 同款 TODO）。
   **任何独立脚本打的出口请求，闸看不见**（Python 工作台已按 §15.10 退役，脚本这条口子仍在）。
   多实例部署会把同出口预算乘上进程数 —— 与 `limiter.ts` 的 TODO 是同一条账，本批不做。
2. **`capacity` 的地板性未定**：5–6 是**脏 IP 上的实测值**（本次会话在同一 IP 上打过大量 401/403），
   不能直接当成干净部署 IP 的产能基线。标定前按最坏情况写死是**安全侧**。
3. **出口窗口语义未知**（固定窗 / 滑动窗 / 令牌桶）：恒定补桶对两者都安全，但可能比上游更保守。
4. **保留额口径有三种，契约只写最保守的一条**（裁定 1 的表）；数据面满载时管理面吞吐**不承诺**。
5. **桶不产生任何对外形状**：不新增端点、不新增错误码、不改 `/v1/*` 对外行为（只有"什么时候拒绝、
   什么时候放行"变了），`ERROR_CODES` / `GATEWAY_ERROR_CODES` 零新增，`SCHEMA_VERSION` 不变。
   §7 `egress_cooldown` 帧**不为桶加字段**（桶不是冷却态，它是额度），且**不因桶拒绝而发射**（裁定 2）。
6. **`x-sub2api-egress-local` 标记头需要一个不泄漏的断言**：它只出现在进程内合成的响应上，
   既不上行也不透客户端，由 §7 的 spec 表守。
7. **ADR-0021 里有一处行号漂移**：决策 4 写 `engine.ts:141` 的 `doFetch`，本工作树实为 **`:154`**
   （本稿引用的 `438`（429 分支）/ `473`（`reportFailure`）/ `553`（收尾分型）三处已逐行核过）。
   实现时以**函数名 + 本稿行号**为准；管家落契约时顺手改掉。

---

## 10. 需要契约补的条目（终版清单，交给管家落 S1 · 契约 v1.7.0）

| # | 落点 | 内容 | 来源 |
|---|---|---|---|
| 1 | §16.7 Tier 1.5 作用域 | 从「刷新 / 建 key / 重登 / 探活 / 数据面」明确扩到**管理面全部打上游的消费者**，逐条点名 §14 三个刷新端点 + §15.2 六个端点 + 探活 + 自测 | PM 裁决第一条 + 本稿 §3 |
| 2 | §16.7 计价单位 | **一次上游 HTTP 请求 = 一枚 token**（不是一把 key）；§15.5「刷新 = 2 请求/账号」据此换算 | 本稿 §3 |
| 3 | §16.7 `RATE_LIMITED` 触发条件 | 加**第四条路径「出口预算耗尽」**：0 次真实尝试、不计任何 key 健康、**不写出口冷却**、一律带 `Retry-After`；与 §10「0 次真实尝试不是上游故障」同刀，**零新码值** | 本稿 §4 裁定 2/3 |
| 4 | §16.7 保留额度 | 写一句「管理面消费者不得占用数据面保留额度，否则单次人工刷新可合法饿死客户端流量」，并登记占位值 `reserveForData: 1` | 本稿 §4 裁定 1 |
| 5 | §16.7 键一致 | 桶钥匙 = `egressId`，与 Tier 1 冷却键**同源**；Tier 2 落地时两处**一起**换成 `egress_proxies.id`；禁止"桶按代理、冷却按 host"的分裂脑；**`egressHostOf` 删除** | 本稿 §4 裁定 4 |
| 6 | §15.5 表 + 0.6s 间隔 | 「27 个账号一轮刷新 ≈ 1 分钟」按 `ceil(总请求数 / 有效容量) × 窗口` 重算；并写清「0.6s 账号间隔**保留**为账号级内层纪律，出口级速率**由 Tier 1.5 取代**」 | 本稿 §8 |
| 7 | §16.7 冷却写入来源 | **两条来源分列**：出口冷却**只由上游证据写入**（同出口第 2 把不同 key 亦 429）；桶拒绝走"终止本轮轮换 + `Retry-After`"，**不推进阶梯、不写冷却、不发射 §7 帧** | 本稿 §4 裁定 2 + §6 |
| 8 | §16.7 终态形状 | 桶拒绝的客户端终态 **必须是 429 + `Retry-After`，不是 502**；`attempts` 恒为 0（本地拒绝不算尝试）；事件流不得出现假失败行 | 本稿 §4 **细则 6** |
| 9 | §16.7 + §15.5 检测器转正 | `egressLimitedOnSecondKey` 默认值替换 + `distinctKeysFailed429` 参数化为「当前作用域」（`request` / `batch`） | §6；PM 明文放行 |
| 10 | ADR-0017 补遗 1–4 | 管家的四条（TTFB 分句判 / 退避判据 / 第 5 个 `hintCode` / 漂移判据与 `knownKeyCount` 语义） | 管家，同批 |

**同批硬依赖（画师，契约 v1.7.0 放行前不动）**：
① `HINT_CONFIG` 是**穷尽 Record 且无兜底** ⇒ 第 5 个 `HintCode` 先到、前端后到**当场抛错**，故加第 5 项
**并**补兜底分支是**同批硬依赖**，不是"可后补"；② 检测器转正 ⇒ 出口冷却真会被置起 ⇒ §7
`egress_cooldown` 帧**开始发射**，v1.4.9 的「本期不发射 / 前端不得接线」随之作废，画师**多一项接线义务**
（三处接线点照 v1.4.11）。本稿对 §7 帧语义的收窄（裁定 2）**不减少**这项义务 —— 帧只报上游证据。

**本稿不含任何代码改动**；ADR-0017 补遗 v1.7.0 + ADR-0021 修订稿 + 本终版**同批过目，通过后一起推**。

---

## 附：与 ADR-0021 的逐条对账（终版）

| ADR-0021 | 终版状态 |
|---|---|
| 决策 1 端口在 `src/egress/`、实现在 `src/gateway/egress.ts`、同一个实例 | **接受**（新顶层目录 PM 已裁定"收"） |
| 决策 2 归一化只有一份实现 `egressIdOfUrl` | **接受 + 改**：点名删除 `egressHostOf`；补 fail-open 规则 |
| 决策 3 同步签名 / 不排队 / 数值全注入 / `snapshot` 逐字不动 | **接受 + 改**：加 `consumer` 参数（裁定 1）与 `observeSuccess`（裁定 5） |
| 决策 4 唯一集散点 = fetch 装饰器；拒绝合成 429 | **接受 + 改**：`observeLimited` 调用权归调用方，合成响应带本地标记头；**行号订正 141 → 154** |
| 决策 5 预算拒绝即 `cool()`；检测器转正共用冷却 | **共用冷却/检测器接受**；**"拒绝即 `cool()`" 作废**（PM 裁定 2：不写冷却、不推进阶梯、不发射 §7 帧）；检测器状态收进闸内一份 |
| 决策 6 一律不等 | **接受**（草案 v1 的 `acquire(maxWaitMs)` 删除） |
| 决策 7 缺省逐字节同现状 / `BALANCE_SYNC_MINUTES=0` 是唯一真止血 | **接受**，并照此写回执口径 |
| 决策 8 占位 `{capacity:5, windowMs:60_000}` / 只改数不改结构 | **接受 + 改**：写死 `{capacity:5, reserveForData:1, windowMs:60_000}`（PM 裁定） |
| 决策 1/8 的结构决策与数值占位 | PM 已裁定：**同批放行**，但裁定 1（保留额）与裁定 2（不写冷却）**必须在这批里** |
