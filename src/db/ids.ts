// 不透明 id 生成。契约 §0.2：id 是 string，前端不得解析其内部结构。
//
// 前缀只是为了人和日志好读（一眼看出这是 upstream 还是 key），**不构成 API 语义**。
// 前缀表集中在 ID_PREFIX，避免各处散落字符串拼接导致同一类资源出现两种前缀。

import { randomBytes } from 'node:crypto';

const ID_PREFIX = {
  upstream: 'up',
  key: 'key',
  group: 'grp',
  gatewayKey: 'gwk',
  model: 'mdl',
  task: 'task',
  log: 'log',
  audit: 'aud',
  errorEvent: 'err',
  healthSnapshot: 'hs',
  balanceSnapshot: 'bs',
  // 供应商账号（契约 §15.1 示例 `acc_…`）。id 前缀**构成 API 形状的一部分**：
  // 前端拿它当不透明串，但契约文档里已经写成 `acc_`，换一个前缀就等于换个字段值。
  supplierAccount: 'acc',
  // 台账行（§15.1 `supplier_account_keys`）。它**不出现在任何响应体里** ——
  // §15 对外只见掩码，归属关系靠 `pooled_key_id` 表达。前缀在这里纯为日志可读性。
  supplierAccountKey: 'sak',
  // 套餐行（§15.1 `supplier_account_subscriptions`）。与台账行同一条理由：
  // 不出响应体，前缀只为日志可读。**不共用 `sak_`** —— 两种行会同时出现在
  // 同一个账号的写入日志里，共用前缀会让"这一行到底是 key 还是套餐"要靠翻 SQL 才分得清。
  supplierSubscription: 'sas',
  // 出口条目（契约 §16.7.2）。id 不透明、契约不写死前缀形状，这里纯为日志可读性；
  // **不共用 `up_`** —— 出口与上游会同时出现在审计 / change_log 里，共用前缀
  // 会让"这一行是上游配置变更还是出口配置变更"要靠翻表才分得清（§9 两个广播面的读者不同）。
  egress: 'eg',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${randomBytes(6).toString('hex')}`;
}

/** 会话 id 形状与网关 key 一致但独立随机源；与网关 key 的等级类似 gatewayKeySecret()。 */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 网关 key 明文（只在签发响应里出现一次）。
 * 用 `gw-` 前缀而非 `sk-`：这是**我们自己签发**的凭据，不该长得像上游 key，
 * 否则一旦混进日志/工单，排查的人会先入为主地以为是上游凭据。
 */
export function gatewayKeySecret(): string {
  return `gw-${randomBytes(24).toString('base64url')}`;
}
