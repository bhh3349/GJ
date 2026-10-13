// 装配层 - **数据面出口代理**出站包装（`src/wiring/egress-proxy.ts`，缺口 A）单测。
//
// 盯的是四条一旦写错就静默出错的口径（与派工令的五条铁律一一对应）：
//   1. **池里没有这一行 ⇒ 原样返回 `gated`**（Tier 1 的 host 型 id / 账号未绑出口 = 配置事实，
//      不是"回落"）—— 这是"零漂移"那一半；
//   2. **池里有这一行却挂不出去 ⇒ 抛**（凭据解不开 / 已退役）—— 决策 9(5)：
//      绝不静默回落宿主直连（一个"绑了出口"的账号偷偷从宿主 IP 出去，账却记在那个出口头上）；
//   3. **禁每请求解密**：同一个出口反复出站复用**同一个** `ProxyAgent` 实例（在配置不变的前提下），
//      配置变了（`change_log` 的 `egress` 实体）才重建 —— 验收 6 的 TTFB 压在这条上；
//   4. **次序**：`dispatcher` 只被注进 `init`，`gated` 照旧收下原样的 `(input, init)`。
//
// 本文件不发任何真实网络：`gated` 是记录参数的桩，`ProxyAgent` 只被构造（不发请求）。

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';

import { openDatabase, type Db } from '../db/database.js';
import { appendChange } from '../db/repo/change-log.js';
import { createEgressProxy } from '../db/repo/egress.js';
import { createEgressProxyLifecycle } from './egress-proxy.js';

const MASTER_KEY = Buffer.from('7c'.repeat(32), 'hex');

const dirs: string[] = [];
const dbs: Db[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 上偶尔仍被短时占用，临时目录不影响判据 */
    }
  }
});

