/**
 * 消费面 · 接入与 key —— §19.5（接入 URL）+ §19.3（本组 key 掩码列表）。
 *
 * Bo 的需求原文是「普通用户只能通过用户前端获取 url 和 key」。这一页就是那件事的落点，
 * 而它之所以**不是**一个"把管理员那页复制过来、删几个字段"的页面，是因为三件事：
 *
 * 1. **URL 的三个字段只有 §18 一个来源**（v1.15.1 / ADR-0034 裁定）。
 *    `publicHost` / `portGateway` / `portAdmin` 只存在于 `GET /api/access-info`，
 *    所以这里调的是 `accessInfoApi.get()` —— **不新开** `/api/console/access-info`。
 *    两个端点回同一份值 = 两份口径，而两份口径将来一定漂移。
 * 2. **key 只有掩码，没有明文**。网关 key 明文只存在于签发那一次的 201 响应体里
 *    （§4 铁律 / ADR-0006），服务端没有任何"再取回"的路径。所以这一页
 *    **不给"复制明文"按钮** —— 按钮点了也只能失败，那是比没有按钮更坏的信号。
 *    v1.15.9 起**取明文的地方是自己那一页**（「我的 key」· 签发即显示一次），
 *    不再是"找管理员"：这一页只说"在哪签"，不替那一页重述规则。
 * 3. **绑定地址（`hostGateway`）从不与端口拼接**。`0.0.0.0` / `127.0.0.1` 是监听语义，
 *    拼出来的 URL 打不开，而用户会以为是我们给错了地址。
 *
 * 与管理面「接入信息」的关系：那一页给管理员看"这服务对外是什么样"（含绑定地址，
 * 用于排查反代），这一页给用户看"我该往客户端里填什么"。同一份数据、两个受众，
 * 所以**共用** `gatewayUrlsOf` 一个拼装点，不各抄一遍公式（ADR-0036 决策 1 的教训）。
 */
import { CopyOutlined, KeyOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Space, Table, Tag, Typography } from 'antd';
import { useMemo } from 'react';
import { Link as RouterLink } from 'react-router-dom';

