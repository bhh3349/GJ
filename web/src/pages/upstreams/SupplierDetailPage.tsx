/**
 * 供应商专属页 —— 路由 `/upstreams/:id`（侧栏「上游管理」子菜单里的每一个供应商）。
 *
 * 与「全部供应商」列表页（`/upstreams`）的分工：列表页回答"我有哪些上游"，
 * 本页回答"这一个上游现在什么状态、怎么动它"。
 *
 * 纪律（逐条来自契约，别在此处"顺手"加料）：
 * - **余额口径分列**：`totalBalance = Σ账号 + Σ无账号归属的 key`（§15.6 / ADR-0018 决策 3），
 *   所以 `accountsBalance` / `keysBalance` 是**拆解**、不是额外的一份钱。两者**不相加**。
 * - `totalBalance === null` = 全部未知，**不是 0**。未知 key 数单独一行。
 * - token-plan 类 key 不进金额合计，只单列数量（ADR-0003 规则 1）。
 * - **账号面判据只有 `hasSupplierAccountPanel(supplier)` 一个函数**（§15.12 锚 1）：不 parse `baseUrl`、不猜、不比某一家。
 * - 「自动同步」是**只读**：开关与间隔来自服务端 `BALANCE_SYNC_MINUTES`，契约里没有写它的端点，
 *   所以这里只显示 + 指路，不造一个点了就 404 的假开关。
 * - 「查余额」不是一次请求（是"被查到的 key 一把一次"的一批，出口预算与数据面共用，§14.7 / §16.7）
 *   ⇒ 走 `confirmManualRefresh` 二次确认，且**不预告请求数**（那个数只有服务端说了算）。
 * - key 的**写**只有 `enabled`（带 `revision` 乐观锁）；建档 / 删除 / 批量仍在 Key 管理页做，
 *   本页只把这一上游的 key 列出来并就地开关，避免同一个动线在两页各长一套。
 * - 删除走共享实现 `deleteUpstream()`（含 `409 UPSTREAM_HAS_KEYS` 的 `{keyCount, modelCount}` 分支）。
 */
import {
  ArrowLeftOutlined,
  CloudServerOutlined,
  EditOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { keysApi, statsApi, upstreamsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { useTaskPolling } from '@/api/useTaskPolling';
import {
  hasSupplierAccountPanel,
  supplierLabel,
  PAGE_SIZE_MAX,
  type BalanceRefreshResult,
  type BalanceSyncUpstreamState,
  type HintCode,
  type KeyCategory,
  type Upstream,
  type UpstreamKey,
} from '@/api/types';
import { BalanceHint } from '@/components/BalanceHint';
import { BalanceText } from '@/components/BalanceText';
import { HealthTag, failureReasonLabel } from '@/components/HealthTag';
import { confirmManualRefresh } from '@/components/ManualRefreshConfirm';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { deleteUpstream } from '@/pages/upstreams/deleteUpstream';
import { SupplierSubscriptionsTable } from '@/pages/upstreams/SupplierSubscriptionsTable';
import { UpstreamModal } from '@/pages/upstreams/UpstreamModal';
import { tokens } from '@/theme/tokens';
import { balanceReadiness } from '@/utils/balanceReadiness';
import { formatCompact, formatCount, formatIso, formatPercent, formatRelative } from '@/utils/format';

const { Text } = Typography;

/** 一行「标签 + 值」，用于概览区的密集信息。 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 132 }}>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {label}
      </Text>
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );
}

interface KeyColumnProps {
  onToggle: (row: UpstreamKey, next: boolean) => void;
  isPending: (key: string) => boolean;
}

/** 本上游的 key 列表。**可写的只有启用状态**；健康态由网关决定，只读展示。 */
function keyColumns({ onToggle, isPending }: KeyColumnProps): ColumnsType<UpstreamKey> {
  return [
    {
      title: '标签 / Key',
      dataIndex: 'label',
      render: (_: string, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 12 }}>{row.label || '（无标签）'}</Text>
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>
            {row.maskedKey}
          </Text>
        </div>
      ),
    },
    {
      title: '分类',
      dataIndex: 'category',
      width: 104,
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
      width: 190,
      render: (_: unknown, row) =>
        row.category === 'token-plan' ? (
          row.tokenPlan ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <Text style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatCompact(row.tokenPlan.remainingTokens)} tokens
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {row.tokenPlan.expiresAt ? `到期 ${formatIso(row.tokenPlan.expiresAt)}` : '无到期时间'}
              </Text>
            </div>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              套餐信息缺失
            </Text>
          )
        ) : (
          <BalanceText
            value={row.balance}
            currency={row.balanceCurrency ?? 'CNY'}
            source={row.balanceSource}
            updatedAt={row.balanceUpdatedAt}
            unlimited={row.unlimited}
            showMeta
            strong
          />
        ),
    },
    {
      title: '健康态',
      dataIndex: 'health',
      width: 168,
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
              {`连续失败 ${formatCount(row.consecutiveFailures)} 次 · ${failureReasonLabel(row.lastFailureReason)}`}
            </Text>
          ) : null}
        </div>
      ),
    },
    {
      title: '今日 token',
      dataIndex: 'todayTokens',
      width: 104,
      align: 'right',
      render: (value: number) => (
        <Text style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCompact(value)}</Text>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 84,
      render: (_: unknown, row) => (
        <Tooltip title={row.deletedAt ? '该 key 已删除，不再参与路由' : '管理端只写启用状态；健康态由网关决定'}>
          <Switch
            size="small"
            checked={row.enabled}
            disabled={Boolean(row.deletedAt)}
            loading={isPending(`key:${row.id}`)}
            onChange={(checked) => {
              onToggle(row, checked);
            }}
          />
        </Tooltip>
      ),
    },
  ];
}

