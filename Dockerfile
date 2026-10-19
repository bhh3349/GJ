# sub-gateway 生产镜像。
#
# （曾有 `# syntax=docker/dockerfile:1` 行：它会要求 BuildKit 拉取外部 frontend
# 镜像，而那条拉取**不走 daemon 的 HTTP_PROXY**，在 DNS 污染网络上直接超时。
# 本文件只用内置语法，去掉后全缓存可构建，故不保留。）
#
# 三个决定，每条都有一个具体的失败形状，不是风格偏好：
#
# 1. **base image 钉 `node:22-bookworm-slim`，不用 `latest` / `22-alpine`**
#    - 不钉大版本：`better-sqlite3` 是**原生模块**，按 Node ABI 编译。Node 24 上跑会
#      `ERR_DLOPEN_FAILED`，报错信息看起来像 better-sqlite3 自己的 bug，不像环境选错。
#      `package.json` 的 `engines: ">=22.0.0 <23.0.0"` 就是这条的声明处。
#    - 不用 alpine：musl 与 glibc 两套 libc，better-sqlite3 需要从**源码**编译
#      （prebuilds 只覆盖 glibc），构建时间与构建期工具链（python3/make/g++）都上来，
#      而收益只是镜像小 ~150MB —— 一个自用网关不为这个付编译时间与失败概率。
#
# 2. **pnpm 版本由 `packageManager` 字段钉死**（corepack 读它，不手抄版本号）
#    - 手抄一份 `pnpm@10.34.6` 到 Dockerfile 里就是第二个事实源，`package.json`
#      改了这里不跟着改，症状是"本地能装、容器里装的不是同一套"。
#
# 3. **native 模块在构建期编译进镜像，不是运行期**
#    - 运行期没有 python3/make/g++。若 `pnpm install` 时跳过了原生编译
#      （例如靠 --ignore-scripts 提速），容器会在**第一次打开数据库**时才炸 ——
#      那已经是服务"启动成功"之后，`health` 还可能是绿的。
#
# 镜像里**不含**：`web/dist` 由 `pnpm web:build` 在**调用方**那一步产出后拷入
# （见 docker-compose.yml 的注释）—— 不在这里构建前端，是因为后端镜像的消费者
# 可能只想跑 API；把前端烧进来会让"只想更新前端"也触发一次后端重构建。

FROM node:22-bookworm-slim

# 构建期工具链：只为 better-sqlite3 从源码编译而生，最终镜像里**留着一份**
# —— 删掉要一个 multi-stage 的 `COPY --from` 搬运 node_modules，而那个搬运
# 会把原生模块的 `.node` 与符号表一起搬漏的风险引进来。一个自用镜像不为
# 这 ~120MB 增加一次"搬漏了但测试没发现"的概率。
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# corepack：pnpm 版本从 package.json 的 packageManager 字段取（上面第 2 条）
RUN corepack enable

WORKDIR /app

# 先只拷依赖清单：源码改动不炸依赖层缓存。
# `pnpm-lock.yaml` 必须一起拷 —— 少了它 pnpm 会按 semver 重新解析，
# 于是"同一份 Dockerfile 两次构建出的依赖树不同"。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# 再拷源码并构建。
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# 数据目录：SQLite 文件的家。声明成 VOLUME 只是为了在 `docker run` 不给 -v 时
# 给一个明确位置，**持久化请用 compose 的命名卷**（见 docker-compose.yml）。
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 缺省端口：网关面 4000（对外）+ 管理面 4001。两个都要 —— 只 EXPOSE 一个
# 不会拦住另一个，但会让 `docker run -P` 只映射一个，而那个症状
# （管理面 404）看起来像后端没起来。
EXPOSE 4000 4001

# 不设 USER node：`/app/data` 的属主是 root，切用户会让 SQLite 打不开
# （症状是启动时报 "unable to open database file"，看着像权限配置问题）。
# 真要降权，先把数据目录 chown 给那个用户 —— 那是部署侧的选择，不在这里替它做。

# 不用 `npm start`：那会走一次包管理器解析。直接 node，缺什么报什么。
CMD ["node", "dist/server.js"]
