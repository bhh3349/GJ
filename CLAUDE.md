# CLAUDE.md

@AGENTS.md

> 守则正文只在上方 import 的 `AGENTS.md`，此处不重抄。本文件只做两件事：指路 + 压缩约定。

## 按需知识库 —— 不要一上来就读完整个仓库

细节在 `.claude/skills/sub-gateway/`。**先想清楚要哪一块，只读对应文件**：

| 要干的事 | 读哪个 |
|---|---|
| 起实例 / 发管理面请求 / 查错误日志 / 直接翻库 | `references/ops-manual.md` |
| 部署到容器或云服务器 / 备份 / 镜像搬运 / 裸 IP 安全 | `references/deploy-ops.md`（权威全文 `deploy/docker-deploy.md`） |
| 查契约（约 4.7k 行的 `docs/api-contract.md`） | `references/contract-index.md` 拿行号，再定点读 |
| 不知道某个功能在哪个目录 / 热路径约束 | `references/module-map.md` |
| 想知道"当初为什么这么定" | `references/adr-index.md`（42 份 ADR 的一行表，点名了才读全文） |

**知识库维护是 DoD 的一部分（业主定的纪律）**：这轮活只要动了 `docs/api-contract.md`、新增/改写了 ADR、
或移动了模块职责，就**在同一批工作里**回改对应的 `references/`（行号表 / 一行表 / 模块地图），
不等"想起来"。索引失准比没有索引更坏 —— 它会指向错的地方。

## 检索习惯（省 token 优先）

1. 找符号/字符串用 Grep；读文件时用 offset/limit 只读命中段落，别整文件读。
2. 大范围调研（"这个字段在哪些地方被写"）交给 Explore 子代理，只回收结论。
3. 契约问题：先查 `contract-index.md`，再 `sed -n '起,止p' docs/api-contract.md`。
4. 换一个无关任务时 `/clear`；判断依据是上下文里塞满了已作废的失败尝试。

## 压缩约定（/compact 时必须保留）

- 当前分支 + worktree 路径 + 未提交改动的意图
- 本会话**已验证**的结论（命令 + 结果）；没验证的猜测要显式标注为猜测
- 开放待办：owner + 载体（分支/worktree）+ 回执口径（AGENTS.md §9）
