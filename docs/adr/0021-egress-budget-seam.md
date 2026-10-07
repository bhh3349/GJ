# 21. 出口（IP）预算：跨车道共享令牌桶与统一注入缝

- 状态：**草案**（待 PM 过目，S1 冻结前；**未生效** —— 放行前不改契约正文、不改代码）
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
export function egressIdOfUrl(url: string): string;
```

**为什么单列一条决策**：这是本期最容易埋的雷 —— 如果内核按 `host` 归一、管理面按 `host:port`、
或一边 `toLowerCase()` 一边没有，同一个出口就会出现**两个键** ⇒ 冷却各冷一半、预算各扣一份（等于把 5–6 变成 10–12）。
它是个纯函数，放进端口模块就是为了**不可能出现第二份实现**。

## 决策 3：端口形状 —— 同步签名、不排队、数值全部注入

```ts
/** 出口（IP）预算闸。**同步签名**：理由见下。 */
export interface EgressGate {
  /** 发请求前取一次配额。**不排队、不等待**：拒绝即刻返回，等待策略归调用方（决策 6）。 */
  reserve(egressId: string): EgressReservation;
  /** 收到 429 时报告，拿回归因结论。同一 `correlationId` 内第 2 个不同 `subject` ⇒ 出口级。 */
  observeLimited(input: EgressLimitedInput): EgressVerdict;
  /** 出口是否在冷却中；`null` = 未冷却。只读，无副作用。 */
  cooldownUntil(egressId: string): number | null;
  /** §7 v1.5.0 **已冻结**的读面，签名逐字不改。 */
  snapshot(): readonly { host: string; untilMs: number }[];
}

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

/** 缺省闸：`reserve` 恒放行、`observeLimited` 恒回 `scope:'key'`。**逐字节同现状**（决策 7）。 */
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

- 每个消费方都沿**自己既有的** 429/失败路径走，不需要新增分支；
- §14 的计数与 hint、§15.3 的批量 `failed`、数据面的 `classify` **全部不需要为"本地拒绝"写特例**；
- 拒绝与上游 429 在**证据面同形** —— 这正是 §16.7 说的"出口被限流与池饱和对调用方同形"的延续，
  管理面不该为本地拒绝发明一套新的判读方式。

> 装饰器只做两件事：`reserve` → 放行则 `inner()`，拒绝则合成 429；外加在响应为 429 时调一次
> `observeLimited`，并把 `egressId` 放回响应（供调用方归因）。

## 决策 5：预算拒绝与上游 429 **共用同一个冷却态与同一个检测器**

这是 PM 裁决里"与 §14 的 429 特判共用一个检测器"的落法，也是本 ADR 把两半缝成一体的地方：

| 证据 | 谁发现 | 动作 |
|---|---|---|
| 本窗口配额已尽（**主动**） | `reserve` 返回 `allowed:false` | 立刻 `cool(egressId, retryAfterMs)`（= 置出口级冷却），**不发请求** |
| 上游回 429，同出口**第 2 把不同 key**（**被动**，`egressLimitedOnSecondKey` 转正） | `observeLimited` 返回 `scope:'egress'` | `cool(egressId, retryAfterMs)`，**不记 key 失败** |
| 上游回 429，同出口**第 1 把** key | `observeLimited` 返回 `scope:'key'` | 沿用既有路径记该 key 失败（**代价照 §16.7 登记**：受害者 27→1，不是零成本） |

- **冷却式子不动**：仍 `max(Retry-After, 60s)`、封顶 30min、阶梯同 key 级（§16.7 裁定 ②，v1.6.2 订正过理由）。
- **数据面因此在源头不换 key**：预算拒绝 ⇒ 出口已冷却 ⇒ Tier 1 已实现的"冷却期内不换 key"直接生效。
  这比"撞完 27 把再靠检测器回头归因"更强 —— **轮换放大器在它成立之前就被掐掉了**。
- **§7 帧的 `reason` 字段被删正好在此兑现价值**（v1.5.0）：预算拒绝与上游 429 **都是同一个成因**
  （出口级 RATE_LIMITED），一个字段省下来了；将来真出现第二种成因再同批加字段与生产者。
- **连带**：检测器转正后出口冷却**真的会被置起** ⇒ §7 的 `egress_cooldown` 帧**从此开始发射**，
  §16.7 v1.4.9 的「本期不发射 / 前端不得接线」随之失效 —— 那一条要同批翻篇（见影响表）。

## 决策 6：拿不到配额时，各消费方怎么办（**不等**是默认，等待是例外）

| 消费方 | 拒绝后的行为 | 理由 |
|---|---|---|
| `/v1/*` 数据面 | **不等**；沿既有口径回客户端 `429 RATE_LIMITED` + `Retry-After`，**不换 key** | 让客户端等一分钟比回 429 更坏；同出口轮换必然再撞 |
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

