# ADR-0028：接入信息只读面 `GET /api/access-info`

- 状态：已接受（2026-10-14）
- 关联：契约 v1.12.2 §18；交付链探查缺口 2（「给别人接入网关，没有一页把地址 + 发 key 入口摆在一起」）
- 车道：管家（`src/api/`）；画师消费（接入信息页，等本契约条目开工，不预写调用方代码）

## 背景

PM 派单缺口 B：需要一页「接入信息」，让运营者直接看到网关对外地址与发给客户端的
组 key 入口。全仓没有任何端点承载网关对外地址；服务端只知道端口与绑定地址
（`PORT_GATEWAY`/`PORT_ADMIN`、`HOST_GATEWAY`/`HOST_ADMIN`），不知道公网 host。

## 决策

1. **只读、无副作用端点 `GET /api/access-info`**：回端口 / 绑定地址 / `publicHost` /
   `adminWebDistEnabled`，全部从 config 现读。不落库、零 DDL、零迁移、零审计。
2. **不设 `gatewayUrl` / `adminUrl` 完整 URL 字段**：服务端猜 host 必然猜错
   （`0.0.0.0` 是监听语义，`127.0.0.1` 只是回环）。URL 拼接责任在前端：
   `publicHost || window.location.hostname` + 端口。
3. **host 覆盖值走新可选 env `PUBLIC_HOST`（默认空 = `null`），不落库**：host 是部署环境
   属性，归 `.env` 口径，免 DB 与审计面；设置后即为接入页权威基址。
4. **组 key 不进本响应**：明文只在签发响应出现一次（§4 安全纪律），掩码走既有
   `GET /api/groups`。接入页「复制 key」指向用户组发 key 流程；本端点保持无状态只读，
   不做第二个 key 读面。

## 后果

- 画师拿到契约即可写页面；实现带用例过四闸后合流，PM 活体验证「接入页能直接复制 base url + key」。
- 后续若需更多自报字段（如出口池状态摘要）按「只加字段」演进，不改既有形状。
