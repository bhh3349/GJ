// 管理面响应 DTO —— 与 docs/api-contract.md（v1.0-frozen）逐字段对齐。
//
// 这些接口是**契约的代码化身**：改这里就是改契约，必须同时改 docs/api-contract.md 并补 ADR。
// 所以每个对象上方都标了契约小节号，方便 review 时逐条比对。
//
// 布尔一律 true/false（不是 0/1），可空一律 `| null`（不是 undefined）——
// JSON 里不出现 undefined 键，前端拿到的字段集合是稳定的。

import type { BalanceQueryTemplate, BalanceUnit } from '../db/balance-query.js';
import type { DepletedReason } from '../db/depletion.js';

/**
 * 契约 §2 余额查询失败引导码（ADR-0012 §4）。
 *
 * **不是错误码**：不进 `ERROR_CODES`、不映射 HTTP 状态 —— "查不到余额"不是 HTTP 层的失败，
 * 刷新任务本身是成功的（`202` + `ok` 计数）。它只是给前端一个"该引导用户做什么"的指针。
 */
export type HintCode =
  | 'BALANCE_QUERY_UNSUPPORTED'
  | 'BALANCE_PARSE_MISMATCH'
  | 'BALANCE_UPSTREAM_UNREACHABLE'
  | 'BALANCE_AUTH_REJECTED'
  /**
   * v1.7.0 新增（契约 §2 / §14.2，ADR-0017 补遗 3）—— **判据 = HTTP 状态码 `429` 本身，不看标记头**。
   *
   * 上游真 429 与本地合成的 429（出口预算耗尽）**归同一行**：决策 4 让两者"证据面同形"，
   * 目的正是不按来源分型。**文案不得越证据** —— 429 无专用码、出口级与 key 级同形（§16.7 v1.6.2），
   * 故只能说"可能是出口预算、也可能是该 key 自身撞到限额"，**不得**写成"出口被限流"。
   */
  | 'BALANCE_EGRESS_RATE_LIMITED';

/** 契约 §2 内置余额查询 preset 的命中情况。**只读、可推导**，传了也不生效。 */
export interface BalancePresetDto {
  id: string;
  label: string;
  matchedBy: 'host';
  /** 当前真正生效的是它（即用户模板未启用） */
  effective: boolean;
}

/** 自测的查询来源。③（无查询方式）走不到 —— 那种情况直接 422。 */
export type BalanceTestSource = 'user-template' | 'preset';
export type BalanceTestErrorCode = 'UPSTREAM_UNREACHABLE' | 'PARSE_FAILED';

/** 契约 §2 自测解析结果。`balance` 是**分**；`null` = 取不到（与 0 严格区分）。 */
export interface BalanceTestParsed {
  balance: number | null;
  currency: string | null;
  remainingTokens: number | null;
  expiresAt: string | null;
  unit: BalanceUnit;
}

/**
 * 契约 §2 `BalanceTestResult` —— 两个自测端点共用（同步执行、**绝不写库**）。
 *
 * 业务性失败（上游不可达 / 取不到值）一律 `200` + `ok:false`：自测是**诊断**，
 * 前端要展示诊断结论，不该被错误分支吃掉。只有请求本身有问题才 4xx/5xx。
 */
export interface BalanceTestResult {
  ok: boolean;
  keyId: string | null;
  maskedKey: string | null;
  source: BalanceTestSource;
  presetId: string | null;
  /** 规范化后的 `协议//host/path`，已剥 query。绝不回显替换过 `{key}` 的 URL */
  endpoint: string;
  /** HTTP 状态；`0` = 没拿到响应（不可达 / 超时） */
  httpStatus: number;
  durationMs: number;
  parsed: BalanceTestParsed;
  /** 上游响应体，已抹掉明文 key 的所有出现并截断至 8KB。取值路径没配对时靠它定位 */
  raw: unknown;
  errorCode: BalanceTestErrorCode | null;
  hintCode: HintCode | null;
  hint: string | null;
  /** 契约 §2 v1.8.1：本地拒绝带回的 `Retry-After`（整数秒）；上游真 429 恒 `null`；`null` = 无建议 */
  retryAfterSeconds: number | null;
}

