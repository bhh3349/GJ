/**
 * 模型档案 —— 卡片列表、筛选、详情。
 *
 * 契约纪律：
 * - 卡片上的「可用 key」直接取 `availableKeyIds.length`，**不在前端重算**可用性
 *   （口径由后端按「启用 + 非冷却 + 余额 > 0」给，验收 4 要求它与 `/v1/models` 逐项一致）。
 * - 价格是**分 / 1k tokens**，`null` = 上游没给，**不是 0**：卡片上显示「未知」而非 ¥0.00。
 * - `POST /api/models/sync` 是异步任务，进度只来自 `GET /api/tasks/:id`
 *   的真实 `progress.done/total`；`total` 为 null 时显示不确定进度条，**不做假进度条**。
 */
import { ReloadOutlined, SyncOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Card,
  Input,
  Progress,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useMemo, useState } from 'react';

import { keysApi, modelsApi, upstreamsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { useTaskPolling } from '@/api/useTaskPolling';
import {
  PAGE_SIZE_DEFAULT,
  type ModelCapability,
  type ModelProfile,
  type ModelType,
  type Upstream,
} from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/StateBlock';
import { ModelDetailDrawer } from '@/pages/models/ModelDetailDrawer';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCompact, formatCount, formatRelative } from '@/utils/format';

const { Text } = Typography;

const TYPE_LABEL: Record<ModelType, string> = {
  chat: '对话',
  embedding: '向量',
  image: '图像',
  audio: '语音',
  rerank: '重排',
};

const CAPABILITY_LABEL: Record<ModelCapability, string> = {
  stream: '流式',
  function_call: '函数调用',
  vision: '视觉',
  json_mode: 'JSON 模式',
};

function PriceLine({ model }: { model: ModelProfile }) {
  if (model.price === null) {
    return (
      <Tooltip title="上游未提供价格。未知 ≠ 0，成本统计不会把它当免费累加。">
        <Text type="secondary" italic style={{ fontSize: 12 }}>
          价格未知
        </Text>
      </Tooltip>
    );
  }
  return (
    <Text type="secondary" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
      入 {formatCents(model.price.inputPer1k)} · 出 {formatCents(model.price.outputPer1k)} / 1k
    </Text>
  );
}

