// 进程级停机验证（待办 6 里"必须真信号"的那一半）。
//
// 为什么这条只能在 Linux 上给证据：Node 在 win32 上**没有 POSIX 信号语义** ——
// `process.kill(pid,'SIGTERM')` 走的是 TerminateProcess，进程当场死掉，
// `process.on('SIGTERM')` 的处理器根本不会跑。也就是说在 Windows 上，
// "优雅停机"这条链无论写对写错都测不出来。所以：
//   - 启动用例全平台跑（保证这套子进程脚手架在本机也能验，不是只在 CI 上才第一次运行）；
//   - SIGTERM 用例 `skipIf(!POSIX)`，在 win32 里显示为 **skipped**，而不是静默通过。
//
// 判据怎么做到跨进程可观测（不往生产代码里塞测试钩子）：
//   1. `exit code === 0 且 signal === null` —— 被默认动作杀掉是 `code null / signal SIGTERM`，
//      两者区分得开；
//   2. 子进程日志里不得出现「用量日志落库失败 / key_runtime 镜像刷写失败 / 关闭失败」；
//   3. **`-wal` 边车文件消失** —— SQLite 只在最后一个连接干净 close 时删掉它。
//      被硬杀（默认动作）会把它留下，所以它正好是"`db.close()` 真跑完了"的跨进程判据。
//
// 这条用例**不**断言"收尾 flush 写得进库"：那要求子进程里正好有一批待落库数据，
// 而这个进程没跑过任何 /v1 请求。顺序本身由 `src/wiring/shutdown.spec.ts` 用真 runtime
// 把每一步的调用次序钉死，两边合起来才是完整证据。

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';

/** Windows 上没有 POSIX 信号语义，见文件头 */
const POSIX = process.platform !== 'win32';

// CI 上哪怕跑在 Windows runner 上，这条也会以 skipped 的样子"通过" —— 门禁变成装饰。
// 所以宁可当场把话说死：CI 必须给 POSIX runner。
if (process.env['CI'] !== undefined && !POSIX) {
  throw new Error('CI 跑在非 POSIX 平台上：SIGTERM 停机判据会被静默跳过，请把 runner 换成 Linux');
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// 子进程入口。默认走源码（tsx）——本地 `pnpm test` 不该被一份陈旧的 `dist/` 喂成假绿。
// CI 的停机门禁步骤设 `GATEWAY_ENTRY=dist`，把它指到同一 job 里刚 emit 的产物上：
// 那条路径打的是真正要发布的东西，tsc emit 阶段的 ESM 解析/依赖图问题只有跑 dist 才暴露。
const ENTRY_ARGV =
  process.env['GATEWAY_ENTRY'] === 'dist'
    ? [join(ROOT, 'dist', 'server.js')]
    : ['--import', 'tsx', join(ROOT, 'src', 'server.ts')];

const STARTUP_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 30_000;

interface ServerProcess {
  proc: ChildProcess;
  dbPath: string;
  output(): string;
  /** 已退出则返回结果，否则 null */
  result(): { code: number | null; signal: NodeJS.Signals | null } | null;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const proc of children.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发仍被短暂占用 */
    }
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 起一个真进程。入口见 `ENTRY_ARGV`：源码（`src/server.ts`，同 CI 里 `pnpm dev` 走的那条
 * tsx 路径）或 emit 产物（`dist/server.js`），由 `GATEWAY_ENTRY` 切换，两条都验同一套判据。
 * 端口用 0 让内核挑空闲端口：CI 上固定端口撞车是那种"重跑一次就绿"的假失败。
 */
function startServer(): ServerProcess {
  const dir = mkdtempSync(join(tmpdir(), 'server-sigterm-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');

  const env: Record<string, string | undefined> = {
    ...process.env,
    MASTER_KEY: 'a7'.repeat(32),
    DB_PATH: dbPath,
    ADMIN_PASSWORD: 'shutdown-probe-password',
    PORT_GATEWAY: '0',
    PORT_ADMIN: '0',
    HOST_GATEWAY: '127.0.0.1',
    HOST_ADMIN: '127.0.0.1',
  };
  // 父进程（vitest）的 loader 参数不该泄进子进程
  delete env['NODE_OPTIONS'];

  const proc = spawn(process.execPath, ENTRY_ARGV, {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(proc);

  let out = '';
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    out += chunk;
  });
  proc.stderr?.on('data', (chunk: string) => {
    out += chunk;
  });

  let settled: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on('exit', (code, signal) => {
      settled = { code, signal };
      resolve(settled);
    });
  });

  return { proc, dbPath, output: () => out, result: () => settled, exited };
}

/** 轮询等待；子进程提前退出则立刻报错（别把 60s 白等满才说"超时"） */
async function waitFor(srv: ServerProcess, pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    if (pred()) return;
    const r = srv.result();
    if (r !== null) {
      throw new Error(`${what}：子进程在此前退出 code=${r.code} signal=${r.signal}\n${srv.output()}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${STARTUP_TIMEOUT_MS}ms 仍未满足：${what}\n${srv.output()}`);
    }
    await delay(25);
  }
}

describe('src/server.ts（进程级）', () => {
  it('冷启动：网关面与管理面都起来', async () => {
    const srv = startServer();
    await waitFor(
      srv,
      () => srv.output().includes('网关面已启动') && srv.output().includes('管理面已启动'),
      '两个监听都启动',
    );

    // 本用例只验脚手架与启动路径，停机关法不在判据内：直接硬杀收场
    srv.proc.kill('SIGKILL');
    await srv.exited;
  }, STARTUP_TIMEOUT_MS + 10_000);

  it.skipIf(!POSIX)(
    'SIGTERM → 优雅停机：exit 0 / signal null / 无落库失败 / WAL 已收起',
    async () => {
      const srv = startServer();
      await waitFor(srv, () => srv.output().includes('管理面已启动'), '管理面启动');

      // 前提：启动期的写（建表 + 建管理员）已经把 WAL 支起来。
      // 没有它，"WAL 消失了"就什么都不证明 —— 判据的前提条件必须先自证。
      const walPath = `${srv.dbPath}-wal`;
      assert.equal(existsSync(walPath), true, '用例前提：启动写入后应存在 -wal 边车文件');

      srv.proc.kill('SIGTERM');
      const r = await srv.exited;

      assert.equal(r.code, 0, `应以 0 退出（收到信号并被默认动作杀掉会是 code=null），实际 ${JSON.stringify(r)}\n${srv.output()}`);
      assert.equal(r.signal, null, `不应死于信号，实际 ${JSON.stringify(r)}`);
      assert.ok(srv.output().includes('收到退出信号'), `日志里应能看到信号被处理：\n${srv.output()}`);

      for (const bad of ['用量日志落库失败', 'key_runtime 镜像刷写失败', '关闭失败']) {
        assert.ok(!srv.output().includes(bad), `关停过程出现「${bad}」：\n${srv.output()}`);
      }

      // 跨进程的"db.close() 真跑完了"证据：最后一个连接干净关闭会删掉 WAL 边车。
      assert.equal(
        existsSync(walPath),
        false,
        'WAL 边车还在 = 连接不是被干净关闭的（被硬杀，或 db.close() 没走到）',
      );
    },
    EXIT_TIMEOUT_MS + 10_000,
  );
});
