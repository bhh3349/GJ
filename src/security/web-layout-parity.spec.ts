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

  it('Vite dev server 绑定是双栈（host: true，不许回退成缺省 localhost）', () => {
    // 事故本体：vite.config.ts 不写 host 时 Vite 5 缺省绑 localhost，本机把 localhost
    // 解析成 ::1 在前，dev server 只听 IPv6 —— Bo 用 127.0.0.1（IPv4）打不开页面。
    // host: true = 绑 ::（Node 对 :: 默认关 V6ONLY），IPv4/IPv6 都通。
    const vite = readFileSync(join(webSrcRoot, '..', 'vite.config.ts'), 'utf8');
    expect(vite).toMatch(/host:\s*true/);
  });

  it('Key 管理表：瘦身 Σ≤1176 零横滚，操作列右冻结、首列无冻结（业主 2026-11-03）', () => {
    // 两条事故风险，都真会发到屏幕上：
    //  ① Σ 列宽回弹 ⇒ 1440（可用 1176px）重新出现无谓横向滚动（业主口径：列宽按内容收紧）。
    //  ② `firstUsedAt: null`（从未被真正用过）被画成 `—` / `0` / 空串：`—` 在本页已经
    //     被「手工 key 无归属」占用，两个空混成一个符号，读的人分不清"没有归属"和"没用过"。
    const page = readFileSync(join(webSrcRoot, 'pages', 'KeysPage.tsx'), 'utf8');
    const AVAIL_WIDTH = 1176; // 1440×900 实测可用宽（Chrome 缩放 100%，侧栏收起）

    const scrollX = /scroll=\{\{ x: (\d+) \}\}/.exec(page)?.[1];
    expect(scrollX).toBeTruthy();
    expect(Number(scrollX)).toBeLessThanOrEqual(AVAIL_WIDTH);
    // 正对照：瘦身前的事故值 1662 必须被判据抓到（这条锁放开过一次，判据不许跟着失灵）。
    expect(Number(/scroll=\{\{ x: (\d+) \}\}/.exec('scroll={{ x: 1662 }}')?.[1])).toBeGreaterThan(
      AVAIL_WIDTH,
    );

    const colAt = page.indexOf("dataIndex: 'firstUsedAt'");
    expect(colAt).toBeGreaterThan(0);
    const col = page.slice(colAt, page.indexOf("title: '更新于'", colAt));
    expect(col).toMatch(/width: \d+/);
    // 空值分支：文案「未调用」在，`—` 不在；有值分支走相对时间 + 精确时刻 tooltip。
    expect(col).toMatch(/未调用/);
    expect(col).not.toMatch(/'—'/);
    // 负腿：把 null 渲染成 `—` 的合成样本必须被判据抓到（否则这条锁是摆设）。
    expect(/render: \(v\) => v === null \? <Text>—<\/Text>/.test("render: (v) => v === null ? <Text>—</Text> : null")).toBe(true);
    expect(col).toMatch(/formatIso\(value\)/);

    // 冻结口径（业主 2026-11-03 点名纠正，取代旧"瘦身前不许出现固定列"锁）：
    // **只**许操作列 fixed:'right'，首列（标签 / Key）一律不冻 —— 左冻结是他没要过的。
    expect(page).toMatch(/fixed: 'right'/);
    expect(page).not.toMatch(/fixed: 'left'/);
    // 变异验证：把左冻结加回合成样本，判据必须当场红（否则"不许左冻"是恒真摆设）。
    const hasLeftFixed = (src: string): boolean => /fixed: 'left'/.test(src);
    expect(hasLeftFixed("dataIndex: 'identifier', fixed: 'left' as const,")).toBe(true);
    expect(hasLeftFixed(page)).toBe(false);

    // Σ 列宽逐列加总 = 1140（11 个数据列），加勾选列 32 = 1172 ≤ 1176（1440 零横滚）：
    // 任何人往表里塞宽列而不腾地方，这里当场红。
    const colsSrc = page.slice(
      page.indexOf('const columns: ColumnsType<UpstreamKey>'),
      page.indexOf('const loading = list.loading'),
    );
    const widths = [...colsSrc.matchAll(/^ {6}width: (\d+),$/gm)].map((m) => Number(m[1]));
    expect(widths).toHaveLength(11);
    const sumWithSelection = widths.reduce((a, b) => a + b, 0) + 32;
    expect(sumWithSelection).toBeLessThanOrEqual(AVAIL_WIDTH);
    // scroll.x 必须与真实 Σ 一致（改列宽忘改 scroll.x 的漂移当场红）。
    expect(Number(scrollX)).toBe(sumWithSelection);
    // 正对照：事故值 1662 加回合成样本，判据必须红。
    expect(1662).toBeGreaterThan(AVAIL_WIDTH);
  });

  it('「标签 / Key」列只画标签 + 掩码，不掺调用状态（业主 2026-11-03：调用跟标签没关系）', () => {
    // 事故本体：建 key 自动首调保活（v1.25.0 / ADR-0050）落地后，最"顺手"的错法就是把
    // 「未调用 / 已调用 / 试调结果」画到标签旁边。业主原话：「跟标签状态什么的没关系，
    // 别把调用这个改到标签上面好吗？以前的显示套餐名称挺好的」。
    // 口径：标签列只答"这把 key 是谁"（套餐 key 的标签后端落 `套餐-<planTitle>`，如「套餐-轻享版」）；
    // 调用状态归独立的「首次调用」列与行内「试调」结果，两者都不许渗进这一列。
    const page = readFileSync(join(webSrcRoot, 'pages', 'KeysPage.tsx'), 'utf8');
    const start = page.indexOf("title: '标签 / Key'");
    expect(start).toBeGreaterThan(0);
    const seg = page.slice(start, page.indexOf("title: '上游'", start));

    // 正腿：这一列的数据面只有 label 与 maskedKey。
    expect(seg).toMatch(/row\.label/);
    expect(seg).toMatch(/row\.maskedKey/);

    const leaksCallState = (s: string): string[] =>
      ['probeById', 'firstUsedAt', 'PROBE_LABEL', '未调用', '已调用', '试调'].filter((k) => s.includes(k));
    expect(leaksCallState(seg)).toEqual([]);

    // 变异样本：把试调结果塞进标签列，同一判据必须当场报出来（否则这条锁是恒真摆设）。
    const mutated = seg.replace('{row.maskedKey}', '{probeById[row.id]?.short}');
    expect(mutated).not.toBe(seg);
    expect(leaksCallState(mutated)).toEqual(['probeById']);
  });

  it('账号池表：操作列右冻结、首列不冻（业主 2026-11-03 纠正：成对冻结撤左腿）', () => {
    // 事故本体：`scroll={{ x: 1894 }}` + 11 列清一色给宽，1440 视口（实测可用 1166px）白白滚一屏；
    // 操作列在横向滚动时滑出视野，业主原话「把操作那一列变成冻结列，永远常在」。
    // 2026-11-03 业主再纠正：只冻操作列，**首列不冻**（左冻结是我们自己加的，他没要过）。
    const page = readFileSync(
      join(webSrcRoot, 'pages', 'upstreams', 'SupplierAccountsPage.tsx'),
      'utf8',
    );
    const MAX_TABLE_WIDTH = 1166;

    const scrollX = /scroll=\{\{ x: (\d+) \}\}/.exec(page)?.[1];
    expect(scrollX).toBeTruthy();
    expect(Number(scrollX)).toBeLessThanOrEqual(MAX_TABLE_WIDTH);
    // 正对照：事故值 1894 必须被判据抓到，否则这条锁是摆设。
    expect(Number(/scroll=\{\{ x: (\d+) \}\}/.exec('scroll={{ x: 1894 }}')?.[1])).toBeGreaterThan(
      MAX_TABLE_WIDTH,
    );

    // 首列（账号）**无** fixed，宽度声明保留（fixed 布局里没宽度的列会被内容挤成面条）。
    const accountAt = page.indexOf("dataIndex: 'identifier'");
    const accountCol = page.slice(accountAt, page.indexOf("dataIndex: 'status'", accountAt));
    expect(accountCol).not.toMatch(/fixed: 'left'/);
    expect(accountCol).toMatch(/width: \d+/);

    const actionsAt = page.indexOf("key: 'actions'");
    expect(actionsAt).toBeGreaterThan(0);
    const actionCol = page.slice(actionsAt, actionsAt + 240);
    expect(actionCol).toMatch(/fixed: 'right'/);
    expect(actionCol).toMatch(/width: \d+/);
    // 负腿：右侧少了 fixed 的合成样本必须被抓到（判据不是恒真）。
    expect(/fixed: 'right'/.test("key: 'actions', width: 176,")).toBe(false);
    // 变异验证：把左冻结加回合成样本，「首列不冻」判据必须当场红。
    const hasLeftFixed = (src: string): boolean => /fixed: 'left'/.test(src);
    expect(hasLeftFixed(`${accountCol.slice(0, 80)}\n fixed: 'left' as const,`)).toBe(true);
    expect(hasLeftFixed(accountCol)).toBe(false);

    // 勾选/展开两列默认各 54/36px，收紧到 32 才把省下的宽度让给内容列。
    expect(page).toMatch(/rowSelection=\{\{[\s\S]{0,160}columnWidth: 32/);
    expect(page).toMatch(/expandable=\{\{[\s\S]{0,80}columnWidth: 32/);
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

  it('用户可见文案：按钮纯中文 ≤4 字、错误态标题不带端点路径（业主 2026-11-03）', () => {
    // 事故本体（业主原话「每个页面都有大片的说明性小文字」）里可被机器判定的两条：
    //  ① 按钮写成整句：「我已保存，关闭」「回到仪表盘」—— 4 字以上就不是按钮，是句子。
    //  ② 错误态标题里贴端点路径：「额度读取失败（GET /api/console/quota）」
    //     —— 用户读不懂也用不上，端点该留在代码里。
    // 只看用户真能读到的字符：JSX 文本节点与 `title` 属性值。注释、dataIndex、placeholder 不受影响
    // （placeholder 是输入提示，长度另说，这里不锁，免得把「选择上游」这类正常提示一起判死）。
    //
    // 并行车道豁免：曾把 Key 两页留给前端工程师自己补锁，2026-11-03 已摘掉 ——
    // 他的瘦身单（dev/web-fe cb597e7）把这两页的按钮压到 ≤4 单位、端点路径全部移出 title，
    // 所以豁免失效，锁重新覆盖全站（含这两页）。留空集合是为了让"下次再需要豁免"有唯一落点。
    const EXEMPT = new Set<string>();

    const COPY_JARGON = /\/api\/|\/v1\//;

    function copyOffenders(source: string): { longButtons: string[]; apiInTitle: string[] } {
      // 按钮判据：JSX 文本节点、含中文、**单位数** >4。单位 = 一个汉字 / 一个 ASCII 词
      // （「Key 管理」「近 7 天」都是 3 个单位，属正常标签）；空格不计数。
      // 不能用 \u4e00-\u9fa5 数长度 —— 「我已保存，关闭」里的全角逗号不算汉字，会少算一位。
      const units = (t: string): number =>
        (t.replace(/\s+/g, '').match(/[\u4e00-\u9fa5]|[A-Za-z0-9]+|./gu) ?? []).length;
      // 判据不看**原始跨度**：JSX 里的缩进与换行属于排版，不属于文案。
      // 旧写法 `>([^<>{}]{1,40})</Button>` 把缩进一起数进 40 字符上限，多行深缩进的按钮光缩进就超了，
      // 于是整块漏扫（2026-11-03 画师实证：`导出对账 CSV` 在 22/24 空格缩进下原始跨度 56，判据返回 0 条）。
      // 现在先取 Button 的纯文本子节点、再把空白折叠成一个空格 —— 缩进多深都不影响判定。
      const longButtons = [...source.matchAll(/>([^<>{}]*)<\/Button>/g)]
        .map((m) => (m[1] ?? '').replace(/\s+/g, ' ').trim())
        .filter((t) => /[\u4e00-\u9fa5]/.test(t) && units(t) > 4);
      const apiInTitle = [...source.matchAll(/title=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
        .map((m) => m[1] ?? m[2] ?? '')
        .filter((v) => COPY_JARGON.test(v));
      return { longButtons, apiInTitle };
    }

    const offenders: string[] = [];
    for (const file of listWebSources()) {
      const rel = relative(webSrcRoot, file).replace(/\\/g, '/');
      if (EXEMPT.has(rel)) continue;
      const { longButtons, apiInTitle } = copyOffenders(readFileSync(file, 'utf8'));
      for (const t of longButtons) offenders.push(`${rel} → 按钮「${t}」`);
      for (const t of apiInTitle) offenders.push(`${rel} → title「${t.slice(0, 40)}」`);
    }
    expect(offenders).toEqual([]);

    // 正对照：两个合成违例样本必须被同一条判据抓到（否则判据是摆设）。
    const sample = [
      '        <Button>我已保存，关闭</Button>',
      '        <ErrorState title="额度读取失败（`GET /api/console/quota`）" />',
    ].join('\n');
    const caught = copyOffenders(sample);
    expect(caught.longButtons).toEqual(['我已保存，关闭']);
    expect(caught.apiInTitle).toHaveLength(1);
    // 深层缩进变异样本（画师 2026-11-03 实证的盲区形态）：按钮写成多行、22/24 空格缩进。
    // 旧判据在这份样本上返回 0 条（原始跨度 56 > 40）—— 这行断言就是盲区本体，留作反证。
    const deepIndent = [
      '                      <Button',
      '                        size="small"',
      '                        icon={<DownloadOutlined />}',
      '                      >',
      '                        导出对账 CSV',
      '                      </Button>',
    ].join('\n');
    expect([...deepIndent.matchAll(/>([^<>{}]{1,40})<\/Button>/g)]).toHaveLength(0);
    expect(copyOffenders(deepIndent).longButtons).toEqual(['导出对账 CSV']);
    // 负腿：4 字以内按钮、以及数据型 title（掩码 / 时刻 / 计数）不得被误伤。
    expect(copyOffenders('<Button>解除透支</Button>').longButtons).toEqual([]);
    expect(copyOffenders('<ErrorState title="刷新失败，下方为旧数据" />').apiInTitle).toEqual([]);
  });
});
