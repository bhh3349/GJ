/**
 * 上游新增 / 编辑弹窗，含余额查询模板编辑器。
 *
 * 契约 §2 的两点硬要求：
 * - `baseUrl` 必须 `http(s)://` 且无尾斜杠（根路径除外），不合法直接 400 —— 这里前置校验，少一次往返。
 * - `headers` 里的 `{key}` 是**占位符**。页面上只编辑模板文本，永远不出现替换后的串，
 *   也不显示任何上游凭据。
 *
 * §15.6 的「供应商」下拉（本期唯一动到本表单的地方）：
 * - `supplier` **可写**（`null` | `'tierflow'`，默认 `null`），且**建与改两条路径都要发** ——
 *   只加在下拉上而漏进 body，会变成一个"选得动、不生效"的控件，比没有这个控件更难查。
 * - 表单值是 `'common' | 'tierflow'` 这个**展示枚举**，只在提交那一刻映射成 `null | 'tierflow'`。
 *   不让 `null` 直接当控件值，是因为 antd 的 `Select` 把 `null` 与"没选"当同一件事。
 * - `PATCH` 的判据是 `!== undefined` 而不是真值判断 ⇒ **必须显式发 `null`** 才能降回通用；
 *   省略这个字段是"不改"。这两者必须分得开（§2）。
 * - 不解析 `baseUrl` 猜供应商（§15.6）：猜错会静默渲染出一个功能全 422 的分区。
 * - 降回通用**没有** `force`、没有 409（与退役出口的 `EGRESS_HAS_ACCOUNTS` 不同）：
 *   后端只改这一列、不级联删账号。所以这里用一条就地警告说清代价，而不是假装弹个确认框。
 */
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Space,
  Switch,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';

import { upstreamsApi } from '@/api/endpoints';
import { useAction } from '@/api/hooks';
import type {
  BalanceQueryTemplate,
  BalanceTestTemplate,
  SupplierKind,
  Upstream,
} from '@/api/types';
import { tokens } from '@/theme/tokens';
import { BalanceSelfTest } from './BalanceSelfTest';

const { Text } = Typography;

/** 表单里的展示枚举。`'common'` 提交时映射为 `supplier: null`（§15.6 默认值）。 */
type SupplierFormValue = 'common' | 'tierflow';

const SUPPLIER_OPTIONS: { value: SupplierFormValue; label: string }[] = [
  { value: 'common', label: '通用（无账号面）' },
  { value: 'tierflow', label: 'TierFlow（供应商账号面）' },
];

interface UpstreamFormValues {
  name: string;
  baseUrl: string;
  supplier: SupplierFormValue;
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
      supplier: 'common',
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
    // 判据只有一条：`supplier === 'tierflow'`（§15.12 锚 1）。不是 tierflow 就是通用，
    // 包括 `null` 与将来可能出现的第二个供应商值 —— 落到「通用」比落到某个具体值是更诚实的缺省。
    supplier: upstream.supplier === 'tierflow' ? 'tierflow' : 'common',
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
  const [selfTestOpen, setSelfTestOpen] = useState(false);
  const [selfTestDraft, setSelfTestDraft] = useState<BalanceTestTemplate | null>(null);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(toFormValues(editing));
  }, [open, editing, form]);

  const queryEnabled = Form.useWatch('queryEnabled', form) ?? false;
  const method = Form.useWatch('queryMethod', form) ?? 'GET';
  const supplier = Form.useWatch('supplier', form) ?? 'common';

  /** 把主表单当前的模板字段快照成一份草稿（best-effort，headers 解析失败则空对象），交给自测抽屉。 */
  const openSelfTest = (): void => {
    const values = form.getFieldsValue(true) as Partial<UpstreamFormValues>;
    let headers: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(values.headersJson || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        headers = parsed as Record<string, string>;
      }
    } catch {
      /* 快照仅作草稿起点，解析失败按空对象处理 */
    }
    setSelfTestDraft({
      url: values.queryUrl ?? '',
      method: values.queryMethod ?? 'GET',
      headers,
      body: values.body ? values.body : null,
      parse: {
        balance: values.parseBalance ?? '',
        currency: values.parseCurrency ? values.parseCurrency : null,
        remainingTokens: values.parseRemainingTokens ? values.parseRemainingTokens : null,
        expiresAt: values.parseExpiresAt ? values.parseExpiresAt : null,
        unit: values.unit ?? 'yuan',
      },
      timeoutMs: values.timeoutMs ?? 5000,
    });
    setSelfTestOpen(true);
  };

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

    // 展示枚举 → 契约取值。`null` 是**显式降回通用**，不是"没填"（§2 / §15.6）。
    const supplierValue: SupplierKind | null = values.supplier === 'tierflow' ? 'tierflow' : null;

    const result = editing
      ? await run(
          'save',
          () =>
            upstreamsApi.update(editing.id, {
              name: values.name,
              baseUrl: values.baseUrl,
              supplier: supplierValue,
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
              supplier: supplierValue,
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
    <>
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

          {/*
            契约 §15.6：建/改上游表单里**唯一**多出来的控件。默认「通用」= `supplier: null`。
            这里刻意不做「按 Base URL 自动选中」—— 那正是 §15.6 禁止的猜测。
          */}
          <Form.Item
            name="supplier"
            label="供应商"
            extra="账号面判据只有这一个字段（§15.6 / §15.12）：选定 TierFlow 后，该上游才出现账号池入口。前端不解析 Base URL 猜供应商。"
            style={{ maxWidth: 360 }}
          >
            <Select<SupplierFormValue> options={SUPPLIER_OPTIONS} />
          </Form.Item>

          {/*
            降回通用：后端不拦（没有 409、也没有 `force`），只把这一列写成 NULL。
            所以代价必须在这里说清 —— 入口会消失，但账号数据还在；否则管理员会以为
            这个动作要么被拒绝、要么连账号一起清了。
          */}
          {editing?.supplier === 'tierflow' && supplier !== 'tierflow' ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: tokens.space.md, background: tokens.tint.warning, border: 'none' }}
              message="改回「通用」后，这个上游的账号池入口会消失"
              description={
                <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                  这个动作只写这一个字段，不会级联删除账号
                  {editing.accountCount > 0 ? `（当前名下有 ${editing.accountCount} 个账号，它们会保留）` : ''}
                  ；但管理面上不再显示账号池入口，直到把「供应商」改回 TierFlow。
                </Text>
              }
            />
          ) : null}

          <Form.Item
            name="queryEnabled"
            label="余额查询模板"
            valuePropName="checked"
            extra="关闭时该上游只能手动录入余额（契约 §2：balanceQuery.enabled=false）。"
          >
            <Switch />
          </Form.Item>

          {editing?.balancePreset ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: tokens.space.md }}
              message={`已自动识别为「${editing.balancePreset.label}」`}
              description={
                editing.balancePreset.effective
                  ? '当前生效：不配模板也能自动查询余额。'
                  : '但当前已启用用户模板，将优先使用用户模板。'
              }
            />
          ) : null}

          {editing ? (
            <Button size="small" style={{ marginBottom: tokens.space.md }} onClick={openSelfTest}>
              自测余额查询
            </Button>
          ) : null}

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

      <BalanceSelfTest
        open={selfTestOpen}
        upstreamId={editing?.id ?? ''}
        initial={selfTestDraft}
        onClose={() => setSelfTestOpen(false)}
      />
    </>
  );
}
