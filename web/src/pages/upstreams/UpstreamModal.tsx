/**
 * 上游新增 / 编辑弹窗，含余额查询模板编辑器。
 *
 * 契约 §2 的两点硬要求：
 * - `baseUrl` 必须 `http(s)://` 且无尾斜杠（根路径除外），不合法直接 400 —— 这里前置校验，少一次往返。
 * - `headers` 里的 `{key}` 是**占位符**。页面上只编辑模板文本，永远不出现替换后的串，
 *   也不显示任何上游凭据。
 */
import { Alert, Form, Input, InputNumber, Modal, Segmented, Space, Switch, Typography } from 'antd';
import { useEffect } from 'react';

import { upstreamsApi } from '@/api/endpoints';
import { useAction } from '@/api/hooks';
import type { BalanceQueryTemplate, Upstream } from '@/api/types';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

interface UpstreamFormValues {
  name: string;
  baseUrl: string;
  enabled: boolean;
  queryEnabled: boolean;
  queryUrl: string;
  queryMethod: 'GET' | 'POST';
  headersJson: string;
  body: string;
  parseBalance: string;
  parseCurrency: string;
  parseRemainingTokens: string;
  parseExpiresAt: string;
  unit: 'yuan' | 'cents' | 'dollar';
  timeoutMs: number;
}

const DEFAULT_TEMPLATE: BalanceQueryTemplate = {
  enabled: false,
  url: '',
  method: 'GET',
  headers: { Authorization: 'Bearer {key}' },
  body: null,
  parse: {
    balance: 'data.balance',
    currency: null,
    remainingTokens: null,
    expiresAt: null,
    unit: 'yuan',
  },
  timeoutMs: 5000,
};

function toFormValues(upstream: Upstream | null): Partial<UpstreamFormValues> {
  if (!upstream) {
    return {
      enabled: true,
      queryEnabled: false,
      queryMethod: 'GET',
      headersJson: JSON.stringify(DEFAULT_TEMPLATE.headers, null, 2),
      unit: DEFAULT_TEMPLATE.parse.unit,
      timeoutMs: DEFAULT_TEMPLATE.timeoutMs,
      parseBalance: DEFAULT_TEMPLATE.parse.balance,
    };
  }

  const template = upstream.balanceQuery ?? DEFAULT_TEMPLATE;
  return {
    name: upstream.name,
    baseUrl: upstream.baseUrl,
    enabled: upstream.enabled,
    queryEnabled: template.enabled,
    queryUrl: template.url,
    queryMethod: template.method,
    headersJson: JSON.stringify(template.headers, null, 2),
    body: template.body ?? '',
    parseBalance: template.parse.balance,
    parseCurrency: template.parse.currency ?? '',
    parseRemainingTokens: template.parse.remainingTokens ?? '',
    parseExpiresAt: template.parse.expiresAt ?? '',
    unit: template.parse.unit,
    timeoutMs: template.timeoutMs,
  };
}

export interface UpstreamModalProps {
  open: boolean;
  editing: Upstream | null;
  onClose: () => void;
  onSaved: () => void;
}

