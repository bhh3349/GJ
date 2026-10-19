# 1panel 网关五功能 → sub 可增加性报告 v1

> 对象：`<内网地址已隐去>`（1Panel AI 网关，社区版，并发上限 10）。
> 范围：**仅** Bo 点名的五项——用户、用户组、网关设置、系统设置、左下角用户按钮（工作区切换）。
> 证据：全部为**只读文本快照**（登录后 a11y 快照 + 前端产物 `index-BYtX3fBK.js` 路由表 + 各页面 chunk 的 i18n/字段）。不截图。
> 落款：管家（管理后端工程师）。性质：**可行性提案**，不含改动，未动任何一行代码。
> 基线：`main = f711fb3`。

---

## 0. TL;DR（结论先行）

1panal 这五项里，**真正对 sub 有意义的是「工作区切换」**，其余四项 sub 已有等价物、或按 sub 的交付口径**刻意不做**。逐项判决：

| # | 1panel 功能 | sub 现状 | 判决 |
|---|---|---|---|
| 1 | 用户管理（多用户/角色/状态/MFA/锁定） | 只有单管理员 `admin_users`（username+password_hash） | **可小步做**：多管理员 + 角色位（可做，非必需） |
| 2 | 用户组（最大并发/单Key并发/Token配额/授权模型组） | `groups` 仅 rpm/tpm/daily_quota | **可选增强**：并发与模型组授权可补，quota 语义不同（sub 已按用户组发 key） |
| 3 | 网关设置（基础/性能/向量/智能路由/内容合规/ES/上游代理） | 全部走 `.env`，运行期只读 | **不做运行期面板**（铁律：安装即用）；仅「上游代理」值得考虑 |
| 4 | 系统设置（基础/开放API/企业认证/MFA） | 有 `audit_log`，无设置页、无开放API凭证、无企业认证 | **大部分不做**；`audit_log` 查询页是低垂果实 |
| 5 | 左下角用户按钮 → **工作区切换**（管理中心 ⇄ 用户中心） | 无此概念：只有一个管理员后台 | **可做、且最值得做**（等价物=租户/视图隔离） |

---

## 1. 先把「工作区切换」弄懂（Bo 特别点名）

### 1.1 它到底是什么

`<内网地址已隐去>` 前端有两个**并列的顶层工作区**（证据：`index-BYtX3fBK.js` 路由表）：

- **管理中心**：`/admin/*`，路由 `meta.requiredRole: 'admin'`
  - 子页：概览、账号池、模型组、用户、用户组、智能路由、内容合规、用量统计、调用日志、网关设置、系统设置
- **用户中心**：`/console/*`，仅 `requiresAuth`（无角色门槛）
  - 子页：模型广场 `/console/models`、API Keys `/console/api-keys`、用量统计 `/console/usage`

「左下角用户按钮 → 菜单顶部『切换工作区』标签 → 管理中心 / 用户中心」就是把当前 URL 在 `/admin` 与 `/console` 之间切换，**同一账号、同一登录会话**下换一套左侧导航。

### 1.2 支撑它的机制（关键，决定「我们能不能加」）

1. **登录后按角色分流**：路由守卫 `function O(e){ return e?.roles.includes('admin') ? '/admin' : '/console/models' }`
   —— 账号带 `admin` 角色 → 落管理中心；否则落用户中心（模型广场）。
2. **越权自动弹回**：守卫里若 `meta.requiredRole` 不满足，直接 `O(user)` 返回自己角色对应的首页。普通用户 URL 敲 `/admin` 会被弹到 `/console/models`。
3. **用户对象自带 `roles: string[]`**，权限判断只看这一项（`users-DuX57thz.js` 中 `role==='admin'` / `role!=='user'` 分支）。

所以「工作区切换」**不是一个新功能，而是「角色 + 两套前端工作区」的自然结果**。它的价值是：**同一个产品，管理员看治理面，普通用户只看「拿模型、发 key、看用量」三件事**，互不越界。

### 1.3 sub 侧现状

