/**
 * 能力那几格的**三态**渲染 —— 卡片与详情抽屉共用，避免两个面各写一套判读。
 *
 * 契约 §5（v1.11.0）来源规则：
 * - `capabilities` 非空 = **有**该能力；
 * - `[]` + `capabilitiesSource='probe'` = **问过、上游没通过**（不是「不知道」）；
 * - `[]` + `capabilitiesSource=null` = **未知**（还没问过）。
 * 把后两种读成一种，就等于把「未知」写成「不支持」—— 正是 ADR-0009 一直在防的假数据。
 * `manual` 值另有徽标：探测**永不覆盖**它。
 */
import { Tag, Tooltip, Typography } from 'antd';

import type { ModelCapability, ModelProfile } from '@/api/types';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

export const CAPABILITY_LABEL: Record<ModelCapability, string> = {
  stream: '流式',
  function_call: '函数调用',
  vision: '视觉',
  json_mode: 'JSON 模式',
};

export interface CapabilityRowProps {
  model: ModelProfile;
  /** 卡片用 11，抽屉用默认 12。 */
  fontSize?: number;
}

export function CapabilityRow({ model, fontSize = 12 }: CapabilityRowProps) {
  const { capabilities, capabilitiesSource } = model;

  if (capabilities.length > 0) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {capabilities.map((item) => (
          <Tag
            key={item}
            bordered={false}
            style={{
              marginInlineEnd: 0,
              fontSize: fontSize - 1,
              background: tokens.tint.info,
              color: tokens.color.info,
            }}
          >
            {CAPABILITY_LABEL[item]}
          </Tag>
        ))}
        {/* 来源徽标只标「机器问过」；人工值不需要一顶帽子，标出来反而像在质疑管理员。 */}
        {capabilitiesSource === 'probe' ? (
          <Tooltip title="由上游实测得出。人工修改过之后，探测不会再覆盖它。">
            <Tag
              bordered={false}
              style={{
                marginInlineEnd: 0,
                fontSize: fontSize - 2,
                background: tokens.tint.neutral,
                color: tokens.color.textTertiary,
              }}
            >
              实测
            </Tag>
          </Tooltip>
        ) : null}
      </div>
    );
  }

  if (capabilitiesSource === 'probe') {
    return (
      <Tooltip title="已向上游问过，四项都没通过。这是结论，不是缺失。">
        <Text type="secondary" italic style={{ fontSize }}>
          已探测 · 均不支持
        </Text>
      </Tooltip>
    );
  }

  return (
    <Tooltip title="还没有问过上游，也没有人工填写。「未知」不等于「不支持」。">
      <Text type="secondary" italic style={{ fontSize }}>
        能力未知
      </Text>
    </Tooltip>
  );
}
