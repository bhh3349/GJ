/**
 * Key 管理的两个弹窗：新增/编辑、手动录入余额。
 *
 * 两条不可违背的契约点：
 * 1. **明文只在 `POST /api/keys` 请求体里出现一次**。响应只回 `maskedKey`，
 *    编辑弹窗里也不回显任何 key 内容 —— 所以编辑态根本不提供"查看原文"。
 * 2. `PUT /api/keys/:id/balance` 里 `0`（确实是 0）与 `null`（未知）是两个值。
 *    UI 上「置为未知」是独立按钮，不是把输入框清空，避免误把 0 当未知。
 */
import { Alert, Form, Input, InputNumber, Modal, Segmented, Select, Space, Switch, Typography } from 'antd';
import { useEffect } from 'react';

import { keysApi } from '@/api/endpoints';
import { useAction } from '@/api/hooks';
import type { KeyCategory, TokenPlan, Upstream, UpstreamKey } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatBalance } from '@/utils/format';

const { Text } = Typography;

// ── 新增 / 编辑 ───────────────────────────────────────────────────────────

interface KeyFormValues {
  upstreamId: string;
  key: string;
  category: KeyCategory;
  label: string;
  weight: number;
  enabled: boolean;
  planTokens: number | null;
  planExpiresAt: string | null;
}

export interface KeyFormModalProps {
  open: boolean;
  upstreams: readonly Upstream[];
  /** 有值 = 编辑态；为空 = 新增态。 */
  editing: UpstreamKey | null;
  /** 预选上游（从上游页跳过来时用）。 */
  defaultUpstreamId?: string | undefined;
  onClose: () => void;
  onSaved: () => void;
}

export function KeyFormModal({
  open,
  upstreams,
  editing,
  defaultUpstreamId,
  onClose,
  onSaved,
}: KeyFormModalProps) {
  const [form] = Form.useForm<KeyFormValues>();
  const { run, isPending } = useAction();
  const editingId = editing?.id ?? null;

  useEffect(() => {
    if (!open) return;
    if (editing) {
      form.setFieldsValue({
        upstreamId: editing.upstreamId,
        key: '',
        category: editing.category,
        label: editing.label,
        weight: editing.weight,
        enabled: editing.enabled,
        planTokens: editing.tokenPlan?.remainingTokens ?? null,
        planExpiresAt: editing.tokenPlan?.expiresAt ?? null,
      });
    } else {
      form.resetFields();
      form.setFieldsValue({
        upstreamId: defaultUpstreamId ?? upstreams[0]?.id ?? '',
        category: 'balance',
        weight: 1,
        enabled: true,
      });
    }
  }, [open, editing, defaultUpstreamId, upstreams, form]);

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const category = values.category;

    const tokenPlan: TokenPlan | null =
      category === 'token-plan' && values.planTokens !== null && values.planTokens !== undefined
        ? { remainingTokens: values.planTokens, expiresAt: values.planExpiresAt ?? null }
        : null;

    const result = editingId
      ? await run(
          'save',
          () =>
            keysApi.update(editingId, {
              label: values.label,
              weight: values.weight,
              category,
              tokenPlan,
              revision: editing?.revision ?? 0,
            }),
          '已保存',
        )
      : await run(
          'save',
          () =>
            keysApi.create({
              upstreamId: values.upstreamId,
              key: values.key,
              category,
              label: values.label,
              weight: values.weight,
              ...(tokenPlan ? { tokenPlan } : {}),
            }),
          'Key 已创建（明文已加密落盘，此后只显示后 4 位）',
        );

    if (result === null) return;
    onSaved();
    onClose();
  };

  const isTokenPlan = Form.useWatch('category', form) === 'token-plan';

  return (
    <Modal
      open={open}
      title={editingId ? `编辑 Key · ${editing?.maskedKey ?? ''}` : '新增 Key'}
      okText={editingId ? '保存' : '创建'}
      cancelText="取消"
      confirmLoading={isPending('save')}
      onOk={() => {
        void submit();
      }}
      onCancel={onClose}
      destroyOnClose
      width={560}
    >
      <Form<KeyFormValues> form={form} layout="vertical" requiredMark="optional">
        {!editingId ? (
          <Form.Item
            name="key"
            label="API Key 明文"
            rules={[{ required: true, message: '请输入上游 key 明文' }]}
            extra="明文只在这一处进入系统，服务端立即 aes-256-gcm 加密落盘，之后任何响应都只回后 4 位。"
          >
            <Input.Password
              autoComplete="off"
              placeholder="sk-..."
              style={{ fontFamily: tokens.font.mono }}
            />
          </Form.Item>
        ) : (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: tokens.space.md }}
            message="明文不可回显"
            description={`当前 key：${editing?.maskedKey ?? ''}。如需更换明文，请删除后重新添加。`}
          />
        )}

        <Form.Item name="upstreamId" label="所属上游" rules={[{ required: true }]}>
          <Select
            disabled={Boolean(editingId)}
            placeholder="选择上游"
            options={upstreams.map((item) => ({ label: `${item.name} · ${item.baseUrl}`, value: item.id }))}
          />
        </Form.Item>

        <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
          <Form.Item name="category" label="分类" rules={[{ required: true }]} style={{ minWidth: 220 }}>
            <Segmented
              options={[
                { label: '余额类', value: 'balance' },
                { label: 'Token 套餐', value: 'token-plan' },
              ]}
            />
          </Form.Item>
          <Form.Item name="label" label="标签" style={{ flex: 1, minWidth: 200 }}>
            <Input placeholder="如 my88-主号-1" />
          </Form.Item>
          <Form.Item name="weight" label="权重">
            <InputNumber min={1} max={100} style={{ width: 88 }} />
          </Form.Item>
        </Space>

        {isTokenPlan ? (
          <Space size={tokens.space.md} style={{ display: 'flex' }}>
            <Form.Item name="planTokens" label="套餐剩余 token">
              <InputNumber min={0} style={{ width: 180 }} placeholder="如 5000000" />
            </Form.Item>
            <Form.Item name="planExpiresAt" label="到期时间（ISO8601 UTC）" style={{ flex: 1 }}>
              <Input placeholder="2026-12-31T00:00:00.000Z" />
            </Form.Item>
          </Space>
        ) : (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: tokens.space.md }}
            message="余额类 key 的金额请在列表里用「录入余额」填写（分），不要在这里编一个数。"
          />
        )}

        {editingId ? (
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );
}

