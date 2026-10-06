/**
 * 管理面端点层 —— 一个函数对应 docs/api-contract.md 的一行。
 *
 * 这一层只做三件事：拼路径、拼 query、给返回类型。**不做**字段改名、
 * 不做默认值填充、不做 null→0 的降级（契约 §0.2 的 null 语义必须原样往上传）。
 */
import { api, type QueryValue } from './http';
import type {
  AuditEntry,
  BalanceStats,
  BalanceTemplateTestRequest,
  BalanceTestResult,
  CallLog,
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
  ModelProfile,
  Paged,
  SessionInfo,
  StatsOverview,
  StatsWindow,
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
};

export const logsApi = {
  list: (query: LogListQuery = {}) => api.get<Paged<CallLog>>('/logs', { query: q(query) }),
  audit: (query: { page?: number; pageSize?: number } = {}) =>
    api.get<Paged<AuditEntry>>('/audit', { query: q(query) }),
};
