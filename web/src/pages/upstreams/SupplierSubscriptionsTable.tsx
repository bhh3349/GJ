/**
 * 套餐台账**分组表**（契约 §15.2 `GET /api/supplier-accounts/subscriptions` + §15.8 第 6/8 问）。
 *
 * 这一格最容易做错的地方不是排版，是**归属**：
 *
 * 1. **账号是主语**。服务端那条扁平台账按 `end_at ASC` 排（回答"接下来谁到期"），
 *    但它**自己没有主语** —— 所以这里按 `accountId` 分组，账号列用 `rowSpan` 合起来。
 *    组顺序 = 各组**首条出现**的位置，也就是**该账号最先到期的那个套餐**的到期时刻；
 *    组内沿用服务端顺序。这是一次**有说法的重排**，所以写在页面上，不做静默重排。
 * 2. **套餐不是 key**（§15.8 第 6 问）。所以这一格**不叫**「套餐 key」，套餐的剩余额度也
 *    **不进** `totalBalance`、不进 §14 快照、不进网关准入判断。表里那一列 `keyMasked` 是
 *    上游给的**套餐自带 key 掩码**（只读、永不进池），不是池内 key。
 * 3. **三态与未知各占一格**：`autoRenew` 是 `true`/`false`/`null` 三态，`null` 是"上游没这个字段"；
 *    剩余额度由 `(amountTotal - amountUsed)` 得来，**任一端为 null 就是"未知"而不是 0**（§0.2）。
 * 4. **不跨页合并**。分组天然要求同一账号的行在同一页，而 `pageSize` 上限 200 ⇒ 这里
 *    **只取一页并如实说出被截断**，不画一个会把同一账号劈成两半的「下一页」。
 *
 * 表头那条**到期时间轴**是同一批数据的另一个切面：按天堆柱，点一根就把下面筛成那天到期的
 * 那些。判据与柱上的计数是**同一次日期归一**（本地日），所以"柱上写 3、筛出 3 行"必然一致；
 * 没有 `end_at` 的行不上轴、也不属于任何一天（把「不知道」画成一个确定的点是造假）。
 */
