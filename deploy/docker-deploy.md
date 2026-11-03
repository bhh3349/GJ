# sub-gateway Docker 部署（单机）

> 2026-10-19 由部署准备生成。2026-11-03 增补：镜像 multi-stage 化、生产 `.env`
> 模板（`deploy/env.production.example`）、部署后可达性自检（§5c）。
> 前置阅读：根目录 `Dockerfile` 头注释（四条构建决定，含 multi-stage 的代价）、
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
- **multi-stage 化后（2026-11-03）新增一条**：运行期阶段没有编译器，better-sqlite3
  的原生绑定只来自 prebuild（GitHub releases）。**GitHub 不可达的构建机会在
  `pnpm install --prod` 层显式失败**（症状：`pnpm install` 报 better-sqlite3
  install Failed，日志里 `prebuild-install warn install Request timed out` 后跟着
  gyp 找不到 Python）。实测（阿里云成都）：GitHub release 资产是**间歇性**可达，
  不可靠 —— 所以构建时可以走镜像站逃生口：

  ```bash
  docker build \
    --build-arg NPM_BINARY_MIRROR=https://registry.npmmirror.com/-/binary/better-sqlite3 \
    -t sub-gateway:local .
  # 原理：prebuild-install 读 npm_config_better_sqlite3_binary_host，配了它就直接
  # 从镜像站拼 {mirror}/v{version}/better-sqlite3-v{version}-node-v{abi}-linux-x64.tar.gz，
  # 不查 GitHub API。缺省空串 = 官方 GitHub。npmmirror 资产 2026-11-03 实测 200。
  ```

  这不是回退到旧单阶段的理由 —— 旧单阶段在这种网络上是**源码编译兜底**（要
  python3/make/g++，慢且把工具链烧进最终镜像）。

- **部署机上现成的 `sub-gateway:local` 可能是旧代码，真部署前先重建**（2026-11-03
  验证机踩点：机上那份 `local` 构建于 `NPM_BINARY_MIRROR` 落地之前，不含该 ARG，
  直接 `up` 跑的是旧代码）。标签同名 ≠ 内容新 —— 真部署第一步是用**当时 main 的
  代码**重建一次再起栈：

  ```bash
  docker build \
    --build-arg NPM_BINARY_MIRROR=https://registry.npmmirror.com/-/binary/better-sqlite3 \
    -t sub-gateway:local .
  ```

  复验/换机同理（§7 的 `docker images` 对比必须在**重建后**的镜像上做）。

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
# 生产部署用新模板（只含必改项，键位说明不重抄）：
cp deploy/env.production.example .env
# 全键位模板（本地开发 / 要查某个键的完整语义）：
cp .env.example .env             # 然后按需改，或用部署准备时已生成的那份
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

# —— 传输 + 校验（multi-stage 后 `docker save | gzip` ≈ 94MB，旧单阶段同机 209MB；
#    2026-11-03 实测值，见 §6/§7）——
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

## 5c. 部署后 5 分钟可达性自检（手检清单）

**为什么单列这一节**：启动 `(healthy)` 只证明"进程活着 + 管理面在服务"（§3 的 WS 101 探针），
**不证明它能出去**。而"上游域名拼错"与"出口被墙"在网关观测面上是**同一个症状**
（`last failure NETWORK`、上游"全挂"）—— 所以下面四步各自只回答一个问题，一条不过就停。

```bash
# ① 容器内 G1 等价判据：原生绑定真能加载（multi-stage 后运行期阶段不带编译器，
#    better-sqlite3 的绑定只来自 prebuild —— 这一步就是在验证"prebuild 与容器 Node ABI 匹配"）
docker exec <容器> node -e 'const D=require("better-sqlite3");const db=new D(":memory:");db.exec("create table t(v)");db.prepare("insert into t values(?)").run("ok");console.log("G1(容器内)",db.prepare("select v from t").get().v);'
# 判据：打印 G1(容器内) ok。抛 "Could not locate the bindings file" = 该层 prebuild 没落盘。

# ② 容器内解析上游域名（DNS 通不通；坑 3 的现场复核）
docker exec <容器> getent hosts tierflow.cn
# 判据：有输出（IP 行）= 解析通。空输出 = 容器 DNS 瞎了 → 查 compose 的 dns 段。

# ③ 容器内直连上游（链路通不通 / 是不是被墙）
docker exec <容器> node -e 'fetch("https://tierflow.cn/v1/models").then(r=>console.log("HTTP",r.status)).catch(e=>console.log("FAIL",(e.cause&&e.cause.code)||e.message))'
# 判据：HTTP 200/401 = 通（401 只是没带 key，链路是通的）。
#       FAIL ENOTFOUND = 回到 ②（域名拼错或解析坏）；
#       FAIL UND_ERR_CONNECT_TIMEOUT / ECONNRESET = 出口被墙或安全组没放行 —— 这才是"被墙"专属症状。

# ④ 配了出口池的话，逐出口回显（证明流量真从那个 VPS 出去）
curl -x http://<用户>:<口令>@<VPS_IP>:8080 -s https://api.ipify.org; echo
# 判据：返回 VPS 的 IP = 通；返回项目服务器自己的 IP = 没走代理。
# 与 deploy/vps-egress/README.md §2 的 30 秒自检是同一条命令。
```

