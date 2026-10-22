import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import type { AppConfig, Service } from '../../shared/contracts.js';
import type { ContainerEntity, ContainerObservation, ObservationPoint, ServiceObservation } from '../../shared/entities.js';
import type { LogSourceState } from '../../shared/logs.js';
import type { StatusPage } from '../../shared/status.js';
import { ServiceIcon } from './ServiceIcon.js';
import { Icon } from './Icon.js';
import { LogViewer } from './LogViewer.js';
import { StatusTimeline } from './StatusTimeline.js';

type Props = {
  service: Service | undefined;
  observation: ServiceObservation | undefined;
  config: AppConfig;
  containers: ContainerEntity[];
  observations: ContainerObservation[];
  logs: LogSourceState[];
  epoch: number;
  slotIndex: number;
  onFocusSlot: (slotIndex: number) => void;
  onOpenDetails: (slotIndex: number, trigger: HTMLButtonElement) => void;
  statusPage?: StatusPage | undefined;
  statusLoading?: boolean | undefined;
  onLoadMoreStatus?: (() => void) | undefined;
};

const statusText: Record<string, string> = { ok: '容器正常', attention: '需关注', neutral: '已停止', unknown: '未知', unconfigured: '未配置' };

export function ServicePanel(props: Props) {
  const areaClass = focusAreaClass(props.config.display.layout, props.config.display.focusSlot, props.slotIndex);
  if (!props.service) return <article className={`service-panel panel-blank ${areaClass}`}><span className="slot-number">0{props.slotIndex + 1}</span><div><h2>选择一个服务</h2><p>打开设置，为这个槽位绑定任意设备与容器组合。</p>{focusButton(props.config.display.layout, props.config.display.focusSlot, props.slotIndex, props.onFocusSlot)}</div></article>;
  return <BoundServicePanel {...props} service={props.service} />;
}

