// 网关适配层 - 共享 SQLite → 内存快照（四个端口里最重的那个实现）
//
// 边界依据：AGENTS.md §8 —— 适配器放 `src/gateway` 之外，网关内核只认 ports.ts 里的接口。
// 冻结口径：docs/api-contract.md §9（网关与共享 SQLite 同步靠 change_log + 1s 轮询兜底）
//
// 一次刷新读三样东西，之后全部从内存走：
//   1. 上游行 → `UpstreamConfig[]`（含该上游**登记并启用**的模型名，见下方「选路口径」）
//   2. key 行 → `KeyConfig[]` + 解密后的明文 + 出口归属（交给 secrets.ts 的缓存；三表 join 见 KEYS_SQL）
//   3. 已启用模型档案 → `/v1/models` 列表 + 用量落库时的价格换算
//
// 台账也是快照输入的一部分（那把 key 属于哪个账号 / 走哪个出口）。台账表**不在** SNAPSHOT_ENTITIES
// 的实体名里，所以它的写路径必须自己发一条 `'key'`（见 `db/repo/supplier-accounts.ts` 的两个绑定入口）
// —— 漏发不会报错，只会让 `accountId` 停在旧值上一直不动。
//
// 选路口径（本文件里唯一需要动脑子的地方）：
//   `UpstreamConfig.models` 取「该上游名下 enabled=1 的模型名」。
//   - 上游**一个档案都没有** → 传 null = 不限制。新装机、或只用 key 池不建档时，
//     行为与管理端当前一致（全部模型都试），不会因为"还没同步模型"就 503。
//   - 上游**有档案** → 只认档案里启用的那些：档案是管理员的业务判断，
//     他把某模型停用了，请求就不该再打到那个上游。
//   已知后果（已在回执里点名，不藏着）：一个**谁都没启用**的模型名会返回 503 NO_AVAILABLE_KEY，
//   而不是上游的 404 model_not_found。回滚方式是一行：把 models 恒置 null。
//
// 热路径纪律：`refresh()` 由 1s 定时器调用，`secrets.resolve()` / `maskOf()` / `costCentsOf()`
// 全是内存读；`/v1/*` 转发线程上**没有**任何 SQL。
//
// 明文纪律：明文只经 `secrets.update()` 进缓存，本文件不 log 它、不把它放进快照对象
// （`KeyConfig` 里没有 key 字段，这是刻意的）。

import { listEnabledGatewayModels } from '../db/repo/models.js';
import { changesSince } from '../db/repo/change-log.js';
// 编解码口径的唯一来源（`serializeModelLimits` / `parseModelLimits`）。
// 本网关读面与管理面读方（`KeyDto.models`）、写方（`createKey`）**共用这一份实现** ——
// 见 `src/db/model-limits.ts` 头注。本地不得再存一份解析。
import { parseModelLimits } from '../db/model-limits.js';
import type { Db } from '../db/database.js';
import type { ModelCatalog, ModelDescriptor } from '../gateway/ports.js';
import type { KeyCategory, KeyConfig, PoolSnapshot, UpstreamConfig } from '../gateway/types.js';
import { createSecretResolver } from './secrets.js';
import type { DbSecretResolver, SecretRow } from './secrets.js';

interface UpstreamRow {
  id: string;
  base_url: string;
  enabled: number;
}

interface KeyRow extends SecretRow {
  upstream_id: string;
  category: KeyCategory;
  enabled: number;
  weight: number;
  balance_cents: number | null;
  token_plan_remaining: number | null;
  token_plan_expires_at: string | null;
  model_limits: string | null;
  masked_key: string;
}

interface ChangeRow {
  seq: number;
  entity: string;
}

/** 上游的 key 才需要 base_url；只要没软删的行 —— 软删是"停用并留痕"，不该再出站 */
const UPSTREAMS_SQL = 'SELECT id, base_url, enabled FROM upstreams ORDER BY name, id';

