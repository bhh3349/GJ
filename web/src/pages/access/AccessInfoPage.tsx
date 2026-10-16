/**
 * 接入信息页 —— 部署自报口径的一屏展示（契约 §18 / ADR-0028）。
 *
 * 数据源：GET /api/access-info（只读、无副作用）。本页零写操作、零实时通道，
 * 唯一动作是「重新读取」。
 *
 * 契约三条硬边界在本页的落法：
 * - 服务端**不回**完整 URL（服务端猜 host 必然猜错）—— 拼接责任在前端：
 *   对外 host = PUBLIC_HOST 配置值，没配就用当前浏览器地址栏的机器名。
 * - 绑定地址（0.0.0.0 / 127.0.0.1）是监听语义不是访问地址 —— 只在「绑定地址」
 *   一行单独展示并说明，绝不与端口拼接。
 * - 本端点刻意不回组密钥（明文只在签发响应出现一次）—— 本页不放任何密钥内容，
 *   只放去「用户组」签发/重置的入口，避免长出第二个密钥读取面。
 */
import { LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import { App, Button, Typography } from 'antd';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { accessInfoApi } from '@/api/endpoints';
import { useResource } from '@/api/hooks';
import type { AccessInfo } from '@/api/types';
import { PageHeader } from '@/components/PageHeader';
import { Panel } from '@/components/Panel';
import { EmptyState, ErrorState, LoadingState } from '@/components/states/StateBlock';
import { tokens } from '@/theme/tokens';

const { Text } = Typography;

/** 一行「标签 + 值」。值用等宽字体，复制场景读得清。 */
function InfoRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: tokens.space.md,
        padding: `${tokens.space.sm}px 0`,
        flexWrap: 'wrap',
      }}
    >
      <Text type="secondary" style={{ fontSize: 12, flex: 'none', width: 72 }}>
        {label}
      </Text>
      <Text
        {...(hint ? { title: hint } : {})}
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 13,
          color: tokens.color.textPrimary,
          wordBreak: 'break-all',
          minWidth: 0,
        }}
      >
        {value}
      </Text>
    </div>
  );
}

