// TokenRhythm（tokenrhythm.studio）**管理面**驱动器 —— 第二个特殊供应商（契约 §15.14）。
//
// 与 `tierflow.ts` 的关系：**结构上实现同一个 `TierFlowClient` 接口**，所以六个批量端点
// （import / refresh / :id/login / :id/test / keys / keys/sync）连同被动重登、账号级节奏、
// 逐行累加那一整套机制**原样复用**；两家真正的差异不是"字段名不同"，是**能力集不同**。
// 能力差异全部收在具名操作的实现里，不往调用方漏：
//
// ## 实测事实（2026-10-18/19 现场钉死，共 12 轮探针；与随附文档不符处以实测为准）
//
//   - **信封**：`{code:0,message,data,traceId}`。`code` 是数字 0 才是成功；
//     业务错误给**字符串码**（`"UNAUTHORIZED"` / `"BAD_REQUEST"` / `"CSRF_INVALID"`）。
//   - **认证**：Cookie `tr_session`。401 `UNAUTHORIZED` = 会话失效（§15.9 被动重登的触发条件）。
//   - **没有密码登录这条路**（v1.16.1 订正，见下）：站点**只有会话鉴权**，账号面拿不到
//     "用账号密码换一枚会话"的能力。**凭据只能是会话**（§15.9 会话型），HTTP `import`
//     那套密码通路对这家整体不适用（服务端在入口 422，见 `supplier-accounts.ts`）。
//   - **写请求的 CSRF**：文档说「带 Origin」——**实测只带 Origin/Referer 一律 403**。
//     硬性要求是 `Sec-Fetch-Site: same-origin`（单变量 A/B：只有它就 200，没有它必 403）。
//     `tr_csrf` cookie 与 `X-CSRF-Token` 头**同值双发**；token 每个响应都轮换但**非一次性**
//     （复用最新一枚连发两次写均 200）。403 与 401 是**两条路**：伪造会话 + 合法 csrf 回 403，
//     所以 403 绝不能映射成 `session_expired`（那会触发无谓的密码重登）。
//   - **余额**：`GET /api/wallet/summary.availableBalanceCny`（文档没写；实测发现）。
//     8 位小数的 CNY **字符串**。转账流水端点 (`/api/wallet/transactions`) 只在
//     summary 失效时才有用，这里不用。
//   - **建 key**：**1 次请求**（TierFlow 是 2 次），`POST /api/api-keys {name}`，
//     `data.key` 是完整明文**只此一次**，`data.id` 是 UUID。
//   - **掩码**：`sk_tr_5o****6Us8C0` —— 可见尾巴与明文真值的尾 4 一致，
//     所以 `maskTail`/`maskFromUpstream`（tierflow.ts）对 TokenRhythm **原样可用**。
//   - **没有的概念**：套餐（subscriptions）、key 额度（quota/unlimited_quota）、
//     模型白名单（model_limits）、quota_per_unit。`subscriptions()` 不发请求直接回 `[]`；
//     建 key 只发 `{name}`，额度/白名单由服务端在入口 422（§15.14），驱动器不再二次报错。
//
// 三条纪律与 tierflow.ts 逐字相同：凭据只进不出（`scrubCredentials`）、失败不抛异常
// （一律 `ok:false`）、HTTP 缝注入（离线可测）。

import {
  adminRootOf,
  DEFAULT_TIMEOUT_MS,
  maskFromUpstream,
  scrubCredentials,
  type AccountSelfSnapshot,
  type LoginOutcome,
  type RequestSpec,
  type RotateSubscriptionOutcome,
  type TierFlowClient,
  type TierFlowOptions,
  type TierFlowResult,
  type UpstreamTokenRow,
} from './tierflow.js';

/** 实测全部带浏览器 UA 发的请求；不带 UA 的形状**未实测**，保持与实测一致。 */
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0';

/**
 * 写请求的硬性要求（单变量 A/B 钉死，见文件头）。这**不是**可选的礼貌头：
 * 缺它上游回 403 `CSRF_INVALID`，而文档写的 `Origin` 顶替不了它。
 */
const SEC_FETCH_SITE = { 'Sec-Fetch-Site': 'same-origin' } as const;

