# 2. 管理面与前端同源，会话鉴权走 HttpOnly Cookie

- 状态：已接受
- 日期：2026-10-06
- 决策者：管家 · 管理后端、画师 · 前端、路由者 · 网关内核、PM（拍板）

## 背景与问题

管理端需要一个会话机制，同时前端（React SPA）要调管理 API、还要开 WebSocket 收实时统计。

备选：
- **A. token 放 localStorage，请求头 `Authorization: Bearer`**：最省事的经典做法。
- **B. 前后端同源，token 放 HttpOnly Cookie**：要处理 CSRF。

## 决策

选 **B**，并把它和端口布局绑死：

- 管理面 API 与构建后的 SPA 由**同一个监听器**（`:4001`）提供，同源。前端在 `:4001` 上直接发 `/api/*`，不经过跨域。
- 会话 token 走 **`HttpOnly` + `SameSite=Lax` Cookie**（生产再加 `Secure`、host-only）。前端 JS **读不到 token**。
- **REST 与 WS 握手都由浏览器自动带 Cookie**。WS 首帧发 `{type:"auth"}`，**只作就绪确认、不传 token**；5s 内未就绪则断开。
- **CSRF 三层校验，顺序固定**：`Origin` → `Sec-Fetch-Site`（缺失则跳过）→ `X-Requested-With`（仅浏览器发起的写请求）。拒绝一律 `CSRF_REJECTED` (403)。
- `ALLOWED_ORIGINS` 由 env 驱动。**CORS 不得对任意 Origin 反射 `Allow-Credentials`**。
- `ADMIN_TOKEN` 默认关闭，仅作 CI 机器令牌，不参与浏览器流程。

WS 关闭码约定：

| code | 含义 | 前端动作 |
|---|---|---|
| `4401` | 会话失效 | 跳登录页 |
| `4408` | 就绪超时 | 重连一次 |
| `1012` | 服务重启 | 退避重连 |

## 为什么不用 localStorage

- XSS 一旦命中，`localStorage` 里的 token 直接被读走，且能长期重放；HttpOnly Cookie 读不到。
- WS 场景下方案 A 要把 token 塞进 URL query 或首帧 —— URL 会进日志和 Referer，首帧方案等于把 token 交给 JS 拼装，等于没有 HttpOnly 的收益。
- 同源 Cookie 让 REST 与 WS 共用一套凭据，不需要维护两套 token 传递路径。

## 为什么接受 CSRF 复杂度

同源 + Cookie 天然带 CSRF 面。三层校验里 `Sec-Fetch-Site` 由浏览器强制写入、脚本改不了，是主防线；`Origin` 覆盖老浏览器；`X-Requested-With` 要求写请求非简单请求，挡住表单跨站提交。三层成本低、无额外依赖，比引入 CSRF token 往返更简单。

## 影响

- 正面：token 对 JS 不可见；REST/WS 一套凭据；无跨域预检开销。
- 负面：必须有 CSRF 校验；纯 HTTP 部署时 `COOKIE_SECURE=false`，此时管理口**必须绑内网 / `127.0.0.1`**，不能暴露公网。
- 反向代理终止 TLS 时需 `COOKIE_SECURE=true` + Fastify `trustProxy`，否则 Secure Cookie 发不出去。
- 生产 SPA 用 `@fastify/static` + catch-all 回退 `index.html`，保证刷新子路由不 404。
