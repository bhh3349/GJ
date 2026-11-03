/**
 * 消费面的两个 key 弹窗：**明文一次性展示** 与 **改名**（v1.15.9 / ADR-0038）。
 *
 * 为什么这里又写了一份明文弹窗，而不是 import 管理面的 `GatewayKeyRevealModal`：
 *
 * 分包的边界是**代码边界**。消费面的三个页面全部懒加载，`role=user` 的会话
 * 永远不会下载管理面的 chunk（`router.tsx` 里那句"不是性能优化，是别让管理面的代码
 * 进到普通用户的浏览器里"）。从 `/pages/groups/GroupModals` import 一个组件，
 * 会把那个模块（含建组 / 改配额表单）整块拉进消费面的 chunk —— 于是"分包"这件事
 * 在构建产物上就失效了，而它不会有任何编译错误或测试失败来提醒我们。
 *
 * 两份明文弹窗的**纪律是同一条**（§4 铁律 / ADR-0006）：明文不缓存、不写
 * localStorage、不进 URL，关闭即从内存丢弃；没有"再次查看"入口 —— 要新的只能再签一把。
 * 与管理面那一份的形状差异只有文案：这里说"你的 key"，那里说"这个组的 key"。
 *
 * 改名弹窗存在的理由更简单：`label` 这一列建表起就在，而 v1.15.9 是它第一次有读者。
 * 「我有 10 把 key，哪把是给哪个客户端的」这个问题在界面上此前**没有答案** ——
 * 用户只能靠 `****9f3c` 这四个字符认人。
 */
import { CopyOutlined } from '@ant-design/icons';
import { Alert, App, Button, Form, Input, Modal, Space, Typography } from 'antd';
import { useEffect } from 'react';

import { tokens } from '@/theme/tokens';

const { Text, Paragraph } = Typography;

// ── 一次性明文 ────────────────────────────────────────────────────────────

export interface ConsoleKeyReveal {
  /** **仅此一次**的明文（以 `gw-` 开头）。 */
  gatewayKey: string;
  maskedKey: string;
  /** 名字（刚填的那个，`null` = 没起名）—— 让"我刚签的是哪一把"当场对上号。 */
  label: string | null;
  /** 带 `/v1` 的 Base URL（拿得到就显示）。抄走 key 的人下一个问题永远是"填哪儿"。 */
  baseUrl?: string | null;
}

export interface ConsoleKeyRevealModalProps {
  reveal: ConsoleKeyReveal | null;
  onClose: () => void;
}

/**
 * 明文展示。`reveal` 为 `null` 即关闭 —— 父组件必须把它置回 `null`，
 * 这样明文不会残留在任何组件 state 里。
 */
export function ConsoleKeyRevealModal({ reveal, onClose }: ConsoleKeyRevealModalProps) {
  const { message } = App.useApp();

  /**
   * 显式复制。明文只在这一次响应里出现，**关掉就取不回**，所以复制这一步不能只靠
   * 文本右侧那个小图标 —— 手滑点了「关闭」就没有第二次机会了。
   */
  const copy = async (): Promise<void> => {
    const text = reveal?.gatewayKey ?? '';
    if (text === '') return;
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制');
    } catch {
      message.error('请手动选中上面这串复制');
    }
  };

  return (
    <Modal
      open={reveal !== null}
      title="你的新 key"
      okText="已保存"
      cancelButtonProps={{ style: { display: 'none' } }}
      onOk={onClose}
      onCancel={onClose}
      // 点遮罩不关：这一下点下去明文就永远没了，必须走那个写着"我已保存"的按钮。
      maskClosable={false}
      width={560}
    >
      <Paragraph type="secondary" style={{ marginBottom: tokens.space.xs }}>
        {reveal?.label === null || reveal?.label === undefined
          ? '刚签发的 key（未命名）'
          : `刚签发的 key：「${reveal.label}」`}
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
        <Text
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 13,
            wordBreak: 'break-all',
            color: tokens.color.textPrimary,
          }}
          copyable={{ text: reveal?.gatewayKey ?? '' }}
        >
          {reveal?.gatewayKey ?? ''}
        </Text>
      </div>

      <Space size={tokens.space.sm} align="center" wrap style={{ marginBottom: tokens.space.sm }}>
        <Button
          size="small"
          icon={<CopyOutlined />}
          onClick={() => {
            void copy();
          }}
        >
          复制
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          掩码：{reveal?.maskedKey ?? '—'}
        </Text>
      </Space>

      {reveal?.baseUrl ? (
        <div
          style={{
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            background: tokens.color.bgBase,
            padding: tokens.space.md,
            marginBottom: tokens.space.sm,
          }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            Base URL（/v1 不能省）
          </Text>
          <div style={{ marginTop: tokens.space.xs }}>
            <Text
              style={{ fontFamily: tokens.font.mono, fontSize: 13, wordBreak: 'break-all' }}
              copyable={{ text: reveal.baseUrl }}
            >
              {reveal.baseUrl}
            </Text>
          </div>
        </div>
      ) : null}

      <Alert
        type="warning"
        showIcon
        style={{ background: tokens.tint.warning, border: 'none' }}
        message="只显示一次，关闭后取不回"
      />
    </Modal>
  );
}

