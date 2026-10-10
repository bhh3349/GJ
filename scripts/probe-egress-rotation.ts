/**
 * 出口轮换探针 P0–P4（路由者车道；队列位：503 选择器收口之后）
 *
 * 要回答的五件事（每笔一个可核验产物，PM 派单口径）：
 *   P0 基线探活      —— 网关面活着、鉴权面认探针 key、模型清单可发现
 *   P1 单出口轮换    —— 同一出口下多账号轮换，不得恒钉一个账号
 *   P2 池内切换      —— 多出口之间按台账切换；全 retired 走 503、全冷却走 429（带 Retry-After）
 *   P3 冷却写入窗口  —— v6 判据：同出口同上游 60s 内 ≥3 个**不同账号**上游 429 才写冷却；
 *                       本地拒与 key 级失败不得混进计数；写入时长 = max(Retry-After, 60s)，封顶 30min
 *   P4 落帧验证      —— `egress_cooldown` 三处接线（造帧 / 推帧 / 注册进 live 集合）+ 冻结帧形逐字
 *
 * ── 凭据纪律（与 S4 同款，本脚本「凭据无关」设计）───────────────────────────
 * 仓库不存放任何会话、手机号、密码、明文 key。凭据只由执行者在运行时以环境变量注入，
 * 活在进程内存里，用完即弃，报告输出前全量过 scrubCredentials + 注入值精确替换。
 *
 *   PROBE_GATEWAY_URL   网关面基址（缺省 http://127.0.0.1:4000）
 *   PROBE_ADMIN_URL     管理面基址（缺省 http://127.0.0.1:4001）
 *   PROBE_GATEWAY_KEY   一枚可用网关 sk-（P0 起全部需要）
 *   PROBE_ADMIN_SESSION 管理面会话（P2/P3 读台账、P4 读 live 面需要）
 *   PROBE_MODEL         真实可用模型 id
 *   PROBE_EXCLUDED      逗号分隔的禁入手机号清单（**必须由环境给，脚本内不写死任何号码**）
 *   PROBE_UPSTREAM_KEY  S4 同款建 TTL 探针 key 所需的上游账号标识（与密码分离，密码见下）
 *   PROBE_UPSTREAM_PASS 上游账号密码（仅当需要现场建 TTL key 时给）
 *   PROBE_TTL_KEY       若执行者已在会话直连侧建好 TTL 探针 key，直接给这一枚，脚本不再自己建
 *
 * 缺凭据时**显式 SKIP 并退出非 0**，绝不把「没发出去」写成「观测到了什么」。
 *
 * 运行：
 *   PROBE_OFFLINE=1 pnpm exec tsx scripts/probe-egress-rotation.ts     # 离线自检判据核（不发任何请求）
 *   PROBE_GATEWAY_KEY=... PROBE_MODEL=... pnpm exec tsx scripts/probe-egress-rotation.ts
 *   PROBE_ONLY=P3,P4 ...                                                # 分片（出口预算所限，见下）
 *
 * ── 出网预算（项目级约束，v2 实测）───────────────────────────────────────────
 * 出口 IP 级限流是**次数预算**（≈5–6 次/窗口），与账号/key 无关，成功请求同样计入。
 * 所以「P0–P4 一次全跑」在这条出口上结构上做不到：后半段必然被前半段自己打出的 429
 * 污染成假结论。故默认预算 5 次，撞 429 立刻停本片，等冷却窗口退干净再分片重跑。
 */

import { classifyUpstreamStatus } from '../src/gateway/classify.js';
import { scrubCredentials } from '../src/util/redact.js';

/* ------------------------------ 入参 ------------------------------ */

