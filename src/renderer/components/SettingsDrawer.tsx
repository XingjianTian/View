import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppConfig, AppInfo, Binding, Device, ObservationSnapshot, ProfileSummary, Service } from '../../shared/contracts.js';
import type { ContainerEntity } from '../../shared/entities.js';
import type { StatusSourceSummary } from '../../shared/status.js';

type Props = {
  epoch: number;
  config: AppConfig;
  info: AppInfo | null;
  observation: ObservationSnapshot;
  refreshing: boolean;
  message: string;
  profiles: ProfileSummary[];
  containers: ContainerEntity[];
  containersLoading: boolean;
  containersError: string;
  onRetryContainers: () => void;
  statusSources: StatusSourceSummary[];
  onConfig: (config: AppConfig) => void;
  onLayout: (layout: AppConfig['display']['layout'], persist?: boolean) => void;
  onFocusSlot: (slotIndex: number, persist?: boolean) => void;
  onRefresh: () => Promise<void>;
  onClose: () => void;
  onMessage: (message: string) => void;
  onRegisterProfile: () => Promise<void>;
};

type Section = 'services' | 'devices' | 'panel' | 'appearance' | 'diagnostics';
type ServiceTab = 'basic' | 'members' | 'source';
type DisplaySaveResult = Awaited<ReturnType<Window['observatory']['saveDisplay']>>;

const navItems: ReadonlyArray<{ id: Section; label: string }> = [
  { id: 'services', label: '服务' },
  { id: 'devices', label: '设备' },
  { id: 'panel', label: '面板与布局' },
  { id: 'appearance', label: '外观与动效' },
  { id: 'diagnostics', label: '诊断与关于' },
];

const layoutOptions: ReadonlyArray<{ layout: AppConfig['display']['layout']; label: string }> = [
  { layout: 'columns4', label: '四列' },
  { layout: 'grid2x2', label: '四宫格' },
  { layout: 'focus', label: '一大三小' },
];

