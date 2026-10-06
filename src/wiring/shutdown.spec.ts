// 停机顺序判据（待办 6 里"不依赖信号"的那一半）。
//
// 为什么必须有一条专门判据：`stop()` 里的 `sink.close()` 与 `mirror.close()` 各自是一次 SQLite 写，
// 而它们出错时只走 `onError` 记一行日志、把异常吞掉 —— 于是"库关早了"这类顺序错误
// 从外面看和"一切正常"完全一样：进程照样以 0 退出。顺序不能靠"跑起来没报错"来判，
// 只能把每一步的调用次序、以及**那一刻库还开着吗**一起记下来断言。
//
// 用真 runtime（`src/wiring/runtime.ts`）+ 真库，不用桩：判据要落在真实的 `stop()` 上，
// 拿桩去测等于测自己写的那份桩。唯一的假件是两个 Fastify 实例的 `close()`（本用例不关心监听
// 怎么关，只关心它排在链条的哪一步）和一个用来捕获退出码的 `exit`。
//
// 信号那半截（真 SIGTERM 能不能走到这条路径）见 `src/server.spec.ts`：win32 上验不了，归 Linux CI。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterAll, afterEach, describe, it } from 'vitest';

import { loadConfig } from '../config.js';
import { openDatabase, openReadonly } from '../db/database.js';
import type { Db } from '../db/database.js';
import type { UsageLogEntry } from '../gateway/ports.js';
import { createGatewayRuntime } from './runtime.js';
import type { GatewayRuntime } from './runtime.js';
import { createShutdownHandler } from './shutdown.js';
import type { ShutdownTarget } from './shutdown.js';

/** 与其它 wiring 用例同款：hex 64 字符，够 32 字节即可，不是真凭据 */
const MASTER_KEY_HEX = 'a7'.repeat(32);

/**
 * 一条真实形状的用量记录。字段取"能落库"的最小合法组合：
 * 三个 id 传空串 —— 实现侧会把它转成 null（空串进库等于指向空主键的假外键）。
 */
const ENTRY: UsageLogEntry = {
  groupId: '',
  keyId: '',
  upstreamId: '',
  model: 'gpt-shutdown-probe',
  clientModel: 'gpt-shutdown-probe',
  endpoint: '/v1/chat/completions',
  stream: false,
  statusCode: 200,
  promptTokens: 3,
  completionTokens: 5,
  totalTokens: 8,
  isEstimated: false,
  ttfbMs: 12,
  latencyMs: 20,
  attempts: 1,
  failureReason: null,
  at: new Date().toISOString(),
};

interface Harness {
  dbPath: string;
  db: Db;
  gateway: GatewayRuntime;
}

const dirs: string[] = [];
const dbs: Db[] = [];

// 与 `src/server.spec.ts` 的 `sigtermCaseRan` 同款，堵的是另一半僵尸：
// `check:shutdown` 拆成两段（各自唯一过滤器）之后，文件被删/改名会转红 ——
// 但"文件还在、顺序用例却被 `skip` 掏空"仍然静默绿（`1 skipped` 退出 0）。
// 于是让顺序判据自己记账：CI 上只有两种结局，真跑过，或整步转红。
// 前提是本文件里至少留一条无跳过用例（现有三条全是），日后给它加 `skipIf` 会连带失效。
let orderCaseRan = false;

afterAll(() => {
  if (process.env['CI'] !== undefined && !orderCaseRan) {
    throw new Error(
      'CI 上停机顺序用例没有真正执行（被跳过？）：db.close() 必须最后 这条判据此刻形同虚设',
    );
  }
});

afterEach(() => {
  // 正常路径下 db 由停机编排关掉，失败用例里可能还开着 —— 两种都要收干净，
  // 否则 Windows 上临时目录会被占用，rmSync 报 EBUSY。
  for (const db of dbs.splice(0)) {
    try {
      if (db.open) db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上偶发仍被短暂占用 */
    }
  }
});

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'shutdown-'));
  dirs.push(dir);
  const dbPath = join(dir, 'gateway.db');

  const config = loadConfig({ MASTER_KEY: MASTER_KEY_HEX, DB_PATH: dbPath });
  const db = openDatabase({ path: dbPath });
  dbs.push(db);

  return { dbPath, db, gateway: createGatewayRuntime({ db, config }) };
}

function countLogs(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get() as { n: number }).n;
}

/**
 * 把停机链上每一步都包一层记录器。
 * 关键：`stop()` 调的是 `sink` / `mirror` / `store.secrets` **这几个对象的同一个引用**，
 * 所以在返回出去的对象上包方法，编排里调到的一定是被包过的那份。
 */
function instrument(h: Harness, order: string[], dbOpenAt: Record<string, boolean>): {
  adminApp: { close(): Promise<void> };
  gateway: ShutdownTarget['gateway'];
} {
  const note = (stage: string): void => {
    order.push(stage);
    dbOpenAt[stage] = h.db.open;
  };

  const rawSinkClose = h.gateway.sink.close.bind(h.gateway.sink);
  h.gateway.sink.close = () => {
    note('sink.close');
    rawSinkClose();
  };

  const rawMirrorClose = h.gateway.mirror.close.bind(h.gateway.mirror);
  h.gateway.mirror.close = () => {
    note('mirror.close');
    rawMirrorClose();
  };

  const rawSecretsClear = h.gateway.store.secrets.clear.bind(h.gateway.store.secrets);
  h.gateway.store.secrets.clear = () => {
    note('secrets.clear');
    rawSecretsClear();
  };

  // better-sqlite3 的 close() 声明成返回 this，包成 void 版本要过一次显式转换
  const rawDbClose = h.db.close.bind(h.db);
  (h.db as unknown as { close: () => void }).close = () => {
    note('db.close');
    rawDbClose();
  };

  // 不直接改写 Fastify 实例的 close：它的类型是重载的（`(): Promise<undefined>` + 回调版），
  // 赋值签名对不上。包一层同样能记录调用点，而且调到的仍是真实例。
  const gatewayApp = {
    close: (): Promise<undefined> => {
      note('gatewayApp.close');
      return h.gateway.app.close();
    },
  };

  return {
    adminApp: { close: async (): Promise<void> => void note('adminApp.close') },
    gateway: { stop: () => h.gateway.stop(), app: gatewayApp },
  };
}

