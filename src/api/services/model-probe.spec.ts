// 能力探测（契约 §5 v1.11.0 / ADR-0024）。
//
// 钉的是"破了不会报错、只会让档案卡开始骗人"的那几处：
//   1. 判据表逐格（2xx true / 非 auth 的 4xx false / 401·403·404·429·5xx·超时·网络 null）；
//   2. 来源规则三条（manual 永不被覆盖、false 与 null 从不写库、last_probed_at 每次都刷）；
//   3. apply:false 一个字节都不写；
//   4. 同步尾部补探的候选口径与六计数（含 rate_limited 即停）；
//   5. 探测的凭据失败走**共享选择器换把**（ADR-0026）：换把成功就不该记 auth → null。
// 出站全部由注入的假 fetchImpl 承担，零真实网络。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../db/database.js';
import { sha256Hex } from '../../db/crypto.js';
import { createUpstream } from '../../db/repo/upstreams.js';
import { createKey } from '../../db/repo/keys.js';
import { getModelRow, updateModel, upsertModelFromSync } from '../../db/repo/models.js';
import type { TaskReporter } from '../task-runner.js';
import {
  ALL_PROBE_CAPABILITIES,
  chatCompletionsEndpoint,
  probeCandidatesAfterSync,
  probeModel,
} from './model-probe.js';
import { syncModels } from './model-sync.js';

const MASTER_KEY = Buffer.from('3b'.repeat(32), 'hex');
const BASE_URL = 'https://upstream.example.com';
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

function setup(): { db: Db; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'model-probe-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  return { db, close: () => db.close() };
}

/** 运行时拼装的假上游 key：源码里没有这个字面量（否则扫描器会命中自己）。 */
function probeSecret(tag: string): string {
  return ['sk', 'probe', sha256Hex(tag).slice(0, 40)].join('-');
}

function silentReporter(): TaskReporter {
  return { id: 'task_probe', setTotal: () => undefined, step: () => undefined, note: () => undefined };
}

/** 上游 + 一把已启用的 balance key：探测要有 key 才发得出去。 */
function seedUpstream(db: Db, name = 'probe-up'): string {
  const up = createUpstream(db, { name, baseUrl: BASE_URL });
  createKey(db, { upstreamId: up.id, key: probeSecret('k1'), category: 'balance' }, MASTER_KEY);
  return up.id;
}

