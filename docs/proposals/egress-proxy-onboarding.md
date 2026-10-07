# 出口代理接入方案：VPS 一键部署 + 管理面自填

- 状态：**提案（VPS 侧脚本已落 `deploy/vps-egress/`；网关未接线、`src/` 零改动）**
- 日期：2026-10-07（v2 —— Bo 已答「Ubuntu / 不用 Docker / 尽量多出口」，VPS 侧成品见 `deploy/vps-egress/README.md`）
- 提出：Bo ——「独享的，我希望可以用户自己填写代理信息。因为可能后期 IP 会有变化，
  请提供一个快捷的方式，包括在 VPS 那边部署什么程序，方便项目是填 IP 信息就能通过 IP 出口」
- 车道：**管家**（`src/db` / `src/api` / 部署脚本）；数据面接线 = 路由者；管理界面 = 画师
- 关联：ADR-0020 决策 5（Tier 2 出口 IP 池）/ ADR-0021 决策 8（容量按出口计）/ 契约 §16.7

---

## 0. 这条需求带来了什么

Bo 的两句话各改变一件事：

1. **「独享的」** ⇒ ADR-0021 补遗 6 的标定口径**成立**（静默一夜量到的额度就是我们自己的，
   不会把第三方流量算成欠账）。S4 标定可以照跑，回填出来的 `capacity` 可信。
2. **「用户自己填代理信息、IP 后期会变」** ⇒ Tier 2 从「**待 Bo 拍代理资源**」变成**已拍**；
   且需求比原设计多一条 —— **出口条目必须是运行时可维护的，不是部署期写死的**。

第 2 条推翻的是原设计的一个隐含前提：ADR-0020 写的是「账号分组绑不同出口」（部署期一次性归类），
而现在要的是「管理员在后台随时加 / 改 / 停一个出口，改一条记录就换 IP」。

---

## 1. VPS 侧：部署什么、怎么最省事

### 1.1 协议选型：**HTTP CONNECT 优先，不是 SOCKS5**

这不是偏好，是依赖决定的：

| 方案 | 网关侧代价 |
|---|---|
| **HTTP 代理（`CONNECT` 隧道）** | **+1 运行时依赖，不换栈** —— 按请求注入 `dispatcher` 是 Node 原生 `fetch` 支持的（v22 实测：喂假 dispatcher 能收到请求）；但 `ProxyAgent` **不是 `node:` 内置**（`builtinModules` 里没有 `undici`，本仓 `undici` 也未安装），要装一个运行时依赖。**fetch 栈不动**，与 stream 透传不冲突 |
| SOCKS5 | undici **不支持**。要么引入 `socks-proxy-agent` 换掉 fetch 栈（与「stream 透传不缓冲」的既有实现冲突），要么本地再套一层 HTTP→SOCKS 桥 |

> 订正（路由者实测）：本节原写「零新依赖」，不成立 —— 见上表。结论不变，只是代价从 0 变成 +1 个依赖。

**结论：VPS 上要暴露的是 HTTP 代理端口**（SOCKS5 可以同开当备用，但不是接线路径）。

### 1.2 成品：`deploy/vps-egress/install.sh`（Ubuntu 直装，不用 Docker）

Bo 已拍：**Ubuntu + 脚本直装**。容器化那一整条（Dockerfile / compose / buildx 多架构 / GH Actions 构建流水线）
**作废** —— 单二进制 + systemd 就够了，少一层要维护的东西。

脚本幂等地做四件事：

1. **按 `sha256` 校验后装 gost 单二进制** —— `GOST_SHA256` 缺失即**拒绝安装**。
   把来路不明的二进制装到出口上，等于把整条链路的流量交出去，所以这里 fail-closed，不给「跳过校验」的口子。
2. **生成口令并落盘**：`openssl rand -hex 16`（128 位，字符集只有 `[0-9a-f]`，天然避开 URL / systemd / shell 的转义坑）
   → `/etc/sub2api/egress-proxy.env`（600 root:root）。systemd 单元里只写 `${变量名}`，真值走 `EnvironmentFile`
   ⇒ 连 `systemctl cat` 都看不到口令。
3. **systemd 常驻 + 加固**：`NoNewPrivileges` / `CapabilityBoundingSet=` 空 / `ProtectSystem=strict` /
   `PrivateTmp` / `SystemCallFilter=@system-service`（监听 >1024 端口，不需要任何 capability）。
4. **ufw 只加 allow 规则**，不擅自改默认策略、不擅自 `enable` —— 一把 `enable` 是有可能把自己关在门外的。
   未生效时脚本以退出码 `3` 收尾并给出两种收尾方式；`--enable-firewall` 会在 enable 前先放行当前 SSH 来源。

```bash
# 在 VPS 上
sudo GOST_SHA256=<官方 release 摘要> ./install.sh --allow <项目服务器出口IP>/32
```

