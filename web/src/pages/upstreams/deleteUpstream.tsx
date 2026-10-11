/**
 * 删除上游 —— 二次确认与 `409 UPSTREAM_HAS_KEYS` 分支的**唯一实现**（契约 v1.2.2 / ADR-0016）。
 *
 * 上游列表页与供应商专属页都要删上游，两处各写一份必然走偏（一处改了文案、另一处没改）。
 *
 * 契约纪律（照 §2 逐字，不在这里加料）：
 * - `force!=true` 且上游下有 key **或模型档案** → `409 UPSTREAM_HAS_KEYS`，
 *   `details:{keyCount, modelCount}`。**两个计数都要读**：`keyCount` 可能是 0 而
 *   `modelCount > 0`（只同步了模型、没建 key 是常态），只看 key 数会让人读成"没什么可删的"。
 * - `modelCount` 拿不到（早于 v1.2.2 的后端）时是 `null` ⇒ **不写模型数**，不把"不知道"写成 0。
 * - `force=true` 不是软删：单事务按依赖序**物理删除整棵子树**，所以文案必须说出
 *   "模型档案连同手改的开关 / 价格一起没"。
 */
import { App, Typography } from 'antd';

import { upstreamsApi } from '@/api/endpoints';
import { describeError, isApiError } from '@/api/http';
import type { Upstream } from '@/api/types';
import { invalidateSupplierNav } from '@/router/supplierNav';

const { Text } = Typography;

/** `App.useApp()` 给的 `modal` 实例（不另起 `Modal.confirm`，那会丢全局 `ConfigProvider` 上下文）。 */
type ModalHook = ReturnType<typeof App.useApp>['modal'];

export interface SubtreeCounts {
  /** 未软删的 key 数（与 §2 `Upstream.keyCount` 同源）。后端没给时退回列表行自身的计数。 */
  keyCount: number;
  /** 模型档案数。后端未返回（早于 v1.2.2）时是 `null`，**不补 0**。 */
  modelCount: number | null;
}

/** 解析 `409 UPSTREAM_HAS_KEYS` 的 `details: {keyCount, modelCount}`（契约 v1.2.2）。 */
export function detailCounts(details: unknown, row: Upstream): SubtreeCounts {
  const pick = (key: 'keyCount' | 'modelCount'): number | null => {
    if (details === null || typeof details !== 'object' || !(key in details)) return null;
    const value = (details as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  return { keyCount: pick('keyCount') ?? row.keyCount, modelCount: pick('modelCount') };
}

/** 二次确认正文：只说删掉什么（数量）。 */
export function DeleteUpstreamBody({ name, counts }: { name: string; counts: SubtreeCounts }) {
  const parts: string[] = [];
  if (counts.keyCount > 0) parts.push(`Key ${counts.keyCount} 个`);
  if (counts.modelCount !== null && counts.modelCount > 0) {
    parts.push(`模型档案 ${counts.modelCount} 个`);
  }

  return (
    <div>
      <Text>
        将物理删除「{name}」整棵子树
        {parts.length > 0 ? `：${parts.join(' · ')}` : ''}。
      </Text>
    </div>
  );
}

export interface DeleteUpstreamHandlers {
  modal: ModalHook;
  upstream: Upstream;
  /** 删除成功（含 409 二次确认后 `force` 成功）：调用方刷新自己的数据。 */
  onDeleted: () => void;
  /** 删除失败：文案已按契约码格式化，调用方展示即可。 */
  onFailure: (text: string) => void;
}

/**
 * 发起删除。故意不走 `useAction`：`force` 分支需要读到 `UPSTREAM_HAS_KEYS` 的**原始错误**，
 * 而 `useAction.run` 会把错误吞成 `null`。
 */
export function deleteUpstream({ modal, upstream, onDeleted, onFailure }: DeleteUpstreamHandlers): void {
  const attempt = (force: boolean): void => {
    upstreamsApi
      .remove(upstream.id, force)
      .then(() => {
        // 上游从列表里消失，侧栏子菜单必须跟着重取（不重取就是"页面新、侧栏旧"）。
        invalidateSupplierNav();
        onDeleted();
      })
      .catch((error: unknown) => {
        if (!force && isApiError(error) && error.code === 'UPSTREAM_HAS_KEYS') {
          const counts = detailCounts(error.details, upstream);
          modal.confirm({
            title: `「${upstream.name}」下还有从属资源，确定一并删除？`,
            width: 480,
            content: <DeleteUpstreamBody name={upstream.name} counts={counts} />,
            okText: '连同从属资源删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            onOk: () => {
              attempt(true);
            },
          });
          return;
        }
        const { code, message } = describeError(error);
        onFailure(`${message} [${code}]`);
      });
  };

  attempt(false);
}
