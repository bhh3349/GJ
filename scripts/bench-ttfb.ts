/**
 * 网关内核 - TTFB 增量基准（§九.3 / §8 验收证据）
 * 冻结依据：docs/dev-constraints.md §六（`pnpm bench:ttfb` 语义）、docs/需求文档-v1.1.md §九.3
 *
 * 测量口径（性能类验收必须报「同机直连对比」，不接受只有绝对值）：
 *   - 直连：client ──fetch──▶ mock upstream，量「发出请求 → 收到响应头」这段 TTFB
 *   - 经网关：client ──fetch──▶ Fastify gateway（真实 engine + 真实 key pool）──▶ mock upstream
 *   - 增量：每一轮**配对采样** delta = gateway TTFB − direct TTFB
 *
 * mock upstream 故意注入 20ms 固定延迟，把 TTFB 抬到可测、可复现的量级：
 * 没有它，全链路 TTFB 是微秒级噪声，增量反而被事件循环抖动淹没，测不出「网关自身开销」。
 *
 * ── 采样结构（2026-10-06 M6-B 升级：多轮取中位数 + 抖动带）────────────────────
 * 旧口径是**单次采样**：一次跑满 N 对，对合并样本取一个 ΔP50 去撞 1ms 阈值。
 * 问题（路由者在 M6-A 收口时实测到）：ΔP50 实测 0.819ms / 0.960ms，余量只剩 0.04ms，
 * 判定完全吃单次噪声 —— 某一次跑遇到一次 GC 或调度抖动就把闸翻红，且翻红后无法自证是噪声还是回归。
 *
 * 新口径：分成 BATCHES 轮，每轮独立采样 SAMPLES_PER_BATCH 对，**每轮各自算 ΔP50 / ΔP99**，
 *   判据统计量 = **多轮的中位数**（默认 5 轮 → 正中间那一轮，对单轮离群免疫）；
 *   同时打印**抖动带**（跨轮 min–max 与 P25–P75）—— 它是给人看的稳定性证据，**不参与 exit 码**。
 * 阈值本身不变（仍是 §8 冻结的 ΔP50≤1ms / ΔP99≤5ms），只是**被比较的对象**从「单次样本」换成「多轮中位数」。
 *
 * 配对序刻意保持「直连→网关」不变：与 M6-A 基线（0.819ms / 0.960ms）保持同口径可比，
 * 本次升级只动统计量、不动测量本身。轮内/轮间不做顺序交替（那会引入与基线不可比的口径变更）。
 *
 * 判据（§8 冻结阈值，比 §九.3 的「P50 < 5ms」更严）：
 *   median(逐轮 ΔP50) ≤ 1ms 且 median(逐轮 ΔP99) ≤ 5ms → exit 0；任一不满足 → exit 1
 *
 * 运行：pnpm bench:ttfb
 * 环境变量（仅供本机/CI 调时长，**阈值不可配**）：
 *   BENCH_BATCHES（默认 5，≥3）、BENCH_SAMPLES_PER_BATCH（默认 100，≥20）、BENCH_UPSTREAM_DELAY_MS（默认 20）
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import Fastify from 'fastify';

import { createGatewayStack, gatewayRoutes } from '../src/gateway/index.js';
import type {
  GatewayAuth,
  GroupContext,
  KeyConfig,
  ModelCatalog,
  PoolSnapshot,
  SecretResolver,
  UpstreamTarget,
} from '../src/gateway/index.js';

/* ------------------------------ 参数 ------------------------------ */

/** mock 上游固定延迟（ms）：把 TTFB 抬到可测量级，别改成 0 */
const UPSTREAM_DELAY_MS = intEnv('BENCH_UPSTREAM_DELAY_MS', 20, 1);
/** 轮数：每轮独立采样 + 独立算分位，最后对「逐轮 ΔP50/ΔP99」取中位数。≥3 才谈得上抗离群 */
const BATCHES = intEnv('BENCH_BATCHES', 5, 3);
/** 每轮配对样本数：100 对足以把该轮的 P99 压稳，再乘轮数取中位数 */
const SAMPLES_PER_BATCH = intEnv('BENCH_SAMPLES_PER_BATCH', 100, 20);
/** 正式采样前的热身请求数：吃满连接复用、逼 JIT 与 Fastify 路由缓存热起来 */
const WARMUP = 20;

/* ----------------- 冻结阈值（§8；硬编码，不接受环境变量，免得闸被改成绿） ----------------- */

const DELTA_P50_MAX_MS = 1;
const DELTA_P99_MAX_MS = 5;

/* ------------------------------ 桩 ------------------------------ */

