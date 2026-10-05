# 4. pnpm 锁 10.34.6，不跟随 latest

- 状态：已接受
- 日期：2026-10-06
- 决策者：管家 · 管理后端（D0 仓库化，G1 门禁实测）

## 背景与问题

D0 要求为 Node 22 启用 pnpm（经 Corepack）并**精确锁定 `packageManager` 版本**。首次执行 `corepack use pnpm@latest` 后，锁到 `pnpm@12.9.1`，但随即失败：

```
Error: Cannot find module
  C:\Users\Administrator\AppData\Local\node\corepack\v1\pnpm\12.9.1\bin\pnpm.cjs
```

排查结论：**包体已完整下载到 corepack 缓存**（`bin/pnpm.mjs`、`dist/` 均在），失败点不在网络，而在 shim 与 payload 的入口文件名不匹配。实测三个版本的 `bin` 字段：

| pnpm | `bin` 声明 | 与 corepack 0.34.0 | 备注 |
|---|---|---|---|
| 10.34.6 | `{"pnpm":"bin/pnpm.cjs"}` | ✅ 兼容 | Node `>=18.12` |
| 11.28.2 | `{"pnpm":"bin/pnpm.mjs"}` | ❌ shim 找 `.cjs` | Node `>=22.13` |
| 12.9.1 | `{"pnpm":"pnpm"}`（原生 wrapper） | ❌ shim 找 `.cjs` | 直接 `node bin/pnpm.mjs -v` 无输出 |

而本机 corepack 是随 Node 22.22.0 自带的 **0.34.0**，其生成的 shim 写死了 `bin/pnpm.cjs`。即：**pnpm ≥ 11 改了入口文件名，corepack 0.34.0 不认识。**

## 决策

`packageManager` 锁 **`pnpm@10.34.6`**（10.x 线最新），并带 integrity 摘要：

```json
"packageManager": "pnpm@10.34.6+sha512.7e1ae66a83a9143c118cc1944f37cc4f2b8acddeda4b001cfa78908f6e46e45e15292739ca6c9d026426cc757e9318cc98c5551d6a16c165097b0028ba87b4e6"
```

注意：corepack 的摘要格式是 `+sha512.<hex>`，与 npm registry 的 `sha512-<base64>` **不同**，需转换（base64 → hex）。直接照抄 registry 的 base64 形式会报
`Invalid package manager specification ... expected a semver version`。

## 被否决的方案

- **锁 pnpm 12.x / 11.x（跟随 latest）**：与随 Node 自带的 corepack 0.34.0 不兼容，本机直接跑不起来。
- **升级 corepack 到支持 `.mjs` 的版本**：会改动 `C:\Program Files\nodejs\` 下的全局 shim，且本机 PATH 里的 `pnpm` 实际来自 Hermes 运行时目录（`.hermes-web-ui/desktop-runtime/hermes/0.21.5/win-x64/node/pnpm`），是宿主管理的目录——改它属于越界，还会与宿主的 Node 分发打架。
- **绕过 corepack，`npm i -g pnpm`**：破坏"`packageManager` 精确锁版 + `--frozen-lockfile`"的既定纪律，且全局装的位置同样可能被宿主覆盖。
- **用 npm 代替 pnpm**：既定决策已选 pnpm，且 pnpm 的严格依赖隔离对本项目有意义。

## 影响

- 正面：本机开箱即用，无需改全局环境；`packageManager` 仍是精确锁版 + 完整性校验；CI（Linux）用同一份锁定。
- 负面：**项目被钉在 pnpm 10.x 线**。上游 Node 升级带动 corepack 升级后，方可评估迁移到 11/12；迁移时必须同步更新本 ADR 与 `packageManager` 摘要。
- 门禁：CI 用 `pnpm install --frozen-lockfile`，锁文件与 `packageManager` 不一致即失败。
