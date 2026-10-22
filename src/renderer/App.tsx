import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AppConfig, AppInfo, DisplayPrefs, SnapshotPage } from '../shared/contracts.js';
import type { ContainerEntity } from '../shared/entities.js';
import type { StatusPage, StatusSourceSummary } from '../shared/status.js';
import { AsciiBackground } from './components/AsciiBackground.js';
import { ServicePanel } from './components/ServicePanel.js';
import { ServiceDetailsDrawer } from './components/ServiceDetailsDrawer.js';
import { SettingsDrawer } from './components/SettingsDrawer.js';
import { motionEnabled, usePerformanceProtected, useSystemReducedMotion } from './motion.js';
import { mergeStatusPage } from './status-helpers.js';
import { acceptsVisibilityQuery } from './window-visibility.js';

type Layout = AppConfig['display']['layout'];
type DisplayUpdate = Pick<DisplayPrefs, 'layout' | 'focusSlot'>;
type DisplayPatch = Partial<DisplayUpdate>;

export default function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotPage | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlightRef = useRef(false);
  const [settingsContainers, setSettingsContainers] = useState<ContainerEntity[]>([]);
  const [settingsContainersLoading, setSettingsContainersLoading] = useState(false);
  const [settingsContainersError, setSettingsContainersError] = useState('');
  const [settingsContainersReload, setSettingsContainersReload] = useState(0);
  const [statusPages, setStatusPages] = useState<Record<string, StatusPage>>({});
  const [statusLoading, setStatusLoading] = useState<Record<string, boolean>>({});
  const [statusSources, setStatusSources] = useState<StatusSourceSummary[]>([]);
  const [detailsSlot, setDetailsSlot] = useState<number | null>(null);
  const [windowVisible, setWindowVisible] = useState(true);
  const systemReducedMotion = useSystemReducedMotion();
  const performanceProtected = usePerformanceProtected();
  const dashboardRef = useRef<HTMLElement>(null);
  const configRef = useRef<AppConfig | undefined>(undefined);
  const displayUpdateRef = useRef<DisplayUpdate | null>(null);
  const displayInFlightTargetRef = useRef<DisplayUpdate | null>(null);
  const displaySaveInFlightRef = useRef(false);
  const pendingPanelRectsRef = useRef<Map<number, DOMRect> | null>(null);
  const transitionFrameRef = useRef<number | undefined>(undefined);
  const panelAnimationsRef = useRef<Array<{ panel: HTMLElement; animation: Animation }>>([]);
  const detailsTriggerRef = useRef<HTMLElement | null>(null);
  const statusLoadingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let disposed = false;
    void window.observatory.bootstrap().then((result) => {
      if (disposed) return;
      if (!result.ok) { setMessage(result.error.message); return; }
      setInfo(result.value.info);
      setSnapshot(result.value.snapshot);
    }).catch(() => { if (!disposed) setMessage('应用尚未准备好，请稍后重试。'); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const epoch = snapshot?.windowEpoch;
      if (!epoch) return;
      void window.observatory.getSnapshot(epoch).then((result) => { if (result.ok) setSnapshot(result.value); });
    }, 30000);
    return () => window.clearInterval(timer);
  }, [snapshot?.windowEpoch]);

  useEffect(() => {
    setStatusPages({});
    setStatusLoading({});
    statusLoadingRef.current.clear();
  }, [snapshot?.windowEpoch]);

  const loadStatusPage = async (serviceId: string, cursor?: string) => {
    const currentEpoch = snapshot?.windowEpoch;
    if (!currentEpoch || statusLoadingRef.current.has(`${serviceId}:${cursor ?? 'first'}`)) return;
    const requestKey = `${serviceId}:${cursor ?? 'first'}`;
    statusLoadingRef.current.add(requestKey);
    setStatusLoading((current) => ({ ...current, [serviceId]: true }));
    try {
      const result = await window.observatory.getStatusPage(currentEpoch, serviceId, cursor, 40);
      if (!result.ok) {
        setMessage(result.error.message);
        return;
      }
      setStatusPages((current) => ({ ...current, [serviceId]: mergeStatusPage(current[serviceId], result.value, !cursor) }));
    } finally {
      statusLoadingRef.current.delete(requestKey);
      setStatusLoading((current) => ({ ...current, [serviceId]: false }));
    }
  };

  useEffect(() => {
    const currentEpoch = snapshot?.windowEpoch;
    const visibleServiceIds = [...new Set((snapshot?.config.slots ?? []).map((slot) => slot.serviceId).filter((value): value is string => !!value))];
    if (!currentEpoch || visibleServiceIds.length === 0) return () => undefined;
    let disposed = false;
    const read = async () => {
      for (const serviceId of visibleServiceIds) {
        if (disposed) return;
        await loadStatusPage(serviceId);
      }
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, 8_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [snapshot?.windowEpoch, snapshot?.config?.slots.map((slot) => slot.serviceId).join('|')]);

  useEffect(() => {
    const currentEpoch = snapshot?.windowEpoch;
    if (!settingsOpen || !currentEpoch) return () => undefined;
    let disposed = false;
    void window.observatory.listStatusSources(currentEpoch).then((result) => {
      if (disposed || !result.ok) return;
      setStatusSources(result.value);
    });
    return () => { disposed = true; };
  }, [settingsOpen, snapshot?.windowEpoch]);

  useEffect(() => {
    const epoch = snapshot?.windowEpoch;
    const currentObservation = snapshot?.observation;
    if (!settingsOpen || !epoch || !currentObservation) {
      setSettingsContainersLoading(false);
      setSettingsContainersError('');
      return () => undefined;
    }
    let disposed = false;
    setSettingsContainersLoading(true);
    setSettingsContainersError('');
    const loadContainerDirectory = async () => {
      try {
        const merged = new Map<string, ContainerEntity>(currentObservation.containers.map((container) => [container.key, container]));
        let offset = currentObservation.containerPage.nextOffset;
        const limit = 32;
        for (let pageIndex = 0; pageIndex < 512; pageIndex += 1) {
          if (offset >= currentObservation.containerPage.total) break;
          const result = await window.observatory.getSnapshotPage(epoch, 0, 32, offset, limit);
          if (disposed) return;
          if (!result.ok) {
            setSettingsContainersError('容器目录尚未完整加载，现有绑定已保留；请重试后再编辑成员。');
            return;
          }
          for (const container of result.value.observation.containers) merged.set(container.key, container);
          const page = result.value.observation.containerPage;
          if (page.capacityExceeded) setSettingsContainersError('容器目录容量不足，现有绑定已保留；请减少面板绑定后重试。');
          if (!page.hasMore) break;
          const nextOffset = page.nextOffset;
          if (nextOffset <= offset) break;
          offset = nextOffset;
        }
        if (!disposed) setSettingsContainers([...merged.values()]);
      } finally {
        if (!disposed) setSettingsContainersLoading(false);
      }
    };
    setSettingsContainers([...currentObservation.containers]);
    void loadContainerDirectory();
    return () => { disposed = true; };
  }, [settingsOpen, snapshot?.windowEpoch, settingsContainersReload]);

  useEffect(() => {
    const epoch = snapshot?.windowEpoch;
    if (!epoch) return () => undefined;
    const removeListener = window.observatory.onUpdates((update) => {
      const payload = update.payload as { items?: Array<{ kind?: string; payload?: { observation?: SnapshotPage['observation'] } }> };
      const item = payload.items?.find((candidate) => candidate.kind === 'observations');
      const nextObservation = item?.payload?.observation;
      if (nextObservation) setSnapshot((current) => current ? { ...current, observation: nextObservation } : current);
    });
    void window.observatory.subscribeUpdates(epoch);
    return () => {
      removeListener();
      void window.observatory.unsubscribeUpdates(epoch);
    };
  }, [snapshot?.windowEpoch]);

  useEffect(() => {
    const currentEpoch = snapshot?.windowEpoch;
    if (!currentEpoch) {
      setWindowVisible(true);
      return () => undefined;
    }
    let disposed = false;
    let notificationVersion = 0;
    setWindowVisible(true);
    // Subscribe before querying. A native hide/show event can arrive between
    // the query and its resolution; the version guard keeps that event ahead
    // of a stale query result from the same window epoch.
    const removeListener = window.observatory.onWindowVisibility((visibility) => {
      if (disposed || visibility.windowEpoch !== currentEpoch) return;
      notificationVersion += 1;
      setWindowVisible(visibility.visible);
    });
    const queryVersion = notificationVersion;
    void window.observatory.getWindowVisibility(currentEpoch).then((result) => {
      if (disposed || !acceptsVisibilityQuery(result, currentEpoch, queryVersion, notificationVersion) || !result.ok) return;
      setWindowVisible(result.value.visible);
    });
    return () => {
      disposed = true;
      removeListener();
    };
  }, [snapshot?.windowEpoch]);

  const epoch = snapshot?.windowEpoch ?? 0;
  const config = snapshot?.config;
  const observation = snapshot?.observation;
  useEffect(() => {
    configRef.current = config;
  }, [config]);
  const devices = config?.devices ?? [];
  const services = config?.services ?? [];

  const cancelPanelAnimations = () => {
    if (transitionFrameRef.current !== undefined) {
      window.cancelAnimationFrame(transitionFrameRef.current);
      transitionFrameRef.current = undefined;
    }
    for (const { panel, animation } of panelAnimationsRef.current) {
      animation.cancel();
      panel.style.willChange = '';
    }
    panelAnimationsRef.current = [];
  };

  const capturePanelRects = () => {
    const rects = new Map<number, DOMRect>();
    dashboardRef.current?.querySelectorAll<HTMLElement>('.service-panel').forEach((panel, index) => {
      rects.set(index, panel.getBoundingClientRect());
    });
    return rects;
  };

  const animatePanelLayout = (before: Map<number, DOMRect>) => {
    cancelPanelAnimations();
    if (!dashboardRef.current || !config || !motionEnabled(config.display.asciiMode, config.display.reducedMotion, systemReducedMotion, performanceProtected) || document.hidden) return;
    transitionFrameRef.current = window.requestAnimationFrame(() => {
      transitionFrameRef.current = undefined;
      const panels = [...(dashboardRef.current?.querySelectorAll<HTMLElement>('.service-panel') ?? [])];
      for (const [index, panel] of panels.entries()) {
        const from = before.get(index);
        const to = panel.getBoundingClientRect();
        if (!from || (Math.abs(from.left - to.left) < 0.5 && Math.abs(from.top - to.top) < 0.5)) continue;
        const deltaX = from.left - to.left;
        const deltaY = from.top - to.top;
        const animation = panel.animate(
          [{ transform: 'translate(' + deltaX + 'px, ' + deltaY + 'px)' }, { transform: 'translate(0, 0)' }],
          { duration: 220, easing: 'cubic-bezier(.22,.8,.24,1)', fill: 'both' },
        );
        panel.style.willChange = 'transform';
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          animation.cancel();
          panel.style.willChange = '';
          panelAnimationsRef.current = panelAnimationsRef.current.filter((item) => item.animation !== animation);
        };
        animation.onfinish = cleanup;
        animation.oncancel = cleanup;
        panelAnimationsRef.current.push({ panel, animation });
      }
    });
  };

  useLayoutEffect(() => {
    const before = pendingPanelRectsRef.current;
    pendingPanelRectsRef.current = null;
    if (before) animatePanelLayout(before);
  }, [config?.display.layout, config?.display.focusSlot]);

  useEffect(() => {
    if (!config || motionEnabled(config.display.asciiMode, config.display.reducedMotion, systemReducedMotion, performanceProtected)) return;
    cancelPanelAnimations();
  }, [config?.display.asciiMode, config?.display.reducedMotion, systemReducedMotion, performanceProtected]);

  useEffect(() => {
    const handleVisibility = () => { if (document.hidden) cancelPanelAnimations(); };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  useEffect(() => () => {
    pendingPanelRectsRef.current = null;
    cancelPanelAnimations();
  }, []);

  const setConfig = (next: typeof config) => {
    if (!next) return;
    configRef.current = next;
    setSnapshot((current) => current ? { ...current, config: next } : current);
  };

  const flushDisplayUpdate = () => {
    if (displaySaveInFlightRef.current || !displayUpdateRef.current || !epoch) return;
    displaySaveInFlightRef.current = true;
    void (async () => {
      try {
        while (displayUpdateRef.current) {
          const current = configRef.current;
          if (!current) { displayUpdateRef.current = null; break; }
          const requested = displayUpdateRef.current;
          displayUpdateRef.current = null;
          displayInFlightTargetRef.current = requested;
          pendingPanelRectsRef.current = capturePanelRects();
          const result = await window.observatory.saveDisplay(epoch, { ...current.display, ...requested });
          if (!result.ok) {
            displayInFlightTargetRef.current = null;
            pendingPanelRectsRef.current = null;
            setMessage(result.error.message);
            if (!displayUpdateRef.current) break;
            continue;
          }
          setConfig(result.value);
          displayInFlightTargetRef.current = null;
          if (displayUpdateRef.current) await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        }
      } finally {
        displaySaveInFlightRef.current = false;
        if (configRef.current) void window.observatory.setMenuLayout(epoch, configRef.current.display.layout);
        if (displayUpdateRef.current) flushDisplayUpdate();
      }
    })();
  };

  const requestDisplayUpdate = (patch: DisplayPatch) => {
    const current = configRef.current;
    if (!epoch || !current) return;
    const base = displayUpdateRef.current ?? displayInFlightTargetRef.current ?? { layout: current.display.layout, focusSlot: current.display.focusSlot };
    displayUpdateRef.current = { ...base, ...patch };
    flushDisplayUpdate();
  };

  const applyDisplayPreview = (patch: DisplayPatch) => {
    const current = configRef.current;
    if (!current) return;
    pendingPanelRectsRef.current = capturePanelRects();
    setConfig({ ...current, display: { ...current.display, ...patch } });
  };

  const updateLayout = (layout: Layout, persist = true) => {
    if (!persist) {
      applyDisplayPreview({ layout });
      return;
    }
    requestDisplayUpdate({ layout });
  };

  const updateFocusSlot = (focusSlot: number, persist = true) => {
    if (!persist) {
      applyDisplayPreview({ focusSlot });
      return;
    }
    requestDisplayUpdate({ focusSlot });
  };

  const openDetails = (slotIndex: number, trigger: HTMLButtonElement) => {
    detailsTriggerRef.current = trigger;
    setDetailsSlot(slotIndex);
  };

  const refresh = async () => {
    if (!epoch || refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setRefreshing(true);
    try {
      const result = await window.observatory.refresh(epoch);
      if (!result.ok) { setMessage(result.error.message); return; }
      setSnapshot((current) => current ? { ...current, observation: result.value } : current);
      setMessage('已刷新本地与远端只读采样。');
    } finally {
      refreshInFlightRef.current = false;
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!epoch) return;
    return window.observatory.onMenuCommand((command) => {
      if (command === 'open-settings') setSettingsOpen(true);
      else if (command === 'layout-columns4') updateLayout('columns4');
      else if (command === 'layout-grid2x2') updateLayout('grid2x2');
      else if (command === 'layout-focus') updateLayout('focus');
      else void refresh();
    });
  }, [epoch]);

  useEffect(() => {
    if (epoch && config) void window.observatory.setMenuLayout(epoch, config.display.layout);
  }, [epoch, config?.display.layout]);

  const registerProfile = async () => {
    if (!epoch) return;
    setMessage('等待选择本机私有 profile…');
    const result = await window.observatory.chooseAndRegisterProfile(epoch);
    if (!result.ok) { setMessage(result.error.message); return; }
    if (!result.value) { setMessage('已取消登记。'); return; }
    const refreshed = await window.observatory.getSnapshot(epoch);
    if (refreshed.ok) setSnapshot(refreshed.value);
    setSettingsOpen(true);
    setMessage(`已登记 ${result.value.displayName}，请在设置中加入设备。`);
  };

  const detailsService = detailsSlot === null ? undefined : services.find((service) => service.id === config?.slots[detailsSlot]?.serviceId);
  const detailsObservation = detailsService ? observation?.services.find((item) => item.serviceId === detailsService.id) : undefined;

  if (!snapshot || !config || !observation) return <main className="shell loading-shell"><AsciiBackground mode="dynamic" brightness={50} strength={50} reducedMotion={false} visible={windowVisible} /><div className="loading-copy"><h1 className="brand-lockup"><span className="brand-mark">「观」</span><span className="brand-label">Server Observer</span></h1><p>正在连接本机观测台 · {message || '读取配置、设备发现与采样…'}</p></div></main>;

  return <main className="shell">
    <AsciiBackground mode={config.display.asciiMode} brightness={config.display.asciiBrightness} strength={config.display.asciiStrength} reducedMotion={config.display.reducedMotion} visible={windowVisible} windowEpoch={epoch} />
    <div className="app-content">
      <header className="masthead app-topbar"><div className="topbar-brand"><h1 className="brand-lockup"><span className="brand-mark">「观」</span><span className="brand-label">Server Observer</span></h1></div></header>
      {!devices.length && !services.length ? <section className="setup-state"><span className="section-label">FIRST RUN</span><h2>先把你的设备接进来</h2><p>登记现有私有 profile，再选择本机或 NAS 设备。服务、槽位和日志都从这里开始配置。</p><div className="setup-actions"><button type="button" className="solid-button" onClick={() => void registerProfile()}>登记私有 profile</button><button type="button" className="ghost-button" onClick={() => setSettingsOpen(true)}>查看设置</button></div></section> : <section ref={dashboardRef} className={'dashboard-grid layout-' + config.display.layout} aria-label="服务面板">{config.slots.map((slot, index) => <ServicePanel key={index} slotIndex={index} service={services.find((service) => service.id === slot.serviceId)} observation={observation.services.find((item) => item.serviceId === slot.serviceId)} config={config} containers={observation.containers} observations={observation.observations} logs={observation.logs} epoch={epoch} statusPage={slot.serviceId ? statusPages[slot.serviceId] : undefined} statusLoading={slot.serviceId ? statusLoading[slot.serviceId] : false} onLoadMoreStatus={slot.serviceId ? () => { const page = statusPages[slot.serviceId!]; if (page?.nextCursor) void loadStatusPage(slot.serviceId!, page.nextCursor); } : undefined} onFocusSlot={updateFocusSlot} onOpenDetails={openDetails} />)}</section>}
    </div>
    {settingsOpen && <SettingsDrawer epoch={epoch} config={config} info={info} observation={observation} refreshing={refreshing} message={message} profiles={snapshot.profiles} containers={settingsContainers.length ? settingsContainers : observation.containers} containersLoading={settingsContainersLoading} containersError={settingsContainersError} onRetryContainers={() => setSettingsContainersReload((value) => value + 1)} statusSources={statusSources} onConfig={setConfig} onLayout={updateLayout} onFocusSlot={updateFocusSlot} onRefresh={refresh} onClose={() => setSettingsOpen(false)} onMessage={setMessage} onRegisterProfile={registerProfile} />}
    {detailsService && config && observation && <ServiceDetailsDrawer service={detailsService} observation={detailsObservation} config={config} containers={observation.containers} observations={observation.observations} statusPage={statusPages[detailsService.id]} statusLoading={statusLoading[detailsService.id]} onLoadMoreStatus={() => { const page = statusPages[detailsService.id]; if (page?.nextCursor) void loadStatusPage(detailsService.id, page.nextCursor); }} trigger={detailsTriggerRef.current} onClose={() => setDetailsSlot(null)} />}
  </main>;
}
