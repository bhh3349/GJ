/**
 * 网关接入地址的**唯一拼装点**（契约 §18 / §19.5；`/v1` 后缀口径见 ADR-0036 决策 1）。
 *
 * 在 v1.15.7 之前，这条公式在管理面「接入信息」与消费面「接入与 key」各写了一遍
 * （`joinHostPort` 的注释里还专门论证过"复刻而不是共享"）。两处都**漏了 `/v1`**，
 * 于是两页展示的"Base URL"抄进客户端打出去的第一个响应是 404 —— 而
 * `/models` → 404 与 `/v1/models` → 401 的差别就是"前缀是路由的一部分"。
 * 两个调用方各自照契约实现，并没有让漂移在类型上暴露（那句话当时是对的推测、
 * 错的结论）：契约里根本没有写过 `/v1` 这一层，所以两边"照契约实现"照的是**同一份缺了后缀的公式**。
 * 现在后缀写在这里一处，页面不再各抄一遍。
 *
 * 三条纪律：
 * 1. **绑定地址（`hostGateway` / `hostAdmin`）绝不参与拼接**。`0.0.0.0` / `127.0.0.1`
 *    是监听语义（§18），拼出来的 URL 打不开，而用户会以为是我们给错了地址。
 * 2. **服务端不回完整 URL、本模块不发请求**。它只做纯函数式的字符串拼装，
 *    事实源仍是 `GET /api/access-info` 那三个字段（ADR-0028 决策 2）。
 * 3. **`root` 与 `baseUrl` 两个都要能说出来**：服务根服务静态页与 `/api/*`（有用），
 *    业务上的"API 地址"是带 `/v1` 的那个。把它们当同一个东西展示，就是本版要修的那个 bug。
 */
import type { AccessInfo } from '@/api/types';

/** 网关面的路径前缀（§10）。网关只认 `/v1/*`，少了它就是 404。 */
export const GATEWAY_PATH_PREFIX = '/v1';

export interface GatewayUrls {
  /** 服务根：静态页与 `/api/*` 的入口，如 `http://gw.example.com:4000`。 */
  root: string;
  /** 填进 OpenAI 兼容客户端的 Base URL = `root + '/v1'`。 */
  baseUrl: string;
}

/**
 * host + 端口拼接。三种输入都要对：
 * - `gw.example.com` → 补端口；`gw.example.com:4000` → 已完整，不动；
 * - IPv6 裸地址 `[::1]`（浏览器 `hostname` 的原样输出）→ **要**补端口；
 * - IPv6 带端口 `[::1]:4000` → 已完整，不动。
 *
 * `base` 已经带了端口时**原样返回**：用户自己配了非默认端口（或反代域名里的端口），
 * 我们再补一个默认端口就会拼出 `host:8080:4000` 这种谁也不认的东西。
 */
export function joinHostPort(base: string, port: number): string {
  if (/]:\d+$/.test(base)) return base;
  if (base.includes(':')) return base.startsWith('[') ? `${base}:${port}` : base;
  return `${base}:${port}`;
}

/**
 * 对外 host：`PUBLIC_HOST` 配置值优先；没配 = 当前浏览器地址栏的机器名。
 *
 * 没配时**必须明说**（两页都有那句"换机器就变了"）：`window.location.hostname`
 * 只在"用户与网关在同一台机器 / 同一个名字下"成立，换台机器打开就变成另一个地址。
 * 返回 `null` = 拿不到（SSR / 非浏览器环境），调用方据此展示"无法确定"而不是猜一个。
 */
export function externalHostOf(access: AccessInfo | null): string | null {
  if (access === null) return null;
  if (access.publicHost) return access.publicHost;
  if (typeof window === 'undefined') return null;
  return window.location.hostname;
}

/** 网关的两个地址（服务根 / 带 `/v1` 的 Base URL）。拿不到 host 时回 `null`。 */
export function gatewayUrlsOf(access: AccessInfo | null): GatewayUrls | null {
  const host = externalHostOf(access);
  if (access === null || host === null) return null;
  const root = `${access.gateway.scheme}://${joinHostPort(host, access.gateway.portGateway)}`;
  return { root, baseUrl: `${root}${GATEWAY_PATH_PREFIX}` };
}
