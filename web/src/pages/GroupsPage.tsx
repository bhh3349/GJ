import { PageStub } from '@/components/PageStub';

export default function GroupsPage() {
  return (
    <PageStub
      title="用户组"
      description="建组、发 key、配额设置"
      pending={[
        'GET /api/groups 列表',
        'POST /api/groups 建组',
        '组内发 key（明文仅一次返回）',
        '配额设置：RPM / TPM / 日配额，超限错误码 QUOTA_EXCEEDED / KEY_EXHAUSTED',
      ]}
    />
  );
}
