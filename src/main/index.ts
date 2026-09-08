import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, app, ipcMain, nativeTheme, powerMonitor, screen, shell } from "electron";
import { IPC } from "../shared/ipc.ts";
import type { AppSettings } from "../shared/types.ts";
import { bridgePaths, disableBridge, enableBridge, getBridgeState } from "./bridge/bridge-manager.ts";
import { LocalUsageService } from "./jsonl/service.ts";
import { MiniWindow } from "./mini-window.ts";
import { ThresholdNotifier } from "./notifier.ts";
import { loadSettings, saveSettings } from "./store.ts";
import { TrayController } from "./tray.ts";
import { UsageWatcher } from "./watcher.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: TrayController | null = null;
let panel: BrowserWindow | null = null;
let settings: AppSettings = loadSettings();
let localRefreshTimer: NodeJS.Timeout | null = null;
const watcher = new UsageWatcher();
const localUsage = new LocalUsageService();
const notifier = new ThresholdNotifier();

const PRELOAD = path.join(dirname, "../preload/index.mjs");
const RENDERER_FILE = path.join(dirname, "../renderer/index.html");

const mini = new MiniWindow({
  preloadPath: PRELOAD,
  rendererUrl: process.env.ELECTRON_RENDERER_URL,
  rendererFile: RENDERER_FILE,
  // ドラッグ移動のたびに settings を書くと I/O が増えるが、
  // 移動完了時にしか飛ばないイベントなので実用上は問題ない。
  onMoved: (x, y) => applySettings({ ...settings, mini: { ...settings.mini, x, y } }),
});

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
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // フォーカスが外れたらポップオーバーらしく隠す。
  // 設定で切れるようにしてある — 数字を見ながら別のウィンドウを操作したい場合があるため。
  window.on("blur", () => {
    if (!settings.panel.autoHide) return;
    if (!window.webContents.isDevToolsOpened()) window.hide();
  });

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(RENDERER_FILE);
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

/** Trayの画面切替は、初回ロード完了前でも取りこぼさずレンダラへ届ける。 */
function openPanelView(channel: typeof IPC.openSettings | typeof IPC.openHelp): void {
  const created = panel === null;
  const target = panel ?? createPanel();
  panel = target;
  const openView = () => target.webContents.send(channel, null);

  if (created || target.webContents.isLoading()) {
    target.webContents.once("did-finish-load", openView);
  } else {
    openView();
  }

  if (!target.isVisible()) {
    positionNearTray(target);
    target.show();
    target.focus();
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

/**
 * ディスクから読み直して全画面を描き直す。
 *
 * スリープ復帰・スクリーンロック解除の直後に必要になる:
 *   - chokidar が寝ている間の書き込みを取りこぼしていることがある
 *   - 取りこぼしが無くても、寝ている間に 5時間枠がリセットされている可能性が高い。
 *     最後の payload のままだと、前の枠の消費率を現在値として出し続けてしまう。
 */
function refreshFromDisk(): void {
  watcher.refresh();
  const snapshot = watcher.current();
  tray?.update(snapshot);
  broadcast(IPC.snapshotChanged, snapshot);
}

/** 設定値を OS 側の状態 (テーマ・自動起動・小窓) とタイマーに反映する。 */
function applySideEffects(previous: AppSettings | null): void {
  nativeTheme.themeSource = settings.theme;

  // 位置だけの変更 (ドラッグ移動) で作り直さない。無限ループになる。
  const miniChanged =
    previous === null ||
    previous.mini.enabled !== settings.mini.enabled ||
    previous.mini.alwaysOnTop !== settings.mini.alwaysOnTop ||
    previous.mini.visibleOnAllWorkspaces !== settings.mini.visibleOnAllWorkspaces;
  if (miniChanged) mini.sync(settings);

  // Electron の API を毎回叩かず、変わったときだけ設定する。
  if (previous === null || previous.launchAtLogin !== settings.launchAtLogin) {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, openAsHidden: true });
  }

  if (previous === null || previous.localRefreshSeconds !== settings.localRefreshSeconds) {
    if (localRefreshTimer) clearInterval(localRefreshTimer);
    localRefreshTimer = null;
    // 0 ならファイル監視だけに任せる。監視の取りこぼしに対する保険なので必須ではない。
    if (settings.localRefreshSeconds > 0) {
      localRefreshTimer = setInterval(
        () => localUsage.refresh(),
        settings.localRefreshSeconds * 1000,
      );
    }
  }

  // ブリッジが有効なら refreshInterval を settings.json の現物と突き合わせて直す。
  //
  // 「前回と変わったときだけ書く」だと、既定値を変えても既存ユーザーには一生届かない
  // (起動時は previous === null で、設定を触るまで比較が走らないため)。
  // 希望値と現物を比べる形にすれば、起動時のズレも設定変更も同じ経路で収束する。
  // 一致していれば書かないので、毎回 settings.json を触ることにはならない。
  const state = getBridgeState();
  if (
    state.status === "enabled" &&
    state.refreshIntervalSeconds !== settings.statusLineRefreshSeconds
  ) {
    broadcast(
      IPC.bridgeStateChanged,
      enableBridge({ refreshIntervalSeconds: settings.statusLineRefreshSeconds }),
    );
  }
}

