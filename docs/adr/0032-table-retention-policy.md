# ADR-0032：五张表的保留策略 —— 从"表只会长"到"每张表都有人扫"

- 状态：**已接受（2026-10-16，PM 批准「按你的建议动手」）**
- 关联：契约 §6（`usage_logs` 的口径出处）、§12.1（`gateway_error_events` 保留期明文）、
  §9（`change_log` 广播语义）；`.env.example` 三个新旋钮
- 车道：管家（`src/db/repo/{audit,tasks,change-log}.ts`、`src/config.ts`、`src/server.ts` 维护定时器）
- 触发：派工令铁律⑤收尾时的顺手排查 —— 五个 prune 函数里**两个有实现、零生产调用方**。

## 背景：一张只进不出的库

本项目从第一天起就有 `usage_logs` 的保留期（`LOG_RETENTION_DAYS`，30 天），
但那是**唯一**一条真正接进进程的清理路径。清完一遍之后剩下的形状是：

| 表 |  prune 函数 | 有实现？ | 被调用？ |
|---|---|---|---|
| `usage_logs` | `pruneLogs` | ✅ | ✅ `src/server.ts` 6h 定时器 |
| `gateway_error_events` | `pruneGatewayErrorEvents` | ✅ | ❌ **零调用方**（连 spec 都有，`gateway-events.spec.ts:206`） |
| `change_log` | `pruneChanges` | ✅ | ❌ **零调用方** |
| `audit_log` | `pruneAudit` | ❌ 不存在 | — |
| `tasks` | `pruneTasks` | ❌ 不存在 | — |
| `gateway_health_snapshots` | `pruneHealthSnapshots` | ✅ | ✅ 自己的 1h 定时器（`health-snapshot-writer.ts`） |
| `balance_snapshots` | `pruneBalanceSnapshots` | ✅ | ✅ 自己的定时器（`balance-sync.ts`） |

也就是说：**`gateway_error_events` 和 `change_log` 是"写了清理函数但没人调用"** ——
一个函数存在、spec 绿、生产环境里从不运行，比"没有这个函数"更坏：
它让"这张表有保留期"这件事看起来是**已实现的**。而 `audit_log` / `tasks` 连函数都没有。

这不是理论问题。`tasks.result` 是 JSON，2000 行粘贴导入的 result ≈ 75KB（契约 §15.3）；
`audit_log` 按管理动作计、量不大但**永久累积**。单写者模式下库文件只增不减，
迟早撞上一次"备份拷不动 / 迁移跑不完"，而那时候没人说得清是哪张表吃掉的。

## 决策

### 1. 审计的保留期是独立配置，不并进 `LOG_RETENTION_DAYS`

`audit_log` 加 `pruneAudit`，保留期读**新的** `AUDIT_RETENTION_DAYS`（默认 180 天）。

**为什么不能复用 `LOG_RETENTION_DAYS`（30 天）**：两张表回答的问题不同。
`usage_logs` 回答"跑过多少流量"，`audit_log` 回答"**谁在什么时候改过什么**"。
安全事件的追溯期本来就长于用量明细的有用期 ——
拿 30 天去裁审计，等于让"三个月前谁改过配置"比"三天前跑过多少请求"更早消失，
而这正是审计唯一不可替代的那部分价值。

代价是一个新旋钮。多一个配置项的成本远低于"审计和用量同寿命"带来的错误。

**仍然没有 delete 函数**：`pruneAudit` 按**时间窗**删，不认 id / actor / action。
调用方说不出"删掉某一条"，只能说"N 天以前的都不要了" ——
逐行删审计的能力是"谁能抹掉自己的痕迹"的入口，那个口子不开。
（`src/db/repo/audit.ts` 文件头原来写"只读不删，要清理只能直连库"，
本 ADR 落地后那句话会变成假的，所以同批改写为上面这个口径。）

### 2. 任务只删终态，且用显式谓词而不是靠 NULL 比较兜底

`tasks` 加 `pruneTasks`（`TASK_RETENTION_DAYS`，默认 7 天）：

```sql
DELETE FROM tasks WHERE finished_at IS NOT NULL AND finished_at < ?
```

