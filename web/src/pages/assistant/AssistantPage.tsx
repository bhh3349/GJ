/**
 * 内置 AI 助手聊天框（契约 §13，v1.2.0）。
 *
 * 落地抓手：
 * - **独立懒加载路由** —— 经 `lazyPage` 单独分包（`router.tsx`）。本页零图表依赖，
 *   不进 Dashboard 首屏、不加载 ECharts。
 * - **对话只在内存** —— 状态全在 `useAssistantChat` 的 `useState` 里，不落 `sessionStorage`、
 *   不落服务端；顶部明示「对话不保存」。刷新即清空。
 * - **成功不弹 toast，失败内联** —— 终止帧的 `{code, message}` 留在气泡里；这页只在
 *   「清空对话」这类命令式动作上用确认弹窗，问答链路一条 toast 都没有。
 * - **观测上下文结构化** —— 只暴露 `LogContextBar` 的 §12.3 白名单，没有自由文本查询入口。
 */
import { ClearOutlined, SendOutlined, SettingOutlined } from '@ant-design/icons';
import { App, Button, Input, Space, Tag, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PageHeader } from '@/components/PageHeader';
import { EmptyState } from '@/components/states/StateBlock';
import { AssistantTurnCard } from '@/pages/assistant/AssistantTurnCard';
import {
  EMPTY_LOG_CONTEXT,
  LogContextBar,
  toLogContext,
  type LogContextDraft,
} from '@/pages/assistant/LogContextBar';
import { useAssistantChat } from '@/pages/assistant/useAssistantChat';
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

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

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
      chat.send(content, logContext);
      setDraft('');
    },
    [chat, inFlight, logContext],
  );

  const retry = useCallback(() => {
    stickRef.current = true;
    chat.retry(logContext);
  }, [chat, logContext]);

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

  const hasTurns = chat.turns.length > 0;

  return (
    <>
      <PageHeader
        title="内置助手"
        description="读观测面数据定位故障 —— 会话鉴权、只读取数、问答不落库"
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
          <Text type="secondary" style={{ fontSize: 12 }}>
            只在当前页面内存里，刷新或关闭即消失；服务端无状态、不落库（契约 §13）。
          </Text>
        </div>

        {showContext ? (
          <LogContextBar value={logCtx} onChange={setLogCtx} disabled={inFlight} />
        ) : null}

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
                element.scrollHeight - element.scrollTop - element.clientHeight < STICK_THRESHOLD_PX;
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
                description="问观测面的问题，例如错误分型、异常 key、上游可用性。留空「观测上下文」即为纯闲聊，不注入任何日志。"
                action={
                  <Space direction="vertical" size={tokens.space.sm} style={{ marginTop: tokens.space.md }}>
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
                  : logContext === null
                    ? '当前不注入日志（纯闲聊）'
                    : '本轮会把命中的错误事件作为「数据」注入'}
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
    </>
  );
}