const GROUP: GroupContext = {
  groupId: 'grp_bench',
  name: 'TTFB 基准',
  enabled: true,
  rpm: null,
  tpm: null,
  dailyQuota: null,
};

const auth: GatewayAuth = {
  async authenticate(): Promise<GroupContext> {
    return GROUP;
  },
};

/* ------------------------------ 小工具 ------------------------------ */

/**
 * 读一个正整数环境变量，缺失取默认；给了但不合法（非整数 / 小于下界）直接抛 ——
 * 悄悄回落到默认值会让「我明明调了 200 轮」变成一个查不出来的坑。
 */
function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`[bench:ttfb] 环境变量 ${name}=${raw} 非法：需要 ≥${min} 的整数`);
  }
  return value;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve(port);
    });
  });
}

/** 百分位（linear interpolation） */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (idx - lo);
}

/** 中位数：不改入参（拷一份排序）；偶数个取中间两个的均值 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  if (Number.isInteger(mid)) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[Math.floor(mid)] ?? 0;
}

/** 抖动带：min / max / P25 / P75，全部来自同一份排序样本 */
function jitterBand(values: readonly number[]): { min: number; max: number; p25: number; p75: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
  };
}

function fmt(v: number): string {
  return v.toFixed(3);
}

/* ------------------------------ mock 上游 ------------------------------ */

function mockUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const body: unknown = {
      id: 'cmpl_bench',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    };
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(JSON.stringify(body).length) });
      res.end(JSON.stringify(body));
    }, UPSTREAM_DELAY_MS);
  });
  return listen(server).then((port) => ({
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }));
}

/* ------------------------------ 网关 ------------------------------ */

function keyConfig(upstreamId: string): KeyConfig {
  return {
    keyId: 'k1',
    upstreamId,
    category: 'balance',
    status: 'enabled',
    weight: 1,
    models: null,
    balanceCents: null,
    tokenPlanRemainingTokens: null,
    tokenPlanExpiresAt: null,
  };
}

function snapshot(upstreamId: string): PoolSnapshot {
  return {
    revision: 1,
    upstreams: [{ upstreamId, enabled: true, models: null }],
    keys: [keyConfig(upstreamId)],
  };
}

async function buildGateway(upstreamBase: string): Promise<{ port: number; close: () => Promise<void> }> {
  const secrets: SecretResolver = {
    resolve(): UpstreamTarget {
      return { upstreamId: 'up1', baseUrl: upstreamBase, apiKey: 'sk-bench' };
    },
  };
  const models: ModelCatalog = {
    listEnabledModels: async () => [],
    resolveUpstreamModel: (m) => m,
  };

  const stack = createGatewayStack({ secrets, models, auth });
  stack.pool.applySnapshot(snapshot('up1'));

  const app = Fastify({ logger: false });
  await app.register(gatewayRoutes, stack.routes);
  // listen({ port: 0 }) 让 OS 挑空闲端口；Fastify 的 listen resolve 值是 URL 字符串，
  // 要拿到端口得读底层 http server 的 address()
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;

  return { port, close: () => app.close() };
}

/* ------------------------------ 测量 ------------------------------ */

const BODY = JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
const HEADERS = { 'content-type': 'application/json', authorization: 'Bearer gw-test' };

async function ttfb(url: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(url, { method: 'POST', headers: HEADERS, body: BODY });
  // fetch 在「响应头到达」时 resolve —— 这正是 TTFB 口径，与引擎 `ttfbMs = now() - started` 同源
  const ttfbMs = performance.now() - t0;
  await res.text(); // 消费 body 释放连接，让 keep-alive 复用生效
  return ttfbMs;
}

interface Batch {
  /** 该轮逐对 delta（gateway − direct），保持与直连/网关样本同序 */
  delta: number[];
  /** 该轮合并样本的绝对耗时，仅用于打印 */
  direct: number[];
  via: number[];
  /** 该轮自身的分位（未排序的原始样本进来，出参已排序） */
  incP50: number;
  incP99: number;
}

/** 跑一轮：rounds 对配对采样，返回该轮样本与分位 */
async function runBatch(directUrl: string, gatewayUrl: string, rounds: number): Promise<Batch> {
  const direct: number[] = [];
  const via: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < rounds; i += 1) {
    const d = await ttfb(directUrl);
    const g = await ttfb(gatewayUrl);
    direct.push(d);
    via.push(g);
    delta.push(g - d);
  }
  delta.sort((a, b) => a - b);
  const batch: Batch = {
    delta,
    direct: [...direct].sort((a, b) => a - b),
    via: [...via].sort((a, b) => a - b),
    incP50: percentile(delta, 0.5),
    incP99: percentile(delta, 0.99),
  };
  if (batch.delta.length !== rounds) {
    // 采样数对不齐就不许出结论（分位数是静默失真的那一类错误）
    throw new Error(`[bench:ttfb] 轮内样本数异常：期望 ${rounds}，实得 ${batch.delta.length}`);
  }
  return batch;
}

