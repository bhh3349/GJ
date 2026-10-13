/**
 * 管理面端点层 —— 一个函数对应 docs/api-contract.md 的一行。
 *
 * 这一层只做三件事：拼路径、拼 query、给返回类型。**不做**字段改名、
 * 不做默认值填充、不做 null→0 的降级（契约 §0.2 的 null 语义必须原样往上传）。
 */
import { api, downloadFile, type QueryValue } from './http';
import type {
  AuditEntry,
  BalanceStats,
  BalanceSyncQuery,
  BalanceSyncStatus,
  BalanceTemplateTestRequest,
  BalanceTestResult,
  CallLog,
  EgressProxy,
  EgressProxyCreateRequest,
  EgressProxyListQuery,
  EgressProxyPatchRequest,
  EgressProxyTestResult,
  EgressRetiredReason,
  Group,
  GroupCreateRequest,
  GroupCreateResponse,
  GroupKeyIssued,
  GroupKeyResetResponse,
  GroupPatchRequest,
  KeyBalanceUpsertRequest,
  KeyBatchRequest,
  KeyBatchResult,
  KeyCreateRequest,
  KeyListQuery,
  KeyPatchRequest,
  LoginRequest,
  LogListQuery,
  ModelListQuery,
  ModelPatchRequest,
  ModelProbeRequest,
  ModelProbeResult,
  ModelProfile,
  ObservabilityErrorEvent,
  ObservabilityErrorQuery,
  ObservabilityHealth,
  ObservabilityHealthSnapshot,
  ObservabilityPaged,
  ObservabilitySnapshotQuery,
  ObservabilityWindow,
  Paged,
  SessionInfo,
  StatsOverview,
  StatsWindow,
  SupplierAccount,
  SupplierAccountListQuery,
  SupplierBatchRequest,
  SupplierImportRequest,
  SupplierKeysRequest,
  SupplierRotateKeyRequest,
  SupplierSubscriptionRow,
  SupplierTestResult,
  Task,
  TaskAccepted,
  Upstream,
  UpstreamCreateRequest,
  UpstreamKey,
  UpstreamListQuery,
  UpstreamPatchRequest,
  UsageQuery,
  UsageStats,
} from './types';

/**
 * 契约里的过滤参数是 interface，TS 不给 interface 隐式索引签名，
 * 无法直接当 `Record<string, QueryValue>` 传。取值全是标量，这里一次性收口，
 * 避免每处调用都手抄字段名。
 */
function q(params: object): Record<string, QueryValue> {
  return params as Record<string, QueryValue>;
}

// ── §1 鉴权 ───────────────────────────────────────────────────────────────

export const authApi = {
  /** 会话走 HttpOnly Cookie，响应体里**没有** token，前端也读不到。 */
  login: (body: LoginRequest) => api.post<SessionInfo>('/auth/login', body),
  logout: () => api.post<void>('/auth/logout'),
  /** 启动时调它决定是否跳登录页。未登录 → 401 UNAUTHORIZED。 */
  session: () => api.get<SessionInfo>('/auth/session'),
};

// ── §2 上游 ───────────────────────────────────────────────────────────────

export const upstreamsApi = {
  list: (query: UpstreamListQuery = {}) => api.get<Paged<Upstream>>('/upstreams', { query: q(query) }),
  get: (id: string) => api.get<Upstream>(`/upstreams/${id}`),
  create: (body: UpstreamCreateRequest) => api.post<Upstream>('/upstreams', body),
  /** 必须带 `revision`；不符 → 409 REVISION_MISMATCH。 */
  update: (id: string, body: UpstreamPatchRequest) => api.patch<Upstream>(`/upstreams/${id}`, body),
  /**
   * 删上游。有 key **或模型档案**且 `force !== true` → `409 UPSTREAM_HAS_KEYS`，
   * `details: {keyCount, modelCount}`（v1.2.2）。
   * `force=true` 按依赖序**物理删除整棵子树**（ADR-0016），不可撤销 —— 不是软删。
   */
  remove: (id: string, force = false) =>
    api.del<void>(`/upstreams/${id}`, { query: { force: force ? true : undefined } }),
  /** 按模板查该上游全部 key 余额（异步）。 */
  refreshBalance: (id: string) => api.post<TaskAccepted>(`/upstreams/${id}/balance/refresh`),
  /**
   * 用草稿模板打一次真实查询（同步、不写库）。`body` 缺省 = 用已存模板；
   * `keyId` 可选，缺省 = 上游第一把可用 balance key。响应 `raw` 用于帮用户定位该填哪条解析路径。
   */
  testBalanceTemplate: (id: string, body?: BalanceTemplateTestRequest) =>
    api.post<BalanceTestResult>(`/upstreams/${id}/balance-template/test`, body),
};

