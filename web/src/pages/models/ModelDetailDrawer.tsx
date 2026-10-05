/**
 * 模型档案详情抽屉 —— 类型 / 支持能力 / 价格 / 可用 key。
 *
 * 契约纪律：
 * - 价格单位是**分 / 1k tokens**（契约 §0.2）。这里按「分」直接编辑，只额外给出「≈ ¥」预览，
 *   避免在输入侧做元↔分换算时引入浮点误差；写出去的永远是整数分。
 * - `price: null` = 上游没给价格，**不是 0**。用独立开关表达，不让「清空输入框」被读成 0。
 * - `availableKeyIds` 是后端按「启用 + 非冷却 + 余额 > 0」算好的，与 `/v1/models` 口径同源。
 *   前端不再自己筛 key，只做 id → 掩码的展示映射。
 * - 写请求带 `revision`；409 时提示并让调用方重拉。
 */
import {
  Alert,
  Button,
  Drawer,
  Form,
  Input,
  InputNumber,
  Segmented,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useEffect } from 'react';

import { modelsApi } from '@/api/endpoints';
import { useAction } from '@/api/hooks';
import type { ModelCapability, ModelProfile, ModelType } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCount, formatIso } from '@/utils/format';

const { Text } = Typography;

const TYPE_OPTIONS: readonly { label: string; value: ModelType }[] = [
  { label: '对话', value: 'chat' },
  { label: '向量', value: 'embedding' },
  { label: '图像', value: 'image' },
  { label: '语音', value: 'audio' },
  { label: '重排', value: 'rerank' },
];

const CAPABILITY_OPTIONS: readonly { label: string; value: ModelCapability }[] = [
  { label: '流式', value: 'stream' },
  { label: '函数调用', value: 'function_call' },
  { label: '视觉', value: 'vision' },
  { label: 'JSON 模式', value: 'json_mode' },
];

interface ModelFormValues {
  displayName: string;
  type: ModelType;
  capabilities: ModelCapability[];
  contextLength: number | null;
  priceUnknown: boolean;
  inputPer1k: number | null;
  outputPer1k: number | null;
  enabled: boolean;
}

export interface ModelDetailDrawerProps {
  open: boolean;
  model: ModelProfile | null;
  /** keyId → 掩码，来自 `/api/keys` 列表；查不到时退回显示 id。 */
  keyLabel: (keyId: string) => string;
  onClose: () => void;
  onSaved: () => void;
}

