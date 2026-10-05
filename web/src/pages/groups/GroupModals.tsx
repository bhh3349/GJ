/**
 * 用户组的两个弹窗：建组 / 改配额，以及**网关 key 明文一次性展示**。
 *
 * 契约 §4 明文纪律（违反即红线）：
 * - `gatewayKey` 明文只在 `POST /api/groups` 与 `POST /api/groups/:id/keys`
 *   的响应里出现**一次**；库内只存 sha256 摘要，之后任何端点都取不回。
 * - 本组件不缓存、不写 localStorage、不进 URL；关闭弹窗即从内存丢弃。
 *   所以它是「只读展示」型弹窗，没有「再次查看」入口——重发只能重新签发。
 *
 * 配额口径：`rpm`/`tpm`/`dailyQuota` 为 `null` = **不限**，与 `0`（等于全部拒绝）不同。
 */
import { Alert, Form, Input, InputNumber, Modal, Space, Switch, Typography } from 'antd';
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
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: tokens.space.md }}
        message="关闭后无法再次查看"
        description="系统只保存 sha256 摘要，明文不再落盘、不再回显、不进日志。丢失只能重置或重新签发。"
      />
      <Paragraph type="secondary" style={{ marginBottom: tokens.space.xs }}>
        {reveal?.context ?? ''}
      </Paragraph>
      <div
        style={{
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          background: tokens.color.bgBase,
          padding: tokens.space.md,
          marginBottom: tokens.space.md,
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
      <Text type="secondary" style={{ fontSize: 12 }}>
        掩码：{reveal?.maskedKey ?? '—'}（列表里只会出现这个）
      </Text>
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
        {editing === null ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: tokens.space.md }}
            message="创建后会自动签发第一把网关 key"
            description="明文 key 只在创建响应里出现一次，请当场保存。"
          />
        ) : null}

        <Form.Item name="name" label="组名" rules={[{ required: true, message: '请输入组名' }]}>
          <Input placeholder="如 内部测试组" />
        </Form.Item>

        <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
          <Form.Item
            name="rpm"
            label="RPM（每分钟请求）"
            extra="留空 = 不限"
            style={{ flex: 1 }}
          >
            <InputNumber min={0} step={10} style={{ width: '100%' }} placeholder="不限" />
          </Form.Item>
          <Form.Item name="tpm" label="TPM（每分钟 token）" extra="留空 = 不限" style={{ flex: 1 }}>
            <InputNumber min={0} step={1000} style={{ width: '100%' }} placeholder="不限" />
          </Form.Item>
          <Form.Item
            name="dailyQuota"
            label="日配额（请求数）"
            extra="留空 = 不限"
            style={{ flex: 1 }}
          >
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
