import { app, ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  AppInfoSchema,
  AppConfigSchema,
  ConnectionProbeSchema,
  DiagnosticsSchema,
  DeviceSchema,
  DisplayPrefsSchema,
  ProfileSummarySchema,
  ServiceSchema,
  WindowVisibilitySchema,
  fail,
  ok,
  type AppInfo,
  type AppConfig,
  type Diagnostics,
  type Result,
  type SnapshotPage,
  type WindowVisibility,
} from '../../shared/contracts.js';
import { StatusPageSchema, StatusSourceSummarySchema, type StatusPage } from '../../shared/status.js';
import { ConfigStore } from '../config/store.js';
import { ProfileRegistry } from '../credentials/registry.js';
import { LifecycleManager, ResourceRegistry } from '../lifecycle.js';
import { probeDevice } from '../transport/probe.js';
import { ObservationRuntime } from '../runtime.js';
import type { LogSourceState } from '../../shared/logs.js';
import { IpcGuard, safeError } from './guard.js';
import { ObservationStream } from './observation-stream.js';

const EmptyPayloadSchema = z.undefined();
const IdPayloadSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/) }).strict();
const DevicePayloadSchema = z.object({ device: DeviceSchema }).strict();
const ServicePayloadSchema = z.object({ service: ServiceSchema }).strict();
const DisplayPayloadSchema = z.object({ display: DisplayPrefsSchema }).strict();
const SlotsPayloadSchema = z.object({ slots: AppConfigSchema.shape.slots }).strict();
const WindowPayloadSchema = z.object({ window: z.object({
  x: z.number().int().finite(),
  y: z.number().int().finite(),
  width: z.number().int().min(800).max(10000),
  height: z.number().int().min(600).max(10000),
  displayId: z.string().max(256).optional(),
}) }).strict();
const LogOpenPayloadSchema = z.object({
  deviceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  containerId: z.string().regex(/^[a-f0-9]{12,64}$/),
}).strict();
const LogSourcePayloadSchema = z.object({
  sourceKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}:[a-f0-9]{12,64}$/),
}).strict();
const LogClosePayloadSchema = LogSourcePayloadSchema.extend({ generation: z.string().min(1).max(160).optional(), continuous: z.boolean().optional() }).strict();
const LogSearchPayloadSchema = LogSourcePayloadSchema.extend({ query: z.string().max(256) }).strict();
const LogPausePayloadSchema = LogSourcePayloadSchema.extend({ paused: z.boolean() }).strict();
const AckPayloadSchema = z.object({ seq: z.number().int().positive() }).strict();
const MAX_SNAPSHOT_PAGE_BYTES = 60 * 1024;
const SnapshotPagePayloadSchema = z.object({
  offset: z.number().int().min(0).max(128).default(0),
  limit: z.number().int().min(1).max(32).default(32),
  containerOffset: z.number().int().min(0).max(4096).default(0),
  containerLimit: z.number().int().min(1).max(512).default(96),
}).strict().default({ offset: 0, limit: 32, containerOffset: 0, containerLimit: 96 });
const StatusPagePayloadSchema = z.object({
  serviceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(40).default(40),
}).strict();

type IpcDependencies = {
  getWindow: () => BrowserWindow | null;
  getEpoch: () => number;
  getWindowVisibility: () => WindowVisibility;
  store: ConfigStore;
  profiles: ProfileRegistry;
  resources: ResourceRegistry;
  lifecycle: LifecycleManager;
  runtime: ObservationRuntime;
  onMenuLayout?: (layout: AppConfig['display']['layout']) => void;
  onConfigChanged?: (config: AppConfig) => void;
};

let registered = false;

