/**
 * 余额查询失败引导 —— `hintCode` 的唯一展示出口（契约 ADR-0012 §4）。
 *
 * 关键纪律：
 * - `hintCode` 是**引导指针**，不是错误码：不进 `ERROR_CODES`、不映射 HTTP 状态，
 *   所以这里也不用 `ErrorState`，而是按几种形态给可操作的说明。
 * - `BALANCE_UPSTREAM_UNREACHABLE` 只提示重试，**不引导改配置**（上游挂了不是配置错）。
 * - `hintCode=null` 表示出数了，无需引导，本组件应直接不渲染。
 * - 老前端 + 新后端：后端先上新码时，旧 bundle 的 `HINT_CONFIG` 查不到该值。`Record` 的穷尽性
 *   只在编译期成立，运行时 `config` 会是 `undefined`，直接读 `.title` 会把整个组件炸掉 ——
 *   所以渲染层必须有 `?? fallback`（ADR-0017 补遗 3 · 后果 2）。兜底文案同样**不越证据**：
 *   只说"遇到一种未知的失败状态"，**不猜**是哪一类，也**不**指向任何"改配置"的动作 ——
 *   与其余四码同一条纪律，这里能给的只有"刷新 / 重试"这类与成因无关的选项。
 *
 * `Record<HintCode, …>` **没有 fallback 项是刻意的**：`HintCode` 加值时这里不补就编译不过 ——
 * 一条新的引导码如果没人写文案，会在 UI 上变成空白提示，而空白提示比没有提示更坏
 * （用户以为"系统说没事"）。v1.7.0 的第 5 值就是被这条约束逼出来的。
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
    description:
      '请求超时，或返回了非 2xx（429 除外 —— 限流有它自己的提示）。请稍后重试，无需改动配置。',
  },
  BALANCE_AUTH_REJECTED: {
    type: 'warning',
    title: '鉴权被拒绝',
    description: '该 key 可能已失效，或该端点需要另一种凭据。请核对 key 有效性。',
  },
  /**
   * v1.7.0 第 5 值。**判据只是 HTTP 429**（契约 §「失败引导字段」表 + 文案纪律那两条）。
   *
   * `title` 是**另一处用户可见文案**，所以它同样受"不越证据"约束：出口级 429 与 key 级 429
   * 在证据面上**同形**（上游真的 429 与本地合成的 429 归同一行，标记头只证明"我们的桶拒了"、
   * 不证明"给 429 的是这把 key 的额度"）。⇒ `title` 只能陈述"本次请求被限流"，
   * **不得**写成"出口被限流"这种确定性归因：那等于把后端刚立起来的文案纪律在这一处漏掉。
   *
   * `type` 取 `info` 而不是 `warning`：这是**稍后重试即可**的临时状态，
   * 不需要用户做任何事，用 warning 会把人推去查一个不存在的配置问题。
   */
  BALANCE_EGRESS_RATE_LIMITED: {
    type: 'info',
    title: '本次请求被限流（429）',
    description:
      '可能是出口 IP 的请求预算已用尽，也可能该 key 自身撞到限额 —— 两者在这里同形，无法区分，所以不替你归因。稍后重试即可，不必改配置。',
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

  // 运行时兜底：`Record<HintCode, …>` 的穷尽性只在**编译期**成立，而 `hintCode` 直接来自 REST
  // 响应（没有运行时校验）—— 后端先上新码、前端 bundle 未更新时这里取到 `undefined`，
  // 直接读 `.title` 就当场抛错、整个组件渲染失败（不只是缺文案）。文案纪律见文件头。
  const config =
    HINT_CONFIG[hintCode] ??
    ({
      type: 'warning',
      title: '遇到一种未知的失败状态',
      description: '后端返回了本版本未收录的引导码，可能是前端版本落后于后端。请刷新页面或稍后重试。',
    } as const);
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
