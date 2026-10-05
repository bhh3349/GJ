// 进程入口：读配置 → 开库 → 建管理员 → 起管理面 HTTP 服务 → 挂维护定时器。
//
// 启动顺序是有讲究的，不能调换：
//   1. loadConfig 先跑。MASTER_KEY 缺失或长度不对会在这一步抛错，进程直接起不来 ——
//      这是有意的（契约要求），绝不允许"降级成不加密"把服务拉起来。
//   2. openDatabase 建表/迁移，再 bootstrapAdmin 造首个管理员。
//   3. 最后才 listen。反过来的话，存在一个窗口期：端口已对外，鉴权数据还没准备好。
//
// 维护定时器（清过期会话 / 裁日志 / 清限速表）在**同一个进程**里跑：
// 本项目是单写者模型（同一份 SQLite 文件被网关与管理面共享），
// 再起一个 cron 进程去写库，就同时有两个写者了。

import { buildApp } from './api/app.js';
import { LoginRateLimiter, bootstrapAdmin, purgeExpiredSessions } from './api/auth.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { pruneLogs } from './db/repo/logs.js';

const HOUR_MS = 3_600_000;

function main(): void {
  const config = loadConfig();
  const db = openDatabase({ path: config.dbPath });

  // 首次启动没有管理员且没给 ADMIN_PASSWORD 时会在这里抛错并退出（fail-fast）
  bootstrapAdmin(db, process.env);

  const loginLimiter = new LoginRateLimiter();
  const app = buildApp({ db, config, logger: true, loginLimiter });

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

  const shutdown = (signal: string): void => {
    app.log.info({ signal }, '收到退出信号，正在关闭');
    for (const t of timers) clearInterval(t);
    void app.close().then(
      () => {
        db.close();
        process.exit(0);
      },
      (err: unknown) => {
        app.log.error({ err }, '关闭失败');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  app.listen({ host: config.hostAdmin, port: config.portAdmin }).then(
    (address) => app.log.info({ address, dbPath: config.dbPath }, '管理面已启动'),
    (err: unknown) => {
      app.log.error({ err }, '监听失败');
      db.close();
      process.exit(1);
    },
  );
}

main();