`finished_at IS NOT NULL` 这条谓词**单独写出来，即使删掉它现在也恰好安全** ——
2026-10-16 做了变异验证：SQL 里 `NULL < cutoff` 恒为假，所以在跑的（`queued` / `running`）
任务碰巧不会被删。**但那是撞上的，不是设计出来的。**

它真正拦的是这次改写（注释里点名的那次"优化"）：

```sql
DELETE FROM tasks WHERE COALESCE(finished_at, started_at) < ?
```

有人嫌 NULL 比较别扭、补一个 `started_at` 兜底 —— 那一版会让在跑的任务按**开始时间**被裁掉，
而 `getTask` 会开始给正在轮询的前端回 404。变异验证：换成 `COALESCE` 那条用例**立刻红**，
直接删掉谓词则**不红**。所以这条钉住的不是"删不删在跑任务"这个当前结果，
而是"**不许引入 `started_at` 兜底**"这个改写方向。

删掉终态任务后**没有级联**：`tasks` 没有子表，`GET /api/tasks/:id` 对已删 id 回 404 ——
那是正确语义（"这个作业记录已经不在保留期内了"），不是数据丢失。

### 3. 广播表按**行数**裁，不按天数

`change_log` 的 `pruneChanges` 原来就有，本 ADR 只是**把它接进进程**。
保留量读 `CHANGE_LOG_KEEP_ROWS`（默认 10000 行）。

**为什么是行数而不是天数**：它是**广播信道**，不是历史。判据是"消费者的 `seq` 追到哪了"，
不是"这条广播多老了"。按天数裁会把"昨天的一条广播"和"三天前的一条广播"区别对待，
而消费者对两者的需求完全一样（都不需要）。

**删掉 seq 更小的行为什么不会让消费者漏变更**（`pruneChanges` 头注已论证，这里收成结论）：
`src/wiring/store.ts` 的 `drainChanges` 每次排空都把 `lastSeq` 推到**读到的最后一条**，
节拍 1s（`SNAPSHOT_POLL_MS`）。所以"哪些行还被某个消费者需要" = `seq > 该消费者的 lastSeq`。
一个节拍最多产生多少条？`appendChange` 的写点全是管理面批量动作，单次事务里最多的是
`backfillSubscriptionTokenPlan` 与 `replaceSupplierAccountKeyLedger` —— 它们按**受影响的 key 数**
逐条发，而上游 key 池规模是几十把。**一个节拍的上界在几十条量级，`keep = 10_000` 余量约两个数量级。**

**两个前提必须成立**，所以写进头注而不是藏在数字里：
- 消费者进程**活着**。停了两周又启动的消费者会漏这两周的变更且**不报错**
  （`changesSince` 只是查不到行）。但那种情形下它本来就已经落后两周了 ——
  裁剪只是让落后变成不可恢复，不是制造落后。`store.refresh()` 的 `!built` 支把 `lastSeq`
  对齐到当前水位，所以**重启不会漏**。
- `keep` **不小于**任何一次暂停期间可能累积的变更数。暂停越久这个数越大 ——
  所以它必须是配置，不是一个写死在代码里的"够大了"。

### 4. `gateway_error_events` 按契约原样接上，不新配旋钮

`pruneGatewayErrorEvents` 同样"有实现、零调用"，保留期取 `LOG_RETENTION_DAYS`。

**为什么不给它单独配置**：契约 §12.1 第 1488 行**明文**写了
「保留期与 `usage_logs` 同口径（`LOG_RETENTION_DAYS`，默认 30 天）」。
这条是**已经发布的契约行**，本 ADR 做的是把实现补齐到与契约一致 ——
而不是顺手改掉那条。真要提高错误事件的保留期，走契约修订，不在这里夹带。

### 5. 五张表挂同一个 6h 定时器；另两张留在原地

新增的 `pruneAudit` / `pruneTasks` / `pruneGatewayErrorEvents` / `pruneChanges`
四条挂在**同一个** `6 * HOUR_MS` 定时器里，逐条 try/catch（清垃圾失败不该把整台服务带走）。

**不为它们各起一个定时器**：四张表的量级都不大，一天扫四次与一小时扫一次在库大小上
没有可测差别；而多三个定时器就多三条可能在关停时漏清的尾巴
（`src/wiring/shutdown.ts` 要逐个 unref/clear）。

