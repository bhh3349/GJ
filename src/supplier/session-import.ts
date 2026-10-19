// §15.9 会话型凭据的**离线一次性导入**（非 HTTP 面）。
//
// ## 为什么是一个模块 + 一个脚本，而不是一个端点
//
// 会话值（`tr_session` / TierFlow 的 `session`）等价于"已经登录的浏览器"。它一旦有
// HTTP 入口，浏览器、代理日志、前端 `localStorage` 就都成了明文的过路点 —— 而这条路径
// 本来只需要操作员在本机跑一次。所以契约把入口定死为**离线**：脚本 + 运行时环境变量，
// 值不进仓库、不进日志、不进聊天（§15.9 纪律 1/2）。
//
// ## 这个模块负责什么
//
// 只负责"把一枚已经拿到的会话写进库"：归一化标识 → 掩码 / 摘要 → 排除名单 → 建行或
// **覆写**既有行的 `encrypted_session`。**不发任何上游请求**（因此离线可用、失败面只有
// 本机），也**绝不回显**会话值。验活是它之后的一次 `refresh` 的事 —— 导入只回答
// "这枚会话已经落库了"，不回答"它还活着吗"（后者要打上游，属于另一个动作）。
//
// TR 的定位：这家**只有**会话鉴权（§15.14.1「密码登录 ❌」），所以本模块不是它的
// "冷备通路"，而是它**唯一**的入池通路。

import { sha256Hex } from '../db/crypto.js';
import { newId } from '../db/ids.js';
import { getUpstreamRow } from '../db/repo/upstreams.js';
import {
  createSupplierAccount,
  findSupplierAccountByIdentifier,
  findSupplierAccountByIdentifierHash,
  findSupplierAccountByUid,
  updateSupplierAccount,
} from '../db/repo/supplier-accounts.js';
import type { Db } from '../db/database.js';
import { encodeSessionBlob } from './credentials.js';
import { isExcluded, maskIdentifier, normalizeIdentifier } from './identifiers.js';

/** 一次导入需要的最小信息。`identifier` 是**真值**（手机号 / 邮箱），只在本次调用内出现。 */
export interface ImportSessionInput {
  upstreamId: string;
  identifier: string;
  /** 会话值本身（Cookie 的 value，不含 `name=`）。 */
  session: string;
  /** TierFlow 的 `TF-User`；TokenRhythm 没有这个头，传 `null`。 */
  tfUser?: string | null;
  /** 权威信息：能顺手拿到就记下，拿不到留 `null`，由后续 refresh 回填。 */
  username?: string | null;
  uid?: string | null;
  /** §15.9 排除名单（归一化后的真值集合）。命中即拒绝，不写任何行。 */
  excluded?: ReadonlySet<string> | undefined;
  /** 会话预计到期时刻（ISO）。没有依据就别猜 —— 留 `null` 表示"未知"。 */
  sessionExpiresAt?: string | null | undefined;
}

export type ImportSessionFailure =
  | 'upstream_not_found'
  | 'not_supplier_upstream'
  | 'identifier_invalid'
  | 'excluded'
  | 'session_empty';

export type ImportSessionResult =
  | {
      ok: true;
      accountId: string;
      /** 掩码 —— 与列表页展示的是同一形态。 */
      identifier: string;
      /** `true` = 新建行；`false` = 覆写了既有行的会话（§15.9「两路汇入同一行」）。 */
      created: boolean;
    }
  | { ok: false; reason: ImportSessionFailure; message: string };

/**
 * 写一枚会话。**幂等按 `(upstreamId, identifierHash)` 判**：同一账号重复导入只覆写
 * `encrypted_session`，不会长出第二行（§15.9「一个账号只有一行」）。
 *
 * 失败一律**不抛**：脚本要把原因打成一行给人看，调用方也不该为了一个可预期的输入问题
 * 去接异常。真正的环境故障（密钥长度不对、磁盘写失败）仍然照常抛出 —— 那不是"输入问题"。
 */