export function SettingsDrawer(props: Props) {
  const { config, observation, profiles, containers, statusSources } = props;
  const [section, setSection] = useState<Section>('services');
  const [serviceId, setServiceId] = useState<string | null>(config.services[0]?.id ?? null);
  const [serviceTab, setServiceTab] = useState<ServiceTab>('basic');
  const [deviceId, setDeviceId] = useState<string | null>(config.devices[0]?.id ?? null);
  const [draft, setDraft] = useState<AppConfig>(() => cloneConfig(config));
  const [baseline, setBaseline] = useState<AppConfig>(() => cloneConfig(config));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [memberQuery, setMemberQuery] = useState('');
  const [deviceDraft, setDeviceDraft] = useState<Device | null>(() => config.devices[0] ? { ...config.devices[0] } : null);
  const lastConfigRef = useRef(config);
  const displaySaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const displaySaveGenerationRef = useRef(0);
  const displayWritePendingRef = useRef(0);
  const displayPreviewDirtyRef = useRef(false);

  useEffect(() => () => {
    displaySaveGenerationRef.current += 1;
  }, []);

  useEffect(() => {
    if (lastConfigRef.current === config) return;
    lastConfigRef.current = config;
    if (dirty) {
      setDraft((current) => {
        const next = cloneConfig(config);
        if (section === 'services' && serviceId) {
          const editing = current.services.find((service) => service.id === serviceId);
          if (editing) next.services = next.services.some((service) => service.id === serviceId) ? next.services.map((service) => service.id === serviceId ? editing : service) : [...next.services, editing];
        }
        if (section === 'devices' && deviceId) {
          const editing = current.devices.find((device) => device.id === deviceId);
          if (editing) next.devices = next.devices.some((device) => device.id === deviceId) ? next.devices.map((device) => device.id === deviceId ? editing : device) : [...next.devices, editing];
        }
        if (section === 'panel') next.slots = current.slots;
        if (section === 'appearance' || section === 'panel') next.display = current.display;
        return next;
      });
      return;
    }
    const next = cloneConfig(config);
    setDraft(next);
    setBaseline(next);
    if (serviceId && !next.services.some((service) => service.id === serviceId)) setServiceId(next.services[0]?.id ?? null);
    if (deviceId && !next.devices.some((device) => device.id === deviceId)) {
      const nextDevice = next.devices[0];
      setDeviceId(nextDevice?.id ?? null);
      setDeviceDraft(nextDevice ? { ...nextDevice } : null);
    }
  }, [config, dirty, deviceId, serviceId]);

  useEffect(() => {
    const selected = draft.devices.find((device) => device.id === deviceId);
    setDeviceDraft(selected ? { ...selected } : null);
  }, [deviceId, draft.devices]);

  const selectedService = draft.services.find((service) => service.id === serviceId);
  const selectedDevice = deviceDraft ?? draft.devices.find((device) => device.id === deviceId);
  const deviceNames = useMemo(() => new Map(draft.devices.map((device) => [device.id, device.name])), [draft.devices]);
  const orderedContainers = useMemo(() => containers.slice().sort((left, right) => `${left.deviceId}:${left.name}`.localeCompare(`${right.deviceId}:${right.name}`)), [containers]);
  const filteredContainers = useMemo(() => {
    const query = memberQuery.trim().toLocaleLowerCase();
    if (!query) return orderedContainers;
    return orderedContainers.filter((container) => `${container.name} ${deviceNames.get(container.deviceId) ?? container.deviceId} ${container.image}`.toLocaleLowerCase().includes(query));
  }, [deviceNames, memberQuery, orderedContainers]);

  const markDraft = (next: AppConfig) => {
    setDraft(next);
    setDirty(true);
    setError('');
  };

  const navigate = (action: () => void) => {
    if (dirty) setPendingLeave(() => action);
    else action();
  };

  const enqueueDisplaySave = (display: AppConfig['display'], generation: number): Promise<DisplaySaveResult> => {
    displayWritePendingRef.current += 1;
    const write = async (): Promise<DisplaySaveResult> => {
      try {
        const result = await window.observatory.saveDisplay(props.epoch, display);
        if (generation === displaySaveGenerationRef.current) {
          if (!result.ok) setError(result.error.message);
          else props.onConfig(result.value);
        }
        return result;
      } catch (cause) {
        const result: DisplaySaveResult = {
          ok: false,
          error: { code: 'internal', message: cause instanceof Error ? cause.message : '显示设置保存失败。' },
        };
        if (generation === displaySaveGenerationRef.current) setError(result.error.message);
        return result;
      } finally {
        displayWritePendingRef.current -= 1;
      }
    };
    const task = displaySaveQueueRef.current.then(write, write);
    displaySaveQueueRef.current = task.then(() => undefined, () => undefined);
    return task;
  };

  const settleDisplayDecision = async (display: AppConfig['display']): Promise<boolean> => {
    const generation = ++displaySaveGenerationRef.current;
    await displaySaveQueueRef.current;
    if (generation !== displaySaveGenerationRef.current) return false;
    const result = await enqueueDisplaySave(display, generation);
    if (!result.ok) return false;
    displayPreviewDirtyRef.current = false;
    return true;
  };

  const persistDisplayDecision = async (display: AppConfig['display']): Promise<boolean> => {
    if (!displayPreviewDirtyRef.current && displayWritePendingRef.current === 0 && sameDisplay(config.display, display)) return true;
    return settleDisplayDecision(display);
  };

  const restorePreview = async (): Promise<boolean> => {
    if (!props.epoch) return true;
    const needsRestore = displayPreviewDirtyRef.current || displayWritePendingRef.current > 0 || !sameDisplay(config.display, baseline.display);
    if (!needsRestore) return true;
    const restored = await persistDisplayDecision(baseline.display);
    if (!restored) props.onMessage('预览设置未能恢复，请重试。');
    return restored;
  };

  const discardAndLeave = async () => {
    setBusy(true);
    try {
      if (!await restorePreview()) return;
      setDraft(cloneConfig(baseline));
      setDirty(false);
      setPendingLeave(null);
      const action = pendingLeave;
      if (action) action();
    } finally {
      setBusy(false);
    }
  };

  const applySavedConfig = (next: AppConfig) => {
    props.onConfig(next);
    setDraft(cloneConfig(next));
    setBaseline(cloneConfig(next));
    setDirty(false);
    setError('');
  };

  const saveCurrent = async (): Promise<boolean> => {
    if (!props.epoch) return false;
    setBusy(true);
    setError('');
    try {
      if (section === 'services') {
        if (!selectedService) { setError('先选择一个服务对象。'); return false; }
        if (props.containersLoading) { setError('容器目录仍在加载，请稍后保存。'); return false; }
        if (props.containersError) { setError('容器目录不完整，请重试后再保存成员变更。'); return false; }
        const result = await window.observatory.saveService(props.epoch, selectedService);
        if (!result.ok) { setError(result.error.message); return false; }
        applySavedConfig(result.value);
        props.onMessage(`已保存服务：${selectedService.name}`);
        return true;
      }
      if (section === 'devices') {
        if (!selectedDevice) { setError('先选择一个设备对象。'); return false; }
        const result = await window.observatory.saveDevice(props.epoch, selectedDevice);
        if (!result.ok) { setError(result.error.message); return false; }
        applySavedConfig(result.value);
        props.onMessage(`已保存设备：${selectedDevice.name}`);
        return true;
      }
      if (section === 'panel') {
        const latest = await window.observatory.getSnapshot(props.epoch);
        if (!latest.ok) { setError(latest.error.message); return false; }
        const merged = mergeSlotDraft(baseline.slots, draft.slots, latest.value.config.slots);
        if (merged.conflicts.length > 0) {
          setError(`槽位 ${merged.conflicts.map((index) => `0${index + 1}`).join('、')} 已被其他更新修改，请重新选择后再保存。`);
          return false;
        }
        if (!await persistDisplayDecision(draft.display)) return false;
        if (sameSlots(merged.slots, latest.value.config.slots)) {
          applySavedConfig({ ...latest.value.config, display: cloneConfig(draft).display });
          props.onMessage('已保存槽位服务配置。');
          return true;
        }
        const result = await window.observatory.setSlots(props.epoch, merged.slots);
        if (!result.ok) { setError(result.error.message); return false; }
        applySavedConfig(result.value);
        props.onMessage('已保存槽位服务配置。');
        return true;
      }
      if (!await persistDisplayDecision(draft.display)) return false;
      setDirty(false);
      setBaseline(cloneConfig(draft));
      props.onMessage('预览设置已保留。');
      return true;
    } finally {
      setBusy(false);
    }
  };

  const saveAndLeave = async () => {
    const action = pendingLeave;
    if (!action) return;
    const saved = await saveCurrent();
    if (!saved) return;
    setPendingLeave(null);
    action();
  };

  const cancelDraft = async () => {
    setBusy(true);
    try {
      if (!await restorePreview()) return;
      setDraft(cloneConfig(baseline));
      setDirty(false);
      setError('');
      const nextDevice = baseline.devices.find((device) => device.id === deviceId);
      setDeviceDraft(nextDevice ? { ...nextDevice } : null);
    } finally {
      setBusy(false);
    }
  };

  const close = () => navigate(props.onClose);
  const chooseSection = (next: Section) => navigate(() => {
    setSection(next);
    setError('');
    if (next === 'services' && !serviceId) setServiceId(draft.services[0]?.id ?? null);
    if (next === 'devices' && !deviceId) setDeviceId(draft.devices[0]?.id ?? null);
  });
  const chooseService = (next: string | null) => navigate(() => { setServiceId(next); setServiceTab('basic'); setMemberQuery(''); });
  const chooseDevice = (next: string) => navigate(() => setDeviceId(next));

  const startNewService = () => navigate(() => {
    const id = uniqueId('service', draft.services.map((service) => service.id));
    const service: Service = { id, name: '新服务', category: '自定义', bindings: [], businessAdapter: { kind: 'none' }, statusAdapter: { kind: 'none' } };
    markDraft({ ...draft, services: [...draft.services, service] });
    setServiceId(id);
    setServiceTab('basic');
  });

  const startNewDevice = () => navigate(() => {
    const profile = profiles.find((item) => item.status === 'available');
    if (!profile) { setError('先登记一个可用 profile。'); return; }
    const device: Device = { id: uniqueId('device', draft.devices.map((item) => item.id)), name: profile.displayName, transport: profile.kind, profileId: profile.id, enabled: true };
    setDeviceId(device.id);
    setDeviceDraft(device);
    markDraft({ ...draft, devices: [...draft.devices, device] });
  });

  const updateService = (patch: Partial<Service>) => {
    if (!selectedService) return;
    markDraft({ ...draft, services: draft.services.map((service) => service.id === selectedService.id ? { ...service, ...patch } : service) });
  };

  const toggleMember = (container: ContainerEntity) => {
    if (!selectedService) return;
    const existing = selectedService.bindings.find((binding) => binding.deviceId === container.deviceId && binding.selector.kind === 'container_id' && binding.selector.value === container.id);
    const bindings = existing ? selectedService.bindings.filter((binding) => binding.id !== existing.id) : [...selectedService.bindings, newContainerBinding(selectedService.id, container, selectedService.bindings)];
    updateService({ bindings });
  };

  const removeBinding = (binding: Binding) => {
    if (selectedService) updateService({ bindings: selectedService.bindings.filter((item) => item.id !== binding.id) });
  };

  const previewDisplay = (display: AppConfig['display']) => {
    markDraft({ ...draft, display });
    displayPreviewDirtyRef.current = true;
    const generation = ++displaySaveGenerationRef.current;
    if (display.layout !== config.display.layout) props.onLayout(display.layout, false);
    if (display.focusSlot !== config.display.focusSlot) props.onFocusSlot(display.focusSlot, false);
    void enqueueDisplaySave(display, generation);
  };

  const updateSlots = (index: number, serviceValue: string) => {
    const slots = draft.slots.map((slot, slotIndex) => slotIndex === index ? { ...slot, serviceId: serviceValue || null } : slot) as AppConfig['slots'];
    markDraft({ ...draft, slots });
  };

  const updateDevice = (patch: Partial<Device>) => {
    if (!selectedDevice) return;
    const next = { ...selectedDevice, ...patch };
    setDeviceDraft(next);
    markDraft({ ...draft, devices: draft.devices.some((device) => device.id === next.id) ? draft.devices.map((device) => device.id === next.id ? next : device) : [...draft.devices, next] });
  };

  const removeService = async (service: Service) => {
    navigate(() => { void (async () => {
      setBusy(true);
      const result = await window.observatory.removeService(props.epoch, service.id);
      setBusy(false);
      if (!result.ok) { setError(result.error.message); return; }
      applySavedConfig(result.value);
      setServiceId(result.value.services[0]?.id ?? null);
      props.onMessage(`已删除服务：${service.name}`);
    })(); });
  };

  const removeDevice = async (device: Device) => {
    navigate(() => { void (async () => {
      setBusy(true);
      const result = await window.observatory.removeDevice(props.epoch, device.id);
      setBusy(false);
      if (!result.ok) { setError(result.error.message); return; }
      applySavedConfig(result.value);
      setDeviceId(result.value.devices[0]?.id ?? null);
      props.onMessage(`已移除设备：${device.name}`);
    })(); });
  };

  const testSelectedDevice = async () => {
    if (!selectedDevice) return;
    setBusy(true);
    const result = await window.observatory.testDevice(props.epoch, selectedDevice);
    setBusy(false);
    if (!result.ok) setError(result.error.message);
    else props.onMessage(result.value.status === 'connected' ? '连接测试通过。' : `连接状态：${result.value.errorCode ?? result.value.status}`);
  };

  return <>
    <aside className="settings-drawer" aria-label="设置">
      <div className="drawer-head settings-drawer-head"><div><h2>设置</h2><p className="settings-summary">{observation.devices.length} 台设备 · {observation.containerPage.total} 个容器 · {config.services.length} 个服务</p></div><button type="button" className="close-button" onClick={close} aria-label="关闭设置">×</button></div>
      <div className="settings-shell">
        <nav className="settings-nav" aria-label="设置类别">{navItems.map((item) => <button type="button" key={item.id} className={section === item.id ? 'settings-nav-item active' : 'settings-nav-item'} aria-current={section === item.id ? 'page' : undefined} onClick={() => chooseSection(item.id)}>{item.label}</button>)}</nav>
        {section === 'services' && <ServiceObjects services={draft.services} selectedId={serviceId} onChoose={chooseService} onNew={startNewService} onRemove={removeService} disabled={busy} />}
        {section === 'devices' && <DeviceObjects devices={draft.devices} selectedId={deviceId} onChoose={chooseDevice} onNew={startNewDevice} onRemove={removeDevice} disabled={busy} />}
        <div className="settings-editor">
          <div className="settings-editor-head"><div>{(section === 'services' || section === 'devices') && <p className="settings-breadcrumb" aria-label="当前位置"><span>{navItems.find((item) => item.id === section)?.label}</span><span aria-hidden="true"> / </span><strong>{section === 'services' ? selectedService?.name ?? '服务对象' : selectedDevice?.name ?? '设备对象'}</strong></p>}<h3>{section === 'services' ? selectedService?.name ?? '服务对象' : section === 'devices' ? selectedDevice?.name ?? '设备对象' : navItems.find((item) => item.id === section)?.label}</h3></div>{dirty && <span className="draft-indicator">草稿未保存</span>}</div>
          {props.message && <p className="settings-feedback" role="status">{props.message}</p>}
          {error && <p className="settings-error" role="alert">{error}</p>}
          {props.containersError && <p className="settings-error" role="alert">{props.containersError} <button type="button" className="text-button" onClick={props.onRetryContainers}>重试</button></p>}
          {section === 'services' && selectedService && <ServiceEditor service={selectedService} tab={serviceTab} onTab={setServiceTab} onChange={updateService} containers={orderedContainers} filteredContainers={filteredContainers} query={memberQuery} onQuery={setMemberQuery} containersLoading={props.containersLoading} onToggleMember={toggleMember} onRemoveBinding={removeBinding} statusSources={statusSources} profiles={profiles} devices={draft.devices} />}
          {section === 'services' && !selectedService && <EmptyEditor text="还没有服务对象。" action="新建服务" onAction={startNewService} />}
          {section === 'devices' && selectedDevice && <DeviceEditor device={selectedDevice} profiles={profiles} onChange={updateDevice} onTest={() => void testSelectedDevice()} busy={busy} services={draft.services} />}
          {section === 'devices' && !selectedDevice && <EmptyEditor text="还没有设备对象。" action="加入设备" onAction={startNewDevice} />}
          {section === 'panel' && <PanelEditor config={draft} onLayout={(layout) => previewDisplay({ ...draft.display, layout })} onFocus={(focusSlot) => previewDisplay({ ...draft.display, focusSlot })} onSlot={updateSlots} />}
          {section === 'appearance' && <AppearanceEditor display={draft.display} onChange={previewDisplay} />}
          {section === 'diagnostics' && <DiagnosticsEditor info={props.info} observation={observation} onRefresh={props.onRefresh} refreshing={props.refreshing} onRegisterProfile={props.onRegisterProfile} />}
        </div>
      </div>
      <div className="settings-footer"><button type="button" className="ghost-button" onClick={() => void cancelDraft()} disabled={!dirty || busy}>取消</button><button type="button" className="solid-button" onClick={() => void saveCurrent()} disabled={!dirty || busy}>{busy ? '保存中…' : '保存'}</button></div>
      <p className="drawer-note">配置与 profile 引用保存在应用数据目录；观测只读访问 Docker。</p>
    </aside>
    {pendingLeave && <div className="leave-dialog-backdrop"><section className="leave-dialog" role="dialog" aria-modal="true" aria-labelledby="leave-dialog-title"><h2 id="leave-dialog-title">草稿尚未保存</h2><p>当前对象有未保存修改，离开前如何处理？</p><div className="leave-actions"><button type="button" className="solid-button" onClick={() => void saveAndLeave()} disabled={busy}>保存并离开</button><button type="button" className="ghost-button" onClick={() => void discardAndLeave()} disabled={busy}>放弃修改</button><button type="button" className="text-button" onClick={() => setPendingLeave(null)}>留在此处</button></div></section></div>}
  </>;
}

