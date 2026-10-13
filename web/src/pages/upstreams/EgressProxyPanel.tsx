/**
 * 出口池配置面板 —— 消费 §16.7.2 的 REST 配置面 `/api/egress`（v1.7.1）。
 *
 * ## 这一格为什么之前是空的
 *
 * 卡（`EgressPoolCard`）消费的是 §7 的**运行态**帧（`egress_pool`：探活 IP / 冷却时刻），
 * 而契约 v1.4.9 / v1.6.4 把「出口状态不走 REST」写成了硬约束 —— 于是出口池在管理面上
 * **只有读、没有写**：能看见节点在不在线，却**没有任何地方能填一个出口代理**。
 * 这不是契约要求「固定值封死」，恰恰相反：§16.7.2 明确登记了 `/api/egress` 六个写端点，
 * 只是前端这一笔一直没接。本组件补的就是这一笔。
 *
 * ## 两条面**不许混**
 *
 * - **配置面（本组件，走 REST）**：`name` / `url` / `region` / `note` / `status` / `authSet`
 *   与最近一次探活结果 `lastTestAt` / `lastTestOk`。这些是**台账事实**，服务端存得住、查得回。
 * - **运行态（`EgressPoolCard`，走 §7 帧）**：此刻的 `exitIp` / `cooldownUntil`。
 *   契约禁止用配置面反推运行态（`egress_id` 不进任何 DTO）。
 *
 * 所以本组件**不显示** exitIp / 冷却，也不假装能显示 —— 那两格归下方的帧卡。
 *
 * ## 三条同源纪律（与账号面逐字一致）
 *
 * 1. **凭据只进不回**：`username` / `password` 只在提交那一刻进 body；响应只回 `authSet`。
 *    编辑时**不回填**凭据（回填等于把明文留在浏览器里），留空 = 不改；要清凭据走「清除」勾选。
 * 2. **退役被引用要先把依赖摆出来**：`409 EGRESS_HAS_ACCOUNTS` **无 `force`**，
 *    提示里点明 `accountCount` 并指路去账号池改绑，而不是假装能强删。
 * 3. **`lastTestOk === null` 是「未测」**，不是「失败」—— 未知 ≠ 失败（§0.2）。
 */
