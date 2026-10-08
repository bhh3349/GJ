/**
 * 供应商账号池 —— `/upstreams/:id/accounts`（契约 §15.6 / §15.8 第 6 问 / §14.7 / §15.12）。
 *
 * **进门先看一个字段**：`upstream.supplier === 'tierflow'`（§15.12 锚 1）。
 * **不 parse `baseUrl`、不查域名、不猜** —— §15.6 写死了理由：猜错会静默渲染出一个功能全 422 的分区。
 * 判据不成立时这一页只留一行说明并指回上游管理，**账号 UI 一个都不渲染**。
 *
 * 三个 tab 是三个**数据来源完全不同**的切面，混着看必然读错，所以分开：
 *
 * 1. **账号池**（`GET /api/supplier-accounts?upstreamId=`）—— 账号是**主语**，套餐与 key 都挂在它下面。
 * 2. **套餐台账**（`GET /api/supplier-accounts/subscriptions`）—— 服务端那条扁平列表**自己没有主语**，
 *    所以它在那一格里按 `accountId` 分组后才可读（§15.8 第 6 问）。
 * 3. **出口池** —— **本期无 REST 读面**，只读占位；理由三条写在 `EgressPoolCard` 顶部。
 *
 * ## 批量动作：四个入口，两条纪律
 *
 * 四个入口里三个**真的打上游**（刷新余额 / 同步 key / 建 key 入池），而出口预算**与数据面共用**
 * （§14.7 / §16.7 Tier 1.5）⇒ **这个按钮能挤掉客户端流量**，不是"多点一下没关系"的动作。
 *
 * - **打上游的两个走二次确认**（`modal.confirm`），文案必须写出代价 —— 不写代价的
 *   「确认刷新？」不算二次确认（§14.7）。建 key 走的是自己的弹窗，那个弹窗下半段就是代价说明，
 *   不再叠一层确认框（同一个动作问两遍会让人开始盲点"确定"）。
 * - **一处都不预告请求数同上**。一次刷新是"被查账号数 × 2"次请求，这个数**由服务端给**
 *   （§15.3 的 `result`）；前端乘出来的是编造，不是承诺（§14.7 / §14.5）。所以确认框里的
 *   「打谁」只说**选择事实**（勾了几个 / 全部），不写总量。
 * - **按钮不因退避置灰**：退避只约束**自动**同步，手动照常可发（§14.1 / §14.7）。
 * - **同上游单飞**：上一轮没结束时本轮由服务端跳过（§14.1）⇒ 连点不等于多刷一遍，
 *   所以这里**不做队列** —— 前端排队就是把一条已经定死的服务端行为再实现一遍。
 *
 * ## 逐行明细只挂在终态
 *
 * `SupplierBatchDrawer` 拿的是 `useTaskPolling` 的真任务对象，`result` 只在
 * `succeeded` / `failed` 才读（§15.12 锚 2）—— 本页**不碰** `result`，
 * 免得"认结果形状"出现第二份实现。
 */
