/**
 * 组 ↔ 模型授权抽屉（契约 §4「模型授权」/ v1.15.8 / ADR-0037）。
 *
 * Bo 的第四条原话「哪些组下的账号用哪些模型」——此前契约 §4 的三个端点
 * （GET / PUT group models）没有界面出口，组永远"不限"。这个抽屉就是那个出口。
 *
 * 四条纪律：
 * 1. **候选集与消费面同源**：多选的选项来自 `/api/models?enabled=true` ∩ 上游 enabled
 *    （与 `AssistantModelSelect` 同一条判据），不是"库里所有档案"——
 *    给管理员看到一个打不通的名字（档案停用）是又一种会骗人的信号（§19.6 同理）。
 *    候选集在**打开抽屉那一刻**抓取；抽屉开着时档案变了不追（重开即最新）。
 * 2. **`null`（不限）是缺省语义，`[]` 是显式清空**：控件里"清空选择 + 保存"就是
 *    写回 `null`（服务端把 `[]` 归一成 `null`，出口恒不为 `[]`，决策 3）。
 *    界面上只说"清空 = 不限（可用全部已启用模型）"，不出现第三种说法。
 * 3. **保存必须带当前 `revision`**：授权与配额共用 `groups.revision` 这一条版本号，
 *    别人先改过（改配额、改授权）就拿旧版本号来保存 → 409 `REVISION_MISMATCH`。
 *    这里**不静默吞掉**：就地显示冲突、提示重开抽屉拿最新授权（决策 3 的"共享版本号"）。
 * 4. **保存成功就地更新组行**：响应里的 `group.authorizedModels` 与 `group.revision`
 *    已是新值，`onSaved(result.group)` 让父组件**就地**替换那一行 ——
 *    列表页的授权列立刻变，不整页刷新（v1.15.4 的纪律在 v1.15.8 的延续）。
 */
