/**
 * 出口（IP）预算闸 —— **唯一集散点的 fetch 装饰器**（ADR-0021 决策 4 / 4a / 4b / 4c）
 *
 * 为什么是装饰器、而不是让每个调用方自己写 `reserve`：
 *   两条车道的出站路径都已经各有一个单一出口（内核 = `engine.ts` 的 `doFetch`；管理面 =
 *   `SupplierOps.fetchImpl` / `RefreshOptions.fetchImpl`，默认值都在 `buildApp` 一处填）。
 *   包一层就覆盖数据面 / §14 刷新 / 自测 / §15.2 批量 / 探活 / 模型同步 / 出口自检
 *   **七类出站**，且"漏了一处没走闸"这件事在类型层面就看得见（`fetchImpl` 改必填注入）。
 *   把 `reserve` 散到调用方，就是"七处都能取配额、只要有一处忘了就没人发现"。
 *
 * 装饰器**只做两件事**：`reserve` → 放行则 `inner()`，拒绝则**合成一个 429**（不落网络）。
 *   - **不 `observeLimited`**（决策 4a）：归因所需的信息（这次 429 是哪把 key / 哪个账号、
 *     属于哪一轮）装饰器手上没有，照字面调它参数是编的；把 key 塞进请求头去凑参数，
 *     是把凭据散进更低的层（ADR-0006 同纪律）。**硬故障**：合成的 429 会被内核当成上游证据，
 *     一次**本地**预算拒绝被记成"这把 key 失败一次"，几轮下来真的把好 key 停掉。
 *   - **不 `cool`、不推进阶梯、不发射 §7 帧**（决策 5 表内第 1 行）：桶拒绝是**我们自己的
 *     预算耗尽**，不是对面忙 —— 把"自己这边忙"推进 §7 帧，与 ADR-0011 §4 修掉的错误同形。
 *
 * 返回的是**工厂**（`egressId, consumer → typeof fetch`）而不是裸 `typeof fetch`：
 *   Tier 2 下出口是**账号级**的（决策 4c），一轮刷新里不同 key 可能绑不同出口，
 *   装饰器闭包拿不到它。这个类型在 `port.ts` 已冻结为 `EgressFetchFor`。
 */

import {
  EGRESS_LOCAL_HEADER,
  EGRESS_LOCAL_VALUE,
  retryAfterSecOf,
  type EgressConsumer,
  type EgressFetchFor,
  type EgressGate,
  type EgressReservation,
} from './port.js';

/**
 * 合成 429 的 body —— **PM 2026-10-07 裁定**（裁 1）：`{"error":{"code":"RATE_LIMITED"}}`。
 *
 * 为什么不是空 body：它要能过 `classify` 落到引擎的 `RATE_LIMITED` 分支（决策 4b 的终态 429），
 * 空 body 会把一次**本地**拒绝变成**未归因**错误 —— 调用方拿不到"这是限流、可以等一下再来"这个结论。
 * 形状与内核既有的错误体一致（`engine.ts` 的 `error.body.error.code`）。
 *
 * ⚠️ 它**不是**给客户端看的最终错误体：引擎按 429 分型后自己重造响应（带请求 id / §10 的码）。
 *   理由见 `EGRESS_LOCAL_HEADER` 那条 —— 进程内标记**不得透给客户端**。
 */
export const EGRESS_LOCAL_BODY = '{"error":{"code":"RATE_LIMITED"}}';

/**
 * 判定一个响应是不是**我们自己合成的**本地拒绝（决策 4a 的标记头）。
 *
 * 收成一个函数、而不是让两侧各自 `headers.get(...) === '1'`：字面量只许出现在 `port.ts` 一处，
 * 比较也必须只有一处 —— 写第二遍比较就是"两个地方都能判、只是默认关着"的温床。
 *
 * 调用方（数据面）：命中 ⇒ **不换 key**（本地拒绝落在同一个出口上，换一把再试必然再撞）、
 * **不进台账归因**（判据只在闸内一处 —— `EgressGate.observeLimited` 的返回
 * `attribution === 'egress'`）、**不 `reportFailure`**、终止候选轮换（决策 4b 的落法）。
 */
export function isLocalEgressReject(res: Response): boolean {
  return res.headers.get(EGRESS_LOCAL_HEADER) === EGRESS_LOCAL_VALUE;
}

/** 合成一次本地拒绝。`reason`（`budget` / `cooldown`）**不进响应** —— 两者对调用方同形（决策 3） */
function localRejectResponse(retryAfterMs: number): Response {
  return new Response(EGRESS_LOCAL_BODY, {
    status: 429,
    headers: {
      'content-type': 'application/json',
      // 决策 6：拒绝时**带上到恢复时刻的距离**，等待策略归调用方（我们不等）
      'retry-after': String(retryAfterSecOf(retryAfterMs)),
      [EGRESS_LOCAL_HEADER]: EGRESS_LOCAL_VALUE,
    },
  });
}

/**
 * 造一个"按已知出口取绑定 fetch"的工厂（决策 4 保名保参，返回类型取决策 4c 的 `EgressFetchFor`）。
 *
 * 语义（冻结点，改动即改契约）：
 *  - `egressId === null` ⇒ **直接回 `inner`、0 次裁决** —— 这是决策 2 的 **fail-open**：
 *    解析不出出口时宁可退回旧的 key 级处置，也不拿一个假出口去冷掉别的上游、更不拒绝请求；
 *  - `reserve` 拒绝 ⇒ **不调 `inner`、不抛**，回一个合成 429（决策 4b：客户端拿到的是
 *    **429 + `Retry-After`**，不是 `502`；且那次请求**一次网络都没发**）；
 *  - `reserve` 放行 ⇒ 原样转发给 `inner`，**不碰 `input` / `init`**（标记头只存在于进程内合成响应，
 *    不上行、不透客户端）；
 *  - `inner` 缺省 = 全局 fetch，且**测试注入假 fetch 时仍然经过闸**（决策 4）—— 这条与
 *    管理面 8 处"拆兜底、改必填注入"方向相反，是刻意的。
 *
 * **`reserve` 抛异常时就地 fail-open**（放行 + 不合成 429）：ADR 只规定了 `observeLimited` 的全域性
 * （v10），`reserve` 的异常分支没写 —— 这里按本模块既有的 fail-open 姿态补上（同 `egressIdOfUrl`
 * 解析失败 → `null`）：闸是**我们自己的进程内代码**，它炸了不应该把数据面变成 5xx，
 * 也不应该让每次请求都多一条假 key 失败（引擎若把异常当网络错误，正是"把好 key 停掉"那条路）。
 * 代价是"闸炸了"与"闸放行"在响应面同形；本期没有标定消费者依赖这一点（标定吃的是
 * `observeLimited` 的 shadow），故不引入日志面。**ADR 未写此分支，已登记请 PM 追认。**
 */
export function createEgressFetch(gate: EgressGate, inner?: typeof fetch): EgressFetchFor {
  const base: typeof fetch = inner ?? globalThis.fetch;

  return (egressId: string | null, consumer: EgressConsumer): typeof fetch => {
    if (egressId === null) return base;

    return (...args: Parameters<typeof fetch>): ReturnType<typeof fetch> => {
      let decision: EgressReservation | null;
      try {
        decision = gate.reserve(egressId, consumer);
      } catch {
        return base(...args); // fail-open：闸不可用时退回改动前的行为（决策 7 的缺省姿态）
      }
      if (!decision.allowed) return Promise.resolve(localRejectResponse(decision.retryAfterMs));
      return base(...args);
    };
  };
}
