# 1. 终端与脚本基线统一为 Git Bash + 跨平台 npm scripts

- 状态：已接受
- 日期：2026-10-06
- 决策者：管家 · 管理后端（D0 仓库化）、PM（拍板）

## 背景与问题

本机实测环境：Node `v22.22.0`、npm `10.9.4`、git `2.56.0.windows.1`、corepack `0.34.0`（随 Node 22 自带）、PowerShell 仅 5.1（无 pwsh 7）。

实测到的两个硬事实：

1. Git Bash 可运行（`C:\Program Files\Git\bin\bash.exe`，GNU bash 5.3.15），**但不在 PATH** —— PATH 里只有 `Git\cmd`。
2. 本机 `npm run` 实际走 `cmd.exe`。带 POSIX 语法的 script 会直接失败；`npm run --script-shell=bash` 报 ENOENT（因为 bash 不在 PATH）。

这意味着：如果脚本写成 bash 语法，本机会挂；如果依赖 bash 做构建，CI（Linux）与本机行为会分叉。

## 决策

采用**双层基线**：

- **终端**：人/AI 交互统一用 Git Bash，通过终端 profile 指向 `C:\Program Files\Git\bin\bash.exe`，**不修改全局 PATH**（避免影响用户其它工具链）。
- **脚本**：`package.json` 里的 script **一律写成跨平台形式** —— 不用 `&&`、`$(...)`、`rm`、`cp`、引号假设。需要多步就写成 Node 脚本或拆成多个 script。
- **PowerShell 5.1** 仅保留给 Windows 原生操作（进程、端口、服务、注册表），不参与构建与测试。
- **行尾**：`.gitattributes` 锁 `eol=lf`，`git config core.autocrlf false`，消除 CRLF 干扰。

## 被否决的方案

- **改全局 PATH 把 Git Bash 加进去**：改动用户机器全局状态，副作用超出项目边界。
- **`--script-shell=bash`**：实测 ENOENT，因为 bash 不在 PATH；若为此去改 PATH 又回到上一条。
- **全部改用 PowerShell script**：CI 跑 Linux，行为分叉，且 pwsh 7 未装，PS 5.1 语法受限（无 `&&`、无三元）。
- **装 pwsh 7**：引入额外依赖，收益不抵成本——跨平台 script 写法本身就能解决问题。

## 影响

- 正面：本机与 CI 走同一条脚本路径，不依赖 shell 差异；用户机器全局环境不变。
- 负面：写 script 时不能用 shell 惯用语法，多步流程要落到 Node 脚本里，略啰嗦。
- 后续约束：CI 必须在 Linux 上跑 `pnpm test`，作为跨平台写法的强制门禁。