export function importSupplierSession(
  db: Db,
  masterKey: Buffer,
  input: ImportSessionInput,
): ImportSessionResult {
  const upstream = getUpstreamRow(db, input.upstreamId);
  if (upstream === null) {
    return { ok: false, reason: 'upstream_not_found', message: `上游 ${input.upstreamId} 不存在` };
  }
  const supplier = upstream.supplier;
  if (supplier === null || supplier === '') {
    return {
      ok: false,
      reason: 'not_supplier_upstream',
      message: `上游 ${input.upstreamId} 不是供应商账号型（supplier 为空），不能导入会话`,
    };
  }

  const session = input.session.trim();
  if (session === '') {
    return { ok: false, reason: 'session_empty', message: '会话值为空（Cookie 的 value 部分不能为空）' };
  }

  const normalized = normalizeIdentifier(input.identifier);
  if (normalized === null) {
    return {
      ok: false,
      reason: 'identifier_invalid',
      message: '标识无法归一化（手机号 / 邮箱）—— 拒绝写入，避免出现"有会话但认不出是谁"的行',
    };
  }
  // 掩码收不出的输入**不退化存原文**（同 `maskIdentifier` 的纪律）。
  const masked = maskIdentifier(normalized);
  if (masked === null) {
    return {
      ok: false,
      reason: 'identifier_invalid',
      message: '标识短到无法掩码（手机号至少 7 位 / 邮箱要有域名）—— 拒绝写入，绝不落原文',
    };
  }

  if (input.excluded !== undefined && isExcluded(normalized, input.excluded)) {
    return {
      ok: false,
      reason: 'excluded',
      message: '该账号在排除名单里，本次未写入，也未做任何上游请求',
    };
  }

  const identifierHash = sha256Hex(normalized);
  // 会话值不返回、不拼接进任何 message；只有密文进库。
  const encryptedSession = encodeSessionBlob(session, input.tfUser ?? null, masterKey);
  const existing = findSupplierAccountByIdentifierHash(db, input.upstreamId, identifierHash);

  if (existing !== null) {
    updateSupplierAccount(db, existing.id, {
      encryptedSession,
      // 会话刚换过，旧的失败原因不再成立；但**有效性尚未验证**，所以是 `unknown`
      // 而不是 `active`（状态位是给"验过没有"用的，不是给"刚导入了"用的）。
      status: 'unknown',
      statusMessage: null,
      ...(input.sessionExpiresAt === undefined ? {} : { sessionExpiresAt: input.sessionExpiresAt }),
      ...(input.username === undefined || input.username === null ? {} : { username: input.username }),
      ...(input.uid === undefined || input.uid === null ? {} : { uid: input.uid }),
    });
    return { ok: true, accountId: existing.id, identifier: masked, created: false };
  }

  const accountId = newId('supplierAccount');
  createSupplierAccount(db, accountId, {
    upstreamId: input.upstreamId,
    supplier,
    identifier: masked,
    identifierHash,
    status: 'unknown',
    encryptedSession,
    sessionExpiresAt: input.sessionExpiresAt ?? null,
    username: input.username ?? null,
    uid: input.uid ?? null,
  });
  return { ok: true, accountId, identifier: masked, created: true };
}

// ---------------------------------------------------------------------------
// cookie-only 通路（v1.16.3）
// ---------------------------------------------------------------------------

/**
 * 身份已由上游解析后的导入输入。与 `ImportSessionInput` 的差别只有一处：
 * **标识是上游给的掩码，不是本地真值** —— 因此不能在这里再归一化/掩码，
 * 也不能用 `sha256(真值)` 判重。
 *
 * `identifierHash` 由调用方按上游 uid 派生（`sha256('tokenrhythm:uid:<id>')`）。
 * 它只在"同一上游内判重"这个用途上等价于原来的真值摘要；**不是**手机号/邮箱的摘要，
 * 不能拿去和真值摘要互比。判重顺序见下：uid → 掩码 → 摘要，前两者覆盖了
 * "既有行来自真值导入、uid 已回填或尚未回填"的两种情况。
 */
