import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ContainerEntity } from '../../shared/entities.js';
import type { LogEntry, LogSourceState } from '../../shared/logs.js';

const NEAR_BOTTOM_PX = 32;

type ScrollAnchor = { id: string; offset: number };
type ScrollIntent =
  | { kind: 'bottom' }
  | { kind: 'top' }
  | { kind: 'anchor'; anchor: ScrollAnchor };
type ScrollSnapshot = { intent: ScrollIntent; nearBottom: boolean };

type Props = {
  toolbarTarget?: HTMLElement | null | undefined;
  epoch: number;
  container: ContainerEntity | undefined;
  deviceName?: string | undefined;
  initialState?: LogSourceState | undefined;
  sourceOptions?: ReadonlyArray<{ value: string; label: string }> | undefined;
  sourceValue?: string | undefined;
  onSourceChange?: ((value: string) => void) | undefined;
};

function readScrollSnapshot(node: HTMLElement): ScrollSnapshot {
  const distance = Math.max(0, node.scrollHeight - node.clientHeight - node.scrollTop);
  const nearBottom = distance <= NEAR_BOTTOM_PX;
  const rootRect = node.getBoundingClientRect();
  const anchor = [...node.querySelectorAll<HTMLElement>('[data-entry-id]')].find((row) => {
    const rowRect = row.getBoundingClientRect();
    return rowRect.bottom > rootRect.top + 1 && rowRect.top < rootRect.bottom - 1;
  });
  const intent: ScrollIntent = nearBottom
    ? { kind: 'bottom' }
    : anchor
      ? { kind: 'anchor', anchor: { id: anchor.dataset.entryId ?? '', offset: anchor.getBoundingClientRect().top - rootRect.top } }
      : { kind: 'top' };
  return { intent, nearBottom };
}

function restoreScrollIntent(node: HTMLElement, intent: ScrollIntent): void {
  if (intent.kind === 'bottom') {
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    return;
  }
  if (intent.kind === 'top') {
    node.scrollTop = 0;
    return;
  }
  const anchor = [...node.querySelectorAll<HTMLElement>('[data-entry-id]')].find((row) => row.dataset.entryId === intent.anchor.id);
  if (!anchor) return;
  const rootRect = node.getBoundingClientRect();
  const delta = anchor.getBoundingClientRect().top - rootRect.top - intent.anchor.offset;
  node.scrollTop = Math.max(0, node.scrollTop + delta);
}

function countNewEntries(next: readonly LogEntry[], previous: readonly LogEntry[]): number {
  const known = new Set(previous.map((entry) => entry.id));
  return next.reduce((count, entry) => count + (known.has(entry.id) ? 0 : 1), 0);
}

