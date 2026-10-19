/**
 * 用户组的两个弹窗：建组 / 改配额，以及**网关 key 明文一次性展示**。
 *
 * 契约 §4 明文纪律（违反即红线）：
 * - `gatewayKey` 明文只在 `POST /api/groups` 与 `POST /api/groups/:id/keys`
 *   的响应里出现**一次**；库内只存 sha256 摘要，之后任何端点都取不回。
 * - 本组件不缓存、不写 localStorage、不进 URL；关闭弹窗即从内存丢弃。
 *   所以它是「只读展示」型弹窗，没有「再次查看」入口——重发只能重新签发。
 *   这句话**必须写在弹窗上**（不只在注释里）：关掉就取不回，而人不会因为注释里写过而记得。
 * - 复制是一个**显式按钮**，不只是文本右侧那个小图标：手滑点了关闭就没有第二次机会。
 *
 * 配额口径：`rpm`/`tpm`/`dailyQuota` 为 `null` = **不限**，与 `0`（等于全部拒绝）不同。
 */
import { CopyOutlined } from '@ant-design/icons';
import { Alert, App, Button, Form, Input, InputNumber, Modal, Space, Switch, Typography } from 'antd';
import { useEffect } from 'react';

import { groupsApi } from '@/api/endpoints';
import { useAction } from '@/api/hooks';
import type { Group, GroupCreateResponse, QuotaValue } from '@/api/types';
import { tokens } from '@/theme/tokens';

const { Text, Paragraph } = Typography;

// ── 一次性明文 ────────────────────────────────────────────────────────────

export interface GatewayKeyReveal {
  gatewayKey: string;
  maskedKey: string;
  /** 哪个组、是建组签发还是追加签发——只在提示文案里用。 */
  context: string;
  /**
   * 带 `/v1` 的网关 Base URL（有就显示）。抄走 key 的人下一个问题永远是"填哪儿"，
   * 而这两个值**只在同一帧里同时握在手上**（v1.15.7 / ADR-0036 决策 1）：
   * 事后再去接入页抄地址，就是又一次"两处各说一半"的机会。
   */
  baseUrl?: string | null;
}

export interface GatewayKeyRevealModalProps {
  reveal: GatewayKeyReveal | null;
  onClose: () => void;
}

/**
 * 明文展示。`reveal` 为 `null` 即关闭——父组件必须把它置回 `null`，
 * 这样明文不会残留在任何组件 state 里。
 */
export function GatewayKeyRevealModal({ reveal, onClose }: GatewayKeyRevealModalProps) {
  const { message } = App.useApp();

  /**
   * 显式复制。明文只在这一次响应里出现，**关掉就取不回**，所以复制这一步不能只靠
   * 文本右侧那个小图标 —— 手滑点了「关闭」就没有第二次机会了。
   * 剪贴板写入会被浏览器拒（非安全上下文 / 未授权），失败时必须说清楚并给出兜底动作。
   */
  const copy = async (): Promise<void> => {
    const text = reveal?.gatewayKey ?? '';
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
      title="网关 key（仅此一次）"
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
        <Button size="small" icon={<CopyOutlined />} onClick={() => { void copy(); }}>
          复制这串 key
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
            客户端 Base URL（结尾的 /v1 不能省）：
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
        message="现在不复制，之后就拿不到了"
        description={
          <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
            库里只存摘要，管理面此后只显示掩码。这串关掉就取不回；要新的只能再签发一把，
            或重置（重置会让旧 key 立即失效）。
          </Text>
        }
      />
    </Modal>
  );
}

// ── 建组 / 改配额 ─────────────────────────────────────────────────────────

interface GroupFormValues {
  name: string;
  rpm: number | null;
  tpm: number | null;
  dailyQuota: number | null;
  enabled: boolean;
}

export interface GroupFormModalProps {
  open: boolean;
  /** 有值 = 编辑配额；为空 = 建组（建组会顺带签发第一把 key）。 */
  editing: Group | null;
  onClose: () => void;
  onSaved: () => void;
  /** 建组成功时把一次性明文交给父组件展示。 */
  onCreated: (result: GroupCreateResponse) => void;
}

export function GroupFormModal({
  open,
  editing,
  onClose,
  onSaved,
  onCreated,
}: GroupFormModalProps) {
  const [form] = Form.useForm<GroupFormValues>();
  const { run, isPending } = useAction();

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({
        name: editing.name,
        rpm: editing.rpm,
        tpm: editing.tpm,
        dailyQuota: editing.dailyQuota,
        enabled: editing.enabled,
      });
    } else {
      form.setFieldsValue({ name: '', rpm: null, tpm: null, dailyQuota: null, enabled: true });
    }
  }, [open, editing, form]);

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const quota = (value: QuotaValue): QuotaValue => (value === undefined ? null : value);

    if (editing) {
      const result = await run(
        'save',
        () =>
          groupsApi.update(editing.id, {
            name: values.name,
            rpm: quota(values.rpm),
            tpm: quota(values.tpm),
            dailyQuota: quota(values.dailyQuota),
            enabled: values.enabled,
            revision: editing.revision,
          }),
        '已保存',
      );
      if (result === null) return;
      onSaved();
      onClose();
      return;
    }

    const created = await run(
      'save',
      () =>
        groupsApi.create({
          name: values.name,
          rpm: quota(values.rpm),
          tpm: quota(values.tpm),
          dailyQuota: quota(values.dailyQuota),
        }),
      '用户组已创建',
    );
    if (created === null) return;
    onSaved();
    onClose();
    // C1：建组自动签发第一把网关 key，明文只在这一次的响应里。交给父组件立刻展示。
    onCreated(created);
  };

  return (
    <Modal
      open={open}
      title={editing ? `编辑用户组 · ${editing.name}` : '新建用户组'}
      okText={editing ? '保存' : '创建并签发 key'}
      cancelText="取消"
      confirmLoading={isPending('save')}
      onOk={() => {
        void submit();
      }}
      onCancel={onClose}
      destroyOnClose
      width={560}
    >
      <Form<GroupFormValues> form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="name" label="组名" rules={[{ required: true, message: '请输入组名' }]}>
          <Input placeholder="如 内部测试组" />
        </Form.Item>

        <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
          <Form.Item name="rpm" label="RPM（每分钟请求）" style={{ flex: 1 }}>
            <InputNumber min={0} step={10} style={{ width: '100%' }} placeholder="不限" />
          </Form.Item>
          <Form.Item name="tpm" label="TPM（每分钟 token）" style={{ flex: 1 }}>
            <InputNumber min={0} step={1000} style={{ width: '100%' }} placeholder="不限" />
          </Form.Item>
          <Form.Item name="dailyQuota" label="日配额（请求数）" style={{ flex: 1 }}>
            <InputNumber min={0} step={100} style={{ width: '100%' }} placeholder="不限" />
          </Form.Item>
        </Space>

        {editing ? (
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );
}
