/**
 * 批量任务的**逐行状态浮层**（契约 §15.3 / §15.12 锚 2 / §14.7）。
 *
 * 这个浮层要同时守住五条纪律，逐条对应下面五处实现：
 *
 * 1. **只读 `result.items`，且只在终态读**（§15.12 锚 2）。`queued` / `running` 期间
 *    `result` 是 `null` —— 那时**不渲染任何逐行结论**，只渲染服务端给的真实进度。
 *    进度不是编的：`progress.done/total` 直接来自 `GET /api/tasks/:id`，
 *    `total` 为 `null` 时显示不确定进度条（**不补一个百分比**）。
 * 2. **一次点击必须落到一个明确结论**，不许一直转圈（§14.7）。所以本浮层在运行中**如实说**
 *    "还在跑、跑到几分之几"，而不是给一个 0% 的假进度。终态才给结论。
 * 3. **被拒也是结论，不是坏态**（§14.7）。出口预算耗尽时任务**照常完成**、`failed` 计数**照记**、
 *    `hintCode` 落 `BALANCE_EGRESS_RATE_LIMITED` —— 这是**任务结论**而不是 key 归因
 *    （key 健康计数不动）。所以那种终态**不渲染成红色错误**，文案交给 `BalanceHint`
 *    （第 5 个码的"不越证据"纪律只有一处实现）。
 * 4. **`truncated` 必须说出来**：`items` 上限 500 行，超了只留前 500 + `itemsTotal` 给真实行数。
 *    本期**没有分页**，所以不能画一个"下一页"按钮 —— 只能把"看全部"指到 `ids` 分批或 CSV 导出。
 * 5. **一行都不含凭据**：`identifier` / `keyMasked` 都是掩码，明文全程不经浏览器（§15.2 `keys`）。
 *    因此这里**不做**"一次性明文"浮层 —— 那一套是 §3 人工从供应商控制台复制的路径才需要的。
 */
import { SyncOutlined } from '@ant-design/icons';
import { Alert, Drawer, Empty, Progress, Segmented, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { BalanceHint } from '@/components/BalanceHint';
import { ErrorState } from '@/components/states/StateBlock';
import type { SupplierBatchAction, SupplierBatchItem, SupplierBatchResult, Task } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatCount, formatIso } from '@/utils/format';

const { Text } = Typography;

/** `action` 五值 → 人话。五值**每个都有生产者**（§15.3），所以这里没有兜底项要写"其它"。 */
const ACTION_TEXT: Record<SupplierBatchAction, string> = {
  login: '首登',
  relogin: '重登',
  refresh: '刷新余额',
  create: '建 key',
  sync: '同步 key',
};

/**
 * 认形状。`Task.result` 是 `unknown`（别的任务类型也走这个字段），所以**必须**先判再读 ——
 * 认不出就如实说认不出，而不是把 `undefined` 渲染成 0：`ok` 显示 0 与"没有这个计数"
 * 在读的人眼里是同一件事，而那正是本面最忌讳的那种错。
 */
function asBatchResult(value: unknown): SupplierBatchResult | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.items)) return null;
  if (typeof row.total !== 'number' || typeof row.ok !== 'number' || typeof row.failed !== 'number') {
    return null;
  }
  return value as SupplierBatchResult;
}

export interface SupplierBatchDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 本次动作的人话名字（「批量刷新余额」…）。只用于标题，不参与判断。 */
  title: string;
  task: Task | null;
  taskError: unknown;
  onRetryTask: () => void;
}