sub 的 `admin_users` 只有 `username / password_hash`（`src/db/schema.ts`），**没有角色列、没有普通用户概念**；前端只有一个管理后台（`web/src/pages/*`），没有 `/console` 这类消费视角工作区。`GET /api/auth/session` 只回 `{username, expiresAt}`（`src/api/routes/auth.ts`）。

### 1.4 可增加性（分三档，按成本从小到大）

**A 档（最小可用，推荐先做）——只加「视图」，不加「租户」**
- 复用现有单管理员会话，前端增设 `/console` 工作区：模型广场（读 `/api/models`）、我的 Key（复用「用户组→发 key」）、我的用量（读 `/api/stats/usage` 过滤到本人组）。
- 左下角用户按钮加「切换工作区」互切 `/admin ⇄ /console`。
- **成本**：纯前端路由 + 2~3 个只读页；**后端 0 改动**。风险极低。

**B 档（真多用户）——加普通用户与服务端角色位**
- `admin_users` 增 `role`（`admin|user`）、`display_name`、`enabled`、`last_login_at`（纯加列，`SCHEMA_VERSION` 不递增，同 `capabilities_source` 那批）。
- `sessions` 记 `role`；`onRequest` 鉴权闸门按 `path` 授面：`/api/**`（管理面）限 `role=admin`，消费面挂新前缀（如 `/api/console/**`）放行 `user`。
- 用户中心页调 `/api/console/*`：只回本人组名下的 key 与用量，**永不吐别组数据**。
- **成本**：`src/db`（加列+repo）+ `src/api`（新前缀路由 + 鉴权分支）+ `web`（工作区）。这是**我（管家）车道**的活，可单笔交付。

**C 档（真多租户/多工作区）——引入 tenant/workspace 维度**
- 给 `upstreams / groups / gateway_keys` 等都挂 `workspace_id`，数据按工作区分区，一个管理员可管多个工作区。
- **成本**：**高**，动 schema 主干 + 全量查询面 + 网关共享树（`src/gateway/` 不能 import `src/db`，跨租户隔离要重设计 KeyPool）。**建议：不做**，除非 Bo 真有「一个部署服务多个互不可见的租户」需求。

> 判定：Bo 想要的「工作区切换」= 1panel 的**双视图**。对 sub，**A 档即可复刻观感，B 档才是等价物**，C 档超出当前产品定位。

---

## 2. 用户管理

**1panel 有**：用户列表（角色/用户组/Token 用量/状态/最近登录/创建时间/备注/企业认证/双因素认证）、按状态·用户组筛选、用户名搜索、行内启用开关、编辑、锁定/解锁、MFA 状态（证据：`users-DuX57thz.js` 含 `role`/`mfa`/`tokenUsage`/`mustChangePassword`）。

**sub 有**：单管理员（`admin_users`），`auth.ts` 三条纪律（响应不吐 token、成败都审计、防用户名枚举）。

**可增加性**：
- ✅ **多管理员 + `role` 列**：值得做（B 档前置）。
- ✅ **状态/最近登录**：`last_login_at` 纯加列，与 `audit_log` 已有的 `auth.login` 记录天然对齐，成本小。
- ⚠️ **锁定/解锁**：sub 目前有 IP 级登录限流（`loginLimiter`），**账号级锁定**可加（加 `locked_until` 列），但不是刚需。
- ⏸ **MFA**：见 §4，建议暂不做。

---

## 3. 用户组

**1panel 有**（`user-groups-DY6tKNcx.js` i18n 坐实）：`maxConcurrency`（组最大并发）、`apiKeyMaxConcurrency`（单 Key 并发）、`tokenQuota`（Token 配额，单位 万/百万/亿…）、`authorizedModelGroups`（授权模型组）；`Default` 默认组不可删、Switch 置灰。

**sub 有**：`groups`（`name / rpm / tpm / daily_quota / enabled`）。语义对齐点：sub 的 `daily_quota`(token) ≈ 1panel 的 `tokenQuota`；sub 的 `rpm/tpm` 是**限流**，1panel 是**并发**。