import { Alert, Button, Drawer, Empty, Select, Space, Tag, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { groupsApi, modelsApi, upstreamsApi } from '@/api/endpoints';
import { useAction, useResource } from '@/api/hooks';
import { isApiError } from '@/api/http';
import { PAGE_SIZE_MAX, type Group, type GroupModels } from '@/api/types';
import { ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';

const { Text, Paragraph } = Typography;

export interface GroupModelsDrawerProps {
  /** 有值 = 打开（抽屉显示哪个组由它决定）；`null` = 关闭。 */
  group: Group | null;
  onClose: () => void;
  /**
   * 保存成功：把响应里**服务端算好的那一行**交给父组件就地更新
   * （`authorizedModels` / `revision` 是服务端口径，前端不自己推算）。
   */
  onSaved: (updated: Group) => void;
}

/** 与 `AssistantModelSelect` 同一条判据：模型 enabled ∩ 上游 enabled，按名去重。 */
const LIST_QUERY = { pageSize: PAGE_SIZE_MAX, enabled: true } as const;

export function GroupModelsDrawer({ group, onClose, onSaved }: GroupModelsDrawerProps) {
  const { run, isPending } = useAction();

  const groupId = group?.id ?? null;

  // 授权现状：`models === null` = 不限（还没有授权行 / 显式清过）。
  const current = useResource<GroupModels | null>(
    () => (groupId === null ? Promise.resolve(null) : groupsApi.getModels(groupId)),
    [groupId],
  );

  // 候选集：已启用档案 ∩ 已启用上游，按名去重（同名跨上游授权时打的是同一个名字）。
  const models = useResource(() => modelsApi.list({ ...LIST_QUERY }), []);
  const upstreams = useResource(() => upstreamsApi.list({ ...LIST_QUERY }), []);

  // 草稿：抽屉打开（或 current 到位）那一刻从服务端值起稿。
  // `undefined` = 还没起稿；`null` = 用户选了"清空"。保存时按"空选即不限"写 `null`。
  const [draft, setDraft] = useState<string[] | undefined>(undefined);
  /**
   * 409 冲突后就地标出，**不是**一个飘过去就没了 toast（纪律 3）。
   * 一个只在 toast 里出现过一次的「版本冲突」，用户点第二次保存时只会再撞一次同样的错，
   * 而屏幕上没有任何东西告诉他还差一步"重读最新授权"。
   */
  const [conflict, setConflict] = useState(false);
  /**
   * 冲突后重读到的那一行：props 里的 `group.revision` 是打开抽屉那一刻的快照，
   * 别人先改过（改配额、改授权）它就过期了，继续拿它保存会**永远** 409。
   * 重读成功才写入；重读前保存按钮禁用 —— 拿一个已知过期的版本号再发一次请求，
   * 是把同一个错再犯一遍。
   */
  const [fresh, setFresh] = useState<Group | null>(null);

  useEffect(() => {
    if (current.data === null) {
      setDraft(undefined);
      return;
    }
    setDraft(current.data.models ?? []);
  }, [current.data, groupId]);

  // 换组打开（或抽屉关掉再开）必须把冲突态丢掉：那是**上一组**的事，
  // 留在界面上等于给新组的授权现状扣一顶"可能冲突"的帽子。
  useEffect(() => {
    setConflict(false);
    setFresh(null);
  }, [groupId]);

  /**
   * 冲突后的出路：重读组行（拿回**服务端当前的** `revision` —— models 端点不回版本号，
   * 组行才回）+ 重读授权（草稿随之重锚到最新现状）。
   * 刻意**不自动合并**：两个管理员各改一半，谁替谁合并都可能悄悄合掉对方的意图；
   * 这里只把"最新是什么"摆出来，放弃草稿这件事在界面上先说清楚再按。
   */
  const reread = async (): Promise<void> => {
    if (groupId === null) return;
    const row = await run(`reread:${groupId}`, () => groupsApi.get(groupId));
    if (row === null) return; // 重读失败：冲突提示留在原地，草稿不动
    setFresh(row);
    setConflict(false);
    current.reload();
  };

  const options = useMemo(() => {
    const open = new Set(upstreams.data?.items.map((u) => u.id) ?? []);
    if (!models.data) return [];
    const byName = new Map<string, { value: string; label: string; upstreams: string[] }>();
    for (const model of models.data.items) {
      if (!open.has(model.upstreamId)) continue;
      const existing = byName.get(model.name);
      if (existing) {
        existing.upstreams.push(model.upstreamId);
        continue;
      }
      byName.set(model.name, {
        value: model.name,
        label:
          model.displayName && model.displayName !== model.name
            ? `${model.name} · ${model.displayName}`
            : model.name,
        upstreams: [model.upstreamId],
      });
    }
    return [...byName.values()];
  }, [models.data, upstreams.data]);

  /** 展开行里"同名几条"的信息：这个组的授权落到几个档案行（给"×2"这类角标用）。 */
  const entryCountOf = (name: string): number =>
    current.data?.authorizedModels.filter((e) => e.name === name).length ?? 0;

  const save = async (): Promise<void> => {
    if (group === null || current.data === null || draft === undefined) return;
    // 冲突后服务端重取的那一份优先于 props 里那个可能过期的行（见 `fresh` 的注释）。
    const revision = fresh?.revision ?? group.revision;
    const names = draft.length === 0 ? null : draft;
    let hit = false;
    const result = await run(
      `models:${group.id}`,
      async () => {
        try {
          return await groupsApi.setModels(group.id, { models: names, revision });
        } catch (error) {
          if (isApiError(error) && error.code === 'REVISION_MISMATCH') hit = true;
          throw error;
        }
      },
      names === null ? '已清空授权（该组恢复为不限）' : '已保存模型授权',
    );
    if (result === null) {
      if (hit) setConflict(true);
      return;
    }
    setConflict(false);
    onSaved(result.group);
    // 服务端回的那一份才是权威（`group.revision` 已 +1）：用它把本地草稿对齐，
    // 连续保存两次（先授权一条、再补一条）就不会拿旧 revision 撞 409。
    setDraft(result.models ?? []);
    onClose();
  };

  const loading = current.loading || models.loading || upstreams.loading;
  const candidatesFailed = models.error !== null || upstreams.error !== null;

  /**
   * 已授权但**不在候选集里**的名字：档案被停用了（或上游被停用了）就会出现。
   *
   * 这件事必须说出来。候选集是「已启用档案 ∩ 已启用上游」，而授权面**刻意不限 enabled**
   * （`resolveModelIdsByName` 的注释：停用是临时状态、授权是长期策略）——
   * 于是这里会出现一个看着像"选得到"、其实已经打不通的 tag。不说，用户就会以为
   * 这模型还能用（正是 ADR-0037 要消除的那类"看得见但不生效"）。
   * **不替用户删掉它**：授权是长期策略，档案停用可能只是今天的事，
   * 自动清理等于替人做了一个不可见的长期决定。
   */
  const offList = useMemo(() => {
    if (loading || candidatesFailed) return [];
    const known = new Set(options.map((o) => o.value));
    return (draft ?? []).filter((name) => !known.has(name));
  }, [draft, options, loading, candidatesFailed]);

  return (
    <Drawer
      open={group !== null}
      onClose={onClose}
      width={560}
      title={
        <Space size={tokens.space.sm} wrap>
          <span>模型授权</span>
          {group ? (
            <Text type="secondary" style={{ fontFamily: tokens.font.mono, fontSize: 12, fontWeight: 400 }}>
              {group.name}
            </Text>
          ) : null}
        </Space>
      }
      footer={
        <Space size={tokens.space.sm} style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            loading={isPending(`models:${group?.id ?? ''}`)}
            disabled={draft === undefined || conflict}
            onClick={() => {
              void save();
            }}
          >
            保存
          </Button>
        </Space>
      }
    >
      <Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
        授权是按<strong>模型名</strong>判定的：这个组下的网关 key 只能调用被授权的模型，
        其余一律 403。<Text strong>清空选择 = 不限</Text>（可用全部已启用模型）——
        没有第三种状态，"一个都不许用"请改用禁用整个组。
      </Paragraph>

      {conflict ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: tokens.space.md }}
          message="版本冲突：这个组在你编辑期间被改过"
          description={
            <Space direction="vertical" size={tokens.space.xs}>
              <Text style={{ fontSize: 12 }}>
                授权与配额共用同一个版本号（<Text code style={{ fontSize: 11 }}>revision</Text>），
                别人先改过这个组，所以你这一份改动没写进去（<Text code style={{ fontSize: 11 }}>REVISION_MISMATCH</Text>）。
              </Text>
              <Text style={{ fontSize: 12 }}>
                点下面的「重读最新」拿回服务端当前授权与版本号，再重新选一次 ——
                重读会<strong>丢弃你这次的选择</strong>，这里不替你自动合并（谁合并都可能合掉对方的意思）。
              </Text>
              <Button size="small" loading={isPending(`reread:${groupId ?? ''}`)} onClick={() => { void reread(); }}>
                重读最新
              </Button>
            </Space>
          }
        />
      ) : null}

      {candidatesFailed ? (
        <Alert
          type="warning"
          showIcon
          message="候选模型列表读取失败"
          description={
            <Space direction="vertical" size={tokens.space.xs}>
              <Text style={{ fontSize: 12 }}>授权现状照常显示，但要改动需要候选列表。</Text>
              <Button size="small" onClick={() => { models.reload(); upstreams.reload(); }}>
                重试
              </Button>
            </Space>
          }
        />
      ) : loading ? (
        <LoadingState tip="正在读取授权与候选模型…" minHeight={200} />
      ) : current.error !== null && current.data === null ? (
        <ErrorState
          error={current.error}
          onRetry={current.reload}
          title="授权读取失败（`GET /api/groups/:id/models`）"
        />
      ) : (
        <>
          <div style={{ marginBottom: tokens.space.xs }}>
            <Text strong style={{ fontSize: 13 }}>
              该组可用的模型
            </Text>
            {current.data?.models === null ? (
              <Tag style={{ marginLeft: tokens.space.sm }} color="default">
                当前：不限
              </Tag>
            ) : null}
          </div>
          {offList.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: tokens.space.sm }}
              message={`有 ${offList.length} 个已授权模型当前不可用`}
              description={
                <Text style={{ fontSize: 12 }}>
                  <Text code style={{ fontSize: 11 }}>{offList.join('、')}</Text>
                  {' '}不在「已启用模型档案 ∩ 已启用上游」里，所以在下面的选择框里看不到。
                  它们仍保留在授权中（授权是长期策略，停用可能只是今天的事），
                  但现在打不通 —— 要恢复就把档案/上游重新启用，要去掉就取消勾选后保存
                  （取消勾选会从授权里移除它）。
                </Text>
              }
            />
          ) : null}
          <Select
            mode="multiple"
            style={{ width: '100%' }}
            placeholder="选择该组可调用的模型；留空 = 不限"
            value={draft ?? []}
            onChange={(next: string[]) => setDraft(next)}
            options={[
              // 不在候选集里的已授权名字补一条选项出来，否则 antd 只会渲染它的 raw value，
              // 用户看到一格裸名字、也**没法取消它**（没有对应 option 就点不掉）。
              ...offList.map((name) => ({ value: name, label: `${name}（当前不可用）` })),
              ...options.map((o) => ({ value: o.value, label: o.label })),
            ]}
            optionRender={(option) => {
              const entry = options.find((o) => o.value === option.value);
              const count = entry ? entryCountOf(entry.value) : 0;
              return (
                <Space size={tokens.space.xs}>
                  <span>{option.label}</span>
                  {count > 1 ? (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      （{count} 条档案已授权）
                    </Text>
                  ) : null}
                </Space>
              );
            }}
            allowClear
            maxTagCount="responsive"
            notFoundContent={
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="没有已启用的模型档案。先在「模型档案」页启用，再来授权。"
              />
            }
          />
          {draft !== undefined && draft.length === 0 && current.data?.models !== null ? (
            <Paragraph type="warning" style={{ fontSize: 12, marginTop: tokens.space.sm, marginBottom: 0 }}>
              保存后将清空该组的全部授权行（组恢复为「不限」）。
            </Paragraph>
          ) : null}
          {current.data !== null && current.data.authorizedModels.length > 0 ? (
            <div style={{ marginTop: tokens.space.md }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                当前授权落到 {current.data.authorizedModels.length} 条模型档案：
              </Text>
              <div style={{ marginTop: tokens.space.xs }}>
                {current.data.authorizedModels.map((entry) => (
                  <Tag key={entry.id} style={{ marginBottom: tokens.space.xs }}>
                    {entry.name}
                  </Tag>
                ))}
              </div>
            </div>
          ) : null}
          <Alert
            type="info"
            showIcon
            style={{ marginTop: tokens.space.md, background: tokens.tint.info, border: 'none' }}
            message="改动立即生效"
            description={
              <Text style={{ fontSize: 12, color: tokens.color.textSecondary }}>
                网关按请求实时读授权：保存后该组的 key 打未授权模型会立刻收到 403
                （<Text code style={{ fontSize: 11 }}>MODEL_NOT_AUTHORIZED</Text>），不需要重启或等待。
                授权与配额共用同一个版本号 —— 若保存时提示版本冲突，说明别人刚改过这个组，
                重开抽屉即可拿到最新授权。
              </Text>
            }
          />
        </>
      )}
    </Drawer>
  );
}
