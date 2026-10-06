// 网关进程装配 - 把四个适配器接到 `src/gateway` 的端口上，并拉出独立的 Fastify 实例。
//
// 边界依据：AGENTS.md §8。本文件是**唯一**同时 import `src/gateway` 与 `src/db` 的地方 ——
// 内核只认 ports.ts，库只认 SQL；接线是接线，别让任何一端的知识漏到另一端。
//
// 这个 runtime 是 `/v1/*` 的宿主，与管理面（`src/api` 的 buildApp）**分开两个监听**：
//   - 网关面 `HOST_GATEWAY:PORT_GATEWAY`（默认 0.0.0.0:4000），对外开放、只跑 OpenAI 兼容接口；
//   - 管理面仍然只监听回环（config.hostAdmin）。
//   合并成一个实例的诱惑在于"少一个端口"，代价是管理端点的可达面跟着网关一起放开，
//   以及把两种错误体（OpenAI 形状 vs `{code,message}`）挤进同一个 errorHandler。分开。
//
// `trustProxy: false` 是刻意的，别改成 config.trustProxy：
//   `/internal/snapshot` 的准入判据是 `isLoopback(request.ip)`。一旦信任 `X-Forwarded-For`，
//   任何人加一个 `X-Forwarded-For: 127.0.0.1` 就能读到 key 池快照（含每个上游的实时余量）。
//   网关面本来就该部署在反代之后、由反代决定要不要转发，而不是自己相信客户端说的 IP。
//
// 快照刷新走 1s 轮询兜底（契约 §9）：共享 SQLite 的 change_log 有增量才重建，重建了才
// `applySnapshot` —— 后者会把 token-plan key 的乐观扣减清零，不能拿它当"定时心跳"用。
//
// 明文纪律：明文只活在 `store.secrets` 的内存缓存里，`stop()` 里 clear 掉；
// 本文件不 log 它，也不把它放进任何返回值。

import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/database.js';
import { gatewayRoutes } from '../gateway/routes.js';
import type { FetchLike } from '../gateway/engine.js';
import { createGatewayStack } from '../gateway/stack.js';
import type { GatewayStack } from '../gateway/stack.js';
import { createDbGatewayAuth } from './auth.js';
import { createErrorEventSink } from './error-event-sink.js';
import type { BufferedErrorEventSink } from './error-event-sink.js';
import { createKeyRuntimeFlusher } from './key-runtime-flusher.js';
import type { KeyRuntimeFlusher } from './key-runtime-flusher.js';
import { createGatewayStore } from './store.js';
import type { GatewayStore } from './store.js';
import { createUsageLogSink } from './usage-sink.js';
import type { UsageSink } from './usage-sink.js';

/** 快照轮询间隔（契约 §9 冻结：1s 兜底） */
const SNAPSHOT_POLL_MS = 1000;

/**
 * 网关面 body 上限。比管理面（1MB）松：一次 chat 请求带几十 K 的历史很常见，
 * 但也不能不设 —— 单线程事件循环上一个超长 body 就是一次全局卡顿。
 */
const GATEWAY_BODY_LIMIT_BYTES = 8 * 1024 * 1024;

export interface GatewayRuntimeOptions {
  db: Db;
  config: AppConfig;
  logger?: boolean;
  /** 测试用桩：替换出站 fetch */
  fetchImpl?: FetchLike;
}

export interface GatewayRuntime {
  app: FastifyInstance;
  stack: GatewayStack;
  store: GatewayStore;
  sink: UsageSink;
  /**
   * 错误事件出口（契约 §12.1 / ADR-0013）。`dropped()` 要经 `buildApp` 的 `droppedEvents`
   * 接进 `/api/observability/health`，所以这里必须把实例**暴露出来**而不是藏在闭包里。
   */
  errors: BufferedErrorEventSink;
  /**
   * `key_runtime` 运行态镜像（ADR-0010）。管理端的 `?health=` 与健康灯读的就是它写的表 ——
   * 没有它，契约 §3 的四个字段恒为 healthy/0，看板上是假数据。
   */
  mirror: KeyRuntimeFlusher;
  /** 启动 1s 快照轮询（幂等） */
  start(): void;
  /** 停轮询 + 最后一次用量落库 + 丢弃明文。不关 app（由调用方 `app.close()`） */
  stop(): Promise<void>;
  /** 立即拉一次快照（测试/`/internal/snapshot` 前的自检用），返回是否重建 */
  refreshNow(): boolean;
}

