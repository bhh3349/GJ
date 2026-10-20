/**
 * 网关内核 - 对外依赖的「端口」
 * 冻结依据：AGENTS.md §8 架构边界（src/gateway 不得 import src/db / src/api）
 *
 * 为什么是接口而不是直接调 DB：
 *   1. 架构边界：跨边界实现由管家侧提供，网关只声明「我需要什么」
 *   2. 热路径零同步 DB 写：实现必须是**内存读**（解密后的 key 走进程内缓存，
 *      由 change_log / 1s 轮询刷新），端口签名刻意设计成同步，把异步挡在实现侧
 *   3. 可测：单测注入桩实现，不碰真库
 *
 * key 明文纪律：`UpstreamTarget.apiKey` 是本进程内唯一的明文出口，
 * 只允许进 Authorization 头；禁止进日志、错误体、异常 message、任何落盘路径。
 */

import type { FailureReason } from './types.js';

/** 上游调用所需的全部材料（明文仅供本次出站请求使用） */
export interface UpstreamTarget {
  upstreamId: string;
  /** 上游 Base URL，形如 https://api.example.com（末尾斜杠可有可无） */
  baseUrl: string;
  /** ⚠️ 明文。只准写入 Authorization 头 */
  apiKey: string;
  /**
   * 本次出站走的**出口 id**（ADR-0021 决策 5 的 E 接缝）。
   *
   * 取值 = `supplier_accounts.egress_id`（Tier 2 的**稳定 id**，`egress_proxies.id`，
   *        **原样透传、不过 `egressIdOfUrl`** —— 拿它去解析一个 id 会恒得 `null`，
   *        出口被整个丢掉 = 「一个出口零个桶 ⇒ 无上限」）
   *        ?? `egressIdOfUrl(baseUrl)`（Tier 1，没指定出口的直连流量仍占同一个桶）。
   *        `null` = 连 base URL 都解析不出 host ⇒ **fail-open**（不裁决、不加桶）。
   *
   * **在快照重建时算一次**，热路径只读：改成在 `resolve()` 里现算就是每次出站多一次
   * `new URL` + 一次台账查库，TTFB 直接崩（验收 6）。
   *
   * 必填**且可空**是刻意的 —— 与 `UsageLogEntry.requestId` 同一条理由：漏传在编译期报错。
   * 漏传若退化成 `undefined`，语义上与 `null`（放行、无上限）同形，而这正是 ADR-0021 点名的事故。
   */
  egressId: string | null;
  /** 这把 key 的供应商账号归属（`supplier_account_keys.account_id`）；通用上游 / 未入池 → `null` */
  accountId: string | null;
}

/** keyId → 出站材料；命中不到（密文缺失/已删）返回 null，由引擎跳过该 key */
export interface SecretResolver {
  resolve(keyId: string): UpstreamTarget | null;
}

/** 模型档案只读视图：`GET /v1/models` 必须与「已启用」集合逐项 0 差异（验收 4） */
export interface ModelCatalog {
  /** 已启用模型档案的客户端可见名（含别名映射的目标名由上游侧解析） */
  listEnabledModels(): Promise<ModelDescriptor[]>;
  /** 客户端模型名 → 上游真实模型名；未登记则原样透传 */
  resolveUpstreamModel(clientModel: string): string;
  /**
   * 客户端模型名 → 登记类别；**未登记**（或档案/上游已停用）返回 `null`。
   *
   * 与 `listEnabledModels()` 的差别是刻意的，两个就读口径各有各的验收：
   *   · `listEnabledModels` **实时读库**（验收 4 要求改一个 enabled 后 `/v1/models` 立刻变）；
   *   · `typeOf` **走快照**，因为它是**转发路径上的准入判据**，而快照就是选路判据
   *     （`UpstreamConfig.models` = 「谁登记了谁才可能被选到」）。热路径上不许有 SQL
   *     （`wiring/store.ts` 的明文/热路径纪律）。
   *
   * 两者**不会**打架：调用方拿到的名字如果因为 1s 窗口还没进快照，这里返回 `null` ⇒ 本闸放行，
   * 而同一个窗口里 `pool.getAvailableKeys(name)` 也建不出候选集 ⇒ 503。也就是说
   * **本闸永远不会拒掉一个路由器还能路由的名字**，只是那一秒退回旧行为（上游 404 透传），
   * 而不是收窄成"列表里有、打过去 400"。
   *
   * 同步签名是硬要求（同 `resolveUpstreamModel`）：把异步实现留给适配层，
   * 转发线程上一次 await 就是一次可观测的 TTFB 增量（验收 6）。
   */
  typeOf(clientModel: string): ModelType | null;
}

