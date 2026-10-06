/**
 * 内置 AI 助手 - 首字（TTFB）增量实测（契约 v1.2.0 §13 / ADR-0015 §7）
 *
 * 口径（同机配对采样，与 `bench:ttfb` 保持同构，只是多一列）：
 *   - 直连：client ──fetch──▶ mock upstream SSE，量「发出请求 → 读到第一块字节」
 *   - 经引擎：client ──engine──▶ mock upstream，量「发出请求 → 拿到流的第一块字节」
 *   - 助手：`createAssistantInvoker().stream()` 量「发出请求 → 第一个 `delta` 事件」
 *   两个增量：`engine − direct`（网关自身开销）、`assistant − engine`（**助手透传层增量**，
 *   即 SSE 逐行解析 + 事件装箱这段）。助手侧的验收判据看后者。
 *
 * **不设闸**（PM 口径：首字不设闸、只记数）：本脚本恒 exit 0，输出就是记录本身。
 * 阈值心里有数即可 —— 验收 §8 对透传层的要求是增量 < 5ms；`bench:ttfb` 才是带闸的那把尺子。
 *
 * mock 上游注入固定首帧延迟：没有它，增量落在事件循环抖动里，量出来的是噪声不是开销。
 *
 * 运行：pnpm bench:assistant-ttfb
 * 环境变量：BENCH_BATCHES（默认 5，≥3）/ BENCH_SAMPLES_PER_BATCH（默认 50，≥20）/
 *          BENCH_UPSTREAM_DELAY_MS（默认 20）
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createAssistantMetrics, createAssistantInvoker } from '../src/wiring/assistant-invoker.js';
import { createGatewayEngine } from '../src/gateway/engine.js';
import { createKeyPool } from '../src/gateway/key-pool.js';
import type { KeyPoolInternal } from '../src/gateway/key-pool.js';
import type { GroupContext, ModelCatalog, SecretResolver } from '../src/gateway/ports.js';
import type { KeyConfig, PoolSnapshot } from '../src/gateway/types.js';
import { generateRequestId } from '../src/util/request-id.js';

/* ------------------------------ 参数 ------------------------------ */

const UPSTREAM_DELAY_MS = intEnv('BENCH_UPSTREAM_DELAY_MS', 20, 1);
const BATCHES = intEnv('BENCH_BATCHES', 5, 3);
const SAMPLES_PER_BATCH = intEnv('BENCH_SAMPLES_PER_BATCH', 50, 20);
const WARMUP = 10;

const MODEL = 'gpt-4o-mini';

function intEnv(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`[bench:assistant-ttfb] 环境变量 ${name}=${raw} 非法：需要 ≥${min} 的整数`);
  }
  return value;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] ?? 0;
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (idx - lo);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  if (Number.isInteger(mid)) return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return sorted[Math.floor(mid)] ?? 0;
}

function fmt(v: number): string {
  return v.toFixed(3);
}

/* ------------------------------ mock 上游（SSE） ------------------------------ */

const FIRST_FRAME = `data: ${JSON.stringify({ choices: [{ delta: { content: '好' } }] })}\n\n`;
const DONE_FRAME = 'data: [DONE]\n\n';

function mockUpstream(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    req.resume(); // 不消费请求体：小 body 无所谓，但别让 socket 背压挂在那儿
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    setTimeout(() => {
      res.write(FIRST_FRAME);
      res.write(DONE_FRAME);
      res.end();
    }, UPSTREAM_DELAY_MS);
  });
  return listen(server).then((port) => ({
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }));
}

/* ------------------------------ 被测装配 ------------------------------ */

const GROUP: GroupContext = {
  groupId: 'grp_assistant_bench',
  name: '助手首字基准',
  enabled: true,
  rpm: null,
  tpm: null,
  dailyQuota: null,
};

const KEY: KeyConfig = {
  keyId: 'k1',
  upstreamId: 'up1',
  category: 'balance',
  status: 'enabled',
  weight: 1,
  models: null,
  balanceCents: null,
  tokenPlanRemainingTokens: null,
  tokenPlanExpiresAt: null,
};

const SNAPSHOT: PoolSnapshot = {
  revision: 1,
  upstreams: [{ upstreamId: 'up1', enabled: true, models: null }],
  keys: [KEY],
};

const models: ModelCatalog = { listEnabledModels: async () => [], resolveUpstreamModel: (m) => m };

function secretsOver(baseUrl: string): SecretResolver {
  return { resolve: () => ({ upstreamId: 'up1', baseUrl, apiKey: 'sk-bench' }) };
}

function newPool(): KeyPoolInternal {
  const pool = createKeyPool();
  pool.applySnapshot(SNAPSHOT);
  return pool;
}

const BODY = { model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true };

/* ------------------------------ 三条测量路径 ------------------------------ */

async function firstDirect(url: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(BODY),
  });
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error('直连上游没有 body');
  await reader.read(); // 第一块字节 = 首字
  const ms = performance.now() - t0;
  await reader.cancel();
  return ms;
}

