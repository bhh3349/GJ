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
 * - **删账号会连同名下池内 key 一起软删**（§21.5，v1.19.0 推翻旧的"只解绑"取向）：账号型 key 的
 *   额度 / 套餐 / 余额全在账号那边，账号没了这把 key 打出去只有 402/404 —— 留着比删掉更坏。
 *   所以 409 `ACCOUNT_HAS_KEYS` 的二次确认必须把"会删掉几把 key"写明白，它是与删上游
 *   （ADR-0016 物理删子树）**方向相同**的一个删除（旧版本这里是反的）。
 * - **废号池**（§21.4，v1.19.0）：`scrapped=true` 时抽屉顶部给一条醒目提示 + 「移出废号池」。
 *   出池是**同步**端点（200 回改完的那一行）、**不收 `revision`**，一次恢复名下 key 的启用与锁；
 *   确认文案必须预告「判据仍成立下一轮刷新会再次进池」—— 不预告会被读成按钮失灵。
 * - **重置套餐 key**（§15.13）是任务型端点（`202 {taskId}`）：本抽屉只提交并打开父层结果浮层，
 *   不在抽屉里自建轮询；`ids` 只带本账号，`subNo` 省略 = 该账号最新到期的套餐。
 */
import { Alert, App, Button, Drawer, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';
import type { ReactNode } from 'react';

import { supplierAccountsApi } from '@/api/endpoints';
import { describeError, isApiError } from '@/api/http';
import { useAction, useResource } from '@/api/hooks';
import {
  supplierCapabilities,
  SUPPLIER_STATUS_TEXT,
  type SupplierAccount,
  type SupplierCredentialSource,
  type SupplierSubscription,
} from '@/api/types';
import { BalanceText } from '@/components/BalanceText';
import { DepletedTag } from '@/components/DepletedTag';
import { RemainingBar } from '@/components/RemainingBar';
import { confirmManualRefresh } from '@/components/ManualRefreshConfirm';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCount, formatIso, formatRelative } from '@/utils/format';
import { subscriptionRemainingCents, subscriptionRemainingTail } from '@/utils/poolFunds';
import { SCRAP_REASON_TEXT } from '@/utils/supplierHealth';

const { Text, Paragraph } = Typography;

/** §15.1 `credentialSource`：回答「会话过期后能不能自动重登」。与 `hasSession` **正交**。 */
const CREDENTIAL_TEXT: Record<SupplierCredentialSource, string> = {
  password: '密码型（有存档密码，可自动重登）',
  session: '会话型（仅冷备会话，无存档密码）',
};

