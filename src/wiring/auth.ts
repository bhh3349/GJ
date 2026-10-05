// 网关适配层 - `GatewayAuth`：网关 key 明文 → 用户组。
//
// 边界依据：AGENTS.md §8。冻结口径：docs/api-contract.md §4 / §10。
//
// 这里是**实时读库**，不是快照 —— 与 SecretResolver 的"内存读"要求刻意相反，别照抄：
//   - 鉴权读的是 `gateway_keys.key_hash`（sha256 摘要），索引命中、单行、无解密，
//     读一次的成本在一次 LLM 调用面前可以忽略（微秒级）；
//   - 换来的是**撤销立即生效**：管理端点"重置 key"，下一个请求就 401。
//     若在这里放缓存，被重置的 key 会继续有效到缓存过期 —— 一把已经作废的凭据还能用，
//     这是安全问题，不是性能问题。
//   - 「热路径零同步 DB 写」禁的是**写**；读不在那条约束里（快照那套是为了躲读锁抖动，
//     而 WAL 下读不阻塞写、写也不阻塞读，读锁抖动只出现在 checkpoint）。
//
// 明文纪律：网关 key 明文只在本函数栈上活着，落库比对用的是 sha256 摘要，
// 不 log、不进错误信息（路由层对"不存在"与"已禁用"一律回同一句话，别在这里制造探测窗口）。

import { sha256Hex } from '../db/crypto.js';
import { findGroupByGatewayKeyHash } from '../db/repo/groups.js';
import type { Db } from '../db/database.js';
import type { GatewayAuth, GroupContext } from '../gateway/ports.js';

export function createDbGatewayAuth(db: Db): GatewayAuth {
  return {
    async authenticate(gatewayKey: string): Promise<GroupContext | null> {
      // 空串不该到达这里（路由层已挡），但摘要空串会得到一个无意义的哈希，顺手挡掉
      if (gatewayKey === '') return null;
      const row = findGroupByGatewayKeyHash(db, sha256Hex(gatewayKey));
      if (row === null) return null;
      return {
        groupId: row.id,
        name: row.name,
        enabled: row.enabled === 1,
        rpm: row.rpm,
        tpm: row.tpm,
        dailyQuota: row.daily_quota,
      };
    },
  };
}
