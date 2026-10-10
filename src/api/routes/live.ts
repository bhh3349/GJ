// 实时通道 `WS /api/stats/live` 服务端。契约 §7。
//
// 这个文件是「不许做假数据」在实时场景下的落点：仪表盘上的 QPS / 健康灯 / 余额
// 如果靠前端定时拉 REST，数字在两次拉取之间就是陈旧的，而前端**无从知道自己手上的数字多旧**。
// 所以由服务端主动推，且每帧都带 `serverTime`，前端据此判断新鲜度并降级呈现（契约 §7 末段）。
//
// 五条纪律，每条都在下面有对应的实现点：
//   1. **会话判定放在握手成功之后**。握手阶段回 HTTP 401 的话，浏览器只看得到"连接异常中断"
//      （1006），前端就无法把「会话过期，去登录」（4401）与「服务挂了，退避重连」（1006）
//      分开 —— 这两件事的用户动作完全相反。代价是 app.ts 的鉴权闸门要为这条路径开一个例外，
//      所以例外条件写得极窄：方法 + 路径 + `Upgrade` 头三者同时满足。
//   2. **Origin 必须判**。WebSocket 不受同源策略保护：浏览器会带着 Cookie 发起**跨站**升级请求，
//      而且这里没有 CSRF 那三层头可查（那三层是 fetch 才有的）。Origin 是这条链路上唯一的结构性防线。
//   3. **一个进程一个 1s ticker**，第一个订阅者到达时启动、最后一个离开时停止。
//      没人看仪表盘的时候不该每秒查一次库 —— 它是"有观众才有的成本"，不是常驻后台任务。
//   4. **按客户端做差分**。每个连接各记一份"上次推出去的状态指纹"，指纹变了才发帧。
//      于是新连上来的客户端在第一个 tick 就拿到全量状态（它什么都没记过），
//      而在线的客户端稳态下每秒只收一帧 metrics —— 不重复推没变的东西。
//   5. **关停用 1012**。契约 §7 里 1012 的含义是"服务重启 → 退避重连"，
//      而 1000 的含义是"登出 → 不重连"。一次部署重启绝不该把所有人踢去重新登录，
//      所以 WS 插件的默认 preClose（用 1000 关连接）被我们在 app.ts 里换掉了。

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { computeGlobalBalance } from '../../db/balance.js';
// **type-only** import（方案 A 的关键约束）：发射面只消费 `EgressPoolNode` 这个**形状**，
// 不在运行时依赖心跳生产者 —— 否则 `src/api/` 会在模块图上拉起 `src/egress/heartbeat.ts`
// 的文件 IO 与定时器，而那件事属于接线层（`src/server.ts`）。终局名由 `heartbeat.ts` 持有，
// 契约 §7 冻结；这里引用它而不是重抄一遍，是为了让"字段漂移"在编译期就红。
import type { EgressPoolNode } from '../../egress/heartbeat.js';
import type { Db } from '../../db/database.js';
import { listLiveKeyStates } from '../../db/repo/keys.js';
import { listLiveTasks } from '../../db/repo/tasks.js';
import { computeOverview } from '../../db/stats.js';
import { nowIso } from '../../util/time.js';
import { sessionAlive, touchSession } from '../auth.js';
import { originHostMatches, sessionCookieValue } from '../http.js';
import type { ApiContext } from '../app.js';

/** 契约 §7 的关闭码表。前端 live.ts 按这张表决定"跳登录 / 重连 / 不重连"。 */
export const WS_CLOSE = {
  /** 会话失效 → 跳登录页 */
  SESSION_EXPIRED: 4401,
  /** 就绪超时 → 重连一次 */
  READY_TIMEOUT: 4408,
  /** 服务重启 → 退避重连 */
  SERVICE_RESTART: 1012,
  /** 正常关闭（登出）→ 不重连 */
  NORMAL: 1000,
} as const;