import { ArrowLeftOutlined, DownloadOutlined, KeyOutlined, PlusOutlined, SyncOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Empty,
  Input,
  Segmented,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { supplierAccountsApi, upstreamsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { useTaskPolling } from '@/api/useTaskPolling';
import {
  PAGE_SIZE_DEFAULT,
  SUPPLIER_STATUS_TEXT,
  type SupplierAccount,
  type SupplierAccountStatus,
  type SupplierBatchRequest,
  type SupplierCredentialSource,
  type SupplierSubscription,
  type TaskAccepted,
} from '@/api/types';
import { BalanceText } from '@/components/BalanceText';
import { confirmManualRefresh } from '@/components/ManualRefreshConfirm';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { EgressPoolCard } from '@/pages/upstreams/EgressPoolCard';
import { SupplierAccountDetailDrawer } from '@/pages/upstreams/SupplierAccountDetailDrawer';
import { SupplierBatchDrawer } from '@/pages/upstreams/SupplierBatchDrawer';
import { SupplierCreateKeysModal, SupplierImportModal } from '@/pages/upstreams/SupplierModals';
import { SupplierSubscriptionsTable } from '@/pages/upstreams/SupplierSubscriptionsTable';
import { tokens } from '@/theme/tokens';
import { formatCount, formatIso, formatRelative } from '@/utils/format';

const { Text } = Typography;

/** 凭据来源 → 短标签。与详情四行里那句长文案同源（§15.9）。 */
const CREDENTIAL_SHORT: Record<SupplierCredentialSource, string> = {
  password: '密码型',
  session: '会话型',
};

/** 一个「打上游」的批量动作。三个字段各自只用在一处：确认标题 / 确认代价 / 真正的提交函数。 */
interface BatchActionSpec {
  key: string;
  label: string;
  /** 二次确认里那句「会付出什么」。**必须写代价**（§14.7），否则那不是二次确认。 */
  cost: string;
  submit: (body: SupplierBatchRequest) => Promise<TaskAccepted>;
}

const BATCH_ACTIONS: readonly BatchActionSpec[] = [
  {
    key: 'refresh',
    label: '批量刷新余额',
    cost: '会真的打上游：每个被选中的账号 2 次请求（§15.5，刷新 + 套餐），所以这个按钮是"一批"而不是"一次"。出口预算与网关数据面共用同一条，账号多时可能挤到客户端流量。会话过期的号也会被刷 —— 它们正是最该刷的那批。',
    submit: (body) => supplierAccountsApi.refresh(body),
  },
  {
    key: 'sync',
    label: '批量同步 key',
    cost: '会真的打上游（只读上游、只写台账）。同步回来的是 key 掩码与套餐：未被我们认领的掩码只记数、不入池。同样占出口预算。',
    submit: (body) => supplierAccountsApi.syncKeys(body),
  },
];

/**
 * 二次确认正文已抽到 `@/components/ManualRefreshConfirm`（§14.7 的唯一实现）——
 * 本页只负责给出「打谁」与「代价」，那句"量级由服务端给"的纪律文案不在页面里复述。
 * 末句挂本页专属的终态去处：逐行结论在明细浮层。
 */

/** 展开行第二级：套餐摘要表（§15.8 第 6 问的口径与详情里那张同源）。 */
const SUBSCRIPTION_COLUMNS: ColumnsType<SupplierSubscription> = [
  {
    title: '套餐',
    key: 'plan',
    render: (_: unknown, row) => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Text style={{ fontSize: 12 }}>{row.planTitle ?? row.planSlug ?? row.subNo}</Text>
        <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>
          {row.subNo}
        </Text>
      </div>
    ),
  },
  {
    title: '剩余额度',
    key: 'remaining',
    width: 150,
    align: 'right',
    render: (_: unknown, row) => {
      // 两端都是服务端给的分，相减不涉及量纲换算；**任一端为 null 就是"未知"而不是 0**（§0.2）。
      const total = row.amountTotalCents;
      const used = row.amountUsedCents;
      return <BalanceText value={total === null || used === null ? null : total - used} />;
    },
  },
  {
    title: '到期',
    dataIndex: 'endAt',
    width: 110,
    render: (value: string | null) => (
      <Tooltip title={value ? formatIso(value) : '上游未给到期时间 —— 不按「永久」渲染'}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {value ? formatRelative(value) : '未提供'}
        </Text>
      </Tooltip>
    ),
  },
  {
    title: '续费',
    dataIndex: 'autoRenew',
    width: 92,
    render: (value: boolean | null) =>
      value === null ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          未提供
        </Text>
      ) : (
        <Tag
          bordered={false}
          style={{
            marginInlineEnd: 0,
            fontSize: 11,
            background: value ? tokens.tint.info : tokens.tint.neutral,
            color: value ? tokens.color.info : tokens.color.textSecondary,
          }}
        >
          {value ? '自动续费' : '不自动'}
        </Tag>
      ),
  },
];

