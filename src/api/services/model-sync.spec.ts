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
import { createKey } from '../../db/repo/keys.js';
import { getModelRow, listModels, updateModel } from '../../db/repo/models.js';
import type { TaskReporter } from '../task-runner.js';
import { inferModelType, syncModels } from './model-sync.js';

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
