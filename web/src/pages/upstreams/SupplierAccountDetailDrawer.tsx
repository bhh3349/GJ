/**
 * 账号详情浮层 —— **四行**（契约 §15.1 / §15.8 第 6 问 / §15.9）。
 *
 * 「四行」不是排版偏好，是四组**不同证据强度**的事实，混在一张卡里最容易读错：
 *
 * 1. **身份**：`id` / `identifier`（掩码）/ `username` / `uid` / `revision`。
 *    `uid` 与 `username` **不掩码**（§15.8 第 2 问补充：uid 是内部数字 ID、username 与站点登录名同值，
 *    两者都**不是登录凭据**）；登录凭据是 `identifier` + `password`，而 `password` 永不出口。
 * 2. **凭据与会话**：`credentialSource` 与 `hasSession` **正交** ——
 *    「能不能自动重登」**只由 `credentialSource` 回答**，**不得**用 `hasSession` 反推
 *    （会话在但没存档密码 ⇒ 会话一过期就只能人工重新导凭据）。会话值本身永不出后端，所以这一行
 *    只有「有 / 无」与到期时刻，没有第三个字段可看。
 * 3. **余额**：`balanceCents` 走 `BalanceText`（`null` = 未知 ≠ 0），`balanceUpdatedAt` 是
 *    **最近一次真的查到**的时刻 —— 查失败**不动它**。所以它可能显示成"很旧"，那正是要传达的事实。
 * 4. **池内 key 与套餐计数**：三个计数**不是同一件事**，`maskedKeyCount` **不得**与 `keyCount`
 *    相加成"key 总数"。这条与 §15.8 第 6 问同源：套餐**不建成 key**，所以"套餐 M 个"不进任何 key 计数。
 *
 * 两条动作侧的纪律：
 * - **重登**是**同步**端点（200），无存档密码时**当场 422**。会话型账号因此**必然** 422，
 *   而这一事实**来自 `credentialSource` 字段**（不是猜的），所以那种号码直接禁用按钮并把原因写在旁边 ——
 *   让用户点一次必然失败的动作不叫"如实"，那叫把契约已知的事实用一次报错广告一遍。
 * - **删账号一把 key 都不删，只解绑**（§15.2）：账号删了名下 key 仍可用。真删 key 会让网关下一轮快照
 *   少一批可用 key —— 也就是"删个账号把流量打穿"。所以 409 的二次确认必须说清这一点，
 *   它是与"删上游（ADR-0016 物理删子树）"**语义相反**的一个删除。
 */
import { App, Button, Drawer, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { supplierAccountsApi } from '@/api/endpoints';
import { describeError, isApiError } from '@/api/http';
import { useAction, useResource } from '@/api/hooks';
import {
  SUPPLIER_STATUS_TEXT,
  type SupplierAccount,
  type SupplierCredentialSource,
  type SupplierSubscription,
} from '@/api/types';
import { BalanceText } from '@/components/BalanceText';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCount, formatIso, formatRelative } from '@/utils/format';

const { Text, Paragraph } = Typography;

/** §15.1 `credentialSource`：回答「会话过期后能不能自动重登」。与 `hasSession` **正交**。 */
const CREDENTIAL_TEXT: Record<SupplierCredentialSource, string> = {
  password: '密码型（有存档密码，可自动重登）',
  session: '会话型（仅冷备会话，无存档密码）',
};

/** 四行里的第一个构建块：一行 = 标签 + 若干「标签: 值」。 */
function DetailRow({ index, label, hint, children }: {
  index: number;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: tokens.space.md,
        padding: `${tokens.space.md}px 0`,
        borderTop: index === 0 ? 'none' : `1px solid ${tokens.color.border}`,
      }}
    >
      <div style={{ width: 122, flexShrink: 0 }}>
        <Space size={4} align="center">
          <Text style={{ fontSize: 13, fontWeight: 600 }}>{label}</Text>
          {hint ? (
            <Tooltip title={hint}>
              <Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>
                ?
              </Text>
            </Tooltip>
          ) : null}
        </Space>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.xs, minWidth: 0, flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

