// 消费面路由。契约 §19 / ADR-0034 / ADR-0038。
//
// 这个文件是**普通用户**（`role=user`）唯一能看到的东西。四条纪律：
//
//   1. **读端点全部是 GET；写端点只有 key 自助这一组（v1.15.9 / ADR-0038）。**
//      v1.15.0–v1.15.8 这里是"零写方法"，理由是把签发权下放给 `user` 等于组内
//      任一成员可无限增发、共烧同一个配额池（ADR-0034 决策 3）。**ADR-0038 订正
//      了那条**：1panel 的实测是"key 由用户自己发"，而"没有自助"的真实代价是
//      **整组的 key 生命周期卡在一个管理员身上**（要发一把就得找管理员，而管理员的
//      签发按钮在组列表里、与"这是我那个组的第几把"完全脱节）。
//      **护栏是下放的代价，不是可选项**：`KEY_SELF_ISSUE_LIMIT` 把持数钉在 10 把，
//      且写方法**仍然要过 CSRF**（闸门在鉴权前校验，消费面不豁免）。
//      明文纪律**一个字都没动**：明文只在签发（这里）与重置（管理面）的响应里
//      出现一次，此后没有任何取回路径 —— 这一组里**没有**"显示明文"的端点。
//   2. **数据归属只来自会话**，绝不来自请求参数。`?groupId=` 一律忽略 ——
//      那等于把"我能看哪个组"变成客户端可改的东西。写端点同一条：写入的
//      `group_id` 恒来自 `groupIdOf(req)`，body 里带 `groupId` 会被 schema 忽略。
//   3. **复用既有形状，不新造一份**。keys 复用 §4 `GatewayKeyDto`、
//      usage 复用 `computeUsage`、models 复用 §5 的启用判据、
//      quota 复用 `getGroup`（§4 `GroupDto` 的同一次计算）。
//      新造一份的失败形状不是"多写点代码"，是**两份口径将来一定漂移**
//      （ADR-0033 决策 2 的同一条理由，这里禁的是第二份形状）。
//   4. **删除/改名的越权判据是 404 不是 403**：`WHERE id = ? AND group_id = ?`
//      命中不到就 404 —— 403 会告诉调用方"这个 keyId 存在、只是不属于你"，
//      而那正是枚举别人 key 的反馈信号（§19.3 同一条）。
//
// 授面（谁能进这个文件的路由）在 `src/api/app.ts` 的闸门里判，不在这里判 ——
// 判据放闸门，新增路由不可能"忘了判作用域"。
//
// 闸门那一句**只判前缀、不判方法**（`inConsoleScope(path)`），所以本文件加写路由
// **不需要动闸门**；反过来说：这个前缀下**任何**写路由的授面就是"该组用户"，
// 所以新增写路由前必须先想清楚"这一下动的是不是他自己的组"，而不是先看闸门。

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  ConsoleKeysDto,
  ConsoleModelsDto,
  ConsoleQuotaDto,
  ConsoleSessionDto,
  GatewayKeyDto,
} from '../dto.js';
import type { ApiContext, AuthInfo } from '../app.js';
import {
  countGatewayKeys,
  deleteGatewayKey,
  getGroup,
  issueGatewayKey,
  listGatewayKeys,
  renameGatewayKey,
} from '../../db/repo/groups.js';
import { computeUsage, type UsageBucket, type UsageGroupBy, type UsageResult } from '../../db/stats.js';
import { ApiError } from '../errors.js';
import { auditWrite } from '../http.js';

