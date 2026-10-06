// 余额自动同步调度器 `createBalanceSync` 的验收测试（契约 §14.1–14.4 / ADR-0017）。
//
// 这里钉的是 ADR-0017「验证」清单里**调度器**承担的那几条：
//   1. 间隔与抖动（含首轮抖动、`0` = 关）；        2. 退避阶梯 + 成功归零 + `skipped` 不罚；
//   3. 单飞 + 并发上限复用 `REFRESH_CONCURRENCY`； 4. NULL 口径（取不到就一个字都不写）；
//   5. 快照写入时机与 NULL 口径；                  7. 漂移两态 + 上升不告警 + 未知不判定；
//   8. `asOf` 不撒谎（读路径）；                   9. 热路径零回退（结构面）；10. 零新增枚举/零迁移。
//
// 判据 6（删上游后历史仍可读）在 `src/db/repo/balance-snapshots.spec.ts`；
// §14.3 的**响应形状**在 `src/api/routes/balance-sync.spec.ts`（路由层，与本文件分工不重叠）。
//
// ── 三条测试基建纪律 ───────────────────────────────────────────────────────────
//   a. **注入时钟 + 注入随机源 + `timers:false`，手动驱动 `tick()`**。真定时器会让
//      "30m / 1h / 2h" 这种精确断言变成与真实时钟赛跑，第一个挂的就是它；
//      注入 `random: () => 0.5` 让抖动系数**恰好** 1.0，阶梯才是可写的整数。
//   b. **桩 fetch 只记 pathname**。模板 URL 里的 `{key}` 会被替换成明文再发出去，
//      把整个 URL 记进数组等于在测试里留一份明文 —— 所以 `{key}` 一律放在 query 上，
//      账本只记 pathname（ADR-0006 同纪律，扫描器也会抓 `sk-` 字面量，见文件底部说明）。
//   c. **桩 key 运行时拼**（`'sk-probe-' + 'B'.repeat(24)`）。仓库自带的 `check:secrets`
//      不区分测试与生产，`sk-` 后接 ≥20 位字面量会被它判成"疑似真 key"。

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeGlobalBalance } from '../db/balance.js';
import { openDatabase, type Db } from '../db/database.js';
import { newId } from '../db/ids.js';
import { appendBalanceSnapshot, listBalanceSnapshots } from '../db/repo/balance-snapshots.js';
import { createKey, getKey, setKeyBalance } from '../db/repo/keys.js';
import { createUpstream } from '../db/repo/upstreams.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { ERROR_CODES } from './errors.js';
import { GATEWAY_ERROR_CODES } from '../gateway/errors.js';
import type { BalanceSyncLog } from './balance-sync.js';
import {
  BALANCE_SYNC_BACKOFF_CAP_MINUTES,
  BALANCE_SYNC_JITTER_RATIO,
  createBalanceSync,
  DRIFT_ALERT_LIMIT,
  type BalanceSync,
} from './balance-sync.js';
import {
  REFRESH_CONCURRENCY,
  refreshBalances,
  type RefreshDone,
} from './services/balance-refresh.js';
import type { TaskReporter } from './task-runner.js';

const MIN = 60_000;
/** 注入时钟的原点：全部判据都在这个绝对时刻上算，不依赖跑测试的那一天。 */
const T0 = Date.parse('2026-10-07T00:00:00.000Z');
/** 与 `BALANCE_SYNC_MINUTES` 默认值一致（ADR-0017 决策 1）。 */
const BASE_MINUTES = 15;
const MASTER_KEY = Buffer.from('2a'.repeat(32), 'hex');
/** 桩上游的余额端点：`{key}` 走 query 参数，pathname 因而干净（见头注 b）。 */
const UP_ORIGIN = 'https://upstream.example.com';

const dirs: string[] = [];
const open: Db[] = [];

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上偶尔仍被短时占用，临时目录不影响判据 */
    }
  }
});

/* ------------------------------ 桩与夹具 ------------------------------ */

/**
 * 桩响应的**输入**形态：`body` 是原始文本 —— `queryBalance` 是"先 `res.text()`
 * 再 `JSON.parse`"（非 JSON 的报错页要能落到 PARSE_FAILED），所以桩必须提供 `text()`。
 * 只给 `body` 而漏 `text()` 的桩会在解析**之前**抛异常，于是每次尝试都被记成
 * "上游不可达"：失败用例照样红得有理，但"取到值"和"取不到值"两类判据会一起假绿。
 */
interface StubResult {
  status?: number;
  ok?: boolean;
  body?: string;
}

type Handler = (path: string) => StubResult | Promise<StubResult>;

/** `data.balance` 是元（模板 `unit: 'yuan'`）→ 落库是分。 */
function balanceBody(yuan: number): StubResult {
  return { body: JSON.stringify({ data: { balance: yuan } }) };
}

/** 2xx 但取不到数：金额字段缺位 → `unknown`（既不是成功也不是失败）。 */
function emptyBody(): StubResult {
  return { body: JSON.stringify({ data: {} }) };
}