**为什么 `gateway_health_snapshots` / `balance_snapshots` 不并进来**：
它们的写入方**已经有自己的定时器**（`health-snapshot-writer.ts` 的 1h、
`balance-sync.ts` 的独立 prune 定时器）。再挂一个全局清理器就成了
"同一个表两个节拍"，而两边的保留期一旦配得不一样，**谁先跑谁后跑决定库的大小**。
`src/server.ts` 的定时器总表把这个理由写成明文，避免下一个人"顺手补齐"。

## 影响面

| 面 | 变更 |
|---|---|
| `/api/*` 响应 | **零变更**。保留策略不碰任何 DTO、不改任何查询口径 |
| `/v1/*` | **零变更**、`src/gateway/` **零改动** |
| DDL | **零**。`SCHEMA_VERSION` 仍为 2、零迁移脚本 —— 删行不需要动表结构 |
| `ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` | **零新增**。没有任何新的失败形态 |
| 审计动作 | **零新增**。裁剪是维护动作，不是管理动作 —— 它自己就在删审计，给它记一条审计会自我抵消 |
| 新配置 | 3 个可选旋钮：`AUDIT_RETENTION_DAYS`(180) / `TASK_RETENTION_DAYS`(7) / `CHANGE_LOG_KEEP_ROWS`(10000)。**全部有默认值，缺省行为 = 本 ADR 的口径** |
| 新函数 | `pruneAudit` / `pruneTasks`（`pruneChanges` / `pruneGatewayErrorEvents` 早已存在，本 ADR 只是接线） |

## 判据

`src/db/repo/retention.spec.ts`（16 条，全部经变异验证）：

| 用例 | 钉住什么 |
|---|---|
| `pruneAudit`：边界那条（`ts === cutoff`）留着 | `<` 而非 `<=`，与 `pruneLogs` / 三个快照 prune 逐字一致 |
| `pruneAudit`：差一毫秒做判据 | 不是"差一天"这种粗粒度 —— 毫秒边界才是真边界 |
| `pruneAudit`：`retentionDays = 0` 留一条 | 同一套 `<` 纪律的自洽性，"一天都不留"仍留住"这一毫秒" |
| `pruneAudit`：`appendAudit` 写的行同样在射程内 | 没有"只裁手插行"的隐歧 |
| `pruneTasks`：只删终态 + 早于 cutoff | 两个谓词同时在位 |
| `pruneTasks`：在跑的无论多老都不删 | 拦的是 `COALESCE(finished_at, started_at)` 那次改写（见决策 2 的变异结论） |
| `pruneTasks`：`result` 是 JSON 也整行删 | 不解析、不报错 |
| `pruneChanges`：没超 keep 一行不删 | 裁剪线相对**水位**（`MAX(seq)`），不是绝对 seq |
| `pruneChanges`：超了只删最旧、留下的 seq 连续 | 留下的正好 `keep` 条 |
| `pruneChanges`：恰好等于 keep 一条不删 | `seq <= max - keep` 的闭区间 |
| `pruneChanges`：可反复调用且单调收敛 | 周期任务的语义 |

## 遗留（不粉饰）

1. **三个新旋钮没有任何"改错了会怎样"的守护**。`positiveIntFromEnv` 只挡非正数，
   挡不住 `AUDIT_RETENTION_DAYS=0`（一天都不留）或 `CHANGE_LOG_KEEP_ROWS=1`（等于关掉广播缓冲）。
   没加范围校验的理由：这两个值**没有客观上正确的范围**，而"猜一个合理区间然后拒绝用户"
   比"让用户配错"更糟 —— 至少配错是用户自己的决定，且可从日志看出来（每轮打印 `retentionDays`）。
2. **没有"这张表现在多大"的观测面**。保留策略生效与否只能从 `app.log.info({removed})` 看，
   没有进 §12.2 健康指标。理由同 `pruneChanges` 的 `void` 返回值：删除行数随业务活跃度漂，
   不是健康指标。真要观测库大小应该走文件系统，不走 SQL。
3. **`change_log` 的"消费者活着"前提无法在网关侧验证**。停摆的消费者漏变更不报错，
   这是 `changesSince` 的设计（查不到行 = 没有变更），不是缺陷；但它意味着
   **广播丢失没有告警**。补救只能靠消费者侧自己比对（例如定期全量重建），本 ADR 不做。
