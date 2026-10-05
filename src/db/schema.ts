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

import type { Database as SqliteDatabase } from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

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
  enabled             INTEGER NOT NULL DEFAULT 1,
  weight              INTEGER NOT NULL DEFAULT 1,
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

CREATE TABLE IF NOT EXISTS gateway_keys (
  id         TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id),
  key_hash   TEXT NOT NULL UNIQUE,            -- sha256，明文永不落盘亦不可再取回
  masked_key TEXT NOT NULL,
  label      TEXT,
  deleted_at TEXT,
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
`;

/**
 * 建表 / 迁移。幂等：全部 IF NOT EXISTS，重复调用无副作用。
 * user_version 留给后续带数据搬迁的迁移用；纯加表加索引不需要它。
 */
export function migrate(db: SqliteDatabase): void {
  db.exec(DDL);
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current < SCHEMA_VERSION) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}