function upstreamError(): StubResult {
  return { status: 500, body: '{"error":"boom"}' };
}

interface Harness {
  db: Db;
  sync: BalanceSync;
  /** 桩 fetch 收到的 pathname，按调用顺序（不含明文，见头注 b）。 */
  calls: string[];
  /** 只收 warn —— 漂移提示的唯一出口是日志 + 进程内计数（ADR-0017 决策 4）。 */
  warns: Record<string, unknown>[];
  fetchImpl: typeof fetch;
  /** 注入时钟的当前 epoch ms。 */
  now(): number;
  /** 把注入时钟推进 delta 毫秒。 */
  advance(delta: number): number;
}

interface HarnessOptions {
  intervalMinutes?: number;
  random?: () => number;
  handler?: Handler;
  retentionDays?: number;
}

function makeHarness(over: HarnessOptions = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'balsync-probe-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  open.push(db);

  const handler: Handler = over.handler ?? ((): StubResult => ({}));
  const calls: string[] = [];
  const warns: Record<string, unknown>[] = [];
  let ms = T0;

  const fetchImpl = (async (input: unknown): Promise<{ ok: boolean; status: number; text(): Promise<string> }> => {
    // 只取 pathname：`{key}` 已被替换成明文，URL 本体不许进任何数组/断言
    calls.push(new URL(String(input)).pathname);
    const r = await handler(new URL(String(input)).pathname);
    const status = r.status ?? 200;
    const body = r.body ?? '';
    return { ok: r.ok ?? (status >= 200 && status < 300), status, text: async (): Promise<string> => body };
  }) as unknown as typeof fetch;

  const log: BalanceSyncLog = {
    info: () => {},
    warn: (obj) => {
      warns.push(obj);
    },
    error: () => {},
  };

  const sync = createBalanceSync({
    db,
    masterKey: MASTER_KEY,
    intervalMinutes: over.intervalMinutes ?? BASE_MINUTES,
    retentionDays: over.retentionDays ?? 90,
    log,
    now: () => new Date(ms),
    random: over.random ?? (() => 0.5),
    fetchImpl,
    // 不注册任何真实定时器：全部由 `tick()` / `pruneNow()` 手动驱动（头注 a）
    timers: false,
  });

  return {
    db,
    sync,
    calls,
    warns,
    fetchImpl,
    now: () => ms,
    advance(delta) {
      ms += delta;
      return ms;
    },
  };
}

let keySeq = 0;

/** 桩 key 运行时拼（头注 c）。同一个测试内多把 key 靠序号区分。 */
function fakeKey(): string {
  keySeq += 1;
  return `sk-probe-${'B'.repeat(20)}${keySeq}`;
}

/** 余额查询模板：`url` 里的 `{key}` 放 query（头注 b）。`path === null` = 不配查询方式。 */
function template(path: string | null): unknown {
  return {
    enabled: path !== null,
    url: path === null ? null : `${UP_ORIGIN}${path}?key={key}`,
    method: 'GET',
    headers: {},
    body: null,
    parse: {
      balance: 'data.balance',
      currency: null,
      remainingTokens: null,
      expiresAt: null,
      unit: 'yuan',
    },
    timeoutMs: 5000,
  };
}

function addUpstream(h: Harness, name: string, path: string | null): string {
  const up = createUpstream(h.db, {
    name,
    baseUrl: UP_ORIGIN,
    balanceQuery: template(path),
  });
  return up.id;
}

function addKey(h: Harness, upstreamId: string, balance: number | null, category: 'balance' | 'token-plan' = 'balance'): string {
  const dto = createKey(
    h.db,
    { upstreamId, key: fakeKey(), category, ...(balance === null ? {} : { balance }) },
    MASTER_KEY,
  );
  return dto.id;
}

/** 让 `refreshBalances` 内部的若干次 await 全部跑完（真定时器 0ms，不引入睡眠）。 */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function upstreamState(h: Harness, upstreamId: string) {
  return h.sync.status(3600).upstreams.find((u) => u.upstreamId === upstreamId);
}

/** 该上游下一次尝试距现在的毫秒数；没排上程时为 null。 */
function nextDelayMs(h: Harness, upstreamId: string): number | null {
  const next = upstreamState(h, upstreamId)?.nextAttemptAt;
  return next === null || next === undefined ? null : Date.parse(next) - h.now();
}

/** 先排一程再跨过它：`tick()` 的语义是"到点就起"，头一拍只负责排程。 */
async function runDueRound(h: Harness, delayMs = BASE_MINUTES * MIN): Promise<void> {
  await h.sync.tick();
  h.advance(delayMs);
  await h.sync.tick();
}

/* ------------------------------ 判据 1：间隔与抖动 ------------------------------ */

