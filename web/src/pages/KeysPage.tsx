/**
 * Key 管理 —— 列表、分类标签、余额显示、启用/禁用/删除（多选批量）。
 *
 * 契约纪律：
 * - 列表只出现 `maskedKey`（后 4 位），页面**没有任何**展示明文的路径。
 * - `health` 是网关运行态：这里只读展示，可写的只有 `enabled`。
 * - 所有写请求带 `revision`（乐观锁）；不符则 409 REVISION_MISMATCH，页面提示并拉最新。
 * - 余额实时性走验收 3：WS `balance` 帧到达即覆盖该行，不等列表重拉。
 * - 「全量查余额」是**最大的一批**（扫全部上游、每把被查到的 key 一次请求），出口预算与数据面共用
 *   同一条（§16.7 Tier 1.5）⇒ §14.7 二次确认，走 `confirmManualRefresh`，本页不自造请求数。
 *   单把 key 的刷新**刻意不弹**：一次请求，"批"的代价量级不成立，且同一个动作问两遍会让人盲点「确定」。
 * - v1.18.0：`account` / `tokenPlan.totalTokens` / `remainingTokens` 的 null 语义上首页 ——
 *   「未同步」与「0」是两句话，见 `TokenPlanCell`。套餐余量的回填腿 v1.22.0 起有**两条**：
 *   账号池 `refresh`（「刷新余额」，顺带回填余量与掩码）与 §15.2 `keys/sync`（行内/批量
 *   「同步套餐余量」，`ids` = 归属账号）。`keys/sync` 仍是**掩码取不到时的兜底** —— 上游
 *   那个待实测端点没回数据时，刷新补不了掩码，「未同步」会一直挂着，只能靠它补（ADR-0047）。
 *   任务进度与逐行结论复用 `useTaskPolling` + `SupplierBatchDrawer`，不自造轮询。
 * - 账号型上游（tierflow / tokenrhythm）的 key **没有 key 级余额查询**（契约 §2 v1.18.1，
 *   后端恒 422）：这类行的「查余额」换成指向账号池的引导入口，见 `balanceReadiness.ts` 的注释。
 * - v1.23.0：`firstUsedAt` = **第一次有真实请求落到它身上**的时刻（不是「首次成功」：上游失败的
 *   尝试不落用量日志，终态成功 / 4xx / 429 / 流式中断都算「用过」）。`null` = 从未被真正用过
 *   （存量 key 的调用日志过保留期也回 null）→ 渲染灰字「未调用」，**不渲染 `—` / `0` / 空串**，
 *   也不拿 `todayTokens` 之类的旁证反推时刻：这一格只回答"用没用过"，不负责猜"什么时候用过"。
 */
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Empty,
  Input,
  Segmented,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { keysApi, supplierAccountsApi, upstreamsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { useTaskPolling } from '@/api/useTaskPolling';
import {
  PAGE_SIZE_DEFAULT,
  asSupplierKind,
  type BalanceRefreshResult,
  type HintCode,
  type KeyCategory,
  type KeyHealth,
  type Upstream,
  type UpstreamKey,
} from '@/api/types';
import { BalanceHint } from '@/components/BalanceHint';
import { BalanceText } from '@/components/BalanceText';
import { balanceReadiness } from '@/utils/balanceReadiness';
import { DepletedTag } from '@/components/DepletedTag';
import { HealthTag, failureReasonLabel } from '@/components/HealthTag';
import { confirmManualRefresh } from '@/components/ManualRefreshConfirm';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { SupplierBatchDrawer } from '@/pages/upstreams/SupplierBatchDrawer';
import { BalanceModal, KeyFormModal } from '@/pages/keys/KeyModals';
import { KeyBalanceSelfTest } from '@/pages/keys/KeyBalanceSelfTest';
import { useLive } from '@/realtime/useLive';
import { tokens } from '@/theme/tokens';
import { formatCents, formatCompact, formatIso, formatRelative, formatTokens, formatTokensShort, formatUntil } from '@/utils/format';

const { Text } = Typography;

interface Filters {
  upstreamId: string | undefined;
  category: KeyCategory | undefined;
  health: KeyHealth | undefined;
  enabled: boolean | undefined;
  /** §20.8 第四轴筛选，与 `enabled` / `health` 并用（三轴正交，见 `DepletedTag`）。 */
  depleted: boolean | undefined;
  q: string;
  includeDeleted: boolean;
}

const EMPTY_FILTERS: Filters = {
  upstreamId: undefined,
  category: undefined,
  health: undefined,
  enabled: undefined,
  depleted: undefined,
  q: '',
  includeDeleted: false,
};

/**
 * 「余额 / 套餐」列的套餐侧（契约 §3 v1.18.0 / v1.22.0）。
 *
 * 三个取值**必须长得不一样**（§0.2「未知 ≠ 0」在这张表上的落点）：
 * - `remainingTokens === null` → 「未同步」徽标：**从未查到过**，不是烧干。tooltip 顺手指明
 *   真相源与兜底路（账号池「刷新余额」会回填；刷新后仍不消 = 掩码没取到 → 「同步套餐余量」补）。
 * - `remainingTokens === 0` → 「0」并给烧干色：查到过、确实没了。与徽标同列出现时一眼可分。
 * - 有值 → `6.2M / 8M`；`totalTokens === null`（无归属 / 撞号 / 上游没给）只给 `6.2M / —`。
 *   两个都 null 时只画「未同步」，不画「— / —」的空壳 —— 那读起来像"两个字段都坏了"，
 *   而事实只是"还没同步"。
 *
 * **第二行 = 钱额度面**（v1.22.0 / ADR-0046）：`¥29.90 · 已用 ¥6.42`。台账里有这一面，
 * 本页此前只有 token 数，业主读成"数据没显示对"。两格**各自透传**（token 未知不拖累金额），
 * 所以「未同步」的行只要台账给了钱额度也照画；两格都 null 才不画这一段。
 * 格子最多两行：到期用 `formatUntil` 的短形（「还剩 29 天」）与钱面同行，精确时刻进 tooltip。
 */
function TokenPlanCell({ row }: { row: UpstreamKey }) {
  const plan = row.tokenPlan;
  if (plan === null) {
    // 契约保证 token-plan 行的 `tokenPlan` 恒为对象（`repo/keys.ts` 读路径按类别再造），
    // 这个分支是防御：真到了说明响应违约，如实说，不编一个 0。
    return <Text type="secondary">套餐信息缺失</Text>;
  }
  const remaining = plan.remainingTokens;
  const total = plan.totalTokens;
  const exhausted = remaining === 0;
  // 钱额度面：`null` = 台账没给出（无归属 / 撞号 / 上游没给），照 §0.2 画「—」不是 0。
  const moneyVisible = plan.amountTotalCents !== null || plan.amountUsedCents !== null;
  const moneyShort = moneyVisible
    ? `${formatCents(plan.amountTotalCents)} · 已用 ${formatCents(plan.amountUsedCents)}`
    : null;
  const moneyTip = moneyVisible
    ? ` · 台账套餐额度 ${formatCents(plan.amountTotalCents)}、已用 ${formatCents(plan.amountUsedCents)}`
    : '';
  const expiryShort = plan.expiresAt ? formatUntil(plan.expiresAt) : '无到期时间';
  const secondLine = [moneyShort, expiryShort].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {remaining === null ? (
        <Tooltip title="这把 key 的套餐余量还没同步过（余量未知 ≠ 0，不是 0）。账号池「刷新余额」会顺带回填余量与掩码，所以正常下一轮刷新后「未同步」自己就消失；刷新过仍是未同步，说明这个账号的 key 掩码还没取到 —— 点一次「同步套餐余量」（本页行内或账号池批量）即可补上">
          <Tag
            bordered={false}
            style={{
              marginInlineEnd: 0,
              alignSelf: 'flex-start',
              background: tokens.tint.warning,
              color: tokens.color.warning,
            }}
          >
            未同步
          </Tag>
        </Tooltip>
      ) : (
        <Tooltip
          title={`${formatTokens(remaining)}${total === null ? '' : ` / ${formatTokens(total)}`}${moneyTip}${plan.expiresAt ? ` · 到期 ${formatIso(plan.expiresAt)}` : ''}`}
        >
          <Text
            style={{
              fontVariantNumeric: 'tabular-nums',
              color: exhausted ? tokens.color.error : undefined,
              fontWeight: exhausted ? 600 : undefined,
            }}
          >
            {formatTokensShort(remaining)}
            <Text type="secondary"> / {formatTokensShort(total)}</Text>
          </Text>
        </Tooltip>
      )}
      <Text type="secondary" style={{ fontSize: 12 }}>
        {secondLine}
      </Text>
    </div>
  );
}

