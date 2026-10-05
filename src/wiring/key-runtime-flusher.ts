// 网关适配层 - `key_runtime` 运行态镜像：把 KeyPool 的内存健康态周期刷进共享 SQLite。
//
// 决策依据：ADR-0010（方案 C）。方向是**单向**的，别搞反：
//   KeyPool（进程内存，权威）──本文件──▶ key_runtime（SQLite）──LEFT JOIN──▶ /api/keys（只读展示）
//
// 为什么要有它：在本文件出现之前，全仓没有一行代码写 `key_runtime`（`keys.ts`/`models.ts` 只
// LEFT JOIN 读）。于是管理端 `?health=cooling` 恒空、仪表盘健康灯恒绿 —— 契约 §3 的四个字段在
// 可观测层面是**假数据**，不是"暂时没数据"。也不是"重启会丢"：是从来没有过。
//
// 三条纪律，重构时别弄丢：
//   1. **绝不在 `/v1/*` 请求线程上写**。只有定时器与退出时的 `close()` 会碰 SQL；
//      `reportSuccess/reportFailure` 是纯内存操作（热路径零同步 DB 写，契约 §9）。
//   2. 只写**值真的变了**的行，且差集在内存里比：成功一次会把 `consecutiveFails` 归零，
//      若每 tick 全量写，健康 key 会按 QPS 产生无意义的写放大。
//   3. **不参与冷启动**（ADR-0010 §3）：启动时 `lastWritten` 是空的 = 全量标脏，第一个周期
//      （≤1s）把上一进程遗留的陈旧行纠正过来（冷却可能还停在未来，不纠正就是假数据）。
//      恢复冷却只会让池子更保守 —— 最坏"重启后 30min 全站 503"是无界可用性损失，
//      而不恢复的代价有界（每把坏 key 最多吃一次失败，被 `maxAttempts` 覆盖）。
//
// `failCount`（进程内累计失败总数）**不落库**：表里只存 `consecutive_failures`（连续失败），
// 累计数只出现在 `/internal/snapshot`。这样"重启后累计数归零"是契约内行为，不是背离。

import { upsertKeyRuntimeStates } from '../db/repo/key-runtime.js';
import type { KeyRuntimeStateRow } from '../db/repo/key-runtime.js';
import type { Db } from '../db/database.js';
import type { KeyRuntimeState } from '../gateway/types.js';

/** 镜像间隔。契约 §9 / ADR-0010 冻结：约 1s（管理端新鲜度预算 5s，见验收 ③） */
const DEFAULT_FLUSH_INTERVAL_MS = 1000;

/** 只声明用得到的那一面：这层不需要知道 KeyPool 还能做什么 */
export interface KeyPoolView {
  view(): KeyRuntimeState[];
}

export interface KeyRuntimeFlusherOptions {
  db: Db;
  pool: KeyPoolView;
  /** 刷写间隔，默认 1000ms */
  flushIntervalMs?: number;
  /** 刷写异常回调（只传错误对象；池状态本身不含明文，但仍不该进日志） */
  onError?: (err: unknown) => void;
}

export interface KeyRuntimeFlusher {
  /** 立即刷写差集，返回本次写入行数（测试/退出时用） */
  flush(): number;
  /** 累计成功写入的行数（观测用；不是"当前表里有多少行"） */
  written(): number;
  /** 停定时器 + 最后一次 flush */
  close(): void;
}

/** 落库字段的等价签名：只含会被写进 `key_runtime` 的四列，`failCount`/`inflight` 刻意不含 */
function signatureOf(row: KeyRuntimeStateRow): string {
  return [row.consecutiveFails, row.cooldownUntilMs ?? '', row.lastFailureReason ?? '', row.lastFailureAtMs ?? ''].join('|');
}

export function createKeyRuntimeFlusher(options: KeyRuntimeFlusherOptions): KeyRuntimeFlusher {
  const { db, pool } = options;
  const flushIntervalMs = Math.max(1, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);

  /**
   * 上次**成功写入**的签名。空表 = 启动态 = 全量标脏（ADR-0010 §4），
   * 所以这里不需要额外的 dirty 标志：没记账过就是脏的。
   */
  const lastWritten = new Map<string, string>();
  let writtenCount = 0;

  function flush(): number {
    const changed: KeyRuntimeStateRow[] = [];
    const changedSigs = new Map<string, string>();
    const live = new Set<string>();

    for (const rt of pool.view()) {
      live.add(rt.keyId);
      const row: KeyRuntimeStateRow = {
        keyId: rt.keyId,
        consecutiveFails: rt.consecutiveFails,
        // KeyPool 内部用 epoch ms，ISO8601 UTC 的转换只在仓储里发生（契约 §0.2）
        cooldownUntilMs: rt.cooldownUntil,
        lastFailureReason: rt.lastFailureReason,
        lastFailureAtMs: rt.lastFailureAt,
      };
      const sig = signatureOf(row);
      if (lastWritten.get(rt.keyId) === sig) continue; // 值没变 → 不写
      changed.push(row);
      changedSigs.set(rt.keyId, sig);
    }

    // 池里已经没有的 key（被软删/移出快照）：清本地记账即可。
    // 表里的残留行**不删** —— 本函数只 upsert，清理规则记在 ADR-0010「已知缺口」，归 M4。
    for (const keyId of [...lastWritten.keys()]) {
      if (!live.has(keyId)) lastWritten.delete(keyId);
    }

    if (changed.length === 0) return 0;

    try {
      const n = upsertKeyRuntimeStates(db, changed);
      // 只有**真写成功**才推进记账：失败时保留旧签名，下一 tick 会重试。
      // 反过来（乐观推进）会让镜像永久停在这一版，且表面上看不出任何异常。
      for (const [keyId, sig] of changedSigs) lastWritten.set(keyId, sig);
      writtenCount += n;
      return n;
    } catch (err) {
      // 真异常（schema 不对 / 磁盘故障），不是忙等（busy_timeout 已配 5s）。
      // 镜像不是账，丢一拍可以；但绝不能抛到调用方（定时器上抛会打挂进程）。
      options.onError?.(err);
      return 0;
    }
  }

  const timer = setInterval(() => {
    flush();
  }, flushIntervalMs);
  // 别吊住进程退出：退出前由 runtime.ts / server.ts 显式 close()
  if (typeof timer.unref === 'function') timer.unref();

  return {
    flush,
    written: () => writtenCount,
    close(): void {
      clearInterval(timer);
      flush();
    },
  };
}
