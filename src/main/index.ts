import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, ipcMain, screen, shell } from "electron";
import { IPC } from "../shared/ipc.ts";
import type { AppSettings } from "../shared/types.ts";
import { bridgePaths, disableBridge, enableBridge, getBridgeState } from "./bridge/bridge-manager.ts";
import { loadSettings, saveSettings } from "./store.ts";
import { TrayController } from "./tray.ts";
import { UsageWatcher } from "./watcher.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: TrayController | null = null;
let panel: BrowserWindow | null = null;
let settings: AppSettings = loadSettings();
const watcher = new UsageWatcher();

/** Tray 常駐アプリなので Dock には出さない (macOS)。 */
function hideFromDock(): void {
  if (process.platform === "darwin") app.dock?.hide();
}

function createPanel(): BrowserWindow {
  const window = new BrowserWindow({
    width: 400,
    height: 560,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Tray からのポップオーバーなので、他ウィンドウの上に出す。
    alwaysOnTop: true,
    vibrancy: process.platform === "darwin" ? "under-window" : undefined,
    webPreferences: {
      preload: path.join(dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // フォーカスが外れたらポップオーバーらしく隠す。
  window.on("blur", () => {
    if (!window.webContents.isDevToolsOpened()) window.hide();
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(path.join(dirname, "../renderer/index.html"));
  }

  return window;
}

/** Tray アイコンの真下にパネルを寄せる。 */
function positionNearTray(window: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const bounds = window.getBounds();
  const x = Math.round(
    Math.min(
      Math.max(cursor.x - bounds.width / 2, display.workArea.x + 8),
      display.workArea.x + display.workArea.width - bounds.width - 8,
    ),
  );
  const y = display.workArea.y + 8;
  window.setPosition(x, y, false);
}

function togglePanel(): void {
  if (!panel) panel = createPanel();
  if (panel.isVisible()) {
    panel.hide();
    return;
  }
  positionNearTray(panel);
  panel.show();
  panel.focus();
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

function applySettings(next: AppSettings): AppSettings {
  settings = next;
  saveSettings(settings);
  tray?.updateSettings(settings);
  broadcast(IPC.settingsChanged, settings);
  return settings;
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSnapshot, () => watcher.current());
  ipcMain.handle(IPC.getBridgeState, () => getBridgeState());

  ipcMain.handle(IPC.enableBridge, () => {
    const state = enableBridge();
    broadcast(IPC.bridgeStateChanged, state);
    return state;
  });

  ipcMain.handle(IPC.disableBridge, () => {
    const state = disableBridge();
    broadcast(IPC.bridgeStateChanged, state);
    return state;
  });

  ipcMain.handle(IPC.getSettings, () => settings);
  ipcMain.handle(IPC.setSettings, (_event, next: AppSettings) => applySettings(next));
  ipcMain.handle(IPC.getPaths, () => bridgePaths);

  ipcMain.handle(IPC.revealPath, (_event, target: string) => {
    // 任意パスを開かせない。アプリが管理しているパスだけを許可する。
    const allowed = new Set(Object.values(bridgePaths));
    if (!allowed.has(target)) return;
    shell.showItemInFolder(target);
  });
}

// 二重起動すると Tray が 2 つ出るので単一インスタンスに固定する。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => togglePanel());

  void app.whenReady().then(() => {
    hideFromDock();
    registerIpc();

    tray = new TrayController(settings, {
      onToggleWindow: togglePanel,
      onOpenSettings: () => {
        togglePanel();
        broadcast("ui:openSettings", null);
      },
      onSetTrayMode: (mode) => applySettings({ ...settings, tray: { ...settings.tray, mode } }),
      onQuit: () => app.quit(),
    });
    tray.create();

    watcher.onSnapshot((snapshot) => {
      tray?.update(snapshot);
      broadcast(IPC.snapshotChanged, snapshot);
    });
    watcher.start();
    tray.update(watcher.current());
  });

  // Tray 常駐なので全ウィンドウが閉じても終了しない。
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    watcher.stop();
    tray?.destroy();
  });
}
