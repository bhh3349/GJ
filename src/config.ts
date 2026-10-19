// 启动配置的唯一读取点。与 .env.example 逐项对应。
//
// 纪律：**关键配置缺失就 fail-fast**，不做"降级成不加密/不鉴权"这种兜底。
// MASTER_KEY 的长度校验交给 src/db/crypto.ts，这里只负责把它取出来。
// 端口/开关这类有合理默认值的项才允许缺省。

import { loadMasterKeyFromEnv } from './db/crypto.js';

export interface AppConfig {
  masterKey: Buffer;
  dbPath: string;
  /** 网关面（OpenAI 兼容，对外服务） */
  portGateway: number;
  hostGateway: string;
  /** 管理面（REST + WS，默认只监听回环） */
  portAdmin: number;
  hostAdmin: string;
  sessionTtlHours: number;
  cookieSecure: boolean;
  trustProxy: boolean;
  /** 空数组 = 仅同源 */
  allowedOrigins: string[];
  /** CI 机器令牌；为空表示关闭（契约 §0.5） */
  adminToken: string | null;
  /**
   * 只读维护令牌（契约 §12.4 / ADR-0013）。为空表示关闭（默认）。
   * 作用域**仅** `GET /api/observability/*`；与 `adminToken` 配成同一个值会被拒绝启动。
   */
  readonlyToken: string | null;
  logRetentionDays: number;
  /**
   * 审计日志保留天数（默认 180）。**不并入 `logRetentionDays`** —— 那是 `usage_logs` 的口径
   * （契约 §6，30 天），而审计是**安全证据**：§6 的 retention 是从"用量明细有用期"出发的，
   * 拿它去裁审计等于让"三个月前谁改过配置"比"三天前跑过多少请求"更早消失。
   * 180 天的理由：它比"一次安全事件的追溯期"长，又不会让库永远背着历史。
   */
  auditRetentionDays: number;
  /**
   * 历史任务保留天数（默认 7）。`tasks` 的读者只有两个：轮询中的前端
   * （`listLiveTasks` 只认 `queued/running` + 60s 内结束的）与事后查 `GET /api/tasks/:id`。
   * 两者都不需要一周以前的作业记录，而 `result` 那列是 JSON ——
   * 2000 行粘贴导入的 result ≈ 75KB（契约 §15.3），一天几十次批量就是几 MB。
   */
  taskRetentionDays: number;
  /**
   * `change_log` 的保留行数（默认 10000）。**行数而不是天数**：它是广播信道、不是历史
   * （`pruneChanges` 头注原话），判据是"消费者的 seq 追到哪了"而不是"这条广播多老了"。
   * 取 10000 的依据见 `src/db/repo/change-log.ts` 的裁剪安全分析。
   */
  changeLogKeepRows: number;
  /** 健康快照保留天数；快照量级远小于日志（60s 一条），默认给 90 天 */
  healthSnapshotRetentionDays: number;
  /**
   * 余额自动同步的基准间隔（分钟，契约 §14.1 / ADR-0017）。**`0` = 关闭自动同步**
   * （手动三个刷新端点全部保留）；负数 / 非十进制 → 启动失败。
   */
  balanceSyncMinutes: number;
  /**
   * 余额快照保留天数（默认 90，与 `healthSnapshotRetentionDays` 同一形态与理由）。
   * **不参与** `logRetentionDays`（那是 `usage_logs` 的 30 天口径，两件事别混）。
   */
  balanceSnapshotRetentionDays: number;
  /** 单次调用的最大尝试次数（含首次）；默认 3（冻结常量） */
  maxAttempts: number;
  /** 每把上游 key 的并发上限；默认 4（冻结常量） */
  maxConcurrencyPerKey: number;
  /**
   * 失败冷却阶梯（秒），下标 = 连续失败次数 - 1。
   * 默认 = 冻结阶梯 0/1m/5m/15m/30m（首档 0，即首次失败只吃该 reason 的基础冷却）
   */
  cooldownLadderSeconds: number[];
  /**
   * 内置助手（契约 §13 / ADR-0015）的**缺省客户端模型名**；为空 = 助手未接线。
   *
   * v1.10.0 起它是**缺省值**而不是唯一来源：请求体可带 `model` 逐轮覆盖（§13.1 / ADR-0023），
   * 但**没配这一行就没有缺省可用** —— 未接线分支与"发不发表单覆盖"无关。
   *
   * 刻意**不给默认值**：这个名字必须已在模型档案里建档并绑到上游 key，编一个默认值
   * 只会让 `/api/assistant/chat` 每次都走一遍"选路失败"再回 503，把"没配"伪装成"配错了"。
   * 为空时 server.ts 注入 `unwiredAssistantInvoker`，前端拿到的是一个说人话的终止帧
   * （而不是挂到超时），启动日志里也有一条 warn 说明原因。
   */
  assistantModel: string | null;
  /**
   * 出口心跳**文件收件箱**目录（ADR-0020 决策 8 的入口 A）。**空 / 未设 = `null` = 入口 A 关闭**。
   *
   * 为什么是**目录**而不是单个文件路径：`pool-probe.sh --json` 由项目服务器侧的 systemd timer
   * **整份覆写**（当前 30s 一档），生产者每拍取「最新且没吃过的那份」（按内容 SHA-256 记账）。
   * 给它一个固定文件名 = 写入方与读取方在同一个 inode 上赛跑，半截 JSON 会被读走。
   *
   * 为什么**缺省关闭**：入口 A 是「有人配了出口池」才成立的事实。默认给一个目录会让每台开发机
   * 都起一个周期性 `readdir` 的定时器，而它对没配出口的机器**什么也证明不了**。
   * 空串按"未配置"处理（与 `ADMIN_TOKEN` / `ASSISTANT_MODEL` 同一条纪律）：
   * `EGRESS_HEARTBEAT_INBOX_DIR=` 是部署脚本里最常见的"这行先留着"写法，把它当成一个空目录名
   * 会让入口 A 静默启成一个永远读不到的监视器 —— 那种"配了但没生效"比拒绝启动难查得多。
   *
   * 本字段只被**接线层**（`src/server.ts`）读：`src/egress/heartbeat.ts` 不解释环境变量，
   * 也不 import `src/db`（AGENTS.md §8）—— 它收的是**已解析的目录字符串或 null**。
   */
  egressHeartbeatInboxDir: string | null;
  /**
   * 出口探活的**回显端点**（ADR-0033 / 契约 §16.7）。**空 / 未设 = `null` = 用缺省值**
   * `EGRESS_ECHO_URL_DEFAULT`（`src/egress/port.ts`，唯一字面量来源）。
   *
   * 为什么要有这个旋钮：回显端点被墙/被 DNS 污染时，`/api/egress/:id/test` 会对一台
   * **完全健康**的代理回 `ok:false` 并把它写进 `egress_proxies.last_test_ok` ——
   * 面板上唯一那个"我的出口通不通"的信号在最坏情况下恒假，而照着它删代理的人
   * 删掉的是能用的机器。心跳生产者入口 B 同源：端点不可达 ⇒ 每拍都是失败证据 ⇒
   * 累计到 `HEARTBEAT_EVICT_AFTER_FAILURES`(3) 就把好节点**静默摘除**。
   * 两个消费者必须能指向同一个新端点，所以值可配；**缺省不变**（换缺省会静默改变
   * 所有现存部署的探测语义，理由见 `EGRESS_ECHO_URL_DEFAULT` 头注）。
   *
   * 与 `egressHeartbeatInboxDir` 同款空串纪律：`EGRESS_ECHO_URL=` 是部署脚本里
   * 最常见的"这行先留着"写法。这里**不做 URL 合法性校验** —— 配置层只负责取值，
   * 语法对不对由运行时暴露（一个连不上的端点就是一次失败的探测，那正是探测的职责），
   * 而"拒绝启动"会让一个填错别名的用户在启动阶段看到一句与网络无关的报错。
   */
  egressEchoUrl: string | null;
  /**
   * 能力探测（契约 §5 / ADR-0024）自动补探总开关。默认开（Bo 拍板"默认开"）；
   * `MODEL_PROBE_ENABLED=false` 装配侧全局关。请求体 `{probe:false}` 是单次调用的第二道闸。
   */
  modelProbeEnabled: boolean;
  /**
   * 同步尾部自动补探的**单轮模型数上限**（占位 10，装配侧 env 默认，数值不进契约 ——
   * 契约 §5 v1.11.2 只登记来源与默认值语义，不锁数值）。
   * 超出的模型留在 `capabilities_source IS NULL`，下一轮再补。
   */
  modelProbeMaxModels: number;
  /**
   * 管理面同源托管的前端产物目录（契约 §17 / ADR-0027）。**默认 `null` = 托管关闭**
   * （关闭时行为与 v1.12.0 之前逐字节相同：`GET /` 回既有 JSON 404）。
   *
   * **显式配置才开**：不做"探测 web/dist 存在就托管"——仓库里 `web/dist` 是长期存在的
   * 构建产物，一探测就会让测试进程意外开启托管（用例 cwd 即仓库根），真实 index.html
   * 被塞进 inject 响应，断言随构建产物漂移。生产在 `.env` 里 `ADMIN_WEB_DIST=web/dist` 打开
   * （相对路径按进程 cwd 解析）。
   *
   * **目录缺失不 fail-fast**（与 MASTER_KEY 那条相反，理由也相反）：`vite build` 没跑是常态，
   * 不该拦后端启动。启动 warn 一条，托管退化为「0 条静态路由 + 兜底退化为 404」
   * （`@fastify/static` `wildcard:false` 在 root 缺失时安全退化，实测不炸 ready）。
   */
  adminWebDist: string | null;
  /**
   * 对外 host 覆盖值（契约 §18 / ADR-0028）。env `PUBLIC_HOST`，**默认空 = `null`**。
   *
   * 服务端只知道端口与**绑定地址**（`0.0.0.0` 是监听语义、`127.0.0.1` 只是回环），
   * 都不知道公网 host —— 所以本项是唯一能告诉前端"对外基址长什么样"的来源
   * （ADR-0028 决策 2：刻意不设完整 URL 字段，拼 URL 的责任在前端）。
   * 落 `.env` **不落库**：host 是部署环境属性，免 DB / 免 schema / 免审计面。
   * 不带 scheme（如 `gw.example.com`）；前端拼接 = `(publicHost ?? location.hostname)` + 端口。
   *
   * 空串按"未配置"处理（与 `ADMIN_TOKEN` / `ASSISTANT_MODEL` / `ADMIN_WEB_DIST` 同一条纪律：
   * `PUBLIC_HOST=` 是部署脚本里常见的"这行先留着"写法，把它当成一个叫空串的主机名
   * 会让接入页把用户导向一个不存在的地址）。
   */
  publicHost: string | null;
  /**
   * 出口（IP）预算闸的**每出口、每窗口请求上限**（契约 §16.7.3 / ADR-0021 决策 8）。
   * **`null` = 不限**（缺省，业主 2026-10-19 裁定）。
   *
   * 为什么缺省是"不限"而不是一个数：写死的 `5 枚/60s` 被实测证伪 —— 连发第 6 枚起整窗
   * 被拒（`429 upstream egress rate limited`），而同一时段**上游从未拒过我们**，被拒的
   * 100% 是网关自己合成的。在"我们并不知道上游的真实地板"这件事上，正确缺省是
   * "别拿猜出来的数去拒真实流量"，而不是猜一个数。真正的出口保护仍在：上游真限我们时
   * 的归因冷却（§16.7 判据）一个字没动。
   *
   * 为什么仍留这个旋钮：标定出真实地板后要能**只改数**就封顶（决策 8 的回填纪律），
   * 不必改代码；也给"我就想限流"的部署一条明说出来的路。**不设默认数** ——
   * 给个默认数等于把上面那段理由推翻。
   *
   * 解析：空 / 未设 = `null`；正整数 = 封顶；`0` / 小数 / 非十进制 → **拒绝启动**
   * （0 会让每个出口恒拒 ⇒ 整台网关不可用，是比启动失败严重得多的静默故障）。
   */
  egressBudgetCapacity: number | null;
}

