---
name: sub-gateway
description: sub-gateway 项目（OpenAI 兼容多上游 key 池网关）的仓库知识库：本地测试实例运维（起停/发管理面请求/查错/翻库）、docs/api-contract.md 章节行号索引、模块职责与热路径约束、41 份 ADR 一览。当需要跑或调本地实例、手发管理面 curl、查错误事件/用量、定位某个功能在 src 哪个目录、或为契约/ADR 找出处时使用。不替代 AGENTS.md 的守则，只提供"读代码猜不到"的事实。
---

# sub-gateway 仓库知识库

三件事：**先读哪块、怎么查、纪律在哪**。守则全文在仓库根的 `AGENTS.md`（本技能不重抄）。

## 按需取用

| 需求 | 文件 |
|---|---|
| 起停实例、管理面 curl、错误事件/日志、直接查 SQLite | `references/ops-manual.md` |
| `docs/api-contract.md`（约 4,756 行 / 120 个标题，当前 v1.17.1）章节 → 行号 | `references/contract-index.md` |
| `src/` `web/` 目录职责、关键文件、热路径红线 | `references/module-map.md` |
| ADR-0001…0041 一行表（含"什么时候必须去读它"） | `references/adr-index.md` |

## 三条最容易踩的检索纪律

1. **不要整读契约**。约 4,750 行。先到 `contract-index.md` 找行号，再 `sed -n 'A,Bp' docs/api-contract.md`。
2. **不要整读 ADR 目录**。41 份约 7,200 行。`adr-index.md` 一行一份；只有被现行问题直接点名时才读那一份全文。
3. **不要用 Read 扫源码**。`src/` 非测试代码约 3 万行。先用 Grep 定位 `文件:行`，再 Read 带 offset/limit 的窗口。

## 触碰代码前必须知道的边界（详见 AGENTS.md）

- 契约先行：`docs/api-contract.md` 是唯一接口事实源，跨边界改动**先改契约 + ADR，再改代码**。
- 目录归属：`src/gateway/` 路由者、`src/api/` + `src/db/` 管家、`web/` 画师。
- 安全红线：key 明文永不落盘/落日志/落错误/落 git；`MASTER_KEY` 缺失即拒绝启动。
- 单写者 + 热路径零同步 DB 写：`/v1/*` 转发路径上不许 `db.prepare().run()` 挡在 TTFB 前面。
- 前端禁止 mock 兜底；DoD 必须真接口自测。