/** 把第一把 key 绑到 active 账号台账（排序会把它提前，用于验换把顺序）。 */
function bindFirstKey(db: Db, upstreamId: string, keyId: string): void {
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO supplier_accounts (id, upstream_id, supplier, identifier, identifier_hash,
                                    encrypted_password, status, created_at, updated_at)
     VALUES (?, ?, 'tierflow', ?, ?, ?, 'active', ?, ?)`,
  ).run(`sa_${keyId}`, upstreamId, `id-${keyId}`, `hash-${keyId}`, Buffer.from('seed-cipher'), at, at);
  db.prepare(
    `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, created_at, updated_at)
     VALUES (?, ?, '****seed', ?, ?, ?)`,
  ).run(`sak_${keyId}`, `sa_${keyId}`, keyId, at, at);
}

function newModel(db: Db, upstreamId: string, name: string): string {
  return upsertModelFromSync(db, {
    upstreamId,
    name,
    displayName: null,
    type: 'chat',
    capabilities: [],
    contextLength: null,
    price: null,
  }).id;
}

/**
 * 从内置请求体**反推**在答哪一项能力（请求体由服务端内置，桩据此分派）。
 * 这本身也是一条断言：四项能力的探针形状互不相同，混了这里就分不出来。
 */
function detectCapability(body: Record<string, unknown>): string {
  const messages = body['messages'] as { content: unknown }[] | undefined;
  if (Array.isArray(messages?.[0]?.content)) return 'vision';
  if (body['response_format'] !== undefined) return 'json_mode';
  if (body['tools'] !== undefined) return 'function_call';
  if (body['stream'] === true) return 'stream';
  return 'plain';
}

interface StubOptions {
  /** 按能力给响应 */
  script: (capability: string) => { status: number; eventStream?: boolean };
  /** 命中这把明文时回 401（验换把） */
  rejectSecret?: string;
}

function probeFetch(opts: StubOptions): {
  fetchImpl: typeof fetch;
  calls: { capability: string; body: Record<string, unknown>; authorization: string }[];
} {
  const calls: { capability: string; body: Record<string, unknown>; authorization: string }[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const reqHeaders = (init?.headers ?? {}) as Record<string, string>;
    const authorization = reqHeaders['authorization'] ?? reqHeaders['Authorization'] ?? '';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const capability = detectCapability(body);
    calls.push({ capability, body, authorization });
    // 401 优先级最高：它是选择器要换把的信号（ADR-0026）
    if (opts.rejectSecret !== undefined && authorization.includes(opts.rejectSecret)) {
      return {
        status: 401,
        headers: new Headers(),
        ok: false,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }
    const r = opts.script(capability);
    const resHeaders = new Headers();
    resHeaders.set('content-type', r.eventStream === true ? 'text/event-stream; charset=utf-8' : 'application/json');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: resHeaders,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/* ------------------------------- 端点拼装 ------------------------------- */

describe('chatCompletionsEndpoint（与 modelsEndpoint 同一条 /v1 规则）', () => {
  it('baseUrl 自带 /v1 时不再拼第二次，不带则补一', () => {
    expect(chatCompletionsEndpoint('https://x.example/v1')).toBe('https://x.example/v1/chat/completions');
    expect(chatCompletionsEndpoint('https://x.example/v1/')).toBe('https://x.example/v1/chat/completions');
    expect(chatCompletionsEndpoint('https://x.example')).toBe('https://x.example/v1/chat/completions');
  });
});

/* -------------------------------- 判据表 -------------------------------- */

describe('判据表（能力专属请求 + 只看响应，不解析文案）', () => {
  it('四项各按其形状发探针：2xx=true、400=false+upstream_4xx、429=null+rate_limited', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const modelId = newModel(db, upstreamId, 'm-judge');
      const { fetchImpl, calls } = probeFetch({
        script: (cap) => {
          if (cap === 'stream') return { status: 200, eventStream: true };
          if (cap === 'vision') return { status: 200 };
          if (cap === 'function_call') return { status: 400 };
          return { status: 429 }; // json_mode
        },
      });

      const result = await probeModel(
        db,
        MASTER_KEY,
        { id: upstreamId, baseUrl: BASE_URL },
        { id: modelId, name: 'm-judge' },
        { targets: ALL_PROBE_CAPABILITIES, apply: false, fetchImpl },
      );
      const byCap = new Map(result.items.map((i) => [i.capability, i]));

      expect(byCap.get('stream')?.supported).toBe(true);
      expect(byCap.get('stream')?.reason).toBeNull();
      expect(byCap.get('vision')?.supported).toBe(true);
      // 契约示例逐字同形：400 ⇒ false + upstream_4xx（"不支持"是一态，不是"判不出"）
      expect(byCap.get('function_call')?.supported).toBe(false);
      expect(byCap.get('function_call')?.reason).toBe('upstream_4xx');
      expect(byCap.get('json_mode')?.supported).toBeNull();
      expect(byCap.get('json_mode')?.reason).toBe('rate_limited');

      expect(result.requests).toBe(4); // 每能力一发，一把 key 就够
      expect(result.applied).toEqual([]);
      expect(calls).toHaveLength(4);

      // 请求体服务端内置：max_tokens 压到最小，且四项探针形状互不相同
      for (const c of calls) expect(c.body['max_tokens']).toBe(16);
      expect(calls.find((c) => c.capability === 'stream')?.body['stream']).toBe(true);
      expect((calls.find((c) => c.capability === 'json_mode')?.body['response_format'] as { type: string }).type).toBe('json_object');
      expect(calls.find((c) => c.capability === 'function_call')?.body['tools']).toHaveLength(1);

      // vision 那发带**真图**（base64 PNG data URL，不是文本假图）
      const visionMessages = calls.find((c) => c.capability === 'vision')?.body['messages'] as
        | { content: { type: string; image_url?: { url: string } }[] }[]
        | undefined;
      const visionContent = visionMessages?.[0]?.content ?? [];
      const imageUrl = visionContent[1]?.image_url?.url ?? '';
      expect(imageUrl.startsWith('data:image/png;base64,')).toBe(true);
      expect(imageUrl.length).toBeGreaterThan(100);
    } finally {
      close();
    }
  });

  it('stream 的 true 判据是 content-type：2xx 但不是事件流 ⇒ false + not_event_stream', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const modelId = newModel(db, upstreamId, 'm-stream-ct');
      const { fetchImpl } = probeFetch({ script: () => ({ status: 200 }) }); // application/json
      const result = await probeModel(
        db,
        MASTER_KEY,
        { id: upstreamId, baseUrl: BASE_URL },
        { id: modelId, name: 'm-stream-ct' },
        { targets: ['stream'], apply: false, fetchImpl },
      );
      expect(result.items[0]?.supported).toBe(false);
      expect(result.items[0]?.reason).toBe('not_event_stream');
    } finally {
      close();
    }
  });

  it('404 / 5xx / 非法地址都判 null，不判 false（三态不能塌成两态）', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const modelId = newModel(db, upstreamId, 'm-null');
      const { fetchImpl } = probeFetch({
        script: (cap) => (cap === 'vision' ? { status: 404 } : { status: 503 }),
      });
      const result = await probeModel(
        db,
        MASTER_KEY,
        { id: upstreamId, baseUrl: BASE_URL },
        { id: modelId, name: 'm-null' },
        { targets: ['vision', 'json_mode'], apply: false, fetchImpl },
      );
      expect(result.items.find((i) => i.capability === 'vision')?.reason).toBe('not_found');
      expect(result.items.find((i) => i.capability === 'json_mode')?.reason).toBe('server_error');
      for (const item of result.items) expect(item.supported).toBeNull();

      // baseUrl 不合法（空串 = 路由层取不到上游时的形态）：按网络类记，不抛
      const bad = await probeModel(
        db,
        MASTER_KEY,
        { id: upstreamId, baseUrl: '' },
        { id: modelId, name: 'm-null' },
        { targets: ['stream'], apply: false, fetchImpl },
      );
      expect(bad.items[0]?.supported).toBeNull();
      expect(bad.items[0]?.reason).toBe('network');
    } finally {
      close();
    }
  });

  it('没有已启用 key：每项 null + reason:auth，且一个上游请求都不发', async () => {
    const { db, close } = setup();
    try {
      const up = createUpstream(db, { name: 'probe-nokey', baseUrl: BASE_URL });
      const { fetchImpl, calls } = probeFetch({ script: () => ({ status: 200, eventStream: true }) });
      const result = await probeModel(
        db,
        MASTER_KEY,
        { id: up.id, baseUrl: BASE_URL },
        { id: 'mdl_none', name: 'm-x' },
        { targets: ['stream', 'vision'], apply: false, fetchImpl },
      );
      expect(result.items).toHaveLength(2);
      for (const item of result.items) {
        expect(item.supported).toBeNull();
        expect(item.reason).toBe('auth');
      }
      expect(calls).toHaveLength(0);
      expect(result.requests).toBe(0);
    } finally {
      close();
    }
  });

  /**
   * ADR-0026 的联动钉：探测判据里 401/403 → null **依赖共享选择器先换把**。
   * 不换把的话，一把死首 key 会让整个探测面板全 null —— 那是"判不出"，不是"不支持"。
   */
  it('队首 key 上游侧失效（401）：换下一把拿到真结论，而不是记 auth', async () => {
    const { db, close } = setup();
    try {
      const up = createUpstream(db, { name: 'probe-rotate', baseUrl: BASE_URL });
      const dead = createKey(db, { upstreamId: up.id, key: probeSecret('dead'), category: 'balance' }, MASTER_KEY);
      createKey(db, { upstreamId: up.id, key: probeSecret('alive'), category: 'balance' }, MASTER_KEY);
      bindFirstKey(db, up.id, dead.id); // 死 key 有台账绑定 ⇒ 排序把它放队首
      const modelId = newModel(db, up.id, 'm-rot');

      const { fetchImpl, calls } = probeFetch({
        rejectSecret: probeSecret('dead'),
        script: () => ({ status: 200, eventStream: true }),
      });
      const result = await probeModel(
        db,
        MASTER_KEY,
        { id: up.id, baseUrl: BASE_URL },
        { id: modelId, name: 'm-rot' },
        { targets: ['stream'], apply: false, fetchImpl },
      );
      expect(result.items[0]?.supported).toBe(true); // 不是 null：换把成功了
      expect(calls).toHaveLength(2);
      expect(result.requests).toBe(2);
    } finally {
      close();
    }
  });
});

/* ------------------------------ 来源与落库 ------------------------------ */

describe('来源规则（manual 永不覆盖 / false·null 不写 / 时刻每次刷）', () => {
  it('apply:false 一个字节都不写：连 last_probed_at 都不刷（预览不留观测痕迹）', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const modelId = newModel(db, upstreamId, 'm-preview');
      const { fetchImpl } = probeFetch({ script: () => ({ status: 200, eventStream: true }) });
      await probeModel(
        db,
        MASTER_KEY,
        { id: upstreamId, baseUrl: BASE_URL },
        { id: modelId, name: 'm-preview' },
        { targets: ['stream'], apply: false, fetchImpl },
      );
      const row = getModelRow(db, modelId);
      expect(row?.capabilities).toBe('[]');
      expect(row?.capabilities_source ?? null).toBeNull();
      expect(row?.last_probed_at ?? null).toBeNull();
    } finally {
      close();
    }
  });

  it('apply:true 只把 true 项并进档案；source=probe、时刻刷、revision 不涨', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const modelId = newModel(db, upstreamId, 'm-apply');
      const { fetchImpl } = probeFetch({
        script: (cap) => (cap === 'vision' ? { status: 400 } : { status: 200, eventStream: true }),
      });
      const result = await probeModel(
        db,
        MASTER_KEY,
        { id: upstreamId, baseUrl: BASE_URL },
        { id: modelId, name: 'm-apply' },
        { targets: ['stream', 'vision'], apply: true, fetchImpl },
      );
      // stream 2xx + vision 400 ⇒ 只有 stream 进档案（false 从不写库）
      expect(result.applied).toEqual(['stream']);
      const row = getModelRow(db, modelId);
      expect(row?.capabilities).toBe('["stream"]');
      expect(row?.capabilities_source).toBe('probe');
      expect(row?.last_probed_at).not.toBeNull();
      // 探测不是人工编辑：revision 保持 1（不涨），change_log 由 capabilities 变化驱动
      expect(row?.revision).toBe(1);
    } finally {
      close();
    }
  });

  it('PATCH 过 capabilities 的 manual 行：探测一个字都不覆盖，但时刻照刷', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const modelId = newModel(db, upstreamId, 'm-manual');
      updateModel(db, modelId, { capabilities: ['json_mode'], revision: 1 });
      const before = getModelRow(db, modelId);
      expect(before?.capabilities_source).toBe('manual'); // 规则 1 的落点（另一例见 models repo spec）

      const { fetchImpl } = probeFetch({ script: () => ({ status: 200, eventStream: true }) });
      const result = await probeModel(
        db,
        MASTER_KEY,
        { id: upstreamId, baseUrl: BASE_URL },
        { id: modelId, name: 'm-manual' },
        { targets: ['stream'], apply: true, fetchImpl },
      );
      expect(result.applied).toEqual([]); // 被 manual 挡下 ⇒ applied 恒不含它
      const row = getModelRow(db, modelId);
      expect(row?.capabilities).toBe('["json_mode"]'); // 人工值原样
      expect(row?.capabilities_source).toBe('manual');
      expect(row?.last_probed_at).not.toBeNull(); // 规则 4：时刻每次刷，与覆盖无关
      expect(row?.revision).toBe(2); // 只有 PATCH 那一次涨过
    } finally {
      close();
    }
  });

  it('三态可分辨：[]+NULL=没问过 / []+probe=问过不支持 / 非空=有（apply:false 也不得把它刷成 probe）', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const modelId = newModel(db, upstreamId, 'm-tristate');

      // ① 没问过
      const row0 = getModelRow(db, modelId);
      expect(row0?.capabilities).toBe('[]');
      expect(row0?.capabilities_source ?? null).toBeNull();

      // ② 问过、全不支持 ⇒ 不写（[] + NULL 不变），只刷时刻
      const { fetchImpl: f4xx } = probeFetch({ script: () => ({ status: 400 }) });
      await probeModel(db, MASTER_KEY, { id: upstreamId, baseUrl: BASE_URL }, { id: modelId, name: 'm-tristate' }, {
        targets: ['stream'],
        apply: true,
        fetchImpl: f4xx,
      });
      const row1 = getModelRow(db, modelId);
      expect(row1?.capabilities).toBe('[]');
      // 探测跑过但没有任何可写项：source 由 applyProbeCapabilities 置 probe（"问过"这个事实要留下）
      expect(row1?.capabilities_source).toBe('probe');
      expect(row1?.last_probed_at).not.toBeNull();
    } finally {
      close();
    }
  });
});

/* ---------------------------- 同步尾部补探 ---------------------------- */

describe('同步尾部补探（候选口径 / limit / 预算拒绝即停 / 不改任务成败）', () => {
  it('候选 = 给定 id 里 capabilities_source IS NULL 的；已探测过的不重复烧', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const a = newModel(db, upstreamId, 'm-a');
      const b = newModel(db, upstreamId, 'm-b');

      // b 先探一次（写进 probe）⇒ 之后不进候选
      const { fetchImpl: f0 } = probeFetch({ script: () => ({ status: 200, eventStream: true }) });
      await probeModel(db, MASTER_KEY, { id: upstreamId, baseUrl: BASE_URL }, { id: b, name: 'm-b' }, {
        targets: ['stream'],
        apply: true,
        fetchImpl: f0,
      });

      const { fetchImpl } = probeFetch({ script: () => ({ status: 200, eventStream: true }) });
      const counters = await probeCandidatesAfterSync(
        db,
        MASTER_KEY,
        { id: upstreamId, baseUrl: BASE_URL },
        [a, b],
        { limit: 10, fetchImpl },
      );
      expect(counters.candidates).toBe(1); // 只有 a
      expect(counters.probed).toBe(1);
      expect(counters.applied).toBeGreaterThan(0);
      expect(counters.requests).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it('limit 截断：本轮只探 limit 个，其余留到下一轮（candidates 只数真进候选的）', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const ids = [newModel(db, upstreamId, 'm-1'), newModel(db, upstreamId, 'm-2'), newModel(db, upstreamId, 'm-3')];
      const { fetchImpl, calls } = probeFetch({ script: () => ({ status: 200, eventStream: true }) });
      const counters = await probeCandidatesAfterSync(
        db,
        MASTER_KEY,
        { id: upstreamId, baseUrl: BASE_URL },
        ids,
        { limit: 1, fetchImpl },
      );
      expect(counters.candidates).toBe(1);
      expect(counters.probed).toBe(1);
      expect(calls.length).toBeLessThanOrEqual(ALL_PROBE_CAPABILITIES.length); // 只探了一个模型
    } finally {
      close();
    }
  });

  it('出口预算拒绝（rate_limited）即停：剩余候选计入 skipped', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const a = newModel(db, upstreamId, 'm-r1');
      const b = newModel(db, upstreamId, 'm-r2');
      const c = newModel(db, upstreamId, 'm-r3');
      // a 的第一项就 429 ⇒ 该模型探完即停，b/c 留到下一轮
      const { fetchImpl } = probeFetch({ script: () => ({ status: 429 }) });
      const counters = await probeCandidatesAfterSync(
        db,
        MASTER_KEY,
        { id: upstreamId, baseUrl: BASE_URL },
        [a, b, c],
        { limit: 10, fetchImpl },
      );
      expect(counters.candidates).toBe(3);
      expect(counters.probed).toBe(1);
      expect(counters.skipped).toBe(2);
      expect(counters.applied).toBe(0); // 429 判不出，不写库
    } finally {
      close();
    }
  });

  it('端到端：syncModels 带 probeOptions 时 result.probe 有六计数；关闸时不带该字段', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      const listFetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ object: 'list', data: [{ id: 'm-sync-1' }, { id: 'm-sync-2' }] }),
      })) as unknown as typeof fetch;

      const summary = await syncModels(db, MASTER_KEY, upstreamId, silentReporter(), listFetch, undefined, {
        enabled: true,
        limit: 10,
      });
      expect(summary.inserted).toBe(2);
      expect(summary.probe).toMatchObject({ candidates: 2, probed: 2, failed: 0 });

      // 关闸（MODEL_PROBE_ENABLED=false 或请求体 {probe:false}）：字段**省略**，不是六枚 0
      const off = await syncModels(db, MASTER_KEY, upstreamId, silentReporter(), listFetch, undefined, {
        enabled: false,
        limit: 10,
      });
      expect(off.probe).toBeUndefined();
    } finally {
      close();
    }
  });
});
