/**
 * 消费面 · 模型广场 —— §19.6 `GET /api/console/models` + §19.5 接入地址 + 接口说明。
 *
 * 这一页现在回答三个连在一起的问题，而它们必须**在同一屏**里：
 * 「我该往客户端里填什么地址」「填完之后能打哪几个接口」「`model` 该填哪个名字」。
 * 分成三页会退回到那个原始抱怨的形状 —— 用户在 A 页抄到地址、在 B 页抄到模型名，
 * 中间那一步「这两个东西怎么拼成一次调用」谁也没说。
 *
 * **唯一一条不可动摇的纪律**：用户端看到的集合必须与网关实际准入的集合一致
 * （契约 §19.6，与 §10 `/v1/models` 同一判据）。不一致的形状不是"少显示一个模型"，
 * 是**用户照列表去调用、拿到 403/404**，然后来问"你们站上到底有没有这个模型" ——
 * 那是一个会骗人的信号。
 *
 * 〔v1.15.9 订正「不做任何本地过滤」这句话的**适用范围**。原话是在 v1.15.8 修完
 * `enabled` 那个假三态之后留下的，它当时防的是"把服务端已经判定可用的模型藏起来"
 * （`item.enabled ? … : 已停用` 那条分支：字段恒 `undefined`，于是每个模型都被标成
 * 已停用、一按「只看可用」清空列表）。这个禁令**原样成立**。但它不等于"页面上不能有
 * 搜索框"—— 两者的区别是**谁在收窄**：
 *   · 服务端收窄（组授权 ∩ enabled）= **集合**，前端一个字都不能改，改了就是骗人；
 *   · 用户自己敲进去的关键字 = **视图**，他明确要求"只看这几个"，看不到别的正是他想要的。
 * 判据因此是：**筛选器必须自报家门**。所以下面那行恒写 `已筛选 N / 共 M`，
 * 筛到空时给"清除筛选"而不是一个空白页 —— 只要用户随时能看出"是我筛掉的、不是没有"，
 * 视图收窄就不构成骗人的信号。把这条说清楚，是因为下一个人很可能把「刚才那个开关」
 * 和「现在这个搜索框」当成同一类东西删掉。〕
 *
 * 与管理面「模型」页的差异是**类型层**的：这里用 `ConsoleModel`，不是 §5 的
 * `ModelProfile`（后者带 `upstreamId` / `price` / `availableKeyIds` / `revision` ——
 * 服务端一个都不回）。所以这不是"前端挑了字段显示"，是响应体里压根没有那些列。
 *
 * **可复制的值是 `name`**：用户要把它填进客户端的 `model` 字段（§10 的请求键是模型名），
 * 而 `id` 是档案行号（`mdl_*`），填它会 404。
 */
import { CopyOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { App, Button, Input, Segmented, Space, Tag, Tooltip, Typography } from 'antd';
import { useMemo, useState } from 'react';

import { accessInfoApi, consoleApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import type { AccessInfo, ConsoleModel, ConsoleModels } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';
import { formatCompact } from '@/utils/format';
import { gatewayUrlsOf } from '@/utils/gatewayUrl';

const { Text, Paragraph } = Typography;

/**
 * 模型类型的显示名。**只用于显示** —— `ConsoleModel.type` 是服务端给的 `string`，
 * 不在表里就原样显示（`?? item.type`），绝不猜、也不把它归到某一类里。
 */
const TYPE_LABEL: Record<string, string> = {
  chat: '对话',
  embedding: '向量',
  image: '图像',
  audio: '语音',
  rerank: '重排',
};

/**
 * 能力标签的显示名。**刻意在本页重写一份，而不是 import 管理面的
 * `@/pages/models/CapabilityRow` 那个 `CAPABILITY_LABEL`** —— 那是一次会静默
 * 破坏分包的 import：`CapabilityRow` 那个模块里带着整套三态渲染 + 管理面类型，
 * 一旦被消费面的 chunk 引到，`role=user` 的浏览器就会下载管理面代码。
 * 而这件事**不会有任何编译错误**（分包纪律在构建产物上才失效，见 `ConsoleLayout` 头注）。
 *
 * 两份表会漂移吗？会 —— 但它们漂移的代价只是标签文案不一致，不是数据不一致；
 * 与"把管理面代码塞进用户浏览器"相比，这是明知代价的那个选择（ADR-0034 决策 4）。
 * 认不出的能力原样显示，绝不猜（`?? capability`）。
 */
const CAPABILITY_TEXT: Record<string, string> = {
  stream: '流式',
  function_call: '函数调用',
  vision: '视觉',
  json_mode: 'JSON 模式',
};

/**
 * 网关**真正实现**的三个端点（§10）。
 *
 * 这里是全站第二个写这三个路径的地方，而它必须是**穷举**的：
 * `src/gateway/routes.ts` 只注册了这三条（外加 `UNSUPPORTED_PREFIXES` 的 501 与兜底 404），
 * 所以多写一个路径就是教用户打一个必 404 的接口。
 *
 * **只列这三个、不列"即将支持"**：`image` / `audio` / `rerank` 这些能建档案但接口
 * 回 `501 UNSUPPORTED_ENDPOINT`（§10 表），把它们列在"接口说明"里等于给出一份
 * 半真半假的清单 —— 而用户没法从清单上分辨哪条是真的。真要列，得等它们真的实现。
 */
const ENDPOINTS: readonly { method: 'GET' | 'POST'; path: string; summary: string }[] = [
  { method: 'GET', path: '/v1/models', summary: '列出你能用的模型（本页数据就是这个接口的返回）' },
  { method: 'POST', path: '/v1/chat/completions', summary: '对话补全，`messages` 必填；支持 `stream: true` 流式' },
  { method: 'POST', path: '/v1/embeddings', summary: '向量化，`input` 必填' },
];

/** 一行「标签 + 等宽值 + 复制」。地址与模型名都用它，两处的读法因此一致。 */
function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const { message } = App.useApp();
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      message.success('已复制');
    } catch {
      // 浏览器拒绝剪贴板时不弹错误框盖住内容：值就在旁边摆着，用户可以自己选。
    }
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: tokens.space.md,
        padding: `${tokens.space.xs}px 0`,
        flexWrap: 'wrap',
      }}
    >
      <Text type="secondary" style={{ fontSize: 12, flex: 'none', width: 88 }}>
        {label}
      </Text>
      <Text code style={{ fontSize: 13, wordBreak: 'break-all', minWidth: 0 }}>
        {value}
      </Text>
      <Tooltip title={hint}>
        <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => void copy()}>
          复制
        </Button>
      </Tooltip>
    </div>
  );
}

