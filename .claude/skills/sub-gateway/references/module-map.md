# 模块地图 —— 读代码前先看这里

> 行数是"非 spec 的 .ts"规模感，不是精确值。**不要按目录顺序整读**：先 Grep 定位 `文件:行`，再开小窗口 Read。

## 架构边界（AGENTS.md §8，不可越）

| 目录 | 归属（角色分工） | 内容 |
|---|---|---|
| `src/gateway/` | 路由者 | `/v1/*`、KeyPool、转发、限流、故障切换 |
| `src/api/` | 管家 | `/api/*` 管理面 REST 与 WS |
| `src/db/` | 管家 | SQLite schema、加密存储、统计聚合 |
| `web/` | 画师 | React + Ant Design 管理后台 |

跨边界改动**先改 `docs/api-contract.md` + `docs/adr/`，再动代码**。

## src/ 各目录的关键文件

### src/gateway/（转发热路径，~8.4k 行）
- **`engine.ts`**（~970）转发核心。`/v1/*` 对 body **纯透传**（:371 附近只覆盖 `model`）；`finish_reason` 的唯一消费点是 `usage.ts` tracker 的终局探针（§12.1 判据补遗）：**openai-node 等 SDK 在 `[DONE]` 后即 abort 底层连接**，所以流包装器 `cancel()` 见终局已转发就走有界补读（1.5s 窗 / 64 帧 / 单读超时竞速）按 200 收账，`499` 只留给未见终局的真断开。上游超时 120s（:195）。
- **`routes.ts`** `/v1` 路由注册：鉴权、限流、OpenAI 错误形状、`bodyLimitBytes`（默认 8MB，字节不是 token）、`UNSUPPORTED_PREFIXES`（images/audio/rerank/moderations/files/fine_tuning → 501）。
- **`key-pool.ts`** 内存 key 池。`getAvailableKeys` 只读内存快照；快照由 **change_log 事件 + 1s 轮询兜底** 刷新（AGENTS.md §5）。`isUsable` 早退顺序：status → **depleted（锁存，§20/ADR-0041）** → autoDisabled → cooldown → inflight → 类别规则（余额 `null||>0` / 套餐时效+余量）—— 注意锁存与"余额 ≤0 排除"是**两道独立的闸**，解一个不等于解另一个。
- **`egress.ts`** 出口（IP 级）限流/预算；**`cooldown.ts`** 冷却阶梯；**`limiter.ts`**；**`usage.ts`** 从响应 choices 里数 token（不碰 finish_reason）。
- **`ports.ts`** 四 port 适配层的同步签名 —— 把异步挡在实现侧，热路径零 DB。

### src/api/（管理面，~6.4k 行 + routes ~11.2k + services ~5.6k）
- **`app.ts`** Fastify 装配；**`http.ts`** Cookie/IP/**CSRF**（`verifyCsrf` :181，顺序 Origin → Sec-Fetch-Site → X-Requested-With，只查写方法）；**`errors.ts`** `{code,message,details?}` 错误体；**`dto.ts`**（~900）响应 DTO 全集。
- **`routes/supplier-accounts.ts`**（~2,250，最大单文件）供应商账号面；**`routes/console.ts`** 消费面（ADR-0034/0038）；**`routes/live.ts`** WS 实时通道。
- **`services/`**：`balance-refresh.ts` / `balance-query.ts`（余额同步，ADR-0017）、`model-sync.ts`（ADR-0009 字段映射）、`credential-rotation.ts`（401/403 换下一把，ADR-0026）、`model-probe.ts`、`assistant-chat.ts`（三重上限 + SSE）。

### src/db/（~3.4k + repo ~7.6k）
- **`schema.ts`**（~680）全部 DDL；**`crypto.ts`** MASTER_KEY AES 加密存储；**`balance.ts`** 余额三级口径（ADR-0003：未知≠0）；**`observability.ts`** 错误事件/健康快照；**`stats.ts`** 聚合。
- **`depletion.ts`**（64）透支阈值判据唯一实现（§20.2）+ **`repo/depletion-latch.ts`**（~170）落库腿（粘性/不碰 enabled/必广播三条纪律，七个落库点共用，ADR-0041）。改任何"该不该锁"的问题先看这两个文件。
- **`repo/`** 每表一个 repo（17 个）。写操作全部走单连接串行。`repo/keys.ts` 的**每一个余额/余量写点**末尾都挂 `latchIfBalanceDepleted` —— 新增写点必须挂，否则"所有落库处都判"破功。

### src/wiring/（装配层，~5.9k）
- `runtime.ts` 启动装配总成；`assistant-invoker.ts`（`ASSISTANT_MODEL` 未配 → 503 `NO_AVAILABLE_KEY`）；`usage-sink.ts` / `error-event-sink.ts` / `key-runtime-flusher.ts` —— **热路径异步批量落库的三件套**；`shutdown.ts` 优雅停机。

### 其余
- **`src/supplier/`**（~5.2k）`tierflow.ts`（~980）/ `tokenrhythm.ts`（第二家，ADR-0040）、session 导入、pacing 礼貌节奏（契约 §15.5）。
- **`src/balance/`** preset/template/raw 三种余额解析；**`src/egress/`** heartbeat/fetch-gate；**`src/security/plaintext-scan.ts`** = `npm run check:secrets`。
- `src/server.ts` 入口：装配 + 监听 + 优雅停机。

## web/（React + AntD，101 个 ts(x)）
- `pages/` 与管理面 API 一一对应：dashboard / upstreams / keys / groups / models / stats / users / assistant / access / console。
- **禁止 mock**：只调契约里的管理 API，契约有疑问问管家，不自己造字段（AGENTS.md §6）。

## 命令速查（Node 必须 `/opt/node22/bin/node`，v24 会坏 better-sqlite3 ABI）

```bash
pnpm build                        # tsc -p tsconfig.build.json
npm run dev                       # tsx watch src/server.ts（开发）
npm run typecheck                 # tsc --noEmit -p tsconfig.json
npm run test                      # vitest run（全量，~70 个 spec 文件）
npm run test:gateway              # 只跑 src/gateway
npm run check:sqlite              # 单写者/热路径静态检查
npm run check:secrets             # key 明文扫描（CI 同款）
npm run bench:ttfb                # TTFB 基准
npm run probe:tierflow            # TierFlow 数据通路探针
```

## 文档地图

- `docs/api-contract.md` —— 唯一接口事实源（行号索引见 `contract-index.md`）。
- `docs/adr/` 41 份（一行表见 `adr-index.md`）；`docs/dev-constraints.md`、`docs/proposals/`。
- `deploy/docker-deploy.md` + `docker-compose.yml` + `Dockerfile` —— 4100 的部署三件套。
- `HANDOVER.md` 交接记录（**可能过期**，以代码 + 契约为准，引用前先核对）。
- 根目录 `需求文档-v1.0.md` / `技术选型.md` —— 原始需求与选型。
