/**
 * statusLine が stdin で渡してくる JSON の型。
 *
 * docs/findings.md §2 の実測に基づく。**すべて optional** なのは意図的:
 *   - `rate_limits` は Pro/Max 契約 かつ セッション初回 API 応答後 にのみ出現する
 *   - `five_hour` / `seven_day` は互いに独立して欠損しうる
 *   - 実測で `workspace.repo` が同一セッション内で明滅した (findings.md §2-3(3))
 *
 * したがって「前回あったから今回もある」という仮定は一切置かない。
 */

export interface RateLimitWindow {
  /** 0〜100。実測で `14.000000000000002` のような浮動小数点誤差つきの値が来る。 */
  used_percentage?: number;
  /** Unix epoch **秒**。ミリ秒ではない (findings.md §2-3 で実時刻と突き合わせ済み)。 */
  resets_at?: number;
}

export interface RateLimits {
  five_hour?: RateLimitWindow;
  seven_day?: RateLimitWindow;
}

export interface ContextWindowUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ContextWindow {
  total_input_tokens?: number;
  total_output_tokens?: number;
  context_window_size?: number;
  /** セッション初期は null になりうる。 */
  used_percentage?: number | null;
  remaining_percentage?: number | null;
  /** 初回 API 応答前と `/compact` 直後は null。 */
  current_usage?: ContextWindowUsage | null;
}

export interface StatusLinePayload {
  session_id?: string;
  session_name?: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd?: string;
  version?: string;
  /** `id` は `claude-opus-5[1m]` のように角括弧サフィックスが付く (findings.md §2-3(2))。 */
  model?: { id?: string; display_name?: string };
  workspace?: {
    current_dir?: string;
    project_dir?: string;
    added_dirs?: string[];
    git_worktree?: string;
    repo?: { host?: string; owner?: string; name?: string };
  };
  output_style?: { name?: string };
  cost?: {
    /** クライアント側推定であり請求額とは一致しない。UI で「推定」と明示すること。 */
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: ContextWindow;
  exceeds_200k_tokens?: boolean;
  fast_mode?: boolean;
  effort?: { level?: string };
  thinking?: { enabled?: boolean };
  rate_limits?: RateLimits;
  /** 上記以外のキーも破棄せず保持する (デバッグ画面で raw 表示するため)。 */
  [key: string]: unknown;
}

/** 値がいつ観測されたかを持ち回るためのラッパ。 */
export interface Observed<T> {
  value: T;
  /** 観測時刻 (ms)。鮮度表示とグレーアウト判定に使う。 */
  observedAt: number;
}

/**
 * レンダラに渡す、正規化済みかつ last-known-good をマージしたスナップショット。
 *
 * 「今回の payload に無い」ことと「これまで一度も観測されていない」ことは別物なので、
 * 前者では前回値を保持する。ただし `observedAt` を必ず添えて鮮度を判断できるようにする
 * (findings.md §2-3(3) / 指示書 §4 表示規則)。
 */
export interface UsageSnapshot {
  /** ブリッジが最後に payload を書いた時刻 (ms)。null = 一度も観測していない。 */
  lastPayloadAt: number | null;
  fiveHour: Observed<RateLimitWindow> | null;
  sevenDay: Observed<RateLimitWindow> | null;
  model: Observed<{ id?: string; displayName?: string; normalizedId?: string }> | null;
  contextWindow: Observed<ContextWindow> | null;
  sessionCost: Observed<NonNullable<StatusLinePayload["cost"]>> | null;
  sessionId: string | null;
  claudeCodeVersion: string | null;
  /** 直近に受け取った生 payload。デバッグ画面用。 */
  raw: StatusLinePayload | null;
}

export type BridgeState =
  | { status: "disabled" }
  | { status: "enabled"; bridgePath: string; wrappedCommand: string | null }
  /** settings.json に他ツールの statusLine が入っており、こちらのブリッジではない状態。 */
  | { status: "foreign"; command: string }
  | { status: "error"; message: string };

export interface TrayDisplaySettings {
  /** 指示書 §4: アイコンのみ / % のみ / 両方 */
  mode: "icon" | "percent" | "both";
}

export interface NotificationSettings {
  enabled: boolean;
  /**
   * 通知する消費率 (%)。指示書 §4 の既定は 80 / 95。
   * Tray の色分け閾値 (50/80) とは別物なので混同しないこと。
   */
  thresholds: number[];
  watchFiveHour: boolean;
  watchSevenDay: boolean;
}

/**
 * ミニウィンドウ（デスクトップに常駐する小窓）の設定。
 *
 * メニューバーの表示とは独立した機能。5時間枠と週次枠のメーターだけを出し、
 * 作業中ずっと見えるようにする。
 */
export interface MiniWindowSettings {
  enabled: boolean;
  /** 他のアプリより常に手前に出すか。 */
  alwaysOnTop: boolean;
  /** 全デスクトップ (Mission Control のすべての操作スペース) に表示するか。 */
  visibleOnAllWorkspaces: boolean;
  /** 前回の位置。null なら画面右上に寄せる。 */
  x: number | null;
  y: number | null;
}

export interface AppSettings {
  tray: TrayDisplaySettings;
  mini: MiniWindowSettings;
  notifications: NotificationSettings;
  /** ログイン時に自動起動する */
  launchAtLogin: boolean;
  theme: "system" | "light" | "dark";
  /**
   * ローカル集計の定期再スキャン間隔 (秒)。0 ならファイル監視のみに任せる。
   * 監視が取りこぼした場合の保険。
   */
  localRefreshSeconds: number;
  /**
   * Claude Code の `statusLine.refreshInterval` に渡す秒数。null なら設定しない。
   *
   * 既定ではイベント駆動でしか statusLine が走らないため、Claude Code が起動していても
   * 操作していない間は使用量が更新されない。ここを設定すると N 秒ごとに再実行される。
   */
  statusLineRefreshSeconds: number | null;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  tray: { mode: "both" },
  mini: {
    enabled: false,
    alwaysOnTop: true,
    visibleOnAllWorkspaces: false,
    x: null,
    y: null,
  },
  notifications: {
    enabled: true,
    thresholds: [80, 95],
    watchFiveHour: true,
    watchSevenDay: true,
  },
  launchAtLogin: false,
  theme: "system",
  localRefreshSeconds: 300,
  statusLineRefreshSeconds: null,
};

/** 値が古いとみなす閾値 (指示書 §4: 5分以上古い場合はグレーアウト)。 */
export const STALE_AFTER_MS = 5 * 60 * 1000;
