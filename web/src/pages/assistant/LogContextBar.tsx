/**
 * §13.1 `logContext` 编辑器 —— 只暴露 §12.3 的**结构化白名单**。
 *
 * 硬约束：**不接受自由文本查询**。这里每一个控件都对应一个受控过滤参数，
 * 没有「随便输入一句话去查日志」的入口 —— 那是 prompt injection 的入口（§13 头注 3）。
 */
import { DatePicker, Input, Select, Space, Typography } from 'antd';
import type { Dayjs } from 'dayjs';

import {
  OBSERVABILITY_CATEGORIES,
  type AssistantLogContext,
  type ObservabilitySeverity,
  type ObservabilityWindow,
} from '@/api/types';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

export interface LogContextDraft {
  window: ObservabilityWindow | null;
  severity: ObservabilitySeverity | null;
  categories: string[];
  model: string;
  range: [Dayjs, Dayjs] | null;
}

export const EMPTY_LOG_CONTEXT: LogContextDraft = {
  window: null,
  severity: null,
  categories: [],
  model: '',
  range: null,
};

const WINDOW_OPTIONS = [
  { value: '60s', label: '近 60 秒' },
  { value: '5m', label: '近 5 分钟' },
  { value: '1h', label: '近 1 小时' },
] as const;

const SEVERITY_OPTIONS = [
  { value: 'warn', label: 'warn（调用方/配额侧）' },
  { value: 'error', label: 'error（系统侧）' },
] as const;

/** §12.1 的 9 个分型，逐字取自契约枚举 —— 不在这里自造分类。 */
const CATEGORY_OPTIONS = OBSERVABILITY_CATEGORIES.map((category) => ({
  value: category,
  label: category,
}));

/** 全空 = 不注入日志（纯闲聊）；`AssistantLogContext` 字段一律「有值才带上」。 */
export function toLogContext(draft: LogContextDraft): AssistantLogContext | null {
  const context: AssistantLogContext = {};
  let filled = false;

  if (draft.window !== null) {
    context.window = draft.window;
    filled = true;
  }
  if (draft.severity !== null) {
    context.severity = draft.severity;
    filled = true;
  }
  if (draft.categories.length > 0) {
    context.category = draft.categories.join(',');
    filled = true;
  }

  const model = draft.model.trim();
  if (model !== '') {
    context.model = model;
    filled = true;
  }

  if (draft.range !== null) {
    const [from, to] = draft.range;
    context.from = from.toISOString();
    context.to = to.toISOString();
    filled = true;
  }

  return filled ? context : null;
}

export interface LogContextBarProps {
  value: LogContextDraft;
  onChange: (next: LogContextDraft) => void;
  disabled?: boolean;
}

export function LogContextBar({ value, onChange, disabled = false }: LogContextBarProps) {
  const active = toLogContext(value) !== null;

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: `${tokens.space.sm}px ${tokens.space.md}px`,
      }}
    >
      <Space size={tokens.space.md} wrap align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>
          观测上下文
        </Text>

        <Select
          size="small"
          allowClear
          placeholder="健康窗口"
          style={{ width: 128 }}
          value={value.window ?? undefined}
          options={[...WINDOW_OPTIONS]}
          disabled={disabled}
          onChange={(next) => onChange({ ...value, window: next ?? null })}
        />

        <Select
          size="small"
          allowClear
          placeholder="级别"
          style={{ width: 196 }}
          value={value.severity ?? undefined}
          options={[...SEVERITY_OPTIONS]}
          disabled={disabled}
          onChange={(next) => onChange({ ...value, severity: next ?? null })}
        />

        <Select
          size="small"
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder="事件分型（可多选）"
          style={{ minWidth: 240, maxWidth: 360 }}
          value={value.categories}
          options={CATEGORY_OPTIONS}
          disabled={disabled}
          onChange={(next) => onChange({ ...value, categories: next })}
        />

        {/* 模型名是**精确匹配的单值过滤参数**：这里只负责取值，
            值以结构化参数进后端，绝不会被当成自由文本查询塞进 prompt。 */}
        <Input
          size="small"
          allowClear
          placeholder="模型名（精确匹配）"
          style={{ width: 200 }}
          value={value.model}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, model: event.target.value })}
        />

        <DatePicker.RangePicker
          size="small"
          showTime
          allowClear
          placeholder={['错误事件 from', 'to']}
          value={value.range}
          disabled={disabled}
          onChange={(dates) =>
            onChange({
              ...value,
              range: dates && dates[0] && dates[1] ? [dates[0], dates[1]] : null,
            })
          }
        />

        <Text type="secondary" style={{ fontSize: 12 }}>
          {active ? '本轮会把命中的错误事件作为「数据」注入' : '留空 = 纯闲聊，不注入日志'}
        </Text>
      </Space>
    </div>
  );
}
