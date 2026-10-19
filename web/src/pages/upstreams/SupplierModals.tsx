/**
 * 账号池的三个**入口弹窗**：导入账号（§15.2 `import`）、粘贴 Cookie
 * （v1.16.4 `import-sessions`，仅 TokenRhythm）与批量建 key 并入池（§15.2 `keys`）。
 *
 * 两条纪律各自只有一个实现处，所以放在同一个文件里对照着看：
 *
 * 1. **凭据明文只进不回**（§15.8 第 2 问 / §15.9）。导入框里的「账号,密码」，以及
 *    TokenRhythm 的「每行一枚 Cookie」，是**仅有的**允许出现明文的界面元素：提交后
 *    **立刻从表单里抹掉**（`resetFields`），不留回显、不写本地存储、不进 URL。响应、日志、
 *    审计 detail、任务 result、错误 message 里都没有它们 —— 所以这里也**不提供**
 *    "查看已导入的密码 / Cookie"这种入口（没有那样的读面，做出来就是把明文留在浏览器里）。
 *    粘贴 Cookie 走 HTTP 是 v1.16.4 的显式取舍（自用项目），不在前端另做持久化。
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
import {
  asSupplierKind,
  supplierCapabilities,
  supplierLabel,
  type SupplierKeysRequest,
} from '@/api/types';
import { tokens } from '@/theme/tokens';

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
  /**
   * 该上游的 `supplier`。**决定这个弹窗收什么**（v1.16.4）：
   * - `sessionImport`（TokenRhythm）→ 每行一枚 Cookie；
   * - `passwordLogin`（TierFlow）→ 每行「账号,密码」。
   * 解析器密码侧两种写法都收（`supplier/import-text.ts` 的表头词表里 `手机号` 与 `账号` 都在）。
   */
  supplier: string | null;
}

export function SupplierImportModal({
  open,
  upstreamId,
  onClose,
  onSubmitted,
  supplier,
}: SupplierImportModalProps) {
  const [form] = Form.useForm<ImportFormValues>();
  const { run, isPending } = useAction();

  /** v1.16.4：这家是"直接收会话"还是"账号密码登录"，由能力位决定，不由弹窗猜。 */
  const sessionImport = supplierCapabilities(supplier)?.sessionImport === true;
  /** 提示词里的第一列叫法。只有 TierFlow 是手机号；其余（含未知值）都按"账号"说。 */
  const accountWord = asSupplierKind(supplier) === 'tierflow' ? '手机号' : '账号';
  /** 示例行同样不能造一个假号码给 TokenRhythm 看 —— 那里账号不是手机号，写成号码是误导。 */
  const accountExample = asSupplierKind(supplier) === 'tierflow' ? '16xxxxxxxxxxx' : 'your-account';

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
      form.setFields([
        {
          name: 'text',
          errors: [sessionImport ? '至少粘贴一枚 Cookie' : `至少给一行「${accountWord},密码」`],
        },
      ]);
      return;
    }
    const result = await run(
      'import',
      () =>
        sessionImport
          ? supplierAccountsApi.importSessions({ upstreamId, text })
          : supplierAccountsApi.import({ upstreamId, text }),
      sessionImport ? '已提交 Cookie 导入任务' : '已提交导入任务',
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
      title={sessionImport ? '批量导入 Cookie' : '批量导入账号'}
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
      <Form<ImportFormValues> form={form} layout="vertical">
        <Form.Item
          name="text"
          label={sessionImport ? 'Cookie 清单（每行一枚）' : '账号清单'}
          rules={[{ required: true, message: sessionImport ? '至少粘贴一枚 Cookie' : '至少给一行' }]}
        >
          <Input.TextArea
            rows={8}
            style={{ fontFamily: tokens.font.mono }}
            placeholder={
              sessionImport
                ? 'tr_session=xxxxx; Path=/\ntr_session=yyyyy; Path=/'
                : `${accountWord},密码\n${accountExample},password`
            }
          />
        </Form.Item>
      </Form>
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
  /**
   * 该上游的 `supplier`（父组件手里已有）。决定这一格表单**长什么样**：
   * 有额度概念的供应商（TierFlow）给 unlimited/额度/白名单三项；没有的（TokenRhythm）
   * 三项都不显示，且 `unlimited` 恒为 `true` —— 这不是"默认开着"，是**唯一合法取值**
   * （§15.14 的入口闸：`unlimited !== true` 或带 `models` 的请求当场 422）。
   */
  supplier: string | null;
  onClose: () => void;
  onSubmitted: (taskId: string) => void;
}