/**
 * 冻结默认阶梯（秒）：0 / 1m / 5m / 15m / 30m。
 *
 * 与 `src/gateway/cooldown.ts` 的 `DEFAULT_COOLDOWN_LADDER_MS` **逐项同值**（乘 1000 后）。
 * 这条等价关系是硬约束，不是巧合：env 未设时 `runtime.ts` 仍会把本值灌进 `PoolOptions`，
 * 于是"默认路径"完全绕开内核常量 —— 两边一旦漂移，真实进程用的就是另一个阶梯，
 * 而门禁全绿也看不出来。`config.spec.ts` 里有一例回归专门钉死这个等式。
 *
 * 首档必须是 0，别"修"成 60：冻结语义是 n=1 → 用 reason 基础冷却
 * （NETWORK 15s / UPSTREAM_ERROR 10s / RATE_LIMITED 60s），
 * 首档给 60 会让一次失败的 key 被停 60s 而不是 15s。
 */
const DEFAULT_COOLDOWN_LADDER_SECONDS: readonly number[] = [0, 60, 300, 900, 1800];

/**
 * 「十进制整数字面量」两张网，只认 0-9（可带一个前导负号）。
 *
 * 为什么不直接 `Number(raw)`：`Number` 的接受面比"配置项"该有的宽得多，
 * 且**全部静默**——`0x10`=16、`1e3`=1000、`30.9` 被 `Math.floor` 成 30、
 * `-0` 满足 `n < 0` 为假。这类值读进来不会报错，只会让端口/保留天数/冷却档位
 * 变成另一个数，症状看起来像"代码有 bug"。所以入口只放十进制字面量过，
 * 其余一律 fail-fast（与 MASTER_KEY 缺失即拒绝启动同款纪律）。
 * 注意 `Number('abc')`=NaN、`Number('1_000')`=NaN 本来就会被有限性检查拦下，
 * 这里收的是那些"能算出数、但显然不是配置本意"的形状。
 */
