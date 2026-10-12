/**
 * 助手页「错误日志汇总表」面板（契约 §13.6，v1.11.1 / ADR-0025；Bo 原话：
 * 「不是价格错误汇总。是日志的错误日志汇总表，这样方便和助手对话复制」）。
 *
 * ## 这一张表存在的唯一理由：**可复制 + 可一键把条件交给助手**
 *
 * 日志页也能查错误，但它是分页查询表：看完要在脑子里记住分型、时间、请求号，再切到助手
 * 重新描述一遍。这张面板把那段人肉搬运去掉 —— 一行就在眼前，点一下把**这一行的条件**
 * 交给助手，选中文字就能复制。
 *
 * ## 三条口径（§13.6 逐条落地；写成硬规则是因为每一条都有"顺手就错了"的做法）
 *
 * 1. **面板行 = §12.3 原样响应**（`GET /api/observability/errors`，`from`/`to` **全省略**
 *    = 用该端点既有的默认窗口，默认排序 `ts DESC, id DESC`）。**行内容不加工**：不拼字段造
 *    「新对象」，也**不截 `message` 省地方** —— 截到 120 字符这个动作只有 `citations` 有权做
 *    （§13.2）。所以归因那一列整段换行显示，宁可撑高也不藏一个字。
 * 2. **顶部 9 分型计数条 = §12.2 `events.byCategory`**，**不用**面板那份分页响应现算计数：
 *    分页只覆盖第 1 页、计数是全窗口，「第 1 页 20 条里某类 7 条」不等于「这一小时只有 7 条」。
 * 3. **点行注入只走 §13.1 白名单字段**（`category` / `severity` / `model` / `requestId` /
 *    `from` / `to`），**绝不把行文本拼成一句话塞进对话** —— 那是自由文本注入，等于绕过白名单，
 *    还会把「脱敏之后仍不得外传」的内容送进 prompt（§13 纪律 3）。`model` 为 `null`
 *    （未过鉴权的行）时**不注入该字段**，注入空串是第二回事。
 *
 * ## 两个窗口分开标（§13.6 第 6 条）
 *
 * 面板按 §12.3 回显的 `range` 取数（**前端不自算**），计数条按 `window` 取数，契约允许两者
 * 不同窗口、也**不加字段把它们绑成一个** —— 所以这一格必须把两个窗口都显式说出来，
 * 不能让用户以为「表里 12 条」和「计数条 7 条」是同一件事。
 *
 * ## 实时滚动：为什么是轮询
 *
 * §7 的实时帧里没有错误事件帧（§12.1 的事件只落库、不发射），所以「实时」只能靠轮询 §12.3。
 * 5s 一档；以事件 `id` 去重。**暂停时照常取数、只是不改屏**，恢复时直接落到最新那一页 ——
 * 若把新行攒在本地缓冲再合并，恢复的瞬间会出现"缓冲已清、服务端那页还没换"的空窗。
 */