export function createGatewayRuntime(options: GatewayRuntimeOptions): GatewayRuntime {
  const { db, config } = options;

  // 先建实例：下面 sink.onError / pool.onAlert 都要往它的日志里写
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: GATEWAY_BODY_LIMIT_BYTES,
    // 见文件头：信任 XFF 会让 /internal/snapshot 的回环判据可被伪造
    trustProxy: false,
  });

  const store = createGatewayStore({ db, masterKey: config.masterKey });

  // 首次同步建快照：必须在 pool.applySnapshot 之前，否则第一秒内池子是空的，
  // 这段时间进来的请求会全数 503（启动窗口的"假故障"）
  store.refresh();

  const sink = createUsageLogSink({
    db,
    maskOf: (keyId) => store.maskOf(keyId),
    costCentsOf: (upstreamModel, promptTokens, completionTokens) =>
      store.costCentsOf(upstreamModel, promptTokens, completionTokens),
    onError: (err, dropped) => {
      // 只报条数与错误对象：这批记录的内容里有客户端模型名与用量，不该进日志
      app.log.error({ err, dropped }, '用量日志落库失败');
    },
  });

  // 错误事件出口（契约 §12.1）。掩码同样由 store 反查 —— 网关侧**拿不到掩码**，
  // 也就无从把明文传进来（"不许传明文"从约定变成了类型上就传不进来）。
  const errors = createErrorEventSink({
    db,
    maskOf: (keyId) => store.maskOf(keyId),
    onError: (err, dropped) => {
      app.log.error({ err, dropped }, '错误事件落库失败');
    },
    onOverflow: (dropped) => {
      // 丢事件不许静默（契约 §12.1）：一个会悄悄丢观测数据的观测系统比没有更误导。
      // 累计值由 `dropped()` 经 /api/observability/health 的 `events.dropped` 暴露；
      // 这条日志给的是"什么时候开始丢的"，两者都要有。
      app.log.warn({ dropped }, '错误事件队列溢出，已丢弃最旧的一批');
    },
  });

  const stack = createGatewayStack({
    secrets: store.secrets,
    models: store.catalog,
    auth: createDbGatewayAuth(db),
    logs: sink,
    errors,
    maxAttempts: config.maxAttempts,
    poolOptions: {
      defaultMaxConcurrency: config.maxConcurrencyPerKey,
      // 阶梯的单位在配置层是秒（与 env 同口径），内核一律用 ms
      cooldownLadderMs: config.cooldownLadderSeconds.map((s) => s * 1000),
    },
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  stack.pool.applySnapshot(store.poolSnapshot());
  stack.pool.onAlert = (event) => {
    app.log.warn({ alert: event }, 'KeyPool 告警');
  };

  // 运行态镜像：必须在 applySnapshot 之后建（否则第一个周期看到的池子是空的，
  // 会把"上一进程的陈旧行"当成现状原样留在表里）。ADR-0010。
  const mirror = createKeyRuntimeFlusher({
    db,
    pool: stack.pool,
    onError: (err) => {
      // 镜像不是账，丢一拍可以，但必须留痕：管理端健康灯停更只有日志能解释
      app.log.error({ err }, 'key_runtime 镜像刷写失败');
    },
  });

  let pollTimer: NodeJS.Timeout | null = null;

  function refreshNow(): boolean {
    const rebuilt = store.refresh();
    if (rebuilt) stack.pool.applySnapshot(store.poolSnapshot());
    return rebuilt;
  }

  function stop(): Promise<void> {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    // 顺序有意义：
    //   1. 先落用量（队列里最后一批是真实流量，丢了就是对账缺口）；
    //   2. 再落错误事件（同样是"在飞的那一批"，而且它的保留期比用量长，丢了不可回填）；
    //   3. 再把最后一版运行态镜像写进 key_runtime（否则管理端停在上一拍，健康灯看着像卡住）；
    //   4. 最后丢明文 —— 前三步都还在用池/库，明文缓存得活到最后。
    // 四步都是同步 SQLite 写，必须全部排在 `shutdown.ts` 的 `db.close()` 之前（已冻结）。
    sink.close();
    errors.close();
    mirror.close();
    store.secrets.clear();
    return Promise.resolve();
  }

  return {
    app,
    stack,
    store,
    sink,
    errors,
    mirror,

    start(): void {
      if (pollTimer !== null) return;
      pollTimer = setInterval(() => {
        try {
          refreshNow();
        } catch (err) {
          // 刷新失败不清空旧快照：拿旧配置继续服务，比"配置读不出来就全站 503"好
          app.log.error({ err }, '网关快照刷新失败，沿用上一版快照');
        }
      }, SNAPSHOT_POLL_MS);
      // 别吊住进程退出：退出前由 server.ts 显式 stop()
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
    },

    refreshNow,
    stop,
  };
}

/** 注册 `/v1/*` 与 `/internal/snapshot`。必须 await（路由插件是异步加载的）。 */
export async function mountGatewayRoutes(runtime: GatewayRuntime, bodyLimitBytes?: number): Promise<void> {
  await runtime.app.register(
    gatewayRoutes,
    bodyLimitBytes === undefined ? runtime.stack.routes : { ...runtime.stack.routes, bodyLimitBytes },
  );
}
