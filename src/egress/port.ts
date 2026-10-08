/**
 * 出口（IP）预算闸 —— **跨车道共享的冻结端口**
 * 冻结依据：docs/adr/0021-egress-budget-seam.md（决策 2 / 3 / 4a / 4c / 10）+ 契约 docs/api-contract.md §16.7
 *
 * 为什么单开一个顶层目录，而不放进 src/api 或 src/gateway：
 *   出口预算是**两条车道共同的约束** —— 数据面转发 / §14 余额刷新 / 自测 / §15.2 批量 /
 *   模型同步 / 出口自检，打出去的每一个请求都扣在**同一张配额表**上（上游按**来源 IP** 计数，
 *   连账号与 key 都不区分）。放进 `src/api` 会让 `src/gateway` 反向 import 管理面
 *   （AGENTS.md §8 禁止）；放进 `src/wiring` 则与 ADR-0017 已按"属路由者车道"处理过的归属两说。
 *   端口是**被两侧引用的公共契约**，独立目录比一个有归属争议的目录稳。
 *
 * 本文件只依赖标准库：**不** import `src/api` / `src/gateway` / `src/db`。
 * 改这里就是改契约 —— 必须同时改 docs/adr/0021-egress-budget-seam.md 与 docs/api-contract.md §16.7。
 *
 * 三个车道分工（防止"两处都能判、只是默认关着"）：
 *   - **本模块（管家）**：类型 + 常量的**唯一字面量来源** + 归一化纯函数 + 缺省闸 + fetch 装饰器；
 *   - **实现（路由者 `src/gateway/egress.ts`）**：令牌桶 + 冷却态 + 窗口化归因判据；
 *   - **接线（`src/server.ts`）**：**造一次、注入两处**（`buildApp({ egress })` + 网关装配）。
 */

/**
 * 预算消费方：`'data'` = `/v1/*` 数据面；`'management'` = §14 刷新 / 自测 / §15.2 批量 / 模型同步 / 出口自检。
 *
 * 这个字段是**保留额**（决策 8）的开关：`剩余配额 <= reserveForData` 时 `'management'` 必须被拒，
 * `'data'` 不受此限。没有它，一次人工全量刷新（26 key × 2 请求 = 52 枚）可以**合规地**吃干整段预算、
 * 饿死客户端流量 —— 那不是绕过闸，是"用光闸"。
 */
export type EgressConsumer = 'data' | 'management';

/**
 * 一次取配额的结果。
 *
 * **结构上没有 `release`**（决策 3 逐字 `{ allowed: true }` 不带句柄）：预算是**单向记账**，
 * 没有"预留再归还"这回事。加一个 `release` 就等于允许"先占位、判断后再还"，
 * 而扣减本身必须在**发请求之前**一次性成立（决策 4b：本地拒绝 = 0 次真实尝试，
 * 不能被还原成"这条路径没取过配额"）。
 */
export type EgressReservation =
  | { allowed: true }
  | {
      allowed: false;
      /** `budget` = 本窗口配额已尽；`cooldown` = 该出口正在冷却。两者对调用方**同形**（都合成 429） */
      reason: 'budget' | 'cooldown';
      /** 距离该不可用态恢复的毫秒数（写进 `Retry-After`，向上取整、至少 1s） */
      retryAfterMs: number;
    };

/** 一次上游限流（429）的证据足迹。 */
export interface EgressLimitedInput {
  /** 出口标识。Tier 1 = `upstream.host`；Tier 2 = `egress_proxies.id` —— 都经 `egressIdOfUrl` 归一 */
  egressId: string;
  /**
   * 相关单元（数据面 = 一次客户端请求；管理面 = 一轮刷新 / 一个批量任务）。
   * 数据面用 ADR-0014 已有的关联键，引擎内取不到时退化为该次调用作用域 id。
   * **只作证据关联**（v8 起）：判据数的是 `egressId` × 60s 滑动窗口，**不按相关单元分桶**。
   */
  correlationId: string;
  /**
   * 本次 429 的凭据足迹（v8）。**判据按 `accountId` 计数**：同一账号 5 把 key 全挂 = **1** 个账号；
   * `accountId === null`（`src/db/balance.ts` 的 `UNOWNED_KEY` 形状）**贡献 0**，不并入任何桶 ——
   * 没有归属就没有"跨账号"这个命题（两把无主 key 不得凑出 1 个账号）。
   * `keyId` **只作足迹 / 日志，不进计数**。
   */
  subject: { accountId: string | null; keyId: string };
  /** 上游给的 `Retry-After`（实测上游从不发，§16.7 v1.6.2） */
  retryAfterMs?: number;
}