describe('§14.1 判据 1 —— 间隔与抖动', () => {
  it('基准 15 分钟；注入中点随机源时排程正好落在 base（抖动因子恰为 1.0）', async () => {
    const h = makeHarness();
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);

    await h.sync.tick();

    // 头一拍**只排程、不起跑**：否则"到点才跑"这条就无从验证了
    expect(h.calls).toEqual([]);
    expect(nextDelayMs(h, up)).toBe(BASE_MINUTES * MIN);
    expect(upstreamState(h, up)?.nextAttemptAt).toBe(new Date(T0 + BASE_MINUTES * MIN).toISOString());
  });

  it('首轮同样带抖动：三个上游的首轮延迟互不相同，且各自落在 [0.9, 1.1] × base', async () => {
    // 顺序取 [0, 0.5, 1) → 因子 0.9 / 1.0 / 1.1（抖动是第一周期就生效的，
    // 否则开机那一刻 N 个上游同时开火，退避与单飞都救不了"同时"——PM 实现期纪律 2）
    const seq = [0, 0.5, 0.999_999];
    let i = 0;
    const h = makeHarness({ random: () => seq[i++ % seq.length] ?? 0.5 });
    const ids = ['up-a', 'up-b', 'up-c'].map((n) => addUpstream(h, n, `/balance/${n}`));

    await h.sync.tick();

    const delays = ids.map((id) => nextDelayMs(h, id) ?? -1);
    const base = BASE_MINUTES * MIN;
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(Math.floor(base * (1 - BALANCE_SYNC_JITTER_RATIO)));
      expect(d).toBeLessThanOrEqual(Math.ceil(base * (1 + BALANCE_SYNC_JITTER_RATIO)));
    }
    expect(new Set(delays).size).toBe(3);
    expect(delays).toEqual([base * 0.9, base, base * 1.1].map((v) => Math.round(v)));
  });

  it('没到点不起跑；到点那一拍才发请求', async () => {
    const h = makeHarness({ handler: () => balanceBody(10) });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);

    await h.sync.tick();
    h.advance(BASE_MINUTES * MIN - 1);
    await h.sync.tick();
    expect(h.calls).toEqual([]);

    h.advance(1);
    await h.sync.tick();
    expect(h.calls).toEqual(['/balance']);
  });

  it('intervalMinutes=0（BALANCE_SYNC_MINUTES=0）→ auto.enabled=false / nextRunAt=null / 无排程 / tick 空转', async () => {
    const h = makeHarness({ intervalMinutes: 0, handler: () => balanceBody(10) });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);

    h.sync.start(); // 关着也允许起：它只是不注册排程拍节

    // 契约把"关"表达为这三个可观测字段，测试就断这三个（定时器句柄本身在
    // `timers:false` 下永远是 null，拿它当判据等于断了个恒真式）
    const st = h.sync.status(3600);
    expect(st.auto).toEqual({
      enabled: false,
      intervalMinutes: 0,
      jitterRatio: BALANCE_SYNC_JITTER_RATIO,
      backoffCapMinutes: BALANCE_SYNC_BACKOFF_CAP_MINUTES,
    });
    expect(st.nextRunAt).toBeNull();
    expect(upstreamState(h, up)?.nextAttemptAt).toBeNull();

    // 运营后果一并钉住：关了就一把都不许查，跨 6 小时、连拍多次也不许
    for (let i = 0; i < 5; i += 1) {
      await h.sync.tick();
      h.advance(6 * 60 * MIN);
    }
    expect(h.calls).toEqual([]);
    expect(st.lastSyncedAt).toBeNull();
    expect(st.lastTrigger).toBeNull();

    h.sync.stop();
  });

  it('start / stop 幂等：重复调用不多排一轮程、不多裁一次表，且 stop 后 tick 不再起跑', async () => {
    const h = makeHarness({ handler: () => balanceBody(10) });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);

    h.sync.start();
    h.sync.start(); // 第二次必须是空操作：每拍多排一次程会让退避阶梯整体错位
    await h.sync.tick();
    const planned = nextDelayMs(h, up);
    expect(planned).toBe(BASE_MINUTES * MIN);

    h.sync.stop();
    h.sync.stop();
    h.advance(6 * 60 * MIN);
    await h.sync.tick();
    expect(h.calls).toEqual([]);
  });
});

/* ------------------------------ 判据 2：退避 ------------------------------ */

