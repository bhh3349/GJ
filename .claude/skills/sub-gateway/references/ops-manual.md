# 运维手册（本地实例）

> 全部命令在仓库根 `/root/WorkSpace/BHH/SUB` 下执行。**Node 必须用 `/opt/node22/bin/node`**：
> 默认 `node` 是 v24，会弄坏 better-sqlite3 的原生 ABI，四条门禁全挂。

## 1. 两个测试实例

| 端口 | 形态 | 启动方式 | 库 | 备注 |
|---|---|---|---|---|
| 4000 | 裸进程，**不归 systemd** | `/opt/node22/bin/node dist/server.js`（带 env） | `data/test-lan.db` | 手工起停，改代码后要自己重启 |
| 4100 | docker | `docker-compose.yml`（容器内监听 4000，宿主映射 4100） | 容器卷内 | 重建镜像才吃到新构建 |

启动 env 在 **`/tmp/subtest/test.env`**（备份 `/root/sub-test-lan.env.bak`），变量名：
`MASTER_KEY` `ADMIN_USERNAME` `ADMIN_PASSWORD` `ADMIN_WEB_DIST` `ASSISTANT_MODEL` `DB_PATH` `HOST_ADMIN` `HOST_GATEWAY`。
**只按名字引用，值永不写进本文件/记忆/聊天/日志。**

### 停实例的唯一正确姿势

```bash
ss -ltnp | grep ':4000 '            # 取 pid
kill <pid>                          # 精确杀
```

**禁止 `pkill -f`**：模式会同时匹配到 4100 的 docker-proxy 和其它实例，一杀全灭。
4000 也**不要**用 `systemctl` 管（它不是服务单元）。

### 重启 4000

```bash
cd /root/WorkSpace/BHH/SUB && pnpm build                       # 或 npm run build
set -a; . /tmp/subtest/test.env; set +a
nohup /opt/node22/bin/node dist/server.js > /tmp/subtest/gw3.log 2>&1 &
```

- assisstant 相关要生效，env 里必须有 `ASSISTANT_MODEL`（空串按"未配置"处理，见 `src/config.ts`）。
- 改前端后若 4000 要托管新版，`ADMIN_WEB_DIST=web/dist` 且先 `pnpm --filter web build`。

## 2. 管理面请求：登录 → 带 CSRF 头

管理面 `/api/*` 除 `auth/login` 外**全量鉴权**（AGENTS.md §4）。写请求还要过 CSRF，
校验**顺序固定**（契约 §0.5，实现 `src/api/http.ts:181`）：`Origin` → `Sec-Fetch-Site` → `X-Requested-With`，
逐层叠加，任一否定即拒 `403 CSRF_REJECTED`。只读请求不校验。

因此**手发 curl 的写请求必须带 `X-Requested-With`**，最省事的写法：

```bash
set -a; . /tmp/subtest/test.env; set +a
B=http://127.0.0.1:4000
J=/tmp/myj.cookies; rm -f "$J"

# 1) 登录（唯一免鉴权端点；会话写 HttpOnly Cookie，明文 token 只出现这一次）
curl -s -c "$J" -H 'content-type: application/json' -H 'x-requested-with: XMLHttpRequest' \
  -d "{\"username\":\"$ADMIN_USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}" "$B/api/auth/login"

# 2) 读（GET 免 CSRF 头，Cookie 即可）
curl -s -b "$J" "$B/api/access-info" | head -c 400

# 3) 写（必须带 x-requested-with；否则 403 CSRF_REJECTED）
curl -s -b "$J" -X POST -H 'content-type: application/json' -H 'x-requested-with: XMLHttpRequest' \
  -d '{}' "$B/api/observability/errors?pageSize=1"
```

- 错误体是 `{code,message,details?}`（`/api/*`），**不是** OpenAI 形状。`/v1/*` 才是 `{error:{...}}`。
- 观测面可用只读令牌：`Authorization: Bearer $READONLY_TOKEN`，**仅 `GET /api/observability/*`**，
  写方法或其它路径一律 `403`（契约 §12.4）。`READONLY_TOKEN` 空 = 关闭；与 `ADMIN_TOKEN` 同值 = 启动即拒。

## 3. 查错误：别读日志文件，先查观测面

```bash
curl -s -b "$J" "$B/api/observability/errors?from=2026-10-19T00:00:00Z&pageSize=50"
curl -s -b "$J" "$B/api/observability/health"
```

- `errors` 默认窗口 **1h**，`ts DESC, id DESC`；`category` 支持逗号分隔多值（最多 9），`severity` 单值。
  `from`/`to` 是**带时区** ISO8601，跨度上限 30 天。只读、无副作用。
- 关联键 `x-request-id` 是跨表关联的唯一抓手（契约 §6，ADR-0014）：拿到一条错误事件，用它的 requestId
  反查调用记录 / 日志行。
- 日志文件只做兜底（4000 是 `/tmp/subtest/gw3.log`）。**别整文件读**：先 `grep` 出关键行再看。

## 4. 直接查库（只读）

```bash
/opt/node22/bin/node -e "
const D=require('better-sqlite3');const db=new D('data/test-lan.db',{readonly:true});
console.log(db.prepare(\"select count(*) c from call_logs where ts>='2026-10-19'\").get());
"
```

- **SQL 字面量一律单引号**。SQLite 把 `"..."` 当标识符：写成 `ts>="2026-10-19"` 会报 `no such column`。
  这个坑已踩过多次。
- 只读打开（`readonly:true`）：**单写者原则**（AGENTS.md §5），不要拿第二个连接去写。
- 临时脚本先落仓库目录再删，别在 `/tmp` 里留半成品。

## 5. 判读纪律（血泪）

- **"端点能发通"≠"功能可用"**：只有 4xx 一律按"能力不存在"处理，必须观测到 **2xx** 才算实现。
- **压测/验收要加间隔**：连发会打出上游**真 429**，污染证据链（会在 `call_logs` 里留下 `RATE_LIMITED`）。
- **别把 `completion_tokens=0` 当"被截断"**：429/499/502 的行本来就没产出 token，要按 `status` 分型看。
- 网关对 `/v1/*` 是**纯透传**（`src/gateway/engine.ts:371` 只覆盖 `model`；`finish_reason` 全局没有处理代码），
  所以"输出被限"一般不是网关干的 —— 先看 `call_logs` 的 `prompt_tokens` 是否已贴近模型上下文窗口。

## 6. 常用门禁

```bash
/opt/node22/bin/node node_modules/.bin/tsc --noEmit -p tsconfig.json   # 类型
npm run check:sqlite        # 单写者/热路径静态检查
npm run check:secrets       # key 明文扫描（CI 同款）
/opt/node22/bin/node node_modules/.bin/vitest run --silent            # 全量测试
```

GitHub 操作（push/gh/curl）前先 `export ALL_PROXY=http://127.0.0.1:7890`，直连 DNS 被污染会超时。
