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

  it('相等档位不算递减（允许 "60,60,300"）', () => {
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '60,60,300' })).cooldownLadderSeconds, [60, 60, 300]);
  });
});

describe('其余项仍然 fail-fast', () => {
  it('MAX_CONCURRENCY_PER_KEY=0 拒绝启动（会让池子恒"已满"）', () => {
    assert.throws(() => loadConfig(env({ MAX_CONCURRENCY_PER_KEY: '0' })), /MAX_CONCURRENCY_PER_KEY/);
  });
});
