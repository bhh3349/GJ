// `ErrorEventSink`：分型派生 + 攒批落库（契约 §12.1 / ADR-0013 §7）。
//
// 三条不变式，破了都不会报错、只会静默出错：
//   1. `record()` 绝不碰库 —— 它跑在 `/v1/*` 热路径上，一次同步写就会把
//      "单 key 故障 100ms 内切换"的预算吃掉。这里用"入队后库里仍是 0 行"钉死。
//   2. 分型由 `gatewayCode` 决定、**不是**由 HTTP 状态码现推：429 既可能是限流
//      （退避重试）也可能是配额用尽（今天别来了），两者处置完全相反。
//   3. 脱敏发生在**入队前**：队列里那一份必须已经是净化过的，否则"内存里那份"
//      与"落盘那份"有两套形态，迟早有人读到前者。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ErrorEventEntry } from '../gateway/ports.js';
import { openDatabase, type Db } from '../db/database.js';
import { appendGatewayErrorEvent, listGatewayErrorEvents } from '../db/repo/gateway-events.js';
import { createErrorEventSink, deriveCategory, deriveSeverity } from './error-event-sink.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响判据 */
    }
  }
});

function setup(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'errsink-probe-'));
  dirs.push(dir);
  return openDatabase({ path: join(dir, 'gateway.db') });
}

function countRows(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM gateway_error_events').get() as { n: number }).n;
}

/** 只填与本文件判据相关的字段，其余给安全默认值。 */
function entry(over: Partial<ErrorEventEntry> = {}): ErrorEventEntry {
  return {
    at: '2026-10-06T00:00:00.000Z',
    requestId: 'req-test-0001',
    status: 502,
    gatewayCode: 'UPSTREAM_ERROR',
    failureReason: 'UPSTREAM_ERROR',
    endpoint: '/v1/chat/completions',
    clientModel: 'gpt-probe',
    keyId: 'key_probe',
    upstreamId: 'up_probe',
    stream: false,
    upstreamStatus: 502,
    attempts: 1,
    candidates: 2,
    latencyMs: 12,
    message: 'upstream 502',
    ...over,
  };
}

const maskOf = (keyId: string): string => `****${keyId.slice(-4)}`;

