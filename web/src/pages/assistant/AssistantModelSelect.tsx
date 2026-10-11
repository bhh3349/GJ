/**
 * 助手聊天的「本轮用哪个模型」选择器 —— 契约 §13.1 / v1.10.0（ADR-0023）。
 *
 * 四条口径落在这里：
 * - **选择面 = 后端实际接受的那个集合**，不是「档案里启用的模型」。后端判据是
 *   `models.enabled = 1` **且其上游 `upstreams.enabled = 1`**（`listEnabledModelNames`），
 *   而模型档案列表端点只按前者过滤。所以这里必须再取一次「已启用上游」求交集 —— 少这一步，
 *   档案里挂着一个上游已停用的模型就会出现在下拉里，选中即 `400`，用户以为是功能坏了。
 * - **不选 / 清空 = 请求体不带 `model` 字段**（省略 = 服务端用装配侧缺省模型）。这里不做
 *   「把缺省模型名填进选择框」的事：前端拿不到 `ASSISTANT_MODEL`，编一个名字就是说谎。
 * - **无状态**：选中值只活在页面内存里，不写 localStorage、不进对话历史（§13 头注 1）。
 * - **在途禁用**：一轮打完后才允许换，避免回答与选择框对不上。
 */
import { ReloadOutlined } from '@ant-design/icons';
import { Select, Tag, Tooltip, Typography } from 'antd';
import { useMemo } from 'react';

import { modelsApi, upstreamsApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import { PAGE_SIZE_MAX } from '@/api/types';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

/** 只问「有哪些能选」，一页拉满（上限 200，超出属异常，不做静默截断处理）。 */
const LIST_QUERY = { pageSize: PAGE_SIZE_MAX } as const;

export interface AssistantModelSelectProps {
  /** `null` = 未选：请求体里不带 `model`。 */
  value: string | null;
  onChange: (next: string | null) => void;
  /** 有在途请求：禁用，本轮的模型不许中途换。 */
  disabled?: boolean;
}

export function AssistantModelSelect({ value, onChange, disabled = false }: AssistantModelSelectProps) {
  // 两个读请求互相独立；任一失败只降级为「暂时拉不到可选模型」，聊天本身照常可用。
  const models = useResource(() => modelsApi.list({ ...LIST_QUERY, enabled: true }), []);
  const upstreams = useResource(() => upstreamsApi.list({ ...LIST_QUERY, enabled: true }), []);

  const loading = models.loading || upstreams.loading;
  const failed = models.error !== null || upstreams.error !== null;

  /** 交集：模型已启用 **且** 其上游已启用 —— 与后端校验同一判据。 */
  const options = useMemo(() => {
    const openUpstreams = upstreams.data?.items;
    if (!models.data || !openUpstreams) return [];
    const open = new Set(openUpstreams.map((upstream) => upstream.id));

    // 同名模型可能来自不同上游，而后端按名字匹配：按名字去重，否则会出现两条选出来一样的选项。
    const byName = new Map<string, { value: string; label: string }>();
    for (const model of models.data.items) {
      if (!open.has(model.upstreamId) || byName.has(model.name)) continue;
      byName.set(model.name, {
        value: model.name,
        label:
          model.displayName && model.displayName !== model.name
            ? `${model.name} · ${model.displayName}`
            : model.name,
      });
    }
    return [...byName.values()];
  }, [models.data, upstreams.data]);

  // 选中的模型后来被停用 / 删档：它已不在可选集合里，发出去必吃 400。当场标出来，别等报错。
  const stale = value !== null && !loading && !failed && !options.some((item) => item.value === value);

  const reload = () => {
    models.reload();
    upstreams.reload();
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
      <Tooltip title="选中的模型只对本轮生效；不选则使用服务端配置的缺省模型">
        <Select
          size="small"
          showSearch
          allowClear
          optionFilterProp="label"
          style={{ width: 240 }}
          placeholder={loading ? '正在读取可选模型…' : '缺省模型（服务端配置）'}
          value={value ?? undefined}
          disabled={disabled || loading}
          options={options}
          onChange={(next) => onChange(next ?? null)}
          notFoundContent={
            loading ? '加载中…' : failed ? '可选模型加载失败' : '无可选模型（模型档案里没有已启用的模型）'
          }
        />
      </Tooltip>

      {stale ? (
        <Tag
          bordered={false}
          style={{
            marginInlineEnd: 0,
            fontSize: 11,
            background: tokens.tint.warning,
            color: tokens.color.warning,
          }}
        >
          已停用 · 请重选
        </Tag>
      ) : null}

      {failed && !loading ? (
        <Tooltip title="重新拉取可选模型">
          <Text
            style={{ fontSize: 11, color: tokens.color.textTertiary, cursor: 'pointer' }}
            onClick={reload}
          >
            <ReloadOutlined style={{ marginInlineEnd: 4 }} />
            重试
          </Text>
        </Tooltip>
      ) : null}
    </div>
  );
}
