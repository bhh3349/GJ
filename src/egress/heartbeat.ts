/**
 * 出口池心跳**生产者** —— §7 `egress_pool` 帧里 `status` / `exitIp` / `lastHeartbeatAt`
 * 三条冻结字段的数据来源（契约 v1.6.4 那句「生产者不存在」由此关闭）。
 *
 * 冻结依据：docs/api-contract.md §7（`egress_pool` 字段表 + 四条纪律）
 *           docs/adr/0020-egress-ip-rate-limit.md 决策 8（心跳状态机参数）
 *           docs/adr/0021-egress-budget-seam.md 决策 9(4)（自动摘除**不落库**）
 *
 * 为什么生产者放在 `src/egress/`、而不是 `src/gateway/` 或 `src/api/`：
 *   它既不是数据面选路（`src/gateway`），也不是管理面 REST（`src/api`）—— 它是**出口健康态**
 *   这台状态机，与预算闸同属「两条车道共同的约束」（`port.ts` 文件头那条理由）。
 *   且本文件**不许 import `src/db`**（AGENTS.md §8）：出口清单由**接线层注入**（`src/server.ts`），
 *   于是「读哪张表」这件事留在装配层，状态机本身可以离线判据。
 *
 * 三条不可漂移的口径（每条都对应一类会静默出错的事故）：
 *   1. **`status` 只由证据给出，不做新鲜度推断**。契约 §7 写死「前端不得按 `lastHeartbeatAt`
 *      的“新鲜度”自己算健康」；同一把刀反过来也成立：**生产者也不许**因为"心跳多久没来了"
 *      就把节点判离线 —— 那是第二套健康语义（决策 9(4) 禁的就是这个）。停摆时该看到的是
 *      `lastHeartbeatAt` 变旧，**不是**状态翻转。
 *   2. **本地合成拒绝不算失败证据**（决策 4a 同源）。探活走 `fetchFor(egressId,'management')`，
 *      于是"预算耗尽 / 正在冷却"会以**合成 429** 的形式回来。它是我们自己拒的，不是对面挂了；
 *      把它计入连败，一次人工全量刷新就能把整池出口摘除 —— 与 ADR-0011 §4 修掉的错误同形。
 *      判据只有一处：`isLocalEgressReject()`（字面量归 `port.ts`）。
 *   3. **摘除/回池是内存态、不落库**。重启后回到冷启动（`online` + `null`）是**契约内行为**，
 *      不是 bug；写进 `egress_proxies.status` 才会造出第二套健康语义。
 *
 * 两个证据入口、**一台**状态机（`applyEvidence`）：
 *   A. **文件收件箱轮询**（默认、推荐）：`deploy/vps-egress/pool-probe.sh --json` 由 systemd
 *      timer 定时写进 `EGRESS_HEARTBEAT_INBOX_DIR`，生产者每拍取「最新且未吃过的那份」。**0 次
 *      上游请求**（echo 端点打的是 VPS 侧那条出口，不占 TierFlow 配额，见 ADR-0020 决策 8）。
 *   B. **进程内主动探活**（可选，接线传 `probe: true`）：网关自己打 echo 端点。代价写死在这里：
 *      它**吃 `management` 预算**（capacity 5/60s − reserveForData 1 = 4 枚），两个节点按 30s
 *      一拍就是 4 枚/60s —— 会把 `/test` 与余额刷新的额度吃干。所以默认关，且被闸拒掉时
 *      **不产生证据**（口径 2）。
 *   同一拍里 A 优先：A 已给出证据的节点不再跑 B（一份证据 = 一次采样，两个入口叠加会把
 *   「连续 3 次失败」变成「连续 3 拍 6 个样本」，节奏口径当场失真）。
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createEgressFetch, isLocalEgressReject } from './fetch-gate.js';
import { egressIdOfUrl, type EgressFetchFor, type EgressGate } from './port.js';
import { toIso } from '../util/time.js';

/** 心跳节奏（契约 §7 的 30s；接线层经 `setIntervalMs` / 环境变量改节奏）。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** 连续失败多少次摘除（ADR-0020 决策 8）。 */
export const HEARTBEAT_EVICT_AFTER_FAILURES = 3;
/** 摘除后回池的滞回（ADR-0020 决策 8）。滞回期内的成功**不回池**，但也不推翻失败计数。 */
export const HEARTBEAT_REJOIN_HYSTERESIS_MS = 5 * 60_000;
/** 单次探活超时。与 `pool-probe.sh` 的 `TIMEOUT=10` 同口径。 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * 出口 IP 的形状判据 —— 与 `src/api/routes/egress.ts` 的 `/test` **逐字同一条**（`egress.ts:238`）。
 *
 * 为什么不 import 那一处：那是管理面（`src/api`），本文件按 AGENTS.md §8 不许反向依赖。
 * 复制的代价由 spec 承担（`heartbeat.spec.ts` 里有一条断言比对两个文件的这条正则字面量，
 * 漂移即红）—— 两处各写一遍、且**没有判据**才是真的风险。
 */