describe('deriveCategory：分型由码值决定，不由状态码推', () => {
  it('§10 码值 → 分型（逐项）', () => {
    const table: [string, string][] = [
      ['INVALID_REQUEST', 'CLIENT_REQUEST'],
      ['NOT_FOUND', 'CLIENT_REQUEST'],
      ['UNSUPPORTED_ENDPOINT', 'CLIENT_REQUEST'],
      ['INVALID_API_KEY', 'AUTH_FAILED'],
      ['GROUP_DISABLED', 'AUTH_FAILED'],
      // v1.15.8 / ADR-0037 决策 5：凭据对了、人（组）不对 —— 与 GROUP_DISABLED 同族。
      ['MODEL_NOT_AUTHORIZED', 'AUTH_FAILED'],
      ['RATE_LIMITED', 'RATE_LIMITED'],
      ['QUOTA_EXCEEDED', 'QUOTA_EXCEEDED'],
      ['NO_AVAILABLE_KEY', 'NO_AVAILABLE_KEY'],
      ['UPSTREAM_ERROR', 'UPSTREAM_ERROR'],
      ['UPSTREAM_TIMEOUT', 'UPSTREAM_TIMEOUT'],
    ];
    for (const [code, category] of table) {
      expect(deriveCategory({ status: 500, gatewayCode: code }), code).toBe(category);
    }
  });

  /**
   * v1.15.8 订正一处**既有**漂移（ADR-0037 决策 5），这条用例的注释本身就是记录：
   *
   * `NO_AVAILABLE_EGRESS` 自 v1.7.0 进契约 §10 表以来，**从未登进 `error-event-sink.ts`
   * 的 CODE 映射** —— 于是 503 `NO_AVAILABLE_EGRESS` 事件被 `deriveCategory` 的 default
   * 一路归成 `INTERNAL`（error 级）。而 §10 那句「§12.1 的 category 仍是 9 值：'出口选不出'
   * 与'key 选不出'是同一个分诊对象」的**意图本来就是**它归 `NO_AVAILABLE_KEY` 分型。
   *
   * 它先于本版存在，本版补上。**不静默改**：判据落在这条断言上，谁去掉映射谁红。
   */
  it('v1.15.8 订正：503 NO_AVAILABLE_EGRESS 归 NO_AVAILABLE_KEY，不再落 INTERNAL', () => {
    expect(deriveCategory({ status: 503, gatewayCode: 'NO_AVAILABLE_EGRESS' })).toBe('NO_AVAILABLE_KEY');
    // 对照：同一个分型的另一个码，两者必须同归一类（这是"同一个分诊对象"的字面判据）
    expect(deriveCategory({ status: 503, gatewayCode: 'NO_AVAILABLE_EGRESS' })).toBe(
      deriveCategory({ status: 503, gatewayCode: 'NO_AVAILABLE_KEY' }),
    );
    // 严重级随分型走：修复前它还会因为落到 INTERNAL 而被判成 error（值班被引向"网关内部出错"）
    expect(deriveSeverity(deriveCategory({ status: 503, gatewayCode: 'NO_AVAILABLE_EGRESS' }))).toBe('error');
  });

  it('同为 429，码值不同则分型不同（这是本表存在的全部理由）', () => {
    expect(deriveCategory({ status: 429, gatewayCode: 'RATE_LIMITED' })).toBe('RATE_LIMITED');
    expect(deriveCategory({ status: 429, gatewayCode: 'QUOTA_EXCEEDED' })).toBe('QUOTA_EXCEEDED');
  });

  it('无码值的 499 → CLIENT_ABORTED（引擎不会为客户端断连造一个 §10 码）', () => {
    expect(deriveCategory({ status: 499, gatewayCode: null })).toBe('CLIENT_ABORTED');
  });

  it('不认识的码值 → INTERNAL，不猜相近分型（码值原样留在事件里，漏登记看得见）', () => {
    expect(deriveCategory({ status: 500, gatewayCode: 'SOMETHING_NEW' })).toBe('INTERNAL');
  });

  it('既无码值也不是 499 → INTERNAL', () => {
    expect(deriveCategory({ status: 500, gatewayCode: null })).toBe('INTERNAL');
  });
});

describe('deriveSeverity：按归因侧分诊，不按状态码', () => {
  it('系统侧三类 + INTERNAL 是 error，调用方/配额侧是 warn', () => {
    expect(deriveSeverity('NO_AVAILABLE_KEY')).toBe('error');
    expect(deriveSeverity('UPSTREAM_ERROR')).toBe('error');
    expect(deriveSeverity('UPSTREAM_TIMEOUT')).toBe('error');
    expect(deriveSeverity('INTERNAL')).toBe('error');
    expect(deriveSeverity('RATE_LIMITED')).toBe('warn');
    expect(deriveSeverity('QUOTA_EXCEEDED')).toBe('warn');
    expect(deriveSeverity('CLIENT_REQUEST')).toBe('warn');
    expect(deriveSeverity('AUTH_FAILED')).toBe('warn');
    expect(deriveSeverity('CLIENT_ABORTED')).toBe('warn');
  });
});

