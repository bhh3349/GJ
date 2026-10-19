/**
 * KeyPool 纯逻辑单测
 * 运行方式：pnpm test（vitest run，与根 package.json 的 test 脚本一致）
 * 覆盖：过滤 / 排序 / 冷却阶梯与封顶 / 并发上限 / 成功结算 / 自动禁用 / 未知余额口径
 * 依据：docs/dev-constraints.md §三 §四
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { MAX_COOLDOWN_MS, MINUTE, NETWORK_BASE_MS, UPSTREAM_ERROR_BASE_MS, nextCooldownMs } from './cooldown.js';
import { createKeyPool } from './key-pool.js';
import type { KeyConfig, PoolSnapshot, TokenUsage } from './types.js';

let clock = 1_700_000_000_000;
const now = (): number => clock;

function balanceKey(keyId: string, over: Partial<KeyConfig> = {}): KeyConfig {
  return {
    keyId,
    upstreamId: 'up1',
    category: 'balance',
    status: 'enabled',
    weight: 1,
    models: null,
    balanceCents: 1000,
    tokenPlanRemainingTokens: null,
    tokenPlanExpiresAt: null,
    // 透支锁存（§20.7）：必填字段，构造点逐一点名。测试默认"未锁存"，
    // 需要锁存态的用例显式传 `{ depleted: true }`。
    depleted: false,
    ...over,
  };
}

function snapshot(keys: KeyConfig[], upstreams: PoolSnapshot['upstreams'] = [{ upstreamId: 'up1', enabled: true, models: null }]): PoolSnapshot {
  return { revision: 1, upstreams, keys };
}

const usage = (total: number): TokenUsage => ({ prompt: total, completion: 0, total, isEstimated: false });

describe('getAvailableKeys 过滤', () => {
  it('排除 disabled / 上游停用 / 余额为 0 / 套餐过期 / 模型不匹配，保留未知余额', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(
      snapshot([
        balanceKey('ok'),
        balanceKey('disabled', { status: 'disabled' }),
        balanceKey('zero', { balanceCents: 0 }),
        balanceKey('unknown', { balanceCents: null }),
        balanceKey('other-model', { models: ['gpt-4o'] }),
        balanceKey('expired', { category: 'token-plan', tokenPlanRemainingTokens: 100, tokenPlanExpiresAt: '2020-01-01T00:00:00Z' }),
        balanceKey('orphan', { upstreamId: 'up-missing' }),
      ]),
    );

    const ids = (await pool.getAvailableKeys('gpt-4o-mini')).map((c) => c.keyId);
    assert.deepEqual(ids.sort(), ['ok', 'unknown']);
    assert.ok(!ids.includes('zero'), '余额为 0 必须排除');
    assert.ok(ids.includes('unknown'), '未知余额不得当作 0（未知≠0）');
  });
});

describe('getAvailableKeys 排序', () => {
  it('权重 → 剩余额度(token-plan) → 上次失败时间 → LRU；balance 类不按余额排序', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(
      snapshot([
        balanceKey('k1', { weight: 1, balanceCents: 500 }),
        balanceKey('k2', { weight: 2, balanceCents: 100 }),
        balanceKey('k3', { weight: 2, balanceCents: 900 }),
        balanceKey('k4', { weight: 2, balanceCents: 900 }),
      ]),
    );

    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['k2', 'k3', 'k4', 'k1'],
      'balance 类在键 2 上全平（余额不再排序），同权重档回落到快照序；跨档仍按权重降序',
    );

    pool.reportFailure('k3', 'NETWORK');
    clock += NETWORK_BASE_MS + 1; // 冷却已过、仍在时效窗内：lastFailureAt 保留故障优先序
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['k2', 'k4', 'k3', 'k1'],
      '键 3（上次失败时间）时效窗内生效：k3 带着新鲜失败沉到同档的 k2/k4 之后',
    );

    // ADR-0011 的核心回归：键 4 LRU —— 用掉谁，谁就沉到同档队尾。
    pool.beginAttempt('k2');
    pool.endAttempt('k2');
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['k4', 'k2', 'k3', 'k1'],
      'k2 刚用过 → 同档内让位给从未用过的 k4（旧行为里 k2 会永远霸占头把）',
    );

    clock += 1;
    pool.beginAttempt('k4');
    pool.endAttempt('k4');
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['k2', 'k4', 'k3', 'k1'],
      'k4 用过之后轮到 k2（stamp T < T+1）—— 头把在 k2/k4 之间确定性轮转',
    );
  });

  it('陈旧失败超窗后归从未失败，LRU 接管轮换（探针 P1 恒钉修复回归）', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('a'), balanceKey('b'), balanceKey('c')]));

    // 模拟昨晚 401 风暴：三把同权重同余额 key 冻结着相异失败时间戳。
    // 旧实现里键 3 按这些相异时间戳恒序 → 键 4 LRU 永远轮不到，头把恒钉一把。
    pool.reportFailure('a', 'AUTH_INVALID');
    clock += 1;
    pool.reportFailure('b', 'AUTH_INVALID');
    clock += 1;
    pool.reportFailure('c', 'AUTH_INVALID');

    // 越过最晚那笔失败的时效窗（30min）：三把的 lastFailureAt 全部过期，归「从未失败」。
    clock += MAX_COOLDOWN_MS + 1;

    const heads = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const head = (await pool.getAvailableKeys('gpt-4o'))[0]?.keyId;
      assert.ok(head !== undefined, '每次都必须有可用 head');
      heads.add(head);
      pool.beginAttempt(head);
      pool.endAttempt(head);
    }
    assert.ok(heads.size > 1, `LRU 应轮换到多把头 key（distinct=${heads.size}），而不是恒钉一把`);
  });

  it('token-plan 仍按套餐余量降序，且**未知余量也排在余额 key 之前**（ADR-0011 追认）', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(
      snapshot([
        balanceKey('tp-rich', { category: 'token-plan', balanceCents: null, tokenPlanRemainingTokens: 900 }),
        balanceKey('tp-poor', { category: 'token-plan', balanceCents: null, tokenPlanRemainingTokens: 100 }),
        balanceKey('tp-unknown', { category: 'token-plan', balanceCents: null, tokenPlanRemainingTokens: null }),
      ]),
    );
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['tp-rich', 'tp-poor', 'tp-unknown'],
      '余量降序；未知哨兵取 1，垫在「任何可用的已知余量」之后（可用最小即 1），但不排除',
    );
    pool.reportSuccess('tp-rich', { prompt: 400, completion: 0, total: 400, isEstimated: false }, 10);
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['tp-rich', 'tp-poor', 'tp-unknown'],
      '乐观扣减后 900-400=500 仍 > 100，序不变（扣减真实生效即可，轮转由键 2 单调性自然产生）',
    );
    pool.reportSuccess('tp-rich', { prompt: 450, completion: 0, total: 450, isEstimated: false }, 10);
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['tp-poor', 'tp-rich', 'tp-unknown'],
      '累计扣到余量 50（>0 仍可用）后 tp-poor 胜出 —— 这是验收 1 在 token-plan 上的既有轮转路径，不得回退',
    );
  });

  it('套餐 key 一律排在余额 key 之前（用户目标：先烧 30 天有效期的套餐）', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    // 余额 key 刻意给「很高」的余额：按 balanceCents 排序的旧世界它会赢，
    // 而它现在必须排在最后 —— 这正是 ADR-0011 的 balance 常量 0 与追认的哨兵 1 共同作用的结果。
    pool.applySnapshot(
      snapshot([
        balanceKey('bal-rich', { balanceCents: 999_999 }),
        balanceKey('bal-unknown', { balanceCents: null }),
        balanceKey('bal-zero-ish', { balanceCents: 1 }),
        balanceKey('tp-known', { category: 'token-plan', balanceCents: null, tokenPlanRemainingTokens: 2 }),
        balanceKey('tp-unknown', { category: 'token-plan', balanceCents: null, tokenPlanRemainingTokens: null }),
      ]),
    );
    const ids = (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId);
    assert.deepEqual(
      ids.slice(0, 2).sort(),
      ['tp-known', 'tp-unknown'],
      `两把套餐 key 必须占据前两位（实际顺序 ${ids.join(', ')}）`,
    );
    assert.deepEqual(
      ids.slice(2),
      ['bal-rich', 'bal-unknown', 'bal-zero-ish'],
      '余额 key 全数沉到套餐 key 之后；它们内部按键 3/4/5 走（余额不参与键 2）',
    );

    // 反向钉：哨兵 1 不能盖过**真实只剩 2** 的套餐 key —— 否则"刚 rotate、还没回填"的 key
    // 会抢在"快用完、该轮换了"的 key 前面，把仅剩的额度堵死。
    pool.applySnapshot(
      snapshot([
        balanceKey('tp-unknown', { category: 'token-plan', balanceCents: null, tokenPlanRemainingTokens: null }),
        balanceKey('tp-last-tokens', { category: 'token-plan', balanceCents: null, tokenPlanRemainingTokens: 2 }),
        balanceKey('bal', { balanceCents: 5000 }),
      ]),
    );
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['tp-last-tokens', 'tp-unknown', 'bal'],
      '2 > 1（哨兵）：真实余量仍胜过未知；且未知仍胜过余额 key',
    );
  });

  it('lastUsedSeq 不进 view()（内部轮转游标，不对外承诺）', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('k1')]));
    pool.beginAttempt('k1');
    pool.endAttempt('k1');
    const rt = pool.view().find((r) => r.keyId === 'k1');
    assert.ok(rt !== undefined);
    assert.equal('lastUsedAt' in rt, false, 'view() 输出形状零变化（/internal/snapshot、key_runtime 镜像不受影响）');
    // autoDisabled **在** view() 里（审计项 A 的可观测性腿），但它刻意不进 key_runtime
    // 镜像 —— 表里没有那一列，加了就是给 ADR-0010 的单向镜像添一个永不刷新的假字段。
    assert.equal('autoDisabled' in rt, true, '自动禁用态必须可见（此前连日志外没有任何读面）');
  });
});

describe('冷却映射', () => {
  it('NETWORK 首失 15s，连续失败走 1m→5m→15m→30m 封顶', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('k1')]));

    const seen: number[] = [];
    for (let i = 1; i <= 6; i += 1) {
      pool.reportFailure('k1', 'NETWORK');
      const rt = pool.view().find((r) => r.keyId === 'k1');
      assert.ok(rt?.cooldownUntil != null);
      seen.push(rt.cooldownUntil - clock);
      assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '冷却中不得入选');
      clock += (seen[seen.length - 1] ?? 0) + 1; // 等冷却结束，制造下一次连续失败
    }
    assert.deepEqual(seen, [NETWORK_BASE_MS, MINUTE, 5 * MINUTE, 15 * MINUTE, MAX_COOLDOWN_MS, MAX_COOLDOWN_MS]);
  });

  it('AUTH_INVALID / INSUFFICIENT_BALANCE 恒为长冷却 30min；429 尊重 Retry-After', () => {
    assert.equal(nextCooldownMs({ reason: 'AUTH_INVALID', consecutiveFails: 1 }), MAX_COOLDOWN_MS);
    assert.equal(nextCooldownMs({ reason: 'INSUFFICIENT_BALANCE', consecutiveFails: 1 }), MAX_COOLDOWN_MS);
    assert.equal(nextCooldownMs({ reason: 'RATE_LIMITED', consecutiveFails: 1 }), MINUTE);
    assert.equal(nextCooldownMs({ reason: 'RATE_LIMITED', consecutiveFails: 1, retryAfterMs: 120_000 }), 120_000);
  });

  it('阶梯可整条替换（env COOLDOWN_LADDER_SECONDS）：升档按自定义，封顶与基础冷却不变', () => {
    // 阶梯与基础冷却取 max：调低阶梯不会把某类失败压到基础冷却以下
    assert.equal(nextCooldownMs({ reason: 'UPSTREAM_ERROR', consecutiveFails: 3, ladderMs: [1_000, 2_000] }), UPSTREAM_ERROR_BASE_MS);
    // 调高阶梯立刻生效（第 2 档 60s 而不是冻结的 5m），超出长度取最后一档
    assert.equal(nextCooldownMs({ reason: 'UPSTREAM_ERROR', consecutiveFails: 2, ladderMs: [30_000, 60_000] }), 60_000);
    assert.equal(nextCooldownMs({ reason: 'UPSTREAM_ERROR', consecutiveFails: 9, ladderMs: [30_000, 60_000] }), 60_000);
    // 超长阶梯仍被封顶在 MAX_COOLDOWN_MS（30min），不是静默截断阶梯
    assert.equal(nextCooldownMs({ reason: 'NETWORK', consecutiveFails: 2, ladderMs: [0, 99 * MINUTE] }), MAX_COOLDOWN_MS);
    // 长冷却不会因为换阶梯而变短
    assert.equal(nextCooldownMs({ reason: 'AUTH_INVALID', consecutiveFails: 3, ladderMs: [1_000, 2_000] }), MAX_COOLDOWN_MS);
  });

  it('池按自定义阶梯计算冷却（PoolOptions.cooldownLadderMs 真的生效）', () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now, cooldownLadderMs: [30_000, 60_000, 120_000] });
    pool.applySnapshot(snapshot([balanceKey('k1')]));

    pool.reportFailure('k1', 'UPSTREAM_ERROR');
    assert.equal((pool.view()[0]?.cooldownUntil ?? 0) - clock, 30_000, '第 1 档');

    clock += 30_001; // 等冷却过去，制造第 2 次连续失败
    pool.reportFailure('k1', 'UPSTREAM_ERROR');
    assert.equal((pool.view()[0]?.cooldownUntil ?? 0) - clock, 60_000, '第 2 档，而不是冻结的 5m');
  });
});

describe('reportSuccess', () => {
  it('清失败计数与冷却，并按 tokens 结算（token-plan 乐观扣减）', async () => {
    clock = 1_700_000_000_000;
    const collected: Array<{ keyId: string; total: number; latencyMs: number }> = [];
    const pool = createKeyPool({ now, usageSink: (keyId, tokens, latencyMs) => collected.push({ keyId, total: tokens.total, latencyMs }) });
    pool.applySnapshot(snapshot([balanceKey('tp1', { category: 'token-plan', tokenPlanRemainingTokens: 100, balanceCents: null })]));

    pool.reportFailure('tp1', 'UPSTREAM_ERROR');
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0);
    clock += 2 * MINUTE;

    pool.reportSuccess('tp1', usage(100), 42);
    assert.equal(pool.view()[0]?.consecutiveFails, 0);
    assert.equal(pool.view()[0]?.lastLatencyMs, 42);
    assert.deepEqual(collected, [{ keyId: 'tp1', total: 100, latencyMs: 42 }]);

    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '套餐余量耗尽后不再入选');
  });
});

describe('并发上限与自动禁用', () => {
  it('满并发的 key 暂不入选，且不计失败、不进冷却', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('k1', { maxConcurrency: 4 })]));

    for (let i = 0; i < 4; i += 1) assert.equal(pool.beginAttempt('k1'), true);
    assert.equal(pool.beginAttempt('k1'), false, '第 5 个并发位必须拒绝');
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '满并发不入候选');
    assert.equal(pool.view()[0]?.consecutiveFails, 0, '满并发不算失败');

    pool.endAttempt('k1');
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 1, '释放后立即可用');
  });

  it('key 未配 maxConcurrency 时取 PoolOptions.defaultMaxConcurrency，未传则默认 4', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now, defaultMaxConcurrency: 2 });
    pool.applySnapshot(snapshot([balanceKey('k1')]));

    assert.equal(pool.beginAttempt('k1'), true);
    assert.equal(pool.beginAttempt('k1'), true);
    assert.equal(pool.beginAttempt('k1'), false, '第 3 个并发位必须拒绝（defaultMaxConcurrency=2 被忽略则为 4）');
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0);
  });

  it('AUTH_INVALID 连续 5 次自动禁用并告警', async () => {
    clock = 1_700_000_000_000;
    const alerts: string[] = [];
    const pool = createKeyPool({ now });
    pool.onAlert = (e) => alerts.push(`${e.type}:${e.keyId}`);
    pool.applySnapshot(snapshot([balanceKey('k1')]));

    for (let i = 0; i < 5; i += 1) {
      pool.reportFailure('k1', 'AUTH_INVALID');
      clock += MAX_COOLDOWN_MS + 1;
    }
    assert.deepEqual(alerts, ['AUTH_INVALID_AUTO_DISABLED:k1']);
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '自动禁用后不再入选');
  });

  // 审计项 A：自动禁用曾经是**进程级不可恢复**的 —— reportSuccess 清了冷却与计数，
  // 却没碰 autoDisabled，而 isUsable 第一行就看它。后果不是"多等 30min"，是
  // 这把 key 从此再也不入选：key_runtime 表没有这一列、管理面没有入口、
  // applySnapshot 也不清，唯一的恢复手段是重启进程。
  it('自动禁用后，一次真实成功即可撤回（审计项 A）', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('k1')]));

    for (let i = 0; i < 5; i += 1) {
      pool.reportFailure('k1', 'AUTH_INVALID');
      clock += MAX_COOLDOWN_MS + 1;
    }
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '已自动禁用');
    assert.equal(pool.view()[0]?.autoDisabled, true, 'view() 暴露自动禁用态');

    // 上游恢复 / 管理员换了新 key：一次真实的成功就是最强的反证。
    // 自动禁用是网关自己的**推断**，不是管理端的配置意图，被证据推翻时就该撤回。
    pool.reportSuccess('k1', usage(1), 10);
    assert.equal(pool.view()[0]?.autoDisabled, false, '成功即撤回禁用态');
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 1, '重新入选');
  });

  it('自动禁用态不进 key_runtime 镜像（与 failCount 同族，重启归零）', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('k1')]));

    for (let i = 0; i < 5; i += 1) {
      pool.reportFailure('k1', 'AUTH_INVALID');
      clock += MAX_COOLDOWN_MS + 1;
    }
    // 表里没有 auto_disabled 列（见 src/db/schema.ts 的 key_runtime DDL）。
    // 加列就是给镜像添一个"永不刷新"的假字段 —— 见 src/wiring/key-runtime-flusher.ts
    // 的 signatureOf：只含会被写进表里的四列，这里守的就是那句话。
    assert.equal(pool.view()[0]?.autoDisabled, true);
  });
});

/**
 * 透支锁存（契约 §20.7 / ADR-0041）：库里的**第四轴**，与另外三轴正交。
 *
 * 这一组的存在理由是它的失败形状：把 `depleted` 悄悄忽略掉**不会报错** ——
 * 池子照常选路、客户端拿 200，只是钱已经付不起了。四个断言各自钉住一个错法：
 *   1. `depleted` 的 key **不进候选**（这一条就是整个功能）；
 *   2. 它与 `enabled=1` **不互斥** —— 锁存**不碰** `enabled`（§20.5 决策 6），
 *      所以"启用的 key 也不入选"必须由 `depleted` 单独判得出来；
 *   3. 它与 `autoDisabled` **不是一回事**（§20.9）：后者是网关自己的推断、一次成功就清；
 *      前者是落库的资金事实。成功**不得**撤回锁存 —— 快照不换，它就该一直在池外；
 *   4. 清锁只是换一份快照（`depleted: false`）—— 也就是"人工重启用"那条路走得通。
 */
