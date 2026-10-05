import { PageStub } from '@/components/PageStub';

export default function UpstreamsPage() {
  return (
    <PageStub
      title="上游管理"
      description="Base URL 与上游凭据的增删改"
      pending={[
        'GET /api/upstreams 列表',
        'POST /api/upstreams 新增（Base URL 校验）',
        'PUT /api/upstreams/:id 编辑',
        'DELETE /api/upstreams/:id 删除（关联 key 的处置确认）',
      ]}
    />
  );
}