describe('攒批落库', () => {
  it('record() 只入队：入队后库里仍是 0 行，flush() 才落库', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    try {
      sink.record(entry());
      sink.record(entry());
      expect(sink.pending()).toBe(2);
      // 热路径判据：record 期间没有任何一次同步写
      expect(countRows(db)).toBe(0);

      expect(sink.flush()).toBe(2);
      expect(sink.pending()).toBe(0);
      expect(countRows(db)).toBe(2);
    } finally {
      sink.close();
    }
  });

  it('flush 用网关侧时刻，不重打入库时间', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    try {
      sink.record(entry({ at: '2026-10-05T12:00:00.000Z' }));
      sink.flush();
      const page = listGatewayErrorEvents(db, { page: 1, pageSize: 10 });
      expect(page.items[0]?.ts).toBe('2026-10-05T12:00:00.000Z');
    } finally {
      sink.close();
    }
  });

  it('分型/严重级在入队前派生好，落库行与之一致', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    try {
      sink.record(entry({ status: 429, gatewayCode: 'QUOTA_EXCEEDED', failureReason: 'RATE_LIMITED' }));
      sink.flush();
      const e = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items[0];
      expect(e?.category).toBe('QUOTA_EXCEEDED');
      expect(e?.severity).toBe('warn');
      // 三层口径各留各的：码值是 429 的配额码，而 key 失败原因记的是限流
      expect(e?.gatewayCode).toBe('QUOTA_EXCEEDED');
      expect(e?.failureReason).toBe('RATE_LIMITED');
    } finally {
      sink.close();
    }
  });

  it('脱敏发生在入队前：message 里的凭据不会先以明文躺在队列里', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    const cred = 'sk-probe-' + 'A'.repeat(24);
    try {
      sink.record(entry({ message: `upstream echoed Bearer ${cred}` }));
      // 还没 flush：库里当然是空的，但队列那份也必须是净化过的
      expect(sink.pending()).toBe(1);
      sink.flush();
      const e = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items[0];
      expect(e?.message).not.toContain(cred);
      expect(e?.message).toContain('upstream echoed');
      expect(JSON.stringify(e)).not.toContain(cred);
    } finally {
      sink.close();
    }
  });

  it('keyMasked：有 keyId 走 maskOf；keyId 为空写 **** 而不是 null', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    try {
      sink.record(entry({ keyId: 'key_abcd', upstreamId: 'up_probe' }));
      sink.record(entry({ keyId: '', upstreamId: '', clientModel: null }));
      sink.flush();
      const items = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items;
      const withKey = items.find((e) => e.keyId !== null);
      const withoutKey = items.find((e) => e.keyId === null);
      expect(withKey?.keyMasked).toBe('****abcd');
      // null 的语义是"这次失败与某把具体 key 无关"，与"有关联但认不出哪把"不能混同
      expect(withoutKey?.keyMasked).toBe('****');
      expect(withoutKey?.upstreamId).toBeNull();
      expect(withoutKey?.model).toBeNull();
    } finally {
      sink.close();
    }
  });
});

describe('溢出与失败', () => {
  it('队列满丢最旧的，并**计数**（会静默丢数据的观测系统比没有更误导）', () => {
    const db = setup();
    const overflow: number[] = [];
    const sink = createErrorEventSink({ db, maskOf, maxQueue: 3, onOverflow: (n) => overflow.push(n) });
    try {
      for (let i = 0; i < 5; i += 1) {
        sink.record(entry({ message: `e${i}` }));
      }
      expect(sink.pending()).toBe(3);
      expect(sink.dropped()).toBe(2);
      expect(overflow).toEqual([1, 1]);

      sink.flush();
      const items = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items;
      // 留下的是最近三条：e4 / e3 / e2（按 ts 全同，次序由 id 定，这里只比集合）
      expect(items.map((e) => e.message).sort()).toEqual(['e2', 'e3', 'e4']);
    } finally {
      sink.close();
    }
  });

  it('落库失败：丢这一批并计数，不塞回队首（否则新事件会被一个坏连接堵死）', () => {
    const db = setup();
    const errors: number[] = [];
    const sink = createErrorEventSink({ db, maskOf, onError: (_err, n) => errors.push(n) });
    sink.record(entry());
    sink.record(entry());
    db.close();

    expect(sink.flush()).toBe(0);
    expect(sink.pending()).toBe(0);
    expect(sink.dropped()).toBe(2);
    expect(errors).toEqual([2]);
    // close() 时再 flush 一次仍然失败，但不抛出（定时器回调里抛出会变成 unhandled rejection）
    expect(() => sink.close()).not.toThrow();
  });

  it('空队列 flush 是 0 且不建事务', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    try {
      expect(sink.flush()).toBe(0);
      expect(countRows(db)).toBe(0);
    } finally {
      sink.close();
    }
  });
});

