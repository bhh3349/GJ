# ADR-0042：错误事件的 key 标识三腿 —— 「裸 `****`」的观测缺口

- 状态：**已接受（2026-10-20，业主裁定 B「全带」——含对假信号风险后的确认）**
- 关联：契约 §12.1（字段表四行新增 + `keyId` 语义修订）、§12.3（`keyId` 筛选语义一句话）、
  §10（零变更）；ADR-0013（事件面原始决策）、ADR-0011 / ADR-0021（冷却与归因纪律）、
  ADR-0014（关联键）、ADR-0010（key_runtime 镜像）
- 车道：`src/gateway/`（引擎 + 路由）、`src/wiring/`（sink + auth）、`src/db/`（纯加列 + 仓储）、
  `src/api/dto.ts`（DTO）、`web/`（观测面板）；`docs/api-contract.md` v1.17.2
- 触发：业主查 Docker 实例错误日志发现——错误事件里有的带 `****dfgs` 形掩码、有的只有光秃秃
  的 `****`，后者无法定位是哪把 key 的问题。

## 背景：实测数据（2026-10-20 快照，201 条事件）

把「裸 `****`」（200 条）按 message 形状分类，**三类各自的"事件产出点手里有没有 key"完全不同**：

| 类 | 条数 | 产出点手里有什么 | 现状 |
|---|---|---|---|
| 组级 429 / `GROUP_DISABLED` / `MODEL_NOT_AUTHORIZED` | 33 | **网关 key**（已过鉴权，`gateway_keys.masked_key` 可顺带） | 掩码丢了 |
| egress-429（出口级限流） | 115 | **上游 key**（`candidate.keyId` 就在循环变量里） | 掩码丢了 |
| 502/504 全灭、流中断、客户端 abort | 其余 | **上游 key**（同上；502 全灭是"最后摸过的那把"） | 掩码丢了 |
| 401（missing/invalid gateway key） | 34 | 没有组上下文；**入站废 key 的明文**（验完即弃） | 无来源、无指纹 |

唯一掩码**没丢**的一行（`****u1Wi`）是 499 CLIENT_ABORTED——它恰好走的是
`reportError` 带 `ctx.keyId` 的路径。

`****` 与 `****dfgs` 的分叉机制：`error-event-sink.ts` 的 `keyId === null → fallbackMask()`
（即光秃秃 `****`）；`keyId` 非空才走 `store.maskOf(keyId)`（`****` + 后 4 位）。**不是两种
掩码算法，是同一个算法的两条岔路**——引擎/路由的 `reportError`/`reportRejection` 大量调用点
不传 `keyId`，于是全走了 fallback。

## 为什么不是"每处都塞一个 keyId"就完事

因为三类产出点的**语义**不同，塞同一个字段会造出假信号：

1. **组级 429 / 403**：网关**自己**拒的（限流器 / 授权判定），0 次真实尝试，**没有上游 key
   参与**。给它们塞上游 `keyId` = 让值班照掩码去冷却一把无辜 key（它压根没被用过）。
   这类事件的 key 语境是**网关 key**（谁的调用被限了），不是上游 key。
2. **egress-429**：ADR-0021 决策 10(4) 刻意「不调 `reportFailure(keyId)`——谁没错，不给谁
   记过」。把 `keyId` 塞进事件**不等于**进冷却（冷却与事件是两条线），但必须成文，否则下一个
   读者会以为事件带 key = key 有过。
3. **502 全灭**：`keyId` 只能是「最后摸过的那把」——它可能没坏，是前面哪把先挂才轮换到它。
   把这行塞进现有 `?keyId=` 归因筛选的语义承诺（"筛出这把 key 的失败"）会掺假。

## 决策

**三腿分开，各有各的列**（业主裁定"全带"，落法按数据事实分腿）：

| 腿 | 列 | 填谁 | 何时 |
|---|---|---|---|
| 上游 key | `keyId` + `keyMasked`（**既有列，语义修订**） | 当时正在用的上游 key | egress-429 / 502·504 全灭 / 流中断 / 客户端 abort（既有） |
| 客户端 key | `clientKeyMasked`（新） | 网关 key 掩码 | 已过鉴权的拒绝（组级 429 / 403） |
| 来源 | `sourceIp` + `invalidKeyFingerprint`（新） | socket IP；废 key 指纹 | 全事件带 `sourceIp`；`invalidKeyFingerprint` 仅 401 且带了 Bearer |
| 尝试明细 | `attemptTrail`（新） | 各把候选怎么死的（JSON 数组串） | `attempts > 0` 的终态 |

### 语义修订的成文（防止下一个读者误读）

- `keyId`：**「当时正在用哪把」**，不再是「哪把 key 失败了」。502 全灭特例：是「最后摸过的
  那把」，不等于「它坏了」。§12.3 的 `?keyId=` 筛选含义改口为「事件直接归因到的那把 key」，
  502 行要配 `attemptTrail` 一起读。
