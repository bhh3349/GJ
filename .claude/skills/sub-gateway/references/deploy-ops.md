# 部署运维（容器 / 云服务器）

> 权威全文在 **`deploy/docker-deploy.md`**（构建、compose 三坑、迁移、更新、全新部署、已知不粉饰）。
> 本文件只做两件事：指路 + 记录"读代码看不出来"的现场事实。**别在这里重抄手册。**

## 什么时候读哪节

| 要干的事 | 读 `deploy/docker-deploy.md` 哪节 |
|---|---|
| 首次构建 / 镜像为什么这么写 | §0 前置 + 根 `Dockerfile` 头注释（四条决定，含 multi-stage 代价） |
| compose 字段为什么这么定 | 根 `docker-compose.yml` 注释（逐条写了失败形状） |
| 旧库迁进容器 | §3b（**三个坑**：卷名前缀 / `PORT_*` 注入 / `daemon.json` DNS） |
| 改后端后换容器 | §5（镜像先验再换、重建前快照、打日期标签） |
| **国内网 + 裸 IP 全新部署** | §5b（三包搬运：`docker save` / `git archive` / `web dist`） |
| **部署后可达性自检（域名拼错 vs 被墙分界）** | §5c（容器内 G1 / `getent` / 直连 fetch / 出口回显） |
| 备份 / cron | §4 + 装箱脚本 `deploy/backup.sh` + `deploy/snapshot.cjs` |
| 生产 `.env` 填什么 | `deploy/env.production.example`（只含必改项；键位全集在根 `.env.example`） |

## 现场事实（本地推断不出来的）

- **镜像标签不代表内容新**。验法：`docker run --rm --entrypoint node sub-gateway:local -e "..."`，
  在容器里查 `dist/` 是否真有那行新代码。换容器前必做。**部署机上现成的同名镜像尤其危险**：
  2026-11-03 验证机那份 `sub-gateway:local` 构建于 `NPM_BINARY_MIRROR` 落地之前，直接 `up`
  跑的是旧代码 —— 真部署第一步是用当时 main 重建（`docker build --build-arg NPM_BINARY_MIRROR=…`，
  见 `docker-deploy.md` §0 末条）。
- **compose 卷名带项目名前缀**：本目录项目名 `sub` → 实际卷 `sub_sub-gateway-data`。
  `docker volume create sub-gateway-data` 建的是**另一个空卷**，症状是容器启动日志出现
  「已创建管理组」。核对：`docker inspect <容器> --format '{{range .Mounts}}{{.Name}}{{"\n"}}{{end}}'`。
- **健康探针是 WS 101 握手**（`/api/stats/live`），不是 HTTP 200：`/api/*` 除 `auth/login`
  全量鉴权，HTTP 探针恒 401 → 好容器被反复重启。镜像里没 curl，探针用 Node 内置 `net` 裸 socket。
- **镜像 multi-stage（2026-11-03）**：运行期 = slim + `pnpm install --prod` + dist，无编译器、
  无 devDeps。实测（阿里云 Ubuntu24.04/Docker29）：`docker images` **922MB→432MB**，
  `docker save|gzip` **209MB→94MB**；四项验证（体积/healthy/双面在听/重启数据在）已过，
  原始数据在 `docker-deploy.md` §7。
- **构建时 GitHub 是间歇可达的**（阿里云成都实测：2s 200 与 10s 超时交替）。运行期阶段没有
  编译器，prebuild 下不来就**显式失败**（`prebuild-install warn install Request timed out` +
  gyp 找不到 Python）。逃生口：`--build-arg NPM_BINARY_MIRROR=https://registry.npmmirror.com/-/binary/better-sqlite3`
  （prebuild-install 认 `npm_config_<pkg>_binary_host`，配了就不查 GitHub API；npmmirror 资产实测 200）。
- **"上游全挂"先跑 §5c 四步自检**：域名拼错（② `getent` 空）与被墙（③ connect timeout）症状
  相同、修法反向。