export default function SupplierDetailPage() {
  const { id: upstreamId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const { run, isPending } = useAction();

  const [tab, setTab] = useState('overview');
  const [formOpen, setFormOpen] = useState(false);
  const [refreshHint, setRefreshHint] = useState<{
    hintCode: HintCode;
    hint: string | null;
    retryAfterSeconds: number | null;
  } | null>(null);

  const upstream = useResource(
    () => (upstreamId ? upstreamsApi.get(upstreamId) : Promise.resolve(null)),
    [upstreamId],
  );

  const supplySync = useResource(
    () => statsApi.balanceSync(upstreamId ? { upstreamId } : {}),
    [upstreamId],
  );
  const syncState: BalanceSyncUpstreamState | undefined = useMemo(
    () => supplySync.data?.upstreams.find((item) => item.upstreamId === upstreamId),
    [supplySync.data, upstreamId],
  );

  /** 本上游的 key 列表（与 Key 管理页同一个端点，只是带了 upstreamId）。 */
  const keys = useResource(
    () => (upstreamId ? keysApi.list({ upstreamId, pageSize: PAGE_SIZE_MAX }) : Promise.resolve(null)),
    [upstreamId],
  );

  const task = useTaskPolling((finished) => {
    const result = finished.result as BalanceRefreshResult | null;
    setRefreshHint(
      result && result.hintCode
        ? {
            hintCode: result.hintCode,
            hint: result.hint,
            retryAfterSeconds: result.retryAfterSeconds ?? null,
          }
        : null,
    );
    message.success('余额查询完成');
    upstream.reload();
    keys.reload();
    supplySync.reload();
  });

  const patchKey = async (row: UpstreamKey, next: boolean): Promise<void> => {
    await run(
      `key:${row.id}`,
      () => keysApi.update(row.id, { enabled: next, revision: row.revision }),
      next ? '已启用' : '已禁用',
    );
    keys.reload();
  };

  /**
   * 「查余额」先要一次机会成本（§14.7）。代价三样必须说全：**真打上游**、**占出口预算**、
   * 可能**挤到数据面**；"几次请求"不预告 —— 那个数只有服务端的 result 说了算。
   */
  const confirmRefreshBalance = (row: Upstream): void => {
    const ready = balanceReadiness(row);
    if (!ready.queryable) {
      // 无可用查询方式时后端当场 422 拒绝，不会产生一个「全部跳过」的任务。
      // 把一次注定的失败做成一个可点的按钮没有意义，这里直接把原因说清楚。
      message.warning(ready.reason ?? '这个上游现在查不了余额');
      return;
    }
    confirmManualRefresh(modal, {
      title: `查「${row.name}」的余额？`,
      scope: `打谁：这一条上游名下全部 ${row.keyCount} 把 key，按当前生效的查询方式逐把查`,
      onOk: async () => {
        const accepted = await run('refresh', () => upstreamsApi.refreshBalance(row.id), '已提交余额查询任务');
        if (accepted !== null) task.start(accepted.taskId);
      },
    });
  };

  const toggleEnabled = async (row: Upstream): Promise<void> => {
    const next = !row.enabled;
    await run(
      'patch',
      () => upstreamsApi.update(row.id, { enabled: next, revision: row.revision }),
      next ? '已启用' : '已禁用',
    );
    // 无论成败都拉最新：成功要回显服务端真值，失败多半是 409 乐观锁冲突。
    upstream.reload();
  };

  const remove = (row: Upstream): void => {
    deleteUpstream({
      modal,
      upstream: row,
      onDeleted: () => {
        message.success(`已删除「${row.name}」`);
        // 这个上游没了，专属页就没有落点 —— 回列表，不留在空页上。
        navigate('/upstreams', { replace: true });
      },
      onFailure: (text) => {
        message.error(text);
      },
    });
  };

  if (upstreamId === undefined) {
    return (
      <ErrorState
        variant="page"
        error={{ code: 'INVALID_PARAM', message: '路由里缺少上游 id' }}
        onRetry={() => {
          navigate('/upstreams');
        }}
        title="无法定位上游"
      />
    );
  }

  if (upstream.loading && !upstream.data) {
    return (
      <>
        <PageHeader title="供应商" />
        <LoadingState tip="正在加载上游信息…" minHeight={320} />
      </>
    );
  }

  if (upstream.error && !upstream.data) {
    return (
      <>
        <PageHeader title="供应商" />
        <ErrorState
          error={upstream.error}
          onRetry={upstream.reload}
          variant="page"
          title="上游信息加载失败"
        />
      </>
    );
  }

  const row = upstream.data;
  if (!row) {
    return (
      <>
        <PageHeader title="供应商" />
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有取到该上游" />
      </>
    );
  }

  const isSupplier = hasSupplierAccountPanel(row.supplier);
  const auto = supplySync.data?.auto;
  const columns = keyColumns({ onToggle: (target, next) => void patchKey(target, next), isPending });

  const overview = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
      <Card
        size="small"
        title="上游信息"
        extra={
          <Button
            size="small"
            icon={<EditOutlined />}
            onClick={() => {
              setFormOpen(true);
            }}
          >
            编辑
          </Button>
        }
      >
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, lg: 3 }}
          items={[
            {
              key: 'baseUrl',
              label: 'Base URL',
              children: (
                <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }} copyable={{ text: row.baseUrl }}>
                  {row.baseUrl}
                </Text>
              ),
            },
            {
              key: 'id',
              label: 'ID',
              children: <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{row.id}</Text>,
            },
            {
              key: 'supplier',
              label: '供应商',
              children: isSupplier ? (
                <Tag bordered={false} style={{ background: tokens.tint.info, color: tokens.color.info }}>
                  {supplierLabel(row.supplier)}
                </Tag>
              ) : (
                <Text type="secondary">通用</Text>
              ),
            },
            {
              key: 'enabled',
              label: '启用',
              children: (
                <Tooltip title="禁用后网关不再选用该上游下的任何 key">
                  <Switch
                    size="small"
                    checked={row.enabled}
                    loading={isPending('patch')}
                    onChange={() => {
                      void toggleEnabled(row);
                    }}
                  />
                </Tooltip>
              ),
            },
            {
              key: 'updatedAt',
              label: '更新于',
              children: (
                <Tooltip title={formatIso(row.updatedAt)}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {formatRelative(row.updatedAt)}
                  </Text>
                </Tooltip>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title="余额">
        <Space size={tokens.space.xl} wrap>
          <Field label="余额合计">
            <BalanceText value={row.totalBalance} strong />
          </Field>
          <Field label="账号级合计">
            <BalanceText value={row.accountsBalance} />
          </Field>
          <Field label="key 级合计">
            <BalanceText value={row.keysBalance} />
          </Field>
          <Field label="Key">{`${formatCount(row.enabledKeyCount)} 启用 / 共 ${formatCount(row.keyCount)}`}</Field>
          <Field label="未知余额的 key">{formatCount(row.balanceUnknownKeyCount)}</Field>
          <Field label="无限额度的 key">{formatCount(row.unlimitedKeyCount)}</Field>
          <Field label="不计金额的套餐类 key">{formatCount(row.tokenPlanKeyCount)}</Field>
        </Space>
        <div style={{ marginTop: tokens.space.sm, fontSize: 11, color: tokens.color.textTertiary }}>
          账号级与 key 级是合计的拆解，两者不相加；未知余额与无限额度的 key 都不计入合计。
        </div>
      </Card>

      <Card
        size="small"
        title="余额查询与自动同步"
        extra={
          <Space size={tokens.space.sm}>
            <Tooltip
              title={
                balanceReadiness(row).queryable
                  ? '按当前生效的查询方式逐把查该上游全部 key 的余额'
                  : balanceReadiness(row).reason
              }
            >
              <Button
                size="small"
                loading={isPending('refresh') || task.running}
                onClick={() => {
                  confirmRefreshBalance(row);
                }}
              >
                查余额
              </Button>
            </Tooltip>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={supplySync.refreshing}
              onClick={supplySync.reload}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Space size={tokens.space.xl} wrap>
          <Field label="查询方式">
            {row.balanceQuery?.enabled ? (
              <Tooltip
                title={`${row.balanceQuery.method} ${row.balanceQuery.url}（超时 ${row.balanceQuery.timeoutMs}ms）`}
              >
                <Tag bordered={false} style={{ background: tokens.tint.info, color: tokens.color.info }}>
                  已配置模板
                </Tag>
              </Tooltip>
            ) : row.balancePreset ? (
              <Tooltip title="内置余额查询来源（只读、可推导）。不配模板也能自动查询余额。">
                <Tag bordered={false} style={{ background: tokens.tint.success, color: tokens.color.success }}>
                  {`内置 · ${row.balancePreset.label}`}
                </Tag>
              </Tooltip>
            ) : (
              <Tooltip title="未配置模板查询，也未识别到内置来源：该上游的余额只能手动录入。">
                <Tag bordered={false} style={{ background: tokens.tint.neutral, color: tokens.color.textSecondary }}>
                  仅手动
                </Tag>
              </Tooltip>
            )}
          </Field>
          <Field label="自动同步">
            {supplySync.data ? (
              auto?.enabled ? (
                <Text style={{ fontSize: 13 }}>
                  {`每 ${auto.intervalMinutes} 分钟 ±${formatPercent(auto.jitterRatio, 0)}（退避上限 ${auto.backoffCapMinutes} 分钟）`}
                </Text>
              ) : (
                <Tooltip title="自动同步整体已关闭。手动「查余额」不受影响。">
                  <Tag bordered={false} style={{ background: tokens.tint.neutral, color: tokens.color.textSecondary }}>
                    已关闭
                  </Tag>
                </Tooltip>
              )
            ) : supplySync.error ? (
              <Tooltip title="自动同步状态加载失败，这一格暂时未知（不代表该上游已关闭自动同步）。">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  未知
                </Text>
              </Tooltip>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                …
              </Text>
            )}
          </Field>
          <Field label="最近同步">
            {syncState?.lastSyncedAt ? (
              <Tooltip title={formatIso(syncState.lastSyncedAt)}>
                <span>{formatRelative(syncState.lastSyncedAt)}</span>
              </Tooltip>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                尚未同步
              </Text>
            )}
          </Field>
          <Field label="运行态">
            {!supplySync.data ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                —
              </Text>
            ) : syncState?.inFlight ? (
              <Text style={{ fontSize: 12, color: tokens.color.info }}>同步中</Text>
            ) : syncState && syncState.consecutiveFailures > 0 ? (
              <Tooltip
                title={
                  syncState.nextAttemptAt
                    ? `连续失败进入指数退避，下次自动尝试 ${formatIso(syncState.nextAttemptAt)}。手动查询仍可立即发起。`
                    : '连续失败中；任一次拿到值即归零。'
                }
              >
                <Text style={{ color: tokens.color.warning, fontSize: 12 }}>
                  {`连续失败 ${formatCount(syncState.consecutiveFailures)} 次`}
                </Text>
              </Tooltip>
            ) : (
              <Text type="secondary" style={{ fontSize: 12 }}>
                正常
              </Text>
            )}
          </Field>
        </Space>
        <div style={{ marginTop: tokens.space.sm, fontSize: 11, color: tokens.color.textTertiary }}>
          自动同步的开关与间隔由服务端配置决定，管理面没有写入口；手动「查余额」随时可用。
        </div>
      </Card>

      <Space wrap>
        {isSupplier ? (
          <Button
            size="small"
            icon={<CloudServerOutlined />}
            onClick={() => {
              navigate(`/upstreams/${row.id}/accounts`);
            }}
          >
            账号池
          </Button>
        ) : null}
        <Button size="small" danger onClick={() => remove(row)}>
          删除这个上游
        </Button>
      </Space>
    </div>
  );

  const keysPane = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
      {keys.error && keys.data ? (
        <ErrorState error={keys.error} onRetry={keys.reload} title="刷新失败，以下为上一次成功的数据" />
      ) : null}
      {keys.loading ? (
        <LoadingState tip="正在加载 key 列表…" minHeight={240} />
      ) : keys.error && !keys.data ? (
        <ErrorState error={keys.error} onRetry={keys.reload} variant="page" title="Key 列表加载失败" />
      ) : (
        <Table<UpstreamKey>
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={keys.data?.items ?? []}
          loading={keys.refreshing}
          pagination={false}
          scroll={{ x: 960 }}
          locale={{
            emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="这个上游还没有 key。" />,
          }}
        />
      )}
      <Button
        size="small"
        type="link"
        style={{ padding: 0 }}
        onClick={() => {
          navigate('/keys');
        }}
      >
        去 Key 管理做新增、删除与批量操作
      </Button>
    </div>
  );

  const tabItems = [
    { key: 'overview', label: '概览', children: overview },
    { key: 'keys', label: 'Key 列表', children: keysPane },
    ...(isSupplier
      ? [
          {
            key: 'subscriptions',
            label: '套餐台账',
            children: (
              /* 台账自带账号掩码；这里不做 id→掩码 的二次翻译，免得为一个只读格多取一次账号列表。 */
              <SupplierSubscriptionsTable upstreamId={row.id} identifierOf={() => null} />
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title={row.name}
        extra={
          <Button
            size="small"
            icon={<ArrowLeftOutlined />}
            onClick={() => {
              navigate('/upstreams');
            }}
          >
            全部供应商
          </Button>
        }
      />

      {refreshHint ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <BalanceHint
            hintCode={refreshHint.hintCode}
            hint={refreshHint.hint}
            retryAfterSeconds={refreshHint.retryAfterSeconds}
          />
        </div>
      ) : null}

      {task.error ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={task.error} onRetry={task.refresh} title="余额查询任务查询失败" />
        </div>
      ) : null}

      {!isSupplier ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: tokens.space.md, background: tokens.tint.neutral, border: 'none' }}
          message="这个上游是通用型，没有账号池"
          description={
            <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
              要开通账号池，请编辑该上游、把「供应商」选成对应值。
            </Text>
          }
        />
      ) : null}

      <Tabs activeKey={tab} onChange={setTab} items={tabItems} />

      <UpstreamModal
        open={formOpen}
        editing={row}
        onClose={() => {
          setFormOpen(false);
        }}
        onSaved={() => {
          upstream.reload();
          keys.reload();
          supplySync.reload();
        }}
      />
    </>
  );
}