import { CopyOutlined, PauseOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { App, Button, Segmented, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { observabilityApi } from '@/api/endpoints';
import {
  OBSERVABILITY_CATEGORIES,
  PAGE_SIZE_MAX,
  type ObservabilityErrorEvent,
  type ObservabilityEvents,
  type ObservabilityWindow,
} from '@/api/types';
import { EmptyState, ErrorState } from '@/components/states/StateBlock';
import { categoryHint, categoryLabel, severityTone } from '@/utils/observabilityLabels';
import { tokens } from '@/theme/tokens';
import { formatIso } from '@/utils/format';

const { Text } = Typography;

/** 轮询间隔：§12.3 是只读端点，5s 一档不给管理面添压。 */
const POLL_MS = 5_000;

/** 计数条窗口（§12.2 的三档；观测面**没有** `15m`）。 */
const COUNT_WINDOWS: readonly ObservabilityWindow[] = ['60s', '5m', '1h'];

/**
 * 每列声明宽度 + `tableLayout: fixed`（长文本靠换行，而不是把别的列挤成面条）。
 *
 * 列的取舍按「这一行要不要拿去问助手」定，不按 DTO 有什么就摆什么：级别用状态色表达
 * （`warn` 黄 / `error` 红），尝试数折进状态格（0 次 = 「未出网」），端点与延迟**不进表**
 * 但**进复制文本** —— 它们对"这条是什么错"不是决定性的，对事后排查有用。
 */
const COLUMN_WIDTHS = {
  ts: 148,
  category: 104,
  status: 96,
  code: 132,
  model: 112,
  key: 76,
  message: 260,
  copy: 48,
} as const;

const COLUMN_WIDTH_SUM = Object.values(COLUMN_WIDTHS).reduce((sum, value) => sum + value, 0);

/** `message` 那一列刻意不裁切（§13.6 第 1 条：不得截它来省地方）。 */
const wrapCell: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.6,
  wordBreak: 'break-word',
  whiteSpace: 'pre-wrap',
  color: tokens.color.textSecondary,
};

/**
 * 一行复制成什么：**字段名 + 原值**，粘到任何地方都还读得出是哪一条。
 * 这里带上表格里没摆的 `endpoint` / `attempts` / `latencyMs` / `requestId`（契约字段原值），
 * 因为复制的用途正是"拿去别处继续查"。
 */
function rowToText(event: ObservabilityErrorEvent, range: { from: string; to: string }): string {
  return [
    `ts=${event.ts}`,
    `severity=${event.severity}`,
    `category=${event.category}`,
    `status=${event.status}`,
    `gatewayCode=${event.gatewayCode ?? ''}`,
    `model=${event.model ?? ''}`,
    `upstreamId=${event.upstreamId ?? ''}`,
    `keyMasked=${event.keyMasked ?? ''}`,
    `endpoint=${event.endpoint}`,
    `stream=${event.stream}`,
    `upstreamStatus=${event.upstreamStatus ?? ''}`,
    `attempts=${event.attempts}`,
    `latencyMs=${event.latencyMs ?? ''}`,
    `requestId=${event.requestId ?? ''}`,
    `window=${range.from}~${range.to}`,
    `message=${event.message ?? ''}`,
  ].join('\n');
}

export interface ErrorSummaryPanelProps {
  /** 点一行 = 把该行能表达的条件写进下一次请求的 `logContext`（只走白名单字段）。 */
  onInject: (event: ObservabilityErrorEvent, range: { from: string; to: string }) => void;
  /** 点计数条 = 注入 `category` 多值（计数条是导航控件，本身不是 `logContext` 字段）。 */
  onPickCategory: (categories: string[]) => void;
  /** 助手正在流式作答时不改屏：那时人的注意力在回答上。 */
  busy?: boolean;
}

export function ErrorSummaryPanel({
  onInject,
  onPickCategory,
  busy = false,
}: ErrorSummaryPanelProps) {
  const { message: toast } = App.useApp();

  const [rows, setRows] = useState<ObservabilityErrorEvent[] | null>(null);
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [manualPause, setManualPause] = useState(false);
  const [countWindow, setCountWindow] = useState<ObservabilityWindow>('1h');
  const [counts, setCounts] = useState<ObservabilityEvents | null>(null);
  const [countsFailed, setCountsFailed] = useState(false);
  /** 本批新到达的 id（只有这些行放滑入动画；首轮不放）。 */
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  /** 暂停期间取到但没上屏的页数（用来告诉用户"下面这些不是最新的"）。 */
  const [pendingCount, setPendingCount] = useState(0);

  const seenRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);
  const latestRef = useRef<{ items: ObservabilityErrorEvent[]; total: number } | null>(null);

  const paused = hovered || manualPause || busy;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  /** 把一页结果落到屏幕上，并算出哪些是新行。 */
  const apply = useCallback((items: readonly ObservabilityErrorEvent[], animate: boolean) => {
    const fresh = items.filter((event) => !seenRef.current.has(event.id));
    for (const event of items) seenRef.current.add(event.id);
    setRows([...items]);
    setFreshIds(animate ? new Set(fresh.map((event) => event.id)) : new Set());
    setPendingCount(0);
  }, []);

  // ── 面板取数（§12.3：from/to 全省略 = 端点既有默认窗口；窗口以回显 range 为准） ──
  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const page = await observabilityApi.errors({ page: 1, pageSize: PAGE_SIZE_MAX });
        if (!active) return;
        setFailed(false);
        setRange(page.range);
        setTotal(page.total);
        latestRef.current = { items: page.items, total: page.total };
        if (pausedRef.current && primedRef.current) {
          const known = seenRef.current;
          setPendingCount(page.items.filter((event) => !known.has(event.id)).length);
          return;
        }
        apply(page.items, primedRef.current);
        primedRef.current = true;
      } catch {
        // 这一格失败只影响这一格：不打整页、不弹 toast（与仪表盘快照区同一条纪律）。
        if (active) setFailed(true);
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      // 后台标签页不拉数据：省得开着页面挂一整夜在打观测接口。
      if (document.visibilityState !== 'visible') return;
      void poll();
    }, POLL_MS);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [apply]);

  // 解除暂停：直接把最新那一页落屏（不维护本地缓冲，避免恢复瞬间出现空窗）。
  useEffect(() => {
    if (paused) return;
    const latest = latestRef.current;
    if (latest === null) return;
    const unseen = latest.items.filter((event) => !seenRef.current.has(event.id)).length;
    if (unseen > 0 || pendingCount > 0) apply(latest.items, primedRef.current);
  }, [paused, apply, pendingCount]);

  // ── 计数条取数（§12.2 events.byCategory，与仪表盘同源） ──
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const health = await observabilityApi.health(countWindow);
        if (!active) return;
        setCounts(health.events);
        setCountsFailed(false);
      } catch {
        if (active) setCountsFailed(true);
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void load();
    }, POLL_MS * 2);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [countWindow]);

  const countOf = useCallback(
    (category: string) =>
      counts?.byCategory.find((item) => item.category === category)?.count ?? 0,
    [counts],
  );

  const columns = useMemo<ColumnsType<ObservabilityErrorEvent>>(
    () => [
      {
        title: '时间',
        dataIndex: 'ts',
        width: COLUMN_WIDTHS.ts,
        render: (value: string) => (
          <Text style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {formatIso(value)}
          </Text>
        ),
      },
      {
        title: '分型',
        dataIndex: 'category',
        width: COLUMN_WIDTHS.category,
        render: (value: string) => (
          <Tooltip title={categoryHint(value)}>
            <Text style={{ fontSize: 12 }}>{categoryLabel(value)}</Text>
          </Tooltip>
        ),
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: COLUMN_WIDTHS.status,
        render: (value: number, row) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Text style={{ fontFamily: tokens.font.mono, fontSize: 12, color: severityTone(row.severity).color }}>
              {value}
            </Text>
            {row.attempts === 0 ? (
              <Tooltip title="0 次真实上游尝试：请求没发出去，不计任何 key 健康">
                <Tag
                  bordered={false}
                  style={{
                    marginInlineEnd: 0,
                    fontSize: 10,
                    lineHeight: '16px',
                    background: tokens.tint.warning,
                    color: tokens.color.warning,
                  }}
                >
                  未出网
                </Tag>
              </Tooltip>
            ) : null}
          </span>
        ),
      },
      {
        title: '错误码',
        dataIndex: 'gatewayCode',
        width: COLUMN_WIDTHS.code,
        render: (value: string | null) =>
          value === null ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              —
            </Text>
          ) : (
            <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value}</Text>
          ),
      },
      {
        title: '模型',
        dataIndex: 'model',
        width: COLUMN_WIDTHS.model,
        render: (value: string | null) =>
          value === null ? (
            <Tooltip title="未过鉴权的请求没有模型，不是缺数据">
              <Text type="secondary" style={{ fontSize: 12 }}>
                无
              </Text>
            </Tooltip>
          ) : (
            <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value}</Text>
          ),
      },
      {
        title: 'Key',
        dataIndex: 'keyMasked',
        width: COLUMN_WIDTHS.key,
        render: (value: string | null) => (
          <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{value ?? '—'}</Text>
        ),
      },
      {
        title: '归因（原文，不截断）',
        dataIndex: 'message',
        width: COLUMN_WIDTHS.message,
        render: (value: string | null) =>
          value === null ? (
            <Text type="secondary" style={wrapCell}>
              —
            </Text>
          ) : (
            <span style={{ ...wrapCell, userSelect: 'text' }}>{value}</span>
          ),
      },
      {
        title: '',
        dataIndex: 'copy',
        width: COLUMN_WIDTHS.copy,
        fixed: 'right',
        render: (_: unknown, row) => (
          <Tooltip title="复制这一行（含完整归因、请求号与窗口）">
            <Button
              size="small"
              type="text"
              icon={<CopyOutlined />}
              onClick={(event) => {
                // 复制与"点行注入"是两件事：复制不该顺手改上下文，所以这里阻止冒泡。
                event.stopPropagation();
                void navigator.clipboard
                  .writeText(rowToText(row, range ?? { from: row.ts, to: row.ts }))
                  .then(
                    () => toast.success('已复制这一行'),
                    () => toast.error('浏览器拒绝了剪贴板写入，可直接选中文字复制'),
                  );
              }}
            />
          </Tooltip>
        ),
      },
    ],
    [range, toast],
  );

  if (rows === null) {
    if (failed) {
      return (
        <ErrorState
          minHeight={200}
          error={new Error('错误事件取数失败')}
          title="错误日志取数失败"
          onRetry={() => {
            setFailed(false);
            void observabilityApi
              .errors({ page: 1, pageSize: PAGE_SIZE_MAX })
              .then(
                (page) => {
                  setRange(page.range);
                  latestRef.current = { items: page.items, total: page.total };
                  apply(page.items, false);
                },
                () => setFailed(true),
              );
          }}
        />
      );
    }
    return (
      <div style={{ padding: tokens.space.lg, textAlign: 'center' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          正在取错误事件…
        </Text>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm, minWidth: 0 }}
    >
      {/* ── 9 分型计数条（§12.2 events.byCategory；点一下注入 category 多值） ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: tokens.space.xs + 2,
        }}
      >
        {OBSERVABILITY_CATEGORIES.map((category) => {
          const count = countOf(category);
          return (
            <Tooltip
              key={category}
              title={
                countsFailed
                  ? '计数窗口取数失败 —— 这一排暂时不可点，下面的表不受影响'
                  : count === 0
                    ? `${category} · 该窗口内没发生过`
                    : `${categoryLabel(category)} · ${categoryHint(category) ?? ''} 点一下：按这个分型问助手`
              }
            >
              <button
                type="button"
                disabled={count === 0}
                onClick={() => onPickCategory([category])}
                style={{
                  cursor: count === 0 ? 'default' : 'pointer',
                  border: `1px solid ${count === 0 ? tokens.color.border : tokens.color.borderStrong}`,
                  borderRadius: tokens.radius.sm,
                  background: count === 0 ? 'transparent' : tokens.tint.neutral,
                  color: count === 0 ? tokens.color.textTertiary : tokens.color.textPrimary,
                  padding: `2px ${tokens.space.sm}px`,
                  font: 'inherit',
                  fontSize: 11,
                  lineHeight: '18px',
                  opacity: count === 0 ? 0.62 : 1,
                }}
              >
                {categoryLabel(category)}
                <span style={{ marginLeft: 4, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
              </button>
            </Tooltip>
          );
        })}
        <Segmented
          size="small"
          value={countWindow}
          options={COUNT_WINDOWS.map((item) => ({ label: item, value: item }))}
          onChange={(value) => setCountWindow(value as ObservabilityWindow)}
        />
      </div>

      {/* ── 两个窗口分开说（§13.6 第 6 条：允许不同窗口，一致性归渲染） ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.space.sm,
          flexWrap: 'wrap',
          fontSize: 11,
          color: tokens.color.textTertiary,
        }}
      >
        <span>
          {`表内窗口 ${range ? `${formatIso(range.from)} → ${formatIso(range.to)}` : '等待回显'} · 共 ${total ?? 0} 条`}
          {` · 计数窗口 ${counts ? `${counts.total} 条 / ${countWindow}` : countWindow}`}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
          {failed ? <span style={{ color: tokens.color.warning }}>刷新失败，下面是上一次的结果</span> : null}
          {paused && pendingCount > 0 ? (
            <span style={{ color: tokens.color.warning }}>{`${pendingCount} 条新事件待入`}</span>
          ) : null}
          <Button
            size="small"
            type="text"
            icon={paused ? <PlayCircleOutlined /> : <PauseOutlined />}
            onClick={() => setManualPause((value) => !value)}
          >
            {paused ? '继续滚动' : '暂停滚动'}
          </Button>
        </span>
      </div>

      <Table<ObservabilityErrorEvent>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        tableLayout="fixed"
        scroll={{ x: COLUMN_WIDTH_SUM }}
        pagination={false}
        onRow={(row) => ({
          onClick: () => {
            if (range === null) return;
            onInject(row, range);
          },
          style: {
            cursor: range === null ? 'default' : 'pointer',
            background: freshIds.has(row.id) ? tokens.tint.info : undefined,
            animation: freshIds.has(row.id)
              ? `assistant-ticker-in ${420}ms ${tokens.motion.easing} both`
              : undefined,
          },
        })}
        locale={{
          emptyText: (
            <EmptyState
              minHeight={160}
              title="窗口内没有错误事件 —— 这是「没发生过」，不是「没查到」"
            />
          ),
        }}
      />

      <Text type="secondary" style={{ fontSize: 11 }}>
        点一行 = 把这一行的条件（分型 / 级别 / 模型 / 请求号 / 窗口）交给助手；归因原文可直接选中复制或点行末复制。面板不替你写问题。
      </Text>
    </div>
  );
}