**可增加性**：
- ✅ **授权模型组**：sub 已有「用户组 → 发 key → 配额」，加「该组可用哪些模型」是自然扩展（新表 `group_models(group_id, model_id)` 或 CSV 列）。**路由者的路由引擎需读这条授权**（涉 `src/gateway/`，接口先行）。
- ✅ **单 Key 并发 / 组最大并发**：需在网关侧加并发计数（路由者车道），sub 已有 429 合成能力，可扩展。
- ⚠️ **单位换算（万/百万/亿）**：sub 已有 `formatTokens()` 以「万」为主，风格已定，无需照搬。
- 🔴 **Default 组不可删**：sub 的组是"建组发 key"，无内建默认组禁忌；是否引入默认组由 Bo 定，不建议为对齐而加。

---

## 4. 网关设置 & 系统设置（合并判，这两项 sub 大概率「不做」）

**1panel 网关设置有**：基础（接入地址只读/日志保留天数/协议转换开关）、性能、向量服务、智能路由、内容合规、Elasticsearch、**上游代理**（proxy URL/用户名/密码）。
**1panel 系统设置有**：基础（会话空闲超时、MFA 全局策略）、**开放 API**（管理凭证/接口文档/操作审计）、**企业认证**（LDAP/OAuth/企微）。

**sub 的硬约束**（记忆 + 铁律）：**安装即用；端口与绑定全部走 `.env`；不写死**。因此：

| 1panel 项 | sub 判决 | 理由 |
|---|---|---|
| 基础设置（接入地址/日志保留） | 🔴 不做面板 | 已由 `.env` 承载（`PORT_GATEWAY`/`HOST_GATEWAY`…），运行期改需重启，做面板反而制造"改了不生效"的坑 |
| 性能设置（并发/队列/超时） | 🟡 可参数化 | sub 有并发/超时概念，但建议继续留在 `.env`，不做运行期热改 |
| **上游代理** | ✅ **值得考虑** | sub 已有**出口池 `egress_proxies` + 数据面接线**（`src/wiring/egress-proxy.ts`）。1panel 的"上游代理"≈sub 的出口池，**sub 已超出**（支持按账号绑出口、HTTP(S) CONNECT）。**不需要新增，只需确认出口池 UI 可达** |
| 向量服务 / 智能路由 / 内容合规 / ES | 🔴 不做 | 超出 sub 产品范围（sub 是 OpenAI 兼容网关+key 池） |
| 开放 API 凭证 | 🟡 可小步做 | sub 有 `audit_log` 基础；"管理凭证"=给外部程序调管理 API 的 token，**低优先** |
| 企业认证（LDAP/OAuth/企微） | 🔴 不做 | 与"单机安装即用"冲突，绑定外部 IdP |
| MFA（全局策略/双因素） | ⏸ 缓做 | 单管理员场景收益低；真多用户（B 档）后再议 |
| **操作审计查询页** | ✅ **低垂果实** | sub `audit_log` 已在写（`auth.login` 等），只差一个**只读查询页**（`GET /api/audit`）。成本极小、价值直观 |

---

## 5. 建议的落地顺序（供 Bo 拍板）

1. **〔A〕工作区双视图**（前端为主，0 后端）：`/admin` ⇄ `/console`，复刻 1panel 观感。**最省、最像**。
2. **〔低垂〕审计日志查询页**：`GET /api/audit` + 前端表格（数据已存在）。
3. **〔B〕多用户 + 角色位**（管家车道）：`admin_users.role/display_name/enabled/last_login_at`，鉴权按角色授面。
4. **〔可选〕用户组增强**：授权模型组（需路由者配合）。
5. **〔不做〕**：网关/系统设置运行期面板、企业认证、向量/内容合规/ES。

> 每档都是**可独立交付的一笔**（一笔一个可核验 commit + 四闸 + 红线扫）。Bo 只需圈定第几档，我出接口文档先行，再动代码。

---

## 6. 诚实边界

- 本文为**只读调查 + 可行性判断**，**未改任何代码/配置**，未产生 commit。
- 1panel 的 `openapi.yaml` 需鉴权、未取；其"用户/用户组"字段来自已登录页面的文本快照与前端产物，**属观察而非契约**。
- 对 `.66` 那台：9 个上游账号名（sadad/gsfas/…）是它既有测试数据，与 sub 的 94 把 key 池无关。

