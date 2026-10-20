/**
 * 管理面契约类型层 —— docs/api-contract.md v1.0-frozen 的逐字段映射。
 *
 * 纪律（来自契约 §0.2，违反即红线）：
 * - 金额：`int`，单位**分**。拿不到是 `null`，**不是 0**。
 * - token：永远是 `int`。
 * - 时间：ISO8601 UTC 字符串（不带时区的时间串视为非法）。
 * - id：不透明 string，前端不解析。
 * - `health` / `cooldownUntil` / `consecutiveFailures` 是网关运行态，**只读**。
 *
 * 本文件不含任何 mock 默认值：所有可空字段都显式建模为 `| null`，
 * 让「未知」在类型层就无法被悄悄降级成 0。
 */

// ── §0 通用 ────────────────────────────────────────────────────────────────

/** 所有列表统一分页信封（§0.3）。`items` 为空是**合法**空态，不是错误。 */
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 分页请求参数。`pageSize` 上限 200，超限后端返回 400 INVALID_PARAM。 */
export interface PageQuery {
  page?: number;
  pageSize?: number;
}

export const PAGE_SIZE_MAX = 200;
export const PAGE_SIZE_DEFAULT = 20;

/** ISO8601 UTC 时间串。 */
export type Iso8601 = string;

/** 金额，单位分。 */
export type Cents = number;

/** 契约 §0.4 错误码全集，前端按 code 分支，不按 message 文案分支。 */
export type ApiErrorCode =
  | 'INVALID_PARAM'
  | 'UNAUTHORIZED'
  | 'SESSION_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'CSRF_REJECTED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'REVISION_MISMATCH'
  | 'UPSTREAM_HAS_KEYS'
  /** v1.4.0 首次新增的错误码（409）：删账号时名下还有已入池 key。**只解绑、不删 key**。 */
  | 'ACCOUNT_HAS_KEYS'
  | 'UNPROCESSABLE'
  | 'TOO_MANY_ATTEMPTS'
  | 'INTERNAL'
  | 'UPSTREAM_UNREACHABLE'
  | 'TASK_FAILED';

// ── §1 鉴权 ───────────────────────────────────────────────────────────────

/** `GET /api/auth/session` 与 `POST /api/auth/login` 的 200 响应。 */
export interface SessionInfo {
  username: string;
  expiresAt: Iso8601;
  /**
   * §19 / ADR-0034（v1.15.0 纯新增可选字段）。前端据此分流工作区：
   * `admin` → `/admin`（管理面），`user` → `/console`（消费面）。
   *
   * **老后端不带的可能**：字段是可选的，所以读它必须容忍 `undefined`。
   * 但**不能**因此就在本地猜 —— 猜错的形状是"普通用户被送进管理面然后逐个 403"，
   * 那比留在登录页更糟。缺省按 `admin` 走（历史行为），并由 §19.1 的服务端
   * 授面兜底：真没有权限的请求会拿到 403，不会看到数据。
   */
  role?: UserRole;
}

/** §19：账号角色。`admin_users.role` 的取值集合（ADR-0034 决策 1）。 */
export type UserRole = 'admin' | 'user';

export interface LoginRequest {
  username: string;
  password: string;
}

/**
 * §1b `POST /api/auth/password` 的请求体（v1.15.9 / ADR-0038 决策 3）。
 *
 * **没有 `username` 字段**，这是刻意的：改的恒是**会话本人**那一行。
 * 带一个用户名参数就得判"你能不能改别人的"，而这一版里那个能力不存在 ——
 * 少一个参数就是少一类越权面（同一个理由见契约 §19.7：那一页没有"重置密码"
 * 按钮是因为那个端点不存在）。
 *
 * `currentPassword` 必须提供并正确：只判"已登录"是不够的 —— 一条被偷走的会话
 * 就能改掉口令，把真正的主人锁在门外。改成功后**其他设备的会话会被踢掉**
 * （这正是改密的动机），当前会话留着（不必马上再登一次）。
 */
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

// ── §2 上游 ───────────────────────────────────────────────────────────────

/** 余额模板的响应解析路径。空串/字段缺失统一用 `null`。 */
export interface BalanceParseRules {
  /** 如 `data.balance_infos[0].total_balance` */
  balance: string;
  currency: string | null;
  remainingTokens: string | null;
  expiresAt: string | null;
  /** 上游给的单位，统一换算到「分」是后端的责任。 */
  unit: 'yuan' | 'cents' | 'dollar';
}

/**
 * 余额查询模板。
 * 安全：`headers` 里的 `{key}` 是占位符，执行时才替换；替换后的串永不下发。
 */
export interface BalanceQueryTemplate {
  /** `false` ⇒ 该上游只能手动录入余额。 */
  enabled: boolean;
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | null;
  parse: BalanceParseRules;
  timeoutMs: number;
}

/** 内置余额查询 preset（只读、可推导，永不落库；本批仅注册 `openai`）。 */
export interface BalancePreset {
  id: string;
  label: string;
  matchedBy: 'host';
  /** 当前真正生效的是它（即用户模板未启用）。 */
  effective: boolean;
}

/**
 * 余额查询失败引导码。**不是错误码**：不进 `ERROR_CODES`、不映射 HTTP 状态，
 * 只是给前端一个「该引导用户做什么」的指针。
 */
export type HintCode =
  | 'BALANCE_QUERY_UNSUPPORTED'
  | 'BALANCE_PARSE_MISMATCH'
  | 'BALANCE_UPSTREAM_UNREACHABLE'
  | 'BALANCE_AUTH_REJECTED'
  /**
   * v1.7.0 新增（§15.3 `failed` 子型）。**判据只是 HTTP 429**（契约第 328 行），
   * 所以文案只能陈述"这一轮请求被拒绝"，**不得**写成"出口被限流" —— 归因归检测器，不归 UI。
   */
  | 'BALANCE_EGRESS_RATE_LIMITED';

/** 自测的查询来源。③（无查询方式）走不到，直接 422。 */
export type BalanceTestSource = 'user-template' | 'preset';

export type BalanceTestErrorCode = 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED';

/** 自测解析结果。`balance` 是分；`null` = 取不到（与 0 严格区分）。 */
export interface BalanceTestParsed {
  balance: Cents | null;
  currency: string | null;
  remainingTokens: number | null;
  expiresAt: Iso8601 | null;
  unit: 'yuan' | 'cents' | 'dollar';
}

/**
 * 两个自测端点共用的响应（同步、不写库）。业务性失败仍 200 + `ok:false`。
 * `raw` 是上游原文，后端已抹掉明文 key 并截断 8KB；前端只做只读展示，绝不当 HTML 渲染。
 */
export interface BalanceTestResult {
  ok: boolean;
  keyId: string | null;
  maskedKey: string | null;
  source: BalanceTestSource;
  presetId: string | null;
  /** 规范化后的 `协议//host/path`，已剥 query，绝不回显替换过 `{key}` 的 URL。 */
  endpoint: string;
  httpStatus: number;
  durationMs: number;
  parsed: BalanceTestParsed;
  raw: unknown;
  errorCode: BalanceTestErrorCode | null;
  hintCode: HintCode | null;
  hint: string | null;
}

/** 自测草稿模板 = 余额查询模板去掉 `enabled`（测试语义无「启用」）。 */
export type BalanceTestTemplate = Omit<BalanceQueryTemplate, 'enabled'>;

/**
 * 上游级自测请求体 = 草稿模板 + 可选 `keyId`。
 * `keyId` 缺省 = 上游第一把 `enabled=true` 且 `category="balance"` 的 key（契约 §2）。
 */
export interface BalanceTemplateTestRequest extends BalanceTestTemplate {
  keyId?: string;
}

/**
 * 余额刷新任务的 `result`：原计数 + 失败引导两字段（非破坏新增，计数语义不变）。
 */
export interface BalanceRefreshResult {
  checked: number;
  ok: number;
  failed: number;
  unknown: number;
  skipped: number;
  hintCode: HintCode | null;
  hint: string | null;
  /**
   * #12（共享形状，PM 钉死）：本地拒绝带回的 `Retry-After`，单位**整数秒**。
   * `null` / 字段缺席 = 无建议 —— 展示位**不渲染**，不编默认秒数。
   * 后端（管家 #16）把该字段带进刷新结果；`hintCode` 非 429 型时恒为 `null`。
   */
  retryAfterSeconds: number | null;
}

