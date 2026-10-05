// 上游 key 的落盘加密原语（aes-256-gcm）。
//
// 硬约束：key 明文永不落盘。这里的产物是**唯一**允许进 DB 的形态。
//
// 存储布局（BLOB，单列自描述，不依赖列名/旁表）：
//   ┌────┬──────────┬──────────┬──────────────┐
//   │ v  │   iv     │   tag    │  ciphertext  │
//   │ 1B │   12B    │   16B    │    变长      │
//   └────┴──────────┴──────────┴──────────────┘
// 版本字节前置是为了将来换算法时不至于要全表猜格式。
//
// AAD（附加认证数据）绑定用途，防止把别的场景的密文塞进 key 列还能解出来。
//
// 配套断言见 src/db/crypto.spec.ts —— 会把密文写进真 SQLite 文件，
// 再对 db/-wal/-shm 的**裸字节**做扫描，证明明文确实没落盘。只看"能解密回来"是不够的：
// 密文正确但明文被顺手写进旁路列，那种错只有扫字节才看得见。

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ALGORITHM = 'aes-256-gcm';
export const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 1;

/** AAD：绑定"这是 key 列里的密文"，与将来其他加密用途隔开 */
const AAD = Buffer.from('sub:upstream-key:v1', 'utf8');

export class CryptoConfigError extends Error {
  readonly code = 'MASTER_KEY_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'CryptoConfigError';
  }
}

/**
 * 解析 MASTER_KEY。必须是 **32 字节**，用 hex(64 字符) 或 base64(44 字符) 表达。
 * 缺失或长度不对一律抛错 —— 调用方应在启动时 fail-fast，绝不"降级成不加密"。
 */
export function parseMasterKey(raw: string | undefined | null): Buffer {
  if (raw === undefined || raw === null || raw.trim() === '') {
    throw new CryptoConfigError(
      'MASTER_KEY 未设置。生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  const value = raw.trim();

  let key: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    key = Buffer.from(value, 'hex');
  } else if (/^[A-Za-z0-9+/]{43}=?$/.test(value)) {
    key = Buffer.from(value, 'base64');
  }

  if (!key || key.length !== KEY_BYTES) {
    // 不回显内容，只回长度线索，避免把"接近正确"的密钥写进日志
    const got = key ? `${key.length} 字节` : `无法识别为 hex/base64（长度 ${value.length}）`;
    throw new CryptoConfigError(`MASTER_KEY 必须是 ${KEY_BYTES} 字节（hex 64 字符或 base64 44 字符），实际 ${got}`);
  }
  return key;
}

export function loadMasterKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  return parseMasterKey(env['MASTER_KEY']);
}

/** 明文 → 密文 BLOB。同一明文每次结果都不同（随机 iv），不做确定性加密。 */
export function encryptSecret(plaintext: string, masterKey: Buffer): Buffer {
  if (masterKey.length !== KEY_BYTES) {
    throw new CryptoConfigError(`masterKey 长度必须 ${KEY_BYTES} 字节，实际 ${masterKey.length}`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const out = Buffer.allocUnsafe(1 + IV_BYTES + TAG_BYTES + ct.length);
  out.writeUInt8(VERSION, 0);
  iv.copy(out, 1);
  tag.copy(out, 1 + IV_BYTES);
  ct.copy(out, 1 + IV_BYTES + TAG_BYTES);
  return out;
}

/** 密文 BLOB → 明文。篡改/换 key/串用途都会在 GCM 校验上炸，不会静默返回垃圾。 */
export function decryptSecret(blob: Buffer, masterKey: Buffer): string {
  if (masterKey.length !== KEY_BYTES) {
    throw new CryptoConfigError(`masterKey 长度必须 ${KEY_BYTES} 字节，实际 ${masterKey.length}`);
  }
  const min = 1 + IV_BYTES + TAG_BYTES;
  if (blob.length < min) {
    throw new Error(`密文长度 ${blob.length} 小于最小 ${min}，格式不合法`);
  }
  const version = blob.readUInt8(0);
  if (version !== VERSION) {
    throw new Error(`不支持的密文版本 ${version}`);
  }

  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, min);
  const ct = blob.subarray(min);

  const decipher = createDecipheriv(ALGORITHM, masterKey, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * 掩码：`****` + 后 4 位。这是 key 在响应/日志里的**唯一**出口形态。
 * 长度不足 8 时整串打掉 —— 短串的"后 4 位"本身就已经泄漏了大半。
 */
export function maskKey(plaintext: string): string {
  const s = plaintext.trim();
  if (s.length < 8) return '****';
  return `****${s.slice(-4)}`;
}

/** 网关 key 的落盘形态：只存 sha256 摘要，明文只在签发响应里出现一次。 */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 定长摘要比较，避免计时侧信道 */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}