其余开关（`--rotate` 轮换口令 / `--uninstall` / `--purge` / `--dry-run` / `--socks5-port`）见 `install.sh -h`。

**备选（不想装第三方二进制时）**

- Ubuntu / Debian：`apt install 3proxy` 或 `apt install squid`（Squid 配置更重，但发行版自带、有安全更新）
- 应急、零安装：`ssh -N -D 0.0.0.0:1080 user@vps`（动态转发）；只适合临时排障，不做生产接线

### 1.3 防火墙：只放行项目服务器

`install.sh` 只做下面这条的等价物，**不改默认策略、不擅自 `enable`**（理由见 1.2 第 4 条）：

```bash
ufw allow from <项目服务器出口IP> to any port 8080 proto tcp
```

**两层都要配，缺一层就等于没配**：

- **主机层**：ufw（上面这条）；
- **云厂商安全组**：多数 VPS 还有这一层，来源同样要限定为项目服务器 IP。安全组不放行时，ufw 配对了照样连不上；
  反过来只配安全组、不配 ufw，等于端口对同网段全开。

### 1.4 必须带认证 + 白名单（这条直接决定 Bo 那句「独享」成不成立）

无认证的开放代理会被全网扫描器在**几小时内**发现并当成免费出口。
后果不是"多几个人蹭带宽"，而是 —— **那个 IP 上跑的不再只有我们的流量**，
上游按 IP 计数的限流会把别人的消耗算成我们的额度，
**§14 的自动同步与 S4 标定同时失真**。所以：

> 代理必须带认证，端口必须按来源 IP 白名单。这两条不是加固项，是「独享」这个前提的**维护成本**。

### 1.5 部署完的自检（30 秒）

```bash
# 从**项目服务器**上跑：返回的 IP 应该是 VPS 的出口 IP，不是项目服务器自己的
curl -x http://sub2api:<口令>@<VPS_IP>:8080 -s https://api.ipify.org; echo
```

这条命令与下面 §4 的 `POST /api/egress/:id/test` 是同一件事 —— 后者就是把它做成后台的一个按钮。
`install.sh` 结束时会把它连同真实口令一起打出来（并提醒别粘进聊天/仓库）。

多出口时用它逐台验太慢，用 `deploy/vps-egress/pool-probe.sh`：逐节点测通、**回显出口 IP 并与清单登记的
`expected_ip` 比对**、测延迟、输出 JSON，退出码 0/1 可直接接监控。它的 `status` 已经区分
`auth_rejected`(407) 与 `ip_mismatch` —— 这两件事的排障方向相反，「连不上/口令错/IP 不对」不能混成一类。

### 1.6 多个出口 + 出口池（Bo 已拍：尽量多，按延迟最优调用）

- **加节点 = 在新 VPS 上跑同一个 `install.sh`**，然后在出口管理里登记一条。
  **结构不用改**：桶键天然按出口分账（ADR-0021 决策 8）。
- **选路在网关侧，不在 VPS 侧**：VPS 只提供出口。延迟最优、摘除、回池都是运行时逻辑
  （探测 30s / 连续 3 次失败摘除 / 回池滞回 5min），**只有一份实现**，归路由者。
- **`pool-probe.sh` 是无状态体检**：不摘除、不回池、不记忆 —— 避免和网关那套状态机长出第二事实源。
- **多出口 ⇒ 逐出口记账**：容量**不得跨出口加总回填**，S4 标定必须**从承运 key 的那个出口**打
  （在别处量到的是另一个桶）。这正是 ADR-0021 决策 8 写死的触发条件，**现在生效了** ——
  补遗 6 那份「单出口口径」的重开门槛必须按出口分别算，不是把总数除以节点数。
- **清单不只是配置**：`egress_proxies` 表是网关的事实源；`pool-probe.sh` 读的 TSV 是运维输入
  （装机自检、标定期、DB 未建档时），**不驱动网关**，见 `deploy/vps-egress/README.md §事实源`。

---

## 2. 项目侧：用户要填什么

**一行代理 URL**：`http://sub2api:<口令>@<VPS_IP>:8080`

进后台 → 出口管理 → 新建 → 填名称 / URL → 点「测试连接」→ 看到回显的**真实出口 IP** 即成功
→ 把账号（供应商账号）绑到这个出口。

改 IP 时：**只改这一个字段**，绑定关系、统计口径、前端显示的出口 id 都不用动（见 §5）。

---

## 3. 数据模型：表已经有了，零 DDL

`egress_proxies` 表与 `supplier_accounts.egress_id` 列**已在 `dev/api` 的 `src/db/schema.ts`**
（`egress_proxies` 在 `:338`，`egress_id` 在 `:320`），Tier 2 落地时按「纯加表 + 加列」写的。字段够用：

