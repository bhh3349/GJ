# 网关内核开发约束 v1.0

> 作者：路由者 · 网关内核 ｜ 状态：**同意 PM 派发方案，随整包待 Bo 终审**
> 定位：M0 交付物之一（PM 派发），网关侧开发约束 + KeyPool 接口冻结件
> 唯一依据：`需求文档-v1.1.md` §四 / §二 / §三；REST 契约以 `docs/api-contract.md`（管家产出）为准
> 边界：本文只含约束与**接口签名**，不含任何实现代码（契约未冻结不写实现，含不写调用方代码）

---

## 〇、对 PM 派发方案的逐项表态

| # | 派发项 | 路由者表态 |
|---|---|---|
| 1 | 终端基线 = Git Bash 为主，PowerShell 仅 Windows 原生操作 | **同意**（附前置动作 A1） |
| 2 | 包管理器 = pnpm（Corepack 启用 + `packageManager` 锁版本） | **同意**（附前置动作 A2/A3 与自检 G1） |
| 3 | Node 22 LTS + TypeScript strict | **同意** |
| 4 | KeyPool 三方法签名 + 5 类失败原因枚举 | **同意**；签名细化 2 处，见 §三/§七 |
| 5 | 契约边界（`/v1/*` vs `/api/*`）、单写者、热路径零同步写 | **同意**，沿用 v1.1 已收敛口径，见 §五 |

**无反驳项。** 本文件对所有争论项均为「同意 + 证据/前置条件」，未提出需要重新拍板的异议。

---

## 一、终端与环境基线（含路由者侧独立实测）

本机实测（2026-10-05，路由者侧复测，与画师侧结论一致）：

| 项 | 实测值 |
|---|---|
| Node | `v22.22.0` |
| npm | `10.9.4` |
| git | `2.56.0.windows.1` |
| corepack | `0.34.0`（随 Node 22 提供，`corepack enable` 即可启用 pnpm） |
| pnpm | **未安装** |
| Git Bash | `C:\Program Files\Git\bin\bash.exe`，`GNU bash 5.3.15`（`bash -lc` 实测可用） |
| PATH 现状 | 只有 `C:\Program Files\Git\cmd`（含 `git.exe`）→ **`bash.exe` 确实不在 PATH**；需绝对路径才能调用 |

**基线**：Git Bash 为工程主 shell；PowerShell 保留 Windows 原生用途（端口/进程/服务/后台驻留）。
无论 shell 选谁，**`package.json` scripts 是唯一正式入口**（与 shell 无关），这是底线。

**前置动作**

| # | 动作 | 负责 | 验收证据 |
|---|---|---|---|
| A1 | 将 `C:\Program Files\Git\bin` 加入**用户** PATH（不动系统 PATH） | 画师 | `bash --version` 实测输出 |
| A2 | 仓库内 `packageManager` 字段锁定 pnpm 精确版本 | 管家（M0 D0 仓库化） | `package.json` + lockfile 入库 |
| A3 | `corepack enable`（**无需额外安装**，corepack 0.34.0 已随 Node 22 提供） | 全员本机 | `pnpm -v` 与锁定版本一致 |

**硬规则**（与管家 §1 一致，网关侧同样适用）
1. scripts 禁任何 shell 语法：环境变量用 `cross-env`、删目录用 `rimraf`、复杂逻辑落 `scripts/*.mjs`；禁 `VAR=x cmd` 前缀写法；不写 `.npmrc` 的 script-shell。
2. 路径一律正斜杠；Node 内用 `node:path` 拼接。
3. `.gitattributes` 锁 `* text=auto eol=lf`（sh 脚本混入 CRLF 会在 Git Bash 下报 `\r` 错误）。
4. 密钥只走 `.env`（不入库），仓库只留 `.env.example`；任何文档/日志不回显 secret。
5. **导入路径大小写必须与真实文件名严格一致**（Windows 能过、Docker 会挂）。

---

## 二、Node 与包管理器

