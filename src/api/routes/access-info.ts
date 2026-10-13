// 接入信息只读面。契约 §18（v1.12.2）/ ADR-0028。
//
// 本文件只做一件事：把**装配层已经解析好的 config** 原样摊平成 §18 的响应形状。
// **不读库、不写审计、不产生任何副作用** —— 纯配置回显，所以没有错误分支：
// 本资源永远存在（鉴权失败走 §1 既有的 401/403，在 app.ts 的 onRequest 闸门里判）。
//
// 三条必须同时成立的边界（写在这里，免得下一个人"顺手"加字段）：
//   1. **不回组 key**：网关 key 明文只在签发响应出现一次（§4 安全纪律），掩码列表走
//      §4 `GET /api/groups`。接入页的「复制 key」指向用户组发 key 流程，本端点保持无状态，
//      不得变成第二个 key 读面。
//   2. **不回完整 URL**：服务端只知道端口与绑定地址，不知道公网 host —— `0.0.0.0` 是监听
//      语义、`127.0.0.1` 只是回环，都不是对外可访问地址。拼 URL 的责任在前端：
//      `(publicHost ?? window.location.hostname)` + 端口。ADR-0028 决策 2。
//   3. **`scheme` 恒 `"http"`**：TLS 终结在反代，服务端不感知（与 §17 同口径）。

import type { FastifyInstance } from 'fastify';
import type { AccessInfoDto } from '../dto.js';
import type { ApiContext } from '../app.js';

export function registerAccessInfoRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { config } = ctx;
  // 取 `config` 而不是 `db`：本模块**刻意不碰库** —— 一旦 import 了 `db`，下一个人就会
  // 顺手在这里查一下出口池状态，于是 §18 从"纯配置回显"变成"又一条半成品读面"。
  app.get('/api/access-info', (): AccessInfoDto => {
    return {
      gateway: {
        scheme: 'http',
        portGateway: config.portGateway,
        hostGateway: config.hostGateway,
      },
      admin: {
        scheme: 'http',
        portAdmin: config.portAdmin,
        hostAdmin: config.hostAdmin,
      },
      publicHost: config.publicHost,
      // 口径 = 「**配置了**托管吗」（§17 root 口径：`ADMIN_WEB_DIST` 非空即 true），
      // 不是「此刻真的在托管」—— 目录缺失时运行期退化 404，那一条属启动日志，不在这里二次判定。
      adminWebDistEnabled: config.adminWebDist !== null,
    };
  });
}