/**
 * 模型类别（契约 §5；库内闭集 `models.type` 的 CHECK 与之一字不差）。
 *
 * 为什么在网关侧**再写一份**而不 import 管理面的 `ModelType`：AGENTS.md §8 ——
 * `src/gateway` 不得 import `src/api`。与本文件同族的先例是 `KeyCategory`
 * （`types.ts` 与管理面 dto 各有一份，注释互相指名）。两处口径靠本句与
 * `src/api/dto.ts` 的对应注释互相钉住：改一处漏另一处，契约 §5 与本行的闭集就会打架。
 *
 * 值为 `image` / `audio` / `rerank` 的档案**建得出来但端点不实现**（501，见 routes.ts
 * 的 `UNSUPPORTED_PREFIXES`）—— 它们在这里出现只是因为 CHECK 允许，不代表可服务。
 */
export type ModelType = 'chat' | 'embedding' | 'image' | 'audio' | 'rerank';

export interface ModelDescriptor {
  id: string;
  /**
   * 模型类别（契约 §5 / ADR-0039）。路由层按 `(端点, 类别)` 准入的唯一依据 ——
   * 在此之前 `type` 只活在建档与展示里，从不进服务路径，于是任何登记过的名字
   * 都会被原样转发到上游的 `/embeddings`。
   */
  type: ModelType;
  /** 建档时间 ISO8601 UTC */
  createdAt: string;
  /** 归属，默认取上游名；仅用于 /v1/models 的 owned_by 字段 */
  ownedBy: string;
  /**
   * 模型能力（契约 §5 枚举 `stream | function_call | vision | json_mode`）。
   * 口径（契约 §10 v1.11.0）：`[]` 是「未探测 / 上游未给」，**不另立 null 语义**；
   * 与模型档案 `capabilities` 逐项 0 差异（验收 4 的字段面延伸）。
   * 只读透传：网关不判能力、不写档案，写入口只在管理面（probe / PATCH）。
   */
  capabilities: string[];
  /** 上下文长度；上游没给就是 null（契约 §5「缺失是 null 不是 0」，/v1/models 显示口径同款） */
  contextLength: number | null;
  /**
   * 上游 `supported_endpoint_types` 的独立只读字段（契约 §10 v1.11.0 登记）。
   * **本期恒 null = 未采集**（不并进 capabilities —— 端点类型不是模型能力，ADR-0024 备选 C）；
   * 采集是另一笔，届时只改实现侧取数，本形状不变。
   */
  endpointTypes: string[] | null;
}

/** 用户组配额（契约 §4 Group 对象；null = 不限） */
export interface GroupContext {
  groupId: string;
  name: string;
  enabled: boolean;
  rpm: number | null;
  tpm: number | null;
  dailyQuota: number | null;
  /**
   * 该组授权的模型**名**列表（契约 §4「模型授权」/ ADR-0037）；`null` = 不限（可用全部已启用模型）。
   *
   * 三件事写在这里，因为它们是这个字段的设计而不是实现细节：
   *   1. **实时读库**（`src/wiring/auth.ts`），**不进快照** —— group / gateway_key 本来就被
   *      刻意排除在 `SNAPSHOT_ENTITIES` 之外，鉴权与限流走实时点查，换来"改授权下一个请求生效"。
   *      授权是同一性质的属性，跟着 `GroupContext` 走。
   *   2. **判定按名字、不特判 `*`**：授权列表按字面匹配；通配符归 key 白名单的既有语义
   *      （§16.3 `matchesModel`），两层不混。
   *   3. **与 key 白名单是交集，不是替代**：组授权了 A、key 白名单没含 A，照样打不通。
   *      本字段只管"这一组的人许不许用"，管不到"哪把 key 能跑"（那是 `KeyConfig.models`）。
   */
  authorizedModels: readonly string[] | null;
  /**
   * **这把网关 key 的掩码**（`gateway_keys.masked_key`，`****后4位`；契约 §12.1 `clientKeyMasked` / ADR-0042）。
   *
   * 客户端腿的取值来源：鉴权已经查到 `gateway_keys` 行，掩码就在手边（不新增一次查询）。
   * **可选**是有意的：内部助手（`wiring/assistant-invoker.ts`）的合成组没有网关 key，
   * 消费侧按 `?? null` 处理即可，不必为它编一个假掩码。明文纪律不变 —— 这里只可能是掩码。
   */
  gatewayKeyMasked?: string | null;
}

/** 网关 key 明文 → 用户组上下文；未命中返回 null（实现侧用 sha256 摘要比对） */
export interface GatewayAuth {
  authenticate(gatewayKey: string): Promise<GroupContext | null>;
}

/**
 * 用量/调用日志出口。
 * 硬要求：`record()` 只做入队，**不得 await 落库**，否则 TTFB 被日志抖动（验收 8）。
 * 返回 Promise 是为了让实现能表达「队列满反压」，引擎不会 await 它。
 */
export interface UsageLogSink {
  record(entry: UsageLogEntry): void;
}

