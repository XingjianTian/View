import { contextBridge, ipcRenderer } from 'electron';
import type {
  MenuCommand,
  AppConfig,
  AppInfo,
  Device,
  ConnectionProbe,
  Diagnostics,
  DisplayPrefs,
  ProfileSummary,
  Result,
  Service,
  SnapshotPage,
  Slot,
  WindowBounds,
  WindowVisibility,
  UpdateEnvelope,
} from '../shared/contracts.js';
import type { LogEntry, LogSourceState } from '../shared/logs.js';
import type { StatusPage, StatusSourceSummary } from '../shared/status.js';

const invoke = <T>(channel: string, epoch: number, payload?: unknown): Promise<Result<T>> =>
  ipcRenderer.invoke(channel, payload === undefined ? { epoch } : { epoch, payload });

type UpdateListener = (update: UpdateEnvelope) => void;
const updateListeners = new Set<UpdateListener>();
type WindowVisibilityListener = (visibility: WindowVisibility) => void;
const windowVisibilityListeners = new Set<WindowVisibilityListener>();
let latestWindowEpoch = 0;
const isUpdateEnvelope = (value: unknown): value is UpdateEnvelope => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<UpdateEnvelope>;
  return Number.isInteger(candidate.epoch) && typeof candidate.seq === 'number' && Number.isInteger(candidate.seq) && candidate.seq > 0 && candidate.kind === 'diagnostic' && !!candidate.payload;
};

ipcRenderer.on('observatory:update', (_event, value: unknown) => {
  if (!isUpdateEnvelope(value)) return;
  for (const listener of updateListeners) listener(value);
  void ipcRenderer.invoke('app:ack-update', { epoch: value.epoch, payload: { seq: value.seq } });
});

const isWindowVisibility = (value: unknown): value is WindowVisibility => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WindowVisibility>;
  return Number.isInteger(candidate.windowEpoch) && (candidate.windowEpoch ?? -1) >= 0 && typeof candidate.visible === 'boolean';
};

ipcRenderer.on('observatory:window-visibility', (_event, value: unknown) => {
  if (!isWindowVisibility(value) || value.windowEpoch < latestWindowEpoch) return;
  latestWindowEpoch = value.windowEpoch;
  for (const listener of windowVisibilityListeners) listener(value);
});

const menuListeners = new Set<(command: MenuCommand) => void>();
let pendingMenuCommand: MenuCommand | null = null;
ipcRenderer.on('observatory:menu-command', (_event, command: unknown) => {
  if (command !== 'open-settings' && command !== 'refresh' && command !== 'layout-columns4' && command !== 'layout-grid2x2' && command !== 'layout-focus') return;
  if (!menuListeners.size) pendingMenuCommand = command;
  else for (const listener of menuListeners) listener(command);
});

