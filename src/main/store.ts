/**
 * アプリ自身の設定の永続化。Claude Code の設定とは完全に別ファイル。
 */

import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_APP_SETTINGS,
  SETTINGS_SCHEMA_VERSION,
  type AppSettings,
} from "../shared/types.ts";
import { APP_SETTINGS_JSON } from "./paths.ts";

/**
 * 保存済み設定を現行スキーマへ移行する。
 *
 * `{...DEFAULT, ...parsed}` は既定値の変更を反映できない。保存ファイルに
 * 明示的な値 (null を含む) が入っていれば、それが常に新しい既定を上書きするため。
 * 「まだ選んでいない人」だけを移すには版で線を引くしかない。
 */
export function migrateSettings(parsed: Partial<AppSettings>): Partial<AppSettings> {
  const version = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 0;
  if (version >= SETTINGS_SCHEMA_VERSION) return parsed;

  const next: Partial<AppSettings> = { ...parsed };

  // v0 → v1: statusLineRefreshSeconds に既定が無く、全員 null で保存されていた。
  // その状態では枠がリセットされても次の操作まで画面が更新されないので、
  // 既定 (30秒) へ寄せる。以降は版が上がるので「設定しない」を選び直せば残る。
  if (version < 1 && next.statusLineRefreshSeconds == null) {
    next.statusLineRefreshSeconds = DEFAULT_APP_SETTINGS.statusLineRefreshSeconds;
  }

  next.schemaVersion = SETTINGS_SCHEMA_VERSION;
  return next;
}

export function loadSettings(): AppSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(APP_SETTINGS_JSON, "utf8")) as Partial<AppSettings>;
    const parsed = migrateSettings(raw);
    // ネストしたオブジェクトは既定値とマージする。
    // 設定項目を後から増やしたとき、古い設定ファイルで undefined にならないようにするため。
    return {
      ...DEFAULT_APP_SETTINGS,
      ...parsed,
      tray: { ...DEFAULT_APP_SETTINGS.tray, ...parsed.tray },
      panel: { ...DEFAULT_APP_SETTINGS.panel, ...parsed.panel },
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