describe('§14.1 判据 2 —— 退避阶梯', () => {
  it('连续失败：30m → 1h → 2h → 4h → 6h → 封顶 6h', async () => {
    const h = makeHarness({ handler: () => upstreamError() });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);

    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      // 每次跨 6h：既保证"到点"，也让封顶那一档（360m）必然被跨过
      await runDueRound(h, 6 * 60 * MIN);
      delays.push(nextDelayMs(h, up) ?? -1);
    }

    expect(delays).toEqual([30, 60, 120, 240, 360, 360].map((m) => m * MIN));
    expect(upstreamState(h, up)?.consecutiveFailures).toBe(6);
    // 6h 封顶是硬上限：跑再久也不许越过
    expect(Math.max(...delays)).toBe(BALANCE_SYNC_BACKOFF_CAP_MINUTES * MIN);
  });

  it('拿到任何一个有效值即归零，下一轮回到基准间隔', async () => {
    let broken = true;
    const h = makeHarness({ handler: () => (broken ? upstreamError() : balanceBody(12.5)) });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);

    await runDueRound(h);
    await runDueRound(h, 60 * MIN);
    expect(upstreamState(h, up)?.consecutiveFailures).toBe(2);
    expect(nextDelayMs(h, up)).toBe(60 * MIN); // 2 次失败 → 2^2 × 15m = 1h

    broken = false;
    await runDueRound(h, 6 * 60 * MIN);
    expect(upstreamState(h, up)?.consecutiveFailures).toBe(0);
    expect(nextDelayMs(h, up)).toBe(BASE_MINUTES * MIN);
  });

  it('skipped（没配查询方式）不推进退避：没做的事不该被罚', async () => {
    // `path: null` → 模板未启用且 baseUrl 不命中任何内置 preset → 一个请求都不发
    const h = makeHarness({ handler: () => balanceBody(10) });
    const up = addUpstream(h, 'up-a', null);
    addKey(h, up, null);

    await runDueRound(h);
    await runDueRound(h);

    expect(h.calls).toEqual([]);
    expect(upstreamState(h, up)?.consecutiveFailures).toBe(0);
    expect(nextDelayMs(h, up)).toBe(BASE_MINUTES * MIN);
  });

  it('手动刷新的收尾钩子同样归零退避（用户点过了、且通了，不该让他等 6 小时）', async () => {
    const h = makeHarness({ handler: () => upstreamError() });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);

    await runDueRound(h);
    await runDueRound(h, 60 * MIN);
    expect(upstreamState(h, up)?.consecutiveFailures).toBe(2);

    // 手动刷新走同一个入口，只是 trigger 不同（§14.3"任意触发都算"）
    h.sync.onRefreshDone(done({ upstreamId: up, trigger: 'manual', checked: 1, ok: 1 }));

    expect(upstreamState(h, up)?.consecutiveFailures).toBe(0);
    expect(nextDelayMs(h, up)).toBe(BASE_MINUTES * MIN);
  });
});

/* --------------------- 判据 3：单飞与并发上限 --------------------- */

describe('§14.1 判据 3 —— 单飞与并发上限', () => {
  it('单飞：上一轮未结束时该上游被跳过（不并发、不排队、不堆积）', async () => {
    const gate = deferred();
    const h = makeHarness({
      handler: async () => {
        await gate.promise;
        return balanceBody(10);
      },
    });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);

    await h.sync.tick();
    h.advance(BASE_MINUTES * MIN);
    const inFlight = h.sync.tick();
    await flush();

    expect(h.calls).toHaveLength(1);
    expect(h.sync.inFlightCount()).toBe(1);
    expect(upstreamState(h, up)?.inFlight).toBe(true);

    // 下一拍又到点了，但上一轮还在飞 —— 这一拍必须原地不动
    h.advance(BASE_MINUTES * MIN);
    await h.sync.tick();
    expect(h.calls).toHaveLength(1);

    gate.resolve();
    await inFlight;
    expect(h.sync.inFlightCount()).toBe(0);
  });

  it(`并发上限复用 REFRESH_CONCURRENCY：6 个上游同时到点只起 ${REFRESH_CONCURRENCY} 个，余下等下一拍`, async () => {
    const gate = deferred();
    const h = makeHarness({
      handler: async () => {
        await gate.promise;
        return balanceBody(10);
      },
    });
    const ids = Array.from({ length: 6 }, (_, i) => addUpstream(h, `up-${i}`, `/balance/${i}`));
    for (const id of ids) addKey(h, id, null);

    await h.sync.tick();
    h.advance(BASE_MINUTES * MIN);
    const round = h.sync.tick();
    await flush();

    // 上限是**全量刷新的那一个**（不另拍第二个数，免得两处慢慢漂开）
    expect(h.calls).toHaveLength(REFRESH_CONCURRENCY);
    expect(h.sync.inFlightCount()).toBe(REFRESH_CONCURRENCY);

    gate.resolve();
    await round;
    expect(h.sync.inFlightCount()).toBe(0);
    expect(h.calls).toHaveLength(REFRESH_CONCURRENCY);

    // 被挡下的那两个**不是排队**（没有队列这回事）：不在飞、仍逾期、下一拍到点
    const pending = ids.filter((_, i) => !h.calls.includes(`/balance/${i}`));
    expect(pending).toHaveLength(6 - REFRESH_CONCURRENCY);
    for (const id of pending) {
      expect(upstreamState(h, id)?.inFlight).toBe(false);
      expect(Date.parse(String(upstreamState(h, id)?.nextAttemptAt))).toBeLessThanOrEqual(h.now());
    }

    // 把时钟推到"先跑的那批还没到点、被挡下的两个已经到点"那一刻：它们补跑。
    // 断的是**覆盖**不是次数 —— 固定迭代顺序 + 同抖动下谁抢到槽位由顺序决定，
    // 判据要的是"没有上游被永久饿死"，不是一个依赖顺序的数字。
    h.advance(BASE_MINUTES * MIN - 1);
    await h.sync.tick();
    expect(new Set(h.calls)).toEqual(new Set(ids.map((_, i) => `/balance/${i}`)));
  });
});

