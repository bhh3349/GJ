// key 探活（契约 §3 v1.24.0 / ADR-0049）。
//
// 钉的是"破了不报错、只会骗人"的那几处：
//   1. 判据表逐格（2xx+choices ok / 200+success:false 也算 fail / 401·403 AUTH / 402·quota QUOTA /
//      429 分频率与额度 / 404·400·422 MODEL / 超时 / 网络 / 空响应）；
//   2. 计量隔离四条里的可测三条：零 usage_logs、key 行一字不动（revision / updated_at）、
//      key_runtime 不产生行（reportSuccess/reportFailure 一个都不能被调用）；
//   3. 模型解析三段（点名须在白名单内 → 白名单第一条 → 都没有就退化探 /v1/models）；
//   4. 频控：同 key 10s 一次（TOO_MANY_ATTEMPTS + retryAfterSeconds），且**绝不换把** ——
//      401 就是这把 key 的结论，不是换一把再试的理由；
//   5. 明文纪律：上游把 key 回显在报错文案或 `error.code` 里，出口前必须被 sanitize 抹掉。
// 出站全部由注入的假 fetchImpl 承担，零真实网络。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, type Db } from '../../db/database.js';
import { sha256Hex } from '../../db/crypto.js';
import { createUpstream } from '../../db/repo/upstreams.js';
import { createKey } from '../../db/repo/keys.js';
import { ApiError } from '../errors.js';
import { probeKey, probeCooldownMs, probeKeyOnce, AUTO_PROBE_AUDITOR } from './key-probe.js';

const MASTER_KEY = Buffer.from('3b'.repeat(32), 'hex');
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* 临时目录删不掉不影响判据 */
    }
  }
  vi.restoreAllMocks();
});

function setup(): { db: Db } {
  const dir = mkdtempSync(join(tmpdir(), 'key-probe-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  return { db };
}

/** 运行时拼装的假上游 key：源码里没有 sk- 字面量（否则扫描器会命中自己）。 */
function probeSecret(tag: string): string {
  return ['sk', 'probe', sha256Hex(tag).slice(0, 40)].join('-');
}

function seedKey(db: Db, tag: string, withWhitelist = false): string {
  const up = createUpstream(db, { name: `up-${tag}`, baseUrl: 'https://up.example.com' });
  const key = createKey(db, { upstreamId: up.id, key: probeSecret(tag), category: 'balance' }, MASTER_KEY);
  if (withWhitelist) {
    db.prepare('UPDATE upstream_keys SET model_limits = ? WHERE id = ?').run('alpha-model,beta-model', key.id);
  }
  return key.id;
}

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 记录出站的探活假 fetch：URL / 方法 / 次数都要断言。 */
function fakeFetch(responses: Response[]): { fetch: typeof fetch; calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const stub = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    const next = responses.shift();
    if (next === undefined) throw new Error('假 fetch 的应答被用光了');
    return next;
  }) as unknown as typeof fetch;
  return { fetch: stub, calls };
}

function snapshotKey(db: Db, keyId: string): { revision: number; updated_at: string; first_used_at: string | null } {
  return db.prepare('SELECT revision, updated_at, first_used_at FROM upstream_keys WHERE id = ?').get(keyId) as {
    revision: number;
    updated_at: string;
    first_used_at: string | null;
  };
}