export const TOKENRHYTHM_PATHS = {
  /** 当前用户（uid / 用户名；也是 CSRF 的种子端点 —— 任何 GET 都会回发新 tr_csrf） */
  me: '/api/me',
  /** 余额唯一来源（实测发现，文档未载） */
  walletSummary: '/api/wallet/summary',
  /** key 列表 + 建 key（`POST` 同一路径） */
  apiKeys: '/api/api-keys',
} as const;

// ---------------------------------------------------------------------------
// 信封解码（TokenRhythm 形状：code 是数字 0 才是成功）
// ---------------------------------------------------------------------------

interface TrEnvelope {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

export interface DecodedTrEnvelope {
  success: boolean;
  message: string | null;
  data: unknown;
}

/**
 * 解码 `{code,message,data}` 信封。
 *
 * 判据与 tierflow 的 `success` 字段不同但取向相同（把失败判成成功的代价不对称）：
 * **只有 `code === 0`（数字）才算成功**。业务错误给的是字符串码（`"UNAUTHORIZED"`），
 * `== '0'` 一类的宽松比较会把 `"0"` 串也放过 —— 不放宽。
 * 非对象响应按成功交出原文（与 tierflow `decodeEnvelope` 同一容错：个别平铺端点）。
 */
export function decodeTrEnvelope(body: unknown): DecodedTrEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { success: true, message: null, data: body };
  }
  const env = body as TrEnvelope;
  const failed = env.code !== 0;
  return {
    success: !failed,
    message: typeof env.message === 'string' && env.message !== '' ? env.message : null,
    data: env.data === undefined ? body : env.data,
  };
}

// ---------------------------------------------------------------------------
// 余额（纯函数 —— 8 位小数字符串 → 分）
// ---------------------------------------------------------------------------

/**
 * `"23.66510789"` → `2367` 分。**只在驱动器这一处换算**。
 *
 * 上游给的是**字符串**不是数字（实测 12 位有效数字全保留，JS number 仍有余量），
 * 解析不出有限数就 `null` —— 不可信就不猜（§14.2：写 NULL 会把真值抹成"未知"，
 * 但**编一个数**比那更糟，它是错的"已知"）。
 */
