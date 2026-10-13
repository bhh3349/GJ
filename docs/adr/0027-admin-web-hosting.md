# ADR-0027：管理面同源托管前端产物（@fastify/static + SPA fallback）

- 状态：已接受（2026-10-14）
- 关联：契约 v1.12.0 §17；`docs/开发约束-v0.1.md` §155（「生产环境部署」明列管理面要托管构建产物，此前未实现）
- 车道：管家（`src/api/` + `src/config.ts` + `.env.example`）；画师零改动需求

## 背景

PM 的交付链探查（2026-10-14）指出缺口 3：管理面没有托管前端产物。依赖里没有
`@fastify/static`，`GET :4001/` 回 JSON 404。开发态靠 Vite dev server（:5173，
`/api` 代理到 :4001），但生产没有任何 UI 入口 —— 运营者进不了自己的后台。

## 决策

1. **同源托管**：管理面（:4001）同时服务 `/api/*` 与前端静态产物，`GET /` 即控制台。
   与开发态 Vite 的「同源代理」口径一致（Cookie 不跨域、WS `/api/stats/live` 同源升级）。
2. **注册顺序**：`buildApp` 内先注册全部 `/api/*` 路由，静态托管**最后**注册。
   Fastify 路由按注册序匹配，`/api/*` 永远先于静态命中。
3. **插件形态：`wildcard: false`（逐文件路由），不取 `wildcard: true`（`/*` catch-all）**。
   实测（2026-10-14，`@fastify/static` 8.3.0）：
   - `wildcard:true` 在 `setNotFoundHandler` **之前**注册 `GET /*`，会把 `/keys`、
     `/v1/*` 等**所有 GET 未命中路径**先吃进静态处理器再落 `callNotFound()` ——
     网关面 `/v1/*` 的 404 形状（`{"error":{…}}`）与管理面的 `{"code":"NOT_FOUND",…}`
     都会被静态处理器的 not-found 路径覆盖，行为面不可控；
   - `wildcard:false` 只为 `dist` 里**真实存在**的文件注册精确路由：`/`、`/index.html`、
     `/assets/*`。SPA 深链路由（`/keys`、`/logs`…）由**应用级 `setNotFoundHandler`**
     兜底：非 `/api`、非 `/v1` 的 GET 未命中 → `reply.sendFile('index.html')`（200 SPA）。
   - 新增一条「**静态兜底只兜非 `/api` 非 `/v1` 的 GET**」的应用级闸：任何非 GET 方法、
     `/api/*`、`/v1/*` 未命中一律维持既有 JSON 404（`{"code":"NOT_FOUND",…}`）。
     `assertAdminPath()` 前端护栏（永不允许拼 `/v1` 前缀）继续有效，本笔不改前端。
4. **root 来源：新可选 env `ADMIN_WEB_DIST`（`AppConfig.adminWebDist`）**：
   - **默认 `null` = 托管关闭**，行为与改动前**逐字节相同**（`GET /` → 既有
     `{"code":"NOT_FOUND"}` 404）；生产在 `.env` 里 `ADMIN_WEB_DIST=web/dist` 显式打开
     （相对路径按进程 cwd 解析）。
   - **刻意不做「探测 `web/dist` 存在就托管」**：仓库里 `web/dist` 是长期存在的构建产物，
     一探测就会让**测试进程**意外开启托管（用例 cwd 即仓库根），真实 `index.html` 被塞进
     `inject` 响应，断言随构建产物漂移 —— 一个部署开关变成测试环境依赖。所以默认关闭，
     既有的 8 个 spec 零行为变更（它们不配这一项）。
   - 目录不存在时**不 fail-fast**：启动只打 warn（`vite build` 没跑是常态，不拦后端启动），
     托管退化为「注册 0 条静态路由 + 兜底退化为 404」（实测 `wildcard:false` 在 root 缺失
     时安全退化，不炸 ready）—— 这是可诊断的配置错误，不能静默。
5. **缓存纪律**：`index.html` 不缓存（SPA 入口必须每次校验，否则新版本发不出去）；
   带指纹的 `/assets/*`（Vite 产物文件名自带内容 hash）长缓存 `maxAge=30d, immutable`。
6. **资产目录遍历**：`@fastify/static` 自带 root 约束（`/../package.json` → 404，实测）；
   资产目录经 `path.resolve` 归一，防拼接路径逃逸。
7. **`sendFile` 兜底**：注册在路由清单末尾 + notFound 处理器内部。插件关闭或产物缺失时
   `sendFile` 自动退化为 404（实测），无需运行时探测文件存在性。

## 后果

- 生产形态：`pnpm web:build` → `ADMIN_WEB_DIST=web/dist`（或默认探测到 `web/dist`）→
  `PORT_ADMIN` 一个入口同时给 API 与控制台。
- 测试进程零影响：`makeConfig()` 不配 `adminWebDist` ⇒ 托管关闭 ⇒ 全部既有 spec 行为不变。
- `restart-dev.ps1` 的活体验证、四闸、红线扫均不受影响（开发态仍走 Vite :5173）。
- 画师零改动：`API_BASE` 钉死同源相对路径（既有硬约束），生产同源后 Cookie/WS 语义不变。