describe('判据表（成功与各失败格）', () => {
  it('chat 200 + choices → ok；模型取白名单第一条；key 行一字不动、零 usage_logs、零 key_runtime', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'ok', true);
    const before = snapshotKey(db, keyId);
    const { fetch, calls } = fakeFetch([jsonRes(200, { choices: [{ message: { role: 'assistant', content: 'ok' } }] })]);

    const result = await probeKey(db, keyId, MASTER_KEY, fetch);

    expect(result.ok).toBe(true);
    expect(result.kind).toBe('chat');
    expect(result.model).toBe('alpha-model');
    expect(result.probeCode).toBeNull();
    expect(result.httpStatus).toBe(200);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://up.example.com/v1/chat/completions');

    // 计量隔离（可测三条）：探活是纯观测
    const after = snapshotKey(db, keyId);
    expect(after.revision).toBe(before.revision);
    expect(after.updated_at).toBe(before.updated_at);
    expect(after.first_used_at).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM key_runtime').get() as { n: number }).n).toBe(0);
  });

  it('401/403 → AUTH_REJECTED，且只发一次请求：探活测的是这一把，绝不换把', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'auth');
    const { fetch, calls } = fakeFetch([jsonRes(401, { error: { message: 'invalid api key', code: 'invalid_api_key' } })]);

    const result = await probeKey(db, keyId, MASTER_KEY, fetch);

    expect(result.ok).toBe(false);
    expect(result.probeCode).toBe('AUTH_REJECTED');
    expect(result.upstreamErrorCode).toBe('invalid_api_key');
    expect(result.httpStatus).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it('200 + success:false 信封也算 fail（与数据面 §16.2 同口径）', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'envelope');
    const { fetch } = fakeFetch([
      jsonRes(200, { success: false, message: 'insufficient quota', code: 'insufficient_quota' }),
    ]);

    const result = await probeKey(db, keyId, MASTER_KEY, fetch);

    expect(result.ok).toBe(false);
    expect(result.probeCode).toBe('UPSTREAM_ERROR');
    expect(result.upstreamErrorCode).toBe('insufficient_quota');
  });

  it('429 分两格：insufficient_quota → QUOTA_EXHAUSTED；普通限频 → RATE_LIMITED', async () => {
    const { db } = setup();
    const quotaKey = seedKey(db, 'quota429');
    const { fetch: quotaFetch } = fakeFetch([
      jsonRes(429, { error: { code: 'insufficient_quota', message: 'quota exceeded' } }),
    ]);
    const quota = await probeKey(db, quotaKey, MASTER_KEY, quotaFetch);
    expect(quota.probeCode).toBe('QUOTA_EXHAUSTED');

    const rateKey = seedKey(db, 'rate429');
    const { fetch: rateFetch } = fakeFetch([jsonRes(429, { error: { code: 'rate_limit', message: 'too many' } })]);
    const rate = await probeKey(db, rateKey, MASTER_KEY, rateFetch);
    expect(rate.probeCode).toBe('RATE_LIMITED');
  });

  it('404 / 400 → MODEL_REJECTED；5xx → UPSTREAM_ERROR；空响应 → EMPTY_RESPONSE', async () => {
    const { db } = setup();
    const notFoundKey = seedKey(db, 'm404');
    const notFound = await probeKey(
      db,
      notFoundKey,
      MASTER_KEY,
      fakeFetch([jsonRes(404, { error: { message: 'model not found' } })]).fetch,
    );
    expect(notFound.probeCode).toBe('MODEL_REJECTED');

    const serverKey = seedKey(db, 'm500');
    const server = await probeKey(db, serverKey, MASTER_KEY, fakeFetch([jsonRes(500, { error: {} })]).fetch);
    expect(server.probeCode).toBe('UPSTREAM_ERROR');

    const emptyKey = seedKey(db, 'mempty');
    const empty = await probeKey(db, emptyKey, MASTER_KEY, fakeFetch([jsonRes(200, { object: 'list' })]).fetch);
    expect(empty.ok).toBe(false);
    expect(empty.probeCode).toBe('EMPTY_RESPONSE');
  });

  it('网络拒绝 → UPSTREAM_UNREACHABLE；中断（AbortError）→ TIMEOUT', async () => {
    const { db } = setup();
    const netKey = seedKey(db, 'net');
    const net = await probeKey(
      db,
      netKey,
      MASTER_KEY,
      (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    );
    expect(net.probeCode).toBe('UPSTREAM_UNREACHABLE');
    expect(net.httpStatus).toBeNull();

    const abortKey = seedKey(db, 'abort');
    const abort = await probeKey(
      db,
      abortKey,
      MASTER_KEY,
      (async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }) as unknown as typeof fetch,
    );
    expect(abort.probeCode).toBe('TIMEOUT');
  });
});