/**
 * 消费面自助签发的把数上限（v1.15.9 / ADR-0038 决策 2）。
 *
 * **为什么必须有这个数**：ADR-0034 决策 3 拒绝下放签发权的理由是"组内任一成员可
 * 无限增发、共烧同一个配额池"。ADR-0038 决定下放，那就必须把"无限"这一半解决掉 ——
 * 否则那条理由原样成立，只是没人再提它。这个数字就是那条理由的具象化。
 *
 * **为什么是 10**：同一个组的 key 共享同一份配额池（RPM / TPM / 日配额），
 * 所以第 11 把 key 不带来任何新额度，只带来"我到底在用哪把"的混乱。10 把足够
 * 覆盖"每台设备一把 + 几个临时排查用"的真实场景，而再往上加这个数**不会**解决
 * 任何问题 —— 真需要更多的场景是"该拆组了"，那件事这一版不做。
 *
 * **为什么写死在代码里而不是配置项**：一个可配的上限在一次事故复盘里会变成
 * "当时是谁把它调成 200 的"。这个数不是运维旋钮，是这一版给"下放签发权"配的
 * 护栏宽度，改它应当是一次有理由的改动（改这里 + 改契约 + 说明为什么）。
 */
const KEY_SELF_ISSUE_LIMIT = 10;

/** §19.4 消费面用法：`groupBy` 不含 `group` —— 恒按本组收窄，按组分箱只会得到一根恒等的线。 */
const CONSOLE_GROUP_BY = ['key', 'upstream', 'model'] as const;
type ConsoleGroupBy = (typeof CONSOLE_GROUP_BY)[number];

interface UsageQueryParams {
  from: string;
  to: string;
  bucket: UsageBucket;
  groupBy: ConsoleGroupBy;
  upstreamId?: string | undefined;
  model?: string | undefined;
}

const usageQuerySchema = {
  type: 'object',
  required: ['from', 'to', 'bucket', 'groupBy'],
  properties: {
    from: { type: 'string' },
    to: { type: 'string' },
    bucket: { type: 'string', enum: ['1m', '5m', '1h', '1d'] },
    // 刻意**不含** 'group'：给消费面一个按 group 分箱的选项，只会产出恒等的一根线。
    // 列在 enum 里而服务端忽略它，是"一个看起来能选、选了没效果"的控件 —— 那比没有更糟。
    groupBy: { type: 'string', enum: [...CONSOLE_GROUP_BY] },
    upstreamId: { type: 'string' },
    model: { type: 'string' },
    // `groupId` **故意不出现在 schema 里**：带进来会被 Fastify 的 schema 校验静默剥掉，
    // 剥掉之后请求照常成功，调用方以为自己的过滤生效了（实际没有）。
    // 不声明 = 明确拒绝，而不是静默忽略。
  },
} as const;

/**
 * 取当前请求的会话身份。
 *
 * 统一走这一个函数而不是各端点直接读 `req.auth`：`req.auth` 为 null 只可能是
 * "这条路没走闸门"（比如有人把 console 路由注册到免鉴权前缀下）。
 * 那是**装配错误**，该在开发期就炸，而不是运行时给一个 undefined.username。
 */
function authOf(req: FastifyRequest): AuthInfo {
  const auth = req.auth;
  if (auth === null) throw new ApiError('UNAUTHORIZED', '未登录');
  return auth;
}

/**
 * 取当前会话的 groupId。
 *
 * 集中成这一个函数，是为了让"没有组"的降级**只有一个出口** ——
 * 三个端点都要处理它，各写一遍 `if (auth.groupId === null)` 的话，
 * 将来加第四个端点时漏一次，那个端点就在未分配用户面前 500。
 */
function groupIdOf(req: FastifyRequest): string | null {
  return authOf(req).groupId;
}

