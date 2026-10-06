/**
 * 网关内核 - TierFlow 数据面探针（M6-D / S1 待钉项）
 * 冻结依据：docs/api-contract.md §10「失败枚举」；classify.ts 顶注释的「铁律」段
 *
 * ── 这个脚本要回答的两个问题 ───────────────────────────────────────────────
 * 1. **数据面路径存在吗？** TierFlow 文档里出现过 `/api/token/`、`/api/user/login`、
 *    `/api/subscription/self/token`、`/api/status` —— **全是管理面**。数据面（relay）
 *    到底是不是 `/v1/chat/completions`，还是自有协议，至今没有任何人写出来过。
 *    若不是 OpenAI 兼容 relay，这家根本接不进通用上游，性质从「改两处」升级为
 *    「进不了网关」，必须在 S1 之前钉死，不能留到 S4。
 * 2. **错误体是不是 200 + `success:false`？** 文档 §1.2 / §8.2 明说业务错误通常
 *    返回 HTTP 200，成败看 `success` 字段。而 `classifyUpstreamStatus()` 是**纯状态码驱动**：
 *    余额耗尽/令牌失效若走 200，会被判成「不计失败」→ 不冷却、还 reportSuccess →
 *    死 key 永远被选中，直接打穿「单 key 故障 100ms 内切换」这条验收。
 *
 * ── 凭据纪律（本脚本为「凭据无关」设计）────────────────────────────────────
 * 本仓库**不存放** TierFlow 会话 cookie、手机号、密码或任何明文 key。
 * 凭据一律由**执行者**在运行时以环境变量注入，落在进程内存里，用完即弃：
 *   PROBE_KEY            一枚正常 sk-（探针 1/2 共用）
 *   PROBE_EXHAUSTED_KEY  一枚**已知耗尽**的 key（透支套餐，探针 3）
 *   PROBE_MODEL          一个真实可用模型 id
 * 输出**全量过 scrubCredentials**，并额外对注入值做精确替换；
 * 报告只写 stdout，**不落盘**（避免把上游回显的凭据写进工作区）。
 *
 * 运行（凭据只存在于当前 shell 会话，别写进 .env、别提交）：
 *   PROBE_KEY=sk-... PROBE_MODEL=... pnpm probe:tierflow
 *   PROBE_DRY_RUN=1 pnpm probe:tierflow      # 只打印计划，不发任何请求（自检用）
 *
 * 退出码：全部探针都跑完 → 0；有探针**没能执行**（网络/超时）→ 1。
 * 探针本身「探出问题」**不算失败**（它是诊断工具），结论打在报告末的 VERDICT 段。
 */

import { classifyUpstreamStatus } from '../src/gateway/classify.js';
import { scrubCredentials } from '../src/util/redact.js';

/* ------------------------------ 入参 ------------------------------ */

const BASE_URL = (process.env.PROBE_BASE_URL ?? 'https://tierflow.cn').replace(/\/+$/, '');
const KEY = process.env.PROBE_KEY ?? '';
const EXHAUSTED_KEY = process.env.PROBE_EXHAUSTED_KEY ?? '';
const MODEL = process.env.PROBE_MODEL ?? '';
const DRY_RUN = process.env.PROBE_DRY_RUN === '1';
const TIMEOUT_MS = intEnv('PROBE_TIMEOUT_MS', 15000, 1000);

/** 请求体里故意用一个不可能存在的模型，用来把「模型不存在」与「余额/鉴权」分开 */
const BOGUS_MODEL = '__probe_model_that_does_not_exist__';

function intEnv(name: string, dflt: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}

/* ------------------------------ 脱敏 ------------------------------ */

/** 掩码：与仓库既有口径同形（`****` + 后 4 位），永不打印完整凭据 */
function maskOf(secret: string): string {
  if (secret === '') return '(未提供)';
  return secret.length <= 4 ? '****' : `****${secret.slice(-4)}`;
}

