import { PageStub } from '@/components/PageStub';

export default function LogsPage() {
  return (
    <PageStub
      title="日志"
      description="调用记录查询，保留 30 天"
      pending={[
        '调用记录查询（分页 limit 默认 20，上限 200）',
        '筛选：时间区间 / key / 上游 / 用户组 / 失败类型',
        '失败枚举五类：AUTH_INVALID / RATE_LIMITED / INSUFFICIENT_BALANCE / UPSTREAM_ERROR / NETWORK',
        '首字节耗时（latencyMs）与 token 用量列',
      ]}
    />
  );
}
