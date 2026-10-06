/**
 * 单条对话回合的渲染 —— 契约 §13.2 三帧（`delta` / `done` / `error`）在 UI 上的投影。
 *
 * 三条纪律落在这里：
 * - **错误内联、不弹 toast** —— 终止帧的 `{code, message}` 就留在气泡里；成功也**不**弹 toast。
 *   这页只有「清空对话」这类命令式动作才允许用 `message`。
 * - **断流保留已收文本** —— `interrupted` / `aborted` 都不清空 `content`，只把可重试的告警挂在下面。
 * - **citations 只展示、不跳转** —— MVP 范围（§13.2）。`model` + `summary` 是契约给出的
 *   最小可读标签；两者都是 §12.1 已脱敏字段的投影，key 明文零出现。
 */
import { CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, Spin, Tag, Tooltip, Typography } from 'antd';

import type { AssistantCitation } from '@/api/types';
import type { AssistantTurn } from '@/pages/assistant/useAssistantChat';
import { tokens } from '@/theme/tokens';
import { formatIso } from '@/utils/format';

const { Text } = Typography;

/** `error` 帧的两类 429 才带退避秒数（§13.2）；其它码值 `retryAfterSec = null`。 */
function retryHint(error: { retryAfterSec: number | null }): string | null {
  return error.retryAfterSec === null ? null : `上游建议 ${error.retryAfterSec} 秒后重试`;
}

/** 引用行背景色：`warn` / `error` 沿用 §12.1 分型语义，不复用状态码颜色。 */
function severityTone(severity: AssistantCitation['severity']) {
  return severity === 'warn'
    ? { color: tokens.color.warning, bg: tokens.tint.warning }
    : { color: tokens.color.error, bg: tokens.tint.error };
}

