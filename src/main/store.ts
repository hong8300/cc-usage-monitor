/**
 * アプリ自身の設定の永続化。Claude Code の設定とは完全に別ファイル。
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../shared/types.ts";
import { APP_SETTINGS_JSON } from "./paths.ts";

export function loadSettings(): AppSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(APP_SETTINGS_JSON, "utf8")) as Partial<AppSettings>;
    // ネストしたオブジェクトは既定値とマージする。
    // 設定項目を後から増やしたとき、古い設定ファイルで undefined にならないようにするため。
    return {
      ...DEFAULT_APP_SETTINGS,
      ...parsed,
      tray: { ...DEFAULT_APP_SETTINGS.tray, ...parsed.tray },
      mini: { ...DEFAULT_APP_SETTINGS.mini, ...parsed.mini },
      notifications: { ...DEFAULT_APP_SETTINGS.notifications, ...parsed.notifications },
    };
  } catch {
    return structuredClone(DEFAULT_APP_SETTINGS);
  }
}

export function saveSettings(settings: AppSettings): void {
  fs.mkdirSync(path.dirname(APP_SETTINGS_JSON), { recursive: true });
  const tmp = `${APP_SETTINGS_JSON}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, APP_SETTINGS_JSON);
}
