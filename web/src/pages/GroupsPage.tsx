/**
 * 用户组 —— 建组、发 key、配额设置。
 *
 * 契约纪律：
 * - C1：建组**自动签发**第一把网关 key，明文只在创建响应里出现一次；
 *   页面用一次性弹窗展示（`GatewayKeyRevealModal`），关闭即从内存丢弃。
 * - 配额 `null` = **不限**，不是 0。`0` 是「全部拒绝」，两者在 UI 上必须能分开看。
 * - 组里的网关 key 明文永不再取回：本页只显示 `gatewayKeyMasked`，
 *   逐把的掩码列表在 `GroupKeysDrawer` 里（同一份 §4 数据，没有第二个明文来源）。
 *
 * v1.15.7（ADR-0036）：这一行从此是**两个粒度** —— 上面那层是"这个组建不建得起来"，
 * 下面那层（「共 N 把 · 管理」抽屉）是"这一把还好不好用"。此前只有前一层，
 * 于是 `resetKey` / `removeKey` 两个端点虽然一直存在、却没有任何界面出口。
 * **Base URL 也从这一页给出去**：签发/重置弹窗里与明文并排显示（带 `/v1`），
 * 因为抄走 key 的人下一个问题永远是"填哪儿"。
 */
import { PlusOutlined } from '@ant-design/icons';
import { App, Button, Empty, Input, Progress, Space, Switch, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';

import { accessInfoApi, groupsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { PAGE_SIZE_DEFAULT, type Group, type QuotaValue } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import {
  GatewayKeyRevealModal,
  GroupFormModal,
  type GatewayKeyReveal,
} from '@/pages/groups/GroupModals';
import { GroupKeysDrawer } from '@/pages/groups/GroupKeysDrawer';
import { GroupModelsDrawer } from '@/pages/groups/GroupModelsDrawer';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCompact, formatCount, formatIso, formatRelative } from '@/utils/format';
import { gatewayUrlsOf } from '@/utils/gatewayUrl';

const { Text } = Typography;

/** `null`（不限）与 `0`（全部拒绝）用两种观感，不能都渲染成数字。 */
function QuotaCell({ value }: { value: QuotaValue }) {
  if (value === null) {
    return (
      <Tooltip title="未设置上限（不限）">
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
  /** 有值 = 该组的 key 管理抽屉打开（v1.15.7）。 */
  const [keysOf, setKeysOf] = useState<Group | null>(null);
  /** 有值 = 该组的模型授权抽屉打开（v1.15.8）。 */
  const [modelsOf, setModelsOf] = useState<Group | null>(null);

  const queryKey = JSON.stringify({ q, page, pageSize });
  const list = useResource(() => groupsApi.list(JSON.parse(queryKey)), [queryKey]);

  /*
    带 `/v1` 的 Base URL。签发 / 重置给出明文时一并展示 —— 抄走 key 的人下一个问题
    永远是"填哪儿"，而在那一帧里两个值只有这里同时握得住（v1.15.7 / ADR-0036 决策 1）。
    这个读面失败**不阻塞**发 key（拿不到就只是不显示那一行地址）：为它把「签发」这一
    主要动作打成错态，是拿次要功能挡主要功能（与建号弹窗的组下拉同一条纪律）。
  */
  const access = useResource((signal) => accessInfoApi.get({ signal }), []);
  const baseUrl = useMemo(() => gatewayUrlsOf(access.data)?.baseUrl ?? null, [access.data]);

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
      baseUrl,
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
          {/* 「共 N 把」是个入口而不只是说明：N > 1 时这一格分不清哪把是哪把，
              逐把的重置 / 吊销只在抽屉里（v1.15.7 / ADR-0036 决策 2）。 */}
          <Button
            size="small"
            type="link"
            style={{ padding: 0, height: 'auto', fontSize: 11 }}
            onClick={() => setKeysOf(row)}
          >
            共 {row.keyCount} 把 · 管理
          </Button>
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
      /*
        授权模型（v1.15.8 / ADR-0037）。`null` = 不限，与 `0` 是完全不同的事 ——
        所以这一格与配额格同一形状：不限就写「不限」，绝不给一个 0 或长度。
        和「共 N 把 · 管理」一样，下面那行按钮是**入口**：没有它，§4 的 GET/PUT
        group models 两个端点就又没有界面出口，而"授权"就成了一个只能靠 API 改的属性。
      */
      title: '授权模型',
      dataIndex: 'authorizedModels',
      width: 150,
      render: (_: unknown, row) => {
        const names = row.authorizedModels;
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {names === null ? (
              <Tooltip title="未设置授权（null = 不限）：本组可用全部已启用模型">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  不限
                </Text>
              </Tooltip>
            ) : (
              <Tooltip title={names.join('、')}>
                <Text style={{ fontSize: 12 }}>{formatCount(names.length)} 个模型</Text>
              </Tooltip>
            )}
            <Button
              size="small"
              type="link"
              style={{ padding: 0, height: 'auto', fontSize: 11 }}
              onClick={() => setModelsOf(row)}
            >
              {names === null ? '设置授权' : '调整授权'}
            </Button>
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
          scroll={{ x: 1370 }}
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
          /*
            建组响应里的明文是**嵌套**的（`gatewayKey.gatewayKey`），与 §4
            「再签发一把」那个顶层四格不同形 —— 两种形状在这里各出现一次，抄错一边
            就是运行期 `Objects are not valid as a React child`（v1.15.7 验收实测到的
            P0：类型说 string、运行期是对象，所以四闸全绿也拦不住）。
            掩码同样取服务端给的那个，不自己从明文切。
          */
          setReveal({
            gatewayKey: created.gatewayKey.gatewayKey,
            maskedKey: created.gatewayKey.maskedKey,
            baseUrl,
            context: `用户组「${created.name}」创建成功，这是它的第一把网关 key。`,
          });
        }}
      />

      {/* 明文只在本次签发后驻留内存；关闭即置 null，不缓存、不写 localStorage。 */}
      <GatewayKeyRevealModal reveal={reveal} onClose={() => setReveal(null)} />

      {/*
        逐把 key 管理（v1.15.7 / ADR-0036）。`onChanged` = 抽屉里的动作改了 key 集合 →
        整组行重拉（keyCount / gatewayKeyMasked 是服务端算的派生值，前端不自己推算）。
      */}
      <GroupKeysDrawer
        group={keysOf}
        baseUrl={baseUrl}
        onClose={() => setKeysOf(null)}
        onRevealed={setReveal}
        onChanged={() => {
          if (keysOf !== null) list.reload();
        }}
      />

      {/*
        模型授权（v1.15.8 / ADR-0037）。**就地更新那一行**，不整页刷新 ——
        响应里的 `group` 已经是服务端算好的新状态（`authorizedModels` 变了、`revision` +1），
        所以这里用 `mutate` 换掉 `items` 里的同一行就够了（v1.15.4 / ADR-0035 的纪律）。
        为什么不能只 `list.reload()`：那会把整页打回转圈，而这只是组行上一个字段的变化；
        也不能就地更新后不更新 `modelsOf`（抽屉的 props 是那一行），否则连保存两次
        第二次会拿旧 `revision` 撞 409 —— 这正是共享版本号要防的事，得按服务端回的值对齐。
      */}
      <GroupModelsDrawer
        group={modelsOf}
        onClose={() => setModelsOf(null)}
        onSaved={(updated) => {
          setModelsOf(updated);
          list.mutate((prev) =>
            prev === null
              ? prev
              : { ...prev, items: prev.items.map((item) => (item.id === updated.id ? updated : item)) },
          );
        }}
      />

    </>
  );
}
