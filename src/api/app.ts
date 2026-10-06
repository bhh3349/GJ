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
import { LoginRateLimiter, requireSession, type SessionInfo } from './auth.js';
import { ApiError } from './errors.js';
import { createHealthSnapshotWriter } from './health-snapshot-writer.js';
import { isWriteMethod, sessionCookieValue, verifyCsrf } from './http.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGroupRoutes } from './routes/groups.js';
import { registerKeyRoutes } from './routes/keys.js';
import { createLiveHub, registerLiveRoutes, type LiveHub } from './routes/live.js';
import { registerMiscRoutes } from './routes/misc.js';
import { registerModelRoutes } from './routes/models.js';
import { registerObservabilityRoutes } from './routes/observability.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerUpstreamRoutes } from './routes/upstreams.js';

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

  const ctx: ApiContext = {
    db,
    config,
    loginLimiter: opts.loginLimiter ?? new LoginRateLimiter(),
    startedAt,
    droppedEvents,
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
  registerMiscRoutes(app, ctx);
  registerObservabilityRoutes(app, ctx);

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

  return app;
}