**分界口径（省一次误判）**：② 空输出/`ENOTFOUND` = **名字问题**（拼错、DNS 瞎）；
③ `timeout`/`reset` 但 ② 有输出 = **通路问题**（被墙、安全组、出口挂了）。
两件事的修法反向，别混着查。

## 6. 已知不粉饰

- ~~镜像留着构建期工具链（python3/make/g++，~120MB）~~ **2026-11-03 已 multi-stage 化
  并实测**：阿里云成都 Ubuntu 24.04 / Docker 29.1.3，同机同基座两镜像对比 ——
  `docker images` **922MB → 432MB**（运行期在基座之上的部分 593MB → 103MB，工具链与
  devDeps 全部消失：容器内 `gcc/make/python3/g++` 全部 ABSENT，`/app/node_modules`
  只剩 `@fastify better-sqlite3 fastify undici`）；`docker save | gzip` **209MB → 94MB**
  （三包搬运的实际传输量）。当年否掉 `COPY --from` 的理由（搬漏原生 `.node`）不再
  适用 —— 运行期自己按同一份 lockfile 装，不搬 node_modules。**换来的新代价**：运行期
  原生绑定只来自 better-sqlite3 prebuild（GitHub releases），GitHub 不可达时构建显式
  失败 —— 用 `--build-arg NPM_BINARY_MIRROR=…` 走镜像站（见 §0 末条）。四项容器验证
  结果见 **§7**。
- 生产 `.env` 模板已有：`deploy/env.production.example`（只含必改项；键位全集仍以
  根目录 `.env.example` 为唯一事实源，模板不重抄）。
- `EGRESS_HEARTBEAT_INBOX_DIR`（入口 A）缺省关，要开在 `.env` + compose 卷两处一起。
- 管理面 4101 对整个网段开放（compose `ports` 的左半边是 `4101`，不是 `127.0.0.1:4101`）。
  裸跑实例时代它也是 0.0.0.0 —— 但切到对外部署时**必须**改 `127.0.0.1:4101` + 反代 TLS。

## 7. 镜像与宿主四项验证（2026-11-03 已实测，留作换机复验清单）

**实测环境**：阿里云成都，Ubuntu 24.04.2 / Docker 29.1.3 / compose 2.40.3。方法：仓库
compose **原文件** `--no-build` 起实例（镜像预打 `sub-gateway:local` 标签，与生产同流程），
全新命名卷 + 首启引导库，`.env` 临时生成用后即删。**镜像必须是当时 main 现建的**：机上
残留的同名旧镜像不算数（见 §0 末条）—— 2026-11-03 那份验证镜像已从机上删除，只剩
`node:22-bookworm-slim` 基座，下次部署重新 `build`。

**生产部署实录（2026-11-03，同机）**：main `75f3e61` → `git archive` 上下文 + 宿主
`pnpm web:build` → `docker build --build-arg NPM_BINARY_MIRROR=…` → 镜像 `57076991e749`
（432MB）→ `docker compose up -d --no-build` **20s `(healthy)`**；§7 四项 + 管理面
登录→会话→鉴权端点→登出**全回路实测过**（curl 写请求必须带 `X-Requested-With`，
缺了 403 `CSRF_REJECTED`，见 references/ops-manual §2）。暴露面 = 业主拍板 **C**（4101
裸公网 + 强密码，`COOKIE_SECURE=false`）。**外部可达性卡在云控制台防火墙**：只放
22/80/443，4100/4101 是 DROP —— 加规则只能在 SWAS 控制台点（判别法与证据见
references/deploy-ops.md 现场事实），服务器本机 ufw/iptables 都没拦，别在那排查。

**迭代重建实录（2026-11-03，同机同卷）**：首部署之后又滚了三次 —— `558f0e3`→镜像
`5b76b0f60462`、`9b90fa4`→`8da8ac5079bf`、`18bbe14`→`2a50acd7299e`（均 432MB；
`up -d --no-build` 后 20–22s `(healthy)`，`docker restart` 6–10s 回 healthy；命名卷与
`.env` 全程不动，逐次核对业务表行数全等 —— 业主这轮的原话重点就是「保留之前的数据」）。
固定动作两条：

