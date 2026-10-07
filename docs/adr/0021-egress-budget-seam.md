# 21. 出口（IP）预算：跨车道共享令牌桶与统一注入缝

- 状态：**草案 v2**（待 PM 过目，S1 冻结前；**未生效** —— 放行前不改契约正文、不改代码）
  - v2 变更（2026-10-07，路由者评审后）：已吸收五条**签名级**异议中的四条（决策 2 / 决策 3 / 决策 4a / 决策 8），
    第 5 条（自拒绝是否写出口冷却）**语义级、不自裁**，升格为待 PM 裁定第 4 条并保留 A/B 两案。
- 日期：2026-10-07
- 决策者：管家 · 管理后端（接口形状与归因口径）；路由者（`src/gateway/` 实现面）
- 关联：ADR-0020（§16.7 Tier 1.5「出口级令牌桶」，本 ADR 是它的**接口化**）/ ADR-0017（§14 自动同步，
  补遗草案同批）/ ADR-0015（`ApiContext.assistant`：接口 + 缺省未接线实现 + 接线层注入的先例）/
  ADR-0011（归因纪律：0 次真实尝试不计 key 健康）/ ADR-0014（`x-request-id` 关联键）/ ADR-0010（进程内状态、重启归零）
- 触发：路由者 2026-10-07 实测「出口 IP 预算 **≈5–6 请求/窗口、成功请求同样计入、与账号/key 无关、放慢不解决**」
  +\>管家报回「§14 自动同步是最大单一消费者（26 次/轮）且失败形态不退避」；PM 裁决：
  「作用域**必须包含管理面消费方**……统一注入缝，形状同 `ApiContext.assistant`；
  429 分类口径：出口级限流（`egressLimitedOnSecondKey` 转正）不记 key 失败、走短冷却，与 §14 的 429 特判共用一个检测器」。

## 背景与问题

出口预算是**全进程共享**的一条约束：同一个出口 IP 上，数据面转发、余额刷新、账号面批量、自测、探活
打出去的每一个请求**都在同一张配额表上扣**（§16.7 实测：连账号/key 都不区分）。而现在这五类请求
由两个车道、四个模块各自用各自的 `fetch` 发出去：

| 消费方 | 现状发请求的位置 | 车道 |
|---|---|---|
| `/v1/*` 数据面 | `src/gateway/engine.ts:141` 的 `doFetch`（`options.fetchImpl ?? fetch`） | 路由者 |
| §14 余额刷新（自动 + 三个手动端点） | `src/api/services/balance-refresh.ts` → `executePlan(plan, target, fetchImpl)` | 管家 |
| 余额自测 / 探活 | `src/api/services/balance-selftest.ts`（同一条 `executePlan`） | 管家 |
| §15.2 六个端点（`import`/`refresh`/`login`/`test`/`keys`/`keys/sync`） | `src/supplier/tierflow.ts` 的 client（`fetchImpl` 来自 `SupplierSeams`） | 管家 |
| key 健康探活（§16.4） | 内核侧 | 路由者 |

各自为政的后果正好是实测到的那一个：**26 把 key 的自动同步一轮就把窗口烧干，数据面随后 429**，
而两边谁都不知道自己撞的是同一张表。

## 决策 1：端口放**中性模块** `src/egress/`，端口是"接口 + 缺省实现"，实现在路由者侧

- **端口**（类型 + 归一化纯函数 + 缺省闸 + fetch 装饰器）落在**新目录 `src/egress/`**，只依赖标准库，
  不 import `src/api` / `src/gateway` / `src/db`。
- **实现**（令牌桶 + 冷却态）由**路由者**落在 `src/gateway/egress.ts` —— 与 §7 帧 v1.4.9 已冻结的
  "生产者归路由者 `src/gateway/egress.ts` `createEgressCooldown()`"**是同一个对象**，本 ADR 不为它新起第二个实例。
- **接线**在 `src/server.ts`（既有的 `assistant` / supplier seams 都从这里注入）：**造一次、注入两处** ——
  一进 `buildApp({ egress })`（即 `ApiContext.egress`），一进网关装配（§7 v1.4.11 的 `stack.ts` `egress?`）。

