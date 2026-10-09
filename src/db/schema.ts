// SQLite schema —— 管理面与网关**共享**的唯一事实存储（契约 §9）。
//
// 设计取舍：
//   1. 时间统一存 ISO8601 UTC 的 TEXT。字符串序 == 时间序，范围查询能直接用索引。
//   2. 布尔存 INTEGER 0/1（SQLite 没有 bool 类型），**转成 true/false 是仓储层的责任**，
//      API 响应里绝不出现 0/1（契约 §0.2）。
//   3. 金额存 INTEGER **分**；可空 —— 可空是关键，`null`(未知) 与 `0`(确实没钱) 是两个语义。
//   4. upstream_keys.secret 是 aes-256-gcm 密文 BLOB，**唯一**允许存 key 的位置（ADR-0006）。
//      masked_key 是派生冗余列：列表页要按后 4 位搜索/展示，每次解密不现实，
//      且它只含 4 位明文，落盘无风险。
//   5. key_runtime 与 upstream_keys 分表：前者是**网关进程运行态**，管理端只读（契约 §9）。
//      分开是为了让"管理端写 key"与"网关写健康态"不争用同一行的写锁 —— 热路径零等待。
//   6. gateway_error_events / gateway_health_snapshots（v1.1.0 观测面，契约 §12）同样是**显式列**，
//      不设自由 JSON 列。脱敏因此是构造性的：key_masked 这一列物理上放不下明文，
//      而不是"序列化时记得替换一下"。见 ADR-0013。

import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * 版本号只在**有数据/结构搬迁**时递增（纯加表加索引不递增）：
 *   1 → 2：删除 `gateway_keys.deleted_at`（ADR-0008 定案：网关 key 吊销是硬删）。
 * 递增后必须在 `migrate()` 里补上对应的搬迁分支，否则老库升不上来。
 */
