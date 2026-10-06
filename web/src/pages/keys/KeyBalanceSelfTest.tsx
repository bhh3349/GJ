/**
 * Key 余额自测 —— 用该 key 所属上游的**生效查询方式**（用户模板或 preset）打一次，
 * 回诊断（契约 §2 / ADR-0012 §3，不写库）。没有草稿表单：直接跑，结果交给
 * `BalanceTestResultView` 只读渲染。
 *
 * 关键：请求 200 + `ok:false` 是业务性失败（`BalanceTestResult` 正常返回），
 * 只有真正的请求错误（如 422 无查询方式）才进 `catch`。
 */
import { Alert, Modal, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';

import { keysApi } from '@/api/endpoints';
import { describeError } from '@/api/http';
import type { BalanceTestResult } from '@/api/types';
import { BalanceTestResultView } from '@/components/BalanceTestResultView';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

export interface KeyBalanceSelfTestProps {
  open: boolean;
  keyId: string | null;
  maskedKey: string | null;
  onClose: () => void;
}

export function KeyBalanceSelfTest({ open, keyId, maskedKey, onClose }: KeyBalanceSelfTestProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BalanceTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !keyId) return;
    setResult(null);
    setError(null);
    setLoading(true);
    let active = true;
    keysApi
      .testBalance(keyId)
      .then((res) => {
        if (active) setResult(res);
      })
      .catch((reason: unknown) => {
        const { code, message } = describeError(reason);
        if (active) setError(`${message} [${code}]`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, keyId]);

  return (
    <Modal
      open={open}
      title={maskedKey ? `余额自测 · ${maskedKey}` : '余额自测'}
      footer={null}
      onCancel={onClose}
      destroyOnClose
      width={760}
    >
      <Text type="secondary" style={{ fontSize: 12 }}>
        用该 key 所属上游当前生效的查询方式（用户模板或内置 preset）打一次，**不会写库**。
      </Text>
      <div style={{ marginTop: tokens.space.md }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: tokens.space.xl }}>
            <Spin />
            <Text type="secondary" style={{ display: 'block', marginTop: tokens.space.sm }}>
              正在发起查询…
            </Text>
          </div>
        ) : null}
        {error ? <Alert type="error" showIcon message="自测请求失败" description={error} /> : null}
        {result ? <BalanceTestResultView result={result} /> : null}
      </div>
    </Modal>
  );
}
