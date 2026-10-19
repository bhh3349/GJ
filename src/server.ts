// 进程入口：读配置 → 开库 → 建管理员 → 起**两个**监听（网关面 / 管理面）→ 挂维护定时器。
// 维护定时器负责五张表的保留策略（总表见下方定时器那段），另两张由各自的写入方自己扫。
//
// 启动顺序是有讲究的，不能调换：
//   1. loadConfig 先跑。MASTER_KEY 缺失或长度不对会在这一步抛错，进程直接起不来 ——
//      这是有意的（契约要求），绝不允许"降级成不加密"把服务拉起来。
//   2. openDatabase 建表/迁移，再 bootstrapAdmin 造首个管理员。
//   3. 建网关 runtime（这一步会同步建快照并解密 key），最后才 listen。
//      反过来的话，存在一个窗口期：端口已对外，key 池还是空的 —— 那个窗口里进来的请求
//      会拿到 503 NO_AVAILABLE_KEY，看起来像"池子坏了"。
//   4. 管理面（buildApp）建在 gateway runtime **之后**：`/api/observability/health` 的
//      `events.dropped` 读的就是网关侧错误事件队列的累计丢弃数（契约 §12.2），
//      只有 runtime 先存在才接得上。接不上的后果不是报错，而是那个字段恒为 0 —— 一个
//      "看起来一直没丢过事件"的假读数，比报错难发现得多。
//
// 两个监听、一份库：
//   - 网关面（config.hostGateway:portGateway）跑 `/v1/*`，对外；
//   - 管理面（config.hostAdmin:portAdmin）跑 `/api/*` + 前端，默认只回环。
//   两个 Fastify 实例共用一个 `Db` 句柄：本项目是单写者模型，一个句柄才谈得上单写者。
//
// 维护定时器（清过期会话 / 裁日志 / 裁审计 / 裁任务 / 裁错误事件 / 裁广播 / 清限速表）
// 在**同一个进程**里跑：再起一个 cron 进程去写库，就同时有两个写者了。

import { buildApp } from './api/app.js';
import { unwiredAssistantInvoker } from './api/assistant-port.js';
import { LoginRateLimiter, bootstrapAdmin, purgeExpiredSessions } from './api/auth.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { pruneAudit } from './db/repo/audit.js';
import { pruneChanges } from './db/repo/change-log.js';
import { pruneGatewayErrorEvents } from './db/repo/gateway-events.js';
import { pruneLogs } from './db/repo/logs.js';
import { pruneTasks } from './db/repo/tasks.js';
import { listEgressProxies } from './db/repo/egress.js';
import { EGRESS_BUDGET_DEFAULT, createEgressGate } from './gateway/egress.js';
import { startHeartbeatProducer } from './egress/heartbeat.js';
import type { EgressShadowRecord } from './egress/port.js';
import {
  createAssistantInvoker,
  createAssistantMetrics,
  createEgressProxyLifecycle,
  createEgressSelectable,
  createGatewayRuntime,
  createShutdownHandler,
  mountGatewayRoutes,
} from './wiring/index.js';