function ServiceObjects({ services, selectedId, onChoose, onNew, onRemove, disabled }: { services: Service[]; selectedId: string | null; onChoose: (id: string) => void; onNew: () => void; onRemove: (service: Service) => Promise<void>; disabled: boolean }) {
  return <section className="settings-objects" aria-label="服务对象"><div className="settings-objects-head"><span>服务对象</span><button type="button" className="text-button" onClick={onNew} disabled={disabled}>新建</button></div><div className="settings-object-list">{services.map((service) => <div className={selectedId === service.id ? 'settings-object active' : 'settings-object'} key={service.id}><button type="button" onClick={() => onChoose(service.id)}><strong>{service.name}</strong><small>{service.category} · {service.bindings.length} 个成员</small></button><button type="button" className="object-delete" aria-label={`删除${service.name}`} onClick={() => void onRemove(service)} disabled={disabled}>×</button></div>)}{!services.length && <p className="settings-muted">暂无服务</p>}</div></section>;
}

function DeviceObjects({ devices, selectedId, onChoose, onNew, onRemove, disabled }: { devices: Device[]; selectedId: string | null; onChoose: (id: string) => void; onNew: () => void; onRemove: (device: Device) => Promise<void>; disabled: boolean }) {
  return <section className="settings-objects" aria-label="设备对象"><div className="settings-objects-head"><span>设备对象</span><button type="button" className="text-button" onClick={onNew} disabled={disabled}>新建</button></div><div className="settings-object-list">{devices.map((device) => <div className={selectedId === device.id ? 'settings-object active' : 'settings-object'} key={device.id}><button type="button" onClick={() => onChoose(device.id)}><strong>{device.name}</strong><small>{device.transport} · {device.enabled ? '启用' : '停用'}</small></button><button type="button" className="object-delete" aria-label={`移除${device.name}`} onClick={() => void onRemove(device)} disabled={disabled}>×</button></div>)}{!devices.length && <p className="settings-muted">暂无设备</p>}</div></section>;
}

