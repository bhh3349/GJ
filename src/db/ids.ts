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
} as const;

export type IdKind = keyof typeof ID_PREFIX;

/** 6 字节随机 → 48 bit，单机量级下碰撞概率可忽略；真撞了主键约束会立刻报错，不会静默覆盖。 */
export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${randomBytes(6).toString('hex')}`;
}

/** 会话 id 与网关 key 明文用同一档随机源；网关 key 明文长度见 gatewayKeySecret()。 */
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
