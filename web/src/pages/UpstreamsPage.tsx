/**
 * 上游管理 —— Base URL 的增删改、余额查询模板、余额合计。
 *
 * 契约纪律：
 * - 余额是「防造假」主战场：`totalBalance=null` 表示该上游所有 balance 类 key 都未知，
 *   **不是 0**；`balanceUnknownKeyCount` 必须单独呈现，让管理员看得见「合计是不完整的」。
 * - `token-plan` 类 key 不进金额合计（ADR-0003 规则 1），只在旁边单列数量。
 * - 删上游：上游下有 key **或模型档案**时，后端 409 `UPSTREAM_HAS_KEYS`，
 *   `details: {keyCount, modelCount}` 两个计数都给（契约 v1.2.2）。这里拿它做二次确认再发 `force=true`。
 *   `force` 不是软删 —— ADR-0016：单事务按依赖序**物理删除整棵子树**
 *   （`key_runtime → upstream_keys → models → upstreams`）。所以文案必须说出
 *   「模型档案连同手改的开关 / 价格一起没」，且 `modelCount` 拿不到时**不写模型数**（不把「不知道」写成 0）。
 * - 写请求一律带 `revision`；409 `REVISION_MISMATCH` 时提示并拉最新，避免对着旧版本反复提交。
 *
 * 「自动同步」列（T2 接线，契约 §14.1 / §14.3）：
 * - 这一列是**只读**的。自动同步开关与基准间隔来自服务端 `BALANCE_SYNC_MINUTES`
 *   （`0` = 关闭），经 `GET /api/stats/balance/sync` 的 `auto` 回显；
 *   **契约里不存在** `min_interval_minutes` 这类每上游可写字段，也**没有**写这个配置的端点 ——
 *   所以这里只显示 + 指路部署配置，不造一个点了就 404 的假开关。
 * - 手动「查余额」三个端点语义**零变更**（§14.1），本页只把运行态（退避 / 单飞 / 上次同步）显示出来。
 * - 但「查余额」**不是一次请求**：它是该上游被查到的 key **一把一次**的一批，而出口预算与数据面共用
 *   同一条（§16.7 Tier 1.5 / ADR-0021）⇒ §14.7 要求二次确认、且必须说出代价。走
 *   `confirmManualRefresh`（那句"量级由服务端给"的纪律文案只有一个落点），本页不自造请求数。
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
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { statsApi, upstreamsApi } from '@/api/endpoints';
import { describeError, isApiError } from '@/api/http';
import { useAction, useResource } from '@/api/hooks';
import { useTaskPolling } from '@/api/useTaskPolling';
import {
  PAGE_SIZE_DEFAULT,
  type BalanceRefreshResult,
  type BalanceSyncUpstreamState,
  type HintCode,
  type Upstream,
} from '@/api/types';
import { BalanceDriftBanner } from '@/components/BalanceDriftBanner';
import { BalanceHint } from '@/components/BalanceHint';
import { BalanceText } from '@/components/BalanceText';
import { confirmManualRefresh } from '@/components/ManualRefreshConfirm';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { UpstreamModal } from '@/pages/upstreams/UpstreamModal';
import { tokens } from '@/theme/tokens';
import { formatCount, formatIso, formatPercent, formatRelative } from '@/utils/format';

const { Text } = Typography;

interface SubtreeCounts {
  /** 未软删的 key 数（与 §2 `Upstream.keyCount` 同源）。后端没给时退回列表行自身的计数。 */
  keyCount: number;
  /** 模型档案数。后端未返回（早于 v1.2.2）时是 `null`，**不补 0**。 */
  modelCount: number | null;
}

/**
 * 解析 `409 UPSTREAM_HAS_KEYS` 的 `details: {keyCount, modelCount}`（契约 v1.2.2）。
 *
 * 两个计数都得读：`keyCount` 可能是 0 而 `modelCount > 0`（上游只同步了模型、没建 key 是常态），
 * 只看 key 数会让管理员读成「没什么可删的」，而实际连模型档案会一起删。
 */
