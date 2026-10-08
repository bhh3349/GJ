/**
 * 出口池卡片 —— **本期是一个只读占位**（契约 v1.6.4 裁定 + §15.12 锚 3 + §16.7 绑定纪律之三）。
 *
 * 这张卡上**没有任何数据，也不该有任何数据**，三条理由按依赖顺序：
 *
 * 1. **出口状态没有 REST 读面**。`egress_id` 不进任何 DTO；§15.1 的 `SupplierAccount` 是**穷尽**的
 *    （§15.12 锚 3 逐字写着"不加 `egressId` / 出口字段"）。所以**不能**像别的卡片那样去 `GET` 一个端点
 *    —— 没有那样一个端点。凭空造一个形状，就是这一格最贵的错：它会让"出口池有几个"变成一个
 *    看起来有来源的数字。
 * 2. **唯一的读面是 §7 的池级差分帧 `egress_pool`**，而它**本期不发射**（v1.6.4 ④：形状已冻结、
 *    生产者未落地）。接线它等于订阅一个永不到来的帧，然后在一块卡片上渲染出"0 个出口"——
 *    而"0 个出口"正是契约专门要避免的歧义：池级帧存在的全部理由，就是让「已接线且当前 0 个出口」
 *    与「根本没接线」在通道上不同形。
 * 3. **更前置的一条**：它的三个关键字段 `status` / `lastHeartbeatAt` / `exitIp` 的**生产者不存在**
 *    （`deploy/vps-egress/pool-probe.sh` 按设计是无状态的：不摘除、不回池，**心跳没有接收端**）。
 *    按 v1.5.0 写死的「**禁止先加字段、后补生产者**」，这三条必须与**心跳上报链**同一批落地 ——
 *    所以它不是一个"等后端跑起来就有"的字段，而是一整条链。
 *
 * 于是这张卡**只登记形状、不显示状态**：字段名照 §7 帧原样列出，并逐条标注"生产者不存在"。
 * 将来接上时的改动只有一处 —— 把帧里的 `nodes` 接过来渲染；**在此之前，"无数据源"是唯一诚实的显示**。
 *
 * 顺带一条反向纪律：本卡片**不得**渲染「0 个出口」「全部离线」这类结论。
 * 现在没有读面 ⇒ 我们不知道有几个出口，而"不知道"与"没有"是两件事（ADR-0003 同一条刀）。
 */
import { Alert, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';

import { tokens } from '@/theme/tokens';

const { Text, Paragraph } = Typography;

interface EgressFieldRow {
  /** §7 `egress_pool` 帧的字段名，原样（不翻译成别名 —— 接线上的人要按这个名字取）。 */
  field: string;
  meaning: string;
  /** 生产者状态。**没有一条写"已就绪"**：本期三条关键字段全部没有生产者。 */
  producer: string;
}

const FIELDS: readonly EgressFieldRow[] = [
  { field: 'egressId', meaning: '出口标识（不透明字符串，前端不解析）', producer: '帧本身' },
  {
    field: 'name',
    meaning: '出口名（`egress_proxies.name`，唯一）',
    producer: '建表已落（`src/db/schema.ts`）',
  },
  {
    field: 'status',
    meaning: '出口在线状态',
    producer: '不存在 —— 心跳没有接收端',
  },
  { field: 'exitIp', meaning: '出口实际出口 IP', producer: '不存在 —— 心跳没有接收端' },
  {
    field: 'expectedExitIp',
    meaning: '期望出口 IP（与实际的偏差即"出口漂了"）',
    producer: '配置侧（`egress_proxies`）',
  },
  {
    field: 'lastHeartbeatAt',
    meaning: '最近一次心跳时刻',
    producer: '不存在 —— 心跳没有接收端',
  },
  { field: 'cooldownUntil', meaning: '出口级冷却解除时刻', producer: '进程内注册表（重启归零）' },
];

export function EgressPoolCard() {
  const columns: ColumnsType<EgressFieldRow> = [
    {
      title: '字段',
      dataIndex: 'field',
      width: 170,
      render: (value: string) => (
        <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value}</Text>
      ),
    },
    {
      title: '含义',
      dataIndex: 'meaning',
      render: (value: string) => <Text style={{ fontSize: 12 }}>{value}</Text>,
    },
    {
      title: '生产者',
      dataIndex: 'producer',
      width: 240,
      render: (value: string) => {
        const missing = value.startsWith('不存在');
        return (
          <Tag
            bordered={false}
            style={{
              marginInlineEnd: 0,
              background: missing ? tokens.tint.warning : tokens.tint.neutral,
              color: missing ? tokens.color.warning : tokens.color.textSecondary,
              fontSize: 11,
            }}
          >
            {value}
          </Tag>
        );
      },
    },
  ];

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.bgContainer,
        padding: tokens.space.lg,
      }}
    >
      <Space size={tokens.space.sm} align="center" wrap style={{ marginBottom: tokens.space.md }}>
        <Text style={{ fontSize: 13, fontWeight: 600 }}>出口池</Text>
        <Tag
          bordered={false}
          style={{
            marginInlineEnd: 0,
            background: tokens.tint.neutral,
            color: tokens.color.textSecondary,
          }}
        >
          形状已冻结 · 本期无数据源
        </Tag>
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: tokens.space.md, background: tokens.tint.neutral, border: 'none' }}
        message={
          <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
            这一格现在读不到任何出口状态，原因是三件叠在一起：出口状态不走 REST（`egress_id`
            不进任何 DTO）；唯一读面是 §7 的池级帧 <Text code>egress_pool</Text>，而它本期不发射；
            且其中 status / exitIp / lastHeartbeatAt 三条的
            <Text strong style={{ fontSize: 12 }}>
              生产者尚不存在
            </Text>
            （心跳没有接收端）。所以这里只登记字段形状，不显示任何出口状态 —— 包括不显示「0
            个出口」：现在没有读面，我们不知道有几个出口，而「不知道」与「没有」是两件事。
          </Text>
        }
      />

      <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: tokens.space.sm }}>
        下表的字段名照 §7 <Text code>egress_pool</Text> 帧原样列出（不翻译成别名）——
        接线时按这些名字取，形状无需再对。其中「生产者不存在」的三条按 v1.5.0
        「禁止先加字段、后补生产者」必须与<Text strong style={{ fontSize: 12 }}>心跳上报链同一批</Text>落地。
      </Paragraph>

      <Table<EgressFieldRow>
        rowKey="field"
        size="small"
        columns={columns}
        dataSource={[...FIELDS]}
        pagination={false}
        locale={{ emptyText: <Text type="secondary">（字段形状见契约 §7，此处不重复实现取数）</Text> }}
      />

      <Tooltip title="§16.7 处置三档里的 Tier 2：出口 IP 池。DDL 已落（egress_proxies），余下是实配与标定；账号侧绑定为账号级（非 key 级）。">
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: tokens.space.sm }}>
          出口池对应的处置档位是 Tier 2（出口 IP 池）：DDL 已落，实配与标定未做。
        </Text>
      </Tooltip>
    </div>
  );
}
