/**
 * 消费面 · 本组额度卡 —— §19.3c `GET /api/console/quota`（v1.15.9）。
 *
 * 这一块回答的是用户最常问的两个问题：「我这个组一分钟能打多少」「今天还能用多少」。
 * 此前没有任何界面回答它们 —— 用户只能靠"打过去看看会不会 429"来试探，
 * 而那条路每次都真的消耗一次配额、还留下一行 429 日志。
 *
 * **所有数字都是服务端 §4 `GroupDto` 的透传**（`getGroup` 的同一次计算），
 * 这一块**不算任何东西**：
 * - 「今日已用」用 `dailyQuotaUsed`，不用 `todayUsage.tokens` 现推 —— 两个都回正是
 *   为了不让前端去猜该用哪个；
 * - 百分比只是把两个既有数字放一起展示（`used / total`），不是第二个口径。
 *
 * `null` 与 `0` 是**两件完全不同的事**，展示上必须分开（这是本卡最容易写错的地方）：
 * - `null` = **不限**（没设配额）→ 写「不限」，绝不画一根长度 0 的进度条。
 *   画了的话，用户会以为"我的配额是 0、一点都不能用"。
 * - `0` = 一点都不能用 → 那是真的封顶，要有一个明确的、非空的视觉信号。
 *
 * 未分配到组（`assigned: false`）时整块退回一句说明 + 为什么：额度是**组**的属性，
 * 没有组就没有额度可言，此时回 `null` 而**不是 0**（回 0 会让人去查"我为什么被限流了"）。
 */
import { Progress, Space, Tag, Typography } from 'antd';

import { consoleApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import type { ConsoleQuota } from '@/api/types';
import { Panel } from '@/components/Panel';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';
import { formatCompact, formatCount } from '@/utils/format';

const { Text } = Typography;

/** 单项配额的展示。`limit === null` 走「不限」那一支，不画进度条。 */
function QuotaRow({
  label,
  used,
  limit,
  unit,
}: {
  label: string;
  used: number;
  limit: number | null;
  unit: string;
}) {
  if (limit === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Text style={{ fontSize: 12 }}>{label}</Text>
        <Space size={tokens.space.sm} align="baseline">
          <Text strong style={{ fontSize: 18 }}>
            不限
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            已用 {formatCount(used)} {unit}
          </Text>
        </Space>
      </div>
    );
  }

  // `limit === 0` 单独拎出来：`used / 0` 是 `NaN`，而 `0%` 会被读成"一点都没用"——
  // 恰恰相反，"日配额 0"是**一点都不许用**，该显示的是满格的红色。
  const percent = limit === 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Text style={{ fontSize: 12 }}>{label}</Text>
      <Text style={{ fontSize: 12 }}>
        {formatCount(used)} {unit} / {formatCompact(limit)} {unit}
      </Text>
      <Progress
        percent={percent}
        size="small"
        showInfo={false}
        strokeColor={
          percent >= 90 ? tokens.color.error : percent >= 70 ? tokens.color.warning : tokens.color.primary
        }
        trailColor={tokens.color.border}
      />
    </div>
  );
}

export function ConsoleQuotaPanel() {
  const quota = useResource<ConsoleQuota>(() => consoleApi.quota(), []);

  return (
    <Panel
      title="本组额度"
      description="额度按组共享：同组的每一把 key 都花这一份池子。"
      hint="数字与管理面「用户组」里同一个组的那几格同源（服务端同一次计算），所以两边必须一字不差。"
      extra={
        quota.data?.assigned === true ? (
          <Tag
            color={quota.data.dailyQuota !== null && quota.data.dailyQuotaUsed >= quota.data.dailyQuota ? 'orange' : 'default'}
          >
            今日 {formatCount(quota.data.dailyQuotaUsed)} tokens
          </Tag>
        ) : null
      }
    >
      {quota.error !== null && quota.data === null ? (
        <ErrorState error={quota.error} onRetry={quota.reload} title="额度读取失败（`GET /api/console/quota`）" />
      ) : quota.loading ? (
        <LoadingState tip="正在读取额度…" minHeight={120} />
      ) : quota.data === null || quota.data.assigned === false ? (
        <Text type="secondary" style={{ fontSize: 12 }}>
          你还没有被分配到用户组，所以没有配额可言 —— 分配之后这里会显示该组的
          RPM / TPM / 日配额与今日已用量。
        </Text>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: tokens.space.lg,
          }}
        >
          {/* 今日 token 配额：`used` 就是 `dailyQuotaUsed`（不另算一遍）。 */}
          <QuotaRow
            label="日配额（tokens）"
            used={quota.data.dailyQuotaUsed}
            limit={quota.data.dailyQuota}
            unit=""
          />
          {/* RPM / TPM 是**每分钟**的窗口，服务端的限流器实时判它们，不累加到"已用"里 ——
              所以这里只写上限，不画进度条（画了就得现编一个"这一分钟用了多少"的数）。 */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Text style={{ fontSize: 12 }}>RPM（每分钟请求）</Text>
            <Text strong style={{ fontSize: 18 }}>
              {quota.data.rpm === null ? '不限' : formatCompact(quota.data.rpm)}
            </Text>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Text style={{ fontSize: 12 }}>TPM（每分钟 token）</Text>
            <Text strong style={{ fontSize: 18 }}>
              {quota.data.tpm === null ? '不限' : formatCompact(quota.data.tpm)}
            </Text>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Text style={{ fontSize: 12 }}>今日请求数</Text>
            <Text strong style={{ fontSize: 18 }}>
              {formatCount(quota.data.todayUsage.requests)}
            </Text>
          </div>
        </div>
      )}
    </Panel>
  );
}
