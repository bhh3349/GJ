/**
 * 登录页。
 * 契约 §1：`POST /api/auth/login` → `{username, expiresAt}`，会话在 HttpOnly Cookie 里，
 * **响应体里没有 token**，前端也读不到 —— 所以这里没有任何"保存 token"的代码，这是刻意的。
 *
 * 错误处理按契约 §0.4：
 * - `INVALID_CREDENTIALS`(401) → 页内提示并清空密码；
 * - `TOO_MANY_ATTEMPTS`(429) → 按钮倒计时禁用（每 IP 5 次/分钟）。
 * 登录失败用页内 Alert 而不是 toast：登录页是唯一的无壳页面，toast 容易被忽略。
 */
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { authApi } from '@/api/endpoints';
import { describeError } from '@/api/http';
import { tokens } from '@/theme/tokens';

interface LoginFormValues {
  username: string;
  password: string;
}

interface LocationState {
  from?: string;
}

/** 限速冷却时长，与契约「每 IP 5 次/分钟」对齐。 */
const THROTTLE_SECONDS = 60;

export default function LoginPage() {
  const [form] = Form.useForm<LoginFormValues>();
  const navigate = useNavigate();
  const location = useLocation();

  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => {
      setCountdown((n) => n - 1);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [countdown]);

  const onSubmit = async (values: LoginFormValues): Promise<void> => {
    setFailure(null);
    setSubmitting(true);
    try {
      await authApi.login({ username: values.username, password: values.password });
    } catch (error) {
      const { code, message } = describeError(error);
      setFailure({ code, message });
      if (code === 'INVALID_CREDENTIALS') {
        form.setFieldValue('password', '');
      }
      if (code === 'TOO_MANY_ATTEMPTS') {
        setCountdown(THROTTLE_SECONDS);
      }
      return;
    } finally {
      setSubmitting(false);
    }

    const state = location.state as LocationState | null;
    navigate(state?.from ?? '/dashboard', { replace: true });
  };

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
          width: 400,
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
            单管理员账号 · 会话 24h 滑动续期 · Cookie 同源鉴权
          </Typography.Text>
        </div>

        {failure ? (
          <Alert
            type={failure.code === 'TOO_MANY_ATTEMPTS' ? 'warning' : 'error'}
            showIcon
            style={{ marginBottom: tokens.space.lg }}
            message={failure.message}
            description={
              failure.code === 'TOO_MANY_ATTEMPTS'
                ? '登录失败次数过多，请等待倒计时结束后重试。'
                : undefined
            }
          />
        ) : null}

        <Form<LoginFormValues>
          form={form}
          layout="vertical"
          onFinish={(values) => {
            void onSubmit(values);
          }}
          onFinishFailed={() => {
            setFailure({ code: 'INVALID_PARAM', message: '请填写账号与密码' });
          }}
        >
          <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
            <Input autoComplete="username" placeholder="admin" disabled={submitting} />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password
              autoComplete="current-password"
              placeholder="••••••••"
              disabled={submitting}
            />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button
              type="primary"
              htmlType="submit"
              block
              loading={submitting}
              disabled={countdown > 0}
            >
              {countdown > 0 ? `登录过于频繁，${countdown}s 后可重试` : '登录'}
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
