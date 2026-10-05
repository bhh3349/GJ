/**
 * 用户组 —— 建组、发 key、配额设置。
 *
 * 契约纪律：
 * - C1：建组**自动签发**第一把网关 key，明文只在创建响应里出现一次；
 *   页面用一次性弹窗展示（`GatewayKeyRevealModal`），关闭即从内存丢弃。
 * - 配额 `null` = **不限**，不是 0。`0` 是「全部拒绝」，两者在 UI 上必须能分开看。
 * - 组里的网关 key 明文永不再取回：列表只显示 `gatewayKeyMasked`。
 */
import { KeyOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Empty, Input, Progress, Space, Switch, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { groupsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { PAGE_SIZE_DEFAULT, type Group, type QuotaValue } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import {
  GatewayKeyRevealModal,
  GroupFormModal,
  type GatewayKeyReveal,
} from '@/pages/groups/GroupModals';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCompact, formatCount, formatIso, formatRelative } from '@/utils/format';

const { Text } = Typography;

/** `null`（不限）与 `0`（全部拒绝）用两种观感，不能都渲染成数字。 */
function QuotaCell({ value }: { value: QuotaValue }) {
  if (value === null) {
    return (
      <Tooltip title="未设置上限（契约 §4：null = 不限）">
        <Text type="secondary">不限</Text>
      </Tooltip>
    );
  }
  return <Text style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCount(value)}</Text>;
}

