// 适配层单测 - 共享 SQLite → 内存快照（`src/wiring/store.ts`）
//
// 盯的是四条一旦写错就静默出错的口径：
//   1. `secrets.resolve()` 必须是**纯内存读**：refresh 之后即便把库里那行删了，
//      不 refresh 也照样能出站（证明它没在热路径上查库）；
//   2. 明文只在 refresh 时解密一次：revision 没变就不重复解密，解不开的**立刻出缓存**；
//   3. 只有与快照有关的实体才触发重建 —— 后者会把 token-plan 的乐观扣减清零；
//   4. `UpstreamConfig.models` 的三态：无档案=null（不限制）、有档案=只认启用的那些。
//
// 明文探针在运行时拼装，源码里不存在该字面量 —— 否则 `pnpm check:secrets` 会命中自己。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';

import { encryptSecret, sha256Hex } from '../db/crypto.js';
import { openDatabase, type Db } from '../db/database.js';
import { appendChange } from '../db/repo/change-log.js';
import { createGroup } from '../db/repo/groups.js';
import { createKey, deleteKey } from '../db/repo/keys.js';
import { upsertModelFromSync, updateModel, getModel } from '../db/repo/models.js';
import { createSupplierAccount, linkSupplierAccountKey } from '../db/repo/supplier-accounts.js';
import { createUpstream, updateUpstream } from '../db/repo/upstreams.js';
import { createSecretResolver } from './secrets.js';
import { createGatewayStore } from './store.js';

/* ------------------------------ 测试台 ------------------------------ */

const MASTER_KEY = Buffer.from('3b'.repeat(32), 'hex');

/** 运行时拼装的假上游 key：形状像真的，但源码里没有这个字面量。 */
function probeSecret(tag: string): string {
  return ['sk', 'probe', tag, sha256Hex(`wiring-store-${tag}`).slice(0, 32)].join('-');
}

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

interface Harness {
  db: Db;
  store: ReturnType<typeof createGatewayStore>;
}

function setup(masterKey: Buffer = MASTER_KEY): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-store-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  dbs.push(db);
  return { db, store: createGatewayStore({ db, masterKey }) };
}

function addUpstream(db: Db, name = 'up-a', baseUrl = 'https://a.example.com'): string {
  return createUpstream(db, { name, baseUrl }).id;
}

/** 一个最小可用的供应商账号行（凭据是密文探针，源码里没有可扫的明文）。 */
function seedAccount(db: Db, upstreamId: string, egressId: string | null = null): string {
  const id = `sa_probe_${accountSeq++}`;
  createSupplierAccount(db, id, {
    upstreamId,
    supplier: 'tierflow',
    identifier: '138****0000',
    identifierHash: sha256Hex(`wiring-store-${id}`),
    status: 'active',
    encryptedPassword: encryptSecret(probeSecret(`${id}-pw`), MASTER_KEY),
  });
  if (egressId !== null) setAccountEgress(db, id, egressId);
  return id;
}

/** 直接改出口列：Tier 2 的写路径还没落，这里只造快照输入。 */
function setAccountEgress(db: Db, accountId: string, egressId: string): void {
  db.prepare('UPDATE supplier_accounts SET egress_id = ? WHERE id = ?').run(egressId, accountId);
}

let accountSeq = 0;

/* ------------------------------ 用例 ------------------------------ */

