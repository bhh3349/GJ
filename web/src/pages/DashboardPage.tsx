import { PageStub } from '@/components/PageStub';

export default function DashboardPage() {
  return (
    <PageStub
      title="仪表盘"
      description="QPS、成功率、余额总览、key 健康状态"
      pending={[
        'GET /api/stats/usage 时间窗口指标（QPS 由后端带时间窗口字段）',
        'WS /api/stats/live 实时推送，前端不轮询，指标 1s 一档',
        '余额三口径卡片：单 key / 上游合计 / 全局合计，含 balanceUnknownKeyCount',
        'key 健康状态矩阵（冷却 / 失败计数只读）',
      ]}
    />
  );
}