contextBridge.exposeInMainWorld('observatory', Object.freeze({
  onMenuCommand: (listener: (command: MenuCommand) => void): (() => void) => {
    menuListeners.add(listener);
    if (pendingMenuCommand) {
      const command = pendingMenuCommand;
      pendingMenuCommand = null;
      listener(command);
    }
    return () => { menuListeners.delete(listener); };
  },
  bootstrap: (): Promise<Result<{ info: AppInfo; snapshot: SnapshotPage }>> => ipcRenderer.invoke('app:bootstrap'),
  getAppInfo: (epoch: number): Promise<Result<AppInfo>> => invoke('app:get-info', epoch),
  getWindowVisibility: async (epoch: number): Promise<Result<WindowVisibility>> => {
    const result = await invoke<WindowVisibility>('app:get-window-visibility', epoch);
    if (result.ok && result.value.windowEpoch >= latestWindowEpoch) latestWindowEpoch = result.value.windowEpoch;
    return result;
  },
  getSnapshot: (epoch: number): Promise<Result<SnapshotPage>> => invoke('app:get-snapshot', epoch),
  getSnapshotPage: (epoch: number, offset = 0, limit = 32, containerOffset = 0, containerLimit = 96): Promise<Result<SnapshotPage>> => invoke('app:get-snapshot-page', epoch, { offset, limit, containerOffset, containerLimit }),
  getStatusPage: (epoch: number, serviceId: string, cursor?: string, limit = 40): Promise<Result<StatusPage>> => invoke('status:get-page', epoch, { serviceId, ...(cursor ? { cursor } : {}), limit }),
  listStatusSources: (epoch: number): Promise<Result<StatusSourceSummary[]>> => invoke('status:list-sources', epoch),
  setMenuLayout: (epoch: number, layout: DisplayPrefs['layout']): Promise<Result<{ layout: DisplayPrefs['layout'] }>> => invoke('app:set-menu-layout', epoch, { layout }),
  refresh: (epoch: number): Promise<Result<SnapshotPage['observation']>> => invoke('app:refresh', epoch),
  subscribeUpdates: (epoch: number): Promise<Result<{ subscribed: boolean }>> => invoke('app:subscribe-updates', epoch),
  unsubscribeUpdates: (epoch: number): Promise<Result<{ subscribed: boolean }>> => invoke('app:unsubscribe-updates', epoch),
  onUpdates: (listener: UpdateListener): (() => void) => {
    updateListeners.add(listener);
    return () => updateListeners.delete(listener);
  },
  onWindowVisibility: (listener: WindowVisibilityListener): (() => void) => {
    windowVisibilityListeners.add(listener);
    return () => windowVisibilityListeners.delete(listener);
  },
  getDiagnostics: (epoch: number): Promise<Result<Diagnostics>> => invoke('app:get-diagnostics', epoch),
  listProfiles: (epoch: number): Promise<Result<ProfileSummary[]>> => invoke('profiles:list', epoch),
  chooseAndRegisterProfile: (epoch: number): Promise<Result<ProfileSummary | null>> => invoke('profiles:choose-and-register', epoch),
  testDevice: (epoch: number, device: Device): Promise<Result<ConnectionProbe>> => invoke('device:test', epoch, { device }),
  saveDevice: (epoch: number, device: Device): Promise<Result<AppConfig>> => invoke('config:save-device', epoch, { device }),
  removeDevice: (epoch: number, id: string): Promise<Result<AppConfig>> => invoke('config:remove-device', epoch, { id }),
  saveService: (epoch: number, service: Service): Promise<Result<AppConfig>> => invoke('config:save-service', epoch, { service }),
  removeService: (epoch: number, id: string): Promise<Result<AppConfig>> => invoke('config:remove-service', epoch, { id }),
  saveDisplay: (epoch: number, display: DisplayPrefs): Promise<Result<AppConfig>> => invoke('config:save-display', epoch, { display }),
  setSlots: (epoch: number, slots: [Slot, Slot, Slot, Slot]): Promise<Result<AppConfig>> => invoke('config:set-slots', epoch, { slots }),
  saveWindowBounds: (epoch: number, window: WindowBounds): Promise<Result<AppConfig>> => invoke('config:save-window-bounds', epoch, { window }),
  openLog: (epoch: number, deviceId: string, containerId: string): Promise<Result<{ sourceKey: string }>> => invoke('logs:open', epoch, { deviceId, containerId }),
  pollLog: (epoch: number, sourceKey: string): Promise<Result<LogSourceState>> => invoke('logs:poll', epoch, { sourceKey }),
  pauseLog: (epoch: number, sourceKey: string, paused: boolean): Promise<Result<{ sourceKey: string; paused: boolean }>> => invoke('logs:pause', epoch, { sourceKey, paused }),
  searchLog: (epoch: number, sourceKey: string, query: string): Promise<Result<LogEntry[]>> => invoke('logs:search', epoch, { sourceKey, query }),
  closeLog: (epoch: number, sourceKey: string, generation?: string, continuous?: boolean): Promise<Result<{ sourceKey: string }>> => invoke('logs:close', epoch, { sourceKey, ...(generation ? { generation } : {}), ...(continuous === undefined ? {} : { continuous }) }),
}));
