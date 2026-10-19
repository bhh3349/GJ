# ADR-0033：出口探活端点可配 —— 一个会静默骗人的故障形状

- 状态：**已接受（2026-10-16，Bo 授权「按你的建议动手」）**
- 关联：契约 §16.7（`/api/egress/:id/test` 回显端点行 + 新增的「回显端点可配」小节）、
  §7 `egress_pool`（`HEARTBEAT_EVICT_AFTER_FAILURES` 的落点）、`docs/adr/0021` 补遗 v1.7.1（生产者接线）
- 车道：接线层为主（`src/config.ts` / `src/server.ts`），两侧各动一行实现（`src/api/routes/egress.ts` / `src/egress/heartbeat.ts`）
- 触发：交接文档 §10 第 6 条「出口探活目标：`api.ipify.org` 在部分网络被挡，**建议**换国内可达目标」
  —— 核完之后发现它不是"建议"，是**会主动骗人**。

## 背景：一个恒假的健康信号

`api.ipify.org` 从网关所在网络不可达时（被墙 / DNS 污染 / 上游代理策略），
受影响的**不是**"探测功能不可用"，而是探测**给出错误的答案**：

| 消费者 | 不可达时的表现 | 后果 |
|---|---|---|
| `POST /api/egress/:id/test`（面板「测试」按钮） | 回 `ok:false`，且 `updateEgressProxy(db, id, { lastTestOk: false })` 把那个 false **写进库** | 面板上唯一那个"我的出口通不通"的信号**恒假**。照着它删代理的人，删掉的是能用的机器 |
| 心跳生产者入口 B（`probe: true`） | 每拍一条失败证据 → `applyEvidence` 累加 → 第 3 拍 `status='offline'` | 一台好节点被**静默摘除**：无报错、无日志级别变化，只是可用出口少一个 |

第二条现在**不会咬**（`src/server.ts` 的接线没传 `probe`，入口 B 默认关），
但它不是"暂时安全"，是**埋着的**：哪天有人按 ADR-0020 决策 8 的成本口径开入口 B，
故障立刻从"面板说谎"升级成"池子偷偷缩小"。

注意这里没有一处是**报错**。两边的日志都写着"探测正常执行"，
用户看到的是一个合理的、自洽的、**错的**答案。这正是本 ADR 值得单独立一条的理由：
它修的不是功能缺失，是一个**无法从症状反推到病因**的失败形状。

（部署侧 `deploy/vps-egress/pool-probe.sh` 早有 `EGRESS_ECHO_URL` 旋钮，
所以后端是唯一没跟上的一边 —— 这也是"补上就够"而非"引入新旋钮"的旁证。）

## 决策

### 1. 端点可配，缺省值**不动**

新增 `EGRESS_ECHO_URL`（空 / 未设 = `null` = 用缺省值），
取值只做 trim，**不做 URL 语法校验**。

**为什么不顺手把缺省换成国内可达的目标**：换缺省会**静默改变所有现存部署**的探测语义 ——
包括那些"我测过、面板显示通"的历史记录，以及 VPS 侧 `pool-probe.sh` 里另一份
`EGRESS_ECHO_URL` 的缺省。一件会改变既有部署行为的决定，该由部署者**显式**做。
加旋钮是给"被墙的人"一条出路，不是替所有人换靶子。

**为什么不校验 URL**：一个连不上的端点就是一次失败的探测，**那正是探测的职责**。
而"拒绝启动"会让填错别名的用户在启动阶段看到一句与网络无关的报错 ——
把一个运行时事实（网络可达性）提前到启动期，只会让错误信息指向错的地方。

### 2. 缺省字面量只有一份，落在 `src/egress/port.ts`

```ts
export const EGRESS_ECHO_URL_DEFAULT = 'https://api.ipify.org';
```

两个消费者都从这里取：`src/api/routes/egress.ts` 的 `/test` 与
`src/egress/heartbeat.ts` 的入口 B。

**为什么"写两遍"在这里是严重问题**（不是洁癖）：两处各写一遍 `'https://api.ipify.org'`，
失败形状不是"以后要改两个地方"，而是**两个消费者可以配不同的值而毫无症状** ——
面板说这台出口通（它打的是新端点）、心跳说这台出口死了（它还打旧的），
**两边日志都写着"探测正常"**。用户看到的是"同一条数据两个互相矛盾的真相"，
而按现有信息没有任何办法判断该信哪个。

这与 ADR-0021「同一个对象 / 同一张预算表」是同一条纪律：
**共享的东西必须只有一份**。数字型先例是 `EGRESS_BUDGET_PLACEHOLDER`
（接线层引用那一份常量，不在这里抄数字）。

