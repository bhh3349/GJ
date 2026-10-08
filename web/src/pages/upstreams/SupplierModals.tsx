/**
 * 账号池的两个**入口弹窗**：导入账号（§15.2 `import`）与批量建 key 并入池（§15.2 `keys`）。
 *
 * 两条纪律各自只有一个实现处，所以放在同一个文件里对照着看：
 *
 * 1. **密码明文只进不回**（§15.8 第 2 问 / §15.9）。导入框里那行「手机号,密码」是**唯一**
 *    允许出现明文的界面元素：提交后**立刻从表单里抹掉**（`resetFields`），不留回显、不写本地存储、
 *    不进 URL。响应、日志、审计 detail、任务 result、错误 message 里都没有它 —— 所以这里
 *    也**不提供**"查看已导入的密码"这种入口（没有那样的读面，做出来就是把明文留在浏览器里）。
 * 2. **上游明文不经浏览器**（§15.8 第 3 问）。建 key 是服务端自己去上游取、当场加密落库，
 *    只回 `keyId` + `keyMasked` ⇒ 这里**不做**"一次性明文"浮层，结论浮层里那一列是掩码。
 *
 * 另一个刻意的留白：两个弹窗都**不预测会有几次上游请求**。§14.7 写死了"量级由服务端给，
 * 前端不得自造承诺" —— `count` / 账号数是最容易被顺手乘 2 的两个数（§15.5：建 key = 2 次请求/账号），
 * 乘出来的数字不是承诺而是编造，所以这里只回显**选择事实**（选了几个账号、要建几把），不做乘法。
 */
import { Alert, Form, Input, InputNumber, Modal, Select, Space, Switch, Typography } from 'antd';
import { useEffect } from 'react';

import { supplierAccountsApi } from '@/api/endpoints';
import { useAction } from '@/api/hooks';
import type { SupplierKeysRequest } from '@/api/types';
import { tokens } from '@/theme/tokens';
import { formatCount } from '@/utils/format';

const { Text } = Typography;

/** 契约 §15.2 `keys`：`count` 1..10，越界**在本次 HTTP 里就 400**（不变成立刻失败的异步任务）。 */
const KEY_COUNT_MIN = 1;
const KEY_COUNT_MAX = 10;

// ── 导入账号 ──────────────────────────────────────────────────────────────

interface ImportFormValues {
  text: string;
}

export interface SupplierImportModalProps {
  open: boolean;
  upstreamId: string;
  onClose: () => void;
  /** 202 拿到 `taskId` 就交给调用方去轮询 —— 成了几行要等 §15.3 的逐行结果说话。 */
  onSubmitted: (taskId: string) => void;
}