import { Alert, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';

import { supplierAccountsApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import { PAGE_SIZE_MAX, type SupplierSubscriptionRow } from '@/api/types';
import { BalanceText } from '@/components/BalanceText';
import { RemainingBar } from '@/components/RemainingBar';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { SubscriptionExpiryTimeline } from '@/pages/upstreams/SubscriptionExpiryTimeline';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCount, formatIso, formatRelative, formatTokens } from '@/utils/format';

const { Text } = Typography;

/**
 * 上游 `basic_token_*` 的单位是 **Token**（Bo 2026-10-12 定死口径：那是套餐赠送的剩余
 * Token，调用基础模型时扣减，1M = 100 万 Token）。契约 §15.1 按原值透传（字段名无
 * `Cents` 后缀即证据）—— 站内曾按「1 元 = 500000 quota」折元渲染，**是错误推断，已撤**：
 * 这一列只显示 Token 计数，不做任何折元换算。
 */

export interface SupplierSubscriptionsTableProps {
  upstreamId: string;
  /** 账号 id → 掩码（来自账号列表，用于把 `accountIdentifier` 与当前列表对上；取不到就退回台账自带的掩码）。 */
  identifierOf: (accountId: string) => string | null;
}

export function SupplierSubscriptionsTable({ upstreamId, identifierOf }: SupplierSubscriptionsTableProps) {
  const ledger = useResource(
    () => supplierAccountsApi.subscriptions({ upstreamId, page: 1, pageSize: PAGE_SIZE_MAX }),
    [upstreamId],
  );

  /** 时间轴点中的那一天（`YYYY-MM-DD`，本地日）。`null` = 不按天筛。 */
  const [day, setDay] = useState<string | null>(null);

  /** 台账里的全部行（服务端这一页）。 */
  const allRows = useMemo(() => ledger.data?.items ?? [], [ledger.data]);

  /**
   * 按天筛后的行。判据与时间轴**同一天**（本地日），所以"柱子上写 3"与"筛出来 3 行"必然一致。
   * 上游没给 `end_at` 的行**不进任何一天**，因此按天筛时它们不出现 —— 这是对的：
   * 没有时刻的行不属于任何一天。
   */
  const rows = useMemo(() => {
    if (day === null) return allRows;
    return allRows.filter((row) => {
      if (!row.endAt) return false;
      const at = new Date(row.endAt);
      if (Number.isNaN(at.getTime())) return false;
      const key = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(
        at.getDate(),
      ).padStart(2, '0')}`;
      return key === day;
    });
  }, [allRows, day]);

  /** 按账号分组：组序 = 首条出现位置（即该账号最早到期的套餐在前），组内保持服务端 `end_at ASC`。 */
  const grouped = useMemo(() => {
    const order: string[] = [];
    const buckets = new Map<string, SupplierSubscriptionRow[]>();
    for (const row of rows) {
      const bucket = buckets.get(row.accountId);
      if (bucket) {
        bucket.push(row);
      } else {
        buckets.set(row.accountId, [row]);
        order.push(row.accountId);
      }
    }
    const flat: SupplierSubscriptionRow[] = [];
    for (const accountId of order) {
      const bucket = buckets.get(accountId);
      if (bucket) flat.push(...bucket);
    }
    return flat;
  }, [rows]);

  /** 每个位置的 `rowSpan`：组内第一条拿组大小，其余拿 0（合并成一格）。 */
  const spans = useMemo(() => {
    const out: number[] = [];
    let start = 0;
    for (let i = 0; i <= grouped.length; i += 1) {
      const current = grouped[i];
      const head = grouped[start];
      const sameGroup =
        i < grouped.length &&
        current !== undefined &&
        head !== undefined &&
        current.accountId === head.accountId;
      if (!sameGroup) {
        const size = i - start;
        for (let k = 0; k < size; k += 1) out.push(k === 0 ? size : 0);
        start = i;
      }
    }
    return out;
  }, [grouped]);

  const columns: ColumnsType<SupplierSubscriptionRow> = [
    {
      title: (
        <Tooltip title="掩码。归属来自服务端台账的 accountId；这里不按掩码去猜账号，猜错了会把一份台账记到别人头上。">
          <span>账号</span>
        </Tooltip>
      ),
      key: 'account',
      width: 168,
      onCell: (_row, index) => ({ rowSpan: spans[index ?? 0] ?? 1 }),
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>
            {identifierOf(row.accountId) ?? row.accountIdentifier}
          </Text>
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 10 }}>
            {row.accountId}
          </Text>
        </div>
      ),
    },
    {
      title: '套餐',
      key: 'plan',
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Text style={{ fontSize: 12 }}>{row.planTitle ?? row.planSlug ?? '（上游未给套餐名）'}</Text>
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>
            {row.subNo}
          </Text>
        </div>
      ),
    },
    {
      title: (
        <Tooltip title="套餐剩余 = 总额 - 已用；任一端缺失就是「未知」。这不是账号 key 的余额，也不计进任何合计。">
          <span>套餐剩余</span>
        </Tooltip>
      ),
      key: 'remaining',
      width: 140,
      align: 'right',
      render: (_: unknown, row) => {
        const total = row.amountTotalCents;
        const used = row.amountUsedCents;
        const remaining = total === null || used === null ? null : total - used;
        const ratio = total === null || used === null || total <= 0 ? null : (total - used) / total;
        return (
          <RemainingBar
            ratio={ratio}
            hint={
              ratio === null
                ? '算不出剩余占比（总额或已用缺失，或总额为 0）—— 不画一根 0% 的假条。'
                : `剩余占总额 ${Math.round(ratio * 100)}%（总额 ${formatCents(total)}）`
            }
          >
            <BalanceText value={remaining} />
            caption={`总额 ${formatCents(total)} · 已用 ${formatCents(used)}`}
          </RemainingBar>
        );
      },
    },
    {
      title: (
        <Tooltip title="套餐赠送的基础额度剩余（basic_token_total - basic_token_used），单位是 Token 个数 —— 调用基础模型时扣减，1M = 100 万 Token。它不是钱，因此不按钱渲染、不进任何金额合计；任一端缺失即「未知」。这不是账号 key 的余额。">
          <span>基础额度（Token）</span>
        </Tooltip>
      ),
      key: 'tokens',
      width: 158,
      align: 'right',
      render: (_: unknown, row) => {
        // 原值即 Token 计数，直接加减，不做任何折元换算。
        const total = row.basicTokenTotal;
        const used = row.basicTokenUsed;
        const remaining = total === null || used === null ? null : total - used;
        const ratio = total === null || used === null || total <= 0 ? null : (total - used) / total;
        return (
          <RemainingBar
            ratio={ratio}
            hint={
              ratio === null
                ? '算不出剩余占比（Token 数缺失或总额为 0）—— 不画一根 0% 的假条。'
                : `剩余占总额 ${Math.round(ratio * 100)}%（总额 ${formatCount(total)} Token，已用 ${formatCount(used)} Token）`
            }
          >
            {remaining === null ? (
              <Text type="secondary" italic>
                未知
              </Text>
            ) : (
              <Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatTokens(remaining)}
              </Text>
            )}
            caption={total === null ? null : `总额 ${formatTokens(total)} · 已用 ${formatTokens(used)}`}
          </RemainingBar>
        );
      },
    },
    {
      title: '到期',
      dataIndex: 'endAt',
      width: 120,
      render: (value: string | null) => (
        <Tooltip title={value ? formatIso(value) : '上游未给到期时间 —— 不按「永久」渲染，也不按「已过期」渲染。'}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {value ? formatRelative(value) : '未提供'}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: (
        <Tooltip title="三态：自动续费 / 不自动 / 上游根本没给这个字段。合并成两态等于把「供应商没告诉我们」当成「不会自动续费」。">
          <span>续费</span>
        </Tooltip>
      ),
      dataIndex: 'autoRenew',
      width: 100,
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
    {
      title: (
        <Tooltip title="上游给的套餐自带 key 掩码。只读，永不进池、不参与网关路由。">
          <span>套餐 key（掩码）</span>
        </Tooltip>
      ),
      dataIndex: 'keyMasked',
      width: 150,
      render: (value: string | null, row) => (
        <Space size={tokens.space.xs} align="center">
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>{value ?? '—'}</Text>
          {row.hasKey ? (
            <Tooltip title="上游表示这个套餐带 key。它只以掩码存在 —— 建行等于造一把不可用凭据，所以不进池。">
              <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 10, background: tokens.tint.neutral, color: tokens.color.textSecondary }}>
                仅掩码
              </Tag>
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
  ];

  const accountCount = new Set(grouped.map((row) => row.accountId)).size;
  /** 截断判的是**服务端那一页**，与按天筛无关 —— 筛完变少不代表台账被截断。 */
  const truncated = (ledger.data?.total ?? 0) > allRows.length;

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: tokens.space.lg,
      }}
    >
      <Space size={tokens.space.sm} align="center" wrap style={{ marginBottom: tokens.space.md }}>
        <Text style={{ fontSize: 13, fontWeight: 600 }}>套餐台账（按账号分组）</Text>
        {ledger.data ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {day === null
              ? `${formatCount(accountCount)} 个账号 · ${formatCount(grouped.length)} 条套餐`
              : `已按 ${day} 到期筛：${formatCount(accountCount)} 个账号 · ${formatCount(grouped.length)} 条套餐`}
          </Text>
        ) : null}
      </Space>

      {truncated ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: tokens.space.md, background: tokens.tint.warning, border: 'none' }}
          message={`套餐台账共 ${formatCount(ledger.data?.total ?? 0)} 条，本页只取回前 ${formatCount(grouped.length)} 条`}
          description={
            <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
              分组表<Text strong style={{ fontSize: 12 }}>不跨页合并</Text> —— 画一个「下一页」会把同一个账号的套餐劈成两页。
              要看全某个账号：展开账号行或打开它的详情，那里的 `subscriptions[]` 是该账号的全量。
            </Text>
          }
        />
      ) : null}

      {ledger.error && ledger.data ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={ledger.error} onRetry={ledger.reload} title="刷新失败，以下为上一次成功的数据" />
        </div>
      ) : null}

      {ledger.data ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <SubscriptionExpiryTimeline rows={allRows} selectedDay={day} onSelectDay={setDay} />
        </div>
      ) : null}

      {ledger.loading ? (
        <LoadingState tip="正在加载套餐台账…" minHeight={240} />
      ) : ledger.error && !ledger.data ? (
        <ErrorState error={ledger.error} onRetry={ledger.reload} variant="page" title="套餐台账加载失败" />
      ) : (
        <Table<SupplierSubscriptionRow>
          rowKey="subNo"
          size="small"
          columns={columns}
          dataSource={grouped}
          loading={ledger.refreshing}
          pagination={false}
          scroll={{ x: 1080 }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Text type="secondary">
                    {day === null ? '还没有套餐台账' : `${day} 没有到期的套餐`}
                  </Text>
                }
              />
            ),
          }}
        />
      )}
    </div>
  );
}