function ServiceEditor({ service, tab, onTab, onChange, containers, filteredContainers, query, onQuery, containersLoading, onToggleMember, onRemoveBinding, statusSources, profiles, devices }: { service: Service; tab: ServiceTab; onTab: (tab: ServiceTab) => void; onChange: (patch: Partial<Service>) => void; containers: ContainerEntity[]; filteredContainers: ContainerEntity[]; query: string; onQuery: (value: string) => void; containersLoading: boolean; onToggleMember: (container: ContainerEntity) => void; onRemoveBinding: (binding: Binding) => void; statusSources: StatusSourceSummary[]; profiles: ProfileSummary[]; devices: Device[] }) {
  return <div className="object-editor"><div className="local-tabs" role="tablist" aria-label="服务编辑页签"><button type="button" role="tab" aria-selected={tab === 'basic'} className={tab === 'basic' ? 'active' : ''} onClick={() => onTab('basic')}>基本信息</button><button type="button" role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'active' : ''} onClick={() => onTab('members')}>容器成员</button><button type="button" role="tab" aria-selected={tab === 'source'} className={tab === 'source' ? 'active' : ''} onClick={() => onTab('source')}>状态数据源</button></div>{tab === 'basic' && <div className="editor-form"><label><span>服务名称</span><input value={service.name} onChange={(event) => onChange({ name: event.target.value })} /></label><label><span>分类</span><input value={service.category} onChange={(event) => onChange({ category: event.target.value })} /></label><p className="editor-help">服务名称只影响本地配置与面板显示。</p></div>}{tab === 'members' && <MemberEditor service={service} containers={containers} filteredContainers={filteredContainers} devices={devices} query={query} onQuery={onQuery} containersLoading={containersLoading} onToggleMember={onToggleMember} onRemoveBinding={onRemoveBinding} />}{tab === 'source' && <SourceEditor service={service} sources={statusSources} profiles={profiles} onChange={(statusAdapter) => onChange({ statusAdapter })} />}</div>;
}