/** ws 的 `readyState`。用字面量而不是引 `ws` 的运行时值：它只是 @fastify/websocket 的传递依赖。 */
const WS_OPEN = 1;
/** 1008 policy violation：跨站来源被拒。前端 LIVE 客户端见到它会走默认分支（退避重连），符合预期。 */
const WS_POLICY_VIOLATION = 1008;

/** 推送节奏。契约 §7 写死 1s，且验收 3 只要求"5s 内呈现"，余量充足。 */
const TICK_MS = 1000;
/** 与 `/api/stats/overview` 的默认窗口同口径，前端两张卡片才对得上。 */
const WINDOW_SECONDS = 60;
const READY_TIMEOUT_MS = 5000;
/** 会话复查间隔（tick 数）。低频是因为它要**读库**：1s 一次会把只读检查变成一条常驻查询。 */
const SESSION_RECHECK_TICKS = 5;
/** 心跳间隔（tick 数）：30s 探一次半开连接。 */
const HEARTBEAT_TICKS = 30;
/** 关停时留给 close 帧上路的宽限期。 */
const CLOSE_GRACE_MS = 200;

/**
 * 握手期的会话判定，返回会话 token（此后只读复查要用）或 null。
 *
 * 用 `touchSession` 而不是 `sessionAlive`：建连是一次性动作，顺手把滑动续期做掉是正确的；
 * 而连接建立之后每秒复查绝不能再走这条写路径（见 auth.ts `sessionAlive` 的注释）。
 */
function handshakeSession(db: Db, ttlHours: number, req: FastifyRequest): string | null {
  const token = sessionCookieValue(req);
  if (token === null) return null;
  return touchSession(db, token, ttlHours) === null ? null : token;
}

/**
 * 升级请求的来源校验。口径与 CSRF 第一层**完全一致**（`allowedOrigins` 白名单，空则同源）。
 * 不一致的话就会留下一条绕过路径：写请求被 CSRF 挡住，但同源的 WS 通道能推数据出去。
 */
function originAllowed(req: FastifyRequest, allowedOrigins: readonly string[]): boolean {
  const origin = req.headers.origin;
  // 没有 Origin = 非浏览器客户端（脚本/测试）。它们拿不到受害者的 Cookie，
  // "用受害者的浏览器打我们"这个攻击面不存在，放行；否则 CLI 订阅只能靠伪造 Origin。
  if (typeof origin !== 'string' || origin === '') return true;
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  return originHostMatches(origin, req.headers.host);
}

/** 首帧必须是 `{"type":"auth"}`（契约 §7 第 3 步），仅作就绪确认，不携带任何凭据。 */
function isAuthFrame(data: unknown): boolean {
  const text =
    typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : null;
  if (text === null) return false;
  try {
    const parsed = JSON.parse(text) as { type?: unknown } | null;
    return typeof parsed === 'object' && parsed !== null && parsed.type === 'auth';
  } catch {
    return false;
  }
}

function send(socket: WebSocket, json: string): void {
  if (socket.readyState !== WS_OPEN) return;
  socket.send(json);
}

/**
 * `close()` 要经过一次关闭握手（对端可能永远不回），所以关停路径上配合 terminate 用。
 * 它**不能**用在一开始：close 帧还没出网就被 terminate，客户端只会看到 1006，
 * 那就把 4401/4408/1012 这三个有语义的码全变成了同一个"未知断开"。
 */
function closeQuietly(socket: WebSocket, code: number, reason: string, graceMs = 0): void {
  if (socket.readyState !== WS_OPEN) {
    socket.terminate();
    return;
  }
  try {
    socket.close(code, reason);
    if (graceMs > 0) {
      // unref：这个定时器不该成为进程退出的理由（进程退出时 socket 自然也没了）
      setTimeout(() => socket.terminate(), graceMs).unref();
    }
  } catch {
    socket.terminate();
  }
}

interface DiffFrame {
  /** 差分键，形如 `health:key_x`。三类帧共用一个 Map，靠前缀区分。 */
  id: string;
  /** 状态指纹：变了才发。 */
  sig: string;
  json: string;
}