const EXIT_IP_SHAPE = /^[0-9a-fA-F:.]{3,45}$/;

export type EgressNodeStatus = 'online' | 'offline';

/** 接线层注入的**节点配置**（来自 `egress_proxies` 的 `status='active'` 行）。 */
export interface EgressNodeConfig {
  /** `egress_proxies.id` —— §7 帧的 `egressId`，不透明、前端不得解析 */
  egressId: string;
  /** `egress_proxies.name` —— 只作展示，**不作键**（用户可改） */
  name: string;
  /** 归一化后的代理 URL（不含凭据）。状态机的键走 `egressIdOfUrl`，这里只是推导材料 */
  proxyUrl: string;
}

/**
 * §7 `egress_pool` 帧里一个节点的全部字段（**终局名，别改名**，与契约 §7 字段表逐字对应）。
 *
 * `cooldownUntil` 不在状态机里：它由 `EgressGate.cooldownUntil(egressId)` **现取**，
 * 于是「探活态」与「上游限流态」各有各的唯一事实源（契约那条「两种不可用并列展示、
 * 不得互相盖掉」在数据结构层面就成立，不靠约定）。
 */
export interface EgressPoolNode {
  egressId: string;
  name: string;
  status: EgressNodeStatus;
  exitIp: string | null;
  expectedExitIp: string | null;
  /** 最近一次**真证据**的绝对时刻（ISO8601 UTC）。冷启动 = null */
  lastHeartbeatAt: string | null;
  cooldownUntil: string | null;
}

/** 一条证据。`ok=false` 时 `exitIp` 仍可能非空（`ip_mismatch`：看到了 IP，但不是登记的那个）。 */
interface Evidence {
  ok: boolean;
  exitIp: string | null;
  expectedExitIp: string | null;
  /** 证据采集时刻（epoch ms）。`lastHeartbeatAt` 就是它，**不许**用"距今多少秒" */
  atMs: number;
  /** 分型（`ok` / `timeout` / `proxy_unreachable` / `ip_mismatch`…），只进日志、不进帧 */
  detail: string | null;
}

interface NodeState {
  config: EgressNodeConfig;
  status: EgressNodeStatus;
  failures: number;
  /** 最近一次置起离线的时刻（滞回计时起点）；在线时为 null */
  evictedAtMs: number | null;
  exitIp: string | null;
  expectedExitIp: string | null;
  lastHeartbeatAt: string | null;
  /** 诊断：累计吃过多少条被闸拒掉的探活（不进帧，只给日志/验收看） */
  localRejects: number;
}

/** 冷启动 = online + null（决策 8 的契约内行为，重启即回到它，见口径 3）。 */
function coldState(cfg: EgressNodeConfig): NodeState {
  return {
    config: cfg,
    status: 'online',
    failures: 0,
    evictedAtMs: null,
    exitIp: null,
    expectedExitIp: null,
    lastHeartbeatAt: null,
    localRejects: 0,
  };
}