function CitationList({ citations }: { citations: readonly AssistantCitation[] }) {
  if (citations.length === 0) return null;

  return (
    <div
      style={{
        marginTop: tokens.space.md,
        borderTop: `1px dashed ${tokens.color.border}`,
        paddingTop: tokens.space.sm,
      }}
    >
      <Text type="secondary" style={{ fontSize: 11, letterSpacing: '0.04em' }}>
        数据引用 · {citations.length} 条（仅展示，不跳转）
      </Text>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.space.xs,
          marginTop: tokens.space.xs,
        }}
      >
        {citations.map((item) => {
          const tone = severityTone(item.severity);
          return (
            <div
              key={item.id}
              style={{
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                background: tokens.color.bgBase,
                padding: `${tokens.space.xs}px ${tokens.space.sm}px`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: tokens.space.xs + 2,
                }}
              >
                <Tag
                  bordered={false}
                  style={{
                    marginInlineEnd: 0,
                    fontSize: 10,
                    lineHeight: '16px',
                    background: tone.bg,
                    color: tone.color,
                  }}
                >
                  {item.severity}
                </Tag>
                <Text
                  style={{
                    fontFamily: tokens.font.mono,
                    fontSize: 11,
                    color: tokens.color.textSecondary,
                  }}
                >
                  #{item.id}
                </Text>
                <Text type="secondary" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                  {formatIso(item.ts)}
                </Text>
                {item.model === null ? (
                  <Tooltip title="未过鉴权的请求没有 clientModel（§12.1 产出边界），不是缺数据">
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      模型未知
                    </Text>
                  </Tooltip>
                ) : (
                  <Text style={{ fontFamily: tokens.font.mono, fontSize: 11 }}>{item.model}</Text>
                )}
                {item.gatewayCode === null ? null : (
                  <Text style={{ fontFamily: tokens.font.mono, fontSize: 11, color: tone.color }}>
                    {item.gatewayCode}
                  </Text>
                )}
              </div>
              <div
                style={{
                  marginTop: 2,
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: tokens.color.textSecondary,
                  wordBreak: 'break-word',
                }}
              >
                {item.summary}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface AssistantTurnCardProps {
  turn: AssistantTurn;
  /** 本条就是当前在途的那条 —— 决定取消按钮落在谁身上。 */
  active: boolean;
  /** 全局在途（单流）：在途时禁用重试，避免并发第二条流。 */
  streaming: boolean;
  onRetry: () => void;
  onCancel: () => void;
}

export function AssistantTurnCard({
  turn,
  active,
  streaming,
  onRetry,
  onCancel,
}: AssistantTurnCardProps) {
  // ── 用户回合：没有流式生命周期，恒 done ──
  if (turn.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <div
          style={{
            maxWidth: '78%',
            background: tokens.tint.info,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.md,
            padding: `${tokens.space.sm}px ${tokens.space.md}px`,
            fontSize: 13,
            lineHeight: 1.7,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {turn.content}
        </div>
      </div>
    );
  }

  const waiting = turn.phase === 'pending';
  const error = turn.error;

  const retryButton = (
    <Button
      size="small"
      icon={<ReloadOutlined />}
      disabled={streaming}
      onClick={onRetry}
    >
      重试
    </Button>
  );

  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div
        style={{
          maxWidth: '86%',
          minWidth: 260,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          background: tokens.color.bgContainer,
          padding: tokens.space.md,
        }}
      >
        {turn.content === '' ? null : (
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.75,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: tokens.color.textPrimary,
            }}
          >
            {turn.content}
            {turn.phase === 'streaming' ? (
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 6,
                  height: 14,
                  marginLeft: 3,
                  verticalAlign: '-2px',
                  background: tokens.color.primary,
                  // 关键帧在 global.css；prefers-reduced-motion 下会停在 100%（实心光标），不会闪。
                  animation: 'assistant-caret 1s steps(1, end) infinite',
                }}
              />
            ) : null}
          </div>
        )}

        {/* 首字未到：15s 前「正在思考」，之后转「仍在等待上游」——**不判失败**（PM 口径 / §13 头注）。 */}
        {waiting ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: tokens.space.sm,
            }}
          >
            <Spin size="small" />
            <Text type="secondary" style={{ fontSize: 12 }}>
              {turn.slowFirstByte ? '仍在等待上游…' : '正在思考…'}
            </Text>
            {turn.slowFirstByte ? (
              <Text type="secondary" style={{ fontSize: 11 }}>
                首字已超过 15s，不判失败；可继续等或取消
              </Text>
            ) : null}
            {active ? (
              <Button size="small" icon={<CloseOutlined />} onClick={onCancel}>
                取消
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* 增量中：让用户随时能掐掉（abort → 上游 499，不烧完 token）。 */}
        {turn.phase === 'streaming' && active ? (
          <div style={{ marginTop: tokens.space.sm, display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
            <Button size="small" icon={<CloseOutlined />} onClick={onCancel}>
              取消
            </Button>
            <Text type="secondary" style={{ fontSize: 11 }}>
              取消会 abort 上游，已收到的文本保留
            </Text>
          </div>
        ) : null}

        {/* 失败终止帧：复用 §10 码值，`status` 是该码值的 HTTP 状态，不是本次响应状态。 */}
        {turn.phase === 'error' && error ? (
          <Alert
            style={{ marginTop: tokens.space.sm }}
            type="error"
            showIcon
            message={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.space.sm, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13 }}>{error.message}</span>
                <Tag
                  bordered={false}
                  style={{
                    marginInlineEnd: 0,
                    fontFamily: tokens.font.mono,
                    fontSize: 10,
                    background: tokens.tint.error,
                    color: tokens.color.error,
                  }}
                >
                  {error.code}
                </Tag>
              </span>
            }
            description={
              <div style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                <div>
                  {error.status > 0
                    ? `契约 §10 中该码值对应 HTTP ${error.status}`
                    : '客户端侧诊断码，未走 §10 码表（流未开或解析失败）'}
                </div>
                {retryHint(error) === null ? null : <div>{retryHint(error)}</div>}
              </div>
            }
            action={retryButton}
          />
        ) : null}

        {/* 断流：服务端没发终止帧就断开 —— 不是「答完了」，是「话说一半」。 */}
        {turn.phase === 'interrupted' ? (
          <Alert
            style={{ marginTop: tokens.space.sm }}
            type="warning"
            showIcon
            message="响应中断 · 可重试"
            description={
              <span style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                在收到终止帧前连接断开。已收到的文本保留在上方，重试会重新发这一轮问题。
              </span>
            }
            action={retryButton}
          />
        ) : null}

        {turn.phase === 'aborted' ? (
          <Alert
            style={{ marginTop: tokens.space.sm }}
            type="warning"
            showIcon
            message="已取消"
            description={
              <span style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                已 abort 上游（§13.4：不 abort 就是白烧 token + 占住并发槽位）。
              </span>
            }
            action={retryButton}
          />
        ) : null}

        {/* 三重上限命中：绝不静默截。 */}
        {turn.truncated ? (
          <Alert
            style={{ marginTop: tokens.space.sm }}
            type="info"
            showIcon
            message="上下文已被截断"
            description={
              <span style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                本轮命中三重上限之一（messages 24 条 / 单条 8000 token / 总 16000 token / 注入 50 条 ×
                ≤24h），服务端裁剪后作答 —— 回答不覆盖被裁掉的部分。
              </span>
            }
          />
        ) : null}

        {turn.seqGap ? (
          <div style={{ marginTop: tokens.space.sm }}>
            <Tooltip title="SSE 帧的 seq 应逐帧加一；跳变说明中间有帧丢失，回答可能缺了一截">
              <Tag
                bordered={false}
                style={{
                  marginInlineEnd: 0,
                  fontSize: 11,
                  background: tokens.tint.warning,
                  color: tokens.color.warning,
                }}
              >
                帧序跳变 · 可能丢帧
              </Tag>
            </Tooltip>
          </div>
        ) : null}

        {turn.phase === 'done' ? <CitationList citations={turn.citations} /> : null}
      </div>
    </div>
  );
}