describe('模型解析三段', () => {
  it('点名不在白名单 → 400 INVALID_PARAM（details.field=model）', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'wlcheck', true);
    await expect(probeKey(db, keyId, MASTER_KEY, fakeFetch([]).fetch, { model: 'not-allowed' })).rejects.toMatchObject({
      code: 'INVALID_PARAM',
      details: { field: 'model' },
    });
  });

  it('无白名单且未点名 → 退化为 /v1/models 探活（GET、零 token、data 数组即 ok）', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'models');
    const { fetch, calls } = fakeFetch([jsonRes(200, { object: 'list', data: [{ id: 'm1' }, { id: 'm2' }] })]);

    const result = await probeKey(db, keyId, MASTER_KEY, fetch);

    expect(result.kind).toBe('models');
    expect(result.model).toBeNull();
    expect(result.ok).toBe(true);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toBe('https://up.example.com/v1/models');
  });

  it('key 或上游不存在 → 404', async () => {
    const { db } = setup();
    await expect(probeKey(db, 'key_ghost', MASTER_KEY, fakeFetch([]).fetch)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('频控与明文纪律', () => {
  it('同一把 key 10 秒内第二次 → TOO_MANY_ATTEMPTS + retryAfterSeconds；推进时钟后可再探', async () => {
    // 只 mock Date.now：vi.useFakeTimers 会连 undici 的 body 读取一起冻住（`.json()` 直接抛，被吞成空响应）
    let now = Date.parse('2026-11-03T02:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { db } = setup();
    const keyId = seedKey(db, 'cooldown');
    const { fetch } = fakeFetch([jsonRes(200, { object: 'list', data: [{ id: 'm1' }] })]);

    await probeKey(db, keyId, MASTER_KEY, fetch);
    expect(probeCooldownMs(keyId)).toBeGreaterThan(0);

    await expect(probeKey(db, keyId, MASTER_KEY, fetch)).rejects.toMatchObject({
      code: 'TOO_MANY_ATTEMPTS',
      details: { retryAfterSeconds: expect.any(Number) },
    });

    now += 11_000;
    expect(probeCooldownMs(keyId)).toBe(0);

    const second = fakeFetch([jsonRes(200, { object: 'list', data: [{ id: 'm1' }] })]);
    const again = await probeKey(db, keyId, MASTER_KEY, second.fetch);
    expect(again.ok).toBe(true);
    clock.mockRestore();
  });

  it('上游把 key 明文回显进报错文案：出口前必须被 sanitize 抹掉', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'leak');
    const secret = probeSecret('leak');
    const { fetch } = fakeFetch([jsonRes(401, { error: { message: `invalid api key: ${secret}` } })]);

    const result = await probeKey(db, keyId, MASTER_KEY, fetch);

    expect(result.ok).toBe(false);
    expect(result.upstreamMessage).not.toBeNull();
    expect(result.upstreamMessage).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('上游把 key 明文回显进 error.code：code 同样必须被 sanitize 抹掉（零明文是红线不是概率题）', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'leakcode');
    const secret = probeSecret('leakcode');
    const { fetch } = fakeFetch([jsonRes(401, { error: { code: `echo_${secret}`, message: 'invalid api key' } })]);

    const result = await probeKey(db, keyId, MASTER_KEY, fetch);

    expect(result.probeCode).toBe('AUTH_REJECTED');
    expect(result.upstreamErrorCode).not.toBeNull();
    expect(result.upstreamErrorCode).not.toContain(secret);
    expect(result.upstreamErrorCode).toContain('****');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('别的 key 刚探过不影响这一把（频控按 key 分桶，全局并发上限只是手抖保险）', async () => {
    const { db } = setup();
    const keyA = seedKey(db, 'bucketA');
    const keyB = seedKey(db, 'bucketB');
    const a = fakeFetch([jsonRes(200, { object: 'list', data: [{ id: 'm1' }] })]);
    await probeKey(db, keyA, MASTER_KEY, a.fetch);

    const b = fakeFetch([jsonRes(200, { object: 'list', data: [{ id: 'm2' }] })]);
    const result = await probeKey(db, keyB, MASTER_KEY, b.fetch);
    expect(result.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 建 key 首调保活（ADR-0050）：fire-and-forget，结论只落一条审计        */
/* ------------------------------------------------------------------ */

interface AutoProbeAuditRow {
  actor: string;
  ip: string;
  action: string;
  result: string;
  detail: string;
}

/** 等那条自动首调审计落库。fire-and-forget 没有返回值，只能从库里看它落没落。 */
async function waitForAutoProbeAudit(db: Db, keyId: string, deadlineMs = 1_000): Promise<AutoProbeAuditRow> {
  const started = Date.now();
  for (;;) {
    const row = db
      .prepare("SELECT actor, ip, action, result, detail FROM audit_log WHERE action = 'key.probe' AND target_id = ?")
      .get(keyId) as AutoProbeAuditRow | undefined;
    if (row !== undefined) return row;
    if (Date.now() - started > deadlineMs) throw new Error('自动首调的审计 1s 内没有落库');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('probeKeyOnce（建 key 首调保活）', () => {
  it('ok 腿：落一条 auto=1 的 key.probe；零 usage_logs、first_used_at 不写、key 行一字不动', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'auto-ok');
    const before = snapshotKey(db, keyId);
    const { fetch, calls } = fakeFetch([jsonRes(200, { object: 'list', data: [{ id: 'm1' }] })]);

    probeKeyOnce(db, keyId, MASTER_KEY, fetch, { actor: 'admin-9', ip: '10.0.0.9' });
    const row = await waitForAutoProbeAudit(db, keyId);

    expect(row.action).toBe('key.probe');
    expect(row.result).toBe('ok');
    expect(row.detail).toContain('auto=1');
    expect(row.detail).toContain('kind=models');
    expect(row.detail).toContain('ok=1');
    // 调用者身份原样落库：手动建 key 记的是点按钮的那个人
    expect(row.actor).toBe('admin-9');
    expect(row.ip).toBe('10.0.0.9');
    expect(row.detail).not.toContain('sk-');

    expect(calls).toHaveLength(1);
    // 口径隔离：首调是**管理面动作**，不是客户流量 —— 首调时刻不许写进 first_used_at
    const after = snapshotKey(db, keyId);
    expect(after.first_used_at).toBeNull();
    expect(after.revision).toBe(before.revision);
    expect(after.updated_at).toBe(before.updated_at);
    expect((db.prepare('SELECT COUNT(*) AS n FROM usage_logs').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM key_runtime').get() as { n: number }).n).toBe(0);
  });

  it('fail 腿：上游 401 → result=fail、错码进 detail（不落上游 body 原文）', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'auto-auth');
    const { fetch } = fakeFetch([jsonRes(401, { error: { message: 'invalid api key', code: 'invalid_api_key' } })]);

    probeKeyOnce(db, keyId, MASTER_KEY, fetch, AUTO_PROBE_AUDITOR);
    const row = await waitForAutoProbeAudit(db, keyId);

    expect(row.result).toBe('fail');
    expect(row.detail).toContain('auto=1');
    expect(row.detail).toContain('ok=0');
    expect(row.detail).toContain('code=AUTH_REJECTED');
    expect(row.actor).toBe('system');
  });

  it('没打出去也留痕：上游连不上（fetch 直接抛）→ code=SKIPPED 的 fail 审计，而不是无声无息', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'auto-offline');
    const thrower = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    probeKeyOnce(db, keyId, MASTER_KEY, thrower, AUTO_PROBE_AUDITOR);
    const row = await waitForAutoProbeAudit(db, keyId);

    // 连不上上游属于"探活跑完了但结论是 fail"，不是"没跑"：走的是正常 fail 腿
    expect(row.result).toBe('fail');
    expect(row.detail).toContain('code=UPSTREAM_UNREACHABLE');
  });

  it('没打出去也留痕：频控挡下的自动首调 → code=SKIPPED 的 fail 审计（10s 频控是共享的）', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'auto-rate');
    const f = fakeFetch([jsonRes(200, { object: 'list', data: [{ id: 'm1' }] })]);

    probeKeyOnce(db, keyId, MASTER_KEY, f.fetch, AUTO_PROBE_AUDITOR);
    await waitForAutoProbeAudit(db, keyId);

    // 同一把 key 立刻再触发一次（比如同一批里重复回调）：被 10s 频控挡下 ——
    // 这正是「就一次」的字面执行，但必须在审计里留痕，而不是无声无息地消失。
    probeKeyOnce(db, keyId, MASTER_KEY, f.fetch, AUTO_PROBE_AUDITOR);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = db
      .prepare("SELECT result, detail FROM audit_log WHERE action = 'key.probe' AND target_id = ? ORDER BY ts")
      .all(keyId) as { result: string; detail: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.detail).toContain('ok=1');
    expect(rows[1]!.detail).toContain('code=SKIPPED');
    expect(rows[1]!.result).toBe('fail');
    // 自动首调总共只打了一次上游
    expect(f.calls).toHaveLength(1);
  });

  it('绝不抛：库已关（进程收尾 / 用例清理）时也不产生无人接管的 rejection', async () => {
    const { db } = setup();
    const keyId = seedKey(db, 'auto-closed');
    const { fetch } = fakeFetch([jsonRes(200, { object: 'list', data: [{ id: 'm1' }] })]);
    db.close();

    // 若有未接管的 rejection，vitest 会让本用例红 —— 这条用例的全部价值就在这里
    probeKeyOnce(db, keyId, MASTER_KEY, fetch, AUTO_PROBE_AUDITOR);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});
