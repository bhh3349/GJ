// Fastify 应用装配：错误收口、鉴权闸门、CSRF、路由注册。
//
// 这里有两道「全量」闸门（契约 §0.5）：
//   1. `/api/*` 除 `POST /api/auth/login` 外全部要求有效会话；
//   2. 写方法全部过 CSRF 三层校验。
// 实现方式是把闸门放在 onRequest 钩子里一次判完，而不是散在每个 handler 里 ——
// 后者只要有人新加一个路由忘了写守卫，就静默变成公开接口。
//
// **唯一的例外是 WS 握手**（`GET /api/stats/live` + `Upgrade: websocket`），
// 而且它只是"换了个地方判"：会话校验挪到升级成功之后的 handler 里，用 4401 关连接。
// 原因是协议层面的 —— 升级请求回 HTTP 401 的话，浏览器只看得到连接异常中断（1006），
// 前端就没法把"会话过期"和"服务不可用"分开处理。见 isLiveHandshake 与 routes/live.ts。
//
// 错误体在 setErrorHandler 里统一成 `{code,message,details?}`，
// 包括 Fastify 自己的 schema 校验错误：它默认的形状不符合契约，
// 且前端拿不到 `details.field` 就没法把表单那一栏标红。

import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/database.js';
import { NO_ASSISTANT_METRICS } from '../db/observability.js';
import { permissiveEgressGate, type EgressGate } from '../egress/port.js';
import { unwiredAssistantInvoker, type AssistantModelInvoker } from './assistant-port.js';
import { LoginRateLimiter, requireSession, type SessionInfo } from './auth.js';
import { createBalanceSync, type BalanceSync } from './balance-sync.js';
import type { AssistantMetricsDto } from './dto.js';
import { ApiError } from './errors.js';
import { createHealthSnapshotWriter } from './health-snapshot-writer.js';
import { isWriteMethod, sessionCookieValue, verifyCsrf } from './http.js';
import { registerAssistantRoutes } from './routes/assistant.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerKeyRoutes } from './routes/keys.js';
import { createLiveHub, registerLiveRoutes, type LiveHub } from './routes/live.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerModelRoutes } from './routes/models.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerSupplierAccountRoutes } from './routes/supplier-accounts.js';
import { registerUpstreamRoutes } from './routes/upstreams.js';
import { supplierOps, type SupplierOps, type SupplierSeams } from './services/supplier-accounts.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: (SessionInfo & { viaMachineToken: boolean }) | null;
  }
  interface FastifyInstance {
    /**
     * 实时通道的中心节点。挂在实例上而不是藏在闭包里：关停路径要用它（见下面的 preClose），
     * 测试也要靠它把 1s 的推帧节奏变成确定性的 —— 否则每个用例都得等真实时钟。
     */
    liveHub: LiveHub;
  }
}

