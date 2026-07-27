import os from "node:os";
import path from "node:path";

/**
 * アプリが使うパスを一元管理する。
 *
 * 指示書 §3-A は「`~/.cc-usage-monitor/bridge.js`(Windows も同じ相対パス)」を要求している。
 * `os.homedir()` で解決するので Windows でも同じ形になる (Phase 4 で実機確認予定)。
 */

export const HOME = os.homedir();

/** アプリ専有ディレクトリ。Claude Code の管理下には一切書かない。 */
export const APP_DIR = path.join(HOME, ".cc-usage-monitor");

/** ブリッジが毎ターン原子的に書き換える最新 payload。 */
export const LATEST_JSON = path.join(APP_DIR, "latest.json");

/** アプリが生成する statusLine ブリッジ。 */
export const BRIDGE_JS = path.join(APP_DIR, "bridge.js");

/** 元の statusLine コマンドなど、ブリッジが実行時に読む設定。 */
export const BRIDGE_CONFIG_JSON = path.join(APP_DIR, "bridge-config.json");

/** ブリッジが自身のエラーを吐く先。statusLine の出力は汚さない。 */
export const BRIDGE_LOG = path.join(APP_DIR, "bridge.log");

/** アプリ自身の設定 (Tray 表示モードなど)。 */
export const APP_SETTINGS_JSON = path.join(APP_DIR, "app-settings.json");

/** 有効化直前の settings.json 全文バックアップ。 */
export const SETTINGS_BACKUP = path.join(APP_DIR, "claude-settings.backup.json");

/** 世代バックアップの置き場 (毎回の有効化ごとにタイムスタンプ付きで残す)。 */
export const SETTINGS_BACKUP_DIR = path.join(APP_DIR, "backups");

/** Claude Code のユーザー設定。**書き換えるのはこの 1 ファイルだけ。** */
export const CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json");

/**
 * JSONL 探索ルートの候補。指示書 §3-B の順序に従う。
 * Phase 2 で使用する。
 */
export function transcriptRoots(): string[] {
  const roots: string[] = [];
  const configured = process.env.CLAUDE_CONFIG_DIR;
  if (configured) {
    for (const dir of configured.split(",")) {
      const trimmed = dir.trim();
      if (trimmed) roots.push(path.join(trimmed, "projects"));
    }
  }
  roots.push(path.join(HOME, ".claude", "projects"));
  roots.push(path.join(HOME, ".config", "claude", "projects"));
  return [...new Set(roots)];
}