/**
 * key 行 + 它的**账号归属**（ADR-0021 决策 5 的 E 接缝）。
 *
 * 这是本文件唯一一处跨到 §15 台账面的读，两个新列都只为出口面服务：
 *   · `account_id` → `EgressLimitedInput.subject.accountId`（限流计数按**账号**去重，
 *     否则"一个账号建 3 把 key"会把同一次限流数 3 遍）；
 *   · `account_egress_id` → 这把 key 从哪个出口出站（§16.7 Tier 2；NULL = 账号直连）。
 *
 * 谓词与 `src/db/balance.ts` 的 `UNOWNED_KEY` **逐字同形**（含 `account_id IS NOT NULL`）：
 * 两处口径一旦不一致，"这把 key 算谁的"会在余额页与网关快照里给出两个答案。
 *
 * 一对一是**由索引保证**的（`uq_supplier_account_keys_pooled`，见 schema.ts）：
 * 少了它，一次 fan-out 就会让同一把 key 在池里出现两遍 —— 放行量翻倍，
 * 而症状看起来像"路由算法抽风"。
 *
 * 也正因为那条部分唯一索引存在，这个 JOIN **不是** ADR-0021 警告的"裸 JOIN 后取首行"：
 * 它在结构上至多回一行（重建时拿到哪个出口是**确定**的，不随行序/重建次数漂移），
 * 而索引建不出来时 `migrate()` 直接 fail-closed、进程压根不开门。
 */
const KEYS_SQL = `
SELECT k.id, k.upstream_id, k.category, k.enabled, k.weight, k.balance_cents,
       k.token_plan_remaining, k.token_plan_expires_at, k.model_limits, k.masked_key, k.revision, k.secret,
       sak.account_id AS account_id,
       sa.egress_id   AS account_egress_id
FROM upstream_keys k
LEFT JOIN supplier_account_keys sak
       ON sak.pooled_key_id = k.id AND sak.account_id IS NOT NULL
LEFT JOIN supplier_accounts sa ON sa.id = sak.account_id
WHERE k.deleted_at IS NULL
ORDER BY k.created_at, k.id
`;

/**
 * `model_limits` CSV → `KeyConfig.models`：实现与口径都在 `src/db/model-limits.ts`
 * （§16.3 禁止同语义两处实现 —— 页面上白名单看得见、网关上不生效，正是那份漂移）。
 * `*` 原样透出 —— 通配语义归 `matchesModel()`（冻结件），这里不解释。
 */

const MAX_CHANGES_SQL = 'SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log';

/**
 * 会让**网关快照**失效的实体。
 *
 * `group` / `gateway_key` 是特意排除的：它们只影响鉴权（走实时读，见 auth.ts），
 * 与 key 池无关。而 `applySnapshot` 会把 token-plan key 的乐观扣减清零
 * （它假设"新快照里的余量已含历史消耗"），所以「跟配置无关的变更」不该触发重建 ——
 * 否则管理端改个组名就能把套餐扣减重置一次。
 */
const SNAPSHOT_ENTITIES: ReadonlySet<string> = new Set(['upstream', 'key', 'model', 'balance']);

export interface GatewayStore {
  /** 同步内存读的明文出口（硬约束：`resolve()` 不得查库/解密） */
  secrets: DbSecretResolver;
  /** `/v1/models` 与「客户端名 → 上游名」映射 */
  catalog: ModelCatalog;
  /** 当前快照（交给 `pool.applySnapshot`） */
  poolSnapshot(): PoolSnapshot;
  /** 当前快照里通过选路的 key 数（自检/manifest 用） */
  keyCount(): number;
  /** 落库用掩码；未知 keyId（如"全失败"那条终态日志）返回 `****` */
  maskOf(keyId: string): string;
  /** 用量落库的金额换算：分（int），单价未知按 0 计 */
  costCentsOf(upstreamModel: string, promptTokens: number, completionTokens: number): number;
  /** 拉 change_log 增量；有相关变更则重建快照并返回 true */
  refresh(): boolean;
}

export interface GatewayStoreOptions {
  db: Db;
  masterKey: Buffer;
  /** 解密失败回调（keyId + 错误对象，不带明文/密文） */
  onDecryptError?: (keyId: string, err: unknown) => void;
}