export interface ApiContext {
  db: Db;
  config: AppConfig;
  loginLimiter: LoginRateLimiter;
  /** 服务启动时刻。`uptimeSec` 用它，**不用** `Date.now() - process.uptime()` 现推（会随调用漂移） */
  startedAt: Date;
  /** 错误事件累计丢弃数（契约 §12.2 `events.dropped`）。sink 未接入时恒 0 */
  droppedEvents: () => number;
  /**
   * 内置助手的模型调用入口（契约 §13 / ADR-0015）。
   *
   * **由接线层注入**（`src/server.ts`），因为实现要用到网关侧同一个 key 池与密文出口，
   * 而那两样 `src/api` 拿不到也不该拿到（AGENTS.md §8）。缺省是 `unwiredAssistantInvoker`：
   * 它回一个说明"未接线"的失败终止帧 —— 未配置时前端看到的是**一条明确的错误**，
   * 而不是一个转不完的圈。
   */
  assistant: AssistantModelInvoker;
  /** 助手独立计量（契约 §12.2 `assistant`）。经 `/api/observability/health` 只读暴露 */
  assistantMetrics: AssistantMetricsDto;
  /**
   * 余额自动同步调度器（契约 §14 / ADR-0017）。**始终存在**（即使 `BALANCE_SYNC_MINUTES=0`）——
   * `GET /api/stats/balance/sync` 是只读观测口，不能因为"自动同步关了"就 404：
   * 关了之后历史快照仍然可读，而那正是"关掉自动同步"的人最想确认的东西。
   */
  balanceSync: BalanceSync;
  /**
   * §15.2 六个"要打上游"的端点的注入缝（HTTP 出口 / 排除名单 / 账号级节奏）。
   *
   * 默认值在 `buildApp` 里填好，所以用例拿到的 `ctx.supplier` 是**可直接用**的完整对象。
   * 之所以要有这层缝：那六个端点的验收要求里有一条"排除名单里的号永不参与任何测试"，
   * 而名单是运行时环境变量给的真实手机号。没有缝的话，验证这条纪律的唯一办法是
   * 拿真号去跑 —— 那正好是这条纪律禁止的事。
   */
  supplier: SupplierOps;
  /**
   * 出口（IP）预算闸（ADR-0021 决策 4 / §16.7）。**始终存在**，未接线时是
   * `permissiveEgressGate` —— 那个实例的所有方法都是"逐字节同现状"的空实现。
   *
   * 为什么要有这层缝：管理面有**七类出站**（§14 刷新 / 自测 / §15.2 批量 / 模型同步 /
   * 出口自检……），它们扣的是**同一张**上游配额表（上游按来源 IP 计数，连账号与 key 都不区分）。
   * 把闸藏在某一类出站的调用点里，等于"另外六类可以取配额，只是默认没人取"。
   *
   * ⚠️ **与本批一起落的是"缝"，不是"修"**：目前 `src/api` 里还没有消费者读它，
   * 真正的接线（把 `SupplierOps.fetchImpl` / 刷新那两处 fetch 包成 `fetchFor(egressId,'management')`）
   * 在批二。所以现在断言它的唯一有意义的东西是**实例身份** —— 见 `resolveEgressGate`。
   */
  egress: EgressGate;
}

/** 唯一免鉴权路径（契约 §0.5）。用 method+path 精确匹配，不用前缀。 */
function isPublic(method: string, path: string): boolean {
  return method === 'POST' && path === '/api/auth/login';
}

/**
 * 只读维护令牌的作用域（契约 §12.4 / ADR-0013）。
 *
 * 刻意用**前缀 + 方法双判**，而不是"只判方法"或"只判路径"：
 *   - 只判方法，等于观测令牌能读整个管理面（上游列表、key 列表、审计日志……）；
 *   - 只判路径，等于写方法也能进（虽然本节目前只有 GET，但那是路由的现状，不是约束）。
 * 作用域判定放在闸门里而不是各路由里 —— 这样将来往观测面加一条新路由，
 * 不可能出现"忘了判作用域"这种漏法。
 */
function inReadonlyScope(method: string, path: string): boolean {
  return method === 'GET' && path.startsWith('/api/observability/');
}

/**
 * WS 升级请求的识别（`GET /api/stats/live`）。
 *
 * 刻意不用插件装饰出来的 `req.ws`：插件在 ready 阶段才加载，它的 onRequest 钩子排在
 * 本文件的钩子**之后**，此刻 `req.ws` 还停在装饰时的默认值 null，用它判断永远为假。
 * `Upgrade` 头是原始请求上就有的，且注入式测试（injectWS）也会伪造它。
 */
function isLiveHandshake(req: FastifyRequest, path: string): boolean {
  const upgrade = req.headers.upgrade;
  return (
    req.method === 'GET' &&
    path === '/api/stats/live' &&
    typeof upgrade === 'string' &&
    upgrade.toLowerCase() === 'websocket'
  );
}