// ── 手动录入余额 ──────────────────────────────────────────────────────────

interface BalanceFormValues {
  /** 以「元」录入，提交前换算成分（契约要求整数分）。 */
  yuan: number | null;
  currency: string;
  note: string;
}

export interface BalanceModalProps {
  open: boolean;
  target: UpstreamKey | null;
  onClose: () => void;
  onSaved: () => void;
}

export function BalanceModal({ open, target, onClose, onSaved }: BalanceModalProps) {
  const [form] = Form.useForm<BalanceFormValues>();
  const { run, isPending } = useAction();

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({
      yuan: target?.balance === null || target?.balance === undefined ? null : target.balance / 100,
      currency: target?.balanceCurrency ?? 'CNY',
      note: '',
    });
  }, [open, target, form]);

  const save = async (): Promise<void> => {
    if (!target) return;
    const values = await form.validateFields();
    if (values.yuan === null || values.yuan === undefined) {
      // 清空输入框不等于「未知」：未知有独立按钮，避免误操作把 0 当未知。
      form.setFields([{ name: 'yuan', errors: ['请输入金额；如要置为未知请点左下角「置为未知」'] }]);
      return;
    }
    const cents = Math.round(values.yuan * 100);
    const result = await run(
      'balance',
      () =>
        keysApi.upsertBalance(target.id, {
          balance: cents,
          currency: values.currency,
          ...(values.note ? { note: values.note } : {}),
        }),
      `余额已录入：${formatBalance(cents, values.currency)}（来源标记为手动）`,
    );
    if (result === null) return;
    onSaved();
    onClose();
  };

  const markUnknown = async (): Promise<void> => {
    if (!target) return;
    const result = await run(
      'unknown',
      () => keysApi.upsertBalance(target.id, { balance: null }),
      '已置为「未知」',
    );
    if (result === null) return;
    onSaved();
    onClose();
  };

  return (
    <Modal
      open={open}
      title={`录入余额 · ${target?.maskedKey ?? ''}`}
      okText="保存"
      cancelText="取消"
      confirmLoading={isPending('balance')}
      onOk={() => {
        void save();
      }}
      onCancel={onClose}
      destroyOnClose
      footer={(_, { OkBtn, CancelBtn }) => (
        <>
          <Typography.Link
            style={{ float: 'left', color: tokens.color.warning }}
            onClick={() => {
              void markUnknown();
            }}
          >
            置为未知（撤销误录）
          </Typography.Link>
          <CancelBtn />
          <OkBtn />
        </>
      )}
      width={480}
    >
      <Form<BalanceFormValues> form={form} layout="vertical">
        <Form.Item
          name="yuan"
          label="余额（元）"
          extra="提交时换算为「分」整数存库。录 0 就是 0，与「未知」是两个不同状态。"
        >
          <InputNumber
            min={0}
            step={1}
            style={{ width: '100%' }}
            placeholder="如 1234.50"
            addonAfter="元"
          />
        </Form.Item>
        <Form.Item name="currency" label="币种">
          <Input placeholder="CNY" />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input placeholder="如：客服核对 / 2026-10-06 手动校准" />
        </Form.Item>
        <Text type="secondary" style={{ fontSize: 12 }}>
          当前值：{formatBalance(target?.balance ?? null, target?.balanceCurrency ?? 'CNY')}
          {target?.balanceSource === 'template' ? '（由模板查询得到，手动录入后将被覆盖）' : ''}
        </Text>
      </Form>
    </Modal>
  );
}