/**
 * 报告输出的**唯一出口**。两道：
 *   1. 形状抹 —— `scrubCredentials`（认 sk-/gw-/Bearer/api_key= 等已知形状）
 *   2. 精确抹 —— 本次注入的两个 key 若漏网（上游换了回显形状），在这里兜住
 * 顺序与 `scrubMessage` 同理：先抹再截，截断点之后不留半个凭据。
 */
function safe(text: string, limit = 400): string {
  let out = scrubCredentials(text);
  for (const secret of [KEY, EXHAUSTED_KEY]) {
    if (secret !== '') out = out.split(secret).join('****');
  }
  out = out.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return out.length <= limit ? out : `${out.slice(0, limit)}…`;
}

/* --------------------------- 响应形状描述 --------------------------- */

/**
 * 把响应体压成「形状 + 脱敏样例」。目的是让人一眼看出
 * `success` 字段在不在、`error` 长什么样 —— 而不是看一整包原文。
 */
function describe(value: unknown, depth = 0): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return safe(value, 160);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [`<${value.length} 项>`, describe(value[0], depth + 1)];
  }
  if (typeof value === 'object') {
    if (depth >= 4) return '<深度截断>';
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 40);
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[safe(k, 64)] = describe(v, depth + 1);
    return out;
  }
  return `<${typeof value}>`;
}

type ProbeResult = {
  id: string;
  title: string;
  ran: boolean;
  httpStatus: number | null;
  contentType: string | null;
  firstChunkMs: number | null;
  sse: boolean;
  body: unknown;
  networkError: string | null;
  /** 现有 `classifyUpstreamStatus()` 会怎么判 —— 这是「改不改 classify」的直接依据 */
  currentVerdict: string | null;
  /** 200 + 错误体 → true。true 即代表现状会漏判 */
  needsBodyRecognition: boolean;
};

/** 200 + 错误体判定的候选形状。宁可列全，别让一个没想到的字段名把结论带偏 */
function looksLikeFailureBody(status: number, parsed: unknown): boolean {
  if (status !== 200) return false;
  if (parsed === null || typeof parsed !== 'object') return false;
  const rec = parsed as Record<string, unknown>;
  if (rec.success === false) return true;
  if (rec.success === 0) return true;
  if (typeof rec.code === 'string' && rec.code !== '') return true;
  if (typeof rec.error === 'object' && rec.error !== null) return true;
  if (typeof rec.message === 'string' && /fail|error|invalid|expired|insufficient|quota|balance/i.test(rec.message)) {
    return true;
  }
  return false;
}

type ProbeSpec = {
  id: string;
  title: string;
  /** 该探针要证明什么 */
  goal: string;
  secret: string;
  /** 该探针要求的凭据缺口说明（缺了就跑不了，报告里显式标 SKIP，不静默跳过） */
  requires: string;
  run: (secret: string) => Promise<ProbeResult>;
};

/* ------------------------------ 探针实现 ------------------------------ */

const CHAT_PATH = `${BASE_URL}/v1/chat/completions`;
const MODELS_PATH = `${BASE_URL}/v1/models`;

