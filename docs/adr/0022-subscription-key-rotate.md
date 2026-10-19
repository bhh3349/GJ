# 22. 套餐专属 key 轮换 / 重置（§15.13）

- 状态：**已落（2026-10-12；Bo 指示 + 手册 §5.3 已实测）** —— 契约 §15.13（v1.9.0）+ 代码同批。

## 背景

TierFlow 的**套餐专属 key** 与 §4 的余额 key 是两类东西（手册 §5.5）：

|  | 套餐专属 key | 余额 key（按量） |
|---|---|---|
| 接口 | `/api/subscription/self/token*` | `/api/token/*` |
| 数量 | 每套餐固定 1 把 | 可自建多个 |
| 管理 | **只能重置**，不能新建 / 删除 | 新建 / 修改 / 启停 / 删除 |
| 扣费 | 扣套餐自己的额度池 | 扣账户钱包余额 |

v1.4.0 冻结时（ADR-0018 决策 7），上游的 `POST /api/subscription/self/token/rotate` 在供应商文档里
**自标「未实测」**，且当时只确认了套餐 key **查询**接口 `GET /api/subscription/self/token` 回掩码。
于是 §15.8 第 8 问把"套餐能不能进池被网关先烧"判为**不能**，并把「若将来实测确认 rotate 能取回明文
且 Bo 要，则是独立的一次契约变更（新增 ADR + 改 §15）」写成明文前置条件。

2026-10-10 Bo 提供的手册（`TierFlow接口调用手册.md` §5.3）已把 rotate 标为 **「✅ 实测」**：
**重置响应会直接下发新 Key 明文**、旧 Key 立即失效、随后再查只拿到掩码。
2026-10-12 Bo 明确指示："重置套餐 key 做了没？没做就做一下"。

**前置条件满足 ⇒ 本 ADR 即那次"独立的一次契约变更"。**

## 决策

1. **新增管理面端点** `POST /api/supplier-accounts/rotate-key`（契约 §15.13，v1.9.0）。
   body `{upstreamId, ids?, subNo?}` → `202 {taskId}`，任务类型 `supplier_rotate_key`，
   逐行结果复用 §15.3 `SupplierBatchResult`。
   - `ids` 省略 = 该上游**全部**账号（与 `refresh` 同口径）；`subNo` 省略 = 各账号**最新到期**的套餐。
   - **`SupplierBatchAction` 新增第 6 个值 `rotate`**（被重登过的行照 §15.3 报 `relogin`）。

2. **取回明文 ⇒ 当场入池**：重置响应里的 `sk-…` 明文由**服务端**取回、当场 `aes-256-gcm` 写入
   `upstream_keys`（`category='token-plan'`，走既有 `createKey` 路径），响应 / 任务 result **只回
   `keyId` + `keyMasked`**。明文**不经浏览器**、不进日志 / 审计 —— 与 §15.2 `keys` 同一条纪律。

3. **四步固定次序（纪律，不是实现细节）**：
   1. **先落库、后失效** —— 新 key 入库**成功之后**才禁用被替换的旧 key。
      明文只在重置响应里出现这一次 ⇒ 顺序反了会造成"旧 key 已废、新明文已丢"的**不可恢复态**。
   2. **`subNo` 省略取"最新到期"**（`end_at` 最大，`NULL` 最后）：多套餐账号里，正在生效的那个才是
      用户说"重置这个套餐的 key"时指的那个。名下无套餐记录 → 逐行 `SUBSCRIPTION_NOT_FOUND`（不发上游）。
   3. **旧 key 只在掩码「精确相等且唯一」时被认领并禁用**，且**认领锚点 = 「重置前」的旧掩码**：
      实现须在重置**之前**先查一次该套餐 key 的掩码（`GET /api/subscription/self/token?sub_no=`）。
      **实测（2026-10-12）**：上游重置换尾（`…iHLd` → `…5w2l`），拿新掩码认领**永远落空**；
      旧掩码查询失败 → 本次不自动禁用（按"认领不到"处理）。命中 0 条或 >1 条一律**不动任何 key**，
      该行仍 `ok:true`，`message` 说明"未自动禁用、请人工核对"。取向同 §15.2 `keys/sync` 的
      `KEY_MASK_AMBIGUOUS` —— 宁可留一把已失效的旧 key，也不误禁别人的 key。
   4. **重置不改变账号 `status`**：§15.1 的 `status` 是"最近一次查询"的结论，重置不是查询。
      失败只写 `statusMessage`（同 `failurePatch`），成功也不把它顶成 `active`。