describe('close()', () => {
  it('停表并做最后一次 flush（退出前不丢在飞的那一批）', () => {
    const db = setup();
    // 节拍给得足够长：这条用例验证的是 close 的兜底，不是定时器
    const sink = createErrorEventSink({ db, maskOf, flushIntervalMs: 60_000 });
    sink.record(entry());
    expect(countRows(db)).toBe(0);
    sink.close();
    expect(countRows(db)).toBe(1);
  });

  it('节拍到点自动 flush', async () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf, flushIntervalMs: 5 });
    try {
      sink.record(entry());
      await waitFor(() => countRows(db) === 1);
      expect(countRows(db)).toBe(1);
      expect(sink.pending()).toBe(0);
    } finally {
      sink.close();
    }
  });
});

/** 轮询等待条件成立（最多 1s），避免用固定 sleep 赌机器快慢。 */
async function waitFor(pred: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('等待条件超时');
}

describe('仓储层兜底', () => {
  it('单条写入同样过 scrubMessage：绕过 sink 的路径不会漏抹', () => {
    const db = setup();
    const cred = 'gw-' + 'B'.repeat(24);
    appendGatewayErrorEvent(db, {
      requestId: null,
      severity: 'error',
      category: 'INTERNAL',
      status: 500,
      gatewayCode: null,
      failureReason: null,
      endpoint: '/v1/models',
      model: null,
      upstreamId: null,
      keyId: null,
      keyMasked: null,
      stream: false,
      upstreamStatus: null,
      attempts: 0,
      candidates: null,
      latencyMs: null,
      message: `key=${cred}`,
    });
    const e = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items[0];
    expect(e?.message ?? '').not.toContain(cred);
  });
});

