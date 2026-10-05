// SQLite 约束错误 → 契约错误码。
//
// 为什么不让唯一约束直接把 SQLITE_CONSTRAINT 抛到 HTTP 层：
//   契约 §0.4 要求重名回 `409 CONFLICT` 且前端据此把对应表单栏标红。
//   把 driver 的原始错误暴露出去，前端只能显示"操作失败"，无从定位是哪个字段。
//   `details.field` 就是给这个用的。
//
// 做法是"先试后译"而不是"先查再插"：查了再插在并发下仍有窗口，
// 而唯一索引本身才是唯一可靠的判据。

import { ApiError } from '../../api/errors.js';

export function translateWriteError(err: unknown, uniqueField: string): Error {
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';

  if (code.startsWith('SQLITE_CONSTRAINT')) {
    if (message.includes('UNIQUE')) {
      return new ApiError('CONFLICT', `${uniqueField} 已存在，请换一个`, { field: uniqueField });
    }
    if (message.includes('FOREIGN KEY')) {
      return ApiError.invalidParam(uniqueField, '引用的资源不存在');
    }
    if (message.includes('CHECK')) {
      return ApiError.invalidParam(uniqueField, '取值不在允许范围内');
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}
