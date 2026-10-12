# ADR-0026：同步/探测的共享凭据选择器（401/403 换下一把）

- 状态：已接受（2026-10-14）
- 关联：ADR-0024（能力探测）、ADR-0021（出站必走闸）、ADR-0018（账号面台账）、ADR-0009（模型档案不造假）、契约 v1.11.2
- 车道：管家（`src/api` / `src/db`）

## 背景

2026-10-12 起 `POST /api/models/sync`（TierFlow 上游）持续 401（任务 `task_96699be7df10`）。
路由者 2026-10-14 复核定案：**不是上游故障，是选 key 逻辑选中了一把「孤儿 key」**。

- `src/api/services/model-sync.ts` 的 `pickSyncKey` 只取 `ORDER BY created_at, id` 的**第一把**启用 key，
  不问健康、不问类别、不问台账绑定；401 不重试、不换 key。
- 被选中的是 `key_232d66a4385d`（掩码 `****amMc`，2026-10-11 19:43 建档）：全库 **93 把启用 key 中唯一**
  没有 `supplier_account_keys` 台账绑定的（`enabled_unbound=1`）。rotate 之后它在上游侧的凭据已失效。
- 它 `usage_logs` 命中 0 条、`key_runtime` 零观测——**「93 把全 healthy」是「未观察到失败」，
  不是「验证可用」**：sync/管理面路径不喂 key_runtime，该 key 又零数据面流量，所以零信号、业务零感。
- A/B 实测（同刻同上游）：`****amMc` → **401** `Invalid token`；台账绑定 key `****BfbV` → **200** 正常模型列表。

## 决策

1. **共享选择器** `src/api/services/credential-rotation.ts`：候选 = 该上游**已启用** key，按
   「台账绑定 `status='active'` 账号的优先 → `created_at, id` 稳定序」排序。解密唯一出口仍是
   `decryptedKeyRefs()`（**不造第二份解密实现**）；排序键与既有出口逐字一致，台账行缺失（非账号面上游）时退化为原 `created_at,id` 序。
2. **换把判定只认 HTTP 状态码**：`401/403 → reason:"auth"` 换下一把；其余错误（超时/网络/5xx）**不换**、
   直接按原样报错。**不解析文案**（§16.1 决策 4 同向）。
3. **预算**：装配默认**试 3 把**（实现常量，不进契约）。预算耗尽回**最后一个**上游错误（保留原始状态码语义）。
4. **可观测位**：`SyncSummary` 新增**可选** `credentials: { tried, usedMaskedKeys, switched }`——
   **只含计数与掩码，不含明文**；省略 = 未换过。`decryptedKeyRefs` 不带 `toJSON` 的既有纪律照旧。
5. **实现拆两笔**：本笔（`d0f0d33`）落选择器 + sync 接线 + 契约 v1.11.2；探测四件
   （`/api/models/:id/probe` + sync 尾部补探 + `capabilities_source` 两列 + `last_probed_at`）
   是第二笔，探测的凭据获取**必须走本选择器**，预算共享同一常量。Bo 拍板（2026-10-14）：「探测 commit 携带共享凭据选择器」。
6. **停用孤儿 key**（Bo 拍板「请停用 `****amMc`」，2026-10-14）：`key_232d66a4385d` 经管理面
   `PATCH /api/keys/:id`（CAS + 审计）停用，`revision 1→2`。不直写库、不软删——台账/usage_logs 的外键落点保留。
   停用后实测 `task_944dd9facc1b` succeeded（`failedUpstreams=0`，401 消失）。

## 备选方案（否掉的）

| 方案 | 结论 |
|---|---|
| 只停用坏 key，不改选 key 逻辑 | 治标。下一把孤儿 key 出现时同样的事故重演一遍，且没有任何信号 |
| 候选扩成「启用 + 非冷却」 | `key_runtime` 只覆盖数据面流量；sync 路径零观测，冷却条件在管理面路径上恒真——**没有判别力** |
| 失败后把 key 写进冷却/停用 | 管理面写 `key_runtime` 违反 §9 镜像纪律（唯一写方是网关运行态镜像）；凭 401 停用会在「全局凭据失效」时连锁停光 |
| 候选只允许「台账绑定 key」 | 非账号面上游没有台账行，会被一刀切排除；台账行缺失必须退化而不是拒绝 |

## 影响

- `src/api/services/credential-rotation.ts`（新文件）、`src/api/services/model-sync.ts`（接线 + `SyncSummary.credentials`）。
- 契约 v1.11.2：§5 三处口径补充 + 变更块 + 版本索引；`MODEL_PROBE_MAX_MODELS` 落装配侧 env 默认 = 10（数值不进契约）。
- `/v1/*` 零变更；`ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` 零新增；`SCHEMA_VERSION` 仍为 2。
- `firstUsableBalanceKeyId` 同型隐患（自测/余额刷新只看 enabled+category）：**本笔只登记不动**——
  探测判据 401/403→`null` 依赖选择器先落；刷新路径的口径（快照、计费面）牵扯更宽，另行派单，不在本笔顺手改。