export function UpstreamModal({ open, editing, onClose, onSaved }: UpstreamModalProps) {
  const [form] = Form.useForm<UpstreamFormValues>();
  const { run, isPending } = useAction();

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(toFormValues(editing));
  }, [open, editing, form]);

  const queryEnabled = Form.useWatch('queryEnabled', form) ?? false;
  const method = Form.useWatch('queryMethod', form) ?? 'GET';

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();

    let headers: Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(values.headersJson || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        form.setFields([{ name: 'headersJson', errors: ['必须是 JSON 对象，如 {"Authorization":"Bearer {key}"}'] }]);
        return;
      }
      headers = parsed as Record<string, string>;
    } catch {
      form.setFields([{ name: 'headersJson', errors: ['JSON 解析失败'] }]);
      return;
    }

    const balanceQuery: BalanceQueryTemplate = {
      enabled: values.queryEnabled,
      url: values.queryUrl ?? '',
      method: values.queryMethod,
      headers,
      body: values.body ? values.body : null,
      parse: {
        balance: values.parseBalance ?? '',
        currency: values.parseCurrency ? values.parseCurrency : null,
        remainingTokens: values.parseRemainingTokens ? values.parseRemainingTokens : null,
        expiresAt: values.parseExpiresAt ? values.parseExpiresAt : null,
        unit: values.unit,
      },
      timeoutMs: values.timeoutMs,
    };

    const result = editing
      ? await run(
          'save',
          () =>
            upstreamsApi.update(editing.id, {
              name: values.name,
              baseUrl: values.baseUrl,
              enabled: values.enabled,
              balanceQuery,
              revision: editing.revision,
            }),
          '已保存',
        )
      : await run(
          'save',
          () =>
            upstreamsApi.create({
              name: values.name,
              baseUrl: values.baseUrl,
              enabled: values.enabled,
              balanceQuery,
            }),
          '上游已创建',
        );

    if (result === null) return;
    onSaved();
    onClose();
  };

  return (
    <Modal
      open={open}
      title={editing ? `编辑上游 · ${editing.name}` : '新增上游'}
      okText={editing ? '保存' : '创建'}
      cancelText="取消"
      confirmLoading={isPending('save')}
      onOk={() => {
        void submit();
      }}
      onCancel={onClose}
      destroyOnClose
      width={680}
    >
      <Form<UpstreamFormValues> form={form} layout="vertical" requiredMark="optional">
        <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如 my88" style={{ width: 200 }} />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label="Base URL"
            style={{ flex: 1 }}
            rules={[
              { required: true, message: '请输入 Base URL' },
              {
                validator: (_rule, value: string) => {
                  if (!value) return Promise.resolve();
                  // 契约：必须 http(s)://，且无尾斜杠（根路径除外）。
                  if (!/^https?:\/\//.test(value)) {
                    return Promise.reject(new Error('必须以 http:// 或 https:// 开头'));
                  }
                  const path = value.replace(/^https?:\/\/[^/]+/, '');
                  if (path !== '' && path.endsWith('/')) {
                    return Promise.reject(new Error('不能以 / 结尾（根路径除外）'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="https://api.example.com" style={{ fontFamily: tokens.font.mono }} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Space>

        <Form.Item
          name="queryEnabled"
          label="余额查询模板"
          valuePropName="checked"
          extra="关闭时该上游只能手动录入余额（契约 §2：balanceQuery.enabled=false）。"
        >
          <Switch />
        </Form.Item>

        {queryEnabled ? (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: tokens.space.md }}
              message="占位符 {key} 在执行时才被替换"
              description="替换后的字符串永不落盘、永不进日志、永不回显。这里编辑的是模板原文。"
            />
            <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
              <Form.Item
                name="queryMethod"
                label="方法"
                initialValue="GET"
                style={{ width: 120 }}
              >
                <Segmented options={['GET', 'POST']} />
              </Form.Item>
              <Form.Item name="queryUrl" label="URL" style={{ flex: 1 }}>
                <Input placeholder="https://api.example.com/user/balance" style={{ fontFamily: tokens.font.mono }} />
              </Form.Item>
              <Form.Item name="timeoutMs" label="超时 (ms)">
                <InputNumber min={500} max={30000} step={500} style={{ width: 110 }} />
              </Form.Item>
            </Space>

            <Form.Item
              name="headersJson"
              label="请求头（JSON）"
              extra='示例：{"Authorization": "Bearer {key}"}'
            >
              <Input.TextArea rows={3} style={{ fontFamily: tokens.font.mono }} />
            </Form.Item>

            {method === 'POST' ? (
              <Form.Item name="body" label="请求体">
                <Input.TextArea rows={3} style={{ fontFamily: tokens.font.mono }} placeholder='{"key": "{key}"}' />
              </Form.Item>
            ) : null}

            <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
              <Form.Item
                name="parseBalance"
                label="余额取值路径"
                style={{ flex: 1 }}
                rules={[{ required: true, message: '给出余额字段路径' }]}
              >
                <Input placeholder="data.balance_infos[0].total_balance" style={{ fontFamily: tokens.font.mono }} />
              </Form.Item>
              <Form.Item name="unit" label="上游单位" style={{ width: 160 }}>
                <Segmented
                  options={[
                    { label: '元', value: 'yuan' },
                    { label: '分', value: 'cents' },
                    { label: '美元', value: 'dollar' },
                  ]}
                />
              </Form.Item>
            </Space>

            <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
              <Form.Item name="parseCurrency" label="币种路径（可选）" style={{ flex: 1 }}>
                <Input placeholder="data.currency" style={{ fontFamily: tokens.font.mono }} />
              </Form.Item>
              <Form.Item name="parseRemainingTokens" label="套餐余量路径（可选）" style={{ flex: 1 }}>
                <Input placeholder="data.remaining_tokens" style={{ fontFamily: tokens.font.mono }} />
              </Form.Item>
              <Form.Item name="parseExpiresAt" label="到期时间路径（可选）" style={{ flex: 1 }}>
                <Input placeholder="data.expires_at" style={{ fontFamily: tokens.font.mono }} />
              </Form.Item>
            </Space>

            <Text type="secondary" style={{ fontSize: 12 }}>
              单位换算到「分」由后端负责；前端只负责把模板原样存下去。
            </Text>
          </>
        ) : null}
      </Form>
    </Modal>
  );
}
