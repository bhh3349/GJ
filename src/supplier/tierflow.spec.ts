// TierFlow 管理面驱动器的离线用例（契约 §15 / §16.1）。
//
// **一个网络请求都不发**：`fetchImpl` 是注入的假 fetch。这是本文件存在的意义 ——
// 六个端点卡在凭据上，而协议与玩法不卡凭据。真机验证由凭据持有者跑（§16.1.1），
// 这里管的是"凭据到手那天，代码已经是对的"。

import { describe, expect, it } from 'vitest';
import {
  adminRootOf,
  DEFAULT_QUOTA_PER_UNIT,
  callWithRelogin,
  centsToQuota,
  createTierFlowClient,
  decodeEnvelope,
  maskFromUpstream,
  maskTail,
  quotaToCents,
  resolveBalanceCents,
  scrubCredentials,
  type AccountCredential,
} from './tierflow.js';

interface Call {
  url: string;
  init: RequestInit;
}

/** 假 fetch：记下每次调用，把响应交给 `handler` 决定。 */
function fakeFetch(
  handler: (call: Call) => Response | Promise<Response>,
): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const CRED = { session: 'sess-abc', tfUser: '42' };

function client(fetchImpl: typeof fetch) {
  return createTierFlowClient({ baseUrl: 'https://tierflow.cn/', fetchImpl });
}

describe('信封解码（文档 §1.2：200 + success:false 才是业务错误）', () => {
  it('success 缺失按成功处理 —— /api/status 一类只读端点未必带这个字段', () => {
    expect(decodeEnvelope({ data: { ok: 1 } })).toEqual({
      success: true,
      message: null,
      data: { ok: 1 },
    });
  });

  it('false / 0 / "false" 都算失败 —— 代价不对称，判据取宽', () => {
    for (const value of [false, 0, 'false']) {
      expect(decodeEnvelope({ success: value, message: '余额不足' }).success).toBe(false);
    }
  });

  it('data 缺席时把整个信封交出去（平铺响应）', () => {
    expect(decodeEnvelope({ quota: 500000 }).data).toEqual({ quota: 500000 });
  });
});

describe('金额换算（§15.6：1 元 = 500000 quota）', () => {
  it('quota ↔ 分 往返不漂', () => {
    expect(centsToQuota(100)).toBe(DEFAULT_QUOTA_PER_UNIT);
    expect(quotaToCents(DEFAULT_QUOTA_PER_UNIT)).toBe(100);
    expect(quotaToCents(centsToQuota(54253))).toBe(54253);
  });

  it('quota 不是个数时返回 null —— 不可信就不猜', () => {
    expect(quotaToCents('500000')).toBeNull();
    expect(quotaToCents(null)).toBeNull();
    expect(quotaToCents(Number.NaN)).toBeNull();
  });

  it('无限额度必须落 null，绝不落上游那个占位负数（§15.7）', () => {
    // 上游实测样例：{unlimited_quota: true, remain_quota: -331119}
    expect(resolveBalanceCents({ unlimitedQuota: true, remainQuota: -331119 })).toEqual({
      unlimited: true,
      balanceCents: null,
    });
  });

  it('固定额度照实测：quota 真换算成分', () => {
    expect(resolveBalanceCents({ unlimitedQuota: false, remainQuota: 250000 })).toEqual({
      unlimited: false,
      balanceCents: 50,
    });
  });
});

describe('上游掩码（§15.2 keys/sync：只按后 4 位）', () => {
  it('剥掉 sk- 前缀再取后 4 —— 不剥就永远匹配不上', () => {
    expect(maskTail('sk-k58R**********vFnt')).toBe('vFnt');
    expect(maskTail('NcBZ**********WnWw')).toBe('WnWw');
  });

  it('转成池内形态，与 maskKey() 同形（**** + 后 4 位）', () => {
    expect(maskFromUpstream('sk-k58R**********vFnt')).toBe('****vFnt');
  });

  it('长度不足以取后 4 时返回 null —— 宁可少对一次账，也不要把余额写到别的 key 上', () => {
    expect(maskTail('sk-abc')).toBeNull();
    expect(maskFromUpstream('sk-')).toBeNull();
  });
});

