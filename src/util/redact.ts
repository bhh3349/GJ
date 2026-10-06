// 事件 message 的净化（契约 §12.1「落盘前脱敏」/ ADR-0013 §5）。
//
// 与 `src/balance/raw.ts` 的 scrubText 的区别，也是本文件存在的理由：
//   那边手里有**明文 key**（是本次请求刚解出来的），所以能做"精确替换"。
//   事件侧不保证拿得到明文 —— 池为空、密文损坏、上游 401 这些路径上，
//   手里根本没有 secret 可比对，而 `message` 里恰恰最可能夹带上游回显的凭据。
//   所以这里**按形状抹**：认得出是凭据的一律替换，认不出的一律保留（不误伤归因信息）。
//
// 落盘纪律：本函数是 gateway_error_events.message 与 error-event sink 的唯一入口，
// 任何绕过它写库的路径都视为违规。

/** message 落盘前的字符上限（契约 §12.1）。超出部分截断，保留前半段归因线索。 */
export const MAX_MESSAGE_CHARS = 512;

/** 掩码串。与 raw.ts 同形，一眼可辨"这里被抹过"，不会被误当成真实字段值。 */
const MASK = '****';

/**
 * 凭据形状表。每条都是"抹掉捕获组 2（或整段）"。
 *
 * 只认**有把握**的形状：宁可漏抹一个不认识的凭据形状（那是靠 payload 构造方式兜住的事），
 * 也不要把普通文本抹成 `****` —— 过度脱敏会把 message 变成一串无信息量的星号，
 * 而"归因信息还在不在"正是这个字段存在的意义。
 */
const CREDENTIAL_PATTERNS: readonly { re: RegExp; to: string }[] = [
  // Authorization: Bearer <token> —— 最常见的回显形式
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: `Bearer ${MASK}` },
  // 各家接口 key 前缀。`sk-` 系与 `gw-`（我们自己签发的网关 key）都要抹：
  // 上游把请求头原样回显时，两边的凭据都可能出现。
  { re: /\b(?:sk-(?:ant-|or-v1-)?|gw-)[A-Za-z0-9_\-]{8,}/gi, to: MASK },
  // 报错模板里的 "api_key=xxx" / "x-api-key: xxx" / "token": "xxx" 一类。
  // 用 `$1` 保留字段名：抹掉之后仍要看得出"这里原本是个什么字段"。
  {
    re: /((?:api[_-]?key|x[_-]api[_-]key|access[_-]?token|auth[_-]?token|secret|password)["'\s]*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/gi,
    to: `$1${MASK}`,
  },
];

/**
 * 按形状抹掉可能夹带的凭据。**不做截断**（截断见 `scrubMessage`）：
 * 两件事分开，是为了能在别处只做脱敏而不改变长度。
 */
export function scrubCredentials(text: string): string {
  let out = text;
  for (const { re, to } of CREDENTIAL_PATTERNS) {
    // 带 /g 的正则是有状态的，跨调用复用必须先复位 lastIndex
    re.lastIndex = 0;
    out = out.replace(re, to);
  }
  return out;
}

/**
 * `message` 的完整落盘形态：**先抹再截**。
 *
 * 顺序不可反：先截后抹会留下一个"恰好把凭据切成两半"的尾巴，
 * 那一半仍然有信息量（前缀能认出是哪家 key）。先抹再截，截断点之后的残串已经被换成 `****`。
 *
 * 空串按 `null` 返回 —— 事件表里 `NULL` 表示"没有归因信息"，
 * 存一个空串会让查询面出现两种等价的"空"，消费方得同时处理。
 */
export function scrubMessage(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;

  // 换行与控制字符压成单空格：message 是一行归因摘要，不是多行堆栈。
  // 不压的话，前端表格里会出现撑破布局的长文本，而 JSON 里是一串 \n。
  const flat = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (flat === '') return null;

  const scrubbed = scrubCredentials(flat);
  if (scrubbed.length <= MAX_MESSAGE_CHARS) return scrubbed;
  // 截断标记是 `…` 而不是 `...`：与 raw.ts 的截断标记同形，
  // 且占 1 字符 —— 512 的预算里塞得下，不用为了标记再减一位。
  return `${scrubbed.slice(0, MAX_MESSAGE_CHARS - 1)}…`;
}

/**
 * key 掩码的**兜底**取值。
 *
 * 正常路径上事件里的 `keyMasked` 由 store.maskOf(keyId) 给出（一致性最好）。
 * 但事件可能在"store 已经关闭"或"kID 不在快照里"时产生，此时宁可写 `****` 也不写 `null`：
 * `null` 的语义是"这次失败与某把具体 key 无关"（如鉴权前就被拒），
 * 而 `****` 是"有关系但不知道是哪把"。两者混同会让按 key 聚合的排障结论出错。
 */
export function fallbackMask(): string {
  return MASK;
}