function detailCounts(details: unknown, row: Upstream): SubtreeCounts {
  const pick = (key: 'keyCount' | 'modelCount'): number | null => {
    if (details === null || typeof details !== 'object' || !(key in details)) return null;
    const value = (details as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  return { keyCount: pick('keyCount') ?? row.keyCount, modelCount: pick('modelCount') };
}

/** 二次确认正文：先给「删掉什么」的数量，再给「丢掉什么」的不可逆代价。 */
function DeleteUpstreamBody({ name, counts }: { name: string; counts: SubtreeCounts }) {
  const parts: string[] = [];
  if (counts.keyCount > 0) parts.push(`Key ${counts.keyCount} 个`);
  if (counts.modelCount !== null && counts.modelCount > 0) {
    parts.push(`模型档案 ${counts.modelCount} 个`);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
      <Text>
        将物理删除「{name}」整棵子树
        {parts.length > 0 ? `：${parts.join(' · ')}` : ''}。
      </Text>
      <Text type="secondary" style={{ fontSize: 12 }}>
        计数只含未软删的 key；此前软删、仍挂在库上的 key 行也会一并消失 —— 行级外键不解除，留着就删不掉上游。
      </Text>
      <Text type="secondary" style={{ fontSize: 12 }}>
        模型档案随上游一起消失，
        <Text style={{ color: tokens.color.warning }}>你在档案卡上手改的开关 / 价格会一并丢失</Text>
        ，且不可撤销。
      </Text>
      <Text type="secondary" style={{ fontSize: 12 }}>
        历史调用日志不受影响：日志行自带 key 掩码与模型名，本次删除由审计日志留痕。
      </Text>
    </div>
  );
}

export default function UpstreamsPage() {
  const { message, modal } = App.useApp();
  const { run, isPending } = useAction();
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Upstream | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [refreshHint, setRefreshHint] = useState<{
    hintCode: HintCode;
    hint: string | null;
    retryAfterSeconds: number | null;
  } | null>(null);

  const queryKey = JSON.stringify({ q, enabled, page, pageSize });
  const list = useResource(
    () => upstreamsApi.list(JSON.parse(queryKey)),
    [queryKey],
  );

  /**
   * §14.3 只读观测口：每上游的自动同步运行态（退避 / 单飞 / 上次同步）。
   *
   * 与列表**分开取数**：它是观测信息，失败只降级这一列，不该把整张表打成错误态。
   * 也**不在这里放任何写入口** —— 契约里没有配置自动同步节奏的端点（那是部署侧
   * `BALANCE_SYNC_MINUTES` 的事），做个点了就 404 的开关才是骗人。
   */
  const syncStatus = useResource(() => statsApi.balanceSync({}), []);
  const syncByUpstream = useMemo(() => {
    const map = new Map<string, BalanceSyncUpstreamState>();
    for (const item of syncStatus.data?.upstreams ?? []) map.set(item.upstreamId, item);
    return map;
  }, [syncStatus.data]);

  const task = useTaskPolling((finished) => {
    const result = finished.result as BalanceRefreshResult | null;
    setRefreshHint(
      result && result.hintCode
        ? { hintCode: result.hintCode, hint: result.hint, retryAfterSeconds: result.retryAfterSeconds ?? null }
        : null,
    );
    message.success('余额查询完成');
    list.reload();
    // 手动刷新成功同样归零退避（§14.1），所以这列必须跟着重取，否则会显示过期的失败计数。
    syncStatus.reload();
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
   * 「查余额」先要一次机会成本（§14.7）。代价三样必须说全：**真打上游**、**占出口预算**、
   * 可能**挤到数据面**；而"几次请求"不在这里预告 —— 那个数只有服务端的 result 说了算。
   */
  const confirmRefreshBalance = (row: Upstream): void => {
    confirmManualRefresh(modal, {
      title: `查「${row.name}」的余额？`,
      scope: '打谁：这一条上游名下全部配了余额查询方式的 key（没配的会被跳过）',
      cost: '会真的打上游，而且这是一“批”：该上游被查到的 key 一把一次请求（§14.7）。出口预算与网关数据面共用同一条 ⇒ key 多时可能挤到客户端流量。',
      onOk: () => refreshBalance(row),
    });
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
          const counts = detailCounts(error.details, row);
          modal.confirm({
            title: `「${row.name}」下还有从属资源，确定一并删除？`,
            width: 480,
            content: <DeleteUpstreamBody name={row.name} counts={counts} />,
            okText: '连同从属资源删除',
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
      title: (
        <Tooltip title="自动同步运行态（契约 §14.3，只读）。间隔 / 抖动 / 退避是服务端配置的回显，前端不自算；开关与间隔由部署侧 BALANCE_SYNC_MINUTES 决定，管理面没有写入口。">
          <span>自动同步</span>
        </Tooltip>
      ),
      key: 'autoSync',
      width: 156,
      render: (_: unknown, row) => {
        const sync = syncStatus.data;
        const state = syncByUpstream.get(row.id);
        // 状态取不到就说取不到 —— 不把它渲染成「已关闭」（缺省不是证据）。
        if (!sync) {
          return syncStatus.error ? (
            <Tooltip title="自动同步状态加载失败，这一列暂时未知（不代表该上游已关闭自动同步）。">
              <Text type="secondary" style={{ fontSize: 12 }}>
                未知
              </Text>
            </Tooltip>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              …
            </Text>
          );
        }
        if (!sync.auto.enabled) {
          return (
            <Tooltip title="自动同步整体已关闭（BALANCE_SYNC_MINUTES=0）。手动「查余额」不受影响。">
              <Tag
                bordered={false}
                style={{
                  marginInlineEnd: 0,
                  background: tokens.tint.neutral,
                  color: tokens.color.textSecondary,
                }}
              >
                已关闭
              </Tag>
            </Tooltip>
          );
        }
        return (
          <Space direction="vertical" size={2}>
            <Text style={{ fontSize: 12 }}>{`每 ${sync.auto.intervalMinutes} 分钟`}</Text>
            {state?.inFlight ? (
              <Text style={{ fontSize: 11, color: tokens.color.info }}>同步中</Text>
            ) : null}
            {state && state.consecutiveFailures > 0 ? (
              <Tooltip
                title={
                  state.nextAttemptAt
                    ? `连续失败进入指数退避，下次自动尝试 ${formatIso(state.nextAttemptAt)}。手动查询仍可立即发起。`
                    : '连续失败中；任一次拿到值即归零。'
                }
              >
                <Text style={{ fontSize: 11, color: tokens.color.warning }}>
                  {`连续失败 ${formatCount(state.consecutiveFailures)} 次`}
                </Text>
              </Tooltip>
            ) : null}
            {state?.lastSyncedAt ? (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {`上次 ${formatRelative(state.lastSyncedAt)}`}
              </Text>
            ) : (
              <Text type="secondary" style={{ fontSize: 11 }}>
                尚未同步
              </Text>
            )}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 260,
      render: (_: unknown, row) => (
        <Space size={tokens.space.sm}>
          {/*
            账号面入口**只由 `supplier` 这一个字段决定**（§15.12 锚 1）——
            不解析 Base URL 猜供应商。不是 tierflow 的上游这里连按钮都不出现：
            画一个点进去全是"不是供应商账号型"的按钮，等于把一次拒绝做成一个功能。
          */}
          {row.supplier === 'tierflow' ? (
            <Tooltip title="供应商账号池：账号 → 池内 key / 套餐（契约 §15）">
              <Button
                size="small"
                type="link"
                style={{ padding: 0 }}
                onClick={() => {
                  navigate(`/upstreams/${row.id}/accounts`);
                }}
              >
                账号池
              </Button>
            </Tooltip>
          ) : null}
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
                confirmRefreshBalance(row);
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
      {syncStatus.data ? (
        <Tooltip title="自动同步的生效参数由服务端回显（契约 §14.3），前端不得自算间隔 / 抖动 / 退避。要改间隔请改部署侧 BALANCE_SYNC_MINUTES —— 管理面没有写入口。">
          <Text type="secondary" style={{ fontSize: 12 }}>
            {syncStatus.data.auto.enabled
              ? `自动同步：每 ${syncStatus.data.auto.intervalMinutes} 分钟 ±${formatPercent(
                  syncStatus.data.auto.jitterRatio,
                  0,
                )}（退避上限 ${syncStatus.data.auto.backoffCapMinutes} 分钟）`
              : '自动同步：已关闭（仅手动查询）'}
          </Text>
        </Tooltip>
      ) : null}
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

      {/*
        余额漂移横幅（契约 §14.4）。数据**复用本页已经取到的那一份** `statsApi.balanceSync` ——
        再发一次请求换来的只是"两个数字可能不一致"。取不到时**整条不渲染**：
        渲染一条"无提示"会把"没加载出来"画成"这轮健康"（缺省不是证据）。
      */}
      {syncStatus.data ? (
        <BalanceDriftBanner drift={syncStatus.data.drift} upstreams={syncStatus.data.upstreams} />
      ) : null}

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
          <BalanceHint
            hintCode={refreshHint.hintCode}
            hint={refreshHint.hint}
            retryAfterSeconds={refreshHint.retryAfterSeconds}
          />
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
          scroll={{ x: 1340 }}
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
