// 网关适配层 - **数据面出口代理**出站包装（ADR-0021 决策 4c / 契约 §16.7 Tier 2）。
//
// 缺口：`src/egress/fetch-gate.ts` 的装饰器**只做预算**（放行即 `inner()` 原样转发、从不注
// `dispatcher`），全仓 `ProxyAgent` 的唯一落点曾只有管理面的 `POST /api/egress/:id/test`。
// 于是"账号绑了出口、流量照样从宿主 IP 直出" —— 出口池建了、绑了，却不生效。
//
// 为什么实现落在这里（`src/wiring/`）而不是引擎：
//   · `src/gateway/` **不许认识 `undici`**（AGENTS.md §8；端口只依赖标准库）；
//   · `new ProxyAgent` 要解析 URL、建连接池 —— 逐请求做就是把 TTFB 吃掉（验收 6）。
//   所以"这个出口怎么出去"整件事归装配层：本模块在闭包里持**已缓存的 agent**，
//   引擎只收一个 `egressId → 出站 fetch` 的单参回调（`EngineOptions.egressOutbound`）。
//
// 三条硬纪律（对着缺口 A 派工令的五条铁律落）：
//   1. **组合次序**：入参 `gated` 是**已经被预算闸包好**的 fetch，我们把 `dispatcher` 注进
//      `init` **之后再调它** ⇒ 闸永远在最外层：本地拒绝（合成 429）照旧一个字节都不落网络。
//      反过来（先注 dispatcher 再包闸）等于给代理开一条绕过预算的路 —— 不这么写。
//   2. **禁每请求解密**：代理 URL 与凭据（`egress_proxies.secret`，aes-256-gcm）只在**首次用到
//      某个出口**与**该出口配置变更后**解密；对齐 `store.ts` 的明文纪律（热路径零 SQL、零解密）。
//      刷新靠 `change_log` 的 `egress` 实体（`refresh()` 挂在网关 runtime 那 1s 节拍上）。
//   3. **出站失败不得静默回落宿主直连**（决策 9(5)）：出口池里**有这一行**（`status='active'`）
//      却拿不到可用代理材料（解密失败 / url 空）时**抛**，绝不裸转发 —— 一个"绑了出口"的账号
//      偷偷从宿主 IP 出去，账却记在那个出口头上，是比报错难查得多的形状。
//      池里**没有这一行**的 id（Tier 1 的 host、账号未绑出口）= **配置事实**，原样返回 `gated`。
//
// 明文纪律：解密出来的 `user:pass` 只进 `ProxyAgent` 的构造参数，不进日志、不进错误 message；
// `check:secrets` 的 `proxy-url-credentials` 规则同批守这条。

import { ProxyAgent } from 'undici';
import { decryptEgressProxySecret } from '../db/repo/egress.js';
import { changesSince } from '../db/repo/change-log.js';
import type { Db } from '../db/database.js';

/** `egress_proxies` 的一行（只取出口出站要用的四列；`secret` 是密文 BLOB，NULL = 免认证） */
interface EgressRow {
  id: string;
  url: string;
  secret: Buffer | null;
  status: 'active' | 'retired';
}

interface KnownEntry {
  url: string;
  secret: Buffer | null;
  status: 'active' | 'retired';
}

interface CachedAgent {
  agent: ProxyAgent;
  /**
   * 缓存判据 = 这一版出口配置的指纹（url + 密文 BLOB）。
   *
   * 用**密文**而不是解出来的明文做判据：指纹只活在进程内、只用来判"要不要重建 agent"，
   * 一旦用明文，它就变成第二份明文副本（明文纪律：只许出现在 `ProxyAgent` 的构造参数里）。
   */
  fingerprint: string;
}

export interface EgressProxyLifecycleOptions {
  db: Db;
  masterKey: Buffer;
  /** 解密失败回调（只传 egressId 与错误对象，**不传密文/明文**） */
  onError?: (egressId: string, err: unknown) => void;
}

export interface EgressProxyLifecycle {
  /** 交给 `GatewayRuntimeOptions.egressOutbound`（引擎只认这个签名） */
  outbound: (egressId: string, gated: typeof fetch) => typeof fetch;
  /** 按 `change_log` 的 `egress` 实体增量重建：挂在网关 runtime 的 1s 节拍上 */
  refresh(): void;
  /** 关停：丢弃全部 agent（连接池）与配置镜像。签名与 `Stoppable` 同形 */
  stop(): void;
}

/** `egress_proxies` 的出站材料（唯一读点；只读四列，不碰 last_test_* 等展示字段） */
const ROWS_SQL = 'SELECT id, url, secret, status FROM egress_proxies';
const MAX_SEQ_SQL = 'SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log';

function fingerprintOf(url: string, secret: Buffer | null): string {
  return `${url}|${secret === null ? '' : secret.toString('base64')}`;
}

