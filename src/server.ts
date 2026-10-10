// 进程入口：读配置 → 开库 → 建管理员 → 起**两个**监听（网关面 / 管理面）→ 挂维护定时器。
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
// 维护定时器（清过期会话 / 裁日志 / 清限速表）在**同一个进程**里跑：
// 再起一个 cron 进程去写库，就同时有两个写者了。

import { buildApp } from './api/app.js';
import { unwiredAssistantInvoker } from './api/assistant-port.js';
import { LoginRateLimiter, bootstrapAdmin, purgeExpiredSessions } from './api/auth.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { pruneLogs } from './db/repo/logs.js';
import { listEgressProxies } from './db/repo/egress.js';
import { EGRESS_BUDGET_PLACEHOLDER, createEgressGate } from './gateway/egress.js';
import { startHeartbeatProducer } from './egress/heartbeat.js';
import type { EgressShadowRecord } from './egress/port.js';
import {
  createAssistantInvoker,
  createAssistantMetrics,
  createGatewayRuntime,
  createShutdownHandler,
  mountGatewayRoutes,
} from './wiring/index.js';

const HOUR_MS = 3_600_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase({ path: config.dbPath });

  // 首次启动没有管理员且没给 ADMIN_PASSWORD 时会在这里抛错并退出（fail-fast）
  bootstrapAdmin(db, process.env);

  const loginLimiter = new LoginRateLimiter();

  // 出口（IP）预算闸（契约 §16.7 / ADR-0021 决策 4c）：**造一次、注入两处** ——
  // 下一行的网关装配（数据面）与后面的 `buildApp({ egress })`（管理面）拿到**同一个对象**。
  // 建两个实例不是性能问题而是正确性问题：上游按**来源 IP** 计数，两侧扣的是同一张配额表，
  // 各持一份 = 各自以为还有额度（`src/egress/port.ts` 文件头那段"两条车道共同的约束"）。
  //
  // 预算值引用 `EGRESS_BUDGET_PLACEHOLDER` 这**一份**常量，不在这里抄数字：
  // 标定回填时"只改数、不改结构"（决策 8），抄第二遍就等于标定只改到了一半。
  //
  // **mode: 'active'**（⑧ 转正，PM 裁定 1）：判据从此真正启用 —— 上游确认的出口级 429
  // 会真的置起冷却，§7 `egress_cooldown` 帧从此开始发射（v1.4.9「本期不发射」由本笔翻篇）。
  // 判据照 §16.7.3 v6 `distinctAccounts` 窗口化落（同出口 60s 滑动窗内 ≥3 个不同账号）。
  //
  // shadow 记录的去处在下面 `logShadow` 那一跳 —— 见那里的注释（为何要晚绑到网关 app 的 logger）。
  let logShadow: (record: EgressShadowRecord) => void = () => {};
  const egress = createEgressGate({
    budget: EGRESS_BUDGET_PLACEHOLDER,
    mode: 'active',
    onShadow: (record) => logShadow(record),
  });

  // 网关 runtime 自带内存快照 + 明文缓存；`stop()` 负责最后一次用量落库、最后一次
  // key 运行态镜像（ADR-0010）与清明文 —— 都在 db.close() 之前，否则 flush 会写到已关的连接上
  // 503 出口选择器判据缝（ADR-0021 决策 9(5)，装配层方案 A）：**请求期现查** `egress_proxies`，
  // 不缓存 —— retire/reactivate 立即生效（零失步窗口）；表是个位数行，一条同步 SELECT 微秒级。
  // 「启用 = 行数 > 0」：0 行 = 池未启用 ⇒ 恒真（fail-open 宿主直连、不判 503；与决策 9(5)
  // 「`egress_id IS NULL` 是配置事实照常走宿主出口」同一条纪律）。有行时逐 id 查单轴 `status`：
  // `active` = 活绑定；`retired` / 查无此行 = 死绑定 ⇒ 全部候选都死时引擎回
  // 503 NO_AVAILABLE_EGRESS（不带 Retry-After、不回落直连，分型见 engine.ts 收尾段）。
  // 刻意提成命名常量、保持下方调用对象扁平：egress.spec 的生产装配锁用
  // `createGatewayRuntime\(\{[^}]*\begress\b[^}]*\}\)` 钉「数据面拿到同一个 egress 实例」，
  // 对象里嵌函数体会让该正则失配 —— 装配锁不为此放宽，改的是装配写法。
  const egressSelectable = (egressId: string): boolean => {
    const rows = listEgressProxies(db);
    if (rows.length === 0) return true;
    return rows.some((row) => row.id === egressId && row.status === 'active');
  };
  const gateway = createGatewayRuntime({ db, config, logger: true, egress, egressSelectable });

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
  // `nodes` 为空数组时生产者照跑：`poolSnapshot()` 回 `[]`，发射面据此发「未配置出口」的空池帧。
  const egressProducer = startHeartbeatProducer({
    gate: egress,
    nodes: listEgressProxies(db)
      .filter((row) => row.status === 'active')
      .map((row) => ({ egressId: row.id, name: row.name, proxyUrl: row.url })),
    inboxDir: config.egressHeartbeatInboxDir,
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
    app.log.info({ model: config.assistantModel }, '内置助手已接线');
  }


  // 维护任务一律 try/catch 吞掉异常：清垃圾失败不该把整台服务带走，
  // 下一次 tick 还会再来一遍。
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
