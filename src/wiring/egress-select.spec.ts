// 装配层 - **出口池判据缝**实现（`src/wiring/egress-select.ts`）单测。
//
// 盯的是三支判据里**每一支都必需**、且缺一支就静默出错的口径：
//   ① 池空（0 行）= 池未启用 ⇒ 恒活；
//   ② 池内条目按单轴 `status`：active 活绑定 / retired 死绑定；
//   ③ **查无此行**（未绑账号的 Tier-1 host id）= 配置事实、照常走宿主出口。
//
// 第 ③ 支是本模块存在的理由，也是**曾经缺失**的那一支（P0）：上一版判据只覆盖 ①②，于是
// `rows.length > 0` 时每一个未绑账号的 Tier-1 host id 都落进「查无此行 = 死绑定」——
// **建第一个出口那一瞬，全池未绑账号一起 503、零出站**。本文件第一条 P0 回归用例直接钉这一点。
//
// 本文件用真库（临时目录）驱动：判据读的就是 `egress_proxies` 的真行，"查无此行"与
// "行 retired" 必须由真实写入造出来，桩不出来。

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'vitest';

import { openDatabase, type Db } from '../db/database.js';
import { createEgressProxy, reactivateEgressProxy, retireEgressProxy } from '../db/repo/egress.js';
import { createEgressSelectable } from './egress-select.js';

const MASTER_KEY = Buffer.from('7c'.repeat(32), 'hex');
const AT = '2026-10-14T00:00:00.000Z';

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

function setup(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'wiring-egress-select-'));
  dirs.push(dir);
  const db = openDatabase({ path: join(dir, 'gateway.db') });
  dbs.push(db);
  return db;
}

function addEgress(db: Db, name: string, url: string): string {
  return createEgressProxy(db, { name, url }, MASTER_KEY).id;
}

/** Typed as a Tier-1 host id：`secrets.ts` 对**未绑账号**算出来的 `egressId`（= `egressIdOfUrl(baseUrl).host`） */
const HOST_ID = 'tierflow.cn';

describe('createEgressSelectable：出口池判据缝（ADR-0021 决策 9(5)，装配层方案 A）', () => {
  it('① 池空（0 行）= 池未启用 ⇒ 恒活：任何 id 都放行（fail-open 宿主直连，不判 503）', () => {
    const db = setup();
    const selectable = createEgressSelectable(db);

    assert.equal(selectable(HOST_ID), true, '未绑账号的 host id 照常走宿主出口');
    assert.equal(selectable('eg_anything'), true, '池未启用 ⇒ 不筛');
  });

  it('③ **P0 回归**：池非空时，未绑账号的 Tier-1 host id（查无此行）**不得**判死绑定', () => {
    // 这是 P0 的内核：池里只建了**一个**出口（用户点"新建出口"那一瞬），而未绑账号的
    // `egressId` 是 `egressIdOfUrl(baseUrl)` 算出来的 host —— 它**永远不是** `egress_proxies.id`。
    // 判据若把"查无此行"读成"死绑定"，全池未绑账号在此刻一起 503。契约 §10 逐字否掉这个读法：
    // 「不含『账号级未绑』—— `egress_id IS NULL` 是配置事实、照常走宿主出口，不是池空」。
    const db = setup();
    addEgress(db, 'hk-1', 'http://10.0.0.1:8080');
    const selectable = createEgressSelectable(db);

    assert.equal(selectable(HOST_ID), true, '未绑账号：池非空**不影响**它走宿主出口');
    assert.equal(selectable('eg_missing'), true, '查无此行的任何 id 都不是"出口条目"，是配置事实');
  });

  it('② 池内条目按单轴 status：active = 活绑定；retired = 死绑定', () => {
    const db = setup();
    const active = addEgress(db, 'hk-1', 'http://10.0.0.1:8080');
    const toRetire = addEgress(db, 'us-1', 'http://10.0.0.2:8080');
    retireEgressProxy(db, toRetire, 'manual', AT);
    const selectable = createEgressSelectable(db);

    assert.equal(selectable(active), true, 'active 出口 = 活绑定');
    assert.equal(selectable(toRetire), false, 'retired 出口 = 死绑定（决策 9(1)：退役退出候选）');
    assert.equal(selectable(HOST_ID), true, '退役别的出口**不牵连**未绑账号的宿主出口');
  });

  it('请求期现查、不缓存：retire / reactivate 立即生效（零失步窗口）', () => {
    const db = setup();
    const id = addEgress(db, 'hk-1', 'http://10.0.0.1:8080');
    const selectable = createEgressSelectable(db);
    assert.equal(selectable(id), true);

    retireEgressProxy(db, id, 'manual', AT);
    assert.equal(selectable(id), false, '退役**立即**反映（判据不缓存）');

    reactivateEgressProxy(db, id, AT);
    assert.equal(selectable(id), true, '回池**立即**反映');
  });

  it('与出站缝同形：`egress-proxy.ts` 也把「不在池里的 id」当宿主机直出（两缝不得两说）', () => {
    // 判据缝说"这个 id 能不能用"，出站缝说"这个 id 怎么出去"。两条缝对"未绑 = host id 不在池"
    // 必须同读成"直连"，否则会出现"判据放行、出站却当它该死"（或反向）的两说。
    const src = readFileSync(fileURLToPath(new URL('./egress-proxy.ts', import.meta.url)), 'utf8');
    assert.match(src, /if \(entry === undefined\) return gated;/, '出站缝：不在池里 ⇒ 原样 gated（宿主直连）');
  });
});