/** 四行里的第一个构建块：一行 = 标签 + 若干「标签: 值」。 */
function DetailRow({ index, label, children }: {
  index: number;
  label: string;
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
  /** 重置套餐 key 已提交（`202 {taskId}`）→ 父组件打开批量结果浮层并轮询。 */
  onRotateTask: (taskId: string) => void;
  /**
   * 该账号所属上游的 `supplier`（父组件手里已有，不另取）。只用来问一句
   * 「这家有没有套餐概念」—— 没有就不画「重置套餐 key」（§15.14：那是入口 422）。
   */
  supplier: string | null;
}

export function SupplierAccountDetailDrawer({
  accountId,
  fallback,
  onClose,
  onChanged,
  onRotateTask,
  supplier,
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

  /**
   * 重置套餐 key（§15.13）。任务型端点：`202 {taskId}` 后挂父层结果浮层轮询。
   * `ids` 只带本账号；`subNo` 省略 = 该账号最新到期的套餐（叠多套餐时才需要指定）。
   * 代价：上游侧旧套餐 key 立即失效 —— 确认文案必须说清。
   */
  const rotateKey = (): void => {
    if (!account) return;
    confirmManualRefresh(modal, {
      title: '重置套餐 key',
      scope: `打谁：仅本账号（${account.identifier}）`,
      outcome: '执行后等终态，逐行结论见明细浮层；旧套餐 key 会立即失效。',
      onOk: async () => {
        const accepted = await run('rotate', () =>
          supplierAccountsApi.rotateKey({ upstreamId: account.upstreamId, ids: [account.id] }),
        );
        if (accepted === null) return;
        onRotateTask(accepted.taskId);
      },
    });
  };

  /**
   * 解除透支（§20.5 / §20.6）。同步端点、**不要求 `revision`** —— 它解除的是系统自动置位的
   * 标记，不是替换一个编辑值（对照「绑出口」那条要 `revision`）。一个动作做三件事：
   * 清账号锁 + 清名下 `reason="account"` 的 key 锁（同样 `enabled=1`）+ 广播快照重建。
   * 确认文案必须预告「下次刷新仍透支会再次锁上」—— 不预告的话它会被读成故障。
   * 注意：它**不**出废号池 —— 那是 §21.4 的另一个粘性标记，两者正交，各自的入口各管各的。
   */
  const undeplete = (): void => {
    if (!account) return;
    modal.confirm({
      title: '解除这个账号的透支锁？',
      content: (
        <span>
          解除后该账号与其名下被「账号连坐」停用的 key 会<strong>回到选路池</strong>；自己余额不足的那些 key
          仍在池外 —— 它们没钱这件事没变。
          如果下一次余额刷新显示账号仍然透支（余额见底且套餐也不可用），会<strong>再次自动锁上</strong> —— 那是预期行为，不是故障。
        </span>
      ),
      okText: '解除并启用',
      cancelText: '取消',
      onOk: async () => {
        const result = await run('undeplete', () => supplierAccountsApi.undeplete(accountId), '透支锁已解除');
        if (result === null) return;
        detail.reload();
        onChanged();
      },
    });
  };

  /**
   * 出废号池（§21.4 v1.19.0）。同步端点、200 回改完的那一行、**不要 `revision`** ——
   * 与「解除透支」同一条理由：解除的是系统自动置位的粘性标记。一次动作三件事：
   * 清账号两列 + 名下 key 恢复启用 + 清它们的级联锁。
   *
   * 确认文案的第三句是整件事的钩子：判据（§21.2）没有变，出池不是"修好了"，
   * 下一轮 refresh / keys/sync 判据仍成立就**再次进池**。不预告的话，用户会把它当
   * "我点了移出怎么又进去了"的故障报上来。
   */
  const unscrap = (): void => {
    if (!account) return;
    modal.confirm({
      title: `把 ${account.identifier} 移出废号池？`,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>
            移出后该账号名下被停用的 key 会<strong>恢复启用并解锁</strong>。
          </span>
          <span style={{ color: tokens.color.warning }}>
            但判据没有变：若下一次余额刷新 / 套餐同步时它<strong>仍同时满足「套餐余量见底 + 余额不足 1 元」</strong>，
            会<strong>再次自动进池</strong> —— 那是判据在工作，不是按钮失灵。要让一个号留在池子外，
            先给它充上余额或换上有效套餐。
          </span>
        </div>
      ),
      okText: '移出并启用',
      cancelText: '取消',
      onOk: async () => {
        const result = await run('unscrap', () => supplierAccountsApi.unscrap(accountId), '已移出废号池');
        if (result === null) return;
        detail.reload();
        onChanged();
      },
    });
  };

  /** 删账号。v1.19.0 起**连同名下池内 key 一并软删**（§21.5），不再是"只解绑"。 */
  const remove = (force: boolean): void => {
    setRemoving(true);
    supplierAccountsApi
      .remove(accountId, force)
      .then(() => {
        message.success('账号已删除（名下池内 key 已一并软删，不再参与路由）');
        onChanged();
        onClose();
      })
      .catch((error: unknown) => {
        if (!force && isApiError(error) && error.code === 'ACCOUNT_HAS_KEYS') {
          const keyCount = readNumber(error.details, 'keyCount') ?? account?.keyCount ?? null;
          modal.confirm({
            title: '这个账号名下还有 key，确定删除？',
            width: 500,
            content: (
              <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
                <Text>
                  {keyCount === null
                    ? '删除账号会一并删除名下的 key（软删，不可恢复参与路由）。'
                    : `删除账号会一并删除名下的 ${formatCount(keyCount)} 把 key（软删，之后不再参与路由）。`}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  账号型 key 的额度、套餐、余额都在账号这一侧 —— 账号没了，key 打出去只会失败，
                  所以它们跟着走。这是刻意的强绑定，不是顺手删除。
                </Text>
              </div>
            ),
            okText: '仍然删除（连 key 一起删）',
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
        const remaining = subscriptionRemainingCents(row);
        const ratio = total === null || used === null || total <= 0 ? null : (total - used) / total;
        return (
          <RemainingBar
            ratio={ratio}
            hint={
              ratio === null
                ? '算不出剩余占比（总额或已用缺失，或总额为 0）—— 不画一根 0% 的假条。'
                : `剩余占总额 ${Math.round(ratio * 100)}%`
            }
            value={
              <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                {remaining === null ? '未知' : formatCents(remaining)}
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {` / ${formatCents(total)}`}
                </Text>
              </Text>
            }
          />
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

  /**
   * 「套餐 N 个 · 剩余 ¥X」的尾巴：套餐余额 = 各套餐「总额 − 已用」的**合计**（¥），
   * 与账号钱包、key 余额是三个口径、不相加。没有套餐就说"没有"，算不出就说"未知"，
   * 两者都不得渲染成 ¥0.00（§0.2）。判据与措辞住在公共函数，不在这里重算。
   */
  const subscriptionSummaryTail = account ? subscriptionRemainingTail(account) : '';

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
          {/* 状态标的是连接事实，透支标的是资金事实，两者正交（§20.1）—— 并排画，不合并。 */}
          {account ? (
            <DepletedTag
              depleted={account.depleted}
              depletedAt={account.depletedAt}
              depletedReason={account.depletedReason}
            />
          ) : null}
          {/* 废号池是第三根粘性轴（§21.4）：与透支也正交，同样并排画。 */}
          {account?.scrapped ? (
            <Tooltip title="已进废号池：套餐与余额同时见底（或套餐已过期且余额见底），名下 key 已全部停用。出池只有人工操作。">
              <Tag
                bordered={false}
                style={{ marginInlineEnd: 0, background: tokens.tint.error, color: tokens.color.error }}
              >
                {account.scrapReason === null ? '废号池' : `废号池 · ${SCRAP_REASON_TEXT[account.scrapReason]}`}
              </Tag>
            </Tooltip>
          ) : null}
        </Space>
      }
      footer={
        <Space size={tokens.space.sm} wrap style={{ width: '100%', justifyContent: 'flex-end' }}>
          {/* §20.5：只在真锁着的时候画 —— 一个恒在的「解除透支」会让人以为它是常规维护动作。 */}
          {account?.depleted ? (
            <Tooltip title="清账号锁 + 清名下被账号连坐停用的 key，并把它们重新启用；自己余额不足的 key 不会被放回池中。余额回升不会自动解锁，只有这个动作能解。">
              <Button
                size="small"
                style={{ color: tokens.color.orange, borderColor: tokens.color.orange }}
                loading={isPending('undeplete')}
                onClick={() => {
                  undeplete();
                }}
              >
                解除透支
              </Button>
            </Tooltip>
          ) : null}
          {account?.credentialSource === 'session' ? (
            <Tooltip title="该账号是会话型凭据，没有存档密码，无法自动重登。">
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
          {/* §15.14：没有套餐概念的供应商不画这个入口（恒 422），与批量按钮同一张能力表。 */}
          {supplierCapabilities(supplier)?.plans === true ? (
            <Button
              size="small"
              loading={isPending('rotate')}
              onClick={() => {
                rotateKey();
              }}
            >
              重置套餐 key
            </Button>
          ) : null}
          <Tooltip title="删账号会连同名下池内的 key 一起软删（不再参与路由）—— 账号型 key 的额度 / 套餐 / 余额都在账号这一侧，离开账号没有独立价值。">
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
          {/*
            废号池横幅放在四行**之前**：它解释的是"这个号现在整体是什么状态"，
            后面的身份 / 凭据 / 余额都是它的证据。放在中间或末尾会让人先读一堆细节再发现结论。
          */}
          {account.scrapped ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: tokens.space.md, background: tokens.tint.error, border: 'none' }}
              message={`这个账号在废号池里${account.scrappedAt ? `（${formatIso(account.scrappedAt)} 进池，${formatRelative(account.scrappedAt)}）` : ''}`}
              description={
                <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.xs }}>
                  <span style={{ fontSize: 12 }}>
                    原因：{account.scrapReason === null ? '未记录' : SCRAP_REASON_TEXT[account.scrapReason]}。
                    该账号名下 key 已<strong>全部停用</strong>并被级联锁存，网关不会再选它们。
                  </span>
                  <span style={{ fontSize: 12 }}>
                    出池只有人工操作；出池后下一轮刷新若判据仍成立会<strong>再次进池</strong> ——
                    先充余额或换上有效套餐才留得住它。
                  </span>
                  <Button
                    size="small"
                    style={{ alignSelf: 'flex-start', marginTop: tokens.space.xs }}
                    loading={isPending('unscrap')}
                    onClick={() => {
                      unscrap();
                    }}
                  >
                    移出废号池
                  </Button>
                </div>
              }
            />
          ) : null}
          <DetailRow
            index={0}
            label="身份"
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
                      >
            <Field label="凭据来源" value={CREDENTIAL_TEXT[account.credentialSource]} />
            <Field label="会话状态" value={account.hasSession ? '有会话（值不出后端）' : '无会话'} />
            <Field
              label="会话到期"
              value={account.sessionExpiresAt ? formatIso(account.sessionExpiresAt) : '未提供'}
            />
          </DetailRow>

          <DetailRow
            index={2}
            label="余额"
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
            label="key 与套餐"
                      >
            <div style={{ display: 'flex', gap: tokens.space.lg, flexWrap: 'wrap' }}>
              <Text style={{ fontSize: 12 }}>
                账号 key {formatCount(account.keyCount)} 把
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
              <Tooltip title="只有掩码、未进入 key 池的数量（对账用），不参与网关路由，也不与上面的账号 key 数相加。">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {`仅掩码 ${formatCount(account.maskedKeyCount)}`}
                </Text>
              </Tooltip>
              <Tooltip title="套餐余额 = 各套餐「总额 − 已用」的合计（¥）。它不是账号钱包，也不是 key 的余额，三者不相加。">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {`套餐 ${formatCount(account.subscriptions.length)} 个${subscriptionSummaryTail}`}
                </Text>
              </Tooltip>
            </div>
            <Table<SupplierSubscription>
              rowKey="subNo"
              size="small"
              columns={subscriptionColumns}
              dataSource={account.subscriptions}
              pagination={false}
              locale={{ emptyText: <Text type="secondary" style={{ fontSize: 12 }}>这个账号名下没有套餐。</Text> }}
            />
          </DetailRow>

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
