// `gateway_error_events` 仓储（契约 §12.1 / ADR-0013）。
//
// 只追加、不修改；查询面只读。这里钉住的是四条容易被"顺手改坏"的口径：
//   1. `keyMasked` 的三态：`null`（与某把 key 无关）/ `****后4位` / 兜底 `****`（认不出哪把）；
//   2. 分型多值过滤只拼占位符、值全走绑定参数（列表是用户输入）；
//   3. 同毫秒事件的翻页**不重不漏** —— 一次上游抖动会同时打掉一批请求，
//      同 ts 是常态，只按 ts 排序的第二页会重复或漏记录；
//   4. `byCategory` 不补 0：只列出现过的分型。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../database.js';
import {
  CLIENT_ABORTED_STATUS,
  appendGatewayErrorEvent,
  appendGatewayErrorEvents,
  getGatewayErrorEvent,
  listGatewayErrorEvents,
  pruneGatewayErrorEvents,
  summarizeErrorEvents,
  type GatewayErrorEventInput,
} from './gateway-events.js';
import type { GatewayErrorCategory } from '../../api/dto.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'errepo-probe-'));
  dirs.push(dir);
  return openDatabase({ path: join(dir, 'gateway.db') });
}

function input(over: Partial<GatewayErrorEventInput> = {}): GatewayErrorEventInput {
  return {
    ts: '2026-10-06T00:00:00.000Z',
    severity: 'error',
    category: 'UPSTREAM_ERROR',
    status: 502,
    gatewayCode: 'UPSTREAM_ERROR',
    failureReason: 'UPSTREAM_ERROR',
    endpoint: '/v1/chat/completions',
    model: 'gpt-probe',
    upstreamId: 'up_probe',
    keyId: 'key_probe',
    keyMasked: '****robe',
    stream: false,
    upstreamStatus: 502,
    attempts: 1,
    candidates: 2,
    latencyMs: 12,
    message: 'upstream 502',
    ...over,
  };
}

const LIST = { page: 1, pageSize: 50 } as const;

describe('写入与读取', () => {
  it('roundtrip：字段逐项对得上，且在 json 里形状符合契约（bool 不是 0/1）', () => {
    const db = setup();
    const id = appendGatewayErrorEvent(db, input({ stream: true }));
    expect(id.startsWith('err_')).toBe(true);

    const e = getGatewayErrorEvent(db, id);
    expect(e).not.toBeNull();
    expect(e?.ts).toBe('2026-10-06T00:00:00.000Z');
    expect(e?.severity).toBe('error');
    expect(e?.category).toBe('UPSTREAM_ERROR');
    expect(e?.status).toBe(502);
    expect(e?.stream).toBe(true);
    expect(e?.attempts).toBe(1);
    expect(e?.latencyMs).toBe(12);
    expect(typeof e?.stream).toBe('boolean');
  });

  it('未知 id → null（路由层转 404，不在这里抛）', () => {
    const db = setup();
    expect(getGatewayErrorEvent(db, 'err_nope')).toBeNull();
  });

  it('keyMasked：空串按"认不出哪把"落 ****；显式 null 保留 null', () => {
    const db = setup();
    appendGatewayErrorEvent(db, input({ keyMasked: '', message: 'a' }));
    appendGatewayErrorEvent(db, input({ keyMasked: null, keyId: null, message: 'b' }));
    const items = listGatewayErrorEvents(db, LIST).items;
    expect(items.find((e) => e.message === 'a')?.keyMasked).toBe('****');
    expect(items.find((e) => e.message === 'b')?.keyMasked).toBeNull();
  });

  it('499 是事件流专有的状态码，不对应任何真实响应', () => {
    expect(CLIENT_ABORTED_STATUS).toBe(499);
  });

  it('批量写入：条数一致，空数组是 0（不建事务）', () => {
    const db = setup();
    expect(appendGatewayErrorEvents(db, [])).toBe(0);
    expect(appendGatewayErrorEvents(db, [input(), input(), input()])).toBe(3);
    expect(listGatewayErrorEvents(db, LIST).total).toBe(3);
  });
});

