import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type AppPaths, type MonitorApi } from "../shared/ipc.ts";
import type { AppSettings, BridgeState, UsageSnapshot } from "../shared/types.ts";

/** on/off をまとめて解除関数を返すヘルパ。 */
function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: MonitorApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot) as Promise<UsageSnapshot | null>,
  onSnapshot: (listener) => subscribe<UsageSnapshot | null>(IPC.snapshotChanged, listener),

  getBridgeState: () => ipcRenderer.invoke(IPC.getBridgeState) as Promise<BridgeState>,
  enableBridge: () => ipcRenderer.invoke(IPC.enableBridge) as Promise<BridgeState>,
  disableBridge: () => ipcRenderer.invoke(IPC.disableBridge) as Promise<BridgeState>,
  onBridgeState: (listener) => subscribe<BridgeState>(IPC.bridgeStateChanged, listener),

  getSettings: () => ipcRenderer.invoke(IPC.getSettings) as Promise<AppSettings>,
  setSettings: (settings) => ipcRenderer.invoke(IPC.setSettings, settings) as Promise<AppSettings>,
  onSettings: (listener) => subscribe<AppSettings>(IPC.settingsChanged, listener),

  getPaths: () => ipcRenderer.invoke(IPC.getPaths) as Promise<AppPaths>,
  revealPath: (target) => ipcRenderer.invoke(IPC.revealPath, target) as Promise<void>,
};

contextBridge.exposeInMainWorld("monitor", api);
