# 出口池（VPS 侧）—— Ubuntu 直装，不用 Docker

Bo 拍板：**Ubuntu + 直接脚本装**（不用容器、不做镜像构建流水线）。
三个产物：

| 文件 | 干什么 | 跑在哪 |
|---|---|---|
| `install.sh` | 装 gost + systemd 常驻 + 认证 + 来源 IP 白名单；幂等、可卸载 | 每台 VPS |
| `pool-probe.sh` | 出口池体检：逐节点测通、回显出口 IP、测延迟、输出 JSON | 项目服务器（或任意能连到这些出口的机器） |
| `nodes.example.tsv` | 节点清单格式（示例）。真清单不进仓库 | — |

方案背景与契约草案：`docs/proposals/egress-proxy-onboarding.md`。

---

## 1. 为什么是这套（三条定死的，不是偏好）

1. **HTTP CONNECT 代理，不是 SOCKS5。** 网关侧是 Node 原生 `fetch`，按请求注入 `dispatcher`
   走 HTTP 代理是原生支持的；SOCKS5 得换掉 fetch 栈，与「stream 透传不缓冲」冲突。
   （订正：`ProxyAgent` 不是 `node:` 内置，需**加一个运行时依赖** —— 但**不换栈**，结论不变。）
2. **必须带认证 + 来源 IP 白名单。** 无认证的开放代理数小时内会被扫描器抓走。
   一旦有别人的流量从这个 IP 出去，「这个出口的额度 = 我们的额度」当场破掉 ——
   S4 标定与 §14 自动同步同时失真。所以脚本**不允许**免认证启动，也**要求**至少一条 `--allow`。
3. **不用 Docker。** 单二进制 + systemd 就够了，少一层要维护的东西。

---

## 2. 每台 VPS 装一次（约 1 分钟）

```bash
# ① 取官方包摘要（在没有被墙的机器上跑）
curl -fsSL -o /tmp/gost.tar.gz \
  https://github.com/go-gost/gost/releases/download/v3.0.0/gost_3.0.0_linux_amd64.tar.gz
sha256sum /tmp/gost.tar.gz

# ② 在 VPS 上装（把 <摘要> 换成上一行的输出，<项目服务器出口IP> 换成项目那台的公网 IP）
sudo GOST_SHA256=<摘要> ./install.sh --allow <项目服务器出口IP>/32
```

脚本**没有摘要就拒绝下载安装** —— 这是故意的：装一个来路不明的二进制到出口上，
等于把整条链路的流量交出去。已有二进制时重跑会复用，不会重复下载。

结束时会打印：后台要填的 URL、以及 30 秒自检命令。

### 30 秒自检（在**项目服务器**上跑，不是 VPS 上）

```bash
curl -x http://<用户>:<口令>@<VPS_IP>:8080 -s https://api.ipify.org; echo
```

返回 **VPS 的 IP** 就通了（返回项目服务器自己的 IP = 没走代理）。
这条与后台「测试连接」按钮是同一件事，后者会回显真实出口 IP。

---

## 3. 多出口 / 出口池

- **加一个节点** = 在新 VPS 上跑同一个 `install.sh`，然后在项目侧登记一条出口。
  **结构不用改**：桶键天然按出口分账（ADR-0021 决策 8）。
- **延迟最优选路**：运行时逻辑在网关侧（路由者），不在 VPS 侧。VPS 只提供出口，不做选路。
- **本脚本不做状态机**：`pool-probe.sh` 是**无状态**体检 —— 不摘除、不回池。滞回参数
  （探测 30s / 连续 3 次失败摘除 / 回池 5min）是运行时的事，只有一份实现，在网关侧。
- **多出口 ⇒ 逐出口记账**：容量不能跨出口加总回填，标定也必须**从承运 key 的那个出口**打
  （在别处量到的是另一个桶）。这是 ADR-0021 决策 8 写死的触发条件，现在生效了。

### 节点清单

