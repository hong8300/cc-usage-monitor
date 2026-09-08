/**
 * main ↔ renderer の契約。チャンネル名の綴りミスを型で潰すためにここへ集約する。
 */

import type { AppSettings, BridgeState, UsageSnapshot } from "./types.ts";
import type { LocalUsageReport } from "./usage-types.ts";

export const IPC = {
  getSnapshot: "usage:getSnapshot",
  snapshotChanged: "usage:snapshotChanged",
  getLocalReport: "local:getReport",
  refreshLocalReport: "local:refresh",
  localReportChanged: "local:reportChanged",
  getBridgeState: "bridge:getState",
  enableBridge: "bridge:enable",
  disableBridge: "bridge:disable",
  bridgeStateChanged: "bridge:stateChanged",
  getPaths: "app:getPaths",
  getVersion: "app:getVersion",
  getSettings: "app:getSettings",
  setSettings: "app:setSettings",
  settingsChanged: "app:settingsChanged",
  revealPath: "app:revealPath",
  /** Tray メニューの「設定…」から設定画面を開かせる。 */
  openSettings: "ui:openSettings",
  /** Tray メニューの「ヘルプ…」からヘルプ画面を開かせる。 */
  openHelp: "ui:openHelp",
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

  /** ローカル JSONL 集計 (推定値)。statusLine 由来の公式値とは別系統。 */
  getLocalReport(): Promise<LocalUsageReport | null>;
  refreshLocalReport(): Promise<LocalUsageReport>;
  onLocalReport(listener: (report: LocalUsageReport) => void): () => void;

  getBridgeState(): Promise<BridgeState>;
  enableBridge(): Promise<BridgeState>;
  disableBridge(): Promise<BridgeState>;
  onBridgeState(listener: (state: BridgeState) => void): () => void;

  getSettings(): Promise<AppSettings>;
  setSettings(settings: AppSettings): Promise<AppSettings>;
  onSettings(listener: (settings: AppSettings) => void): () => void;

  getPaths(): Promise<AppPaths>;
  getVersion(): Promise<string>;
  revealPath(target: string): Promise<void>;
  onOpenSettings(listener: () => void): () => void;
  onOpenHelp(listener: () => void): () => void;
}
