/**
 * statusLine ブリッジの有効化 / 無効化。
 *
 * これはアプリ内で唯一 Claude Code の管理下 (`~/.claude/settings.json`) を書き換える場所。
 * 指示書 §6 の禁止事項に照らして、ここでの不変条件は 3 つ:
 *
 *   1. 書き換える前に必ず全文バックアップを取る (世代も残す)
 *   2. 無効化で元の statusLine 設定に完全復元できる
 *   3. `statusLine` キー以外には一切触れない
 *
 * 3 について: 「無効化時に settings.json をバックアップで丸ごと上書きする」実装にすると、
 * 有効化中にユーザーが別の設定 (model や permissions など) を変更していた場合、
 * その変更を巻き戻して壊してしまう。そこで復元は **`statusLine` キーだけを対象**にし、
 * 全文バックアップは「それでも壊れた時の最後の砦」としてディスクに残す方式にした。
 */

import fs from "node:fs";
import path from "node:path";
import type { BridgeState } from "../../shared/types.ts";
import {
  APP_DIR,
  BRIDGE_CONFIG_JSON,
  BRIDGE_JS,
  BRIDGE_LOG,
  CLAUDE_SETTINGS,
  HOME,
  LATEST_JSON,
  SETTINGS_BACKUP,
  SETTINGS_BACKUP_DIR,
} from "../paths.ts";
import { BRIDGE_SCRIPT_VERSION, renderBridgeScript } from "./bridge-script.ts";

interface StatusLineSetting {
  type?: string;
  command?: string;
  refreshInterval?: number;
  [key: string]: unknown;
}

interface BridgeConfig {
  bridgeScriptVersion: number;
  /** 元の statusLine コマンド。無かった場合は null。 */
  originalCommand: string | null;
  /** 元の statusLine オブジェクト全体 (padding などの付随設定も戻せるように)。 */
  originalStatusLine: StatusLineSetting | null;
  /** 有効化時点で settings.json 自体が存在したか。 */
  settingsFileExisted: boolean;
  enabledAt: string;
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** tmp → rename。書き込み途中で Claude Code に読まれて設定を壊されないようにする。 */
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readSettings(): { exists: boolean; settings: Record<string, unknown>; raw: string | null } {
  if (!fs.existsSync(CLAUDE_SETTINGS)) {
    return { exists: false, settings: {}, raw: null };
  }
  const raw = fs.readFileSync(CLAUDE_SETTINGS, "utf8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    // 壊れた JSON を上書きすると被害が拡大するので、ここで止める。
    throw new Error(
      `${CLAUDE_SETTINGS} が有効な JSON ではありません。手動で修正してください: ${
        (err as Error).message
      }`,
    );
  }
  return { exists: true, settings: parsed, raw };
}

function isOurBridge(statusLine: StatusLineSetting | undefined | null): boolean {
  if (!statusLine || typeof statusLine.command !== "string") return false;
  // 設定の移植などで絶対パスが $HOME / ${HOME} / ~ になっていても同一視する。
  // シェルは実行せず、単純な node コマンドだけを認識する。
  const tokens = [...statusLine.command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
  if (tokens[0] === "exec") tokens.shift();
  if (tokens.length !== 2 || !/^node(?:\.exe)?$/.test(path.basename(tokens[0]))) return false;
  const script = tokens[1].replace(/^(?:\$HOME|\$\{HOME\}|~|%USERPROFILE%)(?=[/\\])/, () => HOME);
  return path.normalize(script) === path.normalize(BRIDGE_JS);
}

/** 旧版が自身を「元の設定」として保存していた場合は復元・実行しない。 */
function safeConfig(config: BridgeConfig): BridgeConfig {
  const originalStatusLine = isOurBridge(config.originalStatusLine) ? null : config.originalStatusLine;
  const originalCommand = isOurBridge({ command: config.originalCommand ?? undefined })
    ? (typeof originalStatusLine?.command === "string" ? originalStatusLine.command : null)
    : config.originalCommand;
  return { ...config, originalCommand, originalStatusLine };
}

/** 現在の状態を settings.json から判定する。 */
export function getBridgeState(): BridgeState {
  try {
    const { settings } = readSettings();
    const statusLine = settings.statusLine as StatusLineSetting | undefined;

    if (!statusLine) return { status: "disabled" };

    if (isOurBridge(statusLine)) {
      const config = readJsonFile<BridgeConfig>(BRIDGE_CONFIG_JSON);
      const interval = statusLine.refreshInterval;
      return {
        status: "enabled",
        bridgePath: BRIDGE_JS,
        wrappedCommand: config?.originalCommand ?? null,
        // アプリの希望値ではなく settings.json の現物を返す。
        refreshIntervalSeconds: typeof interval === "number" ? interval : null,
      };
    }

    return { status: "foreign", command: statusLine.command ?? JSON.stringify(statusLine) };
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }
}

/** 有効化のたびにタイムスタンプ付きの世代バックアップを残す。 */
function backupSettings(raw: string | null): void {
  fs.mkdirSync(SETTINGS_BACKUP_DIR, { recursive: true });
  const payload = raw ?? "";
  fs.writeFileSync(SETTINGS_BACKUP, payload);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(SETTINGS_BACKUP_DIR, `settings-${stamp}.json`), payload);
}

export interface EnableOptions {
  /**
   * Claude Code の `statusLine.refreshInterval` (秒)。
   *
   * 既定では statusLine はイベント駆動でしか走らないため、Claude Code が起動していても
   * 操作していない間は使用量が更新されない。ここを設定すると N 秒ごとに再実行される。
   * null なら設定しない (Claude Code 既定の挙動)。
   */
  refreshIntervalSeconds?: number | null;
}

function buildStatusLine(options: EnableOptions): StatusLineSetting {
  const statusLine: StatusLineSetting = {
    type: "command",
    // パスに空白が含まれても壊れないよう必ず引用符で囲む。
    command: `node "${BRIDGE_JS}"`,
  };
  const interval = options.refreshIntervalSeconds;
  // Claude Code 側のスキーマは minimum 1。
  if (typeof interval === "number" && interval >= 1) {
    statusLine.refreshInterval = interval;
  }
  return statusLine;
}

export function enableBridge(options: EnableOptions = {}): BridgeState {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });

    const { exists, settings, raw } = readSettings();
    const existing = settings.statusLine as StatusLineSetting | undefined;

    // 既存の元コマンドを保持しつつ、旧版の自己参照設定も修復する。
    if (isOurBridge(existing)) {
      const stored = readJsonFile<BridgeConfig>(BRIDGE_CONFIG_JSON);
      const config = safeConfig(stored ?? {
        bridgeScriptVersion: BRIDGE_SCRIPT_VERSION,
        originalCommand: null,
        originalStatusLine: null,
        settingsFileExisted: exists,
        enabledAt: new Date().toISOString(),
      });
      config.bridgeScriptVersion = BRIDGE_SCRIPT_VERSION;
      if (JSON.stringify(stored) !== JSON.stringify(config)) {
        // 壊れた元設定も、手動復旧の手掛かりとして保全する。
        if (fs.existsSync(BRIDGE_CONFIG_JSON)) {
          fs.mkdirSync(SETTINGS_BACKUP_DIR, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, "-");
          fs.copyFileSync(BRIDGE_CONFIG_JSON, path.join(SETTINGS_BACKUP_DIR, `bridge-config-${stamp}.json`));
        }
        writeJsonAtomic(BRIDGE_CONFIG_JSON, config);
      }
      // スクリプト本体は毎回書き直す (アプリ更新でブリッジが古いままになるのを防ぐ)。
      writeBridgeScript();
      const statusLine = { ...existing, ...buildStatusLine(options) };
      if (options.refreshIntervalSeconds == null) delete statusLine.refreshInterval;
      if (JSON.stringify(existing) !== JSON.stringify(statusLine)) {
        backupSettings(raw);
        writeJsonAtomic(CLAUDE_SETTINGS, { ...settings, statusLine });
      }
      return getBridgeState();
    }

    backupSettings(raw);

    const config: BridgeConfig = {
      bridgeScriptVersion: BRIDGE_SCRIPT_VERSION,
      originalCommand: typeof existing?.command === "string" ? existing.command : null,
      originalStatusLine: existing ?? null,
      settingsFileExisted: exists,
      enabledAt: new Date().toISOString(),
    };
    writeJsonAtomic(BRIDGE_CONFIG_JSON, config);

    writeBridgeScript();

    // `statusLine` 以外のキーは触らない。
    writeJsonAtomic(CLAUDE_SETTINGS, { ...settings, statusLine: buildStatusLine(options) });

    return getBridgeState();
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }
}

