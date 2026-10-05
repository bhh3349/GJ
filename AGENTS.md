# AGENTS.md — 唯一守则入口

本项目所有 AI/人协作守则只写在这里。`CLAUDE.md` 只做 import，不重抄。
原则：**只写读代码猜不到的东西**。能从代码、`tsconfig`、CI 看出来的，不写在这里。

---

## 1. 终端基线（强制）

- 统一 shell：**Git Bash** — `C:\Program Files\Git\bin\bash.exe`。它不在 PATH 里，用终端 profile 指向它，**不要改全局 PATH**。
- `npm run` / `pnpm run` 的 script **必须跨平台写法**：不得使用 `&&` 串接、`$(...)`、`rm -rf`、`cp`、单引号包裹等 shell 语法，否则在 cmd.exe 下必挂。
- **PowerShell 5.1 只用于 Windows 原生操作**（进程、端口、服务、注册表）。本机没有 pwsh 7。
- 行尾一律 LF（`.gitattributes` 已锁），`core.autocrlf=false`。

## 2. 网络工具（环境限制）

本机模型经 OpenAI 兼容网关接入，**DeepSeek 不支持 Claude 服务端 `WebSearch`**，调用会直接返回
`400 invalid request: tools[0].input_schema is required`。

- **禁止调用 `WebSearch`**。要联网就用 `WebFetch` 抓具体 URL。
- 不知道抓哪个 URL 时，直接问用户要链接，别硬搜。

## 3. 契约先行（强制）

- `docs/api-contract.md` 是**唯一接口事实源**。契约未冻结，不写任何调用方代码。
- `/v1/*` 错误体是 OpenAI 形状 `{error:{message,type,code}}`；`/api/*` 错误体是 `{code,message,details?}`。两套不能混。
- 统一口径：**金额 = 分 (int)**，**token = int**，**时间 = ISO8601 UTC 字符串**。别用 float 存钱，别用本地时间。

## 4. 安全红线（强制，CI 会扫）

- **key 明文永不落盘**：不落 SQLite、不落日志、不落错误信息、不落 git。对外一律 `****后4位`。CI 有扫描断言。
- `MASTER_KEY` 缺失或 base64 解码后不是 32 字节 → **拒绝启动**，不允许降级或自动生成。
- `/api/*` 除 `auth/login` 外**全量鉴权**，无例外列表。
- 会话 token 只存 sha256 摘要，明文仅在登录响应出现一次。

## 5. 数据写入（强制）

- **单写者原则**：SQLite 单连接写。全部写操作串行。
- **热路径零同步 DB 写**：`/v1/*` 转发路径上的日志与用量走异步批量落库，不许 `db.prepare().run()` 挡在 TTFB 前面。
- 管理端改 key 必须递增 `revision`；网关靠 `change_log` + 1s 轮询兜底同步。

## 6. 前端（强制）

- **禁止假数据**。禁止用 mock 证明功能完成，禁止生产构建里有 mock 兜底。DoD 必须是真接口自测。
- 只调用 `docs/api-contract.md` 定义的管理 API，**不改网关内部实现**。契约有疑问问管家。

## 7. 流程

- 一人一分支 + 一人一 worktree（ADR-0007）：`dev/api`（管家）、`dev/gateway-m3`（路由者）、`dev/web-m2`（画师）、`dev/infra`（基建/收口）。
- 新工作一律从**当前 `main`** 起开分支；`main` 只进快进，不合并不动共享检出 HEAD。
- **禁止裸 `update-ref`**（触发案例：M3 适配层合流前，一次裸 `update-ref` 差点把 flusher + 冷却阶梯
  修复静默回滚，14 个文件）。它只挪分支指针，**不动 HEAD / index / 工作区**：于是 `git status` 会把
  "工作区落后于新 tip" 显示成一大片反向改动，此时一次误提交或一次 `checkout --` 就把新 tip 的内容
  抹掉了，而表面完全看不出异常。规则：
  - 在**已 checkout 该分支的 worktree 内**，一律禁止裸 `update-ref`。快进走
    `git merge --ff-only <tip>`（或 `checkout` / `reset --hard <tip>`），让 HEAD + index + 工作区
    **一起**移到新 tip。
  - `main` 没有专属 worktree，仍可用三参 CAS `git update-ref refs/heads/main <new> <old>`（带旧值做
    compare-and-swap，防并发覆盖）；执行完必须核 `git rev-parse main^{tree}` 与目标 tip 的 tree 一致。
  - **合流后 `git status --porcelain` 为空才算收口**（R1：合并 ≠ 收口）。非空说明指针与工作区没同步，
    这时报"已合流"是假回执。回执里带上新 tip 与空 status 两样。
- Conventional Commits。不装 husky，门禁走 CI。
- 决策记录写 `docs/adr/`（MADR 格式，`NNNN-标题.md`），不要只留在聊天记录里。
- 长代码不写进 `AGENTS.md`；守则短写，写「读代码猜不到」的部分。

## 8. 架构边界

| 目录 | 归属 | 内容 |
|---|---|---|
| `src/gateway/` | 路由者 | `/v1/*`、KeyPool、转发、限流、故障切换 |
| `src/api/` | 管家 | `/api/*` 管理面 REST 与 WS |
| `src/db/` | 管家 | SQLite schema、加密存储、统计聚合 |
| `web/` | 画师 | React + Ant Design 管理后台 |

跨边界改动先改契约，再改代码。

## 9. 接力纪律（R1「接力不掉棒」，强制）

触发案例：M3 适配层（`/v1/*` 挂载 + 四 port 适配 + `/internal/snapshot` 注册）在交接中被静默丢下 ——
报备人写了「随后我再提交」，但没有 owner、没有载体、没有回执口径，接力棒移交给下一棒后它就成了悬空待办。
**报备不等于交接**，这是本条的由来。

- **报备即锚定**：回执/报备里出现的每一项「待办 / 缺口 / 后续步骤」，必须同时给足三要素 ——
  **owner（具体 Agent）** + **载体（分支名 + worktree）** + **回执口径（回什么、何时回）**。
  禁止用「随后我再做」「以后再说」等无追踪表述带过；缺任一项视为未报备，不计入已交接。
- **移交要点名**：交接棒时移交方逐条点名未完成项 + 新 owner + 回执口径；收棒方必须**复述自己接住了什么**，不复述即视为未移交。
- **合并 ≠ 收口**：分支合流只代表代码落位，不代表里程碑完成。里程碑的开放待办由 owner 单独回执关闭，未回执前一直挂在开放清单上。
- **核对方**：PM 每次合并/派发回执时核对有无被丢掉的项，丢一项当场点名补回。