function MemberEditor({ service, containers, filteredContainers, devices, query, onQuery, containersLoading, onToggleMember, onRemoveBinding }: { service: Service; containers: ContainerEntity[]; filteredContainers: ContainerEntity[]; devices: Device[]; query: string; onQuery: (value: string) => void; containersLoading: boolean; onToggleMember: (container: ContainerEntity) => void; onRemoveBinding: (binding: Binding) => void }) {
  const knownBindings = new Set(service.bindings.flatMap((binding) => binding.selector.kind === 'container_id' ? [`${binding.deviceId}:${binding.selector.value}`] : []));
  const deviceNames = new Map(devices.map((device) => [device.id, device.name]));
  return <div className="member-editor"><label className="member-search"><span>搜索成员</span><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="名称、设备或镜像" /></label><p className="editor-help">勾选新增成员；已有名称或 Compose 绑定会保留，只有明确取消才会移除。</p>{containersLoading && <p className="settings-muted">正在加载完整容器目录…</p>}<div className="member-checklist" aria-label="容器成员列表">{filteredContainers.map((container) => { const selected = knownBindings.has(containerBindingKey(container)); const deviceName = deviceNames.get(container.deviceId) || container.deviceId; return <label className="member-check" key={container.key}><input type="checkbox" checked={selected} onChange={() => onToggleMember(container)} /><span><strong>{container.name}</strong><small>{deviceName} · {container.state}</small></span></label>; })}{!filteredContainers.length && <p className="settings-muted">没有匹配成员。</p>}</div><div className="legacy-bindings"><span className="settings-muted">已登记但当前未发现的绑定</span>{service.bindings.filter((binding) => binding.selector.kind !== 'container_id' || !containers.some((container) => binding.deviceId === container.deviceId && binding.selector.kind === 'container_id' && binding.selector.value === container.id)).map((binding) => <label className="legacy-binding" key={binding.id}><input type="checkbox" checked onChange={() => onRemoveBinding(binding)} /><span>{bindingLabel(binding)}</span><small>保留</small></label>)}</div></div>;
}