export function disableBridge(): BridgeState {
  try {
    const { settings, raw } = readSettings();
    const current = settings.statusLine as StatusLineSetting | undefined;

    // こちらのブリッジでないものを勝手に消さない。
    if (current && !isOurBridge(current)) {
      return {
        status: "foreign",
        command: current.command ?? JSON.stringify(current),
      };
    }

    const stored = readJsonFile<BridgeConfig>(BRIDGE_CONFIG_JSON);
    const config = stored ? safeConfig(stored) : null;
    const next: Record<string, unknown> = { ...settings };

    if (config?.originalStatusLine) {
      // 元々 statusLine があった → padding などの付随設定ごと戻す。
      next.statusLine = config.originalStatusLine;
    } else {
      // 元々無かった → キーごと消す。空オブジェクトを残さない。
      delete next.statusLine;
    }

    backupSettings(raw);
    writeJsonAtomic(CLAUDE_SETTINGS, next);

    // 設定は消えたので、実行時設定も畳んでおく。
    try {
      fs.rmSync(BRIDGE_CONFIG_JSON, { force: true });
    } catch {
      /* 消せなくても致命的ではない */
    }

    return getBridgeState();
  } catch (err) {
    return { status: "error", message: (err as Error).message };
  }
}

function writeBridgeScript(): void {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const source = renderBridgeScript({
    latestJsonPath: LATEST_JSON,
    configPath: BRIDGE_CONFIG_JSON,
    logPath: BRIDGE_LOG,
  });
  const tmp = `${BRIDGE_JS}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, source, { mode: 0o755 });
  fs.renameSync(tmp, BRIDGE_JS);
}

/** 設定画面から「バックアップ場所を開く」等に使うため、パスを公開する。 */
export const bridgePaths = {
  bridge: BRIDGE_JS,
  latest: LATEST_JSON,
  backup: SETTINGS_BACKUP,
  backupDir: SETTINGS_BACKUP_DIR,
  log: BRIDGE_LOG,
  claudeSettings: CLAUDE_SETTINGS,
};
