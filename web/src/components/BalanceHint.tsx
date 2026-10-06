/**
 * 余额查询失败引导 —— `hintCode` 的唯一展示出口（契约 ADR-0012 §4）。
 *
 * 关键纪律：
 * - `hintCode` 是**引导指针**，不是错误码：不进 `ERROR_CODES`、不映射 HTTP 状态，
 *   所以这里也不用 `ErrorState`，而是按四种形态给可操作的说明。
 * - `BALANCE_UPSTREAM_UNREACHABLE` 只提示重试，**不引导改配置**（上游挂了不是配置错）。
 * - `hintCode=null` 表示出数了，无需引导，本组件应直接不渲染。
 */
import { Alert } from 'antd';
import type { ReactNode } from 'react';

import type { HintCode } from '@/api/types';

const HINT_CONFIG: Record<HintCode, { type: 'info' | 'warning' | 'error'; title: string; description: string }> = {
  BALANCE_QUERY_UNSUPPORTED: {
    type: 'info',
    title: '该上游未配置余额查询方式',
    description: '没有可用的查询模板，也未识别到内置来源。请打开自测表单，配置并验证查询方式。',
  },
  BALANCE_PARSE_MISMATCH: {
    type: 'warning',
    title: '查询成功，但取值路径取不到余额',
    description: '上游返回了数据，但按当前字段路径解析不到余额。请调整字段路径后就地再自测。',
  },
  BALANCE_UPSTREAM_UNREACHABLE: {
    type: 'warning',
    title: '上游暂不可达',
    description: '请求超时或返回非 2xx。请稍后重试，无需改动配置。',
  },
  BALANCE_AUTH_REJECTED: {
    type: 'warning',
    title: '鉴权被拒绝',
    description: '该 key 可能已失效，或该端点需要另一种凭据。请核对 key 有效性。',
  },
};

export interface BalanceHintProps {
  hintCode: HintCode | null | undefined;
  /** 后端给的可读指引文案，若给则在说明下追加原文。 */
  hint?: string | null;
  /** 可选操作按钮，如「打开自测表单」。 */
  action?: ReactNode;
}

export function BalanceHint({ hintCode, hint, action }: BalanceHintProps) {
  if (!hintCode) return null;

  const config = HINT_CONFIG[hintCode];
  return (
    <Alert
      type={config.type}
      showIcon
      message={config.title}
      description={
        <>
          <div>{config.description}</div>
          {hint ? <div style={{ marginTop: 4, opacity: 0.85 }}>{hint}</div> : null}
        </>
      }
      action={action}
    />
  );
}
