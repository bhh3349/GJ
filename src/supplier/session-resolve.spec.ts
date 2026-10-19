// cookie-only 身份解析的离线用例（零网络：fetchImpl 注入）。
//
// 钉的是"用会话问上游这是谁"这一条路：成功形状、401/403 分开、未掩码值本地再掩、
// 拿不到掩码就拒绝。响应形状取自 2026-10-18 的现场实测（`/api/me` 的 data 键）。

import { describe, expect, it } from 'vitest';
import { resolveTokenRhythmIdentity } from './session-resolve.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function fakeFetch(spec: {
  status: number;
  body: unknown;
  rawText?: string;
}): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    calls.push({ url: String(input), method: init?.method ?? 'GET', headers });
    const text = spec.rawText ?? JSON.stringify(spec.body);
    return new Response(text, { status: spec.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const IDENTITY = {
  code: 0,
  message: 'ok',
  data: {
    id: '736e95fe-3d4a-4d8b-9685-fe9a3d6a438b',
    name: 'bhh3349',
    phoneMasked: '192****5609',
    emailMasked: 'b***@example.com',
    status: 'active',
  },
};

describe('resolveTokenRhythmIdentity（cookie-only 身份解析）', () => {
  it('200 成功：取 id / name / phoneMasked，请求带 Cookie 与 same-origin，不走 CSRF', async () => {
    const { impl, calls } = fakeFetch({ status: 200, body: IDENTITY });
    const res = await resolveTokenRhythmIdentity({
      baseUrl: 'https://tokenrhythm.example/',
      session: 'sess-abc',
      fetchImpl: impl,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identity).toEqual({
      uid: '736e95fe-3d4a-4d8b-9685-fe9a3d6a438b',
      username: 'bhh3349',
      identifier: '192****5609',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://tokenrhythm.example/api/me');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers['cookie']).toBe('tr_session=sess-abc');
    expect(calls[0]?.headers['sec-fetch-site']).toBe('same-origin');
    // 只问身份，不碰写请求的安全头。
    expect(calls[0]?.headers['x-csrf-token']).toBeUndefined();
  });

  it('401 = 会话失效（与 403 分开）', async () => {
    const { impl } = fakeFetch({
      status: 401,
      body: { code: 'UNAUTHORIZED', message: '未认证或登录已过期' },
    });
    const res = await resolveTokenRhythmIdentity({
      baseUrl: 'https://tokenrhythm.example',
      session: 'sess-abc',
      fetchImpl: impl,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('session_expired');
    expect(res.message).toContain('401');
  });

  it('403 绝不映射成 session_expired（ADR-0040 实测钉子）', async () => {
    const { impl } = fakeFetch({ status: 403, body: { code: 'CSRF_INVALID', message: '拒绝' } });
    const res = await resolveTokenRhythmIdentity({
      baseUrl: 'https://tokenrhythm.example',
      session: 'sess-abc',
      fetchImpl: impl,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('upstream_rejected');
    expect(res.reason).not.toBe('session_expired');
  });

  it('200 但信封 code 是 UNAUTHORIZED → 会话失效', async () => {
    const { impl } = fakeFetch({
      status: 200,
      body: { code: 'UNAUTHORIZED', message: '未认证或登录已过期' },
    });
    const res = await resolveTokenRhythmIdentity({
      baseUrl: 'https://tokenrhythm.example',
      session: 'sess-abc',
      fetchImpl: impl,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('session_expired');
  });

  it('上游回了未掩码手机号 → 本地再掩一次，绝不落真值', async () => {
    const { impl } = fakeFetch({
      status: 200,
      body: { code: 0, data: { id: 'u-1', name: 'n', phoneMasked: '19200005609' } },
    });
    const res = await resolveTokenRhythmIdentity({
      baseUrl: 'https://tokenrhythm.example',
      session: 'sess-abc',
      fetchImpl: impl,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.identity.identifier).toBe('192****5609');
  });

  it('没有 phoneMasked 时用 emailMasked；两者都没有 → 拒绝', async () => {
    const email = fakeFetch({
      status: 200,
      body: { code: 0, data: { id: 'u-1', name: 'n', emailMasked: 'a***@example.com' } },
    });
    const ok = await resolveTokenRhythmIdentity({
      baseUrl: 'https://tokenrhythm.example',
      session: 's',
      fetchImpl: email.impl,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.identity.identifier).toBe('a***@example.com');

    const none = fakeFetch({ status: 200, body: { code: 0, data: { id: 'u-1', name: 'n' } } });
    const bad = await resolveTokenRhythmIdentity({
      baseUrl: 'https://tokenrhythm.example',
      session: 's',
      fetchImpl: none.impl,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('identity_unavailable');
  });

  it('缺少 id → 拒绝（没有判重键就不能建行）', async () => {
    const { impl } = fakeFetch({
      status: 200,
      body: { code: 0, data: { name: 'n', phoneMasked: '192****5609' } },
    });
    const res = await resolveTokenRhythmIdentity({
      baseUrl: 'https://tokenrhythm.example',
      session: 's',
      fetchImpl: impl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('identity_unavailable');
  });

  it('网络错误 / 非 JSON 都不抛，只回分类原因', async () => {
    const throwing = (async (): Promise<Response> => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const down = await resolveTokenRhythmIdentity({
      baseUrl: 'https://tokenrhythm.example',
      session: 's',
      fetchImpl: throwing,
    });
    expect(down.ok).toBe(false);
    if (!down.ok) expect(down.reason).toBe('upstream_unreachable');

    const html = fakeFetch({ status: 200, body: null, rawText: '<html>gateway</html>' });
    const bad = await resolveTokenRhythmIdentity({
      baseUrl: 'https://tokenrhythm.example',
      session: 's',
      fetchImpl: html.impl,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('envelope_invalid');
  });
});