function SourceEditor({ service, sources, profiles, onChange }: { service: Service; sources: StatusSourceSummary[]; profiles: ProfileSummary[]; onChange: (adapter: NonNullable<Service['statusAdapter']>) => void }) {
  const current = service.statusAdapter ?? { kind: 'none' as const };
  const value = current.kind === 'none' ? 'none' : sourceKey(current);
  return <div className="source-editor"><p className="editor-help">选择服务的进度来源。未接入时仍显示容器状态。</p><label className="source-option"><input type="radio" name={`status-source-${service.id}`} checked={value === 'none'} onChange={() => onChange({ kind: 'none' })} /><span><strong>未接入</strong><small>未接入业务进度，继续显示容器状态。</small></span></label>{sources.map((source) => { const key = sourceKey(source); const profileName = profiles.find((profile) => profile.id === source.profileId)?.displayName ?? '已登记连接'; return <label className="source-option" key={key}><input type="radio" name={`status-source-${service.id}`} checked={value === key} onChange={() => onChange(sourceAdapter(source))} /><span><strong>{source.displayName}</strong><small>来源于 {profileName}</small></span></label>; })}{!sources.length && <p className="settings-muted">当前没有登记的状态来源。</p>}</div>;
}

function DeviceEditor({ device, profiles, onChange, onTest, busy, services }: { device: Device; profiles: ProfileSummary[]; onChange: (patch: Partial<Device>) => void; onTest: () => void; busy: boolean; services: Service[] }) {
  const profile = profiles.find((item) => item.id === device.profileId);
  const ownership = services.filter((service) => service.bindings.some((binding) => binding.deviceId === device.id));
  return <div className="object-editor editor-form"><label><span>设备名称</span><input value={device.name} onChange={(event) => onChange({ name: event.target.value })} /></label><label><span>连接引用</span><select value={device.profileId} onChange={(event) => { const next = profiles.find((item) => item.id === event.target.value); onChange({ profileId: event.target.value, transport: next?.kind ?? device.transport }); }}><option value="">选择已登记 profile</option>{profiles.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.kind} · {item.status}</option>)}</select></label><p className="editor-help">来源：{profile?.displayName ?? '未找到引用'} · {device.transport}。应用只读取 Docker 状态。</p><button type="button" className="secondary-button" onClick={onTest} disabled={busy || !device.profileId}>只读连接测试</button><div className="ownership-list"><span className="settings-muted">服务归属</span>{ownership.length ? ownership.map((service) => <span key={service.id}>{service.name}</span>) : <span className="settings-muted">暂无绑定服务</span>}</div></div>;
}

