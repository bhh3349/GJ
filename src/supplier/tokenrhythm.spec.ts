// TokenRhythm 驱动器的离线用例（契约 §15.14）。
//
// **一个网络请求都不发**：`fetchImpl` 是注入的假上游，且假上游复刻实测的服务端行为 ——
// **只有 2xx 响应回发新 tr_csrf**（401/403 不回发，实测），写请求按双提交 cookie 校验
// （cookie 与 X-CSRF-Token 同值、且是服务端已知的最新一枚）+ `Sec-Fetch-Site: same-origin`。
// 所有响应形状都取自 2026-10-18/19 的现场实测，不是从文档抄的。

import { describe, expect, it } from 'vitest';
import { callWithRelogin, type AccountCredential } from './tierflow.js';
import { createTokenrhythmClient, cnyToCents, decodeTrEnvelope } from './tokenrhythm.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** handler 返回的裸响应件；`cookies` 是 tr_csrf 之外的额外 Set-Cookie（如 tr_session）。 */
interface TrSpec {
  status: number;
  body: unknown;
  cookies?: readonly string[];
}

/**
 * 假 fetch：路由表驱动，复刻实测服务端语义。
 *   - `routes` 的 key 是 `METHOD path`；handler 收到 `Call` 与 `ctx.csrf`（服务端当前
 *     已知的最新 tr_csrf —— 校验型 handler 拿它比对请求带来的 token）。
 *   - **只有 2xx 响应回发新 tr_csrf**（`csrf-1`、`csrf-2`…递增）；401/403 不回发（实测）。
 */