const OFFLINE = process.env.PROBE_OFFLINE === '1';
const GATEWAY = (process.env.PROBE_GATEWAY_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
const ADMIN = (process.env.PROBE_ADMIN_URL ?? 'http://127.0.0.1:4001').replace(/\/+$/, '');
const KEY = process.env.PROBE_GATEWAY_KEY ?? '';
const ADMIN_SESSION = process.env.PROBE_ADMIN_SESSION ?? '';
const MODEL = process.env.PROBE_MODEL ?? '';
const TTL_KEY = process.env.PROBE_TTL_KEY ?? '';
const UPSTREAM_ID = process.env.PROBE_UPSTREAM_KEY ?? '';
const UPSTREAM_SECRET = process.env.PROBE_UPSTREAM_PASS ?? '';
/** 禁入号清单只从环境来；脚本里没有任何号码字面，所以「不参与」这条不可能靠这里兜住 —— 靠断言兜 */
const EXCLUDED = (process.env.PROBE_EXCLUDED ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');
const ONLY = (process.env.PROBE_ONLY ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
const BUDGET = intEnv('PROBE_BUDGET', 5, 1);
const PACE_MS = intEnv('PROBE_PACE_MS', 700, 0);
const COOLDOWN_MS = intEnv('PROBE_COOLDOWN_MS', 0, 0);
const TIMEOUT_MS = intEnv('PROBE_TIMEOUT_MS', 20000, 1000);
/** 每账号打几次以逼出轮换（P1/P2）。预算不够时自动缩，缩到 <2 轮则该片标 SKIP */
const ROUNDS = intEnv('PROBE_ROUNDS', 6, 1);

function intEnv(name: string, dflt: number, min: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
}

/* ------------------------------ 脱敏 ------------------------------ */

function maskOf(secret: string): string {
  if (secret === '') return '(未提供)';
  return secret.length <= 4 ? '****' : `****${secret.slice(-4)}`;
}

/** 号码/会话一律掩码；探针报告里永不出现完整值 */
function maskPhone(p: string): string {
  if (p === '') return '(未提供)';
  return p.length <= 5 ? '****' : `${p.slice(0, 3)}****${p.slice(-2)}`;
}

/** 报告输出的唯一出口：先形状抹，再对注入值精确替换，最后压控制字符 */
function safe(text: string, limit = 300): string {
  let out = scrubCredentials(text);
  for (const secret of [KEY, ADMIN_SESSION, TTL_KEY, UPSTREAM_SECRET, ...EXCLUDED]) {
    if (secret !== '') out = out.split(secret).join('****');
  }
  out = out.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return out.length <= limit ? out : `${out.slice(0, limit)}…`;
}

/* --------------------------- 判据核（可离线自证）--------------------------- */

/** 一次上游/本地拒绝的观测。account 只带**不可逆摘要**，永不带账号明文 */
type Reject = {
  atMs: number;
  egressId: string;
  upstreamId: string;
  account: string;
  /** 上游真回 429 = 'upstream'；我们自己在出口闸前拒掉 = 'local' */
  source: 'upstream' | 'local';
  retryAfterSec: number | null;
};

/** 一帧 `egress_cooldown` 的观测形状（v1.5.0 冻结件） */
type CooldownFrame = {
  type: string;
  serverTime: string | null;
  egressId: string | null;
  cooldownUntil: string | null;
  reason?: string;
  sig?: Record<string, unknown>;
  id?: string;
};

/** 台账里一条出口绑定 */
type EgressRow = { id: string; status: string; exitIp: string | null; lastHeartbeatAt: string | null };

const WINDOW_MS = 60_000;
const MIN_DISTINCT_ACCOUNTS = 3;
const FLOOR_SEC = 60;
const CEIL_SEC = 1800;

/**
 * P3 判据（v6 窗口化）：同一 (egress, upstream) 的 60s 滑动窗内，**只有 source='upstream'**
 * 的不同账号数 ≥3 才该写冷却。本地拒不得混进来（否则一个被打空预算的出口拿自己拒出来的脸
 * 冷掉自己）；同账号刷 N 次只算 1 个（否则一个死号能把整条出口打死）。
 */
function shouldWriteCooldown(rejects: Reject[], atMs: number, egressId: string, upstreamId: string): boolean {
  const accounts = new Set<string>();
  for (const r of rejects) {
    if (r.source !== 'upstream') continue;
    if (r.egressId !== egressId || r.upstreamId !== upstreamId) continue;
    if (atMs - r.atMs > WINDOW_MS || atMs - r.atMs < 0) continue;
    accounts.add(r.account);
  }
  return accounts.size >= MIN_DISTINCT_ACCOUNTS;
}

/** 写入时长：max(Retry-After, 60s) 起步、封顶 30min。无 Retry-After 头则取地板值 */
function cooldownDurationSec(rejects: Reject[]): number {
  let max = FLOOR_SEC;
  for (const r of rejects) {
    if (r.retryAfterSec !== null && r.retryAfterSec > max) max = r.retryAfterSec;
  }
  return Math.min(max, CEIL_SEC);
}

/**
 * P4 判据：帧形逐字对齐 v1.5.0 冻结件。
 * 四枚硬钉子：type 字面、字段集恰为 {type,serverTime,egressId,cooldownUntil}（**不得有 reason**）、
 * sig 必带 cooldownUntil、单出口帧 id 与池帧 id 不同键。
 */
function judgeFrame(frame: CooldownFrame | undefined, egressId: string): string[] {
  const errs: string[] = [];
  if (frame === undefined) return ['未收到任何帧（观测面未接线或本片被预算截断）'];
  if (frame.type !== 'egress_cooldown') errs.push(`type 漂移：${safe(frame.type, 40)}`);
  if (frame.reason !== undefined) errs.push('帧多出 reason 字段（冻结件无此字段）');
  if (frame.egressId !== egressId) errs.push(`egressId 不符：期望本出口 id，实得 ${safe(String(frame.egressId), 40)}`);
  if (frame.serverTime === null) errs.push('serverTime 缺失（帧必须带绝对时刻）');
  if (frame.cooldownUntil === null) errs.push('cooldownUntil 缺失（帧恒在，哪怕尚未到期也必须吐）');
  if (frame.sig === undefined || frame.sig.cooldownUntil === undefined) errs.push('sig 未带 cooldownUntil');
  const id = frame.id ?? '';
  if (id === '' ) errs.push('帧 id 缺失');
  else if (id === 'egress:pool') errs.push('单出口帧错用了池帧键 egress:pool');
  else if (!id.startsWith('egress:')) errs.push(`帧键形状漂移：${safe(id, 40)}`);
  return errs;
}

/** P1/P2 判据：命中分布不得恒钉一点；出口维至少要有切换的证据才叫「池内切换」 */
function judgeRotation(hits: Map<string, number>): { distinct: number; top: number; total: number } {
  let total = 0;
  for (const n of hits.values()) total += n;
  let top = 0;
  for (const n of hits.values()) if (n > top) top = n;
  return { distinct: hits.size, top, total };
}

/**
 * P2 终态分型（503 收口后的两条冻结终态，v10 不变量②）：
 *   全 retired → 503 `NO_AVAILABLE_EGRESS`，**不带** Retry-After；
 *   全冷却/预算耗尽 → 429 `RATE_LIMITED`，**恒带** Retry-After。
 * 二者被压成同形就是回归，这一条把「形状」钉成断言而不是靠人读代码。
 */
function judgeExhausted(rows: EgressRow[], status: number, retryAfter: string | null): string[] {
  const errs: string[] = [];
  const active = rows.filter((r) => r.status === 'active');
  if (status === 503) {
    if (active.length > 0 && rows.every((r) => r.status !== 'retired')) {
      errs.push('503 但台账里没有任何 retired 行（应为 429 冷却路径）');
    }
    if (retryAfter !== null) errs.push('503 却带了 Retry-After（违反冻结终态：503 不带）');
  } else if (status === 429) {
    if (retryAfter === null) errs.push('429 未带 Retry-After（违反 v10②：429 恒带）');
  } else if (status >= 200 && status < 300 && rows.length > 0 && active.length === 0) {
    errs.push('台账无一条 active 却拿到 2xx（池空未判故障）');
  }
  const coded = classifyUpstreamStatus(status);
  errs.push(`[归因参考] classifyUpstreamStatus(${status}) → ${coded ?? 'null（不计失败/不换 key）'}`);
  return errs;
}

/* ------------------------------ 离线自检 ------------------------------ */

/**
 * 不给凭据也要能证明「判据核」本身是对的：用**合成观测**喂进去，
 * 断言核在「合规样本」上全过、在「每条钉子各自的违例样本」上精确报错。
 * 这些样本是判据的测试输入，不是对真实上游的任何结论。
 */
function offlineSelfCheck(): number {
  const T = 1_700_000_000_000;
  const up = (n: number, account: string, retry: number | null = 30): Reject => ({
    atMs: T + n * 1000, egressId: 'eg-1', upstreamId: 'up-1', account, source: 'upstream', retryAfterSec: retry,
  });
  let pass = true;
  const say = (label: string, ok: boolean, detail: string): void => {
    if (!ok) pass = false;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  · ${detail}`}`);
  };

  console.log('── P3 冷却写入窗口（v6 distinctAccounts）──');

  // 1) 2 个不同账号 → 不该写
  say('2 账号 60s 内 429 → 不写冷却',
    shouldWriteCooldown([up(0, 'a'), up(1, 'b')], T + 2000, 'eg-1', 'up-1') === false, '');

  // 2) 同账号刷 9 次 → 仍只有 1 个号，不该写
  const sameAccount: Reject[] = [];
  for (let i = 0; i < 9; i += 1) sameAccount.push(up(i, 'a'));
  say('同账号 ×9 → 不写冷却（否则一个死号打死整条出口）',
    shouldWriteCooldown(sameAccount, T + 10_000, 'eg-1', 'up-1') === false, '');

  // 3) 3 个不同账号 → 该写
  say('3 账号 → 写冷却',
    shouldWriteCooldown([up(0, 'a'), up(10, 'b'), up(20, 'c')], T + 30_000, 'eg-1', 'up-1') === true, '');

  // 4) 窗口外的第 3 个号 → 不该写（滑动窗，不是累计）
  say('第 3 个号落在 61s 之外 → 不写冷却',
    shouldWriteCooldown([up(0, 'a'), up(1, 'b'), up(61, 'c')], T + 61_000, 'eg-1', 'up-1') === false, '');

  // 5) 本地拒混进来也不计数
  const withLocal: Reject[] = [up(0, 'a'), up(1, 'b'),
    { atMs: T + 2000, egressId: 'eg-1', upstreamId: 'up-1', account: 'c', source: 'local', retryAfterSec: 1 }];
  say('本地拒不得计入 distinctAccounts',
    shouldWriteCooldown(withLocal, T + 3000, 'eg-1', 'up-1') === false, '');

  // 6) 跨出口 / 跨上游不得串窗
  say('跨出口不串窗',
    shouldWriteCooldown([up(0, 'a'), up(1, 'b')], T + 2000, 'eg-2', 'up-1') === false, '');

  console.log('── P3 冷却时长（Tier 1 口径）──');
  say('max(Retry-After, 60s)：RA=120 → 120', cooldownDurationSec([up(0, 'a', 120)]) === 120, '');
  say('RA=5 → 地板 60', cooldownDurationSec([up(0, 'a', 5)]) === 60, '');
  say('RA=99999 → 封顶 1800', cooldownDurationSec([up(0, 'a', 99_999)]) === 1800, '');

  console.log('── P4 帧形（v1.5.0 冻结件逐字）──');
  const goodFrame: CooldownFrame = {
    type: 'egress_cooldown', serverTime: new Date(T).toISOString(),
    egressId: 'eg-1', cooldownUntil: new Date(T + 60_000).toISOString(),
    sig: { cooldownUntil: new Date(T + 60_000).toISOString() }, id: 'egress:eg-1',
  };
  say('合规帧 → 零错', judgeFrame(goodFrame, 'eg-1').length === 0, '');
  say('帧多出 reason → 精确抓到',
    judgeFrame({ ...goodFrame, reason: 'x' }, 'eg-1').some((e) => e.includes('reason')) === true, '');
  say('cooldownUntil 缺失 → 精确抓到',
    judgeFrame({ ...goodFrame, cooldownUntil: null }, 'eg-1').some((e) => e.includes('cooldownUntil')) === true, '');
  say('sig 未带 cooldownUntil → 精确抓到',
    judgeFrame({ ...goodFrame, sig: {} }, 'eg-1').some((e) => e.includes('sig')) === true, '');
  say('单出口帧误用池键 → 精确抓到（两键必须可分）',
    judgeFrame({ ...goodFrame, id: 'egress:pool' }, 'eg-1').some((e) => e.includes('egress:pool')) === true, '');
  say('一帧未收 → 不许静默通过',
    judgeFrame(undefined, 'eg-1').length > 0, '');

  console.log('── P2 终态分型（429 恒带 RA / 503 恒不带）──');
  const retiredOnly: EgressRow[] = [{ id: 'eg-1', status: 'retired', exitIp: null, lastHeartbeatAt: null }];
  const activeOnly: EgressRow[] = [{ id: 'eg-1', status: 'active', exitIp: 'e1', lastHeartbeatAt: '2026-10-10T00:00:00.000Z' }];
  say('全 retired + 503 + 无 RA → 合规', judgeExhausted(retiredOnly, 503, null).filter((e) => !e.startsWith('[归因参考]')).length === 0, '');
  say('503 却带 RA → 精确抓到', judgeExhausted(retiredOnly, 503, '60').some((e) => e.includes('违反冻结终态')) === true, '');
  say('429 未带 RA → 精确抓到（v10②）', judgeExhausted(activeOnly, 429, null).some((e) => e.includes('v10')) === true, '');
  say('无 active 却 2xx → 精确抓到', judgeExhausted(retiredOnly, 200, null).some((e) => e.includes('2xx')) === true, '');

  console.log('── P1/P2 轮换分布 ──');
  const stuck = new Map([['eg-1', ROUNDS]]);
  const spread = new Map([['eg-1', 4], ['eg-2', 2]]);
  say('恒钉一点 → 判为未轮换', judgeRotation(stuck).distinct === 1, `distinct=${judgeRotation(stuck).distinct}`);
  say('两点分布 → 判为有切换证据', judgeRotation(spread).distinct === 2, `distinct=${judgeRotation(spread).distinct}`);

  console.log('');
  console.log(pass
    ? '离线自检：PASS（判据核对合规样本全过、对 12 条违例样本各自精确报错）'
    : '离线自检：FAIL（判据核本身有缺陷，别接凭据跑在线）');

  /* 顺手把在线所需抓手打全，省掉一轮「缺什么」问答 */
  console.log('');
  console.log('── 在线面缺口（本轮实测：' + (KEY === '' ? 'PROBE_GATEWAY_KEY 未注入' : '已注入') + '）──');
  for (const [name, need] of [
    ['P0', 'PROBE_GATEWAY_KEY, PROBE_MODEL'],
    ['P1', 'PROBE_GATEWAY_KEY, PROBE_MODEL, PROBE_ADMIN_SESSION(读命中归属)'],
    ['P2', 'PROBE_GATEWAY_KEY, PROBE_MODEL, PROBE_ADMIN_SESSION(读 /api/egress 台账)'],
    ['P3', 'PROBE_GATEWAY_KEY ×≥3 个不同账号的 key 或同一出口多号，PROBE_ADMIN_SESSION'],
    ['P4', 'PROBE_ADMIN_SESSION(订 WS /api/stats/live)'],
  ] as [string, string][]) {
    console.log(`  ${name} 需要：${need}`);
  }
  console.log(`  禁入号清单：${EXCLUDED.length === 0 ? '⚠ PROBE_EXCLUDED 未注入 → 在线模式将 fail-closed 拒绝起跑' : `已注入 ${EXCLUDED.length} 枚（脚本内零号码字面）`}`);
  console.log(`  出口预算：${BUDGET} 次/片，片间等 ${COOLDOWN_MS}ms 冷却；P0–P4 一次全跑在实测预算下结构上做不到，分片是唯一拿干净结论的方式`);
  return pass ? 0 : 1;
}

/* ------------------------------ 在线探针 ------------------------------ */

type Hit = { atMs: number; egressId: string | null; account: string | null; status: number; retryAfter: string | null };

const state = { requests: 0, budgetUsed: 0, hits: [] as Hit[], frames: [] as CooldownFrame[], rows: [] as EgressRow[], createdTokenNo: null as string | null };

async function call(url: string, opts: RequestInit = {}, admin = false): Promise<Response> {
  if (state.requests >= BUDGET) throw new Error(`出网预算已用尽（${BUDGET} 次/片），本片终止`);
  state.requests += 1;
  const headers: Record<string, string> = { ...(opts.headers as Record<string, string> ?? {}) };
  if (admin) {
    if (ADMIN_SESSION === '') throw new Error('缺 PROBE_ADMIN_SESSION');
    headers.cookie = `session=${ADMIN_SESSION}`;
  }
  const res = await fetch(url, { ...opts, headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429) state.budgetUsed += 1;
  return res;
}

async function chatOnce(): Promise<{ status: number; retryAfter: string | null; ms: number }> {
  const t0 = Date.now();
  const res = await call(`${GATEWAY}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], max_tokens: 8 }),
  });
  const ms = Date.now() - t0;
  await res.body?.cancel().catch(() => undefined);
  return { status: res.status, retryAfter: res.headers.get('retry-after'), ms };
}

async function readLedger(): Promise<EgressRow[]> {
  const res = await call(`${ADMIN}/api/egress`, { method: 'GET' }, true);
  if (!res.ok) throw new Error(`台账读取 HTTP ${res.status}`);
  const json = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return (json.items ?? []).map((r) => ({
    id: String(r.id ?? ''),
    status: String(r.status ?? ''),
    exitIp: r.exitIp === undefined || r.exitIp === null ? null : safe(String(r.exitIp), 40),
    lastHeartbeatAt: r.lastHeartbeatAt === undefined || r.lastHeartbeatAt === null ? null : String(r.lastHeartbeatAt),
  }));
}

function gate(label: string, need: string[], missing: string[]): boolean {
  if (missing.length === 0) return true;
  console.log(`SKIP ${label} —— 缺 ${missing.join(' / ')}`);
  return false;
}

function missingFor(...names: string[]): string[] {
  const table: Record<string, string> = {
    KEY, ADMIN: ADMIN_SESSION, MODEL, TTL: TTL_KEY, UPSTREAM: UPSTREAM_ID, SECRET: UPSTREAM_SECRET,
  };
  return names.filter((n) => (table[n] ?? '') === '');
}

async function runOnline(): Promise<number> {
  const selected = ONLY.length === 0 ? ['P0', 'P1', 'P2', 'P3', 'P4'] : ONLY;
  console.log('出口轮换探针（在线）');
  console.log(`网关面 ${GATEWAY}  管理面 ${ADMIN}`);
  console.log(`key ${maskOf(KEY)}  model ${MODEL === '' ? '(未提供)' : safe(MODEL, 40)}  预算 ${BUDGET} 次/片`);
  console.log(`禁入号清单：${EXCLUDED.length} 枚（环境注入，脚本内零号码字面）`);

  if (EXCLUDED.length === 0) {
    console.log('❌ PROBE_EXCLUDED 未注入 —— 无法保证选号避开禁入号，fail-closed 拒绝起跑（不试跑、不猜号）。');
    return 2;
  }
  if (UPSTREAM_ID !== '' && EXCLUDED.includes(UPSTREAM_ID)) {
    console.log('❌ 本次选号命中禁入号，中止（掩码后仍拒绝继续，避免任何出网）。');
    return 2;
  }
  console.log(`选号 ${maskPhone(UPSTREAM_ID)} 断言不在禁入清单 ✅`);

  let incomplete = false;
  let lastErr = '';

  if (COOLDOWN_MS > 0) {
    console.log(`冷却等待 ${COOLDOWN_MS}ms（让上一片的出口预算退干净）…`);
    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
  }

  for (const id of selected) {
    if (state.requests >= BUDGET) {
      console.log(`SKIP ${id} —— 本片出网预算已用尽（结论不完整）`);
      incomplete = true;
      continue;
    }
    const need = id === 'P0' ? ['KEY', 'MODEL'] : id === 'P3' ? ['KEY', 'MODEL', 'ADMIN'] : id === 'P4' ? ['ADMIN'] : ['KEY', 'MODEL', 'ADMIN'];
    const miss = missingFor(...need);
    if (!gate(id, need, miss)) { incomplete = true; continue; }
    try {
      if (PACE_MS > 0 && state.hits.length > 0) await new Promise((r) => setTimeout(r, PACE_MS));

      if (id === 'P0') {
        const res = await call(`${GATEWAY}/v1/models`, { headers: { authorization: `Bearer ${KEY}` } });
        const text = await res.text();
        const count = (safeJson(text) as { data?: unknown[] } | null)?.data?.length ?? null;
        console.log(`P0 基线探活 → HTTP ${res.status} 模型数=${count ?? '(不可析)'} 样例=${safe(text.slice(0, 120), 120)}`);
      } else if (id === 'P1' || id === 'P2') {
        state.rows = await readLedger();
        const active = state.rows.filter((r) => r.status === 'active');
        console.log(`${id} 台账：共 ${state.rows.length} 行，active=${active.length} retired=${state.rows.filter((r) => r.status === 'retired').length}`);
        for (const r of active.slice(0, 6)) {
          console.log(`     · ${safe(r.id, 24)} exitIp=${r.exitIp ?? '(未登记)'} 心跳=${r.lastHeartbeatAt ?? '(冷启动 null)'}`);
        }
        if (active.length === 0) {
          const one = await chatOnce();
          const errs = judgeExhausted(state.rows, one.status, one.retryAfter);
          console.log(`${id} 池空终态 → HTTP ${one.status} Retry-After=${one.retryAfter ?? '(无)'}`);
          for (const e of errs) console.log(`     ${e}`);
          incomplete = incomplete || errs.some((e) => !e.startsWith('[归因参考]'));
        } else {
          const rounds = Math.min(ROUNDS, Math.max(0, BUDGET - state.requests));
          if (rounds < 2) { console.log(`${id} 预算不足 2 轮，无法判轮换 → SKIP（不猜）`); incomplete = true; continue; }
          const dist = new Map<string, number>();
          for (let i = 0; i < rounds; i += 1) {
            const one = await chatOnce();
            state.hits.push({ atMs: Date.now(), egressId: null, account: null, status: one.status, retryAfter: one.retryAfter });
            dist.set(String(one.status), (dist.get(String(one.status)) ?? 0) + 1);
            console.log(`     ${id} #${i + 1} → HTTP ${one.status} TTFB=${one.ms}ms RA=${one.retryAfter ?? '-'}`);
            if (one.status === 429) { console.log('     ⚠ 429：出口预算耗尽，停本片剩余探针'); incomplete = true; break; }
          }
          const j = judgeRotation(dist);
          console.log(`${id} 分布：${j.distinct} 种状态码，总 ${j.total}，最高占比 ${((j.top / Math.max(1, j.total)) * 100).toFixed(0)}%`);
          if (id === 'P2') {
            console.log('     注：状态码分布只能证明「有切换」的一半；账号/出口维归属需台账 diff，本片若预算不够则该维标未观测');
          }
        }
      } else if (id === 'P3') {
        console.log('P3 冷却写入窗口 —— 判据核已在离线自检钉死；在线只做一件事：观测真实上游 429 是否带 Retry-After，以及窗口内不同账号数');
        state.rows = await readLedger();
        console.log(`     台账 active 行数=${state.rows.filter((r) => r.status === 'active').length}（同出口多号需 ≥${MIN_DISTINCT_ACCOUNTS} 个不同账号才能验写入，预算通常不够 → 缺则标未观测）`);
        console.log('     结论口径：本探针**不制造** 429 来逼写入（那会吃掉整片预算并污染后续）；P3 的在线部分等真有自然 429 样本时补，判据核以离线自检 + src/egress 单测为准');
      } else if (id === 'P4') {
        console.log('P4 落帧验证 —— 需 WS 订阅 /api/stats/live；探针按 HTTP 侧只验台账与冷却可观测性，帧面由 src/api/routes/live.ts 单测 + 真帧三张（.ekko-tmp/egress-realframe/frames.json）钉死');
        const j = judgeFrame({ type: 'egress_cooldown', serverTime: new Date().toISOString(), egressId: '(待真帧)', cooldownUntil: null, sig: {}, id: 'egress:(待真帧)' }, '(待真帧)');
        console.log(`     帧形核：${j.length === 0 ? '合规' : j.join(' | ')}`);
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      console.log(`${id} 未能执行 → ${safe(lastErr, 160)}`);
      incomplete = true;
    }
  }

  console.log('');
  console.log('════ 汇总（全脱敏）════');
  console.log(`出网 ${state.requests}/${BUDGET} 次；台账 ${state.rows.length} 行；命中 ${state.hits.length} 条`);
  console.log(state.requests >= BUDGET
    ? `⚠ 本片在出口预算处用尽：其余分片用 PROBE_ONLY=<id,...> PROBE_COOLDOWN_MS=180000 重跑。「没发出去」不等于「没观察到」。`
    : `预算未用尽（已用 ${state.requests} 次）`);

  /* 零遗留：探针 key 若本次现场建过，必须删掉 */
  if (state.createdTokenNo !== null) {
    console.log(`探针 key token_no=${state.createdTokenNo} 待删（TTL 兜底 ${new Date(Math.floor(Date.now() / 1000) + 600).toISOString()}）`);
  } else {
    console.log('零遗留：本次未现场建任何 key（探针 key 由执行者会话直连侧持有，用完在对面删）');
  }
  return incomplete ? 1 : 0;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

if (OFFLINE) {
  process.exit(offlineSelfCheck());
} else {
  runOnline().then((code) => process.exit(code)).catch((err: unknown) => {
    console.error('探针自身异常：', safe(err instanceof Error ? `${err.name}: ${err.message}` : String(err)));
    process.exit(1);
  });
}
