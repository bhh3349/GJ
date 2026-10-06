/**
 * 余额自测结果展示 —— `BalanceTestResult` 的只读渲染。
 *
 * 纪律：
 * - `ok:false` 是**业务性失败**（HTTP 仍 200），不是请求错误，所以这里不用 `ErrorState`。
 * - `parsed.balance` 后端已规范成「分」；`null` = 取不到（未知），与 0 严格区分，走 `formatBalance`。
 * - `raw` 是上游原文（后端已抹 key、截断 8KB），**只当文本看**，绝不 `dangerouslySetInnerHTML`。
 */
import { Alert, Descriptions, Tag, Typography } from 'antd';

import type { BalanceTestResult, BalanceTestSource } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatBalance, formatCount, formatIso, formatLatency } from '@/utils/format';
import { BalanceHint } from './BalanceHint';

const { Text } = Typography;

const SOURCE_LABEL: Record<BalanceTestSource, string> = {
  'user-template': '用户模板',
  preset: '内置 preset',
};

/** 把 `raw` 安全地转成可读 JSON 文本；序列化失败给占位串。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export interface BalanceTestResultViewProps {
  result: BalanceTestResult;
  /** 打开「就地再自测」的入口，由父层传入（仅对可改配置的来源有意义）。 */
  action?: React.ReactNode;
}

export function BalanceTestResultView({ result, action }: BalanceTestResultViewProps) {
  const { parsed } = result;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
      <Alert
        type={result.ok ? 'success' : 'warning'}
        showIcon
        message={result.ok ? '查询成功' : '查询未出数'}
        description={
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.md }}>
            <Text type="secondary">
              来源：{SOURCE_LABEL[result.source]}
              {result.presetId ? `（${result.presetId}）` : ''}
            </Text>
            {result.maskedKey ? (
              <Text type="secondary" style={{ fontFamily: tokens.font.mono }}>
                key：{result.maskedKey}
              </Text>
            ) : null}
            <Text type="secondary">HTTP {result.httpStatus}</Text>
            <Text type="secondary">耗时 {formatLatency(result.durationMs)}</Text>
          </div>
        }
      />

      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="请求端点">
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{result.endpoint}</Text>
        </Descriptions.Item>
        <Descriptions.Item label="余额">
          {/* 后端已把上游单位统一换算到分；null = 取不到，不是 0。 */}
          <Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatBalance(parsed.balance, parsed.currency ?? 'CNY')}
          </Text>
          {parsed.unit ? (
            <Tag bordered={false} style={{ marginInlineStart: tokens.space.sm, background: tokens.tint.neutral, color: tokens.color.textSecondary }}>
              上游单位：{parsed.unit}
            </Tag>
          ) : null}
        </Descriptions.Item>
        <Descriptions.Item label="币种">{parsed.currency ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="剩余 token">
          {formatCount(parsed.remainingTokens)}
        </Descriptions.Item>
        <Descriptions.Item label="到期时间">{formatIso(parsed.expiresAt)}</Descriptions.Item>
      </Descriptions>

      <BalanceHint hintCode={result.hintCode} hint={result.hint} action={action} />

      <div>
        <Text type="secondary" style={{ display: 'block', marginBottom: tokens.space.xs, fontSize: 12 }}>
          上游原始响应（已抹除 key、截断 8KB，只读）
        </Text>
        <pre
          style={{
            margin: 0,
            padding: tokens.space.md,
            background: tokens.color.bgBase,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            fontFamily: tokens.font.mono,
            fontSize: 12,
            maxHeight: 280,
            overflow: 'auto',
            color: tokens.color.textSecondary,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {safeStringify(result.raw)}
        </pre>
      </div>
    </div>
  );
}