export interface UsageLogEntry {
  groupId: string;
  keyId: string;
  upstreamId: string;
  model: string;
  /** 客户端请求的模型名（可能与上游真实名不同） */
  clientModel: string;
  endpoint: string;
  stream: boolean;
  statusCode: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  isEstimated: boolean;
  /** 首字节耗时（ms） */
  ttfbMs: number;
  latencyMs: number;
  attempts: number;
  /** 失败原因（成功为 null） */
  failureReason: string | null;
  /**
   * 关联键（契约 §6「关联键 `x-request-id`」/ ADR-0014）。**必填**。
   *
   * 值来自同一次请求：入站头合法则沿用，否则在入站处重新生成（`src/util/request-id.ts`）。
   * 必填是刻意的 —— 漏传在编译期就报错，而不是上线后静默写一列 NULL。
   */
  requestId: string;
  at: string; // ISO8601 UTC
}

/**
 * 网关错误事件出口（契约 §12.1 / ADR-0013 §7）。签名由 ADR-0013 冻结。
 *
 * 与 `UsageLogSink` 的差别：用量是**每请求一条**，错误事件只在这条请求**失败**时产生，
 * 所以它是稀疏的 —— 但热路径纪律一模一样：`record()` 只入队，不落库、不 await。
 *
 * `category`（分型）与 `severity` **刻意不由网关传**：它们由实现侧按契约 §12.1 的映射表
 * 从 `gatewayCode` + `status` 派生。映射只有一个实现处，网关不需要理解分型概念，
 * 也就不会与契约漂移 —— 这是本端口最省事也最不容易出错的一点。
 */
export interface ErrorEventSink {
  record(entry: ErrorEventEntry): void;
}

export interface ErrorEventEntry {
  /** ISO8601 UTC，**网关侧时刻**；落库不重打时间 */
  at: string;
  /** 回给客户端的 HTTP 状态；客户端中途断开写 499（只存在于事件流，契约 §12.1） */
  status: number;
  /** 契约 §10 的码；网关自身未预期异常传 null → 实现侧归入 INTERNAL */
  gatewayCode: string | null;
  /** 与 key_runtime.last_failure_reason 同一套枚举；未触达上游传 null */
  failureReason: FailureReason | null;
  endpoint: string;
  /** 客户端请求的模型名；无模型概念（如 /v1/models）传 null */
  clientModel: string | null;
  /** 空串 = 「没有某把具体 key」可言（与 UsageLogEntry 同约定），实现侧转 null */
  keyId: string;
  /** 空串 = 同上 */
  upstreamId: string;
  stream: boolean;
  /** 上游返回的原始状态码；一次都没打到上游传 null */
  upstreamStatus: number | null;
  /** **真实**上游尝试次数；0 = 一次都没发出去（配置/密文侧问题的判据） */
  attempts: number;
  /** 本次候选 key 数；不适用传 null */
  candidates: number | null;
  latencyMs: number | null;
  /**
   * 关联键（契约 §6 / ADR-0014）。**必填**，与同一请求的 `usage_logs.request_id` 同值。
   *
   * 0 次真实尝试的两条终态（`429` 池饱和 / `503` 密文不可解，ADR-0011）**同样要传** ——
   * 那两条上游侧没有任何痕迹，这个键是唯一能把它们和产生它的那次调用对上的东西。
   */
  requestId: string;
  /**
   * 人类可读归因，可含上游原文。**实现侧负责脱敏与截断**（契约 §12.1），
   * 网关侧不要先自己抹 —— 两处都抹并不更安全，但两处规则不一致就会漏。
   */
  message: string | null;
  // ── v1.17.2 / ADR-0042：key 标识三腿四字段。全部可选 = 「没这腿就不填」，
  //    实现侧（sink）按缺省转 null —— 与 ErrorFacts 的「缺省即不知道」同一纪律。

  /** 客户端腿：网关 key 掩码，仅已过鉴权的拒绝（组级 429 / 403）填；401 恒不填（无组上下文） */
  clientKeyMasked?: string | null;
  /** 来源腿：调用方 socket 层 IP（`request.ip`，trustProxy:false 永不读 XFF）；取不到不填 */
  sourceIp?: string | null;
  /** 来源腿：401 且带了 Bearer 时，入站废 key 的 sha256 前 8 hex（归并撞库，不可反推） */
  invalidKeyFingerprint?: string | null;
  /**
   * 尝试明细：各把候选怎么死的（契约 §12.1 `attemptTrail`）。网关侧传 **keyId**（不是掩码 ——
   * 掩码归实现侧按 `maskOf` 统一映射，与 `keyMasked` 同一条纪律），每项 `{keyId, reason, status}`。
   * 只在真实尝试过的终态填；实现侧负责排序校验、上限 16、序列化与 scrub。
   */
  attemptTrail?: readonly { keyId: string; reason: string; status: number }[];
}