- `clientKeyMasked` 与 `keyMasked` **不得互相顶替、不得相加**：一个是网关 key、一个是上游 key，
  两条腿。401 恒 `null`（鉴权没过 = 没有组上下文；不给匿名请求"这把 key 存不存在"的反馈）。
- egress-429 带 `keyId` **不等于进冷却**：ADR-0021 决策 4a 原样（不 `reportFailure`）。

### 指纹的安全边界

- `invalidKeyFingerprint` = 入站网关 key 的 sha256 **前 8 hex**（32 bit）。用途只有归并
  「同一把废 key 反复敲门」（同一指纹 = 同一来源的撞库尝试）。
- **不可反推**：网关 key 是 `gw-` + 24 字节 base64url（192 bit 熵），8 hex 指纹的碰撞域
  2^32 对 2^192 的真值空间——拿指纹**验证**一把猜测的 key 仍要逐把真实请求（那已经是
  行为攻击，有没有指纹都拦不住）。
- `missing bearer`（压根没带 key）**不产指纹**（无值可指纹），但 `sourceIp` 照记。
- 网关面 `trustProxy: false`（`runtime.ts` 既有决定，`/internal/snapshot` 回环判据依赖它），
  `sourceIp` 取 `request.ip`（socket 层），**永不读 XFF**——否则伪造该头就能把 401 栽给
  无辜机器。`audit_log.ip` 有存 IP 先例（§0.5）。

### attemptTrail 的形状与上限

```json
[{"keyMasked":"****ab12","reason":"AUTH_INVALID","status":401},
 {"keyMasked":"****cd34","reason":"NETWORK","status":0}]
```

### 消费侧：助手注入块同批补齐（不是"另做一件"）

§12 头注把 §12.1 的消费者写成**两个**——「排障的人」与「内嵌 AI 助手」；§6 关联键一节明写第二阶段
助手「读日志 → 定位问题」靠的正是这张表。所以**只补观测面、不补助手注入侧，等于只兑现一半**：
面板上看得见 `keyFp=` 而注入块里仍是光秃秃的 `****`，助手就答不出业主原话问的那个问题
（"都没办法查是哪个 key 的问题"）。因此 `assistant-chat.ts` 的 `renderEvent` 同批带上
`clientKey` / `keyFp` / `src` / `trail` 四项（trail 压成 `****ab12=AUTH_INVALID/401,…`）。

三条边界写在代码注释里，也登记在这里：

- **纪律 3 零放宽**：五项全部是掩码 / socket IP / 8 hex 指纹 / 逐把失败因由，**无一是凭据**。
  §13.6 第 3 条禁的是"把**行文本**塞进 `messages`"（绕开结构化白名单的自由文本查询），
  与"结构化事件行进 `[观测数据]` 块"是两件事——后者本来就是这个块的全部内容。
- **trail 解析不出原样回退**：渲染问题不得让观测数据消失（与 `web` 侧 `parseTrail` 同一处置）。
  不在渲染侧加第二道上限——项数上限 16 是 §12.1 唯一的硬口径，再加一个就又是"两个上限里
  有一个是空头承诺"。
- **`citations` 字段集合不变**：新腿只进 prompt，不进引用帧（§13.2 表一字未改）——引用帧是
  给前端"只展示不跳转"渲染的，加列是另一个决策，不顺手做。

- 只在 `attempts > 0` 的终态产出；`attempts=0`（配置侧/池空）为 `null`——那时没有"尝试"可言。
- 上限 **16** 条：定位"批量挂"的形状够了（谁 401、谁 NETWORK、各几把）；115 把候选全 trail
  只会把 message 字段变成噪声。超出保留**前** 16。这是调用方实际能看到的**硬口径**。
- 另有一道字符上限（2,048）**只作畸形输入兜底**，不是常规口径：实现时先取的 512 会让它**先于**
  项数上限触发（规范项约 60 字符 × 16 ≈ 1,000），于是"最多 16 条"成了永远兑现不了的承诺
  （实测只留 8 条，且调用方从文档推不出来）。合法项单项 ≤66 字符 × 16 ≈ 1,060 ⇒ 2,048 有
  约两倍余量，项数上限永远先响。超出字符上限时按序丢尾部项，最少保 1 项，仍超则整列 `null`
  —— **永不落撕裂的 JSON**（按**项**丢才对，`message` 的 512 字符截断在这里会切碎结构）。
- 只记掩码 + 失败因由 + 状态码，**不记明文、不记 id 以外的凭据形状**；整串落库前过
  `scrubCredentials`（`scrubMessage` 同款脱敏，但**只抹不截**）。

## 被否掉的方案

1. **复用 `keyId` 一列装三类**——组级拒绝塞上游 keyId 是假信号（理由见上）；一列装两种 key
   语义（网关/上游）会让 `?keyId=` 筛选与 §12.1 字段表互相矛盾。
2. **`sourceIp` 走 XFF**——伪造头栽赃（见上）；真要反代部署时开 `TRUST_PROXY` 的讨论
   归 `config.ts`，不在事件层偷偷做。
