# ADR 索引 —— 42 份一行表

**读法**：先用本表定位，再 `Read docs/adr/NNNN-*.md` 那一份。不要按目录顺序整读（42 份约 7,340 行）。
A Decision Records 是 MADR 格式，文件名 `NNNN-标题.md`。新决策必须落 `docs/adr/`，不许只留在聊天记录（AGENTS.md §7）。

| ADR | 一行结论 | 什么时候必须去读 |
|---|---|---|
| [0001](../../../docs/adr/0001-terminal-and-script-baseline.md) | 终端基线 = Git Bash + 跨平台 npm scripts | npm script 写了 `&&`/`$(...)`/单引号被质疑时 |
| [0002](../../../docs/adr/0002-same-origin-cookie-auth.md) | 管理面与前端同源，HttpOnly Cookie 会话 | 动鉴权/Cookie/CSRF 时 |
| [0003](../../../docs/adr/0003-balance-three-scopes.md) | 余额三级口径，"未知"≠0 | 动余额字段/展示时 |
| [0004](../../../docs/adr/0004-pnpm-version-pin.md) | pnpm 锁 10.34.6 | 想升 pnpm 时 |
| [0005](../../../docs/adr/0005-pnpm-build-script-allowlist.md) | 只放行必要依赖的构建脚本 | 加依赖遇 blocked build script 时 |
| [0006](../../../docs/adr/0006-plaintext-key-scan.md) | key 明文判据：静态扫描 + 裸字节断言 | 动加密存储/日志脱敏时 |
| [0007](../../../docs/adr/0007-api-contract-freeze-c1-c5.md) | 契约 v1.0 冻结 + C1–C5 拍板 | 任何"契约当初为什么冻结成这样" |
| [0008](../../../docs/adr/0008-gateway-key-list-endpoint.md) | 补 `GET /api/groups/:id/keys` | 动网关 key 列表时 |
| [0009](../../../docs/adr/0009-models-sync-field-mapping.md) | 模型同步只落能证明的，未知不覆盖已知 | 动 `/api/models/sync` 时 |
| [0010](../../../docs/adr/0010-key-runtime-mirror.md) | `key_runtime` 镜像落库且不参与冷启动 | 动 key 运行态/启动路径时 |
| [0011](../../../docs/adr/0011-balance-exit-quota-sort-lru-rotation.md) | 路由排序：balance 退出额度键，兜底 LRU 单调序号 | 动 key 挑选/轮换时 |
| [0012](../../../docs/adr/0012-balance-preset-and-selftest.md) | 余额查询内置 preset、失败引导、自测端点 | 动余额解析失败路径时 |
| [0013](../../../docs/adr/0013-observability-readonly-query.md) | 错误事件分型 + 健康快照 + 只读维护令牌 | 动观测面时 |
| [0014](../../../docs/adr/0014-request-id-correlation.md) | `x-request-id` 全链路透传 + 两表落列 | 查关联/排错链路时 |
| [0015](../../../docs/adr/0015-assistant-chat.md) | 内置 AI 助手聊天 | 动 `/api/assistant/chat` 时 |
| [0016](../../../docs/adr/0016-delete-upstream-subtree.md) | 删上游按依赖序物理删整棵子树 | 动删除级联时 |
| [0017](../../../docs/adr/0017-balance-sync-source-of-truth.md) | 余额以上游同步为唯一事实源 | 动自动同步/快照/漂移提示时 |
| [0018](../../../docs/adr/0018-supplier-account-batch.md) | 账号=凭据容器，批量新建 key 是唯一入池通路 | 动供应商账号/批量任务时 |
| [0019](../../../docs/adr/0019-key-model-whitelist.md) | key 模型白名单落管理面一列 | 动 model_limits/白名单时 |
| [0020](../../../docs/adr/0020-egress-ip-rate-limit.md) | 出口级限流：归因上移到出口，冷却期内不换 key | 动限流归因时 |
| [0021](../../../docs/adr/0021-egress-budget-seam.md) | 出口预算：跨车道共享令牌桶 + 统一注入缝 | 动出口预算/注入点时 |
| [0022](../../../docs/adr/0022-subscription-key-rotate.md) | 套餐专属 key 轮换/重置 | 动 rotate-key 时 |
| [0023](../../../docs/adr/0023-assistant-model-select.md) | 助手聊天可按请求选站内模型 | 动 assistant `model` 参数时 |
| [0024](../../../docs/adr/0024-model-capability-probe.md) | `capabilities` 加机器来源 | 动模型能力位时 |
| [0025](../../../docs/adr/0025-assistant-error-summary-panel.md) | 错误汇总面板复用观测面，citations 不加默认快照 | 助手页取数口径 |
| [0026](../../../docs/adr/0026-sync-credential-rotation.md) | 同步/探测共享凭据选择器（401/403 换下一把） | 动凭据轮换时 |
| [0027](../../../docs/adr/0027-admin-web-hosting.md) | 管理面同源托管前端产物 | 动静态托管/SPA fallback 时 |
| [0028](../../../docs/adr/0028-gateway-access-info.md) | 接入信息只读面 | 动 `/api/access-info` 时 |
| [0029](../../../docs/adr/0029-supplier-account-egress-binding.md) | 账号绑出口的写路径与读面 | 动账号-出口绑定时 |
| [0030](../../../docs/adr/0030-plan-key-before-balance-key.md) | **套餐 key 优先于余额 key**（ADR-0011 排序键 2 追认） | 动路由排序/优先级时 |
| [0031](../../../docs/adr/0031-quota-per-unit-from-upstream.md) | 站点换算比从上游读不写死 | 动余额换算时 |
| [0032](../../../docs/adr/0032-table-retention-policy.md) | 五张表的保留策略 | 动表增长/清理任务时 |
| [0033](../../../docs/adr/0033-egress-echo-url-configurable.md) | 出口探活端点可配（会静默骗人的故障形状） | 动探活时 |
| [0034](../../../docs/adr/0034-console-user-role.md) | 消费面用户与角色授面的定位 | 动角色/权限时 |
| [0035](../../../docs/adr/0035-admin-workspace-group.md) | 管理组与首库种子：管理员必须持有一把网关 key | 动种子数据/管理组时 |
| [0036](../../../docs/adr/0036-admin-key-management-ui.md) | Base URL `/v1` 与逐把 key 管理面（零新增端点） | 动 key 管理 UI 时 |
| [0037](../../../docs/adr/0037-group-model-authorization.md) | 用户组模型授权 | 动组-模型授权时 |
| [0038](../../../docs/adr/0038-console-key-selfservice-and-password.md) | 消费面 key 自助与改自己口令 | 动 console 自助能力时 |
| [0039](../../../docs/adr/0039-endpoint-model-category-admission.md) | 端点类别准入 | 动模型类别/准入时 |
| [0040](../../../docs/adr/0040-tokenrhythm-second-supplier.md) | 第二家供应商 TokenRhythm：驱动器复用 + 能力位分发 | 动多供应商接入时 |
| [0041](../../../docs/adr/0041-overdraft-latch.md) | 透支锁存：余额 <10 分 / 套餐余量 =0 ⇒ 锁出选路（第四轴，`enabled` 不动），只有人工解除回池；判定腿挂**七个**落库点 | 动 `depleted` / `isUsable` / 任何余额余量落库点时 |
| [0042](../../../docs/adr/0042-error-event-key-attribution.md) | 错误事件的 key 标识**三腿分列**（上游 key / 客户端网关 key / 来源 IP+指纹）+ `attemptTrail`；`keyId` 语义改为「当时正在用哪把」；401 只到 socket IP 与 8 hex 指纹 | 动错误事件字段 / 排查「裸 `****` 是哪把 key」/ 动 §12.1 或助手注入块时 |

## 维护纪律

- 本表是**导航**，不是裁决文本；冲突以 ADR 全文 + 契约为准。
- 新增 ADR 后补一行；行号/结论与全文冲突时以全文为准并回改本表。