export interface Upstream {
  id: string;
  name: string;
  baseUrl: string;
  /**
   * §2 `supplier`（v1.4.0）。它存在的唯一目的是让 host **不被当成能力判据** ——
   * 「这个上游有没有账号面」由管理员建上游时就指定，前端**不得**去 parse `baseUrl` 反推。
   * 判据只有一条：`supplier ∈ SUPPLIER_ACCOUNT_KINDS`（§15.12 锚 1 / ADR-0018 决策 0）。
   * 取值**不可穷尽猜测** —— 新增一家供应商就是服务端 enum 多一个值 + 这里多一个 kind，
   * 判据本身不变（判"是不是账号面供应商"，不是判"是哪一家"）。
   */
  supplier: string | null;
  enabled: boolean;
  keyCount: number;
  enabledKeyCount: number;
  /**
   * 本上游合计（分）。全部未知时是 `null`，不是 0。
   * 组成 = `Σ账号 + Σ无账号归属的 key`（§15.6 / ADR-0018 决策 3）——
   * 所以它**不是** `accountsBalance + keysBalance` 之外的新一份钱，另两个字段是拆解用的。
   */
  totalBalance: Cents | null;
  /** 余额未知的 key 数。**未知 ≠ 0**，UI 必须单独呈现。 */
  balanceUnknownKeyCount: number;
  /** `balance` 类 key 中 `unlimited=1` 的子集。**是子集：不额外相加、也不进未知计数**。 */
  unlimitedKeyCount: number;
  /** token-plan 类 key 数。这类**不进** totalBalance。 */
  tokenPlanKeyCount: number;
  /** §15 账号数。**通用上游恒 0**（0 是"没有账号面"，不是"没查到"）。 */
  accountCount: number;
  /** 账号级余额合计（分）；通用上游恒 `null`。 */
  accountsBalance: Cents | null;
  accountsBalanceUnknownCount: number;
  /** `totalBalance` 里由 key 贡献的那一半（分，供拆解合计）；**不是**新增的一份钱。 */
  keysBalance: Cents | null;
  balanceQuery: BalanceQueryTemplate | null;
  /** 内置 preset（只读、可推导）。未命中任何 preset 时为 `null`。 */
  balancePreset: BalancePreset | null;
  revision: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface UpstreamListQuery extends PageQuery {
  q?: string;
  enabled?: boolean;
}

/**
 * v1.4.0 起 `supplier` **可写**（§15.6：上游表单多一个可选「供应商」下拉，缺省 = 通用）。
 * 取值：`null` = 通用上游，其余每个值 = 一家走 §15 账号面的供应商（ADR-0018 决策 0）。
 * 服务端 schema 是 `enum: [null, 'tierflow', 'tokenrhythm']`，写别的值会当场 400。
 *
 * **这里是前端唯一一份 kind 名单**：UI 任何地方判"有没有账号面"都走
 * {@link hasSupplierAccountPanel}，不要去写 `=== 'tierflow'` —— 那种写法在接入第二家
 * 供应商时会**静默漏掉**它（不报错、只是入口不出现），而这正是最难查的一类缺陷。
 */
export type SupplierKind = 'tierflow' | 'tokenrhythm';

/** 账号面供应商全名单（§15.6）。新增一家：服务端 enum + 这里各加一个值。 */
export const SUPPLIER_ACCOUNT_KINDS: readonly SupplierKind[] = ['tierflow', 'tokenrhythm'];

/** 供应商在下拉框 / 台账里显示的名字。**显示名只在这里改**，业务判断一律用 kind 字面量。 */
export const SUPPLIER_LABELS: Record<SupplierKind, string> = {
  tierflow: 'TierFlow',
  tokenrhythm: 'TokenRhythm',
};

/** 把上游的 `supplier` 收成已知 kind；`null` / 未知值 → `null`（= 通用上游）。 */
export function asSupplierKind(supplier: string | null | undefined): SupplierKind | null {
  if (supplier === null || supplier === undefined) return null;
  return (SUPPLIER_ACCOUNT_KINDS as readonly string[]).includes(supplier) ? (supplier as SupplierKind) : null;
}

/**
 * §15.12 锚 1：**这个上游有没有账号面**的唯一判据。
 *
 * 名字刻意叫 panel（"管理面上有没有那块面板"）而不是 `isSupplier` —— 后者的读法容易被
 * 写成"是不是 TierFlow"。判据是**集合归属**，与具体哪一家无关。
 */
export function hasSupplierAccountPanel(supplier: string | null | undefined): boolean {
  return asSupplierKind(supplier) !== null;
}

/** 该 kind 的显示名；未知值原样回显（宁可见到一个陌生字符串，也不要显示成 TierFlow）。 */
export function supplierLabel(supplier: string | null | undefined): string {
  const kind = asSupplierKind(supplier);
  return kind === null ? (supplier ?? '通用') : SUPPLIER_LABELS[kind];
}

/**
 * 各供应商**有没有某类概念** —— 只用来决定"这个入口画不画、这个字段显不显"。
 *
 * **服务端是权威**：这里写错的后果只是多画或少画一个控件，真发出去该 422 的还是 422
 * （§15.14 的入口闸就是这样写的，前端这份表是它的镜像，不是替代）。
 * 所以这张表**必须与 §15.14 的入口闸逐条对齐**：那里放行的字段，这里才允许显示。
 */
export interface SupplierCapabilities {
  /** 有套餐 / 订阅概念（决定「套餐台账」页签与「轮换套餐 key」入口）。 */
  plans: boolean;
  /** key 有额度概念（决定建 key 表单的 unlimited / 额度 / 模型白名单三项）。 */
  keyQuota: boolean;
  /**
   * 有没有账号密码登录（决定「导入账号」入口是否存在）。
   * `false` 的供应商只有会话鉴权，文本导入对它是入口 422 —— 前端不该画一个点了必然失败的按钮。
   */
  passwordLogin: boolean;
  /**
   * 有没有「粘贴 Cookie」导入（v1.16.4）。与 `passwordLogin` 互斥：一家供应商的凭据
   * 要么靠密码换会话，要么直接收会话，不存在两条都开的情况。
   */
  sessionImport: boolean;
}

export const SUPPLIER_CAPABILITIES: Record<SupplierKind, SupplierCapabilities> = {
  // TierFlow：套餐 + 额度 + 模型白名单 + 密码登录俱全。
  tierflow: { plans: true, keyQuota: true, passwordLogin: true, sessionImport: false },
  /*
   * TokenRhythm（§15.14）：**没有**套餐概念（订阅腿是零请求的空数组、rotate 恒 422），
   * **也没有**额度概念（建 key 只收 `{name}`，限额/白名单字段一并发出去会 422），
   * **更没有账号密码登录**（站点只有 `tr_session`，§15.14.1 / v1.16.1）——
   * 入池走「粘贴 Cookie」（v1.16.4，`sessionImport`）—— 它没有密码可登，所以
   * 不给「导入账号」入口，给的是 Cookie 粘贴框。
   * 建 key 的 `unlimited` 因此不是"默认开着"而是**唯一合法取值**（见 SupplierModals）。
   */
  tokenrhythm: { plans: false, keyQuota: false, passwordLogin: false, sessionImport: true },
};

/** 该上游的能力位；通用上游（或未知值）→ `null`（没有账号面，也就没有这些入口）。 */
export function supplierCapabilities(supplier: string | null | undefined): SupplierCapabilities | null {
  const kind = asSupplierKind(supplier);
  return kind === null ? null : SUPPLIER_CAPABILITIES[kind];
}

export interface UpstreamCreateRequest {
  name: string;
  baseUrl: string;
  enabled?: boolean;
  supplier?: SupplierKind | null;
  balanceQuery?: BalanceQueryTemplate;
}

/** PATCH 只发变更子集 + `revision`（乐观锁）。 */
export interface UpstreamPatchRequest {
  name?: string;
  baseUrl?: string;
  enabled?: boolean;
  supplier?: SupplierKind | null;
  balanceQuery?: BalanceQueryTemplate | null;
  revision: number;
}

// ── §3 Key ────────────────────────────────────────────────────────────────

export type KeyCategory = 'balance' | 'token-plan';

/** 网关运行态健康度，管理端只读。`disabled` 优先于 `cooling`。 */
export type KeyHealth = 'healthy' | 'cooling' | 'disabled';

/**
 * 透支锁存的解除原因（契约 §20.2）。
 *
 * `'balance'` = 自己的余额 / 套餐余量耗尽；`'account'` = 其所属账号欠费级联（§20.6）。
 * **没有 `'token_plan'`**：套餐余量耗尽与余额不足是同一句话的事实，要区分看 `category`。
 */
export type DepletedReason = 'balance' | 'account';

/** §10：只有这五类计入 key 失败。 */
export type FailureReason =
  | 'AUTH_INVALID'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_BALANCE'
  | 'UPSTREAM_ERROR'
  | 'NETWORK';

export type BalanceSource = 'manual' | 'template';

export interface TokenPlan {
  remainingTokens: number;
  expiresAt: Iso8601 | null;
}

export interface UpstreamKey {
  id: string;
  upstreamId: string;
  label: string;
  /** 后端唯一出口，形如 `****a1b2`。明文永不出现。 */
  maskedKey: string;
  category: KeyCategory;
  enabled: boolean;
  weight: number;
  /** `null` = **未知**（查不到或从未录入）。UI 显示「未知」，绝不显示 0。 */
  balance: Cents | null;
  balanceCurrency: string | null;
  balanceUpdatedAt: Iso8601 | null;
  balanceSource: BalanceSource | null;
  /** `category="token-plan"` 时非空，此时 `balance` 恒为 `null`。 */
  tokenPlan: TokenPlan | null;
  /**
   * `true` = 上游侧给的是**无限额度**（此时 `balance` 恒为 `null`，但语义不是「未知」）。
   * 两者必须分开呈现：无限额度渲染成徽标，绝不渲染成 `—` / 「未知」 / 任何金额或负数。
   */
  unlimited: boolean;
  /**
   * **与 `enabled` / `health` 正交的第四轴**（契约 §20.1）：它答的是「有没有钱付账」。
   *
   * `enabled=true` + `health="healthy"` + `depleted=true` 是**完全合法的组合** ——
   * 没被停用、没在冷却，只是没钱了、网关不会选它。所以**透支时必须不能只画三灯**，
   * 那等于把「没钱」渲染成「可用」。
   */
  depleted: boolean;
  /** 「最早发现它付不起账的时刻」（只置位一次，粘性）。未锁存为 `null`。 */
  depletedAt: Iso8601 | null;
  depletedReason: DepletedReason | null;
  health: KeyHealth;
  cooldownUntil: Iso8601 | null;
  consecutiveFailures: number;
  lastFailureReason: FailureReason | null;
  lastFailureAt: Iso8601 | null;
  /** 自然日（UTC）累计 token。 */
  todayTokens: number;
  revision: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
  /**
   * 非空 = 已软删。来源只有 `DELETE /api/keys/:id` 这一条 —— 上游删除（ADR-0016）走的是
   * **物理删除整棵子树**，不留软删行（v1.2.2 起）。
   */
  deletedAt: Iso8601 | null;
}

export interface KeyListQuery extends PageQuery {
  upstreamId?: string;
  category?: KeyCategory;
  enabled?: boolean;
  health?: KeyHealth;
  /** §20.8：透支锁存筛选（第四轴，可与 `enabled` / `health` 并用）。 */
  depleted?: boolean;
  q?: string;
  /** 默认不含已软删；`true` 才显式查询。 */
  includeDeleted?: boolean;
}

export interface KeyCreateRequest {
  upstreamId: string;
  /** 明文只在此处进入系统，响应只回 maskedKey。 */
  key: string;
  category: KeyCategory;
  label?: string;
  weight?: number;
  balance?: Cents | null;
  tokenPlan?: TokenPlan | null;
}

export interface KeyPatchRequest {
  label?: string;
  enabled?: boolean;
  weight?: number;
  category?: KeyCategory;
  tokenPlan?: TokenPlan | null;
  revision: number;
}

/** `PUT /api/keys/:id/balance`：`0` 合法，与「未知」(`null`) 严格区分。 */
export interface KeyBalanceUpsertRequest {
  balance: Cents | null;
  currency?: string;
  note?: string;
}

export interface KeyBatchRequest {
  ids: string[];
  /**
   * `'undeplete'`（§20.5）= 清锁 + `enabled = 1`，**一个动作**。
   *
   * 与 `'enable'` 的区别是界面上的关键点：`'enable'` **不清锁**（下一条注释），
   * 用「启用」去解一把透支的 key 是最自然的误操作，而它不会报错、只是什么都没变。
   */
  action: 'enable' | 'disable' | 'undeplete';
}

export interface KeyBatchResult {
  updated: number;
}

// ── §4 用户组 ─────────────────────────────────────────────────────────────

/** `null` ⇒ **不限**（契约 §4）。 */
export type QuotaValue = number | null;

export interface GroupUsageToday {
  requests: number;
  tokens: number;
  costCents: Cents;
}

export interface Group {
  id: string;
  name: string;
  gatewayKeyMasked: string | null;
  rpm: QuotaValue;
  tpm: QuotaValue;
  dailyQuota: QuotaValue;
  dailyQuotaUsed: number;
  todayUsage: GroupUsageToday;
  keyCount: number;
  /**
   * 该组授权的模型**名**列表（契约 §4「模型授权」，v1.15.8 / ADR-0037）。
   * `null` = **不限**（可用全部已启用模型）—— 与 `[]` 同义，服务端出口恒不为 `[]`。
   *
   * 列表页那一列读的就是它，所以它是 `Group` 的字段、不是"详情端点专有"。
   */
  authorizedModels: string[] | null;
  enabled: boolean;
  revision: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

/**
 * `GET/PUT /api/groups/:id/models` 的展开项：授权**落到哪个上游**。
 *
 * 与 `models`（可写回的名字列表）并存：名字是开关、展开行是"两条同名档案分得开"。
 */
export interface GroupModelEntry {
  id: string;
  name: string;
  upstreamId: string;
}

/** `GET /api/groups/:id/models` 与 `PUT` 的响应体（契约 §4）。 */
export interface GroupModels {
  /** `null` = 不限。写回时 `null` / `[]` 是同一件事。 */
  models: string[] | null;
  authorizedModels: GroupModelEntry[];
}

/**
 * `PUT /api/groups/:id/models` 的请求体。
 *
 * **两格都必填**：`models` 不是可选项 —— 省略表达不了"置回不限"（那正是 `null` 的活），
 * 服务端对缺格回 400 并指名 `field`。
 *
 * `revision` 是**同一个** `Group.revision`（组只有一条版本号）：改授权会推它 +1，
 * 所以抽屉打开时抓的那一份拿来做保存，别人先改过就必然 409。
 */
export interface GroupModelsPutRequest {
  models: string[] | null;
  revision: number;
}

export interface GroupCreateRequest {
  name: string;
  rpm?: QuotaValue;
  tpm?: QuotaValue;
  dailyQuota?: QuotaValue;
}

export interface GroupPatchRequest {
  name?: string;
  rpm?: QuotaValue;
  tpm?: QuotaValue;
  dailyQuota?: QuotaValue;
  enabled?: boolean;
  revision: number;
}

/**
 * 建组响应 = Group + `gatewayKey`（**仅此一次**）。前端纪律：弹窗关闭即从内存丢弃，
 * 不缓存、不写 localStorage。
 *
 * **`gatewayKey` 是一个对象（`GroupKeyIssued`），不是字符串** —— 服务端
 * `createGroup` 返回 `{ group, gatewayKey: issued }`，路由层 `{ ...group, gatewayKey }`
 * 原样摊平，所以明文在 `gatewayKey.gatewayKey`（与 `POST /api/groups/:id/keys`
 * 的顶层四格**不同形**）。这里曾写成 `gatewayKey: string`，类型在编译期是绿的、
 * 运行期把对象直接喂给 `GatewayKeyRevealModal` → React 抛
 * 「Objects are not valid as a React child」，建组后整页进错误边界（v1.15.7 验收实测）。
 */
export interface GroupCreateResponse extends Group {
  gatewayKey: GroupKeyIssued;
}

export interface GroupKeyIssued {
  id: string;
  gatewayKey: string;
  maskedKey: string;
  /**
   * 人类给这把 key 起的名字（v1.15.9，纯新增可空字段）。`null` = 没名字。
   *
   * 回的是**库里真正写下的值**（服务端写入时 trim、空串收成 `null`），
   * 不是"让调用方确认自己传了什么" —— 所以前端拿它直接渲染，不要再 trim 一遍。
   */
  label: string | null;
  createdAt: Iso8601;
}

/**
 * §4 `POST /api/groups/:id/keys/:keyId/reset` 的响应。
 *
 * **与 `GroupKeyIssued` 逐字同形**，所以这里是一个别名而不是第二个 interface ——
 * 契约 §4 两行写的是同一组四格（`id` / `gatewayKey` / `maskedKey` / `createdAt`）。
 * 此前这里只有两格（少了 `id` / `createdAt`），而**它没有过调用方**，
 * 所以那个漂移从未产生过一次错误行为，只是账上一笔（ADR-0036 遗留 4）。
 * 改成别名之后，"两处形状各写一遍、将来漂移"这个可能就不存在了：
 * `id` 是**新**那把 key 的 id（旧行在同一个事务里被删掉，所以 `:keyId` 那次重置过后就查不到了）。
 */
export type GroupKeyResetResponse = GroupKeyIssued;

/**
 * §4 `GET /api/groups/:id/keys` 的列表项 —— **本端点存在的唯一理由**：
 * `Group` 只暴露 `gatewayKeyMasked`，前端拿不到 `:keyId`，重置/吊销无从触达。
 *
 * 与消费面的 `ConsoleKeyItem` 逐字同形（同一把 key 的掩码视角），但**不是同一个类型**：
 * 那个端点的授面、归属推导（恒来自会话）与这一个是两件事；共用类型会让
 * "管理员面这一份多了什么字段"变成看不见的事 —— 而这一份**刻意没有** `updatedAt`
 * （重置 = 删旧插新，`updated_at` 恒等于 `created_at`，回一个永远相等的字段只会误导）。
 */
export interface GroupKeyItem {
  id: string;
  /** `****后4位`。 */
  maskedKey: string;
  /** 这把 key 的名字（v1.15.9）。`null` = 没起名，列表里显示"未命名"。 */
  label: string | null;
  createdAt: Iso8601;
}

// ── §5 模型 ───────────────────────────────────────────────────────────────

export type ModelType = 'chat' | 'embedding' | 'image' | 'audio' | 'rerank';
export type ModelCapability = 'stream' | 'function_call' | 'vision' | 'json_mode';

/**
 * v1.11.0（§5 能力探测）：`capabilities` 的写入来源，**只读**（`PATCH` 不收）。
 * `manual` = 人手 PATCH 写的（探测永不覆盖）；`probe` = 机器探测写的；`null` = 从没问过。
 */
export type ModelCapabilitySource = 'manual' | 'probe' | null;

/** 单价，单位分/1k tokens。整体为 `null` 表示上游没给（≠ 0）。 */
export interface ModelPrice {
  inputPer1k: Cents;
  outputPer1k: Cents;
}

export interface ModelProfile {
  id: string;
  name: string;
  displayName: string;
  upstreamId: string;
  type: ModelType;
  capabilities: ModelCapability[];
  /** v1.11.0 只读：来源标记。与空数组一起解读 —— `[]`+'probe' = 问过、不支持；`[]`+null = 还没问过。 */
  capabilitiesSource: ModelCapabilitySource;
  /** v1.11.0 只读：最近一次能力探测时刻（探测每次都刷，与是否写库无关）；null = 从没探测过。 */
  lastProbedAt: Iso8601 | null;
  contextLength: number | null;
  price: ModelPrice | null;
  /** 当前**可服务**该模型的 key（启用、非冷却、余额 > 0）。空数组 = 暂不可用。 */
  availableKeyIds: string[];
  /** 决定是否出现在 `/v1/models`；与验收 4 的逐项 0 差异直接相关。 */
  enabled: boolean;
  lastSyncedAt: Iso8601 | null;
  revision: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

/**
 * §5 能力探测单项结论（v1.11.0）。`supported` 是**三态**不是布尔：
 * `true` = 支持 / `false` = 上游明确拒绝（4xx，模型的性质不是 key 的故障）/
 * `null` = 判不出（401/403/404/429/5xx/超时/网络）。`false` 与 `null` 都**从不写库**。
 */
export interface ModelProbeItem {
  capability: ModelCapability;
  supported: boolean | null;
  /** 上游响应状态码；超时 / 网络失败时为 `null`。 */
  status: number | null;
  durationMs: number;
  /** 逐端点诊断字段（不进 ERROR_CODES）：upstream_4xx / rate_limited / auth / not_found / server_error / timeout / network。 */
  reason: string | null;
}

/** `POST /api/models/:id/probe` 请求体（§5）。`targets` 只接受四枚能力名，其余后端 400。 */
export interface ModelProbeRequest {
  /** 省略 = 全探四项。 */
  targets?: ModelCapability[];
  /** 缺省 `false` = 只回结果、一个字节都不写库；`true` = 把探测到的 `true` 写回档案（人工值永不被覆盖）。 */
  apply?: boolean;
}

/** `POST /api/models/:id/probe` 的同步响应（§5，不打任务）。 */
export interface ModelProbeResult {
  modelId: string;
  modelName: string;
  upstreamId: string;
  probedAt: Iso8601;
  /** 本次真打出去的上游请求数。探测永不写 usage_logs，所以响应里没有 token 数。 */
  requests: number;
  items: ModelProbeItem[];
  /** 本次**真写进档案**的项（`apply:false` 时恒 `[]`）。 */
  applied: ModelCapability[];
  /** 写后现值（`apply:false` 时也是现值，前端可直接渲染）。 */
  capabilities: ModelCapability[];
  capabilitiesSource: ModelCapabilitySource;
}

/**
 * 同步任务 `result.probe`（§5 尾部自动补探的六计数）。探测失败不改任务成败，
 * 所以任务 succeeded / failed 都可能带它。读前必须先认形状（ModelsPage 的 asProbeCounters）。
 */
export interface ModelSyncProbeCounters {
  /** 候选 = 本次同步涉及且从未问过（capabilities_source 为 null）的模型。 */
  candidates: number;
  probed: number;
  applied: number;
  skipped: number;
  failed: number;
  requests: number;
}

export interface ModelListQuery extends PageQuery {
  upstreamId?: string;
  type?: ModelType;
  capability?: ModelCapability;
  enabled?: boolean;
  q?: string;
}

export interface ModelPatchRequest {
  enabled?: boolean;
  type?: ModelType;
  capabilities?: ModelCapability[];
  contextLength?: number | null;
  price?: ModelPrice | null;
  displayName?: string;
  revision: number;
}

// ── §5.1 异步任务 ─────────────────────────────────────────────────────────

/**
 * 任务类型。后五个来自 §15.2 的五个批量端点（服务端 `startTask` 的取值，
 * 见 `src/api/services/supplier-accounts.ts`）。前端**不用它做分支判断**
 * —— 逐行结果一律读 `result.items`（§15.3），类型串只用来在浮层标题上指个来源。
 */
export type TaskType =
  | 'model_sync'
  | 'balance_refresh'
  | 'supplier_import'
  | 'supplier_refresh'
  | 'supplier_keys'
  | 'supplier_keys_sync'
  | 'supplier_rotate_key'
  | 'supplier_import_sessions';

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface TaskProgress {
  done: number;
  total: number;
}

export interface Task {
  id: string;
  type: TaskType;
  status: TaskStatus;
  /** `total` 未知时为 `null`（如全量同步尚未枚举完）。 */
  progress: TaskProgress | null;
  message: string | null;
  result: unknown;
  startedAt: Iso8601 | null;
  finishedAt: Iso8601 | null;
}

export interface TaskAccepted {
  taskId: string;
}

// ── §6 统计 ───────────────────────────────────────────────────────────────

export type StatsWindow = '60s' | '5m' | '15m' | '1h';

export interface TokenBuckets {
  prompt: number;
  completion: number;
  total: number;
}

/** 余额聚合的一层（上游或全局）。 */
export interface BalanceScope {
  upstreamId?: string;
  name?: string;
  /** 全部未知时是 `null`，不是 0。 */
  totalBalance: Cents | null;
  balanceKeyCount?: number;
  /** 未知 ≠ 0，必须单独呈现。 */
  balanceUnknownKeyCount: number;
  /** `balanceKeyCount` 中 `unlimited=1` 的子集：不进金额合计、也不算未知（§15.6/§15.7）。 */
  unlimitedKeyCount?: number;
  tokenPlanKeyCount: number;
  currency?: string;
  /** 仅 `/api/stats/balance` 的 byUpstream 下钻带 `keys`。 */
  keys?: BalanceKeyRow[];
  byUpstream?: BalanceScope[];
}

export interface BalanceKeyRow {
  keyId: string;
  maskedKey: string;
  balance: Cents | null;
  balanceUpdatedAt?: Iso8601;
  balanceSource?: BalanceSource;
  balanceUnknownKeyCount?: number;
  /**
   * 契约 §2 / ADR-0018 决策 8（v1.6.0 起后端 `KeyBalanceEntry` 就带这一位）。
   * 无限额度 key 的 `balance` 恒为 `null`，但语义**不是「未知」**：两者数据同形、语义相反，
   * 只能靠这个旗标区分。漏传它的地方会把无限额度 key 渲染成「未知」——那是显示缺陷，不是数据缺失。
   */
  unlimited?: boolean;
}

export interface BalanceStats {
  global: BalanceScope;
}

export interface KeyHealthRow {
  keyId: string;
  maskedKey: string;
  upstreamId: string;
  health: KeyHealth;
  cooldownUntil?: Iso8601;
}

export interface StatsOverview {
  /** **后端给**的时间窗口。前端不得用本地时间自算 QPS。 */
  window: StatsWindow;
  generatedAt: Iso8601;
  qps: number;
  /** 0..1 的小数，不是百分数。 */
  successRate: number;
  requests: number;
  errors: number;
  tokens: TokenBuckets;
  balance: BalanceStats;
  keyHealth: KeyHealthRow[];
}

export type UsageGroupBy = 'key' | 'upstream' | 'group' | 'model';
export type UsageBucket = '1m' | '5m' | '1h' | '1d';

export interface UsageQuery {
  from: Iso8601;
  to: Iso8601;
  groupBy: UsageGroupBy;
  bucket: UsageBucket;
  upstreamId?: string;
  groupId?: string;
  model?: string;
}

export interface UsagePoint {
  t: Iso8601;
  requests: number;
  tokens: number;
  /** token 维度补缺（ADR-0012）：输入/输出/估算分列，`tokens = prompt + completion`。 */
  promptTokens: number;
  completionTokens: number;
  /** 本点中 `is_estimated=1` 的调用条数，>0 时该点需标「含估算」。 */
  estimatedTokens: number;
  costCents: Cents;
  errors: number;
}

export interface UsageSeries {
  key: string;
  label: string;
  /** 与 `axis` **等长且下标对齐**；缺失桶补 0（计数补 0 是对的，与余额的 null 语义不同）。 */
  points: UsagePoint[];
}

export interface UsageStats {
  from: Iso8601;
  to: Iso8601;
  /** C2：允许后端降级，此处回显**实际**使用的 bucket，前端按回显渲染。 */
  bucket: UsageBucket;
  groupBy: UsageGroupBy;
  axis: Iso8601[];
  series: UsageSeries[];
  /** `is_estimated=1` 的调用条数，>0 时图表需标注「含估算」。 */
  isEstimatedTokenCount: number;
}

export interface CallLog {
  id: string;
  ts: Iso8601;
  groupId: string | null;
  model: string;
  upstreamId: string;
  /** 只 4 位。 */
  keyMasked: string;
  status: number;
  errorCode: string | null;
  tokens: TokenBuckets & { isEstimated: boolean };
  latencyMs: number;
  ttfbMs: number | null;
  stream: boolean;
}

export interface LogListQuery extends PageQuery {
  from?: Iso8601;
  to?: Iso8601;
  groupId?: string;
  model?: string;
  status?: number;
  upstreamId?: string;
  keyId?: string;
  includeDeleted?: boolean;
}

export interface AuditEntry {
  id: string;
  ts: Iso8601;
  actor: string;
  ip: string;
  action: string;
  targetType: string;
  targetId: string;
  result: string;
}

// ── §14 余额同步（v1.3.0） ────────────────────────────────────────────────

/**
 * `lastTrigger`：最近一次同步**完成**的触发方（`"auto"` | `"manual"`）—— **任意触发都算**，
 * 不是"最近一次自动同步"。从未同步过是 `null`。
 */
export type BalanceSyncTrigger = 'auto' | 'manual';

/**
 * 契约 §14.4 方向级漂移码。**只有这两个**，且**只 warn + 计数**：
 * 本地没有单价（`usage_logs` 只有 token、`balance` 只有分，量纲不可比），
 * 所以漂移**只能判方向 + 零/非零，不能判钱**。前端不得据此推断"对账不上"或建议扣减。
 */
export type BalanceDriftCode =
  | 'BALANCE_SPENT_WITHOUT_TRAFFIC'
  | 'BALANCE_UNCHANGED_WITH_TRAFFIC';

/**
 * 自动同步的**生效参数回显**。前端**不得自算**间隔 / 抖动 / 退避（契约 §14.3 逐字）。
 *
 * ⚠️ 这三个数是**服务端配置**（`BALANCE_SYNC_MINUTES` 环境变量）的只读投影，
 * **不是**可以从前端改写的字段：契约里**没有**写这个配置的端点，
 * 也**没有** `min_interval_minutes` 这样的每上游字段。UI 只能显示 + 指向部署侧。
 */
export interface BalanceSyncAuto {
  enabled: boolean;
  /** 基准间隔（分钟）。`enabled=false` 时该值仍回显配置值，但**不代表正在跑**。 */
  intervalMinutes: number;
  /** ±比例，如 `0.1` = ±10%。 */
  jitterRatio: number;
  /** 退避上限（分钟），契约冻结 360。 */
  backoffCapMinutes: number;
}

/** 每上游的运行态（§14.3 `upstreams[]`）：退避与单飞读面。 */
export interface BalanceSyncUpstreamState {
  upstreamId: string;
  name: string;
  /** 该上游最近一次同步**完成**时刻；从未同步过为 `null`。 */
  lastSyncedAt: Iso8601 | null;
  /** 连续失败次数（退避用）；任一成功即归零。 */
  consecutiveFailures: number;
  /** 退避中非空，否则 `null`。 */
  nextAttemptAt: Iso8601 | null;
  inFlight: boolean;
}

/**
 * 一个快照点 = 该上游**此刻**所有未软删 key 的余额状态（**照下来的相**，不是作业记录）。
 * `totalBalanceCents === null` 表示那一刻**全未知** —— **不是 0**（§0.2 / §14.2 绝不补 0）。
 */
export interface BalanceSyncPoint {
  t: Iso8601;
  totalBalanceCents: Cents | null;
  /** 推导值：`balanceKeyCount - unknownKeyCount - unlimitedKeyCount`，分列出来才解释得通缺口。 */
  knownKeyCount: number;
  unknownKeyCount: number;
  unlimitedKeyCount: number;
  tokenPlanKeyCount: number;
}

export interface BalanceSyncSeries {
  upstreamId: string;
  /** 上游名快照（ADR-0016：删上游后历史仍可读）。 */
  label: string;
  /** **不自带等长轴**：节奏不规则（抖动 + 退避 + 关闭期），要均匀轴就得发明不存在的点。 */
  points: BalanceSyncPoint[];
}

/**
 * 一条漂移告警：相邻两次快照 + 同窗口 token 用量。
 * `from` / `to` 是判定窗口两端，`usedTokens` 是**上游级**（不按 key 过滤）。
 */
export interface BalanceDriftAlert {
  code: BalanceDriftCode;
  upstreamId: string;
  from: Iso8601;
  to: Iso8601;
  usedTokens: number;
}

/** §14.4 漂移块。`counts` 是**进程内计数**（重启归零），**不是**窗口内计数。 */
export interface BalanceDrift {
  since: Iso8601;
  counts: Record<BalanceDriftCode, number>;
  /** 按 `to` 倒序，上限 20 条。 */
  alerts: BalanceDriftAlert[];
}

/** 契约 §14.3 `GET /api/stats/balance/sync` 的 200 响应。**只读**：不改状态、不触发查询。 */
export interface BalanceSyncStatus {
  auto: BalanceSyncAuto;
  lastSyncedAt: Iso8601 | null;
  lastTrigger: BalanceSyncTrigger | null;
  /** 已含抖动的下一次计划时刻；关闭自动同步时为 `null`。 */
  nextRunAt: Iso8601 | null;
  window: { from: Iso8601; to: Iso8601 };
  upstreams: BalanceSyncUpstreamState[];
  series: BalanceSyncSeries[];
  drift: BalanceDrift;
}

/**
 * `window` 为 `Ns` / `Nm` / `Nh`，上限 24h，**默认 `6h`**（解析规则同 §6 `overview`）。
 * 契约说得很清楚：这是**观测窗口**，与自动同步的节奏**无关** —— 别拿它当"同步间隔"。
 */
export interface BalanceSyncQuery {
  upstreamId?: string;
  window?: string;
}

// ── §7 实时通道 ───────────────────────────────────────────────────────────

export interface LiveReadyMessage {
  type: 'ready';
  serverTime: Iso8601;
  intervalMs: number;
}

export interface LiveMetricsMessage {
  type: 'metrics';
  window: StatsWindow;
  serverTime: Iso8601;
  qps: number;
  successRate: number;
  requests: number;
  tokensTotal: number;
  balanceGlobal: Cents | null;
  balanceUnknownKeyCount: number;
}

export interface LiveKeyHealthMessage {
  type: 'key_health';
  serverTime: Iso8601;
  keyId: string;
  upstreamId: string;
  maskedKey: string;
  health: KeyHealth;
  cooldownUntil: Iso8601 | null;
  lastFailureReason: FailureReason | null;
}

export interface LiveBalanceMessage {
  type: 'balance';
  serverTime: Iso8601;
  keyId: string;
  maskedKey: string;
  balance: Cents | null;
  balanceUpdatedAt: Iso8601;
  balanceSource: BalanceSource | null;
  globalTotalBalance: Cents | null;
  balanceUnknownKeyCount: number;
}

export interface LiveTaskMessage {
  type: 'task';
  taskId: string;
  status: TaskStatus;
  progress: TaskProgress | null;
  message: string | null;
}

export interface LiveErrorMessage {
  type: 'error';
  code: ApiErrorCode;
  message: string;
}

/** §7 `egress_pool` 帧的单个节点（**终局名**，与 `src/egress/heartbeat.ts` 的 `EgressPoolNode` 逐字对应）。 */
export interface EgressPoolNode {
  /** **不透明字符串**，只当键用，前端不得解析其内容（契约 §7 v1.6.4）。 */
  egressId: string;
  /** 显示名（用户可改）—— 只作展示，不作键。 */
  name: string;
  /** 池化层探活态。前端**不得**按 `lastHeartbeatAt` 的新鲜度自算健康。 */
  status: 'online' | 'offline';
  /** 探活观测到的出口 IP；null = 本次心跳未带回。 */
  exitIp: string | null;
  /** 登记期望值；null = 未登记。与 `exitIp` 不等时必须显式告警。 */
  expectedExitIp: string | null;
  /** 最近一次真证据的绝对时刻（ISO8601 UTC）；冷启动 = null。 */
  lastHeartbeatAt: string | null;
  /** 上游限流冷却解除时刻。**与 `status` 是两种不可用**，并列展示、不得互盖。 */
  cooldownUntil: string | null;
}

export interface LiveEgressPoolMessage {
  type: 'egress_pool';
  serverTime: Iso8601;
  /**
   * **池级一帧**。`[]` = 已接线且当前 0 个出口 ⇒ 「未配置出口」空态；
   * **收不到本帧 ≠ 0 个出口**（= 未接线/未发射，缺省不是证据）。N 节点自适应，不得写死数量。
   */
  nodes: EgressPoolNode[];
}

export type LiveMessage =
  | LiveReadyMessage
  | LiveMetricsMessage
  | LiveKeyHealthMessage
  | LiveBalanceMessage
  | LiveTaskMessage
  | LiveEgressPoolMessage
  | LiveErrorMessage;

/** 服务端可识别的入站帧（首帧 `auth` 仅作就绪确认，**不传 token**）。 */
export interface LiveAuthFrame {
  type: 'auth';
}

/** 契约 §7 关闭码。 */
export const WS_CLOSE = {
  /** 会话失效 → 跳登录 */
  SESSION_EXPIRED: 4401,
  /** 就绪超时 → 重连一次 */
  READY_TIMEOUT: 4408,
  /** 服务重启 → 退避重连 */
  SERVICE_RESTART: 1012,
  /** 正常关闭（登出）→ 不重连 */
  NORMAL: 1000,
} as const;

// ── §12 运维观测（只读） ──────────────────────────────────────────────────

/** §12.1 错误事件分型，9 值枚举。**唯一判据**，不由 HTTP 状态现推。 */
export const OBSERVABILITY_CATEGORIES = [
  'CLIENT_REQUEST',
  'AUTH_FAILED',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'NO_AVAILABLE_KEY',
  'UPSTREAM_ERROR',
  'UPSTREAM_TIMEOUT',
  'CLIENT_ABORTED',
  'INTERNAL',
] as const;

export type ObservabilityCategory = (typeof OBSERVABILITY_CATEGORIES)[number];

/** §12.2 健康窗口。与 §6 `StatsWindow` 不同：观测面**没有** `15m`。 */
export type ObservabilityWindow = '60s' | '5m' | '1h';

export type ObservabilitySeverity = 'warn' | 'error';

// ── §12.2 健康指标 `GET /api/observability/health`（只读，实时算） ──────────

/**
 * 契约 §12.2 的 `traffic.latencyMs`：`usage_logs.latency_ms` 的**最近秩**分位（nearest-rank，不做插值）。
 * `samples = 0` 时两个分位是 `null` —— **不是 0**（把「没有样本」画成「0ms 延迟」是造假）。
 */
export interface ObservabilityLatency {
  p50: number | null;
  p99: number | null;
  samples: number;
}

/** §12.2 `traffic.*`：与 §6 `overview` **同一份 SQL、同一口径**，但这里是观测面自己的响应体。 */
export interface ObservabilityTraffic {
  qps: number;
  /** 0..1 小数。`requests=0` 时后端给 `successRate=1` 是**约定而非断言** ⇒ 调用方仍须自行显示「无流量」。 */
  successRate: number;
  requests: number;
  errors: number;
  tokens: TokenBuckets;
  latencyMs: ObservabilityLatency;
}

/** §12.2 `keys.items[]` 单项（与 §3 Key 的 `health` / `cooldownUntil` / `consecutiveFailures` 同源）。 */
export interface ObservabilityKeyItem {
  keyId: string;
  maskedKey: string;
  upstreamId: string;
  health: KeyHealth;
  cooldownUntil: Iso8601 | null;
  consecutiveFailures: number;
  /** 第四轴，**与 `health` 正交**：没钱的 key 完全可以是 `health="healthy"`（§20.1）。 */
  depleted: boolean;
}

/** §12.2 `keys.*`：`total` 与三个分档计数同源（`key_runtime`，新鲜度 ≤1s）。 */
export interface ObservabilityKeys {
  total: number;
  healthy: number;
  cooling: number;
  disabled: number;
  /**
   * 透支计数（§12.2 / §20.1）。**不与上面三分相加**（`healthy + cooling + disabled = total`），
   * 它是一根**正交轴**：一把 `healthy` 的 key 可以同时进这一格。
   * 相加会把 `total` 读大一倍，而多出来的那些"key"根本不存在。
   */
  depleted: number;
  /** 全量 key 明细（无分页）。 */
  items: ObservabilityKeyItem[];
}

/** §12.2 `db.*`：`ok` 是**真跑一次** `SELECT 1` 的结果，不是"连接对象还在"。取不到的两列是 `null`。 */
export interface ObservabilityDb {
  ok: boolean;
  schemaVersion: number;
  fileSizeBytes: number | null;
  walSizeBytes: number | null;
  queryMs: number;
}

/** §12.2 `events.byCategory[]` 单项。只列**出现过**的分型，**不补 0**（与 §6 时间轴补 0 不同）。 */
export interface ObservabilityEventBucket {
  category: ObservabilityCategory;
  severity: ObservabilitySeverity;
  count: number;
  lastAt: Iso8601;
}

/** §12.2 `events.*`：`dropped` 是**进程启动以来**的累计丢弃数（不是窗口内）—— 丢事件不许静默。 */
export interface ObservabilityEvents {
  total: number;
  dropped: number;
  byCategory: ObservabilityEventBucket[];
}

/**
 * §12.2 `assistant.*`：内置助手独立计量。**进程内计数、重启归零、不落表**；
 * 计入 `keys.*` 健康，**不计入 `traffic.*`**（不写 `usage_logs`，不污染业务 QPS / 成功率）。
 */
export interface ObservabilityAssistant {
  requests: number;
  errors: number;
  tokens: TokenBuckets;
}

/** `GET /api/observability/health?window=` 的 200 响应（契约 §12.2）。 */
export interface ObservabilityHealth {
  generatedAt: Iso8601;
  /** 后端回显**实际**生效的窗口（解析规则同 §6，上限 24h）。 */
  window: ObservabilityWindow;
  uptimeSec: number;
  startedAt: Iso8601;
  traffic: ObservabilityTraffic;
  keys: ObservabilityKeys;
  db: ObservabilityDb;
  events: ObservabilityEvents;
  assistant: ObservabilityAssistant;
}

/** §12.2 健康快照（`gateway_health_snapshots`）：每 60s 一条，是**当时算出来的历史**，不允许事后重算。 */
export interface ObservabilityHealthSnapshot {
  id: string;
  ts: Iso8601;
  windowSec: number;
  qps: number;
  successRate: number;
  requests: number;
  errors: number;
  /** 样本为 0 时是 `null`，**不是 0**。 */
  p50Ms: number | null;
  p99Ms: number | null;
  keys: {
    total: number;
    healthy: number;
    cooling: number;
    disabled: number;
  };
  dbOk: boolean;
  errorCount: number;
}

/** §12.3：响应在 §0.3 分页信封之上**追加** `range`，回显**实际**生效的窗口（前端按回显渲染，不自算）。 */
export interface ObservabilityPaged<T> extends Paged<T> {
  range: { from: Iso8601; to: Iso8601 };
}

/** §12.3 错误事件查询的一行（§12.1 `GatewayErrorEvent` 的读面投影）。 */
export interface ObservabilityErrorEvent {
  id: string;
  ts: Iso8601;
  /** 关联键（§6 `x-request-id`）。本列上线前的历史行为 `null`。 */
  requestId: string | null;
  severity: ObservabilitySeverity;
  category: ObservabilityCategory;
  /** 最终回给客户端的 HTTP 状态；客户端断开写 `499`（该值只存在于事件流）。 */
  status: number;
  gatewayCode: string | null;
  failureReason: FailureReason | null;
  endpoint: string;
  /** 未过鉴权（401）恒为 `null`（§12.1 产出边界 2）。 */
  model: string | null;
  upstreamId: string | null;
  keyId: string | null;
  /** `****后4位`；没有"哪一把 key"可言时产出侧写 `****`（退化形态），不是 `null`。 */
  keyMasked: string | null;
  /** v1.17.2 新增：客户端腿——网关 key 掩码，仅已过鉴权的拒绝（组级 429/403）；401 恒 null。 */
  clientKeyMasked: string | null;
  /** v1.17.2 新增：来源腿——调用方 socket 层 IP（永不读 XFF）。 */
  sourceIp: string | null;
  /** v1.17.2 新增：401 且带 Bearer 时入站废 key 的 sha256 前 8 hex；其余恒 null。 */
  invalidKeyFingerprint: string | null;
  /** v1.17.2 新增：尝试明细 JSON 串（掩码+因由+状态码），仅 attempts>0 的终态；上限 16 项。 */
  attemptTrail: string | null;
  stream: boolean;
  upstreamStatus: number | null;
  /** **真实**上游尝试次数（`0` = 一次都没发出去）。 */
  attempts: number;
  candidates: number | null;
  latencyMs: number | null;
  /** 已脱敏 + 截断 512 字符的人类可读归因。只读展示，绝不当 HTML 渲染。 */
  message: string | null;
}

/** §12.3 `GET /api/observability/errors` 的过滤参数。`category` 是**逗号分隔多值**（最多 9）。 */
export interface ObservabilityErrorQuery extends PageQuery {
  from?: Iso8601;
  to?: Iso8601;
  category?: string;
  severity?: ObservabilitySeverity;
  upstreamId?: string;
  keyId?: string;
  model?: string;
  requestId?: string;
}

/** §12.3 `GET /api/observability/health/snapshots` 的过滤参数（默认最近 6h）。 */
export interface ObservabilitySnapshotQuery extends PageQuery {
  from?: Iso8601;
  to?: Iso8601;
}

// ── §13 内置 AI 助手聊天 `POST /api/assistant/chat`（v1.2.0） ─────────────

export type AssistantRole = 'system' | 'user' | 'assistant';

/** 一轮对话里的一条消息。多轮上下文由**客户端**原样回传（服务端无状态、不落库）。 */
export interface AssistantMessage {
  role: AssistantRole;
  content: string;
}

/**
 * §13.1 结构化取数参数 —— 逐字段复用 §12.3 白名单，**不造第二套口径**。
 * 省略 = 纯闲聊、不注入日志。
 */
export interface AssistantLogContext {
  window?: ObservabilityWindow;
  /** 带时区 ISO8601；与 `to` 跨度 > 24h 时服务端收窄并回 `truncated`（**不报 400**）。 */
  from?: Iso8601;
  to?: Iso8601;
  /** 逗号分隔多值（最多 9）。 */
  category?: string;
  severity?: ObservabilitySeverity;
  upstreamId?: string;
  keyId?: string;
  model?: string;
  requestId?: string;
}

export interface AssistantChatRequest {
  /** 至少 1 条；空/缺失 → 400 INVALID_PARAM。 */
  messages: AssistantMessage[];
  /**
   * 本轮助手使用的站内模型名（契约 §13.1 / v1.10.0）。省略 / 空串 = 用装配侧缺省模型。
   * 取值面 = 站内已启用模型 × 已启用上游（与后端校验同一判据）；不在集合内 →
   * `400 INVALID_PARAM`（`details.field="model"`），不静默回落。
   */
  model?: string;
  logContext?: AssistantLogContext;
}

/** §13.2 citation：服务端派生的注入事件引用（不是从模型输出解析 id）。 */
export interface AssistantCitation {
  id: string;
  ts: Iso8601;
  /** 事件可能没有码值（如 499 客户端断开）→ `null`。 */
  gatewayCode: string | null;
  category: string;
  severity: ObservabilitySeverity;
  /** 未过鉴权的请求恒为 `null`（§12.1 产出边界）。 */
  model: string | null;
  /** 已脱敏 `message` 再截 120 字符 —— 可直接渲染的最小可读标签。 */
  summary: string;
}

/**
 * §13.2 SSE 帧（**恰好一个终止帧**）。
 * `seq` 单请求内从 1 起单调递增；「重试」= 新请求 = 从 1 重来。
 */
export type AssistantFrame =
  | { kind: 'delta'; seq: number; text: string }
  | { kind: 'done'; seq: number; truncated: boolean; citations: AssistantCitation[] }
  | {
      kind: 'error';
      seq: number;
      /** §10 网关码值，零新增枚举。 */
      code: string;
      message: string;
      /** §10 表里该码值的 HTTP 状态，**不是**本次 SSE 响应状态（流已开恒 200）。 */
      status: number;
      /** 仅 429 两类带；其它为 `null`。 */
      retryAfterSec: number | null;
    };

// ── §15 供应商账号面（TierFlow） ───────────────────────────────────────────
//
// **消费锚（§15.12，三个字段级事实，判据唯一）**
// 1. 「这个上游有没有账号面」的唯一判据是 `Upstream.supplier ∈ SUPPLIER_ACCOUNT_KINDS`
//    （辅助函数 `hasSupplierAccountPanel`；自 v1.14.0 起该集合含 `'tierflow'` 与 `'tokenrhythm'`）。
//    **不 parse `baseUrl`、不查域名、不猜**，也**不要**把判据写成对某一家供应商的等值比较 ——
//    接入第二家时等值比较不会报错，只会让新供应商静默没有入口。
//    判"是哪一家"（决定按钮文案、表单项）时才用 `asSupplierKind` 取到具体 kind。
// 2. 批量任务的逐行结论**只读 `result.items`**，且只在**终态**读（`succeeded` / `failed`）。
//    它最多 500 行，`itemsTotal` 是截断前的真实行数、`truncated` 说明明细被截。
//    本期**没有**分页，前端不得自己造一个"下一页"。
// 3. `SupplierAccount` DTO 是**穷尽**的：自 v1.13.0 起这一格里多了 `egressId` —— 它答的是
//    「这个账号**自己绑了谁**」（配置事实，`supplier_accounts` 的列）。**出口池的实时状态**
//    （在线 / 冷却 / 出口 IP）仍然只有 §7 的 `egress_*` 帧一条读面，而本期那两帧**不发射**
//    ⇒ 池的健康在管理面上仍无数据可读。两者不是一件事，**别合并渲染**。
//
// **凭据纪律**：本文件里所有 `identifier` / `keyMasked` 都是**掩码**；
// 唯一进入系统的明文密码走 `POST /api/supplier-accounts/import` 的请求体，且**只进不出**。

/** §15.1 `credentialSource`：回答「会话过期后能不能自动重登」。与 `hasSession` **正交**。 */
export type SupplierCredentialSource = 'password' | 'session';

/** §15.1 账号状态。`unknown` = **从未成功查询过**，不是"正常"的同义词。 */
export type SupplierAccountStatus = 'active' | 'login_failed' | 'session_expired' | 'unknown';

/**
 * §15.1 `SupplierAccount`。列表项与详情**共用同一形状**。
 *
 * 金额一律 int **分**；上游给的是 quota 或**浮点元**，换算**全在后端**，前端不做任何除法。
 */
export interface SupplierAccount {
  id: string;
  upstreamId: string;
  supplier: string;
  /** **掩码**手机号 / 邮箱。真值不出后端，前端也不得试图还原。 */
  identifier: string;
  username: string | null;
  uid: string | null;
  status: SupplierAccountStatus;
  /** 面向人的一句话，只放供应商错误码或通用原因，**不含凭据**。 */
  statusMessage: string | null;
  /** 分；`null` = 未知 ≠ 0。 */
  balanceCents: Cents | null;
  /** 最近一次**真的查到**余额的时刻。查失败**不动它** —— 否则会渲染成"刚查过"，而事实是没查到。 */
  balanceUpdatedAt: Iso8601 | null;
  /** 归属本账号、**已入池**的 key 数。 */
  keyCount: number;
  /** `keyCount` 中 `unlimited=1` 的**子集**（不额外相加）。 */
  unlimitedKeyCount: number;
  /** 只拿到掩码、**进不了池**的 key 数（对账用）。**不得与 `keyCount` 相加成"key 总数"**。 */
  maskedKeyCount: number;
  /** **恒为数组**：上游给的是 `all_subscriptions: []`，单数对象表达不了"没有套餐"。 */
  subscriptions: SupplierSubscription[];
  /** 「能不能自动重登」由它回答。**不得**用 `hasSession` 反推。 */
  credentialSource: SupplierCredentialSource;
  /** 只回答**有无**，会话值永不出后端。 */
  hasSession: boolean;
  sessionExpiresAt: Iso8601 | null;
  /**
   * §15.1 v1.13.0 新增（**非破坏**）：该账号绑定的出口。`eg_` 前缀**不透明 id** —— 只当键用，
   * 前端**不得解析它的内容**（Tier 2 换形状时不该变成一次前端改造）。
   *
   * **`null` = 未绑定、走宿主出口** —— 这是**配置事实**，不是「未知」、不是「不可用」（§16.7）。
   * 它答的是「这个账号自己绑了谁」，**不是**「这个出口现在活着吗」（池的健康只有 §7 帧一条读面）。
   *
   * 写入口 = `PATCH /api/supplier-accounts/:id`（`egressId` + `revision`，乐观锁）。
   */
  egressId: string | null;
  /** 见 `UpstreamKey.depleted`：与 `status` **正交**的资金事实（§20.1 / §20.6）。 */
  depleted: boolean;
  depletedAt: Iso8601 | null;
  /** 账号只可能是 `'balance'` / `null` —— 没有「所属账号欠费」这种东西（§20.6）。 */
  depletedReason: DepletedReason | null;
  revision: number;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

/** §15.1 套餐摘要。**挂账号、不建成 key**（ADR-0018 决策 7）。 */
export interface SupplierSubscription {
  subNo: string;
  planTitle: string | null;
  planSlug: string | null;
  amountTotalCents: Cents | null;
  amountUsedCents: Cents | null;
  paidCents: Cents | null;
  /**
   * 套餐赠送的基础额度总额，**单位是 Token 个数**（Bo 2026-10-12 定死：调用基础模型时扣减，
   * 1M = 100 万 Token）。契约 §15.1 按原值透传、无 `Cents` 后缀即证据 —— **不是钱，不得折元**。
   */
  basicTokenTotal: number | null;
  /** 同上口径：已消耗的 Token 个数。 */
  basicTokenUsed: number | null;
  status: string | null;
  source: string | null;
  startAt: Iso8601 | null;
  endAt: Iso8601 | null;
  /**
   * **三态**：`true` / `false` 是上游明确给了；`null` = 上游**根本没这个字段**。
   * 合并成两态等于把"供应商没告诉我们"当成"不会自动续费" —— 替对方下了结论。
   */
  autoRenew: boolean | null;
  hasKey: boolean;
  /** 套餐 key **只有掩码、永不进池**。 */
  keyMasked: string | null;
  updatedAt: Iso8601;
}

/**
 * §15.2 `GET /api/supplier-accounts/subscriptions` 的一行 = 套餐摘要 **加上"它是谁的"**。
 *
 * 归属字段**只放掩码**：扁平列表不知道自己属于谁，而不给归属的列表在读的人眼里
 * 是一串没有主语的编号，对账时第一句话就是"这是哪个号的"。
 */
export interface SupplierSubscriptionRow extends SupplierSubscription {
  accountId: string;
  /** **掩码**。与 §15.1 同一条纪律。 */
  accountIdentifier: string;
  upstreamId: string;
}

export interface SupplierAccountListQuery extends PageQuery {
  upstreamId?: string;
  status?: SupplierAccountStatus;
  /** §20.8：透支锁存筛选（与 `status` 正交，可并用）。 */
  depleted?: boolean;
  q?: string;
}

/**
 * §15.2 `PATCH /api/supplier-accounts/:id`（v1.13.0，账号绑出口 / ADR-0029）。
 *
 * `egressId` 是**目标出口**：**`null` = 解绑、回宿主出口**（合法值，不是「清空成未知」）；
 * `revision` **必填**（§0.2 乐观锁）。判据顺序由服务端定死：**活性校验 → 乐观锁 → 值未变短路**
 * —— 出口不存在 / 已 `retired` ⇒ `400 INVALID_PARAM`（`details.field = 'egressId'`），
 * `revision` 不符 ⇒ `409 REVISION_MISMATCH`（带 `expected` / `actual`）；
 * 值未变 = **空操作**（不推 `revision`、不发 `change_log`）。
 */
export interface SupplierAccountSetEgressRequest {
  egressId: string | null;
  revision: number;
}

/** §15.2 `POST /api/supplier-accounts/import`。**本端点只收密码型凭据**；会话型不走 HTTP（§15.9）。 */
export interface SupplierImportRequest {
  upstreamId: string;
  /** 「手机号,密码」行文本。逐行校验在服务层 —— 它要按行给「第 3 行缺密码」这种原因。 */
  text?: string;
}

/**
 * v1.16.4 `POST /api/supplier-accounts/import-sessions`（仅 TokenRhythm）。
 *
 * `text` 每行一枚 `tr_session`。这是唯一把会话明文送进管理面的入口 —— 业主显式接受
 * "自用项目、值过一次 HTTP"的代价；前端仍不把值写进任何本地存储 / 日志 / 错误提示。
 */
export interface SupplierSessionImportRequest {
  upstreamId: string;
  /** 每行一枚 Cookie（`tr_session=…; Path=/`、裸 value、`Cookie:` 前缀均可）。 */
  text?: string;
}

/** 四个批量端点共用的「打谁」参数。`ids` 省略 = 该上游全部账号。 */
export interface SupplierBatchRequest {
  upstreamId: string;
  ids?: string[];
}

/** §15.13 `POST /api/supplier-accounts/rotate-key`：重置套餐专属 key（v1.9.0，ADR-0022）。
 *  `subNo` 省略 = 各目标账号**最新到期**的套餐（`end_at` 最大，`NULL` 排最后）。 */
export interface SupplierRotateKeyRequest extends SupplierBatchRequest {
  subNo?: string;
}

/** §15.2 `POST /api/supplier-accounts/keys`：批量新建 key 并入池（**本节的目的是这个**）。 */
export interface SupplierKeysRequest extends SupplierBatchRequest {
  /** 1..10，越界**在本次 HTTP 里就 400**（不变成一个立刻失败的异步任务）。 */
  count?: number;
  namePrefix?: string;
  unlimited?: boolean;
  quotaCents?: Cents | null;
  /** 空数组与省略同义，两者都归一化为 `NULL` = 不限模型。 */
  models?: string[] | null;
  label?: string | null;
}

/**
 * §15.3 `action` 七值，每个都必须有生产者（不留"枚举里有、没人发"的空值）；
 * `rotate` 见 §15.13，`import` 见 v1.16.4 Cookie 粘贴导入。
 */
export type SupplierBatchAction =
  | 'login'
  | 'relogin'
  | 'refresh'
  | 'create'
  | 'sync'
  | 'rotate'
  /** v1.16.4：只登记会话，没有发生登录。 */
  | 'import';

/** 逐行结果的一行。**不含任何凭据** —— `keyMasked` 是掩码，`keyId`/`tokenNo` 是内部标识。 */
export interface SupplierBatchItem {
  accountId: string | null;
  /** **掩码**；这一行没能解析出账号时为 `null`。 */
  identifier: string | null;
  action: SupplierBatchAction | null;
  ok: boolean;
  /** 供应商错误码原样（如 `LOGIN_INVALID_CREDENTIALS`）或本契约错误码。 */
  code: string | null;
  message: string | null;
  keyId: string | null;
  keyMasked: string | null;
  tokenNo: number | null;
}

/**
 * §15.3 批量任务 result（四个批量端点共用形状）。
 *
 * 不变量：`ok + failed + skipped = total`。
 */
export interface SupplierBatchResult {
  done: number;
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  /** `items` 截断前的**真实行数**。 */
  itemsTotal: number;
  /** `items` 超过 500 行时为 `true` —— UI **必须**说出"逐行明细已截断"。 */
  truncated: boolean;
  items: SupplierBatchItem[];
  hintCode: HintCode | null;
  hint: string | null;
}

/**
 * §15.2 `SupplierTestResult`（连接自测）。与 §2 `BalanceTestResult` 同口径三条：
 * **永不写库**、业务性失败一律 `200 + ok:false`、`raw` 是上游原样而 `parsed` 才是结论。
 */
export interface SupplierTestResult {
  ok: boolean;
  accountId: string;
  /** **掩码**。 */
  identifier: string;
  /** 未能发出请求时为 `0`（`null` 会让人以为是"没记录"，事实是"没发生"）。 */
  httpStatus: number;
  durationMs: number;
  /** 本次是否为验证密码而**真实登录过** —— 让"这次测得慢"可解释。 */
  loginAttempted: boolean;
  /** **换算后**的结论：`balanceCents` 是分，取不到就是 `null`。 */
  parsed: SupplierTestParsed;
  /** 上游原样，已抹掉所有凭据出现并截断。**禁止读这里的数字当金额渲染**。 */
  raw: unknown;
  errorCode: string | null;
  hintCode: HintCode | null;
  hint: string | null;
}

export interface SupplierTestParsed {
  balanceCents: Cents | null;
  /** 换算比（**比例，非金额**）。保留是为了诊断"换算比是不是被供应商改了"。 */
  quotaPerUnit: number | null;
  subscriptionCount: number | null;
}

/** 状态 → 人话。`unknown` 那一格刻意不写"正常"。 */
export const SUPPLIER_STATUS_TEXT: Record<SupplierAccountStatus, string> = {
  active: '正常',
  login_failed: '登录失败',
  session_expired: '会话过期',
  unknown: '未查询过',
};

// ── §16.7.2 出口池（Tier 2 出口代理，v1.7.1） ────────────────────────────────
//
// 这是「Upstream 之外的第 10 类资源对象」，与供应商账号面**完全独立**：账号面回答
// 「这些号能不能登录」；出口面回答「流量从哪个 IP 出去」。两者唯一的交集是
// `supplier_accounts.egress_id` 那一列（v1.13.0 起**已进 `SupplierAccount.egressId` 读面**，
// 写入口 = `PATCH /api/supplier-accounts/:id` 的请求体 `egressId`）。
//
// 三条与账号面同源、但**必须分开写**的纪律：
// 1. 明文凭据**只进不回**：`username` / `password` 只在 POST/PATCH 请求体里出现一次，
//    响应只回 `authSet`（推导值）。所以没有「查看已设凭据」这种入口。
// 2. `lastTestOk` 是**三态**：`null` = 未测。**未知 ≠ 失败**（同 §0.2 纪律）。
// 3. 退役**不删行**：`retiredAt` / `retiredReason` 回池后**不清**（历史可读性）。

/** §16.7.2 单轴生命周期。只滤 `active`，不存在「启用且已退役」组合态。 */
export type EgressLifecycle = 'active' | 'retired';

/** 退役原因。**必带** —— 没有原因的退役半年后没人判断得了它能不能删。 */
export type EgressRetiredReason = 'replaced' | 'manual';

/**
 * §16.7.2 `EgressProxy`（全字段）。`secret`（aes-256-gcm BLOB）**不出任何响应体**，
 * 只在 `authSet` 里以布尔推导值露头。
 */
export interface EgressProxy {
  /** `eg_` 前缀，不透明键。**退役不删行** ⇒ 它比 IP 活得久。前端不得解析其内容。 */
  id: string;
  /** 唯一。同名冲突 → `409 CONFLICT`（`details.field = 'name'`）。 */
  name: string;
  /** 只放 `scheme://host:port`，**归一化后唯一**；不含 `user:pass@`、查询串、锚点。 */
  url: string;
  region: string | null;
  note: string | null;
  status: EgressLifecycle;
  retiredReason: EgressRetiredReason | null;
  retiredAt: Iso8601 | null;
  /** **推导值**：凭据是否已设。明文永不出后端。 */
  authSet: boolean;
  /** 最近一次 `/test` 时刻；`null` = 未测。 */
  lastTestAt: Iso8601 | null;
  /** **三态**：`null` = 未测（未知 ≠ 失败）。 */
  lastTestOk: boolean | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface EgressProxyListQuery {
  status?: EgressLifecycle;
}

/** §16.7.2 `POST /api/egress`。凭据**只在这一次请求里出现**，落盘即加密、不回显、不落日志。 */
export interface EgressProxyCreateRequest {
  name: string;
  url: string;
  username?: string;
  password?: string;
  region?: string | null;
  note?: string | null;
}

/**
 * §16.7.2 `PATCH /api/egress/:id`（任意子集，空 body → 200 行未变）。
 *
 * 凭据是**整体换**、不是子集更新（密码无法子集更新）：`username` + `password`
 * **都非空**才落 `secret`；**都为空** = 清除凭据（`authSet` 从 `true` 回到 `false`）；
 * 一空一非空 = **不落**（避免落一个登不上去的半份凭据）。
 */
export interface EgressProxyPatchRequest {
  name?: string;
  region?: string | null;
  note?: string | null;
  username?: string;
  password?: string;
}

/** §16.7.2 `POST /api/egress/:id/test`。`egressIp` 只在 `ok` 时非 null。 */
export interface EgressProxyTestResult {
  ok: boolean;
  /** 回显端点（`api.ipify.org`）观测到的出口 IP；失败为 `null`。 */
  egressIp: string | null;
  latencyMs: number;
  /** HTTP 状态或错误 message，**不含凭据**。 */
  error: string | null;
}

// ── §18 接入信息 ────────────────────────────────────────────────

/**
 * §18 `GET /api/access-info`（v1.12.2，只读、无副作用、零新存储）。
 *
 * 契约刻意**不回**任何完整 URL（`gatewayUrl`/`adminUrl` 不存在）：服务端只知道
 * 端口与绑定地址，不知道公网 host —— `0.0.0.0`/`127.0.0.1` 都是监听语义，不是
 * 可访问地址。URL 拼接责任在前端：`(publicHost ?? window.location.hostname) + 端口`，
 * **禁止**把 `hostGateway`/`hostAdmin` 直接拼给用户（契约 §18 响应表逐行口径）。
 */
export interface AccessInfo {
  gateway: { scheme: string; portGateway: number; hostGateway: string };
  admin: { scheme: string; portAdmin: number; hostAdmin: string };
  /** env `PUBLIC_HOST`（默认空 = null）。对外基址覆盖值（不带 scheme），不落库。 */
  publicHost: string | null;
  /** `ADMIN_WEB_DIST` 非空即 true；前端据此提示「生产直开 :4001」还是「先起 Vite」。 */
  adminWebDistEnabled: boolean;
}

// ── §19 消费面 `/api/console/*`（ADR-0034） ────────────────────────────────

/**
 * §19.2 `GET /api/console/session` 的响应。
 *
 * 与 `SessionInfo` **不是同一个东西**，尽管字段有重叠：这个端点只对
 * `/api/console/**` 前缀生效（§19.1），且多两个消费面专有的字段
 * （`role` / `groupId`）。`groupId === null` = 账号还没有被分配到组 ——
 * 此时四个读端点回空/降级 + `assigned: false`，写端点回 `400`（`field=groupId`），
 * **都不是 500**（ADR-0034 决策 5 / ADR-0038 决策 1）。
 */
export interface ConsoleSession {
  username: string;
  role: UserRole;
  groupId: string | null;
  expiresAt: Iso8601;
}

/**
 * §19.3 `GET /api/console/keys` 的响应。元素形状**逐字复用 §4 `GatewayKeyDto`**
 * （契约 §19.3：不新增字段、不改名）。
 */
export interface ConsoleKeys {
  groupId: string | null;
  keys: ConsoleKeyItem[];
  /** `false` = 未分配组（此时 `keys` 恒为空）。前端据此显示"你还没有被分配到组"。 */
  assigned: boolean;
  /**
   * 自助签发的把数上限（v1.15.9 / ADR-0038）。**服务端的事实，不是前端的一条文案**：
   * 置灰「签发」按钮、算"还能签几把"用的都是这个数。
   *
   * 为什么不让前端写死 10：那要求前端复刻同一个数字，两份将来一定漂移 ——
   * 服务端改成 20 之后前端还按 10 拦，用户看到的是一个"点了必然失败"的按钮；
   * 反过来前端放宽了则会让人白填一次表单再吃 422。
   */
  keyLimit: number;
}

/**
 * §19.3 的 key 元素 = §4 那把 key 的**掩码形状**。
 *
 * 与管理面的 `GroupKeyIssued` 是**同一个东西少一个字段**：那个类型带
 * `gatewayKey`（明文，只在签发的 201 里出现一次），这里**没有**它 ——
 * 不是"前端不展示"，是响应体里压根不存在这一列（§4 铁律 / ADR-0006：
 * 没有任何"再取回明文"的路径）。所以这不是裁剪出来的子类型，
 * 是两份不同的 DTO，共用一个 `maskedKey` 口径。
 */
export interface ConsoleKeyItem {
  id: string;
  /** `****后4位`。 */
  maskedKey: string;
  /**
   * 这把 key 的名字（v1.15.9）。`null` = 没起名。
   *
   * 这一格是 v1.15.9 把签发权下放到消费面的**直接后果**：一个组最多 10 把 key，
   * 而它们共用同一份配额池，用户唯一能分辨"哪把是给哪个客户端的"的东西就是它 ——
   * 没有它，10 把 `****9f3c` 在界面上是同一种东西的十个副本。
   */
  label: string | null;
  createdAt: Iso8601;
}

/**
 * §19.3b `POST /api/console/keys` 的 201 响应（v1.15.9）。
 *
 * **这是消费面唯一的明文出口**，形状与 §4 的 `GroupKeyIssued` 逐字相同
 * （同一把 key 的同一份四格 + `label`）。库里只存 sha256 摘要，
 * 此后没有任何端点能取回 `gatewayKey` —— 所以调用方必须在**这一帧**把它交给用户。
 */
export interface ConsoleKeyIssued {
  id: string;
  /** **仅此一次**的明文（以 `gw-` 开头）。不缓存、不落 localStorage。 */
  gatewayKey: string;
  maskedKey: string;
  label: string | null;
  createdAt: Iso8601;
}

/**
 * §19.3b `GET /api/console/quota` 的响应（v1.15.9）。
 *
 * **每一格都是 §4 `GroupDto` 那些字段的透传**，消费面不新造第二个口径
 * （同一件事算两遍 = 两份将来一定漂移的数字）。所以页面上这几个数
 * 与管理面组列表里同一个组的数**必须一字不差**，包括 `null` = 不限、
 * `0` = 一点都不能用这两个截然不同的意思。
 */
export interface ConsoleQuota {
  /** `null` = 未分配组，此时其余各格见下（`rpm`/`tpm`/`dailyQuota` 也是 `null`）。 */
  groupId: string | null;
  assigned: boolean;
  /** 每分钟请求数上限。`null` = **不限**（不是 0）。 */
  rpm: number | null;
  /** 每分钟 token 上限。`null` = **不限**。 */
  tpm: number | null;
  /** 日 token 配额。`null` = **不限**。 */
  dailyQuota: number | null;
  /** 今日已用 token（与 `todayUsage.tokens` 同一个数，两格都回是为了不让前端去猜用哪个）。 */
  dailyQuotaUsed: number;
  todayUsage: { requests: number; tokens: number; costCents: number };
}

/**
 * §19.4 `GET /api/console/usage` 的响应 —— **与 §6 `GET /api/stats/usage` 逐字相同**，
 * 只多一层"恒按本组收窄"。所以类型直接复用 `UsageStats`，本文件不为它建第二个名字。
 *
 * `groupBy` **不接受 `group`**：消费面恒按本组收窄，按组分箱只会得到一根恒等的线
 * （契约 §19.4；传它 → 400，enum 里没有这个值）。
 */
export type ConsoleUsage = UsageStats;

/**
 * §19.4 的查询参数 —— **`UsageQuery` 少一个枚举值、且没有 `groupId`**。
 *
 * 两处裁剪都是契约裁的，不是前端省事：
 * - `groupBy` 去掉 `group`（消费面恒按本组收窄，按组分箱只会得到一根恒等的线）；
 * - **没有 `groupId` 字段**。归属恒来自服务端会话，`?groupId=` 传了也被忽略
 *   （判据：构造别组 id 回的仍是本组）。类型上就没有这个字段，
 *   调用方就写不出"我想看别组"的代码。
 *
 * `from` / `to` / `bucket` 三个必填项与 §6 同口径（`UsageQuery` 是 `Partial`，
 * 这里把三个必填的重新钉成必填）。
 */
export interface ConsoleUsageQuery {
  from: string;
  to: string;
  groupBy: Exclude<UsageGroupBy, 'group'>;
  bucket: UsageBucket;
}

/** §19.6 `GET /api/console/models` 的响应。 */
export interface ConsoleModels {
  models: ConsoleModel[];
}

/**
 * §19.6 的模型元素 —— **刻意不是 §5 `ModelProfile`**。
 *
 * 消费面看不到的东西一样都不带：`upstreamId`（上游归属）、`price`（计费口径）、
 * `availableKeyIds`（谁在服务这个模型）、`revision`（乐观锁语义）全是管理面概念。
 *
 * **逐字对齐服务端响应**（v1.15.8 订正）：`{id, name, displayName, type,
 * capabilities, contextLength}`。两处此前的漂移，都**不是**漏了几个字的形状：
 * - 曾多写一个 `enabled: boolean` —— 服务端从第一天就没回过它（SQL 判据恒
 *   `enabled = 1`，回一个恒真字段只会教人处理一个不存在的三态）。而它不 `undefined`
 *   就为真：页面拿它做的每个判断**全部反转**（每个模型都显示「已停用」、
 *   「只看可用」把列表清空），**这正是一个会骗人的信号**。
 * - 曾漏写 `name` —— 而 `name` 恰恰是**唯一有用的那个字段**：`id` 是档案行号
 *   （`mdl_*`），§10 的请求体 `model` 字段填的是**名字**，网关热路径上没有
 *   "行号→名字"的映射。少写 `name` 就等于没有可调用的值可给用户。
 *
 * **没有 `enabled`，所以页面也不该有"停用"这个概念**：能出现在这里的就是可用的
 * （集合 = §5 enabled 判据 ∩ 本组授权，§19.6）。
 * 判据与 §10 `/v1/models` **同一份**：用户端看到的集合必须与网关实际准入的集合一致。
 */
export interface ConsoleModel {
  id: string;
  /** 调用时 `model` 字段填它（不是 `id`）—— §10 的请求键是模型名。 */
  name: string;
  displayName: string | null;
  type: string;
  capabilities: string[];
  contextLength: number | null;
}

// ── §19.7 管理面用户端点（ADR-0034） ──────────────────────────────────────

/**
 * §19.7 的用户行。**与 `SessionInfo` / `ConsoleSession` 都不是同一个东西**，
 * 尽管三个都有 `role`：那两个是"我自己是谁"，这个是"账号表里的某一行"。
 *
 * **没有 `password` 也没有 `passwordHash`** —— 不是前端挑了字段显示，是响应体里
 * 压根没有（服务端读面一律不 SELECT `password_hash`，契约 §19.7）。
 * 所以这一页**没有"重置密码"入口**。〔v1.15.9 订正那个理由：当时写的是"改口令的端点
 * 不存在，要换口令只能删了重建"——那前半句已不成立（`POST /api/auth/password` 存在，
 * 见 §1），后半句仍然成立且**因为另一个理由**：那个端点改的恒是**会话本人**，
 * 管理员没有任何路径去改别人的口令。所以"管理员帮用户重置密码"这个能力
 * 在服务端真的没有，而不是"端点没做"—— 前者是订正后仍然正确的判据。
 * 用户自己改密码的入口在两个外壳的账号菜单里（`ChangePasswordModal`）。〕
 */
export interface UserDto {
  username: string;
  role: UserRole;
  /** 归属组 id。`null` = 未分配 —— 该用户进消费面会看到"你还没有被分配到组"。 */
  groupId: string | null;
  displayName: string | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

/**
 * §19.7 `POST /api/users` 的请求体。
 *
 * `password` 是**唯一一次**以明文进入系统的机会（§4 同一条纪律）：建完之后
 * 服务端只留散列，任何端点都取不回。所以表单必须让人**当场抄走** ——
 * 这也是本页唯一的明文出口，与用户组的 `gatewayKey` 同一形状。
 */
export interface UserCreateRequest {
  username: string;
  password: string;
  role: UserRole;
  groupId?: string | null | undefined;
  displayName?: string | null | undefined;
}

/**
 * §19.7 `PATCH /api/users/:username` 的请求体（v1.15.6 / ADR-0035 决策 2）。
 *
 * **只有一个字段，且必填。** `groupId: null` 是一个有意义的值（= 退回未分配），
 * 与"不发这个字段"不是一回事 —— 后者服务端回 400：省略字段的 PATCH 等于一次
 * "什么都不做却写一条 `user.update` 审计"的请求，而那条审计会说"有人改了这个用户的
 * 归属"，其实什么都没改。
 *
 * `role` / `password` / `displayName` **刻意不在这里**：类型上就发不出去。
 * 服务端也会静默忽略它们（schema 只列 `groupId`）—— 两处都不是漏校验，
 * 是"只开一个字段"这个决定在两个位置各写了一遍。
 */
export interface UserUpdateRequest {
  groupId: string | null;
}
