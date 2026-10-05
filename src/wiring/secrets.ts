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

import { decryptSecret } from '../db/crypto.js';
import type { SecretResolver, UpstreamTarget } from '../gateway/ports.js';

/** 解密所需的最小列集（`upstream_keys` 的一行，已软删的不该传进来） */
export interface SecretRow {
  id: string;
  upstream_id: string;
  revision: number;
  secret: Buffer;
}

interface CachedSecret {
  revision: number;
  upstreamId: string;
  apiKey: string;
}

export interface SecretResolverOptions {
  masterKey: Buffer;
  /** 解密失败回调（只传 keyId 与错误对象，不传密文/明文） */
  onDecryptError?: (keyId: string, err: unknown) => void;
}

export interface DbSecretResolver extends SecretResolver {
  /** 用一次快照读到的行重建缓存；未变化的 key 沿用旧明文 */
  update(rows: readonly SecretRow[], baseUrlByUpstream: ReadonlyMap<string, string>): void;
  /** 当前缓存的可用 key 数（观测/自检用） */
  size(): number;
  /** 丢弃全部明文。关停时调用，别让进程带着 key 走到退出流程的后半段 */
  clear(): void;
}

export function createSecretResolver(options: SecretResolverOptions): DbSecretResolver {
  const { masterKey, onDecryptError } = options;
  const cache = new Map<string, CachedSecret>();
  // 上游 base URL 与 key 同批刷新：上游被删/禁用后，它的 key 必须一起失去出站能力
  let baseUrlByUpstream = new Map<string, string>();

  function update(rows: readonly SecretRow[], baseUrls: ReadonlyMap<string, string>): void {
    baseUrlByUpstream = new Map(baseUrls);

    const live = new Set<string>();
    for (const row of rows) {
      live.add(row.id);
      const cached = cache.get(row.id);
      if (cached !== undefined && cached.revision === row.revision && cached.upstreamId === row.upstream_id) {
        continue; // 没变：不重复解密（GCM 解密不贵，但也没必要每次都做）
      }
      try {
        cache.set(row.id, {
          revision: row.revision,
          upstreamId: row.upstream_id,
          apiKey: decryptSecret(row.secret, masterKey),
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
    clear: () => {
      cache.clear();
    },
    resolve(keyId: string): UpstreamTarget | null {
      const hit = cache.get(keyId);
      if (hit === undefined) return null;
      const baseUrl = baseUrlByUpstream.get(hit.upstreamId);
      // 没有 base URL（上游被删）→ 无法出站。返回 null 让引擎跳过这把 key，不计失败。
      if (baseUrl === undefined || baseUrl === '') return null;
      return { upstreamId: hit.upstreamId, baseUrl, apiKey: hit.apiKey };
    },
  };
}
