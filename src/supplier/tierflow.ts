// TierFlow **管理面**驱动器（契约 §15 / §16.1）。
//
// 管理面 = 账号池那条链：登录、刷余额、建 key、对账 key。**数据面（`/v1/*` relay）不在这里**，
// 那是 §16、路由者的车道。
//
// 为什么单独一个模块，而不是把协议塞进六个路由里：
//   - 它是**上游协议的唯一落点**。端点 / 信封 / quota 单位 / 掩码规则散进六个端点，
//     改一处就漏五处 —— 而漏掉的那五处不会报错，只会静默对不上账（§16.3 警告过的同一类事）。
//   - §15.2 剩下六个端点（`import` / `refresh` / `:id/login` / `:id/test` / `keys` / `keys/sync`）
//     全部经它打上游。它是它们共同的缝，也是"卡凭据"与"能离线做"之间的那条切法：
//     **协议与玩法离线写、离线测；真机验证由凭据持有者跑**（§16.1.1）。
//
// 三条纪律，落成代码而不是留在文档里：
//   1. **凭据只进不出**：`password` / `session` 只在本次调用的栈内存在，不存字段、不进错误消息、
//      不进日志。任何要外露的字符串先过 `scrubCredentials()` —— 上游会把凭据回显在报错体里
//      （余额那条链已经踩过，见 `balance/raw.ts` 的文件头）。
//   2. **失败不抛异常**，一律返回 `ok:false`：批量里一个账号失败不该让其余账号的进度一起丢掉
//      （沿用 `api/services/balance-query.ts` 的既有惯例）。
//   3. **HTTP 缝是注入的**：`fetchImpl` 由调用方给。测试注入假 fetch ⇒ 全部用例离线跑、零网络。
//
// ⚠️ **未实测面（§16.1.1 登记）**：本文件里凡标「待实测」的，都是**凭据持有者跑一次就能钉死**的形状。
// 这类形状被刻意收进下面那三个 `pending*` 小函数 —— 实测回来后**只改那三处**，
// 不要在这里长第二套分支：容错只留一处，两处就会漂。

/** 1 元 = 500000 quota（§15.6，工作台 `/api/status → config.quota_per_unit`）。 */
export const DEFAULT_QUOTA_PER_UNIT = 500_000;

/** 单次请求超时。契约没给数，取一个"比上游慢但比人的耐心快"的值。 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** 上游把凭据回显出来时的替换物。写成常量是为了让它**看起来就不像数据**。 */
const MASK = '****';

export type TierFlowFailure =
  /** 连不上：DNS / 连接被拒 / TLS */
  | 'unreachable'
  /** 超时。与 unreachable 分开是为了让操作员一眼看出"是慢还是不通" */
  | 'timeout'
  /** 401 / 403 —— §15.9 被动重登的**唯一**触发条件 */
  | 'session_expired'
  /** HTTP 200 + `success:false`：上游自己的业务错误（文档 §1.2 / §8.2） */
  | 'rejected'
  /** 其它非 2xx */
  | 'http_error';

export interface TierFlowOk<T> {
  ok: true;
  data: T;
  httpStatus: number;
}

export interface TierFlowErr {
  ok: false;
  failure: TierFlowFailure;
  httpStatus: number;
  /** **已擦除凭据**的一句话。可以直接进日志 / 进任务 result。 */
  message: string;
  /**
   * 上游响应体**原样**（解不出 JSON 时是截断后的原文），连不上时为 `null`。
   *
   * 存在的理由是 `:id/test`：诊断端点的主诉是"取值路径没配对"，而配对失败时
   * 唯一的线索就是上游到底回了什么 —— 只给一句 `message` 的诊断是不可诊断的。
   *
   * ⚠ **未净化**（与 `AccountSelfSnapshot.raw` 同一纪律）：上游会在报错体里**回显本次
   * 请求带的凭据**，而擦除要那把账号的密码/会话 —— 驱动器只有本次请求用的会话，密码它拿不到，
   * 也**不该**为了擦一句话去拿。所以净化一律在**出口侧**做（§15.2 `SupplierTestResult.raw`
   * 过 `sanitizeUpstreamBody`）。**任何直接把它塞进日志 / 响应 / result 的写法都是凭据泄漏。**
   */
  raw?: unknown;
}