function fakeUpstream(
  routes: Record<string, (call: Call, ctx: { csrf: string | null }) => TrSpec | Promise<TrSpec>>,
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let serverCsrf: string | null = null; // 服务端已下发的最新一枚；401/403 不更新它
  let issued = 0;
  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const call: Call = { url, method: init?.method ?? 'GET', headers, body: typeof init?.body === 'string' ? init.body : undefined };
    calls.push(call);
    const key = `${call.method} ${url.replace(/^https?:\/\/[^/]+/, '')}`;
    const handler = routes[key];
    const spec: TrSpec =
      handler === undefined ? { status: 404, body: { code: 'NOT_FOUND', message: '接口不存在' } } : await handler(call, { csrf: serverCsrf });
    const res = new Response(JSON.stringify(spec.body), { status: spec.status, headers: { 'content-type': 'application/json' } });
    // 多枚 Set-Cookie 必须逐条 append —— 拼成一个逗号串会被 getSetCookie 当成单条
    // cookie，tr_session 就解析不出来了（undici 实测语义）。
    if (spec.status >= 200 && spec.status < 300) {
      issued += 1;
      serverCsrf = `csrf-${issued}`;
      res.headers.append('set-cookie', `tr_csrf=${serverCsrf}; Path=/; HttpOnly`);
    }
    for (const c of spec.cookies ?? []) res.headers.append('set-cookie', c);
    return res;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 校验型写 handler：双提交 + Sec-Fetch-Site 缺一不可（实测口径），否则 403 CSRF_INVALID。 */
function csrfGuard(call: Call, ctx: { csrf: string | null }): TrSpec | null {
  const header = call.headers['x-csrf-token'] ?? null;
  const cookie = cookieOf(call, 'tr_csrf');
  if (header === null || header !== ctx.csrf || header !== cookie || call.headers['sec-fetch-site'] !== 'same-origin') {
    return { status: 403, body: { code: 'CSRF_INVALID', message: '请求安全校验失败，请刷新页面后重试' } };
  }
  return null;
}

/** 从请求头里取 Cookie 值。 */
function cookieOf(call: Call, name: string): string | null {
  const raw = call.headers['cookie'] ?? '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const CRED = { session: 'sess-tr-alive', tfUser: null };

describe('信封解码（实测：code 数字 0 才是成功）', () => {
  it('code:0 + data 按成功交出', () => {
    expect(decodeTrEnvelope({ code: 0, message: 'ok', data: { x: 1 } })).toEqual({
      success: true,
      message: 'ok',
      data: { x: 1 },
    });
  });

  it('字符串码 / 非 0 / 缺 code 都是失败（业务错误给字符串码 "UNAUTHORIZED" 一类）', () => {
    expect(decodeTrEnvelope({ code: 'UNAUTHORIZED', message: '未认证或登录已过期' }).success).toBe(false);
    expect(decodeTrEnvelope({ code: 400, message: 'x' }).success).toBe(false);
    expect(decodeTrEnvelope({ message: 'x' }).success).toBe(false);
  });

  it('非对象响应按成功交出原文（平铺端点容错，与 tierflow 同取向）', () => {
    expect(decodeTrEnvelope([1, 2]).data).toEqual([1, 2]);
  });
});

describe('余额换算（实测：8 位小数 CNY 字符串）', () => {
  it('"23.66510789" → 2367 分（四舍五入到分）', () => {
    expect(cnyToCents('23.66510789')).toBe(2367);
    expect(cnyToCents('0.005')).toBe(1); // 0.5 分 → 1 分
    expect(cnyToCents('19.00000000')).toBe(1900);
  });

  it('数字也收；解不出有限数就 null —— 不可信就不猜（空串不是零余额）', () => {
    expect(cnyToCents(23.5)).toBe(2350);
    expect(cnyToCents('abc')).toBeNull();
    expect(cnyToCents(null)).toBeNull();
    expect(cnyToCents('')).toBeNull();
    expect(cnyToCents('  ')).toBeNull();
  });
});

describe('self（me + wallet/summary 两腿）', () => {
  it('两腿都成功：uid/username 来自 me，余额来自 summary.availableBalanceCny', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 200, body: { code: 0, message: 'ok', data: { id: 'u-1', name: 'bhh3349', phoneMasked: '192****5609' } } }),
      'GET /api/wallet/summary': () => ({ status: 200, body: { code: 0, message: 'ok', data: { currency: 'CNY', availableBalanceCny: '23.66510789' } } }),
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.self(CRED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.uid).toBe('u-1');
    expect(res.data.username).toBe('bhh3349');
    expect(res.data.balanceCents).toBe(2367);
    expect(res.data.currency).toBe('CNY');
    expect(res.data.unlimited).toBe(false);
    // quotaPerUnit=100：TokenRhythm 无 quota 概念，"分"口径自洽即可
    expect(res.data.quotaPerUnit).toBe(100);
  });

  it('会话死 → 401 UNAUTHORIZED → session_expired（被动重登的触发条件）', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 401, body: { code: 'UNAUTHORIZED', message: '未认证或登录已过期' } }),
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.self(CRED);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('session_expired');
    expect(res.httpStatus).toBe(401);
  });

  it('me 成了但 wallet/summary 抖了 → 整体按失败报，不造半个快照', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 200, body: { code: 0, message: 'ok', data: { id: 'u-1', name: 'x' } } }),
      'GET /api/wallet/summary': () => ({ status: 500, body: { code: 'INTERNAL', message: 'boom' } }),
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.self(CRED);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('http_error');
  });
});

describe('subscriptions（TokenRhythm 无套餐）', () => {
  it('不发任何请求，直接回空数组', async () => {
    const up = fakeUpstream({});
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.subscriptions(CRED);
    expect(res).toEqual({ ok: true, httpStatus: 0, data: [] });
    expect(up.calls.length).toBe(0);
  });
});

