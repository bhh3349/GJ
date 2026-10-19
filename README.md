# sub-gateway

LLM 网关：固定上游 Base URL + 账号池轮转，OpenAI 兼容透传 + Web 管理后台（React + Ant Design 深色主题）。

## 架构一览

- **网关面**（缺省 4000，`/v1/*`）：OpenAI 兼容透传，池内 key 轮转、冷却阶梯、故障切换。
- **管理面**（缺省 4001，`/`）：React SPA + `/api/*` 控制面。**除 `auth/login` 外全量鉴权**。
- **存储**：SQLite（better-sqlite3，WAL），库内密钥一律 AES-256-GCM 密文。
- **出口探活**（可选）：VPS 侧 `deploy/vps-egress/`，心跳 JSON 报告进收件箱目录。

详细架构与 33 条 ADR 见 `docs/`；交接摘要见 `HANDOVER.md`；开发约束见 `docs/开发约束-v1.0.md`。

## 快速开始（Docker，推荐）

```bash
# 1) 前端产物（镜像不构建前端）
pnpm install --frozen-lockfile
pnpm web:build

# 2) 镜像
docker build -t sub-gateway:local .

# 3) 配置：.env 最少填 MASTER_KEY（32 字节 base64）与管理员账号
cp .env.example .env

# 4) 启动 + 验证
docker compose up -d
docker compose ps   # STATUS 应为 (healthy)
```

完整步骤、数据迁移、备份、更新流程见 **[deploy/docker-deploy.md](deploy/docker-deploy.md)**。

## 快速开始（裸跑开发）

```bash
pnpm install --frozen-lockfile
pnpm dev                # tsx watch src/server.ts（网关 + 管理面一起起）
pnpm web:dev            # 另开终端，Vite dev server
```

生产 `.env` 关键项：`MASTER_KEY`（硬要求）、`ADMIN_USERNAME/ADMIN_PASSWORD`、
`ADMIN_WEB_DIST=web/dist`（同源托管管理界面）。

## 四条门禁

本地与 CI 同一套口径（`.github/workflows/ci.yml`）：

```bash
pnpm run check:sqlite    # G1: 原生 sqlite + WAL + aes-256-gcm 真加载
pnpm run typecheck
pnpm test
pnpm run build && test -f dist/server.js
pnpm run check:shutdown  # 优雅停机顺序 + 真 SIGTERM
pnpm run check:secrets   # key 明文永不落盘
```

**Node 版本纪律**：Node ≥22 <23（`engines` 钉死）。v24 会 `ERR_DLOPEN_FAILED`
弄坏 better-sqlite3 原生 ABI，症状像模块自己的 bug，实为环境选错。

## 安全红线

- `.env` 含真实上游凭据 → 不入包不入库（`.gitignore` + `.dockerignore` 双重排除）。
- 库内密钥只存 AES-256-GCM 密文，`MASTER_KEY` 丢失 = 全部密文作废。
- 管理面是对完整控制面，对外部署走反代 + TLS，compose 里把 4001 绑回环。

## License

见 [LICENSE](LICENSE)。
