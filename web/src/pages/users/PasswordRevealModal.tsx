/**
 * 建号成功后的**口令一次性展示**。与用户组的 `GatewayKeyRevealModal` 同一形状、
 * 同一条纪律 —— 不是因为"看起来对称"，是因为底层事实相同：
 *
 * 口令与网关 key 一样，**只在创建那一次的响应里以明文存在**。服务端只留
 * scrypt 散列，此后没有任何端点能取回它（§4 铁律 / §1）。所以：
 *
 * - 本组件不缓存、不写 localStorage、不进 URL；关闭即从内存丢弃。
 *  父组件必须把 `reveal` 置回 `null`，这样明文不会残留在任何组件 state 里。
 * - **没有"再次查看"入口**。重看只能重建号，而那会让旧口令立即失效 ——
 *  一个点了只会失败的按钮，比没有按钮更坏。
 * - 复制是**显式按钮**，不是文本右侧那个小图标：手滑点了关闭就没有第二次机会。
 *
 * 与 `GatewayKeyRevealModal` 的**唯一差别**是措辞（"这是登录口令，交给本人"
 * 而不是"这是网关 key，填进客户端"）。差别不在逻辑，在**这个东西归谁**：
 * key 归调用方，口令归那个人自己。
 */
import { CopyOutlined } from '@ant-design/icons';
import { Alert, App, Button, Modal, Space, Typography } from 'antd';

import type { UserRole } from '@/api/types';
import { tokens } from '@/theme/tokens';

const { Text, Paragraph } = Typography;

export interface PasswordReveal {
  username: string;
  password: string;
  role: UserRole;
  /** 建的是管理员还是普通用户 —— 只影响提示文案。 */
  context: string;
}

export interface PasswordRevealModalProps {
  reveal: PasswordReveal | null;
  onClose: () => void;
}

export function PasswordRevealModal({ reveal, onClose }: PasswordRevealModalProps) {
  const { message } = App.useApp();

  const copy = async (): Promise<void> => {
    const text = reveal?.password ?? '';
    if (text === '') return;
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制到剪贴板');
    } catch {
      message.error('浏览器不允许写入剪贴板，请手动选中上面这串复制');
    }
  };

  return (
    <Modal
      open={reveal !== null}
      title="登录口令（仅此一次）"
      okText="我已保存，关闭"
      cancelButtonProps={{ style: { display: 'none' } }}
      onOk={onClose}
      onCancel={onClose}
      maskClosable={false}
      width={560}
    >
      <Paragraph type="secondary" style={{ marginBottom: tokens.space.xs }}>
        {reveal?.context ?? ''}
      </Paragraph>

      <div
        style={{
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          background: tokens.color.bgBase,
          padding: tokens.space.md,
          marginBottom: tokens.space.sm,
        }}
      >
        <Space direction="vertical" size={tokens.space.xs} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 11 }}>
            账号
          </Text>
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 13, color: tokens.color.textPrimary }}>
            {reveal?.username ?? ''}
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            口令
          </Text>
          <Text
            style={{
              fontFamily: tokens.font.mono,
              fontSize: 13,
              wordBreak: 'break-all',
              color: tokens.color.textPrimary,
            }}
            copyable={{ text: reveal?.password ?? '' }}
          >
            {reveal?.password ?? ''}
          </Text>
        </Space>
      </div>

      <Space size={tokens.space.sm} align="center" wrap style={{ marginBottom: tokens.space.sm }}>
        <Button size="small" icon={<CopyOutlined />} onClick={() => void copy()}>
          复制这串口令
        </Button>
        {reveal?.role === 'user' ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            他登录后进的是消费面，看不到这一页。
          </Text>
        ) : null}
      </Space>

      <Alert
        type="warning"
        showIcon
        style={{ background: tokens.tint.warning, border: 'none' }}
        message="现在不抄，之后就拿不到了"
        description={
          <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
            库里只存口令散列，管理面此后也只显示账号名。这串关掉就取不回；
            也没有"重置口令"这个功能 —— 要换只能删掉这个账号重建一个。
          </Text>
        }
      />
    </Modal>
  );
}