async function firstViaEngine(engine: ReturnType<typeof createGatewayEngine>): Promise<number> {
  const t0 = performance.now();
  const result = await engine.chatCompletions({
    group: GROUP,
    model: MODEL,
    body: BODY,
    stream: true,
    requestId: generateRequestId(),
  });
  if (result.kind !== 'stream') throw new Error(`经引擎没拿到流：kind=${result.kind}`);
  const reader = result.body.getReader();
  await reader.read();
  const ms = performance.now() - t0;
  await reader.cancel();
  return ms;
}

async function firstViaAssistant(invoker: ReturnType<typeof createAssistantInvoker>): Promise<number> {
  const t0 = performance.now();
  const controller = new AbortController();
  let ms = -1;
  for await (const event of invoker.stream([{ role: 'user', content: 'hi' }], controller.signal)) {
    if (event.kind === 'delta') {
      ms = performance.now() - t0;
      break; // 提前收工：剩下的帧与首字无关
    }
    if (event.kind === 'error') throw new Error(`助手终止帧：${event.code}`);
  }
  if (ms < 0) throw new Error('助手没吐 delta');
  controller.abort(); // 早退 → invoker 的 finally 会放开上游流
  return ms;
}

/* ------------------------------ 主流程 ------------------------------ */

interface Batch {
  direct: number[];
  engine: number[];
  assistant: number[];
  dEngine: number; // 该轮 engine−direct 的 P50
  dAssistant: number; // 该轮 assistant−engine 的 P50
}

async function runBatch(directUrl: string, engine: ReturnType<typeof createGatewayEngine>, invoker: ReturnType<typeof createAssistantInvoker>): Promise<Batch> {
  const direct: number[] = [];
  const engineMs: number[] = [];
  const assistant: number[] = [];
  for (let i = 0; i < SAMPLES_PER_BATCH; i += 1) {
    const d = await firstDirect(directUrl);
    const e = await firstViaEngine(engine);
    const a = await firstViaAssistant(invoker);
    direct.push(d);
    engineMs.push(e);
    assistant.push(a);
  }
  const dEngine = percentile([...direct.map((d, i) => (engineMs[i] ?? 0) - d)].sort((x, y) => x - y), 0.5);
  const dAssistant = percentile([...engineMs.map((e, i) => (assistant[i] ?? 0) - e)].sort((x, y) => x - y), 0.5);
  return { direct, engine: engineMs, assistant, dEngine, dAssistant };
}

async function main(): Promise<void> {
  const upstream = await mockUpstream();
  const baseUrl = `http://127.0.0.1:${upstream.port}/v1`;
  const directUrl = `${baseUrl}/chat/completions`;

  const pool = newPool();
  const engine = createGatewayEngine({ pool, secrets: secretsOver(baseUrl), models, maxAttempts: 1 });
  const invoker = createAssistantInvoker({
    pool,
    secrets: secretsOver(baseUrl),
    models,
    model: MODEL,
    metrics: createAssistantMetrics(),
    maxAttempts: 1,
  });

  try {
    for (let i = 0; i < WARMUP; i += 1) {
      await firstDirect(directUrl);
      await firstViaEngine(engine);
      await firstViaAssistant(invoker);
    }

    const batches: Batch[] = [];
    for (let i = 0; i < BATCHES; i += 1) batches.push(await runBatch(directUrl, engine, invoker));

    const incEngine = median(batches.map((b) => b.dEngine));
    const incAssistant = median(batches.map((b) => b.dAssistant));
    const allDirect = batches.flatMap((b) => b.direct).sort((a, b) => a - b);
    const allEngine = batches.flatMap((b) => b.engine).sort((a, b) => a - b);
    const allAssistant = batches.flatMap((b) => b.assistant).sort((a, b) => a - b);

    // eslint-disable-next-line no-console
    console.log(
      [
        `[bench:assistant-ttfb] 同机直连 vs 经引擎 vs 助手  ${BATCHES} 轮 × ${SAMPLES_PER_BATCH} 对 = ${BATCHES * SAMPLES_PER_BATCH} 样本  upstream_delay=${UPSTREAM_DELAY_MS}ms  配对序=直连→引擎→助手`,
        ...batches.map((b, i) => `    #${i + 1}  Δ(engine)${fmt(b.dEngine)}ms  Δ(assistant)${fmt(b.dAssistant)}ms`),
        `  直连(合并)   P50=${fmt(percentile(allDirect, 0.5))}ms  P99=${fmt(percentile(allDirect, 0.99))}ms`,
        `  经引擎(合并) P50=${fmt(percentile(allEngine, 0.5))}ms  P99=${fmt(percentile(allEngine, 0.99))}ms`,
        `  助手(合并)   P50=${fmt(percentile(allAssistant, 0.5))}ms  P99=${fmt(percentile(allAssistant, 0.99))}ms`,
        `  增量 引擎−直连       P50=${fmt(incEngine)}ms   (多轮中位数)`,
        `  增量 助手−引擎(透传层) P50=${fmt(incAssistant)}ms   (多轮中位数，验收口径参考 5ms，本脚本不设闸)`,
      ].join('\n'),
    );
    // 不设闸：exit 0。这条输出本身就是记录（PM 口径：首字不设闸、只记数）。
  } finally {
    await upstream.close();
  }
}

void main();
