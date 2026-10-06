// 关联键 `x-request-id` 的**唯一实现处**（契约 §6「关联键」/ ADR-0014）。
//
// 为什么单独一个文件、而不是散在网关 routes 里现写：
//   这个值会**原样进三个地方** —— 我们的响应头、发给上游的请求头、两张表的列。
//   规则一旦有两处实现，就会出现"网关收的时候按一套判、sink 落库时按另一套判"，
//   于是同一个请求在两列里长得不一样 —— 那比没有关联键更糟。
//
// 纪律：全部 O(1) 内存操作，不碰 DB、不 await、不抛。

import { randomUUID } from 'node:crypto';

/** 头名只有这一处定义：产出侧不许内联字符串，也不许自己写正则。 */
export const REQUEST_ID_HEADER = 'x-request-id';

/** 上限 64：装得下 UUID（36）与常见带前缀 trace id，又不至于让一列塞进任意长串。 */
export const MAX_REQUEST_ID_CHARS = 64;

/**
 * 合法性白名单：`^[A-Za-z0-9._-]{8,64}$`。
 *
 * 为什么是**白名单**而不是"排掉危险字符"：这个值会被我们原样回写进响应头。
 * CR/LF 是响应头注入的经典入口，而"排掉几个字符"的写法总会漏掉下一个
 * （C0 控制字符、` `、超长串……）。白名单把这一整类问题一次关掉。
 *
 * 下界 8 是防"占位符"（`x`、`123`）：短到那种程度的 id 不可能真的唯一，
 * 收下来只会让两列看起来有值、实际对不上。
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * 入站值是否可用。
 *
 * 重复头（数组）一律**按非法处理**，不挑一个用：同一个头出现两次是可疑输入，
 * 而且挑第一个会让我们与上游（可能挑最后一个）记的不是同一个值。
 */
export function isValidRequestId(value: unknown): boolean {
  return typeof value === 'string' && VALID_REQUEST_ID.test(value);
}

/** 生成一个新的关联键。UUID v4，纯内存，无 IO。 */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * 解析出**最终生效**的关联键：入站值合法则沿用，否则重新生成。
 *
 * 非法**不报错**（契约 §6）：坏 ID 是诊断信息缺失，不是业务参数错误，
 * 不该让调用方的请求失败。同理也**不截断**——截一段再回写等于伪造一个
 * 我们没有遵守的 id，重新生成反而干净。
 */
export function resolveRequestId(inbound: unknown): string {
  return isValidRequestId(inbound) ? (inbound as string) : generateRequestId();
}