export function ModelDetailDrawer({
  open,
  model,
  keyLabel,
  onClose,
  onSaved,
}: ModelDetailDrawerProps) {
  const [form] = Form.useForm<ModelFormValues>();
  const { run, isPending } = useAction();

  useEffect(() => {
    if (!open || !model) return;
    form.resetFields();
    form.setFieldsValue({
      displayName: model.displayName,
      type: model.type,
      capabilities: model.capabilities,
      contextLength: model.contextLength,
      priceUnknown: model.price === null,
      inputPer1k: model.price?.inputPer1k ?? null,
      outputPer1k: model.price?.outputPer1k ?? null,
      enabled: model.enabled,
    });
  }, [open, model, form]);

  // 两个 watch 必须在组件顶层无条件调用（hooks 规则），不能塞进渲染分支里。
  const priceUnknown = Form.useWatch('priceUnknown', form) ?? false;
  const inputPer1k = Form.useWatch('inputPer1k', form);

  const submit = async (): Promise<void> => {
    if (!model) return;
    const values = await form.validateFields();

    const price = values.priceUnknown
      ? null
      : {
          inputPer1k: values.inputPer1k ?? 0,
          outputPer1k: values.outputPer1k ?? 0,
        };

    const result = await run(
      'save',
      () =>
        modelsApi.update(model.id, {
          displayName: values.displayName,
          type: values.type,
          capabilities: values.capabilities,
          contextLength: values.contextLength,
          price,
          enabled: values.enabled,
          revision: model.revision,
        }),
      '已保存',
    );

    if (result === null) {
      // 乐观锁冲突 / 校验失败：拉最新，别让管理员对着旧 revision 反复提交。
      onSaved();
      return;
    }
    onSaved();
    onClose();
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={520}
      destroyOnClose
      title={model ? `模型档案 · ${model.displayName}` : '模型档案'}
      extra={
        <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>
          {model?.name ?? ''}
        </Text>
      }
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              loading={isPending('save')}
              disabled={model === null}
              onClick={() => {
                void submit();
              }}
            >
              保存
            </Button>
          </Space>
        </div>
      }
    >
      {model === null ? null : (
        <>
          <Form<ModelFormValues> form={form} layout="vertical" requiredMark="optional">
            <Form.Item
              name="displayName"
              label="展示名"
              rules={[{ required: true, message: '请输入展示名' }]}
            >
              <Input />
            </Form.Item>

            <Form.Item name="type" label="类型">
              <Segmented options={TYPE_OPTIONS.map((item) => ({ label: item.label, value: item.value }))} />
            </Form.Item>

            <Form.Item name="capabilities" label="支持能力">
              <Select
                mode="multiple"
                allowClear
                placeholder="未声明"
                options={CAPABILITY_OPTIONS.map((item) => ({ label: item.label, value: item.value }))}
              />
            </Form.Item>

            <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
              <Form.Item name="contextLength" label="上下文长度 (tokens)" style={{ flex: 1 }}>
                <InputNumber min={0} step={1024} style={{ width: '100%' }} placeholder="上游未提供" />
              </Form.Item>
              <Form.Item name="enabled" label="启用" valuePropName="checked">
                <Switch />
              </Form.Item>
            </Space>

            <Form.Item
              name="priceUnknown"
              label="价格"
              valuePropName="checked"
              extra="打开 = price 写为 null（上游未提供）。null 与 0 是两个值，账单口径不会当成免费。"
            >
              <Switch checkedChildren="未知" unCheckedChildren="填写" />
            </Form.Item>

            {priceUnknown ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: tokens.space.md }}
                message="价格将保存为未知（null）"
                description="成本统计不会把未知价格当 0 累加；需要精确成本时请填入真实单价。"
              />
            ) : (
              <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
                <Form.Item
                  name="inputPer1k"
                  label="输入价（分 / 1k）"
                  style={{ flex: 1 }}
                  rules={[{ required: true, message: '填写输入价，或把价格标为未知' }]}
                  extra={
                    inputPer1k === null || inputPer1k === undefined
                      ? '单位：分'
                      : `≈ ${formatCents(inputPer1k)} / 1k tokens`
                  }
                >
                  <InputNumber min={0} step={1} style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item
                  name="outputPer1k"
                  label="输出价（分 / 1k）"
                  style={{ flex: 1 }}
                  rules={[{ required: true, message: '填写输出价，或把价格标为未知' }]}
                  extra="单位：分"
                >
                  <InputNumber min={0} step={1} style={{ width: '100%' }} />
                </Form.Item>
              </Space>
            )}
          </Form>

          <div
            style={{
              borderTop: `1px solid ${tokens.color.border}`,
              paddingTop: tokens.space.md,
              marginTop: tokens.space.sm,
            }}
          >
            <Text type="secondary" style={{ fontSize: 12 }}>
              上游 {model.upstreamId}
              {model.contextLength !== null ? ` · 上下文 ${formatCount(model.contextLength)} tokens` : ''}
              {` · 最近同步 ${formatIso(model.lastSyncedAt)}`}
              {` · 更新 ${formatIso(model.updatedAt)}`}
            </Text>

            <div style={{ marginTop: tokens.space.md }}>
              <Space size={tokens.space.sm}>
                <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>可用 key</Text>
                <Text type="secondary" style={{ fontSize: 11 }}>
                  由后端按「启用 + 非冷却 + 余额 &gt; 0」计算，与 /v1/models 同源
                </Text>
              </Space>
              <div style={{ marginTop: tokens.space.sm }}>
                {model.availableKeyIds.length === 0 ? (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    暂无可服务的 key（全部冷却、禁用或余额不足）——此时该模型不会出现在 /v1/models
                  </Text>
                ) : (
                  <Space size={[6, 6]} wrap>
                    {model.availableKeyIds.map((id) => (
                      <Tag
                        key={id}
                        bordered={false}
                        style={{
                          fontFamily: tokens.font.mono,
                          background: tokens.tint.success,
                          color: tokens.color.success,
                        }}
                      >
                        {keyLabel(id)}
                      </Tag>
                    ))}
                  </Space>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </Drawer>
  );
}
