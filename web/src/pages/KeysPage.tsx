/**
 * Key 管理 —— 列表、分类标签、余额显示、启用/禁用。
 *
 * 契约纪律：
 * - 列表只出现 `maskedKey`（后 4 位），页面**没有任何**展示明文的路径。
 * - `health` 是网关运行态：这里只读展示，可写的只有 `enabled`。
 * - 所有写请求带 `revision`（乐观锁）；不符则 409 REVISION_MISMATCH，页面提示并拉最新。
 * - 余额实时性走验收 3：WS `balance` 帧到达即覆盖该行，不等列表重拉。
 */
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Empty,
  Input,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';

import { keysApi, upstreamsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { useTaskPolling } from '@/api/useTaskPolling';
import {
  PAGE_SIZE_DEFAULT,
  type BalanceRefreshResult,
  type HintCode,
  type KeyCategory,
  type KeyHealth,
  type Upstream,
  type UpstreamKey,
} from '@/api/types';
import { BalanceHint } from '@/components/BalanceHint';
import { BalanceText } from '@/components/BalanceText';
import { HealthTag, failureReasonLabel } from '@/components/HealthTag';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { BalanceModal, KeyFormModal } from '@/pages/keys/KeyModals';
import { KeyBalanceSelfTest } from '@/pages/keys/KeyBalanceSelfTest';
import { useLive } from '@/realtime/useLive';
import { tokens } from '@/theme/tokens';
import { formatCompact, formatIso, formatRelative } from '@/utils/format';

const { Text } = Typography;

interface Filters {
  upstreamId: string | undefined;
  category: KeyCategory | undefined;
  health: KeyHealth | undefined;
  enabled: boolean | undefined;
  q: string;
  includeDeleted: boolean;
}

const EMPTY_FILTERS: Filters = {
  upstreamId: undefined,
  category: undefined,
  health: undefined,
  enabled: undefined,
  q: '',
  includeDeleted: false,
};

export default function KeysPage() {
  const { message, modal } = App.useApp();
  const { run, isPending } = useAction();
  const live = useLive();

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UpstreamKey | null>(null);
  const [balanceTarget, setBalanceTarget] = useState<UpstreamKey | null>(null);
  const [testTarget, setTestTarget] = useState<UpstreamKey | null>(null);
  const [refreshHint, setRefreshHint] = useState<{ hintCode: HintCode; hint: string | null } | null>(null);

  const upstreams = useResource(() => upstreamsApi.list({ pageSize: 200 }), []);
  const upstreamName = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of upstreams.data?.items ?? []) map.set(item.id, item.name);
    return map;
  }, [upstreams.data]);

  const query = useMemo(
    () => ({
      page,
      pageSize,
      ...(filters.upstreamId ? { upstreamId: filters.upstreamId } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.health ? { health: filters.health } : {}),
      ...(filters.enabled === undefined ? {} : { enabled: filters.enabled }),
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.includeDeleted ? { includeDeleted: true } : {}),
    }),
    [page, pageSize, filters],
  );
  const queryKey = JSON.stringify(query);

  const list = useResource(() => keysApi.list(JSON.parse(queryKey)), [queryKey]);
  const task = useTaskPolling((finished) => {
    const result = finished.result as BalanceRefreshResult | null;
    setRefreshHint(
      result && result.hintCode ? { hintCode: result.hintCode, hint: result.hint } : null,
    );
    message.success('余额刷新完成');
    list.reload();
  });

  // 验收 3：WS balance 帧到即覆盖该行余额，不等下一次列表拉取。
  const rows = useMemo<UpstreamKey[]>(() => {
    const items = list.data?.items ?? [];
    return items.map((row) => {
      const frame = live.balances[row.id];
      if (!frame) return row;
      return {
        ...row,
        balance: frame.balance,
        balanceUpdatedAt: frame.balanceUpdatedAt,
        balanceSource: frame.balanceSource,
      };
    });
  }, [list.data, live.balances]);

  const patchKey = async (row: UpstreamKey, body: Parameters<typeof keysApi.update>[1], okText: string) => {
    const result = await run(`patch:${row.id}`, () => keysApi.update(row.id, body), okText);
    if (result === null) {
      // 乐观锁冲突：提示已由 useAction 给出，这里补一次强制刷新，避免用户对着旧版本反复提交。
      list.reload();
      return;
    }
    list.reload();
  };

  const removeKey = (row: UpstreamKey) => {
    modal.confirm({
      title: `删除 key ${row.maskedKey}？`,
      content: '删除后该 key 立即停止服务，调用历史仍可查（日志保留 30 天）。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await run(`delete:${row.id}`, () => keysApi.remove(row.id), '已删除');
        if (result !== null) list.reload();
      },
    });
  };

  const refreshOne = async (row: UpstreamKey) => {
    const result = await run(
      `refresh:${row.id}`,
      () => keysApi.refreshBalance(row.id),
      '已提交余额查询',
    );
    if (result === null) return;
    // 契约对单 key 刷新的响应体未明示是同步回值还是 202 任务；两种都兼容处理。
    if (typeof result === 'object' && result !== null && 'taskId' in result) {
      task.start((result as { taskId: string }).taskId);
    } else {
      list.reload();
    }
  };

  const batch = async (action: 'enable' | 'disable') => {
    if (selectedIds.length === 0) return;
    const result = await run(
      `batch:${action}`,
      () => keysApi.batch({ ids: selectedIds, action }),
      action === 'enable' ? '已批量启用' : '已批量禁用',
    );
    if (result === null) return;
    setSelectedIds([]);
    list.reload();
  };

  const columns: ColumnsType<UpstreamKey> = [
    {
      title: '标签 / Key',
      dataIndex: 'label',
      render: (_: string, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 13 }}>{row.label || '（无标签）'}</Text>
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>
            {row.maskedKey}
          </Text>
        </div>
      ),
    },
    {
      title: '上游',
      dataIndex: 'upstreamId',
      width: 140,
      render: (value: string) => <Text type="secondary">{upstreamName.get(value) ?? value}</Text>,
    },
    {
      title: '分类',
      dataIndex: 'category',
      width: 110,
      render: (value: KeyCategory) =>
        value === 'balance' ? (
          <Tag bordered={false} style={{ background: tokens.tint.info, color: tokens.color.info }}>
            余额类
          </Tag>
        ) : (
          <Tag bordered={false} style={{ background: tokens.tint.neutral, color: tokens.color.textSecondary }}>
            Token 套餐
          </Tag>
        ),
    },
    {
      title: '余额 / 套餐',
      dataIndex: 'balance',
      width: 200,
      render: (_: unknown, row) =>
        row.category === 'token-plan' ? (
          row.tokenPlan ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Text style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatCompact(row.tokenPlan.remainingTokens)} tokens
              </Text>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {row.tokenPlan.expiresAt ? `到期 ${formatIso(row.tokenPlan.expiresAt)}` : '无到期时间'}
              </Text>
            </div>
          ) : (
            <Text type="secondary">套餐信息缺失</Text>
          )
        ) : (
          <BalanceText
            value={row.balance}
            currency={row.balanceCurrency ?? 'CNY'}
            source={row.balanceSource}
            updatedAt={row.balanceUpdatedAt}
            showMeta
            strong
          />
        ),
    },
    {
      title: '健康态',
      dataIndex: 'health',
      width: 170,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <HealthTag
            health={row.health}
            cooldownUntil={row.cooldownUntil}
            lastFailureReason={row.lastFailureReason}
            consecutiveFailures={row.consecutiveFailures}
          />
          {row.consecutiveFailures > 0 ? (
            <Text type="secondary" style={{ fontSize: 11 }}>
              连续失败 {row.consecutiveFailures} 次 · {failureReasonLabel(row.lastFailureReason)}
            </Text>
          ) : null}
        </div>
      ),
    },
    {
      title: '今日 token',
      dataIndex: 'todayTokens',
      width: 110,
      align: 'right',
      render: (value: number) => <Text style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCompact(value)}</Text>,
    },
    {
      title: '更新于',
      dataIndex: 'updatedAt',
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
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (_: unknown, row) => (
        <Tooltip title={row.deletedAt ? '该 key 已软删（C4 级联），不再参与路由' : '管理端只写 enabled；health 由网关决定'}>
          <Switch
            size="small"
            checked={row.enabled}
            disabled={Boolean(row.deletedAt)}
            loading={isPending(`patch:${row.id}`)}
            onChange={(checked) => {
              void patchKey(row, { enabled: checked, revision: row.revision }, checked ? '已启用' : '已禁用');
            }}
          />
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
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
          {row.category === 'balance' ? (
            <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setBalanceTarget(row)}>
              录入余额
            </Button>
          ) : null}
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            loading={isPending(`refresh:${row.id}`)}
            disabled={row.deletedAt !== null}
            onClick={() => {
              void refreshOne(row);
            }}
          >
            查余额
          </Button>
          {row.category === 'balance' ? (
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              disabled={row.deletedAt !== null}
              onClick={() => setTestTarget(row)}
            >
              自测
            </Button>
          ) : null}
          <Button size="small" type="link" danger style={{ padding: 0 }} onClick={() => removeKey(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const loading = list.loading || upstreams.loading;
  if (loading) {
    return (
      <>
        <PageHeader title="Key 管理" description="分类标签、余额显示、启用与禁用" />
        <LoadingState tip="正在加载 key 列表…" minHeight={420} />
      </>
    );
  }

  if (list.error && !list.data) {
    return (
      <>
        <PageHeader title="Key 管理" description="分类标签、余额显示、启用与禁用" />
        <ErrorState error={list.error} onRetry={list.reload} variant="page" title="Key 列表加载失败" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Key 管理"
        description="分类标签、余额显示、启用与禁用"
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={isPending('refreshAll') || task.running}
              disabled={(upstreams.data?.items.length ?? 0) === 0}
              onClick={async () => {
                const result = await run(
                  'refreshAll',
                  () => keysApi.refreshAllBalances(),
                  '已提交全量余额刷新任务',
                );
                if (result !== null) task.start(result.taskId);
              }}
            >
              全量查余额
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              disabled={(upstreams.data?.items.length ?? 0) === 0}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              新增 Key
            </Button>
          </Space>
        }
      />

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: tokens.space.sm,
          marginBottom: tokens.space.md,
        }}
      >
        <Select
          allowClear
          size="small"
          style={{ width: 180 }}
          placeholder="全部上游"
          value={filters.upstreamId}
          options={(upstreams.data?.items ?? []).map((item: Upstream) => ({
            label: item.name,
            value: item.id,
          }))}
          onChange={(value: string | undefined) => {
            setFilters((prev) => ({ ...prev, upstreamId: value }));
            setPage(1);
          }}
        />
        <Segmented
          size="small"
          value={filters.category ?? 'all'}
          options={[
            { label: '全部', value: 'all' },
            { label: '余额类', value: 'balance' },
            { label: 'Token 套餐', value: 'token-plan' },
          ]}
          onChange={(value) => {
            setFilters((prev) => ({
              ...prev,
              category: value === 'all' ? undefined : (value as KeyCategory),
            }));
            setPage(1);
          }}
        />
        <Select
          allowClear
          size="small"
          style={{ width: 150 }}
          placeholder="全部健康态"
          value={filters.health}
          options={[
            { label: '健康', value: 'healthy' },
            { label: '冷却中', value: 'cooling' },
            { label: '已禁用', value: 'disabled' },
          ]}
          onChange={(value: KeyHealth | undefined) => {
            setFilters((prev) => ({ ...prev, health: value }));
            setPage(1);
          }}
        />
        <Segmented
          size="small"
          value={filters.enabled === undefined ? 'all' : filters.enabled ? 'on' : 'off'}
          options={[
            { label: '全部', value: 'all' },
            { label: '已启用', value: 'on' },
            { label: '已禁用', value: 'off' },
          ]}
          onChange={(value) => {
            setFilters((prev) => ({
              ...prev,
              enabled: value === 'all' ? undefined : value === 'on',
            }));
            setPage(1);
          }}
        />
        <Tooltip title="默认不显示已软删的 key；打开后可查历史（软删行仍保留，日志外键不断）">
          <Segmented
            size="small"
            value={filters.includeDeleted ? 'with' : 'without'}
            options={[
              { label: '不含已删', value: 'without' },
              { label: '含已删', value: 'with' },
            ]}
            onChange={(value) => {
              setFilters((prev) => ({ ...prev, includeDeleted: value === 'with' }));
              setPage(1);
            }}
          />
        </Tooltip>
        <Input.Search
          size="small"
          allowClear
          style={{ width: 200 }}
          placeholder="搜索标签"
          onSearch={(value) => {
            setFilters((prev) => ({ ...prev, q: value }));
            setPage(1);
          }}
        />

        {selectedIds.length > 0 ? (
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              已选 {selectedIds.length} 个
            </Text>
            <Button size="small" loading={isPending('batch:enable')} onClick={() => void batch('enable')}>
              批量启用
            </Button>
            <Button
              size="small"
              danger
              loading={isPending('batch:disable')}
              onClick={() => void batch('disable')}
            >
              批量禁用
            </Button>
          </Space>
        ) : null}
      </div>

      {list.error && list.data ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={list.error} onRetry={list.reload} title="刷新失败，以下为上一次成功的数据" />
        </div>
      ) : null}

      {task.error ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={task.error} onRetry={task.refresh} title="余额刷新任务查询失败" />
        </div>
      ) : null}

      {refreshHint ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <BalanceHint hintCode={refreshHint.hintCode} hint={refreshHint.hint} />
        </div>
      ) : null}

      <Table<UpstreamKey>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        loading={list.refreshing}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
          getCheckboxProps: (row) => ({ disabled: Boolean(row.deletedAt) }),
        }}
        scroll={{ x: 1200 }}
        pagination={{
          current: page,
          pageSize,
          total: list.data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200],
          showTotal: (total) => `共 ${total} 个 key`,
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
                (upstreams.data?.items.length ?? 0) === 0
                  ? '还没有上游。先到「上游管理」添加 Base URL，再回来加 key。'
                  : '当前筛选条件下没有 key。'
              }
            />
          ),
        }}
      />

      <KeyFormModal
        open={formOpen}
        upstreams={upstreams.data?.items ?? []}
        editing={editing}
        onClose={() => setFormOpen(false)}
        onSaved={list.reload}
      />
      <BalanceModal
        open={balanceTarget !== null}
        target={balanceTarget}
        onClose={() => setBalanceTarget(null)}
        onSaved={list.reload}
      />
      <KeyBalanceSelfTest
        open={testTarget !== null}
        keyId={testTarget?.id ?? null}
        maskedKey={testTarget?.maskedKey ?? null}
        onClose={() => setTestTarget(null)}
      />
    </>
  );
}
