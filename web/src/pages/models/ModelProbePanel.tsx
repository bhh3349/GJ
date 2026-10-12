/**
 * §5 能力探测面板（v1.11.0）—— 「探测能力」按钮 + 逐项三态结论 + 人工确认后写入。
 *
 * 契约纪律（前端侧）：
 * - `apply` **缺省 `false`**：先只回结果、一个字节都不写库；管理员看清结论再点「写入档案」。
 *   这是 ADR-0024 决策 1 的「先看后写」，也是 Bo 要的「自动检测」之上的人工确认闸。
 * - **校验一次都不做在前端**：请求体由后端内置（`true` 的可归因性依赖它），前端只发 `{targets?, apply?}`。
 * - `supported` **三态**照原样显示：`false` = 上游明确拒绝，`null` = 判不出。把 `null` 当 `false`
 *   就是把「没问出结论」写成「不支持」，与 ADR-0009 同向禁止。
 * - `manual` 来源受保护：探测**永不覆盖**人工值，此时按钮改为提示，不让管理员白等一轮请求。
 */
import { ExperimentOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, App, Button, Space, Tag, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { modelsApi } from '@/api/endpoints';
import { useAction } from '@/api/hooks';
import type { ModelProbeItem, ModelProbeResult, ModelProfile } from '@/api/types';
import { CapabilityRow, CAPABILITY_LABEL } from '@/pages/models/CapabilityRow';
import { tokens } from '@/theme/tokens';
import { formatIso } from '@/utils/format';

const { Text } = Typography;

/** 逐端点诊断字段（`reason`）的人话映射。未知取值原样显示，不吞。 */
const REASON_LABEL: Record<string, string> = {
  upstream_4xx: '上游当场拒绝',
  rate_limited: '被限流（429）',
  auth: '鉴权失败（401/403）',
  not_found: '模型不存在（404）',
  server_error: '上游错误（5xx）',
  timeout: '超时',
  network: '网络失败',
};

function SupportedTag({ item }: { item: ModelProbeItem }) {
  if (item.supported === true) {
    return (
      <Tag bordered={false} style={{ marginInlineEnd: 0, background: tokens.tint.success, color: tokens.color.success }}>
        支持
      </Tag>
    );
  }
  if (item.supported === false) {
    return (
      <Tooltip title={`上游明确拒绝（状态码 ${item.status ?? '—'}）：这是模型的属性，不是 key 的故障。`}>
        <Tag bordered={false} style={{ marginInlineEnd: 0, background: tokens.tint.error, color: tokens.color.error }}>
          不支持
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={item.reason ? `判不出：${REASON_LABEL[item.reason] ?? item.reason}` : '判不出'}>
      <Tag bordered={false} style={{ marginInlineEnd: 0, background: tokens.tint.neutral, color: tokens.color.textSecondary }}>
        未判定
      </Tag>
    </Tooltip>
  );
}

export interface ModelProbePanelProps {
  model: ModelProfile;
  /** 写入成功后通知外层重拉列表，让卡片上的能力与来源同步刷新。 */
  onSaved: () => void;
}

export function ModelProbePanel({ model, onSaved }: ModelProbePanelProps) {
  const { run, isPending } = useAction();
  const { modal } = App.useApp();
  const [result, setResult] = useState<ModelProbeResult | null>(null);

  // 换了一把模型就清掉上一份结论 —— 否则 A 的探测结果会挂在 B 的卡上。
  useEffect(() => {
    setResult(null);
  }, [model.id]);

  const probe = async (): Promise<void> => {
    const value = await run(
      'probe',
      () => modelsApi.probe(model.id, { apply: false }),
      '探测完成（未写入档案）',
    );
    if (value !== null) setResult(value);
  };

  const confirmApply = (): void => {
    if (result === null) return;
    const yetToWrite = result.items.filter(
      (item) => item.supported === true && !result.capabilities.includes(item.capability),
    );
    modal.confirm({
      title: '把探测结果写入档案？',
      content:
        yetToWrite.length === 0
          ? '本次探测没有新结论可写（已有的能力位不会被抹掉）。'
          : `将新增 ${yetToWrite.map((item) => CAPABILITY_LABEL[item.capability]).join('、')}。` +
            '人工填写过的能力永不被覆盖；「不支持」与「未判定」从不写库。',
      okText: '写入档案',
      cancelText: '取消',
      onOk: async () => {
        const value = await run(
          'probe-apply',
          () => modelsApi.probe(model.id, { apply: true }),
          '已写入档案',
        );
        if (value !== null) {
          setResult(value);
          onSaved();
        }
      },
    });
  };

  const manual = model.capabilitiesSource === 'manual';
  const trueCount = result?.items.filter((item) => item.supported === true).length ?? 0;
  const hasNewToWrite =
    result !== null && result.items.some((item) => item.supported === true && !result.capabilities.includes(item.capability));
  const current: ModelProfile = result
    ? { ...model, capabilities: result.capabilities, capabilitiesSource: result.capabilitiesSource }
    : model;

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: tokens.space.md,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.space.sm }}>
        <div>
          <Text strong style={{ fontSize: 13 }}>
            能力探测
          </Text>
          <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
            向上游发能力专属小请求，用响应判断。不写调用日志、不影响 key 健康。
          </Text>
        </div>
        <Button
          size="small"
          icon={<ExperimentOutlined />}
          loading={isPending('probe')}
          onClick={() => {
            void probe();
          }}
        >
          探测能力
        </Button>
      </div>

      <div style={{ marginTop: tokens.space.sm, display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          档案现值
        </Text>
        <CapabilityRow model={current} />
      </div>

      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
        {model.lastProbedAt == null ? '从未探测过' : `最近探测 ${formatIso(model.lastProbedAt)}`}
        {result === null ? '' : ` · 本次 ${formatIso(result.probedAt)}（${result.requests} 次上游请求）`}
      </Text>

      {result === null ? null : (
        <div style={{ marginTop: tokens.space.sm }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {result.items.map((item) => (
              <div key={item.capability} style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
                <Text style={{ fontSize: 12, minWidth: 64 }}>{CAPABILITY_LABEL[item.capability]}</Text>
                <SupportedTag item={item} />
                <Text type="secondary" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                  {item.status === null ? '—' : `HTTP ${item.status}`}
                  {item.reason ? ` · ${REASON_LABEL[item.reason] ?? item.reason}` : ''}
                  {` · ${item.durationMs}ms`}
                </Text>
              </div>
            ))}
          </div>

          {manual ? (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: tokens.space.sm }}
              message="该模型的能力由人工填写，探测不会覆盖，以上仅供参考。"
            />
          ) : result.applied.length > 0 ? (
            <Text type="success" style={{ fontSize: 12, display: 'block', marginTop: tokens.space.sm }}>
              已写入档案：{result.applied.map((item) => CAPABILITY_LABEL[item]).join('、')}
            </Text>
          ) : trueCount === 0 ? (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: tokens.space.sm }}>
              本次没有探测到受支持的能力，没有可写入的项。
            </Text>
          ) : (
            <Space style={{ marginTop: tokens.space.sm }}>
              <Button
                size="small"
                type="primary"
                icon={<SaveOutlined />}
                loading={isPending('probe-apply')}
                disabled={!hasNewToWrite}
                onClick={confirmApply}
              >
                写入档案
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }}>
                只写「支持」的项；确认后再落库。
              </Text>
            </Space>
          )}
        </div>
      )}
    </div>
  );
}