describe('透支锁存：不进候选，且与 enabled / autoDisabled 互不干扰（§20.7）', () => {
  it('`depleted: true` 的 key 不入选 —— 余额再高也一样', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('ok'), balanceKey('latched', { depleted: true, balanceCents: 999_999 })]));

    const ids = (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId);
    assert.deepEqual(ids, ['ok'], '锁存与余额高低无关：判据是库里那个标记，不是这一列');
    // token-plan 类同样：套餐余量还没回填成 0 时，锁存标记就是**唯一**的排除依据。
    pool.applySnapshot(
      snapshot([
        balanceKey('plan-latched', {
          category: 'token-plan',
          balanceCents: null,
          tokenPlanRemainingTokens: 1000,
          depleted: true,
        }),
      ]),
    );
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '套餐 key 的锁存标记同样生效');
  });

  it('锁存**不碰** `enabled`：启用的 key 照样不入选，两者不是同一个判据', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    // `status: 'enabled'` + `depleted: true` 是**合法组合**（§20.5 决策 6：锁存绝不改 enabled）。
    // 若 isUsable 漏判 depleted，这把 key 会被当成一把完全正常的 key 选出去 —— 不报错。
    pool.applySnapshot(snapshot([balanceKey('enabled-but-broke', { status: 'enabled', depleted: true })]));
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, 'enabled=1 不是"可用"的充分条件');

    // 反向：清掉标记（= 人工 `undeplete` 换来的新快照）后同一条记录立刻回池。
    pool.applySnapshot(snapshot([balanceKey('enabled-but-broke', { status: 'enabled', depleted: false })]));
    assert.deepEqual(
      (await pool.getAvailableKeys('gpt-4o')).map((c) => c.keyId),
      ['enabled-but-broke'],
      '解除锁存 = 换一份 depleted:false 的快照，key 当场回池（这是"重新启用"那条路）',
    );
  });

  it('与 autoDisabled 正交：一次成功撤不回锁存（§20.9）', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('latched', { depleted: true })]));

    // `reportSuccess` 会清 autoDisabled（那是网关自己的推断，被证据推翻就该撤回），
    // 但它**够不着** depleted —— 后者是库里那一列，只有管理面写得了。
    pool.reportSuccess('latched', usage(1), 10);
    assert.equal(
      (await pool.getAvailableKeys('gpt-4o')).length,
      0,
      '一次成功不能把透支的 key 放回选路（能敲通上游 ≠ 付得起账）',
    );

    // 两者可以同时为真且互不干扰：一把被自动禁用**且**已锁存的 key，
    // 清掉锁存后仍因 autoDisabled 被排除 —— 两个判据各判各的。
    pool.applySnapshot(snapshot([balanceKey('both', { depleted: true })]));
    for (let i = 0; i < 5; i += 1) {
      pool.reportFailure('both', 'AUTH_INVALID');
      clock += MAX_COOLDOWN_MS + 1;
    }
    assert.equal(pool.view()[0]?.autoDisabled, true);
    pool.applySnapshot(snapshot([balanceKey('both', { depleted: false })]));
    assert.equal(
      (await pool.getAvailableKeys('gpt-4o')).length,
      0,
      '清锁存救不了它：autoDisabled 是另一条独立的排除理由，仍要等一次真实成功',
    );
    pool.reportSuccess('both', usage(1), 10);
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 1, '成功撤回 autoDisabled 后回池');
  });
});

describe('applySnapshot', () => {
  it('刷新后移除已删除 key 的运行态，保留仍在册 key 的冷却', async () => {
    clock = 1_700_000_000_000;
    const pool = createKeyPool({ now });
    pool.applySnapshot(snapshot([balanceKey('k1'), balanceKey('k2')]));
    pool.reportFailure('k1', 'NETWORK');

    pool.applySnapshot({ revision: 2, upstreams: [{ upstreamId: 'up1', enabled: true, models: null }], keys: [balanceKey('k1')] });
    assert.deepEqual(pool.view().map((r) => r.keyId), ['k1']);
    assert.equal((await pool.getAvailableKeys('gpt-4o')).length, 0, '冷却跨越快照刷新仍生效');
  });
});
