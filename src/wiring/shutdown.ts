// 停机编排：收到退出信号之后做什么、按什么顺序做。
//
// 为什么把它从 `src/server.ts` 里抽出来单独一个模块：**顺序本身要有确定性判据**（待办 6）。
// 挂在 `process.on('SIGTERM')` 上的那段匿名闭包在单测里够不着，而 Windows 上又验不了
// 真信号（Node 在 win32 没有 POSIX 信号语义，`process.kill(pid,'SIGTERM')` 直接终结进程，
// 处理器根本不跑）。抽出编排 → 顺序可以在任何平台上用真 runtime + 真库钉死；
// `src/server.ts` 只留"信号 → 编排"这一段接线，再由 Linux CI 上的真进程用例补信号那半截。
//
// 冻结顺序（契约口径，与 `src/wiring/runtime.ts` 的 `stop()` 及 ADR-0010 同源）：
//   1. 清维护定时器 —— 再 tick 一次就是在关库之后写库；
//   2. `gateway.stop()`：内部依次 `sink.close()` → `mirror.close()` → `secrets.clear()`；
//   3. 两个监听一起关（网关面 + 管理面）；
//   4. **最后**才 `db.close()`。
//
// 第 4 步必须在最后，不是风格问题：`sink.close()` 与 `mirror.close()` 各自都是一次 SQLite 写，
// 库先关的话那次收尾 flush 会写到一个已关闭的连接上 —— 它会失败、被 `onError` 记成
// 「用量日志落库失败」，而进程照样以 0 退出。也就是说**顺序错了也不会有人发现**，
// 所以这条必须有判据（`src/wiring/shutdown.spec.ts`），不能只写在注释里。

export interface AsyncClosable {
  close(): Promise<void>;
}

export interface SyncClosable {
  close(): void;
}

export interface ShutdownLog {
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ShutdownTarget {
  /** 网关 runtime：`stop()` 内部做 sink.close() → mirror.close() → secrets.clear() */
  gateway: { stop(): Promise<void>; app: AsyncClosable };
  /** 管理面 Fastify 实例 */
  app: AsyncClosable;
  /** 共享 SQLite 句柄：**全局最后一个**被关的东西 */
  db: SyncClosable;
  /** 维护定时器（清过期会话 / 裁日志 / 清限速表） */
  timers: readonly NodeJS.Timeout[];
  log: ShutdownLog;
  /** 注入点：生产传 `(code) => process.exit(code)`；测试传记录桩，好断言退出码 */
  exit(code: number): void;
}

/**
 * 造一个"收到信号就关停"的处理器。返回的函数幂等：
 * 连按两次 Ctrl-C（或 SIGINT 后又来一个 SIGTERM）不该把关停流程跑两遍 ——
 * 第二遍会在已经关掉的连接/监听上再走一次，日志里就会多出一条假的「关闭失败」。
 */
export function createShutdownHandler(target: ShutdownTarget): (signal: string) => void {
  let closing = false;

  return (signal: string): void => {
    if (closing) return;
    closing = true;

    target.log.info({ signal }, '收到退出信号，正在关闭');
    for (const t of target.timers) clearInterval(t);

    void target.gateway
      .stop()
      .then(() => Promise.all([target.app.close(), target.gateway.app.close()]))
      .then(
        () => {
          target.db.close();
          target.exit(0);
        },
        (err: unknown) => {
          target.log.error({ err }, '关闭失败');
          target.exit(1);
        },
      );
  };
}