/* ------------------------- 判据 4 / 8：NULL 口径与 asOf ------------------------- */

describe('§14.2 判据 4 / §14.3 判据 8 —— 取不到就一个字都不写', () => {
  it('查失败（非 2xx）→ 金额与 balance_updated_at 都不变', async () => {
    const h = makeHarness({ handler: () => upstreamError() });
    const up = addUpstream(h, 'up-a', '/balance');
    const keyId = addKey(h, up, 8888);
    const before = getKey(h.db, keyId, false);

    await runDueRound(h);

    const after = getKey(h.db, keyId, false);
    expect(after?.balance).toBe(8888);
    expect(after?.balanceUpdatedAt).toBe(before?.balanceUpdatedAt);
    expect(after?.balanceSource).toBe('manual');
    expect(after?.health).toBe('healthy');
  });

  it('2xx 但取不到金额（unknown）→ 同样一个字都不写（把陈旧读数推新比不显示更坏）', async () => {
    const h = makeHarness({ handler: () => emptyBody() });
    const up = addUpstream(h, 'up-a', '/balance');
    const keyId = addKey(h, up, 8888);
    const before = getKey(h.db, keyId, false);

    await runDueRound(h);

    const after = getKey(h.db, keyId, false);
    expect(after?.balance).toBe(8888);
    expect(after?.balanceUpdatedAt).toBe(before?.balanceUpdatedAt);
    expect(after?.balanceSource).toBe('manual');
  });

  it('从未查到过 → 保持 NULL，绝不写成 0（"未知"与"确实没钱了"是两条分支）', async () => {
    const h = makeHarness({ handler: () => emptyBody() });
    const up = addUpstream(h, 'up-a', '/balance');
    const keyId = addKey(h, up, null);

    await runDueRound(h);
    await runDueRound(h);

    const after = getKey(h.db, keyId, false);
    expect(after?.balance).toBeNull();
    expect(after?.balance).not.toBe(0);
    expect(after?.balanceUpdatedAt).toBeNull();
    expect(after?.balanceSource).toBeNull();
  });

  it('§8 读路径：一次真实的成功查询**会**把 asOf 推到新时刻（判据不是"永远不动"）', async () => {
    let broken = true;
    const h = makeHarness({ handler: () => (broken ? upstreamError() : balanceBody(66)) });
    const up = addUpstream(h, 'up-a', '/balance');
    const keyId = addKey(h, up, 8888);
    // 把 `balance_updated_at` 打到一天前再断：`refreshBalances` 用**真实时钟**盖章，
    // 而整轮刷新可能在同一毫秒里跑完 —— 拿"录入那一刻"当旧值会偶尔碰巧相等。
    const stale = at(-24 * 60 * MIN);
    h.db.prepare('UPDATE upstream_keys SET balance_updated_at = ? WHERE id = ?').run(stale, keyId);

    await runDueRound(h);
    expect(getKey(h.db, keyId, false)?.balanceUpdatedAt).toBe(stale);

    broken = false;
    await runDueRound(h, 60 * MIN);
    const after = getKey(h.db, keyId, false);
    expect(after?.balance).toBe(6600);
    expect(after?.balanceSource).toBe('template');
    expect(Date.parse(String(after?.balanceUpdatedAt))).toBeGreaterThan(Date.parse(stale));
  });
});

/* ------------------------------ 判据 5：快照 ------------------------------ */

const NOOP_REPORTER: TaskReporter = {
  id: 'probe-manual',
  setTotal: () => {},
  step: () => {},
  note: () => {},
};