export default function ModelsPage() {
  const { message } = App.useApp();
  const { run, isPending } = useAction();

  const [q, setQ] = useState('');
  const [upstreamId, setUpstreamId] = useState<string | undefined>(undefined);
  const [type, setType] = useState<ModelType | undefined>(undefined);
  const [capability, setCapability] = useState<ModelCapability | undefined>(undefined);
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [detail, setDetail] = useState<ModelProfile | null>(null);

  const queryKey = JSON.stringify({ q, upstreamId, type, capability, enabled, page, pageSize });
  const list = useResource(() => modelsApi.list(JSON.parse(queryKey)), [queryKey]);

  const upstreams = useResource(() => upstreamsApi.list({ pageSize: 200 }), []);
  const upstreamName = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of upstreams.data?.items ?? []) map.set(item.id, item.name);
    return map;
  }, [upstreams.data]);

  // 详情里要把 availableKeyIds 显示成 `****后4位`；只取掩码，不碰明文。
  const keys = useResource(() => keysApi.list({ pageSize: 200 }), []);
  const keyLabel = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of keys.data?.items ?? []) map.set(item.id, item.maskedKey);
    return (keyId: string) => map.get(keyId) ?? keyId;
  }, [keys.data]);

  const task = useTaskPolling((finished) => {
    if (finished.status === 'succeeded') message.success('模型同步完成');
    else message.error(finished.message ?? '模型同步失败');
    list.reload();
  });

  const sync = async () => {
    const result = await run(
      'sync',
      () => modelsApi.sync(upstreamId),
      upstreamId ? '已提交该上游的同步任务' : '已提交全量同步任务',
    );
    if (result !== null) task.start(result.taskId);
  };

  const progressPercent = (() => {
    const progress = task.task?.progress;
    if (!progress || progress.total <= 0) return null;
    // 真实进度，不在前端做平滑/预测；done/total 直接来自后端。
    return Math.min(100, Math.round((progress.done / progress.total) * 100));
  })();

  const models = list.data?.items ?? [];
  const filterActive =
    q !== '' || upstreamId !== undefined || type !== undefined || capability !== undefined || enabled !== undefined;

  return (
    <>
      <PageHeader
        title="模型档案"
        description="模型类型、支持能力、价格、可用 key"
        extra={
          <Space>
            <Button
              size="small"
              icon={<SyncOutlined />}
              loading={isPending('sync') || task.running}
              onClick={() => {
                void sync();
              }}
            >
              {upstreamId ? '同步该上游' : '全量同步'}
            </Button>
            <Button size="small" icon={<ReloadOutlined />} loading={list.refreshing} onClick={list.reload}>
              刷新
            </Button>
          </Space>
        }
      />

      {/* 同步进度：全部来自 GET /api/tasks/:id 的真实 done/total */}
      {task.task ? (
        <div
          style={{
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            background: tokens.color.bgContainer,
            padding: tokens.space.md,
            marginBottom: tokens.space.md,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: 12 }}>
              模型同步任务 · {task.task.status === 'running' ? '进行中' : task.task.status === 'queued' ? '排队中' : task.task.status === 'succeeded' ? '已完成' : '失败'}
              {task.task.progress ? ` ${task.task.progress.done}/${task.task.progress.total}` : ''}
            </Text>
            <Button size="small" type="link" onClick={task.clear}>
              收起
            </Button>
          </div>
          {task.task.progress === null ? (
            <Tooltip title="后端尚未枚举出总条数，这里只表示「还在跑」，不编造百分比。">
              <Space size={6} style={{ marginTop: tokens.space.sm }}>
                <Spin
                  size="small"
                  indicator={<SyncOutlined spin style={{ color: tokens.color.primary }} />}
                />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  同步中（总条数未知，不显示百分比）
                </Text>
              </Space>
            </Tooltip>
          ) : (
            <Progress
              percent={progressPercent ?? 0}
              size="small"
              strokeColor={task.task.status === 'failed' ? tokens.color.error : tokens.color.primary}
              trailColor={tokens.color.border}
            />
          )}
          {task.task.message ? (
            <Text type={task.task.status === 'failed' ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
              {task.task.message}
            </Text>
          ) : null}
        </div>
      ) : null}

      {task.error ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={task.error} onRetry={task.refresh} title="同步任务查询失败" />
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: tokens.space.sm,
          marginBottom: tokens.space.md,
        }}
      >
        <Input.Search
          size="small"
          allowClear
          style={{ width: 220 }}
          placeholder="搜索模型名"
          onSearch={(value) => {
            setQ(value);
            setPage(1);
          }}
        />
        <Select
          allowClear
          size="small"
          style={{ width: 170 }}
          placeholder="全部上游"
          value={upstreamId}
          options={(upstreams.data?.items ?? []).map((item: Upstream) => ({
            label: item.name,
            value: item.id,
          }))}
          onChange={(value: string | undefined) => {
            setUpstreamId(value);
            setPage(1);
          }}
        />
        <Select
          allowClear
          size="small"
          style={{ width: 150 }}
          placeholder="全部类型"
          value={type}
          options={(Object.keys(TYPE_LABEL) as ModelType[]).map((value) => ({
            label: TYPE_LABEL[value],
            value,
          }))}
          onChange={(value: ModelType | undefined) => {
            setType(value);
            setPage(1);
          }}
        />
        <Select
          allowClear
          size="small"
          style={{ width: 150 }}
          placeholder="全部能力"
          value={capability}
          options={(Object.keys(CAPABILITY_LABEL) as ModelCapability[]).map((value) => ({
            label: CAPABILITY_LABEL[value],
            value,
          }))}
          onChange={(value: ModelCapability | undefined) => {
            setCapability(value);
            setPage(1);
          }}
        />
        <Segmented
          size="small"
          value={enabled === undefined ? 'all' : enabled ? 'on' : 'off'}
          options={[
            { label: '全部', value: 'all' },
            { label: '已启用', value: 'on' },
            { label: '已停用', value: 'off' },
          ]}
          onChange={(value) => {
            setEnabled(value === 'all' ? undefined : value === 'on');
            setPage(1);
          }}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>
          共 {formatCount(list.data?.total ?? 0)} 个模型
        </Text>
      </div>

      {list.error && list.data ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={list.error} onRetry={list.reload} title="刷新失败，以下为上一次成功的数据" />
        </div>
      ) : null}

      {list.loading ? (
        <LoadingState tip="正在加载模型档案…" minHeight={320} />
      ) : list.error && !list.data ? (
        <ErrorState error={list.error} onRetry={list.reload} variant="page" title="模型档案加载失败" />
      ) : models.length === 0 ? (
        <EmptyState
          title={filterActive ? '当前筛选条件下没有模型' : '还没有模型档案'}
          description={
            filterActive
              ? '换个筛选条件，或清空筛选看全部。'
              : '模型档案来自上游拉取：先加好上游并挂上 key，再点右上角「全量同步」。'
          }
          minHeight={320}
          action={
            filterActive ? null : (
              <Button
                type="primary"
                size="small"
                loading={isPending('sync') || task.running}
                onClick={() => {
                  void sync();
                }}
              >
                开始同步
              </Button>
            )
          }
        />
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(304px, 1fr))',
            gap: tokens.space.md,
          }}
        >
          {models.map((model) => {
            const available = model.availableKeyIds.length;
            return (
              <Card
                key={model.id}
                size="small"
                hoverable
                onClick={() => setDetail(model)}
                styles={{ body: { padding: tokens.space.md } }}
                style={{
                  borderColor: model.enabled ? tokens.color.border : tokens.color.borderStrong,
                  opacity: model.enabled ? 1 : 0.66,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: tokens.space.sm,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: tokens.color.textPrimary,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {model.displayName}
                    </div>
                    <Text
                      type="secondary"
                      style={{
                        fontFamily: tokens.font.mono,
                        fontSize: 11,
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {model.name}
                    </Text>
                  </div>
                  <Space size={4}>
                    <Tag bordered={false} style={{ background: tokens.tint.neutral, color: tokens.color.textSecondary }}>
                      {TYPE_LABEL[model.type]}
                    </Tag>
                    {model.enabled ? null : (
                      <Tag bordered={false} style={{ background: tokens.tint.warning, color: tokens.color.warning }}>
                        已停用
                      </Tag>
                    )}
                  </Space>
                </div>

                <div style={{ marginTop: tokens.space.md, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {model.capabilities.length === 0 ? (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      未声明能力
                    </Text>
                  ) : (
                    model.capabilities.map((item) => (
                      <Tag
                        key={item}
                        bordered={false}
                        style={{
                          marginInlineEnd: 0,
                          fontSize: 11,
                          background: tokens.tint.info,
                          color: tokens.color.info,
                        }}
                      >
                        {CAPABILITY_LABEL[item]}
                      </Tag>
                    ))
                  )}
                </div>

                <div
                  style={{
                    marginTop: tokens.space.md,
                    paddingTop: tokens.space.sm,
                    borderTop: `1px solid ${tokens.color.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                  }}
                >
                  <PriceLine model={model} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {model.contextLength === null ? '上下文未知' : `${formatCompact(model.contextLength)} ctx`}
                    </Text>
                    <Tooltip
                      title={
                        available === 0
                          ? '当前没有可服务的 key（全部冷却、禁用或余额不足）——该模型不会出现在 /v1/models'
                          : '启用、非冷却、余额大于 0 的 key 数量'
                      }
                    >
                      <Tag
                        bordered={false}
                        style={{
                          marginInlineEnd: 0,
                          background: available === 0 ? tokens.tint.error : tokens.tint.success,
                          color: available === 0 ? tokens.color.error : tokens.color.success,
                        }}
                      >
                        可用 key {available}
                      </Tag>
                    </Tooltip>
                  </div>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {upstreamName.get(model.upstreamId) ?? model.upstreamId} · 同步于{' '}
                    {formatRelative(model.lastSyncedAt)}
                  </Text>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {list.data && list.data.total > pageSize ? (
        <div style={{ marginTop: tokens.space.md, display: 'flex', justifyContent: 'flex-end' }}>
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              第 {page} / {Math.max(1, Math.ceil(list.data.total / pageSize))} 页
            </Text>
            <Button size="small" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>
              上一页
            </Button>
            <Button
              size="small"
              disabled={page >= Math.ceil(list.data.total / pageSize)}
              onClick={() => setPage((current) => current + 1)}
            >
              下一页
            </Button>
            <Select
              size="small"
              style={{ width: 110 }}
              value={pageSize}
              options={[20, 50, 100].map((value) => ({ label: `${value} / 页`, value }))}
              onChange={(value: number) => {
                setPageSize(value);
                setPage(1);
              }}
            />
          </Space>
        </div>
      ) : null}

      <ModelDetailDrawer
        open={detail !== null}
        model={detail}
        keyLabel={keyLabel}
        onClose={() => setDetail(null)}
        onSaved={list.reload}
      />
    </>
  );
}
