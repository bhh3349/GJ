// cookie-only 会话导入的**身份解析**（v1.16.3）。
//
// ## 为什么需要它
//
// TokenRhythm 只有会话鉴权（§15.14.1），操作员手上常常**只有 cookie**，没有手机号 /
// 邮箱真值。而 `supplier_accounts.identifier` 是列表展示列（掩码），`identifier_hash`
// 需要真值才能算 —— 两条都指向"先知道这是谁"。
//
// 上游 `GET /api/me`（§15.14 驱动器已实测）在会话有效时返回：
//   `data.id`（UUID）、`data.name`、`data.phoneMasked`（`192****5609`）、`data.emailMasked`。
// 拿到的**已经是掩码**，所以身份解析不等于拿到真值：这里把掩码落库，真值从未出现。
//
// ## 边界（与 §15.9 的关系）
//
// - 这条通路**会打一次上游**（每枚会话一次 `GET /api/me`），这是它与
//   `identifier + session` 离线导入的**唯一**区别。v1.16.4 起会话值也可从管理面
//   `POST /api/supplier-accounts/import-sessions` 的粘贴文本进入（业主显式接受的
//   风险取舍，见 §15.9 纪律 1）；无论哪条入口，本模块都只打印掩码、不回显会话值。
// - 403 与 401 分开：401 才是会话失效；403 是上游拒绝（CSRF/WAF/权限），
//   绝不能把它报成"会话过期"（ADR-0040 实测钉子）。
// - 上游若回了未掩码的值，本地再掩一次；掩不出来就拒绝该行，绝不把真值落进展示列。

import { adminRootOf } from './tierflow.js';
import { decodeTrEnvelope } from './tokenrhythm.js';
import { maskIdentifier, normalizeIdentifier } from './identifiers.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export type ResolveIdentityFailure =
  | 'upstream_unreachable'
  | 'session_expired'
  | 'upstream_rejected'
  | 'envelope_invalid'
  | 'identity_unavailable';

export interface ResolvedIdentity {
  /** 上游用户 id（UUID）。cookie-only 判重的稳定键。 */
  uid: string;
  username: string | null;
  /** 上游返回并已确认是掩码形态的展示值。 */
  identifier: string;
}

export type ResolveIdentityResult =
  | { ok: true; identity: ResolvedIdentity }
  | { ok: false; reason: ResolveIdentityFailure; message: string };

export interface ResolveIdentityInput {
  baseUrl: string;
  /** 会话值本身（Cookie 的 value，不含 `tr_session=`）。 */
  session: string;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

/**
 * 把上游给的值收成**掩码**。已带 `*` 的（`phoneMasked` 的正常形态）原样收；
 * 未带的先按手机号/邮箱归一化再掩码。收不出掩码返回 `null` —— 调用方据此拒绝该行。
 */
function toMask(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value === '') return null;
  if (value.includes('*')) return value;
  const normalized = normalizeIdentifier(value);
  if (normalized === null) return null;
  return maskIdentifier(normalized);
}

/**
 * 用一枚会话向上游问"这是谁"。**不发写请求**，不读/写 `tr_csrf`。
 *
 * 失败一律返回 `ok:false`，不抛 —— 批量导入要把原因打成一行继续下一条。
 * 只有真正的编程/环境异常（例如 fetch 实现本身同步抛出）才会冒泡。
 */
export async function resolveTokenRhythmIdentity(
  input: ResolveIdentityInput,
): Promise<ResolveIdentityResult> {
  const session = input.session.trim();
  if (session === '') {
    return { ok: false, reason: 'session_expired', message: '会话值为空' };
  }

  // `upstreams.base_url` 存的是**网关根**（`https://host/v1`），而 `/api/me` 在站点根上。
  // 驱动器里用 `adminRootOf` 做同一次换算；这里若直接拼 baseUrl 会打成
  // `https://host/v1/api/me` —— 上游对这个路径只会回 404，整批会话就被误判成身份不可用。
  const baseUrl = adminRootOf(input.baseUrl);
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/me`, {
      method: 'GET',
      headers: {
        Cookie: `tr_session=${session}`,
        Accept: 'application/json',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0',
      },
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    // 不回显 URL 之外的任何请求细节；会话值不在 message 里。
    return { ok: false, reason: 'upstream_unreachable', message: '连不上上游（网络错误或超时）' };
  }

  const text = await response.text().catch(() => '');
  let body: unknown = null;
  let parseFailed = false;
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      parseFailed = true;
    }
  }

  if (response.status === 401) {
    return { ok: false, reason: 'session_expired', message: '上游拒绝该会话（401，会话已失效）' };
  }
  if (response.status === 403) {
    return {
      ok: false,
      reason: 'upstream_rejected',
      message: '上游拒绝身份查询（403，不是会话过期；不要据此重新导入会话）',
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: 'upstream_rejected',
      message: `上游身份查询失败（HTTP ${response.status}）`,
    };
  }
  if (parseFailed) {
    return { ok: false, reason: 'envelope_invalid', message: '上游返回的不是 JSON，无法解析身份' };
  }

  const decoded = decodeTrEnvelope(body);
  if (!decoded.success) {
    const hint = decoded.message ?? '';
    // 信封的业务码是字符串（`"UNAUTHORIZED"`），而 message 可能是中文
    // （「未认证或登录已过期」）—— 两处都要看，不能只 grep message。
    const rawCode =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)['code']
        : undefined;
    const unauthorized =
      (typeof rawCode === 'string' && /unauthor/i.test(rawCode)) || /unauthor/i.test(hint);
    if (unauthorized) {
      return { ok: false, reason: 'session_expired', message: '上游判定会话失效（UNAUTHORIZED）' };
    }
    return {
      ok: false,
      reason: 'envelope_invalid',
      message: `上游信封不是成功码${hint === '' ? '' : `（${hint}）`}`,
    };
  }

  const data = decoded.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, reason: 'identity_unavailable', message: '上游没有返回身份对象' };
  }
  const record = data as Record<string, unknown>;
  const uid = typeof record['id'] === 'string' ? record['id'].trim() : '';
  if (uid === '') {
    return { ok: false, reason: 'identity_unavailable', message: '上游身份对象缺少 id，无法判重' };
  }

  const identifier = toMask(record['phoneMasked']) ?? toMask(record['emailMasked']);
  if (identifier === null) {
    return {
      ok: false,
      reason: 'identity_unavailable',
      message: '上游没有返回可展示的掩码（phoneMasked / emailMasked），拒绝写入',
    };
  }

  const username =
    typeof record['name'] === 'string' && record['name'].trim() !== '' ? record['name'].trim() : null;

  return { ok: true, identity: { uid, username, identifier } };
}
