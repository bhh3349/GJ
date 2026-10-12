// 共享凭据选择器（契约 §5 v1.11.2 / ADR-0026）。
//
// 给「要打上游管理接口」的离散动作（模型同步、能力探测）选一把 key，并在**凭据失效**
// （401/403）时换下一把。sync 与 probe 共用同一份实现 —— 两份口径早晚会漂，而漂的方式
// 恰好是「其中一条路径又选中了一把观测不到的死 key」。
//
// 为什么要有这个文件：2026-10-12 起 sync 持续 401，根因是旧的 pickSyncKey 只取
// `ORDER BY created_at, id` 的第一把启用 key —— 它不问台账绑定、不问健康，401 也不换把。
// 它选中的那把是全库唯一没有 `supplier_account_keys` 台账绑定的「孤儿 key」，上游侧凭据早已失效。
// 详见 docs/adr/0026-sync-credential-rotation.md。
//
// 纪律：
//   - 解密出口**唯一**：`decryptedKeyRefs()`（db/repo/keys.ts）。本文件不另写解密。
//   - 明文**一次只持有一把**：逐把调用 decryptedKeyRefs，不在内存里同时铺开整个候选集。
//   - 换把判定**只认 HTTP 状态码** 401/403，不解析任何文案（§16.1 决策 4 同向）。
//   - 不改冷却、不写 key_runtime、不写 usage_logs（§9 与 §12 纪律），这些都不是本文件的职责。

import type { Db } from '../../db/database.js';
import { decryptedKeyRefs, type DecryptedKeyRef } from '../../db/repo/keys.js';

/**
 * 装配默认尝试把数（实现常量，**不进契约**）。
 *
 * 为什么是 3 而不是 1：1 就是现状（无换把）；给 2~3 把足够覆盖「个别孤儿 key 混在队首」
 * 这一真实故障形态，又不会在一次全局凭据失效时把整池 key 轮询一遍（那既烧出口预算、又拖慢同步）。
 */
export const CREDENTIAL_ATTEMPT_BUDGET = 3;

/** 本轮换把的可观测位：**只含计数与掩码**，不含明文、不落库。省略在调用方 = 未换过。 */
export interface CredentialAttempt {
  /** 真解出并向上游发过请求的把数 */
  tried: number;
  /** 依次用过的 key 掩码（`****` 形态，与列表页同一口径） */
  usedMaskedKeys: string[];
  /** 发生了多少次「上一把失败、换下一把」 */
  switched: number;
}

/**
 * 上游按状态码判定的**凭据类**错误（401 / 403）。
 *
 * 单独一个类是为了让「换把」这件事只依赖状态码一个事实 —— 把判定写成
 * `err.message.includes('401')` 那种，会在某天有人改了错误文案时静默失效。
 */
export class UpstreamCredentialError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'UpstreamCredentialError';
    this.status = status;
  }
}

/**
 * 候选 key id：该上游 **已启用、未软删** 的 key，按「有 active 台账绑定的优先 → `created_at, id` 稳定序」。
 *
 * 为什么要绑定的优先：无台账绑定的 key 是「不在观测面里」的（管理面/sync 路径不喂 key_runtime，
 * 又常常零数据面流量），它失效时没有任何信号 —— 让它排在队首，等于把一次静默 401 变成**第一个**动作。
 *
 * 排序键 `created_at, id` 与 `decryptedKeyRefs` 的既有出口逐字一致；台账行缺失（非账号面上游，
 * 例如手工建 key 的上游）时按 `(b.n IS NULL)` 自然退化回原序，**不做「无绑定就排除」的一刀切** ——
 * 那会直接排空非账号面上游的候选集。
 */
export function pickCredentialKeyIds(db: Db, upstreamId: string): string[] {
  const rows = db
    .prepare(
      `SELECT k.id AS id
       FROM upstream_keys k
       LEFT JOIN (
         SELECT s.pooled_key_id AS pooled_key_id, COUNT(*) AS n
         FROM supplier_account_keys s
         JOIN supplier_accounts a ON a.id = s.account_id
         WHERE a.status = 'active'
         GROUP BY s.pooled_key_id
       ) b ON b.pooled_key_id = k.id
       WHERE k.upstream_id = ? AND k.deleted_at IS NULL AND k.enabled = 1
       ORDER BY (b.n IS NULL), k.created_at, k.id`,
    )
    .all(upstreamId) as { id: string }[];
  return rows.map((r) => r.id);
}

/** 一次尝试的结论：`ok` 采用结果并收工；`retry` 表示凭据疑似失效、换下一把。 */
export type RotationOutcome<T> = { outcome: 'ok'; value: T } | { outcome: 'retry'; error: unknown };

export interface RotationResult<T> {
  result: T;
  /** 最终采用的那把（含掩码，**不含明文** —— `DecryptedKeyRef` 不带 toJSON，丢出去也不会被序列化） */
  used: DecryptedKeyRef;
  attempts: CredentialAttempt;
}

/**
 * 按候选顺序逐把尝试，401/403 换下一把，直到成功或预算耗尽。
 *
 * `attempt` 的契约：**只有**判定为「凭据失效」时返回 `retry`；其余错误（超时 / 网络 / 5xx /
 * 结构不认识）应当**直接抛出** —— 那些不是换一把 key 能解决的问题，换把只会把一次真故障
 * 伪装成「试了三把都失败」。
 *
 * 预算耗尽时抛**最后一个**错误（保留其原始类型与状态码语义），不伪造一个「全部失败」的聚合错误。
 */
export async function tryWithRotation<T>(
  db: Db,
  upstreamId: string,
  masterKey: Buffer,
  budget: number,
  attempt: (ref: DecryptedKeyRef) => Promise<RotationOutcome<T>>,
  noKeyMessage = '该上游没有已启用的 key',
): Promise<RotationResult<T>> {
  const ids = pickCredentialKeyIds(db, upstreamId);
  if (ids.length === 0) throw new Error(noKeyMessage);

  const capped = Math.max(1, Math.min(budget, ids.length));
  const attempts: CredentialAttempt = { tried: 0, usedMaskedKeys: [], switched: 0 };
  let lastError: unknown = null;

  for (let i = 0; i < capped; i += 1) {
    const id = ids[i] as string;
    // 逐把解密：明文在内存里只存活一把的时长
    const ref = decryptedKeyRefs(db, { keyIds: [id] }, masterKey)[0];
    if (ref === undefined) continue; // ids 与本 WHERE 同源，理论上取不到；取不到就跳过而非崩

    attempts.tried += 1;
    attempts.usedMaskedKeys.push(ref.maskedKey);

    const res = await attempt(ref);
    if (res.outcome === 'ok') {
      return { result: res.value, used: ref, attempts };
    }

    lastError = res.error;
    // 还有下一把才记一次「换把」：最后一把失败是终止，不是切换
    if (i < capped - 1) attempts.switched += 1;
  }

  throw lastError ?? new Error('所有候选 key 均未通过（凭据疑似失效）');
}
