// 账号级节奏队列（契约 §15.5）。
//
// §15.5 的表述是"节奏与礼貌（不是性能问题，是能不能长期跑的问题）"—— 它防的不是慢，
// 是**被供应商风控带走**。所以这里做两件**分开**的事，别把两件并成一件：
//
//   1. **起跑间隔**：相邻两次"起跑"至少隔 `gapMs`。§15.5 的 0.6s 说的是这个 ——
//      它是**每账号**的礼貌间隔，不是并发度。
//   2. **并发上限**：同时最多几个账号在跑。§15.5 明写**复用 `REFRESH_CONCURRENCY`**，
//      "不新拍一个数，避免手动/自动漂成两个并发度" —— 所以本模块**不提供默认值**，
//      并发度是必填项，绑定点只有一个（接线处传 `REFRESH_CONCURRENCY`）。
//
// 两条必须都有：27 个账号并发重登就是自己撞自己的登录接口，也正是站点风控最容易抓的形状。
//
// ⚠️ §15.5 那条 0.6s 的**依据已降级**（v1.4.8）：它只在"单出口 + 当时那种请求密度"下成立，
// 对**按 IP 计数**的限流不成立。出口级速率见 §16.7 Tier 1.5（值待实测标定）。
// 本模块管得住账号，管不住出口 —— 别把它当成出口级限流。
//
// `now` / `sleep` 是注入的，所以全部节流用例离线跑，不必真的等 0.6 秒。

/** §15.5 表内的账号间间隔（当前实现值）。 */
export const ACCOUNT_GAP_MS = 600;

export interface AccountQueueOptions {
  /** 同时在跑的账号数上限。**必填**，接线处传 `REFRESH_CONCURRENCY`（§15.5）。 */
  concurrency: number;
  /** 相邻两次起跑的最小间隔，默认 `ACCOUNT_GAP_MS`。 */
  gapMs?: number;
  /** 注入时钟，测试用。 */
  now?: () => number;
  /** 注入睡眠，测试用。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface AccountQueue {
  /** 排队跑一个账号的活。**任务的异常照常向上抛** —— 队列不该吞掉调用方的错。 */
  run<T>(task: () => Promise<T>): Promise<T>;
  /** 当前在跑 + 在等的任务数。只为观测，不参与判定。 */
  readonly pending: number;
}

export function createAccountQueue(options: AccountQueueOptions): AccountQueue {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error(`账号级队列的并发度必须是正整数，收到 ${String(options.concurrency)}`);
  }
  const concurrency = options.concurrency;
  const gapMs = options.gapMs ?? ACCOUNT_GAP_MS;
  const now = options.now ?? ((): number => Date.now());
  const sleep =
    options.sleep ?? ((ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  /** 已入场（在跑 + 在等）的任务数。释放一个就放行一个，所以它偏大不偏离。 */
  let entered = 0;
  const waiters: Array<() => void> = [];

  /** 下一次允许起跑的最早时刻。`null` = 还没有人起跑过，第一个不等待。 */
  let nextAllowedStart: number | null = null;
  /**
   * 起跑时刻的串行化闸。
   *
   * 不加它就会漏：两个任务**同时**读到 `nextAllowedStart = null`，于是同时起跑 ——
   * 间隔看起来是实现了，实际只在串行调用时才生效。把"读时间 → 算等待 → 记新时刻"
   * 串成一条链，是让间隔在并发下也成立的唯一写法。
   */
  let reserveChain: Promise<void> = Promise.resolve();

  function reserveStart(): Promise<void> {
    const mine = reserveChain.then(async () => {
      const current = now();
      const wait = nextAllowedStart === null ? 0 : nextAllowedStart - current;
      if (wait > 0) await sleep(wait);
      nextAllowedStart = now() + gapMs;
    });
    reserveChain = mine;
    return mine;
  }

  async function acquireSlot(): Promise<void> {
    entered += 1;
    if (entered <= concurrency) return;
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  function releaseSlot(): void {
    entered -= 1;
    const next = waiters.shift();
    if (next !== undefined) next();
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      await acquireSlot();
      try {
        await reserveStart();
        return await task();
      } finally {
        releaseSlot();
      }
    },
    get pending(): number {
      return entered;
    },
  };
}
