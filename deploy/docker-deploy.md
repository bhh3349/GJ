# sub-gateway Docker 部署（单机）

> 2026-10-19 由部署准备生成。前置阅读：根目录 `Dockerfile` 头注释（三条构建决定）、
> `docker-compose.yml` 注释（健康探针为什么是 WS 101 而不是 HTTP 200）。

## 0. 前置条件

- Docker 29+ / compose v2（本机实测 29.8.1 / v5.5.1）
- `node:22-bookworm-slim` base image 能拉取。**DNS 污染网络注意**：
  - daemon 的 `HTTP_PROXY`（`/etc/systemd/system/docker.service.d/http-proxy.conf`）
    只管 `docker pull`，**不管 BuildKit 的 frontend 拉取**；
  - 所以 `Dockerfile` 里**不放** `# syntax=docker/dockerfile:1` 行 —— 它会触发
    BuildKit 拉外部 frontend 镜像，那条路径不走代理，直接超时。
  - 症状识别：`docker build` 报 `failed to fetch anonymous token ... i/o timeout`
    且指到 `docker-image://docker/dockerfile:1`，就是这条。

## 1. 构建

```bash
# 前端先出产物（镜像不构建前端，见 Dockerfile 头注释）
pnpm web:build

# 后端镜像（依赖层有缓存，源码改动只重建后两层）
docker build -t sub-gateway:local .
```

**Node 版本纪律**：宿主机跑 `pnpm web:build` 必须 `/opt/node22/bin/node`（默认
node v24 会弄坏 better-sqlite3 原生 ABI —— 只影响宿主机构建，镜像内已钉 22）。

## 2. 配置

```bash
cp .env.example .env   # 然后按需改，或用部署准备时已生成的那份
```

`.env` 最少要填：

| 键 | 说明 |
|---|---|
| `MASTER_KEY` | **硬要求**。32 字节 base64：`/opt/node22/bin/node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`。换 key = 库内全部密文作废 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 首次启动自动引导管理员 |
| `DB_PATH` | 容器内写 `/app/data/gateway.db`（compose 强制覆盖，写一致即可） |
| `ADMIN_WEB_DIST` | 容器内写 `/app/web/dist`（指向 compose 挂载的只读卷） |
| `PORT_GATEWAY` / `PORT_ADMIN` | 宿主机端口。**缺省 4100/4101** —— 与 LAN 测试实例（裸跑 node，占 4000/4001）错开。切换 = 停掉裸实例后改回 4000/4001 |

`.env` 已被 `.gitignore` + `.dockerignore` 双重排除，绝不入包/入镜像。

## 3. 启动与验证

```bash
docker compose up -d

# 健康探针是 WS 升级握手（/api/stats/live 的 101），不是 HTTP 200 ——
# /api/* 全量鉴权，HTTP 探针恒 401，会把好容器反复重启。看 compose 注释。
docker compose ps          # STATUS 应是 (healthy)
docker compose logs --tail 50 gateway

# 双面在听
curl -sI http://127.0.0.1:4100/v1/models | head -1     # 网关面（401/404 都算"活着"）
curl -sI http://127.0.0.1:4101/ | head -1              # 管理面应 200
```

管理界面：`http://<host>:4101`，用 `.env` 里的 `ADMIN_USERNAME/ADMIN_PASSWORD` 登录。

## 4. 数据与备份

- SQLite 在**命名卷** `sub-gateway-data`（不是 bind —— NFS/CIFS 上 fcntl 锁不可靠）。
- 备份：
  ```bash
  docker run --rm -v sub-gateway-data:/data -v $PWD:/out alpine cp /data/gateway.db /out/
  ```
- 从裸跑实例迁移数据：先停裸实例（保证 WAL 落盘），把 `data/*.db` 灌进卷：
  ```bash
  docker run --rm -v sub-gateway-data:/data -v $PWD:/src alpine sh -c \
    "cp /src/data/test-lan.db /data/gateway.db && chown 0:0 /data/gateway.db"
  # 注意：master key 不同 = 库内密文作废。迁移就要沿用原实例的 MASTER_KEY。
  ```

## 5. 更新

```bash
git pull && pnpm install --frozen-lockfile
pnpm web:build
docker compose build && docker compose up -d   # 数据在命名卷，重建不动数据
```

## 6. 已知不粉饰

- 镜像留着构建期工具链（python3/make/g++，~120MB）：没做 multi-stage，
  因为 `COPY --from` 搬 node_modules 有搬漏原生 `.node` 的风险，自用镜像不为 120MB 付它。
- `EGRESS_HEARTBEAT_INBOX_DIR`（入口 A）缺省关，要开在 `.env` + compose 卷两处一起。
- 管理面 4101 对整个网段开放（compose `ports` 的左半边是 `4101`，不是 `127.0.0.1:4101`）。
  裸跑实例时代它也是 0.0.0.0 —— 但切到对外部署时**必须**改 `127.0.0.1:4101` + 反代 TLS。