function BoundServicePanel({ service, observation, config, containers, logs, epoch, slotIndex, onFocusSlot, onOpenDetails, statusPage, statusLoading }: Props & { service: Service }) {
  const panelRef = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  const [tabbed, setTabbed] = useState(false);
  const [logToolbarHost, setLogToolbarHost] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<'business' | 'log'>('business');
  const areaClass = focusAreaClass(config.display.layout, config.display.focusSlot, slotIndex);
  const containerMap = useMemo(() => new Map(containers.map((container) => [container.key, container])), [containers]);
  const members = observation?.members ?? [];
  const bindingPolicy = new Map(service.bindings.map((binding) => [binding.id, binding.expectedPolicy]));
  const selectableMembers = members.filter((member) => member.status === 'bound' && !!member.containerKey && containerMap.has(member.containerKey));
  const initialMember = selectableMembers.find((member) => bindingPolicy.get(member.bindingId) === 'continuous') ?? selectableMembers[0];
  const [selectedBindingId, setSelectedBindingId] = useState(initialMember?.bindingId ?? '');
  useEffect(() => {
    if (!selectableMembers.some((member) => member.bindingId === selectedBindingId)) setSelectedBindingId(initialMember?.bindingId ?? '');
  }, [initialMember?.bindingId, selectableMembers, selectedBindingId]);

  const selectedMember = selectableMembers.find((member) => member.bindingId === selectedBindingId) ?? initialMember;
  const primary = selectedMember?.containerKey ? containerMap.get(selectedMember.containerKey) : undefined;
  const logState = primary ? logs.find((log) => log.sourceKey === primary.key) : undefined;
  const deviceName = (deviceId: string) => config.devices.find((device) => device.id === deviceId)?.name ?? deviceId;
  const deviceNames = [...new Set(members.map((member) => deviceName(member.deviceId)))];
  const deviceSummary = summarizeDevices(deviceNames);
  const deviceFullLabel = deviceNames.join(' / ') || '未配置设备';
  const memberNames = members.map((member) => containerMap.get(member.containerKey ?? '')?.name ?? member.reason ?? member.bindingId);
  const memberFullLabel = memberNames.join(' / ') || '暂无成员';
  const statusLabel = statusText[observation?.status ?? 'unknown'] ?? '未知';
  const isUnconfigured = observation?.status === 'unconfigured';
  const unresolvedBinding = observation?.errorCode === 'binding_unresolved';
  const statusNote = isUnconfigured ? ''
    : unresolvedBinding ? '绑定未解析'
      : observation?.errorCode ? '采样异常'
        : observation?.freshness === 'stale' ? '数据过期'
          : observation?.freshness === 'partial' ? '部分覆盖'
            : '';
  const statusTone = observation?.status === 'ok' && statusNote ? 'attention' : observation?.status ?? 'unknown';
  const statusIcon = statusTone === 'ok' ? 'check' : statusTone === 'attention' ? 'warning' : statusTone === 'neutral' ? 'cross' : statusTone === 'unconfigured' ? 'minus' : 'question';
  const statusDescription = statusLabel + (statusNote ? `，${statusNote}` : '');
  const nameLimit = compact ? (areaClass.includes('panel-focus-small') ? 18 : 24) : areaClass.includes('panel-focus-small') ? 36 : 64;
  const isLongName = service.name.length > nameLimit;
  const displayName = isLongName ? `${service.name.slice(0, Math.max(12, nameLimit - 1))}…` : service.name;
  const openDetails = (event: MouseEvent<HTMLButtonElement>) => onOpenDetails(slotIndex, event.currentTarget);
  const sourceOptions = selectableMembers.map((member) => ({
    value: member.bindingId,
    label: `${containerMap.get(member.containerKey as string)?.name ?? member.bindingId} · ${deviceName(member.deviceId)}`,
  }));

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === 'undefined') return;
    const updateDensity = () => {
      const rect = panel.getBoundingClientRect();
      const next = rect.width < 430 || rect.height < 360;
      setCompact((current) => current === next ? current : next);
      setTabbed(rect.width < 560 && rect.height < 440);
    };
    updateDensity();
    const observer = new ResizeObserver(updateDensity);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  return <article ref={panelRef} className={`service-panel panel-${observation?.status ?? 'unknown'} ${areaClass}${compact ? ' panel-compact' : ''}`}>
    <header className="panel-head">
      <div className="panel-identity">
        <button type="button" className="service-title-button" onClick={openDetails} aria-label={`打开${service.name}详情`}><h2><ServiceIcon service={service} /><span>{displayName}</span></h2></button>
        {isLongName && <button type="button" className="full-name-button" onClick={openDetails}>完整名称</button>}
        <div className="panel-meta">
          <button type="button" className="device-summary" onClick={openDetails} title={`设备：${deviceFullLabel}`} aria-label={`打开${service.name}详情，设备：${deviceFullLabel}`}><span>{deviceSummary}</span></button>
          <button type="button" className="member-summary" onClick={openDetails} title={`成员：${memberFullLabel}`} aria-label={`打开${service.name}详情，成员：${memberFullLabel}`}><span>{members.length} 成员</span></button>
        </div>
      </div>
      <div className="panel-head-actions">{focusButton(config.display.layout, config.display.focusSlot, slotIndex, onFocusSlot)}<button type="button" className={`status-chip status-${statusTone}`} title={statusDescription} onClick={openDetails} aria-label={`打开${service.name}详情，状态：${statusLabel}${statusNote ? `，${statusNote}` : ''}`}><Icon name={statusIcon} /></button><button type="button" className="detail-button" onClick={openDetails} aria-label={`打开${service.name}详情`} title="打开详情">⋮</button></div>
    </header>
    <div className="metric-row"><Metric label="CPU" value={observation?.metrics.cpuPercent == null ? '未知' : `${observation.metrics.cpuPercent.toFixed(1)}%`} /><Metric label="内存" value={formatBytes(observation?.metrics.memoryBytes)} /><Metric label="最短存活" value={formatDuration(observation?.uptimeSeconds)} /></div>
    <div className={`panel-content-grid${tabbed ? ' panel-content-tabbed' : ''}`} data-panel-content={content}>
      {tabbed && <div className="panel-content-switch" role="group" aria-label={`${service.name}卡片内容`}><button type="button" aria-pressed={content === 'business'} onClick={() => setContent('business')}>业务</button><button type="button" aria-pressed={content === 'log'} onClick={() => setContent('log')}>日志</button><div className="panel-log-actions" ref={setLogToolbarHost} hidden={content !== 'log'} /></div>}
      <StatusTimeline mode="panel" page={statusPage} loading={statusLoading} previewLimit={tabbed ? 1 : 3} statusAdapterKind={service.statusAdapter?.kind ?? 'none'} onOpenDetails={(trigger) => onOpenDetails(slotIndex, trigger)} />
      <LogViewer toolbarTarget={tabbed ? logToolbarHost : null} epoch={epoch} container={primary} deviceName={primary ? deviceName(primary.deviceId) : undefined} initialState={logState} sourceOptions={sourceOptions.length > 1 ? sourceOptions : undefined} sourceValue={selectedBindingId} onSourceChange={setSelectedBindingId} />
    </div>
  </article>;
}