export interface ImportResolvedSessionInput {
  upstreamId: string;
  /** 上游返回并已确认是掩码形态的展示值（`phoneMasked` / `emailMasked`）。 */
  identifier: string;
  /** `sha256('tokenrhythm:uid:<uid>')`，64 位小写十六进制。 */
  identifierHash: string;
  session: string;
  tfUser?: string | null;
  username?: string | null;
  uid?: string | null;
  sessionExpiresAt?: string | null | undefined;
}

/**
 * 写入一枚**身份已知**的会话。与 `importSupplierSession` 共用同一张表与同一条不变量，
 * 但判重不依赖真值摘要：
 *
 *   1. `(upstreamId, uid)` —— cookie-only 行自身、以及任何 refresh 过的行都能命中；
 *   2. `(upstreamId, identifier 掩码)` —— 兜住"按真值导入过、uid 还没回填"的行；
 *   3. `(upstreamId, identifierHash)` —— 兜住同一通路在 uid 缺失时的重放。
 *
 * 命中既有行只覆写会话与权威信息，**不改**它的 `identifier` / `identifier_hash`：
 * 那一行当初是按什么身份建的，就让它继续按那个身份存在；改摘要会让它和
 * 密码通路/真值通路失去对应关系。
 *
 * 本函数**不发上游请求**。身份解析是调用方（`session-resolve.ts`）的事，
 * 这样"写库"与"验活/解析"的失败面仍然分开。
 */
export function importResolvedSupplierSession(
  db: Db,
  masterKey: Buffer,
  input: ImportResolvedSessionInput,
): ImportSessionResult {
  const upstream = getUpstreamRow(db, input.upstreamId);
  if (upstream === null) {
    return { ok: false, reason: 'upstream_not_found', message: `上游 ${input.upstreamId} 不存在` };
  }
  const supplier = upstream.supplier;
  if (supplier === null || supplier === '') {
    return {
      ok: false,
      reason: 'not_supplier_upstream',
      message: `上游 ${input.upstreamId} 不是供应商账号型（supplier 为空），不能导入会话`,
    };
  }

  const session = input.session.trim();
  if (session === '') {
    return { ok: false, reason: 'session_empty', message: '会话值为空（Cookie 的 value 部分不能为空）' };
  }

  const masked = input.identifier.trim();
  // 只收掩码形态：调用方若误把真值传进来，这里要拒绝，而不是把真值落进展示列。
  if (masked === '' || !masked.includes('*')) {
    return {
      ok: false,
      reason: 'identifier_invalid',
      message: '身份解析结果不是掩码形态 —— 拒绝写入（展示列不能落真值）',
    };
  }
  if (!/^[0-9a-f]{64}$/.test(input.identifierHash)) {
    return {
      ok: false,
      reason: 'identifier_invalid',
      message: '身份摘要形态不合法（需要 64 位小写十六进制）',
    };
  }

  const encryptedSession = encodeSessionBlob(session, input.tfUser ?? null, masterKey);
  const uid = input.uid === undefined || input.uid === null || input.uid === '' ? null : input.uid;
  const existing =
    (uid === null ? null : findSupplierAccountByUid(db, input.upstreamId, uid)) ??
    findSupplierAccountByIdentifier(db, input.upstreamId, masked) ??
    findSupplierAccountByIdentifierHash(db, input.upstreamId, input.identifierHash);

  if (existing !== null) {
    updateSupplierAccount(db, existing.id, {
      encryptedSession,
      status: 'unknown',
      statusMessage: null,
      ...(input.sessionExpiresAt === undefined ? {} : { sessionExpiresAt: input.sessionExpiresAt }),
      ...(input.username === undefined || input.username === null ? {} : { username: input.username }),
      ...(uid === null ? {} : { uid }),
    });
    return { ok: true, accountId: existing.id, identifier: existing.identifier, created: false };
  }

  const accountId = newId('supplierAccount');
  createSupplierAccount(db, accountId, {
    upstreamId: input.upstreamId,
    supplier,
    identifier: masked,
    identifierHash: input.identifierHash,
    status: 'unknown',
    encryptedSession,
    sessionExpiresAt: input.sessionExpiresAt ?? null,
    username: input.username ?? null,
    uid,
  });
  return { ok: true, accountId, identifier: masked, created: true };
}
