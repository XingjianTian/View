import { useEffect, useMemo, useRef } from 'react';
import type { AppConfig, Service } from '../../shared/contracts.js';
import type { ContainerEntity, ContainerObservation, ServiceObservation } from '../../shared/entities.js';
import type { StatusPage } from '../../shared/status.js';
import { StatusTimeline } from './StatusTimeline.js';

type Props = {
  service: Service;
  observation: ServiceObservation | undefined;
  config: AppConfig;
  containers: ContainerEntity[];
  observations: ContainerObservation[];
  statusPage?: StatusPage | undefined;
  statusLoading?: boolean | undefined;
  onLoadMoreStatus?: (() => void) | undefined;
  trigger: HTMLElement | null;
  onClose: () => void;
};

const statusText: Record<string, string> = {
  ok: '容器正常',
  attention: '需关注',
  neutral: '已停止',
  unknown: '未知',
  unconfigured: '未配置',
};

export function ServiceDetailsDrawer({ service, observation, config, containers, observations, statusPage, statusLoading, onLoadMoreStatus, trigger, onClose }: Props) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const containerMap = useMemo(() => new Map(containers.map((container) => [container.key, container])), [containers]);
  const observationMap = useMemo(() => new Map(observations.map((item) => [item.key, item])), [observations]);
  const deviceName = (deviceId: string) => config.devices.find((device) => device.id === deviceId)?.name ?? deviceId;
  const members = observation?.members ?? [];
  const healthValues = [...new Set(members.map((member) => member.containerKey ? containerMap.get(member.containerKey)?.health : undefined).filter((value): value is ContainerEntity['health'] => value !== undefined))];
  const restartCounts = members.map((member) => member.containerKey ? containerMap.get(member.containerKey)?.restartCount : null).filter((value): value is number => typeof value === 'number');
  const trendObservation = members.find((member) => member.containerKey)?.containerKey;
  const trend = trendObservation ? observationMap.get(trendObservation) : undefined;
  const trendContainer = trendObservation ? containerMap.get(trendObservation) : undefined;
  const trendValues = [...(trend?.history ?? []), ...(trend?.current ? [trend.current] : [])]
    .map((point) => point.cpuPercent)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const networkScope = networkScopeText(members, containerMap, observationMap);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      trigger?.focus();
    };
  }, [trigger]);

  const freshness = observation ? freshnessText(observation.freshness) : '暂无观测';
  const status = observation ? statusText[observation.status] ?? observation.status : '暂无观测';

  return <>
    <button type="button" className="details-backdrop" tabIndex={-1} aria-label="关闭服务详情" onClick={onClose} />
    <aside ref={drawerRef} className="details-drawer" role="dialog" aria-modal="true" aria-labelledby="service-details-title">
      <div className="drawer-head details-head">
        <div>
          <span className="section-label">SERVICE DETAILS</span>
          <h2 id="service-details-title">{service.name}</h2>
          <p className="details-subtitle">{service.category}</p>
        </div>
        <button ref={closeButtonRef} type="button" className="close-button" onClick={onClose} aria-label="关闭详情">×</button>
      </div>

      <section className="details-section details-status" aria-label="当前状态">
        <div className={`status-chip status-${observation?.status ?? 'unknown'}`}>{status}</div>
        <span>{freshness}</span>
        {observation?.errorCode && <strong>{observation.errorCode}</strong>}
        {observation?.observedAt && <time dateTime={observation.observedAt}>观测 {formatTimestamp(observation.observedAt)}</time>}
      </section>

      <section className="details-section" aria-labelledby="details-members-title">
        <div className="details-title"><h3 id="details-members-title">设备与成员</h3><span>{members.length} 个成员</span></div>
        <div className="details-members">
          {members.length ? members.map((member) => {
            const container = member.containerKey ? containerMap.get(member.containerKey) : undefined;
            const current = member.containerKey ? observationMap.get(member.containerKey)?.current : undefined;
            return <div className="details-member" key={member.bindingId}>
              <strong>{deviceName(member.deviceId)}</strong>
              <span>{container?.name ?? member.bindingId}</span>
              <span>{memberStatus(member.status, container?.state, member.reason)}</span>
              <span>{container ? `${healthText(container.health)} · 重启 ${container.restartCount ?? '—'}` : '未绑定容器'}</span>
              {current?.observedAt && <time dateTime={current.observedAt}>采样 {formatTimestamp(current.observedAt)}</time>}
            </div>;
          }) : <p className="details-muted">没有绑定成员。</p>}
        </div>
      </section>

      <section className="details-section" aria-labelledby="details-metrics-title">
        <div className="details-title"><h3 id="details-metrics-title">资源与采样</h3><span>{observation?.sourceAt ? `源 ${formatTimestamp(observation.sourceAt)}` : '暂无源时间'}</span></div>
        <dl className="details-grid">
          <Detail label="CPU" value={formatPercent(observation?.metrics.cpuPercent)} />
          <Detail label="内存" value={formatBytesDetail(observation?.metrics.memoryBytes)} />
          <Detail label="累计接收" value={formatBytesDetail(observation?.metrics.networkRxBytes)} />
          <Detail label="累计发送" value={formatBytesDetail(observation?.metrics.networkTxBytes)} />
          <Detail label="网络口径" value={networkScope} />
          <Detail label="存活时长" value={formatDuration(observation?.uptimeSeconds)} />
          <Detail label="覆盖" value={observation ? `${observation.coverage.observed}/${observation.coverage.required}` : '未知'} />
          <Detail label="Health" value={healthValues.length ? healthValues.map(healthText).join(' / ') : '未配置健康检查'} />
          <Detail label="重启最大值" value={restartCounts.length ? String(Math.max(...restartCounts)) : '未知'} />
        </dl>
        <div className="details-trend"><span>CPU 趋势 · {trendContainer?.name ?? '当前成员'}</span><span>{trendValues.length ? trendValues.slice(-12).map((value) => `${value.toFixed(1)}%`).join(' · ') : '等待真实采样'}</span></div>
      </section>

      <section className="details-section" aria-labelledby="details-business-title">
        <div className="details-title"><h3 id="details-business-title">业务接入</h3><span>{businessStatusText(observation?.business.status)}</span></div>
        <dl className="details-grid details-business">
          <Detail label="范围" value={observation?.business.scopeType ?? '未配置'} />
          <Detail label="范围 ID" value={observation?.business.scopeId ?? '未配置'} />
          <Detail label="总量" value={formatNumber(observation?.business.metrics.total)} />
          <Detail label="成功" value={formatNumber(observation?.business.metrics.succeeded)} />
          <Detail label="失败" value={formatNumber(observation?.business.metrics.failed)} />
          <Detail label="进行中" value={formatNumber(observation?.business.metrics.active)} />
          <Detail label="等待" value={formatNumber(observation?.business.metrics.waiting)} />
          <Detail label="取消" value={formatNumber(observation?.business.metrics.cancelled)} />
        </dl>
        {observation?.business.sourceAt && <time className="details-muted" dateTime={observation.business.sourceAt}>业务源 {formatTimestamp(observation.business.sourceAt)}</time>}
      </section>

      <StatusTimeline mode="detail" page={statusPage} loading={statusLoading} statusAdapterKind={service.statusAdapter?.kind ?? 'none'} onLoadMore={onLoadMoreStatus} />
    </aside>
  </>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function freshnessText(value: ServiceObservation['freshness']): string {
  return value === 'fresh' ? '最新观测' : value === 'stale' ? '数据过期' : value === 'partial' ? '部分覆盖' : '未知新鲜度';
}

