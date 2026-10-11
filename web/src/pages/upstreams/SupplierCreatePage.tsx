/**
 * 「添加供应商」页 —— 路由 `/upstreams/new`（侧栏「上游管理」子菜单第一条）。
 *
 * 它**不重新实现表单**：新增只此一处实现（`UpstreamModal`），本页只负责
 * 「进来就打开、取消回列表、成功后去这个供应商的专属页」这段导航。
 *
 * 为什么做成一个路由而不是弹窗：子菜单需要一个能高亮的落点，且用户可以直接
 * 收藏 / 回退到「添加供应商」；弹窗留在列表页与专属页里就地编辑，两条路共用同一个组件。
 */
import { useNavigate } from 'react-router-dom';

import { PageHeader } from '@/components/PageHeader';
import { UpstreamModal } from '@/pages/upstreams/UpstreamModal';

export default function SupplierCreatePage() {
  const navigate = useNavigate();

  return (
    <>
      <PageHeader title="添加供应商" />
      <UpstreamModal
        open
        editing={null}
        onClose={() => {
          navigate('/upstreams');
        }}
        onSaved={(created) => {
          // 建成即进它的专属页；拿不到 id（异常路径）就回列表，不猜一个地址。
          navigate(created ? `/upstreams/${created.id}` : '/upstreams');
        }}
      />
    </>
  );
}
