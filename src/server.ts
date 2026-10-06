// 进程入口：读配置 → 开库 → 建管理员 → 起**两个**监听（网关面 / 管理面）→ 挂维护定时器。
//
// 启动顺序是有讲究的，不能调换：
//   1. loadConfig 先跑。MASTER_KEY 缺失或长度不对会在这一步抛错，进程直接起不来 ——
//      这是有意的（契约要求），绝不允许"降级成不加密"把服务拉起来。
//   2. openDatabase 建表/迁移，再 bootstrapAdmin 造首个管理员。
//   3. 建网关 runtime（这一步会同步建快照并解密 key），最后才 listen。
//      反过来的话，存在一个窗口期：端口已对外，key 池还是空的 —— 那个窗口里进来的请求
//      会拿到 503 NO_AVAILABLE_KEY，看起来像"池子坏了"。
//
// 两个监听、一份库：
//   - 网关面（config.hostGateway:portGateway）跑 `/v1/*`，对外；
//   - 管理面（config.hostAdmin:portAdmin）跑 `/api/*` + 前端，默认只回环。
//   两个 Fastify 实例共用一个 `Db` 句柄：本项目是单写者模型，一个句柄才谈得上单写者。
//
// 维护定时器（清过期会话 / 裁日志 / 清限速表）在**同一个进程**里跑：
// 再起一个 cron 进程去写库，就同时有两个写者了。

import { buildApp } from './api/app.js';
import { LoginRateLimiter, bootstrapAdmin, purgeExpiredSessions } from './api/auth.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { pruneLogs } from './db/repo/logs.js';
import { createGatewayRuntime, createShutdownHandler, mountGatewayRoutes } from './wiring/index.js';

const HOUR_MS = 3_600_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase({ path: config.dbPath });

  // 首次启动没有管理员且没给 ADMIN_PASSWORD 时会在这里抛错并退出（fail-fast）
  bootstrapAdmin(db, process.env);

  const loginLimiter = new LoginRateLimiter();
  const app = buildApp({ db, config, logger: true, loginLimiter });

  // 网关 runtime 自带内存快照 + 明文缓存；`stop()` 负责最后一次用量落库、最后一次
  // key 运行态镜像（ADR-0010）与清明文 —— 都在 db.close() 之前，否则 flush 会写到已关的连接上
  const gateway = createGatewayRuntime({ db, config, logger: true });
  await mountGatewayRoutes(gateway);
  gateway.start();

  // 维护任务一律 try/catch 吞掉异常：清垃圾失败不该把整台服务带走，
  // 下一次 tick 还会再来一遍。
  const timers: NodeJS.Timeout[] = [
    setInterval(() => {
      try {
        const n = purgeExpiredSessions(db);
        if (n > 0) app.log.info({ removed: n }, '清理过期会话');
      } catch (err) {
        app.log.error({ err }, '清理过期会话失败');
      }
    }, HOUR_MS),
    setInterval(() => {
      try {
        const n = pruneLogs(db, config.logRetentionDays);
        if (n > 0) app.log.info({ removed: n, retentionDays: config.logRetentionDays }, '裁剪历史日志');
      } catch (err) {
        app.log.error({ err }, '裁剪历史日志失败');
      }
    }, 6 * HOUR_MS),
    setInterval(() => {
      try {
        loginLimiter.prune();
      } catch (err) {
        app.log.error({ err }, '清理登录限速表失败');
      }
    }, 5 * 60_000),
  ];

  // 关停顺序（谁先谁后、为什么 db.close() 必须在最后）收在 src/wiring/shutdown.ts，
  // 那里同时是被判据钉住的地方；这里只负责"信号 → 编排"这一段接线。
  const shutdown = createShutdownHandler({
    gateway,
    app,
    db,
    timers,
    log: app.log,
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const onListenError = (err: unknown): void => {
    app.log.error({ err }, '监听失败');
    db.close();
    process.exit(1);
  };

  // 两个监听都起来才算启动完成：先起网关面（客户端在等），再起管理面
  gateway.app
    .listen({ host: config.hostGateway, port: config.portGateway })
    .then((address) => gateway.app.log.info({ address }, '网关面已启动 (/v1/*)'))
    .then(() =>
      app.listen({ host: config.hostAdmin, port: config.portAdmin }).then(
        (address) => app.log.info({ address, dbPath: config.dbPath }, '管理面已启动'),
        onListenError,
      ),
    )
    .catch(onListenError);
}

void main();