describe('§14.3 判据 5 —— 快照只在"覆盖整个上游"的一轮之后写', () => {
  it('整上游同步后新增 1 行，合计与三计数取自**刷新后**的库值', async () => {
    let yuan = 100;
    const h = makeHarness({ handler: () => balanceBody(yuan) });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, 5000); // 手录 5000 分，会被模板值覆盖
    addKey(h, up, 2500);
    addKey(h, up, null, 'token-plan'); // token-plan 类进 tokenPlanKeyCount，不进金额合计

    yuan = 100; // 100 元 = 10000 分
    await runDueRound(h);

    const rows = listBalanceSnapshots(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.upstreamId).toBe(up);
    expect(rows[0]?.upstreamName).toBe('up-a');
    expect(rows[0]?.trigger).toBe('auto');
    expect(rows[0]?.totalBalanceCents).toBe(10000 + 10000);
    expect(rows[0]?.knownKeyCount).toBe(2);
    expect(rows[0]?.unknownKeyCount).toBe(0);
    expect(rows[0]?.tokenPlanKeyCount).toBe(1);
    // ts = 本轮完成时刻（上游级 asOf）。它由 `refreshBalances` 用**真实时钟**盖章，
    // 与本 spec 注入给调度器的时钟无关 —— 所以这里断的是"status 报的就是落库那条"，
    // 而不是拿注入时钟去比一个它根本管不到的时刻。
    const ts = rows[0]?.ts ?? '';
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
    expect(h.sync.status(6 * 3600).lastSyncedAt).toBe(ts);
    expect(h.sync.status(6 * 3600).lastTrigger).toBe('auto');
  });

  it('单 key 手动刷新**不**新增快照行（宁缺一个点，不造假点）', async () => {
    const h = makeHarness({ handler: () => balanceBody(100) });
    const up = addUpstream(h, 'up-a', '/balance');
    const a = addKey(h, up, null);
    addKey(h, up, null);

    await runDueRound(h);
    expect(listBalanceSnapshots(h.db)).toHaveLength(1);
    const afterWhole = listBalanceSnapshots(h.db).length;

    // 只刷一把：此刻上游合计里只有这一把是新值、另一把是旧值 ——
    // 记成"上游此刻的状态"会是一条半新半旧的假快照
    await refreshBalances(h.db, MASTER_KEY, { keyIds: [a] }, NOOP_REPORTER, {
      trigger: 'manual',
      onUpstreamDone: h.sync.onRefreshDone,
      fetchImpl: h.fetchImpl,
    });

    expect(listBalanceSnapshots(h.db)).toHaveLength(afterWhole);
  });

  it('带 keyIds 的批量刷新同样不写快照（wholeUpstream 为假）', async () => {
    const h = makeHarness({ handler: () => balanceBody(100) });
    const up = addUpstream(h, 'up-a', '/balance');
    const a = addKey(h, up, null);
    addKey(h, up, null);

    await refreshBalances(h.db, MASTER_KEY, { keyIds: [a] }, NOOP_REPORTER, {
      trigger: 'manual',
      onUpstreamDone: h.sync.onRefreshDone,
      fetchImpl: h.fetchImpl,
    });

    expect(listBalanceSnapshots(h.db)).toEqual([]);
  });

  it('整个上游全未知时 total_balance_cents = NULL（不是 0）', async () => {
    const h = makeHarness({ handler: () => emptyBody() });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);
    addKey(h, up, null);

    await runDueRound(h);

    const rows = listBalanceSnapshots(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalBalanceCents).toBeNull();
    expect(rows[0]?.totalBalanceCents).not.toBe(0);
    expect(rows[0]?.unknownKeyCount).toBe(2);
    expect(rows[0]?.knownKeyCount).toBe(0);
  });

  it('快照数字与 computeGlobalBalance 同源（不另写一套 SQL，免得"总数对不上单上游之和"）', async () => {
    const h = makeHarness({ handler: () => balanceBody(7.5) });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);

    await runDueRound(h);

    const row = listBalanceSnapshots(h.db)[0];
    const u = computeGlobalBalance(h.db).byUpstream.find((x) => x.upstreamId === up);
    expect(row?.totalBalanceCents).toBe(u?.totalBalance);
    // known 是**三格里减掉两格**：无限额度 key 的 balance 恒为 null，但它不进 unknown
    // （ADR-0018 决策 8），所以只减 unknown 会把"无限"算成"已知"。
    expect(row?.knownKeyCount).toBe(
      (u?.balanceKeyCount ?? 0) - (u?.balanceUnknownKeyCount ?? 0) - (u?.unlimitedKeyCount ?? 0),
    );
    expect(row?.unknownKeyCount).toBe(u?.balanceUnknownKeyCount);
    expect(row?.unlimitedKeyCount).toBe(u?.unlimitedKeyCount);
    expect(row?.tokenPlanKeyCount).toBe(u?.tokenPlanKeyCount);
  });
});

/* ------------------------------ 判据 7：漂移 ------------------------------ */

interface DoneOver {
  upstreamId: string;
  trigger?: 'auto' | 'manual';
  checked?: number;
  ok?: number;
  failed?: number;
  unknown?: number;
  skipped?: number;
  wholeUpstream?: boolean;
}

/** 直接驱动收尾钩子：漂移判的是"相邻两条快照 + 窗口内 token"，不必绕道一次真实查询。 */
function done(over: DoneOver): RefreshDone {
  const checked = over.checked ?? 1;
  return {
    at: new Date().toISOString(),
    trigger: over.trigger ?? 'manual',
    wholeUpstream: over.wholeUpstream ?? true,
    upstreams: [
      {
        upstreamId: over.upstreamId,
        checked,
        ok: over.ok ?? checked,
        failed: over.failed ?? 0,
        unknown: over.unknown ?? 0,
        skipped: over.skipped ?? 0,
      },
    ],
  };
}

function seedUsage(h: Harness, upstreamId: string, ts: string, tokens: number): void {
  h.db
    .prepare(
      `INSERT INTO usage_logs (id, ts, upstream_id, key_id, key_masked, status, total_tokens)
       VALUES (?, ?, ?, ?, '****probe', 200, ?)`,
    )
    .run(newId('log'), ts, upstreamId, 'key_probe', tokens);
}