/** 发射缝的读面形状：**同步、无副作用**（契约 §7「同一 tick、同一份出口快照」）。 */
export type EgressPoolProvider = () => readonly EgressPoolNode[];

/** 池级帧的**唯一**差分键（契约 §7 v1.6.4：一帧覆盖全池，不是每出口一帧）。 */
export const EGRESS_POOL_FRAME_ID = 'egress:pool';

/**
 * 池级帧的指纹。**必带 `lastHeartbeatAt` 与 `cooldownUntil`**（契约 §7 四条纪律之四）：
 * 前者每 30s 一次心跳 = 真变化，该推；后者会**自然到期**，那一刻没有任何写入动作、
 * 只有时间流逝 —— 与 `key_health` 同一个坑、同一个解法。
 * 另带 `status` / `exitIp` / `expectedExitIp`（三条都是终局值），以及 `name`：
 * 改名是用户动作，不带进指纹的话卡片会停在旧名字直到下一次状态变化。
 * 顺序按 `egressId` 排定 —— 指纹必须与 Map 迭代顺序无关，否则一次进程重启就会白推一帧。
 */
function egressPoolSig(nodes: readonly EgressPoolNode[]): string {
  return [...nodes]
    .sort((a, b) => (a.egressId < b.egressId ? -1 : a.egressId > b.egressId ? 1 : 0))
    .map((n) => `${n.egressId}|${n.status}|${n.name}|${n.exitIp ?? ''}|${n.expectedExitIp ?? ''}|${n.lastHeartbeatAt ?? ''}|${n.cooldownUntil ?? ''}`)
    .join(';');
}

interface TickFrames {
  metricsJson: string;
  health: DiffFrame[];
  balance: DiffFrame[];
  task: DiffFrame[];
  /**
   * 池级帧（**恒长 1**，见 `egressPoolFrames`）。
   * 刻意不是 `[] | [frame]`：契约要求「`nodes` 为空也要注册」，而"空数组"这个形状
   * 会让 `tickNow` 里的 `live` 集合注册退化成条件分支 —— 那条分支就是"0 个出口 = 零帧"
   * 这个 bug 的诞生地。类型上收不掉的错误，就别留给调用方自觉。
   */
  egressPool: DiffFrame[];
}

/**
 * 一次 tick 的全部快照。**每个 tick 只查一遍库**，然后分发给所有客户端 ——
 * 每客户端各查一次的话，连接数就是查询数的乘数。
 */