// ── §3 Key ────────────────────────────────────────────────────────────────

export const keysApi = {
  list: (query: KeyListQuery = {}) => api.get<Paged<UpstreamKey>>('/keys', { query: q(query) }),
  get: (id: string, includeDeleted = false) =>
    api.get<UpstreamKey>(`/keys/${id}`, {
      query: { includeDeleted: includeDeleted ? true : undefined },
    }),
  /** 明文 `key` 只在此处进入系统；响应只回 `maskedKey`。 */
  create: (body: KeyCreateRequest) => api.post<UpstreamKey>('/keys', body),
  update: (id: string, body: KeyPatchRequest) => api.patch<UpstreamKey>(`/keys/${id}`, body),
  remove: (id: string) => api.del<void>(`/keys/${id}`),
  /**
   * 手动录入余额。`balance: 0` 是合法值，`balance: null` 表示置回**未知**——
   * 契约 §3「防造假」的关键，两者在 UI 上不得渲染成同一个东西。
   */
  upsertBalance: (id: string, body: KeyBalanceUpsertRequest) =>
    api.put<UpstreamKey>(`/keys/${id}/balance`, body),
  refreshBalance: (id: string) => api.post<UpstreamKey | TaskAccepted>(`/keys/${id}/balance/refresh`),
  /** 用该 key 所属上游的**生效查询方式**（用户模板或 preset）打一次，回诊断（不写库）。 */
  testBalance: (id: string) => api.post<BalanceTestResult>(`/keys/${id}/test-balance`),
  batch: (body: KeyBatchRequest) => api.post<KeyBatchResult>('/keys/batch', body),
  refreshAllBalances: () => api.post<TaskAccepted>('/keys/balance/refresh'),
};

// ── §4 用户组 ─────────────────────────────────────────────────────────────

export const groupsApi = {
  list: (query: { q?: string; page?: number; pageSize?: number } = {}) =>
    api.get<Paged<Group>>('/groups', { query: q(query) }),
  get: (id: string) => api.get<Group>(`/groups/${id}`),
  /** C1：建组自动签发第一把 key，响应额外带**仅此一次**的明文 `gatewayKey`。 */
  create: (body: GroupCreateRequest) => api.post<GroupCreateResponse>('/groups', body),
  update: (id: string, body: GroupPatchRequest) => api.patch<Group>(`/groups/${id}`, body),
  remove: (id: string) => api.del<void>(`/groups/${id}`),
  /** 再签发一把，明文仅此一次。 */
  issueKey: (id: string) => api.post<GroupKeyIssued>(`/groups/${id}/keys`),
  /** 重置：旧 key **立即失效**。 */
  resetKey: (groupId: string, keyId: string) =>
    api.post<GroupKeyResetResponse>(`/groups/${groupId}/keys/${keyId}/reset`),
  removeKey: (groupId: string, keyId: string) =>
    api.del<void>(`/groups/${groupId}/keys/${keyId}`),
};

// ── §5 模型 ───────────────────────────────────────────────────────────────

export const modelsApi = {
  list: (query: ModelListQuery = {}) => api.get<Paged<ModelProfile>>('/models', { query: q(query) }),
  get: (id: string) => api.get<ModelProfile>(`/models/${id}`),
  update: (id: string, body: ModelPatchRequest) => api.patch<ModelProfile>(`/models/${id}`, body),
  /** 异步任务：省略 upstreamId 即全量。进度走 `GET /api/tasks/:id`，**不做假进度条**。 */
  sync: (upstreamId?: string) =>
    api.post<TaskAccepted>('/models/sync', upstreamId ? { upstreamId } : {}),
  /**
   * §5 能力探测（v1.11.0）：同步返回（不打任务）。`apply:false` 只回结果、零写库。
   * 计量与请求体全在后端内置 —— 前端只拼路径与 body，不做任何请求体注入。
   */
  probe: (id: string, body: ModelProbeRequest = {}) =>
    api.post<ModelProbeResult>(`/models/${id}/probe`, body),
};

// ── §5.1 异步任务 ─────────────────────────────────────────────────────────

export const tasksApi = {
  get: (id: string) => api.get<Task>(`/tasks/${id}`),
};

// ── §6 统计 ───────────────────────────────────────────────────────────────

