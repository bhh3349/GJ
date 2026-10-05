// 「key 明文永不落盘」静态扫描 —— 验收第 9 条。
//
// 为什么把它做成独立可执行脚本而不是只写个测试：
//   1. CI 需要一步独立的门禁（红了能直接看出是这条纪律挂了，而不是"某个测试挂了"）；
//   2. 测试里也 import 同一个 scanRepo()，保证「pnpm test 绿」和「CI 绿」用的是同一份判据，
//      不会出现两套规则慢慢漂移。
//
// 设计上的两个防自欺：
//   - 扫描器输出「扫了多少个文件」。0 命中 + 0 文件 = 假绿，必须能看出来。
//   - spec 里有正对照：故意在临时目录造一个真格式的 key，断言扫描器**抓得到**。
//     没有正对照的扫描器，退化成 `return []` 也照样"全绿"。
//
// 用法：pnpm run check:secrets

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname, sep, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ScanHit {
  /** 仓库相对路径，统一用 `/`，保证 Windows/CI 输出一致 */
  file: string;
  line: number;
  rule: string;
  /** 命中片段，已脱敏：只留前 6 位 + 长度，避免扫描输出本身又变成一次泄漏 */
  excerpt: string;
}

export interface ScanOptions {
  /** 额外跳过的相对路径前缀 */
  skip?: string[];
}

/** 目录名黑名单（任意层级命中即整棵跳过） */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vitest',
  '.ekko-tmp',
  '.pnpm-store',
  // git worktree 是整棵仓库的另一份检出处，扫它只会翻倍耗时并产出重复命中
  '.worktrees',
]);

/** 文件名黑名单：锁文件里全是 base64 integrity 摘要，扫它只有噪声没有信号 */
const SKIP_FILES: ReadonlySet<string> = new Set(['pnpm-lock.yaml', 'package-lock.json']);

/** 只扫文本类扩展名。含空扩展名以覆盖 `.env.example` 这类文件。 */
const TEXT_EXT: ReadonlySet<string> = new Set([
  '',
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.json5',
  '.md',
  '.yml',
  '.yaml',
  '.sql',
  '.example',
  '.html',
  '.css',
  '.txt',
  '.sh',
]);

const MAX_BYTES = 2 * 1024 * 1024;

interface Rule {
  id: string;
  pattern: RegExp;
  /** 命中说明，直接打到 CI 日志里给人看 */
  note: string;
}

/**
 * 规则集。新增规则必须同时补正对照用例，否则等于没加。
 *
 * 注意：本文件自身也在扫描范围内，所以 pattern 不能自我命中 ——
 * 把下划线写成字面量（而不是 `_?`）会让规则在源码里匹配到自己，
 * 这条规则就成了"永远失败"，等于失效。（本文件第一版就踩了这个，靠扫描器自己抓出来的。）
 */
