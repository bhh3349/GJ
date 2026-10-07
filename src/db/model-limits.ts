// `upstream_keys.model_limits` 的编解码 —— 契约 §15.7（落库）/ §16.3（读取）。
//
// 为什么单独一个文件：**同一个列有两个读方、一个写方** ——
//   写：`db/repo/keys.ts` 的 `createKey`（§15.2 批量建 key 从这里入池）；
//   读：管理面 `db/repo/keys.ts` → `KeyDto.models`（§3）；
//   读：网关 `wiring/store.ts` → `KeyConfig.models` → `matchesModel()`（§16.3）。
// 三处必须**逐字同口径**。若各存一份解析，"页面上白名单看得见、网关上不生效" 这类
// 分歧不会报任何错、也不会进冷却 —— 正是 §16.3 那句「对不上且无报错」。
// 所以口径只留这一份，两边 import。
//
// 口径（§3 / §16.3，与冻结件 `matchesModel()` 对齐）：
//   - 空值三态归一：`null` / `''` / 纯空白 一律 ⇒ `null`；
//   - CSV 去空白、丢空项；`*` 是合法模型名，**原样透出**（不是通配展开）；
//   - `null` 与 `[]` **同义** = 不限模型 —— 故出口恒不出现 `[]`，
//     契约不制造一个 `matchesModel()` 实现不了的三态。

/**
 * 落库归一化（写侧，§15.7）：`[]` / 省略 / 全空白 ⇒ `null`，**不落 `''`**。
 *
 * 库里只允许「`NULL` = 不限」一个语义值。`''` 与 `NULL` 表达同一件事时，
 * 早晚有人写出只判其中一个的查询。
 */
export function serializeModelLimits(models: readonly string[] | null | undefined): string | null {
  if (models === null || models === undefined) return null;
  const items = models.map((m) => m.trim()).filter((m) => m !== '');
  return items.length === 0 ? null : items.join(',');
}

/**
 * 读取解析（读侧，§16.3）：`null` / `''` / 纯空白 ⇒ `null`（= 不限模型）。
 *
 * 回 `null` 而不是 `[]`：两者同义，出口固定成一种形态，调用方就不必判两次。
 */
export function parseModelLimits(csv: string | null): string[] | null {
  if (csv === null) return null;
  const items = csv.split(',').map((m) => m.trim()).filter((m) => m !== '');
  return items.length === 0 ? null : items;
}
