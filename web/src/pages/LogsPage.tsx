/**
 * 日志 —— 调用记录查询 + 审计（最小集）。
 *
 * 契约纪律：
 * - C3 裁决：**不加导出端点**，导出由前端自行完成。这里导出的是「当前筛选条件下的前 200 条」
 *   （分页上限 200，契约 §0.3），条数不足时会明确告知实际条数，不假装导了全量。
 * - `keyMasked` 只 4 位；日志里永远没有 key 明文。token 是 int，`isEstimated=true` 的行要标出来
 *   ——它进了配额，但不是上游真实报数，管理员看账单时必须能区分（`is_estimated=1`）。
 * - 时间一律按契约的 ISO8601 UTC 传参，展示时转本地时区。
 */
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { App, Button, DatePicker, Empty, Input, Segmented, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';

import { groupsApi, logsApi, upstreamsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { PAGE_SIZE_DEFAULT, type AuditEntry, type CallLog, type Group, type Upstream } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';
import { formatCount, formatIso, formatLatency } from '@/utils/format';

const { Text } = Typography;

/** 后端给的是确切状态码，契约不支持「成功/失败」这种区间参数，所以这里只能精确匹配。 */
const STATUS_OPTIONS = [200, 400, 401, 403, 404, 429, 500, 502, 503, 504];

function statusTone(status: number): { color: string; bg: string } {
  if (status < 300) return { color: tokens.color.success, bg: tokens.tint.success };
  if (status < 500) return { color: tokens.color.warning, bg: tokens.tint.warning };
  return { color: tokens.color.error, bg: tokens.tint.error };
}

/** 客户端 CSV 导出（C3）。字段全部加引号，引号双写转义。 */
function toCsv(rows: readonly CallLog[]): string {
  const header = [
    'ts',
    'model',
    'upstreamId',
    'keyMasked',
    'groupId',
    'status',
    'errorCode',
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'isEstimated',
    'latencyMs',
    'ttfbMs',
    'stream',
  ];
  const cell = (value: unknown): string => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((row) =>
    [
      row.ts,
      row.model,
      row.upstreamId,
      row.keyMasked,
      row.groupId ?? '',
      row.status,
      row.errorCode ?? '',
      row.tokens.prompt,
      row.tokens.completion,
      row.tokens.total,
      row.tokens.isEstimated,
      row.latencyMs,
      row.ttfbMs ?? '',
      row.stream,
    ]
      .map(cell)
      .join(','),
  );
  return [header.join(','), ...lines].join('\r\n');
}

function downloadCsv(content: string, filename: string): void {
  // BOM 让 Excel 正确识别 UTF-8，中文列名不会乱码。
  const blob = new Blob([`﻿${content}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function LogsPage() {
  const { message } = App.useApp();
  const { run, isPending } = useAction();

  const [tab, setTab] = useState<'calls' | 'audit'>('calls');

  // ── 调用记录 ──
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(24, 'hour'), dayjs()]);
  const [upstreamId, setUpstreamId] = useState<string | undefined>(undefined);
  const [groupId, setGroupId] = useState<string | undefined>(undefined);
  const [model, setModel] = useState('');
  const [status, setStatus] = useState<number | undefined>(undefined);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);

  const from = range[0].toISOString();
  const to = range[1].toISOString();

  const queryKey = JSON.stringify({ from, to, upstreamId, groupId, model, status, includeDeleted, page, pageSize });
  const logs = useResource(() => logsApi.list(JSON.parse(queryKey)), [queryKey, tab]);

  // ── 审计 ──
  const [auditPage, setAuditPage] = useState(1);
  const audit = useResource(() => logsApi.audit({ page: auditPage, pageSize: PAGE_SIZE_DEFAULT }), [auditPage, tab]);

  const upstreams = useResource(() => upstreamsApi.list({ pageSize: 200 }), []);
  const groups = useResource(() => groupsApi.list({ pageSize: 200 }), []);
  const upstreamName = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of upstreams.data?.items ?? []) map.set(item.id, item.name);
    return map;
  }, [upstreams.data]);
  const groupName = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of groups.data?.items ?? []) map.set(item.id, item.name);
    return map;
  }, [groups.data]);

  const exportCsv = async () => {
    const result = await run('export', () => logsApi.list({ ...JSON.parse(queryKey), page: 1, pageSize: 200 }));
    if (result === null) return;
    if (result.items.length === 0) {
      message.warning('当前筛选条件下没有记录可导出');
      return;
    }
    const stamp = dayjs().format('YYYYMMDD-HHmmss');
    downloadCsv(toCsv(result.items), `sub-logs-${stamp}.csv`);
    if (result.total > result.items.length) {
      message.warning(`当前筛选条件共 ${result.total} 条，本次导出前 ${result.items.length} 条（分页上限 200）`);
    } else {
      message.success(`已导出 ${result.items.length} 条`);
    }
  };

  const callColumns: ColumnsType<CallLog> = [
    {
      title: '时间',
      dataIndex: 'ts',
      width: 170,
      render: (value: string) => (
        <Tooltip title={value}>
          <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{formatIso(value)}</Text>
        </Tooltip>
      ),
    },
    {
      title: '模型',
      dataIndex: 'model',
      width: 170,
      render: (value: string) => (
        <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value}</Text>
      ),
    },
    {
      title: '上游 / key',
      key: 'route',
      width: 170,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 12 }}>{upstreamName.get(row.upstreamId) ?? row.upstreamId}</Text>
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>
            {row.keyMasked}
          </Text>
        </div>
      ),
    },
    {
      title: '用户组',
      dataIndex: 'groupId',
      width: 120,
      render: (value: string | null) =>
        value === null ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            直连
          </Text>
        ) : (
          <Text style={{ fontSize: 12 }}>{groupName.get(value) ?? value}</Text>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 150,
      render: (value: number, row) => {
        const tone = statusTone(value);
        return (
          <Space size={4}>
            <Tag bordered={false} style={{ marginInlineEnd: 0, color: tone.color, background: tone.bg }}>
              {value}
            </Tag>
            {row.errorCode ? (
              <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>
                {row.errorCode}
              </Text>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: 'tokens',
      key: 'tokens',
      width: 170,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {formatCount(row.tokens.total)}
          </Text>
          <Space size={4}>
            <Text type="secondary" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
              {formatCount(row.tokens.prompt)} / {formatCount(row.tokens.completion)}
            </Text>
            {row.tokens.isEstimated ? (
              <Tooltip title="上游未返回用量，按字符估算（is_estimated=1）。已计入配额，但不是上游真实报数。">
                <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 10, background: tokens.tint.warning, color: tokens.color.warning }}>
                  估算
                </Tag>
              </Tooltip>
            ) : null}
          </Space>
        </div>
      ),
    },
    {
      title: '延迟',
      key: 'latency',
      width: 150,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{formatLatency(row.latencyMs)}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            首字节 {row.ttfbMs === null ? '—' : formatLatency(row.ttfbMs)}
          </Text>
        </div>
      ),
    },
    {
      title: 'stream',
      dataIndex: 'stream',
      width: 80,
      render: (value: boolean) =>
        value ? (
          <Tag bordered={false} style={{ marginInlineEnd: 0, background: tokens.tint.info, color: tokens.color.info }}>
            流式
          </Tag>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>
            非流式
          </Text>
        ),
    },
  ];

  const auditColumns: ColumnsType<AuditEntry> = [
    {
      title: '时间',
      dataIndex: 'ts',
      width: 180,
      render: (value: string) => (
        <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{formatIso(value)}</Text>
      ),
    },
    {
      title: '操作人',
      dataIndex: 'actor',
      width: 140,
      render: (value: string) => <Text style={{ fontSize: 12 }}>{value}</Text>,
    },
    {
      title: '来源 IP',
      dataIndex: 'ip',
      width: 150,
      render: (value: string) => (
        <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value}</Text>
      ),
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 200,
      render: (value: string) => (
        <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value}</Text>
      ),
    },
    {
      title: '目标',
      key: 'target',
      render: (_: unknown, row) => (
        <Text style={{ fontSize: 12 }}>
          {row.targetType}
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>
            {' '}
            {row.targetId}
          </Text>
        </Text>
      ),
    },
    {
      title: '结果',
      dataIndex: 'result',
      width: 110,
      render: (value: string) => (
        <Tag
          bordered={false}
          style={{
            marginInlineEnd: 0,
            background: value === 'ok' ? tokens.tint.success : tokens.tint.error,
            color: value === 'ok' ? tokens.color.success : tokens.color.error,
          }}
        >
          {value}
        </Tag>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="日志"
        description="调用记录与审计（保留 30 天）"
        extra={
          <Space>
            {tab === 'calls' ? (
              <Button
                size="small"
                icon={<DownloadOutlined />}
                loading={isPending('export')}
                disabled={(logs.data?.total ?? 0) === 0}
                onClick={() => {
                  void exportCsv();
                }}
              >
                导出 CSV
              </Button>
            ) : null}
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={tab === 'calls' ? logs.refreshing : audit.refreshing}
              onClick={tab === 'calls' ? logs.reload : audit.reload}
            >
              刷新
            </Button>
          </Space>
        }
      />

      <Tabs
        activeKey={tab}
        onChange={(key) => setTab(key === 'audit' ? 'audit' : 'calls')}
        items={[
          {
            key: 'calls',
            label: '调用记录',
            children: (
              <>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    gap: tokens.space.sm,
                    marginBottom: tokens.space.md,
                  }}
                >
                  <DatePicker.RangePicker
                    size="small"
                    showTime={{ format: 'HH:mm' }}
                    allowClear={false}
                    value={range}
                    onChange={(values) => {
                      const start = values?.[0];
                      const end = values?.[1];
                      if (!start || !end) return;
                      setRange([start, end]);
                      setPage(1);
                    }}
                  />
                  <Select
                    allowClear
                    size="small"
                    style={{ width: 160 }}
                    placeholder="全部上游"
                    value={upstreamId}
                    options={(upstreams.data?.items ?? []).map((item: Upstream) => ({
                      label: item.name,
                      value: item.id,
                    }))}
                    onChange={(value: string | undefined) => {
                      setUpstreamId(value);
                      setPage(1);
                    }}
                  />
                  <Select
                    allowClear
                    size="small"
                    style={{ width: 160 }}
                    placeholder="全部用户组"
                    value={groupId}
                    options={(groups.data?.items ?? []).map((item: Group) => ({
                      label: item.name,
                      value: item.id,
                    }))}
                    onChange={(value: string | undefined) => {
                      setGroupId(value);
                      setPage(1);
                    }}
                  />
                  <Tooltip title="按模型名精确匹配">
                    <Input.Search
                      size="small"
                      allowClear
                      style={{ width: 190 }}
                      placeholder="模型名"
                      onSearch={(value) => {
                        setModel(value);
                        setPage(1);
                      }}
                    />
                  </Tooltip>
                  <Tooltip title="契约只支持精确状态码匹配，没有「只看失败」这种区间参数">
                    <Select
                      allowClear
                      size="small"
                      style={{ width: 150 }}
                      placeholder="全部状态码"
                      value={status}
                      options={STATUS_OPTIONS.map((value) => ({ label: String(value), value }))}
                      onChange={(value: number | undefined) => {
                        setStatus(value);
                        setPage(1);
                      }}
                    />
                  </Tooltip>
                  <Tooltip title="默认不查已软删的上游 / key / 组；打开后按 id 过滤仍可命中（C4 保留了日志外键）">
                    <Segmented
                      size="small"
                      value={includeDeleted ? 'with' : 'without'}
                      options={[
                        { label: '不含已删', value: 'without' },
                        { label: '含已删', value: 'with' },
                      ]}
                      onChange={(value) => {
                        setIncludeDeleted(value === 'with');
                        setPage(1);
                      }}
                    />
                  </Tooltip>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    共 {formatCount(logs.data?.total ?? 0)} 条
                  </Text>
                </div>

                {logs.error && logs.data ? (
                  <div style={{ marginBottom: tokens.space.md }}>
                    <ErrorState error={logs.error} onRetry={logs.reload} title="刷新失败，以下为上一次成功的数据" />
                  </div>
                ) : null}

                {logs.loading ? (
                  <LoadingState tip="正在查询调用记录…" minHeight={320} />
                ) : logs.error && !logs.data ? (
                  <ErrorState error={logs.error} onRetry={logs.reload} variant="page" title="调用记录加载失败" />
                ) : (
                  <Table<CallLog>
                    rowKey="id"
                    size="small"
                    columns={callColumns}
                    dataSource={logs.data?.items ?? []}
                    loading={logs.refreshing}
                    scroll={{ x: 1240 }}
                    pagination={{
                      current: page,
                      pageSize,
                      total: logs.data?.total ?? 0,
                      showSizeChanger: true,
                      pageSizeOptions: [20, 50, 100, 200],
                      showTotal: (total) => `共 ${total} 条记录`,
                      onChange: (nextPage, nextSize) => {
                        setPage(nextPage);
                        setPageSize(nextSize);
                      },
                    }}
                    locale={{
                      emptyText: (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="该时间区间与筛选条件下没有调用记录。"
                        />
                      ),
                    }}
                  />
                )}
              </>
            ),
          },
          {
            key: 'audit',
            label: '审计',
            children: (
              <>
                <Text type="secondary" style={{ display: 'block', marginBottom: tokens.space.md, fontSize: 12 }}>
                  审计最小集：登录 / 登出 / 所有写操作。只读，不可编辑、不可删除。
                </Text>

                {audit.error && audit.data ? (
                  <div style={{ marginBottom: tokens.space.md }}>
                    <ErrorState error={audit.error} onRetry={audit.reload} title="刷新失败，以下为上一次成功的数据" />
                  </div>
                ) : null}

                {audit.loading ? (
                  <LoadingState tip="正在加载审计日志…" minHeight={320} />
                ) : audit.error && !audit.data ? (
                  <ErrorState error={audit.error} onRetry={audit.reload} variant="page" title="审计日志加载失败" />
                ) : (
                  <Table<AuditEntry>
                    rowKey="id"
                    size="small"
                    columns={auditColumns}
                    dataSource={audit.data?.items ?? []}
                    loading={audit.refreshing}
                    scroll={{ x: 900 }}
                    pagination={{
                      current: auditPage,
                      pageSize: PAGE_SIZE_DEFAULT,
                      total: audit.data?.total ?? 0,
                      showSizeChanger: false,
                      showTotal: (total) => `共 ${total} 条`,
                      onChange: (nextPage) => setAuditPage(nextPage),
                    }}
                    locale={{
                      emptyText: (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有审计记录。" />
                      ),
                    }}
                  />
                )}
              </>
            ),
          },
        ]}
      />
    </>
  );
}