export const RULES: readonly Rule[] = [
  {
    id: 'provider-key-literal',
    // OpenAI / Anthropic / OpenRouter / Google / GitHub / Slack / JWT
    pattern:
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|sk-or-v1-[A-Za-z0-9]{32,}|AIza[0-9A-Za-z_-]{35}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
    note: '看起来是真 key 的字面量，必须换成占位符或从 env 读',
  },
  {
    id: 'assigned-secret',
    pattern:
      /(?:api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{24,}["']/gi,
    note: '给 key/secret/token 硬编码赋值，改从 env 读',
  },
  {
    id: 'plaintext-key-identifier',
    // 禁止出现"存明文 key"的字段/变量/列名。落盘列只允许存密文，列名不得暗示明文。
    pattern: /\b(?:plain_?(?:text_?)?key|raw_?key|unencrypted_?key|key_?plaintext)\b/gi,
    note: '出现"明文 key"语义的标识符：落盘只许密文，见 docs/adr/0006',
  },
];

/** 占位符豁免：这些明显不是真凭据 */
const PLACEHOLDER = /(?:change[_-]?me|placeholder|example|your[_-]?|xxxx|<[^>]*>|\.\.\.|redacted|dummy|fake|sample|\*\*\*\*)/i;

function isPlaceholder(text: string): boolean {
  return PLACEHOLDER.test(text);
}

function isTextFile(name: string, size: number): boolean {
  if (size > MAX_BYTES) return false;
  return TEXT_EXT.has(extname(name).toLowerCase());
}

/** 前端构建产物等可能带 BOM/二进制；用 NUL 字节粗判 */
function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function redact(match: string): string {
  const head = match.slice(0, 6);
  return `${head}…(${match.length} chars)`;
}

function scanFile(absPath: string, relPath: string): ScanHit[] {
  const hits: ScanHit[] = [];
  let content: string;
  try {
    const buf = readFileSync(absPath);
    if (looksBinary(buf)) return hits;
    content = buf.toString('utf8');
  } catch {
    // 读不了（权限/软链断）不静默吞：算一个命中，避免"扫不到=通过"
    return [{ file: relPath, line: 0, rule: 'unreadable', excerpt: '无法读取，需人工确认' }];
  }

  const lines = content.split(/\r?\n/);
  for (const rule of RULES) {
    // 每条规则独立遍历，正则带 /g 必须重置 lastIndex
    rule.pattern.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      rule.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.pattern.exec(line)) !== null) {
        const match = m[0];
        if (rule.id === 'assigned-secret' && isPlaceholder(match)) continue;
        if (rule.id === 'provider-key-literal' && isPlaceholder(match)) continue;
        hits.push({ file: relPath, line: i + 1, rule: rule.id, excerpt: redact(match) });
        if (m.index === rule.pattern.lastIndex) rule.pattern.lastIndex++;
      }
    }
  }
  return hits;
}

function walk(
  root: string,
  dir: string,
  skipPrefixes: string[],
  out: ScanHit[],
  counter: { files: number; bytes: number },
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    const rel = relative(root, abs).split(sep).join('/');
    if (SKIP_DIRS.has(name)) continue;
    if (skipPrefixes.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
    if (SKIP_FILES.has(name)) continue;

    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(root, abs, skipPrefixes, out, counter);
      continue;
    }
    if (!st.isFile()) continue;
    if (!isTextFile(name, st.size)) continue;

    counter.files++;
    counter.bytes += st.size;
    out.push(...scanFile(abs, rel));
  }
}

/** 扫描整仓。返回空数组 = 干净。 */
export function scanRepo(
  rootDir: string,
  opts: ScanOptions = {},
): { hits: ScanHit[]; filesScanned: number; bytesScanned: number } {
  const hits: ScanHit[] = [];
  const counter = { files: 0, bytes: 0 };
  walk(rootDir, rootDir, opts.skip ?? [], hits, counter);
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { hits, filesScanned: counter.files, bytesScanned: counter.bytes };
}

/** 仓库根目录：本文件在 <root>/src/security/ 下 */
export function repoRoot(): string {
  return fileURLToPath(new URL('../..', import.meta.url));
}

function main(): void {
  const root = repoRoot();
  const { hits, filesScanned, bytesScanned } = scanRepo(root);

  const kb = Math.round(bytesScanned / 1024);
  console.log(`扫描范围: ${root}`);
  console.log(`已扫描: ${filesScanned} 个文件 / ${kb} KB`);

  if (filesScanned === 0) {
    console.error('FAIL  扫描到 0 个文件，判据失效（0 文件 != 干净）');
    process.exit(1);
  }

  if (hits.length > 0) {
    const notes = new Map(RULES.map((r) => [r.id, r.note]));
    console.error(`\nFAIL  命中 ${hits.length} 处「key 明文」疑似：`);
    for (const h of hits) {
      console.error(`  ${h.file}:${h.line}  [${h.rule}]  ${h.excerpt}`);
      const note = notes.get(h.rule);
      if (note) console.error(`      → ${note}`);
    }
    console.error('处置：改成占位符/从 env 读；确属误报则在对应规则里补豁免并说明理由。');
    process.exit(1);
  }

  console.log('PASS  key 明文扫描：0 命中');
}

/** Windows 下 argv[1] 与 fileURLToPath 的大小写/分隔符可能不一致，统一规范化后再比 */
function isDirectRun(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  const a = resolve(arg);
  const b = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// 仅在被直接执行时跑 main（被 import 时不执行）
if (isDirectRun()) {
  main();
}
