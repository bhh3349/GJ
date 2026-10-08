/**
 * 余额漂移**横幅**（契约 §14.4）—— 表格上方那一条，展开即完整面板。
 *
 * 与 `pages/stats/BalanceDriftPanel` 的分工：面板是**明细**（哪条上游、哪个窗口、多少 token），
 * 横幅只回答"现在要不要看一眼"，点开把明细交给面板 —— 这样"判钱"的纪律只有一处实现，
 * 不会出现横幅说一套、面板说一套。
 *
 * 三条不越的线（与面板同源，此处只是入口）：
 *
 * 1. **不判钱**。本地没有单价（`usage_logs` 只有 token、`balance` 只有分，量纲不可比），
 *    判据只有「方向 + 零/非零」。所以横幅**只报条数**，一个金额的字都不出现。
 * 2. `counts` 是**进程内计数**（重启归零），`alerts` 是**窗口内条目**（上限 20，会滚出去）。
 *    两者出现在同一行时必须各带前缀 —— 合并成一个"共 N 次"是把两个不同口径的数加在一起。
 * 3. **零条 ≠ 没有这回事**。没提示时那行字也留在原地，并写明"自 X 起无提示"，
 *    否则"没渲染"和"没加载出来"在屏幕上长得一模一样（缺省不是证据）。
 *
 * 另记一条 v1.7.0 的前置条件：**本轮有出口级限流（`rateLimited > 0`）时后端两个码都不判定**
 * （那轮差额里混着"我们没读到"的 key，拿它下"读数不新鲜"的结论必然误伤）。这是**判定侧**的规则，
 * 前端据此**不多做任何事** —— 只要不把"这轮没有提示"读成"这轮一定健康"就行，
 * 而本组件的文案本来就没这么说。
 */
import { Alert, Button, Space, Tooltip, Typography } from 'antd';
import { useState } from 'react';

import type { BalanceDrift, BalanceSyncUpstreamState } from '@/api/types';
import { BalanceDriftPanel, DRIFT_CODE_TEXT } from '@/pages/stats/BalanceDriftPanel';
import { tokens } from '@/theme/tokens';
import { formatCount, formatIso } from '@/utils/format';

const { Text } = Typography;

export interface BalanceDriftBannerProps {
  drift: BalanceDrift;
  /** 传给面板做 `upstreamId → 名字` 的翻译；取不到就退回 id（**不编名字**）。 */
  upstreams: readonly BalanceSyncUpstreamState[];
}

export function BalanceDriftBanner({ drift, upstreams }: BalanceDriftBannerProps) {
  const [open, setOpen] = useState(false);

  const spent = drift.counts.BALANCE_SPENT_WITHOUT_TRAFFIC;
  const unchanged = drift.counts.BALANCE_UNCHANGED_WITH_TRAFFIC;
  const processTotal = spent + unchanged;

  // 窗口内按码分组计数：这是**从 alerts 现场数出来的**，不是 counts（那是进程内的）。
  const windowedSpent = drift.alerts.filter((row) => row.code === 'BALANCE_SPENT_WITHOUT_TRAFFIC').length;
  const windowedUnchanged = drift.alerts.filter((row) => row.code === 'BALANCE_UNCHANGED_WITH_TRAFFIC').length;
  const alertCount = drift.alerts.length;

  if (alertCount === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: tokens.space.sm,
          marginBottom: tokens.space.md,
        }}
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          {`余额漂移：自 ${formatIso(drift.since)} 起的窗口内无提示。`}
        </Text>
        {processTotal > 0 ? (
          <Tooltip title="进程内累计与窗口内条目不是同一个计数：窗口滚动后条目会消失，计数不会。进程内计数在服务重启时归零。">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {`进程内累计 ${formatCount(processTotal)} 次（均已在当前窗口之外）`}
            </Text>
          </Tooltip>
        ) : null}
        <Tooltip title="判据只用「余额方向 + token 用量是否为零」，口径为上游级快照对比。本网关本地没有单价，所以不与金额做任何比较，也不判断账目是否对得上。">
          <Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>
            方向级 · 只提示不判钱
          </Text>
        </Tooltip>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: tokens.space.md }}>
      <Alert
        type="warning"
        showIcon
        style={{ background: tokens.tint.warning, border: `1px solid ${tokens.color.warning}` }}
        message={
          <Space size={tokens.space.sm} align="center" wrap>
            <Text style={{ fontSize: 13, fontWeight: 600 }}>
              {`余额漂移提示 ${formatCount(alertCount)} 条（窗口内）`}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              方向级 · 只提示不判钱 · 不拦请求
            </Text>
          </Space>
        }
        description={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Text style={{ fontSize: 12 }}>
              {`窗口内：${DRIFT_CODE_TEXT.BALANCE_SPENT_WITHOUT_TRAFFIC.label} ${formatCount(windowedSpent)} 条 · `}
              {`${DRIFT_CODE_TEXT.BALANCE_UNCHANGED_WITH_TRAFFIC.label} ${formatCount(windowedUnchanged)} 条`}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {`进程内累计（重启归零）：有支出无流量 ${formatCount(spent)} · 有流量余额不变 ${formatCount(unchanged)}`}
              <Text type="secondary" style={{ fontSize: 12 }}>
                {' '}
                —— 与上面的窗口内条数不是同一个计数
              </Text>
            </Text>
          </div>
        }
        action={
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            {open ? '收起明细' : '查看逐条'}
          </Button>
        }
      />
      {open ? (
        <div style={{ marginTop: tokens.space.sm }}>
          <BalanceDriftPanel drift={drift} upstreams={upstreams} />
        </div>
      ) : null}
    </div>
  );
}
