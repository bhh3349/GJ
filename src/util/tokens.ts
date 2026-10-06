// token 估算的**唯一实现处**（契约 §0.2 / §13.3）。
//
// 为什么提到 `src/util`：这条例要同时被两侧用到 ——
//   1. 网关（`src/gateway/usage.ts`）：上游没给 usage 时按字符估算并标 `is_estimated`；
//   2. 管理面（助手 §13.3）：三重上限里"单条 / 总 token"的确定性代理。
// 而 `src/api` 不许 import `src/gateway`（AGENTS.md §8 架构边界），反过来也不行
// （内核不许知道管理面的存在）。两处各写一份 = 口径分叉，且分叉了**不会报错**：
// 同一段历史会在网关算 99 token、在助手算 100 token，用户看到的是"同一条上下文，
// 两处上限判定不一样"。所以只留一份实现在中立层，两边都调它。

/**
 * 估算：ASCII 0.25 token/字符，非 ASCII（中日文等）1 token/字符；向上取整、最小 0。
 *
 * 这是**代理值**，不是计费口径 —— 真实计费一律以上游返回的 usage 为准（契约 §0.2）。
 * 它只负责两件事：缺 usage 时记账，以及给 §13.3 的上限判定一个**确定性**答案
 * （确定性是这条的全部要求：同一段文本必须永远算出同一个数）。
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! > 0x7f) wide += 1;
    else ascii += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}
