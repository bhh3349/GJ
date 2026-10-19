/**
 * 消费面 · 我的 key —— §19.3 列表 + §19.3b 自助签发 / 改名 / 吊销（v1.15.9 / ADR-0038）。
 *
 * 这一页是 Bo 那条原始反馈的落点：「1panel 的管理界面没有发 key 的按钮，都是用户界面
 * 用户自己发 key」。v1.15.0–v1.15.8 这里只有一张掩码列表，签发要去找管理员 ——
 * 而管理员的签发按钮在**用户组列表**里，与"这是我那个组的第几把、给哪个客户端的"
 * 完全脱节。ADR-0038 把签发权下放到这一页，代价是两条护栏：
 *
 *   · **持数上限 10 把**（`keys.data.keyLimit`，服务端的事实）。到顶时按钮置灰并说明原因，
 *     而不是让人填完表单再吃一个 422。
 *   · **写方法照旧过 CSRF**（服务端闸门，与这一页无关，但它是"下放不等于放行"的证据）。
 *
 * 四条纪律，每条都对应一个具体的坏形状：
 *
 * 1. **没有「显示明文」按钮**。明文只在签发那一次的 201 里出现（§4 铁律 / ADR-0006），
 *    服务端此后没有任何取回路径。一个点了只能失败的按钮比没有按钮更坏 ——
 *    所以取回明文的唯一出路是"再签一把"，而这句话必须写在页面上（不只在注释里）。
 * 2. **不预判"这是不是我的 key"**。服务端用 `WHERE id = ? AND group_id = ?`，
 *    命中不到回 **404**（不是 403 —— 403 会告诉调用方"这个 keyId 存在、只是不属于你"，
 *    那正是枚举别人 key 的反馈信号）。前端跟着 404 说"这把 key 不存在"，
 *    而不是自己先查一遍列表再决定拦不拦。
 * 3. **写完之后就地更新，不整页刷新**（v1.15.4 / ADR-0035 的纪律）：吊销删掉那一行、
 *    改名就地换那一格、签发追加到末尾。**但顺序不去猜** —— 服务端排序固定
 *    `createdAt, id`，所以签发后重拉一次列表，而不是本地插到第一个。
 * 4. **上限用服务端的数**。`keyLimit` 从 `GET /api/console/keys` 来，不在这里写死 10：
 *    写死的失败形状是"服务端改成 20 了、前端还在按 10 拦"，用户看到一个点了必然失败的按钮。
 */
import { KeyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Empty, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';

import { accessInfoApi, consoleApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import type { AccessInfo, ConsoleKeyItem, ConsoleKeys } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { ConsoleKeyRenameModal, ConsoleKeyRevealModal, type ConsoleKeyReveal } from '@/pages/console/ConsoleKeyModals';
import { tokens } from '@/theme/tokens';
import { formatIso, formatRelative } from '@/utils/format';
import { gatewayUrlsOf } from '@/utils/gatewayUrl';

const { Text, Paragraph } = Typography;

export default function ConsoleKeysPage() {
  const { modal } = App.useApp();
  const { run, isPending } = useAction();
  const [reveal, setReveal] = useState<ConsoleKeyReveal | null>(null);
  const [renaming, setRenaming] = useState<ConsoleKeyItem | null>(null);

  const keys = useResource<ConsoleKeys>(() => consoleApi.keys(), []);
  /**
   * Base URL 与 `ConsoleAccessPage` 同源（§18 那一个端点）。
   * 明文弹窗里要一并给出"填哪儿" —— 那两个值只在同一帧里同时握在手上
   * （v1.15.7 / ADR-0036 决策 1），事后再去接入页抄就是又一次"两处各说一半"的机会。
   */
  const access = useResource<AccessInfo>((signal) => accessInfoApi.get({ signal }), []);
  const baseUrl = useMemo(() => gatewayUrlsOf(access.data)?.baseUrl ?? null, [access.data]);

  const list = keys.data?.keys ?? [];
  const limit = keys.data?.keyLimit ?? null;
  const atLimit = limit !== null && list.length >= limit;

  const issue = async (): Promise<void> => {
    const result = await run('issue', () => consoleApi.issueKey(), '已签发新 key');
    if (result === null) return;
    // 明文只在这一帧存在 —— 交给弹窗，父组件负责置回 null。
    setReveal({
      gatewayKey: result.gatewayKey,
      maskedKey: result.maskedKey,
      label: result.label,
      baseUrl,
    });
    // **重拉而不是本地插行**：新 key 恒排在最后（`createdAt, id`），
    // 本地插到第一个是错的顺序，而那个错误会一直留在页面上直到刷新。
    keys.reload();
  };

  const rename = async (keyId: string, label: string | null): Promise<boolean> => {
    const result = await run(`rename:${keyId}`, () => consoleApi.renameKey(keyId, { label }), '已改名');
    if (result === null) return false;
    // 就地换那一格（`label` 回的是**库里那个值**，不是入参 —— 所以直接用它）。
    keys.mutate((prev) =>
      prev === null
        ? prev
        : { ...prev, keys: prev.keys.map((k) => (k.id === keyId ? { ...k, label: result.label } : k)) },
    );
    return true;
  };

  const revoke = (row: ConsoleKeyItem): void => {
    modal.confirm({
      title: '吊销这把 key？',
      content: `${row.maskedKey} 会立即失效且不可恢复（吊销是硬删，没有回收站）。用它的客户端会开始收到 401。`,
      okText: '吊销',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await run(`revoke:${row.id}`, () => consoleApi.removeKey(row.id), '已吊销');
        if (result === null) return;
        // 就地删行：这一行确实没了，而"没了"正是要立刻看见的事（不整页刷新）。
        keys.mutate((prev) =>
          prev === null ? prev : { ...prev, keys: prev.keys.filter((k) => k.id !== row.id) },
        );
      },
    });
  };

  const columns: ColumnsType<ConsoleKeyItem> = [
    {
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
      width: 140,
      render: (_: unknown, row) => (
        <Space size={tokens.space.sm}>
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            onClick={() => setRenaming(row)}
          >
            改名
          </Button>
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
    <>
      <PageHeader
        title="我的 key"
        extra={
          <Space size={tokens.space.sm}>
            <Button size="small" icon={<ReloadOutlined spin={keys.refreshing} />} onClick={keys.reload}>
              刷新
            </Button>
            <Tooltip
              title={
                atLimit
                  ? `已经到 ${limit} 把了。要再签一把，先在下面吊销一把不用的。`
                  : undefined
              }
            >
              {/* 到上限时**真的禁用**（不是一个点了报错的按钮）—— 原因写在 tooltip 与下方提示里。 */}
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={keys.data === null || keys.data.assigned === false || atLimit}
                loading={isPending('issue')}
                onClick={() => {
                  void issue();
                }}
              >
                签发新 key
              </Button>
            </Tooltip>
          </Space>
        }
      />

      <div style={{ display: 'grid', gap: tokens.space.lg }}>
        <Panel
          title="key 列表"
          description="你所在组的全部 key。为安全起见只显示掩码 —— 完整 key 只在签发那一刻出现一次。"
          extra={
            <Space size={tokens.space.sm}>
              {limit !== null ? (
                <Tag icon={<KeyOutlined />} color={atLimit ? 'orange' : 'default'}>
                  {list.length} / {limit} 把
                </Tag>
              ) : (
                <Tag icon={<KeyOutlined />} color="default">
                  {list.length} 把
                </Tag>
              )}
            </Space>
          }
          hint="同一个组下的多把 key 共用同一份配额池（RPM / TPM / 日配额），所以多签一把不是多一份额度 —— 名字是分辨它们的唯一办法。"
        >
          {keys.error !== null && keys.data === null ? (
            <ErrorState error={keys.error} onRetry={keys.reload} variant="page" title="key 列表读取失败" />
          ) : keys.loading ? (
            <LoadingState tip="正在读取 key…" minHeight={200} />
          ) : keys.data === null ? null : keys.data.assigned === false ? (
            <Alert
              type="info"
              showIcon
              message="你还没有被分配到用户组"
              description="组由管理员分配。分配之后这一页就会出现该组的 key，你也可以在这里自己签发 —— 现在签发按钮是灰的，因为签出来的 key 打 /v1 会被判成「组不存在」。"
            />
          ) : (
            <Table<ConsoleKeyItem>
              size="small"
              rowKey="id"
              pagination={false}
              loading={keys.refreshing}
              columns={columns}
              dataSource={list}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="这个组一把 key 都没有。没有 key 就打不通 /v1，点右上角的「签发新 key」。"
                  />
                ),
              }}
            />
          )}

          {keys.data?.assigned === true && limit !== null ? (
            <Paragraph type="secondary" style={{ fontSize: 12, marginTop: tokens.space.md, marginBottom: 0 }}>
              自助签发上限是 <Text strong>{limit}</Text> 把（同一个组的 key 共享同一份配额池，
              第 {limit + 1} 把不带来任何新额度）。{atLimit ? '已经到顶了：要换 key 请先吊销一把不用的。' : ''}
            </Paragraph>
          ) : null}
        </Panel>

        <Panel title="关于 key 的三件事" size="sm">
          <Space direction="vertical" size={tokens.space.xs}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              1. <Text strong>完整 key 只在签发那一刻显示一次</Text>。服务端只保存摘要，
              这一页永远只有掩码 —— 也没有任何「显示明文」的按钮，因为没有任何端点能取回它。
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              2. <Text strong>吊销是硬删</Text>，立即生效、不可恢复。如果只是想给同一台设备换一把，
              就吊销旧的、再签一把新的（这个版本没有「临时停用」）。
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              3. 一把 key 泄漏了就吊销它 —— 组里其他 key 不受影响（它们只是共用配额，
              不是共用同一串凭据）。想换个名字点「改名」，不影响任何客户端。
            </Text>
          </Space>
        </Panel>
      </div>

      <ConsoleKeyRevealModal reveal={reveal} onClose={() => setReveal(null)} />
      <ConsoleKeyRenameModal
        target={renaming === null ? null : { id: renaming.id, maskedKey: renaming.maskedKey, label: renaming.label }}
        onClose={() => setRenaming(null)}
        onSubmit={rename}
        pending={renaming !== null && isPending(`rename:${renaming.id}`)}
      />
    </>
  );
}
