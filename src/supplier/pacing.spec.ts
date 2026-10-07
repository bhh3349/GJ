// 账号级节奏队列的离线用例（契约 §15.5）。
//
// 时钟与睡眠都是注入的，所以这里**不必真的等 0.6 秒** —— 用例跑的是判定逻辑，
// 不是 setTimeout 的精度。

import { describe, expect, it } from 'vitest';
import { ACCOUNT_GAP_MS, createAccountQueue } from './pacing.js';

/** 手动时钟：只有 sleep 被调用时才前进，断言因此是确定的。 */
function manualClock(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    slept,
  };
}

describe('账号级节奏队列（§15.5）', () => {
  it('第一个任务不等待 —— 一上来先等 0.6s 是把礼貌做成了延迟', async () => {
    const clock = manualClock();
    const queue = createAccountQueue({ concurrency: 1, now: clock.now, sleep: clock.sleep });
    await queue.run(async () => 'ok');
    expect(clock.slept).toEqual([]);
  });

  it('串行时相邻两次起跑隔 0.6s', async () => {
    const clock = manualClock();
    const queue = createAccountQueue({ concurrency: 1, now: clock.now, sleep: clock.sleep });
    await queue.run(async () => 'a');
    await queue.run(async () => 'b');
    await queue.run(async () => 'c');
    expect(clock.slept).toEqual([ACCOUNT_GAP_MS, ACCOUNT_GAP_MS]);
  });

  it('并发时也隔 —— 两个任务同时起跑是这条纪律最容易漏的破法', async () => {
    const clock = manualClock();
    const queue = createAccountQueue({ concurrency: 4, now: clock.now, sleep: clock.sleep });
    await Promise.all([
      queue.run(async () => 'a'),
      queue.run(async () => 'b'),
      queue.run(async () => 'c'),
      queue.run(async () => 'd'),
    ]);
    // 4 个任务、首個不等 ⇒ 共 3 次间隔。
    expect(clock.slept).toEqual([ACCOUNT_GAP_MS, ACCOUNT_GAP_MS, ACCOUNT_GAP_MS]);
  });

  it('并发上限生效：同时最多 concurrency 个在跑', async () => {
    const queue = createAccountQueue({ concurrency: 2, gapMs: 0, sleep: () => Promise.resolve() });
    let running = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      running -= 1;
    };
    await Promise.all([queue.run(task), queue.run(task), queue.run(task), queue.run(task), queue.run(task)]);
    expect(peak).toBe(2);
  });

  it('任务抛错照常向上抛，且不卡住队列', async () => {
    const queue = createAccountQueue({ concurrency: 1, gapMs: 0, sleep: () => Promise.resolve() });
    await expect(queue.run(async () => Promise.reject(new Error('上游炸了')))).rejects.toThrow('上游炸了');
    await expect(queue.run(async () => 'after')).resolves.toBe('after');
  });

  it('并发度必填且必须是正整数 —— §15.5 要求复用 REFRESH_CONCURRENCY，不给默认值就不会偷偷漂成第二个数', () => {
    expect(() => createAccountQueue({ concurrency: 0 })).toThrow();
    expect(() => createAccountQueue({ concurrency: -1 })).toThrow();
    expect(() => createAccountQueue({ concurrency: 1.5 })).toThrow();
  });
});