export function cnyToCents(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null; // Number('') 是 0 —— 空串不是"零余额"，是"没有可信值"
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

interface TrCallOutcome {
  /** 分类前的原始件：401 / 403 / 非 2xx 都要先看它 */
  status: number;
  text: string;
  parsed: unknown;
  /** JSON 解析失败时为 true（200 + 非 JSON 也是一条可报的路） */
  parseFailed: boolean;
  setCookies: readonly string[];
}

/**
 * 为什么 client 里要有一个**可变 jar**：`tr_csrf` 每个响应都轮换，写请求必须回发
 * "最后一次拿到的那枚"。而 `clientFor` 是**每账号一次**地 new 出来的（六个端点共用），
 * 所以 jar 的生命周期 = 一次账号级操作 —— 不跨账号、不跨任务，不存在"把 A 账号的
 * csrf 拿去 B 账号"这种形状（csrf 绑会话，跨了也只会 403 再自愈）。
 *
 * `tr_session` **刻意不进 jar**：会话永远从 `credential.session` 来（调用方从密文库解出），
 * jar 只存 csrf 这一枚"协议内部状态"。
 */
export function createTokenrhythmClient(options: TierFlowOptions): TierFlowClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const adminRoot = adminRootOf(options.baseUrl);
  const fetchImpl = options.fetchImpl;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jar = new Map<string, string>();

  // --- 内部：一次裸 HTTP ---

  async function fetchOnce(
    method: RequestSpec['method'],
    path: string,
    input: { body?: unknown; session?: string; csrfHeader?: string | null; writeHeaders?: boolean },
  ): Promise<TrCallOutcome | { ok: false; failure: 'unreachable' | 'timeout'; message: string }> {
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
    const cookieParts: string[] = [];
    if (input.session !== undefined) cookieParts.push(`tr_session=${input.session}`);
    if (jar.has('tr_csrf')) cookieParts.push(`tr_csrf=${jar.get('tr_csrf') ?? ''}`);
    if (cookieParts.length > 0) headers.Cookie = cookieParts.join('; ');
    if (input.body !== undefined) headers['Content-Type'] = 'application/json';
    if (input.writeHeaders === true) {
      Object.assign(headers, SEC_FETCH_SITE);
      headers.Origin = adminRoot;
      headers.Referer = `${adminRoot}/account/keys`;
      if (input.csrfHeader !== undefined && input.csrfHeader !== null) headers['X-CSRF-Token'] = input.csrfHeader;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(adminRoot + path, {
        method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal,
      });
    } catch {
      const timedOut = controller.signal.aborted;
      return {
        ok: false,
        failure: timedOut ? 'timeout' : 'unreachable',
        message: timedOut ? `上游请求超时（${timeoutMs}ms）` : '上游不可达',
      };
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let parsed: unknown = null;
    let parseFailed = false;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parseFailed = true;
      }
    }
    absorb(res);
    return { status: res.status, text, parsed, parseFailed, setCookies: setCookiesOf(res) };
  }

  /** 采纳响应回发的 cookie（tr_csrf 轮换 / 清除；tr_session 由调用方单独取，不进 jar）。 */
  function absorb(res: Response): void {
    for (const cookie of setCookiesOf(res)) {
      const i = cookie.indexOf('=');
      if (i < 0) continue;
      const name = cookie.slice(0, i).trim();
      const value = cookie.slice(i + 1).split(';')[0] ?? '';
      if (name !== 'tr_csrf') continue;
      if (value === '') jar.delete(name);
      else jar.set(name, value);
    }
  }

  // --- 内部：把一次裸 HTTP 的结果分类成 TierFlowResult ---

  function classify(outcome: TrCallOutcome, secrets: readonly (string | null | undefined)[]): TierFlowResult<unknown> {
    const message = (fallback: string): string => {
      const env = decodeTrEnvelope(outcome.parsed);
      const raw = env.message ?? (outcome.text === '' ? null : outcome.text.slice(0, 200));
      return scrubCredentials(raw ?? fallback, secrets);
    };

    if (outcome.status === 401) {
      // §15.9 被动重登的唯一触发条件（403 不走这条，见下）。
      return { ok: false, failure: 'session_expired', httpStatus: 401, message: message('会话失效') };
    }
    if (outcome.status === 403) {
      // 实测：403 = CSRF 校验失败（伪造会话时也回 403 而非 401）。**绝不映射成 session_expired**
      // —— 那会触发一次注定失败的密码重登。403 的自愈在 `writeWithCsrf` 里做，
      // 走到这里的 403 是自愈也救不回来的，按业务拒绝报。
      return { ok: false, failure: 'rejected', httpStatus: 403, message: message('CSRF 校验失败') };
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      return { ok: false, failure: 'http_error', httpStatus: outcome.status, message: message(`上游返回 HTTP ${outcome.status}`) };
    }
    if (outcome.parseFailed) {
      // 2xx 但不是 JSON：归到 rejected 让调用方看见上游说了什么。
      return {
        ok: false,
        failure: 'rejected',
        httpStatus: outcome.status,
        message: scrubCredentials(outcome.text.slice(0, 200), secrets),
      };
    }
    const env = decodeTrEnvelope(outcome.parsed);
    if (!env.success) {
      return { ok: false, failure: 'rejected', httpStatus: outcome.status, message: message('上游拒绝了本次请求') };
    }
    return { ok: true, data: env.data, httpStatus: outcome.status };
  }

  // --- 内部：带 CSRF 的写请求（seed → 发 → 403 自愈一次 → 重发一次） ---

  /**
   * 写请求的完整礼数（实测钉死）：`Sec-Fetch-Site: same-origin` + `tr_csrf` cookie 与
   * `X-CSRF-Token` **同值双发**。jar 里没有 token 时先打一发 `GET /api/me` 种它
   * （任何成功响应都会回发新 tr_csrf）。
   *
   * 403 时**自愈一次**：强制重新种（403 响应**不回发** tr_csrf —— 实测，jar 里那枚
   * 刚被拒，不重种就原样重发必再 403）→ 重发一次。不再循环 —— CSRF 连续失败不是
   * "再试就能过"的形状，多半是协议又变了，报出去让人看。
   *
   * **种子 GET 顺带当会话探针**：死会话 + 写请求回的是 403 `CSRF_INVALID`（实测）而非
   * 401 —— 不看种子的话，一次该触发被动重登的 `session_expired` 会被伪装成
   * `rejected`，`callWithRelogin` 就不会重登了。所以种子的 401 直接原样上报。
   */
  async function writeWithCsrf(
    path: string,
    body: unknown,
    session: string,
    secrets: readonly (string | null | undefined)[],
  ): Promise<TierFlowResult<unknown>> {
    type Once = TrCallOutcome | { ok: false; failure: 'unreachable' | 'timeout'; message: string };
    const send = async (): Promise<Once> =>
      fetchOnce('POST', path, { body, session, csrfHeader: jar.get('tr_csrf') ?? null, writeHeaders: true });

    /** 判"这是不是一次可用的响应"（另一个分支只有 unreachable/timeout 两种）。 */
    const isResponse = (v: Once): v is TrCallOutcome => 'status' in v;

    /**
     * 种 csrf。`force` 强制重种（403 自愈路径）：非强制时 jar 里已有就**不发请求**
     * （正常路径的第一发不该多花一次 GET）。
     * 返回 false = 种子探到 401（会话已死，调用方应按 session_expired 处理）。
     */
    const seed = async (force = false): Promise<boolean> => {
      if (!force && jar.has('tr_csrf')) return true;
      const s = await fetchOnce('GET', TOKENRHYTHM_PATHS.me, { session });
      return !isResponse(s) || s.status !== 401;
    };

    if (!(await seed())) {
      return { ok: false, failure: 'session_expired', httpStatus: 401, message: '会话失效' };
    }
    let outcome = await send();
    // 403 自愈：强制重种一次（jar 里的旧枚刚被拒）→ 重发一次。仍 403 就走 classify 报 rejected。
    if (isResponse(outcome) && outcome.status === 403 && (await seed(true))) {
      outcome = await send();
    }
    if (!isResponse(outcome)) {
      return { ok: false, failure: outcome.failure, httpStatus: 0, message: outcome.message };
    }
    return classify(outcome, secrets);
  }

  // --- 具名操作 ---

  return {
    baseUrl,
    adminRoot,

    /** 裸请求（单发、无 CSRF 自愈）。TokenRhythm 的六端点路径不经过这里，留作调试缝。 */
    async request(spec: RequestSpec): Promise<TierFlowResult<unknown>> {
      const session = spec.credential?.session;
      const secrets = [session];
      const outcome = await fetchOnce(spec.method, spec.path, {
        body: spec.body,
        session: session === undefined ? undefined : session,
        // 请求缝带 credential 时按写请求的礼数发（GET 多带几个头无害，实测确认）。
        writeHeaders: spec.method !== 'GET',
        csrfHeader: spec.method === 'GET' ? null : jar.get('tr_csrf') ?? null,
      });
      if (!('status' in outcome)) {
        return { ok: false, failure: outcome.failure, httpStatus: 0, message: outcome.message };
      }
      return classify(outcome, secrets);
    },

    /**
     * **TokenRhythm 没有密码登录这条路**（v1.16.1 订正）：站点对 `/api/*` 只有会话鉴权
     * （文档明写 Cookie `tr_session`，全篇没有登录端点）。`/api/auth/login` 这个路径
     * **存在但不是账号密码登录** —— 对 `{account,password}` 的任何取值一律 401
     * `UNAUTHORIZED`（与"会话过期"同码同文案），真登录走的是 `/api/auth/login-or-register`
     * 一类的**验证码 / 安全验证**流程（`channel` 字段、`CAPTCHA_REQUIRED`），浏览器外
     * 无法完成，也**不该**由网关代做（那是一个带人机验证的注册面，不是凭据面）。
     *
     * 所以这个操作在这里是**能力缺口**而不是网络调用：不发请求、直接 `rejected`。
     * 正常路径下服务端在入口就 422 了（§15.14.1 能力表「密码登录 ❌」），这里是
     * 兜底 —— 与 `rotateSubscriptionToken` 同一取向：一个不存在的操作成功了比失败更难排查。
     */
    async login(_identifier: string, _password: string): Promise<TierFlowResult<LoginOutcome>> {
      return {
        ok: false,
        failure: 'rejected',
        httpStatus: 0,
        message: 'TokenRhythm 只有会话鉴权（tr_session），没有账号密码登录（§15.14.1 能力表）',
      };
    },

    /**
     * 账号自身 = **两腿**：`/api/me`（uid / 用户名）+ `/api/wallet/summary`（余额）。
     * 两条都成功才算成功 —— refresh 的承诺是"余额 + 套餐"，TokenRhythm 没有套餐腿，
     * 余额腿拆成两发后总请求数与 TierFlow 的 refresh 持平（2 次，§15.5 预算不破）。
     *
     * `quotaPerUnit` 落 `100`（1 元 = 100 分）：TokenRhythm 没有 quota 概念，这个值
     * 只为让"分"口径自洽（`persistQuotaPerUnit` 会把它记进库），建 key 不消费它。
     */
    async self(credential: { session: string; tfUser: string | null }): Promise<TierFlowResult<AccountSelfSnapshot>> {
      const secrets = [credential.session];
      const me = await fetchOnce('GET', TOKENRHYTHM_PATHS.me, { session: credential.session });
      if (!('status' in me)) return { ok: false, failure: me.failure, httpStatus: 0, message: me.message };
      const meRes = classify(me, secrets);
      if (!meRes.ok) return meRes;

      const wallet = await fetchOnce('GET', TOKENRHYTHM_PATHS.walletSummary, { session: credential.session });
      if (!('status' in wallet)) return { ok: false, failure: wallet.failure, httpStatus: 0, message: wallet.message };
      const walletRes = classify(wallet, secrets);
      if (!walletRes.ok) return walletRes;

      const meData = asRecord(meRes.data);
      const walletData = asRecord(walletRes.data);
      return {
        ok: true,
        httpStatus: meRes.httpStatus,
        data: {
          uid: readString(meData, 'id'),
          username: readString(meData, 'name'),
          balanceCents: cnyToCents(walletData?.['availableBalanceCny']),
          unlimited: false,
          currency: readString(walletData, 'currency') ?? 'CNY',
          quotaPerUnit: 100,
          raw: { me: meRes.data, wallet: walletRes.data },
        },
      };
    },

    /** TokenRhythm 没有套餐。**不发请求**直接回空数组 —— 调用方的套餐腿对它天然是 no-op。 */
    async subscriptions(): Promise<TierFlowResult<readonly unknown[]>> {
      return { ok: true, httpStatus: 0, data: [] };
    },

    /**
     * 该账号站点上的全部 key。列表**无分页**（实测一页全量；账号 key 数有创建上限，
     * 上限内一页装得下）。删除的 key 不再出现（实测），停用的仍在 —— 台账对账口径
     * 与 TierFlow 一致：以"上游还认的 key"为准。
     */
    async tokens(credential: { session: string; tfUser: string | null }, nameFilter?: string): Promise<TierFlowResult<readonly UpstreamTokenRow[]>> {
      const secrets = [credential.session];
      const outcome = await fetchOnce('GET', TOKENRHYTHM_PATHS.apiKeys, { session: credential.session });
      if (!('status' in outcome)) return { ok: false, failure: outcome.failure, httpStatus: 0, message: outcome.message };
      const res = classify(outcome, secrets);
      if (!res.ok) return res;

      const list = Array.isArray(res.data) ? res.data : [];
      const rows: UpstreamTokenRow[] = [];
      for (const item of list) {
        const row = asRecord(item);
        if (row === null) continue;
        const rawMask = readString(row, 'maskedKey') ?? '';
        rows.push({
          name: readString(row, 'name') ?? '',
          mask: rawMask,
          tail: rawMask === '' ? null : trMaskTail(rawMask),
          // TokenRhythm 的 key 无额度概念：`unlimited:true` + `remainQuota:null`
          // 与"无限额度 key 落 NULL 余额"的 §15.7 口径一致（不确定 ≠ 0）。
          unlimited: true,
          remainQuota: null,
          models: null,
          raw: item,
        });
      }
      const filtered = nameFilter === undefined || nameFilter === '' ? rows : rows.filter((r) => r.name === nameFilter);
      return { ok: true, httpStatus: res.httpStatus, data: filtered };
    },

    /**
     * 建 key = **1 次请求**（TierFlow 是 2 次）。Body **只有 `{name}`**：
     * TokenRhythm 的 key 无额度、无模型白名单（§15.14 能力表），入参里的
     * `unlimited` / `quotaCents` / `models` / `quotaPerUnit` 一概忽略 ——
     * 服务端在 `keys` 端点入口已对"指定了额度/白名单"的请求 422，到这里的一律是
     * 没指定的，忽略即无歧义。
     */
    async createToken(
      credential: { session: string; tfUser: string | null },
      input: { name: string },
    ): Promise<TierFlowResult<{ tokenNo: string | null; maskedKey: string | null; plaintext: string | null; raw: unknown }>> {
      const res = await writeWithCsrf(TOKENRHYTHM_PATHS.apiKeys, { name: input.name }, credential.session, [
        credential.session,
      ]);
      if (!res.ok) return res;

      const data = asRecord(res.data);
      const plaintext = readString(data, 'key');
      if (plaintext === null) {
        // 实测创建响应必带明文（文档 §3 亦同）；真出现时按 KEY_PLAINTEXT_MISSING 语义报，
        // 调用方不会入池一把没有明文的 key。
        return {
          ok: false,
          failure: 'rejected',
          httpStatus: res.httpStatus,
          message: '创建响应里没有明文 key（data.key）—— 形状与驱动器预期不符',
          raw: res.data,
        };
      }
      const maskedFromUpstream = maskFromUpstream(readString(data, 'maskedKey') ?? plaintext);
      return {
        ok: true,
        httpStatus: res.httpStatus,
        data: {
          // `data.id` 是 UUID；DTO 侧 `toTokenNo` 解析不出整数落 null，属预期（§15.14）。
          tokenNo: readString(data, 'id'),
          maskedKey: maskedFromUpstream,
          plaintext,
          raw: res.data,
        },
      };
    },

    /** 删上游 key：`POST …/{id}/delete`，Body `{}`（实测形状；REST 风格的 DELETE 不存在）。 */
    async deleteToken(credential: { session: string; tfUser: string | null }, tokenId: string): Promise<TierFlowResult<unknown>> {
      return writeWithCsrf(
        `${TOKENRHYTHM_PATHS.apiKeys}/${encodeURIComponent(tokenId)}/delete`,
        {},
        credential.session,
        [credential.session],
      );
    },

    /**
     * 套餐专属 key 轮换：TokenRhythm **没有套餐**，此操作不存在。不发请求、直接报
     * `rejected`。正常路径下服务端在入口就 422 了（§15.14），这里是不让"绕过入口直接
     * 拿驱动器"的调用静默成功 —— 一个不存在的操作成功了比失败更难排查。
     */
    async rotateSubscriptionToken(
      _credential: { session: string; tfUser: string | null },
      _subNo: string,
    ): Promise<TierFlowResult<RotateSubscriptionOutcome>> {
      return {
        ok: false,
        failure: 'rejected',
        httpStatus: 0,
        message: 'TokenRhythm 无套餐专属 key，不支持轮换（§15.14 能力表）',
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * TokenRhythm 掩码的后 4 位。`sk_tr_5o****6Us8C0` 的前缀是 `sk_tr_`（不是 tierflow 的
 * `sk-`），tierflow 的 `maskTail` 不剥它也**不影响**取尾 4 —— 但语义上它是 TokenRhythm
 * 自己的形状，单独一个函数把这层认识钉在这里；真值与掩码尾 4 一致是**实测样例**证的
 * （`sk_tr_agdXBT…RF-BD8` ↔ `sk_tr_ag****RF-BD8`）。
 */
function trMaskTail(upstreamMask: string): string | null {
  const s = upstreamMask.trim();
  return s.length >= 4 ? s.slice(-4) : null;
}

function setCookiesOf(res: Response): readonly string[] {
  const get = (res as unknown as { headers?: { getSetCookie?: () => string[] } }).headers?.getSetCookie;
  return typeof get === 'function' ? get.call((res as unknown as { headers: Record<string, unknown> }).headers) : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(source: unknown, key: string): string | null {
  const record = asRecord(source);
  const value = record === null ? undefined : record[key];
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}