describe('凭据擦除', () => {
  it('把所有出现处替换掉，且不动其它文本', () => {
    const out = scrubCredentials('invalid session sess-abc for user 42', ['sess-abc', '42', '']);
    expect(out).not.toContain('sess-abc');
    expect(out).toContain('****');
  });

  it('空串不做替换 —— 否则整段文本会被 **** 填满', () => {
    expect(scrubCredentials('abc', ['', null, undefined])).toBe('abc');
  });
});

describe('登录', () => {
  it('成功时取到 session 与 TF-User（值可能来自响应头）', async () => {
    const { impl, calls } = fakeFetch(() =>
      json({ success: true, data: { session: 'sess-new', uid: '9' } }, 200),
    );
    const res = await client(impl).login('16200004225', 'pw-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.session).toBe('sess-new');
    expect(res.data.uid).toBe('9');
    expect(calls[0]?.url).toBe('https://tierflow.cn/api/user/login');
    // 尾斜杠被抹掉：`https://tierflow.cn//api/...` 在某些网关上是另一条路径。
    expect(calls[0]?.url).not.toContain('cn//');
  });

  it('登录请求体字段是 identifier（契约 §15.9）—— 发 username 上游回「empty」（2026-10-12 实测钉死）', async () => {
    const { impl, calls } = fakeFetch(() =>
      json({ success: true, data: { session: 'sess-new', uid: '9' } }, 200),
    );
    await client(impl).login('16200004225', 'pw-1');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['identifier']).toBe('16200004225');
    expect(body['password']).toBe('pw-1');
    expect(body).not.toHaveProperty('username');
  });

  it('session 只从 Set-Cookie 回时照样取到（实测口径：登录成功的 body 里没有 session 字段）', async () => {
    const { impl } = fakeFetch(() =>
      new Response(JSON.stringify({ success: true, message: '', data: { uid: '9', username: 'u9' } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=sess-from-cookie; Path=/; HttpOnly',
        },
      }),
    );
    const res = await client(impl).login('16200004225', 'pw-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.session).toBe('sess-from-cookie');
    // body 没给 TF-User 时回退 uid：缺它带会话的后续请求必 401（§15.9）。
    expect(res.data.tfUser).toBe('9');
  });

  it('401 是登录失败，不是"会话失效" —— 失败路径不留半边会话', async () => {
    const { impl } = fakeFetch(() => json({ success: false, message: '密码错误' }, 401));
    const res = await client(impl).login('16200004225', 'pw-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('rejected');
  });

  it('上游把密码回显在报错里时不外露', async () => {
    const { impl } = fakeFetch(() => json({ success: false, message: 'bad pw pw-secret' }, 200));
    const res = await client(impl).login('16200004225', 'pw-secret');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).not.toContain('pw-secret');
  });

  it('响应里没有 session 时明确报形状不符，而不是给一个空会话', async () => {
    const { impl } = fakeFetch(() => json({ success: true, data: { uid: '9' } }, 200));
    const res = await client(impl).login('16200004225', 'pw-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('session');
  });
});

describe('请求分类', () => {
  it('带会话的请求同时有 Cookie: session= 与 TF-User 头（实测口径：缺 TF-User 上游 401）', async () => {
    const { impl, calls } = fakeFetch(() => json({ success: true, data: { quota: 500000 } }));
    await client(impl).self(CRED);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['cookie']).toBe('session=sess-abc');
    expect(headers['TF-User']).toBe('42');
  });

  it('401 归 session_expired —— §15.9 被动重登的唯一触发条件', async () => {
    const { impl } = fakeFetch(() => json({ message: 'expired' }, 401));
    const res = await client(impl).self(CRED);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('session_expired');
  });

  it('403 同样归 session_expired（契约把 401/403 写在一起）', async () => {
    const { impl } = fakeFetch(() => json({ message: 'nope' }, 403));
    const res = await client(impl).self(CRED);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('session_expired');
  });

  it('200 + success:false 归 rejected，并把上游那句话带出来', async () => {
    const { impl } = fakeFetch(() => json({ success: false, message: '套餐已过期' }, 200));
    const res = await client(impl).self(CRED);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('rejected');
    expect(res.message).toContain('套餐已过期');
  });

  it('连接被拒归 unreachable', async () => {
    const { impl } = fakeFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const res = await client(impl).self(CRED);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('unreachable');
  });

  it('超时归 timeout，且与 unreachable 分开 —— 操作员要能一眼看出"是慢还是不通"', async () => {
    const { impl } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          call.init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const res = await createTierFlowClient({
      baseUrl: 'https://tierflow.cn',
      fetchImpl: impl,
      timeoutMs: 5,
    }).self(CRED);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('timeout');
  });
});

describe('账号自身与套餐', () => {
  it('余额按 quota 换算，无限额度落 null', async () => {
    const { impl } = fakeFetch(() => json({ success: true, data: { quota: 250000, uid: 9 } }));
    const res = await client(impl).self(CRED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.balanceCents).toBe(50);
    expect(res.data.unlimited).toBe(false);
  });

  it('quota_per_unit 从响应里读（默认值只是兜底，不是事实源）', async () => {
    const { impl } = fakeFetch(() =>
      json({ success: true, data: { quota: 100000, config: { quota_per_unit: 100000 } } }),
    );
    const res = await client(impl).self(CRED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.balanceCents).toBe(100);
  });

  it('套餐列表恒为数组 —— 上游给了单数对象或没给都落 []，不编一个', async () => {
    const missing = fakeFetch(() => json({ success: true, data: {} }));
    expect((await client(missing.impl).subscriptions(CRED)).ok).toBe(true);
    const single = fakeFetch(() => json({ success: true, data: { all_subscriptions: { sub_no: 'SB1' } } }));
    const res = await client(single.impl).subscriptions(CRED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toEqual([]);
  });

  it('all_subscriptions 原样带出（归一化在写入侧，不在读侧猜格式）', async () => {
    const { impl } = fakeFetch(() =>
      json({ success: true, data: { all_subscriptions: [{ sub_no: 'SB1', end_at: '2026-11-01T00:00:00Z' }] } }),
    );
    const res = await client(impl).subscriptions(CRED);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toHaveLength(1);
  });
});

describe('key 对账与创建', () => {
  it('keyword 留空拉全量，再本地按名过滤（§15.5：供应商搜索不可靠）', async () => {
    const { impl, calls } = fakeFetch(() =>
      json({
        success: true,
        data: {
          items: [
            { name: 'tierflow-4225-1', key: 'sk-k58R**********vFnt' },
            { name: 'tierflow-4225-2', key: 'sk-aaaa**********WnWw' },
          ],
        },
      }),
    );
    const res = await client(impl).tokens(CRED, 'tierflow-4225-2');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls[0]?.url).toBe('https://tierflow.cn/api/token/search?keyword=&p=1&size=100');
    expect(res.data.map((r) => r.name)).toEqual(['tierflow-4225-2']);
    expect(res.data[0]?.tail).toBe('WnWw');
  });

  it('无限额度建 key：不发 model_limits（空 CSV 的语义还没实测，就根本不发这个字段）', async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.init.method === 'POST') return json({ success: true, data: { key: 'sk-new-key-9f3c', token_no: '77' } });
      return json({ success: true, data: { items: [] } });
    });
    const res = await client(impl).createToken(CRED, {
      name: 'tierflow-4225-1',
      unlimited: true,
      quotaCents: null,
      models: [],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['unlimited_quota']).toBe(true);
    expect(body).not.toHaveProperty('model_limits');
    expect(body).not.toHaveProperty('model_limits_enabled');
    expect(res.data.plaintext).toBe('sk-new-key-9f3c');
    expect(res.data.maskedKey).toBe('****9f3c');
  });

  it('固定额度建 key：分换算成 quota，前端不乘 500000', async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.init.method === 'POST'
        ? json({ success: true, data: { key: 'sk-x1y2', token_no: '78' } })
        : json({ success: true, data: { items: [] } }),
    );
    await client(impl).createToken(CRED, {
      name: 'n',
      unlimited: false,
      quotaCents: 100,
      models: null,
    });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['unlimited_quota']).toBe(false);
    expect(body['remain_quota']).toBe(DEFAULT_QUOTA_PER_UNIT);
  });

  it('固定额度建 key：站点自己的换算比说了算（审计项 D，写死 500000 会成比例算错）', async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.init.method === 'POST'
        ? json({ success: true, data: { key: 'sk-x1y2', token_no: '78' } })
        : json({ success: true, data: { items: [] } }),
    );
    // 站点把比值改成 250000/元。要建 1000 分（10 元）的 key：
    // 按站点比例 → 2500000；按写死的 500000 → 5000000（= 20 元，凭空多一倍）。
    const res = await client(impl).createToken(CRED, {
      name: 'n',
      unlimited: false,
      quotaCents: 1000,
      models: null,
      quotaPerUnit: 250_000,
    });
    expect(res.ok).toBe(true);
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['unlimited_quota']).toBe(false);
    expect(body['remain_quota']).toBe(2_500_000);
    // 比值只影响 remain_quota 一处：`unlimited_quota` 与其它字段不该跟着变。
    expect(body).not.toHaveProperty('quota_per_unit');
  });

  it('比值缺省 ⇒ 落回文档默认值（老库没读到过比值的账号走这条路）', async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.init.method === 'POST'
        ? json({ success: true, data: { key: 'sk-x1y2', token_no: '78' } })
        : json({ success: true, data: { items: [] } }),
    );
    await client(impl).createToken(CRED, { name: 'n', unlimited: false, quotaCents: 100, models: null });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['remain_quota']).toBe(DEFAULT_QUOTA_PER_UNIT);
  });

  it('无限额度时比值**不参与**：body 里没有 remain_quota 可错', async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.init.method === 'POST'
        ? json({ success: true, data: { key: 'sk-x1y2', token_no: '78' } })
        : json({ success: true, data: { items: [] } }),
    );
    // 给一个错得离谱的比值：unlimited 分支根本不看它，所以发出去的 body 必须干净。
    await client(impl).createToken(CRED, {
      name: 'n',
      unlimited: true,
      quotaCents: null,
      models: null,
      quotaPerUnit: 1,
    });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['unlimited_quota']).toBe(true);
    expect(body).not.toHaveProperty('remain_quota');
  });

  it('白名单给了值才发 model_limits，逗号拼接', async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.init.method === 'POST'
        ? json({ success: true, data: { key: 'sk-x1y2', token_no: '79' } })
        : json({ success: true, data: { items: [] } }),
    );
    await client(impl).createToken(CRED, {
      name: 'n',
      unlimited: true,
      quotaCents: null,
      models: ['gpt-4o', 'claude-sonnet-5-5'],
    });
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['model_limits_enabled']).toBe(true);
    expect(body['model_limits']).toBe('gpt-4o,claude-sonnet-5-5');
  });

  it('创建响应不带 token_no 时回查一次（§15.5：建 key = 2 次请求）', async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.init.method === 'POST'
        ? json({ success: true, data: { key: 'sk-x1y2' } })
        : json({ success: true, data: { items: [{ name: 'n', key: 'sk-x1y2', token_no: '80' }] } }),
    );
    const res = await client(impl).createToken(CRED, {
      name: 'n',
      unlimited: true,
      quotaCents: null,
      models: null,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls).toHaveLength(2);
    expect(res.data.tokenNo).toBe('80');
  });

  it('删上游 key 无尾斜杠（带斜杠 307，§15.5 表内钉过）', async () => {
    const { impl, calls } = fakeFetch(() => json({ success: true, data: {} }));
    await client(impl).deleteToken(CRED, '77');
    expect(calls[0]?.url).toBe('https://tierflow.cn/api/token/77');
    expect(calls[0]?.init.method).toBe('DELETE');
  });
});