function focusAreaClass(layout: AppConfig['display']['layout'], focusSlot: number, slotIndex: number): string {
  if (layout !== 'focus') return '';
  if (slotIndex === focusSlot) return 'panel-focus-main';
  let smallIndex = 1;
  for (let index = 0; index < 4; index += 1) {
    if (index === focusSlot) continue;
    if (index === slotIndex) return `panel-focus-small panel-focus-small-${smallIndex}`;
    smallIndex += 1;
  }
  return '';
}

function focusButton(layout: AppConfig['display']['layout'], focusSlot: number, slotIndex: number, onFocusSlot: (slotIndex: number) => void) {
  if (layout !== 'focus' || focusSlot === slotIndex) return null;
  return <button type="button" className="focus-button" aria-label="设为主视图" title="设为主视图" onClick={(event) => { event.stopPropagation(); onFocusSlot(slotIndex); }}><Icon name="arrow-up" /></button>;
}

function Metric({ label, value, note }: { label: string; value: string; note?: string | undefined }) { return <div className="metric"><span>{label}{note && <small className="metric-qualifier">{note}</small>}</span><strong>{value}</strong></div>; }

export type TrendSample = ObservationPoint | null;

export function trendPoints(observation: ContainerObservation | undefined): TrendSample[] {
  if (!observation) return [];
  const byTime = new Map<string, { observedAt: string; sample: TrendSample; order: number }>();
  [...observation.history, ...(observation.current ? [observation.current] : [])].forEach((point, order) => {
    const key = point.observedAt || `invalid-${order}`;
    const timestamp = Date.parse(point.observedAt);
    const usable = point.freshness === 'fresh'
      && Number.isFinite(timestamp)
      && point.cpuPercent != null
      && Number.isFinite(point.cpuPercent);
    byTime.set(key, { observedAt: point.observedAt, sample: usable ? point : null, order });
  });
  return [...byTime.values()]
    .sort((left, right) => {
      const leftTime = Date.parse(left.observedAt);
      const rightTime = Date.parse(right.observedAt);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return leftTime - rightTime;
      if (Number.isFinite(leftTime)) return -1;
      if (Number.isFinite(rightTime)) return 1;
      return left.order - right.order;
    })
    .slice(-12)
    .map((entry) => entry.sample);
}

export function trendSegments(samples: TrendSample[]): ObservationPoint[][] {
  const points = samples.filter((sample): sample is ObservationPoint => sample !== null);
  if (points.length < 2) return points.length ? [points] : [];
  const intervals = points.slice(1).map((point, index) => Date.parse(point.observedAt) - Date.parse(points[index]?.observedAt ?? '')).filter((value) => value > 0);
  const expected = intervals.length ? Math.min(...intervals) : 0;
  const threshold = expected > 0 ? expected * 2.25 : Number.POSITIVE_INFINITY;
  const segments: ObservationPoint[][] = [];
  let currentSegment: ObservationPoint[] = [];
  let previous: ObservationPoint | undefined;
  for (const sample of samples) {
    if (!sample) {
      if (currentSegment.length) segments.push(currentSegment);
      currentSegment = [];
      previous = undefined;
      continue;
    }
    const gap = previous ? Date.parse(sample.observedAt) - Date.parse(previous.observedAt) : 0;
    if (currentSegment.length && gap > threshold) {
      segments.push(currentSegment);
      currentSegment = [];
    }
    currentSegment.push(sample);
    previous = sample;
  }
  if (currentSegment.length) segments.push(currentSegment);
  return segments;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '未知';
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m`;
  if (value < 86400) return `${Math.floor(value / 3600)}h`;
  return `${Math.floor(value / 86400)}d`;
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

function summarizeDevices(names: readonly string[]): string {
  if (!names.length) return '未配置设备';
  if (names.length === 1) return deviceDisplayName(names[0]!);
  return `${deviceDisplayName(names[0]!)} · ${names.length} 台设备`;
}

function deviceDisplayName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, '');
  return normalized === 'NAS只读设备' ? 'NAS' : shortLabel(value, 14);
}

function shortLabel(value: string, limit: number): string {
  const normalized = value.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(6, limit - 1))}…`;
}