export default function ConsoleModelsPage() {
  const models = useResource<ConsoleModels>(() => consoleApi.models(), []);
  /**
   * 接入地址与 `ConsoleAccessPage` / 我的 key 同一来源（§18 那一个端点、§19.5 那一条公式）。
   * 三个页共用 `gatewayUrlsOf` 一个拼装点 —— `/v1` 后缀只写在那里一处（ADR-0036 决策 1）。
   */
  const access = useResource<AccessInfo>((signal) => accessInfoApi.get({ signal }), []);

  /** 视图筛选（不改集合，见文件头）：关键字 + 类型。 */
  const [keyword, setKeyword] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const all = models.data?.models ?? [];

  /**
   * 类型筛选项**从返回数据里长出来**，不是照 `TYPE_LABEL` 铺一遍。
   * 照标签铺会给出「图像 / 语音 / 重排」这类零点就筛空的选项 ——
   * 一个筛出来必然为空的漏斗是骗人信号的另一种形状。
   */
  const typeOptions = useMemo(() => {
    const seen = new Map<string, number>();
    for (const item of all) seen.set(item.type, (seen.get(item.type) ?? 0) + 1);
    return [
      { label: `全部 ${all.length}`, value: 'all' },
      ...[...seen.entries()].map(([type, count]) => ({
        label: `${TYPE_LABEL[type] ?? type} ${count}`,
        value: type,
      })),
    ];
  }, [all]);

  const visible = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    return all.filter((item) => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false;
      if (needle === '') return true;
      return (
        item.name.toLowerCase().includes(needle) ||
        (item.displayName ?? '').toLowerCase().includes(needle)
      );
    });
  }, [all, keyword, typeFilter]);

  const filtering = keyword.trim() !== '' || typeFilter !== 'all';
  const baseUrl = useMemo(() => gatewayUrlsOf(access.data)?.baseUrl ?? null, [access.data]);

  if (models.loading) {
    return (
      <div>
        <PageHeader title="模型广场" />
        <LoadingState tip="正在读取模型列表…" minHeight={320} />
      </div>
    );
  }

  if (models.error !== null && models.data === null) {
    return (
      <div>
        <PageHeader title="模型广场" />
        <ErrorState error={models.error} onRetry={models.reload} variant="page" title="模型列表读取失败" />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="模型广场"
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined spin={models.refreshing || access.refreshing} />}
            onClick={() => {
              models.reload();
              access.reload();
            }}
          >
            刷新
          </Button>
        }
      />

      <div style={{ display: 'grid', gap: tokens.space.lg, marginBottom: tokens.space.lg }}>
        <Panel
          title="接入地址"
          description="把这一串填进 OpenAI 兼容客户端（ChatGPT-Next-Web、LobeChat、Cursor 等）的 Base URL。"
          hint="地址由服务端自报的端口 + 公网 host 拼成（与「接入与 key」那一页同一个公式）。结尾的 /v1 是网关路径的一部分，整串照抄，不要截短。"
        >
          {baseUrl === null ? (
            <EmptyState title="无法确定对外地址" minHeight={80} />
          ) : (
            <CopyRow
              label="Base URL"
              value={baseUrl}
              hint="客户端设置里的「接口地址 / API Base」。少了结尾的 /v1 会直接 404。"
            />
          )}
          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: tokens.space.sm, marginBottom: 0 }}>
            密钥（API Key）填 <Text code>gw-</Text> 开头的完整串 —— 那是本站自己签发的网关 key
            （刻意与上游的 <Text code>sk-</Text> 区分开）。手上有哪几把、要不要新签一把，
            去「我的 key」那一页。
          </Paragraph>
        </Panel>

        <Panel
          title="接口说明"
          description="网关目前实现了下面这三个接口，除此之外的路径一律 404（或 501「未实现」）。"
          extra={<Tag color="default">{ENDPOINTS.length} 个</Tag>}
          hint="请求头只有一种形式：Authorization: Bearer <你的网关 key>。没有 x-api-key、没有 ?api_key= 这类兼容写法 —— 那些一律当成没带凭据。"
        >
          <Space direction="vertical" size={tokens.space.sm} style={{ width: '100%' }}>
            {ENDPOINTS.map((item) => (
              <div
                key={`${item.method} ${item.path}`}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: tokens.space.md,
                  flexWrap: 'wrap',
                  padding: `${tokens.space.xs}px 0`,
                }}
              >
                <Tag
                  color={item.method === 'GET' ? 'blue' : 'green'}
                  style={{ minWidth: 48, textAlign: 'center', margin: 0 }}
                >
                  {item.method}
                </Tag>
                <Text code style={{ fontSize: 13 }}>
                  {item.path}
                </Text>
                <Text type="secondary" style={{ fontSize: 12, flex: 1, minWidth: 200 }}>
                  {item.summary}
                </Text>
              </div>
            ))}
          </Space>
          <Paragraph type="secondary" style={{ fontSize: 12, marginTop: tokens.space.md, marginBottom: 0 }}>
            鉴权只有一种：请求头 <Text code>Authorization: Bearer &lt;你的网关 key&gt;</Text>。
            兼容 <Text code>/v1/chat/completions</Text> 的客户端除了模型名以外不用改任何设置 ——
            模型名从下面那张表里抄。
          </Paragraph>
        </Panel>
      </div>

      <Panel
        title="可用模型"
        description="调用时 model 字段填这里的名称。列表与网关实际准入的集合一致。"
        extra={
          <Tag color={filtering ? 'orange' : 'default'}>
            {filtering ? `已筛选 ${visible.length} / 共 ${all.length}` : `${all.length} 个可用`}
          </Tag>
        }
        hint="授权与启用都由管理员设置；这里列出的每一个都能直接调用，没有「列出来但其实不能用」的模型。搜索与类型只收窄这一屏的显示，不改变服务端给你的集合。"
      >
        {models.error !== null && models.data !== null ? (
          <div style={{ marginBottom: tokens.space.md }}>
            <ErrorState error={models.error} onRetry={models.reload} title="刷新失败，以下为上一次成功的数据" />
          </div>
        ) : null}

        {all.length === 0 ? (
          <EmptyState title="当前没有可用的模型（请联系管理员）" minHeight={200} />
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: tokens.space.sm,
                marginBottom: tokens.space.md,
              }}
            >
              <Input
                size="small"
                allowClear
                style={{ width: 260 }}
                prefix={<SearchOutlined style={{ color: tokens.color.textTertiary }} />}
                placeholder="搜模型名（如 gpt-4o）"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
              />
              <Segmented
                size="small"
                value={typeFilter}
                options={typeOptions}
                onChange={(value) => setTypeFilter(String(value))}
              />
            </div>

            {visible.length === 0 ? (
              <EmptyState
                title="没有匹配的模型"
                minHeight={200}
                action={
                  <Button
                    size="small"
                    onClick={() => {
                      setKeyword('');
                      setTypeFilter('all');
                    }}
                  >
                    清除筛选（共 {all.length} 个）
                  </Button>
                }
              />
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                  gap: tokens.space.md,
                }}
              >
                {visible.map((item) => (
                  <ModelCard key={item.id} item={item} />
                ))}
              </div>
            )}
          </>
        )}
      </Panel>
    </>
  );
}