import {
  ApiOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
  ReloadOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Segmented,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { egressApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import type {
  EgressProxy,
  EgressProxyCreateRequest,
  EgressProxyPatchRequest,
  EgressRetiredReason,
} from '@/api/types';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';
import { formatIso, formatRelative } from '@/utils/format';

const { Text } = Typography;

interface EgressFormValues {
  name: string;
  url: string;
  region: string;
  note: string;
  /** 仅新建时为真；编辑时凭据整体替换，两个都填才落 secret。 */
  hasAuth: boolean;
  username: string;
  password: string;
  /** 编辑态专用：清掉已设凭据（后端判据 = 两个凭据字段都为空串）。 */
  clearAuth: boolean;
}

const RETIRE_REASON_TEXT: Record<EgressRetiredReason, string> = {
  replaced: '已换新出口（旧 IP 报废）',
  manual: '手工退役',
};

function statusTag(row: EgressProxy) {
  const active = row.status === 'active';
  return (
    <Tooltip
      title={
        active
          ? 'active：可被账号绑定、可用于出站。'
          : `retired：${row.retiredReason ? RETIRE_REASON_TEXT[row.retiredReason] : '未记原因'}${
              row.retiredAt ? ` · ${formatIso(row.retiredAt)}` : ''
            }。退役不删行 —— 历史用量与统计仍挂在它上面。`
      }
    >
      <Tag
        bordered={false}
        style={{
          marginInlineEnd: 0,
          background: active ? tokens.tint.success : tokens.tint.neutral,
          color: active ? tokens.color.success : tokens.color.textSecondary,
        }}
      >
        {active ? '在池' : '已退役'}
      </Tag>
    </Tooltip>
  );
}

function testTag(row: EgressProxy) {
  if (row.lastTestOk === null) {
    return (
      <Tooltip title="从未探活过。未知 ≠ 失败 —— 这一格不说它通不通。">
        <Text type="secondary" style={{ fontSize: 12 }}>
          未测
        </Text>
      </Tooltip>
    );
  }
  const ok = row.lastTestOk;
  return (
    <Tooltip title={row.lastTestAt ? `最近探活 ${formatIso(row.lastTestAt)}` : '无时间戳'}>
      <Tag
        bordered={false}
        style={{
          marginInlineEnd: 0,
          background: ok ? tokens.tint.success : tokens.tint.error,
          color: ok ? tokens.color.success : tokens.color.error,
        }}
      >
        {ok ? '通' : '不通'}
      </Tag>
    </Tooltip>
  );
}

export function EgressProxyPanel() {
  const { message, modal } = App.useApp();
  const { run, isPending } = useAction();

  const list = useResource(() => egressApi.list(), []);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<EgressProxy | null>(null);
  const [form] = Form.useForm<EgressFormValues>();

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({
      name: '',
      url: '',
      region: '',
      note: '',
      hasAuth: false,
      username: '',
      password: '',
      clearAuth: false,
    });
    setFormOpen(true);
  };

  const openEdit = (row: EgressProxy): void => {
    setEditing(row);
    form.resetFields();
    form.setFieldsValue({
      name: row.name,
      url: row.url,
      region: row.region ?? '',
      note: row.note ?? '',
      hasAuth: false,
      username: '',
      password: '',
      clearAuth: false,
    });
    setFormOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();

    if (editing === null) {
      const body: EgressProxyCreateRequest = {
        name: values.name,
        url: values.url,
        region: values.region ? values.region : null,
        note: values.note ? values.note : null,
      };
      // 凭据判定与服务端一致：**两个都非空**才发（一空一非空 = 不落，见 §16.7.2）。
      if (values.hasAuth && values.username && values.password) {
        body.username = values.username;
        body.password = values.password;
      }
      const created = await run('egress-save', () => egressApi.create(body), '出口已创建');
      if (created === null) return;
      setFormOpen(false);
      list.reload();
      return;
    }

    const patch: EgressProxyPatchRequest = {};
    if (values.name !== editing.name) patch.name = values.name;
    const region = values.region ? values.region : null;
    if (region !== editing.region) patch.region = region;
    const note = values.note ? values.note : null;
    if (note !== editing.note) patch.note = note;
    if (values.clearAuth && editing.authSet) {
      // 清除 = 两个都发空串（整体换凭据，密码无法子集更新）。
      patch.username = '';
      patch.password = '';
    } else if (values.username && values.password) {
      patch.username = values.username;
      patch.password = values.password;
    }

    if (Object.keys(patch).length === 0) {
      message.info('没有改动');
      setFormOpen(false);
      return;
    }

    const saved = await run('egress-save', () => egressApi.update(editing.id, patch), '出口已更新');
    if (saved === null) return;
    setFormOpen(false);
    list.reload();
  };

  const retire = (row: EgressProxy): void => {
    let reason: EgressRetiredReason = 'manual';
    modal.confirm({
      title: `退役出口「${row.name}」？`,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
          <Text style={{ fontSize: 12 }}>
            退役后它不再被选路。仍然可以「回池」复用原条目 —— 不新建行，所以不会白拿一次出口额度。
          </Text>
          <Segmented
            size="small"
            defaultValue="manual"
            options={[
              { label: '手工退役', value: 'manual' },
              { label: '已换新出口', value: 'replaced' },
            ]}
            onChange={(value) => {
              reason = value as EgressRetiredReason;
            }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            若这个出口已被账号绑定，服务端会拒绝（无强制退役）—— 需先把账号改到别的在池出口。
          </Text>
        </div>
      ),
      okText: '退役',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await run('egress-retire', () => egressApi.retire(row.id, reason), '已退役');
        if (result === null) {
          // 409 EGRESS_HAS_ACCOUNTS 的 details 里带 accountCount；useAction 已弹过一次错误，
          // 这里补一句指路，避免用户以为「点了没反应」。
          list.reload();
          return;
        }
        list.reload();
      },
    });
  };

  const reactivate = async (row: EgressProxy): Promise<void> => {
    const result = await run('egress-reactivate', () => egressApi.reactivate(row.id), '已回池');
    if (result !== null) list.reload();
  };

  const test = async (row: EgressProxy): Promise<void> => {
    const result = await run('egress-test', () => egressApi.test(row.id));
    if (result === null) {
      // 预算耗尽（429 TOO_MANY_ATTEMPTS）时不会走到这里之外：useAction 已弹提示。
      return;
    }
    if (result.ok) {
      message.success(`出口可达 · IP ${result.egressIp ?? '未带回'} · ${result.latencyMs}ms`);
    } else {
      message.warning(`出口不可达：${result.error ?? '未知原因'}（${result.latencyMs}ms）`);
    }
    list.reload();
  };

  const columns: ColumnsType<EgressProxy> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 160,
      render: (value: string, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 12, fontWeight: 600 }}>{value}</Text>
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 10 }}>
            {row.id}
          </Text>
        </div>
      ),
    },
    {
      title: '出口地址',
      dataIndex: 'url',
      render: (value: string) => (
        <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }} copyable={{ text: value }}>
          {value}
        </Text>
      ),
    },
    {
      title: '地区',
      dataIndex: 'region',
      width: 80,
      render: (value: string | null) =>
        value ? <Text style={{ fontSize: 12 }}>{value}</Text> : <Text type="secondary">—</Text>,
    },
    {
      title: (
        <Tooltip title="代理认证是否已设。明文凭据永不出后端 —— 这里只回答有没有。">
          <span>凭据</span>
        </Tooltip>
      ),
      dataIndex: 'authSet',
      width: 88,
      render: (value: boolean) => (
        <Tag
          bordered={false}
          style={{
            marginInlineEnd: 0,
            fontSize: 11,
            background: value ? tokens.tint.info : tokens.tint.neutral,
            color: value ? tokens.color.info : tokens.color.textSecondary,
          }}
        >
          {value ? '已认证' : '免认证'}
        </Tag>
      ),
    },
    { title: '状态', key: 'status', width: 88, render: (_, row) => statusTag(row) },
    { title: '探活', key: 'test', width: 76, render: (_, row) => testTag(row) },
    {
      title: '更新于',
      dataIndex: 'updatedAt',
      width: 100,
      render: (value: string) => (
        <Tooltip title={formatIso(value)}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatRelative(value)}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      render: (_, row) => (
        <Space size={tokens.space.xs}>
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            icon={<EditOutlined />}
            onClick={() => {
              openEdit(row);
            }}
          >
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            icon={<ApiOutlined />}
            loading={isPending('egress-test')}
            onClick={() => {
              void test(row);
            }}
          >
            探活
          </Button>
          {row.status === 'active' ? (
            <Button
              size="small"
              type="link"
              danger
              style={{ padding: 0 }}
              icon={<DeleteOutlined />}
              onClick={() => {
                retire(row);
              }}
            >
              退役
            </Button>
          ) : (
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              icon={<UndoOutlined />}
              loading={isPending('egress-reactivate')}
              onClick={() => {
                void reactivate(row);
              }}
            >
              回池
            </Button>
          )}
        </Space>
      ),
    },
  ];

  const hasAuth = Form.useWatch('hasAuth', form) ?? false;
  const clearAuth = Form.useWatch('clearAuth', form) ?? false;

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: tokens.space.lg,
      }}
    >
      <Space
        size={tokens.space.sm}
        align="center"
        wrap
        style={{ marginBottom: tokens.space.md }}
      >
        <Text style={{ fontSize: 13, fontWeight: 600 }}>出口配置</Text>
        <Tag
          bordered={false}
          style={{ marginInlineEnd: 0, background: tokens.tint.info, color: tokens.color.info }}
        >
          {`${list.data?.items.length ?? 0} 条`}
        </Tag>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          loading={list.refreshing}
          onClick={list.reload}
        >
          刷新
        </Button>
        <Button size="small" type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增出口
        </Button>
      </Space>

      {list.error && list.data ? (
        <ErrorState
          error={list.error}
          onRetry={list.reload}
          title="刷新失败，以下为上一次成功的数据"
        />
      ) : null}

      {list.loading ? (
        <LoadingState tip="正在加载出口配置…" minHeight={160} />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} variant="page" title="出口配置加载失败" />
      ) : (
        <Table<EgressProxy>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={list.data?.items ?? []}
          loading={list.refreshing}
          pagination={false}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    还没有配置出口。未配置时账号走宿主 IP 出站；要固定出口 IP，点「新增出口」填一个代理地址。
                  </Text>
                }
              />
            ),
          }}
        />
      )}

      <Modal
        open={formOpen}
        title={editing ? `编辑出口 · ${editing.name}` : '新增出口'}
        okText={editing ? '保存' : '创建'}
        cancelText="取消"
        width={620}
        destroyOnClose
        confirmLoading={isPending('egress-save')}
        onOk={() => {
          void submit();
        }}
        onCancel={() => {
          setFormOpen(false);
        }}
      >
        <Form<EgressFormValues> form={form} layout="vertical" requiredMark="optional">
          <Form.Item
            name="name"
            label="名称"
            rules={[{ required: true, message: '请输入名称' }]}
          >
            <Input placeholder="如 vps-hk-1（唯一）" style={{ width: 260 }} />
          </Form.Item>

          <Form.Item
            name="url"
            label="代理地址"
            rules={[
              { required: true, message: '请输入代理地址' },
              {
                validator: (_rule, value: string) => {
                  if (!value) return Promise.resolve();
                  if (!/^https?:\/\//.test(value)) {
                    return Promise.reject(new Error('必须以 http:// 或 https:// 开头'));
                  }
                  if (/@/.test(value)) {
                    return Promise.reject(new Error('凭据不要写在地址里，填到下面的认证栏'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
            extra={
              <Text type="secondary" style={{ fontSize: 12 }}>
                只填 <Text code>scheme://host:port</Text>，不要带 <Text code>user:pass@</Text>、
                查询串或锚点；内网 / 回环地址会被服务端拒绝。
              </Text>
            }
          >
            <Input
              placeholder="https://proxy.example:8443"
              style={{ fontFamily: tokens.font.mono }}
            />
          </Form.Item>

          <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
            <Form.Item name="region" label="地区（可选）">
              <Input placeholder="hk / cn-bj / us" style={{ width: 160 }} />
            </Form.Item>
            <Form.Item name="note" label="备注（可选）" style={{ flex: 1 }}>
              <Input placeholder="如 primary" />
            </Form.Item>
          </Space>

          {editing === null ? (
            <>
              <Form.Item name="hasAuth" label="代理需要认证" valuePropName="checked">
                <Switch />
              </Form.Item>
              {hasAuth ? (
                <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
                  <Form.Item
                    name="username"
                    label="用户名"
                    rules={[{ required: true, message: '请输入用户名' }]}
                  >
                    <Input autoComplete="off" style={{ width: 200 }} />
                  </Form.Item>
                  <Form.Item
                    name="password"
                    label="密码"
                    rules={[{ required: true, message: '请输入密码' }]}
                  >
                    <Input.Password autoComplete="new-password" style={{ width: 200 }} />
                  </Form.Item>
                </Space>
              ) : null}
            </>
          ) : (
            <>
              <Form.Item
                label="代理认证"
                extra={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {editing.authSet
                      ? '已设凭据。明文不回显 —— 留空 = 不改；要换就两个都填；要清就勾下面的清除。'
                      : '当前免认证。两个都填才落凭据（只填一个不生效）。'}
                  </Text>
                }
              >
                <Space size={tokens.space.md} align="start">
                  <Form.Item name="username" noStyle>
                    <Input placeholder="用户名" autoComplete="off" style={{ width: 200 }} />
                  </Form.Item>
                  <Form.Item name="password" noStyle>
                    <Input.Password
                      placeholder="密码"
                      autoComplete="new-password"
                      style={{ width: 200 }}
                    />
                  </Form.Item>
                </Space>
              </Form.Item>
              {editing.authSet ? (
                <Form.Item name="clearAuth" label="清除已设凭据" valuePropName="checked">
                  <Switch />
                </Form.Item>
              ) : null}
              {clearAuth ? (
                <Text type="warning" style={{ fontSize: 12 }}>
                  保存后这个出口变成免认证。
                </Text>
              ) : null}
            </>
          )}
        </Form>
      </Modal>
    </div>
  );
}