// ── 改名 ──────────────────────────────────────────────────────────────────

export interface ConsoleKeyRenameModalProps {
  /** 有值 = 打开；`null` = 关闭。改名弹窗只需要这两格，不需要整个 DTO。 */
  target: { id: string; maskedKey: string; label: string | null } | null;
  onClose: () => void;
  /**
   * 提交。父组件返回 `true` 表示成功（此时父组件会关掉弹窗）；
   * 返回 `false` 表示失败 —— 弹窗**保持打开并保留输入**，不要让人重打一遍。
   */
  onSubmit: (keyId: string, label: string | null) => Promise<boolean>;
  pending: boolean;
}

interface RenameFormValues {
  label: string;
}

/**
 * 改名弹窗。**清空 = 去掉名字**（`''` → 服务端归一化成 `null`），
 * 这在 UI 上就是"把输入框删干净"，不需要第二个「清除名字」按钮 ——
 * 两种写法对应同一个事实，那就只留一种写法。
 */
export function ConsoleKeyRenameModal({ target, onClose, onSubmit, pending }: ConsoleKeyRenameModalProps) {
  const [form] = Form.useForm<RenameFormValues>();

  useEffect(() => {
    if (target === null) return;
    // 打开时把当前名字填进去（`null` → 空串），而不是每次从一个空框开始：
    // 改名多数是"在这个名字上改两个字"，让人重打一遍是纯粹的损耗。
    form.setFieldsValue({ label: target.label ?? '' });
  }, [target, form]);

  const submit = async (): Promise<void> => {
    if (target === null) return;
    const values = await form.validateFields();
    const raw = values.label ?? '';
    // **本地也 trim 一次**：服务端会再归一化一遍（空串/纯空白 → `null`），
    // 这里 trim 只是为了让"我传的是什么"与"库里存的是什么"在这一次调用里一致 ——
    // 判据仍在服务端，不是这里替它判。
    const trimmed = raw.trim();
    const ok = await onSubmit(target.id, trimmed === '' ? null : trimmed);
    if (ok) onClose();
  };

  return (
    <Modal
      open={target !== null}
      title="改名"
      okText="保存"
      cancelText="取消"
      confirmLoading={pending}
      onOk={() => {
        void submit();
      }}
      onCancel={onClose}
      destroyOnClose
      width={480}
    >
      <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: tokens.space.sm }}>
        这把 key 的掩码是 <Text code>{target?.maskedKey ?? ''}</Text>。
      </Paragraph>
      <Form<RenameFormValues> form={form} layout="vertical" requiredMark="optional">
        <Form.Item
          name="label"
          label="名称"
          rules={[{ max: 100, message: '名称最长 100 个字符' }]}
          extra="留空即去掉名字。"
        >
          <Input placeholder="如 台式机" maxLength={100} allowClear />
        </Form.Item>
      </Form>
    </Modal>
  );
}
