// 账号凭据的**封装**侧（契约 §15.9）。与 `db/repo/supplier-accounts.ts` 里的
// `readSupplierCredential` / `parseCredentialBlob` 正好是一对：那边拆、这边封。
//
// ## 为什么真值 `identifier` 要跟密码存在一起
//
// 重登要用**真值**手机号调 `/api/user/login`（§15.9），而库里按纪律只存
// `identifier`（**掩码**）+ `identifier_hash`（sha256）—— 两者都推不回真值。
// 于是真值必须有第二个落点，而它只能落在**密文里**：
//
//   · 落到 `identifier` 那一列 → 违反 §15.1「真值不出后端 / 列表直接展示的必须是掩码」；
//   · 加一列明文的 `identifier_raw` → 一个聚光灯下的明文个人标识符列，比掩码那列还糟；
//   · 只存哈希、重登时向操作员再问一次 → 把"自动重登"（§15.9 主动行）整个抹掉。
//
// 所以它进密码密文：**只有密码型账号才需要它**（会话型无从重登，本来就不需要真值），
// 而密码型恰好是唯一一种"本来就要存一个秘密"的账号 —— 真值搭它的车，不额外暴露面。
// 载荷形状是 JSON（`{secret, identifier, tfUser}`），由 `parseCredentialBlob` 解。
//
// ## 一条不变量
//
// **明文只在本文件的函数参数里出现，返回前已经加密。** 没有任何函数返回明文凭据。

import { encryptSecret } from '../db/crypto.js';

/**
 * 密码型凭据密文：`{secret: 密码, identifier: 归一化真值}`。
 *
 * 真值一并封在这里，理由见文件头。**不要**把它拆成"密码归密码、真值归掩码列"。
 */
export function encodePasswordBlob(identifier: string, password: string, masterKey: Buffer): Buffer {
  return encryptSecret(JSON.stringify({ secret: password, identifier }), masterKey);
}

/**
 * 会话型凭据密文：`{secret: session, tfUser}`。
 *
 * `TF-User` 必须一起封 —— §15.9 把它和 `session` 写成**一次登录的两个产物**
 * （"换一枚新 `session`（+ `TF-User`）"）。只存 session 而丢掉 `TF-User`，
 * 下一次带凭据的请求就会缺一个头，症状是"重登成功了但请求还是 401"。
 */
export function encodeSessionBlob(
  session: string,
  tfUser: string | null,
  masterKey: Buffer,
): Buffer {
  return encryptSecret(JSON.stringify({ secret: session, tfUser }), masterKey);
}

/**
 * 凭据擦除的**统一入口**：调用方把手里所有明文秘密交给它，得到一个可安全外露的字符串。
 *
 * 只是 `tierflow.ts` 的 `scrubCredentials` 的一个薄封装，存在的理由是**调用点可读性**：
 * 六个端点都写 `scrubCredentials(msg, [cred.session, cred.password])` 的话，
 * 早晚有一处漏掉某一个 —— 而漏掉的那次不会报错，只会把会话明文写进审计或任务 result。
 * 这里把"要擦哪些"收成一个函数，新增一类凭据时改一处。
 */
export { scrubCredentials } from './tierflow.js';
