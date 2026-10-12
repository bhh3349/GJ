/**
 * 「这个上游现在能不能查余额」—— 与后端 `resolveQueryPlan` 同判据的前端只读推导。
 *
 * 为什么要在前端推一遍：手动「查余额」在后端**没有可用查询方式时是当场 422 拒绝**
 * （`assertQueryable`），而不是"发起一个全部跳过的任务"。按钮若照常可点，
 * 用户点了必然看到一个错误 —— 那是把一次注定的失败做成一个功能。
 *
 * 判据（与后端逐条对齐，**不新增**任何前端自创条件）：
 * 1. 模板启用 ⇒ 还要 `url` 与 `parse.balance` 都在，缺一个就是"启用了但残缺"，
 *    后端退回 none（**不会**悄悄改用内置来源），所以这里同样判为不可查。
 * 2. 模板未启用 ⇒ 只有命中内置余额来源才可查。
 * 3. 两者都没有 ⇒ 不可查。
 *
 * 注意 `balancePreset.effective`：它为 `false` 只说明"当前生效的是用户模板"，
 * 而模板那条路是否完整由第 1 条判，不参与这里的判定。
 */
import type { Upstream } from '@/api/types';

export interface BalanceReadiness {
  /** `false` = 现在点「查余额」会被当场拒绝，按钮不该给一次注定的失败。 */
  queryable: boolean;
  /** 不可查时给人看的一句话（可作 action 指向配置入口）。 */
  reason: string | null;
}

export function balanceReadiness(row: Pick<Upstream, 'balanceQuery' | 'balancePreset'>): BalanceReadiness {
  const template = row.balanceQuery;
  if (template?.enabled) {
    const complete = template.url !== null && template.parse?.balance !== null && template.parse?.balance !== '';
    return complete
      ? { queryable: true, reason: null }
      : {
          queryable: false,
          reason: '余额查询模板已启用但没填完整（需要请求地址与余额取值路径），先补全再查。',
        };
  }
  if (row.balancePreset) {
    return { queryable: true, reason: null };
  }
  return {
    queryable: false,
    reason: '这个上游还没有可用的余额查询方式（既没启用模板，也没命中内置来源），现在查会直接被拒绝。要查余额请先在「编辑」里配置余额查询模板。',
  };
}