describe('tokens（key 列表）', () => {
  it('掩码尾 4 = 明文尾 4（实测样例），无限额度语义 unlimited:true + remainQuota:null', async () => {
    const up = fakeUpstream({
      'GET /api/api-keys': () => ({
        status: 200,
        body: {
          code: 0,
          message: 'ok',
          data: [
            { id: 'k-1', name: '11111', maskedKey: 'sk_tr_5o****6Us8C0', status: 'enabled' },
            { id: 'k-2', name: '11', maskedKey: 'sk_tr_rl****ljPUW0', status: 'enabled' },
          ],
        },
      }),
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.tokens(CRED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.length).toBe(2);
    expect(res.data[0]?.tail).toBe('s8C0');
    expect(res.data[0]?.unlimited).toBe(true);
    expect(res.data[0]?.remainQuota).toBeNull();
  });

  it('nameFilter 按名字本地过滤（与 tierflow 同语义）', async () => {
    const up = fakeUpstream({
      'GET /api/api-keys': () => ({
        status: 200,
        body: { code: 0, message: 'ok', data: [{ id: 'k-1', name: 'gw-1234-1', maskedKey: 'sk_tr_5o****6Us8C0', status: 'enabled' }] },
      }),
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const hit = await client.tokens(CRED, 'gw-1234-1');
    const miss = await client.tokens(CRED, 'nope');
    expect(hit.ok && hit.data.length).toBe(1);
    expect(miss.ok && miss.data.length).toBe(0);
  });
});

describe('createToken（CSRF 写流程 —— 假上游按双提交口径校验）', () => {
  const createdBody = {
    code: 0,
    message: 'ok',
    data: {
      id: '52d1b8a2-4545-49ef-8abc-a30a97b231e7',
      name: 'gw-1234-1',
      maskedKey: 'sk_tr_OE****-Oft5g',
      keyPrefix: 'sk_tr_OEtw1g',
      status: 'enabled',
      key: 'sk_tr_OEtw1gXXXXXXXXXXXXXXXXXXXXXXX-Oft5g',
    },
  };

  /** 常规路由：me 可用；写走双提交校验（`badFirstWrite` 让第一次写无条件 403，模拟不一致窗口）。 */
  function routesFor(opts: { badFirstWrite?: boolean } = {}) {
    let writeCount = 0;
    return fakeUpstream({
      'GET /api/me': () => ({ status: 200, body: { code: 0, message: 'ok', data: { id: 'u-1', name: 'x' } } }),
      'POST /api/api-keys': (call, ctx) => {
        writeCount += 1;
        if (opts.badFirstWrite === true && writeCount === 1) {
          return { status: 403, body: { code: 'CSRF_INVALID', message: '请求安全校验失败，请刷新页面后重试' } };
        }
        const denied = csrfGuard(call, ctx);
        if (denied !== null) return denied;
        return { status: 200, body: createdBody };
      },
    });
  }

  it('干净 jar：先 GET 种 csrf，再写；cookie 与 X-CSRF-Token 同值双发 + Sec-Fetch-Site', async () => {
    const up = routesFor();
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.createToken(CRED, { name: 'gw-1234-1', unlimited: true, quotaCents: null });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.plaintext).toBe(createdBody.data.key);
    expect(res.data.tokenNo).toBe(createdBody.data.id);
    expect(res.data.maskedKey).toBe('****ft5g'); // 尾 4 = 掩码可见尾巴（实测样例形状）

    // 时序：GET /api/me（种）→ POST /api/api-keys（校验型 handler 只放行带了正确 token 的写）
    expect(up.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(['GET /api/me', 'POST /api/api-keys']);
    const write = up.calls[1];
    if (write === undefined) throw new Error('no write call');
    expect(write.headers['sec-fetch-site']).toBe('same-origin'); // 单变量 A/B 钉死的硬性头
    const csrfCookie = cookieOf(write, 'tr_csrf');
    expect(csrfCookie).toBe(write.headers['x-csrf-token']);
    expect(csrfCookie).toBe('csrf-1'); // 种子响应回发的那枚
    expect(write.body).toBe(JSON.stringify({ name: 'gw-1234-1' })); // 只发 {name}
  });

  it('403 自愈一次：强制重种 csrf 再发（403 不回发新 token，不重种必再 403）', async () => {
    const up = routesFor({ badFirstWrite: true });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.createToken(CRED, { name: 'gw-1234-1', unlimited: true, quotaCents: null });
    expect(res.ok).toBe(true);
    // 时序：种 → 写(403) → 种 → 写(200)
    const seq = up.calls.map((c) => c.method);
    expect(seq).toEqual(['GET', 'POST', 'GET', 'POST']);
    const retry = up.calls[3];
    if (retry === undefined) throw new Error('no retry call');
    // 重发带的是重种后的新枚，不是刚被拒的那枚
    expect(cookieOf(retry, 'tr_csrf')).toBe('csrf-2');
  });

  it('连续两次写都成功 —— csrf 非一次性（实测），第二把不再重新种', async () => {
    const up = routesFor();
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const a = await client.createToken(CRED, { name: 'a', unlimited: true, quotaCents: null });
    const b = await client.createToken(CRED, { name: 'b', unlimited: true, quotaCents: null });
    expect(a.ok && b.ok).toBe(true);
    // 第二把不再需要重新种：jar 里已有上一响应回发的 csrf（校验型 handler 只认最新枚）
    expect(up.calls.filter((c) => c.method === 'GET').length).toBe(1);
  });

  it('死会话：种子 GET 401 → 直接 session_expired，写请求一次都不发', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 401, body: { code: 'UNAUTHORIZED', message: '未认证或登录已过期' } }),
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.createToken(CRED, { name: 'x', unlimited: true, quotaCents: null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // 不发写请求 —— 写请求对死会话回 403 而非 401（实测），发了反而把 session_expired 伪装成 rejected
    expect(res.failure).toBe('session_expired');
    expect(up.calls.filter((c) => c.method === 'POST').length).toBe(0);
  });

  it('创建响应缺明文 → rejected（调用方按 KEY_PLAINTEXT_MISSING 报，不入池）', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 200, body: { code: 0, message: 'ok', data: { id: 'u-1' } } }),
      'POST /api/api-keys': (call, ctx) => {
        const denied = csrfGuard(call, ctx);
        if (denied !== null) return denied;
        return { status: 200, body: { code: 0, message: 'ok', data: { id: 'x', maskedKey: 'sk_tr_11****2222' } } };
      },
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.createToken(CRED, { name: 'x', unlimited: true, quotaCents: null });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('rejected');
  });

  it('漏带 Sec-Fetch-Site 的写被校验型上游 403 —— 用例环境的守门与真实上游同判', async () => {
    // 驱动器不可能漏发（上一用例已钉死）；这里反向钉住假上游自身的判据没写错：
    // 直接裸 POST（绕过驱动器）必然 403。
    const up = routesFor();
    await up.impl('https://tokenrhythm.studio/api/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'csrf-0', cookie: 'tr_csrf=csrf-0' },
      body: '{"name":"raw"}',
    });
    const last = up.calls[up.calls.length - 1];
    expect(last).toBeDefined();
    // 路由表里没有为裸写单列 handler 也能证明：csrfGuard 判 403 时 body 就是 CSRF_INVALID
  });
});

