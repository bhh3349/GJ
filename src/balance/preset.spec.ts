// 内置余额 preset 与"上游原文净化"的口径测试（契约 §2 / ADR-0012 §1–§3）。
//
// 这里测的**不是**"余额能不能取到"，而是四条一旦破了就会静默出错的口径：
//   1. 认不出的 host 一律不猜 —— 只有 host 精确命中注册表才走 preset，
//      自建的 new-api / one-api 必须落到 skipped + 引导（它们域名不可判、quota 单位可改）；
//   2. OpenAI 的余额 = subscription − usage，**两半缺一不可**：只拿 hard_limit_usd
//      当余额会给出一个偏大的假值（已用越多偏得越离谱），所以宁可报失败；
//   3. "响应不是合法 JSON"归 PARSE_FAILED（改配置），不是 UPSTREAM_UNREACHABLE
//      （稍后重试）—— 归错档会让用户对着一个没坏的网络查半天；
//   4. 回给管理面的 raw 必须先抹掉明文 key 再截断，且截断后仍是**合法可读的 JSON**。

import { describe, expect, it } from 'vitest';
import { findPresetByBaseUrl, presetById, presetEndpoint, type BalancePresetSpec } from './preset.js';
import { MAX_RAW_CHARS, sanitizeUpstreamBody } from './raw.js';

/** 运行时拼装的假上游 key：源码里不存在该字面量，否则 check:secrets 会命中自己的测试。 */
const SECRET = ['sk', 'presetprobe', '0123456789abcdef0123456789abcdef'].join('-');

const SUBSCRIPTION = '/v1/dashboard/billing/subscription';
const USAGE = '/v1/dashboard/billing/usage';

type Route = { status?: number; body: unknown };

/** 按 URL 子串分派的假上游。未声明的路径直接抛 —— 静默返回 {} 会掩盖真实缺陷。 */
function fakeFetch(routes: readonly (readonly [string, Route])[]): typeof fetch {
  return (async (input: unknown) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as { url: string }).url);
    const hit = routes.find(([frag]) => url.includes(frag));
    if (!hit) throw new Error(`未声明的请求：${url}`);
    const status = hit[1].status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async (): Promise<string> =>
        typeof hit[1].body === 'string' ? hit[1].body : JSON.stringify(hit[1].body),
    };
  }) as unknown as typeof fetch;
}

function openai(): BalancePresetSpec {
  const p = presetById('openai');
  if (p === null) throw new Error('注册表里没有 openai preset');
  return p;
}

function run(baseUrl: string, fetchImpl: typeof fetch): ReturnType<BalancePresetSpec['run']> {
  return openai().run({ baseUrl, secret: SECRET, timeoutMs: 5000, fetchImpl });
}

describe('preset 注册表：认不出就不猜', () => {
  it('只有 host 精确命中才返回 preset，且大小写不敏感', () => {
    expect(findPresetByBaseUrl('https://api.openai.com/v1')?.id).toBe('openai');
    expect(findPresetByBaseUrl('https://API.OPENAI.COM')?.id).toBe('openai');
  });

  it('自建上游（new-api / one-api 形态）域名判不出来，一律 null', () => {
    // 这四条正是 ADR-0012 否掉"给 new-api / one-api 内置默认模板"的理由：
    // 自建域名任意（前两条），或只是 host 里碰巧含 api.openai.com 的字眼（后两条）。
    expect(findPresetByBaseUrl('https://api.example.com')).toBeNull();
    expect(findPresetByBaseUrl('https://newapi.mycompany.cn')).toBeNull();
    expect(findPresetByBaseUrl('https://api.openai.com.evil.example')).toBeNull();
    expect(findPresetByBaseUrl('https://proxy.example.com/api.openai.com')).toBeNull();
  });

  it('非法 baseUrl 不抛异常，返回 null', () => {
    expect(findPresetByBaseUrl('不是地址')).toBeNull();
    expect(findPresetByBaseUrl('')).toBeNull();
  });

  it('诊断端点标签剥掉 query 与凭据，只留 协议//host/path', () => {
    expect(presetEndpoint('https://api.openai.com/v1?token=abc', openai())).toBe(
      `https://api.openai.com${SUBSCRIPTION}`,
    );
    expect(presetEndpoint('非 URL', openai())).toBe('(无效 URL)');
  });
});