/** 快照的时刻必须由调用方显式给：漂移判的是**相邻两条**，两次同毫秒会被严格早于挡掉。 */
function at(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

describe('§14.4 判据 7 —— 漂移只能是方向级', () => {
  it('余额降 + 窗口内 token = 0 → BALANCE_SPENT_WITHOUT_TRAFFIC（只 warn + 计数）', () => {
    const h = makeHarness();
    const up = addUpstream(h, 'up-a', '/balance');
    const keyId = addKey(h, up, 5000);

    h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(0) });
    setKeyBalance(h.db, keyId, { balance: 4000 });
    h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(15 * MIN) });
    // 快照时刻是手工给的（`at`），但 `status` 的窗口上界取自**注入时钟** ——
    // 不把时钟推到最后一个快照之后，窗口就是 [−24h, T0]，提示全被上界过滤掉，
    // `alerts` 即使一条没漏也会是空数组（假绿）。
    h.advance(15 * MIN);

    const st = h.sync.status(86_400);
    expect(st.drift.counts.BALANCE_SPENT_WITHOUT_TRAFFIC).toBe(1);
    expect(st.drift.counts.BALANCE_UNCHANGED_WITH_TRAFFIC).toBe(0);
    expect(st.drift.alerts).toEqual([
      {
        code: 'BALANCE_SPENT_WITHOUT_TRAFFIC',
        upstreamId: up,
        from: at(0),
        to: at(15 * MIN),
        usedTokens: 0,
      },
    ]);
    // 出口只有两个：一条 warn + 一个进程内计数
    expect(h.warns.map((w) => w['code'])).toEqual(['BALANCE_SPENT_WITHOUT_TRAFFIC']);
    expect(h.warns[0]?.['usedTokens']).toBe(0);
    // 提示就是提示：库值与快照条数除我们自己写的之外零变化
    expect(getKey(h.db, keyId, false)?.balance).toBe(4000);
    expect(listBalanceSnapshots(h.db)).toHaveLength(2);
  });

  it('余额平 + 窗口内 token > 0 → BALANCE_UNCHANGED_WITH_TRAFFIC', () => {
    const h = makeHarness();
    const up = addUpstream(h, 'up-a', '/balance');
    const keyId = addKey(h, up, 4000);

    h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(0) });
    seedUsage(h, up, at(5 * MIN), 12_000);
    h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(15 * MIN) });
    h.advance(15 * MIN); // 同上：窗口上界要越过后一个快照

    const st = h.sync.status(86_400);
    expect(st.drift.counts.BALANCE_UNCHANGED_WITH_TRAFFIC).toBe(1);
    expect(st.drift.alerts[0]).toEqual({
      code: 'BALANCE_UNCHANGED_WITH_TRAFFIC',
      upstreamId: up,
      from: at(0),
      to: at(15 * MIN),
      usedTokens: 12_000,
    });
    expect(getKey(h.db, keyId, false)?.balance).toBe(4000);
  });

  it('余额上升不告警（充值 / 上游按周期重置都正常）；token 用量再大也不告警', () => {
    const h = makeHarness();
    const up = addUpstream(h, 'up-a', '/balance');
    const keyId = addKey(h, up, 4000);

    h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(0) });
    seedUsage(h, up, at(5 * MIN), 999_999);
    setKeyBalance(h.db, keyId, { balance: 9000 });
    h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(15 * MIN) });
    h.advance(15 * MIN); // 让窗口真的罩得住那两条快照，否则"没有告警"可能只是被窗口滤掉的

    const st = h.sync.status(86_400);
    expect(st.drift.counts).toEqual({
      BALANCE_SPENT_WITHOUT_TRAFFIC: 0,
      BALANCE_UNCHANGED_WITH_TRAFFIC: 0,
    });
    expect(st.drift.alerts).toEqual([]);
    expect(h.warns).toEqual([]);
  });

  it('任一端为 null 不判定（未知与未知之间没有差额可言）；只有 1 条快照也不判', () => {
    const h = makeHarness();
    const up = addUpstream(h, 'up-a', '/balance');
    const keyId = addKey(h, up, null); // 全未知 → 快照的 totalBalanceCents 为 NULL

    h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(0) });
    // 只有一条：`previousBalanceSnapshot` 回 null，不判
    expect(h.sync.status(86_400).drift.alerts).toEqual([]);

    h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(15 * MIN) });
    setKeyBalance(h.db, keyId, { balance: 4000 }); // 一端 NULL 一端有值
    h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(30 * MIN) });
    h.advance(30 * MIN); // 窗口上界推到最后一个快照之后，"不判"才断得实

    expect(h.sync.status(86_400).drift.alerts).toEqual([]);
    expect(h.sync.status(86_400).drift.counts.BALANCE_SPENT_WITHOUT_TRAFFIC).toBe(0);
    expect(h.warns).toEqual([]);
  });

  it('提示窗口外的不返回、条数上限 20；counts 是**进程内累计**不是窗口内量', () => {
    const h = makeHarness();
    const up = addUpstream(h, 'up-a', '/balance');
    const keyId = addKey(h, up, 1_000_000);

    // 造 25 次"降 + 无流量"：每次都写一条新快照
    for (let i = 0; i < 25; i += 1) {
      h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(i * 60 * MIN) });
      const cur = getKey(h.db, keyId, false)?.balance ?? 0;
      setKeyBalance(h.db, keyId, { balance: cur - 100 });
    }
    h.sync.onRefreshDone({ ...done({ upstreamId: up }), at: at(25 * 60 * MIN) });
    // 窗口 = `[now − window, now]`，而 now 是注入时钟 —— 时钟必须推到最后一条快照
    // 之后，否则宽窗和窄窗都会把 25 条提示全滤掉，"上限 20"会以一个空数组通过。
    h.advance(25 * 60 * MIN);

    // counts 记全部（进程内累计），alerts 只给最近 20 条
    const st = h.sync.status(86_400);
    expect(st.drift.counts.BALANCE_SPENT_WITHOUT_TRAFFIC).toBe(25);
    expect(st.drift.alerts).toHaveLength(DRIFT_ALERT_LIMIT);
    // 按 `to` 倒序
    const tos = st.drift.alerts.map((a) => a.to);
    expect([...tos].sort().reverse()).toEqual(tos);

    // 窗口收窄到最近半小时：`[…, 24h]` 与 `[…, 25h]` 两条里只剩最后那一条，但 counts 不动
    const narrow = h.sync.status(1800);
    expect(narrow.drift.alerts).toHaveLength(1);
    expect(narrow.drift.alerts[0]?.to).toBe(at(25 * 60 * MIN));
    expect(narrow.drift.counts.BALANCE_SPENT_WITHOUT_TRAFFIC).toBe(25);
  });
});

