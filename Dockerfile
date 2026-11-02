# sub-gateway 生产镜像（multi-stage）。
#
# （曾有 `# syntax=docker/dockerfile:1` 行：它会要求 BuildKit 拉取外部 frontend
# 镜像，而那条拉取**不走 daemon 的 HTTP_PROXY**，在 DNS 污染网络上直接超时。
# 本文件只用内置语法，去掉后全缓存可构建，故不保留。）
#
# 四个决定，每条都有一个具体的失败形状，不是风格偏好：
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
# 3. **两个阶段，工具链只活在 build 阶段（2026-11-03 multi-stage 化）**
#    - build 阶段装 python3/make/g++：better-sqlite3 没有现成 prebuild 时从这里
#      源码编译兜底；dist/ 也在这里产出。
#    - 运行期阶段**不装工具链**，靠 better-sqlite3 的 prebuild（锁定的
#      v11.10.0 有 node-v127-linux-x64，即 Node 22 / glibc 的预编译产物）。
#      代价：**GitHub 不可达的构建机会在这一层显式失败**（prebuild 下载不走
#      任何回退 —— 没有编译器，装不出来就是装不出来）。旧单阶段在那种网络上
#      会静默退回源码编译；multi-stage 后这类机器直接走 §5b 三包搬运，构建
#      放在能联网的机器上。**2026-11-03 实测**：阿里云成都机器到 GitHub
#      release 资产是**间歇性**可达（同一台机 2 秒 200 / 10 秒超时交替出现），
#      所以留了 `NPM_BINARY_MIRROR` 逃生口（见下面各阶段的 RUN 前缀）：
#        docker build --build-arg NPM_BINARY_MIRROR=https://registry.npmmirror.com/-/binary/better-sqlite3 .
#      原理：prebuild-install 读 `npm_config_<包名>_binary_host`（util.getHostMirrorUrl），
#      配了它就直接拼 `{mirror}/v{version}/{name}-v{version}-node-v{abi}-{platform}-{arch}.tar.gz`，
#      **不再查 GitHub API**。缺省空串 = 走官方 GitHub，行为与未加该参数时一致。
#    - 为什么运行期阶段自己 `pnpm install --prod` 而不是 `COPY --from=build
#      /app/node_modules`：后者曾因"搬漏原生 `.node`/符号表"被否（构建不报错、
#      运行才炸是最隐蔽的失败形状）。现在依赖树由**同一份 lockfile** 决定，
#      两个阶段各装各的，树内容一致由 lockfile 保证，不靠搬运完整性。
#    - `pnpm-workspace.yaml` 必须随清单一起拷：pnpm 10 默认拦截依赖构建脚本，
#      better-sqlite3 的 prebuild-install 在 `onlyBuiltDependencies` 白名单里 ——
#      少了它，运行期阶段装出来的 better-sqlite3 **没有原生绑定**，且只在
#      第一次打开数据库时才炸（进程"启动成功"、health 还可能是绿的）。
#
# 4. **镜像里不含**：`web/dist` 由 `pnpm web:build` 在**调用方**那一步产出后
#    bind 进容器（见 docker-compose.yml 的注释）—— 不在这里构建前端，是因为
#    后端镜像的消费者可能只想跑 API；把前端烧进来会让"只想更新前端"也触发
#    一次后端重构建。`devDependencies` 同理不进运行期（tsc/tsx/vitest 只属于
#    build 阶段；运行期缺它们不是缺陷，`pnpm install --prod` 保证这一点）。

# ---------- build 阶段：工具链 + 全量依赖 + tsc 产物 ----------

FROM node:22-bookworm-slim AS build

# 构建期工具链：只为 better-sqlite3 从源码编译兜底（有 prebuild 时用不上，
# 没有 prebuild 的 ABI/平台靠它），以及 devDependencies 的正常安装。
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
# NPM_BINARY_MIRROR：空串 = 官方 GitHub（缺省行为不变）；只在下面这个 RUN 内生效，
# 不写进镜像 env —— 它是构建期开关，不是运行时配置。
ARG NPM_BINARY_MIRROR=
RUN npm_config_better_sqlite3_binary_host="${NPM_BINARY_MIRROR}" pnpm install --frozen-lockfile

# 再拷源码并构建。
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---------- 运行期阶段：slim 基座 + 生产依赖 + dist，不带工具链 ----------

FROM node:22-bookworm-slim

# 与 build 阶段同一份 lockfile 装**生产依赖**：devDeps（typescript/tsx/vitest/
# esbuild 等）与构建工具链都不进这一层。better-sqlite3 的原生绑定来自
# prebuild（见头注释第 3 条的代价说明）。
RUN corepack enable

WORKDIR /app

# 三份清单一起拷：package.json（"type": "module" 决定 dist 是 ESM，缺它
# `node dist/server.js` 直接 SyntaxError）+ lockfile（树与 build 阶段同源）+
# pnpm-workspace.yaml（onlyBuiltDependencies 白名单，见第 3 条）。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 与 build 阶段同一个逃生口（见头注释第 3 条）：GitHub 间歇不可达时不加
# --build-arg 会在这一层显式失败 —— 没有编译器兜底，这是设计而不是意外。
ARG NPM_BINARY_MIRROR=
RUN npm_config_better_sqlite3_binary_host="${NPM_BINARY_MIRROR}" pnpm install --frozen-lockfile --prod

# 只搬 tsc 产物。不搬 node_modules、不搬 src/：运行期不读它们。
COPY --from=build /app/dist ./dist

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
