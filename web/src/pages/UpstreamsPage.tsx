/**
 * 上游管理 —— Base URL 的增删改、余额查询模板、余额合计。
 *
 * 契约纪律：
 * - 余额是「防造假」主战场：`totalBalance=null` 表示该上游所有 balance 类 key 都未知，
 *   **不是 0**；`balanceUnknownKeyCount` 必须单独呈现，让管理员看得见「合计是不完整的」。
 * - `token-plan` 类 key 不进金额合计（ADR-0003 规则 1），只在旁边单列数量。
 * - 删除有 key 的上游：后端 409 `UPSTREAM_HAS_KEYS`（`details.keyCount`），
 *   这里拿它做二次确认再发 `force=true`，不做「静默级联删」。
 * - 写请求一律带 `revision`；409 `REVISION_MISMATCH` 时提示并拉最新，避免对着旧版本反复提交。
 */
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Empty,
  Input,
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

import { upstreamsApi } from '@/api/endpoints';
import { describeError, isApiError } from '@/api/http';
import { useAction, useResource } from '@/api/hooks';
import { useTaskPolling } from '@/api/useTaskPolling';
import { PAGE_SIZE_DEFAULT, type BalanceRefreshResult, type HintCode, type Upstream } from '@/api/types';
import { BalanceHint } from '@/components/BalanceHint';
import { BalanceText } from '@/components/BalanceText';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { UpstreamModal } from '@/pages/upstreams/UpstreamModal';
import { tokens } from '@/theme/tokens';
import { formatCount, formatIso, formatRelative } from '@/utils/format';

const { Text } = Typography;