export default function SupplierAccountsPage() {
  const { id: upstreamId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { message, modal } = App.useApp();
  const { run, isPending } = useAction();

  const [tab, setTab] = useState('accounts');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<SupplierAccountStatus | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  /** 勾选的账号 id。**空数组与"未选"在这里是两件事**，所以用 `null` 表示未选（见 `scopeOf`）。 */
  const [selected, setSelected] = useState<string[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [batchTitle, setBatchTitle] = useState('');
  const [batchOpen, setBatchOpen] = useState(false);

  const upstream = useResource(
    () => (upstreamId ? upstreamsApi.get(upstreamId) : Promise.resolve(null)),
    [upstreamId],
  );

  const accounts = useResource(
    () =>
      upstreamId
        ? supplierAccountsApi.list({
            upstreamId,
            page,
            pageSize,
            ...(status ? { status } : {}),
            ...(q ? { q } : {}),
          })
        : Promise.resolve(null),
    [upstreamId, q, status, page, pageSize],
  );

  /** 账号 id → 掩码。给套餐分组表把「这是哪个号」翻出来；取不到就退回台账自带的那一列。 */
  const identifierOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of accounts.data?.items ?? []) map.set(row.id, row.identifier);
    return (accountId: string): string | null => map.get(accountId) ?? null;
  }, [accounts.data]);

  /**
   * 批量任务的**唯一**真值来源。`onSettled` 只做两件事：刷新列表、说一句"到终态了"。
   * 复述计数会多出第二份"认 result 形状"的实现 —— 那份在浮层里，且只有一份。
   */
  const task = useTaskPolling((finished) => {
    accounts.reload();
    if (finished.status === 'succeeded') {
      message.info('批量任务已到终态，逐行结论见明细浮层');
    } else {
      message.error('批量任务失败，原因见明细浮层');
    }
  });

  /** 打谁：勾了就是勾中的那些，没勾就是该上游全部账号（与省略 `ids` 同义，§15.2）。 */
  const ids = selected.length > 0 ? selected : null;
  const scopeOf = (): string =>
    ids === null ? '打谁：该上游全部账号（未勾选任何账号）' : `打谁：已勾选的 ${formatCount(ids.length)} 个账号`;

  const runBatch = (spec: BatchActionSpec): void => {
    if (!upstreamId) return;
    const body: SupplierBatchRequest = { upstreamId, ...(ids ? { ids } : {}) };
    confirmManualRefresh(modal, {
      title: spec.label,
      scope: scopeOf(),
      cost: spec.cost,
      outcome: '逐行结论见明细浮层。',
      onOk: async () => {
        const accepted = await run(spec.key, () => spec.submit(body), '已提交任务');
        if (accepted === null) return;
        setBatchTitle(spec.label);
        setBatchOpen(true);
        task.start(accepted.taskId);
      },
    });
  };

  /**
   * 对账 CSV。包一层对象是因为 `downloadFile` 成功时也可能回 `null`（服务端没给文件名），
   * 而 `run` 用 `null` 表示失败 —— 两者同形就没法判断到底是哪种（缺省不是证据）。
   */
  const exportCsv = async (): Promise<void> => {
    if (!upstreamId) return;
    const result = await run('export', async () => ({
      name: await supplierAccountsApi.exportCsv({ upstreamId }),
    }));
    if (result === null) return;
    message.success(result.name ? `已导出 ${result.name}` : '已导出（服务端未给文件名）');
  };

  const closeBatch = (): void => {
    setBatchOpen(false);
    task.clear();
  };

  const columns: ColumnsType<SupplierAccount> = [
    {
      title: (
        <Tooltip title="掩码。真值不出后端，前端也不试图还原 —— 它只用来把这一行和你知道的那个号对上。">
          <span>账号</span>
        </Tooltip>
      ),
      dataIndex: 'identifier',
      width: 168,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{row.identifier}</Text>
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 10 }}>
            {row.id}
          </Text>
        </div>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 108,
      render: (_: unknown, row) => (
        <Tooltip
          title={
            row.statusMessage ??
            '上游没给状态说明。`未查询过` 表示从未成功查询过，不是「正常」的同义词。'
          }
        >
          <Tag
            bordered={false}
            style={{
              marginInlineEnd: 0,
              background:
                row.status === 'active'
                  ? tokens.tint.success
                  : row.status === 'unknown'
                    ? tokens.tint.neutral
                    : tokens.tint.error,
              color:
                row.status === 'active'
                  ? tokens.color.success
                  : row.status === 'unknown'
                    ? tokens.color.textSecondary
                    : tokens.color.error,
            }}
          >
            {SUPPLIER_STATUS_TEXT[row.status]}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: (
        <Tooltip title="账号级余额（与 key 级余额是两个口径，不相加）。null = 未知 ≠ 0；下面的时刻是最近一次「真的查到」——查失败不动它，所以显示得旧本身是一条事实。">
          <span>账号余额</span>
        </Tooltip>
      ),
      dataIndex: 'balanceCents',
      width: 190,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <BalanceText value={row.balanceCents} strong updatedAt={row.balanceUpdatedAt} />
        </div>
      ),
    },
    {
      title: (
        <Tooltip title="归属本账号、已入池的 key 数。徽标是其中 unlimited=1 的子集（不相加）；仅掩码未入池的那部分单列，也不能与它相加成「key 总数」。">
          <span>池内 key</span>
        </Tooltip>
      ),
      key: 'keys',
      width: 168,
      render: (_: unknown, row) => (
        <Space size={tokens.space.xs} align="center" wrap>
          <Text style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
            {formatCount(row.keyCount)}
            <Text type="secondary" style={{ fontSize: 12 }}>
              {' 把'}
            </Text>
          </Text>
          {row.unlimitedKeyCount > 0 ? (
            <Tooltip title="unlimited=1：上游侧无限额度（余额落 NULL）。它显示为徽标，绝不渲染成金额或负数。">
              <Tag
                bordered={false}
                style={{
                  marginInlineEnd: 0,
                  fontSize: 10,
                  background: tokens.tint.info,
                  color: tokens.color.info,
                }}
              >
                {`无限 ${formatCount(row.unlimitedKeyCount)}`}
              </Tag>
            </Tooltip>
          ) : null}
          {row.maskedKeyCount > 0 ? (
            <Tooltip title="只拿到掩码、进不了池的 key 数（对账用）。它们不参与网关路由，也不与左边的池内 key 相加。">
              <Text type="secondary" style={{ fontSize: 11 }}>
                {`仅掩码 ${formatCount(row.maskedKeyCount)}`}
              </Text>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
    {
      title: (
        <Tooltip title="套餐数。套餐不建成 key（§15.8 第 6 问），所以它不进左边的 key 计数、不进余额合计、也不参与网关准入判断。">
          <span>套餐</span>
        </Tooltip>
      ),
      dataIndex: 'subscriptions',
      width: 88,
      align: 'right',
      render: (_: unknown, row) => (
        <Text style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
          {formatCount(row.subscriptions.length)}
        </Text>
      ),
    },
    {
      title: (
        <Tooltip title="credentialSource 回答「会话过期后能不能自动重登」，与 hasSession 正交：有会话但没有存档密码的号，会话一过期就只能人工重导凭据。不得用 hasSession 反推。">
          <span>凭据</span>
        </Tooltip>
      ),
      key: 'credential',
      width: 128,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 12 }}>{CREDENTIAL_SHORT[row.credentialSource]}</Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {row.hasSession ? '有会话' : '无会话'}
          </Text>
        </div>
      ),
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
      title: '操作',
      key: 'actions',
      width: 92,
      render: (_: unknown, row) => (
        <Button
          size="small"
          type="link"
          style={{ padding: 0 }}
          onClick={() => {
            setDetailId(row.id);
          }}
        >
          详情
        </Button>
      ),
    },
  ];

  const supplier = upstream.data?.supplier ?? null;

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

  return (
    <>
      <PageHeader
        title="账号池"
        description={
          upstream.data
            ? `${upstream.data.name} · 供应商账号面`
            : '供应商账号面（账号 → 池内 key / 套餐）'
        }
        extra={
          <Space>
            <Button
              size="small"
              icon={<ArrowLeftOutlined />}
              onClick={() => {
                navigate('/upstreams');
              }}
            >
              返回上游管理
            </Button>
          </Space>
        }
      />

      {upstream.loading && !upstream.data ? (
        <LoadingState tip="正在确认这个上游的供应商属性…" minHeight={200} />
      ) : upstream.error && !upstream.data ? (
        <ErrorState
          error={upstream.error}
          onRetry={upstream.reload}
          variant="page"
          title="上游信息加载失败"
        />
      ) : supplier !== 'tierflow' ? (
        /* 判据是**一个字段**（§15.12 锚 1）。这里不渲染任何账号 UI —— 画一套不存在的账号面更坏。 */
        <Alert
          type="info"
          showIcon
          style={{ background: tokens.tint.neutral, border: 'none' }}
          message="这个上游不是供应商账号型（supplier 不是 tierflow）"
          description={
            <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
              判据只有<Text strong style={{ fontSize: 12 }}>一个字段</Text>：`upstream.supplier`。
              这里不去解析 Base URL 猜供应商 —— 猜错会渲染出一套点了全 422 的分区（§15.6）。
              要开通账号面，请到上游管理编辑该上游、把「供应商」选成对应值。
            </Text>
          }
        />
      ) : (
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'accounts',
              label: '账号池',
              children: (
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      gap: tokens.space.sm,
                    }}
                  >
                    <Input.Search
                      size="small"
                      allowClear
                      style={{ width: 220 }}
                      placeholder="搜索账号 / 用户名 / uid"
                      onSearch={(value) => {
                        setQ(value);
                        setPage(1);
                      }}
                    />
                    <Segmented
                      size="small"
                      value={status ?? 'all'}
                      options={[
                        { label: '全部', value: 'all' },
                        { label: SUPPLIER_STATUS_TEXT.active, value: 'active' },
                        { label: SUPPLIER_STATUS_TEXT.login_failed, value: 'login_failed' },
                        { label: SUPPLIER_STATUS_TEXT.session_expired, value: 'session_expired' },
                        { label: SUPPLIER_STATUS_TEXT.unknown, value: 'unknown' },
                      ]}
                      onChange={(value) => {
                        setStatus(
                          value === 'all' ? undefined : (value as SupplierAccountStatus),
                        );
                        setPage(1);
                      }}
                    />
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      共 {formatCount(accounts.data?.total ?? 0)} 个账号
                    </Text>
                    {selected.length > 0 ? (
                      <Tooltip title="批量动作的打谁范围。清空勾选即回到「该上游全部账号」——那与省略 ids 同义（§15.2）。">
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {`已勾选 ${formatCount(selected.length)} 个`}
                        </Text>
                      </Tooltip>
                    ) : (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        未勾选 → 批量动作作用于全部账号
                      </Text>
                    )}
                  </div>

                  <Space wrap size={tokens.space.sm}>
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() => {
                        setImportOpen(true);
                      }}
                    >
                      导入账号
                    </Button>
                    <Tooltip title="入口名是「新建 key」不是「新建套餐」：账号面上唯一能新建的东西就是池内 key（§15.2 / §15.8 第 6 问）。套餐是上游的事实，只能同步。">
                      <Button
                        size="small"
                        type="primary"
                        icon={<KeyOutlined />}
                        onClick={() => {
                          setKeysOpen(true);
                        }}
                      >
                        新建 key（并入池）
                      </Button>
                    </Tooltip>
                    {BATCH_ACTIONS.map((spec) => (
                      <Button
                        key={spec.key}
                        size="small"
                        icon={<SyncOutlined />}
                        loading={isPending(spec.key)}
                        onClick={() => {
                          runBatch(spec);
                        }}
                      >
                        {spec.label.replace('批量', '')}
                      </Button>
                    ))}
                    <Tooltip title="对账表，不分页导出全部账号（分页导出拿到的「账号总数」取决于点第几页，那不是对账表）。表里不含密码、不含会话、不含任何 key 明文或掩码，所以它只能用来对账，不能用来重建账号。">
                      <Button
                        size="small"
                        icon={<DownloadOutlined />}
                        loading={isPending('export')}
                        onClick={() => {
                          void exportCsv();
                        }}
                      >
                        导出对账 CSV
                      </Button>
                    </Tooltip>
                  </Space>

                  {accounts.error && accounts.data ? (
                    <ErrorState
                      error={accounts.error}
                      onRetry={accounts.reload}
                      title="刷新失败，以下为上一次成功的数据"
                    />
                  ) : null}

                  {accounts.loading ? (
                    <LoadingState tip="正在加载账号池…" minHeight={320} />
                  ) : accounts.error && !accounts.data ? (
                    <ErrorState
                      error={accounts.error}
                      onRetry={accounts.reload}
                      variant="page"
                      title="账号池加载失败"
                    />
                  ) : (
                    <Table<SupplierAccount>
                      rowKey="id"
                      size="small"
                      columns={columns}
                      dataSource={accounts.data?.items ?? []}
                      loading={accounts.refreshing}
                      scroll={{ x: 1240 }}
                      rowSelection={{
                        selectedRowKeys: selected,
                        onChange: (keys) => {
                          setSelected(keys.map((key) => String(key)));
                        },
                      }}
                      expandable={{
                        expandedRowRender: (row) => (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: tokens.space.sm,
                              padding: `${tokens.space.xs}px 0`,
                            }}
                          >
                            <Text style={{ fontSize: 12 }}>
                              池内 key {formatCount(row.keyCount)} 把
                              {row.unlimitedKeyCount > 0
                                ? `（其中无限额度 ${formatCount(row.unlimitedKeyCount)}）`
                                : ''}
                              {row.maskedKeyCount > 0
                                ? ` · 仅掩码未入池 ${formatCount(row.maskedKeyCount)}`
                                : ''}
                            </Text>
                            {/*
                              第二级 key 明细**读不到**：GET /api/keys 没有 accountId 过滤，
                              KeyDto 也不带 accountId ⇒ 从这一页没法把某账号的 key 列出来。
                              不去编一层映射（按掩码后 4 位猜归属，猜错了就是把 A 的 key 记到 B 头上），
                              直接说清缺口并指路 —— 这是本格唯一诚实的渲染。
                            */}
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              这一级的 key 明细<Text strong style={{ fontSize: 12 }}>暂时列不出来</Text>
                              ：`GET /api/keys` 没有按账号过滤的参数，key 对象里也没有账号归属字段。
                              要看具体是哪几把，请到
                              <Button
                                type="link"
                                size="small"
                                style={{ padding: `0 ${tokens.space.xs}px` }}
                                onClick={() => {
                                  navigate('/keys');
                                }}
                              >
                                Key 管理
                              </Button>
                              按上游筛。上面的计数是服务端给的，不受此影响。
                            </Text>
                            <div>
                              <Text style={{ fontSize: 12, fontWeight: 600 }}>
                                {`套餐 ${formatCount(row.subscriptions.length)} 个`}
                              </Text>
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {'（挂账号、不建成 key；余额不进任何合计）'}
                              </Text>
                            </div>
                            <Table<SupplierSubscription>
                              rowKey="subNo"
                              size="small"
                              columns={SUBSCRIPTION_COLUMNS}
                              dataSource={row.subscriptions}
                              pagination={false}
                              locale={{
                                emptyText: (
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    这个账号名下没有套餐。
                                  </Text>
                                ),
                              }}
                            />
                          </div>
                        ),
                      }}
                      pagination={{
                        current: page,
                        pageSize,
                        total: accounts.data?.total ?? 0,
                        showSizeChanger: true,
                        pageSizeOptions: [20, 50, 100, 200],
                        showTotal: (total) => `共 ${total} 个账号`,
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
                              q || status !== undefined
                                ? '当前筛选条件下没有账号。'
                                : '这个上游还没有账号。用「导入账号」粘贴「手机号,密码」清单开始。'
                            }
                          />
                        ),
                      }}
                    />
                  )}
                </div>
              ),
            },
            {
              key: 'subscriptions',
              label: '套餐台账',
              children: <SupplierSubscriptionsTable upstreamId={upstreamId} identifierOf={identifierOf} />,
            },
            {
              key: 'egress',
              label: '出口池',
              children: <EgressPoolCard />,
            },
          ]}
        />
      )}

      <SupplierImportModal
        open={importOpen}
        upstreamId={upstreamId}
        onClose={() => {
          setImportOpen(false);
        }}
        onSubmitted={(taskId) => {
          setBatchTitle('批量导入账号');
          setBatchOpen(true);
          task.start(taskId);
        }}
      />

      <SupplierCreateKeysModal
        open={keysOpen}
        upstreamId={upstreamId}
        ids={ids}
        onClose={() => {
          setKeysOpen(false);
        }}
        onSubmitted={(taskId) => {
          setBatchTitle('新建 key 并入池');
          setBatchOpen(true);
          task.start(taskId);
        }}
      />

      <SupplierBatchDrawer
        open={batchOpen}
        onClose={closeBatch}
        title={batchTitle}
        task={task.task}
        taskError={task.error}
        onRetryTask={task.refresh}
      />

      <SupplierAccountDetailDrawer
        accountId={detailId}
        fallback={accounts.data?.items.find((row) => row.id === detailId) ?? null}
        onClose={() => {
          setDetailId(null);
        }}
        onChanged={() => {
          accounts.reload();
        }}
      />
    </>
  );
}