**为什么放 `port.ts` 而不是 `src/config.ts`**：这个字面量要同时被 `src/api/` 与
`src/egress/` 读，而配置模块属于装配层。端口模块零 import，两侧都 import 它不引入新边。

### 3. 接线：两个消费者同源

- `src/config.ts`：`egressEchoUrl: string | null`，空串纪律与 `egressHeartbeatInboxDir` /
  `ADMIN_TOKEN` / `ASSISTANT_MODEL` 逐字相同（`KEY=` 是部署脚本里最常见的"这行先留着"写法）。
- `src/server.ts`：`startHeartbeatProducer({ ..., echoUrl: config.egressEchoUrl ?? undefined })`。
  传 `undefined` 而不是传缺省字符串，**默认值的解释仍只有一处**。
- `src/api/routes/egress.ts`：`config.egressEchoUrl ?? EGRESS_ECHO_URL_DEFAULT`。
  `ApiContext` 里本来就有 `config`，**零签名变更**。

## 影响面

| 面 | 变更 |
|---|---|
| `/api/*` 响应 | **零字节变更**。同一个端点、同一个字段，只是它去打的那条 URL 变成可配 |
| `/v1/*` | **零变更**、`src/gateway/` **零改动** |
| DDL | **零**。`SCHEMA_VERSION` 仍为 2、零迁移 |
| `ERROR_CODES` / `GATEWAY_ERROR_CODES` / `hintCode` | **零新增**。没有任何新的失败形态 —— 探测失败早就回 `ok:false` |
| 审计动作 | **零新增**。探活是诊断不是管理动作（这条自 v1.7.1 起没变） |
| 上游请求 | **零增加**。只是同一次请求换了个 URL |
| 新配置 | 1 个可选旋钮 `EGRESS_ECHO_URL`（有缺省，缺省行为 = 本 ADR 前的逐字节原状） |
| 新导出 | 1 个常量 `EGRESS_ECHO_URL_DEFAULT`（`src/egress/port.ts`） |

## 判据

`src/egress/heartbeat.spec.ts` + `src/api/routes/egress.spec.ts` + `src/config.spec.ts`，五条：

| 用例 | 钉住什么 |
|---|---|
| `config`：`EGRESS_ECHO_URL` 空串 / 空白 → `null`，其余 trim 后原样透出 | 空串纪律（`KEY=` 不是"一个叫空串的端点"） |
| 心跳：缺省时入口 B 打 `EGRESS_ECHO_URL_DEFAULT` | 缺省值没被顺手改掉 |
| 心跳：配了 `echoUrl` 打配置值，缺省端点一次都不碰 | 旋钮真的接上了（不是接了个寂寞） |
| `/test`：上面两条的同形版本，断言**打进假件的 URL** | 两个消费者行为一致 |
| 心跳：**缺省字面量只存在于 `port.ts` 一处** | 拦住"复制第二份字面量"这个漂移起点（本条就是决策 2 的守卫） |

**全部经变异验证**（改坏 → 红 → 还原）：

| 变异 | 结果 |
|---|---|
| 路由改成永远用缺省（`config.egressEchoUrl ??` 删掉） | **红** ← 「配了就走配的」 |
| 心跳缺省换成另一个字面量（`ifconfig.me`） | **红** ← 「缺省走缺省」 |
| 心跳把 `api.ipify.org` 字面量复制回来 | **红** ← 字面量唯一性守卫 |

第一条变异值得单独说：它证明的不是"配置能读进来"（那是 `config.spec` 的事），
而是**旋钮接上了**。一个 `config` 有字段、`server.ts` 也传了、但消费者那一行忘了改的实现，
在前两条用例下是绿的 —— 因为缺省值正好等于旧行为。这种"接了个寂寞"的失败形状，
只有断言"打进去的到底是哪个 URL"才拦得住。

## 遗留（不粉饰）

1. **入口 B 仍然默认关**，所以本 ADR 的第 2 条后果（静默摘除）目前不会触发。
   本 ADR 做的是让"开之前那条隐患不存在"，**不是**把入口 B 打开。开它要另有一笔决策
   （ADR-0020 决策 8 的成本口径：吃 management 预算）。
2. **`/test` 的那个假失败仍然会写库**。旋钮让它可修（换个可达端点），
   但没改"探测失败即落库"这个语义 —— 那是 v1.7.1 的既有决定，
   改它要动 `last_test_ok` 的口径，超出本 ADR 范围。
3. **没有"端点可达性"的自检**。配了一个拼错的域名，症状与端点被墙完全相同
   （都是 `ok:false`），用户仍可能要自己 `curl` 一次才知道是哪一种。
   真正能区分的是把探活的失败原因分型（DNS / 超时 / HTTP 状态），本 ADR 未做。