export function registerIpc(dependencies: IpcDependencies) {
  if (registered) return;
  registered = true;
  const guard = new IpcGuard(dependencies);
  const subscriptions = new Map<number, { epoch: number; stream: ObservationStream; timer: NodeJS.Timeout; release: () => Promise<void> }>();

  const disposeSubscription = (webContentsId: number) => {
    const subscription = subscriptions.get(webContentsId);
    if (!subscription) return;
    subscriptions.delete(webContentsId);
    clearInterval(subscription.timer);
    subscription.release().catch(() => undefined);
  };

  const sendQueuedUpdate = (event: IpcMainInvokeEvent, subscription: { stream: ObservationStream }) => {
    subscription.stream.tick();
    const batch = subscription.stream.flush();
    if (batch && !event.sender.isDestroyed()) event.sender.send('observatory:update', batch);
  };

  install('app:get-info', EmptyPayloadSchema, guard, async () => ok<AppInfo>(AppInfoSchema.parse({
    name: 'ServiceObservatory',
    displayName: '观',
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
  })));

  install('app:get-window-visibility', EmptyPayloadSchema, guard, async () => ok<WindowVisibility>(WindowVisibilitySchema.parse(dependencies.getWindowVisibility())));

  installBootstrap('app:bootstrap', guard, async () => {
    const info = AppInfoSchema.parse({
      name: 'ServiceObservatory',
      displayName: '观',
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    });
    const snapshot = buildSnapshotPage(dependencies, 0, 32);
    return ok({ info, snapshot });
  });

  install('app:get-snapshot', EmptyPayloadSchema, guard, async () => ok(buildSnapshotPage(dependencies, 0, 32)));
  install('app:get-snapshot-page', SnapshotPagePayloadSchema, guard, async ({ offset, limit, containerOffset, containerLimit }) => ok(buildSnapshotPage(dependencies, offset, limit, containerOffset, containerLimit)));
  install('status:get-page', StatusPagePayloadSchema, guard, async ({ serviceId, cursor, limit }) => ok<StatusPage>(StatusPageSchema.parse(dependencies.runtime.statusPage(serviceId, cursor, limit))));
  install('status:list-sources', EmptyPayloadSchema, guard, async () => ok(z.array(StatusSourceSummarySchema).max(32).parse(await dependencies.runtime.statusSourceSummaries())));

  install('app:get-diagnostics', EmptyPayloadSchema, guard, async () => ok<Diagnostics>(DiagnosticsSchema.parse({
    resourceCount: dependencies.resources.count(),
    activeEpoch: dependencies.getEpoch(),
    transportPool: dependencies.runtime.transports.stats(),
  })));

  install('profiles:list', EmptyPayloadSchema, guard, async () => ok(dependencies.profiles.summaries()));
  install('profiles:choose-and-register', EmptyPayloadSchema, guard, async () => {
    try {
      const summary = await dependencies.profiles.chooseAndRegister();
      return ok(ProfileSummarySchema.nullable().parse(summary));
    } catch {
      return fail('profile_invalid', '私有 profile 无效或无法读取。');
    }
  });

  install('app:set-menu-layout', z.object({ layout: DisplayPrefsSchema.shape.layout }).strict(), guard, async ({ layout }) => {
    dependencies.onMenuLayout?.(layout);
    return ok({ layout });
  });

  install('app:refresh', EmptyPayloadSchema, guard, async () => {
    await dependencies.runtime.refresh();
    return ok(dependencies.runtime.snapshot());
  });

  install('app:subscribe-updates', EmptyPayloadSchema, guard, async (_payload, event) => {
    disposeSubscription(event.sender.id);
    const epoch = dependencies.getEpoch();
    const stream = new ObservationStream(epoch);
    let subscription: { epoch: number; stream: ObservationStream; timer: NodeJS.Timeout; release: () => Promise<void> };
    subscription = { epoch, stream, timer: setInterval(() => sendQueuedUpdate(event, subscription), 250), release: async () => undefined };
    const unsubscribeRuntime = dependencies.runtime.subscribe(() => {
      stream.enqueue('observations', { observation: dependencies.runtime.snapshot() });
    });
    const releaseResource = dependencies.resources.register(event.sender.id, epoch, 'observation-subscription', () => {
      unsubscribeRuntime();
      clearInterval(subscription.timer);
      subscriptions.delete(event.sender.id);
    });
    subscription.release = releaseResource;
    subscriptions.set(event.sender.id, subscription);
    stream.enqueue('observations', { observation: dependencies.runtime.snapshot() });
    sendQueuedUpdate(event, subscription);
    return ok({ subscribed: true });
  });
  install('app:unsubscribe-updates', EmptyPayloadSchema, guard, async (_payload, event) => {
    disposeSubscription(event.sender.id);
    return ok({ subscribed: false });
  });
  install('app:ack-update', AckPayloadSchema, guard, async ({ seq }, event) => {
    const subscription = subscriptions.get(event.sender.id);
    if (!subscription) return fail('invalid_request', '更新订阅不存在。');
    return ok({ acknowledged: subscription.stream.confirm(subscription.epoch, seq) });
  });

  install('config:save-device', DevicePayloadSchema, guard, async ({ device }) => saveConfig(dependencies.store.saveDevice(device), dependencies.onConfigChanged));
  install('device:test', DevicePayloadSchema, guard, async ({ device }) => {
    const reference = dependencies.profiles.getReference(device.profileId);
    if (!reference || reference.kind !== device.transport) return fail('profile_missing', '设备 profile 不可用。');
    return ok(ConnectionProbeSchema.parse(await probeDevice(device, reference)));
  });
  install('config:remove-device', IdPayloadSchema, guard, async ({ id }) => saveConfig(dependencies.store.removeDevice(id), dependencies.onConfigChanged));
  install('config:save-service', ServicePayloadSchema, guard, async ({ service }) => {
    const knownDevices = new Set(dependencies.store.snapshot().devices.map((device) => device.id));
    if (service.bindings.some((binding) => !knownDevices.has(binding.deviceId))) {
      return fail('invalid_request', '服务包含未知设备。');
    }
    return saveConfig(dependencies.store.saveService(service), dependencies.onConfigChanged);
  });
  install('config:remove-service', IdPayloadSchema, guard, async ({ id }) => saveConfig(dependencies.store.removeService(id), dependencies.onConfigChanged));
  install('config:save-display', DisplayPayloadSchema, guard, async ({ display }) => saveConfig(dependencies.store.saveDisplay(display)));
  install('config:set-slots', SlotsPayloadSchema, guard, async ({ slots }) => {
    const config = dependencies.store.snapshot();
    const services = new Set(config.services.map((service) => service.id));
    if (slots.some((slot) => slot.serviceId !== null && !services.has(slot.serviceId))) {
      return fail('invalid_request', '槽位包含未知服务。');
    }
    return saveConfig(dependencies.store.setSlots(slots), dependencies.onConfigChanged);
  });
  install('config:save-window-bounds', WindowPayloadSchema, guard, async ({ window }) => saveConfig(dependencies.store.saveWindowBounds(window), dependencies.onConfigChanged));

  install('logs:open', LogOpenPayloadSchema, guard, async ({ deviceId, containerId }) => {
    const opened = await dependencies.runtime.openLog(deviceId, containerId);
    if (!opened) return fail('log_unavailable', '日志源当前不可用。');
    return ok({ sourceKey: `${deviceId}:${containerId}` });
  });
  install('logs:poll', LogSourcePayloadSchema, guard, async ({ sourceKey }) => {
    const state = await dependencies.runtime.pollLog(sourceKey);
    if (!state) return fail('log_unavailable', '日志源尚未打开。');
    return ok(trimLogState(state));
  });
  install('logs:pause', LogPausePayloadSchema, guard, async ({ sourceKey, paused }) => {
    dependencies.runtime.pauseLog(sourceKey, paused);
    return ok({ sourceKey, paused });
  });
  install('logs:search', LogSearchPayloadSchema, guard, async ({ sourceKey, query }) => {
    return ok(dependencies.runtime.searchLog(sourceKey, query).slice(-100));
  });
  install('logs:close', LogClosePayloadSchema, guard, async ({ sourceKey, generation, continuous }) => {
    dependencies.runtime.closeLog(sourceKey, generation, continuous);
    return ok({ sourceKey });
  });
}

