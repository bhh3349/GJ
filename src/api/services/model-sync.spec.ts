// 模型同步的字段映射（契约 §5 补遗 v1.0.2 / ADR-0009）。
//
// 这里测的不是"同步能不能跑通"，而是**两条一旦破了就会静默出错的口径**：
//   1. 上游没给的字段一律留空 —— 建档不许编造 capabilities / price / contextLength；
//   2. 未知不覆盖已知 —— 重同步不许把管理员 PATCH 过的人工值抹回 null。
//
// 第 2 条是本次修掉的真实缺陷：初版更新分支无条件写 `capabilities='[]'`、
// `price=null`，于是"PATCH 补好价格 → 再同步一次 → 价格没了"，而且前端只会显示 `—`，
// 没人知道那里曾经有过一个正确的数字。判据因此**不是**"同步返回成功"，
// 而是"重同步之后逐字段比对，人工值还在，且 revision 没涨"。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../db/database.js';
import { sha256Hex } from '../../db/crypto.js';
import { createUpstream } from '../../db/repo/upstreams.js';
import { createKey, decryptedKeyRefs } from '../../db/repo/keys.js';
import { getModelRow, listModels, updateModel } from '../../db/repo/models.js';
import type { TaskReporter } from '../task-runner.js';
import { inferModelType, syncModels } from './model-sync.js';
import { pickCredentialKeyIds, tryWithRotation } from './credential-rotation.js';

/** 运行时拼装的假上游 key：形状像真的，但源码里没有这个字面量（否则扫描器会命中自己）。 */
function probeSecret(): string {
  return ['sk', 'syncprobe', sha256Hex('model-sync-spec-probe').slice(0, 40)].join('-');
}

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
});

/** 内存里记账的 reporter：同步只要求它别抛。 */
function silentReporter(): TaskReporter {
  return { id: 'task_probe', setTotal: () => undefined, step: () => undefined, note: () => undefined };
}

/** 只回模型列表的假上游。 */
function fakeModelsFetch(names: string[]): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ object: 'list', data: names.map((id) => ({ id, object: 'model' })) }),
  })) as unknown as typeof fetch;
}

function setup(): { db: Db; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'model-sync-probe-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  return { db, close: () => db.close() };
}

/** 建一个上游 + 一把已启用的 balance key：同步要有 key 才拉得动列表。 */
function seedUpstream(db: Db, name = 'probe-up'): string {
  const up = createUpstream(db, { name, baseUrl: 'https://upstream.example.com' });
  createKey(db, { upstreamId: up.id, key: probeSecret(), category: 'balance' }, MASTER_KEY);
  return up.id;
}

async function runSync(db: Db, upstreamId: string | undefined, names: string[]): Promise<unknown> {
  return syncModels(db, MASTER_KEY, upstreamId, silentReporter(), fakeModelsFetch(names));
}

describe('type 推断规则表（ADR-0009 §2）', () => {
  it('按名字命中，顺序固定且 chat 是兜底', () => {
    expect(inferModelType('text-embedding-3-large')).toBe('embedding');
    expect(inferModelType('bge-reranker-v2')).toBe('rerank');
    expect(inferModelType('whisper-1')).toBe('audio');
    expect(inferModelType('dall-e-3')).toBe('image');
    expect(inferModelType('deepseek-chat')).toBe('chat');
    // 同一条名字里多个线索时，顺序给出确定解 —— 不许随实现细节漂移
    expect(inferModelType('deepseek-vl2-embed-image')).toBe('embedding');
  });
});

