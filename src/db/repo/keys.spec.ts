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
import { applyTemplateBalance, applyTemplateTokenPlan, createKey, getKey, setKeyBalance } from './keys.js';
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

// §15.2（v1.4.2）：`models` → `upstream_keys.model_limits` CSV。
//
// 这条的失败方式同样静默：列存在、DTO 有字段、网关也读这一个列，但**写侧没人落它**时，
// 白名单在页面上看得见、在网关上不生效，且不报任何错（§16.3 那行"对不上且无报错"）。
// 契约 §15.7 另行钉死「空 ⇒ `NULL`，**不落 `''`**」—— `''` 与 `NULL` 两个值表达同一语义，
// 早晚有人写出只判其中一个的查询，所以空值归一化也在这里钉住。
describe('§15.2 / §15.7 落库规则：models ⇒ model_limits CSV（空一律归一化为 NULL）', () => {
  /** 直读列：DTO 出口会拦一道，库里那一列才是真正的落库结果。 */
  function storedCsv(db: Db, keyId: string): string | null {
    const row = db.prepare('SELECT model_limits FROM upstream_keys WHERE id = ?').get(keyId) as {
      model_limits: string | null;
    };
    return row.model_limits;
  }

  it('给了白名单：落成 CSV，且 getKey 读回同一个集合', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });

    const created = createKey(
      db,
      { upstreamId: up.id, key: probeSecret(), category: 'balance', models: ['gpt-4o', 'claude-3-5-sonnet'] },
      MASTER_KEY,
    );

    expect(storedCsv(db, created.id)).toBe('gpt-4o,claude-3-5-sonnet');
    expect(created.models).toEqual(['gpt-4o', 'claude-3-5-sonnet']);
    expect(getKey(db, created.id, false)?.models).toEqual(['gpt-4o', 'claude-3-5-sonnet']);
  });

  it('省略 / `[]` / 全空白：一律落 NULL，不落 `\'\'`', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });

    const omitted = createKey(db, { upstreamId: up.id, key: probeSecret(), category: 'balance' }, MASTER_KEY);
    const empty = createKey(
      db,
      { upstreamId: up.id, key: probeSecret(), category: 'balance', models: [] },
      MASTER_KEY,
    );
    const blank = createKey(
      db,
      { upstreamId: up.id, key: probeSecret(), category: 'balance', models: ['', '   '] },
      MASTER_KEY,
    );

    for (const k of [omitted, empty, blank]) {
      expect(storedCsv(db, k.id)).toBeNull();
      // `[]` 与 `null` 同义（§3），出口恒不出现 `[]`
      expect(k.models).toBeNull();
      expect(getKey(db, k.id, false)?.models).toBeNull();
    }
  });

  it('去空白、丢空项 —— 但不改模型名本身（`*` 原样透出）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });

    const created = createKey(
      db,
      { upstreamId: up.id, key: probeSecret(), category: 'balance', models: [' gpt-4o ', '', '  ', '*'] },
      MASTER_KEY,
    );

    expect(storedCsv(db, created.id)).toBe('gpt-4o,*');
    expect(created.models).toEqual(['gpt-4o', '*']);
  });

  it('token-plan 行同样可带白名单（白名单与余额类别是两条正交的维度）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });

    const created = createKey(
      db,
      {
        upstreamId: up.id,
        key: probeSecret(),
        category: 'token-plan',
        models: ['gpt-4o'],
        tokenPlan: { remainingTokens: 1000, expiresAt: null },
      },
      MASTER_KEY,
    );

    expect(getKey(db, created.id, false)?.models).toEqual(['gpt-4o']);
  });
});