async function main(): Promise<void> {
  const upstream = await mockUpstream();
  const upstreamBase = `http://127.0.0.1:${upstream.port}/v1`;
  const directUrl = `${upstreamBase}/chat/completions`;
  const gateway = await buildGateway(upstreamBase);
  const gatewayUrl = `http://127.0.0.1:${gateway.port}/v1/chat/completions`;

  try {
    // 热身
    for (let i = 0; i < WARMUP; i += 1) {
      await ttfb(directUrl);
      await ttfb(gatewayUrl);
    }

    const batches: Batch[] = [];
    for (let i = 0; i < BATCHES; i += 1) {
      batches.push(await runBatch(directUrl, gatewayUrl, SAMPLES_PER_BATCH));
    }

    // 判据统计量 = 逐轮分位的**中位数**（对单轮离群免疫）
    const incP50PerBatch = batches.map((b) => b.incP50);
    const incP99PerBatch = batches.map((b) => b.incP99);
    const incP50 = median(incP50PerBatch);
    const incP99 = median(incP99PerBatch);
    const band50 = jitterBand(incP50PerBatch);
    const band99 = jitterBand(incP99PerBatch);

    // 合并样本只用于展示绝对值（判据不用它 —— 它是单次采样口径的遗留）
    const allDirect = batches.flatMap((b) => b.direct).sort((a, b) => a - b);
    const allVia = batches.flatMap((b) => b.via).sort((a, b) => a - b);

    const perBatchLines = batches.map((b, i) => `    #${i + 1}  ΔP50=${fmt(b.incP50)}  ΔP99=${fmt(b.incP99)}`);

    // eslint-disable-next-line no-console
    console.log(
      [
        `[bench:ttfb] 同机直连 vs 经网关  ${BATCHES} 轮 × ${SAMPLES_PER_BATCH} 对 = ${BATCHES * SAMPLES_PER_BATCH} 样本  upstream_delay=${UPSTREAM_DELAY_MS}ms  配对序=直连→网关`,
        `  逐轮增量`,
        ...perBatchLines,
        `  直连(合并)   P50=${fmt(percentile(allDirect, 0.5))}ms  P99=${fmt(percentile(allDirect, 0.99))}ms`,
        `  经网关(合并) P50=${fmt(percentile(allVia, 0.5))}ms  P99=${fmt(percentile(allVia, 0.99))}ms`,
        `  增量  P50=${fmt(incP50)}ms  P99=${fmt(incP99)}ms  (多轮中位数，判据口径)`,
        `  抖动带(提示，不参与判据)  ΔP50 ${fmt(band50.min)}~${fmt(band50.max)}ms  [P25~P75 ${fmt(band50.p25)}~${fmt(band50.p75)}]`,
        `                              ΔP99 ${fmt(band99.min)}~${fmt(band99.max)}ms  [P25~P75 ${fmt(band99.p25)}~${fmt(band99.p75)}]`,
      ].join('\n'),
    );

    const passP50 = incP50 <= DELTA_P50_MAX_MS;
    const passP99 = incP99 <= DELTA_P99_MAX_MS;
    const pass = passP50 && passP99;

    // 抖动带只提示，不翻闸：单轮超阈值正是旧口径的假红来源，这里把它显示出来但仍然按中位数判。
    // 判据已经判完了再写这句 —— 否则 FAIL 的时候还印「未翻转」就是自相矛盾的输出。
    const over50 = incP50PerBatch.filter((v) => v > DELTA_P50_MAX_MS).length;
    const over99 = incP99PerBatch.filter((v) => v > DELTA_P99_MAX_MS).length;
    if (over50 > 0 || over99 > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[bench:ttfb] 提示 超出单轮阈值的轮次：ΔP50 ${over50}/${BATCHES}、ΔP99 ${over99}/${BATCHES}` +
          (pass
            ? ' —— 判据取中位数故未翻转；若持续超标说明余量不足，请查回归而非噪声'
            : ' —— 中位数亦已越线，属实质劣化'),
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[bench:ttfb] 判据（逐轮中位数）ΔP50≤${DELTA_P50_MAX_MS}ms / ΔP99≤${DELTA_P99_MAX_MS}ms → ${pass ? 'PASS' : 'FAIL'}`,
    );
    if (!pass) process.exitCode = 1;
  } finally {
    await gateway.close();
    await upstream.close();
  }
}

void main();