function setup(options: { onError?: (egressId: string, err: unknown) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-egress-proxy-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  dbs.push(db);
  const proxy = createEgressProxyLifecycle({
    db,
    masterKey: MASTER_KEY,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  return { db, proxy };
}

function addEgress(db: Db, name: string, url: string, auth?: [string, string]): string {
  const created = createEgressProxy(
    db,
    auth === undefined ? { name, url } : { name, url, username: auth[0], password: auth[1] },
    MASTER_KEY,
  );
  return created.id;
}

/** 记录 `init` 的桩 `gated`：形状与 `fetch-gate.ts` 造出来的那个逐字同款（收 `(input, init)`） */
function makeGated() {
  const calls: { input: unknown; init: RequestInit }[] = [];
  const gated = (async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init: init ?? {} });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { gated, calls };
}

function dispatcherOf(init: RequestInit): unknown {
  return (init as unknown as Record<string, unknown>).dispatcher;
}

/** 调一次出站、把 `gated` 收到的 `init.dispatcher` 取回来（这是判"有没有重建 agent"的唯一观测面） */
function outboundDispatcher(proxy: ReturnType<typeof setup>['proxy'], egressId: string): unknown {
  const { gated, calls } = makeGated();
  void proxy.outbound(egressId, gated)('https://up.example.com/v1/models', { method: 'POST' });
  return dispatcherOf(calls[0]?.init ?? {});
}

describe('出口代理出站（缺口 A）：池外 id 原样直连（零漂移那一半）', () => {
  it('池里没有这一行 ⇒ 返回 `gated` 本身（`===`），一次都不多包一层', () => {
    const { proxy } = setup();
    proxy.refresh();
    const { gated } = makeGated();

    // Tier 1：`egressId` 是归一化后的 host，出口池里没有这一行 —— 正是"账号未绑出口"的直连流量
    assert.equal(proxy.outbound('api.example.com', gated), gated);
  });

  it('池里没有这一行 ⇒ 出站 `init` 里不得凭空出现 `dispatcher`', async () => {
    const { proxy } = setup();
    proxy.refresh();
    const { gated, calls } = makeGated();

    await proxy.outbound('api.example.com', gated)('https://api.example.com/v1/models', { method: 'GET' });

    assert.equal(calls.length, 1);
    assert.equal(dispatcherOf(calls[0]?.init ?? {}), undefined);
  });
});

describe('出口代理出站（缺口 A）：池内 active ⇒ 注 dispatcher，原字段一个不少', () => {
  it('`dispatcher` 被注进 `init`，method/headers/body 原样带到 `gated`', async () => {
    const { db, proxy } = setup();
    const id = addEgress(db, 'hk-1', 'https://proxy.example.com:8080');
    proxy.refresh();
    const { gated, calls } = makeGated();

    const outbound = proxy.outbound(id, gated);
    assert.notEqual(outbound, gated, '池内出口要包一层，不能原样透出去');

    await outbound('https://up.example.com/v1/chat', {
      method: 'POST',
      headers: { authorization: 'redacted' },
      body: '{"model":"m"}',
    });

    const sent = calls[0];
    assert.ok(sent !== undefined);
    assert.equal(sent.input, 'https://up.example.com/v1/chat');
    assert.equal(sent.init.method, 'POST');
    assert.deepEqual(sent.init.headers, { authorization: 'redacted' });
    assert.equal(sent.init.body, '{"model":"m"}');
    assert.ok(dispatcherOf(sent.init) !== undefined, 'dispatcher 必须被注进去（否则代理等于没接）');
  });

  it('带凭据的出口：明文（user:pass）**不进**出站请求，只进 dispatcher 的构造参数', async () => {
    const { db, proxy } = setup();
    const password = 'p@ss:word/with.chars';
    const id = addEgress(db, 'hk-auth', 'https://proxy.example.com:8080', ['sub2api', password]);
    proxy.refresh();
    const { gated, calls } = makeGated();

    await proxy.outbound(id, gated)('https://up.example.com/v1/models');

    const serialized = JSON.stringify(calls[0]);
    assert.equal(serialized.includes(password), false, '代理口令不得随出站请求体/头泄出去');
    assert.equal(serialized.includes('sub2api:'), false, 'user:pass 组合形态同样不得出现');
    assert.ok(dispatcherOf(calls[0]?.init ?? {}) !== undefined);
  });
});

describe('出口代理出站（缺口 A）：禁每请求解密（缓存判据）', () => {
  it('配置未变 ⇒ 复用**同一个** agent 实例（否则就是每请求重建/解密）', () => {
    const { db, proxy } = setup();
    const id = addEgress(db, 'hk-1', 'https://proxy.example.com:8080', ['u', 'p']);
    proxy.refresh();

    const one = outboundDispatcher(proxy, id);
    const two = outboundDispatcher(proxy, id);
    assert.ok(one !== undefined);
    assert.equal(one, two, '同一版配置（指纹未变）必须复用同一个 agent');
  });

  it('`change_log` 非 `egress` 实体 ⇒ 不重建（改了上游名不该换代理）', () => {
    const { db, proxy } = setup();
    const id = addEgress(db, 'hk-1', 'https://proxy.example.com:8080', ['u', 'p']);
    proxy.refresh();
    const before = outboundDispatcher(proxy, id);

    appendChange(db, 'upstream', 'up-1', 'update', null);
    proxy.refresh();

    assert.equal(outboundDispatcher(proxy, id), before, '与出口无关的变更不得触发 agent 重建');
  });

  it('`change_log` 出现 `egress` 实体 ⇒ 重建（改 IP / 换凭据要立刻生效）', () => {
    const { db, proxy } = setup();
    const id = addEgress(db, 'hk-1', 'https://proxy.example.com:8080', ['u', 'p']);
    proxy.refresh();
    const before = outboundDispatcher(proxy, id);

    db.prepare('UPDATE egress_proxies SET url = ? WHERE id = ?').run('https://proxy2.example.com:8080', id);
    appendChange(db, 'egress', id, 'update', null);
    proxy.refresh();

    assert.notEqual(outboundDispatcher(proxy, id), before, '出口配置变了必须换一把 agent（否则"改了 IP 没生效"）');
  });

  it('首次 `refresh()` 就把池里的出口装进镜像：不把历史 `change_log` 当增量、也不当池外直连', () => {
    const { db, proxy } = setup();
    const id = addEgress(db, 'hk-1', 'https://proxy.example.com:8080', ['u', 'p']);
    const { gated } = makeGated();

    // 建出口时已写过一条 `egress` change_log；首次 refresh 只对齐水位
    proxy.refresh();

    assert.notEqual(proxy.outbound(id, gated), gated, '池内出口必须被接管（否则第一次出站会当池外直连）');
  });

  it('`stop()` 丢弃全部 agent 与镜像；随后重新 `refresh()` 会按新配置重建', () => {
    const { db, proxy } = setup();
    const id = addEgress(db, 'hk-1', 'https://proxy.example.com:8080', ['u', 'p']);
    proxy.refresh();
    const before = outboundDispatcher(proxy, id);

    proxy.stop();

    const { gated } = makeGated();
    assert.equal(proxy.outbound(id, gated), gated, 'stop() 后镜像清空，不再接管（进程正在退出）');

    proxy.refresh();
    assert.notEqual(outboundDispatcher(proxy, id), before, '重新 refresh 后按新配置重建（旧凭据不留在进程里）');
  });
});

describe('出口代理出站（缺口 A）：挂不出去必须响，不得静默回落宿主直连', () => {
  it('已退役（`retired`）的出口 ⇒ 抛，绝不裸转发', () => {
    const { db, proxy } = setup();
    const id = addEgress(db, 'hk-1', 'https://proxy.example.com:8080');
    db.prepare("UPDATE egress_proxies SET status='retired', retired_reason='manual' WHERE id = ?").run(id);
    proxy.refresh();
    const { gated, calls } = makeGated();

    assert.throws(() => proxy.outbound(id, gated), /已退役/);
    assert.equal(calls.length, 0, '抛之前不得先发一个裸请求出去');
  });

  it('凭据解不开 ⇒ 抛 + 回调只带 egressId，且**不回落**直连', () => {
    const seen: string[] = [];
    const { db, proxy } = setup({ onError: (egressId) => seen.push(egressId) });
    const id = addEgress(db, 'broken', 'https://proxy.example.com:8080');
    // 塞一个不是 GCM 密文的 BLOB：解密必然失败（真实形态：管理端换过 master key）
    db.prepare('UPDATE egress_proxies SET secret = ? WHERE id = ?').run(Buffer.from('not-a-gcm-blob'), id);
    proxy.refresh();
    const { gated, calls } = makeGated();

    assert.throws(() => proxy.outbound(id, gated), /无法解密/);
    assert.deepEqual(seen, [id], '回调只带 egressId（不得带密文/明文）');
    assert.equal(calls.length, 0);
  });
});


/* --------------------- 防回退钉：生产装配必须真接线 --------------------- */

describe('防回退钉（缺口 A）：装配面不许静默退化成"建了出口池但不生效"', () => {
  it('`src/server.ts` 造一次出口代理生命周期，并把它随 `egress` 一起注入数据面', () => {
    // "接线了没有"没法靠运行期断言判（`server.ts` 的 `main()` 一 import 就跑）——
    // 退到源码面：与 `egressSelectable` 那条同款。少了它，症状只有一句
    // 「绑了出口，流量照样从宿主 IP 直出」，没有任何报错。
    const source = readFileSync(fileURLToPath(new URL('../server.ts', import.meta.url)), 'utf8');
    assert.equal(
      (source.match(/createEgressProxyLifecycle\(/g) ?? []).length,
      1,
      '出口代理生命周期只许造一次',
    );
    assert.match(
      source,
      /createGatewayRuntime\(\{[^}]*\begressProxy\b[^}]*\}\)/,
      '数据面（网关装配）必须拿到它 —— 否则代理永远不生效',
    );
    assert.match(
      source,
      /createEgressProxyLifecycle\(\{[^}]*masterKey:\s*config\.masterKey[^}]*\}\)/,
      '解密代理凭据用的是同一个 master key（明文只经装配层，不进内核）',
    );
  });

  it('刷新与关停都挂在网关 runtime 既有节拍上（缓存过期 = "改了 IP 没生效"）', () => {
    const source = readFileSync(fileURLToPath(new URL('./runtime.ts', import.meta.url)), 'utf8');
    assert.match(source, /options\.egressProxy\?\.refresh\(\)/, '刷新必须挂在 refreshNow（1s 节拍）上');
    assert.match(source, /options\.egressProxy\?\.stop\(\)/, '关停必须丢弃连接池/凭据');
    // 缺省不注入 ⇒ 一次都不调用（零漂移）
    assert.match(
      source,
      /options\.egressProxy === undefined \? \{\} : \{ egressOutbound: options\.egressProxy\.outbound \}/,
      '缺省不注入时必须什么都不挂（零漂移）',
    );
  });

  it('内核车道**不 import** `undici`、也**不构造** `ProxyAgent`（只在注释里提名字是允许的）', () => {
    // 判据落在"代码面"而不是"出现过这个词"：内核车道在注释里点名这两个词是有价值的
    // （它解释了缝为什么长这样），但**不许 import、不许 new** —— 那才是真正的耦合。
    for (const entry of ['engine.ts', 'stack.ts']) {
      const source = readFileSync(fileURLToPath(new URL(`../gateway/${entry}`, import.meta.url)), 'utf8');
      assert.equal(/from\s+'undici'/.test(source), false, `${entry} 不得 import undici（AGENTS.md §8）`);
      assert.equal(/new\s+ProxyAgent\s*\(/.test(source), false, `${entry} 不得构造 ProxyAgent`);
      assert.equal(/import\s*\(\s*'undici'\s*\)/.test(source), false, `${entry} 不得动态 import undici`);
    }
    const wiring = readFileSync(fileURLToPath(new URL('./egress-proxy.ts', import.meta.url)), 'utf8');
    assert.ok(/import\s*\{[^}]*ProxyAgent[^}]*\}\s*from\s*'undici'/.test(wiring), 'agent 归装配层造');
  });
});
