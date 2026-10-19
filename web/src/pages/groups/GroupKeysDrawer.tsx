/**
 * 组内 key 管理抽屉 —— 逐把看见、逐把签发 / 重置 / 吊销（v1.15.7 / ADR-0036 决策 2）。
 *
 * 为什么需要它：四条 key 端点（列表 / 签发 / 重置 / 吊销）自契约 §4 起就在，
 * `api.spec.ts` 里也早有整套用例，而管理面长期只有"整组一个掩码 + 共 N 把"这一层视野 ——
 * 于是 N > 1 时"哪把该重置、哪把该吊销"在界面上没有答案，
 * `groupsApi.resetKey` / `removeKey` 两个函数**零调用方**。Bo 的原话"没有发 key 的按钮"
 * 说的就是这个：不是缺"再发一把"（那个按钮一直在），是缺一个**能对其中一把动手**的面。
 *
 * 四条纪律：
 * 1. **没有"显示明文"入口**。没有任何端点能取回明文（§4 铁律 / ADR-0006），
 *    一个点了只能失败的按钮**比没有按钮更坏**（§19.3 同一句）。要明文只有两个动作：
 *    签发、重置 —— 两者都会当场弹那一帧的明文。
 * 2. **重置确认框必须说出代价**：旧 key **立即失效**（服务端同一个事务里删旧插新），
 *    且重置后**拿到的是新 id**，旧 `keyId` 从此查不到 —— 这句话不写，用户会以为
 *    "重置"是换了个密码、旧的还能用一阵。
 * 3. **吊销就地删掉那一行**，不整页刷新（v1.15.4 / ADR-0035 那条纪律的同一形状）。
 *    同时让父组件去后台校准组行上的 `keyCount` / `gatewayKeyMasked` ——
 *    吊销了列表第一把时那个掩码**必须**跟着变，就地删行不等于就地算对了那个派生值。
 * 4. **列表顺序不去猜**：服务端固定 `createdAt, id`，第一项恒等于组行那个
 *    `gatewayKeyMasked`（契约 §4）。重置/签发之后行的位置会变（新 key 排在最后），
 *    所以那两条动作后**重拉一次这个抽屉的列表**，而不是在本地拼一个"大概的"顺序。
 */
import { KeyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Drawer, Empty, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { groupsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import type { Group, GroupKeyItem } from '@/api/types';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import type { GatewayKeyReveal } from '@/pages/groups/GroupModals';
import { tokens } from '@/theme/tokens';
import { formatIso, formatRelative } from '@/utils/format';

const { Text, Paragraph } = Typography;

export interface GroupKeysDrawerProps {
  /** 有值 = 打开（drawer 显示哪个组由它决定）；`null` = 关闭。 */
  group: Group | null;
  /** 带 `/v1` 的 Base URL（拿不到时 `null`）—— 每次给明文时一并给出，抄 key 的人下一个问题就是"填哪儿"。 */
  baseUrl: string | null;
  onClose: () => void;
  /** 签发 / 重置成功：明文只在这一帧存在，交给父组件立刻展示（父组件负责置回 null）。 */
  onRevealed: (reveal: GatewayKeyReveal) => void;
  /** key 集合变了：父组件去校准组行上的 `keyCount` / `gatewayKeyMasked`。 */
  onChanged: () => void;
}

export function GroupKeysDrawer({
  group,
  baseUrl,
  onClose,
  onRevealed,
  onChanged,
}: GroupKeysDrawerProps) {
  const { modal } = App.useApp();
  const { run, isPending } = useAction();
  const [issuedKeyId, setIssuedKeyId] = useState<string | null>(null);

  const groupId = group?.id ?? null;
  // `groupId` 变了就重拉（抽屉不关、换组打开时也必须换数据）。
  // 关闭时不发请求：`groupId === null` 由 loader 短路成一个空页（不是为了省一次调用，
  // 是为了不出现"抽屉关了还在打请求、回来了写进已卸载的 state"）。
  const keys = useResource(
    () => (groupId === null ? Promise.resolve(null) : groupsApi.listKeys(groupId, { pageSize: 200 })),
    [groupId],
  );

  /**
   * 签发 / 重置的公共尾巴：展示明文一次 + 重拉这个抽屉的列表 + 让父组件校准组行。
   * **不在本地插行**：新 key 恒排在最后（`createdAt, id`），本地插到第一个是**错的顺序**，
   * 而那个错误会直接表现为"组行掩码与列表第一项不一致"（契约 §4 钉过的恒等式）。
   */
  const afterIssued = (reveal: GatewayKeyReveal, keyId: string): void => {
    onRevealed(reveal);
    setIssuedKeyId(keyId);
    keys.reload();
    onChanged();
  };

  const issue = async (): Promise<void> => {
    if (group === null) return;
    const result = await run(`issue:${group.id}`, () => groupsApi.issueKey(group.id), '已签发新 key');
    if (result === null) return;
    afterIssued(
      {
        gatewayKey: result.gatewayKey,
        maskedKey: result.maskedKey,
        baseUrl,
        context: `用户组「${group.name}」新签发的网关 key。`,
      },
      result.id,
    );
  };

  const reset = async (row: GroupKeyItem): Promise<void> => {
    if (group === null) return;
    const result = await run(
      `reset:${row.id}`,
      () => groupsApi.resetKey(group.id, row.id),
      '已重置，旧 key 已失效',
    );
    if (result === null) return;
    afterIssued(
      {
        gatewayKey: result.gatewayKey,
        maskedKey: result.maskedKey,
        baseUrl,
        context: `用户组「${group.name}」重置后的新网关 key（${row.maskedKey} 已立即失效）。`,
      },
      result.id,
    );
  };

  const revoke = (row: GroupKeyItem): void => {
    if (group === null) return;
    modal.confirm({
      title: '吊销这把 key？',
      content: `${row.maskedKey} 会立即失效且不可恢复（吊销是硬删，没有回收站）。用它的客户端会开始收到 401。`,
      okText: '吊销',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await run(
          `revoke:${row.id}`,
          () => groupsApi.removeKey(group.id, row.id),
          '已吊销',
        );
        if (result === null) return;
        // 就地删掉那一行（不是整页刷新）：这一行确实没了，而"没了"正是要立刻看见的事。
        keys.mutate((prev) =>
          prev === null ? prev : { ...prev, items: prev.items.filter((k) => k.id !== row.id), total: prev.total - 1 },
        );
        // 组行上的 keyCount / gatewayKeyMasked 是服务端算的派生值，交给它自己再说一遍。
        onChanged();
      },
    });
  };

  const columns: ColumnsType<GroupKeyItem> = [
    {
      title: 'key',
      dataIndex: 'maskedKey',
      render: (value: string, row) => (
        <Space size={tokens.space.xs}>
          <Text code>{value}</Text>
          {row.id === issuedKeyId ? <Tag color="green">刚签发</Tag> : null}
        </Space>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (value: string) => (
        <Tooltip title={formatIso(value)}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatRelative(value)}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 130,
      render: (_: unknown, row) => (
        <Space size={tokens.space.sm}>
          <Popconfirm
            title="重置这把 key？"
            description="旧 key 立即失效，替换成一把新的 —— 用旧 key 的客户端要立刻换成新的。"
            okText="重置"
            cancelText="取消"
            onConfirm={() => reset(row)}
          >
            <Button size="small" type="link" style={{ padding: 0 }} loading={isPending(`reset:${row.id}`)}>
              重置
            </Button>
          </Popconfirm>
          <Button
            size="small"
            type="link"
            danger
            style={{ padding: 0 }}
            loading={isPending(`revoke:${row.id}`)}
            onClick={() => revoke(row)}
          >
            吊销
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <Drawer
      open={group !== null}
      onClose={onClose}
      width={620}
      title={
        <Space size={tokens.space.sm} wrap>
          <span>key 管理</span>
          {group ? (
            <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 12, fontWeight: 400 }}>
              {group.name}
            </Text>
          ) : null}
        </Space>
      }
      footer={
        <Space size={tokens.space.sm} style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button
            size="small"
            icon={<ReloadOutlined spin={keys.refreshing} />}
            onClick={keys.reload}
          >
            刷新
          </Button>
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            loading={isPending(`issue:${group?.id ?? ''}`)}
            onClick={() => {
              void issue();
            }}
          >
            签发新 key
          </Button>
        </Space>
      }
    >
      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        同一个组下的多把 key <Text strong>共用同一份配额池</Text>（RPM / TPM / 日配额），
        所以多签发一把不是"多一份额度"。
      </Paragraph>

      {keys.error !== null && keys.data === null ? (
        <ErrorState
          error={keys.error}
          onRetry={keys.reload}
          title="key 列表读取失败（`GET /api/groups/:id/keys`）"
        />
      ) : keys.loading ? (
        <LoadingState tip="正在读取该组的 key…" minHeight={200} />
      ) : (
        <Table<GroupKeyItem>
          size="small"
          rowKey="id"
          pagination={false}
          loading={keys.refreshing}
          columns={columns}
          dataSource={keys.data?.items ?? []}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="这个组一把 key 都没有。没有 key 就打不通 /v1，点下面的「签发新 key」。"
              />
            ),
          }}
        />
      )}

      <Alert
        type="warning"
        showIcon
        style={{ marginTop: tokens.space.md, background: tokens.tint.warning, border: 'none' }}
        icon={<KeyOutlined />}
        message="完整 key 只在签发 / 重置那一刻显示一次（本站这把 key 以 gw- 开头）"
        description={
          <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
            库里只存摘要，这个列表永远只有掩码 —— <Text strong style={{ color: tokens.color.textSecondary }}>没有任何端点能取回明文</Text>，
            所以这里也没有"显示明文"按钮。重置会立刻废掉旧 key；共用的那把要换，就走重置（而不是先吊销、再签发）。
          </Text>
        }
      />

      {baseUrl ? (
        <div style={{ marginTop: tokens.space.md }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            客户端 Base URL（结尾的 /v1 不能省）：
          </Text>
          <div style={{ marginTop: tokens.space.xs }}>
            <Text
              style={{ fontFamily: tokens.font.mono, fontSize: 13, wordBreak: 'break-all' }}
              copyable={{ text: baseUrl }}
            >
              {baseUrl}
            </Text>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}
