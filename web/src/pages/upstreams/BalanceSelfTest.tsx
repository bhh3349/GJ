/**
 * 余额自测抽屉 —— 用「草稿模板」打一次真实查询（契约 §2 / ADR-0012 §3）。
 *
 * 语义要点：
 * - 草稿是**独立副本**，改这里不影响主表单；自测**不写库**（预览语义）。
 * - 请求 200 + `ok:false` 是业务性失败，**不是**请求错误，所以不走 `useAction`，
 *   而是直接调 API、把 `BalanceTestResult` 存进本地 state 交给 `BalanceTestResultView` 渲染。
 * - 响应 `raw` 帮用户定位「该填哪条取值路径」。
 */
import { Divider, Form, Input, InputNumber, Modal, Segmented, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { keysApi, upstreamsApi } from '@/api/endpoints';
import { describeError } from '@/api/http';
import {
  PAGE_SIZE_MAX,
  type BalanceTemplateTestRequest,
  type BalanceTestResult,
  type BalanceTestTemplate,
  type UpstreamKey,
} from '@/api/types';
import { BalanceTestResultView } from '@/components/BalanceTestResultView';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

interface DraftFormValues {
  keyId?: string;
  url: string;
  method: 'GET' | 'POST';
  headersJson: string;
  body: string;
  parseBalance: string;
  parseCurrency: string;
  parseRemainingTokens: string;
  parseExpiresAt: string;
  unit: 'yuan' | 'cents' | 'dollar';
  timeoutMs: number;
}

function toDraftValues(template: BalanceTestTemplate | null): Partial<DraftFormValues> {
  if (!template) {
    return { method: 'GET', headersJson: '{}', unit: 'yuan', timeoutMs: 5000 };
  }
  return {
    url: template.url,
    method: template.method,
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

export interface BalanceSelfTestProps {
  open: boolean;
  upstreamId: string;
  /** 主表单当前模板（作为草稿的起点）；没有模板时给 null。 */
  initial: BalanceTestTemplate | null;
  onClose: () => void;
}

export function BalanceSelfTest({ open, upstreamId, initial, onClose }: BalanceSelfTestProps) {
  const [form] = Form.useForm<DraftFormValues>();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<BalanceTestResult | null>(null);
  const [keys, setKeys] = useState<UpstreamKey[]>([]);

  const method = Form.useWatch('method', form) ?? 'GET';

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(toDraftValues(initial));
    setResult(null);
  }, [open, initial, form]);

  useEffect(() => {
    if (!open || !upstreamId) return;
    let active = true;
    keysApi
      .list({ upstreamId, category: 'balance', enabled: true, pageSize: PAGE_SIZE_MAX })
      .then((page) => {
        if (active) setKeys(page.items);
      })
      .catch(() => {
        // 拉不到 key 清单不阻断自测：选择器留空，仍可「自动」。
        if (active) setKeys([]);
      });
    return () => {
      active = false;
    };
  }, [open, upstreamId]);

  const buildDraft = async (): Promise<BalanceTemplateTestRequest | null> => {
    const values = await form.validateFields();

    let headers: Record<string, string>;
    try {
      const parsed: unknown = JSON.parse(values.headersJson || '{}');
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        form.setFields([{ name: 'headersJson', errors: ['必须是 JSON 对象'] }]);
        return null;
      }
      headers = parsed as Record<string, string>;
    } catch {
      form.setFields([{ name: 'headersJson', errors: ['JSON 解析失败'] }]);
      return null;
    }

    const draft: BalanceTemplateTestRequest = {
      url: values.url ?? '',
      method: values.method,
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
    return values.keyId ? { ...draft, keyId: values.keyId } : draft;
  };

  const runTest = async (): Promise<void> => {
    const draft = await buildDraft();
    if (!draft) return;

    setTesting(true);
    try {
      const res = await upstreamsApi.testBalanceTemplate(upstreamId, draft);
      setResult(res);
    } catch (error: unknown) {
      const { code, message } = describeError(error);
      // 只有真正的请求/校验失败才进这里（422 无查询方式、400 参数非法等）。
      setResult(null);
      Modal.error({ title: '自测请求失败', content: `${message} [${code}]` });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="余额自测"
      okText="测试"
      cancelText="关闭"
      confirmLoading={testing}
      onOk={() => {
        void runTest();
      }}
      onCancel={onClose}
      destroyOnClose
      width={760}
    >
      <Text type="secondary" style={{ fontSize: 12 }}>
        用下面的草稿打一次真实查询，**不会写库**。改字段路径后点「测试」，用原始响应定位该填哪条路径。
      </Text>

      <Form<DraftFormValues> form={form} layout="vertical" style={{ marginTop: tokens.space.md }}>
        <Form.Item name="keyId" label="测试用 Key" style={{ width: 320 }}>
          <Select
            allowClear
            placeholder="自动（第一把可用余额 key）"
            options={keys.map((k) => ({
              label: k.label ? `${k.label} · ${k.maskedKey}` : k.maskedKey,
              value: k.id,
            }))}
          />
        </Form.Item>

        <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
          <Form.Item name="method" label="方法" style={{ width: 120 }}>
            <Segmented options={['GET', 'POST']} />
          </Form.Item>
          <Form.Item name="url" label="URL" style={{ flex: 1 }}>
            <Input placeholder="https://api.example.com/user/balance" style={{ fontFamily: tokens.font.mono }} />
          </Form.Item>
          <Form.Item name="timeoutMs" label="超时 (ms)">
            <InputNumber min={500} max={30000} step={500} style={{ width: 110 }} />
          </Form.Item>
        </Space>

        <Form.Item name="headersJson" label="请求头（JSON）" extra='占位符 {key} 只在执行时替换'>
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
      </Form>

      {result ? (
        <>
          <Divider style={{ margin: `${tokens.space.md}px 0` }} />
          <BalanceTestResultView result={result} />
        </>
      ) : null}
    </Modal>
  );
}