export default function KeysPage() {
  const { message, modal } = App.useApp();
  const { run, isPending } = useAction();
  const live = useLive();
  const navigate = useNavigate();

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UpstreamKey | null>(null);
  const [balanceTarget, setBalanceTarget] = useState<UpstreamKey | null>(null);
  const [testTarget, setTestTarget] = useState<UpstreamKey | null>(null);
  const [refreshHint, setRefreshHint] = useState<{
    hintCode: HintCode;
    hint: string | null;
    retryAfterSeconds: number | null;
  } | null>(null);
  /** 套餐余量同步任务的明细浮层（复用账号池那张 `SupplierBatchDrawer`，不自造第二份逐行表）。 */
  const [planDrawer, setPlanDrawer] = useState<{ open: boolean; title: string }>({
    open: false,
    title: '同步套餐余量',
  });

  const upstreams = useResource(() => upstreamsApi.list({ pageSize: 200 }), []);
  const upstreamName = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of upstreams.data?.items ?? []) map.set(item.id, item.name);
    return map;
  }, [upstreams.data]);

  /**
   * 每把 key 的上游现在能不能查余额。单 key「查余额」在后端无查询方式时是当场 422 拒绝
   * （`assertQueryable`），点了必然报错 —— 所以这里先判一次，把原因说清楚再决定发不发。
   * 上游列表还没到手时判为"不知道"，此时**照常发起**：不拿一个未取到的观测去禁掉用户的动作。
   */
  const readinessByUpstream = useMemo(() => {
    const map = new Map<string, ReturnType<typeof balanceReadiness>>();
    for (const item of upstreams.data?.items ?? []) map.set(item.id, balanceReadiness(item));
    return map;
  }, [upstreams.data]);

  /**
   * 账号型上游（tierflow / tokenrhythm）的 key **没有 key 级余额查询**：后端 `assertQueryable`
   * 对它们恒 422（契约 §2 v1.18.1，Chief 裁决 2026-11-03——那条"第 ③ 档账号型驱动"从未实现，
   * 余额真相源在账号维度）。所以这类行的「查余额」不发请求，换成指向账号池的引导入口；
   * 引导按钮要哪个图标都不需要，只要能跳对页。
   */
  const accountKindByUpstream = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const item of upstreams.data?.items ?? []) map.set(item.id, asSupplierKind(item.supplier) !== null);
    return map;
  }, [upstreams.data]);

  const query = useMemo(
    () => ({
      page,
      pageSize,
      ...(filters.upstreamId ? { upstreamId: filters.upstreamId } : {}),
      ...(filters.category ? { category: filters.category } : {}),
      ...(filters.health ? { health: filters.health } : {}),
      ...(filters.enabled === undefined ? {} : { enabled: filters.enabled }),
      ...(filters.depleted === undefined ? {} : { depleted: filters.depleted }),
      ...(filters.q ? { q: filters.q } : {}),
      ...(filters.includeDeleted ? { includeDeleted: true } : {}),
    }),
    [page, pageSize, filters],
  );
  const queryKey = JSON.stringify(query);

  const list = useResource(() => keysApi.list(JSON.parse(queryKey)), [queryKey]);
  const task = useTaskPolling((finished) => {
    const result = finished.result as BalanceRefreshResult | null;
    setRefreshHint(
      result && result.hintCode
        ? { hintCode: result.hintCode, hint: result.hint, retryAfterSeconds: result.retryAfterSeconds ?? null }
        : null,
    );
    message.success('余额刷新完成');
    list.reload();
  });

  /**
   * 套餐余量同步的轮询：**独立实例**，不复用上面那个。
   * 上面那个的 `onSettled` 认的是 `BalanceRefreshResult`（要取 `hintCode`）并说"余额刷新完成"；
   * 两个任务的 `result` 形状不同（同步是 `SupplierBatchResult`），挤在一个实例里必有一方认错形状。
   */
  const syncTask = useTaskPolling((finished) => {
    list.reload();
    if (finished.status === 'succeeded') {
      message.success('套餐余量同步完成，逐行结论见明细浮层');
    } else {
      message.error('同步任务失败，原因见明细浮层');
    }
  });

  // 验收 3：WS balance 帧到即覆盖该行余额，不等下一次列表拉取。
  const rows = useMemo<UpstreamKey[]>(() => {
    const items = list.data?.items ?? [];
    return items.map((row) => {
      const frame = live.balances[row.id];
      if (!frame) return row;
      return {
        ...row,
        balance: frame.balance,
        balanceUpdatedAt: frame.balanceUpdatedAt,
        balanceSource: frame.balanceSource,
      };
    });
  }, [list.data, live.balances]);

  const patchKey = async (row: UpstreamKey, body: Parameters<typeof keysApi.update>[1], okText: string) => {
    const result = await run(`patch:${row.id}`, () => keysApi.update(row.id, body), okText);
    if (result === null) {
      // 乐观锁冲突：提示已由 useAction 给出，这里补一次强制刷新，避免用户对着旧版本反复提交。
      list.reload();
      return;
    }
    list.reload();
  };

  const removeKey = (row: UpstreamKey) => {
    modal.confirm({
      title: `删除 key ${row.maskedKey}？`,
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        const result = await run(`delete:${row.id}`, () => keysApi.remove(row.id), '已删除');
        if (result !== null) list.reload();
      },
    });
  };

  const refreshOne = async (row: UpstreamKey) => {
    const ready = readinessByUpstream.get(row.upstreamId);
    if (ready && !ready.queryable) {
      message.warning(ready.reason ?? '这把 key 所在的上游现在查不了余额');
      return;
    }
    const result = await run(
      `refresh:${row.id}`,
      () => keysApi.refreshBalance(row.id),
      '已提交余额查询',
    );
    if (result === null) return;
    // 契约对单 key 刷新的响应体未明示是同步回值还是 202 任务；两种都兼容处理。
    if (typeof result === 'object' && result !== null && 'taskId' in result) {
      task.start((result as { taskId: string }).taskId);
    } else {
      list.reload();
    }
  };

  /**
   * 行内「同步套餐余量」：只打**一个**账号（`ids:[account.id]`），一次上游读 + 台账回填。
   * 不弹二次确认 —— 与单把 key「查余额」同一条理由：一次请求，"批"的代价量级不成立；
   * 且这个动作不写 key 明文、不改启用状态（§15.2：只读上游、只写台账）。
   */
  const syncPlanOne = async (row: UpstreamKey) => {
    const account = row.account;
    if (account === null) return;
    const accepted = await run(
      `plansync:${row.id}`,
      () => supplierAccountsApi.syncKeys({ upstreamId: row.upstreamId, ids: [account.id] }),
      '已提交套餐余量同步',
    );
    if (accepted === null) return;
    setPlanDrawer({ open: true, title: `同步套餐余量 · ${account.identifier}` });
    syncTask.start(accepted.taskId);
  };

  /**
   * 勾选 → 按**上游**分组去重出要同步的账号集合。
   *
   * 为什么按上游而不是逐账号打：`keys/sync` 的 `ids` 就是「该上游的账号列表」，一个上游
   * 一次任务即可覆盖它名下全部勾中的账号；逐账号打会得到 N 个任务、N 份逐行明细、N 次
   * 进度浮层 —— 用户点了「批量」却要关 N 次浮层，那不是批量。
   * 没有归属账号的 key 不参与：手工建的 key 没有可同步的订阅（契约 §3 `account` 语义）。
   */
  const planSyncTargets = (ids: string[]) => {
    const groups = new Map<string, { accountIds: string[]; identifiers: string[] }>();
    for (const row of rows) {
      if (!ids.includes(row.id) || row.category !== 'token-plan' || row.account === null) continue;
      const group = groups.get(row.upstreamId) ?? { accountIds: [], identifiers: [] };
      if (!group.accountIds.includes(row.account.id)) {
        group.accountIds.push(row.account.id);
        group.identifiers.push(row.account.identifier);
      }
      groups.set(row.upstreamId, group);
    }
    return groups;
  };

  const batchSyncPlan = (): void => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const groups = planSyncTargets(ids);
    if (groups.size === 0) {
      message.warning('所选 key 里没有归属账号的套餐 key（手工建的 key 没有可同步的套餐）');
      return;
    }
    const accountCount = [...groups.values()].reduce((n, group) => n + group.accountIds.length, 0);
    const preview = [...groups.values()]
      .flatMap((group) => group.identifiers)
      .slice(0, 5)
      .join('、');
    modal.confirm({
      title: `同步 ${accountCount} 个账号的套餐余量？`,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>
            目标账号：{preview}
            {accountCount > 5 ? ' 等' : ''}；按上游分组提交，每个上游一个任务。
          </span>
          <span style={{ color: tokens.color.textSecondary }}>
            只读上游、只写台账：把各账号套餐的剩余量与基础额度回填到名下入池的套餐 key，
            不动 key 明文、不改启用状态。
          </span>
        </div>
      ),
      okText: '提交',
      cancelText: '取消',
      onOk: async () => {
        const taskIds: string[] = [];
        let failed = 0;
        for (const [upstreamId, group] of groups) {
          try {
            const accepted = await supplierAccountsApi.syncKeys({ upstreamId, ids: group.accountIds });
            taskIds.push(accepted.taskId);
          } catch {
            failed += 1;
          }
        }
        if (taskIds.length === 0) {
          message.error('套餐余量同步没有提交成功');
          return;
        }
        setSelectedIds([]);
        setPlanDrawer({ open: true, title: '批量同步套餐余量' });
        syncTask.start(taskIds[taskIds.length - 1]!);
        if (taskIds.length > 1) {
          message.info(
            `已提交 ${taskIds.length} 个任务（按上游分组），明细浮层显示最后一个；各任务到终态后本页同样会刷新`,
          );
        }
        if (failed > 0) message.warning(`${failed} 个上游的任务没提交上`);
      },
    });
  };

  /** 全量刷新 = 扫全部上游、每把被查到的 key 一次请求（§14.7）⇒ 先过一次机会成本。 */  const confirmRefreshAll = (): void => {
    confirmManualRefresh(modal, {
      title: '查全部上游的余额？',
      scope: '打谁：全部上游名下所有配了余额查询方式的 key（没配的跳过）—— 这是跨上游的全量动作',
      onOk: async () => {
        const result = await run(
          'refreshAll',
          () => keysApi.refreshAllBalances(),
          '已提交全量余额刷新任务',
        );
        if (result !== null) task.start(result.taskId);
      },
    });
  };

  const batch = async (action: 'enable' | 'disable') => {
    if (selectedIds.length === 0) return;
    const result = await run(
      `batch:${action}`,
      () => keysApi.batch({ ids: selectedIds, action }),
      action === 'enable' ? '已批量启用' : '已批量禁用',
    );
    if (result === null) return;
    setSelectedIds([]);
    list.reload();
  };

  /**
   * 批量解除透支锁（§20.5）= 清锁 + `enabled=1`，**一个动作**（后端定死，不拆两步）。
   *
   * 必须二次确认，且文案里要有一句会让人停一下的话：「若仍透支会再次锁上」。
   * 这是整页唯一一个"看起来像普通启用、但会改变资金判定状态"的按钮 —— 用户以为
   * 点完就完事了，而事实是**下一次余额刷新会再判一次**。不说清就会出现
   * "我明明解了它怎么又红了"的困惑（而那不是 bug，是判据按钱说话）。
   *
   * 这里**只选透支的那几把**：批量启用（`action:'enable'`）不清锁是有意的（§20.5），
   * 用「启用」去解透支 key 不会报错、只是什么都没变 —— 所以那个入口必须是一个独立的、
   * 名字就叫「解除透支」的按钮。
   */
  const undeplete = (): void => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const depletedCount = rows.filter((row) => ids.includes(row.id) && row.depleted).length;
    modal.confirm({
      title: `解除 ${ids.length} 个 key 的透支锁？`,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>
            将清除锁存标记并启用这 {ids.length} 个 key（其中 {depletedCount} 个当前处于透支锁存）。
          </span>
          <span style={{ color: tokens.color.warning }}>
            清除后它们会<strong>回到选路池</strong>。如果余额 / 套餐余量仍然是空的，下一次余额刷新会
            <strong>再次锁上</strong> —— 解除不等于钱到账了。
          </span>
        </div>
      ),
      okText: '解除并启用',
      cancelText: '取消',
      onOk: async () => {
        const result = await run(
          'batch:undeplete',
          () => keysApi.batch({ ids, action: 'undeplete' }),
          '已解除透支锁并启用',
        );
        if (result === null) return;
        setSelectedIds([]);
        list.reload();
      },
    });
  };

  /**
   * 批量删除（2026-10-11 Bo）：契约只有单笔 DELETE /api/keys/:id（→204），前端按选择顺序
   * 逐把扇出；单把失败即时 message.error 并继续，结尾汇总 {ok, failed} —— 不造批量端点。
   */
  const batchRemove = (): void => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const masked = new Map(rows.map((row) => [row.id, row.maskedKey] as const));
    const preview = ids
      .slice(0, 5)
      .map((id) => masked.get(id) ?? id)
      .join('、');
    modal.confirm({
      title: `删除 ${ids.length} 个 key？`,
      content: preview + (ids.length > 5 ? ' 等' : ''),
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        let ok = 0;
        const failed: string[] = [];
        for (const id of ids) {
          try {
            await keysApi.remove(id);
            ok += 1;
          } catch {
            failed.push(masked.get(id) ?? id);
          }
        }
        setSelectedIds([]);
        list.reload();
        if (failed.length === 0) {
          message.success(`已删除 ${ok} 个 key`);
        } else {
          message.warning(`已删除 ${ok} 个，失败 ${failed.length} 个：${failed.join('、')}`);
        }
      },
    });
  };

  const columns: ColumnsType<UpstreamKey> = [
    {
      // 身份列**不冻结**：本表 12 列合计 1662px，1440 视口可用宽只有 1176px。
      // 冻结「操作」(312px) 会从 1104px 起把右侧整段盖住 —— 实测「首次调用」整列被盖掉
      // （0px 可见），主数据变成必须先横滚才看得见。冻结 + 可见性在这张表上不能同时成立，
      // 列预算（今日 token 是否并入余额 / 套餐等）留给独立的表格瘦身单，不在加列这一单里混。
      title: '标签 / Key',
      dataIndex: 'label',
      width: 200,
      ellipsis: true,
      render: (_: string, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <Text style={{ fontSize: 13 }} ellipsis={{ tooltip: row.label || '（无标签）' }}>
            {row.label || '（无标签）'}
          </Text>
          <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>
            {row.maskedKey}
          </Text>
        </div>
      ),
    },
    {
      title: '上游',
      dataIndex: 'upstreamId',
      width: 140,
      render: (value: string) => <Text type="secondary">{upstreamName.get(value) ?? value}</Text>,
    },
    {
      /**
       * 契约 §3 v1.18.0：归属供应商账号（`supplier_account_keys.pooled_key_id` 反查，唯一归属才回）。
       * `null` 是**手工建的 key**（不是「未知」）—— 渲染「—」，不渲染「未知」/空白：
       * 空白在表里会被读成"这列没数据"，而 `—` 说的是"这类 key 本来就没有归属"。
       */
      title: '所属账号',
      dataIndex: 'account',
      width: 150,
      render: (account: UpstreamKey['account']) =>
        account === null ? (
          <Tooltip title="手工建的 key（非账号池来源），没有归属账号 —— 这不是「未知」">
            <Text type="secondary">—</Text>
          </Tooltip>
        ) : (
          <Tooltip title="归属供应商账号（掩码）。该账号的余额与套餐余量是这些 key 的资金来源">
            <Text style={{ fontFamily: tokens.font.mono, fontSize: 12 }}>{account.identifier}</Text>
          </Tooltip>
        ),
    },
    {
      title: '分类',
      dataIndex: 'category',
      width: 96,
      render: (value: KeyCategory) =>
        value === 'balance' ? (
          <Tag bordered={false} style={{ background: tokens.tint.info, color: tokens.color.info }}>
            余额类
          </Tag>
        ) : (
          <Tag bordered={false} style={{ background: tokens.tint.neutral, color: tokens.color.textSecondary }}>
            Token 套餐
          </Tag>
        ),
    },
    {
      title: '余额 / 套餐',
      dataIndex: 'balance',
      width: 210,
      render: (_: unknown, row) => {
        if (row.category === 'token-plan') return <TokenPlanCell row={row} />;
        /*
         * 契约 §3 v1.18.1：账号型 key 的余额是**账号级资金的只读镜像** —— 渲染
         * `account.balanceCents` / `account.balanceUpdatedAt`，**不渲染 key 自己的 `balance`**
         * （账号型上游的 key 级余额查询不支持，那一列恒 null；拿它渲染只会得到一片「未知」，
         * 而那正是业主说的"key 管理的余额没体现"）。
         * 币种：账号行只有分，没有 currency 列，管理面统一按 CNY 呈现（§15.1 金额口径）。
         */
        if (row.account !== null) {
          return (
            <BalanceText
              value={row.account.balanceCents}
              updatedAt={row.account.balanceUpdatedAt}
              showMeta
              strong
            />
          );
        }
        return (
          <BalanceText
            value={row.balance}
            currency={row.balanceCurrency ?? 'CNY'}
            source={row.balanceSource}
            updatedAt={row.balanceUpdatedAt}
            unlimited={row.unlimited}
            showMeta
            strong
          />
        );
      },
    },
    {
      title: '健康态',
      dataIndex: 'health',
      width: 170,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/*
            §20.1 硬约束：`depleted=true` 时**不得只画三灯**。所以这里是**并排两个**标签，
            不是一个标签的两个取值 —— 一把 `health="healthy"` + `depleted=true` 的 key
            两个标签同时出现，那正是它真实的样子（没坏，但没钱）。
          */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.xs }}>
            <HealthTag
              health={row.health}
              cooldownUntil={row.cooldownUntil}
              lastFailureReason={row.lastFailureReason}
              consecutiveFailures={row.consecutiveFailures}
            />
            <DepletedTag
              depleted={row.depleted}
              depletedAt={row.depletedAt}
              depletedReason={row.depletedReason}
            />
          </div>
          {row.consecutiveFailures > 0 ? (
            <Text type="secondary" style={{ fontSize: 11 }}>
              连续失败 {row.consecutiveFailures} 次 · {failureReasonLabel(row.lastFailureReason)}
            </Text>
          ) : null}
        </div>
      ),
    },
    {
      title: '今日 token',
      dataIndex: 'todayTokens',
      width: 96,
      align: 'right',
      render: (value: number) => <Text style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCompact(value)}</Text>,
    },
    {
      /**
       * 契约 v1.23.0：这把 key 第一次**有真实请求落到它身上**的时刻。列表 / 详情都带。
       *
       * 口径不是「首次成功」：上游失败的尝试不落用量日志，所以只要有一行带这把 key 的记录，
       * 就说明请求真的发出去过一次 —— 终态是成功 / 4xx 透传 / 429 / 流式中断都算「用过」。
       * 「这把 key 到底能不能用」不是这一列的问题。
       *
       * `null` = **从未被真正用过**，渲染灰字「未调用」—— 不是 `—`、不是 0、不是空串：
       * `—` 在本页已被「手工 key 无归属」占用（语义是"这类 key 本来就没有"），
       * 而这里要回答的是"用没用过"，两个空必须长得不一样。
       * 存量 key 的调用日志超出保留期时后端也回 `null` —— 宁可显示「未调用」，不按旁证
       * （如 `todayTokens`）反推一个假时刻，所以这里**只读不推**。
       * 有值 → 相对时间（与「更新于」同一套 `formatRelative` 口径），精确时刻进 tooltip
       * （本地时区 + 原始 ISO 串，两者都要，跨时区核对以 ISO 为准）。
       */
      title: '首次调用',
      dataIndex: 'firstUsedAt',
      width: 96,
      render: (value: string | null) =>
        !value ? (
          <Tooltip title="这把 key 还没有被真正用过 —— 至今没有一条请求落到它的上游。存量 key 的调用日志超出保留期后也会显示「未调用」，后端宁可空着也不编一个时刻">
            <Text type="secondary" style={{ fontSize: 12 }}>
              未调用
            </Text>
          </Tooltip>
        ) : (
          <Tooltip title={`第一次被真正用上（请求发往上游）：${formatIso(value)} · ${value}`}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {formatRelative(value)}
            </Text>
          </Tooltip>
        ),
    },
    {
      title: '更新于',
      dataIndex: 'updatedAt',
      width: 96,
      render: (value: string) => (
        <Tooltip title={formatIso(value)}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {formatRelative(value)}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 64,
      render: (_: unknown, row) => (
        <Tooltip
          title={
            row.deletedAt
              ? '该 key 已删除，不再参与路由'
              : row.depleted
                ? '管理端只写启用状态；健康态由网关决定。透支锁不受这里影响 —— 打开它不会让这把 key 回池，要用「解除透支」'
                : '管理端只写启用状态；健康态由网关决定'
          }
        >
          <Switch
            size="small"
            checked={row.enabled}
            disabled={Boolean(row.deletedAt)}
            loading={isPending(`patch:${row.id}`)}
            onChange={(checked) => {
              void patchKey(row, { enabled: checked, revision: row.revision }, checked ? '已启用' : '已禁用');
            }}
          />
        </Tooltip>
      ),
    },
    {
      // 「操作」**不冻结**：理由是刚性冲突而不是口味 —— 本表 1662px 宽、1440 可用 1176px，
      // 冻结这 312px 会让「首次调用 / 更新于 / 启用」在首屏被整列盖住（实测 0px 可见）。
      // 业主「操作列冻结常在」的口径在账号池表成立（那张表已瘦身到 1166px 容得下），
      // 这张表的列预算还没做，先保主数据可见。
      title: '操作',
      key: 'actions',
      width: 312,
      render: (_: unknown, row) => (
        <Space size={tokens.space.sm}>
          <Button
            size="small"
            type="link"
            style={{ padding: 0 }}
            onClick={() => {
              setEditing(row);
              setFormOpen(true);
            }}
          >
            编辑
          </Button>
          {row.category === 'balance' ? (
            <Button size="small" type="link" style={{ padding: 0 }} onClick={() => setBalanceTarget(row)}>
              录入余额
            </Button>
          ) : null}
          {/*
            账号型上游（tierflow / tokenrhythm）的 key 余额是**账号级资金的镜像**（契约 §2 v1.18.1）：
            key 级余额查询不支持、后端恒 422。所以这里不给「查余额」按钮 —— 那是把一次注定的
            失败做成一个功能 —— 换成指向账号池的引导入口。这是整页唯一"不发请求的按钮"，
            文案必须写成**去哪儿做什么**，不能只写「查余额」把人送去一个空动作。
          */}
          {accountKindByUpstream.get(row.upstreamId) === true ? (
            <Tooltip title="账号型上游的 key 余额就是账号余额（只读镜像），不支持单独查这把 key 的余额。余额请去账号池「刷新余额」—— 那一次刷新也会顺带回填套餐余量；掩码还没取到的再点「同步套餐余量」补齐">
              <Button
                size="small"
                type="link"
                style={{ padding: 0 }}
                onClick={() => {
                  navigate(`/upstreams/${row.upstreamId}/accounts`);
                }}
              >
                去账号池查余额
              </Button>
            </Tooltip>
          ) : (
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              loading={isPending(`refresh:${row.id}`)}
              disabled={row.deletedAt !== null}
              onClick={() => {
                void refreshOne(row);
              }}
            >
              查余额
            </Button>
          )}
          {/*
            套餐余量的回填腿：v1.22.0 起账号池「刷新余额」也会顺带回填余量与掩码，
            所以这条（§15.2 `keys/sync`）不再是**唯一**的腿，而是**掩码取不到时的兜底** ——
            刷新只能回填已有掩码的行，掩码缺了就一直是「未同步」，只有它能补（ADR-0047）。
            只有「token-plan + 有归属账号」的行才有这个入口：没有归属就没有可同步的订阅。
          */}
          {row.category === 'token-plan' && row.account !== null ? (
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              loading={isPending(`plansync:${row.id}`)}
              disabled={row.deletedAt !== null}
              onClick={() => {
                void syncPlanOne(row);
              }}
            >
              同步套餐余量
            </Button>
          ) : null}
          {row.category === 'balance' ? (
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              disabled={row.deletedAt !== null}
              onClick={() => setTestTarget(row)}
            >
              自测
            </Button>
          ) : null}
          <Button size="small" type="link" danger style={{ padding: 0 }} onClick={() => removeKey(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  const loading = list.loading || upstreams.loading;
  if (loading) {
    return (
      <>
        <PageHeader title="Key 管理" />
        <LoadingState tip="正在加载 key 列表…" minHeight={420} />
      </>
    );
  }

  if (list.error && !list.data) {
    return (
      <>
        <PageHeader title="Key 管理" />
        <ErrorState error={list.error} onRetry={list.reload} variant="page" title="Key 列表加载失败" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Key 管理"
        extra={
          <Space>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={isPending('refreshAll') || task.running}
              disabled={(upstreams.data?.items.length ?? 0) === 0}
              onClick={() => {
                confirmRefreshAll();
              }}
            >
              全量查余额
            </Button>
            <Button
              type="primary"
              size="small"
              icon={<PlusOutlined />}
              disabled={(upstreams.data?.items.length ?? 0) === 0}
              onClick={() => {
                setEditing(null);
                setFormOpen(true);
              }}
            >
              新增 Key
            </Button>
          </Space>
        }
      />

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: tokens.space.sm,
          marginBottom: tokens.space.md,
        }}
      >
        <Select
          allowClear
          size="small"
          style={{ width: 180 }}
          placeholder="全部上游"
          value={filters.upstreamId}
          options={(upstreams.data?.items ?? []).map((item: Upstream) => ({
            label: item.name,
            value: item.id,
          }))}
          onChange={(value: string | undefined) => {
            setFilters((prev) => ({ ...prev, upstreamId: value }));
            setPage(1);
          }}
        />
        <Segmented
          size="small"
          value={filters.category ?? 'all'}
          options={[
            { label: '全部', value: 'all' },
            { label: '余额类', value: 'balance' },
            { label: 'Token 套餐', value: 'token-plan' },
          ]}
          onChange={(value) => {
            setFilters((prev) => ({
              ...prev,
              category: value === 'all' ? undefined : (value as KeyCategory),
            }));
            setPage(1);
          }}
        />
        <Select
          allowClear
          size="small"
          style={{ width: 150 }}
          placeholder="全部健康态"
          value={filters.health}
          options={[
            { label: '健康', value: 'healthy' },
            { label: '冷却中', value: 'cooling' },
            { label: '已禁用', value: 'disabled' },
          ]}
          onChange={(value: KeyHealth | undefined) => {
            setFilters((prev) => ({ ...prev, health: value }));
            setPage(1);
          }}
        />
        <Segmented
          size="small"
          value={filters.enabled === undefined ? 'all' : filters.enabled ? 'on' : 'off'}
          options={[
            { label: '全部', value: 'all' },
            { label: '已启用', value: 'on' },
            { label: '已禁用', value: 'off' },
          ]}
          onChange={(value) => {
            setFilters((prev) => ({
              ...prev,
              enabled: value === 'all' ? undefined : value === 'on',
            }));
            setPage(1);
          }}
        />
        {/* 契约依据写在注释里（§20.1 的第四轴），tooltip 里只留人话：用户可见文案不带开发术语。 */}
        <Tooltip title="透支锁存是一根与健康态正交的轴 —— 一把「健康」的 key 也可以同时是透支的">
          <Segmented
            size="small"
            value={filters.depleted === undefined ? 'all' : filters.depleted ? 'yes' : 'no'}
            options={[
              { label: '全部资金', value: 'all' },
              { label: '仅透支', value: 'yes' },
              { label: '非透支', value: 'no' },
            ]}
            onChange={(value) => {
              setFilters((prev) => ({
                ...prev,
                depleted: value === 'all' ? undefined : value === 'yes',
              }));
              setPage(1);
            }}
          />
        </Tooltip>
        <Tooltip title="默认不显示已软删的 key；打开后可查历史（软删行仍保留，日志外键不断）">
          <Segmented
            size="small"
            value={filters.includeDeleted ? 'with' : 'without'}
            options={[
              { label: '不含已删', value: 'without' },
              { label: '含已删', value: 'with' },
            ]}
            onChange={(value) => {
              setFilters((prev) => ({ ...prev, includeDeleted: value === 'with' }));
              setPage(1);
            }}
          />
        </Tooltip>
        <Input.Search
          size="small"
          allowClear
          style={{ width: 200 }}
          placeholder="搜索标签"
          onSearch={(value) => {
            setFilters((prev) => ({ ...prev, q: value }));
            setPage(1);
          }}
        />

        {selectedIds.length > 0 ? (
          <Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              已选 {selectedIds.length} 个
            </Text>
            <Button size="small" loading={isPending('batch:enable')} onClick={() => void batch('enable')}>
              批量启用
            </Button>
            <Button
              size="small"
              danger
              loading={isPending('batch:disable')}
              onClick={() => void batch('disable')}
            >
              批量禁用
            </Button>
            {/*
              独立的「解除透支」按钮（§20.5）。**不**并入「批量启用」：后端定死了
              `enable` 不清锁（一次批量启用就能把整池透支 key 放回去，"不会再回到
              正常的池"当场作废）—— 界面上如果只有一个按钮，用户拿着「启用」去解
              透支 key，得到的会是"点了没报错、什么都没变"。
            */}
            {rows.some((row) => selectedIds.includes(row.id) && row.depleted) ? (
              <Button
                size="small"
                style={{ color: tokens.color.orange, borderColor: tokens.color.orange }}
                loading={isPending('batch:undeplete')}
                onClick={undeplete}
              >
                解除透支
              </Button>
            ) : null}
            {/* 勾选里只要有一把「token-plan + 有归属账号」的 key，就值得给这个入口（其余行不参与）。 */}
            {rows.some(
              (row) => selectedIds.includes(row.id) && row.category === 'token-plan' && row.account !== null,
            ) ? (
              <Button size="small" onClick={batchSyncPlan}>
                批量同步套餐余量
              </Button>
            ) : null}
            <Button size="small" danger icon={<DeleteOutlined />} onClick={batchRemove}>
              批量删除
            </Button>
          </Space>
        ) : null}
      </div>

      {list.error && list.data ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={list.error} onRetry={list.reload} title="刷新失败，以下为上一次成功的数据" />
        </div>
      ) : null}

      {task.error ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <ErrorState error={task.error} onRetry={task.refresh} title="余额刷新任务查询失败" />
        </div>
      ) : null}

      {refreshHint ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <BalanceHint
            hintCode={refreshHint.hintCode}
            hint={refreshHint.hint}
            retryAfterSeconds={refreshHint.retryAfterSeconds}
          />
        </div>
      ) : null}

      <Table<UpstreamKey>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rows}
        loading={list.refreshing}
        rowSelection={{
          selectedRowKeys: selectedIds,
          onChange: (keys) => setSelectedIds(keys as string[]),
          getCheckboxProps: (row) => ({ disabled: Boolean(row.deletedAt) }),
        }}
        // Σ 列宽（含勾选列 32）与加「首次调用」**之前**逐像素持平（1440 / 1280 实测均 1662）：
        // 新列的 96px 从有余量的列里借（标签 -20 / 分类 -14 / 今日 token -14 / 更新于 -14 /
        // 启用 -16 / 操作 -18 = 96），两档的横向滚动量因此一分不涨。
        // scroll.x = 1662 = 真实表宽（scrollW 实测），不是拍的；改列宽先量后改。
        scroll={{ x: 1662 }}
        pagination={{
          current: page,
          pageSize,
          total: list.data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: [20, 50, 100, 200],
          showTotal: (total) => `共 ${total} 个 key`,
          onChange: (nextPage, nextSize) => {
            setPage(nextPage);
            setPageSize(nextSize);
          },
        }}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无 key"
            />
          ),
        }}
      />

      <KeyFormModal
        open={formOpen}
        upstreams={upstreams.data?.items ?? []}
        editing={editing}
        onClose={() => setFormOpen(false)}
        onSaved={list.reload}
      />
      <BalanceModal
        open={balanceTarget !== null}
        target={balanceTarget}
        onClose={() => setBalanceTarget(null)}
        onSaved={list.reload}
      />
      <KeyBalanceSelfTest
        open={testTarget !== null}
        keyId={testTarget?.id ?? null}
        maskedKey={testTarget?.maskedKey ?? null}
        onClose={() => setTestTarget(null)}
      />

      {/*
        套餐余量同步的逐行明细：**复用**账号池那张 `SupplierBatchDrawer`（同一个任务形状
        `SupplierBatchResult`、同一套认形状的防御），不在这里造第二份。
      */}
      <SupplierBatchDrawer
        open={planDrawer.open}
        onClose={() => {
          setPlanDrawer((prev) => ({ ...prev, open: false }));
        }}
        title={planDrawer.title}
        task={syncTask.task}
        taskError={syncTask.error}
        onRetryTask={syncTask.refresh}
      />
    </>
  );
}