describe('§15.9 被动重登策略', () => {
  const account: AccountCredential = {
    identifier: '16200004225',
    password: 'pw-1',
    session: 'old-sess',
    tfUser: '42',
  };

  it('401 → 重登 1 次 → 重试 1 次 → 成功，并把新会话交给调用方覆写', async () => {
    let authorized = 0;
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/api/user/login')) {
        return json({ success: true, data: { session: 'new-sess' } });
      }
      authorized += 1;
      return authorized === 1 ? json({ message: 'expired' }, 401) : json({ success: true, data: { quota: 500000 } });
    });
    const res = await callWithRelogin(client(impl), account, (c) => client(impl).self(c));
    expect(res.result.ok).toBe(true);
    expect(res.relogged).toBe(true);
    expect(res.renewed?.session).toBe('new-sess');
    expect(calls.filter((c) => c.url.endsWith('/api/user/login'))).toHaveLength(1);
    expect(authorized).toBe(2);
  });

  it('只有会话、没有密码：连一次注定 401 的请求都不发', async () => {
    const { impl, calls } = fakeFetch(() => json({ message: 'expired' }, 401));
    const sessionOnly: AccountCredential = { ...account, password: null };
    const res = await callWithRelogin(client(impl), sessionOnly, (c) => client(impl).self(c));
    expect(res.result.ok).toBe(false);
    expect(res.relogged).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.url.endsWith('/api/user/login'))).toBe(false);
  });

  it('重登后仍失败就到此为止 —— 每号一次，不循环', async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.url.endsWith('/api/user/login')
        ? json({ success: true, data: { session: 'new-sess' } })
        : json({ message: 'expired' }, 401),
    );
    const res = await callWithRelogin(client(impl), account, (c) => client(impl).self(c));
    expect(res.result.ok).toBe(false);
    expect(res.relogged).toBe(true);
    expect(calls.filter((c) => c.url.endsWith('/api/user/login'))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith('/api/user/self'))).toHaveLength(2);
  });

  it('重登本身失败：返回会话失效，且不外露密码', async () => {
    const { impl } = fakeFetch((call) =>
      call.url.endsWith('/api/user/login')
        ? json({ success: false, message: 'bad pw-1' }, 200)
        : json({ message: 'expired' }, 401),
    );
    const res = await callWithRelogin(client(impl), account, (c) => client(impl).self(c));
    expect(res.result.ok).toBe(false);
    if (res.result.ok) return;
    expect(res.result.message).not.toContain('pw-1');
    expect(res.renewed).toBeNull();
  });

  it('非 401 的失败不触发重登 —— refresh 跑 27 个号时不该打 27 次登录接口', async () => {
    const { impl, calls } = fakeFetch(() => json({ success: false, message: '套餐过期' }, 200));
    const res = await callWithRelogin(client(impl), account, (c) => client(impl).self(c));
    expect(res.relogged).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('没有会话时不发请求', async () => {
    const { impl, calls } = fakeFetch(() => json({ success: true, data: {} }));
    const res = await callWithRelogin(
      client(impl),
      { ...account, session: null },
      (c) => client(impl).self(c),
    );
    expect(res.result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('管理面根（§16.1.1：baseUrl 是数据面口径，管理面六端点打站点根）', () => {
  it('adminRootOf：剥 /v1 后缀；不带 /v1 的根幂等；/v1/ 结尾（尾斜杠）也剥；/v11 不误伤', () => {
    expect(adminRootOf('https://tierflow.cn/v1')).toBe('https://tierflow.cn');
    expect(adminRootOf('https://tierflow.cn/v1/')).toBe('https://tierflow.cn');
    expect(adminRootOf('https://tierflow.cn/')).toBe('https://tierflow.cn');
    expect(adminRootOf('https://tierflow.cn/v11')).toBe('https://tierflow.cn/v11');
    expect(adminRootOf('https://tierflow.cn/x/v1')).toBe('https://tierflow.cn/x');
  });

  it('带 /v1 的 baseUrl：登录打站点根 —— 复现「Invalid URL (POST /v1/api/user/login)」的那一笔', async () => {
    // 在册上游的真实形状：数据面转发要 /v1（baseUrl + /chat/completions），管理面要站点根
    const { impl, calls } = fakeFetch(() => json({ success: true, data: { session: 's1' } }));
    const c = createTierFlowClient({ baseUrl: 'https://tierflow.cn/v1', fetchImpl: impl });
    await c.login('u', 'p');
    expect(c.adminRoot).toBe('https://tierflow.cn');
    expect(calls[0]?.url).toBe('https://tierflow.cn/api/user/login');
    expect(calls[0]?.url).not.toContain('/v1/');
  });

  it('带 /v1 的 baseUrl：具名操作与裸 request 同样打站点根，六端点一处在 constructor 收口', async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.url.includes('/api/token/search')
        ? json({ success: true, data: { items: [] } })
        : json({ success: true, data: { quota: 500000 } }),
    );
    const c = createTierFlowClient({ baseUrl: 'https://tierflow.cn/v1', fetchImpl: impl });
    await c.self(CRED);
    await c.tokens(CRED);
    await c.request({ method: 'GET', path: '/api/status' });
    expect(calls[0]?.url).toBe('https://tierflow.cn/api/user/self');
    expect(calls[1]?.url).toBe('https://tierflow.cn/api/token/search?keyword=&p=1&size=100');
    expect(calls[2]?.url).toBe('https://tierflow.cn/api/status');
    for (const call of calls) {
      expect(call.url.startsWith('https://tierflow.cn/api/')).toBe(true);
    }
  });

  it('不带 /v1 的 baseUrl：行为与既有用例逐字一致（回归锁）', async () => {
    const { impl, calls } = fakeFetch(() => json({ success: true, data: { session: 's1' } }));
    const c = createTierFlowClient({ baseUrl: 'https://tierflow.cn', fetchImpl: impl });
    await c.login('u', 'p');
    expect(c.adminRoot).toBe('https://tierflow.cn');
    expect(calls[0]?.url).toBe('https://tierflow.cn/api/user/login');
  });
});

describe('套餐专属 key 轮换（§15.13 / 手册 §5.3）', () => {
  it('打 /api/subscription/self/token/rotate，POST 体带 sub_no，带走 Cookie 与 TF-User', async () => {
    const { impl, calls } = fakeFetch(() =>
      json({ success: true, data: { key: 'sk-k58Rwxyz1234vFnt', masked: true } }),
    );
    const res = await client(impl).rotateSubscriptionToken(CRED, 'SB1261003742775');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls[0]?.url).toBe('https://tierflow.cn/api/subscription/self/token/rotate');
    expect(calls[0]?.init.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body['sub_no']).toBe('SB1261003742775');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['cookie']).toBe('session=sess-abc');
    expect(headers['TF-User']).toBe('42');
    expect(res.data.plaintext).toBe('sk-k58Rwxyz1234vFnt');
    expect(res.data.maskedKey).toBe('****vFnt');
    expect(res.data.subNo).toBe('SB1261003742775');
  });

  it('明文给在顶层 token 时也认（形状容错三种形状，钉死一种）', async () => {
    const { impl } = fakeFetch(() => json({ success: true, data: { token: 'sk-abcdefgh1234WXYZ' } }));
    const res = await client(impl).rotateSubscriptionToken(CRED, 'SB1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.plaintext).toBe('sk-abcdefgh1234WXYZ');
    expect(res.data.maskedKey).toBe('****WXYZ');
  });

  it('ok 但响应里没有 key → rejected（绝不给上层一个"成功却没有明文"）', async () => {
    const { impl } = fakeFetch(() => json({ success: true, data: { ok: true } }));
    const res = await client(impl).rotateSubscriptionToken(CRED, 'SB1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('rejected');
    expect(res.message).toContain('key');
  });

  it('上游把本次会话回显在报错里时不外露（擦除对象含 session）', async () => {
    const { impl } = fakeFetch(() => json({ success: false, message: 'invalid session sess-abc' }, 200));
    const res = await client(impl).rotateSubscriptionToken(CRED, 'SB1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).not.toContain('sess-abc');
  });

  it('401 归 session_expired —— 走全线同一条被动重登触发条件', async () => {
    const { impl } = fakeFetch(() => json({ message: 'expired' }, 401));
    const res = await client(impl).rotateSubscriptionToken(CRED, 'SB1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('session_expired');
  });
});