/** 一格键值。`null` 一律显示 `—`：这一行全是"描述性事实"，没有一处该被补成 0。 */
function Field({ label, value, mono = false }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: tokens.space.sm, fontSize: 12 }}>
      <Text type="secondary" style={{ width: 96, flexShrink: 0 }}>
        {label}
      </Text>
      <Text style={mono ? { fontFamily: tokens.font.mono, fontSize: 12 } : { fontSize: 12 }}>
        {value ?? '—'}
      </Text>
    </div>
  );
}

export interface SupplierAccountDetailDrawerProps {
  /** 打开时非空；关闭后父组件置 `null`，本组件随之卸载（避免残留上一次的数据）。 */
  accountId: string | null;
  /** 列表行 —— 首次拉取完成前先用它渲染，**不显示空白的假占位**。 */
  fallback: SupplierAccount | null;
  onClose: () => void;
  /** 账号被删或状态变了 → 父组件重取列表。 */
  onChanged: () => void;
}

export function SupplierAccountDetailDrawer({
  accountId,
  fallback,
  onClose,
  onChanged,
}: SupplierAccountDetailDrawerProps) {
  const { message, modal } = App.useApp();
  const { run, isPending } = useAction();
  const [removing, setRemoving] = useState(false);

  const detail = useResource(
    () => (accountId ? supplierAccountsApi.get(accountId) : Promise.resolve(null)),
    [accountId],
  );

  if (accountId === null) return null;

  const account = detail.data ?? fallback;

  /**
   * 重登。**同步端点**：成功当场回新的 `SupplierAccount`，无存档密码时当场 422 ——
   * 所以不需要任务轮询，也不该有"点了没反应"的中间态。
   */
  const relogin = async (): Promise<void> => {
    const result = await run('relogin', () => supplierAccountsApi.relogin(accountId), '已重新登录');
    if (result === null) return;
    detail.reload();
    onChanged();
  };

  const test = async (): Promise<void> => {
    const result = await run(
      'test',
      () => supplierAccountsApi.test(accountId),
      // 业务性失败是 `200 + ok:false`，所以这里不写"测试成功"——成功的是这次请求，不是这次诊断。
      '自测已执行（结论看下方）',
    );
    if (result === null || result.ok) return;
    message.warning(`自测结论：本次未通过（${result.errorCode ?? '见响应'}）`);
  };

  /** 删账号。与删上游（ADR-0016）**语义相反**：这里一把 key 都不删，只解绑。 */
  const remove = (force: boolean): void => {
    setRemoving(true);
    supplierAccountsApi
      .remove(accountId, force)
      .then(() => {
        message.success('账号已删除（名下 key 未被删除，已解除归属）');
        onChanged();
        onClose();
      })
      .catch((error: unknown) => {
        if (!force && isApiError(error) && error.code === 'ACCOUNT_HAS_KEYS') {
          const keyCount = readNumber(error.details, 'keyCount') ?? account?.keyCount ?? null;
          modal.confirm({
            title: '这个账号名下还有已入池的 key，确定删除？',
            width: 500,
            content: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
                <Text>
                  {keyCount === null
                    ? '删除后这些 key 会解除归属，但不会消失。'
                    : `删除后名下 ${formatCount(keyCount)} 把 key 会解除归属，但不会消失。`}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  <Text strong style={{ fontSize: 12 }}>
                    这次删除一把 key 都不删，只解绑
                  </Text>
                  —— 与删上游（按依赖序物理删整棵子树）正好相反。真删 key 会让网关下一轮快照
                  少一批可用 key，也就是"删个账号把流量打穿"。
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  代价是：解绑后这些 key 不再有归属账号，余额也不会再随本账号刷新而更新。
                </Text>
              </div>
            ),
            okText: '仍然删除账号（保留 key）',
            okButtonProps: { danger: true },
            cancelText: '取消',
            onOk: () => {
              remove(true);
            },
          });
          return;
        }
        const { code, message: text } = describeError(error);
        message.error(`${text} [${code}]`);
      })
      .finally(() => {
        setRemoving(false);
      });
  };

  const subscriptionColumns: ColumnsType<SupplierSubscription> = [
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
      width: 130,
      align: 'right',
      render: (_: unknown, row) => {
        // §15.8 第 6 问：套餐余额就是 (amount_total - amount_used)。两端都是服务端给的分，
        // 相减不涉及量纲换算；**任一端为 null 则剩余是"未知"，不是 0**。
        const total = row.amountTotalCents;
        const used = row.amountUsedCents;
        const remaining = total === null || used === null ? null : total - used;
        return (
          <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {remaining === null ? '未知' : formatCents(remaining)}
            <Text type="secondary" style={{ fontSize: 11 }}>
              {` / ${formatCents(total)}`}
            </Text>
          </Text>
        );
      },
    },
    {
      title: '到期',
      dataIndex: 'endAt',
      width: 110,
      render: (value: string | null) => (
        <Tooltip title={value ? formatIso(value) : '上游未给到期时间 —— 不按"永久"渲染'}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {value ? formatRelative(value) : '未提供'}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: (
        <Tooltip title="三态：自动续费 / 不自动续费 / 上游根本没给这个字段。合并成两态等于把「供应商没告诉我们」当成「不会自动续费」。">
          <span>续费</span>
        </Tooltip>
      ),
      dataIndex: 'autoRenew',
      width: 96,
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

  return (
    <Drawer
      open
      onClose={onClose}
      width={720}
      title={
        <Space size={tokens.space.sm} wrap>
          <span>账号详情</span>
          {account ? (
            <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 12, fontWeight: 400 }}>
              {account.identifier}
            </Text>
          ) : null}
          {account ? (
            <Tag
              bordered={false}
              style={{ marginInlineEnd: 0, background: tokens.tint.neutral, color: tokens.color.textSecondary }}
            >
              {SUPPLIER_STATUS_TEXT[account.status]}
            </Tag>
          ) : null}
        </Space>
      }
      footer={
        <Space size={tokens.space.sm} wrap style={{ width: '100%', justifyContent: 'flex-end' }}>
          {account?.credentialSource === 'session' ? (
            <Tooltip title="该账号是会话型凭据，没有存档密码 ⇒ 重登必然当场 422。这不是失败，是这条通路本来就不通（§15.9 双路径：密码型是第一事实源、会话型是冷备）。">
              <span style={{ display: 'inline-block' }}>
                <Button size="small" disabled>
                  重新登录
                </Button>
              </span>
            </Tooltip>
          ) : (
            <Button
              size="small"
              loading={isPending('relogin')}
              onClick={() => {
                void relogin();
              }}
            >
              重新登录
            </Button>
          )}
          <Button
            size="small"
            loading={isPending('test')}
            onClick={() => {
              void test();
            }}
          >
            连接自测
          </Button>
          <Tooltip title="删账号不删 key：名下的池内 key 会解除归属并继续可用（§15.2）。">
            <Button size="small" danger loading={removing} onClick={() => remove(false)}>
              删除账号
            </Button>
          </Tooltip>
        </Space>
      }
    >
      {detail.loading && !detail.data ? (
        <LoadingState tip="正在拉取账号详情…" minHeight={280} />
      ) : detail.error && !detail.data ? (
        <ErrorState
          error={detail.error}
          onRetry={detail.reload}
          title="账号详情加载失败（下面是列表里那一份，可能不是最新的）"
        />
      ) : null}

      {account ? (
        <>
          <DetailRow
            index={0}
            label="身份"
            hint="identifier 是掩码；uid 与 username 不掩码，因为它们不是登录凭据 —— 登录凭据是 identifier + password，而 password 永不出口。"
          >
            <Field label="内部 ID" value={account.id} mono />
            <Field label="账号（掩码）" value={account.identifier} mono />
            <Field label="用户名" value={account.username} mono />
            <Field label="uid" value={account.uid} mono />
            <Field label="上游" value={account.upstreamId} mono />
            <Field
              label="版本"
              value={`revision ${formatCount(account.revision)} · 更新于 ${formatIso(account.updatedAt)}`}
            />
          </DetailRow>

          <DetailRow
            index={1}
            label="凭据与会话"
            hint="credentialSource 与 hasSession 正交：「能不能自动重登」只由前者回答，不得用后者反推。会话值本身永不出后端。"
          >
            <Field label="凭据来源" value={CREDENTIAL_TEXT[account.credentialSource]} />
            <Field label="会话状态" value={account.hasSession ? '有会话（值不出后端）' : '无会话'} />
            <Field
              label="会话到期"
              value={account.sessionExpiresAt ? formatIso(account.sessionExpiresAt) : '未提供'}
            />
            {account.credentialSource === 'session' ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                会话型账号<Text strong style={{ fontSize: 12 }}>没有</Text>存档密码：会话一过期就得人工重新导凭据，
                页面上那条「重新登录」因此是禁用的。
              </Text>
            ) : null}
          </DetailRow>

          <DetailRow
            index={2}
            label="余额"
            hint="balanceUpdatedAt 是最近一次「真的查到」的时刻；查失败不动它 —— 所以它显示得旧，本身就是一条事实。"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
              <BalanceText value={account.balanceCents} strong showMeta updatedAt={account.balanceUpdatedAt} />
            </div>
            <Field
              label="更新于"
              value={
                account.balanceUpdatedAt
                  ? `${formatIso(account.balanceUpdatedAt)}（${formatRelative(account.balanceUpdatedAt)}）`
                  : '从未成功查到（显示为「未知」，不计入任何合计）'
              }
            />
          </DetailRow>

          <DetailRow
            index={3}
            label="池内 key 与套餐"
            hint="三个 key 计数不是同一件事：maskedKeyCount 是「只有掩码、进不了池」的那部分，不得与 keyCount 相加成「key 总数」。套餐不建成 key（§15.8 第 6 问），所以套餐数不进任何 key 计数。"
          >
            <div style={{ display: 'flex', gap: tokens.space.lg, flexWrap: 'wrap' }}>
              <Text style={{ fontSize: 12 }}>
                池内 key {formatCount(account.keyCount)} 把
                {account.unlimitedKeyCount > 0 ? (
                  <Tooltip title="unlimited=1：上游给的是无限额度（balance 落 NULL），列表里据此显示「无限」徽标，绝不渲染成一个金额或负数。">
                    <Tag
                      bordered={false}
                      style={{
                        marginInlineStart: tokens.space.sm,
                        marginInlineEnd: 0,
                        fontSize: 11,
                        background: tokens.tint.info,
                        color: tokens.color.info,
                      }}
                    >
                      {`其中无限额度 ${formatCount(account.unlimitedKeyCount)}`}
                    </Tag>
                  </Tooltip>
                ) : null}
              </Text>
              <Tooltip title="只拿到掩码、进不了池的 key 数（对账用）。它们不参与网关路由，也不与上面的池内 key 相加。">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {`仅掩码未入池 ${formatCount(account.maskedKeyCount)}`}
                </Text>
              </Tooltip>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {`套餐 ${formatCount(account.subscriptions.length)} 个`}
              </Text>
            </div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              套餐余额是账号级的量（`amount_total - amount_used`），既不进 `totalBalance`、
              也不进网关准入判断 —— 本上游池内<Text strong style={{ fontSize: 12 }}>没有</Text>
              {` `}`token-plan` 行（§15.8 第 8 问）。
            </Text>
            <Table<SupplierSubscription>
              rowKey="subNo"
              size="small"
              columns={subscriptionColumns}
              dataSource={account.subscriptions}
              pagination={false}
              locale={{ emptyText: <Text type="secondary" style={{ fontSize: 12 }}>这个账号名下没有套餐。</Text> }}
            />
          </DetailRow>

          {account.statusMessage ? (
            <div style={{ marginTop: tokens.space.md }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                最近一次状态说明：{account.statusMessage}
              </Text>
            </div>
          ) : null}
        </>
      ) : (
        <Paragraph type="secondary" style={{ fontSize: 12 }}>
          账号数据尚未到达。
        </Paragraph>
      )}
    </Drawer>
  );
}

/** 从 `details` 里取一个计数；拿不到就 `null` —— **不补 0**（不知道 ≠ 0）。 */
function readNumber(details: unknown, key: string): number | null {
  if (details === null || typeof details !== 'object' || !(key in details)) return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
