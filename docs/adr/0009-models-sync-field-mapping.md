# 9. 模型同步的字段映射：只落能证明的，其余一律未知，且未知不覆盖已知

- 状态：已接受（PM 于 2026-10-06 追认编号顺延至 0009；决策内容来自 M2 裁决②）
- 日期：2026-10-06
- 决策者：管家 · 管理后端
- 关联：契约 §5、ADR-0007（冻结纪律）、ADR-0008（占用了原定的 0008 编号）

## 背景与问题

契约 §5 要求模型有 `type` / `capabilities` / `contextLength` / `price`，档案卡要按这些字段筛选和展示。而 `POST /api/models/sync` 的数据源是上游的 `/v1/models` —— OpenAI 兼容形状只回 `{id, object, created, owned_by}`。

**能力、上下文长度、价格，上游一个都不给。**

于是同步面临一个三选一：编、不填、还是干脆不建档。前两项各有一个具体的失效模式：

- 编一个「合理默认值」（比如 `contextLength: 4096`、`price: 0`、`capabilities: ["stream"]`）：档案卡从第一秒起就在骗人。前端「筛选支持 stream 的模型」会筛出一堆并不支持 stream 的模型；价格写 0 会让 M4 的成本统计整个失去意义。这个项目的验收里没有一条能抓出这种假数据 —— 它只能靠纪律。
- 整个字段留 `null`（含 `type`）：`type` 是列表页的筛选主键，全 `null` 等于模型页不可用。

## 决策

### 1. 建档只写三样：`name` / `type`（推断）/ 同步时间

| 字段 | 同步写入 | 分类 |
|---|---|---|
| `name` | 上游 `id` | **有证据** |
| `type` | 按名字推断（见 §2） | **显式推断，可覆盖** |
| `displayName` | `null` | 未知 |
| `capabilities` | `[]` | 未声明 |
| `contextLength` | `null` | 未知 |
| `price` | `null` | 未知 |
| `enabled` | `1` | 建档即启用，服务与否由管理员在卡片上决定 |
| `lastSyncedAt` | 本次同步时间 | 内容没变也刷新：它回答的是「上次拉到数据是什么时候」 |

`capabilities` 用**空数组**而不是 `null`：字段类型是数组，`null` 会让前端的筛选逻辑多一个分支；空数组的语义是明确的「未声明」，与「声明了但没有能力」在业务上恰好同解 —— 这两者都不该被当作可服务。

### 2. `type` 的推断规则：显式、有顺序、可覆盖

按顺序匹配名字，命中即取，全不命中为 `chat`：

| 顺序 | 命中模式 | 结果 |
|---|---|---|
| 1 | `embed` | `embedding` |
| 2 | `rerank` | `rerank` |
| 3 | `whisper` \| `tts` \| `audio` \| `speech` \| `voice` \| `sovits` | `audio` |
| 4 | `dall-e` \| `dalle` \| `stable-diffusion` \| `flux` \| `midjourney` \| `imagen` \| `sd[-_]?xl` \| `image` | `image` |
| — | 其余 | `chat` |

顺序是**故意固定**的：`deepseek-vl2-image` 这类同时含多个线索的名字必须有确定解，否则同一份上游数据在不同时间同步会得到不同的 `type`。

推断结果要**可见**：任务 `result.inferredTypeCount` 回本次建档时靠推断定类型的条数。管理员据此知道有多少条 `type` 是猜的。

### 3. 推断只发生在建档；已存在的模型以库里现值为准

`type` 一旦入库，后续同步**不回退**它。原因：`PATCH /api/models/:id` 是唯一能修正推断结果的手段，如果每次同步都把人工修正冲掉，那 PATCH 就是无效的 —— 管理员改一次、同步一次、改回来，等于没改。

代价要说清楚：上游把 `text-embedding-3-large` 改名或新增名字线索后，已有档案的 `type` 不会自动跟着变，需要管理员 PATCH。**这是刻意选择的方向**：宁可漏更新（可见、可修），不可静默覆盖人工值（不可见、不可修）。

### 4. 未知不覆盖已知（本次一并修的实现缺陷）

初版 `upsertModelFromSync` 在更新分支里**无条件写入** `capabilities='[]' / contextLength=null / price=null / displayName=null`。这意味着：管理员 `PATCH` 补好一把模型的价格，下一次同步就把它抹回未知。