/**
 * 一台状态机吃一条证据（收件箱与进程内探活共用这一个入口）。
 * 口径 1 的落点：状态**只**随证据翻转 —— 进程停摆、心跳断供、inbox 断写都**不**翻转它。
 * 成功证据：记 IP；在线则清连败；离线则过了滞回才回池（滞回内的成功只记 IP 不回池）。
 * 失败证据：`lastHeartbeatAt` 照记（心跳到了，只是报告坏消息），连败 +1，达阈值摘除并起滞回。
 * `ip_mismatch` 不清连败 —— 看到了 IP 不等于从对的出口出去（"填了代理却走宿主 IP"是静默故障）。
 */
function applyEvidence(state: NodeState, ev: Evidence, now: number): void {
  state.lastHeartbeatAt = toIso(new Date(ev.atMs));
  if (ev.expectedExitIp !== null) state.expectedExitIp = ev.expectedExitIp;
  if (ev.ok) {
    state.exitIp = ev.exitIp;
    if (state.status === 'online') {
      state.failures = 0;
      return;
    }
    if (state.evictedAtMs !== null && now - state.evictedAtMs >= HEARTBEAT_REJOIN_HYSTERESIS_MS) {
      state.status = 'online';
      state.evictedAtMs = null;
      state.failures = 0;
    }
    return;
  }
  if (ev.exitIp !== null) state.exitIp = ev.exitIp; // ip_mismatch 的观测 IP 照记（告警原料，契约 §7）
  if (state.status === 'offline') return; // 已摘除：不再累计，等滞回后的成功回池
  state.failures += 1;
  if (state.failures >= HEARTBEAT_EVICT_AFTER_FAILURES) {
    state.status = 'offline';
    state.evictedAtMs = now;
    state.exitIp = null;
  }
}

/** 吃过的收件箱文件指纹（内存态，重启后自然重新吃一次 —— 冷启动语义的一部分）。 */
class IngestLedger {
  private readonly seenDigests = new Set<string>();
  has(digest: string): boolean {
    return this.seenDigests.has(digest);
  }
  mark(digest: string): void {
    this.seenDigests.add(digest);
  }
}

/**
 * 收件箱读取：目录里 `*.json` 按 mtime 取**最新一份**、按内容 SHA-256 记账防重吃。
 * 同一份只吃一次：systemd 每 30s 覆写一份也不会把「3 次心跳」变成「3 份证据」。
 * 目录不存在 / 读失败 / JSON 半截 = 本拍该入口无新证据，**不是错误**（口径：断供不改状态）。
 * 行的键 = `pool-probe.sh` 输出的 `host`（`scheme://host:port` 去掉凭据后的 host，
 * 与 `egressIdOfUrl` 同一套归一），**不是** `name` —— name 用户可改，不作键（契约 §7 同款纪律）。
 */
export interface InboxRow {
  ok: boolean;
  egressIp: string | null;
  expectedIp: string | null;
  detail: string | null;
}

export interface InboxItem {
  checkedAtMs: number;
  rows: Map<string, InboxRow>;
}