4. **落库口径**：`category='token-plan'`、`enabled=1`、`label=套餐-<plan_title>`；
   **`token_plan_remaining` 落 `NULL`**（余量未知 ≠ 0，由后续 `keys/sync` / 余额刷新回填
   —— **该"后续"已于 2026-10-16 由 ADR-0030 落地为 `backfillSubscriptionTokenPlan`**）；
   **`unlimited` 不适用**（`token-plan` 行不落该列，§15.7）。旧 key 走既有 `deleteKey` 软删
   （`enabled=0` + `deleted_at`），台账行**不删**（保留对账历史）。

5. **不改任何码表**：`SUBSCRIPTION_NOT_FOUND` / `KEY_PLAINTEXT_MISSING` 是**逐行 `items[].code`**
   （进不了 `ERROR_CODES`，同 `LOGIN_INVALID_CREDENTIALS` / `KEY_MASK_AMBIGUOUS`）；
   新增审计动作 `supplier.rotate-key`（`detail` 只放计数）。

6. **不改既有口径**：① `action` 之外**无字段改名 / 删除**；② `SCHEMA_VERSION` 仍为 **2**、**零 DDL**
   （第一把 `token-plan` 行是**新数据**，不是新列）；③ `/v1/*` 零变更、`src/gateway/` **零改动**
   （网关按 `category` + `balance_cents` 选路；`unlimited=0` + `balance_cents IS NULL` 走既有
   「未知 ≠ 0、仍可用」分支）；④ **§15.8 第 8 问的"套餐额度不进 `totalBalance` / 不进 §14 快照 /
   不进网关准入判断"三条零改动** —— 本次动的是**凭据**的入池通路，不是**额度**的展示口径。

## 与 ADR-0018 / ADR-0011 的关系

- **修订 ADR-0018 决策 7 / §15.8 第 8 问的适用范围**：原文"套餐不建 key"针对的是**只拿得到掩码**的
  情形（掩码不可逆 ⇒ 建行等于造一把不可用凭据）。新增的 rotate 通路**能取回明文** ⇒ 不再落在该禁令内。
  **ADR-0018 决策 7 对"用掩码回捞池内 key"的部分零改动。**
- **不复活 ADR-0011 的"先烧套餐再烧余额"**：`rotate` 只产出**凭据**；**套餐额度仍不进任何网关准入判断**。
  池内出现 `token-plan` 行的是**挂该账号的套餐专属 key**（其额度池归上游管），
  与"本地账本按 ADR-0011 排序"是两回事。真正的"先烧套餐"若要落地，仍须另开一次契约变更。
  > **2026-10-16 追认（ADR-0030）**：那次契约变更**已经做了** —— ADR-0030 补上本文 §4 承诺的
  > "后续回填"腿，并把 ADR-0011 的未知哨兵从 `-1` 改 `1`，"套餐 key 优先于余额 key"自此生效。
  > 本文 §4 的**具体承诺**（"由后续 `keys/sync` / 余额刷新回填"）由 ADR-0030 的
  > `backfillSubscriptionTokenPlan` 兑现；**判据本身未变**：`token_plan_remaining` 仍是
  > "未知 ≠ 0、仍可用"，`/v1/*` 与 `src/gateway/` 的准入过滤零改动。

## 代价与已知边界（不粉饰）

1. **上游明文在结果面不可取回**：重置只此一次 —— 这正是"先落库、后失效"必须是硬次序的原因。
2. **旧 key 可能不被自动禁用**：掩码撞号 / 不在池内时只报 `message`，由人工在账号面手动启停兜底。
3. **全新 key 未对账前 `token_plan_remaining` 为 `NULL`**：网关按"未知"处理（可用），
   真实余量等下一次 `keys/sync` / 余额刷新。
4. **供应商改版会静默弄坏驱动器**（同 ADR-0018 代价 2）：`:id/test` 与逐行 `items[].message`
   是它的探测面。

## 验证口径（已落）

- **四闸**：`typecheck` RC=0 ｜ `test`（含新增 5 条驱动器用例 + 5 条路由用例）全过 ｜ `build` ok ｜
  `check:secrets` 0 命中。
- **红线**：`rotate` 相关代码 / 用例 / 文档零真实手机号、零 `sk-` 明文常量（用例明文运行时拼接）。
- **关键不变量（用例断言）**：新 key `category='token-plan'`、`enabled=1`、`token_plan_remaining IS NULL`；
  旧 key `enabled=0` 且 `deleted_at` 非空而台账行保留；明文不出现在响应 / result / 库文本 / 出站请求体。
- **安全断言（用例）**：无会话 → **零上游请求**；排除名单命中 → **零上游请求**；撞号 → **零禁用**。