const DECIMAL_INT_RE = /^-?\d+$/;
/** 非负变体（冷却阶梯按定义不允许负数，连 `-0` 也不放行）。 */
const DECIMAL_UINT_RE = /^\d+$/;

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const text = raw.trim();
  if (!DECIMAL_INT_RE.test(text)) {
    throw new Error(`${name} 必须是十进制整数（不接受 0x/科学计数/小数），实际为 ${JSON.stringify(raw)}`);
  }
  const n = Number(text);
  // 位数多到溢出成 Infinity 的照样拦下；其余情况正则已保证是整数，不需要 Math.floor
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是十进制整数，实际为 ${JSON.stringify(raw)}`);
  return n;
}

/**
 * 正整数项（尝试次数、并发上限这类）。
 *
 * 为什么单独一个函数而不是复用 intFromEnv：`MAX_CONCURRENCY_PER_KEY=0` 不会被任何地方拦住，
 * 它会让每把 key 的并发闸门恒为"已满"，症状是「池子里有 6 把健康 key，却一把也选不出来」——
 * 一个纯粹由配置打错造成的全站 503，且不会报错。这类值必须是正数，否则启动就失败。
 */
function positiveIntFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = intFromEnv(env, name, fallback);
  if (n < 1) throw new Error(`${name} 必须 >= 1，实际为 ${JSON.stringify(env[name])}`);
  return n;
}

/**
 * 非负整数项（`BALANCE_SYNC_MINUTES` 这类"0 有明确含义"的项）。
 *
 * 为什么不能直接用 `intFromEnv`：负数在这类项上**不是"更小的值"，是另一种语义**。
 * `BALANCE_SYNC_MINUTES=-15` 会被 `intervalMinutes > 0` 判成"关闭自动同步"，
 * 于是部署者以为配了一个更勤的间隔，实际把自动同步整个关掉了 —— 门禁全绿，
 * 症状只是"余额再也不自己更新了"。这类值要么是正数、要么是显式的 0。
 */
function nonNegativeIntFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const n = intFromEnv(env, name, fallback);
  if (n < 0) throw new Error(`${name} 必须 >= 0（0 = 关闭），实际为 ${JSON.stringify(env[name])}`);
  return n;
}

function boolFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

/**
 * 冷却阶梯（秒）。逗号分隔，如 `0,60,300,900,1800`。
 *
 * 为什么在这里做严格校验而不是读进来直接用：阶梯是**单调升档**语义，配错不会报错，
 * 只会让某把 key 冷却成 1ms 或被长期锁死，而症状看起来像"上游挂了"。
 * 所以非空、非负整数、非递减三条不满足就拒绝启动（与 MAX_CONCURRENCY_PER_KEY 同款纪律）。
 *
 * **首档允许 0**，这一条是有来历的：冻结阶梯的首档就是 0（首次失败 = 只吃 reason 基础冷却）。
 * 早先要求"正整数"时，默认值只能编成 `60,300,900,1800`，整条阶梯相对冻结值上移一档、
 * 丢掉首档 0，一次失败的 NETWORK key 被停 60s 而不是 15s —— 门禁绿着，谁也没发现。
 * 别再把 0 判成非法；同时 0 只在首档有意义，`60,0` 这种递减仍照旧拒绝。
 * 注意封顶仍是 `MAX_COOLDOWN_MS`：最后一档超过 30min 会被封顶，不是静默截断阶梯。
 */
function cooldownLadderFromEnv(env: NodeJS.ProcessEnv): number[] {
  const raw = env['COOLDOWN_LADDER_SECONDS'];
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_COOLDOWN_LADDER_SECONDS];

  const parts = raw.split(',').map((s) => s.trim());
  const secs = parts.map((p) => {
    // 同样只认十进制字面量：`0x10`/`1e3`/`60.0` 用 Number 都能算出合法的非负整数，
    // 于是"配错"被静默吞成"另一个档位"——正是上面那段注释说的那类故障。
    const n = Number(p);
    if (!DECIMAL_UINT_RE.test(p) || !Number.isInteger(n)) {
      throw new Error(`COOLDOWN_LADDER_SECONDS 必须是逗号分隔的非负整数秒（十进制字面量，不接受 0x/科学计数/小数），实际为 ${JSON.stringify(raw)}`);
    }
    return n;
  });

  for (let i = 1; i < secs.length; i += 1) {
    const prev = secs[i - 1] ?? 0;
    const cur = secs[i] ?? 0;
    if (cur < prev) {
      throw new Error(`COOLDOWN_LADDER_SECONDS 必须非递减（阶梯是升档语义），实际为 ${JSON.stringify(raw)}`);
    }
  }
  return secs;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const origins = (env['ALLOWED_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  const adminToken = (env['ADMIN_TOKEN'] ?? '').trim();
  const readonlyToken = (env['READONLY_TOKEN'] ?? '').trim();

  /**
   * 两把令牌同值 = 隔离归零（契约 §12.4 / ADR-0013）。
   *
   * 这里刻意选择**拒绝启动**而不是"以管理员为准"：没有第三种正确行为。
   * 静默取其一，会让部署者以为"观测令牌已经和会话隔离了"，实际拿到观测令牌的人
   * 就是管理员；而报错会在启动那一秒就让人看见，代价最小。
   * 与 MASTER_KEY 缺失即拒绝启动同款纪律 —— 安全配置的错误不能降级成运行期行为差异。
   */
  if (readonlyToken !== '' && adminToken !== '' && readonlyToken === adminToken) {
    throw new Error(
      'READONLY_TOKEN 不能与 ADMIN_TOKEN 相同：只读维护令牌与管理面机器令牌必须是两个值（契约 §12.4）',
    );
  }

  return {
    // 缺 MASTER_KEY 或长度不对会在这里抛 CryptoConfigError，进程起不来 —— 这是有意的
    masterKey: loadMasterKeyFromEnv(env),
    dbPath: env['DB_PATH'] ?? './data/gateway.db',
    // 网关面默认对外（0.0.0.0）：它是给客户端用的；管理面默认只听回环（见下），别搞反。
    portGateway: intFromEnv(env, 'PORT_GATEWAY', 4000),
    hostGateway: env['HOST_GATEWAY'] ?? '0.0.0.0',
    portAdmin: intFromEnv(env, 'PORT_ADMIN', 4001),
    hostAdmin: env['HOST_ADMIN'] ?? '127.0.0.1',
    sessionTtlHours: intFromEnv(env, 'SESSION_TTL_HOURS', 24),
    cookieSecure: boolFromEnv(env, 'COOKIE_SECURE', false),
    trustProxy: boolFromEnv(env, 'TRUST_PROXY', false),
    allowedOrigins: origins,
    adminToken: adminToken === '' ? null : adminToken,
    readonlyToken: readonlyToken === '' ? null : readonlyToken,
    logRetentionDays: intFromEnv(env, 'LOG_RETENTION_DAYS', 30),
    auditRetentionDays: positiveIntFromEnv(env, 'AUDIT_RETENTION_DAYS', 180),
    taskRetentionDays: positiveIntFromEnv(env, 'TASK_RETENTION_DAYS', 7),
    changeLogKeepRows: positiveIntFromEnv(env, 'CHANGE_LOG_KEEP_ROWS', 10_000),
    healthSnapshotRetentionDays: positiveIntFromEnv(env, 'HEALTH_SNAPSHOT_RETENTION_DAYS', 90),
    // 0 是**显式含义**（关闭自动同步），所以走非负版本而不是 positive 版本
    balanceSyncMinutes: nonNegativeIntFromEnv(env, 'BALANCE_SYNC_MINUTES', 15),
    balanceSnapshotRetentionDays: positiveIntFromEnv(env, 'BALANCE_SNAPSHOT_RETENTION_DAYS', 90),
    maxAttempts: positiveIntFromEnv(env, 'MAX_ATTEMPTS', 3),
    maxConcurrencyPerKey: positiveIntFromEnv(env, 'MAX_CONCURRENCY_PER_KEY', 4),
    cooldownLadderSeconds: cooldownLadderFromEnv(env),
    // 空串按"未配置"处理（同两把令牌的写法）：`ASSISTANT_MODEL=` 是部署脚本里最常见的
    // "这一行先留着"写法，把它当成一个叫空字符串的模型名会让助手静默走 503。
    assistantModel: (env['ASSISTANT_MODEL'] ?? '').trim() === '' ? null : (env['ASSISTANT_MODEL'] ?? '').trim(),
    egressHeartbeatInboxDir: (env['EGRESS_HEARTBEAT_INBOX_DIR'] ?? '').trim() === '' ? null : (env['EGRESS_HEARTBEAT_INBOX_DIR'] ?? '').trim(),
    egressEchoUrl: (env['EGRESS_ECHO_URL'] ?? '').trim() === '' ? null : (env['EGRESS_ECHO_URL'] ?? '').trim(),
    modelProbeEnabled: boolFromEnv(env, 'MODEL_PROBE_ENABLED', true),
    modelProbeMaxModels: positiveIntFromEnv(env, 'MODEL_PROBE_MAX_MODELS', 10),
    // 空串按"未配置 / 探测"处理（与 ASSISTANT_MODEL / EGRESS_HEARTBEAT_INBOX_DIR 同款写法：
    // `ADMIN_WEB_DIST=` 是部署脚本里最常见的"这行先留着"写法）。显式关闭值的解释留在装配层
    // （`src/api/app.ts` 的 `resolveWebDist`），配置层只负责"取出来"—— 与 resolveEgressGate 同一条纪律：
    // 默认值的解释只有一处，否则"关托管"会有两种写法各自为政。
    adminWebDist: (env['ADMIN_WEB_DIST'] ?? '').trim() === '' ? null : (env['ADMIN_WEB_DIST'] ?? '').trim(),
    // 对外 host 覆盖值（契约 §18 / ADR-0028）。空串 = 未配置，与上面几项同款写法。
    publicHost: (env['PUBLIC_HOST'] ?? '').trim() === '' ? null : (env['PUBLIC_HOST'] ?? '').trim(),
    // 出口预算上限：空 / 未设 = 不限（null）；正整数 = 封顶（决策 8 回填的落点）。
    // 0 / 小数 / 非十进制 → 拒绝启动：0 会让每个出口恒拒，是比启动失败更难查的静默故障。
    egressBudgetCapacity: parseEgressBudgetCapacity(env),
  };
}

/**
 * 出口预算上限（契约 §16.7.3 / ADR-0021 决策 8）。空 = 不限；
 * 正整数 = 封顶；`0` / 小数 / 非十进制 → 拒绝启动（0 = 每个出口恒拒，是静默的全局故障）。
 */
function parseEgressBudgetCapacity(env: NodeJS.ProcessEnv): number | null {
  const raw = (env['EGRESS_BUDGET_CAPACITY'] ?? '').trim();
  if (raw === '') return null;
  if (!DECIMAL_INT_RE.test(raw)) {
    throw new Error(
      `EGRESS_BUDGET_CAPACITY 必须是十进制整数或留空（不限），实际为 ${JSON.stringify(env['EGRESS_BUDGET_CAPACITY'])}`,
    );
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`EGRESS_BUDGET_CAPACITY 必须 >= 1（留空 = 不限），实际为 ${JSON.stringify(env['EGRESS_BUDGET_CAPACITY'])}`);
  }
  return n;
}