/** `409 UPSTREAM_HAS_KEYS` 的 `details: {keyCount: 6}`，拿不到就回 null。 */
function detailKeyCount(details: unknown): number | null {
  if (details !== null && typeof details === 'object' && 'keyCount' in details) {
    const value = (details as { keyCount?: unknown }).keyCount;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export default function UpstreamsPage() {
  const { message, modal } = App.useApp();
  const { run, isPending } = useAction();

  const [q, setQ] = useState('');
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Upstream | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [refreshHint, setRefreshHint] = useState<{ hintCode: HintCode; hint: string | null } | null>(null);

  const queryKey = JSON.stringify({ q, enabled, page, pageSize });
  const list = useResource(
    () => upstreamsApi.list(JSON.parse(queryKey)),
    [queryKey],
  );
  const task = useTaskPolling((finished) => {
    const result = finished.result as BalanceRefreshResult | null;
    setRefreshHint(
      result && result.hintCode ? { hintCode: result.hintCode, hint: result.hint } : null,
    );
    message.success('余额查询完成');
    list.reload();
  });

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (row: Upstream) => {
    setEditing(row);
    setFormOpen(true);
  };

  const toggleEnabled = async (row: Upstream) => {
    const next = !row.enabled;
    const result = await run(
      `patch:${row.id}`,
      () => upstreamsApi.update(row.id, { enabled: next, revision: row.revision }),
      next ? '已启用' : '已禁用',
    );
    // 无论成败都拉最新：成功要回显服务端真值，失败多半是 409 乐观锁冲突。
    void result;
    list.reload();
  };

  const refreshBalance = async (row: Upstream) => {
    const result = await run(
      `refresh:${row.id}`,
      () => upstreamsApi.refreshBalance(row.id),
      '已提交余额查询任务',
    );
    if (result !== null) task.start(result.taskId);
  };

  /**
   * 删除。故意不走 `useAction`：force 分支需要读到 `UPSTREAM_HAS_KEYS` 的原始错误，
   * 而 `useAction.run` 会把错误吞成 `null`。失败提示仍按契约 code 给出。
   */
  const remove = (row: Upstream, force: boolean) => {
    setRemovingId(row.id);
    upstreamsApi
      .remove(row.id, force)
      .then(() => {
        message.success(force ? `已强制删除「${row.name}」` : `已删除「${row.name}」`);
        list.reload();
      })
      .catch((error: unknown) => {
        if (!force && isApiError(error) && error.code === 'UPSTREAM_HAS_KEYS') {
          const count = detailKeyCount(error.details);
          modal.confirm({
            title: `「${row.name}」下还有 key，确定强制删除？`,
            content: `该上游有 ${count ?? row.keyCount} 个 key，会被级联软删（enabled=false + deletedAt，C4）；历史调用日志的外键保留，仍可查询。`,
            okText: '强制删除',
            okButtonProps: { danger: true },
            cancelText: '取消',
            onOk: () => {
              remove(row, true);
            },
          });
          return;
        }
        const { code, message: text } = describeError(error);
        message.error(`${text} [${code}]`);
      })
      .finally(() => {
        setRemovingId((current) => (current === row.id ? null : current));
      });
  };

  const columns: ColumnsType<Upstream> = [
    {
      title: '名称',
      dataIndex: 'name',
      width: 160,
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
      title: 'Base URL',
      dataIndex: 'baseUrl',
      render: (value: string) => (
        <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }} copyable={{ text: value }}>
          {value}
        </Text>
      ),
    },
    {
      title: 'Key',
      dataIndex: 'keyCount',
      width: 110,
      render: (_: unknown, row) => (
        <Tooltip title={`已启用 ${row.enabledKeyCount} / 共 ${row.keyCount}`}>
          <Text style={{ fontVariantNumeric: 'tabular-nums' }}>
            {row.enabledKeyCount}
            <Text type="secondary"> / {row.keyCount}</Text>
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '余额合计',
      dataIndex: 'totalBalance',
      width: 210,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/* 全部 key 都未知时 totalBalance 为 null → BalanceText 显示「未知」，绝不补 0 */}
          <BalanceText value={row.totalBalance} strong />
          <Text type="secondary" style={{ fontSize: 11 }}>
            {row.balanceUnknownKeyCount > 0
              ? `${row.balanceUnknownKeyCount} 个未知未计入合计`
              : '已全部纳入合计'}
            {row.tokenPlanKeyCount > 0 ? ` · 套餐类 ${row.tokenPlanKeyCount} 个不计金额` : ''}
          </Text>
        </div>
      ),
    },
    {
      title: '余额模板',
      dataIndex: 'balanceQuery',
      width: 160,
      render: (_: unknown, row) => {
        if (row.balanceQuery?.enabled) {
          return (
            <Tooltip title={`${row.balanceQuery.method} ${row.balanceQuery.url}（超时 ${row.balanceQuery.timeoutMs}ms）`}>
              <Tag bordered={false} style={{ background: tokens.tint.info, color: tokens.color.info }}>
                已配置
              </Tag>
            </Tooltip>
          );
        }
        if (row.balancePreset) {
          return (
            <Tooltip title="内置余额查询来源（只读、可推导）。不配模板也能自动查询余额。">
              <Tag bordered={false} style={{ background: tokens.tint.success, color: tokens.color.success }}>
                内置 · {row.balancePreset.label}
              </Tag>
            </Tooltip>
          );
        }
        return (
          <Tooltip title="未配置模板查询，也未识别到内置来源：该上游的余额只能手动录入。">
            <Tag bordered={false} style={{ background: tokens.tint.neutral, color: tokens.color.textSecondary }}>
              仅手动
            </Tag>
          </Tooltip>
        );
      },
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
        <Tooltip title="禁用后网关不再选用该上游下的任何 key">
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
      title: '操作',
      key: 'actions',
      width: 200,
      render: (_: unknown, row) => (
        <Space size={tokens.space.sm}>
          <Button size="small" type="link" style={{ padding: 0 }} onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Tooltip title={row.balanceQuery?.enabled ? '按模板查该上游全部 key 的余额' : '未配置余额模板，查询会跳过'}>
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              loading={isPending(`refresh:${row.id}`)}
              onClick={() => {
                void refreshBalance(row);
              }}
            >
              查余额
            </Button>
          </Tooltip>
          <Button
            size="small"
            type="link"
            danger
            style={{ padding: 0 }}
            loading={removingId === row.id}
            onClick={() => {
              remove(row, false);
            }}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const filterBar = (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: tokens.space.sm,
        marginBottom: tokens.space.md,
      }}
    >
      <Input.Search
        size="small"
        allowClear
        style={{ width: 220 }}
        placeholder="搜索名称 / Base URL"
        onSearch={(value) => {
          setQ(value);
          setPage(1);
        }}
      />
      <Segmented
        size="small"
        value={enabled === undefined ? 'all' : enabled ? 'on' : 'off'}
        options={[
          { label: '全部', value: 'all' },
          { label: '已启用', value: 'on' },
          { label: '已禁用', value: 'off' },
        ]}
        onChange={(value) => {
          setEnabled(value === 'all' ? undefined : value === 'on');
          setPage(1);
        }}
      />
      <Text type="secondary" style={{ fontSize: 12 }}>
        共 {formatCount(list.data?.total ?? 0)} 个上游
      </Text>
    </div>
  );

  return (
    <>
      <PageHeader
        title="上游管理"
        description="Base URL 的增删改与余额查询模板"
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={list.refreshing}
              onClick={list.reload}
            >
              刷新
            </Button>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={openCreate}>
              新增上游
            </Button>
          </Space>
        }
      />

      {filterBar}

      {list.error && list.data ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={list.error} onRetry={list.reload} title="刷新失败，以下为上一次成功的数据" />
        </div>
      ) : null}

      {task.error ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={task.error} onRetry={task.refresh} title="余额查询任务查询失败" />
        </div>
      ) : null}

      {refreshHint ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <BalanceHint hintCode={refreshHint.hintCode} hint={refreshHint.hint} />
        </div>
      ) : null}

      {list.loading ? (
        <LoadingState tip="正在加载上游列表…" minHeight={320} />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} variant="page" title="上游列表加载失败" />
      ) : (
        <Table<Upstream>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={list.data?.items ?? []}
          loading={list.refreshing}
          scroll={{ x: 1180 }}
          pagination={{
            current: page,
            pageSize,
            total: list.data?.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100, 200],
            showTotal: (total) => `共 ${total} 个上游`,
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
                  q || enabled !== undefined
                    ? '当前筛选条件下没有上游。'
                    : '还没有上游。先添加一个 Base URL，再往下面挂 key。'
                }
              />
            ),
          }}
        />
      )}

      <UpstreamModal
        open={formOpen}
        editing={editing}
        onClose={() => setFormOpen(false)}
        onSaved={list.reload}
      />
    </>
  );
}