| 列 | 用途 |
|---|---|
| `id` | 稳定标识（= `egressId`，见 §5） |
| `name` | 唯一名，列表展示 |
| `url` | **只放 `scheme://host:port`，不放凭据** |
| `secret` | 代理认证，**aes-256-gcm 密文 BLOB**，与 `upstream_keys.secret` 同形（复用 `src/db/crypto.ts:69` 的 `encryptSecret`） |
| `region` / `note` | 备注（`hk` / `cn-bj` …，给用户自己看） |
| `enabled` | 停用即从候选出口里摘掉，不删数据 |

> **订正**（落脚本时回核 `src/db/schema.ts:338` 发现）：表里**没有 `revision` 列**，
> 而 §4 的 `GET`/`PUT /api/egress` 写了 `revision` 做乐观锁。两种落法二选一，S2 实现前定：
> ① 给 `egress_proxies` 加 `revision` 列（与 `supplier_accounts` 同形）；② 出口条目不做乐观锁。
> **在定之前，§4 里的 `revision` 是纸面字段** —— 不改这一句，实现时只会静默少一个字段。
>
> 另：表里 `secret` 是 `BLOB`、注释写「NULL = 免认证」，而 §1.4 的纪律是**必须带认证**。
> 两者不冲突（schema 允许，部署脚本不允许 —— `install.sh` 不给免认证的口子），但别把它读成"可以免认证上线"。

**一条要显式反转的现纪律**：ADR-0020 决策 5 写死「**`egress_id` 不进任何 DTO**」。
用户要自填、要看、要改，就必须进管理面 DTO。反转的**边界**写清楚：

- ✅ 进**管理面** DTO（`/api/egress`、供应商账号的绑定字段）
- ❌ 仍不进网关 key 面（`/v1/*`、KeyPool 视图、`/api/stats/*`）

即：**它是配置项，不是运行时可观测项** —— 与「出口状态只走 §7 帧、不走 REST」不冲突。

---

## 4. REST 契约草案（管家车道，接口先行）

统一沿用 §0.1 错误体 `{code, message, details?}`；时间 ISO8601；`secret` 只进不出。

| 方法 | 路径 | 用途 | 说明 |
|---|---|---|---|
| `GET` | `/api/egress` | 出口列表 | 返回 `{id, name, url, region, note, enabled, authSet, lastTestAt, lastTestOk, revision}`；**不含明文** |
| `POST` | `/api/egress` | 新建 | body `{name, url, username?, password?, region?, note?}`；`url` 只给 `scheme://host:port`，凭据分字段传 |
| `PUT` | `/api/egress/:id` | 改 | 任一字段改动 → `revision` 自增（沿用既有乐观锁）；**改 `host:port` 触发出口指纹变化**（§5） |
| `DELETE` | `/api/egress/:id` | 删 | 仍被账号引用 ⇒ `409 CONFLICT` + `details.refCount`；**不级联**（`egress_id` 落 `NULL` = 回宿主出口是可接受的降级，但需用户显式确认，见下） |
| `POST` | `/api/egress/:id/test` | **测试连接** | 经该代理请求一次上游轻量端点，回 `{ok, egressIp, latencyMs, error?}` —— **`egressIp` 就是 Bo 要的「填了就能通过这个 IP 出去」的证明** |

**错误码：优先复用，不新开。** 本仓对 `ERROR_CODES` 增长的克制是有记录的（多次「零新增」），
而这三种失败在既有码表里都有形状：

- 连不上 / 超时 ⇒ `UPSTREAM_UNREACHABLE`（502），`details.stage = 'egress'`
- 代理认证失败（407）⇒ `UNPROCESSABLE`（422），`details.field = 'password'`
- 仍被引用 ⇒ `CONFLICT`（409），`details.refCount`

只有当「代理认证失败」需要前端走**独立引导分支**时，才加专用码 —— 那时按 §0.4 走契约升版，不偷偷加。

**测试端点的代价**：`test` 会打上游 ⇒ 它是**管理面消费者**，走 Tier 1.5 管理面保留额度；
额度耗尽时回既有 `429 RATE_LIMITED` + `Retry-After`。**不为一个按钮新开旁路** ——
否则"点几次测试连接把客户端流量挤掉"就是 §16.7 要治的自伤的下一个形状。

---

## 5. IP 变了怎么办：稳定 `egressId` + 出口指纹

这是本提案**唯一**动到 ADR-0021 字面的地方，单独列出。

**问题**：ADR-0021 决策 2 / 决策 8 写死「**桶键 = `egressId`**」。
如果 `egressId` 就是出口地址本身，那用户一改 IP 就换了桶 —— 而实际发生的是：
**上游对我们的计数确实归零了**（新 IP 是新的额度），旧桶与新冷却**应当作废**；
但绑定关系、前端显示的 id、历史统计**不应该跟着断**。