/**
 * 「新建 key（并入池）」——**这是 §15.2 声明为本节目的的入口**，不是"新建套餐"。
 *
 * 契约 §15.8 第 6/8 问把套餐定死为**不建成 key**（套餐 key 只拿得到掩码、建行等于造一把
 * 不可用凭据），所以账号面上**不存在**"新建套餐"这个动作 —— 套餐是上游事实，我们只能同步它。
 * 本账号面真正能"新建"的东西只有一样：**池内 key**。
 *
 * ## 能力位怎么落到表单上（§15.14）
 *
 * `keyQuota === false` 的供应商（TokenRhythm）：
 * - 不画「无限额度 / 本把额度 / 模型白名单」三项 —— 画出来只要用户碰一下就 422；
 * - 但**提交时仍显式发 `unlimited: true`**，并且表单初值也写 `true`：
 *   服务端的闸是 `unlimited !== true → 422`，而"不画开关"与"发 true"是两件事，
 *   少了后者这一格就成了**点默认路径必失败**的入口。
 */
export function SupplierCreateKeysModal({
  open,
  upstreamId,
  ids,
  supplier,
  onClose,
  onSubmitted,
}: SupplierCreateKeysModalProps) {
  const [form] = Form.useForm<KeysFormValues>();
  const { run, isPending } = useAction();

  /** 有额度概念才画额度/白名单三项；`null`（通用上游）也当作没有 —— 少画不会造假承诺。 */
  const quotaCapable = supplierCapabilities(supplier)?.keyQuota === true;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue({ count: 1, unlimited: quotaCapable, models: [] });
  }, [open, form, quotaCapable]);

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
      // 没有额度概念的供应商：`unlimited: true` 是唯一合法取值，**显式发**（见组件头注释）。
      // 它同样意味着落库 `balance_cents NULL` —— 与用户在 TierFlow 上勾「无限额度」是同一条落库路径。
      ...(quotaCapable ? {} : { unlimited: true }),
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
      title="新建 key"
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
      <Form<KeysFormValues> form={form} layout="vertical">
        <Space size={tokens.space.md} style={{ display: 'flex' }} align="start">
          <Form.Item
            name="count"
            label="建几把"
            rules={[{ required: true, message: '给出把数' }]}
            style={{ width: 130 }}
          >
            <InputNumber min={KEY_COUNT_MIN} max={KEY_COUNT_MAX} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="namePrefix" label="名称前缀（可选）" style={{ flex: 1 }}>
            <Input placeholder={`如 ${supplierLabel(supplier)}-batch`} />
          </Form.Item>
        </Space>

        {/*
          额度三项只对有额度概念的供应商画。TokenRhythm 的 key 上游侧就不带额度，
          「无限额度」在那里不是开关而是事实 —— 开关画出来，拨到哪边都改变不了任何东西，
          还会让"看起来能设额度"变成一个假承诺。提交侧恒发 unlimited:true（组件头注释）。
        */}
        {quotaCapable ? (
          <>
            <Form.Item name="unlimited" label="无限额度" valuePropName="checked">
              <Switch />
            </Form.Item>

            <Form.Item name="yuan" label="本把额度（元，可选）">
              <InputNumber
                min={0}
                step={1}
                disabled={unlimited}
                style={{ width: '100%' }}
                placeholder="如 100.00"
                addonAfter="元"
              />
            </Form.Item>

            <Form.Item name="models" label="模型白名单（可选）">
              <Select
                mode="tags"
                style={{ width: '100%' }}
                placeholder="输入模型名后回车，如 gpt-4o-mini"
                tokenSeparators={[',', ' ']}
              />
            </Form.Item>
          </>
        ) : (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: tokens.space.md, background: tokens.tint.info, border: 'none' }}
            message={`${supplierLabel(supplier)} 的 key 没有额度与模型白名单`}
            description={
              <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                这家上游建 key 只收名称；额度与白名单由上游侧决定，网关不代填。建出的 key 在池内按「无限额度」记账。
              </Text>
            }
          />
        )}

        <Form.Item name="label" label="备注（可选）">
          <Input placeholder="如：客服核对批次" />
        </Form.Item>

        {/*
          这一句是**刻意的**：用户组那条路径会在浏览器里显示一次明文，账号池这条不会。
          不写就会有人等一个永远不出现的"一次性明文"浮层，然后以为建 key 失败了。
        */}
        <Text type="secondary" style={{ fontSize: 12 }}>
          建好的 key 明文不经浏览器：服务端取回后当场加密入池，回执浮层里只给掩码。要明文请到上游站点取。
        </Text>
      </Form>
    </Modal>
  );
}