export function SupplierImportModal({ open, upstreamId, onClose, onSubmitted }: SupplierImportModalProps) {
  const [form] = Form.useForm<ImportFormValues>();
  const { run, isPending } = useAction();

  /**
   * 关闭即抹掉。明文在页面状态里多留一秒都是没必要的暴露面 ——
   * 而且这一格的内容**永远是"已经交出去了"**，留着只会被误当成"还没导入"。
   */
  const close = (): void => {
    form.resetFields();
    onClose();
  };

  useEffect(() => {
    if (!open) form.resetFields();
  }, [open, form]);

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const text = values.text.trim();
    if (text === '') {
      form.setFields([{ name: 'text', errors: ['至少给一行「手机号,密码」'] }]);
      return;
    }
    const result = await run(
      'import',
      () => supplierAccountsApi.import({ upstreamId, text }),
      '已提交导入任务',
    );
    if (result === null) return;
    // 先抹明文再交棒：顺序反过来的话，onSubmitted 抛错就把明文留在了表单里。
    form.resetFields();
    onSubmitted(result.taskId);
    onClose();
  };

  return (
    <Modal
      open={open}
      title="批量导入账号"
      okText="提交导入"
      cancelText="取消"
      confirmLoading={isPending('import')}
      onOk={() => {
        void submit();
      }}
      onCancel={close}
      destroyOnClose
      width={560}
    >
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: tokens.space.md, background: tokens.tint.warning, border: 'none' }}
        message="这一格是全程唯一出现密码明文的地方"
        description={
          <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
            提交后立即从页面抹掉，服务端<Text strong style={{ fontSize: 12 }}>只进不回</Text>：响应、日志、审计、任务结果、错误信息里都没有它。
            请别把这段文本贴到聊天 / 工单 / 截图里 —— 契约 §15.9 的口径是「用后即弃」。
          </Text>
        }
      />
      <Form<ImportFormValues> form={form} layout="vertical">
        <Form.Item
          name="text"
          label="账号清单"
          rules={[{ required: true, message: '至少给一行' }]}
          extra={
            <span>
              每行一条，格式「手机号,密码」。解析不了的行
              <Text strong style={{ fontSize: 12 }}>
                跳过并逐行报原因
              </Text>
              （记 `skipped`，不记 `failed`）。
            </span>
          }
        >
          <Input.TextArea
            rows={8}
            style={{ fontFamily: tokens.font.mono }}
            placeholder={'16200000000,password1\n16200000001,password2'}
          />
        </Form.Item>
      </Form>
      <Text type="secondary" style={{ fontSize: 12 }}>
        导入是<Text strong style={{ fontSize: 12 }}>异步任务</Text>：27 个账号一轮约 1 分钟（§15.5），
        提交后本页会等到终态才给逐行结论。
        解析失败的行与命中排除名单的行都算「没做过」（`skipped`），与「做了但没成」（`failed`）不是一回事。
      </Text>
    </Modal>
  );
}

// ── 批量建 key 并入池 ─────────────────────────────────────────────────────

interface KeysFormValues {
  count: number;
  namePrefix: string;
  unlimited: boolean;
  /** 以「元」录入，提交前换算成分（契约要求整数分）。 */
  yuan: number | null;
  models: string[];
  label: string;
}

export interface SupplierCreateKeysModalProps {
  open: boolean;
  upstreamId: string;
  /**
   * 打谁：`null` = 该上游**全部账号**（与省略 `ids` 同义）；数组 = 页面上勾中的那些。
   * 只用来**如实说明打谁**，不参与"会有几次请求"的推算。
   */
  ids: string[] | null;
  onClose: () => void;
  onSubmitted: (taskId: string) => void;
}

/**
 * 「新建 key（并入池）」——**这是 §15.2 声明为本节目的的入口**，不是"新建套餐"。
 *
 * 契约 §15.8 第 6/8 问把套餐定死为**不建成 key**（套餐 key 只拿得到掩码、建行等于造一把
 * 不可用凭据），所以账号面上**不存在**"新建套餐"这个动作 —— 套餐是上游事实，我们只能同步它。
 * 本账号面真正能"新建"的东西只有一样：**池内 key**。
 */