/** PUBLIC_HOST 已配置时，把配置值交给用户带去部署环境。 */
function PublicHostCard({ value, onCopy }: { value: string; onCopy: () => void }) {
  return (
    <Panel
      title={
        <span>
          <LinkOutlined style={{ marginRight: tokens.space.sm, color: tokens.color.info }} />
          对外地址已配置
        </span>
      }
      extra={
        <Button size="small" onClick={onCopy}>
          复制
        </Button>
      }
    >
      <Text
        style={{
          fontFamily: tokens.font.mono,
          fontSize: 15,
          color: tokens.color.textPrimary,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </Text>
    </Panel>
  );
}

export function AccessInfoPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  /** 复制失败后的兜底说明开关（剪贴板被浏览器拒时给出手动记录路径）。 */
  const [copyFallbackOpen, setCopyFallbackOpen] = useState(false);

  const resource = useResource<AccessInfo>((signal) => accessInfoApi.get({ signal }), []);

  // 对外 host：PUBLIC_HOST 配置值优先；没配 = 当前浏览器地址栏的机器名（本机部署的兜底）。
  const externalHost = useMemo(() => {
    if (resource.data?.publicHost) return resource.data.publicHost;
    if (typeof window === 'undefined') return null;
    return window.location.hostname;
  }, [resource.data]);

  /**
   * host + 端口拼接。三种输入都要对：
   * - `gw.example.com` → 补端口；`gw.example.com:4000` → 已完整，不动；
   * - IPv6 裸地址 `[::1]`（浏览器 hostname 的原样输出）→ **要**补端口；
   * - IPv6 带端口 `[::1]:4000` → 已完整，不动。
   */
  const joinHostPort = (base: string, port: number): string => {
    if (/]:\d+$/.test(base)) return base;
    if (base.includes(':')) return base.startsWith('[') ? `${base}:${port}` : base;
    return `${base}:${port}`;
  };

  const copyPublicHost = async (): Promise<void> => {
    const value = resource.data?.publicHost ?? '';
    if (value === '') return;
    try {
      await navigator.clipboard.writeText(value);
      message.success('已复制，交给部署的人填进配置文件');
    } catch {
      setCopyFallbackOpen(true);
      message.error('浏览器不允许写入剪贴板，请手动记录');
    }
  };

  if (resource.loading) {
    return (
      <div>
        <PageHeader title="接入信息" />
        <LoadingState tip="正在读取部署信息…" />
      </div>
    );
  }

  if (resource.error !== null && resource.data === null) {
    return (
      <div>
        <PageHeader title="接入信息" />
        <ErrorState error={resource.error} onRetry={resource.reload} minHeight={320} />
      </div>
    );
  }

  const access = resource.data;
  if (access === null) return null;

  const gatewayUrl =
    externalHost === null ? null : joinHostPort(externalHost, access.gateway.portGateway);
  // 管理后台与它的数据接口同源托管时，后台地址就是你当前打开的本页；
  // 未托管时给出数据接口所在地址，仅作核对与排障参考，不再虚构另一个页面地址。
  const adminUrl = access.adminWebDistEnabled
    ? typeof window === 'undefined'
      ? null
      : window.location.origin
    : externalHost === null
      ? null
      : joinHostPort(externalHost, access.admin.portAdmin);

  return (
    <div>
      <PageHeader
        title="接入信息"
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined spin={resource.refreshing} />}
            onClick={resource.reload}
          >
            重新读取
          </Button>
        }
      />

      {access.publicHost !== null ? (
        <div style={{ marginBottom: tokens.space.md }}>
          <PublicHostCard value={access.publicHost} onCopy={() => void copyPublicHost()} />
        </div>
      ) : (
        <div style={{ marginBottom: tokens.space.md }}>
          <Panel title="对外地址未配置">
            <EmptyState
              title="现在用的是当前浏览器所在机器的名字，换机器就变了"
              action={
                <Button
                  size="small"
                  onClick={() => {
                    navigator.clipboard
                      .writeText('PUBLIC_HOST')
                      .then(
                        () => message.success('已复制，交给部署的人填进配置文件'),
                        () => message.error('浏览器不允许复制，记下这个名字：PUBLIC_HOST'),
                      );
                  }}
                >
                  复制配置项名字
                </Button>
              }
              minHeight={120}
            />
          </Panel>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
          gap: tokens.space.md,
          alignItems: 'stretch',
        }}
      >
        <Panel title="网关地址" description="外部程序调用模型服务时填这个地址">
          <InfoRow
            label="接入地址"
            value={gatewayUrl ?? '—'}
            {...(externalHost === null
              ? {}
              : { hint: '配置了对外地址就用它，没配置就用你当前浏览器的机器名' })}
          />
          <InfoRow
            label="绑定地址"
            value={access.gateway.hostGateway}
            hint="这是服务监听的网卡范围，不是给人访问的地址，别把它填进程序配置"
          />
          <InfoRow label="端口" value={String(access.gateway.portGateway)} />
        </Panel>

        <Panel
          title="管理后台"
          description={
            access.adminWebDistEnabled
              ? '后台页面与数据由同一个服务提供，你当前打开的就是它'
              : '后台页面文件不由管理服务托管，当前是开发或另行托管静态文件的部署'
          }
        >
          <InfoRow
            label="后台地址"
            value={adminUrl ?? '—'}
            {...(access.adminWebDistEnabled ? { hint: '当前浏览器地址栏里的地址' } : {})}
          />
          <InfoRow
            label="绑定地址"
            value={access.admin.hostAdmin}
            hint="这是服务监听的网卡范围，不是给人访问的地址"
          />
          <InfoRow label="端口" value={String(access.admin.portAdmin)} />
        </Panel>
      </div>

      <div style={{ marginTop: tokens.space.md }}>
        <Panel
          title="调用密钥从「用户组」签发"
          description="密钥明文只在签发那一刻显示一次，这里不放任何密钥；建组或重置后当场保存"
          extra={
            <Button type="primary" onClick={() => navigate('/groups')}>
              去用户组
            </Button>
          }
        >
          {copyFallbackOpen ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              复制失败时手动记录：对外地址的配置项名字是 PUBLIC_HOST，值就是上面那串。
            </Text>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

export default AccessInfoPage;
