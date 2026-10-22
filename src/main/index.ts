import { app, dialog, Menu, powerMonitor } from 'electron';
import path from 'node:path';
import { ConfigStore } from './config/store.js';
import { ProfileRegistry } from './credentials/registry.js';
import { LifecycleManager, ResourceRegistry } from './lifecycle.js';
import { registerIpc } from './ipc/index.js';
import { registerAppProtocol, registerAppScheme } from './protocol.js';
import { ObservationRuntime } from './runtime.js';
import { createMainWindow, destroyMainWindow, getMainWindow } from './window.js';
import { WindowVisibilityController } from './window-visibility.js';
import type { AppConfig, MenuCommand, WindowBounds } from '../shared/contracts.js';

const stableUserDataPath = path.join(app.getPath('appData'), 'ServiceObservatory');
app.setName('观');
app.setPath('userData', process.env.SERVICE_OBSERVATORY_DATA_DIR ?? stableUserDataPath);
app.setAppUserModelId('local.serviceobservatory');
registerAppScheme();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  const resources = new ResourceRegistry();
  const lifecycle = new LifecycleManager(resources);
  let store: ConfigStore | null = null;
  let profiles: ProfileRegistry | null = null;
  let runtime: ObservationRuntime | null = null;
  let quitting = false;
  let boundsTimer: NodeJS.Timeout | null = null;
  let pendingBounds: WindowBounds | null = null;
  const visibility = new WindowVisibilityController(() => lifecycle.currentEpoch());

  const isWindowActuallyVisible = (window: Electron.BrowserWindow) => !window.isDestroyed() && window.isVisible() && !window.isMinimized();

  app.on('second-instance', () => {
    const window = getMainWindow();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });

  const saveBoundsSoon = (bounds: WindowBounds) => {
    pendingBounds = bounds;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      const next = pendingBounds;
      pendingBounds = null;
      if (next && store) void store.saveWindowBounds(next).catch(() => undefined);
    }, 250);
  };

  const createWindow = async () => {
    if (!store || !runtime) return;
    const epoch = lifecycle.nextEpoch();
    visibility.setEpochVisible(false);
    runtime.start(store.snapshot());
    const window = await createMainWindow({
      bounds: store.getWindowBounds(),
      onBoundsChanged: saveBoundsSoon,
      onRendererCrashed: async (window) => {
        await lifecycle.disposeWindow(window);
        const nextEpoch = lifecycle.nextEpoch();
        visibility.setWindowVisible(window, isWindowActuallyVisible(window));
        if (!quitting && !window.isDestroyed()) {
          const config = store?.snapshot();
          if (config) runtime?.start(config);
          attachRuntimeResource(window, nextEpoch);
          window.webContents.reload();
        }
      },
      onClosed: async (window, capturedOwnerId) => {
        visibility.detach(window);
        await lifecycle.disposeWindow(window, capturedOwnerId);
        runtime?.stop();
        if (lifecycle.currentEpoch() === epoch) {
          lifecycle.nextEpoch();
          visibility.setEpochVisible(false);
        }
      },
    });
    visibility.attach(window);
    attachRuntimeResource(window, epoch);
  };

  const attachRuntimeResource = (window: Electron.BrowserWindow, epoch: number) => {
    resources.register(window.webContents.id, epoch, 'observation-runtime', () => runtime?.stop());
  };

  app.whenReady().then(async () => {
    registerAppProtocol();
    store = new ConfigStore();
    await store.load();
    profiles = new ProfileRegistry(store.root);
    await profiles.load();
    runtime = new ObservationRuntime(profiles);
    const syncMenuLayout = (layout: AppConfig['display']['layout']) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(`layout-${layout}`);
      if (item) item.checked = true;
    };
    registerIpc({
      getWindow: getMainWindow,
      getEpoch: lifecycle.currentEpoch.bind(lifecycle),
      getWindowVisibility: () => visibility.snapshot(),
      store,
      profiles,
      resources,
      lifecycle,
      runtime,
      onMenuLayout: syncMenuLayout,
      onConfigChanged: (config) => runtime?.start(config),
    });
    const sendMenuCommand = async (command: MenuCommand) => {
      if (!getMainWindow()) await createWindow();
      const window = getMainWindow();
      if (!window || window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send('observatory:menu-command', command);
    };
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: '观',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { id: 'open-settings', label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => { void sendMenuCommand('open-settings'); } },
          { type: 'separator' },
          { role: 'quit', label: '退出观' },
        ],
      },
      {
        label: '视图',
        submenu: [
          ...(['columns4', 'grid2x2', 'focus'] as const).map((layout, index) => ({
            id: `layout-${layout}`,
            label: ['四列', '四宫格', '一大三小'][index]!,
            type: 'radio' as const,
            checked: store?.snapshot().display.layout === layout,
            accelerator: `CmdOrCtrl+${index + 1}`,
            click: () => { void sendMenuCommand(`layout-${layout}`); },
          })),
          { type: 'separator' },
          { id: 'refresh-status', label: '刷新状态', accelerator: 'CmdOrCtrl+R', click: () => { void sendMenuCommand('refresh'); } },
        ],
      },
      {
        label: '窗口',
        submenu: [
          { role: 'minimize', label: '最小化' },
          { role: 'togglefullscreen', label: '切换全屏' },
        ],
      },
    ]));
    powerMonitor.on('suspend', () => {
      const window = getMainWindow();
      if (window) {
        visibility.setWindowVisible(window, false);
        void lifecycle.disposeWindow(window);
      }
      lifecycle.nextEpoch();
      if (window && !window.isDestroyed()) visibility.setWindowVisible(window, false);
      else visibility.setEpochVisible(false);
    });
    powerMonitor.on('resume', () => {
      const window = getMainWindow();
      if (window && !window.isDestroyed() && runtime && store) {
        runtime.start(store.snapshot());
        attachRuntimeResource(window, lifecycle.currentEpoch());
        visibility.setWindowVisible(window, isWindowActuallyVisible(window));
        window.webContents.reload();
      }
    });
    await createWindow();
  }).catch((error) => {
    dialog.showErrorBox('观无法启动', '应用资源加载失败，请查看本机诊断记录。');
    console.error('[startup]', error instanceof Error ? error.message : 'unknown');
    app.quit();
  });

  app.on('activate', () => {
    if (getMainWindow()) {
      getMainWindow()?.show();
      return;
    }
    void createWindow();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    if (boundsTimer) clearTimeout(boundsTimer);
    destroyMainWindow();
    const cleanup = resources.disposeAll();
    void Promise.race([
      cleanup,
      new Promise<void>((resolve) => setTimeout(resolve, 12_000)),
    ]).finally(() => app.exit(0));
  });

  app.on('window-all-closed', () => {
    // macOS keeps the application available in the Dock until Cmd+Q.
  });
}
