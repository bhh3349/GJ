/**
 * 内置 AI 助手 —— 左半聊天、右半「错误日志汇总表」（契约 §13 / §13.6，v1.11.1）。
 *
 * ## 为什么改成左右各半（Bo 2026-10-12 两改之一）
 *
 * 旧版整页只有聊天框：想问「这一小时错在哪几类」，得先切到日志页查、把分型和时间抄下来，
 * 回来再重新描述一遍 —— 助手页成了一个"要自己带素材来"的页面。现在证据面并到右栏：
 * 一行一条错误事件（滚动更新、整行可复制），点一行就把**这一行的条件**交给助手。
 *
 * ## 面板只注入条件，不替你写问题（§13.6 第 3 条，硬规则）
 *
 * 点一行 = 把 `category` / `severity` / `model` / `requestId` / `from` / `to` 写进下一次请求的
 * `logContext`（字段名与取值域一字不改，全部走 `LogContextBar` 那份白名单状态）。
 * **不**把行文本（`message` / 错误码文案 / key 掩码 / 拼出来的"错误摘要句子"）塞进对话 ——
 * 那是自由文本注入，等于绕过白名单，还会把已脱敏但仍不得外传的内容送进 prompt（§13 纪律 3）。
 * 要复制原文，用行末的复制按钮或**直接选中文字**（所以这一列刻意不裁切）。
 *
 * 窄屏（< 1180px）自动堆叠成上下两栏，与站内其它 `panel-grid-*` 同一断点（`global.css` 唯一事实源），
 * 不横向溢出。
 *
 * ## 其余落地抓手（沿用旧版，未改口径）
 *
 * - **独立懒加载路由** —— 经 `lazyPage` 单独分包（`router.tsx`）。本页零图表依赖，
 *   不进 Dashboard 首屏、不加载 ECharts。
 * - **对话只在内存** —— 状态全在 `useAssistantChat` 的 `useState` 里，不落 `sessionStorage`、
 *   不落服务端；顶部明示「对话不保存」。刷新即清空。
 * - **成功不弹 toast，失败内联** —— 终止帧的 `{code, message}` 留在气泡里；这页只在
 *   「清空对话」这类命令式动作上用确认弹窗，问答链路一条 toast 都没有。
 * - **观测上下文结构化** —— 只暴露 `LogContextBar` 的 §12.3 白名单，没有自由文本查询入口。
 *   右栏点一条事件走的是**同一个** `requestId` 白名单字段，不是新开一条口子。
 * - **本轮模型可选** —— 选择器只给「后端接受的那个集合」；不选就请求体不带 `model`（§13.1）。
 *   模型名非法时服务端在开流前回 `400`，错误照旧内联在气泡里，不弹 toast。
 */
import { ClearOutlined, SendOutlined, SettingOutlined } from '@ant-design/icons';
import { App, Button, Input, Space, Tag, Typography } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { EmptyState } from '@/components/states/StateBlock';
import { AssistantModelSelect } from '@/pages/assistant/AssistantModelSelect';
import { AssistantTurnCard } from '@/pages/assistant/AssistantTurnCard';
import { ErrorSummaryPanel } from '@/pages/assistant/ErrorSummaryPanel';
import {
  EMPTY_LOG_CONTEXT,
  LogContextBar,
  toLogContext,
  type LogContextDraft,
} from '@/pages/assistant/LogContextBar';
import { useAssistantChat } from '@/pages/assistant/useAssistantChat';
import type { ObservabilityErrorEvent } from '@/api/types';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

/** 起始问法：只是把问题填进输入框的 UI 文案，不是数据，也不代表服务端有这些口径。 */
const STARTERS = [
  '最近 5 分钟的错误多吗？有没有反复失败的 key？',
  '按 UPSTREAM_ERROR 分型看一下最近 1 小时的错误分布',
  '哪个模型最容易撞 NO_AVAILABLE_KEY？',
];

/** 用户往上翻历史时不抢滚动条：距底部超过这个距离就停掉自动跟随。 */
const STICK_THRESHOLD_PX = 72;