describe('快照构造', () => {
  it('上游 / key / 模型三样都进快照，且金额与余量按列映射', () => {
    const h = setup();
    const up = addUpstream(h.db);
    const k = createKey(h.db, { upstreamId: up, key: probeSecret('alpha'), category: 'balance', balance: 12_345, weight: 7 }, MASTER_KEY);
    upsertModelFromSync(h.db, {
      upstreamId: up,
      name: 'gpt-4o',
      displayName: null,
      type: 'chat',
      capabilities: ['stream'],
      contextLength: 128_000,
      price: { inputPer1k: 1, outputPer1k: 2 },
    });

    assert.equal(h.store.refresh(), true);

    const snap = h.store.poolSnapshot();
    assert.equal(snap.upstreams.length, 1);
    assert.equal(snap.upstreams[0]?.upstreamId, up);
    assert.equal(snap.upstreams[0]?.enabled, true);
    // 有档案 → 只认档案里启用的名字（见文件头第 4 条）
    assert.deepEqual(snap.upstreams[0]?.models, ['gpt-4o']);

    assert.equal(snap.keys.length, 1);
    const key = snap.keys[0];
    assert.equal(key?.keyId, k.id);
    assert.equal(key?.upstreamId, up);
    assert.equal(key?.status, 'enabled');
    assert.equal(key?.weight, 7);
    assert.equal(key?.balanceCents, 12_345);
    assert.equal(key?.category, 'balance');

    // 掩码与价格换算都来自同一版快照
    assert.equal(h.store.maskOf(k.id), k.maskedKey);
    assert.equal(h.store.maskOf('key_不存在'), '****', '未知 keyId 给 **** 而不是抛错');
    assert.equal(h.store.costCentsOf('gpt-4o', 1000, 500), 1 + 1, '1 分/1k 输入 + 2 分/1k 输出');
    assert.equal(h.store.costCentsOf('没人建过档的模型', 1000, 500), 0, '单价未知按 0（不是编一个价格）');
    assert.equal(h.store.keyCount(), 1);
  });

  it('上游一个档案都没有时 models=null（不限制），不是空数组', () => {
    const h = setup();
    const up = addUpstream(h.db);
    h.store.refresh();

    // null = 不限制（新装机行为）；[] = 一个模型都不许走 —— 两者不能混
    assert.equal(h.store.poolSnapshot().upstreams[0]?.models, null);
  });

  it('停用档案里的模型 → 立刻从「上游允许集合」消失', async () => {
    const h = setup();
    const up = addUpstream(h.db);
    const inserted = upsertModelFromSync(h.db, {
      upstreamId: up,
      name: 'gpt-4o',
      displayName: null,
      type: 'chat',
      capabilities: [],
      contextLength: null,
      price: null,
    });
    upsertModelFromSync(h.db, {
      upstreamId: up,
      name: 'gpt-4o-mini',
      displayName: null,
      type: 'chat',
      capabilities: [],
      contextLength: null,
      price: null,
    });
    h.store.refresh();
    assert.deepEqual(h.store.poolSnapshot().upstreams[0]?.models, ['gpt-4o', 'gpt-4o-mini']);

    const dto = getModel(h.db, inserted.id);
    assert.ok(dto);
    updateModel(h.db, inserted.id, { enabled: false, revision: dto.revision });

    assert.equal(h.store.refresh(), true, '模型停用属于「与快照有关」的变更');
    assert.deepEqual(h.store.poolSnapshot().upstreams[0]?.models, ['gpt-4o-mini']);
    assert.deepEqual(
      (await h.store.catalog.listEnabledModels()).map((m) => m.id),
      ['gpt-4o-mini'],
    );
  });

  it('上游停用 → 其名下模型不再出现在 /v1/models（联动的是上游开关）', async () => {
    const h = setup();
    const up = addUpstream(h.db);
    upsertModelFromSync(h.db, {
      upstreamId: up,
      name: 'gpt-4o',
      displayName: null,
      type: 'chat',
      capabilities: [],
      contextLength: null,
      price: null,
    });
    h.store.refresh();
    const before = await h.store.catalog.listEnabledModels();
    assert.deepEqual(before.map((m) => m.id), ['gpt-4o']);
    assert.equal(before[0]?.ownedBy, 'up-a');

    updateUpstream(h.db, up, { enabled: false, revision: 1 });
    // 列表是**实时读**（验收 4 要求与档案 0 差异），不该等 1s 轮询窗口
    assert.deepEqual(await h.store.catalog.listEnabledModels(), []);
  });
});

