/**
 * 管理面 · 用户管理 —— §19.7。
 *
 * 这是**唯一能造出 `role=user` 的地方**（服务端亦然：`src/api/routes/users.ts`
 * 是全仓唯一建用户的入口，消费面全程只读）。所以这一页的每一次点击都在改变
 * "谁能登进这个网关"，它的纪律比别的管理页更硬：
 *
 * 1. **口令明文只在这一页出现一次**。`POST /api/users` 的响应里没有口令，
 *    库里只有散列，**没有任何端点能再取回**（§4 铁律）。所以建号成功后的弹窗
 *    照用户组的 `GatewayKeyRevealModal` 同一形状做：一次性展示 + 显式复制按钮
 *    + "现在不抄之后就拿不到了"。**不给"再次查看"入口** —— 那个按钮点了也只能失败，
 *    比没有按钮更坏。
 * 2. **可改的只有归属组**（v1.15.6 / ADR-0035 决策 2）。服务端开了
 *    `PATCH /api/users/:username` 且 body 只认 `groupId` —— 于是这一页的表里
 *    「归属组」那一格是**就地可编**的，别处没有编辑入口。**没有"改角色"**：
 *    服务端刻意不提供（那会让"把自己降级"变成一次普通请求，降完就改不回来，
 *    因为 `/api/users` 只有 admin 能进）。改角色仍然只能删了重建。
 *    两个字段的失败形状不相同，所以处理方式也不该相同：进错组改回来即可
 *    （下一个请求就是新组），而降错角色不可逆。
 * 3. **删除的两条下限由服务端判，前端只原样转述**。删自己、删最后一个 admin
 *    都是 `400 INVALID_PARAM`。前端不抢先判一遍 —— 抢先判的失败形状是
 *    "前端说能删、服务端说不能"，而那个准是服务端对；而且两处判据一旦漂移，
 *    用户看到的就是一个自相矛盾的界面。
 * 4. **`role=user` 看不到这一页**。不是前端藏的（§19.1 授面在服务端闸门里），
 *    前端只是不给他入口。
 */
import { PlusOutlined, ReloadOutlined, SafetyOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, App, Button, Empty, Popconfirm, Select, Space, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useState } from 'react';

