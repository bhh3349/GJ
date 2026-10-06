// 上游 key 写路径（契约 §3）。
//
// 这里只钉**一条**规则，因为它的失败方式是静默的：§15.7「`unlimited = 1` ⇒ `balance_cents`
// 必须落 `NULL`」。上游对无限额度 key 回的是 `{unlimited_quota: true, remain_quota: -331119}`，
// 那个负数落进库就成了一把"已欠费"的 key，而网关的可用性过滤是 `balance_cents <= 0 → 排除` ——
// 于是它被**静默踢出选路**：不报错、不告警、不进冷却，客户端只看到"没有可用 key"。
// 规则由 `createKey` 自己强制（不信调用方会记得丢那个负数），所以判据也落在这里。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../database.js';
import { createKey, getKey } from './keys.js';
import { createUpstream } from './upstreams.js';

const dirs: string[] = [];
const open: Db[] = [];
const MASTER_KEY = Buffer.from('22'.repeat(32), 'hex');

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
      /* 临时目录删不掉不影响判据 */
    }
  }
});

function setup(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'keys-probe-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  open.push(db);
  return db;
}

/** 桩 key 运行时拼：`sk-` 后接 ≥20 位字面量会被自己的 `check:secrets` 抓成疑似真 key。 */
function probeSecret(): string {
  return 'sk-probe-' + 'C'.repeat(24);
}

describe('§15.7 落库规则：unlimited ⇒ balance_cents 必须是 NULL', () => {
  it('调用方把上游的 -331119 一起传进来，落库仍是 NULL，且 unlimited 置位', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });

    const created = createKey(
      db,
      { upstreamId: up.id, key: probeSecret(), category: 'balance', unlimited: true, balance: -331119 },
      MASTER_KEY,
    );

    expect(created.unlimited).toBe(true);
    expect(created.balance).toBeNull();
    expect(created.balanceUpdatedAt).toBeNull();
    expect(created.balanceSource).toBeNull();

    // 回读一遍：出口的 DTO 是拦一道，库里那一列才是真正的落库结果
    const stored = db.prepare('SELECT balance_cents, unlimited FROM upstream_keys WHERE id = ?').get(created.id) as {
      balance_cents: number | null;
      unlimited: number;
    };
    expect(stored.balance_cents).toBeNull();
    expect(stored.unlimited).toBe(1);
  });

  it('普通 key 不受影响：给多少落多少，unlimited 恒 false', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'generic', baseUrl: 'https://generic.example.com' });

    const created = createKey(
      db,
      { upstreamId: up.id, key: probeSecret(), category: 'balance', balance: 1280 },
      MASTER_KEY,
    );

    expect(created.unlimited).toBe(false);
    expect(created.balance).toBe(1280);
    expect(created.balanceSource).toBe('manual');
  });

  it('token-plan 行不认 unlimited（该类别不看余额，徽标会指着一个不存在的概念）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'generic', baseUrl: 'https://generic.example.com' });

    const created = createKey(
      db,
      {
        upstreamId: up.id,
        key: probeSecret(),
        category: 'token-plan',
        unlimited: true,
        tokenPlan: { remainingTokens: 1000, expiresAt: null },
      },
      MASTER_KEY,
    );

    expect(created.unlimited).toBe(false);
  });

  it('`unlimited` 落库后 getKey 仍读得出来（读路径没把它漏掉）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    const created = createKey(
      db,
      { upstreamId: up.id, key: probeSecret(), category: 'balance', unlimited: true },
      MASTER_KEY,
    );
    expect(getKey(db, created.id, false)?.unlimited).toBe(true);
  });
});