export type TierFlowResult<T> = TierFlowOk<T> | TierFlowErr;

/**
 * 一个账号手里有的两路凭据（§15.9）。
 * `password` 非空 ⇒ `credentialSource = "password"`（密码是超集能力：有密码就一定能登）；
 * 否则是 `"session"`，会话一过就回不来，**两路重登都不触发**。
 */
export interface AccountCredential {
  identifier: string;
  password: string | null;
  session: string | null;
  tfUser: string | null;
}

export function credentialSource(cred: {
  password: string | null;
}): 'password' | 'session' {
  return cred.password !== null ? 'password' : 'session';
}

// ---------------------------------------------------------------------------
// 凭据擦除
// ---------------------------------------------------------------------------

/**
 * 把所有非空 `secret` 的出现替换成 `****`。
 *
 * 存在的理由与 `balance/raw.ts` 逐字相同：上游的报错体里会带凭据
 * （"invalid session xxx" 一类），原样转发等于把会话从服务端搬到浏览器 / 日志。
 */
export function scrubCredentials(
  text: string,
  secrets: readonly (string | null | undefined)[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === null || secret === undefined || secret === '') continue;
    out = out.split(secret).join(MASK);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 信封与分类
// ---------------------------------------------------------------------------

export interface TierFlowEnvelope {
  success?: unknown;
  message?: unknown;
  data?: unknown;
}

export interface DecodedEnvelope {
  success: boolean;
  message: string | null;
  data: unknown;
}

/**
 * 解码上游信封 `{ success, message, data }`。
 *
 * 判据刻意**取宽**：`false` / `0` / `'false'` 都算失败。因为两个方向的代价不对称 ——
 * 把成功判成失败是"这一轮白跑、重跑一次"，把失败判成成功是 §16.2 那一类
 * **静默把错误当成功**（余额耗尽被判成成功调用、死 key 永远被选中）。
 * `success` 字段缺失时按成功处理（`/api/status` 一类只读端点未必带这个字段）。
 */
export function decodeEnvelope(body: unknown): DecodedEnvelope {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { success: true, message: null, data: body };
  }
  const env = body as TierFlowEnvelope;
  const raw = env.success;
  const failed = raw === false || raw === 0 || raw === 'false';
  return {
    success: !failed,
    message: typeof env.message === 'string' ? env.message : null,
    // `data` 缺席时把整个信封给出去：有些端点（`/api/status`）本来就是平铺的。
    data: env.data === undefined ? body : env.data,
  };
}

// ---------------------------------------------------------------------------
// 金额与掩码（纯函数 —— 契约里最容易搞错的两处）
// ---------------------------------------------------------------------------

/** quota → 分。`null` = 上游给的不是个数（不可信就不猜）。 */
export function quotaToCents(
  quota: unknown,
  quotaPerUnit: number = DEFAULT_QUOTA_PER_UNIT,
): number | null {
  if (typeof quota !== 'number' || !Number.isFinite(quota)) return null;
  return Math.round((quota / quotaPerUnit) * 100);
}

/** 分 → quota。**只在这一处换算**，前端不乘 500000（§15.2 `keys` 入参）。 */
export function centsToQuota(
  cents: number,
  quotaPerUnit: number = DEFAULT_QUOTA_PER_UNIT,
): number {
  return Math.round((cents / 100) * quotaPerUnit);
}

/**
 * 上游 key 的余额口径（§15.7 落库规则，**不是可选的**）。
 *
 * `unlimited_quota:true` 时上游给的 `remain_quota` 是**无意义占位**
 * （实测样例 `-331119`）。把它落进 `balance_cents` 会让这把 key 被网关卡在
 * `balance_cents <= 0 → 排除`上**静默踢出选路**：不报错、不告警、不进冷却，
 * 客户端只看到「没有可用 key」。所以无限额度必须落 `NULL`（"未知 ≠ 0、仍可用"那条分支）。
 */
export function resolveBalanceCents(
  input: { unlimitedQuota: boolean; remainQuota: unknown },
  quotaPerUnit: number = DEFAULT_QUOTA_PER_UNIT,
): { unlimited: boolean; balanceCents: number | null } {
  if (input.unlimitedQuota) return { unlimited: true, balanceCents: null };
  return {
    unlimited: false,
    balanceCents: quotaToCents(input.remainQuota, quotaPerUnit),
  };
}