**方案**：

- `egressId` = `egress_proxies.id`（**稳定**，绑定 / §7 帧 / DTO 全用它，永不变）
- 新增 **`egressFingerprint` = `sha256(scheme://host:port)`**（归一化：小写、含非默认端口）
- **桶键与冷却键 = `egressId` + `egressFingerprint`**

效果：用户在后台改一个 `url` 字段 ⇒ 绑定不动、帧 id 不动、旧桶与旧冷却**自动作废**、
新出口从满桶开始。**不需要管理人肉记得"改完 IP 要重置冷却"**。

**需裁定（二选一）**：

- **(a)** 按本文写「桶键 = `egressId#fingerprint`」，改 ADR-0021 决策 2/8 一句；
- **(b)** 保持「桶键 = `egressId`」字面不变，规定 PUT 改 host 时**经注入缝同步重置**桶与冷却 ——
  多一次跨车道调用，且失败模式是"忘了重置"。

**我的建议是 (a)**：纯函数式、无跨车道调用，失败模式从"状态错"降级为"多一个空桶"，安全侧。

---

## 6. 安全（我的验收面）

- **SSRF**：`url` 的 host 校验，禁 `127.0.0.0/8` / `10/8` / `172.16/12` / `192.168/16` /
  `169.254/16`（含云元数据 `169.254.169.254`）/ `::1` / `fc00::/7`。缺省只允许公网地址。
- **凭据**：明文永不落盘；响应只回 `authSet: true`；不进日志、不进 `usage_logs`、不进 §7 帧；
  `check:secrets` 增加一条「代理 URL 不含 `user:pass@`」的断言。
- **不转发**：代理认证头不得透传给上游，也不得写进调用记录。
- 本期仍是**单一管理员**填代理，不是多租户开放入口 —— 谁可填、能填几个，按现有会话鉴权走。

---

## 7. 与现有裁定的连带（诚实列出）

| # | 连带 | 影响 |
|---|---|---|
| 1 | `egress_id` 进管理面 DTO | 反转 ADR-0020 决策 5 的「不进任何 DTO」，边界见 §3 |
| 2 | 桶键加指纹 | 改 ADR-0021 决策 2/8 的字面（§5，需裁定） |
| 3 | 多出口 ⇒ 容量逐出口回填 | ADR-0021 上轮已写死这条触发条件，**正好生效**；Bo 若最终只用 1 个出口则不受影响 |
| 4 | 「每出口账号数上限 = 6」现在是**校验**不是注释 | 用户自填后由 `POST/PUT /api/egress` 与账号绑定处校验 |
| 5 | §7 帧 `egressId` 本期 = host、Tier 2 后 = 条目 id | 契约 v1.4.8 已冻结「前端不得解析其内容」，**这条纪律现在兑现了价值** —— 前端零改造 |

---

## 8. 明确不做

- ❌ 网关侧支持 SOCKS5（依赖成本 > 收益，见 §1.1）
- ❌ 出口状态走 REST（仍只走 §7 帧，契约 v1.4.9/v1.4.11 不变）
- ❌ 本期做多租户自助填代理

---

## 9. 待办

**Bo 的两问已答（2026-10-07）**：① 发行版 = **Ubuntu**，且**不用 Docker**、脚本直装；
② 出口 = **尽量多个**，做代理池、按延迟最优调用 ⇒ **逐出口记账生效**（§1.6）。
原「待 Bo」两行因此关闭；容器化那一整条作废（§1.2）。

| 谁 | 事项 | 载体 | 回执口径 |
|---|---|---|---|
| **管家** | VPS 侧三件（`install.sh` / 30 秒自检 / `pool-probe.sh`） | `dev/api` → `deploy/vps-egress/` | **已落**：参数面 6 条分支自测 + 探测脚本六种分型对假代理端到端实测 |
| **管家** | `check:secrets` 增一条「代理 URL 不含 `user:pass@`」断言（§6 承诺） | `dev/api` | 规则 + 正对照用例同批落，回命中数 |
| **管家** | `pool-probe.sh` 的清单改为可从 `GET /api/egress` 取（DB 成为唯一事实源后） | `dev/api` | S2 落 `/api/egress` 时同批改，回命令与输出样例 |
| **管家** | `src/api/routes/egress.ts` + `src/db/repo/egress.ts` + 加密复用 + SSRF 校验 + `test` 端点 | `dev/api` | S2，随契约字段表同批 |
| **路由者** | 数据面接线（`ProxyAgent` + 指纹桶键 §5 + 出口单例 + 池化选路的摘除/回池滞回） | `dev/gateway-rotation` | 按 ADR-0021 §验证 |
| **画师** | 出口管理页（列表 / 表单 / 测试连接按钮 + **出口 IP 回显** / 启用停用 / 账号绑定选择器） | `dev/web-m2` | S3 |