export const statsApi = {
  overview: (window: StatsWindow) => api.get<StatsOverview>('/stats/overview', { query: { window } }),
  balance: () => api.get<BalanceStats>('/stats/balance'),
  usage: (query: UsageQuery) => api.get<UsageStats>('/stats/usage', { query: q(query) }),
  /**
   * §14.3 余额同步观测口（**只读**）。回显生效的自动同步参数 + 带 `asOf` 的余额序列 + 漂移提示。
   *
   * 两条纪律落在调用方，别在这里"顺手"补：
   * - **前端不得自算间隔 / 抖动 / 退避** —— 一律读 `auto`，它是服务端配置的投影；
   * - `points[].totalBalanceCents === null` 是"那一刻全未知"，**不得补 0、不得插值**。
   * `window` 默认 `6h`（后端回显实际值），**不是**同步节奏。
   */
  balanceSync: (query: BalanceSyncQuery = {}) =>
    api.get<BalanceSyncStatus>('/stats/balance/sync', { query: q(query) }),
};

// ── §12 运维观测（只读） ────────────────────────────────────────────────────
//
// 这一组是**只读**端点（契约 §12.3 末行：全部端点无副作用、不写审计），所以仪表盘
// 可以直接轮询它们。字段名逐字按 §12.2 的响应体建模，本层不做改名、不做默认值填充。

export const observabilityApi = {
  /** §12.2 健康指标（实时算，不读快照表）。`window` 缺省由后端定为 `5m`。 */
  health: (window?: ObservabilityWindow) =>
    api.get<ObservabilityHealth>('/observability/health', {
      // exactOptionalPropertyTypes：不显式写 `query: undefined`，没传窗口就让后端定。
      ...(window ? { query: { window } } : {}),
    }),
  /** §12.3 历史快照，`ts DESC, id DESC`；默认最近 6h。 */
  snapshots: (query: ObservabilitySnapshotQuery = {}) =>
    api.get<ObservabilityPaged<ObservabilityHealthSnapshot>>('/observability/health/snapshots', {
      query: q(query),
    }),
  /** §12.3 错误事件查询，`ts DESC, id DESC`；默认最近 1h。 */
  errors: (query: ObservabilityErrorQuery = {}) =>
    api.get<ObservabilityPaged<ObservabilityErrorEvent>>('/observability/errors', {
      query: q(query),
    }),
};

// ── §15 供应商账号面（TierFlow） ───────────────────────────────────────────
//
// 一个函数对应 §15.2 的一行。11 个端点**全在这里**，因为它们是同一张管理面的两个切面
// （账号池 / 套餐台账），拆成两个命名空间只会让"这个上游有没有账号面"这个判据
// 散在两处 —— 而那个判据只有一条：`Upstream.supplier === 'tierflow'`（§15.12 锚 1）。

export const supplierAccountsApi = {
  list: (query: SupplierAccountListQuery = {}) =>
    api.get<Paged<SupplierAccount>>('/supplier-accounts', { query: q(query) }),
  get: (id: string) => api.get<SupplierAccount>(`/supplier-accounts/${id}`),
  /**
   * 跨账号的扁平套餐台账（**只读、不发上游请求**）。与详情里那个嵌套 `subscriptions[]`
   * 是同一份数据的两个切面；这边按 `end_at` 排，回答的是"接下来谁到期"。
   */
  subscriptions: (query: { upstreamId?: string; page?: number; pageSize?: number } = {}) =>
    api.get<Paged<SupplierSubscriptionRow>>('/supplier-accounts/subscriptions', { query: q(query) }),
  /**
   * 批量导入（`text` = 「手机号,密码」行文本）。**只收密码型凭据** ——
   * 会话型凭据不走 HTTP（§15.9），所以这里没有第二个入口。
   * 返回 `202 {taskId}`：成了几行要等任务跑完，靠 §15.3 的逐行结果说话。
   */
  import: (body: SupplierImportRequest) => api.post<TaskAccepted>('/supplier-accounts/import', body),
  /** 刷余额。`ids` 省略 = 该上游全部账号（**不按状态筛**，会话过期的号正是最该刷的）。 */
  refresh: (body: SupplierBatchRequest) => api.post<TaskAccepted>('/supplier-accounts/refresh', body),
  /** 批量新建 key 并入池。上游明文**不经浏览器**，响应与任务结果只回 `keyId` + `keyMasked`。 */
  createKeys: (body: SupplierKeysRequest) => api.post<TaskAccepted>('/supplier-accounts/keys', body),
  /** 同步已有 key（掩码）+ 套餐。只读上游、只写台账；未命中的掩码**只记数**。 */
  syncKeys: (body: SupplierBatchRequest) =>
    api.post<TaskAccepted>('/supplier-accounts/keys/sync', body),
  /**
   * 重置 / 轮换套餐专属 key（§15.13，v1.9.0）。异步任务：`202 {taskId}`，
   * 终态经 `GET /api/tasks/:id` 取 `SupplierBatchResult`（逐行 `action` 第 6 值 `rotate`）。
   * `ids` 省略 = 该上游全部账号；`subNo` 省略 = 各账号最新到期的套餐。
   * 逐行只回 `keyId` + `keyMasked`（**新** key 掩码）—— 明文不经浏览器（服务端当场加密入池）。
   */
  rotateKey: (body: SupplierRotateKeyRequest) =>
    api.post<TaskAccepted>('/supplier-accounts/rotate-key', body),
  /** 单账号重登。**同步**端点，回 200；无存档密码时当场 422（不是"点了没重登成"）。 */
  relogin: (id: string) => api.post<SupplierAccount>(`/supplier-accounts/${id}/login`),
  /** 连接自测。**永不写库**，业务性失败一律 `200 + ok:false`（诊断结论走响应体）。 */
  test: (id: string) => api.post<SupplierTestResult>(`/supplier-accounts/${id}/test`),
  /**
   * 删账号。名下还有已入池 key 且 `force !== true` → `409 ACCOUNT_HAS_KEYS`。
   * 与删上游（ADR-0016 物理删子树）关键差别：**这里一把 key 都不删，只解绑** ——
   * 账号删了它名下的 key 仍可用，真删 key 会让网关下一轮快照少一批可用 key（删账号打穿流量）。
   */
  remove: (id: string, force = false) =>
    api.del<void>(`/supplier-accounts/${id}`, { query: { force: force ? true : undefined } }),
  /**
   * §15.2 对账 CSV（`text/csv`，UTF-8 BOM + CRLF，文件名由服务端给）。
   *
   * 走 `downloadFile` 而不是 `api.get`：它是产出物型端点，要按 `Content-Disposition` 落盘，
   * 且失败必须能落进 loading / 成功 / 失败同一条通道（裸 `window.open` 拿不到 401 的反馈）。
   * **导出不分页**（§15.2）—— 分页导出拿到的"账号总数"取决于点第几页，那不是对账表。
   * 表里**不含密码、不含会话、不含任何 key 明文或掩码**，所以它不能用来重建账号，只能用来对账。
   */
  exportCsv: (query: { upstreamId?: string } = {}) =>
    downloadFile('/supplier-accounts/export', { query: q(query) }),
};

