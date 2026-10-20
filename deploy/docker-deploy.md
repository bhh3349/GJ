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

## 3b. 迁移旧库进容器（实测踩过的三个坑）

```bash
# 不停机一致性快照（**不要用 cp** —— 源库有未 checkpoint 的 WAL，cp 拿到的是
# 撕裂的库；实测源库 -wal 有 4MB）
node -e "const d=require('better-sqlite3')('data/test-lan.db',{readonly:true});
         d.prepare(\"VACUUM INTO '/tmp/gateway-migrate.db'\").run(); d.close();"

# 灌进**带 compose 项目名前缀**的卷 —— 见坑 1
docker run --rm -v sub_sub-gateway-data:/data -v /tmp:/src:ro alpine sh -c \
  "rm -f /data/gateway.db*; cp /src/gateway-migrate.db /data/gateway.db"
```

`.env` 的 `MASTER_KEY` **必须是旧库那把**，否则迁过去的凭据全是解不开的废密文
（换 key = 库内密文作废）。旧实例的 key 存在 `/root/sub-test-lan.env.bak`（600）。

### 坑 1：compose 命名卷带项目名前缀

`docker volume create sub-gateway-data` 建的是**裸名卷**，而 compose 挂载的是
`<项目名>_<卷名>`（本目录项目名 = `sub` → `sub_sub-gateway-data`）。两者是**不同的卷**。
症状：手动灌的卷"数据齐全"，但容器启动日志出现「已创建管理组」——因为它挂的是空卷，
走了首次引导。**核对方法**：
```bash
docker inspect <容器> --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
```
灌数据请直接灌 inspect 报出来的那个卷名。

### 坑 2：`.env` 的 `PORT_*` 被 env_file 注入容器，改了容器内监听端口

`.env` 把 `PORT_GATEWAY=4100`（宿主端口）也注入了容器，进程于是**在容器内听 4100**，
而 `ports: "4100:4000"` 往容器 4000 转发 → `ECONNREFUSED`。更阴的是健康检查脚本读
`process.env.PORT_ADMIN`，恰好探到错端口上的真服务 → **误报 healthy**。已在 compose
的 `environment` 段把 `PORT_GATEWAY/PORT_ADMIN` 强制覆盖回 4000/4001（宿主机端口只由
`ports` 左半边决定）。

### 坑 3：宿主机 `daemon.json` 的全局 `dns` 把容器解析全打死

宿主 `/etc/docker/daemon.json` 里有 `"dns": ["127.0.0.1"]`（AdGuard Home 占宿主 :53）。
这个全局值会被 docker 注入**每个容器**的内置解析器（`resolv.conf` 里的
`ExtServers: [127.0.0.1]`）—— 而容器里的 127.0.0.1 是**容器自己**，那个地址上没有
DNS，于是所有外网域名一律 SERVFAIL。症状极具误导性：网关日志里全是
`last failure NETWORK`、上游"看起来全挂了"，但宿主机 `curl` 一切正常 ——
因为它不是网络问题，是**只有容器瞎了**。

```bash
# 核对（两行都要有输出才算通）
docker exec <容器> getent hosts tierflow.cn
docker exec <容器> cat /etc/resolv.conf | grep ExtServers
```

修法在 `docker-compose.yml` 的 gateway 服务级 `dns:`（223.5.5.5 / 119.29.29.29），
**不动 daemon.json** —— 改全局值会把这台机器上其他没坏过的容器栈一起卷进来，
爆炸半径不可接受。别把这里的 dns 填成宿主的 172.x.0.1 网关地址：那等于绕回
AdGuard，回到同一个坑。

## 4. 数据与备份

- SQLite 在**命名卷** `sub-gateway-data`（不是 bind —— NFS/CIFS 上 fcntl 锁不可靠）。
  compose 挂的实际卷名带项目名前缀（本目录 = `sub_sub-gateway-data`），见坑 1。
- 备份用 `deploy/backup.sh`（**装箱脚本，别手敲 `cp`**）：

  ```bash
  scp deploy/backup.sh deploy/snapshot.cjs root@<host>:/opt/sub/
  chmod 700 /opt/sub/backup.sh
  /opt/sub/backup.sh                      # 先手动跑一遍确认
  crontab -e                              # 再挂上：
  # 30 3 * * * /opt/sub/backup.sh >> /var/log/sub-backup.log 2>&1
  ```

  为什么不是 `cp`：源库有未 checkpoint 的 WAL（实测 -wal 有 4MB），`cp` 拿到的是
  **撕裂的库**。脚本用只读连接 + `VACUUM INTO` 出完整快照，保留最近 14 天。
  为什么要有 `snapshot.cjs` 而不是 `node -e`：引号在 sh → docker → node 三层之间
  必炸（实测 `SyntaxError: Invalid regular expression flags`），文件化后只剩一层。
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

