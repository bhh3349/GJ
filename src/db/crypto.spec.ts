// 验收第 9 条的**真判据**：key 明文永不落盘。
//
// 这条测试刻意不只做「加密能解回来」。那只证明数学对，不证明落盘干净 ——
// 密文写对了、同时明文被顺手写进另一列/另一张表/WAL，加密往返测试照样全绿。
//
// 所以这里做的是：把密文写进**真实 SQLite 文件**（真开 WAL），关库，
// 然后对 .db / .db-wal / .db-shm 的**裸字节**做双向扫描：
//   - 负向：明文及其 base64/hex 形态必须**一个字节都找不到**；
//   - 正向：往对照库里存明文，同一个扫描函数必须**抓得到**。
// 没有正向那条，扫描函数退化成 `return false` 也照样全绿。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CryptoConfigError,
  decryptSecret,
  encryptSecret,
  loadMasterKeyFromEnv,
  maskKey,
  parseMasterKey,
  safeEqualHex,
  sha256Hex,
} from './crypto.js';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'crypto-probe-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const MASTER_KEY = Buffer.from('0f'.repeat(32), 'hex');

/** 合成一个上游 key 形状的明文。运行时拼装，源码里不存在该字面量（扫描器自指防线）。 */
function fakeUpstreamKey(): string {
  return ['sk', 'probe', sha256Hex('disk-plaintext-probe').slice(0, 40)].join('-');
}

/** db 文件 + WAL + SHM 的裸字节 */
function readRawFiles(dbPath: string): Buffer {
  return Buffer.concat(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((p) => existsSync(p)).map((p) => readFileSync(p)),
  );
}

/** 明文是否以任一常见编码出现在字节流里 */
function containsPlaintext(raw: Buffer, plaintext: string): boolean {
  const forms = [
    Buffer.from(plaintext, 'utf8'),
    Buffer.from(Buffer.from(plaintext, 'utf8').toString('base64'), 'utf8'),
    Buffer.from(Buffer.from(plaintext, 'utf8').toString('hex'), 'utf8'),
  ];
  return forms.some((f) => f.length > 0 && raw.includes(f));
}

describe('MASTER_KEY 解析（硬约束：缺/错长度必须拒绝启动）', () => {
  it('缺失、空串、长度不对一律抛 MASTER_KEY_INVALID', () => {
    for (const bad of [undefined, null, '', '   ', 'abc', '00'.repeat(31), '00'.repeat(33)]) {
      expect(() => parseMasterKey(bad), `输入 ${JSON.stringify(bad)} 应被拒绝`).toThrow(CryptoConfigError);
    }
  });

  it('接受 32 字节的 hex 与 base64 两种表达，且解出同一把 key', () => {
    const hex = '0f'.repeat(32);
    const b64 = Buffer.from(hex, 'hex').toString('base64');
    expect(parseMasterKey(hex).equals(MASTER_KEY)).toBe(true);
    expect(parseMasterKey(b64).equals(MASTER_KEY)).toBe(true);
  });

  it('错误信息不回显密钥内容', () => {
    const nearMiss = 'ab'.repeat(31);
    try {
      parseMasterKey(nearMiss);
      throw new Error('应当抛错');
    } catch (err) {
      expect((err as Error).message).not.toContain(nearMiss);
    }
  });

  it('loadMasterKeyFromEnv 读 env.MASTER_KEY', () => {
    expect(loadMasterKeyFromEnv({ MASTER_KEY: '0f'.repeat(32) }).equals(MASTER_KEY)).toBe(true);
    expect(() => loadMasterKeyFromEnv({})).toThrow(CryptoConfigError);
  });
});