/** 非流式对话请求 */
async function probeChat(
  id: string,
  title: string,
  goal: string,
  secret: string,
  requires: string,
  model: string,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const res = await fetch(CHAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    const firstChunkMs = Date.now() - started;

    let parsed: unknown = null;
    let parsedOk = false;
    try {
      parsed = JSON.parse(text);
      parsedOk = true;
    } catch {
      /* 非 JSON：保留原文（已脱敏），parsedOk=false */
    }

    const contentType = res.headers.get('content-type');
    const body = parsedOk ? describe(parsed) : safe(text, 400);
    const needs = looksLikeFailureBody(res.status, parsedOk ? parsed : null);
    const verdict = classifyUpstreamStatus(res.status);

    return {
      id,
      title,
      goal,
      ran: true,
      httpStatus: res.status,
      contentType,
      firstChunkMs,
      sse: (contentType ?? '').includes('text/event-stream'),
      body,
      networkError: null,
      currentVerdict: verdict ?? 'null（不计失败 / 不换 key）',
      needsBodyRecognition: needs,
      requires,
    } as ProbeResult & { goal: string; requires: string };
  } catch (err) {
    return {
      id,
      title,
      goal,
      ran: false,
      httpStatus: null,
      contentType: null,
      firstChunkMs: null,
      sse: false,
      body: null,
      networkError: safe(err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
      currentVerdict: null,
      needsBodyRecognition: false,
      requires,
    } as ProbeResult & { goal: string; requires: string };
  }
}

/**
 * 流式探针 —— 这一条是 classify 改动边界的**唯一依据**。
 *
 * 只读**首包**就停：要区分「首包之前就吐 200 错误体」（可改判，能换 key 且客户端无感知）
 * 与「首包已经发出、之后才断流」（不能改 HTTP 状态，否则客户端拿到 200 再断流 = 有感知）。
 * 所以这里刻意在首个 chunk 后立刻 cancel，并记录首包耗时。
 */
async function probeChatStream(id: string, title: string, goal: string, secret: string, model: string): Promise<ProbeResult> {
  const started = Date.now();
  const base: Omit<ProbeResult, 'body' | 'httpStatus' | 'networkError' | 'currentVerdict' | 'ran'> = {
    id,
    title,
    firstChunkMs: null,
    contentType: null,
    sse: false,
    needsBodyRecognition: false,
  };
  try {
    const res = await fetch(CHAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const contentType = res.headers.get('content-type');
    const sse = (contentType ?? '').includes('text/event-stream');

    // 读首个 chunk（或读到流结束）。读到就停 —— 不消费整条流。
    const reader = res.body?.getReader();
    let firstText = '';
    if (reader !== undefined) {
      const { value, done } = await reader.read();
      firstText = done || value === undefined ? '' : new TextDecoder().decode(value);
      await reader.cancel().catch(() => undefined);
    }
    const firstChunkMs = Date.now() - started;

    // 首包是 JSON（非 SSE）才有「200 + 错误体」的可判空间；SSE 首包是 data: 帧
    let parsed: unknown = null;
    let parsedOk = false;
    if (!sse && firstText.trim() !== '') {
      try {
        parsed = JSON.parse(firstText);
        parsedOk = true;
      } catch {
        /* 首包不是完整 JSON */
      }
    }
    const needs = looksLikeFailureBody(res.status, parsedOk ? parsed : null);

    return {
      ...base,
      ran: true,
      httpStatus: res.status,
      contentType,
      firstChunkMs,
      sse,
      body: parsedOk ? describe(parsed) : safe(firstText, 400),
      networkError: null,
      currentVerdict: classifyUpstreamStatus(res.status) ?? 'null（不计失败 / 不换 key）',
      needsBodyRecognition: needs,
    } as ProbeResult & { goal: string; requires: string };
  } catch (err) {
    return {
      ...base,
      ran: false,
      httpStatus: null,
      body: null,
      networkError: safe(err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
      currentVerdict: null,
    } as ProbeResult & { goal: string; requires: string };
  }
}

async function probeModels(secret: string): Promise<ProbeResult> {
  const started = Date.now();
  const goal = '数据面是否提供 OpenAI 兼容的 /v1/models —— 模型清单能否自动发现';
  try {
    const res = await fetch(MODELS_PATH, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    let parsedOk = false;
    try {
      parsed = JSON.parse(text);
      parsedOk = true;
    } catch {
      /* 非 JSON */
    }
    const contentType = res.headers.get('content-type');
    const rec = parsedOk && parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    const modelCount = rec !== null && Array.isArray(rec.data) ? rec.data.length : null;

    return {
      id: 'P0',
      title: 'GET /v1/models',
      goal,
      requires: 'PROBE_KEY',
      ran: true,
      httpStatus: res.status,
      contentType,
      firstChunkMs: Date.now() - started,
      sse: false,
      body: modelCount !== null ? { data: [`<${modelCount} 个模型>`], sample: describe(rec?.data) } : parsedOk ? describe(parsed) : safe(text, 400),
      networkError: null,
      currentVerdict: classifyUpstreamStatus(res.status) ?? 'null（不计失败 / 不换 key）',
      needsBodyRecognition: looksLikeFailureBody(res.status, parsedOk ? parsed : null),
    } as ProbeResult & { goal: string; requires: string };
  } catch (err) {
    return {
      id: 'P0',
      title: 'GET /v1/models',
      goal,
      requires: 'PROBE_KEY',
      ran: false,
      httpStatus: null,
      contentType: null,
      firstChunkMs: null,
      sse: false,
      body: null,
      networkError: safe(err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
      currentVerdict: null,
      needsBodyRecognition: false,
    } as ProbeResult & { goal: string; requires: string };
  }
}

/* ------------------------------ 主流程 ------------------------------ */

/** 无效 key 探针用的假 key：形状合法、值必错。**故意运行时拼**，免得被 check:secrets 当明文 key 命中 */
const FAKE_KEY = ['sk', 'probe', 'invalid', '0'.repeat(24)].join('-');

function buildSpecs(): ProbeSpec[] {
  return [
    {
      id: 'P0',
      title: 'GET /v1/models',
      goal: '数据面是否有 OpenAI 兼容面（无则这家接不进通用上游）',
      secret: KEY,
      requires: 'PROBE_KEY',
      run: probeModels,
    },
    {
      id: 'P1',
      title: 'POST /v1/chat/completions · 无效 key',
      goal: '令牌失效回什么 —— 401/403（现状可判）还是 200+success:false（现状漏判）',
      secret: FAKE_KEY,
      requires: '（无需凭据）',
      run: (s) => probeChat('P1', 'POST /v1/chat/completions · 无效 key', '令牌失效的错误体形状', s, '（无需凭据）', MODEL === '' ? BOGUS_MODEL : MODEL),
    },
    {
      id: 'P2',
      title: 'POST /v1/chat/completions · 不存在模型',
      goal: '客户端侧错误（400/404 原样透传）与业务错误的边界在哪',
      secret: KEY,
      requires: 'PROBE_KEY',
      run: (s) => probeChat('P2', 'POST /v1/chat/completions · 不存在模型', '客户端错误与业务错误的区分', s, 'PROBE_KEY', BOGUS_MODEL),
    },
    {
      id: 'P3',
      title: 'POST /v1/chat/completions · stream:true 不存在模型',
      goal: '错误体出现在首包**之前**（可改判）还是之后（不可改 HTTP 状态）—— classify 改动边界的唯一依据',
      secret: KEY,
      requires: 'PROBE_KEY',
      run: (s) => probeChatStream('P3', 'POST /v1/chat/completions · stream:true 不存在模型', '错误体相对首包的时序位置', s, BOGUS_MODEL),
    },
    {
      id: 'P4',
      title: 'POST /v1/chat/completions · 已知耗尽 key',
      goal: '余额耗尽的错误体形状 —— 现状若判成成功，死 key 会被无限选中',
      secret: EXHAUSTED_KEY,
      requires: 'PROBE_EXHAUSTED_KEY（透支套餐 key）+ PROBE_MODEL',
      run: (s) => probeChat('P4', 'POST /v1/chat/completions · 已知耗尽 key', '余额耗尽的错误体形状', s, 'PROBE_EXHAUSTED_KEY', MODEL === '' ? BOGUS_MODEL : MODEL),
    },
  ];
}

function printPlan(specs: ProbeSpec[]): void {
  console.log('── 探针计划（DRY RUN，未发出任何请求）──');
  for (const s of specs) {
    const ok = s.secret !== '';
    console.log(`  ${s.id}  ${s.title}`);
    console.log(`       目的：${s.goal}`);
    console.log(`       凭据：${s.requires}  → ${ok ? '就绪' : '缺失（将 SKIP）'}`);
  }
  console.log('');
  console.log(`baseUrl     : ${BASE_URL}`);
  console.log(`PROBE_MODEL : ${MODEL === '' ? '(未提供 → P4 将 SKIP)' : safe(MODEL, 80)}`);
  console.log(`key         : ${maskOf(KEY)}`);
  console.log(`耗尽 key    : ${maskOf(EXHAUSTED_KEY)}`);
}

async function main(): Promise<number> {
  const specs = buildSpecs();

  console.log('TierFlow 数据面探针（M6-D / S1 待钉项）');
  console.log(`目标 baseUrl: ${BASE_URL}`);
  console.log('');

  if (DRY_RUN) {
    printPlan(specs);
    console.log('DRY RUN 结束：未发出任何请求。');
    return 0;
  }

  const results: (ProbeResult & { goal: string; requires: string })[] = [];
  let skipped = 0;

  for (const spec of specs) {
    if (spec.secret === '') {
      console.log(`SKIP ${spec.id} ${spec.title} —— 缺 ${spec.requires}`);
      skipped += 1;
      continue;
    }
    console.log(`RUN  ${spec.id} ${spec.title} …`);
    const r = await spec.run(spec.secret);
    results.push(r as ProbeResult & { goal: string; requires: string });
    console.log(`     → HTTP ${r.httpStatus ?? 'N/A'}${r.sse ? ' (SSE)' : ''}${r.networkError !== null ? `  ⚠ ${r.networkError}` : ''}`);
  }

  console.log('');
  console.log('════════════════════ 报告（全量脱敏）════════════════════');
  for (const r of results) {
    console.log('');
    console.log(`【${r.id}】${r.title}`);
    console.log(`  目的      : ${r.goal}`);
    console.log(`  ran       : ${r.ran}`);
    console.log(`  httpStatus: ${r.httpStatus ?? 'N/A'}`);
    console.log(`  contentType: ${r.contentType ?? 'N/A'}`);
    console.log(`  sse       : ${r.sse}`);
    console.log(`  首包耗时  : ${r.firstChunkMs === null ? 'N/A' : `${r.firstChunkMs}ms`}`);
    if (r.networkError !== null) console.log(`  网络错误  : ${r.networkError}`);
    console.log(`  响应形状  : ${JSON.stringify(r.body, null, 2).split('\n').join('\n              ')}`);
    console.log(`  现有判定  : classifyUpstreamStatus(${r.httpStatus ?? '?'}) → ${r.currentVerdict ?? 'N/A'}`);
    if (r.needsBodyRecognition) {
      console.log('  ⚠ 200 + 错误体：现状判为「不计失败 / 不换 key」→ 需 pre-first-chunk 改判');
    }
  }

  /* ------------------------------ 结论 ------------------------------ */

  console.log('');
  console.log('════════════════════ VERDICT ════════════════════════');

  const anyBodyRecognition = results.some((r) => r.needsBodyRecognition);
  const modelsRan = results.find((r) => r.id === 'P0');
  const openAiCompatible = modelsRan !== undefined && modelsRan.httpStatus !== null && modelsRan.httpStatus < 400;

  console.log(`数据面是否为 OpenAI 兼容面 : ${openAiCompatible ? '是（/v1/models 可用）' : '否 / 未证实'}`);
  console.log(`是否需要「200 + 错误体」识别 : ${anyBodyRecognition ? '需要 —— classify.ts 必须加 pre-first-chunk 改判' : '本批探针未见 200+错误体'}`);
  if (skipped > 0) {
    console.log(`跳过 ${skipped} 条：缺凭据。结论不完整，补齐后重跑才能冻结契约。`);
  }
  console.log('');
  console.log('报告请整段回贴到群/契约；本脚本不落盘任何文件。');

  // 有探针没能执行（网络/超时）→ 非 0，让执行者注意到结论不完整
  const failedToRun = results.some((r) => !r.ran);
  return failedToRun || skipped > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error('探针自身异常：', safe(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
    process.exit(1);
  });