改了后端代码时的实测流程（2026-10-20，499 修复部署）：

- 前端没动就跳过 `pnpm web:build`（`web/dist` 是 bind 只读挂载，容器直接读宿主机的文件）。
- `docker compose up -d --force-recreate gateway` 会在新镜像存在时只重建容器；纯
  `docker build -t sub-gateway:local .` + `--force-recreate` 与 `docker compose build` 等价。
- 镜像建了先验证再换容器：`docker run --rm --entrypoint node sub-gateway:local -e "..."` 查
  `dist/` 里是否真有新代码——镜像标签对不代表内容新。
- 重建前做 DB 快照（VACUUM INTO 只读连接跑，`docker cp` 拷出来），数据虽在命名卷
  理论上不动，但快照在手，任何翻车都能回到重建前一刻。
- 建议同时打日期标签（`-t sub-gateway:2026-10-20`），回滚就是 `docker tag` 换回去 + recreate。

## 5b. 全新部署到云服务器（国内网 + 裸 IP）

适用于**服务器拉不动作**的场景（国内机器打不通 Docker Hub / GitHub）。方案：
本地构建 → 三个 tar 包搬运 → 服务器只 `docker load`。**服务器全程不碰任何 registry**。

```bash
# —— 本地：打三个包 ——
docker build -t sub-gateway:local .          # 镜像
docker save sub-gateway:local | gzip > sub-gateway-image.tar.gz
git archive HEAD | gzip > sub-src.tar.gz      # 源码：无 .git、无 .env（.gitignore 挡着）
tar czf web-dist.tar.gz -C web dist           # 前端产物：宿主机 pnpm web:build 产出

# —— 传输 + 校验（镜像约 235MB，国内跨机实测 30s）——
scp sub-*.tar.gz web-dist.tar.gz root@<host>:/root/
ssh root@<host> 'cd /root && sha256sum *.tar.gz'   # 与本地逐条比对，不等就是传坏了

# —— 服务器：落盘 ——
docker load < /root/sub-gateway-image.tar.gz
mkdir -p /opt/sub/web
tar xzf /root/sub-src.tar.gz -C /opt/sub
tar xzf /root/web-dist.tar.gz -C /opt/sub/web   # 产出 /opt/sub/web/dist
```

然后按第 2 节配 `.env`（全新库 = 全新 `MASTER_KEY`，见下），按第 3 节启动。

**全新部署的三个必改项**：

1. `MASTER_KEY` 现生成、**立刻存进密码管理器**：换 key = 库内全部密文作废，
   账号池凭据全在里面。生成用容器里的 node，不用在服务器上另装：
   `docker run --rm sub-gateway:local node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
2. `ADMIN_PASSWORD` 必填且 ≥8 字符（否则**故意启动失败**，不降级）。
3. **裸 IP 下管理面必须绑回环**：compose 缺省是 `"${PORT_ADMIN:-4101}:4001"`，
   即 `0.0.0.0` —— 那是带会话 cookie 的完整控制面，等于把后台交给全网扫描器。
   改成 `"127.0.0.1:${PORT_ADMIN:-4101}:4001"`，远程访问走 SSH 隧道：
   `ssh -N -L 4101:127.0.0.1:4101 root@<host>`，浏览器开 `http://127.0.0.1:4101`。
   裸 IP + http 时 `COOKIE_SECURE` 保持 `false`（设 true 会话 cookie 发不出去）。

第 6 节那条"管理面对整个网段开放"就是这个缺省值；对外部署前**先改这里再启动**，
别等上线后补——中间那段时间后台是敞的。

`ADMIN_WEB_DIST` 在 `.env` 里要写 `/app/web/dist`（容器内路径，不是宿主机的 `/opt/sub/web/dist`）。

## 6. 已知不粉饰

- 镜像留着构建期工具链（python3/make/g++，~120MB）：没做 multi-stage，
  因为 `COPY --from` 搬 node_modules 有搬漏原生 `.node` 的风险，自用镜像不为 120MB 付它。
- `EGRESS_HEARTBEAT_INBOX_DIR`（入口 A）缺省关，要开在 `.env` + compose 卷两处一起。
- 管理面 4101 对整个网段开放（compose `ports` 的左半边是 `4101`，不是 `127.0.0.1:4101`）。
  裸跑实例时代它也是 0.0.0.0 —— 但切到对外部署时**必须**改 `127.0.0.1:4101` + 反代 TLS。