- **备份不能用 `cp`**：源库有未 checkpoint 的 WAL（本地实测 -wal 有 4MB），`cp` 拿到撕裂的库。
  用 `deploy/snapshot.cjs`（只读连接 + `VACUUM INTO`）。
- **`node -e` 别塞进 `sh -c` 里**：引号在 sh → docker → node 三层之间必炸
  （实测 `SyntaxError: Invalid regular expression flags`）。落成 `.cjs` 文件挂进容器跑。
- **生产部署已落地（2026-11-03）**：阿里云成都轻量应用服务器（SWAS）`47.108.194.235`，
  main `75f3e61` → 镜像 `57076991e749`（432MB），部署目录 `/root/sub-gateway`（`.env` 600），
  卷 `sub-gateway_sub-gateway-data`。暴露面 = 业主拍板 **C：4101 裸公网 + 强密码**
  （`COOKIE_SECURE=false` 必配，设 true 会话 cookie 发不出去，登录假死）；网关面 4100 公网。
- **外部可达性唯一闸是云控制台防火墙**（SWAS → 防火墙），别在服务器本机排查：
  `ufw` inactive、iptables INPUT 全 ACCEPT，但控制台只放 22/80/443 —— 4100/4101 一律
  DROP。判别法（外部探）：80/443 = **REFUSED**（放行但宿主无监听），4100/4101 与随机端口
  = **TIMEOUT**（防火墙丢包）。加规则只能在控制台点，SSH 代不了。宿主自己 curl 自己的
  公网 IP 也不通（云上 hairpin NAT 本来就不通），别拿这个当防火墙证据。
- **首个网关 key 的一次性日志在容器启动日志里**（`docker logs` grep「仅此一次」）；
  值不进任何回执/聊天/记忆，业主自行读取或丢弃后到管理面「用户组」重置。
- **手发 curl 验管理面**：写请求必须带 `X-Requested-With`（CSRF 三层校验，ops-manual §2），
  缺了回 403 `CSRF_REJECTED` —— 那是闸门在工作，别误判成鉴权坏。
- **裸 IP 部署**：compose 缺省把管理面 `4101` 开到 `0.0.0.0` —— 那是带会话 cookie 的完整
  控制面。**启动前**就改成 `127.0.0.1:${PORT_ADMIN:-4101}:4001`，远程走 SSH 隧道
  （`ssh -N -L 4101:127.0.0.1:4101 root@<host>`）。裸 IP + http 时 `COOKIE_SECURE=false`。
- `ADMIN_WEB_DIST` 在 `.env` 里写**容器内路径** `/app/web/dist`（宿主 `web/dist` 由 compose 只读挂载）。
- `.env` 的 `PORT_GATEWAY/PORT_ADMIN` 会被 `env_file` 原样注入容器，而进程读它们决定**监听端口**；
  compose 的 `environment` 段已强制覆盖回 4000/4001，宿主机端口只由 `ports` 左半边决定。
- **`MASTER_KEY` 是硬要求**：缺失/非 32 字节 → 拒启（不降级、不自动生成）。换 key = 库内全部密文作废
  （账号池凭据全在里面）——全新部署时现生成并**立刻进密码管理器**。
- 服务器上若还跑着别的面板（如 1Panel 占 2333），别用 `ufw enable` 一刀切；
  优先云安全组只放行 SSH + 网关面端口。改 `iptables` 前先 `iptables -S` 看清有没有别的链在管。
- 全新库的**首个网关 key 只在启动日志打一次**（库内只存散列），要立刻记下来或之后在管理面重置。

## 数据初始化（全新部署）

管理面登录后：建上游（tierflow `https://tierflow.cn/v1` 等）→ 导账号池 → 批量建 key。
- 密码型账号走管理面「导入」直接粘贴文本（值不落任何文件/聊天/日志）。
- 会话型账号**只能**走服务器上的离线脚本 `scripts/import-supplier-session.ts`，不经 HTTP。