async function saveConfig(operation: Promise<AppConfig>, onSaved?: (config: AppConfig) => void): Promise<Result<AppConfig>> {
  try {
    const config = await operation;
    onSaved?.(config);
    return ok(config);
  } catch {
    return fail('config_write_failed', '设置未能保存。');
  }
}

function trimLogState(state: LogSourceState): LogSourceState {
  const entries = state.entries.slice(-100);
  return { ...state, entries };
}

function buildSnapshotPage(dependencies: IpcDependencies, offset: number, limit: number, containerOffset = 0, containerLimit = 96): SnapshotPage {
  const sourceConfig = dependencies.store.snapshot();
  const servicePage = sourceConfig.services.slice(offset, offset + limit);
  const slotServices = sourceConfig.slots.flatMap((slot) => slot.serviceId ? sourceConfig.services.filter((service) => service.id === slot.serviceId) : []);
  let services = [...new Map([...servicePage, ...slotServices].map((service) => [service.id, service])).values()];
  const servicePageMeta = { offset, limit, total: sourceConfig.services.length, hasMore: offset + limit < sourceConfig.services.length };
  let page: SnapshotPage = {
    config: { ...sourceConfig, services },
    profiles: dependencies.profiles.summaries(),
    resourceCount: dependencies.resources.count(),
    windowEpoch: dependencies.getEpoch(),
    observation: dependencies.runtime.snapshot({ containerOffset, containerLimit }),
    servicePage: servicePageMeta,
  };
  while (Buffer.byteLength(JSON.stringify(page), 'utf8') > MAX_SNAPSHOT_PAGE_BYTES && services.length > 0) {
    services = services.slice(0, Math.max(0, Math.floor(services.length / 2)));
    page = { ...page, config: { ...sourceConfig, services } };
  }
  return page;
}

function install<T>(
  channel: string,
  payloadSchema: z.ZodType<T>,
  guard: IpcGuard,
  handler: (payload: T, event: IpcMainInvokeEvent) => Promise<Result<unknown>>,
) {
  ipcMain.handle(channel, async (event, value: unknown) => {
    try {
      const envelope = guard.envelope(event, channel, value);
      const parsed = payloadSchema.safeParse(envelope.payload);
      if (!parsed.success) return fail('invalid_request', '请求参数无效。');
      return await handler(parsed.data, event);
    } catch (error) {
      return safeError(error);
    }
  });
}

function installBootstrap(
  channel: string,
  guard: IpcGuard,
  handler: () => Promise<Result<unknown>>,
) {
  ipcMain.handle(channel, async (event, value: unknown) => {
    try {
      guard.bootstrap(event, channel, value);
      return await handler();
    } catch (error) {
      return safeError(error);
    }
  });
}
