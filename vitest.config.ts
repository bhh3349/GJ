import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只收 src/ 下的测试。
    //
    // 为什么显式写死而不是用默认值：本仓库三个人共用 `C:\WorkSpace\sub` 一个工作区，
    // 根目录下会临时出现 git worktree / 检出处（`.worktrees/`、`.ekko-tmp/wt-*`）。
    // vitest 默认的可变路径会把副本里的 spec 一起收走，后果不只是"重复跑"：
    // 副本里的 plaintext-scan.spec.ts 用 import.meta.url 反推仓库根，
    // 反推出来的是**副本自己**，扫描范围从 66 个文件缩水到 7 个 —— 判据静默失效。
    // 真踩过一次：`pnpm test` 报 `expected 7 to be greater than 20`。
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'web/**', '.worktrees/**', '.ekko-tmp/**'],
  },
});