function readInbox(dir: string, ledger: IngestLedger, now: number): InboxItem | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null; // 目录不存在 = 入口 A 未启用，不是错误
  }
  let newest: { file: string; mtimeMs: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      if (newest === null || st.mtimeMs > newest.mtimeMs) newest = { file: full, mtimeMs: st.mtimeMs };
    } catch {
      continue; // 竞态：恰好被下一次覆写删掉，下一拍再取
    }
  }
  if (newest === null) return null;
  let raw: string;
  try {
    raw = readFileSync(newest.file, 'utf8');
  } catch {
    return null;
  }
  const digest = createHash('sha256').update(raw).digest('hex');
  if (ledger.has(digest)) return null; // 最新的一份已经吃过 → 本拍无新证据
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    return null; // 半截文件（写入方 crash 中途）→ 不吃，等下一份完整覆盖
  }
  if (typeof doc !== 'object' || doc === null || !Array.isArray((doc as { results?: unknown }).results)) {
    return null;
  }
  const rows = new Map<string, InboxRow>();
  for (const item of (doc as { results: unknown[] }).results) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (typeof r.host !== 'string' || r.host === '') continue;
    rows.set(egressIdOfUrl(r.host) ?? r.host.toLowerCase(), {
      ok: r.ok === true && r.status === 'ok',
      egressIp: typeof r.egressIp === 'string' && r.egressIp !== '' ? r.egressIp : null,
      expectedIp: typeof r.expectedIp === 'string' && r.expectedIp !== '' ? r.expectedIp : null,
      detail: typeof r.detail === 'string' ? r.detail : null,
    });
  }
  ledger.mark(digest);
  // 证据时刻取文档的 checkedAt（VPS 上探针真正跑的那一刻），不是网关读到它的时刻——
  // 收件箱天然滞后，用读取时刻会把传输延迟抹平成 0，lastHeartbeatAt 就成了谎。
  const docAt = typeof (doc as { checkedAt?: unknown }).checkedAt === 'string' ? Date.parse((doc as { checkedAt: string }).checkedAt) : NaN;
  return { checkedAtMs: Number.isNaN(docAt) ? now : docAt, rows };
}

/** 证据分型的日志行（不进帧、不进 DB —— 口径 3 的"只在内存与日志"）。 */
export interface HeartbeatLogLine {
  egressId: string;
  source: 'inbox' | 'probe';
  detail: string | null;
}

export interface HeartbeatProducerDeps {
  /** `EgressGate`（与数据面/管理面**同一个实例**：`cooldownUntil` 帧字段同源、探活扣同一张预算表） */
  gate: EgressGate;
  /** 节点配置（接线层从 `egress_proxies` 读 active 行；本模块不 import `src/db`） */
  nodes: readonly EgressNodeConfig[];
  /** 收件箱目录；`null` = 入口 A 关闭 */
  inboxDir: string | null;
  /** 入口 B 开关（默认关，理由见文件头） */
  probe?: boolean;
  /** 绑定 fetch 工厂；缺省 = 按**同一个闸**造（`createEgressFetch(gate)`），探活扣 management 预算 */
  fetchFor?: EgressFetchFor;
  /** 探活端点；缺省 ipify（与 `pool-probe.sh` 缺省同源） */
  echoUrl?: string;
  /** 注入日志（生产接线传 gateway/app 的 logger；缺省静默） */
  onLog?: (line: HeartbeatLogLine) => void;
  /** 测试注入时钟（epoch ms）；缺省 Date.now。心跳节奏与 `lastHeartbeatAt` 都吃它 */
  now?: () => number;
}

export interface HeartbeatProducer {
  /** 运行中改节奏，下一拍生效 */
  setIntervalMs(ms: number): void;
  /** 立即跑一拍（收件箱 → 探活 → 应用证据）。`stop()` 之后返回 `{ stopped: true }` */
  tick(): Promise<{ stopped: true } | undefined>;
  /** 契约 §7 的帧读面：全量节点（含离线）+ 现取的 `cooldownUntil`。**同步、无副作用** */
  poolSnapshot(): EgressPoolNode[];
  /** `src/wiring/shutdown.ts` 的停机钩子形状：清定时器、不再接受新 tick */
  stop(): void;
}

