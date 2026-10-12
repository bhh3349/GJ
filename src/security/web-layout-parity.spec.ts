// 前端排版防回退锁 —— 扫 `web/src` 源码文本，把 2026-10-12 Bo 抓到的两类事故钉成断言。
//
// 为什么做成源码扫描而不是组件测试：vitest 只收根仓 `src/**/*.spec.ts`，`web/**` 被显式排除
// （AGENTS.md 的测试口径），站内没有能渲染 React 的测试位。能锁住这两类的只有文本级断言 +
// typecheck 的类型护栏（RemainingBar 不收 children），所以本文件同时**核对护栏还在**。
//
// 事故本体（真在屏幕上出现过，见 Bo 2026-10-12 截图）：
//   1. `caption={…}` 被写进组件的**子节点位置**而不是属性位置 —— 只要该组件收 children，
//      这就是合法 JSX，TS 一声不吭，React 照字面渲染出「caption=总额 ¥29.90 ·」这种开发术语串。
//   2. 表格里长文本逐字换行 + 未声明宽度的列吃掉全部剩余宽度（「套餐」列左边大片空白、
//      右边三列挤成面条）。修法是 `tableLayout="fixed"` + 每列声明宽度，这里锁住它不被重构抹掉。
//
// 与 plaintext-scan 同一条纪律：**每条负腿都配正对照**（同一判据喂一个合成事故样本，
// 必须抓到）。没有正对照的扫描器，退化成 `return []` 也照样全绿。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const webSrcRoot = fileURLToPath(new URL('../../web/src', import.meta.url));

/** 收集 web/src 下全部 .ts/.tsx（与站内源码同扩展名面）。 */
function listWebSources(dir: string = webSrcRoot): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...listWebSources(abs));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(abs);
  }
  return out;
}

/**
 * 找「prop 字面量出现在 JSX 子节点位置」的行号。
 *
 * 判据（纯文本级，够用且零误报面）：一行以 `名字=` 开头（这些名字都是本仓组件的属性名），
 * 且**上一条非空行以 `>` 收尾** —— 意味着 JSX 开标签已经闭合，本行只能是 children。
 * 合法的多行属性写法里，属性行永远跟在另一个属性行（以 `}`、字符串或 `,` 收尾）或开标签行后，
 * 不会命中这条判据；而事故形态（`<X …>` 换行后 `<Child />` 再换行 `caption={…}`）必命中。
 */
export function findPropLiteralInChildPosition(source: string): number[] {
  const lines = source.split(/\r?\n/);
  const hits: number[] = [];
  let lastNonEmpty = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const isPropChild =
      lastNonEmpty.endsWith('>') &&
      /^(?:caption|hint|tooltip|value|ratio|source|updatedAt|strong|showMeta)=/.test(trimmed) &&
      // 属性位置的多行换行形态 `name={` 与文本子节点形态都算事故；
      // 但 `=>` 结尾的箭头函数属性行（lastNonEmpty 以 `>` 收尾的另一种来源）由下一条排除。
      !lastNonEmpty.endsWith('=>');
    if (isPropChild) hits.push(i + 1);
    lastNonEmpty = trimmed;
  }
  return hits;
}

describe('web 排版防回退锁（2026-10-12 事故）', () => {
  it('正对照：合成事故样本必须被抓到（否则判据是摆设）', () => {
    const accident = [
      '<RemainingBar',
      '  ratio={ratio}',
      '>',
      '  <BalanceText value={remaining} />',
      '  caption={`总额 ${total} · 已用 ${used}`}',
      '</RemainingBar>',
    ].join('\n');
    expect(findPropLiteralInChildPosition(accident)).toEqual([5]);

    // 合法形态不得误报：属性全在开标签内，caption 是属性不是子节点。
    const legal = [
      '<RemainingBar',
      '  ratio={ratio}',
      '  value={<BalanceText value={remaining} />}',
      '  caption={`总额 ${total}`}',
      '/>',
    ].join('\n');
    expect(findPropLiteralInChildPosition(legal)).toEqual([]);
  });

  it('web/src 全量：没有任何 prop 字面量落在 JSX 子节点位置', () => {
    const offenders: string[] = [];
    for (const file of listWebSources()) {
      const lines = findPropLiteralInChildPosition(readFileSync(file, 'utf8'));
      if (lines.length > 0) offenders.push(`${relative(webSrcRoot, file)}:${lines.join(',')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('RemainingBar 的 props 里不得重新出现 children（类型护栏不能被拆）', () => {
    // 护栏语义：props 接口不含 children ⇒ 多写一个子节点直接 TS2322，事故在编辑期即被 typecheck 拦下。
    // 这里锁的是**声明**，注释里提到 children 不算（文件头注释本来就在解释这段历史）。
    const src = readFileSync(join(webSrcRoot, 'components', 'RemainingBar.tsx'), 'utf8');
    const interfaceBlock = src.slice(
      src.indexOf('export interface RemainingBarProps'),
      src.indexOf('const LOW_RATIO') > src.indexOf('export interface RemainingBarProps')
        ? src.indexOf('const LOW_RATIO')
        : src.length,
    );
    expect(interfaceBlock).not.toBe('');
    expect(interfaceBlock).not.toMatch(/^\s*children\??:/m);
    expect(interfaceBlock).toMatch(/\bvalue: React\.ReactNode/);
  });

  it('套餐台账表仍是 fixed 布局 + 全列声明宽度（长文本换行事故的回归位）', () => {
    const src = readFileSync(
      join(webSrcRoot, 'pages', 'upstreams', 'SupplierSubscriptionsTable.tsx'),
      'utf8',
    );
    expect(src).toMatch(/tableLayout="fixed"/);
    expect(src).toMatch(/COLUMN_WIDTHS/);
    // 每一列都必须从 COLUMN_WIDTHS 拿宽度：出现 `key: '…'` 列却没有对应 width 声明即回退。
    const planCol = src.slice(src.indexOf("title: '套餐'"), src.indexOf("key: 'remaining'"));
    expect(planCol).toMatch(/width: COLUMN_WIDTHS\.plan/);
  });
});
