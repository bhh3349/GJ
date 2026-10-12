/**
 * 「还剩多少」的百分比 + 进度线（Bo 2026-10-12 改进 ⑥）。
 *
 * 一列金额读不出**节奏**：¥3.20 是"快用完了"还是"刚开的一瓶"，取决于总额是多少。
 * 所以这一格给两条信息：剩余金额（原样）+ 剩余占总额的比例。
 *
 * 三条纪律：
 * - **比例算不出来就不画**。总额 ≤ 0 或任一端未知时 `ratio` 是 `null`：
 *   一根 0% 的条看起来像"用光了"，而事实是"不知道"。
 * - **剩余 ≤ 10% 转琥珀、= 0 转橙**（与账号健康档同一套色），让人一眼挑出该续的那几个。
 * - 负数（上游侧触到额度上限）**按 0 画条、按比例显示 `−`**：条长不能是负的，
 *   但那个超出是事实，得写出来（红减号是 U+2212，与连字符区分，等宽对齐才不跳）。
 *
 * ## 排版：本组件必须**只能变窄，不能撑破**
 *
 * 2026-10-12 Bo 截图指出套餐台账那一格"一大堆文字缩在小空间里逐字换行"。根因在**这里也有份**：
 * 旧版写死 `minWidth: 96` + 进度条 `width: 88` + 说明行 `whiteSpace: nowrap`，
 * 三样合起来等于对外声明"我至少要有 ~150px 才不溢出"，而调用方给的列宽是 140px。
 * 于是金额被拆成 `¥0` / `.0` / `5` 三行，说明行溢出到隔壁列。
 *
 * 现在改成：**宽度完全跟随所在格子**（`width: 100%` + `minWidth: 0`），
 * 进度条跟着格子伸缩，说明行放不下就省略号收尾（完整口径在悬浮提示里，不靠换行硬塞）。
 * 也就是说，这一格**永远不会再把表格撑破**；要放不下了，它自己收窄。
 *
 * ## 为什么主数值是 `value` 而不是 `children`（同类缺陷的类型级护栏）
 *
 * 上面那个 `caption=` 事故之所以能编译通过，是因为本组件**过去收 children**。
 * 一旦收 children，`<RemainingBar ratio={…}><BalanceText /></RemainingBar>` 后面再跟一行
 * `caption={…}` 就是**合法的 JSX 文本子节点**，TS 一声不吭，React 照字面渲染。
 * 现在**显式不收 children**（`children` 不在 props 里 ⇒ 多写一个子节点直接 TS2322），
 * 把这类错误从"上线后被用户看见"提前到"编辑时被 typecheck 拦下"。
 * 类型护栏是这里唯一可行的锁：vitest 只收根仓 `src` 下的 `.spec.ts`，`web` 目录被显式排除，
 * 所以站内**没有**能跑这条断言的测试位；不能指望测试兜住，只能让类型不允许。
 */
import { Tooltip, Typography } from 'antd';

import { tokens } from '@/theme/tokens';

const { Text } = Typography;

/** 剩余占比低于此值转琥珀。 */
const LOW_RATIO = 0.1;

/**
 * 注意：**这里没有 `children`**。不是漏了，是故意的 —— 见文件头「类型级护栏」一节。
 */
export interface RemainingBarProps {
  /** 0..1；`null` = 算不出来（未知），此时**不画条、不显示百分比**。 */
  ratio: number | null;
  /** 百分比左侧的那句金额文案（由调用方给，本组件不参与金额口径）。 */
  value: React.ReactNode;
  /** 悬浮补充说明。 */
  hint?: string | undefined;
  /** 条下方的次要口径（总额 / 已用这类）。不传就不占一行。 */
  caption?: React.ReactNode;
  /**
   * 说明行与主数值**同行**显示（窄格子里省一行高度）。
   * 默认 `false` = 说明行单独占一行 —— 台账那种两列并排的场景更整齐。
   */
  inlineCaption?: boolean;
}

/** 单行、放不下就省略号：这一格的原则是「收窄」而不是「撑破」。 */
const oneLine: React.CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export function RemainingBar({
  ratio,
  value,
  hint,
  caption = null,
  inlineCaption = false,
}: RemainingBarProps) {
  const clamped = ratio === null ? null : Math.min(1, Math.max(0, ratio));
  const exhausted = ratio !== null && ratio <= 0;
  const low = clamped !== null && clamped < LOW_RATIO;
  const color = exhausted
    ? tokens.color.orange
    : low
      ? tokens.color.warning
      : tokens.color.success;

  /** 百分比：按 `ratio` 原值显示、条长按 `clamped` 画。 */
  const percent =
    ratio === null ? null : (
      <Text
        style={{
          fontSize: 11,
          color,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          flex: 'none',
        }}
      >
        {/*
          剩余是负数（上游侧超出上限）时条不能是负长度，但那个超出是事实，
          写成 `−n%` 而不是假装 0%。
        */}
        {`${ratio < 0 ? '\u2212' : ''}${Math.round(Math.abs(ratio) * 100)}%`}
      </Text>
    );

  const bar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.space.sm, minWidth: 0 }}>
        <span style={{ ...oneLine, flex: '1 1 auto' }}>{value}</span>
        {inlineCaption && caption ? (
          <Text
            type="secondary"
            style={{
              ...oneLine,
              flex: '0 1 auto',
              fontSize: 11,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {caption}
          </Text>
        ) : null}
        {percent}
      </div>
      <div
        style={{
          // 条长跟随格子宽度；至少留 40px 才看得出"有一根条"这件事。
          minWidth: 40,
          height: 3,
          borderRadius: 2,
          background: tokens.color.border,
          overflow: 'hidden',
        }}
      >
        {clamped === null ? null : (
          <div
            style={{
              width: `${clamped * 100}%`,
              height: '100%',
              background: color,
              transition: `width ${tokens.motion.base} ${tokens.motion.easing}`,
            }}
          />
        )}
      </div>
      {!inlineCaption && caption ? (
        <Text
          type="secondary"
          style={{
            ...oneLine,
            display: 'block',
            fontSize: 11,
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
          }}
        >
          {caption}
        </Text>
      ) : null}
    </div>
  );

  if (!hint) return bar;
  return <Tooltip title={hint}>{bar}</Tooltip>;
}