function buildTickFrames(
  db: Db,
  serverTime: string,
  egressPool: EgressPoolProvider,
): TickFrames {
  const overview = computeOverview(db, WINDOW_SECONDS);
  const global = computeGlobalBalance(db);

  const metricsJson = JSON.stringify({
    type: 'metrics',
    // 窗口口径由后端回显（前端不许本地自算），与 /api/stats/overview 的 window 同一套
    window: overview.window,
    serverTime,
    qps: overview.qps,
    successRate: overview.successRate,
    requests: overview.requests,
    tokensTotal: overview.tokens.total,
    // 全部未知时是 null（不是 0）—— ADR-0003 的 null 纪律同样适用于实时通道
    balanceGlobal: global.totalBalance,
    balanceUnknownKeyCount: global.balanceUnknownKeyCount,
  });

  const health: DiffFrame[] = listLiveKeyStates(db).map((s) => ({
    id: `health:${s.keyId}`,
    // 指纹里带 cooldownUntil 是必须的：冷却会**自然到期**，那一刻没有任何写入动作，
    // 只有时间流逝。指纹不带它，冷却结束的灯就会一直停在黄灯上。
    sig: `${s.health}|${s.cooldownUntil ?? ''}|${s.lastFailureReason ?? ''}`,
    json: JSON.stringify({ type: 'key_health', serverTime, ...s }),
  }));

  const balance: DiffFrame[] = [];
  for (const upstream of global.byUpstream) {
    for (const k of upstream.keys) {
      // balanceUpdatedAt 为 null = 这把 key **从未查询过**，没有"变动"可推；
      // 且前端类型把该字段声明为非空，推 null 是拿契约赌一个它没承诺的形状。
      // 它的初始状态由 REST 全量接口（/api/stats/balance）承担，这里只负责"变化"。
      if (k.balanceUpdatedAt === null) continue;
      balance.push({
        id: `balance:${k.keyId}`,
        sig: `${k.balance}|${k.balanceUpdatedAt}|${k.balanceSource ?? ''}`,
        json: JSON.stringify({
          type: 'balance',
          serverTime,
          keyId: k.keyId,
          maskedKey: k.maskedKey,
          balance: k.balance,
          balanceUpdatedAt: k.balanceUpdatedAt,
          balanceSource: k.balanceSource,
          globalTotalBalance: global.totalBalance,
          balanceUnknownKeyCount: global.balanceUnknownKeyCount,
        }),
      });
    }
  }

  const task: DiffFrame[] = listLiveTasks(db).map((t) => ({
    id: `task:${t.id}`,
    sig: `${t.status}|${t.progress.done}/${t.progress.total}|${t.message ?? ''}`,
    // 契约 §7 的 task 帧**没有** serverTime（其余帧都有），照契约原样发，不多加字段
    json: JSON.stringify({
      type: 'task',
      taskId: t.id,
      status: t.status,
      progress: t.progress,
      message: t.message,
    }),
  }));


  // 池级帧（方案 A 发射缝的唯一产出点）。**恒长 1**，且未接线也发 —— 见 TickFrames.egressPool
  // 的注释：「0 个出口 = 零帧」这个 bug 的诞生地就是把它写成条件分支。
  // 读面是同步的 provider：本 tick 的所有帧共享同一条 serverTime，
  // 出口快照与 metrics 因此同拍，前端不必猜两帧的先后。
  const egressFrames: DiffFrame[] = egressPoolFrames(egressPool(), serverTime);

  return { metricsJson, health, balance, task, egressPool: egressFrames };
}

/**
 * 造**一帧**池级帧：一帧覆盖全池（契约 §7 v1.6.4），不是每出口一帧。
 *
 * `nodes: []` 也要注册差分键：它说的是「当前没有出口」这件事本身，
 * 从有到零是一次真变化，前端据此切「未配置出口」空态。
 * 空数组在 JSON 里是 `"nodes":[]`（有生产者、池为空），与字段缺失是两回事。
 */
function egressPoolFrames(nodes: readonly EgressPoolNode[], serverTime: string): DiffFrame[] {
  return [
    {
      id: EGRESS_POOL_FRAME_ID,
      sig: egressPoolSig(nodes),
      json: JSON.stringify({ type: 'egress_pool', serverTime, nodes }),
    },
  ];
}

interface LiveClient {
  socket: WebSocket;
  token: string;
  ticks: number;
  /** 心跳用：本周期内是否收到过 pong。 */
  alive: boolean;
  /** 差分状态：`id → 指纹`（见 DiffFrame）。 */
  seen: Map<string, string>;
}

export interface LiveHub {
  /** 客户端就绪后接入（发完 `ready` 帧再调）。 */
  attach(socket: WebSocket, token: string): void;
  detach(socket: WebSocket): void;
  /**
   * 立刻跑一次推帧，不改变 ticker 的节奏。
   *
   * 存在的理由是**测试的确定性**：帧内容与差分逻辑不该依赖"等真实时钟走 1 秒"，
   * 那种测试又慢又会偶发。间隔定时器本身仍按契约的 1s 走，这个入口只是提前把同一段
   * 逻辑跑一遍 —— 不是第二条推帧路径。
   */
  tickNow(): void;
  /** 关停：停 ticker + 用 1012 关掉所有连接。 */
  shutdown(): void;
  /** 当前订阅数（测试与运维观测用）。 */
  size(): number;
}