export default function AssistantPage() {
  const { modal } = App.useApp();
  const chat = useAssistantChat();

  const [draft, setDraft] = useState('');
  const [logCtx, setLogCtx] = useState<LogContextDraft>(EMPTY_LOG_CONTEXT);
  const [showContext, setShowContext] = useState(false);
  // 本轮模型（契约 §13.1 / v1.10.0）：只在内存里，刷新即回到「不指定」。
  const [model, setModel] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  // `TextAreaRef` 自带 focus()，不必绕 `resizableTextArea.textArea` 那层实现细节。
  const inputRef = useRef<TextAreaRef>(null);

  const logContext = useMemo(() => toLogContext(logCtx), [logCtx]);
  const inFlight = chat.streaming;
  // 首字慢：只反映在途的那条回合上（15s 计时器由状态机落 `slowFirstByte`）。
  const slowFirstByte =
    chat.turns.some((turn) => turn.id === chat.activeTurnId && turn.slowFirstByte);

  useEffect(() => {
    if (!stickRef.current) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [chat.turns]);

  const submit = useCallback(
    (text: string) => {
      const content = text.trim();
      if (content === '' || inFlight) return;
      stickRef.current = true;
      chat.send(content, logContext, model);
      setDraft('');
    },
    [chat, inFlight, logContext, model],
  );

  const retry = useCallback(() => {
    stickRef.current = true;
    chat.retry(logContext, model);
  }, [chat, logContext, model]);

  const onClear = useCallback(() => {
    modal.confirm({
      title: '清空对话',
      content: '对话只存在当前页面内存里，清空后无法恢复，也不会留下任何记录。',
      okText: '清空',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        chat.clear();
        setDraft('');
      },
    });
  }, [chat, modal]);

  /**
   * 点一行 = 只把该行能表达的**条件**写进 `logContext`（§13.6 第 3 条）。
   * 不碰输入框、不拼句子：问题由人自己写，注入的是过滤条件。
   */
  const injectEvent = useCallback(
    (event: ObservabilityErrorEvent, range: { from: string; to: string }) => {
      setLogCtx({
        // 面板回显的实际窗口优先（前端不自算窗口，§13.6 第 6 条）。
        window: null,
        severity: event.severity,
        categories: [event.category],
        // 未过鉴权的行 `model` 是 `null` → 不注入该字段（注入空串是第二回事）。
        model: event.model ?? '',
        requestId: event.requestId ?? '',
        range: [dayjs(range.from), dayjs(range.to)],
      });
      setShowContext(true);
    },
    [],
  );

  /** 点计数条 = 注入 `category` 多值（计数条是导航控件，本身不是 logContext 字段）。 */
  const pickCategories = useCallback((categories: string[]) => {
    setLogCtx((prev) => ({ ...prev, categories }));
    setShowContext(true);
  }, []);

  const hasTurns = chat.turns.length > 0;

  return (
    <>
      <PageHeader
        title="内置助手"
        extra={
          <Space size={tokens.space.sm}>
            <Button
              size="small"
              icon={<SettingOutlined />}
              type={showContext ? 'primary' : 'default'}
              ghost={showContext}
              onClick={() => setShowContext((prev) => !prev)}
            >
              观测上下文{logContext === null ? '' : ' · 已注入'}
            </Button>
            <Button
              size="small"
              icon={<ClearOutlined />}
              disabled={!hasTurns || inFlight}
              onClick={onClear}
            >
              清空对话
            </Button>
          </Space>
        }
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.space.md,
          height: 'calc(100vh - 176px)',
          minHeight: 460,
        }}
      >
        {showContext ? (
          <LogContextBar value={logCtx} onChange={setLogCtx} disabled={inFlight} />
        ) : null}

        {/* 左右各半：栅格与窄屏堆叠都在 global.css 的 `.panel-grid-half`（断点全站一处）。 */}
        {/* 可用高度掉下限时（观测上下文展开 / 小窗）整块可滚，而不是把表格压成只剩表头。 */}
        <div className="panel-grid-half" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {/* ── 左半：聊天 ─────────────────────────────────────────────── */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.space.sm,
              // 同右栏：父级可滚时给下限，否则聊天框会被压到只剩输入区（"整块可滚"比"压扁"好读）。
              minHeight: 380,
              minWidth: 0,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: tokens.space.sm,
                fontSize: 12,
                color: tokens.color.textTertiary,
              }}
            >
              <Tag
                bordered={false}
                style={{
                  marginInlineEnd: 0,
                  fontSize: 11,
                  background: tokens.tint.neutral,
                  color: tokens.color.textSecondary,
                }}
              >
                对话不保存
              </Tag>
              <AssistantModelSelect value={model} onChange={setModel} disabled={inFlight} />
            </div>

            <div
              style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.lg,
                background: tokens.color.bgContainer,
                overflow: 'hidden',
              }}
            >
              <div
                ref={scrollRef}
                onScroll={() => {
                  const element = scrollRef.current;
                  if (!element) return;
                  stickRef.current =
                    element.scrollHeight - element.scrollTop - element.clientHeight <
                    STICK_THRESHOLD_PX;
                }}
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflowY: 'auto',
                  padding: tokens.space.md,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: tokens.space.md,
                }}
              >
                {hasTurns ? (
                  chat.turns.map((turn) => (
                    <AssistantTurnCard
                      key={turn.id}
                      turn={turn}
                      active={chat.activeTurnId === turn.id}
                      streaming={inFlight}
                      onRetry={retry}
                      onCancel={chat.cancel}
                    />
                  ))
                ) : (
                  <EmptyState
                    minHeight={240}
                    title="还没有对话"
                    action={
                      <Space
                        direction="vertical"
                        size={tokens.space.sm}
                        style={{ marginTop: tokens.space.md }}
                      >
                        {STARTERS.map((text) => (
                          <Button
                            key={text}
                            size="small"
                            type="text"
                            style={{
                              height: 'auto',
                              whiteSpace: 'normal',
                              textAlign: 'left',
                              fontSize: 12,
                              color: tokens.color.textSecondary,
                            }}
                            onClick={() => setDraft(text)}
                          >
                            {text}
                          </Button>
                        ))}
                      </Space>
                    }
                  />
                )}
              </div>

              <div
                style={{
                  borderTop: `1px solid ${tokens.color.border}`,
                  padding: tokens.space.md,
                  background: tokens.color.bgBase,
                }}
              >
                <Input.TextArea
                  value={draft}
                  autoSize={{ minRows: 2, maxRows: 6 }}
                  placeholder="问点什么…（Enter 发送，Shift + Enter 换行）"
                  disabled={inFlight}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.shiftKey) return;
                    // 中文输入法候选框里的 Enter 是「上屏」，不是「发送」。
                    if (event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    submit(draft);
                  }}
                  style={{ fontSize: 13, resize: 'none' }}
                  ref={inputRef}
                />

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: tokens.space.sm,
                    marginTop: tokens.space.sm,
                  }}
                >
                  <Text
                    type="secondary"
                    style={{ fontSize: 11, color: slowFirstByte ? tokens.color.warning : undefined }}
                  >
                    {inFlight
                      ? slowFirstByte
                        ? '仍在等待上游 —— 首字已超过 15s，不判失败；可继续等或取消'
                        : '正在生成 —— 可随时取消，取消即 abort 上游'
                      : `本轮模型：${model ?? '服务端缺省'}${logContext === null ? ' · 不注入日志' : ' · 注入命中的错误事件'}`}
                  </Text>
                  <Space size={tokens.space.sm}>
                    {inFlight ? (
                      <Button size="small" onClick={chat.cancel}>
                        取消
                      </Button>
                    ) : null}
                    <Button
                      type="primary"
                      size="small"
                      icon={<SendOutlined />}
                      loading={inFlight}
                      disabled={draft.trim() === ''}
                      onClick={() => submit(draft)}
                    >
                      发送
                    </Button>
                  </Space>
                </div>
              </div>
            </div>
          </div>

          {/* ── 右半：错误日志汇总表（§13.6） ─────────────────────────── */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: tokens.space.md,
              minHeight: 0,
              minWidth: 0,
              // 面板自带横向滚动（列多），纵向交给这一栏：装不下就滚，不压扁表格。
              overflowY: 'auto',
            }}
          >
            <Panel
              size="sm"
              title="错误日志汇总"
              description="一行一条错误事件，随窗口滚动更新；整行可复制，点一行把条件交给助手。"
              hint="表里的行是错误事件端点的原样响应（默认近 1 小时、按时间倒序），归因那一列不裁切。顶上一排是各分型在计数窗口内的条数，点一下就能按那个分型问助手 —— 它的计数来自健康指标，和表里的行数不是同一个窗口，所以两个窗口分开标。"
              style={{ flex: '1 1 auto', minHeight: 320, overflow: 'auto' }}
            >
              <ErrorSummaryPanel
                onInject={injectEvent}
                onPickCategory={pickCategories}
                busy={inFlight}
              />
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
