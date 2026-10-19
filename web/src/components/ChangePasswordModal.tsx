/**
 * 改自己的口令（v1.15.9 / ADR-0038 决策 3）—— `POST /api/auth/password`（§1）。
 *
 * **为什么放在 `components/` 而不是 `pages/console/`**：两个外壳都要挂它
 * （`AppLayout` 的账号菜单给管理员、`ConsoleLayout` 的账号菜单给普通用户），
 * 而它改的是**会话本人**那一行、与角色无关 —— 服务端一条路径、前端一个组件。
 * 放进 `pages/console/` 就会让管理面的 chunk 依赖消费面的 chunk（方向反了），
 * 放进任一个 Layout 里则会变成两份实现、两个漂移点。
 *
 * **它不含任何管理面内容**，只有 antd + `authApi.changePassword` —— 所以消费面的
 * 用户下载它不会顺带下载管理面代码（`ConsoleLayout` 头注那条分包纪律）。
 *
 * 三个必须说清楚的行为，全部来自服务端而不是这里猜的：
 *
 * 1. **成功之后不要跳登录页**。改密会踢掉该账号的**其他**会话、**保留当前会话** ——
 *    所以"改完被弹回登录页"是错的表现，用户会以为改失败了（或以为自己把自己踢了）。
 *    这里成功后就地给一张结果卡，把"谁被踢了、谁还在"写明白。
 * 2. **旧口令必填**。少这一格的话，一条被偷走的会话就能直接改掉口令、把真正的主人
 *    锁在门外 —— 服务端因此强制验旧口令（`INVALID_CREDENTIALS` 401）。
 * 3. **限速与登录共用同一个闸**（5 次/分钟/IP，`TOO_MANY_ATTEMPTS` 429）。
 *    所以这里的 429 不是"网络出错"，是"等一分钟" —— 照 `LoginPage` 的做法起倒计时，
 *    而不是让人反复点一个必然失败的按钮。
 *
 * 失败一律走**弹窗内 Alert**、不用 toast：这台弹窗上四种失败（旧口令错 / 太短 /
 * 与旧口令相同 / 被限速）各需要一句不同的话，而 `useAction` 那个通用 toast 会把它们
 * 压成同一行带错误码的文本 —— 那正是"说了等于没说"。
 */
import { LockOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { authApi } from '@/api/endpoints';
import { describeError, isApiError } from '@/api/http';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

/** 与服务端 `PASSWORD_MIN_LENGTH` / §19.7 建号同一把尺子（8 位）。 */
const MIN_LENGTH = 8;

/** 限速冷却时长，与 §1「每 IP 5 次/分钟」对齐（同 `LoginPage`）。 */
const THROTTLE_SECONDS = 60;

interface FormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface ChangePasswordModalProps {
  open: boolean;
  onClose: () => void;
}

export function ChangePasswordModal({ open, onClose }: ChangePasswordModalProps) {
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);
  // `hint` 显式带 `| undefined`：`exactOptionalPropertyTypes` 下"这个键不存在"与
  // "这个键是 undefined"不是一回事，而这里的 hint 常常就是没有 —— 写 `?:` 会逼着
  // 调用点去拼一个 `...(hint ? {hint} : {})`，那是为类型擦屁股而不是表达意图。
  const [failure, setFailure] = useState<{
    code: string;
    message: string;
    hint: string | undefined;
  } | null>(null);
  const [done, setDone] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setTimeout(() => setCountdown((n) => n - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [countdown]);

  // 关闭即清干净：口令明文只在这一次提交里存在，不在任何 state 里留到下一次打开。
  useEffect(() => {
    if (open) return;
    form.resetFields();
    setFailure(null);
    setDone(false);
  }, [open, form]);

  const submit = async (values: FormValues): Promise<void> => {
    setFailure(null);
    setSubmitting(true);
    try {
      await authApi.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      setDone(true);
    } catch (error) {
      const { code, message } = describeError(error);
      if (isApiError(error) && code === 'TOO_MANY_ATTEMPTS') setCountdown(THROTTLE_SECONDS);
      setFailure({
        code,
        message,
        hint:
          code === 'INVALID_CREDENTIALS'
            ? '当前密码填错了。口令本身没有被改动 —— 改回来再试。'
            : code === 'TOO_MANY_ATTEMPTS'
              ? '改密与登录共用同一个限速闸（5 次/分钟），等倒计时结束再试。'
              : code === 'INVALID_PARAM'
                ? '新密码要 8 位以上，且不能与当前密码相同。'
                : undefined,
      });
      return;
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="修改密码"
      width={460}
      // 提交中不许点遮罩关掉：请求已经在路上了，关掉只会让人不知道到底改没改成功。
      maskClosable={!submitting}
      footer={
        done
          ? [
              <Button key="close" type="primary" onClick={onClose}>
                知道了
              </Button>,
            ]
          : undefined
      }
      confirmLoading={submitting}
      okText="改密码"
      cancelText="取消"
      okButtonProps={{ disabled: countdown > 0 || submitting }}
      onOk={() => {
        void form.submit();
      }}
      onCancel={onClose}
      destroyOnClose
    >
      {done ? (
        <Space direction="vertical" size={tokens.space.sm} style={{ width: '100%' }}>
          <Alert
            type="success"
            showIcon
            message="密码已改"
            description={
              <Text style={{ fontSize: 12 }}>
                该账号在<Text strong>其他设备</Text>上的会话已经全部失效（这正是改密码的作用）。
                你现在这一条会话保留着，所以不会被弹回登录页 —— 但下次登录要用
                <Text strong>新密码</Text>。
              </Text>
            }
          />
        </Space>
      ) : (
        <>
          {failure ? (
            <Alert
              type={failure.code === 'TOO_MANY_ATTEMPTS' ? 'warning' : 'error'}
              showIcon
              style={{ marginBottom: tokens.space.md }}
              message={failure.message}
              description={
                failure.hint ? (
                  <Text style={{ fontSize: 12 }}>
                    {failure.hint}
                    {failure.code === 'TOO_MANY_ATTEMPTS' && countdown > 0
                      ? `（${countdown} 秒）`
                      : ''}
                  </Text>
                ) : undefined
              }
            />
          ) : null}

          <Form<FormValues>
            form={form}
            layout="vertical"
            requiredMark="optional"
            onFinish={(values) => {
              void submit(values);
            }}
          >
            <Form.Item
              name="currentPassword"
              label="当前密码"
              rules={[{ required: true, message: '请输入当前密码' }]}
            >
              <Input.Password autoComplete="current-password" placeholder="••••••••" />
            </Form.Item>
            <Form.Item
              name="newPassword"
              label="新密码"
              rules={[
                { required: true, message: '请输入新密码' },
                { min: MIN_LENGTH, message: `至少 ${MIN_LENGTH} 位` },
              ]}
              extra={`至少 ${MIN_LENGTH} 位（与建号同一把尺子，判据在服务端）。`}
            >
              <Input.Password autoComplete="new-password" placeholder="••••••••" />
            </Form.Item>
            <Form.Item
              name="confirmPassword"
              label="确认新密码"
              dependencies={['newPassword']}
              rules={[
                { required: true, message: '请再输入一次新密码' },
                ({ getFieldValue }) => ({
                  validator: (_rule, value: string) =>
                    value === undefined || value === getFieldValue('newPassword')
                      ? Promise.resolve()
                      : Promise.reject(new Error('两次输入的新密码不一致')),
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" placeholder="••••••••" />
            </Form.Item>
          </Form>

          <Text type="secondary" style={{ fontSize: 12 }}>
            <LockOutlined style={{ marginInlineEnd: tokens.space.xs }} />
            改完之后，这个账号在别处的会话会被全部踢下线，当前这条留着 —— 所以你不会被弹回登录页。
          </Text>
        </>
      )}
    </Modal>
  );
}
