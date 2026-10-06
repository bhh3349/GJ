// 启动配置单测（`src/config.ts`）
//
// 这里只测**会 fail-fast 的那些项**，重点是新接上的 `COOLDOWN_LADDER_SECONDS`：
// 阶梯是"升档"语义，配错不会报错、只会让某把 key 冷却成 1ms 或被长期锁死，
// 症状看起来像"上游挂了"。所以非空 / 非负整数 / 非递减三条不满足就必须拒绝启动。

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { loadConfig } from './config.js';
import { DEFAULT_COOLDOWN_LADDER_MS } from './gateway/cooldown.js';

/** 32 字节 base64；`loadConfig` 会在缺它时先抛 CryptoConfigError，其余项就测不到了 */
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { MASTER_KEY, ...over };
}

describe('COOLDOWN_LADDER_SECONDS', () => {
  it('缺省 / 空串用冻结常量 0→1m→5m→15m→30m', () => {
    const frozen = [0, 60, 300, 900, 1800];
    assert.deepEqual(loadConfig(env()).cooldownLadderSeconds, frozen);
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '' })).cooldownLadderSeconds, frozen);
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '   ' })).cooldownLadderSeconds, frozen);
  });

  /**
   * 回归：这条曾经是错的，而且**门禁全绿也看不出来**。
   *
   * `wiring/runtime.ts` 无条件把 `config.cooldownLadderSeconds` 灌进 `PoolOptions.cooldownLadderMs`，
   * 所以 env 未设时"默认路径"用的是配置层那份字面量，内核常量 `DEFAULT_COOLDOWN_LADDER_MS`
   * 在真实进程里一次都不会被用到。当时配置层默认写的是 `[60,300,900,1800]`
   * （"正整数"校验逼出来的，因为冻结阶梯的首档本就是 0），于是整条阶梯相对冻结值上移一档、
   * 首档的 0 也丢了：一次失败的 NETWORK key 被停 60s 而不是 15s，直接打在验收 ①②
   * （单 key 故障切换 <100ms、健康 key 占比 ≥10%）上，而单测断言写的正是那个错值，所以是绿的。
   *
   * 断言写成 `.map(s => s * 1000)` 而不是裸比较，是为了顺带钉死秒/毫秒的换算口径。
   */
  it('env 未设时，真实生效的阶梯逐项等于内核冻结常量（防档位/单位静默漂移）', () => {
    const effectiveMs = loadConfig(env()).cooldownLadderSeconds.map((s) => s * 1000);
    assert.deepEqual(effectiveMs, DEFAULT_COOLDOWN_LADDER_MS);
    assert.equal(effectiveMs[0], 0, '首档必须是 0：首次失败只吃该 reason 的基础冷却');
  });

  it('自定义阶梯按逗号切分并去空白', () => {
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '10, 30,60' })).cooldownLadderSeconds, [10, 30, 60]);
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '5' })).cooldownLadderSeconds, [5], '只给一档也合法');
  });

  it('首档 0 合法（冻结阶梯的首档就是 0，别判成非法）', () => {
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '0' })).cooldownLadderSeconds, [0]);
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '0,60,300' })).cooldownLadderSeconds, [0, 60, 300]);
  });

  it('非数字 / 负数 / 小数 / 空档位 / 递减 一律拒绝启动', () => {
    for (const bad of ['abc', '60,abc', '-30', '0,-30', '60,0', '60,,120', ',', '1.5', '60,30', '300,60,900']) {
      assert.throws(
        () => loadConfig(env({ COOLDOWN_LADDER_SECONDS: bad })),
        /COOLDOWN_LADDER_SECONDS/,
        `${JSON.stringify(bad)} 必须被拒绝，而不是读进来变成奇怪的行为`,
      );
    }
  });

  /**
   * 回归：档位只认十进制字面量。
   *
   * 这些形状用 `Number` 全都能算出**合法的非负整数**——`0x10`=16、`1e3`=1000、
   * `60.0`=60、`+30`=30、`-0` 还满足 `n < 0` 为假——于是"配错"被静默吞成
   * "另一个档位"，冷却时长不对但门禁全绿。收紧了才好，配错就必须起不来。
   */
  it('非十进制字面量一律拒绝启动（0x / 科学计数 / 小数 / 正号 / -0）', () => {
    for (const bad of ['0x10', '0,1e3', '60.0', '+30', '-0', '0x1e']) {
      assert.throws(
        () => loadConfig(env({ COOLDOWN_LADDER_SECONDS: bad })),
        /COOLDOWN_LADDER_SECONDS/,
        `${JSON.stringify(bad)} 用 Number 能算出数，但显然不是配置本意，必须 fail-fast`,
      );
    }
  });

  it('相等档位不算递减（允许 "60,60,300"）', () => {
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '60,60,300' })).cooldownLadderSeconds, [60, 60, 300]);
  });
});

