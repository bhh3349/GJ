import { Alert, Button, Card, Form, Input, Typography } from 'antd';

import { tokens } from '@/theme/tokens';

interface LoginFormValues {
  username: string;
  password: string;
}

/**
 * 登录页。
 * 契约未冻结：/api/auth/login 的请求/响应字段名未进 docs/api-contract.md，故此处不写调用方代码，
 * 提交按钮保持禁用并在页面上明示原因（禁止用 mock 证明完成）。
 */
export default function LoginPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.space.lg,
      }}
    >
      <Card
        style={{
          width: 380,
          background: tokens.color.bgContainer,
          border: `1px solid ${tokens.color.border}`,
        }}
        styles={{ body: { padding: tokens.space.xl } }}
      >
        <div style={{ marginBottom: tokens.space.lg }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: tokens.color.textPrimary }}>
            Gateway Console
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            单管理员账号登录 · 会话 24h 滑动续期
          </Typography.Text>
        </div>

        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: tokens.space.lg }}
          message="等待契约冻结"
          description="docs/api-contract.md 尚未冻结 /api/auth/* 字段，登录未接线，不使用 mock 假登录。"
        />

        <Form<LoginFormValues> layout="vertical" disabled>
          <Form.Item name="username" label="账号" rules={[{ required: true }]}>
            <Input autoComplete="username" placeholder="admin" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" placeholder="••••••••" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
