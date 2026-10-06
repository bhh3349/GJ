// 自测响应里"上游原文"的净化（契约 §2 BalanceTestResult.raw / ADR-0012 §3 安全条）。
//
// 两条硬要求，缺一不可：
//   1. **抹掉明文 key 的所有出现** —— 上游偶尔会把 key 回显在报错体里
//      （"invalid api key sk-xxx"），原样转发等于把明文从服务端搬到浏览器。
//      替换结果不落盘、不进日志、不进审计 detail，只出现在这一次响应里。
//   2. **截断至 8KB** —— 上游返回一坨几 MB 的东西时，不截断会把管理面响应撑爆，
//      前端也得渲染一个巨长的 pre。
//
// 截断方式刻意选"递归按预算裁结构"而不是"切字符串"：
// 切字符串会让 raw 从 JSON 变成半截文本（前端 JSON.stringify 后是一串转义乱码，
// 没法看），而按预算裁掉多余的数组元素/对象键，得到的仍是一份**合法且可读**的
// JSON，用户照样能看出"该填哪条取值路径"—— 这正是 raw 存在的唯一理由。

/** 净化后 raw 的字符预算。契约写的是 8KB，这里按字符算（UTF-8 下中文 1 字符 3 字节，
 *  所以实际字节数可能略超；对"别把响应撑爆"这个目的来说，量级正确即可）。 */
export const MAX_RAW_CHARS = 8192;

/** 掩码串。写成常量是为了让它**看起来就不像数据**，不会被误当成真实字段值。 */
const MASK = '****';

interface Budget {
  left: number;
}

function scrubText(text: string, secret: string): string {
  return secret === '' ? text : text.split(secret).join(MASK);
}

/**
 * 把上游响应体净化成可安全外露的形态。
 *
 * `secret` 为明文 key；`''` 表示调用方拿不到明文（此时只做截断）。
 * 返回的是一个**新的** JSON 值，不修改入参。
 */
export function sanitizeUpstreamBody(body: unknown, secret: string): unknown {
  return trim(body, secret, { left: MAX_RAW_CHARS });
}

function trim(value: unknown, secret: string, budget: Budget): unknown {
  if (budget.left <= 0) return null;

  if (typeof value === 'string') {
    const scrubbed = scrubText(value, secret);
    if (scrubbed.length <= budget.left) {
      budget.left -= scrubbed.length;
      return scrubbed;
    }
    const cut = `${scrubbed.slice(0, Math.max(0, budget.left - 1))}…`;
    budget.left = 0;
    return cut;
  }

  if (value === null || value === undefined) return null;

  if (typeof value === 'number' || typeof value === 'boolean') {
    budget.left -= 8;
    return value;
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      // 预算见底就**停止添加**，而不是塞一个占位元素：数组短了是"截断"，
      // 塞占位元素是"造假数据"，后者违背整个项目的禁假数据纪律。
      if (budget.left <= 0) break;
      out.push(trim(item, secret, budget));
    }
    return out;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (budget.left <= 0) break;
      // 键名也要过一遍：上游把 key 当字段名回显虽然罕见，但不是不可能
      const safeKey = scrubText(key, secret);
      budget.left -= safeKey.length + 4;
      out[safeKey] = trim(item, secret, budget);
    }
    return out;
  }

  // JSON.parse 的产物里不会出现这些类型，兜底转成字符串而不是丢掉键
  budget.left -= 8;
  return String(value);
}