3. **指纹存全 64 hex**——那就是存的 `key_hash` 本身，`invalidKeyFingerprint` 与
   `gateway_keys.key_hash` 能直接等值比对 = 指纹可当"这把废 key 是否曾有效"的预言机。
   前 8 hex 保留归并能力、砍掉比对能力。
4. **不补，让值班去健康页看 `key_runtime`**——egress-429 与 502 的冷却痕迹确实都在
   `key_runtime`（实测 01:39/01:42 两把 AUTH_INVALID 都能对到具体 key），但两边没有关联键，
   要人肉对时间线；而"每把候选怎么死的"（502 循环内逐把 emit 的事实）在事件侧
   **根本没有可查询的落点**。业主裁定补在事件侧。

## 影响面

| 层 | 改动 |
|---|---|
| `docs/api-contract.md` | v1.17.2 变更条；§12.1 字段表 +4 行 + `keyId`/`keyMasked` 语义修订 + 写入纪律补一句；§12.3 `keyId` 筛选语义一句 |
| `src/db/schema.ts` | `gateway_error_events` 纯加四列（`client_key_masked` / `source_ip` / `invalid_key_fingerprint` / `attempt_trail`），`hasColumn()` 判据，`SCHEMA_VERSION` 不变 |
| `src/gateway/ports.ts` | `ErrorEventEntry` +4 字段（`clientKeyMasked` / `sourceIp` / `invalidKeyFingerprint` / `attemptTrail`）；`GroupContext` 顺带掩码的接线 |
| `src/gateway/engine.ts` | egress-429 / 502·504 全灭 / 流中断的 `reportError` 填 `keyId` + trail |
| `src/gateway/routes.ts` | 组级拒绝填 `clientKeyMasked`；401 填 `sourceIp` + 指纹 |
| `src/wiring/error-event-sink.ts` | 透传四字段 |
| `src/wiring/runtime.ts` | maskOf 之外补 `clientMaskOf`（网关 key 掩码）接线 |
| `src/db/repo/gateway-events.ts` | INSERT / toParams / toDto / EventRow 同步 |
| `src/api/dto.ts` | `GatewayErrorEventDto` +4 字段 |
| `src/api/services/assistant-chat.ts` | `renderEvent` 带三腿四字段；`attemptTrail` 压缩渲染 + 解析回退（消费侧补齐，见上） |
| `web/` | 错误面板加列 + 复制行带新字段 |

## 验证

- 单测逐腿钉：egress-429 带 keyId+掩码；502 全灭 trail 有序且最后一把 = keyId；
  组级 429 带 clientKeyMasked；401 带 sourceIp+指纹、missing bearer 只有 sourceIp；
  403 带掩码无指纹；trail 过 scrub。
- **消费侧同批**：`assistant.spec.ts` 钉"三腿进注入块"（`keyFp=` / `src=` / `trail=` 压缩串 /
  `clientKey=` 与 `key=` 并存不互相顶替）与"trail 解析不出原样回退"两条；
  `trail` 序列化的两个上限另在 `error-event-sink.spec.ts` 逐条钉（16 项硬口径 / 畸形按项丢）。
- **变异验证**（业主纪律）：删掉 egress-429 的 keyId 填数 → 用例红；删掉 401 指纹 → 用例红；
  删掉注入侧 `keyFp` 一行 → 用例红（三次均已实测红并还原）。
- 四门禁（typecheck / vitest / build / secrets）全绿；secrets 扫描确认指纹列不触红线。
- live（2026-10-20，Docker 实例 `sub-gateway-1`，镜像 `2026-10-20-v2`）：实测三类齐全——
  ①401（错 key）：`source_ip` + `invalid_key_fingerprint`（8 hex）落列，`client_key_masked`
  恒 NULL；②组级 429（临调 rpm=1 造出，**取数后已还原 rpm=1000 并删探针 key**）：
  `client_key_masked` 落列、`key_id` NULL、`attempt_trail` NULL（`attempts=0` 无 trail，
  合预期）；③存量 429 事件 87 行全部带 `client_key_masked`，`source_ip` 89 行里 **84 行是
  真实局域网 IP（192.168.1.66）**——`sourceIp` 对真实客户端流量取到的是真值，不只是探针。
- **部署侧边界（非代码缺陷，如实记录）**：从宿主机直打容器端口发起的请求，Docker bridge
  做 NAT，`request.ip` 只能是网关地址 `172.22.0.1`——宿主机源 IP 在 socket 层已经不可见。
  局域网真实客户端（不经 NAT 的路径）不受影响（上条 84 行为证）。若日后宿主机入口也要记
  真实 IP，那是 `trustProxy`/部署拓扑的决策（归 `config.ts`），事件层依旧不读 XFF。
- `attempt_trail` live 覆盖 0 行：重建后未发生 egress-429 / 502 全灭（存量错误全是组级 429
  与 401，本就 `attempts=0`）。该腿的实证在 `runtime.spec.ts`（真引擎连真实候选轮换，断言
  trail 有序且末项 = `keyId`），不在 live 事件里。