describe('明文缓存', () => {
  it('resolve 是纯内存读：库里那行删掉、不 refresh 也照样能出站', () => {
    const h = setup();
    const up = addUpstream(h.db);
    const plain = probeSecret('beta');
    const k = createKey(h.db, { upstreamId: up, key: plain, category: 'balance' }, MASTER_KEY);
    h.store.refresh();

    assert.deepEqual(h.store.secrets.resolve(k.id), { upstreamId: up, baseUrl: 'https://a.example.com', apiKey: plain });

    // 硬约束（PM 冻结）：热路径零 SQL。软删之后不 refresh，明文必须还在 ——
    // 反过来说，如果 resolve() 真在查库，这里已经返回 null 了
    deleteKey(h.db, k.id);
    assert.equal(h.store.secrets.resolve(k.id)?.apiKey, plain);

    // refresh 之后才消失：软删/物理删的 key 不该留在内存里
    assert.equal(h.store.refresh(), true);
    assert.equal(h.store.secrets.resolve(k.id), null);
    assert.equal(h.store.secrets.size(), 0);
  });

  it('revision 没变不重复解密；上游 base URL 变化立刻反映到 resolve', () => {
    const h = setup();
    const up = addUpstream(h.db);
    const k = createKey(h.db, { upstreamId: up, key: probeSecret('gamma'), category: 'balance' }, MASTER_KEY);
    h.store.refresh();
    const first = h.store.secrets.resolve(k.id);

    // 改上游名（不在 SNAPSHOT_ENTITIES 里）→ 不重建，但 base URL 也没变
    h.store.refresh();
    assert.equal(h.store.secrets.resolve(k.id)?.apiKey, first?.apiKey);

    updateUpstream(h.db, up, { baseUrl: 'https://b.example.com', revision: 1 });
    assert.equal(h.store.refresh(), true);
    assert.equal(h.store.secrets.resolve(k.id)?.baseUrl, 'https://b.example.com');
  });

  it('解密失败：立刻出缓存 + 上报 keyId，且不抛（坏 key 不该带走整个刷新）', () => {
    const created = setup();
    const up = addUpstream(created.db);
    const k = createKey(created.db, { upstreamId: up, key: probeSecret('delta'), category: 'balance' }, MASTER_KEY);

    // 用另一把 master key 建缓存 = 模拟"管理端换过主密钥"
    const wrong = Buffer.from('4c'.repeat(32), 'hex');
    const errors: string[] = [];
    const store = createGatewayStore({ db: created.db, masterKey: wrong, onDecryptError: (id) => errors.push(id) });

    assert.equal(store.refresh(), true);
    assert.deepEqual(errors, [k.id]);
    // 删掉而不是留着旧明文：否则事故会以"用旧 key 悄悄打上游"的形态继续
    assert.equal(store.secrets.resolve(k.id), null);
    assert.equal(store.secrets.size(), 0);
    // key 仍在快照里（配置上是启用的），只是出不了站 → 引擎会跳过它、不计失败
    assert.equal(store.keyCount(), 1);
  });

  it('软删的 key 不进快照、不进缓存', () => {
    const h = setup();
    const up = addUpstream(h.db);
    const k = createKey(h.db, { upstreamId: up, key: probeSecret('epsilon'), category: 'balance' }, MASTER_KEY);
    h.store.refresh();
    assert.equal(h.store.keyCount(), 1);

    deleteKey(h.db, k.id);
    assert.equal(h.store.refresh(), true);
    assert.equal(h.store.keyCount(), 0);
    assert.equal(h.store.secrets.resolve(k.id), null);
  });
});

describe('刷新触发条件', () => {
  it('与快照无关的变更（改用户组名）不重建', () => {
    const h = setup();
    addUpstream(h.db);
    h.store.refresh();

    const group = createGroup(h.db, { name: '组-旧' });
    assert.equal(h.store.refresh(), false, 'group 只影响鉴权（实时读），没有理由重建 key 池');
    assert.ok(group.group.id !== '');
  });

  it('余额录入 / 新增 key / 新增上游都会触发重建', () => {
    const h = setup();
    const up = addUpstream(h.db);
    h.store.refresh();
    assert.deepEqual(h.store.poolSnapshot().upstreams.map((u) => u.upstreamId), [up]);

    createKey(h.db, { upstreamId: up, key: probeSecret('zeta'), category: 'balance' }, MASTER_KEY);
    assert.equal(h.store.refresh(), true);
    assert.equal(h.store.keyCount(), 1);

    addUpstream(h.db, 'up-b', 'https://b.example.com');
    assert.equal(h.store.refresh(), true);
    assert.equal(h.store.poolSnapshot().upstreams.length, 2);

    // 没有新变更时不该无限重建（否则 applySnapshot 会被空转调用，见 store.ts 头注释）
    assert.equal(h.store.refresh(), false);
  });
});

