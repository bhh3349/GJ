# 5. 只放行必要依赖的构建脚本（pnpm 10 供应链防护）

- 状态：已接受
- 日期：2026-10-06
- 决策者：管家 · 管理后端（G1 门禁实测）

## 背景与问题

G1 第一次执行 `pnpm install` 的结果：

```
Done in 1m 5.7s using pnpm v10.34.6

╭ Warning ──────────────────────────────────────────────────╮
│   Ignored build scripts: better-sqlite3@11.10.0,          │
│   esbuild@0.21.5, esbuild@0.28.2.                         │
│   Run "pnpm approve-builds" to pick which dependencies    │
│   should be allowed to run scripts.                       │
╰───────────────────────────────────────────────────────────╯
```

安装"成功"（退出码 0），但 **`better-sqlite3` 的原生绑定没有构建**。这是最关键的一类"假绿"：CI 会绿，直到第一次 `require('better-sqlite3')` 才炸。

pnpm 10 默认拦截依赖的 postinstall / 构建脚本，这是供应链防护（防 `postinstall` 偷跑任意代码）。方向是对的，但不能让 `better-sqlite3` 也进不来——它整个价值就在那个 `.node` 原生模块上。

`pnpm approve-builds` 是**交互式**命令，本环境（headless / 无 TTY）用不了。

## 决策

在 `pnpm-workspace.yaml` 里**显式白名单**：

```yaml
onlyBuiltDependencies:
  - better-sqlite3   # 原生 SQLite 绑定，必须构建/下载预编译产物
  - esbuild          # 二进制分发，postinstall 落盘可执行文件
```

原则：**默认拦截不变，逐个放行**。新增条目必须能说清"为什么必须构建"，否则不加。

## 被否决的方案

- **`pnpm approve-builds`**：交互式命令，headless 环境跑不了，CI 里也跑不了。
- **全局关掉脚本拦截（`ignore-scripts=false` / `enable-pre-post-scripts`）**：等于把整条供应链防护拆了，为了两个包牺牲全部依赖的安全边界，不值得。
- **改用 `--config.strict-dep-builds=false`** 之类绕过：同样是把拦截关掉，只是换个说辞。
- **接受不构建、靠运行时报错**：G1 门禁的意义就是在这里拦住，放过去等于门禁形同虚设。

## 影响

- 正面：默认拦截保持有效；`better-sqlite3` 能真正加载；白名单是显式、可审计、有注释的。
- 负面：以后每引入一个需要构建的包，都要手动加一行。这是**故意**的成本——每一次放行都是一次供应链决策，不该自动化掉。
- 门禁：G1 判据从"`pnpm install` 退出码 0"**升级**为"`pnpm install` 退出码 0 **且** `require('better-sqlite3')` 能打开一个 WAL 库"。见 `scripts/g1-sqlite-check.mjs`。