/* ------------------------------ 判据 9 / 10：边界 ------------------------------ */

/** 递归收集某个目录下的全部 `.ts`（判据 9 的静态面）。 */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTs(abs, out);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts') && statSync(abs).size > 0) out.push(abs);
  }
  return out;
}

describe('判据 9 / 10 —— 热路径零回退与零新增枚举', () => {
  it('§9 结构面：src/gateway/ 全目录零引用余额同步 / 快照 / 刷新（本版热路径新增同步读写 = 0）', () => {
    const files = collectTs(join(process.cwd(), 'src', 'gateway'));
    expect(files.length).toBeGreaterThan(5); // 0 文件 = 假绿

    const forbidden = [
      'balance-sync',
      'createBalanceSync',
      'balance-snapshots',
      'balance_snapshots',
      'refreshBalances',
      'computeGlobalBalance',
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const needle of forbidden) {
        if (text.includes(needle)) offenders.push(`${file} → ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('§10 零新增枚举 / 零迁移：两张码表长度不变，SCHEMA_VERSION 仍为 2，漂移码不在码表里', () => {
    expect(ERROR_CODES).toHaveLength(15);
    expect(Object.keys(GATEWAY_ERROR_CODES)).toHaveLength(10);
    expect(SCHEMA_VERSION).toBe(2);

    // 漂移码的地位同 `hintCode`：进码表就等于给它开了 HTTP 状态与拦截能力
    const codes: string[] = [...ERROR_CODES];
    expect(codes).not.toContain('BALANCE_SPENT_WITHOUT_TRAFFIC');
    expect(codes).not.toContain('BALANCE_UNCHANGED_WITH_TRAFFIC');
    expect(Object.values(GATEWAY_ERROR_CODES)).not.toContain('BALANCE_SPENT_WITHOUT_TRAFFIC');
    expect(Object.values(GATEWAY_ERROR_CODES)).not.toContain('BALANCE_UNCHANGED_WITH_TRAFFIC');
  });

  it('纯加表：新库开出来即带 balance_snapshots 两索引（零迁移，PM 反查过的那个前提）', () => {
    const h = makeHarness();
    // 排掉 `sqlite_autoindex_*`：TEXT PRIMARY KEY 会被 SQLite 实现成一个隐式唯一索引，
    // 它也在 sqlite_master 里 —— 不排掉的话这条断言就成了"列全表"，多一个隐式索引就红。
    const indexes = h.db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'balance_snapshots' AND name NOT LIKE 'sqlite_autoindex%'
         ORDER BY name`,
      )
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toEqual([
      'idx_balance_snapshots_ts',
      'idx_balance_snapshots_upstream_ts',
    ]);
  });

  it('自动同步**不落 tasks 表**：每 15 分钟 N 行会把任务列表变成噪音', async () => {
    const h = makeHarness({ handler: () => balanceBody(10) });
    const up = addUpstream(h, 'up-a', '/balance');
    addKey(h, up, null);

    await runDueRound(h);

    expect(h.calls).toHaveLength(1);
    const tasks = h.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
    expect(tasks.n).toBe(0);
  });
});