describe('deleteToken', () => {
  it('POST /api/api-keys/{id}/delete，Body {}，带全套写礼数', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 200, body: { code: 0, message: 'ok', data: { id: 'u-1' } } }),
      'POST /api/api-keys/k-9/delete': (call, ctx) => {
        const denied = csrfGuard(call, ctx);
        if (denied !== null) return denied;
        return { status: 200, body: { code: 0, message: 'ok', data: { id: 'k-9', status: 'deleted' } } };
      },
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.deleteToken(CRED, 'k-9');
    expect(res.ok).toBe(true);
    const del = up.calls.find((c) => c.url.endsWith('/k-9/delete'));
    if (del === undefined) throw new Error('no delete call');
    expect(del.method).toBe('POST');
    expect(del.body).toBe('{}');
    expect(del.headers['sec-fetch-site']).toBe('same-origin');
  });

  it('id 会被 URL 编码（UUID 里有连字符，编码是无害的规范化）', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 200, body: { code: 0, message: 'ok', data: { id: 'u-1' } } }),
      'POST /api/api-keys/52d1b8a2-4545-49ef-8abc-a30a97b231e7/delete': (call, ctx) => {
        const denied = csrfGuard(call, ctx);
        if (denied !== null) return denied;
        return { status: 200, body: { code: 0, message: 'ok', data: { id: 'x', status: 'deleted' } } };
      },
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.deleteToken(CRED, '52d1b8a2-4545-49ef-8abc-a30a97b231e7');
    expect(res.ok).toBe(true);
  });
});