export default function GroupsPage() {
  const { modal } = App.useApp();
  const { run, isPending } = useAction();

  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const [reveal, setReveal] = useState<GatewayKeyReveal | null>(null);

  const queryKey = JSON.stringify({ q, page, pageSize });
  const list = useResource(() => groupsApi.list(JSON.parse(queryKey)), [queryKey]);

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const issueKey = async (row: Group) => {
    const result = await run(`issue:${row.id}`, () => groupsApi.issueKey(row.id), '已签发新 key');
    if (result === null) return;
    setReveal({
      gatewayKey: result.gatewayKey,
      maskedKey: result.maskedKey,
      context: `用户组「${row.name}」新签发的网关 key。`,
    });
    list.reload();
  };

  const toggleEnabled = async (row: Group) => {
    const next = !row.enabled;
    await run(
      `patch:${row.id}`,
      () => groupsApi.update(row.id, { enabled: next, revision: row.revision }),
      next ? '已启用' : '已禁用',
    );
    list.reload();
  };

  const remove = (row: Group) => {
    modal.confirm({
      title: `删除用户组「${row.name}」？`,
      content:
        row.keyCount > 0
          ? `该组下有 ${row.keyCount} 把网关 key，删除后立即失效；历史调用日志保留（30 天）。`
          : '删除后不可恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await run(`delete:${row.id}`, () => groupsApi.remove(row.id), '已删除');
        if (result !== null) list.reload();
      },
    });
  };

  const columns: ColumnsType<Group> = [
    {
      title: '组名',
      dataIndex: 'name',
      width: 170,
      render: (value: string, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text>{value}</Text>
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>
            {row.id}
          </Text>
        </div>
      ),
    },
    {
      title: '网关 key',
      dataIndex: 'gatewayKeyMasked',
      width: 170,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>
            {row.gatewayKeyMasked ?? <Text type="secondary">未签发</Text>}
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            共 {row.keyCount} 把（明文仅签发时可见一次）
          </Text>
        </div>
      ),
    },
    {
      title: 'RPM / TPM',
      key: 'rate',
      width: 150,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 12 }}>
            RPM <QuotaCell value={row.rpm} />
          </Text>
          <Text style={{ fontSize: 12 }}>
            TPM <QuotaCell value={row.tpm} />
          </Text>
        </div>
      ),
    },
    {
      title: '日配额',
      dataIndex: 'dailyQuota',
      width: 190,
      render: (_: unknown, row) => {
        if (row.dailyQuota === null) {
          return (
            <Tooltip title="未设置日配额（null = 不限）">
              <Text type="secondary">不限 · 今日已用 {formatCount(row.dailyQuotaUsed)}</Text>
            </Tooltip>
          );
        }
        // 后端给的是真实累计值；这里只做呈现，不自己推算，也不做乐观预估。
        const percent = Math.min(100, Math.round((row.dailyQuotaUsed / Math.max(row.dailyQuota, 1)) * 100));
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Text style={{ fontSize: 12 }}>
              {formatCount(row.dailyQuotaUsed)} / {formatCount(row.dailyQuota)}
            </Text>
            <Progress
              percent={percent}
              size="small"
              showInfo={false}
              strokeColor={percent >= 90 ? tokens.color.error : percent >= 70 ? tokens.color.warning : tokens.color.primary}
              trailColor={tokens.color.border}
            />
          </div>
        );
      },
    },
    {
      title: '今日用量',
      key: 'today',
      width: 160,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {formatCount(row.todayUsage.requests)} 次 · {formatCompact(row.todayUsage.tokens)} tokens
          </Text>
          <Text type="secondary" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
            {formatCents(row.todayUsage.costCents)}
          </Text>
        </div>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (_: unknown, row) => (
        <Tooltip title="禁用后该组下所有网关 key 立即停止服务">
          <Switch
            size="small"
            checked={row.enabled}
            loading={isPending(`patch:${row.id}`)}
            onChange={() => {
              void toggleEnabled(row);
            }}
          />
        </Tooltip>
      ),
    },
    {
      title: '创建于',
      dataIndex: 'createdAt',
      width: 110,
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
      width: 190,
      render: (_: unknown, row) => (
        <Space size={tokens.space.sm}>
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            onClick={() => {
              setEditing(row);
              setFormOpen(true);
            }}
          >
            编辑
          </Button>
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            loading={isPending(`issue:${row.id}`)}
            onClick={() => {
              void issueKey(row);
            }}
          >
            签发新 key
          </Button>
          <Button size="small" type="link" danger style={{ padding: 0 }} onClick={() => remove(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="用户组"
        description="建组、发 key、配额设置"
        extra={
          <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>
            新建用户组
          </Button>
        }
      />

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space.sm,
          marginBottom: tokens.space.md,
        }}
      >
        <Input.Search
          size="small"
          allowClear
          style={{ width: 220 }}
          placeholder="搜索组名"
          onSearch={(value) => {
            setQ(value);
            setPage(1);
          }}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          共 {formatCount(list.data?.total ?? 0)} 个组
        </Text>
      </div>

      {list.error && list.data ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={list.error} onRetry={list.reload} title="刷新失败，以下为上一次成功的数据" />
        </div>
      ) : null}

      {list.loading ? (
        <LoadingState tip="正在加载用户组…" minHeight={320} />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} variant="page" title="用户组加载失败" />
      ) : (
        <Table<Group>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={list.data?.items ?? []}
          loading={list.refreshing}
          scroll={{ x: 1200 }}
          pagination={{
            current: page,
            pageSize,
            total: list.data?.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100, 200],
            showTotal: (total) => `共 ${total} 个组`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            },
          }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  q
                    ? '当前搜索条件下没有用户组。'
                    : '还没有用户组。新建一个组会自动签发第一把网关 key。'
                }
              />
            ),
          }}
        />
      )}

      <GroupFormModal
        open={formOpen}
        editing={editing}
        onClose={() => setFormOpen(false)}
        onSaved={list.reload}
        onCreated={(created) => {
          setReveal({
            gatewayKey: created.gatewayKey,
            maskedKey: created.gatewayKeyMasked ?? created.gatewayKey.slice(-4),
            context: `用户组「${created.name}」创建成功，这是它的第一把网关 key。`,
          });
        }}
      />

      {/* 明文只在本次签发后驻留内存；关闭即置 null，不缓存、不写 localStorage。 */}
      <GatewayKeyRevealModal reveal={reveal} onClose={() => setReveal(null)} />

      {/* 签发入口的第二处提示位：列表为空时也告诉管理员 key 从哪来 */}
      {list.data && list.data.items.length > 0 && (
        <Text type="secondary" style={{ display: 'block', marginTop: tokens.space.md, fontSize: 12 }}>
          <KeyOutlined /> 网关 key 明文仅在创建/签发响应里出现一次，之后系统只保留 sha256 摘要与
          <Text code>****后4位</Text>掩码。
        </Text>
      )}
    </>
  );
}