describe('建档时只落能证明的字段（ADR-0009 §1）', () => {
  it('capabilities 空数组、price/contextLength 为 null，且 inferredTypeCount 只数新建档的', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);

      const first = await runSync(db, upstreamId, ['text-embedding-3-large', 'deepseek-chat']);
      expect(first).toMatchObject({ inserted: 2, updated: 0, unchanged: 0, inferredTypeCount: 2 });

      const rows = listModels(db, { page: 1, pageSize: 20 }).items;
      for (const row of rows) {
        expect(row.capabilities).toEqual([]);
        expect(row.price).toBeNull();
        expect(row.contextLength).toBeNull();
        expect(row.displayName).toBeNull();
        expect(row.enabled).toBe(true);
      }

      // 第二次同步同样是这两条名字：一条都没新建，inferredTypeCount 必须归零。
      // 它回答的是"本次新猜了几条"，不是"本次处理了几条"。
      const second = await runSync(db, upstreamId, ['text-embedding-3-large', 'deepseek-chat']);
      expect(second).toMatchObject({ inserted: 0, unchanged: 2, inferredTypeCount: 0 });
    } finally {
      close();
    }
  });

  it('上游榜上没有的模型不建档，老档案也不被删除（软口径：同步只增不删）', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      await runSync(db, upstreamId, ['model-a', 'model-b']);
      await runSync(db, upstreamId, ['model-a']);

      const names = listModels(db, { page: 1, pageSize: 20 }).items.map((m) => m.name).sort();
      expect(names).toEqual(['model-a', 'model-b']);
    } finally {
      close();
    }
  });
});

describe('未知不覆盖已知（ADR-0009 §4）', () => {
  it('PATCH 过的人工值经重同步后逐字段保留，且 revision 不因未变字段增长', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      await runSync(db, upstreamId, ['deepseek-chat']);

      const before = listModels(db, { page: 1, pageSize: 20 }).items[0];
      expect(before).toBeDefined();
      const id = before?.id ?? '';

      const patched = updateModel(db, id, {
        displayName: 'DeepSeek Chat（人工）',
        type: 'embedding', // 故意跟推断结果不同：人工修正必须压过推断
        capabilities: ['stream', 'function_call'],
        contextLength: 65536,
        price: { inputPer1k: 100, outputPer1k: 200 },
        revision: before?.revision ?? 1,
      });
      expect(patched.revision).toBe((before?.revision ?? 1) + 1);

      // 同步看到的名字没变，但它对 capabilities/price/contextLength 一无所知 ——
      // "上游没说"不是"上游说没有"，所以一个字都不该写。
      const summary = await runSync(db, upstreamId, ['deepseek-chat']);
      expect(summary).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });

      const after = getModelRow(db, id);
      expect(after?.display_name).toBe('DeepSeek Chat（人工）');
      expect(after?.type).toBe('embedding');
      expect(JSON.parse(after?.capabilities ?? 'null')).toEqual(['stream', 'function_call']);
      expect(after?.context_length).toBe(65536);
      expect(after?.price_input_per_1k).toBe(100);
      expect(after?.price_output_per_1k).toBe(200);
      expect(after?.revision).toBe(patched.revision);

      // lastSyncedAt 仍要刷新：它回答的是"上次拉到数据是什么时候"，与内容变没变无关
      expect(after?.last_synced_at).not.toBeNull();
    } finally {
      close();
    }
  });

  it('人工关掉的 enabled 不被重同步打开（同步不碰管理员的业务开关）', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db);
      await runSync(db, upstreamId, ['model-a']);
      const row = listModels(db, { page: 1, pageSize: 20 }).items[0];
      updateModel(db, row?.id ?? '', { enabled: false, revision: row?.revision ?? 1 });

      await runSync(db, upstreamId, ['model-a']);
      expect(getModelRow(db, row?.id ?? '')?.enabled).toBe(0);
    } finally {
      close();
    }
  });
});