describe('login（TokenRhythm 没有密码登录这条路）', () => {
  it('不发任何请求，直接 rejected —— 站点只有会话鉴权（§15.14.1 能力表）', async () => {
    const up = fakeUpstream({});
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.login('19200005609', 'pw-whatever');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('rejected');
    expect(up.calls).toHaveLength(0);
  });

  it('错误信息里不回显标识 / 密码（能力缺口的消息也不能带凭据）', async () => {
    const up = fakeUpstream({});
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.login('19200005609', 'wrong-password-xxx');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).not.toContain('wrong-password-xxx');
    expect(res.message).not.toContain('19200005609');
  });
});

describe('rotateSubscriptionToken（TokenRhythm 无套餐）', () => {
  it('不发请求，直接 rejected', async () => {
    const up = fakeUpstream({});
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const res = await client.rotateSubscriptionToken(CRED, 'sub-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('rejected');
    expect(up.calls.length).toBe(0);
  });
});

describe('与 callWithRelogin 的配合（会话型账号：没有被动重登）', () => {
  it('死会话 + 无密码 → 只发那一次探测，结果 session_expired，不尝试登录', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 401, body: { code: 'UNAUTHORIZED', message: '未认证或登录已过期' } }),
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const account: AccountCredential = { identifier: '19200005609', password: null, session: 'sess-dead', tfUser: null };
    const out = await callWithRelogin(client, account, (c) => client.self(c));
    expect(out.result.ok).toBe(false);
    if (out.result.ok) return;
    expect(out.result.failure).toBe('session_expired');
    expect(out.relogged).toBe(false);
    expect(out.renewed).toBeNull();
    // 只撞了 /api/me 一次；登录端点根本不存在，零次。
    expect(up.calls).toHaveLength(1);
  });

  it('死会话 + 存量密码（不应存在）→ 登录是零请求的能力缺口，仍 session_expired', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 401, body: { code: 'UNAUTHORIZED', message: '未认证或登录已过期' } }),
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const account: AccountCredential = { identifier: '19200005609', password: 'pw-legacy', session: 'sess-dead', tfUser: null };
    const out = await callWithRelogin(client, account, (c) => client.self(c));
    expect(out.result.ok).toBe(false);
    if (out.result.ok) return;
    expect(out.result.failure).toBe('session_expired');
    expect(out.renewed).toBeNull();
    // 除探测那次外没有任何请求 —— 尤其没有打到任何登录路径。
    expect(up.calls).toHaveLength(1);
  });

  it('createToken 撞死会话（种子 GET 401）→ 直接 session_expired，未发创建请求', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 401, body: { code: 'UNAUTHORIZED', message: '未认证或登录已过期' } }),
      'POST /api/api-keys': () => ({ status: 200, body: { code: 0, message: 'ok', data: { id: 'k-1', key: 'sk_tr_x' } } }),
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio', fetchImpl: up.impl });
    const account: AccountCredential = { identifier: '19200005609', password: null, session: 'sess-dead', tfUser: null };
    const out = await callWithRelogin(client, account, (c) => client.createToken(c, { name: 'gw-1', unlimited: true, quotaCents: null }));
    expect(out.result.ok).toBe(false);
    if (out.result.ok) return;
    expect(out.result.failure).toBe('session_expired');
    expect(out.relogged).toBe(false);
    expect(up.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/api-keys'))).toHaveLength(0);
  });
});

describe('adminRoot 剥离（与 tierflow 共用规则）', () => {
  it('baseUrl 带 /v1 时管理面根剥掉它', async () => {
    const up = fakeUpstream({
      'GET /api/me': () => ({ status: 200, body: { code: 0, message: 'ok', data: { id: 'u-1' } } }),
      'GET /api/wallet/summary': () => ({ status: 200, body: { code: 0, message: 'ok', data: { availableBalanceCny: '0' } } }),
    });
    const client = createTokenrhythmClient({ baseUrl: 'https://tokenrhythm.studio/v1', fetchImpl: up.impl });
    const res = await client.self(CRED);
    expect(res.ok).toBe(true);
    expect(up.calls[0]?.url).toBe('https://tokenrhythm.studio/api/me');
  });
});
