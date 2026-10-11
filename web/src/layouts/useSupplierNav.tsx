/**
 * 侧栏「上游管理」子菜单的内容（**添加供应商固定第一，其余按真实上游列表排**）。
 *
 * 纪律：
 * - **列表来自真实端点**（`GET /api/upstreams`，取满一页）。加载中显示「加载中…」、
 *   失败显示「供应商列表加载失败」并置灰 —— 都不编造一个空列表（缺省不是证据：
 *   空列表与"还没查到"在屏幕上会长得一模一样）。
 * - 新增 / 改名 / 删除上游后由 `invalidateSupplierNav()` 失效重取；
 *   改启用状态不改列表形状，不触发（见 `@/router/supplierNav`）。
 * - 只显示**名字**，不显示 Base URL / key 数 —— 子菜单是导航，不是仪表盘。
 */
import { PlusOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useMemo, useSyncExternalStore } from 'react';

import { upstreamsApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import { PAGE_SIZE_MAX } from '@/api/types';
import { getSupplierNavRevision, subscribeSupplierNav } from '@/router/supplierNav';

type MenuItem = NonNullable<MenuProps['items']>[number];

/** 「添加供应商」的固定 key（排在第一位，且永远存在 —— 它是唯一不依赖数据的一条）。 */
export const SUPPLIER_ADD_KEY = '/upstreams/new';

export interface SupplierNav {
  children: MenuItem[];
  /** 当前列表里的上游 id，用于把 `/upstreams/:id` 反查成该子项做高亮。 */
  ids: string[];
  loading: boolean;
  error: unknown;
}

export function useSupplierNav(): SupplierNav {
  // 写上游的地方（新增 / 改名 / 删除）显式失效；路由切换不触发重取。
  const revision = useSyncExternalStore(
    subscribeSupplierNav,
    getSupplierNavRevision,
    getSupplierNavRevision,
  );

  const list = useResource(() => upstreamsApi.list({ pageSize: PAGE_SIZE_MAX }), [revision]);
  const items = list.data?.items ?? [];

  const children = useMemo<MenuItem[]>(() => {
    const out: MenuItem[] = [{ key: SUPPLIER_ADD_KEY, icon: <PlusOutlined />, label: '添加供应商' }];
    for (const upstream of items) {
      out.push({ key: `/upstreams/${upstream.id}`, label: upstream.name });
    }
    if (list.error && !list.data) {
      out.push({ key: 'suppliers-error', label: '供应商列表加载失败', disabled: true });
    } else if (!list.data) {
      out.push({ key: 'suppliers-loading', label: '加载中…', disabled: true });
    }
    return out;
  }, [items, list.error, list.data]);

  const ids = useMemo(() => items.map((upstream) => upstream.id), [items]);

  return { children, ids, loading: list.loading, error: list.error };
}