function applySettings(next: AppSettings): AppSettings {
  const previous = settings;
  settings = next;
  saveSettings(settings);
  tray?.updateSettings(settings);
  applySideEffects(previous);
  broadcast(IPC.settingsChanged, settings);
  return settings;
}

function registerIpc(): void {
  ipcMain.handle(IPC.getSnapshot, () => watcher.current());
  ipcMain.handle(IPC.getBridgeState, () => getBridgeState());

  ipcMain.handle(IPC.getLocalReport, () => localUsage.current());
  ipcMain.handle(IPC.refreshLocalReport, () => localUsage.refresh());

  ipcMain.handle(IPC.enableBridge, () => {
    const state = enableBridge({ refreshIntervalSeconds: settings.statusLineRefreshSeconds });
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
  ipcMain.handle(IPC.getVersion, () => app.getVersion());

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

  // macOS で `open` や Finder からもう一度起動されたとき。
  // このケースは新しいプロセスを作らないので `second-instance` は発火しない。
  // 何も起きないと「起動したのに反応がない」と見えるので、パネルを出す。
  app.on("activate", () => {
    if (!panel?.isVisible()) togglePanel();
  });

  void app.whenReady().then(() => {
    hideFromDock();
    registerIpc();

    tray = new TrayController(settings, {
      onToggleWindow: togglePanel,
      onTogglePanelPinned: () => {
        applySettings({
          ...settings,
          panel: { ...settings.panel, autoHide: !settings.panel.autoHide },
        });
        if (!settings.panel.autoHide && !panel?.isVisible()) togglePanel();
      },
      onOpenSettings: () => openPanelView(IPC.openSettings),
      onOpenHelp: () => openPanelView(IPC.openHelp),
      onSetTrayMode: (mode) => applySettings({ ...settings, tray: { ...settings.tray, mode } }),
      onToggleMini: () =>
        applySettings({
          ...settings,
          mini: { ...settings.mini, enabled: !settings.mini.enabled },
        }),
      isMiniEnabled: () => settings.mini.enabled,
      onQuit: () => app.quit(),
    });
    tray.create();

    watcher.onSnapshot((snapshot) => {
      tray?.update(snapshot);
      notifier.check(snapshot, settings);
      broadcast(IPC.snapshotChanged, snapshot);
    });
    watcher.start();
    applySideEffects(null);
    tray.update(watcher.current());

    powerMonitor.on("resume", refreshFromDisk);
    powerMonitor.on("unlock-screen", refreshFromDisk);

    localUsage.onReport((report) => broadcast(IPC.localReportChanged, report));
    // 起動直後の全ファイル走査で UI を待たせないよう、次のイベントループに逃がす。
    setImmediate(() => localUsage.start());
  });

  // Tray 常駐なので全ウィンドウが閉じても終了しない。
  app.on("window-all-closed", () => {});

  app.on("before-quit", () => {
    if (localRefreshTimer) clearInterval(localRefreshTimer);
    watcher.stop();
    localUsage.stop();
    mini.destroy();
    tray?.destroy();
  });
}
