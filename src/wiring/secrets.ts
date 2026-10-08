// 网关适配层 - `SecretResolver` 的落库实现。
//
// 边界依据：AGENTS.md §8 —— `src/gateway` 不 import `src/db`，适配器只能放在它外面。
// 冻结口径：docs/api-contract.md §9（热路径零同步 DB 写）。
//
// 为什么必须是「同步内存读」：
//   `resolve()` 在**每一次出站请求**上被调用。它一旦去查库（读锁）或解密（GCM），
//   TTFB 就被这两件事的抖动吃掉了（验收 6：TTFB 增量 P50 < 5ms）。
//   所以明文只在**快照刷新时**解密一次，之后躺在进程内 Map 里，热路径只做一次哈希查找。
//
// key 明文纪律（全仓最硬的一条，CI 有扫描断言）：
//   - 本文件解出的明文**只**放进 `UpstreamTarget.apiKey`，由引擎写进 Authorization 头；
//   - 不 log、不进错误 message、不进任何持久化路径；解密失败只报 keyId 与错误类型；
//   - 缓存以 `revision` 判重，没改动的 key 不重复解密，也不会把旧明文留在缓存里。
//
// 谁在写缓存：只有 `update()`，由 `store.refresh()` 在读到 change_log 后调用（1s 轮询兜底）。
// 本文件不 import `Db`，读写分离得干净些 —— 它只认"行"，不认"库"。
//
// 出口归属（ADR-0021 决策 5 的 E 接缝）搭同一个缓存、同一个刷新节拍：
//   `accountId` / `egressId` 在 `update()` 里从行上算一次，热路径只读。理由与明文同一条 ——
//   它们一旦改成在 `resolve()` 里现查，每次出站就多一次 SQL，TTFB 被它吃掉。

import { decryptSecret } from '../db/crypto.js';
import { egressIdOfUrl } from '../egress/port.js';
import type { SecretResolver, UpstreamTarget } from '../gateway/ports.js';

/**
 * 解密所需的列集（`upstream_keys` 的一行 + 它的**账号归属**，已软删的不该传进来）。
 *
 * 后两列来自 KEYS_SQL 的台账 join，与明文同批刷新 —— 出口归属和 key 一样是**快照期**的事实，
 * 放热路径上查库就等于把 `resolve()` 变成一次 SQL（验收 6 的 TTFB 直接崩）。
 */
export interface SecretRow {
  id: string;
  upstream_id: string;
  revision: number;
  secret: Buffer;
  /** §15.2 台账：这把 key 属于哪个供应商账号；通用上游 / 未入池 → null */
  account_id: string | null;
  /** 账号自己的出口（§16.7 Tier 2，`supplier_accounts.egress_id`）；NULL = 账号直连。**未归一化** */
  account_egress_id: string | null;
}

interface CachedSecret {
  revision: number;
  upstreamId: string;
  apiKey: string;
  accountId: string | null;
  /**
   * 归一化后的出口 id：`account_egress_id ?? egressIdOfUrl(baseUrl)`。
   *
   * 在 `update()`（= 快照重建）里算**一次**，热路径只读 —— 于是归一化在全仓只有
   * `egressIdOfUrl` 一个实现（ADR-0021 决策 2 的验收口径，见
   * `docs/adr/0021-egress-budget-seam.md:189`）。
   */
  egressId: string | null;
}

export interface SecretResolverOptions {
  masterKey: Buffer;
  /** 解密失败回调（只传 keyId 与错误对象，不传密文/明文） */
  onDecryptError?: (keyId: string, err: unknown) => void;
}

export interface DbSecretResolver extends SecretResolver {
  /** 用一次快照读到的行重建缓存；未变化的 key 沿用旧明文（出口归属照常刷新，见 `update`） */
  update(rows: readonly SecretRow[], baseUrlByUpstream: ReadonlyMap<string, string>): void;
  /** 当前缓存的可用 key 数（观测/自检用） */
  size(): number;
  /**
   * 这把 key 在**本版快照**里的出口归属（只读观测口）。
   *
   * 与 `resolve()` 分开是因为两者面向的时刻不同：`resolve()` 每次出站都调用、只回出站必需的那几个值；
   * 这里是给单测与自检一个**独立于出站面**的读点 —— 出站面是冻结形状（多个值就多一份漂移面），
   * 而归属要能被断言，否则缓存里算好的 `egressId` 是一块没有断言的死数据，写错了也不会有人知道。
   */
  egressOf(keyId: string): { egressId: string | null; accountId: string | null } | null;
  /** 丢弃全部明文。关停时调用，别让进程带着 key 走到退出流程的后半段 */
  clear(): void;
}