import { accessInfoApi, consoleApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import type { AccessInfo, ConsoleKeys } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';
import { formatIso } from '@/utils/format';
import { gatewayUrlsOf } from '@/utils/gatewayUrl';

const { Text, Link } = Typography;

export default function ConsoleAccessPage() {
  const access = useResource<AccessInfo>((signal) => accessInfoApi.get({ signal }), []);
  const keys = useResource<ConsoleKeys>(() => consoleApi.keys(), []);

  /**
   * 地址拼装走共享的 `utils/gatewayUrl`（v1.15.7 / ADR-0036 决策 1）。
   * 这一页此前自己复刻了一份 `joinHostPort` 并**漏了 `/v1`**，与管理面那页同病 ——
   * 那段"复刻而不是 import"的理由（"两处各自照契约实现，漂移会在类型上暴露"）
   * 见该文件头注：漂移没有在类型上暴露，因为契约当时也没写 `/v1`。
   * **用户抄走的是 `baseUrl`** ——`root` 只用于"这服务在哪"的核对。
   */
  const gatewayUrls = useMemo(() => gatewayUrlsOf(access.data), [access.data]);
  /** **用户抄走的是这个**（带 `/v1`）；`root` 只是"这服务在哪"的核对值。 */
  const gatewayUrl = gatewayUrls?.baseUrl ?? null;

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 浏览器拒绝剪贴板时不弹错误框盖住内容：地址就在下面摆着，用户可以自己选。
    }
  };

  if (access.loading && keys.loading) {
    return (
      <div>
        <PageHeader title="接入与 key" />
        <LoadingState tip="正在读取接入信息…" minHeight={320} />
      </div>
    );
  }

  if (access.error !== null && access.data === null) {
    return (
      <div>
        <PageHeader title="接入与 key" />
        <ErrorState error={access.error} onRetry={access.reload} variant="page" title="接入信息读取失败" />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="接入与 key"
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined spin={access.refreshing || keys.refreshing} />}
            onClick={() => {
              access.reload();
              keys.reload();
            }}
          >
            刷新
          </Button>
        }
      />

      <div style={{ display: 'grid', gap: tokens.space.lg }}>
        <Panel
          title="API 地址"
          description="把 OpenAI 兼容客户端（ChatGPT-Next-Web、LobeChat、Cursor 等）的 Base URL 填成这个地址。"
          hint="地址由服务端自报的端口 + 公网 host 拼成；host 取 PUBLIC_HOST 配置，没配则用你当前打开本页的地址。结尾的 /v1 是网关路径的一部分，整串照抄，不要截短。"
        >
          {gatewayUrl === null ? (
            <EmptyState title="无法确定对外地址" minHeight={80} />
          ) : (
            <Space direction="vertical" size={tokens.space.sm} style={{ width: '100%' }}>
              <Space size={tokens.space.sm} wrap>
                <Text
                  code
                  copyable={{ text: gatewayUrl, onCopy: () => void copy(gatewayUrl) }}
                  style={{ fontSize: 14, padding: '6px 10px' }}
                >
                  {gatewayUrl}
                </Text>
                <Button size="small" icon={<CopyOutlined />} onClick={() => void copy(gatewayUrl)}>
                  复制
                </Button>
              </Space>
              <Text type="secondary" style={{ fontSize: 12 }}>
                密钥（API Key）用下面列表里的任意一把 —— 以 <Text code>gw-</Text> 开头的完整串
                （这是本站自己签发的网关 key，刻意与上游的 <Text code>sk-</Text> 区分开）。
                要新的一把，去{' '}
                <RouterLink to="/console/keys">我的 key</RouterLink>{' '}
                自己签发 —— 完整 key 会在签发那一刻显示一次，之后只剩掩码。
              </Text>
            </Space>
          )}
        </Panel>

        <Panel
          title="我的 key"
          description="以下是你所在组的全部 key。为安全起见只显示掩码。"
          extra={<Tag icon={<KeyOutlined />} color="default">{keys.data?.keys.length ?? 0} 把</Tag>}
          hint="签发 / 改名 / 吊销在「我的 key」那一页。这里只回答「我要填进客户端的那个地址是什么」。"
        >
          {keys.error !== null && keys.data === null ? (
            <ErrorState error={keys.error} onRetry={keys.reload} title="key 列表读取失败" />
          ) : keys.loading ? (
            <LoadingState tip="正在读取 key…" minHeight={160} />
          ) : keys.data === null ? null : keys.data.assigned === false ? (
            <Alert
              type="info"
              showIcon
              message="你还没有被分配到组"
              description="组由管理员分配。分配之后，本页会显示该组下的 key，用量页也会显示对应数据。"
            />
          ) : keys.data.keys.length === 0 ? (
            <EmptyState title="你的组还没有 key（管理员创建后会出现在这里）" minHeight={140} />
          ) : (
            <Table<ConsoleKeys['keys'][number]>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={[...keys.data.keys]}
              columns={[
                {
                  // 名称（v1.15.9）：这一页的列表是"我手上有哪些凭据"的只读视角，
                  // 多一把 key 就多一行「未命名」，而名字是分辨它们的唯一办法 ——
                  // 这里不显示列，用户就得跳到「我的 key」才知道每把是干什么的。
                  title: '名称',
                  dataIndex: 'label',
                  width: 180,
                  render: (value: string | null) =>
                    value === null ? (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        未命名
                      </Text>
                    ) : (
                      <Text style={{ fontSize: 13 }}>{value}</Text>
                    ),
                },
                {
                  title: 'key',
                  dataIndex: 'maskedKey',
                  render: (value: string) => <Text code>{value}</Text>,
                },
                {
                  title: '创建时间',
                  dataIndex: 'createdAt',
                  width: 220,
                  render: (value: string) => (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {formatIso(value)}
                    </Text>
                  ),
                },
              ]}
            />
          )}

          <Alert
            type="warning"
            showIcon
            style={{ marginTop: tokens.space.md }}
            message="完整 key 只在签发那一刻显示一次"
            description={
              <Text style={{ fontSize: 12 }}>
                服务端只保存摘要，这一页永远只有掩码 —— 没有任何端点能取回明文。
                要新的一把（或旧的那把丢了），去{' '}
                <RouterLink to="/console/keys">我的 key</RouterLink> 自己签发；
                同一把不用了就把它吊销。
              </Text>
            }
          />
        </Panel>

        <Panel title="怎么用" size="sm">
          <Space direction="vertical" size={tokens.space.xs}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              1. 复制上面的 API 地址，填进客户端设置。
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              2. 密钥填完整 key（在「我的 key」里自己签发，只有那一刻能抄），
              模型名填「模型广场」里列出的任意一个。
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              3. 有疑问先看用量页：请求是否到达、错误出现在哪个模型，那里都记着。
            </Text>
            {access.data !== null && access.data.adminWebDistEnabled ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                当前页面由 <Link href={window.location.origin} target="_blank" rel="noreferrer">同一服务</Link> 托管，
                地址栏即是本服务的入口。
              </Text>
            ) : null}
          </Space>
        </Panel>
      </div>
    </>
  );
}
