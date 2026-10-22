import type {
  MenuCommand,
  AppConfig,
  AppInfo,
  ConnectionProbe,
  Device,
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

export {};

declare global {
  interface Window {
    observatory: {
      bootstrap: () => Promise<Result<{ info: AppInfo; snapshot: SnapshotPage }>>;
      getAppInfo: (epoch: number) => Promise<Result<AppInfo>>;
      getWindowVisibility: (epoch: number) => Promise<Result<WindowVisibility>>;
      getSnapshot: (epoch: number) => Promise<Result<SnapshotPage>>;
      getSnapshotPage: (epoch: number, offset?: number, limit?: number, containerOffset?: number, containerLimit?: number) => Promise<Result<SnapshotPage>>;
      getStatusPage: (epoch: number, serviceId: string, cursor?: string, limit?: number) => Promise<Result<StatusPage>>;
      listStatusSources: (epoch: number) => Promise<Result<StatusSourceSummary[]>>;
      setMenuLayout: (epoch: number, layout: DisplayPrefs['layout']) => Promise<Result<{ layout: DisplayPrefs['layout'] }>>;
      refresh: (epoch: number) => Promise<Result<SnapshotPage['observation']>>;
      subscribeUpdates: (epoch: number) => Promise<Result<{ subscribed: boolean }>>;
      unsubscribeUpdates: (epoch: number) => Promise<Result<{ subscribed: boolean }>>;
      onMenuCommand: (listener: (command: MenuCommand) => void) => () => void;
      onUpdates: (listener: (update: UpdateEnvelope) => void) => () => void;
      onWindowVisibility: (listener: (visibility: WindowVisibility) => void) => () => void;
      getDiagnostics: (epoch: number) => Promise<Result<Diagnostics>>;
      listProfiles: (epoch: number) => Promise<Result<ProfileSummary[]>>;
      chooseAndRegisterProfile: (epoch: number) => Promise<Result<ProfileSummary | null>>;
      testDevice: (epoch: number, device: Device) => Promise<Result<ConnectionProbe>>;
      saveDevice: (epoch: number, device: Device) => Promise<Result<AppConfig>>;
      removeDevice: (epoch: number, id: string) => Promise<Result<AppConfig>>;
      saveService: (epoch: number, service: Service) => Promise<Result<AppConfig>>;
      removeService: (epoch: number, id: string) => Promise<Result<AppConfig>>;
      saveDisplay: (epoch: number, display: DisplayPrefs) => Promise<Result<AppConfig>>;
      setSlots: (epoch: number, slots: [Slot, Slot, Slot, Slot]) => Promise<Result<AppConfig>>;
      saveWindowBounds: (epoch: number, window: WindowBounds) => Promise<Result<AppConfig>>;
      openLog: (epoch: number, deviceId: string, containerId: string) => Promise<Result<{ sourceKey: string }>>;
      pollLog: (epoch: number, sourceKey: string) => Promise<Result<LogSourceState>>;
      pauseLog: (epoch: number, sourceKey: string, paused: boolean) => Promise<Result<{ sourceKey: string; paused: boolean }>>;
      searchLog: (epoch: number, sourceKey: string, query: string) => Promise<Result<LogEntry[]>>;
      closeLog: (epoch: number, sourceKey: string, generation?: string, continuous?: boolean) => Promise<Result<{ sourceKey: string }>>;
    };
  }
}