export function createGatewayStore(options: GatewayStoreOptions): GatewayStore {
  const { db } = options;

  const secrets = createSecretResolver(
    options.onDecryptError === undefined
      ? { masterKey: options.masterKey }
      : { masterKey: options.masterKey, onDecryptError: options.onDecryptError },
  );

  let snapshot: PoolSnapshot = { revision: 0, upstreams: [], keys: [] };
  let maskedById = new Map<string, string>();
  let priceByModel = new Map<string, { inputPer1k: number | null; outputPer1k: number | null }>();
  let lastSeq = 0;
  let built = false;

  function rebuild(): void {
    const upstreams = db.prepare(UPSTREAMS_SQL).all() as UpstreamRow[];
    const keys = db.prepare(KEYS_SQL).all() as KeyRow[];
    const models = listEnabledGatewayModels(db);

    // 先把明文缓存换成"这一版"的：未变化的 key 复用旧明文，软删的立刻消失
    secrets.update(keys, new Map(upstreams.map((u) => [u.id, u.base_url])));

    maskedById = new Map(keys.map((k) => [k.id, k.masked_key]));
    priceByModel = new Map(
      models.map((m) => [m.name, { inputPer1k: m.priceInputPer1k, outputPer1k: m.priceOutputPer1k }]),
    );

    // 模型档案按上游分组 = 该上游"被允许路由"的模型集合（见文件头「选路口径」）
    const modelsByUpstream = new Map<string, string[]>();
    for (const m of models) {
      const list = modelsByUpstream.get(m.upstreamId);
      if (list === undefined) modelsByUpstream.set(m.upstreamId, [m.name]);
      else list.push(m.name);
    }

    const upstreamConfigs: UpstreamConfig[] = upstreams.map((u) => ({
      upstreamId: u.id,
      enabled: u.enabled === 1,
      models: modelsByUpstream.get(u.id) ?? null,
    }));

    const keyConfigs: KeyConfig[] = keys.map((k) => ({
      keyId: k.id,
      upstreamId: k.upstream_id,
      category: k.category,
      status: k.enabled === 1 ? 'enabled' : 'disabled',
      weight: k.weight,
      // key 级模型白名单（§3 / §16.3）：库里 CSV 解析而来；null = 不限 → keyModels() 按 upstream 继承
      models: parseModelLimits(k.model_limits),
      balanceCents: k.balance_cents,
      tokenPlanRemainingTokens: k.token_plan_remaining,
      tokenPlanExpiresAt: k.token_plan_expires_at,
    }));

    snapshot = { revision: lastSeq, upstreams: upstreamConfigs, keys: keyConfigs };
  }

  /** 排空 change_log 增量，返回是否出现「与快照有关」的变更 */
  function drainChanges(): boolean {
    let relevant = false;
    for (;;) {
      const rows = changesSince(db, lastSeq, 500) as ChangeRow[];
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      lastSeq = last.seq;
      for (const row of rows) {
        if (SNAPSHOT_ENTITIES.has(row.entity)) relevant = true;
      }
      if (rows.length < 500) break;
    }
    return relevant;
  }

  return {
    secrets,

    catalog: {
      /**
       * 实时读，不走快照。理由：验收 4 要求 `/v1/models` 与「已启用档案集合」**0 差异**，
       * 校验脚本通常是"改一个模型 enabled → 立刻查 /v1/models"。
       * 快照有 1s 轮询窗口，会让这类校验间歇性失败（而失败原因看起来像接口错了）。
       */
      async listEnabledModels(): Promise<ModelDescriptor[]> {
        return listEnabledGatewayModels(db).map((m) => ({
          id: m.name,
          createdAt: m.createdAt,
          ownedBy: m.upstreamName,
        }));
      },

      /**
       * 客户端模型名 → 上游真实模型名。
       * 档案表里目前**没有**别名列，所以这里恒等透传 —— 不编造映射是刻意的：
       * 凭空的"智能映射"会让 /v1/models 里没有的名字也能打通，把档案架空了。
       */
      resolveUpstreamModel(clientModel: string): string {
        return clientModel;
      },
    },

    poolSnapshot: () => snapshot,

    keyCount: () => snapshot.keys.length,

    maskOf(keyId: string): string {
      return maskedById.get(keyId) ?? '****';
    },

    costCentsOf(upstreamModel: string, promptTokens: number, completionTokens: number): number {
      const price = priceByModel.get(upstreamModel);
      // 单价缺失 = 未知（未知 ≠ 0）。这里只能记 0 并在回执里点名 ——
      // 契约尚未定义"计费口径"，编一个单价出来会把统计页变成假数据。
      if (price === undefined) return 0;
      const inCents = price.inputPer1k === null ? 0 : Math.round((promptTokens * price.inputPer1k) / 1000);
      const outCents = price.outputPer1k === null ? 0 : Math.round((completionTokens * price.outputPer1k) / 1000);
      return inCents + outCents;
    },

    refresh(): boolean {
      if (!built) {
        // 首次：先把 seq 对齐到当前水位，避免把历史 change_log 当成"新变更"全量重放一遍
        const max = db.prepare(MAX_CHANGES_SQL).get() as { seq: number };
        lastSeq = max.seq;
        rebuild();
        built = true;
        return true;
      }
      if (!drainChanges()) return false;
      rebuild();
      return true;
    },
  };
}