function memberStatus(status: string, state: ContainerEntity['state'] | undefined, reason: string | null): string {
  if (status !== 'bound') return reason ?? (status === 'missing-device' ? '设备缺失' : status === 'ambiguous' ? '绑定不明确' : '等待绑定');
  return state === 'running' ? '运行中' : state ? stateText(state) : '状态未知';
}

function stateText(value: ContainerEntity['state']): string {
  return value === 'created' ? '已创建' : value === 'running' ? '运行中' : value === 'paused' ? '已暂停' : value === 'restarting' ? '重启中' : value === 'exited' ? '已退出' : value === 'dead' ? '已失效' : value === 'removing' ? '移除中' : '未知';
}

function healthText(value: ContainerEntity['health']): string {
  return value === 'healthy' ? '健康' : value === 'unhealthy' ? '异常' : value === 'starting' ? '启动中' : value === 'none' ? '未配置' : '未知';
}

function businessStatusText(value: ServiceObservation['business']['status'] | undefined): string {
  return value === 'fresh' ? '最新' : value === 'stale' ? '过期' : value === 'error' ? '接口异常' : value === 'uncomputable' ? '不可计算' : '未接入';
}

function formatTimestamp(value: string): string {
  return value.length >= 19 ? value.slice(11, 19) : value;
}

function formatPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '未知' : `${value.toFixed(1)}%`;
}

function formatBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let amount = Math.max(0, value);
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : amount >= 100 ? 0 : 1;
  return `${amount.toFixed(precision)} ${units[unitIndex]}`;
}

function formatBytesDetail(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '未知';
  return `${formatBytes(value)} · ${Math.round(value).toLocaleString('en-US')} B`;
}

function formatNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '未知' : String(value);
}

function networkScopeText(members: ServiceObservation['members'], containerMap: ReadonlyMap<string, ContainerEntity>, observationMap: ReadonlyMap<string, ContainerObservation>): string {
  const containers = members.flatMap((member) => member.containerKey ? [containerMap.get(member.containerKey)] : []).filter((container): container is ContainerEntity => container !== undefined);
  if (!containers.length) return '未知（无可用成员）';
  const shared = containers.some((container) => {
    const mode = container.networkMode?.toLowerCase() ?? '';
    return mode === 'host' || mode.startsWith('container:') || mode.startsWith('service:');
  });
  if (shared) return '不可汇总（共享网络）';
  const missing = containers.length < members.length || containers.some((container) => {
    const current = observationMap.get(container.key)?.current;
    return current?.networkRxBytes == null || current.networkTxBytes == null;
  });
  return missing ? '部分成员缺项' : '成员累计';
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '未知';
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  if (value < 86400) return `${Math.floor(value / 3600)}h`;
  return `${Math.floor(value / 86400)}d`;
}