describe('查询过滤', () => {
  function seed(db: Db): void {
    appendGatewayErrorEvent(db, input({ ts: '2026-10-06T01:00:00.000Z', category: 'AUTH_FAILED', severity: 'warn', upstreamId: 'up_a', model: 'm1', status: 401, gatewayCode: 'INVALID_API_KEY' }));
    appendGatewayErrorEvent(db, input({ ts: '2026-10-06T02:00:00.000Z', category: 'RATE_LIMITED', severity: 'warn', upstreamId: 'up_a', model: 'm1', status: 429, gatewayCode: 'RATE_LIMITED' }));
    appendGatewayErrorEvent(db, input({ ts: '2026-10-06T03:00:00.000Z', category: 'UPSTREAM_ERROR', severity: 'error', upstreamId: 'up_b', model: 'm2', status: 502 }));
    appendGatewayErrorEvent(db, input({ ts: '2026-10-06T04:00:00.000Z', category: 'NO_AVAILABLE_KEY', severity: 'error', upstreamId: null, model: 'm2', status: 503 }));
  }

  it('时间窗是闭区间 [from, to]', () => {
    const db = setup();
    seed(db);
    const all = listGatewayErrorEvents(db, LIST);
    expect(all.total).toBe(4);
    const win = listGatewayErrorEvents(db, { ...LIST, from: '2026-10-06T02:00:00.000Z', to: '2026-10-06T03:00:00.000Z' });
    expect(win.total).toBe(2);
  });

  it('分型多值：IN 展开，值全部走绑定参数', () => {
    const db = setup();
    seed(db);
    const one = listGatewayErrorEvents(db, { ...LIST, categories: ['UPSTREAM_ERROR'] });
    expect(one.total).toBe(1);
    const two = listGatewayErrorEvents(db, { ...LIST, categories: ['UPSTREAM_ERROR', 'NO_AVAILABLE_KEY'] });
    expect(two.total).toBe(2);
    // 单引号注入尝试：只应被当作"不认识的分型"查不到任何行，绝不改变 SQL 结构。
    // 刻意 `as` 掉类型：路由层会先把分型过滤白名单，这里要测的恰恰是"白名单万一漏了"
    // 时仓储层自己站得住 —— 值永远走绑定参数，拼进 SQL 的只有占位符。
    const hostile = "UPSTREAM_ERROR') OR 1=1 --" as GatewayErrorCategory;
    const inj = listGatewayErrorEvents(db, { ...LIST, categories: [hostile] });
    expect(inj.total).toBe(0);
    expect(listGatewayErrorEvents(db, LIST).total).toBe(4);
  });

  it('severity / upstreamId / model 过滤', () => {
    const db = setup();
    seed(db);
    expect(listGatewayErrorEvents(db, { ...LIST, severity: 'error' }).total).toBe(2);
    expect(listGatewayErrorEvents(db, { ...LIST, severity: 'warn' }).total).toBe(2);
    expect(listGatewayErrorEvents(db, { ...LIST, upstreamId: 'up_a' }).total).toBe(2);
    expect(listGatewayErrorEvents(db, { ...LIST, model: 'm2' }).total).toBe(2);
  });

  it('翻页：同毫秒（同 ts）的事件不重不漏', () => {
    const db = setup();
    const ids = [
      appendGatewayErrorEvent(db, input({ ts: '2026-10-06T05:00:00.000Z', message: '1' })),
      appendGatewayErrorEvent(db, input({ ts: '2026-10-06T05:00:00.000Z', message: '2' })),
      appendGatewayErrorEvent(db, input({ ts: '2026-10-06T05:00:00.000Z', message: '3' })),
    ];
    const p1 = listGatewayErrorEvents(db, { page: 1, pageSize: 2 });
    const p2 = listGatewayErrorEvents(db, { page: 2, pageSize: 2 });
    expect(p1.total).toBe(3);
    expect(p2.total).toBe(3);
    const seen = [...p1.items, ...p2.items].map((e) => e.id);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual([...ids].sort());
  });
});

describe('分型计数与保留期', () => {
  it('byCategory：按出现过的分型计数，不补 0；total 等于各行之和', () => {
    const db = setup();
    appendGatewayErrorEvent(db, input({ ts: '2026-10-06T01:00:00.000Z', category: 'UPSTREAM_ERROR', message: '1' }));
    appendGatewayErrorEvent(db, input({ ts: '2026-10-06T02:00:00.000Z', category: 'UPSTREAM_ERROR', message: '2' }));
    appendGatewayErrorEvent(db, input({ ts: '2026-10-06T03:00:00.000Z', category: 'AUTH_FAILED', severity: 'warn', message: '3' }));

    const s = summarizeErrorEvents(db, '2026-10-05T00:00:00.000Z', '2026-10-07T00:00:00.000Z');
    expect(s.total).toBe(3);
    expect(s.byCategory.map((r) => r.category)).toEqual(['UPSTREAM_ERROR', 'AUTH_FAILED']);
    expect(s.byCategory[0]?.count).toBe(2);
    // 没出现过的分型不占位（"一次都没发生过"本身是信息）
    expect(s.byCategory.some((r) => r.category === 'INTERNAL')).toBe(false);
    // lastAt 是窗口内该分型最近一条的时刻
    expect(s.byCategory[0]?.lastAt).toBe('2026-10-06T02:00:00.000Z');
  });

  it('窗口外的行不计入', () => {
    const db = setup();
    appendGatewayErrorEvent(db, input({ ts: '2026-09-01T00:00:00.000Z' }));
    const s = summarizeErrorEvents(db, '2026-10-05T00:00:00.000Z', '2026-10-07T00:00:00.000Z');
    expect(s.total).toBe(0);
    expect(s.byCategory).toEqual([]);
  });

  it('prune 按保留期整批删，边界（恰好等于 cutoff）保留', () => {
    const db = setup();
    const now = new Date('2026-10-06T00:00:00.000Z');
    const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    appendGatewayErrorEvent(db, input({ ts: cutoff }));
    appendGatewayErrorEvent(db, input({ ts: '2026-09-01T00:00:00.000Z' }));
    expect(pruneGatewayErrorEvents(db, 30, now)).toBe(1);
    expect(listGatewayErrorEvents(db, LIST).items[0]?.ts).toBe(cutoff);
  });
});

describe('落盘前脱敏（仓储层兜底）', () => {
  it('message 经过 scrubMessage：换行压平、凭据抹掉', () => {
    const db = setup();
    const cred = 'sk-probe-' + 'C'.repeat(24);
    appendGatewayErrorEvent(db, input({ message: `line1\nline2 key=${cred}` }));
    const e = listGatewayErrorEvents(db, LIST).items[0];
    expect(e?.message ?? '').not.toContain(cred);
    expect(e?.message ?? '').not.toContain('\n');
    expect(e?.message ?? '').toContain('line1 line2');
  });

  it('纯空白 message 落 null，不留空串这种第二形态的"空"', () => {
    const db = setup();
    appendGatewayErrorEvent(db, input({ message: '   ' }));
    expect(listGatewayErrorEvents(db, LIST).items[0]?.message).toBeNull();
  });
});
