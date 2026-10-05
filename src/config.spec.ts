// 启动配置单测（`src/config.ts`）
//
// 这里只测**会 fail-fast 的那些项**，重点是新接上的 `COOLDOWN_LADDER_SECONDS`：
// 阶梯是"升档"语义，配错不会报错、只会让某把 key 冷却成 1ms 或被长期锁死，
// 症状看起来像"上游挂了"。所以非空 / 正整数 / 非递减三条不满足就必须拒绝启动。

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { loadConfig } from './config.js';

/** 32 字节 base64；`loadConfig` 会在缺它时先抛 CryptoConfigError，其余项就测不到了 */
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

function env(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { MASTER_KEY, ...over };
}

describe('COOLDOWN_LADDER_SECONDS', () => {
  it('缺省 / 空串用冻结常量 1m→5m→15m→30m', () => {
    assert.deepEqual(loadConfig(env()).cooldownLadderSeconds, [60, 300, 900, 1800]);
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '' })).cooldownLadderSeconds, [60, 300, 900, 1800]);
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '   ' })).cooldownLadderSeconds, [60, 300, 900, 1800]);
  });

  it('自定义阶梯按逗号切分并去空白', () => {
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '10, 30,60' })).cooldownLadderSeconds, [10, 30, 60]);
    assert.deepEqual(loadConfig(env({ COOLDOWN_LADDER_SECONDS: '5' })).cooldownLadderSeconds, [5], '只给一档也合法');
  });

  it('非数字 / 零 / 负数 / 空档位 / 递减 一律拒绝启动', () => {
    for (const bad of ['abc', '60,abc', '0', '60,0', '-30', '60,,120', ',', '1.5', '60,30', '300,60,900']) {
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
