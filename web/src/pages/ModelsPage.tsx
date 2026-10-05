import { PageStub } from '@/components/PageStub';

export default function ModelsPage() {
  return (
    <PageStub
      title="模型档案"
      description="模型类型、支持能力、价格、可用 key"
      pending={[
        'GET /api/models 卡片列表 + 筛选',
        'POST /api/models/sync 从上游拉取建档',
        '详情：类型 / 支持能力 / 价格（金额用分 int）',
        '详情：可用 key 列表（与 /v1/models 口径逐项一致）',
      ]}
    />
  );
}