export function startHeartbeatProducer(deps: HeartbeatProducerDeps): HeartbeatProducer {
  const now = deps.now ?? (() => Date.now());
  const onLog = deps.onLog ?? (() => {});
  // 缺省工厂用**传入的同一个闸**：探活必须与数据面/管理面扣同一张预算表（决策 4c 的"造一次"），
  // 且被拒时回的是带标记头的合成 429 —— 口径 2 的判据才有得判。
  const fetchFor = deps.fetchFor ?? createEgressFetch(deps.gate);
  const ledger = new IngestLedger();
  const states = new Map<string, NodeState>();
  for (const cfg of deps.nodes) states.set(cfg.egressId, coldState(cfg));

  let intervalMs = HEARTBEAT_INTERVAL_MS;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function tick(): Promise<{ stopped: true } | undefined> {
    if (stopped) return { stopped: true };
    const at = now();

    // 入口 A：文件收件箱（优先，见文件头"A 优先"）
    const fed = new Set<string>();
    if (deps.inboxDir !== null) {
      const item = readInbox(deps.inboxDir, ledger, at);
      if (item !== null) {
        for (const state of states.values()) {
          const id = egressIdOfUrl(state.config.proxyUrl);
          if (id === null) continue; // 解析失败 → 本拍无证据，不是失败（port.ts 的 fail-open 同款）
          const row = item.rows.get(id);
          if (row === undefined) continue;
          fed.add(id);
          applyEvidence(
            state,
            {
              ok: row.ok,
              exitIp: row.egressIp,
              expectedExitIp: row.expectedIp,
              atMs: item.checkedAtMs,
              detail: row.detail,
            },
            at,
          );
          onLog({ egressId: state.config.egressId, source: 'inbox', detail: row.detail });
        }
      }
    }

    // 入口 B：进程内探活（默认关；只打本拍未吃到证据的节点，扣 management 预算）
    if (deps.probe === true) {
      for (const state of states.values()) {
        const id = egressIdOfUrl(state.config.proxyUrl);
        if (id === null || fed.has(id)) continue;
        const ev = await probeOnce(state, id, at);
        if (ev === null) continue; // 被闸拒掉：零证据（口径 2），静默等待下一拍
        applyEvidence(state, ev, at);
        onLog({ egressId: state.config.egressId, source: 'probe', detail: ev.detail });
      }
    }
    return undefined;
  }

  /** 被闸拒掉时返回 `null`（= 零证据），其余任何结果都算证据。 */
  async function probeOnce(state: NodeState, id: string, at: number): Promise<Evidence | null> {
    const call = fetchFor(id, 'management');
    const controller = new AbortController();
    const killer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await call(deps.echoUrl ?? 'https://api.ipify.org', { signal: controller.signal });
      if (isLocalEgressReject(res)) {
        state.localRejects += 1;
        return null;
      }
      const ip = (await res.text()).trim();
      const shapeOk = EXIT_IP_SHAPE.test(ip);
      const mismatch = state.expectedExitIp !== null && ip !== state.expectedExitIp;
      return {
        ok: res.ok && shapeOk && !mismatch,
        exitIp: shapeOk ? ip : null,
        expectedExitIp: state.expectedExitIp,
        atMs: at,
        detail: !res.ok ? `http_${res.status}` : !shapeOk ? 'bad_response' : mismatch ? 'ip_mismatch' : 'ok',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        exitIp: null,
        expectedExitIp: state.expectedExitIp,
        atMs: at,
        // abort 的 message 是运行时措辞，只认"超时"这一类；其余原样进日志便于分型
        detail: controller.signal.aborted ? 'timeout' : `proxy_unreachable:${msg}`,
      };
    } finally {
      clearTimeout(killer);
    }
  }

  function loop(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(() => loop());
    }, intervalMs);
    // 定时器不该吊住进程退出（关停由 shutdown 钩子负责，不靠它）
    timer.unref?.();
  }
  loop();

  return {
    setIntervalMs(ms) {
      intervalMs = ms;
    },
    tick,
    poolSnapshot() {
      const out: EgressPoolNode[] = [];
      for (const state of states.values()) {
        const cooling = deps.gate.cooldownUntil(egressIdOfUrl(state.config.proxyUrl) ?? '');
        out.push({
          egressId: state.config.egressId,
          name: state.config.name,
          status: state.status,
          exitIp: state.exitIp,
          expectedExitIp: state.expectedExitIp,
          lastHeartbeatAt: state.lastHeartbeatAt,
          cooldownUntil: cooling === null ? null : toIso(new Date(cooling)),
        });
      }
      return out;
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