1. **Node 22 LTS**（本机 22.22.0），`engines` 同时锁 node 与 pnpm 版本区间。
2. **TypeScript `strict: true`**，禁 `any` 逃逸（确需时 `unknown` + 收窄并注释原因）。
3. **pnpm 经 Corepack 启用**，`packageManager` 字段锁精确版本，CI 与本地/容器同版本。
4. **自检项 G1（D0 必做，非分歧项）**：`better-sqlite3` 是原生模块，网关与管理端都依赖它。
   装机后必须实测 `require('better-sqlite3')` 可加载、能开库；若 `pnpm install` 未执行该依赖的构建脚本，
   需按**锁定的 pnpm 版本**对应的配置放行（不同大版本的配置名不同，以实测为准，不预设名称）；
   同时 `node_modules` 与 Node ABI 必须匹配（Node 22 对应固定 ABI），故**锁死版本 + `--frozen-lockfile`**，禁用浮动升级。
5. 原生模块、Docker 构建、CI 三处必须跑同一条 `pnpm install --frozen-lockfile`，任何一处另起装法视为缺陷。

---

## 三、KeyPool 接口签名（M0 冻结物，不含实现）

```ts
/** 计入 key 失败的 5 类原因；其余情况一律不调用 reportFailure（见 §四） */
type FailureReason =
  | 'AUTH_INVALID'          // 401/403
  | 'RATE_LIMITED'          // 429
  | 'INSUFFICIENT_BALANCE'  // 402 / 上游明示余额不足
  | 'UPSTREAM_ERROR'        // 5xx
  | 'NETWORK';              // 连接/读取超时、ECONNRESET

/** 一次调用的 token 用量；缺失上游 usage 时按字符估算并置 isEstimated=true（v1.1 §三.2/.3） */
interface TokenUsage {
  prompt: number;       // int
  completion: number;   // int
  total: number;        // int
  isEstimated: boolean; // true 表示按字符估算，仍计入 TPM/日配额
}

/** 路由候选；只含选路所需最小信息，不含 key 明文、不含密文 */
interface KeyCandidate {
  keyId: string;        // 用 DB 主键，不用「后4位」（后4位可能重复）
  upstreamId: string;
  category: 'token-plan' | 'balance';
  weight: number;
}

interface KeyPool {
  /** 过滤（模型匹配+启用+类目可用+不在冷却+并发未满）→ 排序（权重→（token-plan 剩余额度）→ 上次失败时间→ LRU），见 ADR-0011 */
  getAvailableKeys(model: string): Promise<KeyCandidate[]>;

  /** 记一次失败：更新失败计数、按 §四 进入冷却；同一请求同一 key 只调一次 */
  reportFailure(keyId: string, reason: FailureReason): void;

  /** 记一次成功：清失败计数、按 tokens 结算用量、按 latencyMs 更新健康评分 */
  reportSuccess(keyId: string, tokens: TokenUsage, latencyMs: number): void; // latencyMs = 首字节耗时 int ms
}
```

**实现侧硬约束（签名冻结，语义同步冻结）**

1. `getAvailableKeys` 必须命中**进程内缓存、零 DB 往返**（v1.1 §四.10：热路径零 DB 查询）；签名保留 `Promise` 以便后续换异步来源，调用方按 `await` 写。
2. **重试与换 key 是网关引擎的职责**，不由 KeyPool 内部重试；`getAvailableKeys` 只返回候选列表，返回顺序即优先级。
3. 「超并发上限」的 key 暂不入选，**不算失败、不进冷却**（v1.1 §四.3）；token-plan 类不参与「余额>0」过滤，改按套餐余量/到期时间判定（P7）。
4. **单写者**：`cooldown / fail_count` 归网关运行态，KeyPool 是**唯一写入方**；管理端只读展示 + 手动启停/恢复，写操作递增 `revision` 触发网关缓存失效（v1.1 §四.10）。
5. 管理端读到的 key 健康数据来自网关侧快照 `GET /internal/snapshot`（v1.1 §四.6），管理端不得自行改写健康态。
6. **排序口径（ADR-0011，2026-10-06 PM 裁决）：`权重 →（token-plan 剩余额度）→ 上次失败时间 → LRU`**。
   `balance` 类**不参与**「剩余额度」排序（余额是计费资金、不随请求递减，按它排序 = 余额最高者垄断流量，
   破验收 §九.1）；`isUsable` 的「余额>0/未知」可用性过滤**原样保留**，排序与可用性解耦。
   LRU 兜底位用**单调使用序号**（`beginAttempt` 成功占位时打点），不进 `view()`、不落 `key_runtime` 镜像，
   `/internal/snapshot` 与契约响应形状零变化。需求文档 §四.1 字面不动，冲突在 ADR-0011 备案。