describe('同步的失败口径（ADR-0009 / 契约 §5）', () => {
  it('全部上游都失败时任务失败，不谎报"同步成功 0 条"', async () => {
    const { db, close } = setup();
    try {
      const upstreamId = seedUpstream(db, 'up-without-models');
      const brokenFetch = (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch;

      await expect(
        syncModels(db, MASTER_KEY, upstreamId, silentReporter(), brokenFetch),
      ).rejects.toThrow(/同步失败/);
    } finally {
      close();
    }
  });
});

describe('共享凭据选择器（契约 §5 v1.11.2 / ADR-0026）', () => {
  /**
   * sync 401 根因回归：旧实现取「第一把启用 key」且 401 不换把。
   * 钉三件事：
   *   1. 候选排序把「无台账绑定的 key」沉底（孤儿 key 不再挡道）；
   *   2. 预算内被试到时，401/403 换下一把并留下可观测位（tried/usedMaskedKeys/switched）；
   *   3. 非凭据错误（5xx/超时/网络）不换把，原样进 errors。
   */
  function seedTwoKeys(db: Db, upstreamId: string): { orphanSecret: string; boundSecret: string } {
    const orphanSecret = probeSecret() + '-orphan';
    const boundSecret = probeSecret() + '-bound';
    // 先建的这把**无台账绑定**（孤儿），排序后必须沉底
    createKey(db, { upstreamId, key: orphanSecret, category: 'balance' }, MASTER_KEY);
    const bound = createKey(db, { upstreamId, key: boundSecret, category: 'token-plan' }, MASTER_KEY);
    // 台账种子：凭证 BLOB 必须非空（「至少持有一路凭据」CHECK），status 必须 'active'
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO supplier_accounts (id, upstream_id, supplier, identifier, identifier_hash,
                                      encrypted_password, status, created_at, updated_at)
       VALUES ('sa_seed_1', ?, 'tierflow', 'seed-acc', 'seed-hash-1', ?, 'active', ?, ?)`,
    ).run(upstreamId, Buffer.from('seed-cipher'), at, at);
    db.prepare(
      `INSERT INTO supplier_account_keys (id, account_id, masked_key, pooled_key_id, created_at, updated_at)
       VALUES ('sak_seed_1', 'sa_seed_1', ?, ?, ?, ?)`,
    ).run(bound.maskedKey, bound.id, at, at);
    return { orphanSecret, boundSecret };
  }

  /** 按明文反查 key id（验证排序位次用）。 */
  function keyIdOfSecret(db: Db, secret: string): string {
    const refs = decryptedKeyRefs(db, {}, MASTER_KEY);
    const hit = refs.find((r) => r.decrypted === secret);
    expect(hit).toBeDefined();
    return (hit as { keyId: string }).keyId;
  }

  /** 按 Authorization 头分派的假上游：orphan 那把给 401，其余给模型列表。 */
  function authAwareFetch(orphanSecret: string, names: string[]): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      const auth = init?.headers?.Authorization ?? '';
      calls.push(auth);
      if (auth.includes(orphanSecret)) {
        return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ object: 'list', data: names.map((id) => ({ id, object: 'model' })) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('候选排序：active 台账绑定的优先，孤儿 key 沉底', () => {
    const { db, close } = setup();
    try {
      const up = createUpstream(db, { name: 'sort-check-up', baseUrl: 'https://upstream.example.com' });
      const { orphanSecret, boundSecret } = seedTwoKeys(db, up.id);
      const ids = pickCredentialKeyIds(db, up.id);
      expect(ids).toHaveLength(2);
      // 逐字断言位次：绑定的在后建侧，但必须排到队首；孤儿沉底
      expect(ids[0]).toBe(keyIdOfSecret(db, boundSecret));
      expect(ids[1]).toBe(keyIdOfSecret(db, orphanSecret));
    } finally {
      close();
    }
  });

  it('401 换把成功后带 credentials 可观测位；一发通过时该字段省略', async () => {
    const { db, close } = setup();
    try {
      const up = createUpstream(db, { name: 'rot-up', baseUrl: 'https://upstream.example.com' });
      const { boundSecret } = seedTwoKeys(db, up.id);
      // 队首 = 绑定 key（排序把绑定优先）。401 打在队首才触发「换下一把」：
      // 第一发 bound → 401，第二发 orphan → 200，同步照样成功。
      const probe = authAwareFetch(boundSecret, ['m-x']);
      const summary = await syncModels(db, MASTER_KEY, up.id, silentReporter(), probe.fetchImpl);
      expect(summary.failedUpstreams).toBe(0);
      expect(summary.credentials).toMatchObject({ tried: 2, switched: 1 });
      expect(summary.credentials?.usedMaskedKeys).toHaveLength(2);
      expect(probe.calls).toHaveLength(2); // 真的打了两发上游：第一把 401

      // 第二次同步：不再 401 任何一把 ⇒ 队首一发成功，credentials 省略（switched === 0）
      const probe2 = authAwareFetch('no-secret-matches', ['m-x']);
      const again = await syncModels(db, MASTER_KEY, up.id, silentReporter(), probe2.fetchImpl);
      expect(again.credentials).toBeUndefined();
      expect(probe2.calls).toHaveLength(1);
    } finally {
      close();
    }
  });

  it('预算耗尽：全 401 时试满 budget 把，最后一个错误进 errors', async () => {
    const { db, close } = setup();
    try {
      const up = createUpstream(db, { name: 'rot-exhaust', baseUrl: 'https://upstream.example.com' });
      createKey(db, { upstreamId: up.id, key: probeSecret() + '-a', category: 'balance' }, MASTER_KEY);
      createKey(db, { upstreamId: up.id, key: probeSecret() + '-b', category: 'balance' }, MASTER_KEY);
      createKey(db, { upstreamId: up.id, key: probeSecret() + '-c', category: 'balance' }, MASTER_KEY);
      let calls = 0;
      const always401 = (async () => {
        calls += 1;
        return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      // 既有不变量：全部上游失败 ⇒ 任务失败（抛错），错误带最后一个上游的原始状态码
      await expect(syncModels(db, MASTER_KEY, up.id, silentReporter(), always401, 2)).rejects.toThrow('401');
      expect(calls).toBe(2); // 3 把候选、预算 2：第 3 把不该被试到
    } finally {
      close();
    }
  });

  it('非凭据错误（5xx）不换把：一发即止，错误原样进 errors', async () => {
    const { db, close } = setup();
    try {
      const up = createUpstream(db, { name: 'rot-5xx', baseUrl: 'https://upstream.example.com' });
      seedTwoKeys(db, up.id);
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch;
      await expect(syncModels(db, MASTER_KEY, up.id, silentReporter(), fetchImpl)).rejects.toThrow('500');
      expect(calls).toBe(1); // 5xx 不是换一把 key 能解决的问题：第二把不该被试到
    } finally {
      close();
    }
  });

  it('台账行缺失（非账号面上游）：退化为 created_at,id 序，不排空候选', async () => {
    const { db, close } = setup();
    try {
      const up = createUpstream(db, { name: 'rot-noledger', baseUrl: 'https://upstream.example.com' });
      createKey(db, { upstreamId: up.id, key: probeSecret() + '-n1', category: 'balance' }, MASTER_KEY);
      createKey(db, { upstreamId: up.id, key: probeSecret() + '-n2', category: 'balance' }, MASTER_KEY);
      const ids = pickCredentialKeyIds(db, up.id);
      expect(ids).toHaveLength(2);
      // 没有台账 ⇒ 退化回原 `created_at, id` 稳定序（同毫秒创建时并列由 id 决胜，故期望值从库反推）
      const expected = (
        db
          .prepare(
            `SELECT id FROM upstream_keys WHERE upstream_id = ? AND deleted_at IS NULL AND enabled = 1
             ORDER BY created_at, id LIMIT 1`,
          )
          .get(up.id) as { id: string }
      ).id;
      expect(ids[0]).toBe(expected);
    } finally {
      close();
    }
  });
});