/**
 * `observeLimited` 的**全部返回值**：本次该记谁失败。
 *
 * **全域函数（v10，total）**：任何分支都**不返回 `undefined`、不抛** —— 内部异常**就地降级**为
 * `{ attribution: 'key', cooldownUntilMs: null }` 并在 shadow 记录里打 `degraded`。
 * 判不出归因就**不动状态**（降级路径**不得** `cool()`）："炸了但要保险起见冷一下"
 * 正是把误报从"错一次短冷却"放大回"误退出口"的那条路。
 */
export interface EgressVerdict {
  /**
   * **归因**：`'egress'` = 判给出口（本次**不计 key 失败**）；`'key'` = 留在 key 级
   * （沿用既有路径记该 key 失败）。
   *
   * v9 由 `scope` 改名：判据作用域已由 `egressId × 60s` 结构性固定，"scope" 在端口上不再有第二个含义。
   * **字段本身保留** —— 两个值都在用，且它是本次调用的全部返回值。
   */
  attribution: 'key' | 'egress';
  /** 判出口级时非空：本次冷却到什么时候（epoch ms，与 §7 帧的 `cooldownUntil` **同源**） */
  cooldownUntilMs: number | null;
}

/**
 * 出口（IP）预算闸。**同步签名**：与 `src/gateway/ports.ts` 已写死的原则同源 ——
 * "端口签名刻意设计成同步，把异步挡在实现侧"。热路径上一个 async 的闸，等于给引擎开了一道
 * "不小心 await 了 IO"的门；同步签名让"发请求前必须已经拿到裁决"成为**类型层面的事实**。
 */
export interface EgressGate {
  /**
   * 发请求前取一次配额。**不排队、不等待**：拒绝即刻返回，等待策略归调用方（决策 6）。
   * `consumer` 决定能否动用**数据面保留额度**（决策 8）。
   */
  reserve(egressId: string, consumer: EgressConsumer): EgressReservation;

  /**
   * 收到 429 时报一次，拿回归因结论。判据见决策 10（同一出口 60s 滑动窗口内 ≥3 个不同账号）。
   *
   * **全域**：不返回 `undefined`、不抛（见 `EgressVerdict`）。
   * **必须在**同一处调用**产出的 shadow 记录与判据同源**，不得旁路第二个计数器（决策 10 第 (5) 条）——
   * 旁路等于让一个被打空预算的出口拿**自己拒出来的** N 张脸判成"被上游限"，然后摘掉自己。
   */
  observeLimited(input: EgressLimitedInput): EgressVerdict;

  /**
   * 出口**真的答了**（仅上游证据）→ 清连续计数、退出升档阶梯。语义同内核既有的 `noteSuccess()`。
   * 缺了它，管理面跑完一轮成功也退不了档，两侧只能绕过端口直接改状态。
   */
  observeSuccess(egressId: string): void;

  /** 出口是否在冷却中；`null` = 未冷却。只读，无副作用。 */
  cooldownUntil(egressId: string): number | null;

  /**
   * 契约 §7 v1.5.0 **已冻结**的读面，签名逐字不改。
   *
   * 两条语义是硬要求（v1.5.0 ②）：`untilMs` 是**绝对时刻**（不是剩余量）；返回**全量**、
   * 含已过期条目（差分通道没有墓碑，只报"冷却中的出口"会让解除帧永不发出）。
   */
  snapshot(): readonly { host: string; untilMs: number }[];
}

/**
 * 决策 10 第 (6) 条：shadow 观察模式的**唯一**记录形状（标定直接吃它）。
 *
 * 本期判据**默认关**，"关"的形态是**只记不动** —— 照常扫窗、照常产这条记录，
 * 但不 `cool()`、不摘除、不发射 §7 帧。**"不调用"和"调用但什么都没发现"必须在输出里可区分**，
 * 否则 N 会标定在一个已经死掉的判据上。
 */
export interface EgressShadowRecord {
  egressId: string;
  /** 60s 滑动窗口内去重后的账号数（`accountId === null` 贡献 0） */
  distinctAccounts: number;
  /** 诊断位，**不进判据**（决策 10 第 (3) 条）；本期只在 429 路径被调用，事件天然同型 */
  types: readonly string[];
  /** 判据若**真生效**会不会挂钩。观察模式下它只是记录，不改任何状态 */
  wouldFire: boolean;
  /**
   * 账号数不足 ⇒ 判据**结构上**不可能触发（决策 10 第 (5) 条）；**不得**混进"未命中"。
   *
   * 此处「账号数」= 该出口**累计见过**的账号数（进程内存、只增不剪），与上一行那个
   * **窗口级** `distinctAccounts` **不是同一个量**：按窗口级读，任何一条 `wouldFire=false`
   * 都必然同时 `insufficientAccounts=true` —— "未命中"被整体吞进"没前提"，可区分性当场失效。
   */
  insufficientAccounts: boolean;
  /** v10：内部异常就地降级。**必填位，不是可选诊断**（"判据炸了"与"什么都没发现"必须可区分） */
  degraded: boolean;
}