export function SupplierBatchDrawer({
  open,
  onClose,
  title,
  task,
  taskError,
  onRetryTask,
}: SupplierBatchDrawerProps) {
  const [onlyProblem, setOnlyProblem] = useState(false);

  const result = task && (task.status === 'succeeded' || task.status === 'failed') ? asBatchResult(task.result) : null;

  const columns: ColumnsType<SupplierBatchItem> = [
    {
      title: '结果',
      dataIndex: 'ok',
      width: 76,
      render: (ok: boolean, row) => (
        <Tooltip title={row.ok ? '这一行做成了' : '这一行做了但没成 —— 原因看「码」与「说明」两列'}>
          <Tag
            bordered={false}
            style={{
              marginInlineEnd: 0,
              background: ok ? tokens.tint.success : tokens.tint.error,
              color: ok ? tokens.color.success : tokens.color.error,
            }}
          >
            {ok ? '成功' : '失败'}
          </Tag>
        </Tooltip>
      ),
    },
    {
      title: (
        <Tooltip title="掩码。这一行没能从上游响应里解析出账号时为 null —— 那种行显示为「未解析出账号」，不补一个空字符串（空字符串看起来像「没有账号」，而事实是「没认出来」）。">
          <span>账号</span>
        </Tooltip>
      ),
      dataIndex: 'identifier',
      width: 150,
      render: (value: string | null) =>
        value === null ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            未解析出账号
          </Text>
        ) : (
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value}</Text>
        ),
    },
    {
      title: '动作',
      dataIndex: 'action',
      width: 90,
      render: (value: SupplierBatchAction | null) =>
        value === null ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        ) : (
          <Text style={{ fontSize: 12 }}>{ACTION_TEXT[value]}</Text>
        ),
    },
    {
      title: (
        <Tooltip title="供应商错误码原样（如 LOGIN_INVALID_CREDENTIALS）或本契约错误码。不做翻译 —— 码是排查时的检索键。">
          <span>码</span>
        </Tooltip>
      ),
      dataIndex: 'code',
      width: 210,
      render: (value: string | null) =>
        value === null ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        ) : (
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>{value}</Text>
        ),
    },
    {
      title: '说明',
      dataIndex: 'message',
      render: (value: string | null) =>
        value === null ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        ) : (
          <Text style={{ fontSize: 12 }}>{value}</Text>
        ),
    },
    {
      title: (
        <Tooltip title="上游明文全程不经浏览器：服务端取回后当场加密落库，出口只有这条掩码。所以这里没有「一次性明文」可看 —— 那是 §3 人工从供应商控制台复制明文的路子才需要的。">
          <span>key（掩码）</span>
        </Tooltip>
      ),
      dataIndex: 'keyMasked',
      width: 140,
      render: (value: string | null, row) =>
        value === null ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        ) : (
          <Text
            style={{ fontFamily: tokens.font.mono, fontSize: 11 }}
            copyable={row.keyId ? { text: row.keyId, tooltips: ['复制内部 key id（不是明文 key）', '已复制 id'] } : false}
          >
            {value}
          </Text>
        ),
    },
    {
      title: (
        <Tooltip title="上游侧的单号（tokenNo）。与掩码一起用于对账。">
          <span>单号</span>
        </Tooltip>
      ),
      dataIndex: 'tokenNo',
      width: 90,
      align: 'right',
      render: (value: number | null) =>
        value === null ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Text>
        ) : (
          <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>{value}</Text>
        ),
    },
  ];

  const items = result?.items ?? [];
  const shown = onlyProblem ? items.filter((row) => !row.ok) : items;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={960}
      title={
        <Space size={tokens.space.sm} wrap>
          <span>{title}</span>
          {task ? (
            <Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              {`任务 ${task.id} · ${task.type}`}
            </Text>
          ) : null}
        </Space>
      }
    >
      {taskError ? (
        <ErrorState error={taskError} onRetry={onRetryTask} title="任务状态查询失败（结果未知，不代表没跑完）" />
      ) : null}

      {!task && !taskError ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={<Text type="secondary">已提交，正在取任务状态…</Text>}
        />
      ) : null}

      {task && task.status !== 'succeeded' && task.status !== 'failed' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
          <Space size={tokens.space.sm} wrap>
            <Tag
              bordered={false}
              style={{ marginInlineEnd: 0, background: tokens.tint.info, color: tokens.color.info }}
            >
              {task.status === 'queued' ? '排队中' : '进行中'}
            </Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {task.progress
                ? `${formatCount(task.progress.done)} / ${formatCount(task.progress.total)}`
                : '总数尚未枚举完'}
            </Text>
            {task.startedAt ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {`自 ${formatIso(task.startedAt)} 起`}
              </Text>
            ) : null}
          </Space>
          {/* total 未知时不画进度条：0% 是"一个都没做"，"不知道"不是 0%（同 ModelsPage 口径）。 */}
          {task.progress ? (
            <Progress
              percent={Math.round((task.progress.done / Math.max(task.progress.total, 1)) * 100)}
              size="small"
              strokeColor={tokens.color.primary}
              trailColor={tokens.color.border}
            />
          ) : (
            <Tooltip title="服务端还没枚举出总条数，这里只表示「还在跑」，不编造百分比。">
              <Space size={tokens.space.sm} align="center">
                <Spin size="small" indicator={<SyncOutlined spin style={{ color: tokens.color.primary }} />} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  总数尚未枚举完，不显示百分比
                </Text>
              </Space>
            </Tooltip>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            本浮层会等到终态才给结论（契约 §14.7：一次点击必须落到一个明确结论）。
            一行明细要等任务跑完才由服务端给 —— 在这里画进度条可以，编逐行结果不行。
          </Text>
        </div>
      ) : null}

      {task && (task.status === 'succeeded' || task.status === 'failed') && result === null ? (
        <Alert
          type="warning"
          showIcon
          message="任务已到终态，但结果不是本页认识的批量形状"
          description={
            <Text style={{ fontSize: 12 }}>
              `result` 的形状只对 §15.2 的四个批量端点成立。这个任务可能来自别的入口
              （如全量模型同步），请到对应的页面看它的结论。这里不猜、也不把缺失的计数字段当 0 渲染。
            </Text>
          }
        />
      ) : null}

      {result ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
          <Space size={tokens.space.lg} wrap>
            <Text style={{ fontSize: 12 }}>
              {`总计 ${formatCount(result.total)}`}
            </Text>
            <Text style={{ fontSize: 12, color: tokens.color.success }}>
              {`成功 ${formatCount(result.ok)}`}
            </Text>
            <Text style={{ fontSize: 12, color: result.failed > 0 ? tokens.color.error : tokens.color.textSecondary }}>
              {`失败 ${formatCount(result.failed)}`}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {`跳过 ${formatCount(result.skipped)}`}
            </Text>
            <Tooltip title="不变量：成功 + 失败 + 跳过 = 总计。跳过 = 没做过的行（整行解析失败等），失败 = 做了但不成的行 —— 两者不是一回事。">
              <Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>
                成功 + 失败 + 跳过 = 总计
              </Text>
            </Tooltip>
            {task?.finishedAt ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                {`完成于 ${formatIso(task.finishedAt)}`}
              </Text>
            ) : null}
          </Space>

          {/*
            §14.7：被拒也是结论。出口预算耗尽时任务照常完成、failed 照记，
            它是**任务结论**而不是 key 归因（key 健康计数不动）。
            所以这里用 info 而不是 error —— 渲染成红色会让人以为要把哪把 key 挑出来处理。
          */}
          {result.hintCode === 'BALANCE_EGRESS_RATE_LIMITED' && result.failed > 0 ? (
            <Alert
              type="info"
              showIcon
              style={{ background: tokens.tint.info, border: 'none' }}
              message="这一批里有一部分被限流拒绝了 —— 这是任务结论，不是「哪把 key 坏了」"
              description={
                <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                  被拒的行<Text strong style={{ fontSize: 12 }}>不计入任何 key 的健康度</Text>（契约 §16.7：谁没错，不给谁记过）。
                  按钮也不会因此被禁用 —— 退避只约束自动同步，手动刷新照常可发。稍后重试即可。
                </Text>
              }
            />
          ) : null}

          <BalanceHint hintCode={result.hintCode} hint={result.hint} />

          {result.truncated ? (
            <Alert
              type="warning"
              showIcon
              style={{ background: tokens.tint.warning, border: 'none' }}
              message={`逐行明细已截断：下面只有前 ${formatCount(items.length)} 行，实际共 ${formatCount(
                result.itemsTotal,
              )} 行`}
              description={
                <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                  本期<Text strong style={{ fontSize: 12 }}>没有分页</Text>（契约 §15.12 锚 2），所以这里没有「下一页」可点。要看全：按 `ids`
                  分批重发，或用上方的「导出对账 CSV」把台账带出去。上面的计数是<Text strong style={{ fontSize: 12 }}>全量</Text>的，不受截断影响。
                </Text>
              }
            />
          ) : null}

          <Space size={tokens.space.sm} align="center" wrap>
            <Segmented
              size="small"
              value={onlyProblem ? 'problem' : 'all'}
              options={[
                { label: `全部 ${formatCount(items.length)}`, value: 'all' },
                { label: `只看失败 ${formatCount(items.filter((row) => !row.ok).length)}`, value: 'problem' },
              ]}
              onChange={(value) => {
                setOnlyProblem(value === 'problem');
              }}
            />
            {result.skipped > 0 ? (
              <Tooltip title="跳过的行不会出现在 items 里 —— 它们是「没做过」的行（整行解析失败、命中排除名单），没有逐行结论可给。">
                <Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>
                  跳过的行没有逐行明细
                </Text>
              </Tooltip>
            ) : null}
          </Space>

          <Table<SupplierBatchItem>
            rowKey={(row, index) => `${row.keyId ?? row.identifier ?? 'row'}:${String(index)}`}
            size="small"
            columns={columns}
            dataSource={shown}
            pagination={false}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {onlyProblem && items.length > 0
                        ? '这批没有失败的行。'
                        : '这批没有逐行明细（可能全部被跳过）。'}
                    </Text>
                  }
                />
              ),
            }}
          />
        </div>
      ) : null}
    </Drawer>
  );
}