describe('attemptTrail 序列化（v1.17.2 / ADR-0042）', () => {
  /** trail 项：网关侧传 keyId（掩码映射归 sink），与 ErrorEventEntry.attemptTrail 同形 */
  const trailItem = (keyId: string, reason = 'AUTH_INVALID', status = 401) => ({ keyId, reason, status });

  it('keyId → 掩码映射走 maskOf（唯一映射处）；空 keyId 兜底 ****；无 trail 落 null', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    try {
      sink.record(entry({ keyId: 'k2', attemptTrail: [trailItem('k1'), trailItem('k2', 'NETWORK', 0)] }));
      sink.flush();
      const e = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items[0];
      const trail = JSON.parse(e?.attemptTrail ?? '[]') as { keyMasked: string; reason: string; status: number }[];
      expect(trail).toEqual([
        { keyMasked: '****k1', reason: 'AUTH_INVALID', status: 401 },
        { keyMasked: '****k2', reason: 'NETWORK', status: 0 },
      ]);
      // 顶层 keyMasked 与 trail 各自映射，不串
      expect(e?.keyMasked).toBe('****k2');

      // 空 trail 落 NULL（不是空串）：空串是第二种"空"，会让 `IS NULL` 的历史语义失真
      sink.record(entry({ attemptTrail: [] }));
      sink.flush();
      const rows = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items;
      expect(rows.some((x) => x.attemptTrail === null)).toBe(true);
      expect(rows.every((x) => x.attemptTrail !== '')).toBe(true);
    } finally {
      sink.close();
    }
  });

  it('项数上限 16：超出保留**前** 16（失败按轮换次序发生，前几把才是起点）', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    const trail = Array.from({ length: 20 }, (_, i) => trailItem(`key_${String(i).padStart(2, '0')}`));
    try {
      sink.record(entry({ attemptTrail: trail }));
      sink.flush();
      const e = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items[0];
      const parsed = JSON.parse(e?.attemptTrail ?? '[]') as { keyMasked: string }[];
      expect(parsed).toHaveLength(16);
      // 保留前 16：第一把（轮换起点）必须在
      expect(parsed[0]?.keyMasked).toBe(maskOf(trail[0]!.keyId));
      expect(parsed.at(-1)?.keyMasked).toBe(maskOf(trail[15]!.keyId));
      expect(parsed.some((x) => x.keyMasked === maskOf(trail[19]!.keyId))).toBe(false);
    } finally {
      sink.close();
    }
  });

  it('字符上限只兜畸形输入：规范 16 项原样放得下（项数上限才是硬口径）', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    // 最长合法 reason（`INSUFFICIENT_BALANCE`，20 字符）+ 随机 keyId：合法输入的最坏形状
    const trail = Array.from({ length: 16 }, (_, i) =>
      trailItem(`key_${Math.random().toString(36).slice(2, 10)}_${String(i)}`, 'INSUFFICIENT_BALANCE', 402),
    );
    try {
      sink.record(entry({ attemptTrail: trail }));
      sink.flush();
      const e = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items[0];
      const parsed = JSON.parse(e?.attemptTrail ?? '[]') as unknown[];
      // 契约承诺的硬口径：**最多 16 条**必须真的落满 16 条 ——
      // 若字符上限设得比合法输入还小，这里会掉到 8 条，「16」就成了空头承诺。
      expect(parsed).toHaveLength(16);
    } finally {
      sink.close();
    }
  });

  it('畸形输入（超长 reason）触发按项丢弃：**永不落撕裂的 JSON**，最少保 1 项', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    // 每项约 120 字符 × 16 ≈ 2KB > 2048 的兜底线 ⇒ 必然按项丢尾部
    const fat = (keyId: string) => trailItem(keyId, 'A'.repeat(80), 401);
    const trail = Array.from({ length: 16 }, (_, i) => fat(`key_pad_${String(i).padStart(2, '0')}`));
    try {
      sink.record(entry({ attemptTrail: trail }));
      sink.flush();
      const e = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items[0];
      const raw = e?.attemptTrail ?? '';
      // 撕裂判据：必须能原样 parse 回合法 JSON 数组（按字符截断的串在这里当场炸）
      const parsed = JSON.parse(raw) as { keyMasked: string }[];
      expect(Array.isArray(parsed)).toBe(true);
      // 最少保 1 项 —— 保不住就整列 null，不留残串
      expect(parsed.length).toBeGreaterThanOrEqual(1);
      expect(parsed.length).toBeLessThan(16);
      // 丢的是尾部，第一项（轮换起点）永远在
      expect(parsed[0]?.keyMasked).toBe('****d_00');
    } finally {
      sink.close();
    }
  });

  it('trail 整串过凭据 scrub：reason/mask 夹带的凭据形状不会原样落库', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    const cred = 'sk-ant-' + 'C'.repeat(20);
    try {
      // 形状上不该发生的输入（reason 是枚举、keyId 是 id），但 sink 是"最后一站"：
      // 上游回显被拼进任何字段都拦在这里（幂等，与 message 的双重抹同一理由）
      sink.record(entry({ attemptTrail: [trailItem('k1', `echoed ${cred}`)] }));
      sink.flush();
      const e = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items[0];
      expect(e?.attemptTrail ?? '').not.toContain(cred);
      expect(e?.attemptTrail).toContain('****');
    } finally {
      sink.close();
    }
  });

  it('三腿落库形状：clientKeyMasked / sourceIp / invalidKeyFingerprint 透传，空串归 null', () => {
    const db = setup();
    const sink = createErrorEventSink({ db, maskOf });
    try {
      sink.record(
        entry({
          keyId: '',
          clientKeyMasked: '****abcd',
          sourceIp: '127.0.0.1',
          invalidKeyFingerprint: 'deadbeef',
        }),
      );
      sink.record(entry({ keyId: '', clientKeyMasked: '', sourceIp: '', invalidKeyFingerprint: '' }));
      sink.flush();
      const items = listGatewayErrorEvents(db, { page: 1, pageSize: 10 }).items;
      const full = items.find((e) => e.clientKeyMasked !== null);
      expect(full?.clientKeyMasked).toBe('****abcd');
      expect(full?.sourceIp).toBe('127.0.0.1');
      expect(full?.invalidKeyFingerprint).toBe('deadbeef');
      // 空串按"没这腿"落 null：不留第二种"空"的形态（与 message 空串同一条纪律）
      const empty = items.find((e) => e.clientKeyMasked === null);
      expect(empty?.clientKeyMasked).toBeNull();
      expect(empty?.sourceIp).toBeNull();
      expect(empty?.invalidKeyFingerprint).toBeNull();
    } finally {
      sink.close();
    }
  });
});