export function LogViewer({ toolbarTarget, epoch, container, deviceName, initialState, sourceOptions, sourceValue, onSourceChange }: Props) {
  const [sourceKey, setSourceKey] = useState<string | null>(initialState?.sourceKey ?? null);
  const [state, setState] = useState<LogSourceState | undefined>(initialState);
  const [displayEntries, setDisplayEntries] = useState<LogEntry[]>(initialState?.entries ?? []);
  const displayEntriesRef = useRef<LogEntry[]>(initialState?.entries ?? []);
  const lastPolledEntriesRef = useRef<LogEntry[]>(initialState?.entries ?? []);
  const logLinesRef = useRef<HTMLDivElement>(null);
  const scrollIntentRef = useRef<ScrollIntent | null>(null);
  const lastScrollIntentRef = useRef<ScrollIntent>({ kind: 'bottom' });
  const initialPositionRef = useRef(true);
  const searchRestoreRef = useRef<ScrollIntent | null>(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<LogEntry[] | null>(null);
  const [message, setMessage] = useState('正在连接日志…');
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [newCount, setNewCount] = useState(0);
  const [nearBottom, setNearBottom] = useState(true);
  const [showTimestamp, setShowTimestamp] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const toolsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const isRunning = container?.state === 'running';

  const viewerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const closeDetails = () => {
    captureCurrentPosition();
    setExpanded(false);
    window.setTimeout(() => {
      const trigger = toolsTriggerRef.current;
      if (trigger?.isConnected) trigger.focus();
      else (toolbarTarget ?? viewerRef.current)?.querySelector<HTMLButtonElement>('.log-tools-button')?.focus();
    }, 0);
  };

  useEffect(() => {
    if (!expanded) return;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeDetails();
      } else if (event.key === 'Tab') {
        const controls = [...(viewerRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]') ?? [])]
          .filter((node) => node.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [expanded]);

  const captureCurrentPosition = (): ScrollIntent => {
    const node = logLinesRef.current;
    if (!node) return { kind: 'bottom' };
    const snapshot = readScrollSnapshot(node);
    lastScrollIntentRef.current = snapshot.intent;
    setNearBottom(snapshot.nearBottom);
    scrollIntentRef.current = snapshot.intent;
    return snapshot.intent;
  };

  useEffect(() => {
    let disposed = false;
    let activeKey: string | null = null;
    let timer: number | undefined;
    pausedRef.current = false;
    initialPositionRef.current = true;
    scrollIntentRef.current = null;
    lastScrollIntentRef.current = { kind: 'bottom' };
    searchRestoreRef.current = null;
    setPaused(false);
    setNearBottom(true);
    setSearchResults(null);
    setNewCount(0);
    displayEntriesRef.current = initialState?.entries ?? [];
    lastPolledEntriesRef.current = initialState?.entries ?? [];
    setDisplayEntries(displayEntriesRef.current);
    setState(initialState);
    if (!container || !epoch) {
      setSourceKey(null);
      setState(undefined);
      setMessage(container ? '等待窗口就绪…' : '当前服务没有可读容器日志');
      return () => undefined;
    }
    if (!container.logsAvailable) {
      setSourceKey(null);
      setMessage('当前容器没有可读日志');
      return () => undefined;
    }
    const continuous = container.state === 'running';
    const poll = async (key: string) => {
      const result = await window.observatory.pollLog(epoch, key);
      if (disposed) return;
      if (result.ok) {
        const previousEntries = lastPolledEntriesRef.current;
        const incomingCount = countNewEntries(result.value.entries, previousEntries);
        lastPolledEntriesRef.current = result.value.entries;
        const snapshot = logLinesRef.current?.clientHeight ? readScrollSnapshot(logLinesRef.current) : { intent: lastScrollIntentRef.current, nearBottom: lastScrollIntentRef.current.kind === 'bottom' };
        scrollIntentRef.current = snapshot.intent;
        lastScrollIntentRef.current = snapshot.intent;
        setNearBottom(snapshot.nearBottom);
        setState(result.value);
        if (!pausedRef.current) {
          displayEntriesRef.current = result.value.entries;
          setDisplayEntries(result.value.entries);
          if (snapshot.nearBottom) setNewCount(0);
          else if (incomingCount > 0) setNewCount((count) => count + incomingCount);
        } else if (incomingCount > 0) {
          setNewCount((count) => count + incomingCount);
        }
        const outcome = result.value.diagnostic?.outcome;
        const diagnosticMessage = outcome && outcome !== 'success_new' && outcome !== 'success_idle' ? logReadText(outcome, continuous, result.value.errorCode) : undefined;
        setMessage(diagnosticMessage ?? (result.value.errorCode ? logErrorText(result.value.errorCode, result.value.diagnostic?.phase) : logReadText(outcome, continuous)));
      } else setMessage(result.error.message);
    };
    const connect = async () => {
      const opened = await window.observatory.openLog(epoch, container.deviceId, container.id);
      if (disposed) {
        if (opened.ok) void window.observatory.closeLog(epoch, opened.value.sourceKey);
        return;
      }
      if (!opened.ok) {
        setMessage(opened.error.message);
        return;
      }
      activeKey = opened.value.sourceKey;
      setSourceKey(activeKey);
      await poll(activeKey);
      if (!disposed && continuous) timer = window.setInterval(() => void poll(activeKey!), 2200);
    };
    void connect();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearInterval(timer);
      if (activeKey) void window.observatory.closeLog(epoch, activeKey, container.generation, continuous);
    };
  }, [container?.key, container?.generation, container?.state, epoch]);

  const visibleEntries = useMemo(() => searchResults ?? displayEntries, [searchResults, displayEntries]);

  useLayoutEffect(() => {
    const node = logLinesRef.current;
    if (!node || !node.clientHeight || !visibleEntries.length) return;
    const intent = scrollIntentRef.current;
    if (intent) {
      restoreScrollIntent(node, intent);
      scrollIntentRef.current = null;
    } else if (initialPositionRef.current) {
      restoreScrollIntent(node, { kind: 'bottom' });
      initialPositionRef.current = false;
    }
    const snapshot = readScrollSnapshot(node);
    lastScrollIntentRef.current = snapshot.intent;
    setNearBottom(snapshot.nearBottom);
  }, [visibleEntries, expanded, searchResults]);

  useEffect(() => {
    const node = logLinesRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return () => undefined;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        if (!node.clientHeight) return;
        restoreScrollIntent(node, lastScrollIntentRef.current);
        const snapshot = readScrollSnapshot(node);
        lastScrollIntentRef.current = snapshot.intent;
        setNearBottom(snapshot.nearBottom);
      });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [expanded, searchResults]);

  const handleScroll = () => {
    const node = logLinesRef.current;
    if (!node) return;
    const snapshot = readScrollSnapshot(node);
    lastScrollIntentRef.current = snapshot.intent;
    setNearBottom(snapshot.nearBottom);
    if (snapshot.nearBottom) setNewCount(0);
  };

  const runSearch = async () => {
    if (!sourceKey) return;
    const previousPosition = captureCurrentPosition();
    if (!query.trim()) {
      searchRestoreRef.current = previousPosition;
      scrollIntentRef.current = { kind: 'top' };
      setSearchResults(null);
      return;
    }
    searchRestoreRef.current = previousPosition;
    const result = await window.observatory.searchLog(epoch, sourceKey, query.trim());
    if (result.ok) {
      scrollIntentRef.current = { kind: 'top' };
      setSearchResults(result.value);
    }
  };

  const togglePaused = () => {
    if (!isRunning) return;
    const next = !pausedRef.current;
    const previousPosition = captureCurrentPosition();
    pausedRef.current = next;
    setPaused(next);
    if (sourceKey) void window.observatory.pauseLog(epoch, sourceKey, next);
    if (!next) {
      const entries = state?.entries ?? [];
      const incomingCount = countNewEntries(entries, displayEntriesRef.current);
      displayEntriesRef.current = entries;
      scrollIntentRef.current = previousPosition;
      setDisplayEntries(entries);
      if (previousPosition.kind === 'bottom') setNewCount(0);
      else if (incomingCount > 0) setNewCount(incomingCount);
    }
  };

  const clearSearch = () => {
    setQuery('');
    scrollIntentRef.current = searchRestoreRef.current ?? lastScrollIntentRef.current;
    setSearchResults(null);
    searchRestoreRef.current = null;
  };

  const scrollToLatest = () => {
    const node = logLinesRef.current;
    if (!node) return;
    scrollIntentRef.current = { kind: 'bottom' };
    restoreScrollIntent(node, { kind: 'bottom' });
    lastScrollIntentRef.current = { kind: 'bottom' };
    setNearBottom(true);
    setNewCount(0);
  };

  const openDetails = (trigger: HTMLButtonElement) => {
    captureCurrentPosition();
    toolsTriggerRef.current = trigger;
    setExpanded(true);
  };

  if (!container) return <section className="log-viewer log-empty" aria-label="容器日志">
    {!toolbarTarget && <div className="log-toolbar"><span className="log-source log-source-empty" role="heading" aria-level={3}><span className="log-source-name">日志</span></span></div>}
    <div className="log-lines"><div className="log-placeholder">尚未绑定日志来源</div></div>
  </section>;
  const sourceLabel = container.name + ' · ' + (deviceName ?? container.deviceId);
  const logClasses = ['log-viewer', expanded ? 'log-expanded' : '', paused ? 'log-paused' : '', searchResults ? 'log-filtered' : '', state?.errorCode ? 'log-error' : ''].filter(Boolean).join(' ');
  const collapsedState = [paused ? '已暂停' : '', searchResults ? '已筛选' : ''].filter(Boolean).join(' · ');
  const hasUnread = !nearBottom && newCount > 0;
  const compactState = compactLogState(message, state);
  const toolbar = <div className="log-toolbar">
      <span className="log-source"><span className="log-source-name" title={sourceLabel}>{expanded ? sourceLabel : '日志'}</span></span>
      {collapsedState && <span className="log-collapsed-state">{collapsedState}</span>}
      {compactState !== '无新增' && <button type="button" className={`log-state log-state-${state?.errorCode ? 'error' : 'quiet'}`} onClick={(event) => openDetails(event.currentTarget)} title={message} aria-label={`打开日志状态详情：${message}`}>{compactState}</button>}
      {state?.gap ? <button type="button" className="log-gap" onClick={(event) => openDetails(event.currentTarget)} title={`历史有缺口 · ${state.gap} 行`} aria-label={`打开详细日志，历史有缺口 ${state.gap} 行`}>缺口</button> : null}
      {expanded && <button ref={closeButtonRef} type="button" className="log-close-button" onClick={closeDetails}>关闭日志 <span aria-hidden="true">×</span></button>}
      <button hidden={expanded} type="button" className="log-tools-button" aria-label="打开详细日志" title="打开详细日志" onClick={(event) => openDetails(event.currentTarget)}>⋮</button>
    </div>;
  return <section ref={viewerRef} className={logClasses} role={expanded ? 'dialog' : undefined} aria-modal={expanded ? true : undefined} aria-label={expanded ? '详细日志' : '容器日志'}>
    {toolbarTarget && !expanded ? createPortal(toolbar, toolbarTarget) : toolbar}
    <div className="log-controls" hidden={!expanded}>
      {!isRunning && <p className="log-snapshot-note" tabIndex={0}>已停止，仅显示有限历史快照，不持续读取。</p>}
      {sourceOptions && sourceOptions.length > 1 && <label className="log-source-picker"><span>来源</span><select value={sourceValue ?? ''} onChange={(event) => onSourceChange?.(event.target.value)} aria-label="选择日志来源">{sourceOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}
      <div className="log-diagnostics" role="status">
        <span>当前：{message}</span>
        {state?.diagnostic && <span>本次读取：{diagnosticMeta(state.diagnostic)}</span>}
        {state?.lastErrorCode && <span>最近失败：{logErrorText(state.lastErrorCode, state.lastErrorDiagnostic?.phase)} · {state.lastErrorAt ? formatDiagnosticAt(state.lastErrorAt) : '时间待确认'}{state.lastErrorDiagnostic ? ` · ${diagnosticMeta(state.lastErrorDiagnostic)}` : ''}</span>}
      </div>
      {isRunning && <button type="button" className="text-button" onClick={togglePaused}>{paused ? '继续' : '暂停'}</button>}
      {searchResults && <button type="button" className="text-button" onClick={clearSearch}>清除筛选</button>}
      <div className="log-search"><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }} placeholder="查找缓存日志" aria-label="搜索日志" /><button type="button" className="text-button" onClick={() => void runSearch()}>查找</button></div>
      <button type="button" className="text-button" onClick={() => setShowTimestamp((value) => !value)}>{showTimestamp ? '隐藏时间' : '显示时间'}</button>
      {expanded && hasUnread && <button type="button" className="text-button log-latest-button new-count" onClick={scrollToLatest}>回到最新（{newCount} 条）</button>}
    </div>
    {!expanded && hasUnread && <button type="button" className="log-unread-button new-count" onClick={scrollToLatest}>回到最新 · +{newCount}</button>}
    <div ref={logLinesRef} className="log-lines" onScroll={handleScroll}>
      {visibleEntries.length ? visibleEntries.slice(-(expanded ? 160 : 100)).map((entry) => <div className={'log-line ' + (showTimestamp ? 'with-time' : 'without-time')} data-entry-id={entry.id} key={entry.id}>{showTimestamp && <span className="log-time">{entry.timestamp ? entry.timestamp.slice(11, 23) : '—'}</span>}<span>{entry.message}</span></div>) : <div className="log-placeholder">stdout 暂无新行</div>}
    </div>
  </section>;
}

function logErrorText(code: string, phase?: string): string {
  if (code === 'engine_unavailable') return phase === 'connection' ? 'SSH连接失败' : phase === 'channel' ? '等待日志通道超时' : '远端日志读取失败';
  if (code === 'deadline_unavailable') return '远端期限工具不可用';
  if (code === 'timeout') return phase === 'channel' ? '等待日志通道超时' : phase === 'remote' || phase === 'output' ? '远端日志未完成' : '读取超时';
  if (code === 'channel_error') return '日志通道建立失败';
  if (code === 'incomplete') return '日志输出超过上限';
  if (code === 'parse_gap') return '日志解析出现缺口';
  if (code === 'log_unavailable') return '日志不可读';
  if (code === 'auth_failed') return '读取认证失败';
  if (code === 'host_key_untrusted') return '主机密钥未获信任';
  return '日志读取异常';
}

function logReadText(outcome: string | undefined, continuous: boolean, errorCode?: string | null): string {
  if (outcome === 'success_new') return continuous ? '实时读取中 · 有新增' : '已停止 · 有日志';
  if (outcome === 'success_idle') return continuous ? '实时读取中 · 无新行' : '已停止 · 无新增';
  if (outcome === 'ssh_connection_error') return 'SSH连接失败';
  if (outcome === 'deadline_error') return '远端期限工具不可用';
  if (outcome === 'channel_error') return '等待日志通道超时';
  if (outcome === 'remote_timeout') return '远端日志未完成';
  if (outcome === 'remote_error') return '远端日志读取失败';
  if (outcome === 'output_truncated') return '日志输出超过上限';
  if (outcome === 'parse_error') return '日志解析出现缺口';
  if (outcome === 'cancelled') return '读取已取消';
  if (outcome === 'unknown_error') return errorCode ? `${logErrorText(errorCode)} · 阶段未确定` : '日志读取原因未确定';
  return continuous ? '实时读取中' : '已停止 · 快照';
}

export function compactLogState(message: string, state: LogSourceState | undefined): string {
  if (state?.errorCode) return '异常';
  if (message.includes('无新行') || message.includes('无新增')) return '无新增';
  if (message.includes('实时读取中')) return '实时';
  if (message.includes('已停止')) return '快照';
  if (message.includes('连接') || message.includes('等待')) return '连接';
  return '状态';
}

function diagnosticMeta(diagnostic: NonNullable<LogSourceState['diagnostic']>): string {
  return `${diagnosticPhaseText(diagnostic.phase)} · ${diagnostic.elapsedMs}ms · ${formatDiagnosticAt(diagnostic.observedAt)}`;
}

function diagnosticPhaseText(phase: NonNullable<LogSourceState['diagnostic']>['phase']): string {
  return {
    connection: '连接',
    deadline: '期限',
    channel: '通道',
    remote: '远端',
    output: '输出',
    parse: '解析',
    read: '读取',
  }[phase];
}

function formatDiagnosticAt(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : value;
}