function validationField(error: { validation?: unknown }): string {
  const list = error.validation;
  if (!Array.isArray(list) || list.length === 0) return 'body';
  const first = list[0] as { instancePath?: unknown; params?: unknown };
  const params = (first.params ?? {}) as Record<string, unknown>;
  const missing = params['missingProperty'];
  if (typeof missing === 'string') return missing;
  if (typeof first.instancePath === 'string' && first.instancePath !== '') {
    return first.instancePath.replace(/^\//, '').replace(/\//g, '.');
  }
  return 'body';
}

export interface BuildAppOptions {
  db: Db;
  config: AppConfig;
  logger?: boolean;
  /**
   * 登录限速器可由调用方注入：它持有一份按 IP 的内存计数，需要**周期性 prune**
   * 才不会让大量不同来源 IP 把它撑爆。进程入口拿到同一个实例才能定期清理，
   * 否则这里创建的实例没人有机会 prune（进程不重启就一直攒）。
   */
  loginLimiter?: LoginRateLimiter;
  /**
   * 推帧节拍是否由真实定时器驱动，默认 `true`（线上行为）。
   *
   * 测试注入 `false`：拍子完全由 `tickNow()` 驱动。不这么做的后果不是"慢"，而是**错**——
   * 一条用例只要整体跑了 1s 以上，真实的 1s 定时器就会插进额外的拍，
   * 于是"收到第 n 帧 metrics = 前 n-1 拍已全部过线"的屏障推理静默失效，
   * 断言退化成"赌这个用例跑得比定时器快"。
   */
  liveAutoTick?: boolean;
  /**
   * 服务启动时刻（契约 §12.2 `uptimeSec` / `startedAt`）。缺省取本函数被调用的那一刻。
   *
   * 由调用方显式注入是为了**快照序列的一致性**：`uptimeSec` 会写进每一条 60s 快照，
   * 如果管理面路由和快照写入器各自 `new Date()`，同一份 uptime 曲线会在两个时刻起算，
   * 差几毫秒 —— 平时看不出来，重启后比对两条序列时会像"有段时间对不上"。
   */
  startedAt?: Date;
  /**
   * 错误事件累计丢弃数（契约 §12.2 `events.dropped`）。
   *
   * sink 由 `src/wiring/` 建（它要拿到 key 的掩码）并注入到这里；未接入时缺省恒 0 ——
   * 那是**事实**（这个进程确实一条都没丢），不是占位假数据。
   */
  droppedEvents?: () => number;
  /**
   * 内置助手的模型调用入口（契约 §13）。缺省 `unwiredAssistantInvoker` —— 见 `ApiContext.assistant`。
   *
   * 管理面**不检查它是否已接线**：检查出来的唯一动作是"别让这条路由生效"，而把路由摘掉
   * 会让前端拿到 404（看起来像版本不对）。回一个 503 终止帧的语义精确得多。
   */
  assistant?: AssistantModelInvoker;
  /** 助手独立计量出口（与 invoker 共用一个对象）；缺省全 0 */
  assistantMetrics?: AssistantMetricsDto;
  /**
   * 是否启动 60s 健康快照写入器（契约 §12.2 / ADR-0013 §5）。默认 `true`（线上行为）。
   *
   * 测试可注入 `false`：快照是**历史序列**，"建 app 时先写一条"会让每个用例的库里
   * 天然多一行，断言就变成"算上那一行正好如何"。要测快照行为应当直接驱动
   * `createHealthSnapshotWriter(...).writeOnce()`，而不是靠这条隐式副作用。
   */
  healthSnapshots?: boolean;
  /** 快照节拍，仅测试用（默认 60s） */
  healthSnapshotIntervalMs?: number;
  /** 快照统计窗口，仅测试用（默认 300s） */
  healthSnapshotWindowSeconds?: number;
  /**
   * 是否**启动**余额自动同步调度器（契约 §14 / ADR-0017）。默认 `true`（线上行为）。
   *
   * 与 `healthSnapshots` 有意不同的一点：调度器**总是**被创建（路由要它），
   * 这个开关只决定要不要 `start()` 注册定时器。测试关掉它就能用 `tick()` 手动驱动，
   * 不必和应用的真实时钟赛跑。
   *
   * 它**不影响** `auto.enabled` 的回显：那个字段答的是"配置里自动同步开着吗"，
   * 拿一个测试开关去篡改它，会让唯一一条能验证"`0` = 关"的路径失效。
   */
  balanceSync?: boolean;
  /** 排程拍节，仅测试用（默认 15s） */
  balanceSyncTickMs?: number;
  /** 快照裁剪拍节，仅测试用（默认 1h） */
  balanceSyncPruneIntervalMs?: number;
  /**
   * §15.2 管理面端点的注入缝（见 `ApiContext.supplier`）。缺省：全局 `fetch`、
   * 运行时环境里的排除名单、§15.5 的 0.6s 节奏。
   *
   * 测试注入假 `fetchImpl` ⇒ 六个端点的全部用例**零网络**；注入 `pacing: {gapMs: 0}`
   * ⇒ 不必真的等 0.6s × N。
   */
  supplier?: SupplierSeams;
  /**
   * 出口（IP）预算闸（ADR-0021）。缺省 `permissiveEgressGate` —— 语义上等价于"没有闸"，
   * 与改动前逐字节同行为，所以线上漏注入不会静默改变现有流量。
   *
   * **本批刻意保持可选**：ADR-0020 决策 5 反转那一段要求"管理面出站改必填注入"，
   * 但必填化必须与**所有注入点同一笔**落（否则中间态就是"有的出站走闸、有的不走"，
   * 而那正是这条缝要防的事）。批二接线时连同 `src/server.ts` 的造一次注入两处一起收。
   */
  egress?: EgressGate;
}

/**
 * 缺省闸的**唯一**填充点（`ApiContext.egress` 与 `BuildAppOptions.egress` 之间那一跳）。
 *
 * 单独写成函数、并导出：`permissiveEgressGate` 的正确性靠的是"注入的**就是端口里那个实例**"，
 * 而不是"形状对得上"。任何形如 `?? { ...permissiveEgressGate }` 的写法都会造出第二个缺省闸 ——
 * 那一份和端口里那份会各自被将来的实现替换掉，于是"未接线"有了两种行为。
 * 导出只为让这条身份断言可测（`app.spec.ts`）。
 */
export function resolveEgressGate(opt: EgressGate | undefined): EgressGate {
  return opt ?? permissiveEgressGate;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const { db, config } = opts;
  const app = Fastify({
    logger: opts.logger ?? false,
    // 管理面只收小 JSON；给个上限免得一个超长 body 把单线程事件循环卡住
    bodyLimit: 1 * 1024 * 1024,
    trustProxy: config.trustProxy,
  });

  const startedAt = opts.startedAt ?? new Date();
  const droppedEvents = opts.droppedEvents ?? (() => 0);

  // 余额自动同步调度器（契约 §14 / ADR-0017）。**先建对象、后起步**：
  // 路由与刷新收尾钩子都要拿到同一个实例，而"要不要注册定时器"是启动那一步的事。
  const balanceSync = createBalanceSync({
    db,
    masterKey: config.masterKey,
    intervalMinutes: config.balanceSyncMinutes,
    retentionDays: config.balanceSnapshotRetentionDays,
    log: app.log,
    tickMs: opts.balanceSyncTickMs,
    pruneIntervalMs: opts.balanceSyncPruneIntervalMs,
  });

  const ctx: ApiContext = {
    db,
    config,
    loginLimiter: opts.loginLimiter ?? new LoginRateLimiter(),
    startedAt,
    droppedEvents,
    assistant: opts.assistant ?? unwiredAssistantInvoker,
    assistantMetrics: opts.assistantMetrics ?? NO_ASSISTANT_METRICS,
    balanceSync,
    // 六个管理面端点的缝。这里**只填默认值**，业务代码拿到的永远是填好的对象 ——
    // 于是"排除名单没接上"这种事只可能发生在这一个表达式里，不可能发生在某个 handler 里。
    // `fetch` 是**延迟**取全局的：写成模块级常量会在 import 那一刻绑死，测试就换不掉了。
    supplier: supplierOps(db, config.masterKey, opts.supplier ?? {}),
    // 同一条纪律：默认值只在这一处填，业务代码拿到的永远是填好的闸。
    egress: resolveEgressGate(opts.egress),
  };

  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    const path = req.url.split('?')[0] ?? req.url;

    // 非 /api/* 的路径（例如将来挂静态资源）不在这里判，交给各自的处理器
    if (!path.startsWith('/api/')) return;

    // CSRF 在鉴权**之前**：login 也同样受保护（登录 CSRF 是一种真实的攻击面，
    // 诱使受害者的浏览器用攻击者的账号登入，之后受害者的操作全落在对方账号里）。
    // 契约里对 CSRF 的要求是"所有写请求"，从未把 login 排除在外。
    if (isWriteMethod(req.method)) verifyCsrf(req, config.allowedOrigins);

    // 实时通道的 WS 握手是**唯一**的例外 —— 而它不是"免鉴权"。
    // 升级请求一旦回 HTTP 401，浏览器只会把连接报成异常中断（1006），
    // 前端就无法把「会话过期，去登录」（4401）与「服务崩了，退避重连」分开，
    // 而这两件事的用户动作完全相反。所以会话判定被**推迟到升级成功之后**：
    // handler 拿到连接、判来源、判会话，不通过就用 4401 关掉（见 routes/live.ts）。
    // 例外条件收得极窄：方法 + 路径 + Upgrade 头三者同时满足。非升级的普通 GET
    // 落到同一个路径上会走插件给的 404，同样不经过这里。
    if (isLiveHandshake(req, path)) return;

    if (isPublic(req.method, path)) return;

    // 机器令牌：只认 Bearer，不参与浏览器流程。两把令牌互不隶属：
    //   - ADMIN_TOKEN：管理面全权（CI 用）；
    //   - READONLY_TOKEN：**只有** `GET /api/observability/*`，落在别处 403（契约 §12.4）。
    // 任何一个未配置即为关闭；两个都关时，带 Bearer 头的请求照旧落到会话鉴权上
    // （保持 v1.0 的既有行为，不让"多了一个可选配置"改变老部署的语义）。
    const authz = req.headers.authorization;
    if ((config.adminToken !== null || config.readonlyToken !== null) && typeof authz === 'string' && authz.startsWith('Bearer ')) {
      const presented = authz.slice('Bearer '.length).trim();
      if (presented !== '' && config.adminToken !== null && presented === config.adminToken) {
        req.auth = { username: 'ci', expiresAt: new Date(Date.now() + 60_000).toISOString(), viaMachineToken: true };
        return;
      }
      if (presented !== '' && config.readonlyToken !== null && presented === config.readonlyToken) {
        // 令牌有效但越界：是 403 不是 401 —— 客户端换一个令牌就能解决，
        // 而 401 会让它以为"这把令牌已经失效"，进而去重新申请一把（拿到的还是同一把）。
        if (!inReadonlyScope(req.method, path)) {
          throw new ApiError('FORBIDDEN', '只读维护令牌仅可用于 GET /api/observability/*');
        }
        req.auth = {
          username: 'readonly',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          viaMachineToken: true,
        };
        return;
      }
      throw new ApiError('UNAUTHORIZED', '令牌无效');
    }

    req.auth = { ...requireSession(db, sessionCookieValue(req), config.sessionTtlHours), viaMachineToken: false };
  });

  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ApiError) {
      void reply.code(error.status).send(error.toBody());
      return;
    }

    // Fastify 的错误类型在这里是 unknown（不是每个抛出物都是 Error）。
    // 先收窄成"可能带 statusCode/validation 的东西"，再决定回什么。
    const thrown = error as { statusCode?: unknown; validation?: unknown };
    const status = typeof thrown.statusCode === 'number' ? thrown.statusCode : 500;
    if (status === 400 && thrown.validation !== undefined) {
      const field = validationField({ validation: thrown.validation });
      const body = new ApiError('INVALID_PARAM', `参数 ${field} 不合法`, { field }).toBody();
      void reply.code(400).send(body);
      return;
    }

    // 未预期的异常：日志里留全量，响应里只给通用信息。
    // 把 driver 的原始报错回给客户端，等于免费送一份内部结构说明。
    req.log.error({ err: error }, '未处理的请求异常');
    void reply.code(500).send({ code: 'INTERNAL', message: '服务端异常，请稍后重试' });
  });

  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ code: 'NOT_FOUND', message: `接口不存在: ${req.method} ${req.url}` });
  });

  // 实时通道。三处顺序/取舍值得记下来：
  //   1. `preClose` 由我们提供，覆盖插件的默认实现。默认那版用 **1000** 关掉所有连接，
  //      而契约 §7 里 1000 的语义是"登出 → 前端不重连"：一次部署重启会把所有仪表盘
  //      永久留在断开态，直到有人手动刷新。换成 1012（服务重启 → 退避重连）才对。
  //   2. WS 路由必须写在 `register` 回调里（见下面那段）。这不是风格问题 ——
  //      直接 `registerLiveRoutes(app, ...)` 会让这条路由**静默地变成一个普通 GET**。
  //   3. 其余路由不这么写，因为它们的注册只依赖已经就绪的钩子，与加载次序无关。
  const liveHub = createLiveHub(db, app.log, { autoTick: opts.liveAutoTick ?? true });
  app.decorate('liveHub', liveHub);
  app.register(fastifyWebsocket, {
    preClose: (done) => {
      liveHub.shutdown();
      done();
    },
  });

  registerAuthRoutes(app, ctx);
  registerUpstreamRoutes(app, ctx);
  registerKeyRoutes(app, ctx);
  registerGroupRoutes(app, ctx);
  registerModelRoutes(app, ctx);
  registerStatsRoutes(app, ctx);
  registerSupplierAccountRoutes(app, ctx);
  registerMiscRoutes(app, ctx);
  registerObservabilityRoutes(app, ctx);
  registerAssistantRoutes(app, ctx);

  // 形状必须是这样：`register` 的回调被 avvio 排队，等前面排的 WS 插件**加载完**才执行；
  // 插件的 onRoute 钩子是在那一刻才装上的，早于它的路由它一个都看不见。
  // 代价是写得别扭，收益是这条路由真的会被改写成 `websocket:true`：
  // 少了它，升级请求会落在一个"普通 GET"上（handler 收到的是 request/reply，
  // 不是 socket），表现是整个握手挂住、客户端一直等到超时。
  app.register(async (instance) => {
    registerLiveRoutes(instance, ctx, liveHub);
  });

  // 60s 健康快照（契约 §12.2 / ADR-0013 §5）。生命周期挂在 app 上而不是 server.ts 的
  // 维护定时器数组里：冻结的关停顺序（src/wiring/shutdown.ts）保证 `app.close()` 早于
  // `db.close()`，于是这里 stop() 掉就不会写到一个已经关掉的连接上 —— 顺序表一行都不用改。
  //
  // 为什么由**管理进程**持有这个定时器：`/v1/*` 是热路径，单写者模型下它连一次同步写
  // 都不该有；快照是"后台周期性任务"，不该和请求抢写锁，而这边 60s 一次的写完全落在噪声里。
  if (opts.healthSnapshots ?? true) {
    const writer = createHealthSnapshotWriter({
      db,
      startedAt,
      droppedEvents,
      retentionDays: config.healthSnapshotRetentionDays,
      onError: (err) => app.log.error({ err }, '健康快照写入失败'),
      intervalMs: opts.healthSnapshotIntervalMs,
      windowSeconds: opts.healthSnapshotWindowSeconds,
    });
    app.addHook('onClose', async () => {
      writer.stop();
    });
    writer.start();
  }

  // 余额自动同步（契约 §14 / ADR-0017）。生命周期与上面那位同款，理由也同款：
  // 冻结的关停顺序保证 `app.close()` 早于 `db.close()`，于是这里停表就不会写到一个
  // 已经关掉的连接上。两条定时器（排程 / 裁剪）都 `unref()`，不会吊住进程退出。
  if (opts.balanceSync ?? true) {
    app.addHook('onClose', async () => {
      balanceSync.stop();
    });
    balanceSync.start();
  }

  return app;
}