describe('aes-256-gcm 往返与抗篡改', () => {
  it('往返一致，且同明文两次密文不同（随机 iv）', () => {
    const pt = fakeUpstreamKey();
    const a = encryptSecret(pt, MASTER_KEY);
    const b = encryptSecret(pt, MASTER_KEY);
    expect(a.equals(b)).toBe(false);
    expect(decryptSecret(a, MASTER_KEY)).toBe(pt);
    expect(decryptSecret(b, MASTER_KEY)).toBe(pt);
  });

  it('密文里不含明文，长度只多出头部 29 字节', () => {
    const pt = fakeUpstreamKey();
    const blob = encryptSecret(pt, MASTER_KEY);
    expect(blob.includes(Buffer.from(pt, 'utf8'))).toBe(false);
    expect(blob.length).toBe(Buffer.byteLength(pt, 'utf8') + 1 + 12 + 16);
  });

  it('改一个 bit 就解不开（GCM 认证），换 key 也解不开', () => {
    const blob = encryptSecret(fakeUpstreamKey(), MASTER_KEY);
    const tampered = Buffer.from(blob);
    const last = tampered.length - 1;
    // 用 readUInt8/writeUInt8 而不是索引赋值：noUncheckedIndexedAccess 下 `buf[i]` 是 number|undefined
    tampered.writeUInt8((tampered.readUInt8(last) ^ 0x01) & 0xff, last);
    expect(() => decryptSecret(tampered, MASTER_KEY)).toThrow();

    const otherKey = Buffer.from('1a'.repeat(32), 'hex');
    expect(() => decryptSecret(blob, otherKey)).toThrow();
  });

  it('版本字节不对、长度过短都拒绝', () => {
    const blob = encryptSecret('x', MASTER_KEY);
    const wrongVersion = Buffer.from(blob);
    wrongVersion.writeUInt8(99, 0);
    expect(() => decryptSecret(wrongVersion, MASTER_KEY)).toThrow(/版本/);
    expect(() => decryptSecret(Buffer.alloc(10), MASTER_KEY)).toThrow(/长度/);
  });

  it('masterKey 长度非法直接拒绝', () => {
    expect(() => encryptSecret('x', Buffer.alloc(16))).toThrow(CryptoConfigError);
    expect(() => decryptSecret(Buffer.alloc(64), Buffer.alloc(16))).toThrow(CryptoConfigError);
  });
});

describe('掩码与摘要', () => {
  it('掩码只留后 4 位', () => {
    const key = fakeUpstreamKey();
    const masked = maskKey(key);
    expect(masked).toBe(`****${key.slice(-4)}`);
    expect(masked).not.toContain(key.slice(0, 8));
  });

  it('短串整串打掉，不暴露后 4 位', () => {
    for (const s of ['', 'abc', 'abcdefg']) expect(maskKey(s)).toBe('****');
  });

  it('sha256Hex 稳定，safeEqualHex 定长比较', () => {
    expect(sha256Hex('gw-key-1')).toBe(sha256Hex('gw-key-1'));
    expect(sha256Hex('gw-key-1')).not.toBe(sha256Hex('gw-key-2'));
    expect(safeEqualHex(sha256Hex('a'), sha256Hex('a'))).toBe(true);
    expect(safeEqualHex(sha256Hex('a'), sha256Hex('b'))).toBe(false);
    expect(safeEqualHex('', '')).toBe(false);
  });
});

describe('落盘断言：真 SQLite 文件的裸字节', () => {
  function writeKeyRow(dbPath: string, blob: Buffer): void {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS upstream_keys (id TEXT PRIMARY KEY, label TEXT NOT NULL, secret BLOB NOT NULL)');
    db.prepare('INSERT INTO upstream_keys (id, label, secret) VALUES (?, ?, ?)').run('key_1', 'probe', blob);
    // 把 WAL 落回主库，确保断言覆盖到两条路径都关掉的情况
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  }

  it('加密后落盘：明文在 db/-wal/-shm 裸字节里一个都找不到', () => {
    const plaintext = fakeUpstreamKey();
    const blob = encryptSecret(plaintext, MASTER_KEY);
    const dbPath = join(tempDir(), 'keys.db');

    writeKeyRow(dbPath, blob);
    const raw = readRawFiles(dbPath);

    // 先证明扫描确实读到了数据区（正向）：密文必须在
    expect(raw.includes(blob)).toBe(true);
    // 再证明明文不在（负向）
    expect(containsPlaintext(raw, plaintext), '明文或其编码出现在 db/-wal/-shm 中').toBe(false);

    // 关库后再取一次：确认不是"只在 WAL 里"造成的假阴性
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT secret FROM upstream_keys WHERE id = ?').get('key_1') as { secret: Buffer };
    db.close();
    expect(decryptSecret(row.secret, MASTER_KEY)).toBe(plaintext);
  });

  it('正对照：同样的字节扫描能抓到未加密落盘（证明上一条不是恒真）', () => {
    const plaintext = fakeUpstreamKey();
    const dbPath = join(tempDir(), 'plain.db');

    writeKeyRow(dbPath, Buffer.from(plaintext, 'utf8'));
    const raw = readRawFiles(dbPath);

    expect(containsPlaintext(raw, plaintext), '正对照失效：扫描抓不到明文').toBe(true);
  });
});