export function createSecretResolver(options: SecretResolverOptions): DbSecretResolver {
  const { masterKey, onDecryptError } = options;
  const cache = new Map<string, CachedSecret>();
  // 上游 base URL 与 key 同批刷新：上游被删/禁用后，它的 key 必须一起失去出站能力
  let baseUrlByUpstream = new Map<string, string>();

  /**
   * 出口 id 归一化：`account_egress_id ?? egressIdOfUrl(baseUrl)`。
   *
   * 账号指定了出口就用它（Tier 2）；没指定就退回 Tier 1 的"按上游 base URL 推导"——
   * 于是**直连流量仍占同一个桶**。把"账号没指定出口"混成一个裸 `null` 的后果不是降级，
   * 是**无上限**（`src/egress/port.ts` 的 `egressIdOfUrl` 那段注释点名的坑）。
   *
   * 空串按"没指定"处理：Tier 2 的写路径建起来之前这一列恒 NULL，而 `''` 一旦落库会变成
   * 一个**谁都匹配不上、又绕过了宿主出口兜底**的假出口 id —— 比 null 更难查。
   */
  function resolveEgressId(row: SecretRow): string | null {
    const owned =
      row.account_egress_id === null || row.account_egress_id === '' ? null : row.account_egress_id;
    return owned ?? egressIdOfUrl(baseUrlByUpstream.get(row.upstream_id) ?? '');
  }

  function update(rows: readonly SecretRow[], baseUrls: ReadonlyMap<string, string>): void {
    baseUrlByUpstream = new Map(baseUrls);

    const live = new Set<string>();
    for (const row of rows) {
      live.add(row.id);
      const egressId = resolveEgressId(row);
      const cached = cache.get(row.id);
      if (cached !== undefined && cached.revision === row.revision && cached.upstreamId === row.upstream_id) {
        // 没变：不重复解密（GCM 解密不贵，但也没必要每次都做）。
        // 但**归属可能变了而 revision 没变** —— 换账号、账号换出口，动的都是别的表，
        // 这把 key 的行一个字节都没改（ADR-0021 决策 4c 末条）。
        // 所以这里走"就地改写缓存条目"的轻路径：只覆盖归属，**不重新解密**。
        cached.accountId = row.account_id;
        cached.egressId = egressId;
        continue;
      }
      try {
        cache.set(row.id, {
          revision: row.revision,
          upstreamId: row.upstream_id,
          apiKey: decryptSecret(row.secret, masterKey),
          accountId: row.account_id,
          egressId,
        });
      } catch (err) {
        // 解不开 = 用不了。**删掉旧明文**而不是留着：留着会让"管理端换过 master key"
        // 这种事故继续用旧 key 悄悄打上游，症状会变得极难归因。
        cache.delete(row.id);
        onDecryptError?.(row.id, err);
      }
    }

    // 软删 / 物理删除的 key 立即从缓存消失（桶里那把已失效的凭据不该还留在内存里）
    for (const id of [...cache.keys()]) {
      if (!live.has(id)) cache.delete(id);
    }
  }

  return {
    size: () => cache.size,
    update,
    egressOf(keyId: string): { egressId: string | null; accountId: string | null } | null {
      const hit = cache.get(keyId);
      // 不在缓存 = 解不开或已软删，与 `resolve()` 回 null 逐字同因：不可用的 key 没有归属可言。
      if (hit === undefined) return null;
      return { egressId: hit.egressId, accountId: hit.accountId };
    },
    clear: () => {
      cache.clear();
    },
    resolve(keyId: string): UpstreamTarget | null {
      const hit = cache.get(keyId);
      if (hit === undefined) return null;
      const baseUrl = baseUrlByUpstream.get(hit.upstreamId);
      // 没有 base URL（上游被删）→ 无法出站。返回 null 让引擎跳过这把 key，不计失败。
      if (baseUrl === undefined || baseUrl === '') return null;
      return {
        upstreamId: hit.upstreamId,
        baseUrl,
        apiKey: hit.apiKey,
        // 出口归属与明文同批算好（`update()` 里一次），这里只做一次哈希查找后的读 —— 零额外成本。
        // 红线：**不得**在这个位置现算/现查（见文件头「为什么必须是同步内存读」）。
        egressId: hit.egressId,
        accountId: hit.accountId,
      };
    },
  };
}