**为什么不放进 `src/api/`（尽管 `ApiContext.assistant` 就在那儿）**：`assistant-port.ts` 只有 `src/api` 消费，
所以放它自己家里是对的；出口预算**两车道都消费**，放 `src/api` 会让 `src/gateway` 反向 import 管理面
（AGENTS.md §8 禁止）。**为什么不放 `src/wiring/`**：`src/wiring/` 的注释写它"不属于任何一侧"，但 ADR-0017 已经
按"属路由者车道"处理过它，一处两说；端口是**被两侧引用的公共契约**，独立目录比一个归属有争议的目录稳。

> 这条是**结构决策**，需要 PM 一并点头（新顶层目录）。备选是 `src/net/egress*.ts`，语义更泛但离 §16.7 的术语更远，
> 不推荐。

## 决策 2：`egressId` 的归一化**只有一份实现**，两个车道必须引用它

本期出口 = `upstream.host`（Tier 2 后 = `egress_proxies.id`，值换形状不换 —— §7 决策 7 已定死"前端不得解析其内容"）。
归一化规则与 §16.7 逐字一致：**小写、含非默认端口**。

```ts
export function egressIdOfUrl(url: string): string | null;
```

**为什么单列一条决策**：这是本期最容易埋的雷 —— 如果内核按 `host` 归一、管理面按 `host:port`、
或一边 `toLowerCase()` 一边没有，同一个出口就会出现**两个键** ⇒ 冷却各冷一半、预算各扣一份（等于把 5–6 变成 10–12）。
它是个纯函数，放进端口模块就是为了**不可能出现第二份实现**。

**但"唯一"目前不成立，得先并轨**（路由者 2026-10-07 指出，已回代码核对）：`src/gateway/egress.ts:27`
的 `egressHostOf(baseUrl)` 就是同一套归一化（`new URL().host` + `toLowerCase()`，含非默认端口），
而且它是**本期唯一一份在跑的**（`egressIdOfUrl` 目前还不存在）。本 ADR 因此把并轨写成落地要求，不是建议：

- `egressIdOfUrl(url: string): string | null` 为**唯一**归一化实现，**取不到 URL / 解析失败 → `null`**；
- `egressHostOf` **退化成对它的一层薄封装**（或删除、调用点直接改用它），**禁止两份并存**；
- 落地验收：`grep -rn "new URL(.*)\.host" src/` 只允许命中端口模块一处。

**`null` 的语义是 fail-open（放行），这条原 ADR 漏写了**（路由者 2026-10-07）：解析不出出口时
**不得**拒绝请求、**不得**记 key 失败 —— 宁可退回旧的 key 级处置，也不拿一个假出口去冷掉别的上游。
这与 `egressHostOf` 现有的 fail-open 行为一致（`egress.ts:22-26` 注释原文："宁可退回旧的 key 级处置"），
所以并轨是保语义的，不是改语义的。

留着 `egressHostOf` 的代价不是"某个实现者将来会粗心"，是**这条决策自己当场成立的反例**：
一根出口两个键 ⇒ 冷却各冷一半、预算各扣一份，正好把 5–6 变成 10–12。

## 决策 3：端口形状 —— 同步签名、不排队、数值全部注入

```ts
/** 出口（IP）预算闸。**同步签名**：理由见下。 */
export interface EgressGate {
  /**
   * 发请求前取一次配额。**不排队、不等待**：拒绝即刻返回，等待策略归调用方（决策 6）。
   * `consumer` 决定能否动用**数据面保留额度**（决策 8）：`'data'` 可，`'management'` 不可。
   */
  reserve(egressId: string, consumer: EgressConsumer): EgressReservation;
  /** 收到 429 时报告，拿回归因结论。同一 `correlationId` 内第 2 个不同 `subject` ⇒ 出口级。 */
  observeLimited(input: EgressLimitedInput): EgressVerdict;
  /**
   * 出口**真的答了**（仅上游证据）→ 清连续计数、退出升档阶梯。与内核既有 `noteSuccess()` 同义。
   * 缺了它，管理面跑完一轮成功也退不了档，两侧只能绕过端口直接改状态（路由者 2026-10-07）。
   */
  observeSuccess(egressId: string): void;
  /** 出口是否在冷却中；`null` = 未冷却。只读，无副作用。 */
  cooldownUntil(egressId: string): number | null;
  /** §7 v1.5.0 **已冻结**的读面，签名逐字不改。 */
  snapshot(): readonly { host: string; untilMs: number }[];
}

/** 预算消费方：`'data'` = `/v1/*`；`'management'` = §14 刷新 / 自测 / §15.2 批量 / 探活。 */
export type EgressConsumer = 'data' | 'management';