/** 一张模型卡：名称（可复制）+ 类型 + 上下文长度 + 能力标签。 */
function ModelCard({ item }: { item: ConsoleModel }) {
  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        padding: tokens.space.md,
        background: tokens.color.bgContainer,
      }}
    >
      <Space direction="vertical" size={tokens.space.xs} style={{ width: '100%' }}>
        <Text strong style={{ fontSize: 13 }}>
          {item.displayName ?? item.name}
        </Text>
        {/* 可复制的是 `name`（§10 的请求键），不是 `id`（档案行号，填它会 404）。 */}
        <Text code copyable={{ text: item.name }} style={{ fontSize: 12 }}>
          {item.name}
        </Text>
        <Space size={tokens.space.xs} wrap>
          {/* `type !== 'chat'` 才显示：绝大多数是对话模型，每张卡都挂一个「对话」标签
              只会把真正需要分辨的那几个淹掉。 */}
          {item.type !== 'chat' ? <Tag color="default">{TYPE_LABEL[item.type] ?? item.type}</Tag> : null}
          {item.contextLength !== null ? (
            <Tag bordered={false}>
              <Text type="secondary" style={{ fontSize: 11 }}>
                上下文 {formatCompact(item.contextLength)}
              </Text>
            </Tag>
          ) : null}
        </Space>
        {item.capabilities.length > 0 ? (
          <Space size={4} wrap>
            {item.capabilities.map((capability) => (
              <Tag key={capability} bordered={false} color="processing" style={{ fontSize: 11 }}>
                {CAPABILITY_TEXT[capability] ?? capability}
              </Tag>
            ))}
          </Space>
        ) : null}
      </Space>
    </div>
  );
}