/**
 * 从上游掩码里取**后 4 位** —— 与池内 `masked_key` 对账的唯一可用键（§15.2 `keys/sync`）。
 *
 * 上游给的是 `NcBZ**********WnWw` 这种"前 4 + 后 4"，而我们的 `maskKey()`
 * （`src/db/crypto.ts`）只留后 4：**只有后 4 位是两边都有的**。
 * 比对前先剥 `sk-`：`/api/token/search` 的掩码不含它，`/api/subscription/self/token`
 * 给的却是 `sk-k58R**********vFnt` —— 不剥就永远匹配不上。
 *
 * 长度不足以取后 4 时返回 `null`：**不猜**。宁可少对一次账，也不要把 A key 的余额
 * 写到 B key 上（§15.2 的 `KEY_MASK_AMBIGUOUS` 是同一条取向）。
 */
export function maskTail(upstreamMask: string): string | null {
  const s = upstreamMask.trim();
  const stripped = s.startsWith('sk-') ? s.slice(3) : s;
  return stripped.length >= 4 ? stripped.slice(-4) : null;
}

/** 上游掩码 → 池内 `masked_key` 形态（`****` + 后 4 位，与 `maskKey()` 同形）。 */
export function maskFromUpstream(upstreamMask: string): string | null {
  const tail = maskTail(upstreamMask);
  return tail === null ? null : `${MASK}${tail}`;
}

// ---------------------------------------------------------------------------
// ⚠️ 待实测：三处形状（唯一容错点，实测回来只改这里）
// ---------------------------------------------------------------------------

/** 待实测（§16.1.1）：登录请求体。文档 §8 只写了端点与"换一枚新 session"。 */
export function pendingLoginBody(identifier: string, password: string): Record<string, unknown> {
  return { username: identifier, password };
}

/**
 * 待实测（§16.1.1）：凭据怎么带。
 *
 * 契约钉死的只有**值叫什么**（`session` / `TF-User`，§15.9），没钉**怎么传**。
 * 这里按"同名请求头"实现 —— 若实测是 cookie 形态，**只改这一个函数**，
 * 其余代码不必知道凭据是怎么走的（这正是把缝放在这里的原因）。
 */
export function pendingAuthHeaders(cred: { session: string; tfUser: string | null }): Record<string, string> {
  const headers: Record<string, string> = { session: cred.session };
  if (cred.tfUser !== null && cred.tfUser !== '') headers['TF-User'] = cred.tfUser;
  return headers;
}

