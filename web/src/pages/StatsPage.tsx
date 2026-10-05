import { PageStub } from '@/components/PageStub';

export default function StatsPage() {
  return (
    <PageStub
      title="统计"
      description="按 key / 上游 / 用户组 / 时间的用量聚合"
      pending={[
        'GET /api/stats/usage 聚合查询',
        'ECharts 按需引入（不整包引入），切页不阻塞首屏',
        'token 口径 int；估算值 is_estimated=1 需在图例上可区分',
        '时间轴统一 ISO8601 UTC 展示',
      ]}
    />
  );
}
