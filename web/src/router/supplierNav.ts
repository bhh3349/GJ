/**
 * 侧栏供应商列表的失效信号（一个模块级计数器 + 订阅）。
 *
 * 为什么需要它：侧栏挂在 `AppLayout` 上，**路由切换不会重挂**，所以它自己那份
 * `GET /api/upstreams` 的数据只会在整页刷新时更新。若新增 / 改名 / 删除上游后不显式失效，
 * 页面内容是真的、侧栏却还是旧的 —— 这种"局部陈旧"最难被发现（看起来不像坏了）。
 *
 * 谁负责失效：**写上游的地方**，只有两处 —— `UpstreamModal` 提交成功（新增 / 改名）、
 * 删除上游成功（`deleteUpstream`）。不在路由变化时无脑重取：那会把"每次点导航都多一个请求"
 * 变成常态，而它换不来任何正确性。
 *
 * 不引入状态库：一个计数器足够，读取走 `useSyncExternalStore`。
 */
let revision = 0;
const listeners = new Set<() => void>();

/** 上游的**列表形状**变了（新增 / 改名 / 删除）时调用。改启用状态不影响侧栏文案，不必调。 */
export function invalidateSupplierNav(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

export function subscribeSupplierNav(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSupplierNavRevision(): number {
  return revision;
}