```bash
sudo install -m 600 /dev/null /etc/sub2api/egress-nodes.tsv
sudo cp nodes.example.tsv /etc/sub2api/egress-nodes.tsv   # 再填真值
./pool-probe.sh --nodes /etc/sub2api/egress-nodes.tsv --repeat 3 --json
```

格式（TSV）：`name<TAB>proxy_url<TAB>expected_ip(可空)<TAB>region(可空)`。
`expected_ip` 填了就做**回显校验** —— 对不上会报 `ip_mismatch`，这是「填了 IP 就真从这个 IP 出去」的证明。

`status`：`ok` / `ip_mismatch` / `auth_rejected`(407) / `proxy_unreachable` / `proxy_dns_failed` /
`timeout` / `tls_error` / `bad_response` / `error` / `skipped`。
退出码 `0` 全健康、`1` 有节点不健康 —— 可直接接进监控。

**为什么 `auth_rejected` 和 `ip_mismatch` 必须分开**：这两件事的排障方向相反（一个去查口令，一个去查
这个 URL 到底走没走这个出口）。实测踩过：明文 HTTP 目标的 407 会作为**正常响应体**回来、curl 退出码为 0，
不按状态码单独判一次，就会把「口令错」误报成「回显 IP 不对」。

---

## 4. 事实源（避免长出第二份配置）

| 问题 | 答案 |
|---|---|
| 网关用哪些出口？ | **`egress_proxies` 表**（走 `/api/egress`）。这是唯一事实源。 |
| 那 TSV 算什么？ | **运维输入**：装机自检、S4 标定期、DB 尚未建档时的一次性清单。它**不驱动**网关。 |
| 会不会双写？ | 会 —— 所以脚本**不维护状态、不写回任何地方**，只读清单、只输出体检结果。 |

---

## 5. 安全与运维

- **凭据**：口令在 VPS 上由 `openssl rand -hex 16` 生成（128 位，字符集只有 `[0-9a-f]`，
  天然避开 URL / systemd / shell 转义坑），只落 `/etc/sub2api/egress-proxy.env`（600 root:root）。
  systemd 单元里只有 `${变量名}`，真值走 `EnvironmentFile` ⇒ `systemctl cat` 也看不到口令。
  口令**不入仓库、不进聊天、不进日志**。
- **轮换**：`sudo ./install.sh --rotate --allow <CIDR>` ⇒ 换口令后同步改后台的出口条目。
- **防火墙**：脚本**只加 allow 规则，不擅自改默认策略、不擅自 `ufw enable`** ——
  一把 enable 是有可能把自己关在门外的。`ufw` 未激活时退出码 `3` 并在结尾给出两种收尾方式；
  `--enable-firewall` 会在 enable 前先放行当前 SSH 来源。
  另：多数云厂商还有**安全组**这一层，它不放行的话 ufw 配对了照样连不上 —— 来源仍要限定项目服务器 IP。
- **systemd 加固**：`NoNewPrivileges` / `CapabilityBoundingSet=` 空 / `ProtectSystem=strict` /
  `PrivateTmp` / `SystemCallFilter=@system-service`。若服务起不来，`journalctl -u egress-proxy -n 50`
  通常会指向加固项，把对应那行注释掉再 `daemon-reload`。
- **卸载**：`sudo ./install.sh --uninstall`（连二进制一起删加 `--purge`）。
  ufw 规则不自动删，脚本会提醒手工核对。

---

## 6. 开放待办（R1：owner + 载体 + 回执口径）

| 事项 | owner | 载体 | 回执口径 |
|---|---|---|---|
| `check:secrets` 增一条「代理 URL 不含 `user:pass@`」断言（提案 §6 已承诺） | 管家 | `dev/api` | 规则 + 正对照用例同批落，回 `check:secrets` 命中数 |
| `pool-probe.sh` 的清单改为可从 `GET /api/egress` 取（DB 成为唯一事实源后） | 管家 | `dev/api` | S2 落 `/api/egress` 时同批改，回命令与输出样例 |
| 网关侧代理接线 + 指纹桶键 + 出口单例 | 路由者 | `dev/gateway-rotation` | 按 ADR-0021 §验证 |
