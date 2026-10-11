/**
 * 手动刷新的「二次确认」—— 契约 §14.7 的唯一实现。
 *
 * 2026-10-11 Bo 指示摘除解释性小字后，确认框收敛为两行：「打谁」（各页传入）+
 * 等待说明（服务端口径）。「量级由服务端给、前端不得自造承诺」的契约纪律不变，
 * 只是文案落点从确认框正文移出 —— 调用方仍不得把前端自算的请求数写进 scope。
 * 单把 key 不弹确认、不叠第二层确认两条纪律照旧。
 */
import { App, Typography } from 'antd';

const { Text } = Typography;

/** `App.useApp()` 给的 `modal` 实例（不另起 `Modal.confirm`，那会丢全局 `ConfigProvider` 上下文）。 */
type ModalHook = ReturnType<typeof App.useApp>['modal'];

export interface ManualRefreshCostBodyProps {
  /** 「打谁」：只陈述选择事实，**不写总量**（§14.7）。 */
  scope: string;
  /**
   * 末句的后半截（"执行后等终态，……"之后）。**只有这一处允许各页不同** ——
   * 入参是"终态在哪看"，不是"要不要等到终态"（§14.7：转圈不可接受，这半句谁都改不了）。
   * 写成 `| undefined` 是因为本仓开了 `exactOptionalPropertyTypes`：转发方会把可选值原样带过来。
   */
  outcome?: string | undefined;
}

/** 确认框正文：「打谁」一行 + 服务端口径的等待说明（Bo：摘除解释性小字）。 */
export function ManualRefreshCostBody({ scope, outcome }: ManualRefreshCostBodyProps) {
  return (
    <div>
      <Text>{scope}</Text>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        {outcome ?? '执行后等终态，结论按端点各自的形状回显。'}
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
    content: <ManualRefreshCostBody scope={options.scope} outcome={options.outcome} />,
    okText: '执行（会打上游）',
    cancelText: '取消',
    onOk: options.onOk,
  });
}