/**
 * shadow 记录的去处。由**具体实现的构造参数**注入（`createEgressGate({ onShadow })`），
 * **不是** `EgressGate` 的方法 —— 决策 9(5) 末条那句"本轮不新增端口方法"照旧管着；
 * 观察模式是既有方法的语义，不是新方法。
 */
export type EgressShadowSink = (record: EgressShadowRecord) => void;

/**
 * 一次注入、按已知出口取**绑定 fetch**（决策 4c）。
 *
 * Tier 2 下出口是**账号级**的，装饰器闭包够用不成立：一轮刷新里不同 key 可能绑不同出口
 * ⇒ 管理面要的是 `fetchFor(egressId, 'management')`，且出口得**贴着 key 走**。
 *
 * `egressId === null` ⇒ 直接回 `inner`、**0 次裁决**（fail-open，决策 2）。
 */
export type EgressFetchFor = (egressId: string | null, consumer: EgressConsumer) => typeof fetch;

/**
 * 合成 429 的**进程内标记头** —— **唯一字面量来源**：两侧只许 import 这两个常量，
 * 不许再写一遍字面量（写第二遍就是"两个地方都能判、只是默认关着"的温床）。
 *
 * 它的用途有两重：
 *   1. 数据面凭它**不换 key**（本地拒绝落在同一个出口上，换一把再试必然再撞）；
 *   2. 引擎 429 分支凭它**不进台账归因**（判据只在闸内一处 —— `EgressGate.observeLimited`
 *      的返回 `attribution === 'egress'`）、**不** `reportFailure`（决策 4a 第 2 条硬故障：
 *      否则一次**本地**预算拒绝会被记成"这把 key 失败一次"，几轮下来真的把好 key 停掉）。
 *
 * **不得泄漏**：仅出现在进程内合成的响应上，**不上行、不透给客户端**，由 spec 守。
 */
export const EGRESS_LOCAL_HEADER = 'x-sub2api-egress-local';
export const EGRESS_LOCAL_VALUE = '1';

/**
 * 剩余毫秒 → 写进 `Retry-After` 的秒数（向上取整，**至少 1s**）。
 *
 * 放在端口模块是因为它必须**只有一份**：`src/gateway/egress.ts` 与合成响应两处各算一遍，
 * 就是"同一个可用态两个恢复时刻"的迷你版（契约 §10 正文 `:1088`「429 一律带 `Retry-After`」）。
 */
export function retryAfterSecOf(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * 出口标识归一化 —— **全仓唯一**实现（决策 2），两车道必须引用它。
 *
 * 规则与 §16.7 逐字一致：**小写、含非默认端口**。`new URL` 负责等价写法收敛
 * （大小写、默认端口、尾斜杠、带 query 都是同一个 `host`）。
 *
 * **解析失败 / 取不到 host → `null`**，语义是 **fail-open（放行）**：宁可退回旧的 key 级处置，
 * 也不拿一个假出口去冷掉别的上游。**不得**因此拒绝请求、**不得**因此记 key 失败。
 *
 * 注意 `null` 的两种来源必须分开（决策 2）：这里管的是"**解析不出出口**"；
 * Tier 2 下 `supplier_accounts.egress_id IS NULL`（账号本就直连）**不是** `null` ——
 * 它要退回 Tier 1 推导，直连流量仍占同一个桶。混成一个 `null` 的后果不是降级，是**无上限**。
 *
 * 落地验收口径见 `docs/adr/0021-egress-budget-seam.md:189`：扫 `src/` 全集，本函数是**唯一**实现。
 */
export function egressIdOfUrl(url: string): string | null {
  try {
    const host = new URL(url).host;
    return host === '' ? null : host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 缺省闸：`reserve` 恒放行、`observeLimited` 恒回 `attribution:'key'`、`observeSuccess` 空操作、
 * `cooldownUntil` 恒 `null`、`snapshot()` 恒空。**逐字节同现状**（决策 7）。
 *
 * 这是"**接缝**"不是"**修**"：未接线时运行时行为与改动前逐字节相同 —— 回执里**不得**写成
 * "轮换放大器已掐断"。本期真正的保护是配置（`BALANCE_SYNC_MINUTES=0`）。
 *
 * **v10 口径**：「恒回 `'key'`」**不等于"不调用"** —— 判据开着但什么都没发现，同样恒回 `'key'`
 * （那是 shadow 形态）。两者的区别在 shadow 记录：本缺省闸**没有 sink**（未接线），
 * 生产装配要断言"注入的是哪个实例"，而不是靠日志反推。
 */
export const permissiveEgressGate: EgressGate = {
  reserve: () => ({ allowed: true }),
  observeLimited: () => ({ attribution: 'key', cooldownUntilMs: null }),
  observeSuccess: () => {},
  cooldownUntil: () => null,
  snapshot: () => [],
};
