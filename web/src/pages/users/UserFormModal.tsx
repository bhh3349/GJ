/**
 * 新建用户弹窗。**只有"新建"**：这个弹窗一个字段都不改已经存在的账号。
 *
 * 归属组不在这里改，它在 `UsersPage` 的表里就地改（v1.15.6 的
 * `PATCH /api/users/:username`，body 只认 `groupId`）—— 少一层"编辑 → 弹窗 →
 * 保存"的往返，而改错了当场再改成对的就行。角色与口令仍然没有可改的端点
 * （改角色要走删除重建，见 `UsersPage` 文件头第 2 条）。
 *
 * 三处口径必须与服务端一致，各写一遍就会漂移：
 * 1. **口令至少 8 位**（§1 同一把尺子）。前端先挡一层只是为了少一次往返，
 *    真正的判据在服务端 schema（`minLength: 8`）—— 空口无凭的校验挡不住
 *    直接打 API 的人。
 * 2. **用户名非空、≤64**（服务端 `maxLength: 64`）。唯一性由库判
 *    （撞了回 `409` 或 `400 INVALID_PARAM`，`translateWriteError` 译成"用户名已存在"）。
 * 3. **`groupId` 可空**。空 = 未分配，那个人进消费面会看到"你还没有被分配到组"，
 *    **不是报错**（§19.2 / ADR-0034 决策 5）。所以这里允许建，但默认选中时
 *    提示一句 —— 建一个登进去只能看到空页的账号，是能避免的失望。
 *
 * `role` 默认 `user`：这个页面存在的理由就是发普通用户账号，管理员只有
 * Bo 自己一个（而且不能删最后一个 admin，多一个就多一个锁死风险）。
 */
import { Alert, Form, Input, Modal, Select, Space, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { usersApi } from '@/api/endpoints';
import { useAction } from '@/api/hooks';
import type { UserCreateRequest, UserDto, UserRole } from '@/api/types';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

/** 与服务端 `src/api/routes/users.ts` 的 `createUserBodySchema` 同一把尺子。 */
const USERNAME_MAX = 64;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 512;

export interface UserFormModalProps {
  open: boolean;
  /** 归属组下拉。父组件加载，失败时传空数组（不阻塞建号）。 */
  groups: readonly { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
  /** 建号成功。`password` 是明文，**只在这一帧里存在**，交给父组件立刻展示。 */
  onCreated: (created: UserDto, password: string) => void;
}

interface UserFormValues {
  username: string;
  password: string;
  role: UserRole;
  groupId?: string | null | undefined;
  displayName?: string | null | undefined;
}

export function UserFormModal({ open, groups, onClose, onSaved, onCreated }: UserFormModalProps) {
  const [form] = Form.useForm<UserFormValues>();
  const { run, isPending } = useAction();
  const [role, setRole] = useState<UserRole>('user');

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({
      username: '',
      password: '',
      role: 'user',
      groupId: null,
      displayName: null,
    });
    setRole('user');
  }, [open, form]);

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const body: UserCreateRequest = {
      username: values.username.trim(),
      password: values.password,
      role: values.role,
      // 空串与 null 都是"未分配"，统一成 null 再发 —— 发空串会让服务端
      // 存一个空 group_id，而那张表的 group_id 是可空外键，空串不是 null。
      groupId: values.groupId ?? null,
      displayName: values.displayName?.trim() ? values.displayName.trim() : null,
    };
    const created = await run('save', () => usersApi.create(body), '用户已创建');
    if (created === null) return;
    onSaved();
    onClose();
    // 明文口令只存在于这一次的请求里。交给父组件立刻展示，自己不缓存。
    onCreated(created, body.password);
  };

  return (
    <Modal
      open={open}
      title="新建用户"
      okText="创建"
      cancelText="取消"
      confirmLoading={isPending('save')}
      onOk={() => {
        void submit();
      }}
      onCancel={onClose}
      destroyOnClose
      width={560}
    >
      <Form<UserFormValues> form={form} layout="vertical" requiredMark="optional">
        <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
          <Input placeholder="用于登录的用户名" maxLength={USERNAME_MAX} showCount />
        </Form.Item>

        <Form.Item
          name="password"
          label="登录口令"
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              至少 {PASSWORD_MIN} 位。创建后只显示一次，请当场保存。
            </Text>
          }
          rules={[{ required: true, message: '请设置登录口令' }]}
        >
          <Input.Password placeholder="至少 8 位" maxLength={PASSWORD_MAX} autoComplete="new-password" />
        </Form.Item>

        <Form.Item name="displayName" label="显示名">
          <Input placeholder="选填，便于你和用户本人辨认" maxLength={64} />
        </Form.Item>

        <Form.Item name="role" label="角色" rules={[{ required: true }]}>
          <Select
            onChange={(value: UserRole) => setRole(value)}
            options={[
              { value: 'user', label: '普通用户 —— 只能看消费面（接入地址、本组 key 掩码、本组用量、模型列表）' },
              { value: 'admin', label: '管理员 —— 管理面全部权限' },
            ]}
          />
        </Form.Item>

        {role === 'admin' ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: tokens.space.md, background: tokens.tint.warning, border: 'none' }}
            message="管理员账号等同于把整个网关交出去"
            description="他能改上游凭据、签发 key、删除用户，也能删掉包括你在内的所有账号。给共同使用者请用普通用户。"
          />
        ) : null}

        <Form.Item name="groupId" label="归属组">
          <Select
            allowClear
            placeholder="未分配（该用户进消费面会看到提示）"
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
            notFoundContent={groups.length === 0 ? '还没有用户组，先去「用户组」建一个' : undefined}
          />
        </Form.Item>

        <Space size={tokens.space.xs} direction="vertical" style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            同组的多个用户共享同一批 key、同一个配额池与同一份用量统计。
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            角色建好后不能改 —— 要换角色只能删掉重建。
          </Text>
        </Space>
      </Form>
    </Modal>
  );
}
