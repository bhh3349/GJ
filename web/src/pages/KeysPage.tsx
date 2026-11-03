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
 *   「未同步」与「0」是两句话，见 `AmountCell`（业主口径后列头改「金额」，余额类/套餐类各画各的）。套餐余量的回填腿 v1.22.0 起有**两条**：
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
  Dropdown,
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
import type { MenuProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { keysApi, supplierAccountsApi, upstreamsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { describeError, isApiError } from '@/api/http';
import { useTaskPolling } from '@/api/useTaskPolling';
import {
  PAGE_SIZE_DEFAULT,
  asSupplierKind,
  type BalanceRefreshResult,
  type HintCode,
  type KeyCategory,
  type KeyHealth,
  type KeyProbeCode,
  type Upstream,
  type UpstreamKey,
} from '@/api/types';
import { BalanceHint } from '@/components/BalanceHint';
import { BalanceText, balanceSourceLabel } from '@/components/BalanceText';
import { balanceReadiness } from '@/utils/balanceReadiness';
import { DepletedTag } from '@/components/DepletedTag';
import { HealthTag } from '@/components/HealthTag';
import { confirmManualRefresh } from '@/components/ManualRefreshConfirm';
import { PageHeader } from '@/components/PageHeader';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { SupplierBatchDrawer } from '@/pages/upstreams/SupplierBatchDrawer';
import { BalanceModal, KeyFormModal } from '@/pages/keys/KeyModals';
import { KeyBalanceSelfTest } from '@/pages/keys/KeyBalanceSelfTest';
import { useLive } from '@/realtime/useLive';
import { tokens } from '@/theme/tokens';
import {
  formatCents,
  formatCompact,
  formatIso,
  formatRelative,
  formatTokensShort,
  formatUntil,
} from '@/utils/format';

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
 * 试调结论的中文短名（契约 §3 `ProbeResult.probeCode` 八值，v1.24.0）。
 *
 * 逐行把错码翻成人话 —— 业主点完按钮要能直接读出"哪把能用、为什么不能用"，
 * 不是去查枚举。上游自己给的 `upstreamMessage` 单独放进 tooltip（已过后端脱敏）。
 */
const PROBE_LABEL: Record<KeyProbeCode, string> = {
  UPSTREAM_UNREACHABLE: '上游连不上',
  TIMEOUT: '探活超时',
  AUTH_REJECTED: '鉴权被拒',
  MODEL_REJECTED: '模型不被接受',
  QUOTA_EXHAUSTED: '额度耗尽',
  RATE_LIMITED: '上游限流',
  UPSTREAM_ERROR: '上游错误',
  EMPTY_RESPONSE: '空响应',
};

/** 单行试调结果：`✓` / `✗` + 短名进格子，完整诊断进 tooltip。 */
interface ProbeRowState {
  ok: boolean;
  short: string;
  detail: string;
}

/**
 * 「金额」列（业主 2026-11-03 口径：列头由「余额 / 套餐」改成「金额」，210 → ~150）。
 *
 * 业主原话：「余额key就显示余额啊，套餐key就显示套餐金额和赠送的8M啊（29.9/8M）」。
 *
 * - **套餐类**：主行 `¥29.90 / 8M`（`amountTotalCents` / `totalTokens`，现成字段、零后端改动），
 *   次行 `剩 6.2M · 还剩 29 天`，全量（含已用金额、到期精确时刻）进 tooltip。
 * - **余额类**：只画余额（账号型 key 仍是 `account.balanceCents` 只读镜像），次行只留
 *   来源 / 更新时间的小灰字。
 *
 * 三个 null 语义照旧（§0.2「0 和 null 不是一回事」在这张表上的落点）：
 * - 套餐两面都没值 ⇒ 「未同步」徽标（**从未查到过**，不是烧干）；两格都 null 时**不画**空壳
 *   `— / —`，那读起来像"两个字段都坏了"，而事实只是"还没同步"。
 * - 单面 null ⇒ 那一格画 `—`（台账没给这一面），另一面照画。
 * - `remainingTokens === 0` ⇒ 次行照写「剩 0」并给烧干色 —— 查到过、确实没了。
 */
function AmountCell({ row }: { row: UpstreamKey }) {
  if (row.category === 'token-plan') {
    const plan = row.tokenPlan;
    if (plan === null) {
      // 契约保证 token-plan 行的 `tokenPlan` 恒为对象（读路径按类别再造），这个分支是防御：
      // 真到了说明响应违约，如实说，不编一个 0。
      return <Text type="secondary">套餐信息缺失</Text>;
    }
    const moneyKnown = plan.amountTotalCents !== null || plan.amountUsedCents !== null;
    const tokenKnown = plan.totalTokens !== null || plan.remainingTokens !== null;
    if (!moneyKnown && !tokenKnown) {
      return (
        <Tooltip title="刷新会回填掩码；仍显示未同步就点「同步套餐余量」">
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
      );
    }
    const exhausted = plan.remainingTokens === 0;
    const main = `${formatCents(plan.amountTotalCents)} / ${formatTokensShort(plan.totalTokens)}`;
    const second = [
      plan.remainingTokens === null ? null : `剩 ${formatTokensShort(plan.remainingTokens)}`,
      plan.expiresAt ? formatUntil(plan.expiresAt) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const tip = [
      `套餐额度 ${formatCents(plan.amountTotalCents)}，已用 ${formatCents(plan.amountUsedCents)}`,
      `基础额度 ${formatTokensShort(plan.totalTokens)}，剩余 ${formatTokensShort(plan.remainingTokens)}`,
      plan.expiresAt ? `到期 ${formatIso(plan.expiresAt)}（${formatUntil(plan.expiresAt)}）` : '无到期时间',
    ].join('；');
    return (
      <Tooltip title={tip}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
          <Text strong style={{ fontVariantNumeric: 'tabular-nums', fontSize: 13 }}>
            {main}
          </Text>
          {second ? (
            <Text
              type="secondary"
              style={{
                fontSize: 11,
                color: exhausted ? tokens.color.error : undefined,
                fontWeight: exhausted ? 600 : undefined,
              }}
            >
              {second}
            </Text>
          ) : null}
        </div>
      </Tooltip>
    );
  }

  /*
   * 余额类。契约 §3 v1.18.1：账号型 key 的余额是**账号级资金的只读镜像** —— 渲染
   * `account.balanceCents` / `account.balanceUpdatedAt`，**不渲染 key 自己的 `balance`**
   * （账号型上游 key 级余额查询不支持，那列恒 null；拿它渲染只会得到一片「未知」）。
   * 币种：账号行只有分，没有 currency 列，管理面统一按 CNY 呈现（§15.1 金额口径）。
   */
  const viaAccount = row.account !== null;
  const value = viaAccount && row.account ? row.account.balanceCents : row.balance;
  const updatedAt = viaAccount && row.account ? row.account.balanceUpdatedAt : row.balanceUpdatedAt;
  const sourceLabel = viaAccount ? '账号' : balanceSourceLabel(row.balanceSource);
  const second = [sourceLabel, updatedAt ? formatRelative(updatedAt) : null].filter(Boolean).join(' · ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      <BalanceText
        value={value}
        currency={row.balanceCurrency ?? 'CNY'}
        unlimited={row.unlimited}
        strong
      />
      {second ? (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {second}
        </Text>
      ) : null}
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

  /** 逐行试调结果（`✓` / `✗` 与完整诊断），按 key id 记；重拉列表不主动清（结论只对"刚才那一刻"有效）。 */
  const [probeById, setProbeById] = useState<Record<string, ProbeRowState>>({});
  const [probingIds, setProbingIds] = useState<Record<string, true>>({});
  /** 批量试调的进度（只在 header 那个按钮上显示，够看就行）。 */
  const [probeBatch, setProbeBatch] = useState({ running: false, done: 0, total: 0 });

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
   * 试调一次（契约 §3 v1.24.0 `POST /api/keys/:id/probe`）。
   *
   * 与「查余额」的分工：探活打的是**这把 key 本身**（白名单第一条模型打一次 chat，
   * 或退化成 `/v1/models`），回答"现在能不能用"；后端**不写用量、不动健康态**（ADR-0049），
   * 所以这里也不 reload 列表 —— 重拉只会把没变的值再画一遍，看着像"点完什么都没发生"。
   *
   * 429 是「同一把 key 10 秒内又点了一次」的后端频控，**不是失败结论**：提示等几秒，
   * 绝不写进 `✗`（写进去会让人以为 key 坏了）。
   */
  const probeOne = async (row: UpstreamKey): Promise<void> => {
    setProbingIds((prev) => ({ ...prev, [row.id]: true }));
    try {
      const res = await keysApi.probe(row.id);
      const where = res.kind === 'chat' ? `${res.model ?? 'chat'}（打了一次 chat）` : '模型列表接口（不烧 token）';
      const label = res.ok ? '可用' : PROBE_LABEL[res.probeCode ?? 'UPSTREAM_ERROR'];
      const detail = [
        `${label} · ${where}`,
        `状态 ${res.httpStatus ?? '无'} · ${res.durationMs}ms`,
        res.upstreamErrorCode ? `上游码 ${res.upstreamErrorCode}` : null,
        res.upstreamMessage ? `上游说：${res.upstreamMessage}` : null,
        `${formatIso(res.checkedAt)} 试调`,
      ]
        .filter(Boolean)
        .join('；');
      setProbeById((prev) => ({ ...prev, [row.id]: { ok: res.ok, short: label, detail } }));
    } catch (reason) {
      if (isApiError(reason) && reason.status === 429) {
        const retry = (reason.details as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
        message.warning(`${row.maskedKey} 刚试调过，${retry ?? 10} 秒后再试（同一把 key 10 秒一次）`);
        return;
      }
      const { code, message: text } = describeError(reason);
      setProbeById((prev) => ({
        ...prev,
        [row.id]: { ok: false, short: '请求失败', detail: `${text} [${code}]` },
      }));
    } finally {
      setProbingIds((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    }
  };

  /**
   * 批量试调：勾选优先，没有勾选 = **当前页全部启用行**。并发 2 —— 与后端全局上限同一量级：
   * 后端那 2 路是"管理员手点的保险"，前端开更多只会排队、把进度拖长，不会更快。
   * 单把失败不中断全批（`probeOne` 自己吃掉所有错误，含 429）。
   */
  const runProbePool = async (targets: UpstreamKey[]): Promise<void> => {
    const queue = [...targets];
    let done = 0;
    setProbeBatch({ running: true, done: 0, total: targets.length });
    const worker = async (): Promise<void> => {
      for (;;) {
        const row = queue.shift();
        if (row === undefined) return;
        await probeOne(row);
        done += 1;
        setProbeBatch({ running: true, done, total: targets.length });
      }
    };
    await Promise.all([worker(), worker()]);
    setProbeBatch({ running: false, done, total: targets.length });
    message.success(`试调完成：${targets.length} 把，结论见各行 ✓ / ✗`);
  };

  /**
   * 「全部试调」= 业主原话「每个账号的key必须要调用一下保活」。
   * 打之前先说清**打谁、打几把**（这是真打上游的批动作，不是本地刷新）。
   */
  const probeMany = (): void => {
    const picked = selectedIds.length > 0;
    const targets = picked
      ? rows.filter((row) => selectedIds.includes(row.id))
      : rows.filter((row) => row.enabled && row.deletedAt === null);
    if (targets.length === 0) {
      message.info(picked ? '勾选里没有可试调的 key' : '当前页没有启用中的 key');
      return;
    }
    modal.confirm({
      title: `试调 ${targets.length} 把 key？`,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>
            {picked
              ? `逐把真打上游（勾选的 ${targets.length} 把）。`
              : `逐把真打上游（当前页全部启用的 ${targets.length} 把）。`}
          </span>
          <span style={{ color: tokens.color.textSecondary }}>
            只读观测：不写用量、不动健康态；单把失败不中断，结果逐行 ✓ / ✗。
          </span>
        </div>
      ),
      okText: '开始试调',
      cancelText: '取消',
      onOk: async () => {
        await runProbePool(targets);
      },
    });
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
    modal.confirm({
      title: `解除 ${ids.length} 个 key 的透支锁？`,
      content: (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span>清锁并启用这 {ids.length} 个 key，它们会回到选路池。</span>
          <span style={{ color: tokens.color.warning }}>
            若余额仍是空的，下一次余额刷新会<strong>再次锁上</strong>。
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
      // 业主原话「那个标签/key那么长，干嘛啊」→ 200 收到 118：标签**一行省略号**（全文进 tooltip），
      // 掩码另起一行 mono。宽表里身份列不该靠"多显示几个字的标签"占掉主数据的宽度。
      // 首列**不冻结**（业主 2026-11-03：只冻操作列，左右成对冻结是我们自己加的，已撤）。
      title: '标签 / Key',
      dataIndex: 'label',
      width: 118,
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
      // 140 → 106：上游名只做"这是哪家"的定位，长名字省略号 + tooltip，不让它撑列。
      title: '上游',
      dataIndex: 'upstreamId',
      width: 106,
      render: (value: string) => {
        const name = upstreamName.get(value) ?? value;
        return (
          <Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: name }}>
            {name}
          </Text>
        );
      },
    },
    {
      /**
       * 契约 §3 v1.18.0：归属供应商账号（`supplier_account_keys.pooled_key_id` 反查，唯一归属才回）。
       * `null` 是**手工建的 key**（不是「未知」）—— 渲染「—」，不渲染「未知」/空白：
       * 空白在表里会被读成"这列没数据"，而 `—` 说的是"这类 key 本来就没有归属"。
       */
      title: '所属账号',
      dataIndex: 'account',
      width: 112,
      render: (account: UpstreamKey['account']) =>
        account === null ? (
          <Tooltip title="手工建的 key（非账号池来源），没有归属账号 —— 这不是「未知」">
            <Text type="secondary">—</Text>
          </Tooltip>
        ) : (
          <Tooltip title="归属供应商账号（掩码）。该账号的余额与套餐余量是这些 key 的资金来源">
            <Text
              style={{ fontFamily: tokens.font.mono, fontSize: 12 }}
              ellipsis={{ tooltip: account.identifier }}
            >
              {account.identifier}
            </Text>
          </Tooltip>
        ),
    },
    {
      title: '分类',
      dataIndex: 'category',
      width: 84,
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
      title: '金额',
      dataIndex: 'balance',
      width: 150,
      render: (_: unknown, row) => <AmountCell row={row} />,
    },
    {
      title: '健康态',
      dataIndex: 'health',
      width: 116,
      render: (_: unknown, row) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {/*
            §20.1 反向禁则（业主 2026-11-03：「都透支了还健康呢？」）：`depleted=true` 的行
            **只画红「透支」**，不再并排绿色「健康」—— 没钱的 key 挂着绿灯是撒谎。
            三灯只在 `depleted=false` 时出现；失败原因与冷却细节都收进 HealthTag 的 tooltip。
          */}
          {row.depleted ? (
            <DepletedTag
              depleted
              depletedAt={row.depletedAt}
              depletedReason={row.depletedReason}
            />
          ) : (
            <HealthTag
              compact
              health={row.health}
              cooldownUntil={row.cooldownUntil}
              lastFailureReason={row.lastFailureReason}
              consecutiveFailures={row.consecutiveFailures}
            />
          )}
          {row.consecutiveFailures > 0 ? (
            <Text type="secondary" style={{ fontSize: 11 }}>
              连续失败 {row.consecutiveFailures} 次
            </Text>
          ) : null}
        </div>
      ),
    },
    {
      title: '今日 token',
      dataIndex: 'todayTokens',
      width: 88,
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
      width: 84,
      render: (value: string | null) =>
        !value ? (
          <Tooltip title="这把 key 至今没有一条请求落到上游；日志超出保留期也显示「未调用」">
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
      width: 84,
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
      width: 52,
      render: (_: unknown, row) => (
        <Tooltip
          title={
            row.deletedAt
              ? '已删除，不参与路由'
              : row.depleted
                ? '只写启用状态；透支锁要「解除透支」才清'
                : '只写启用状态；健康态由网关决定'
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
      /*
        「操作」右冻结（业主 2026-11-03 口径：**只**冻结操作列，首列一律不冻）。
        瘦身后 Σ=1172 ≤ 1440 可用 1176，冻结不再遮列（旧版 312px 冻结会把
        「首次调用 / 更新于 / 启用」整列盖掉，实测 0px 可见，所以当年不冻）。
        行内常驻「试调」；结果以 ✓ / ✗ 短标落在按钮左侧，完整诊断进 tooltip；
        其余低频动作收进「更多」。
      */
      title: '操作',
      key: 'actions',
      width: 146,
      fixed: 'right',
      render: (_: unknown, row) => {
        const probe = probeById[row.id];
        const menu: MenuProps = {
          items: [
            { key: 'edit', label: '编辑' },
            ...(row.category === 'balance' ? [{ key: 'balance-input', label: '录入余额' }] : []),
            { key: 'balance-check', label: '查余额' },
            ...(row.category === 'token-plan' && row.account !== null
              ? [{ key: 'plan-sync', label: '同步余量' }]
              : []),
            ...(row.category === 'balance' ? [{ key: 'self-test', label: '自测' }] : []),
            { key: 'delete', label: '删除', danger: true },
          ],
          onClick: ({ key }) => {
            if (key === 'edit') {
              setEditing(row);
              setFormOpen(true);
            } else if (key === 'balance-input') {
              setBalanceTarget(row);
            } else if (key === 'balance-check') {
              /*
                账号型上游的 key 余额是账号级镜像（§3 v1.18.1），key 级查询后端恒 422 ——
                同一个「查余额」，账号型路由去账号池（那里才是账号余额的写入口）。
              */
              if (accountKindByUpstream.get(row.upstreamId) === true) {
                navigate(`/upstreams/${row.upstreamId}/accounts`);
              } else {
                void refreshOne(row);
              }
            } else if (key === 'plan-sync') {
              void syncPlanOne(row);
            } else if (key === 'self-test') {
              setTestTarget(row);
            } else if (key === 'delete') {
              removeKey(row);
            }
          },
        };
        return (
          <Space size={4}>
            {probe ? (
              <Tooltip title={probe.detail}>
                <Tag
                  bordered={false}
                  color={probe.ok ? 'green' : 'red'}
                  style={{ marginInlineEnd: 0 }}
                  data-testid={`probe-result-${row.id}`}
                >
                  {probe.ok ? '✓' : '✗'}
                </Tag>
              </Tooltip>
            ) : null}
            <Button
              size="small"
              type="link"
              style={{ padding: 0 }}
              loading={probingIds[row.id] === true}
              disabled={row.deletedAt !== null}
              onClick={() => {
                void probeOne(row);
              }}
            >
              试调
            </Button>
            <Dropdown menu={menu} trigger={['click']}>
              <Button size="small" type="link" style={{ padding: 0 }}>
                更多
              </Button>
            </Dropdown>
          </Space>
        );
      },
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
              onClick={probeMany}
              loading={probeBatch.running}
              disabled={(upstreams.data?.items.length ?? 0) === 0}
            >
              {probeBatch.running ? `试调 ${probeBatch.done}/${probeBatch.total}` : '全部试调'}
            </Button>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              loading={isPending('refreshAll') || task.running}
              disabled={(upstreams.data?.items.length ?? 0) === 0}
              onClick={() => {
                confirmRefreshAll();
              }}
            >
              刷新
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
              新建
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
        {/* 契约依据写在注释里（§20.1 的第四轴），tooltip 只留一句人话。 */}
        <Tooltip title="只看透支锁还挂着的 key（与健康态无关）">
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
        {/* 软删行的存在性说明留给「含已删」三个字本身。 */}
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
                同步余量
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
          <ErrorState error={list.error} onRetry={list.reload} title="刷新失败，下方为旧数据" />
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
        // 瘦身后 Σ 列宽（含勾选列 32）= 32+118+106+112+84+150+116+88+84+84+52+146 = 1172，
        // ≤ 1440×900 可用 1176 ⇒ 首屏零横滚；1280×800 可用 1016，溢出 156（实测回填）。
        // 操作列 fixed:'right' 常在，首列无冻结（业主 2026-11-03 口径）。
        // scroll.x = 1172 = 真实表宽（scrollW 实测），不是拍的；改列宽先量后改。
        scroll={{ x: 1172 }}
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