- 占位值：`{ capacity: 5, windowMs: 60_000 }` —— **取自实测下界，明确标记为占位**。
  窗口长度**未测**（§16.7 v1.6.2：只知"8 次无间隔触发、约 1–2 分钟自愈"，不知"每 N 秒 8 次"还是"突发 8 次后惩罚性冷 60s"）
  ⇒ 这个占位**在最坏情况下也是保守的**（真窗口若更宽，我们只是更慢），但**不得**被读成标定结果。
- 回填**只改数不改结构**；标定实验（静默一夜重跑 / 干净出口 IP）按 PM 裁决列入 S4 前置项，不阻塞 S1/S2。
- **自适应兜底**：即便占位偏乐观，任何一次 429 都会置起冷却（决策 5），所以系统不会持续超速 ——
  这是占位值可以被接受的前提。

## 影响

| 落点 | 车道 | 内容 |
|---|---|---|
| `src/egress/`（新目录：`port.ts` + `fetch-gate.ts`） | 管家 | 端口、`egressIdOfUrl`、缺省闸、fetch 装饰器。只依赖标准库 |
| `src/gateway/egress.ts` | 路由者 | 令牌桶 + 冷却态**同一个实例**；`egressLimitedOnSecondKey` 转正；`snapshot()` 签名保持不动 |
| `src/api/app.ts`（`ApiContext.egress` + `BuildAppOptions.egress`） | 管家 | 注入缝，缺省 `permissiveEgressGate`（形状同 `assistant`） |
| `src/api/services/supplier-accounts.ts` / `balance-refresh.ts` | 管家 | `fetchImpl` 默认值外面套 `createEgressFetch`；**调用点零改动** |
| `src/server.ts` | 接线 | **造一次、注入两处**（`buildApp` + 网关装配） |
| `docs/api-contract.md` §16.7 / §15.5 | 管家 | Tier 1.5 从"口径定死、数值占位"升级为"接口成文"；§15.5 表内那行指向本 ADR |
| `docs/api-contract.md` §7 `egress_cooldown` | 管家 | **v1.4.9「本期不发射 / 前端不得接线」翻篇**：检测器转正后该帧会真的发射，画师接线从"禁止"变为"要求"（三处接线点照 v1.4.11） |
| `web/` | 画师 | ① `HINT_CONFIG` 第 5 项 **+ 兜底**（见 ADR-0017 补遗 3，**同批硬依赖**）；② §7 `egress_cooldown` 帧接线（出口限流提示位）；③ 手动刷新二次确认 |
| `ERROR_CODES` / DTO / `SCHEMA_VERSION` | — | **零新增、零变更**（唯一枚举新增是 `HintCode`，见补遗 3） |

## 验证（用例清单，随实现提交）

1. **归一化唯一**：`egressIdOfUrl` 对大小写、默认端口、尾斜杠、带 query 的等价 URL 回同一个 id；两车道取件来自同一函数。
2. **拒绝不发请求**：配额耗尽时 `inner` fetch **零调用**，调用方拿到 `429` + `Retry-After`。
3. **拒绝即冷却**：`reserve` 拒绝后 `cooldownUntil` 非空；数据面在冷却期内**不换 key**（断言只打一次上游）。
4. **检测器**：同 `correlationId` 内第 1 把 key 429 → `scope:'key'`（仍记 key 失败）；第 2 把不同 key 429 → `scope:'egress'`（**不记 key 失败**）；**同一把 key 重复 429 不升级**。
5. **跨消费方共享**：同一出口上，管理面刷新把配额打完后，数据面**立刻**拿到 429（同进程、同实例）。
6. **缺省闸无害**：注入 `permissiveEgressGate` 时，全部既有用例逐字节同现状（这是防"缝变修"的回归锁）。
7. **小数不泄漏**：拒绝路径与归因路径的日志/审计/任务 result 里**不出现 key 明文**（ADR-0006 同纪律）。

## 已知缺口 / 未决

- **数值未标定**（窗口长度、是否分档）—— 占位见决策 8；标定输入仍是 §16.7 登记的第 3 样。
- **单进程假设**：多进程部署会把同出口预算乘上进程数（决策 3 末条）。
- **key 级 429 与出口级 429 在响应面上仍同形**（§16.7 v1.6.2：无专用码）；检测器只解决**归因**，不解决**可观测**。
- **`{ host, untilMs }` 与 `egressId` 一名两形**：前者是 v1.5.0 已冻结的既有签名，本批不动 ——
  这是既有债，记在这里，不在本批还。
- **`x-request-id` 是否在引擎内可取**需实现时确认；取不到则退化为调用作用域 id（判据不变，只是相关单元的粒度变粗）。

## 待 PM 裁定（三条）

1. **新顶层目录 `src/egress/`** 是否可（决策 1 的结构决策）。
2. **占位数值 `{ capacity: 5, windowMs: 60_000 }`** 是否照此写死到接线层（决策 8），还是等标定后一次性注入。
3. **本 ADR 与 ADR-0017 补遗同批放行**，还是先放行补遗 1（纯文案订正）止血、其余等标定。
