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

  it('用户可见文案里不得出现接口文档术语（§ 号 / 契约 / 端点参数名）', () => {
    // 事故本体：助手页新组件把「数据源：§5 模型档案 + §6 用量（groupBy=model）…」写进了 Panel 的
    // `hint`，于是**生产包里**出现 `§` 与「契约」（本轮 dist 扫描抓到）。Bo 的口径是全站
    // 开发术语清空 —— 注释里引契约是依据，写进 tooltip 就是漏给用户。
    //
    // 判据只看**字符串字面量内部**。这里刻意用带状态的扫描器而不是"正则抓引号"：
    // 本仓注释里的中文引号不成对，先剥注释或按行配对都会被注释里的引号骗出误报，
    // 而一条会误报的锁最终只会被绕过。扫描器跳过注释、字符串内的 `//` 与模板串 `${}`。
    const JARGON = /\u00a7\s*\d|\u5951\u7ea6\s*\u00a7|\bgroupBy\b|\bcostCents\b|\bpageSize\b|\busage_logs\b|ADR-\d/;

    /** 抽出源码里所有字符串字面量的内容（不含注释、不含模板串插值）。 */
    function stringLiterals(source: string): string[] {
      const out: string[] = [];
      let i = 0;
      while (i < source.length) {
        const ch = source[i];
        const next = source[i + 1];
        if (ch === '/' && next === '/') {
          while (i < source.length && source[i] !== '\n') i += 1;
          continue;
        }
        if (ch === '/' && next === '*') {
          i += 2;
          while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
          i += 2;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') {
          const quote = ch;
          i += 1;
          let body = '';
          while (i < source.length) {
            const c = source[i];
            if (c === '\\') {
              body += c + (source[i + 1] ?? '');
              i += 2;
              continue;
            }
            // 模板串的插值部分是**代码**，不是文案：跳到配对的 `}` 再继续收字面量。
            if (quote === '`' && c === '$' && source[i + 1] === '{') {
              let depth = 1;
              i += 2;
              while (i < source.length && depth > 0) {
                if (source[i] === '{') depth += 1;
                else if (source[i] === '}') depth -= 1;
                i += 1;
              }
              continue;
            }
            if (c === quote) {
              i += 1;
              break;
            }
            // 普通引号不跨行：跨行说明这里不是字符串（JSX 文本、误判等），放弃这一段。
            if ((quote === '"' || quote === "'") && c === '\n') break;
            body += c;
            i += 1;
          }
          out.push(body);
          continue;
        }
        i += 1;
      }
      return out;
    }

    // 豁免：**整串就是一个 ASCII 标识符**的字面量是字段绑定（`dataIndex: 'costCents'`、
    // `value: '1m'`），不是给人读的文案 —— 它必须与契约字段同名，改它才是 bug。
    // 判据因此只看"含中文或含空格的字符串"，也就是真正会出现在屏幕上的那些。
    const isCopy = (body: string): boolean => body !== '' && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(body);

    const offenders: string[] = [];
    for (const file of listWebSources()) {
      const hits = stringLiterals(readFileSync(file, 'utf8')).filter((b) => isCopy(b) && JARGON.test(b));
      if (hits.length > 0) offenders.push(`${relative(webSrcRoot, file)} \u2192 ${hits.join(' | ')}`);
    }
    expect(offenders).toEqual([]);

    // 正对照：合成一个"tooltip 里写契约编号"的违例样本，同一条判据必须抓到。
    const violation = 'const a = 1; // \u6ce8\u91ca\u91cc\u63d0 \u00a76 \u65e0\u59a8\nconst hint = "\u6570\u636e\u6e90\uff1a\u00a76 \u7528\u91cf\uff08groupBy=model\uff09";';
    const violationLiterals = stringLiterals(violation).filter((b) => isCopy(b) && JARGON.test(b));
    expect(violationLiterals).toHaveLength(1);
    // 负腿 2：字段绑定不是文案，不得被这条锁误伤（否则第一个被绕过的就是它）。
    expect(isCopy('costCents')).toBe(false);
    expect(isCopy('\u6210\u672c costCents \u6309\u5206\u8ba1')).toBe(true);
    // 负腿：注释里的契约引用、以及模板串插值里的变量名都不算漏给用户。
    expect(stringLiterals('// \u53e3\u5f84\u6765\u81ea\u5951\u7ea6 \u00a76\uff0c\u53c2\u6570 groupBy \u539f\u6837\u4f20')).toEqual([]);
    // 模板串里的 `${row.costCents}` 是**代码**不是文案：插值被跳过后只剩「成本 」，
    // 它不含术语，所以这条判据不报（而若有人把它写成 "成本 costCents" 就会被抓到）。
    const templateLiterals = stringLiterals('const s = `\u6210\u672c ${row.costCents}`;');
    expect(templateLiterals).toEqual(['\u6210\u672c ']);
    expect(templateLiterals.filter((b) => isCopy(b) && JARGON.test(b))).toEqual([]);
  });

  it('§12.1 分型标签只有一个事实源（两处各抄一份必然漂移）', () => {
    // 事故风险不是排版而是**口径**：分型中文名原先长在 DashboardPage 里，助手页要用同一份时
    // 若抄一遍，就会出现「同一个 category 在两页显示两个名字」，读的人以为分型变了。
    // 唯一实现收在 `web/src/utils/observabilityLabels.ts`，其余页面只许 import。
    const owners: string[] = [];
    for (const file of listWebSources()) {
      const src = readFileSync(file, 'utf8');
      // 判据：出现「分型名 → 中文」的字面量映射（以 CLIENT_REQUEST 为锚，它是九个里最独特的键）。
      if (/CLIENT_REQUEST:\s*'/.test(src)) owners.push(relative(webSrcRoot, file));
    }
    expect(owners).toEqual([join('utils', 'observabilityLabels.ts')]);

    // 正对照：同一判据喂一个"在页面里抄了一份"的合成样本，必须抓到。
    const copied = ["const LOCAL: Record<string, string> = {", "  CLIENT_REQUEST: '调用方写错',", '};'].join(
      '\n',
    );
    expect(/CLIENT_REQUEST:\s*'/.test(copied)).toBe(true);
  });

  it('助手页错误面板守 §13.6 三条硬口径（50/50 分栏的回归位）', () => {
    // 契约 v1.11.1 §13.6 / ADR-0025 把这张面板的口径钉成硬规则；这里锁的是**结构**而不是像素：
    // 栅格类名、行去重、以及"面板不许把行文本拼进对话"这三条一旦被重构抹掉就静默回退。
    const page = readFileSync(join(webSrcRoot, 'pages', 'assistant', 'AssistantPage.tsx'), 'utf8');
    expect(page).toMatch(/className="panel-grid-half"/);
    expect(page).toMatch(/ErrorSummaryPanel/);

    const panel = readFileSync(
      join(webSrcRoot, 'pages', 'assistant', 'ErrorSummaryPanel.tsx'),
      'utf8',
    );
    // ① 轮询区间天然重叠，不去重就会把同一事件刷屏重复计数。
    expect(panel).toMatch(/seenRef\.current\.has\(event\.id\)/);
    // ② 计数条必须读 §12.2 的健康指标，**不得**从面板那份分页响应现算（两个口径）。
    expect(panel).toMatch(/observabilityApi\.health\(/);
    expect(panel).toMatch(/byCategory/);
    // ③ 分工：**面板**只回调注入条件，绝不自己开流（`chat.send` 在页面里是人按发送，合法；
    //    出现在面板文件里就是面板替人按了发送）。页面侧则锁"点行不写输入框"：
    //    `injectEvent` 里出现 `setDraft` 或 `event.message` 都等于把行文本塞进对话。
    expect(panel).not.toMatch(/assistant\/chat/);
    expect(panel).not.toMatch(/chat\.send\(/);
    const inject = page.slice(page.indexOf('const injectEvent'), page.indexOf('const pickCategories'));
    expect(inject).not.toBe('');
    expect(inject).not.toMatch(/setDraft/);
    expect(inject).not.toMatch(/\.message/);
    // 正对照：合成一个"点行时把归因拼成句子塞进输入框"的违例样本，判据必须抓到。
    const violation =
      'const injectEvent = (event) => { setDraft(`看一下这条 ${event.message}`); }; const pickCategories = 0;';
    const violationInject = violation.slice(
      violation.indexOf('const injectEvent'),
      violation.indexOf('const pickCategories'),
    );
    expect(/setDraft/.test(violationInject)).toBe(true);
    expect(/\.message/.test(violationInject)).toBe(true);
    // 负腿：白名单字段赋值不是"拼句子"，不得被误伤。
    expect(
      /setDraft|\.message/.test('const requestId = event.requestId ?? null; logCtx.severity = event.severity;'),
    ).toBe(false);
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
