/**
 * main ↔ renderer の契約。チャンネル名の綴りミスを型で潰すためにここへ集約する。
 */

import type { AppSettings, BridgeState, UsageSnapshot } from "./types.ts";

export const IPC = {
  getSnapshot: "usage:getSnapshot",
  snapshotChanged: "usage:snapshotChanged",
  getBridgeState: "bridge:getState",
  enableBridge: "bridge:enable",
  disableBridge: "bridge:disable",
  bridgeStateChanged: "bridge:stateChanged",
  getPaths: "app:getPaths",
  getSettings: "app:getSettings",
  setSettings: "app:setSettings",
  settingsChanged: "app:settingsChanged",
  revealPath: "app:revealPath",
} as const;

export interface AppPaths {
  bridge: string;
  latest: string;
  backup: string;
  backupDir: string;
  log: string;
  claudeSettings: string;
}

/** preload が contextBridge で公開する API の形。 */
export interface MonitorApi {
  getSnapshot(): Promise<UsageSnapshot | null>;
  onSnapshot(listener: (snapshot: UsageSnapshot | null) => void): () => void;

  getBridgeState(): Promise<BridgeState>;
  enableBridge(): Promise<BridgeState>;
  disableBridge(): Promise<BridgeState>;
  onBridgeState(listener: (state: BridgeState) => void): () => void;

  getSettings(): Promise<AppSettings>;
  setSettings(settings: AppSettings): Promise<AppSettings>;
  onSettings(listener: (settings: AppSettings) => void): () => void;

  getPaths(): Promise<AppPaths>;
  revealPath(target: string): Promise<void>;
}