const HOUR_MS = 3_600_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase({ path: config.dbPath });

  // 首次启动没有管理员且没给 ADMIN_PASSWORD 时会在这里抛错并退出（fail-fast）
  const boot = bootstrapAdmin(db, process.env);

  /*
    首次建库时把管理组的网关 key 明文打一行到标准输出（ADR-0035 遗留 1）。

    **这一行与本文件上面那句"凭据不进日志"的纪律是矛盾的，我是明知代价选的它。**
    两个凭据的**替代路径**不一样：管理员口令他能记得、能存密码管理器；
    而网关 key 明文**没有任何其它路径** —— §4 铁律决定了它只在签发响应里出现一次，
    不打日志就等于那把 key 从诞生起就不可知，"管理员的账号无法使用路由"原样保留
    （那正是本版要修的故障）。缓解只有三条：只在首次建库打、明确标注"仅此一次"、
    并指明轮换办法（管理面里重置那把 key）。
    代价写在这里而不是藏起来：这一行会进容器日志，任何能读日志的人都能拿到它。
    **所以管理组的配额是本版刻意留空的**（ADR-0035 遗留 2）—— 建站后第一件事
    应当是去管理面给它设限，或者重置这把 key。
  */
  if (boot.adminGatewayKey !== undefined && boot.adminGroup !== undefined) {
    process.stdout.write(
      [
        `已创建「${boot.adminGroup.name}」，并把首个管理员放进它。`,
        `网关 Base URL: http://<本机地址>:${config.portGateway}/v1`,
        `网关 key（仅此一次显示，库内只存散列；可在管理面「用户组」里重置）: ${boot.adminGatewayKey}`,
        '',
      ].join('\n'),
    );
  }

  const loginLimiter = new LoginRateLimiter();

  // 出口（IP）预算闸（契约 §16.7 / ADR-0021 决策 4c）：**造一次、注入两处** ——
  // 下一行的网关装配（数据面）与后面的 `buildApp({ egress })`（管理面）拿到**同一个对象**。
  // 建两个实例不是性能问题而是正确性问题：上游按**来源 IP** 计数，两侧扣的是同一张配额表，
  // 各持一份 = 各自以为还有额度（`src/egress/port.ts` 文件头那段"两条车道共同的约束"）。
  //
  // 预算值引用 `EGRESS_BUDGET_DEFAULT` 这**一份**常量（capacity: null = 不限，缺省），不在这里抄数字：
  // 要封顶走 `EGRESS_BUDGET_CAPACITY` env（config.ts 解析、null = 不限），抄第二遍就等于标定只改到了
  // 一半。**2026-10-19 业主裁定改不限**：写死的 5 枚/60s 被实测证伪（被拒的全是我们自己合成的 429，
  // 上游从没拒过），常量随 ADR-0021 v11 由 `EGRESS_BUDGET_PLACEHOLDER` 改名 `EGRESS_BUDGET_DEFAULT`。
  //
  // **mode: 'active'**（⑧ 转正，PM 裁定 1）：判据从此真正启用 —— 上游确认的出口级 429
  // 会真的置起冷却，§7 `egress_cooldown` 帧从此开始发射（v1.4.9「本期不发射」由本笔翻篇）。
  // 判据照 §16.7.3 v6 `distinctAccounts` 窗口化落（同出口 60s 滑动窗内 ≥3 个不同账号）。
  //
  // shadow 记录的去处在下面 `logShadow` 那一跳 —— 见那里的注释（为何要晚绑到网关 app 的 logger）。
  let logShadow: (record: EgressShadowRecord) => void = () => {};
  const egress = createEgressGate({
    ...(config.egressBudgetCapacity === null
      ? {}
      : { budget: { ...EGRESS_BUDGET_DEFAULT, capacity: config.egressBudgetCapacity } }),
    mode: 'active',
    onShadow: (record) => logShadow(record),
  });

  // 网关 runtime 自带内存快照 + 明文缓存；`stop()` 负责最后一次用量落库、最后一次
  // key 运行态镜像（ADR-0010）与清明文 —— 都在 db.close() 之前，否则 flush 会写到已关的连接上
  // 503 出口选择器判据缝（ADR-0021 决策 9(5)，装配层方案 A）：**请求期现查** `egress_proxies`，
  // 不缓存 —— retire/reactivate 立即生效（零失步窗口）；表是个位数行，一条同步 SELECT 微秒级。
  // 三支判据收在 `src/wiring/egress-select.ts`（唯一实现处，与出站缝 `egress-proxy.ts` 同形）：
  //   ① 池空（0 行）= 池未启用 ⇒ 恒活；② 池内条目按单轴 `status`（active 活绑定 / retired 死绑定）；
  //   ③ **查无此行** = 未绑账号的 Tier-1 host id ⇒ 配置事实、照常走宿主出口（契约 §10 逐字
  //   「不含『账号级未绑』」）。上一版把判据写在本层且只覆盖 ①②：池一旦非空，未绑账号的
  //   Tier-1 host id 全落进「查无此行 = 死绑定」⇒ **建第一个出口那一瞬全池未绑账号一起 503**（P0）。
  // 刻意提成命名常量、保持下方调用对象扁平：egress.spec 的生产装配锁用
  // `createGatewayRuntime\(\{[^}]*\begress\b[^}]*\}\)` 钉「数据面拿到同一个 egress 实例」，
  // 对象里嵌函数体会让该正则失配 —— 装配锁不为此放宽，改的是装配写法。
  const egressSelectable = createEgressSelectable(db);

  // 出口代理出站（ADR-0021 决策 4c / 契约 §16.7 Tier 2，缺口 A）：让"绑了出口的账号"真的从
  // 那个 IP 出去。此前 `ProxyAgent` 全仓只有管理面 `POST /api/egress/:id/test` 一个落点，
  // 数据面出站走裸 fetch ⇒ 出口池建了、绑了却不生效（流量照样从宿主 IP 直出）。
  //
  // 造在这里、只给数据面：管理面那七类出站的代理包装是**批二**（另一笔），本笔范围 = 数据面
  // （派工令铁律⑤）。`masterKey` 只在装配层解密代理凭据，解密结果只进 `ProxyAgent` 构造参数。
  // `refresh()` / `stop()` 由网关 runtime 挂进它既有那 1s 节拍与关停链（见 runtime.ts）——
  // 于是缓存刷新与快照同一个拍子、凭据随 key 明文同批丢弃，装配层不用另记两处。
  const egressProxy = createEgressProxyLifecycle({ db, masterKey: config.masterKey });

  const gateway = createGatewayRuntime({ db, config, logger: true, egress, egressSelectable, egressProxy });

  // 晚绑（上面先给了个空实现）：`onShadow` 的消费者是日志，而闸必须**先于** app 存在
  // （它要注入进 runtime，runtime 才建 app）。标定吃的就是这条输出（决策 10(6)「shadow 输出
  // 只是日志」），挂成空实现 = 影子模式在线上没有观测面，"判据炸了"与"判据什么都没发现"
  // 又变成同一件事。只写 `egressId` + 那几个判据字段：这里不含 key 明文，也不含请求体。
  //
  // 晚绑的代价只有一处，且实际为零：空实现与赋值之间是一段**纯同步**窗口（造闸 → 建 runtime →
  // 下面这一行），窗口里没有请求可跑，判据记录吞不到任何东西；初始化值是空函数而**不是**未赋值，
  // 运行期不会抛 `ReferenceError`。也正因为窗口内无请求，这里不写"先攒着、赋值后补发"那类兜底：
  // 攒下来的只会是空集，多一段状态就多一处能烂的地方。
  logShadow = (record) => {
    gateway.app.log.info({ egressShadow: record }, '出口预算判据 shadow 记录（只记不动，未生效）');
  };

  await mountGatewayRoutes(gateway);
  gateway.start();

  // 内置助手（契约 §13 / ADR-0015）。三处接线刻意都放在**管理面之前**，
  // 且共用同一个 metrics 对象：
  //   - 池子与密文出口取自 `gateway`，所以助手调用与业务请求**同源**结算 key 健康；
  //   - invoker 内部另起一个 engine 且不挂任何 sink（不写 usage_logs / 不产错误事件），
  //     这条隔离在 `src/wiring/assistant-invoker.ts` 里是结构性的，不靠调用方自觉；
  //   - 未配 `ASSISTANT_MODEL` 时注入 `unwiredAssistantInvoker`：前端拿到一条说人话的
  //     503 终止帧，同时这里留一条 warn 说明"功能没坏，是没配"。
  //     **不编一个默认模型名** —— 那只会把"没配"伪装成"配错了"（每次走一遍选路失败）。
  const assistantMetrics = createAssistantMetrics();
  const assistant =
    config.assistantModel === null
      ? unwiredAssistantInvoker
      : createAssistantInvoker({
          pool: gateway.stack.pool,
          secrets: gateway.store.secrets,
          models: gateway.store.catalog,
          model: config.assistantModel,
          metrics: assistantMetrics,
        });

  // 出口心跳生产者（ADR-0020 决策 8 / 契约 §7 `egress_pool`）—— 发射面的数据源。
  // 建在管理面**之前**：下面 `buildApp({ egressPool })` 要闭包引用它（用 `app.log` 会是 TDZ），
  // 而它的 `stop()` 由冻结顺序第 1 步的 `stops` 摘（见 shutdown.ts）。
  //
  // 接线的三个决策：
  //   1. **节点清单在本层读表**：`egress_proxies` 的 `active` 行 → `EgressNodeConfig`。
  //      `heartbeat.ts` 不 import `src/db`（AGENTS.md §8），「读哪张表」留在装配层。
  //      清单取**启动时快照**：新增/退休出口要重启进程才进池 —— 本期接受这个成本，
  //      换来的是连败计数不会被一次改名清零（「配置变更」与「健康劣化」不进同一台机器）。
  //   2. `gate` 传**同一个闸实例**：帧里的 `cooldownUntil` 与数据面/管理面同源，
  //      入口 B 的探活也扣同一张 management 预算表（决策 4c）。
  //   3. `inboxDir` 取自 config（空/缺省 = null = 入口 A 关）。入口 B（`probe`）**默认关**：
  //      它吃 management 预算（成本口径写在 heartbeat.ts 文件头），开启要另有一笔明确决策。
  //   4. `echoUrl` 与 `/api/egress/:id/test` **同源**（ADR-0033）：两边都从 `config.egressEchoUrl`
  //      取，缺省回落 `EGRESS_ECHO_URL_DEFAULT`（端口层唯一字面量）。各配一个值会让面板说
  //      "这台通"而心跳说"这台死了" —— 两边的日志还都写着"探测正常"。
  // `nodes` 为空数组时生产者照跑：`poolSnapshot()` 回 `[]`，发射面据此发「未配置出口」的空池帧。
  const egressProducer = startHeartbeatProducer({
    gate: egress,
    nodes: listEgressProxies(db)
      .filter((row) => row.status === 'active')
      .map((row) => ({ egressId: row.id, name: row.name, proxyUrl: row.url })),
    inboxDir: config.egressHeartbeatInboxDir,
    ...(config.egressEchoUrl === null ? {} : { echoUrl: config.egressEchoUrl }),
    onLog: (line) => gateway.app.log.info({ egressHeartbeat: line }, '出口心跳证据'),
  });

  // 管理面：`droppedEvents` 接到网关侧的事件队列上（见文件头第 4 条）。
  // 只传一个取值函数而不是 sink 本身：管理面只需要那一个**累计数**，
  // 拿到 sink 就等于拿到了往事件流里写的能力 —— 观测面不该有写入口。
  const app = buildApp({
    db,
    config,
    logger: true,
    loginLimiter,
    droppedEvents: () => gateway.errors.dropped(),
    assistant,
    assistantMetrics,
    // 同一个闸实例（见上面"造一次、注入两处"）—— 决策 4c 的验收就压在"这是同一个对象"上。
    egress,
    // §7 `egress_pool` 发射缝（方案 A）：闭包现取 producer 的 `poolSnapshot()`（同步、无副作用）。
    // 刻意不传数组：状态机每拍都在变（收件箱证据进来就翻），发出去的必须是**这一拍**的快照。
    egressPool: () => egressProducer.poolSnapshot(),
  });

  if (config.assistantModel === null) {
    app.log.warn('未配置 ASSISTANT_MODEL：内置助手未接线，/api/assistant/chat 将回 503 NO_AVAILABLE_KEY');
  } else {
    app.log.info({ model: config.assistantModel }, '内置助手已接线（缺省模型；请求体 model 可逐轮覆盖）');
  }


  // 维护任务一律 try/catch 吞掉异常：清垃圾失败不该把整台服务带走，
  // 下一次 tick 还会再来一遍。
  //
  // 保留策略总表（为什么分散在四个文件里而不是一个"清理器"）：
  //   · `usage_logs`        —— 本文件，`LOG_RETENTION_DAYS`（30d）
  //   · `audit_log`         —— 本文件，`AUDIT_RETENTION_DAYS`（180d，**独立**于上面那个）
  //   · `tasks`             —— 本文件，`TASK_RETENTION_DAYS`（7d）
  //   · `gateway_error_events` —— 本文件，与 `usage_logs` 同口径（契约 §12.1 明文）
  //   · `change_log`        —— 本文件，**按行数**不按天数（`CHANGE_LOG_KEEP_ROWS`）
  //   · `gateway_health_snapshots` —— `src/api/health-snapshot-writer.ts` 自己的节拍
  //   · `balance_snapshots` —— `src/api/balance-sync.ts` 自己的节拍（与同步开关无关）
  // 后两张表留在原地不是懒：它们的写入方已经有自己的定时器，再挂一个全局清理器
  // 就成了"同一个表两个节拍"，而两边的保留期一旦配得不一样，谁先跑谁后跑决定库的大小。
  // 本文件只收**没有其它写入方**的五张表。
  const timers: NodeJS.Timeout[] = [
    setInterval(() => {
      try {
        const n = purgeExpiredSessions(db);
        if (n > 0) app.log.info({ removed: n }, '清理过期会话');
      } catch (err) {
        app.log.error({ err }, '清理过期会话失败');
      }
    }, HOUR_MS),
    setInterval(() => {
      try {
        const n = pruneLogs(db, config.logRetentionDays);
        if (n > 0) app.log.info({ removed: n, retentionDays: config.logRetentionDays }, '裁剪历史日志');
      } catch (err) {
        app.log.error({ err }, '裁剪历史日志失败');
      }
    }, 6 * HOUR_MS),
    // 审计 / 任务 / 错误事件 / 广播表四条挂同一个 6h 节拍。**不为它们各起一个定时器**：
    // 四张表的量级都不大（审计按管理动作计、任务按批量动作计、错误事件按失败计、
    // 广播按管理写计），一天扫四次与一小时扫一次在库大小上没有可测差别，
    // 而多三个定时器就多三条可能在关停时漏清的尾巴。
    setInterval(() => {
      try {
        const n = pruneAudit(db, config.auditRetentionDays);
        if (n > 0) app.log.info({ removed: n, retentionDays: config.auditRetentionDays }, '裁剪历史审计');
      } catch (err) {
        app.log.error({ err }, '裁剪历史审计失败');
      }
      try {
        const n = pruneTasks(db, config.taskRetentionDays);
        if (n > 0) app.log.info({ removed: n, retentionDays: config.taskRetentionDays }, '裁剪历史任务');
      } catch (err) {
        app.log.error({ err }, '裁剪历史任务失败');
      }
      try {
        // 与 usage_logs 同口径（契约 §12.1 明文）。保留期取 logRetentionDays 而不是新配一个：
        // 契约已经把两者钉在同一个配置上，拆开只会让"为什么错误事件比用量明细活得久"变成疑问。
        const n = pruneGatewayErrorEvents(db, config.logRetentionDays);
        if (n > 0) app.log.info({ removed: n, retentionDays: config.logRetentionDays }, '裁剪历史错误事件');
      } catch (err) {
        app.log.error({ err }, '裁剪历史错误事件失败');
      }
      try {
        // 广播信道按**行数**裁，不是按天数 —— 判据是"消费者的 seq 追到哪了"。
        // 裁剪安全性分析见仓储层的注释（为什么 10000 行追不上 1s 节拍的消费者）。
        pruneChanges(db, config.changeLogKeepRows);
      } catch (err) {
        app.log.error({ err }, '裁剪变更广播失败');
      }
    }, 6 * HOUR_MS),
    setInterval(() => {
      try {
        loginLimiter.prune();
      } catch (err) {
        app.log.error({ err }, '清理登录限速表失败');
      }
    }, 5 * 60_000),
  ];

  // 关停顺序（谁先谁后、为什么 db.close() 必须在最后）收在 src/wiring/shutdown.ts，
  // 那里同时是被判据钉住的地方；这里只负责"信号 → 编排"这一段接线。
  const shutdown = createShutdownHandler({
    gateway,
    app,
    db,
    timers,
    // 冻结顺序第 1 步（PM 裁定 2）：先摘节拍再走 2/3/4，关停期间不再多打一次上游。
    stops: [egressProducer],
    log: app.log,
    exit: (code) => process.exit(code),
  });
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const onListenError = (err: unknown): void => {
    app.log.error({ err }, '监听失败');
    db.close();
    process.exit(1);
  };

  // 两个监听都起来才算启动完成：先起网关面（客户端在等），再起管理面
  gateway.app
    .listen({ host: config.hostGateway, port: config.portGateway })
    .then((address) => gateway.app.log.info({ address }, '网关面已启动 (/v1/*)'))
    .then(() =>
      app.listen({ host: config.hostAdmin, port: config.portAdmin }).then(
        (address) => app.log.info({ address, dbPath: config.dbPath }, '管理面已启动'),
        onListenError,
      ),
    )
    .catch(onListenError);
}

void main();
