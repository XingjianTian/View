import { app, BrowserWindow, screen, session } from 'electron';
import path from 'node:path';
import type { WindowBounds } from '../shared/contracts.js';

let mainWindow: BrowserWindow | null = null;
let cspInstalled = false;

function installCsp() {
  if (cspInstalled) return;
  cspInstalled = true;
  const devServer = process.env.SERVICE_OBSERVATORY_DEV_SERVER;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const allowed = isAllowedNavigation(details.url, devServer);
    callback({ cancel: !allowed });
  });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders ?? {};
    if (details.url.startsWith('app://observatory/')) {
      callback({
        responseHeaders: {
          ...responseHeaders,
          'Content-Security-Policy': ["default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none';"],
        },
      });
      return;
    }
    callback({ responseHeaders });
  });
}

function isAllowedNavigation(url: string, devServer = process.env.SERVICE_OBSERVATORY_DEV_SERVER) {
  return url.startsWith('app://observatory/')
    || (!app.isPackaged && devServer !== undefined && url.startsWith(devServer));
}

function windowBounds() {
  return { width: 1440, height: 900, minWidth: 1120, minHeight: 700 };
}

type DisplayWorkArea = { id: number; workArea: { x: number; y: number; width: number; height: number } };
type WindowDefaults = ReturnType<typeof windowBounds>;

export function clampWindowBounds(saved: WindowBounds | null, defaults: WindowDefaults, displays: readonly DisplayWorkArea[], primary: DisplayWorkArea): WindowBounds {
  const savedDisplay = saved?.displayId ? displays.find((display) => String(display.id) === saved.displayId) : undefined;
  const savedCenter = saved ? { x: saved.x + saved.width / 2, y: saved.y + saved.height / 2 } : null;
  const matchingDisplay = savedCenter
    ? displays.find((display) => {
      const area = display.workArea;
      return savedCenter.x >= area.x && savedCenter.x < area.x + area.width && savedCenter.y >= area.y && savedCenter.y < area.y + area.height;
    })
    : undefined;
  const display = savedDisplay ?? matchingDisplay ?? primary;
  const area = display.workArea;
  const requestedWidth = saved?.width ?? defaults.width;
  const requestedHeight = saved?.height ?? defaults.height;
  const width = Math.min(area.width, Math.max(defaults.minWidth, requestedWidth));
  const height = Math.min(area.height, Math.max(defaults.minHeight, requestedHeight));
  const defaultX = area.x + Math.round((area.width - width) / 2);
  const defaultY = area.y + Math.round((area.height - height) / 2);
  const x = Math.min(Math.max(saved?.x ?? defaultX, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(saved?.y ?? defaultY, area.y), area.y + area.height - height);
  return { x, y, width, height, displayId: String(display.id) };
}

type WindowOptions = {
  bounds?: WindowBounds | null;
  onClosed?: (window: BrowserWindow, capturedOwnerId?: number) => void | Promise<void>;
  onRendererCrashed?: (window: BrowserWindow) => void | Promise<void>;
  onBoundsChanged?: (bounds: WindowBounds) => void;
};

export function getMainWindow() {
  return mainWindow;
}

export async function createMainWindow(options: WindowOptions = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  installCsp();
  const defaults = windowBounds();
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const initial = clampWindowBounds(options.bounds ?? null, defaults, displays, primary);
  mainWindow = new BrowserWindow({
    ...defaults,
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
    minWidth: Math.min(defaults.minWidth, initial.width),
    minHeight: Math.min(defaults.minHeight, initial.height),
    show: false,
    title: '「观」',
    backgroundColor: '#101418',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  let capturedOwnerId: number | undefined;
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (event) => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', () => {
    if (mainWindow) void options.onRendererCrashed?.(mainWindow);
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  const emitBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const current = mainWindow.getBounds();
    options.onBoundsChanged?.({ x: current.x, y: current.y, width: current.width, height: current.height, displayId: String(screen.getDisplayMatching(current).id) });
  };
  mainWindow.on('move', emitBounds);
  mainWindow.on('resize', emitBounds);
  mainWindow.on('close', () => {
    const closingWindow = mainWindow;
    if (!closingWindow || closingWindow.isDestroyed()) return;
    try {
      capturedOwnerId = closingWindow.webContents.id;
    } catch {
      capturedOwnerId = undefined;
    }
  });
  mainWindow.on('closed', () => {
    const closedWindow = mainWindow;
    mainWindow = null;
    const ownerId = capturedOwnerId;
    capturedOwnerId = undefined;
    if (closedWindow) void options.onClosed?.(closedWindow, ownerId);
  });
  const devServer = process.env.SERVICE_OBSERVATORY_DEV_SERVER;
  if (!app.isPackaged && devServer) await mainWindow.loadURL(devServer);
  else await mainWindow.loadURL('app://observatory/index.html');
  return mainWindow;
}

export function destroyMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  mainWindow = null;
}
