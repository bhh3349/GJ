import { PageStub } from '@/components/PageStub';

export default function KeysPage() {
  return (
    <PageStub
      title="Key 管理"
      description="分类标签、余额显示、启用与禁用"
      pending={[
        'GET /api/keys 列表（key 只显示 ****后4位）',
        '分类标签：token-plan / 余额 两类分列',
        'PUT /api/keys/:id/balance 余额录入与查询',
        '启用 / 禁用（写操作递增 revision，健康态只读）',
        '写操作全部走 X-Requested-With + Cookie 同源鉴权',
      ]}
    />
  );
}