import { groupsApi, usersApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { PAGE_SIZE_DEFAULT, type PageQuery, type UserDto } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { PasswordRevealModal, type PasswordReveal } from '@/pages/users/PasswordRevealModal';
import { UserFormModal } from '@/pages/users/UserFormModal';
import { tokens } from '@/theme/tokens';
import { formatIso, formatRelative } from '@/utils/format';

const { Text } = Typography;

export default function UsersPage() {
  const { modal } = App.useApp();
  const { run, isPending } = useAction();

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [formOpen, setFormOpen] = useState(false);
  const [reveal, setReveal] = useState<PasswordReveal | null>(null);

  const queryKey = JSON.stringify({ page, pageSize } satisfies PageQuery);
  const list = useResource(() => usersApi.list(JSON.parse(queryKey) as PageQuery), [queryKey]);

  // 归属组下拉的数据源（建号弹窗与表里那一格共用）。失败**不阻塞**建号：
  // 组下拉空着照样能建（`groupId` 可选），为它把整页打成错态是拿一个次要功能
  // 挡主要功能。表里那一格同样——加载不出来时是空下拉，不是坏掉的页面。
  const groups = useResource(() => groupsApi.list({ pageSize: 200 }), []);

  const remove = (row: UserDto) => {
    modal.confirm({
      title: `删除用户「${row.username}」？`,
      content: '删除会立即吊销他的全部会话，且不可恢复。历史调用日志按组保留。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await run(`delete:${row.username}`, () => usersApi.remove(row.username), '已删除');
        if (result !== null) list.reload();
      },
    });
  };

  /*
    就地改归属组（v1.15.6 / §19.7 PATCH）。选下拉 = 改组，清空 = 退回未分配。
    成功后**不整页刷新**：响应体就是新的 UserDto，直接落回行 state，与「删除后
    实时更新」的纪律同一条 —— 让操作者再自己按 F5，等于把"改没改成"变回猜谜。
    服务端对坏 groupId 回 400 INVALID_PARAM（`details.field: 'groupId'`），
    由 useAction 统一弹错，这里不提前判：判据（外键）在服务端库里，前端复刻
    一份必漂移。
  */
  const changeGroup = async (row: UserDto, nextGroupId: string | null): Promise<void> => {
    if (nextGroupId === row.groupId) return; // 没变就不发请求：不发"什么都没改"的 PATCH
    const updated = await run(`group:${row.username}`, () => usersApi.update(row.username, { groupId: nextGroupId }), '已保存');
    if (updated === null) return; // 失败：行数据不动，下拉仍显示原值
    // 服务端回的就是权威行。直接替换该项 —— `updatedAt` 也在响应里，不另行推算。
    list.mutate((prev) =>
      prev === null ? prev : { ...prev, items: prev.items.map((u) => (u.username === updated.username ? updated : u)) },
    );
  };

  const columns: ColumnsType<UserDto> = [
    {
      title: '账号',
      dataIndex: 'username',
      width: 180,
      render: (value: string, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Space size={tokens.space.xs}>
            <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value}</Text>
            {row.role === 'admin' ? (
              <Tag color="gold" icon={<SafetyOutlined />}>
                管理员
              </Tag>
            ) : (
              <Tag icon={<UserOutlined />}>普通用户</Tag>
            )}
          </Space>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {row.displayName ?? '未设置显示名'}
          </Text>
        </div>
      ),
    },
    {
      title: '归属组',
      dataIndex: 'groupId',
      width: 200,
      // 就地可编（v1.15.6）：这一格是**页面上唯一一个能改已经存在的账号的地方**。
      // 用 Select 而不是"编辑 → 弹窗 → 保存"三段式：只改一个字段，弹窗那一层
      // 只是在点第二次"确定"。清空（allowClear）= 退回未分配，是一个合法值。
      render: (value: string | null, row) => (
        <Select
          size="small"
          style={{ width: '100%' }}
          // `null` → `undefined`：未分配**不是**下拉里的一个选项，是"什么都没选"。
          // 这样清空（allowClear）与"本来就是未分配"走同一条显示路径（placeholder），
          // 不会出现"选项里点未分配"与"点 × 清空"两条语义相同的路各写一遍。
          value={value ?? undefined}
          allowClear
          placeholder="未分配"
          options={(groups.data?.items ?? []).map((g) => ({ value: g.id, label: g.name }))}
          loading={isPending(`group:${row.username}`)}
          // 一个组都没有时下拉是空的（"未分配"不是选项）—— 这时缺的那一步是去建组。
          notFoundContent={
            (groups.data?.items ?? []).length === 0 ? '还没有用户组，先去「用户组」建一个' : undefined
          }
          onChange={(next: string | undefined) => {
            // 清空（× 或退格）落到 `undefined` —— 那正是"退回未分配"，
            // 所以 `undefined` 与"本来就没选"在这里合成同一个值：null。
            void changeGroup(row, next ?? null);
          }}
        />
      ),
    },
    {
      title: '创建于',
      dataIndex: 'createdAt',
      width: 130,
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
      width: 90,
      render: (_: unknown, row) => (
        // 只有"删除"一个动作：归属组在表里就地改（见上面「归属组」列），
        // 角色与口令没有可改的端点（文件头第 2 条）。
        // 删自己会被服务端拒（`username === 当前会话`），这里不抢先置灰 ——
        // 抢先置灰会让"为什么不能删"变成一个只在评论里存在的答案。
        <Popconfirm
          title="确认删除"
          description="不可恢复"
          okButtonProps={{ danger: true }}
          onConfirm={() => remove(row)}
        >
          <Button size="small" type="link" danger style={{ padding: 0 }} loading={isPending(`delete:${row.username}`)}>
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="用户管理"
        extra={
          <Space size={tokens.space.sm}>
            <Button
              size="small"
              icon={<ReloadOutlined spin={list.refreshing} />}
              onClick={list.reload}
            >
              刷新
            </Button>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => setFormOpen(true)}>
              新建用户
            </Button>
          </Space>
        }
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: tokens.space.md, background: tokens.tint.info, border: 'none' }}
        message="普通用户登录后只能看到消费面（接入地址、本组 key 掩码、本组用量、模型列表）"
        description={
          <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
            账号口令只在你创建时显示一次，之后连管理面也取不回 —— 需要时只能删了重建。
            归属组可以直接在表里改（改完立刻生效，他不用重新登录）；角色建好后不能改，
            要换角色同样走删除重建。
          </Text>
        }
      />

      {list.error !== null && list.data !== null ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={list.error} onRetry={list.reload} title="刷新失败，以下为上一次成功的数据" />
        </div>
      ) : null}

      {list.loading ? (
        <LoadingState tip="正在加载用户…" minHeight={320} />
      ) : list.error !== null && list.data === null ? (
        <ErrorState error={list.error} onRetry={list.reload} variant="page" title="用户列表加载失败" />
      ) : (
        <Table<UserDto>
          rowKey="username"
          size="small"
          columns={columns}
          dataSource={list.data?.items ?? []}
          loading={list.refreshing}
          scroll={{ x: 720 }}
          pagination={{
            current: page,
            pageSize,
            total: list.data?.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [20, 50, 100, 200],
            showTotal: (total) => `共 ${total} 个账号`,
            onChange: (nextPage, nextSize) => {
              setPage(nextPage);
              setPageSize(nextSize);
            },
          }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="还没有用户。新建的第一个账号如果是普通用户，他就能登录消费面了。"
              />
            ),
          }}
        />
      )}

      <UserFormModal
        open={formOpen}
        groups={(groups.data?.items ?? []).map((g) => ({ id: g.id, name: g.name }))}
        onClose={() => setFormOpen(false)}
        onSaved={list.reload}
        onCreated={(created, password) => {
          setReveal({
            username: created.username,
            password,
            role: created.role,
            context:
              created.role === 'user'
                ? `普通用户「${created.username}」已创建。这是他的登录口令，请交给他本人。`
                : `管理员「${created.username}」已创建。这是他的登录口令。`,
          });
        }}
      />

      <PasswordRevealModal reveal={reveal} onClose={() => setReveal(null)} />
    </>
  );
}