「同步会抹掉刚录的价格」比「价格空着」更坏：空着是**已知的未知**，被抹掉是**静默的数据丢失**，而且下一次看板只会显示 `—`，没人知道那里曾经有过一个正确的数字。

修正后的规则：对已存在的行，`null` / `[]` **不是新值**，不构成覆盖理由。

| 字段 | 更新分支的取值 |
|---|---|
| `name` | 不参与更新（它是匹配键） |
| `type` / `displayName` | 保留库中现值 |
| `capabilities` | 空数组 → 保留库中现值；非空 → 覆盖（当前同步从不产生非空，为将来上游给出能力时留的口子） |
| `contextLength` / `price` | `null` → 保留库中现值 |
| `lastSyncedAt` | 总是刷新 |

`unchanged` / `updated` 的判定也据此改为比较**生效后**的值：字段实际没变时只刷 `lastSyncedAt`，`revision` 不涨、不产生多余的 `change_log` —— 否则每同步一次都会给全部模型推一次前端刷新。

## 备选方案

| 方案 | 结论 |
|---|---|
| A. 建档 + 显式推断 + 未知留空 + 未知不覆盖已知 | **采纳** |
| B. 给未知字段填「合理默认值」 | 否。验收 9 条里没有一条能抓住它，只能靠纪律拦 —— 正因为抓不住，才更不能开这个口子 |
| C. 干脆不建档，只保存上游返回的原始 JSON，展示层再解析 | 否。`enabled`（验收 4 的「已启用集合」）、`availableKeyIds`、`PATCH` 修订都需要真实的行；把语义推到展示层会让 `/v1/models` 与档案量的一致性无法在服务端保证 |
| D. 用模型的 `context_length` / `price` 从上游别的端点「顺带拿」 | 否。上游是固定 Base URL 的兼容端点，没有这类端点；假设它有，是在实现里赌一个不存在的事实 |
| E. 覆盖即可，反正管理员会重填 | 否。见 §4：静默数据丢失的失效模式比空值差一个量级 |
| F. 加 `manual_fields` 列逐字段记录「谁写的」 | 暂不。它是 E 的严格解（能区分「人工填的 null」与「从没填过」），但需要 schema 变更 + 迁移，而当前没有任何路径能写入「人工置空」这个状态（`PATCH` 的 `price: null` 与「没填过」在业务上同解）。等真出现「人工显式置空」需求再上，见「已知缺口」 |

## 影响

- **后端（管家）**：`src/api/services/model-sync.ts`（推断表、计数口径）+ `src/db/repo/models.ts`（更新分支的覆盖规则）。无 schema 变更。
- **前端（画师）**：`ModelsPage` 对 `price`/`contextLength`/`capabilities` 为 `null`/`[]` 时显示「未知」而不是 `0`/`—`（画师已在 `dev/web-m2` 按此实现）。`inferredTypeCount` 可作为同步结果提示的一部分展示。
- **网关（路由者）**：无影响。`/v1/models` 只取 `enabled = 1` 的名字集合。
- **契约**：§5 新增字段映射小节 + 两条不变量；版本号 → v1.0.2。

## 已知缺口（不在本次范围）

- **无法表达「人工显式置空」**：`PATCH` 把 `price` 置回 `null` 之后，下次同步会保留「值已经是 `null`」的现状 —— 结果正确，但路径是巧合而非机制。要严格区分需要 F 方案的 `manual_fields` 列，留待 M4 一起评估（与 `gateway_keys.deleted_at` 删列同批 schema 变更）。
- **上游若真给出 `capabilities`**：当前解析器只取 `id`，不读其余字段。将来要读，需要同时定义「上游给的能力」与「人工 PATCH 的能力」如何合并 —— 本次不预埋。
- **`type` 不随改名自动修正**：见 §3，刻意如此。

## 门禁核验

在 `.worktrees/api`（分支 `dev/api`，基点 `bbe3252`）实测，见本次提交回执：

| 闸 | 结果 |
|---|---|
| `pnpm run typecheck` | 0 error |
| `pnpm run test` | **46 passed (5 files)**，其中新增 `src/api/services/model-sync.spec.ts` 6 例 |
| `pnpm run check:secrets` | 107 文件 / 476 KB，**0 命中** |
| `pnpm run build` | PASS |

回归用例的判据不是「同步返回 200」，而是：建档 → `PATCH` 写入 `price`/`capabilities`/`contextLength`/`displayName` → 再同步一次，**四项人工值逐字段比对仍相等**，且该行 `revision` 不因未变的字段而增长。