/** 契约 §0.3 分页信封 */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 契约 §2 Upstream */
export interface UpstreamDto {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  /**
   * 契约 §2 `supplier`（v1.4.0）。**只读语义、可写入**。
   *
   * 它存在的唯一目的是让 `baseUrl` 的 host **不被当成能力判据**：猜错会静默走错驱动器，
   * 而"这个上游有没有账号面"是管理员建上游时就知道的事，不该让代码去反推。
   */
  supplier: string | null;
  keyCount: number;
  enabledKeyCount: number;
  /** 分；全部未知时 null。组成 = `Σ账号 + Σ无账号归属的 key`（§15.6 / ADR-0018 决策 3） */
  totalBalance: number | null;
  /** `category='balance' AND unlimited=0 AND balance_cents IS NULL` */
  balanceUnknownKeyCount: number;
  /** `balanceKeyCount` 的子集：无限额度 key 数。**不额外相加、也不进未知计数** */
  unlimitedKeyCount: number;
  tokenPlanKeyCount: number;
  /** §15 账号数；通用上游恒 0 */
  accountCount: number;
  /** 账号级余额合计（分）；通用上游恒 null */
  accountsBalance: number | null;
  accountsBalanceUnknownCount: number;
  /** `totalBalance` 里由 key 贡献的那一半，供前端拆解合计；**不是**新增的一份钱 */
  keysBalance: number | null;
  balanceQuery: BalanceQueryTemplate;
  /** 该 upstream 的 baseUrl 命中的内置 preset；没命中为 null。用户模板启用后它仍返回，只是 `effective:false` */
  balancePreset: BalancePresetDto | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** 契约 §3 Key */
export type KeyCategory = 'balance' | 'token-plan';
export type KeyHealth = 'healthy' | 'cooling' | 'disabled';
export type FailureReasonCode =
  | 'AUTH_INVALID'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_BALANCE'
  | 'UPSTREAM_ERROR'
  | 'NETWORK';

export interface TokenPlanDto {
  remainingTokens: number;
  expiresAt: string | null;
}

export interface KeyDto {
  id: string;
  upstreamId: string;
  label: string;
  maskedKey: string;
  category: KeyCategory;
  enabled: boolean;
  weight: number;
  /**
   * 契约 §3 `unlimited`（v1.4.0）。无限额度 key 的 `balance` **恒为 `null`**（§15.7），
   * 于是它与"还没查到余额"在 JSON 上逐字同形。
   *
   * **`unlimited: true` 优先于任何负值渲染**（§15.6）：上游给这类 key 的 `remain_quota`
   * 是无意义的负数（如 `-331119`），前端若照抄会把"无限"画成"欠费"。
   */
  unlimited: boolean;
  /**
   * 契约 §3 `models`（v1.4.2）。模型白名单，取自 `upstream_keys.model_limits` CSV。
   *
   * `null` = 无白名单、不限模型；**`[]` 与 `null` 同义**（§3 / §5），故出口恒不出现 `[]`。
   * 与网关 `KeyConfig.models` 同源同口径 —— 两边读的是**同一个列**。
   * **只读**：`PATCH /api/keys/:id` 不收该字段；建 key 时由 §15.2 `keys` 入参给。
   */
  models: string[] | null;
  /** 分；null = 未知 */
  balance: number | null;
  balanceCurrency: string | null;
  balanceUpdatedAt: string | null;
  balanceSource: 'manual' | 'template' | null;
  tokenPlan: TokenPlanDto | null;
  /**
   * 透支锁存（契约 §20 / ADR-0041）。**第四根轴，不是第四个 `health` 值** ——
   * `enabled` 是管理员的配置意图、`health` 是网关运行态（重启归零），
   * `depleted` 是**落库的资金事实**，只有人工「重新启用」能清（§20.5）。
   *
   * 三者正交：`true` 的 key 完全可能同时 `enabled=true` + `health='healthy'`，
   * 它没被停用、没在冷却，只是网关不选它。**前端硬约束（§20.1）**：
   * `depleted=true` 时**不得只画三灯** —— 那等于把"没钱"渲染成"可用"。
   */
  depleted: boolean;
  /** 首次发现它付不起账的时刻（ISO8601 UTC）；null = 未锁存。**反复刷新不推新**（§20.3）。 */
  depletedAt: string | null;
  /** 锁存原因；null = 未锁存。`'balance'` = 自己余额/套餐余量耗尽，`'account'` = 所属账号欠费级联。 */
  depletedReason: DepletedReason | null;
  health: KeyHealth;
  cooldownUntil: string | null;
  consecutiveFailures: number;
  lastFailureReason: FailureReasonCode | null;
  lastFailureAt: string | null;
  todayTokens: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** 契约 §4 Group */
export interface GroupDto {
  id: string;
  name: string;
  gatewayKeyMasked: string | null;
  /** null = 不限 */
  rpm: number | null;
  tpm: number | null;
  dailyQuota: number | null;
  dailyQuotaUsed: number;
  todayUsage: { requests: number; tokens: number; costCents: number };
  keyCount: number;
  /**
   * 该组授权的模型**名**列表（契约 §4「模型授权」/ ADR-0037）。`null` = 不限（可用全部已启用模型）。
   *
   * **非破坏新增**（与 `gatewayKeyMasked` 同一呈现层）：管理面列表页要一列"这组能用什么"，
   * 所以它是 `GroupDto` 的字段，不是"只在详情端点给"。出口恒不为 `[]`（与 `null` 同义，
   * 见 `src/db/model-limits.ts` 那条冻结口径）。
   */
  authorizedModels: string[] | null;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 契约 §4 `GET`/`PUT /api/groups/:id/models` 里 `authorizedModels` 的展开项。
 *
 * 为什么和 `models` 并存：`models` 是**可写回的授权名列表**（PUT 的 body 就吃这个形状），
 * 展开项是**管理面要看的"这条授权落到哪个上游"**。只给展开行，前端得自己拼回名字列表；
 * 只给名字，界面上两条同名档案分不出来。**不给 `model_id` 裸值**：对界面无意义。
 */
export interface GroupModelEntryDto {
  id: string;
  name: string;
  upstreamId: string;
}

/** 契约 §4 `GET`/`PUT /api/groups/:id/models` 的响应体。 */
export interface GroupModelsDto {
  /** null = 不限（与 `[]` 同义，出口恒不为 `[]`） */
  models: string[] | null;
  authorizedModels: GroupModelEntryDto[];
}

/**
 * 契约 §4 网关 key 列表项（`GET /api/groups/:id/keys`）。
 *
 * 故意只有三个字段：`id` 是重置/吊销唯一能用的入参，`maskedKey` 给人眼认，
 * `createdAt` 是列表的排序键。**不回 `updatedAt`** —— 网关 key 的改法是删旧行插新行，
 * 它恒等于 `createdAt`，回一个永远相等的字段只会让调用方以为它可能不同。
 */
export interface GatewayKeyDto {
  id: string;
  maskedKey: string;
  /**
   * 人类给这把 key 起的名字（v1.15.9 新增，纯新增可空字段）。`null` = 没名字。
   *
   * 为什么现在才加：`gateway_keys.label` 这一列**建表起就在**（`src/db/schema.ts`），
   * 只是从来没人写、也没人读；而 v1.15.9 把签发权下放到消费面之后，
   * "我这三把 key 哪把是给哪个客户端的"在界面上必须有个答案 —— 否则用户只能
   * 靠 `****9f3c` 这四个字符认人，而他要认的是"那把是给我的桌面客户端的"。
   * 空串与纯空白在写入时归一化成 `null`（`normalizeLabel`），所以这里只有两态。
   */
  label: string | null;
  createdAt: string;
}

/**
 * 契约 §4 建组/签发网关 key 的响应：明文只在这里出现一次。
 *
 * `label` 与 `GatewayKeyDto` 同义（v1.15.9）。它**不是**"让调用方确认自己传了什么"——
 * 传进来的值会被 trim、空串会被收成 `null`，所以回的是**库里真正写下的那个值**，
 * 与随后列表里读到的那一格逐字相同。
 */
export interface GatewayKeyIssuedDto {
  id: string;
  gatewayKey: string;
  maskedKey: string;
  label: string | null;
  createdAt: string;
}

/** 契约 §5 Model */
export type ModelType = 'chat' | 'embedding' | 'image' | 'audio' | 'rerank';
// 与 `src/gateway/ports.ts` 的 `ModelType` 是**两份刻意的重复**（网关不得 import 管理面，AGENTS.md §8），
// 同 `KeyCategory` 的先例；两处注释互相钉住，改动必须成对。
export type ModelCapability = 'stream' | 'function_call' | 'vision' | 'json_mode';

/** 契约 §5 `capabilitiesSource`（v1.11.0 / ADR-0024）：能力那格的**写入来源**。 */
export type ModelCapabilitiesSource = 'manual' | 'probe';

export interface ModelDto {
  id: string;
  name: string;
  displayName: string | null;
  upstreamId: string;
  type: ModelType;
  capabilities: ModelCapability[];
  /**
   * v1.11.0 只读（`PATCH` 不收该字段）。与 `capabilities` 一起解读三态：
   * 非空 = 有该能力 / `[]` + `probe` = 问过、不支持 / `[]` + `null` = 还没问过。
   */
  capabilitiesSource: ModelCapabilitiesSource | null;
  /** v1.11.0 只读：最近一次能力探测的时刻（探测每次都刷，与是否覆盖 capabilities 无关）；null = 从没探测过 */
  lastProbedAt: string | null;
  contextLength: number | null;
  /** 两端都缺失时整体为 null；前端显示 — */
  price: { inputPer1k: number | null; outputPer1k: number | null } | null;
  availableKeyIds: string[];
  enabled: boolean;
  lastSyncedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** 契约 §5 任务对象 */
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export interface TaskDto {
  id: string;
  type: string;
  status: TaskStatus;
  progress: { done: number; total: number };
  message: string | null;
  result: unknown;
  startedAt: string;
  finishedAt: string | null;
}

/** 契约 §6 调用记录 */
export interface LogDto {
  id: string;
  ts: string;
  /** 关联键（契约 §6「关联键 `x-request-id`」/ ADR-0014）。本列上线前的历史行为 `null` */
  requestId: string | null;
  groupId: string | null;
  model: string | null;
  upstreamId: string | null;
  keyMasked: string;
  status: number;
  errorCode: string | null;
  tokens: { prompt: number; completion: number; total: number; isEstimated: boolean };
  latencyMs: number | null;
  ttfbMs: number | null;
  stream: boolean;
}

/** 契约 §6 审计 */
export interface AuditDto {
  id: string;
  ts: string;
  actor: string;
  ip: string;
  action: string;
  targetType: string;
  targetId: string | null;
  result: 'ok' | 'fail';
}

/** 契约 §1 会话 */
export interface SessionDto {
  username: string;
  expiresAt: string;
  /**
   * 身份（v1.15.0 / §19 / ADR-0034）。**纯新增可选字段** —— 老前端不读它，
   * 行为与 v1.15.0 之前逐字节相同。
   * 登录响应带它，是为了那一刻就能决定跳 `/admin` 还是 `/console`；
   * 多一次往返只会让"跳错地方"多一个时序窗口。
   */
  role?: 'admin' | 'user';
}

/** 契约 §19.2 消费面会话 */
export interface ConsoleSessionDto {
  username: string;
  role: 'admin' | 'user';
  /** 归属组；`null` = 未分配（此时四个读端点回空/降级 + `assigned:false`，写端点回 400，都不是 500） */
  groupId: string | null;
  expiresAt: string;
}

/** 契约 §19.3 消费面 key 列表 */
export interface ConsoleKeysDto {
  groupId: string | null;
  /**
   * 形状逐字复用 §4 `GatewayKeyDto`（含 v1.15.9 的 `label`）——
   * **只有掩码**，明文只在签发/重置那一次的 201 里出现，此后没有任何取回路径。
   */
  keys: GatewayKeyDto[];
  /** `false` = 未分配组；前端据此显示一句说明，而不是一张空表格 */
  assigned: boolean;
  /**
   * 自助签发的把数上限（v1.15.9）。前端据此把"签发新 key"按钮置灰并说明原因 ——
   * **上限是服务端的事实，不是前端的一条文案**：前端也能从 `keys.length` 推断出来，
   * 但那要求前端复刻同一个数字，复刻出来的那份将来一定与这一份漂移
   * （改了上限前端还按旧数拦，用户看到的是一个"点了必然失败"的按钮）。
   */
  keyLimit: number;
}

/**
 * 契约 §19.3b 消费面额度（v1.15.9）。
 *
 * **每一格都是既有字段的透传**，本面不新造第二个口径：
 * `rpm` / `tpm` / `dailyQuota` / `dailyQuotaUsed` 与 §4 `GroupDto` 逐字同源
 * （同一个 `todayUsage()` 的 SQL），`requests` / `tokens` / `costCents` 就是
 * §4 `todayUsage` 那三格。所以"用量页显示的数字"与"管理面组列表显示的数字"
 * 是同一句话，不是两份可能对不上的账。
 */
export interface ConsoleQuotaDto {
  /** `null` = 未分配组：此时其余各格是否回 0/`null` 由契约钉定 */
  groupId: string | null;
  assigned: boolean;
  /** 每分钟请求数上限；`null` = 不限 */
  rpm: number | null;
  /** 每分钟 token 上限；`null` = 不限 */
  tpm: number | null;
  /** 日 token 配额；`null` = 不限 */
  dailyQuota: number | null;
  /** 今日已用 token（与 `todayUsage.tokens` 同一个数，单列一格是为了不让前端去算） */
  dailyQuotaUsed: number;
  todayUsage: { requests: number; tokens: number; costCents: number };
}

/** 契约 §19.6 消费面模型列表 */
export interface ConsoleModelsDto {
  models: ConsoleModelDto[];
}

/**
 * §19.6 模型项。**刻意不带** `upstreamId` / `upstreamName` / 价格 / 余额：
 * 那些是管理员面的信息，对普通用户无用，且是上游信息的泄漏面。
 */
export interface ConsoleModelDto {
  id: string;
  name: string;
  displayName: string | null;
  type: string;
  capabilities: string[];
  contextLength: number | null;
}

/** 契约 §19.7 用户（管理面建删用） */
export interface UserDto {
  username: string;
  role: 'admin' | 'user';
  groupId: string | null;
  displayName: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 契约 §12 运维观测（v1.1.0）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 契约 §12.1 错误事件**分型**（9 值）。
 *
 * 这是本模块最容易踩的坑，所以写在类型注释里：它**不是错误码**。
 * 面向调用方的码在 §10 `GATEWAY_ERROR_CODES`（`gatewayCode` 字段），
 * 计入 key 失败的 5 类在 `FailureReasonCode`（`failureReason` 字段）。
 * 三者可以不同且都正确 —— 见契约 §12.1「三层口径不可互相替代」。
 */
export type GatewayErrorCategory =
  | 'CLIENT_REQUEST'
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'NO_AVAILABLE_KEY'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'CLIENT_ABORTED'
  | 'INTERNAL';

export type GatewayErrorSeverity = 'warn' | 'error';

/** 契约 §12.1 网关错误事件 */
export interface GatewayErrorEventDto {
  id: string;
  ts: string;
  /** 关联键（契约 §6「关联键 `x-request-id`」/ ADR-0014）。本列上线前的历史行为 `null` */
  requestId: string | null;
  severity: GatewayErrorSeverity;
  category: GatewayErrorCategory;
  /** 回给客户端的 HTTP 状态；客户端断开为 499（该值只存在于事件流，§10 未登记） */
  status: number;
  gatewayCode: string | null;
  failureReason: FailureReasonCode | null;
  endpoint: string;
  model: string | null;
  upstreamId: string | null;
  keyId: string | null;
  /** 永远只有 ****后4位；`null` = 这次失败与某把具体 key 无关 */
  keyMasked: string | null;
  stream: boolean;
  upstreamStatus: number | null;
  /** 真实上游尝试次数；`0` = 一次都没发出去（配置/密文侧问题的判据） */
  attempts: number;
  candidates: number | null;
  latencyMs: number | null;
  /** 已 scrub + 截断 512 字符 */
  message: string | null;
}

/** 契约 §12.2 延迟分位。`samples=0` 时两个分位是 `null`（未知 != 0）。 */
export interface LatencyPercentilesDto {
  p50: number | null;
  p99: number | null;
  samples: number;
}

/** 契约 §12.2 窗口流量指标。与 §6 `overview` 同一份 SQL、同一口径。 */
export interface HealthTrafficDto {
  qps: number;
  successRate: number;
  requests: number;
  errors: number;
  tokens: { prompt: number; completion: number; total: number };
  latencyMs: LatencyPercentilesDto;
}

/** 契约 §12.2 key 健康总览 */
export interface HealthKeysDto {
  total: number;
  healthy: number;
  cooling: number;
  disabled: number;
  /**
   * 已锁存的 key 数（§12.2 / §20.8 / ADR-0041）。
   *
   * **不参与 `healthy + cooling + disabled = total` 那套划分、不得相加**：那三个数是
   * 运行态的**三分**（互斥且穷尽），而透支是**另一根正交轴** —— 一把 key 会同时出现在
   * `healthy` 与 `depleted` 里。加它是必须的：不加的话健康页会把一批"永不接流量的 key"
   * 报成 `healthy`，那恰好是 ADR-0041 要消灭的"每个可见信号都说好"的故障形状。
   */
  depleted: number;
  items: {
    keyId: string;
    maskedKey: string;
    upstreamId: string;
    health: KeyHealth;
    cooldownUntil: string | null;
    consecutiveFailures: number;
    /** 该 key 是否已锁存。与 `health` **正交**（见 `HealthKeysDto.depleted`） */
    depleted: boolean;
  }[];
}

/** 契约 §12.2 DB 状态。**不返回库文件路径** —— 那是部署细节。 */
export interface HealthDbDto {
  /** 真跑一次 `SELECT 1` 的结果，不是"连接对象还在" */
  ok: boolean;
  schemaVersion: number;
  fileSizeBytes: number | null;
  walSizeBytes: number | null;
  queryMs: number;
}

/** 契约 §12.2 错误分型计数。**不补 0**：只列出现过的分型。 */
export interface HealthEventCategoryDto {
  category: GatewayErrorCategory;
  severity: GatewayErrorSeverity;
  count: number;
  lastAt: string;
}

export interface HealthEventsDto {
  total: number;
  /** 进程启动以来**累计**丢弃的事件条数（不是窗口内） */
  dropped: number;
  byCategory: HealthEventCategoryDto[];
}

/**
 * 契约 §12.2 / §13.4 `assistant` —— 内置助手的**独立计量**。
 *
 * 本进程内计数、重启归零、不落表（与 `events.dropped` 同属"本进程"口径，不是窗口内量）。
 * 之所以能在 §12.2 只读暴露：助手调用**计入 key 健康**（`keys.*` 含它的影响），但
 * **不计入业务流量口径**（不写 `usage_logs`，故 `traffic.*` 不含它）—— 值班必须能把
 * "助手把并发槽位吃满"与"业务流量打满"分开归因，否则会去查一个根本不存在的流量尖峰。
 *
 * 结构上等同于 `src/wiring/assistant-invoker.ts` 的 `AssistantMetrics`。刻意不复用那个类型：
 * 依赖方向是 wiring → api，dto 反向 import wiring 会绕出一个环（AGENTS.md §8）。
 * 两端形状由 §12.2 钉住，`server.ts` 以此为接线点，字段增删必须同时改契约。
 */
export interface AssistantMetricsDto {
  /** 助手调用总次数 */
  requests: number;
  /** 以 `error` 终止帧结束的次数 */
  errors: number;
  /** 累计 token（上游 usage 或字符估算） */
  tokens: { prompt: number; completion: number; total: number };
}

/** 契约 §12.2 `GET /api/observability/health` */
export interface HealthMetricsDto {
  generatedAt: string;
  /** 归一化后回显；前端按它渲染，不自算 */
  window: string;
  uptimeSec: number;
  startedAt: string;
  traffic: HealthTrafficDto;
  keys: HealthKeysDto;
  db: HealthDbDto;
  events: HealthEventsDto;
  /** 契约 §12.2 / §13.4：助手独立计量。未接线时为全 0（这是事实：本进程确实没跑过助手调用） */
  assistant: AssistantMetricsDto;
}

/** 契约 §12.2 / §12.3 历史健康快照。落当时算出来的结果，不事后重算。 */
export interface HealthSnapshotDto {
  id: string;
  ts: string;
  windowSec: number;
  qps: number;
  successRate: number;
  requests: number;
  errors: number;
  p50Ms: number | null;
  p99Ms: number | null;
  keys: { total: number; healthy: number; cooling: number; disabled: number };
  dbOk: boolean;
  errorCount: number;
}

/**
 * 契约 §14.3 自动同步的**生效参数回显**。
 *
 * 前端**不得**自算间隔 / 抖动 / 退避 —— 这些数只在这里给一次，前端抄了就会和
 * 后端漂成两个值（同 `HealthMetricsDto.window` 的"归一化后回显"纪律）。
 */
export interface BalanceSyncAutoDto {
  enabled: boolean;
  intervalMinutes: number;
  jitterRatio: number;
  backoffCapMinutes: number;
}

/** 契约 §14.3 每上游运行态。退避与单飞都在**进程内存**里，重启即归零（ADR-0010 同款降级）。 */
export interface BalanceSyncUpstreamStateDto {
  upstreamId: string;
  name: string;
  /** 该上游最近一条快照的 `ts`（上游级 `asOf`）；从未同步过为 `null` */
  lastSyncedAt: string | null;
  consecutiveFailures: number;
  /** 退避中非空；无排程（自动同步关闭）为 `null`。刻意不与 `nextRunAt` 求同：两者取的不是同一批上游 */
  nextAttemptAt: string | null;
  inFlight: boolean;
}

/**
 * 契约 §14.3 快照点。**自带 `t`** —— 本节刻意没有等长 `axis`：
 * 同步节奏本身不规则（抖动 + 退避 + 关闭期），造一条均匀轴就得发明不存在的点。
 */
export interface BalanceSnapshotPointDto {
  t: string;
  /** 分；`null` = 那一刻该上游 balance 类 key **全部未知**（不是 0） */
  totalBalanceCents: number | null;
  /** `balanceKeyCount` − unknown − unlimited。**三格加起来才是那一刻的 key 总数**（v1.6.0） */
  knownKeyCount: number;
  unknownKeyCount: number;
  /** v1.6.0：无限额度那一格。缺了它 `known + unknown` 会平白少一批 key 而无人能解释 */
  unlimitedKeyCount: number;
  tokenPlanKeyCount: number;
}

export interface BalanceSyncSeriesDto {
  upstreamId: string;
  /** 展示名来自快照行的 `upstream_name`：上游被物理删除后这一路仍可读 */
  label: string;
  points: BalanceSnapshotPointDto[];
}

/**
 * 契约 §14.4 漂移提示码。**地位同 `hintCode`**：不进 `ERROR_CODES`、
 * 不影响任何 HTTP 状态、不拦请求 —— 它只是"给管理员看一眼"的方向级提示。
 */
export type BalanceDriftCode = 'BALANCE_SPENT_WITHOUT_TRAFFIC' | 'BALANCE_UNCHANGED_WITH_TRAFFIC';

export interface BalanceDriftAlertDto {
  code: BalanceDriftCode;
  upstreamId: string;
  /** 相邻两次快照的较早 / 较晚时刻（判定的窗口两端） */
  from: string;
  to: string;
  /** 该窗口内本网关的 token 用量（上游级，不按 key 过滤） */
  usedTokens: number;
}

export interface BalanceDriftDto {
  since: string;
  /** 进程内计数，重启归零（`balance_drift_total{code}`），**不是**窗口内计数 */
  counts: Record<BalanceDriftCode, number>;
  /** 按 `to` 倒序，上限 20 条 */
  alerts: BalanceDriftAlertDto[];
}

/** 契约 §14.3 `GET /api/stats/balance/sync` */
export interface BalanceSyncStatusDto {
  auto: BalanceSyncAutoDto;
  /** 最近一次同步**完成**的时刻（任意触发都算）；从未同步过为 `null` */
  lastSyncedAt: string | null;
  lastTrigger: 'auto' | 'manual' | null;
  /** 自动同步下一次计划时刻（已含抖动）；关闭时为 `null` */
  nextRunAt: string | null;
  window: { from: string; to: string };
  upstreams: BalanceSyncUpstreamStateDto[];
  series: BalanceSyncSeriesDto[];
  drift: BalanceDriftDto;
}

// ---------------------------------------------------------------------------
// §15 供应商账号面（TierFlow）
// ---------------------------------------------------------------------------

/**
 * 契约 §15.1 `credentialSource`。
 *
 * 它回答的是**一个具体问题**「会话过期后能不能自动重登」：`password` = 库里有存档密码、能；
 * `session` = 只有会话、不能（§15.9 明示取舍）。前端**不自行推断** ——
 * 「有会话」和「能重登」是两件事，用 `hasSession` 推 `credentialSource` 一定推错。
 */
export type SupplierCredentialSource = 'password' | 'session';

/** 契约 §15.1 账号状态。`unknown` = **从未成功查询过**，不是"正常"的同义词。 */
export type SupplierAccountStatus = 'active' | 'login_failed' | 'session_expired' | 'unknown';

/** 契约 §15.1 套餐摘要。金额一律 int **分**；上游给的是 quota 或**浮点元**，换算全在后端。 */
export interface SupplierSubscriptionDto {
  subNo: string;
  planTitle: string | null;
  planSlug: string | null;
  amountTotalCents: number | null;
  amountUsedCents: number | null;
  paidCents: number | null;
  basicTokenTotal: number | null;
  basicTokenUsed: number | null;
  status: string | null;
  source: string | null;
  startAt: string | null;
  endAt: string | null;
  /**
   * **三态**：`true` / `false` 是上游明确给了；`null` 是**上游根本没这个字段**。
   * 合并成两态，等于把"供应商没告诉我们"当成"不会自动续费" —— 替对方下了结论。
   */
  autoRenew: boolean | null;
  hasKey: boolean;
  /** 套餐 key **只有掩码、永不进池**（ADR-0018 决策 7） */
  keyMasked: string | null;
  updatedAt: string;
}

/**
 * 契约 §15.2 `GET /api/supplier-accounts/subscriptions` 的一行 = `SupplierSubscriptionDto`
 * **加上"它是谁的"**。
 *
 * 为什么必须带归属：套餐列表是**跨账号**的（详情页里那个 `subscriptions[]` 天然知道
 * 自己属于谁，扁平列表不知道）。只给 `subNo` 的列表在读的人眼里是一串没有主语的编号，
 * 对账时第一句话就是"这是哪个号的" —— 而那正是这个端点存在的用途。
 *
 * 归属字段**只放掩码**（`accountIdentifier`），真值连这个端点也不出后端（§15.1）。
 */
export interface SupplierSubscriptionRowDto extends SupplierSubscriptionDto {
  accountId: string;
  /** **掩码**手机号 / 邮箱。与 §15.1 同一条纪律：真值不出后端 */
  accountIdentifier: string;
  upstreamId: string;
}

/** 契约 §15.1 `SupplierAccount`（`GET /api/supplier-accounts` 列表项与详情共用同一形状）。 */export interface SupplierAccountDto {
  id: string;
  upstreamId: string;
  supplier: string;
  /** **掩码**手机号 / 邮箱。真值不出后端 */
  identifier: string;
  username: string | null;
  uid: string | null;
  status: SupplierAccountStatus;
  /** 面向人的一句话。只放供应商错误码或通用原因，不含凭据 */
  statusMessage: string | null;
  /** 分；`null` = 未知 ≠ 0（ADR-0003） */
  balanceCents: number | null;
  /** 最近一次**真的查到**余额的时刻。查失败**不动它** —— 否则会渲染成"刚查过"，而事实是没查到 */
  balanceUpdatedAt: string | null;
  /** 归属本账号、**已入池**（`upstream_keys` 未软删）的 key 数 */
  keyCount: number;
  /** `keyCount` 中 `unlimited = 1` 的条数。**是子集，不额外相加**（§15.7 不变量） */
  unlimitedKeyCount: number;
  /** 只拿到掩码、**进不了池**的 key 数（对账用）。**不得与 `keyCount` 相加成"key 总数"** */
  maskedKeyCount: number;
  /** **恒为数组**：上游给的是 `all_subscriptions: []`，单数对象表达不了"没有套餐" */
  subscriptions: SupplierSubscriptionDto[];
  /** 「能不能自动重登」，由它回答；与 `hasSession` **正交** */
  credentialSource: SupplierCredentialSource;
  /** 只回答**有无**。会话值永不出后端 */
  hasSession: boolean;
  sessionExpiresAt: string | null;
  /**
   * **该账号绑定的出口**（§16.7 Tier 2 的写路径读面；v1.13.0 / ADR-0029）。
   *
   * `null` = **未绑定，走宿主出口** —— 那是**配置事实**，不是"未知"、也不是"不可用"
   * （§16.7 把 `null` 的两种来源分开写死：解析不出出口才是 fail-open 的那种 null）。
   * 非空时是一个 `eg_…` 不透明 id，**前端不得解析其内容**（§7 同一条纪律）：
   * Tier 2 之后它换成 `egress_proxies.id` 之外的东西也不必改前端。
   *
   * 只在写路径落地后才加这一格（v1.13.0）：在此之前 `egress_id` 写不进、也读不出，
   * 加字段等于给前端一个永远为 `null` 的假选项。出口**池的状态**（在线 / 冷却 / 出口 IP）
   * 仍然只有 §7 帧一条读面，不进本 DTO —— 这里只答"这个账号自己绑了谁"。
   */
  egressId: string | null;
  /**
   * **账号透支锁存**（§20.6 / ADR-0041）。`balance_cents < 10` 分（含 0 与负数）时置位，
   * 并**级联**其名下池内 key（那些 key 的 `depletedReason = 'account'`）。只有人工
   * `POST /api/supplier-accounts/:id/undeplete` 能清（§20.5）。`balanceCents = null`（未知）与
   * `unlimited` 账号**永不锁存**。
   *
   * 与 `status` **正交**：`status` 说的是会话/登录健康，透支是资金事实 ——
   * 一个 `status='active'` 且余额为 `0` 的账号是**正常态**，不是故障。
   */
  depleted: boolean;
  /** ISO8601 UTC；null = 未锁存。首次发现的那一刻，反复刷新不推新（§20.3） */
  depletedAt: string | null;
  /** 账号只可能是 `'balance'`（它自己就是源头，没有"所属账号欠费"这种级联）；null = 未锁存 */
  depletedReason: DepletedReason | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 契约 §15.2 `SupplierTestResult`（连接自测）。
 *
 * 与 §2 `BalanceTestResult` 同口径的三条：**永不写库**、业务性失败一律 `200 + ok:false`、
 * `raw` 是上游原样而 `parsed` 才是换算后的结论。
 *
 * `loginAttempted` 存在是为了让"这次测得慢"可解释：为验证存档密码而真登了一次的时候，
 * 耗时里含一次完整登录往返，否则运维会去查一个不存在的性能问题。
 */
export interface SupplierTestResult {
  ok: boolean;
  accountId: string;
  /** **掩码**手机号 / 邮箱。真值不出后端（§15.1） */
  identifier: string;
  /** 未能发出请求时为 `0`（同 §2：`null` 会让人以为是"没记录"，事实是"没发生"） */
  httpStatus: number;
  durationMs: number;
  /** 本次是否为验证密码而真实登录过 */
  loginAttempted: boolean;
  /** **换算后**的结论：`balanceCents` 是分。取不到就是 `null`，不是 0 */
  parsed: SupplierTestParsed;
  /** 上游原样。已抹掉所有凭据出现并截断；**前端禁止读这里的数字当金额渲染** */
  raw: unknown;
  errorCode: string | null;
  hintCode: HintCode | null;
  hint: string | null;
}

export interface SupplierTestParsed {
  balanceCents: number | null;
  /** 换算比（比例，非金额）。保留是为了诊断"换算比是不是被供应商改了" */
  quotaPerUnit: number | null;
  subscriptionCount: number | null;
}

/**
 * 契约 §15.3 批量任务逐行结果。
 *
 * `action` 的六个取值**每个都必须有生产者**（§15.3 明令不留"枚举里有、没人发"的空值）：
 * `login` = `import` 里新建账号的首登；`relogin` = 已有账号在 `import`/`refresh`/`keys` 中被重登；
 * `refresh` = `refresh`；`create` = `keys`；`sync` = `keys/sync`；`rotate` = §15.13 套餐 key 轮换。
 */
export type SupplierBatchAction =
  | 'login'
  | 'relogin'
  | 'refresh'
  | 'create'
  | 'sync'
  | 'rotate'
  /** v1.16.4：Cookie 粘贴导入 —— 只登记会话，没有发生登录。 */
  | 'import';

/** 一行。**不含任何凭据** —— `keyMasked` 是掩码，`keyId`/`tokenNo` 是内部标识。 */
export interface SupplierBatchItem {
  accountId: string | null;
  /** **掩码**；这一行没能解析出账号时为 `null` */
  identifier: string | null;
  action: SupplierBatchAction | null;
  ok: boolean;
  /** 供应商错误码原样（如 `LOGIN_INVALID_CREDENTIALS`）或本契约错误码 */
  code: string | null;
  message: string | null;
  keyId: string | null;
  keyMasked: string | null;
  tokenNo: number | null;
}

/** 契约 §15.3 批量任务 result（四个批量端点共用形状）。 */
export interface SupplierBatchResult {
  done: number;
  total: number;
  ok: number;
  failed: number;
  skipped: number;
  /** `items` 截断前的真实行数 */
  itemsTotal: number;
  /** `items` 超过 500 行时为 `true`（前端须提示"逐行明细已截断"） */
  truncated: boolean;
  items: SupplierBatchItem[];
  hintCode: HintCode | null;
  hint: string | null;
}


/**
 * 契约 §18 `GET /api/access-info`（v1.12.2 / ADR-0028）—— 部署自报口径。
 *
 * 只读、无副作用、**零新存储**：全部从 config 现读，不落库、不写审计。
 * 刻意**不含组 key**（明文只在签发响应出现一次；掩码走 §4 `GET /api/groups`），
 * 也**不含任何完整 URL**（服务端猜 host 必然猜错 —— 拼接责任在前端：
 * `(publicHost ?? window.location.hostname)` + 端口）。
 */
export interface AccessInfoDto {
  /** 网关面（OpenAI 兼容，对外服务）的监听信息 */
  gateway: {
    /** 恒 `"http"`：TLS 终结在反代，服务端不感知（§17 同口径） */
    scheme: 'http';
    /** config `PORT_GATEWAY`（默认 4000），**不写死** */
    portGateway: number;
    /** **绑定地址**（config `HOST_GATEWAY`，如 `0.0.0.0`）—— 是监听语义，**不是可访问地址** */
    hostGateway: string;
  };
  /** 管理面（REST + WS）的监听信息 */
  admin: {
    scheme: 'http';
    /** config `PORT_ADMIN`（默认 4001） */
    portAdmin: number;
    /** 绑定地址（config `HOST_ADMIN`，如 `127.0.0.1`）—— 同 `hostGateway`，不是可访问地址 */
    hostAdmin: string;
  };
  /** env `PUBLIC_HOST`（默认空 = `null`）。对外基址覆盖值，不带 scheme */
  publicHost: string | null;
  /**
   * 是否**配置了**管理面同源托管前端产物（§17 root 口径）：`ADMIN_WEB_DIST` 非空即 `true`。
   *
   * 这是**配置事实**，不是"此刻真的在托管" —— 目录缺失时运行期会退化为 404（不 fail-fast，
   * 见 `resolveWebDist`），那一条属启动日志的可诊断面；本字段不额外做一次 `stat` 去改口径。
   */
  adminWebDistEnabled: boolean;
}