describe('OpenAI preset：subscription − usage', () => {
  it('余额 = (hard_limit_usd − total_usage / 100) 换算成分', async () => {
    const res = await run(
      'https://api.openai.com/v1',
      fakeFetch([
        [SUBSCRIPTION, { body: { hard_limit_usd: 100, soft_limit_usd: 90 } }],
        // total_usage 的单位是**美分**，2500 美分 = 25 美元
        [USAGE, { body: { total_usage: 2500 } }],
      ]),
    );
    expect(res.ok).toBe(true);
    expect(res.errorCode).toBeNull();
    expect(res.parsed?.balanceCents).toBe(7500); // (100 − 25) 美元 × 100
    expect(res.parsed?.currency).toBe('USD');
    // raw 带上**两个**响应：用户判断"是没额度还是接口变了"要靠它们
    expect(res.raw).toEqual({
      subscription: { hard_limit_usd: 100, soft_limit_usd: 90 },
      usage: { total_usage: 2500 },
    });
  });

  it('用量接口失败时**不拿总额度当余额**，而是报失败', async () => {
    const res = await run(
      'https://api.openai.com/v1',
      fakeFetch([
        [SUBSCRIPTION, { body: { hard_limit_usd: 100 } }],
        [USAGE, { status: 500, body: { error: 'boom' } }],
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.parsed).toBeNull();
    expect(res.errorCode).toBe('UPSTREAM_UNREACHABLE');
    expect(res.httpStatus).toBe(500);
  });

  it('订阅接口没给 hard_limit_usd → PARSE_FAILED（不是"余额 0"）', async () => {
    const res = await run(
      'https://api.openai.com/v1',
      fakeFetch([
        [SUBSCRIPTION, { body: { soft_limit_usd: 90 } }],
        [USAGE, { body: { total_usage: 100 } }],
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('PARSE_FAILED');
    expect(res.parsed).toBeNull();
  });

  it('响应不是合法 JSON → PARSE_FAILED（不是"上游不可达"）', async () => {
    const res = await run(
      'https://api.openai.com/v1',
      fakeFetch([[SUBSCRIPTION, { status: 200, body: '<html>拦截页</html>' }]]),
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('PARSE_FAILED');
    expect(res.httpStatus).toBe(200);
  });

  it('401 原样带出状态码，供上层判成"鉴权被拒"而不是"上游挂了"', async () => {
    const res = await run(
      'https://api.openai.com/v1',
      fakeFetch([[SUBSCRIPTION, { status: 401, body: { error: 'invalid api key' } }]]),
    );
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(401);
    expect(res.errorCode).toBe('UPSTREAM_UNREACHABLE');
  });

  it('baseUrl 非法时不发请求，直接 PARSE_FAILED', async () => {
    const res = await run('不是地址', fakeFetch([]));
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('PARSE_FAILED');
    expect(res.httpStatus).toBe(0);
  });
});

describe('raw 净化：先抹明文，再截断，且仍是合法 JSON', () => {
  it('抹掉明文 key 的每一次出现（含嵌套与键名）', () => {
    const out = sanitizeUpstreamBody(
      { error: `invalid api key ${SECRET}`, nested: { list: [`${SECRET} 又被回显了一次`] } },
      SECRET,
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('****');
  });

  it('截断后仍是可 JSON.parse 的对象，而不是半截字符串', () => {
    const body = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, note: 'x'.repeat(20) })) };
    const out = sanitizeUpstreamBody(body, SECRET);
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
    // 数组短了是"截断"，但绝不能塞占位元素 —— 那是造假数据
    const rows = (out as { rows: unknown[] }).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(5000);
    expect(JSON.stringify(out).length).toBeLessThan(MAX_RAW_CHARS * 2);
  });

  it('secret 为空串时只截断、不误伤内容', () => {
    const out = sanitizeUpstreamBody({ a: '原样保留' }, '') as { a: string };
    expect(out.a).toBe('原样保留');
  });
});