- **重建前先备份**：只读连接 `VACUUM INTO '/app/data/backup-<UTC时间戳>.db'`（落在卷里），
  再 `docker cp` 一份到 `/root/backups/` 并 `sha256sum` 记进回执。数据在命名卷理论上不会丢，
  但快照在手才敢 `up`；直接 `cp` 库文件会拿到撕裂库（见 §4）。
- **回滚锚点用 tag**：覆 `sub-gateway:local` 之前先 `docker tag <旧镜像 id> sub-gateway:prev`，
  回滚就是 `up -d --no-build` 前把 `image` 指回 `prev`。别指望旧镜像不悬空。

**开工令里的「无 DDL / 无新环境变量」必须自己复核**，判据是这一条 diff 为空：

```bash
git diff <在役 tip>..<新 tip> -- src/db/schema.ts docker-compose.yml .env.example \
  env.production.example package.json pnpm-lock.yaml
```

实测反例（2026-11-03，`18bbe14` 批）：开工令写的「无 DDL」，但 `schema.ts` 里带着
`ALTER TABLE upstream_keys ADD COLUMN first_used_at TEXT` + 一次性回填（ADR-0048；
`hasColumn()` 守卫 ⇒ 只补缺失列、不动既有列，`SCHEMA_VERSION` 不递增）。加列本身无害，
但**回执要按「有迁移」报**，并在重启后再核对一次回填没有二次执行
（`select count(*) from upstream_keys where first_used_at is not null` 前后同值）。

| # | 项 | 实测结果 |
|---|---|---|
| ① | 体积对比（同机同基座） | `docker images`：单阶段 **922MB → multi-stage 432MB**（基座 329MB；基座之上的部分 593MB → 103MB）。`docker save \| gzip`：**209MB → 94MB**（三包实际传输量）。旧文档的"235MB"是另一台机器的口径，**别跨机比绝对值** |
| ② | healthy | `docker compose ps` → **Up 10 seconds (healthy)**（WS 101 探针真工作；40s start_period 没用满） |
| ③ | 双面在听 | 宿主：4100 `/v1/models` → **401**（活着）、4101 `/` → **200**（返回真 HTML）；容器内：4000 → 401、4001 → 200 |
| ④ | 重启数据在 | 卷名 `sg-test_sub-gateway-data`（**带项目名前缀**，坑 1 复证）；restart 前后 `integrity_check=ok` 且 `admin_users=1 / groups=1 / gateway_keys=1 / change_log=2` 全等；`gateway_health_snapshots` 2→3 = 新进程启动正常写库、旧行全在 |

加分佐证：**容器内 G1**（prebuild 与容器 ABI 匹配）`G1(容器内) ok`；运行期镜像
`gcc/make/python3/g++` 全 ABSENT，`/app/node_modules` 只剩 `@fastify better-sqlite3
fastify undici` 四个运行时依赖。

换机/换版本时把下面四条重跑一遍（④ 的表清单按当时 schema 用参数化计数，**别写死业务表名**
—— 本机实测 `call_logs` 在 v1.19+ 已不是表名，写死必踩 `no such table`）：

```bash
# ① 体积对比（同机才有意义）
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | grep sub-gateway

# ② healthy（WS 101 探针，不是 HTTP 200 —— 别改判据，见 §3）
docker compose ps --format '{{.Name}}\t{{.Status}}'
# 判据：STATUS 出现 (healthy)。(unhealthy) 先看 logs；若是探针探到错端口，回 §3b 坑 2。

# ③ 双面在听（宿主缺省 4100/4101）
curl -sI http://127.0.0.1:4100/v1/models | head -1
curl -sI http://127.0.0.1:4101/ | head -1
# 判据：网关面 401/404 都算"活着"；管理面 200。

# ④ 重启后数据在（先记 → restart → 再记 → 两次全等）
docker inspect <容器> --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{"\n"}}{{end}}'
docker exec <容器> node -e 'const D=require("better-sqlite3");const db=new D("/app/data/gateway.db",{readonly:true});const t=db.prepare(`select name from sqlite_master where type=@k`).all({k:"table"});const c={integrity:db.prepare("pragma integrity_check").get().integrity_check};for(const {name:n} of t){try{c[n]=db.prepare(`select count(*) c from "${n}"`).get().c}catch(e){}}console.log(JSON.stringify(c));db.close()'
docker compose restart gateway && sleep 10 && docker compose ps --format '{{.Status}}'
docker exec <容器> node -e '<同上一条>'
# 判据：卷名是 <项目名>_sub-gateway-data（**不是**裸名 sub-gateway-data，见 §3b 坑 1）；
#       两次 JSON 全等（health_snapshots/usage_logs 这类"运行时自增"表允许变大，其余必须相等）。
```

部署后**可达性**（能不能出去）另见 §5c —— 两节别混：§7 验镜像与宿主，§5c 验网络与出口。