---

## 四、失败分类与冷却映射（冻结，逐条对齐 v1.1 §四.2）

| 上游情况 | `FailureReason` | 计入 key 失败 | 冷却策略 |
|---|---|---|---|
| 401/403 | `AUTH_INVALID` | 是 | 长冷却 30min + 告警；连续 N 次自动禁用 |
| 429 | `RATE_LIMITED` | 是 | 按 `Retry-After`，默认 60s，指数退避 |
| 402 / 余额不足 | `INSUFFICIENT_BALANCE` | 是 | 长冷却 + 余额告警 |
| 5xx | `UPSTREAM_ERROR` | 是 | 短冷却 10–30s |
| 连接/读取超时、ECONNRESET | `NETWORK` | 是 | 短冷却 15s |
| 400/404/422 | — | **否** | 无冷却，错误直接透传客户端（**不调 reportFailure**） |
| 客户端主动断开 | — | **否** | abort 上游，日志记 `aborted`（**不调 reportFailure**） |

- 换 key **仅限未向客户端写出任何字节前**；已开始输出后上游中断 → 不换 key，发 SSE 错误事件后正常 `[DONE]`，按已产生部分 usage 计费。
- 探活用 `GET /v1/models`（零 token 成本）；冷却半开探测 1m → 5m → 15m → 30m 封顶。
- 上游 key 全挂时走上游级熔断短路，避免每请求白试 3 次。

**默认参数提案**（全部可配，M0 冻结数值、实现可覆盖）

| 参数 | 默认 | 参数 | 默认 |
|---|---|---|---|
| 换 key 重试上限 | 3 个 key | `UPSTREAM_ERROR` 冷却 | 10–30s |
| `NETWORK` 冷却 | 15s | `AUTH_INVALID` / `INSUFFICIENT_BALANCE` 冷却 | 30min |
| 冷却半开 | 1m→5m→15m→30m 封顶 | 每 key 并发上限 `maxConcurrency` | 4 |
| 连接/首字节/流内空闲/整请求超时 | 四项独立可配（首字节超时 < 整请求上限） | 上游熔断短路时长 | 30s |

---

## 五、契约边界与协作规则

1. **接口面归属**：`/v1/*` 归路由者，`/api/*` 归管家；两者只共享 SQLite(WAL) 与 key 状态，**不互相调内部实现**。我不改 `/api/*` 契约，管家不改 `/v1/*`。
2. **错误体双轨**（v1.1 §二.1）：`/v1/*` 用 OpenAI 格式 `{error:{message,type,code}}`，另含 `NO_AVAILABLE_KEY`(503) / `UNSUPPORTED_ENDPOINT`(501)；`/api/*` 用 `{code,message,details?}`。
3. **我需要管家在 `docs/api-contract.md` 中给出字段级定义的消费项**（网关侧读取，缺一项我就无法开 M3）：
   - `upstreams`：`base_url`、`enabled`、余额模板与上游级配置、熔断相关字段；
   - `upstream_keys`：`status`、`category`、`weight`、`balance_cents`、`balance_updated_at`、套餐余量/到期（token-plan）、`revision`；
   - `key_models`：显式关联与「留空即按 upstream 继承」的判定；
   - `models`：档案 `enabled` 集合 + 「客户端模型名 → 上游真实模型名」别名；
   - `groups` / `group_keys`：RPM/TPM/日配额字段（含 `null` = 不限）；
   - `change_log`：变更事件结构与 `revision` 语义（网关据此失效缓存，1s 轮询兜底）。
