// 复用的 JSON Schema 片段。
//
// 把校验前置到 Fastify 的 schema 层（而不是在 handler 里手写 if）有两个收益：
//   1. 400 的 `details.field` 由框架统一给出（见 app.ts 的 validationField），
//      不需要每个路由自己拼"字段名 + 错误信息"这种容易写歪的字符串；
//   2. handler 里读到的已经是**转换并补过默认值**的值，page/pageSize 不必再兜底。
//
// `additionalProperties` 一律**不写 false**：Fastify 默认开着 ajv 的
// removeAdditional，写 false 会让多余字段被静默裁掉 —— 前端多发一个字段却
// 毫无反馈，是最难查的一类问题。未知字段忽略掉就好。

/** 契约 §0.3：page 从 1 起，pageSize 默认 20、上限 200（超限 400 INVALID_PARAM）。 */
export const pageProps = {
  page: { type: 'integer', minimum: 1, default: 1 },
  pageSize: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
} as const;

export const includeDeletedProp = { type: 'boolean', default: false } as const;

/** 路径参数 :id */
export const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
  additionalProperties: true,
} as const;

/** 乐观锁版本号。契约 §0.2：写请求必须带 revision。 */
export const revisionProp = { type: 'integer', minimum: 1 } as const;

/** 可空整数的写法（JSON Schema 里必须显式列出 null，否则 null 会被判为类型不符）。 */
export const nullableInteger = { type: ['integer', 'null'] } as const;
export const nullableString = { type: ['string', 'null'] } as const;

// 这里曾有一个 `pageQuery`（把 pageProps 包成 object 的导出），**全仓零引用**，已删
// （2026-10-16 清死代码）。删它的理由不是重复 —— 是它是个**没被用过的半成品**：
// 真正的分页 querystring 全在路由里就地展开（`...pageProps` 再加各自的筛选位），
// 一个没人引用的包装件会让人以为"分页校验有第二种写法"，从而在新路由里引它、
// 于是同一个 querystring 出现两条构造路径。
