// 出口池判据缝的实现（ADR-0021 决策 9(5)，装配层方案 A）：**请求期现查** `egress_proxies`。
//
// 位置说明（AGENTS.md §8）：引擎（`src/gateway/`）不认识库，这条判据只能由装配层注入；
// 本模块是那条缝的**唯一实现处**，`src/server.ts` 造一次注入数据面（与 `egress-proxy.ts` 同款分工）。
//
// 本缝回答的是「**绑定到某个出口**的账号此刻还能不能从这个出口出去」，**不是**「这个 id 是不是出口」。
// 于是有三支，缺任何一支都会静默做错：
//   1. **池空（0 行）= 池未启用 ⇒ 恒活**（fail-open 宿主直连、不判 503）。
//      反回退钉守了很久的就是这一支（`if (rows.length === 0) return true;`）。
//   2. **池里有这一行** ⇒ 按单轴 `status` 判死活：`active` = 活绑定；`retired` = 死绑定
//      （决策 9(1)：退役退出候选）⇒ 全部候选都死时引擎回 `503 NO_AVAILABLE_EGRESS`。
//   3. **池里查无此行** ⇒ 这个 id **不是出口条目**，是 Tier-1 的 host id
//      （`secrets.ts` 的 `account_egress_id ?? egressIdOfUrl(baseUrl)`：账号**未绑出口**时
//      `egressId = host`）= **配置事实，照常走宿主出口**。契约 §10 逐字如此：
//      「**不含『账号级未绑』** —— 某个账号 `egress_id IS NULL` 是**配置事实**、照常走宿主出口，不是池空」。
//
// ⚠️ 第 3 支是本模块存在的理由，也是它曾经缺失的那一支（P0）：
//   反回退钉只护住了第 1 支。少了第 3 支，`rows.length > 0` 时**每一个未绑账号的 Tier-1 host id
//   都落进「查无此行 = 死绑定」** ⇒ **用户建第一个出口的那一瞬，全池未绑账号一起冻结**（503、
//   零出站）；解绑也救不回（池仍非空）、`retire` 只会撞 `409 EGRESS_HAS_ACCOUNTS` ——
//   面板上没有任何动作能退回。症状是「一建出口就 503」，而失败面（`NO_AVAILABLE_EGRESS`）
//   看起来像「出口配置坏了」，根因（判据把"未绑"当"死绑定"）要好几个来回才定位得到。
//
// 与出站缝**必须同形**：`src/wiring/egress-proxy.ts` 的 `known.get(egressId) === undefined ⇒ 原样 gated`
// 用的是同一句判断（不在池里 = 直连 = 配置事实）。两条缝一旦不同形，「能选中」与「走得出去」就会两说。
//
// 为什么不按 id 形状（前缀 `eg_`）判 Tier-2：契约 §0.2 逐字「id 是 string，前端**不得解析其内部结构**」，
//   前缀「**不构成 API 语义**」。拿前缀去决定 503 / 直连，等于把前缀升格成语义 —— 正是 §0.2 禁的形状。
//   也不依赖「行会被物理删除」：`egress_proxies` 退役是**状态不是删除**、且没有 DELETE 端点
//   （ADR-0021 决策 9），所以「绑了出口」的行永远在池里 —— 第 2 支判得到，不需要用形状兜底。

import { listEgressProxies } from '../db/repo/egress.js';
import type { Db } from '../db/database.js';

/**
 * 造一个出口活集判据闭包，交给 `GatewayRuntimeOptions.egressSelectable`（引擎侧 `EngineOptions.egressSelectable`）。
 *
 * **每条候选一查**（表是个位数行，一条同步 SELECT 微秒级）：不缓存 —— `retire` / `reactivate`
 * 立即生效，零失步窗口。返回值 `false` 的候选按**死绑定**跳过；全部候选都死 ⇒
 * `503 NO_AVAILABLE_EGRESS`（不带 `Retry-After`、不回落宿主直连）。
 */
export function createEgressSelectable(db: Db): (egressId: string) => boolean {
  return (egressId: string): boolean => {
    const rows = listEgressProxies(db);
    // 支 1：池未启用 ⇒ 恒活（fail-open 宿主直连、不判 503）。
    if (rows.length === 0) return true;
    // 支 3：查无此 id ⇒ 不是出口条目（未绑账号的 Tier-1 host 出口）⇒ 配置事实，照常宿主机直出。
    const row = rows.find((r) => r.id === egressId);
    if (row === undefined) return true;
    // 支 2：池里的条目按单轴 status：active = 活绑定；retired = 死绑定（决策 9(1)）。
    return row.status === 'active';
  };
}