describe('出口归属（E 接缝：台账 → 快照缓存）', () => {
  it('无主 key：accountId=null，egressId 按 base URL 推导（Tier 1，与改动前逐字相同）', () => {
    const h = setup();
    const up = addUpstream(h.db); // https://a.example.com
    const k = createKey(h.db, { upstreamId: up, key: probeSecret('egress-a'), category: 'balance' }, MASTER_KEY);
    h.store.refresh();

    assert.deepEqual(h.store.secrets.egressOf(k.id), { egressId: 'a.example.com', accountId: null });
    // 缓存里多出来的两个值**不得**改变出站面：resolve 的返回形状本批一字不动
    assert.deepEqual(Object.keys(h.store.secrets.resolve(k.id) ?? {}).sort(), ['apiKey', 'baseUrl', 'upstreamId']);
  });

  it('入池 key 的归属来自台账；账号没指定出口时退回 Tier 1 推导', () => {
    const h = setup();
    const up = addUpstream(h.db);
    const k = createKey(h.db, { upstreamId: up, key: probeSecret('egress-b'), category: 'balance' }, MASTER_KEY);
    const account = seedAccount(h.db, up);
    linkSupplierAccountKey(h.db, account, k.id, k.maskedKey);
    assert.equal(h.store.refresh(), true);

    assert.deepEqual(h.store.secrets.egressOf(k.id), { egressId: 'a.example.com', accountId: account });
  });

  it('账号指定出口（Tier 2）→ 原样取那一列，**不做 URL 归一化**；空串按"没指定"处理', () => {
    const h = setup();
    const up = addUpstream(h.db);
    const k = createKey(h.db, { upstreamId: up, key: probeSecret('egress-c'), category: 'balance' }, MASTER_KEY);
    const account = seedAccount(h.db, up, 'egress_hk_1');
    linkSupplierAccountKey(h.db, account, k.id, k.maskedKey);
    h.store.refresh();

    // 这一列存的是**稳定 egressId**（Tier 2 = `egress_proxies.id`），**不是 URL**。
    // 拿 `egressIdOfUrl` 去"归一化"一个 id，`new URL('egress_hk_1')` 会抛 → 恒 null，
    // 于是出口被整个丢掉 —— 那正是"一个出口零个桶 ⇒ 无上限"那条事故。
    assert.deepEqual(h.store.secrets.egressOf(k.id), { egressId: 'egress_hk_1', accountId: account });

    // 空串不是"一个叫 '' 的出口"：它会绕开宿主出口兜底，所以归一到 Tier 1。
    // 这里顺带钉住一条**给 Tier 2 写路径的约定**：改 `supplier_accounts.egress_id` 必须同时
    // 广播一条 `'key'`。它动的是一张不在 SNAPSHOT_ENTITIES 里的表，不广播就**不会重建** ——
    // 下面那行 `appendChange` 就是将来那条写路径欠的动作（本期还没有写路径，所以由测试代做）。
    setAccountEgress(h.db, account, '');
    appendChange(h.db, 'key', k.id, 'update', null);
    assert.equal(h.store.refresh(), true);
    assert.equal(h.store.secrets.egressOf(k.id)?.egressId, 'a.example.com');
  });
});

describe('归属变化不吃明文缓存（决策 4c 末条）', () => {
  it('revision 没变时只覆盖归属、不重新解密', () => {
    // 直接驱动解析器：把"密文在那两轮之间已经解不开"当成探针 ——
    // 一旦实现退化成"每轮都重新解密"，第二轮就会失败并把条目踢出缓存。
    const errors: string[] = [];
    const resolver = createSecretResolver({ masterKey: MASTER_KEY, onDecryptError: (id) => errors.push(id) });
    const cipher = encryptSecret(probeSecret('egress-light'), MASTER_KEY);
    const row = { id: 'k-light', upstream_id: 'up-1', revision: 3, secret: cipher, account_id: null, account_egress_id: null };
    const urls = new Map([['up-1', 'https://a.example.com']]);

    resolver.update([row], urls);
    resolver.update([{ ...row, secret: Buffer.from('已经不是密文了'), account_id: 'acc-1' }], urls);

    assert.deepEqual(errors, [], 'revision 未变 + 归属变了 → 走轻路径，不碰密文');
    assert.equal(resolver.size(), 1);
    assert.deepEqual(resolver.egressOf('k-light'), { egressId: 'a.example.com', accountId: 'acc-1' });
  });

  it('台账写路径发 change_log：绑定后 refresh 会重建（否则 accountId 停在旧值上）', () => {
    const h = setup();
    const up = addUpstream(h.db);
    const k = createKey(h.db, { upstreamId: up, key: probeSecret('egress-trigger'), category: 'balance' }, MASTER_KEY);
    h.store.refresh();
    assert.equal(h.store.secrets.egressOf(k.id)?.accountId, null);

    const account = seedAccount(h.db, up);
    linkSupplierAccountKey(h.db, account, k.id, k.maskedKey);
    assert.equal(h.store.refresh(), true, '台账绑定必须广播到网关快照');
    assert.equal(h.store.secrets.egressOf(k.id)?.accountId, account);
  });
});