describe('READONLY_TOKEN（契约 §12.4 / ADR-0013）', () => {
  it('缺省 / 空串 / 纯空白 → null（= 关闭，v1.0 语义原样）', () => {
    assert.equal(loadConfig(env()).readonlyToken, null);
    assert.equal(loadConfig(env({ READONLY_TOKEN: '' })).readonlyToken, null);
    assert.equal(loadConfig(env({ READONLY_TOKEN: '   ' })).readonlyToken, null);
  });

  it('配了就原样带出（两侧空白去掉），与 ADMIN_TOKEN 互不隶属', () => {
    assert.equal(loadConfig(env({ READONLY_TOKEN: ' ro-1 ' })).readonlyToken, 'ro-1');
    const both = loadConfig(env({ ADMIN_TOKEN: 'ci-1', READONLY_TOKEN: 'ro-1' }));
    assert.equal(both.adminToken, 'ci-1');
    assert.equal(both.readonlyToken, 'ro-1');
  });

  /**
   * 这条是本项存在的全部意义：两把令牌同值 = 隔离归零。
   * 刻意选**拒绝启动**而不是"以管理员为准"——静默取其一，部署者会以为
   * "观测令牌已经和会话隔离了"，而拿到观测令牌的人其实就是管理员。
   * 与 MASTER_KEY 缺失即拒绝启动同款纪律：安全配置的错误不能降级成运行期行为差异。
   */
  it('与 ADMIN_TOKEN 同值 → 拒绝启动（不是静默取其一）', () => {
    assert.throws(
      () => loadConfig(env({ ADMIN_TOKEN: 'same-1', READONLY_TOKEN: 'same-1' })),
      /READONLY_TOKEN/,
    );
    // 去空白之后才比较：`'same-1 '` 与 `'same-1'` 是同一把，不能因为空格绕过
    assert.throws(() => loadConfig(env({ ADMIN_TOKEN: 'same-1', READONLY_TOKEN: ' same-1 ' })), /READONLY_TOKEN/);
    // 只配一把时不触发（另一把是 null，谈不上"同值"）
    assert.equal(loadConfig(env({ READONLY_TOKEN: 'same-1' })).readonlyToken, 'same-1');
  });
});

describe('HEALTH_SNAPSHOT_RETENTION_DAYS', () => {
  it('缺省 90 天（快照 60s 一条，量级远小于日志，给得比日志宽）', () => {
    assert.equal(loadConfig(env()).healthSnapshotRetentionDays, 90);
    assert.equal(loadConfig(env({ HEALTH_SNAPSHOT_RETENTION_DAYS: '' })).healthSnapshotRetentionDays, 90);
    assert.equal(loadConfig(env({ HEALTH_SNAPSHOT_RETENTION_DAYS: '7' })).healthSnapshotRetentionDays, 7);
  });

  /**
   * 0/负数会被读成"每次写入立刻清空历史"，而历史序列正是这个功能唯一的产品；
   * 症状是"快照表一直是空的"，看不出是配置打错。按 positiveIntFromEnv 拒绝启动。
   */
  it('0 / 负数 / 非十进制字面量 → 拒绝启动（0 会让历史恒为空）', () => {
    assert.throws(() => loadConfig(env({ HEALTH_SNAPSHOT_RETENTION_DAYS: '0' })), /HEALTH_SNAPSHOT_RETENTION_DAYS/);
    assert.throws(() => loadConfig(env({ HEALTH_SNAPSHOT_RETENTION_DAYS: '-3' })), /HEALTH_SNAPSHOT_RETENTION_DAYS/);
    assert.throws(() => loadConfig(env({ HEALTH_SNAPSHOT_RETENTION_DAYS: '1e2' })), /HEALTH_SNAPSHOT_RETENTION_DAYS/);
  });
});

describe('其余项仍然 fail-fast', () => {
  it('MAX_CONCURRENCY_PER_KEY=0 拒绝启动（会让池子恒"已满"）', () => {
    assert.throws(() => loadConfig(env({ MAX_CONCURRENCY_PER_KEY: '0' })), /MAX_CONCURRENCY_PER_KEY/);
  });

  /**
   * 回归：`Number(raw)` 的接受面比"配置项"宽得多，而且**全部静默**。
   * `0x10`→16、`1e3`→1000 会被原样收下；`30.9` 更阴——先被 `Math.floor` 截成 30
   * （日志保留天数），字面量写错了，进程照起，谁也没法从行为上看出来。
   * 这些形状必须在启动时打脸，而不是变成另一个数。
   */
  it('非十进制整数字面量一律拒绝启动（0x / 科学计数 / 小数）', () => {
    assert.throws(() => loadConfig(env({ PORT_GATEWAY: '0x10' })), /PORT_GATEWAY/);
    assert.throws(() => loadConfig(env({ SESSION_TTL_HOURS: '1e3' })), /SESSION_TTL_HOURS/);
    assert.throws(() => loadConfig(env({ LOG_RETENTION_DAYS: '30.9' })), /LOG_RETENTION_DAYS/);
    assert.throws(() => loadConfig(env({ MAX_ATTEMPTS: '3.5' })), /MAX_ATTEMPTS/);
    assert.throws(() => loadConfig(env({ MAX_ATTEMPTS: '-1' })), /MAX_ATTEMPTS/, '负数归 >=1 那条管，不归字面量这条');
  });

  it('十进制整数照旧生效（收紧不误伤正常写法，两侧空白仍去）', () => {
    assert.equal(loadConfig(env({ PORT_GATEWAY: '8080' })).portGateway, 8080);
    assert.equal(loadConfig(env({ PORT_ADMIN: ' 4002 ' })).portAdmin, 4002);
    assert.equal(loadConfig(env({ LOG_RETENTION_DAYS: '030' })).logRetentionDays, 30);
  });
});