export function SupplierCreateKeysModal({
  open,
  upstreamId,
  ids,
  onClose,
  onSubmitted,
}: SupplierCreateKeysModalProps) {
  const [form] = Form.useForm<KeysFormValues>();
  const { run, isPending } = useAction();

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({ count: 1, unlimited: false, models: [] });
  }, [open, form]);

  const unlimited = Form.useWatch('unlimited', form) ?? false;

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const models = (values.models ?? []).map((item) => item.trim()).filter((item) => item !== '');
    const body: SupplierKeysRequest = {
      upstreamId,
      count: values.count,
      ...(ids ? { ids } : {}),
      ...(values.namePrefix ? { namePrefix: values.namePrefix } : {}),
      ...(values.label ? { label: values.label } : {}),
      /**
       * `unlimited=1 ⇒ balance_cents NULL`（§15.7 落库规则）。所以勾了无限额度就**不发金额**
       * —— 发一个 0 出去等于让服务端去分辨"0 是用户输的"还是"这一格本来没意义"。
       */
      ...(unlimited
        ? {}
        : values.yuan === null || values.yuan === undefined
          ? {}
          : { quotaCents: Math.round(values.yuan * 100) }),
      // 空数组与省略同义，两者都归一化为 NULL = 不限模型（§15.2）。
      ...(models.length > 0 ? { models } : {}),
    };

    const result = await run('keys', () => supplierAccountsApi.createKeys(body), '已提交建 key 任务');
    if (result === null) return;
    form.resetFields();
    onSubmitted(result.taskId);
    onClose();
  };

  return (
    <Modal
      open={open}
      title="新建 key 并入池"
      okText="提交建 key"
      cancelText="取消"
      confirmLoading={isPending('keys')}
      onOk={() => {
        void submit();
      }}
      onCancel={onClose}
      destroyOnClose
      width={560}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: tokens.space.md, background: tokens.tint.neutral, border: 'none' }}
        message="上游明文不经浏览器"
        description={
          <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
            服务端自己去上游取 key、当场加密落库，回给页面的只有 `keyId` 与掩码 ——
            所以结论浮层里没有「一次性明文」可看，那是人工从供应商控制台复制的路子才需要的（§15.8 第 3 问）。
          </Text>
        }
      />
      <Form<KeysFormValues> form={form} layout="vertical">
        <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
          <Form.Item
            name="count"
            label="建几把"
            rules={[{ required: true, message: '给出把数' }]}
            style={{ width: 130 }}
            extra={`${KEY_COUNT_MIN}–${KEY_COUNT_MAX}`}
          >
            <InputNumber min={KEY_COUNT_MIN} max={KEY_COUNT_MAX} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="namePrefix" label="名称前缀（可选）" style={{ flex: 1 }}>
            <Input placeholder="如 tf-batch" />
          </Form.Item>
        </Space>

        <Form.Item
          name="unlimited"
          label="无限额度"
          valuePropName="checked"
          extra="置 1 时该 key 的余额落 NULL（§15.7 落库规则）—— 列表里显示为「无限」徽标，绝不渲染成一个金额。"
        >
          <Switch />
        </Form.Item>

        <Form.Item
          name="yuan"
          label="本把额度（元，可选）"
          extra={
            unlimited
              ? '已勾选无限额度，本格不生效；留空即「额度未知」—— 未知 ≠ 0。'
              : (
                <span>
                  提交时换算为「分」整数存库。留空 = 额度未知（
                  <Text strong style={{ fontSize: 12 }}>
                    不是 0
                  </Text>
                  ）。
                </span>
              )
          }
        >
          <InputNumber
            min={0}
            step={1}
            disabled={unlimited}
            style={{ width: '100%' }}
            placeholder="如 100.00"
            addonAfter="元"
          />
        </Form.Item>

        <Form.Item
          name="models"
          label="模型白名单（可选）"
          extra="留空 = 不限模型。契约把「空数组」与「省略」归一化为同一个 NULL，所以这里不区分「没填」与「填了又删空」。"
        >
          <Select
            mode="tags"
            style={{ width: '100%' }}
            placeholder="输入模型名后回车，如 gpt-4o-mini"
            tokenSeparators={[',', ' ']}
          />
        </Form.Item>

        <Form.Item name="label" label="备注（可选）">
          <Input placeholder="如：客服核对批次" />
        </Form.Item>
      </Form>

      <Text type="secondary" style={{ fontSize: 12 }}>
        打谁：{ids ? `已勾选的 ${formatCount(ids.length)} 个账号` : '该上游全部账号'}
        。
        这是一个<Text strong style={{ fontSize: 12 }}>打上游</Text>的动作（每个账号 2 次请求，§15.5），
        提交后本页等到终态给逐行结论 —— 会有几次请求由服务端的 `result` 说了算，这里不预告一个自己算的数（§14.7）。
      </Text>
    </Modal>
  );
}
