/**
 * 手动刷新的「二次确认」—— 契约 §14.7 的**唯一实现**。
 *
 * 为什么一个交互要写进契约：一次手动刷新**不是一次请求**，而是一**批**上游请求
 * （一把 key 一次；§15.5 按账号记账时一个账号 2 次），而出口预算**与数据面共用**
 * 同一条（§16.7 Tier 1.5 / ADR-0021）⇒ **这个按钮能挤掉客户端流量**，不是"多点一下没关系"。
 *
 * 三条纪律（照抄 §14.7，不得各自发挥）：
 * 1. **必须说清代价**：会真的打上游、会占出口预算、可能挤到数据面 ——
 *    不写代价的「确认刷新？」不算二次确认，只是多一次点击。
 * 2. **量级由服务端给，前端不得自造承诺**：请求数 = 被查 key 数（或账号数 ×2），
 *    这个数只有 §15.3 的 `result` 说了算。所以确认框里的「打谁」只陈述**选择事实**
 *    （勾了几个 / 全部 / 哪一个上游），**不写前端乘出来的总量**。
 * 3. **本组件是这句纪律文案的唯一落点**：三个入口（上游级 / 全量 / 供应商批量）共用它，
 *    谁在页面里再抄一遍下面第三行，就多出一个迟早分叉的事实源 ——
 *    而分叉的代价正好落在最不该出错的那句话上。
 *
 * 两条**刻意不做**：
 * - **单把 key 的刷新不弹这个**（一次请求，"一批"的代价量级不成立）；
 * - **不叠第二层确认**：同一个动作问两遍，人会开始盲点「确定」（§15.2 批量入口同一条纪律）。
 */
import { App, Typography } from 'antd';

import { tokens } from '@/theme/tokens';

const { Text } = Typography;

/** `App.useApp()` 给的 `modal` 实例（不另起 `Modal.confirm`，那会丢全局 `ConfigProvider` 上下文）。 */
type ModalHook = ReturnType<typeof App.useApp>['modal'];

export interface ManualRefreshCostBodyProps {
  /** 「打谁」：只陈述选择事实，**不写总量**（§14.7）。 */
  scope: string;
  /** 「代价」：会打上游 / 占出口预算 / 可能挤到数据面，三样缺一不可。 */
  cost: string;
  /**
   * 末句的后半截（"提交后本页等到终态，……"之后）。**只有这一处允许各页不同** ——
   * 入参是"终态在哪看"，不是"要不要等到终态"（§14.7：转圈不可接受，这半句谁都改不了）。
   * 写成 `| undefined` 是因为本仓开了 `exactOptionalPropertyTypes`：转发方会把可选值原样带过来。
   */
  outcome?: string | undefined;
}

/** 确认框正文：「打谁」+「代价」+「量级不由前端给」。 */
export function ManualRefreshCostBody({ scope, cost, outcome }: ManualRefreshCostBodyProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
      <Text>{scope}</Text>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {cost}
      </Text>
      <Text type="secondary" style={{ fontSize: 12 }}>
        会有几次请求由服务端说了算（契约 §14.7：量级由服务端给，
        <Text strong style={{ fontSize: 12 }}>
          前端不得自造承诺
        </Text>
        ）—— 提交后本页等到终态，{outcome ?? '结论按端点各自的形状回显。'}
      </Text>
    </div>
  );
}

export interface ConfirmManualRefreshOptions extends ManualRefreshCostBodyProps {
  /** 动作名。**写动词短语**（"查余额"），不写"确认刷新？"这类无信息的标题。 */
  title: string;
  /** 真正的提交。返回 Promise 时确认框自带 loading，不会出现"点了没反应"。 */
  onOk: () => void | Promise<void>;
}

/** 弹一次 §14.7 二次确认。三个入口共用，`okText` 只在能改代价语义时才改。 */
export function confirmManualRefresh(modal: ModalHook, options: ConfirmManualRefreshOptions): void {
  modal.confirm({
    title: options.title,
    width: 480,
    content: <ManualRefreshCostBody scope={options.scope} cost={options.cost} outcome={options.outcome} />,
    okText: '执行（会打上游）',
    cancelText: '取消',
    onOk: options.onOk,
  });
}