4. **配置同步**：共享 SQLite(WAL) + 网关进程内缓存 + 变更事件 + 1s 轮询兜底，热更新生效 < 1s，热路径零 DB 查询。
5. **契约变更流程**：改 `docs/api-contract.md` → 群里同步影响面 → 再改代码；文档未改的契约变更无效。
6. **脱敏**：任何列表/日志/图表 tooltip/导出只出现 `****后4位`；网关日志同样只落后 4 位，`x-request-id` 全链路透传。

---

## 六、网关侧验证命令与 DoD

`package.json` scripts（名称 M0 定稿，语义先冻结）：

| 命令 | 覆盖 | 对应验收 |
|---|---|---|
| `pnpm test:gateway` | 路由过滤/排序、轮询出量分布（§九.1，每健康 key ≥10%）、冷却半开、重试上限 3、限流滑动窗口、TPM 预留与结算、别名映射 | §九 1/5 |
| `pnpm test:fault` | 401 / 429 / 超时 / 进程 kill 四类故障注入：断言客户端无感、首字节前切换 < 100ms | §九 2 |
| `pnpm bench:ttfb` | 同机直连 vs 经网关，输出 TTFB 增量 P50/P99 | §九 3 |
| `pnpm test` | 全量回归（第 9 条验收） | §九 9 |
| `pnpm check:secrets` | 扫描日志与 spool 文件，断言**不含 key 明文**（机器检查，非口头承诺） | §九 8 |

> 上表三行均为 **M0 冻结的语义名**（不得改名）。落地进度（2026-10-06 更新）：`pnpm test:gateway` = `vitest run src/gateway`，**已落地可跑**（含 `rotation.spec.ts` 的 §九.1 轮询出量分布判据，ADR-0011）；`test:fault` / `bench:ttfb` **尚未落地**（M5 前补），仍不得在门禁/CI/交付证据里当已存在的命令引用。

**DoD**：门禁**四闸**全绿 —— `pnpm typecheck` / `pnpm test` / `pnpm build` / `pnpm check:secrets`（CI 另跑 `pnpm check:sqlite` 作原生绑定判据、`pnpm check:shutdown` 作优雅停机证据步；这两条是**单列证据步，不属于四闸**，四闸永远只有上面四个名字）+ 可复现证据（命令与真实输出）+ 契约改动已回写 `docs/api-contract.md`。性能类验收必须报**同机直连基准对比**，不接受只有绝对值。

> `pnpm check:shutdown`（2026-10-06 口径）：**证据步 + 两个具名 spec，删除任一即转红**。命令是 `vitest run src/wiring/shutdown.spec.ts && vitest run src/server.spec.ts` —— 两段各只有一个过滤器。为什么不写成一个 run 带两个参数：vitest 的 positional 参数是**过滤器**而非路径断言，落空的过滤器被静默忽略（`vitest run <存在的 spec> <不存在的 spec>` → exit 0、零警告），那样删掉 `shutdown.spec.ts` 闸照样绿，"`db.close()` 必须最后"整条判据消失。`pnpm test` 是全量回归，与 `check:shutdown` 重复跑不是冗余：后者是能指名道姓的停机证据步，CI 步骤名与四闸字面量均不变。

> `pnpm lint` 已于 2026-10-06 删除（仓库无 eslint 配置，脚本实际不可跑，属幽灵门禁），不再计入任何 DoD。

---

## 七、与 v1.1 / PM 清单的差异说明

**冲突：0 项。细化：2 处（均为签名可读性，不改变 PM 的冻结语义）**

1. `reportSuccess` 的 `tokens` 由标量细化为 `TokenUsage` 对象 —— 理由：v1.1 §三.3 与验收 §九.6 需要 `prompt/completion/total` 与 `isEstimated` 才能做 TPM/日配额结算；**方法名、参数顺序、调用点均不变**。
2. `latencyMs` 明确为「**首字节耗时 int ms**」—— 理由：验收 §九.2 要求首字节前切换 P99 < 100ms，该字段必须可与 TTFB 口径对齐；整请求耗时由网关内部统计，不参与选路评分。

---

*变更记录：v1.0 首版，路由者 · 网关内核，随整包待 Bo 终审；M0 契约冻结后变更需 PM 批准。*