/** 代理 URL 带上认证（`user:pass` 从密文解出，只在此处拼装，不外传） */
function proxyUrlWithCredentials(base: string, credentials: string): string {
  const at = credentials.indexOf(':');
  if (at < 0) return base;
  const head = base.indexOf('//');
  const rest = head < 0 ? base : base.slice(head + 2);
  const scheme = head < 0 ? '' : base.slice(0, head + 2);
  return `${scheme}${encodeURIComponent(credentials.slice(0, at))}:${encodeURIComponent(credentials.slice(at + 1))}@${rest}`;
}

export function createEgressProxyLifecycle(options: EgressProxyLifecycleOptions): EgressProxyLifecycle {
  const { db, masterKey, onError } = options;

  /** 出口池当前全部行（active + retired）：用它区分「不在池里 = 直连」与「在池里但不可用 = 抛」 */
  const known = new Map<string, KnownEntry>();
  const agents = new Map<string, CachedAgent>();
  let lastSeq = 0;
  let primed = false;

  function closeAgent(id: string): void {
    const cached = agents.get(id);
    if (cached === undefined) return;
    agents.delete(id);
    // `close()` 返回 Promise：这里不等（关停/刷新路径上不等），但**必须调** ——
    // 不关就是把旧连接池、旧代理凭据留在进程里，这正是明文纪律最不想看到的那种残留。
    try {
      void cached.agent.close();
    } catch {
      /* 关不掉不阻塞关停：连接池由进程退出一并回收 */
    }
  }

  function rebuild(): void {
    const rows = db.prepare(ROWS_SQL).all() as EgressRow[];
    const live = new Set<string>();
    known.clear();
    for (const row of rows) {
      live.add(row.id);
      known.set(row.id, { url: row.url, secret: row.secret, status: row.status });
    }
    // 行被删 / 退役不影响出站？退役由 `egressSelectable` 在引擎侧拦（死绑定 503），
    // 这里只负责"材料变了就重建 agent"；行没了就把 agent 丢掉（别留着一条没人用的隧道）。
    for (const id of [...agents.keys()]) {
      if (!live.has(id)) closeAgent(id);
    }
  }

  /**
   * 取该出口的 agent（**唯一解密点**）。
   *
   * 指纹没变 ⇒ 复用同一个 agent（**零解密、零连接池重建**，验收 6 的 TTFB 就压在这条上）；
   * 变了 ⇒ 关掉旧的、按新配置重建一把。
   */
  function agentFor(id: string, entry: KnownEntry): ProxyAgent {
    const fingerprint = fingerprintOf(entry.url, entry.secret);
    const cached = agents.get(id);
    if (cached !== undefined && cached.fingerprint === fingerprint) return cached.agent;

    let proxyUrl = entry.url;
    if (entry.secret !== null) {
      let credentials: string;
      try {
        credentials = decryptEgressProxySecret(entry.secret, masterKey);
      } catch (err) {
        // 解不开 = 用不了。**抛**（决策 9(5)）：绝不拿一个没有凭据的裸地址去连 ——
        // 那既会认证失败，也会让"配置坏了"看起来像"出口慢"。
        onError?.(id, err);
        throw new Error(`egress ${id} 的代理凭据无法解密`);
      }
      proxyUrl = proxyUrlWithCredentials(entry.url, credentials);
    }

    if (cached !== undefined) closeAgent(id);
    const agent = new ProxyAgent(proxyUrl);
    agents.set(id, { agent, fingerprint });
    return agent;
  }

  return {
    outbound(egressId: string, gated: typeof fetch): typeof fetch {
      const entry = known.get(egressId);
      // 不在出口池：Tier 1 的 host 型 id（账号未绑出口 = 直连）——**配置事实，不是回落**。
      if (entry === undefined) return gated;
      if (entry.status !== 'active') {
        throw new Error(`egress ${egressId} 已退役，不得从宿主 IP 直连出站`);
      }
      const agent = agentFor(egressId, entry);
      return (input, init) => {
        // 次序冻结点：`gated` 先裁决预算，代理只挂在"闸放行之后"那一层。
        // `dispatcher` 不是标准 `RequestInit` 字段（Node 的 fetch 由 undici 实现，认这个洞），
        // 故与 `src/api/routes/egress.ts:235` 的管理面探活同款 cast；改 cast 前先确认上游实现。
        const withProxy = { ...(init ?? {}), dispatcher: agent } as unknown as RequestInit;
        return gated(input, withProxy);
      };
    },

    refresh(): void {
      if (!primed) {
        // 首次：把 seq 对齐到当前水位，别把历史 change_log 当成"新变更"全量重放（同 store.ts）。
        const max = db.prepare(MAX_SEQ_SQL).get() as { seq: number };
        lastSeq = max.seq;
        primed = true;
        rebuild();
        return;
      }
      const rows = changesSince(db, lastSeq, 500) as { seq: number; entity: string }[];
      let relevant = false;
      for (const row of rows) {
        lastSeq = row.seq;
        if (row.entity === 'egress') relevant = true;
      }
      if (relevant) rebuild();
    },

    stop(): void {
      for (const id of [...agents.keys()]) closeAgent(id);
      known.clear();
    },
  };
}