/** 待实测（§16.1.1）：建 key 请求体。字段名取自契约 §15.2 的入参表与上游回显样例。 */
export function pendingCreateTokenBody(input: {
  name: string;
  unlimited: boolean;
  quotaCents: number | null;
  models: readonly string[] | null;
  quotaPerUnit: number;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { name: input.name };
  if (input.unlimited) {
    body['unlimited_quota'] = true;
  } else {
    body['unlimited_quota'] = false;
    body['remain_quota'] = centsToQuota(input.quotaCents ?? 0, input.quotaPerUnit);
  }
  // 省略或空数组 = 不设白名单（§15.2）。**不给空 CSV** —— 那正好是 v1.4.6 登记的那条
  // 「全禁还是不限」的悬空语义，没实测前根本不发这个字段，就不会踩。
  if (input.models !== null && input.models.length > 0) {
    body['model_limits_enabled'] = true;
    body['model_limits'] = input.models.join(',');
  }
  return body;
}

// ---------------------------------------------------------------------------
// 端点（§16.1：契约自己列过的那四个 + §15.2 用到的其余路径）
// ---------------------------------------------------------------------------

export const TIERFLOW_PATHS = {
  login: '/api/user/login',
  self: '/api/user/self',
  subscriptions: '/api/subscription/self',
  /** 套餐专属 key 的掩码（`?sub_no=`） */
  subscriptionTokens: '/api/subscription/self/token',
  tokenSearch: '/api/token/search',
  tokenCreate: '/api/token/',
  /** 删除**无尾斜杠**：带斜杠 307（文档 §8.4，§15.5 表内钉过）。 */
  tokenDelete: '/api/token',
  status: '/api/status',
} as const;

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export interface TierFlowOptions {
  /** 上游根，如 `https://tierflow.cn`。尾斜杠会被抹掉。 */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RequestSpec {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** 本请求带的凭据；同时作为擦除对象 —— 上游可能把它回显在报错里。 */
  credential?: { session: string; tfUser: string | null };
}

export interface LoginOutcome {
  session: string;
  tfUser: string | null;
  uid: string | null;
  username: string | null;
}

export interface AccountSelfSnapshot {
  uid: string | null;
  username: string | null;
  balanceCents: number | null;
  unlimited: boolean;
  currency: string | null;
  quotaPerUnit: number;
  /**
   * 上游原样（`data` 那一层）。`SupplierTestResult.raw` 要的就是它 —— 契约 §15.2：
   * "想要 quota 原值看 `raw`"。**已过 `decodeEnvelope`**，不是完整信封。
   *
   * 这里**不在这里做净化**：擦除要那把账号的密码/会话，而驱动器只有本次请求用的会话
   * （见 `request()` 的 `secrets`），密码它拿不到也不该拿。净化是**出口**那一侧的事
   * （`services/supplier-accounts.ts` 过 `sanitizeUpstreamBody`），与 §2 自测同一条切法。
   */
  raw: unknown;
}

export interface UpstreamTokenRow {
  /** 上游侧 key 名。`keys` 端点按 `<namePrefix>-<identifier后4>-<序号>` 生成，回查靠它。 */
  name: string;
  /** 上游给的掩码（可能带 `sk-`）。 */
  mask: string;
  /** 掩码后 4 位；取不到时 `null`（不猜）。 */
  tail: string | null;
  unlimited: boolean;
  remainQuota: number | null;
  models: readonly string[] | null;
  raw: unknown;
}

export interface TierFlowClient {
  readonly baseUrl: string;
  /** 裸请求。六个端点之外的调试用；正常路径请用下面的具名操作。 */
  request(spec: RequestSpec): Promise<TierFlowResult<unknown>>;
  /** 登录换会话。**不重试**（每号一次，§15.5）—— 重试策略在调用方。 */
  login(identifier: string, password: string): Promise<TierFlowResult<LoginOutcome>>;
  /** 账号自身（`/api/user/self`）：余额 / quota 的事实源。 */
  self(credential: { session: string; tfUser: string | null }): Promise<TierFlowResult<AccountSelfSnapshot>>;
  /** 套餐列表（`all_subscriptions`，恒为数组 —— 单数对象表达不了它）。 */
  subscriptions(credential: { session: string; tfUser: string | null }): Promise<TierFlowResult<readonly unknown[]>>;
  /** 该账号站点上的全部 key（掩码）。**keyword 留空拉全量再本地过滤**（§15.5）。 */
  tokens(credential: { session: string; tfUser: string | null }, nameFilter?: string): Promise<TierFlowResult<readonly UpstreamTokenRow[]>>;
  /** 建 key。返回的明文**只在此刻存在于栈内**，调用方须当场加密落库。 */
  createToken(
    credential: { session: string; tfUser: string | null },
    input: { name: string; unlimited: boolean; quotaCents: number | null; models?: readonly string[] | null },
  ): Promise<TierFlowResult<{ tokenNo: string | null; maskedKey: string | null; plaintext: string | null; raw: unknown }>>;
  /** 删上游 key。**无尾斜杠**。 */
  deleteToken(credential: { session: string; tfUser: string | null }, tokenId: string): Promise<TierFlowResult<unknown>>;
}

export function createTierFlowClient(options: TierFlowOptions): TierFlowClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(spec: RequestSpec): Promise<TierFlowResult<unknown>> {
    const url = buildUrl(baseUrl, spec.path, spec.query);
    const secrets: (string | null | undefined)[] = [spec.credential?.session, spec.credential?.tfUser];

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    if (spec.credential !== undefined) {
      Object.assign(headers, pendingAuthHeaders(spec.credential));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: spec.method,
        headers,
        body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
        signal: controller.signal,
      });
    } catch {
      const timedOut = controller.signal.aborted;
      return {
        ok: false,
        failure: timedOut ? 'timeout' : 'unreachable',
        httpStatus: 0,
        message: timedOut ? `上游请求超时（${timeoutMs}ms）` : '上游不可达',
      };
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      return { ok: false, failure: 'unreachable', httpStatus: res.status, message: '上游响应读取失败' };
    }

    let parsed: unknown = null;
    let parseFailed = false;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parseFailed = true;
      }
    }

    if (res.status === 401 || res.status === 403) {
      // 会话失效 —— §15.9 被动重登的唯一触发条件。**重登不在这里做**：
      // 这里是驱动器，策略在调用方（`callWithRelogin`），否则每个具名操作都得抄一遍。
      return {
        ok: false,
        failure: 'session_expired',
        httpStatus: res.status,
        message: scrubbedMessage(parsed, text, secrets) ?? '会话失效',
        raw: rawFor(parsed, text),
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        failure: 'http_error',
        httpStatus: res.status,
        message: scrubbedMessage(parsed, text, secrets) ?? `上游返回 HTTP ${res.status}`,
        raw: rawFor(parsed, text),
      };
    }

    if (parseFailed) {
      // 200 但不是 JSON：这两个方向都不该发生，归到 rejected 让调用方看见上游说了什么，
      // 而不是把它当成一个形状对不上的"成功"。
      return {
        ok: false,
        failure: 'rejected',
        httpStatus: res.status,
        message: scrubCredentials(text.slice(0, 200), secrets),
        raw: rawFor(parsed, text),
      };
    }

    const envelope = decodeEnvelope(parsed);
    if (!envelope.success) {
      return {
        ok: false,
        failure: 'rejected',
        httpStatus: res.status,
        message: scrubCredentials(envelope.message ?? '上游拒绝了本次请求', secrets),
        raw: rawFor(parsed, text),
      };
    }

    return { ok: true, data: envelope.data, httpStatus: res.status };
  }

  return {
    baseUrl,
    request,

    /**
     * 登录走**独立**的一次请求，不进 `request()`：它要拿会话，所以**不能带会话**，
     * 而 `request()` 的擦除对象正是"本次请求带的凭据"。混在一起会让人以为
     * "登录也要带 session"，而那个方向是错的。
     */
    login: rawLogin,

    async self(credential) {
      const res = await request({ method: 'GET', path: TIERFLOW_PATHS.self, credential });
      if (!res.ok) return res;
      const data = asRecord(res.data);
      const quotaPerUnit = readQuotaPerUnit(data);
      const unlimitedQuota = data?.['unlimited_quota'] === true;
      const balance = resolveBalanceCents(
        { unlimitedQuota, remainQuota: data?.['quota'] ?? data?.['remain_quota'] },
        quotaPerUnit,
      );
      return {
        ok: true,
        httpStatus: res.httpStatus,
        data: {
          uid: readString(data, 'uid') ?? readString(data, 'id'),
          username: readString(data, 'username') ?? readString(data, 'display_name'),
          balanceCents: balance.balanceCents,
          unlimited: balance.unlimited,
          currency: readString(data, 'currency'),
          quotaPerUnit,
          raw: res.data,
        },
      };
    },

    async subscriptions(credential) {
      const res = await request({ method: 'GET', path: TIERFLOW_PATHS.subscriptions, credential });
      if (!res.ok) return res;
      const data = asRecord(res.data);
      const list = data?.['all_subscriptions'];
      // 契约 §15.1：恒为数组。上游给了个单数对象或没给 → `[]`，**不编一个**。
      return { ok: true, httpStatus: res.httpStatus, data: Array.isArray(list) ? list : [] };
    },

    async tokens(credential, nameFilter) {
      // keyword **留空拉全量再本地过滤**：供应商搜索不可靠（文档 §8.5，§15.5 表内钉过）。
      const res = await request({
        method: 'GET',
        path: TIERFLOW_PATHS.tokenSearch,
        query: { keyword: '' },
        credential,
      });
      if (!res.ok) return res;
      const rows = extractTokenRows(res.data);
      const filtered =
        nameFilter === undefined || nameFilter === ''
          ? rows
          : rows.filter((r) => r.name === nameFilter);
      return { ok: true, httpStatus: res.httpStatus, data: filtered };
    },

    async createToken(credential, input) {
      const created = await request({
        method: 'POST',
        path: TIERFLOW_PATHS.tokenCreate,
        body: pendingCreateTokenBody({
          name: input.name,
          unlimited: input.unlimited,
          quotaCents: input.quotaCents,
          models: input.models ?? null,
          quotaPerUnit: DEFAULT_QUOTA_PER_UNIT,
        }),
        credential,
      });
      if (!created.ok) return created;

      const createdData = asRecord(created.data);
      const plaintext = readString(createdData, 'key') ?? readString(createdData, 'token');
      const masked =
        maskFromUpstream(readString(createdData, 'key') ?? '') ??
        readString(createdData, 'masked_key');

      // 建 key = **2 次请求**：创建 + 回查 `token_no`（§15.5 表内钉过）。
      // `token_no` 是回查得到的，不是创建响应里那个（实测前不敢假定创建响应带它）。
      let tokenNo = readString(createdData, 'token_no') ?? readString(createdData, 'id');
      if (tokenNo === null) {
        const again = await request({
          method: 'GET',
          path: TIERFLOW_PATHS.tokenSearch,
          query: { keyword: '' },
          credential,
        });
        if (again.ok) {
          const hit = extractTokenRows(again.data).find((r) => r.name === input.name);
          tokenNo = hit === undefined ? null : readString(asRecord(hit.raw), 'token_no');
        }
      }

      return {
        ok: true,
        httpStatus: created.httpStatus,
        data: {
          tokenNo,
          maskedKey: masked,
          plaintext: plaintext ?? null,
          raw: created.data,
        },
      };
    },

    async deleteToken(credential, tokenId) {
      // **无尾斜杠**：带斜杠 307（文档 §8.4）。
      return request({
        method: 'DELETE',
        path: `${TIERFLOW_PATHS.tokenDelete}/${encodeURIComponent(tokenId)}`,
        credential,
      });
    },
  };

  // --- 内部：登录单列，因为它不带会话（要拿会话，不能带会话）---

  async function rawLogin(
    identifier: string,
    password: string,
  ): Promise<TierFlowResult<LoginOutcome>> {
    const url = buildUrl(baseUrl, TIERFLOW_PATHS.login, undefined);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const secrets = [password];
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(pendingLoginBody(identifier, password)),
        signal: controller.signal,
      });
    } catch {
      const timedOut = controller.signal.aborted;
      return {
        ok: false,
        failure: timedOut ? 'timeout' : 'unreachable',
        httpStatus: 0,
        message: timedOut ? `登录请求超时（${timeoutMs}ms）` : '上游不可达',
      };
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      parsed = null;
    }

    // 登录失败就是登录失败 —— 失败路径**不留任何半边会话**。
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        failure: 'rejected',
        httpStatus: res.status,
        message: scrubbedMessage(parsed, text, secrets) ?? '账号或密码不正确',
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        failure: 'http_error',
        httpStatus: res.status,
        message: scrubbedMessage(parsed, text, secrets) ?? `上游返回 HTTP ${res.status}`,
      };
    }

    const envelope = decodeEnvelope(parsed);
    if (!envelope.success) {
      return {
        ok: false,
        failure: 'rejected',
        httpStatus: res.status,
        message: scrubCredentials(envelope.message ?? '账号或密码不正确', secrets),
      };
    }

    const data = asRecord(envelope.data);
    const user = asRecord(data?.['user']);
    const session = readString(data, 'session') ?? readString(user, 'session');
    if (session === null) {
      return {
        ok: false,
        failure: 'rejected',
        httpStatus: res.status,
        message: '登录响应里没有 session —— 形状与驱动器预期不符（待实测）',
      };
    }

    return {
      ok: true,
      httpStatus: res.status,
      data: {
        session,
        tfUser: readString(data, 'TF-User') ?? readString(res.headers, 'TF-User') ?? readString(user, 'TF-User'),
        uid: readString(data, 'uid') ?? readString(data, 'id') ?? readString(user, 'uid'),
        username: readString(data, 'username') ?? readString(user, 'username'),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// §15.9 被动重登策略（离线可测，与驱动器分开 —— 策略不该埋在协议里）
// ---------------------------------------------------------------------------

export interface ReloginCall<T> {
  result: TierFlowResult<T>;
  /** 本轮是否真的重登过。用来写 `status` / 审计，不进 DTO。 */
  relogged: boolean;
  /** 重登成功后的新会话，调用方**须加密覆写** `encrypted_session` + 续 `session_expires_at`。 */
  renewed: { session: string; tfUser: string | null } | null;
}

/**
 * 「收到 401/403 → 用存档密码重登 **1 次** → 成功则重试本次请求 **1 次**」（§15.9 被动行）。
 *
 * 三条约束逐字来自契约，不要"顺手放宽"：
 *   - **每号一次**，再失败就到此为止（连续重登是供应商风控最容易抓的形状）；
 *   - `credentialSource="session"` 的账号**连一次注定 401 的请求都不发**，
 *     直接返回 `session_expired`（这正是 `credentialSource` 这个字段存在的理由）；
 *   - 重登成功**只重试一次**，不循环。
 */
export async function callWithRelogin<T>(
  client: TierFlowClient,
  account: AccountCredential,
  call: (credential: { session: string; tfUser: string | null }) => Promise<TierFlowResult<T>>,
): Promise<ReloginCall<T>> {
  if (account.session === null) {
    return {
      result: { ok: false, failure: 'session_expired', httpStatus: 0, message: '账号没有可用会话' },
      relogged: false,
      renewed: null,
    };
  }

  const first = await call({ session: account.session, tfUser: account.tfUser });
  if (first.ok || first.failure !== 'session_expired') {
    return { result: first, relogged: false, renewed: null };
  }

  if (account.password === null) {
    // 只有会话、没有密码：无从重登。**不发那次注定失败的请求。**
    return { result: first, relogged: false, renewed: null };
  }

  const login = await client.login(account.identifier, account.password);
  if (!login.ok) {
    return {
      result: {
        ok: false,
        failure: 'session_expired',
        httpStatus: first.httpStatus,
        message: `重登失败：${login.message}`,
      },
      relogged: true,
      renewed: null,
    };
  }

  const renewed = { session: login.data.session, tfUser: login.data.tfUser };
  const second = await call(renewed);
  // 重登已成功 ⇒ 新会话**有效**，即使重试又失败也要交给调用方覆写（否则下一次还是拿旧会话再撞一轮）。
  return { result: second, relogged: true, renewed };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function buildUrl(
  baseUrl: string,
  path: string,
  query: Record<string, string | number | undefined> | undefined,
): string {
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  if (query !== undefined) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

function scrubbedMessage(parsed: unknown, text: string, secrets: readonly (string | null | undefined)[]): string | null {
  const envelope = decodeEnvelope(parsed);
  const message = envelope.message ?? (text === '' ? null : text.slice(0, 200));
  return message === null ? null : scrubCredentials(message, secrets);
}

/**
 * 失败时带出去的上游原文。解出 JSON 就给整份，否则是截断后的文本，连响应都没有时 `null`。
 *
 * 截断的额度与 `message` 相同（200 字符）—— 那是"够不够定位"与"会不会把一份 HTML 错误页
 * 整个搬进 result"之间的取舍。**未净化**，见 `TierFlowErr.raw`。
 */
function rawFor(parsed: unknown, text: string): unknown {
  if (parsed !== null) return parsed;
  return text === '' ? null : text.slice(0, 200);
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

function readQuotaPerUnit(data: Record<string, unknown> | null): number {
  const config = asRecord(data?.['config']);
  const raw = config?.['quota_per_unit'] ?? data?.['quota_per_unit'];
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_QUOTA_PER_UNIT;
}

function extractTokenRows(data: unknown): readonly UpstreamTokenRow[] {
  const record = asRecord(data);
  const list = Array.isArray(data)
    ? data
    : Array.isArray(record?.['items'])
      ? (record?.['items'] as unknown[])
      : Array.isArray(record?.['tokens'])
        ? (record?.['tokens'] as unknown[])
        : [];
  const rows: UpstreamTokenRow[] = [];
  for (const item of list) {
    const row = asRecord(item);
    if (row === null) continue;
    const rawMask = readString(row, 'key') ?? readString(row, 'masked_key') ?? '';
    const models = readString(row, 'model_limits');
    rows.push({
      name: readString(row, 'name') ?? '',
      mask: rawMask,
      tail: rawMask === '' ? null : maskTail(rawMask),
      unlimited: row['unlimited_quota'] === true,
      remainQuota: typeof row['remain_quota'] === 'number' ? row['remain_quota'] : null,
      models: models === null || models === '' ? null : models.split(',').map((m) => m.trim()).filter((m) => m !== ''),
      raw: item,
    });
  }
  return rows;
}