export const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS admin_users (
  username      TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,          -- scrypt/argon2id 编码串（含 salt 与参数）
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,    -- 只存 sha256 摘要，库被读走也拿不到可用会话
  username     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS upstreams (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  base_url      TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  supplier      TEXT,                         -- 供应商能力位（本期唯一取值 'tierflow'）；NULL = 通用上游。能力位只看这一列，不猜 host（§2 / §15.6 / ADR-0018 决策 0）
  balance_query TEXT NOT NULL DEFAULT '{}',   -- JSON：{enabled,url,method,headers,body,parse,timeoutMs}
  revision      INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS upstream_keys (
  id                  TEXT PRIMARY KEY,
  upstream_id         TEXT NOT NULL REFERENCES upstreams(id),
  label               TEXT NOT NULL,
  masked_key          TEXT NOT NULL,
  secret              BLOB NOT NULL,          -- aes-256-gcm，见 src/db/crypto.ts
  category            TEXT NOT NULL CHECK (category IN ('balance','token-plan')),
  unlimited           INTEGER NOT NULL DEFAULT 0,  -- 1 = 上游无限额度（unlimited_quota）。**此时 balance_cents 必须为 NULL**：上游给的 remain_quota 是无意义负数（如 -331119），落库就成了"已欠费"（§15.6 / ADR-0018 决策 8）
  enabled             INTEGER NOT NULL DEFAULT 1,
  weight              INTEGER NOT NULL DEFAULT 1,
  model_limits        TEXT,                   -- 模型白名单 CSV（上游 model_limits，原样落盘，不解析）。NULL = 不限模型；空串/空 CSV 一律归一化为 NULL，**不落 ''**（§15.7 / ADR-0019 决策 2）
  balance_cents       INTEGER,                -- NULL = 未知（未知 != 0）
  balance_currency    TEXT,
  balance_updated_at  TEXT,
  balance_source      TEXT CHECK (balance_source IN ('manual','template')),
  token_plan_remaining INTEGER,
  token_plan_expires_at TEXT,
  today_tokens        INTEGER NOT NULL DEFAULT 0,
  today_day           TEXT,                   -- UTC 自然日，切换日时把 today_tokens 归零
  revision            INTEGER NOT NULL DEFAULT 1,
  deleted_at          TEXT,                   -- 软删；已软删不进任何合计与计数
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keys_upstream ON upstream_keys(upstream_id);
CREATE INDEX IF NOT EXISTS idx_keys_live ON upstream_keys(deleted_at, enabled);

CREATE TABLE IF NOT EXISTS key_runtime (
  key_id              TEXT PRIMARY KEY REFERENCES upstream_keys(id),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  cooldown_until      TEXT,
  last_failure_reason TEXT,
  last_failure_at     TEXT,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  rpm         INTEGER,                        -- NULL = 不限
  tpm         INTEGER,
  daily_quota INTEGER,                        -- 单位 token，NULL = 不限
  enabled     INTEGER NOT NULL DEFAULT 1,
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- 网关 key（客户端的凭据）。**没有 deleted_at**：吊销即物理删除（ADR-0008）。
-- 软删只会把"已吊销的凭据"重新引入查询面，而网关 key 吊销本就不需要可恢复；
-- 吊销痕迹由 audit_log 承担。因此本表也没有任何 includeDeleted 语义。
CREATE TABLE IF NOT EXISTS gateway_keys (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  key_hash   TEXT NOT NULL UNIQUE,            -- sha256，明文永不落盘亦不可再取回
  masked_key TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gateway_keys_group ON gateway_keys(group_id);

CREATE TABLE IF NOT EXISTS models (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  display_name        TEXT,
  upstream_id         TEXT NOT NULL REFERENCES upstreams(id),
  type                TEXT NOT NULL CHECK (type IN ('chat','embedding','image','audio','rerank')),
  capabilities        TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  context_length      INTEGER,
  price_input_per_1k  INTEGER,                      -- 分；NULL = 缺失（缺失 != 0）
  price_output_per_1k INTEGER,
  enabled             INTEGER NOT NULL DEFAULT 1,
  last_synced_at      TEXT,
  revision            INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (upstream_id, name)
);
CREATE INDEX IF NOT EXISTS idx_models_enabled ON models(enabled);

CREATE TABLE IF NOT EXISTS usage_logs (
  id                TEXT PRIMARY KEY,
  ts                TEXT NOT NULL,
  request_id        TEXT,                      -- 关联键（契约 §6 / ADR-0014）；本列上线前的历史行为 NULL
  group_id          TEXT,
  model             TEXT,
  upstream_id       TEXT,
  key_id            TEXT,
  key_masked        TEXT NOT NULL,             -- 永远只有 ****后4位
  status            INTEGER NOT NULL,
  error_code        TEXT,
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  is_estimated      INTEGER NOT NULL DEFAULT 0,
  latency_ms        INTEGER,
  ttfb_ms           INTEGER,
  stream            INTEGER NOT NULL DEFAULT 0,
  cost_cents        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON usage_logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_group_ts ON usage_logs(group_id, ts);
CREATE INDEX IF NOT EXISTS idx_logs_upstream_ts ON usage_logs(upstream_id, ts);

-- request_id 的索引**不在这里**建：老库的 usage_logs 没有这列，exec(DDL) 又跑在补列之前，
-- 写在这儿会让每台老库在启动时直接抛。两处索引统一在 migrate() 的补列之后建，见那里的注释。

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
  progress_done  INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  message        TEXT,
  result         TEXT,                          -- JSON
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks(started_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  ip          TEXT NOT NULL,
  action      TEXT NOT NULL,                    -- 如 key.create
  target_type TEXT NOT NULL,
  target_id   TEXT,
  result      TEXT NOT NULL,                    -- ok | fail
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);

-- 变更广播：网关进程靠它感知管理端的写入（另有 1s 轮询兜底，契约 §9）。
CREATE TABLE IF NOT EXISTS change_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op        TEXT NOT NULL,
  revision  INTEGER,
  at        TEXT NOT NULL
);

-- 观测面（契约 §12 / ADR-0013）。纯加表，SCHEMA_VERSION 不递增。
--
-- category 刻意**不加 CHECK 约束**：分型枚举是契约的东西，契约里加一个值不该需要一次建表迁移
-- （SQLite 改 CHECK 要重写表）。越界值在写入侧由 TS 联合类型与派发函数挡住 —— 编译期就拦住了，
-- 比运行期报错早一步。其余字段的 CHECK 都只约束"不可能正确"的值（如 severity 两值）。
CREATE TABLE IF NOT EXISTS gateway_error_events (
  id              TEXT PRIMARY KEY,
  ts              TEXT NOT NULL,               -- 网关侧时刻，落库不重打
  request_id      TEXT,                        -- 关联键（契约 §6 / ADR-0014）；同一次调用与 usage_logs 同值
  severity        TEXT NOT NULL CHECK (severity IN ('warn','error')),
  category        TEXT NOT NULL,               -- 9 值分型，契约 §12.1
  status          INTEGER NOT NULL,            -- 回给客户端的状态；客户端断开为 499
  gateway_code    TEXT,                        -- §10 的码；网关自身异常为 NULL
  failure_reason  TEXT,                        -- 与 key_runtime.last_failure_reason 同一套枚举
  endpoint        TEXT NOT NULL,
  model           TEXT,
  upstream_id     TEXT,                        -- 抹名引用：只 id，不存 baseUrl / 上游名
  key_id          TEXT,                        -- 抹名引用
  key_masked      TEXT,                        -- 永远只有 ****后4位（adr-0006 同一条纪律）
  stream          INTEGER NOT NULL DEFAULT 0,
  upstream_status INTEGER,                     -- 上游原始状态码；没打到上游为 NULL
  attempts        INTEGER NOT NULL DEFAULT 0,  -- 真实上游尝试次数；0 = 一次都没发出去
  candidates      INTEGER,
  latency_ms      INTEGER,
  message         TEXT                         -- 落盘前已 scrub + 截断 512 字符
);
CREATE INDEX IF NOT EXISTS idx_err_ts ON gateway_error_events(ts);
CREATE INDEX IF NOT EXISTS idx_err_category_ts ON gateway_error_events(category, ts);
CREATE INDEX IF NOT EXISTS idx_err_upstream_ts ON gateway_error_events(upstream_id, ts);
CREATE INDEX IF NOT EXISTS idx_err_key_ts ON gateway_error_events(key_id, ts);

-- 60s 一条的**历史**健康快照。刻意不存"原始样本"，只存当时算出来的结果：
-- usage_logs 会被保留期裁掉，事后重算会得到另一种历史 —— 那正是最难识别的假数据。
CREATE TABLE IF NOT EXISTS gateway_health_snapshots (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  window_sec   INTEGER NOT NULL,
  qps          REAL NOT NULL,
  success_rate REAL NOT NULL,
  requests     INTEGER NOT NULL,
  errors       INTEGER NOT NULL,
  p50_ms       INTEGER,                        -- NULL = 窗口内无样本（未知 != 0）
  p99_ms       INTEGER,
  key_total    INTEGER NOT NULL,
  key_healthy  INTEGER NOT NULL,
  key_cooling  INTEGER NOT NULL,
  key_disabled INTEGER NOT NULL,
  db_ok        INTEGER NOT NULL,               -- 0/1，出参转 bool
  error_count  INTEGER NOT NULL                -- 窗口内错误事件条数（含非上游类的）
);
CREATE INDEX IF NOT EXISTS idx_health_snap_ts ON gateway_health_snapshots(ts);

-- 余额快照（契约 §14.3 / ADR-0017）。**纯加表**，SCHEMA_VERSION 不递增、零迁移 ——
-- 同 gateway_error_events / gateway_health_snapshots 那两批，DDL 每次开库整体跑，
-- 旧库上照建。
--
-- 三处与 gateway_health_snapshots 刻意不同，都不是风格问题：
--   1. **无外键**。ADR-0016 起删上游是**物理删除**整棵子树，这里若写
--      REFERENCES upstreams(id)，"删上游"会在钱上再踩一次那个 500（还是删不掉，
--      因为快照行没人级联）。历史的可读性不靠外键保，靠下一列。
--   2. **upstream_name 存名字快照**。上游删掉后行仍在，展示名仍有来源
--      （同 usage_logs.key_masked 的做法：行自带可读标识，不依赖父行还在）。
--   3. **total_balance_cents 可空**：null = 那一刻该上游的 balance 类 key **全部未知**，
--      与 0（确实没钱了）严格区分（§0.2 / ADR-0003）。
--
-- 一条快照记的是"该上游此刻的状态"，不是"本次刷了多少把"（后者在 tasks 表）。
-- 所以它不带 ok/failed 计数 —— 那些是动作的结果，不是状态。
CREATE TABLE IF NOT EXISTS balance_snapshots (
  id                   TEXT PRIMARY KEY,
  upstream_id          TEXT NOT NULL,             -- 抹名引用：只 id，不存 baseUrl
  upstream_name        TEXT NOT NULL,             -- 名字快照：上游物理删除后历史仍可读
  ts                   TEXT NOT NULL,             -- 快照时刻（= 该上游本轮同步完成时刻，即上游级 asOf）
  total_balance_cents  INTEGER,                   -- 分；null = 全未知（不是 0）
  known_key_count      INTEGER NOT NULL,
  unknown_key_count    INTEGER NOT NULL,
  -- v1.6.0：无限额度 key 数。**加这一列不是为了好看** —— known 的口径是
  -- 「总数 − 未知 − 无限额度」，少了它前端看到"已知 0 / 未知 0"而该上游有 27 把 key，
  -- 却没有任何一格能解释那 27 把去哪了（§15.6：无限与未知永远是两个平行的计数）。
  unlimited_key_count  INTEGER NOT NULL DEFAULT 0,
  token_plan_key_count INTEGER NOT NULL,
  trigger              TEXT NOT NULL CHECK (trigger IN ('auto','manual')),
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_ts ON balance_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_upstream_ts ON balance_snapshots(upstream_id, ts);

-- 供应商账号面（契约 §15 / ADR-0018）。**纯加表**，SCHEMA_VERSION 不递增 ——
-- 同 balance_snapshots 那批，DDL 每次开库整体跑，旧库上照建。
--
-- 四条不是风格问题的取舍：
--   1. **凭据一律 aes-256-gcm 密文 BLOB，明文永不落盘**（ADR-0006 同一条纪律）。
--      encrypted_password 与 encrypted_session 是**两列**，不是一个 ——
--      §15.1 的 credentialSource 与 hasSession 是正交的两个问题（有密码但当前无会话
--      是合法过渡态），一列存不下这个状态。两个出参字段都由这两列**推导**，各自不单独存。
--   2. **identifier 是掩码，identifier_hash 是归一化真值的 sha256**。真值不进库
--      （"真值不出后端"），但同一上游内要能判重 —— 摘要是唯一同时满足这两件事的形状
--      （同 sessions.token_hash / gateway_keys.key_hash）。
--   3. **upstream_id 刻意不设外键**。删上游在 ADR-0016 之后是「按依赖序物理删整棵子树」，
--      而 §2 的守卫只报 keyCount / modelCount —— 账号既不在守卫里、也不在删除里。
--      此刻加外键，force=false 且名下只有账号时的那次删除会变成 **500**；
--      此刻把账号塞进删除里，又等于**不经确认静默删掉整批账号凭据**。两条都是错的，
--      所以先不加约束，把「删上游时账号怎么办」留作契约缺口，不在这里发明行为。
--   4. **不存套餐价、不存单价**。quota_per_unit 每次从上游读（§15.1），落库的只有
--      换算后的**分**。供应商改了换算比，我们的历史数不会跟着错。
--
-- ⚠ 给 Tier 2 写路径的约定（ADR-0021 决策 5）：改 egress_id 时**必须同时发一条 change_log**
--   （entity 'key'，entity_id = 受影响的每把 pooled_key_id）。网关快照只认 change_log，
--   而 supplier_accounts 不在它的实体清单里 —— 漏发的表现不是报错，是那把 key 的出口
--   永远停在旧值上（出口预算按 id 分桶，于是同一根出口被算成两根、放行量翻倍）。
--   本期没落这条写路径，所以这里只登记，不发明入口。
CREATE TABLE IF NOT EXISTS supplier_accounts (
  id                 TEXT PRIMARY KEY,
  upstream_id        TEXT NOT NULL,                 -- 抹名引用，刻意不设外键（见上）
  supplier           TEXT NOT NULL,                 -- 'tierflow'（本期唯一取值）
  identifier         TEXT NOT NULL,                 -- 掩码手机号 / 邮箱，列表直接展示这个
  identifier_hash    TEXT NOT NULL,                 -- 归一化真值 sha256，同一上游内判重
  username           TEXT,
  uid                TEXT,
  encrypted_password BLOB,                          -- 非空 ⇒ credentialSource = 'password'
  encrypted_session  BLOB,                          -- 非空 ⇒ hasSession = true
  session_expires_at TEXT,
  status             TEXT NOT NULL CHECK (status IN ('active','login_failed','session_expired','unknown')),
  status_message     TEXT,                          -- 面向人的一句话；只放供应商错误码，不含凭据
  balance_cents      INTEGER,                       -- 分；NULL = 未知（未知 != 0，ADR-0003）
  balance_currency   TEXT,
  balance_updated_at TEXT,                          -- 只在**真查到**时写；查失败不动（§14.2 同纪律）
  egress_id          TEXT,                          -- §16.7 Tier 2；NULL = 用宿主出口
  revision           INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (upstream_id, identifier_hash),            -- §15.9「一个账号只建一行」，两路凭据汇入同一行
  -- 「至少持有一路凭据」。这条不是洁癖：credentialSource 由这两列**推导**，
  -- 两列全空时它无值可推 —— 那种行在 DTO 里只能瞎猜一个，而它是永远登不上的死行。
  -- 会话过期**不清 BLOB**（只把 status 落 session_expired），所以这条不变量长期成立。
  CHECK (encrypted_password IS NOT NULL OR encrypted_session IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_supplier_accounts_upstream ON supplier_accounts(upstream_id);
CREATE INDEX IF NOT EXISTS idx_supplier_accounts_status ON supplier_accounts(status);

-- 出口 IP 池（契约 §16.7 Tier 2 / ADR-0020；生命周期见 ADR-0021 决策 9）。**纯加表**。
--
-- url 只放 scheme://host:port，**不放凭据**；代理认证走 secret（aes-256-gcm 密文 BLOB，
-- 与 upstream_keys.secret 同一形状）。"凭据不存值"的正确落法是**不存明文** ——
-- 一个连不上的代理不是出口，所以这里存的是可用凭据，但明文永不落盘、永不出后端。
--
-- v1.7.0 三处形状（ADR-0021 决策 9，表未发布 ⇒ 逐字替换、零迁移）：
--   1. status 单轴：enabled + 退役位两列能组合出"启用且已退役"，而选择器要滤两处 ⇒
--      漏一处就是静默选错的出口。改成单列枚举，只有一处要滤。
--   2. retired **不删行**：删了它，历史用量 / 统计 / §7 帧就失去宿主 —— egressId 必须比 IP 活得久。
--   3. url 归一化后 UNIQUE：同 URL 两行 = 两个 egressId = 两个桶 = 放行量翻倍；且"退役后重建同 URL"
--      会拿到一个新桶 —— 等于改个名字白拿一次额度。**回池只有一条路：复用原 id 改回 active**。
--      UNIQUE 只在**归一化之后**才拦得住 HTTPS://A.EXAMPLE:443 与 https://a.example 是同一个出口，
--      所以写库前必须走 src/egress 的同一份归一化。
CREATE TABLE IF NOT EXISTS egress_proxies (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  url            TEXT NOT NULL UNIQUE,              -- scheme://host:port（归一化后落库），不含 user:pass
  secret         BLOB,                              -- aes-256-gcm：代理认证；NULL = 免认证
  region         TEXT,                              -- 备注用：hk / cn-bj / us
  note           TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  retired_reason TEXT CHECK (retired_reason IS NULL OR retired_reason IN ('replaced','manual')),
  retired_at     TEXT,                              -- ISO8601；退役即写，回池不清
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  -- 没有原因的 retired 半年后没人判断得了它能不能删 ⇒ 退役必须带原因。
  last_test_at   TEXT,                              -- ISO8601；最近一次 /test；NULL = 未测
  last_test_ok   INTEGER,                           -- 0/1；NULL = 未测（未知 != 失败）
  CHECK (status <> 'retired' OR retired_reason IS NOT NULL)
);

-- 账号套餐（契约 §15.1 subscriptions）。**纯加表**。
--
-- 套餐**不建成 key**、不引入 token-plan 新行（ADR-0018 决策 7）：它的余额是**账号级**的，
-- 且上游给的是 N 个套餐各带掩码。金额一律 …_cents(int 分) —— 上游 paid_money 是
-- **浮点元**（29.9 * 100 = 2989.9999999999995），换算必须 Math.round，截断会系统性少算一分。
-- 顺带：套餐摘要也是**冷读**来源（§15.3 说套餐刷新走 /api/subscription/self 且**不消耗限流**）。
CREATE TABLE IF NOT EXISTS supplier_account_subscriptions (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES supplier_accounts(id),
  sub_no             TEXT NOT NULL,                 -- 上游套餐号（SB…），稳定标识
  plan_title         TEXT,
  plan_slug          TEXT,
  amount_total_cents INTEGER,
  amount_used_cents  INTEGER,
  paid_cents         INTEGER,
  basic_token_total  INTEGER,
  basic_token_used   INTEGER,
  status             TEXT,
  source             TEXT,
  start_at           TEXT,
  end_at             TEXT,
  auto_renew         INTEGER,                       -- 0/1；NULL = 上游没给（不是 false）
  has_key            INTEGER NOT NULL DEFAULT 0,
  key_masked         TEXT,                          -- 套餐 key 只有掩码，进不了池
  updated_at         TEXT NOT NULL,
  UNIQUE (account_id, sub_no)
);
CREATE INDEX IF NOT EXISTS idx_supplier_subs_account ON supplier_account_subscriptions(account_id);

-- 账号名下的 key（契约 §15.1 keyCount / unlimitedKeyCount / maskedKeyCount）。**纯加表**。
--
-- pooled_key_id 非空 = 已入池（keyCount 那一格）；空 = 只拿到掩码、进不了池
-- （maskedKeyCount 那一格，**不得与 keyCount 相加**）。unlimitedKeyCount 不在这里存 ——
-- 它按 §15.7 从 upstream_keys.unlimited 现算，两个数各存一份早晚会对不上。
--
-- 两条刻意不做的事：
--   1. **masked_key 不加 UNIQUE**。掩码只有后 4 位，两把不同的 key 撞后 4 位是正常事件，
--      加了它等于把一次正常同步变成约束报错。判重是同步写入方的责任（按账号整体替换，
--      §15.2 keys/sync），不是这一列的职责。
--   2. **pooled_key_id 不设外键**。upstream_keys 会被 deleteUpstream 整批物理删除，
--      加了外键就把那条已冻结、已被测的删除路径变成 500 —— 与 upstream_id 同一个理由。
CREATE TABLE IF NOT EXISTS supplier_account_keys (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES supplier_accounts(id),
  masked_key    TEXT NOT NULL,
  pooled_key_id TEXT,                               -- NULL = 只拿到掩码，进不了池
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_keys_account ON supplier_account_keys(account_id);

-- pooled_key_id 的**部分唯一索引**（ADR-0021 决策 5 的 E 接缝）。纯加索引，SCHEMA_VERSION 不递增。
--
-- 网关的 KEYS_SQL 要 join 这张台账才能知道"这把 key 属于哪个账号 / 走哪个出口"，
-- 一对一是那条 join 成立的前提：一旦 fan-out（同一个 pooled_key_id 被两条台账行引用），
-- 同一把 key 会在池里出现两遍 —— 出口预算的放行量翻倍，而且症状看起来像"路由算法抽风"。
-- 台账写入方（linkSupplierAccountKey / replaceSupplierAccountKeyLedger）本来就按
-- upsert-by-(account_id, pooled_key_id) 写，这里只是把那条**约定**变成**约束**。
--
-- 为什么是部分索引：纯掩码行（pooled_key_id IS NULL）可以有任意多条，
-- 全局 UNIQUE 会让"同一个后 4 位出现两次"这种**正常事件**变成约束报错 —— 同上一条刻意不做的事。
-- （本段不写反引号：它在模板字符串里，反引号会当场截断整段 DDL。）
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_account_keys_pooled
  ON supplier_account_keys(pooled_key_id) WHERE pooled_key_id IS NOT NULL;
`;

/** 列是否存在。删列是"只做一次"的搬迁，靠它判幂等 —— 版本号只当记账用。 */
function hasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as { name: string }[];
  return rows.some((r) => r.name === column);
}

/**
 * 建 `uq_supplier_account_keys_pooled` 之前先数一遍 fan-out 行 —— **非 0 就地 fail-closed**。
 *
 * 为什么不能等索引自己报错：库里已有重复时 `CREATE UNIQUE INDEX` 抛的是
 * `SQLITE_CONSTRAINT: UNIQUE constraint failed`，既不说哪张表、也不说哪几行；
 * 排障得倒着读整段 DDL 才找得到病根，而它表现为"服务起不来"。
 * 这里先把**具体的 pooled_key_id** 报出来，让拿到日志的人知道该去删哪一行。
 *
 * 不静默的取舍已定：库里有 fan-out 说明**事实已经分叉**（两把台账行都在声称同一把 key），
 * 自动挑一条删掉等于替用户决定"哪条为准"。宁可不开门，也不猜。
 */
function assertNoPooledKeyFanOut(db: SqliteDatabase): void {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'supplier_account_keys'")
    .get();
  if (table === undefined) return; // 新库：表与索引在本次 DDL 里同批建出来，没有历史数据可查

  const dupes = db
    .prepare(
      `SELECT pooled_key_id AS pooledKeyId, COUNT(*) AS n
         FROM supplier_account_keys
        WHERE pooled_key_id IS NOT NULL
        GROUP BY pooled_key_id
       HAVING COUNT(*) > 1
        LIMIT 5`,
    )
    .all() as { pooledKeyId: string; n: number }[];
  if (dupes.length === 0) return;

  const detail = dupes.map((d) => `${d.pooledKeyId} ×${d.n}`).join(', ');
  throw new Error(
    `supplier_account_keys 存在 fan-out 行（同一 pooled_key_id 被多条台账行引用）：${detail}` +
      `${dupes.length === 5 ? '（只列前 5 组）' : ''}。` +
      '建 UNIQUE(pooled_key_id) 部分索引会失败；即便强行建上，这把 key 也会在网关池里出现多次，' +
      '导致出口预算放行量翻倍。请先人工判定哪条台账行为准（删除多余的行），再启动。',
  );
}

/**
 * 建表 / 迁移。幂等：DDL 全是 IF NOT EXISTS，搬迁分支自身也判存在性，
 * 所以重复调用无副作用、可以安全地在每次开库时跑。
 */
export function migrate(db: SqliteDatabase): void {
  assertNoPooledKeyFanOut(db);
  db.exec(DDL);

  // v1 → v2：gateway_keys.deleted_at 删列（ADR-0008）。
  // 判据刻意用"列在不在"而不是 `user_version < 2`：DDL 里新库本就没这列，
  // 而任何一份 v1 老库都一定有 —— 前者跳过、后者搬迁，同一句代码覆盖两种库，
  // 也就不会因为某个中间状态（user_version 被写过但列没删）而永久漏迁。
  if (hasColumn(db, 'gateway_keys', 'deleted_at')) {
    // DROP COLUMN 会重写整表，包在事务里：中途失败不留"删了一半"的库。
    db.transaction(() => {
      // 先删干净 deleted_at 非空的行，再删列。顺序不能反：
      // 万一老库里存在"已软删"的行，删列会把它**复活成一把有效凭据** ——
      // 吊销是硬删，所以这些行本就该消失，而不是变成活 key。
      db.exec('DELETE FROM gateway_keys WHERE deleted_at IS NOT NULL');
      db.exec('ALTER TABLE gateway_keys DROP COLUMN deleted_at');
    })();
  }

  // v1.1.1：关联键 request_id（ADR-0014）。两张表各一列，**纯加列**，SCHEMA_VERSION 不递增。
  //
  // 判据同样用"列在不在"：老库两表都没这列 → 补；新库建表时已带 → 跳过。重复跑无副作用。
  // 注意这里与 ADR-0013 那批的区别：那批是**纯加表**（只改 CREATE TABLE 文本就够），
  // 这一批是给**既有表加列** —— 只改文本对已经在跑的库没有任何作用，必须真发 ALTER。
  db.transaction(() => {
    for (const table of ['usage_logs', 'gateway_error_events'] as const) {
      if (!hasColumn(db, table, 'request_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN request_id TEXT`);
      }
    }
    // 索引必须建在补列**之后**：老库上这条语句在列还不存在时执行会直接抛，把启动一起带走。
    // 放在循环之后也顺带覆盖新库（新库两列已在 CREATE TABLE 里，走不到 ALTER 那支）。
    //
    // 只建 (request_id) 单列索引，不跟 ts：这一列基数近似唯一（一次调用一个值），
    // 点查命中 1 行日志 + 0..n 条事件，拿到的行少到不需要 ts 再切；
    // 而 upstream_id / key_id 那种低基数列必须带 ts，否则一个 key 会拖出全表。
    db.exec('CREATE INDEX IF NOT EXISTS idx_logs_request_id ON usage_logs(request_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_err_request_id ON gateway_error_events(request_id)');
  })();

  // v1.7.1：egress_proxies 的 last_test_at / last_test_ok。
  //
  // 为什么这两列要 ALTER：这张表在早期批次（v1.4.8 Tier 2 DDL）就已随开库建进**运行中的库**，
  // 而两列是后来才加进 CREATE TABLE 文本的 —— `CREATE TABLE IF NOT EXISTS` 撞上已存在的表
  // 是空操作，那些库的列永远进不来，`SELECT last_test_at`（GET /api/egress 的 DTO 需要）一跑就炸。
  // 可空、无默认：老行 NULL = 未测（DTO `lastTestOk: null`），"没测过"既不是 ok 也不是 failed，
  // 不是缺一个默认值。判据同前两批用"列在不在"，同一句代码覆盖新库与老库，幂等。
  db.transaction(() => {
    for (const [column, decl] of [
      ['last_test_at', 'TEXT'],
      ['last_test_ok', 'INTEGER'],
    ] as const) {
      if (!hasColumn(db, 'egress_proxies', column)) {
        db.exec(`ALTER TABLE egress_proxies ADD COLUMN ${column} ${decl}`);
      }
    }
  })();

  // v1.4.x：供应商能力位 + key 模型白名单（契约 §15.7，ADR-0018 / ADR-0019）。**纯加列**，SCHEMA_VERSION 不递增。
  //
  // 与 ADR-0013 那批（纯加表）的区别同 v1.1.1：这三列是加给**既有表**的。
  // 只改上面的 DDL 文本对已经在跑的库**没有任何作用** —— `CREATE TABLE IF NOT EXISTS` 撞上
  // 已存在的表是空操作，`upstreams` / `upstream_keys` 正是这种表：老库里它们早就存在，
  // 于是"新列"永远进不来，而下一次 `SELECT model_limits` 才炸。必须真发 ALTER。
  //
  // 守卫必须是 hasColumn() 而非 user_version：ADD COLUMN **不幂等**，重复执行抛
  // `duplicate column name`，而这段跑在每次 openDatabase() 里，会把开库一起带走。
  // 判据也用"列在不在"而非"库新不新"：新库建表时已带这三列 → 跳过；老库没有 → 补。
  // 同一句代码覆盖两种库，中间状态（用户版本号被写过但列没加）也不会永久漏迁。
  db.transaction(() => {
    const added: [table: string, column: string, decl: string][] = [
      // 可空、无默认：老行 NULL = 不走供应商能力位，与加列前逐字一致（§15.6：不猜 host，只看这一列）。
      ['upstreams', 'supplier', 'TEXT'],
      // 有默认值：老行填 0 == "非无限额度"，正是我们要的语义（§15.6 / 决策 8）。
      ['upstream_keys', 'unlimited', 'INTEGER NOT NULL DEFAULT 0'],
      // 可空、无默认：老行 NULL == "不限模型"，与加列前逐字一致（§3：null 与 [] 同义，库里不出现 ''）。
      ['upstream_keys', 'model_limits', 'TEXT'],
      // 有默认值：老快照行填 0 == "那一刻没有无限额度 key"。**这个 0 是有依据的**，
      // 不是补一个好看的空缺：`unlimited` 这一列本身就是 v1.4.0 才有的，
      // 比它更早的快照里不可能存在无限额度 key。
      ['balance_snapshots', 'unlimited_key_count', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [table, column, decl] of added) {
      if (!hasColumn(db, table, column)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
      }
    }
  })();

  const current = db.pragma('user_version', { simple: true }) as number;
  if (current < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