function PanelEditor({ config, onLayout, onFocus, onSlot }: { config: AppConfig; onLayout: (layout: AppConfig['display']['layout']) => void; onFocus: (slot: number) => void; onSlot: (index: number, serviceId: string) => void }) {
  return <div className="object-editor"><div className="settings-title"><h4>视图布局</h4><span>立即预览</span></div><div className="choice-row" role="group" aria-label="视图布局">{layoutOptions.map((option) => <button type="button" className={config.display.layout === option.layout ? 'choice active' : 'choice'} aria-pressed={config.display.layout === option.layout} key={option.layout} onClick={() => onLayout(option.layout)}>{option.label}</button>)}</div><div className="choice-row" role="group" aria-label="主槽位"><span className="choice-label">主槽位</span>{config.slots.map((_, index) => <button type="button" className={config.display.focusSlot === index ? 'choice active' : 'choice'} aria-pressed={config.display.focusSlot === index} key={index} onClick={() => onFocus(index)}>0{index + 1}</button>)}</div><div className="slot-list">{config.slots.map((slot, index) => <label className="slot-setting" key={index}><span>槽位 0{index + 1}</span><select value={slot.serviceId ?? ''} onChange={(event) => onSlot(index, event.target.value)}><option value="">空白</option>{config.services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>)}</div></div>;
}

function AppearanceEditor({ display, onChange }: { display: AppConfig['display']; onChange: (display: AppConfig['display']) => void }) {
  return <div className="object-editor"><div className="choice-row"><span className="choice-label">ASCII</span>{(['dynamic', 'static', 'off'] as const).map((mode) => <button type="button" className={display.asciiMode === mode ? 'choice active' : 'choice'} key={mode} onClick={() => onChange({ ...display, asciiMode: mode })}>{mode === 'dynamic' ? '动态' : mode === 'static' ? '静态' : '关'}</button>)}</div><div className="display-controls"><label><span>背景亮度 {display.asciiBrightness}</span><input type="range" min="0" max="100" value={display.asciiBrightness} onChange={(event) => onChange({ ...display, asciiBrightness: Number(event.target.value) })} /></label><label><span>背景强度 {display.asciiStrength}</span><input type="range" min="0" max="100" value={display.asciiStrength} onChange={(event) => onChange({ ...display, asciiStrength: Number(event.target.value) })} /></label><label className="check-setting"><input type="checkbox" checked={display.reducedMotion} onChange={(event) => onChange({ ...display, reducedMotion: event.target.checked })} />减少动态效果</label></div><p className="editor-help">背景预览立即生效；取消会恢复打开设置前的数值。</p></div>;
}

function DiagnosticsEditor({ info, observation, onRefresh, refreshing, onRegisterProfile }: { info: AppInfo | null; observation: ObservationSnapshot; onRefresh: () => Promise<void>; refreshing: boolean; onRegisterProfile: () => Promise<void> }) {
  const [motion, setMotion] = useState<MotionDiagnostics | null>(null);
  useEffect(() => {
    let disposed = false;
    const read = () => {
      if (disposed) return;
      const data = document.querySelector<HTMLCanvasElement>('canvas.ascii-background')?.dataset;
      const next: MotionDiagnostics = {
        state: data?.motionState ?? 'unavailable',
        fps: data?.motionFps ?? '',
        targetFps: data?.motionTargetFps ?? '',
        drawP95Ms: data?.motionDrawP95Ms ?? '',
        frameP95Ms: data?.motionFrameP95Ms ?? '',
        quality: data?.motionQuality ?? '',
        reason: data?.motionReason ?? '背景尚未绘制',
      };
      setMotion((current) => current && sameMotionDiagnostics(current, next) ? current : next);
    };
    read();
    const timer = window.setInterval(read, 1_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  const stateLabel = motionStateLabel(motion?.state);
  return <div className="object-editor diagnostics-editor"><div className="app-info"><span>{info?.displayName ?? '观'} {info?.version ?? '0.1.0'}</span><span>{info?.arch ?? '未知架构'} · {info?.isPackaged ? '打包版' : '开发版'}</span><span>Docker / SSH 只读观测</span></div><dl className="diagnostics-grid"><div><dt>设备</dt><dd>{observation.devices.length}</dd></div><div><dt>已发现容器</dt><dd>{observation.containerPage.total}</dd></div><div><dt>当前服务</dt><dd>{observation.services.length}</dd></div></dl><section className="motion-diagnostics" aria-label="ASCII背景诊断"><div className="settings-title"><h4>ASCII背景</h4><span>{stateLabel}</span></div><dl className="diagnostics-grid"><div><dt>完成绘制</dt><dd>{motion?.fps ? `${motion.fps} 帧/秒` : '等待采样'}</dd></div><div><dt>目标</dt><dd>{motion?.targetFps ? `${motion.targetFps} 帧/秒` : '已停止'}</dd></div><div><dt>降级</dt><dd>{motionQualityLabel(motion?.quality)}</dd></div><div><dt>绘制P95</dt><dd>{motion?.drawP95Ms ? `${motion.drawP95Ms} ms` : '—'}</dd></div><div><dt>帧间隔P95</dt><dd>{motion?.frameP95Ms ? `${motion.frameP95Ms} ms` : '—'}</dd></div></dl><p className="editor-help" role="status">{motion?.reason ?? '正在读取背景状态。'} 每秒更新一次。</p></section><div className="action-row"><button type="button" className="secondary-button" onClick={() => void onRefresh()} disabled={refreshing}>{refreshing ? '刷新中…' : '刷新采样'}</button><button type="button" className="secondary-button" onClick={() => void onRegisterProfile()}>登记私有 profile</button></div></div>;
}

type MotionDiagnostics = { state: string; fps: string; targetFps: string; drawP95Ms: string; frameP95Ms: string; quality: string; reason: string };
function sameMotionDiagnostics(left: MotionDiagnostics, right: MotionDiagnostics) { return JSON.stringify(left) === JSON.stringify(right); }
function motionStateLabel(state: string | undefined) { return state === 'dynamic' ? '运行中' : state === 'degraded-quality' ? '已降低密度' : state === 'degraded-30' ? '已降至30帧' : state === 'static-protected' ? '静态保护' : state === 'paused' ? '已暂停' : state === 'hidden' ? '窗口不可见' : state === 'off' ? '背景已关闭' : state === 'static' ? '静态模式' : '未采样'; }
function motionQualityLabel(quality: string | undefined) { return quality === 'full' ? '完整' : quality === 'reduced-density' ? '降低密度' : quality === '30fps' ? '30帧保护' : '—'; }

function EmptyEditor({ text, action, onAction }: { text: string; action: string; onAction: () => void }) { return <div className="empty-editor"><p>{text}</p><button type="button" className="secondary-button" onClick={onAction}>{action}</button></div>; }

function cloneConfig(config: AppConfig): AppConfig { return structuredClone(config); }
function sameDisplay(left: AppConfig['display'], right: AppConfig['display']): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function sameSlot(left: AppConfig['slots'][number], right: AppConfig['slots'][number]): boolean { return left.serviceId === right.serviceId && left.logBindingId === right.logBindingId; }
function sameSlots(left: AppConfig['slots'], right: AppConfig['slots']): boolean { return left.every((slot, index) => sameSlot(slot, right[index]!)); }
function mergeSlotDraft(baseline: AppConfig['slots'], draft: AppConfig['slots'], latest: AppConfig['slots']): { slots: AppConfig['slots']; conflicts: number[] } {
  const conflicts: number[] = [];
  const slots = latest.map((remoteSlot, index) => {
    const baseSlot = baseline[index]!;
    const draftSlot = draft[index]!;
    const localChanged = !sameSlot(draftSlot, baseSlot);
    const remoteChanged = !sameSlot(remoteSlot, baseSlot);
    if (localChanged && remoteChanged && !sameSlot(draftSlot, remoteSlot)) conflicts.push(index);
    return localChanged && !remoteChanged ? draftSlot : remoteSlot;
  }) as AppConfig['slots'];
  return { slots, conflicts };
}
function uniqueId(prefix: string, existing: readonly string[]): string { const used = new Set(existing); let id = `${prefix}-${Date.now().toString(36)}`; let index = 1; while (used.has(id)) id = `${prefix}-${Date.now().toString(36)}-${index++}`; return id; }
function containerBindingKey(container: ContainerEntity): string { return `${container.deviceId}:${container.id}`; }
function newContainerBinding(serviceId: string, container: ContainerEntity, bindings: readonly Binding[]): Binding { return { id: uniqueId(`${serviceId}-binding`, bindings.map((binding) => binding.id)), deviceId: container.deviceId, selector: { kind: 'container_id', value: container.id }, required: true, expectedPolicy: 'continuous' }; }
function bindingLabel(binding: Binding): string { if (binding.selector.kind === 'container_id') return `${binding.deviceId} · ${binding.selector.value}`; if (binding.selector.kind === 'name') return `${binding.deviceId} · 名称：${binding.selector.value}`; return `${binding.deviceId} · Compose：${binding.selector.project}/${binding.selector.service}${binding.selector.ordinal == null ? '' : ` #${binding.selector.ordinal}`}`; }
function sourceKey(value: NonNullable<Service['statusAdapter']> | StatusSourceSummary): string {
  if (value.kind === 'article_receipt_json' || value.kind === 'ragflow_documents' || value.kind === 'quant_pg_receipts' || value.kind === 'tailscale_status' || value.kind === 'acme_certificates' || value.kind === 'openresty_status') return `${value.kind}:${value.profileId}:${value.sourceRef}`;
  if (value.kind === 'http_json') return `http:${value.profileId}:${value.endpointRef}`;
  return 'none';
}
function sourceAdapter(source: StatusSourceSummary): NonNullable<Service['statusAdapter']> {
  if (source.kind === 'article_receipt_json' || source.kind === 'ragflow_documents' || source.kind === 'quant_pg_receipts' || source.kind === 'tailscale_status' || source.kind === 'acme_certificates' || source.kind === 'openresty_status') return { kind: source.kind, profileId: source.profileId, sourceRef: source.sourceRef };
  return { kind: source.kind, profileId: source.profileId, endpointRef: source.endpointRef, mapping: {} };
}