// ── §16.7.2 出口池（Tier 2 出口代理） ──────────────────────────────────────
//
// 十类资源对象里的第十类，与 §15 账号面**独立**。写方法的 CSRF 头由 http.ts 统一带；
// 明文凭据只走 create / patch 的请求体，响应只回 `authSet` —— 所以这里**没有**读凭据的端点。
//
// `/test` 是唯一一个**真的打外网**的端点（出站 `api.ipify.org`）且吃出口预算：
// 预算耗尽 → `429 TOO_MANY_ATTEMPTS`（`details.retryAfterSec`）。调用方据此给"稍后再试"。

export const egressApi = {
  /** 默认全量（按 `name` 排）；`status` 可选过滤。 */
  list: (query: EgressProxyListQuery = {}) =>
    api.get<{ items: EgressProxy[] }>('/egress', { query: q(query) }),
  get: (id: string) => api.get<EgressProxy>(`/egress/${id}`),
  /** 明文凭据仅在本次请求里进入系统，落盘即加密；响应不回显、日志不出现。 */
  create: (body: EgressProxyCreateRequest) => api.post<EgressProxy>('/egress', body),
  /** 任意子集；凭据是**整体换**（见 `EgressProxyPatchRequest`）。 */
  update: (id: string, body: EgressProxyPatchRequest) =>
    api.patch<EgressProxy>(`/egress/${id}`, body),
  /**
   * 退役（`replaced` | `manual`，**必填**）。仍被账号引用 → `409 EGRESS_HAS_ACCOUNTS`
   * （`details.accountCount`，**没有 `force`** —— 迁移必须先把账号改到别的 active 出口）。
   */
  retire: (id: string, reason: EgressRetiredReason) =>
    api.post<{ ok: boolean; status: 'retired' }>(`/egress/${id}/retire`, { reason }),
  /** 回池。**复用原 id**（同 URL 只有一条路回到 active，不新建行 —— §16.7 裁定 3）。 */
  reactivate: (id: string) => api.post<EgressProxy>(`/egress/${id}/reactivate`),
  /** 探活：真的从该出口打一次外网，回观测 IP。吃出口预算，可能 `429 TOO_MANY_ATTEMPTS`。 */
  test: (id: string) => api.post<EgressProxyTestResult>(`/egress/${id}/test`),
};

export const logsApi = {
  list: (query: LogListQuery = {}) => api.get<Paged<CallLog>>('/logs', { query: q(query) }),
  audit: (query: { page?: number; pageSize?: number } = {}) =>
    api.get<Paged<AuditEntry>>('/audit', { query: q(query) }),
};