export function registerConsoleRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { db, config } = ctx;

  // §19.2 会话。回 role 与 groupId，前端据此决定显示什么、以及"未分配"时显示哪句话。
  app.get('/api/console/session', (req): ConsoleSessionDto => {
    const auth = authOf(req);
    return {
      username: auth.username,
      role: auth.role,
      groupId: auth.groupId,
      expiresAt: auth.expiresAt,
    };
  });

  // §19.3 本组 key 的**掩码**列表。明文没有"再取回"的路径（§4 / ADR-0006）。
  app.get('/api/console/keys', (req): ConsoleKeysDto => {
    const groupId = groupIdOf(req);
    if (groupId === null) {
      // 未分配组：回空 + assigned:false，让前端显示一句"你还没有被分配到组"。
      // 不是 404（没有"这个资源不存在"的语义），更不是 500。
      // `keyLimit` 照回：它是**这个端点的一条规则**，与调用方有没有组无关 ——
      // 未分配时回 null 会让前端多一个"拿不到上限"的分支，而那个分支没有对应的事实。
      return { groupId: null, keys: [], assigned: false, keyLimit: KEY_SELF_ISSUE_LIMIT };
    }
    const page = listGatewayKeys(db, groupId, { page: 1, pageSize: 200 });
    return {
      groupId,
      // 形状逐字复用 §4 GatewayKeyDto（id / maskedKey / label / createdAt）。
      // **不透传 page/pageSize/total** —— 消费面不需要翻页，而自助上限是 10 把，
      // 列表规模有了上界之后"翻页"这一层就更是纯粹的负担。
      keys: page.items,
      assigned: true,
      keyLimit: KEY_SELF_ISSUE_LIMIT,
    };
  });

  // ── §19.3b 自助签发 / 改名 / 吊销（v1.15.9 / ADR-0038）────────────────────────
  //
  // 三条路由的归属**全部来自会话**（`groupIdOf`），且**未分配组一律 400**
  // （不是 404 / 不是 500）：没有组就没有配额池，签出来的 key 打 /v1 会被
  // 网关判成"组不存在"—— 那是把一个必然失败的东西交给用户，比拒绝更坏。
  // 未分配组在**读**端点上是可读降级（回空 + assigned:false），在**写**端点上是
  // 明确的拒绝：读的失败是"看不到"（无害），写的失败是"签出一把废 key"（有害）。

  app.post<{ Body: { label?: string | null | undefined } }>(
    '/api/console/keys',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            // 可省 = 不起名。空串走 `normalizeLabel` 收成 null，schema 不拦它 ——
            // 拦的失败形状是"表单留空提交 → 400"，而那是一次完全正常的签发。
            label: { type: ['string', 'null'], maxLength: 100 },
            // `groupId` **故意不在 schema 里**：它会被 ajv 剥掉（同 §19.4 那条），
            // 剥掉之后请求照常成功、调用方以为自己指定了组 —— 不声明就是明确忽略。
          },
        },
      },
    },
    (req, reply) => {
      const groupId = groupIdOf(req);
      if (groupId === null) {
        throw new ApiError('INVALID_PARAM', '你的账号还没有被分配到用户组，无法签发 key', {
          field: 'groupId',
        });
      }
      // 护栏在**签发之前**判：先签再判的话，被拒的那一下也得回滚一次写
      // （`issueGatewayKey` 不返回事务句柄），而"签了再删"还会在库里留下一段
      // 没解释的 id 空洞与两条 change_log。
      const used = countGatewayKeys(db, groupId);
      if (used >= KEY_SELF_ISSUE_LIMIT) {
        // 422 而不是 400 / 409：请求本身完全合法（表单填得对、身份也对），
        // 挡下它的是**这个组的现状**（已经 10 把了）—— 与 §15.4 那条
        // "UNPROCESSABLE = 语义合法但业务拒绝" 同一条判据。
        throw new ApiError(
          'UNPROCESSABLE',
          `这个组已经有 ${used} 把 key，自助签发上限是 ${KEY_SELF_ISSUE_LIMIT} 把。要换掉不用的那把，请在列表里吊销它；要更多额度请联系管理员。`,
          { limit: KEY_SELF_ISSUE_LIMIT, used },
        );
      }
      const issued = issueGatewayKey(db, groupId, req.body?.label);
      // 审计动作**复用管理面那一套**（`gateway_key.issue`），不新造一个
      // `gateway_key.self_issue`：审计的问题是"谁在什么时候动过这把 key"，
      // 而"从哪个面动的"不是这个问题的一半 —— actor 已经回答了。
      // 拆成两个动作会让"某把 key 的全部历史"要按两个 action 查两次。
      // `detail` 只记掩码（§4 铁律：审计里永不出现明文）。
      auditWrite(db, req, config, {
        action: 'gateway_key.issue',
        targetType: 'group',
        targetId: groupId,
        detail: issued.maskedKey,
      });
      return reply.code(201).send(issued);
    },
  );

  app.patch<{ Params: { keyId: string }; Body: { label?: string | null | undefined } }>(
    '/api/console/keys/:keyId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['keyId'],
          properties: { keyId: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        body: {
          type: 'object',
          // `label` **不是 required**：`{}` 是一次合法的"不改名"，
          // 而把它设成 required 会让"清掉名字"必须传 `{label: ""}` 或 `{label: null}`
          // 两种写法之一 —— 两种写法都得支持，那就不如都不要求。
          properties: { label: { type: ['string', 'null'], maxLength: 100 } },
        },
      },
    },
    (req): GatewayKeyDto => {
      const groupId = groupIdOf(req);
      if (groupId === null) {
        throw new ApiError('INVALID_PARAM', '你的账号还没有被分配到用户组', { field: 'groupId' });
      }
      const updated = renameGatewayKey(db, groupId, req.params.keyId, req.body?.label);
      auditWrite(db, req, config, {
        action: 'gateway_key.update',
        targetType: 'group',
        targetId: groupId,
        // 名字能是空（`null`），所以这里不能只写 `updated.label` ——
        // 清掉名字的那一次会写成字符串 'null'。`JSON.stringify` 让 `null` 与
        // 字符串 `"null"` 在审计里长得不一样。
        detail: `keyId=${updated.id} label=${JSON.stringify(updated.label)}`,
      });
      return updated;
    },
  );

  app.delete<{ Params: { keyId: string } }>(
    '/api/console/keys/:keyId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['keyId'],
          properties: { keyId: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    (req, reply) => {
      const groupId = groupIdOf(req);
      if (groupId === null) {
        throw new ApiError('INVALID_PARAM', '你的账号还没有被分配到用户组', { field: 'groupId' });
      }
      deleteGatewayKey(db, groupId, req.params.keyId);
      auditWrite(db, req, config, {
        action: 'gateway_key.delete',
        targetType: 'group',
        targetId: groupId,
        detail: req.params.keyId,
      });
      return reply.code(204).send();
    },
  );

  // §19.3c 本组额度（v1.15.9）。**不新造一份计算**：直接读 §4 `GroupDto` 的那几格，
  // 它们来自 `todayUsage()` 的同一句 SQL。
  app.get('/api/console/quota', (req): ConsoleQuotaDto => {
    const groupId = groupIdOf(req);
    if (groupId === null) {
      // 未分配组：回 `null` 而不是 0 —— "没有配额"与"配额是 0"是两件事，
      // 前者是"你还没进组"，后者是"你今天一点都不能用"。回 0 会让前端把第一种
      // 情况渲染成第二种（一排 0/0 的进度条），而用户会去查"我为什么被限流了"。
      return {
        groupId: null,
        assigned: false,
        rpm: null,
        tpm: null,
        dailyQuota: null,
        dailyQuotaUsed: 0,
        todayUsage: { requests: 0, tokens: 0, costCents: 0 },
      };
    }
    const group = getGroup(db, groupId);
    if (group === null) {
      // 会话里的 groupId 指着一行不存在的组：组刚被管理员删掉、而这个会话还没刷新。
      // 回**未分配**那一形状（而不是 500）：对用户来说这就是"你暂时没有组"，
      // 而 500 会让他去报告一个不存在的问题。
      return {
        groupId: null,
        assigned: false,
        rpm: null,
        tpm: null,
        dailyQuota: null,
        dailyQuotaUsed: 0,
        todayUsage: { requests: 0, tokens: 0, costCents: 0 },
      };
    }
    return {
      groupId,
      assigned: true,
      rpm: group.rpm,
      tpm: group.tpm,
      dailyQuota: group.dailyQuota,
      dailyQuotaUsed: group.dailyQuotaUsed,
      todayUsage: group.todayUsage,
    };
  });

  // §19.4 本组用量。响应形状与 §6 `GET /api/stats/usage` 逐字相同 ——
  // 直接复用 `computeUsage`，不在这一侧重新定义 token / costCents 的口径。
  app.get<{ Querystring: UsageQueryParams }>(
    '/api/console/usage',
    { schema: { querystring: usageQuerySchema } },
    (req): UsageResult => {
      const groupId = groupIdOf(req);
      const { from, to, bucket, groupBy, upstreamId, model } = req.query;
      if (groupId === null) {
        // 未分配组：空轴 + 空 series。前端据此画一张空图 + 那句话，而不是报错。
        return { from, to, bucket, groupBy, axis: [], series: [], isEstimatedTokenCount: 0 };
      }
      return computeUsage(db, {
        from,
        to,
        bucket,
        groupBy,
        upstreamId,
        // **groupId 恒取会话的那一个**，请求里的（如果有）一律不采用。
        groupId,
        model,
      });
    },
  );

  // §19.6 模型广场。判据 = §5 `GET /api/models?enabled=true` 的同一判据
  // （`models.enabled = 1` 且其上游 `upstreams.enabled = 1`），与 §10 `/v1/models` 同源 ——
  // 用户端看到的"能用哪些模型"必须与网关实际准入的集合一致，否则又是一个会骗人的信号。
  app.get<{ Querystring: { page?: number; pageSize?: number } }>(
    '/api/console/models',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
          },
        },
      },
    },
    (req): ConsoleModelsDto => {
      // v1.15.8 / ADR-0037 决策 6：按**会话的组**收窄 —— 集合 = enabled 判据 ∩ 该组授权。
      // 收窄在服务端这一句 SQL 里做，不给前端过滤：前端过滤是"列表对了、集合没对"，
      // 而这里的理由与 §19.6 那句原文同一条 —— 与网关实际准入的集合一致，否则又是一个
      // 会骗人的信号（用户在广场上看得到、打过去 403）。
      // 未授权收缩的组（库里没有行）逐项不变：升级的零行为变更。
      // 未分配组的会话（groupId null）没有授权可言，照旧看到全部已启用模型。
      const groupId = groupIdOf(req);
      const rows = db
        .prepare(
          `SELECT m.id, m.name, m.display_name, m.type, m.capabilities, m.context_length
           FROM models m
           JOIN upstreams u ON u.id = m.upstream_id
           WHERE m.enabled = 1 AND u.enabled = 1
             AND (
               ? IS NULL
               OR NOT EXISTS (SELECT 1 FROM group_models gm WHERE gm.group_id = ?)
               OR EXISTS (SELECT 1 FROM group_models gm WHERE gm.group_id = ? AND gm.model_id = m.id)
             )
           ORDER BY m.name, m.id
           LIMIT ? OFFSET ?`,
        )
        .all(
          groupId,
          groupId,
          groupId,
          req.query.pageSize ?? 100,
          ((req.query.page ?? 1) - 1) * (req.query.pageSize ?? 100),
        ) as {
        id: string;
        name: string;
        display_name: string | null;
        type: string;
        capabilities: string;
        context_length: number | null;
      }[];

      return {
        models: rows.map((r) => ({
          id: r.id,
          name: r.name,
          displayName: r.display_name,
          type: r.type,
          // 库里是 JSON string[]；解析失败按空数组处理（老行可能是 '[]' 或畸形串）。
          // **不猜**：解析不出来就是"未知"，与 §5 的三态口径一致。
          capabilities: parseCapabilities(r.capabilities),
          contextLength: r.context_length,
        })),
      };
    },
  );
}

function parseCapabilities(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// 让 TypeScript 知道 UsageGroupBy 在这里被收窄过（schema enum 保证只有那三个值）。
export type { UsageGroupBy };