class Hub implements LiveHub {
  private readonly clients = new Map<WebSocket, LiveClient>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
    /** false = 不装真实定时器（拍子只由 `tickNow()` 驱动，见 `LiveHubOptions`）。 */
    private readonly autoTick: boolean = true,
    /** 发射缝（方案 A）：每拍现取出口池快照；缺省 = 未接线 = 每拍空 nodes。 */
    private readonly egressPool: EgressPoolProvider = () => [],
  ) {}

  size(): number {
    return this.clients.size;
  }

  attach(socket: WebSocket, token: string): void {
    if (this.clients.has(socket)) return;
    const client: LiveClient = { socket, token, ticks: 0, alive: true, seen: new Map() };
    this.clients.set(socket, client);
    // pong 是**协议层**的：浏览器自动回，不经过页面 JS。所以它是判断
    // "这条 TCP 连接后面还有没有一个活着的对端"唯一可靠的信号。
    socket.on('pong', () => {
      client.alive = true;
    });
    this.ensureTimer();
  }

  detach(socket: WebSocket): void {
    this.clients.delete(socket);
    if (this.clients.size === 0) this.stopTimer();
  }

  shutdown(): void {
    this.stopTimer();
    const clients = [...this.clients.values()];
    this.clients.clear();
    for (const c of clients) {
      closeQuietly(c.socket, WS_CLOSE.SERVICE_RESTART, 'service restart', CLOSE_GRACE_MS);
    }
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    if (!this.autoTick) return;
    const timer = setInterval(() => this.tickNow(), TICK_MS);
    // 不为进程续命：ticker 活着只说明"有人在看仪表盘"，不说明"服务该运行"
    timer.unref();
    this.timer = timer;
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private broadcast(json: string): void {
    for (const client of this.clients.values()) send(client.socket, json);
  }

  tickNow(): void {
    if (this.clients.size === 0) {
      this.stopTimer();
      return;
    }

    let frames: TickFrames;
    try {
      frames = buildTickFrames(this.db, nowIso(), this.egressPool);
    } catch (err) {
      // 一帧失败**不关连接**：断线会让前端把整块仪表盘降级成"已断开·重连中"，
      // 而实际上只是这一秒的聚合查询出了错，下一 tick 大概率就恢复了。
      this.log.error({ err }, '实时通道快照失败');
      this.broadcast(JSON.stringify({ type: 'error', code: 'INTERNAL', message: '实时数据读取失败' }));
      return;
    }

    // 本 tick 仍然存在的差分键：用它清掉已消失的 key/task，
    // 否则一条长连接的 seen 会随着 key 的增删只涨不落。
    const live = new Set<string>();
    for (const f of frames.health) live.add(f.id);
    for (const f of frames.balance) live.add(f.id);
    for (const f of frames.task) live.add(f.id);
    // 池级帧恒在（哪怕 nodes 为空）：它的差分键不随出口增减消失，
    // 从 live 集合里漏掉它 = 下一拍会被 seen 清理剪除，「池从有到空」那次变化就丢了。
    for (const f of frames.egressPool) live.add(f.id);

    for (const client of [...this.clients.values()]) {
      if (client.socket.readyState !== WS_OPEN) {
        this.detach(client.socket);
        continue;
      }

      client.ticks += 1;

      if (client.ticks % HEARTBEAT_TICKS === 0) {
        // 半开连接（对端进程没了、TCP 还没断）不会触发 close。不探活的话这条"客户端"
        // 会永远留在集合里：ticker 停不下来，每秒照常查库，而对面根本没人看。
        if (!client.alive) {
          this.detach(client.socket);
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        client.socket.ping();
      }

      // 会话复查：只读、低频。有它，管理员在别处登出或会话被清理后，
      // 这条长连接不会一直推到会话自然过期为止。
      if (client.ticks % SESSION_RECHECK_TICKS === 0 && !sessionAlive(this.db, client.token)) {
        this.detach(client.socket);
        closeQuietly(client.socket, WS_CLOSE.SESSION_EXPIRED, 'session expired');
        continue;
      }

      send(client.socket, frames.metricsJson);
      for (const f of frames.health) this.pushIfChanged(client, f);
      for (const f of frames.balance) this.pushIfChanged(client, f);
      for (const f of frames.task) this.pushIfChanged(client, f);
      for (const f of frames.egressPool) this.pushIfChanged(client, f);

      for (const key of [...client.seen.keys()]) {
        if (!live.has(key)) client.seen.delete(key);
      }
    }
  }

  private pushIfChanged(client: LiveClient, frame: DiffFrame): void {
    if (client.seen.get(frame.id) === frame.sig) return;
    client.seen.set(frame.id, frame.sig);
    send(client.socket, frame.json);
  }
}

export interface LiveHubOptions {
  /**
   * 是否由真实 1s 定时器驱动推帧，默认 `true`（契约 §7 的线上节奏）。
   * 测试传 `false`，把拍子完全交给 `tickNow()` —— 理由与 `BuildAppOptions.liveAutoTick` 同。
   */
  autoTick?: boolean;
  /**
   * 出口池读面（方案 A 的注入点）。**缺省 = 未接线**：每拍发 `nodes: []`。
   * 发射面只经 type-only import 消费形状，运行时不依赖心跳生产者 ——
   * 实例由接线层（`src/server.ts` → `buildApp`）持有并注入。
   */
  egressPool?: EgressPoolProvider;
}

export function createLiveHub(db: Db, log: FastifyBaseLogger, options: LiveHubOptions = {}): LiveHub {
  return new Hub(db, log, options.autoTick ?? true, options.egressPool ?? (() => []));
}

/**
 * 注册 `GET /api/stats/live`。hub 由调用方创建并注入，因为 WS 插件的 `preClose`
 * 需要在**注册插件时**就能拿到它（见 app.ts 的关停注释）。
 */
export function registerLiveRoutes(app: FastifyInstance, ctx: ApiContext, hub: LiveHub): void {
  app.get('/api/stats/live', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    // 顺序：来源 → 会话 → 就绪握手。
    // Origin 放在最前：它拦的是"借别人的浏览器打我们"，与"来者是谁"无关，
    // 先判它可以让跨站请求连会话探测的机会都没有。
    if (!originAllowed(req, ctx.config.allowedOrigins)) {
      closeQuietly(socket, WS_POLICY_VIOLATION, 'origin not allowed');
      return;
    }

    const token = handshakeSession(ctx.db, ctx.config.sessionTtlHours, req);
    if (token === null) {
      closeQuietly(socket, WS_CLOSE.SESSION_EXPIRED, 'session expired');
      return;
    }

    let attached = false;
    const readyTimer = setTimeout(() => {
      // 契约 §7：5s 内没等到 auth 帧就关 4408。前端那边也在 5s 主动断，
      // 不是冗余：前端可能卡在别的分支没走到超时，服务端不能留一条半开连接白占资源。
      if (!attached) closeQuietly(socket, WS_CLOSE.READY_TIMEOUT, 'ready timeout');
    }, READY_TIMEOUT_MS);
    readyTimer.unref();

    socket.on('message', (data: unknown) => {
      // 就绪之后收到什么都不再改变状态：契约 §7 的首帧协议到此为止，
      // 没有"改订阅"这种扩展，多余的消息只能是前端 bug 或有人在乱发。
      if (attached) return;
      if (!isAuthFrame(data)) return;
      attached = true;
      clearTimeout(readyTimer);
      // 先回 ready 再接入 hub：反过来的话，客户端可能在收到 ready 之前先收到一帧 metrics，
      // 而它的状态机还没进入 ready —— 契约里 ready 就是"此后收到的帧都算数"的分界点。
      send(socket, JSON.stringify({ type: 'ready', serverTime: nowIso(), intervalMs: TICK_MS }));
      hub.attach(socket, token);
    });

    socket.on('close', () => {
      clearTimeout(readyTimer);
      hub.detach(socket);
    });
  });
}