export type EgressReservation =
  | { allowed: true }
  | { allowed: false; reason: 'budget' | 'cooldown'; retryAfterMs: number };

export interface EgressLimitedInput {
  egressId: string;
  /** 相关单元：数据面 = 一次客户端请求（用 ADR-0014 已有的关联键；引擎内拿不到时退化为该次调用作用域 id）；
   *  管理面 = 一轮刷新 / 一个批量任务 */
  correlationId: string;
  /** 本次请求所用凭据（keyId / accountId）。**同一凭据重复 429 不升级为出口级** —— 判据是"第 2 把不同 key" */
  subject: string;
  /** 上游给的 `Retry-After`（实测上游从不发，§16.7 v1.6.2） */
  retryAfterMs?: number;
}

export type EgressVerdict = {
  scope: 'key' | 'egress';
  /** 判出口级时非空：本次冷却到什么时候（epoch ms，与 §7 帧的 `cooldownUntil` 同源） */
  cooldownUntilMs: number | null;
};

/** 缺省闸：`reserve` 恒放行、`observeLimited` 恒回 `scope:'key'`、`observeSuccess` 空操作。
 *  **逐字节同现状**（决策 7）。 */
export const permissiveEgressGate: EgressGate;
```

- **同步**（`reserve` 不返回 Promise）：与 `src/gateway/ports.ts` 已写死的原则同源 ——
  "端口签名刻意设计成同步，把异步挡在实现侧"。热路径上一个 async 的闸等于给引擎开了一道
  "不小心 await 了 IO" 的门；同步签名让"发请求前必须已经拿到裁决"成为类型层面的事实。
- **不排队**：令牌桶只回答"现在能不能发"，**不替调用方等**。等待是策略，策略按消费方不同（决策 6）。
- **数值全部由构造参数注入**（同 §15.5「并发上限复用 `REFRESH_CONCURRENCY`、不新拍一个数」的纪律）：
  端口**不得**把 5–6 / 窗口写成常量。**唯一绑定点在接线处**，标定回来后**只改数、不改结构**（§16.7 Tier 1.5 的原文口径）。
- **账本进程内**：与既有出口冷却态（v1.4.11：`Map`、不落库、重启归零）同款降级；**单进程假设**写明 ——
  将来若跑多进程，同出口的预算会被乘上进程数，届时需要共享账本（另一笔，本 ADR 不做）。

## 决策 4：唯一集散点 = **接线层的 fetch 装饰器**；预算拒绝**合成一个 429**（不落网络）

```ts
/** 每条出站路径都必须经过它。`inner` 缺省 = 全局 fetch（测试注入假 fetch 时**仍然经过闸**）。 */
export function createEgressFetch(gate: EgressGate, inner?: typeof fetch): typeof fetch;
```

放在装饰器里而不是让每个调用方手写 `reserve`，是因为两条车道**都已经有单一出口**：
内核是 `engine.ts:141` 的 `doFetch`，管理面是 `SupplierOps.fetchImpl` / `RefreshOptions.fetchImpl`
（默认值都在 `buildApp` 一处填）。装饰器一包，覆盖数据面 / 刷新 / 自测 / 批量 / 探活五类，**零调用点改动**。

拒绝时不抛异常、不发请求，而是**合成一个 `429` Response（带 `Retry-After`）** 返回给调用方。这样：

- §14 的计数与 hint、§15.3 的批量 `failed` **不需要为"本地拒绝"写特例** —— 它们沿既有的 429 分支走；
- 拒绝与上游 429 在**证据面同形** —— 这正是 §16.7 说的"出口被限流与池饱和对调用方同形"的延续，
  管理面不该为本地拒绝发明一套新的判读方式。

**但数据面是例外，必须能区分二者**（见下条）；原 ADR 把"全部不需要写特例"写满了，是被路由者
2026-10-07 指出后订正的。

### 决策 4a：装饰器**只**取配额，**不做归因**

装饰器**只做一件事**：`reserve` → 放行则 `inner()`，拒绝则合成 429。它**不调 `observeLimited`**，
合成的 429 上带一个**进程内标记头**（实现时定名并导出常量，本文写作 `X-Egress-Local-Reject`）。

两条理由，第二条是硬故障：

1. **归因所需的信息装饰器手上没有。** `observeLimited` 的判据是"**同一相关单元内第 2 把不同 key**
   吃到 429"，需要 `subject`（哪把 key / 哪个账号）与 `correlationId`（哪一轮 / 哪一批）。装饰器只拿到
   一个 URL；照字面在装饰器里调它，参数是编的。
2. **合成的 429 会被内核当成上游证据。** `src/gateway/engine.ts:438` 起，任何 `RATE_LIMITED` 都先
   `egressKeys429.add(candidate.keyId)`；判不出出口级就落到 `engine.ts:479` 的
   `pool.reportFailure(candidate.keyId, 'RATE_LIMITED', { retryAfterMs })` —— 于是一次**本地**预算拒绝
   被记成**这把 key 失败一次**。窗口反复打满，每一轮候选里的头一把都被假记一次过，几轮下来真的进
   key 冷却：正是 §16.7 明令禁止的"把好 key 停掉"，与 ADR-0011 §4 修掉的那类错误同形。

因此归因**只有一份判据、一个调用点，都在闸里**，由调用方喂：

| 消费方 | 谁调 `observeLimited` | `correlationId` |
|---|---|---|
| `/v1/*` 数据面 | `engine.ts:438` 那处**既有的** `egressKeys429` 位置（原本就在算"同一请求内第几把不同 key"） | ADR-0014 的关联键；引擎内取不到时退化为该次调用作用域 id |
| §14 刷新 / 自测 | `balance-refresh.ts` / `balance-selftest.ts` 的循环 | 一轮刷新 = 一个 id |
| §15.2 四个批量端点 | 各自的逐项循环 | 一个批量任务 = 一个 id |

**连带**：`classify.ts` 的 `neverEgressLimited` 与 `egressLimitedOnSecondKey` **两个识别器随之退休**
（`classify.ts:94` / `:110`），判据唯一化到闸内，内核不再保留第二份。`EgressLimitDetector` 这个缝
在 Tier 1.5 落地后不再有第二个消费者 —— 这一点要写进实现回执，别留成"两个地方都能判、只是默认关着"。

**标记头的第二重作用**：数据面凭它**不换 key**（决策 5 / 决策 6）。本地拒绝落在同一个出口上，
换一把再试必然再撞；这个"不换"由标记头直接给出，**不依赖出口是否在冷却中**（见决策 5）。

## 决策 5：预算拒绝与上游 429 在**证据面同形**；冷却态共用，但"主动拒绝要不要写冷却"**待 PM 裁定**

这是 PM 裁决里"与 §14 的 429 特判共用一个检测器"的落法。判据唯一化到闸内（决策 4a）后，
只剩**动作**这一处有分歧 —— 表中第 1 行：

| 证据 | 谁发现 | 动作 |
|---|---|---|
| 本窗口配额已尽（**主动**，我们自己拒绝的） | `reserve` 返回 `allowed:false` | **待 PM 裁定**（见文末第 4 条）：① **不写冷却**，只合成带标记头的 429（路由者 2026-10-07 建议）；② `cool(egressId, retryAfterMs)`（本 ADR v1 原案） |
| 上游回 429，同出口**第 2 把不同 key**（**被动**，`egressLimitedOnSecondKey` 转正） | `observeLimited` 返回 `scope:'egress'` | `cool(egressId, retryAfterMs)`，**不记 key 失败** |
| 上游回 429，同出口**第 1 把** key | `observeLimited` 返回 `scope:'key'` | 沿用既有路径记该 key 失败（**代价照 §16.7 登记**：受害者 27→1，不是零成本） |

### 为什么第 1 行不能照 v1 原案直接落（路由者 2026-10-07；已回代码取证）

原案"拒绝 ⇒ 立刻 `cool()`"在现有冷却实现下不是"记一笔"，是**一次点击打暗数据面半小时**：

- `src/gateway/egress.ts:133` `cool()` 每次调用都 `s.consecutive += 1`，**每次各推一档**；
- 阶梯 `src/gateway/cooldown.ts:23` `[0, 1m, 5m, 15m, 30m]`，429 基础冷却 60s（`cooldown.ts:52-56`）
  ⇒ 第 1 次 60s、第 2 次 1m、第 3 次 5m、第 4 次 15m、**第 5 次 30min 封顶**；
- `src/gateway/egress.ts:142` `s.until = Math.max(s.until, t + ms)` —— **只增不减**；
- 手动刷新一次点击 = 26 key × 2 请求 = **52 枚**，占位容量 5/窗口 ⇒ 一次点击内几十毫秒就会连吃多次拒绝
  ⇒ **第 5 次拒绝即封顶，整个出口 30 分钟不给任何请求**。

代价不对称：

- **不写冷却**：最坏是"这次自拒绝没被记成全局信号"。客户端**立刻**拿到 429 + `Retry-After`，
  数据面凭标记头终止本轮候选轮换（决策 4a），行为已经正确；
- **写冷却**：最坏是一键把数据面打进 30min 黑洞，而这条冷却**没有任何上游证据支撑**（是我们自己算出来的），
  §7 帧还会把它当"出口被限流中"播给前端 —— 归因方向反了，与 ADR-0011 §4 修掉的错误同形。

- **冷却式子不动**（被动那两行）：仍 `max(Retry-After, 60s)`、封顶 30min、阶梯同 key 级（§16.7 裁定 ②，v1.6.2 订正过理由）；
  **阶梯只由上游证据推进** —— 这是我们自己的拒绝，不构成"连续命中"。
- **数据面"不换 key"不再依赖冷却**：原案靠"预算拒绝 ⇒ 出口已冷却 ⇒ Tier 1 的冷却期内不换 key 生效"，
  这条链一旦第 1 行不写冷却就断了。改由**标记头**直接给：本地拒绝 ⇒ 本轮候选轮换就此终止，
  **不记 key 健康、不换 key**（决策 4a / 决策 6）。效果相同（轮换放大器在它成立之前就被掐掉），
  但**不引入一条无证据的 30min 冷却**。
- **§7 帧的 `reason` 字段被删仍在此兑现价值**（v1.5.0）：两个成因共用 `RATE_LIMITED`，一个字段省下来了。
- **连带**：检测器转正后，**上游确认**的出口级 429 会真的置起冷却 ⇒ §7 的 `egress_cooldown` 帧
  **从此开始发射**，§16.7 v1.4.9 的「本期不发射 / 前端不得接线」随之失效（见影响表）。
  **注意口径**：帧的成因只有"上游确认"一种；第 1 行若裁定为不写冷却，**本地拒绝不会发帧**。

## 决策 6：拿不到配额时，各消费方怎么办（**不等**是默认，等待是例外）

| 消费方 | 拒绝后的行为 | 理由 |
|---|---|---|
| `/v1/*` 数据面 | **不等**；沿既有口径回客户端 `429 RATE_LIMITED` + `Retry-After`（`Retry-After` 取"到下一枚 token 的时间"）；**凭标记头终止本轮候选轮换、不记 key 健康、不换 key** | 让客户端等一分钟比回 429 更坏；同出口轮换必然再撞 |
| §14 **自动同步** | **不等**；本轮照常结束，退避按补遗 2 的新判据推进 | 15 分钟节拍天然就是"等下一个窗口"；等待只会把 tick 卡住 |
| §14 **手动刷新**（人在等） | **不等**；任务照常完成，计数落 `failed` + `hintCode = BALANCE_EGRESS_RATE_LIMITED` | 前端要有明确结论，不能转圈 |
| §15.2 四个批量端点 | **逐项不等**；撞到拒绝的项记失败带码，**整批不中止** | 与"一把 key 查不到不影响其余 50 把"同一条纪律（§14 文件头） |
| 自测 / 探活 | **不等**；**失败不得被读成"这把 key 坏了"** | 归因纪律（§16.7 决策 2）：谁没错，不给谁记过 |

**为什么不做"自动同步等配额"**：等待会让单飞（同上游同时只跑一次）把 tick 占住，而后退避判据已经在做同一件事
（"这一轮的额度不够 ⇒ 下一轮晚点来"），两者叠只会让节奏变复杂而不更快。

## 决策 7：缺省 = **逐字节同现状**；本期真正的保护是 `BALANCE_SYNC_MINUTES=0`

- 端口缺省实现 `permissiveEgressGate` 恒放行、恒回 `scope:'key'`；未接线时**运行时行为与改动前逐字节相同**。
  这条纪律是从 §16.7 v1.4.8 的教训直接抄来的：**接缝**不等于**修**，回执里**不得**写成"轮换放大器已掐断"。
- 因而在标定与放行之前，**唯一真正生效的保护是配置**（PM 裁决第一条）：
  26 把 key 的池子所在出口上先 **`BALANCE_SYNC_MINUTES=0`**（零代码，§14.1 既有开关；
  `status()` 仍可读、快照裁剪仍照跑 —— 已核对 `balance-sync.ts:485-498`）。
- 手动 `POST /api/keys/balance/refresh` 是**一次点击 = 26 次出口请求**，即使自动同步关着也能一秒打暗数据面
  ⇒ PM 裁决里的二次确认（画师 S3）不是可选项，是**本期唯一的手动止血**。

## 决策 8：数值占位与标定回填纪律

- 占位值：`{ capacity: 5, windowMs: 60_000, reserveForData: 1 }` —— **取自实测下界，明确标记为占位**。
  窗口长度**未测**（§16.7 v1.6.2：只知"8 次无间隔触发、约 1–2 分钟自愈"，不知"每 N 秒 8 次"还是"突发 8 次后惩罚性冷 60s"）
  ⇒ 这个占位**在最坏情况下也是保守的**（真窗口若更宽，我们只是更慢），但**不得**被读成标定结果。
- **`reserveForData` 的语义**（新增，路由者 2026-10-07）：`'management'` 消费方在
  `剩余配额 <= reserveForData` 时**必须被拒**；`'data'` 消费方不受此限。即管理面可用 = `capacity - reserveForData`，
  数据面可用 = `capacity`，**两者之和不超过 `capacity`**（同一张账，不是两张）。
  没有它，一次人工全量刷新（26 key × 2 请求 = **52 枚**）可以**合法**吃干整段预算、饿死客户端流量 ——
  这正是 §16.7 要治的"自伤"的下一个形状：不是绕过闸，是**合规地**用光闸。
- **为什么占位取 1，而不是 `capacity/2`**：capacity=5 时后者只给管理面留 2/窗口 = 30 枚/15min
  **< 52 枚/轮** ⇒ §14 自动同步一轮**永远跑不完**，PM 的"先关自动同步"会从止血变成**唯一出路**。
  取 1 时管理面 4/窗口 = 60 枚/15min ≥ 52，一轮跑得完（仍紧）。这个数与容量是**同一个标定输入的函数**，
  capacity 回填时必须一起重算 —— 写死到接线层的只有"两者都有、且和 ≤ capacity"这条**结构**。
- 回填**只改数不改结构**；标定实验（静默一夜重跑 / 干净出口 IP）按 PM 裁决列入 S4 前置项，不阻塞 S1/S2。
- **自适应兜底**：即便占位偏乐观（capacity 比真实地板大），**任何一次上游 429 都会置起冷却**（决策 5 被动两行），
  所以系统不会持续超速 —— 这是占位值可以被接受的前提。注意这条兜底的证据来源是**上游**，
  不是我们自己的拒绝（决策 5 第 1 行的 A/B 分歧正在于此）。

## 影响

| 落点 | 车道 | 内容 |
|---|---|---|
| `src/egress/`（新目录：`port.ts` + `fetch-gate.ts`） | 管家 | 端口、`egressIdOfUrl`（唯一归一化，**解析失败 → `null` 且放行**）、缺省闸、fetch 装饰器。只依赖标准库 |
| `src/gateway/egress.ts` | 路由者 | 令牌桶 + 冷却态**同一个实例**；`egressHostOf` **退化为 `egressIdOfUrl` 的薄封装或删除**；`egressLimitedOnSecondKey` 的判据**转正进闸内**；`snapshot()` 签名保持不动 |
| `src/gateway/classify.ts` | 路由者 | `neverEgressLimited` / `egressLimitedOnSecondKey` **两个识别器退休**，`EgressLimitDetector` 缝随之关闭；**不得留成"两处都能判、只是默认关着"** |
| `src/gateway/engine.ts` | 路由者 | ① `:438` 起对**带标记头的本地拒绝**新增分支：不进 `egressKeys429`、不 `reportFailure`、终止候选轮换；② 该处既有的"同一请求内第几把不同 key"改为喂 `observeLimited` 的 `correlationId` |
| `src/api/app.ts`（`ApiContext.egress` + `BuildAppOptions.egress`） | 管家 | 注入缝，缺省 `permissiveEgressGate`（形状同 `assistant`） |
| `src/api/services/supplier-accounts.ts` / `balance-refresh.ts` | 管家 | `fetchImpl` 默认值外面套 `createEgressFetch`；**调用点零改动** |
| `src/server.ts` | 接线 | **造一次、注入两处**（`buildApp` + 网关装配） |
| `docs/api-contract.md` §16.7 / §15.5 | 管家 | Tier 1.5 从"口径定死、数值占位"升级为"接口成文"；§15.5 表内那行指向本 ADR |
| `docs/api-contract.md` §7 `egress_cooldown` | 管家 | **v1.4.9「本期不发射 / 前端不得接线」翻篇**：检测器转正后该帧会真的发射，画师接线从"禁止"变为"要求"（三处接线点照 v1.4.11） |
| `web/` | 画师 | ① `HINT_CONFIG` 第 5 项 **+ 兜底**（见 ADR-0017 补遗 3，**同批硬依赖**）；② §7 `egress_cooldown` 帧接线（出口限流提示位）；③ 手动刷新二次确认 |
| `ERROR_CODES` / DTO / `SCHEMA_VERSION` | — | **零新增、零变更**（唯一枚举新增是 `HintCode`，见补遗 3） |

## 验证（用例清单，随实现提交）

1. **归一化唯一**：`egressIdOfUrl` 对大小写、默认端口、尾斜杠、带 query 的等价 URL 回同一个 id；两车道取件来自同一函数。
2. **归一化并轨**（决策 2）：`egressHostOf(x)` 与 `egressIdOfUrl(x)` 对同一输入**同值**（并轨回归锁）；
   解析失败两者都不产生出口 ⇒ **放行**（fail-open），既不拒请求也不记 key 失败。
3. **拒绝不发请求**：配额耗尽时 `inner` fetch **零调用**，调用方拿到 `429` + `Retry-After`。
4. **拒绝不换 key、不记 key 健康**（决策 4a / 5 / 6，**与文末第 4 条裁定无关**）：数据面拿到本地拒绝后
   **只打一次上游**，且 KeyPool / `key_runtime` 里该 key 的健康计数**不变**；管理面批量项记 `failed` 但**不记 key 失败**。
5. **标记头**：合成 429 带 `X-Egress-Local-Reject`，`engine.ts:438` 分支下**不进 `egressKeys429`**；
   上游真 429 不带该头、归因路径逐字节同现状。
6. **保留额度**（决策 8）：`剩余 <= reserveForData` 时 `reserve(id, 'management')` 被拒、`reserve(id, 'data')` 仍放行；
   两侧消费之和 ≤ `capacity`。
7. **归因判据只此一份**（决策 4a）：`classify.ts` 两个识别器退休后，全仓 `egressLimitDetector` 只剩一个消费者（闸内）。
8. **检测器**：同 `correlationId` 内第 1 把 key 429 → `scope:'key'`（仍记 key 失败）；第 2 把不同 key 429 → `scope:'egress'`（**不记 key 失败**）；**同一把 key 重复 429 不升级**。
9. **跨消费方共享**：同一出口上，管理面刷新把配额打完后，数据面**立刻**拿到 429（同进程、同实例）。
10. **缺省闸无害**：注入 `permissiveEgressGate` 时，全部既有用例逐字节同现状（这是防"缝变修"的回归锁）。
11. **小数不泄漏**：拒绝路径与归因路径的日志/审计/任务 result 里**不出现 key 明文**（ADR-0006 同纪律）。

## 已知缺口 / 未决

- **数值未标定**（窗口长度、是否分档）—— 占位见决策 8；标定输入仍是 §16.7 登记的第 3 样。
- **单进程假设**：多进程部署会把同出口预算乘上进程数（决策 3 末条）。
- **key 级 429 与出口级 429 在响应面上仍同形**（§16.7 v1.6.2：无专用码）；检测器只解决**归因**，不解决**可观测**。
- **`{ host, untilMs }` 与 `egressId` 一名两形**：前者是 v1.5.0 已冻结的既有签名，本批不动 ——
  这是既有债，记在这里，不在本批还。
- **`x-request-id` 是否在引擎内可取**需实现时确认；取不到则退化为调用作用域 id（判据不变，只是相关单元的粒度变粗）。

## 待 PM 裁定（四条）

1. **新顶层目录 `src/egress/`** 是否可（决策 1 的结构决策）。**两条车道现已一致**：路由者 2026-10-07
   明确"放 `src/api` 会让 gateway 反向 import 管理面，这条你判得对"，无异议 —— 只差 PM 对"新顶层目录"点头。
2. **占位数值 `{ capacity: 5, windowMs: 60_000, reserveForData: 1 }`** 是否照此写死到接线层（决策 8），
   还是等标定后一次性注入。**两条车道一致取 `capacity: 5`**（路由者 v1 提案里的 6 作废），
   且都要求结构（含 `reserveForData`）先写、数值可回填。
3. **本 ADR 与 ADR-0017 补遗同批放行**，还是先放行补遗 1（纯文案订正）止血、其余等标定。
4. **【新】我们自己拒绝时要不要写出口冷却**（决策 5 表中第 1 行）。这不是数值，是语义，且连带 §7 帧的含义：
   - **选项 A（路由者建议，本文按此写）**：**不写冷却**。桶拒绝只合成带标记头的 429 +
     `Retry-After = 到下一枚 token 的时间`，阶梯**只由上游证据推进**。理由：`cool()` 每次各推一档、
     `until` 只增不减 ⇒ 一次手动点击几十毫秒内就能爬满 30min 封顶，形成一条**无上游证据的**黑洞（见决策 5）。
   - **选项 B（ADR v1 原案）**：拒绝即 `cool()`。理由是"拒绝也是出口饱和的证据"。**代价已量化**：
     至少要把桶拒绝的冷却与上游冷却**分开计数**（否则阶梯被自拒绝推满），否则不建议。
   - **@管家 的立场**：技术上支持 A，且 A 与"不换 key"的正确定性（标记头）**解耦**，不欠 B 任何东西。
     但这条**改的是"我们自己拒绝算不算证据"这个语义**，按 PM 给的裁定范围**不自裁**，等 PM 一句话。
     **A/B 之外没有第三条**：若选 B，决策 5 的验证第 4 条要加"拒绝后 `cooldownUntil` 非空"。
