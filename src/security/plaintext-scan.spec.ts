// 「key 明文永不落盘」扫描器的测试 —— 验收第 9 条的判据本体。
//
// 这个文件里**没有**任何真格式的 key 字面量，所有 fixture 都是运行时拼出来的。
// 原因有两个：
//   1. 本文件也在扫描范围内，写死一个字面量会让扫描器命中自己（自指死锁）；
//   2. 运行时拼装本身就证明了那是人造串，不是谁不小心粘进来的真 key。
//
// 结构是「一正一负」两条腿：
//   - 负：扫真仓库，必须 0 命中；
//   - 正：扫临时目录里的合成 key，必须命中。
//   只有负腿的话，`scanRepo = () => []` 也能全绿。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { RULES, repoRoot, scanRepo, type ScanHit } from './plaintext-scan.js';

/** 合成一个 OpenAI 形状的 key。字符串在运行时拼出，源码里不存在该字面量。 */
function fakeOpenAiKey(): string {
  return ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('-');
}

/** 合成一个给 secret 硬编码赋值的片段 */
function fakeAssignedSecret(): string {
  return `const apiKey = "${'Zq7'.repeat(10)}";`;
}

/** 合成一个「明文 key」语义的标识符 */
function fakePlaintextIdentifier(): string {
  return `${'plain'}${'_'}${'key'}`;
}

const roots: string[] = [];
function makeTempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'scan-probe-'));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe('plaintext-scan 规则集', () => {
  it('每条规则都能抓到自己的合成样本（否则规则是摆设）', () => {
    const probes: Record<string, string> = {
      'provider-key-literal': `const k = "${fakeOpenAiKey()}";`,
      'assigned-secret': fakeAssignedSecret(),
      'plaintext-key-identifier': `const ${fakePlaintextIdentifier()} = cipher;`,
      // 分片拼装：源码里不得出现完整的 user:pass@域名 形态字面量，否则本文件自命中
      'proxy-url-credentials': `const u = "${['http://svc', ':', 'K9w'.repeat(8), '@203.0.113.9:8080'].join('')}";`,
    };

    // 规则集增删时这里会失败，强制补正对照
    expect(Object.keys(probes).sort()).toEqual(RULES.map((r) => r.id).sort());

    for (const [ruleId, source] of Object.entries(probes)) {
      const dir = makeTempRepo({ 'a.ts': source });
      const { hits } = scanRepo(dir);
      const matched = hits.filter((h: ScanHit) => h.rule === ruleId);
      expect(matched, `规则 ${ruleId} 未命中合成样本`).toHaveLength(1);
    }
  });

  it('豁免占位符，避免把文档示例判成泄漏', () => {
    const dir = makeTempRepo({
      'a.env': ['OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', '', '# 说明：token: <your-token-here>', ''].join('\n'),
    });
    expect(scanRepo(dir).hits).toEqual([]);
  });

  it('跳过 node_modules / dist，不把依赖和产物算进判据', () => {
    const dir = makeTempRepo({
      'src/ok.ts': 'export const a = 1;',
      'node_modules/pkg/index.js': `module.exports = "${fakeOpenAiKey()}";`,
      'dist/bundle.js': `var k="${fakeOpenAiKey()}";`,
    });
    const { hits, filesScanned } = scanRepo(dir);
    expect(hits).toEqual([]);
    expect(filesScanned).toBe(1);
  });
});

describe('真实仓库', () => {
  it('全仓 0 命中，且确实扫到了文件（0 文件 = 判据失效）', () => {
    const { hits, filesScanned, bytesScanned } = scanRepo(repoRoot());

    if (hits.length > 0) {
      const detail = hits.map((h) => `${h.file}:${h.line} [${h.rule}] ${h.excerpt}`).join('\n  ');
      throw new Error(`仓库里发现疑似明文 key：\n  ${detail}`);
    }

    expect(filesScanned).toBeGreaterThan(20);
    expect(bytesScanned).toBeGreaterThan(10_000);
  });
});

describe('proxy-url-credentials（§16.7 出口面，台账 deny-case 证据）', () => {
  it('deny：.ts 里出现 user:pass@ 明文凭据 → 命中', () => {
    // 源码里运行时拼装，避免本文件被扫描器自命中
    // host 用 TEST-NET IP 而不是 proxy.example：PLACEHOLDER 豁免含 "example"，
    // 用带 example 的域名会让 deny 样本被自己豁免掉（假阴性）。
    const url = ['http://sub2api', ':', 'S3cret-Vault-9', '@203.0.113.9:8080'].join('');
    const dir = makeTempRepo({ 'a.ts': `const egressUrl = "${url}";` });
    const { hits } = scanRepo(dir);
    const matched = hits.filter((h: ScanHit) => h.rule === 'proxy-url-credentials');
    expect(matched).toHaveLength(1);
  });

  it('正对照：nodes.example.tsv 的 CHANGE_ME 占位不命中（示例清单不是泄漏）', () => {
    const line = 'hk-1\thttp://sub2api:CHANGE_ME@203.0.113.10:8080\t203.0.113.10\thk';
    const dir = makeTempRepo({ 'nodes.example.tsv': line });
    const { hits } = scanRepo(dir);
    expect(hits).toEqual([]);
  });
});