describe('停机编排（src/wiring/shutdown.ts）', () => {
  it('顺序：sink.close → mirror.close → secrets.clear → 两个监听 → db.close → exit(0)', async () => {
    orderCaseRan = true;

    const h = makeHarness();
    const order: string[] = [];
    const dbOpenAt: Record<string, boolean> = {};
    const logs: string[] = [];
    const { adminApp, gateway } = instrument(h, order, dbOpenAt);

    // 先往队列里放一条真实用量：它只可能在收尾 flush 里落库。
    // 这是"db.close() 排在最后"的**可观测后果** —— 顺序反了，这条记录就查不到。
    h.gateway.sink.record(ENTRY);
    assert.equal(h.gateway.sink.pending(), 1, '用例前提：队列里应有 1 条待落库用量');
    assert.equal(countLogs(h.db), 0, '用例前提：落库前 usage_logs 应为 0 行');

    let signalExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      signalExit = resolve;
    });

    const shutdown = createShutdownHandler({
      gateway,
      app: adminApp,
      db: h.db,
      timers: [],
      log: {
        info: (_obj, msg) => logs.push(msg),
        error: (_obj, msg) => logs.push(msg),
      },
      exit: (code) => {
        order.push(`exit(${code})`);
        signalExit(code);
      },
    });

    shutdown('SIGTERM');
    const code = await exited;

    assert.equal(code, 0, '正常关停必须以 0 退出');
    assert.deepEqual(order, [
      'sink.close',
      'mirror.close',
      'secrets.clear',
      'adminApp.close',
      'gatewayApp.close',
      'db.close',
      'exit(0)',
    ]);

    // 前三步都要写 SQL，那一刻库必须还开着
    for (const stage of ['sink.close', 'mirror.close', 'secrets.clear']) {
      assert.equal(dbOpenAt[stage], true, `${stage} 时库已关闭：收尾 flush 会写到已关闭的连接上`);
    }
    assert.equal(h.db.open, false, 'db.close() 必须真的把句柄关掉');
    assert.deepEqual(logs, ['收到退出信号，正在关闭']);

    // 换个只读连接去查：证明那条记录是真落盘了，不是内存里的假象
    const reader = openReadonly(h.dbPath);
    try {
      assert.equal(countLogs(reader), 1, '收尾 flush 没落库 —— db.close() 先于 stop() 的典型症状');
    } finally {
      reader.close();
    }
  });

  it('幂等：连收两个信号只关停一次（第二遍会在已关的连接上再写一次）', async () => {
    const h = makeHarness();
    const order: string[] = [];
    const { adminApp, gateway } = instrument(h, order, {});

    let signalExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      signalExit = resolve;
    });
    const shutdown = createShutdownHandler({
      gateway,
      app: adminApp,
      db: h.db,
      timers: [],
      log: { info: () => undefined, error: () => undefined },
      exit: (code) => {
        order.push(`exit(${code})`);
        signalExit(code);
      },
    });

    shutdown('SIGINT');
    shutdown('SIGTERM'); // 连按两次 Ctrl-C 的等价形状
    await exited;

    assert.equal(order.filter((s) => s === 'sink.close').length, 1, 'stop() 不应跑第二遍');
    assert.equal(order.filter((s) => s === 'db.close').length, 1, 'db.close() 不应跑第二遍');
    assert.equal(order.filter((s) => s.startsWith('exit(')).length, 1);
  });

  it('监听关不掉时以 1 退出并留痕 —— 但用量已经先落库了', async () => {
    const h = makeHarness();
    const order: string[] = [];
    const logs: string[] = [];
    const { adminApp, gateway } = instrument(h, order, {});
    adminApp.close = async () => {
      order.push('adminApp.close');
      throw new Error('监听关闭失败（用例构造）');
    };

    h.gateway.sink.record(ENTRY);

    let signalExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      signalExit = resolve;
    });
    const shutdown = createShutdownHandler({
      gateway,
      app: adminApp,
      db: h.db,
      timers: [],
      log: {
        info: (_obj, msg) => logs.push(msg),
        error: (_obj, msg) => logs.push(msg),
      },
      exit: (code) => {
        order.push(`exit(${code})`);
        signalExit(code);
      },
    });

    shutdown('SIGTERM');
    const code = await exited;

    assert.equal(code, 1, '关停失败必须以非 0 退出，不能静默当成功');
    assert.ok(logs.includes('关闭失败'), `失败必须留痕，实际日志：${logs.join(' / ')}`);
    // 账在关监听之前就已经落了：关闭失败不该让那批用量跟着丢
    assert.ok(order.indexOf('sink.close') < order.indexOf('adminApp.close'));
    const reader = openReadonly(h.dbPath);
    try {
      assert.equal(countLogs(reader), 1, '关停失败路径上，收尾 flush 也应当已经落库');
    } finally {
      reader.close();
    }
  });
});