// §20.4 判定腿：`keys.ts` 的三个落库点（手动录入 / 模板余额回写 / 套餐余量回写）
// 每个都在**写完那一列之后**重读整行、按 `category` 分派判据、置位锁存。
//
// 这里钉的是"判定腿真的挂在了这些路上"，而不是判据本身（判据在 `../depletion.spec.ts`）
// 或置位 SQL 的粘性 / 广播（在 `./depletion-latch.spec.ts`）—— 这三层各自的失败形状不同：
// 判据写反锁错人，SQL 写坏丢审计事实，而**腿没挂上**最安静：库里有余额有标记位，
// 谁都不报错，只是那把 key 永远不被打标、永远在候选里，直到打出去 402。
describe('§20.4 判定腿挂在 keys.ts 的三个落库点上', () => {
  /** 库里那一行的锁存两列 + revision。 */
  function latchOf(db: Db, keyId: string): { at: string | null; reason: string | null; revision: number } {
    return db
      .prepare('SELECT depleted_at AS at, depleted_reason AS reason, revision FROM upstream_keys WHERE id = ?')
      .get(keyId) as { at: string | null; reason: string | null; revision: number };
  }

  /** 该 key 收到的 `'key'` 实体**更新**广播条数（置位应发一条，未置位不发）。 */
  function keyBroadcasts(db: Db, keyId: string): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'key' AND entity_id = ? AND op = 'update'")
        .get(keyId) as { n: number }
    ).n;
  }

  it('setKeyBalance：录一个 0 当场锁；录回 5000 **不**解锁（§20.3 只置位）', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    const created = createKey(
      db,
      { upstreamId: up.id, key: probeSecret(), category: 'balance', balance: 1280 },
      MASTER_KEY,
    );
    expect(latchOf(db, created.id).at).toBeNull();

    // "人工核实"是把值写得更准，不是把判据关掉（§20.4）。
    setKeyBalance(db, created.id, { balance: 0 });
    expect(latchOf(db, created.id)).toMatchObject({ reason: 'balance' });
    expect(keyBroadcasts(db, created.id)).toBe(1);

    // 回池只有人工那一个入口：录回一个够用的余额不解锁。
    setKeyBalance(db, created.id, { balance: 5000 });
    expect(latchOf(db, created.id).at).not.toBeNull();
  });

  it('setKeyBalance 录 NULL（未知）：不解锁，但**也不会**把"未知"当"没钱"再锁一次', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    // 起点必须是一把**没锁**的 key（余额在阈值之上），"录 NULL 后仍未锁"才是
    // "NULL 不判"，而不是继承了一个本来为空（或本来已锁）的初始态。
    const created = createKey(
      db,
      { upstreamId: up.id, key: probeSecret(), category: 'balance', balance: 5000 },
      MASTER_KEY,
    );
    expect(latchOf(db, created.id).at).toBeNull();

    setKeyBalance(db, created.id, { balance: null });
    expect(latchOf(db, created.id).at).toBeNull();
    expect(keyBroadcasts(db, created.id)).toBe(0);
  });

  it('applyTemplateBalance：模板查到 5 分 → 锁；查到 NULL → 真空操作不锁', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    const a = createKey(db, { upstreamId: up.id, key: probeSecret(), category: 'balance' }, MASTER_KEY);
    const b = createKey(db, { upstreamId: up.id, key: probeSecret(), category: 'balance' }, MASTER_KEY);

    applyTemplateBalance(db, a.id, { balanceCents: 5, currency: 'CNY' });
    expect(latchOf(db, a.id)).toMatchObject({ reason: 'balance' });
    expect(keyBroadcasts(db, a.id)).toBe(1);

    // 查不到值（NULL）是"未知 ≠ 没钱"（ADR-0003）：不写、不锁、不广播。
    applyTemplateBalance(db, b.id, { balanceCents: null, currency: null });
    expect(latchOf(db, b.id).at).toBeNull();
    expect(keyBroadcasts(db, b.id)).toBe(0);
  });

  it('applyTemplateTokenPlan：余量回填 0 → 锁；NULL（上游没说）→ 保留旧值、按旧值判', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    // `remainingTokens: null` = **不传 `tokenPlan`**：`createKey` 的入参里那是个非空 `number`
    // （上游没回余量时调用方本就不该编一个数出来），省略才落 `NULL`。
    const seed = (over: { remainingTokens: number | null }): string =>
      createKey(
        db,
        {
          upstreamId: up.id,
          key: probeSecret(),
          category: 'token-plan',
          ...(over.remainingTokens === null
            ? {}
            : { tokenPlan: { remainingTokens: over.remainingTokens, expiresAt: null } }),
        },
        MASTER_KEY,
      ).id;

    const zero = seed({ remainingTokens: 900 });
    applyTemplateTokenPlan(db, zero, { remainingTokens: 0, expiresAt: null });
    expect(latchOf(db, zero)).toMatchObject({ reason: 'balance' });

    // COALESCE 路径：这次只给了到期时间，余量留 NULL ⇒ 库里保留 900，不锁。
    const keep = seed({ remainingTokens: 900 });
    applyTemplateTokenPlan(db, keep, { remainingTokens: null, expiresAt: '2027-01-01T00:00:00Z' });
    expect(latchOf(db, keep).at).toBeNull();

    // 未知余量（库里本来就没有）不锁："上游没说用了多少" ≠ "一点没剩"。
    const unknown = seed({ remainingTokens: null });
    applyTemplateTokenPlan(db, unknown, { remainingTokens: null, expiresAt: '2027-01-01T00:00:00Z' });
    expect(latchOf(db, unknown).at).toBeNull();
  });

  it('判据按 category 分派：balance 类 key 的 token_plan 历史残留不触发锁存', () => {
    const db = setup();
    const up = createUpstream(db, { name: 'tf', baseUrl: 'https://tierflow.cn', supplier: 'tierflow' });
    // 创建时给一个健康余额；token_plan_remaining 用模板路径塞进一个 0（历史残留的形状）。
    const created = createKey(
      db,
      { upstreamId: up.id, key: probeSecret(), category: 'balance', balance: 1280 },
      MASTER_KEY,
    );
    db.prepare('UPDATE upstream_keys SET token_plan_remaining = 0 WHERE id = ?').run(created.id);

    // 触发一次判定腿：余额照旧健康（1280），若误判 token_plan 那列会当场锁上。
    setKeyBalance(db, created.id, { balance: 1280 });
    expect(latchOf(db, created.id).at).toBeNull();
  });
});
